# sage-android-bridge

Minimal local Android bridge worker scaffold for Sage.

This process:

- creates or loads a local ECDSA P-256 keypair
- registers the bridge with `sage-brain`
- sends signed heartbeats
- pulls signed execution jobs
- executes a safe Phase-1 action subset (`read`, `list`, `write`, `status`)
- submits signed job results

## Environment

- `SAGE_BRAIN_BASE_URL` (required): base URL to `sage-brain`, for example `http://127.0.0.1:8787`
- `SAGE_AGENT_INSTANCE` (optional, default `default`)
- `SAGE_DEVICE_ID` (optional, default `android-${pid}`)
- `SAGE_ATTESTATION` (optional, default `verified:android-dev-local`)
- `SAGE_POLL_INTERVAL_MS` (optional, default `3000`)
- `SAGE_MAX_JOBS_PER_CYCLE` (optional, default `5`)
- `SAGE_RUN_ONCE` (optional, set `1` to run one register/heartbeat/pull/execute cycle and exit)
- `SAGE_ALLOWED_ROOTS` (optional, CSV list, default current directory)
- `SAGE_BRIDGE_STATE_FILE` (optional, default `~/.sage/android-bridge-state.json`)

## Run

```bash
npm install
SAGE_BRAIN_BASE_URL="http://127.0.0.1:8787" npm run dev
```

One-shot smoke cycle:

```bash
SAGE_BRAIN_BASE_URL="http://127.0.0.1:8787" npm run smoke
```

## Notes

- Designed to align with `BRIDGE_SIGNATURE_MODE=required` in cloud runtime.
- This is a scaffold bridge for local development, not yet a packaged production Android app.
