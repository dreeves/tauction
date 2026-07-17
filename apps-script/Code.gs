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
// time-modified, tfin = time-final (the reveal moment), bcount = the
// (re)submission count, deviceID = the claiming browser's anonymous
// uuid, deviceBlurb = its self-description ("a Mac (Chrome)").
const AUCTIONS_HEAD = ['aname', 'tini', 'tmod', 'tfin', 'blurb',
                       'tblurb'];
const BIDS_HEAD     = ['aname', 'uname', 'bid', 'bcount', 'tini', 'tmod'];
// A users row IS a roster seat; future per-person attributes
// (weights/shares) append as columns to the right, which positional
// reads tolerate.
const USERS_HEAD    = ['aname', 'uname', 'deviceID', 'deviceBlurb',
                       'tini', 'tmod'];

// Microcopy (the server half of stringles.js): everything user-visible
// that this file generates. Throw strings land verbatim in the client's
// error banner. stringles.js can't be shared across the deployment
// boundary, so this block mirrors its role — edit copy here as freely.
// The ERROR-numbered prefixes are load-bearing (the client quietly
// swallows /^ERROR1304/ as an expected seat race); keep them.
const badAnameCopy = 'auction name must be alphanumeric';
const badUnameCopy = 'username must be alphanumeric and start with a letter';
const badDeviceCopy = 'bad deviceID';
const badDevBlurbCopy = 'bad deviceBlurb';
const unknownActionCopy = (action) => 'unknown action: ' + action;
const notReadyCopy = 'not ready to reveal: everyone on the roster'
  + ' (at least two people) must bid first';
const blurbTooLongCopy = 'blurb too long (2000 chars max)';
// must match stringles.js simulEditsBanner EXACTLY (a qual checks):
// the client shows the same words for locally- and remotely-detected
// simultaneous edits, so back-to-back banners read as one message
const simulEditsCopy =
  'Oops, someone else is making simultaneous edits to the description';
const rosterClosedCopy = 'Auction complete — no new participants';
const nameTakenCopy = 'That name is taken';
const noSuchOneCopy = (from) => 'No such participant: ' + from;
const claimNeedsDeviceCopy = 'ERROR1303: claim requires a deviceID';
const seatHeldCopy = (blurb) =>
  'ERROR1304: Claimed by someone (' + blurb + ')';
const releaseNeedsDeviceCopy = 'ERROR1305: release requires a deviceID';
const notYourSeatCopy = 'ERROR1306: Can this error ever happen?'
  + ' Disclaiming yourself as a participant failed?';
const emptyBidCopy = 'Bid is empty';
const bidTooLongCopy = 'bid too long (80 characters max)';
const gavelFellCopy =
  'Womp Womp! The auction closed before your bid got through';
const bidSeatHeldCopy = (blurb) =>
  'ERROR1312: Claimed by someone (' + blurb + ')';
// operator-facing (dreev sees this, users only if very unlucky): the
// sheet's tabs predate the running code's schema
const schemaDriftCopy = (name, got, want) =>
  'schema drift: the "' + name + '" tab\'s headers are [' + got
  + '] but this code expects [' + want + '] — rename the tab for'
  + ' posterity (or delete it) and retry: the script rebuilds it fresh';
// a holder whose claim carried no self-description (must match
// stringles.js mysteryDevice: it's the same rig-naming fallback)
const mysteryDeviceCopy = 'mystery device';

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

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ---------------------------- validation ------------------------------ */

function cleanAname(s) {
  s = String(s || '').toLowerCase();
  if (!/^[a-z0-9]{1,40}$/.test(s)) throw badAnameCopy;
  return s;
}

