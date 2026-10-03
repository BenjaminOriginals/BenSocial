#!/usr/bin/env node
'use strict';
// =====================================================================
// Held monetization in live mode. The committed index.html has both
// switches off (live.spec.js runs that). Here the gateway serves scratch
// copies with one switch flipped, the way the owner would flip it:
//   ads on       nothing shows or pays until public.settings.ads_enabled is
//                on too; then ads come from public.ads (active only),
//                record_ad_view credits 70% once per ad per day, the
//                attention price saves, and an ad pulled mid-session
//                disappears quietly
//   payments on  every money button shows "Payments aren't available yet."
// Run through run.sh.
// =====================================================================

const fs = require('fs');
const path = require('path');
const {
  BASE, launch, db, begin, check, eq, near, summary, openUser, addPage, screenshots,
  toast, viewText, waitApp, waitAuth, go, withResponse, rpcPath, tablePath, localDay, signUpUI,
} = require('./lib');

const ROOT = process.env.E2E_ROOT || path.join(__dirname, '..', '..');
const SCRATCH = process.env.E2E_SCRATCH_DIR;
const PAY_MSG = "Payments aren't available yet.";
const C = { name: 'Cleo Viewer', handle: 'cleo_e2e', email: 'cleo@e2e.test', password: 'cleo password 1' };

// A scratch copy of index.html with switches flipped, served at /scratch/<name>.html.
function variant(name, { ads = false, payments = false }) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  if (!html.includes('  ads: false,') || !html.includes('  payments: false,')) throw new Error('index.html switches are not in their committed (off) position');
  const out = html.replace('  ads: false,', `  ads: ${ads},`).replace('  payments: false,', `  payments: ${payments},`);
  fs.writeFileSync(path.join(SCRATCH, name + '.html'), out);
  return `${BASE}/scratch/${name}.html`;
}
const textOf = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); return e ? e.innerText : ''; }, sel);

