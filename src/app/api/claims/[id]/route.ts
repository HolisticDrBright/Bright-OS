import type { NextRequest } from "next/server";
import { z } from "zod";
import { getActor } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { apiError, json, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  verified: z.boolean().optional(),
  verified_by: z.string().optional(),
  source_url: z.string().nullable().optional(),
  claim_text: z.string().min(1).optional(),
});

/**
 * PATCH /api/claims/:id — verification lane (CODEX or the human).
 * GUARDRAIL: verified=true is impossible without a source_url; enforced
 * here and again by a DB trigger.
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const actor = await getActor(req);
  if (!actor) return apiError(401, "unauthorized");
  const { id } = await ctx.params;
  const body = await readJson(req);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return apiError(400, "invalid body", { issues: parsed.error.issues });
  const db = createAdminClient();

  const { data: claim, error } = await db.from("claims").select("*").eq("id", id).maybeSingle();
  if (error) return apiError(500, error.message);
  if (!claim) return apiError(404, "claim not found");

  const patch = { ...parsed.data };
  if (patch.verified === true) {
    const sourceUrl = patch.source_url !== undefined ? patch.source_url : claim.source_url;
    if (!sourceUrl || !String(sourceUrl).trim()) {
      return apiError(422, "GUARDRAIL: claim cannot be verified without source_url");
    }
    if (!patch.verified_by) {
      patch.verified_by = actor.type === "human" ? actor.email : actor.agentName;
    }
  }

  const { data: updated, error: upErr } = await db
    .from("claims")
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  if (upErr) {
    return upErr.message.includes("GUARDRAIL") ? apiError(422, upErr.message) : apiError(500, upErr.message);
  }
  return json({ claim: updated });
}
