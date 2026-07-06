/**
 * BRIGHT OS seed — real agent fleet + brand roster.
 *
 *   npm run seed            # agents + brands only (idempotent upserts)
 *   npm run seed -- --demo  # also loads demo tasks/decisions/events for the smoke test
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env first.");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

const AGENTS = [
  { name: "CODEX", role: "VERIFIER · BOARD-KEEPER", kind: "claude", status: "idle" },
  { name: "COWORK", role: "ANALYST · WRITER", kind: "claude", status: "idle" },
  {
    name: 'OPENCLAW "JARVIS"',
    role: "EXECUTOR",
    kind: "openclaw",
    status: "idle",
    endpoint_url: process.env.OPENCLAW_URL ?? null,
  },
  {
    name: "HERMES",
    role: "MEMORY · RESEARCH",
    kind: "hermes",
    status: "idle",
    endpoint_url: process.env.HERMES_URL ?? null,
  },
  { name: "MARISOL · VA", role: "HUMAN VA", kind: "human", status: "idle" },
] as const;

const BRANDS = [
  {
    name: "Bright Family Clinic",
    tier: "engine",
    metrics: { visits_wtd: 0, no_show_rate: 0, outcome_label: "booked visit" },
  },
  {
    name: "AI Longevity Pro",
    tier: "engine",
    metrics: { waitlist: 0, gsc_clicks: 0, content_shipped: 0, outcome_label: "lead" },
  },
  { name: "Quantum Mind", tier: "cron_only", metrics: { beta_users: 0, outcome_label: "activated user" } },
  { name: "QCL", tier: "cron_only", metrics: { license_review_day: 0, outcome_label: "published post" } },
  { name: "BDS", tier: "cron_only", metrics: { active_clients: 0, outcome_label: "proposal" } },
] as const;

async function main() {
  const demo = process.argv.includes("--demo");

  const { error: agentErr } = await db
    .from("agents")
    .upsert(AGENTS as unknown as Record<string, unknown>[], { onConflict: "name" });
  if (agentErr) throw new Error(`agents seed failed: ${agentErr.message}`);
  console.log(`✓ agents: ${AGENTS.map((a) => a.name).join(", ")}`);

  const { error: brandErr } = await db
    .from("brands")
    .upsert(BRANDS as unknown as Record<string, unknown>[], { onConflict: "name" });
  if (brandErr) throw new Error(`brands seed failed: ${brandErr.message}`);
  console.log(`✓ brands: ${BRANDS.map((b) => `${b.name} (${b.tier})`).join(", ")}`);

  if (demo) await seedDemo();
  console.log("Seed complete.");
}

async function seedDemo() {
  const { data: agents } = await db.from("agents").select("id,name");
  const { data: brands } = await db.from("brands").select("id,name");
  const agent = (n: string) => agents?.find((a) => a.name.startsWith(n))?.id ?? null;
  const brand = (n: string) => brands?.find((b) => b.name === n)?.id ?? null;

  const { data: task, error: taskErr } = await db
    .from("tasks")
    .upsert(
      {
        title: "ALP: /beta-access landing copy",
        agent_id: agent("OPENCLAW"),
        brand_id: brand("AI Longevity Pro"),
        status: "awaiting_approval",
        source: "chat",
        frontmatter: { demo: true, url: "https://example.com/beta-access", expected_title: "Beta access" },
        obsidian_path: "Tasks/ALP beta-access landing copy.md",
      },
      { onConflict: "obsidian_path" },
    )
    .select()
    .single();
  if (taskErr) throw new Error(`demo task failed: ${taskErr.message}`);

  const { data: existingDecision } = await db
    .from("decisions")
    .select("id")
    .eq("task_id", task.id)
    .limit(1)
    .maybeSingle();
  if (!existingDecision) {
    const { error } = await db.from("decisions").insert({
      task_id: task.id,
      title: "Approve /beta-access copy — AI Longevity Pro",
      requesting_agent_id: agent("OPENCLAW"),
      brand_id: brand("AI Longevity Pro"),
      impact_note: "480 unconverted searches ≈ 96 leads/day",
      impact_dollars_estimate: 480,
      preview_md: [
        '+ Headline: "Your labs. Your protocol. One AI."',
        '+ CTA: "Claim beta access — 200 slots"',
        '- CTA: "Sign up for the waitlist"',
        "  Body: 3-step onboarding, HIPAA note, founder video embed",
      ].join("\n"),
      tags: ["publish"],
    });
    if (error) throw new Error(`demo decision failed: ${error.message}`);
  }

  const { error: claimErr } = await db.from("claims").insert({
    task_id: task.id,
    agent_id: agent("OPENCLAW"),
    claim_text: "Page deployed to /beta-access and returns 200",
    source_url: "https://example.com/beta-access",
    verified: false,
  });
  if (claimErr) console.warn(`demo claim skipped: ${claimErr.message}`);

  const { error: hbErr } = await db.from("heartbeat_events").insert([
    { source: "GHL", message: "+12 beta signups (AI Longevity Pro)", severity: "info" },
    { source: "GSC", message: "BPC-157 post +3 positions → #6", severity: "info" },
    { source: "OPENCLAW", message: "published /beta-access ✓", severity: "info" },
  ]);
  if (hbErr) console.warn(`demo events skipped: ${hbErr.message}`);
  console.log("✓ demo task + decision + claim + ticker events");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
