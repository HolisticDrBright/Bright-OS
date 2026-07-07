import type { NextRequest } from "next/server";
import { z } from "zod";
import { getHumanActor } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { apiError, readJson } from "@/lib/http";
import { runCommandStream, type StreamEvent } from "@/lib/command/router";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // tool loops + Hermes research take time

const schema = z.object({
  text: z.string().min(1).max(4000),
  via: z.enum(["web", "voice"]).optional(),
});

/**
 * POST /api/command/stream {text} — the streaming twin of /api/command.
 *
 * Emits newline-delimited JSON ({@link StreamEvent} per line) so the HUD can
 * render, and start speaking, the first sentence while the rest of the reply is
 * still generating. Same human-only guard and rate limit as /api/command; the
 * Telegram bot keeps using the plain JSON endpoint.
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
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: StreamEvent) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        } catch {
          // controller already closed (client disconnected) — drop the event.
        }
      };
      try {
        await runCommandStream(parsed.data.text, { db, via: parsed.data.via ?? "web" }, emit);
      } catch (e) {
        emit({ type: "error", message: e instanceof Error ? e.message : "command failed" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      // stop nginx/proxies from buffering the stream so first-sentence TTS is snappy
      "x-accel-buffering": "no",
    },
  });
}
