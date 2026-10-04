'use strict';
// Demo mode, in Chromium: every view with the switches off (desktop and phone), a long simulated run, routing,
// features, the switches on (together and one at a time), a text diff against the first prototype, and review fixes.
// Run through run.sh, or: node tests/demo/verify.js [filter regex, e.g. sweep|diff]
const path = require('path');
const { SHOTS, OFF, launch, variant, original } = require('./env');

const ON = variant('switches-on', true, true);
const ADS_ONLY = variant('ads-only', true, false);
const PAY_ONLY = variant('payments-only', false, true);
const ORIGINAL = original(); // git show a1e807c:index.html

let pass = 0; const failures = []; const notes = [];
function check(cond, msg) { if (cond) pass++; else { failures.push(msg); console.log('  FAIL', msg); } }
const log = (...a) => console.log(...a);

const BANNED = [['¢', /¢/], ['$', /\$/], ['Wallet', /Wallet/], ['Pro', /\bPro\b/], ['PRO', /\bPRO\b/], ['Tip', /\bTips?\b/],
  ['Sponsored', /Sponsored/], ['attention', /attention/i], ['Cash out', /Cash out/], ['cash-out', /cash.?out/i],
  ['Patron', /Patron/], ['Paid to scroll', /Paid to scroll/], ['Ad/Ads word', /\bAds?\b/], ['dollar', /dollar/i]];
function leaks(text, list = BANNED) {
  return list.filter(([, re]) => re.test(text)).map(([n, re]) => { const m = text.match(new RegExp('.{0,50}' + re.source + '.{0,50}', re.flags)); return `${n}: "${m ? m[0].replace(/\n/g, ' | ') : ''}"`; });
}

let browser;
async function open(url, { width = 1360, height = 900, scheme = 'dark', mobile = false, clock = null, init = null, label = 'page' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(`${label} pageerror: ${e.message}`));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const where = (m.location() && m.location().url) || '';
    if (/fonts\.(googleapis|gstatic)\.com/.test(m.text() + ' ' + where)) return;
    errors.push(`${label} console: ${m.text()} @ ${where}`);
  });
  if (init) await page.addInitScript(init);
  if (clock) await page.clock.install(clock);
  await page.goto(url);
  await page.waitForSelector('#view > *');
  return { ctx, page, errors };
}
const state = async page => { await page.waitForTimeout(700); return page.evaluate(() => JSON.parse(localStorage.getItem('bensocial.v2'))); };
const bodyText = page => page.evaluate(() => document.body.innerText);
const ariaText = page => page.evaluate(() => [...document.querySelectorAll('[aria-label],[title],[placeholder]')].map(e => [e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('placeholder')].filter(Boolean).join(' ')).join('\n'));
const lastToast = page => page.evaluate(() => { const t = [...document.querySelectorAll('#toasts .toast')]; return t.length ? t[t.length - 1].innerText : ''; });
const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const h1 = page => page.evaluate(() => { const h = document.querySelector('#view h1'); return h ? h.textContent.trim() : ''; });
const active = page => page.evaluate(() => { const a = document.activeElement; return a ? (a.dataset.act ? `${a.dataset.act}|${a.dataset.id || ''}|${a.dataset.arg || ''}` : a.id || a.tagName) : ''; });
const menuItems = page => page.$$eval('#menu .menu-item', els => els.map(e => e.innerText.trim()));
async function nav(page, v, mobile) {
  if (!mobile) return page.click(`.rail [data-nav="${v}"]`);
  if (['feed', 'algo', 'market', 'duels', 'wallet'].includes(v)) return page.click(`.tabbar [data-nav="${v}"]`);
  return page.click(`.topbar [data-arg="${v}"]`);
}

