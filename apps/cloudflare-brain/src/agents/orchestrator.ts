import { Agent } from "agents";
import { runChatViaAiGateway } from "../lib/ai-gateway";
import { ensureSqlSchema, insertAuditEvent, insertSessionMessage } from "../lib/db";
import type { AppEnv } from "../types/env";
import { toolIntentSchema, type ToolIntent } from "../types/protocol";

type SessionDigest = {
  lastMessageAt: string;
  messageCount: number;
};

type SageAgentState = {
  sessions: Record<string, SessionDigest>;
};

export class SageAgent extends Agent<AppEnv, SageAgentState> {
  initialState: SageAgentState = {
    sessions: {}
  };

  onStart(): void {
    ensureSqlSchema(this);
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname.endsWith("/message")) {
      const input = (await request.json()) as { sessionId: string; content: string };
      const result = await this.sendUserMessage(input);
      return Response.json(result);
    }

    if (request.method === "POST" && url.pathname.endsWith("/tool-intent")) {
      const input = (await request.json()) as ToolIntent;
      const result = await this.submitToolIntent(input);
      return Response.json(result);
    }

    if (request.method === "GET" && url.pathname.endsWith("/state")) {
      return Response.json(this.state);
    }

    return new Response("Not found", { status: 404 });
  }

  async sendUserMessage(input: { sessionId: string; content: string }): Promise<{ reply: string }> {
    const timestamp = nowIso();
    const correlationId = crypto.randomUUID();

    if (!input.sessionId || !input.content) {
      throw new Error("sessionId and content are required");
    }

    insertSessionMessage(this, {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      role: "user",
      content: input.content,
      createdAt: timestamp
    });

    await this.persistAudit(input.sessionId, "llm_invoked", { role: "user" }, correlationId);

    const reply = await runChatViaAiGateway(
      this.env,
      [
        {
          role: "system",
          content:
            "You are Sage, a cloud control-plane brain. Always enforce explicit approvals for risky local actions."
        },
        { role: "user", content: input.content }
      ],
      correlationId
    );

    insertSessionMessage(this, {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      role: "assistant",
      content: reply,
      createdAt: nowIso()
    });

    const current = this.state.sessions[input.sessionId] ?? {
      lastMessageAt: timestamp,
      messageCount: 0
    };

    this.setState({
      ...this.state,
      sessions: {
        ...this.state.sessions,
        [input.sessionId]: {
          lastMessageAt: nowIso(),
          messageCount: current.messageCount + 2
        }
      }
    });

    return { reply };
  }

  async submitToolIntent(raw: ToolIntent): Promise<{ accepted: boolean; reason?: string }> {
    const parsed = toolIntentSchema.safeParse(raw);
    if (!parsed.success) {
      return { accepted: false, reason: "Invalid tool intent payload" };
    }

    await this.persistAudit(
      parsed.data.sessionId,
      "intent_received",
      {
        intentId: parsed.data.id,
        tool: parsed.data.tool,
        action: parsed.data.action
      },
      parsed.data.id
    );

    return { accepted: true };
  }

  private async persistAudit(
    sessionId: string,
    kind: string,
    payload: Record<string, unknown>,
    correlationId: string
  ): Promise<void> {
    const eventId = crypto.randomUUID();
    const createdAt = nowIso();
    const payloadJson = JSON.stringify(payload);

    insertAuditEvent(this, {
      id: eventId,
      sessionId,
      kind,
      payloadJson,
      correlationId,
      createdAt
    });

    await this.env.APP_AUDIT_BUCKET.put(
      `events/${sessionId}/${createdAt}-${eventId}.json`,
      JSON.stringify({
        id: eventId,
        sessionId,
        kind,
        payload,
        correlationId,
        createdAt
      })
    );
  }
}

function nowIso(): string {
  return new Date().toISOString();
}
