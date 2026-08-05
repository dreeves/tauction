// Tauction API — Google Apps Script web app fronting the spreadsheet.
//
// Vocabulary: "slug" = an auction's name, which is also its URL slug;
// "uname" = a bidder's username, shown with an @ in the UI.
//
// Deploying: `npm run deploy` from the repo (clasp). Manual fallback:
// paste into the sheet's Apps Script editor, then Deploy -> Manage
// deployments -> pencil -> Version: New version. The /exec URL never
// changes either way.

const SHEET_ID = '1hclphAZ3zQIq14Nip1ZxTDSoE9ygXqAv27RwP1hiMA8';

// Column vocabulary (dreev's): tini = time-initial (created), tmod =
// time-modified, tfin = time-final (the reveal moment), tbid = a
// submission's moment, devid = a browser's anonymous uuid.
//
// THE USERID: a person id, a uuid minted client-side at add-time.
// The userid IS the identity — seats, bids, claims, and the client's
// memory all key on it — and the uname is just its display label, so
// renames are one-cell label edits: no bid re-keying, no client
// rename transactions, no orphaned identities.
const AUCTIONS_HEAD = ['slug', 'tini', 'tfin', 'blurb', 'bver',
                       'tbed'];
// The bids tab is an append-only LOG: every submission is its own
// row, nothing is ever overwritten, and the payload's tini/tmod/
// bcount are DERIVED
const BIDS_HEAD     = ['slug', 'userid', 'bid', 'tbid',
                       'devid'];
// A users row IS a roster seat, and every seat is live: removing a
// bidless person deletes their row outright, and a person who HAS
// bid cannot be removed at all (a sealed bid is never deletable, so
// it can never be orphaned; the straggler you ex to end early is
// bidless by definition). Future per-person
// attributes (weights/shares) append as columns to the right.
const SEATS_HEAD    = ['slug', 'userid', 'uname', 'devid',
                       'tini', 'tmod'];

// THE DEVICES TABLE (dreev 2026-08-02): one row per device ever
// seen, the rig self-description's ONE home ("Mac Chrome in
// Portland, OR"). Everything else stores devid REFERENCES and
// getState joins. Rows are written devices-FIRST — touchDevice
// before any write that references the device — so a dangling
// reference can never be minted.
// blug/bluid/tblug are the device's EDITING-PRESENCE
// slot (per-device, so a whole desk crowd can show at once): which
// auction's blurb this device has open, as whom ('' = walk-in), and
// the latest heartbeat. Ephemeral by TTL — see noteEditing.
const DEVICES_HEAD  = ['devid', 'rig', 'tini', 'tmod',
                       'blug', 'bluid', 'tblug'];

// Every cell that will ever hold data is armored plain-text at tab
// creation: Sheets otherwise reinterprets writes ("007" -> 7, "3/4"
// -> March 4th — silent sealed-bid corruption), and rows born when
// appendRow grows the grid DON'T inherit the armor, bounded or
// whole-column. So the grid is
// pre-grown and armored ARMOR_ROWS deep up front, and insert()
// refuses loudly past that.
const ARMOR_ROWS = 10000;

