import type { CommandContext, CommandResult } from "./router";

/**
 * Placeholder — Phase 5 replaces this with the Claude tool-use loop
 * (create_task, decide, query_metrics, search_memory, assign_agent, brief).
 */
export async function runCommandBrain(_text: string, _ctx: CommandContext): Promise<CommandResult> {
  return {
    reply: "Command brain not wired yet (Phase 5). /brief and the approval buttons work already.",
    actions: [],
    cost_usd: 0,
  };
}
