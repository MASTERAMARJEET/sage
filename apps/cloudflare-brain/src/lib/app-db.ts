import type { D1Database } from "@cloudflare/workers-types";
import type { DeviceTrustTier } from "../types/protocol";

export async function ensureAppDbSchema(db: D1Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      trust_tier TEXT NOT NULL,
      public_key TEXT NOT NULL,
      attestation TEXT NOT NULL,
      enrolled_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approvals (
      approval_id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      resolved_by TEXT,
      resolved_at TEXT,
      resolution_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS policy_decisions (
      id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      allow INTEGER NOT NULL,
      risk_tier TEXT NOT NULL,
      requires_approval INTEGER NOT NULL,
      reason TEXT NOT NULL,
      decided_at TEXT NOT NULL
    );
  `);
}

export async function upsertDeviceRecord(
  db: D1Database,
  input: {
    deviceId: string;
    platform: "macos" | "android";
    trustTier: DeviceTrustTier;
    publicKey: string;
    attestation: string;
    enrolledAt: string;
    lastSeenAt: string;
  }
): Promise<void> {
  await db
    .prepare(
      `
      INSERT INTO devices (
        device_id, platform, trust_tier, public_key, attestation, enrolled_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        platform = excluded.platform,
        trust_tier = excluded.trust_tier,
        public_key = excluded.public_key,
        attestation = excluded.attestation,
        last_seen_at = excluded.last_seen_at
      `
    )
    .bind(
      input.deviceId,
      input.platform,
      input.trustTier,
      input.publicKey,
      input.attestation,
      input.enrolledAt,
      input.lastSeenAt
    )
    .run();
}

export async function updateDeviceHeartbeat(
  db: D1Database,
  input: { deviceId: string; lastSeenAt: string }
): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE devices SET last_seen_at = ? WHERE device_id = ?`)
    .bind(input.lastSeenAt, input.deviceId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

export async function insertApprovalRecord(
  db: D1Database,
  input: {
    approvalId: string;
    intentId: string;
    sessionId: string;
    status: "pending" | "approved" | "rejected";
    summary: string;
    createdAt: string;
    expiresAt: string;
  }
): Promise<void> {
  await db
    .prepare(
      `
      INSERT INTO approvals (
        approval_id, intent_id, session_id, status, summary, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    )
    .bind(
      input.approvalId,
      input.intentId,
      input.sessionId,
      input.status,
      input.summary,
      input.createdAt,
      input.expiresAt
    )
    .run();
}

export async function resolveApprovalRecord(
  db: D1Database,
  input: {
    approvalId: string;
    status: "approved" | "rejected";
    resolvedBy: string;
    resolvedAt: string;
    resolutionReason: string | null;
  }
): Promise<void> {
  await db
    .prepare(
      `
      UPDATE approvals
      SET status = ?, resolved_by = ?, resolved_at = ?, resolution_reason = ?
      WHERE approval_id = ?
      `
    )
    .bind(
      input.status,
      input.resolvedBy,
      input.resolvedAt,
      input.resolutionReason,
      input.approvalId
    )
    .run();
}

export async function insertPolicyDecisionRecord(
  db: D1Database,
  input: {
    id: string;
    intentId: string;
    sessionId: string;
    allow: boolean;
    riskTier: string;
    requiresApproval: boolean;
    reason: string;
    decidedAt: string;
  }
): Promise<void> {
  await db
    .prepare(
      `
      INSERT INTO policy_decisions (
        id, intent_id, session_id, allow, risk_tier, requires_approval, reason, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .bind(
      input.id,
      input.intentId,
      input.sessionId,
      input.allow ? 1 : 0,
      input.riskTier,
      input.requiresApproval ? 1 : 0,
      input.reason,
      input.decidedAt
    )
    .run();
}
