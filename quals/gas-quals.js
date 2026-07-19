// Quals for apps-script/Code.gs: stub the Apps Script services
// (SpreadsheetApp/LockService/ContentService) with an in-memory fake
// spreadsheet, load Code.gs, and run the API through its paces.
//
// Run: node quals/gas-quals.js
'use strict';

const ctx = require('./fake-gas')();
const ss = ctx.__ss;
// Every action's result is checked against THE CLOSED-STATE COVENANT
// (dreev found live auction test0916 revealed with a solo, bidless
// roster — fabricated by pre-freeze code plus tab recreations): once
// revealed, at least two roster members, every one of them with a
// bid, forever (the freezes make it eternal).
const call = (req) => {
  const st = ctx.handle(req);
  if (st && !st.error && st.revealed) {
    ok(st.roster.length >= 2
       && st.roster.every((u) => st.bidders.some((b) => b.uname === u)),
       'closed-state covenant after "' + req.action + '" on '
         + st.aname + ': roster=' + JSON.stringify(st.roster)
         + ' bidders=' + JSON.stringify(st.bidders.map((b) => b.uname)));
  }
  return st;
};

// Server microcopy DERIVED from Code.gs's block (read back out of the
// vm context hosting it), so copy edits there never break these quals
// — they pin the right words in the right place, not the wording
const COPY = require('vm').runInContext('({ gavelFellCopy,'
  + ' simulEditsCopy, seatHeldCopy, bidSeatHeldCopy, unknownActionCopy,'
  + ' mysteryDeviceCopy, schemaDriftCopy, auctionClosedCopy,'
  + ' rosterClosedCopy, badDevBlurbCopy })', ctx);
// Real Apps Script resets globals every execution; one shared vm
// context hosts the whole qual run, so drift quals empty the
// header-check memo by hand to simulate a fresh execution
const resetTabMemo = () => require('vm').runInContext(
  'ssMemo = null;'
  + ' Object.keys(sheetMemo).forEach((k) => delete sheetMemo[k]);'
  + ' Object.keys(rowsMemo).forEach((k) => delete rowsMemo[k]);', ctx);

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
ok(st.exists === false,
   'virgin state reports that no auction record exists');

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
ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(st.bidders[0].tmod),
   'bidder carries ISO tmod stamp');
ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(st.bidders[0].tini),
   'bidder carries ISO tini stamp (the bid-cell tooltip needs it)');
ok(st.bidders[0].bcount === 1, 'first submission counts 1');
ok(st.roster.join(',') === 'alice', 'bidding claims a roster seat');
ok(ss.sheets['users'].data[1][1] === 'alice', 'seat written to the sheet');
ok(st.revealed === false && st.bids === null,
   'solo roster never reveals: an auction takes two');
ok(ss.sheets['bids'].data[1][2] === '3 tacos', 'bid trimmed');
ok(ss.sheets['auctions'].data[1][0] === 'tau', 'default settings row created');
ok(ss.sheets['bids'].data[0][4] === "IT'S CHEATING TO LOOK HERE DURING AN AUCTION"
   && ss.sheets['bids'].data[0][5] === undefined
   && ss.sheets['auctions'].data[0].length === 6,
   'cheater banner right after the bids headers; none on auctions');
ok(ss.sheets['bids'].colors['2,3'] === '#ffffff',
   'sealed bid painted white-on-white');
ok(ss.sheets['bids'].fonts['1,1'] === 'Roboto Mono'
   && ss.sheets['bids'].backgrounds['1,1'] !== undefined,
   'headers dressed up: monospace labels on a tinted band');

// 4. the bids tab is an append-only LOG (dreev's 2026-07-17
//    rearchitecture, replacing upsert): every submission is its own
//    row with one stamp, tbid; a person's standing bid is their
//    LATEST row, and tini/tmod/bcount arrive in the payload DERIVED
const stamp1 = st.bidders[0].tmod;
const t0 = Date.now(); while (Date.now() - t0 < 3);  // ensure stamps differ
st = call({ action: 'bid', aname: 'tau', uname: 'alice', bid: 'sushi' });
ok(ss.sheets['bids'].data.length === 3
   && ss.sheets['bids'].data[1][2] === '3 tacos'
   && ss.sheets['bids'].data[2][2] === 'sushi'
   && ss.sheets['bids'].data[2][3] > ss.sheets['bids'].data[1][3],
   're-bid APPENDS: both submissions on the sheet, later tbid below');
