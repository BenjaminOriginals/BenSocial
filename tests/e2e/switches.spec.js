#!/usr/bin/env node
'use strict';
// =====================================================================
// Held monetization in live mode. In live mode the database decides
// alone: public.settings (ads_enabled, payments_enabled), read by the app
// through app_switches(). SWITCHES in index.html are for the demo only, so
// this spec signs up on a scratch copy with both of them flipped on and
// checks that it changes nothing.
//   * SWITCHES on, database off: nothing shows, nothing pays
//   * a tampered browser cache that says "on": one reload, then nothing,
//     and no error; and no reload loop when the reload can't fix it
//   * an admin turns ads on in Moderation -> Switchboard (two steps); the
//     other person's 30-second poll notes it without reloading their page,
//     and their next page load shows ads that pay once per day
//   * payments turned on in SQL: every money button says "Payments aren't
//     available yet."; the Switchboard shows payments with no button
//   * the admin turns ads off again: gone on the next load
// Run through run.sh.
// =====================================================================

const fs = require('fs');
const path = require('path');
const {
  BASE, launch, db, begin, check, eq, near, until, summary, openUser, addPage, screenshots,
  toast, viewText, waitApp, waitAuth, go, withResponse, rpcPath, tablePath, localDay, signUpUI, signInUI,
} = require('./lib');

const ROOT = process.env.E2E_ROOT || path.join(__dirname, '..', '..');
const SCRATCH = process.env.E2E_SCRATCH_DIR;
const PAY_MSG = "Payments aren't available yet.";
const SW_KEY = 'bensocial.live.switches';
const C = { name: 'Cleo Viewer', handle: 'cleo_e2e', email: 'cleo@e2e.test', password: 'cleo password 1' };
const M = { name: 'Mo Admin', handle: 'mo_admin_e2e', email: 'mo@e2e.test', password: 'mo password 123' };
const MONEY = [/¢/, /\$/, /Wallet/, /\bPro\b/, /\bTips?\b/, /Sponsored/, /attention/i, /Cash out/, /Patron/, /\bAds?\b/];

