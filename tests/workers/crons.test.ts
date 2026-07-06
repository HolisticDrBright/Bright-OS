import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

import { composeBriefing, runDailyBriefing } from "@/workers/daily-briefing";
import { composeCloseout, isoWeekLabel } from "@/workers/weekly-closeout";
import { runNightlyBackup, runWeeklyOffsite } from "@/workers/backup";
import { syncBoardNote } from "@/workers/board-sync";
import { renderCommandBoard } from "@/lib/obsidian";
import { byTable, createMockDb, uuid } from "../helpers/harness";

const NOW = new Date("2026-07-06T13:00:00Z");
const H = 36e5;
const asDb = (m: unknown) => m as SupabaseClient;

function standardData() {
  return byTable({
    decisions: () => ({
      data: [
        {
          id: uuid(5),
          title: "Approve $240 GHL SMS top-up — Clinic",
          status: "pending",
          impact_dollars_estimate: 240,
          impact_note: "38 no-show risks this week",
          created_at: new Date(NOW.getTime() - 11 * H).toISOString(),
        },
        {
          id: uuid(6),
          title: "Publish BPC-157 comparison — QCL",
          status: "pending",
          impact_dollars_estimate: 1200,
          impact_note: null,
          created_at: new Date(NOW.getTime() - 26 * H).toISOString(),
        },
      ],
    }),
    tasks: () => ({
      data: [
        { id: uuid(1), title: "Clinic: June P&L reconciliation", status: "shipped", updated_at: NOW.toISOString() },
        { id: uuid(2), title: "BDS: Meridian Law launch", status: "verified", updated_at: NOW.toISOString() },
        { id: uuid(3), title: "QCL: FAQ", status: "awaiting_approval", updated_at: NOW.toISOString() },
        { id: uuid(4), title: "ALP: webhook wiring", status: "in_progress", updated_at: NOW.toISOString() },
      ],
    }),
    agent_sessions: () => ({
      data: [
        { agent_id: uuid(10), cost_usd: 4.12, started_at: NOW.toISOString() },
        { agent_id: uuid(11), cost_usd: 2.05, started_at: NOW.toISOString() },
      ],
    }),
    brands: () => ({
      data: [
        {
          id: uuid(20),
          name: "Bright Family Clinic",
          tier: "engine",
          revenue_wtd: 8420,
          spend_wtd: 1730,
          metrics: { visits_wtd: 61 },
        },
        {
          id: uuid(21),
          name: "AI Longevity Pro",
          tier: "engine",
          revenue_wtd: 2140,
          spend_wtd: 960,
          metrics: { waitlist: 412 },
        },
      ],
    }),
    heartbeat_events: (op) =>
      op.method === "insert" ? { data: [] } : { data: [{ source: "GSC", message: "-24% clicks", severity: "alert" }] },
    agents: () => ({
      data: [
        { id: uuid(10), name: "COWORK" },
        { id: uuid(11), name: "HERMES" },
      ],
    }),
  });
}

describe("daily briefing", () => {
  it("composes decisions sorted by $-impact with all sections", async () => {
    const db = createMockDb(standardData());
    const b = await composeBriefing(asDb(db), NOW);
    expect(b.markdown).toContain("BRIGHT OS Briefing");
    // $1200 impact sorts above $240
    const idxBig = b.markdown.indexOf("BPC-157");
    const idxSmall = b.markdown.indexOf("SMS top-up");
    expect(idxBig).toBeGreaterThan(-1);
    expect(idxBig).toBeLessThan(idxSmall);
    expect(b.markdown).toContain("Clinic: June P&L reconciliation");
    expect(b.markdown).toContain("COWORK: $4.12");
    expect(b.markdown).toContain("Bright Family Clinic");
    expect(b.markdown).toContain("[GSC] -24% clicks");
    expect(b.telegramHtml).toContain("2 decisions pending");
  });

  it("runDailyBriefing records a BRIEFING heartbeat event", async () => {
    const db = createMockDb(standardData());
    await runDailyBriefing(asDb(db), NOW);
    const insert = db.__ops.find((o) => o.table === "heartbeat_events" && o.method === "insert");
    expect((insert?.payload as Record<string, unknown>)?.source).toBe("BRIEFING");
  });
});

