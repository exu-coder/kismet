-- Make matchmaking leave call-scoped.
--
-- The client fires leave() when a call ends and join() again almost immediately
-- (Next / automatic retry). With the old signature, a late leave deleted the
-- user's fresh queue row and cleared a brand-new match, stranding the partner.
-- Leave now only tears down the call id it was given, and falls back to the old
-- behaviour when no call id is supplied (legacy clients, direct leaves).
begin;

drop function if exists public.kismet_matchmake(text, text);

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
  if coalesce(auth.role(), '') <> 'service_role' then
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
      -- Legacy path: leave whatever this user is currently in.
      delete from public.match_queue where user_id = v_user_id;
      update public.match_queue
        set matched_with = null, call_id = null, role = null, created_at = now()
        where matched_with = v_user_id;
    else
      -- Only remove the row if it still belongs to that call. If the client has
      -- already re-queued (new call_id), its fresh row is left untouched.
      delete from public.match_queue
        where user_id = v_user_id and call_id = p_call_id;
      update public.match_queue
        set matched_with = null, call_id = null, role = null, created_at = now()
        where call_id = p_call_id and matched_with = v_user_id;
    end if;
    return jsonb_build_object('ok', true);
  end if;

  delete from public.match_queue
    where created_at < now() - interval '2 minutes'
      and (matched_with is null or call_id is null);

  select * into v_existing from public.match_queue where user_id = v_user_id for update;
  if found and v_existing.matched_with is not null and v_existing.call_id is not null then
    return jsonb_build_object(
      'status', 'matched',
      'callId', v_existing.call_id,
      'partnerId', v_existing.matched_with,
      'role', coalesce(v_existing.role, 'responder')
    );
  end if;

  select * into v_partner from public.match_queue
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

revoke all on function public.kismet_matchmake(text, text, text) from public, anon, authenticated;
grant execute on function public.kismet_matchmake(text, text, text) to service_role;

commit;
