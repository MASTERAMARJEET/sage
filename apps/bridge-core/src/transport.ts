export type BridgeTransportConfig = {
  brainBaseUrl: string;
  instance: string;
  requestTimeoutMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
};

export type BridgeErrorEnvelope = {
  ok?: boolean;
  reason?: string;
  [key: string]: unknown;
};

export function createBridgeTransport(config: BridgeTransportConfig): {
  postJson: (suffix: string, body: Record<string, unknown>) => Promise<BridgeErrorEnvelope>;
} {
  const baseUrl = config.brainBaseUrl.replace(/\/$/, "");
  const instance = encodeURIComponent(config.instance);
  const requestTimeoutMs = Math.max(config.requestTimeoutMs ?? 10_000, 1_000);
  const maxAttempts = Math.max(config.maxAttempts ?? 3, 1);
  const baseBackoffMs = Math.max(config.baseBackoffMs ?? 250, 50);

  return {
    async postJson(suffix: string, body: Record<string, unknown>): Promise<BridgeErrorEnvelope> {
      const url = `${baseUrl}/agents/sage-agent/${instance}${suffix}`;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

        try {
          const response = await fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify(body),
            signal: controller.signal
          });

          const envelope = await parseJsonEnvelope(response);
          if (response.ok || !shouldRetryStatus(response.status) || attempt === maxAttempts) {
            return envelope;
          }
        } catch (error) {
          if (attempt === maxAttempts) {
            return {
              ok: false,
              reason:
                error instanceof Error
                  ? `Bridge request failed: ${error.message}`
                  : "Bridge request failed"
            };
          }
        } finally {
          clearTimeout(timeout);
        }

        await sleep(baseBackoffMs * 2 ** (attempt - 1));
      }

      return { ok: false, reason: "Bridge request exhausted retry budget" };
    }
  };
}

function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function parseJsonEnvelope(response: Response): Promise<BridgeErrorEnvelope> {
  try {
    return (await response.json()) as BridgeErrorEnvelope;
  } catch {
    return {
      ok: false,
      reason: `Unexpected non-JSON response (status ${response.status})`
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
