import type { NextRequest } from "next/server";
import { z } from "zod";
import { getActor } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { apiError, json, readJson } from "@/lib/http";
import { canTransition, checkShippedGate, checkVerifiedGate } from "@/lib/transitions";
import type { TaskStatus } from "@/types/db";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const actor = await getActor(req);
  if (!actor) return apiError(401, "unauthorized");
  const { id } = await ctx.params;
  const db = createAdminClient();
  const { data, error } = await db
    .from("tasks")
    .select("*, claims(*), decisions(*)")
    .eq("id", id)
    .maybeSingle();
  if (error) return apiError(500, error.message);
  if (!data) return apiError(404, "task not found");
  return json({ task: data });
}

const patchSchema = z.object({
  title: z.string().min(1).optional(),
  brand_id: z.string().nullable().optional(),
  agent_id: z.string().nullable().optional(),
  status: z
    .enum(["backlog", "assigned", "in_progress", "awaiting_approval", "verified", "shipped", "failed"])
    .optional(),
  due_at: z.string().nullable().optional(),
  obsidian_path: z.string().nullable().optional(),
  frontmatter: z.record(z.string(), z.unknown()).optional(),
});

/**
 * PATCH /api/tasks/:id — field updates + guarded status transitions.
 *  - transition legality depends on the actor (agents get a narrow matrix)
 *  - → verified requires every claim verified (or no claims)
 *  - → shipped requires an approved decision (publish guardrail)
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const actor = await getActor(req);
  if (!actor) return apiError(401, "unauthorized");
  const { id } = await ctx.params;
  const body = await readJson(req);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return apiError(400, "invalid body", { issues: parsed.error.issues });
  const patch = parsed.data;
  const db = createAdminClient();

  const { data: task, error } = await db.from("tasks").select("*").eq("id", id).maybeSingle();
  if (error) return apiError(500, error.message);
  if (!task) return apiError(404, "task not found");

  if (patch.status && patch.status !== task.status) {
    const from = task.status as TaskStatus;
    const to = patch.status as TaskStatus;
    const legal = canTransition(from, to, actor.type);
    if (!legal.ok) return apiError(422, legal.reason);

    if (to === "verified") {
      const gate = await checkVerifiedGate(db, id);
      if (!gate.ok) return apiError(422, gate.reason);
    }
    if (to === "shipped") {
      const gate = await checkShippedGate(db, id);
      if (!gate.ok) return apiError(422, gate.reason);
    }
  }

  const { data: updated, error: upErr } = await db
    .from("tasks")
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  if (upErr) {
    // DB triggers back-stop the gates; surface them as 422, not 500.
    return upErr.message.includes("GUARDRAIL") ? apiError(422, upErr.message) : apiError(500, upErr.message);
  }

  if (patch.status && patch.status !== task.status && ["shipped", "failed"].includes(patch.status)) {
    await db.from("heartbeat_events").insert({
      source: actor.type === "agent" ? actor.agentName.toUpperCase() : "BOARD",
      message: `task ${patch.status}: ${updated.title}`,
      severity: patch.status === "failed" ? "warn" : "info",
      meta: { task_id: id, from: task.status, to: patch.status },
    });
  }

  return json({ task: updated });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  // Guardrail: no destructive ops from agents.
  const actor = await getActor(req);
  if (!actor) return apiError(401, "unauthorized");
  if (actor.type !== "human") return apiError(403, "agents cannot delete tasks");
  const { id } = await ctx.params;
  const db = createAdminClient();
  const { error } = await db.from("tasks").delete().eq("id", id);
  if (error) return apiError(500, error.message);
  return json({ deleted: true });
}
