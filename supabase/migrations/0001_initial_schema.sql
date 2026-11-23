-- Kismet — initial Supabase schema (exported from the live project)
-- Ref: xjckwcvwssuadqkxgumt | Region: ap-south-1
-- Idempotent: safe to re-run.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id            uuid primary key default gen_random_uuid(),
  user_id       text unique,
  name          text not null default 'Anonymous',
  friend_code   text not null unique,
  country       text,
  photo_url     text,
  reveal_default boolean default false,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create table if not exists public.friends (
  id          uuid primary key default gen_random_uuid(),
  user_id     text,
  friend_id   text,
  friend_name text,
  friend_code text,
  created_at  timestamptz default now(),
  constraint friends_user_friend_unique unique (user_id, friend_id)
);

create table if not exists public.friend_requests (
  id           uuid primary key default gen_random_uuid(),
  from_user_id text,
  to_user_id   text,
  from_name    text,
  from_code    text,
  status       text default 'pending',
  created_at   timestamptz default now(),
  constraint friend_requests_from_to_unique unique (from_user_id, to_user_id),
  constraint friend_requests_status_check check (status in ('pending', 'accepted', 'rejected'))
);

create table if not exists public.messages (
  id           uuid primary key default gen_random_uuid(),
  from_user_id text,
  to_user_id   text,
  content      text not null,
  created_at   timestamptz default now()
);

create table if not exists public.waiting_queue (
  id         uuid primary key default gen_random_uuid(),
  user_id    text not null,
  user_name  text default 'Anonymous',
  created_at timestamptz default now()
);

create table if not exists public.active_calls (
  id         uuid primary key default gen_random_uuid(),
  user1_id   text not null,
  user2_id   text not null,
  created_at timestamptz default now(),
  ended_at   timestamptz
);

create table if not exists public.match_queue (
  id           uuid primary key default gen_random_uuid(),
  user_id      text not null unique,
  interests    text[] default '{}',
  language     text default 'en',
  country      text,
  created_at   timestamptz default now(),
  matched_with text,
  call_id      text,
  role         text,
  constraint match_queue_role_check check (role in ('initiator', 'responder') or role is null)
);

create table if not exists public.reports (
  id          uuid primary key default gen_random_uuid(),
  reporter_id text not null,
  reported_id text not null,
  reason      text not null,
  call_id     text,
  created_at  timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- NOTE: these are intentionally permissive because identities are currently
-- random localStorage `user_...` IDs, not auth-backed. Tighten to
-- auth.uid()::text = user_id / from_user_id once real/anonymous auth lands.
-- ---------------------------------------------------------------------------

alter table public.profiles        enable row level security;
alter table public.friends         enable row level security;
alter table public.friend_requests enable row level security;
alter table public.messages        enable row level security;
alter table public.waiting_queue   enable row level security;
alter table public.active_calls    enable row level security;
alter table public.match_queue     enable row level security;
alter table public.reports         enable row level security;

do $$
declare r record;
begin
  for r in
    select * from (values
      ('profiles',        'profiles_select',        'SELECT', 'true', null::text),
      ('profiles',        'profiles_insert',        'INSERT', null,  'true'),
      ('profiles',        'profiles_update',        'UPDATE', 'true', null),
      ('friends',         'friends_select',         'SELECT', 'true', null),
      ('friends',         'friends_insert',         'INSERT', null,  'true'),
      ('friends',         'friends_delete',         'DELETE', 'true', null),
      ('friend_requests', 'requests_select',        'SELECT', 'true', null),
      ('friend_requests', 'requests_insert',        'INSERT', null,  'true'),
      ('friend_requests', 'requests_update',        'UPDATE', 'true', null),
      ('messages',        'messages_select',        'SELECT', 'true', null),
      ('messages',        'messages_insert',        'INSERT', null,  'true'),
      ('waiting_queue',   'Anyone can view waiting_queue',   'SELECT', 'true', null),
      ('waiting_queue',   'Anyone can insert into waiting_queue', 'INSERT', null, 'true'),
      ('waiting_queue',   'Anyone can delete from waiting_queue', 'DELETE', 'true', null),
      ('active_calls',    'Anyone can view active_calls',    'SELECT', 'true', null),
      ('active_calls',    'Anyone can insert into active_calls', 'INSERT', null, 'true'),
      ('active_calls',    'Anyone can update active_calls',  'UPDATE', 'true', null),
      ('match_queue',     'queue_select',           'SELECT', 'true', null),
      ('match_queue',     'queue_insert',           'INSERT', null,  'true'),
      ('match_queue',     'queue_update',           'UPDATE', 'true', null),
      ('match_queue',     'queue_delete',           'DELETE', 'true', null),
      ('reports',         'reports_select',         'SELECT', 'true', null),
      ('reports',         'reports_insert',         'INSERT', null,  'true')
    ) as v(tbl, pol, cmd, q, wc)
  loop
    execute format('drop policy if exists %I on public.%I', r.pol, r.tbl);
    if r.q is not null then
      execute format('create policy %I on public.%I for %s to public using (%s)', r.pol, r.tbl, r.cmd, r.q);
    else
      execute format('create policy %I on public.%I for %s to public with check (%s)', r.pol, r.tbl, r.cmd, r.wc);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Realtime publication (used for matchmaking + presence fallback)
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname='supabase_realtime' and schemaname='public' and tablename='active_calls') then
    alter publication supabase_realtime add table public.active_calls;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname='supabase_realtime' and schemaname='public' and tablename='match_queue') then
    alter publication supabase_realtime add table public.match_queue;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname='supabase_realtime' and schemaname='public' and tablename='waiting_queue') then
    alter publication supabase_realtime add table public.waiting_queue;
  end if;
end $$;
