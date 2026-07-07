"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { HudDataProvider, useHud } from "./data";
import { Boot, Particles, Stamp } from "./chrome";
import { C, F, chime, isoWeekLabel } from "./theme";
import { deriveDecisions, deriveFleet, derivePods } from "./derive";
import CommandView from "./CommandView";
import BoardView from "./BoardView";
import BrandsView from "./BrandsView";
import AnalyticsView from "./AnalyticsView";
import MemoryView from "./MemoryView";
import MobileView from "./MobileView";
import AgentDrawer from "./AgentDrawer";

export type Tab = "command" | "board" | "brands" | "analytics" | "memory" | "mobile";
const TABS: [Tab, string][] = [
  ["command", "COMMAND"],
  ["board", "BOARD"],
  ["brands", "BRANDS"],
  ["analytics", "ANALYTICS"],
  ["memory", "MEMORY"],
  ["mobile", "MOBILE"],
];

export default function BrightOS() {
  return (
    <HudDataProvider>
      <Shell />
    </HudDataProvider>
  );
}

function Shell() {
  const hud = useHud();
  const [booted, setBooted] = useState(false);
  const [tab, setTab] = useState<Tab>("command");
  const [sound, setSound] = useState(false);
  const [stamp, setStamp] = useState<{ text: string; color: string } | null>(null);
  const [selAgent, setSelAgent] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setBooted(true), 1600);
    return () => clearTimeout(t);
  }, []);

  const showStamp = useCallback((text: string, color: string = C.green) => {
    setStamp({ text, color });
    setTimeout(() => setStamp(null), 1100);
  }, []);

  const fleet = useMemo(
    () => deriveFleet(hud.agents, hud.tasks, hud.metrics, hud.memory),
    [hud.agents, hud.tasks, hud.metrics, hud.memory],
  );
  const decisions = useMemo(() => deriveDecisions(hud.decisions, hud.agents), [hud.decisions, hud.agents]);
  const pods = useMemo(() => derivePods(hud.brands), [hud.brands]);
  const pendingCount = decisions.filter((d) => d.status === "pending").length;

  const alerts = hud.events.filter((e) => e.severity === "alert").length;
  const lastBeat = hud.events.find((e) => e.source === "HEARTBEAT");
  const beatLabel = lastBeat
    ? new Date(lastBeat.ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" })
    : "—";
  const burn = hud.metrics?.burn_today_usd ?? 0;
  const cap = hud.metrics?.daily_cap_usd ?? 60;
  const breakerTripped = hud.metrics?.cost_breaker?.tripped ?? false;

  const goTab = (k: Tab) => {
    setTab(k);
    chime(sound, 520, 0.12);
  };

  const ctx = { hud, fleet, decisions, pendingCount, sound, showStamp, setSelAgent, goTab };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.body, fontFamily: F.inter, fontSize: 13, position: "relative", overflow: "hidden" }}>
      <Particles />
      {!booted && <Boot onSkip={() => setBooted(true)} />}

      {/* ============ TOP HUD BAR ============ */}
      <div style={{ position: "relative", zIndex: 10, display: "flex", alignItems: "center", gap: 20, height: 56, padding: "0 18px", borderBottom: "1px solid rgba(0,212,255,.18)", background: C.panel, backdropFilter: "blur(16px)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 250 }}>
          <div style={{ fontFamily: F.orbitron, fontWeight: 900, fontSize: 17, color: C.arc, letterSpacing: ".14em", textShadow: "0 0 18px rgba(0,212,255,.7)" }}>
            BRIGHT<span style={{ color: C.cyan }}>OS</span>
          </div>
          <div style={{ fontFamily: F.mono, fontSize: 11, color: C.dim }}>{isoWeekLabel()}</div>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: breakerTripped ? C.red : C.green, boxShadow: `0 0 8px ${breakerTripped ? C.red : C.green}`, animation: "ledBlink 2.4s ease-in-out infinite" }} />
          <div style={{ fontFamily: F.rajdhani, fontWeight: 600, fontSize: 11, letterSpacing: ".16em", color: breakerTripped ? C.red : C.green }}>
            {breakerTripped ? "PAUSED" : "NOMINAL"}
          </div>
        </div>
        <div style={{ flex: 1, display: "flex", justifyContent: "center", gap: 10 }}>
          {pods.map((p) => (
            <div key={p.name} className="hud-hover" style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", border: "1px solid rgba(0,212,255,.16)", borderRadius: 6, background: "rgba(10,20,35,.5)" }}>
              <div style={{ width: 18, height: 18, borderRadius: "50%", background: p.ring, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <div style={{ width: 11, height: 11, borderRadius: "50%", background: "#0A1423" }} />
              </div>
              <div>
                <div style={{ fontFamily: F.rajdhani, fontWeight: 700, fontSize: 10.5, letterSpacing: ".12em", color: C.body }}>{p.name}</div>
                <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 10, marginTop: 2 }}>
                  {p.spark.map((h, i) => (
                    <div key={i} style={{ width: 3, borderRadius: 1, background: p.color, height: h }} />
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 330, justifyContent: "flex-end" }}>
          <div style={{ fontFamily: F.mono, fontSize: 11, color: C.green }}>HEARTBEAT: {beatLabel} ✓</div>
          <div style={{ fontFamily: F.mono, fontSize: 11, color: C.gold }}>
            BURN ${burn.toFixed(2)}
            <span style={{ color: C.dim }}>/${cap}</span>
          </div>
          <div onClick={() => goTab("command")} style={{ position: "relative", cursor: "pointer", fontSize: 15, lineHeight: 1 }} title="Alerts">
            <span style={{ color: C.arc }}>◬</span>
            {alerts > 0 && (
              <div style={{ position: "absolute", top: -6, right: -9, minWidth: 15, height: 15, borderRadius: 8, background: C.red, color: "#fff", fontFamily: F.mono, fontSize: 9, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 0 8px rgba(255,77,109,.8)" }}>
                {alerts}
              </div>
            )}
          </div>
          <div
            onClick={() => {
              const on = !sound;
              setSound(on);
              if (on) chime(true, 880, 0.2);
            }}
            style={{ cursor: "pointer", padding: "4px 9px", border: `1px solid ${sound ? "rgba(61,245,166,.5)" : "rgba(94,122,147,.4)"}`, borderRadius: 5, fontFamily: F.rajdhani, fontWeight: 700, fontSize: 10, letterSpacing: ".14em", color: sound ? C.green : C.dim }}
            title="Sound toggle"
          >
            {sound ? "♪ SOUND ON" : "♪ MUTED"}
          </div>
          <a href="/api/auth/logout" onClick={(e) => { e.preventDefault(); void fetch("/api/auth/logout", { method: "POST" }).then(() => window.location.assign("/login")); }} style={{ cursor: "pointer", padding: "4px 9px", border: "1px solid rgba(94,122,147,.4)", borderRadius: 5, fontFamily: F.rajdhani, fontWeight: 700, fontSize: 10, letterSpacing: ".14em", color: C.dim }} className="hover-red">
            ⏻
          </a>
        </div>
      </div>

      {/* tab strip */}
      <div style={{ position: "relative", zIndex: 10, display: "flex", gap: 4, padding: "0 18px", height: 36, alignItems: "stretch", borderBottom: "1px solid rgba(0,212,255,.12)", background: "rgba(8,16,28,.6)", backdropFilter: "blur(16px)" }}>
        {TABS.map(([k, label]) => (
          <div
            key={k}
            onClick={() => goTab(k)}
            className="hover-arc"
            style={{
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              padding: "0 16px",
              fontFamily: F.rajdhani,
              fontWeight: 700,
              fontSize: 12,
              letterSpacing: ".18em",
              color: tab === k ? C.cyan : C.dim,
              borderBottom: `2px solid ${tab === k ? C.cyan : "transparent"}`,
              textShadow: tab === k ? "0 0 12px rgba(0,212,255,.8)" : "none",
            }}
          >
            {label}
          </div>
        ))}
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", fontFamily: F.mono, fontSize: 10, color: C.dim }}>
          DR. BRANDON BRIGHT · SUPERVISOR
        </div>
      </div>

      {/* views */}
      {booted && (
        <>
          {tab === "command" && <CommandView {...ctx} />}
          {tab === "board" && <BoardView {...ctx} />}
          {tab === "brands" && <BrandsView hud={hud} />}
          {tab === "analytics" && <AnalyticsView hud={hud} />}
          {tab === "memory" && <MemoryView hud={hud} showStamp={showStamp} sound={sound} />}
          {tab === "mobile" && <MobileView {...ctx} />}
        </>
      )}

      {selAgent && (
        <AgentDrawer agent={fleet.find((a) => a.id === selAgent) ?? null} hud={hud} onClose={() => setSelAgent(null)} />
      )}
      {stamp && <Stamp text={stamp.text} color={stamp.color} />}
    </div>
  );
}

export interface ViewCtx {
  hud: ReturnType<typeof useHud>;
  fleet: ReturnType<typeof deriveFleet>;
  decisions: ReturnType<typeof deriveDecisions>;
  pendingCount: number;
  sound: boolean;
  showStamp: (text: string, color?: string) => void;
  setSelAgent: (id: string | null) => void;
  goTab: (t: Tab) => void;
}
