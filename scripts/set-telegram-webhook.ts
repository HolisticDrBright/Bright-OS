/**
 * One-shot: point the Telegram bot at this deployment's webhook.
 *   APP_BASE_URL=https://os.example.com npm run telegram:set-webhook
 */
import "dotenv/config";

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const base = process.env.APP_BASE_URL;
  if (!token || !secret || !base) {
    console.error("Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and APP_BASE_URL first.");
    process.exit(1);
  }
  const url = `${base.replace(/\/$/, "")}/api/telegram/webhook`;
  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url,
      secret_token: secret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    }),
  });
  const body = await res.json();
  console.log(JSON.stringify(body, null, 2));
  if (!body.ok) process.exit(1);
  console.log(`✓ webhook set to ${url}`);
}

main();
