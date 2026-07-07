# BRIGHT OS

Jarvis-style mission control for a one-person, multi-brand business run by AI
agents with human approval. Iron Man HUD (Next.js 15 + Tailwind) over Supabase
(Postgres + Realtime + Storage + Auth), with a Claude-powered command brain,
a Telegram approval surface, a 30-minute heartbeat, an Obsidian two-way
bridge, and a self-hosted Hermes agent as the memory/research lane.

```
bright-os/
  src/app              HUD (6 tabs) + API routes (/api/*)
  src/lib              auth, guardrails, transitions, brain, integrations
  src/workers          heartbeat · daily briefing · weekly closeout · backups
  src/watcher          Obsidian vault ⇄ tasks two-way sync
  supabase/migrations  schema + RLS + realtime (applied via Supabase CLI/MCP)
  scripts              seed · import-mcv2 · set-telegram-webhook
  docs                 OPENCLAW_SKILL.md · HERMES.md · SMOKE_TEST.md
  HEARTBEAT.md         the checkbox list the heartbeat worker executes
```

## The loop it runs

Agents work autonomously → anything needing judgment lands in the **Decision
Queue** → you approve/reject/discuss in seconds (HUD, phone view, or Telegram
buttons) → OpenClaw executes → CODEX verifies claims (every claim needs a
`source_url`) → the heartbeat re-verifies the live publish → the board note in
your vault updates. Goal state: **ALL CLEAR — NOTHING NEEDS YOU**.

### Non-negotiable guardrails (enforced in code + DB triggers)

- Agents can never decide decisions; medical/regulatory decisions can't even
  be decided through chat — HUD/Telegram buttons only.
- A task can't reach `verified` with unverified claims; a claim without
  `source_url` can never verify.
- Nothing ships without `decisions.status=approved` (API layer + DB trigger).
- Inbound webhooks are HMAC-signed (±300s replay window) and rate-limited;
  the Telegram bot is allow-listed to one chat id.
- Cost circuit breaker: daily spend ≥ `DAILY_COST_CAP_USD` pauses workers and
  the command brain, and alerts once.
- No destructive DB ops from agents; nightly `pg_dump` → Supabase Storage,
  weekly off-site copy.

## 1 · Supabase (already provisioned)

A fresh project **bright-os** (`pmrhvztjvnmprrhcrmom`, us-east-1) was created
with all three migrations applied (schema + guardrail triggers, RLS
authenticated-only, Realtime on tasks/decisions/heartbeat_events, private
`backups` bucket) and the agent fleet + brand roster seeded.

Grab from the dashboard → Settings:
- `NEXT_PUBLIC_SUPABASE_URL` = `https://pmrhvztjvnmprrhcrmom.supabase.co`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` (API keys → anon)
- `SUPABASE_SERVICE_ROLE_KEY` (API keys → service_role — server only)
- `SUPABASE_DB_URL` (Database → connection string, for backups)

Re-creating from scratch: `supabase link --project-ref <ref> && supabase db push`
from this directory, then `npm run seed` (add `-- --demo` for smoke-test data).

## 2 · Local dev

```sh
cp .env.example .env   # fill in Supabase + ANTHROPIC_API_KEY at minimum
npm ci
npm run dev            # HUD on http://localhost:3100
npm test               # 136 tests
npm run workers        # cron process (separate terminal)
npm run watcher        # Obsidian bridge (needs OBSIDIAN_VAULT_PATH)
```

Sign-in: enter `ALLOWED_EMAIL` on /login → Supabase emails a 6-digit OTP.
Sessions are long-lived (refresh tokens); nothing is publicly writable.

## 3 · VPS deploy (DigitalOcean, Docker Compose)

```sh
# on a fresh droplet (2GB+), as root:
apt update && apt install -y docker.io docker-compose-v2 git
git clone <this repo> && cd rork-ai-longevity-coach/bright-os
cp .env.example .env && nano .env          # fill EVERYTHING relevant
mkdir -p vault hermes-data

