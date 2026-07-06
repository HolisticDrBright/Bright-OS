import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => import("../helpers/admin-mock"));
vi.mock("@/lib/auth", () => import("../helpers/auth-mock"));

import { GET, POST } from "@/app/api/decisions/route";
import { POST as DECIDE } from "@/app/api/decisions/[id]/decide/route";
import { AGENT, HUMAN, authState, byTable, createMockDb, dbHolder, makeReq, uuid } from "../helpers/harness";

const DEC_ID = uuid(5);
const ctx = { params: Promise.resolve({ id: DEC_ID }) };

function decisionRow(status = "pending", extra: Record<string, unknown> = {}) {
  return {
    id: DEC_ID,
    task_id: uuid(1),
    title: "Publish BPC-157 vs TB-500 comparison — QCL",
    requesting_agent_id: uuid(10),
    brand_id: uuid(20),
    impact_note: "GSC: +3 positions · 1.2k impressions/wk at stake",
    impact_dollars_estimate: 1200,
    preview_md: "+ 2,400-word comparison",
    status,
    tags: ["publish"],
    decided_at: null,
    decided_via: null,
    created_at: new Date(Date.now() - 26 * 36e5).toISOString(), // 26h old
    ...extra,
  };
}

describe("GET /api/decisions", () => {
  it("computes age_hours from created_at", async () => {
    authState.actor = HUMAN;
    dbHolder.db = createMockDb(byTable({ decisions: () => ({ data: [decisionRow()] }) }));
    const res = await GET(makeReq("http://os/api/decisions?status=pending"));
    const body = await res.json();
    expect(body.decisions[0].age_hours).toBeGreaterThan(25.9);
    expect(body.decisions[0].age_hours).toBeLessThan(26.1);
  });
});

describe("POST /api/decisions", () => {
  it("auto-tags medical/regulatory content (hard rule is data, not vibes)", async () => {
    authState.actor = AGENT("openclaw");
    let inserted: Record<string, unknown> | null = null;
    dbHolder.db = createMockDb(
      byTable({
        agents: () => ({ data: [{ id: uuid(10), name: 'OPENCLAW "JARVIS"', kind: "openclaw" }] }),
        decisions: (op) => {
          if (op.method === "insert") {
            inserted = op.payload as Record<string, unknown>;
            return { data: decisionRow("pending", { tags: inserted.tags }) };
          }
          return undefined;
        },
        tasks: () => ({ data: [] }),
        heartbeat_events: () => ({ data: [] }),
      }),
    );
    const res = await POST(
      makeReq("http://os/api/decisions", {
        method: "POST",
        body: {
          title: "Publish peptide dosing guide",
          preview_md: "BPC-157 dosage recommendations for patients",
          task_id: uuid(1),
        },
      }),
    );
    expect(res.status).toBe(201);
    expect(inserted!.tags).toContain("medical-regulatory");
  });

  it("moves the linked task to awaiting_approval", async () => {
    authState.actor = HUMAN;
    let taskUpdated = false;
    dbHolder.db = createMockDb(
      byTable({
        decisions: (op) => (op.method === "insert" ? { data: decisionRow() } : undefined),
        tasks: (op) => {
          if (op.method === "update") {
            taskUpdated = true;
            expect((op.payload as Record<string, unknown>).status).toBe("awaiting_approval");
          }
          return { data: [] };
        },
        heartbeat_events: () => ({ data: [] }),
      }),
    );
    const res = await POST(
      makeReq("http://os/api/decisions", {
        method: "POST",
        body: { title: "Approve top-up", task_id: uuid(1) },
      }),
    );
    expect(res.status).toBe(201);
    expect(taskUpdated).toBe(true);
  });
});

describe("POST /api/decisions/:id/decide — the human-only choke point", () => {
  it("HARD RULE: agent tokens can never decide", async () => {
    authState.actor = AGENT("openclaw");
    dbHolder.db = createMockDb();
    const res = await DECIDE(
      makeReq(`http://os/api/decisions/${DEC_ID}/decide`, { method: "POST", body: { action: "approve" } }),
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("approves: sets status/decided_via/decided_at + heartbeat event", async () => {
    authState.actor = HUMAN;
    let updatePayload: Record<string, unknown> | null = null;
    let heartbeat = false;
    dbHolder.db = createMockDb(
      byTable({
        decisions: (op) => {
          if (op.method === "update") {
            updatePayload = op.payload as Record<string, unknown>;
            return { data: decisionRow("approved", { decided_via: "web" }) };
          }
          return { data: decisionRow("pending") };
        },
        heartbeat_events: (op) => {
          heartbeat = op.method === "insert";
          return { data: [] };
        },
        tasks: () => ({ data: [] }),
      }),
    );
    const res = await DECIDE(
      makeReq(`http://os/api/decisions/${DEC_ID}/decide`, {
        method: "POST",
        body: { action: "approve", via: "web" },
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(updatePayload!.status).toBe("approved");
    expect(updatePayload!.decided_via).toBe("web");
    expect(updatePayload!.decided_at).toBeTruthy();
    expect(heartbeat).toBe(true);
  });

  it("rejects: pushes the linked awaiting_approval task back to in_progress", async () => {
    authState.actor = HUMAN;
    let taskPushedBack = false;
    dbHolder.db = createMockDb(
      byTable({
        decisions: (op) =>
          op.method === "update"
            ? { data: decisionRow("rejected", { decided_via: "telegram" }) }
            : { data: decisionRow("pending") },
        tasks: (op) => {
          if (op.method === "update") {
            taskPushedBack = true;
            expect((op.payload as Record<string, unknown>).status).toBe("in_progress");
          }
          return { data: [] };
        },
        heartbeat_events: () => ({ data: [] }),
      }),
    );
    const res = await DECIDE(
      makeReq(`http://os/api/decisions/${DEC_ID}/decide`, {
        method: "POST",
        body: { action: "reject", via: "telegram" },
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(taskPushedBack).toBe(true);
  });

  it("409s when already decided", async () => {
    authState.actor = HUMAN;
    dbHolder.db = createMockDb(byTable({ decisions: () => ({ data: decisionRow("approved") }) }));
    const res = await DECIDE(
      makeReq(`http://os/api/decisions/${DEC_ID}/decide`, { method: "POST", body: { action: "approve" } }),
      ctx,
    );
    expect(res.status).toBe(409);
  });

  it("404s for unknown decisions and 400s for unknown actions", async () => {
    authState.actor = HUMAN;
    dbHolder.db = createMockDb(byTable({ decisions: () => ({ data: null }) }));
    const missing = await DECIDE(
      makeReq(`http://os/api/decisions/${DEC_ID}/decide`, { method: "POST", body: { action: "approve" } }),
      ctx,
    );
    expect(missing.status).toBe(404);

    const bad = await DECIDE(
      makeReq(`http://os/api/decisions/${DEC_ID}/decide`, { method: "POST", body: { action: "maybe" } }),
      ctx,
    );
    expect(bad.status).toBe(400);
  });
});
