---
summary: "OpenClaw architecture and full deployment on Cloudflare"
read_when:
  - Evaluating Cloudflare Workers / Durable Objects for deployment
  - Forking or reimplementing OpenClaw for serverless/edge
title: "Architecture and Cloudflare Deployment"
---

# OpenClaw Architecture and Cloudflare Deployment

This document explains the architecture of the OpenClaw project and how it could be deployed fully on Cloudflare (Workers, Durable Objects, KV, D1, R2). It is aimed at readers who are okay with forking or re-implementing parts of the system.

## 1. High-Level Architecture

OpenClaw is a **single-process, local-first** control plane: one long-lived Node.js process (the **Gateway**) owns all state, channels, and agent runs. Clients (CLI, macOS app, iOS/Android nodes, Control UI) talk to it over **HTTP + WebSocket** on one port (default **18789**).

- **Repo layout:** `src/` (CLI in `src/cli`, commands in `src/commands`, gateway in `src/gateway`, channels in `src/telegram`, `src/discord`, `src/slack`, `src/web` (WhatsApp), `src/signal`, `src/imessage`, etc., routing in `src/routing`, agents in `src/agents`, config in `src/config`). Extensions live in `extensions/*`.
- **Deployment today:** Gateway runs on a single host (your machine, VPS, or exe.dev). "Remote" mode means the Gateway runs elsewhere and clients connect via SSH tunnel or Tailscale; the **same binary and process model** run on that host. There is no built-in "serverless" or "Cloudflare Workers" backend.

## 2. Gateway Process (Control Plane)

The Gateway is started by `openclaw gateway run` (or the macOS menubar app / systemd / launchd). Entry is `startGatewayServer()` in `src/gateway/server.impl.ts`.

### 2.1 HTTP + WebSocket Server

- **Single port** (e.g. 18789): HTTP and WebSocket upgrade on the same server.
- **HTTP:**
  - Static **Control UI** (dashboard).
  - **OpenAI-compatible** `POST /v1/chat/completions`.
  - **OpenResponses** API (`POST /v1/responses`).
  - **Hooks** and **plugin** routes.
  - **Tools** invoke endpoint.
  - Health, etc.
- **WebSocket:** one long-lived WS per client. All control-plane RPC goes over this: `agent`, `agent.wait`, `sessions.*`, `channels.start`/`stop`, `cron.*`, `node.*`, presence, health, etc. Handlers live in `src/gateway/server-methods*.ts` and `attachGatewayWsHandlers` in `src/gateway/server-ws-runtime.ts`.

So the Gateway is a **stateful HTTP + WS server**: in-memory sets/maps for clients, chat runs, dedupe, tool-event recipients, etc. (`src/gateway/server-runtime-state.ts`).

### 2.2 What the Gateway Starts and Owns

Inside the same process it:

- **Loads config** from disk (`~/.openclaw/openclaw.json` or `OPENCLAW_CONFIG_PATH` / `OPENCLAW_HOME`). Config is re-read on demand via `loadConfig()` and can be reloaded without full restart.
- **Starts channel "monitors"** (one per configured channel/account): Telegram (webhook or long polling), Discord (discord.js), Slack (Bolt), WhatsApp (Baileys), Signal (signal-cli subprocess), iMessage, etc. They run in-process (or as subprocess for Signal) and push inbound messages into the gateway; outbound uses `sendMessage*` from the plugin runtime (`src/plugins/runtime/`, `src/channels/dock.ts`).
- **Runs the Pi agent**: each user message triggers an in-process **embedded Pi run** (`runEmbeddedPiAgent` in `src/agents/pi-embedded-runner/run.ts`). The agent reads session state from **files**, calls the **LLM via fetch** (Anthropic/OpenAI/Ollama/etc.), runs **tools**, and writes back to session files.
- **Cron**: in-process scheduler with file-backed store (`src/cron/`).
- **Plugins**: loaded from disk (`extensions/*`), register gateway handlers and channel adapters.
- **Nodes**: mobile/macOS nodes connect over the same WebSocket; gateway tracks presence and forwards events; nodes run tools (e.g. camera) and return results.
- **Discovery**: mDNS/Bonjour, optional Tailscale Serve, optional wide-area discovery.
- **Sidecars**: e.g. browser control server if enabled.

