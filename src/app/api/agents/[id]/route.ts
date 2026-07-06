import type { NextRequest } from "next/server";
import { z } from "zod";
import { getActor, getHumanActor } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { apiError, json, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const actor = await getActor(req);
  if (!actor) return apiError(401, "unauthorized");
  const { id } = await ctx.params;
  const db = createAdminClient();
  const [{ data: agent, error }, sessions] = await Promise.all([
    db.from("agents").select("*").eq("id", id).maybeSingle(),
    db
      .from("agent_sessions")
      .select("*")
      .eq("agent_id", id)
      .order("started_at", { ascending: false })
      .limit(20),
  ]);
  if (error) return apiError(500, error.message);
  if (!agent) return apiError(404, "agent not found");
  return json({ agent, recent_sessions: sessions.data ?? [] });
}

const humanPatch = z.object({
  name: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  kind: z.enum(["claude", "openclaw", "hermes", "human"]).optional(),
  status: z.string().optional(),
  endpoint_url: z.string().nullable().optional(),
});

// Agents may only report their own status ("working", "idle", "blocked"…).
const agentPatch = z.object({ status: z.string().min(1) }).strict();

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const actor = await getActor(req);
  if (!actor) return apiError(401, "unauthorized");
  const { id } = await ctx.params;
  const body = await readJson(req);
  const schema = actor.type === "human" ? humanPatch : agentPatch;
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return apiError(actor.type === "agent" ? 403 : 400, "invalid body (agents may only update status)", {
      issues: parsed.error.issues,
    });
  }
  const db = createAdminClient();
  const { data, error } = await db.from("agents").update(parsed.data).eq("id", id).select().maybeSingle();
  if (error) return apiError(500, error.message);
  if (!data) return apiError(404, "agent not found");
  return json({ agent: data });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  // Guardrail: destructive ops are human-only, never agents.
  const actor = await getHumanActor();
  if (!actor) return apiError(401, "unauthorized (human session required)");
  const { id } = await ctx.params;
  const db = createAdminClient();
  const { error } = await db.from("agents").delete().eq("id", id);
  if (error) return apiError(500, error.message);
  return json({ deleted: true });
}
