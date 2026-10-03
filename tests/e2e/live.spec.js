#!/usr/bin/env node
'use strict';
// =====================================================================
// Live mode, end to end: two people (A and B) in separate browsers and a
// moderator, against PostgREST + the auth stand-in + the real schema.
// Every step checks what the app shows and what landed in Postgres.
// Run through run.sh, which starts the stack and sets the env.
// =====================================================================

const {
  BASE, launch, db, begin, check, eq, near, until, summary, openUser, addPage, expectConsoleErrors, screenshots,
  toast, gateText, viewText, waitApp, waitAuth, go, postSel, withResponse, rpcPath, tablePath, localDay,
  signUpUI, signInUI, signOutUI,
} = require('./lib');

const PW = 'correct horse 42';
const A = { name: 'Ada Lovelace', handle: 'ada_e2e', email: 'ada@e2e.test', password: PW };
const B = { name: 'Bob Builder', handle: 'bob_e2e', email: 'bob@e2e.test', password: PW };
const M = { name: 'Mo Derator', handle: 'mod_e2e', email: 'mod@e2e.test', password: PW };

const POST1 = 'Hot take: tabs are better than spaces, and I will die on this hill.';
const POST1_EDIT = 'Hot take: tabs are better than spaces. Edited to be a little calmer.';
const POST_B = 'Fresh bread on a Sunday morning beats almost everything.';
const POST2 = 'Second post from Ada, for the block test.';
const REPLY = 'Spaces forever. Fight me.';
const BIO = 'Counting engines since 1843.';
const REPORT_NOTE = 'Posting the same thing every day.';
const SELF_REPLY = 'Thanks for reading, everyone.';

const num = v => Number(v);
// Text of the first match right now ('' if none). Wait for the element first when it may still be rendering.
const textOf = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); return e ? e.innerText : ''; }, sel);
const hasPost = (page, id) => page.locator(postSel(id)).count().then(n => n > 0);

// Clout Market curve from the spec (the schema rounds shares down to 6 dp, proceeds to the cent).
const base = p => 5 + 0.8 * Math.sqrt(Math.max(0, num(p.likes) + 2 * num(p.reposts) + 1.5 * num(p.replies) - 0.5 * num(p.dislikes)));
const buyShares = (p, M) => { const spot = base(p) + 0.05 * num(p.shares_outstanding); return Math.trunc(2 * M / (spot + Math.sqrt(spot * spot + 2 * 0.05 * M)) * 1e6) / 1e6; };
const sellProceeds = (p, h) => { const s = num(p.shares_outstanding); return Math.trunc((base(p) * h + 0.05 * h * (2 * s - h) / 2) * 100) / 100; };

const profile = id => db.one('select * from public.profiles where id = $1', [id]);
const clout = async id => num((await profile(id)).clout);

