import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import chokidar from "chokidar";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { renderNoteWriteback, syncNoteToDb } from "./sync";
import { syncBoardNote } from "@/workers/board-sync";
import type { TaskRow } from "@/types/db";

/**
 * OBSIDIAN BRIDGE — a small Node service (compose service `watcher`).
 *  (a) watches {vault}/{Tasks}/*.md, parses YAML frontmatter
 *      (status/owner/due/brand) and syncs into the tasks table
 *  (b) writes back: task notes for DB-side changes, plus the DB-rendered
 *      "Active Command Board.md" so the board can never go stale
 * Two-way with last-write-wins; conflicts logged to heartbeat_events and
 * {vault}/.brightos/conflict-log.jsonl. The vault dir is OneDrive-synced —
 * we poll-watch to survive network filesystems.
 */

const db = createAdminClient();

function vaultTasksDir(): string {
  return path.join(env.obsidianVaultPath, env.obsidianTasksDir);
}

async function logConflict(entry: Record<string, unknown>): Promise<void> {
  const logDir = path.join(env.obsidianVaultPath, ".brightos");
  await fs.mkdir(logDir, { recursive: true });
  await fs.appendFile(
    path.join(logDir, "conflict-log.jsonl"),
    `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
    "utf8",
  );
}

async function writeTaskFile(task: TaskRow): Promise<void> {
  if (!task.obsidian_path) return;
  const full = path.join(env.obsidianVaultPath, task.obsidian_path);
  const existing = await fs.readFile(full, "utf8").catch(() => null);
  const [agents, brands] = await Promise.all([
    db.from("agents").select("id,name"),
    db.from("brands").select("id,name"),
  ]);
  const agentName = agents.data?.find((a) => a.id === task.agent_id)?.name ?? null;
  const brandName = brands.data?.find((b) => b.id === task.brand_id)?.name ?? null;
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, renderNoteWriteback(existing, task, { agentName, brandName }), "utf8");
}

async function handleFile(fullPath: string): Promise<void> {
  const relPath = path.relative(env.obsidianVaultPath, fullPath).split(path.sep).join("/");
  try {
    const [content, stat] = await Promise.all([fs.readFile(fullPath, "utf8"), fs.stat(fullPath)]);
    const outcome = await syncNoteToDb(db, { relPath, content, mtime: stat.mtime });
    switch (outcome.kind) {
      case "created":
        console.log(`[watcher] + task from note: ${relPath}`);
        break;
      case "db_updated":
        console.log(`[watcher] note → db (${outcome.fields.join(",")}): ${relPath}`);
        break;
      case "file_stale": {
        const { data: task } = await db.from("tasks").select("*").eq("id", outcome.taskId).maybeSingle();
        if (task) {
          await writeTaskFile(task as TaskRow);
          await db
            .from("tasks")
            .update({
              frontmatter: { ...(task as TaskRow).frontmatter, brightos_synced_at: new Date().toISOString() },
            })
            .eq("id", task.id);
          console.log(`[watcher] db → note: ${relPath}`);
        }
        break;
      }
      case "conflict":
        await logConflict({ path: relPath, ...outcome });
        console.warn(`[watcher] CONFLICT (${outcome.winner} wins): ${relPath}`);
        if (outcome.winner === "db") {
          const { data: task } = await db.from("tasks").select("*").eq("id", outcome.taskId).maybeSingle();
          if (task) await writeTaskFile(task as TaskRow);
        }
        break;
      case "rejected":
        await db.from("heartbeat_events").insert({
          source: "OBSIDIAN",
          message: `note change rejected (${outcome.reason}): ${relPath} — file rewritten from DB`,
          severity: "warn",
          meta: { path: relPath, task_id: outcome.taskId },
        });
        if (outcome.taskId) {
          const { data: task } = await db.from("tasks").select("*").eq("id", outcome.taskId).maybeSingle();
          if (task) await writeTaskFile(task as TaskRow); // board never lies
        }
        break;
      case "noop":
        break;
    }
  } catch (e) {
    console.error(`[watcher] failed on ${relPath}:`, e);
  }
}

/** DB → vault sweep: notes for tasks changed since the last sweep. */
let lastSweep = new Date(Date.now() - 5 * 60_000).toISOString();
async function sweepDbChanges(): Promise<void> {
  const since = lastSweep;
  lastSweep = new Date().toISOString();
  const { data: tasks } = await db
    .from("tasks")
    .select("*")
    .gte("updated_at", since)
    .not("obsidian_path", "is", null);
  for (const task of (tasks ?? []) as TaskRow[]) {
    const syncedAt = new Date(String(task.frontmatter?.brightos_synced_at ?? 0)).getTime() || 0;
    if (new Date(task.updated_at).getTime() <= syncedAt + 3000) continue; // already synced
    await writeTaskFile(task);
    await db
      .from("tasks")
      .update({ frontmatter: { ...task.frontmatter, brightos_synced_at: new Date().toISOString() } })
      .eq("id", task.id);
    console.log(`[watcher] db → note (sweep): ${task.obsidian_path}`);
  }
  await syncBoardNote(db).catch((e) => console.error("[watcher] board sync failed:", e));
}

async function main() {
  if (!env.obsidianVaultPath) {
    console.error("OBSIDIAN_VAULT_PATH not set — watcher has nothing to do.");
    process.exit(1);
  }
  await fs.mkdir(vaultTasksDir(), { recursive: true });
  console.log(`[watcher] watching ${vaultTasksDir()} (OneDrive-synced vault)`);

  const watcher = chokidar.watch(vaultTasksDir(), {
    ignoreInitial: false,
    usePolling: true, // OneDrive/network mounts don't deliver inotify reliably
    interval: 2000,
    awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 300 },
  });
  watcher.on("add", (p) => void handleFile(String(p)));
  watcher.on("change", (p) => void handleFile(String(p)));
  watcher.on("unlink", async (p) => {
    const relPath = path.relative(env.obsidianVaultPath, String(p)).split(path.sep).join("/");
    // GUARDRAIL: a vanished note never deletes work — flag it instead.
    const { data: task } = await db.from("tasks").select("*").eq("obsidian_path", relPath).maybeSingle();
    if (task) {
      await db
        .from("tasks")
        .update({ frontmatter: { ...(task as TaskRow).frontmatter, obsidian_deleted: true } })
        .eq("id", task.id);
      await db.from("heartbeat_events").insert({
        source: "OBSIDIAN",
        message: `task note deleted from vault (task kept): ${relPath}`,
        severity: "warn",
        meta: { task_id: task.id, path: relPath },
      });
    }
  });

  setInterval(() => void sweepDbChanges(), 60_000);
  await sweepDbChanges();
}

main();
