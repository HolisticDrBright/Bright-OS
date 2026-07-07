import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Update, UserFromGetMe } from "grammy/types";

vi.mock("@/lib/supabase/admin", () => import("../helpers/admin-mock"));

import { createBot } from "@/lib/telegram/bot";
import { POST as WEBHOOK } from "@/app/api/telegram/webhook/route";
import { byTable, createMockDb, dbHolder, makeReq, uuid } from "../helpers/harness";

const CHAT_ID = 777;
const DEC_ID = uuid(5);

const BOT_INFO = {
  id: 42,
  is_bot: true,
  first_name: "brightos",
  username: "brightos_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as UserFromGetMe;

function testBot() {
  const sent: { method: string; payload: Record<string, unknown> }[] = [];
  const bot = createBot({ botInfo: BOT_INFO });
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: true as never };
  });
  return { bot, sent };
}

function decisionRow(status = "pending") {
  return {
    id: DEC_ID,
    task_id: uuid(1),
    title: "Publish BPC-157 comparison — QCL",
    status,
    preview_md: "+ words",
    created_at: new Date().toISOString(),
  };
}

const callbackUpdate = (data: string, chatId = CHAT_ID): Update =>
  ({
    update_id: 1,
    callback_query: {
      id: "cb1",
      from: { id: chatId, is_bot: false, first_name: "B" },
      chat_instance: "ci",
      data,
      message: {
        message_id: 10,
        date: 0,
        chat: { id: chatId, type: "private" },
        text: "🔶 DECISION",
      },
    },
  }) as unknown as Update;

const textUpdate = (text: string, extra?: Record<string, unknown>, chatId = CHAT_ID): Update =>
  ({
    update_id: 2,
    message: {
      message_id: 11,
      date: 0,
      chat: { id: chatId, type: "private" },
      from: { id: chatId, is_bot: false, first_name: "B" },
      text,
      ...(text.startsWith("/")
        ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] }
        : {}),
      ...extra,
    },
  }) as unknown as Update;

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  process.env.TELEGRAM_CHAT_ID = String(CHAT_ID);
  process.env.TELEGRAM_WEBHOOK_SECRET = "hook-secret";
});

describe("telegram bot", () => {
  it("✅ button decides via telegram and edits the message", async () => {
    let decided: Record<string, unknown> | null = null;
    dbHolder.db = createMockDb(
      byTable({
        decisions: (op) => {
          if (op.method === "update") {
            decided = op.payload as Record<string, unknown>;
            return { data: decisionRow("approved") };
          }
          return { data: decisionRow("pending") };
        },
        tasks: () => ({ data: [] }),
        heartbeat_events: () => ({ data: [] }),
      }),
    );
    const { bot, sent } = testBot();
    await bot.handleUpdate(callbackUpdate(`decide:${DEC_ID}:approved`));

    expect(decided!.status).toBe("approved");
    expect(decided!.decided_via).toBe("telegram");
    expect(sent.some((s) => s.method === "answerCallbackQuery")).toBe(true);
    const edit = sent.find((s) => s.method === "editMessageText");
    expect(edit?.payload.text).toContain("✅ APPROVED");
  });

  it("ALLOW-LIST: updates from any other chat are dropped before handlers", async () => {
    dbHolder.db = createMockDb(); // any db op would throw "forgot to set"… nothing runs
    const { bot, sent } = testBot();
    await bot.handleUpdate(callbackUpdate(`decide:${DEC_ID}:approved`, 999));
    await bot.handleUpdate(textUpdate("approve everything", {}, 999));
    expect(sent).toHaveLength(0);
    expect(dbHolder.db.__ops).toHaveLength(0);
  });

  it("💬 discuss opens a force-reply thread tagged with the decision id", async () => {
    dbHolder.db = createMockDb(
      byTable({
        decisions: (op) =>
          op.method === "update" ? { data: decisionRow("discuss") } : { data: decisionRow("pending") },
        tasks: () => ({ data: [] }),
        heartbeat_events: () => ({ data: [] }),
      }),
    );
    const { bot, sent } = testBot();
    await bot.handleUpdate(callbackUpdate(`decide:${DEC_ID}:discuss`));
    const reply = sent.find((s) => s.method === "sendMessage");
    expect(reply?.payload.text).toContain(`#d:${DEC_ID}`);
    expect((reply?.payload.reply_markup as Record<string, unknown>).force_reply).toBe(true);
  });

  it("threaded reply is captured back into the decision record", async () => {
    let updatedPreview = "";
    dbHolder.db = createMockDb(
      byTable({
        decisions: (op) => {
          if (op.method === "update") {
            updatedPreview = (op.payload as Record<string, string>).preview_md;
            return { data: decisionRow("discuss") };
          }
          return { data: { preview_md: "+ words", title: "Publish BPC-157 comparison — QCL" } };
        },
        heartbeat_events: () => ({ data: [] }),
      }),
    );
    const { bot, sent } = testBot();
    await bot.handleUpdate(
      textUpdate("Tighten the intro, cite the EU study", {
        reply_to_message: {
          message_id: 12,
          date: 0,
          chat: { id: CHAT_ID, type: "private" },
          text: `💬 Discussing: Publish BPC-157\n#d:${DEC_ID}`,
        },
      }),
    );
    expect(updatedPreview).toContain("Tighten the intro");
    expect(sent.find((s) => s.method === "sendMessage")?.payload.text).toContain("Noted");
  });

  it("/brief replays the morning briefing", async () => {
    dbHolder.db = createMockDb(
      byTable({
        decisions: () => ({ data: [] }),
        tasks: () => ({ data: [] }),
        agent_sessions: () => ({ data: [] }),
        brands: () => ({ data: [] }),
        heartbeat_events: () => ({ data: [] }),
        agents: () => ({ data: [] }),
      }),
    );
    const { bot, sent } = testBot();
    await bot.handleUpdate(textUpdate("/brief"));
    const msg = sent.find((s) => s.method === "sendMessage");
    expect(msg?.payload.text).toContain("BRIGHT OS BRIEFING");
  });

  it("plain text routes to the command brain", async () => {
    dbHolder.db = createMockDb(byTable({}));
    const { bot, sent } = testBot();
    await bot.handleUpdate(textUpdate("what's blocking ALP?"));
    const msg = sent.find((s) => s.method === "sendMessage");
    expect(msg?.payload.text).toBeTruthy(); // placeholder brain reply until Phase 5
  });
});

describe("telegram webhook route", () => {
  it("rejects a missing/wrong secret token", async () => {
    dbHolder.db = createMockDb();
    const noSecret = await WEBHOOK(
      makeReq("http://os/api/telegram/webhook", { method: "POST", body: { update_id: 1 } }),
    );
    expect(noSecret.status).toBe(401);

    const wrong = await WEBHOOK(
      makeReq("http://os/api/telegram/webhook", {
        method: "POST",
        body: { update_id: 1 },
        headers: { "x-telegram-bot-api-secret-token": "nope" },
      }),
    );
    expect(wrong.status).toBe(401);
  });
});
