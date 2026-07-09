import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@anthropic-ai/sdk", () => import("../helpers/anthropic-mock"));

import { extractMemories, recallMemories, rememberMemory } from "@/lib/command/brain-memory";
import { updateWorkingMemory } from "@/lib/command/working-memory";
import { anthropicState, byTable, createMockDb, uuid } from "../helpers/harness";

const asDb = (m: unknown) => m as SupabaseClient;
const USAGE = { input_tokens: 200, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const textResponse = (text: string) => ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: USAGE });

describe("rememberMemory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
  });

  it("stores a new typed memory (keyword mode, no embeddings key)", async () => {
    let inserted: Record<string, unknown> | null = null;
    const db = createMockDb(
      byTable({
        memories: (op) => {
          if (op.method === "insert") {
            inserted = op.payload as Record<string, unknown>;
            return { data: { id: uuid(1) } };
          }
          return { data: [] };
        },
      }),
    );
    const out = await rememberMemory(asDb(db), { kind: "preference", content: "Dr. Bright prefers espresso.", importance: 4 }, "tool:web");
    expect(out).toEqual({ stored: true, id: uuid(1) });
    expect(inserted!.kind).toBe("preference");
    expect(inserted!.importance).toBe(4);
    expect(inserted!.source).toBe("tool:web");
    expect(inserted!.embedding).toBeNull();
  });

  it("dedupes on exact content and bumps importance instead of inserting", async () => {
    let updated: Record<string, unknown> | null = null;
    let insertHappened = false;
    const db = createMockDb(
      byTable({
        memories: (op) => {
          if (op.method === "insert") {
            insertHappened = true;
            return { data: { id: uuid(9) } };
          }
          if (op.method === "update") {
            updated = op.payload as Record<string, unknown>;
            return { data: [] };
          }
          return { data: [{ id: uuid(2), importance: 2 }] }; // exact-content match
        },
      }),
    );
    const out = await rememberMemory(asDb(db), { kind: "fact", content: "The clinic is in California.", importance: 5 });
    expect(out).toEqual({ stored: false, dedupedAgainst: uuid(2) });
    expect(insertHappened).toBe(false);
    expect(updated!.importance).toBe(5); // bumped to the higher of the two
  });

  it("dedupes semantically via match_memories when embeddings are configured", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 }),
      ),
    );
    let rpcArgs: Record<string, unknown> | null = null;
    let insertHappened = false;
    const db = createMockDb((op) => {
      if (op.table === "rpc:match_memories") {
        rpcArgs = op.payload as Record<string, unknown>;
        return { data: [{ id: uuid(3), kind: "fact", content: "near-duplicate", importance: 3, similarity: 0.95 }] };
      }
      if (op.table === "memories" && op.method === "insert") {
        insertHappened = true;
        return { data: { id: uuid(9) } };
      }
      return { data: [] };
    });
    const out = await rememberMemory(asDb(db), { kind: "fact", content: "The clinic is located in California." });
    expect(out).toEqual({ stored: false, dedupedAgainst: uuid(3) });
    expect(insertHappened).toBe(false);
    expect(Array.isArray(rpcArgs!.query_embedding)).toBe(true);
  });
});

describe("recallMemories", () => {
  it("falls back to keyword search without embeddings and returns typed rows", async () => {
    const rows = [{ id: uuid(4), kind: "decision", content: "Approved the beta pricing.", importance: 4 }];
    const db = createMockDb(
      byTable({
        memories: (op) => (op.method === "select" ? { data: rows } : { data: [] }),
      }),
    );
    const out = await recallMemories(asDb(db), "pricing", 5);
    expect(out).toEqual(rows);
  });
});

describe("extractMemories (the automatic end-of-turn extractor)", () => {
  it("parses haiku's JSON, saves each memory, and logs the session", async () => {
    const inserted: Record<string, unknown>[] = [];
    let logged: Record<string, unknown> | null = null;
    const db = createMockDb(
      byTable({
        memories: (op) => {
          if (op.method === "insert") {
            inserted.push(op.payload as Record<string, unknown>);
            return { data: { id: uuid(inserted.length) } };
          }
          return { data: [] };
        },
        agent_sessions: (op) => {
          if (op.method === "insert") logged = op.payload as Record<string, unknown>;
          return { data: [] };
        },
      }),
    );
    anthropicState.queue = [
      textResponse(
        '```json\n[{"kind":"preference","content":"Dr. Bright wants briefings under 100 words.","importance":4},{"kind":"person","content":"Alyssa is the Doctor\'s human VA.","importance":3}]\n```',
      ),
    ];

    const saved = await extractMemories(asDb(db), { operator: "keep briefings short", reply: "Noted, Doctor.", via: "web" });

    expect(saved).toBe(2);
    expect(inserted.map((i) => i.kind)).toEqual(["preference", "person"]);
    expect(inserted.every((i) => String(i.source) === "auto:web")).toBe(true);
    expect(logged!.model).toBe("claude-haiku-4-5");
  });

  it("saves nothing when the turn has nothing notable (or output is garbage)", async () => {
    let insertHappened = false;
    const db = createMockDb(
      byTable({
        memories: (op) => {
          if (op.method === "insert") insertHappened = true;
          return { data: [] };
        },
        agent_sessions: () => ({ data: [] }),
      }),
    );
    anthropicState.queue = [textResponse("[]")];
    expect(await extractMemories(asDb(db), { operator: "hey", reply: "Good evening.", via: "web" })).toBe(0);

    anthropicState.queue = [textResponse("no memories here, sorry")];
    expect(await extractMemories(asDb(db), { operator: "hey", reply: "Evening.", via: "web" })).toBe(0);
    expect(insertHappened).toBe(false);
  });
});

describe("updateWorkingMemory", () => {
  it("appends the exchange and persists per surface", async () => {
    let upserted: Record<string, unknown> | null = null;
    const db = createMockDb(
      byTable({
        working_memory: (op) => {
          if (op.method === "upsert") {
            upserted = op.payload as Record<string, unknown>;
            return { data: [] };
          }
          return { data: { summary_md: "", recent: [] } };
        },
      }),
    );
    await updateWorkingMemory(asDb(db), "web", "how's it going", "Splendidly, Doctor.");
    expect(upserted!.surface).toBe("web");
    const recent = upserted!.recent as { you: string; os: string }[];
    expect(recent).toHaveLength(1);
    expect(recent[0].os).toContain("Splendidly");
  });

  it("compresses the oldest exchanges into the summary via haiku when it grows", async () => {
    const bigRecent = Array.from({ length: 8 }, (_, i) => ({
      at: "2026-07-09T00:00:00Z",
      you: `question ${i}`,
      os: `answer ${i}`,
    }));
    let upserted: Record<string, unknown> | null = null;
    const db = createMockDb(
      byTable({
        working_memory: (op) => {
          if (op.method === "upsert") {
            upserted = op.payload as Record<string, unknown>;
            return { data: [] };
          }
          return { data: { summary_md: "Old summary.", recent: bigRecent } };
        },
        agent_sessions: () => ({ data: [] }),
      }),
    );
    anthropicState.queue = [textResponse("Merged running summary of the conversation.")];

    await updateWorkingMemory(asDb(db), "telegram", "and one more thing", "Certainly.");

    expect(upserted!.summary_md).toBe("Merged running summary of the conversation.");
    expect((upserted!.recent as unknown[]).length).toBe(4); // oldest folded away
    expect(anthropicState.requests[0].model).toBe("claude-haiku-4-5");
  });
});
