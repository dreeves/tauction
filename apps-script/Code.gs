// Tauction API — Google Apps Script web app fronting the spreadsheet.
//
// Vocabulary: "aname" = an auction's name, which is also its URL slug;
// "uname" = a bidder's username, shown with an @ in the UI.
//
// Deploying: `npm run deploy` from the repo (clasp). Manual fallback:
// paste into the sheet's Apps Script editor, then Deploy -> Manage
// deployments -> pencil -> Version: New version. The /exec URL never
// changes either way.

const SHEET_ID = '1hclphAZ3zQIq14Nip1ZxTDSoE9ygXqAv27RwP1hiMA8';

// Column vocabulary (dreev's): tini = time-initial (created), tmod =
// time-modified, tfin = time-final (the reveal moment), tbid = a
// submission's moment, deviceID = the claiming browser's anonymous
// uuid, deviceBlurb = its self-description ("a Mac (Chrome)").
//
// THE PID: a person id, a uuid minted client-side at add-time.
// The pid IS the identity — seats, bids, claims, and the client's
// memory all key on it — and the uname is just its display label, so
// renames are one-cell label edits: no bid re-keying, no client
// rename transactions, no orphaned identities.
const AUCTIONS_HEAD = ['aname', 'tini', 'tmod', 'tfin', 'blurb',
                       'blurbver'];
// The bids tab is an append-only LOG: every submission is its own
// row, nothing is ever overwritten, and the payload's tini/tmod/
// bcount are DERIVED
const BIDS_HEAD     = ['aname', 'pid', 'bid', 'tbid'];
// A users row IS a roster seat, and every seat is live: removing a
// bidless person deletes their row outright, and a person who HAS
// bid cannot be removed at all (a sealed bid is never deletable, so
// it can never be orphaned; the straggler you ex to end early is
// bidless by definition). Future per-person
// attributes (weights/shares) append as columns to the right.
const USERS_HEAD    = ['aname', 'pid', 'uname', 'deviceID',
                       'deviceBlurb', 'tini', 'tmod'];

// Every cell that will ever hold data is armored plain-text at tab
// creation: Sheets otherwise reinterprets writes ("007" -> 7, "3/4"
// -> March 4th — silent sealed-bid corruption), and rows born when
// appendRow grows the grid DON'T inherit the armor, bounded or
// whole-column. So the grid is
// pre-grown and armored ARMOR_ROWS deep up front, and insert()
// refuses loudly past that.
const ARMOR_ROWS = 10000;

// Microcopy (the server half of stringles.js): everything user-visible
// that this file generates. Throw strings land verbatim in the client's
// error banner. stringles.js can't be shared across the deployment
// boundary, so this block mirrors its role — edit copy here as freely.
// The ERROR-numbered prefixes are for greppability.
const badAnameCopy = 'auction name must be alphanumeric';
const badUnameCopy = 'username must be alphanumeric and start with a letter';
// The name-length refusals (dreev's copy). Must match stringles.js anameTooLongBanner /
// unameTooLongBanner EXACTLY (quals check): the client refuses
// before the wire in the same words, so local and server refusals
// read as one message.
const anameTooLongCopy = 'Auction name too long (max 20 characters)';
const unameTooLongCopy = 'Name too long (max 20 characters)';
const badDeviceCopy = 'bad deviceID';
const badDevBlurbCopy = 'bad deviceBlurb';
const unknownActionCopy = (action) => 'unknown action: ' + action;
const notReadyCopy = 'not ready to reveal: everyone on the roster'
  + ' (at least two people) must bid first';
// (dreev's copy; must match stringles.js
// blurbTooLongBanner exactly, like its two name siblings)
const blurbTooLongCopy = 'Description too long (max 2000 characters)';
// the edit-war refusal's ONE home: the compare-and-swap refuses at
// save time (the wikis' mid-air-collision convention) and the client
// banners these words verbatim
const simulEditsCopy =
  'Edit war! Copy your changes elsewhere for safekeeping and reload the page';
