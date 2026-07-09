import type Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import { checkCostBreaker } from "@/lib/guardrails";
import { client, logOsSession } from "@/lib/claude/client";
import { computeCostUsd, sumUsage, type UsageLike } from "@/lib/claude/pricing";
import { composeBriefing } from "@/workers/daily-briefing";
import { hermesConfigured, postSessionSummary, research, storeResearchAsTask } from "@/lib/hermes";
import { loadBrainFile } from "./brain-files";
import { extractMemories, topMemories } from "./brain-memory";
import { loadWorkingMemory, renderWorkingMemory, updateWorkingMemory } from "./working-memory";
import { COMMAND_TOOLS, executeCommandTool } from "./tools";
import type { CommandContext, CommandEmit, CommandResult } from "./router";

export { __resetAnthropicClient } from "@/lib/claude/client";

/**
 * THE REACTOR BRAIN — natural language → actions.
 *
 * claude-haiku-4-5 does the cheap intent classification; claude-sonnet-5
 * runs the tool-use loop (create_task, decide, query_metrics, search_memory,
 * remember, assign_agent, brief). Guardrails live in code:
 *  - cost circuit breaker refuses commands over the daily cap
 *  - decide tool refuses medical/regulatory decisions (HUD/Telegram only)
 *  - every call is logged to agent_sessions with REAL token costs
 *
 * THE PROMPT IS TWO BLOCKS (prompt caching — see usage.cache_read_input_tokens):
 *  1. STATIC, cache_control:ephemeral — hardcoded core rules + the editable
 *     brain files (PERSONALITY.md / SELF.md / KNOWLEDGE.md, hot-reloaded on
 *     save, vault copy preferred). Cached with the tools; ~90% cheaper after
 *     the first call in a 5-minute window.
 *  2. DYNAMIC — working memory (conversation continuity, persisted per
 *     surface), pinned long-term memories, and the personality checkpoint
 *     that keeps the voice in character on every single turn.
 */

const CORE_RULES = `You are BRIGHT OS ("Jarvis"), mission control for Dr. Brandon Bright's one-person, multi-brand business run by AI agents with human approval.

LANE RULES (non-negotiable — the API enforces them; never work around them):
- COWORK: analysis and drafts. CODEX: verification and board-keeping. OPENCLAW "JARVIS": execution — exactly ONE narrow WordPress/exec action per task. HERMES: memory and research. ALYSSA (VA): tasks only a human can do.
- Single-manager reporting: every task has exactly one assigned agent; agents never task each other.
- Nothing publishes without an approved decision. Tasks cannot reach verified with unverified claims; claims need a source_url.
- Medical/regulatory content ALWAYS requires human approval via the HUD or Telegram buttons. The decide tool refuses those — that is a code rule, not your judgment call.
- Never invent numbers: use query_metrics. Never claim work happened without a task trail.

VOICE: You have a voice channel. The operator can speak to you (the HUD mic, or Telegram voice notes transcribed to text) and your replies can be read aloud by text-to-speech. Never claim to be text-only or to lack a voice. Because a reply may be spoken, keep it short and easy to say.

The sections below — personality, self-knowledge, core knowledge — come from editable files that hot-reload; treat them as part of who you are.`;

/** The anti-drift checkpoint — re-asserted in the dynamic block on EVERY call. */
const VOICE_CHECK = `VOICE CHECK (every reply, however long the session): stay in character — BRIGHT OS, composed JARVIS register, dry wit, address the operator as "Doctor" where natural. Never generic-assistant voice ("As an AI…", "I'd be happy to…"). Never break character.`;

/**
 * Appended (dynamic block) for the CHAT fast-lane: casual turns that skip the
 * tool loop for a snappy back-and-forth. The hard rule is safety — with no
 * tools, the model must NOT invent live numbers or claim it did anything.
 */
const CHAT_NOTE = `CONVERSATIONAL TURN: This is casual conversation — reply directly and briefly, like talking out loud. You have NO tools this turn. Do NOT cite specific live business numbers, task counts, or metrics as if you looked them up, and do NOT claim any task/decision/action happened. If the operator actually wants an action taken or a real figure, tell them to say it plainly (e.g. "create a task…", "how many tasks are open") and the full brain will run it.`;

/**
 * Assemble the two-block system prompt. Block 1 is byte-stable between calls
 * (changes only when a brain file is edited) so it prompt-caches together with
 * the tool schemas; block 2 carries everything volatile.
 */
