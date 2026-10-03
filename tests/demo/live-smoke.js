'use strict';
// Live mode in Chromium against a fake supabase-js (fake-supabase.js): no network, no database. Sign-in and sign-up,
// boot and every action's request shape, no simulation, polling, load failures, moderation and the Switchboard, the
// monetization switches (read from the server, never from SWITCHES), recovery, bans, the real supabase-js build with
// SRI, setup checks, and a sweep of every view for money and demo copy.
// Run through run.sh, or: node tests/demo/live-smoke.js [suite name, e.g. switchesOn]
const fs = require('fs');
const path = require('path');
const { SHOTS, OFF, launch, variant, supabaseBuild } = require('./env');

const FAKE = fs.readFileSync(path.join(__dirname, 'fake-supabase.js'), 'utf8');
const ON = variant('live-switches-on', true, true); // SWITCHES flipped on. Live mode must ignore them.
const FAKE_SRC = 'https://fake-cdn.test/supabase.js';
const PAY_MSG = "Payments aren't available yet.";
const SW_KEY = 'bensocial.live.switches';

let pass = 0; const failures = [];
function check(cond, msg) { if (cond) pass++; else { failures.push(msg); console.log('  FAIL', msg); } }
const log = (...a) => console.log(...a);
let browser;

// cache: a value for the live switches cache (SW_KEY), written before the app runs. once: only on the first load.
async function open(url, { fake = {}, width = 1360, height = 900, scheme = 'dark', clock = false, hash = '', label = 'live', src = FAKE_SRC, serve = true, mobile = false, backend = null, legal = null, cache = null, once = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(`${label} pageerror: ${e.message}`));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const where = (m.location() && m.location().url) || '';
    if (/fonts\.(googleapis|gstatic)\.com/.test(m.text() + ' ' + where)) return;
    errors.push(`${label} console: ${m.text()}`);
  });
  await ctx.addInitScript(({ fake, src, backend, legal, cache, once, key }) => {
    window.BENSOCIAL_BACKEND = backend || { supabaseUrl: 'https://fake.supabase.test', supabaseAnonKey: 'anon-key' };
    window.BENSOCIAL_SUPABASE_SRC = src;
    if (legal) window.BENSOCIAL_LEGAL = legal;
    window.__FAKE = fake;
    if (cache != null && !(once && sessionStorage.getItem('__cacheSet'))) { sessionStorage.setItem('__cacheSet', '1'); localStorage.setItem(key, cache); }
  }, { fake, src, backend, legal, cache, once, key: SW_KEY });
  if (serve) await ctx.route(src, r => r.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE }));
  if (clock) await page.clock.install();
  const loads = { n: 0 }; page.on('domcontentloaded', () => { loads.n++; }); // Full page loads, including the app's own reloads.
  await page.goto(url + hash);
  return { ctx, page, errors, loads };
}
const calls = page => page.evaluate(() => window.__calls || []);
const callsOf = async (page, pred) => (await calls(page)).filter(pred);
const rpcCalls = async (page, fn) => callsOf(page, c => c.kind === 'rpc' && c.fn === fn);
const fromCalls = async (page, table, op) => callsOf(page, c => c.kind === 'from' && c.table === table && (!op || c.op === op));
const bodyText = page => page.evaluate(() => document.body.innerText);
const lastToast = page => page.evaluate(() => { const t = [...document.querySelectorAll('#toasts .toast')]; return t.length ? t[t.length - 1].innerText : ''; });
const allToasts = page => page.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map(t => t.innerText).join(' | '));
const settle = (page, ms = 120) => page.waitForTimeout(ms);
const gateText = page => page.evaluate(() => { const g = document.getElementById('gate'); return g && !g.hidden ? g.innerText : ''; });
const shellHidden = page => page.evaluate(() => getComputedStyle(document.querySelector('.shell')).display === 'none');
const localDay = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const DEMO_WORDS = /\bdemo\b|simulated|Demo mode/i;
const MONEY = [/¢/, /\$/, /Wallet/, /\bPro\b/, /\bTips?\b/, /Sponsored/, /attention/i, /Cash out/, /Patron/, /\bAds?\b/];
async function noErrors(errors, tag, allow = []) {
  const bad = errors.filter(e => !allow.some(re => re.test(e)));
  check(!bad.length, `${tag}: no page/console errors (${bad.slice(0, 3).join(' || ')})`);
  errors.length = 0;
}
async function waitFeed(page) { await page.waitForSelector('#view .feed .post', { timeout: 8000 }); }

/* ------------------------------------------------------------------ */
async function authFlow() {
  log('\n== Auth screen (no session)');
  const { ctx, page, errors } = await open(OFF, { label: 'auth' });
  await page.waitForSelector('#gate [data-form="signin"]');
  const g = await gateText(page);
  check(g.includes('The social network with nothing to hide.'), 'auth: tagline shown');
  check(/Sign in/.test(g) && /Create account/.test(g), 'auth: both tabs shown');
  check(await shellHidden(page), 'auth: app shell hidden');
  check(!DEMO_WORDS.test(await bodyText(page)), 'auth: no demo wording');
  check((await callsOf(page, c => c.kind === 'createClient')).length === 1, 'auth: createClient called once');
  const cc = (await callsOf(page, c => c.kind === 'createClient'))[0];
  check(cc && cc.url === 'https://fake.supabase.test' && cc.key === 'anon-key', 'auth: createClient got BACKEND url + key from window.BENSOCIAL_BACKEND');
  check((await callsOf(page, c => c.kind === 'rpc' || c.kind === 'from')).length === 0, 'auth: no data calls before sign-in');
  check(await page.evaluate(() => document.activeElement && document.activeElement.id === 'auth-email'), 'auth: email field focused');

  // wrong password
  await page.fill('#auth-email', 'tester@example.com');
  await page.fill('#auth-password', 'nope');
  await page.click('#gate [data-form="signin"] button.btn');
  await page.waitForSelector('#gate .form-msg.err:not([hidden])');
  check((await page.textContent('#gate .form-msg')).includes("That email and password don't match"), 'auth: wrong password shows plain inline error');
  // empty fields
  await page.fill('#auth-password', '');
  await page.click('#gate [data-form="signin"] button.btn');
  check((await page.textContent('#gate .form-msg')).includes('Enter your password'), 'auth: missing password message');
  // forgot password
  await page.click('[data-act="forgot"]'); await settle(page);
  const fp = await callsOf(page, c => c.op === 'resetPasswordForEmail');
  check(fp.length === 1 && fp[0].email === 'tester@example.com' && fp[0].opts && /index\.html$/.test(fp[0].opts.redirectTo), `auth: resetPasswordForEmail(email, {redirectTo}) (${JSON.stringify(fp[0] && fp[0].opts)})`);
  check((await page.textContent('#gate .form-msg')).includes('we sent it a link'), 'auth: forgot password confirmation shown');

  // sign-up tab keeps the email
  await page.click('#tab-signup');
  check(await page.$eval('#tab-signup', e => e.getAttribute('aria-selected')) === 'true', 'signup: tab selected');
  check(await page.$eval('#su-email', e => e.value) === 'tester@example.com', 'signup: email carried over from sign-in tab');
  await page.fill('#su-name', 'New Person');
  await page.type('#su-handle', 'Ana.Real');
  await page.waitForFunction(() => /Taken/.test(document.getElementById('su-handle-status').textContent), null, { timeout: 3000 });
  check(true, 'signup: taken handle shows "Taken"');
  const ha = await rpcCalls(page, 'handle_available');
  check(ha.length >= 1 && ha[ha.length - 1].args.p_handle === 'ana.real', `signup: handle_available called once after debounce with lowercase handle (${ha.length} calls)`);
  await page.fill('#su-handle', ''); await page.type('#su-handle', 'newbie_1');
  await page.waitForFunction(() => /Available/.test(document.getElementById('su-handle-status').textContent), null, { timeout: 3000 });
  check(true, 'signup: free handle shows "Available"');
  await page.fill('#su-handle', 'a!'); await settle(page, 50);
  check(/lowercase/.test(await page.textContent('#su-handle-status')), 'signup: bad characters flagged');
  await page.fill('#su-handle', 'newbie_1'); await settle(page, 500);
  await page.fill('#su-password', 'short');
  await page.click('#gate [data-form="signup"] button.btn:not([type])');
  check((await page.textContent('#gate .form-msg')).includes('at least 8'), 'signup: short password rejected');
  await page.fill('#su-password', 'long-enough-pw');
  await page.click('#gate [data-form="signup"] button.btn:not([type])');
  check((await page.textContent('#gate .form-msg')).includes('13 or older'), 'signup: age checkbox required');
  await page.check('#su-age');
  await page.click('#gate [data-form="signup"] button.btn:not([type])');
  check((await page.textContent('#gate .form-msg')).includes('Community Guidelines'), 'signup: guidelines checkbox required');
  // guidelines link opens modal and doesn't tick the box
  await page.click('#su-terms + span [data-act="guidelines"]');
  check(!(await page.$eval('#modal', e => e.hidden)) && (await page.textContent('#modalBody')).includes('Community Guidelines'), 'signup: guidelines link opens the modal');
  check(!(await page.$eval('#su-terms', e => e.checked)), 'signup: guidelines link does not tick the checkbox');
  await page.keyboard.press('Escape');
  await page.check('#su-terms');
  await page.click('#gate [data-form="signup"] button.btn:not([type])');
  await page.waitForFunction(() => /Check your email/.test(document.getElementById('gate').innerText), null, { timeout: 3000 });
  const su = (await callsOf(page, c => c.op === 'signUp'))[0];
  check(su && su.args.email === 'tester@example.com' && su.args.password === 'long-enough-pw', 'signup: signUp email/password');
  check(su && su.args.options && su.args.options.data && su.args.options.data.handle === 'newbie_1' && su.args.options.data.name === 'New Person', `signup: options.data {handle, name} (${JSON.stringify(su && su.args.options)})`);
  check(su && /index\.html$/.test(su.args.options.emailRedirectTo || ''), 'signup: emailRedirectTo is origin + pathname');
  check((await page.textContent('#gate .form-msg')).includes('Check your email to confirm your account, then sign in.'), 'signup: no session → confirmation message');
  check(await page.$eval('#tab-signin', e => e.getAttribute('aria-selected')) === 'true', 'signup: back on sign-in tab');

  // correct sign in → app boots
  await page.fill('#auth-password', 'correct-horse');
  await page.click('#gate [data-form="signin"] button.btn');
  await waitFeed(page);
  check(!(await shellHidden(page)) && await page.$eval('#gate', e => e.hidden), 'signin: app shell shows, gate hidden');
  check((await bodyText(page)).includes('Hello from a real person'), 'signin: feed rendered from FEED ROWs');
  await noErrors(errors, 'auth');

  // sign out from settings
  await page.click('.rail [data-nav="profile"]'); await settle(page);
  check((await page.textContent('#view')).includes('Signed in as tester@example.com'), 'settings: shows signed-in email');
  check(!(await page.$('#view [data-act="reset"]')), 'settings: no Reset demo in live mode');
  await page.click('[data-act="signOut"]');
  await page.waitForSelector('#gate [data-form="signin"]');
  check(await shellHidden(page), 'signout: back to auth screen');
  check((await page.evaluate(() => document.getElementById('view').innerHTML)) === '', 'signout: personal views cleared from the DOM');
  check((await callsOf(page, c => c.op === 'signOut')).length >= 1, 'signout: sb.auth.signOut called');
  await noErrors(errors, 'signout');
  await ctx.close();
}