/* ------------------------------------------------------------------ */
async function switchesOffSweep(opts, tag) {
  log(`\n== Switches OFF sweep: ${tag}`);
  const { ctx, page, errors } = await open(OFF, { ...opts, label: tag });
  const mobile = !!opts.mobile;
  let all = '', aria = '';
  const grab = async name => {
    all += `\n### ${name}\n` + await bodyText(page);
    aria += '\n' + await ariaText(page);
    if (mobile) { const o = await overflow(page); check(o <= 0, `${tag}: no horizontal overflow on ${name} (got ${o}px)`); }
  };
  await grab('feed foryou');
  for (const t of ['following', 'latest', 'foryou']) { await page.click(`[data-act="tab"][data-arg="${t}"]`); await grab('feed ' + t); }
  check(!(await page.$('[data-ad], .ad')), `${tag}: no ad cards in feed`);
  check(!(await page.$('[data-act="pop"][data-arg="tip"]')), `${tag}: no Tip buttons`);
  check(!(await page.$('.tips-line')), `${tag}: no tip lines`);
  check(!(await page.$('[data-post="p5"]')), `${tag}: seed post p5 not present`);
  check(!(await page.$(`[data-nav="wallet"]`)), `${tag}: no Wallet nav/tab`);
  check((await page.$eval('.welcome', e => e.innerText)).includes('Duels and the Clout Market'), `${tag}: welcome card shows Duels item`);
  check((await page.$eval('.welcome', e => e.innerText)).includes('Pick sides, back posts early, earn clout.'), `${tag}: welcome Duels copy`);
  if (mobile) check((await page.$$('.tabbar button')).length === 4, `${tag}: tabbar has 4 tabs`);
  else {
    const me = await page.$eval('.me-card .stat-pair', e => e.innerText);
    check(/Clout/.test(me) && /Followers/.test(me), `${tag}: me-card shows Clout + Followers (${me.replace(/\n/g, ' ')})`);
    check(!(await page.$('.rail-foot [data-act="pro"]')), `${tag}: no Try Pro rail link`);
    const foot = await page.$eval('#live', e => e.innerText);
    check(foot.includes('Demo mode: every account and post here is simulated'), `${tag}: live-rail demo footnote without ads/dollars`);
  }
  const tick = await page.$eval('#ticker', e => e.textContent);
  check(!/bids|Your price/.test(tick), `${tag}: ticker has no ad lines`);
  // post interactions that open panels
  await page.click('[data-post="p1"] [data-act="why"]'); await grab('why panel');
  await page.click('[data-post="p2"] [data-act="pop"][data-arg="back"]'); await grab('back pop');
  await page.click('[data-post="p1"] [data-act="reply"]'); await grab('thread');
  await page.click('[data-post="p1"] [data-act="menu"]'); await grab('post menu'); await page.keyboard.press('Escape');
  await page.click('[data-post="p1"] [data-act="menu"]'); await page.click('#menu [data-act="report"]'); await grab('report modal');
  await page.click('#modalBody [data-act="guidelines"]'); await grab('guidelines modal'); await page.keyboard.press('Escape');
  await page.click('[data-post="p1"] [data-act="menu"]'); await page.click('#menu [data-act="askBlock"]'); await grab('block modal'); await page.keyboard.press('Escape');
  for (const v of ['algo', 'market', 'duels', 'activity', 'profile']) {
    await nav(page, v, mobile); await page.waitForTimeout(80); await grab(v);
    if (v === 'algo') {
      const chip = await page.$eval('[data-act="savePreset"]', e => e.innerText.trim());
      check(chip === 'Save preset', `${tag}: Save preset chip has no Pro lock (got "${chip}")`);
      check(!(await page.$('[data-act="savePreset"] svg path[d^="M8 11V7"]')), `${tag}: Save preset chip has no lock icon`);
      await page.click('[data-act="savePreset"]');
      check($hidden(await page.$eval('#modal', e => e.hidden)), `${tag}: Save preset does not open Pro modal`);
      check((await lastToast(page)).includes('Saved'), `${tag}: Save preset works for free`);
      await grab('algo after preset');
    }
    if (v === 'market') {
      await page.click('.mrow [data-act="back"]'); await page.waitForTimeout(80); await grab('market with position');
      const sell = await page.$eval('[data-act="sell"]', e => e.innerText.trim());
      check(sell === 'Sell', `${tag}: market position button reads Sell (got "${sell}")`);
      await page.click('[data-act="sell"]'); await grab('market after sell');
    }
    if (v === 'duels') { await page.click('[data-act="vote"]'); await grab('duels voted'); }
    if (v === 'activity') {
      const first = await page.$eval('.notes li', e => e.innerText);
      check(first.includes('Tune your feed any time in Your algorithm'), `${tag}: welcome note has no attention-price copy`);
    }
    if (v === 'profile') {
      const badges = await page.$$eval('.badge-card b', els => els.map(e => e.textContent));
      check(badges.length === 6 && !badges.includes('Paid to scroll') && !badges.includes('Patron'), `${tag}: 6 badges, no Paid to scroll/Patron (${badges.join(', ')})`);
      check(!(await page.$('#view [data-act="pro"]')), `${tag}: no Pro settings row`);
      const stats = await page.$eval('.stats', e => e.innerText);
      check(!/Ad earnings/.test(stats) && /Posts/.test(stats), `${tag}: profile stats show Posts not Ad earnings`);
      await page.click('[data-act="editProfile"]'); await grab('profile editing'); await page.click('form[data-form="profile"] [data-act="editProfile"]');
    }
  }
  // person view
  await nav(page, 'feed', mobile);
  await page.click('[data-post="p2"] .post-head .name-btn');
  check((await h1(page)) === 'Maya Ortiz', `${tag}: person view opens from author name`);
  await grab('person maya');
  await page.click('#view [data-act="menu"]'); await grab('person menu'); await page.keyboard.press('Escape');
  await page.click('[data-act="goBack"]');
  // wait for sim ticks (real time) and capture again
  await page.waitForTimeout(7600);
  await grab('feed after ticks');
  if (mobile) {
    await page.screenshot({ path: path.join(SHOTS, `${tag}-feed.png`) });
  }
  const st = await state(page);
  check(!!st && st.v === 2, `${tag}: state saved under bensocial.v2`);
  check(await page.evaluate(() => localStorage.getItem('bensocial.v1') === null), `${tag}: nothing written to old bensocial.v1 key`);
  check(!st.posts.some(p => p.id === 'p5'), `${tag}: p5 not seeded`);
  const L = leaks(all), A = leaks(aria);
  check(!L.length, `${tag}: no monetization words in innerText across views. Leaks: ${L.join(' ;; ')}`);
  check(!A.length, `${tag}: no monetization words in aria-labels/placeholders. Leaks: ${A.join(' ;; ')}`);
  check(!errors.length, `${tag}: zero page/console errors ${errors.join(' | ')}`);
  notes.push(`${tag}: swept ${all.split('\n### ').length - 1} view states, ${all.length} chars of text`);
  await ctx.close();
}
const $hidden = v => v === true;

async function longRunOff() {
  log('\n== Switches OFF long run (fake clock, 150 sim ticks)');
  const { ctx, page, errors } = await open(OFF, { clock: {}, label: 'longrun' });
  await page.focus('#live [data-act="drop"]');
  await page.clock.runFor(3500 * 4);
  check(await page.evaluate(() => document.activeElement.matches('#live [data-act="drop"]')), 'longrun: keyboard focus survives live-rail re-renders');
  await page.clock.runFor(3500 * 150);
  let all = await bodyText(page);
  await page.click('.rail [data-nav="activity"]'); all += await bodyText(page);
  const nNotes = await page.$$eval('.notes li', e => e.length);
  check(nNotes >= 10, `longrun: activity has many simulated notes (${nNotes})`);
  await page.click('.rail [data-nav="feed"]');
  if (await page.$('[data-act="showNew"]')) { await page.click('[data-act="showNew"]'); }
  all += await bodyText(page);
  await page.click('.rail [data-nav="market"]'); all += await bodyText(page);
  await page.click('.rail [data-nav="duels"]'); all += await bodyText(page);
  all += await page.$eval('#ticker', e => e.textContent);
  const L = leaks(all);
  check(!L.length, `longrun: no monetization words after 150 ticks. Leaks: ${L.join(' ;; ')}`);
  check(!errors.length, `longrun: zero errors ${errors.join(' | ')}`);
  await ctx.close();
}

async function routing() {
  log('\n== Hash routing');
  let { ctx, page, errors } = await open(OFF + '#wallet', { label: 'route' });
  check((await h1(page)) === 'Home', 'route: #wallet on load falls back to feed');
  check((await page.evaluate(() => location.hash)) === '#feed', `route: hash rewritten to #feed (got ${await page.evaluate(() => location.hash)})`);
  await page.click('.rail [data-nav="algo"]');
  await page.evaluate(() => { location.hash = '#wallet'; });
  await page.waitForTimeout(150);
  check((await h1(page)) === 'Home', 'route: hashchange to #wallet falls back to feed');
  await page.evaluate(() => { location.hash = '#person:jun'; });
  await page.waitForTimeout(150);
  check((await h1(page)) === 'Jun Park', 'route: #person:jun opens person view');
  await page.reload(); await page.waitForSelector('#view > *');
  check((await h1(page)) === 'Jun Park', 'route: person view survives reload');
  await page.evaluate(() => { location.hash = '#person:constructor'; });
  await page.waitForTimeout(150);
  check((await h1(page)) === 'Home', 'route: prototype-key person hash falls back to feed');
  await page.evaluate(() => { location.hash = '#person:nobody'; });
  await page.waitForTimeout(150);
  check((await h1(page)) === 'Home', 'route: unknown person falls back to feed');
  await page.focus('.skip'); await page.keyboard.press('Enter'); await page.waitForTimeout(150);
  check((await h1(page)) === 'Home', 'route: skip link does not navigate away');
  check(!errors.length, `route: zero errors ${errors.join(' | ')}`);
  await ctx.close();
}

