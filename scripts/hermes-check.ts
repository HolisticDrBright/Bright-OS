/**
 * BRIGHT OS ↔ HERMES handshake test — run:  npm run hermes:check
 *
 * Verifies, step by step, with precise failure reasons:
 *  1. HERMES_URL + HERMES_API_KEY load from .env
 *  2. the Hermes gateway is actually listening at that URL
 *  3. the API key is accepted
 *  4. a real /v1/responses round-trip works (the surface the research +
 *     memory lanes use)
 */
import "dotenv/config";

const url = (process.env.HERMES_URL ?? "").replace(/\/$/, "");
const key = process.env.HERMES_API_KEY ?? "";
const model = process.env.HERMES_MODEL ?? "hermes-agent";

function fail(msg: string): never {
  console.error(`\n✗ FAIL — ${msg}`);
  process.exit(1);
}

function connCode(e: unknown): string {
  const cause = (e as { cause?: { code?: string } })?.cause;
  return cause?.code ?? (e instanceof Error ? e.message : String(e));
}

function extractText(body: { output_text?: string; output?: { content?: { text?: string }[] }[] }): string {
  if (typeof body.output_text === "string" && body.output_text.length > 0) return body.output_text;
  const parts: string[] = [];
  for (const item of body.output ?? []) for (const c of item.content ?? []) if (typeof c.text === "string") parts.push(c.text);
  return parts.join("\n");
}

async function main() {
  console.log("BRIGHT OS ↔ HERMES handshake test");
  console.log("─".repeat(44));

  if (!url || !key) {
    fail(
      "HERMES_URL / HERMES_API_KEY are not loading from .env.\n" +
        "  Add to the bright-os .env (values from your Hermes install):\n" +
        "    HERMES_URL=http://127.0.0.1:8642\n" +
        "    HERMES_API_KEY=<the API server key you set in Hermes>\n" +
        "  then run this again.",
    );
  }
  console.log(`✓ HERMES_URL: ${url}`);
  console.log(`✓ HERMES_API_KEY: ${key.slice(0, 5)}… (${key.length} chars) · model: ${model}`);

  // Step 1: is anything listening there?
  console.log("→ pinging the gateway …");
  try {
    const ping = await fetch(`${url}/v1/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    if (ping.status === 401 || ping.status === 403) {
      fail(
        `the gateway is RUNNING but rejected the key (${ping.status}).\n` +
          "  HERMES_API_KEY in bright-os .env must exactly match the API server key\n" +
          "  configured in Hermes (its API server settings).",
      );
    }
    console.log(`  gateway answered (${ping.status})${ping.ok ? "" : " — /v1/models not exposed; continuing"}`);
  } catch (e) {
    const code = connCode(e);
    if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|TimeoutError|UND_ERR/i.test(code)) {
      fail(
        `nothing is listening at ${url} (${code}).\n` +
          "  Hermes isn't running, or its API server isn't enabled.\n" +
          "  On the Hermes machine: enable the API server in its config\n" +
          "  (API_SERVER_ENABLED=true + an API_SERVER_KEY), then start the\n" +
          "  gateway:  hermes gateway\n" +
          "  If Hermes runs on another machine/VPS, HERMES_URL must use that\n" +
          "  host (and the port must be open to this machine).",
      );
    }
    fail(`gateway ping failed: ${code}`);
  }

  // Step 2: the real round-trip the research/memory lanes use.
  console.log("→ /v1/responses round-trip (this can take a moment) …");
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(`${url}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "x-hermes-session-key": "brightos",
      },
      body: JSON.stringify({
        model,
        input: "Reply with exactly: HERMES ONLINE",
        conversation: "brightos-selftest",
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e) {
    fail(`/v1/responses request failed: ${connCode(e)}`);
  }

  if (res.status === 401 || res.status === 403) fail(`key rejected on /v1/responses (${res.status}).`);
  if (res.status === 404) {
    fail(
      "/v1/responses not found (404) — your Hermes version may expose a\n" +
        "  different API surface. Paste this output to Claude and the bridge\n" +
        "  (src/lib/hermes.ts) will be adjusted to match your version.",
    );
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    fail(`/v1/responses error ${res.status}:\n  ${detail}`);
  }

  const reply = extractText((await res.json()) as Parameters<typeof extractText>[0]).trim();
  console.log(`\n✓ PASS — round-trip in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  Hermes replied: ${reply.slice(0, 120) || "(empty reply — but the pipe works)"}`);
  console.log("  The research + memory lanes are live. Try in the HUD:");
  console.log("    /research <topic>     — HERMES researches → task + sourced claims");
  console.log('    "what do you remember about …" — deep recall via search_memory');
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
