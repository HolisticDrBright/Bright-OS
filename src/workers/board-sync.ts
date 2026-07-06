import type { SupabaseClient } from "@supabase/supabase-js";
import { renderCommandBoard, vaultConfigured, writeCommandBoard } from "@/lib/obsidian";

/**
 * Re-renders "Active Command Board.md" from the database into the vault.
 * The board is a VIEW of the DB — it can never go stale because it is
 * regenerated every 10 minutes and after Obsidian-driven syncs.
 */
export async function syncBoardNote(db: SupabaseClient, now = new Date()): Promise<boolean> {
  if (!vaultConfigured()) return false;
  const [tasks, agents, brands] = await Promise.all([
    db.from("tasks").select("*").order("updated_at", { ascending: false }).limit(500),
    db.from("agents").select("id,name"),
    db.from("brands").select("id,name"),
  ]);
  if (tasks.error) throw new Error(`board sync query failed: ${tasks.error.message}`);
  const md = renderCommandBoard({
    tasks: tasks.data ?? [],
    agents: agents.data ?? [],
    brands: brands.data ?? [],
    now,
  });
  await writeCommandBoard(md);
  return true;
}
