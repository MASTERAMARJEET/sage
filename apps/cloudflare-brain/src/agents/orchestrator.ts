import { Agent } from "agents";
import { runChatViaAiGateway } from "../lib/ai-gateway";
import { ensureSqlSchema, insertAuditEvent, insertSessionMessage } from "../lib/db";
import { evaluateToolIntentPolicy } from "../lib/policy";
import type { AppEnv } from "../types/env";
import {
  approvalResolutionSchema,
  toolIntentSchema,
  type ApprovalRequest,
  type ToolIntent
} from "../types/protocol";

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

    if (request.method === "POST" && url.pathname.endsWith("/approval/resolve")) {
      const input = await request.json();
      const parsed = approvalResolutionSchema.safeParse(input);
      if (!parsed.success) {
        return Response.json(
          {
            ok: false,
            reason: "Invalid approval resolution payload"
          },
          { status: 400 }
        );
      }

      const result = await this.resolveApproval(parsed.data);
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

  async submitToolIntent(raw: ToolIntent): Promise<{
    accepted: boolean;
    reason?: string;
    requiresApproval?: boolean;
    approvalId?: string;
  }> {
    const parsed = toolIntentSchema.safeParse(raw);
    if (!parsed.success) {
      return { accepted: false, reason: "Invalid tool intent payload" };
    }

    const decision = evaluateToolIntentPolicy(parsed.data);

    await this.persistAudit(
      parsed.data.sessionId,
      "policy_decided",
      {
        intentId: parsed.data.id,
        allow: decision.allow,
        requiresApproval: decision.requiresApproval,
        riskTier: decision.riskTier,
        reason: decision.reason
      },
      parsed.data.id
    );

    if (!decision.allow) {
      return { accepted: false, reason: decision.reason };
    }

    if (decision.requiresApproval) {
      const approvalRequest = await this.createApprovalRequest(parsed.data, decision.reason);

      await this.persistAudit(
        parsed.data.sessionId,
        "approval_requested",
        approvalRequest,
        parsed.data.id
      );

      return {
        accepted: false,
        requiresApproval: true,
        approvalId: approvalRequest.id,
        reason: decision.reason
      };
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

  private async createApprovalRequest(intent: ToolIntent, summary: string): Promise<ApprovalRequest> {
    const now = Date.now();
    const request: ApprovalRequest = {
      id: crypto.randomUUID(),
      intentId: intent.id,
      sessionId: intent.sessionId,
      summary,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 15 * 60 * 1000).toISOString()
    };

    await this.env.APP_KV.put(
      `approval:${request.id}`,
      JSON.stringify({
        ...request,
        status: "pending"
      }),
      { expirationTtl: 15 * 60 }
    );

    return request;
  }

  private async resolveApproval(input: {
    approvalId: string;
    approved: boolean;
    reason?: string;
    resolvedBy: string;
    resolvedAt: string;
  }): Promise<{ ok: boolean; reason?: string }> {
    const key = `approval:${input.approvalId}`;
    const existing = await this.env.APP_KV.get(key, "json");

    if (!existing || typeof existing !== "object") {
      return { ok: false, reason: "Approval request not found or expired" };
    }

    const pending = existing as Record<string, unknown>;
    if (pending.status !== "pending") {
      return { ok: false, reason: "Approval is already resolved" };
    }

    const updated = {
      ...pending,
      status: input.approved ? "approved" : "rejected",
      resolvedBy: input.resolvedBy,
      resolvedAt: input.resolvedAt,
      resolutionReason: input.reason ?? null
    };

    await this.env.APP_KV.put(key, JSON.stringify(updated), { expirationTtl: 24 * 60 * 60 });

    const sessionId = typeof pending.sessionId === "string" ? pending.sessionId : "unknown-session";

    await this.persistAudit(
      sessionId,
      "approval_resolved",
      {
        approvalId: input.approvalId,
        approved: input.approved,
        resolvedBy: input.resolvedBy,
        reason: input.reason ?? null
      },
      input.approvalId
    );

    return { ok: true };
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
