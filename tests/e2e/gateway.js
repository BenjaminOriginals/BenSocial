#!/usr/bin/env node
'use strict';
// =====================================================================
// One port that looks like a Supabase project plus the app:
//   /                      index.html, with a script that points it here
//                          (/?key=publishable uses the new-style key instead)
//   /scratch/<name>.html   a page from E2E_SCRATCH_DIR (switch-flipped copies)
//   /vendor/supabase.js    the npm build of @supabase/supabase-js 2.117.2
//   /rest/v1/*             proxied to PostgREST
//   /auth/v1/*             the GoTrue stand-in (auth-stub.js)
//   /__health              JSON { ok, anonKey, publishableKey }
// Like Supabase's API gateway, /rest/v1 and /auth/v1 need an apikey header
// (except /auth/v1/verify, the link in confirmation and recovery emails).
// Both key styles work: the legacy anon JWT, and an sb_publishable_ key,
// which is swapped for the anon JWT before PostgREST sees it.
//
// Env: GATEWAY_PORT, POSTGREST_URL, JWT_SECRET, PGHOST (socket dir), PGPORT,
//      APP_HTML (default ../../index.html), E2E_SCRATCH_DIR (optional).
// =====================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { createAuth, anonKey, verifyJwt } = require('./auth-stub');

const PORT = Number(process.env.GATEWAY_PORT || 54341);
const POSTGREST = new URL(process.env.POSTGREST_URL || 'http://127.0.0.1:54340');
const SECRET = process.env.JWT_SECRET;
const APP_HTML = process.env.APP_HTML || path.join(__dirname, '..', '..', 'index.html');
const SCRATCH = process.env.E2E_SCRATCH_DIR || '';
const VENDOR = require.resolve('@supabase/supabase-js/dist/umd/supabase.js');

if (!SECRET || SECRET.length < 32) {
  console.error('JWT_SECRET must be set (at least 32 characters).');
  process.exit(2);
}

const ANON_KEY = anonKey(SECRET);
const PUBLISHABLE_KEY = 'sb_publishable_' + require('crypto').createHash('sha256').update(SECRET).digest('base64url').slice(0, 24);
const pool = new Pool({
  host: process.env.PGHOST, port: Number(process.env.PGPORT || 5432),
  user: 'supabase_auth_admin', database: 'postgres', max: 4,
});
pool.on('error', e => console.error('[gateway] pg pool error', e.message));
const auth = createAuth({ pool, secret: SECRET });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, prefer, range, accept, accept-profile, content-profile, x-client-info, x-supabase-api-version',
  'Access-Control-Expose-Headers': 'content-range, x-supabase-api-version',
  'Access-Control-Max-Age': '600',
};

// The page reads these before the app script runs (see BACKEND in index.html).
function inject(html, publishable) {
  const backend = publishable ? `supabaseKey: ${JSON.stringify(PUBLISHABLE_KEY)}` : `supabaseAnonKey: ${JSON.stringify(ANON_KEY)}`;
  const tag = `<script>window.BENSOCIAL_BACKEND = { supabaseUrl: location.origin, ${backend} };
window.BENSOCIAL_SUPABASE_SRC = '/vendor/supabase.js';</script>`;
  return html.replace(/<head(\s[^>]*)?>/i, m => m + '\n' + tag);
}

function sendFile(res, file, type, transform) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    const body = transform ? transform(buf.toString('utf8')) : buf;
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Like Kong on Supabase: the apikey must be a key for this project.
function apiKeyOk(req) {
  const key = req.headers.apikey;
  if (!key) return 'No API key found in request';
  if (key === PUBLISHABLE_KEY) return null;
  const claims = verifyJwt(key, SECRET);
  return claims && (claims.role === 'anon' || claims.role === 'service_role') ? null : 'Invalid API key';
}

function proxyRest(req, res, rest) {
  const headers = { ...req.headers, host: POSTGREST.host };
  delete headers.apikey;
  if (headers.authorization === 'Bearer ' + PUBLISHABLE_KEY) headers.authorization = 'Bearer ' + ANON_KEY;
  const up = http.request({ host: POSTGREST.hostname, port: POSTGREST.port, method: req.method, path: rest, headers }, r => {
    res.writeHead(r.statusCode, { ...r.headers, ...CORS });
    r.pipe(res);
  });
  up.on('error', e => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ message: 'PostgREST unreachable: ' + e.message }));
  });
  req.pipe(up);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    if (p === '/__health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, anonKey: ANON_KEY, publishableKey: PUBLISHABLE_KEY }));
      return;
    }
    if (p.startsWith('/rest/v1/') || p === '/rest/v1' || p.startsWith('/auth/v1/')) {
      // Email links open in a plain browser tab, so /auth/v1/verify is open, as on Supabase.
      const bad = p === '/auth/v1/verify' ? null : apiKeyOk(req);
      if (bad) {
        res.writeHead(401, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ message: bad }));
        return;
      }
      if (p.startsWith('/auth/v1/')) {
        const body = await readBody(req);
        Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
        await auth(req, res, p.slice('/auth/v1'.length), url.searchParams, body);
        return;
      }
      proxyRest(req, res, (p.slice('/rest/v1'.length) || '/') + url.search);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    const withKey = html => inject(html, url.searchParams.get('key') === 'publishable');
    if (p === '/' || p === '/index.html') { sendFile(res, APP_HTML, 'text/html; charset=utf-8', withKey); return; }
    const m = /^\/scratch\/([a-z0-9-]+\.html)$/.exec(p);
    if (m && SCRATCH) { sendFile(res, path.join(SCRATCH, m[1]), 'text/html; charset=utf-8', withKey); return; }
    if (p === '/vendor/supabase.js') { sendFile(res, VENDOR, 'application/javascript; charset=utf-8'); return; }
    if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
    console.error('[gateway] ' + (e && e.stack || e));
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Gateway error');
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`[gateway] listening on http://127.0.0.1:${PORT}`));
const stop = () => { server.close(); pool.end().finally(() => process.exit(0)); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
