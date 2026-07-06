import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { parseHeartbeatMd, runHeartbeat } from "@/workers/heartbeat";
import {
  checkBoardHygiene,
  checkDecisionAging,
  checkGhlWaitlist,
  checkPublishVerification,
} from "@/workers/checks";
import { computeDeltas } from "@/lib/gsc";
import { byTable, createMockDb, uuid } from "../helpers/harness";

const NOW = new Date("2026-07-06T20:00:00Z");
const H = 36e5;

const asDb = (m: unknown) => m as SupabaseClient;

describe("parseHeartbeatMd", () => {
  it("reads checked boxes only, ignoring unknown names", () => {
    const md = [
      "- [x] decision-aging — stuff",
      "- [ ] ghl-waitlist — disabled",
      "- [X] publish-verification",
      "- [x] made-up-check",
      "not a checkbox",
    ].join("\n");
    expect(parseHeartbeatMd(md)).toEqual(["decision-aging", "publish-verification"]);
  });
});

describe("checkDecisionAging", () => {
  it("alerts for >24h pending decisions and dedups within 24h", async () => {
    const staleDecision = {
      id: uuid(5),
      title: "Publish BPC-157 comparison",
      status: "pending",
      created_at: new Date(NOW.getTime() - 26 * H).toISOString(),
    };
    const db = createMockDb(
      byTable({
        decisions: () => ({ data: [staleDecision] }),
        heartbeat_events: () => ({ data: [] }), // no prior alerts
      }),
    );
    const notify = vi.fn(async () => {});
    const events = await checkDecisionAging({ db: asDb(db), now: NOW, notifyDecision: notify });
    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe("alert");
    expect(events[0].meta.decision_id).toBe(uuid(5));
    expect(notify).toHaveBeenCalledOnce();

    // second beat inside 24h: alert already recorded → silence
    const db2 = createMockDb(
      byTable({
        decisions: () => ({ data: [staleDecision] }),
        heartbeat_events: () => ({ data: [{ meta: { decision_id: uuid(5) } }] }),
      }),
    );
    const events2 = await checkDecisionAging({ db: asDb(db2), now: NOW });
    expect(events2).toHaveLength(0);
  });
});

describe("checkGhlWaitlist", () => {
  beforeEach(() => {
    process.env.GHL_API_KEY = "k";
    process.env.GHL_LOCATION_ID = "loc";
  });
  afterEach(() => {
    delete process.env.GHL_API_KEY;
    delete process.env.GHL_LOCATION_ID;
  });

  const fetchTotal = (total: number) =>
    vi.fn(async () => new Response(JSON.stringify({ meta: { total } }), { status: 200 })) as unknown as typeof fetch;

  it("emits a ticker event with the delta since last beat", async () => {
    const db = createMockDb(
      byTable({ heartbeat_events: () => ({ data: [{ meta: { waitlist_total: 400 } }] }) }),
    );
    const events = await checkGhlWaitlist({ db: asDb(db), now: NOW, fetchImpl: fetchTotal(412) });
    expect(events[0].message).toContain("+12 new signups");
    expect(events[0].severity).toBe("info");
    expect(events[0].meta).toEqual({ waitlist_total: 412, delta: 12 });
  });

  it("alerts on negative deltas (data loss smells)", async () => {
    const db = createMockDb(
      byTable({ heartbeat_events: () => ({ data: [{ meta: { waitlist_total: 400 } }] }) }),
    );
    const events = await checkGhlWaitlist({ db: asDb(db), now: NOW, fetchImpl: fetchTotal(380) });
    expect(events[0].severity).toBe("alert");
    expect(events[0].message).toContain("anomaly");
  });

  it("no-ops when GHL is not configured", async () => {
    delete process.env.GHL_API_KEY;
    const events = await checkGhlWaitlist({ db: asDb(createMockDb()), now: NOW });
    expect(events).toEqual([]);
  });
});

describe("GSC computeDeltas", () => {
  it("compares the two most recent days per query", () => {
    const rows = [
      { date: "2026-07-03", query: "bpc-157 vs tb-500", clicks: 10, impressions: 100, position: 9 },
      { date: "2026-07-04", query: "bpc-157 vs tb-500", clicks: 13, impressions: 130, position: 6 },
    ];
    const [d] = computeDeltas("QCL", rows);
    expect(d.clicksPctChange).toBe(30);
    expect(d.positionChange).toBe(3); // improved by 3 spots
  });
  it("returns [] with fewer than 2 days of data", () => {
    expect(
      computeDeltas("QCL", [
        { date: "2026-07-04", query: "x", clicks: 1, impressions: 2, position: 3 },
      ]),
    ).toEqual([]);
  });
});