async function buildSystemBlocks(
  lane: "chat" | "act",
  dynamicSections: string[],
): Promise<Anthropic.TextBlockParam[]> {
  const [personality, self, knowledge] = await Promise.all([
    loadBrainFile("PERSONALITY.md"),
    loadBrainFile("SELF.md"),
    loadBrainFile("KNOWLEDGE.md"),
  ]);
  const staticText = [CORE_RULES, personality.trim(), self.trim(), knowledge.trim()]
    .filter(Boolean)
    .join("\n\n");
  const dynamic = [...dynamicSections, VOICE_CHECK];
  if (lane === "chat") dynamic.push(CHAT_NOTE);
  return [
    { type: "text", text: staticText, cache_control: { type: "ephemeral" } },
    { type: "text", text: dynamic.join("\n\n") },
  ];
}

/** Working memory + pinned memories for the dynamic block. Never blocks the brain. */
async function loadDynamicContext(ctx: CommandContext): Promise<string[]> {
  const sections: string[] = [];
  try {
    const [wm, pinned] = await Promise.all([
      loadWorkingMemory(ctx.db, ctx.via),
      topMemories(ctx.db, 6),
    ]);
    const wmText = renderWorkingMemory(wm);
    if (wmText) sections.push(wmText);
    if (pinned.length > 0) {
      sections.push(
        `PINNED MEMORIES (highest-importance long-term memories — use search_memory for more):\n${pinned
          .map((m) => `· [${m.kind}] ${m.content}`)
          .join("\n")}`,
      );
    }
  } catch {
    // memory must never take the brain down
  }
  return sections;
}

/**
 * After-turn memory upkeep, fire-and-forget: append the exchange to working
 * memory and run the everything-notable extractor. Failures are swallowed —
 * the reply already shipped. Tests can await __drainBrainTasks().
 */
const pendingBrainTasks: Promise<unknown>[] = [];
function afterTurn(ctx: CommandContext, operatorText: string, reply: string) {
  const task = Promise.allSettled([
    updateWorkingMemory(ctx.db, ctx.via, operatorText, reply),
    extractMemories(ctx.db, { operator: operatorText, reply, via: ctx.via }),
  ]);
  pendingBrainTasks.push(task);
}
/** Test hook: wait for fire-and-forget memory upkeep to settle. */
export async function __drainBrainTasks() {
  const tasks = pendingBrainTasks.splice(0);
  await Promise.allSettled(tasks);
}

export type Intent = "research" | "brief" | "chat" | "act";

/** Cheap classification lane (claude-haiku-4-5). */
export async function classifyIntent(text: string): Promise<{ intent: Intent; usage: UsageLike }> {
  const response = await client().messages.create({
    model: env.classifyModel,
    max_tokens: 8,
    system:
      'Classify the operator\'s message into exactly one word:\n"research" — asking to research/investigate/find external information about a topic\n"brief" — asking for the status rundown/briefing/summary of the business\n"chat" — casual conversation: greetings, opinions, small talk, or questions about you and what you can do — needs NO action and NO live business data\n"act" — needs a real action (create/assign/approve/move a task or decision) OR any real business number, metric, or memory lookup\nWhen unsure between "chat" and "act", choose "act".\nReply with ONLY the single word.',
    messages: [{ role: "user", content: text }],
  });
  const word = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()
    .toLowerCase();
  const intent: Intent = word.includes("research")
    ? "research"
    : word.includes("brief")
      ? "brief"
      : word.includes("chat")
        ? "chat"
        : "act"; // default/ambiguous → the guardrailed tool lane, never the tool-less chat lane
  return { intent, usage: response.usage };
}

async function logSession(
  ctx: CommandContext,
  model: string,
  usage: UsageLike,
  costUsd: number,
  durationS: number,
  taskId: string | null = null,
) {
  await logOsSession(ctx.db, model, usage, costUsd, durationS, taskId);
}

