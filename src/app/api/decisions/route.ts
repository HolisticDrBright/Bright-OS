import type { NextRequest } from "next/server";
import { z } from "zod";
import { getActor } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { apiError, json, readJson } from "@/lib/http";
import { autoTagDecision } from "@/lib/guardrails";
import { sendDecisionMessage } from "@/lib/telegram/send";

export const dynamic = "force-dynamic";

/** GET /api/decisions?status=pending — age_hours computed from created_at. */
export async function GET(req: NextRequest) {
  const actor = await getActor(req);
  if (!actor) return apiError(401, "unauthorized");
  const db = createAdminClient();
  const url = new URL(req.url);
  const status = url.searchParams.get("status");

  let query = db
    .from("decisions")
    .select("*, agents:requesting_agent_id(id,name,kind), brands:brand_id(id,name)")
    .order("created_at", { ascending: true })
    .limit(200);
  if (status) {
    const list = status.split(",").map((s) => s.trim());
    query = list.length > 1 ? query.in("status", list) : query.eq("status", list[0]);
  }
  const { data, error } = await query;
  if (error) return apiError(500, error.message);
  const now = Date.now();
  const decisions = (data ?? []).map((d) => ({
    ...d,
    age_hours: Math.max(0, (now - new Date(d.created_at).getTime()) / 36e5),
  }));
  return json({ decisions });
}

const createSchema = z.object({
  title: z.string().min(1),
  task_id: z.string().nullable().optional(),
  requesting_agent_id: z.string().nullable().optional(),
  requesting_agent: z.string().optional(),
  brand_id: z.string().nullable().optional(),
  brand: z.string().optional(),
  impact_note: z.string().nullable().optional(),
  impact_dollars_estimate: z.number().nullable().optional(),
  preview_md: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
});

/**
 * POST /api/decisions — agents and the human both create decision requests.
 * Every new decision is auto-tagged (medical/regulatory detection) and
 * pushed to Telegram with approval buttons.
 */
export async function POST(req: NextRequest) {
  const actor = await getActor(req);
  if (!actor) return apiError(401, "unauthorized");
  const body = await readJson(req);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return apiError(400, "invalid body", { issues: parsed.error.issues });
  const input = parsed.data;
  const db = createAdminClient();

  let agentId = input.requesting_agent_id ?? null;
  if (!agentId && (input.requesting_agent || actor.type === "agent")) {
    const term = input.requesting_agent ?? (actor.type === "agent" ? actor.agentName : "");
    if (term) {
      const { data } = await db.from("agents").select("id,name,kind");
      agentId =
        (data ?? []).find(
          (a) => a.kind === term.toLowerCase() || a.name.toLowerCase().includes(term.toLowerCase()),
        )?.id ?? null;
    }
  }
  let brandId = input.brand_id ?? null;
  if (!brandId && input.brand) {
    const { data } = await db.from("brands").select("id").ilike("name", `%${input.brand}%`).limit(1);
    brandId = data?.[0]?.id ?? null;
  }

  const tags = autoTagDecision(input);

  const { data: decision, error } = await db
    .from("decisions")
    .insert({
      title: input.title,
      task_id: input.task_id ?? null,
      requesting_agent_id: agentId,
      brand_id: brandId,
      impact_note: input.impact_note ?? null,
      impact_dollars_estimate: input.impact_dollars_estimate ?? null,
      preview_md: input.preview_md ?? null,
      tags,
      status: "pending",
    })
    .select()
    .single();
  if (error) return apiError(500, error.message);

  // Task with a pending publish decision is awaiting approval.
  if (decision.task_id) {
    await db
      .from("tasks")
      .update({ status: "awaiting_approval" })
      .eq("id", decision.task_id)
      .in("status", ["assigned", "in_progress"]);
  }

  await db.from("heartbeat_events").insert({
    source: "DECISION",
    message: `new decision pending: ${decision.title}`,
    severity: "info",
    meta: { decision_id: decision.id },
  });

  // Mobile approval surface — never let a Telegram hiccup fail the request.
  sendDecisionMessage(decision, {}).catch(() => {});

  return json({ decision }, 201);
}
