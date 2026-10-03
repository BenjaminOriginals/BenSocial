# BenSocial

**The social network with nothing to hide.** BenSocial for BenOS HTML is one file, `index.html`, with no build step.

## Two modes, one file

| Mode | When | What you get |
| --- | --- | --- |
| **Demo** | `BACKEND` in `index.html` is empty (the default) | A simulated network that runs entirely in the browser. Good for showing the idea. |
| **Live** | You paste your Supabase URL and publishable key into `BACKEND` | Real accounts, real posts and real people, stored in your own database. |

To go live, follow **[docs/GO-LIVE.md](docs/GO-LIVE.md)**. It takes about 30 minutes.

## What makes it different

- **Public algorithm.** Every post has "Why this?" with its full score. Under *Your algorithm* you set every ranking weight yourself.
- **Public dislikes.** Dislike counts show on every post.
- **Edit receipts.** Editing a post keeps every earlier version on a public receipt.
- **Clout Market.** Back posts early with clout and sell later. In live mode, prices follow real engagement and demand. Clout is earned only, and it can never be bought or cashed out.
- **Duels.** Two takes go head to head, and you see the split only after you vote. If your side wins, you get clout.
- **Streaks, XP, levels, badges and a daily drop.** In live mode the server keeps score, so nobody can fake it in the browser.

## Safety

Each person has a profile page. The ⋯ menu on any post or person lets you report, mute or block. Settings has the Community Guidelines, your blocked accounts and account deletion. Admins get a **Moderation** view for reports, removals, bans and creating duels.

## Monetization is parked

Ads and payments are fully built but switched off. At the very top of the script in `index.html`:

```js
const SWITCHES = {
  ads: false,       // Ads in the feed, attention price, ad earnings for users.
  payments: false,  // Money: wallet top-up, tips, cash-out, BenSocial Pro.
};
```

While a switch is `false`, nothing about that feature shows anywhere. Set it to `true` to turn it on. [docs/GO-LIVE.md](docs/GO-LIVE.md#the-monetization-switchboard) explains what each switch does, and what must exist before you flip one in live mode.

## Repository

| Path | What it is |
| --- | --- |
| `index.html` | The whole app: demo mode, live mode, the switchboard. |
| `supabase/schema.sql` | The database: tables, security rules and server functions. Paste it into Supabase once. |
| `supabase/seed.sql` | Optional starter duels and example ads. The ads are inactive. |
| `docs/GO-LIVE.md` | The owner's go-live checklist. |
| `tests/db/` | Database tests on a throwaway local PostgreSQL 16: `bash tests/db/run.sh` |
| `tests/e2e/` | Live-mode browser tests against a local Supabase stand-in: `bash tests/e2e/run.sh` (see its README). |
