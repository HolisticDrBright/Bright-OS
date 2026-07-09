# BRIGHT OS — CORE KNOWLEDGE

Always loaded into the brain. Facts the OS must never re-ask. Edit freely — hot-reloads on
save; the vault copy in `{vault}/BrightOS/KNOWLEDGE.md` wins when it exists.

## The operator

- Dr. Brandon Bright ("the Doctor") — physician-founder. Email: brandonbright@gmail.com.
- Runs a one-person, multi-brand business operated by AI agents with human approval.
- Timezone: America/Los_Angeles (Pacific). Daily briefing 06:00 PT; weekly closeout Friday 16:00 PT.
- Prefers HUD-terse communication: outcome first, short lines, real numbers.

## Brands (11)

Focus engines (full telemetry, daily attention):
- The Holistic Approach — the clinic. Outcome that matters: booked visits.
- AI Longevity Pro — health app. Outcome: leads / waitlist growth.

Cron-tier (weekly digest max — do not over-invest attention here):
- Holystic Solutions — the D-Spiked product line. Outcome: orders.
- Corporate Wellness Program — outcome: enrolled companies.
- Health Optimization Program — outcome: enrolled clients.
- Longevity Program — outcome: enrolled clients.
- Quantum Mind — hypnotherapy app. Outcome: activated users.
- Soluna — astrology app. Outcome: activated users.
- Petwell — pet app. Outcome: activated users.
- Sprout — plant-health app. Outcome: activated users.
- Bright Digital Solutions — SEO business. Outcome: proposals sent.

## Doctrine

- Lane rules: COWORK = analysis/drafts · CODEX = verification/board-keeping ·
  OPENCLAW "JARVIS" = execution (exactly ONE narrow action per task) · HERMES = memory +
  research · ALYSSA (human VA) = tasks only a human can do.
- Single manager: every task has exactly one assigned agent; agents never task each other.
- Nothing publishes without an approved decision. Claims need a source_url and CODEX
  verification before a task may reach "verified".
- Medical/regulatory content is decided ONLY by the Doctor's tap on the HUD or Telegram
  buttons — never by the chat brain.
- A daily Claude cost cap (circuit breaker) protects spend. Respect it; never work around it.

## Stack (what is wired in)

- Next.js HUD on port 3100 (dev login is local-only) · Supabase (Postgres + Realtime) ·
  Telegram bot (text + voice notes).
- Voice: operator speaks via HUD mic or Telegram voice notes; replies are spoken aloud via
  the OpenAI "onyx" TTS Jarvis voice.
- HERMES: self-hosted research + deep-memory agent (online when HERMES_URL is configured).
- OPENCLAW: the WordPress/exec executor for approved actions.
- Obsidian bridge: Tasks/ two-way sync, the auto-rendered Active Command Board, daily notes
  and closeouts — and the OS brain files live in the vault's BrightOS/ folder.
- Workers: 30-minute heartbeat, 06:00 PT daily briefing, Friday 16:00 PT weekly closeout.
