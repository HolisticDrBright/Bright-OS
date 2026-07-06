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
  const { data, error } = await db.from("agents").select("*").order("created_at", { ascending: true });
  if (error) return apiError(500, error.message);
  return json({ agents: data });
}

const createSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  kind: z.enum(["claude", "openclaw", "hermes", "human"]),
  status: z.string().optional(),
  endpoint_url: z.string().nullable().optional(),
});

export async function POST(req: NextRequest) {
  // Fleet changes are a human call — agents cannot add agents.
  const actor = await getHumanActor();
  if (!actor) return apiError(401, "unauthorized (human session required)");
  const body = await readJson(req);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return apiError(400, "invalid body", { issues: parsed.error.issues });
  const db = createAdminClient();
  const { data, error } = await db.from("agents").insert(parsed.data).select().single();
  if (error) return apiError(500, error.message);
  return json({ agent: data }, 201);
}
