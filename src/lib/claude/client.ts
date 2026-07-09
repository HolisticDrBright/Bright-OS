import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import type { UsageLike } from "./pricing";

/** Shared cached Anthropic client (brain, working memory, memory extractor). */
let cachedClient: Anthropic | null = null;
export function client(): Anthropic {
  if (!cachedClient) cachedClient = new Anthropic({ apiKey: env.anthropicApiKey });
  return cachedClient;
}
/** Test hook. */
export function __resetAnthropicClient() {
  cachedClient = null;
}

/**
 * Log an OS-core Claude call to agent_sessions with REAL token costs —
 * the guardrail is that every call is accounted for, including the small
 * memory-maintenance ones.
 */
export async function logOsSession(
  db: SupabaseClient,
  model: string,
  usage: UsageLike,
  costUsd: number,
  durationS: number,
  taskId: string | null = null,
) {
  await db.from("agent_sessions").insert({
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