So: **one Node process = HTTP + WS + channels + agent runs + cron + plugins**, with **file-based config and session state**.

## 3. State and Persistence

| What            | Where / how                                                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config          | `~/.openclaw/openclaw.json` (or env overrides). `src/config/io.ts`, `paths.ts`.                                                                                      |
| Credentials     | `~/.openclaw/credentials/` (e.g. OAuth, WhatsApp auth).                                                                                                              |
| Sessions        | Session **store** (e.g. `~/.openclaw/agents/<agentId>/sessions.json`) + per-session **transcript** files. `src/config/sessions/`, `src/gateway/session-utils.fs.ts`. |
| Agent workspace | Configurable; often under state dir or `agentDir`.                                                                                                                   |
| Cron jobs       | File-based cron store.                                                                                                                                               |
| QMD / memory    | Under state dir (`agents/<id>/qmd/`), SQLite and files.                                                                                                              |
| Delivery queue  | Outbound delivery queue with file-backed recovery.                                                                                                                   |

No built-in database: everything is **files + in-memory** in the Gateway process.

## 4. Channels (Messaging)

Channels are **long-lived connections or servers** started by the Gateway:

- **Telegram**: Bot API — either **webhook** (HTTP server in-process) or **long polling**. Webhook fits "one HTTP endpoint per request" (e.g. Worker).
- **Discord**: **discord.js** — WebSocket to Discord; plus HTTP for interactions. Needs a persistent WebSocket or an HTTP-only "interactions" endpoint.
- **Slack**: **Bolt** — Socket Mode (WebSocket) or Events API (HTTP). HTTP-only is possible.
- **WhatsApp**: **Baileys** — persistent WebSocket + local auth state; very much "stateful process".
- **Signal**: **signal-cli** — subprocess; not suitable for Workers.
- **iMessage / BlueBubbles**: platform-specific; not Worker-friendly.

So: **Telegram (webhook), Discord (interactions URL), Slack (Events API)** can be modeled as **HTTP endpoints**. The rest assume a **long-running process** (and sometimes subprocesses) on a host.

## 5. Agent (Pi) Runtime

- **Entry**: Incoming message → routing → `agent` gateway method → `runEmbeddedPiAgent` (or CLI path via `runCliAgent`).
- **Session**: Loaded from **session store + transcript files**; messages and history are file-based. Compaction and context pruning are implemented against those files.
- **LLM**: Provider-specific **fetch** to Anthropic/OpenAI/Ollama/etc. (e.g. `pi-embedded-runner/run/attempt.ts`). No Node-only I/O; **fetch is fine in Workers**.
- **Tools**: Many are **HTTP or in-process**. Some use **child_process** (bash, shell, signal-cli), **Puppeteer/Playwright** (browser), or **Docker** (sandbox). Those **cannot** run inside a Worker; they need a Node (or other) runtime with processes and optional Docker.

So for a "full" Cloudflare deployment you either **drop or stub** process-based tools, or **delegate** them to an external service (e.g. Sandbox, or a small Node service).

## 6. What "Deploy Fully on Cloudflare" Implies

- **Workers**: Stateless, request-scoped. No TCP listen, no `fs`, no `child_process`, no long-lived in-memory state. Execution and CPU time limits. So the **current Gateway binary cannot run as a Worker** as-is.
- **Durable Objects (DO)**: Stateful, can hold **WebSockets**, single-threaded per DO. No Node `fs`/`child_process`. Good fit for the **control plane** (WS + in-memory-like state moved to DO storage or D1/KV).
- **KV / D1 / R2**: Replace **config**, **session store**, **transcript blobs**, **cron store**, and optionally **credentials** (with care). No filesystem.
- **Channels:**
  - **Telegram webhook** → Worker HTTP.
  - **Discord** → Worker HTTP for interactions (and optionally Events API).
  - **Slack** → Worker HTTP for Events API.
  - **WhatsApp / Signal / iMessage** → not on Workers; would stay on a separate "channel host" or be dropped in a CF-only fork.
