// Quals for apps-script/Code.gs: stub the Apps Script services
// (SpreadsheetApp/LockService/ContentService) with an in-memory fake
// spreadsheet, load Code.gs, and run the API through its paces.
//
// Run: node quals/gas-quals.js
'use strict';

const ctx = require('./fake-gas')();
const ss = ctx.__ss;

// THE PID ERA (2026-07-19): the pid is the identity; unames are
// display labels. Real clients mint uuid pids; here a STABLE fake pid
// derives from (aname, uname) so scenarios stay readable. names()
// flattens a state's live-seat labels for roster-shaped asserts;
// cutNames() the flagged ones.
const pid = (a, u) => ('pid-' + a + '-' + u).toLowerCase();
const names = (st) => st.seats.map((s) => s.uname).join(',');

// Every action's result is checked against THE CLOSED-STATE COVENANT
// (dreev found live auction test0916 revealed with a solo, bidless
// roster — fabricated by pre-freeze code plus tab recreations): once
// revealed, at least two live roster seats, every one of them with a
// bid, forever (the freezes make it eternal).
const call = (req) => {
  const st = ctx.handle(req);
  if (st && !st.error && st.revealed) {
    ok(st.seats.length >= 2
       && st.seats.every((s) =>
            st.bidders.some((b) => b.pid === s.pid)),
       'closed-state covenant after "' + req.action + '" on '
         + st.aname + ': roster=' + JSON.stringify(names(st))
         + ' bidders=' + JSON.stringify(st.bidders.map((b) => b.pid)));
  }
  return st;
};

// Server microcopy DERIVED from Code.gs's block (read back out of the
// vm context hosting it), so copy edits there never break these quals
// — they pin the right words in the right place, not the wording
const COPY = require('vm').runInContext('({ gavelFellCopy,'
  + ' simulEditsCopy, bidSeatHeldCopy, unknownActionCopy,'
  + ' mysteryDeviceCopy, schemaDriftCopy, auctionClosedCopy,'
  + ' rosterClosedCopy, badDevBlurbCopy, badPidCopy, nameTakenCopy,'
  + ' removeBidderCopy })', ctx);
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

// 1. state of a virgin auction: empty seats, sealed, creates no rows
let st = call({ action: 'state', aname: 'TAU' });
ok(st.aname === 'tau' && st.seats.length === 0, 'virgin defaults');
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
st = call({ action: 'bid', aname: 'Tau', uname: 'Alice',
            pid: pid('tau', 'alice'), bid: '  3 tacos ' });
ok(!st.error, 'bid accepted: ' + st.error);
ok(st.bidders.length === 1 && st.bidders[0].pid === pid('tau', 'alice'),
   'bidder recorded, keyed by pid');
ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(st.bidders[0].tmod),
   'bidder carries ISO tmod stamp');
ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(st.bidders[0].tini),
   'bidder carries ISO tini stamp (the bid-cell tooltip needs it)');
ok(st.bidders[0].bcount === 1, 'first submission counts 1');
ok(names(st) === 'alice', 'bidding claims a roster seat, labeled');
ok(ss.sheets['users'].data[1][1] === pid('tau', 'alice')
   && ss.sheets['users'].data[1][2] === 'alice',
   'seat written to the sheet: pid and label');
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
st = call({ action: 'bid', aname: 'tau', uname: 'alice',
            pid: pid('tau', 'alice'), bid: 'sushi' });
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
   && call({ action: 'state', aname: 'tau' }).bidders[0].pid
        === pid('tau', 'alice'),
   'one BIDDER in the payload however many rows: latest-row-wins');

// 4b. Replicata: a pid that is literally "constructor" (valid by the
//     pid grammar) submits a bid. Expectata: aggregated like any pid.
//     Resultata pre-fix: Object.prototype.constructor impersonated an
//     aggregate entry, so the sheet row existed but the bidder vanished.
call({ action: 'add', aname: 'reserved', uname: 'constructor',
       pid: 'constructor' });
call({ action: 'add', aname: 'reserved', uname: 'alice',
       pid: pid('reserved', 'alice') });
st = call({ action: 'bid', aname: 'reserved', uname: 'constructor',
            pid: 'constructor', bid: 'reserved words are people too' });
ok(st.bidders.some((b) => b.pid === 'constructor'),
   'valid reserved-key pid is aggregated: its logged bid cannot vanish');
call({ action: 'bid', aname: 'reserved', uname: 'alice',
       pid: pid('reserved', 'alice'), bid: 'ordinary' });
ok(!call({ action: 'reveal', aname: 'reserved' }).error,
   'reserved-key bidder counts toward reveal readiness');
const reservedState = call({ action: 'state', aname: 'reserved' });
ok(reservedState.claims.constructor === undefined
   && reservedState.blurbs.constructor === undefined,
   'pid-keyed payload maps have no inherited reserved-key entries');

// 5. reveal is a human act: a complete roster only UNLOCKS it.
//    (The motivating bug: two drive-by bidders who never stated a roster
//    must not see each other's bids just because they're "all in".)
call({ action: 'add', aname: 'tau', uname: 'Alice',
       pid: pid('tau', 'alice') });
st = call({ action: 'add', aname: 'tau', uname: 'bob',
            pid: pid('tau', 'bob') });