export async function runCommandBrain(text: string, ctx: CommandContext): Promise<CommandResult> {
  const started = Date.now();
  const trimmed = text.trim();
  if (!trimmed) return { reply: "empty command", actions: [], cost_usd: 0 };

  // Circuit breaker: over the daily cap, the brain stops spending.
  const breaker = await checkCostBreaker(ctx.db);
  if (breaker.tripped) {
    return {
      reply: `⛔ COST BREAKER: $${breaker.spentTodayUsd.toFixed(2)} spent ≥ $${breaker.capUsd} daily cap. Workers and the command brain are paused until midnight PT. Raise DAILY_COST_CAP_USD if this is intentional.`,
      actions: [{ tool: "circuit-breaker", detail: "refused" }],
      cost_usd: 0,
    };
  }

  // Slash-command fast paths (zero tokens).
  if (/^\/brief\b/i.test(trimmed)) {
    const briefing = await composeBriefing(ctx.db);
    return { reply: briefing.markdown, actions: [{ tool: "brief", detail: briefing.day }], cost_usd: 0 };
  }
  const slashResearch = /^\/research\s+(.+)/i.exec(trimmed);

  let usage: UsageLike = {};
  let haikuCost = 0;
  let intent: Intent = "act";
  let researchQuery: string | null = slashResearch?.[1]?.trim() ?? null;

  if (!researchQuery && !trimmed.startsWith("/")) {
    const c = await classifyIntent(trimmed);
    intent = c.intent;
    haikuCost = computeCostUsd(env.classifyModel, c.usage);
    usage = sumUsage(usage, c.usage);
    if (intent === "research") researchQuery = trimmed;
  }

  // RESEARCH LANE → HERMES (results come back as a task with claims[]).
  if (researchQuery) {
    if (!hermesConfigured()) {
      const reply = "HERMES is not configured (set HERMES_URL + HERMES_API_KEY) — research lane offline.";
      await logSession(ctx, env.classifyModel, usage, haikuCost, (Date.now() - started) / 1000);
      return { reply, actions: [{ tool: "research", detail: "hermes-offline" }], cost_usd: haikuCost };
    }
    try {
      const result = await research(researchQuery);
      const stored = await storeResearchAsTask(ctx.db, researchQuery, result);
      await logSession(ctx, env.classifyModel, usage, haikuCost, (Date.now() - started) / 1000, stored.taskId);
      const flaggedNote =
        stored.flagged > 0
          ? `\n⚑ ${stored.flagged} claim(s) arrived WITHOUT a source_url — stored flagged (verified=false, cannot verify until sourced).`
          : "";
      return {
        reply: `HERMES research complete → task "${result.task_title}" with ${result.claims.length} claims (all pending CODEX verification).${flaggedNote}\n\n${result.summary}`,
        actions: [{ tool: "research", detail: stored.taskId }],
        cost_usd: haikuCost,
      };
    } catch (e) {
      await logSession(ctx, env.classifyModel, usage, haikuCost, (Date.now() - started) / 1000);
      return {
        reply: `HERMES research failed: ${e instanceof Error ? e.message : e}`,
        actions: [{ tool: "research", detail: "error" }],
        cost_usd: haikuCost,
      };
    }
  }

  if (intent === "brief") {
    const briefing = await composeBriefing(ctx.db);
    await logSession(ctx, env.classifyModel, usage, haikuCost, (Date.now() - started) / 1000);
    return { reply: briefing.markdown, actions: [{ tool: "brief", detail: briefing.day }], cost_usd: haikuCost };
  }

  const dynamicContext = await loadDynamicContext(ctx);

  // CHAT LANE → one tool-less claude-sonnet-5 call (fast conversational reply).
  if (intent === "chat") {
    const response = await client().messages.create({
      model: env.commandModel,
      max_tokens: 1024,
      system: await buildSystemBlocks("chat", dynamicContext),
      messages: [{ role: "user", content: trimmed }],
    });
    usage = sumUsage(usage, response.usage);
    const reply = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    const costUsd = haikuCost + computeCostUsd(env.commandModel, usage);
    await logSession(ctx, env.commandModel, usage, costUsd, (Date.now() - started) / 1000);
    afterTurn(ctx, trimmed, reply);
    return { reply: reply || "…", actions: [], cost_usd: costUsd };
  }

  // ACT LANE → claude-sonnet-5 tool-use loop.
  const systemBlocks = await buildSystemBlocks("act", dynamicContext);
  const actions: CommandResult["actions"] = [];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: trimmed }];
  let reply = "";
  const model = env.commandModel;

  for (let turn = 0; turn < 6; turn++) {
    const response = await client().messages.create({
      model,
      max_tokens: 2048,
      system: systemBlocks,
      tools: COMMAND_TOOLS,
      messages,
    });
    usage = sumUsage(usage, response.usage);

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const texts = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text");
    if (texts.length > 0) reply = texts.map((t) => t.text).join("\n").trim();

    if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const { result, detail } = await executeCommandTool(
        tu.name,
        tu.input as Record<string, unknown>,
        { db: ctx.db, via: ctx.via },
      );
      actions.push({ tool: tu.name, detail });
      results.push({ type: "tool_result", tool_use_id: tu.id, content: result });
    }
    messages.push({ role: "user", content: results });
  }

  const costUsd = haikuCost + computeCostUsd(model, usage);
  await logSession(ctx, model, usage, costUsd, (Date.now() - started) / 1000);
  await recordActLane(ctx, trimmed, actions, reply, costUsd);
  afterTurn(ctx, trimmed, reply);

  return { reply: reply || "done (no reply text)", actions, cost_usd: costUsd };
}

