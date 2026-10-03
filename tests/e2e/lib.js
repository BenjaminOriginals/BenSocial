'use strict';
// Shared helpers for the e2e specs: Playwright setup, direct database
// access, checks, and a few UI helpers. run.sh sets the env these read.

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:54341';
const ARTIFACTS = path.join(__dirname, '.artifacts');
const HEADED = !!process.env.HEADED;

function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/node-tools/node_modules/playwright'].filter(Boolean);
  for (const t of tries) {
    try { return require(t); } catch (e) { /* try the next one */ }
  }
  throw new Error('Playwright not found. Install it (npm i -g playwright) or set PLAYWRIGHT_MODULE.');
}

async function launch() {
  const { chromium } = loadPlaywright();
  const exe = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(p => p && fs.existsSync(p));
  return chromium.launch({ headless: !HEADED, ...(exe ? { executablePath: exe } : {}) });
}

// ------------------------------------------------------------------ database
// Direct access as the cluster superuser, to check what the app wrote.
const pool = new Pool({ host: process.env.PGHOST, port: Number(process.env.PGPORT || 54339), user: 'supabase_admin', database: 'postgres', max: 3 });
const db = {
  async rows(sql, params = []) { return (await pool.query(sql, params)).rows; },
  async one(sql, params = []) { const r = await pool.query(sql, params); return r.rows[0] || null; },
  async val(sql, params = []) { const r = await pool.query(sql, params); const row = r.rows[0]; return row ? row[Object.keys(row)[0]] : null; },
  end() { return pool.end(); },
};

// ------------------------------------------------------------------ checks
let passed = 0;
const failures = [];
let section = '';
function begin(name) { section = name; console.log(`\n-- ${name}`); }
function check(cond, msg) {
  if (cond) { passed++; if (process.env.VERBOSE) console.log(`   ok   ${msg}`); }
  else { failures.push(`[${section}] ${msg}`); console.log(`   FAIL ${msg}`); }
  return !!cond;
}
function eq(actual, expected, msg) {
  const ok = Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  return check(ok, ok ? msg : `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}
function near(actual, expected, tol, msg) {
  const ok = Math.abs(Number(actual) - Number(expected)) <= tol;
  return check(ok, ok ? msg : `${msg} (expected ${expected} ± ${tol}, got ${actual})`);
}
// Polls fn until it returns something truthy. Returns the last value.
async function until(fn, { timeout = 8000, every = 100 } = {}) {
  const end = Date.now() + timeout;
  let v;
  for (;;) {
    try { v = await fn(); } catch (e) { v = undefined; }
    if (v || Date.now() > end) return v;
    await new Promise(r => setTimeout(r, every));
  }
}
function summary(label) {
  console.log(`\n${label}: ${passed} checks passed, ${failures.length} failed.`);
  failures.forEach(f => console.log('  - ' + f));
  return failures.length === 0;
}

// ------------------------------------------------------------------ browser
// One signed-in person = one browser context. Page errors are always
// failures. Console errors are failures too, unless the step that caused
// them said they were expected (a refused request logs a 4xx line).
async function openUser(browser, label, { width = 1360, height = 900, url = BASE + '/' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: 'light', locale: 'en-US' });
  // Nothing leaves the machine: fonts get an empty stylesheet, anything else external is refused.
  await ctx.route(url => !url.href.startsWith(BASE), route => {
    const u = route.request().url();
    if (/fonts\.(googleapis|gstatic)\.com/.test(u)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    return route.abort();
  });
  const user = { label, ctx, pages: [], errors: [], expected: [], allow: null, requests: [] };
  user.expect = (re, fn) => expectConsoleErrors(user, re, fn);
  ctx.on('request', r => user.requests.push(`${r.method()} ${r.url()}`));
  user.page = await addPage(user, url);
  return user;
}
async function addPage(user, url = BASE + '/') {
  const page = await user.ctx.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', e => user.errors.push(`${user.label} pageerror: ${e.message}`));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const text = `${user.label} console: ${m.text()}`;
    if (user.allow && user.allow.test(m.text())) user.expected.push(text); else user.errors.push(text);
  });
  user.pages.push(page);
  await page.goto(url);
  return page;
}
// Runs fn while console errors matching re are expected, then waits a moment for late ones.
async function expectConsoleErrors(user, re, fn) {
  user.allow = re;
  try { return await fn(); } finally { await new Promise(r => setTimeout(r, 300)); user.allow = null; }
}

async function screenshots(users, tag) {
  try {
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    for (const u of users) {
      for (const [i, p] of u.pages.entries()) {
        if (p.isClosed()) continue;
        const f = path.join(ARTIFACTS, `${tag}-${u.label}${i ? '-' + i : ''}.png`);
        await p.screenshot({ path: f, fullPage: false }).catch(() => {});
        console.log('   screenshot: ' + path.relative(process.cwd(), f));
      }
    }
  } catch (e) { console.log('   (could not save screenshots: ' + e.message + ')'); }
}

// ------------------------------------------------------------------ UI helpers
const toast = (page, text, timeout = 8000) => page.locator('#toasts .toast', { hasText: text }).first().waitFor({ timeout });
const gateText = page => page.evaluate(() => { const g = document.getElementById('gate'); return g && !g.hidden ? g.innerText : ''; });
const viewText = page => page.locator('#view').innerText();
const waitApp = page => page.waitForFunction(() => document.getElementById('gate').hidden && !!document.querySelector('#view .view-title, #view .panel, #view .back-btn'), null, { timeout: 15000 });
const waitAuth = page => page.waitForSelector('#gate [data-form="signin"]', { timeout: 15000 });
const go = async (page, view) => { await page.click(`#rail [data-nav="${view}"]`); await page.waitForFunction(v => location.hash === '#' + v, view); };
const postSel = id => `#view [data-post="${id}"]`;
// Waits for one backend response while running an action.
async function withResponse(page, match, action) {
  const [resp] = await Promise.all([
    page.waitForResponse(r => {
      const u = r.url();
      return (typeof match === 'string' ? u.includes(match) : match(r)) && r.request().method() !== 'OPTIONS';
    }, { timeout: 10000 }),
    action(),
  ]);
  return resp;
}
const rpcPath = fn => r => r.url().includes(`/rest/v1/rpc/${fn}`);
const tablePath = (table, method) => r => new URL(r.url()).pathname === `/rest/v1/${table}` && (!method || r.request().method() === method);

// Local calendar day, like dayKey() in the app.
const localDay = (d = new Date()) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

async function signUpUI(page, { name, handle, email, password }) {
  await page.click('#tab-signup');
  await page.fill('#su-name', name);
  await page.fill('#su-handle', handle);
  await page.locator('#su-handle-status', { hasText: 'Available' }).waitFor();
  await page.fill('#su-email', email);
  await page.fill('#su-password', password);
  await page.check('#su-age');
  await page.check('#su-terms');
  await page.click('#gate [data-form="signup"] button:not([type])');
  await waitApp(page);
}
async function signInUI(page, email, password) {
  await page.fill('#auth-email', email);
  await page.fill('#auth-password', password);
  await page.click('#gate [data-form="signin"] button:not([type])');
}
async function signOutUI(page) {
  await go(page, 'profile');
  await page.click('#view [data-act="signOut"]');
  await waitAuth(page);
}

module.exports = {
  BASE, launch, db, begin, check, eq, near, until, summary, openUser, addPage, expectConsoleErrors, screenshots,
  toast, gateText, viewText, waitApp, waitAuth, go, postSel, withResponse, rpcPath, tablePath, localDay,
  signUpUI, signInUI, signOutUI,
};
