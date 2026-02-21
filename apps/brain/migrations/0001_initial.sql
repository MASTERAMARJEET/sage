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
