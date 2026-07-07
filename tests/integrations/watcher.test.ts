import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  normalizeStatus,
  parseTaskNote,
  renderNoteWriteback,
  syncNoteToDb,
} from "@/watcher/sync";
import { uuidv5FromLegacy } from "../../scripts/import-mcv2";
import { byTable, createMockDb, uuid } from "../helpers/harness";
import type { TaskRow } from "@/types/db";

const asDb = (m: unknown) => m as SupabaseClient;
const NOW = new Date("2026-07-06T20:00:00Z");

const NOTE = `---
title: "ALP: wire GHL webhook"
status: doing
owner: OPENCLAW
brand: AI Longevity Pro
due: 2026-07-07
---

## Notes
Wire the beta cohort webhook.
`;

function taskRow(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: uuid(1),
    title: "ALP: wire GHL webhook",
    brand_id: uuid(20),
    agent_id: uuid(10),
    status: "assigned",
    due_at: null,
    source: "obsidian",
    obsidian_path: "Tasks/ALP wire GHL webhook.md",
    frontmatter: { brightos_synced_at: "2026-07-06T10:00:00Z" },
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-06T10:00:00Z", // == synced_at → db unchanged
    ...over,
  };
}

describe("frontmatter parsing", () => {
  it("parses status aliases, owner, brand, due", () => {
    const note = parseTaskNote(NOTE, "Tasks/ALP wire GHL webhook.md");
    expect(note.title).toBe("ALP: wire GHL webhook");
    expect(note.status).toBe("in_progress"); // doing → in_progress
    expect(note.owner).toBe("OPENCLAW");
    expect(note.brand).toBe("AI Longevity Pro");
    expect(note.due).toBe("2026-07-07");
    expect(note.body).toContain("Wire the beta cohort webhook");
  });

  it("falls back to the filename for untitled notes", () => {
    const note = parseTaskNote("---\nstatus: todo\n---\nbody", "Tasks/Fix the fax queue.md");
    expect(note.title).toBe("Fix the fax queue");
    expect(note.status).toBe("backlog");
  });

  it("normalizes the full alias table", () => {
    expect(normalizeStatus("Done")).toBe("verified");
    expect(normalizeStatus("published")).toBe("shipped");
    expect(normalizeStatus("In Progress")).toBe("in_progress");
    expect(normalizeStatus("garbage")).toBeNull();
  });
});

describe("renderNoteWriteback", () => {
  it("updates managed keys and preserves the body", () => {
    const out = renderNoteWriteback(NOTE, taskRow({ status: "awaiting_approval" }), {
      agentName: 'OPENCLAW "JARVIS"',
      brandName: "AI Longevity Pro",
    });
    expect(out).toContain("status: awaiting_approval");
    expect(out).toContain("Wire the beta cohort webhook");
    expect(out).toContain(`brightos_id: ${uuid(1)}`);
  });

  it("creates a fresh note when none exists", () => {
    const out = renderNoteWriteback(null, taskRow(), { agentName: null, brandName: null });
    expect(out).toContain("status: assigned");
    expect(out).toContain("# ALP: wire GHL webhook");
  });
});

