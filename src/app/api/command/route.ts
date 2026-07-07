import type { NextRequest } from "next/server";
import { z } from "zod";
import { getHumanActor } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { apiError, json, readJson } from "@/lib/http";
import { runCommand } from "@/lib/command/router";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // tool loops + Hermes research take time

const schema = z.object({
  text: z.string().min(1).max(4000),
  via: z.enum(["web", "voice"]).optional(),
});

/**
 * POST /api/command {text} — the chat endpoint. Human-only: this surface
 * wields the decide tool, so agent tokens are rejected outright. Telegram
 * text/voice reach the same brain through the bot (allow-listed chat).
 */
export async function POST(req: NextRequest) {
  const human = await getHumanActor();
  if (!human) return apiError(401, "unauthorized — the command deck is human-only");

  const rl = rateLimit(`command:${human.email}`, { limit: 30, windowMs: 60_000 });
  if (!rl.allowed) return apiError(429, "rate limited");

  const body = await readJson(req);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return apiError(400, "invalid body", { issues: parsed.error.issues });

  const db = createAdminClient();
  try {
    const result = await runCommand(parsed.data.text, { db, via: parsed.data.via ?? "web" });
    return json(result);
  } catch (e) {
    return apiError(500, e instanceof Error ? e.message : "command failed");
  }
}
