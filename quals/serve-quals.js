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
  const server = spawn('python3', [path.join(REPO, 'serve.py'), String(PORT)],
                       { stdio: 'ignore' });
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