const rosterClosedCopy = 'Auction complete — no new participants';
const nameTakenCopy = 'That name is taken';
// the frozen-record refusal (dreev's copy): renames, claims, and
// releases all bounce off it once the auction closes
const auctionClosedCopy = 'Auction closed, no editing';
const noSuchOneCopy = (pid) => 'No such participant: ' + pid;
const badPidCopy = 'bad pid';
const claimNeedsDeviceCopy = 'ERROR1303: claim requires a deviceID';
const releaseNeedsDeviceCopy = 'ERROR1305: release requires a deviceID';
const notYourSeatCopy = 'ERROR1306: Can this error ever happen?'
  + ' Disclaiming yourself as a participant failed?';
const emptyBidCopy = 'Bid is empty';
const bidTooLongCopy = 'bid too long (160 characters max)';
const gavelFellCopy =
  'Womp Womp! The auction closed before your bid got through';
// the bid-hijack refusal (dreev's copy): names the holder's rig and
// the seat's label
const bidSeatHeldCopy = (blurb, uname) =>
  'Someone else (' + blurb + ') already placed a bid as ' + uname + '!';
// operator-facing, like schemaDriftCopy: a closed auction violating
// the covenant (revealed ⇒ roster of two-plus, all with bids) was
// edited by hand or written by pre-freeze code — refuse to render
// nonsense (dreev's test0916: revealed, solo bidless roster)
const covenantCopy = (aname, why) =>
  'closed-state covenant broken for "' + aname + '": ' + why
  + ' — fix or delete its sheet rows';
// operator-facing (dreev sees this, users only if very unlucky): the
// sheet's tabs predate the running code's schema
// operator-facing, like schemaDriftCopy: a write aimed at a row a
// hand-edit deleted (the auction's sibling rows survive it)
const patchGhostCopy = (kind) =>
  'no "' + kind + '" row to write: the sheet was hand-edited out'
  + ' from under this auction — fix or delete its sibling rows';
const schemaDriftCopy = (name, got, want) =>
  'schema drift: the "' + name + '" tab\'s headers are [' + got
  + '] but this code expects [' + want + '] — rename the tab for'
  + ' posterity (or delete it) and retry: the script rebuilds it fresh';
// a holder whose claim carried no self-description (must match
// stringles.js mysteryDevice: it's the same rig-naming fallback)
const mysteryDeviceCopy = 'mystery device';
// removing someone who has already bid is refused (reachable only by
// losing a race: the UI grays that × up front).
const removeBidderCopy = 'Too late to remove, bid sealed';
// operator-facing, like schemaDriftCopy: an append one row past the
// pre-armored grid refuses rather than let Sheets silently
// reinterpret what lands there
const armorFullCopy = (name) =>
  'the "' + name + '" tab outgrew its plain-text armor (' + ARMOR_ROWS
  + ' rows): raise ARMOR_ROWS, deploy, and run armThePit()';

function doGet(e) {
  return respond(handle((e && e.parameter) || {}));
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); }
  catch (err) { return respond({ error: 'request body is not valid JSON' }); }
  return respond(handle(req));
}

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function handle(req) {
  try {
    switch (req.action) {
      case 'state':    return getState(cleanAname(req.aname));
      case 'bid':      return withLock(() => placeBid(req));
      case 'claim':    return withLock(() => saveClaim(req));
      case 'release':  return withLock(() => releaseClaim(req));
      case 'describe': return withLock(() => describe(req));
      case 'add':      return withLock(() => addParticipant(req));
      case 'remove':   return withLock(() => removeParticipant(req));
      case 'rename':   return withLock(() => renameParticipant(req));
      case 'reveal':   return withLock(() => reveal(req));
      case undefined:  return { ok: 'tauction API is live',
                                try: '?action=state&aname=tau' };
      default:         return { error: unknownActionCopy(req.action) };
    }
  } catch (err) {
    return { error: String(err) };
  }
}

// Platform mutual exclusion (LockService is Apps Script's; a real
// database would bring its own transactions — this is the storage
// layer's one out-of-section sibling). Reads run UNLOCKED, by
// choice: a state GET between a multi-write op's rows can see a
// transient half-picture (e.g. one device on two seats for a poll
// tick) — the next poll heals it, and serializing reads would put
// every 5s poll through the lock queue.
function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ---------------------------- validation ------------------------------ */

