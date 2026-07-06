import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => import("../helpers/admin-mock"));
vi.mock("@/lib/auth", () => import("../helpers/auth-mock"));

import { GET, POST } from "@/app/api/heartbeat/route";
import { signHeartbeat } from "@/lib/hmac";
import { HUMAN, authState, byTable, createMockDb, dbHolder, makeReq } from "../helpers/harness";

const SECRET = process.env.HEARTBEAT_HMAC_SECRET!;

function signedReq(payload: unknown, opts?: { ts?: string; sig?: string; ip?: string }) {
  const rawBody = JSON.stringify(payload);
  const ts = opts?.ts ?? String(Math.floor(Date.now() / 1000));
  const sig = opts?.sig ?? signHeartbeat(SECRET, ts, rawBody);
  return makeReq("http://os/api/heartbeat", {
    method: "POST",
    rawBody,
    headers: {
      "content-type": "application/json",
      "x-brightos-timestamp": ts,
      "x-brightos-signature": sig,
      "x-forwarded-for": opts?.ip ?? "10.0.0.1",
    },
  });
}

describe("POST /api/heartbeat (HMAC ingest)", () => {
  it("ingests a correctly signed single event", async () => {
    let inserted: unknown[] = [];
    dbHolder.db = createMockDb(
      byTable({
        heartbeat_events: (op) => {
          inserted = op.payload as unknown[];
          return { data: inserted.map((_, i) => ({ id: String(i) })) };
        },
      }),
    );
    const res = await POST(signedReq({ source: "OPENCLAW", message: "published /beta-access ✓" }));
    expect(res.status).toBe(201);
    expect(inserted).toHaveLength(1);
    expect((inserted[0] as Record<string, unknown>).severity).toBe("info");
  });

  it("ingests a batch", async () => {
    dbHolder.db = createMockDb(
      byTable({
        heartbeat_events: (op) => ({ data: (op.payload as unknown[]).map((_, i) => ({ id: String(i) })) }),
      }),
    );
    const res = await POST(
      signedReq({
        events: [
          { source: "GHL", message: "+12 signups", severity: "info" },
          { source: "GSC", message: "-24% clicks", severity: "alert" },
        ],
      }),
    );
    const body = await res.json();
    expect(body.ingested).toBe(2);
  });

  it("rejects a bad signature", async () => {
    dbHolder.db = createMockDb();
    const res = await POST(signedReq({ source: "X", message: "y" }, { sig: "deadbeef" }));
    expect(res.status).toBe(401);
  });

  it("rejects replayed timestamps outside the ±300s window", async () => {
    dbHolder.db = createMockDb();
    const staleTs = String(Math.floor(Date.now() / 1000) - 3600);
    const res = await POST(signedReq({ source: "X", message: "y" }, { ts: staleTs }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("replay");
  });

  it("rejects unsigned requests", async () => {
    dbHolder.db = createMockDb();
    const res = await POST(
      makeReq("http://os/api/heartbeat", { method: "POST", body: { source: "X", message: "y" } }),
    );
    expect(res.status).toBe(401);
  });

  it("rate limits per IP (120/min)", async () => {
    dbHolder.db = createMockDb(byTable({ heartbeat_events: () => ({ data: [{ id: "1" }] }) }));
    let lastStatus = 0;
    for (let i = 0; i < 121; i++) {
      const res = await POST(signedReq({ source: "X", message: `m${i}` }, { ip: "10.9.9.9" }));
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });

  it("400s on valid signature but invalid payload", async () => {
    dbHolder.db = createMockDb();
    const res = await POST(signedReq({ nope: true }));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/heartbeat", () => {
  it("requires auth and returns recent events", async () => {
    dbHolder.db = createMockDb(
      byTable({ heartbeat_events: () => ({ data: [{ id: "1", source: "GHL", message: "+12" }] }) }),
    );
    const anon = await GET(makeReq("http://os/api/heartbeat"));
    expect(anon.status).toBe(401);

    authState.actor = HUMAN;
    const res = await GET(makeReq("http://os/api/heartbeat?limit=10"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(1);
  });
});
