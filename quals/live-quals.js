// Post-deploy smoke quals: hit the LIVE deployed API (network!) and check
// liveness + response shape. Chained onto `npm run deploy`; deliberately not
// part of `npm run quals`, which stays offline-deterministic.
//
// Run: node quals/live-quals.js
'use strict';
const fs = require('fs');
const path = require('path');

// Single source of truth: the API URL the frontend actually uses
const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const API = APP_JS.match(/const API = '(https:\/\/[^']+)'/)[1];

let passed = 0;
function ok(cond, label) {
  if (!cond) { console.error('FAIL: ' + label); process.exit(1); }
  passed++;
}

(async () => {
  let r = await (await fetch(API)).json();
  ok(r.ok, 'live API answers: ' + JSON.stringify(r));
  r = await (await fetch(API + '?action=state&aname=tau')).json();
  ok(r.aname === 'tau' && Array.isArray(r.bidders)
     && r.bidders.every((b) => typeof b.uname === 'string'
                            && typeof b.updated === 'string'),
     'live state shape matches what app.js expects: ' + JSON.stringify(r).slice(0, 120));
  r = await (await fetch(API + '?action=state&aname=smoketest')).json();
  ok(r.bidders.length >= 2 && r.bidders.every((b) => b.subs >= 1),
     'live legacy rows count >= 1: ' + JSON.stringify(r.bidders));
  console.log('live-quals: all ' + passed
    + ' assertions passed — deployed API is current');
})().catch((e) => { console.error(e); process.exit(1); });