function cleanAname(s) {
  s = String(s || '').toLowerCase();
  // length first, for the specific words (20 max)
  if (s.length > 20) throw anameTooLongCopy;
  if (!/^[a-z0-9]{1,20}$/.test(s)) throw badAnameCopy;
  return s;
}

function cleanUname(s) {
  s = String(s || '').toLowerCase();
  if (s.length > 20) throw unameTooLongCopy;
  if (!/^[a-z][a-z0-9]{0,19}$/.test(s)) {
    throw badUnameCopy;
  }
  return s;
}

// A deviceID is a client-minted uuid; empty means "release the claim"
function cleanDeviceID(s) {
  s = String(s == null ? '' : s);
  if (!/^[a-z0-9-]{0,64}$/.test(s)) throw badDeviceCopy;
  return s;
}

// A pid is a client-minted uuid: the person's identity, forever
function cleanPid(s) {
  s = String(s == null ? '' : s);
  if (!/^[a-z0-9-]{8,64}$/.test(s)) throw badPidCopy;
  return s;
}

// The claimant's self-reported rig ("a Mac (Chrome)") — decoration for
// the who-claimed-this tooltip, printable ASCII only. (Apps Script web
// apps can't read request headers, so the client must tell us; honor
// system, like everything.)
function cleanBlurb(s) {
  s = String(s == null ? '' : s);
  if (!/^[ -~]{0,64}$/.test(s)) throw badDevBlurbCopy;
  return s;
}

/* ======================= the sheets storage layer ======================
   Everything Google-Sheets-specific lives in this section, behind the
   fence line at its end — the business logic below the fence speaks
   only in RECORDS (rows zipped with their tab's header: {aname: ...,
   uname: ..., all strings}) and 0-based record indexes. Switching to
   a real database later means rewriting this section (plus withLock,
   its platform sibling above): load / insert / patch / erase per
   table, and the two sheet-cosmetic seal calls, which a database
   would simply no-op. A qual holds the fence.
   ===================================================================== */

const TABS = { auctions: AUCTIONS_HEAD, bids: BIDS_HEAD,
               users: USERS_HEAD };
// the bids tab is where peeking would spoil the sealing; warn there only
const TAB_WARNINGS =
  { bids: "IT'S CHEATING TO LOOK HERE DURING AN AUCTION" };

// Per-execution memos (globals reset each Apps Script execution).
// Every Sheets service call costs ~50-150ms and the script lock is
// held for the whole parade, so the call count IS the latency: one
// spreadsheet handle, one header-checked Sheet per tab, one data
// read per tab per request. Within a locked execution nothing else
// can write the sheet, so a first read is good for the whole
// request; wrote() drops a tab's records after a value write. The
// budget quals pin the per-action call counts.
let ssMemo = null;
const sheetMemo = {};
const rowsMemo = {};

function tab(kind) {
  if (sheetMemo[kind] !== undefined) return sheetMemo[kind];
  if (ssMemo === null) ssMemo = SpreadsheetApp.openById(SHEET_ID);
  const headers = TABS[kind];
  let sh = ssMemo.getSheetByName(kind);
  if (sh) {
    // The header row IS the schema. Everything reads positionally, so
    // a drifted tab would misread every row — refuse loudly
    // instead. Only the first headers.length cells count: columns
    // appended to the right (and the cheater banner) are legal.
    const got = sh.getRange(1, 1, 1, headers.length).getValues()[0]
      .map(String);
    if (!headers.every((h, i) => got[i] === h)) {
      throw schemaDriftCopy(kind, got.join(', '), headers.join(', '));
    }
  } else {
    sh = ssMemo.insertSheet(kind);
    // Pre-grow the grid and lay the plain-text armor down whole (see
    // ARMOR_ROWS): newborn grid rows don't inherit it, so it must be
    // there before the data ever arrives
    if (sh.getMaxRows() < ARMOR_ROWS) {
      sh.insertRowsAfter(sh.getMaxRows(), ARMOR_ROWS - sh.getMaxRows());
    }
    sh.getRange(1, 1, ARMOR_ROWS, headers.length).setNumberFormat('@');
    // headers: bold monospace on a quiet tinted band, frozen in place
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setFontFamily('Roboto Mono')
      .setBackground('#f1f3f4');
    sh.setFrozenRows(1);
    if (TAB_WARNINGS[kind]) {
      sh.getRange(1, headers.length + 1).setValue(TAB_WARNINGS[kind])
        .setFontSize(24).setFontWeight('bold').setFontColor('#b3261e');
    }
  }
  sheetMemo[kind] = sh;
  return sh;
}