// Operator diagnostics — the error channel's only English. The
// server's deliberate REFUSALS are thrown as { code, ...args }
// objects and stringles.js's refusalCopy renders the words
// client-side (a qual pins the two vocabularies equal, both
// directions). What remains below is the assert family: the sheet or
// the deploy is broken, and the words are marching orders that must
// stay readable raw — in a terminal (deploy.js, live-quals), the
// execution log, or a curl. (Off the error channel this file still
// generates two English strings, untouched by the codes rework: the
// bids tab's cheater banner and the root liveness response.)
// operator-facing, like schemaDriftCopy: a closed auction violating
// the covenant (revealed ⇒ roster of two-plus, all with bids) was
// edited by hand or written by pre-freeze code — refuse to render
// nonsense (dreev's test0916: revealed, solo bidless roster)
const covenantCopy = (slug, why) =>
  'closed-state covenant broken for "' + slug + '": ' + why
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
  catch (err) { return respond({ error: { code: 'badJson' } }); }
  return respond(handle(req));
}

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function handle(req) {
  try {
    switch (req.action) {
      case 'state':    return getState(cleanSlug(req.slug));
      case 'bid':      return withLock(() => placeBid(req));
      case 'claim':    return withLock(() => saveClaim(req));
      case 'release':  return withLock(() => releaseClaim(req));
      case 'describe': return withLock(() => describe(req));
      case 'editing':  return withLock(() => noteEditing(req));
      case 'add':      return withLock(() => addParticipant(req));
      case 'remove':   return withLock(() => removeParticipant(req));
      case 'rename':   return withLock(() => renameParticipant(req));
      case 'reveal':   return withLock(() => reveal(req));
      case undefined:  return { ok: 'tauction API is live',
                                try: '?action=state&slug=tau' };
      default:         return { error: { code: 'unknownAction',
                                         action: req.action } };
    }
  } catch (err) {
    // refusals are { code, ...args } objects, passed through for the
    // client to render; anything else (assert-family diagnostics,
    // genuine crashes) is finished text, stringified verbatim
    return { error: (err && err.code) ? err : String(err) };
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

function cleanSlug(s) {
  s = String(s || '').toLowerCase();
  // length first, for the specific words (20 max)
  if (s.length > 20) throw { code: 'slugTooLong' };
  if (!/^[a-z0-9]{1,20}$/.test(s)) throw { code: 'badSlug' };
  return s;
}

function cleanUname(s) {
  s = String(s || '').toLowerCase();
  if (s.length > 20) throw { code: 'unameTooLong' };
  if (!/^[a-z][a-z0-9]{0,19}$/.test(s)) {
    throw { code: 'badUname' };
  }
  return s;
}

// A devid is a client-minted uuid; empty means "release the claim"
function cleanDevid(s) {
  s = String(s == null ? '' : s);
  if (!/^[a-z0-9-]{0,64}$/.test(s)) throw { code: 'badDevid' };
  return s;
}

// A userid is a client-minted uuid: the person's identity, forever
function cleanUserid(s) {
  s = String(s == null ? '' : s);
  if (!/^[a-z0-9-]{8,64}$/.test(s)) throw { code: 'badUserid' };
  return s;
}

// The claimant's self-reported rig ("a Mac (Chrome)") — decoration for
// the who-claimed-this tooltip, printable ASCII only. (Apps Script web
// apps can't read request headers, so the client must tell us; honor
// system, like everything.)
function cleanRig(s) {
  s = String(s == null ? '' : s);
  if (!/^[ -~]{0,64}$/.test(s)) throw { code: 'badRig' };
  return s;
}

/* ======================= the sheets storage layer ======================
   Everything Google-Sheets-specific lives in this section, behind the
   fence line at its end — the business logic below the fence speaks
   only in RECORDS (rows zipped with their tab's header: {slug: ...,
   uname: ..., all strings}) and 0-based record indexes. Switching to
   a real database later means rewriting this section (plus withLock,
   its platform sibling above): load / insert / patch / erase per
   table, and the two sheet-cosmetic seal calls, which a database
   would simply no-op. A qual holds the fence.
   ===================================================================== */

const TABS = { auctions: AUCTIONS_HEAD, bids: BIDS_HEAD,
               seats: SEATS_HEAD, devices: DEVICES_HEAD };
// the bids tab is where peeking would spoil the sealing; warn there only
const TAB_WARNINGS =
  { bids: "IT'S CHEATING TO LOOK HERE DURING AN AUCTION" };

// Per-execution memos (globals reset each Apps Script execution).
// Every Sheets service call costs ~50-150ms and the script lock is
// held for the whole parade, so the call count IS the latency: one
// spreadsheet handle, one Sheet handle per tab, and ONE values read
// for the whole database (loadAll's batchGet). Within a locked
// execution nothing else can write the sheet, so a batch is good
// until wrote() drops a tab's records after a value write — the next
// load() then re-batches everything, same one-call price. The budget
// quals pin the per-action call counts.
let ssMemo = null;
const sheetMemo = {};
const rowsMemo = {};

// The write-side Sheet handle; creates (and armors) a missing tab.
// Header verification lives in loadAll, read-side, free from the
// batch payload.
function tab(kind) {
  if (sheetMemo[kind] !== undefined) return sheetMemo[kind];
  if (ssMemo === null) ssMemo = SpreadsheetApp.openById(SHEET_ID);
  const headers = TABS[kind];
  let sh = ssMemo.getSheetByName(kind);
  if (!sh) {
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

// ONE metered read for the whole database: every tab's values in a
// single batchGet (Advanced Sheets Service, enabled in the
// manifest), refreshing every tab's records together. The header row
// IS the schema, checked here from the same payload: everything
// reads positionally, so a drifted tab would misread every row —
// refuse loudly instead. Only the first headers.length cells count:
// columns appended to the right (and the cheater banner) are legal.
// (The values API trims trailing empty cells, hence the undefined
// guard: a short row's missing cells are ''.)
function loadAll() {
  Object.keys(TABS).forEach(tab);  // every tab exists before we ask
  // SpreadsheetApp writes are BUFFERED, and the values API reads the
  // backend over REST where unflushed writes don't exist yet (the
  // live smoke caught a fresh claim missing from its own response).
  // The flush is the write barrier; the fake refuses a batchGet
  // without it.
  SpreadsheetApp.flush();
  const got = Sheets.Spreadsheets.Values.batchGet(SHEET_ID,
    { ranges: Object.keys(TABS) }).valueRanges;
  Object.keys(TABS).forEach((kind, i) => {
    const rows = got[i].values || [[]];  // a blank tab omits values
    const headers = TABS[kind];
    const head = (rows[0] || []).slice(0, headers.length).map(String);
    if (!headers.every((h, j) => head[j] === h)) {
      throw schemaDriftCopy(kind, head.join(', '),
                            headers.join(', '));
    }
    rowsMemo[kind] = rows.slice(1).map(r => {
      const rec = {};
      headers.forEach((h, c) => {
        rec[h] = String(r[c] === undefined ? '' : r[c]);
      });
      return rec;
    });
  });
}

// A tab's data rows as records — each row zipped with the schema,
// every value a string; columns appended past the schema are legal
// and simply invisible here.
function load(kind) {
  if (rowsMemo[kind] === undefined) loadAll();
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
  Logger.log(JSON.stringify(handle({ action: 'state', slug: 'tau' })));
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

function getState(slug) {
  const arow = load('auctions').find(r => r.slug === slug);

  // The SEATS are the users rows (in insertion order): userid + display
  // label. The claims map rides along: userid -> devid for seats
  // someone holds. Every seat is live — removal deletes, and bidders
  // cannot be removed — so the seats ARE the roster that gates the
  // reveal.
  // the devices join: devid -> its one self-description row
  const rigOf = Object.create(null);
  load('devices').forEach(r => {
    if (r.rig) rigOf[r.devid] = r.rig;
  });
  const seats = [];
  const claims = Object.create(null);
  const rigs = Object.create(null);  // userid -> the holder's rig
  load('seats').forEach(r => {
    if (r.slug !== slug) return;
    seats.push({ userid: r.userid, uname: r.uname });
    if (r.devid) claims[r.userid] = r.devid;
    if (r.devid && rigOf[r.devid]) rigs[r.userid] = rigOf[r.devid];
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
  const bver = arow
    ? Number(arow.bver === '' ? NaN : arow.bver) : 0;
  if (!Number.isInteger(bver) || bver < 0) {
    throw 'auctions.bver corrupt for ' + slug + ': '
      + JSON.stringify(arow && arow.bver);
  }
  // the desk crowd: every device whose editing slot points here and
  // whose last heartbeat is fresh (both stamps are this server's
  // clock — no skew); a vanished editor ages out right here, no
  // sweeper needed
  const editors = [];
  load('devices').forEach(r => {
    if (r.blug === slug && r.tblug
        && Date.now() - new Date(r.tblug).getTime() < EDITOR_TTL_MS) {
      editors.push({ userid: r.bluid, devid: r.devid,
                     rig: r.rig });
    }
  });

  // A person's standing bid is their LATEST log row at or before tfin
  // (<=, dreev's call: a bid stamped the gavel's own millisecond made
  // it — belt only, since placeBid refuses after the reveal anyway).
  // The payload keeps its vocabulary, derived per person from the log:
  // tini = first tbid, tmod = latest, bcount = row count. ISO stamps
  // compare lexicographically; rows are in submission order.
  const agg = Object.create(null);  // userid -> derived bidder, in first-bid order
  const stamps = Object.create(null);  // tbid forgery tripwire
  load('bids').forEach(r => {
    if (r.slug !== slug) return;
    // placeBid mints tbid strictly increasing per auction, so a
    // duplicate can only be a hand-edited log: refuse to render it
    if (stamps[r.tbid]) {
      throw 'duplicate tbid in "' + slug + '": ' + r.tbid
        + ' — the bids log was hand-edited; fix or delete the rows';
    }
    stamps[r.tbid] = true;
    if (revealed && r.tbid > tfin) return;  // after the gavel: not in
    const a = agg[r.userid] || (agg[r.userid] =
      { userid: r.userid, bcount: 0, tini: r.tbid });
    a.bcount++;
    a.tmod = r.tbid;
    a.bid = r.bid;
  });
  const people = Object.keys(agg).map(p => agg[p]);
  const bidders = people.map(a =>
    ({ userid: a.userid, bcount: a.bcount, tini: a.tini, tmod: a.tmod }));

  // the closed-state covenant, asserted on every read: a revealed
  // auction has two-plus (uncut) roster seats, every one of them with
  // a bid — forever (the post-close freezes make it eternal)
  if (revealed && !(roster.length >= 2
      && roster.every(s => bidders.some(b => b.userid === s.userid)))) {
    throw covenantCopy(slug, 'roster ['
      + roster.map(s => s.uname).join(', ') + '] but bids only from ['
      + bidders.map(b => b.userid).join(', ') + ']');
  }

  return {
    slug: slug, exists: arow !== undefined,
    seats: seats, bidders: bidders, revealed: revealed,
    tfin: tfin, blurb: blurb, bver: bver, editors: editors,
    claims: claims, rigs: rigs,
    bids: revealed ? people.map(a => ({ userid: a.userid, bid: a.bid }))
                   : null,
  };
}

// This auction's seat record index for a userid (-1 if none)
function seatIndex(slug, userid) {
  return load('seats').findIndex(
    r => r.slug === slug && r.userid === userid);
}

// The seat carrying a display label (labels are unique per auction)
function seatByName(slug, uname) {
  return load('seats').find(r => r.slug === slug
    && r.uname === uname);
}

// The reveal button. Anyone may press it once the roster is complete —
// at least two people, all with bids in. Idempotent, and permanent.
function reveal(req) {
  const slug = cleanSlug(req.slug);
  const st = getState(slug);
  if (st.revealed) return st;  // racing presses: both succeed
  const bidPids = st.bidders.map(b => b.userid);
  if (!(st.seats.length >= 2
        && st.seats.every(s => bidPids.indexOf(s.userid) !== -1))) {
    throw { code: 'notReady' };
  }
  const i = load('auctions').findIndex(r => r.slug === slug);
  // the revealed column holds the moment itself (legacy rows hold
  // '1'). The gavel obeys the same monotonic discipline as tbid:
  // minted tbids can sit up to a few ms in the future (max(now,
  // prev+1)), and a tfin stamped before the last bid would drop that
  // bid at the <= cutoff — so tfin = max(now, latest tbid here).
  const last = load('bids').reduce((m, r) =>
    r.slug === slug && r.tbid > m ? r.tbid : m, '');
  const tfin = new Date(Math.max(Date.now(),
    last === '' ? 0 : new Date(last).getTime())).toISOString();
  patch('auctions', i, { tfin: tfin });
  unmaskBids(slug);
  return getState(slug);
}

// Reveal's unmasking sweep: sealed bids are painted white-on-white as
// they land (see placeBid); the reveal gives every one of this
// auction's its color back. Purely cosmetic — the honor system's
// honor system.
function unmaskBids(slug) {
  load('bids').forEach((r, i) => {
    if (r.slug === slug) unsealBid(i);
  });
}

// Make sure the auction has its row (tini/tmod stamped; tfin empty)
// bver is born an explicit 0: an empty version cell is never a
// legitimate spelling (getState refuses it as corruption). Insert-
// only: the auctions row has no tmod to bump (nothing read it, and
// bumping it cost a write on every action), so an existing row is
// left exactly as found.
function ensureAuction(slug) {
  const now = new Date().toISOString();
  if (load('auctions').findIndex(r => r.slug === slug) === -1) {
    insert('auctions', { slug: slug, tini: now, bver: 0 });
  }
}

// Make sure a seat exists for this userid+label; adding is idempotent
// (labels change only via rename, so an existing userid's seat is left
// exactly as found)
function ensureSeat(slug, userid, uname) {
  const now = new Date().toISOString();
  if (seatIndex(slug, userid) !== -1) return;
  insert('seats', { slug: slug, userid: userid, uname: uname,
                    devid: '', tini: now, tmod: now });
}

// The auction blurb: freeform markdown, editable by anyone at any
// time — before or after the close. Concurrent edits are guarded by
// compare-and-swap on bver: the request carries the version the
// edit was based on, and a stale base is refused loudly rather than
// silently clobbering someone's words. The version is a plain
// counter — 0 = never described, +1 per committed save, incremented
// under this write lock — so identities can never collide, no clock
// consulted, and the same number is the pencil tooltip's.
function describe(req) {
  const slug = cleanSlug(req.slug);
  const blurb = String(req.blurb == null ? '' : req.blurb);
  if (blurb.length > 2000) throw { code: 'blurbTooLong' };
  // the verdict comes BEFORE any write (a refusal must mutate
  // nothing, tmod included) — a missing row reads as the virgin
  // version 0, so a fresh auction's first describe passes
  const current = getState(slug).bver;
  // one spelling of virgin: the number 0 (an absent base reads as a
  // legacy caller; '' would coerce to 0 silently, so it may not)
  const base = req.base == null || req.base === ''
    ? NaN : Number(req.base);
  if (base !== current) {
    // the refusal CARRIES the snapshot that refused it — generated
    // under this same write lock — so the client's edit-war diff
    // draws yours-vs-theirs with no second round trip
    const s = getState(slug);
    s.error = { code: 'simulEdits' };
    return s;
  }
  ensureAuction(slug);
  const i = load('auctions').findIndex(r => r.slug === slug);
  // tbed (the blurb's own edit stamp) rides the same patch slab: a
  // last-edited time at zero marginal writes
  patch('auctions', i, { blurb: blurb, bver: current + 1,
                         tbed: new Date().toISOString() });
  return getState(slug);
}

// The blurb editor's presence heartbeat (dreev 2026-07-31; per-
// device rows 2026-08-02): while an editor is open its client pings
// every ~10s into its OWN devices row, and getState shows every
// editor whose last ping is fresh (EDITOR_TTL_MS covers two missed
// beats plus slack — a closed tab simply ages out). One slot per
// DEVICE — the whole desk crowd shows at once, and a foreign clear
// is structurally impossible, since a device only ever writes its
// own row. Disclosed if: a stop clears the slot only while it still
// points at this auction (a newer beat for another auction owns the
// row now). The gavel doesn't apply: the blurb is editable
// post-close, so its presence rides the same exemption; and the
// auctions tab is never touched, so virgin auctions take presence
// and stay virgin.
const EDITOR_TTL_MS = 25000;
function noteEditing(req) {
  const slug = cleanSlug(req.slug);
  const userid = req.userid ? cleanUserid(req.userid) : '';  // '' = unseated
  const devid = cleanDevid(req.devid);
  if (!devid) throw { code: 'editingNeedsDevice' };
  const rig = cleanRig(req.rig);
  const now = new Date().toISOString();
  const i = touchDevice(devid, rig);  // devices first
  if (req.stop) {
    if (load('devices')[i].blug === slug) {
      patch('devices', i, { tmod: now, tblug: '' });
    }
  } else {
    patch('devices', i, { tmod: now, blug: slug, bluid: userid,
                          tblug: now });
  }
  return getState(slug);
}

// The roster is CLOSED once revealed: the game is over, and a fresh
// participant could neither bid meaningfully nor be waited on.
// Adding is IDEMPOTENT on the label (dreev's ruling): if the label is already seated — same userid or
// not — the requested goal state holds, so this is success, sans
// writes (not even a tmod bump). The race loser converges as an
// ordinary latecomer: their next snapshot unseats their ghost userid and
// the claimable star is the re-attach affordance. Renames onto a live
// label still refuse: their goal is a CHANGE, which didn't happen.
function addParticipant(req) {
  const slug = cleanSlug(req.slug);
  const uname = cleanUname(req.uname);
  const userid = cleanUserid(req.userid);
  if (getState(slug).revealed) throw { code: 'rosterClosed' };
  if (seatIndex(slug, userid) === -1 && seatByName(slug, uname)) {
    return getState(slug);  // the label is seated: mission complete
  }
  ensureAuction(slug);
  ensureSeat(slug, userid, uname);
  return getState(slug);
}

// Renaming is a LABEL EDIT, nothing more: the userid is the identity,
// so bids, claims, memory, and reveal-gating don't even notice. One
// cell changes. (This one-liner replaced a re-key of the seat AND
// every bid log row AND the client's rename-transaction machinery —
// the whole reason pids exist.) Renaming onto a live label is
// refused.
function renameParticipant(req) {
  const slug = cleanSlug(req.slug);
  const userid = cleanUserid(req.userid);
  const to = cleanUname(req.to);
  // names freeze at the gavel: a post-close rename could swap
  // around who bid what (dreev's ruling)
  if (getState(slug).revealed) throw { code: 'auctionClosed' };
  const i = seatIndex(slug, userid);
  if (i === -1) throw { code: 'noSuchOne', userid: userid };
  if (load('seats')[i].uname === to) return getState(slug);
  const twin = seatByName(slug, to);
  if (twin && twin.userid !== userid) throw { code: 'nameTaken' };
  patch('seats', i, { uname: to, tmod: new Date().toISOString() });
  ensureAuction(slug);
  return getState(slug);
}

// Removing DELETES the seat — and is allowed only while they have
// not bid (a sealed
// bid is never deletable, so it must never be orphaned either; the
// straggler you ex to end early is bidless by definition, and the UI
// grays the × on every bid-bearing row, so this refusal is only ever
// reached by losing a race). Absent seat: harmless no-op.
function removeParticipant(req) {
  const slug = cleanSlug(req.slug);
  const userid = cleanUserid(req.userid);
  // the record freezes at the gavel
  if (getState(slug).revealed) throw { code: 'auctionClosed' };
  const i = seatIndex(slug, userid);
  if (i === -1) return getState(slug);  // absent: a harmless no-op
  if (load('bids').some(r => r.slug === slug && r.userid === userid)) {
    throw { code: 'removeBidder' };
  }
  ensureAuction(slug);
  erase('seats', i);
  return getState(slug);
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
  const slug = cleanSlug(req.slug);
  const userid = cleanUserid(req.userid);
  const devid = cleanDevid(req.devid);
  if (!devid) throw { code: 'claimNeedsDevice' };
  // identity is part of the frozen record, like names and bids: a
  // post-close claim would dress a revealed bid in a stranger's rig
  if (getState(slug).revealed) throw { code: 'auctionClosed' };
  const rig = cleanRig(req.rig);
  if (seatIndex(slug, userid) === -1) throw { code: 'noSuchOne', userid: userid };
  touchDevice(devid, rig);  // devices first, always
  ensureAuction(slug);
  setDevid(slug, userid, devid);
  return getState(slug);
}

// Vacate a seat — only its holder may. An unheld seat releases as a
// no-op: a merely-local soft claim must release without drama.
function releaseClaim(req) {
  const slug = cleanSlug(req.slug);
  const userid = cleanUserid(req.userid);
  const devid = cleanDevid(req.devid);
  if (!devid) throw { code: 'releaseNeedsDevice' };
  if (getState(slug).revealed) throw { code: 'auctionClosed' };  // frozen too
  const held = deviceOf(slug, userid);
  if (held && held !== devid) {
    throw { code: 'notYourSeat' };
  }
  // only an ACTUAL release writes: refused and no-op requests mutate
  // nothing, not even tmod
  if (held) {
    ensureAuction(slug);
    setDevid(slug, userid, '');
  }
  return getState(slug);
}

// The devid currently holding a seat ('' if open or no such seat)
function deviceOf(slug, userid) {
  const i = seatIndex(slug, userid);
  return i === -1 ? '' : load('seats')[i].devid;
}

function setDevid(slug, userid, devid) {
  const now = new Date().toISOString();
  load('seats').forEach((r, i) => {
    if (r.slug !== slug) return;
    if (r.userid === userid) {
      patch('seats', i, { devid: devid, tmod: now });
    } else if (devid && r.devid === devid) {
      patch('seats', i, { devid: '', tmod: now });
    }
  });
}

// Upsert the device's one row — devices FIRST, before any write that
// references it (so a dangling reference is unmintable; a refusal
// after it leaves at worst a harmless orphan row) — and return its
// record index. Two disclosed ifs beyond the upsert itself: an
// unchanged blurb costs no write, and a '' report never erases a
// known blurb — ignorance is not news, the device didn't stop being
// a Mac. '' devid (old clients, nobody) touches nothing: -1.
function touchDevice(devid, rig) {
  if (!devid) return -1;
  const now = new Date().toISOString();
  const i = load('devices').findIndex(r => r.devid === devid);
  if (i === -1) {
    return insert('devices', { devid: devid, rig: rig,
                               tini: now, tmod: now });
  }
  if (rig && load('devices')[i].rig !== rig) {
    patch('devices', i, { rig: rig, tmod: now });
  }
  return i;
}

// The holder's rig, RAW from its devices row ('' when the device
// never described itself; the client's mystery-device fallback
// decorates it), for the seat-taken refusal that names who beat you
function holderRig(slug, userid) {
  const dev = load('devices')
    .find(r => r.devid === deviceOf(slug, userid));
  return dev === undefined ? '' : dev.rig;
}

function placeBid(req) {
  const slug = cleanSlug(req.slug);
  const userid = cleanUserid(req.userid);
  const uname = cleanUname(req.uname);  // the label, for walk-on seats
  const bid = String(req.bid == null ? '' : req.bid).trim();
  if (!bid) throw { code: 'emptyBid' };
  if (bid.length > 160) throw { code: 'bidTooLong' };
  // The gavel drop is a bright line: no bid lands after tfin. This is
  // also the explicit loss notice for an under-the-wire revision that
  // arrived a beat too late.
  if (getState(slug).revealed) {
    throw { code: 'gavelFell' };
  }
  const devid = req.devid === undefined ? ''
    : cleanDevid(req.devid);
  const rig = cleanRig(req.rig);
  const held = deviceOf(slug, userid);

  // bidding claims a roster seat: your own bid must never read as
  // not-counting (a bid rebuilds its seat if a raced removal took
  // it). A WALK-ON bid (no seat for this userid yet) whose label is
  // already seated under someone else's userid is a doppelganger,
  // refused.
  // Bidding as someone is claiming to be them, and claims are first
  // come, first served: a bid may not touch a seat someone else holds.
  // Old clients carry no devid and count as nobody — fine on an
  // open seat, refused on a held one.
  if (held && held !== devid) {
    throw { code: 'bidSeatHeld', rig: holderRig(slug, userid),
            uname: uname };
  }
  const twin = seatByName(slug, uname);
  if (seatIndex(slug, userid) === -1 && twin && twin.userid !== userid) {
    throw { code: 'nameTaken' };
  }
  // no partial writes: every row this bid may append is capacity-
  // checked BEFORE the first one lands (a refusal must not leave a
  // half-created seat)
  assertRoom('bids');
  if (seatIndex(slug, userid) === -1) assertRoom('seats');
  touchDevice(devid, rig);  // devices first, always
  ensureAuction(slug);
  ensureSeat(slug, userid, uname);
  if (devid) {
    setDevid(slug, userid, devid);
  }

  // every submission is its own log row; the read side derives the
  // rest (latest wins, first stamps tini, count counts)
  // tbid is minted strictly increasing per auction — max(now, prev
  // + 1ms) — so exact ties are unmintable, order is recoverable from
  // tbid alone (no row-order tiebreak, no sheet-sorting hazard), and
  // the read side may assert duplicates as forgery. The 1ms fudge is
  // invisible: tbid renders only as "3m ago".
  const prev = load('bids').reduce((m, r) =>
    r.slug === slug && r.tbid > m ? r.tbid : m, '');
  const tbid = new Date(Math.max(Date.now(),
    (prev === '' ? 0 : new Date(prev).getTime()) + 1)).toISOString();
  const at = insert('bids', { slug: slug, userid: userid, bid: bid,
                              tbid: tbid, devid: devid });
  // seal THIS submission white-on-white as it lands — one write, not
  // a repaint of the whole pile (its elders were sealed at their own
  // appends; reveal() unmasks the lot)
  sealBid(at);
  return getState(slug);
}
