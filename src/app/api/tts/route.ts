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
 * Provider chain, first success wins (streamed MP3 either way):
 *  1. ElevenLabs (when ELEVENLABS_API_KEY is set) — native British voice,
 *     the closest thing to the actual Jarvis. Default voice: "Daniel".
 *  2. OpenAI gpt-4o-mini-tts (voice=onyx + butler persona instructions).
 *  3. OpenAI tts-1 — legacy engine every OpenAI account can use, in case the
 *     account lacks access to the newer model.
 * The winning engine is reported in the x-tts-model response header so the
 * HUD can show which voice actually spoke. Human-only, rate-limited. With no
 * provider configured it 503s and the HUD falls back to browser speech.
 */
function renderElevenLabs(text: string): Promise<Response> {
  return fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${env.elevenLabsVoiceId}/stream?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": env.elevenLabsApiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: env.elevenLabsModel,
        voice_settings: { stability: 0.5, similarity_boost: 0.8 },
      }),
    },
  );
}

function renderOpenAI(model: string, text: string): Promise<Response> {
  const body: Record<string, unknown> = {
    model,
    voice: env.ttsVoice,
    input: text,
    response_format: "mp3",
  };
  // `instructions` (the butler persona) is a gpt-4o-mini-tts feature; the
  // legacy tts-1 fallback rejects unknown params, so only send it there.
  if (model.startsWith("gpt-")) body.instructions = env.ttsInstructions;
  return fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.openaiApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

export async function POST(req: NextRequest) {
  const human = await getHumanActor();
  if (!human) return apiError(401, "unauthorized — the command deck is human-only");

  const rl = rateLimit(`tts:${human.email}`, { limit: 120, windowMs: 60_000 });
  if (!rl.allowed) return apiError(429, "rate limited");

  const body = await readJson(req);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return apiError(400, "invalid body", { issues: parsed.error.issues });

  const text = parsed.data.text;
  const providers: { name: string; render: () => Promise<Response> }[] = [];
  if (env.elevenLabsApiKey) {
    providers.push({ name: `elevenlabs/${env.elevenLabsModel}`, render: () => renderElevenLabs(text) });
  }
  if (env.openaiApiKey) {
    providers.push({ name: env.ttsModel, render: () => renderOpenAI(env.ttsModel, text) });
    if (env.ttsModel !== "tts-1") providers.push({ name: "tts-1", render: () => renderOpenAI("tts-1", text) });
  }
  if (providers.length === 0) {
    return apiError(503, "TTS offline — set ELEVENLABS_API_KEY (British Jarvis voice) or OPENAI_API_KEY in .env");
  }

  let last: Response | null = null;
  let served = "";
  try {
    for (const p of providers) {
      const r = await p.render();
      last = r;
      if (r.ok && r.body) {
        served = p.name;
        break;
      }
    }
  } catch (e) {
    return apiError(502, `TTS provider unreachable: ${e instanceof Error ? e.message : e}`);
  }

  if (!last || !last.ok || !last.body) {
    const detail = last ? await last.text().catch(() => "") : "";
    return apiError(502, `TTS provider error ${last?.status ?? "?"}`, { detail: detail.slice(0, 300) });
  }

  // Stream the MP3 through as it renders — the first audio bytes reach the
  // browser in ~the provider's time-to-first-byte instead of after the whole
  // clip is synthesized. The HUD plays it progressively via MediaSource.
  return new Response(last.body, {
    headers: {
      "content-type": "audio/mpeg",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
      "x-tts-model": served,
    },
  });
}
