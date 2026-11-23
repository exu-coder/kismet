# Kismet — deploy & backend reference

## Live
- Site: https://3565a0f0.kismet-k2f.pages.dev
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
│   └── 0001_initial_schema.sql     # all 8 tables, RLS policies, realtime publication
└── functions/
    └── matchmake/
        └── index.ts                # server-side matchmaking (v2)
```

Apply the schema to a fresh project:

```bash
supabase db push                       # or paste 0001_initial_schema.sql in the SQL editor
```

Deploy the Edge Function:

```bash
supabase functions deploy matchmake --no-verify-jwt
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase at runtime —
never commit them. The anon key is public by design; RLS is the only database barrier.

### Tables
`profiles`, `friends`, `friend_requests`, `messages`, `waiting_queue`,
`active_calls`, `match_queue`, `reports`.

### Realtime
`supabase_realtime` publication includes `active_calls`, `match_queue`, `waiting_queue`.
Signaling itself uses ephemeral broadcast channels (`signal_<callId>`) and the lobby
presence channel (`lobby`).

## Where the code lives
- **Website pages** — `index.html`, `chat/`, `inbox/`, `requests/`, `profile/`, plus
  `es/` and `pt/` localised landing pages.
- **Frontend app logic** — `redesign/*.js`. There is no SvelteKit source in this repo;
  `_app/immutable/` is pre-built static output kept for the landing page.
- **Backend** — `supabase/` (this document).

## Known open items
- RLS policies are intentionally `true` for all operations because user IDs are random
  `localStorage` values. Move to Supabase anonymous auth + `auth.uid()` checks.
- Reports are client-inserted into `reports` (no server validation, dedupe or IP rate limit).
- TURN uses Metered's open relay — replace with production credentials.
- No custom domain yet (Cloudflare `*.pages.dev` only).
