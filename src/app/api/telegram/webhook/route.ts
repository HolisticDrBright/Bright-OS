import type { NextRequest } from "next/server";
import { webhookCallback } from "grammy";
import { apiError } from "@/lib/http";
import { env } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";
import { getBot } from "@/lib/telegram/bot";

export const dynamic = "force-dynamic";

/**
 * Telegram webhook. Three fences before any handler runs:
 *  1. per-IP rate limit
 *  2. X-Telegram-Bot-Api-Secret-Token must equal TELEGRAM_WEBHOOK_SECRET
 *  3. the bot middleware drops updates from any chat but TELEGRAM_CHAT_ID
 */
export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const rl = rateLimit(`telegram:${ip}`, { limit: 120, windowMs: 60_000 });
  if (!rl.allowed) return apiError(429, "rate limited");

  const secret = req.headers.get("x-telegram-bot-api-secret-token");
  if (!secret || secret !== env.telegramWebhookSecret) {
    return apiError(401, "bad webhook secret");
  }

  const handle = webhookCallback(getBot(), "std/http", {
    secretToken: env.telegramWebhookSecret,
  });
  try {
    return await handle(req);
  } catch (e) {
    // grammY throws on malformed updates — never 500 back to Telegram
    console.error("[telegram] webhook error:", e);
    return new Response("ok");
  }
}
