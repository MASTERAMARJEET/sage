import type { DeviceTrustTier } from "../types/protocol";

const ALLOW_ACTIONS_FOR_QUARANTINED = new Set(["read", "list", "status"]);
const BLOCK_ACTIONS_FOR_RESTRICTED = new Set(["exec", "publish", "delete"]);
const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

export type BridgeSignatureMode = "off" | "optional" | "required";

export function evaluateTrustTierAuthorization(input: {
  trustTier: DeviceTrustTier;
  action: string;
}): { allowed: boolean; reason?: string } {
  const action = input.action.trim().toLowerCase();

  if (input.trustTier === "trusted") {
    return { allowed: true };
  }

  if (input.trustTier === "restricted" && BLOCK_ACTIONS_FOR_RESTRICTED.has(action)) {
    return {
      allowed: false,
      reason: `Action '${action}' blocked for restricted device tier`
    };
  }

  if (input.trustTier === "quarantined" && !ALLOW_ACTIONS_FOR_QUARANTINED.has(action)) {
    return {
      allowed: false,
      reason: `Action '${action}' blocked for quarantined device tier`
    };
  }

  return { allowed: true };
}

export function isReplayNonceAllowed(existingNonceValue: string | null): boolean {
  return existingNonceValue === null;
}

export function isBridgeOnline(input: {
  lastSeenAt: string;
  now: Date;
  maxStalenessMs?: number;
}): boolean {
  const lastSeen = new Date(input.lastSeenAt);
  if (Number.isNaN(lastSeen.getTime())) {
    return false;
  }
  const maxStalenessMs = input.maxStalenessMs ?? 5 * 60 * 1000;
  return input.now.getTime() - lastSeen.getTime() <= maxStalenessMs;
}

export function ensureBridgeRegistered(record: unknown): { ok: true } | { ok: false; reason: string } {
  if (!record || typeof record !== "object") {
    return { ok: false, reason: "Bridge is not registered" };
  }
  return { ok: true };
}

export function validateApprovalResolutionState(input: {
  pending: Record<string, unknown>;
  approvalToken: string;
  now: Date;
}): { ok: true } | { ok: false; reason: string } {
  if (input.pending.status !== "pending") {
    return { ok: false, reason: "Approval is already resolved" };
  }

  if (input.pending.approvalToken !== input.approvalToken) {
    return { ok: false, reason: "Invalid approval token" };
  }

  const expiresAt =
    typeof input.pending.expiresAt === "string" ? new Date(input.pending.expiresAt) : null;
  if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
    return { ok: false, reason: "Approval request is malformed" };
  }

  if (expiresAt.getTime() < input.now.getTime()) {
    return { ok: false, reason: "Approval request expired" };
  }

  return { ok: true };
}

export function evaluateDispatchAuthorization(input: {
  requiresApproval: boolean;
  approvalStatus?: string;
  bridgeOnline: boolean;
}): { allowed: true } | { allowed: false; reason: string } {
  if (!input.bridgeOnline) {
    return { allowed: false, reason: "Bridge appears offline" };
  }

  if (input.requiresApproval && input.approvalStatus !== "approved") {
    return { allowed: false, reason: "Dispatch blocked until approval is resolved as approved" };
  }

  return { allowed: true };
}

export async function verifyBridgeRequestSignature(input: {
  mode?: string;
  bridgeRecord: Record<string, unknown>;
  operation: string;
  signedAt?: string;
  signature?: string;
  payload: Record<string, unknown>;
  now: Date;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const mode = normalizeSignatureMode(input.mode);
  if (mode === "off") {
    return { ok: true };
  }

  if (!input.signedAt || !input.signature) {
    if (mode === "required") {
      return { ok: false, reason: "Missing bridge request signature or signed timestamp" };
    }
    return { ok: true };
  }

  const signedAtDate = new Date(input.signedAt);
  if (Number.isNaN(signedAtDate.getTime())) {
    return { ok: false, reason: "Bridge signature timestamp is invalid" };
  }
  if (Math.abs(input.now.getTime() - signedAtDate.getTime()) > SIGNATURE_MAX_AGE_MS) {
    return { ok: false, reason: "Bridge signature timestamp is outside allowed window" };
  }

  const publicKeyRaw = input.bridgeRecord.publicKey;
  if (typeof publicKeyRaw !== "string" || publicKeyRaw.length < 16) {
    return { ok: false, reason: "Bridge public key is missing or invalid" };
  }

  let publicKey: CryptoKey;
  try {
    publicKey = await importBridgePublicKey(publicKeyRaw);
  } catch {
    return { ok: false, reason: "Bridge public key format is unsupported" };
  }

  const message = buildSignatureMessage(input.operation, input.signedAt, input.payload);
  const messageBytes = new TextEncoder().encode(message);

  let signatureBytes: ArrayBuffer;
  try {
    signatureBytes = decodeBase64(input.signature);
  } catch {
    return { ok: false, reason: "Bridge signature encoding is invalid" };
  }

  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    signatureBytes,
    messageBytes
  );
  if (!verified) {
    return { ok: false, reason: "Bridge signature verification failed" };
  }

  return { ok: true };
}

function normalizeSignatureMode(mode?: string): BridgeSignatureMode {
  if (mode === "required" || mode === "off") {
    return mode;
  }
  return "optional";
}

function buildSignatureMessage(
  operation: string,
  signedAt: string,
  payload: Record<string, unknown>
): string {
  return `${operation}\n${signedAt}\n${stableStringify(payload)}`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortJsonValue(obj[key]);
    }
    return sorted;
  }
  return value;
}

async function importBridgePublicKey(raw: string): Promise<CryptoKey> {
  const normalized = raw.includes("BEGIN PUBLIC KEY")
    ? raw
        .replace("-----BEGIN PUBLIC KEY-----", "")
        .replace("-----END PUBLIC KEY-----", "")
        .replace(/\s+/g, "")
    : raw.trim();
  return crypto.subtle.importKey(
    "spki",
    decodeBase64(normalized),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
}

function decodeBase64(value: string): ArrayBuffer {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i += 1) {
    bytes[i] = decoded.charCodeAt(i);
  }
  const out = new ArrayBuffer(bytes.length);
  new Uint8Array(out).set(bytes);
  return out;
}
