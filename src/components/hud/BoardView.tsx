"use client";

import { useState } from "react";
import type { ViewCtx } from "./BrightOS";
import type { TaskWithRels } from "./data";
import { DiffLines, HexAvatar } from "./chrome";
import { C, F, agentGlyph, chime } from "./theme";
import type { TaskStatus } from "@/types/db";

const COLS: { key: TaskStatus | "shipped_verified"; statuses: TaskStatus[]; label: string; color: string }[] = [
  { key: "backlog", statuses: ["backlog"], label: "BACKLOG", color: C.dim },
  { key: "assigned", statuses: ["assigned"], label: "ASSIGNED", color: C.arc },
  { key: "in_progress", statuses: ["in_progress"], label: "IN PROGRESS", color: C.cyan },
  { key: "awaiting_approval", statuses: ["awaiting_approval"], label: "AWAITING APPROVAL", color: C.gold },
  { key: "shipped_verified", statuses: ["verified", "shipped"], label: "VERIFIED-SHIPPED", color: C.green },
];

export default function BoardView(ctx: ViewCtx) {
  const { hud, decisions, sound, showStamp } = ctx;
  const [diffOpen, setDiffOpen] = useState<Record<string, boolean>>({});

  const drop = async (taskId: string, colKey: string) => {
    const target: TaskStatus = colKey === "shipped_verified" ? "verified" : (colKey as TaskStatus);
    const task = hud.tasks.find((t) => t.id === taskId);
    if (!task || task.status === target) return;
    chime(sound, 600, 0.15);
    const res = await hud.moveTask(taskId, target);
    if (!res.ok) {
      showStamp("BLOCKED", C.red);
      chime(sound, 320, 0.3);
      alert(`Move refused: ${res.error}`);
    }
  };

  const pendingDecisionFor = (t: TaskWithRels) =>
    decisions.find((d) => d.task_id === t.id && d.status === "pending");

  return (
    <div style={{ position: "relative", zIndex: 5, display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 12, padding: "14px 16px", height: "calc(100vh - 92px)", animation: "fadeUp .4s ease-out both" }}>
      {COLS.map((col) => {
        const cards = hud.tasks.filter((t) => col.statuses.includes(t.status));
        return (
          <div
            key={col.key}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData("text/plain");
              if (id) void drop(id, col.key);
            }}
            style={{ display: "flex", flexDirection: "column", gap: 9, background: "rgba(10,20,35,.35)", border: "1px dashed rgba(0,212,255,.16)", borderRadius: 8, padding: 10, overflowY: "auto" }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontFamily: F.rajdhani, fontWeight: 700, fontSize: 11, letterSpacing: ".18em", color: col.color }}>{col.label}</div>
              <div style={{ fontFamily: F.mono, fontSize: 10, color: C.dim }}>{cards.length}</div>
            </div>
            {cards.map((t) => {
              const agent = hud.agents.find((a) => a.id === t.agent_id);
              const brand = hud.brands.find((b) => b.id === t.brand_id);
              const decision = pendingDecisionFor(t);
              const shipped = t.status === "shipped";
              const dueToday = t.due_at && new Date(t.due_at).toDateString() === new Date().toDateString();
              const flaggedClaims = (t.claims ?? []).filter((c) => !c.verified).length;
              return (
                <div
                  key={t.id}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData("text/plain", t.id)}
                  onClick={() => decision && setDiffOpen((x) => ({ ...x, [t.id]: !x[t.id] }))}
                  className="hud-hover"
                  style={{ cursor: "grab", background: "rgba(10,20,35,.7)", backdropFilter: "blur(16px)", border: "1px solid rgba(0,212,255,.2)", borderRadius: 7, padding: 10 }}
                >
                  <div style={{ fontFamily: F.rajdhani, fontWeight: 600, fontSize: 12.5, color: C.bright, lineHeight: 1.35 }}>{t.title}</div>
                  <div style={{ display: "flex", gap: 6, marginTop: 7, alignItems: "center" }}>
                    {agent && <HexAvatar glyph={agentGlyph(agent.name, agent.kind)} color={C.cyan} size={20} />}
                    {brand && (
                      <span style={{ fontFamily: F.mono, fontSize: 9, padding: "2px 6px", borderRadius: 3, border: "1px solid rgba(0,212,255,.3)", color: C.arc }}>
                        {brand.name.toUpperCase().slice(0, 16)}
                      </span>
                    )}
                    <span style={{ marginLeft: "auto", fontFamily: F.mono, fontSize: 9, color: shipped ? C.green : dueToday ? C.red : C.dim }}>
                      {shipped ? "SHIPPED" : t.status === "verified" ? "VERIFIED" : t.due_at ? new Date(t.due_at).toLocaleDateString("en-US", { month: "short", day: "2-digit" }).toUpperCase() : "—"}
                    </span>
                  </div>
                  {flaggedClaims > 0 && (
                    <div style={{ marginTop: 6, fontFamily: F.mono, fontSize: 9, color: C.red }}>⚑ {flaggedClaims} unverified claim{flaggedClaims > 1 ? "s" : ""}</div>
                  )}
                  {decision && !diffOpen[t.id] && (
                    <div style={{ marginTop: 6, fontFamily: F.mono, fontSize: 9, color: C.dim }}>⧉ decision attached · click to review</div>
                  )}
                  {decision && diffOpen[t.id] && (
                    <div style={{ marginTop: 7, padding: 8, border: "1px solid rgba(0,212,255,.14)", borderRadius: 5, background: "rgba(5,10,20,.8)", fontFamily: F.mono, fontSize: 10, lineHeight: 1.7 }} onClick={(e) => e.stopPropagation()}>
                      <DiffLines lines={decision.previewLines} fontSize={10} />
                      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                        <div
                          onClick={() => {
                            void hud.decide(decision.id, "approve").then((r) => {
                              if (r.ok) {
                                showStamp("APPROVED ✓");
                                chime(sound, 1046, 0.3);
                              } else alert(`Refused: ${r.error}`);
                            });
                          }}
                          className="btn-approve"
                          style={{ cursor: "pointer", flex: 1, textAlign: "center", padding: "5px 0", border: "1px solid rgba(61,245,166,.5)", borderRadius: 4, fontFamily: F.rajdhani, fontWeight: 700, fontSize: 10, letterSpacing: ".1em", color: C.green }}
                        >
                          ✔ APPROVE
                        </div>
                        <div
                          onClick={() => {
                            void hud.decide(decision.id, "reject").then(() => chime(sound, 320, 0.3));
                          }}
                          className="btn-reject"
                          style={{ cursor: "pointer", flex: 1, textAlign: "center", padding: "5px 0", border: "1px solid rgba(255,77,109,.5)", borderRadius: 4, fontFamily: F.rajdhani, fontWeight: 700, fontSize: 10, letterSpacing: ".1em", color: C.red }}
                        >
                          ✕ REJECT
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