describe("syncNoteToDb", () => {
  const lookups = {
    agents: () => ({ data: [{ id: uuid(10), name: 'OPENCLAW "JARVIS"' }] }),
    brands: () => ({ data: [{ id: uuid(20), name: "AI Longevity Pro" }] }),
  };

  it("creates a task from a new note (source=obsidian)", async () => {
    let inserted: Record<string, unknown> | null = null;
    const db = createMockDb(
      byTable({
        ...lookups,
        tasks: (op) => {
          if (op.method === "insert") {
            inserted = op.payload as Record<string, unknown>;
            return { data: { id: uuid(2) } };
          }
          return { data: null }; // no existing
        },
      }),
    );
    const out = await syncNoteToDb(asDb(db), {
      relPath: "Tasks/New idea.md",
      content: NOTE,
      mtime: NOW,
      now: NOW,
    });
    expect(out.kind).toBe("created");
    expect(inserted!.source).toBe("obsidian");
    expect(inserted!.agent_id).toBe(uuid(10));
    expect(inserted!.brand_id).toBe(uuid(20));
  });

  it("file newer → db updated with the human transition matrix", async () => {
    let patch: Record<string, unknown> | null = null;
    const db = createMockDb(
      byTable({
        ...lookups,
        tasks: (op) => {
          if (op.method === "update") {
            patch = op.payload as Record<string, unknown>;
            return { data: [] };
          }
          return { data: taskRow() };
        },
      }),
    );
    const out = await syncNoteToDb(asDb(db), {
      relPath: "Tasks/ALP wire GHL webhook.md",
      content: NOTE, // status doing → in_progress
      mtime: new Date("2026-07-06T12:00:00Z"), // after synced_at
      now: NOW,
    });
    expect(out.kind).toBe("db_updated");
    expect(patch!.status).toBe("in_progress");
    expect((patch!.frontmatter as Record<string, unknown>).brightos_synced_at).toBe(NOW.toISOString());
  });

  it("REJECTS illegal vault transitions (assigned → shipped)", async () => {
    const shippedNote = NOTE.replace("status: doing", "status: published");
    const db = createMockDb(byTable({ ...lookups, tasks: () => ({ data: taskRow() }) }));
    const out = await syncNoteToDb(asDb(db), {
      relPath: "Tasks/ALP wire GHL webhook.md",
      content: shippedNote,
      mtime: new Date("2026-07-06T12:00:00Z"),
      now: NOW,
    });
    expect(out.kind).toBe("rejected");
    expect((out as { reason: string }).reason).toContain("illegal transition");
  });

  it("REJECTS verified-from-vault when unverified claims exist (gate holds everywhere)", async () => {
    const doneNote = NOTE.replace("status: doing", "status: done");
    const db = createMockDb(
      byTable({
        ...lookups,
        tasks: () => ({ data: taskRow({ status: "in_progress" }) }),
        claims: () => ({ count: 2 }),
      }),
    );
    const out = await syncNoteToDb(asDb(db), {
      relPath: "Tasks/ALP wire GHL webhook.md",
      content: doneNote,
      mtime: new Date("2026-07-06T12:00:00Z"),
      now: NOW,
    });
    expect(out.kind).toBe("rejected");
    expect((out as { reason: string }).reason).toContain("unverified claim");
  });

  it("db newer → file_stale (caller rewrites the note)", async () => {
    const db = createMockDb(
      byTable({
        ...lookups,
        tasks: () => ({ data: taskRow({ updated_at: "2026-07-06T13:00:00Z" }) }), // after synced_at
      }),
    );
    const out = await syncNoteToDb(asDb(db), {
      relPath: "Tasks/ALP wire GHL webhook.md",
      content: NOTE,
      mtime: new Date("2026-07-06T10:00:00Z"), // == synced_at → file unchanged
      now: NOW,
    });
    expect(out.kind).toBe("file_stale");
  });

  it("both changed → conflict, last write wins, conflict logged", async () => {
    let conflictEvent: Record<string, unknown> | null = null;
    const db = createMockDb(
      byTable({
        ...lookups,
        tasks: (op) => {
          if (op.method === "update") return { data: [] };
          return { data: taskRow({ updated_at: "2026-07-06T12:00:00Z" }) };
        },
        heartbeat_events: (op) => {
          conflictEvent = op.payload as Record<string, unknown>;
          return { data: [] };
        },
      }),
    );
    const out = await syncNoteToDb(asDb(db), {
      relPath: "Tasks/ALP wire GHL webhook.md",
      content: NOTE,
      mtime: new Date("2026-07-06T14:00:00Z"), // file later than db → file wins
      now: NOW,
    });
    expect(out.kind).toBe("conflict");
    expect((out as { winner: string }).winner).toBe("file");
    expect(conflictEvent!.source).toBe("SYNC-CONFLICT");
  });

  it("nothing changed → noop", async () => {
    const db = createMockDb(byTable({ ...lookups, tasks: () => ({ data: taskRow() }) }));
    const out = await syncNoteToDb(asDb(db), {
      relPath: "Tasks/ALP wire GHL webhook.md",
      content: NOTE,
      mtime: new Date("2026-07-06T10:00:00Z"),
      now: NOW,
    });
    expect(out.kind).toBe("noop");
  });
});

describe("mcv2 import ids", () => {
  it("uuidv5FromLegacy is deterministic, valid, and kind-scoped", () => {
    const a = uuidv5FromLegacy("task", "42");
    expect(a).toBe(uuidv5FromLegacy("task", "42"));
    expect(a).not.toBe(uuidv5FromLegacy("session", "42"));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
