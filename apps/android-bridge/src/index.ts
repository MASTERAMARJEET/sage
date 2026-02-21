import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

type BridgeConfig = {
  brainBaseUrl: string;
  instance: string;
  deviceId: string;
  pollIntervalMs: number;
  maxJobsPerCycle: number;
  runOnce: boolean;
  attestation: string;
  allowedRoots: string[];
  stateFile: string;
};

type BridgeState = {
  privateKeyPkcs8Base64: string;
  publicKeySpkiBase64: string;
};

type PullJob = {
  jobId: string;
  intentId: string;
  payload: {
    action: string;
    args: Record<string, unknown>;
  };
};

async function main(): Promise<void> {
  const config = loadConfig();
  await ensureParentDir(config.stateFile);
  const keys = await loadOrCreateBridgeState(config.stateFile);

  await registerBridge(config, keys.publicKeySpkiBase64);
  console.log(`[sage-android-bridge] Registered device ${config.deviceId}`);

  for (;;) {
    try {
      await sendHeartbeat(config, keys.privateKeyPkcs8Base64);
      const jobs = await pullJobs(config, keys.privateKeyPkcs8Base64, config.maxJobsPerCycle);
      for (const job of jobs) {
        await handleJob(config, keys.privateKeyPkcs8Base64, job);
      }
    } catch (error) {
      console.error("[sage-android-bridge] loop error", error);
    }
    if (config.runOnce) {
      console.log("[sage-android-bridge] run-once cycle complete");
      return;
    }
    await sleep(config.pollIntervalMs);
  }
}

function loadConfig(): BridgeConfig {
  const brainBaseUrl = requireEnv("SAGE_BRAIN_BASE_URL");
  const instance = process.env.SAGE_AGENT_INSTANCE ?? "default";
  const deviceId = process.env.SAGE_DEVICE_ID ?? `android-${process.pid}`;
  const pollIntervalMs = Number.parseInt(process.env.SAGE_POLL_INTERVAL_MS ?? "3000", 10);
  const maxJobsPerCycle = Number.parseInt(process.env.SAGE_MAX_JOBS_PER_CYCLE ?? "5", 10);
  const runOnce = process.env.SAGE_RUN_ONCE === "1";
  const attestation = process.env.SAGE_ATTESTATION ?? "verified:android-dev-local";
  const allowedRoots = (process.env.SAGE_ALLOWED_ROOTS ?? process.cwd())
    .split(",")
    .map((entry) => path.resolve(entry.trim()))
    .filter((entry) => entry.length > 0);
  const stateFile = path.resolve(
    process.env.SAGE_BRIDGE_STATE_FILE ?? path.join(homedir(), ".sage", "android-bridge-state.json")
  );
  return {
    brainBaseUrl: brainBaseUrl.replace(/\/$/, ""),
    instance,
    deviceId,
    pollIntervalMs,
    maxJobsPerCycle,
    runOnce,
    attestation,
    allowedRoots,
    stateFile
  };
}

async function loadOrCreateBridgeState(stateFile: string): Promise<BridgeState> {
  try {
    const raw = await fs.readFile(stateFile, "utf8");
    const parsed = JSON.parse(raw) as BridgeState;
    if (!parsed.privateKeyPkcs8Base64 || !parsed.publicKeySpkiBase64) {
      throw new Error("bridge state file is malformed");
    }
    return parsed;
  } catch {
    const created = await createBridgeState();
    await fs.writeFile(stateFile, JSON.stringify(created, null, 2));
    return created;
  }
}

async function createBridgeState(): Promise<BridgeState> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const privatePkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const publicSpki = await crypto.subtle.exportKey("spki", keyPair.publicKey);
  return {
    privateKeyPkcs8Base64: toBase64(new Uint8Array(privatePkcs8)),
    publicKeySpkiBase64: toBase64(new Uint8Array(publicSpki))
  };
}

async function registerBridge(config: BridgeConfig, publicKey: string): Promise<void> {
  const requestedAt = new Date().toISOString();
  const body = {
    deviceId: config.deviceId,
    platform: "android",
    publicKey,
    attestation: config.attestation,
    nonce: crypto.randomUUID(),
    requestedAt
  };
  const response = await postJson(config, "/bridge/register", body);
  if (!response.ok) {
    throw new Error(`bridge register failed: ${JSON.stringify(response)}`);
  }
}

async function sendHeartbeat(config: BridgeConfig, privateKeyBase64: string): Promise<void> {
  const sentAt = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const signedAt = new Date().toISOString();
  const payload = {
    deviceId: config.deviceId,
    nonce,
    sentAt
  };
  const signature = await signBridgeRequest(privateKeyBase64, "bridge.heartbeat", signedAt, payload);
  const response = await postJson(config, "/bridge/heartbeat", {
    ...payload,
    signedAt,
    signature
  });
  if (!response.ok) {
    throw new Error(`bridge heartbeat failed: ${JSON.stringify(response)}`);
  }
}

