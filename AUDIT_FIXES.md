# Kismet source audit fixes

This branch contains a source-level hardening pass for the editable `redesign/` modules and their HTML entry points.

## Changes made

- Added a shared Supabase initialization promise, explicit SDK loading, guarded client access, and one shared anonymous-ID helper.
- Corrected script order on the inbox, requests, and profile pages so the SDK and shared client initialize before page modules.
- Removed unnecessary Supabase SDK initialization from the static landing pages.
- Changed inbox conversations to use the friend's `friend_id` (the other user's ID), not the friends-table row's primary key.
- Added a stable anonymous ID when the inbox or requests page is opened directly.
- Made friend acceptance retry-safe: friend links are upserted before the request is marked accepted, and status updates are scoped to the receiving user and pending state.
- Added clear failure handling for message loads/sends and friend-request operations.
- Compressed profile photos to a 512px WebP data URL before local persistence, added type/size validation, and persisted photo removal immediately.
- Replaced indefinite auth polling with the shared Supabase readiness promise and added account/profile sync error handling.
- Made matchmaking cancellable while camera permission is pending or queue polling is active; rejected non-success HTTP responses and incomplete match responses.
- Invalidated stale camera permission requests, stopped camera/microphone tracks on call end and page exit, and fixed rematch sequencing so teardown completes before a new search starts.
- Added guarded error handling around WebRTC offer/answer negotiation.
- Made report submission use the shared Supabase client, show progress, and remain retryable after failure.
- Escaped user-controlled profile, friend, request, and message text before legacy widget HTML interpolation.

## Important limitations requiring backend access

The repository tree does not include Supabase migrations/schema, RLS policy definitions, or the `matchmake` Edge Function source. These cannot be safely repaired by changing browser JavaScript alone.

Before production, verify or implement the following in Supabase:

1. **RLS on every exposed table.** The public anon key is expected to be visible in browser code; security must come from policies, not secrecy of the key.
2. **Friend request authorization.** A recipient must only accept/reject requests addressed to their own identity. A secure server-side RPC/Edge Function should create both friend rows and transition the request in one transaction.
3. **Message authorization.** Only the two participants in a conversation should be able to read or create its messages.
4. **Report privacy and enforcement.** Users should be allowed to submit a report for a real call, but not read reports or arbitrarily report unrelated users. Moderation/ban decisions must be server-side.
5. **Anonymous-to-account migration.** Existing anonymous friends/messages must not be reassigned to an authenticated account by client-side ID rewriting. Implement a verified server-side migration with ownership checks if account linking is required.
6. **Matchmaking cleanup.** Confirm the `matchmake` Edge Function removes the caller from every queue state on `action: leave`, expires stale entries, and cannot return the same participant twice.
7. **TURN credentials.** Replace shared/public demo TURN credentials with time-limited credentials issued by a trusted backend/provider. STUN-only fallback is not reliable across all NATs.

## Verification

No automated test runner, package manifest, database schema, or Edge Function source is included in this repository snapshot. These changes therefore require browser integration testing against the actual Supabase project.

Recommended smoke test:
- Open `/profile/`, upload/remove a photo, save, sign in/out, and refresh.
- Open `/requests/` directly in a fresh browser profile; verify an empty state rather than a silent no-op.
- Send a friend request from a second browser, accept it, and confirm both friend rows exist exactly once.
- Open `/inbox/` directly; verify the correct recipient ID is used and messages appear in both sessions.
- Start matchmaking, cancel during camera permission, cancel while queued, connect two browsers, press Next, then Stop.
- Verify camera and microphone indicators turn off after Stop/Next and after navigating away.
- Submit a report and verify it is stored once; simulate a network failure and retry.
- Test on mobile Safari/Chrome and desktop browsers, including restrictive NAT networks.
