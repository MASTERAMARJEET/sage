import type { AppEnv } from "../types/env";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type AiGatewayChatResponse = {
  response?: string;
  result?: {
    response?: string;
  };
};

export async function runChatViaAiGateway(
  env: AppEnv,
  messages: ChatMessage[],
  correlationId: string
): Promise<string> {
  const result = await env.AI.run<AiGatewayChatResponse>(
    env.AI_MODEL,
    { messages },
    {
      gateway: {
        id: env.AI_GATEWAY_ID,
        skipCache: false
      }
    }
  );

  const text = result.response ?? result.result?.response;
  if (!text) {
    throw new Error(`AI Gateway returned empty response. correlationId=${correlationId}`);
  }

  return text;
}
