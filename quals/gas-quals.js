// Quals for apps-script/Code.gs: stub the Apps Script services
// (SpreadsheetApp/LockService/ContentService) with an in-memory fake
// spreadsheet, load Code.gs, and run the API through its paces.
//
// Run: node quals/gas-quals.js
'use strict';

const ctx = require('./fake-gas')();
const ss = ctx.__ss;
const call = (req) => ctx.handle(req);

// Server microcopy DERIVED from Code.gs's block (read back out of the
// vm context hosting it), so copy edits there never break these quals
// — they pin the right words in the right place, not the wording
const COPY = require('vm').runInContext('({ gavelFellCopy,'
  + ' simulEditsCopy, seatHeldCopy, bidSeatHeldCopy, unknownActionCopy,'
  + ' mysteryDeviceCopy, schemaDriftCopy, renameClosedCopy })', ctx);
// Real Apps Script resets globals every execution; one shared vm
// context hosts the whole qual run, so drift quals empty the
// header-check memo by hand to simulate a fresh execution
const resetTabMemo = () => require('vm').runInContext(
  'Object.keys(tabsChecked).forEach((k) => delete tabsChecked[k])', ctx);

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
ok(ss.sheets['bids'].data[0][6] === "IT'S CHEATING TO LOOK HERE DURING AN AUCTION"
   && ss.sheets['bids'].data[0][7] === undefined
   && ss.sheets['auctions'].data[0].length === 6,
   'cheater banner right after the bids headers; none on auctions');
ok(ss.sheets['bids'].colors['2,3'] === '#ffffff',
   'sealed bid painted white-on-white');
ok(ss.sheets['bids'].fonts['1,1'] === 'Roboto Mono'
   && ss.sheets['bids'].backgrounds['1,1'] !== undefined,
   'headers dressed up: monospace labels on a tinted band');

// 4. re-bid overwrites, doesn't duplicate, bumps tmod + bcount
const stamp1 = st.bidders[0].tmod;
const t0 = Date.now(); while (Date.now() - t0 < 3);  // ensure stamps differ
st = call({ action: 'bid', aname: 'tau', uname: 'alice', bid: 'sushi' });
ok(st.bidders[0].tmod !== stamp1, 're-bid bumps the tmod stamp');
ok(st.bidders[0].tini === stamp1,
   're-bid keeps the tini stamp (first submission time survives)');
ok(st.bidders[0].bcount === 2, 're-submission counts 2');
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
ok(String(st.error) === COPY.renameClosedCopy
   && call({ action: 'state', aname: 'tau' }).roster.includes('alice')
   && call({ action: 'state', aname: 'tau' }).bids
        .some((b) => b.uname === 'alice'),
   'names freeze at the gavel too (dreev 2026-07-17, reversing'
   + ' always-editable: a post-close rename could swap around who bid'
   + " what): refused, and alice's bid stays alice's");
// (2026-07-16, per dreev: the roster is CLOSED once revealed — adds
// refuse rather than merely not-resealing)
st = call({ action: 'add', aname: 'tau', uname: 'zed' });
ok(st.error && !call({ action: 'state', aname: 'tau' })
     .roster.includes('zed'),
   'adding a participant after the reveal is refused: game over');
ok(ss.sheets['bids'].colors['2,3'] === null,
   'bids stay visible in the sheet after the latch');
st = call({ action: 'remove', aname: 'tau', uname: 'bob' });
ok(st.revealed === true, 'no roster change whatsoever can reseal');
ok(!st.roster.includes('bob'), 'removed seat is gone');

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

console.log('gas-quals: all ' + passed + ' assertions passed');
