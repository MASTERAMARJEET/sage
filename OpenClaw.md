## OpenClaw Document Outline (Detailed)

### 1) What OpenClaw Is

- **Positioning:** Personal AI assistant that runs on your own devices and in your existing channels.
- **Core promise:** “AI that actually does things,” not just chat responses.
- **Operating model:** Gateway as control plane; assistant as product experience.
- **Intended user:** Single-user/personal operator who wants local-feeling, always-on assistance.

### 2) Goals of OpenClaw

- **Primary goal:** Deliver a practical personal assistant that can execute real tasks across messaging, voice, and device tools.
- **Usability goal:** Keep setup straightforward (wizard-first) while exposing critical configuration clearly.
- **Platform goal:** Support major messaging channels, model providers, and companion device surfaces.
- **Reliability goal:** Prioritize stability, bug fixes, and strong first-run UX.
- **Security goal:** Ship secure defaults and make higher-risk capability explicit and operator-controlled.
- **Extensibility goal:** Keep core lean and enable optional capability through plugins/skills.
- **Long-term goal:** Unified, multi-device assistant experience across macOS, iOS, Android, Linux, and Windows paths.

### 3) Philosophy and Principles

- **Local-first control plane:** Keep operator in control of runtime, channels, and data flow.
- **Power with guardrails:** Preserve high capability while requiring explicit opt-in for risky paths.
- **Terminal-first clarity:** Favor transparent setup over convenience that hides security implications.
- **Hackable by default:** TypeScript-first orchestration to maximize developer accessibility and iteration speed.
- **Lean core, rich ecosystem:** Push optional integrations into plugins/extensions/skills, not monolith core.
- **Pragmatic architecture:** Prefer decoupled integration patterns (e.g., bridge-style MCP support) over heavyweight core coupling.
- **Single-user ergonomics:** Optimize for personal assistant quality, not enterprise multi-tenant abstraction by default.

### 4) Product Scope at a Glance

- **Assistant runtime:** Sessioned agent orchestration with tool access and model routing/failover.
- **Gateway:** WebSocket-based control plane for channels, sessions, tools, web surfaces, and events.
- **CLI:** Full operational surface for onboarding, messaging, agent execution, doctor, and config.
- **Web surfaces:** Control UI + WebChat served by gateway.
- **Companion apps/nodes:** macOS app and mobile nodes for local-device actions and voice workflows.

### 5) Feature Inventory (Comprehensive)

### 5.1 Core Platform Features

- Gateway WebSocket control plane (sessions, presence, config, cron, webhooks, control UI).
- CLI workflows (`onboard`, `agent`, `message send`, `doctor`, gateway run/control).
- Session model for direct chats/groups, activation and queue modes, and reply-back behavior.
- Pi agent runtime (RPC mode) with streaming support.
- Media pipeline for image/audio/video processing and transcription flow handling.

### 5.2 Channel Features

- Native/primary channels: WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage (legacy), WebChat.
- Extension channels: BlueBubbles (recommended iMessage path), Matrix, Microsoft Teams, Zalo, Zalo Personal.
- Group routing controls: mention gating, reply tagging, per-channel chunking behavior.
- Multi-channel inbox model for unified assistant delivery across channels.
- DM safety defaults with pairing flow and allowlist approval.

### 5.3 Multi-Agent and Workspace Features

- Multi-agent routing by channel/account/peer to isolated agents.
- Per-agent workspace isolation and session separation.
- Agent identity model (`IDENTITY.md` path + explicit identity fields).
- Workspace-level skill usage and scoped behavior controls.

### 5.4 Voice, Canvas, and Device Features

- Voice Wake (always-on listening path) and Talk Mode (continuous conversational interaction).
- Live Canvas (A2UI-based visual workspace controlled by the agent).
- Device node capabilities: camera capture, screen recording, location command, notifications.
- macOS node mode commands (`system.run`, `system.notify`) with permission-aware execution.
- Cross-device pairing and execution split (gateway-host tools vs device-local actions).

### 5.5 Tools and Automation Features

- Browser automation/control via managed Chromium/Chrome workflows.
- Canvas actions: push/reset/eval/snapshot patterns.
- Automation primitives: cron jobs, wakeups, webhook ingestion.
- Gmail Pub/Sub integration hooks.
- Skills platform modes: bundled skills, managed skills, workspace skills.

### 5.6 Models and Intelligence Features

- Model selection and provider auth support.
- Profile rotation (OAuth/API key strategies) and failover logic.
- Session pruning and usage controls.
- Prompt/tool streaming with operational telemetry hooks.

### 5.7 Runtime, Safety, and Reliability Features

- Channel routing policy controls and retry policies.
- Streaming/chunking controls for channel constraints.
- Presence and typing indicator management.
- Usage tracking instrumentation.
- Security defaults + diagnostic tooling (`doctor`) for misconfiguration detection.

### 5.8 Ops, Deployment, and Packaging Features

- Gateway-served Control UI and WebChat.
- Remote access via Tailscale Serve/Funnel and SSH tunnel patterns.
- Loopback bind enforcement and auth guardrails for exposure modes.
- Nix and Docker install/deploy pathways.
- Logging, troubleshooting, and migration diagnostics.

### 6) Security Model Section

- **Threat posture:** Treat inbound channel traffic as untrusted.
- **Default DM policy:** Pairing-first workflow for unknown senders.
- **Explicit trust upgrade path:** Operator must approve codes/allowlists.
- **Remote exposure constraints:** Auth mode requirements by serve/funnel mode.
- **Permissions model:** Device action permissions surfaced and enforced at runtime.

### 7) Ecosystem Strategy

- **Plugins/extensions:** Optional capability should live outside core whenever possible.
- **Skills strategy:** New skills should favor registry publishing over core bundling.
- **MCP strategy:** Bridge-based MCP integration to preserve runtime decoupling and stability.
- **Community contribution model:** Focused PR scope and maintainability-first review posture.

### 8) Roadmap Framing

- **Current top priorities:** Security defaults, bug fixes/stability, setup reliability.
- **Near-term priorities:** More model provider coverage, channel depth, performance/test infra, better agent harness.
- **Experience priorities:** Better CLI + web ergonomics, stronger companion apps.
- **Guardrail/non-goal examples:** Avoid unnecessary core bloat, avoid heavyweight nested-agent architecture by default.

### 9) Suggested Document Appendices

- **A. Channel matrix:** capability/support table per channel.
- **B. Node capability matrix:** macOS/iOS/Android/local command coverage.
- **C. Security checklist:** onboarding hardening steps and policy defaults.
- **D. Deployment recipes:** local-only, remote gateway, tailscale, docker, nix.
- **E. Glossary:** Gateway, node, session, agent, skill, extension, pairing.

---

If you want, I can convert this into a publish-ready Markdown doc with full section text (not just outline), tailored for either `README` style or docs-site style.
