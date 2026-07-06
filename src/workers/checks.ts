import type { SupabaseClient } from "@supabase/supabase-js";
import type { HeartbeatSeverity } from "@/types/db";
import { getContactCount, ghlConfigured } from "@/lib/ghl";
import { computeDeltas, getAccessToken, gscConfigured, parseTracked, queryDaily } from "@/lib/gsc";

export interface EventInsert {
  source: string;
  message: string;
  severity: HeartbeatSeverity;
  meta: Record<string, unknown>;
}

export interface CheckDeps {
  db: SupabaseClient;
  fetchImpl?: typeof fetch;
  now?: Date;
  /** decision alerts re-send the Telegram approval card */
  notifyDecision?: (decision: Record<string, unknown>, ageHours: number) => Promise<void>;
}

const HOURS = 36e5;

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** 1 — Blocked-decision aging: pending > 24h escalates + Telegram re-alert. */
export async function checkDecisionAging(deps: CheckDeps): Promise<EventInsert[]> {
  const { db } = deps;
  const now = deps.now ?? new Date();
  const thresholdH = envNum("DECISION_AGING_HOURS", 24);
  const cutoff = new Date(now.getTime() - thresholdH * HOURS).toISOString();

  const { data: stale, error } = await db
    .from("decisions")
    .select("*")
    .eq("status", "pending")
    .lte("created_at", cutoff);
  if (error) throw new Error(`decision aging query failed: ${error.message}`);
  if (!stale || stale.length === 0) return [];

  // one escalation per decision per 24h
  const { data: recentAlerts } = await db
    .from("heartbeat_events")
    .select("meta")
    .eq("source", "DECISION-AGING")
    .gte("ts", new Date(now.getTime() - 24 * HOURS).toISOString());
  const alreadyAlerted = new Set(
    (recentAlerts ?? []).map((e) => (e.meta as Record<string, unknown>)?.decision_id).filter(Boolean),
  );

  const events: EventInsert[] = [];
  for (const d of stale) {
    if (alreadyAlerted.has(d.id)) continue;
    const ageHours = Math.round((now.getTime() - new Date(d.created_at).getTime()) / HOURS);
    events.push({
      source: "DECISION-AGING",
      message: `decision blocked ${ageHours}h: ${d.title}`,
      severity: "alert",
      meta: { decision_id: d.id, age_hours: ageHours },
    });
    if (deps.notifyDecision) {
      await deps.notifyDecision(d, ageHours).catch(() => {});
    }
  }
  return events;
}

/** 2 — GHL waitlist counts: delta vs last beat; anomalies alert. */
export async function checkGhlWaitlist(deps: CheckDeps): Promise<EventInsert[]> {
  if (!ghlConfigured()) return [];
  const { db } = deps;
  const total = await getContactCount({
    tag: process.env.GHL_WAITLIST_TAG,
    fetchImpl: deps.fetchImpl,
  });

  const { data: last } = await db
    .from("heartbeat_events")
    .select("meta")
    .eq("source", "GHL")
    .order("ts", { ascending: false })
    .limit(1);
  const prev = Number((last?.[0]?.meta as Record<string, unknown>)?.waitlist_total ?? NaN);
  const delta = Number.isFinite(prev) ? total - prev : 0;
  const anomalyAt = envNum("GHL_DELTA_ALERT", 50);

  const anomalous = Number.isFinite(prev) && (delta < 0 || delta >= anomalyAt);
  return [
    {
      source: "GHL",
      message: anomalous
        ? `waitlist anomaly: ${delta >= 0 ? "+" : ""}${delta} since last beat (total ${total})`
        : delta > 0
          ? `+${delta} new signups (total ${total})`
          : `waitlist steady at ${total}`,
      severity: anomalous ? "alert" : "info",
      meta: { waitlist_total: total, delta },
    },
  ];
}