st = call({ action: 'add', aname: 'tau', uname: 'alice',
            pid: pid('tau', 'alice') });
ok(!st.error && names(st) === 'alice,bob',
   'adds are idempotent + normalized: one seat per person');
ok(call({ action: 'reveal', aname: 'tau' }).error,
   'reveal refused while bob is outstanding');
st = call({ action: 'bid', aname: 'tau', uname: 'bob',
            pid: pid('tau', 'bob'), bid: '$40' });
ok(st.revealed === false && st.bids === null,
   'roster complete: still sealed until someone reveals');
st = call({ action: 'reveal', aname: 'tau' });
ok(st.revealed === true, 'pressing reveal reveals');
ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(st.tfin),
   'the reveal stamps its moment (the Closed line needs it)');
ok(st.bids.length === 2 && st.bids[0].pid === pid('tau', 'alice')
   && st.bids[0].bid === 'sushi' && st.bids[1].bid === '$40', 'bids exposed');
ok(ss.sheets['bids'].colors['2,3'] === null
   && ss.sheets['bids'].colors['3,3'] === null,
   'revealed bids repainted visible');
ok(!call({ action: 'reveal', aname: 'tau' }).error,
   'racing reveal presses: idempotent, no error');

// 6. the gavel drop is a BRIGHT LINE (2026-07-16, dreev — reversing
//    the old permissive-after-reveal pin): no bid lands after tfin,
//    and the loser of an under-the-wire race hears it explicitly
st = call({ action: 'bid', aname: 'tau', uname: 'carl',
            pid: pid('tau', 'carl'), bid: 'too late' });
ok(String(st.error) === COPY.gavelFellCopy
   && call({ action: 'state', aname: 'tau' }).bids.length === 2
   && !names(call({ action: 'state', aname: 'tau' })).includes('carl'),
   'a bid after the gavel falls is refused outright: nothing written');
st = call({ action: 'bid', aname: 'tau', uname: 'alice',
            pid: pid('tau', 'alice'), bid: 'revised!' });
ok(String(st.error) === COPY.gavelFellCopy
   && call({ action: 'state', aname: 'tau' }).bids[0].bid === 'sushi',
   "even the bidder's own revision bounces: the record is the record");
st = call({ action: 'rename', aname: 'tau', pid: pid('tau', 'alice'),
            to: 'mallory' });
ok(String(st.error) === COPY.auctionClosedCopy
   && names(call({ action: 'state', aname: 'tau' })).includes('alice')
   && call({ action: 'state', aname: 'tau' }).bids
        .some((b) => b.pid === pid('tau', 'alice')),
   'names freeze at the gavel too (dreev 2026-07-17, reversing'
   + ' always-editable: a post-close rename could swap around who bid'
   + " what): refused, and alice's bid stays alice's");
// ...and so do SEATS: found hunting dreev's one-more-bug 2026-07-17 —
// post-reveal claims re-attributed a revealed bid to a stranger's rig,
// and releases reopened seats for the taking. The whole record
// freezes at the gavel.
st = call({ action: 'claim', aname: 'tau', pid: pid('tau', 'alice'),
            deviceID: 'd-x', deviceBlurb: 'mallory rig' });
ok(String(st.error) === COPY.auctionClosedCopy
   && call({ action: 'state', aname: 'tau' })
        .claims[pid('tau', 'alice')] === undefined,
   "identities freeze at the gavel: a post-close claim can't dress a"
   + " revealed bid in a stranger's rig");
st = call({ action: 'release', aname: 'tau', pid: pid('tau', 'alice'),
            deviceID: 'd-x' });
ok(String(st.error) === COPY.auctionClosedCopy,
   'releases freeze too: no reopening seats after the game');
// (2026-07-16, per dreev: the roster is CLOSED once revealed — adds
// refuse rather than merely not-resealing)
st = call({ action: 'add', aname: 'tau', uname: 'zed',
            pid: pid('tau', 'zed') });
ok(st.error && !names(call({ action: 'state', aname: 'tau' }))
     .includes('zed'),
   'adding a participant after the reveal is refused: game over');
ok(ss.sheets['bids'].colors['2,3'] === null,
   'bids stay visible in the sheet after the latch');
// [FLIPPED 2026-07-18, dreev's report "it just let me remove someone
// from a closed auction": the freeze doctrine never reached remove.
// The old pins blessed permissive removal; now the whole record —
// seats, bids, cut-row zombie purges — freezes at the gavel.]
st = call({ action: 'remove', aname: 'tau', pid: pid('tau', 'bob') });
ok(String(st.error) === COPY.auctionClosedCopy
   && names(call({ action: 'state', aname: 'tau' })).includes('bob'),
   'removing a seat from a CLOSED auction is refused: the roster is'
   + ' part of the frozen record');
ok(call({ action: 'state', aname: 'tau' }).revealed === true,
   'and still revealed, of course');

// 6b. end-early = ex the straggler, THEN press reveal; roster edits
//     alone never reveal anything
call({ action: 'add', aname: 'photon', uname: 'pat',
       pid: pid('photon', 'pat') });
call({ action: 'add', aname: 'photon', uname: 'quinn',
       pid: pid('photon', 'quinn') });
st = call({ action: 'add', aname: 'photon', uname: 'rey',
            pid: pid('photon', 'rey') });
