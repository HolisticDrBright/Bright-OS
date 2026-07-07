# HERMES — memory + research lane (self-hosted hermes-agent)

BRIGHT OS integrates a self-hosted [nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent)
instance as the long-term-memory + research agent. We talk to its gateway's
OpenAI-compatible API server; we do NOT rebuild its admin panel — the HERMES
agent card in the HUD deep-links to Hermes' own dashboard.

## How the bridge works (src/lib/hermes.ts)

| Lane | Mechanism |
| --- | --- |
| Session summaries → memory | `POST {HERMES_URL}/v1/responses` with a "store this in your memory" turn on the `brightos-memory` conversation. hermes-agent has **no REST memory-push endpoint** — its curated memory (`~/.hermes/memories/MEMORY.md`, 2,200-char cap) is written by the agent's own `memory` tool, so agent-mediated writes are the sanctioned path. `X-Hermes-Session-Key: brightos` scopes memory providers. |
| Research (`/research …`, intents tagged research) | `POST {HERMES_URL}/v1/responses` asking for STRICT JSON `{task_title, summary, claims:[{claim_text, source_url}]}`. Hermes has **first-class X search** (`x_search`, backed by xAI — set `XAI_API_KEY` on the Hermes side) plus `web_search`. Results land as a BRIGHT OS task with `claims[]`; every claim is stored `verified=false`, and claims without `source_url` can never verify (HUD shows them flagged). |
| Dashboard | `hermes dashboard` serves its own React admin on port **9119**. Set `NEXT_PUBLIC_HERMES_DASHBOARD_URL` and the HUD agent card links straight to it. |

## Enabling the API server on your Hermes instance

The API server is OFF by default and loopback-bound. In `~/.hermes/.env`:

```
API_SERVER_ENABLED=true
API_SERVER_HOST=0.0.0.0        # container/LAN reachable
API_SERVER_PORT=8642
API_SERVER_KEY=<openssl rand -hex 32>   # min 8 chars; treat like root
```

⚠️ The API grants Hermes' full toolset **including terminal** — keep 8642
firewalled to the VPS-internal network and never expose it publicly.

For X search: `XAI_API_KEY=...` (or `hermes auth add xai-oauth`).
For web search: `EXA_API_KEY` / `FIRECRAWL_API_KEY`.

## Docker (same VPS, used by our docker-compose.yml)

```yaml
hermes:
  image: nousresearch/hermes-agent
  command: gateway run
  restart: unless-stopped
  volumes:
    - ~/.hermes:/opt/data          # ALL Hermes state lives here
  ports:
    - "127.0.0.1:8642:8642"        # API (loopback only)
    - "127.0.0.1:9119:9119"        # dashboard
  environment:
    API_SERVER_ENABLED: "true"
    API_SERVER_HOST: "0.0.0.0"
    API_SERVER_KEY: "${HERMES_API_KEY}"
    HERMES_DASHBOARD: "1"
```

## BRIGHT OS env

```
HERMES_URL=http://hermes:8642            # or http://127.0.0.1:8642 with pm2
HERMES_API_KEY=<same as API_SERVER_KEY>
HERMES_MODEL=hermes-agent                # model field is cosmetic server-side
NEXT_PUBLIC_HERMES_DASHBOARD_URL=http://<vps-ip>:9119
```

## Optional: push-on-finish hook

Long research can also be run through Hermes' async Runs API
(`POST /v1/runs`, SSE at `/v1/runs/{id}/events`). If you want Hermes to
notify BRIGHT OS when background work finishes, drop a gateway hook at
`~/.hermes/hooks/brightos/HOOK.yaml` subscribing to `agent:end` whose
`handler.py` POSTs an HMAC-signed event to `{BRIGHTOS_URL}/api/heartbeat`
(same recipe as docs/OPENCLAW_SKILL.md §5).
