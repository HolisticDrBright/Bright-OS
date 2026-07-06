import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => import("../helpers/admin-mock"));
vi.mock("@/lib/auth", () => import("../helpers/auth-mock"));

import { GET, POST } from "@/app/api/tasks/[id]/claims/route";
import { PATCH } from "@/app/api/claims/[id]/route";
import { AGENT, HUMAN, authState, byTable, createMockDb, dbHolder, makeReq, uuid } from "../helpers/harness";

const TASK_ID = uuid(1);
const CLAIM_ID = uuid(7);
const taskCtx = { params: Promise.resolve({ id: TASK_ID }) };
const claimCtx = { params: Promise.resolve({ id: CLAIM_ID }) };

function claimRow(extra: Record<string, unknown> = {}) {
  return {
    id: CLAIM_ID,
    task_id: TASK_ID,
    agent_id: uuid(10),
    claim_text: "sitemap submitted to GSC",
    source_url: null,
    verified: false,
    verified_by: null,
    verified_at: null,
    ...extra,
  };
}

describe("POST /api/tasks/:id/claims", () => {
  it("stores claims as unverified and flags missing source_url", async () => {
    authState.actor = AGENT("hermes");
    let inserted: Record<string, unknown> | null = null;
    dbHolder.db = createMockDb(
      byTable({
        tasks: () => ({ data: { id: TASK_ID } }),
        claims: (op) => {
          if (op.method === "insert") {
            inserted = op.payload as Record<string, unknown>;
            return { data: claimRow() };
          }
          return undefined;
        },
      }),
    );
    const res = await POST(
      makeReq(`http://os/api/tasks/${TASK_ID}/claims`, {
        method: "POST",
        body: { claim_text: "sitemap submitted to GSC" },
      }),
      taskCtx,
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(inserted!.verified).toBe(false);
    expect(body.flagged).toBe(true); // no source_url → UI shows it flagged
  });

  it("404s for a claim on a missing task", async () => {
    authState.actor = HUMAN;
    dbHolder.db = createMockDb(byTable({ tasks: () => ({ data: null }) }));
    const res = await POST(
      makeReq(`http://os/api/tasks/${TASK_ID}/claims`, { method: "POST", body: { claim_text: "x" } }),
      taskCtx,
    );
    expect(res.status).toBe(404);
  });

  it("GET lists claims for a task", async () => {
    authState.actor = HUMAN;
    dbHolder.db = createMockDb(byTable({ claims: () => ({ data: [claimRow()] }) }));
    const res = await GET(makeReq(`http://os/api/tasks/${TASK_ID}/claims`), taskCtx);
    expect((await res.json()).claims).toHaveLength(1);
  });
});

describe("PATCH /api/claims/:id — verification", () => {
  it("GUARDRAIL: cannot verify a claim without source_url", async () => {
    authState.actor = HUMAN;
    dbHolder.db = createMockDb(byTable({ claims: () => ({ data: claimRow() }) }));
    const res = await PATCH(
      makeReq(`http://os/api/claims/${CLAIM_ID}`, { method: "PATCH", body: { verified: true } }),
      claimCtx,
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain("source_url");
  });

  it("verifies when source_url is provided in the same patch", async () => {
    authState.actor = AGENT("codex");
    let updated: Record<string, unknown> | null = null;
    dbHolder.db = createMockDb(
      byTable({
        claims: (op) => {
          if (op.method === "update") {
            updated = op.payload as Record<string, unknown>;
            return { data: claimRow({ verified: true, source_url: "https://example.com/x" }) };
          }
          return { data: claimRow() };
        },
      }),
    );
    const res = await PATCH(
      makeReq(`http://os/api/claims/${CLAIM_ID}`, {
        method: "PATCH",
        body: { verified: true, source_url: "https://example.com/x" },
      }),
      claimCtx,
    );
    expect(res.status).toBe(200);
    expect(updated!.verified_by).toBe("codex"); // actor recorded as verifier
  });

  it("verifies when the claim already has a source_url", async () => {
    authState.actor = HUMAN;
    dbHolder.db = createMockDb(
      byTable({
        claims: (op) =>
          op.method === "update"
            ? { data: claimRow({ verified: true, source_url: "https://example.com/y" }) }
            : { data: claimRow({ source_url: "https://example.com/y" }) },
      }),
    );
    const res = await PATCH(
      makeReq(`http://os/api/claims/${CLAIM_ID}`, { method: "PATCH", body: { verified: true } }),
      claimCtx,
    );
    expect(res.status).toBe(200);
  });

  it("cannot sneak verified=true while clearing source_url", async () => {
    authState.actor = HUMAN;
    dbHolder.db = createMockDb(
      byTable({ claims: () => ({ data: claimRow({ source_url: "https://example.com/y" }) }) }),
    );
    const res = await PATCH(
      makeReq(`http://os/api/claims/${CLAIM_ID}`, {
        method: "PATCH",
        body: { verified: true, source_url: null },
      }),
      claimCtx,
    );
    expect(res.status).toBe(422);
  });
});
