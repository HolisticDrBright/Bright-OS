import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => import("../helpers/admin-mock"));
vi.mock("@/lib/auth", () => import("../helpers/auth-mock"));

import { GET } from "@/app/api/metrics/summary/route";
import { aggregateMetrics } from "@/lib/metrics";
import { HUMAN, authState, byTable, createMockDb, dbHolder, makeReq, uuid } from "../helpers/harness";
import type { AgentSessionRow } from "@/types/db";

const AGENT_A = uuid(10);
const AGENT_B = uuid(11);
const BRAND_ALP = uuid(20);
const TASK_1 = uuid(1);

function session(over: Partial<AgentSessionRow>): AgentSessionRow {
  return {
    id: uuid(99),
    agent_id: AGENT_A,
    task_id: null,
    model: "claude-sonnet-5",
    input_tokens: 1000,
    output_tokens: 500,
    cost_usd: 1,
    duration_s: 10,
    quality_score: null,
    started_at: new Date().toISOString(),
    ...over,
  };
}

describe("aggregateMetrics (pure)", () => {
  const now = new Date("2026-07-06T20:00:00Z");

  it("computes burn today, model split, heatmap totals and cost/outcome", () => {
    const sessions = [
      session({ cost_usd: 2.5, started_at: "2026-07-06T15:00:00Z", task_id: TASK_1 }), // today (LA)
      session({ cost_usd: 4, started_at: "2026-07-01T15:00:00Z", model: "claude-haiku-4-5" }),
      session({ cost_usd: 1, started_at: "2026-06-15T15:00:00Z", agent_id: AGENT_B, quality_score: 88 }),
    ];
    const out = aggregateMetrics({
      sessions30d: sessions,
      agents: [
        { id: AGENT_A, name: "COWORK" },
        { id: AGENT_B, name: "CODEX" },
      ],
      brands: [
        {
          name: "AI Longevity Pro",
          tier: "engine",
          revenue_wtd: 2140,
          spend_wtd: 960,
          metrics: { outcome_label: "lead" },
        },
      ],
      doneTasks7d: [
        { id: TASK_1, status: "shipped" },
        { id: uuid(2), status: "awaiting_approval" },
      ],
      outcomeTasks30d: [{ id: TASK_1, status: "shipped", brand_id: BRAND_ALP }],
      brandIdToName: { [BRAND_ALP]: "AI Longevity Pro" },
      unverifiedClaims: 3,
      now,
      timeZone: "America/Los_Angeles",
      capUsd: 60,
    });

    expect(out.burn_today_usd).toBe(2.5);
    expect(out.total_30d_usd).toBe(7.5);
    expect(out.daily_cap_usd).toBe(60);

    const sonnet = out.by_model_30d.find((m) => m.model === "claude-sonnet-5");
    expect(sonnet?.cost_usd).toBe(3.5);

    const cowork = out.cost_heatmap_30d.find((r) => r.agent_name === "COWORK");
    expect(cowork?.total_usd).toBe(6.5);
    expect(cowork?.days).toHaveLength(30);

    const alp = out.cost_per_outcome.find((c) => c.brand === "AI Longevity Pro");
    expect(alp?.outcome_label).toBe("lead");
    expect(alp?.outcomes_30d).toBe(1);
    expect(alp?.cost_per_outcome_usd).toBe(2.5);

    expect(out.verification_lane).toEqual({ reported_done: 2, verified: 1, unverified_claims: 3 });
    expect(out.revenue_engines[0]).toEqual({ name: "AI Longevity Pro", revenue_wtd: 2140, spend_wtd: 960 });
    expect(out.quality_weekly).toHaveLength(8);
  });

  it("handles the empty database without dividing by zero", () => {
    const out = aggregateMetrics({
      sessions30d: [],
      agents: [],
      brands: [],
      doneTasks7d: [],
      outcomeTasks30d: [],
      brandIdToName: {},
      unverifiedClaims: 0,
      now,
      timeZone: "America/Los_Angeles",
      capUsd: 60,
    });
    expect(out.burn_today_usd).toBe(0);
    expect(out.cost_per_outcome).toEqual([]);
  });
});

describe("GET /api/metrics/summary", () => {
  it("requires auth", async () => {
    dbHolder.db = createMockDb();
    const res = await GET(makeReq("http://os/api/metrics/summary"));
    expect(res.status).toBe(401);
  });

  it("returns the summary with circuit-breaker state", async () => {
    authState.actor = HUMAN;
    dbHolder.db = createMockDb(
      byTable({
        agent_sessions: () => ({ data: [session({ cost_usd: 5 })] }),
        agents: () => ({ data: [{ id: AGENT_A, name: "COWORK" }] }),
        brands: (op) =>
          op.columns?.includes("id")
            ? { data: [{ id: BRAND_ALP, name: "AI Longevity Pro" }] }
            : {
                data: [
                  { name: "AI Longevity Pro", tier: "engine", revenue_wtd: 0, spend_wtd: 0, metrics: {} },
                ],
              },
        tasks: () => ({ data: [] }),
        claims: () => ({ count: 0 }),
      }),
    );
    const res = await GET(makeReq("http://os/api/metrics/summary"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cost_breaker.capUsd).toBe(60);
    expect(body.cost_breaker.tripped).toBe(false);
    expect(body.burn_today_usd).toBeGreaterThanOrEqual(0);
  });
});