/* ------------------------------------------------------------------ */
async function bootAndActions() {
  log('\n== Boot with session, actions');
  const { ctx, page, errors } = await open(OFF, { fake: { session: true }, label: 'app' });
  await waitFeed(page);
  const c = await calls(page);
  const idx = (pred) => c.findIndex(pred);
  const ts = c.find(x => x.kind === 'rpc' && x.fn === 'touch_streak');
  check(ts && ts.args.p_today === localDay(), `boot: touch_streak with local date (${ts && ts.args.p_today} vs ${localDay()})`);
  check(idx(x => x.fn === 'settle_duels') >= 0 && idx(x => x.fn === 'settle_duels') < idx(x => x.fn === 'list_duels'), 'boot: settle_duels before list_duels');
  for (const fn of ['feed', 'unread_count', 'my_stats', 'list_duels']) check(c.some(x => x.kind === 'rpc' && x.fn === fn), `boot: rpc ${fn}`);
  const fd = c.find(x => x.fn === 'feed'); check(fd && fd.args.p_limit === 200, 'boot: feed(p_limit 200)');
  for (const t of ['follows', 'mutes', 'blocks', 'positions']) check(c.some(x => x.kind === 'from' && x.table === t && x.op === 'select'), `boot: select ${t}`);
  check(c.some(x => x.kind === 'rpc' && x.fn === 'my_profile'), 'boot: own profile from my_profile()');
  check(!c.some(x => x.kind === 'from' && x.table === 'profiles' && x.cols === '*'), 'boot: never select * from profiles (other people only show public columns)');
  check(!c.some(x => x.kind === 'from' && x.table === 'ads'), 'boot: ads table not read while ads switch is off');
  const t = await bodyText(page);
  check(!DEMO_WORDS.test(t), `boot: no demo/simulated wording (${(t.match(DEMO_WORDS) || [])[0]})`);
  check(!MONEY.some(re => re.test(t)), 'boot: no money copy with switches off');
  check(await page.evaluate(() => window.__xss === undefined), 'boot: user HTML not executed');
  check((await page.textContent('[data-post="102"] .post-text')).includes('<img src=x'), 'boot: post body rendered as text');
  check((await page.textContent('[data-post="102"] .name')).includes('<img src=x'), 'boot: author name rendered as text');
  check((await page.textContent('.me-card')).includes('Test User'), 'boot: rail shows profile name');
  check(/Lv 1/.test(await page.textContent('.me-card')), 'boot: level from server XP (90 → Lv 1)');
  check((await page.textContent('.me-card .stat-pair')).includes('500'), 'boot: clout from profile');
  check((await page.$eval('[data-me="streak"]', e => e.textContent)) === '3', 'boot: streak from touch_streak (2 → 3)');
  const unread = await page.$eval('.rail [data-me="unread"]', e => e.hidden ? '' : e.textContent);
  check(unread === '2', `boot: unread badge from unread_count (${unread})`);
  check(!(await page.$('.rail [data-nav="moderation"]')), 'boot: no Moderation nav for non-admin');
  check((await page.textContent('#live')).includes('Is cereal a <soup>?'), 'boot: live duel title escaped in rail');
  check(!/Demo mode/.test(await page.textContent('#live')), 'boot: no demo footnote in live rail');
  check((await page.$$('[data-post="103"] .receipt-link')).length === 1 && /2 versions/.test(await page.textContent('[data-post="103"] .receipt-link')), 'boot: edit receipt link from edit_count');

  // composer → posts.insert
  await page.fill('#composeText', 'A brand new live post');
  await page.click('[data-act="mood"][data-arg="wholesome"]');
  await page.click('#composeForm button.btn');
  await page.waitForFunction(() => document.body.innerText.includes('A brand new live post'));
  const ins = await fromCalls(page, 'posts', 'insert');
  check(ins.length === 1 && ins[0].payload.body === 'A brand new live post' && ins[0].payload.mood === 'wholesome' && Object.keys(ins[0].payload).sort().join() === 'body,mood', `post: posts.insert {body, mood} (${JSON.stringify(ins[0] && ins[0].payload)})`);
  await settle(page, 700);
  const profSel = await rpcCalls(page, 'my_profile');
  check(profSel.length >= 2, 'post: profile re-fetched after an XP action');
  check(/Lv 2/.test(await page.textContent('.me-card')), 'post: level from server XP after refresh (90+25 → Lv 2)');
  check((await allToasts(page)).includes('Level 2 reached. +100 clout.'), 'post: level-up toast from server numbers');
  check(await page.$eval('#composeText', e => e.value) === '', 'post: composer cleared');

  // like → reactions upsert; unlike → delete
  const likes0 = +(await page.textContent('[data-b="likes:101"]'));
  await page.click('[data-post="101"] [data-act="like"]');
  check(+(await page.textContent('[data-b="likes:101"]')) === likes0 + 1, 'like: optimistic count +1');
  await settle(page);
  const up = await fromCalls(page, 'reactions', 'upsert');
  check(up.length === 1 && up[0].payload.post_id === 101 && up[0].payload.kind === 'like' && up[0].opts && up[0].opts.onConflict === 'user_id,post_id', `like: reactions.upsert {post_id:101, kind:'like'} onConflict user_id,post_id (${JSON.stringify(up[0])})`);
  await page.click('[data-post="101"] [data-act="dislike"]'); await settle(page);
  const up2 = await fromCalls(page, 'reactions', 'upsert');
  check(up2.length === 2 && up2[1].payload.kind === 'dislike', 'dislike: switches reaction with upsert');
  check(+(await page.textContent('[data-b="likes:101"]')) === likes0, 'dislike: like count back');
  await page.click('[data-post="101"] [data-act="dislike"]'); await settle(page);
  const del = await fromCalls(page, 'reactions', 'delete');
  check(del.length === 1 && del[0].filters.some(f => f[1] === 'post_id' && f[2] === 101), 'undislike: reactions.delete where post_id');
  // optimistic revert on error
  await page.evaluate(() => { window.__FAKE.fail = { 'reactions.upsert': { message: 'banned', code: 'P0001' } }; });
  const l102 = +(await page.textContent('[data-b="likes:102"]'));
  await page.click('[data-post="102"] [data-act="like"]');
  await page.waitForFunction(() => /suspended/.test(document.getElementById('toasts').innerText), null, { timeout: 3000 });
  check(+(await page.textContent('[data-b="likes:102"]')) === l102, 'like error: count reverted');
  check(await page.$eval('[data-post="102"] [data-act="like"]', e => e.getAttribute('aria-pressed')) === 'false', 'like error: pressed state reverted');
  check((await lastToast(page)).includes("Your account is suspended, so you can't do that."), 'like error: banned mapped to plain message');
  await noErrors(errors, 'like revert', [/banned/, /\[object Object\]/, /Object/]);

  // repost
  await page.click('[data-post="101"] [data-act="repost"]'); await settle(page);
  const rp = await fromCalls(page, 'reposts', 'insert');
  check(rp.length === 1 && rp[0].payload.post_id === 101, 'repost: reposts.insert {post_id}');
  check((await allToasts(page)).includes('Reposted to your followers.'), 'repost: toast');

  // replies lazy-load + insert
  await page.click('[data-post="101"] [data-act="reply"]');
  await page.waitForFunction(() => document.querySelector('[data-post="101"] .reply'));
  const rs = await fromCalls(page, 'replies', 'select');
  check(rs.length === 1 && rs[0].filters.some(f => f[1] === 'post_id' && f[2] === 101) && rs[0].cols.replace(/\s/g, '') === 'id,post_id,author_id,body,created_at', 'replies: lazy select by post_id with contract columns');
  check((await page.textContent('[data-post="101"] .reply p')).includes('<b>tags</b>'), 'replies: reply text escaped');
  check(await page.evaluate(() => document.activeElement && document.activeElement.id === 'reply-101'), 'replies: focus stays in reply box after load');
  await page.fill('#reply-101', 'My live reply');
  await page.press('#reply-101', 'Enter');
  await page.waitForFunction(() => document.querySelector('[data-post="101"] .thread').innerText.includes('My live reply'));
  const ri = await fromCalls(page, 'replies', 'insert');
  check(ri.length === 1 && ri[0].payload.post_id === 101 && ri[0].payload.body === 'My live reply', 'reply: replies.insert {post_id, body}');
  // delete own reply
  await page.click('[data-post="101"] .reply:has-text("My live reply") [data-act="menu"]');
  await page.click('#menu [data-act="askDelete"]');
  await page.click('[data-act="confirmDelete"]'); await settle(page);
  check((await fromCalls(page, 'replies', 'delete')).length === 1, 'reply: delete own reply calls replies.delete');

  // receipts lazy-load
  await page.click('[data-post="103"] .receipt-link');
  await page.waitForSelector('#modal:not([hidden]) .receipt');
  const pe = await fromCalls(page, 'post_edits', 'select');
  check(pe.length === 1 && pe[0].filters.some(f => f[1] === 'post_id' && f[2] === 103), 'receipt: post_edits select by post_id');
  check((await page.textContent('.receipt')).includes('My own first post') && (await page.textContent('.receipt')).includes('My own first post, edited'), 'receipt: old and current versions');
  await page.keyboard.press('Escape');
  // edit own post
  await page.click('[data-post="103"] [data-act="menu"]');
  await page.click('#menu [data-act="edit"]');
  await page.fill('#edit-103', 'My own first post, edited twice');
  await page.click('[data-form="edit"] button.btn:not([type])');
  await settle(page, 200);
  const pu = await fromCalls(page, 'posts', 'update');
  check(pu.length === 1 && pu[0].payload.body === 'My own first post, edited twice' && pu[0].filters.some(f => f[1] === 'id' && f[2] === 103), 'edit: posts.update {body} where id');
  check(/3 versions/.test(await page.textContent('[data-post="103"] .receipt-link')), 'edit: receipt count updated');

  // follow from post header
  await page.click('[data-post="102"] [data-act="follow"]'); await settle(page);
  const fi = await fromCalls(page, 'follows', 'insert');
  check(fi.length === 1 && fi[0].payload.followee === 'cccccccc-0000-4000-8000-000000000003', 'follow: follows.insert {followee}');
  check((await page.textContent('[data-post="102"] [data-act="follow"]')).trim() === 'Following', 'follow: button shows Following');

  // person view
  await page.click('[data-post="101"] .post-head .name-btn');
  await page.waitForFunction(() => document.querySelector('#view h1') && document.querySelector('#view h1').textContent.includes('Ana Real'));
  const pb = await rpcCalls(page, 'posts_by');
  check(pb.length === 1 && pb[0].args.p_author === 'bbbbbbbb-0000-4000-8000-000000000002' && pb[0].args.p_limit === 50, 'person: posts_by(p_author, p_limit)');
  check((await page.textContent('#view .bio')).includes('<b>not bold</b>'), 'person: bio escaped');
  check(/10\s*followers/.test(await page.textContent('#view .follow-counts')), 'person: follower count from profile');
  check((await page.evaluate(() => location.hash)) === '#person:bbbbbbbb-0000-4000-8000-000000000002', 'person: #person:<uuid> hash');
  await page.click('#view .person-tools [data-act="follow"]'); await settle(page);
  const fd2 = await fromCalls(page, 'follows', 'delete');
  check(fd2.length === 1 && fd2[0].filters.some(f => f[1] === 'followee' && f[2] === 'bbbbbbbb-0000-4000-8000-000000000002'), 'person: unfollow → follows.delete');
  check(/9\s*followers/.test(await page.textContent('#view .follow-counts')), 'person: follower count drops optimistically');
  await page.click('[data-act="goBack"]'); await waitFeed(page);

  // report
  await page.click('[data-post="102"] [data-act="menu"]');
  await page.click('#menu [data-act="report"]');
  await page.check('#modalBody input[value="harassment"]');
  await page.fill('#reportDetails', 'Not nice');
  await page.click('#modalBody [data-form="report"] button.btn:not([type])');
  await settle(page);
  const rep = await fromCalls(page, 'reports', 'insert');
  check(rep.length === 1 && rep[0].payload.post_id === 102 && rep[0].payload.reason === 'harassment' && rep[0].payload.details === 'Not nice' && Object.keys(rep[0].payload).length === 3, `report: reports.insert {post_id, reason, details} (${JSON.stringify(rep[0] && rep[0].payload)})`);
  check((await allToasts(page)).includes('Thanks. A moderator will review it.'), 'report: toast');
  // mute + block
  await page.click('[data-post="102"] [data-act="menu"]');
  await page.click('#menu [data-act="mute"]'); await settle(page);
  const mu = await fromCalls(page, 'mutes', 'insert');
  check(mu.length === 1 && mu[0].payload.muted_id === 'cccccccc-0000-4000-8000-000000000003', 'mute: mutes.insert {muted_id}');
  check(!(await page.$('[data-post="102"]')), 'mute: their posts hidden');
  await page.click('.rail [data-nav="algo"]'); await settle(page);
  await page.click('#view [data-act="unmute"]'); await settle(page, 300);
  check((await fromCalls(page, 'mutes', 'delete')).length === 1, 'unmute: mutes.delete');
  check((await rpcCalls(page, 'feed')).length >= 2, 'unmute: feed reloaded to bring their posts back');
  await page.click('.rail [data-nav="feed"]'); await waitFeed(page);
  await page.click('[data-post="102"] [data-act="menu"]');
  await page.click('#menu [data-act="askBlock"]');
  await page.click('#modalBody [data-act="block"]'); await settle(page);
  const bl = await fromCalls(page, 'blocks', 'insert');
  check(bl.length === 1 && bl[0].payload.blocked === 'cccccccc-0000-4000-8000-000000000003', 'block: blocks.insert {blocked}');
  check(!(await page.$('[data-post="102"]')), 'block: their posts hidden');
  await page.click('.rail [data-nav="profile"]'); await settle(page);
  check((await page.textContent('#view .settings-sub')).includes('@evil_one'), 'block: listed in Blocked accounts');
  await page.click('#view .settings-sub [data-act="unblock"]'); await settle(page, 300);
  check((await fromCalls(page, 'blocks', 'delete')).length === 1, 'unblock: blocks.delete');

  // market: back + error mapping + sell
  await page.click('.rail [data-nav="feed"]'); await waitFeed(page);
  await page.click('[data-post="101"] .clout-chip');
  await page.click('[data-post="101"] [data-act="back"][data-arg="25"]'); await settle(page, 200);
  const bp = await rpcCalls(page, 'back_post');
  check(bp.length === 1 && bp[0].args.p_post === 101 && bp[0].args.p_amount === 25, 'back: back_post(p_post, p_amount)');
  check(/Backed @ana\.real with 25 clout/.test(await allToasts(page)), 'back: toast');
  await page.click('[data-post="103"] .clout-chip');
  check((await page.textContent('[data-post="103"] .pop')).includes("This is your post, so you can't back it"), 'back: own post explains instead of offering Back buttons');
  await page.evaluate(() => { window.__FAKE.fail = { 'rpc.back_post': { message: 'insufficient_clout', code: 'P0001' } }; });
  await page.click('[data-post="101"] .clout-chip');
  await page.click('[data-post="101"] [data-act="back"][data-arg="25"]');
  await page.waitForFunction(() => /enough clout/.test(document.getElementById('toasts').innerText), null, { timeout: 3000 });
  check(true, 'back error: insufficient_clout mapped to plain message');
  await page.click('.rail [data-nav="market"]'); await settle(page);
  check((await page.textContent('#view')).includes('Your positions'), 'market: position listed');
  await page.click('#view [data-act="sell"]'); await settle(page, 300);
  const sp = await rpcCalls(page, 'sell_position');
  check(sp.length === 1 && sp[0].args.p_post === 101, 'sell: sell_position(p_post)');
  check(/Sold for/.test(await allToasts(page)), 'sell: toast says Sold (payments off)');
  await noErrors(errors, 'market', [/insufficient_clout/, /Object/]);

  // duels
  await page.click('.rail [data-nav="duels"]'); await settle(page, 300);
  check((await page.textContent('#view .duel h2')).includes('Is cereal a <soup>?'), 'duels: title escaped');
  check((await page.textContent('#view .duel')).includes('Soup') && (await page.textContent('#view .duel')).includes('@ana.real'), 'duels: label-only side and linked side');
  await page.click('#view [data-act="vote"][data-arg="a"]'); await settle(page, 200);
  const vd = await rpcCalls(page, 'vote_duel');
  check(vd.length === 1 && vd[0].args.p_duel === 7 && vd[0].args.p_side === 'a', 'vote: vote_duel(p_duel, p_side)');
  check((await page.textContent('#view .split')).includes('%'), 'vote: split shown');

  // daily drop
  await page.click('#live [data-act="drop"]'); await settle(page, 200);
  const dd = await rpcCalls(page, 'claim_daily_drop');
  check(dd.length === 1 && dd[0].args.p_today === localDay(), 'drop: claim_daily_drop(p_today = local date)');
  check(/Daily drop: \+77 clout/.test(await allToasts(page)), 'drop: amount from server');

  // dial saved to profiles.dial, debounced
  await page.click('.rail [data-nav="algo"]'); await settle(page);
  await page.$eval('#dial-spicy', e => { e.value = '80'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.$eval('#dial-spicy', e => { e.value = '85'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await settle(page, 300);
  check((await callsOf(page, x => x.table === 'profiles' && x.op === 'update' && x.payload.dial)).length === 0, 'dial: not saved before 800ms');
  await settle(page, 900);
  const du = await callsOf(page, x => x.table === 'profiles' && x.op === 'update' && x.payload.dial);
  check(du.length === 1 && du[0].payload.dial.spicy === 85 && Object.keys(du[0].payload).join() === 'dial', `dial: one profiles.update {dial} after debounce (${du.length})`);
  await page.click('[data-act="savePreset"]'); await settle(page, 1100);
  const du2 = await callsOf(page, x => x.table === 'profiles' && x.op === 'update' && x.payload.dial);
  check(du2.length === 2 && du2[1].payload.dial.presets.length === 1, 'dial: saved preset stored with the dial');

  // activity: notifications + mark read
  await page.click('.rail [data-nav="activity"]');
  await page.waitForSelector('#view .notes li');
  const ns = await fromCalls(page, 'notifications', 'select');
  check(ns.length === 1, 'activity: notifications select');
  const notesText = await page.textContent('#view .notes');
  check(notesText.includes('@ana.real liked your post') && notesText.includes('<i>sneaky</i>') && notesText.includes('You reached level 2'), 'activity: notification text mapped and escaped');
  check((await page.$$('#view .notes li.unread')).length === 2, 'activity: unread dots from server read flags');
  await settle(page, 200);
  check((await rpcCalls(page, 'mark_notifications_read')).length === 1, 'activity: mark_notifications_read called');
  check(await page.$eval('.rail [data-me="unread"]', e => e.hidden), 'activity: unread badge cleared');
  check((await page.textContent('#view .view-sub')).trim() === 'Likes, replies, backers, followers and duel results.', 'activity: no simulated wording');

  // profile edit: handle availability + save
  await page.click('.rail [data-nav="profile"]'); await settle(page);
  const profText = await page.textContent('#view');
  check(!MONEY.some(re => re.test(profText)), 'profile: no money copy');
  await page.click('[data-act="editProfile"]');
  await page.fill('#pf-handle', ''); await page.type('#pf-handle', 'ana.real');
  await page.waitForFunction(() => /Taken/.test(document.getElementById('pf-handle-status').textContent));
  await page.click('[data-form="profile"] button.btn:not([type])');
  check((await lastToast(page)).includes('That handle is taken'), 'profile: taken handle blocked before saving');
  await page.fill('#pf-handle', 'tester2'); await page.fill('#pf-bio', 'New <bio>');
  await page.waitForFunction(() => /Available/.test(document.getElementById('pf-handle-status').textContent));
  await page.click('[data-form="profile"] button.btn:not([type])'); await settle(page, 200);
  const pu2 = await callsOf(page, x => x.table === 'profiles' && x.op === 'update' && x.payload.handle);
  check(pu2.length === 1 && pu2[0].payload.handle === 'tester2' && pu2[0].payload.bio === 'New <bio>' && pu2[0].payload.name === 'Test User', 'profile: profiles.update {name, handle, bio}');
  check((await page.textContent('#view .bio')).includes('New <bio>'), 'profile: bio escaped after save');

  // delete own post (two-step)
  await page.click('[data-post="103"] [data-act="menu"]');
  await page.click('#menu [data-act="askDelete"]');
  await page.click('[data-act="confirmDelete"]'); await settle(page, 200);
  const pd = await fromCalls(page, 'posts', 'delete');
  check(pd.length === 1 && pd[0].filters.some(f => f[1] === 'id' && f[2] === 103), 'delete post: posts.delete where id');
  check(!(await page.$('[data-post="103"]')), 'delete post: removed from view');

  // delete account
  await page.click('[data-act="askDeleteAccount"]');
  check(await page.evaluate(() => document.activeElement && document.activeElement.dataset.act === 'cancelDeleteAccount'), 'delete account: confirm shown with Cancel focused');
  await page.keyboard.press('Escape');
  check(!(await page.$('[data-act="deleteAccount"]')), 'delete account: Escape cancels');
  await page.click('[data-act="askDeleteAccount"]');
  await page.click('[data-act="deleteAccount"]');
  await page.waitForSelector('#gate [data-form="signin"]');
  check((await rpcCalls(page, 'delete_my_account')).length === 1, 'delete account: delete_my_account rpc');
  check((await page.textContent('#gate .form-msg')).includes('Your account was deleted'), 'delete account: auth screen with message');
  await noErrors(errors, 'actions', [/insufficient_clout/, /banned/, /Object/]);
  await ctx.close();

  // touch_streak() rebuilds a missing profile row. unread_count() and my_stats() raise not_found without one, so they
  // wait for it like my_profile() does (a slow touch_streak used to leave "Couldn't load your feed").
  {
    const s = await open(OFF, { fake: { session: true, delay: { touch_streak: 150 } }, label: 'slow-streak' });
    await waitFeed(s.page);
    const sc = (await calls(s.page)).filter(x => x.kind === 'rpc');
    const at = fn => sc.findIndex(x => x.fn === fn);
    check(at('touch_streak') >= 0 && ['my_profile', 'unread_count', 'my_stats'].every(fn => at(fn) > at('touch_streak')),
          `boot: my_profile, unread_count and my_stats wait for touch_streak (${sc.map(x => x.fn).join(',')})`);
    await noErrors(s.errors, 'slow-streak');
    await s.ctx.close();
  }
}

/* ------------------------------------------------------------------ */
async function noSimulation() {
  log('\n== No simulation, polling');
  const { ctx, page, errors, loads } = await open(OFF, { fake: { session: true, ads: true }, label: 'nosim', clock: true });
  await waitFeed(page);
  const snap = () => page.evaluate(() => ({
    likes: [...document.querySelectorAll('[data-b^="likes:"]')].map(e => e.textContent).join(','),
    price: [...document.querySelectorAll('[data-b^="price:"]')].map(e => e.textContent).join(','),
    posts: document.querySelectorAll('#feedList .post').length, toasts: document.getElementById('toasts').innerText,
    ticker: document.getElementById('ticker').innerText, unread: document.querySelector('.rail [data-me="unread"]').textContent,
  }));
  const before = await snap();
  const n0 = (await calls(page)).length;
  await page.clock.runFor(29000); await settle(page, 200);
  const mid = await calls(page);
  check(mid.length === n0, `nosim: no backend calls before 30s (${mid.length - n0})`);
  await page.clock.runFor(2000); await settle(page, 200);
  const polled = (await calls(page)).slice(n0);
  check(polled.some(x => x.fn === 'unread_count') && polled.some(x => x.fn === 'feed' && x.args.p_limit === 50) && polled.some(x => x.fn === 'app_switches'),
        `nosim: 30s poll calls unread_count + feed(50) + app_switches (${polled.map(x => x.fn || x.table).join(',')})`);
  check(polled.length === 3, `nosim: poll makes exactly three calls (${polled.length})`);
  await page.clock.runFor(14000); await settle(page, 200);
  const after = await snap();
  check(after.likes === before.likes && after.price === before.price, 'nosim: no fake likes or price moves after 45s');
  check(after.posts === before.posts && !(await page.$('.new-pill')), 'nosim: no incoming posts or pill');
  check(!after.toasts, `nosim: no fake toasts (${after.toasts})`);
  check(after.ticker === before.ticker, 'nosim: ticker unchanged');
  // a real new post from someone else → pill → reload
  await page.evaluate(() => { window.__fakeDb.posts.push({ id: 777, author_id: 'bbbbbbbb-0000-4000-8000-000000000002', body: 'Fresh from the server', mood: null, spicy: .25, wholesome: .35, likes: 0, dislikes: 0, replies: 0, reposts: 0, shares_outstanding: 0, price: 5, price_history: [5], removed: false, created_at: new Date().toISOString(), edited_at: null }); });
  await page.clock.runFor(30000); await settle(page, 200);
  check((await page.textContent('.new-pill')).includes('Show 1 new post'), 'poll: pill counts new posts');
  await page.click('.new-pill'); await settle(page, 300);
  check((await page.textContent('#feedList')).includes('Fresh from the server') && !(await page.$('.new-pill')), 'poll: pill reloads feed');
  // The owner turns ads on: the poll remembers it for the next load, and leaves the open page alone.
  await page.evaluate(() => { window.__fakeSettings({ ads_enabled: true }); window.__stillHere = true; });
  await page.clock.runFor(30000); await settle(page, 200);
  check((await page.evaluate(k => localStorage.getItem(k), SW_KEY)) === '{"ads":true,"payments":false}', 'poll: a switch change is remembered for the next load');
  check(loads.n === 1 && await page.evaluate(() => window.__stillHere === true), 'poll: the page in use is not reloaded');
  check(!(await page.$('[data-ad]')) && !(await page.$('[data-nav="wallet"]')) && !(await allToasts(page)), 'poll: nothing changes on the open page');
  await page.evaluate(() => window.__fakeSettings({ ads_enabled: false }));
  await page.clock.runFor(30000); await settle(page, 200);
  check((await page.evaluate(k => localStorage.getItem(k), SW_KEY)) === '{"ads":false,"payments":false}', 'poll: and turning it back off too');
  // hidden tab: no polling
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  const n1 = (await calls(page)).length;
  await page.clock.runFor(65000); await settle(page, 200);
  check((await calls(page)).length === n1, 'poll: no calls while the tab is hidden');
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await settle(page, 200); await page.clock.runFor(100); await settle(page, 200);
  check((await calls(page)).slice(n1).some(x => x.fn === 'unread_count'), 'poll: polls right away when the tab is visible again');
  // activity shows only server notifications after time passes
  await page.click('.rail [data-nav="activity"]'); await page.waitForSelector('#view .notes li');
  check((await page.$$('#view .notes li')).length === 3, 'nosim: Activity holds only the 3 server notifications');
  await noErrors(errors, 'nosim');
  await ctx.close();
}

/* ------------------------------------------------------------------ */
async function loadFailure() {
  log('\n== Client load failure');
  const { ctx, page, errors } = await open(OFF, { serve: false, label: 'loadfail' });
  await ctx.route(FAKE_SRC, r => r.abort());
  await page.reload();
  await page.waitForSelector('#gate [data-act="retryLoad"]');
  check((await gateText(page)).includes("BenSocial couldn't load"), 'loadfail: full-screen error');
  check(await shellHidden(page), 'loadfail: app hidden');
  check(await page.evaluate(() => document.activeElement && document.activeElement.dataset.act === 'retryLoad'), 'loadfail: Retry focused');
  await ctx.unroute(FAKE_SRC);
  await ctx.route(FAKE_SRC, r => r.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE }));
  await page.click('[data-act="retryLoad"]');
  await page.waitForSelector('#gate [data-form="signin"]');
  check(true, 'loadfail: Retry loads the client and shows sign-in');
  check(await page.evaluate(() => document.querySelectorAll('script[src*="fake-cdn"]').length) === 1, 'loadfail: old script tag replaced');
  await noErrors(errors, 'loadfail', [/Failed to load resource/, /ERR_FAILED/]);
  await ctx.close();
}

/* ------------------------------------------------------------------ */
async function admin() {
  log('\n== Moderation (admin)');
  const admin = await open(OFF, { fake: { session: true, admin: true }, label: 'admin' });
  const { ctx, page, errors } = admin;
  await waitFeed(page);
  check(!!(await page.$('.rail [data-nav="moderation"]')), 'admin: Moderation nav shown');
  await page.click('.rail [data-nav="moderation"]');
  await page.waitForSelector('#view .mod-item');
  check((await rpcCalls(page, 'mod_open_reports')).length === 1, 'admin: mod_open_reports');
  const item = await page.textContent('#view .mod-item');
  check(item.includes('Harassment or bullying') && item.includes('@evil_one') && item.includes('Reported by @ana.real'), 'admin: report shows reason, target and reporter');
  check(item.includes('<img src=x') && item.includes('<b>posting</b>') && await page.evaluate(() => window.__xss === undefined), 'admin: content and details escaped');
  await page.click('#view [data-act="modRemove"][data-arg="1"]'); await settle(page, 300);
  const rm = await rpcCalls(page, 'mod_set_post_removed');
  check(rm.length === 1 && rm[0].args.p_post === 102 && rm[0].args.p_removed === true, 'admin: mod_set_post_removed(p_post, true)');
  check(!!(await page.$('#view [data-act="modRemove"][data-arg="0"]')), 'admin: Restore offered after removal');
  await page.click('#view [data-act="modBan"][data-arg="1"]'); await settle(page, 300);
  const bn = await rpcCalls(page, 'mod_set_banned');
  check(bn.length === 1 && bn[0].args.p_user === 'cccccccc-0000-4000-8000-000000000003' && bn[0].args.p_banned === true, 'admin: mod_set_banned(p_user, true)');
  check(!!(await page.$('#view [data-act="modBan"][data-arg="0"]')), 'admin: Unban offered');
  await page.click('#view [data-act="modResolve"][data-arg="dismissed"]'); await settle(page, 300);
  const rr = await rpcCalls(page, 'mod_resolve_report');
  check(rr.length === 1 && rr[0].args.p_report === 900 && rr[0].args.p_status === 'dismissed', 'admin: mod_resolve_report(p_report, dismissed)');
  check((await page.textContent('#view')).includes('Nothing to review right now.'), 'admin: empty state after resolving');
  // create duel
  await page.fill('#duel-title', 'Tabs or spaces?');
  await page.fill('#duel-a-label', 'Tabs'); await page.fill('#duel-a-take', 'One char, any width.');
  await page.fill('#duel-b-take', 'Same everywhere.'); await page.fill('#duel-b-handle', '@ana.real');
  await page.fill('#duel-hours', '0');
  await page.click('[data-form="duel"] button.btn');
  check((await lastToast(page)).includes('1 to 72 hours'), 'admin: duel hours validated');
  await page.fill('#duel-hours', '12');
  await page.click('[data-form="duel"] button.btn'); await settle(page, 300);
  const cd = await rpcCalls(page, 'mod_create_duel');
  check(cd.length === 1 && JSON.stringify(cd[0].args) === JSON.stringify({ p_title: 'Tabs or spaces?', p_a_label: 'Tabs', p_a_take: 'One char, any width.', p_b_label: '', p_b_take: 'Same everywhere.', p_hours: 12, p_a_handle: null, p_b_handle: '@ana.real' }), `admin: mod_create_duel args (${JSON.stringify(cd[0] && cd[0].args)})`);
  check((await allToasts(page)).includes('Duel created'), 'admin: duel created toast');
  await page.fill('#duel-title', 'X'); await page.fill('#duel-a-label', 'A'); await page.fill('#duel-a-take', 'a'); await page.fill('#duel-a-handle', 'nobody_here');
  await page.fill('#duel-b-label', 'B'); await page.fill('#duel-b-take', 'b'); await page.fill('#duel-hours', '5');
  await page.click('[data-form="duel"] button.btn'); await settle(page, 300);
  check((await lastToast(page)).includes('No account has that handle'), 'admin: unknown handle mapped');
  // Switchboard: ads turn on in two steps; payments have no button.
  const sbAds = '#switchboardPanel [data-switch="ads"]', sbPay = '#switchboardPanel [data-switch="payments"]';
  check((await page.textContent(sbAds)).includes('Off: nobody sees an ad, and no ad pays.'), 'switchboard: ads off, and what that means');
  check((await page.textContent(sbPay)).includes('Payments need a payment processor first. See docs/GO-LIVE.md.'), 'switchboard: payments point to docs/GO-LIVE.md');
  check(!(await page.$(`${sbPay} button`)), 'switchboard: payments have no button');
  await page.click(`${sbAds} [data-act="askSwitch"]`); await page.waitForSelector(`${sbAds} .confirm`);
  check((await page.textContent(`${sbAds} .confirm`)).includes('no active ads yet'), 'switchboard: step one warns there are no active ads');
  check((await page.evaluate(() => document.activeElement.dataset.act)) === 'cancelSwitch', 'switchboard: focus moves to Cancel');
  check(!(await rpcCalls(page, 'mod_set_switch')).length, 'switchboard: nothing changes on step one');
  await page.keyboard.press('Escape');
  check(!(await page.$(`${sbAds} .confirm`)) && (await page.evaluate(() => document.activeElement.dataset.act)) === 'askSwitch', 'switchboard: Escape cancels, focus back on the button');
  await page.evaluate(() => { window.__FAKE.fail = { 'rpc.mod_set_switch': { message: 'not_admin', code: 'P0001' } }; });
  await page.click(`${sbAds} [data-act="askSwitch"]`); await page.waitForSelector(`${sbAds} [data-act="setSwitch"]`);
  await page.click(`${sbAds} [data-act="setSwitch"]`); await settle(page, 300);
  const ms = await rpcCalls(page, 'mod_set_switch');
  check(ms.length === 1 && JSON.stringify(ms[0].args) === '{"p_name":"ads","p_on":true}', `switchboard: mod_set_switch(p_name 'ads', p_on true) (${JSON.stringify(ms[0] && ms[0].args)})`);
  check((await lastToast(page)).includes('Only moderators can do that.') && admin.loads.n === 1, 'switchboard: a refusal is shown, and nothing reloads');
  await page.click(`${sbAds} [data-act="setSwitch"]`);
  await page.waitForFunction(() => /Ads are on/.test(document.getElementById('toasts').innerText), null, { timeout: 5000 });
  check(admin.loads.n === 2, `switchboard: the admin's page reloads once (${admin.loads.n} loads)`);
  check((await page.evaluate(k => localStorage.getItem(k), SW_KEY)) === '{"ads":true,"payments":false}', 'switchboard: the new switches are remembered');
  await page.waitForSelector(`${sbAds} .status.ok`);
  check((await page.evaluate(() => location.hash)) === '#moderation' && (await page.textContent(`${sbAds} [data-act="askSwitch"]`)).trim() === 'Turn ads off', 'switchboard: back on Moderation, offering to turn ads off');
  // phone: reachable from settings
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('.topbar [data-arg="profile"]'); await settle(page);
  check(!!(await page.$('#view [data-act="go"][data-arg="moderation"]')), 'admin: phone reaches Moderation from Settings');
  check(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, 'admin: no horizontal overflow at 390px');
  await page.click('#view [data-act="go"][data-arg="moderation"]'); await settle(page, 200);
  check(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, 'admin: moderation view fits 390px');
  await noErrors(errors, 'admin', [/not_found/, /not_admin/, /Object/]);
  await ctx.close();

  log('\n== Non-admin cannot route to moderation');
  const n = await open(OFF, { fake: { session: true }, label: 'nonadmin', hash: '#moderation' });
  await waitFeed(n.page);
  check((await n.page.evaluate(() => location.hash)) === '#feed', 'nonadmin: #moderation falls back to #feed');
  await noErrors(n.errors, 'nonadmin');
  await n.ctx.close();
}

/* ------------------------------------------------------------------ */
async function switchesOn() {
  log('\n== Live ignores SWITCHES: a copy with both on, database off');
  {
    const { ctx, page, errors, loads } = await open(ON, { fake: { session: true, ads: true }, label: 'switches-ignored' });
    await waitFeed(page); await settle(page, 300);
    check((await rpcCalls(page, 'app_switches')).length === 1, 'ignored: the app reads app_switches() at boot');
    check(!(await fromCalls(page, 'ads')).length && !(await fromCalls(page, 'ad_views')).length, 'ignored: the ads tables are never read');
    check(!(await page.$('[data-ad]')) && !(await page.$('[data-arg="tip"]')) && !(await page.$('[data-nav="wallet"]')), 'ignored: no ads, no Tip, no Wallet');
    const t = await bodyText(page);
    check(!MONEY.some(re => re.test(t)), 'ignored: no money copy');
    check(loads.n === 1 && (await page.evaluate(k => localStorage.getItem(k), SW_KEY)) === null, 'ignored: no reload, nothing to remember');
    await noErrors(errors, 'switches-ignored');
    await ctx.close();
  }

  log('\n== Live with both database switches on (committed index.html, SWITCHES off)');
  const { ctx, page, errors, loads } = await open(OFF, { fake: { session: true, ads: true, serverAds: true, serverPayments: true }, label: 'on' });
  await waitFeed(page);
  check(loads.n === 2, `on: one reload to pick up the server switches (${loads.n} loads)`);
  check((await page.evaluate(k => localStorage.getItem(k), SW_KEY)) === '{"ads":true,"payments":true}', 'on: the switches are remembered for next time');
  check((await fromCalls(page, 'ads', 'select')).length === 1 && (await fromCalls(page, 'ads', 'select'))[0].filters.some(f => f[1] === 'active' && f[2] === true), 'ads on: ads select active only');
  check((await fromCalls(page, 'ad_views', 'select')).length === 1, 'ads on: ad_views read for the ledger');
  await page.waitForSelector('[data-ad="11"]');
  check((await page.textContent('[data-ad="11"]')).includes('Pebble <Bank>'), 'ads on: ad from table, brand escaped');
  check((await rpcCalls(page, 'record_ad_view')).length === 0, 'ads on: no ad credit before the ad is seen');
  await page.$eval('[data-ad="11"]', e => e.scrollIntoView({ block: 'center' }));
  await page.waitForFunction(() => /Paid you/.test((document.querySelector('[data-ad="11"] .ad-pay') || {}).textContent || ''), null, { timeout: 4000 }).catch(() => {});
  const rv = await rpcCalls(page, 'record_ad_view');
  check(rv.length === 1 && rv[0].args.p_ad === 11 && rv[0].args.p_today === localDay(), 'ads on: record_ad_view(p_ad, p_today) when visible');
  check((await page.textContent('[data-ad="11"] .ad-pay')).includes('Paid you 10.5¢'), 'ads on: shows returned earnings');
  // tip → toast
  await page.click('[data-post="101"] [data-act="pop"][data-arg="tip"]');
  check((await lastToast(page)).includes(PAY_MSG), 'payments on: Tip shows not-connected toast');
  check(!(await page.$('[data-post="101"] .pop')), 'payments on: no tip popover in live');
  await page.click('.rail-foot [data-act="pro"]');
  check((await lastToast(page)).includes(PAY_MSG) && (await page.$eval('#modal', e => e.hidden)), 'payments on: Pro shows toast, no modal');
  await page.click('.rail [data-nav="wallet"]'); await settle(page);
  const w = await page.textContent('#view');
  check(!/demo/i.test(w), 'wallet: no demo money label');
  check(w.includes('$0.10') && w.includes('Ad view · Pebble <Bank>'), `wallet: balance and ledger from server earnings (${(w.match(/\$[\d.]+/) || [])[0]})`);
  await page.click('#view [data-act="addFunds"]');
  check((await lastToast(page)).includes(PAY_MSG), 'wallet: Add funds → toast');
  await page.click('#view [data-act="cashout"]');
  check((await lastToast(page)).includes(PAY_MSG), 'wallet: Cash out → toast');
  // attention price saved
  await page.$eval('#adPrice', e => { e.value = '9'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await settle(page, 1100);
  const ap = await callsOf(page, x => x.table === 'profiles' && x.op === 'update' && 'ad_price_cents' in (x.payload || {}));
  check(ap.length === 1 && ap[0].payload.ad_price_cents === 9, 'ads on: attention price → profiles.update {ad_price_cents}');
  // Save preset is Pro-gated while payments are on; live → toast
  await page.click('.rail [data-nav="algo"]'); await settle(page);
  await page.click('[data-act="savePreset"]');
  check((await lastToast(page)).includes(PAY_MSG), 'payments on: Pro-gated preset → toast');
  check(!DEMO_WORDS.test(await bodyText(page)), 'on: no demo wording');
  // The owner parks ads in SQL. The open page stays put; the next load follows the server.
  await page.evaluate(() => window.__fakeSettings({ ads_enabled: false }));
  await page.click('.rail [data-nav="feed"]');
  await page.reload(); await waitFeed(page); await settle(page, 300);
  check(loads.n === 4, `ads parked: the next load reloads once more (${loads.n} loads)`);
  check(!(await page.$('[data-ad]')) && !(await fromCalls(page, 'ads')).length && !!(await page.$('[data-arg="tip"]')), 'ads parked: no ads, payments still on');
  check(!(await allToasts(page)), `ads parked: no toast (${await allToasts(page)})`);
  await noErrors(errors, 'on');
  await ctx.close();

  log('\n== Live, payments only (database)');
  const p = await open(OFF, { fake: { session: true, ads: true, serverPayments: true }, label: 'payonly' });
  await waitFeed(p.page);
  check(p.loads.n === 2, 'payonly: one reload to pick up the server switches');
  check((await fromCalls(p.page, 'ads')).length === 0, 'payonly: ads table never read');
  check(!(await p.page.$('[data-ad]')), 'payonly: no ads');
  await p.page.click('.rail [data-nav="wallet"]'); await settle(p.page);
  const wt = await p.page.textContent('#view');
  check(wt.includes('$0.00') && !/attention/i.test(wt), 'payonly: balance $0.00 (nothing faked), no attention price');
  await noErrors(p.errors, 'payonly');
  await p.ctx.close();

  log('\n== Tampered switches cache: says on, the server says off');
  {
    const { ctx, page, errors, loads } = await open(OFF, { fake: { session: true, ads: true }, cache: '{"ads":true,"payments":true}', label: 'tampered' });
    await waitFeed(page); await settle(page, 300);
    check(loads.n === 2, `tampered: one reload (${loads.n} loads)`);
    check((await page.evaluate(k => localStorage.getItem(k), SW_KEY)) === '{"ads":false,"payments":false}', 'tampered: the cache now holds the server switches');
    check(!(await page.$('[data-ad]')) && !(await page.$('[data-arg="tip"]')) && !(await page.$('[data-nav="wallet"]')), 'tampered: no ads, no Tip, no Wallet');
    check(!(await fromCalls(page, 'ads')).length && !(await rpcCalls(page, 'record_ad_view')).length, 'tampered: no ads requests');
    check(!(await allToasts(page)), 'tampered: no toast');
    await noErrors(errors, 'tampered');
    await ctx.close();
  }
  log('\n== Tampered on every load (storage that will not keep the server value): no reload loop');
  {
    const { ctx, page, errors, loads } = await open(OFF, { fake: { session: true, ads: true }, cache: '{"ads":true,"payments":false}', once: false, label: 'stuck' });
    await waitFeed(page); await settle(page, 1500);
    check(loads.n === 2, `stuck: one reload, then it carries on (${loads.n} loads)`);
    await page.mouse.wheel(0, 3000); await settle(page, 400);
    check(!(await page.$('[data-ad]')), 'stuck: no ads while the server has them off');
    // Storage still says on after the reload (as when a write just before a reload isn't visible yet), but the reload
    // carried the server's switches in history.state, so this page runs with them.
    check(!(await page.$('[data-arg="tip"]')) && !(await page.$('[data-nav="wallet"]')), 'stuck: the reloaded page runs with the server switches, not the stale cache');
    check(!(await fromCalls(page, 'ads')).length && !(await rpcCalls(page, 'record_ad_view')).length, 'stuck: no ads requests, no ad credits');
    check(!(await allToasts(page)), `stuck: no toast (${await allToasts(page)})`);
    await noErrors(errors, 'stuck');
    await ctx.close();
  }
  log('\n== No storage at all: the app runs with everything off and never reloads');
  {
    const { ctx, page, errors, loads } = await open(OFF, { fake: { session: true, ads: true, serverAds: true }, label: 'nostorage' });
    await ctx.addInitScript(() => {
      for (const k of ['localStorage', 'sessionStorage']) Object.defineProperty(window, k, { get() { throw new Error('storage blocked'); }, configurable: true });
    });
    await page.reload(); await waitFeed(page); await settle(page, 1500);
    check(loads.n === 2, `nostorage: no reload loop (${loads.n} loads)`);
    check(!(await page.$('[data-ad]')) && !(await page.$('[data-nav="wallet"]')), 'nostorage: runs with everything off');
    await noErrors(errors, 'nostorage');
    await ctx.close();
  }
  log('\n== Storage that forgets the switches and the reload marker on every load: still no reload loop');
  {
    const { ctx, page, errors, loads } = await open(OFF, { fake: { session: true, ads: true, serverAds: true }, label: 'forgetful' });
    await waitFeed(page); await settle(page, 300);
    check(loads.n === 2 && !!(await page.$('[data-ad]')), `forgetful: one reload, then ads (${loads.n} loads)`);
    await ctx.addInitScript(k => { localStorage.removeItem(k); sessionStorage.removeItem(k + '.reload'); }, SW_KEY);
    await page.reload(); await waitFeed(page); await settle(page, 1500);
    check(loads.n === 4, `forgetful: one more reload, then it stops (${loads.n} loads)`);
    check(!!(await page.$('[data-ad]')) && (await fromCalls(page, 'ads')).length === 1, 'forgetful: the reload carried the switches (history.state), so ads show');
    check(!(await allToasts(page)), `forgetful: no toast (${await allToasts(page)})`);
    await noErrors(errors, 'forgetful');
    await ctx.close();
  }
}

/* ------------------------------------------------------------------ */
async function recoveryAndBan() {
  log('\n== Password recovery link');
  const { ctx, page, errors } = await open(OFF, { fake: { session: true }, label: 'recovery', hash: '#access_token=x&type=recovery' });
  await page.waitForSelector('#gate [data-form="recover"]');
  check((await gateText(page)).includes('Set a new password'), 'recovery: set-password form');
  await page.fill('#rc-password', 'short');
  await page.click('#gate [data-form="recover"] button.btn');
  check((await page.textContent('#gate .form-msg')).includes('at least 8'), 'recovery: short password rejected');
  await page.fill('#rc-password', 'a-new-password');
  await page.click('#gate [data-form="recover"] button.btn');
  await waitFeed(page);
  const uu = await callsOf(page, c => c.op === 'updateUser');
  check(uu.length === 1 && uu[0].attrs.password === 'a-new-password', 'recovery: updateUser({password})');
  check((await allToasts(page)).includes('Password updated.'), 'recovery: toast, then app');
  await noErrors(errors, 'recovery');
  await ctx.close();

  log('\n== Banned account');
  const b = await open(OFF, { fake: { session: true, banned: true }, label: 'banned' });
  await waitFeed(b.page);
  check((await b.page.textContent('#view')).includes('Your account is suspended'), 'banned: suspended note in feed');
  await b.page.fill('#composeText', 'try');
  await b.page.click('#composeForm button.btn');
  await b.page.waitForFunction(() => /suspended, so you can't/.test(document.getElementById('toasts').innerText));
  check(true, 'banned: posting error mapped');
  await noErrors(b.errors, 'banned', [/banned/, /Object/]);
  await b.ctx.close();

  log('\n== Phone layout, light theme');
  const m = await open(OFF, { fake: { session: true }, label: 'phone', width: 390, height: 844, scheme: 'light', mobile: true });
  await waitFeed(m.page);
  check((await m.page.$$('.tabbar button')).length === 4, 'phone: 4 tabs with switches off');
  const ov = await m.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(ov <= 0, `phone: no horizontal overflow (${ov})`);
  await m.page.screenshot({ path: path.join(SHOTS, 'live-phone-feed.png') });
  await m.page.click('.topbar [data-arg="profile"]'); await settle(m.page);
  await m.page.screenshot({ path: path.join(SHOTS, 'live-phone-profile.png'), fullPage: true });
  await noErrors(m.errors, 'phone');
  await m.ctx.close();
  const a = await open(OFF, { label: 'phone-auth', width: 390, height: 844, scheme: 'light', mobile: true });
  await a.page.waitForSelector('#gate [data-form="signin"]');
  await a.page.screenshot({ path: path.join(SHOTS, 'live-phone-signin.png') });
  await a.page.click('#tab-signup');
  check(await a.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, 'phone: sign-up form fits 390px');
  await a.page.screenshot({ path: path.join(SHOTS, 'live-phone-signup.png'), fullPage: true });
  await a.ctx.close();
  const d = await open(OFF, { label: 'desk-auth', scheme: 'dark' });
  await d.page.waitForSelector('#gate [data-form="signin"]');
  await d.page.screenshot({ path: path.join(SHOTS, 'live-desk-signin-dark.png') });
  await d.ctx.close();
}

/* ------------------------------------------------------------------ */
// The real supabase-js build (npm tarball, same bytes jsdelivr serves) under the default CDN URL: SRI must pass.
async function realClient() {
  log('\n== Real supabase-js 2.117.2 from the default CDN URL (SRI)');
  const real = fs.readFileSync(supabaseBuild());
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|Failed to load resource|ERR_|127\.0\.0\.1/.test(m.text())) errors.push('console ' + m.text()); });
  await ctx.addInitScript(() => { window.BENSOCIAL_BACKEND = { supabaseUrl: 'http://127.0.0.1:9', supabaseKey: 'sb_publishable_test' }; });
  await ctx.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js',
    r => r.fulfill({ status: 200, body: real, headers: { 'content-type': 'application/javascript', 'access-control-allow-origin': '*' } }));
  await page.goto(OFF);
  await page.waitForSelector('#gate [data-form="signin"]', { timeout: 10000 });
  check(true, 'real client: loads with SRI + crossorigin and shows sign-in (no session)');
  check(await page.evaluate(() => !!document.querySelector('script[integrity^="sha384-"][crossorigin="anonymous"]')), 'real client: script tag carries integrity');
  check(await page.evaluate(() => typeof window.supabase.createClient === 'function'), 'real client: global supabase.createClient');
  await page.fill('#auth-email', 'x@example.com'); await page.fill('#auth-password', 'whatever1');
  await page.click('#gate [data-form="signin"] button.btn');
  await page.waitForSelector('#gate .form-msg.err:not([hidden])', { timeout: 10000 });
  const msg = await page.textContent('#gate .form-msg');
  check(/Can't reach BenSocial|Something went wrong/.test(msg), `real client: unreachable backend → plain error (${msg})`);
  check(!errors.length, `real client: no page errors (${errors.join(' | ')})`);
  await ctx.close();
  // tampered bytes must be refused by SRI, from both CDNs
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  await ctx2.addInitScript(() => { window.BENSOCIAL_BACKEND = { supabaseUrl: 'http://127.0.0.1:9', supabaseAnonKey: 'k' }; });
  const tampered = r => r.fulfill({ status: 200, body: Buffer.concat([real, Buffer.from('\n//x')]), headers: { 'content-type': 'application/javascript', 'access-control-allow-origin': '*' } });
  await ctx2.route('https://cdn.jsdelivr.net/**', tampered);
  await ctx2.route('https://unpkg.com/**', tampered);
  await p2.goto(OFF);
  await p2.waitForSelector('#gate [data-act="retryLoad"]', { timeout: 10000 });
  check(true, 'real client: tampered CDN file is refused (SRI) → error screen');
  check((await gateText(p2)).includes('blocker'), 'real client: the error does not only blame the connection');
  await ctx2.close();
  // jsDelivr blocked: the same file (same hash) comes from unpkg.
  const ctx3 = await browser.newContext();
  const p3 = await ctx3.newPage();
  await ctx3.addInitScript(() => { window.BENSOCIAL_BACKEND = { supabaseUrl: 'http://127.0.0.1:9', supabaseKey: 'sb_publishable_test' }; });
  await ctx3.route('https://cdn.jsdelivr.net/**', r => r.abort());
  await ctx3.route('https://unpkg.com/@supabase/supabase-js@2.117.2/dist/umd/supabase.js',
    r => r.fulfill({ status: 200, body: real, headers: { 'content-type': 'application/javascript', 'access-control-allow-origin': '*' } }));
  await p3.goto(OFF);
  await p3.waitForSelector('#gate [data-form="signin"]', { timeout: 10000 });
  check(await p3.evaluate(() => { const s = document.querySelector('script[src^="https://unpkg.com/"]'); return !!s && s.integrity.startsWith('sha384-') && s.crossOrigin === 'anonymous'; }),
        'real client: with jsDelivr blocked, it loads from unpkg with the same integrity hash');
  await ctx3.close();
}


/* ------------------------------------------------------------------ */
async function extras() {
  log('\n== Missing profile → Finish your profile');
  const { ctx, page, errors } = await open(OFF, { fake: { session: true, noProfile: true }, label: 'finish' });
  await page.waitForSelector('#gate [data-form="finish"]');
  check((await gateText(page)).includes('Finish your profile'), 'finish: form shown when the profile row is missing');
  await page.fill('#fp-name', 'Fresh Person'); await page.fill('#fp-handle', 'Fresh.One');
  await page.click('#gate [data-form="finish"] button.btn');
  await waitFeed(page);
  const up = await callsOf(page, x => x.table === 'profiles' && x.op === 'update');
  check(up.length === 1 && up[0].payload.name === 'Fresh Person' && up[0].payload.handle === 'fresh.one', 'finish: touch_streak then profiles.update {name, handle (lowercase)}');
  check((await page.textContent('.me-card')).includes('Fresh Person'), 'finish: app boots with the new profile');
  await noErrors(errors, 'finish', [/not_found/, /Object/]);
  await ctx.close();

  log('\n== Prefs, reply report, person deep link');
  const b = await open(OFF, { fake: { session: true }, label: 'extras', hash: '#person:bbbbbbbb-0000-4000-8000-000000000002' });
  await b.page.waitForFunction(() => document.querySelector('#view h1') && document.querySelector('#view h1').textContent.includes('Ana Real'));
  check(true, 'deep link: #person:<uuid> opens after boot');
  check(!!(await b.page.$('#view [data-post="101"]')), 'deep link: their posts from posts_by');
  await b.page.click('[data-act="goBack"]'); await waitFeed(b.page);
  await b.page.click('[data-post="101"] [data-act="reply"]');
  await b.page.waitForSelector('[data-post="101"] .reply');
  await b.page.click('[data-post="101"] .reply [data-act="menu"]');
  await b.page.click('#menu [data-act="report"]');
  await b.page.check('#modalBody input[value="spam"]');
  await b.page.click('#modalBody [data-form="report"] button.btn:not([type])'); await settle(b.page);
  const rep = await fromCalls(b.page, 'reports', 'insert');
  check(rep.length === 1 && rep[0].payload.reply_id === 501 && rep[0].payload.reason === 'spam' && !('post_id' in rep[0].payload), `reply report: reports.insert {reply_id, reason, details} (${JSON.stringify(rep[0] && rep[0].payload)})`);
  await b.page.click('[data-act="tab"][data-arg="latest"]');
  await b.page.fill('#composeText', 'draft text');
  await settle(b.page, 500);
  const st = await b.page.evaluate(() => ({ live: JSON.parse(localStorage.getItem('bensocial.live.v1')), demo: localStorage.getItem('bensocial.v2') }));
  check(st.live && st.live.tab === 'latest' && st.live.draft === 'draft text' && st.live.dial && typeof st.live.dial.spicy === 'number', 'prefs: tab, draft and dial cached in bensocial.live.v1');
  check(st.demo === null, 'prefs: demo storage key untouched in live mode');
  check(Object.keys(st.live).sort().join() === 'dial,draft,tab,theme,view,welcomed', `prefs: only display prefs stored (${Object.keys(st.live).join()})`);
  await b.page.reload(); await waitFeed(b.page);
  check(await b.page.$eval('#composeText', e => e.value) === 'draft text' && await b.page.$eval('[data-act="tab"][data-arg="latest"]', e => e.getAttribute('aria-selected')) === 'true', 'prefs: draft and tab restored after reload');
  await noErrors(b.errors, 'extras');
  await b.ctx.close();
}

// WCAG contrast of an element's text against the first solid background behind it.
const contrastOf = (page, sel) => page.evaluate(sel => {
  const el = document.querySelector(sel); if (!el) return 0;
  const rgb = c => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  const lum = ([r, g, b]) => { const f = c => (c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  let n = el, bg = null;
  while (n && !bg) { const c = getComputedStyle(n).backgroundColor; if (c && !/^rgba\(.*,\s*0\)$/.test(c) && c !== 'transparent') bg = c; n = n.parentElement; }
  const a = lum(rgb(getComputedStyle(el).color)), b = lum(rgb(bg || 'rgb(255, 255, 255)'));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}, sel);
const overflowOf = page => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
async function fillSignup(page, email) {
  await page.click('#tab-signup');
  await page.fill('#su-name', 'New Person'); await page.fill('#su-handle', 'newbie_9'); await page.fill('#su-email', email);
  await page.fill('#su-password', 'long-enough-pw'); await page.check('#su-age'); await page.check('#su-terms');
  await settle(page, 500);
  await page.click('#gate [data-form="signup"] button.btn:not([type])');
}

async function fixes() {
  log('\n== Review fixes: BACKEND setup checks');
  const jwt = role => 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ role, iss: 'supabase' })).toString('base64url') + '.sig';
  for (const [label, backend, want] of [
    ['a secret key', { supabaseUrl: 'https://fake.supabase.test', supabaseKey: 'sb_secret_abc123' }, 'secret key'],
    ['the service_role key', { supabaseUrl: 'https://fake.supabase.test', supabaseKey: jwt('service_role') }, 'service_role key'],
    ['a URL with /rest/v1/', { supabaseUrl: 'https://fake.supabase.test/rest/v1/', supabaseKey: 'sb_publishable_x' }, 'with nothing after it'],
    ['a plain http URL', { supabaseUrl: 'http://fake.supabase.test', supabaseKey: 'sb_publishable_x' }, 'must start with https://'],
    ['a URL that is not one', { supabaseUrl: 'fake.supabase.test', supabaseKey: 'sb_publishable_x' }, 'not a web address'],
  ]) {
    const { ctx, page } = await open(OFF, { backend, label: 'setup' });
    await page.waitForFunction(() => /isn't set up correctly/.test(document.getElementById('gate').innerText), null, { timeout: 5000 });
    check((await gateText(page)).includes(want), `setup: ${label} is refused with a clear message`);
    check(!(await page.evaluate(() => !!document.querySelector('script[src]'))), `setup: ${label}: the client is never loaded`);
    await ctx.close();
  }
  {
    const { ctx, page, errors } = await open(OFF, { backend: { supabaseUrl: 'https://fake.supabase.test/', supabaseKey: jwt('anon') }, label: 'setup-ok' });
    await page.waitForSelector('#gate [data-form="signin"]');
    check(true, 'setup: an anon JWT and a trailing slash are fine');
    await noErrors(errors, 'setup-ok');
    await ctx.close();
  }
  {
    const { ctx, page } = await open(OFF, { fake: { authError: { status: 401, message: 'Invalid API key' } }, label: 'badkey' });
    await page.waitForSelector('#gate [data-form="signin"]');
    await page.fill('#auth-email', 'x@example.com'); await page.fill('#auth-password', 'whatever1');
    await page.click('#gate [data-form="signin"] button.btn');
    await page.waitForSelector('#gate .form-msg:not([hidden])');
    check((await page.textContent('#gate .form-msg')).includes('check supabaseUrl and supabaseKey'), 'setup: "Invalid API key" says what to check, not "Something went wrong"');
    await ctx.close();
  }

  log('\n== Review fixes: sign-up messages and Send again');
  for (const [mode, want, label] of [['duplicate', 'An account already uses that email. Sign in, or choose Forgot password.', 'an existing email (no identities)'],
    ['unauthorized', "We can't send email to that address yet.", 'an address the email sender refuses']]) {
    const { ctx, page } = await open(OFF, { fake: { signup: mode }, label: 'signup-' + mode });
    await page.waitForSelector('#gate [data-form="signin"]');
    await fillSignup(page, 'someone@example.com');
    await page.waitForFunction(w => (document.querySelector('#gate .form-msg') || {}).innerText && document.querySelector('#gate .form-msg').innerText.includes(w), want, { timeout: 4000 });
    check(!(await gateText(page)).includes('Check your email'), `signup: ${label} gets a plain message, and no promise of an email`);
    await ctx.close();
  }
  {
    const { ctx, page, errors } = await open(OFF, { label: 'resend' });
    await page.waitForSelector('#gate [data-form="signin"]');
    check(await page.locator('#gate [data-act="resend"]').isHidden(), 'resend: hidden until it is useful');
    await fillSignup(page, 'fresh@example.com');
    await page.waitForFunction(() => /Check your email/.test(document.getElementById('gate').innerText));
    check(await page.locator('#gate [data-act="resend"]').isVisible(), 'resend: offered after sign-up');
    await page.click('#gate [data-act="resend"]'); await settle(page, 200);
    const rs = await callsOf(page, c => c.op === 'resend');
    check(rs.length === 1 && rs[0].args.type === 'signup' && rs[0].args.email === 'fresh@example.com' && /index\.html$/.test(rs[0].args.options.emailRedirectTo), `resend: auth.resend({type: signup, email, emailRedirectTo}) (${JSON.stringify(rs[0] && rs[0].args)})`);
    check((await page.textContent('#gate .form-msg')).includes('we sent a new link'), 'resend: confirms in plain words');
    await noErrors(errors, 'resend');
    await ctx.close();
  }

  log('\n== Review fixes: legal links, focus after sign-in, contrast');
  {
    const legal = { termsUrl: 'https://example.com/terms', privacyUrl: 'javascript:alert(1)', contactEmail: 'help@example.com' };
    const { ctx, page, errors } = await open(OFF, { legal, label: 'legal', scheme: 'light' });
    await page.waitForSelector('#gate [data-form="signin"]');
    await page.click('#tab-signup');
    const consent = await page.textContent('#su-terms + span');
    check(consent.includes('Terms of Service') && consent.includes('Community Guidelines') && !consent.includes('Privacy Policy'), `legal: sign-up names the Terms, and ignores a privacy link that is not a web address (${consent})`);
    check(await page.$eval('#su-terms + span a', a => a.href === 'https://example.com/terms' && a.target === '_blank' && /noopener/.test(a.rel)), 'legal: the Terms link opens in a new tab');
    await page.fill('#su-handle', 'newbie_8');
    await page.waitForFunction(() => /Available/.test(document.getElementById('su-handle-status').textContent));
    const ok = await contrastOf(page, '#su-handle-status');
    check(ok >= 4.5, `contrast: "Available" is readable in light theme (${ok.toFixed(2)}:1)`);
    await page.click('#tab-signin');
    await page.fill('#auth-email', 'tester@example.com'); await page.fill('#auth-password', 'correct-horse');
    await page.click('#gate [data-form="signin"] button.btn');
    await waitFeed(page);
    check(await page.evaluate(() => document.activeElement && document.activeElement.id === 'view'), 'focus: after sign-in, keyboard focus is in the app, not on <body>');
    await page.click('.rail [data-nav="market"]'); await settle(page);
    const fine = await contrastOf(page, '#view .panel-head .fine');
    check(fine >= 4.5, `contrast: small print (.fine) is readable in light theme (${fine.toFixed(2)}:1)`);
    await page.click('.rail [data-nav="profile"]'); await settle(page);
    const st = await page.textContent('#view');
    check(st.includes('Terms of Service') && st.includes('help@example.com') && !st.includes('Privacy Policy'), 'legal: Settings lists the Terms and the contact address');
    check(await page.$eval('#view a[href^="mailto:"]', a => a.href === 'mailto:help@example.com'), 'legal: the contact address is a mail link');
    await page.click('#view [data-act="guidelines"]');
    check((await page.textContent('#modalBody')).includes('help@example.com'), 'legal: the Guidelines give the contact address');
    await page.keyboard.press('Escape');
    await noErrors(errors, 'legal');
    await ctx.close();
  }
  {
    const { ctx, page } = await open(OFF, { fake: { session: true }, label: 'dark-contrast', scheme: 'dark' });
    await waitFeed(page);
    await page.click('.rail [data-nav="market"]'); await settle(page);
    const fine = await contrastOf(page, '#view .panel-head .fine');
    check(fine >= 4.5, `contrast: small print (.fine) is readable in dark theme (${fine.toFixed(2)}:1)`);
    await ctx.close();
  }

  log('\n== Review fixes: long names, duels, counts, people, mod tools');
  {
    const { ctx, page, errors } = await open(OFF, { fake: { session: true, admin: true }, label: 'phone-fixes', width: 390, height: 844, scheme: 'light', mobile: true });
    await waitFeed(page);
    const LONG = 'Maximilianalexandertheodorvanderberghen';
    await page.evaluate(n => { window.__fakeDb.profiles[1].name = n; }, LONG);
    await page.evaluate(() => { location.hash = '#person:bbbbbbbb-0000-4000-8000-000000000002'; });
    await page.waitForFunction(n => document.querySelector('#view h1') && document.querySelector('#view h1').textContent.includes(n), LONG);
    await page.waitForSelector('#view [data-post="101"]');
    check(await overflowOf(page) <= 0, `long name: the person view fits 390px (${await overflowOf(page)}px over)`);
    const nb = await page.$eval('#view [data-post="101"] .name-btn', e => { const r = e.getBoundingClientRect(), b = e.closest('.post-body').getBoundingClientRect(); return r.right <= b.right + 1; });
    check(nb, 'long name: the post header name stays inside the post');
    await page.click('.topbar [data-arg="profile"]'); await settle(page);
    await page.click('#view [data-act="editProfile"]');
    await page.fill('#pf-name', LONG); await page.click('[data-form="profile"] button.btn:not([type])'); await settle(page, 300);
    check(await overflowOf(page) <= 0, `long name: your own profile fits 390px (${await overflowOf(page)}px over)`);
    await page.click('.topbar [data-arg="people"]');
    await page.waitForSelector('#peopleResults .person-row');
    check((await rpcCalls(page, 'search_people')).some(c => c.args.p_query === ''), 'people: opens with the newest members');
    check(await overflowOf(page) <= 0, 'people: fits 390px');
    await page.fill('#peopleQ', 'evil'); await settle(page, 600);
    check((await rpcCalls(page, 'search_people')).some(c => c.args.p_query === 'evil'), 'people: typing searches (debounced)');
    check((await page.textContent('#peopleResults')).includes('@evil_one') && (await page.textContent('#peopleResults')).includes('1 follower') && !(await page.textContent('#peopleResults')).includes('1 followers'), 'people: results, with 1 follower in the singular');
    await page.click('#peopleResults [data-act="follow"]'); await settle(page, 200);
    check((await fromCalls(page, 'follows', 'insert')).some(c => c.payload.followee === 'cccccccc-0000-4000-8000-000000000003'), 'people: Follow from the results');
    check((await page.textContent('#peopleResults [data-act="follow"]')).trim() === 'Following', 'people: the button says Following');
    await page.click('.tabbar [data-nav="duels"]'); await settle(page);
    check((await page.textContent('#view .lede')).includes('One question, two sides.'), 'duels: the live intro describes live duels');
    // Moderation: a reply report, a deleted one with its copy, and a profile report.
    await page.evaluate(() => {
      const base = { status: 'open', created_at: new Date().toISOString(), reporter_handle: 'ana.real', details: '', target_banned: false, post_removed: false, post_id: null, reply_id: null, profile_id: null };
      window.__fakeDb.reports_mod.push(
        Object.assign({}, base, { report_id: 901, reason: 'harassment', target_kind: 'reply', reply_id: 501, content: 'Reply with <b>tags</b>', target_user: 'cccccccc-0000-4000-8000-000000000003', target_handle: 'evil_one' }),
        Object.assign({}, base, { report_id: 902, reason: 'hate', target_kind: 'gone', content: 'deleted but copied', target_user: 'cccccccc-0000-4000-8000-000000000003', target_handle: 'evil_one' }),
        Object.assign({}, base, { report_id: 903, reason: 'other', target_kind: 'profile', profile_id: 'cccccccc-0000-4000-8000-000000000003', content: 'Evil', target_user: 'cccccccc-0000-4000-8000-000000000003', target_handle: 'evil_one' }));
    });
    await page.click('.topbar [data-arg="profile"]'); await settle(page);
    await page.click('#view [data-act="go"][data-arg="moderation"]');
    await page.waitForSelector('#view .mod-item[data-report="903"]');
    await page.click('#view .mod-item[data-report="901"] [data-act="modRemoveReply"][data-arg="1"]'); await settle(page, 300);
    const rr = await rpcCalls(page, 'mod_set_reply_removed');
    check(rr.length === 1 && rr[0].args.p_reply === 501 && rr[0].args.p_removed === true, 'mod: Remove reply calls mod_set_reply_removed');
    check(!!(await page.$('#view .mod-item[data-report="901"] [data-act="modRemoveReply"][data-arg="0"]')), 'mod: then offers Restore reply');
    const gone = await page.textContent('#view .mod-item[data-report="902"]');
    check(gone.includes('Its author deleted it.') && gone.includes('deleted but copied') && !!(await page.$('#view .mod-item[data-report="902"] [data-act="modBan"]')), 'mod: a deleted item shows its copy and a Ban button');
    await page.click('#view .mod-item[data-report="903"] [data-act="modResetProfile"]'); await settle(page, 300);
    const rp = await rpcCalls(page, 'mod_reset_profile');
    check(rp.length === 1 && rp[0].args.p_user === 'cccccccc-0000-4000-8000-000000000003', 'mod: Reset name and bio calls mod_reset_profile');
    check(await overflowOf(page) <= 0, 'mod: fits 390px');
    await noErrors(errors, 'phone-fixes');
    await ctx.close();
  }

  log('\n== Review fixes: notifications link to people and posts');
  {
    const { ctx, page, errors } = await open(OFF, { fake: { session: true }, label: 'notes' });
    await waitFeed(page);
    await page.click('.rail [data-nav="activity"]');
    await page.waitForSelector('#view .notes li');
    await page.click('#view .notes li:has-text("liked your post") [data-act="openNote"]');
    await page.waitForFunction(() => location.hash === '#profile');
    await page.waitForSelector('#view [data-post="103"].flash');
    check(true, 'notes: View post opens it on your profile');
    await page.click('.rail [data-nav="activity"]');
    await page.waitForSelector('#view .notes li');
    await page.click('#view .notes [data-act="person"][data-id="bbbbbbbb-0000-4000-8000-000000000002"]');
    await page.waitForFunction(() => document.querySelector('#view h1') && /Ana Real/.test(document.querySelector('#view h1').textContent));
    check(true, 'notes: the actor\'s name opens their profile');
    await page.evaluate(() => { location.hash = '#person:@ana.real'; });
    await page.waitForFunction(() => location.hash === '#person:bbbbbbbb-0000-4000-8000-000000000002');
    check(true, 'route: #person:@handle opens that profile');
    await page.click('#view .follow-counts [data-act="followList"][data-arg="followers"]');
    await page.waitForFunction(() => { const b = document.getElementById('followListBody'); return b && !/Loading/.test(b.innerText); });
    check((await fromCalls(page, 'follows', 'select')).some(c => c.filters.some(f => f[1] === 'followee' && f[2] === 'bbbbbbbb-0000-4000-8000-000000000002')), 'lists: followers come from the follows table');
    await page.keyboard.press('Escape');
    // Block someone: their notifications go away at once.
    await page.click('.rail [data-nav="feed"]'); await waitFeed(page);
    await page.click('[data-post="102"] [data-act="menu"]'); await page.click('#menu [data-act="askBlock"]'); await page.click('#modalBody [data-act="block"]'); await settle(page, 300);
    await page.click('.rail [data-nav="activity"]'); await page.waitForSelector('#view .notes li');
    check(!(await page.textContent('#view .notes')).includes('evil_one'), 'notes: notifications from someone you blocked disappear');
    await noErrors(errors, 'notes');
    await ctx.close();
  }

  log('\n== Review fixes: an ad turned off on the server leaves quietly');
  {
    const ADS = { session: true, ads: true, serverAds: true };
    const { ctx, page, errors, loads } = await open(OFF, { fake: ADS, cache: '{"ads":true,"payments":false}', label: 'ads-off' });
    await waitFeed(page);
    await page.waitForSelector('[data-ad="11"]');
    check(loads.n === 1, 'ads_off: a browser that already knows ads are on does not reload');
    await page.evaluate(() => window.__fakeSettings({ ads_enabled: false })); // The owner parks ads mid-session.
    await page.$eval('[data-ad="11"]', e => e.scrollIntoView({ block: 'center' }));
    await page.waitForFunction(() => !document.querySelector('[data-ad="11"]'), null, { timeout: 4000 });
    check(true, 'ads_off: the ad leaves the feed');
    check(!/running|went wrong|isn't available/i.test(await allToasts(page)), `ads_off: no error toast (${await allToasts(page)})`);
    check((await rpcCalls(page, 'record_ad_view')).length === 1, 'ads_off: not retried');
    await noErrors(errors, 'ads-off', [/ads_off/, /Object/]);
    await ctx.close();
  }
  {
    // The 30s poll already saw ads go off, so the ad leaves without asking the server to pay for it.
    const { ctx, page, errors } = await open(OFF, { fake: { session: true, ads: true, serverAds: true }, cache: '{"ads":true,"payments":false}', clock: true, label: 'ads-off-poll' });
    await waitFeed(page);
    await page.waitForSelector('[data-ad="11"]');
    await page.evaluate(() => window.__fakeSettings({ ads_enabled: false }));
    await page.clock.runFor(30500); await settle(page, 200);
    check((await page.evaluate(k => localStorage.getItem(k), SW_KEY)) === '{"ads":false,"payments":false}', 'ads_off poll: remembered for the next load');
    await page.$eval('[data-ad="11"]', e => e.scrollIntoView({ block: 'center' }));
    await page.waitForFunction(() => !document.querySelector('[data-ad="11"]'), null, { timeout: 4000 });
    check((await rpcCalls(page, 'record_ad_view')).length === 0, 'ads_off poll: the ad leaves without a record_ad_view call');
    check(!(await allToasts(page)), `ads_off poll: no toast (${await allToasts(page)})`);
    await noErrors(errors, 'ads-off-poll');
    await ctx.close();
  }
}

async function liveSweep() {
  log('\n== Live sweep, switches off: every view');
  for (const [w, h, scheme, mobile] of [[1360, 900, 'dark', false], [390, 844, 'light', true]]) {
    const tag = `sweep-${w}`;
    const { ctx, page, errors } = await open(OFF, { fake: { session: true, admin: true }, label: tag, width: w, height: h, scheme, mobile });
    await waitFeed(page);
    let all = '';
    for (const hash of ['#feed', '#algo', '#market', '#duels', '#activity', '#profile', '#moderation', '#person:bbbbbbbb-0000-4000-8000-000000000002', '#wallet']) {
      await page.evaluate(x => { location.hash = x; }, hash); await settle(page, 400);
      if (hash === '#wallet') check((await page.evaluate(() => location.hash)) === '#feed', `${tag}: #wallet falls back to #feed with switches off`);
      // The admin-only Switchboard is where ads and payments get turned on, so it names them. Nothing else may.
      if (hash === '#moderation') check(/\bAds\b/.test(await page.textContent('#switchboardPanel')), `${tag}: the Switchboard is on Moderation`);
      const sb = await page.$('#switchboardPanel'); if (sb) await sb.evaluate(e => { e.hidden = true; });
      all += '\n' + await bodyText(page);
      all += '\n' + await page.evaluate(() => [...document.querySelectorAll('[aria-label],[title],[placeholder]')].filter(e => !e.closest('#switchboardPanel')).map(e => [e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('placeholder')].filter(Boolean).join(' ')).join('\n'));
      if (sb) await sb.evaluate(e => { e.hidden = false; });
      if (mobile) check(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, `${tag}: no overflow on ${hash}`);
    }
    const leak = MONEY.filter(re => re.test(all)).map(re => (all.match(new RegExp('.{0,40}' + re.source + '.{0,40}', re.flags)) || [''])[0]);
    check(!leak.length, `${tag}: no money copy in any live view (${leak.join(' | ')})`);
    const demo = all.match(new RegExp('.{0,40}(' + DEMO_WORDS.source + ').{0,40}', 'i'));
    check(!demo, `${tag}: no demo/simulated wording in any live view (${demo && demo[0]})`);
    check(!(await page.$('[data-nav="wallet"]')), `${tag}: no Wallet nav`);
    await noErrors(errors, tag);
    await ctx.close();
  }
}

(async () => {
  browser = await launch();
  const only = process.argv[2];
  const suites = { authFlow, bootAndActions, noSimulation, loadFailure, admin, switchesOn, recoveryAndBan, realClient, extras, fixes, liveSweep };
  for (const [name, fn] of Object.entries(suites)) {
    if (only && only !== name) continue;
    try { await fn(); } catch (e) { failures.push(`${name} crashed: ${e.message.split('\n')[0]}`); console.log('  CRASH', name, e.stack.split('\n').slice(0, 4).join(' / ')); }
  }
  await browser.close();
  console.log(`\nRESULT: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map(f => ' - ' + f).join('\n')); process.exit(1); }
})();
