/**
 * MC V2 IMPORT (one-shot, idempotent) — pulls tasks/costs/documents from the
 * old Mission Control V2 Supabase project and maps them into BRIGHT OS.
 *
 *   MCV2_SUPABASE_URL=... MCV2_SUPABASE_SERVICE_KEY=... npm run import:mcv2
 *   npm run import:mcv2 -- --dry-run    # print what would happen
 *
 * Idempotency: every imported row gets a deterministic UUIDv5 derived from
 * its legacy id, and inserts are upserts on id. Re-running converges.
 * Legacy ids are also kept in frontmatter/meta for tracing.
 */
import "dotenv/config";
import crypto from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const NAMESPACE = "b7a9b1de-0000-4000-8000-brightosv2mc".replace(/[^0-9a-f-]/g, "0");

export function uuidv5FromLegacy(kind: string, legacyId: string): string {
  const hash = crypto.createHash("sha1").update(`${NAMESPACE}:${kind}:${legacyId}`).digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const STATUS_MAP: Record<string, string> = {
  backlog: "backlog",
  todo: "backlog",
  assigned: "assigned",
  in_progress: "in_progress",
  doing: "in_progress",
  review: "awaiting_approval",
  awaiting_approval: "awaiting_approval",
  done: "verified",
  verified: "verified",
  shipped: "shipped",
  published: "shipped",
  failed: "failed",
  cancelled: "failed",
};

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env: ${name}`);
    process.exit(1);
  }
  return v;
}

async function fetchAll(db: SupabaseClient, table: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await db.from(table).select("*").range(from, from + page - 1);
    if (error) {
      console.warn(`  (skipping ${table}: ${error.message})`);
      return out;
    }
    out.push(...(data ?? []));
    if (!data || data.length < page) return out;
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const oldDb = createClient(need("MCV2_SUPABASE_URL"), need("MCV2_SUPABASE_SERVICE_KEY"), {
    auth: { persistSession: false },
  });
  const newDb = createClient(need("NEXT_PUBLIC_SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });

  const { data: agents } = await newDb.from("agents").select("id,name,kind");
  const { data: brands } = await newDb.from("brands").select("id,name");
  const agentByHint = (hint: unknown): string | null => {
    if (typeof hint !== "string" || !hint) return null;
    const h = hint.toLowerCase();
    return (
      (agents ?? []).find((a) => a.name.toLowerCase().includes(h) || a.kind === h)?.id ?? null
    );
  };
  const brandByHint = (hint: unknown): string | null => {
    if (typeof hint !== "string" || !hint) return null;
    const h = hint.toLowerCase();
    return (brands ?? []).find((b) => b.name.toLowerCase().includes(h))?.id ?? null;
  };

  // ---------- tasks ----------
  console.log("▸ importing MC V2 tasks…");
  const oldTasks = await fetchAll(oldDb, "tasks");
  const taskRows = oldTasks.map((t) => {
    const legacyId = String(t.id);
    return {
      id: uuidv5FromLegacy("task", legacyId),
      title: String(t.title ?? t.name ?? `MCV2 task ${legacyId}`),
      status: STATUS_MAP[String(t.status ?? "").toLowerCase()] ?? "backlog",
      agent_id: agentByHint(t.agent ?? t.agent_name ?? t.assignee),
      brand_id: brandByHint(t.brand ?? t.brand_name ?? t.project),
      due_at: t.due_at ?? t.due_date ?? null,
      source: "chat" as const,
      frontmatter: { mcv2_id: legacyId, mcv2: true, notes: t.description ?? t.notes ?? undefined },
      created_at: t.created_at ?? undefined,
    };
  });
  console.log(`  ${taskRows.length} tasks`);
  if (!dryRun && taskRows.length) {
    const { error } = await newDb.from("tasks").upsert(taskRows, { onConflict: "id" });
    if (error) throw new Error(`task upsert failed: ${error.message}`);
  }

  // ---------- costs / sessions ----------
  console.log("▸ importing MC V2 costs…");
  const oldCosts = [...(await fetchAll(oldDb, "agent_sessions")), ...(await fetchAll(oldDb, "costs"))];
  const sessionRows = oldCosts.map((c) => {
    const legacyId = String(c.id);
    return {
      id: uuidv5FromLegacy("session", legacyId),
      agent_id: agentByHint(c.agent ?? c.agent_name),
      task_id: c.task_id ? uuidv5FromLegacy("task", String(c.task_id)) : null,
      model: (c.model as string) ?? null,
      input_tokens: Number(c.input_tokens ?? 0),
      output_tokens: Number(c.output_tokens ?? 0),
      cost_usd: Number(c.cost_usd ?? c.cost ?? c.amount_usd ?? 0),
      duration_s: c.duration_s != null ? Number(c.duration_s) : null,
      quality_score: c.quality_score != null ? Number(c.quality_score) : null,
      started_at: (c.started_at ?? c.created_at ?? new Date().toISOString()) as string,
    };
  });
  console.log(`  ${sessionRows.length} sessions/costs`);
  if (!dryRun && sessionRows.length) {
    const { error } = await newDb.from("agent_sessions").upsert(sessionRows, { onConflict: "id" });
    if (error) throw new Error(`session upsert failed: ${error.message}`);
  }

  // ---------- documents → memory_log ----------
  console.log("▸ importing MC V2 documents…");
  const oldDocs = [...(await fetchAll(oldDb, "documents")), ...(await fetchAll(oldDb, "notes"))];
  let docCount = 0;
  for (const d of oldDocs) {
    const content = String(d.content ?? d.body ?? d.markdown ?? "");
    if (!content.trim()) continue;
    const day = String(d.day ?? d.created_at ?? new Date().toISOString()).slice(0, 10);
    docCount += 1;
    if (dryRun) continue;
    const { data: existing } = await newDb.from("memory_log").select("*").eq("day", day).maybeSingle();
    const tagged = `<!-- mcv2:${d.id} -->\n${content}`;
    if (existing?.content_md?.includes(`mcv2:${d.id}`)) continue; // idempotent
    const merged = existing?.content_md ? `${existing.content_md.trimEnd()}\n\n${tagged}` : tagged;
    const { error } = await newDb.from("memory_log").upsert({ day, content_md: merged }, { onConflict: "day" });
    if (error) throw new Error(`memory_log upsert failed: ${error.message}`);
  }
  console.log(`  ${docCount} documents → memory_log`);

  if (!dryRun) {
    await newDb.from("heartbeat_events").insert({
      source: "IMPORT",
      message: `MC V2 import: ${taskRows.length} tasks, ${sessionRows.length} sessions, ${docCount} documents`,
      severity: "info",
      meta: { tasks: taskRows.length, sessions: sessionRows.length, documents: docCount },
    });
  }
  console.log(dryRun ? "Dry run complete — nothing written." : "Import complete (re-run safe).");
}

// Allow tests to import uuidv5FromLegacy without running the import.
if (process.argv[1]?.includes("import-mcv2")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
