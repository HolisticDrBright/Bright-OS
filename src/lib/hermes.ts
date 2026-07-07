import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

/**
 * HERMES bridge — self-hosted github.com/nousresearch/hermes-agent.
 *
 * Talks to the Hermes gateway's OpenAI-compatible API server
 * (API_SERVER_ENABLED=true, port 8642, `Authorization: Bearer API_SERVER_KEY`).
 * Memory writes are agent-mediated: hermes-agent has no REST memory-push
 * endpoint, so we send a turn through /v1/responses and its own memory tool
 * persists it (X-Hermes-Session-Key scopes long-term memory to BRIGHT OS).
 * Research goes through the same surface; Hermes has first-class x_search.
 */
export function hermesConfigured(): boolean {
  return Boolean(process.env.HERMES_URL && process.env.HERMES_API_KEY);
}

const SESSION_KEY = "brightos";

interface ResponsesReply {
  output_text?: string;
  output?: { content?: { type?: string; text?: string }[] }[];
}

export function extractResponseText(body: ResponsesReply): string {
  if (typeof body.output_text === "string" && body.output_text.length > 0) return body.output_text;
  const parts: string[] = [];
  for (const item of body.output ?? []) {
    for (const c of item.content ?? []) {
      if (typeof c.text === "string") parts.push(c.text);
    }
  }
  return parts.join("\n");
}

async function hermesResponses(
  input: string,
  opts?: { fetchImpl?: typeof fetch; conversation?: string },
): Promise<string> {
  const f = opts?.fetchImpl ?? fetch;
  const res = await f(`${env.hermesUrl.replace(/\/$/, "")}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.hermesApiKey}`,
      "content-type": "application/json",
      "x-hermes-session-key": SESSION_KEY,
    },
    body: JSON.stringify({
      model: env.hermesModel,
      input,
      ...(opts?.conversation ? { conversation: opts.conversation } : {}),
    }),
  });
  if (!res.ok) throw new Error(`hermes /v1/responses failed: ${res.status}`);
  return extractResponseText((await res.json()) as ResponsesReply);
}

/**
 * (a) After any BRIGHT OS chat session: grow Hermes' curated memory.
 * Fire-and-forget from callers.
 */
export async function postSessionSummary(
  summary: string,
  opts?: { fetchImpl?: typeof fetch },
): Promise<boolean> {
  if (!hermesConfigured()) return false;
  await hermesResponses(
    [
      "You are the long-term memory lane for BRIGHT OS (Dr. Bright's mission control).",
      "Store the following session summary using your memory tool, condensing to the durable facts.",
      "Do not reply with anything except a one-line acknowledgement.",
      "",
      summary,
    ].join("\n"),
    { fetchImpl: opts?.fetchImpl, conversation: "brightos-memory" },
  );
  return true;
}

export interface HermesResearch {
  summary: string;
  claims: { claim_text: string; source_url: string | null }[];
  task_title: string;
}

/** Strict-JSON extraction with fenced-block tolerance. */
export function parseResearchJson(raw: string): HermesResearch {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)?.[1] ?? raw;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("hermes research reply contained no JSON object");
  const parsed = JSON.parse(fenced.slice(start, end + 1)) as {
    summary?: unknown;
    task_title?: unknown;
    claims?: { claim_text?: string; text?: string; source_url?: string | null; url?: string | null }[];
  };
  return {
    summary: String(parsed.summary ?? "").trim(),
    task_title: String(parsed.task_title ?? "Research results").trim(),
    claims: (parsed.claims ?? []).map((c) => ({
      claim_text: String(c.claim_text ?? c.text ?? "").trim(),
      source_url: (c.source_url ?? c.url ?? null) as string | null,
    })),
  };
}

/**
 * (b) Research lane: query → Hermes (x_search + web_search) → task + claims.
 * GUARDRAIL: every claim is stored verified=false; claims arriving without a
 * source_url can never flip verified and the HUD shows them flagged.
 */
export async function research(
  query: string,
  opts?: { fetchImpl?: typeof fetch },
): Promise<HermesResearch> {
  if (!hermesConfigured()) throw new Error("Hermes is not configured (HERMES_URL / HERMES_API_KEY)");
  const raw = await hermesResponses(
    [
      "You are the research lane for BRIGHT OS. Research the following query.",
      "Use x_search for X/Twitter signal and web_search for the open web.",
      "Reply with STRICT JSON only, no prose, matching exactly:",
      '{"task_title": string, "summary": string (markdown, <=400 words),',
      ' "claims": [{"claim_text": string, "source_url": string|null}]}',
      "Every factual claim MUST carry the URL it came from; use null only when you truly have no source.",
      "",
      `QUERY: ${query}`,
    ].join("\n"),
    { fetchImpl: opts?.fetchImpl },
  );
  return parseResearchJson(raw);
}

/** Persist a research result as a task with claims[] (the hallucination gate). */
export async function storeResearchAsTask(
  db: SupabaseClient,
  query: string,
  result: HermesResearch,
): Promise<{ taskId: string; flagged: number }> {
  const { data: hermesAgent } = await db.from("agents").select("id").eq("kind", "hermes").limit(1);
  const agentId = hermesAgent?.[0]?.id ?? null;

  const { data: task, error } = await db
    .from("tasks")
    .insert({
      title: result.task_title || `Research: ${query.slice(0, 80)}`,
      agent_id: agentId,
      status: agentId ? "assigned" : "backlog",
      source: "chat",
      frontmatter: { hermes_research: true, query, summary: result.summary },
    })
    .select()
    .single();
  if (error) throw new Error(`research task insert failed: ${error.message}`);

  let flagged = 0;
  if (result.claims.length > 0) {
    const rows = result.claims
      .filter((c) => c.claim_text)
      .map((c) => {
        const source = c.source_url && String(c.source_url).trim() ? String(c.source_url).trim() : null;
        if (!source) flagged += 1;
        return {
          task_id: task.id,
          agent_id: agentId,
          claim_text: c.claim_text,
          source_url: source,
          verified: false, // ALWAYS — verification is CODEX's lane
        };
      });
    const { error: claimErr } = await db.from("claims").insert(rows);
    if (claimErr) throw new Error(`research claims insert failed: ${claimErr.message}`);
  }

  await db.from("heartbeat_events").insert({
    source: "HERMES",
    message: `research complete: ${result.task_title} (${result.claims.length} claims, ${flagged} unsourced)`,
    severity: flagged > 0 ? "warn" : "info",
    meta: { task_id: task.id, query, flagged },
  });

  return { taskId: task.id, flagged };
}
