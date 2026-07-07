# SMOKE TEST — the full loop from your phone

Everything below works from a phone browser + Telegram. Prereqs: deployed app
with `.env` filled, Telegram webhook set, seed run (`npm run seed`).
Where a `curl` is shown you can paste it into any shell (or Termius on iOS).

Set once in your shell:

```sh
OS=https://os.yourdomain.com
TOKEN=<AGENT_API_TOKEN>
HMAC=<HEARTBEAT_HMAC_SECRET>
```

---

## 0 · Sign in (30s)

- [ ] Open `$OS` on your phone → OTP email arrives → code signs you in.
- [ ] HUD boots ("BRIGHT OS ONLINE"), top bar shows `NOMINAL`, brand pods render.
- [ ] Wrong email is refused with "this OS has exactly one operator".

## 1 · Create a task (chat → board)

- [ ] In the COMMAND chat type:
      `create a task for openclaw: publish the /beta-access page for AI Longevity Pro`
- [ ] Reply confirms creation; BOARD tab shows it under ASSIGNED with the OC hex.
- [ ] (Realtime check) keep the board open on a second device — it appears without a refresh.

## 2 · Agent works it (simulating the OpenClaw skill)

```sh
# task id: tap the task in the HUD, or:
curl -s "$OS/api/tasks?agent=openclaw&status=assigned" \
  -H "Authorization: Bearer $TOKEN" -H "x-agent-name: openclaw" | head -c 600
TASK=<id>

# start work
curl -s -X PATCH "$OS/api/tasks/$TASK" \
  -H "Authorization: Bearer $TOKEN" -H "x-agent-name: openclaw" \
  -H "content-type: application/json" -d '{"status":"in_progress"}'

# stage the publish target for the heartbeat verifier
curl -s -X PATCH "$OS/api/tasks/$TASK" \
  -H "Authorization: Bearer $TOKEN" -H "x-agent-name: openclaw" \
  -H "content-type: application/json" \
  -d '{"frontmatter":{"url":"https://example.com/","expected_title":"Example Domain"}}'

# file the claim WITH a source_url (the hallucination gate)
curl -s -X POST "$OS/api/tasks/$TASK/claims" \
  -H "Authorization: Bearer $TOKEN" -H "x-agent-name: openclaw" \
  -H "content-type: application/json" \
  -d '{"claim_text":"page staged and returns 200","source_url":"https://example.com/"}'
```

- [ ] Fleet card OPENCLAW flips to WORKING (cyan pulsing ring).

## 3 · Decision appears in Telegram

```sh
curl -s -X POST "$OS/api/decisions" \
  -H "Authorization: Bearer $TOKEN" -H "x-agent-name: openclaw" \
  -H "content-type: application/json" \
  -d "{\"title\":\"Publish /beta-access — AI Longevity Pro\",\"task_id\":\"$TASK\",
       \"brand\":\"AI Longevity Pro\",\"impact_note\":\"480 unconverted searches\",
       \"preview_md\":\"+ CTA: Claim beta access — 200 slots\\n- CTA: waitlist\"}"
```

- [ ] Telegram pings within seconds: decision card with ✅ / ❌ / 💬 buttons.
- [ ] HUD Decision Queue shows the same card (age-tinted corners); task is AWAITING APPROVAL.
- [ ] Tap 💬 → force-reply thread → your reply is appended to the decision preview.

## 4 · Approve (the 10-second moment)

- [ ] Tap ✅ in Telegram → message edits to "✅ APPROVED via Telegram".
- [ ] HUD queue empties toward ALL CLEAR (approve on the HUD instead: card slides
      away with the APPROVED ✓ stamp).
- [ ] Guardrail probe: BEFORE verifying claims, try dragging the task to
      VERIFIED-SHIPPED with an unverified claim → BLOCKED stamp
      ("unverified claims"). Verify the claim, then:

```sh
# CODEX verifies the claim (needs its id from /api/tasks/$TASK)
curl -s -X PATCH "$OS/api/claims/<claim-id>" \
  -H "Authorization: Bearer $TOKEN" -H "x-agent-name: codex" \
  -H "content-type: application/json" -d '{"verified":true}'

# now verified → shipped succeeds (approval exists)
curl -s -X PATCH "$OS/api/tasks/$TASK" \
  -H "Authorization: Bearer $TOKEN" -H "x-agent-name: codex" \
  -H "content-type: application/json" -d '{"status":"verified"}'
curl -s -X PATCH "$OS/api/tasks/$TASK" \
  -H "Authorization: Bearer $TOKEN" -H "x-agent-name: openclaw" \
  -H "content-type: application/json" -d '{"status":"shipped"}'
```

## 5 · Heartbeat verifies the publish

- [ ] Wait for the next half-hour beat (or `docker compose exec workers npx tsx -e
      "import('/app/src/workers/heartbeat.js')"` — easier: just wait; boot also beats).
- [ ] Ticker shows `PUBLISH-VERIFY: verified live: https://example.com/`.
- [ ] Negative test: set `frontmatter.expected_title` to `"Wrong Title"`, wait a
      beat → red alert in Telegram + ticker, task pushed back to IN PROGRESS.
- [ ] OpenClaw's publish confirmation lane (HMAC) works:

```sh
BODY='{"source":"OPENCLAW","message":"published /beta-access ✓","meta":{"task_id":"'$TASK'"}}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$HMAC" -hex | sed 's/^.* //')
curl -s -X POST "$OS/api/heartbeat" -H "content-type: application/json" \
  -H "x-brightos-timestamp: $TS" -H "x-brightos-signature: $SIG" -d "$BODY"
# → {"ingested":1}; tamper with BODY after signing → 401
```

## 6 · Board note updates in Obsidian

- [ ] Within ~10 min (or on any task change), open **Active Command Board.md**
      in Obsidian (OneDrive-synced) — the task sits under SHIPPED with agent +
      brand, and the note says "Rendered from the BRIGHT OS database".
- [ ] Two-way: edit a task note's frontmatter `status: doing` in Obsidian →
      task moves to IN PROGRESS in the HUD (watcher log shows `note → db`).
      Illegal edits (e.g. `status: shipped` from backlog) are rejected and the
      file is rewritten from the DB.

## 7 · Round out the cockpit

- [ ] `/brief` in Telegram → morning briefing replays.
- [ ] `/research <topic>` in chat → HERMES task appears with claims; unsourced
      claims show ⚑ flagged; HERMES card deep-links to its own dashboard.
- [ ] ANALYTICS tab: today's command costs appear in the heatmap + model donut.
- [ ] MEMORY tab: promote a daily-log line → PROMOTED ⤴ stamp → line lands in
      MEMORY.md (check the vault file too).
- [ ] 06:00 PT next morning: briefing in Telegram + `Daily Notes/<date>.md`.
- [ ] Voice: send the Telegram bot a voice note → transcript + brain reply.

**Pass = every box ticked.** The queue should end the day empty: ALL CLEAR.
