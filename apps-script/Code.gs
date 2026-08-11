// Tauction API — Google Apps Script web app fronting the spreadsheet.
//
// Vocabulary: "slug" = an auction's name, which is also its URL slug;
// "snym" = a seat's display name, shown with an @ in the UI.
//
// Deploying: `npm run deploy` from the repo (clasp). Manual fallback:
// paste into the sheet's Apps Script editor, then Deploy -> Manage
// deployments -> pencil -> Version: New version. The /exec URL never
// changes either way.

const SHEET_ID = '1hclphAZ3zQIq14Nip1ZxTDSoE9ygXqAv27RwP1hiMA8';

// SVER (dreev-ratified 2026-08-10): the server's GENERATION — a
// hand-bumped integer stated in every state payload, so a page
// that needs newer server behavior refuses to run against an old
// deployment LOUDLY AT LOAD (the push-before-deploy skew window),
// with marching orders instead of a dead button. BUMP IT (with
// app.js's SVERMIN — a qual welds them equal) whenever the page
// starts DEPENDING on new server behavior; adding an action
// without a bump fails the ledger qual by name. Forgetting a bump
// merely falls back to today's loudness — the gate only ever adds.
const SVER = 2;  // 2: bidders[].dvid, the forensic column

// Column vocabulary (dreev's): tini = time-initial (created), tmod =
// time-modified, tfin = time-final (the reveal moment), tbid = a
// submission's moment, dvid = a browser's anonymous uuid.
//
// THE USID: a seat id, a uuid minted client-side at add-time.
// The usid IS the identity — seats, bids, claims, and the client's
// memory all key on it — and the snym is just its display label, so
// renames are one-cell label edits: no bid re-keying, no client
// rename transactions, no orphaned identities.
const AUCTIONS_HEAD = ['slug', 'tini', 'tfin', 'blub', 'bver',
                       'tbed'];
// The bids tab is an append-only LOG: every submission is its own
// row, nothing is ever overwritten, and the payload's tini/tmod/
// bcount are DERIVED
const BIDS_HEAD     = ['slug', 'usid', 'xbid', 'tbid',
                       'dvid'];
// A seats row IS a roster seat, and every seat is live: removing a
// bidless person deletes their row outright, and a person who HAS
// bid cannot be removed at all (a sealed bid is never deletable, so
// it can never be orphaned; the straggler you ex to end early is
// bidless by definition). Future per-person
// attributes (weights/shares) append as columns to the right.
const SEATS_HEAD    = ['slug', 'usid', 'snym', 'dvid',
                       'tini', 'tmod'];

// THE DEVICES TABLE (dreev 2026-08-02): one row per device ever
// seen, the anym self-description's ONE home ("Mac Chrome in
// Portland, OR"). Everything else stores dvid REFERENCES and
// getState joins. Rows are written devices-FIRST — touchDevice
// before any write that references the device — so a dangling
// reference can never be minted.
// blug/blid/blip are the device's EDITING-PRESENCE
// slot (per-device, so a whole desk crowd can show at once): which
// auction's blub this device has open, as whom ('' = walk-in), and
// the latest heartbeat. Ephemeral by TTL — see noteEditing.
const DEVICES_HEAD  = ['dvid', 'anym', 'tini', 'tmod',
                       'blug', 'blid', 'blip'];

// wver = world version: ONE global write counter in its own
// one-cell tab, bumped inside every write's lock (mutate). Clients
// poll this cell through the sheet's public CSV face — spending the
// VISITOR's quota, not the owner's — and pay an API state read only
// when it moves (dreev-ratified 2026-08-06, after the 60-reads/min
// per-user meter fell to five open tabs). Global, never
// per-auction: a virgin auction's presence heartbeats bump it
// without ever touching the auctions tab (the virgin-stays-virgin
// law).
const PULSE_HEAD    = ['wver'];

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
      case 'state':    return cachedState(cleanSlug(req.slug));
      case 'bid':      return mutate(req, () => placeBid(req));
      case 'claim':    return mutate(req, () => saveClaim(req));
      case 'release':  return mutate(req, () => releaseClaim(req));
      case 'describe': return mutate(req, () => describe(req));
      case 'editing':  return mutate(req, () => noteEditing(req));
      case 'add':      return mutate(req, () => addParticipant(req));
      case 'remove':   return mutate(req, () => removeParticipant(req));
      case 'rename':   return mutate(req, () => renameParticipant(req));
      case 'reveal':   return mutate(req, () => reveal(req));
      case 'archive':  return mutate(req, () => archive(req));
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

