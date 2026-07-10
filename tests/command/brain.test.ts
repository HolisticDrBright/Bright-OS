import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@anthropic-ai/sdk", () => import("../helpers/anthropic-mock"));
vi.mock("@/lib/supabase/admin", () => import("../helpers/admin-mock"));
vi.mock("@/lib/auth", () => import("../helpers/auth-mock"));

import { runCommandBrain, runCommandBrainStream, classifyIntent, __drainBrainTasks } from "@/lib/command/brain";
import { computeCostUsd } from "@/lib/claude/pricing";
import type { StreamEvent } from "@/lib/command/router";
import { POST as COMMAND } from "@/app/api/command/route";
import { POST as COMMAND_STREAM } from "@/app/api/command/stream/route";
import {
  AGENT,
  HUMAN,
  anthropicState,
  authState,
  byTable,
  createMockDb,
  dbHolder,
  makeReq,
  uuid,
} from "../helpers/harness";

const asDb = (m: unknown) => m as SupabaseClient;

const USAGE = { input_tokens: 500, output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

const textResponse = (text: string, usage = USAGE) => ({
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  usage,
});

const toolUseResponse = (name: string, input: Record<string, unknown>, id = "tu_1") => ({
  content: [
    { type: "text", text: "on it" },
    { type: "tool_use", id, name, input },
  ],
  stop_reason: "tool_use",
  usage: USAGE,
});

function baseTables(overrides: Parameters<typeof byTable>[0] = {}) {
  return byTable({
    agent_sessions: (op) => (op.method === "insert" ? { data: [] } : { data: [{ cost_usd: 1 }] }),
    heartbeat_events: () => ({ data: [] }),
    decisions: () => ({ data: [] }),
    tasks: () => ({ data: [] }),
    brands: () => ({ data: [] }),
    agents: () => ({ data: [] }),
    memory_log: () => ({ data: [] }),
    working_memory: () => ({ data: null }),
    memories: () => ({ data: [] }),
    ...overrides,
  });
}

/** The reactor brain's system prompt is a two-block array; helpers to read it. */
type SystemBlocks = { type: string; text: string; cache_control?: { type: string } }[];
const systemOf = (req: Record<string, unknown>) => req.system as SystemBlocks;

// Drain fire-and-forget memory upkeep so it never bleeds across tests.
afterEach(() => __drainBrainTasks());

describe("cost pricing", () => {
  it("computes real token costs per model incl. cache tiers", () => {
    expect(computeCostUsd("claude-sonnet-5", { input_tokens: 1_000_000, output_tokens: 0 })).toBe(3);
    expect(computeCostUsd("claude-haiku-4-5", { input_tokens: 0, output_tokens: 1_000_000 })).toBe(5);
    expect(
      computeCostUsd("claude-sonnet-5", {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 1_000_000,
      }),
    ).toBe(0.3);
  });
});

describe("runCommandBrain", () => {
  it("refuses when the cost breaker is tripped — zero Claude calls", async () => {
    dbHolder.db = createMockDb(baseTables({ agent_sessions: () => ({ data: [{ cost_usd: 999 }] }) }));
    const out = await runCommandBrain("approve everything", { db: asDb(dbHolder.db), via: "web" });
    expect(out.reply).toContain("COST BREAKER");
    expect(anthropicState.requests).toHaveLength(0);
    expect(out.cost_usd).toBe(0);
  });

  it("/brief is a zero-token fast path", async () => {
    dbHolder.db = createMockDb(baseTables());
    const out = await runCommandBrain("/brief", { db: asDb(dbHolder.db), via: "telegram" });
    expect(out.reply).toContain("BRIGHT OS Briefing");
    expect(anthropicState.requests).toHaveLength(0);
    expect(out.cost_usd).toBe(0);
  });

  it("classifies with haiku then runs the sonnet tool loop; logs real costs", async () => {
    let insertedTask: Record<string, unknown> | null = null;
    let loggedSession: Record<string, unknown> | null = null;
    dbHolder.db = createMockDb(
      baseTables({
        agents: () => ({ data: [{ id: uuid(10), name: "COWORK", kind: "claude" }] }),
        brands: () => ({ data: [{ id: uuid(20), name: "QCL" }] }),
        tasks: (op) => {
          if (op.method === "insert") {
            insertedTask = op.payload as Record<string, unknown>;
            return { data: { id: uuid(1), title: insertedTask.title, status: insertedTask.status } };
          }
          return { data: [] };
        },
        agent_sessions: (op) => {
          if (op.method === "insert") {
            loggedSession = op.payload as Record<string, unknown>;
            return { data: [] };
          }
          return { data: [{ cost_usd: 1 }] }; // breaker query
        },
      }),
    );
    anthropicState.queue = [
      textResponse("action", { ...USAGE, input_tokens: 40, output_tokens: 2 }), // haiku classify
      toolUseResponse("create_task", { title: "QCL: peptide-safety FAQ", brand: "QCL", agent: "cowork" }),
      textResponse("Created: QCL: peptide-safety FAQ → COWORK"),
    ];

    const out = await runCommandBrain("have cowork draft the QCL peptide safety FAQ", {
      db: asDb(dbHolder.db),
      via: "web",
    });

    expect(anthropicState.requests[0].model).toBe("claude-haiku-4-5");
    expect(anthropicState.requests[1].model).toBe("claude-sonnet-5");
    // Two-block cached system prompt: static block (rules + brain files) carries
    // the cache breakpoint; the dynamic block ends with the personality checkpoint.
    const system = systemOf(anthropicState.requests[1]);
    expect(Array.isArray(system)).toBe(true);
    expect(system[0].text).toContain("LANE RULES");
    expect(system[0].text).toContain("PERSONALITY"); // hot-reloaded brain file present
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(system[1].text).toContain("VOICE CHECK");
    expect(system[1].cache_control).toBeUndefined();
    expect(insertedTask!.status).toBe("assigned");
    expect(insertedTask!.agent_id).toBe(uuid(10));
    expect(out.actions.map((a) => a.tool)).toContain("create_task");
    expect(out.reply).toContain("Created");
    expect(out.cost_usd).toBeGreaterThan(0);
    expect(loggedSession!.model).toBe("claude-sonnet-5");
    expect(Number(loggedSession!.cost_usd)).toBe(out.cost_usd);
  });

  it("HARD RULE: decide tool refuses medical/regulatory decisions", async () => {
    let decisionUpdated = false;
    dbHolder.db = createMockDb(
      baseTables({
        decisions: (op) => {
          if (op.method === "update") {
            decisionUpdated = true;
            return { data: [] };
          }
          return {
            data: [
              {
                id: uuid(5),
                title: "Publish BPC-157 dosing guide",
                status: "pending",
                tags: ["publish", "medical-regulatory"],
              },
            ],
          };
        },
      }),
    );
    anthropicState.queue = [
      textResponse("action", USAGE), // classify
      toolUseResponse("decide", { decision_query: "BPC-157", action: "approve" }),
      textResponse("Refused — medical/regulatory requires the approve buttons."),
    ];

    const out = await runCommandBrain("approve the BPC-157 dosing guide", {
      db: asDb(dbHolder.db),
      via: "web",
    });

    expect(decisionUpdated).toBe(false); // never touched the decision
    expect(out.actions.find((a) => a.tool === "decide")?.detail).toBe("guardrail:medical-regulatory");
    // the refusal came back to the model as the tool result
    const secondSonnetCall = anthropicState.requests[2];
    const toolResultMsg = (secondSonnetCall.messages as Record<string, unknown>[]).at(-1);
    expect(JSON.stringify(toolResultMsg)).toContain("REFUSED");
  });

  it("decide tool works for non-medical decisions via the human surface", async () => {
    let updatePayload: Record<string, unknown> | null = null;
    dbHolder.db = createMockDb(
      baseTables({
        decisions: (op) => {
          if (op.method === "update") {
            updatePayload = op.payload as Record<string, unknown>;
            return {
              data: { id: uuid(6), title: "Rotate SIGMA trading API key", status: "approved", task_id: null },
            };
          }
          if (op.filters.some((f) => f.op === "ilike")) {
            return {
              data: [
                { id: uuid(6), title: "Rotate SIGMA trading API key", status: "pending", tags: ["ops"] },
              ],
            };
          }
          return { data: { id: uuid(6), title: "Rotate SIGMA trading API key", status: "pending", tags: ["ops"] } };
        },
      }),
    );
    anthropicState.queue = [
      textResponse("action", USAGE),
      toolUseResponse("decide", { decision_query: "SIGMA", action: "approve" }),
      textResponse("Approved: key rotation."),
    ];
    const out = await runCommandBrain("approve the sigma key rotation", {
      db: asDb(dbHolder.db),
      via: "voice",
    });
    expect(updatePayload!.status).toBe("approved");
    expect(updatePayload!.decided_via).toBe("voice");
    expect(out.reply).toContain("Approved");
  });

  it("/research routes to HERMES and stores flagged claims", async () => {
    process.env.HERMES_URL = "http://hermes:8642";
    process.env.HERMES_API_KEY = "k";
    let claims: Record<string, unknown>[] = [];
    dbHolder.db = createMockDb(
      baseTables({
        agents: () => ({ data: [{ id: uuid(11) }] }),
        tasks: (op) =>
          op.method === "insert" ? { data: { id: uuid(2), title: "Research: X sentiment" } } : { data: [] },
        claims: (op) => {
          claims = op.payload as Record<string, unknown>[];
          return { data: [] };
        },
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              task_title: "X sentiment on peptide bans",
              summary: "mixed but trending negative",
              claims: [
                { claim_text: "WADA listed", source_url: "https://wada.example/x" },
                { claim_text: "unsourced rumor", source_url: null },
              ],
            }),
          }),
          { status: 200 },
        ),
      ),
    );

    const out = await runCommandBrain("/research X sentiment on peptide bans", {
      db: asDb(dbHolder.db),
      via: "web",
    });

    expect(claims).toHaveLength(2);
    expect(claims.every((c) => c.verified === false)).toBe(true);
    expect(out.reply).toContain("1 claim(s) arrived WITHOUT a source_url");
    expect(anthropicState.requests).toHaveLength(0); // research lane spends no Claude tokens

    vi.unstubAllGlobals();
    delete process.env.HERMES_URL;
    delete process.env.HERMES_API_KEY;
  });

  it("reports the research lane offline when Hermes is unconfigured", async () => {
    delete process.env.HERMES_URL;
    dbHolder.db = createMockDb(baseTables());
    const out = await runCommandBrain("/research anything", { db: asDb(dbHolder.db), via: "web" });
    expect(out.reply).toContain("not configured");
  });
});

