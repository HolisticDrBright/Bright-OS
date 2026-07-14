# Bringing HERMES online

HERMES (github.com/NousResearch/Hermes-Agent) is the fleet's memory + research
agent. BRIGHT OS is already wired for it — the research lane, the memory lane,
and `search_memory` all light up the moment the two env vars below are set.

## 1. Install Hermes (on your PC, or a small VPS)

Windows (native, PowerShell):

```powershell
iex (irm https://hermes-agent.nousresearch.com/install.ps1)
```

Linux / macOS / WSL2:

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

Then run the wizard:

```powershell
hermes setup
```

## 2. Connect your model keys (OpenAI + Claude)

Hermes drives ONE active model at a time, but you can configure several
providers and switch freely with `hermes model`:

- **OpenAI** — pick the OpenAI provider in `hermes setup` (or `hermes model`)
  and paste your `OPENAI_API_KEY` (the same key bright-os uses).
- **Claude / Anthropic** — if the provider list shows Anthropic, paste your
  Anthropic key there. If your version doesn't list it natively, two clean
  routes: (a) OpenRouter (one key, fronts Claude models), or (b) a "custom
  endpoint" pointed at Anthropic's OpenAI-compatible surface
  (`https://api.anthropic.com/v1/` with your Anthropic key).
- Switch anytime: `hermes model` (e.g. Claude for deep research, GPT for cheap
  memory turns). No code changes on the BRIGHT OS side.

## 3. Enable Hermes' API server (what BRIGHT OS talks to)

In Hermes' configuration (config dir: `~/.hermes` on Linux/macOS/WSL2,
`%LOCALAPPDATA%\hermes` on Windows), enable the OpenAI-compatible API server:

```
API_SERVER_ENABLED=true
API_SERVER_KEY=<generate a long random string — this is the handshake secret>
```

(Default port 8642.) Then start the gateway and leave it running:

```powershell
hermes gateway
```

## 4. Point BRIGHT OS at it

In the bright-os `.env`:

```
HERMES_URL=http://127.0.0.1:8642        # or http://<vps-ip>:8642
HERMES_API_KEY=<the same API_SERVER_KEY>
# HERMES_MODEL=hermes-agent             # default; usually leave as-is
```

Restart `npm run dev` (and workers if running).

## 5. Verify the handshake

```powershell
npm run hermes:check
```

It tests each link (env loads → gateway listening → key accepted → real
round-trip) and prints exactly which link is broken, if any. When it passes:

- `/research <topic>` in the HUD → HERMES researches and files a task with
  sourced claims for CODEX verification
- every command session grows HERMES' curated memory automatically
- `search_memory` gains deep session recall

If `hermes:check` reports a 404 on `/v1/responses`, your Hermes version has a
different API surface — paste the output into Claude and the bridge
(`src/lib/hermes.ts`) gets adjusted to match.
