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

// 1. state of a virgin auction: defaults, creates no rows
let st = call({ action: 'state', aname: 'TAU' });
ok(st.aname === 'tau' && st.mode === 'count' && st.n === 2, 'virgin defaults');
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

// 3. first bid (mixed case + padding get normalized)
st = call({ action: 'bid', aname: 'Tau', uname: 'Alice', bid: '  3 tacos ' });
ok(!st.error, 'bid accepted: ' + st.error);
ok(st.bidders.length === 1 && st.bidders[0].uname === 'alice', 'bidder recorded');
ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(st.bidders[0].updated),
   'bidder carries ISO updated stamp');
ok(st.revealed === false && st.bids === null, 'sealed at 1 of 2');
ok(ss.sheets['bids'].data[1][2] === '3 tacos', 'bid trimmed');
ok(ss.sheets['auctions'].data[1][0] === 'tau', 'default settings row created');
ok(ss.sheets['bids'].data[0][7] === "IT'S CHEATING TO LOOK HERE DURING AN AUCTION"
   && ss.sheets['auctions'].data[0][7] === "IT'S CHEATING TO LOOK HERE DURING AN AUCTION",
   'cheater banner on both tabs');
ok(ss.sheets['bids'].colors['2,3'] === '#ffffff',
   'sealed bid painted white-on-white');

// 4. re-bid overwrites, doesn't duplicate, bumps the updated stamp
const stamp1 = st.bidders[0].updated;
const t0 = Date.now(); while (Date.now() - t0 < 3);  // ensure stamps differ
st = call({ action: 'bid', aname: 'tau', uname: 'alice', bid: 'sushi' });
ok(st.bidders[0].updated !== stamp1, 're-bid bumps the updated stamp');
ok(st.bidders.length === 1, 're-bid does not duplicate');
ok(ss.sheets['bids'].data.length === 2, 'still one bid row');
ok(ss.sheets['bids'].data[1][2] === 'sushi', 're-bid overwrites');

// 5. second bidder triggers reveal (count mode, n=2)
st = call({ action: 'bid', aname: 'tau', uname: 'bob', bid: '$40' });
ok(st.revealed === true, 'revealed at n=2');
ok(st.bids.length === 2 && st.bids[0].uname === 'alice'
   && st.bids[0].bid === 'sushi' && st.bids[1].bid === '$40', 'bids exposed');
ok(ss.sheets['bids'].colors['2,3'] === null
   && ss.sheets['bids'].colors['3,3'] === null,
   'revealed bids repainted visible');

// 6. permissive after reveal: revealed is derived, never locked in
st = call({ action: 'bid', aname: 'tau', uname: 'carl', bid: 'late but legal' });
ok(!st.error && st.revealed && st.bids.length === 3,
   'late bid accepted and immediately public');
st = call({ action: 'settings', aname: 'tau', mode: 'count', n: 5 });
ok(!st.error && st.revealed === false && st.bids === null,
   'raising n un-reveals');
ok(ss.sheets['bids'].colors['2,3'] === '#ffffff',
   'un-reveal re-hides bids in the sheet');
st = call({ action: 'settings', aname: 'tau', mode: 'count', n: 2 });
ok(st.revealed === true, 'lowering n force-reveals (end-early mechanism)');

// 7. roster mode
st = call({ action: 'settings', aname: 'gluon', mode: 'roster', n: 2,
            roster: ['Dee', 'evy', 'dee'] });
ok(!st.error && st.mode === 'roster', 'roster settings saved');
ok(st.roster.join(',') === 'dee,evy', 'roster deduped + normalized');
st = call({ action: 'bid', aname: 'gluon', uname: 'dee', bid: 'I bid 2 dishes' });
ok(st.revealed === false, 'waiting on evy');
st = call({ action: 'bid', aname: 'gluon', uname: 'rando', bid: 'me too!' });
ok(st.revealed === false, 'non-roster bidder does not trigger reveal');
st = call({ action: 'bid', aname: 'gluon', uname: 'evy', bid: '1 dish + dessert' });
ok(st.revealed === true && st.bids.length === 3, 'reveals when roster complete');

// 8. settings update on existing auction (upsert, not append)
st = call({ action: 'settings', aname: 'muon', mode: 'count', n: 3 });
st = call({ action: 'settings', aname: 'muon', mode: 'count', n: 4 });
ok(st.n === 4, 'settings updated');
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
ok(call({ action: 'nonsense' }).error, 'unknown action rejected');

// 10. fresh avoids used slugs
for (let i = 0; i < 30; i++) {
  const s = call({ action: 'fresh' }).aname;
  ok(!['tau', 'gluon', 'muon', 'tau2'].includes(s), 'fresh slug unused: ' + s);
}

console.log('gas-quals: all ' + passed + ' assertions passed');
