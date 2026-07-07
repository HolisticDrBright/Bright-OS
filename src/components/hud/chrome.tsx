"use client";

import { C, F, heatCells } from "./theme";

/** Shared chrome: boot overlay, ambient particles, HUD stamp, small bits. */

export function Boot({ onSkip }: { onSkip: () => void }) {
  return (
    <div
      onClick={onSkip}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        background: C.bg,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        gap: 34,
      }}
    >
      <div style={{ position: "relative", width: 220, height: 220 }}>
        <div style={{ position: "absolute", inset: 0, borderRadius: "50%", border: "1px dashed rgba(0,212,255,.5)", animation: "spinCW 3s linear infinite" }} />
        <div style={{ position: "absolute", inset: 18, borderRadius: "50%", border: "2px solid transparent", borderTopColor: C.cyan, borderBottomColor: C.cyan, animation: "spinCCW 1.4s linear infinite" }} />
        <div style={{ position: "absolute", inset: 40, borderRadius: "50%", border: "3px solid rgba(155,232,255,.25)", borderLeftColor: C.arc, animation: "spinCW .9s linear infinite" }} />
        <div style={{ position: "absolute", inset: 74, borderRadius: "50%", background: "radial-gradient(circle,#FFFFFF 0%,#9BE8FF 35%,rgba(0,212,255,.5) 70%,transparent 100%)", animation: "breathe 1.2s ease-in-out infinite", boxShadow: "0 0 60px rgba(0,212,255,.8)" }} />
      </div>
      <div style={{ fontFamily: F.orbitron, fontWeight: 900, fontSize: 30, color: C.arc, textShadow: "0 0 24px rgba(0,212,255,.9)", animation: "bootStamp 1.1s ease-out both" }}>
        BRIGHT OS ONLINE
      </div>
      <div style={{ fontFamily: F.mono, fontSize: 11, color: C.dim, letterSpacing: ".3em" }}>
        INITIALIZING AGENT FLEET ▸ TAP TO SKIP
      </div>
    </div>
  );
}

export function Particles() {
  const dots = heatCells(9, 14, 1).map((v, i) => ({
    x: `${Math.round(v * 96)}%`,
    y: `${Math.round(heatCells(i + 3, 1, 1)[0] * 90)}%`,
    dur: `${(4 + v * 5).toFixed(1)}s`,
    delay: `${(v * 3).toFixed(1)}s`,
  }));
  return (
    <>
      <div className="ambient-grid" />
      {dots.map((p, i) => (
        <div
          key={i}
          style={{
            position: "fixed",
            width: 3,
            height: 3,
            borderRadius: "50%",
            background: "rgba(155,232,255,.5)",
            boxShadow: "0 0 6px rgba(0,212,255,.8)",
            pointerEvents: "none",
            left: p.x,
            top: p.y,
            animation: `floatDot ${p.dur} ease-in-out infinite`,
            animationDelay: p.delay,
          }}
        />
      ))}
    </>
  );
}

export function Stamp({ text, color = C.green }: { text: string; color?: string }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 150, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
      <div
        style={{
          padding: "18px 40px",
          border: `2px solid ${color}`,
          borderRadius: 8,
          background: "rgba(5,10,20,.85)",
          backdropFilter: "blur(10px)",
          fontFamily: F.orbitron,
          fontWeight: 900,
          fontSize: 22,
          letterSpacing: ".3em",
          color,
          textShadow: `0 0 20px ${color}`,
          boxShadow: `0 0 50px ${color}55`,
          animation: "bootStamp .5s ease-out both",
          transform: "rotate(-4deg)",
        }}
      >
        {text}
      </div>
    </div>
  );
}

export function SectionLabel({ children, color = C.dim }: { children: React.ReactNode; color?: string }) {
  return (
    <div style={{ fontFamily: F.rajdhani, fontWeight: 700, fontSize: 11, letterSpacing: ".24em", color, padding: "2px 2px 0" }}>
      {children}
    </div>
  );
}

export function HexAvatar({ glyph, color, size = 44, ringAnim }: { glyph: string; color: string; size?: number; ringAnim?: string }) {
  return (
    <div style={{ position: "relative", width: size, height: size, flex: "none" }}>
      {ringAnim !== undefined && (
        <div style={{ position: "absolute", inset: -3, borderRadius: "50%", border: `1.5px solid ${color}`, animation: ringAnim }} />
      )}
      <div
        className="hex"
        style={{
          position: "absolute",
          inset: 2,
          fontFamily: F.orbitron,
          fontWeight: 700,
          fontSize: size * 0.3,
          color,
        }}
      >
        {glyph}
      </div>
    </div>
  );
}

export function DiffLines({ lines, fontSize = 10.5 }: { lines: string[]; fontSize?: number }) {
  return (
    <>
      {lines.map((text, i) => (
        <div
          key={i}
          style={{
            color: text.startsWith("+") ? C.green : text.startsWith("-") ? C.red : C.secondary,
            whiteSpace: "pre-wrap",
            fontSize,
          }}
        >
          {text}
        </div>
      ))}
    </>
  );
}
