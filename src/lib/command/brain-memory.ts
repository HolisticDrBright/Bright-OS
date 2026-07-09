import type { SupabaseClient } from "@supabase/supabase-js";
import { client, logOsSession } from "@/lib/claude/client";
import { computeCostUsd } from "@/lib/claude/pricing";
import { embedText } from "@/lib/embeddings";
import { env } from "@/lib/env";
import { vaultConfigured, writeVaultDoc } from "@/lib/obsidian";
import { VAULT_BRAIN_DIR } from "./brain-files";

/**
 * TYPED LONG-TERM MEMORY — file-backed in spirit, Supabase in practice:
 * typed rows (fact/preference/decision/person/project/lesson/context) with
 * pgvector semantic recall, written by the brain's own `remember` tool AND an
 * automatic end-of-turn extractor, deduplicated before saving, and mirrored
 * into the Obsidian vault as a human-readable Memory Digest.
 */

export const MEMORY_KINDS = [
  "fact",
  "preference",
  "decision",
  "person",
  "project",
  "lesson",
  "context",
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface MemoryRow {
  id: string;
  kind: string;
  content: string;
  importance: number;
}

const DEDUPE_SIMILARITY = 0.9; // cosine similarity above this = same memory
const RECALL_MIN_SIMILARITY = 0.25;

function normalizeKind(kind: unknown): MemoryKind {
  const k = String(kind ?? "").toLowerCase();
  return (MEMORY_KINDS as readonly string[]).includes(k) ? (k as MemoryKind) : "fact";
}

function clampImportance(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(5, Math.max(1, v)) : 3;
}

export type RememberResult =
  | { stored: true; id: string }
  | { stored: false; dedupedAgainst?: string; reason?: string };

/**
 * Save one memory with dedupe: semantic (cosine ≥ 0.9 against the nearest
 * neighbour) when embeddings are available, exact-content otherwise. A dupe
 * bumps the existing row's importance instead of inserting a twin.
 */
export async function rememberMemory(
  db: SupabaseClient,
  input: { kind: unknown; content: unknown; importance?: unknown },
  source = "chat",
): Promise<RememberResult> {
  const content = String(input.content ?? "").trim();
  if (!content) return { stored: false, reason: "empty content" };
  const kind = normalizeKind(input.kind);
  const importance = clampImportance(input.importance ?? 3);

  const embedding = await embedText(content);
  if (embedding) {
    const { data } = await db.rpc("match_memories", {
      query_embedding: embedding,
      match_count: 1,
    });
    const top = Array.isArray(data) ? (data[0] as (MemoryRow & { similarity: number }) | undefined) : undefined;
    if (top && top.similarity >= DEDUPE_SIMILARITY) {
      await db
        .from("memories")
        .update({
          importance: Math.max(Number(top.importance) || 1, importance),
          last_recalled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", top.id);
      return { stored: false, dedupedAgainst: top.id };
    }
  } else {
    const { data } = await db.from("memories").select("id,importance").eq("content", content).limit(1);
    const existing = data?.[0];
    if (existing) {
      await db
        .from("memories")
        .update({
          importance: Math.max(Number(existing.importance) || 1, importance),
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      return { stored: false, dedupedAgainst: existing.id };
    }
  }

  const { data: row, error } = await db
    .from("memories")
    .insert({ kind, content, importance, source, embedding })
    .select("id")
    .single();
  if (error || !row) return { stored: false, reason: error?.message ?? "insert failed" };

  void renderMemoryDigest(db).catch(() => {});
  return { stored: true, id: row.id };
}

/** Semantic recall (keyword fallback when embeddings are unavailable). */
export async function recallMemories(db: SupabaseClient, query: string, k = 8): Promise<MemoryRow[]> {
  let rows: MemoryRow[] = [];
  const embedding = await embedText(query);
  if (embedding) {
    const { data } = await db.rpc("match_memories", { query_embedding: embedding, match_count: k });
    rows = (Array.isArray(data) ? data : []).filter(
      (r: MemoryRow & { similarity?: number }) => (r.similarity ?? 0) >= RECALL_MIN_SIMILARITY,
    );
  }
  if (rows.length === 0) {
    const { data } = await db
      .from("memories")
      .select("id,kind,content,importance")
      .ilike("content", `%${query.replace(/[%_]/g, "")}%`)
      .order("importance", { ascending: false })
      .limit(k);
    rows = (data ?? []) as MemoryRow[];
  }
  if (rows.length > 0) {
    void db
      .from("memories")
      .update({ last_recalled_at: new Date().toISOString() })
      .in("id", rows.map((r) => r.id))
      .then(
        () => {},
        () => {},
      );
  }
  return rows;
}

/** Highest-importance memories, pinned into the dynamic system block. */
export async function topMemories(db: SupabaseClient, n = 6): Promise<MemoryRow[]> {
  const { data } = await db
    .from("memories")
    .select("id,kind,content,importance")
    .order("importance", { ascending: false })
    .limit(n);
  return (data ?? []) as MemoryRow[];
}

const EXTRACT_SYSTEM = `You extract long-term memories from one exchange between the operator (Dr. Brandon Bright) and his AI, BRIGHT OS.
Reply with STRICT JSON only: an array (possibly empty) of {"kind": "...", "content": "...", "importance": 1-5}.
- kind ∈ fact | preference | decision | person | project | lesson | context.
- content: ONE self-contained third-person sentence (e.g. "Dr. Bright prefers briefings under 100 words.").
- Capture everything durably notable: stated facts, preferences, decisions and their reasons, people, projects, lessons/corrections, personal context.
- Skip: greetings/small talk with nothing durable, live metrics (they go stale), anything the OS obviously already knows, credentials or secrets.
- importance: 5 = core identity/doctrine, 3 = useful, 1 = minor color.
- Max 5 items. If nothing is worth keeping, reply [].
No prose, no code fences — JSON array only.`;

/**
 * The automatic extractor — runs after each conversational/action turn
 * (fire-and-forget), pulls out everything notable, dedupes via rememberMemory.
 * Cheap haiku call, logged to agent_sessions like everything else.
 */
export async function extractMemories(
  db: SupabaseClient,
  turn: { operator: string; reply: string; via: string },
): Promise<number> {
  const started = Date.now();
  const response = await client().messages.create({
    model: env.classifyModel,
    max_tokens: 400,
    system: EXTRACT_SYSTEM,
    messages: [
      {
        role: "user",
        content: `OPERATOR (via ${turn.via}): ${turn.operator.slice(0, 1200)}\n\nBRIGHT OS: ${turn.reply.slice(0, 1200)}`,
      },
    ],
  });
  await logOsSession(
    db,
    env.classifyModel,
    response.usage,
    computeCostUsd(env.classifyModel, response.usage),
    (Date.now() - started) / 1000,
  );

  const text = response.content
    .filter((b): b is Extract<(typeof response.content)[number], { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  let items: unknown;
  try {
    items = JSON.parse(text);
  } catch {
    return 0;
  }
  if (!Array.isArray(items)) return 0;

  let saved = 0;
  for (const item of items.slice(0, 5)) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    const out = await rememberMemory(
      db,
      { kind: it.kind, content: it.content, importance: it.importance },
      `auto:${turn.via}`,
    ).catch(() => null);
    if (out?.stored) saved += 1;
  }
  return saved;
}

/** Mirror the memory store into the vault as a human-readable digest. */
export async function renderMemoryDigest(db: SupabaseClient): Promise<void> {
  if (!vaultConfigured()) return;
  const { data } = await db
    .from("memories")
    .select("kind,content,importance,created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  const rows = (data ?? []) as { kind: string; content: string; importance: number; created_at: string }[];
  const lines: string[] = [
    "# BRIGHT OS — Memory Digest",
    "",
    `> Mirrored from the BRIGHT OS memory store at ${new Date().toISOString()} — read-only;`,
    "> edits belong in the HUD or via \"remember …\". This file is overwritten on every save.",
    "",
  ];
  for (const kind of MEMORY_KINDS) {
    const of = rows.filter((r) => r.kind === kind);
    if (of.length === 0) continue;
    lines.push(`## ${kind.toUpperCase()} (${of.length})`, "");
    for (const m of of.slice(0, 25)) {
      lines.push(`- ${"★".repeat(Math.max(1, Math.min(5, m.importance)))} ${m.content.replace(/\n/g, " ")}`);
    }
    lines.push("");
  }
  await writeVaultDoc(`${VAULT_BRAIN_DIR}/Memory Digest.md`, lines.join("\n"));
}
