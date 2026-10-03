# Live-mode end-to-end tests

These tests run the real `index.html` in Chromium against a local stand-in for a Supabase project. Nothing leaves your machine. The database is thrown away when the run ends.

```sh
tests/e2e/run.sh              # every spec (about a minute)
tests/e2e/run.sh live         # one spec: live, auth or switches
tests/e2e/run.sh serve        # start the stack and leave it running
```

The exit code is 0 only when every check passes.

## What you need

- PostgreSQL 16 server binaries in `/usr/lib/postgresql/16/bin` (or set `PGBIN`). The same ones `tests/db/run.sh` uses.
- Node.js 18 or newer, and npm. The first run installs `@supabase/supabase-js` 2.117.2 and `pg` into `tests/e2e/node_modules`.
- `curl`, `tar` with xz support, and `sha256sum`. On Linux x86_64 the first run downloads PostgREST v12.2.3 from GitHub into `tests/e2e/.bin/` and checks its SHA-256. Elsewhere, set `POSTGREST_BIN` to a PostgREST v12.2.3 binary.
- Playwright with Chromium. The specs try `require('playwright')`, then `/opt/node-tools/node_modules/playwright`. Set `PLAYWRIGHT_MODULE` to point somewhere else, and `CHROMIUM_PATH` to use a specific browser.

## What runs

`run.sh` starts three things and stops all of them on exit, pass or fail:

1. **PostgreSQL 16**, a throwaway cluster on a unix socket. It loads `tests/db/supabase_stubs.sql` (Supabase's roles, grants and `auth` schema), then `supabase/schema.sql` and `supabase/seed.sql`, as the `postgres` role, like the Supabase SQL editor.
2. **PostgREST v12.2.3**, connected as `authenticator`, with `anon` as the anonymous role and a JWT secret made fresh for each run.
3. **`gateway.js`**, one port that looks like a Supabase project with the app on it:

| Path | Serves |
| --- | --- |
| `/` | `index.html`, with a script that sets `window.BENSOCIAL_BACKEND` to this origin and the anon key, and `window.BENSOCIAL_SUPABASE_SRC` to `/vendor/supabase.js`. `/?key=publishable` passes an `sb_publishable_` key as `supabaseKey` instead. |
| `/scratch/<name>.html` | switch-flipped copies the specs write (see `switches.spec.js`) |
| `/vendor/supabase.js` | the npm build of supabase-js 2.117.2 |
| `/rest/v1/*` | PostgREST |
| `/auth/v1/*` | `auth-stub.js`, a small GoTrue stand-in |

Like Supabase, `/rest/v1` and `/auth/v1` need an `apikey` header, except `/auth/v1/verify`, which is the link in emails. The anon key is a JWT for role `anon`, signed with the same secret PostgREST checks. The gateway also accepts a new-style `sb_publishable_` key and swaps it for the anon JWT before PostgREST sees it, the way Supabase does.

### The auth stand-in

`auth-stub.js` keeps accounts in `auth.users`, so the sign-up trigger in `schema.sql` runs exactly as on Supabase. It handles sign-up, password sign-in, token refresh, `GET`/`PUT /user`, sign-out, password recovery and email links. Access tokens are HS256 JWTs with `sub`, `role`, `aud`, `email` and `exp`. Refresh tokens live in memory.

Two conventions exist only for tests:

- An email ending in `@confirm.test` must be confirmed first, like a project with "Confirm email" on. Sign-up returns no session.
- `GET /auth/v1/__test/links?email=...` returns the latest confirmation and recovery links for that address, since the stub sends no email.

## The specs

| Spec | Covers |
| --- | --- |
| `live.spec.js` | Two people (A and B) in separate browsers and an admin, with both switches off as committed. Sign-up with the handle check, sign-out and sign-in, posting with a mood, Latest, For you and Following, follow, person view, the algorithm dial saved to the profile, like, dislike and clear, repost, replies (also while replies are still loading), notifications with the unread badge and the new-post pill from the 30-second poll, edits and the receipt, backing and selling on the price curve, the daily drop and a refused second claim, a duel vote with the split and its settlement, a server-side level-up, reports, moderation (remove, restore, ban, unban, dismiss, mark actioned, create a duel), mute, block and unblock, profile edit, deleting a post, deleting an account, and a sweep for money copy and ads requests. |
| `auth.spec.js` | Email confirmation, a duplicate email, Forgot password and the recovery link, a used link, token refresh on reload, rebuilding a missing profile row, signing up and posting with a publishable key, and switching accounts in one tab. |
| `switches.spec.js` | Scratch copies with `SWITCHES.ads` and `SWITCHES.payments` flipped. Ads come from the `ads` table (active only) and `record_ad_view` pays once per ad per day. The attention price saves. With payments on, every money button shows "Payments aren't connected yet." |

Each step checks what the app shows and what landed in Postgres, which the specs query directly as the cluster superuser. Page errors always fail a spec. Console errors fail it too, unless the step expects a refused request.

## Options

| Variable | Default | Use |
| --- | --- | --- |
| `E2E_PG_PORT` | 54339 | PostgreSQL port (unix socket only) |
| `E2E_POSTGREST_PORT` | 54340 | PostgREST port on 127.0.0.1 |
| `E2E_GATEWAY_PORT` | 54341 | Gateway port on 127.0.0.1 |
| `POSTGREST_BIN` | `.bin/postgrest` | Use your own PostgREST v12.2.3 binary |
| `HEADED` | unset | Set to 1 to watch the browser |
| `VERBOSE` | unset | Set to 1 to print every passing check |

## When something fails

- The failing check is printed with what was expected and what came back.
- Screenshots of every open page go to `tests/e2e/.artifacts/`.
- The last lines of the PostgREST and gateway logs are printed.
- `run.sh serve` starts the same stack and prints the app URL and a `psql` command, so you can click through it yourself.
