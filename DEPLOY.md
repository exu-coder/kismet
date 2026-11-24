# Kismet — deploy & backend reference

## Live
- Site: https://kissmeet.pages.dev (preview URLs are `https://<hash>.kissmeet.pages.dev`)
- GitHub: https://github.com/exu-coder/kismet
- Supabase project ref: `xjckwcvwssuadqkxgumt` (ap-south-1)

## Deploy the website (Cloudflare Pages)
This is a static site — no build step. From the repo root:

```bash
wrangler pages deploy . --project-name=kismet
```

## Backend (Supabase)
All backend source lives in [`supabase/`](supabase/):

```
supabase/
├── config.toml
├── migrations/
│   ├── 0001_initial_schema.sql              # tables, base RLS, realtime
│   ├── 0002_secure_auth_and_realtime.sql    # auth.uid() RLS, private signaling, RPCs
│   ├── 0003_private_realtime_helper.sql     # Realtime helper outside public schema
│   ├── 0004_matchmaking_service_role_only.sql
│   ├── 0005_remove_duplicate_indexes.sql
│   ├── 0006_matchmaking_call_scoped_leave.sql
│   ├── 0007_realtime_social_tables.sql
│   └── 0008_session_grants.sql
└── functions/
    ├── matchmake/index.ts                   # server-side matchmaking (requires a JWT)
    └── session/index.ts                     # guest session fallback (verify_jwt = false)
```

Apply migrations to a fresh project:

```bash
supabase db push
```

Deploy the Edge Functions:

```bash
supabase functions deploy matchmake
supabase functions deploy session --no-verify-jwt
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected by
Supabase at runtime — never commit them. The anon key is public by design; RLS is the
only database barrier.

### Identity model
Kismet is anonymous-only. Every browser gets a real Supabase session, so all policies
use `auth.uid()::text = user_id` and no table is world-readable.

- Preferred: enable **Authentication → Sign In / Providers → Anonymous sign-ins**.
  The client calls `signInAnonymously()` and stops there.
- Fallback: when anonymous sign-ins are disabled, the `session` Edge Function creates a
  throwaway guest user with the service role and returns a normal session. It is
  rate-limited per IP (30/hour) and globally (1,000/day) via `session_grants`, and the
  guest's random `@kismet.invalid` email can never receive mail.
- Enabling the dashboard toggle is still recommended: it retires the fallback and uses
  Supabase's own abuse controls.

### Tables
`profiles`, `friends`, `friend_requests`, `messages`, `waiting_queue`,
`active_calls`, `match_queue`, `reports`, `session_grants`.

### Realtime
`supabase_realtime` publication includes `messages`, `friends`, `friend_requests`,
`active_calls`, `match_queue`, `waiting_queue`. Row events are filtered by RLS
per subscriber. Signaling uses private ephemeral broadcast channels
(`signal_<callId>`); the online counter uses the private `lobby` presence channel.

### Matchmaking
`matchmake` validates the caller's JWT, then calls the service-role-only
`kismet_matchmake(p_user_id, p_action, p_call_id)` transaction. `leave` is scoped to
the call id it was given, so a late leave cannot delete a newer queue row or unmatch a
newer call.

## Where the code lives
- **Website pages** — `index.html`, `chat/`, `inbox/`, `requests/`, `profile/`, plus
  `es/` and `pt/` localised landing pages.
- **Frontend app logic** — `redesign/*.js`. There is no SvelteKit source in this repo;
  `_app/immutable/` is pre-built static output kept for the landing page.
- **Backend** — `supabase/` (this document).

## Domain and alternative hosting tools
- `tools/set-domain.mjs <url>` rewrites every canonical/OG/hreflang URL plus
  `sitemap.xml` and `robots.txt` for a new host.
- `tools/generate-sitemap.mjs [--site-url <url>]` regenerates the sitemap and
  robots files only.
- `tools/package-infinityfree.mjs [--site-url <url>]` builds
  `dist/infinityfree/` and `dist/kismet-infinityfree.zip` for InfinityFree.
- See `docs/free-domain.md` for free domain options and `docs/infinityfree.md`
  for the InfinityFree upload steps.

## Known open items
- Anonymous sign-ins are currently disabled on the hosted project; the `session`
  fallback keeps the app working. Enable the dashboard toggle to retire it.
- Reports are client-inserted into `reports` (RLS-checked, but no server-side dedupe,
  rate limit or automatic ban pipeline yet).
- TURN uses Metered's open relay — replace with production credentials.
- No custom domain yet (Cloudflare `*.pages.dev` only). See `docs/free-domain.md`.
