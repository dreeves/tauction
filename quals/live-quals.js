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
  // A schema-changing deploy makes the API refuse the old tabs by
  // name; surface that as marching orders, not a shape-assert failure
  if (String(r.error).includes('schema drift')) {
    console.error('DEPLOYED CODE REFUSES THE OLD TABS:\n  ' + r.error
      + '\n  -> open the sheet, rename (or delete) the named tab and'
      + ' any other outdated ones, then rerun: node quals/live-quals.js');
    process.exit(1);
  }
  ok(r.aname === 'tau' && Array.isArray(r.bidders)
     && r.bidders.every((b) => typeof b.uname === 'string'
                            && typeof b.tini === 'string'
                            && typeof b.tmod === 'string')
     && r.claims !== null && typeof r.claims === 'object'
     && r.blurbs !== null && typeof r.blurbs === 'object'
     && typeof r.tfin === 'string',
     'live state shape matches what app.js expects: ' + JSON.stringify(r).slice(0, 120));
  // Self-HEALING preamble: a previous run that died between its
  // claim and its release strands smokey's seat, and every later
  // run's deviceless bid then bounces off ERROR1312 (it happened;
  // dreev had to clean the sheet by hand). Releasing an unheld seat
  // is a documented no-op, so this is safe in every state.
  await fetch(API, { method: 'POST',
    body: JSON.stringify({ action: 'release', aname: 'smoketest',
      uname: 'smokey', deviceID: 'smoke-dev' }) });
  // end-to-end write+read: place a smoke bid, read it back from the
  // returned post-write state (self-seeding: no fixture data needed)
  r = await (await fetch(API, { method: 'POST',
    body: JSON.stringify({ action: 'bid', aname: 'smoketest',
      uname: 'smokey', bid: 'smoke ' + Date.now() }) })).json();
  ok(!r.error, 'live bid accepted: ' + JSON.stringify(r).slice(0, 120));
  const smokey = (r.bidders || []).find((b) => b.uname === 'smokey');
  ok(smokey !== undefined && smokey.bcount >= 1,
     'live bid readable with bcount >= 1: '
       + JSON.stringify(r.bidders).slice(0, 120));
  // the full claim lifecycle against the DEPLOYED script — this is
  // what catches an old deployment missing an action ("unknown
  // action: release", the hard way)
  r = await (await fetch(API, { method: 'POST',
    body: JSON.stringify({ action: 'claim', aname: 'smoketest',
      uname: 'smokey', deviceID: 'smoke-dev',
      deviceBlurb: 'a smoke test' }) })).json();
  ok(!r.error && r.claims.smokey === 'smoke-dev'
     && r.blurbs.smokey === 'a smoke test',
     'live claim registers deviceID + blurb: '
       + JSON.stringify(r.claims) + JSON.stringify(r.blurbs));
  r = await (await fetch(API, { method: 'POST',
    body: JSON.stringify({ action: 'release', aname: 'smoketest',
      uname: 'smokey', deviceID: 'not-the-holder' }) })).json();
  ok(String(r.error).includes('ERROR1306'),
     'live release by a non-holder refused: ' + JSON.stringify(r).slice(0, 80));
  r = await (await fetch(API, { method: 'POST',
    body: JSON.stringify({ action: 'release', aname: 'smoketest',
      uname: 'smokey', deviceID: 'smoke-dev' }) })).json();
  ok(!r.error && r.claims.smokey === undefined,
     'live release vacates the seat (self-cleaning: the next run\'s'
     + ' device-less smoke bid needs it open)');
  console.log('live-quals: all ' + passed
    + ' assertions passed — deployed API is current');
})().catch((e) => { console.error(e); process.exit(1); });
