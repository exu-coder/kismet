-- Moderation, identity hardening and admin allowlist.
--
-- - Friend codes move from a UUID-derived 6-hex suffix to 48 bits of randomness.
-- - Friend-code lookups are rate limited per authenticated session.
-- - Reports can be reviewed and turned into warnings or timed/permanent bans.
-- - Guest-session rate limiting is atomic instead of count-then-insert.
-- - Admin access is email/password auth plus an explicit email allowlist.
begin;

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.kismet_admin_emails (
  email      text primary key,
  created_at timestamptz not null default now()
);

create table if not exists public.kismet_bans (
  user_id    text primary key,
  reason     text not null default '',
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  created_by text,
  report_id  uuid
);

create index if not exists kismet_bans_active_idx
  on public.kismet_bans (expires_at)
  where expires_at is not null;

create table if not exists public.kismet_profile_lookups (
  user_id      text primary key,
  window_start timestamptz not null default now(),
  lookup_count integer not null default 0
);

alter table public.reports add column if not exists status text not null default 'pending';
alter table public.reports add column if not exists resolution_note text;
alter table public.reports add column if not exists reviewed_by text;
alter table public.reports add column if not exists reviewed_at timestamptz;

create index if not exists reports_status_created_idx
  on public.reports (status, created_at desc);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'reports_status_check' and conrelid = 'public.reports'::regclass
  ) then
    alter table public.reports
      add constraint reports_status_check
      check (status in ('pending', 'dismissed', 'warned', 'banned'));
  end if;
end $$;

alter table public.kismet_admin_emails enable row level security;
alter table public.kismet_bans enable row level security;
alter table public.kismet_profile_lookups enable row level security;

revoke all on table public.kismet_admin_emails, public.kismet_bans,
  public.kismet_profile_lookups from public, anon, authenticated;
revoke all on sequence public.session_grants_id_seq from public, anon, authenticated;

grant select on public.kismet_admin_emails to authenticated;
grant select, insert, update, delete on public.kismet_bans to authenticated;
grant select, update on public.reports to authenticated;
grant select on public.active_calls to authenticated;

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

-- Ban checks live in a private schema so RLS policies can read them without
-- exposing the bans table to ordinary users.
create or replace function private.kismet_ban_active(p_user_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_user_id is not null
    and exists (
      select 1 from public.kismet_bans b
      where b.user_id = p_user_id
        and (b.expires_at is null or b.expires_at > now())
    );
$$;

revoke all on function private.kismet_ban_active(text) from public, anon;
grant execute on function private.kismet_ban_active(text) to authenticated, service_role;

create or replace function public.kismet_is_admin()
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
    and exists (
      select 1 from public.kismet_admin_emails a
      where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    );
$$;

revoke all on function public.kismet_is_admin() from public, anon;
grant execute on function public.kismet_is_admin() to authenticated;

create or replace function public.kismet_ban_status()
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select jsonb_build_object(
        'banned', true,
        'reason', b.reason,
        'expires_at', b.expires_at
      )
      from public.kismet_bans b
      where b.user_id = (select auth.uid())::text
        and (b.expires_at is null or b.expires_at > now())
      limit 1
    ),
    jsonb_build_object('banned', false, 'reason', null, 'expires_at', null)
  );
$$;

revoke all on function public.kismet_ban_status() from public, anon;
grant execute on function public.kismet_ban_status() to authenticated;

-- ---------------------------------------------------------------------------
-- Friend codes: 48 random bits, normalized server-side on every write.
-- ---------------------------------------------------------------------------

create or replace function public.kismet_generate_friend_code()
returns text
language sql
volatile
set search_path = public, pg_temp
as $$
  select 'KS-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
$$;

update public.profiles
   set friend_code = public.kismet_generate_friend_code(),
       updated_at = now()
 where friend_code is null
    or friend_code !~ '^KS-[0-9A-F]{12}$';

create or replace function public.kismet_normalize_friend_code()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.friend_code is null or new.friend_code !~ '^KS-[0-9A-F]{12}$' then
    new.friend_code := public.kismet_generate_friend_code();
  end if;
  return new;
end;
$$;

drop trigger if exists kismet_profiles_friend_code on public.profiles;
create trigger kismet_profiles_friend_code
  before insert or update of friend_code on public.profiles
  for each row execute function public.kismet_normalize_friend_code();

-- ---------------------------------------------------------------------------
-- Atomic guest-session reservation and friend-code lookup throttling.
-- ---------------------------------------------------------------------------