function cleanUname(s) {
  s = String(s || '').toLowerCase();
  if (!/^[a-z][a-z0-9]{0,29}$/.test(s)) {
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

// The claimant's self-reported rig ("a Mac (Chrome)") — decoration for
// the who-claimed-this tooltip, printable ASCII only. (Apps Script web
// apps can't read request headers, so the client must tell us; honor
// system, like everything.)
function cleanBlurb(s) {
  s = String(s == null ? '' : s);
  if (!/^[ -~]{0,64}$/.test(s)) throw badDevBlurbCopy;
  return s;
}

/* ---------------------------- sheet access ---------------------------- */

// Which tabs this execution already header-checked. Globals reset per
// Apps Script execution, so this only spares the repeat tab() calls
// within one request (each check costs a Sheets read).
const tabsChecked = {};

function tab(name, headers, warning) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sh = ss.getSheetByName(name);
  if (sh && !tabsChecked[name]) {
    // The header row IS the schema. Everything reads positionally, so
    // a drifted tab would misread every row — refuse loudly
    // instead. Only the first headers.length cells count: columns
    // appended to the right (and the cheater banner) are legal.
    const got = sh.getRange(1, 1, 1, headers.length).getValues()[0]
      .map(String);
    if (!headers.every((h, i) => got[i] === h)) {
      throw schemaDriftCopy(name, got.join(', '), headers.join(', '));
    }
  }
  tabsChecked[name] = true;
  if (!sh) {
    sh = ss.insertSheet(name);
    // Format as plain text so bids like "007" don't get mangled into numbers
    sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@');
    // headers: bold monospace on a quiet tinted band, frozen in place
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setFontFamily('Roboto Mono')
      .setBackground('#f1f3f4');
    sh.setFrozenRows(1);
    if (warning) {
      sh.getRange(1, headers.length + 1).setValue(warning)
        .setFontSize(24).setFontWeight('bold').setFontColor('#b3261e');
    }
  }
  return sh;
}

// The reveal button. Anyone may press it once the roster is complete —
// at least two people, all with bids in. Idempotent, and permanent.
function reveal(req) {
  const aname = cleanAname(req.aname);
  const st = getState(aname);
  if (st.revealed) return st;  // racing presses: both succeed
  const unames = st.bidders.map(b => b.uname);
  if (!(st.roster.length >= 2
        && st.roster.every(u => unames.indexOf(u) !== -1))) {
    throw notReadyCopy;
  }
  const sh = auctionsTab();
  const i = rows(sh).findIndex(r => r[0] === aname);
  // the revealed column holds the moment itself (legacy rows hold '1')
  sh.getRange(i + 2, 4).setValue(new Date().toISOString());
  repaintBids(aname, true);
  return getState(aname);
}

// Sealed bids are painted white-on-white in the sheet; revealed bids get
// their color back. Purely cosmetic — the honor system's honor system.
function repaintBids(aname, revealed) {
  const sh = bidsTab();
  rows(sh).forEach((r, i) => {
    if (r[0] === aname) {
      sh.getRange(i + 2, 3).setFontColor(revealed ? null : '#ffffff');
    }
  });
}

function auctionsTab() { return tab('auctions', AUCTIONS_HEAD); }
function bidsTab() {
  // the bids tab is where peeking would spoil the sealing; warn there only
  return tab('bids', BIDS_HEAD,
    "IT'S CHEATING TO LOOK HERE DURING AN AUCTION");
}
function usersTab() { return tab('users', USERS_HEAD); }

// Data rows (sans header) as arrays of strings
function rows(sh) {
  return sh.getDataRange().getValues().slice(1).map(r => r.map(String));
}

/* ------------------------------ actions ------------------------------- */

function getState(aname) {
  const arow = rows(auctionsTab()).find(r => r[0] === aname);

  // The roster IS the users rows (in insertion order), and the claims
  // map rides along: uname -> deviceID for seats someone holds
  const roster = [];
  const claims = {};
  const blurbs = {};  // uname -> the holder's self-reported rig
  rows(usersTab()).forEach(r => {
    if (r[0] !== aname) return;
    roster.push(r[1]);
    if (r[2]) claims[r[1]] = r[2];
    if (r[2] && r[3]) blurbs[r[1]] = r[3];
  });

  const brows = rows(bidsTab()).filter(r => r[0] === aname);
  // tini + tmod stamps let clients notice re-bids (and animate
  // accordingly) and tell you when a bid first landed vs last changed;
  // bcount counts (re)submissions — an existing row implies at least
  // one submission, so a blank bcount floors at 1, never 0
  const bidders = brows.map(r =>
    ({ uname: r[1], bcount: parseInt(r[3], 10) || 1,
       tini: r[4], tmod: r[5] }));

  // Reveal is a human act (the 'reveal' action) and a one-way latch: it
  // never happens automatically, and once bids have been seen, nothing can
  // reseal them. A complete roster merely makes the reveal button pressable.
  const tfin = arow ? arow[3] : '';  // the reveal moment, ISO
  const revealed = tfin !== '';
  const blurb = arow ? arow[4] || '' : '';   // freeform markdown
  const tblurb = arow ? arow[5] || '' : '';  // its own edit stamp (CAS)

  return {
    aname: aname, roster: roster, bidders: bidders, revealed: revealed,
    tfin: tfin, blurb: blurb, tblurb: tblurb,
    claims: claims, blurbs: blurbs,
    bids: revealed ? brows.map(r => ({ uname: r[1], bid: r[2] })) : null,
  };
}

// Make sure the auction has its settings row (created/updated/revealed)
function touchAuction(aname) {
  const sh = auctionsTab();
  const arows = rows(sh);
  const now = new Date().toISOString();
  const i = arows.findIndex(r => r[0] === aname);
  if (i === -1) sh.appendRow([aname, now, now, '']);
  else sh.getRange(i + 2, 3).setValue(now);
}

// Make sure a seat row exists; adding is idempotent
function ensureSeat(aname, uname) {
  const sh = usersTab();
  const now = new Date().toISOString();
  const i = rows(sh).findIndex(r => r[0] === aname && r[1] === uname);
  if (i === -1) sh.appendRow([aname, uname, '', '', now, now]);
}

// The auction blurb: freeform markdown, editable by anyone at any
// time — before or after the close. Concurrent edits are guarded by
// compare-and-swap: the request carries the tblurb stamp the edit was
// based on, and a stale base is refused loudly rather than silently
// clobbering someone's words.
function describe(req) {
  const aname = cleanAname(req.aname);
  const blurb = String(req.blurb == null ? '' : req.blurb);
  if (blurb.length > 2000) throw blurbTooLongCopy;
  touchAuction(aname);
  const sh = auctionsTab();
  const i = rows(sh).findIndex(r => r[0] === aname);
  const current = rows(sh)[i][5] || '';
  if (String(req.base == null ? '' : req.base) !== current) {
    throw simulEditsCopy;
  }
  sh.getRange(i + 2, 5, 1, 2)
    .setValues([[blurb, new Date().toISOString()]]);
  return getState(aname);
}

// The roster is CLOSED once revealed: the game is over, and a fresh
// participant could neither bid meaningfully nor be waited on.
function addParticipant(req) {
  const aname = cleanAname(req.aname);
  const uname = cleanUname(req.uname);
  if (getState(aname).revealed) throw rosterClosedCopy;
  touchAuction(aname);
  ensureSeat(aname, uname);
  return getState(aname);
}

// Renaming fixes a typo in place: the seat row re-keys (its claim
// device rides along) and any bid row re-keys with it, stamps and count
// intact. Renaming onto a name that's already seated is refused.
function renameParticipant(req) {
  const aname = cleanAname(req.aname);
  const from = cleanUname(req.from);
  const to = cleanUname(req.to);
  if (to === from) return getState(aname);
  const sh = usersTab();
  const prows = rows(sh);
  if (prows.some(r => r[0] === aname && r[1] === to)) {
    throw nameTakenCopy;
  }
  const i = prows.findIndex(r => r[0] === aname && r[1] === from);
  if (i === -1) throw noSuchOneCopy(from);
  const now = new Date().toISOString();
  sh.getRange(i + 2, 2).setValue(to);
  sh.getRange(i + 2, 6).setValue(now);  // tmod
  const bsh = bidsTab();
  const j = rows(bsh).findIndex(r => r[0] === aname && r[1] === from);
  if (j !== -1) bsh.getRange(j + 2, 2).setValue(to);
  touchAuction(aname);
  return getState(aname);
}

// Removing deletes the seat row; any bid row stays (a sealed bid is
// never deletable), which is what renders as a crossed-out line
function removeParticipant(req) {
  const aname = cleanAname(req.aname);
  const uname = cleanUname(req.uname);
  touchAuction(aname);
  const sh = usersTab();
  const i = rows(sh).findIndex(r => r[0] === aname && r[1] === uname);
  if (i !== -1) {
    // first remove: the seat goes, any bid stays (re-bidding rejoins)
    sh.deleteRow(i + 2);
  } else {
    // no seat = the row was ALREADY cut (a race or sheet tampering
    // left a zombie bid): removing it again is the recovery path —
    // purge the bid outright
    const bsh = bidsTab();
    const j = rows(bsh).findIndex(r => r[0] === aname && r[1] === uname);
    if (j !== -1) bsh.deleteRow(j + 2);
  }
  return getState(aname);
}

// Stake a claim on a seat — FIRST COME, FIRST SERVED: a seat held by
// another device refuses loudly (last-write-wins let a stale page
// silently steal a seat). Re-claiming your own seat is idempotent.
// One name per device: claiming a new seat releases any other seat
// this device held, radio-style. No auth: the device id is an
// anonymous marker whose only job is making every page agree who's
// taken.
function saveClaim(req) {
  const aname = cleanAname(req.aname);
  const uname = cleanUname(req.uname);
  const deviceID = cleanDeviceID(req.deviceID);
  if (!deviceID) throw claimNeedsDeviceCopy;
  touchAuction(aname);
  ensureSeat(aname, uname);
  const held = deviceOf(aname, uname);
  if (held && held !== deviceID) {
    throw seatHeldCopy(holderBlurb(aname, uname));
  }
  setDeviceID(aname, uname, deviceID, cleanBlurb(req.deviceBlurb));
  return getState(aname);
}

// Vacate a seat — only its holder may. An unheld seat releases as a
// no-op: a merely-local soft claim must release without drama.
function releaseClaim(req) {
  const aname = cleanAname(req.aname);
  const uname = cleanUname(req.uname);
  const deviceID = cleanDeviceID(req.deviceID);
  if (!deviceID) throw releaseNeedsDeviceCopy;
  touchAuction(aname);
  const held = deviceOf(aname, uname);
  if (held && held !== deviceID) {
    throw notYourSeatCopy;
  }
  if (held) setDeviceID(aname, uname, '');
  return getState(aname);
}

// The deviceID currently holding a seat ('' if open or no such seat)
function deviceOf(aname, uname) {
  const r = rows(usersTab()).find(
    (row) => row[0] === aname && row[1] === uname);
  return r ? r[2] : '';
}

function setDeviceID(aname, uname, deviceID, blurb) {
  const sh = usersTab();
  const now = new Date().toISOString();
  rows(sh).forEach((r, i) => {
    if (r[0] !== aname) return;
    if (r[1] === uname) {
      sh.getRange(i + 2, 3, 1, 4)
        .setValues([[deviceID, blurb || '', r[4], now]]);
    } else if (deviceID && r[2] === deviceID) {
      sh.getRange(i + 2, 3, 1, 4).setValues([['', '', r[4], now]]);
    }
  });
}

// The holder's rig, for refusal messages: every seat-taken error names
// who beat you to it
function holderBlurb(aname, uname) {
  const r = rows(usersTab()).find(
    (row) => row[0] === aname && row[1] === uname);
  return (r && r[3]) || mysteryDeviceCopy;
}

function placeBid(req) {
  const aname = cleanAname(req.aname);
  const uname = cleanUname(req.uname);
  const bid = String(req.bid == null ? '' : req.bid).trim();
  if (!bid) throw emptyBidCopy;
  if (bid.length > 80) throw bidTooLongCopy;
  // The gavel drop is a bright line: no bid lands after tfin. This is
  // also the explicit loss notice for an under-the-wire revision that
  // arrived a beat too late.
  if (getState(aname).revealed) {
    throw gavelFellCopy;
  }

  // bidding claims a roster seat: your own bid must never read as
  // not-counting (re-bidding takes a removed seat back, too)
  touchAuction(aname);
  ensureSeat(aname, uname);
  // Bidding as someone is claiming to be them, and claims are first
  // come, first served: a bid may not touch a seat someone else holds.
  // Old clients carry no deviceID and count as nobody — fine on an
  // open seat, refused on a held one.
  const deviceID = req.deviceID === undefined ? ''
    : cleanDeviceID(req.deviceID);
  const held = deviceOf(aname, uname);
  if (held && held !== deviceID) {
    throw bidSeatHeldCopy(holderBlurb(aname, uname));
  }
  if (deviceID) {
    setDeviceID(aname, uname, deviceID, cleanBlurb(req.deviceBlurb));
  }

  const sh = bidsTab();
  const brows = rows(sh);
  const now = new Date().toISOString();
  const i = brows.findIndex(r => r[0] === aname && r[1] === uname);
  if (i !== -1) {  // re-bid: overwrite, keep tini, bump tmod + bcount
    const bcount = (parseInt(brows[i][3], 10) || 1) + 1;
    sh.getRange(i + 2, 3, 1, 4)
      .setValues([[bid, String(bcount), brows[i][4], now]]);
  } else {
    sh.appendRow([aname, uname, bid, '1', now, now]);
  }
  const st = getState(aname);
  repaintBids(aname, st.revealed);
  return st;
}



// Run this once from the Apps Script editor to trigger the permissions
// prompt if you ever set this project up manually (clasp handles it
// otherwise).
function authorize() {
  Logger.log(JSON.stringify(handle({ action: 'state', aname: 'tau' })));
}
