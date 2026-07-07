import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DecisionVia } from "@/types/db";
import { decideDecision, normalizeAction } from "@/lib/decisions";
import { buildMetricsSummary } from "@/lib/metrics";
import { composeBriefing } from "@/workers/daily-briefing";
import { hermesConfigured } from "@/lib/hermes";
import { env } from "@/lib/env";

/**
 * The reactor brain's tool belt. Every guardrail here is CODE:
 *  - decide refuses medical/regulatory decisions outright (those are decided
 *    only via the HUD/Telegram buttons — hard rule, not model discretion)
 *  - task creation cannot mint verified/shipped work
 *  - metrics come from the database, never from the model's imagination
 */
export const COMMAND_TOOLS: Anthropic.Tool[] = [
  {
    name: "create_task",
    description:
      "Create a task on the command board. Lane rules: COWORK=analysis/drafts, CODEX=verification/board, OPENCLAW=execution (ONE narrow WordPress/exec action per task), HERMES=memory/research, MARISOL=human-only tasks.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short imperative task title, prefixed with brand when relevant" },
        brand: { type: "string", description: "Brand name fragment, e.g. 'AI Longevity Pro', 'QCL'" },
        agent: { type: "string", description: "Agent name/kind: codex|cowork|openclaw|hermes|va" },
        due_at: { type: "string", description: "ISO date (YYYY-MM-DD) when due, optional" },
      },
      required: ["title"],
    },
  },
  {
    name: "assign_agent",
    description: "Assign (or reassign) an existing task to an agent. Finds the task by title fragment.",
    input_schema: {
      type: "object",
      properties: {
        task_query: { type: "string", description: "Fragment of the task title (or task id)" },
        agent: { type: "string", description: "Agent name/kind to assign" },
      },
      required: ["task_query", "agent"],
    },
  },
  {
    name: "decide",
    description:
      "Approve/reject/discuss a PENDING decision on the operator's explicit instruction. REFUSES medical/regulatory decisions (those require the HUD/Telegram approve buttons). Only use when the operator clearly told you to decide something.",
    input_schema: {
      type: "object",
      properties: {
        decision_query: { type: "string", description: "Fragment of the decision title (or decision id)" },
        action: { type: "string", enum: ["approve", "reject", "discuss"] },
      },
      required: ["decision_query", "action"],
    },
  },
  {
    name: "query_metrics",
    description:
      "Fetch live metrics: burn today vs cap, 30d spend by model/agent, cost-per-outcome by brand, verification lane, revenue engines. Use this instead of guessing numbers.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "search_memory",
    description:
      "Search long-term memory: Hermes (full-session recall) plus the local daily memory log. Use for 'what did we learn/decide about X'.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "brief",
    description: "Compose the morning briefing (pending decisions by $-impact, shipped, burn, engines, alerts).",
    input_schema: { type: "object", properties: {} },
  },
];

export interface ToolContext {
  db: SupabaseClient;
  via: DecisionVia;
  fetchImpl?: typeof fetch;
}

type ToolInput = Record<string, unknown>;

export async function executeCommandTool(
  name: string,
  input: ToolInput,
  ctx: ToolContext,
): Promise<{ result: string; detail: string }> {
  switch (name) {
    case "create_task":
      return createTask(input, ctx);
    case "assign_agent":
      return assignAgent(input, ctx);
    case "decide":
      return decide(input, ctx);
    case "query_metrics": {
      const summary = await buildMetricsSummary(ctx.db);
      return { result: JSON.stringify(summary), detail: "metrics summary" };
    }
    case "search_memory":
      return searchMemory(String(input.query ?? ""), ctx);
    case "brief": {
      const briefing = await composeBriefing(ctx.db);
      return { result: briefing.markdown, detail: `briefing ${briefing.day}` };
    }
    default:
      return { result: `unknown tool: ${name}`, detail: "error" };
  }
}

async function resolveAgentId(db: SupabaseClient, term: string): Promise<string | null> {
  const { data } = await db.from("agents").select("id,name,kind");
  const t = term.toLowerCase();
  return (
    (data ?? []).find((a) => a.kind === t || a.name.toLowerCase().includes(t))?.id ?? null
  );
}

async function createTask(input: ToolInput, ctx: ToolContext) {
  const title = String(input.title ?? "").trim();
  if (!title) return { result: "error: title required", detail: "error" };

  let brandId: string | null = null;
  if (input.brand) {
    const { data } = await ctx.db.from("brands").select("id,name").ilike("name", `%${input.brand}%`).limit(1);
    brandId = data?.[0]?.id ?? null;
  }
  const agentId = input.agent ? await resolveAgentId(ctx.db, String(input.agent)) : null;

  const { data: task, error } = await ctx.db
    .from("tasks")
    .insert({
      title,
      brand_id: brandId,
      agent_id: agentId,
      status: agentId ? "assigned" : "backlog",
      source: "chat",
      due_at: input.due_at ? new Date(`${input.due_at}T12:00:00Z`).toISOString() : null,
      frontmatter: { created_via: ctx.via },
    })
    .select()
    .single();
  if (error) return { result: `error: ${error.message}`, detail: "error" };
  return {
    result: `task created: "${task.title}" [${task.status}]${agentId ? " and assigned" : ""} (id ${task.id})`,
    detail: `create_task:${task.id}`,
  };
}

