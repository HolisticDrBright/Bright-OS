"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ViewCtx } from "./BrightOS";
import NeuralCanvas, { buildClusters } from "./NeuralCanvas";
import { DiffLines, HexAvatar, SectionLabel } from "./chrome";
import { C, F, chime } from "./theme";
import { deriveEngines, logStreak, tickerText, type DecisionVM } from "./derive";

type Orb = "idle" | "listening" | "speaking";
const PHASES = ["ANALYZING CONNECTIONS", "RANKING RELEVANCE", "SYNTHESIZING INSIGHTS", "PREPARING RESPONSE"];

interface ChatMsg {
  who: "you" | "os";
  text: string;
  id: number;
}

/** Strip HUD glyphs + the cost tag so text-to-speech reads clean prose. */
function stripForSpeech(raw: string): string {
  return raw
    .replace(/\[\$[\d.]+\]/g, "") // drop the cost tag
    .replace(/[*_#`>⌁◈▸✔✕◇⚑⤴●◉⚠⛔⚕]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

export default function CommandView(ctx: ViewCtx) {
  const { hud, fleet, decisions, pendingCount, sound, showStamp, setSelAgent, goTab } = ctx;
  const [chat, setChat] = useState<ChatMsg[]>([
    { who: "os", text: "BRIGHT OS online. /brief for the rundown · /research <topic> tasks HERMES · plain text routes to the reactor brain.", id: 0 },
  ]);
  const [cmdInput, setCmdInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [orb, setOrb] = useState<Orb>("idle");
  const [phase, setPhase] = useState(0);
  const [links, setLinks] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [anim, setAnim] = useState<Record<string, "approved" | "rejected">>({});
  const [speak, setSpeak] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(1); // stable ids so streaming updates the right bubble
  const speakCountRef = useRef(0); // utterances still queued/speaking
  const pendingRef = useRef(""); // unspoken text buffered for sentence-chunked TTS
  const laneRef = useRef(""); // which brain lane the current reply came from

  useEffect(() => {
    const t = setInterval(() => {
      if (thinking || orb !== "idle") setPhase((p) => (p + 1) % 4);
    }, 700);
    return () => clearInterval(t);
  }, [thinking, orb]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat]);

  // remember the speak-aloud preference across reloads
  useEffect(() => {
    setSpeak(window.localStorage.getItem("brightos-speak") === "1");
  }, []);
  useEffect(() => {
    window.localStorage.setItem("brightos-speak", speak ? "1" : "0");
  }, [speak]);

  // TTS — read the reactor brain's replies aloud (browser speech synthesis;
  // works in every browser incl. Brave, no API key). Utterances queue up and
  // play in order, so we can speak sentence-by-sentence as the reply streams.
  // Drives the orb's gold "responding" state while anything is still speaking.
  const enqueueSpeech = useCallback((raw: string) => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const clean = stripForSpeech(raw);
    if (!clean) return;
    const u = new SpeechSynthesisUtterance(clean);
    u.rate = 1.05;
    u.pitch = 0.95;
    speakCountRef.current += 1;
    setOrb("speaking");
    const done = () => {
      speakCountRef.current = Math.max(0, speakCountRef.current - 1);
      if (speakCountRef.current === 0) setOrb((o) => (o === "speaking" ? "idle" : o));
    };
    u.onend = done;
    u.onerror = done;
    window.speechSynthesis.speak(u);
  }, []);

  // Cancel any in-flight speech and clear the sentence buffer (new command / mute).
  const resetSpeech = useCallback(() => {
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    speakCountRef.current = 0;
    pendingRef.current = "";
  }, []);

  // Speak whole sentences as they arrive; keep the trailing partial buffered.
  // On the final flush, speak whatever's left even without a terminator.
  const flushSentences = useCallback(
    (final: boolean) => {
      const buf = pendingRef.current;
      if (final) {
        if (buf.trim()) enqueueSpeech(buf);
        pendingRef.current = "";
        return;
      }
      const m = buf.match(/^[\s\S]*[.!?…]\s/); // up to the last sentence end followed by space
      if (!m) return;
      pendingRef.current = buf.slice(m[0].length);
      enqueueSpeech(m[0]);
    },
    [enqueueSpeech],
  );

  const sendCmd = useCallback(
    async (raw: string, via: "web" | "voice" = "web") => {
      const text = raw.trim();
      if (!text || thinking) return;
      const youId = idRef.current++;
      const osId = idRef.current++;
      setChat((c) => [...c, { who: "you", text, id: youId }, { who: "os", text: "", id: osId }]);
      setCmdInput("");
      setThinking(true);
      chime(sound, 740, 0.15);
      if (speak) resetSpeech();
      laneRef.current = "";
      let streamed = "";
      try {
        const out = await hud.sendCommandStream(text, via, {
          onStatus: (_text, lane) => {
            if (lane) laneRef.current = lane;
          },
          onDelta: (delta) => {
            streamed += delta;
            setChat((c) => c.map((m) => (m.id === osId ? { ...m, text: streamed } : m)));
            // Only the conversational lane speaks live; the act lane speaks its
            // final reply once (below) so it never reads tool-loop chatter aloud.
            if (speak && laneRef.current === "chat") {
              pendingRef.current += delta;
              flushSentences(false);
            }
          },
        });
        const cost = out.cost_usd > 0 ? `\n[$${out.cost_usd.toFixed(4)}]` : "";
        setChat((c) => c.map((m) => (m.id === osId ? { ...m, text: `${out.reply}${cost}` } : m)));
        if (speak) {
          if (laneRef.current === "chat") flushSentences(true);
          else enqueueSpeech(out.reply);
        }
      } finally {
        setThinking(false);
      }
    },
    [hud, sound, thinking, speak, resetSpeech, flushSentences, enqueueSpeech],
  );

  // ◉ VOICE — browser speech recognition feeding the same brain
  const orbClick = useCallback(() => {
    if (orb !== "idle") {
      setOrb("idle");
      return;
    }
    const w = window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike; SpeechRecognition?: new () => SpeechRecognitionLike };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    chime(sound, 880, 0.18);
    if (!Ctor) {
      setOrb("listening");
      setTimeout(() => setOrb("speaking"), 2600);
      setTimeout(() => setOrb("idle"), 4400);
      setChat((c) => [...c, { who: "os", text: "Voice input isn't supported in this browser — type instead, or send a voice note to the Telegram bot.", id: idRef.current++ }]);
      return;
    }
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.interimResults = false;
    setOrb("listening");
    rec.onresult = (e) => {
      const transcript = e.results[0]?.[0]?.transcript ?? "";
      setOrb("speaking");
      setTimeout(() => setOrb("idle"), 1200);
      if (transcript) void sendCmd(transcript, "voice");
    };
    rec.onerror = () => setOrb("idle");
    rec.onend = () => setOrb((o) => (o === "listening" ? "idle" : o));
    rec.start();
  }, [orb, sound, sendCmd]);

  const decide = useCallback(
    async (d: DecisionVM, action: "approve" | "reject" | "discuss") => {
      if (action === "discuss") {
        chime(sound, 660, 0.2);
        await hud.decide(d.id, "discuss");
        setChat((c) => [
          ...c,
          { who: "you", text: `Discuss: ${d.title}`, id: idRef.current++ },
          { who: "os", text: `Thread open on "${d.title}" — context: ${d.impact_note ?? "no impact note"}. Tell me what to change; I'll capture it on the decision.`, id: idRef.current++ },
        ]);
        return;
      }
      setAnim((a) => ({ ...a, [d.id]: action === "approve" ? "approved" : "rejected" }));
      chime(sound, action === "approve" ? 1046 : 320, 0.3);
      const res = await hud.decide(d.id, action);
      if (res.ok) {
        showStamp(action === "approve" ? "APPROVED ✓" : "REJECTED ✕", action === "approve" ? C.green : C.red);
      } else {
        showStamp("BLOCKED", C.red);
        setChat((c) => [...c, { who: "os", text: `⚠ decide failed: ${res.error}`, id: idRef.current++ }]);
      }
      setTimeout(() => setAnim((a) => { const { [d.id]: _drop, ...rest } = a; return rest; }), 600);
    },
    [hud, sound, showStamp],
  );

  const clusters = useMemo(() => {
    const named = hud.brands.slice(0, 6);
    const counts = named.map((b) => hud.tasks.filter((t) => t.brand_id === b.id).length);
    return buildClusters(named.map((b) => b.name), counts);
  }, [hud.brands, hud.tasks]);

  const engines = useMemo(() => deriveEngines(hud.brands), [hud.brands]);
  const lane = hud.metrics?.verification_lane;
  const lastPromotion = hud.memory?.promotions[0];
  const streak = logStreak(hud.memory);
  const memCount = (hud.memory?.log.length ?? 0) + (hud.memory?.promotions.length ?? 0);
  const capUsedPct = hud.metrics ? Math.min(100, Math.round((hud.metrics.burn_today_usd / Math.max(1, hud.metrics.daily_cap_usd)) * 100)) : 0;

  const orbStateColor = orb === "listening" ? C.arc : orb === "speaking" ? C.gold : thinking ? C.cyan : C.dim;
  const orbStateLabel =
    orb === "listening" ? "● HERMES LISTENING" : orb === "speaking" ? "◉ HERMES RESPONDING" : thinking ? "REACTOR BRAIN THINKING" : "NEURAL CORE — CLICK TO ENGAGE VOICE";
  const active = thinking || orb !== "idle";

  const visible = decisions.filter((d) => d.status === "pending");

  return (
    <div style={{ position: "relative", zIndex: 5, display: "grid", gridTemplateColumns: "290px 1fr 380px", gridTemplateRows: "1fr auto", gap: 12, padding: "12px 16px 14px", height: "calc(100vh - 92px)", animation: "fadeUp .5s ease-out both" }}>
      {/* LEFT RAIL — AGENT FLEET */}
      <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, paddingRight: 2 }}>
        <SectionLabel>AGENT FLEET · {fleet.length} UNITS</SectionLabel>
        {fleet.map((a) => (
          <div key={a.id} onClick={() => setSelAgent(a.id)} className="hud-panel hud-corners hud-hover" style={{ cursor: "pointer", padding: "11px 12px", overflow: "hidden" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <HexAvatar glyph={a.glyph} color={a.st.color} ringAnim={a.st.anim} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: F.orbitron, fontWeight: 700, fontSize: 11.5, color: C.bright, letterSpacing: ".06em" }}>{a.name}</div>
                <div style={{ fontFamily: F.rajdhani, fontWeight: 600, fontSize: 10, letterSpacing: ".14em", color: a.st.color }}>
                  {a.st.label} · {a.role}
                </div>
              </div>
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: C.secondary, lineHeight: 1.45, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>▸ {a.currentTask}</div>
            <div style={{ marginTop: 8, display: "flex", gap: 10, fontFamily: F.mono, fontSize: 10 }}>
              <span style={{ color: C.gold }}>${a.costToday.toFixed(2)}</span>
              <span style={{ color: C.green }}>✓{a.done}</span>
              <span style={{ color: C.red }}>✗{a.failed}</span>
              {a.memories !== null && <span style={{ color: C.arc }}>◈ {a.memories} mem</span>}
            </div>
          </div>
        ))}
      </div>

      {/* CENTER — NEURAL COMMAND CORE */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0, overflow: "hidden" }}>
        {/* ticker */}
        <div style={{ position: "relative", overflow: "hidden", height: 30, border: "1px solid rgba(0,212,255,.16)", borderRadius: 6, background: "rgba(10,20,35,.5)", display: "flex", alignItems: "center" }}>
          <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 110, display: "flex", alignItems: "center", paddingLeft: 10, background: "linear-gradient(90deg,#0A1423 60%,transparent)", zIndex: 2, fontFamily: F.rajdhani, fontWeight: 700, fontSize: 10, letterSpacing: ".2em", color: C.cyan }}>
            ⟢ LIVE FEED
          </div>
          <div style={{ display: "flex", whiteSpace: "nowrap", animation: "tickerMove 38s linear infinite", fontFamily: F.mono, fontSize: 11, color: C.secondary }}>
            <span style={{ paddingRight: 60 }}>{tickerText(hud.events)}</span>
            <span style={{ paddingRight: 60 }}>{tickerText(hud.events)}</span>
          </div>
        </div>

        {/* reactor */}
        <div className="hud-corners hud-corners-lg" style={{ position: "relative", flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "rgba(10,20,35,0.4)", backdropFilter: "blur(16px)", border: "1px solid rgba(0,212,255,.14)", borderRadius: 10, overflow: "hidden", minHeight: 280 }}>
          <div style={{ position: "absolute", top: 0, bottom: 0, width: "26%", left: "-35%", background: "linear-gradient(100deg,transparent,rgba(155,232,255,.05) 45%,rgba(155,232,255,.09) 50%,rgba(155,232,255,.05) 55%,transparent)", animation: "scanSweep 20s linear infinite", pointerEvents: "none" }} />
          <NeuralCanvas clusters={clusters} thinking={active} onClick={orbClick} onLinks={setLinks} />
          <div style={{ position: "absolute", top: 10, left: 14, zIndex: 3, fontFamily: F.mono, fontSize: 9.5, color: C.dim, pointerEvents: "none" }}>
            NEURAL VAULT · <span style={{ color: C.arc }}>{memCount.toLocaleString()} MEMORIES</span> · <span style={{ color: C.cyan }}>{links.toLocaleString()} LINKS</span>
          </div>
          <div style={{ position: "absolute", top: 10, right: 14, zIndex: 3, fontFamily: F.mono, fontSize: 9.5, color: C.dim, pointerEvents: "none" }}>
            DAILY CAP <span style={{ color: capUsedPct > 80 ? C.red : C.green }}>{capUsedPct}%</span>
          </div>
          {clusters.map((co) => (
            <div key={co.name} style={{ position: "absolute", width: 148, left: co.side === "l" ? "2.5%" : "auto", right: co.side === "r" ? "2.5%" : "auto", top: `${co.fy * 100}%`, zIndex: 3, pointerEvents: "none", background: "rgba(8,16,28,.78)", backdropFilter: "blur(10px)", border: `1px solid rgba(${co.rgb},.45)`, borderRadius: 6, padding: "7px 10px", boxShadow: `0 0 14px rgba(${co.rgb},.18)` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 7, height: 7, borderRadius: 2, background: co.color, boxShadow: `0 0 6px ${co.color}` }} />
                <div style={{ fontFamily: F.rajdhani, fontWeight: 700, fontSize: 10.5, letterSpacing: ".1em", color: C.bright, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{co.name}</div>
              </div>
              <div style={{ fontFamily: F.mono, fontSize: 9, color: co.color, marginTop: 3 }}>{co.count}</div>
            </div>
          ))}
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 10, zIndex: 3, display: "flex", flexDirection: "column", alignItems: "center", gap: 8, pointerEvents: "none" }}>
            <div style={{ fontFamily: F.orbitron, fontWeight: 700, fontSize: 13, letterSpacing: ".26em", color: orbStateColor, textShadow: `0 0 16px ${orbStateColor}`, transition: "color .4s" }}>{orbStateLabel}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 2, height: 16, opacity: active ? 1 : 0.25, transition: "opacity .4s" }}>
              {Array.from({ length: 44 }, (_, i) => (
                <div key={i} style={{ width: 2.5, height: 14, borderRadius: 1, background: [C.cyan, C.magenta, C.gold, C.green, C.violet][i % 5], transformOrigin: "center", animation: `waveBar ${(0.4 + (i % 7) * 0.09).toFixed(2)}s ease-in-out infinite`, animationDelay: `${(i * 0.03).toFixed(2)}s` }} />
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
              {PHASES.map((label, i) => {
                const on = active && i === phase;
                return (
                  <div key={label} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 12px", border: `1px solid ${on ? "rgba(0,212,255,.7)" : "rgba(0,212,255,.14)"}`, borderRadius: 14, background: "rgba(8,16,28,.7)", fontFamily: F.rajdhani, fontWeight: 600, fontSize: 10, letterSpacing: ".12em", color: on ? C.arc : C.dim, transition: "all .3s", boxShadow: on ? "0 0 14px rgba(0,212,255,.45)" : "none" }}>
                    ◈ {label}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* command chat */}
        <div className="hud-panel hud-corners hud-corners-tl-only" style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8, maxHeight: 220 }}>
          <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, maxHeight: 140 }}>
            {chat.map((m) => (
              <div key={m.id} style={{ alignSelf: m.who === "you" ? "flex-end" : "flex-start", maxWidth: "82%", padding: "7px 11px", borderRadius: 7, border: `1px solid ${m.who === "you" ? "rgba(255,184,77,.35)" : "rgba(0,212,255,.25)"}`, background: m.who === "you" ? "rgba(255,184,77,.07)" : "rgba(0,212,255,.06)", fontSize: 12, lineHeight: 1.5, color: "#D8EAF7", whiteSpace: "pre-wrap", animation: "fadeUp .3s ease-out both" }}>
                <span style={{ fontFamily: F.rajdhani, fontWeight: 700, fontSize: 9.5, letterSpacing: ".18em", color: m.who === "you" ? C.gold : C.cyan }}>
                  {m.who === "you" ? "DR. BRIGHT" : "BRIGHT OS"}
                </span>
                <br />
                {m.text || (m.who === "os" ? "▌" : "")}
              </div>
            ))}
            {thinking && (
              <div style={{ alignSelf: "flex-start", fontFamily: F.mono, fontSize: 11, color: C.cyan, animation: "ledBlink 1.2s ease-in-out infinite" }}>▌ reactor brain working…</div>
            )}
            <div ref={chatEndRef} />
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontFamily: F.mono, color: C.cyan, fontSize: 13 }}>❯</span>
            <input
              value={cmdInput}
              onChange={(e) => setCmdInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void sendCmd(cmdInput);
              }}
              placeholder="Command your empire…  (/brief  /research <topic>  or plain text)"
              style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: C.bright, fontFamily: F.mono, fontSize: 12 }}
            />
            <div onClick={() => void sendCmd(cmdInput)} className="btn-cyan" style={{ cursor: "pointer", padding: "5px 14px", border: "1px solid rgba(0,212,255,.5)", borderRadius: 5, fontFamily: F.rajdhani, fontWeight: 700, fontSize: 11, letterSpacing: ".16em", color: C.cyan }}>
              EXEC
            </div>
            <div onClick={orbClick} className="btn-cyan" style={{ cursor: "pointer", padding: "5px 10px", border: "1px solid rgba(0,212,255,.4)", borderRadius: 5, fontFamily: F.rajdhani, fontWeight: 700, fontSize: 10, letterSpacing: ".14em", color: C.cyan }}>
              ◉ VOICE
            </div>
            <div
              onClick={() => {
                const next = !speak;
                setSpeak(next);
                if (!next) resetSpeech();
                else enqueueSpeech("Voice online.");
              }}
              style={{ cursor: "pointer", padding: "5px 10px", border: `1px solid ${speak ? "rgba(61,245,166,.5)" : "rgba(94,122,147,.4)"}`, borderRadius: 5, fontFamily: F.rajdhani, fontWeight: 700, fontSize: 10, letterSpacing: ".14em", color: speak ? C.green : C.dim }}
              title="Read replies aloud (works in every browser)"
            >
              {speak ? "🔊 SPEAK ON" : "🔊 SPEAK"}
            </div>
          </div>
        </div>
      </div>

      {/* RIGHT RAIL — DECISION QUEUE */}
      <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, paddingRight: 2 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "2px 2px 0" }}>
          <div style={{ fontFamily: F.rajdhani, fontWeight: 700, fontSize: 11, letterSpacing: ".24em", color: C.gold }}>DECISION QUEUE</div>
          <div style={{ fontFamily: F.mono, fontSize: 10, color: C.dim }}>{pendingCount} PENDING · AGE SORT</div>
        </div>
        {visible.length === 0 && (
          <div style={{ border: "1px solid rgba(0,212,255,.25)", borderRadius: 10, background: C.panel, padding: "46px 20px", textAlign: "center" }}>
            <div style={{ width: 70, height: 70, margin: "0 auto 18px", borderRadius: "50%", background: "radial-gradient(circle,#9BE8FF 0%,rgba(0,212,255,.4) 60%,transparent 100%)", boxShadow: "0 0 40px rgba(0,212,255,.7)", animation: "breathe 3s ease-in-out infinite" }} />
            <div style={{ fontFamily: F.orbitron, fontWeight: 700, fontSize: 15, color: C.arc, letterSpacing: ".1em", textShadow: "0 0 16px rgba(0,212,255,.8)" }}>ALL CLEAR</div>
            <div style={{ fontFamily: F.rajdhani, fontWeight: 600, fontSize: 12, letterSpacing: ".22em", color: C.dim, marginTop: 6 }}>NOTHING NEEDS YOU</div>
          </div>
        )}
        {visible.map((d) => {
          const a = anim[d.id];
          return (
            <div
              key={d.id}
              className="hud-corners"
              style={{
                position: "relative",
                background: a ? (a === "approved" ? "rgba(61,245,166,.12)" : "rgba(255,77,109,.12)") : C.panel,
                backdropFilter: "blur(16px)",
                border: `1px solid ${a ? (a === "approved" ? C.green : C.red) : "rgba(0,212,255,.18)"}`,
                borderRadius: 8,
                padding: "11px 12px",
                transform: a ? `translateX(${a === "approved" ? 60 : -60}px)` : "none",
                opacity: a ? 0 : 1,
                transition: "transform .45s ease,opacity .45s ease,border-color .3s,background .3s",
                ["--corner-color" as string]: d.ageColorV,
              }}
            >
              <div style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
                <HexAvatar glyph={d.agentGlyph} color={d.agentColor} size={28} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: F.rajdhani, fontWeight: 700, fontSize: 13, color: C.bright, lineHeight: 1.3 }}>{d.title}</div>
                  <div style={{ display: "flex", gap: 8, marginTop: 4, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontFamily: F.mono, fontSize: 9, padding: "2px 6px", borderRadius: 3, border: "1px solid rgba(0,212,255,.3)", color: C.arc }}>{d.brandLabel}</span>
                    <span style={{ fontFamily: F.mono, fontSize: 9, padding: "2px 6px", borderRadius: 3, background: d.ageColorV, color: C.bg, fontWeight: 600 }}>{d.ageLabel}</span>
                    {d.medical && (
                      <span style={{ fontFamily: F.mono, fontSize: 9, padding: "2px 6px", borderRadius: 3, border: `1px solid ${C.red}`, color: C.red }}>⚕ HUMAN-ONLY</span>
                    )}
                  </div>
                </div>
              </div>
              {d.impact_note && <div style={{ marginTop: 8, fontFamily: F.mono, fontSize: 10.5, color: C.gold }}>⌁ {d.impact_note}</div>}
              {d.previewLines.length > 0 && (
                <>
                  <div onClick={() => setExpanded((x) => ({ ...x, [d.id]: !x[d.id] }))} className="hover-cyan" style={{ cursor: "pointer", marginTop: 7, fontFamily: F.rajdhani, fontWeight: 600, fontSize: 10.5, letterSpacing: ".14em", color: C.dim }}>
                    {expanded[d.id] ? "▾ HIDE PREVIEW" : "▸ PREVIEW DRAFT"}
                  </div>
                  {expanded[d.id] && (
                    <div style={{ marginTop: 7, padding: "9px 11px", border: "1px solid rgba(0,212,255,.14)", borderRadius: 6, background: "rgba(5,10,20,.7)", fontFamily: F.mono, lineHeight: 1.7 }}>
                      <DiffLines lines={d.previewLines} />
                    </div>
                  )}
                </>
              )}
              <div style={{ display: "flex", gap: 7, marginTop: 10 }}>
                <div onClick={() => void decide(d, "approve")} className="btn-approve" style={{ cursor: "pointer", flex: 1.3, textAlign: "center", padding: "8px 0", border: "1px solid rgba(61,245,166,.5)", borderRadius: 6, fontFamily: F.rajdhani, fontWeight: 700, fontSize: 12, letterSpacing: ".12em", color: C.green }}>
                  ✔ APPROVE
                </div>
                <div onClick={() => void decide(d, "reject")} className="btn-reject" style={{ cursor: "pointer", flex: 1, textAlign: "center", padding: "8px 0", border: "1px solid rgba(255,77,109,.5)", borderRadius: 6, fontFamily: F.rajdhani, fontWeight: 700, fontSize: 12, letterSpacing: ".12em", color: C.red }}>
                  ✕ REJECT
                </div>
                <div onClick={() => void decide(d, "discuss")} className="btn-cyan" style={{ cursor: "pointer", flex: 1, textAlign: "center", padding: "8px 0", border: "1px solid rgba(0,212,255,.45)", borderRadius: 6, fontFamily: F.rajdhani, fontWeight: 700, fontSize: 12, letterSpacing: ".12em", color: C.cyan }}>
                  ◇ DISCUSS
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* BOTTOM STRIP */}
      <div style={{ gridColumn: "1 / -1", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <div className="hud-corners" style={{ position: "relative", background: C.panel, backdropFilter: "blur(16px)", border: "1px solid rgba(255,184,77,.25)", borderRadius: 8, padding: "10px 14px", ["--corner-color" as string]: "rgba(255,184,77,.7)" }}>
          <div style={{ fontFamily: F.rajdhani, fontWeight: 700, fontSize: 10, letterSpacing: ".22em", color: C.gold, marginBottom: 7 }}>REVENUE ENGINES · WTD</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {deriveEngines(hud.brands).length === 0 && <div style={{ fontFamily: F.mono, fontSize: 10, color: C.dim }}>no engine brands yet</div>}
            {engines.map((e) => (
              <div key={e.name}>
                <div style={{ fontFamily: F.rajdhani, fontWeight: 700, fontSize: 12, color: C.bright, letterSpacing: ".06em" }}>{e.name}</div>
                <div style={{ fontFamily: F.mono, fontSize: 12, marginTop: 3 }}>
                  <span style={{ color: C.gold, fontWeight: 600 }}>{e.in}</span> <span style={{ color: C.dim }}>in</span> · <span style={{ color: C.secondary }}>{e.out}</span> <span style={{ color: C.dim }}>out</span>
                </div>
                <div style={{ height: 4, borderRadius: 2, background: "rgba(255,255,255,.07)", marginTop: 5, overflow: "hidden" }}>
                  <div style={{ height: "100%", background: "linear-gradient(90deg,#FFB84D,#9BE8FF)", width: e.pct }} />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="hud-panel hud-corners hud-corners-tl-only" style={{ padding: "10px 14px" }}>
          <div style={{ fontFamily: F.rajdhani, fontWeight: 700, fontSize: 10, letterSpacing: ".22em", color: C.cyan, marginBottom: 7 }}>VERIFICATION LANE · CODEX</div>
          <div style={{ display: "flex", gap: 18, alignItems: "baseline" }}>
            <div>
              <div style={{ fontFamily: F.mono, fontSize: 20, fontWeight: 600, color: C.bright }}>{lane?.reported_done ?? 0}</div>
              <div style={{ fontFamily: F.rajdhani, fontSize: 10, letterSpacing: ".14em", color: C.dim }}>REPORTED DONE</div>
            </div>
            <div style={{ color: C.dim }}>▸</div>
            <div>
              <div style={{ fontFamily: F.mono, fontSize: 20, fontWeight: 600, color: C.green }}>{lane?.verified ?? 0}</div>
              <div style={{ fontFamily: F.rajdhani, fontSize: 10, letterSpacing: ".14em", color: C.dim }}>VERIFIED</div>
            </div>
            <div style={{ marginLeft: "auto", padding: "4px 9px", border: `1px solid ${(lane?.unverified_claims ?? 0) > 0 ? "rgba(255,77,109,.5)" : "rgba(61,245,166,.4)"}`, borderRadius: 5, fontFamily: F.mono, fontSize: 10, color: (lane?.unverified_claims ?? 0) > 0 ? C.red : C.green }}>
              ⚑ {lane?.unverified_claims ?? 0} UNVERIFIED CLAIMS
            </div>
          </div>
        </div>
        <div className="hud-panel hud-corners hud-corners-tl-only" style={{ padding: "10px 14px" }}>
          <div style={{ fontFamily: F.rajdhani, fontWeight: 700, fontSize: 10, letterSpacing: ".22em", color: C.arc, marginBottom: 7 }}>MEMORY SPINE · HERMES</div>
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <div>
              <div style={{ fontFamily: F.mono, fontSize: 13, color: C.bright }}>{lastPromotion ? lastPromotion.promoted_at.slice(0, 10) : "—"}</div>
              <div style={{ fontFamily: F.rajdhani, fontSize: 10, letterSpacing: ".14em", color: C.dim }}>LAST PROMOTION</div>
            </div>
            <div>
              <div style={{ fontFamily: F.mono, fontSize: 13, color: C.green }}>{streak} DAYS</div>
              <div style={{ fontFamily: F.rajdhani, fontSize: 10, letterSpacing: ".14em", color: C.dim }}>LOG STREAK</div>
            </div>
            <div onClick={() => goTab("memory")} className="btn-arc" style={{ marginLeft: "auto", cursor: "pointer", padding: "6px 12px", border: "1px solid rgba(155,232,255,.5)", borderRadius: 5, fontFamily: F.rajdhani, fontWeight: 700, fontSize: 11, letterSpacing: ".14em", color: C.arc }}>
              ⤴ PROMOTE →
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  onresult: ((e: { results: { [i: number]: { [j: number]: { transcript: string } } } }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
}
