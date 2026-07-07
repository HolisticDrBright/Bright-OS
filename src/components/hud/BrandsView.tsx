"use client";

import type { useHud } from "./data";
import { C, F } from "./theme";

export default function BrandsView({ hud }: { hud: ReturnType<typeof useHud> }) {
  const engines = hud.brands.filter((b) => b.tier === "engine");
  const cron = hud.brands.filter((b) => b.tier === "cron_only");
  const cpo = hud.metrics?.cost_per_outcome ?? [];

  const metricCards = (b: (typeof engines)[number]) => {
    const rev = Number(b.revenue_wtd ?? 0);
    const spend = Number(b.spend_wtd ?? 0);
    const extras = Object.entries(b.metrics ?? {})
      .filter(([k, v]) => k !== "outcome_label" && (typeof v === "number" || typeof v === "string"))
      .slice(0, 2);
    const cards: { label: string; value: string; color: string }[] = [
      { label: "REVENUE WTD", value: `$${rev.toLocaleString()}`, color: C.gold },
      { label: "SPEND WTD", value: `$${spend.toLocaleString()}`, color: C.body },
      ...extras.map(([k, v]) => ({
        label: k.replace(/_/g, " ").toUpperCase(),
        value: String(v),
        color: C.arc,
      })),
    ];
    while (cards.length < 4) cards.push({ label: "—", value: "·", color: C.dim });
    return cards.slice(0, 4);
  };

  return (
    <div style={{ position: "relative", zIndex: 5, padding: "14px 16px", height: "calc(100vh - 92px)", overflowY: "auto", animation: "fadeUp .4s ease-out both" }}>
      <div style={{ fontFamily: F.rajdhani, fontWeight: 700, fontSize: 11, letterSpacing: ".24em", color: C.gold, marginBottom: 10 }}>
        FOCUS ENGINES · FULL TELEMETRY
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 18 }}>
        {engines.map((b) => {
          const outcome = cpo.find((c) => c.brand === b.name);
          return (
            <div key={b.id} className="hud-corners hud-corners-lg" style={{ position: "relative", background: C.panel, backdropFilter: "blur(16px)", border: "1px solid rgba(255,184,77,.3)", borderRadius: 10, padding: 16, ["--corner-color" as string]: "rgba(255,184,77,.8)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div style={{ fontFamily: F.orbitron, fontWeight: 700, fontSize: 15, color: C.bright, letterSpacing: ".05em" }}>{b.name.toUpperCase()}</div>
                <div style={{ fontFamily: F.rajdhani, fontWeight: 700, fontSize: 10, letterSpacing: ".2em", color: C.gold, border: "1px solid rgba(255,184,77,.4)", borderRadius: 4, padding: "2px 8px" }}>FOCUS ENGINE</div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginTop: 14 }}>
                {metricCards(b).map((m, i) => (
                  <div key={i}>
                    <div style={{ fontFamily: F.mono, fontSize: 17, fontWeight: 600, color: m.color }}>{m.value}</div>
                    <div style={{ fontFamily: F.rajdhani, fontSize: 9.5, letterSpacing: ".14em", color: C.dim, marginTop: 2 }}>{m.label}</div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid rgba(0,212,255,.12)", fontSize: 11.5, color: C.secondary, lineHeight: 1.5 }}>
                ▸ {outcome ? `${outcome.outcomes_30d} × ${outcome.outcome_label} in 30d · $${outcome.cost_usd_30d.toFixed(2)} agent spend${outcome.cost_per_outcome_usd != null ? ` · $${outcome.cost_per_outcome_usd.toFixed(2)}/${outcome.outcome_label}` : ""}` : "no attributed agent spend yet — link tasks to this brand"}
              </div>
            </div>
          );
        })}
        {engines.length === 0 && (
          <div style={{ fontFamily: F.mono, fontSize: 11, color: C.dim }}>no engine-tier brands — run the seed script</div>
        )}
      </div>

      <div style={{ fontFamily: F.rajdhani, fontWeight: 700, fontSize: 11, letterSpacing: ".24em", color: C.dim, marginBottom: 10 }}>
        CRON-ONLY TIER · WEEKLY DIGEST
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 10 }}>
        {cron.map((b) => {
          const tasks = hud.tasks.filter((t) => t.brand_id === b.id);
          const activeTasks = tasks.filter((t) => ["assigned", "in_progress", "awaiting_approval"].includes(t.status)).length;
          const led = activeTasks > 0 ? C.green : tasks.length > 0 ? C.arc : C.dim;
          const stat = Object.entries(b.metrics ?? {}).find(([k, v]) => k !== "outcome_label" && (typeof v === "number" || typeof v === "string"));
          return (
            <div key={b.id} className="hud-hover" style={{ background: "rgba(10,20,35,.45)", backdropFilter: "blur(16px)", border: "1px solid rgba(0,212,255,.14)", borderRadius: 7, padding: 11 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontFamily: F.rajdhani, fontWeight: 700, fontSize: 12, color: C.body, letterSpacing: ".05em" }}>{b.name}</div>
                <div style={{ width: 7, height: 7, borderRadius: "50%", background: led, boxShadow: `0 0 6px ${led}` }} />
              </div>
              <div style={{ fontFamily: F.mono, fontSize: 10, color: C.dim, marginTop: 5 }}>
                {stat ? `${stat[0].replace(/_/g, " ").toUpperCase()} · ${stat[1]}` : "CRON · digest only"}
              </div>
              <div style={{ fontSize: 10.5, color: C.secondary, marginTop: 6, lineHeight: 1.45 }}>
                {activeTasks > 0 ? `${activeTasks} task${activeTasks > 1 ? "s" : ""} in motion.` : "Quiet. Weekly digest only."}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