// A tab's data rows as records — each row zipped with the schema,
// every value a string; columns appended past the schema are legal
// and simply invisible here. One Sheets read per tab per execution.
function load(kind) {
  if (rowsMemo[kind] === undefined) {
    const head = TABS[kind];
    rowsMemo[kind] = tab(kind).getDataRange().getValues().slice(1)
      .map(r => {
        const rec = {};
        head.forEach((h, c) => { rec[h] = String(r[c]); });
        return rec;
      });
  }
  return rowsMemo[kind];
}

// Call after any VALUE write to a tab: the next load() re-reads it.
// (Format-only writes — the seal paint — change nothing load() sees.)
function wrote(kind) { delete rowsMemo[kind]; }

// Append a record inside the armor or refuse LOUDLY: a row born past
// the plain-text armor gets silently reinterpreted by Sheets
// ("007" -> 7), and for sealed bids silent is the worst kind. Fields
// left out land as ''. Returns the new record's index. Costs no
// extra service calls: the row count comes from the memoized read.
// insert()'s armor check, askable up front (see placeBid: no
// partial writes)
function assertRoom(kind) {
  if (load(kind).length + 2 > ARMOR_ROWS) throw armorFullCopy(kind);
}

function insert(kind, rec) {
  const i = load(kind).length;
  if (i + 2 > ARMOR_ROWS) throw armorFullCopy(kind);
  tab(kind).appendRow(TABS[kind].map(
    h => rec[h] === undefined ? '' : rec[h]));
  wrote(kind);
  return i;
}

// Overwrite named fields of record i, as ONE ranged write: untouched
// columns inside the span are rewritten with their current values
// (safe under the lock), so a patch never costs more than a cell poke
function patch(kind, i, changes) {
  // a hand-gutted sheet hands findIndex a -1, and row -1+2 is the
  // HEADER —
  // refuse at the chokepoint, operator-facing like schemaDriftCopy
  if (i < 0) throw patchGhostCopy(kind);
  const head = TABS[kind];
  const cols = Object.keys(changes).map(f => head.indexOf(f));
  if (cols.some(c => c === -1)) throw 'patch: field not in ' + kind;
  const lo = Math.min(...cols);
  const hi = Math.max(...cols);
  const rec = hi > lo ? load(kind)[i] : null;
  const slab = [];
  for (let c = lo; c <= hi; c++) {
    slab.push(changes[head[c]] === undefined
      ? rec[head[c]] : changes[head[c]]);
  }
  tab(kind).getRange(i + 2, lo + 1, 1, slab.length).setValues([slab]);
  wrote(kind);
}

// Delete record i outright
function erase(kind, i) {
  tab(kind).deleteRow(i + 2);
  wrote(kind);
}

// Sheet-only decoration — a real database would no-op both: sealed
// bid text is white-on-white for anyone peeking at the spreadsheet,
// and the reveal hands the color back
const BID_COL = BIDS_HEAD.indexOf('bid') + 1;
function sealBid(i) {
  tab('bids').getRange(i + 2, BID_COL).setFontColor('#ffffff');
}
function unsealBid(i) {
  tab('bids').getRange(i + 2, BID_COL).setFontColor(null);
}

// Run this once from the Apps Script editor to trigger the permissions
// prompt if you ever set this project up manually (clasp handles it
// otherwise).
function authorize() {
  Logger.log(JSON.stringify(handle({ action: 'state', aname: 'tau' })));
}

