import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => import("../helpers/auth-mock"));

import { POST as TTS } from "@/app/api/tts/route";
import { AGENT, HUMAN, authState, makeReq } from "../helpers/harness";

describe("POST /api/tts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
  });

  it("is human-only (agents rejected)", async () => {
    authState.actor = AGENT("openclaw");
    const res = await TTS(makeReq("http://os/api/tts", { method: "POST", body: { text: "hi" } }));
    expect(res.status).toBe(401);
  });

  it("503s when OPENAI_API_KEY is unset (HUD falls back to the browser voice)", async () => {
    authState.actor = HUMAN;
    delete process.env.OPENAI_API_KEY;
    const res = await TTS(makeReq("http://os/api/tts", { method: "POST", body: { text: "hi" } }));
    expect(res.status).toBe(503);
  });

  it("renders MP3 with the onyx voice + butler persona for the operator", async () => {
    authState.actor = HUMAN;
    process.env.OPENAI_API_KEY = "sk-test";
    let sent: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string }) => {
        expect(url).toBe("https://api.openai.com/v1/audio/speech");
        sent = JSON.parse(init.body) as Record<string, unknown>;
        return new Response(new Uint8Array([0x49, 0x44, 0x33]).buffer, {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      }),
    );

    const res = await TTS(
      makeReq("http://os/api/tts", { method: "POST", body: { text: "Good evening, Doctor." } }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("audio/mpeg");
    expect(sent!.voice).toBe("onyx");
    expect(sent!.model).toBe("gpt-4o-mini-tts");
    expect(sent!.input).toBe("Good evening, Doctor.");
    expect(String(sent!.instructions).toLowerCase()).toContain("butler");
  });

  it("502s when the TTS provider errors", async () => {
    authState.actor = HUMAN;
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    const res = await TTS(makeReq("http://os/api/tts", { method: "POST", body: { text: "hi" } }));
    expect(res.status).toBe(502);
  });

  it("prefers ElevenLabs (British Jarvis) when its key is set", async () => {
    authState.actor = HUMAN;
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.ELEVENLABS_API_KEY = "el-test";
    const calls: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
        calls.push({ url, headers: init.headers });
        return new Response(new Uint8Array([0x49, 0x44, 0x33]).buffer, { status: 200 });
      }),
    );

    const res = await TTS(makeReq("http://os/api/tts", { method: "POST", body: { text: "Good evening, Doctor." } }));

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1); // ElevenLabs succeeded — OpenAI never called
    expect(calls[0].url).toContain("api.elevenlabs.io");
    expect(calls[0].headers["xi-api-key"]).toBe("el-test");
    expect(res.headers.get("x-tts-model")).toContain("elevenlabs");
  });

  it("falls back from ElevenLabs to OpenAI when ElevenLabs fails", async () => {
    authState.actor = HUMAN;
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.ELEVENLABS_API_KEY = "el-bad";
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url.includes("elevenlabs")) return new Response("unauthorized", { status: 401 });
        return new Response(new Uint8Array([0x49, 0x44, 0x33]).buffer, { status: 200 });
      }),
    );

    const res = await TTS(makeReq("http://os/api/tts", { method: "POST", body: { text: "hi" } }));

    expect(res.status).toBe(200);
    expect(urls[0]).toContain("elevenlabs");
    expect(urls[1]).toContain("openai.com");
    expect(res.headers.get("x-tts-model")).toBe("gpt-4o-mini-tts");
  });

  it("falls back to tts-1 (sans instructions) when the account lacks the newer model", async () => {
    authState.actor = HUMAN;
    process.env.OPENAI_API_KEY = "sk-test";
    const sent: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        sent.push(body);
        if (body.model === "gpt-4o-mini-tts") return new Response("model_not_found", { status: 404 });
        return new Response(new Uint8Array([0x49, 0x44, 0x33]).buffer, {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      }),
    );

    const res = await TTS(makeReq("http://os/api/tts", { method: "POST", body: { text: "Good evening." } }));

    expect(res.status).toBe(200);
    expect(res.headers.get("x-tts-model")).toBe("tts-1");
    expect(sent).toHaveLength(2);
    expect(sent[1].model).toBe("tts-1");
    expect(sent[1].voice).toBe("onyx"); // same voice, older engine
    expect(sent[1].instructions).toBeUndefined(); // tts-1 rejects the persona param
  });
});
