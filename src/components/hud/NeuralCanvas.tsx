"use client";

import { useEffect, useRef } from "react";
import { CLUSTER_COLORS } from "./theme";

/**
 * The Obsidian-vault neural graph — faithful port of the prototype engine:
 * 7 clusters (6 brand + 1 arc-blue core) of drifting nodes bounded in an
 * ellipse, proximity edges tinted by cluster, synapse pulses whose spawn
 * rate jumps 0.06 → 0.75/frame while "thinking", HUD callout filaments.
 */
export interface ClusterDef {
  name: string;
  count: string;
  color: string;
  rgb: string;
  side: "l" | "r";
  fy: number;
  hx: number;
  hy: number;
}

const LAYOUT: Omit<ClusterDef, "name" | "count" | "color" | "rgb">[] = [
  { side: "l", fy: 0.12, hx: -0.55, hy: -0.42 },
  { side: "r", fy: 0.12, hx: 0.55, hy: -0.42 },
  { side: "l", fy: 0.38, hx: -0.62, hy: 0.06 },
  { side: "r", fy: 0.38, hx: 0.62, hy: 0.06 },
  { side: "l", fy: 0.64, hx: -0.42, hy: 0.52 },
  { side: "r", fy: 0.64, hx: 0.45, hy: 0.52 },
];

