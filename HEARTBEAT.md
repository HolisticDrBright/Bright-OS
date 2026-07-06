# HEARTBEAT.md — 30-minute system pulse (keep under 50 lines)

The heartbeat worker reads this file each beat and runs every CHECKED item.
Uncheck a line to disable that check without deploying. Order = run order.

## Checks

- [x] decision-aging — any decision pending > 24h: escalate severity, Telegram
      alert with approval buttons. Re-alerts at most once per 24h per decision.
- [x] ghl-waitlist — GoHighLevel contact totals since last beat → ticker event;
      negative or > threshold deltas raise an alert.
- [x] gsc-deltas — Search Console clicks/position on tracked queries per brand;
      ±20% click moves or ≥3 position moves → alert, else ticker info.
- [x] publish-verification — tasks shipped in the last 24h with a `url` in
      frontmatter: fetch live page, require HTTP 200 + expected title;
      failure → red alert + task pushed back to in_progress.
- [x] board-hygiene — tasks in_progress > 72h with no session activity → warn.

## Rules

- Every check writes heartbeat_events; all checks batch into one run.
- If the daily cost cap is exceeded, the beat pauses all checks and raises
  one COST-BREAKER alert for the day (circuit breaker).
- A check crashing never kills the beat; the failure itself becomes a warn
  event with source WORKER.

## Tuning

- decision-aging threshold: 24h (DECISION_AGING_HOURS)
- ghl delta alert threshold: 50 (GHL_DELTA_ALERT)
- gsc click move threshold: ±20% (GSC_CLICK_PCT)
- board hygiene idle window: 72h (BOARD_IDLE_HOURS)