call({ action: 'bid', aname: 'photon', uname: 'pat',
       pid: pid('photon', 'pat'), bid: 'one photon' });
st = call({ action: 'bid', aname: 'photon', uname: 'rey',
            pid: pid('photon', 'rey'), bid: 'two photons' });
ok(st.revealed === false, 'photon sealed while quinn is outstanding');
ok(call({ action: 'reveal', aname: 'photon' }).error,
   'reveal refused with a straggler on the roster');
st = call({ action: 'remove', aname: 'photon',
            pid: pid('photon', 'quinn') });
ok(st.revealed === false, 'shrinking the roster alone reveals nothing');
st = call({ action: 'reveal', aname: 'photon' });
ok(st.revealed === true, 'ex the straggler, then reveal: end-early');
st = call({ action: 'add', aname: 'photon', uname: 'quinn',
            pid: pid('photon', 'quinn') });
ok(st.error && call({ action: 'state', aname: 'photon' }).revealed === true,
   'the ended auction refuses new participants; the latch holds');

// 6e. [REWRITTEN 2026-07-19, dreev deleting the cut-flag model:
//     "just say no removing someone if they've bid."] Replicata: zomb
//     bids, then a remove for zomb arrives (only reachable by losing
//     a race — the UI grays that ×). Expectata: refused loudly, in
//     the Latin, and NOTHING changes: a sealed bid is never deletable
//     and now never orphaned either, so no cut state exists at all.
call({ action: 'add', aname: 'zombie', uname: 'zomb',
       pid: pid('zombie', 'zomb') });
call({ action: 'add', aname: 'zombie', uname: 'keep',
       pid: pid('zombie', 'keep') });
call({ action: 'bid', aname: 'zombie', uname: 'zomb',
       pid: pid('zombie', 'zomb'), bid: 'undead' });
st = call({ action: 'remove', aname: 'zombie',
            pid: pid('zombie', 'zomb') });
ok(String(st.error) === COPY.removeBidderCopy
   && names(call({ action: 'state', aname: 'zombie' })) === 'zomb,keep'
   && call({ action: 'state', aname: 'zombie' }).bidders.length === 1,
   'removing a bidder is refused outright: seat, bid, and roster all'
   + ' untouched');
st = call({ action: 'remove', aname: 'zombie',
            pid: pid('zombie', 'keep') });
ok(!st.error && names(st) === 'zomb'
   && ss.sheets['users'].data.filter(r => r[0] === 'zombie').length === 1,
   'removing a BIDLESS person deletes the seat row outright: no flag,'
   + ' no ghost');

// 6d. the removal race, other order: ada's seat is removed while her
//     FIRST bid is in flight (she was bidless when the remove landed,
//     so it succeeded). Expectata: her bid simply rebuilds the seat —
//     same pid, nothing orphaned, the race self-heals.
call({ action: 'add', aname: 'boson', uname: 'ada',
       pid: pid('boson', 'ada') });
call({ action: 'add', aname: 'boson', uname: 'ben',
       pid: pid('boson', 'ben') });
st = call({ action: 'remove', aname: 'boson', pid: pid('boson', 'ada') });
ok(names(st) === 'ben', 'removing bidless ada deletes her seat');
st = call({ action: 'bid', aname: 'boson', uname: 'ada',
            pid: pid('boson', 'ada'), bid: 'x anyway' });
ok(names(st) === 'ben,ada' && st.bidders.length === 1,
   "ada's in-flight bid rebuilds her seat: same pid, race healed");
ok(st.revealed === false, 'still sealed: ben is outstanding');

// 6c. rows with a blank bcount: an existing bid row implies at
//     least one submission — never 0 (green row + 0 is a contradiction)
ss.sheets['bids'].appendRow(['relic', pid('relic', 'oldtimer'),
  'ancient bid', '', '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z']);
st = call({ action: 'state', aname: 'relic' });
ok(st.bidders[0].bcount === 1, 'legacy bid row counts as 1, never 0');
const t1 = Date.now(); while (Date.now() - t1 < 3);
st = call({ action: 'bid', aname: 'relic', uname: 'oldtimer',
            pid: pid('relic', 'oldtimer'), bid: 'newer' });
ok(st.bidders[0].bcount === 2, 'legacy re-bid counts as 2');

// 7. walk-on bidders don't gate the reveal
call({ action: 'add', aname: 'gluon', uname: 'dee',
       pid: pid('gluon', 'dee') });
st = call({ action: 'add', aname: 'gluon', uname: 'evy',
            pid: pid('gluon', 'evy') });
st = call({ action: 'bid', aname: 'gluon', uname: 'dee',
            pid: pid('gluon', 'dee'), bid: 'I bid 2 dishes' });
ok(st.revealed === false, 'waiting on evy');
st = call({ action: 'bid', aname: 'gluon', uname: 'rando',
            pid: pid('gluon', 'rando'), bid: 'me too!' });
ok(st.revealed === false && names(st).includes('rando'),
   'walk-on joins the roster; reveal still waits on evy');
st = call({ action: 'bid', aname: 'gluon', uname: 'evy',
            pid: pid('gluon', 'evy'), bid: '1 dish + dessert' });