export function buildClusters(brandNames: string[], counts: number[]): ClusterDef[] {
  return LAYOUT.map((pos, i) => ({
    ...pos,
    name: (brandNames[i] ?? `NODE ${i + 1}`).toUpperCase(),
    count: `${counts[i] ?? 0} TASKS`,
    color: CLUSTER_COLORS[i % CLUSTER_COLORS.length].color,
    rgb: CLUSTER_COLORS[i % CLUSTER_COLORS.length].rgb,
  }));
}

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  glow: number;
  rgb: string;
}
interface Pulse {
  a: Node;
  b: Node;
  t: number;
  sp: number;
  rgb: string;
}
interface NV {
  w: number;
  h: number;
  dpr: number;
  nodes: Node[];
  pulses: Pulse[];
  clusters: { rgb: string; x: number; y: number }[];
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export default function NeuralCanvas({
  clusters,
  thinking,
  onClick,
  onLinks,
}: {
  clusters: ClusterDef[];
  thinking: boolean;
  onClick?: () => void;
  onLinks?: (n: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const thinkingRef = useRef(thinking);
  thinkingRef.current = thinking;
  const clustersRef = useRef(clusters);
  clustersRef.current = clusters;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let nv: NV | null = null;
    let raf = 0;
    let frame = 0;

    const init = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) {
        nv = null;
        return;
      }
      const dpr = window.devicePixelRatio || 1;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      let sd = 42;
      const rand = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
      const cx = w * 0.5;
      const cy = h * 0.45;
      const rx = Math.min(w * 0.27, 300);
      const ry = Math.min(h * 0.34, 200);
      const cls = clustersRef.current.map((n) => ({ rgb: n.rgb, x: cx + n.hx * rx, y: cy + n.hy * ry }));
      cls.push({ rgb: "155,232,255", x: cx, y: cy - ry * 0.05 });
      const nodes: Node[] = [];
      cls.forEach((cl, ci) => {
        const count = ci === cls.length - 1 ? 28 : 17;
        for (let i = 0; i < count; i++) {
          const a = rand() * Math.PI * 2;
          const r = Math.pow(rand(), 0.6) * Math.min(rx, ry) * 0.52;
          let x = cl.x + Math.cos(a) * r;
          let y = cl.y + Math.sin(a) * r * 0.85;
          const ex = (x - cx) / rx;
          const ey = (y - cy) / ry;
          const d = ex * ex + ey * ey;
          if (d > 1) {
            const q = Math.sqrt(d);
            x = cx + (ex / q) * rx * 0.96;
            y = cy + (ey / q) * ry * 0.96;
          }
          nodes.push({ x, y, vx: (rand() - 0.5) * 0.12, vy: (rand() - 0.5) * 0.12, r: 1 + rand() * 2.1, glow: 0, rgb: cl.rgb });
        }
      });
      nv = { w, h, dpr, nodes, pulses: [], clusters: cls, cx, cy, rx, ry };
    };

    const draw = () => {
      if (!nv) {
        init();
        raf = requestAnimationFrame(draw);
        return;
      }
      const cw = canvas.clientWidth;
      if (cw && Math.abs(cw - nv.w) > 6) {
        init();
        raf = requestAnimationFrame(draw);
        return;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const { w, h, nodes, pulses } = nv;
      ctx.setTransform(nv.dpr, 0, 0, nv.dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const think = thinkingRef.current;

      const grad = ctx.createRadialGradient(nv.cx, nv.cy, 10, nv.cx, nv.cy, Math.max(nv.rx, nv.ry) * 1.1);
      grad.addColorStop(0, think ? "rgba(155,232,255,0.16)" : "rgba(0,212,255,0.08)");
      grad.addColorStop(1, "rgba(0,212,255,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // filaments to the HUD callouts
      clustersRef.current.forEach((n, i) => {
        const cl = nv!.clusters[i];
        if (!cl) return;
        const ax = n.side === "l" ? Math.min(0.025 * w + 152, w * 0.26) : Math.max(w - 0.025 * w - 152, w * 0.74);
        const ay = n.fy * h + 24;
        ctx.strokeStyle = `rgba(${n.rgb},0.35)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.quadraticCurveTo((ax + cl.x) / 2, ay, cl.x, cl.y);
        ctx.stroke();
        ctx.fillStyle = `rgba(${n.rgb},0.9)`;
        ctx.beginPath();
        ctx.arc(ax, ay, 2.5, 0, 7);
        ctx.fill();
      });

      for (const n of nodes) {
        n.x += n.vx;
        n.y += n.vy;
        const ex = (n.x - nv.cx) / nv.rx;
        const ey = (n.y - nv.cy) / nv.ry;
        if (ex * ex + ey * ey > 1) {
          n.vx *= -1;
          n.vy *= -1;
        }
        n.glow *= 0.94;
      }

      const linkDist = Math.min(w, h) * 0.14;
      const links: [number, number][] = [];
      ctx.lineWidth = 1;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < linkDist * linkDist) {
            const d = Math.sqrt(d2);
            const al = (1 - d / linkDist) * 0.22 + Math.max(a.glow, b.glow) * 0.4;
            ctx.strokeStyle = `rgba(${a.rgb},${Math.min(al, 0.7).toFixed(3)})`;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
            links.push([i, j]);
          }
        }
      }

      const rate = think ? 0.75 : 0.06;
      if (links.length && Math.random() < rate) {
        const lk = links[(Math.random() * links.length) | 0];
        const a = nodes[lk[0]];
        pulses.push({ a, b: nodes[lk[1]], t: 0, sp: 0.02 + Math.random() * 0.04, rgb: a.rgb });
      }
      if (think && Math.random() < 0.12) nodes[(Math.random() * nodes.length) | 0].glow = 1;

      for (let k = pulses.length - 1; k >= 0; k--) {
        const p = pulses[k];
        p.t += p.sp;
        if (p.t >= 1) {
          p.b.glow = 1;
          pulses.splice(k, 1);
          continue;
        }
        const x = p.a.x + (p.b.x - p.a.x) * p.t;
        const y = p.a.y + (p.b.y - p.a.y) * p.t;
        const t0 = Math.max(0, p.t - 0.3);
        const tx = p.a.x + (p.b.x - p.a.x) * t0;
        const ty = p.a.y + (p.b.y - p.a.y) * t0;
        ctx.strokeStyle = `rgba(${p.rgb},0.55)`;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.shadowColor = `rgba(${p.rgb},1)`;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(x, y, 2.1, 0, 7);
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      for (const n of nodes) {
        const g = n.glow;
        ctx.fillStyle = g > 0.05 ? `rgba(255,255,255,${(0.6 + g * 0.4).toFixed(2)})` : `rgba(${n.rgb},0.7)`;
        if (g > 0.05) {
          ctx.shadowColor = `rgba(${n.rgb},1)`;
          ctx.shadowBlur = 14 * g;
        }
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + g * 1.7, 0, 7);
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      frame += 1;
      if (onLinks && frame % 60 === 0) onLinks(links.length);
      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [onLinks]);

  return (
    <canvas
      ref={canvasRef}
      onClick={onClick}
      title="Neural core — click to engage voice"
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", cursor: "pointer" }}
    />
  );
}