// A scratch copy of index.html with SWITCHES flipped, served at /scratch/<name>.html.
function variant(name, { ads = false, payments = false }) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  if (!html.includes('  ads: false,') || !html.includes('  payments: false,')) throw new Error('index.html switches are not in their committed (off) position');
  const out = html.replace('  ads: false,', `  ads: ${ads},`).replace('  payments: false,', `  payments: ${payments},`);
  fs.writeFileSync(path.join(SCRATCH, name + '.html'), out);
  return `${BASE}/scratch/${name}.html`;
}
const textOf = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); return e ? e.innerText : ''; }, sel);
const cacheOf = page => page.evaluate(k => localStorage.getItem(k), SW_KEY);
const toastsOf = page => page.evaluate(() => document.getElementById('toasts').innerText);
const adRequests = (u, from = 0) => u.requests.slice(from).filter(x => /\/rest\/v1\/(ads|ad_views)\b|record_ad_view/.test(x));
// Full page loads (a hash change is not one).
function countLoads(page) {
  const c = { n: 0 };
  page.on('domcontentloaded', () => { c.n++; });
  return c;
}
async function tokenOf(page) {
  return page.evaluate(() => { const k = Object.keys(localStorage).find(x => /^sb-.+-auth-token$/.test(x)); return JSON.parse(localStorage.getItem(k)).access_token; });
}
async function callRpc(fn, args, token) {
  const key = (await (await fetch(BASE + '/__health')).json()).anonKey;
  const r = await fetch(`${BASE}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: key, Authorization: 'Bearer ' + token },
    body: JSON.stringify(args),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const money = text => MONEY.filter(re => re.test(text)).map(String);

async function main() {
  if (!SCRATCH) throw new Error('E2E_SCRATCH_DIR is not set. Run this through run.sh.');
  const BOTH = variant('both', { ads: true, payments: true });
  const browser = await launch();
  const users = [];
  let ok = false;
  try {
    // ------------------------------------------------------------ setup
    begin('Setup: a poster with three posts, an admin, and one active ad row');
    const key = (await (await fetch(BASE + '/__health')).json()).anonKey;
    const signupApi = async (email, password, handle, name) => {
      const r = await fetch(BASE + '/auth/v1/signup', {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: key },
        body: JSON.stringify({ email, password, data: { handle, name } }),
      });
      return (await r.json()).user.id;
    };
    const danaId = await signupApi('dana@e2e.test', 'dana password 1', 'dana_e2e', 'Dana Poster');
    for (const body of ['First post from Dana.', 'Second post from Dana.', 'Third post from Dana.']) {
      await db.rows('insert into public.posts (author_id, body) values ($1, $2)', [danaId, body]);
    }
    M.id = await signupApi(M.email, M.password, M.handle, M.name);
    await db.rows('update public.profiles set is_admin = true where id = $1', [M.id]); // As the owner does in the SQL editor.
    eq(await db.val('select count(*)::int from public.ads where active'), 0, 'seed.sql ads are all held (inactive)');
    const adId = String(await db.val(`insert into public.ads (brand, hue, bid_cents, copy, why, active)
      values ('E2E Coffee', 30, 10.00, 'Coffee that tastes like coffee.', 'Broad campaign. No targeting.', true) returning id`));
    eq(await db.one('select ads_enabled, payments_enabled from public.settings'), { ads_enabled: false, payments_enabled: false },
       'both database switches start off');

    // ------------------------------------------------------------ SWITCHES are ignored in live mode
    begin('Live mode ignores SWITCHES: a copy with both on shows nothing while the database is off');
    const u = await openUser(browser, 'C', { url: BOTH }); users.push(u);
    const page = u.page;
    const loads = countLoads(page);
    await waitAuth(page);
    await signUpUI(page, C);
    C.id = await db.val('select id from auth.users where email = $1', [C.email]);
    await page.waitForSelector('#view .post');
    check(u.requests.some(x => /POST .*\/rest\/v1\/rpc\/app_switches/.test(x)), 'the app asks the database for the switches');
    eq(adRequests(u), [], 'the ads tables are never read');
    eq(await page.locator('#view [data-ad]').count(), 0, 'no ads, though SWITCHES.ads is true in this copy');
    eq(await page.locator('#view [data-act="pop"][data-arg="tip"]').count(), 0, 'no Tip buttons, though SWITCHES.payments is true');
    eq(await page.locator('[data-nav="wallet"]').count(), 0, 'no Wallet');
    eq(money(await page.evaluate(() => document.body.innerText)), [], 'no money copy anywhere on the page');
    eq(await cacheOf(page), null, 'nothing to remember: the browser had the switches right (off)');
    eq(loads.n, 0, 'no reload');
    C.token = await tokenOf(page);
    const direct = await callRpc('record_ad_view', { p_ad: Number(adId), p_today: localDay() }, C.token);
    eq([direct.status, direct.body && direct.body.message], [400, 'ads_off'], 'calling record_ad_view directly is refused with ads_off');
    near((await db.one('select earnings_cents from public.profiles where id = $1', [C.id])).earnings_cents, 0, 1e-9, 'no earnings');

    // ------------------------------------------------------------ tampered cache
    begin('A tampered cache says on, the server says off: one reload, no ads, no error');
    await page.evaluate(k => localStorage.setItem(k, '{"ads":true,"payments":true}'), SW_KEY);
    let mark = u.requests.length;
    loads.n = 0;
    await page.reload();
    await waitApp(page);
    await page.waitForSelector('#view .post');
    await page.waitForTimeout(400);
    eq(loads.n, 2, 'the app reloaded itself once to match the server');
    eq(await cacheOf(page), '{"ads":false,"payments":false}', 'the cache now holds the server switches');
    eq(await page.locator('#view [data-ad]').count(), 0, 'no ads');
    eq(await page.locator('#view [data-act="pop"][data-arg="tip"]').count(), 0, 'no Tip buttons');
    eq(await page.locator('[data-nav="wallet"]').count(), 0, 'no Wallet');
    eq(await toastsOf(page), '', 'no toast at all');
    eq(adRequests(u, mark), [], 'the ads tables were not read, even on the load that believed the cache');

    begin('If the reload cannot fix it, the app carries on quietly instead of looping');
    // As if this tab already reloaded once for these switches and the cache still did not hold.
    await page.evaluate(k => { localStorage.setItem(k, '{"ads":true,"payments":true}'); sessionStorage.setItem(k + '.reload', '{"ads":false,"payments":false}'); }, SW_KEY);
    mark = u.requests.length;
    loads.n = 0;
    await page.reload();
    await waitApp(page);
    await page.waitForSelector('#view .post');
    await page.mouse.wheel(0, 3000); await page.waitForTimeout(600);
    eq(loads.n, 1, 'no second reload');
    eq(await page.locator('#view [data-ad]').count(), 0, 'no ads while the server has them off');
    eq(adRequests(u, mark), [], 'no ads requests and no ad credits');
    eq(await toastsOf(page), '', 'no error toast');
    eq(await cacheOf(page), '{"ads":false,"payments":false}', 'the server switches are stored for the next load');
    loads.n = 0;
    await page.reload(); await waitApp(page); await page.waitForSelector('#view .post');
    eq(loads.n, 1, 'the next load needs no reload');
    eq(await page.locator('#view [data-act="pop"][data-arg="tip"]').count(), 0, 'and is fully back to off');
    const cReady = Date.now(); // C's 30-second poll runs from here.

    // ------------------------------------------------------------ the Switchboard
    begin('Admin: the Switchboard in Moderation');
    const um = await openUser(browser, 'M'); users.push(um);
    const mp = um.page;
    const mLoads = countLoads(mp);
    await waitAuth(mp);
    await signInUI(mp, M.email, M.password);
    await waitApp(mp);
    await go(mp, 'moderation');
    const ads = '#switchboardPanel [data-switch="ads"]', pay = '#switchboardPanel [data-switch="payments"]';
    await mp.locator(`${ads} .status.no`, { hasText: 'Off' }).waitFor();
    check((await textOf(mp, '#switchboardPanel')).includes('Switchboard'), 'the Switchboard panel is there');
    check((await textOf(mp, ads)).includes('Off: nobody sees an ad, and no ad pays.'), 'Ads row: off, with what that means');
    check(await mp.locator(`${pay} .status.no`, { hasText: 'Off' }).count() === 1 && (await textOf(mp, pay)).includes('Payments need a payment processor first. See docs/GO-LIVE.md.'),
          'Payments row: off, and points to docs/GO-LIVE.md');
    eq(await mp.locator(`${pay} button`).count(), 0, 'Payments row has no button');
    eq(await mp.locator(`${ads} [data-act="askSwitch"]`).innerText(), 'Turn ads on', 'Ads row has "Turn ads on"');

    begin('Admin: turning ads on takes two steps');
    await mp.click(`${ads} [data-act="askSwitch"]`);
    await mp.locator(`${ads} .confirm`).waitFor();
    const ask = await textOf(mp, `${ads} .confirm`);
    check(ask.includes('Turn ads on for everyone?') && ask.includes('1 active ad right now'), 'step one says what happens, with the active ad count');
    check(ask.includes('the next time they open BenSocial'), 'and when people get it');
    eq(await db.val('select ads_enabled from public.settings'), false, 'nothing changed after step one');
    await mp.click(`${ads} [data-act="cancelSwitch"]`);
    await mp.locator(`${ads} .confirm`).waitFor({ state: 'detached' });
    check(true, 'Cancel closes it');
    await mp.click(`${ads} [data-act="askSwitch"]`);
    await mp.locator(`${ads} .confirm`).waitFor();
    await mp.keyboard.press('Escape');
    await mp.locator(`${ads} .confirm`).waitFor({ state: 'detached' });
    check(true, 'Escape closes it too');
    eq(await db.val('select ads_enabled from public.settings'), false, 'still off');
    await mp.click(`${ads} [data-act="askSwitch"]`);
    mLoads.n = 0;
    const set = await withResponse(mp, rpcPath('mod_set_switch'), () => mp.click(`${ads} [data-act="setSwitch"]`));
    eq(set.status(), 200, 'step two calls mod_set_switch');
    await toast(mp, 'Ads are on.', 15000);
    eq(mLoads.n, 1, "the admin's page reloaded once so it runs with ads on");
    eq(await db.val('select ads_enabled from public.settings'), true, 'settings.ads_enabled is on');
    eq(await db.val('select payments_enabled from public.settings'), false, 'payments untouched');
    eq(await cacheOf(mp), '{"ads":true,"payments":false}', "the admin's browser remembers it");
    await mp.locator(`${ads} .status.ok`, { hasText: 'On' }).waitFor();
    check((await textOf(mp, ads)).includes('On: active ads show in feeds and pay people 70% of their bid.'), 'Ads row: on, with what that means');
    eq(await mp.locator(`${ads} [data-act="askSwitch"]`).innerText(), 'Turn ads off', 'the button now offers to turn ads off');
    check(await mp.evaluate(() => location.hash === '#moderation'), 'the admin is back on Moderation');

    begin("The other person's poll notes the change without reloading their page");
    await page.evaluate(() => { window.__stillHere = true; });
    loads.n = 0;
    console.log(`   waiting for C's 30-second poll (${Math.max(0, Math.round(30 - (Date.now() - cReady) / 1000))}s or less) ...`);
    await page.waitForFunction(k => localStorage.getItem(k) === '{"ads":true,"payments":false}', SW_KEY, { timeout: 45000 });
    check(true, "C's browser now remembers ads are on");
    eq(loads.n, 0, 'no reload');
    check(await page.evaluate(() => window.__stillHere === true), 'the page C is using was left alone');
    eq(await page.locator('#view [data-ad]').count(), 0, 'no ads pop into the open page');
    eq(await toastsOf(page), '', 'and nothing interrupts');

    // ------------------------------------------------------------ ads on
    begin('Next page load: ads from the ads table, paid once');
    mark = u.requests.length;
    await page.reload(); await waitApp(page);
    const ad = `#view [data-ad="${adId}"]`;
    await page.waitForSelector(ad);
    eq(loads.n, 1, 'ads show on the next load, with no extra reload');
    check(u.requests.slice(mark).some(x => /GET .*\/rest\/v1\/ads\?.*active=eq\.true/.test(x)), 'the app reads active ads from the ads table');
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
    const toastsBefore = await toastsOf(page);
    mark = u.requests.length;
    await u.expect(/status of 400/, async () => {
      const r = await withResponse(page, rpcPath('record_ad_view'), () => page.locator(tea).scrollIntoViewIfNeeded());
      eq(r.status(), 400, 'record_ad_view refuses the pulled ad');
      await page.locator(tea).waitFor({ state: 'detached' });
    });
    check(true, 'the pulled ad leaves the feed');
    await page.waitForTimeout(300);
    const toastsAfter = await toastsOf(page);
    check(!toastsAfter.includes("That isn't available anymore.") && !(toastsAfter.length > toastsBefore.length && /went wrong/.test(toastsAfter)),
          'no error toast for a pulled ad');
    await page.evaluate(() => window.scrollTo(0, 0)); await page.mouse.wheel(0, 2000); await page.waitForTimeout(300);
    eq(u.requests.slice(mark).filter(x => x.includes('/rpc/record_ad_view')).length, 1, 'and it is not retried');

    // ------------------------------------------------------------ payments on (SQL only)
    begin('Payments on in SQL: money buttons show the not-connected message');
    await db.rows('update public.settings set payments_enabled = true'); // The one SQL line in docs/GO-LIVE.md.
    loads.n = 0;
    await page.goto(BASE + '/'); // The committed index.html, with both SWITCHES off.
    await waitApp(page);
    await page.waitForSelector('#view .post [data-act="pop"][data-arg="tip"]');
    eq(loads.n, 2, 'the first load with payments on reloads once to follow the server');
    eq(await cacheOf(page), '{"ads":true,"payments":true}', 'the cache follows the server, not SWITCHES');
    await page.click('#view .post [data-act="pop"][data-arg="tip"]');
    await toast(page, PAY_MSG);
    check(true, 'Tip shows the message');
    check(!(await page.locator('#view .pop').count()), 'no tip popover opens');
    await go(page, 'wallet');
    const pw = await viewText(page);
    // The balance is the server's earnings_cents (7¢ from the ads step), never a demo amount.
    check(/balance/i.test(pw) && pw.includes('$0.07') && !pw.includes('$3.40'), 'Wallet balance is the server value, with no demo money');
    check(pw.includes('Earned from ads: $0.07'), 'Wallet shows the ad earnings too');
    check(pw.includes('Tips') && pw.includes('Ads'), 'Open books shows the Ads and Tips rows');
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
    near((await db.one('select earnings_cents from public.profiles where id = $1', [C.id])).earnings_cents, 7, 1e-9, 'no money moved');

    begin('Payments on: the Switchboard shows it, still with no button');
    await mp.click('#view [data-act="modRefresh"]');
    await mp.locator(`${pay} .status.ok`, { hasText: 'On' }).waitFor();
    check((await textOf(mp, pay)).includes("no payment processor is connected, so money buttons say payments aren't available yet"),
          'Payments row says no processor is connected');
    check((await textOf(mp, pay)).includes('See docs/GO-LIVE.md.'), 'and points to docs/GO-LIVE.md');
    eq(await mp.locator(`${pay} button`).count(), 0, 'Payments row has no button');
    const mTok = await tokenOf(mp);
    let r = await callRpc('mod_set_switch', { p_name: 'payments', p_on: false }, mTok);
    eq([r.status, r.body && r.body.message], [400, 'bad_switch'], 'mod_set_switch refuses payments, even for an admin');
    r = await callRpc('mod_set_switch', { p_name: 'ads', p_on: false }, C.token);
    eq([r.status, r.body && r.body.message], [400, 'not_admin'], 'mod_set_switch refuses members');
    eq(await db.one('select ads_enabled, payments_enabled from public.settings'), { ads_enabled: true, payments_enabled: true }, 'neither call changed anything');

    // ------------------------------------------------------------ ads off again
    begin('Admin turns ads off: gone on the next load');
    await mp.click(`${ads} [data-act="askSwitch"]`);
    await mp.locator(`${ads} .confirm`).waitFor();
    check((await textOf(mp, `${ads} .confirm`)).includes('Turn ads off for everyone?'), 'step one asks first');
    mLoads.n = 0;
    await withResponse(mp, rpcPath('mod_set_switch'), () => mp.click(`${ads} [data-act="setSwitch"]`));
    await toast(mp, 'Ads are off.', 15000);
    eq(mLoads.n, 1, "the admin's page reloaded once");
    eq(await db.one('select ads_enabled, payments_enabled from public.settings'), { ads_enabled: false, payments_enabled: true }, 'ads off, payments still on');
    await mp.locator(`${ads} .status.no`, { hasText: 'Off' }).waitFor();
    mark = u.requests.length;
    loads.n = 0;
    await go(page, 'feed');
    await page.reload(); await waitApp(page);
    await page.waitForSelector('#view .post [data-act="pop"][data-arg="tip"]');
    await page.waitForTimeout(400);
    eq(loads.n, 2, "C's next load reloads once to follow the server");
    eq(await page.locator('#view [data-ad]').count(), 0, 'no ads');
    eq(adRequests(u, mark), [], 'the ads tables are not read');
    eq(await toastsOf(page), '', 'no toast');
    r = await callRpc('record_ad_view', { p_ad: Number(adId), p_today: localDay() }, C.token);
    eq([r.status, r.body && r.body.message], [400, 'ads_off'], 'record_ad_view is refused again');
    near((await db.one('select earnings_cents from public.profiles where id = $1', [C.id])).earnings_cents, 7, 1e-9, 'earnings already made stay');

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