/** Shared act-lane tail: the audit heartbeat + fire-and-forget memory growth. */
async function recordActLane(
  ctx: CommandContext,
  trimmed: string,
  actions: CommandResult["actions"],
  reply: string,
  costUsd: number,
) {
  await ctx.db.from("heartbeat_events").insert({
    source: "COMMAND",
    message: `command via ${ctx.via}: ${trimmed.slice(0, 80)}${actions.length ? ` → ${actions.map((a) => a.tool).join(",")}` : ""}`,
    severity: "info",
    meta: { via: ctx.via, actions, cost_usd: costUsd },
  });

  // Grow Hermes' curated memory with this session (fire-and-forget).
  postSessionSummary(
    `BRIGHT OS command session (${new Date().toISOString().slice(0, 16)}, via ${ctx.via})\nOperator: ${trimmed}\nActions: ${actions.map((a) => `${a.tool}(${a.detail})`).join(", ") || "none"}\nReply: ${reply.slice(0, 400)}`,
  ).catch(() => {});
}

/** Progress label for the lane we're about to run (shown in the HUD). */
function laneStatus(intent: Intent, researchQuery: string | null): string {
  if (researchQuery) return "HERMES researching…";
  if (intent === "brief") return "composing briefing…";
  if (intent === "chat") return "…";
  return "thinking…";
}

/**
 * Streaming variant of the reactor brain — identical lanes and guardrails, but
 * it emits {@link CommandEmit} events as it works so the HUD can render, and
 * start speaking, the first sentence while the rest is still generating.
 *
 * TTS strategy lives on the client: the CHAT lane streams text deltas and the
 * HUD speaks them sentence-by-sentence; the ACT lane streams deltas for the
 * live "typing" feel but the client speaks the final reply once, so it never
 * reads intermediate tool-loop chatter aloud.
 */
