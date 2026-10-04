'use strict';
// =====================================================================
// A small GoTrue stand-in, good enough for @supabase/supabase-js 2.117.2.
//
// Accounts live in auth.users of the test database, so the sign-up trigger
// in supabase/schema.sql runs exactly as it does on Supabase. The stub
// connects as supabase_auth_admin, the role GoTrue uses.
//
// Endpoints (under /auth/v1):
//   POST /signup                        autoconfirm: returns a session
//   POST /resend                        a new confirmation link (type signup)
//   POST /token?grant_type=password
//   POST /token?grant_type=refresh_token
//   GET  /user, PUT /user
//   POST /logout                        204
//   POST /recover                       200; records a recovery link
//   GET  /verify?token&type&redirect_to  the email link: redirects back to
//                                       the app with tokens in the hash
//   GET  /settings
// Test-only conventions:
//   * an email ending in @confirm.test must be confirmed first, like a
//     project with "Confirm email" on: /signup returns no session and
//     sign-in fails with email_not_confirmed. Signing up again with such an
//     email that is already confirmed answers like GoTrue does then: 200 and
//     a stand-in user with no identities, no session, no email. (Other
//     emails behave like "Confirm email" off: a duplicate is 422.)
//   * GET /__test/links?email=... returns the latest confirmation and
//     recovery links for that address (the emails the stub never sends).
// Access tokens are HS256 JWTs signed with the secret PostgREST checks.
// Errors use the 2024-01-01 API shape: { code: '<error_code>', message }.
// =====================================================================

const crypto = require('crypto');

const API_VERSION = '2024-01-01';
const TOKEN_TTL = 3600;

const b64url = buf => Buffer.from(buf).toString('base64url');

function signJwt(payload, secret) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(head + '.' + body).digest('base64url');
  return head + '.' + body + '.' + sig;
}

function verifyJwt(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const want = crypto.createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest();
  const got = Buffer.from(parts[2], 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!claims || (claims.exp && claims.exp < Math.floor(Date.now() / 1000))) return null;
  return claims;
}

