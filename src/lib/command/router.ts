import type { SupabaseClient } from "@supabase/supabase-js";
import type { DecisionVia } from "@/types/db";

/**
 * Entry point every surface (web chat, Telegram text, voice) uses to run a
 * natural-language command. Phase 5 implements the Claude tool-use brain in
 * ./brain — this router stays the stable seam so integrations don't care.
 */
export interface CommandResult {
  reply: string;
  actions: { tool: string; detail: string }[];
  cost_usd: number;
}

export type CommandContext = {
  db: SupabaseClient;
  via: DecisionVia;
  now?: Date;
};

/**
 * Streaming protocol (NDJSON): the brain emits these as it works so the HUD can
 * start rendering — and start speaking — on the first sentence instead of
 * waiting for the whole tool loop to finish.
 *  - status: a lane/progress note ("routing…", "HERMES researching…"); `lane`
 *    tells the client which path we took so it can decide how to speak.
 *  - delta:  a chunk of reply text as the model generates it.
 *  - action: a tool the brain just executed (create_task, decide, …).
 *  - done:   the final, authoritative result (replaces streamed text).
 *  - error:  the brain threw.
 */
export type StreamEvent =
  | { type: "status"; text: string; lane?: string }
  | { type: "delta"; text: string }
  | { type: "action"; tool: string; detail: string }
  | { type: "done"; reply: string; actions: CommandResult["actions"]; cost_usd: number }
  | { type: "error"; message: string };

export type CommandEmit = (e: StreamEvent) => void;

export async function runCommand(text: string, ctx: CommandContext): Promise<CommandResult> {
  const { runCommandBrain } = await import("./brain");
  return runCommandBrain(text, ctx);
}

/** Streaming variant — same brain, but emits {@link StreamEvent}s as it goes. */
export async function runCommandStream(
  text: string,
  ctx: CommandContext,
  emit: CommandEmit,
): Promise<CommandResult> {
  const { runCommandBrainStream } = await import("./brain");
  return runCommandBrainStream(text, ctx, emit);
}