/* ------------------------------------------------------------------ */
async function features(opts, tag) {
  log(`\n== Features: ${tag}`);
  const { ctx, page, errors } = await open(OFF, { ...opts, label: tag });
  const mobile = !!opts.mobile;
  const shot = async n => page.screenshot({ path: path.join(SHOTS, `${tag}-${n}.png`) });

  // Person view from name, avatar, reply author, market row, duel side; own name -> profile
  await page.click('[data-post="p2"] .post-head .name-btn');
  check((await h1(page)) === 'Maya Ortiz', `${tag}: name opens person view`);
  const bio = await page.$eval('#view .bio', e => e.textContent);
  check(bio.includes('Furniture maker'), `${tag}: person bio shown`);
  const counts = await page.$eval('#view .follow-counts', e => e.innerText);
  check(/12K\s*followers/.test(counts) && /312\s*following/.test(counts), `${tag}: follower/following counts (${counts.replace(/\n/g, ' ')})`);
  check((await page.$eval('#view .person-tools [data-act="follow"]', e => e.textContent.trim())) === 'Following', `${tag}: Following state for followed user`);
  check((await page.$$('#view .feed [data-post]')).length === 1, `${tag}: person view lists their posts`);
  check((await page.evaluate(() => location.hash)) === '#person:maya', `${tag}: person hash`);
  await shot('person');
  await page.click('#view .person-tools [data-act="follow"]');
  check((await page.$eval('#view .person-tools [data-act="follow"]', e => e.textContent.trim())) === 'Follow', `${tag}: unfollow from person view`);
  check((await active(page)) === 'follow|maya|', `${tag}: focus stays on follow button after re-render (${await active(page)})`);
  await page.click('#view .person-tools [data-act="follow"]');
  check((await page.$eval('#view .person-tools [data-act="follow"]', e => e.getAttribute('aria-pressed'))) === 'true', `${tag}: follow again`);
  await page.click('[data-act="goBack"]');
  check((await h1(page)) === 'Home', `${tag}: Back returns to feed`);
  await page.click('[data-post="p3"] > .av');
  check((await h1(page)) === 'Jun Park', `${tag}: avatar opens person view`);
  await page.click('[data-act="goBack"]');
  await page.click('[data-post="p1"] [data-act="reply"]');
  await page.click('[data-post="p1"] [data-reply="p1-r0"] .name-btn');
  check((await h1(page)) === 'Theo Grant', `${tag}: reply author opens person view`);
  await page.click('[data-act="goBack"]');
  await nav(page, 'market', mobile);
  await page.click('.mrow .who .name-btn');
  check(['Sam Rivera', 'Maya Ortiz', 'Devon Achebe', 'Priya Nair', 'Kofi Mensah', 'Lena Vogel', 'Jun Park', 'Ana Lima', 'Rosa Kim', 'Theo Grant'].includes(await h1(page)), `${tag}: market row opens person view (${await h1(page)})`);
  await page.click('[data-act="goBack"]');
  check((await h1(page)) === 'Clout Market', `${tag}: Back returns to market`);
  await nav(page, 'duels', mobile);
  await page.click('button.side-who');
  check(['Priya Nair', 'Theo Grant', 'Devon Achebe'].includes(await h1(page)), `${tag}: duel side opens person view (${await h1(page)})`);
  await page.click('[data-act="goBack"]');
  check((await h1(page)) === 'Duels', `${tag}: Back returns to duels`);
  await nav(page, 'feed', mobile);

  // Post menu: keyboard + mouse
  const toggle = '[data-post="p1"] [data-act="menu"]';
  await page.click(toggle);
  check(JSON.stringify(await menuItems(page)) === JSON.stringify(['Report post', 'Mute @sam_takes', 'Block @sam_takes']), `${tag}: others' post menu items (${await menuItems(page)})`);
  check((await page.getAttribute(toggle, 'aria-expanded')) === 'true', `${tag}: aria-expanded true when open`);
  check((await active(page)) === 'report|post:p1|', `${tag}: focus moves to first menu item (${await active(page)})`);
  await page.keyboard.press('ArrowDown');
  check((await active(page)) === 'mute|sam|', `${tag}: ArrowDown moves focus`);
  await page.keyboard.press('End');
  check((await active(page)) === 'askBlock|sam|', `${tag}: End moves to last item`);
  await page.keyboard.press('ArrowDown');
  check((await active(page)) === 'report|post:p1|', `${tag}: ArrowDown wraps`);
  const rect = await page.$eval('#menu', e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, vw: document.documentElement.clientWidth }; });
  check(rect.l >= 0 && rect.r <= rect.vw, `${tag}: menu inside viewport (${JSON.stringify(rect)})`);
  if (mobile) check((await overflow(page)) <= 0, `${tag}: no overflow with menu open`);
  await shot('menu');
  await page.keyboard.press('Escape');
  check(await page.$eval('#menu', e => e.hidden), `${tag}: Escape closes menu`);
  check((await page.getAttribute(toggle, 'aria-expanded')) === 'false', `${tag}: aria-expanded false when closed`);
  check((await active(page)) === 'menu|post:p1|', `${tag}: focus returns to toggle`);
  await page.keyboard.press('Enter');
  check(!(await page.$eval('#menu', e => e.hidden)) && (await active(page)) === 'report|post:p1|', `${tag}: Enter on toggle opens menu with focus inside`);
  await page.keyboard.press('Tab');
  check(await page.$eval('#menu', e => e.hidden), `${tag}: Tab out closes menu`);
  await page.click(toggle);
  await page.click('#view h1');
  check(await page.$eval('#menu', e => e.hidden), `${tag}: outside click closes menu`);

  // Report post with guidelines round trip
  await page.click(toggle); await page.click('#menu [data-act="report"]');
  check(!(await page.$eval('#modal', e => e.hidden)), `${tag}: report modal opens`);
  check((await page.$eval('#modalBody h2', e => e.textContent)) === 'Report this post', `${tag}: report title`);
  const reasons = await page.$$eval('#modalBody .reason', els => els.map(e => e.innerText.trim()));
  check(JSON.stringify(reasons) === JSON.stringify(['Spam', 'Harassment or bullying', 'Hate speech', 'Violence or threats', 'Sexual content', 'Self-harm', 'False information', 'Something else']), `${tag}: 8 reasons in order (${reasons})`);
  check((await page.$eval('#reportDetails', e => e.maxLength)) === 500, `${tag}: details max 500`);
  await page.click('#modalBody button.btn:not(.ghost)');
  check(!(await page.$eval('#modal', e => e.hidden)), `${tag}: cannot submit without a reason`);
  await page.click('#modalBody .reason:nth-child(3)'); // legend is child 1, so this is Harassment
  await page.fill('#reportDetails', 'Repeated insults in the replies.');
  check((await page.$eval('#reportCount', e => e.textContent)) === '32/500', `${tag}: details counter (${await page.$eval('#reportCount', e => e.textContent)})`);
  if (mobile) { await shot('report'); check((await overflow(page)) <= 0, `${tag}: no overflow with report modal`); }
  await page.click('#modalBody [data-act="guidelines"]');
  check((await page.$eval('#modalBody h2', e => e.textContent)) === 'Community Guidelines', `${tag}: guidelines opens from report`);
  const rules = await page.$$eval('#modalBody .rules li', els => els.map(e => e.innerText));
  check(rules.length === 9 && rules.some(r => /minors/.test(r) && /Zero tolerance/.test(r) && /authorities/.test(r)), `${tag}: 9 rules incl. zero tolerance + authorities`);
  check(rules.some(r => /impersonation/i.test(r)) && rules.some(r => /Deleting is allowed/.test(r)) && rules.some(r => /ban accounts/.test(r)), `${tag}: impersonation, deleting, moderators rules`);
  if (mobile) await shot('guidelines');
  await page.click('#modalBody [data-act="report"][data-arg="resume"]');
  check((await page.$eval('#modalBody input[value="harassment"]', e => e.checked)) && (await page.$eval('#reportDetails', e => e.value)) === 'Repeated insults in the replies.', `${tag}: report draft restored after guidelines`);
  await page.click('#modalBody button.btn:not(.ghost)');
  check(await page.$eval('#modal', e => e.hidden), `${tag}: report modal closes on submit`);
  check((await lastToast(page)) === 'Thanks. A moderator will review it.', `${tag}: report toast (${await lastToast(page)})`);
  check((await active(page)) === 'menu|post:p1|', `${tag}: focus back on post menu toggle after report (${await active(page)})`);
  let st = await state(page);
  check(st.reports.length === 1 && st.reports[0].post_id === 'p1' && st.reports[0].reason === 'harassment' && st.reports[0].details === 'Repeated insults in the replies.', `${tag}: report stored locally ${JSON.stringify(st.reports[0])}`);

  // Report a reply (others) + delete own reply
  await page.click('[data-post="p1"] [data-reply="p1-r1"] [data-act="menu"]');
  check(JSON.stringify(await menuItems(page)) === '["Report reply"]', `${tag}: others' reply menu`);
  await page.click('#menu [data-act="report"]');
  check((await page.$eval('#modalBody h2', e => e.textContent)) === 'Report this reply', `${tag}: report reply title`);
  await page.click('#modalBody .reason:nth-child(2)');
  await page.click('#modalBody button.btn:not(.ghost)');
  st = await state(page);
  check(st.reports[0].reply_id === 'p1-r1' && st.reports[0].reason === 'spam', `${tag}: reply report stored ${JSON.stringify(st.reports[0])}`);
  const repliesBefore = await page.$eval('[data-b="replies:p1"]', e => e.textContent);
  await page.fill('#reply-p1', 'Testing a reply I will delete.');
  await page.press('#reply-p1', 'Enter');
  const myReply = await page.$eval('[data-post="p1"] .reply:last-of-type', e => e.dataset.reply);
  await page.click(`[data-reply="${myReply}"] [data-act="menu"]`);
  check(JSON.stringify(await menuItems(page)) === '["Delete reply"]', `${tag}: own reply menu`);
  await page.click('#menu [data-act="askDelete"]');
  check(!!(await page.$(`[data-reply="${myReply}"] .confirm`)), `${tag}: reply delete asks first`);
  check((await active(page)) === 'cancelDelete||', `${tag}: Cancel focused in reply confirm`);
  await page.click(`[data-reply="${myReply}"] [data-act="confirmDelete"]`);
  check(!(await page.$(`[data-reply="${myReply}"]`)), `${tag}: own reply deleted`);
  check((await page.$eval('[data-b="replies:p1"]', e => e.textContent)) === repliesBefore, `${tag}: reply count back to ${repliesBefore}`);
  check((await active(page)) === 'reply-p1', `${tag}: focus to reply input after delete`);

  // Mute via menu, with undo
  await page.click(toggle); await page.click('#menu [data-act="mute"]');
  check(!(await page.$('[data-post="p1"]')), `${tag}: muted author's post hidden`);
  check((await lastToast(page)).includes('Hid @sam_takes'), `${tag}: mute toast`);
  await page.click('#toasts .toast-act');
  check(!!(await page.$('[data-post="p1"]')), `${tag}: undo mute restores post`);

  // Block from post menu (followed user) -> modal -> confirm
  await page.click('[data-post="p2"] [data-act="menu"]'); await page.click('#menu [data-act="askBlock"]');
  check((await page.$eval('#modalBody h2', e => e.textContent)) === 'Block @maya.builds?', `${tag}: block modal title`);
  check((await page.$eval('#modalBody', e => e.innerText)).includes("You won't see each other's posts, and they can't follow you."), `${tag}: block modal copy`);
  if (mobile) await shot('block');
  await page.click('#modalBody [data-act="block"]');
  check(await page.$eval('#modal', e => e.hidden), `${tag}: block modal closes`);
  check(!(await page.$('[data-post="p2"]')), `${tag}: blocked user's posts hidden`);
  check((await lastToast(page)).includes('You blocked @maya.builds'), `${tag}: block toast`);
  st = await state(page);
  check(st.blocked.includes('maya') && !st.follows.includes('maya'), `${tag}: block stored and unfollowed (blocked ${JSON.stringify(st.blocked)} follows ${JSON.stringify(st.follows)})`);
  // Block from person view (theo) hides his replies
  await page.click('[data-post="p1"] [data-reply="p1-r0"] .name-btn');
  await page.click('#view .person-tools [data-act="menu"]');
  check(JSON.stringify(await menuItems(page)) === '["Mute @theo.money","Block @theo.money","Report @theo.money"]', `${tag}: person menu items (${await menuItems(page)})`);
  await page.click('#menu [data-act="askBlock"]'); await page.click('#modalBody [data-act="block"]');
  check((await page.$eval('#view', e => e.innerText)).includes('You blocked @theo.money'), `${tag}: person view shows blocked note`);
  check(!(await page.$('#view .feed')), `${tag}: no posts on blocked person view`);
  check(!!(await page.$('#view .person-tools [data-act="unblock"]')), `${tag}: Unblock on blocked person view`);
  await page.click('[data-act="goBack"]');
  if (!(await page.$('[data-post="p1"] .thread'))) await page.click('[data-post="p1"] [data-act="reply"]');
  check(!(await page.$eval('[data-post="p1"]', e => e.innerText)).includes('The kiosk has a family to feed.'), `${tag}: blocked user's reply hidden`);
  // Report a profile
  await page.click('[data-post="p3"] .name-btn');
  await page.click('#view .person-tools [data-act="menu"]'); await page.click('#menu [data-act="report"]');
  check((await page.$eval('#modalBody h2', e => e.textContent)) === 'Report @jun.codes', `${tag}: report profile title`);
  await page.keyboard.press('Escape');
  // Settings: blocked list + unblock
  await nav(page, 'profile', mobile);
  const blockedList = await page.$eval('.settings-sub', e => e.innerText);
  check(blockedList.includes('@maya.builds') && blockedList.includes('@theo.money'), `${tag}: blocked accounts listed in Settings`);
  if (mobile) { await page.$eval('.settings-sub', e => e.scrollIntoView()); await shot('settings'); }
  await page.click('.settings-sub [data-act="unblock"][data-id="maya"]');
  check(!(await page.$eval('.settings-sub', e => e.innerText)).includes('@maya.builds'), `${tag}: unblock removes from list`);
  check((await lastToast(page)).includes('Unblocked @maya.builds'), `${tag}: unblock toast`);
  await page.click('.settings-sub [data-act="unblock"][data-id="theo"]');
  check((await page.$eval('.settings-sub', e => e.innerText)).includes("You haven't blocked anyone"), `${tag}: empty blocked list copy`);
  await nav(page, 'feed', mobile);
  check(!!(await page.$('[data-post="p2"]')), `${tag}: unblocked user's posts return`);

  // Guidelines from settings, focus trap, Escape returns focus
  await nav(page, 'profile', mobile);
  await page.click('[data-act="guidelines"]');
  check((await page.$eval('#modalBody h2', e => e.textContent)) === 'Community Guidelines', `${tag}: guidelines from Settings`);
  let trapped = true;
  for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); trapped = trapped && await page.evaluate(() => document.querySelector('#modal .modal-card').contains(document.activeElement)); }
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Shift+Tab'); trapped = trapped && await page.evaluate(() => document.querySelector('#modal .modal-card').contains(document.activeElement)); }
  check(trapped, `${tag}: focus trapped in modal`);
  await page.keyboard.press('Escape');
  check((await active(page)) === 'guidelines||', `${tag}: focus returns to Read button (${await active(page)})`);

  // Bio + handle editing
  await page.click('[data-act="editProfile"]');
  check((await page.$eval('#pf-bio', e => e.maxLength)) === 160, `${tag}: bio max 160`);
  await page.fill('#pf-bio', 'Building things in public.');
  check((await page.$eval('#bioCount', e => e.textContent)) === '26/160', `${tag}: bio counter`);
  await page.fill('#pf-handle', 'ab');
  await page.click('form[data-form="profile"] button.btn:not(.ghost)');
  check((await lastToast(page)).includes('Handles are 3 to 20 characters'), `${tag}: short handle rejected`);
  await page.fill('#pf-handle', 'devon');
  await page.click('form[data-form="profile"] button.btn:not(.ghost)');
  check((await lastToast(page)).includes('That handle is taken'), `${tag}: taken handle rejected`);
  await page.fill('#pf-handle', 'Ben.Test');
  await page.fill('#pf-name', 'Ben Tester');
  if (mobile) await shot('edit-profile');
  await page.click('form[data-form="profile"] button.btn:not(.ghost)');
  check((await lastToast(page)) === 'Profile saved.', `${tag}: profile saved`);
  check((await page.$eval('#view .bio', e => e.textContent)) === 'Building things in public.', `${tag}: bio shown on profile`);
  check((await page.$eval('#view .profile-card', e => e.innerText)).includes('@ben.test'), `${tag}: handle lowercased`);
  st = await state(page);
  check(st.me.bio === 'Building things in public.' && st.me.handle === 'ben.test', `${tag}: bio/handle stored`);

  // Own post: menu, edit, delete with two-step confirm, refund
  await nav(page, 'feed', mobile);
  await page.fill('#composeText', 'Delete me later. Testing the menu.');
  await page.click('#composeForm button.btn');
  const mine = await page.getAttribute('[data-post^="m"]', 'data-post');
  await page.click(`[data-post="${mine}"] [data-act="menu"]`);
  check(JSON.stringify(await menuItems(page)) === '["Edit","Delete post"]', `${tag}: own post menu items`);
  check(!(await page.$(`[data-post="${mine}"] [data-act="follow"]`)), `${tag}: no follow button on own post`);
  await page.click('#menu [data-act="edit"]');
  await page.fill(`#edit-${mine}`, 'Delete me later. Edited in public.');
  await page.click(`[data-post="${mine}"] form button.btn:not(.ghost)`);
  check((await page.$$eval('#toasts .toast', els => els.some(e => e.innerText.includes('Edit saved')))), `${tag}: edit via menu`);
  check(!!(await page.$(`[data-post="${mine}"] [data-act="receipts"]`)), `${tag}: receipt link after edit`);
  check((await active(page)) === `menu|post:${mine}|`, `${tag}: focus back on menu toggle after edit`);
  await page.click(`[data-post="${mine}"] .name-btn`);
  check((await page.evaluate(() => location.hash)) === '#profile', `${tag}: own name goes to Profile`);
  await nav(page, 'feed', mobile);
  await page.click(`[data-post="${mine}"] [data-act="menu"]`); await page.click('#menu [data-act="askDelete"]');
  check(!!(await page.$(`[data-post="${mine}"] .confirm`)), `${tag}: delete asks in-page first`);
  check((await page.$eval(`[data-post="${mine}"] .confirm`, e => e.innerText)).includes('Delete this post?'), `${tag}: confirm copy`);
  check((await active(page)) === 'cancelDelete||', `${tag}: Cancel focused`);
  if (mobile) await shot('delete-confirm');
  await page.keyboard.press('Escape');
  check(!(await page.$(`[data-post="${mine}"] .confirm`)) && !!(await page.$(`[data-post="${mine}"]`)), `${tag}: Escape cancels delete`);
  check((await active(page)) === `menu|post:${mine}|`, `${tag}: focus back to toggle after cancel`);
  // back it so delete refunds
  const cloutBefore = (await state(page)).me.clout;
  await page.click(`[data-post="${mine}"] [data-act="pop"][data-arg="back"]`);
  await page.click(`[data-post="${mine}"] [data-act="back"][data-arg="25"]`);
  await page.click(`[data-post="${mine}"] [data-act="menu"]`); await page.click('#menu [data-act="askDelete"]');
  await page.click(`[data-post="${mine}"] [data-act="confirmDelete"]`);
  check(!(await page.$(`[data-post="${mine}"]`)), `${tag}: post deleted`);
  check((await lastToast(page)).includes('Post deleted. Your 25 clout came back to you.'), `${tag}: delete toast mentions refund (${await lastToast(page)})`);
  st = await state(page);
  check(!st.posts.some(p => p.id === mine) && !st.holdings[mine], `${tag}: deleted from state and holdings cleared`);
  check(Math.abs(st.me.clout - cloutBefore) < 60, `${tag}: clout refunded (before ${cloutBefore}, after ${st.me.clout})`);

  if (mobile) {
    for (const v of ['feed', 'algo', 'market', 'duels', 'activity', 'profile']) { await nav(page, v, true); check((await overflow(page)) <= 0, `${tag}: no overflow ${v}`); }
    await nav(page, 'feed', true); await page.click('[data-post="p6"] .name-btn'); check((await overflow(page)) <= 0, `${tag}: no overflow person`);
    await page.click('#view .person-tools [data-act="menu"]'); check((await overflow(page)) <= 0, `${tag}: no overflow person menu`);
    await shot('person-menu');
  }
  check(!errors.length, `${tag}: zero page/console errors ${errors.join(' | ')}`);
  await ctx.close();
}