describe("brain memory integration", () => {
  it("injects working memory + pinned memories into the dynamic block (chat lane)", async () => {
    dbHolder.db = createMockDb(
      baseTables({
        working_memory: (op) =>
          op.method === "select"
            ? {
                data: {
                  summary_md: "Doctor asked for espresso-length briefings.",
                  recent: [{ at: "t", you: "hello", os: "Good evening, Doctor." }],
                },
              }
            : { data: [] },
        memories: (op) =>
          op.method === "select"
            ? { data: [{ id: uuid(30), kind: "preference", content: "Dr. Bright prefers espresso.", importance: 5 }] }
            : { data: [] },
      }),
    );
    anthropicState.queue = [
      textResponse("chat", USAGE), // classify
      textResponse("As you were saying, Doctor."), // chat reply
    ];

    await runCommandBrain("anyway, where were we", { db: asDb(dbHolder.db), via: "web" });

    const system = systemOf(anthropicState.requests[1]);
    expect(system[0].cache_control).toEqual({ type: "ephemeral" }); // static block cached
    expect(system[1].text).toContain("WORKING MEMORY");
    expect(system[1].text).toContain("espresso-length briefings");
    expect(system[1].text).toContain("PINNED MEMORIES");
    expect(system[1].text).toContain("Dr. Bright prefers espresso.");
    expect(system[1].text).toContain("VOICE CHECK"); // anti-drift checkpoint, every call
    expect(system[1].text).toContain("CONVERSATIONAL TURN"); // chat note rides the dynamic block
  });

  it("remember tool stores a typed memory through the act lane", async () => {
    let inserted: Record<string, unknown> | null = null;
    dbHolder.db = createMockDb(
      baseTables({
        memories: (op) => {
          if (op.method === "insert") {
            inserted = op.payload as Record<string, unknown>;
            return { data: { id: uuid(31) } };
          }
          return { data: [] };
        },
      }),
    );
    anthropicState.queue = [
      textResponse("act", USAGE),
      toolUseResponse("remember", { kind: "preference", content: "Dr. Bright prefers espresso.", importance: 4 }),
      textResponse("Noted and remembered, Doctor."),
    ];

    const out = await runCommandBrain("remember that I prefer espresso", {
      db: asDb(dbHolder.db),
      via: "web",
    });

    expect(inserted!.kind).toBe("preference");
    expect(inserted!.content).toBe("Dr. Bright prefers espresso.");
    expect(out.actions.find((a) => a.tool === "remember")?.detail).toBe(`remember:${uuid(31)}`);
    expect(out.reply).toContain("remembered");
  });
});

