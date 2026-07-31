create table if not exists public.line_secretary_store (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.line_secretary_store enable row level security;

grant all on table public.line_secretary_store to service_role;
