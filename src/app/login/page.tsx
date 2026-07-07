"use client";

import { useState } from "react";

const F = {
  orbitron: "var(--font-orbitron), sans-serif",
  rajdhani: "var(--font-rajdhani), sans-serif",
  mono: "var(--font-jbmono), monospace",
};

export default function Login() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"email" | "code" | "busy">("email");
  const [error, setError] = useState("");

  const sendCode = async () => {
    setError("");
    setStage("busy");
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (res.ok) {
      setStage("code");
    } else {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? `HTTP ${res.status}`);
      setStage("email");
    }
  };

  const verify = async () => {
    setError("");
    setStage("busy");
    const res = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, token: code }),
    });
    if (res.ok) {
      window.location.assign("/");
    } else {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? `HTTP ${res.status}`);
      setStage("code");
    }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    background: "rgba(5,10,20,.7)",
    border: "1px solid rgba(0,212,255,.3)",
    borderRadius: 6,
    padding: "12px 14px",
    color: "#E6F4FF",
    fontFamily: F.mono,
    fontSize: 14,
    outline: "none",
    textAlign: "center",
    letterSpacing: ".1em",
  };

  return (
    <div style={{ minHeight: "100vh", background: "#050A14", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 26 }}>
      <div className="ambient-grid" />
      <div style={{ position: "relative", width: 140, height: 140 }}>
        <div style={{ position: "absolute", inset: 0, borderRadius: "50%", border: "1px dashed rgba(0,212,255,.5)", animation: "spinCW 3s linear infinite" }} />
        <div style={{ position: "absolute", inset: 12, borderRadius: "50%", border: "2px solid transparent", borderTopColor: "#00D4FF", borderBottomColor: "#00D4FF", animation: "spinCCW 1.4s linear infinite" }} />
        <div style={{ position: "absolute", inset: 46, borderRadius: "50%", background: "radial-gradient(circle,#FFFFFF 0%,#9BE8FF 35%,rgba(0,212,255,.5) 70%,transparent 100%)", animation: "breathe 1.2s ease-in-out infinite", boxShadow: "0 0 60px rgba(0,212,255,.8)" }} />
      </div>
      <div style={{ fontFamily: F.orbitron, fontWeight: 900, fontSize: 22, color: "#9BE8FF", letterSpacing: ".2em", textShadow: "0 0 20px rgba(0,212,255,.8)" }}>
        BRIGHT<span style={{ color: "#00D4FF" }}>OS</span>
      </div>
      <div style={{ width: 340, display: "flex", flexDirection: "column", gap: 12, position: "relative", zIndex: 2 }}>
        {stage !== "code" ? (
          <>
            <input
              style={inputStyle}
              type="email"
              placeholder="operator email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void sendCode()}
              autoFocus
            />
            <button
              onClick={() => void sendCode()}
              disabled={stage === "busy"}
              className="btn-cyan"
              style={{ cursor: "pointer", padding: "12px 0", background: "transparent", border: "1px solid rgba(0,212,255,.5)", borderRadius: 6, fontFamily: F.rajdhani, fontWeight: 700, fontSize: 13, letterSpacing: ".2em", color: "#00D4FF", opacity: stage === "busy" ? 0.5 : 1 }}
            >
              {stage === "busy" ? "TRANSMITTING…" : "SEND ACCESS CODE"}
            </button>
          </>
        ) : (
          <>
            <input
              style={{ ...inputStyle, fontSize: 22, letterSpacing: ".4em" }}
              inputMode="numeric"
              placeholder="······"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void verify()}
              autoFocus
            />
            <button
              onClick={() => void verify()}
              className="btn-approve"
              style={{ cursor: "pointer", padding: "12px 0", background: "transparent", border: "1px solid rgba(61,245,166,.5)", borderRadius: 6, fontFamily: F.rajdhani, fontWeight: 700, fontSize: 13, letterSpacing: ".2em", color: "#3DF5A6" }}
            >
              ENGAGE
            </button>
            <div onClick={() => setStage("email")} style={{ cursor: "pointer", textAlign: "center", fontFamily: F.mono, fontSize: 10, color: "#5E7A93" }}>
              ← different email
            </div>
          </>
        )}
        {error && <div style={{ textAlign: "center", fontFamily: F.mono, fontSize: 11, color: "#FF4D6D" }}>{error}</div>}
        <div style={{ textAlign: "center", fontFamily: F.rajdhani, fontSize: 11, letterSpacing: ".22em", color: "#5E7A93" }}>
          SINGLE-OPERATOR SYSTEM · EMAIL OTP
        </div>
      </div>
    </div>
  );
}
