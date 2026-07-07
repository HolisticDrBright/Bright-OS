"use client";

import { useMemo } from "react";
import type { useHud } from "./data";
import type { FleetAgent } from "./derive";
import { AGENT_SKILLS } from "./derive";
import { HexAvatar } from "./chrome";
import { C, F } from "./theme";

export default function AgentDrawer({
  agent,
  hud,
  onClose,
}: {
  agent: FleetAgent | null;
  hud: ReturnType<typeof useHud>;
  onClose: () => void;
}) {
  const feed = useMemo(() => {
    if (!agent) return [];
    const first = agent.name.split(" ")[0].replace(/[^A-Za-z]/g, "").toUpperCase();
    return hud.events
      .filter((e) => e.source.toUpperCase().includes(first) || JSON.stringify(e.meta).includes(agent.id))
      .slice(0, 8);
  }, [agent, hud.events]);

  const heatRow = hud.metrics?.cost_heatmap_30d.find((r) => r.agent_id === agent?.id);
  const maxCell = Math.max(0.01, ...(heatRow?.days.map((d) => d.cost_usd) ?? [0]));

  if (!agent) return null;
  const skills = AGENT_SKILLS[agent.glyph] ?? [];
  const hermesDash = process.env.NEXT_PUBLIC_HERMES_DASHBOARD_URL;

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(2,5,10,.6)", backdropFilter: "blur(3px)" }} />
      <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, zIndex: 95, width: 430, background: "rgba(8,16,28,.92)", backdropFilter: "blur(20px)", borderLeft: "1px solid rgba(0,212,255,.3)", padding: 20, overflowY: "auto", animation: "fadeUp .3s ease-out both", boxShadow: "-20px 0 60px rgba(0,0,0,.5)" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <HexAvatar glyph={agent.glyph} color={agent.st.color} size={54} ringAnim={agent.st.anim} />
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: F.orbitron, fontWeight: 700, fontSize: 15, color: C.bright, letterSpacing: ".06em" }}>{agent.name}</div>
            <div style={{ fontFamily: F.rajdhani, fontWeight: 600, fontSize: 11, letterSpacing: ".14em", color: agent.st.color }}>
              {agent.st.label} · {agent.role}
            </div>
          </div>
          <div onClick={onClose} className="hover-red" style={{ cursor: "pointer", fontFamily: F.mono, color: C.dim, fontSize: 15, padding: 4 }}>
            ✕
          </div>
        </div>

        <div style={{ display: "flex", gap: 14, marginTop: 16, fontFamily: F.mono, fontSize: 11, flexWrap: "wrap" }}>
          <span style={{ color: C.gold }}>${agent.costToday.toFixed(2)} today</span>
          <span style={{ color: C.green }}>✓ {agent.done} done</span>
          <span style={{ color: C.red }}>✗ {agent.failed} failed</span>
          {agent.memories !== null && <span style={{ color: C.arc }}>◈ {agent.memories} memories</span>}
        </div>

        {agent.kind === "hermes" && hermesDash && (
          <a href={hermesDash} target="_blank" rel="noreferrer" className="btn-cyan" style={{ display: "inline-block", marginTop: 14, padding: "7px 14px", border: "1px solid rgba(0,212,255,.5)", borderRadius: 6, fontFamily: F.rajdhani, fontWeight: 700, fontSize: 11, letterSpacing: ".14em", color: C.cyan }}>
            OPEN HERMES DASHBOARD ↗
          </a>
        )}
        {agent.kind === "openclaw" && agent.endpoint_url && (
          <a href={agent.endpoint_url} target="_blank" rel="noreferrer" className="btn-cyan" style={{ display: "inline-block", marginTop: 14, padding: "7px 14px", border: "1px solid rgba(0,212,255,.5)", borderRadius: 6, fontFamily: F.rajdhani, fontWeight: 700, fontSize: 11, letterSpacing: ".14em", color: C.cyan }}>
            OPEN OPENCLAW ↗
          </a>
        )}

        <div style={{ marginTop: 20, fontFamily: F.rajdhani, fontWeight: 700, fontSize: 10, letterSpacing: ".22em", color: C.cyan }}>LIVE SESSION FEED</div>
        <div style={{ marginTop: 8, border: "1px solid rgba(0,212,255,.14)", borderRadius: 7, background: "rgba(5,10,20,.7)", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 7 }}>
          {feed.map((f) => (
            <div key={f.id} style={{ fontFamily: F.mono, fontSize: 10.5, lineHeight: 1.55, color: "#B8D2E4" }}>
              <span style={{ color: C.dim }}>{new Date(f.ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" })}</span>{" "}
              <span style={{ color: f.severity === "alert" ? C.red : f.severity === "warn" ? C.gold : C.green }}>{f.source}</span> {f.message}
            </div>
          ))}
          {feed.length === 0 && <div style={{ fontFamily: F.mono, fontSize: 10.5, color: C.dim }}>no recent events from this agent</div>}
          <div style={{ fontFamily: F.mono, fontSize: 10.5, color: C.cyan, animation: "ledBlink 1.2s ease-in-out infinite" }}>▌</div>
        </div>

        <div style={{ marginTop: 20, fontFamily: F.rajdhani, fontWeight: 700, fontSize: 10, letterSpacing: ".22em", color: C.cyan }}>30-DAY SPEND</div>
        <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "repeat(15,1fr)", gap: 3 }}>
          {(heatRow?.days ?? []).map((d) => (
            <div key={d.day} title={`${d.day} · $${d.cost_usd.toFixed(2)}`} style={{ height: 18, borderRadius: 3, background: `rgba(0,212,255,${(0.06 + (d.cost_usd / maxCell) * 0.75).toFixed(2)})` }} />
          ))}
          {!heatRow && <div style={{ gridColumn: "1/-1", fontFamily: F.mono, fontSize: 10, color: C.dim }}>no sessions logged</div>}
        </div>

        <div style={{ marginTop: 20, fontFamily: F.rajdhani, fontWeight: 700, fontSize: 10, letterSpacing: ".22em", color: C.cyan }}>SKILL LIST</div>
        <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
          {skills.map((sk) => (
            <div key={sk} style={{ padding: "4px 10px", border: "1px solid rgba(0,212,255,.3)", borderRadius: 12, fontFamily: F.mono, fontSize: 10, color: C.arc }}>
              {sk}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
