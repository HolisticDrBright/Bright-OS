import type { NextRequest } from "next/server";
import { z } from "zod";
import { getActor, getHumanActor } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { apiError, json, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const actor = await getActor(req);
  if (!actor) return apiError(401, "unauthorized");
  const db = createAdminClient();
  const { data, error } = await db.from("brands").select("*").order("tier").order("name");
  if (error) return apiError(500, error.message);
  return json({ brands: data });
}

const patchSchema = z.object({
  id: z.string(),
  revenue_wtd: z.number().optional(),
  spend_wtd: z.number().optional(),
  tier: z.enum(["engine", "cron_only"]).optional(),
  metrics: z.record(z.string(), z.unknown()).optional(),
});

/** PATCH /api/brands — update WTD numbers/metrics (human or agent reporters). */
export async function PATCH(req: NextRequest) {
  const actor = await getActor(req);
  if (!actor) return apiError(401, "unauthorized");
  const body = await readJson(req);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return apiError(400, "invalid body", { issues: parsed.error.issues });
  const { id, ...patch } = parsed.data;
  if (patch.tier && actor.type !== "human") return apiError(403, "agents cannot change brand tiers");
  const db = createAdminClient();
  const { data, error } = await db.from("brands").update(patch).eq("id", id).select().maybeSingle();
  if (error) return apiError(500, error.message);
  if (!data) return apiError(404, "brand not found");
  return json({ brand: data });
}

const createSchema = z.object({
  name: z.string().min(1),
  tier: z.enum(["engine", "cron_only"]).optional(),
  metrics: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(req: NextRequest) {
  const actor = await getHumanActor();
  if (!actor) return apiError(401, "unauthorized (human session required)");
  const body = await readJson(req);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return apiError(400, "invalid body", { issues: parsed.error.issues });
  const db = createAdminClient();
  const { data, error } = await db.from("brands").insert(parsed.data).select().single();
  if (error) return apiError(500, error.message);
  return json({ brand: data }, 201);
}