// The public key the app is given. Like Supabase's anon key, it is a JWT for role anon.
function anonKey(secret) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ iss: 'supabase-e2e', ref: 'local', role: 'anon', iat: now, exp: now + 10 * 365 * 86400 }, secret);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function checkPassword(password, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const got = crypto.scryptSync(String(password), Buffer.from(salt, 'hex'), 32);
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

class AuthError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function createAuth({ pool, secret }) {
  // refresh token -> { userId, sessionId }
  const refreshTokens = new Map();
  // email link token -> { userId, type: 'signup' | 'recovery', redirectTo }, and the latest links per email.
  const linkTokens = new Map();
  const links = new Map();
  const NEEDS_CONFIRM = /@confirm\.test$/i;

  function makeLink(u, type, issuer, redirectTo) {
    const token = crypto.randomBytes(16).toString('hex');
    linkTokens.set(token, { userId: u.id, type, redirectTo });
    const q = new URLSearchParams({ token, type });
    if (redirectTo) q.set('redirect_to', redirectTo);
    const url = `${issuer}/verify?${q}`;
    links.set(u.email, { ...(links.get(u.email) || {}), [type]: url });
    return url;
  }

  const userJson = u => ({
    id: u.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: u.email,
    email_confirmed_at: u.email_confirmed_at,
    phone: '',
    confirmed_at: u.email_confirmed_at,
    last_sign_in_at: u.last_sign_in_at,
    app_metadata: u.raw_app_meta_data || { provider: 'email', providers: ['email'] },
    user_metadata: u.raw_user_meta_data || {},
    identities: [{
      identity_id: u.id, id: u.id, user_id: u.id, provider: 'email',
      identity_data: { sub: u.id, email: u.email, email_verified: !!u.email_confirmed_at },
      created_at: u.created_at, updated_at: u.updated_at,
    }],
    created_at: u.created_at,
    updated_at: u.updated_at,
    is_anonymous: false,
  });
  // What GoTrue returns for a sign-up with an email that already has a confirmed account while
  // "Confirm email" is on: a made-up user with no identities, so nobody can probe for accounts.
  const obfuscatedUser = (email, meta) => {
    const now = new Date().toISOString();
    return { id: crypto.randomUUID(), aud: 'authenticated', role: 'authenticated', email, phone: '',
      confirmation_sent_at: now, app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: meta,
      identities: [], created_at: now, updated_at: now, is_anonymous: false };
  };

  function issueSession(u, issuer, sessionId = crypto.randomUUID()) {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      aud: 'authenticated',
      exp: now + TOKEN_TTL,
      iat: now,
      iss: issuer,
      sub: u.id,
      email: u.email,
      phone: '',
      app_metadata: u.raw_app_meta_data || {},
      user_metadata: u.raw_user_meta_data || {},
      role: 'authenticated',
      aal: 'aal1',
      amr: [{ method: 'password', timestamp: now }],
      session_id: sessionId,
      is_anonymous: false,
    };
    const refresh = crypto.randomBytes(18).toString('base64url');
    refreshTokens.set(refresh, { userId: u.id, sessionId });
    return {
      access_token: signJwt(claims, secret),
      token_type: 'bearer',
      expires_in: TOKEN_TTL,
      expires_at: now + TOKEN_TTL,
      refresh_token: refresh,
      user: userJson(u),
    };
  }

  const USER_COLS = 'id, email, encrypted_password, email_confirmed_at, last_sign_in_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at';
  async function userById(id) {
    const r = await pool.query(`select ${USER_COLS} from auth.users where id = $1`, [id]);
    return r.rows[0] || null;
  }
  async function userByEmail(email) {
    const r = await pool.query(`select ${USER_COLS} from auth.users where lower(email) = lower($1)`, [email]);
    return r.rows[0] || null;
  }

  function bearer(req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    const claims = m && verifyJwt(m[1], secret);
    if (!claims || claims.role !== 'authenticated' || !claims.sub) throw new AuthError(401, 'bad_jwt', 'invalid JWT: unable to parse or verify signature');
    return claims;
  }
  async function currentUser(req) {
    const claims = bearer(req);
    const u = await userById(claims.sub);
    if (!u) throw new AuthError(403, 'user_not_found', 'User from sub claim in JWT does not exist');
    return { u, claims };
  }

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  async function signup(body, issuer, redirectTo) {
    const email = String(body.email || '').trim().toLowerCase(), password = String(body.password || '');
    if (!EMAIL_RE.test(email)) throw new AuthError(400, 'email_address_invalid', 'Unable to validate email address: invalid format');
    if (password.length < 6) throw new AuthError(422, 'weak_password', 'Password should be at least 6 characters.');
    const meta = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : {};
    const existing = await userByEmail(email);
    if (existing) {
      if (!NEEDS_CONFIRM.test(email)) throw new AuthError(422, 'user_already_exists', 'User already registered');
      if (existing.email_confirmed_at) return obfuscatedUser(email, meta);
      makeLink(existing, 'signup', issuer, redirectTo); // Not confirmed yet: GoTrue sends the link again.
      return userJson(existing);
    }
    const r = await pool.query(
      `insert into auth.users (instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                               raw_app_meta_data, raw_user_meta_data, last_sign_in_at)
       values ('00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $1, $2,
               case when $4 then null else now() end,
               '{"provider":"email","providers":["email"]}', $3, case when $4 then null else now() end)
       returning ${USER_COLS}`,
      [email, hashPassword(password), JSON.stringify(meta), NEEDS_CONFIRM.test(email)]);
    const u = r.rows[0];
    await pool.query(`insert into auth.identities (user_id, provider, identity_data) values ($1, 'email', $2)`,
      [u.id, JSON.stringify({ sub: u.id, email })]);
    if (!u.email_confirmed_at) { // Like GoTrue with "Confirm email" on: the user, no session.
      makeLink(u, 'signup', issuer, redirectTo);
      return userJson(u);
    }
    return issueSession(u, issuer);
  }

  async function resend(body, issuer, redirectTo) {
    if (body.type !== 'signup') throw new AuthError(400, 'validation_failed', 'Missing one of these types: signup, email_change');
    const u = body.email ? await userByEmail(String(body.email).trim()) : null;
    if (u && !u.email_confirmed_at) makeLink(u, 'signup', issuer, redirectTo);
    return {}; // Same answer either way.
  }

  async function recover(body, issuer, redirectTo) {
    const u = body.email ? await userByEmail(String(body.email).trim()) : null;
    if (u) makeLink(u, 'recovery', issuer, redirectTo);
    return {}; // Same answer either way, so nobody can probe for accounts.
  }

  // The link in the email. GoTrue checks the token, then sends the browser back to the app.
  async function verify(query, issuer) {
    const t = linkTokens.get(query.get('token') || '');
    const back = query.get('redirect_to') || (t && t.redirectTo) || '/';
    if (!t || t.type !== query.get('type')) {
      const q = new URLSearchParams({ error: 'access_denied', error_code: 'otp_expired', error_description: 'Email link is invalid or has expired' });
      return back + '#' + q;
    }
    linkTokens.delete(query.get('token'));
    const r = await pool.query(`update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()), last_sign_in_at = now()
                                 where id = $1 returning ${USER_COLS}`, [t.userId]);
    if (!r.rows[0]) {
      const q = new URLSearchParams({ error: 'access_denied', error_code: 'user_not_found', error_description: 'User not found' });
      return back + '#' + q;
    }
    const sess = issueSession(r.rows[0], issuer);
    const q = new URLSearchParams({
      access_token: sess.access_token, expires_at: String(sess.expires_at), expires_in: String(sess.expires_in),
      refresh_token: sess.refresh_token, token_type: 'bearer', type: t.type,
    });
    return back + '#' + q;
  }

  async function passwordGrant(body, issuer) {
    const u = body.email ? await userByEmail(String(body.email).trim()) : null;
    if (!u || !checkPassword(body.password, u.encrypted_password)) throw new AuthError(400, 'invalid_credentials', 'Invalid login credentials');
    if (!u.email_confirmed_at) throw new AuthError(400, 'email_not_confirmed', 'Email not confirmed');
    const r = await pool.query(`update auth.users set last_sign_in_at = now() where id = $1 returning ${USER_COLS}`, [u.id]);
    return issueSession(r.rows[0], issuer);
  }

  async function refreshGrant(body, issuer) {
    const t = refreshTokens.get(String(body.refresh_token || ''));
    if (!t) throw new AuthError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
    refreshTokens.delete(String(body.refresh_token));
    const u = await userById(t.userId);
    if (!u) throw new AuthError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
    return issueSession(u, issuer, t.sessionId);
  }

  async function updateUser(req, body) {
    const { u } = await currentUser(req);
    const sets = [], vals = [u.id];
    if (body.password != null) {
      if (String(body.password).length < 6) throw new AuthError(422, 'weak_password', 'Password should be at least 6 characters.');
      if (checkPassword(body.password, u.encrypted_password)) throw new AuthError(422, 'same_password', 'New password should be different from the old password.');
      vals.push(hashPassword(String(body.password))); sets.push(`encrypted_password = $${vals.length}`);
    }
    if (body.data && typeof body.data === 'object') {
      vals.push(JSON.stringify(body.data)); sets.push(`raw_user_meta_data = coalesce(raw_user_meta_data, '{}') || $${vals.length}::jsonb`);
    }
    if (!sets.length) return userJson(u);
    const r = await pool.query(`update auth.users set ${sets.join(', ')}, updated_at = now() where id = $1 returning ${USER_COLS}`, vals);
    return userJson(r.rows[0]);
  }

  function logout(req, scope) {
    const claims = bearer(req);
    for (const [tok, t] of refreshTokens) {
      if (t.userId !== claims.sub) continue;
      if (scope === 'others' && t.sessionId === claims.session_id) continue;
      if (scope === 'local' && t.sessionId !== claims.session_id) continue;
      refreshTokens.delete(tok);
    }
  }

  // handle(req, res, path, query, body): path is the part after /auth/v1.
  return async function handle(req, res, path, query, rawBody) {
    const issuer = `http://${req.headers.host}/auth/v1`;
    const send = (status, obj) => {
      const headers = { 'Content-Type': 'application/json', 'X-Supabase-Api-Version': API_VERSION };
      if (status === 204) { res.writeHead(204, headers); res.end(); return; }
      res.writeHead(status, headers); res.end(JSON.stringify(obj));
    };
    let body = {};
    if (rawBody && rawBody.length) {
      try { body = JSON.parse(rawBody.toString('utf8')); } catch (e) { return send(400, { code: 'bad_json', message: 'Could not parse request body as JSON' }); }
    }
    try {
      const m = req.method;
      const redirectTo = query.get('redirect_to') || '';
      if (m === 'POST' && path === '/signup') return send(200, await signup(body, issuer, redirectTo));
      if (m === 'POST' && path === '/token') {
        const grant = query.get('grant_type');
        if (grant === 'password') return send(200, await passwordGrant(body, issuer));
        if (grant === 'refresh_token') return send(200, await refreshGrant(body, issuer));
        throw new AuthError(400, 'validation_failed', 'unsupported_grant_type');
      }
      if (m === 'GET' && path === '/user') return send(200, userJson((await currentUser(req)).u));
      if (m === 'PUT' && path === '/user') return send(200, await updateUser(req, body));
      if (m === 'POST' && path === '/logout') { logout(req, query.get('scope') || 'global'); return send(204); }
      if (m === 'POST' && path === '/recover') return send(200, await recover(body, issuer, redirectTo));
      if (m === 'POST' && path === '/resend') return send(200, await resend(body, issuer, redirectTo));
      if (m === 'GET' && path === '/verify') {
        res.writeHead(303, { Location: await verify(query, issuer), 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      if (m === 'GET' && path === '/__test/links') return send(200, links.get(String(query.get('email') || '').toLowerCase()) || {});
      if (m === 'GET' && path === '/settings') {
        return send(200, { external: { email: true }, disable_signup: false, mailer_autoconfirm: true, phone_autoconfirm: false });
      }
      throw new AuthError(404, 'not_found', 'Not found');
    } catch (e) {
      if (e instanceof AuthError) return send(e.status, { code: e.code, message: e.message });
      console.error('[auth] ' + (e && e.stack || e));
      return send(500, { code: 'unexpected_failure', message: 'Database error' });
    }
  };
}

module.exports = { createAuth, signJwt, verifyJwt, anonKey };