ok(st.bidders[0].tmod !== stamp1, 'derived tmod = the latest tbid');
ok(st.bidders[0].tini === stamp1,
   'derived tini = the first tbid (first submission time survives)');
ok(st.bidders[0].bcount === 2, 'derived bcount = the row count');
ok(st.bidders.length === 1
   && call({ action: 'state', aname: 'tau' }).bidders[0].uname === 'alice',
   'one BIDDER in the payload however many rows: latest-row-wins');

// 4b. Replicata: use the valid uname "constructor" and submit a bid.
//     Expectata: its bid is aggregated exactly like any other uname.
//     Resultata pre-fix: Object.prototype.constructor impersonated an
//     aggregate entry, so the sheet row existed but the bidder vanished.
call({ action: 'add', aname: 'reserved', uname: 'constructor' });
call({ action: 'add', aname: 'reserved', uname: 'alice' });
st = call({ action: 'bid', aname: 'reserved', uname: 'constructor',
            bid: 'reserved words are people too' });
ok(st.bidders.some((b) => b.uname === 'constructor'),
   'valid reserved-key uname is aggregated: its logged bid cannot vanish');
call({ action: 'bid', aname: 'reserved', uname: 'alice', bid: 'ordinary' });
ok(!call({ action: 'reveal', aname: 'reserved' }).error,
   'reserved-key bidder counts toward reveal readiness');
const reservedState = call({ action: 'state', aname: 'reserved' });
ok(reservedState.claims.constructor === undefined
   && reservedState.blurbs.constructor === undefined,
   'uname-keyed payload maps have no inherited reserved-key entries');

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
ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(st.tfin),
   'the reveal stamps its moment (the Closed line needs it)');
ok(st.bids.length === 2 && st.bids[0].uname === 'alice'
   && st.bids[0].bid === 'sushi' && st.bids[1].bid === '$40', 'bids exposed');
ok(ss.sheets['bids'].colors['2,3'] === null
   && ss.sheets['bids'].colors['3,3'] === null,
   'revealed bids repainted visible');
ok(!call({ action: 'reveal', aname: 'tau' }).error,
   'racing reveal presses: idempotent, no error');

// 6. the gavel drop is a BRIGHT LINE (2026-07-16, dreev — reversing
//    the old permissive-after-reveal pin): no bid lands after tfin,
//    and the loser of an under-the-wire race hears it explicitly
st = call({ action: 'bid', aname: 'tau', uname: 'carl', bid: 'too late' });
ok(String(st.error) === COPY.gavelFellCopy
   && call({ action: 'state', aname: 'tau' }).bids.length === 2
   && !call({ action: 'state', aname: 'tau' }).roster.includes('carl'),
   'a bid after the gavel falls is refused outright: nothing written');
st = call({ action: 'bid', aname: 'tau', uname: 'alice', bid: 'revised!' });
ok(String(st.error) === COPY.gavelFellCopy
   && call({ action: 'state', aname: 'tau' }).bids[0].bid === 'sushi',
   "even the bidder's own revision bounces: the record is the record");
st = call({ action: 'rename', aname: 'tau', from: 'alice', to: 'mallory' });
ok(String(st.error) === COPY.auctionClosedCopy
   && call({ action: 'state', aname: 'tau' }).roster.includes('alice')
   && call({ action: 'state', aname: 'tau' }).bids
        .some((b) => b.uname === 'alice'),
   'names freeze at the gavel too (dreev 2026-07-17, reversing'
   + ' always-editable: a post-close rename could swap around who bid'
   + " what): refused, and alice's bid stays alice's");
// ...and so do SEATS: found hunting dreev's one-more-bug 2026-07-17 —
// post-reveal claims re-attributed a revealed bid to a stranger's rig,
// and releases reopened seats for the taking. The whole record
// freezes at the gavel.
st = call({ action: 'claim', aname: 'tau', uname: 'alice',
            deviceID: 'd-x', deviceBlurb: 'mallory rig' });
ok(String(st.error) === COPY.auctionClosedCopy
   && call({ action: 'state', aname: 'tau' }).claims.alice === undefined,
   "identities freeze at the gavel: a post-close claim can't dress a"
   + " revealed bid in a stranger's rig");
st = call({ action: 'release', aname: 'tau', uname: 'alice',
            deviceID: 'd-x' });
