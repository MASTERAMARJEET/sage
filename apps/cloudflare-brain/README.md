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
- `POST /agents/sage-agent/:instance/approval/resolve`
- `GET /agents/sage-agent/:instance/state`

## Current policy baseline

- Deny-by-default for unknown actions
- Auto-allow low-risk actions (`read`, `list`, `status`)
- Require approval for high-risk actions (`write`, `delete`, `exec`, `publish`)

## Local development

1. Install dependencies:
   - `npm install`
2. Update `wrangler.jsonc` placeholders:
   - `database_id`
   - `kv namespace id`
   - `AI_GATEWAY_ID`
3. Run:
   - `npm run dev`

## Notes

- This is intentionally a Stage 0/1 foundation and does not yet include full policy/approval workflow execution.
- LLM requests are designed to route through AI Gateway from day one.
