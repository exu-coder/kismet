# Kismet admin panel

The moderation dashboard is at **https://kissmeet.pages.dev/see.you.com/**. It is deliberately unlinked from the public site: no nav item, footer link, sitemap entry, `robots.txt` rule or public-page mention. The only way in is typing the path directly.

No DNS or custom domain is needed. Source files live in `see.you.com/`.

The page is static and talks to Supabase only through server-side RPCs. No admin key, service-role key or moderation table is exposed to the browser.

## Granting admin access

Access is decided entirely by `public.kismet_is_admin()` on the server. Email/password sign-in alone is not enough: the moderator's email must be in `public.kismet_admin_emails`.

1. Create the moderator's email/password user in Supabase Auth (Authentication → Users → Add user). Confirm their email if email confirmation is enabled.
2. Insert their email into the allowlist:

   ```sql
   insert into public.kismet_admin_emails (email)
   values ('moderator@example.com')
   on conflict (email) do nothing;
   ```

   The check is case-insensitive and compares the JWT `email` claim, so the Auth user's email and this row must match.
3. Open https://kissmeet.pages.dev/see.you.com/, sign in with that email and password. The panel calls `kismet_is_admin()` after every sign-in and when restoring an existing session. Non-admins are signed out and see a clean "Admin access required" screen with no moderation data or RPC calls.

To revoke access, delete the allowlist row; no redeploy is needed. Do not add sign-up, magic-link, OAuth or password-reset UI to this page.

## Using the panel

- **Sign in** with the moderator email/password. Wrong credentials and network failures produce distinct inline messages plus toasts. The password is never displayed, logged or stored.
- **Refresh** reloads all sections and shows a toast. Each section also has its own *Try again* button if a request fails.
- **Sign out** ends the Supabase session, clears moderation data from the screen and returns to the login form.
- **Statistics** shows pending and total reports, active bans, users, active calls and profiles.
- **Report queue** lists reports with reporter/reported identities, reason, time and call ID. *Dismiss* and *Warn* resolve the report; *Ban* confirms first, then bans permanently and resolves the report.
- **Bans** lists ban records with reason, duration/status and *Unban*.
- **Profiles** lists up to 100 recent profiles with local search. *Ban* confirms before applying a permanent ban.

Bans issued from this panel use `p_duration_minutes => null` (permanent). Timed bans are possible through `kismet_admin_ban_user()` directly but are not exposed in the UI. All destructive actions use `window.confirm`.

## Session behaviour

`redesign/supabase.js` first creates an anonymous guest session. The admin login form calls `window.kismetSupabase.auth.signInWithPassword({ email, password })`, which replaces that session with the moderator's email/password session. The panel then calls `window.kismetSupabase.realtime.setAuth(session.access_token)` when available. On later loads with an existing email session it restores the session, verifies admin status and skips the login form.

## RPC contract used by the frontend

| RPC | Parameters sent |
| --- | --- |
| `kismet_is_admin` | none |
| `kismet_admin_stats` | none |
| `kismet_admin_list_reports` | none |
| `kismet_admin_resolve_report` | `p_report_id`, `p_action` (`dismiss`/`warn`/`ban`), `p_note` |
| `kismet_admin_ban_user` | `p_user_id`, `p_reason`, `p_duration_minutes: null` |
| `kismet_admin_unban_user` | `p_user_id` |
| `kismet_admin_list_bans` | none |
| `kismet_admin_list_profiles` | `p_limit: 100` |

Every RPC independently re-checks `public.kismet_is_admin()` on the server, so the UI gate cannot be bypassed by calling the API directly. The public anon key in `redesign/supabase.js` is not a secret; this page uses no other credentials.
