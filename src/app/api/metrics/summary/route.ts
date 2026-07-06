import type { NextRequest } from "next/server";
import { getActor } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { apiError, json } from "@/lib/http";
import { buildMetricsSummary } from "@/lib/metrics";
import { checkCostBreaker } from "@/lib/guardrails";

export const dynamic = "force-dynamic";

/**
 * GET /api/metrics/summary — burn today, 30-day cost heatmap, token burn by
 * model, weekly quality, per-brand cost-per-outcome, verification lane,
 * revenue engines, circuit-breaker state.
 */
export async function GET(req: NextRequest) {
  const actor = await getActor(req);
  if (!actor) return apiError(401, "unauthorized");
  const db = createAdminClient();
  try {
    const [summary, breaker] = await Promise.all([buildMetricsSummary(db), checkCostBreaker(db)]);
    return json({ ...summary, cost_breaker: breaker });
  } catch (e) {
    return apiError(500, e instanceof Error ? e.message : "metrics failed");
  }
}
