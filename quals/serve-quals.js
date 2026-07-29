// Quals for serve.py: it must mimic GitHub Pages, i.e., serve real files
// normally and answer any miss with 404.html (status 404) so the reload
// journey covered in frontend-quals.js works locally.
//
// Replicata of the original bug: `python3 -m http.server`, load /, app.js
// rewrites the URL to /tau, reload. Expectata: the app again. Resultata:
// a bare "Error code: 404" page, because the stock server has no /tau.
//
// Run: node quals/serve-quals.js
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PORT = 8377;
const BASE = 'http://localhost:' + PORT;

let passed = 0;
function ok(cond, label) {
  if (!cond) { console.error('FAIL: ' + label); process.exit(1); }
  passed++;
}

(async () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  ok(!pkg.scripts.quals.includes('sync-404'),
     'the qual command audits index/404 parity without rewriting the'
     + ' artifact it is meant to inspect');

  // fail LOUD if a stale server squats the port: the spawn below
  // would die silently on EADDRINUSE and we'd interrogate a zombie
  // (it happened: a crashed run's leftover served pre-fix bytes)
  try {
    await fetch(BASE + '/');
    console.error('FAIL: port ' + PORT + ' is already serving —'
      + ' kill the stale server (lsof -i :' + PORT + ') and rerun');
    process.exit(1);
  } catch (e) { /* connection refused = port free, good */ }
  const server = spawn('python3', [path.join(REPO, 'serve.py'), String(PORT)],
                       { stdio: 'ignore' });
  // a FAILING run exits via process.exit, which skips finally — the
  // orphaned server then squats the port for every later run (the
  // pre-flight guard catches it; this prevents it)
  process.on('exit', () => { try { server.kill(); } catch (e) {} });
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { await fetch(BASE + '/'); up = true; }
      catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    ok(up, 'serve.py came up on port ' + PORT);

    let r = await fetch(BASE + '/');
    ok(r.status === 200, 'GET / is 200');
    ok((await r.text()).includes('id="aname"'), 'GET / serves the app');

    r = await fetch(BASE + '/style.css');
    ok(r.status === 200, 'real files still served');
    ok(r.headers.get('cache-control') === 'no-store',
       'a dev server never lies about freshness: no-store on every'
       + " response (Chrome's heuristic caching served dreev"
       + ' hour-stale CSS)');

    r = await fetch(BASE + '/tau');
    ok(r.status === 404, 'GET /tau is 404 (same status as GitHub Pages)');
    ok((await r.text()) === fs.readFileSync(path.join(REPO, '404.html'), 'utf8'),
       'GET /tau serves 404.html verbatim');

    r = await fetch(BASE + '/no/such/file.png');
    ok(r.status === 404 && (await r.text()).includes('id="aname"'),
       'arbitrary misses serve the app too');

    console.log('serve-quals: all ' + passed + ' assertions passed');
  } finally {
    server.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });
