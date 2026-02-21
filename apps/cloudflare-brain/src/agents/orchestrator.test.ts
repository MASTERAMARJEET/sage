import { describe, expect, it, vi } from "vitest";

vi.mock("agents", () => ({
  Agent: class {}
}));

import { SageAgent } from "./orchestrator";

function createAgent(operatorToken?: string): SageAgent {
  const agent = Object.create(SageAgent.prototype) as SageAgent;
  (agent as unknown as { env: Record<string, unknown> }).env = {
    SageAgent: {} as DurableObjectNamespace,
    APP_DB: {} as D1Database,
    APP_KV: {} as KVNamespace,
    APP_AUDIT_BUCKET: {} as R2Bucket,
    AI: { run: vi.fn() },
    AI_GATEWAY_ID: "gateway-id",
    AI_MODEL: "@cf/meta/llama-3.1-8b-instruct",
    APP_ENV: "test",
    OPERATOR_TOKEN: operatorToken
  };

  return agent;
}

describe("SageAgent operator controls", () => {
  it("routes session job queries through handleJobQuery", async () => {
    const agent = createAgent("top-secret");
    const queryMock = vi.fn(async () => Response.json({ ok: true, jobs: [] }));
    (agent as unknown as { handleJobQuery: typeof queryMock }).handleJobQuery = queryMock;

    const response = await agent.onRequest(
      new Request("https://example.com/agents/sage-agent/default/sessions/session-1/jobs?limit=10", {
        method: "GET",
        headers: {
          "x-sage-operator-token": "top-secret"
        }
      })
    );

    expect(response.status).toBe(200);
    expect(queryMock).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({ ok: true, jobs: [] });
  });

  it("rejects cancel when operator token is missing", async () => {
    const agent = createAgent("top-secret");
    const response = await agent.onRequest(
      new Request("https://example.com/agents/sage-agent/default/jobs/job-1/cancel", {
        method: "POST",
        body: JSON.stringify({
          nonce: "nonce-1",
          actorId: "ops",
          reason: "manual intervention",
          requestedAt: "2026-02-21T00:00:00.000Z"
        })
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ ok: false, reason: "Unauthorized" });
  });

  it("rejects bridge inventory query when operator token is missing", async () => {
    const agent = createAgent("top-secret");
    const response = await agent.onRequest(
      new Request("https://example.com/agents/sage-agent/default/bridges?limit=10", {
        method: "GET"
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ ok: false, reason: "Unauthorized" });
  });

  it("rejects requeue with invalid payload even when authorized", async () => {
    const agent = createAgent("top-secret");
    const response = await agent.onRequest(
      new Request("https://example.com/agents/sage-agent/default/jobs/job-1/requeue", {
        method: "POST",
        headers: {
          "x-sage-operator-token": "top-secret"
        },
        body: JSON.stringify({
          nonce: "nonce-1",
          actorId: "ops",
          requestedAt: "2026-02-21T00:00:00.000Z"
        })
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      reason: "Invalid requeue job payload"
    });
  });

  it("calls cancelJob when payload and auth are valid", async () => {
    const agent = createAgent("top-secret");
    const cancelJobMock = vi.fn(async () => ({ ok: true }));
    (agent as unknown as { cancelJob: typeof cancelJobMock }).cancelJob = cancelJobMock;

    const response = await agent.onRequest(
      new Request("https://example.com/agents/sage-agent/default/jobs/job-encoded%2F1/cancel", {
        method: "POST",
        headers: {
          "x-sage-operator-token": "top-secret"
        },
        body: JSON.stringify({
          nonce: "nonce-002",
          actorId: "ops",
          reason: "stop this run",
          requestedAt: "2026-02-21T00:00:00.000Z"
        })
      })
    );

    expect(response.status).toBe(200);
    expect(cancelJobMock).toHaveBeenCalledWith("job-encoded/1", {
      nonce: "nonce-002",
      actorId: "ops",
      reason: "stop this run",
      requestedAt: "2026-02-21T00:00:00.000Z"
    });
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  it("calls requeueJob when payload and auth are valid", async () => {
    const agent = createAgent("top-secret");
    const requeueJobMock = vi.fn(async () => ({ ok: true }));
    (agent as unknown as { requeueJob: typeof requeueJobMock }).requeueJob = requeueJobMock;

    const response = await agent.onRequest(
      new Request("https://example.com/agents/sage-agent/default/jobs/job-2/requeue", {
        method: "POST",
        headers: {
          "x-sage-operator-token": "top-secret"
        },
        body: JSON.stringify({
          nonce: "nonce-003",
          actorId: "ops",
          reason: "retry this run",
          requestedAt: "2026-02-21T00:00:00.000Z"
        })
      })
    );

    expect(response.status).toBe(200);
    expect(requeueJobMock).toHaveBeenCalledWith("job-2", {
      nonce: "nonce-003",
      actorId: "ops",
      reason: "retry this run",
      requestedAt: "2026-02-21T00:00:00.000Z"
    });
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  it("rejects cleanup when operator token is incorrect", async () => {
    const agent = createAgent("top-secret");
    const response = await agent.onRequest(
      new Request("https://example.com/agents/sage-agent/default/maintenance/cleanup", {
        method: "POST",
        headers: {
          "x-sage-operator-token": "wrong-token"
        },
        body: JSON.stringify({
          nonce: "nonce-4",
          actorId: "ops",
          requestedAt: "2026-02-21T00:00:00.000Z",
          retainDays: 7
        })
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ ok: false, reason: "Unauthorized" });
  });

  it("calls cleanup handler when auth and payload are valid", async () => {
    const agent = createAgent("top-secret");
    const cleanupMock = vi.fn(async () => ({
      ok: true,
      expiredApprovals: 2,
      jobsDeleted: 3,
      resultsDeleted: 4
    }));
    (agent as unknown as { runMaintenanceCleanup: typeof cleanupMock }).runMaintenanceCleanup =
      cleanupMock;

    const response = await agent.onRequest(
      new Request("https://example.com/agents/sage-agent/default/maintenance/cleanup", {
        method: "POST",
        headers: {
          "x-sage-operator-token": "top-secret"
        },
        body: JSON.stringify({
          nonce: "nonce-005",
          actorId: "ops",
          requestedAt: "2026-02-21T00:00:00.000Z",
          retainDays: 7
        })
      })
    );

    expect(response.status).toBe(200);
    expect(cleanupMock).toHaveBeenCalledWith({
      nonce: "nonce-005",
      actorId: "ops",
      requestedAt: "2026-02-21T00:00:00.000Z",
      retainDays: 7
    });
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      expiredApprovals: 2,
      jobsDeleted: 3,
      resultsDeleted: 4
    });
  });
});
