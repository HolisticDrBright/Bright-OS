import type { NextRequest } from "next/server";
import { z } from "zod";
import { getActor } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { apiError, json, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/tasks?agent=openclaw&status=assigned&brand=QCL&limit=100
 * `agent` matches agent id, kind, or (case-insensitive) name fragment —
 * OpenClaw pulls its queue with ?agent=openclaw&status=assigned.
 */
export async function GET(req: NextRequest) {
  const actor = await getActor(req);
  if (!actor) return apiError(401, "unauthorized");
  const db = createAdminClient();
  const url = new URL(req.url);
  const agent = url.searchParams.get("agent");
  const status = url.searchParams.get("status");
  const brand = url.searchParams.get("brand");
  const source = url.searchParams.get("source");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 500);

  let query = db
    .from("tasks")
    .select("*, claims(*), decisions(id,title,status,created_at)")
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (status) {
    const statuses = status.split(",").map((s) => s.trim());
    query = statuses.length > 1 ? query.in("status", statuses) : query.eq("status", statuses[0]);
  }
  if (source) query = query.eq("source", source);

  if (agent) {
    const ids = await resolveAgentIds(db, agent);
    if (ids.length === 0) return json({ tasks: [] });
    query = query.in("agent_id", ids);
  }
  if (brand) {
    const { data: brands } = await db.from("brands").select("id").ilike("name", `%${brand}%`);
    const ids = (brands ?? []).map((b) => b.id);
    if (ids.length === 0) return json({ tasks: [] });
    query = query.in("brand_id", ids);
  }

  const { data, error } = await query;
  if (error) return apiError(500, error.message);
  return json({ tasks: data });
}

async function resolveAgentIds(db: ReturnType<typeof createAdminClient>, term: string): Promise<string[]> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(term)) return [term];
  const { data } = await db.from("agents").select("id,name,kind");
  return (data ?? [])
    .filter(
      (a) =>
        a.kind === term.toLowerCase() ||
        a.name.toLowerCase().includes(term.toLowerCase()),
    )
    .map((a) => a.id);
}

const createSchema = z.object({
  title: z.string().min(1),
  brand_id: z.string().nullable().optional(),
  brand: z.string().optional(), // resolve by name
  agent_id: z.string().nullable().optional(),
  agent: z.string().optional(), // resolve by name/kind
  status: z
    .enum(["backlog", "assigned", "in_progress", "awaiting_approval", "verified", "shipped", "failed"])
    .optional(),
  due_at: z.string().nullable().optional(),
  source: z.enum(["chat", "heartbeat", "cron", "obsidian"]).optional(),
  obsidian_path: z.string().nullable().optional(),
  frontmatter: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(req: NextRequest) {
  const actor = await getActor(req);
  if (!actor) return apiError(401, "unauthorized");
  const body = await readJson(req);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return apiError(400, "invalid body", { issues: parsed.error.issues });
  const db = createAdminClient();
  const input = parsed.data;

  // New tasks enter at backlog/assigned; nobody spawns work directly into
  // verified/shipped and skips the gates.
  const status = input.status ?? "backlog";
  if (["verified", "shipped"].includes(status)) {
    return apiError(422, "tasks cannot be created directly as verified/shipped");
  }

  let brandId = input.brand_id ?? null;
  if (!brandId && input.brand) {
    const { data } = await db.from("brands").select("id").ilike("name", `%${input.brand}%`).limit(1);
    brandId = data?.[0]?.id ?? null;
  }
  let agentId = input.agent_id ?? null;
  if (!agentId && input.agent) {
    const ids = await resolveAgentIds(db, input.agent);
    agentId = ids[0] ?? null;
  }

  const { data, error } = await db
    .from("tasks")
    .insert({
      title: input.title,
      brand_id: brandId,
      agent_id: agentId,
      status: agentId && status === "backlog" ? "assigned" : status,
      due_at: input.due_at ?? null,
      source: input.source ?? "chat",
      obsidian_path: input.obsidian_path ?? null,
      frontmatter: input.frontmatter ?? {},
    })
    .select()
    .single();
  if (error) return apiError(500, error.message);
  return json({ task: data }, 201);
}
