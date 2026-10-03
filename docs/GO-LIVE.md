# Going live with BenSocial

BenSocial runs in two modes from the same `index.html`:

- **Demo mode** (default): everything is simulated in the browser. Good for showing people the idea.
- **Live mode**: real accounts, real posts, real people, stored in your own Supabase database.

Live mode turns on as soon as you paste two values into `index.html`. Nothing else in the code changes.

## What you need to do (about 30 minutes)

### 1. Create the database
1. Sign up at [supabase.com](https://supabase.com) and create a new project. Pick the region closest to
   your users. Save the database password somewhere safe.
2. In the project, open **SQL Editor → New query**, paste all of `supabase/schema.sql`, and press **Run**.
   It should finish with no errors.

### 2. Set up sign-in
In **Authentication → Sign In / Providers → Email**:
- Keep **Email** enabled and **Confirm email** on.

In **Authentication → URL Configuration**:
- **Site URL**: the address where BenSocial will live (step 4), for example `https://yourname.github.io/BenSocial/`.
- **Redirect URLs**: add the same address.

Supabase's built-in email sender is only meant for testing and sends very few emails per hour. Before
you invite real users, connect your own email provider under **Authentication → Emails → SMTP Settings**.

### 3. Connect the app
In Supabase, open **Project Settings → API Keys** and copy:
- the **Project URL** (also shown under **Project Settings → Data API**)
- the **Publishable key**. It starts with `sb_publishable_`. If you don't see one, click **Create new API keys**.

Paste them into the `BACKEND` block near the top of the script in `index.html`:

```js
const BACKEND = {
  supabaseUrl: 'https://YOUR-PROJECT.supabase.co',
  supabaseKey: 'sb_publishable_...',
};
```

The publishable key is meant to be public. The database rules decide what each user can see and change.
**Never** put the secret key (`sb_secret_...`) in the app. (Older projects also show a legacy `anon` key.
It works too, but Supabase is retiring it by the end of 2026.)

### 4. Put it online
Any static host with HTTPS works. The simplest is GitHub Pages:
1. Merge this branch into `main`.
2. On GitHub: **Settings → Pages → Build and deployment → Deploy from a branch → main / (root)**.
3. Your app appears at `https://<your-github-name>.github.io/BenSocial/` after a minute or two.

### 5. Make yourself the admin
1. Open your live app and create your account.
2. In Supabase **SQL Editor**, run (with your handle):
   ```sql
   update public.profiles set is_admin = true where handle = 'yourhandle';
   ```
3. Reload the app. A **Moderation** item appears in the menu, with reports and a "Create duel" form.
4. Optional: run `supabase/seed.sql` for a few starter duels.

### 6. Before you invite the public
These are things code can't do for you:
- **Terms of Service and Privacy Policy.** You are collecting emails and personal posts. Use a reputable
  generator or a lawyer, then link them from the app.
- **Minimum age.** Sign-up requires people to confirm they are 13 or older. Some countries set a higher
  age for consent. Decide your policy.
- **Moderation plan.** Decide who reviews reports and how quickly. Reports land in the Moderation view.
- **A contact address** for abuse and legal requests.
- **Backups.** Check what your Supabase plan includes.

## The monetization switchboard

At the very top of the script in `index.html`:

```js
const SWITCHES = {
  ads: false,
  payments: false,
};
```

Both are off. With a switch off, users see nothing of that feature anywhere.

| Switch | In demo mode | In live mode |
| --- | --- | --- |
| `ads` | Simulated ads appear in the feed and pay simulated cents. | Ads come from the `ads` table (only rows with `active = true`). Each view credits the user 70% of the bid as earnings in the database. |
| `payments` | Simulated tips, wallet top-ups, cash-out and Pro. | Buttons appear but say payments aren't connected yet. Real money needs a payment processor (below). |

### Before flipping `payments` in live mode
Real money needs work that only makes sense once you've decided on the business model:
- A Stripe account. Stripe Checkout handles Pro subscriptions and tips. Stripe Connect handles paying users.
- Server code (Supabase Edge Functions) for checkout and Stripe webhooks, with Stripe keys stored as
  Supabase secrets.
- Tax and payout reporting for users you pay.

Tell me when you're ready and I'll build it.

### Before flipping `ads` in live mode
- Add real ads to the `ads` table and set `active = true`.
- Users' earnings collect in the database. Paying them out needs `payments` too.

### One rule to keep
Clout must never be buyable with money or cashable for money. As long as it's earned-only, the Clout
Market is a game. If money goes in or out, it becomes gambling.
