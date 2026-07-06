import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => import("../helpers/admin-mock"));
vi.mock("@/lib/auth", () => import("../helpers/auth-mock"));

import { GET, POST } from "@/app/api/agents/route";
import { PATCH, DELETE } from "@/app/api/agents/[id]/route";
import { AGENT, HUMAN, authState, byTable, createMockDb, dbHolder, makeReq, uuid } from "../helpers/harness";

const ID = uuid(10);
const ctx = { params: Promise.resolve({ id: ID }) };
const agentRow = { id: ID, name: "CODEX", role: "VERIFIER", kind: "claude", status: "idle", endpoint_url: null };

describe("/api/agents", () => {
  it("GET lists agents for human or agent actors", async () => {
    authState.actor = AGENT("hermes");
    dbHolder.db = createMockDb(byTable({ agents: () => ({ data: [agentRow] }) }));
    const res = await GET(makeReq("http://os/api/agents"));
    expect(res.status).toBe(200);
    expect((await res.json()).agents).toHaveLength(1);
  });

  it("POST is human-only", async () => {
    authState.actor = AGENT("openclaw");
    dbHolder.db = createMockDb();
    const res = await POST(
      makeReq("http://os/api/agents", {
        method: "POST",
        body: { name: "ROGUE", role: "X", kind: "claude" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("POST validates kind enum", async () => {
    authState.actor = HUMAN;
    dbHolder.db = createMockDb();
    const res = await POST(
      makeReq("http://os/api/agents", { method: "POST", body: { name: "X", role: "Y", kind: "skynet" } }),
    );
    expect(res.status).toBe(400);
  });

  it("POST creates an agent", async () => {
    authState.actor = HUMAN;
    dbHolder.db = createMockDb(byTable({ agents: () => ({ data: agentRow }) }));
    const res = await POST(
      makeReq("http://os/api/agents", { method: "POST", body: { name: "CODEX", role: "VERIFIER", kind: "claude" } }),
    );
    expect(res.status).toBe(201);
  });
});

describe("/api/agents/:id", () => {
  it("agents may only PATCH their status — other fields are rejected", async () => {
    authState.actor = AGENT("openclaw");
    dbHolder.db = createMockDb(byTable({ agents: () => ({ data: agentRow }) }));

    const ok = await PATCH(
      makeReq(`http://os/api/agents/${ID}`, { method: "PATCH", body: { status: "working" } }),
      ctx,
    );
    expect(ok.status).toBe(200);

    const forbidden = await PATCH(
      makeReq(`http://os/api/agents/${ID}`, { method: "PATCH", body: { status: "working", role: "GOD-MODE" } }),
      ctx,
    );
    expect(forbidden.status).toBe(403);
  });

  it("DELETE is human-only (no destructive agent ops)", async () => {
    authState.actor = AGENT("openclaw");
    dbHolder.db = createMockDb();
    const res = await DELETE(makeReq(`http://os/api/agents/${ID}`, { method: "DELETE" }), ctx);
    expect(res.status).toBe(401);
  });
});
