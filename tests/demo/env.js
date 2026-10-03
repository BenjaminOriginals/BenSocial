'use strict';
// Shared setup for the suites in tests/demo: repo paths, Playwright, the
// scratch folder, and copies of index.html with SWITCHES flipped.
// Everything these suites write goes to tests/demo/.out/ (gitignored).

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'index.html');
const OUT = path.join(__dirname, '.out');
const SHOTS = path.join(OUT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const fileUrl = f => pathToFileURL(f).href;
const OFF = fileUrl(SRC); // The committed index.html: demo mode, both switches off.

// Playwright: PLAYWRIGHT_MODULE, then a normal install, then the sandbox copy.
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
  return chromium.launch({ headless: !process.env.HEADED, ...(exe ? { executablePath: exe } : {}) });
}

// A copy of index.html with SWITCHES flipped, written to .out/<name>.html. Returns its file:// URL.
function variant(name, ads, payments) {
  const html = fs.readFileSync(SRC, 'utf8');
  if (html.split('ads: false,').length !== 2 || html.split('payments: false,').length !== 2) {
    throw new Error('index.html must have SWITCHES committed off, each on one line (ads: false, payments: false,)');
  }
  const out = html.replace('ads: false,', `ads: ${ads},`).replace('payments: false,', `payments: ${payments},`);
  const f = path.join(OUT, name + '.html');
  fs.writeFileSync(f, out);
  return fileUrl(f);
}

// The first prototype, straight from git history, for the regression diff in verify.js.
const ORIGINAL_COMMIT = 'a1e807c';
function original() {
  let html;
  try {
    html = execFileSync('git', ['-C', ROOT, 'show', `${ORIGINAL_COMMIT}:index.html`], { encoding: 'utf8', maxBuffer: 64 << 20 });
  } catch (e) {
    throw new Error(`Could not read the first prototype with "git show ${ORIGINAL_COMMIT}:index.html". Run from a full clone (not shallow).`);
  }
  const f = path.join(OUT, 'original.html');
  fs.writeFileSync(f, html);
  return fileUrl(f);
}

// supabase-js 2.117.2 from npm, the same bytes jsDelivr and unpkg serve. tests/e2e installs it (run.sh does too).
function supabaseBuild() {
  try {
    return require.resolve('@supabase/supabase-js/dist/umd/supabase.js', { paths: [path.join(ROOT, 'tests', 'e2e')] });
  } catch (e) {
    throw new Error('supabase-js is not installed. Run: (cd tests/e2e && npm ci)');
  }
}

module.exports = { ROOT, SRC, OUT, SHOTS, OFF, fileUrl, launch, variant, original, supabaseBuild };