/** 3 — GSC clicks/position deltas on tracked queries; ±20% moves alert. */
export async function checkGscDeltas(deps: CheckDeps): Promise<EventInsert[]> {
  if (!gscConfigured()) return [];
  const f = deps.fetchImpl ?? fetch;
  const token = await getAccessToken(f, deps.now);
  const clickPct = envNum("GSC_CLICK_PCT", 20);
  const events: EventInsert[] = [];

  for (const site of parseTracked()) {
    const rows = await queryDaily(site, { token, fetchImpl: f, now: deps.now });
    for (const d of computeDeltas(site.brand, rows)) {
      const clicksMoved = d.clicksPctChange !== null && Math.abs(d.clicksPctChange) >= clickPct;
      const positionMoved = Math.abs(d.positionChange) >= 3;
      if (clicksMoved || positionMoved) {
        const dir = (d.clicksPctChange ?? 0) >= 0 && d.positionChange >= 0 ? "info" : "alert";
        const bits: string[] = [];
        if (d.clicksPctChange !== null) {
          bits.push(`clicks ${d.clicksPctChange >= 0 ? "+" : ""}${d.clicksPctChange.toFixed(0)}%`);
        }
        if (d.positionChange !== 0) {
          bits.push(
            `position ${d.positionChange > 0 ? "+" : ""}${d.positionChange.toFixed(1)} → #${d.positionLatest.toFixed(0)}`,
          );
        }
        events.push({
          source: "GSC",
          message: `${site.brand} "${d.query}": ${bits.join(" · ")}`,
          severity: dir as HeartbeatSeverity,
          meta: { ...d },
        });
      }
    }
  }
  if (events.length === 0) {
    events.push({ source: "GSC", message: "tracked queries steady", severity: "info", meta: {} });
  }
  return events;
}

/** 4 — Publish verification: shipped in last 24h with a URL must be live. */
export async function checkPublishVerification(deps: CheckDeps): Promise<EventInsert[]> {
  const { db } = deps;
  const f = deps.fetchImpl ?? fetch;
  const now = deps.now ?? new Date();
  const { data: shipped, error } = await db
    .from("tasks")
    .select("*")
    .eq("status", "shipped")
    .gte("updated_at", new Date(now.getTime() - 24 * HOURS).toISOString());
  if (error) throw new Error(`publish verification query failed: ${error.message}`);

  const events: EventInsert[] = [];
  for (const task of shipped ?? []) {
    const fm = (task.frontmatter ?? {}) as Record<string, unknown>;
    const url = typeof fm.url === "string" ? fm.url : null;
    if (!url) continue;
    const expectedTitle = typeof fm.expected_title === "string" ? fm.expected_title : null;

    let ok = false;
    let detail = "";
    try {
      const res = await f(url, { redirect: "follow" });
      if (!res.ok) {
        detail = `HTTP ${res.status}`;
      } else if (expectedTitle) {
        const html = await res.text();
        const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
        ok = title.toLowerCase().includes(expectedTitle.toLowerCase());
        if (!ok) detail = `title "${title}" ≠ expected "${expectedTitle}"`;
      } else {
        ok = true;
      }
    } catch (e) {
      detail = e instanceof Error ? e.message : "fetch failed";
    }

    if (ok) {
      events.push({
        source: "PUBLISH-VERIFY",
        message: `verified live: ${url}`,
        severity: "info",
        meta: { task_id: task.id, url },
      });
    } else {
      events.push({
        source: "PUBLISH-VERIFY",
        message: `LIVE CHECK FAILED (${detail}): ${task.title} — pushed back to in_progress`,
        severity: "alert",
        meta: { task_id: task.id, url, detail },
      });
      await db.from("tasks").update({ status: "in_progress" }).eq("id", task.id);
    }
  }
  return events;
}

/** 5 — Board hygiene: in_progress > 72h with zero session activity. */
export async function checkBoardHygiene(deps: CheckDeps): Promise<EventInsert[]> {
  const { db } = deps;
  const now = deps.now ?? new Date();
  const idleH = envNum("BOARD_IDLE_HOURS", 72);
  const cutoff = new Date(now.getTime() - idleH * HOURS).toISOString();

  const { data: staleTasks, error } = await db
    .from("tasks")
    .select("*")
    .eq("status", "in_progress")
    .lte("updated_at", cutoff);
  if (error) throw new Error(`board hygiene query failed: ${error.message}`);
  if (!staleTasks || staleTasks.length === 0) return [];

  const { data: recentWarns } = await db
    .from("heartbeat_events")
    .select("meta")
    .eq("source", "BOARD-HYGIENE")
    .gte("ts", new Date(now.getTime() - 24 * HOURS).toISOString());
  const warned = new Set(
    (recentWarns ?? []).map((e) => (e.meta as Record<string, unknown>)?.task_id).filter(Boolean),
  );

  const events: EventInsert[] = [];
  for (const task of staleTasks) {
    if (warned.has(task.id)) continue;
    const { data: sessions } = await db
      .from("agent_sessions")
      .select("id")
      .eq("task_id", task.id)
      .gte("started_at", cutoff)
      .limit(1);
    if (sessions && sessions.length > 0) continue;
    const idleHours = Math.round((now.getTime() - new Date(task.updated_at).getTime()) / HOURS);
    events.push({
      source: "BOARD-HYGIENE",
      message: `stale in_progress ${idleHours}h with no session activity: ${task.title}`,
      severity: "warn",
      meta: { task_id: task.id, idle_hours: idleHours },
    });
  }
  return events;
}