/* ------------------------------------------------------------------ */
async function switchesOn(opts, tag) {
  log(`\n== Switches ON: ${tag}`);
  const { ctx, page, errors } = await open(ON, { ...opts, label: tag });
  const mobile = !!opts.mobile;
  if (mobile) check((await page.$$('.tabbar button')).length === 5, `${tag}: tabbar has 5 tabs incl. Wallet`);
  else {
    check(!!(await page.$('.rail [data-nav="wallet"]')), `${tag}: Wallet nav`);
    check((await page.$eval('.me-card .stat-pair', e => e.innerText)).includes('Wallet'), `${tag}: me-card shows Wallet`);
    check(!!(await page.$('.rail-foot [data-act="pro"]')), `${tag}: Try Pro rail link`);
    check((await page.$eval('#live', e => e.innerText)).includes('every account, post, ad and dollar'), `${tag}: original demo footnote`);
  }
  check(/bids .*per view/.test(await page.$eval('#ticker', e => e.textContent)), `${tag}: ticker ad lines`);
  check((await page.$eval('.welcome', e => e.innerText)).includes('You get paid for ads'), `${tag}: welcome ads item`);
  await page.click('[data-act="tab"][data-arg="latest"]');
  check(!!(await page.$('[data-post="p5"]')), `${tag}: p5 seeded`);
  await page.click('[data-act="tab"][data-arg="foryou"]');
  check((await page.$$('[data-ad]')).length >= 2, `${tag}: ads in feed`);
  check(!!(await page.$('.tips-line')), `${tag}: tip lines`);
  // ad credit
  const ad = await page.$('[data-ad]');
  await ad.scrollIntoViewIfNeeded(); await page.waitForTimeout(500);
  check(!!(await page.$('[data-ad] .ad-pay.paid')), `${tag}: ad marked paid when seen`);
  const ts = await page.$$eval('#toasts .toast', els => els.map(e => e.innerText).join(' | '));
  check(/\+\d+(\.\d)?¢ from .* for your attention/.test(ts), `${tag}: ad credit toast (${ts})`);
  check(/Badge unlocked: Paid to scroll/.test(ts), `${tag}: Paid to scroll badge unlocks`);
  let st = await state(page);
  check(st.me.earned > 0 && st.ledger.some(l => /^Ad view/.test(l.label)), `${tag}: earnings + ledger credited`);
  // tip
  await page.click('[data-post="p1"] [data-act="pop"][data-arg="tip"]');
  check((await page.$eval('[data-post="p1"] .pop', e => e.innerText)).includes('gets $0.92'), `${tag}: tip popover`);
  await page.click('[data-post="p1"] [data-act="tip"][data-arg="100"]');
  check((await lastToast(page)).includes('Sent $1.00 to Sam Rivera. They get $0.92.') || (await page.$$eval('#toasts .toast', els => els.some(e => e.innerText.includes('Sent $1.00 to Sam Rivera')))), `${tag}: tip sent`);
  check((await page.$eval('[data-post="p1"] .tips-line', e => e.textContent)).includes('from 23 people'), `${tag}: tip line updated`);
  // Pro gating of presets, then Pro modal
  await nav(page, 'algo', mobile);
  check((await page.$eval('[data-act="savePreset"]', e => e.innerText.trim())) === 'Save preset · Pro', `${tag}: Save preset is Pro-locked`);
  await page.click('[data-act="savePreset"]');
  check((await page.$eval('#modalBody h2', e => e.textContent)) === 'More clout. Keep every tip.', `${tag}: Pro modal from preset lock`);
  check((await page.$eval('#modalBody h2', e => getComputedStyle(e).fontSize)) === '28px', `${tag}: Pro modal heading keeps its 28px size`);
  await page.click('[data-act="startPro"]');
  check((await lastToast(page)).includes('Pro is on'), `${tag}: Pro started`);
  check((await page.$eval('[data-act="savePreset"]', e => e.innerText.trim())) === 'Save preset', `${tag}: preset unlocked with Pro`);
  if (!mobile) check((await page.$eval('.me-card', e => e.innerText)).includes('PRO'), `${tag}: PRO tag in me-card`);
  await nav(page, 'profile', mobile);
  check((await page.$eval('.profile-name', e => e.innerText)).includes('PRO'), `${tag}: PRO tag on profile`);
  await page.click('#view [data-act="pro"]');
  check((await page.$eval('#modalBody h2', e => e.textContent)) === "You're on Pro", `${tag}: manage Pro`);
  await page.click('[data-act="cancelPro"]');
  check((await lastToast(page)).includes('Pro canceled'), `${tag}: Pro canceled`);
  check((await page.$$eval('.badge-card b', els => els.map(e => e.textContent))).length === 8, `${tag}: all 8 badges`);
  // wallet
  await nav(page, 'wallet', mobile);
  check((await h1(page)) === 'Wallet', `${tag}: wallet view`);
  const w = await page.$eval('#view', e => e.innerText);
  check(/Balance · demo money/i.test(w) && w.includes('Earned from ads') && w.includes('Your attention price'), `${tag}: wallet panels`);
  check(['Ads', 'Tips', 'Pro', 'Your data'].every(b => w.includes(b)), `${tag}: open books rows`);
  const bal = await page.$eval('.big-num', e => e.textContent);
  await page.click('[data-act="addFunds"]');
  const bal2 = await page.$eval('.big-num', e => e.textContent);
  check(Math.round((parseFloat(bal2.slice(1)) - parseFloat(bal.slice(1))) * 100) === 500, `${tag}: Add $5 (${bal} -> ${bal2})`);
  await page.click('[data-act="cashout"]');
  check(/Demo mode: no real money moves|Cash-out opens at/.test(await lastToast(page)), `${tag}: cash out toast`);
  await page.fill('#adPrice', '10');
  check((await page.$eval('#priceOut', e => e.textContent)) === '10¢', `${tag}: attention price slider`);
  const ledger = await page.$eval('.ledger', e => e.innerText);
  check(/Ad view/.test(ledger) && /Tip to @sam_takes/.test(ledger) && /Added funds/.test(ledger) && /Starter balance/.test(ledger), `${tag}: ledger lines`);
  // market keeps "Cash out" wording
  await nav(page, 'market', mobile);
  await page.click('.mrow [data-act="back"]');
  check((await page.$eval('[data-act="sell"]', e => e.innerText.trim())) === 'Cash out', `${tag}: market Cash out wording when payments on`);
  await nav(page, 'activity', mobile);
  check((await page.$eval('#view', e => e.innerText)).includes('Your attention price is set to 4¢'), `${tag}: ads welcome note`);
  if (mobile) { for (const v of ['feed', 'wallet']) { await nav(page, v, true); check((await overflow(page)) <= 0, `${tag}: no overflow ${v}`); } await page.screenshot({ path: path.join(SHOTS, `${tag}-wallet.png`) }); }
  check(!errors.length, `${tag}: zero errors ${errors.join(' | ')}`);
  await ctx.close();
  // direct #wallet route works when on
  const r = await open(ON + '#wallet', { label: tag + '-route' });
  check((await h1(r.page)) === 'Wallet', `${tag}: #wallet loads wallet when on`);
  await r.ctx.close();
}

