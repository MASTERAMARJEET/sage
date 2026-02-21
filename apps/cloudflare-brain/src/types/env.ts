export type AiRunOptions = {
  gateway?: {
    id: string;
    skipCache?: boolean;
    cacheTtl?: number;
  };
};

export type AiBinding = {
  run<TOutput = unknown>(
    model: string,
    input: unknown,
    options?: AiRunOptions
  ): Promise<TOutput>;
};

export type AppEnv = {
  SageAgent: DurableObjectNamespace;
  APP_DB: D1Database;
  APP_KV: KVNamespace;
  APP_AUDIT_BUCKET: R2Bucket;
  AI: AiBinding;
  AI_GATEWAY_ID: string;
  AI_MODEL: string;
  APP_ENV: string;
  OPERATOR_TOKEN?: string;
  BRIDGE_SIGNATURE_MODE?: "off" | "optional" | "required";
};
