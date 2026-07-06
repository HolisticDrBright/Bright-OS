import "dotenv/config";
import cron from "node-cron";
import { createAdminClient } from "@/lib/supabase/admin";
import { runHeartbeat } from "./heartbeat";
import { runDailyBriefing } from "./daily-briefing";
import { runWeeklyCloseout } from "./weekly-closeout";
import { runNightlyBackup, runWeeklyOffsite } from "./backup";
import { syncBoardNote } from "./board-sync";

/**
 * BRIGHT OS worker process (pm2/compose service `workers`).
 *   every 30 min      heartbeat (5 checks, batched)
 *   06:00 daily       briefing                  (America/Los_Angeles)
 *   Fri 16:00         weekly closeout           (America/Los_Angeles)
 *   01:30 daily       nightly pg_dump → storage (America/Los_Angeles)
 *   Sun 01:45         weekly off-site copy      (America/Los_Angeles)
 *   every 10 min      Active Command Board.md re-render
 */
const TZ = "America/Los_Angeles";

function guard(name: string, fn: () => Promise<unknown>): () => void {
  return () => {
    fn().catch(async (e) => {
      console.error(`[workers] ${name} failed:`, e);
      try {
        await createAdminClient()
          .from("heartbeat_events")
          .insert({
            source: "WORKER",
            message: `${name} crashed: ${e instanceof Error ? e.message : e}`,
            severity: "warn",
            meta: { worker: name },
          });
      } catch {
        /* db down — nothing else to do */
      }
    });
  };
}

function main() {
  const db = createAdminClient();
  console.log("[workers] BRIGHT OS workers online");

  cron.schedule("*/30 * * * *", guard("heartbeat", () => runHeartbeat(db)), { timezone: TZ });
  cron.schedule("0 6 * * *", guard("daily-briefing", () => runDailyBriefing(db)), { timezone: TZ });
  cron.schedule("0 16 * * 5", guard("weekly-closeout", () => runWeeklyCloseout(db)), { timezone: TZ });
  cron.schedule("30 1 * * *", guard("nightly-backup", () => runNightlyBackup(db)), { timezone: TZ });
  cron.schedule("45 1 * * 0", guard("weekly-offsite", () => runWeeklyOffsite(db)), { timezone: TZ });
  cron.schedule("*/10 * * * *", guard("board-sync", () => syncBoardNote(db)), { timezone: TZ });

  // one beat + board render at boot so a fresh deploy is immediately live
  guard("heartbeat", () => runHeartbeat(db))();
  guard("board-sync", () => syncBoardNote(db))();
}

main();