async function singleSwitch() {
  log('\n== Single switches');
  let { ctx, page, errors } = await open(ADS_ONLY, { label: 'ads-only' });
  check(!!(await page.$('[data-ad]')) && !(await page.$('[data-arg="tip"]')) && !(await page.$('.tips-line')), 'ads-only: ads yes, tips no');
  await page.click('.rail [data-nav="wallet"]');
  let w = await page.$eval('#view', e => e.innerText);
  check(/Ad earnings · demo money/i.test(w) && w.includes('Cash-out opens when payments turn on.') && !(await page.$('[data-act="addFunds"], [data-act="cashout"]')), 'ads-only: wallet shows earnings + held cash-out text');
  check(w.includes('Your attention price') && /\bAds\b/.test(w) && !/\bTips\b|\bPro\b/.test(w), 'ads-only: attention price + Ads book only');
  let all = '';
  for (const v of ['feed', 'algo', 'market', 'duels', 'activity', 'profile']) { await page.click(`.rail [data-nav="${v}"]`); all += await bodyText(page); }
  const payLeaks = leaks(all, [['Pro', /\bPro\b/], ['PRO', /\bPRO\b/], ['Tip', /\bTips?\b/], ['Patron', /Patron/], ['Add $', /Add \$/]]);
  check(!payLeaks.length, `ads-only: no payments copy ${payLeaks}`);
  check(!errors.length, `ads-only: zero errors ${errors.join(' | ')}`);
  await ctx.close();
  ({ ctx, page, errors } = await open(PAY_ONLY, { label: 'payments-only' }));
  check(!(await page.$('[data-ad]')) && !!(await page.$('[data-arg="tip"]')), 'payments-only: tips yes, ads no');
  await page.click('.rail [data-nav="wallet"]');
  w = await page.$eval('#view', e => e.innerText);
  check(/Balance · demo money/i.test(w) && !!(await page.$('[data-act="addFunds"]')) && !(await page.$('#adPrice')) && !w.includes('Earned from ads'), 'payments-only: wallet without ads');
  all = w;
  for (const v of ['feed', 'algo', 'market', 'duels', 'activity', 'profile']) { await page.click(`.rail [data-nav="${v}"]`); all += await bodyText(page); }
  all += await page.$eval('#ticker', e => e.textContent);
  const adLeaks = leaks(all, [['¢', /¢/], ['Sponsored', /Sponsored/], ['attention', /attention/i], ['Paid to scroll', /Paid to scroll/], ['Ad earnings', /Ad earnings/]]);
  check(!adLeaks.length, `payments-only: no ads copy ${adLeaks}`);
  check(!errors.length, `payments-only: zero errors ${errors.join(' | ')}`);
  await ctx.close();
}

