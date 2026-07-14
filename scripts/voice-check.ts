/**
 * BRIGHT OS voice self-test — run:  npm run voice:check
 *
 * Verifies, outside the browser entirely:
 *  1. the OpenAI key actually loads from .env
 *  2. OpenAI accepts it and renders the Jarvis voice
 * On success it writes voice-check.mp3 — double-click it to HEAR the exact
 * voice the HUD should be using. On failure it prints the precise reason.
 */
import "dotenv/config";
import fs from "node:fs";

const key = process.env.OPENAI_API_KEY ?? "";
const model = process.env.TTS_MODEL ?? "gpt-4o-mini-tts";
const voice = process.env.TTS_VOICE ?? "onyx";
const elevenKey = process.env.ELEVENLABS_API_KEY ?? "";
const elevenVoice = process.env.ELEVENLABS_VOICE_ID ?? "onwK4e9ZLuTAKqWW03F9"; // Daniel — British
const elevenModel = process.env.ELEVENLABS_MODEL ?? "eleven_turbo_v2_5";

function fail(msg: string): never {
  console.error(`\n✗ FAIL — ${msg}`);
  process.exit(1);
}

async function renderEleven(): Promise<Response> {
  return fetch(`https://api.elevenlabs.io/v1/text-to-speech/${elevenVoice}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": elevenKey, "content-type": "application/json" },
    body: JSON.stringify({
      text: "Systems online, Doctor. This is the Jarvis voice, standing by.",
      model_id: elevenModel,
    }),
  });
}

async function render(m: string): Promise<Response> {
  const body: Record<string, unknown> = {
    model: m,
    voice,
    input: "Systems online, Doctor. This is the Jarvis voice, standing by.",
    response_format: "mp3",
  };
  if (m.startsWith("gpt-")) {
    body.instructions = "Deep, authoritative AI butler in the spirit of JARVIS. Composed, unhurried, subtly warm.";
  }
  return fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function main() {
  console.log("BRIGHT OS voice self-test");
  console.log("─".repeat(44));

  // ElevenLabs first — when configured, it's the voice the HUD will prefer.
  if (elevenKey) {
    console.log(`✓ ELEVENLABS_API_KEY loaded: ${elevenKey.slice(0, 6)}… (${elevenKey.length} chars)`);
    console.log(`→ rendering with ElevenLabs ${elevenModel} / voice ${elevenVoice} …`);
    const er = await renderEleven();
    if (er.ok) {
      const buf = Buffer.from(await er.arrayBuffer());
      fs.writeFileSync("voice-check.mp3", buf);
      console.log(`\n✓ PASS (served by ElevenLabs) — wrote voice-check.mp3 (${(buf.length / 1024).toFixed(0)} KB)`);
      console.log("  Double-click voice-check.mp3 — THAT is the British Jarvis the HUD will use.");
      return;
    }
    const detail = (await er.text()).slice(0, 300);
    console.warn(`  ✗ ElevenLabs failed (${er.status}): ${detail}`);
    console.warn("  Falling through to the OpenAI check …\n");
  }

  if (!key) {
    fail(
      (elevenKey ? "ElevenLabs failed and " : "") +
        "OPENAI_API_KEY is NOT loading from .env.\n" +
        "  Check: the file is named exactly '.env' (Notepad loves saving '.env.txt';\n" +
        "  run `dir` to confirm), it sits in the bright-os folder (not .env.example),\n" +
        "  and the line reads OPENAI_API_KEY=sk-... on its own line.",
    );
  }
  console.log(`✓ OPENAI_API_KEY loaded from .env: ${key.slice(0, 7)}… (${key.length} chars)`);

  console.log(`→ rendering with ${model} / ${voice} …`);
  let served = model;
  let r = await render(model);
  if (!r.ok && [400, 403, 404].includes(r.status)) {
    console.warn(`  ${model} unavailable (${r.status}) — retrying with tts-1 …`);
    served = "tts-1";
    r = await render("tts-1");
  }

  if (!r.ok) {
    const detail = (await r.text()).slice(0, 400);
    if (r.status === 401) fail(`OpenAI rejected the key (401 — wrong or revoked key).\n  ${detail}`);
    if (r.status === 429)
      fail(
        `OpenAI quota/billing (429). The key is VALID but the account has no credit.\n` +
          `  Fix: platform.openai.com → Settings → Billing → add credit ($5 is plenty).\n  ${detail}`,
      );
    fail(`OpenAI error ${r.status}:\n  ${detail}`);
  }

  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync("voice-check.mp3", buf);
  console.log(`\n✓ PASS (served by ${served}) — wrote voice-check.mp3 (${(buf.length / 1024).toFixed(0)} KB)`);
  console.log("  Double-click voice-check.mp3 — THAT is the Jarvis voice the HUD should use.");
  console.log("  If the HUD still sounds robotic after this passes:");
  console.log("    1. restart `npm run dev`   2. hard-refresh the tab (Ctrl+F5)");
  console.log("    3. toggle 🔊 VOICE off/on   4. read the ⚠ message it prints");
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