// Run ONCE from the editor after deploying the ARMOR_ROWS scheme
// (column armor falls with grid growth, so pre-grown armor it
// is): grows each live tab's grid to ARMOR_ROWS and re-armors it
// in place, data intact. Tabs born under the new tab() never need
// this; it migrates tabs armored shallower than ARMOR_ROWS.
function armThePit() {
  Object.keys(TABS).forEach(function (kind) {
    const sh = tab(kind);
    if (sh.getMaxRows() < ARMOR_ROWS) {
      sh.insertRowsAfter(sh.getMaxRows(), ARMOR_ROWS - sh.getMaxRows());
    }
    sh.getRange(1, 1, ARMOR_ROWS, TABS[kind].length).setNumberFormat('@');
    Logger.log(kind + ': grid grown and armored ' + ARMOR_ROWS
      + ' rows deep');
  });
}

/* ============= END OF THE SHEETS LAYER (the storage fence) =============
   Below this line: business logic only — records in, records out.
   A qual mechanically refuses any Sheets vocabulary past this point.
   ===================================================================== */

/* ------------------------------ actions ------------------------------- */

function getState(aname) {
  const arow = load('auctions').find(r => r.aname === aname);

  // The SEATS are the users rows (in insertion order): pid + display
  // label. The claims map rides along: pid -> deviceID for seats
  // someone holds. Every seat is live — removal deletes, and bidders
  // cannot be removed — so the seats ARE the roster that gates the
  // reveal.
  const seats = [];
  const claims = Object.create(null);
  const blurbs = Object.create(null);  // pid -> the holder's self-reported rig
  load('users').forEach(r => {
    if (r.aname !== aname) return;
    seats.push({ pid: r.pid, uname: r.uname });
    if (r.deviceID) claims[r.pid] = r.deviceID;
    if (r.deviceID && r.deviceBlurb) blurbs[r.pid] = r.deviceBlurb;
  });
  const roster = seats;

  // Reveal is a human act (the 'reveal' action) and a one-way latch: it
  // never happens automatically, and once bids have been seen, nothing can
  // reseal them. A complete roster merely makes the reveal button pressable.
  const tfin = arow ? arow.tfin : '';  // the reveal moment, ISO
  const revealed = tfin !== '';
  const blurb = arow ? arow.blurb : '';    // freeform markdown
  // the blurb's version counter (CAS token AND the pencil tooltip's
  // number): 0 = never described, +1 per committed save. Sheets may
  // hand the cell back as a string; a cell that isn't a whole number
  // is corruption and refuses loudly.
  const blurbver = arow
    ? Number(arow.blurbver === '' ? NaN : arow.blurbver) : 0;
  if (!Number.isInteger(blurbver) || blurbver < 0) {
    throw 'auctions.blurbver corrupt for ' + aname + ': '
      + JSON.stringify(arow && arow.blurbver);
  }

  // A person's standing bid is their LATEST log row at or before tfin
  // (<=, dreev's call: a bid stamped the gavel's own millisecond made
  // it — belt only, since placeBid refuses after the reveal anyway).
  // The payload keeps its vocabulary, derived per person from the log:
  // tini = first tbid, tmod = latest, bcount = row count. ISO stamps
  // compare lexicographically; rows are in submission order.
  const agg = Object.create(null);  // pid -> derived bidder, in first-bid order
  load('bids').forEach(r => {
    if (r.aname !== aname) return;
    if (revealed && r.tbid > tfin) return;  // after the gavel: not in
    const a = agg[r.pid] || (agg[r.pid] =
      { pid: r.pid, bcount: 0, tini: r.tbid });
    a.bcount++;
    a.tmod = r.tbid;
    a.bid = r.bid;
  });
  const people = Object.keys(agg).map(p => agg[p]);
  const bidders = people.map(a =>
    ({ pid: a.pid, bcount: a.bcount, tini: a.tini, tmod: a.tmod }));

  // the closed-state covenant, asserted on every read: a revealed
  // auction has two-plus (uncut) roster seats, every one of them with
  // a bid — forever (the post-close freezes make it eternal)
  if (revealed && !(roster.length >= 2
      && roster.every(s => bidders.some(b => b.pid === s.pid)))) {
    throw covenantCopy(aname, 'roster ['
      + roster.map(s => s.uname).join(', ') + '] but bids only from ['
      + bidders.map(b => b.pid).join(', ') + ']');
  }

  return {
    aname: aname, exists: arow !== undefined,
    seats: seats, bidders: bidders, revealed: revealed,
    tfin: tfin, blurb: blurb, blurbver: blurbver,
    claims: claims, blurbs: blurbs,
    bids: revealed ? people.map(a => ({ pid: a.pid, bid: a.bid }))
                   : null,
  };
}

