# SKILL.md — BRIGHT OS bridge (install in your OpenCLAW instance)

OpenCLAW ("JARVIS") keeps its existing WordPress/exec lanes. This skill adds
the BRIGHT OS reporting loop: pull your task queue, report status changes,
file claims for everything you assert, confirm publishes, and request
approval before anything ships. **One narrow action per task. Nothing
publishes without an approved decision — the API will refuse.**

## Environment

```
BRIGHTOS_URL=https://os.example.com
BRIGHTOS_AGENT_TOKEN=<AGENT_API_TOKEN from BRIGHT OS .env>
BRIGHTOS_HMAC_SECRET=<HEARTBEAT_HMAC_SECRET from BRIGHT OS .env>
```

Two auth lanes:

- **Agent API** (task pulls, status, claims, decisions):
  `Authorization: Bearer $BRIGHTOS_AGENT_TOKEN` + `x-agent-name: openclaw`
- **Heartbeat ingest** (events, publish confirmations): HMAC headers over the
  raw JSON body — `x-brightos-timestamp` (unix seconds, ±300s) and
  `x-brightos-signature = hex(HMAC_SHA256(secret, "$ts.$body"))`

## 1 · Pull your queue (poll every few minutes)

```bash
curl -s "$BRIGHTOS_URL/api/tasks?agent=openclaw&status=assigned,in_progress" \
  -H "Authorization: Bearer $BRIGHTOS_AGENT_TOKEN" -H "x-agent-name: openclaw"
```

Pick ONE task, move it to `in_progress`, do the ONE action it describes.

## 2 · Report status changes

```bash
curl -s -X PATCH "$BRIGHTOS_URL/api/tasks/$TASK_ID" \
  -H "Authorization: Bearer $BRIGHTOS_AGENT_TOKEN" -H "x-agent-name: openclaw" \
  -H "content-type: application/json" \
  -d '{"status":"in_progress"}'
```

Your allowed transitions: `assigned→in_progress`,
`in_progress→awaiting_approval|verified|failed`, `awaiting_approval→in_progress`,
`verified→shipped`, `failed→in_progress`. Anything else 422s.

## 3 · File a claim for every assertion you make

Anything you claim to have done ("deployed", "submitted", "published") MUST
be filed as a claim with the URL that proves it. Claims without `source_url`
are stored flagged and the task can never reach `verified`.

```bash
curl -s -X POST "$BRIGHTOS_URL/api/tasks/$TASK_ID/claims" \
  -H "Authorization: Bearer $BRIGHTOS_AGENT_TOKEN" -H "x-agent-name: openclaw" \
  -H "content-type: application/json" \
  -d '{"claim_text":"/beta-access deployed and returns 200","source_url":"https://ailongevity.pro/beta-access"}'
```

## 4 · Request approval before publishing

Work that changes anything public gets a decision FIRST. Move the task to
`awaiting_approval` and create the decision with a preview diff:

```bash
curl -s -X POST "$BRIGHTOS_URL/api/decisions" \
  -H "Authorization: Bearer $BRIGHTOS_AGENT_TOKEN" -H "x-agent-name: openclaw" \
  -H "content-type: application/json" \
  -d '{
    "title": "Publish /beta-access copy — AI Longevity Pro",
    "task_id": "'$TASK_ID'",
    "brand": "AI Longevity Pro",
    "impact_note": "480 unconverted searches ≈ 96 leads/day",
    "preview_md": "+ CTA: Claim beta access — 200 slots\n- CTA: Sign up for the waitlist"
  }'
```

Dr. Bright approves from Telegram/HUD. Only after the decision is approved
can the task move `verified → shipped`; the API enforces it, so don't try.
You can NEVER decide decisions yourself — that endpoint rejects agent tokens.

## 5 · Publish confirmations + events → heartbeat

After a real publish, confirm it (include the URL so the 30-min heartbeat
can verify the live page — failures push the task back to you):

```bash
BODY='{"source":"OPENCLAW","message":"published /beta-access ✓","meta":{"task_id":"'$TASK_ID'","url":"https://ailongevity.pro/beta-access"}}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$BRIGHTOS_HMAC_SECRET" -hex | sed 's/^.* //')
curl -s -X POST "$BRIGHTOS_URL/api/heartbeat" \
  -H "content-type: application/json" \
  -H "x-brightos-timestamp: $TS" -H "x-brightos-signature: $SIG" \
  -d "$BODY"
```

Also set `frontmatter.url` + `frontmatter.expected_title` on the task when
you stage a publish — that is what the verifier fetches.

## Node HMAC snippet

```js
const crypto = require("node:crypto");
const ts = String(Math.floor(Date.now() / 1000));
const body = JSON.stringify(payload);
const sig = crypto.createHmac("sha256", process.env.BRIGHTOS_HMAC_SECRET)
  .update(`${ts}.${body}`).digest("hex");
await fetch(`${process.env.BRIGHTOS_URL}/api/heartbeat`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-brightos-timestamp": ts,
    "x-brightos-signature": sig,
  },
  body,
});
```

## House rules (enforced server-side, listed here so you stop early)

1. One narrow WordPress/exec action per task — decompose, don't freelance.
2. Nothing publishes without `decisions.status=approved` on the task.
3. Every assertion needs a claim with a `source_url`.
4. You cannot approve, delete, or touch other agents' lanes.
5. Everything you do lands on the heartbeat ticker — work like you're watched.