describe("checkPublishVerification", () => {
  const shippedTask = {
    id: uuid(1),
    title: "ALP: /beta-access landing copy",
    status: "shipped",
    updated_at: new Date(NOW.getTime() - 2 * H).toISOString(),
    frontmatter: { url: "https://example.com/beta-access", expected_title: "Beta access" },
  };

  it("passes a live page with the expected title", async () => {
    const db = createMockDb(byTable({ tasks: () => ({ data: [shippedTask] }) }));
    const f = vi.fn(
      async () =>
        new Response("<html><head><title>Beta access — AI Longevity Pro</title></head></html>", {
          status: 200,
        }),
    ) as unknown as typeof fetch;
    const events = await checkPublishVerification({ db: asDb(db), now: NOW, fetchImpl: f });
    expect(events[0].severity).toBe("info");
    expect(events[0].message).toContain("verified live");
  });

  it("red-alerts a 404 and pushes the task back to in_progress", async () => {
    let pushedBack = false;
    const db = createMockDb(
      byTable({
        tasks: (op) => {
          if (op.method === "update") {
            pushedBack = (op.payload as Record<string, unknown>).status === "in_progress";
            return { data: [] };
          }
          return { data: [shippedTask] };
        },
      }),
    );
    const f = vi.fn(async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    const events = await checkPublishVerification({ db: asDb(db), now: NOW, fetchImpl: f });
    expect(events[0].severity).toBe("alert");
    expect(events[0].message).toContain("HTTP 404");
    expect(pushedBack).toBe(true);
  });

  it("alerts on title mismatch", async () => {
    const db = createMockDb(
      byTable({
        tasks: (op) => (op.method === "update" ? { data: [] } : { data: [shippedTask] }),
      }),
    );
    const f = vi.fn(
      async () => new Response("<title>Totally different page</title>", { status: 200 }),
    ) as unknown as typeof fetch;
    const events = await checkPublishVerification({ db: asDb(db), now: NOW, fetchImpl: f });
    expect(events[0].severity).toBe("alert");
    expect(events[0].message).toContain("title");
  });

  it("skips shipped tasks without a url", async () => {
    const db = createMockDb(
      byTable({ tasks: () => ({ data: [{ ...shippedTask, frontmatter: {} }] }) }),
    );
    const events = await checkPublishVerification({ db: asDb(db), now: NOW });
    expect(events).toEqual([]);
  });
});

describe("checkBoardHygiene", () => {
  const staleTask = {
    id: uuid(2),
    title: "QCL: peptide-safety FAQ",
    status: "in_progress",
    updated_at: new Date(NOW.getTime() - 80 * H).toISOString(),
  };

  it("warns for idle in_progress tasks with no sessions", async () => {
    const db = createMockDb(
      byTable({
        tasks: () => ({ data: [staleTask] }),
        heartbeat_events: () => ({ data: [] }),
        agent_sessions: () => ({ data: [] }),
      }),
    );
    const events = await checkBoardHygiene({ db: asDb(db), now: NOW });
    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe("warn");
    expect(events[0].meta.idle_hours).toBe(80);
  });

  it("stays silent when session activity exists", async () => {
    const db = createMockDb(
      byTable({
        tasks: () => ({ data: [staleTask] }),
        heartbeat_events: () => ({ data: [] }),
        agent_sessions: () => ({ data: [{ id: "s1" }] }),
      }),
    );
    expect(await checkBoardHygiene({ db: asDb(db), now: NOW })).toEqual([]);
  });
});

describe("runHeartbeat", () => {
  beforeEach(() => {
    process.env.HEARTBEAT_MD_PATH = "/nonexistent/HEARTBEAT.md"; // → all checks enabled
  });

  it("pauses everything when the cost breaker trips", async () => {
    const db = createMockDb(
      byTable({
        agent_sessions: () => ({ data: [{ cost_usd: 999 }] }), // way over $60 cap
        heartbeat_events: (op) => (op.method === "insert" ? { data: [] } : { data: [] }),
      }),
    );
    const result = await runHeartbeat(asDb(db), { now: NOW, sendTelegram: false });
    expect(result.paused).toBe(true);
    expect(result.ran).toEqual([]);
    // breaker alert was written
    const inserts = db.__ops.filter((o) => o.table === "heartbeat_events" && o.method === "insert");
    expect(inserts.length).toBe(1);
    expect((inserts[0].payload as Record<string, unknown>).source).toBe("COST-BREAKER");
  });

  it("runs enabled checks, batches one insert, and survives a check crash", async () => {
    process.env.GHL_API_KEY = "k";
    process.env.GHL_LOCATION_ID = "loc";
    const db = createMockDb(
      byTable({
        agent_sessions: () => ({ data: [{ cost_usd: 1 }] }),
        decisions: () => ({ data: [] }),
        tasks: () => ({ data: [] }),
        heartbeat_events: () => ({ data: [] }),
      }),
    );
    // GHL fetch explodes → that check fails, beat continues
    const f = vi.fn(async () => {
      throw new Error("GHL down");
    }) as unknown as typeof fetch;

    const result = await runHeartbeat(asDb(db), { now: NOW, sendTelegram: false, fetchImpl: f });
    expect(result.paused).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].check).toBe("ghl-waitlist");

    const batchInsert = db.__ops.filter((o) => o.table === "heartbeat_events" && o.method === "insert");
    expect(batchInsert).toHaveLength(1); // ONE batched insert
    const rows = batchInsert[0].payload as Record<string, unknown>[];
    expect(rows.at(-1)?.source).toBe("HEARTBEAT"); // summary event last
    expect(rows.some((r) => r.source === "WORKER" && String(r.message).includes("GHL down"))).toBe(true);

    delete process.env.GHL_API_KEY;
    delete process.env.GHL_LOCATION_ID;
  });
});
