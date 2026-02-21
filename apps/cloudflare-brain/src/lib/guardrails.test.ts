import { describe, expect, it } from "vitest";
import {
  ensureBridgeRegistered,
  evaluateDispatchAuthorization,
  evaluateTrustTierAuthorization,
  isBridgeOnline,
  isReplayNonceAllowed,
  validateApprovalResolutionState,
  verifyBridgeRequestSignature
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

describe("bridge online checks", () => {
  it("rejects stale bridge heartbeat", () => {
    const result = isBridgeOnline({
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      now: new Date("2026-01-01T00:06:01.000Z")
    });
    expect(result).toBe(false);
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

describe("dispatch authorization", () => {
  it("requires approved status when approval is required", () => {
    const result = evaluateDispatchAuthorization({
      requiresApproval: true,
      approvalStatus: "pending",
      bridgeOnline: true
    });
    expect(result.allowed).toBe(false);
  });

  it("blocks dispatch when bridge is offline", () => {
    const result = evaluateDispatchAuthorization({
      requiresApproval: false,
      bridgeOnline: false
    });
    expect(result.allowed).toBe(false);
  });
});

describe("bridge signature verification", () => {
  it("allows unsigned bridge request when signature mode is optional", async () => {
    const result = await verifyBridgeRequestSignature({
      mode: "optional",
      bridgeRecord: { publicKey: "unused-in-optional-mode" },
      operation: "bridge.heartbeat",
      payload: {
        deviceId: "device-1",
        nonce: "nonce-12345678",
        sentAt: "2026-02-21T00:00:00.000Z"
      },
      now: new Date("2026-02-21T00:00:00.000Z")
    });
    expect(result.ok).toBe(true);
  });

  it("rejects unsigned bridge request when signature mode is required", async () => {
    const result = await verifyBridgeRequestSignature({
      mode: "required",
      bridgeRecord: { publicKey: "unused-in-required-mode" },
      operation: "bridge.jobs.pull",
      payload: {
        deviceId: "device-1",
        nonce: "nonce-12345678",
        requestedAt: "2026-02-21T00:00:00.000Z",
        limit: 5
      },
      now: new Date("2026-02-21T00:00:00.000Z")
    });
    expect(result.ok).toBe(false);
  });

  it("verifies a valid ECDSA signed bridge request", async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"]
    );

    const signedAt = "2026-02-21T00:00:00.000Z";
    const payload = {
      deviceId: "device-1",
      nonce: "nonce-12345678",
      sentAt: "2026-02-21T00:00:00.000Z"
    };
    const message = `${"bridge.heartbeat"}\n${signedAt}\n${JSON.stringify(payload)}`;
    const signatureBuffer = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.privateKey,
      new TextEncoder().encode(message)
    );
    const publicKeyBuffer = await crypto.subtle.exportKey("spki", keyPair.publicKey);

    const result = await verifyBridgeRequestSignature({
      mode: "required",
      bridgeRecord: {
        publicKey: toBase64(new Uint8Array(publicKeyBuffer))
      },
      operation: "bridge.heartbeat",
      signedAt,
      signature: toBase64(new Uint8Array(signatureBuffer)),
      payload,
      now: new Date("2026-02-21T00:00:10.000Z")
    });

    expect(result.ok).toBe(true);
  });
});

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
