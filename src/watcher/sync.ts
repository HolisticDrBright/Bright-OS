import matter from "gray-matter";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TaskRow, TaskStatus } from "@/types/db";
import { canTransition, checkShippedGate, checkVerifiedGate } from "@/lib/transitions";

/**
 * Obsidian ⇄ tasks two-way sync core (no filesystem in here — the watcher
 * loop feeds file contents/mtimes in, making all of this unit-testable).
 *
 * Sync marker: tasks.frontmatter.brightos_synced_at (DB-side, so writing it
 * never touches file mtimes). Last-write-wins on conflict + conflict log.
 */

export const EPSILON_MS = 3000;

const STATUS_ALIASES: Record<string, TaskStatus> = {
  backlog: "backlog",
  todo: "backlog",
  inbox: "backlog",
  assigned: "assigned",
  next: "assigned",
  in_progress: "in_progress",
  "in-progress": "in_progress",
  doing: "in_progress",
  active: "in_progress",
  awaiting_approval: "awaiting_approval",
  "awaiting-approval": "awaiting_approval",
  review: "awaiting_approval",
  approval: "awaiting_approval",
  verified: "verified",
  done: "verified",
  shipped: "shipped",
  published: "shipped",
  live: "shipped",
  failed: "failed",
  blocked: "failed",
};

export function normalizeStatus(raw: unknown): TaskStatus | null {
  if (typeof raw !== "string") return null;
  return STATUS_ALIASES[raw.trim().toLowerCase().replace(/\s+/g, "_")] ?? null;
}

