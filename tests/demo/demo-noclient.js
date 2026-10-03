'use strict';
// Demo mode never loads supabase-js, never shows the sign-in gate and never touches live-mode storage
// (bensocial.live.v1, or the live switches cache bensocial.live.switches).
// Run through run.sh, or: node tests/demo/demo-noclient.js
const { OFF, launch } = require('./env');

(async () => {
  const b = await launch();
  const ctx = await b.newContext(); const page = await ctx.newPage();
  const reqs = []; page.on('request', r => reqs.push(r.url()));
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(OFF); await page.waitForSelector('#view .post');
  await page.waitForTimeout(4000);
  const r = await page.evaluate(() => ({
    scripts: document.querySelectorAll('script[src]').length, sb: typeof window.supabase, gate: document.getElementById('gate').hidden,
    live: localStorage.getItem('bensocial.live.v1'), switches: localStorage.getItem('bensocial.live.switches'),
    session: Object.keys(sessionStorage).filter(k => k.startsWith('bensocial.')),
  }));
  const other = reqs.filter(u => !u.startsWith('file://') && !/fonts\.(googleapis|gstatic)/.test(u));
  console.log(JSON.stringify({ ...r, otherRequests: other, errs }));
  const ok = r.scripts === 0 && r.sb === 'undefined' && r.gate === true && r.live === null && r.switches === null && !r.session.length && !other.length && !errs.length;
  console.log(ok ? 'PASS demo: no supabase-js request, no gate, no live storage' : 'FAIL');
  await b.close(); process.exit(ok ? 0 : 1);
})();
