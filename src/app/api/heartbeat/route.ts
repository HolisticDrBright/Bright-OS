import type { NextRequest } from "next/server";
import { z } from "zod";
import { getActor } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { apiError, json } from "@/lib/http";
import { verifyHeartbeatSignature } from "@/lib/hmac";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const eventSchema = z.object({
  source: z.string().min(1),
  message: z.string().min(1),
  severity: z.enum(["info", "warn", "alert"]).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  ts: z.string().optional(),
});
const bodySchema = z.union([eventSchema, z.object({ events: z.array(eventSchema).min(1).max(100) })]);

/**
 * POST /api/heartbeat — token-authenticated ingest for external agents
 * (OpenClaw skill, Hermes hooks, cron shells).
 *
 * Auth: HMAC headers over the RAW body —
 *   x-brightos-timestamp: unix seconds (±300s window)
 *   x-brightos-signature: hex(HMAC_SHA256(secret, `${ts}.${body}`))
 * Rate limited per source IP.
 */
export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const rl = rateLimit(`heartbeat:${ip}`, { limit: 120, windowMs: 60_000 });
  if (!rl.allowed) return apiError(429, "rate limited");

  const rawBody = await req.text();
  const verdict = verifyHeartbeatSignature({
    secret: process.env.HEARTBEAT_HMAC_SECRET ?? "",
    timestamp: req.headers.get("x-brightos-timestamp"),
    signature: req.headers.get("x-brightos-signature"),
    rawBody,
  });
  if (!verdict.ok) return apiError(401, `signature rejected: ${verdict.reason}`);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return apiError(400, "body is not JSON");
  }
  const parsed = bodySchema.safeParse(parsedJson);
  if (!parsed.success) return apiError(400, "invalid body", { issues: parsed.error.issues });

  const events = "events" in parsed.data ? parsed.data.events : [parsed.data];
  const db = createAdminClient();
  const { data, error } = await db
    .from("heartbeat_events")
    .insert(
      events.map((e) => ({
        source: e.source,
        message: e.message,
        severity: e.severity ?? "info",
        meta: e.meta ?? {},
        ...(e.ts ? { ts: e.ts } : {}),
      })),
    )
    .select("id");
  if (error) return apiError(500, error.message);
  return json({ ingested: data?.length ?? events.length }, 201);
}

/** GET /api/heartbeat?limit=50&severity=alert — HUD ticker bootstrap. */
export async function GET(req: NextRequest) {
  const actor = await getActor(req);
  if (!actor) return apiError(401, "unauthorized");
  const db = createAdminClient();
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const severity = url.searchParams.get("severity");

  let query = db.from("heartbeat_events").select("*").order("ts", { ascending: false }).limit(limit);
  if (severity) query = query.eq("severity", severity);
  const { data, error } = await query;
  if (error) return apiError(500, error.message);
  return json({ events: data });
}
