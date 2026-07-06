import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

const execAsync = promisify(exec);

/**
 * NIGHTLY BACKUP — pg_dump (custom format, compressed) → Supabase Storage
 * `backups` bucket. Weekly (Sunday) the latest dump is also copied off-site
 * via rclone when OFFSITE_RCLONE_REMOTE is configured.
 *
 * Guardrail context: agents get no destructive DB access; this is the
 * recovery path if something slips through anyway.
 */
export async function runNightlyBackup(
  db: SupabaseClient,
  opts?: { now?: Date; execImpl?: typeof execAsync },
): Promise<{ objectPath: string; bytes: number }> {
  const run = opts?.execImpl ?? execAsync;
  const now = opts?.now ?? new Date();
  if (!env.supabaseDbUrl) throw new Error("SUPABASE_DB_URL not configured — cannot pg_dump");

  const day = now.toISOString().slice(0, 10);
  await fs.mkdir(env.backupDir, { recursive: true });
  const file = path.join(env.backupDir, `brightos-${day}.dump`);

  await run(`pg_dump --no-owner --no-privileges --format=custom --file=${JSON.stringify(file)} "$DB_URL"`, {
    env: { ...process.env, DB_URL: env.supabaseDbUrl },
    maxBuffer: 64 * 1024 * 1024,
  });

  const buf = await fs.readFile(file);
  const objectPath = `nightly/brightos-${day}.dump`;
  const { error } = await db.storage.from("backups").upload(objectPath, buf, {
    upsert: true,
    contentType: "application/octet-stream",
  });
  if (error) throw new Error(`backup upload failed: ${error.message}`);

  await db.from("heartbeat_events").insert({
    source: "BACKUP",
    message: `nightly pg_dump uploaded (${(buf.length / 1024 / 1024).toFixed(1)} MB)`,
    severity: "info",
    meta: { object: objectPath, bytes: buf.length },
  });

  // keep the local staging dir small
  const old = (await fs.readdir(env.backupDir)).filter((f) => f.endsWith(".dump")).sort();
  for (const f of old.slice(0, Math.max(0, old.length - 7))) {
    await fs.unlink(path.join(env.backupDir, f)).catch(() => {});
  }

  return { objectPath, bytes: buf.length };
}

/** Weekly off-site copy: rclone when configured, else a bucket-side copy. */
export async function runWeeklyOffsite(
  db: SupabaseClient,
  opts?: { now?: Date; execImpl?: typeof execAsync },
): Promise<{ offsite: string }> {
  const run = opts?.execImpl ?? execAsync;
  const now = opts?.now ?? new Date();
  const day = now.toISOString().slice(0, 10);
  const localFile = path.join(env.backupDir, `brightos-${day}.dump`);

  let offsite: string;
  if (env.offsiteRcloneRemote) {
    await run(
      `rclone copyto ${JSON.stringify(localFile)} ${JSON.stringify(`${env.offsiteRcloneRemote}/brightos-${day}.dump`)}`,
      { maxBuffer: 16 * 1024 * 1024 },
    );
    offsite = `${env.offsiteRcloneRemote}/brightos-${day}.dump`;
  } else {
    const buf = await fs.readFile(localFile);
    const objectPath = `offsite-weekly/brightos-${day}.dump`;
    const { error } = await db.storage.from("backups").upload(objectPath, buf, { upsert: true });
    if (error) throw new Error(`offsite copy failed: ${error.message}`);
    offsite = `storage://backups/${objectPath}`;
  }

  await db.from("heartbeat_events").insert({
    source: "BACKUP",
    message: `weekly off-site copy → ${offsite}`,
    severity: "info",
    meta: { offsite },
  });
  return { offsite };
}
