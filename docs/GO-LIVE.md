# Going live with BenSocial

BenSocial runs in two modes from the same `index.html`:

- **Demo mode** (default): everything is simulated in the browser. Good for showing people the idea.
- **Live mode**: real accounts, real posts, real people, stored in your own Supabase database.

Live mode turns on as soon as you paste two values into `index.html`. Nothing else in the code changes.

## What you need to do (about 45 minutes)

### 1. Create the database
1. Sign up at [supabase.com](https://supabase.com) and create a new project. Pick the region closest to
   your users. Save the database password somewhere safe.
2. In the project, open **SQL Editor → New query**, paste all of `supabase/schema.sql`, and press **Run**.
   It should finish with no errors.

### 2. Set up sign-in
In **Authentication → Sign In / Providers → Email**:
- Keep **Email** enabled and **Confirm email** on.

In **Authentication → URL Configuration**:
- **Site URL**: the address where BenSocial will live (step 5), for example `https://yourname.github.io/BenSocial/`.
- **Redirect URLs**: add the same address.

### 3. Connect your own email sender
Do this before anyone but you signs up. Supabase's built-in email sender only writes to people on your
Supabase project's team, and only a few emails an hour. Everyone else who tries to sign up sees "We can't
send email to that address yet" and can't create an account or reset a password.

1. Create an account with an email provider that offers SMTP, for example Resend, Postmark, Amazon SES or
   SendGrid. Follow its steps to verify the domain you will send from, and create SMTP credentials.
2. In Supabase, open **Authentication → Emails → SMTP Settings**, turn on **Enable custom SMTP**, and fill in
   what your provider gave you: **Sender email**, **Sender name** (BenSocial), **Host**, **Port**,
   **Username** and **Password**. Press **Save**.
3. Open **Authentication → Rate Limits**. The limit on emails sent per hour starts low (about 30). Raise it
   before you announce the app, or a burst of sign-ups will be told "Too many tries".
4. Check it: sign up in the app (step 5) with an address that is not on your Supabase team. The
   confirmation email should arrive within a minute.

### 4. Connect the app
In Supabase, open **Project Settings → API Keys** and copy:
- the **Project URL** (also shown under **Project Settings → Data API**)
- the **Publishable key**. It starts with `sb_publishable_`. If you don't see one, click **Create new API keys**.

On GitHub, open `index.html` on this branch, click the pencil icon (**Edit this file**), and paste the two
values into the `BACKEND` block near the top of the script. Then click **Commit changes**.
(If you edit a copy on your own computer instead, commit and push it to this branch.)

```js
const BACKEND = {
  supabaseUrl: 'https://YOUR-PROJECT.supabase.co',
  supabaseKey: 'sb_publishable_...',
};
```

Paste the Project URL exactly as Supabase shows it, with nothing after `.supabase.co`.

The publishable key is meant to be public. The database rules decide what each user can see and change.
**Never** put the secret key (`sb_secret_...`) in the app. If you do, the app refuses to start and tells you.
(Older projects also show a legacy `anon` key. It works too, but Supabase is retiring it by the end of 2026.
Never use the legacy `service_role` key.)

### 5. Put it online
Any static host with HTTPS works. The simplest is GitHub Pages:
1. On GitHub, open **Pull requests → New pull request**. Choose `main` as the base and this branch to
   compare, click **Create pull request**, then **Merge pull request**.
2. On GitHub: **Settings → Pages → Build and deployment → Deploy from a branch → main / (root)**.
3. Your app appears at `https://<your-github-name>.github.io/BenSocial/` after a minute or two.

### 6. Make yourself the admin
1. Open your live app and create your account. Confirm it from the email.
2. In Supabase **SQL Editor**, run this with the email you signed up with:
   ```sql
   update public.profiles set is_admin = true
    where id = (select id from auth.users where email = 'you@example.com');
   ```
   It should say `UPDATE 1`. If it says `UPDATE 0`, check the spelling of the email.
3. Reload the app. A **Moderation** item appears: in the menu on the left on a computer, and under
   **Profile → Settings → Moderation** on a phone. It has the reports and a "Create duel" form.
4. Handles like `bensocial`, `admin`, `support` and `moderator`, and names that contain "BenSocial", are
   reserved: nobody can pick them in the app. To give yourself one, run (with your email):
   ```sql
   update public.profiles set handle = 'bensocial'
    where id = (select id from auth.users where email = 'you@example.com');
   ```
5. Optional: run `supabase/seed.sql` for a few starter duels.

### 7. Before you invite the public
These are things code can't do for you:
- **Terms of Service and Privacy Policy.** You are collecting emails and personal posts. Use a reputable
  generator or a lawyer, and put them online. Then paste their links into the `LEGAL` block at the top of
  the script in `index.html`, right below `BACKEND`, the same way as step 4:
  ```js
  const LEGAL = {
    termsUrl: 'https://example.com/terms',
    privacyUrl: 'https://example.com/privacy',
    contactEmail: 'help@example.com',
  };
  ```
  Sign-up then asks people to agree to your Terms, and Settings and the Community Guidelines link to both.
  Your privacy policy should mention one thing BenSocial does: when a banned person deletes their account,
  it keeps a one-way fingerprint (a hash) of their email and their handle, so the ban still applies if they
  sign up again.
- **Minimum age.** Sign-up requires people to confirm they are 13 or older. Some countries set a higher
  age for consent. Decide your policy.
- **Moderation plan.** Decide who reviews reports and how quickly. Reports land in the Moderation view.
- **A contact address** for abuse and legal requests: `contactEmail` in `LEGAL` (above).
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

In live mode the database has the same two switches, in `public.settings`: `ads_enabled` and
`payments_enabled`. Both start off. The switch in `index.html` decides what people see. The one in the
database decides what the server pays for, so nobody can collect ad money or Pro perks by calling the
database directly while a feature is parked.

| Switch | In demo mode | In live mode |
| --- | --- | --- |
| `ads` | Simulated ads appear in the feed and pay simulated cents. | Ads come from the `ads` table (only rows with `active = true`), and only while `ads_enabled` is on. Each ad pays a user 70% of its bid at most once a day, and only if the bid meets their attention price. The money collects as earnings in the database. |
| `payments` | Simulated tips, wallet top-ups, cash-out and Pro. | Buttons appear but say payments aren't available yet. Real money needs a payment processor (below). |

### Turning ads on in live mode
1. Add real ads to the `ads` table with `active = true`. Replace the example rows from `seed.sql`, which
   stay inactive.
2. Set `ads: true` in `SWITCHES` and publish it (steps 4 and 5). Nothing shows yet.
3. In **SQL Editor**, run `update public.settings set ads_enabled = true;`. Ads appear and start paying.

Users' earnings collect in the database. Paying them out needs `payments` too.

### Parking ads again
1. In **SQL Editor**, run `update public.settings set ads_enabled = false;`. This stops every ad and every
   payout at once.
2. Set `ads: false` in `SWITCHES` and publish it.

Always do step 1. The switch in `index.html` only hides ads in the app.

### Before flipping `payments` in live mode
Real money needs work that only makes sense once you've decided on the business model:
- A Stripe account. Stripe Checkout handles Pro subscriptions and tips. Stripe Connect handles paying users.
- Server code (Supabase Edge Functions) for checkout and Stripe webhooks, with Stripe keys stored as
  Supabase secrets.
- Tax and payout reporting for users you pay.

When that exists, run `update public.settings set payments_enabled = true;` as well. Until then the
database gives no Pro perks (like the doubled daily drop), even to an account marked Pro.

Tell me when you're ready and I'll build it.

### One rule to keep
Clout must never be buyable with money or cashable for money. As long as it's earned-only, the Clout
Market is a game. If money goes in or out, it becomes gambling.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| "BenSocial isn't set up correctly" | The message says what's wrong with `BACKEND` in `index.html`. Fix it as step 4 describes. If it says you used a secret or `service_role` key, also make a new one in Supabase: that key was public. |
| "BenSocial can't connect to its database" when signing in | The key doesn't belong to the project at `supabaseUrl`. Copy both values again (step 4). |
| "We can't send email to that address yet" | Supabase's built-in sender only writes to your team. Do step 3. |
| Nobody gets the confirmation email | Do step 3, then check the spam folder. The sign-in screen has "Send the confirmation email again". |
| "Too many tries. Wait a few minutes" on sign-up | The email limit was reached. Raise it in **Authentication → Rate Limits** (step 3). |
| A link in an email opens the wrong page or says it expired | Check **Site URL** and **Redirect URLs** (step 2). Links work once; ask for a new one. |
| No Moderation item | Check that the SQL in step 6 said `UPDATE 1`, then reload the app. |
| Ads don't show with `ads: true` | Check that the ad rows have `active = true` and that you ran step 3 of "Turning ads on". |
