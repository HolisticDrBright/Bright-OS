import { Bot, InlineKeyboard } from "grammy";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { decideDecision } from "@/lib/decisions";
import { composeBriefing } from "@/workers/daily-briefing";
import { runCommand } from "@/lib/command/router";
import { escapeHtml } from "./send";

/**
 * The mobile approval surface. ONE chat id is allow-listed; every other
 * update is dropped before any handler runs. Buttons decide decisions
 * (decided_via=telegram), 💬 opens a threaded reply captured back into the
 * decision record, /brief replays the briefing, voice notes are transcribed
 * into /api/command.
 */
export function createBot(botInfo?: ConstructorParameters<typeof Bot>[1]) {
  const bot = new Bot(env.telegramBotToken, botInfo);

  // hard allow-list — one operator chat, nothing else exists
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id;
    if (String(chatId) !== env.telegramChatId) return; // silent drop
    await next();
  });

  bot.callbackQuery(/^decide:([0-9a-f-]{36}):(approved|rejected|discuss)$/i, async (ctx) => {
    const [, decisionId, action] = ctx.match!;
    const db = createAdminClient();

    if (action === "discuss") {
      const result = await decideDecision(db, {
        id: decisionId,
        action: "discuss",
        via: "telegram",
      });
      await ctx.answerCallbackQuery({ text: result.ok ? "Thread open" : result.error });
      if (result.ok) {
        await ctx.reply(
          `💬 Discussing: <b>${escapeHtml(result.decision!.title)}</b>\nReply to THIS message with your thoughts.\n#d:${decisionId}`,
          { parse_mode: "HTML", reply_markup: { force_reply: true } },
        );
      }
      return;
    }

    const result = await decideDecision(db, {
      id: decisionId,
      action: action as "approved" | "rejected",
      via: "telegram",
    });
    if (!result.ok) {
      await ctx.answerCallbackQuery({ text: result.error ?? "failed" });
      return;
    }
    await ctx.answerCallbackQuery({ text: action === "approved" ? "✅ Approved" : "❌ Rejected" });
    const original = ctx.callbackQuery.message;
    if (original && "text" in original) {
      await ctx.api
        .editMessageText(
          original.chat.id,
          original.message_id,
          `${original.text}\n\n${action === "approved" ? "✅ APPROVED" : "❌ REJECTED"} via Telegram`,
          { reply_markup: new InlineKeyboard() },
        )
        .catch(() => {});
    }
  });

  bot.command("brief", async (ctx) => {
    const db = createAdminClient();
    const briefing = await composeBriefing(db);
    await ctx.reply(briefing.telegramHtml, { parse_mode: "HTML" });
  });

  bot.command("start", async (ctx) => {
    await ctx.reply("BRIGHT OS online. /brief for the rundown; new decisions arrive with buttons.");
  });

  // threaded 💬 replies → captured into the decision record
  bot.on("message:text", async (ctx) => {
    const replied = ctx.message.reply_to_message;
    const decisionId =
      replied && "text" in replied ? /#d:([0-9a-f-]{36})/i.exec(replied.text ?? "")?.[1] : null;
    const db = createAdminClient();

    if (decisionId) {
      const note = ctx.message.text;
      const { data: decision } = await db
        .from("decisions")
        .select("preview_md,title")
        .eq("id", decisionId)
        .maybeSingle();
      if (decision) {
        await db
          .from("decisions")
          .update({
            preview_md: `${decision.preview_md ?? ""}\n\n> 💬 ${new Date().toISOString().slice(0, 16)} Dr. Bright: ${note}`,
          })
          .eq("id", decisionId);
        await db.from("heartbeat_events").insert({
          source: "DISCUSS",
          message: `discussion on "${decision.title}": ${note.slice(0, 140)}`,
          severity: "info",
          meta: { decision_id: decisionId, note },
        });
        await ctx.reply("Noted on the decision. Approve/reject when ready.");
        return;
      }
    }

    // plain text → the reactor brain
    const result = await runCommand(ctx.message.text, { db, via: "telegram" });
    await ctx.reply(result.reply.slice(0, 4000));
  });

  bot.on("message:voice", async (ctx) => {
    const db = createAdminClient();
    if (!env.openaiApiKey) {
      await ctx.reply("Voice received but transcription isn't configured (set OPENAI_API_KEY).");
      return;
    }
    try {
      const file = await ctx.getFile();
      const url = `https://api.telegram.org/file/bot${env.telegramBotToken}/${file.file_path}`;
      const audio = await (await fetch(url)).arrayBuffer();
      const form = new FormData();
      form.append("model", "whisper-1");
      form.append("file", new Blob([audio], { type: "audio/ogg" }), "voice.ogg");
      const tr = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { authorization: `Bearer ${env.openaiApiKey}` },
        body: form,
      });
      if (!tr.ok) throw new Error(`transcription failed: ${tr.status}`);
      const { text } = (await tr.json()) as { text: string };
      await ctx.reply(`🎙 "${text}"`);
      const result = await runCommand(text, { db, via: "voice" });
      await ctx.reply(result.reply.slice(0, 4000));
    } catch (e) {
      await ctx.reply(`Voice pipeline error: ${e instanceof Error ? e.message : e}`);
    }
  });

  return bot;
}

let cached: ReturnType<typeof createBot> | null = null;

export function getBot() {
  if (!cached) cached = createBot();
  return cached;
}

/** Test hook. */
export function __resetBot() {
  cached = null;
}
