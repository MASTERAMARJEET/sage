import type { PolicyDecision, ToolIntent } from "../types/protocol";

const HIGH_RISK_ACTIONS = new Set(["write", "delete", "exec", "publish"]);
const LOW_RISK_ACTIONS = new Set(["read", "list", "status"]);

export function evaluateToolIntentPolicy(intent: ToolIntent): PolicyDecision {
  const normalizedAction = intent.action.trim().toLowerCase();
  const now = new Date().toISOString();

  if (LOW_RISK_ACTIONS.has(normalizedAction)) {
    return {
      intentId: intent.id,
      allow: true,
      riskTier: "low",
      reason: "Low risk action.",
      requiresApproval: false,
      policyPath: ["global/default", "tool/low-risk"],
      decidedAt: now
    };
  }

  if (HIGH_RISK_ACTIONS.has(normalizedAction)) {
    return {
      intentId: intent.id,
      allow: true,
      riskTier: "high",
      reason: "High risk action requires explicit approval.",
      requiresApproval: true,
      policyPath: ["global/default", "tool/high-risk"],
      decidedAt: now
    };
  }

  // Deny-by-default for any action outside explicit allowlists.
  return {
    intentId: intent.id,
    allow: false,
    riskTier: "critical",
    reason: "Denied by default policy. Action not allowlisted.",
    requiresApproval: false,
    policyPath: ["global/default", "deny/unknown-action"],
    decidedAt: now
  };
}