- **Agent:**
  - **LLM calls**: Keep as **fetch** from Worker or DO.
  - **Session state**: Move to **D1** (or KV for smaller blobs).
  - **Tools**: Only **fetch-based** and **storage-based** tools in Workers; **bash/browser/sandbox** would need an external "tool runner" or be reimplemented (e.g. Cloudflare Sandbox / external API).

## 7. Possible Cloudflare Mapping (for a Fork/Reimplementation)

Conceptually you could split the system like this:

1. **Control plane (WebSocket + RPC)**
   - **Durable Object(s)** per tenant (or one DO with routing): hold WebSocket connections, session/run metadata, presence.
   - Replace in-memory maps with **DO storage** and/or **D1**.
   - HTTP endpoints (health, OpenAI compat, OpenResponses, hooks, plugin routes) as **Workers** that call into the DO or read/write D1/KV.

2. **Config and state**
   - **KV** or **D1** for config (and feature flags).
   - **D1** for session store and transcript-like rows (or KV for small blobs).
   - **R2** for large blobs (e.g. media, exports) if needed.
   - **Secrets / env** for tokens; no `~/.openclaw/credentials/` on disk.

3. **Channels**
   - **Workers** for Telegram webhook, Discord interactions, Slack Events API (and optionally Google Chat, etc.).
   - Each Worker receives the request, resolves tenant/session (e.g. from URL or auth), pushes the event into the DO or a queue (e.g. Queue + consumer Worker/DO) that drives the agent.
   - **WhatsApp, Signal, iMessage**: keep on a **separate Node (or other) service** that talks to your Cloudflare backend via HTTP/WS, or omit in a CF-only fork.

4. **Agent execution**
   - **Worker or DO**: Load session from D1/KV, build messages, **fetch** LLM, parse tool calls.
   - **Tools:**
     - **HTTP-only / fetch-only** tools run in the Worker/DO.
     - **Bash / browser / sandbox** tools: either call out to **Cloudflare Sandbox** (or similar) or to a **separate "tool runner"** service that has Node + processes/Docker.
   - Write back **new messages and state** to D1/KV.

5. **Cron**
   - Replace file-based cron with **Cron Triggers** (Workers) or **Workflows** that invoke the same agent/DO or a dedicated "cron runner" Worker.

6. **Nodes and Control UI**
   - **Nodes** connect to the **DO WebSocket** (same logical role as today's gateway WS).
   - **Control UI** can be **Pages** or a Worker serving static assets + API that calls the DO or D1.

7. **Plugins / extensions**
   - In a fork you'd either: restrict to "config-only" plugins, or implement a small plugin contract that runs inside Workers (e.g. HTTP handlers only, no native modules).

## 8. Summary Table

| Component       | Current (OpenClaw)               | Cloudflare-Oriented Fork/Reimpl       |
| --------------- | -------------------------------- | ------------------------------------- |
| Gateway process | Single Node HTTP+WS server       | Durable Object(s) + Workers           |
| Config          | `~/.openclaw/openclaw.json`      | KV or D1                              |
| Sessions        | Files (store + transcripts)      | D1 (and/or KV for blobs)              |
| LLM             | fetch in Node                    | fetch in Worker/DO                    |
| Tools           | Node + child_process / browser   | fetch-only in CF; rest → external svc |
| Telegram        | Webhook or long poll in process  | Worker HTTP (webhook)                 |
| Discord/Slack   | In-process WebSocket/Socket Mode | Worker HTTP (interactions/Events API) |
| WhatsApp/Signal | In-process / subprocess          | Separate host or drop                 |
| Cron            | In-process + file store          | Cron Triggers / Workflows             |
| Nodes           | WS to gateway                    | WS to DO                              |

**Conclusion:** A **full deployment on Cloudflare** is feasible only by **reimplementing or forking** the control plane and agent layer to use Workers + Durable Objects + D1/KV/R2, and either **dropping** or **offloading** process-dependent channels and tools to another runtime. The existing codebase is a clear blueprint for APIs, protocols, and behavior, but it is not "lift and shift" to Workers; it assumes one long-lived Node process and a filesystem.
