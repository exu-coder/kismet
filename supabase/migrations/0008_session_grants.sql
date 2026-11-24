-- Fallback identity issuance when Supabase Anonymous Sign-Ins are unavailable.
-- The session Edge Function uses the service role to create and sign in a
-- throwaway guest user, so the browser still gets a real auth.uid() session.
-- Rows here are only used for rate limiting and are never exposed to clients.
begin;

create table if not exists public.session_grants (
  id         bigserial primary key,
  ip         text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_session_grants_ip_created
  on public.session_grants (ip, created_at desc);
create index if not exists idx_session_grants_created
  on public.session_grants (created_at);

alter table public.session_grants enable row level security;
revoke all on table public.session_grants from public, anon, authenticated;
revoke all on sequence public.session_grants_id_seq from public, anon, authenticated;

commit;