// THE POLL COLLAPSER (dreev-ratified 2026-08-06, after production
// hit Google's 60-reads/min-per-user meter: execute-as-me means
// every visitor spends the owner's quota, and five open tabs at the
// 5s poll saturate it). Every state poll inside a STATE_CACHE_S
// window shares ONE batchGet via CacheService — only the pure read
// path caches; every write invalidates its slug (mutate, below), so
// a stale answer exists only BETWEEN writes and dies at the TTL.
// 4s < the client's 5s poll: liveness unchanged in kind. The chosen
// trade (pinned by a gas qual): out-of-band sheet edits — a human
// typing in the sheet — now lag up to the TTL.
const STATE_CACHE_S = 4;

function cachedState(slug) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('state:' + slug);
  if (hit !== null) return JSON.parse(hit);
  const res = getState(slug);
  cache.put('state:' + slug, JSON.stringify(res), STATE_CACHE_S);
  return res;
}

// The pulse cell's read-and-validate, asked UP FRONT (the armor
// precedent: no partial writes) — a mangled cell refuses before the
// op touches anything. Returns the current count.
function pulseCheck() {
  // seeded at tab birth (TAB_SEEDS), so absence = hand-vandalism
  // and reads as corruption, same refusal
  const prow = load('pulse')[0];
  const cur = Number(!prow || prow.wver === '' ? NaN : prow.wver);
  if (!Number.isInteger(cur) || cur < 0) {
    throw 'pulse.wver corrupt: ' + JSON.stringify(prow && prow.wver);
  }
  return cur;
}

