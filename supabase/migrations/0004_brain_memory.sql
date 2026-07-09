-- ============================================================
-- BRIGHT OS · Brain memory
--   working_memory — per-surface conversation continuity
--   memories       — typed long-term memory with pgvector semantic recall
-- ============================================================

create extension if not exists vector;

create table if not exists working_memory (
  surface     text primary key,               -- 'web' | 'voice' | 'telegram'
  summary_md  text not null default '',
  recent      jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);

create table if not exists memories (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('fact','preference','decision','person','project','lesson','context')),
  content          text not null,
  source           text not null default 'chat',      -- 'tool:web' | 'auto:telegram' | …
  importance       int  not null default 3 check (importance between 1 and 5),
  embedding        vector(1536),                       -- text-embedding-3-small; null = keyword-only row
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  last_recalled_at timestamptz
);

create index if not exists memories_embedding_idx on memories using hnsw (embedding vector_cosine_ops);
create index if not exists memories_kind_idx on memories (kind);
create index if not exists memories_importance_idx on memories (importance desc);

-- RLS: same single-operator posture as the rest of the schema —
-- authenticated gets everything, anon gets nothing, service-role bypasses.
alter table working_memory enable row level security;
alter table memories       enable row level security;
create policy "authenticated all" on working_memory
  for all to authenticated using (true) with check (true);
create policy "authenticated all" on memories
  for all to authenticated using (true) with check (true);

-- Semantic recall: nearest memories by cosine similarity.
create or replace function match_memories(query_embedding vector(1536), match_count int default 8)
returns table (id uuid, kind text, content text, importance int, similarity float)
language sql stable as $$
  select m.id, m.kind, m.content, m.importance,
         1 - (m.embedding <=> query_embedding) as similarity
  from memories m
  where m.embedding is not null
  order by m.embedding <=> query_embedding
  limit match_count
$$;
