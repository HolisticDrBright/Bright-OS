import type { NextRequest } from "next/server";
import { z } from "zod";
import { getHumanActor } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { apiError, json, readJson } from "@/lib/http";
import { decideDecision, normalizeAction } from "@/lib/decisions";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const schema = z.object({
  action: z.string(),
  via: z.enum(["web", "telegram", "voice"]).optional(),
});

/**
 * POST /api/decisions/:id/decide {action, via}
 *
 * HARD RULE (code, not prompt): only the authenticated human can decide.
 * Agent tokens are rejected outright. Telegram taps arrive through the
 * webhook route which verifies the allow-listed chat id and calls
 * decideDecision() directly — they never pass through here.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const human = await getHumanActor();
  if (!human) return apiError(401, "unauthorized — deciding requires the human supervisor");

  const { id } = await ctx.params;
  const body = await readJson(req);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return apiError(400, "invalid body", { issues: parsed.error.issues });

  const action = normalizeAction(parsed.data.action);
  if (!action) return apiError(400, `unknown action "${parsed.data.action}" (approve|reject|discuss)`);

  const db = createAdminClient();
  const result = await decideDecision(db, { id, action, via: parsed.data.via ?? "web" });
  if (!result.ok) return apiError(result.status, result.error ?? "decide failed");
  return json({ decision: result.decision });
}