describe("classifyIntent", () => {
  it("maps haiku's word to an intent", async () => {
    anthropicState.queue = [textResponse("research", USAGE)];
    const { intent } = await classifyIntent("look into TB-500 regulations in the EU");
    expect(intent).toBe("research");
    expect(anthropicState.requests[0].max_tokens).toBe(8);
  });

  it("recognizes a natural goodbye", async () => {
    anthropicState.queue = [textResponse("bye", USAGE)];
    const { intent } = await classifyIntent("thanks, that's all for tonight");
    expect(intent).toBe("bye");
  });
});

describe("POST /api/command", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is human-only (agents rejected)", async () => {
    authState.actor = AGENT("openclaw");
    dbHolder.db = createMockDb(baseTables());
    const res = await COMMAND(makeReq("http://os/api/command", { method: "POST", body: { text: "hi" } }));
    expect(res.status).toBe(401);
  });

  it("runs a command for the human operator", async () => {
    authState.actor = HUMAN;
    dbHolder.db = createMockDb(baseTables());
    const res = await COMMAND(
      makeReq("http://os/api/command", { method: "POST", body: { text: "/brief", via: "web" } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reply).toContain("Briefing");
  });
});

describe("runCommandBrainStream", () => {
  it("CHAT lane: streams text deltas, uses no tools, surfaces the lane", async () => {
    dbHolder.db = createMockDb(baseTables());
    anthropicState.queue = [
      textResponse("chat", { ...USAGE, input_tokens: 30, output_tokens: 2 }), // haiku classify (via create)
      textResponse("Doing great. Running the empire."), // conversational reply (via stream)
    ];
    const events: StreamEvent[] = [];
    const out = await runCommandBrainStream(
      "hey how's it going",
      { db: asDb(dbHolder.db), via: "web" },
      (e) => events.push(e),
    );

    const deltas = events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");
    expect(deltas).toBe("Doing great. Running the empire.");
    expect(events.some((e) => e.type === "status" && (e as { lane?: string }).lane === "chat")).toBe(true);
    expect(out.actions).toHaveLength(0);
    expect(out.reply).toContain("Doing great");
    const done = events.at(-1) as { type: string; timings?: { classify_ms?: number; first_delta_ms?: number; total_ms: number } };
    expect(done.type).toBe("done");
    // latency instrumentation rides the done event
    expect(typeof done.timings?.total_ms).toBe("number");
    expect(typeof done.timings?.classify_ms).toBe("number");
    expect(typeof done.timings?.first_delta_ms).toBe("number");
  });

  it("BYE lane: short in-character sign-off, no tools, and the OS doesn't take the last word", async () => {
    dbHolder.db = createMockDb(baseTables());
    anthropicState.queue = [
      textResponse("bye", USAGE), // classify
      textResponse("Goodnight, Doctor."), // sign-off (via stream)
    ];
    const events: StreamEvent[] = [];
    const out = await runCommandBrainStream(
      "thanks, that's all for tonight",
      { db: asDb(dbHolder.db), via: "voice" },
      (e) => events.push(e),
    );

    expect(events.some((e) => e.type === "status" && (e as { lane?: string }).lane === "bye")).toBe(true);
    const byeReq = anthropicState.requests[1];
    expect(byeReq.tools).toBeUndefined(); // tool-less — it cannot start new work
    expect(byeReq.max_tokens).toBe(64); // structurally incapable of a monologue
    expect(JSON.stringify(byeReq.system)).toContain("SIGN-OFF");
    expect(out.reply).toBe("Goodnight, Doctor.");
    expect(out.actions).toHaveLength(0);
  });

  it("ACT lane: streams a tool action then the final reply", async () => {
    let insertedTask: Record<string, unknown> | null = null;
    dbHolder.db = createMockDb(
      baseTables({
        agents: () => ({ data: [{ id: uuid(10), name: "COWORK", kind: "claude" }] }),
        brands: () => ({ data: [{ id: uuid(20), name: "QCL" }] }),
        tasks: (op) => {
          if (op.method === "insert") {
            insertedTask = op.payload as Record<string, unknown>;
            return { data: { id: uuid(1), title: insertedTask.title, status: insertedTask.status } };
          }
          return { data: [] };
        },
      }),
    );
    anthropicState.queue = [
      textResponse("act", USAGE), // classify (create)
      toolUseResponse("create_task", { title: "QCL: FAQ", brand: "QCL", agent: "cowork" }), // stream turn 1
      textResponse("Created: QCL: FAQ → COWORK"), // stream turn 2
    ];
    const events: StreamEvent[] = [];
    const out = await runCommandBrainStream(
      "have cowork draft the QCL FAQ",
      { db: asDb(dbHolder.db), via: "web" },
      (e) => events.push(e),
    );

    expect(insertedTask!.status).toBe("assigned");
    expect(events.some((e) => e.type === "action" && (e as { tool: string }).tool === "create_task")).toBe(true);
    expect(out.actions.map((a) => a.tool)).toContain("create_task");
    expect(out.reply).toContain("Created");
    expect(events.at(-1)?.type).toBe("done");
  });
});

describe("POST /api/command/stream", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is human-only (agents rejected)", async () => {
    authState.actor = AGENT("openclaw");
    dbHolder.db = createMockDb(baseTables());
    const res = await COMMAND_STREAM(
      makeReq("http://os/api/command/stream", { method: "POST", body: { text: "hi" } }),
    );
    expect(res.status).toBe(401);
  });

  it("streams NDJSON that ends in a done event", async () => {
    authState.actor = HUMAN;
    dbHolder.db = createMockDb(baseTables());
    const res = await COMMAND_STREAM(
      makeReq("http://os/api/command/stream", { method: "POST", body: { text: "/brief", via: "web" } }),
    );
    expect(res.status).toBe(200);
    const lines = (await res.text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as StreamEvent);
    const done = lines.at(-1);
    expect(done?.type).toBe("done");
    expect((done as { reply: string }).reply).toContain("Briefing");
  });
});
