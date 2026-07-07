"use client";

import { useRef, useState } from "react";
import type { ViewCtx } from "./BrightOS";
import { DiffLines, HexAvatar } from "./chrome";
import { C, F, chime } from "./theme";
import { eventColor } from "./derive";

/** Approval-first phone view — same anatomy as the queue, thumb-sized. */
export default function MobileView(ctx: ViewCtx) {
  const { hud, decisions, pendingCount, sound, showStamp } = ctx;
  const [tickerOpen, setTickerOpen] = useState(false);
  const [anim, setAnim] = useState<"approved" | "rejected" | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  const pending = decisions.filter((d) => d.status === "pending");
  const mc = pending[0] ?? null;

  const act = async (action: "approve" | "reject" | "discuss") => {
    if (!mc) return;
    if (action !== "discuss") {
      setAnim(action === "approve" ? "approved" : "rejected");
      chime(sound, action === "approve" ? 1046 : 320, 0.3);
    }
    const res = await hud.decide(mc.id, action);
    if (res.ok && action !== "discuss") {
      showStamp(action === "approve" ? "APPROVED ✓" : "REJECTED ✕", action === "approve" ? C.green : C.red);
    } else if (!res.ok) {
      showStamp("BLOCKED", C.red);
    }
    setTimeout(() => setAnim(null), 450);
  };

  return (
    <div style={{ position: "relative", zIndex: 5, display: "flex", gap: 40, alignItems: "flex-start", justifyContent: "center", padding: "22px 16px", animation: "fadeUp .4s ease-out both" }}>
      {/* phone frame */}
      <div style={{ width: 390, height: 780, borderRadius: 54, border: "2px solid rgba(120,140,160,.35)", boxShadow: "0 24px 80px rgba(0,0,0,.6), inset 0 0 0 10px #000", padding: 12, background: "#000", flex: "none" }}>
        <div style={{ height: "100%", borderRadius: 42, overflow: "hidden", display: "flex", flexDirection: "column", background: C.bg, color: C.body, fontFamily: F.inter, position: "relative" }}>
          <div style={{ position: "absolute", inset: 0, pointerEvents: "none", opacity: 0.5, backgroundImage: "repeating-linear-gradient(60deg,rgba(0,212,255,.03) 0 1px,transparent 1px 30px),repeating-linear-gradient(-60deg,rgba(0,212,255,.03) 0 1px,transparent 1px 30px)" }} />
          {/* header */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "18px 16px 8px", borderBottom: "1px solid rgba(0,212,255,.16)" }}>
            <div style={{ position: "relative", width: 34, height: 34, flex: "none" }}>
              <div style={{ position: "absolute", inset: 0, borderRadius: "50%", border: "1px dashed rgba(0,212,255,.5)", animation: "spinCW 8s linear infinite" }} />
              <div style={{ position: "absolute", inset: 7, borderRadius: "50%", background: "radial-gradient(circle,#FFFFFF 0%,#9BE8FF 32%,rgba(0,212,255,.55) 65%,transparent 100%)", boxShadow: "0 0 14px rgba(0,212,255,.7)", animation: "breathe 3s ease-in-out infinite" }} />
            </div>
            <div>
              <div style={{ fontFamily: F.orbitron, fontWeight: 900, fontSize: 13, color: C.arc, letterSpacing: ".12em" }}>
                BRIGHT<span style={{ color: C.cyan }}>OS</span>
              </div>
              <div style={{ fontFamily: F.mono, fontSize: 9, color: C.green }}>
                HEARTBEAT {hud.events.find((e) => e.source === "HEARTBEAT") ? new Date(hud.events.find((e) => e.source === "HEARTBEAT")!.ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" }) : "—"} ✓
              </div>
            </div>
            <div style={{ marginLeft: "auto", fontFamily: F.mono, fontSize: 10, color: C.gold, border: "1px solid rgba(255,184,77,.4)", borderRadius: 10, padding: "3px 9px" }}>
              {pendingCount} DECISIONS
            </div>
          </div>
          {/* live feed pull-down */}
          <div onClick={() => setTickerOpen(!tickerOpen)} style={{ cursor: "pointer", padding: "5px 16px", borderBottom: "1px solid rgba(0,212,255,.1)", fontFamily: F.mono, fontSize: 9.5, color: C.dim, display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: C.cyan }}>{tickerOpen ? "▴" : "▾"}</span> LIVE FEED
          </div>
          {tickerOpen && (
            <div style={{ padding: "8px 16px", borderBottom: "1px solid rgba(0,212,255,.12)", display: "flex", flexDirection: "column", gap: 5, background: "rgba(10,20,35,.6)", maxHeight: 140, overflowY: "auto" }}>
              {hud.events.slice(0, 8).map((ev) => (
                <div key={ev.id} style={{ fontFamily: F.mono, fontSize: 9.5, color: C.secondary }}>
                  <span style={{ color: eventColor(ev) }}>{ev.source}</span> {ev.message}
                </div>
              ))}
            </div>
          )}
          {/* body */}
          <div style={{ flex: 1, position: "relative", padding: 16, display: "flex", flexDirection: "column", minHeight: 0 }}>
            {!mc && (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
                <div style={{ width: 80, height: 80, borderRadius: "50%", background: "radial-gradient(circle,#9BE8FF 0%,rgba(0,212,255,.4) 60%,transparent 100%)", boxShadow: "0 0 44px rgba(0,212,255,.7)", animation: "breathe 3s ease-in-out infinite" }} />
                <div style={{ fontFamily: F.orbitron, fontWeight: 700, fontSize: 16, color: C.arc, letterSpacing: ".1em" }}>ALL CLEAR</div>
                <div style={{ fontFamily: F.rajdhani, fontWeight: 600, fontSize: 12, letterSpacing: ".22em", color: C.dim }}>NOTHING NEEDS YOU</div>
              </div>
            )}
            {mc && (
              <>
                <div
                  className="hud-corners hud-corners-lg"
                  onTouchStart={(e) => {
                    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
                  }}
                  onTouchEnd={(e) => {
                    const s = touchStart.current;
                    if (!s) return;
                    const dx = e.changedTouches[0].clientX - s.x;
                    const dy = e.changedTouches[0].clientY - s.y;
                    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy)) void act(dx > 0 ? "approve" : "reject");
                    else if (dy < -70) void act("discuss");
                    touchStart.current = null;
                  }}
                  style={{
                    flex: 1,
                    position: "relative",
                    display: "flex",
                    flexDirection: "column",
                    background: "rgba(10,20,35,0.7)",
                    backdropFilter: "blur(16px)",
                    border: `1px solid ${anim ? (anim === "approved" ? C.green : C.red) : "rgba(0,212,255,.18)"}`,
                    borderRadius: 14,
                    padding: 18,
                    transform: anim ? `translateX(${anim === "approved" ? 60 : -60}px)` : "none",
                    opacity: anim ? 0 : 1,
                    transition: "transform .4s ease,opacity .4s ease",
                    minHeight: 0,
                    ["--corner-color" as string]: mc.ageColorV,
                  }}
                >
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontFamily: F.mono, fontSize: 10, padding: "3px 8px", borderRadius: 4, border: "1px solid rgba(0,212,255,.3)", color: C.arc }}>{mc.brandLabel}</span>
                    <span style={{ fontFamily: F.mono, fontSize: 10, padding: "3px 8px", borderRadius: 4, background: mc.ageColorV, color: C.bg, fontWeight: 600 }}>{mc.ageLabel}</span>
                    <span style={{ marginLeft: "auto", fontFamily: F.mono, fontSize: 10, color: C.dim }}>1 / {pendingCount}</span>
                  </div>
                  <div style={{ fontFamily: F.rajdhani, fontWeight: 700, fontSize: 20, color: C.bright, lineHeight: 1.3, marginTop: 14 }}>{mc.title}</div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
                    <HexAvatar glyph={mc.agentGlyph} color={mc.agentColor} size={26} />
                    <div style={{ fontFamily: F.rajdhani, fontWeight: 600, fontSize: 11, letterSpacing: ".1em", color: C.secondary }}>REQUESTED BY {mc.agentName.toUpperCase()}</div>
                  </div>
                  {mc.impact_note && <div style={{ marginTop: 12, fontFamily: F.mono, fontSize: 12, color: C.gold, lineHeight: 1.5 }}>⌁ {mc.impact_note}</div>}
                  <div style={{ flex: 1, marginTop: 12, padding: 12, border: "1px solid rgba(0,212,255,.14)", borderRadius: 8, background: "rgba(5,10,20,.7)", fontFamily: F.mono, fontSize: 10.5, lineHeight: 1.7, overflowY: "auto", minHeight: 0 }}>
                    {mc.previewLines.length > 0 ? <DiffLines lines={mc.previewLines} /> : <span style={{ color: C.dim }}>no preview attached</span>}
                  </div>
                  <div style={{ textAlign: "center", fontFamily: F.rajdhani, fontSize: 10, letterSpacing: ".18em", color: C.dim, marginTop: 10 }}>
                    SWIPE → APPROVE · ← REJECT · ↑ DISCUSS
                  </div>
                </div>
                <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
                  <div onClick={() => void act("reject")} className="btn-reject" style={{ cursor: "pointer", flex: 1, textAlign: "center", padding: "15px 0", border: "1px solid rgba(255,77,109,.55)", borderRadius: 10, fontFamily: F.rajdhani, fontWeight: 700, fontSize: 14, letterSpacing: ".1em", color: C.red }}>
                    ✕
                  </div>
                  <div onClick={() => void act("discuss")} className="btn-cyan" style={{ cursor: "pointer", flex: 1, textAlign: "center", padding: "15px 0", border: "1px solid rgba(0,212,255,.5)", borderRadius: 10, fontFamily: F.rajdhani, fontWeight: 700, fontSize: 14, letterSpacing: ".1em", color: C.cyan }}>
                    ◇
                  </div>
                  <div onClick={() => void act("approve")} className="btn-approve" style={{ cursor: "pointer", flex: 1.6, textAlign: "center", padding: "15px 0", border: "1px solid rgba(61,245,166,.6)", borderRadius: 10, fontFamily: F.rajdhani, fontWeight: 700, fontSize: 14, letterSpacing: ".1em", color: C.green, boxShadow: "0 0 16px rgba(61,245,166,.2)" }}>
                    ✔ APPROVE
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      <div style={{ maxWidth: 300, paddingTop: 30 }}>
        <div style={{ fontFamily: F.rajdhani, fontWeight: 700, fontSize: 11, letterSpacing: ".24em", color: C.cyan, marginBottom: 10 }}>MOBILE · APPROVAL-FIRST</div>
        <div style={{ fontSize: 12.5, lineHeight: 1.7, color: C.secondary }}>
          Opens directly on the Decision Queue as full-screen cards. One thumb, under 10 seconds per decision — swipe right to approve, left to reject, up to
          discuss. The same buttons live in Telegram, so approvals work from anywhere. On a real phone, open this URL — the view is touch-ready.
        </div>
      </div>
    </div>
  );
}
