import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => import("../helpers/admin-mock"));
vi.mock("@/lib/auth", () => import("../helpers/auth-mock"));

import { GET, POST } from "@/app/api/tasks/route";
import { PATCH, DELETE } from "@/app/api/tasks/[id]/route";
import { AGENT, HUMAN, authState, byTable, createMockDb, dbHolder, makeReq, uuid } from "../helpers/harness";

const TASK_ID = uuid(1);
const ctx = { params: Promise.resolve({ id: TASK_ID }) };

function taskRow(status: string) {
  return {
    id: TASK_ID,
    title: "ALP: /beta-access landing copy",
    brand_id: uuid(20),
    agent_id: uuid(10),
    status,
    due_at: null,
    source: "chat",
    obsidian_path: null,
    frontmatter: {},
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-05T00:00:00Z",
  };
}

describe("GET /api/tasks", () => {
  it("rejects unauthenticated calls", async () => {
    dbHolder.db = createMockDb();
    const res = await GET(makeReq("http://os/api/tasks"));
    expect(res.status).toBe(401);
  });

  it("filters by agent term (kind match) for the OpenClaw queue pull", async () => {
    authState.actor = AGENT("openclaw");
    dbHolder.db = createMockDb(
      byTable({
        agents: () => ({
          data: [
            { id: uuid(10), name: 'OPENCLAW "JARVIS"', kind: "openclaw" },
            { id: uuid(11), name: "CODEX", kind: "claude" },
          ],
        }),
        tasks: (op) => {
          const inFilter = op.filters.find((f) => f.op === "in" && f.column === "agent_id");
          expect(inFilter?.value).toEqual([uuid(10)]);
          const statusFilter = op.filters.find((f) => f.op === "eq" && f.column === "status");
          expect(statusFilter?.value).toBe("assigned");
          return { data: [taskRow("assigned")] };
        },
      }),
    );
    const res = await GET(makeReq("http://os/api/tasks?agent=openclaw&status=assigned"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tasks).toHaveLength(1);
  });

  it("returns empty when the agent term matches nobody", async () => {
    authState.actor = HUMAN;
    dbHolder.db = createMockDb(byTable({ agents: () => ({ data: [] }) }));
    const res = await GET(makeReq("http://os/api/tasks?agent=nonexistent"));
    const body = await res.json();
    expect(body.tasks).toEqual([]);
  });
});

describe("POST /api/tasks", () => {
  it("creates a task, resolving brand + agent by name, and auto-assigns", async () => {
    authState.actor = HUMAN;
    dbHolder.db = createMockDb(
      byTable({
        brands: () => ({ data: [{ id: uuid(20) }] }),
        agents: () => ({ data: [{ id: uuid(10), name: "COWORK", kind: "claude" }] }),
        tasks: (op) => {
          expect(op.method).toBe("insert");
          const p = op.payload as Record<string, unknown>;
          expect(p.brand_id).toBe(uuid(20));
          expect(p.agent_id).toBe(uuid(10));
          expect(p.status).toBe("assigned"); // backlog + agent → assigned
          return { data: { ...taskRow("assigned"), id: uuid(2) } };
        },
      }),
    );
    const res = await POST(
      makeReq("http://os/api/tasks", {
        method: "POST",
        body: { title: "QCL: peptide-safety FAQ", brand: "QCL", agent: "cowork" },
      }),
    );
    expect(res.status).toBe(201);
  });

  it("refuses creating tasks directly as verified/shipped", async () => {
    authState.actor = HUMAN;
    dbHolder.db = createMockDb();
    const res = await POST(
      makeReq("http://os/api/tasks", {
        method: "POST",
        body: { title: "sneaky", status: "shipped" },
      }),
    );
    expect(res.status).toBe(422);
  });

  it("rejects invalid bodies", async () => {
    authState.actor = HUMAN;
    dbHolder.db = createMockDb();
    const res = await POST(makeReq("http://os/api/tasks", { method: "POST", body: { nope: 1 } }));
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/tasks/:id — status transitions", () => {
  it("blocks illegal transitions (backlog → shipped)", async () => {
    authState.actor = HUMAN;
    dbHolder.db = createMockDb(byTable({ tasks: () => ({ data: taskRow("backlog") }) }));
    const res = await PATCH(makeReq(`http://os/api/tasks/${TASK_ID}`, { method: "PATCH", body: { status: "shipped" } }), ctx);
    expect(res.status).toBe(422);
  });

  it("blocks agents from transitions humans may do (awaiting_approval → verified)", async () => {
    authState.actor = AGENT("openclaw");
    dbHolder.db = createMockDb(byTable({ tasks: () => ({ data: taskRow("awaiting_approval") }) }));
    const res = await PATCH(
      makeReq(`http://os/api/tasks/${TASK_ID}`, { method: "PATCH", body: { status: "verified" } }),
      ctx,
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain("agent");
  });

  it("GATE: task with unverified claims can never go verified", async () => {
    authState.actor = HUMAN;
    dbHolder.db = createMockDb(
      byTable({
        tasks: () => ({ data: taskRow("in_progress") }),
        claims: () => ({ count: 2 }),
      }),
    );
    const res = await PATCH(
      makeReq(`http://os/api/tasks/${TASK_ID}`, { method: "PATCH", body: { status: "verified" } }),
      ctx,
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain("unverified claim");
  });

  it("allows verified when all claims are verified", async () => {
    authState.actor = HUMAN;
    dbHolder.db = createMockDb(
      byTable({
        tasks: (op) =>
          op.method === "update" ? { data: taskRow("verified") } : { data: taskRow("in_progress") },
        claims: () => ({ count: 0 }),
      }),
    );
    const res = await PATCH(
      makeReq(`http://os/api/tasks/${TASK_ID}`, { method: "PATCH", body: { status: "verified" } }),
      ctx,
    );
    expect(res.status).toBe(200);
  });

  it("GATE: shipping without an approved decision is blocked", async () => {
    authState.actor = HUMAN;
    dbHolder.db = createMockDb(
      byTable({
        tasks: () => ({ data: taskRow("verified") }),
        decisions: () => ({ count: 0 }),
      }),
    );
    const res = await PATCH(
      makeReq(`http://os/api/tasks/${TASK_ID}`, { method: "PATCH", body: { status: "shipped" } }),
      ctx,
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain("approved decision");
  });

  it("ships with an approved decision and writes a heartbeat event", async () => {
    authState.actor = AGENT("openclaw");
    let heartbeatWritten = false;
    dbHolder.db = createMockDb(
      byTable({
        tasks: (op) =>
          op.method === "update" ? { data: taskRow("shipped") } : { data: taskRow("verified") },
        decisions: () => ({ count: 1 }),
        heartbeat_events: (op) => {
          heartbeatWritten = op.method === "insert";
          return { data: [] };
        },
      }),
    );
    const res = await PATCH(
      makeReq(`http://os/api/tasks/${TASK_ID}`, { method: "PATCH", body: { status: "shipped" } }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(heartbeatWritten).toBe(true);
  });

  it("404s for a missing task", async () => {
    authState.actor = HUMAN;
    dbHolder.db = createMockDb(byTable({ tasks: () => ({ data: null }) }));
    const res = await PATCH(
      makeReq(`http://os/api/tasks/${TASK_ID}`, { method: "PATCH", body: { title: "x" } }),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("surfaces DB GUARDRAIL trigger errors as 422", async () => {
    authState.actor = HUMAN;
    dbHolder.db = createMockDb(
      byTable({
        tasks: (op) =>
          op.method === "update"
            ? { error: { message: "GUARDRAIL: publish requires an approved decision" } }
            : { data: taskRow("verified") },
        decisions: () => ({ count: 1 }), // API gate passes; DB trigger still fires
      }),
    );
    const res = await PATCH(
      makeReq(`http://os/api/tasks/${TASK_ID}`, { method: "PATCH", body: { status: "shipped" } }),
      ctx,
    );
    expect(res.status).toBe(422);
  });
});

describe("DELETE /api/tasks/:id", () => {
  it("refuses agents (no destructive ops from agents)", async () => {
    authState.actor = AGENT("openclaw");
    dbHolder.db = createMockDb();
    const res = await DELETE(makeReq(`http://os/api/tasks/${TASK_ID}`, { method: "DELETE" }), ctx);
    expect(res.status).toBe(403);
  });

  it("allows the human", async () => {
    authState.actor = HUMAN;
    dbHolder.db = createMockDb(byTable({ tasks: () => ({ data: [] }) }));
    const res = await DELETE(makeReq(`http://os/api/tasks/${TASK_ID}`, { method: "DELETE" }), ctx);
    expect(res.status).toBe(200);
  });
});
