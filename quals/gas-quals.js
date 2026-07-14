// Quals for apps-script/Code.gs: stub the Apps Script services
// (SpreadsheetApp/LockService/ContentService) with an in-memory fake
// spreadsheet, load Code.gs, and run the API through its paces.
//
// Run: node quals/gas-quals.js
'use strict';

const ctx = require('./fake-gas')();
const ss = ctx.__ss;
const call = (req) => ctx.handle(req);

/* ------------------------------ quals --------------------------------- */

let passed = 0;
function ok(cond, label) {
  if (!cond) { console.error('FAIL: ' + label); process.exit(1); }
  passed++;
}

// 1. state of a virgin auction: empty roster, sealed, creates no rows
let st = call({ action: 'state', aname: 'TAU' });
ok(st.aname === 'tau' && st.roster.length === 0, 'virgin defaults');
ok(st.revealed === false && st.bids === null && st.bidders.length === 0,
   'virgin unrevealed');
ok(ss.sheets['auctions'].data.length === 1, 'state read creates no rows');

// 2. doGet / doPost plumbing
let viaGet = JSON.parse(ctx.doGet({ parameter: { action: 'state', aname: 'tau' } }).body);
ok(viaGet.aname === 'tau', 'doGet plumbing');
let viaPost = JSON.parse(ctx.doPost({ postData: { contents:
  JSON.stringify({ action: 'state', aname: 'tau' }) } }).body);
ok(viaPost.aname === 'tau', 'doPost plumbing');
ok(JSON.parse(ctx.doPost({ postData: { contents: '{oops' } }).body).error,
   'doPost bad JSON -> error');
ok(JSON.parse(ctx.doGet({}).body).ok, 'bare GET -> friendly liveness JSON');

// 3. first bid (mixed case + padding get normalized); an empty roster can
//    never reveal, so rosterless bids stay sealed
st = call({ action: 'bid', aname: 'Tau', uname: 'Alice', bid: '  3 tacos ' });
ok(!st.error, 'bid accepted: ' + st.error);
ok(st.bidders.length === 1 && st.bidders[0].uname === 'alice', 'bidder recorded');
ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(st.bidders[0].updated),
   'bidder carries ISO updated stamp');
ok(st.bidders[0].subs === 1, 'first submission counts 1');
ok(st.roster.join(',') === 'alice', 'bidding claims a roster seat');
ok(ss.sheets['auctions'].data[1][1] === 'alice', 'seat written to the sheet');
ok(st.revealed === false && st.bids === null,
   'solo roster never reveals: an auction takes two');
ok(ss.sheets['bids'].data[1][2] === '3 tacos', 'bid trimmed');
ok(ss.sheets['auctions'].data[1][0] === 'tau', 'default settings row created');
ok(ss.sheets['bids'].data[0][7] === "IT'S CHEATING TO LOOK HERE DURING AN AUCTION"
   && ss.sheets['auctions'].data[0][7] === "IT'S CHEATING TO LOOK HERE DURING AN AUCTION",
   'cheater banner on both tabs');
ok(ss.sheets['bids'].colors['2,3'] === '#ffffff',
   'sealed bid painted white-on-white');

// 4. re-bid overwrites, doesn't duplicate, bumps the updated stamp + subs
const stamp1 = st.bidders[0].updated;
const t0 = Date.now(); while (Date.now() - t0 < 3);  // ensure stamps differ
st = call({ action: 'bid', aname: 'tau', uname: 'alice', bid: 'sushi' });
ok(st.bidders[0].updated !== stamp1, 're-bid bumps the updated stamp');
ok(st.bidders[0].subs === 2, 're-submission counts 2');
ok(st.bidders.length === 1, 're-bid does not duplicate');
ok(ss.sheets['bids'].data.length === 2, 'still one bid row');
ok(ss.sheets['bids'].data[1][2] === 'sushi', 're-bid overwrites');

// 5. reveal is a human act: a complete roster only UNLOCKS it.
//    (The motivating bug: two drive-by bidders who never stated a roster
//    must not see each other's bids just because they're "all in".)
st = call({ action: 'settings', aname: 'tau', roster: ['Alice', 'bob', 'alice'] });
ok(!st.error && st.roster.join(',') === 'alice,bob',
   'roster deduped + normalized');
ok(call({ action: 'reveal', aname: 'tau' }).error,
   'reveal refused while bob is outstanding');
st = call({ action: 'bid', aname: 'tau', uname: 'bob', bid: '$40' });
ok(st.revealed === false && st.bids === null,
   'roster complete: still sealed until someone reveals');
st = call({ action: 'reveal', aname: 'tau' });
ok(st.revealed === true, 'pressing reveal reveals');
ok(st.bids.length === 2 && st.bids[0].uname === 'alice'
   && st.bids[0].bid === 'sushi' && st.bids[1].bid === '$40', 'bids exposed');
ok(ss.sheets['bids'].colors['2,3'] === null
   && ss.sheets['bids'].colors['3,3'] === null,
   'revealed bids repainted visible');
ok(!call({ action: 'reveal', aname: 'tau' }).error,
   'racing reveal presses: idempotent, no error');

// 6. permissive after reveal, but reveal is a one-way latch
st = call({ action: 'bid', aname: 'tau', uname: 'carl', bid: 'late but legal' });
ok(!st.error && st.revealed && st.bids.length === 3,
   'late bid accepted and immediately public');
ok(st.bidders.find((b) => b.uname === 'carl').subs === 1,
   'counters are per-bidder');
ok(st.roster.includes('carl'), 'late bidder joins the roster');
st = call({ action: 'settings', aname: 'tau', roster: ['alice', 'bob', 'zed'] });
ok(!st.error && st.revealed === true && st.bids.length === 3,
   'growing the roster cannot reseal: reveal latches');