async function main() {
  if (!SCRATCH) throw new Error('E2E_SCRATCH_DIR is not set. Run this through run.sh.');
  const ADS = variant('ads', { ads: true });
  const PAY = variant('payments', { payments: true });
  const BOTH = variant('both', { ads: true, payments: true });
  const browser = await launch();
  const users = [];
  let ok = false;
  try {
    // ------------------------------------------------------------ setup
    begin('Setup: another account with three posts, and one active ad row');
    const key = (await (await fetch(BASE + '/__health')).json()).anonKey;
    const r = await fetch(BASE + '/auth/v1/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: key },
      body: JSON.stringify({ email: 'dana@e2e.test', password: 'dana password 1', data: { handle: 'dana_e2e', name: 'Dana Poster' } }),
    });
    const danaId = (await r.json()).user.id;
    for (const body of ['First post from Dana.', 'Second post from Dana.', 'Third post from Dana.']) {
      await db.rows('insert into public.posts (author_id, body) values ($1, $2)', [danaId, body]);
    }
    eq(await db.val('select count(*)::int from public.ads where active'), 0, 'seed.sql ads are all held (inactive)');
    const adId = String(await db.val(`insert into public.ads (brand, hue, bid_cents, copy, why, active)
      values ('E2E Coffee', 30, 10.00, 'Coffee that tastes like coffee.', 'Broad campaign. No targeting.', true) returning id`));

    // ------------------------------------------------------------ server switch off
    begin('Ads on in the app but off on the server: nothing shows or pays');
    eq(await db.val('select ads_enabled from public.settings'), false, 'ads start off on the server');
    const u = await openUser(browser, 'C', { url: ADS }); users.push(u);
    let page = u.page;
    await waitAuth(page);
    await signUpUI(page, C);
    C.id = await db.val('select id from auth.users where email = $1', [C.email]);
    check(u.requests.some(x => /GET .*\/rest\/v1\/ads\?.*active=eq\.true/.test(x)), 'the app reads active ads from the ads table');
    await page.waitForSelector('#view .post');
    eq(await page.locator('#view [data-ad]').count(), 0, 'an active ad row shows nobody anything while the server switch is off');
    const token = await page.evaluate(() => { const k = Object.keys(localStorage).find(x => /^sb-.+-auth-token$/.test(x)); return JSON.parse(localStorage.getItem(k)).access_token; });
    const direct = await fetch(BASE + '/rest/v1/rpc/record_ad_view', {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: key, Authorization: 'Bearer ' + token },
      body: JSON.stringify({ p_ad: Number(adId), p_today: localDay() }),
    });
    const body = await direct.json();
    eq([direct.status, body.message], [400, 'ads_off'], 'calling record_ad_view directly is refused with ads_off');
    near((await db.one('select earnings_cents from public.profiles where id = $1', [C.id])).earnings_cents, 0, 1e-9, 'no earnings');

    // ------------------------------------------------------------ ads on
    begin('Ads on: ads load from the ads table and pay once');
    await db.rows('update public.settings set ads_enabled = true'); // How the owner turns ads on in the database.
    await page.reload(); await waitApp(page);
    const ad = `#view [data-ad="${adId}"]`;
    await page.waitForSelector(ad);
    check((await textOf(page, ad)).includes('Pays you 7.0¢'), 'ad card offers 70% of the 10¢ bid');
    check(!(await viewText(page)).includes('Pebble Bank'), 'held (inactive) ads never show');
    const credit = await withResponse(page, rpcPath('record_ad_view'), () => page.locator(ad).scrollIntoViewIfNeeded());
    eq(credit.status(), 200, 'record_ad_view called once the ad is in view');
    await toast(page, '+7.0¢ from E2E Coffee for your attention');
    await page.locator(`${ad} .ad-pay.paid`, { hasText: 'Paid you 7.0¢' }).waitFor();
    const views = await db.rows('select day, earned_cents from public.ad_views where user_id = $1', [C.id]);
    eq(views.map(v => [localDay(v.day), Number(v.earned_cents)]), [[localDay(), 7]], 'one ad_views row for today, 7¢');
    near((await db.one('select earnings_cents from public.profiles where id = $1', [C.id])).earnings_cents, 7, 1e-9, 'profiles.earnings_cents = 7');
    await page.reload(); await waitApp(page);
    await page.waitForSelector(ad);
    const again = await withResponse(page, rpcPath('record_ad_view'), () => page.locator(ad).scrollIntoViewIfNeeded());
    eq((await again.json()).earned_cents, 0, 'the same ad the same day earns 0');
    await page.locator(`${ad} .ad-pay`, { hasText: 'Already paid today' }).waitFor();
    eq(await db.val('select count(*)::int from public.ad_views where user_id = $1', [C.id]), 1, 'still one ad_views row');
    near((await db.one('select earnings_cents from public.profiles where id = $1', [C.id])).earnings_cents, 7, 1e-9, 'earnings unchanged after the repeat view');

    begin('Ads on: Wallet and attention price');
    await go(page, 'wallet');
    const w = await viewText(page);
    check(w.includes('$0.07'), 'Wallet shows the server ad earnings');
    check(w.includes('Ad view · E2E Coffee'), 'ledger lists the ad view');
    check(w.includes('Cash-out opens when payments turn on.'), 'no cash-out while payments are off');
    check(!w.includes('Add $5'), 'no Add funds while payments are off');
    await withResponse(page, tablePath('profiles', 'PATCH'), () => page.evaluate(() => {
      const r = document.getElementById('adPrice'); r.value = '12'; r.dispatchEvent(new Event('input', { bubbles: true }));
    }));
    eq(await db.val('select ad_price_cents from public.profiles where id = $1', [C.id]), 12, 'attention price saved to profiles.ad_price_cents');
    check((await textOf(page, '#bidRows')).includes('Below your price'), 'a 10¢ bid is now below the price');
    await go(page, 'feed');
    await page.waitForSelector('#view .post');
    eq(await page.locator('#view [data-ad]').count(), 0, 'ads below the price are not shown');
    await page.reload(); await waitApp(page);
    await go(page, 'wallet');
    eq(await page.inputValue('#adPrice'), '12', 'attention price comes back from the server');

    begin('Ads on: an ad pulled while someone has it on screen disappears quietly');
    const teaId = String(await db.val(`insert into public.ads (brand, hue, bid_cents, copy, why, active)
      values ('E2E Tea', 120, 15.00, 'Tea that tastes like tea.', 'Broad campaign. No targeting.', true) returning id`));
    await go(page, 'feed');
    await page.reload(); await waitApp(page);
    const tea = `#view [data-ad="${teaId}"]`;
    await page.waitForSelector(tea);
    await db.rows('update public.ads set active = false where id = $1', [teaId]); // The owner pulls it.
    const toastsBefore = await page.evaluate(() => document.getElementById('toasts').innerText);
    await u.expect(/status of 400/, async () => {
      const r = await withResponse(page, rpcPath('record_ad_view'), () => page.locator(tea).scrollIntoViewIfNeeded());
      eq(r.status(), 400, 'record_ad_view refuses the pulled ad');
      await page.locator(tea).waitFor({ state: 'detached' });
    });
    check(true, 'the pulled ad leaves the feed');
    await page.waitForTimeout(300);
    const toastsAfter = await page.evaluate(() => document.getElementById('toasts').innerText);
    check(!toastsAfter.includes("That isn't available anymore.") && !(toastsAfter.length > toastsBefore.length && /went wrong/.test(toastsAfter)),
          'no error toast for a pulled ad');
    await page.evaluate(() => window.scrollTo(0, 0)); await page.mouse.wheel(0, 2000); await page.waitForTimeout(300);
    eq(u.requests.filter(x => x.includes('/rpc/record_ad_view')).length, 3, 'and it is not retried');

    // ------------------------------------------------------------ payments on
    begin('Payments on: money buttons show the not-connected message');
    page = await addPage(u, PAY);
    await waitApp(page);
    const adRequests = u.requests.length;
    await go(page, 'feed');
    await page.waitForSelector('#view .post [data-act="pop"][data-arg="tip"]');
    await page.click('#view .post [data-act="pop"][data-arg="tip"]');
    await toast(page, PAY_MSG);
    check(true, 'Tip shows the message');
    check(!(await page.locator('#view .pop').count()), 'no tip popover opens');
    await go(page, 'wallet');
    const pw = await viewText(page);
    // The balance is the server's earnings_cents (7¢ from the ads step), never a demo amount.
    check(/balance/i.test(pw) && pw.includes('$0.07') && !pw.includes('$3.40'), 'Wallet balance is the server value, with no demo money');
    for (const act of ['addFunds', 'cashout']) {
      await page.click(`#view [data-act="${act}"]`);
      await toast(page, PAY_MSG);
      check(true, `${act} shows the message`);
    }
    await page.click('#rail [data-act="pro"]');
    await toast(page, PAY_MSG);
    check(await page.locator('#modal').isHidden(), 'Pro shows the message and opens nothing');
    await go(page, 'algo');
    check((await textOf(page, '#view [data-act="savePreset"]')).includes('Pro'), 'Save preset is a Pro perk while payments are on');
    await page.click('#view [data-act="savePreset"]');
    await toast(page, PAY_MSG);
    check(!u.requests.slice(adRequests).some(x => /\/rest\/v1\/(ads|ad_views)\b/.test(x)), 'payments-only never reads the ads tables');
    near((await db.one('select earnings_cents from public.profiles where id = $1', [C.id])).earnings_cents, 7, 1e-9, 'no money moved');

    // ------------------------------------------------------------ both on
    begin('Both on: Wallet shows the balance and ad earnings');
    page = await addPage(u, BOTH);
    await waitApp(page);
    await go(page, 'wallet');
    const bw = await viewText(page);
    check(/balance/i.test(bw) && bw.includes('Earned from ads: $0.07'), 'Wallet shows Balance and ad earnings');
    check(bw.includes('Tips') && bw.includes('Ads'), 'Open books shows the Ads and Tips rows');

    begin('No page errors');
    for (const x of users) eq(x.errors, [], `${x.label}: no page errors and no unexpected console errors`);
    ok = true;
  } catch (e) {
    check(false, 'stopped by an error: ' + (e && e.stack || e));
    await screenshots(users, 'switches');
    for (const x of users) if (x.errors.length) console.log(`   ${x.label} errors so far:\n     ` + x.errors.join('\n     '));
  } finally {
    await browser.close().catch(() => {});
    await db.end().catch(() => {});
  }
  process.exit(summary('switches.spec.js') && ok ? 0 : 1);
}

main();
