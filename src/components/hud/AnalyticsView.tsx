"use client";

import type { useHud } from "./data";
import { C, F } from "./theme";

export default function AnalyticsView({ hud }: { hud: ReturnType<typeof useHud> }) {
  const m = hud.metrics;
  if (!m) {
    return <div style={{ padding: 40, fontFamily: F.mono, color: C.dim }}>loading telemetry…</div>;
  }

  const models = m.by_model_30d;
  const totalModel = models.reduce((a, x) => a + x.cost_usd, 0);
  const donutColors = [C.arc, C.cyan, C.gold, C.violet, C.green];
  let acc = 0;
  const donutStops = models
    .map((x, i) => {
      const from = acc;
      acc += totalModel > 0 ? (x.cost_usd / totalModel) * 100 : 0;
      return `${donutColors[i % donutColors.length]} ${from.toFixed(1)}% ${acc.toFixed(1)}%`;
    })
    .join(",");

  const maxCell = Math.max(0.01, ...m.cost_heatmap_30d.flatMap((r) => r.days.map((d) => d.cost_usd)));
  const quality = m.quality_weekly;
  const maxCpo = Math.max(0.01, ...m.cost_per_outcome.map((c) => c.cost_per_outcome_usd ?? 0));

  return (
    <div style={{ position: "relative", zIndex: 5, display: "grid", gridTemplateColumns: "1.4fr 1fr", gridTemplateRows: "auto auto", gap: 12, padding: "14px 16px", height: "calc(100vh - 92px)", overflowY: "auto", animation: "fadeUp .4s ease-out both" }}>
      {/* 30-day cost heatmap */}
      <div className="hud-panel hud-corners hud-corners-tl-only" style={{ padding: 14 }}>
        <div style={{ fontFamily: F.rajdhani, fontWeight: 700, fontSize: 11, letterSpacing: ".22em", color: C.cyan, marginBottom: 12 }}>
          30-DAY COST HEATMAP · $ PER AGENT-DAY
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {m.cost_heatmap_30d.map((r) => (
            <div key={r.agent_id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <div style={{ width: 90, fontFamily: F.orbitron, fontWeight: 700, fontSize: 9.5, color: C.secondary, flex: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.agent_name.split(" ")[0]}
              </div>
              <div style={{ display: "flex", gap: 3, flex: 1 }}>
                {r.days.map((d) => (
                  <div key={d.day} title={`${d.day} · $${d.cost_usd.toFixed(2)}`} style={{ flex: 1, height: 16, borderRadius: 2, background: `rgba(0,212,255,${(0.05 + (d.cost_usd / maxCell) * 0.8).toFixed(2)})` }} />
                ))}
              </div>
              <div style={{ width: 56, textAlign: "right", fontFamily: F.mono, fontSize: 10, color: C.gold, flex: "none" }}>${r.total_usd.toFixed(0)}</div>
            </div>
          ))}
          {m.cost_heatmap_30d.length === 0 && <div style={{ fontFamily: F.mono, fontSize: 10, color: C.dim }}>no sessions logged yet</div>}
        </div>
      </div>

      {/* token burn by model */}
      <div className="hud-panel hud-corners hud-corners-tl-only" style={{ padding: 14 }}>
        <div style={{ fontFamily: F.rajdhani, fontWeight: 700, fontSize: 11, letterSpacing: ".22em", color: C.cyan, marginBottom: 12 }}>TOKEN BURN BY MODEL · 30D</div>
        <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
          <div style={{ position: "relative", width: 130, height: 130, flex: "none", borderRadius: "50%", background: totalModel > 0 ? `conic-gradient(${donutStops})` : "rgba(255,255,255,.06)", WebkitMask: "radial-gradient(closest-side,transparent 62%,#000 63%)", mask: "radial-gradient(closest-side,transparent 62%,#000 63%)" }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            {models.map((x, i) => (
              <div key={x.model} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <div style={{ width: 10, height: 10, borderRadius: 2, background: donutColors[i % donutColors.length] }} />
                <span style={{ fontFamily: F.rajdhani, fontWeight: 600, fontSize: 12, color: C.body }}>{x.model.replace("claude-", "").toUpperCase()}</span>
                <span style={{ fontFamily: F.mono, fontSize: 11, color: C.dim }}>
                  {x.pct}% · ${x.cost_usd.toFixed(2)}
                </span>
              </div>
            ))}
            {models.length === 0 && <div style={{ fontFamily: F.mono, fontSize: 10, color: C.dim }}>no burn yet</div>}
          </div>
        </div>
        <div style={{ marginTop: 10, fontFamily: F.mono, fontSize: 10, color: C.dim }}>
          TOTAL 30D SPEND: <span style={{ color: C.gold }}>${m.total_30d_usd.toFixed(2)}</span> · AVG ${(m.total_30d_usd / 30).toFixed(2)}/DAY · TODAY ${m.burn_today_usd.toFixed(2)}
        </div>
      </div>

      {/* quality scores */}
      <div className="hud-panel hud-corners hud-corners-tl-only" style={{ padding: 14 }}>
        <div style={{ fontFamily: F.rajdhani, fontWeight: 700, fontSize: 11, letterSpacing: ".22em", color: C.cyan, marginBottom: 12 }}>
          QUALITY SCORES · CODEX VERIFICATION PASS RATE
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 110 }}>
          {quality.map((q) => (
            <div key={q.week} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <div style={{ fontFamily: F.mono, fontSize: 9, color: q.avg_score != null ? C.green : C.dim }}>{q.avg_score ?? "·"}</div>
              <div style={{ width: "100%", borderRadius: "3px 3px 0 0", background: q.avg_score != null ? "linear-gradient(180deg,#3DF5A6,rgba(61,245,166,.15))" : "rgba(255,255,255,.05)", height: `${Math.round((q.avg_score ?? 4) * 0.85)}px` }} />
              <div style={{ fontFamily: F.mono, fontSize: 8.5, color: C.dim }}>{q.week}</div>
            </div>
          ))}
        </div>
      </div>

      {/* cost per outcome */}
      <div className="hud-corners" style={{ position: "relative", background: C.panel, backdropFilter: "blur(16px)", border: "1px solid rgba(255,184,77,.22)", borderRadius: 8, padding: 14, ["--corner-color" as string]: "rgba(255,184,77,.7)" }}>
        <div style={{ fontFamily: F.rajdhani, fontWeight: 700, fontSize: 11, letterSpacing: ".22em", color: C.gold, marginBottom: 12 }}>COST PER OUTCOME · BY BRAND</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {m.cost_per_outcome.map((cr) => (
            <div key={cr.brand} style={{ display: "grid", gridTemplateColumns: "150px 1fr 110px", gap: 10, alignItems: "center" }}>
              <div style={{ fontFamily: F.rajdhani, fontWeight: 600, fontSize: 12, color: C.body }}>{cr.brand}</div>
              <div style={{ height: 5, borderRadius: 3, background: "rgba(255,255,255,.06)", overflow: "hidden" }}>
                <div style={{ height: "100%", background: "linear-gradient(90deg,#FFB84D,#00D4FF)", width: `${Math.round(((cr.cost_per_outcome_usd ?? 0) / maxCpo) * 100)}%` }} />
              </div>
              <div style={{ textAlign: "right", fontFamily: F.mono, fontSize: 11, color: C.gold }}>
                {cr.cost_per_outcome_usd != null ? `$${cr.cost_per_outcome_usd.toFixed(2)} / ${cr.outcome_label}` : `$${cr.cost_usd_30d.toFixed(2)} · 0 outcomes`}
              </div>
            </div>
          ))}
          {m.cost_per_outcome.length === 0 && <div style={{ fontFamily: F.mono, fontSize: 10, color: C.dim }}>link tasks to brands to attribute spend</div>}
        </div>
      </div>
    </div>
  );
}