export async function runCommandBrainStream(
  text: string,
  ctx: CommandContext,
  emit: CommandEmit,
): Promise<CommandResult> {
  const started = Date.now();
  const trimmed = text.trim();
  const finish = (r: CommandResult): CommandResult => {
    emit({ type: "done", reply: r.reply, actions: r.actions, cost_usd: r.cost_usd });
    return r;
  };

  if (!trimmed) return finish({ reply: "empty command", actions: [], cost_usd: 0 });

  // Circuit breaker: over the daily cap, the brain stops spending.
  const breaker = await checkCostBreaker(ctx.db);
  if (breaker.tripped) {
    return finish({
      reply: `⛔ COST BREAKER: $${breaker.spentTodayUsd.toFixed(2)} spent ≥ $${breaker.capUsd} daily cap. Workers and the command brain are paused until midnight PT. Raise DAILY_COST_CAP_USD if this is intentional.`,
      actions: [{ tool: "circuit-breaker", detail: "refused" }],
      cost_usd: 0,
    });
  }

  // Slash-command fast paths (zero tokens).
  if (/^\/brief\b/i.test(trimmed)) {
    emit({ type: "status", text: "composing briefing…", lane: "brief" });
    const briefing = await composeBriefing(ctx.db);
    return finish({ reply: briefing.markdown, actions: [{ tool: "brief", detail: briefing.day }], cost_usd: 0 });
  }
  const slashResearch = /^\/research\s+(.+)/i.exec(trimmed);

  let usage: UsageLike = {};
  let haikuCost = 0;
  let intent: Intent = "act";
  let researchQuery: string | null = slashResearch?.[1]?.trim() ?? null;

  if (!researchQuery && !trimmed.startsWith("/")) {
    emit({ type: "status", text: "routing…" });
    const c = await classifyIntent(trimmed);
    intent = c.intent;
    haikuCost = computeCostUsd(env.classifyModel, c.usage);
    usage = sumUsage(usage, c.usage);
    if (intent === "research") researchQuery = trimmed;
  }
  emit({ type: "status", text: laneStatus(intent, researchQuery), lane: researchQuery ? "research" : intent });

  // RESEARCH LANE → HERMES (results come back as a task with claims[]).
  if (researchQuery) {
    if (!hermesConfigured()) {
      await logSession(ctx, env.classifyModel, usage, haikuCost, (Date.now() - started) / 1000);
      return finish({
        reply: "HERMES is not configured (set HERMES_URL + HERMES_API_KEY) — research lane offline.",
        actions: [{ tool: "research", detail: "hermes-offline" }],
        cost_usd: haikuCost,
      });
    }
    try {
      const result = await research(researchQuery);
      const stored = await storeResearchAsTask(ctx.db, researchQuery, result);
      await logSession(ctx, env.classifyModel, usage, haikuCost, (Date.now() - started) / 1000, stored.taskId);
      const flaggedNote =
        stored.flagged > 0
          ? `\n⚑ ${stored.flagged} claim(s) arrived WITHOUT a source_url — stored flagged (verified=false, cannot verify until sourced).`
          : "";
      return finish({
        reply: `HERMES research complete → task "${result.task_title}" with ${result.claims.length} claims (all pending CODEX verification).${flaggedNote}\n\n${result.summary}`,
        actions: [{ tool: "research", detail: stored.taskId }],
        cost_usd: haikuCost,
      });
    } catch (e) {
      await logSession(ctx, env.classifyModel, usage, haikuCost, (Date.now() - started) / 1000);
      return finish({
        reply: `HERMES research failed: ${e instanceof Error ? e.message : e}`,
        actions: [{ tool: "research", detail: "error" }],
        cost_usd: haikuCost,
      });
    }
  }

  if (intent === "brief") {
    const briefing = await composeBriefing(ctx.db);
    await logSession(ctx, env.classifyModel, usage, haikuCost, (Date.now() - started) / 1000);
    return finish({ reply: briefing.markdown, actions: [{ tool: "brief", detail: briefing.day }], cost_usd: haikuCost });
  }

  const dynamicContext = await loadDynamicContext(ctx);

  // CHAT LANE → one tool-less streamed call. Deltas flow to the HUD, which
  // speaks them sentence-by-sentence for a conversational back-and-forth.
  if (intent === "chat") {
    const stream = client().messages.stream({
      model: env.commandModel,
      max_tokens: 1024,
      system: await buildSystemBlocks("chat", dynamicContext),
      messages: [{ role: "user", content: trimmed }],
    });
    let reply = "";
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        reply += ev.delta.text;
        emit({ type: "delta", text: ev.delta.text });
      }
    }
    const final = await stream.finalMessage();
    usage = sumUsage(usage, final.usage);
    const costUsd = haikuCost + computeCostUsd(env.commandModel, usage);
    await logSession(ctx, env.commandModel, usage, costUsd, (Date.now() - started) / 1000);
    afterTurn(ctx, trimmed, reply.trim());
    return finish({ reply: reply.trim() || "…", actions: [], cost_usd: costUsd });
  }

  // ACT LANE → claude-sonnet-5 streamed tool-use loop.
  const systemBlocks = await buildSystemBlocks("act", dynamicContext);
  const actions: CommandResult["actions"] = [];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: trimmed }];
  let reply = "";
  const model = env.commandModel;

  for (let turn = 0; turn < 6; turn++) {
    if (turn > 0) emit({ type: "status", text: "working…", lane: "act" });
    const stream = client().messages.stream({
      model,
      max_tokens: 2048,
      system: systemBlocks,
      tools: COMMAND_TOOLS,
      messages,
    });
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        emit({ type: "delta", text: ev.delta.text });
      }
    }
    const response = await stream.finalMessage();
    usage = sumUsage(usage, response.usage);

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const texts = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text");
    if (texts.length > 0) reply = texts.map((t) => t.text).join("\n").trim();

    if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const { result, detail } = await executeCommandTool(
        tu.name,
        tu.input as Record<string, unknown>,
        { db: ctx.db, via: ctx.via },
      );
      actions.push({ tool: tu.name, detail });
      emit({ type: "action", tool: tu.name, detail });
      results.push({ type: "tool_result", tool_use_id: tu.id, content: result });
    }
    messages.push({ role: "user", content: results });
  }

  const costUsd = haikuCost + computeCostUsd(model, usage);
  await logSession(ctx, model, usage, costUsd, (Date.now() - started) / 1000);
  await recordActLane(ctx, trimmed, actions, reply, costUsd);
  afterTurn(ctx, trimmed, reply);

  return finish({ reply: reply || "done (no reply text)", actions, cost_usd: costUsd });
}
