-- Restrict the matchmaking transaction RPC to the verified Edge Function service role.
begin;

drop function if exists public.kismet_matchmake(text);
create or replace function public.kismet_matchmake(p_user_id text,p_action text default 'join')
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
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Service role required' using errcode='42501';
  end if;
  if v_user_id is null or v_user_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'Invalid user identity';
  end if;
  if p_action not in ('join','leave') then raise exception 'Invalid matchmaking action'; end if;

  perform pg_advisory_xact_lock(194783,1);
  if p_action='leave' then
    update public.match_queue set matched_with=null,call_id=null,role=null,created_at=now()
      where matched_with=v_user_id;
    delete from public.match_queue where user_id=v_user_id;
    return jsonb_build_object('ok',true);
  end if;

  delete from public.match_queue
    where created_at<now()-interval '2 minutes'
      and (matched_with is null or call_id is null);

  select * into v_existing from public.match_queue where user_id=v_user_id for update;
  if found and v_existing.matched_with is not null and v_existing.call_id is not null then
    return jsonb_build_object('status','matched','callId',v_existing.call_id,
      'partnerId',v_existing.matched_with,'role',coalesce(v_existing.role,'responder'));
  end if;

  select * into v_partner from public.match_queue
    where user_id<>v_user_id and matched_with is null
    order by created_at asc for update skip locked limit 1;
  if found then
    v_call_id:=gen_random_uuid()::text;
    update public.match_queue set matched_with=v_user_id,call_id=v_call_id,role='responder'
      where user_id=v_partner.user_id and matched_with is null;
    if found then
      insert into public.match_queue(user_id,matched_with,call_id,role,created_at)
        values(v_user_id,v_partner.user_id,v_call_id,'initiator',now())
      on conflict(user_id) do update set matched_with=excluded.matched_with,
        call_id=excluded.call_id,role=excluded.role,created_at=excluded.created_at;
      return jsonb_build_object('status','matched','callId',v_call_id,
        'partnerId',v_partner.user_id,'role','initiator');
    end if;
  end if;

  insert into public.match_queue(user_id,matched_with,call_id,role,created_at)
    values(v_user_id,null,null,null,now())
  on conflict(user_id) do update set matched_with=null,call_id=null,role=null,created_at=now();
  return jsonb_build_object('status','waiting');
end;
$$;

revoke all on function public.kismet_matchmake(text,text) from public,anon,authenticated;
grant execute on function public.kismet_matchmake(text,text) to service_role;

commit;