ok(String(st.error) === COPY.auctionClosedCopy,
   'releases freeze too: no reopening seats after the game');
// (2026-07-16, per dreev: the roster is CLOSED once revealed — adds
// refuse rather than merely not-resealing)
st = call({ action: 'add', aname: 'tau', uname: 'zed' });
ok(st.error && !call({ action: 'state', aname: 'tau' })
     .roster.includes('zed'),
   'adding a participant after the reveal is refused: game over');
ok(ss.sheets['bids'].colors['2,3'] === null,
   'bids stay visible in the sheet after the latch');
// [FLIPPED 2026-07-18, dreev's report "it just let me remove someone
// from a closed auction": the freeze doctrine never reached remove.
// The old pins blessed permissive removal; now the whole record —
// seats, bids, cut-row zombie purges — freezes at the gavel.]
st = call({ action: 'remove', aname: 'tau', uname: 'bob' });
ok(String(st.error) === COPY.auctionClosedCopy
   && call({ action: 'state', aname: 'tau' }).roster.includes('bob'),
   'removing a seat from a CLOSED auction is refused: the roster is'
   + ' part of the frozen record');
ok(call({ action: 'state', aname: 'tau' }).revealed === true,
   'and still revealed, of course');

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
st = call({ action: 'add', aname: 'photon', uname: 'quinn' });
ok(st.error && call({ action: 'state', aname: 'photon' }).revealed === true,
   'the ended auction refuses new participants; the latch holds');

// 6e. removing an already-cut row (seat gone, zombie bid remains —
//     reachable via races or sheet tampering) purges the bid: the
//     recovery path dreev asked for. The FIRST remove never touches
//     the bid (6d pins that re-bidding rejoins); only removing a row
//     that is ALREADY cut deletes it.
call({ action: 'add', aname: 'zombie', uname: 'zomb' });
call({ action: 'add', aname: 'zombie', uname: 'keep' });
call({ action: 'bid', aname: 'zombie', uname: 'zomb', bid: 'undead' });
st = call({ action: 'remove', aname: 'zombie', uname: 'zomb' });
ok(st.bidders.length === 1 && !st.roster.includes('zomb'),
   'first remove: seat gone, bid retained (the cut state)');
st = call({ action: 'remove', aname: 'zombie', uname: 'zomb' });
ok(!st.error && st.bidders.length === 0,
   'second remove, on the cut row: the zombie bid is purged');
ok(ss.sheets['bids'].data.filter(r => r[0] === 'zombie').length === 0,
   'purged from the sheet too, not just the payload');

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

