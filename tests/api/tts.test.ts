import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => import("../helpers/auth-mock"));

import { POST as TTS } from "@/app/api/tts/route";
import { AGENT, HUMAN, authState, makeReq } from "../helpers/harness";

describe("POST /api/tts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
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
});
