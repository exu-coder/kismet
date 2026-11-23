-- Remove redundant unique constraints and indexes without changing data.
begin;
alter table public.friend_requests drop constraint if exists friend_requests_from_user_id_to_user_id_key;
alter table public.friends drop constraint if exists friends_user_id_friend_id_key;
drop index if exists public.idx_friends_user;
drop index if exists public.idx_requests_from;
commit;