/* Deterministic text comparison: original vs switches-on copy. */
async function regressionDiff() {
  log('\n== Original vs switches-on: deterministic text diff');
  const seedRandom = () => { let a = 1234567; Math.random = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; };
  const T = new Date('2026-10-03T12:00:00Z');
  const views = ['feed', 'algo', 'market', 'duels', 'wallet', 'activity', 'profile'];
  const grabAll = async url => {
    const { ctx, page, errors } = await open(url, { clock: { time: T }, init: seedRandom, label: 'diff' });
    const out = {};
    for (const v of views) { await page.click(`.rail [data-nav="${v}"]`); out[v] = (await page.$eval('#view', e => e.innerText)).split('\n'); }
    out.rail = (await page.$eval('#rail', e => e.innerText)).split('\n');
    out.live = (await page.$eval('#live', e => e.innerText)).split('\n');
    out.ticker = [await page.$eval('#ticker', e => e.textContent)];
    await ctx.close();
    return { out, errors };
  };
  const a = await grabAll(ORIGINAL), b = await grabAll(ON);
  const diffs = [];
  for (const k of Object.keys(a.out)) {
    const A = a.out[k], B = b.out[k];
    const onlyA = A.filter(x => !B.includes(x)), onlyB = B.filter(x => !A.includes(x));
    if (onlyA.length || onlyB.length) diffs.push(`[${k}] removed: ${JSON.stringify(onlyA)} added: ${JSON.stringify(onlyB)}`);
  }
  log(diffs.length ? diffs.join('\n') : '  (no differences)');
  notes.push('Original vs switches-on diff:\n' + (diffs.join('\n') || '(none)'));
  const unexpected = diffs.filter(d => !d.startsWith('[profile]'));
  check(!unexpected.length, `diff: only the profile view differs from the original with both switches on`);
  check(!b.errors.length, `diff: zero errors ${b.errors.join(' | ')}`);
}