// 6c. rows with a blank bcount: an existing bid row implies at
//     least one submission — never 0 (green row + 0 is a contradiction)
ss.sheets['bids'].appendRow(['relic', 'oldtimer', 'ancient bid', '',
  '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
st = call({ action: 'state', aname: 'relic' });
ok(st.bidders[0].bcount === 1, 'legacy bid row counts as 1, never 0');
const t1 = Date.now(); while (Date.now() - t1 < 3);
st = call({ action: 'bid', aname: 'relic', uname: 'oldtimer', bid: 'newer' });
ok(st.bidders[0].bcount === 2, 'legacy re-bid counts as 2');

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

// 7b. the auction description: arbitrary markdown, editable by anyone
//     before OR after the close, guarded against silent clobbers by
//     compare-and-swap on dtmod (send the stamp your edit was based
//     on; a stale base is refused loudly)
st = call({ action: 'state', aname: 'tau' });
ok(st.blurb === '' && st.tblurb === '', 'no blurb to start');
st = call({ action: 'describe', aname: 'tau',
            blurb: '# Brunch\n\nBring **cash**.', base: '' });
ok(!st.error && st.blurb === '# Brunch\n\nBring **cash**.'
   && /^\d{4}-/.test(st.tblurb),
   'a blurb lands, newlines and all, and stamps tblurb');
const dt1 = st.tblurb;
{ const t = Date.now(); while (Date.now() - t < 3); }  // stamps differ
st = call({ action: 'describe', aname: 'tau',
            blurb: 'second thoughts', base: dt1 });
ok(!st.error && st.blurb === 'second thoughts' && st.tblurb !== dt1,
   'an edit based on the current stamp goes through');
st = call({ action: 'describe', aname: 'tau',
            blurb: 'clobber attempt', base: dt1 });
ok(String(st.error) === COPY.simulEditsCopy
   && call({ action: 'state', aname: 'tau' }).blurb === 'second thoughts',
   'an edit based on a STALE stamp is refused: no silent clobbering');
st = call({ action: 'describe', aname: 'tau', blurb: 'x'.repeat(2001),
            base: call({ action: 'state', aname: 'tau' }).tblurb });
ok(st.error, 'a novel is refused (2000 chars is plenty)');
ok(!call({ action: 'describe', aname: 'tau', blurb: 'post-close note',
           base: call({ action: 'state', aname: 'tau' }).tblurb }).error,
   'the blurb stays editable after the gavel: tau is revealed');

// 7c. Replicata: save only a description, with no roster or bids.
//     Expectata: the state says the auction exists, so typed-name
//     occupancy does not confuse it with a virgin name. Resultata
//     pre-fix: those two states had no explicit distinguishing field.
st = call({ action: 'describe', aname: 'desconly',
            blurb: 'description without participants', base: '' });
ok(st.exists === true && st.roster.length === 0 && st.bidders.length === 0,
   'description-only auction reports existing despite an empty ledger');

// 8. seats are rows in the users tab; adds upsert, removes delete
st = call({ action: 'add', aname: 'muon', uname: 'a' });
st = call({ action: 'add', aname: 'muon', uname: 'a' });
st = call({ action: 'add', aname: 'muon', uname: 'b' });
ok(st.roster.join(',') === 'a,b', 'roster grows in insertion order');
ok(ss.sheets['users'].data.filter(r => r[0] === 'muon').length === 2,
   'duplicate add: still one seat row');
ok(ss.sheets['auctions'].data.filter(r => r[0] === 'muon').length === 1,
   'one auctions row per auction');
st = call({ action: 'remove', aname: 'muon', uname: 'a' });
ok(st.roster.join(',') === 'b'
   && ss.sheets['users'].data.filter(r => r[0] === 'muon').length === 1,
   'remove deletes the seat row');
ok(!call({ action: 'remove', aname: 'muon', uname: 'ghost' }).error,
   'removing an absent seat is a harmless no-op');

// 8b. claims: who-is-who is server truth, so two machines can't both
//     be alice. FIRST COME, FIRST SERVED (2026-07-16; the old
//     last-write-wins let a stale click silently steal a seat, anyone
//     release anyone, and a bid hijack a held seat — the two pinned
//     behaviors changed here were flagged to dreev): claiming
//     registers your device id; a held seat refuses rivals loudly;
//     only the holder may release; one device holds at most one name
//     per auction (claiming anew releases your old one, radio-style);
//     bidding registers the claim iff the seat is yours or open.
call({ action: 'add', aname: 'higgs', uname: 'ann' });
st = call({ action: 'add', aname: 'higgs', uname: 'ben' });
ok(st.claims && Object.keys(st.claims).length === 0,
   'no claims yet: empty map');
st = call({ action: 'claim', aname: 'higgs', uname: 'ann', deviceID: 'dev-1',
            deviceBlurb: 'a Mac (Chrome)' });
ok(!st.error && st.claims.ann === 'dev-1', 'claim registers the device');
ok(st.blurbs.ann === 'a Mac (Chrome)',
   "the claimant's self-reported deviceBlurb rides along");
st = call({ action: 'claim', aname: 'higgs', uname: 'ann', deviceID: 'dev-1',
            deviceBlurb: 'a Mac (Chrome)' });
ok(!st.error && st.claims.ann === 'dev-1', 're-claiming your own seat is'
   + ' idempotent (a device that lost localStorage re-latches)');
st = call({ action: 'claim', aname: 'higgs', uname: 'ann', deviceID: 'dev-2' });
ok(String(st.error) === COPY.seatHeldCopy('a Mac (Chrome)')
   && call({ action: 'state', aname: 'higgs' }).claims.ann === 'dev-1',
   "a held seat refuses a rival's claim, loudly, naming the holder's"
   + ' rig: no silent stealing');
st = call({ action: 'release', aname: 'higgs', uname: 'ann',
            deviceID: 'dev-2' });
ok(String(st.error).includes('ERROR1306')
   && call({ action: 'state', aname: 'higgs' }).claims.ann === 'dev-1',
   'only the holder may release a seat');
st = call({ action: 'release', aname: 'higgs', uname: 'ben',
            deviceID: 'dev-9' });
ok(!st.error, 'releasing an unheld seat is a no-op (a merely-local'
   + ' soft claim must release without drama)');
st = call({ action: 'release', aname: 'higgs', uname: 'ann',
            deviceID: 'dev-1' });
ok(!st.error && st.claims.ann === undefined,
   'the holder releases: seat open again');
st = call({ action: 'claim', aname: 'higgs', uname: 'ben', deviceID: 'dev-1' });
st = call({ action: 'claim', aname: 'higgs', uname: 'ann', deviceID: 'dev-1' });
ok(st.claims.ann === 'dev-1' && st.claims.ben === undefined,
   'one name per deviceID: claiming ann releases your ben, radio-style');
ok(ss.sheets['users'].data.filter(r => r[0] === 'higgs' && r[1] === 'ann')
     .length === 1, 'claims live on the seat row: upsert, not append');
st = call({ action: 'bid', aname: 'higgs', uname: 'ann', bid: 'a boson',
            deviceID: 'dev-3' });
ok(String(st.error) === COPY.bidSeatHeldCopy(COPY.mysteryDeviceCopy)
   && call({ action: 'state', aname: 'higgs' }).bidders.length === 0,
   "a bid can't hijack a held seat: refused, naming the holder's rig,"
   + ' and no bid row written');
st = call({ action: 'bid', aname: 'higgs', uname: 'ben', bid: 'legal',
            deviceID: 'dev-3' });
ok(!st.error && st.claims.ben === 'dev-3',
   'bidding an OPEN seat registers your claim on it');
st = call({ action: 'bid', aname: 'higgs', uname: 'ben', bid: 'nope' });
ok(String(st.error).includes('ERROR1312'),
   'a device-less bid (old client) counts as nobody: refused on a'
   + ' held seat too');
call({ action: 'add', aname: 'higgs', uname: 'cee' });
st = call({ action: 'bid', aname: 'higgs', uname: 'cee', bid: 'old' });
ok(!st.error && st.claims.cee === undefined,
   'a device-less bid on an open seat still works, claiming nothing');
ok(call({ action: 'claim', aname: 'higgs', uname: 'ann',
          deviceID: 'BAD DEVICE!' }).error, 'garbage device id rejected');
ok(call({ action: 'claim', aname: 'higgs', uname: 'cee',
          deviceID: '' }).error,
   'a claim with no device is a client bug: refused');
// the deviceBlurb contract the client must meet: printable ASCII,
// max 64 chars — the frontend ASCII-fies and clamps its decoration
// to fit (a São Paulo bidder must never lose a bid to an accent)
st = call({ action: 'claim', aname: 'higgs', uname: 'ann',
            deviceID: 'dev-1', deviceBlurb: 'Mac in São Paulo' });
ok(String(st.error) === COPY.badDevBlurbCopy,
   'a non-ASCII deviceBlurb is refused: the contract is printable'
   + ' ASCII, and the server never silently fixes inputs');
ok(call({ action: 'claim', aname: 'higgs', uname: 'ann',
          deviceID: 'dev-1', deviceBlurb: 'y'.repeat(65) }).error,
   'a 65-char deviceBlurb is refused');
ok(!call({ action: 'claim', aname: 'higgs', uname: 'ann',
           deviceID: 'dev-1', deviceBlurb: 'y'.repeat(64) }).error,
   'a 64-char deviceBlurb is accepted: the fence sits at exactly 64');

// 8c. renames fix typos, in place: the seat row and any bid row re-key
//     together; claims (the device column) ride the seat row
call({ action: 'add', aname: 'strange', uname: 'alicw' });
call({ action: 'add', aname: 'strange', uname: 'bob' });
call({ action: 'claim', aname: 'strange', uname: 'alicw', deviceID: 'dev-9' });
st = call({ action: 'bid', aname: 'strange', uname: 'alicw', bid: 'six',
            deviceID: 'dev-9' });  // the holder's own bid
const stampB4 = st.bidders[0].tmod;
st = call({ action: 'rename', aname: 'strange', from: 'alicw', to: 'Alice' });
ok(!st.error && st.roster.join(',') === 'alice,bob',
   'typo fixed in place, normalized, order kept');
ok(st.claims.alice === 'dev-9' && st.claims.alicw === undefined,
   'the claim rides the renamed seat');
ok(st.bidders.length === 1 && st.bidders[0].uname === 'alice'
   && st.bidders[0].tmod === stampB4 && st.bidders[0].bcount === 1,
   'the bid follows the rename: stamps and count intact');
ok(call({ action: 'rename', aname: 'strange', from: 'alice', to: 'bob' })
   .error, 'renaming onto an existing name is refused');
ok(call({ action: 'rename', aname: 'strange', from: 'ghost', to: 'gus' })
   .error, 'renaming a nonexistent participant is refused');
ok(call({ action: 'rename', aname: 'strange', from: 'bob', to: '1bad' })
   .error, 'renaming to an invalid name is refused');
ok(!call({ action: 'rename', aname: 'strange', from: 'bob', to: 'bob' })
   .error, 'renaming to the same name is a no-op');

// 8d. Replicata: bob bids, is cut from the roster, then alice is
//     renamed to bob. Expectata: bob's immortal bid history reserves
//     that identity, so the rename is refused. Resultata pre-fix: only
//     live seats were checked, so alice inherited bob's standing bid.
call({ action: 'add', aname: 'cutrename', uname: 'alice' });
call({ action: 'add', aname: 'cutrename', uname: 'bob' });
call({ action: 'bid', aname: 'cutrename', uname: 'bob', bid: 'bobs bid' });
call({ action: 'remove', aname: 'cutrename', uname: 'bob' });
st = call({ action: 'rename', aname: 'cutrename',
            from: 'alice', to: 'bob' });
const cutRenameState = call({ action: 'state', aname: 'cutrename' });
ok(st.error && cutRenameState.roster.join(',') === 'alice'
   && cutRenameState.bidders.length === 1
   && cutRenameState.bidders[0].uname === 'bob',
   'a cut bidder keeps their uname: rename cannot merge bid histories');

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

// 9b. Replicata: send a virgin claim/bid whose device decoration or id
//     is invalid. Expectata: validation refuses before any write.
//     Resultata pre-fix: touchAuction + ensureSeat ran first, so an error
//     response left a phantom roster seat with no claim and no bid.
const atomicValidationCases = [
  { action: 'claim', aname: 'badclaim', uname: 'alice',
    deviceID: 'dev-1', deviceBlurb: 'São Paulo' },
  { action: 'bid', aname: 'badbidblurb', uname: 'alice', bid: 'ten',
    deviceID: 'dev-1', deviceBlurb: 'São Paulo' },
  { action: 'bid', aname: 'badbiddevice', uname: 'alice', bid: 'ten',
    deviceID: 'BAD DEVICE!', deviceBlurb: 'a rig' },
];
const atomicValidationResults = atomicValidationCases.map((req) => {
  const refusal = call(req);
  const after = call({ action: 'state', aname: req.aname });
  const noRows = ['auctions', 'users', 'bids'].every((name) =>
    !ss.sheets[name].data.some((r) => r[0] === req.aname));
  return refusal.error && after.roster.length === 0
    && after.bidders.length === 0 && noRows;
});
ok(atomicValidationResults.every(Boolean),
   'claim/bid validation errors are atomic: no auction, seat, or bid row');

// 9c. Replicata: a rival claims or bids on a seat already held by
//     another device. Expectata: the refusal precedes every write.
//     Resultata pre-fix: the visible state was unchanged, but the
//     auction's tmod was silently bumped before the holder check.
call({ action: 'claim', aname: 'heldatomic', uname: 'alice',
       deviceID: 'holder', deviceBlurb: 'holder rig' });
const atomicSheetData = () => JSON.stringify(
  ['auctions', 'users', 'bids'].map((name) => ss.sheets[name].data));
let beforeRival = atomicSheetData();
{ const t = Date.now(); while (Date.now() - t < 3); }
const rivalClaim = call({ action: 'claim', aname: 'heldatomic',
  uname: 'alice', deviceID: 'rival', deviceBlurb: 'rival rig' });
const rivalClaimAtomic = atomicSheetData() === beforeRival;
beforeRival = atomicSheetData();
{ const t = Date.now(); while (Date.now() - t < 3); }
const rivalBid = call({ action: 'bid', aname: 'heldatomic', uname: 'alice',
  bid: 'hijack', deviceID: 'rival', deviceBlurb: 'rival rig' });
const rivalBidAtomic = atomicSheetData() === beforeRival;
ok(rivalClaim.error && rivalBid.error
   && rivalClaimAtomic && rivalBidAtomic,
   'held-seat claim/bid refusals leave every sheet cell unchanged');
ok(call({ action: 'add', aname: 'tau2', uname: '1bad' }).error,
   'bad roster name rejected');
ok(call({ action: 'settings', aname: 'tau2', roster: ['a'] }).error,
   'the old whole-roster settings action is gone');
ok(call({ action: 'reveal', aname: 'tau2' }).error,
   'reveal refused for a solo bidder (an auction takes two)');
ok(call({ action: 'nonsense' }).error, 'unknown action rejected');

// 10. the fresh-name endpoint is gone (particle names scrapped
//     2026-07-16 per dreev: users pick their own auction names)
ok(String(call({ action: 'fresh' }).error)
     === COPY.unknownActionCopy('fresh'),
   'no server-invented names: fresh is an unknown action now');

// 11. schema drift: the header row IS the schema — positional reads
//     against a tab from an older deploy would misread every row, so
//     the API must refuse loudly, naming the tab and both layouts
//     (this is also the delete-the-tabs reminder after a deploy)
const uhead = ss.sheets['users'].data[0];
uhead[2] = 'device';  // the pre-rename column name
resetTabMemo();
st = call({ action: 'state', aname: 'tau' });
ok(String(st.error) === COPY.schemaDriftCopy('users',
     'aname, uname, device, deviceBlurb, tini, tmod',
     'aname, uname, deviceID, deviceBlurb, tini, tmod'),
   'a drifted tab refuses reads, naming the tab and both layouts');
st = call({ action: 'bid', aname: 'tau3', uname: 'zoe', bid: 'nope' });
ok(String(st.error).includes('schema drift')
   && !ss.sheets['bids'].data.some((r) => r[0] === 'tau3'),
   'writes refuse too: nothing lands positionally in a drifted world');
uhead[2] = 'deviceID';
resetTabMemo();
ok(!call({ action: 'state', aname: 'tau' }).error,
   'headers restored: same tabs read fine again');
ss.sheets['auctions'].data[0][6] = 'appended-attribute';
resetTabMemo();
ok(!call({ action: 'state', aname: 'tau' }).error,
   'columns appended past the schema are legal, not drift (future'
   + ' per-person attributes grow rightward)');
ss.sheets['auctions'].data[0].length = 6;
const bhead = ss.sheets['bids'].data[0];
ss.sheets['bids'].data[0] = [];  // cleared-but-not-deleted tab
resetTabMemo();
ok(String(call({ action: 'state', aname: 'tau' }).error)
     .includes('schema drift'),
   'a cleared header row is drift too: the fix is DELETING the tab,'
   + ' not emptying it');
ss.sheets['bids'].data[0] = bhead;
resetTabMemo();

// the cut-row × stays alive pre-reveal as the zombie-purge recovery —
// but post-reveal even THAT freezes: one tap must not delete a
// REVEALED bid from the record (the actual mischief dreev hit; the
// purged bids also explained his 'awaiting bid...' on a closed
// auction — seats without bid rows)
call({ action: 'add', aname: 'frozenx', uname: 'gus' });
call({ action: 'add', aname: 'frozenx', uname: 'hana' });
call({ action: 'add', aname: 'frozenx', uname: 'ivy' });
call({ action: 'bid', aname: 'frozenx', uname: 'gus', bid: 'g' });
call({ action: 'bid', aname: 'frozenx', uname: 'hana', bid: 'h' });
call({ action: 'bid', aname: 'frozenx', uname: 'ivy', bid: 'i' });
call({ action: 'remove', aname: 'frozenx', uname: 'gus' });  // cut: bid stays
call({ action: 'add', aname: 'frozenx', uname: 'gus' });  // re-seat...
call({ action: 'remove', aname: 'frozenx', uname: 'gus' });  // ...re-cut
call({ action: 'reveal', aname: 'frozenx' });
st = call({ action: 'remove', aname: 'frozenx', uname: 'gus' });
ok(String(st.error) === COPY.auctionClosedCopy
   && call({ action: 'state', aname: 'frozenx' }).bids
        .some((b) => b.uname === 'gus'),
   "even the cut-row zombie purge freezes at the gavel: gus's"
   + ' revealed bid stays on the record');

// 12. the freeze doctrine is COMPLETE by construction: every action
//     in handle()'s switch must be explicitly classified. A new
//     action added without deciding its post-close policy fails here
//     — this is the anti-whack-a-mole (each of bid/add/rename/claim/
//     release/remove was individually forgotten once).
const CODE_GS = require('fs').readFileSync(
  require('path').join(__dirname, '..', 'apps-script', 'Code.gs'),
  'utf8');
const actions = [...CODE_GS.matchAll(/case '(\w+)':/g)].map((m) => m[1]);
const FROZEN = ['bid', 'add', 'rename', 'claim', 'release', 'remove'];
const OPEN = ['state', 'reveal',   // reads and the idempotent latch
              'describe'];         // the blurb: editable post-close
                                   // by dreev's explicit design
ok(actions.length >= 9 && actions.every((a) =>
     FROZEN.includes(a) || OPEN.includes(a)),
   'every API action has a declared post-close policy: '
     + actions.join(','));
// each freeze speaks its own copy (Womp Womp for bids, no-new-
// participants for adds, no-editing for the rest) — all refusals
const REFUSALS = [COPY.auctionClosedCopy, COPY.gavelFellCopy,
                  COPY.rosterClosedCopy].map(String);
FROZEN.forEach((a) => {
  const r = call({ action: a, aname: 'tau', uname: 'alice', from: 'alice',
                   to: 'zzz', bid: 'x', deviceID: 'd-z', base: '' });
  ok(REFUSALS.includes(String(r.error)),
     'frozen action refuses on a closed auction: ' + a + ' -> ' + r.error);
});

// 13. the covenant is the SERVER's law, not just this suite's: a
//     sheet edited by hand (or written by pre-freeze code) into a
//     covenant-breaking state is REFUSED loudly, never rendered as
//     nonsense (replicata: test0916 — revealed, roster [alice],
//     no bids anywhere)
ss.sheets['users'].appendRow(['tau', 'ghost', '', '',
  '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z']);
st = ctx.handle({ action: 'state', aname: 'tau' });
ok(String(st.error).includes('covenant'),
   'a corrupted closed auction states its corruption instead of'
   + ' rendering it: ' + st.error);
const ghostRow = ss.sheets['users'].data
  .findIndex((r) => r[1] === 'ghost');
ss.sheets['users'].deleteRow(ghostRow + 1);
ok(!call({ action: 'state', aname: 'tau' }).error,
   'rows fixed: the auction speaks again');

// 14. THE CALL BUDGET: every Sheets service call costs ~50-150ms and
//     the script lock holds for the whole parade, so the per-action
//     call count IS the latency — and the how-many-people-can-bid-
//     at-once story. (Measured live 2026-07-18: a bare state GET ran
//     1.6-3.0s.) Pinned so a future convenience read can't quietly
//     double the round trips. Budgets include the per-execution
//     header checks: one read per tab touched, every request.
call({ action: 'add', aname: 'thrift', uname: 'ann' });
call({ action: 'add', aname: 'thrift', uname: 'ben' });
call({ action: 'bid', aname: 'thrift', uname: 'ann', bid: 'a1',
       deviceID: 'dev-thrift' });
call({ action: 'bid', aname: 'thrift', uname: 'ann', bid: 'a2',
       deviceID: 'dev-thrift' });
call({ action: 'bid', aname: 'thrift', uname: 'ann', bid: 'a3',
       deviceID: 'dev-thrift' });  // a pile: a repaint-all would show
const budget = (req, reads, writes, label) => {
  const t = ctx.__tally;
  const r0 = t.reads, w0 = t.writes, o0 = t.opens;
  const res = call(req);
  ok(!res.error, 'budget probe succeeds: ' + label + ' — ' + res.error);
  ok(t.reads - r0 <= reads && t.writes - w0 <= writes
     && t.opens - o0 <= 1,
     label + ' within budget: ' + (t.reads - r0) + '/' + reads
       + ' reads, ' + (t.writes - w0) + '/' + writes + ' writes, '
       + (t.opens - o0) + '/1 opens');
};
budget({ action: 'state', aname: 'thrift' }, 6, 0, 'a state read');
budget({ action: 'add', aname: 'thrift', uname: 'cee' }, 8, 2,
  'seating a participant');
budget({ action: 'bid', aname: 'thrift', uname: 'ann', bid: 'a4',
         deviceID: 'dev-thrift' }, 10, 5,
  're-bidding (the hot path, a pile of three behind it)');

console.log('gas-quals: all ' + passed + ' assertions passed');
