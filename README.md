# Kismet

> Instant random video chat — no account, no downloads, actively moderated.

![Kismet preview](og.png)

**Live:** https://kissmeet.pages.dev
**Source:** https://github.com/exu-coder/kismet
**License:** [AGPL-3.0](LICENSE)

Kismet puts you face to face with one real person in seconds. Press one button, the
matcher finds whoever is free, and two cameras are pointed at two faces. No sign-up,
no profile, no history — just whoever is in front of you, right now.

## Features

- **One-press matching** — random pairing in seconds, with optional language, country
  and interest preferences.
- **Anonymous by default** — every browser gets a secure anonymous session; identity
  is only revealed during a live call, and only after both sides agree.
- **Friends & messenger-style inbox** — reveal to send a request, then see the
  person's display name and profile photo in requests, conversations and chat.
  Accepting a request opens the conversation immediately; updates are realtime.
- **Safety** — adults-only, one-press anonymous reporting, active moderation, banned
  users stop being matched. Revealed identity details are visible only to the people
  in that accepted friendship or pending request.
- **No sign-up** — no email, no password, no OAuth. Your anonymous session and
  optional display profile stay in the browser. Close the tab and the camera is off.
- **Browser-native** — works on Android, iPhone and desktop with no install.
- **Multilingual** — English, Spanish and Portuguese landing pages.

## Tech stack

- **Frontend:** static HTML/CSS/JS (SvelteKit pre-built output in `_app/`), no build step.
- **Backend:** Supabase (Postgres + RLS, Realtime, Edge Functions, Auth).
- **Hosting:** Cloudflare Pages (primary), InfinityFree package available.
- **Signaling:** WebRTC peer-to-peer via Supabase Realtime broadcast channels.

## Project layout

```
.
├── index.html, chat/, inbox/, requests/, profile/   # app pages
├── es/, pt/                                         # localized landing pages
├── redesign/                                        # frontend logic (supabase.js, videochat.js, …)
├── _app/                                            # pre-built SvelteKit assets
├── supabase/
│   ├── config.toml
│   ├── migrations/                                  # SQL schema + RLS + RPCs
│   └── functions/                                   # matchmake, session (Edge Functions)
├── tools/                                           # set-domain, generate-sitemap, package-infinityfree
├── docs/                                            # free-domain, infinityfree, is-a-dev
├── 404.html, robots.txt, sitemap.xml, og.png
└── LICENSE
```

## Local development

No build step. Serve the repo root with any static server:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

The backend (Supabase) is already configured; the anon key is public by design and
lives in `redesign/supabase.js`. RLS is the only database barrier.

## Backend setup (fresh Supabase project)

```bash
supabase db push                                  # apply migrations/
supabase functions deploy matchmake                # matchmaking (verify_jwt = true)
supabase functions deploy session --no-verify-jwt  # guest session fallback
```

Then enable **Authentication → Sign In / Providers → Anonymous sign-ins** in the
Supabase dashboard to retire the `session` fallback.

## Deploy

### Cloudflare Pages (recommended)

```bash
wrangler pages deploy . --project-name=kissmeet
```

The private moderator panel is a hidden path on the same Pages project:
`https://kissmeet.pages.dev/see.you.com/`. Its source is in `see.you.com/`.

See [docs/admin-panel.md](docs/admin-panel.md) for admin allowlist setup. It is
intentionally not linked from any public page.

### InfinityFree

```bash
node tools/package-infinityfree.mjs --site-url https://your-domain
# upload dist/kismet-infinityfree.zip (or dist/infinityfree/ contents) to htdocs
```

See [docs/infinityfree.md](docs/infinityfree.md) and [docs/free-domain.md](docs/free-domain.md).

### Move to a new domain

```bash
node tools/set-domain.mjs https://your-new-domain
node tools/generate-sitemap.mjs --site-url https://your-new-domain
```

## Security notes

- All tables use `auth.uid()::text = user_id` RLS; no table is world-readable.
- Matchmaking runs server-side via a service-role-only `kismet_matchmake` RPC.
- Signaling uses private ephemeral broadcast channels (`signal_<callId>`).
- `session_grants` is service-role-only and rate-limits guest session creation.

## Contributing

Pull requests welcome. Please keep changes consistent with the existing style and
run `node --check` on any edited JS file.

## License

Kismet is licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0).
See [LICENSE](LICENSE). Source: https://github.com/exu-coder/kismet