/* Review fixes: a saved demo follows the switches; long names fit a phone. */
async function seedFollowsSwitch() {
  log('\n== Saved demo follows the switches (seed post p5)');
  const THEO = /keep 70%|attention to advertisers/;
  const scan = async page => {
    let all = '';
    await page.click('[data-act="tab"][data-arg="latest"]'); all += await page.$eval('#feedList', e => e.innerText);
    await page.click('[data-act="tab"][data-arg="foryou"]'); all += await page.$eval('#feedList', e => e.innerText);
    all += await page.$eval('#live', e => e.innerText);
    for (const v of ['market', 'algo', 'profile']) { await page.click(`.rail [data-nav="${v}"]`); all += await page.$eval('#view', e => e.innerText); }
    await page.click('.rail [data-nav="feed"]');
    return all;
  };
  const go = async (page, url) => { await page.goto(url); await page.waitForSelector('#view > *'); };
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await go(page, ADS_ONLY);
  let st = await state(page);
  check(st.posts.some(p => p.id === 'p5'), 'seed flip: ads on seeds p5');
  await go(page, OFF);
  const off = await scan(page);
  check(!THEO.test(off), `seed flip: after turning ads off, p5's copy shows nowhere (${(off.match(THEO) || [])[0]})`);
  st = await state(page);
  check(!st.posts.some(p => p.id === 'p5') && !st.seeded.includes('p5'), 'seed flip: p5 leaves the saved demo');
  await go(page, ADS_ONLY);
  await page.click('[data-act="tab"][data-arg="latest"]');
  check(!!(await page.$('[data-post="p5"]')), 'seed flip: turning ads back on brings p5 back');
  await ctx.close();
  const ctx2 = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const p2 = await ctx2.newPage(); p2.on('pageerror', e => errors.push(e.message));
  await go(p2, OFF);
  st = await state(p2);
  check(!st.posts.some(p => p.id === 'p5') && Array.isArray(st.seeded) && st.seeded.length === 11, 'seed flip: a demo started with ads off has no p5');
  await go(p2, ADS_ONLY);
  await p2.click('[data-act="tab"][data-arg="latest"]');
  check(!!(await p2.$('[data-post="p5"]')), 'seed flip: turning ads on later adds p5 (works as before)');
  await go(p2, ADS_ONLY);
  await p2.waitForTimeout(700);
  check((await state(p2)).posts.filter(p => p.id === 'p5').length === 1, 'seed flip: p5 is added once, not on every load');
  await ctx2.close();
  check(!errors.length, `seed flip: zero errors ${errors.join(' | ')}`);
}

