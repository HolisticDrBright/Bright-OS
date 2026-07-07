import type { AgentRow, BrandRow, HeartbeatEventRow } from "@/types/db";
import type { DecisionJoined, MemoryData, TaskWithRels } from "./data";
import type { MetricsSummary } from "@/lib/metrics";
import { AGENT_STATUS, C, agentGlyph, ageColor, heatCells, type StatusStyle } from "./theme";

/** Raw rows → the exact shapes the HUD panels render. */

export interface FleetAgent extends AgentRow {
  glyph: string;
  st: StatusStyle;
  currentTask: string;
  costToday: number;
  done: number;
  failed: number;
  memories: number | null;
}

export function deriveFleet(
  agents: AgentRow[],
  tasks: TaskWithRels[],
  metrics: MetricsSummary | null,
  memory: MemoryData | null,
): FleetAgent[] {
  return agents.map((a) => {
    const mine = tasks.filter((t) => t.agent_id === a.id);
    const active =
      mine.find((t) => t.status === "in_progress") ??
      mine.find((t) => t.status === "awaiting_approval") ??
      mine.find((t) => t.status === "assigned");

    let key = a.status?.toLowerCase() ?? "idle";
    if (!(key in AGENT_STATUS)) {
      key = mine.some((t) => t.status === "awaiting_approval")
        ? "approval"
        : mine.some((t) => t.status === "in_progress")
          ? "working"
          : "idle";
    } else if (key === "idle" && mine.some((t) => t.status === "awaiting_approval")) {
      key = "approval";
    }

    const heatRow = metrics?.cost_heatmap_30d.find((r) => r.agent_id === a.id);
    const costToday = heatRow?.days.at(-1)?.cost_usd ?? 0;

    return {
      ...a,
      glyph: agentGlyph(a.name, a.kind),
      st: AGENT_STATUS[key] ?? AGENT_STATUS.idle,
      currentTask:
        active?.title ??
        (a.kind === "human" ? "Off-shift" : mine.length ? "Queue clear — standing by" : "No tasks assigned"),
      costToday,
      done: mine.filter((t) => ["verified", "shipped"].includes(t.status)).length,
      failed: mine.filter((t) => t.status === "failed").length,
      memories: a.kind === "hermes" && memory ? memory.log.length + memory.promotions.length : null,
    };
  });
}

export interface DecisionVM extends DecisionJoined {
  agentGlyph: string;
  agentColor: string;
  agentName: string;
  brandLabel: string;
  ageColorV: string;
  ageLabel: string;
  previewLines: string[];
  medical: boolean;
}

export function deriveDecisions(decisions: DecisionJoined[], agents: AgentRow[]): DecisionVM[] {
  const sorted = [...decisions].sort((a, b) => b.age_hours - a.age_hours);
  return sorted.map((d) => {
    const agent = agents.find((a) => a.id === d.requesting_agent_id);
    return {
      ...d,
      agentGlyph: agent ? agentGlyph(agent.name, agent.kind) : "??",
      agentColor: C.cyan,
      agentName: agent?.name ?? d.agents?.name ?? "UNKNOWN",
      brandLabel: (d.brands?.name ?? "OS").toUpperCase(),
      ageColorV: ageColor(d.age_hours),
      ageLabel: `${Math.round(d.age_hours)}H OLD`,
      previewLines: (d.preview_md ?? "").split("\n").filter((l) => l.length > 0),
      medical: (d.tags ?? []).includes("medical-regulatory"),
    };
  });
}

export function tickerText(events: HeartbeatEventRow[]): string {
  if (events.length === 0) return "HEARTBEAT ONLINE — waiting for first events   ◇   ";
  return `${events
    .slice(0, 14)
    .map((e) => `${e.source}: ${e.message}`)
    .join("   ◇   ")}   ◇   `;
}

export function eventColor(e: HeartbeatEventRow): string {
  if (e.severity === "alert") return C.red;
  if (e.severity === "warn") return C.gold;
  return C.cyan;
}

export interface PodVM {
  name: string;
  color: string;
  ring: string;
  spark: string[];
}

function nameSeed(name: string): number {
  return [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 23;
}

export function derivePods(brands: BrandRow[]): PodVM[] {
  return brands.slice(0, 5).map((b) => {
    const rev = Number(b.revenue_wtd ?? 0);
    const spend = Number(b.spend_wtd ?? 0);
    const health =
      b.tier === "engine" ? (rev > spend && rev > 0 ? 92 : rev > 0 ? 74 : 61) : 60 + nameSeed(b.name);
    const color = health >= 80 ? C.green : health >= 65 ? C.arc : C.gold;
    return {
      name: b.name.toUpperCase().replace("BRIGHT FAMILY ", "").slice(0, 13),
      color,
      ring: `conic-gradient(${color} 0 ${health}%, rgba(255,255,255,.1) ${health}% 100%)`,
      spark: heatCells(nameSeed(b.name) + 20, 8, 1).map((v) => `${Math.round(3 + v * 7)}px`),
    };
  });
}

export interface EngineVM {
  name: string;
  in: string;
  out: string;
  pct: string;
}

export function deriveEngines(brands: BrandRow[]): EngineVM[] {
  return brands
    .filter((b) => b.tier === "engine")
    .map((b) => {
      const rev = Number(b.revenue_wtd ?? 0);
      const spend = Number(b.spend_wtd ?? 0);
      return {
        name: b.name.toUpperCase(),
        in: `$${rev.toLocaleString()}`,
        out: `$${spend.toLocaleString()}`,
        pct: `${rev > 0 ? Math.min(99, Math.round(((rev - spend) / rev) * 100)) : 0}%`,
      };
    });
}

/** Consecutive-day log streak ending at the newest entry. */
export function logStreak(memory: MemoryData | null): number {
  if (!memory || memory.log.length === 0) return 0;
  const days = [...new Set(memory.log.map((l) => l.day))].sort().reverse();
  let streak = 1;
  for (let i = 1; i < days.length; i++) {
    const prev = new Date(days[i - 1]);
    const cur = new Date(days[i]);
    if (prev.getTime() - cur.getTime() <= 864e5 * 1.5) streak += 1;
    else break;
  }
  return streak;
}

export const AGENT_SKILLS: Record<string, string[]> = {
  CX: ["claim-verification", "board-hygiene", "diff-review", "regression-checks", "p&l-reconciliation"],
  CW: ["long-form-drafting", "funnel-analysis", "GSC-analysis", "email-sequences", "pricing-models"],
  OC: ["deploys", "GHL-automation", "publishing", "webhooks", "DNS/infra", "scraping"],
  HM: ["session-indexing", "full-text-search", "literature-research", "daily-log-promotion", "x-search"],
  VA: ["inbox-triage", "patient-scheduling", "fax-queue", "insurance-callbacks"],
};