async function main() {
  const browser = await launch();
  const users = [];
  let ok = false;
  try {
    // ------------------------------------------------------------ A signs up
    begin('A signs up through the app');
    const ua = await openUser(browser, 'A'); users.push(ua);
    await waitAuth(ua.page);
    const gate = await gateText(ua.page);
    check(gate.includes('The social network with nothing to hide.'), 'auth screen shows the tagline');
    check(gate.includes('Sign in') && gate.includes('Create account'), 'auth screen has both tabs');
    await ua.page.click('#tab-signup');
    await ua.page.fill('#su-handle', 'Ada!');
    await ua.page.locator('#su-handle-status', { hasText: 'Use up to 20 lowercase' }).waitFor();
    check(true, 'handle with bad characters is flagged');
    await signUpUI(ua.page, A);
    const rowA = await db.one(`select u.id, u.raw_user_meta_data as meta, p.* from auth.users u join public.profiles p using (id) where u.email = $1`, [A.email]);
    A.id = rowA && rowA.id;
    check(!!A.id, 'auth.users and profiles rows exist for A');
    eq(rowA.handle, A.handle, 'profile handle comes from the sign-up form');
    eq(rowA.name, A.name, 'profile name comes from the sign-up form');
    eq(rowA.meta.handle, A.handle, 'sign-up metadata carries the handle');
    check(rowA.accepted_terms_at != null, 'accepted_terms_at is set');
    eq(num(rowA.clout), 500, 'new account starts with 500 clout');
    eq(rowA.streak, 1, 'touch_streak ran at boot (streak 1)');
    eq(String(rowA.last_active && localDay(rowA.last_active)), localDay(), 'last_active is today');
    check((await textOf(ua.page, '#rail .me-name')).includes(A.name), 'rail shows the signed-in name');

    // ------------------------------------------------------------ sign out and in
    begin('A signs out and back in');
    await signOutUI(ua.page);
    check((await gateText(ua.page)).includes('Sign in'), 'sign-out returns to the sign-in screen');
    check(await ua.page.evaluate(() => document.getElementById('view').innerHTML === ''), 'app views are cleared on sign-out');
    await expectConsoleErrors(ua, /status of 400/, async () => {
      await signInUI(ua.page, A.email, 'wrong password');
      await ua.page.locator('#gate .form-msg', { hasText: "That email and password don't match." }).waitFor();
    });
    check(true, 'wrong password shows a plain error');
    await signInUI(ua.page, A.email, A.password);
    await waitApp(ua.page);
    check((await textOf(ua.page, '#rail .me-name')).includes(A.name), 'signed back in as A');
    eq(await ua.page.evaluate(() => location.hash), '#profile', 'the app reopens the last view');
    await go(ua.page, 'feed');

    // ------------------------------------------------------------ A posts
    begin('A posts with a mood');
    await ua.page.fill('#composeText', POST1);
    await ua.page.click('#composeForm [data-act="mood"][data-arg="spicy"]');
    eq(await ua.page.getAttribute('#composeForm [data-act="mood"][data-arg="spicy"]', 'aria-pressed'), 'true', 'mood chip is pressed');
    // A slow connection and an impatient double submit: the post goes out once.
    const slowPost = u => u.pathname === '/rest/v1/posts';
    const delayPost = async route => { if (route.request().method() === 'POST') await new Promise(r => setTimeout(r, 400)); await route.continue(); };
    await ua.ctx.route(slowPost, delayPost);
    await withResponse(ua.page, tablePath('posts', 'POST'), async () => {
      await ua.page.click('#composeForm button:not([type])');
      await ua.page.evaluate(() => { const f = document.getElementById('composeForm'); f.requestSubmit(); f.requestSubmit(); });
      await ua.page.keyboard.press('Enter');
    });
    await toast(ua.page, 'Posted.');
    await ua.ctx.unroute(slowPost, delayPost);
    await ua.page.waitForTimeout(300);
    eq(await db.val('select count(*)::int from public.posts where author_id = $1', [A.id]), 1, 'submitting again while the post is on its way posts once');
    const p1 = await db.one('select * from public.posts where author_id = $1', [A.id]);
    const pid = p1 && String(p1.id);
    check(!!pid, 'post row exists');
    eq(p1.body, POST1, 'post body saved');
    eq(p1.mood, 'spicy', 'post mood saved');
    near(p1.spicy, 0.8, 1e-6, 'spicy weight set from mood');
    near(p1.wholesome, 0.1, 1e-6, 'wholesome weight set from mood');
    await ua.page.waitForSelector(postSel(pid));
    check((await textOf(ua.page, postSel(pid))).includes(POST1), 'A sees the post in the feed');
    eq(await until(async () => (await profile(A.id)).xp === 25 && 25), 25, 'A got 25 XP for posting');
    await until(async () => (await textOf(ua.page, '#live [data-me="xptext"]')) === '25 / 100 XP');
    eq(await textOf(ua.page, '#live [data-me="xptext"]'), '25 / 100 XP', 'XP shown comes from the server');
    eq(await textOf(ua.page, '#view .empty'), '', 'no empty-feed message');

    // ------------------------------------------------------------ B signs up, sees A's post
    begin('B signs up and sees A\'s post');
    const ub = await openUser(browser, 'B'); users.push(ub);
    await waitAuth(ub.page);
    await ub.page.click('#tab-signup');
    await ub.page.fill('#su-handle', A.handle);
    await ub.page.locator('#su-handle-status', { hasText: 'Taken' }).waitFor();
    check(true, 'a handle in use shows Taken');
    await signUpUI(ub.page, B);
    B.id = await db.val('select id from auth.users where email = $1', [B.email]);
    eq(await db.val('select handle from public.profiles where id = $1', [B.id]), B.handle, 'B profile created with the chosen handle');
    await ub.page.waitForSelector(postSel(pid));
    check((await textOf(ub.page, postSel(pid))).includes('@' + A.handle), 'B sees A\'s post in For you, with A\'s handle');
    await ub.page.click('#view [data-act="tab"][data-arg="latest"]');
    await ub.page.waitForSelector(postSel(pid));
    check(true, 'B sees A\'s post in Latest');
    await ub.page.click('#view [data-act="tab"][data-arg="following"]');
    check(!(await hasPost(ub.page, pid)), 'Following is empty before B follows anyone');
    await ub.page.click('#view [data-act="tab"][data-arg="foryou"]');
    await ub.page.waitForSelector(postSel(pid));

    // ------------------------------------------------------------ follow
    begin('B follows A');
    await withResponse(ub.page, tablePath('follows', 'POST'), () => ub.page.click(`${postSel(pid)} [data-act="follow"][data-id="${A.id}"]`));
    await ub.page.locator(`${postSel(pid)} [data-act="follow"]`, { hasText: 'Following' }).waitFor();
    check(true, 'follow button says Following');
    check(!!(await db.one('select 1 from public.follows where follower = $1 and followee = $2', [B.id, A.id])), 'follows row saved');
    eq((await profile(A.id)).followers_count, 1, 'A followers_count is 1');
    eq((await profile(B.id)).following_count, 1, 'B following_count is 1');
    eq(await db.val(`select count(*)::int from public.notifications where user_id = $1 and actor_id = $2 and kind = 'follow'`, [A.id, B.id]), 1, 'A got a follow notification');
    await ub.page.click('#view [data-act="tab"][data-arg="following"]');
    await ub.page.waitForSelector(postSel(pid));
    check(true, 'A\'s post now shows in Following');
    await ub.page.click('#view [data-act="tab"][data-arg="foryou"]');

    // ------------------------------------------------------------ person view
    begin('B opens A\'s person view');
    await ub.page.click(`${postSel(pid)} .name-btn`);
    await ub.page.waitForSelector('#view .person-card');
    await ub.page.waitForSelector(postSel(pid));
    const pv = await viewText(ub.page);
    check(pv.includes(A.name) && pv.includes('@' + A.handle), 'person view shows name and handle');
    check(/1\s+follower\b/.test(pv) && !/1\s+followers/.test(pv) && /0\s+following/.test(pv), 'person view shows follower counts from the server, in the singular for 1');
    eq(await textOf(ub.page, '#view .person-tools [data-act="follow"]'), 'Following', 'person view shows Following');
    eq(await ub.page.evaluate(() => location.hash), '#person:' + A.id, 'person view has its own address');
    await ub.page.click('#view .follow-counts [data-act="followList"][data-arg="followers"]');
    await ub.page.locator('#modalBody .person-row', { hasText: B.name }).waitFor();
    check((await textOf(ub.page, '#modalBody')).includes('Followers'), 'the follower count opens the list of followers');
    await ub.page.keyboard.press('Escape');
    await ub.page.click('#view [data-act="goBack"]');
    await ub.page.waitForSelector(postSel(pid));

    begin('B finds people by name or handle, and by a shared link');
    await go(ub.page, 'people');
    await ub.page.locator('#peopleResults .person-row', { hasText: A.name }).waitFor();
    check((await textOf(ub.page, '#peopleResults')).includes('Newest members'), 'with nothing typed, the newest members are listed');
    await withResponse(ub.page, rpcPath('search_people'), () => ub.page.fill('#peopleQ', 'lovelace'));
    await ub.page.waitForFunction(() => /@ada_e2e/.test(document.getElementById('peopleResults').innerText) && /^People/.test(document.getElementById('peopleResults').innerText));
    check(true, 'a search by name finds A');
    eq(await textOf(ub.page, `#peopleResults [data-act="follow"][data-id="${A.id}"]`), 'Following', 'results show that B follows A');
    await withResponse(ub.page, rpcPath('search_people'), () => ub.page.fill('#peopleQ', 'nobody-like-this'));
    await ub.page.locator('#peopleResults', { hasText: 'Nobody matches' }).waitFor();
    check(true, 'no match says so');
    await ub.page.evaluate(h => { location.hash = '#person:@' + h; }, A.handle);
    await ub.page.waitForFunction(id => location.hash === '#person:' + id, A.id);
    await ub.page.waitForSelector('#view .person-card');
    check((await viewText(ub.page)).includes('@' + A.handle), 'a #person:@handle link opens that profile');
    await go(ub.page, 'feed');
    await ub.page.waitForSelector(postSel(pid));

    // ------------------------------------------------------------ algorithm dial
    begin('B tunes the algorithm; it is saved to the profile');
    await go(ub.page, 'algo');
    await withResponse(ub.page, tablePath('profiles', 'PATCH'), () => ub.page.evaluate(() => {
      const r = document.getElementById('dial-spicy'); r.value = '80'; r.dispatchEvent(new Event('input', { bubbles: true }));
    }));
    let dial = (await profile(B.id)).dial;
    eq(dial && [dial.spicy, dial.tuned], [80, true], 'profiles.dial has the new weight and the tuned flag');
    await withResponse(ub.page, tablePath('profiles', 'PATCH'), () => ub.page.click('#view [data-act="savePreset"]'));
    dial = (await profile(B.id)).dial;
    eq(dial && dial.presets && dial.presets.map(x => [x.label, x.spicy]), [['My mix 1', 80]], 'saved preset stored in profiles.dial');
    check(!(await textOf(ub.page, '#view [data-act="savePreset"]')).includes('Pro'), 'saving presets is free while payments are off');
    await ub.page.reload(); await waitApp(ub.page);
    eq(await ub.page.inputValue('#dial-spicy'), '80', 'the dial comes back from the server after a reload');
    await ub.page.locator('#view [data-act="myPreset"]', { hasText: 'My mix 1' }).waitFor();
    await go(ub.page, 'feed');
    await ub.page.waitForSelector(postSel(pid));

    // ------------------------------------------------------------ reactions
    begin('B likes, dislikes, then clears the reaction');
    const like = `${postSel(pid)} [data-act="like"]`, dislike = `${postSel(pid)} [data-act="dislike"]`;
    const counts = () => db.one('select likes, dislikes from public.posts where id = $1', [pid]);
    const reaction = () => db.val('select kind from public.reactions where user_id = $1 and post_id = $2', [B.id, pid]);
    await withResponse(ub.page, tablePath('reactions', 'POST'), () => ub.page.click(like));
    eq(await counts(), { likes: 1, dislikes: 0 }, 'like: posts.likes = 1');
    eq(await reaction(), 'like', 'like: reaction row is like');
    eq(await textOf(ub.page, `[data-b="likes:${pid}"]`), '1', 'like: count shows 1');
    eq(await ub.page.getAttribute(like, 'aria-pressed'), 'true', 'like: button pressed');
    await withResponse(ub.page, tablePath('reactions', 'POST'), () => ub.page.click(dislike));
    eq(await counts(), { likes: 0, dislikes: 1 }, 'dislike: likes 0, dislikes 1');
    eq(await reaction(), 'dislike', 'dislike: same row switched to dislike');
    eq(await textOf(ub.page, `[data-b="dislikes:${pid}"]`), '1', 'dislike: count shows 1');
    eq(await textOf(ub.page, `[data-b="likes:${pid}"]`), '0', 'dislike: like count back to 0');
    await withResponse(ub.page, tablePath('reactions', 'DELETE'), () => ub.page.click(dislike));
    eq(await counts(), { likes: 0, dislikes: 0 }, 'clear: both counters 0');
    eq(await reaction(), null, 'clear: reaction row deleted');
    eq(await ub.page.getAttribute(dislike, 'aria-pressed'), 'false', 'clear: dislike not pressed');
    eq(await db.val(`select count(*)::int from public.notifications where user_id = $1 and kind = 'like'`, [A.id]), 1, 'A got exactly one like notification');
    eq(await db.val(`select count(*)::int from public.xp_log where user_id = $1 and reason = 'like'`, [B.id]), 1, 'like XP granted once');

    begin('A slow like, then an unlike right after: the last tap wins');
    const slowReact = u => u.pathname === '/rest/v1/reactions';
    let held = 0;
    const holdFirst = async route => { if (route.request().method() === 'POST' && !held++) await new Promise(r => setTimeout(r, 700)); await route.continue(); };
    await ub.ctx.route(slowReact, holdFirst);
    const reactReqs = [];
    const onReq = r => { if (new URL(r.url()).pathname === '/rest/v1/reactions') reactReqs.push(r.method()); };
    ub.page.on('request', onReq);
    await ub.page.click(like);
    await ub.page.waitForTimeout(150);
    await ub.page.click(like); // Unlike while the like is still on its way.
    eq(await ub.page.getAttribute(like, 'aria-pressed'), 'false', 'the screen shows the unlike at once');
    await until(async () => reactReqs.length === 2 && (await reaction()) === null, { timeout: 5000 });
    ub.page.off('request', onReq);
    await ub.ctx.unroute(slowReact, holdFirst);
    eq(reactReqs, ['POST', 'DELETE'], 'the unlike is sent after the like lands, not alongside it');
    eq(await reaction(), null, 'the database ends with no reaction, like the screen');
    eq(await counts(), { likes: 0, dislikes: 0 }, 'and the counters agree');
    eq(await textOf(ub.page, `[data-b="likes:${pid}"]`), '0', 'the screen shows 0 likes');

    begin('B reposts, then undoes it');
    const repost = `${postSel(pid)} [data-act="repost"]`;
    await withResponse(ub.page, tablePath('reposts', 'POST'), () => ub.page.click(repost));
    await toast(ub.page, 'Reposted to your followers.');
    eq((await db.one('select reposts from public.posts where id = $1', [pid])).reposts, 1, 'posts.reposts = 1');
    eq(await db.val('select count(*)::int from public.reposts where user_id = $1 and post_id = $2', [B.id, pid]), 1, 'reposts row saved');
    eq(await db.val(`select count(*)::int from public.notifications where user_id = $1 and kind = 'repost'`, [A.id]), 1, 'A got a repost notification');
    await withResponse(ub.page, tablePath('reposts', 'DELETE'), () => ub.page.click(repost));
    eq((await db.one('select reposts from public.posts where id = $1', [pid])).reposts, 0, 'undo: posts.reposts = 0');
    eq(await db.val('select count(*)::int from public.reposts where user_id = $1', [B.id]), 0, 'undo: reposts row deleted');
    eq(await textOf(ub.page, `[data-b="reposts:${pid}"]`), '0', 'undo: count shows 0');

    // ------------------------------------------------------------ reply, notification, new-post pill
    begin('B replies; A gets a notification, the unread badge and the new-post pill');
    // A slow connection: the replies take a moment to load, and B starts typing right away.
    const slowReplies = u => u.pathname === '/rest/v1/replies';
    const delay = async route => { if (route.request().method() === 'GET') await new Promise(r => setTimeout(r, 1200)); await route.continue(); };
    await ub.ctx.route(slowReplies, delay);
    const repliesLoaded = ub.page.waitForResponse(tablePath('replies', 'GET'));
    await ub.page.click(`${postSel(pid)} [data-act="reply"]`);
    await ub.page.type(`#reply-${pid}`, REPLY);
    await repliesLoaded;
    await ub.page.waitForTimeout(100);
    eq(await ub.page.inputValue(`#reply-${pid}`), REPLY, 'text typed while replies load is kept');
    await ub.ctx.unroute(slowReplies, delay);
    await withResponse(ub.page, tablePath('replies', 'POST'), () => ub.page.press(`#reply-${pid}`, 'Enter'));
    await ub.page.locator(`${postSel(pid)} .reply`, { hasText: REPLY }).waitFor();
    check(true, 'reply shows under the post');
    eq(await ub.page.inputValue(`#reply-${pid}`), '', 'reply box is empty after posting');
    const rp = await db.one('select * from public.replies where post_id = $1', [pid]);
    eq(rp && rp.body, REPLY, 'reply row saved');
    eq(rp && rp.author_id, B.id, 'reply author is B');
    eq((await db.one('select replies from public.posts where id = $1', [pid])).replies, 1, 'posts.replies = 1');
    const rn = await db.one(`select data from public.notifications where user_id = $1 and kind = 'reply'`, [A.id]);
    eq(rn && rn.data.excerpt, REPLY, 'A got a reply notification with the excerpt');
    // B posts too, so A's next poll has a new post to announce.
    await ub.page.fill('#composeText', POST_B);
    await ub.page.click('#composeForm [data-act="mood"][data-arg="wholesome"]');
    await withResponse(ub.page, tablePath('posts', 'POST'), () => ub.page.click('#composeForm button:not([type])'));
    await toast(ub.page, 'Posted.');
    const bpid = String(await db.val('select id from public.posts where author_id = $1', [B.id]));
    const unreadA = await db.val('select count(*)::int from public.notifications where user_id = $1 and not read', [A.id]);
    eq(unreadA, 4, 'A has 4 unread notifications (follow, like, repost, reply)');
    console.log('   waiting for A\'s 30-second poll ...');
    await ua.page.locator('#rail [data-me="unread"]:not([hidden])').waitFor({ timeout: 40000 });
    eq(await textOf(ua.page, '#rail [data-me="unread"]'), String(unreadA), 'unread badge shows the server count');
    await ua.page.locator('#newPill .new-pill', { hasText: 'Show 1 new post' }).waitFor({ timeout: 5000 });
    check(true, 'new-post pill counts B\'s post');
    await withResponse(ua.page, rpcPath('feed'), () => ua.page.click('#newPill .new-pill'));
    await ua.page.waitForSelector(postSel(bpid));
    check(true, 'clicking the pill loads B\'s post');
    await go(ua.page, 'activity');
    await ua.page.locator('#view .notes li', { hasText: 'replied to your post' }).waitFor();
    const notes = await viewText(ua.page);
    check(notes.includes(`@${B.handle} replied to your post: “${REPLY}”`), 'Activity shows the reply with its excerpt');
    check(notes.includes(`@${B.handle} started following you`), 'Activity shows the follow');
    check(notes.includes(`@${B.handle} liked your post`), 'Activity shows the like');
    check(notes.includes(`@${B.handle} reposted your post`), 'Activity shows the repost');
    check(await ua.page.locator(`#view .notes [data-act="person"][data-id="${B.id}"]`).count() >= 4, 'each note names B as a link to B\'s profile');
    check(await ua.page.locator(`#view .notes [data-act="openNote"][data-id="${pid}"][data-arg="reply"]`).isVisible(), 'the reply note links to the reply');
    await until(async () => (await db.val('select count(*)::int from public.notifications where user_id = $1 and not read', [A.id])) === 0);
    eq(await db.val('select count(*)::int from public.notifications where user_id = $1 and not read', [A.id]), 0, 'opening Activity marks notifications read');
    check(await ua.page.locator('#rail [data-me="unread"]').isHidden(), 'unread badge cleared');
    await ua.page.click(`#view .notes li:has-text("liked your post") [data-act="openNote"]`);
    await ua.page.waitForFunction(() => location.hash === '#profile');
    await ua.page.waitForSelector(`#view ${postSel(pid).replace('#view ', '')}.flash`);
    check(true, 'View post opens the post on A\'s profile');
    await go(ua.page, 'activity');
    await ua.page.locator('#view .notes li', { hasText: 'started following you' }).waitFor();
    await ua.page.click(`#view .notes li:has-text("started following you") [data-act="person"]`);
    await ua.page.waitForSelector('#view .person-card');
    check((await viewText(ua.page)).includes('@' + B.handle), 'the name in a follow note opens their profile, to follow back');

    // ------------------------------------------------------------ edit + receipt
    begin('A reads the thread, replies to their own post, then deletes that reply');
    await go(ua.page, 'feed');
    await withResponse(ua.page, tablePath('replies', 'GET'), () => ua.page.click(`${postSel(pid)} [data-act="reply"]`));
    await ua.page.locator(`${postSel(pid)} .reply`, { hasText: REPLY }).waitFor();
    check((await textOf(ua.page, `${postSel(pid)} .reply`)).includes(B.name), 'A sees B\'s reply with B\'s name');
    await ua.page.fill(`#reply-${pid}`, SELF_REPLY);
    await withResponse(ua.page, tablePath('replies', 'POST'), () => ua.page.press(`#reply-${pid}`, 'Enter'));
    const selfReply = String(await db.val('select id from public.replies where author_id = $1', [A.id]));
    eq((await db.one('select replies from public.posts where id = $1', [pid])).replies, 2, 'posts.replies = 2');
    eq(await db.val('select count(*)::int from public.notifications where user_id = $1 and actor_id = $1', [A.id]), 0, 'no notification for replying to yourself');
    await ua.page.click(`${postSel(pid)} [data-act="menu"][data-id="reply:${pid}:${selfReply}"]`);
    await ua.page.click('#menu [data-act="askDelete"]');
    await withResponse(ua.page, tablePath('replies', 'DELETE'), () => ua.page.click(`${postSel(pid)} [data-reply="${selfReply}"] [data-act="confirmDelete"]`));
    await toast(ua.page, 'Reply deleted.');
    eq(await db.val('select count(*)::int from public.replies where id = $1', [selfReply]), 0, 'reply row deleted');
    eq((await db.one('select replies from public.posts where id = $1', [pid])).replies, 1, 'posts.replies back to 1');
    check(!(await ua.page.locator(`${postSel(pid)} [data-reply="${selfReply}"]`).count()), 'deleted reply is gone from the thread');
    await ua.page.click(`${postSel(pid)} [data-act="reply"]`); // Close the thread.

    begin('A edits the post; B opens the receipt');
    await ua.page.click(`${postSel(pid)} [data-act="menu"]`);
    await ua.page.click('#menu [data-act="edit"]');
    await ua.page.fill(`#edit-${pid}`, POST1_EDIT);
    await withResponse(ua.page, tablePath('posts', 'PATCH'), () => ua.page.click(`${postSel(pid)} form[data-form="edit"] button:not([type])`));
    await toast(ua.page, 'Edit saved.');
    const p1e = await db.one('select body, edited_at from public.posts where id = $1', [pid]);
    eq(p1e.body, POST1_EDIT, 'posts.body updated');
    check(p1e.edited_at != null, 'edited_at set');
    eq((await db.rows('select body from public.post_edits where post_id = $1', [pid])).map(r => r.body), [POST1], 'post_edits holds the original');
    check((await textOf(ua.page, `${postSel(pid)} [data-act="receipts"]`)).includes('2 versions'), 'A sees the receipt link');
    await ub.page.reload(); await waitApp(ub.page);
    await ub.page.waitForSelector(postSel(pid));
    check((await textOf(ub.page, `${postSel(pid)} .post-text`)) === POST1_EDIT, 'B sees the edited text');
    await withResponse(ub.page, tablePath('post_edits', 'GET'), () => ub.page.click(`${postSel(pid)} [data-act="receipts"]`));
    await ub.page.waitForSelector('#modalBody .receipt');
    const receipt = await textOf(ub.page, '#modalBody .receipt');
    check(receipt.includes(POST1) && receipt.includes(POST1_EDIT), 'receipt shows both versions');
    check(/V1\s+ORIGINAL/.test(receipt) && /V2\s+CURRENT/.test(receipt), 'receipt labels the original and current versions');
    check(receipt.includes('1 EDIT'), 'receipt counts one edit');
    await ub.page.keyboard.press('Escape');

    // ------------------------------------------------------------ back + sell
    begin('B backs A\'s post, then sells');
    const before = await db.one('select likes, dislikes, replies, reposts, shares_outstanding from public.posts where id = $1', [pid]);
    const c0 = await clout(B.id);
    const wantShares = buyShares(before, 100);
    await ub.page.click(`${postSel(pid)} [data-act="pop"][data-arg="back"]`);
    // A slow connection and a double-click: the clout is spent once.
    const slowBack = u => u.pathname === '/rest/v1/rpc/back_post';
    const delayBack = async route => { await new Promise(r => setTimeout(r, 400)); await route.continue(); };
    await ub.ctx.route(slowBack, delayBack);
    await withResponse(ub.page, rpcPath('back_post'), () => ub.page.dblclick(`${postSel(pid)} .pop [data-act="back"][data-arg="100"]`));
    await toast(ub.page, `Backed @${A.handle} with 100 clout.`);
    await ub.ctx.unroute(slowBack, delayBack);
    await ub.page.waitForTimeout(300);
    eq(ub.requests.filter(x => x.includes('/rpc/back_post')).length, 1, 'a double-click on Back sends one back_post');
    const pos = await db.one('select shares, cost from public.positions where user_id = $1 and post_id = $2', [B.id, pid]);
    near(pos && pos.shares, wantShares, 2e-6, 'shares follow the bonding curve');
    eq(num(pos && pos.cost), 100, 'position cost is 100');
    near(await clout(B.id), c0 - 100, 1e-9, 'B paid 100 clout');
    const after = await db.one('select likes, dislikes, replies, reposts, shares_outstanding, price from public.posts where id = $1', [pid]);
    near(after.shares_outstanding, num(pos.shares), 1e-9, 'shares_outstanding grew by the shares bought');
    near(after.price, Math.round((base(after) + 0.05 * num(after.shares_outstanding)) * 1e4) / 1e4, 1e-4, 'price recomputed on the curve');
    eq(await db.val(`select (data->>'amount')::numeric::int from public.notifications where user_id = $1 and kind = 'back'`, [A.id]), 100, 'A got a back notification');
    await go(ub.page, 'market');
    await ub.page.waitForSelector(`#view [data-act="sell"][data-id="${pid}"]`);
    const wantProceeds = sellProceeds(after, num(pos.shares));
    eq(await textOf(ub.page, `#view [data-b="hv:${pid}"]`), String(Math.round(wantProceeds)), 'Market values the position at what selling pays now');
    check(/^[+−]0$/.test(await textOf(ub.page, '#view [data-b="pf:pl"]')), 'a fresh position shows no made-up profit');
    await withResponse(ub.page, rpcPath('sell_position'), () => ub.page.click(`#view [data-act="sell"][data-id="${pid}"]`));
    await toast(ub.page, 'Sold for');
    eq(await db.val('select count(*)::int from public.positions where user_id = $1', [B.id]), 0, 'position closed');
    const c1 = await clout(B.id);
    near(c1, c0 - 100 + wantProceeds, 0.011, 'clout after selling matches the curve');
    check(c1 <= c0 && c1 >= c0 - 0.01, `a round trip never gains clout and loses at most 0.01 (${c0} -> ${c1})`);
    near((await db.one('select shares_outstanding from public.posts where id = $1', [pid])).shares_outstanding, 0, 1e-9, 'shares_outstanding back to 0');
    await until(async () => (await textOf(ub.page, '#view .kpi [data-me="clout"]')) === String(Math.floor(c1)));
    eq(await textOf(ub.page, '#view .kpi [data-me="clout"]'), String(Math.floor(c1)), 'Market shows the server clout');

    // ------------------------------------------------------------ daily drop
    begin('Daily drop works once; a second claim is refused');
    const b2 = await addPage(ub); // A second tab that still thinks the drop is ready.
    await waitApp(b2);
    await go(ub.page, 'feed');
    const c2 = await clout(B.id), xp2 = (await profile(B.id)).xp;
    await withResponse(ub.page, rpcPath('claim_daily_drop'), () => ub.page.click('#live [data-act="drop"]'));
    const dropToast = ub.page.locator('#toasts .toast', { hasText: 'Daily drop: +' }).first();
    await dropToast.waitFor();
    const amount = Number((/\+(\d+) clout/.exec(await dropToast.innerText()) || [])[1]);
    check(amount >= 40 && amount <= 160, `drop amount ${amount} is between 40 and 160`);
    const pb = await profile(B.id);
    near(num(pb.clout), c2 + amount, 1e-9, 'drop clout credited');
    eq(pb.xp, xp2 + 20, 'drop gave 20 XP');
    eq(pb.drop_day && localDay(pb.drop_day), localDay(), 'drop_day is today');
    await ub.page.locator('#live button[disabled]', { hasText: 'Drop opened' }).waitFor();
    check(true, 'drop button switches to opened');
    check(await b2.locator('#live [data-act="drop"]').isVisible(), 'second tab still offers the drop (stale)');
    await expectConsoleErrors(ub, /status of 400|already_claimed|Object/, async () => {
      const r = await withResponse(b2, rpcPath('claim_daily_drop'), () => b2.click('#live [data-act="drop"]'));
      eq(r.status(), 400, 'server refuses the second claim');
      await toast(b2, "You already opened today's drop. Come back tomorrow.");
    });
    check(true, 'second tab shows the plain refusal');
    near(await clout(B.id), c2 + amount, 1e-9, 'no extra clout from the refused claim');
    await b2.locator('#live button[disabled]', { hasText: 'Drop opened' }).waitFor();
    await b2.close();

    // ------------------------------------------------------------ duel
    begin('B votes in a duel and sees the split');
    const did = String(await db.val(`insert into public.duels (title, a_label, a_take, b_label, b_take, a_votes, b_votes, ends_at)
      values ('E2E: should code reviews block a merge?', 'Block it', 'Reviews exist to stop bad merges.', 'Ship it', 'Merge and fix forward.', 0, 3, now() + interval '2 hours')
      returning id`));
    await go(ub.page, 'duels');
    await ub.page.waitForSelector(`[data-duel="${did}"]`);
    check((await textOf(ub.page, `[data-duel="${did}"]`)).includes('Pick a side to see the split'), 'split is hidden before voting');
    await withResponse(ub.page, rpcPath('vote_duel'), () => ub.page.click(`[data-duel="${did}"] [data-act="vote"][data-arg="a"]`));
    await toast(ub.page, 'Your side is behind for now.');
    await ub.page.waitForSelector(`[data-duel="${did}"] .split`);
    eq(await textOf(ub.page, `[data-duel="${did}"] .split .a`), '25%', 'split shows 25% for side A');
    eq(await textOf(ub.page, `[data-duel="${did}"] .split .b`), '75%', 'split shows 75% for side B');
    check(/your side/i.test(await textOf(ub.page, `[data-duel="${did}"] .side.mine`)), 'B\'s side is marked');
    eq(await db.val('select side from public.duel_votes where user_id = $1 and duel_id = $2', [B.id, did]), 'a', 'duel_votes row saved');
    eq(await db.one('select a_votes, b_votes from public.duels where id = $1', [did]), { a_votes: 1, b_votes: 3 }, 'duel counters updated');
    await db.rows(`update public.duels set starts_at = now() - interval '3 hours', ends_at = now() - interval '1 minute' where id = $1`, [did]);
    await go(ub.page, 'feed');
    await withResponse(ub.page, rpcPath('list_duels'), () => go(ub.page, 'duels'));
    await ub.page.locator(`[data-duel="${did}"] [data-b="left:${did}"]`, { hasText: 'Ended' }).waitFor();
    check(/winner/i.test(await textOf(ub.page, `[data-duel="${did}"] .side:not(.mine)`)), 'ended duel marks side B the winner');
    eq((await db.one('select settled from public.duels where id = $1', [did])).settled, true, 'settle_duels settled the ended duel');
    eq(await db.val(`select data->>'title' from public.notifications where user_id = $1 and kind = 'duel_lost'`, [B.id]), 'E2E: should code reviews block a merge?', 'B got a duel_lost notification');

    // ------------------------------------------------------------ hold a position, report
    begin('B backs the post again and reports it');
    await go(ub.page, 'feed');
    await ub.page.waitForSelector(postSel(pid));
    const c3 = await clout(B.id);
    await ub.page.click(`${postSel(pid)} [data-act="pop"][data-arg="back"]`);
    await withResponse(ub.page, rpcPath('back_post'), () => ub.page.click(`${postSel(pid)} .pop [data-act="back"][data-arg="25"]`));
    await toast(ub.page, `Backed @${A.handle} with 25 clout.`);
    eq(num(await db.val('select cost from public.positions where user_id = $1 and post_id = $2', [B.id, pid])), 25, 'B holds a 25-clout position');
    await ub.page.click(`${postSel(pid)} [data-act="menu"]`);
    await ub.page.click('#menu [data-act="report"]');
    await ub.page.waitForSelector('#modalBody form[data-form="report"]');
    await ub.page.check('#modalBody input[name="reason"][value="spam"]');
    await ub.page.fill('#reportDetails', REPORT_NOTE);
    await withResponse(ub.page, tablePath('reports', 'POST'), () => ub.page.click('#modalBody form[data-form="report"] button:not([type])'));
    await toast(ub.page, 'Thanks. A moderator will review it.');
    const rep = await db.one('select * from public.reports where reporter = $1', [B.id]);
    const rid = rep && String(rep.id);
    eq(rep && [String(rep.post_id), rep.reason, rep.details, rep.status], [pid, 'spam', REPORT_NOTE, 'open'], 'report row saved');
    check(await ub.page.locator('#modal').isHidden(), 'report modal closed');
    await ub.page.evaluate(() => { location.hash = '#moderation'; });
    await ub.page.waitForFunction(() => location.hash === '#feed');
    check(!(await ub.page.locator('#rail [data-nav="moderation"]').count()), 'non-admins have no Moderation item and #moderation goes to the feed');

    // ------------------------------------------------------------ moderation
    begin('An admin signs in');
    const signup = await fetch(BASE + '/auth/v1/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: (await (await fetch(BASE + '/__health')).json()).anonKey },
      body: JSON.stringify({ email: M.email, password: M.password, data: { handle: M.handle, name: M.name } }),
    });
    M.id = (await signup.json()).user.id;
    await db.rows('update public.profiles set is_admin = true where id = $1', [M.id]); // How the owner makes an admin.
    const um = await openUser(browser, 'Mod'); users.push(um);
    await waitAuth(um.page);
    await signInUI(um.page, M.email, M.password);
    await waitApp(um.page);
    await um.page.waitForSelector('#rail [data-nav="moderation"]');
    check(true, 'admin sees the Moderation item');
    begin('The admin mutes A, then shows A again');
    await um.page.waitForSelector(postSel(pid));
    await um.page.click(`${postSel(pid)} [data-act="menu"]`);
    await withResponse(um.page, tablePath('mutes', 'POST'), () => um.page.click('#menu [data-act="mute"]'));
    await toast(um.page, `Hid @${A.handle}.`);
    check(!(await hasPost(um.page, pid)), 'muted author\'s post leaves the feed');
    check(!!(await db.one('select 1 from public.mutes where user_id = $1 and muted_id = $2', [M.id, A.id])), 'mutes row saved');
    await go(um.page, 'algo');
    await withResponse(um.page, tablePath('mutes', 'DELETE'), () => um.page.click(`#view [data-act="unmute"][data-id="${A.id}"]`));
    eq(await db.val('select count(*)::int from public.mutes where user_id = $1', [M.id]), 0, 'mutes row deleted');
    await go(um.page, 'feed');
    await um.page.waitForSelector(postSel(pid));
    check(true, 'A\'s post is back after unmuting');

    begin('The admin removes the reported post');
    await go(um.page, 'moderation');
    const item = `#view .mod-item[data-report="${rid}"]`;
    await um.page.waitForSelector(item);
    const it = await textOf(um.page, item);
    check(it.includes(POST1_EDIT), 'report shows the reported post');
    check(it.includes(`Reported by @${B.handle}`) && it.includes(`@${A.handle}`), 'report shows reporter and author');
    check(it.includes('Spam') && it.includes(REPORT_NOTE), 'report shows reason and note');
    const cBefore = await clout(B.id);
    await um.page.fill('#duel-title', 'A duel I started writing'); // Report actions must not wipe the form below.
    await withResponse(um.page, rpcPath('mod_set_post_removed'), () => um.page.click(`${item} [data-act="modRemove"][data-arg="1"]`));
    await toast(um.page, 'Post removed. Its author was told.');
    await um.page.waitForSelector(`${item} [data-act="modRemove"][data-arg="0"]`);
    check((await textOf(um.page, item)).includes('Removed'), 'report shows the Removed tag and a Restore button');
    eq((await db.one('select removed from public.posts where id = $1', [pid])).removed, true, 'posts.removed = true');
    eq(await db.val('select count(*)::int from public.positions where post_id = $1', [pid]), 0, 'positions in the removed post are closed');
    near(await clout(B.id), cBefore + 25, 1e-9, 'B got the 25 clout cost basis back');
    eq(await db.val(`select data->>'action' from public.notifications where user_id = $1 and kind = 'mod'`, [A.id]), 'removed', 'A was told by a mod notification');
    await withResponse(um.page, rpcPath('mod_set_post_removed'), () => um.page.click(`${item} [data-act="modRemove"][data-arg="0"]`));
    await toast(um.page, 'Post restored.');
    await um.page.waitForSelector(`${item} [data-act="modRemove"][data-arg="1"]`);
    eq((await db.one('select removed from public.posts where id = $1', [pid])).removed, false, 'Restore post sets removed = false');
    await withResponse(um.page, rpcPath('mod_set_post_removed'), () => um.page.click(`${item} [data-act="modRemove"][data-arg="1"]`));
    await um.page.waitForSelector(`${item} [data-act="modRemove"][data-arg="0"]`);
    eq((await db.one('select removed from public.posts where id = $1', [pid])).removed, true, 'removed again');
    near(await clout(B.id), cBefore + 25, 1e-9, 'the refund happened once');
    await withResponse(um.page, rpcPath('mod_resolve_report'), () => um.page.click(`${item} [data-act="modResolve"][data-arg="actioned"]`));
    await toast(um.page, 'Report marked as actioned.');
    await um.page.locator(item).waitFor({ state: 'detached' });
    eq(await db.val('select status from public.reports where id = $1', [rid]), 'actioned', 'report status is actioned');
    eq(await um.page.inputValue('#duel-title'), 'A duel I started writing', 'the half-written duel survives report actions');

    begin('The admin creates a duel');
    await um.page.fill('#duel-title', 'E2E: pineapple on pizza, final answer?');
    await um.page.fill('#duel-a-take', 'Sweet and salty works.');
    await um.page.fill('#duel-a-handle', '@' + A.handle);
    await um.page.fill('#duel-b-label', 'No');
    await um.page.fill('#duel-b-take', 'Fruit is dessert.');
    await um.page.fill('#duel-b-handle', '@nobody_here');
    await um.page.fill('#duel-hours', '2');
    await um.expect(/status of 400|not_found|Object/, async () => {
      await withResponse(um.page, rpcPath('mod_create_duel'), () => um.page.click('#view form[data-form="duel"] button:not([type])'));
      await toast(um.page, 'No account has that handle. Check the spelling.');
    });
    await um.page.fill('#duel-b-handle', '');
    await withResponse(um.page, rpcPath('mod_create_duel'), () => um.page.click('#view form[data-form="duel"] button:not([type])'));
    await toast(um.page, 'Duel created. It is live now.');
    const nd = await db.one(`select id, a_user, a_label, b_user, b_label, round(extract(epoch from ends_at - starts_at) / 3600)::int as hours, created_by
      from public.duels where title = 'E2E: pineapple on pizza, final answer?'`);
    eq(nd && [nd.a_user, nd.a_label, nd.b_user, nd.b_label, nd.hours, nd.created_by], [A.id, A.name, null, 'No', 2, M.id], 'duel saved with A linked to side A, 2 hours, created by the admin');
    eq(await um.page.inputValue('#duel-title'), '', 'the form resets after creating');
    await go(ub.page, 'duels');
    await ub.page.waitForSelector(`[data-duel="${nd.id}"]`);
    check((await textOf(ub.page, `[data-duel="${nd.id}"]`)).includes('@' + A.handle), 'B sees the new duel with A linked');

    begin('The admin removes one reply, sees a deleted reply, and resets a profile');
    const tpid = String(await db.val(`insert into public.posts (author_id, body) values ($1, 'A thread for a reply report.') returning id`, [A.id]));
    const rrid = String(await db.val(`insert into public.replies (post_id, author_id, body) values ($1, $2, 'A rude reply from B.') returning id`, [tpid, B.id]));
    const goneId = String(await db.val(`insert into public.replies (post_id, author_id, body) values ($1, $2, 'Something B deleted later.') returning id`, [tpid, B.id]));
    const rep3 = String(await db.val(`insert into public.reports (reply_id, reason, reporter) values ($1, 'harassment', $2) returning id`, [rrid, A.id]));
    const rep4 = String(await db.val(`insert into public.reports (reply_id, reason, reporter) values ($1, 'harassment', $2) returning id`, [goneId, A.id]));
    await db.rows('delete from public.replies where id = $1', [goneId]); // B deletes it after it was reported.
    const rk = await (await fetch(BASE + '/auth/v1/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: (await (await fetch(BASE + '/__health')).json()).anonKey },
      body: JSON.stringify({ email: 'rude@e2e.test', password: PW, data: { handle: 'rude_e2e', name: 'Rude Name' } }),
    })).json();
    await db.rows(`update public.profiles set bio = 'An offensive bio.' where id = $1`, [rk.user.id]);
    const rep5 = String(await db.val(`insert into public.reports (profile_id, reason, reporter) values ($1, 'hate', $2) returning id`, [rk.user.id, A.id]));
    await withResponse(um.page, rpcPath('mod_open_reports'), () => um.page.click('#view [data-act="modRefresh"]'));
    const item3 = `#view .mod-item[data-report="${rep3}"]`, item4 = `#view .mod-item[data-report="${rep4}"]`, item5 = `#view .mod-item[data-report="${rep5}"]`;
    await um.page.waitForSelector(item3);
    await withResponse(um.page, rpcPath('mod_set_reply_removed'), () => um.page.click(`${item3} [data-act="modRemoveReply"][data-arg="1"]`));
    await toast(um.page, 'Reply removed.');
    await um.page.waitForSelector(`${item3} [data-act="modRemoveReply"][data-arg="0"]`);
    eq(await db.val('select removed from public.replies where id = $1', [rrid]), true, 'Remove reply sets replies.removed');
    eq(await db.val(`select data->>'action' from public.notifications where user_id = $1 and kind = 'mod' order by id desc limit 1`, [B.id]), 'reply_removed', 'B is told');
    const it4 = await textOf(um.page, item4);
    check(it4.includes('Its author deleted it.') && it4.includes('Something B deleted later.'), 'a deleted reply\'s report still shows what it said');
    check(await um.page.locator(`${item4} [data-act="modBan"][data-id="${B.id}"]`).isVisible(), 'and offers to ban its author');
    await withResponse(um.page, rpcPath('mod_reset_profile'), () => um.page.click(`${item5} [data-act="modResetProfile"]`));
    await toast(um.page, 'Profile reset');
    eq(await db.one('select name, bio from public.profiles where id = $1', [rk.user.id]), { name: 'rude_e2e', bio: '' }, 'Reset name and bio clears the profile');
    for (const r of [rep3, rep4, rep5]) await db.rows(`update public.reports set status = 'dismissed' where id = $1`, [r]);
    await db.rows('delete from public.posts where id = $1', [tpid]);

    begin('The removed post is gone for B and for A');
    await ub.page.reload(); await waitApp(ub.page);
    await go(ub.page, 'feed');
    await ub.page.waitForSelector(postSel(bpid));
    check(!(await hasPost(ub.page, pid)), 'B no longer sees the removed post');
    await go(ub.page, 'market');
    check(!(await ub.page.locator(`#view [data-act="sell"][data-id="${pid}"]`).count()), 'B has no position left in it');
    eq(await textOf(ub.page, '#view .kpi [data-me="clout"]'), String(Math.floor(await clout(B.id))), 'B\'s Market clout includes the refund');
    await ua.page.reload(); await waitApp(ua.page);
    check(!(await hasPost(ua.page, pid)), 'A no longer sees their removed post');
    await go(ua.page, 'activity');
    await ua.page.locator('#view .notes li', { hasText: 'A moderator removed your post' }).first().waitFor();
    check(true, 'A\'s Activity says a moderator removed the post');

    // ------------------------------------------------------------ block
    begin('A levels up from a post; the server decides');
    await go(ua.page, 'feed');
    await db.rows('update public.profiles set xp = 95 where id = $1', [A.id]); // 5 XP short of level 2.
    const cA = await clout(A.id);
    await ua.page.fill('#composeText', POST2);
    await withResponse(ua.page, tablePath('posts', 'POST'), () => ua.page.click('#composeForm button:not([type])'));
    await toast(ua.page, 'Posted.');
    await toast(ua.page, 'Level 2 reached. +100 clout.');
    check(true, 'level-up toast uses the server numbers');
    const pA = await profile(A.id);
    eq([pA.xp, num(pA.clout)], [120, cA + 100], 'server added 25 XP and the 100 clout level bonus');
    const lvl = await db.val(`select data from public.notifications where user_id = $1 and kind = 'level'`, [A.id]);
    eq(lvl && [lvl.level, lvl.bonus], [2, 100], 'level notification written');
    await ua.page.locator('#rail [data-me="lv"]', { hasText: 'Lv 2' }).waitFor();
    check(true, 'rail shows Lv 2');

    begin('A blocks B from B\'s profile');
    const pid2 = String(await db.val('select id from public.posts where author_id = $1 and body = $2', [A.id, POST2]));
    await go(ub.page, 'feed');
    await ub.page.reload(); await waitApp(ub.page);
    await ub.page.waitForSelector(postSel(pid2));
    check(true, 'B sees A\'s new post before the block');
    await ua.page.waitForSelector(postSel(bpid));
    await ua.page.click(`${postSel(bpid)} .name-btn`);
    await ua.page.waitForSelector('#view .person-card');
    await ua.page.waitForSelector(postSel(bpid));
    const bv = await viewText(ua.page);
    check(bv.includes(B.name) && bv.includes('@' + B.handle), 'person view shows B');
    check(/0\s+followers/.test(bv) && /1\s+following/.test(bv), 'person view shows B\'s counts');
    await ua.page.click(`#view [data-act="menu"][data-id="person:${B.id}"]`);
    await ua.page.click('#menu [data-act="askBlock"]');
    await ua.page.locator('#modalBody', { hasText: `Block @${B.handle}?` }).waitFor();
    check((await textOf(ua.page, '#modalBody')).includes("You won't see each other's posts, and they can't follow you."), 'block modal explains what happens');
    await withResponse(ua.page, tablePath('blocks', 'POST'), () => ua.page.click('#modalBody [data-act="block"]'));
    await toast(ua.page, `You blocked @${B.handle}.`);
    await ua.page.locator('#view .note-box', { hasText: `You blocked @${B.handle}.` }).waitFor();
    check(await ua.page.locator(`#view [data-act="unblock"][data-id="${B.id}"]`).isVisible(), 'person view offers Unblock');
    check(!!(await db.one('select 1 from public.blocks where blocker = $1 and blocked = $2', [A.id, B.id])), 'blocks row saved');
    eq(await db.val('select count(*)::int from public.follows where (follower = $1 and followee = $2) or (follower = $2 and followee = $1)', [A.id, B.id]), 0, 'follows removed both ways');
    eq((await profile(A.id)).followers_count, 0, 'A followers_count back to 0');
    eq((await profile(B.id)).following_count, 0, 'B following_count back to 0');
    await go(ua.page, 'profile');
    check((await textOf(ua.page, '#view .settings-sub')).includes('@' + B.handle), 'Settings lists B under Blocked accounts');
    await go(ua.page, 'activity');
    await ua.page.waitForSelector('#view .notes li');
    check(!(await viewText(ua.page)).includes('@' + B.handle), 'B\'s earlier notifications are hidden after the block');

    begin('B no longer sees A');
    await ub.page.reload(); await waitApp(ub.page);
    await ub.page.waitForSelector(postSel(bpid));
    check(!(await hasPost(ub.page, pid2)), 'A\'s posts are gone from B\'s feed');
    await ub.page.evaluate(id => { location.hash = '#person:' + id; }, A.id);
    await ub.page.waitForSelector('#view .person-card');
    await ub.page.locator('#view .empty', { hasText: "hasn't posted yet" }).waitFor();
    check(true, 'A\'s profile shows no posts to B');
    await expectConsoleErrors(ub, /status of 400|blocked|Object/, async () => {
      await withResponse(ub.page, tablePath('follows', 'POST'), () => ub.page.click('#view .person-tools [data-act="follow"]'));
      await toast(ub.page, "You can't follow this account.");
    });
    await ub.page.locator('#view .person-tools [data-act="follow"]', { hasText: 'Follow' }).waitFor();
    eq(await db.val('select count(*)::int from public.follows where follower = $1', [B.id]), 0, 'the database refused the follow');
    check(true, 'follow is undone with a plain message');

    // ------------------------------------------------------------ report a profile, ban, unban
    begin('A reports B\'s profile; the admin bans B, then unbans');
    await ua.page.evaluate(id => { location.hash = '#person:' + id; }, B.id);
    await ua.page.waitForSelector('#view .person-card');
    await ua.page.click(`#view [data-act="menu"][data-id="person:${B.id}"]`);
    await ua.page.click('#menu [data-act="report"]');
    await ua.page.check('#modalBody input[name="reason"][value="harassment"]');
    await withResponse(ua.page, tablePath('reports', 'POST'), () => ua.page.click('#modalBody form[data-form="report"] button:not([type])'));
    await toast(ua.page, 'Thanks. A moderator will review it.');
    const rid2 = String(await db.val('select id from public.reports where reporter = $1 and profile_id = $2', [A.id, B.id]));
    check(rid2 !== 'null', 'profile report saved with profile_id');
    await withResponse(um.page, rpcPath('mod_open_reports'), () => um.page.click('#view [data-act="modRefresh"]'));
    const item2 = `#view .mod-item[data-report="${rid2}"]`;
    await um.page.waitForSelector(item2);
    check((await textOf(um.page, item2)).includes(B.name), 'profile report shows the profile');
    await withResponse(um.page, rpcPath('mod_set_banned'), () => um.page.click(`${item2} [data-act="modBan"][data-arg="1"]`));
    await toast(um.page, 'Account banned.');
    await um.page.waitForSelector(`${item2} [data-act="modBan"][data-arg="0"]`);
    eq((await profile(B.id)).is_banned, true, 'profiles.is_banned = true');
    await ub.page.reload(); await waitApp(ub.page);
    await go(ub.page, 'feed');
    await ub.page.locator('#view .note-box', { hasText: 'Your account is suspended.' }).waitFor();
    check(true, 'B sees the suspended note');
    await ub.page.fill('#composeText', 'Can I still post?');
    await expectConsoleErrors(ub, /status of 400|banned|Object/, async () => {
      await withResponse(ub.page, tablePath('posts', 'POST'), () => ub.page.click('#composeForm button:not([type])'));
      await toast(ub.page, "Your account is suspended, so you can't do that.");
    });
    eq(await db.val('select count(*)::int from public.posts where author_id = $1', [B.id]), 1, 'the banned account could not post');
    await withResponse(um.page, rpcPath('mod_set_banned'), () => um.page.click(`${item2} [data-act="modBan"][data-arg="0"]`));
    await toast(um.page, 'Account unbanned.');
    eq((await profile(B.id)).is_banned, false, 'unban saved');
    await withResponse(um.page, rpcPath('mod_resolve_report'), () => um.page.click(`${item2} [data-act="modResolve"][data-arg="dismissed"]`));
    await toast(um.page, 'Report dismissed.');
    eq(await db.val('select status from public.reports where id = $1', [rid2]), 'dismissed', 'report dismissed');
    await ub.page.fill('#composeText', '');

    begin('A unblocks B from Settings');
    await go(ua.page, 'profile');
    await withResponse(ua.page, tablePath('blocks', 'DELETE'), () => ua.page.click(`#view .settings-sub [data-act="unblock"][data-id="${B.id}"]`));
    await toast(ua.page, `Unblocked @${B.handle}.`);
    eq(await db.val('select count(*)::int from public.blocks where blocker = $1', [A.id]), 0, 'blocks row deleted');
    check((await textOf(ua.page, '#view .settings-sub')).includes("You haven't blocked anyone."), 'Blocked accounts list is empty');

    // ------------------------------------------------------------ profile edit
    begin('A edits handle and bio');
    await go(ua.page, 'profile');
    await ua.page.click('#view [data-act="editProfile"]');
    await ua.page.fill('#pf-handle', B.handle);
    await ua.page.locator('#pf-handle-status', { hasText: 'Taken' }).waitFor();
    await ua.page.click('#view form[data-form="profile"] button:not([type])');
    await toast(ua.page, 'That handle is taken. Try another.');
    eq((await profile(A.id)).handle, A.handle, 'a taken handle is not saved');
    await ua.page.fill('#pf-handle', 'ada_renamed');
    await ua.page.locator('#pf-handle-status', { hasText: 'Available' }).waitFor();
    await ua.page.fill('#pf-bio', BIO);
    await withResponse(ua.page, tablePath('profiles', 'PATCH'), () => ua.page.click('#view form[data-form="profile"] button:not([type])'));
    await toast(ua.page, 'Profile saved.');
    const pa = await profile(A.id);
    eq([pa.handle, pa.bio], ['ada_renamed', BIO], 'handle and bio saved');
    const prof = await viewText(ua.page);
    check(prof.includes('@ada_renamed') && prof.includes(BIO), 'Profile shows the new handle and bio');

    begin('A deletes a post');
    await ua.page.waitForSelector(postSel(pid2));
    await ua.page.click(`${postSel(pid2)} [data-act="menu"]`);
    await ua.page.click('#menu [data-act="askDelete"]');
    await ua.page.locator(`${postSel(pid2)} .confirm`, { hasText: 'Delete this post?' }).waitFor();
    await withResponse(ua.page, tablePath('posts', 'DELETE'), () => ua.page.click(`${postSel(pid2)} [data-act="confirmDelete"]`));
    await toast(ua.page, 'Post deleted.');
    eq(await db.val('select count(*)::int from public.posts where id = $1', [pid2]), 0, 'post row deleted');
    check(!(await hasPost(ua.page, pid2)), 'post is gone from the profile');

    // ------------------------------------------------------------ delete account
    begin('B deletes their account');
    await go(ub.page, 'profile');
    await ub.page.click('#view [data-act="askDeleteAccount"]');
    await ub.page.locator('#view .confirm', { hasText: 'Delete your account?' }).waitFor();
    await withResponse(ub.page, rpcPath('delete_my_account'), () => ub.page.click('#view [data-act="deleteAccount"]'));
    await waitAuth(ub.page);
    await ub.page.locator('#gate .form-msg', { hasText: 'Your account was deleted. Everything you posted is gone.' }).waitFor();
    check(true, 'B lands on the sign-in screen with a message');
    const left = await db.one(`select
        (select count(*) from auth.users where id = $1)::int as users,
        (select count(*) from public.profiles where id = $1)::int as profiles,
        (select count(*) from public.posts where author_id = $1)::int as posts,
        (select count(*) from public.replies where author_id = $1)::int as replies,
        (select count(*) from public.reactions where user_id = $1)::int as reactions,
        (select count(*) from public.follows where follower = $1 or followee = $1)::int as follows,
        (select count(*) from public.blocks where blocker = $1 or blocked = $1)::int as blocks,
        (select count(*) from public.positions where user_id = $1)::int as positions,
        (select count(*) from public.duel_votes where user_id = $1)::int as votes,
        (select count(*) from public.notifications where user_id = $1 or actor_id = $1)::int as notes,
        (select count(*) from public.xp_log where user_id = $1)::int as xp`, [B.id]);
    eq(left, { users: 0, profiles: 0, posts: 0, replies: 0, reactions: 0, follows: 0, blocks: 0, positions: 0, votes: 0, notes: 0, xp: 0 }, 'every row that belonged to B is gone');
    eq(await db.val('select reporter from public.reports where id = $1', [rid]), null, 'B\'s report stays for moderators, without the reporter');
    eq((await db.one('select replies from public.posts where id = $1', [pid])).replies, 0, 'reply counter on A\'s post dropped with B\'s reply');
    await expectConsoleErrors(ub, /status of 400/, async () => {
      await signInUI(ub.page, B.email, B.password);
      await ub.page.locator('#gate .form-msg', { hasText: "That email and password don't match." }).waitFor();
    });
    check(true, 'B can no longer sign in');

    begin('A opens the deleted account');
    await ua.page.evaluate(id => { location.hash = '#person:' + id; }, B.id);
    await ua.page.locator('#view', { hasText: "This account isn't available. It may have been deleted." }).waitFor();
    check(true, 'person view says the account is gone');

    // ------------------------------------------------------------ held monetization
    begin('Monetization stays held with both switches off');
    const MONEY = [/¢/, /\$/, /Wallet/, /\bPro\b/, /\bTips?\b/, /Sponsored/, /attention/i, /Cash out/, /Patron/, /\bAds?\b/, /\bdemo\b/i, /simulated/i];
    for (const v of ['feed', 'algo', 'market', 'duels', 'activity', 'profile']) {
      await go(ua.page, v);
      await ua.page.waitForTimeout(150);
      const text = await ua.page.evaluate(() => document.body.innerText);
      const hit = MONEY.filter(re => re.test(text)).map(String);
      eq(hit, [], `no money or demo copy on ${v}`);
    }
    check(!(await ua.page.locator('[data-nav="wallet"]').count()), 'no Wallet in the navigation');
    await ua.page.evaluate(() => { location.hash = '#wallet'; });
    await ua.page.waitForFunction(() => location.hash === '#feed');
    check(true, '#wallet leads to the feed');
    for (const x of users) {
      eq(x.requests.filter(r => /\/rest\/v1\/(ads|ad_views)\b|record_ad_view/.test(r)), [], `${x.label}: never touched the ads tables`);
    }

    begin('Other people\'s private profile columns stay private over the API');
    const tok = await ua.page.evaluate(() => { const k = Object.keys(localStorage).find(x => /^sb-.+-auth-token$/.test(x)); return JSON.parse(localStorage.getItem(k)).access_token; });
    const apikey = (await (await fetch(BASE + '/__health')).json()).anonKey;
    const api = q => fetch(BASE + '/rest/v1/' + q, { headers: { apikey, Authorization: 'Bearer ' + tok } });
    const pub = await api(`profiles?select=handle,name,followers_count&id=eq.${M.id}`);
    eq([pub.status, (await pub.json())[0].handle], [200, M.handle], 'public columns are readable');
    for (const col of ['clout', 'earnings_cents', 'last_active', 'active_days', 'is_admin', 'dial', 'accepted_terms_at']) {
      eq((await api(`profiles?select=handle,${col}&id=eq.${M.id}`)).status, 403, `${col} of another account is refused`);
    }
    eq((await api('profiles?select=handle&is_admin=eq.true')).status, 403, 'nobody can list the moderators');
    for (const x of users) eq(x.requests.filter(r => /\/rest\/v1\/profiles\?select=\*/.test(r)), [], `${x.label}: the app never asks for every profile column`);

    // ------------------------------------------------------------ errors
    begin('No page errors');
    for (const u of users) {
      eq(u.errors, [], `${u.label}: no page errors and no unexpected console errors`);
    }
    ok = true;
  } catch (e) {
    check(false, 'stopped by an error: ' + (e && e.stack || e));
    await screenshots(users, 'live');
    for (const u of users) if (u.errors.length) console.log(`   ${u.label} errors so far:\n     ` + u.errors.join('\n     '));
  } finally {
    await browser.close().catch(() => {});
    await db.end().catch(() => {});
  }
  const passed = summary('live.spec.js') && ok;
  process.exit(passed ? 0 : 1);
}

main();
