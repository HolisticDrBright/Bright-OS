-- ============================================================
-- BRIGHT OS · Phase 1 · core schema
-- ============================================================
create extension if not exists pgcrypto;

-- ---------- enums ----------
create type agent_kind as enum ('claude', 'openclaw', 'hermes', 'human');
create type task_status as enum (
  'backlog', 'assigned', 'in_progress', 'awaiting_approval', 'verified', 'shipped', 'failed'
);
create type task_source as enum ('chat', 'heartbeat', 'cron', 'obsidian');
create type decision_status as enum ('pending', 'approved', 'rejected', 'discuss');
create type decision_via as enum ('web', 'telegram', 'voice');
create type heartbeat_severity as enum ('info', 'warn', 'alert');
create type brand_tier as enum ('engine', 'cron_only');

-- ---------- brands ----------
create table brands (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  tier        brand_tier not null default 'cron_only',
  revenue_wtd numeric(12, 2) not null default 0,
  spend_wtd   numeric(12, 2) not null default 0,
  metrics     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- ---------- agents ----------
create table agents (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  role         text not null,
  kind         agent_kind not null,
  status       text not null default 'idle',
  endpoint_url text,
  created_at   timestamptz not null default now()
);

-- ---------- tasks ----------
create table tasks (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  brand_id      uuid references brands (id) on delete set null,
  agent_id      uuid references agents (id) on delete set null,
  status        task_status not null default 'backlog',
  due_at        timestamptz,
  source        task_source not null default 'chat',
  obsidian_path text,
  frontmatter   jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index tasks_status_idx on tasks (status);
create index tasks_agent_idx on tasks (agent_id);
create index tasks_brand_idx on tasks (brand_id);
create index tasks_updated_idx on tasks (updated_at desc);
create unique index tasks_obsidian_path_idx on tasks (obsidian_path) where obsidian_path is not null;

-- ---------- decisions ----------
create table decisions (
  id                       uuid primary key default gen_random_uuid(),
  task_id                  uuid references tasks (id) on delete cascade,
  title                    text not null,
  requesting_agent_id      uuid references agents (id) on delete set null,
  brand_id                 uuid references brands (id) on delete set null,
  impact_note              text,
  impact_dollars_estimate  numeric(12, 2),
  preview_md               text,
  status                   decision_status not null default 'pending',
  -- e.g. {medical, regulatory, publish, spend}: drives hard guardrails
  tags                     text[] not null default '{}',
  decided_at               timestamptz,
  decided_via              decision_via,
  created_at               timestamptz not null default now()
);
create index decisions_status_idx on decisions (status);
create index decisions_task_idx on decisions (task_id);

-- age is tracked from created_at, never stored
create view decisions_with_age as
select d.*, extract(epoch from (now() - d.created_at)) / 3600.0 as age_hours
from decisions d;

-- ---------- heartbeat events ----------
create table heartbeat_events (
  id       uuid primary key default gen_random_uuid(),
  ts       timestamptz not null default now(),
  source   text not null,
  message  text not null,
  severity heartbeat_severity not null default 'info',
  meta     jsonb not null default '{}'::jsonb
);
create index heartbeat_events_ts_idx on heartbeat_events (ts desc);
create index heartbeat_events_severity_idx on heartbeat_events (severity, ts desc);

-- ---------- agent sessions (cost ledger) ----------
create table agent_sessions (
  id            uuid primary key default gen_random_uuid(),
  agent_id      uuid references agents (id) on delete set null,
  task_id       uuid references tasks (id) on delete set null,
  model         text,
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd      numeric(10, 4) not null default 0,
  duration_s    numeric(10, 2),
  quality_score numeric(4, 1),
  started_at    timestamptz not null default now()
);
create index agent_sessions_started_idx on agent_sessions (started_at desc);
create index agent_sessions_agent_idx on agent_sessions (agent_id, started_at desc);

-- ---------- claims (the hallucination guardrail) ----------
create table claims (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references tasks (id) on delete cascade,
  agent_id    uuid references agents (id) on delete set null,
  claim_text  text not null,
  source_url  text,
  verified    boolean not null default false,
  verified_by text,
  verified_at timestamptz,
  created_at  timestamptz not null default now()
);
create index claims_task_idx on claims (task_id);
create index claims_unverified_idx on claims (verified) where verified = false;

-- ---------- memory ----------
create table memory_log (
  id         uuid primary key default gen_random_uuid(),
  day        date not null unique,
  content_md text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table memory_promotions (
  id          uuid primary key default gen_random_uuid(),
  from_day    date not null,
  line_text   text not null,
  promoted_at timestamptz not null default now()
);

-- ---------- housekeeping triggers ----------
create function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger tasks_updated_at
  before update on tasks
  for each row execute function set_updated_at();

create trigger memory_log_updated_at
  before update on memory_log
  for each row execute function set_updated_at();

-- ============================================================
-- Non-negotiable guardrails, enforced at the database layer as
-- a backstop (the API layer enforces the same rules with
-- friendlier errors).
-- ============================================================

-- A claim without source_url can NEVER be verified.
create function enforce_claim_verification() returns trigger
language plpgsql as $$
begin
  if new.verified = true and (new.source_url is null or length(trim(new.source_url)) = 0) then
    raise exception 'GUARDRAIL: claim cannot be verified without source_url';
  end if;
  if new.verified = true and (tg_op = 'INSERT' or old.verified is distinct from true) then
    new.verified_at = coalesce(new.verified_at, now());
  end if;
  return new;
end $$;

create trigger claims_verification_guard
  before insert or update on claims
  for each row execute function enforce_claim_verification();

-- A task cannot flip to verified with unverified claims, and cannot
-- ship (publish) without an approved decision.
create function enforce_task_gates() returns trigger
language plpgsql as $$
begin
  if new.status = 'verified' and old.status is distinct from 'verified' then
    if exists (select 1 from claims c where c.task_id = new.id and c.verified = false) then
      raise exception 'GUARDRAIL: task has unverified claims — cannot mark verified';
    end if;
  end if;
  if new.status = 'shipped' and old.status is distinct from 'shipped' then
    if not exists (select 1 from decisions d where d.task_id = new.id and d.status = 'approved') then
      raise exception 'GUARDRAIL: publish requires an approved decision';
    end if;
  end if;
  return new;
end $$;

create trigger tasks_gates
  before update on tasks
  for each row execute function enforce_task_gates();