describe("weekly closeout", () => {
  it("isoWeekLabel matches known week", () => {
    expect(isoWeekLabel(new Date("2026-07-06T13:00:00Z"))).toBe("2026-W28");
  });

  it("composes $-in vs $-out per engine + the four board buckets", async () => {
    const db = createMockDb(standardData());
    const c = await composeCloseout(asDb(db), NOW);
    expect(c.week).toBe("2026-W28");
    expect(c.markdown).toContain("net $6690"); // clinic 8420-1730
    expect(c.markdown).toContain("## Shipped (1)");
    expect(c.markdown).toContain("## Verified (1)");
    expect(c.markdown).toContain("## Blocked (1)");
    expect(c.markdown).toContain("## Roll-forward (1)");
    expect(c.telegramHtml).toContain("WEEKLY CLOSEOUT — 2026-W28");
  });
});

describe("nightly backup", () => {
  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brightos-backup-"));
    process.env.BACKUP_DIR = dir;
    process.env.SUPABASE_DB_URL = "postgresql://postgres:pw@db.test.supabase.co:5432/postgres";
  });

  it("pg_dumps, uploads to the backups bucket, records an event", async () => {
    const db = createMockDb(byTable({ heartbeat_events: () => ({ data: [] }) }));
    const execImpl = vi.fn(async (cmd: string) => {
      // emulate pg_dump writing its file
      const m = /--file=("[^"]+"|\S+)/.exec(cmd);
      const file = m![1].replace(/"/g, "");
      await fs.writeFile(file, Buffer.alloc(2048, 1));
      return { stdout: "", stderr: "" };
    });
    const out = await runNightlyBackup(asDb(db), { now: NOW, execImpl: execImpl as never });
    expect(execImpl).toHaveBeenCalledOnce();
    expect(execImpl.mock.calls[0][0]).toContain("pg_dump");
    expect(out.objectPath).toBe("nightly/brightos-2026-07-06.dump");
    expect(db.__uploads[0]).toMatchObject({ bucket: "backups", path: "nightly/brightos-2026-07-06.dump" });
    expect(out.bytes).toBe(2048);
  });

  it("fails loudly without SUPABASE_DB_URL", async () => {
    delete process.env.SUPABASE_DB_URL;
    const db = createMockDb();
    await expect(runNightlyBackup(asDb(db), { now: NOW })).rejects.toThrow("SUPABASE_DB_URL");
  });

  it("weekly offsite falls back to a bucket copy when rclone is unconfigured", async () => {
    delete process.env.OFFSITE_RCLONE_REMOTE;
    const db = createMockDb(byTable({ heartbeat_events: () => ({ data: [] }) }));
    await fs.writeFile(path.join(process.env.BACKUP_DIR!, "brightos-2026-07-06.dump"), Buffer.alloc(10));
    const out = await runWeeklyOffsite(asDb(db), { now: NOW });
    expect(out.offsite).toBe("storage://backups/offsite-weekly/brightos-2026-07-06.dump");
  });
});

describe("board sync", () => {
  it("renders every column and marks the note as generated", () => {
    const md = renderCommandBoard({
      tasks: [
        {
          id: uuid(1),
          title: "ALP: /beta-access landing copy",
          status: "awaiting_approval",
          agent_id: uuid(10),
          brand_id: uuid(20),
          due_at: "2026-07-06T00:00:00Z",
          source: "chat",
          obsidian_path: "Tasks/ALP beta-access.md",
          frontmatter: {},
          created_at: "",
          updated_at: "",
        },
      ],
      agents: [{ id: uuid(10), name: 'OPENCLAW "JARVIS"' }],
      brands: [{ id: uuid(20), name: "AI Longevity Pro" }],
      now: NOW,
    });
    expect(md).toContain("# Active Command Board");
    expect(md).toContain("## AWAITING APPROVAL (1)");
    expect(md).toContain("[[Tasks/ALP beta-access]]");
    expect(md).toContain("do not edit by hand");
    for (const col of ["BACKLOG", "ASSIGNED", "IN PROGRESS", "VERIFIED", "SHIPPED"]) {
      expect(md).toContain(`## ${col}`);
    }
  });

  it("no-ops without a vault configured", async () => {
    delete process.env.OBSIDIAN_VAULT_PATH;
    expect(await syncBoardNote(asDb(createMockDb()), NOW)).toBe(false);
  });

  it("writes the board file when the vault exists", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brightos-vault-"));
    process.env.OBSIDIAN_VAULT_PATH = dir;
    const db = createMockDb(
      byTable({
        tasks: () => ({ data: [] }),
        agents: () => ({ data: [] }),
        brands: () => ({ data: [] }),
      }),
    );
    expect(await syncBoardNote(asDb(db), NOW)).toBe(true);
    const board = await fs.readFile(path.join(dir, "Active Command Board.md"), "utf8");
    expect(board).toContain("# Active Command Board");
    delete process.env.OBSIDIAN_VAULT_PATH;
  });
});
