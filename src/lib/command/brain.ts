import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import { checkCostBreaker } from "@/lib/guardrails";
import { computeCostUsd, sumUsage, type UsageLike } from "@/lib/claude/pricing";
import { composeBriefing } from "@/workers/daily-briefing";
import { hermesConfigured, postSessionSummary, research, storeResearchAsTask } from "@/lib/hermes";
import { COMMAND_TOOLS, executeCommandTool } from "./tools";
import type { CommandContext, CommandResult } from "./router";

/**
 * THE REACTOR BRAIN — natural language → actions.
 *
 * claude-haiku-4-5 does the cheap intent classification; claude-sonnet-5
 * runs the tool-use loop (create_task, decide, query_metrics, search_memory,
 * assign_agent, brief). Guardrails live in code:
 *  - cost circuit breaker refuses commands over the daily cap
 *  - decide tool refuses medical/regulatory decisions (HUD/Telegram only)
 *  - every call is logged to agent_sessions with REAL token costs
 */

const SYSTEM_PROMPT = `You are BRIGHT OS, mission control for Dr. Brandon Bright's one-person, multi-brand business run by AI agents with human approval.

LANE RULES (non-negotiable — the API enforces them; never work around them):
- COWORK: analysis and drafts. CODEX: verification and board-keeping. OPENCLAW "JARVIS": execution — exactly ONE narrow WordPress/exec action per task. HERMES: memory and research. ALYSSA (VA): tasks only a human can do.
- Single-manager reporting: every task has exactly one assigned agent; agents never task each other.
- Nothing publishes without an approved decision. Tasks cannot reach verified with unverified claims; claims need a source_url.
- Medical/regulatory content ALWAYS requires human approval via the HUD or Telegram buttons. The decide tool refuses those — that is a code rule, not your judgment call.
- Never invent numbers: use query_metrics. Never claim work happened without a task trail.

BRANDS: Bright Family Clinic + AI Longevity Pro are the two focus engines. Quantum Mind, QCL, BDS run cron-tier (weekly digest max).

STYLE: HUD-terse. Lead with what changed or the answer. Use short lines, real numbers, no filler. When you take an action, state exactly what you did. If a request is ambiguous, ask one sharp question instead of guessing.`;

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (!cachedClient) cachedClient = new Anthropic({ apiKey: env.anthropicApiKey });
  return cachedClient;
}
/** Test hook. */
export function __resetAnthropicClient() {
  cachedClient = null;
}

export type Intent = "research" | "brief" | "action";

/** Cheap classification lane (claude-haiku-4-5). */
export async function classifyIntent(text: string): Promise<{ intent: Intent; usage: UsageLike }> {
  const response = await client().messages.create({
    model: env.classifyModel,
    max_tokens: 8,
    system:
      'Classify the operator command into exactly one word:\n"research" — asking to research/investigate/find information about a topic (external knowledge)\n"brief" — asking for the status rundown/briefing/summary of the business\n"action" — anything else (create/assign/approve/metrics/memory/chat)\nReply with ONLY the single word.',
    messages: [{ role: "user", content: text }],
  });
  const word = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()
    .toLowerCase();
  const intent: Intent = word.includes("research") ? "research" : word.includes("brief") ? "brief" : "action";
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
  await ctx.db.from("agent_sessions").insert({
    agent_id: null, // the OS core itself, not a fleet agent
    task_id: taskId,
    model,
    input_tokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
    output_tokens: usage.output_tokens ?? 0,
    cost_usd: costUsd,
    duration_s: Math.round(durationS * 100) / 100,
    started_at: new Date().toISOString(),
  });
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
  let intent: Intent = "action";
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

  // ACTION LANE → claude-sonnet-5 tool-use loop.
  const actions: CommandResult["actions"] = [];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: trimmed }];
  let reply = "";
  const model = env.commandModel;

  for (let turn = 0; turn < 6; turn++) {
    const response = await client().messages.create({
      model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
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

  return { reply: reply || "done (no reply text)", actions, cost_usd: costUsd };
}