async function pullJobs(
  config: BridgeConfig,
  privateKeyBase64: string,
  limit: number
): Promise<PullJob[]> {
  const requestedAt = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const signedAt = new Date().toISOString();
  const payload = {
    deviceId: config.deviceId,
    nonce,
    requestedAt,
    limit
  };
  const signature = await signBridgeRequest(privateKeyBase64, "bridge.jobs.pull", signedAt, payload);
  const response = await postJson(config, "/bridge/jobs/pull", {
    ...payload,
    signedAt,
    signature
  });
  if (!response.ok) {
    throw new Error(`bridge jobs pull failed: ${JSON.stringify(response)}`);
  }
  return Array.isArray(response.jobs) ? (response.jobs as PullJob[]) : [];
}

async function handleJob(config: BridgeConfig, privateKeyBase64: string, job: PullJob): Promise<void> {
  let status: "completed" | "failed" | "rejected" = "completed";
  let outputRef: string | undefined;
  let error: string | undefined;

  try {
    const result = await executeTool(config.allowedRoots, job.payload.action, job.payload.args);
    outputRef = encodeInlineJson({
      ok: true,
      value: result
    });
  } catch (executeError) {
    status = "failed";
    error = executeError instanceof Error ? executeError.message : "unknown execution error";
  }

  const reportedAt = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const resultId = crypto.randomUUID();
  const signedAt = new Date().toISOString();
  const signaturePayload = {
    resultId,
    jobId: job.jobId,
    deviceId: config.deviceId,
    nonce,
    status,
    outputRef: outputRef ?? null,
    error: error ?? null,
    reportedAt
  };
  const signature = await signBridgeRequest(
    privateKeyBase64,
    "bridge.jobs.result",
    signedAt,
    signaturePayload
  );

  const response = await postJson(config, "/bridge/jobs/result", {
    ...signaturePayload,
    outputRef,
    error,
    signedAt,
    signature
  });
  if (!response.ok) {
    throw new Error(`bridge jobs result failed: ${JSON.stringify(response)}`);
  }
}

async function executeTool(
  allowedRoots: string[],
  action: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const normalizedAction = action.trim().toLowerCase();
  if (normalizedAction === "status") {
    return { now: new Date().toISOString(), pid: process.pid };
  }

  const candidatePath = expectStringArg(args, "path");
  const resolved = path.resolve(candidatePath);
  assertPathAllowed(allowedRoots, resolved);

  if (normalizedAction === "read") {
    const content = await fs.readFile(resolved, "utf8");
    return { path: resolved, content };
  }
  if (normalizedAction === "list") {
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    return {
      path: resolved,
      entries: entries.map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory() ? "dir" : "file"
      }))
    };
  }
  if (normalizedAction === "write") {
    const content = expectStringArg(args, "content");
    await ensureParentDir(resolved);
    await fs.writeFile(resolved, content, "utf8");
    return { path: resolved, bytes: Buffer.byteLength(content, "utf8") };
  }

  throw new Error(`Unsupported action '${normalizedAction}'`);
}

function assertPathAllowed(allowedRoots: string[], targetPath: string): void {
  const allowed = allowedRoots.some((root) => {
    const relative = path.relative(root, targetPath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
  if (!allowed) {
    throw new Error("Path is outside allowed roots");
  }
}

async function signBridgeRequest(
  privateKeyBase64: string,
  operation: string,
  signedAt: string,
  payload: Record<string, unknown>
): Promise<string> {
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    fromBase64(privateKeyBase64),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const message = `${operation}\n${signedAt}\n${stableStringify(payload)}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(message)
  );
  return toBase64(new Uint8Array(signature));
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

async function postJson(
  config: BridgeConfig,
  suffix: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const url = `${config.brainBaseUrl}/agents/sage-agent/${encodeURIComponent(config.instance)}${suffix}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const json = (await response.json()) as Record<string, unknown>;
  return json;
}

function expectStringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected string arg '${key}'`);
  }
  return value;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

function encodeInlineJson(payload: Record<string, unknown>): string {
  return `inline:base64json:${toBase64(new TextEncoder().encode(JSON.stringify(payload)))}`;
}

function fromBase64(value: string): ArrayBuffer {
  const decoded = Buffer.from(value, "base64");
  const out = new ArrayBuffer(decoded.length);
  new Uint8Array(out).set(decoded);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

async function ensureParentDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

main().catch((error) => {
  console.error("[sage-android-bridge] fatal", error);
  process.exitCode = 1;
});