// This auction's seat record index for a pid (-1 if none)
function seatIndex(aname, pid) {
  return load('users').findIndex(
    r => r.aname === aname && r.pid === pid);
}

// The seat carrying a display label (labels are unique per auction)
function seatByName(aname, uname) {
  return load('users').find(r => r.aname === aname
    && r.uname === uname);
}

// The reveal button. Anyone may press it once the roster is complete —
// at least two people, all with bids in. Idempotent, and permanent.
function reveal(req) {
  const aname = cleanAname(req.aname);
  const st = getState(aname);
  if (st.revealed) return st;  // racing presses: both succeed
  const bidPids = st.bidders.map(b => b.pid);
  if (!(st.seats.length >= 2
        && st.seats.every(s => bidPids.indexOf(s.pid) !== -1))) {
    throw notReadyCopy;
  }
  const i = load('auctions').findIndex(r => r.aname === aname);
  // the revealed column holds the moment itself (legacy rows hold '1')
  patch('auctions', i, { tfin: new Date().toISOString() });
  unmaskBids(aname);
  return getState(aname);
}

// Reveal's unmasking sweep: sealed bids are painted white-on-white as
// they land (see placeBid); the reveal gives every one of this
// auction's its color back. Purely cosmetic — the honor system's
// honor system.
function unmaskBids(aname) {
  load('bids').forEach((r, i) => {
    if (r.aname === aname) unsealBid(i);
  });
}

// Make sure the auction has its row (tini/tmod stamped; tfin empty)
function touchAuction(aname) {
  const now = new Date().toISOString();
  const i = load('auctions').findIndex(r => r.aname === aname);
  // blurbver is born an explicit 0: an empty version cell is never a
  // legitimate spelling (getState refuses it as corruption)
  if (i === -1) {
    insert('auctions', { aname: aname, tini: now, tmod: now, blurbver: 0 });
  } else patch('auctions', i, { tmod: now });
}

// Make sure a seat exists for this pid+label; adding is idempotent
// (labels change only via rename, so an existing pid's seat is left
// exactly as found)
function ensureSeat(aname, pid, uname) {
  const now = new Date().toISOString();
  if (seatIndex(aname, pid) !== -1) return;
  insert('users', { aname: aname, pid: pid, uname: uname,
                    deviceID: '', deviceBlurb: '', tini: now,
                    tmod: now });
}

// The auction blurb: freeform markdown, editable by anyone at any
// time — before or after the close. Concurrent edits are guarded by
// compare-and-swap on blurbver: the request carries the version the
// edit was based on, and a stale base is refused loudly rather than
// silently clobbering someone's words. The version is a plain
// counter — 0 = never described, +1 per committed save, incremented
// under this write lock — so identities can never collide, no clock
// consulted, and the same number is the pencil tooltip's.
function describe(req) {
  const aname = cleanAname(req.aname);
  const blurb = String(req.blurb == null ? '' : req.blurb);
  if (blurb.length > 2000) throw blurbTooLongCopy;
  // the verdict comes BEFORE any write (a refusal must mutate
  // nothing, tmod included) — a missing row reads as the virgin
  // version 0, so a fresh auction's first describe passes
  const current = getState(aname).blurbver;
  // one spelling of virgin: the number 0 (an absent base reads as a
  // legacy caller; '' would coerce to 0 silently, so it may not)
  const base = req.base == null || req.base === ''
    ? NaN : Number(req.base);
  if (base !== current) {
    // the refusal CARRIES the snapshot that refused it — generated
    // under this same write lock — so the client's edit-war diff
    // draws yours-vs-theirs with no second round trip
    const s = getState(aname);
    s.error = simulEditsCopy;
    return s;
  }
  touchAuction(aname);
  const i = load('auctions').findIndex(r => r.aname === aname);
  patch('auctions', i, { blurb: blurb, blurbver: current + 1 });
  return getState(aname);
}

