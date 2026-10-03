#!/usr/bin/env node
'use strict';
// =====================================================================
// Live mode, account edge cases against the real supabase-js client:
// email confirmation and sending it again, duplicate emails (both ways
// Supabase answers), an address the email sender refuses, password
// recovery by link, an expired link, token refresh on reload, the repair
// of a missing profile row, and a handle taken while signing up. Run
// through run.sh.
// =====================================================================

const {
  BASE, launch, db, begin, check, eq, summary, openUser, screenshots,
  toast, gateText, waitApp, waitAuth, go, signInUI, signOutUI, withResponse,
} = require('./lib');

const C = { name: 'Cara Confirm', handle: 'cara_e2e', email: 'cara@confirm.test', password: 'first password 1' };
const NEW_PW = 'second password 2';

async function anonKey() { return (await (await fetch(BASE + '/__health')).json()).anonKey; }
// The emails the auth stand-in would have sent (test-only endpoint).
async function links(email) {
  const r = await fetch(`${BASE}/auth/v1/__test/links?email=${encodeURIComponent(email)}`, { headers: { apikey: await anonKey() } });
  return r.json();
}
const formMsg = page => page.evaluate(() => { const m = document.querySelector('#gate .form-msg'); return m && !m.hidden ? m.innerText : ''; });
const DUPLICATE = 'An account already uses that email. Sign in, or choose Forgot password.';
const resendVisible = page => page.locator('#gate [data-act="resend"]').isVisible();
async function fillSignUp(page, { name, handle, email, password }) {
  await page.click('#tab-signup');
  await page.fill('#su-name', name);
  await page.fill('#su-handle', handle);
  await page.locator('#su-handle-status', { hasText: 'Available' }).waitFor();
  await page.fill('#su-email', email);
  await page.fill('#su-password', password);
  await page.check('#su-age');
  await page.check('#su-terms');
}