docker compose up -d --build               # app + workers + watcher + hermes
docker compose logs -f app                 # watch it come up
```

Four services: `app` (HUD+API :3100 loopback), `workers`, `watcher`, `hermes`
(:8642 API, :9119 dashboard — both loopback-only on purpose).

**TLS**: put Caddy in front (`apt install caddy`), Caddyfile:

```
os.yourdomain.com {
    reverse_proxy 127.0.0.1:3100
}
```

**pm2 instead of Docker**: `npm ci && npm run build && pm2 start
ecosystem.config.cjs && pm2 save && pm2 startup` (run Hermes separately per
docs/HERMES.md).

### Post-deploy wiring

1. **Telegram** — create a bot with @BotFather → `TELEGRAM_BOT_TOKEN`. Message
   the bot once, get your chat id (`https://api.telegram.org/bot<t>/getUpdates`)
   → `TELEGRAM_CHAT_ID`. Set a random `TELEGRAM_WEBHOOK_SECRET`, then:
   `npm run telegram:set-webhook` (needs `APP_BASE_URL=https://os.yourdomain.com`).
2. **Hermes** — first boot: `docker compose exec hermes hermes setup` (or edit
   `hermes-data/.env`): model provider key + `XAI_API_KEY` for X search. Set
   `HERMES_URL=http://hermes:8642`, `HERMES_API_KEY` (same as `API_SERVER_KEY`),
   `NEXT_PUBLIC_HERMES_DASHBOARD_URL=http://<droplet-ip>:9119` (or SSH tunnel).
   Details: docs/HERMES.md.
3. **OpenClaw** — install docs/OPENCLAW_SKILL.md in your existing instance
   with `BRIGHTOS_URL`, `AGENT_API_TOKEN`, `HEARTBEAT_HMAC_SECRET`.
4. **Obsidian vault** — the vault is OneDrive-synced; on the VPS run
   `rclone mount onedrive:Vault ./vault --daemon --vfs-cache-mode writes`
   (or `rclone bisync` on a timer) so `./vault` is the synced copy. The
   watcher poll-watches it (inotify-safe for network mounts).
5. **GHL / GSC** — GHL API key + location id; GSC service-account JSON
   (email + private key) with the property added as a user, then
   `GSC_TRACKED=Brand|https://site.com|query1;query2,...`.
6. **MC V2 import** (one-shot, idempotent):
   `MCV2_SUPABASE_URL=... MCV2_SUPABASE_SERVICE_KEY=... npm run import:mcv2`
   (`-- --dry-run` first to preview).

## 4 · Schedules (America/Los_Angeles)

| When | What |
| --- | --- |
| every 30 min | heartbeat: decision aging → Telegram re-alert, GHL deltas, GSC ±20% moves, publish verification (200 + expected title, failures push task back), board hygiene |
| 06:00 daily | briefing → Telegram + vault daily note |
| Fri 16:00 | weekly closeout → vault + Telegram ($-in/$-out per engine) |
| 01:30 daily / Sun 01:45 | pg_dump → Storage / off-site copy (rclone) |
| every 10 min | "Active Command Board.md" re-render (board can never go stale) |

Checks are toggled by editing the checkboxes in `HEARTBEAT.md` — no deploy.

## 5 · Smoke test

Run docs/SMOKE_TEST.md from your phone: create task → agent works → decision
lands in Telegram → approve → heartbeat verifies the publish → board note
updates in Obsidian.

## API surface (all human-or-agent authenticated; see docs/OPENCLAW_SKILL.md)

`/api/agents` · `/api/tasks` (guarded transitions) · `/api/tasks/:id/claims` ·
`/api/claims/:id` · `/api/decisions` + `/api/decisions/:id/decide` (human-only)
· `/api/heartbeat` (HMAC) · `/api/metrics/summary` · `/api/memory` +
`/api/memory/promote` · `/api/brands` · `/api/command` (the reactor brain) ·
`/api/telegram/webhook`.
