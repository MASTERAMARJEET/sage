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

CREATE INDEX IF NOT EXISTS idx_execution_jobs_device_status
ON execution_jobs(device_id, status, created_at);

CREATE TABLE IF NOT EXISTS execution_job_results (
  result_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  status TEXT NOT NULL,
  output_ref TEXT,
  error TEXT,
  reported_at TEXT NOT NULL
);
