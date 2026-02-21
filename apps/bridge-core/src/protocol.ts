export type BridgeRegistrationRequest = {
  deviceId: string;
  platform: "macos" | "android";
  publicKey: string;
  attestation: string;
  nonce: string;
  requestedAt: string;
};

export type BridgeHeartbeatRequest = {
  deviceId: string;
  nonce: string;
  sentAt: string;
  signedAt: string;
  signature: string;
};

export type BridgeJobPullRequest = {
  deviceId: string;
  nonce: string;
  requestedAt: string;
  limit: number;
  signedAt: string;
  signature: string;
};

export type BridgeJobResultRequest = {
  resultId: string;
  jobId: string;
  deviceId: string;
  nonce: string;
  status: "completed" | "failed" | "rejected";
  outputRef?: string;
  error?: string;
  reportedAt: string;
  signedAt: string;
  signature: string;
};

export type BridgePullJob = {
  jobId: string;
  intentId: string;
  payload: {
    action: string;
    args: Record<string, unknown>;
  };
};
