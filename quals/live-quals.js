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
  r = await (await fetch(API + '?action=state&slug=tau')).json();
  // A schema-changing deploy makes the API refuse the old tabs by
  // name; surface that as marching orders, not a shape-assert failure
  if (String(r.error).includes('schema drift')) {
    console.error('DEPLOYED CODE REFUSES THE OLD TABS:\n  ' + r.error
      + '\n  -> open the sheet, rename (or delete) the named tab and'
      + ' any other outdated ones, then rerun: node quals/live-quals.js');
    process.exit(1);
  }
  ok(r.slug === 'tau' && Array.isArray(r.seats)
     && r.seats.every((se) => typeof se.usid === 'string'
                           && typeof se.snym === 'string')
     && Array.isArray(r.bidders)
     && r.bidders.every((b) => typeof b.usid === 'string'
                            && typeof b.tini === 'string'
                            && typeof b.tmod === 'string')
     && r.claims !== null && typeof r.claims === 'object'
     && r.anyms !== null && typeof r.anyms === 'object'
     && typeof r.tfin === 'string',
     'live state shape matches what app.js expects: ' + JSON.stringify(r).slice(0, 120));
  // Self-HEALING preamble: a previous run that died between its
  // claim and its release strands smokey's seat, and every later
  // run's deviceless bid then bounces off the bidSeatHeld refusal
  // (it happened; dreev had to clean the sheet by hand). Releasing an
  // unheld seat is a documented no-op, so this is safe in every state.
  await fetch(API, { method: 'POST',
    body: JSON.stringify({ action: 'release', slug: 'smoketest',
      usid: 'usid-smoketest-smokey', dvid: 'smoke-dev' }) });
  // end-to-end write+read: place a smoke bid, read it back from the
  // returned post-write state (self-seeding: no fixture data needed)
  r = await (await fetch(API, { method: 'POST',
    body: JSON.stringify({ action: 'bid', slug: 'smoketest',
      snym: 'smokey', usid: 'usid-smoketest-smokey',
      xbid: 'smoke ' + Date.now() }) })).json();
  ok(!r.error, 'live bid accepted: ' + JSON.stringify(r).slice(0, 120));
  const smokey = (r.bidders || []).find(
    (b) => b.usid === 'usid-smoketest-smokey');
  ok(smokey !== undefined && smokey.bcount >= 1,
     'live bid readable with bcount >= 1: '
       + JSON.stringify(r.bidders).slice(0, 120));
  // the full claim lifecycle against the DEPLOYED script — this is
  // what catches an old deployment missing an action ("unknown
  // action: release", the hard way)
  r = await (await fetch(API, { method: 'POST',
    body: JSON.stringify({ action: 'claim', slug: 'smoketest',
      usid: 'usid-smoketest-smokey', dvid: 'smoke-dev',
      anym: 'a smoke test' }) })).json();
  ok(!r.error && r.claims['usid-smoketest-smokey'] === 'smoke-dev'
     && r.anyms['usid-smoketest-smokey'] === 'a smoke test',
     'live claim registers dvid + blub: '
       + JSON.stringify(r.claims) + JSON.stringify(r.anyms));
  r = await (await fetch(API, { method: 'POST',
    body: JSON.stringify({ action: 'release', slug: 'smoketest',
      usid: 'usid-smoketest-smokey',
      dvid: 'not-the-holder' }) })).json();
  ok(r.error && r.error.code === 'notYourSeat',
     'live release by a non-holder refused: ' + JSON.stringify(r).slice(0, 80));
  r = await (await fetch(API, { method: 'POST',
    body: JSON.stringify({ action: 'release', slug: 'smoketest',
      usid: 'usid-smoketest-smokey', dvid: 'smoke-dev' }) })).json();
  ok(!r.error && r.claims['usid-smoketest-smokey'] === undefined,
     'live release vacates the seat (self-cleaning: the next run\'s'
     + ' device-less smoke bid needs it open)');
  // the deployed script must KNOW the archive action (the missing-
  // action failure mode above, the hard way) — proven by its
  // refusal on the never-revealed smoketest auction: a refusal
  // mutates nothing, so no live data is ever renamed by a deploy
  r = await (await fetch(API, { method: 'POST',
    body: JSON.stringify({ action: 'archive',
      slug: 'smoketest' }) })).json();
  ok(r.error && r.error.code === 'archiveUnclosed',
     'live archive action exists and refuses the open smoketest: '
     + JSON.stringify(r).slice(0, 80));
  console.log('live-quals: all ' + passed
    + ' assertions passed — deployed API is current');
})().catch((e) => { console.error(e); process.exit(1); });
