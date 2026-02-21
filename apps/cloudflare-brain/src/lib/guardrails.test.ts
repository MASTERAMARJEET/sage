import { describe, expect, it } from "vitest";
import {
  ensureBridgeRegistered,
  evaluateTrustTierAuthorization,
  isReplayNonceAllowed,
  validateApprovalResolutionState
} from "./guardrails";

describe("evaluateTrustTierAuthorization", () => {
  it("blocks exec for restricted tier", () => {
    const result = evaluateTrustTierAuthorization({
      trustTier: "restricted",
      action: "exec"
    });
    expect(result.allowed).toBe(false);
  });

  it("allows read for quarantined tier", () => {
    const result = evaluateTrustTierAuthorization({
      trustTier: "quarantined",
      action: "read"
    });
    expect(result.allowed).toBe(true);
  });
});

describe("nonce replay protection", () => {
  it("rejects duplicate nonce usage", () => {
    expect(isReplayNonceAllowed("1")).toBe(false);
  });
});

describe("approval resolution checks", () => {
  it("rejects invalid approval token", () => {
    const result = validateApprovalResolutionState({
      pending: {
        status: "pending",
        approvalToken: "expected-token",
        expiresAt: "2099-01-01T00:00:00.000Z"
      },
      approvalToken: "wrong-token",
      now: new Date("2026-01-01T00:00:00.000Z")
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Invalid approval token");
    }
  });

  it("rejects expired approval", () => {
    const result = validateApprovalResolutionState({
      pending: {
        status: "pending",
        approvalToken: "expected-token",
        expiresAt: "2025-01-01T00:00:00.000Z"
      },
      approvalToken: "expected-token",
      now: new Date("2026-01-01T00:00:00.000Z")
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("expired");
    }
  });
});

describe("bridge heartbeat guard", () => {
  it("rejects unregistered bridge", () => {
    const result = ensureBridgeRegistered(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("not registered");
    }
  });
});
