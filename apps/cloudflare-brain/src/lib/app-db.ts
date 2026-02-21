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

    CREATE TABLE IF NOT EXISTS execution_jobs (
      job_id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      dispatched_at TEXT,
      lease_expires_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      output_ref TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS execution_job_results (
      result_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      status TEXT NOT NULL,
      output_ref TEXT,
      error TEXT,
      reported_at TEXT NOT NULL
    );
  `);
}

export type ExecutionJobRow = {
  job_id: string;
  intent_id: string;
  session_id: string;
  device_id: string;
  payload_json: string;
  status: "pending" | "dispatched" | "completed" | "failed" | "rejected";
  created_at: string;
  dispatched_at: string | null;
  lease_expires_at: string | null;
  attempt_count: number;
  completed_at: string | null;
  output_ref: string | null;
  error: string | null;
};

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

export async function insertExecutionJob(
  db: D1Database,
  input: {
    jobId: string;
    intentId: string;
    sessionId: string;
    deviceId: string;
    payloadJson: string;
    createdAt: string;
  }
): Promise<void> {
  await db
    .prepare(
      `
      INSERT INTO execution_jobs (
        job_id, intent_id, session_id, device_id, payload_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
      `
    )
    .bind(
      input.jobId,
      input.intentId,
      input.sessionId,
      input.deviceId,
      input.payloadJson,
      input.createdAt
    )
    .run();
}

export async function pullPendingExecutionJobs(
  db: D1Database,
  input: {
    deviceId: string;
    limit: number;
    dispatchedAt: string;
    leaseExpiresAt: string;
  }
): Promise<ExecutionJobRow[]> {
  await db
    .prepare(
      `
      UPDATE execution_jobs
      SET status = 'pending', dispatched_at = NULL, lease_expires_at = NULL
      WHERE device_id = ? AND status = 'dispatched' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
      `
    )
    .bind(input.deviceId, input.dispatchedAt)
    .run();

  const result = await db
    .prepare(
      `
      SELECT *
      FROM execution_jobs
      WHERE device_id = ? AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT ?
      `
    )
    .bind(input.deviceId, input.limit)
    .all<ExecutionJobRow>();

  const jobs = result.results ?? [];
  if (jobs.length === 0) {
    return [];
  }

  for (const job of jobs) {
    await db
      .prepare(
        `
        UPDATE execution_jobs
        SET status = 'dispatched', dispatched_at = ?, lease_expires_at = ?, attempt_count = attempt_count + 1
        WHERE job_id = ? AND status = 'pending'
        `
      )
      .bind(input.dispatchedAt, input.leaseExpiresAt, job.job_id)
      .run();
  }

  return jobs.map((job) => ({
    ...job,
    status: "dispatched",
    dispatched_at: input.dispatchedAt,
    lease_expires_at: input.leaseExpiresAt,
    attempt_count: (job.attempt_count ?? 0) + 1
  }));
}

export async function insertExecutionJobResult(
  db: D1Database,
  input: {
    resultId: string;
    jobId: string;
    deviceId: string;
    status: "completed" | "failed" | "rejected";
    outputRef?: string;
    error?: string;
    reportedAt: string;
  }
): Promise<"inserted" | "duplicate"> {
  const result = await db
    .prepare(
      `
      INSERT OR IGNORE INTO execution_job_results (
        result_id, job_id, device_id, status, output_ref, error, reported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    )
    .bind(
      input.resultId,
      input.jobId,
      input.deviceId,
      input.status,
      input.outputRef ?? null,
      input.error ?? null,
      input.reportedAt
    )
    .run();

  return (result.meta.changes ?? 0) > 0 ? "inserted" : "duplicate";
}

export async function completeExecutionJob(
  db: D1Database,
  input: {
    jobId: string;
    deviceId: string;
    status: "completed" | "failed" | "rejected";
    completedAt: string;
    outputRef?: string;
    error?: string;
  }
): Promise<"updated" | "already_final" | "not_found"> {
  const lookup = await db
    .prepare(`SELECT status FROM execution_jobs WHERE job_id = ? AND device_id = ?`)
    .bind(input.jobId, input.deviceId)
    .first<{ status: string }>();

  if (!lookup) {
    return "not_found";
  }

  if (lookup.status === "completed" || lookup.status === "failed" || lookup.status === "rejected") {
    return "already_final";
  }

  const result = await db
    .prepare(
      `
      UPDATE execution_jobs
      SET status = ?, completed_at = ?, output_ref = ?, error = ?, lease_expires_at = NULL
      WHERE job_id = ? AND device_id = ? AND status IN ('pending', 'dispatched')
      `
    )
    .bind(
      input.status,
      input.completedAt,
      input.outputRef ?? null,
      input.error ?? null,
      input.jobId,
      input.deviceId
    )
    .run();

  return (result.meta.changes ?? 0) > 0 ? "updated" : "not_found";
}
