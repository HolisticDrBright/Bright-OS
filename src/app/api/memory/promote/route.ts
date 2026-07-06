import type { NextRequest } from "next/server";
import { z } from "zod";
import { getHumanActor } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { apiError, json, readJson } from "@/lib/http";
import { promoteLineToFile } from "@/lib/memory";

export const dynamic = "force-dynamic";

const schema = z.object({
  from_day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  line_text: z.string().min(1),
  section: z.string().optional(),
});

/**
 * POST /api/memory/promote — promote a daily-log line into MEMORY.md.
 * Curated memory is the human's judgment call, so this is human-only.
 */
export async function POST(req: NextRequest) {
  const actor = await getHumanActor();
  if (!actor) return apiError(401, "unauthorized (human session required)");
  const body = await readJson(req);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return apiError(400, "invalid body", { issues: parsed.error.issues });
  const { from_day, line_text, section } = parsed.data;
  const db = createAdminClient();

  await promoteLineToFile(line_text, section ?? "LEARNED");

  const { data, error } = await db
    .from("memory_promotions")
    .insert({ from_day, line_text })
    .select()
    .single();
  if (error) return apiError(500, error.message);

  await db.from("heartbeat_events").insert({
    source: "MEMORY",
    message: `promoted → MEMORY.md: ${line_text.slice(0, 120)}`,
    severity: "info",
    meta: { from_day },
  });

  return json({ promotion: data }, 201);
}
