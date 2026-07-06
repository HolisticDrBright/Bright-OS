-- ============================================================
-- BRIGHT OS · Phase 1 · realtime + storage
-- ============================================================

-- Realtime on the three live surfaces of the HUD.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.decisions;
alter publication supabase_realtime add table public.heartbeat_events;

-- Full row images so UPDATE events carry old values to the HUD.
alter table public.tasks replica identity full;
alter table public.decisions replica identity full;
alter table public.heartbeat_events replica identity full;

-- Private bucket for nightly pg_dump uploads (service role only:
-- no storage.objects policies are created on purpose).
insert into storage.buckets (id, name, public)
values ('backups', 'backups', false)
on conflict (id) do nothing;
