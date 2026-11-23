-- Kismet secure anonymous identity, private signaling and transactional social actions.
-- Enable Anonymous Sign-Ins and disable public Realtime access before rollout.
begin;
do $$
declare p record;
begin
 for p in select schemaname,tablename,policyname from pg_policies
  where schemaname='public' and tablename in
  ('profiles','friends','friend_requests','messages','waiting_queue','active_calls','match_queue','reports')
 loop execute format('drop policy if exists %I on %I.%I',p.policyname,p.schemaname,p.tablename); end loop;
end $$;

alter table public.profiles enable row level security;
alter table public.friends enable row level security;
alter table public.friend_requests enable row level security;
alter table public.messages enable row level security;
alter table public.waiting_queue enable row level security;
alter table public.active_calls enable row level security;
alter table public.match_queue enable row level security;
alter table public.reports enable row level security;

revoke all on table public.profiles,public.friends,public.friend_requests,public.messages,
 public.waiting_queue,public.active_calls,public.match_queue,public.reports from anon,authenticated;
grant select,insert,update on public.profiles to authenticated;
grant select,delete on public.friends to authenticated;
grant select on public.friend_requests to authenticated;
grant select,insert on public.messages to authenticated;
grant insert on public.reports to authenticated;

create policy profiles_select_own on public.profiles for select to authenticated using(user_id=(select auth.uid())::text);
create policy profiles_insert_own on public.profiles for insert to authenticated with check(user_id=(select auth.uid())::text);
create policy profiles_update_own on public.profiles for update to authenticated
 using(user_id=(select auth.uid())::text) with check(user_id=(select auth.uid())::text);
create policy friends_select_own on public.friends for select to authenticated using(user_id=(select auth.uid())::text);
create policy friends_delete_own on public.friends for delete to authenticated using(user_id=(select auth.uid())::text);
create policy requests_select_participant on public.friend_requests for select to authenticated
 using(from_user_id=(select auth.uid())::text or to_user_id=(select auth.uid())::text);
create policy messages_select_participant on public.messages for select to authenticated
 using(from_user_id=(select auth.uid())::text or to_user_id=(select auth.uid())::text);
create policy messages_insert_friend_only on public.messages for insert to authenticated with check(
 from_user_id=(select auth.uid())::text and to_user_id<>(select auth.uid())::text
 and length(btrim(content)) between 1 and 4000
 and exists(select 1 from public.friends f where f.user_id=(select auth.uid())::text and f.friend_id=messages.to_user_id));
create policy reports_insert_self on public.reports for insert to authenticated with check(
 reporter_id=(select auth.uid())::text and reported_id<>(select auth.uid())::text
 and reason in ('inappropriate','exposure','underage','spam','other'));

create or replace function public.kismet_find_profile_by_code(p_friend_code text)
returns table(user_id text,name text,friend_code text,country text,photo_url text)
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
 if p_friend_code is null or length(btrim(p_friend_code)) not between 4 and 32 then return; end if;
 return query select p.user_id,p.name,p.friend_code,p.country,p.photo_url
 from public.profiles p where upper(p.friend_code)=upper(btrim(p_friend_code)) limit 1;
end; $$;

create or replace function public.kismet_send_friend_request(p_to_user_id text)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_from_id text := (select auth.uid())::text; v_request_id uuid;
begin
 if v_from_id is null then raise exception 'Authentication required' using errcode='28000'; end if;
 if p_to_user_id is null or p_to_user_id=v_from_id then raise exception 'Invalid recipient'; end if;
 if not exists(select 1 from public.profiles where user_id=v_from_id) then raise exception 'Save your profile before sending a friend request'; end if;
 if not exists(select 1 from public.profiles where user_id=p_to_user_id) then raise exception 'This profile is no longer available'; end if;
 insert into public.friend_requests(from_user_id,to_user_id,from_name,from_code,status)
 select v_from_id,target.user_id,sender.name,sender.friend_code,'pending'
 from public.profiles sender join public.profiles target on target.user_id=p_to_user_id
 where sender.user_id=v_from_id
 on conflict(from_user_id,to_user_id) do update set from_name=excluded.from_name,
 from_code=excluded.from_code,status='pending',created_at=now()
 returning id into v_request_id;
 return v_request_id;
end; $$;

