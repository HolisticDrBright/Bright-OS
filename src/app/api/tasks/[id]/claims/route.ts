import type { NextRequest } from "next/server";
import { z } from "zod";
import { getActor } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { apiError, json, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const actor = await getActor(req);
  if (!actor) return apiError(401, "unauthorized");
  const { id } = await ctx.params;
  const db = createAdminClient();
  const { data, error } = await db
    .from("claims")
    .select("*")
    .eq("task_id", id)
    .order("created_at", { ascending: true });
  if (error) return apiError(500, error.message);
  return json({ claims: data });
}

const createSchema = z.object({
  claim_text: z.string().min(1),
  source_url: z.string().nullable().optional(),
  agent_id: z.string().nullable().optional(),
});

/**
 * POST /api/tasks/:id/claims — claims are ALWAYS created unverified.
 * A claim with no source_url is stored flagged (verified=false) and can
 * never be verified until a source_url is attached.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const actor = await getActor(req);
  if (!actor) return apiError(401, "unauthorized");
  const { id } = await ctx.params;
  const body = await readJson(req);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return apiError(400, "invalid body", { issues: parsed.error.issues });
  const db = createAdminClient();

  const { data: task } = await db.from("tasks").select("id").eq("id", id).maybeSingle();
  if (!task) return apiError(404, "task not found");

  const { data, error } = await db
    .from("claims")
    .insert({
      task_id: id,
      claim_text: parsed.data.claim_text,
      source_url: parsed.data.source_url ?? null,
      agent_id: parsed.data.agent_id ?? null,
      verified: false,
    })
    .select()
    .single();
  if (error) return apiError(500, error.message);
  return json({ claim: data, flagged: !data.source_url }, 201);
}