ok(st.revealed === false, 'complete (including the walk-on) but still sealed');
st = call({ action: 'reveal', aname: 'gluon' });
ok(st.revealed === true && st.bids.length === 3, 'reveal exposes all three');
// a walk-on bid whose LABEL is already live under someone else's pid
// is a doppelganger, refused (live labels are unique; identity is
// the pid, but the ledger must stay legible)
st = call({ action: 'bid', aname: 'gluon2', uname: 'solo',
            pid: pid('gluon2', 'solo'), bid: 'first' });
st = call({ action: 'bid', aname: 'gluon2', uname: 'solo',
            pid: 'pid-gluon2-imposter', bid: 'second' });
ok(String(st.error) === COPY.nameTakenCopy
   && call({ action: 'state', aname: 'gluon2' }).bidders.length === 1,
   'a doppelganger walk-on (live label, foreign pid) is refused');

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
ok(st.exists === true && st.seats.length === 0 && st.bidders.length === 0,
   'description-only auction reports existing despite an empty ledger');

// 8. seats are rows in the users tab; adds upsert, removes delete
st = call({ action: 'add', aname: 'muon', uname: 'a',
            pid: pid('muon', 'a') });
st = call({ action: 'add', aname: 'muon', uname: 'a',
            pid: pid('muon', 'a') });
ok(!st.error && names(st) === 'a',
   'an exact same-pid add retry is idempotent');
st = call({ action: 'add', aname: 'muon', uname: 'b',
            pid: pid('muon', 'b') });
ok(names(st) === 'a,b', 'roster grows in insertion order');
ok(ss.sheets['users'].data.filter(r => r[0] === 'muon').length === 2,
   'duplicate add: still one seat row');
// Replicata: another browser submits a live label under its own fresh
// pid (two people type alice). Expectata (dreev 2026-07-21, reversing
// the 07-20 loud refusal — the error read as wrong when alice WAS
// added, exactly as requested): the goal state already holds, so this
// is idempotent SUCCESS — no error, no doppelganger, zero sheet
// writes, not even a tmod bump; the loser's pid stays unseated and
// they converge as an ordinary latecomer. Renames onto a live label
// still refuse: their goal is a CHANGE, which genuinely didn't
// happen. Resultata pre-flip: it threw nameTakenCopy at a satisfied
// request.
const collisionWrites = ctx.__tally.writes;
st = call({ action: 'add', aname: 'muon', uname: 'a',
            pid: 'pid-muon-second-browser' });
ok(!st.error && names(st) === 'a,b'
   && st.seats.find((s) => s.uname === 'a').pid === pid('muon', 'a')
   && ss.sheets['users'].data.filter(r => r[0] === 'muon').length === 2
   && ctx.__tally.writes === collisionWrites,
   'a live label under a different pid is idempotent success: zero'
   + ' writes, no doppelganger, the original seat stands');
ok(ss.sheets['auctions'].data.filter(r => r[0] === 'muon').length === 1,
   'one auctions row per auction');
st = call({ action: 'remove', aname: 'muon', pid: pid('muon', 'a') });
ok(names(st) === 'b'
   && ss.sheets['users'].data.filter(r => r[0] === 'muon').length === 1,
   'removing a bidless person deletes the seat row');
ok(!call({ action: 'remove', aname: 'muon',
           pid: pid('muon', 'ghost') }).error,
   'removing an absent seat is a harmless no-op');
// re-adding a removed name is a plain fresh add: they were bidless
// when removed (guaranteed now), so there is nothing to continue
st = call({ action: 'add', aname: 'muon', uname: 'a',
            pid: 'pid-muon-freshly-minted' });
ok(!st.error && names(st) === 'b,a'
   && st.seats.find((s) => s.uname === 'a').pid
        === 'pid-muon-freshly-minted',
   're-adding a removed name mints a fresh seat under the new pid');

// 8b. claims: who-is-who is server truth, so two machines can't both
//     be alice. FIRST COME, FIRST SERVED (2026-07-16; the old
//     last-write-wins let a stale click silently steal a seat, anyone
//     release anyone, and a bid hijack a held seat — the two pinned
//     behaviors changed here were flagged to dreev): claiming
//     registers your device id; a held seat refuses rivals loudly;
//     only the holder may release; one device holds at most one seat
//     per auction (claiming anew releases your old one, radio-style);
//     bidding registers the claim iff the seat is yours or open.
const annP = pid('higgs', 'ann');
const benP = pid('higgs', 'ben');
const ceeP = pid('higgs', 'cee');
call({ action: 'add', aname: 'higgs', uname: 'ann', pid: annP });
st = call({ action: 'add', aname: 'higgs', uname: 'ben', pid: benP });
ok(st.claims && Object.keys(st.claims).length === 0,
   'no claims yet: empty map');
st = call({ action: 'claim', aname: 'higgs', pid: annP, deviceID: 'dev-1',
            deviceBlurb: 'a Mac (Chrome)' });
ok(!st.error && st.claims[annP] === 'dev-1', 'claim registers the device');
ok(st.blurbs[annP] === 'a Mac (Chrome)',
   "the claimant's self-reported deviceBlurb rides along");
st = call({ action: 'claim', aname: 'higgs', pid: annP, deviceID: 'dev-1',
            deviceBlurb: 'a Mac (Chrome)' });
ok(!st.error && st.claims[annP] === 'dev-1', 're-claiming your own seat is'
   + ' idempotent (a device that lost localStorage re-latches)');