async function longNamesPhone() {
  log('\n== Long single-word names on a phone');
  const { ctx, page, errors } = await open(OFF, { width: 390, height: 844, scheme: 'light', mobile: true, label: 'longname' });
  const LONG = 'Maximilianalexandertheodorvanderberghen';
  await nav(page, 'profile', true);
  await page.click('[data-act="editProfile"]');
  await page.fill('#pf-name', LONG);
  await page.click('[data-form="profile"] button.btn:not([type])');
  check((await overflow(page)) <= 0, `longname: profile fits 390px (${await overflow(page)}px over)`);
  await nav(page, 'feed', true);
  await page.fill('#composeText', 'A post under a very long name.');
  await page.click('#composeForm button.btn:not([type])');
  check((await overflow(page)) <= 0, `longname: feed fits 390px (${await overflow(page)}px over)`);
  const inside = await page.$$eval('[data-post] .post-head .name-btn', els => els.every(e => { const r = e.getBoundingClientRect(), b = e.closest('.post-body').getBoundingClientRect(); return r.right <= b.right + 1; }));
  check(inside, 'longname: names in post headers stay inside the post');
  check(!errors.length, `longname: zero errors ${errors.join(' | ')}`);
  await ctx.close();
}

(async () => {
  browser = await launch();
  const ONLY = process.argv[2] ? new RegExp(process.argv[2]) : null;
  const want = n => !ONLY || ONLY.test(n);
  try {
    if (want('sweep')) await switchesOffSweep({ width: 1360, height: 900, scheme: 'dark' }, 'off-desktop-dark');
    if (want('sweep')) await switchesOffSweep({ width: 390, height: 844, scheme: 'light', mobile: true }, 'off-phone-light');
    if (want('sweep')) await switchesOffSweep({ width: 390, height: 844, scheme: 'dark', mobile: true }, 'off-phone-dark');
    if (want('longrun')) await longRunOff();
    if (want('routing')) await routing();
    if (want('features')) await features({ width: 1360, height: 900, scheme: 'light' }, 'feat-desktop-light');
    if (want('features')) await features({ width: 390, height: 844, scheme: 'dark', mobile: true }, 'feat-phone-dark');
    if (want('features')) await features({ width: 390, height: 844, scheme: 'light', mobile: true }, 'feat-phone-light');
    if (want('on')) await switchesOn({ width: 1360, height: 900, scheme: 'dark' }, 'on-desktop');
    if (want('on')) await switchesOn({ width: 390, height: 844, scheme: 'light', mobile: true }, 'on-phone');
    if (want('single')) await singleSwitch();
    if (want('diff')) await regressionDiff();
    if (want('fixes')) await seedFollowsSwitch();
    if (want('fixes')) await longNamesPhone();
  } catch (e) {
    failures.push('CRASH: ' + (e.stack || e.message));
    console.log('CRASH', e);
  }
  await browser.close();
  log('\n' + notes.join('\n'));
  log(`\nRESULT: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { log(failures.map(f => ' - ' + f).join('\n')); process.exit(1); }
})();
