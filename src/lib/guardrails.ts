import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

/**
 * Non-negotiable guardrails enforced in code (not prompts):
 *  - medical/regulatory content ALWAYS requires human approval
 *  - cost circuit breaker: daily spend over cap pauses workers + /api/command
 *  - agents can never decide decisions (enforced in the decide route/auth)
 */

const MEDICAL_PATTERNS: RegExp[] = [
  /\bmedical\b/i,
  /\bclinical?\b/i,
  /\bpatient\b/i,
  /\bdiagnos/i,
  /\btreatment\b/i,
  /\bdosage|dosing|dose\b/i,
  /\bpeptide|bpc-?157|tb-?500|glp-?1|semaglutide|tirzepatide\b/i,
  /\bhipaa\b/i,
  /\bfda|dea|compounding|pharmacy|prescri/i,
  /\bregulat|license|licensure|compliance\b/i,
  /\bsupplement claim|health claim\b/i,
];

/** Detects content that must never be auto-approved by any pathway. */
export function isMedicalOrRegulatory(text: string | null | undefined, tags?: string[] | null): boolean {
  if (tags?.some((t) => ["medical", "regulatory", "clinical"].includes(t.toLowerCase()))) return true;
  if (!text) return false;
  return MEDICAL_PATTERNS.some((re) => re.test(text));
}

/** Tags a new decision so the medical/regulatory rule is data, not vibes. */
export function autoTagDecision(fields: {
  title?: string | null;
  impact_note?: string | null;
  preview_md?: string | null;
  tags?: string[] | null;
}): string[] {
  const tags = new Set((fields.tags ?? []).map((t) => t.toLowerCase()));
  const blob = [fields.title, fields.impact_note, fields.preview_md].filter(Boolean).join("\n");
  if (isMedicalOrRegulatory(blob)) {
    tags.add("medical-regulatory");
  }
  return [...tags];
}

export interface CostBreakerState {
  tripped: boolean;
  spentTodayUsd: number;
  capUsd: number;
}

/** Day boundary in the operator's timezone (America/Los_Angeles). */
export function startOfTodayIso(now = new Date(), timeZone = env.timezone): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  // local wall-clock time of `now`, used to find how far past local midnight we are
  const localAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === "24" ? 0 : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const sinceMidnightMs =
    localAsUtc - Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  return new Date(now.getTime() - sinceMidnightMs).toISOString();
}

/**
 * Cost circuit breaker. Sums agent_sessions.cost_usd since local midnight;
 * when spend ≥ DAILY_COST_CAP_USD, callers must pause and alert.
 */
export async function checkCostBreaker(db: SupabaseClient, now = new Date()): Promise<CostBreakerState> {
  const cap = env.dailyCostCapUsd;
  const { data, error } = await db
    .from("agent_sessions")
    .select("cost_usd")
    .gte("started_at", startOfTodayIso(now));
  if (error) throw new Error(`cost breaker query failed: ${error.message}`);
  const spent = (data ?? []).reduce((acc, r) => acc + Number(r.cost_usd ?? 0), 0);
  return { tripped: cap > 0 && spent >= cap, spentTodayUsd: Math.round(spent * 100) / 100, capUsd: cap };
}

/**
 * Fires the breaker alert exactly once per local day (dedup on
 * heartbeat_events.meta.breaker_day).
 */
export async function alertCostBreakerOnce(db: SupabaseClient, state: CostBreakerState, now = new Date()) {
  if (!state.tripped) return false;
  const day = startOfTodayIso(now).slice(0, 10);
  const { data } = await db
    .from("heartbeat_events")
    .select("id")
    .eq("source", "COST-BREAKER")
    .gte("ts", startOfTodayIso(now))
    .limit(1);
  if (data && data.length > 0) return false;
  await db.from("heartbeat_events").insert({
    source: "COST-BREAKER",
    message: `Daily spend $${state.spentTodayUsd.toFixed(2)} ≥ cap $${state.capUsd.toFixed(2)} — workers paused`,
    severity: "alert",
    meta: { breaker_day: day, spent: state.spentTodayUsd, cap: state.capUsd },
  });
  return true;
}
