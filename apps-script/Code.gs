// Tauction API — Google Apps Script web app fronting the spreadsheet.
//
// Setup (one time):
//   1. Open the sheet -> Extensions -> Apps Script, paste this file over Code.gs
//   2. Run the `authorize` function once from the editor and click through
//      the permissions prompt (it's your own script touching your own sheet)
//   3. Deploy -> New deployment -> type: Web app
//        Execute as: Me
//        Who has access: Anyone
//   4. Copy the /exec URL into the API constant at the top of app.js
//
// After editing this file later: Deploy -> Manage deployments -> pencil icon
// -> Version: New version. (The /exec URL stays the same.)

const SHEET_ID = '1hclphAZ3zQIq14Nip1ZxTDSoE9ygXqAv27RwP1hiMA8';

// Particle names for fresh auction slugs. (tauction/tau, get it?)
const SLUGS = [
  'tau', 'muon', 'quark', 'gluon', 'photon', 'boson', 'higgs', 'lepton',
  'hadron', 'baryon', 'meson', 'pion', 'kaon', 'axion', 'fermion',
  'neutrino', 'positron', 'electron', 'proton', 'neutron', 'graviton',
  'tachyon', 'soliton', 'instanton', 'skyrmion', 'anyon', 'preon',
  'pomeron', 'glueball', 'sphaleron', 'dilaton', 'inflaton', 'majoron',
  'curvaton', 'axino', 'gluino', 'squark', 'photino', 'gravitino',
  'neutralino', 'charm', 'strange', 'top', 'bottom', 'phonon', 'exciton',
  'plasmon', 'magnon', 'polaron', 'spinon', 'holon',
];

const AUCTIONS_HEAD = ['auction', 'mode', 'n', 'roster', 'created', 'updated'];
const BIDS_HEAD     = ['auction', 'name', 'bid', 'created', 'updated'];

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
      case 'fresh':    return { slug: freshSlug() };
      case 'state':    return getState(cleanSlug(req.auction));
      case 'bid':      return withLock(() => placeBid(req));
      case 'settings': return withLock(() => saveSettings(req));
      case undefined:  return { ok: 'tauction API is live',
                                try: '?action=state&auction=tau' };
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

function cleanSlug(s) {
  s = String(s || '').toLowerCase();
  if (!/^[a-z0-9]{1,40}$/.test(s)) throw 'auction slug must be alphanumeric';
  return s;
}

function cleanName(s) {
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
  }
  return sh;
}

function auctionsTab() { return tab('auctions', AUCTIONS_HEAD); }
function bidsTab()     { return tab('bids', BIDS_HEAD); }

// Data rows (sans header) as arrays of strings
function rows(sh) {
  return sh.getDataRange().getValues().slice(1).map(r => r.map(String));
}

/* ------------------------------ actions ------------------------------- */

function getState(slug) {
  const arow = rows(auctionsTab()).find(r => r[0] === slug);
  const mode = arow && arow[1] === 'roster' ? 'roster' : 'count';
  const n = arow ? Math.max(1, parseInt(arow[2], 10) || 1) : 2;
  const roster = arow && arow[3] ? arow[3].split(',').filter(Boolean) : [];

  const brows = rows(bidsTab()).filter(r => r[0] === slug);
  const bidders = brows.map(r => r[1]);

  const revealed = mode === 'roster'
    ? roster.length > 0 && roster.every(u => bidders.indexOf(u) !== -1)
    : bidders.length >= n;

  return {
    slug: slug, mode: mode, n: n, roster: roster, bidders: bidders,
    revealed: revealed,
    bids: revealed ? brows.map(r => ({ name: r[1], bid: r[2] })) : null,
  };
}

function placeBid(req) {
  const slug = cleanSlug(req.auction);
  const name = cleanName(req.name);
  const bid = String(req.bid == null ? '' : req.bid).trim();
  if (!bid) throw 'bid is empty';
  if (bid.length > 80) throw 'bid too long (80 characters max)';

  if (getState(slug).revealed) {
    throw 'this auction is already revealed — bids are locked';
  }

  ensureAuctionRow(slug);

  const sh = bidsTab();
  const brows = rows(sh);
  const now = new Date().toISOString();
  const i = brows.findIndex(r => r[0] === slug && r[1] === name);
  if (i !== -1) {  // re-bid: overwrite, keep created, bump updated
    sh.getRange(i + 2, 3, 1, 3).setValues([[bid, brows[i][3], now]]);
  } else {
    sh.appendRow([slug, name, bid, now, now]);
  }
  return getState(slug);
}

function saveSettings(req) {
  const slug = cleanSlug(req.auction);
  const mode = req.mode === 'roster' ? 'roster' : 'count';
  const n = Math.max(1, parseInt(req.n, 10) || 2);
  const roster = (req.roster || []).map(cleanName)
    .filter((u, i, a) => a.indexOf(u) === i);  // dedupe

  if (getState(slug).revealed) {
    throw 'this auction is already revealed — settings are locked';
  }

  const sh = auctionsTab();
  const arows = rows(sh);
  const now = new Date().toISOString();
  const i = arows.findIndex(r => r[0] === slug);
  if (i !== -1) {
    sh.getRange(i + 2, 2, 1, 5)
      .setValues([[mode, String(n), roster.join(','), arows[i][4], now]]);
  } else {
    sh.appendRow([slug, mode, String(n), roster.join(','), now, now]);
  }
  return getState(slug);
}

// First bid on a never-configured auction materializes a default settings row
function ensureAuctionRow(slug) {
  const sh = auctionsTab();
  if (!rows(sh).some(r => r[0] === slug)) {
    const now = new Date().toISOString();
    sh.appendRow([slug, 'count', '2', '', now, now]);
  }
}

function freshSlug() {
  const used = {};
  rows(auctionsTab()).forEach(r => used[r[0]] = true);
  rows(bidsTab()).forEach(r => used[r[0]] = true);
  const free = SLUGS.filter(s => !used[s]);
  if (free.length) return free[Math.floor(Math.random() * free.length)];
  for (let i = 0; i < 100; i++) {  // all particles taken: suffix a number
    const s = SLUGS[Math.floor(Math.random() * SLUGS.length)]
            + Math.floor(Math.random() * 1000);
    if (!used[s]) return s;
  }
  throw 'could not find a fresh slug!?';
}

// Run this once from the Apps Script editor to trigger the permissions
// prompt before deploying.
function authorize() {
  Logger.log(JSON.stringify(handle({ action: 'state', auction: 'tau' })));
}
