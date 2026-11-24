-- Let revealed friends see each other's saved display name and profile photo.
-- Profiles stay private to everyone else: combine the old owner/admin SELECT
-- policies into one visible-profile policy that also admits accepted friends
-- and pending friend requests. No service-role lookup is exposed to clients.

create index if not exists kismet_requests_to_from_pending_idx
  on public.friend_requests (to_user_id, from_user_id)
  where status = 'pending';

drop policy if exists profiles_select_visible on public.profiles;
drop policy if exists profiles_select_revealed_peer on public.profiles;
drop policy if exists profiles_select_own on public.profiles;
drop policy if exists profiles_admin_select on public.profiles;

create policy profiles_select_visible on public.profiles
  for select to authenticated
  using (
    not (select private.kismet_ban_active((select auth.uid())::text))
    and (
      user_id = (select auth.uid())::text
      or public.kismet_is_admin()
      or exists (
        select 1 from public.friends f
        where f.user_id = (select auth.uid())::text
          and f.friend_id = profiles.user_id
      )
      or exists (
        select 1 from public.friend_requests r
        where r.status = 'pending'
          and (
            (r.from_user_id = (select auth.uid())::text and r.to_user_id = profiles.user_id)
            or (r.to_user_id = (select auth.uid())::text and r.from_user_id = profiles.user_id)
          )
      )
    )
  );
