import { z } from "zod";

export const riskTierSchema = z.enum(["low", "medium", "high", "critical"]);
export type RiskTier = z.infer<typeof riskTierSchema>;

export const toolIntentSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  actorDeviceId: z.string().min(1),
  tool: z.string().min(1),
  action: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  requestedAt: z.string().datetime()
});
export type ToolIntent = z.infer<typeof toolIntentSchema>;

export const policyDecisionSchema = z.object({
  intentId: z.string().min(1),
  allow: z.boolean(),
  riskTier: riskTierSchema,
  reason: z.string().min(1),
  requiresApproval: z.boolean(),
  policyPath: z.array(z.string().min(1)).min(1),
  decidedAt: z.string().datetime()
});
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;

export const approvalRequestSchema = z.object({
  id: z.string().min(1),
  intentId: z.string().min(1),
  sessionId: z.string().min(1),
  summary: z.string().min(1),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime()
});
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

export const executionReceiptSchema = z.object({
  id: z.string().min(1),
  intentId: z.string().min(1),
  executorDeviceId: z.string().min(1),
  status: z.enum(["accepted", "rejected", "failed", "completed"]),
  outputRef: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.string().datetime()
});
export type ExecutionReceipt = z.infer<typeof executionReceiptSchema>;

export const auditEventSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  kind: z.enum([
    "intent_received",
    "policy_decided",
    "approval_requested",
    "approval_resolved",
    "execution_dispatched",
    "execution_result",
    "llm_invoked"
  ]),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
  correlationId: z.string().min(1)
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const websocketEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.update"),
    sessionId: z.string().min(1),
    state: z.record(z.string(), z.unknown())
  }),
  z.object({
    type: z.literal("approval.requested"),
    data: approvalRequestSchema
  }),
  z.object({
    type: z.literal("approval.resolved"),
    approvalId: z.string().min(1),
    approved: z.boolean(),
    reason: z.string().optional()
  }),
  z.object({
    type: z.literal("tool.status"),
    intentId: z.string().min(1),
    status: z.string().min(1)
  }),
  z.object({
    type: z.literal("run.completed"),
    sessionId: z.string().min(1),
    runId: z.string().min(1)
  }),
  z.object({
    type: z.literal("error"),
    code: z.string().min(1),
    reason: z.string().min(1),
    recoverable: z.boolean()
  })
]);
export type WebsocketEvent = z.infer<typeof websocketEventSchema>;
