import type { SupabaseClient } from "@supabase/supabase-js";
import { writeCloseout } from "@/lib/obsidian";
import { sendMarkdown, escapeHtml } from "@/lib/telegram/send";

/**
 * WEEKLY CLOSEOUT — Friday 16:00 America/Los_Angeles.
 * shipped/verified/blocked/roll-forward + $-in vs $-out per engine brand →
 * vault note + Telegram summary.
 */

export function isoWeekLabel(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 864e5 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export interface Closeout {
  week: string;
  markdown: string;
  telegramHtml: string;
}

export async function composeCloseout(db: SupabaseClient, now = new Date()): Promise<Closeout> {
  const week = isoWeekLabel(now);
  const weekStart = new Date(now.getTime() - 7 * 864e5).toISOString();

  const [tasksRes, brandsRes, sessionsRes, agentsRes] = await Promise.all([
    db.from("tasks").select("*").gte("updated_at", weekStart),
    db.from("brands").select("*"),
    db.from("agent_sessions").select("*").gte("started_at", weekStart),
    db.from("agents").select("id,name"),
  ]);
  const tasks = tasksRes.data ?? [];
  const brands = brandsRes.data ?? [];
  const agentName = new Map((agentsRes.data ?? []).map((a) => [a.id, a.name]));

  const shipped = tasks.filter((t) => t.status === "shipped");
  const verified = tasks.filter((t) => t.status === "verified");
  const blocked = tasks.filter((t) => ["awaiting_approval", "failed"].includes(t.status));
  const rollForward = tasks.filter((t) => ["assigned", "in_progress", "backlog"].includes(t.status));

  const burnByAgent = new Map<string, number>();
  let weekBurn = 0;
  for (const s of sessionsRes.data ?? []) {
    weekBurn += Number(s.cost_usd ?? 0);
    const name = agentName.get(s.agent_id) ?? "unattributed";
    burnByAgent.set(name, (burnByAgent.get(name) ?? 0) + Number(s.cost_usd ?? 0));
  }

  const engines = brands.filter((b) => b.tier === "engine");

  const md: string[] = [
    `# Weekly Closeout — ${week}`,
    "",
    "## $-in vs $-out (engines)",
    ...engines.map((b) => {
      const rev = Number(b.revenue_wtd ?? 0);
      const spend = Number(b.spend_wtd ?? 0);
      return `- **${b.name}**: $${rev.toFixed(0)} in / $${spend.toFixed(0)} out → net $${(rev - spend).toFixed(0)}`;
    }),
    `- **Agent burn (week)**: $${weekBurn.toFixed(2)}`,
    ...[...burnByAgent.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `  - ${n}: $${c.toFixed(2)}`),
    "",
    `## Shipped (${shipped.length})`,
    ...shipped.map((t) => `- [x] ${t.title}`),
    "",
    `## Verified (${verified.length})`,
    ...verified.map((t) => `- [x] ${t.title}`),
    "",
    `## Blocked (${blocked.length})`,
    ...blocked.map((t) => `- [ ] ${t.title} (${t.status})`),
    "",
    `## Roll-forward (${rollForward.length})`,
    ...rollForward.map((t) => `- [ ] ${t.title} (${t.status})`),
    "",
  ];
  const markdown = md.join("\n");

  const tg = [
    `<b>WEEKLY CLOSEOUT — ${week}</b>`,
    "",
    ...engines.map((b) => {
      const rev = Number(b.revenue_wtd ?? 0);
      const spend = Number(b.spend_wtd ?? 0);
      return `💰 ${escapeHtml(b.name)}: $${rev.toFixed(0)} in / $${spend.toFixed(0)} out (net $${(rev - spend).toFixed(0)})`;
    }),
    `🔥 agent burn: $${weekBurn.toFixed(2)}`,
    "",
    `✅ shipped ${shipped.length} · verified ${verified.length} · ⏳ blocked ${blocked.length} · ▸ roll-forward ${rollForward.length}`,
    "",
    "Full closeout note is in the vault.",
  ].join("\n");

  return { week, markdown, telegramHtml: tg };
}

export async function runWeeklyCloseout(db: SupabaseClient, now = new Date()): Promise<Closeout> {
  const closeout = await composeCloseout(db, now);
  await writeCloseout(closeout.week, closeout.markdown).catch(() => {});
  await sendMarkdown(closeout.telegramHtml).catch(() => {});
  await db.from("heartbeat_events").insert({
    source: "CLOSEOUT",
    message: `weekly closeout written for ${closeout.week}`,
    severity: "info",
    meta: { week: closeout.week },
  });
  return closeout;
}
