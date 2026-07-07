import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  extractResponseText,
  parseResearchJson,
  postSessionSummary,
  research,
  storeResearchAsTask,
} from "@/lib/hermes";
import { byTable, createMockDb, uuid } from "../helpers/harness";

const asDb = (m: unknown) => m as SupabaseClient;

beforeEach(() => {
  process.env.HERMES_URL = "http://hermes:8642";
  process.env.HERMES_API_KEY = "hermes-key";
});
afterEach(() => {
  delete process.env.HERMES_URL;
  delete process.env.HERMES_API_KEY;
});

describe("extractResponseText", () => {
  it("prefers output_text, falls back to nested output blocks", () => {
    expect(extractResponseText({ output_text: "hi" })).toBe("hi");
    expect(
      extractResponseText({ output: [{ content: [{ type: "output_text", text: "nested" }] }] }),
    ).toBe("nested");
  });
});

describe("parseResearchJson", () => {
  it("parses fenced JSON with claim field aliases", () => {
    const raw = [
      "Here you go:",
      "```json",
      JSON.stringify({
        task_title: "TB-500 EU regulatory status",
        summary: "…",
        claims: [
          { claim_text: "banned for sport by WADA", source_url: "https://wada.example/list" },
          { text: "no EU marketing authorization", url: null },
        ],
      }),
      "```",
    ].join("\n");
    const parsed = parseResearchJson(raw);
    expect(parsed.task_title).toBe("TB-500 EU regulatory status");
    expect(parsed.claims).toHaveLength(2);
    expect(parsed.claims[1].claim_text).toContain("EU marketing");
    expect(parsed.claims[1].source_url).toBeNull();
  });

  it("throws on JSON-free replies", () => {
    expect(() => parseResearchJson("I could not research that.")).toThrow();
  });
});

describe("research()", () => {
  it("POSTs to /v1/responses with bearer auth + session key", async () => {
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://hermes:8642/v1/responses");
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer hermes-key");
      expect(headers["x-hermes-session-key"]).toBe("brightos");
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            task_title: "X sentiment on peptide bans",
            summary: "sum",
            claims: [{ claim_text: "c1", source_url: "https://x.com/p/1" }],
          }),
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const out = await research("peptide ban sentiment", { fetchImpl: f });
    expect(out.claims[0].source_url).toBe("https://x.com/p/1");
  });

  it("fails loudly when Hermes is not configured", async () => {
    delete process.env.HERMES_URL;
    await expect(research("x")).rejects.toThrow("not configured");
  });
});

describe("storeResearchAsTask — the hallucination guardrail", () => {
  it("stores ALL claims verified=false and counts unsourced ones as flagged", async () => {
    let insertedClaims: Record<string, unknown>[] = [];
    const db = createMockDb(
      byTable({
        agents: () => ({ data: [{ id: uuid(10) }] }),
        tasks: () => ({ data: { id: uuid(1), title: "Research: x" } }),
        claims: (op) => {
          insertedClaims = op.payload as Record<string, unknown>[];
          return { data: [] };
        },
        heartbeat_events: () => ({ data: [] }),
      }),
    );
    const { flagged } = await storeResearchAsTask(asDb(db), "x", {
      task_title: "Research: x",
      summary: "s",
      claims: [
        { claim_text: "sourced", source_url: "https://src.example/1" },
        { claim_text: "unsourced", source_url: null },
        { claim_text: "blank url", source_url: "  " },
      ],
    });
    expect(insertedClaims).toHaveLength(3);
    expect(insertedClaims.every((c) => c.verified === false)).toBe(true);
    expect(insertedClaims[1].source_url).toBeNull();
    expect(insertedClaims[2].source_url).toBeNull();
    expect(flagged).toBe(2);
  });
});

describe("postSessionSummary", () => {
  it("no-ops without config, posts a memory turn with config", async () => {
    delete process.env.HERMES_URL;
    expect(await postSessionSummary("s")).toBe(false);

    process.env.HERMES_URL = "http://hermes:8642";
    process.env.HERMES_API_KEY = "k";
    const f = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.input).toContain("memory tool");
      expect(body.conversation).toBe("brightos-memory");
      return new Response(JSON.stringify({ output_text: "ack" }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await postSessionSummary("shipped /beta-access, approved SMS top-up", { fetchImpl: f })).toBe(
      true,
    );
    expect(f).toHaveBeenCalledOnce();
  });
});
