import type { SupabaseClient } from "@supabase/supabase-js";
import { client, logOsSession } from "@/lib/claude/client";
import { computeCostUsd } from "@/lib/claude/pricing";
import { env } from "@/lib/env";

/**
 * WORKING MEMORY — the brain's conversation continuity, per surface
 * (web / voice / telegram). A rolling haiku-compressed summary plus the last
 * few exchanges verbatim, persisted in Supabase so it recovers across
 * restarts and redeploys. Loaded into the dynamic system block every turn.
 */

export interface WorkingMemory {
  summary_md: string;
  recent: { at: string; you: string; os: string }[];
}

const MAX_RECENT = 8; // exchanges kept verbatim
const KEEP_ON_COMPRESS = 4; // exchanges kept after folding the rest into the summary
const COMPRESS_OVER_CHARS = 3600;
const SUMMARY_MAX_CHARS = 1600;

const COMPRESS_PROMPT =
  "You maintain BRIGHT OS's running conversation summary. Merge the CURRENT SUMMARY and the OLDER EXCHANGES into one updated summary, max 120 words. Keep: decisions and their reasons, operator preferences/corrections, open threads and commitments, names and concrete facts. Drop: pleasantries, resolved back-and-forth, stale numbers. Write terse prose lines. Reply with ONLY the summary.";

export async function loadWorkingMemory(db: SupabaseClient, surface: string): Promise<WorkingMemory | null> {
  const { data } = await db
    .from("working_memory")
    .select("summary_md,recent")
    .eq("surface", surface)
    .maybeSingle();
  if (!data) return null;
  return {
    summary_md: typeof data.summary_md === "string" ? data.summary_md : "",
    recent: Array.isArray(data.recent) ? data.recent : [],
  };
}

/** Render for the dynamic system block; "" when there's nothing yet. */
export function renderWorkingMemory(wm: WorkingMemory | null): string {
  if (!wm || (!wm.summary_md.trim() && wm.recent.length === 0)) return "";
  const lines: string[] = [
    "WORKING MEMORY (this conversation so far — persists across sessions; trust it as real context):",
  ];
  if (wm.summary_md.trim()) lines.push(wm.summary_md.trim());
  if (wm.recent.length > 0) {
    lines.push(
      "Recent exchanges:",
      ...wm.recent.map((r) => `OPERATOR: ${r.you}\nBRIGHT OS: ${r.os}`),
    );
  }
  return lines.join("\n");
}

/**
 * Append this turn; when the buffer grows past the cap, fold the oldest
 * exchanges into the summary with one cheap haiku call (logged like every
 * other Claude call). Callers fire-and-forget — memory upkeep must never
 * block or break a reply.
 */
export async function updateWorkingMemory(
  db: SupabaseClient,
  surface: string,
  operatorText: string,
  reply: string,
): Promise<void> {
  const started = Date.now();
  const wm = (await loadWorkingMemory(db, surface)) ?? { summary_md: "", recent: [] };
  wm.recent.push({
    at: new Date().toISOString(),
    you: operatorText.slice(0, 280),
    os: reply.slice(0, 420),
  });

  const size = wm.summary_md.length + JSON.stringify(wm.recent).length;
  if (wm.recent.length > MAX_RECENT || size > COMPRESS_OVER_CHARS) {
    const older = wm.recent.slice(0, -KEEP_ON_COMPRESS);
    wm.recent = wm.recent.slice(-KEEP_ON_COMPRESS);
    const response = await client().messages.create({
      model: env.classifyModel,
      max_tokens: 300,
      system: COMPRESS_PROMPT,
      messages: [
        {
          role: "user",
          content: `CURRENT SUMMARY:\n${wm.summary_md || "(none)"}\n\nOLDER EXCHANGES:\n${older
            .map((r) => `OPERATOR: ${r.you}\nBRIGHT OS: ${r.os}`)
            .join("\n")}`,
        },
      ],
    });
    const text = response.content
      .filter((b): b is Extract<(typeof response.content)[number], { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) wm.summary_md = text.slice(0, SUMMARY_MAX_CHARS);
    await logOsSession(
      db,
      env.classifyModel,
      response.usage,
      computeCostUsd(env.classifyModel, response.usage),
      (Date.now() - started) / 1000,
    );
  }

  await db.from("working_memory").upsert(
    {
      surface,
      summary_md: wm.summary_md,
      recent: wm.recent,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "surface" },
  );
}
