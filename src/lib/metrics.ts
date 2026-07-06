import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentRow, AgentSessionRow, BrandRow, TaskRow } from "@/types/db";
import { env } from "@/lib/env";
import { startOfTodayIso } from "@/lib/guardrails";

export interface MetricsSummary {
  burn_today_usd: number;
  daily_cap_usd: number;
  total_30d_usd: number;
  by_model_30d: { model: string; cost_usd: number; pct: number }[];
  cost_heatmap_30d: {
    agent_id: string;
    agent_name: string;
    days: { day: string; cost_usd: number }[];
    total_usd: number;
  }[];
  quality_weekly: { week: string; avg_score: number | null }[];
  cost_per_outcome: {
    brand: string;
    outcome_label: string;
    outcomes_30d: number;
    cost_usd_30d: number;
    cost_per_outcome_usd: number | null;
  }[];
  verification_lane: { reported_done: number; verified: number; unverified_claims: number };
  revenue_engines: { name: string; revenue_wtd: number; spend_wtd: number }[];
}

function dayKey(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 864e5 + 1) / 7);
  return `W${String(week).padStart(2, "0")}`;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Pure aggregation — unit-tested without a database. */
export function aggregateMetrics(input: {
  sessions30d: AgentSessionRow[];
  agents: Pick<AgentRow, "id" | "name">[];
  brands: Pick<BrandRow, "name" | "tier" | "revenue_wtd" | "spend_wtd" | "metrics">[];
  doneTasks7d: Pick<TaskRow, "id" | "status">[];
  outcomeTasks30d: Pick<TaskRow, "id" | "status" | "brand_id">[];
  brandIdToName: Record<string, string>;
  unverifiedClaims: number;
  now?: Date;
  timeZone?: string;
  capUsd?: number;
}): MetricsSummary {
  const now = input.now ?? new Date();
  const tz = input.timeZone ?? env.timezone;
  const cap = input.capUsd ?? env.dailyCostCapUsd;
  const todayKey = dayKey(now.toISOString(), tz);

  let burnToday = 0;
  let total30 = 0;
  const byModel = new Map<string, number>();
  const byAgentDay = new Map<string, Map<string, number>>();
  const byWeekQuality = new Map<string, { sum: number; n: number }>();

  for (const s of input.sessions30d) {
    const cost = Number(s.cost_usd ?? 0);
    total30 += cost;
    const k = dayKey(s.started_at, tz);
    if (k === todayKey) burnToday += cost;
    const model = s.model ?? "unknown";
    byModel.set(model, (byModel.get(model) ?? 0) + cost);
    if (s.agent_id) {
      const m = byAgentDay.get(s.agent_id) ?? new Map<string, number>();
      m.set(k, (m.get(k) ?? 0) + cost);
      byAgentDay.set(s.agent_id, m);
    }
    if (s.quality_score != null) {
      const wk = isoWeek(new Date(s.started_at));
      const q = byWeekQuality.get(wk) ?? { sum: 0, n: 0 };
      q.sum += Number(s.quality_score);
      q.n += 1;
      byWeekQuality.set(wk, q);
    }
  }

  // 30 day columns, oldest → newest
  const days: string[] = [];
  for (let i = 29; i >= 0; i--) {
    days.push(dayKey(new Date(now.getTime() - i * 864e5).toISOString(), tz));
  }

  const heatmap = input.agents.map((a) => {
    const m = byAgentDay.get(a.id) ?? new Map<string, number>();
    const rows = days.map((day) => ({ day, cost_usd: round2(m.get(day) ?? 0) }));
    return {
      agent_id: a.id,
      agent_name: a.name,
      days: rows,
      total_usd: round2(rows.reduce((acc, r) => acc + r.cost_usd, 0)),
    };
  });

  // last 8 ISO weeks
  const weeks: string[] = [];
  for (let i = 7; i >= 0; i--) {
    weeks.push(isoWeek(new Date(now.getTime() - i * 7 * 864e5)));
  }
  const quality = weeks.map((week) => {
    const q = byWeekQuality.get(week);
    return { week, avg_score: q ? Math.round((q.sum / q.n) * 10) / 10 : null };
  });

  // cost per outcome by brand: 30d spend attributed via task→brand
  const outcomesByBrand = new Map<string, number>();
  for (const t of input.outcomeTasks30d) {
    if (!t.brand_id) continue;
    if (t.status === "verified" || t.status === "shipped") {
      outcomesByBrand.set(t.brand_id, (outcomesByBrand.get(t.brand_id) ?? 0) + 1);
    }
  }
  const spendByBrand = new Map<string, number>();
  const taskBrand = new Map(input.outcomeTasks30d.map((t) => [t.id, t.brand_id]));
  for (const s of input.sessions30d) {
    const brandId = s.task_id ? taskBrand.get(s.task_id) : null;
    if (brandId) spendByBrand.set(brandId, (spendByBrand.get(brandId) ?? 0) + Number(s.cost_usd ?? 0));
  }
  const costPerOutcome = [...new Set([...outcomesByBrand.keys(), ...spendByBrand.keys()])]
    .map((brandId) => {
      const name = input.brandIdToName[brandId] ?? brandId;
      const brand = input.brands.find((b) => b.name === name);
      const label = String((brand?.metrics as Record<string, unknown>)?.outcome_label ?? "shipped task");
      const outcomes = outcomesByBrand.get(brandId) ?? 0;
      const cost = round2(spendByBrand.get(brandId) ?? 0);
      return {
        brand: name,
        outcome_label: label,
        outcomes_30d: outcomes,
        cost_usd_30d: cost,
        cost_per_outcome_usd: outcomes > 0 ? round2(cost / outcomes) : null,
      };
    })
    .sort((a, b) => b.cost_usd_30d - a.cost_usd_30d);

  const reportedDone = input.doneTasks7d.filter((t) =>
    ["awaiting_approval", "verified", "shipped"].includes(t.status),
  ).length;
  const verifiedCount = input.doneTasks7d.filter((t) => ["verified", "shipped"].includes(t.status)).length;

  const totalModel = [...byModel.values()].reduce((a, b) => a + b, 0) || 1;

  return {
    burn_today_usd: round2(burnToday),
    daily_cap_usd: cap,
    total_30d_usd: round2(total30),
    by_model_30d: [...byModel.entries()]
      .map(([model, cost]) => ({
        model,
        cost_usd: round2(cost),
        pct: Math.round((cost / totalModel) * 100),
      }))
      .sort((a, b) => b.cost_usd - a.cost_usd),
    cost_heatmap_30d: heatmap,
    quality_weekly: quality,
    cost_per_outcome: costPerOutcome,
    verification_lane: {
      reported_done: reportedDone,
      verified: verifiedCount,
      unverified_claims: input.unverifiedClaims,
    },
    revenue_engines: input.brands
      .filter((b) => b.tier === "engine")
      .map((b) => ({
        name: b.name,
        revenue_wtd: Number(b.revenue_wtd ?? 0),
        spend_wtd: Number(b.spend_wtd ?? 0),
      })),
  };
}

