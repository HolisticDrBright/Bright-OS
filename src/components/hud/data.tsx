"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createBrowserClient } from "@supabase/ssr";
import type {
  AgentRow,
  BrandRow,
  ClaimRow,
  DecisionRow,
  HeartbeatEventRow,
  TaskRow,
  TaskStatus,
} from "@/types/db";
import type { MetricsSummary } from "@/lib/metrics";

/** Live HUD data: REST bootstrap + Supabase Realtime deltas. */

export interface TaskWithRels extends TaskRow {
  claims?: ClaimRow[];
  decisions?: { id: string; title: string; status: string; created_at: string }[];
}

export interface DecisionJoined extends DecisionRow {
  age_hours: number;
  agents?: { id: string; name: string; kind: string } | null;
  brands?: { id: string; name: string } | null;
}

export interface MemoryData {
  memory_md: string;
  log: { id: string; day: string; content_md: string }[];
  promotions: { id: string; from_day: string; line_text: string; promoted_at: string }[];
}

export interface CommandReply {
  reply: string;
  actions: { tool: string; detail: string }[];
  cost_usd: number;
}

interface HudState {
  agents: AgentRow[];
  tasks: TaskWithRels[];
  decisions: DecisionJoined[];
  events: HeartbeatEventRow[];
  brands: BrandRow[];
  metrics: (MetricsSummary & { cost_breaker?: { tripped: boolean; spentTodayUsd: number; capUsd: number } }) | null;
  memory: MemoryData | null;
  loaded: boolean;
  decide: (id: string, action: "approve" | "reject" | "discuss") => Promise<{ ok: boolean; error?: string }>;
  moveTask: (id: string, status: TaskStatus) => Promise<{ ok: boolean; error?: string }>;
  sendCommand: (text: string, via?: "web" | "voice") => Promise<CommandReply>;
  promoteLine: (fromDay: string, line: string) => Promise<{ ok: boolean; error?: string }>;
  refresh: () => void;
}

const HudContext = createContext<HudState | null>(null);

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function HudDataProvider({ children }: { children: React.ReactNode }) {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [tasks, setTasks] = useState<TaskWithRels[]>([]);
  const [decisions, setDecisions] = useState<DecisionJoined[]>([]);
  const [events, setEvents] = useState<HeartbeatEventRow[]>([]);
  const [brands, setBrands] = useState<BrandRow[]>([]);
  const [metrics, setMetrics] = useState<HudState["metrics"]>(null);
  const [memory, setMemory] = useState<MemoryData | null>(null);
  const [loaded, setLoaded] = useState(false);

  const fetchCore = useCallback(async () => {
    const [a, t, d, e, b] = await Promise.all([
      getJson<{ agents: AgentRow[] }>("/api/agents"),
      getJson<{ tasks: TaskWithRels[] }>("/api/tasks?limit=300"),
      getJson<{ decisions: DecisionJoined[] }>("/api/decisions?status=pending,discuss"),
      getJson<{ events: HeartbeatEventRow[] }>("/api/heartbeat?limit=40"),
      getJson<{ brands: BrandRow[] }>("/api/brands"),
    ]);
    if (a) setAgents(a.agents);
    if (t) setTasks(t.tasks);
    if (d) setDecisions(d.decisions);
    if (e) setEvents(e.events);
    if (b) setBrands(b.brands);
    setLoaded(true);
  }, []);

  const fetchMetrics = useCallback(async () => {
    const m = await getJson<NonNullable<HudState["metrics"]>>("/api/metrics/summary");
    if (m) setMetrics(m);
  }, []);

  const fetchMemory = useCallback(async () => {
    const m = await getJson<MemoryData>("/api/memory");
    if (m) setMemory(m);
  }, []);

  const refresh = useCallback(() => {
    void fetchCore();
    void fetchMetrics();
    void fetchMemory();
  }, [fetchCore, fetchMetrics, fetchMemory]);

  // bootstrap + slow poll fallback
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 90_000);
    return () => clearInterval(t);
  }, [refresh]);

  // realtime deltas — debounce refetch on any change to the live tables
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) return;
    const supabase = createBrowserClient(url, key);
    const bump = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => void fetchCore(), 400);
    };
    const channel = supabase
      .channel("hud-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, bump)
      .on("postgres_changes", { event: "*", schema: "public", table: "decisions" }, bump)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "heartbeat_events" },
        (payload) => {
          setEvents((prev) => [payload.new as HeartbeatEventRow, ...prev].slice(0, 60));
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [fetchCore]);

  const decide = useCallback<HudState["decide"]>(async (id, action) => {
    const res = await fetch(`/api/decisions/${id}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, via: "web" }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    }
    setDecisions((prev) => prev.filter((d) => d.id !== id || action === "discuss"));
    void fetchCore();
    return { ok: true };
  }, [fetchCore]);

  const moveTask = useCallback<HudState["moveTask"]>(async (id, status) => {
    const res = await fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    }
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, status } : t)));
    return { ok: true };
  }, []);

  const sendCommand = useCallback<HudState["sendCommand"]>(async (text, via = "web") => {
    const res = await fetch("/api/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, via }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { reply: `⚠ ${body.error ?? `HTTP ${res.status}`}`, actions: [], cost_usd: 0 };
    }
    const out = (await res.json()) as CommandReply;
    void fetchCore();
    return out;
  }, [fetchCore]);

  const promoteLine = useCallback<HudState["promoteLine"]>(async (fromDay, line) => {
    const res = await fetch("/api/memory/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from_day: fromDay, line_text: line }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    }
    void fetchMemory();
    return { ok: true };
  }, [fetchMemory]);

  const value = useMemo<HudState>(
    () => ({
      agents,
      tasks,
      decisions,
      events,
      brands,
      metrics,
      memory,
      loaded,
      decide,
      moveTask,
      sendCommand,
      promoteLine,
      refresh,
    }),
    [agents, tasks, decisions, events, brands, metrics, memory, loaded, decide, moveTask, sendCommand, promoteLine, refresh],
  );

  return <HudContext.Provider value={value}>{children}</HudContext.Provider>;
}

export function useHud(): HudState {
  const ctx = useContext(HudContext);
  if (!ctx) throw new Error("useHud outside HudDataProvider");
  return ctx;
}
