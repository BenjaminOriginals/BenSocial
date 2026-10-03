# Demo and fake-client browser tests

These run the real `index.html` in Chromium straight from disk (`file://`). They need no database: demo mode runs entirely in the browser, and live mode talks to `fake-supabase.js`, an in-memory stand-in for supabase-js. For live mode against a real database, see `tests/e2e/`.

```sh
tests/demo/run.sh                   # every suite (about two minutes)
tests/demo/run.sh verify [filter]   # demo mode only; filter is a regex such as sweep|diff
tests/demo/run.sh live [suite]      # live mode with the fake client; suite is e.g. switchesOn
tests/demo/run.sh noclient          # demo mode never loads supabase-js
```

The exit code is 0 only when every check passes.

## What you need

- Node.js 18 or newer.
- Playwright with Chromium. The suites try `PLAYWRIGHT_MODULE`, then `require('playwright')`, then `/opt/node-tools/node_modules/playwright`. Set `CHROMIUM_PATH` to use a specific browser, and `HEADED=1` to watch it.
- git history: `verify.js` reads the first prototype with `git show a1e807c:index.html`.
- The supabase-js 2.117.2 build in `tests/e2e/node_modules`. `run.sh` installs it with `npm ci` if it is missing.

## The suites

| File | Covers |
| --- | --- |
| `verify.js` | Demo mode. Every view with both switches off on a computer and two phones, with no money or ad copy anywhere. A long simulated run, hash routing, profiles, menus, reports, blocks and other features. Both switches on, each switch alone, a text diff against the first prototype with both on, and a saved demo that follows the switches. |
| `live-smoke.js` | Live mode with the fake client. Sign-in and sign-up, boot and the shape of every request, no simulation, the 30-second poll, a client that fails to load, moderation, the real supabase-js build and its integrity hash, setup checks, and a sweep of every view for money and demo copy. The monetization switches: live mode ignores `SWITCHES` and follows the database (`app_switches()`), reloads once when they change, never loops, quietly ignores a tampered cache, and the admin Switchboard turns ads on in two steps. |
| `demo-noclient.js` | Demo mode makes no network request for supabase-js, shows no sign-in, and writes no live-mode storage. |
| `fake-supabase.js` | The stand-in client. Its `public.settings` survives a reload in the same browser, like a real database; a test changes it with `window.__fakeSettings({ ads_enabled: true })`. |
| `env.js` | Shared paths, the Playwright loader, and switch-flipped copies of `index.html`. |

Screenshots, the prototype from git and the switch-flipped copies go to `tests/demo/.out/`, which git ignores and `run.sh` empties first.