// The roster is CLOSED once revealed: the game is over, and a fresh
// participant could neither bid meaningfully nor be waited on.
// Adding is IDEMPOTENT on the label (dreev's ruling): if the label is already seated — same pid or
// not — the requested goal state holds, so this is success, sans
// writes (not even a tmod bump). The race loser converges as an
// ordinary latecomer: their next snapshot unseats their ghost pid and
// the claimable star is the re-attach affordance. Renames onto a live
// label still refuse: their goal is a CHANGE, which didn't happen.
function addParticipant(req) {
  const aname = cleanAname(req.aname);
  const uname = cleanUname(req.uname);
  const pid = cleanPid(req.pid);
  if (getState(aname).revealed) throw rosterClosedCopy;
  if (seatIndex(aname, pid) === -1 && seatByName(aname, uname)) {
    return getState(aname);  // the label is seated: mission complete
  }
  touchAuction(aname);
  ensureSeat(aname, pid, uname);
  return getState(aname);
}

// Renaming is a LABEL EDIT, nothing more: the pid is the identity,
// so bids, claims, memory, and reveal-gating don't even notice. One
// cell changes. (This one-liner replaced a re-key of the seat AND
// every bid log row AND the client's rename-transaction machinery —
// the whole reason pids exist.) Renaming onto a live label is
// refused.
function renameParticipant(req) {
  const aname = cleanAname(req.aname);
  const pid = cleanPid(req.pid);
  const to = cleanUname(req.to);
  // names freeze at the gavel: a post-close rename could swap
  // around who bid what (dreev's ruling)
  if (getState(aname).revealed) throw auctionClosedCopy;
  const i = seatIndex(aname, pid);
  if (i === -1) throw noSuchOneCopy(pid);
  if (load('users')[i].uname === to) return getState(aname);
  const twin = seatByName(aname, to);
  if (twin && twin.pid !== pid) throw nameTakenCopy;
  patch('users', i, { uname: to, tmod: new Date().toISOString() });
  touchAuction(aname);
  return getState(aname);
}

// Removing DELETES the seat — and is allowed only while they have
// not bid (a sealed
// bid is never deletable, so it must never be orphaned either; the
// straggler you ex to end early is bidless by definition, and the UI
// grays the × on every bid-bearing row, so this refusal is only ever
// reached by losing a race). Absent seat: harmless no-op.
function removeParticipant(req) {
  const aname = cleanAname(req.aname);
  const pid = cleanPid(req.pid);
  // the record freezes at the gavel
  if (getState(aname).revealed) throw auctionClosedCopy;
  const i = seatIndex(aname, pid);
  if (i === -1) return getState(aname);  // absent: a harmless no-op
  if (load('bids').some(r => r.aname === aname && r.pid === pid)) {
    throw removeBidderCopy;
  }
  touchAuction(aname);
  erase('users', i);
  return getState(aname);
}

// Stake a claim on a seat — LAST WRITE WINS (dreev's ruling:
// Safari re-minted her device uuid and her own seat refused her).
// A claim is a consistency marker, not auth: it TAKES the seat, the
// previous holder's page converges at its next poll, and genuine
// seat fights fall to the honor system like every other op.
// Re-claiming your own seat is the idempotent subcase. One name per
// device: claiming a new seat releases any other seat this device
// held, radio-style.
function saveClaim(req) {
  const aname = cleanAname(req.aname);
  const pid = cleanPid(req.pid);
  const deviceID = cleanDeviceID(req.deviceID);
  if (!deviceID) throw claimNeedsDeviceCopy;
  // identity is part of the frozen record, like names and bids: a
  // post-close claim would dress a revealed bid in a stranger's rig
  if (getState(aname).revealed) throw auctionClosedCopy;
  const deviceBlurb = cleanBlurb(req.deviceBlurb);
  if (seatIndex(aname, pid) === -1) throw noSuchOneCopy(pid);
  touchAuction(aname);
  setDeviceID(aname, pid, deviceID, deviceBlurb);
  return getState(aname);
}