// Replicata (faire, /carnoon, 2026-07-21): her phone claimed her
// seat, then Safari handed her a fresh device uuid (private tab or
// evicted storage) and her own seat refused her as "Claimed by
// someone (iPhone Safari...)" — herself. Expectata (dreev's ruling,
// reversing first-come-first-served): a claim is a consistency
// marker, not auth — it TAKES the seat, last write wins, honor
// system like every other op. Resultata pre-flip: ERROR1304; her
// only escape was removing and re-adding herself.
st = call({ action: 'claim', aname: 'higgs', pid: annP, deviceID: 'dev-2',
            deviceBlurb: 'an iPhone (Safari)' });
ok(!st.error && st.claims[annP] === 'dev-2'
   && st.blurbs[annP] === 'an iPhone (Safari)',
   'a claim on a held seat TAKES it: last write wins, new rig blurbed');
st = call({ action: 'release', aname: 'higgs', pid: annP,
            deviceID: 'dev-1' });
ok(String(st.error).includes('ERROR1306')
   && call({ action: 'state', aname: 'higgs' }).claims[annP] === 'dev-2',
   'only the CURRENT holder may release a seat');
st = call({ action: 'release', aname: 'higgs', pid: benP,
            deviceID: 'dev-9' });
ok(!st.error, 'releasing an unheld seat is a no-op (a merely-local'
   + ' soft claim must release without drama)');
st = call({ action: 'release', aname: 'higgs', pid: annP,
            deviceID: 'dev-2' });
ok(!st.error && st.claims[annP] === undefined,
   'the holder releases: seat open again');
st = call({ action: 'claim', aname: 'higgs', pid: benP, deviceID: 'dev-1' });
st = call({ action: 'claim', aname: 'higgs', pid: annP, deviceID: 'dev-1' });
ok(st.claims[annP] === 'dev-1' && st.claims[benP] === undefined,
   'one seat per deviceID: claiming ann releases your ben, radio-style');
ok(ss.sheets['users'].data.filter(r => r[0] === 'higgs' && r[1] === annP)
     .length === 1, 'claims live on the seat row: upsert, not append');
st = call({ action: 'bid', aname: 'higgs', uname: 'ann', pid: annP,
            bid: 'a boson', deviceID: 'dev-3' });
ok(String(st.error) === COPY.bidSeatHeldCopy(COPY.mysteryDeviceCopy)
   && call({ action: 'state', aname: 'higgs' }).bidders.length === 0,
   "a bid can't hijack a held seat: refused, naming the holder's rig,"
   + ' and no bid row written');
st = call({ action: 'bid', aname: 'higgs', uname: 'ben', pid: benP,
            bid: 'legal', deviceID: 'dev-3' });
ok(!st.error && st.claims[benP] === 'dev-3',
   'bidding an OPEN seat registers your claim on it');
st = call({ action: 'bid', aname: 'higgs', uname: 'ben', pid: benP,
            bid: 'nope' });
ok(String(st.error).includes('ERROR1312'),
   'a device-less bid (old client) counts as nobody: refused on a'
   + ' held seat too');
call({ action: 'add', aname: 'higgs', uname: 'cee', pid: ceeP });
st = call({ action: 'bid', aname: 'higgs', uname: 'cee', pid: ceeP,
            bid: 'old' });
ok(!st.error && st.claims[ceeP] === undefined,
   'a device-less bid on an open seat still works, claiming nothing');
ok(call({ action: 'claim', aname: 'higgs', pid: annP,
          deviceID: 'BAD DEVICE!' }).error, 'garbage device id rejected');
ok(call({ action: 'claim', aname: 'higgs', pid: ceeP,
          deviceID: '' }).error,
   'a claim with no device is a client bug: refused');
ok(call({ action: 'claim', aname: 'higgs', pid: 'pid-higgs-nobody',
          deviceID: 'dev-8' }).error,
   'claiming a seat that does not exist is refused (the client only'
   + ' ever claims rows it can see; ops serialize behind the add)');
// the deviceBlurb contract the client must meet: printable ASCII,
// max 64 chars — the frontend ASCII-fies and clamps its decoration
// to fit (a São Paulo bidder must never lose a bid to an accent)
st = call({ action: 'claim', aname: 'higgs', pid: annP,
            deviceID: 'dev-1', deviceBlurb: 'Mac in São Paulo' });
ok(String(st.error) === COPY.badDevBlurbCopy,
   'a non-ASCII deviceBlurb is refused: the contract is printable'
   + ' ASCII, and the server never silently fixes inputs');
ok(call({ action: 'claim', aname: 'higgs', pid: annP,
          deviceID: 'dev-1', deviceBlurb: 'y'.repeat(65) }).error,
   'a 65-char deviceBlurb is refused');
ok(!call({ action: 'claim', aname: 'higgs', pid: annP,
           deviceID: 'dev-1', deviceBlurb: 'y'.repeat(64) }).error,
   'a 64-char deviceBlurb is accepted: the fence sits at exactly 64');

// 8c. renames are LABEL EDITS (the pid era's whole point): one cell
//     changes; bids, claims, stamps, and counts don't even notice
call({ action: 'add', aname: 'strange', uname: 'alicw',
       pid: pid('strange', 'alicw') });
