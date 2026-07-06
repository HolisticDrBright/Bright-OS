import fs from "node:fs/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { alertCostBreakerOnce, checkCostBreaker } from "@/lib/guardrails";
import { formatDecisionMessage, decisionKeyboard, sendAlert } from "@/lib/telegram/send";
import {
  type CheckDeps,
  type EventInsert,
  checkBoardHygiene,
  checkDecisionAging,
  checkGhlWaitlist,
  checkGscDeltas,
  checkPublishVerification,
} from "./checks";

/**
 * THE HEARTBEAT — every 30 minutes. Reads HEARTBEAT.md (checkbox list),
 * runs the enabled checks, batches every event into one insert, pushes
 * Telegram alerts, and respects the cost circuit breaker.
 */

export type CheckName =
  | "decision-aging"
  | "ghl-waitlist"
  | "gsc-deltas"
  | "publish-verification"
  | "board-hygiene";

const CHECKS: Record<CheckName, (deps: CheckDeps) => Promise<EventInsert[]>> = {
  "decision-aging": checkDecisionAging,
  "ghl-waitlist": checkGhlWaitlist,
  "gsc-deltas": checkGscDeltas,
  "publish-verification": checkPublishVerification,
  "board-hygiene": checkBoardHygiene,
};

/** Parses "- [x] name — …" checkbox lines. Unknown names are ignored. */
export function parseHeartbeatMd(content: string): CheckName[] {
  const enabled: CheckName[] = [];
  for (const line of content.split("\n")) {
    const m = /^\s*-\s*\[(x|X| )\]\s*([a-z0-9-]+)/i.exec(line.trim());
    if (!m) continue;
    const checked = m[1].toLowerCase() === "x";
    const name = m[2].toLowerCase() as CheckName;
    if (checked && name in CHECKS) enabled.push(name);
  }
  return enabled;
}

async function readHeartbeatMd(): Promise<CheckName[]> {
  try {
    const content = await fs.readFile(env.heartbeatMdPath, "utf8");
    return parseHeartbeatMd(content);
  } catch {
    return Object.keys(CHECKS) as CheckName[]; // no file → run everything
  }
}

export interface BeatResult {
  paused: boolean;
  ran: CheckName[];
  events: EventInsert[];
  failures: { check: CheckName; error: string }[];
}

export async function runHeartbeat(
  db: SupabaseClient,
  opts?: { fetchImpl?: typeof fetch; now?: Date; sendTelegram?: boolean },
): Promise<BeatResult> {
  const now = opts?.now ?? new Date();
  const sendTg = opts?.sendTelegram ?? true;

  // Circuit breaker first: over cap → pause everything, alert once.
  const breaker = await checkCostBreaker(db, now);
  if (breaker.tripped) {
    const fired = await alertCostBreakerOnce(db, breaker, now);
    if (fired && sendTg) {
      await sendAlert(
        `COST BREAKER: $${breaker.spentTodayUsd.toFixed(2)} spent ≥ $${breaker.capUsd} cap — workers paused until midnight PT`,
      ).catch(() => {});
    }
    return { paused: true, ran: [], events: [], failures: [] };
  }

  const enabled = await readHeartbeatMd();
  const deps: CheckDeps = {
    db,
    fetchImpl: opts?.fetchImpl,
    now,
    notifyDecision: sendTg
      ? async (d, ageHours) => {
          const { env: e } = await import("@/lib/env");
          if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
          await fetch(`https://api.telegram.org/bot${e.telegramBotToken}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              chat_id: e.telegramChatId,
              text: `⏳ blocked ${ageHours}h\n${formatDecisionMessage(d as never, { ageHours })}`,
              parse_mode: "HTML",
              reply_markup: decisionKeyboard(String(d.id)),
            }),
          });
        }
      : undefined,
  };

  const events: EventInsert[] = [];
  const failures: BeatResult["failures"] = [];
  for (const name of enabled) {
    try {
      events.push(...(await CHECKS[name](deps)));
    } catch (e) {
      failures.push({ check: name, error: e instanceof Error ? e.message : String(e) });
      events.push({
        source: "WORKER",
        message: `check ${name} failed: ${e instanceof Error ? e.message : e}`,
        severity: "warn",
        meta: { check: name },
      });
    }
  }

  events.push({
    source: "HEARTBEAT",
    message: `beat complete: ${enabled.length} checks, ${events.length} events`,
    severity: "info",
    meta: { checks: enabled, failures: failures.length },
  });

  // one batched insert per beat
  const { error } = await db.from("heartbeat_events").insert(events);
  if (error) throw new Error(`heartbeat event insert failed: ${error.message}`);

  if (sendTg) {
    for (const e of events.filter((ev) => ev.severity === "alert" && ev.source !== "DECISION-AGING")) {
      await sendAlert(`${e.source}: ${e.message}`).catch(() => {});
    }
  }

  return { paused: false, ran: enabled, events, failures };
}
