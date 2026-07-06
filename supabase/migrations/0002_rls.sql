-- ============================================================
-- BRIGHT OS · Phase 1 · row-level security
-- Single-user system: the authenticated supervisor gets full
-- access, anon gets NOTHING. Workers/webhooks use the
-- service-role key which bypasses RLS by design.
-- ============================================================

alter table brands            enable row level security;
alter table agents            enable row level security;
alter table tasks             enable row level security;
alter table decisions         enable row level security;
alter table heartbeat_events  enable row level security;
alter table agent_sessions    enable row level security;
alter table claims            enable row level security;
alter table memory_log        enable row level security;
alter table memory_promotions enable row level security;

-- authenticated: full access on every table
create policy "authenticated all" on brands
  for all to authenticated using (true) with check (true);
create policy "authenticated all" on agents
  for all to authenticated using (true) with check (true);
create policy "authenticated all" on tasks
  for all to authenticated using (true) with check (true);
create policy "authenticated all" on decisions
  for all to authenticated using (true) with check (true);
create policy "authenticated all" on heartbeat_events
  for all to authenticated using (true) with check (true);
create policy "authenticated all" on agent_sessions
  for all to authenticated using (true) with check (true);
create policy "authenticated all" on claims
  for all to authenticated using (true) with check (true);
create policy "authenticated all" on memory_log
  for all to authenticated using (true) with check (true);
create policy "authenticated all" on memory_promotions
  for all to authenticated using (true) with check (true);

-- anon: no policies exist → no access. Said out loud for the reviewer.

-- The decisions_with_age view runs with the invoker's rights so RLS
-- on the underlying table applies.
alter view decisions_with_age set (security_invoker = true);