ok(ss.sheets['bids'].colors['2,3'] === null,
   'bids stay visible in the sheet after the latch');
st = call({ action: 'settings', aname: 'tau', roster: [] });
ok(st.revealed === true, 'no settings change whatsoever can reseal');
st = call({ action: 'settings', aname: 'tau', roster: ['alice', 'bob'] });
ok(st.revealed === true, 'restore tau roster; still revealed');

// 6b. end-early = ex the straggler, THEN press reveal; roster edits
//     alone never reveal anything
st = call({ action: 'settings', aname: 'photon', roster: ['pat', 'quinn', 'rey'] });
call({ action: 'bid', aname: 'photon', uname: 'pat', bid: 'one photon' });
st = call({ action: 'bid', aname: 'photon', uname: 'rey', bid: 'two photons' });
ok(st.revealed === false, 'photon sealed while quinn is outstanding');
ok(call({ action: 'reveal', aname: 'photon' }).error,
   'reveal refused with a straggler on the roster');
st = call({ action: 'settings', aname: 'photon', roster: ['pat', 'rey'] });
ok(st.revealed === false, 'shrinking the roster alone reveals nothing');
st = call({ action: 'reveal', aname: 'photon' });
ok(st.revealed === true, 'ex the straggler, then reveal: end-early');
st = call({ action: 'settings', aname: 'photon', roster: ['pat', 'quinn', 'rey'] });
ok(st.revealed === true, 'growing it back cannot reseal: latch holds');

// 6d. removal-after-bid is undone by re-bidding: a bid claims the seat back
st = call({ action: 'settings', aname: 'boson', roster: ['ada', 'ben'] });
call({ action: 'bid', aname: 'boson', uname: 'ada', bid: 'x' });
st = call({ action: 'settings', aname: 'boson', roster: ['ben'] });
ok(st.roster.join(',') === 'ben' && st.bidders.length === 1,
   'ada cut from the roster, bid retained');
st = call({ action: 'bid', aname: 'boson', uname: 'ada', bid: 'x again' });
ok(st.roster.join(',') === 'ben,ada', 're-bidding rejoins the roster');
ok(st.revealed === false, 'still sealed: ben is outstanding');

// 6c. rows predating the subs column: an existing bid row implies at
//     least one submission — never 0 (green row + 0 is a contradiction)
ss.sheets['bids'].appendRow(['relic', 'oldtimer', 'ancient bid',
  '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
st = call({ action: 'state', aname: 'relic' });
ok(st.bidders[0].subs === 1, 'legacy bid row counts as 1, never 0');
const t1 = Date.now(); while (Date.now() - t1 < 3);
st = call({ action: 'bid', aname: 'relic', uname: 'oldtimer', bid: 'newer' });
ok(st.bidders[0].subs === 2, 'legacy re-bid counts as 2');

// 7. walk-on bidders don't gate the reveal
st = call({ action: 'settings', aname: 'gluon', roster: ['dee', 'evy'] });
st = call({ action: 'bid', aname: 'gluon', uname: 'dee', bid: 'I bid 2 dishes' });
ok(st.revealed === false, 'waiting on evy');
st = call({ action: 'bid', aname: 'gluon', uname: 'rando', bid: 'me too!' });
ok(st.revealed === false && st.roster.includes('rando'),
   'walk-on joins the roster; reveal still waits on evy');
st = call({ action: 'bid', aname: 'gluon', uname: 'evy', bid: '1 dish + dessert' });
ok(st.revealed === false, 'complete (including the walk-on) but still sealed');
st = call({ action: 'reveal', aname: 'gluon' });
ok(st.revealed === true && st.bids.length === 3, 'reveal exposes all three');

// 8. settings update on existing auction (upsert, not append)
st = call({ action: 'settings', aname: 'muon', roster: ['a'] });
st = call({ action: 'settings', aname: 'muon', roster: ['a', 'b'] });
ok(st.roster.join(',') === 'a,b', 'settings updated');
ok(ss.sheets['auctions'].data.filter(r => r[0] === 'muon').length === 1,
   'settings upsert, not append');

// 9. validation
ok(call({ action: 'bid', aname: 'ta_u', uname: 'a', bid: 'x' }).error,
   'bad slug rejected');
ok(call({ action: 'bid', aname: 'tau2', uname: '1abc', bid: 'x' }).error,
   'name starting with digit rejected');
ok(call({ action: 'bid', aname: 'tau2', uname: 'a b', bid: 'x' }).error,
   'name with space rejected');
ok(call({ action: 'bid', aname: 'tau2', uname: 'abc', bid: '' }).error,
   'empty bid rejected');
ok(call({ action: 'bid', aname: 'tau2', uname: 'abc', bid: 'y'.repeat(81) })
   .error, '81-char bid rejected');
ok(!call({ action: 'bid', aname: 'tau2', uname: 'abc', bid: 'y'.repeat(80) })
   .error, '80-char bid accepted');
ok(call({ action: 'settings', aname: 'tau2', roster: ['1bad'] }).error,
   'bad roster name rejected');
ok(call({ action: 'reveal', aname: 'tau2' }).error,
   'reveal refused for a solo bidder (an auction takes two)');
ok(call({ action: 'nonsense' }).error, 'unknown action rejected');

// 10. fresh avoids used slugs
for (let i = 0; i < 30; i++) {
  const s = call({ action: 'fresh' }).aname;
  ok(!['tau', 'gluon', 'muon', 'tau2', 'photon', 'relic', 'boson'].includes(s),
     'fresh slug unused: ' + s);
}

console.log('gas-quals: all ' + passed + ' assertions passed');
