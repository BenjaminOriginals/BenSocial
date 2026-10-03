// Fake supabase-js UMD for the live-mode smoke tests (live-smoke.js). Defines window.supabase.createClient.
// In-memory tables and RPCs that follow the BenSocial contract (supabase/schema.sql). Every call is logged to window.__calls.
// Config (set before load): window.__FAKE = { session: bool, admin: bool, banned: bool, fail: { 'reactions.upsert': {message, code} },
//   ads: bool (one active row in the ads table), serverAds / serverPayments: bool (public.settings, both off by default),
//   signup: 'duplicate' (GoTrue's stand-in user with no identities) | 'unauthorized' (email_address_not_authorized),
//   delay: { <rpc name>: ms } (a slow server function; others answer after 5ms) }
// public.settings outlives a reload in the same browser context (localStorage), like a real database. Tests change it the
// way the owner would in the SQL editor with window.__fakeSettings({ ads_enabled: true }).
(function () {
  const CFG = window.__FAKE || {};
  const calls = (window.__calls = window.__calls || []);
  const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
  const ANA = 'bbbbbbbb-0000-4000-8000-000000000002';
  const EVIL = 'cccccccc-0000-4000-8000-000000000003';
  const iso = ms => new Date(ms).toISOString();
  const t0 = Date.now();
  const localDay = (d = new Date()) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const prof = (o) => Object.assign({ hue: 48, bio: '', xp: 0, clout: 500, streak: 0, last_active: null, active_days: [], drop_day: null,
    followers_count: 0, following_count: 0, dial: null, ad_price_cents: 4, earnings_cents: 0, is_admin: false, is_banned: false, pro: false,
    accepted_terms_at: iso(t0), created_at: iso(t0) }, o);
  const post = (o) => Object.assign({ mood: null, spicy: .25, wholesome: .35, likes: 0, dislikes: 0, replies: 0, reposts: 0,
    shares_outstanding: 0, price: 5, price_history: [5], removed: false, created_at: iso(t0), edited_at: null }, o);
  const db = window.__fakeDb = {
    profiles: [
      prof({ id: ME, handle: 'tester', name: 'Test User', hue: 120, bio: 'I test things.', xp: 90, clout: 500, streak: 2,
        active_days: [localDay(new Date(t0 - 864e5))], last_active: localDay(new Date(t0 - 864e5)), followers_count: 3, following_count: 1,
        is_admin: !!CFG.admin, is_banned: !!CFG.banned, dial: CFG.dial || null }),
      prof({ id: ANA, handle: 'ana.real', name: 'Ana Real', hue: 30, bio: 'Real person. <b>not bold</b>', followers_count: 10, following_count: 2 }),
      prof({ id: EVIL, handle: 'evil_one', name: '<img src=x onerror="window.__xss=1">', hue: 300, bio: '<script>window.__xss=2</script>', followers_count: 1 }),
    ],
    posts: [
      post({ id: 101, author_id: ANA, body: 'Hello from a real person', likes: 4, dislikes: 1, replies: 1, reposts: 0, price: 6.7, price_history: [5, 6, 6.7], created_at: iso(t0 - 6e5) }),
      post({ id: 102, author_id: EVIL, body: '<img src=x onerror="window.__xss=3"> spicy', mood: 'spicy', spicy: .8, wholesome: .1, likes: 2, dislikes: 5, created_at: iso(t0 - 12e5) }),
      post({ id: 103, author_id: ME, body: 'My own first post, edited', created_at: iso(t0 - 18e5), edited_at: iso(t0 - 9e5) }),
    ],
    post_edits: [{ id: 1, post_id: 103, body: 'My own first post', written_at: iso(t0 - 18e5) }],
    reactions: [], reposts: [],
    replies: [{ id: 501, post_id: 101, author_id: EVIL, body: 'Reply with <b>tags</b>', removed: false, created_at: iso(t0 - 3e5) }],
    follows: [{ follower: ME, followee: ANA }], mutes: [], blocks: [], reports: [],
    notifications: [
      { id: 1, user_id: ME, actor_id: ANA, kind: 'like', post_id: 103, data: {}, read: false, created_at: iso(t0 - 2e5) },
      { id: 2, user_id: ME, actor_id: EVIL, kind: 'reply', post_id: 103, data: { excerpt: '<i>sneaky</i>' }, read: false, created_at: iso(t0 - 1e5) },
      { id: 3, user_id: ME, actor_id: null, kind: 'level', post_id: null, data: { level: 2, bonus: 100 }, read: true, created_at: iso(t0 - 5e6) },
    ],
    positions: [],
    duels: [
      { id: 7, title: 'Is cereal a <soup>?', a_user: null, a_label: 'Soup', a_take: 'Solid pieces in liquid.', b_user: ANA, b_label: 'Not soup', b_take: 'Cereal is breakfast.',
        a_votes: 3, b_votes: 4, starts_at: iso(t0 - 36e5), ends_at: iso(t0 + 5 * 36e5), settled: false },
    ],
    duel_votes: [],
    ads: CFG.ads ? [{ id: 11, brand: 'Pebble <Bank>', hue: 205, bid_cents: 15, copy: 'No fees.', why: 'Broad campaign.', active: true }] : [],
    ad_views: [],
    reports_mod: [
      { report_id: 900, reason: 'harassment', details: 'They keep <b>posting</b> this', status: 'open', created_at: iso(t0 - 4e5), reporter_handle: 'ana.real',
        target_kind: 'post', post_id: 102, reply_id: null, profile_id: null, content: '<img src=x onerror="window.__xss=4">', target_user: EVIL, target_handle: 'evil_one', target_banned: false, post_removed: false },
    ],
  };
  if (CFG.noProfile) { db.profiles = db.profiles.filter(p => p.id !== ME); db.posts = db.posts.filter(p => p.author_id !== ME); }
  // public.settings: the monetization switches. The server is the only authority on them.
  const SETTINGS_KEY = 'fake-supabase-settings';
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(SETTINGS_KEY)); } catch (e) { stored = null; }
  db.settings = stored || { ads_enabled: !!CFG.serverAds, payments_enabled: !!CFG.serverPayments };
  const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(db.settings)); } catch (e) { /* */ } };
  window.__fakeSettings = patch => { Object.assign(db.settings, patch); saveSettings(); return Object.assign({}, db.settings); };
  const switches = () => ({ ads: !!db.settings.ads_enabled, payments: !!db.settings.payments_enabled });
  let nextId = 1000;
  const err = (message, code = 'P0001') => ({ data: null, error: { message, code, details: null, hint: null } });
  const ok = data => ({ data, error: null, status: 200 });
  const failFor = key => { const f = CFG.fail && CFG.fail[key]; if (f) { if (!CFG.failSticky) delete CFG.fail[key]; return { data: null, error: Object.assign({ details: null, hint: null }, f) }; } return null; };
  const byId = (t, id) => db[t].find(r => String(r.id) === String(id));
  const meP = () => byId('profiles', ME);
  const feedRow = p => {
    const a = byId('profiles', p.author_id);
    const r = db.reactions.find(x => x.user_id === ME && x.post_id === p.id);
    return Object.assign({}, p, { edit_count: db.post_edits.filter(e => e.post_id === p.id).length,
      author_handle: a.handle, author_name: a.name, author_hue: a.hue, author_pro: a.pro,
      my_reaction: r ? r.kind : null, reposted: db.reposts.some(x => x.user_id === ME && x.post_id === p.id) });
  };
  const blockedWith = id => db.blocks.some(b => (b.blocker === ME && b.blocked === id) || (b.blocker === id && b.blocked === ME));
  const visible = p => !p.removed && !blockedWith(p.author_id) && !byId('profiles', p.author_id).is_banned;
  const price = p => +(5 + 0.8 * Math.sqrt(Math.max(0, p.likes + 2 * p.reposts + 1.5 * p.replies - 0.5 * p.dislikes)) + 0.05 * p.shares_outstanding).toFixed(4);
  const reprice = p => { const n = price(p); if (n !== p.price) { p.price = n; p.price_history = [...p.price_history, n].slice(-40); } };

  const RPC = {
    handle_available: ({ p_handle }) => ok(/^[a-z0-9._]{3,20}$/.test(p_handle) && !db.profiles.some(p => p.handle === p_handle)),
    feed: ({ p_limit = 200 } = {}) => ok(db.posts.filter(p => visible(p) && !db.mutes.some(m => m.muted_id === p.author_id))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, p_limit).map(feedRow)),
    posts_by: ({ p_author, p_limit = 50 }) => ok(db.posts.filter(p => p.author_id === p_author && visible(p)).slice(0, p_limit).map(feedRow)),
    touch_streak: ({ p_today }) => {
      window.__touches = (window.__touches || 0) + 1;
      if (!meP()) {
        if (CFG.noProfile && window.__touches >= 2) db.profiles.push(prof({ id: ME, handle: 'user1234abcd', name: 'user1234abcd' }));
        else return err('not_found');
      }
      const m = meP();
      if (m.last_active !== p_today) { m.streak += 1; m.last_active = p_today; m.active_days = [...m.active_days, p_today].slice(-30); }
      return ok({ streak: m.streak, active_days: m.active_days, last_active: m.last_active });
    },
    claim_daily_drop: ({ p_today }) => {
      const m = meP(); if (m.drop_day === p_today) return err('already_claimed');
      m.drop_day = p_today; m.clout += 77; m.xp += 20; return ok({ amount: 77, clout: m.clout, xp: m.xp });
    },
    back_post: ({ p_post, p_amount }) => {
      const p = byId('posts', p_post), m = meP();
      if (!p) return err('not_found'); if (p.author_id === ME) return err('own_post'); if (m.clout < p_amount) return err('insufficient_clout');
      const s = p_amount / p.price; p.shares_outstanding += s; reprice(p); m.clout -= p_amount; m.xp += 10;
      const pos = db.positions.find(x => x.post_id === p.id) || (db.positions.push({ user_id: ME, post_id: p.id, shares: 0, cost: 0 }), db.positions[db.positions.length - 1]);
      pos.shares += s; pos.cost += p_amount;
      return ok({ shares: s, spent: p_amount, price: p.price, clout: m.clout });
    },
    sell_position: ({ p_post }) => {
      const i = db.positions.findIndex(x => x.post_id === Number(p_post)); if (i < 0) return err('not_found');
      const pos = db.positions[i], p = byId('posts', p_post), m = meP(), proceeds = +(pos.shares * p.price * 0.98).toFixed(2);
      db.positions.splice(i, 1); p.shares_outstanding = Math.max(0, p.shares_outstanding - pos.shares); reprice(p); m.clout += proceeds;
      return ok({ proceeds, profit: proceeds - pos.cost, clout: m.clout });
    },
    list_duels: () => ok(db.duels.map(d => {
      const a = d.a_user && byId('profiles', d.a_user), b = d.b_user && byId('profiles', d.b_user), v = db.duel_votes.find(x => x.duel_id === d.id);
      return { id: d.id, title: d.title, a_label: d.a_label, a_take: d.a_take, a_user: d.a_user, a_handle: a ? a.handle : null, a_name: a ? a.name : null, a_hue: a ? a.hue : null,
        b_label: d.b_label, b_take: d.b_take, b_user: d.b_user, b_handle: b ? b.handle : null, b_name: b ? b.name : null, b_hue: b ? b.hue : null,
        a_votes: d.a_votes, b_votes: d.b_votes, starts_at: d.starts_at, ends_at: d.ends_at, settled: d.settled, my_side: v ? v.side : null };
    })),
    vote_duel: ({ p_duel, p_side }) => {
      const d = byId('duels', p_duel); if (!d) return err('not_found'); if (!['a', 'b'].includes(p_side)) return err('bad_side');
      if (db.duel_votes.some(x => x.duel_id === d.id)) return err('already_voted');
      db.duel_votes.push({ duel_id: d.id, side: p_side }); d[p_side + '_votes']++; meP().xp += 5;
      return ok({ a_votes: d.a_votes, b_votes: d.b_votes, side: p_side });
    },
    settle_duels: () => ok(0),
    mark_notifications_read: () => { db.notifications.forEach(n => { n.read = true; }); return ok(null); },
    unread_count: () => ok(db.notifications.filter(n => !n.read).length),
    my_stats: () => ok({ posts: db.posts.filter(p => p.author_id === ME).length, replies: db.replies.filter(r => r.author_id === ME).length, backs: db.positions.length,
      votes: db.duel_votes.length, edits: db.post_edits.filter(e => byId('posts', e.post_id) && byId('posts', e.post_id).author_id === ME).length, likes_given: 0, reposts: 0 }),
    delete_my_account: () => { db.profiles = db.profiles.filter(p => p.id !== ME); window.__deleted = true; return ok(null); },
    my_profile: () => ok(meP() ? Object.assign({}, meP()) : null),
    search_people: ({ p_query = '', p_limit = 20 }) => {
      const q = String(p_query || '').trim().toLowerCase(), h = q.replace(/^@/, '');
      return ok(db.profiles.filter(p => p.id !== ME && !p.is_banned && !blockedWith(p.id) && (!q || p.handle.includes(h) || p.name.toLowerCase().includes(q)))
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, p_limit)
        .map(p => ({ id: p.id, handle: p.handle, name: p.name, hue: p.hue, bio: p.bio, pro: p.pro, followers_count: p.followers_count, following_count: p.following_count })));
    },
    mod_set_reply_removed: ({ p_reply, p_removed }) => { const r = byId('replies', p_reply); if (!r) return err('not_found'); r.removed = p_removed; db.reports_mod.forEach(x => { if (x.reply_id === r.id) x.post_removed = p_removed; }); return ok(null); },
    mod_reset_profile: ({ p_user }) => { const u = byId('profiles', p_user); if (!u) return err('not_found'); u.name = u.handle; u.bio = ''; return ok(null); },
    app_switches: () => ok(switches()),
    mod_set_switch: ({ p_name, p_on }) => {
      if (!meP().is_admin) return err('not_admin');
      if (p_name !== 'ads' || typeof p_on !== 'boolean') return err('bad_switch');
      db.settings.ads_enabled = p_on; saveSettings();
      return ok(switches());
    },
    record_ad_view: ({ p_ad }) => { if (!db.settings.ads_enabled) return err('ads_off'); const a = byId('ads', p_ad); if (!a || !a.active) return err('not_found'); const m = meP(); const e = +(a.bid_cents * 0.7).toFixed(2); m.earnings_cents += e; return ok({ earned_cents: e, earnings_cents: m.earnings_cents }); },
    mod_open_reports: () => meP().is_admin ? ok(db.reports_mod.filter(r => r.status === 'open')) : err('not_admin'),
    mod_set_post_removed: ({ p_post, p_removed }) => { const p = byId('posts', p_post); if (!p) return err('not_found'); p.removed = p_removed; db.reports_mod.forEach(r => { if (r.post_id === p.id) r.post_removed = p_removed; }); return ok(null); },
    mod_set_banned: ({ p_user, p_banned }) => { if (p_user === ME) return err('not_allowed'); const u = byId('profiles', p_user); u.is_banned = p_banned; db.reports_mod.forEach(r => { if (r.target_user === p_user) r.target_banned = p_banned; }); return ok(null); },
    mod_resolve_report: ({ p_report, p_status }) => { const r = db.reports_mod.find(x => x.report_id === p_report); if (!r) return err('not_found'); r.status = p_status; return ok(null); },
    mod_create_duel: (a) => {
      if (a.p_hours < 1 || a.p_hours > 72) return err('bad_amount');
      const h = x => x && db.profiles.find(p => p.handle === String(x).replace(/^@/, '').toLowerCase());
      if (a.p_a_handle && !h(a.p_a_handle)) return err('not_found');
      const id = nextId++;
      db.duels.push({ id, title: a.p_title, a_user: h(a.p_a_handle) ? h(a.p_a_handle).id : null, a_label: a.p_a_label || h(a.p_a_handle).name, a_take: a.p_a_take,
        b_user: h(a.p_b_handle) ? h(a.p_b_handle).id : null, b_label: a.p_b_label || h(a.p_b_handle).name, b_take: a.p_b_take, a_votes: 0, b_votes: 0,
        starts_at: iso(Date.now()), ends_at: iso(Date.now() + a.p_hours * 36e5), settled: false });
      return ok(id);
    },
  };

  class Q {
    constructor(t) { this.t = t; this.op = 'select'; this.f = []; this.payload = null; this.opts = null; this.one = null; this.ret = false; this.ord = null; this.lim = null; this.cols = '*'; }
    select(c) { if (this.op === 'select') this.cols = c || '*'; else this.ret = true; return this; }
    insert(p) { this.op = 'insert'; this.payload = p; return this; }
    upsert(p, o) { this.op = 'upsert'; this.payload = p; this.opts = o || null; return this; }
    update(p) { this.op = 'update'; this.payload = p; return this; }
    delete() { this.op = 'delete'; return this; }
    eq(c, v) { this.f.push(['eq', c, v]); return this; }
    in(c, v) { this.f.push(['in', c, v]); return this; }
    order(c, o) { this.ord = [c, !o || o.ascending !== false]; return this; }
    limit(n) { this.lim = n; return this; }
    maybeSingle() { this.one = 'maybe'; return this; }
    single() { this.one = 'one'; return this; }
    match(r) { return this.f.every(([k, c, v]) => k === 'eq' ? String(r[c]) === String(v) : v.map(String).includes(String(r[c]))); }
    then(res, rej) { return new Promise(r => setTimeout(r, 5)).then(() => this.run()).then(res, rej); }
    run() {
      calls.push({ kind: 'from', table: this.t, op: this.op, payload: this.payload, filters: this.f, opts: this.opts, cols: this.cols });
      const fail = failFor(this.t + '.' + this.op); if (fail) return fail;
      const T = db[this.t]; if (!T) return err('relation does not exist', '42P01');
      let rows;
      if (this.op === 'select') {
        rows = T.filter(r => this.match(r));
        if (this.t === 'posts') rows = rows.filter(visible);
        if (this.t === 'notifications' || this.t === 'positions' || this.t === 'mutes') rows = rows.filter(r => (r.user_id || ME) === ME);
        if (this.t === 'ads') rows = rows.filter(a => (a.active && db.settings.ads_enabled) || meP().is_admin); // RLS, as in schema.sql
        if (this.ord) { const [c, asc] = this.ord; rows = [...rows].sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1)); }
        if (this.lim != null) rows = rows.slice(0, this.lim);
        rows = rows.map(r => Object.assign({}, r));
      } else if (this.op === 'insert' || this.op === 'upsert') {
        const p = Object.assign({}, this.payload);
        if (this.t === 'posts') {
          if (meP().is_banned) return err('banned');
          if (!String(p.body || '').trim() || String(p.body).length > 500) return err('new row violates check constraint "posts_body_check"', '23514');
          Object.assign(p, post({ id: nextId++, author_id: ME, body: p.body, mood: p.mood, created_at: iso(Date.now()) }));
          T.push(p); meP().xp += 25; rows = [p];
        } else if (this.t === 'reactions') {
          const ex = T.find(r => r.user_id === ME && r.post_id === p.post_id), po = byId('posts', p.post_id);
          if (ex) { if (ex.kind !== p.kind) { po[ex.kind + 's']--; po[p.kind + 's']++; ex.kind = p.kind; } }
          else { T.push({ user_id: ME, post_id: p.post_id, kind: p.kind }); po[p.kind + 's']++; }
          reprice(po); rows = [];
        } else if (this.t === 'reposts') {
          if (T.some(r => r.user_id === ME && r.post_id === p.post_id)) return err('duplicate key value violates unique constraint', '23505');
          T.push({ user_id: ME, post_id: p.post_id }); byId('posts', p.post_id).reposts++; rows = [];
        } else if (this.t === 'replies') {
          const r = { id: nextId++, post_id: p.post_id, author_id: ME, body: p.body, removed: false, created_at: iso(Date.now()) };
          T.push(r); byId('posts', p.post_id).replies++; rows = [r];
        } else if (this.t === 'follows') {
          if (blockedWith(p.followee)) return err('blocked');
          T.push({ follower: ME, followee: p.followee }); byId('profiles', p.followee).followers_count++; meP().following_count++; rows = [];
        } else if (this.t === 'mutes') { T.push({ user_id: ME, muted_id: p.muted_id }); rows = []; }
        else if (this.t === 'blocks') {
          T.push({ blocker: ME, blocked: p.blocked });
          db.follows = db.follows.filter(f => !((f.follower === ME && f.followee === p.blocked) || (f.follower === p.blocked && f.followee === ME))); rows = [];
        } else if (this.t === 'reports') {
          const n = ['post_id', 'reply_id', 'profile_id'].filter(k => p[k] != null).length;
          if (n !== 1) return err('new row violates row-level security policy for table "reports"', '42501');
          T.push(Object.assign({ id: nextId++, reporter: ME, status: 'open' }, p)); rows = [];
        } else { T.push(p); rows = [p]; }
      } else if (this.op === 'update') {
        rows = T.filter(r => this.match(r));
        if (this.t === 'profiles') {
          if (this.payload.handle && db.profiles.some(x => x.handle === this.payload.handle && x.id !== ME)) return err('handle_taken');
          rows = rows.filter(r => r.id === ME);
        }
        if (this.t === 'posts') {
          rows = rows.filter(r => r.author_id === ME);
          rows.forEach(r => { if (this.payload.body != null && this.payload.body !== r.body) { db.post_edits.push({ id: nextId++, post_id: r.id, body: r.body, written_at: r.edited_at || r.created_at }); r.edited_at = iso(Date.now()); } });
        }
        rows.forEach(r => { for (const k of Object.keys(this.payload)) if (k !== 'body' || this.t !== 'posts') r[k] = this.payload[k]; else r.body = this.payload.body; });
        rows = rows.map(r => Object.assign({}, r));
      } else if (this.op === 'delete') {
        const gone = T.filter(r => this.match(r));
        db[this.t] = T.filter(r => !gone.includes(r));
        if (this.t === 'reactions') gone.forEach(r => { const po = byId('posts', r.post_id); po[r.kind + 's']--; reprice(po); });
        if (this.t === 'reposts') gone.forEach(r => { byId('posts', r.post_id).reposts--; });
        if (this.t === 'replies') gone.forEach(r => { byId('posts', r.post_id).replies--; });
        if (this.t === 'follows') gone.forEach(f => { byId('profiles', f.followee).followers_count--; meP().following_count--; });
        rows = [];
      }
      if (this.op !== 'select' && !this.ret) return { data: null, error: null, status: 201 };
      if (this.one) {
        if (rows.length === 1) return ok(rows[0]);
        if (!rows.length && this.one === 'maybe') return ok(null);
        return err('JSON object requested, multiple (or no) rows returned', 'PGRST116');
      }
      return ok(rows);
    }
  }

  // ---- auth
  const KEY = 'fake-supabase-session';
  const mkSession = email => ({ access_token: 'tok', refresh_token: 'ref', token_type: 'bearer', expires_in: 3600, user: { id: ME, email: email || 'tester@example.com' } });
  let session = null;
  try { session = JSON.parse(localStorage.getItem(KEY)); } catch (e) { session = null; }
  if (CFG.session && !session) session = mkSession();
  const listeners = [];
  const emit = (ev, s) => listeners.forEach(cb => { try { cb(ev, s); } catch (e) { console.warn(e); } });
  const store = s => { session = s; try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch (e) { /* */ } };
  const recovery = /type=recovery/.test(location.hash);
  const auth = {
    async getSession() { calls.push({ kind: 'auth', op: 'getSession' }); await new Promise(r => setTimeout(r, 5)); return { data: { session }, error: null }; },
    onAuthStateChange(cb) {
      listeners.push(cb);
      setTimeout(() => cb(recovery && session ? 'PASSWORD_RECOVERY' : 'INITIAL_SESSION', session), 0);
      return { data: { subscription: { unsubscribe() { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); } } } };
    },
    async signInWithPassword({ email, password }) {
      calls.push({ kind: 'auth', op: 'signInWithPassword', email });
      if (CFG.authError) return { data: { user: null, session: null }, error: Object.assign({ name: 'AuthApiError' }, CFG.authError) };
      if (password !== 'correct-horse') return { data: { user: null, session: null }, error: { name: 'AuthApiError', message: 'Invalid login credentials', status: 400, code: 'invalid_credentials' } };
      store(mkSession(email)); emit('SIGNED_IN', session); return { data: { user: session.user, session }, error: null };
    },
    async signUp(args) {
      calls.push({ kind: 'auth', op: 'signUp', args });
      if (CFG.signup === 'duplicate') return { data: { user: { id: 'fake-' + Date.now(), email: args.email, identities: [] }, session: null }, error: null };
      if (CFG.signup === 'unauthorized') return { data: { user: null, session: null }, error: { name: 'AuthApiError', status: 400, code: 'email_address_not_authorized', message: `Email address "${args.email}" cannot be used as it is not authorized` } };
      if (CFG.signupSession) { store(mkSession(args.email)); emit('SIGNED_IN', session); return { data: { user: session.user, session }, error: null }; }
      return { data: { user: { id: 'new', email: args.email }, session: null }, error: null };
    },
    async signOut(opts) { calls.push({ kind: 'auth', op: 'signOut', opts }); store(null); emit('SIGNED_OUT', null); return { error: null }; },
    async resetPasswordForEmail(email, opts) { calls.push({ kind: 'auth', op: 'resetPasswordForEmail', email, opts }); return { data: {}, error: null }; },
    async resend(args) { calls.push({ kind: 'auth', op: 'resend', args }); return { data: { user: null, session: null }, error: null }; },
    async updateUser(attrs) { calls.push({ kind: 'auth', op: 'updateUser', attrs }); return { data: { user: session && session.user }, error: null }; },
  };

  window.supabase = {
    createClient(url, key, opts) {
      calls.push({ kind: 'createClient', url, key, opts });
      return {
        auth,
        from: t => new Q(t),
        rpc(fn, args) {
          const q = { then(res, rej) { return new Promise(r => setTimeout(r, (CFG.delay && CFG.delay[fn]) || 5)).then(() => {
            calls.push({ kind: 'rpc', fn, args: args || null });
            const fail = failFor('rpc.' + fn); if (fail) return fail;
            const h = RPC[fn]; if (!h) return err('function not found', 'PGRST202');
            return h(args || {});
          }).then(res, rej); } };
          return q;
        },
      };
    },
  };
})();
