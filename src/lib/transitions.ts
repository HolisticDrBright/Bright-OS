import type { SupabaseClient } from "@supabase/supabase-js";
import type { TaskStatus } from "@/types/db";

/**
 * Task status state machine. The API layer enforces this with readable
 * errors; DB triggers back-stop the two non-negotiable gates.
 */
export const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  backlog: ["assigned", "failed"],
  assigned: ["in_progress", "backlog", "failed"],
  in_progress: ["awaiting_approval", "verified", "assigned", "failed"],
  awaiting_approval: ["in_progress", "verified", "failed"],
  verified: ["shipped", "in_progress", "failed"],
  shipped: ["in_progress"], // publish verification failures push work back
  failed: ["backlog", "assigned", "in_progress"],
};

/** Transitions an agent token may perform. Humans get the full matrix. */
export const AGENT_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  backlog: [],
  assigned: ["in_progress"],
  in_progress: ["awaiting_approval", "verified", "failed"],
  awaiting_approval: ["in_progress"],
  verified: ["shipped"],
  shipped: [],
  failed: ["in_progress"],
};

export function canTransition(
  from: TaskStatus,
  to: TaskStatus,
  actorType: "human" | "agent",
): { ok: true } | { ok: false; reason: string } {
  const matrix = actorType === "agent" ? AGENT_TRANSITIONS : TRANSITIONS;
  if (from === to) return { ok: true };
  if (!matrix[from]?.includes(to)) {
    return {
      ok: false,
      reason: `illegal transition ${from} → ${to}${actorType === "agent" ? " for an agent" : ""}`,
    };
  }
  return { ok: true };
}

/**
 * Gate: a task may only become `verified` when every claim on it is
 * verified (or it has no claims). Claims without source_url can never be
 * verified, so hallucinated work cannot reach the verified column.
 */
export async function checkVerifiedGate(
  db: SupabaseClient,
  taskId: string,
): Promise<{ ok: true } | { ok: false; reason: string; unverified: number }> {
  const { count, error } = await db
    .from("claims")
    .select("id", { count: "exact", head: true })
    .eq("task_id", taskId)
    .eq("verified", false);
  if (error) return { ok: false, reason: `claims lookup failed: ${error.message}`, unverified: -1 };
  if ((count ?? 0) > 0) {
    return {
      ok: false,
      reason: `task has ${count} unverified claim(s) — verify them (each needs a source_url) first`,
      unverified: count ?? 0,
    };
  }
  return { ok: true };
}

/**
 * Gate: publish/ship requires an approved decision on the task —
 * enforced here at the API layer (and again by a DB trigger).
 */
export async function checkShippedGate(
  db: SupabaseClient,
  taskId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { count, error } = await db
    .from("decisions")
    .select("id", { count: "exact", head: true })
    .eq("task_id", taskId)
    .eq("status", "approved");
  if (error) return { ok: false, reason: `decision lookup failed: ${error.message}` };
  if ((count ?? 0) === 0) {
    return { ok: false, reason: "publish requires an approved decision on this task" };
  }
  return { ok: true };
}