// Every write bumps the pulse (inside the lock, so counts never
// interleave) and invalidates its auction's cached poll answer
// AFTER the lock releases: the op's own response is fresh truth,
// and the next poll must re-read rather than resurrect the
// pre-write picture. A refused write threw before the bump and
// invalidates nothing (it mutated nothing).
function mutate(req, fn) {
  const res = withLock(() => {
    const cur = pulseCheck();
    const out = fn();
    if (wroteAny) {  // real news only: no-ops don't wake the crowd
      patch('pulse', 0, { wver: String(cur + 1) });
      // the op built its response BEFORE the bump; restamp the one
      // field rather than re-derive the whole state (a re-derivation
      // would re-batchGet — the pulse memo just invalidated)
      out.wver = String(cur + 1);
    }
    return out;
  });
  CacheService.getScriptCache().remove('state:' + cleanSlug(req.slug));
  return res;
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

// THE ARCHIVE GRAMMAR (dreev-ratified 2026-08-09, format simplified
// same day: the Closed stamp already shows the date, so no date in
// the name): an archived auction's slug is its old name plus
// -archiveN — N minted max+1, unbounded (no per-day cap, so no
// choke refusal; lexical sort of archive names is not chronological
// and nothing in the product sorts slugs, dreev-accepted). This ONE
// regex serves the server's archive-of-archive refusal, the
// client's grayed Archive control and name-field gate, and
// cleanSlug's length exemption (a qual welds the app.js copy
// byte-identical). An -archiveN name FITS the 20-char typed field,
// so the namespace holds by refusal alone: the client name gate
// objects pre-wire and ensureAuction refuses to BIRTH one (the
// archiveSquat refusal — a squatted number would misdirect a later
// real archive).
const ARCHIVE_RE = /-archive\d+$/;

function cleanSlug(s) {
  s = String(s || '').toLowerCase();
  // the length rule judges the BASE — what a human typed; the
  // server-minted archive suffix rides exempt. Length first, for
  // the specific words (20 max)
  const base = s.replace(ARCHIVE_RE, '');
  if (base.length > 20) throw { code: 'slugTooLong' };
  if (!/^[a-z0-9-]{1,20}$/.test(base)) throw { code: 'badSlug' };
  return s;
}

function cleanSnym(s) {
  s = String(s || '').toLowerCase();
  if (s.length > 20) throw { code: 'snymTooLong' };
  if (!/^[a-z][a-z0-9]{0,19}$/.test(s)) {
    throw { code: 'badSnym' };
  }
  return s;
}

// A dvid is a client-minted uuid; empty means "release the claim"
function cleanDvid(s) {
  s = String(s == null ? '' : s);
  if (!/^[a-z0-9-]{0,64}$/.test(s)) throw { code: 'badDvid' };
  return s;
}

// A usid is a client-minted uuid: the person's identity, forever
function cleanUsid(s) {
  s = String(s == null ? '' : s);
  if (!/^[a-z0-9-]{8,64}$/.test(s)) throw { code: 'badUsid' };
  return s;
}

// The claimant's self-reported anym ("a Mac (Chrome)") — decoration for
// the who-claimed-this tooltip, printable ASCII only, max 160 chars
// (matching the bid limit; widened from 64 on 2026-08-05 for the
// crammed city-or-by-timezone tail). (Apps Script web apps can't read
// request headers, so the client must tell us; honor system, like
// everything.)
function cleanAnym(s) {
  s = String(s == null ? '' : s);
  if (!/^[ -~]{0,160}$/.test(s)) throw { code: 'badAnym' };
  return s;
}

/* ======================= the sheets storage layer ======================
   Everything Google-Sheets-specific lives in this section, behind the
   fence line at its end — the business logic below the fence speaks
   only in RECORDS (rows zipped with their tab's header: {slug: ...,
   snym: ..., all strings}) and 0-based record indexes. Switching to
   a real database later means rewriting this section (plus withLock,
   its platform sibling above): load / insert / patch / erase per
   table, and the two sheet-cosmetic seal calls, which a database
   would simply no-op. A qual holds the fence.
   ===================================================================== */

const TABS = { auctions: AUCTIONS_HEAD, bids: BIDS_HEAD,
               seats: SEATS_HEAD, devices: DEVICES_HEAD,
               pulse: PULSE_HEAD };
// the bids tab is where peeking would spoil the sealing; warn there only
const TAB_WARNINGS =
  { bids: "IT'S CHEATING TO LOOK HERE DURING AN AUCTION" };

// A tab's first cell, painted at creation like the warning above
// (never marked as news): the pulse row exists from tab birth, so
// no reader or writer ever re-litigates its absence — an empty
// pulse tab is hand-vandalism and refuses as corruption
const TAB_SEEDS = { pulse: '0' };

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
    if (TAB_SEEDS[kind]) {
      sh.getRange(2, 1).setValue(TAB_SEEDS[kind]);
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
  let got;
  try {
    got = Sheets.Spreadsheets.Values.batchGet(SHEET_ID,
      { ranges: Object.keys(TABS) }).valueRanges;
  } catch (err) {
    // the per-user read meter ran dry — an honest crowd of five tabs
    // can do it, so it refuses on the game channel in stringles
    // words, never as GoogleJsonResponseException prose (dreev saw
    // exactly that banner in production, 2026-08-06); the next poll
    // retries into a fresh minute
    if (String(err).indexOf('Quota exceeded') !== -1) {
      throw { code: 'quotaChoke' };
    }
    throw err;
  }
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
// wroteAny: did THIS execution actually touch a cell? The one
// chokepoint every real mutation passes (patch/insert/erase all call
// wrote), so mutate can bump the pulse only for real news — a
// semantic no-op mutates nothing, not even tmod, not even the
// pulse. Per-execution global: real Apps Script resets it each run;
// the fake's RESET clears it by name.
let wroteAny = false;

function wrote(kind) { wroteAny = true; delete rowsMemo[kind]; }

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
  const rec = load(kind)[i];  // rowsMemo is warm: a free array index
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

// The ATOMIC sibling of patch/insert (dreev-ratified 2026-08-09,
// built for the archive rename): any number of single-field patches
// plus whole-row inserts, all landing in ONE Sheets batchUpdate —
// which Google applies all-or-nothing ("if one request is
// unsuccessful, none of the other ... changes are written"), so a
// crashed execution can tear nothing. Validation (unknown fields,
// armor capacity) runs while BUILDING the requests, before anything
// flies. Insert rows are aimed by the memoized row counts (safe
// under the lock) at explicit coordinates INSIDE the pre-grown
// armor — updateCells at a fixed spot, never append semantics. REST
// writes need no flush to land and the next loadAll's batchGet sees
// them; the flush here is the usual barrier for any SpreadsheetApp
// writes buffered earlier in this execution.
function batchWrite(patches, inserts) {
  SpreadsheetApp.flush();
  const nextAt = {};  // per-tab insert cursor, this batch only
  const touched = {};
  const cell = (v) => ({ userEnteredValue: {
    stringValue: String(v === undefined ? '' : v) } });
  const requests = [];
  patches.forEach(function (p) {
    const head = TABS[p.kind];
    Object.keys(p.changes).forEach(function (f) {
      const c = head.indexOf(f);
      if (c === -1) throw 'batchWrite: field not in ' + p.kind;
      requests.push({ updateCells: {
        start: { sheetId: tab(p.kind).getSheetId(),
                 rowIndex: p.i + 1, columnIndex: c },
        rows: [{ values: [cell(p.changes[f])] }],
        fields: 'userEnteredValue' } });
    });
    touched[p.kind] = true;
  });
  inserts.forEach(function (ins) {
    const head = TABS[ins.kind];
    const at = nextAt[ins.kind] === undefined
      ? load(ins.kind).length : nextAt[ins.kind];
    nextAt[ins.kind] = at + 1;
    if (at + 2 > ARMOR_ROWS) throw armorFullCopy(ins.kind);
    requests.push({ updateCells: {
      start: { sheetId: tab(ins.kind).getSheetId(),
               rowIndex: at + 1, columnIndex: 0 },
      rows: [{ values: head.map(function (h) {
        return cell(ins.rec[h]);
      }) }],
      fields: 'userEnteredValue' } });
    touched[ins.kind] = true;
  });
  Sheets.Spreadsheets.batchUpdate({ requests: requests }, SHEET_ID);
  Object.keys(touched).forEach(wrote);
}

// Sheet-only decoration — a real database would no-op both: sealed
// bid text is white-on-white for anyone peeking at the spreadsheet,
// and the reveal hands the color back
const BID_COL = BIDS_HEAD.indexOf('xbid') + 1;
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
  // A virgin auction is a VALUE, not a scattering of existence
  // checks: absence defaults to the virgin record and every field
  // below reads unconditionally (exists alone remembers the find)
  const found = load('auctions').find(r => r.slug === slug);
  const arow = found || { tfin: '', blub: '', bver: '0' };

  // The SEATS are the users rows (in insertion order): usid + display
  // label. The claims map rides along: usid -> dvid for seats
  // someone holds. Every seat is live — removal deletes, and bidders
  // cannot be removed — so the seats ARE the roster that gates the
  // reveal.
  // the devices join: dvid -> its one self-description row
  const anymOf = Object.create(null);
  load('devices').forEach(r => {
    if (r.anym) anymOf[r.dvid] = r.anym;
  });
  const seats = [];
  const claims = Object.create(null);
  const anyms = Object.create(null);  // usid -> the holder's anym
  load('seats').forEach(r => {
    if (r.slug !== slug) return;
    seats.push({ usid: r.usid, snym: r.snym });
    if (r.dvid) claims[r.usid] = r.dvid;
    if (r.dvid && anymOf[r.dvid]) anyms[r.usid] = anymOf[r.dvid];
  });
  const roster = seats;

  // Reveal is a human act (the 'reveal' action) and a one-way latch: it
  // never happens automatically, and once bids have been seen, nothing can
  // reseal them. A complete roster merely makes the reveal button pressable.
  const tfin = arow.tfin;  // the reveal moment, ISO
  const revealed = tfin !== '';
  const blub = arow.blub;  // freeform markdown
  // the blub's version counter (CAS token AND the pencil tooltip's
  // number): 0 = never described, +1 per committed save. Sheets may
  // hand the cell back as a string; a cell that isn't a whole number
  // is corruption and refuses loudly.
  const bver = Number(arow.bver === '' ? NaN : arow.bver);
  if (!Number.isInteger(bver) || bver < 0) {
    throw 'auctions.bver corrupt for ' + slug + ': '
      + JSON.stringify(arow.bver);
  }
  // the desk crowd: every device whose editing slot points here and
  // whose last heartbeat is fresh (both stamps are this server's
  // clock — no skew); a vanished editor ages out right here, no
  // sweeper needed
  const editors = [];
  load('devices').forEach(r => {
    if (r.blug === slug && r.blip
        && Date.now() - new Date(r.blip).getTime() < EDITOR_TTL_MS) {
      editors.push({ usid: r.blid, dvid: r.dvid,
                     anym: r.anym });
    }
  });

  // A person's standing bid is their LATEST log row at or before tfin
  // (<=, dreev's call: a bid stamped the gavel's own millisecond made
  // it — belt only, since placeBid refuses after the reveal anyway).
  // The payload keeps its vocabulary, derived per person from the log:
  // tini = first tbid, tmod = latest, bcount = row count. ISO stamps
  // compare lexicographically; rows are in submission order.
  const agg = Object.create(null);  // usid -> derived bidder, in first-bid order
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
    const a = agg[r.usid] || (agg[r.usid] =
      { usid: r.usid, bcount: 0, tini: r.tbid });
    a.bcount++;
    a.tmod = r.tbid;
    a.xbid = r.xbid;
    a.dvid = r.dvid;  // the fold's last write = the standing row's
  });
  const people = Object.keys(agg).map(p => agg[p]);
  // Each entry's dvid is the STANDING bid's submitting browser — the
  // log's forensic column (see the bids schema), surfaced so the
  // revealed page can derive is-you from the immutable record: the
  // claim column can be vacated after a bid and before the gavel (a
  // rival claim plus the radio law), and the archive rename orphans
  // the client's slug-keyed memory (dreev's star bug, 2026-08-10).
  const bidders = people.map(a =>
    ({ usid: a.usid, bcount: a.bcount, tini: a.tini, tmod: a.tmod,
       dvid: a.dvid }));

  // the closed-state covenant, asserted on every read: a revealed
  // auction has two-plus (uncut) roster seats, every one of them with
  // a bid — forever (the post-close freezes make it eternal)
  if (revealed && !(roster.length >= 2
      && roster.every(s => bidders.some(b => b.usid === s.usid)))) {
    throw covenantCopy(slug, 'roster ['
      + roster.map(s => s.snym).join(', ') + '] but bids only from ['
      + bidders.map(b => b.usid).join(', ') + ']');
  }

  return {
    slug: slug, exists: found !== undefined,
    seats: seats, bidders: bidders, revealed: revealed,
    tfin: tfin, blub: blub, bver: bver, editors: editors,
    claims: claims, anyms: anyms,
    // the family's archive numbers, ascending (see arcsOf): the
    // incarnation-links chrome derives all its navigation from
    // this one family-wide field
    arcs: arcsOf(slug.replace(ARCHIVE_RE, '')),
    sver: SVER,  // the generation handshake (see the constant)
    // the pulse pair: which sheet to poll for the wver cell (so
    // ?api= test deployments pulse against their own sheet, never a
    // baked constant) and the count this picture was drawn at —
    // read through pulseCheck, the one guarded owner of the row
    sheet: SHEET_ID, wver: String(pulseCheck()),
    bids: revealed ? people.map(a => ({ usid: a.usid, xbid: a.xbid }))
                   : null,
  };
}

