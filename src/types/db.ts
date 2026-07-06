// Row shapes for the BRIGHT OS schema (supabase/migrations/0001_core_schema.sql).

export type AgentKind = "claude" | "openclaw" | "hermes" | "human";
export type TaskStatus =
  | "backlog"
  | "assigned"
  | "in_progress"
  | "awaiting_approval"
  | "verified"
  | "shipped"
  | "failed";
export type TaskSource = "chat" | "heartbeat" | "cron" | "obsidian";
export type DecisionStatus = "pending" | "approved" | "rejected" | "discuss";
export type DecisionVia = "web" | "telegram" | "voice";
export type HeartbeatSeverity = "info" | "warn" | "alert";
export type BrandTier = "engine" | "cron_only";

export interface AgentRow {
  id: string;
  name: string;
  role: string;
  kind: AgentKind;
  status: string;
  endpoint_url: string | null;
  created_at: string;
}

export interface BrandRow {
  id: string;
  name: string;
  tier: BrandTier;
  revenue_wtd: number;
  spend_wtd: number;
  metrics: Record<string, unknown>;
  created_at: string;
}

export interface TaskRow {
  id: string;
  title: string;
  brand_id: string | null;
  agent_id: string | null;
  status: TaskStatus;
  due_at: string | null;
  source: TaskSource;
  obsidian_path: string | null;
  frontmatter: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DecisionRow {
  id: string;
  task_id: string | null;
  title: string;
  requesting_agent_id: string | null;
  brand_id: string | null;
  impact_note: string | null;
  impact_dollars_estimate: number | null;
  preview_md: string | null;
  status: DecisionStatus;
  tags: string[];
  decided_at: string | null;
  decided_via: DecisionVia | null;
  created_at: string;
}

export interface DecisionWithAge extends DecisionRow {
  age_hours: number;
}

export interface HeartbeatEventRow {
  id: string;
  ts: string;
  source: string;
  message: string;
  severity: HeartbeatSeverity;
  meta: Record<string, unknown>;
}

export interface AgentSessionRow {
  id: string;
  agent_id: string | null;
  task_id: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  duration_s: number | null;
  quality_score: number | null;
  started_at: string;
}

export interface ClaimRow {
  id: string;
  task_id: string;
  agent_id: string | null;
  claim_text: string;
  source_url: string | null;
  verified: boolean;
  verified_by: string | null;
  verified_at: string | null;
  created_at: string;
}

export interface MemoryLogRow {
  id: string;
  day: string;
  content_md: string;
  created_at: string;
  updated_at: string;
}

export interface MemoryPromotionRow {
  id: string;
  from_day: string;
  line_text: string;
  promoted_at: string;
}