call({ action: 'add', aname: 'strange', uname: 'bob',
       pid: pid('strange', 'bob') });
call({ action: 'claim', aname: 'strange', pid: pid('strange', 'alicw'),
       deviceID: 'dev-9' });
st = call({ action: 'bid', aname: 'strange', uname: 'alicw',
            pid: pid('strange', 'alicw'), bid: 'six',
            deviceID: 'dev-9' });  // the holder's own bid
const stampB4 = st.bidders[0].tmod;
st = call({ action: 'rename', aname: 'strange',
            pid: pid('strange', 'alicw'), to: 'Alice' });
ok(!st.error && names(st) === 'alice,bob',
   'typo fixed in place, normalized, order kept');
ok(st.claims[pid('strange', 'alicw')] === 'dev-9',
   'the claim rides the renamed seat (same pid: nothing moved)');
ok(st.bidders.length === 1
   && st.bidders[0].pid === pid('strange', 'alicw')
   && st.bidders[0].tmod === stampB4 && st.bidders[0].bcount === 1,
   'the bid follows the rename: stamps and count intact');
ok(call({ action: 'rename', aname: 'strange',
          pid: pid('strange', 'alicw'), to: 'bob' })
   .error, 'renaming onto an existing live name is refused');
ok(call({ action: 'rename', aname: 'strange',
          pid: pid('strange', 'ghost'), to: 'gus' })
   .error, 'renaming a nonexistent participant is refused');
ok(call({ action: 'rename', aname: 'strange',
          pid: pid('strange', 'bob'), to: '1bad' })
   .error, 'renaming to an invalid name is refused');
ok(!call({ action: 'rename', aname: 'strange',
           pid: pid('strange', 'bob'), to: 'bob' })
   .error, 'renaming to the same name is a no-op');

// 8d. [REWRITTEN 2026-07-19: bidders can't be removed at all, so a
//     bidder's label stays seated and reserved — renaming onto it
//     collides like any live label, and bid histories can never
//     merge because bids ride pids.]
call({ action: 'add', aname: 'cutrename', uname: 'alice',
       pid: pid('cutrename', 'alice') });
call({ action: 'add', aname: 'cutrename', uname: 'bob',
       pid: pid('cutrename', 'bob') });
call({ action: 'bid', aname: 'cutrename', uname: 'bob',
       pid: pid('cutrename', 'bob'), bid: 'bobs bid' });
st = call({ action: 'remove', aname: 'cutrename',
            pid: pid('cutrename', 'bob') });
ok(String(st.error) === COPY.removeBidderCopy,
   "bob has bid, so bob stays: his seat and label are permanent");
st = call({ action: 'rename', aname: 'cutrename',
            pid: pid('cutrename', 'alice'), to: 'bob' });
const cutRenameState = call({ action: 'state', aname: 'cutrename' });
ok(String(st.error) === COPY.nameTakenCopy
   && names(cutRenameState) === 'alice,bob'
   && cutRenameState.bidders[0].pid === pid('cutrename', 'bob'),
   "a bidder's label is reserved by their permanent seat: renames"
   + ' collide, histories never merge');

// 9. validation
ok(call({ action: 'bid', aname: 'ta_u', uname: 'a',
          pid: 'pid-x-aaaa', bid: 'x' }).error,
   'bad slug rejected');
ok(call({ action: 'bid', aname: 'tau2', uname: '1abc',
          pid: 'pid-tau2-x', bid: 'x' }).error,
   'name starting with digit rejected');
ok(call({ action: 'bid', aname: 'tau2', uname: 'a b',
          pid: 'pid-tau2-y', bid: 'x' }).error,
   'name with space rejected');
ok(String(call({ action: 'bid', aname: 'tau2', uname: 'abc',
                 pid: 'NOT A PID!', bid: 'x' }).error)
     === COPY.badPidCopy,
   'garbage pid rejected');
ok(String(call({ action: 'bid', aname: 'tau2', uname: 'abc',
                 bid: 'x' }).error) === COPY.badPidCopy,
   'a MISSING pid is rejected too: old-shape clients fail loudly,'
   + ' never half-write');
ok(call({ action: 'bid', aname: 'tau2', uname: 'abc',
          pid: pid('tau2', 'abc'), bid: '' }).error,
   'empty bid rejected');
ok(call({ action: 'bid', aname: 'tau2', uname: 'abc',
          pid: pid('tau2', 'abc'), bid: 'y'.repeat(161) })
   .error, '81-char bid rejected');
ok(!call({ action: 'bid', aname: 'tau2', uname: 'abc',
           pid: pid('tau2', 'abc'), bid: 'y'.repeat(160) })
   .error, '160-char bid accepted');