// This auction's seat record index for a usid (-1 if none)
function seatIndex(slug, usid) {
  return load('seats').findIndex(
    r => r.slug === slug && r.usid === usid);
}

// The seat carrying a display label (labels are unique per auction)
function seatByName(slug, snym) {
  return load('seats').find(r => r.slug === slug
    && r.snym === snym);
}

// The reveal button. Anyone may press it once the roster is complete —
// at least two people, all with bids in. Idempotent, and permanent.
function reveal(req) {
  const slug = cleanSlug(req.slug);
  const st = getState(slug);
  if (st.revealed) return st;  // racing presses: both succeed
  const bidUsids = st.bidders.map(b => b.usid);
  if (!(st.seats.length >= 2
        && st.seats.every(s => bidUsids.indexOf(s.usid) !== -1))) {
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

// THE ARCHIVE (dreev-ratified 2026-08-09): a closed auction's URL
// is evergreen. Archiving renames the whole record — the auctions
// row, its seats, its bids log (the slug key cells ONLY; the
// append-only law bends exactly this far, re-keying rows without
// ever editing their content) — to slug-archiveN, and rebirths the
// slug as a fresh auction. (The close DATE lives on the Closed
// stamp, not in the name — dreev's format ruling.) THE BLUB RIDES
// (dreev's kill-the-pointer ruling, later the same day: no
// machinery ever writes INTO a blub): the reborn row inherits
// blub, bver, and tbed unchanged, so the URL keeps its standing
// description, the archive holds a frozen copy, and a straggler's
// mid-archive draft lands as an ordinary edit on the continuous
// blub. Rename and rebirth land in ONE atomic batchWrite: a
// crashed execution tears nothing. devices.blug may point at the
// old slug for up to EDITOR_TTL_MS — presence ages out on its own,
// chosen not forgotten.
// THE ARCS: a family's existing archive numbers, ascending — ONE
// scan serving both the archive mint (max+1) and every state's
// `arcs` payload (the incarnation-links chrome derives home and
// previous-incarnation from it, client-side, with no extra reads).
// base = any family member's slug with the suffix stripped; its
// charset is [a-z0-9-], so nothing needs regex-escaping.
function arcsOf(base) {
  const nre = new RegExp('^' + base + '-archive(\\d+)$');
  const ns = [];
  load('auctions').forEach(function (r) {
    const m = nre.exec(r.slug);
    if (m !== null) ns.push(Number(m[1]));
  });
  return ns.sort(function (a, b) { return a - b; });
}

function archive(req) {
  const slug = cleanSlug(req.slug);
  // an archive is a historical record: archiving it again would
  // fork history into -archive-...-archive-... (dreev: too gross).
  // The client grays its Archive control, so only hand-rolled
  // requests ever ask.
  if (ARCHIVE_RE.test(slug)) throw { code: 'archiveArchive' };
  const st = getState(slug);
  // one refusal for every nothing-here-to-archive: virgin, still
  // open, or renamed away by a rival's archive a beat ago (dreev's
  // copy names that race; his ERROR number classes it plumbing)
  if (!st.revealed) throw { code: 'archiveUnclosed' };
  // N is max+1 over the existing incarnations, NEVER first-free: a
  // hand-deleted middle round must not be refilled out of order —
  // chronology beats tidiness. Unbounded, so no cap and no choke.
  const ns = arcsOf(slug);
  const maxN = ns.length === 0 ? 0 : ns[ns.length - 1];
  // anti-postel: past 2^53 (a hand-edited N — the API can't mint
  // one) maxN + 1 collides with maxN or goes exponential; refuse
  // loudly rather than rename onto an existing slug
  if (!Number.isSafeInteger(maxN + 1)) {
    throw 'archive: incarnation count beyond safe integers for "'
      + slug + '": ' + maxN + ' — fix the hand-edited row';
  }
  const to = slug + '-archive' + (maxN + 1);
  assertRoom('auctions');  // the reborn row, capacity-checked first
  const patches = [];
  ['auctions', 'seats', 'bids'].forEach(function (kind) {
    load(kind).forEach(function (r, i) {
      if (r.slug === slug) {
        patches.push({ kind: kind, i: i, changes: { slug: to } });
      }
    });
  });
  // the reborn row: fresh tini, open tfin — and the blub column
  // carried from the raw record (tbed included; getState doesn't
  // serve tbed, so read it here), never composed
  const arow = load('auctions').find(function (r) {
    return r.slug === slug;
  });
  const now = new Date().toISOString();
  batchWrite(patches, [{ kind: 'auctions',
    rec: { slug: slug, tini: now, tfin: '', blub: arow.blub,
           bver: arow.bver, tbed: arow.tbed } }]);
  // mutate invalidates this op's own slug after the lock; the
  // TARGET may hold a cached virgin answer from a probed URL —
  // dead now too
  CacheService.getScriptCache().remove('state:' + to);
  return getState(slug);
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
    // Only the archive action may BIRTH an archive-form slug (its
    // batchWrite writes the row directly): born-on-first-touch on
    // a virgin archive name would let anyone eat a letter of the
    // namespace — choking or misdirecting a later real archive —
    // so it refuses. EXISTING archives never reach this refusal
    // (the row check above): their blub stays editable, and the
    // gavel freezes handle the rest.
    if (ARCHIVE_RE.test(slug)) throw { code: 'archiveSquat' };
    insert('auctions', { slug: slug, tini: now, bver: 0 });
  }
}

// Make sure a seat exists for this usid+label; adding is idempotent
// (labels change only via rename, so an existing usid's seat is left
// exactly as found). INVARIANT: a seats row's slug always has its
// auctions row — every caller runs ensureAuction first, and the
// archive re-keys seats and auctions in one atomic batchWrite — so
// seat-requiring ops (rename/remove/claim/release) never re-check
// it. A hand-gutted sheet (auctions row deleted, seats surviving)
// serves exists:false alongside its seats rather than being
// silently healed with a forged tini (anti-postel: patchGhost is
// the disclosed policy for hand-gutted sheets).
function ensureSeat(slug, usid, snym) {
  const now = new Date().toISOString();
  if (seatIndex(slug, usid) !== -1) return;
  insert('seats', { slug: slug, usid: usid, snym: snym,
                    dvid: '', tini: now, tmod: now });
}

// The auction blub: freeform markdown, editable by anyone at any
// time — before or after the close. Concurrent edits are guarded by
// compare-and-swap on bver: the request carries the version the
// edit was based on, and a stale base is refused loudly rather than
// silently clobbering someone's words. The version is a plain
// counter — 0 = never described, +1 per committed save, incremented
// under this write lock — so identities can never collide, no clock
// consulted, and the same number is the pencil tooltip's.
function describe(req) {
  const slug = cleanSlug(req.slug);
  const blub = String(req.blub == null ? '' : req.blub);
  if (blub.length > 2000) throw { code: 'blubTooLong' };
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
  // tbed (the blub's own edit stamp) rides the same patch slab: a
  // last-edited time at zero marginal writes
  patch('auctions', i, { blub: blub, bver: current + 1,
                         tbed: new Date().toISOString() });
  return getState(slug);
}

// The blub editor's presence heartbeat (dreev 2026-07-31; per-
// device rows 2026-08-02): while an editor is open its client pings
// every ~10s into its OWN devices row, and getState shows every
// editor whose last ping is fresh (EDITOR_TTL_MS covers two missed
// beats plus slack — a closed tab simply ages out). One slot per
// DVID — the whole desk crowd shows at once, and a foreign clear
// is structurally impossible, since a device only ever writes its
// own row. Disclosed if: a stop clears the slot only while it still
// points at this auction (a newer beat for another auction owns the
// row now). The gavel doesn't apply: the blub is editable
// post-close, so its presence rides the same exemption; and the
// auctions tab is never touched, so virgin auctions take presence
// and stay virgin.
const EDITOR_TTL_MS = 25000;
function noteEditing(req) {
  const slug = cleanSlug(req.slug);
  const usid = req.usid ? cleanUsid(req.usid) : '';  // '' = unseated
  const dvid = cleanDvid(req.dvid);
  if (!dvid) throw { code: 'editingNeedsDevice' };
  const anym = cleanAnym(req.anym);
  const now = new Date().toISOString();
  const i = touchDevice(dvid, anym);  // devices first
  if (req.stop) {
    if (load('devices')[i].blug === slug) {
      patch('devices', i, { tmod: now, blip: '' });
    }
  } else {
    patch('devices', i, { tmod: now, blug: slug, blid: usid,
                          blip: now });
  }
  return getState(slug);
}

// The roster is CLOSED once revealed: the game is over, and a fresh
// participant could neither bid meaningfully nor be waited on.
// Adding is IDEMPOTENT on the label (dreev's ruling): if the label is already seated — same usid or
// not — the requested goal state holds, so this is success, sans
// writes (not even a tmod bump). The race loser converges as an
// ordinary latecomer: their next snapshot unseats their ghost usid and
// the claimable star is the re-attach affordance. Renames onto a live
// label still refuse: their goal is a CHANGE, which didn't happen.
function addParticipant(req) {
  const slug = cleanSlug(req.slug);
  const snym = cleanSnym(req.snym);
  const usid = cleanUsid(req.usid);
  if (getState(slug).revealed) throw { code: 'rosterClosed' };
  if (seatIndex(slug, usid) === -1 && seatByName(slug, snym)) {
    return getState(slug);  // the label is seated: mission complete
  }
  ensureAuction(slug);
  ensureSeat(slug, usid, snym);
  return getState(slug);
}

// Renaming is a LABEL EDIT, nothing more: the usid is the identity,
// so bids, claims, memory, and reveal-gating don't even notice. One
// cell changes. (This one-liner replaced a re-key of the seat AND
// every bid log row AND the client's rename-transaction machinery —
// the whole reason usids exist.) Renaming onto a live label is
// refused.
function renameParticipant(req) {
  const slug = cleanSlug(req.slug);
  const usid = cleanUsid(req.usid);
  const to = cleanSnym(req.to);
  // names freeze at the gavel: a post-close rename could swap
  // around who bid what (dreev's ruling)
  if (getState(slug).revealed) throw { code: 'auctionClosed' };
  const i = seatIndex(slug, usid);
  if (i === -1) throw { code: 'noSuchOne', usid: usid };
  if (load('seats')[i].snym === to) return getState(slug);
  const twin = seatByName(slug, to);
  if (twin && twin.usid !== usid) throw { code: 'nameTaken' };
  patch('seats', i, { snym: to, tmod: new Date().toISOString() });
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
  const usid = cleanUsid(req.usid);
  // the record freezes at the gavel
  if (getState(slug).revealed) throw { code: 'auctionClosed' };
  const i = seatIndex(slug, usid);
  if (i === -1) return getState(slug);  // absent: a harmless no-op
  if (load('bids').some(r => r.slug === slug && r.usid === usid)) {
    throw { code: 'removeBidder' };
  }
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
  const usid = cleanUsid(req.usid);
  const dvid = cleanDvid(req.dvid);
  if (!dvid) throw { code: 'claimNeedsDevice' };
  // identity is part of the frozen record, like names and bids: a
  // post-close claim would dress a revealed bid in a stranger's anym
  if (getState(slug).revealed) throw { code: 'auctionClosed' };
  const anym = cleanAnym(req.anym);
  if (seatIndex(slug, usid) === -1) throw { code: 'noSuchOne', usid: usid };
  touchDevice(dvid, anym);  // devices first, always
  setDvid(slug, usid, dvid);
  return getState(slug);
}

// Vacate a seat — only its holder may. An unheld seat releases as a
// no-op: a merely-local soft claim must release without drama.
function releaseClaim(req) {
  const slug = cleanSlug(req.slug);
  const usid = cleanUsid(req.usid);
  const dvid = cleanDvid(req.dvid);
  if (!dvid) throw { code: 'releaseNeedsDevice' };
  if (getState(slug).revealed) throw { code: 'auctionClosed' };  // frozen too
  const held = deviceOf(slug, usid);
  if (held && held !== dvid) {
    throw { code: 'notYourSeat' };
  }
  // only an ACTUAL release writes: refused and no-op requests mutate
  // nothing, not even tmod
  if (held) {
    setDvid(slug, usid, '');
  }
  return getState(slug);
}

// The dvid currently holding a seat ('' if open or no such seat)
function deviceOf(slug, usid) {
  const i = seatIndex(slug, usid);
  return i === -1 ? '' : load('seats')[i].dvid;
}

function setDvid(slug, usid, dvid) {
  const now = new Date().toISOString();
  load('seats').forEach((r, i) => {
    if (r.slug !== slug) return;
    if (r.usid === usid) {
      patch('seats', i, { dvid: dvid, tmod: now });
    } else if (dvid && r.dvid === dvid) {
      patch('seats', i, { dvid: '', tmod: now });
    }
  });
}

// Upsert the device's one row — devices FIRST, before any write that
// references it (so a dangling reference is unmintable; a refusal
// after it leaves at worst a harmless orphan row) — and return its
// record index. Two disclosed ifs beyond the upsert itself: an
// unchanged blub costs no write, and a '' report never erases a
// known blub — ignorance is not news, the device didn't stop being
// a Mac. '' dvid (old clients, nobody) touches nothing: -1.
function touchDevice(dvid, anym) {
  if (!dvid) return -1;
  const now = new Date().toISOString();
  const i = load('devices').findIndex(r => r.dvid === dvid);
  if (i === -1) {
    return insert('devices', { dvid: dvid, anym: anym,
                               tini: now, tmod: now });
  }
  if (anym && load('devices')[i].anym !== anym) {
    patch('devices', i, { anym: anym, tmod: now });
  }
  return i;
}

// The holder's anym, RAW from its devices row ('' when the device
// never described itself; the client's mystery-device fallback
// decorates it), for the seat-taken refusal that names who beat you
function holderAnym(slug, usid) {
  const dev = load('devices')
    .find(r => r.dvid === deviceOf(slug, usid));
  return dev === undefined ? '' : dev.anym;
}

function placeBid(req) {
  const slug = cleanSlug(req.slug);
  const usid = cleanUsid(req.usid);
  const snym = cleanSnym(req.snym);  // the label, for walk-on seats
  const bid = String(req.xbid == null ? '' : req.xbid).trim();
  if (!bid) throw { code: 'emptyBid' };
  if (bid.length > 160) throw { code: 'bidTooLong' };
  // The gavel drop is a bright line: no bid lands after tfin. This is
  // also the explicit loss notice for an under-the-wire revision that
  // arrived a beat too late.
  if (getState(slug).revealed) {
    throw { code: 'gavelFell' };
  }
  const dvid = req.dvid === undefined ? ''
    : cleanDvid(req.dvid);
  const anym = cleanAnym(req.anym);
  const held = deviceOf(slug, usid);

  // bidding claims a roster seat: your own bid must never read as
  // not-counting (a bid rebuilds its seat if a raced removal took
  // it). A WALK-ON bid (no seat for this usid yet) whose label is
  // already seated under someone else's usid is a doppelganger,
  // refused.
  // Bidding as someone is claiming to be them, and claims are first
  // come, first served: a bid may not touch a seat someone else holds.
  // Old clients carry no dvid and count as nobody — fine on an
  // open seat, refused on a held one.
  if (held && held !== dvid) {
    throw { code: 'bidSeatHeld', anym: holderAnym(slug, usid),
            snym: snym };
  }
  const twin = seatByName(slug, snym);
  if (seatIndex(slug, usid) === -1 && twin && twin.usid !== usid) {
    throw { code: 'nameTaken' };
  }
  // no partial writes: every row this bid may append is capacity-
  // checked BEFORE the first one lands (a refusal must not leave a
  // half-created seat)
  assertRoom('bids');
  if (seatIndex(slug, usid) === -1) assertRoom('seats');
  touchDevice(dvid, anym);  // devices first, always
  ensureAuction(slug);
  ensureSeat(slug, usid, snym);
  if (dvid) {
    setDvid(slug, usid, dvid);
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
  const at = insert('bids', { slug: slug, usid: usid, xbid: bid,
                              tbid: tbid, dvid: dvid });
  // seal THIS submission white-on-white as it lands — one write, not
  // a repaint of the whole pile (its elders were sealed at their own
  // appends; reveal() unmasks the lot)
  sealBid(at);
  return getState(slug);
}
