import type { NextRequest } from "next/server";
import { z } from "zod";
import { getHumanActor } from "@/lib/auth";
import { apiError, readJson } from "@/lib/http";
import { env } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const schema = z.object({ text: z.string().min(1).max(2000) });

/**
 * POST /api/tts {text} — the HUD "Jarvis" voice.
 *
 * Renders text to speech with OpenAI (gpt-4o-mini-tts, voice=onyx by default)
 * and returns MP3 audio. The `instructions` field carries the butler persona —
 * that's what turns flat TTS into a composed, unhurried AI voice. Human-only,
 * rate-limited. If OPENAI_API_KEY is unset it 503s and the HUD falls back to the
 * browser's built-in speech synthesis.
 */
export async function POST(req: NextRequest) {
  const human = await getHumanActor();
  if (!human) return apiError(401, "unauthorized — the command deck is human-only");
  if (!env.openaiApiKey) return apiError(503, "TTS offline — set OPENAI_API_KEY for the Jarvis voice");

  const rl = rateLimit(`tts:${human.email}`, { limit: 120, windowMs: 60_000 });
  if (!rl.allowed) return apiError(429, "rate limited");

  const body = await readJson(req);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return apiError(400, "invalid body", { issues: parsed.error.issues });

  let r: Response;
  try {
    r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.openaiApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: env.ttsModel,
        voice: env.ttsVoice,
        input: parsed.data.text,
        instructions: env.ttsInstructions,
        response_format: "mp3",
      }),
    });
  } catch (e) {
    return apiError(502, `TTS provider unreachable: ${e instanceof Error ? e.message : e}`);
  }

  if (!r.ok || !r.body) {
    const detail = await r.text().catch(() => "");
    return apiError(502, `TTS provider error ${r.status}`, { detail: detail.slice(0, 300) });
  }

  // Stream the MP3 through as it renders — the first audio bytes reach the
  // browser in ~the provider's time-to-first-byte instead of after the whole
  // clip is synthesized. The HUD plays it progressively via MediaSource.
  return new Response(r.body, {
    headers: {
      "content-type": "audio/mpeg",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
