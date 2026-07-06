import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("@/lib/supabase/admin", () => import("../helpers/admin-mock"));
vi.mock("@/lib/auth", () => import("../helpers/auth-mock"));

import { GET, POST } from "@/app/api/memory/route";
import { POST as PROMOTE } from "@/app/api/memory/promote/route";
import { promoteLineInContent } from "@/lib/memory";
import { AGENT, HUMAN, authState, byTable, createMockDb, dbHolder, makeReq } from "../helpers/harness";

let tmpFile: string;

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brightos-mem-"));
  tmpFile = path.join(dir, "MEMORY.md");
  process.env.MEMORY_MD_PATH = tmpFile;
});

describe("GET /api/memory", () => {
  it("returns MEMORY.md template when the file does not exist yet", async () => {
    authState.actor = HUMAN;
    dbHolder.db = createMockDb(
      byTable({
        memory_log: () => ({ data: [{ id: "1", day: "2026-07-05", content_md: "SIGMA drawdown…" }] }),
        memory_promotions: () => ({ data: [] }),
      }),
    );
    const res = await GET(makeReq("http://os/api/memory"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.memory_md).toContain("OPERATING RULES");
    expect(body.log).toHaveLength(1);
  });
});

describe("POST /api/memory", () => {
  it("upserts a daily log entry", async () => {
    authState.actor = AGENT("hermes");
    let upserted: Record<string, unknown> | null = null;
    dbHolder.db = createMockDb(
      byTable({
        memory_log: (op) => {
          if (op.method === "upsert") {
            upserted = op.payload as Record<string, unknown>;
            return { data: { id: "1", ...upserted } };
          }
          return undefined;
        },
      }),
    );
    const res = await POST(
      makeReq("http://os/api/memory", {
        method: "POST",
        body: { day: "2026-07-06", content_md: "ALP waitlist crossed 500." },
      }),
    );
    expect(res.status).toBe(200);
    expect(upserted!.day).toBe("2026-07-06");
  });

  it("appends when append=true", async () => {
    authState.actor = HUMAN;
    let merged = "";
    dbHolder.db = createMockDb(
      byTable({
        memory_log: (op) => {
          if (op.method === "upsert") {
            merged = (op.payload as Record<string, string>).content_md;
            return { data: { id: "1", day: "2026-07-06", content_md: merged } };
          }
          return { data: { id: "1", day: "2026-07-06", content_md: "existing line" } };
        },
      }),
    );
    await POST(
      makeReq("http://os/api/memory", {
        method: "POST",
        body: { day: "2026-07-06", content_md: "new line", append: true },
      }),
    );
    expect(merged).toBe("existing line\nnew line");
  });

  it("rejects bad day formats", async () => {
    authState.actor = HUMAN;
    dbHolder.db = createMockDb();
    const res = await POST(
      makeReq("http://os/api/memory", { method: "POST", body: { day: "July 6", content_md: "x" } }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/memory/promote", () => {
  it("is human-only", async () => {
    authState.actor = AGENT("hermes");
    dbHolder.db = createMockDb();
    const res = await PROMOTE(
      makeReq("http://os/api/memory/promote", {
        method: "POST",
        body: { from_day: "2026-07-04", line_text: "Opus→Haiku triage saved $9.12/day" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("appends the line to MEMORY.md and records the promotion", async () => {
    authState.actor = HUMAN;
    let promoted: Record<string, unknown> | null = null;
    dbHolder.db = createMockDb(
      byTable({
        memory_promotions: (op) => {
          if (op.method === "insert") {
            promoted = op.payload as Record<string, unknown>;
            return { data: { id: "1", ...promoted } };
          }
          return undefined;
        },
        heartbeat_events: () => ({ data: [] }),
      }),
    );
    const res = await PROMOTE(
      makeReq("http://os/api/memory/promote", {
        method: "POST",
        body: { from_day: "2026-07-04", line_text: "Opus→Haiku triage saved $9.12/day" },
      }),
    );
    expect(res.status).toBe(201);
    expect(promoted!.line_text).toContain("Opus→Haiku");
    const file = await fs.readFile(tmpFile, "utf8");
    expect(file).toContain("· Opus→Haiku triage saved $9.12/day");
  });
});

describe("promoteLineInContent", () => {
  it("inserts under the requested section, before the next heading", () => {
    const content = "# LEARNED\n· old lesson\n\n# PEOPLE\n· Marisol\n";
    const next = promoteLineInContent(content, "new lesson", "LEARNED");
    const learnedBlock = next.split("# PEOPLE")[0];
    expect(learnedBlock).toContain("· old lesson");
    expect(learnedBlock).toContain("· new lesson");
  });

  it("creates the section when missing and is idempotent", () => {
    const once = promoteLineInContent("# OPERATING RULES\n· rule", "lesson", "LEARNED");
    expect(once).toContain("# LEARNED");
    const twice = promoteLineInContent(once, "lesson", "LEARNED");
    expect(twice.match(/· lesson/g)).toHaveLength(1);
  });
});