// Vacate a seat — only its holder may. An unheld seat releases as a
// no-op: a merely-local soft claim must release without drama.
function releaseClaim(req) {
  const aname = cleanAname(req.aname);
  const pid = cleanPid(req.pid);
  const deviceID = cleanDeviceID(req.deviceID);
  if (!deviceID) throw releaseNeedsDeviceCopy;
  if (getState(aname).revealed) throw auctionClosedCopy;  // frozen too
  const held = deviceOf(aname, pid);
  if (held && held !== deviceID) {
    throw notYourSeatCopy;
  }
  // only an ACTUAL release writes: refused and no-op requests mutate
  // nothing, not even tmod
  if (held) {
    touchAuction(aname);
    setDeviceID(aname, pid, '');
  }
  return getState(aname);
}

// The deviceID currently holding a seat ('' if open or no such seat)
function deviceOf(aname, pid) {
  const i = seatIndex(aname, pid);
  return i === -1 ? '' : load('users')[i].deviceID;
}

function setDeviceID(aname, pid, deviceID, blurb) {
  const now = new Date().toISOString();
  load('users').forEach((r, i) => {
    if (r.aname !== aname) return;
    if (r.pid === pid) {
      patch('users', i, { deviceID: deviceID,
                          deviceBlurb: blurb || '', tmod: now });
    } else if (deviceID && r.deviceID === deviceID) {
      patch('users', i, { deviceID: '', deviceBlurb: '', tmod: now });
    }
  });
}

// The holder's rig, for refusal messages: every seat-taken error names
// who beat you to it
function holderBlurb(aname, pid) {
  const i = seatIndex(aname, pid);
  const blurb = i === -1 ? '' : load('users')[i].deviceBlurb;
  return blurb || mysteryDeviceCopy;
}

function placeBid(req) {
  const aname = cleanAname(req.aname);
  const pid = cleanPid(req.pid);
  const uname = cleanUname(req.uname);  // the label, for walk-on seats
  const bid = String(req.bid == null ? '' : req.bid).trim();
  if (!bid) throw emptyBidCopy;
  if (bid.length > 160) throw bidTooLongCopy;
  // The gavel drop is a bright line: no bid lands after tfin. This is
  // also the explicit loss notice for an under-the-wire revision that
  // arrived a beat too late.
  if (getState(aname).revealed) {
    throw gavelFellCopy;
  }
  const deviceID = req.deviceID === undefined ? ''
    : cleanDeviceID(req.deviceID);
  const deviceBlurb = cleanBlurb(req.deviceBlurb);
  const held = deviceOf(aname, pid);

  // bidding claims a roster seat: your own bid must never read as
  // not-counting (a bid rebuilds its seat if a raced removal took
  // it). A WALK-ON bid (no seat for this pid yet) whose label is
  // already seated under someone else's pid is a doppelganger,
  // refused.
  // Bidding as someone is claiming to be them, and claims are first
  // come, first served: a bid may not touch a seat someone else holds.
  // Old clients carry no deviceID and count as nobody — fine on an
  // open seat, refused on a held one.
  if (held && held !== deviceID) {
    throw bidSeatHeldCopy(holderBlurb(aname, pid), uname);
  }
  const twin = seatByName(aname, uname);
  if (seatIndex(aname, pid) === -1 && twin && twin.pid !== pid) {
    throw nameTakenCopy;
  }
  // no partial writes: every row this bid may append is capacity-
  // checked BEFORE the first one lands (a refusal must not leave a
  // half-created seat)
  assertRoom('bids');
  if (seatIndex(aname, pid) === -1) assertRoom('users');
  touchAuction(aname);
  ensureSeat(aname, pid, uname);
  if (deviceID) {
    setDeviceID(aname, pid, deviceID, deviceBlurb);
  }

  // every submission is its own log row; the read side derives the
  // rest (latest wins, first stamps tini, count counts)
  const at = insert('bids', { aname: aname, pid: pid, bid: bid,
                              tbid: new Date().toISOString() });
  // seal THIS submission white-on-white as it lands — one write, not
  // a repaint of the whole pile (its elders were sealed at their own
  // appends; reveal() unmasks the lot)
  sealBid(at);
  return getState(aname);
}
