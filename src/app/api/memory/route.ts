import type { NextRequest } from "next/server";
import { z } from "zod";
import { getActor } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { apiError, json, readJson } from "@/lib/http";
import { readMemoryMd } from "@/lib/memory";

export const dynamic = "force-dynamic";

/** GET /api/memory — MEMORY.md + daily log + promotions (the Memory tab). */
export async function GET(req: NextRequest) {
  const actor = await getActor(req);
  if (!actor) return apiError(401, "unauthorized");
  const db = createAdminClient();
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 60), 365);

  const [memoryMd, log, promotions] = await Promise.all([
    readMemoryMd(),
    db.from("memory_log").select("*").order("day", { ascending: false }).limit(limit),
    db.from("memory_promotions").select("*").order("promoted_at", { ascending: false }).limit(limit),
  ]);
  if (log.error) return apiError(500, log.error.message);
  return json({
    memory_md: memoryMd,
    log: log.data ?? [],
    promotions: promotions.data ?? [],
  });
}

const upsertSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  content_md: z.string(),
  append: z.boolean().optional(),
});

/** POST /api/memory — write/append the daily log entry (Hermes + workers). */
export async function POST(req: NextRequest) {
  const actor = await getActor(req);
  if (!actor) return apiError(401, "unauthorized");
  const body = await readJson(req);
  const parsed = upsertSchema.safeParse(body);
  if (!parsed.success) return apiError(400, "invalid body", { issues: parsed.error.issues });
  const db = createAdminClient();
  const { day, content_md, append } = parsed.data;

  if (append) {
    const { data: existing } = await db.from("memory_log").select("*").eq("day", day).maybeSingle();
    const merged = existing?.content_md ? `${existing.content_md.trimEnd()}\n${content_md}` : content_md;
    const { data, error } = await db
      .from("memory_log")
      .upsert({ day, content_md: merged }, { onConflict: "day" })
      .select()
      .single();
    if (error) return apiError(500, error.message);
    return json({ entry: data });
  }

  const { data, error } = await db
    .from("memory_log")
    .upsert({ day, content_md }, { onConflict: "day" })
    .select()
    .single();
  if (error) return apiError(500, error.message);
  return json({ entry: data });
}
