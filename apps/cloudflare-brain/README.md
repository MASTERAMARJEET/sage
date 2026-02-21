# sage-brain

Cloudflare-native control plane for an OpenClaw-inspired personal agent system.

## Scope in this initial scaffold

- Agents SDK runtime with a stateful `SageAgent` Durable Object
- Protocol contract types for tool intents, approvals, policy decisions, and audit events
- AI Gateway-only LLM invocation path (`env.AI.run(..., { gateway: { id } })`)
- D1/KV/R2 bindings for structured state, ephemeral coordination data, and audit payloads

## Endpoints

- `GET /health` - service health
- `POST/WS /agents/sage-agent/:instance` - Agents SDK route

## Agent instance routes

- `POST /agents/sage-agent/:instance/message`
- `POST /agents/sage-agent/:instance/tool-intent`
- `POST /agents/sage-agent/:instance/tool-intent/authorize-dispatch`
- `POST /agents/sage-agent/:instance/approval/resolve`
- `POST /agents/sage-agent/:instance/bridge/register`
- `POST /agents/sage-agent/:instance/bridge/heartbeat`
- `POST /agents/sage-agent/:instance/bridge/jobs/pull`
- `POST /agents/sage-agent/:instance/bridge/jobs/result`
- `GET /agents/sage-agent/:instance/jobs/:jobId`
- `GET /agents/sage-agent/:instance/sessions/:sessionId/jobs?limit=20`
- `GET /agents/sage-agent/:instance/devices/:deviceId/jobs?limit=20`
- `GET /agents/sage-agent/:instance/approvals/pending?limit=20&sessionId=<id>`
- `GET /agents/sage-agent/:instance/metrics/queue?deviceId=<id>`
- `GET /agents/sage-agent/:instance/state`

## Current policy baseline

- Deny-by-default for unknown actions
- Auto-allow low-risk actions (`read`, `list`, `status`)
- Require approval for high-risk actions (`write`, `delete`, `exec`, `publish`)
- Approval resolution requires a single-use approval token plus replay-safe nonce
- Trust-tier gates run before policy checks:
  - `trusted`: full action surface, then policy gating
  - `restricted`: blocks `exec`, `publish`, and `delete`
  - `quarantined`: only allows `read`, `list`, `status`
- Dispatch authorization requires:
  - active bridge heartbeat (online check)
  - approval status `approved` for actions that require approval
  - matching approval to intent ID
- Authorized dispatches create durable execution jobs in D1
- Bridges pull pending jobs and submit completion/failed/rejected results
- Pulled jobs receive a lease window and stale dispatched jobs are re-queued
- Job results are idempotent via `resultId` deduplication

## Bridge trust tiers

- `trusted`: verified attestation placeholder path
- `restricted`: usable, but should be blocked from highest-risk actions by policy
- `quarantined`: registered but should not execute privileged actions

## D1 migrations

- Initial schema lives in `migrations/0001_initial.sql`
- Apply locally: `npm run d1:migrate:local`
- Apply remotely: `npm run d1:migrate:remote`

## Local development

1. Install dependencies:
   - `npm install`
2. Update `wrangler.jsonc` placeholders:
   - `database_id`
   - `kv namespace id`
   - `AI_GATEWAY_ID`
3. Run:
   - `npm run dev`
4. Run tests:
   - `npm run test`

## Notes

- This is intentionally a Stage 0/1 foundation and does not yet include full policy/approval workflow execution.
- LLM requests are designed to route through AI Gateway from day one.