async function assignAgent(input: ToolInput, ctx: ToolContext) {
  const agentId = await resolveAgentId(ctx.db, String(input.agent ?? ""));
  if (!agentId) return { result: `error: no agent matches "${input.agent}"`, detail: "error" };

  const q = String(input.task_query ?? "");
  const { data: tasks } = await ctx.db
    .from("tasks")
    .select("id,title,status")
    .ilike("title", `%${q}%`)
    .limit(5);
  if (!tasks || tasks.length === 0) return { result: `error: no task matches "${q}"`, detail: "error" };
  if (tasks.length > 1) {
    return {
      result: `ambiguous — ${tasks.length} tasks match: ${tasks.map((t) => t.title).join(" | ")}. Be more specific.`,
      detail: "ambiguous",
    };
  }
  const task = tasks[0];
  const patch: Record<string, unknown> = { agent_id: agentId };
  if (task.status === "backlog") patch.status = "assigned";
  const { error } = await ctx.db.from("tasks").update(patch).eq("id", task.id);
  if (error) return { result: `error: ${error.message}`, detail: "error" };
  return { result: `assigned "${task.title}" → ${input.agent}`, detail: `assign_agent:${task.id}` };
}

async function decide(input: ToolInput, ctx: ToolContext) {
  const action = normalizeAction(String(input.action ?? ""));
  if (!action) return { result: `error: unknown action "${input.action}"`, detail: "error" };

  const q = String(input.decision_query ?? "");
  const { data: matches } = await ctx.db
    .from("decisions")
    .select("*")
    .in("status", ["pending", "discuss"])
    .ilike("title", `%${q}%`)
    .limit(5);
  if (!matches || matches.length === 0) {
    return { result: `error: no pending decision matches "${q}"`, detail: "error" };
  }
  if (matches.length > 1) {
    return {
      result: `ambiguous — ${matches.length} pending decisions match: ${matches.map((d) => d.title).join(" | ")}. Be more specific.`,
      detail: "ambiguous",
    };
  }
  const decision = matches[0];

  // HARD RULE (code, not prompt): medical/regulatory content is never
  // decided through the chat brain.
  if ((decision.tags ?? []).includes("medical-regulatory")) {
    return {
      result:
        `REFUSED: "${decision.title}" is tagged medical/regulatory. It must be decided by a human tap on the HUD or Telegram approve buttons — the command brain cannot decide it.`,
      detail: "guardrail:medical-regulatory",
    };
  }

  const out = await decideDecision(ctx.db, { id: decision.id, action, via: ctx.via });
  if (!out.ok) return { result: `error: ${out.error}`, detail: "error" };
  return { result: `${action}: "${decision.title}"`, detail: `decide:${decision.id}:${action}` };
}

async function searchMemory(query: string, ctx: ToolContext) {
  const parts: string[] = [];

  const { data: logs } = await ctx.db
    .from("memory_log")
    .select("day,content_md")
    .ilike("content_md", `%${query}%`)
    .order("day", { ascending: false })
    .limit(5);
  if (logs && logs.length > 0) {
    parts.push(
      `LOCAL DAILY LOG:\n${logs.map((l) => `[${l.day}] ${l.content_md.slice(0, 300)}`).join("\n")}`,
    );
  }

  if (hermesConfigured()) {
    try {
      const f = ctx.fetchImpl ?? fetch;
      const res = await f(`${env.hermesUrl.replace(/\/$/, "")}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.hermesApiKey}`,
          "content-type": "application/json",
          "x-hermes-session-key": "brightos",
        },
        body: JSON.stringify({
          model: env.hermesModel,
          input: `Search your memory and session history for: "${query}". Reply with the most relevant facts, max 200 words. If nothing relevant, say "no memory".`,
          conversation: "brightos-memory",
        }),
      });
      if (res.ok) {
        const body = (await res.json()) as { output_text?: string };
        if (body.output_text) parts.push(`HERMES:\n${body.output_text}`);
      } else {
        parts.push(`HERMES: unreachable (${res.status})`);
      }
    } catch (e) {
      parts.push(`HERMES: unreachable (${e instanceof Error ? e.message : e})`);
    }
  }

  return {
    result: parts.length > 0 ? parts.join("\n\n") : "no memory found for that query",
    detail: `search_memory:${query.slice(0, 40)}`,
  };
}
