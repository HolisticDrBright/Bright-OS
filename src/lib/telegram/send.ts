import { env } from "@/lib/env";
import type { DecisionRow } from "@/types/db";

/**
 * Outbound Telegram, raw Bot API over fetch (grammY is used for the inbound
 * webhook). Every send goes ONLY to the allow-listed chat id. All senders
 * no-op cleanly when the bot isn't configured, so the OS runs without
 * Telegram in dev.
 */
function configured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

async function tg(method: string, payload: Record<string, unknown>): Promise<unknown> {
  if (!configured()) return null;
  const res = await fetch(`https://api.telegram.org/bot${env.telegramBotToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.telegramChatId, ...payload }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`telegram ${method} failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

export function decisionKeyboard(decisionId: string) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: `decide:${decisionId}:approved` },
        { text: "❌ Reject", callback_data: `decide:${decisionId}:rejected` },
        { text: "💬 Discuss", callback_data: `decide:${decisionId}:discuss` },
      ],
    ],
  };
}

export function formatDecisionMessage(d: Pick<DecisionRow, "id" | "title" | "impact_note" | "preview_md" | "tags">, extra?: { brand?: string; agent?: string; ageHours?: number }) {
  const lines = [
    `🔶 <b>DECISION</b>${extra?.ageHours ? ` · ${Math.round(extra.ageHours)}h old` : ""}`,
    `<b>${escapeHtml(d.title)}</b>`,
  ];
  if (extra?.brand || extra?.agent) {
    lines.push([extra.brand, extra.agent && `requested by ${extra.agent}`].filter(Boolean).join(" · "));
  }
  if (d.impact_note) lines.push(`⌁ ${escapeHtml(d.impact_note)}`);
  if (d.tags?.includes("medical-regulatory")) lines.push("⚠️ <b>medical/regulatory — human approval required</b>");
  if (d.preview_md) lines.push(`<pre>${escapeHtml(truncate(d.preview_md, 900))}</pre>`);
  return lines.join("\n");
}

/** New decision → approval message with inline buttons. Fire-and-forget safe. */
export async function sendDecisionMessage(
  d: Pick<DecisionRow, "id" | "title" | "impact_note" | "preview_md" | "tags">,
  extra?: { brand?: string; agent?: string; ageHours?: number },
): Promise<void> {
  await tg("sendMessage", {
    text: formatDecisionMessage(d, extra),
    parse_mode: "HTML",
    reply_markup: decisionKeyboard(d.id),
  });
}

export async function sendAlert(text: string): Promise<void> {
  await tg("sendMessage", { text: `🔴 ${text}` });
}

export async function sendMarkdown(text: string): Promise<void> {
  // Telegram HTML mode; callers pass pre-escaped plain text with <b>/<pre> only.
  await tg("sendMessage", { text, parse_mode: "HTML" });
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
