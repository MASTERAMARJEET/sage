import { Agent } from "agents";
import {
  expirePendingApprovals,
  cancelExecutionJob,
  completeExecutionJob,
  ensureAppDbSchema,
  getExecutionQueueSummary,
  getExecutionJobById,
  insertExecutionJobResult,
  insertApprovalRecord,
  insertExecutionJob,
  insertPolicyDecisionRecord,
  listExecutionJobsByDevice,
  listDevices,
  listExecutionJobsBySession,
  listPendingApprovals,
  pullPendingExecutionJobs,
  purgeOldExecutionArtifacts,
  requeueExecutionJob,
  resolveApprovalRecord,
  updateDeviceHeartbeat,
  upsertDeviceRecord
} from "../lib/app-db";
import { runChatViaAiGateway } from "../lib/ai-gateway";
import { ensureSqlSchema, insertAuditEvent, insertSessionMessage } from "../lib/db";
import {
  evaluateDispatchAuthorization,
  ensureBridgeRegistered,
  evaluateTrustTierAuthorization,
  isBridgeOnline,
  isReplayNonceAllowed,
  validateApprovalResolutionState,
  verifyBridgeRequestSignature
} from "../lib/guardrails";
import { evaluateToolIntentPolicy } from "../lib/policy";
import type { AppEnv } from "../types/env";
import {
  approvalResolutionSchema,
  bridgeJobPullRequestSchema,
  bridgeJobResultSchema,
  dispatchAuthorizationRequestSchema,
  jobControlRequestSchema,
  maintenanceCleanupRequestSchema,
  bridgeHeartbeatSchema,
  bridgeRegistrationSchema,
  deviceTrustTierSchema,
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
    this.ctx.waitUntil(ensureAppDbSchema(this.env.APP_DB));
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET") {
      const result = await this.handleJobQuery(request, path, url.searchParams);
      if (result) {
        return result;
      }
    }

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

    if (request.method === "POST" && url.pathname.endsWith("/tool-intent/authorize-dispatch")) {
      const input = await request.json();
      const parsed = dispatchAuthorizationRequestSchema.safeParse(input);
      if (!parsed.success) {
        return Response.json(
          {
            authorized: false,
            reason: "Invalid dispatch authorization payload"
          },
          { status: 400 }
        );
      }
      const result = await this.authorizeDispatch(parsed.data);
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

    if (request.method === "POST" && url.pathname.endsWith("/bridge/register")) {
      const input = await request.json();
      const parsed = bridgeRegistrationSchema.safeParse(input);
      if (!parsed.success) {
        return Response.json(
          {
            ok: false,
            reason: "Invalid bridge registration payload"
          },
          { status: 400 }
        );
      }

      const result = await this.registerBridge(parsed.data);
      return Response.json(result);
    }

    if (request.method === "POST" && url.pathname.endsWith("/bridge/heartbeat")) {
      const input = await request.json();
      const parsed = bridgeHeartbeatSchema.safeParse(input);
      if (!parsed.success) {
        return Response.json(
          {
            ok: false,
            reason: "Invalid bridge heartbeat payload"
          },
          { status: 400 }
        );
      }

      const result = await this.bridgeHeartbeat(parsed.data);
      return Response.json(result);
    }

    if (request.method === "POST" && url.pathname.endsWith("/bridge/jobs/pull")) {
      const input = await request.json();
      const parsed = bridgeJobPullRequestSchema.safeParse(input);
      if (!parsed.success) {
        return Response.json(
          {
            ok: false,
            reason: "Invalid bridge jobs pull payload"
          },
          { status: 400 }
        );
      }

      const result = await this.pullBridgeJobs(parsed.data);
      return Response.json(result);
    }

    if (request.method === "POST" && url.pathname.endsWith("/bridge/jobs/result")) {
      const input = await request.json();
      const parsed = bridgeJobResultSchema.safeParse(input);
      if (!parsed.success) {
        return Response.json(
          {
            ok: false,
            reason: "Invalid bridge job result payload"
          },
          { status: 400 }
        );
      }

      const result = await this.submitBridgeJobResult(parsed.data);
      return Response.json(result);
    }

    if (request.method === "POST" && /\/jobs\/[^/]+\/cancel$/.test(url.pathname)) {
      if (!(await this.isOperatorAuthorized(request))) {
        return Response.json({ ok: false, reason: "Unauthorized" }, { status: 401 });
      }
      const input = await request.json();
      const parsed = jobControlRequestSchema.safeParse(input);
      if (!parsed.success) {
        return Response.json({ ok: false, reason: "Invalid cancel job payload" }, { status: 400 });
      }
      const jobId = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
      const result = await this.cancelJob(jobId, parsed.data);
      return Response.json(result);
    }

    if (request.method === "POST" && /\/jobs\/[^/]+\/requeue$/.test(url.pathname)) {
      if (!(await this.isOperatorAuthorized(request))) {
        return Response.json({ ok: false, reason: "Unauthorized" }, { status: 401 });
      }
      const input = await request.json();
      const parsed = jobControlRequestSchema.safeParse(input);
      if (!parsed.success) {
        return Response.json({ ok: false, reason: "Invalid requeue job payload" }, { status: 400 });
      }
      const jobId = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
      const result = await this.requeueJob(jobId, parsed.data);
      return Response.json(result);
    }

    if (request.method === "POST" && url.pathname.endsWith("/maintenance/cleanup")) {
      if (!(await this.isOperatorAuthorized(request))) {
        return Response.json({ ok: false, reason: "Unauthorized" }, { status: 401 });
      }
      const input = await request.json();
      const parsed = maintenanceCleanupRequestSchema.safeParse(input);
      if (!parsed.success) {
        return Response.json({ ok: false, reason: "Invalid cleanup payload" }, { status: 400 });
      }
      const result = await this.runMaintenanceCleanup(parsed.data);
      return Response.json(result);
    }

    if (request.method === "GET" && url.pathname.endsWith("/state")) {
      return Response.json(this.state);
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleJobQuery(
    request: Request,
    path: string,
    searchParams: URLSearchParams
  ): Promise<Response | null> {
    if (path.endsWith("/approvals/pending")) {
      if (!(await this.isOperatorAuthorized(request))) {
        return Response.json({ ok: false, reason: "Unauthorized" }, { status: 401 });
      }
      const limit = Math.min(Number.parseInt(searchParams.get("limit") ?? "20", 10) || 20, 100);
      const sessionId = searchParams.get("sessionId") ?? undefined;
      const approvals = await listPendingApprovals(this.env.APP_DB, { limit, sessionId });
      return Response.json({
        ok: true,
        approvals: approvals.map((approval) => ({
          approvalId: approval.approval_id,
          intentId: approval.intent_id,
          sessionId: approval.session_id,
          summary: approval.summary,
          createdAt: approval.created_at,
          expiresAt: approval.expires_at
        }))
      });
    }

    if (path.endsWith("/metrics/queue")) {
      if (!(await this.isOperatorAuthorized(request))) {
        return Response.json({ ok: false, reason: "Unauthorized" }, { status: 401 });
      }
      const deviceId = searchParams.get("deviceId") ?? undefined;
      const summary = await getExecutionQueueSummary(this.env.APP_DB, { deviceId });
      return Response.json({
        ok: true,
        metrics: {
          deviceId: deviceId ?? null,
          byStatus: summary
        }
      });
    }

    if (path.endsWith("/bridges")) {
      if (!(await this.isOperatorAuthorized(request))) {
        return Response.json({ ok: false, reason: "Unauthorized" }, { status: 401 });
      }
      const limit = Math.min(Number.parseInt(searchParams.get("limit") ?? "50", 10) || 50, 200);
      const platformParam = searchParams.get("platform");
      const trustTierParam = searchParams.get("trustTier");
      const platform =
        platformParam === "macos" || platformParam === "android" ? platformParam : undefined;
      const trustTierParsed = deviceTrustTierSchema.safeParse(trustTierParam);
      const trustTier = trustTierParsed.success ? trustTierParsed.data : undefined;
      const bridges = await listDevices(this.env.APP_DB, { limit, platform, trustTier });
      return Response.json({
        ok: true,
        bridges: bridges.map((bridge) => ({
          deviceId: bridge.device_id,
          platform: bridge.platform,
          trustTier: bridge.trust_tier,
          enrolledAt: bridge.enrolled_at,
          lastSeenAt: bridge.last_seen_at
        }))
      });
    }

    const jobPathMatch = path.match(/\/jobs\/([^/]+)$/);
    if (jobPathMatch) {
      if (!(await this.isOperatorAuthorized(request))) {
        return Response.json({ ok: false, reason: "Unauthorized" }, { status: 401 });
      }
      const jobId = decodeURIComponent(jobPathMatch[1]);
      const job = await getExecutionJobById(this.env.APP_DB, jobId);
      if (!job) {
        return Response.json({ ok: false, reason: "Job not found" }, { status: 404 });
      }
      return Response.json({
        ok: true,
        job: this.serializeJobRow(job)
      });
    }

    const sessionJobsMatch = path.match(/\/sessions\/([^/]+)\/jobs$/);
    if (sessionJobsMatch) {
      if (!(await this.isOperatorAuthorized(request))) {
        return Response.json({ ok: false, reason: "Unauthorized" }, { status: 401 });
      }
      const sessionId = decodeURIComponent(sessionJobsMatch[1]);
      const limit = Math.min(Number.parseInt(searchParams.get("limit") ?? "20", 10) || 20, 100);
      const jobs = await listExecutionJobsBySession(this.env.APP_DB, { sessionId, limit });
      return Response.json({
        ok: true,
        jobs: jobs.map((job) => this.serializeJobRow(job))
      });
    }

    const deviceJobsMatch = path.match(/\/devices\/([^/]+)\/jobs$/);
    if (deviceJobsMatch) {
      if (!(await this.isOperatorAuthorized(request))) {
        return Response.json({ ok: false, reason: "Unauthorized" }, { status: 401 });
      }
      const deviceId = decodeURIComponent(deviceJobsMatch[1]);
      const limit = Math.min(Number.parseInt(searchParams.get("limit") ?? "20", 10) || 20, 100);
      const jobs = await listExecutionJobsByDevice(this.env.APP_DB, { deviceId, limit });
      return Response.json({
        ok: true,
        jobs: jobs.map((job) => this.serializeJobRow(job))
      });
    }

    return null;
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

    const bridge = await this.env.APP_KV.get(`bridge:${parsed.data.actorDeviceId}`, "json");
    const bridgeCheck = ensureBridgeRegistered(bridge);
    if (!bridgeCheck.ok) {
      return { accepted: false, reason: bridgeCheck.reason };
    }

    const bridgeRecord = bridge as Record<string, unknown>;
    const trustTier = deviceTrustTierSchema.safeParse(bridgeRecord.trustTier);
    if (!trustTier.success) {
      return { accepted: false, reason: "Bridge trust tier is missing or invalid" };
    }

    const trustDecision = evaluateTrustTierAuthorization({
      trustTier: trustTier.data,
      action: parsed.data.action
    });
    if (!trustDecision.allowed) {
      await this.persistAudit(
        parsed.data.sessionId,
        "policy_decided",
        {
          intentId: parsed.data.id,
          allow: false,
          requiresApproval: false,
          riskTier: "critical",
          reason: trustDecision.reason
        },
        parsed.data.id
      );
      return { accepted: false, reason: trustDecision.reason };
    }

    const decision = evaluateToolIntentPolicy(parsed.data);

    await insertPolicyDecisionRecord(this.env.APP_DB, {
      id: crypto.randomUUID(),
      intentId: parsed.data.id,
      sessionId: parsed.data.sessionId,
      allow: decision.allow,
      riskTier: decision.riskTier,
      requiresApproval: decision.requiresApproval,
      reason: decision.reason,
      decidedAt: decision.decidedAt
    });

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
    const approvalToken = crypto.randomUUID();
    const request: ApprovalRequest = {
      id: crypto.randomUUID(),
      intentId: intent.id,
      sessionId: intent.sessionId,
      summary,
      approvalToken,
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

    await insertApprovalRecord(this.env.APP_DB, {
      approvalId: request.id,
      intentId: request.intentId,
      sessionId: request.sessionId,
      status: "pending",
      summary: request.summary,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt
    });

    return request;
  }

  private async resolveApproval(input: {
    approvalId: string;
    approvalToken: string;
    nonce: string;
    approved: boolean;
    reason?: string;
    resolvedBy: string;
    resolvedAt: string;
  }): Promise<{ ok: boolean; reason?: string }> {
    if (!(await this.consumeReplayNonce(input.nonce, 5 * 60))) {
      return { ok: false, reason: "Replay-protection nonce already used" };
    }

    const key = `approval:${input.approvalId}`;
    const existing = await this.env.APP_KV.get(key, "json");

    if (!existing || typeof existing !== "object") {
      return { ok: false, reason: "Approval request not found or expired" };
    }

    const pending = existing as Record<string, unknown>;
    const resolutionCheck = validateApprovalResolutionState({
      pending,
      approvalToken: input.approvalToken,
      now: new Date()
    });
    if (!resolutionCheck.ok) {
      return { ok: false, reason: resolutionCheck.reason };
    }

    const updated = {
      ...pending,
      status: input.approved ? "approved" : "rejected",
      approvalToken: null,
      resolvedBy: input.resolvedBy,
      resolvedAt: input.resolvedAt,
      resolutionReason: input.reason ?? null
    };

    await this.env.APP_KV.put(key, JSON.stringify(updated), { expirationTtl: 24 * 60 * 60 });

    await resolveApprovalRecord(this.env.APP_DB, {
      approvalId: input.approvalId,
      status: input.approved ? "approved" : "rejected",
      resolvedBy: input.resolvedBy,
      resolvedAt: input.resolvedAt,
      resolutionReason: input.reason ?? null
    });

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

  private async registerBridge(input: {
    deviceId: string;
    platform: "macos" | "android";
    publicKey: string;
    attestation: string;
    nonce: string;
    requestedAt: string;
  }): Promise<{ ok: boolean; trustTier?: "trusted" | "restricted" | "quarantined"; reason?: string }> {
    if (!(await this.consumeReplayNonce(input.nonce, 5 * 60))) {
      return { ok: false, reason: "Replay-protection nonce already used" };
    }

    const trustTier = this.deriveTrustTier(input.attestation);

    await this.env.APP_KV.put(
      `bridge:${input.deviceId}`,
      JSON.stringify({
        deviceId: input.deviceId,
        platform: input.platform,
        trustTier,
        publicKey: input.publicKey,
        attestation: input.attestation,
        enrolledAt: input.requestedAt,
        lastSeenAt: nowIso()
      })
    );

    await upsertDeviceRecord(this.env.APP_DB, {
      deviceId: input.deviceId,
      platform: input.platform,
      trustTier,
      publicKey: input.publicKey,
      attestation: input.attestation,
      enrolledAt: input.requestedAt,
      lastSeenAt: nowIso()
    });

    await this.persistAudit(
      "bridge-control",
      "execution_dispatched",
      {
        deviceId: input.deviceId,
        platform: input.platform,
        trustTier,
        event: "bridge_registered"
      },
      input.deviceId
    );

    return { ok: true, trustTier };
  }

  private async bridgeHeartbeat(input: {
    deviceId: string;
    nonce: string;
    sentAt: string;
    signature?: string;
    signedAt?: string;
  }): Promise<{ ok: boolean; reason?: string }> {
    if (!(await this.consumeReplayNonce(input.nonce, 5 * 60))) {
      return { ok: false, reason: "Replay-protection nonce already used" };
    }

    const kvKey = `bridge:${input.deviceId}`;
    const existing = await this.env.APP_KV.get(kvKey, "json");
    const bridgeCheck = ensureBridgeRegistered(existing);
    if (!bridgeCheck.ok) {
      return { ok: false, reason: bridgeCheck.reason };
    }

    const bridge = existing as Record<string, unknown>;
    const signatureCheck = await verifyBridgeRequestSignature({
      mode: this.env.BRIDGE_SIGNATURE_MODE,
      bridgeRecord: bridge,
      operation: "bridge.heartbeat",
      signedAt: input.signedAt,
      signature: input.signature,
      payload: {
        deviceId: input.deviceId,
        nonce: input.nonce,
        sentAt: input.sentAt
      },
      now: new Date(input.sentAt)
    });
    if (!signatureCheck.ok) {
      return { ok: false, reason: signatureCheck.reason };
    }

    const updated = {
      ...bridge,
      lastSeenAt: input.sentAt
    };

    await this.env.APP_KV.put(kvKey, JSON.stringify(updated));
    await updateDeviceHeartbeat(this.env.APP_DB, {
      deviceId: input.deviceId,
      lastSeenAt: input.sentAt
    });

    return { ok: true };
  }

  private async authorizeDispatch(input: {
    intent: ToolIntent;
    approvalId?: string;
    requestedAt: string;
  }): Promise<{ authorized: boolean; reason?: string; deviceId?: string; jobId?: string }> {
    const bridge = await this.env.APP_KV.get(`bridge:${input.intent.actorDeviceId}`, "json");
    const bridgeCheck = ensureBridgeRegistered(bridge);
    if (!bridgeCheck.ok) {
      return { authorized: false, reason: bridgeCheck.reason };
    }

    const bridgeRecord = bridge as Record<string, unknown>;
    const trustTier = deviceTrustTierSchema.safeParse(bridgeRecord.trustTier);
    if (!trustTier.success) {
      return { authorized: false, reason: "Bridge trust tier is missing or invalid" };
    }

    const trustDecision = evaluateTrustTierAuthorization({
      trustTier: trustTier.data,
      action: input.intent.action
    });
    if (!trustDecision.allowed) {
      return { authorized: false, reason: trustDecision.reason };
    }

    const policyDecision = evaluateToolIntentPolicy(input.intent);
    let approvalStatus: string | undefined;

    if (policyDecision.requiresApproval) {
      if (!input.approvalId) {
        return { authorized: false, reason: "Approval ID required for this action" };
      }

      const approval = await this.env.APP_KV.get(`approval:${input.approvalId}`, "json");
      if (!approval || typeof approval !== "object") {
        return { authorized: false, reason: "Approval request not found or expired" };
      }

      const pending = approval as Record<string, unknown>;
      if (pending.intentId !== input.intent.id) {
        return { authorized: false, reason: "Approval does not match intent" };
      }
      approvalStatus = typeof pending.status === "string" ? pending.status : undefined;
    }

    const online = isBridgeOnline({
      lastSeenAt:
        typeof bridgeRecord.lastSeenAt === "string" ? bridgeRecord.lastSeenAt : "1970-01-01T00:00:00.000Z",
      now: new Date(input.requestedAt)
    });

    const dispatchDecision = evaluateDispatchAuthorization({
      requiresApproval: policyDecision.requiresApproval,
      approvalStatus,
      bridgeOnline: online
    });
    if (!dispatchDecision.allowed) {
      return { authorized: false, reason: dispatchDecision.reason };
    }

    await this.persistAudit(
      input.intent.sessionId,
      "execution_dispatched",
      {
        intentId: input.intent.id,
        deviceId: input.intent.actorDeviceId
      },
      input.intent.id
    );

    const jobId = crypto.randomUUID();
    await insertExecutionJob(this.env.APP_DB, {
      jobId,
      intentId: input.intent.id,
      sessionId: input.intent.sessionId,
      deviceId: input.intent.actorDeviceId,
      payloadJson: JSON.stringify(input.intent),
      createdAt: nowIso()
    });

    return {
      authorized: true,
      deviceId: input.intent.actorDeviceId,
      jobId
    };
  }

  private async pullBridgeJobs(input: {
    deviceId: string;
    nonce: string;
    requestedAt: string;
    limit?: number;
    signature?: string;
    signedAt?: string;
  }): Promise<{ ok: boolean; reason?: string; jobs?: Array<Record<string, unknown>> }> {
    if (!(await this.consumeReplayNonce(input.nonce, 60))) {
      return { ok: false, reason: "Replay-protection nonce already used" };
    }

    const bridge = await this.env.APP_KV.get(`bridge:${input.deviceId}`, "json");
    const bridgeCheck = ensureBridgeRegistered(bridge);
    if (!bridgeCheck.ok) {
      return { ok: false, reason: bridgeCheck.reason };
    }

    const bridgeRecord = bridge as Record<string, unknown>;
    const signatureCheck = await verifyBridgeRequestSignature({
      mode: this.env.BRIDGE_SIGNATURE_MODE,
      bridgeRecord,
      operation: "bridge.jobs.pull",
      signedAt: input.signedAt,
      signature: input.signature,
      payload: {
        deviceId: input.deviceId,
        nonce: input.nonce,
        requestedAt: input.requestedAt,
        limit: input.limit ?? null
      },
      now: new Date(input.requestedAt)
    });
    if (!signatureCheck.ok) {
      return { ok: false, reason: signatureCheck.reason };
    }

    const jobs = await pullPendingExecutionJobs(this.env.APP_DB, {
      deviceId: input.deviceId,
      limit: input.limit ?? 5,
      dispatchedAt: input.requestedAt,
      leaseExpiresAt: new Date(new Date(input.requestedAt).getTime() + 2 * 60 * 1000).toISOString()
    });

    const mapped = jobs.map((job) => ({
      jobId: job.job_id,
      intentId: job.intent_id,
      sessionId: job.session_id,
      deviceId: job.device_id,
      payload: JSON.parse(job.payload_json),
      status: job.status,
      createdAt: job.created_at,
      dispatchedAt: job.dispatched_at,
      leaseExpiresAt: job.lease_expires_at,
      attemptCount: job.attempt_count
    }));

    return { ok: true, jobs: mapped };
  }

  private async submitBridgeJobResult(input: {
    resultId: string;
    jobId: string;
    deviceId: string;
    nonce: string;
    status: "completed" | "failed" | "rejected";
    outputRef?: string;
    error?: string;
    reportedAt: string;
    signature?: string;
    signedAt?: string;
  }): Promise<{ ok: boolean; reason?: string }> {
    if (!(await this.consumeReplayNonce(input.nonce, 60))) {
      return { ok: false, reason: "Replay-protection nonce already used" };
    }

    const bridge = await this.env.APP_KV.get(`bridge:${input.deviceId}`, "json");
    const bridgeCheck = ensureBridgeRegistered(bridge);
    if (!bridgeCheck.ok) {
      return { ok: false, reason: bridgeCheck.reason };
    }

    const bridgeRecord = bridge as Record<string, unknown>;
    const signatureCheck = await verifyBridgeRequestSignature({
      mode: this.env.BRIDGE_SIGNATURE_MODE,
      bridgeRecord,
      operation: "bridge.jobs.result",
      signedAt: input.signedAt,
      signature: input.signature,
      payload: {
        resultId: input.resultId,
        jobId: input.jobId,
        deviceId: input.deviceId,
        nonce: input.nonce,
        status: input.status,
        outputRef: input.outputRef ?? null,
        error: input.error ?? null,
        reportedAt: input.reportedAt
      },
      now: new Date(input.reportedAt)
    });
    if (!signatureCheck.ok) {
      return { ok: false, reason: signatureCheck.reason };
    }

    const dedupe = await insertExecutionJobResult(this.env.APP_DB, {
      resultId: input.resultId,
      jobId: input.jobId,
      deviceId: input.deviceId,
      status: input.status,
      outputRef: input.outputRef,
      error: input.error,
      reportedAt: input.reportedAt
    });
    if (dedupe === "duplicate") {
      return { ok: true };
    }

    const updated = await completeExecutionJob(this.env.APP_DB, {
      jobId: input.jobId,
      deviceId: input.deviceId,
      status: input.status,
      completedAt: input.reportedAt,
      outputRef: input.outputRef,
      error: input.error
    });
    if (updated === "not_found") {
      return { ok: false, reason: "Job not found or already finalized" };
    }
    if (updated === "already_final") {
      return { ok: true };
    }

    await this.persistAudit(
      "bridge-control",
      "execution_result",
      {
        jobId: input.jobId,
        deviceId: input.deviceId,
        status: input.status,
        outputRef: input.outputRef ?? null,
        error: input.error ?? null
      },
      input.jobId
    );

    return { ok: true };
  }

  private serializeJobRow(job: {
    job_id: string;
    intent_id: string;
    session_id: string;
    device_id: string;
    payload_json: string;
    status: string;
    created_at: string;
    dispatched_at: string | null;
    lease_expires_at: string | null;
    attempt_count: number;
    completed_at: string | null;
    output_ref: string | null;
    error: string | null;
    transition_reason: string | null;
  }): Record<string, unknown> {
    return {
      jobId: job.job_id,
      intentId: job.intent_id,
      sessionId: job.session_id,
      deviceId: job.device_id,
      payload: JSON.parse(job.payload_json),
      status: job.status,
      createdAt: job.created_at,
      dispatchedAt: job.dispatched_at,
      leaseExpiresAt: job.lease_expires_at,
      attemptCount: job.attempt_count,
      completedAt: job.completed_at,
      outputRef: job.output_ref,
      error: job.error,
      transitionReason: job.transition_reason
    };
  }

  private async cancelJob(
    jobId: string,
    input: { nonce: string; actorId: string; reason: string; requestedAt: string }
  ): Promise<{ ok: boolean; reason?: string }> {
    if (!(await this.consumeReplayNonce(input.nonce, 60))) {
      return { ok: false, reason: "Replay-protection nonce already used" };
    }

    const result = await cancelExecutionJob(this.env.APP_DB, {
      jobId,
      reason: `[${input.actorId}] ${input.reason}`,
      cancelledAt: input.requestedAt
    });

    if (result === "not_found") {
      return { ok: false, reason: "Job not found" };
    }
    if (result === "already_final") {
      return { ok: true };
    }

    await this.persistAudit(
      "bridge-control",
      "execution_control",
      {
        action: "cancel",
        actorId: input.actorId,
        jobId,
        reason: input.reason
      },
      jobId
    );

    return { ok: true };
  }

  private async requeueJob(
    jobId: string,
    input: { nonce: string; actorId: string; reason: string; requestedAt: string }
  ): Promise<{ ok: boolean; reason?: string }> {
    if (!(await this.consumeReplayNonce(input.nonce, 60))) {
      return { ok: false, reason: "Replay-protection nonce already used" };
    }

    const result = await requeueExecutionJob(this.env.APP_DB, {
      jobId,
      reason: `[${input.actorId}] ${input.reason}`
    });

    if (result === "not_found") {
      return { ok: false, reason: "Job not found" };
    }

    await this.persistAudit(
      "bridge-control",
      "execution_control",
      {
        action: "requeue",
        actorId: input.actorId,
        jobId,
        reason: input.reason
      },
      jobId
    );

    return { ok: true };
  }

  private async runMaintenanceCleanup(input: {
    nonce: string;
    actorId: string;
    requestedAt: string;
    retainDays?: number;
  }): Promise<{ ok: boolean; reason?: string; expiredApprovals?: number; jobsDeleted?: number; resultsDeleted?: number }> {
    if (!(await this.consumeReplayNonce(input.nonce, 60))) {
      return { ok: false, reason: "Replay-protection nonce already used" };
    }

    const nowIso = input.requestedAt;
    const retainDays = input.retainDays ?? 30;
    const cutoffIso = new Date(new Date(nowIso).getTime() - retainDays * 24 * 60 * 60 * 1000).toISOString();

    const expiredApprovals = await expirePendingApprovals(this.env.APP_DB, nowIso);
    const purged = await purgeOldExecutionArtifacts(this.env.APP_DB, cutoffIso);

    await this.persistAudit(
      "bridge-control",
      "execution_control",
      {
        action: "maintenance_cleanup",
        actorId: input.actorId,
        retainDays,
        expiredApprovals,
        jobsDeleted: purged.jobsDeleted,
        resultsDeleted: purged.resultsDeleted
      },
      `maintenance-${nowIso}`
    );

    return {
      ok: true,
      expiredApprovals,
      jobsDeleted: purged.jobsDeleted,
      resultsDeleted: purged.resultsDeleted
    };
  }

  private deriveTrustTier(attestation: string): "trusted" | "restricted" | "quarantined" {
    // Placeholder trust derivation until real attestation verification is wired in.
    if (attestation.startsWith("verified:")) {
      return deviceTrustTierSchema.parse("trusted");
    }

    if (attestation.length > 24) {
      return deviceTrustTierSchema.parse("restricted");
    }

    return deviceTrustTierSchema.parse("quarantined");
  }

  private async consumeReplayNonce(nonce: string, ttlSeconds: number): Promise<boolean> {
    const nonceKey = `nonce:${nonce}`;
    const existing = await this.env.APP_KV.get(nonceKey);
    if (!isReplayNonceAllowed(existing)) {
      return false;
    }

    await this.env.APP_KV.put(nonceKey, "1", { expirationTtl: ttlSeconds });
    return true;
  }

  private async isOperatorAuthorized(request: Request): Promise<boolean> {
    const configured = this.env.OPERATOR_TOKEN?.trim();
    if (!configured) {
      return true;
    }

    const provided = request.headers.get("x-sage-operator-token") ?? "";
    const configuredBytes = new TextEncoder().encode(configured);
    const providedBytes = new TextEncoder().encode(provided);
    if (configuredBytes.length !== providedBytes.length) {
      return false;
    }

    let diff = 0;
    for (let i = 0; i < configuredBytes.length; i += 1) {
      diff |= configuredBytes[i] ^ providedBytes[i];
    }
    return diff === 0;
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
