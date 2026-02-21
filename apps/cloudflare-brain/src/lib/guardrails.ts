import type { DeviceTrustTier } from "../types/protocol";

const ALLOW_ACTIONS_FOR_QUARANTINED = new Set(["read", "list", "status"]);
const BLOCK_ACTIONS_FOR_RESTRICTED = new Set(["exec", "publish", "delete"]);

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
