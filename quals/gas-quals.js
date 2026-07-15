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
ok(ss.sheets['participants'].data[1][1] === 'alice', 'seat written to the sheet');
ok(st.revealed === false && st.bids === null,
   'solo roster never reveals: an auction takes two');
ok(ss.sheets['bids'].data[1][2] === '3 tacos', 'bid trimmed');
ok(ss.sheets['auctions'].data[1][0] === 'tau', 'default settings row created');
ok(ss.sheets['bids'].data[0][6] === "IT'S CHEATING TO LOOK HERE DURING AN AUCTION"
   && ss.sheets['bids'].data[0][7] === undefined
   && ss.sheets['auctions'].data[0].length === 4,
   'cheater banner right after the bids headers; none on auctions');
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
call({ action: 'add', aname: 'tau', uname: 'Alice' });
st = call({ action: 'add', aname: 'tau', uname: 'bob' });
st = call({ action: 'add', aname: 'tau', uname: 'alice' });
ok(!st.error && st.roster.join(',') === 'alice,bob',
   'adds are idempotent + normalized: one seat per person');
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
st = call({ action: 'add', aname: 'tau', uname: 'zed' });
ok(!st.error && st.revealed === true && st.bids.length === 3,
   'growing the roster cannot reseal: reveal latches');
ok(ss.sheets['bids'].colors['2,3'] === null,
   'bids stay visible in the sheet after the latch');
st = call({ action: 'remove', aname: 'tau', uname: 'zed' });
ok(st.revealed === true, 'no roster change whatsoever can reseal');
ok(!st.roster.includes('zed'), 'removed seat is gone');

// 6b. end-early = ex the straggler, THEN press reveal; roster edits
//     alone never reveal anything
call({ action: 'add', aname: 'photon', uname: 'pat' });
call({ action: 'add', aname: 'photon', uname: 'quinn' });
st = call({ action: 'add', aname: 'photon', uname: 'rey' });
call({ action: 'bid', aname: 'photon', uname: 'pat', bid: 'one photon' });
st = call({ action: 'bid', aname: 'photon', uname: 'rey', bid: 'two photons' });
ok(st.revealed === false, 'photon sealed while quinn is outstanding');
ok(call({ action: 'reveal', aname: 'photon' }).error,
   'reveal refused with a straggler on the roster');
st = call({ action: 'remove', aname: 'photon', uname: 'quinn' });
ok(st.revealed === false, 'shrinking the roster alone reveals nothing');
st = call({ action: 'reveal', aname: 'photon' });
ok(st.revealed === true, 'ex the straggler, then reveal: end-early');
call({ action: 'add', aname: 'photon', uname: 'pat' });
call({ action: 'add', aname: 'photon', uname: 'quinn' });
st = call({ action: 'add', aname: 'photon', uname: 'rey' });
ok(st.revealed === true, 'growing it back cannot reseal: latch holds');

// 6d. removal-after-bid is undone by re-bidding: a bid claims the seat back
call({ action: 'add', aname: 'boson', uname: 'ada' });
call({ action: 'add', aname: 'boson', uname: 'ben' });
call({ action: 'bid', aname: 'boson', uname: 'ada', bid: 'x' });
st = call({ action: 'remove', aname: 'boson', uname: 'ada' });
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
call({ action: 'add', aname: 'gluon', uname: 'dee' });
st = call({ action: 'add', aname: 'gluon', uname: 'evy' });
st = call({ action: 'bid', aname: 'gluon', uname: 'dee', bid: 'I bid 2 dishes' });
ok(st.revealed === false, 'waiting on evy');
st = call({ action: 'bid', aname: 'gluon', uname: 'rando', bid: 'me too!' });
ok(st.revealed === false && st.roster.includes('rando'),
   'walk-on joins the roster; reveal still waits on evy');
st = call({ action: 'bid', aname: 'gluon', uname: 'evy', bid: '1 dish + dessert' });
ok(st.revealed === false, 'complete (including the walk-on) but still sealed');
st = call({ action: 'reveal', aname: 'gluon' });
ok(st.revealed === true && st.bids.length === 3, 'reveal exposes all three');

// 8. seats are rows in the participants tab; adds upsert, removes delete
st = call({ action: 'add', aname: 'muon', uname: 'a' });
st = call({ action: 'add', aname: 'muon', uname: 'a' });
st = call({ action: 'add', aname: 'muon', uname: 'b' });
ok(st.roster.join(',') === 'a,b', 'roster grows in insertion order');
ok(ss.sheets['participants'].data.filter(r => r[0] === 'muon').length === 2,
   'duplicate add: still one seat row');
ok(ss.sheets['auctions'].data.filter(r => r[0] === 'muon').length === 1,
   'one auctions row per auction');
st = call({ action: 'remove', aname: 'muon', uname: 'a' });
ok(st.roster.join(',') === 'b'
   && ss.sheets['participants'].data.filter(r => r[0] === 'muon').length === 1,
   'remove deletes the seat row');
ok(!call({ action: 'remove', aname: 'muon', uname: 'ghost' }).error,
   'removing an absent seat is a harmless no-op');

// 8b. claims: who-is-who is server truth, so two machines can't both be
//     alice. Claiming registers your device id; one device holds at most
//     one name per auction (claiming anew releases the old, radio-style);
//     an empty device releases; bidding upserts the bidder's claim.
call({ action: 'add', aname: 'higgs', uname: 'ann' });
st = call({ action: 'add', aname: 'higgs', uname: 'ben' });
ok(st.claims && Object.keys(st.claims).length === 0,
   'no claims yet: empty map');
st = call({ action: 'claim', aname: 'higgs', uname: 'ann', device: 'dev-1' });
ok(!st.error && st.claims.ann === 'dev-1', 'claim registers the device');
st = call({ action: 'claim', aname: 'higgs', uname: 'ben', device: 'dev-1' });
ok(st.claims.ben === 'dev-1' && st.claims.ann === undefined,
   'one name per device: claiming ben releases ann');
st = call({ action: 'claim', aname: 'higgs', uname: 'ann', device: 'dev-2' });
ok(st.claims.ann === 'dev-2' && st.claims.ben === 'dev-1',
   'two devices hold two names');
st = call({ action: 'claim', aname: 'higgs', uname: 'ann', device: '' });
ok(st.claims.ann === undefined, 'an empty device releases the claim');
ok(ss.sheets['participants'].data.filter(r => r[0] === 'higgs' && r[1] === 'ann')
     .length === 1, 'claims live on the seat row: upsert, not append');
st = call({ action: 'bid', aname: 'higgs', uname: 'ann', bid: 'a boson',
            device: 'dev-3' });
ok(st.claims.ann === 'dev-3', 'bidding upserts the claim');
st = call({ action: 'bid', aname: 'higgs', uname: 'ben', bid: 'nope' });
ok(st.claims.ben === 'dev-1',
   'a device-less bid (old client) leaves claims alone');
ok(call({ action: 'claim', aname: 'higgs', uname: 'ann',
          device: 'BAD DEVICE!' }).error, 'garbage device id rejected');

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
ok(call({ action: 'add', aname: 'tau2', uname: '1bad' }).error,
   'bad roster name rejected');
ok(call({ action: 'settings', aname: 'tau2', roster: ['a'] }).error,
   'the old whole-roster settings action is gone');
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
