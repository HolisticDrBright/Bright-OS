import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => import("../helpers/admin-mock"));
vi.mock("@/lib/auth", () => import("../helpers/auth-mock"));

import { GET, PATCH, POST } from "@/app/api/brands/route";
import { AGENT, HUMAN, authState, byTable, createMockDb, dbHolder, makeReq, uuid } from "../helpers/harness";

const brand = { id: uuid(20), name: "AI Longevity Pro", tier: "engine", revenue_wtd: 2140, spend_wtd: 960, metrics: {} };

describe("/api/brands", () => {
  it("GET lists brands for any actor", async () => {
    authState.actor = AGENT("openclaw");
    dbHolder.db = createMockDb(byTable({ brands: () => ({ data: [brand] }) }));
    const res = await GET(makeReq("http://os/api/brands"));
    expect(res.status).toBe(200);
    expect((await res.json()).brands).toHaveLength(1);
  });

  it("PATCH updates WTD numbers; agents cannot change tiers", async () => {
    authState.actor = AGENT("openclaw");
    dbHolder.db = createMockDb(byTable({ brands: () => ({ data: brand }) }));
    const ok = await PATCH(
      makeReq("http://os/api/brands", { method: "PATCH", body: { id: brand.id, revenue_wtd: 9000 } }),
    );
    expect(ok.status).toBe(200);

    const forbidden = await PATCH(
      makeReq("http://os/api/brands", { method: "PATCH", body: { id: brand.id, tier: "engine" } }),
    );
    expect(forbidden.status).toBe(403);
  });

  it("POST is human-only", async () => {
    authState.actor = AGENT("hermes");
    dbHolder.db = createMockDb();
    const res = await POST(makeReq("http://os/api/brands", { method: "POST", body: { name: "New Brand" } }));
    expect(res.status).toBe(401);

    authState.actor = HUMAN;
    dbHolder.db = createMockDb(byTable({ brands: () => ({ data: brand }) }));
    const ok = await POST(makeReq("http://os/api/brands", { method: "POST", body: { name: "New Brand" } }));
    expect(ok.status).toBe(201);
  });
});