create or replace function public.kismet_respond_friend_request(p_request_id uuid,p_status text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_user_id text := (select auth.uid())::text; v_request public.friend_requests%rowtype; v_name text; v_code text;
begin
 if v_user_id is null then raise exception 'Authentication required' using errcode='28000'; end if;
 if p_status not in ('accepted','rejected') then raise exception 'Invalid request status'; end if;
 select * into v_request from public.friend_requests where id=p_request_id and to_user_id=v_user_id and status='pending' for update;
 if not found then return false; end if;
 update public.friend_requests set status=p_status where id=v_request.id;
 if p_status='accepted' then
  select name,friend_code into v_name,v_code from public.profiles where user_id=v_user_id;
  insert into public.friends(user_id,friend_id,friend_name,friend_code)
  values(v_user_id,v_request.from_user_id,coalesce(v_request.from_name,'Anonymous'),coalesce(v_request.from_code,''))
  on conflict(user_id,friend_id) do update set friend_name=excluded.friend_name,friend_code=excluded.friend_code;
  insert into public.friends(user_id,friend_id,friend_name,friend_code)
  values(v_request.from_user_id,v_user_id,coalesce(v_name,'Anonymous'),coalesce(v_code,''))
  on conflict(user_id,friend_id) do update set friend_name=excluded.friend_name,friend_code=excluded.friend_code;
 end if;
 return true;
end; $$;

create or replace function public.kismet_matchmake(p_action text default 'join')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_user_id text := (select auth.uid())::text; v_existing public.match_queue%rowtype; v_partner public.match_queue%rowtype; v_call_id text;
begin
 if v_user_id is null then raise exception 'Authentication required' using errcode='28000'; end if;
 if p_action not in ('join','leave') then raise exception 'Invalid matchmaking action'; end if;
 perform pg_advisory_xact_lock(194783,1);
 if p_action='leave' then
  update public.match_queue set matched_with=null,call_id=null,role=null,created_at=now() where matched_with=v_user_id;
  delete from public.match_queue where user_id=v_user_id;
  return jsonb_build_object('ok',true);
 end if;
 delete from public.match_queue where created_at<now()-interval '2 minutes' and (matched_with is null or call_id is null);
 select * into v_existing from public.match_queue where user_id=v_user_id for update;
 if found and v_existing.matched_with is not null and v_existing.call_id is not null then
  return jsonb_build_object('status','matched','callId',v_existing.call_id,'partnerId',v_existing.matched_with,'role',coalesce(v_existing.role,'responder'));
 end if;
 select * into v_partner from public.match_queue where user_id<>v_user_id and matched_with is null order by created_at asc for update skip locked limit 1;
 if found then
  v_call_id:=gen_random_uuid()::text;
  update public.match_queue set matched_with=v_user_id,call_id=v_call_id,role='responder' where user_id=v_partner.user_id and matched_with is null;
  if found then
   insert into public.match_queue(user_id,matched_with,call_id,role,created_at) values(v_user_id,v_partner.user_id,v_call_id,'initiator',now())
   on conflict(user_id) do update set matched_with=excluded.matched_with,call_id=excluded.call_id,role=excluded.role,created_at=excluded.created_at;
   return jsonb_build_object('status','matched','callId',v_call_id,'partnerId',v_partner.user_id,'role','initiator');
  end if;
 end if;
 insert into public.match_queue(user_id,matched_with,call_id,role,created_at) values(v_user_id,null,null,null,now())
 on conflict(user_id) do update set matched_with=null,call_id=null,role=null,created_at=now();
 return jsonb_build_object('status','waiting');
end; $$;

revoke all on function public.kismet_find_profile_by_code(text) from public,anon;
revoke all on function public.kismet_send_friend_request(text) from public,anon;
revoke all on function public.kismet_respond_friend_request(uuid,text) from public,anon;
revoke all on function public.kismet_matchmake(text) from public,anon;
grant execute on function public.kismet_find_profile_by_code(text) to authenticated;
grant execute on function public.kismet_send_friend_request(text) to authenticated;
grant execute on function public.kismet_respond_friend_request(uuid,text) to authenticated;
grant execute on function public.kismet_matchmake(text) to authenticated;

create or replace function public.kismet_can_access_signal_topic()
returns boolean language sql stable security definer set search_path=public,realtime,pg_temp as $$
 select auth.uid() is not null and exists(select 1 from public.match_queue q
 where q.call_id=substring(realtime.topic() from 8) and q.user_id=(select auth.uid())::text and q.matched_with is not null);
$$;
revoke all on function public.kismet_can_access_signal_topic() from public,anon;
grant execute on function public.kismet_can_access_signal_topic() to authenticated;
alter table realtime.messages enable row level security;
drop policy if exists kismet_lobby_presence_read on realtime.messages;
drop policy if exists kismet_lobby_presence_write on realtime.messages;
drop policy if exists kismet_signal_read on realtime.messages;
drop policy if exists kismet_signal_write on realtime.messages;
create policy kismet_lobby_presence_read on realtime.messages for select to authenticated using(realtime.topic()='lobby' and extension='presence');
create policy kismet_lobby_presence_write on realtime.messages for insert to authenticated with check(realtime.topic()='lobby' and extension='presence');
create policy kismet_signal_read on realtime.messages for select to authenticated using(public.kismet_can_access_signal_topic() and extension in ('broadcast','presence'));
create policy kismet_signal_write on realtime.messages for insert to authenticated with check(public.kismet_can_access_signal_topic() and extension in ('broadcast','presence'));
commit;