// 9b. Replicata: send a virgin claim/bid whose device decoration or id
//     is invalid. Expectata: validation refuses before any write.
//     Resultata pre-fix: touchAuction + ensureSeat ran first, so an error
//     response left a phantom roster seat with no claim and no bid.
const atomicValidationCases = [
  { action: 'claim', aname: 'badclaim', pid: 'pid-badclaim-alice',
    deviceID: 'dev-1', deviceBlurb: 'São Paulo' },
  { action: 'bid', aname: 'badbidblurb', uname: 'alice',
    pid: 'pid-badbidblurb-alice', bid: 'ten',
    deviceID: 'dev-1', deviceBlurb: 'São Paulo' },
  { action: 'bid', aname: 'badbiddevice', uname: 'alice',
    pid: 'pid-badbiddevice-alice', bid: 'ten',
    deviceID: 'BAD DEVICE!', deviceBlurb: 'a rig' },
];
const atomicValidationResults = atomicValidationCases.map((req) => {
  const refusal = call(req);
  const after = call({ action: 'state', aname: req.aname });
  const noRows = ['auctions', 'users', 'bids'].every((name) =>
    !ss.sheets[name].data.some((r) => r[0] === req.aname));
  return refusal.error && after.seats.length === 0
    && after.bidders.length === 0 && noRows;
});
ok(atomicValidationResults.every(Boolean),
   'claim/bid validation errors are atomic: no auction, seat, or bid row');

// 9c. Replicata: a rival claims, then a THIRD device bids, on a held
//     seat. Expectata (post-takeover-ruling): the claim TAKES the
//     seat (a real write, by design); the bare rival bid still
//     refuses, and that refusal precedes every write. Resultata
//     pre-fix of the atomicity half: the visible state was
//     unchanged, but tmod was silently bumped before the holder
//     check.
call({ action: 'add', aname: 'heldatomic', uname: 'alice',
       pid: pid('heldatomic', 'alice') });
call({ action: 'claim', aname: 'heldatomic',
       pid: pid('heldatomic', 'alice'),
       deviceID: 'holder', deviceBlurb: 'holder rig' });
const atomicSheetData = () => JSON.stringify(
  ['auctions', 'users', 'bids'].map((name) => ss.sheets[name].data));
const rivalClaim = call({ action: 'claim', aname: 'heldatomic',
  pid: pid('heldatomic', 'alice'),
  deviceID: 'rival', deviceBlurb: 'rival rig' });
ok(!rivalClaim.error
   && rivalClaim.claims[pid('heldatomic', 'alice')] === 'rival',
   'the rival claim takes the held seat: last write wins');
const beforeRival = atomicSheetData();
{ const t = Date.now(); while (Date.now() - t < 3); }
const rivalBid = call({ action: 'bid', aname: 'heldatomic',
  uname: 'alice', pid: pid('heldatomic', 'alice'),
  bid: 'hijack', deviceID: 'rival2', deviceBlurb: 'third rig' });
ok(rivalBid.error && atomicSheetData() === beforeRival,
   'a bare bid on a held seat still refuses, leaving every sheet'
   + ' cell unchanged');
ok(call({ action: 'add', aname: 'tau2', uname: '1bad',
          pid: 'pid-tau2-bad' }).error,
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
uhead[3] = 'device';  // the pre-rename column name
resetTabMemo();
st = call({ action: 'state', aname: 'tau' });
ok(String(st.error) === COPY.schemaDriftCopy('users',
     'aname, pid, uname, device, deviceBlurb, tini, tmod',
     'aname, pid, uname, deviceID, deviceBlurb, tini, tmod'),
   'a drifted tab refuses reads, naming the tab and both layouts');
st = call({ action: 'bid', aname: 'tau3', uname: 'zoe',
            pid: pid('tau3', 'zoe'), bid: 'nope' });
ok(String(st.error).includes('schema drift')
   && !ss.sheets['bids'].data.some((r) => r[0] === 'tau3'),
   'writes refuse too: nothing lands positionally in a drifted world');
uhead[3] = 'deviceID';
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

// a bidder is unremovable BEFORE the gavel (their bid protects the
// seat) and everything is unremovable after it — belt and suspenders
// around the same invariant: a revealed record never loses a bid
call({ action: 'add', aname: 'frozenx', uname: 'gus',
       pid: pid('frozenx', 'gus') });
call({ action: 'add', aname: 'frozenx', uname: 'hana',
       pid: pid('frozenx', 'hana') });
call({ action: 'bid', aname: 'frozenx', uname: 'gus',
       pid: pid('frozenx', 'gus'), bid: 'g' });
call({ action: 'bid', aname: 'frozenx', uname: 'hana',
       pid: pid('frozenx', 'hana'), bid: 'h' });
call({ action: 'reveal', aname: 'frozenx' });
st = call({ action: 'remove', aname: 'frozenx',
            pid: pid('frozenx', 'gus') });
ok(String(st.error) === COPY.auctionClosedCopy
   && call({ action: 'state', aname: 'frozenx' }).bids
        .some((b) => b.pid === pid('frozenx', 'gus')),
   "the gavel freezes removes wholesale: gus's revealed bid stays on"
   + ' the record');

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
  const r = call({ action: a, aname: 'tau', uname: 'alice',
                   pid: pid('tau', 'alice'), to: 'zzz', bid: 'x',
                   deviceID: 'd-z', base: '' });
  ok(REFUSALS.includes(String(r.error)),
     'frozen action refuses on a closed auction: ' + a + ' -> ' + r.error);
});

// 13. the covenant is the SERVER's law, not just this suite's: a
//     sheet edited by hand (or written by pre-freeze code) into a
//     covenant-breaking state is REFUSED loudly, never rendered as
//     nonsense (replicata: test0916 — revealed, roster [alice],
//     no bids anywhere)
ss.sheets['users'].appendRow(['tau', 'pid-tau-ghost', 'ghost', '', '',
  '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z']);