/** Fetches raw rows and aggregates. */
export async function buildMetricsSummary(db: SupabaseClient, now = new Date()): Promise<MetricsSummary> {
  const d30 = new Date(now.getTime() - 30 * 864e5).toISOString();
  const d7 = new Date(now.getTime() - 7 * 864e5).toISOString();

  const [sessions, agents, brands, done7, tasks30, claims] = await Promise.all([
    db.from("agent_sessions").select("*").gte("started_at", d30),
    db.from("agents").select("id,name"),
    db.from("brands").select("name,tier,revenue_wtd,spend_wtd,metrics"),
    db.from("tasks").select("id,status").gte("updated_at", d7),
    db.from("tasks").select("id,status,brand_id").gte("updated_at", d30),
    db.from("claims").select("id", { count: "exact", head: true }).eq("verified", false),
  ]);
  for (const r of [sessions, agents, brands, done7, tasks30]) {
    if (r.error) throw new Error(`metrics query failed: ${r.error.message}`);
  }

  const brandRows = (brands.data ?? []) as BrandRow[];
  const { data: brandIds } = await db.from("brands").select("id,name");
  const brandIdToName = Object.fromEntries((brandIds ?? []).map((b) => [b.id, b.name]));

  return aggregateMetrics({
    sessions30d: (sessions.data ?? []) as AgentSessionRow[],
    agents: (agents.data ?? []) as AgentRow[],
    brands: brandRows,
    doneTasks7d: (done7.data ?? []) as TaskRow[],
    outcomeTasks30d: (tasks30.data ?? []) as TaskRow[],
    brandIdToName,
    unverifiedClaims: claims.count ?? 0,
    now,
  });
}
