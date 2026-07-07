// BRIGHT OS design tokens (from the design handoff — high fidelity).
export const C = {
  bg: "#050A14",
  panel: "rgba(10,20,35,0.55)",
  cyan: "#00D4FF",
  arc: "#9BE8FF",
  gold: "#FFB84D",
  red: "#FF4D6D",
  green: "#3DF5A6",
  body: "#C9DCEA",
  bright: "#E6F4FF",
  secondary: "#8FAFC6",
  dim: "#5E7A93",
  magenta: "#FF4DD2",
  violet: "#9B6BFF",
  blue: "#4DA6FF",
} as const;

export const F = {
  orbitron: "var(--font-orbitron), sans-serif",
  rajdhani: "var(--font-rajdhani), sans-serif",
  inter: "var(--font-inter), sans-serif",
  mono: "var(--font-jbmono), monospace",
} as const;

export const HEX_CLIP = "polygon(25% 6%,75% 6%,100% 50%,75% 94%,25% 94%,0% 50%)";
export const HEX_BG = "linear-gradient(160deg,rgba(0,212,255,.35),rgba(10,20,35,.9))";

export interface StatusStyle {
  color: string;
  label: string;
  anim: string;
}

export const AGENT_STATUS: Record<string, StatusStyle> = {
  working: { color: C.cyan, label: "WORKING", anim: "ringPulse 2.2s ease-in-out infinite" },
  idle: { color: C.dim, label: "IDLE", anim: "none" },
  blocked: { color: C.red, label: "BLOCKED", anim: "ringPulse 1.2s ease-in-out infinite" },
  approval: { color: C.gold, label: "AWAITING APPROVAL", anim: "ringPulse 1.6s ease-in-out infinite" },
};

export function agentGlyph(name: string, kind?: string): string {
  const n = name.toUpperCase();
  if (n.startsWith("CODEX")) return "CX";
  if (n.startsWith("COWORK")) return "CW";
  if (n.startsWith("OPENCLAW")) return "OC";
  if (n.startsWith("HERMES")) return "HM";
  if (kind === "human" || n.includes("VA")) return "VA";
  return n.replace(/[^A-Z]/g, "").slice(0, 2) || "AG";
}

export const CLUSTER_COLORS: { color: string; rgb: string }[] = [
  { color: C.cyan, rgb: "0,212,255" },
  { color: C.magenta, rgb: "255,77,210" },
  { color: C.violet, rgb: "155,107,255" },
  { color: C.gold, rgb: "255,184,77" },
  { color: C.green, rgb: "61,245,166" },
  { color: C.blue, rgb: "77,166,255" },
];

/** Deterministic pseudo-random cells (same trick as the prototype). */
export function heatCells(seed: number, n: number, max = 1): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push((Math.abs(Math.sin(seed * 12.9898 + i * 78.233)) % 1) * max);
  }
  return out;
}

export function ageColor(ageHours: number, goldH = 8, redH = 20): string {
  return ageHours >= redH ? C.red : ageHours >= goldH ? C.gold : C.cyan;
}

let audioCtx: AudioContext | null = null;
export function chime(enabled: boolean, freq: number, dur = 0.25) {
  if (!enabled || typeof window === "undefined") return;
  try {
    audioCtx = audioCtx ?? new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "sine";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.08, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + dur);
  } catch {
    /* audio unavailable */
  }
}

export function isoWeekLabel(d = new Date()): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 864e5 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
