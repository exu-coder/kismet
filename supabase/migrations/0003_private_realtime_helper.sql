-- Keep Realtime authorization helpers outside PostgREST's exposed public schema.
begin;

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create or replace function private.kismet_can_access_signal_topic()
returns boolean
language sql
stable
security definer
set search_path = public, realtime, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.match_queue q
    where q.call_id = substring(realtime.topic() from 8)
      and q.user_id = (select auth.uid())::text
      and q.matched_with is not null
  );
$$;

revoke all on function private.kismet_can_access_signal_topic() from public, anon;
grant execute on function private.kismet_can_access_signal_topic() to authenticated;

drop policy if exists kismet_signal_read on realtime.messages;
drop policy if exists kismet_signal_write on realtime.messages;
create policy kismet_signal_read on realtime.messages
  for select to authenticated
  using (private.kismet_can_access_signal_topic() and extension in ('broadcast','presence'));
create policy kismet_signal_write on realtime.messages
  for insert to authenticated
  with check (private.kismet_can_access_signal_topic() and extension in ('broadcast','presence'));

revoke all on function public.kismet_can_access_signal_topic() from authenticated, anon, public;
drop function if exists public.kismet_can_access_signal_topic();

-- Explicit deny policies document the intended service-role-only access and
-- silence the linter's "RLS enabled without a policy" notices.
drop policy if exists match_queue_deny_client_access on public.match_queue;
drop policy if exists active_calls_deny_client_access on public.active_calls;
drop policy if exists waiting_queue_deny_client_access on public.waiting_queue;
create policy match_queue_deny_client_access on public.match_queue
  for all to authenticated using (false) with check (false);
create policy active_calls_deny_client_access on public.active_calls
  for all to authenticated using (false) with check (false);
create policy waiting_queue_deny_client_access on public.waiting_queue
  for all to authenticated using (false) with check (false);

commit;
