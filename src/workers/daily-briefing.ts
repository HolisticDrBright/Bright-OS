import type { SupabaseClient } from "@supabase/supabase-js";
import { appendToDailyNote } from "@/lib/obsidian";
import { sendMarkdown, escapeHtml } from "@/lib/telegram/send";
import { startOfTodayIso } from "@/lib/guardrails";

/**
 * DAILY BRIEFING — 06:00 America/Los_Angeles.
 * Pending decisions by $-impact, yesterday's shipped+verified, burn by
 * agent, focus-engine metrics, top 3 alerts → Telegram + Obsidian daily note.
 */

export interface Briefing {
  day: string;
  markdown: string;
  telegramHtml: string;
}

const HOURS = 36e5;
const fmtUsd = (n: number) => `$${n.toFixed(2)}`;

export async function composeBriefing(db: SupabaseClient, now = new Date()): Promise<Briefing> {
  const todayStart = startOfTodayIso(now);
  const yesterdayStart = new Date(new Date(todayStart).getTime() - 24 * HOURS).toISOString();
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.TZ ?? "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

  const [decisions, shippedTasks, sessions, brands, alerts, agents] = await Promise.all([
    db.from("decisions").select("*").eq("status", "pending"),
    db
      .from("tasks")
      .select("*")
      .in("status", ["verified", "shipped"])
      .gte("updated_at", yesterdayStart)
      .lte("updated_at", todayStart),
    db.from("agent_sessions").select("*").gte("started_at", yesterdayStart),
    db.from("brands").select("*").eq("tier", "engine"),
    db
      .from("heartbeat_events")
      .select("*")
      .eq("severity", "alert")
      .gte("ts", yesterdayStart)
      .order("ts", { ascending: false })
      .limit(3),
    db.from("agents").select("id,name"),
  ]);

  const agentName = new Map((agents.data ?? []).map((a) => [a.id, a.name]));

  const pending = (decisions.data ?? []).sort(
    (a, b) => Number(b.impact_dollars_estimate ?? 0) - Number(a.impact_dollars_estimate ?? 0),
  );
  const burnByAgent = new Map<string, number>();
  for (const s of sessions.data ?? []) {
    const name = agentName.get(s.agent_id) ?? "unattributed";
    burnByAgent.set(name, (burnByAgent.get(name) ?? 0) + Number(s.cost_usd ?? 0));
  }

  const md: string[] = [`## BRIGHT OS Briefing — ${day}`, ""];

  md.push(`### Decisions pending (${pending.length})`);
  if (pending.length === 0) md.push("- ALL CLEAR — nothing needs you");
  for (const d of pending) {
    const age = Math.round((now.getTime() - new Date(d.created_at).getTime()) / HOURS);
    const impact = d.impact_dollars_estimate ? ` · ~$${Number(d.impact_dollars_estimate).toFixed(0)}` : "";
    md.push(`- **${d.title}** (${age}h${impact})${d.impact_note ? ` — ${d.impact_note}` : ""}`);
  }
  md.push("");

  md.push(`### Shipped + verified yesterday (${(shippedTasks.data ?? []).length})`);
  for (const t of shippedTasks.data ?? []) md.push(`- ${t.title} → ${t.status}`);
  if ((shippedTasks.data ?? []).length === 0) md.push("- none");
  md.push("");

  const totalBurn = [...burnByAgent.values()].reduce((a, b) => a + b, 0);
  md.push(`### Cost burn since yesterday (${fmtUsd(totalBurn)})`);
  for (const [name, cost] of [...burnByAgent.entries()].sort((a, b) => b[1] - a[1])) {
    md.push(`- ${name}: ${fmtUsd(cost)}`);
  }
  if (burnByAgent.size === 0) md.push("- $0.00");
  md.push("");

  md.push("### Focus engines");
  for (const b of brands.data ?? []) {
    const metrics = (b.metrics ?? {}) as Record<string, unknown>;
    const extras = Object.entries(metrics)
      .filter(([k, v]) => k !== "outcome_label" && (typeof v === "number" || typeof v === "string"))
      .map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`)
      .join(" · ");
    md.push(
      `- **${b.name}**: $${Number(b.revenue_wtd).toFixed(0)} in / $${Number(b.spend_wtd).toFixed(0)} out WTD${extras ? ` · ${extras}` : ""}`,
    );
  }
  md.push("");

  md.push("### Top alerts (24h)");
  for (const a of alerts.data ?? []) md.push(`- [${a.source}] ${a.message}`);
  if ((alerts.data ?? []).length === 0) md.push("- none 🎉");

  const markdown = md.join("\n");

  const tgLines = [
    `<b>BRIGHT OS BRIEFING — ${day}</b>`,
    "",
    `🔶 <b>${pending.length} decisions pending</b>`,
    ...pending
      .slice(0, 5)
      .map((d) => `  · ${escapeHtml(d.title)} (${Math.round((now.getTime() - new Date(d.created_at).getTime()) / HOURS)}h)`),
    "",
    `✅ shipped/verified yesterday: ${(shippedTasks.data ?? []).length}`,
    `🔥 burn: ${fmtUsd(totalBurn)}`,
    ...(brands.data ?? []).map(
      (b) => `📈 ${escapeHtml(b.name)}: $${Number(b.revenue_wtd).toFixed(0)} in / $${Number(b.spend_wtd).toFixed(0)} out`,
    ),
    ...(alerts.data ?? []).length ? ["", "🔴 <b>alerts</b>"] : [],
    ...(alerts.data ?? []).map((a) => `  · ${escapeHtml(`[${a.source}] ${a.message}`)}`),
    "",
    "/brief to replay · reply to discuss",
  ];

  return { day, markdown, telegramHtml: tgLines.join("\n") };
}

export async function runDailyBriefing(db: SupabaseClient, now = new Date()): Promise<Briefing> {
  const briefing = await composeBriefing(db, now);
  await sendMarkdown(briefing.telegramHtml).catch(() => {});
  await appendToDailyNote(briefing.day, briefing.markdown).catch(() => {});
  await db.from("heartbeat_events").insert({
    source: "BRIEFING",
    message: `daily briefing sent for ${briefing.day}`,
    severity: "info",
    meta: { day: briefing.day },
  });
  return briefing;
}
