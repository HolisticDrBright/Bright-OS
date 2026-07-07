"use client";

import { useMemo, useState } from "react";
import type { useHud } from "./data";
import { C, F, chime } from "./theme";

export default function MemoryView({
  hud,
  showStamp,
  sound,
}: {
  hud: ReturnType<typeof useHud>;
  showStamp: (t: string, c?: string) => void;
  sound: boolean;
}) {
  const [query, setQuery] = useState("");
  const [promoting, setPromoting] = useState<string | null>(null);

  const sections = useMemo(() => {
    const md = hud.memory?.memory_md ?? "";
    const out: { h: string; lines: string[] }[] = [];
    let current: { h: string; lines: string[] } | null = null;
    for (const raw of md.split("\n")) {
      const line = raw.trim();
      if (line.startsWith("#")) {
        current = { h: line.replace(/^#+\s*/, ""), lines: [] };
        out.push(current);
      } else if (line && current) {
        current.lines.push(line.replace(/^[·\-*]\s*/, ""));
      }
    }
    return out.filter((s) => s.h.toLowerCase() !== "memory.md — bright os curated memory");
  }, [hud.memory]);

  const promotedSet = useMemo(
    () => new Set((hud.memory?.promotions ?? []).map((p) => `${p.from_day}:${p.line_text.trim()}`)),
    [hud.memory],
  );

  const entries = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows: { day: string; text: string; promoted: boolean }[] = [];
    for (const log of hud.memory?.log ?? []) {
      for (const raw of log.content_md.split("\n")) {
        const text = raw.trim().replace(/^[·\-*]\s*/, "");
        if (!text || text.startsWith("<!--")) continue;
        rows.push({ day: log.day, text, promoted: promotedSet.has(`${log.day}:${text}`) });
      }
    }
    return rows.filter((r) => !q || r.text.toLowerCase().includes(q) || r.day.includes(q));
  }, [hud.memory, promotedSet, query]);

  const promote = async (day: string, text: string) => {
    setPromoting(`${day}:${text}`);
    const res = await hud.promoteLine(day, text);
    setPromoting(null);
    if (res.ok) {
      chime(sound, 988, 0.3);
      showStamp("PROMOTED ⤴", C.arc);
    } else {
      showStamp("BLOCKED", C.red);
    }
  };

  return (
    <div style={{ position: "relative", zIndex: 5, display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 12, padding: "14px 16px", height: "calc(100vh - 92px)", animation: "fadeUp .4s ease-out both" }}>
      {/* MEMORY.md */}
      <div className="hud-panel hud-corners hud-corners-tl-only" style={{ padding: 16, overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ fontFamily: F.orbitron, fontWeight: 700, fontSize: 14, color: C.arc, letterSpacing: ".08em" }}>MEMORY.md</div>
          <div style={{ fontFamily: F.mono, fontSize: 9.5, color: C.dim }}>edited via vault or /api/memory/promote</div>
        </div>
        {sections.map((sec) => (
          <div key={sec.h} style={{ marginBottom: 14 }}>
            <div style={{ fontFamily: F.rajdhani, fontWeight: 700, fontSize: 11, letterSpacing: ".2em", color: C.cyan, marginBottom: 6, borderBottom: "1px solid rgba(0,212,255,.14)", paddingBottom: 4 }}>
              # {sec.h}
            </div>
            {sec.lines.map((l, i) => (
              <div key={i} style={{ fontFamily: F.mono, fontSize: 11.5, lineHeight: 1.8, color: "#B8D2E4" }}>
                · {l}
              </div>
            ))}
          </div>
        ))}
        {sections.length === 0 && <div style={{ fontFamily: F.mono, fontSize: 11, color: C.dim }}>MEMORY.md is empty — promote your first line →</div>}
      </div>

      {/* timeline + search */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, overflow: "hidden" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", background: "rgba(10,20,35,.6)", border: "1px solid rgba(0,212,255,.2)", borderRadius: 7, padding: "8px 12px" }}>
          <span style={{ color: C.cyan, fontSize: 13 }}>⌕</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the daily log…"
            style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: C.bright, fontFamily: F.mono, fontSize: 11.5 }}
          />
          <span style={{ fontFamily: F.mono, fontSize: 9.5, color: C.dim }}>{entries.length} HITS</span>
        </div>
        <div style={{ flex: 1, overflowY: "auto", position: "relative", paddingLeft: 18 }}>
          <div style={{ position: "absolute", left: 5, top: 6, bottom: 6, width: 1, background: "linear-gradient(180deg,rgba(0,212,255,.5),rgba(0,212,255,.08))" }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            {entries.map((en, i) => (
              <div key={i} style={{ position: "relative", background: "rgba(10,20,35,.5)", border: `1px solid ${en.promoted ? "rgba(61,245,166,.35)" : "rgba(0,212,255,.14)"}`, borderRadius: 7, padding: "9px 11px" }}>
                <div style={{ position: "absolute", left: -17.5, top: 14, width: 9, height: 9, borderRadius: "50%", background: en.promoted ? C.green : C.cyan, boxShadow: `0 0 7px ${en.promoted ? C.green : C.cyan}` }} />
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <div style={{ fontFamily: F.mono, fontSize: 9.5, color: C.dim }}>{en.day}</div>
                  {en.promoted ? (
                    <div style={{ fontFamily: F.rajdhani, fontWeight: 700, fontSize: 9, letterSpacing: ".14em", color: C.green }}>⤴ PROMOTED → MEMORY.md</div>
                  ) : (
                    <div
                      onClick={() => void promote(en.day, en.text)}
                      className="btn-arc"
                      style={{ cursor: "pointer", fontFamily: F.rajdhani, fontWeight: 700, fontSize: 9, letterSpacing: ".14em", color: C.arc, border: "1px solid rgba(155,232,255,.4)", borderRadius: 4, padding: "2px 7px", opacity: promoting === `${en.day}:${en.text}` ? 0.4 : 1 }}
                    >
                      ⤴ PROMOTE
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 11.5, color: C.body, marginTop: 4, lineHeight: 1.5 }}>{en.text}</div>
              </div>
            ))}
            {entries.length === 0 && (
              <div style={{ fontFamily: F.mono, fontSize: 11, color: C.dim, padding: 12 }}>
                daily log is empty — Hermes and the workers write here; POST /api/memory to seed
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