create or replace function public.kismet_reserve_session(
  p_ip text,
  p_per_ip_limit integer default 30,
  p_global_daily_limit integer default 1000
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ip text := left(coalesce(p_ip, 'unknown'), 64);
  v_ip_count integer;
  v_day_count integer;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;

  -- One lock makes the count and insert a single atomic decision.
  perform pg_advisory_xact_lock(194783, 2);

  delete from public.session_grants where created_at < now() - interval '24 hours';

  select count(*) into v_ip_count
    from public.session_grants
   where ip = v_ip and created_at >= now() - interval '1 hour';

  select count(*) into v_day_count from public.session_grants;

  if v_ip_count >= p_per_ip_limit or v_day_count >= p_global_daily_limit then
    return false;
  end if;

  insert into public.session_grants (ip) values (v_ip);
  return true;
end;
$$;

revoke all on function public.kismet_reserve_session(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.kismet_reserve_session(text, integer, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- RLS: add admin visibility and block banned sessions from social actions.
-- ---------------------------------------------------------------------------

drop policy if exists kismet_admin_emails_select_self on public.kismet_admin_emails;
create policy kismet_admin_emails_select_self on public.kismet_admin_emails
  for select to authenticated
  using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

drop policy if exists kismet_bans_select_self on public.kismet_bans;
create policy kismet_bans_select_self on public.kismet_bans
  for select to authenticated
  using (user_id = (select auth.uid())::text);

drop policy if exists kismet_bans_admin_all on public.kismet_bans;
create policy kismet_bans_admin_all on public.kismet_bans
  for all to authenticated
  using (public.kismet_is_admin())
  with check (public.kismet_is_admin());

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (user_id = (select auth.uid())::text);

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
  for insert to authenticated
  with check (
    user_id = (select auth.uid())::text
    and not private.kismet_ban_active((select auth.uid())::text)
  );

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (
    user_id = (select auth.uid())::text
    and not private.kismet_ban_active((select auth.uid())::text)
  )
  with check (
    user_id = (select auth.uid())::text
    and not private.kismet_ban_active((select auth.uid())::text)
  );

drop policy if exists profiles_admin_select on public.profiles;
create policy profiles_admin_select on public.profiles
  for select to authenticated
  using (public.kismet_is_admin());

drop policy if exists friends_select_own on public.friends;
create policy friends_select_own on public.friends
  for select to authenticated
  using (
    user_id = (select auth.uid())::text
    and not private.kismet_ban_active((select auth.uid())::text)
  );

drop policy if exists friends_delete_own on public.friends;
create policy friends_delete_own on public.friends
  for delete to authenticated
  using (
    user_id = (select auth.uid())::text
    and not private.kismet_ban_active((select auth.uid())::text)
  );

drop policy if exists requests_select_participant on public.friend_requests;
create policy requests_select_participant on public.friend_requests
  for select to authenticated
  using (
    (from_user_id = (select auth.uid())::text or to_user_id = (select auth.uid())::text)
    and not private.kismet_ban_active((select auth.uid())::text)
  );

drop policy if exists messages_select_participant on public.messages;
create policy messages_select_participant on public.messages
  for select to authenticated
  using (
    (from_user_id = (select auth.uid())::text or to_user_id = (select auth.uid())::text)
    and not private.kismet_ban_active((select auth.uid())::text)
  );

drop policy if exists messages_insert_friend_only on public.messages;
create policy messages_insert_friend_only on public.messages
  for insert to authenticated
  with check (
    from_user_id = (select auth.uid())::text
    and to_user_id <> (select auth.uid())::text
    and length(btrim(content)) between 1 and 4000
    and not private.kismet_ban_active((select auth.uid())::text)
    and exists (
      select 1 from public.friends f
      where f.user_id = (select auth.uid())::text
        and f.friend_id = messages.to_user_id
    )
  );

drop policy if exists reports_insert_self on public.reports;
create policy reports_insert_self on public.reports
  for insert to authenticated
  with check (
    reporter_id = (select auth.uid())::text
    and reported_id <> (select auth.uid())::text
    and reason in ('inappropriate', 'exposure', 'underage', 'spam', 'other')
    and not private.kismet_ban_active((select auth.uid())::text)
  );

drop policy if exists reports_admin_select on public.reports;
create policy reports_admin_select on public.reports
  for select to authenticated
  using (public.kismet_is_admin());

drop policy if exists reports_admin_update on public.reports;
create policy reports_admin_update on public.reports
  for update to authenticated
  using (public.kismet_is_admin())
  with check (public.kismet_is_admin());

drop policy if exists active_calls_admin_select on public.active_calls;
create policy active_calls_admin_select on public.active_calls
  for select to authenticated
  using (public.kismet_is_admin());

-- ---------------------------------------------------------------------------
-- Social/matching RPCs now reject banned sessions.
-- ---------------------------------------------------------------------------

create or replace function public.kismet_find_profile_by_code(p_friend_code text)
returns table(user_id text, name text, friend_code text, country text, photo_url text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := (select auth.uid())::text;
  v_count integer;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if private.kismet_ban_active(v_uid) then
    raise exception 'This session is blocked' using errcode = '42501';
  end if;
  if p_friend_code is null or length(btrim(p_friend_code)) not between 8 and 32 then
    return;
  end if;
  if not exists (select 1 from public.profiles where profiles.user_id = v_uid) then
    raise exception 'Save your profile before looking up a friend code';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_uid), 7);

  insert into public.kismet_profile_lookups (user_id, window_start, lookup_count)
  values (v_uid, now(), 1)
  on conflict (user_id) do update
    set window_start = case
          when public.kismet_profile_lookups.window_start < now() - interval '1 hour'
          then now()
          else public.kismet_profile_lookups.window_start
        end,
        lookup_count = case
          when public.kismet_profile_lookups.window_start < now() - interval '1 hour'
          then 1
          else public.kismet_profile_lookups.lookup_count + 1
        end
  returning public.kismet_profile_lookups.lookup_count into v_count;

  if v_count > 20 then
    raise exception 'Too many friend-code lookups. Try again later.' using errcode = '42900';
  end if;

  return query
    select p.user_id, p.name, p.friend_code, p.country, p.photo_url
      from public.profiles p
     where upper(p.friend_code) = upper(btrim(p_friend_code))
     limit 1;
end;
$$;

create or replace function public.kismet_send_friend_request(p_to_user_id text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_from_id text := (select auth.uid())::text;
  v_request_id uuid;
begin
  if v_from_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if private.kismet_ban_active(v_from_id) or private.kismet_ban_active(p_to_user_id) then
    raise exception 'This session is blocked' using errcode = '42501';
  end if;
  if p_to_user_id is null or p_to_user_id = v_from_id then
    raise exception 'Invalid recipient';
  end if;
  if not exists (select 1 from public.profiles where user_id = v_from_id) then
    raise exception 'Save your profile before sending a friend request';
  end if;
  if not exists (select 1 from public.profiles where user_id = p_to_user_id) then
    raise exception 'This profile is no longer available';
  end if;

  insert into public.friend_requests(from_user_id, to_user_id, from_name, from_code, status)
  select v_from_id, target.user_id, sender.name, sender.friend_code, 'pending'
    from public.profiles sender
    join public.profiles target on target.user_id = p_to_user_id
   where sender.user_id = v_from_id
  on conflict(from_user_id, to_user_id) do update
    set from_name = excluded.from_name,
        from_code = excluded.from_code,
        status = 'pending',
        created_at = now()
  returning id into v_request_id;

  return v_request_id;
end;
$$;

create or replace function public.kismet_respond_friend_request(p_request_id uuid, p_status text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id text := (select auth.uid())::text;
  v_request public.friend_requests%rowtype;
  v_name text;
  v_code text;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if private.kismet_ban_active(v_user_id) then
    raise exception 'This session is blocked' using errcode = '42501';
  end if;
  if p_status not in ('accepted', 'rejected') then
    raise exception 'Invalid request status';
  end if;

  select * into v_request
    from public.friend_requests
   where id = p_request_id and to_user_id = v_user_id and status = 'pending'
   for update;
  if not found then return false; end if;
  if private.kismet_ban_active(v_request.from_user_id) then
    raise exception 'This session is blocked' using errcode = '42501';
  end if;

  update public.friend_requests set status = p_status where id = v_request.id;

  if p_status = 'accepted' then
    select name, friend_code into v_name, v_code
      from public.profiles where user_id = v_user_id;

    insert into public.friends(user_id, friend_id, friend_name, friend_code)
    values(v_user_id, v_request.from_user_id,
           coalesce(v_request.from_name, 'Anonymous'), coalesce(v_request.from_code, ''))
    on conflict(user_id, friend_id) do update
      set friend_name = excluded.friend_name, friend_code = excluded.friend_code;

    insert into public.friends(user_id, friend_id, friend_name, friend_code)
    values(v_request.from_user_id, v_user_id, coalesce(v_name, 'Anonymous'), coalesce(v_code, ''))
    on conflict(user_id, friend_id) do update
      set friend_name = excluded.friend_name, friend_code = excluded.friend_code;
  end if;

  return true;
end;
$$;

create or replace function public.kismet_matchmake(
  p_user_id text,
  p_action text default 'join',
  p_call_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id text := p_user_id;
  v_existing public.match_queue%rowtype;
  v_partner public.match_queue%rowtype;
  v_call_id text;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  if v_user_id is null or v_user_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'Invalid user identity';
  end if;
  if p_action not in ('join', 'leave') then
    raise exception 'Invalid matchmaking action';
  end if;
  if p_call_id is not null
     and p_call_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'Invalid call identity';
  end if;

  perform pg_advisory_xact_lock(194783, 1);

  if p_action = 'leave' then
    if p_call_id is null then
      delete from public.match_queue where user_id = v_user_id;
      update public.match_queue
        set matched_with = null, call_id = null, role = null, created_at = now()
       where matched_with = v_user_id;
    else
      delete from public.match_queue where user_id = v_user_id and call_id = p_call_id;
      update public.match_queue
        set matched_with = null, call_id = null, role = null, created_at = now()
       where call_id = p_call_id and matched_with = v_user_id;
    end if;
    return jsonb_build_object('ok', true);
  end if;

  if private.kismet_ban_active(v_user_id) then
    raise exception 'This session is blocked' using errcode = '42501';
  end if;

  delete from public.match_queue q
   where q.created_at < now() - interval '2 minutes'
      and (q.matched_with is null or q.call_id is null);

  delete from public.match_queue q
   where private.kismet_ban_active(q.user_id)
      or (q.matched_with is not null and private.kismet_ban_active(q.matched_with));

  select * into v_existing from public.match_queue where user_id = v_user_id for update;
  if found and v_existing.matched_with is not null and v_existing.call_id is not null then
    return jsonb_build_object(
      'status', 'matched',
      'callId', v_existing.call_id,
      'partnerId', v_existing.matched_with,
      'role', coalesce(v_existing.role, 'responder')
    );
  end if;

  select * into v_partner
    from public.match_queue
   where user_id <> v_user_id and matched_with is null
   order by created_at asc
   for update skip locked
   limit 1;

  if found then
    v_call_id := gen_random_uuid()::text;
    update public.match_queue
       set matched_with = v_user_id, call_id = v_call_id, role = 'responder'
     where user_id = v_partner.user_id and matched_with is null;
    if found then
      insert into public.match_queue(user_id, matched_with, call_id, role, created_at)
      values(v_user_id, v_partner.user_id, v_call_id, 'initiator', now())
      on conflict(user_id) do update
        set matched_with = excluded.matched_with,
            call_id = excluded.call_id,
            role = excluded.role,
            created_at = excluded.created_at;
      return jsonb_build_object(
        'status', 'matched',
        'callId', v_call_id,
        'partnerId', v_partner.user_id,
        'role', 'initiator'
      );
    end if;
  end if;

  insert into public.match_queue(user_id, matched_with, call_id, role, created_at)
  values(v_user_id, null, null, null, now())
  on conflict(user_id) do update
    set matched_with = null, call_id = null, role = null, created_at = now();

  return jsonb_build_object('status', 'waiting');
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin RPCs. All are SECURITY INVOKER and guarded by kismet_is_admin().
-- ---------------------------------------------------------------------------

create or replace function public.kismet_admin_stats()
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if not public.kismet_is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'reports_pending', (select count(*) from public.reports where status = 'pending'),
    'reports_total', (select count(*) from public.reports),
    'bans_active', (
      select count(*) from public.kismet_bans
       where expires_at is null or expires_at > now()
    ),
    'users_total', (select count(*) from public.profiles),
    'calls_active', (select count(*) from public.active_calls where ended_at is null),
    'profiles_total', (select count(*) from public.profiles)
  );
end;
$$;

create or replace function public.kismet_admin_list_reports()
returns table (
  id uuid,
  reporter_id text,
  reported_id text,
  reason text,
  call_id text,
  created_at timestamptz,
  status text,
  reporter_name text,
  reporter_code text,
  reported_name text,
  reported_code text,
  reporter_photo text,
  reported_photo text
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if not public.kismet_is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  return query
    select r.id, r.reporter_id, r.reported_id, r.reason, r.call_id, r.created_at,
           r.status,
           rp.name, rp.friend_code, dp.name, dp.friend_code,
           rp.photo_url, dp.photo_url
      from public.reports r
      left join public.profiles rp on rp.user_id = r.reporter_id
      left join public.profiles dp on dp.user_id = r.reported_id
     order by case when r.status = 'pending' then 0 else 1 end, r.created_at desc;
end;
$$;

create or replace function public.kismet_admin_ban_user(
  p_user_id text,
  p_reason text,
  p_duration_minutes integer default null
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if not public.kismet_is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  if p_user_id is null
     or p_user_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'Invalid user identity';
  end if;
  if p_duration_minutes is not null and p_duration_minutes < 1 then
    raise exception 'Invalid ban duration';
  end if;

  insert into public.kismet_bans(user_id, reason, created_at, expires_at, created_by)
  values (
    p_user_id,
    left(coalesce(p_reason, ''), 1000),
    now(),
    case
      when p_duration_minutes is null then null
      else now() + (p_duration_minutes || ' minutes')::interval
    end,
    (select auth.uid())::text
  )
  on conflict(user_id) do update
    set reason = excluded.reason,
        created_at = now(),
        expires_at = excluded.expires_at,
        created_by = excluded.created_by;

  return true;
end;
$$;

create or replace function public.kismet_admin_unban_user(p_user_id text)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if not public.kismet_is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  delete from public.kismet_bans where user_id = p_user_id;
  return true;
end;
$$;

create or replace function public.kismet_admin_resolve_report(
  p_report_id uuid,
  p_action text,
  p_note text default ''
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_reported_id text;
  v_reason text;
begin
  if not public.kismet_is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  if p_action not in ('dismiss', 'warn', 'ban') then
    raise exception 'Invalid report action';
  end if;

  select reported_id, reason into v_reported_id, v_reason
    from public.reports
   where id = p_report_id and status = 'pending'
   for update;
  if not found then return false; end if;

  update public.reports
     set status = case p_action
                    when 'dismiss' then 'dismissed'
                    when 'warn' then 'warned'
                    else 'banned'
                  end,
         resolution_note = left(coalesce(p_note, ''), 1000),
         reviewed_by = (select auth.uid())::text,
         reviewed_at = now()
   where id = p_report_id;

  if p_action = 'ban' then
    perform public.kismet_admin_ban_user(
      v_reported_id,
      coalesce(nullif(btrim(p_note), ''), 'Report: ' || v_reason),
      null
    );
  end if;

  return true;
end;
$$;

create or replace function public.kismet_admin_list_bans()
returns table (
  user_id text,
  reason text,
  created_at timestamptz,
  expires_at timestamptz,
  active boolean,
  reported_name text,
  reported_code text
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if not public.kismet_is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  return query
    select b.user_id, b.reason, b.created_at, b.expires_at,
           (b.expires_at is null or b.expires_at > now()) as active,
           p.name, p.friend_code
      from public.kismet_bans b
      left join public.profiles p on p.user_id = b.user_id
     order by b.created_at desc;
end;
$$;

create or replace function public.kismet_admin_list_profiles(p_limit integer default 100)
returns table (
  user_id text,
  name text,
  friend_code text,
  country text,
  photo_url text,
  created_at timestamptz,
  banned boolean
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if not public.kismet_is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  return query
    select p.user_id, p.name, p.friend_code, p.country, p.photo_url, p.created_at,
           private.kismet_ban_active(p.user_id) as banned
      from public.profiles p
     order by p.created_at desc
     limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;

revoke all on function
  public.kismet_is_admin(),
  public.kismet_ban_status(),
  public.kismet_admin_stats(),
  public.kismet_admin_list_reports(),
  public.kismet_admin_ban_user(text, text, integer),
  public.kismet_admin_unban_user(text),
  public.kismet_admin_resolve_report(uuid, text, text),
  public.kismet_admin_list_bans(),
  public.kismet_admin_list_profiles(integer)
  from public, anon;

grant execute on function
  public.kismet_is_admin(),
  public.kismet_ban_status(),
  public.kismet_admin_stats(),
  public.kismet_admin_list_reports(),
  public.kismet_admin_ban_user(text, text, integer),
  public.kismet_admin_unban_user(text),
  public.kismet_admin_resolve_report(uuid, text, text),
  public.kismet_admin_list_bans(),
  public.kismet_admin_list_profiles(integer)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Data hygiene: close abandoned calls and stale queue entries.
-- ---------------------------------------------------------------------------

update public.active_calls
   set ended_at = coalesce(ended_at, created_at + interval '5 minutes')
 where ended_at is null
   and created_at < now() - interval '1 hour';

delete from public.match_queue
 where created_at < now() - interval '2 minutes';

delete from public.waiting_queue
 where created_at < now() - interval '2 minutes';

commit;