st = ctx.handle({ action: 'state', aname: 'tau' });
ok(String(st.error).includes('covenant'),
   'a corrupted closed auction states its corruption instead of'
   + ' rendering it: ' + st.error);
const ghostRow = ss.sheets['users'].data
  .findIndex((r) => r[2] === 'ghost');
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
call({ action: 'add', aname: 'thrift', uname: 'ann',
       pid: pid('thrift', 'ann') });
call({ action: 'add', aname: 'thrift', uname: 'ben',
       pid: pid('thrift', 'ben') });
call({ action: 'bid', aname: 'thrift', uname: 'ann',
       pid: pid('thrift', 'ann'), bid: 'a1', deviceID: 'dev-thrift' });
call({ action: 'bid', aname: 'thrift', uname: 'ann',
       pid: pid('thrift', 'ann'), bid: 'a2', deviceID: 'dev-thrift' });
call({ action: 'bid', aname: 'thrift', uname: 'ann',
       pid: pid('thrift', 'ann'), bid: 'a3',
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
budget({ action: 'add', aname: 'thrift', uname: 'cee',
         pid: pid('thrift', 'cee') }, 8, 2,
  'seating a participant');
budget({ action: 'bid', aname: 'thrift', uname: 'ann',
         pid: pid('thrift', 'ann'), bid: 'a4',
         deviceID: 'dev-thrift' }, 10, 5,
  're-bidding (the hot path, a pile of three behind it)');

// 15. THE ARMOR (gridScience, 2026-07-18: rows born when appendRow
//     grows the grid do NOT inherit plain-text formatting — bounded
//     and whole-column armor both fall — so "007" silently becomes 7:
//     sealed-bid corruption, the worst failure this app can have).
//     The scheme: every tab is born with an ARMOR_ROWS-deep
//     pre-armored grid, and an append past the armor refuses LOUDLY
//     instead of trusting the grid.
const ARMOR = require('vm').runInContext(
  "typeof ARMOR_ROWS === 'undefined' ? 10000 : ARMOR_ROWS", ctx);
const ARMOR_COPY = require('vm').runInContext(
  "typeof armorFullCopy === 'undefined' ? null : armorFullCopy", ctx);
ok(ss.sheets['bids'].plainTextRows >= ARMOR
   && ss.sheets['users'].plainTextRows >= ARMOR
   && ss.sheets['auctions'].plainTextRows >= ARMOR,
   'every tab is born fully armored: plain text laid down ' + ARMOR
     + ' rows deep, got ' + ss.sheets['bids'].plainTextRows);
const pit = ss.sheets['bids'];
while (pit.data.length < ARMOR - 1) {  // header + ARMOR-2 data rows:
  pit.data.push(['ballast', 'pid-ballast-b', 'x',  // next append lands
    '2026-01-01T00:00:00.000Z']);                  // on the LAST
}                                                  // armored row
st = call({ action: 'bid', aname: 'pit', uname: 'penult',
            pid: pid('pit', 'penult'), bid: 'fits',
            deviceID: 'd-pit' });
ok(!st.error && pit.data.length === ARMOR,
   'the last armored row still accepts a bid: ' + st.error);
st = call({ action: 'bid', aname: 'pit', uname: 'over',
            pid: pid('pit', 'over'), bid: 'spills',
            deviceID: 'd-pit2' });
ok(ARMOR_COPY !== null && String(st.error) === ARMOR_COPY('bids')
   && pit.data.length === ARMOR
   && !call({ action: 'state', aname: 'pit' }).bidders
        .some((b) => b.pid === pid('pit', 'over')),
   'one row past the armor refuses loudly, and no bid row lands: '
     + st.error);
ok(typeof ctx.armThePit === 'function',
   'armThePit exists: the run-once migration for live tabs armored'
   + ' under the old 1000-row scheme');
ctx.armThePit();
ok(ss.sheets['users'].plainTextRows >= ARMOR
   && ss.sheets['auctions'].plainTextRows >= ARMOR,
   're-arming live tabs in place reaches full armor depth');

// 16. THE STORAGE FENCE: everything Sheets-flavored lives in the
//     storage layer; below its fence line the business logic speaks
//     only records and indexes. Mechanically enforced — like the
//     freeze doctrine — so a future switch to a real database stays
//     a one-section rewrite instead of an archaeology dig.
const FENCE = 'END OF THE SHEETS LAYER';
const fenceAt = CODE_GS.indexOf(FENCE);
const business = CODE_GS.slice(fenceAt);
const SHEETY = ['SpreadsheetApp', 'openById', 'getSheetByName',
  'insertSheet', 'deleteSheet', 'getRange', 'getDataRange',
  'appendRow', 'deleteRow', 'insertRows', 'deleteRows', 'getMaxRows',
  'setValue', 'setNumberFormat', 'setFont', 'setBackground',
  'setFrozenRows', 'ssMemo', 'sheetMemo', 'rowsMemo'];
ok(fenceAt !== -1 && SHEETY.every((w) => !business.includes(w)),
   'no Sheets vocabulary below the storage fence; leaked: '
     + SHEETY.filter((w) => business.includes(w)).join(', '));

console.log('gas-quals: all ' + passed + ' assertions passed');