async function main() {
  const browser = await launch();
  const users = [];
  let ok = false;
  try {
    const u = await openUser(browser, 'C'); users.push(u);
    const page = u.page;

    // ------------------------------------------------------------ confirmation
    begin('Sign-up that needs email confirmation');
    await waitAuth(page);
    await page.click('#tab-signup');
    await page.fill('#su-name', C.name);
    await page.fill('#su-handle', C.handle);
    await page.locator('#su-handle-status', { hasText: 'Available' }).waitFor();
    await page.fill('#su-email', C.email);
    await page.fill('#su-password', C.password);
    await page.check('#su-age');
    await page.check('#su-terms');
    await page.click('#gate [data-form="signup"] button:not([type])');
    await page.locator('#gate .form-msg', { hasText: 'Check your email to confirm your account, then sign in.' }).waitFor();
    check(true, 'no session: the app asks to confirm by email');
    eq(await page.inputValue('#auth-email'), C.email, 'sign-in form keeps the email');
    check(await resendVisible(page), 'a button sends the confirmation email again');
    C.id = await db.val('select id from auth.users where email = $1', [C.email]);
    eq(await db.val('select handle from public.profiles where id = $1', [C.id]), C.handle, 'profile exists before confirmation');
    const firstLink = (await links(C.email)).signup;
    await withResponse(page, r => r.url().includes('/auth/v1/resend'), () => page.click('#gate [data-act="resend"]'));
    await page.locator('#gate .form-msg', { hasText: 'we sent a new link' }).waitFor();
    check(true, 'sending it again confirms in plain words');
    const confirmLink = (await links(C.email)).signup;
    check(!!confirmLink && confirmLink !== firstLink, 'a new confirmation link was sent');
    await u.expect(/status of 400/, async () => {
      await signInUI(page, C.email, C.password);
      await page.locator('#gate .form-msg', { hasText: 'Confirm your email first.' }).waitFor();
    });
    check(true, 'signing in before confirming shows a plain message');
    check(await resendVisible(page), 'and offers to send the email again');
    check(!!confirmLink && confirmLink.includes('redirect_to=' + encodeURIComponent(BASE + '/')), 'confirmation link returns to the app (emailRedirectTo)');
    await page.goto(confirmLink);
    await waitApp(page);
    check((await page.textContent('#rail .me-name')).includes(C.name), 'the confirmation link signs you in');
    eq(await page.evaluate(() => document.activeElement && document.activeElement.id), 'view', 'keyboard focus moves into the app');
    check(!/access_token/.test(await page.evaluate(() => location.href)), 'tokens are cleared from the address bar');
    check((await db.val('select email_confirmed_at from auth.users where id = $1', [C.id])) != null, 'email_confirmed_at set');

    // ------------------------------------------------------------ duplicate email
    begin('Sign-up with an email that already has an account');
    await signOutUI(page);
    // With "Confirm email" on, Supabase answers 200 with a stand-in user that has no identities, and sends nothing.
    await fillSignUp(page, { name: 'Someone Else', handle: 'someone_else', email: C.email, password: 'whatever pass' });
    const dup = await withResponse(page, r => r.url().includes('/auth/v1/signup'), () => page.click('#gate [data-form="signup"] button:not([type])'));
    eq(dup.status(), 200, 'setup: Supabase answers a duplicate with 200 while Confirm email is on');
    await page.locator('#gate .form-msg', { hasText: DUPLICATE }).waitFor();
    check(!(await gateText(page)).includes('Check your email'), 'duplicate email says so, and does not promise an email');
    eq(await db.val(`select count(*)::int from public.profiles where handle = 'someone_else'`), 0, 'no second account was made');
    // With "Confirm email" off, Supabase answers 422.
    await fillSignUp(page, { name: 'Someone Else', handle: 'someone_else', email: 'kit@e2e.test', password: 'whatever pass' });
    await db.rows(`insert into auth.users (email, encrypted_password, email_confirmed_at) values ('kit@e2e.test', 'x', now())`);
    await u.expect(/status of 422/, async () => {
      await page.click('#gate [data-form="signup"] button:not([type])');
      await page.locator('#gate .form-msg', { hasText: DUPLICATE }).waitFor();
    });
    check(true, 'the 422 answer shows the same plain message');
    await db.rows(`delete from auth.users where email = 'kit@e2e.test'`);

    begin('An address the email sender will not write to');
    await page.click('#tab-signin');
    await page.route('**/auth/v1/signup*', route => route.fulfill({ status: 400, contentType: 'application/json',
      body: JSON.stringify({ code: 'email_address_not_authorized', message: 'Email address "friend@example.com" cannot be used as it is not authorized' }) }));
    await fillSignUp(page, { name: 'A Friend', handle: 'a_friend', email: 'friend@example.com', password: 'friend password 1' });
    await u.expect(/status of 400/, async () => {
      await page.click('#gate [data-form="signup"] button:not([type])');
      await page.locator('#gate .form-msg', { hasText: "We can't send email to that address yet." }).waitFor();
    });
    check(true, 'email_address_not_authorized gets a plain message, not "Something went wrong"');
    await page.unroute('**/auth/v1/signup*');
    await page.fill('#su-email', C.email);

    // ------------------------------------------------------------ recovery
    begin('Forgot password, then the recovery link');
    await page.click('#tab-signin');
    eq(await page.inputValue('#auth-email'), C.email, 'the email carries over from Create account');
    await page.fill('#auth-email', '');
    await page.click('#gate [data-act="forgot"]');
    eq(await formMsg(page), 'Enter your email above first, then choose Forgot password.', 'forgot password asks for the email first');
    await page.fill('#auth-email', C.email);
    await page.click('#gate [data-act="forgot"]');
    await page.locator('#gate .form-msg', { hasText: 'If an account uses that email, we sent it a link' }).waitFor();
    check(true, 'forgot password confirms without revealing whether the account exists');
    const recoveryLink = (await links(C.email)).recovery;
    check(!!recoveryLink, 'a recovery link was issued');
    await page.goto(recoveryLink);
    await page.waitForSelector('#gate [data-form="recover"]');
    check((await gateText(page)).includes('Set a new password'), 'the recovery link opens Set a new password');
    await page.fill('#rc-password', 'short');
    await page.click('#gate [data-form="recover"] button:not([type])');
    eq(await formMsg(page), 'Use at least 8 characters.', 'short password refused');
    await page.fill('#rc-password', NEW_PW);
    await page.click('#gate [data-form="recover"] button:not([type])');
    await toast(page, 'Password updated.');
    await waitApp(page);
    check(true, 'after saving, the app opens');
    await signOutUI(page);
    await u.expect(/status of 400/, async () => {
      await signInUI(page, C.email, C.password);
      await page.locator('#gate .form-msg', { hasText: "That email and password don't match." }).waitFor();
    });
    check(true, 'the old password no longer works');
    await signInUI(page, C.email, NEW_PW);
    await waitApp(page);
    check(true, 'the new password works');

    // ------------------------------------------------------------ expired link
    begin('An expired or used link');
    await signOutUI(page);
    await page.goto(recoveryLink); // Already used.
    await page.locator('#gate .form-msg', { hasText: 'That link expired or was already used.' }).waitFor();
    check(true, 'a used link shows a plain message on the sign-in screen');
    check(await resendVisible(page) && await page.locator('#gate [data-act="forgot"]').isVisible(), 'with both ways to get a new link');

    // ------------------------------------------------------------ token refresh
    begin('An expired session refreshes on reload');
    await signInUI(page, C.email, NEW_PW);
    await waitApp(page);
    const key = await page.evaluate(() => Object.keys(localStorage).find(k => /^sb-.+-auth-token$/.test(k)));
    check(!!key, 'supabase-js keeps the session in localStorage');
    await page.evaluate(k => { const s = JSON.parse(localStorage.getItem(k)); s.expires_at = Math.floor(Date.now() / 1000) - 60; localStorage.setItem(k, JSON.stringify(s)); }, key);
    const refreshed = page.waitForResponse(r => r.url().includes('/auth/v1/token?grant_type=refresh_token'), { timeout: 15000 });
    await page.reload();
    eq((await refreshed).status(), 200, 'reload refreshes the session with the refresh token');
    await waitApp(page);
    await go(page, 'feed');
    check((await page.textContent('#rail .me-name')).includes(C.name), 'the app boots on the refreshed session');

    // ------------------------------------------------------------ missing profile
    begin('A missing profile row is rebuilt at sign-in');
    await db.rows('delete from public.profiles where id = $1', [C.id]);
    await page.reload();
    await waitApp(page);
    const pr = await db.one('select handle, name from public.profiles where id = $1', [C.id]);
    eq(pr && [pr.handle, pr.name], [C.handle, C.name], 'touch_streak rebuilt the profile from the sign-up details');
    check(!(await gateText(page)).includes('Finish your profile'), 'no Finish your profile form needed');

    // ------------------------------------------------------------ publishable key
    begin('The new-style publishable key works (BACKEND.supabaseKey)');
    const k = await openUser(browser, 'K', { url: BASE + '/?key=publishable' }); users.push(k);
    await waitAuth(k.page);
    await k.page.click('#tab-signup');
    await k.page.fill('#su-name', 'Kit Key');
    await k.page.fill('#su-handle', 'kit_e2e');
    await k.page.locator('#su-handle-status', { hasText: 'Available' }).waitFor();
    check(true, 'signed-out handle check works with the publishable key');
    await k.page.fill('#su-email', 'kit@e2e.test');
    await k.page.fill('#su-password', 'kit password 1');
    await k.page.check('#su-age');
    await k.page.check('#su-terms');
    await k.page.click('#gate [data-form="signup"] button:not([type])');
    await waitApp(k.page);
    await k.page.fill('#composeText', 'Posted with a publishable key.');
    await k.page.click('#composeForm button:not([type])');
    await toast(k.page, 'Posted.');
    eq(await db.val(`select count(*)::int from public.posts p join public.profiles a on a.id = p.author_id where a.handle = 'kit_e2e'`), 1, 'sign-up and posting work with the publishable key');

    // ------------------------------------------------------------ switching accounts
    begin('Switching accounts in the same tab leaves nothing behind');
    await k.page.fill('#composeText', 'A draft Kit never posted.');
    await k.page.waitForTimeout(400); // The draft is saved to this browser after 300ms.
    await signOutUI(k.page);
    await signInUI(k.page, C.email, NEW_PW);
    await waitApp(k.page);
    await go(k.page, 'feed');
    check((await k.page.textContent('#rail .me-name')).includes(C.name), 'the rail shows the new account');
    eq(await k.page.inputValue('#composeText'), '', 'the previous account\'s draft is gone');
    await go(k.page, 'profile');
    const mine = await k.page.evaluate(() => [...document.querySelectorAll('#view > .feed .post-text')].map(e => e.innerText));
    check(!mine.includes('Posted with a publishable key.'), 'Your posts lists only the new account\'s posts');
    check((await k.page.textContent('#view .profile-card')).includes('@' + C.handle), 'Profile shows the new account');

    // ------------------------------------------------------------ handle taken meanwhile
    begin('A handle taken while signing up: the app says which one you got');
    const h = await openUser(browser, 'H'); users.push(h);
    await waitAuth(h.page);
    await fillSignUp(h.page, { name: 'Hana Late', handle: 'hana_e2e', email: 'hana@e2e.test', password: 'hana password 1' });
    await db.rows(`insert into auth.users (email, encrypted_password, email_confirmed_at, raw_user_meta_data)
                   values ('first.hana@e2e.test', 'x', now(), '{"handle":"hana_e2e"}')`); // Someone else gets there first.
    await h.page.click('#gate [data-form="signup"] button:not([type])');
    await waitApp(h.page);
    const got = await db.val(`select p.handle from public.profiles p join auth.users u using (id) where u.email = 'hana@e2e.test'`);
    check(/^user[0-9a-f]{8}$/.test(got), `the server gave a fallback handle (${got})`);
    await toast(h.page, `@hana_e2e was taken, so your handle is @${got}.`);
    check(true, 'the app says so, and where to change it');

    begin('No page errors');
    for (const x of users) eq(x.errors, [], `${x.label}: no page errors and no unexpected console errors`);
    ok = true;
  } catch (e) {
    check(false, 'stopped by an error: ' + (e && e.stack || e));
    await screenshots(users, 'auth');
    for (const x of users) if (x.errors.length) console.log(`   ${x.label} errors so far:\n     ` + x.errors.join('\n     '));
  } finally {
    await browser.close().catch(() => {});
    await db.end().catch(() => {});
  }
  process.exit(summary('auth.spec.js') && ok ? 0 : 1);
}

main();
