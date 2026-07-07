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

export async function runCommand(text: string, ctx: CommandContext): Promise<CommandResult> {
  const { runCommandBrain } = await import("./brain");
  return runCommandBrain(text, ctx);
}