export interface ParsedNote {
  title: string;
  status: TaskStatus | null;
  owner: string | null;
  brand: string | null;
  due: string | null;
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseTaskNote(content: string, relPath: string): ParsedNote {
  const { data, content: body } = matter(content);
  const fm = data as Record<string, unknown>;
  const fileTitle = relPath.split("/").pop()?.replace(/\.md$/i, "") ?? relPath;
  const rawDue = fm.due ?? fm.due_at ?? null;
  // YAML turns bare dates (due: 2026-07-07) into Date objects
  const due = rawDue instanceof Date ? rawDue.toISOString().slice(0, 10) : rawDue;
  return {
    title: typeof fm.title === "string" && fm.title.trim() ? fm.title.trim() : fileTitle,
    status: normalizeStatus(fm.status),
    owner: typeof fm.owner === "string" ? fm.owner.trim() : null,
    brand: typeof fm.brand === "string" ? fm.brand.trim() : null,
    due: due ? String(due) : null,
    frontmatter: fm,
    body,
  };
}

/** Rewrites only the managed frontmatter keys; the note body is sacred. */
export function renderNoteWriteback(
  existingContent: string | null,
  task: TaskRow,
  names: { agentName?: string | null; brandName?: string | null },
): string {
  const parsed = existingContent ? matter(existingContent) : { data: {}, content: `\n# ${task.title}\n` };
  const fm = { ...(parsed.data as Record<string, unknown>) };
  fm.title = task.title;
  fm.status = task.status;
  if (names.agentName) fm.owner = names.agentName;
  else if (names.agentName === null) delete fm.owner;
  if (names.brandName) fm.brand = names.brandName;
  else if (names.brandName === null) delete fm.brand;
  if (task.due_at) fm.due = String(task.due_at).slice(0, 10);
  fm.brightos_id = task.id;
  return matter.stringify(parsed.content, fm);
}

export type SyncOutcome =
  | { kind: "created"; taskId: string }
  | { kind: "db_updated"; taskId: string; fields: string[] }
  | { kind: "file_stale"; taskId: string } // DB is newer → caller writes the file
  | { kind: "conflict"; taskId: string; winner: "file" | "db"; detail: string }
  | { kind: "rejected"; taskId: string; reason: string } // illegal transition/gate
  | { kind: "noop"; taskId: string | null };

/**
 * File-side sync: a task note changed on disk (or was discovered).
 * Applies frontmatter → task with the SAME transition matrix + gates the
 * API enforces (vault edits are the human, so the human matrix applies).
 */
export async function syncNoteToDb(
  db: SupabaseClient,
  input: { relPath: string; content: string; mtime: Date; now?: Date },
): Promise<SyncOutcome> {
  const now = input.now ?? new Date();
  const note = parseTaskNote(input.content, input.relPath);

  const { data: existing } = await db
    .from("tasks")
    .select("*")
    .eq("obsidian_path", input.relPath)
    .maybeSingle();

  const [agentId, brandId] = await Promise.all([
    resolveByName(db, "agents", note.owner),
    resolveByName(db, "brands", note.brand),
  ]);

  if (!existing) {
    const { data: created, error } = await db
      .from("tasks")
      .insert({
        title: note.title,
        status: note.status && !["verified", "shipped"].includes(note.status) ? note.status : "backlog",
        agent_id: agentId,
        brand_id: brandId,
        due_at: note.due ? toIso(note.due) : null,
        source: "obsidian",
        obsidian_path: input.relPath,
        frontmatter: { ...note.frontmatter, brightos_synced_at: now.toISOString() },
      })
      .select()
      .single();
    if (error) return { kind: "rejected", taskId: "", reason: error.message };
    return { kind: "created", taskId: created.id };
  }

  const task = existing as TaskRow;
  const syncedAt = new Date(String(task.frontmatter?.brightos_synced_at ?? 0)).getTime() || 0;
  const fileChanged = input.mtime.getTime() > syncedAt + EPSILON_MS;
  const dbChanged = new Date(task.updated_at).getTime() > syncedAt + EPSILON_MS;

  if (!fileChanged && !dbChanged) return { kind: "noop", taskId: task.id };

  let conflict: { winner: "file" | "db"; detail: string } | null = null;
  if (fileChanged && dbChanged) {
    const winner = input.mtime.getTime() >= new Date(task.updated_at).getTime() ? "file" : "db";
    conflict = {
      winner,
      detail: `both sides changed since last sync (file ${input.mtime.toISOString()} vs db ${task.updated_at}) — ${winner} wins`,
    };
    await db.from("heartbeat_events").insert({
      source: "SYNC-CONFLICT",
      message: `obsidian conflict on ${input.relPath}: ${conflict.detail}`,
      severity: "warn",
      meta: { task_id: task.id, path: input.relPath, winner },
    });
  }

  if ((fileChanged && !dbChanged) || conflict?.winner === "file") {
    const patch: Record<string, unknown> = {};
    if (note.title && note.title !== task.title) patch.title = note.title;
    if (agentId !== undefined && agentId !== task.agent_id && note.owner) patch.agent_id = agentId;
    if (brandId !== undefined && brandId !== task.brand_id && note.brand) patch.brand_id = brandId;
    const due = note.due ? toIso(note.due) : null;
    if (due !== (task.due_at ? new Date(task.due_at).toISOString() : null)) patch.due_at = due;

    if (note.status && note.status !== task.status) {
      const legal = canTransition(task.status, note.status, "human");
      if (!legal.ok) return { kind: "rejected", taskId: task.id, reason: legal.reason };
      if (note.status === "verified") {
        const gate = await checkVerifiedGate(db, task.id);
        if (!gate.ok) return { kind: "rejected", taskId: task.id, reason: gate.reason };
      }
      if (note.status === "shipped") {
        const gate = await checkShippedGate(db, task.id);
        if (!gate.ok) return { kind: "rejected", taskId: task.id, reason: gate.reason };
      }
      patch.status = note.status;
    }

    patch.frontmatter = {
      ...task.frontmatter,
      ...note.frontmatter,
      brightos_synced_at: now.toISOString(),
    };
    const { error } = await db.from("tasks").update(patch).eq("id", task.id);
    if (error) return { kind: "rejected", taskId: task.id, reason: error.message };
    if (conflict) return { kind: "conflict", taskId: task.id, ...conflict };
    return {
      kind: "db_updated",
      taskId: task.id,
      fields: Object.keys(patch).filter((k) => k !== "frontmatter"),
    };
  }

  // DB is newer → tell the caller to rewrite the file
  if (conflict) return { kind: "conflict", taskId: task.id, ...conflict };
  return { kind: "file_stale", taskId: task.id };
}

/** Marks a DB-side write-back completed (bumps the sync marker). */
export async function markSynced(db: SupabaseClient, task: TaskRow, now = new Date()): Promise<void> {
  await db
    .from("tasks")
    .update({ frontmatter: { ...task.frontmatter, brightos_synced_at: now.toISOString() } })
    .eq("id", task.id);
}

async function resolveByName(
  db: SupabaseClient,
  table: "agents" | "brands",
  name: string | null,
): Promise<string | null> {
  if (!name) return null;
  const { data } = await db.from(table).select("id,name");
  const needle = name.toLowerCase();
  return (
    (data ?? []).find((r) => r.name.toLowerCase() === needle)?.id ??
    (data ?? []).find((r) => r.name.toLowerCase().includes(needle))?.id ??
    null
  );
}

function toIso(due: string): string | null {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(due) ? new Date(`${due}T12:00:00Z`) : new Date(due);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
