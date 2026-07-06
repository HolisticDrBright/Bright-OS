import type { SupabaseClient } from "@supabase/supabase-js";
import type { DecisionRow, DecisionVia } from "@/types/db";

export type DecideAction = "approved" | "rejected" | "discuss";

export function normalizeAction(raw: string): DecideAction | null {
  const a = raw.trim().toLowerCase();
  if (["approve", "approved", "yes", "✅"].includes(a)) return "approved";
  if (["reject", "rejected", "no", "❌"].includes(a)) return "rejected";
  if (["discuss", "💬"].includes(a)) return "discuss";
  return null;
}

export interface DecideResult {
  ok: boolean;
  status: number;
  decision?: DecisionRow;
  error?: string;
}

/**
 * The single choke-point for deciding a decision. Callers are responsible
 * for HUMAN authentication (web session or the allow-listed Telegram chat)
 * — agents are never allowed here, that is the hard rule.
 */
export async function decideDecision(
  db: SupabaseClient,
  opts: { id: string; action: DecideAction; via: DecisionVia },
): Promise<DecideResult> {
  const { data: decision, error } = await db
    .from("decisions")
    .select("*")
    .eq("id", opts.id)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!decision) return { ok: false, status: 404, error: "decision not found" };
  if (decision.status !== "pending" && decision.status !== "discuss") {
    return { ok: false, status: 409, error: `decision already ${decision.status}` };
  }

  const patch: Partial<DecisionRow> = {
    status: opts.action,
    decided_via: opts.via,
    decided_at: opts.action === "discuss" ? null : new Date().toISOString(),
  };
  const { data: updated, error: upErr } = await db
    .from("decisions")
    .update(patch)
    .eq("id", opts.id)
    .select()
    .single();
  if (upErr) return { ok: false, status: 500, error: upErr.message };

  // Rejected work goes back to the bench.
  if (opts.action === "rejected" && updated.task_id) {
    await db
      .from("tasks")
      .update({ status: "in_progress" })
      .eq("id", updated.task_id)
      .eq("status", "awaiting_approval");
  }

  await db.from("heartbeat_events").insert({
    source: "DECISION",
    message: `${opts.action.toUpperCase()} via ${opts.via}: ${updated.title}`,
    severity: "info",
    meta: { decision_id: updated.id, action: opts.action, via: opts.via },
  });

  return { ok: true, status: 200, decision: updated };
}

/** Pending decisions with age computed from created_at, oldest first. */
export async function listPendingWithAge(db: SupabaseClient) {
  const { data, error } = await db
    .from("decisions")
    .select("*")
    .in("status", ["pending", "discuss"])
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  const now = Date.now();
  return (data ?? []).map((d) => ({
    ...d,
    age_hours: Math.max(0, (now - new Date(d.created_at).getTime()) / 36e5),
  }));
}
