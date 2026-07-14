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

// Particle names for fresh auction anames. (tauction/tau, get it?)
const ANAMES = [
  'tau', 'muon', 'quark', 'gluon', 'photon', 'boson', 'higgs', 'lepton',
  'hadron', 'baryon', 'meson', 'pion', 'kaon', 'axion', 'fermion',
  'neutrino', 'positron', 'electron', 'proton', 'neutron', 'graviton',
  'tachyon', 'soliton', 'instanton', 'skyrmion', 'anyon', 'preon',
  'pomeron', 'glueball', 'sphaleron', 'dilaton', 'inflaton', 'majoron',
  'curvaton', 'axino', 'gluino', 'squark', 'photino', 'gravitino',
  'neutralino', 'charm', 'strange', 'top', 'bottom', 'phonon', 'exciton',
  'plasmon', 'magnon', 'polaron', 'spinon', 'holon',
];

const AUCTIONS_HEAD = ['aname', 'roster', 'created', 'updated', 'revealed'];
const BIDS_HEAD     = ['aname', 'uname', 'bid', 'created', 'updated', 'subs'];

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
      case 'fresh':    return { aname: freshAname() };
      case 'state':    return getState(cleanAname(req.aname));
      case 'bid':      return withLock(() => placeBid(req));
      case 'settings': return withLock(() => saveSettings(req));
      case 'reveal':   return withLock(() => reveal(req));
      case undefined:  return { ok: 'tauction API is live',
                                try: '?action=state&aname=tau' };
      default:         return { error: 'unknown action: ' + req.action };
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
  if (!/^[a-z0-9]{1,40}$/.test(s)) throw 'auction name must be alphanumeric';
  return s;
}

function cleanUname(s) {
  s = String(s || '').toLowerCase();
  if (!/^[a-z][a-z0-9]{0,29}$/.test(s)) {
    throw 'username must be alphanumeric and start with a letter';
  }
  return s;
}

/* ---------------------------- sheet access ---------------------------- */

function tab(name, headers) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    // Format as plain text so bids like "007" don't get mangled into numbers
    sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(1, 8).setValue("IT'S CHEATING TO LOOK HERE DURING AN AUCTION")
      .setFontSize(24).setFontWeight('bold').setFontColor('#b3261e');
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
    throw 'not ready to reveal: everyone on the roster (at least two people) must bid first';
  }
  const sh = auctionsTab();
  const i = rows(sh).findIndex(r => r[0] === aname);
  sh.getRange(i + 2, 5).setValue('1');
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
function bidsTab()     { return tab('bids', BIDS_HEAD); }

// Data rows (sans header) as arrays of strings
function rows(sh) {
  return sh.getDataRange().getValues().slice(1).map(r => r.map(String));
}

/* ------------------------------ actions ------------------------------- */

function getState(aname) {
  const arow = rows(auctionsTab()).find(r => r[0] === aname);
  const roster = arow && arow[1] ? arow[1].split(',').filter(Boolean) : [];

  const brows = rows(bidsTab()).filter(r => r[0] === aname);
  // updated stamps let clients notice re-bids (and animate accordingly);
  // subs counts (re)submissions — an existing row implies at least one
  // submission, so rows predating the subs column floor at 1, never 0
  const bidders = brows.map(r =>
    ({ uname: r[1], updated: r[4], subs: parseInt(r[5], 10) || 1 }));
  const unames = bidders.map(b => b.uname);

  // Reveal is a human act (the 'reveal' action) and a one-way latch: it
  // never happens automatically, and once bids have been seen, nothing can
  // reseal them. A complete roster merely makes the reveal button pressable.
  const revealed = arow ? arow[4] === '1' : false;

  return {
    aname: aname, roster: roster, bidders: bidders, revealed: revealed,
    bids: revealed ? brows.map(r => ({ uname: r[1], bid: r[2] })) : null,
  };
}

function placeBid(req) {
  const aname = cleanAname(req.aname);
  const uname = cleanUname(req.uname);
  const bid = String(req.bid == null ? '' : req.bid).trim();
  if (!bid) throw 'bid is empty';
  if (bid.length > 80) throw 'bid too long (80 characters max)';

  joinRoster(aname, uname);

  const sh = bidsTab();
  const brows = rows(sh);
  const now = new Date().toISOString();
  const i = brows.findIndex(r => r[0] === aname && r[1] === uname);
  if (i !== -1) {  // re-bid: overwrite, keep created, bump updated + subs
    const subs = (parseInt(brows[i][5], 10) || 1) + 1;  // legacy rows: >= 1
    sh.getRange(i + 2, 3, 1, 4)
      .setValues([[bid, brows[i][3], now, String(subs)]]);
  } else {
    sh.appendRow([aname, uname, bid, now, now, '1']);
  }
  const st = getState(aname);
  repaintBids(aname, st.revealed);
  return st;
}

function saveSettings(req) {
  const aname = cleanAname(req.aname);
  const roster = (req.roster || []).map(cleanUname)
    .filter((u, i, a) => a.indexOf(u) === i);  // dedupe

  const sh = auctionsTab();
  const arows = rows(sh);
  const now = new Date().toISOString();
  const i = arows.findIndex(r => r[0] === aname);
  if (i !== -1) {
    sh.getRange(i + 2, 2, 1, 3)
      .setValues([[roster.join(','), arows[i][2], now]]);
  } else {
    sh.appendRow([aname, roster.join(','), now, now, '']);
  }
  const st = getState(aname);
  repaintBids(aname, st.revealed);
  return st;
}

// Bidding claims a roster seat: your own bid must never read as
// not-counting. (Removal-after-bid is the only road to a crossed-out row,
// and re-bidding takes the seat back.)
function joinRoster(aname, uname) {
  const sh = auctionsTab();
  const arows = rows(sh);
  const now = new Date().toISOString();
  const i = arows.findIndex(r => r[0] === aname);
  if (i === -1) {
    sh.appendRow([aname, uname, now, now, '']);
    return;
  }
  const roster = arows[i][1] ? arows[i][1].split(',').filter(Boolean) : [];
  if (roster.indexOf(uname) === -1) {
    roster.push(uname);
    sh.getRange(i + 2, 2, 1, 3)
      .setValues([[roster.join(','), arows[i][2], now]]);
  }
}

function freshAname() {
  const used = {};
  rows(auctionsTab()).forEach(r => used[r[0]] = true);
  rows(bidsTab()).forEach(r => used[r[0]] = true);
  const free = ANAMES.filter(s => !used[s]);
  if (free.length) return free[Math.floor(Math.random() * free.length)];
  for (let i = 0; i < 100; i++) {  // all particles taken: suffix a number
    const s = ANAMES[Math.floor(Math.random() * ANAMES.length)]
            + Math.floor(Math.random() * 1000);
    if (!used[s]) return s;
  }
  throw 'could not find a fresh aname!?';
}

// Run this once from the Apps Script editor to trigger the permissions
// prompt if you ever set this project up manually (clasp handles it
// otherwise).
function authorize() {
  Logger.log(JSON.stringify(handle({ action: 'state', aname: 'tau' })));
}
