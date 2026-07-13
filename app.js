'use strict';

/* ------------------------------- config ------------------------------- */

// Vocabulary: "aname" = an auction's name, which is also its URL slug;
// "uname" = a bidder's username, shown with an @ in the UI.

// Paste your Apps Script web-app URL here (Deploy -> Web app -> the /exec URL):
const API = 'https://script.google.com/macros/s/AKfycbyJgizZYhYuIj5ASpcV-0Y2MiCCjgGTyi7zEV29wVCf1BNf73b5VLQlrzU2FBGgpCXKLw/exec';

// Fallback anames for when the API isn't configured yet; the server holds
// the master list and picks fresh anames that avoid existing auctions.
const ANAMES = [
  'tau', 'muon', 'quark', 'gluon', 'photon', 'boson', 'higgs', 'lepton',
  'hadron', 'baryon', 'meson', 'pion', 'kaon', 'axion', 'fermion',
  'neutrino', 'positron', 'electron', 'proton', 'neutron', 'graviton',
];

// For testing before editing this file: tauction.dreev.es/?api=https://...
const api = new URLSearchParams(location.search).get('api') || API;
const configured = /^https:\/\//.test(api);

const POLL_MS = 5000;

const NO_BID = 'waiting';
const SLOT = 'bidder ';
const MASK = '•••••';

/* ------------------------------ helpers ------------------------------- */

const $ = (id) => document.getElementById(id);

function assert(cond, msg) { if (!cond) throw new Error('assert: ' + msg); }

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function splur(x, sing, plur) { return x + ' ' + (x === 1 ? sing : plur); }

const sanAname = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
const sanUname = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
                         .replace(/^[0-9]+/, '').slice(0, 30);

async function apiGet(params) {
  const r = await fetch(api + '?' + new URLSearchParams(params));
  return r.json();
}

// Body as a plain string => "simple" CORS request, no preflight (Apps Script
// web apps can't answer preflights)
async function apiPost(body) {
  const r = await fetch(api, { method: 'POST', body: JSON.stringify(body) });
  return r.json();
}

let bannerTimer = null;
function banner(msg, kind) {
  const b = $('banner');
  b.textContent = msg;
  b.className = kind || 'err';
  b.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { b.hidden = true; }, 5000);
}

/* ------------------------------- state -------------------------------- */

let aname = '';
let state = null;         // latest server snapshot of the current auction
let roster = [];          // local working copy of the roster chips
let seen = {};            // uname -> updated stamp at last render (shimmer)
let settingsDirty = 0;    // when the user last touched settings locally
let settingsTimer = null;
let anameTimer = null;
let refreshing = false;

const BID_HINT = $('bid').placeholder;  // stock hint, restored when no own bid

function setPath(a) {
  history.replaceState(null, '', '/' + a + location.search);
}

// Validate + adopt a state snapshot from the server
function ingest(res) {
  assert(Array.isArray(res.bidders) && res.bidders.every(
    (b) => typeof b.uname === 'string' && typeof b.updated === 'string'),
    'bad state shape — is the deployed Code.gs current?');
  state = res;
}

async function refresh() {
  if (!configured || refreshing) return;
  refreshing = true;
  try {
    const res = await apiGet({ action: 'state', aname: aname });
    if (res.error) banner(res.error);
    else if (res.aname === aname) { ingest(res); render(); }  // ignore stale
  } catch (e) {
    banner('network hiccup: ' + e.message);
  } finally {
    refreshing = false;
  }
}

/* ------------------------------ rendering ----------------------------- */

function render() {
  if (!state) return;
  renderStatus();
  renderSettings();
  renderMine();
}

// You are whoever the name field says you are
function me() { return sanUname($('uname').value); }

// The bid you placed on this auction, if this browser placed one
function myBid() {
  return JSON.parse(localStorage.getItem('tauction-mybid:' + aname) || 'null');
}

// Bids whose text this client knows: your own, plus everyone's once
// revealed. Tiles render whatever is known and mask the rest — the same
// rule makes your bid visible to you and sealed for everyone else.
function knownBids() {
  const known = {};
  const mine = myBid();
  if (mine) known[mine.uname] = mine.bid;
  (state.bids || []).forEach((b) => { known[b.uname] = b.bid; });
  return known;
}

// One tile per expected bidder. Roster mode: the roster plus any walk-on
// bidders. Count mode: actual bidders, then you (if named and not among
// them), then anonymous numbered slots up to n.
function slotUnames() {
  const unames = state.bidders.map((b) => b.uname);
  if (state.mode === 'roster') {
    return state.roster.concat(unames.filter((u) => !state.roster.includes(u)));
  }
  if (me() && !unames.includes(me()) && unames.length < state.n) unames.push(me());
  while (unames.length < state.n) unames.push(null);
  return unames;
}

function tilesEl() {
  const grid = el('div', 'tiles');
  const known = knownBids();
  const stamps = {};
  state.bidders.forEach((b) => { stamps[b.uname] = b.updated; });
  const nextSeen = {};
  slotUnames().forEach((uname, i) => {
    const t = el('div', 'tile');
    t.append(el('div', 'tile-name', uname === null ? SLOT + (i + 1) : '@' + uname));
    const stamp = stamps[uname];
    t.classList.toggle('has-bid', stamp !== undefined);
    t.classList.toggle('updated',
      seen[uname] !== undefined && seen[uname] !== stamp);
    t.append(el('div', 'tile-bid',
      stamp === undefined ? NO_BID
        : known[uname] !== undefined ? known[uname] : MASK));
    grid.append(t);
    nextSeen[uname] = stamp;
  });
  seen = nextSeen;
  return grid;
}

function chipList(unames) {
  const frag = document.createDocumentFragment();
  unames.forEach((u) => frag.append(el('span', 'chip', '@' + u), ' '));
  return frag;
}

function statusMsg() {
  if (state.revealed) return el('p', 'card-title', 'Results ⚡');
  const got = state.bidders.map((b) => b.uname);
  const msg = el('p', 'msg');
  if (state.mode === 'count') {
    msg.append('Got bids from ' + splur(got.length, 'person', 'people')
      + ', waiting on ' + (state.n - got.length) + '.');
  } else if (state.roster.length === 0) {
    msg.append('No required bidders listed yet — add some above.');
  } else {
    const waiting = state.roster.filter((u) => !got.includes(u));
    if (got.length === 0) {
      msg.append('No bids yet; waiting on ', chipList(waiting));
    } else {
      msg.append('Got bids from ', chipList(got),
                 ', waiting on ', chipList(waiting));
    }
    msg.append('.');
  }
  return msg;
}

function renderStatus() {
  const box = $('status');
  box.hidden = false;
  box.replaceChildren(statusMsg(), tilesEl());
}

// Your current bid doubles as the placeholder, ready to edit and resubmit
function renderMine() {
  const mine = myBid();
  $('bid').placeholder = mine && mine.uname === me() ? mine.bid : BID_HINT;
}

// Don't clobber the settings controls while the user is mid-edit
function settingsBusy() {
  const focused = document.activeElement;
  return Date.now() - settingsDirty < 4000
    || focused === $('n') || focused === $('roster-input');
}

function renderSettings() {
  if (settingsBusy()) return;
  $('mode-count').checked = state.mode === 'count';
  $('mode-roster').checked = state.mode === 'roster';
  $('n').value = state.n;
  roster = state.roster.slice();
  renderChips();
}

function renderChips() {
  const box = $('chips');
  box.replaceChildren();
  for (const uname of roster) {
    const chip = el('span', 'chip', '@' + uname);
    const x = el('button', 'x', '×');
    x.type = 'button';
    x.title = 'remove @' + uname;
    x.addEventListener('click', () => {
      roster = roster.filter((u) => u !== uname);
      renderChips();
      settingsChanged();
    });
    chip.append(x);
    box.append(chip);
  }
}

/* ------------------------------ actions ------------------------------- */

async function placeBid() {
  const uname = sanUname($('uname').value);
  const bid = $('bid').value.trim();
  if (!uname) return banner('name must be alphanumeric, starting with a letter');
  if (!bid) return banner('bid is empty');
  localStorage.setItem('tauction-uname', uname);
  $('uname').value = uname;
  $('place').disabled = true;
  try {
    const res = await apiPost({ action: 'bid', aname: aname, uname: uname, bid: bid });
    if (res.error) return banner(res.error);
    localStorage.setItem('tauction-mybid:' + aname,
                         JSON.stringify({ uname: uname, bid: bid }));
    $('bid').value = '';
    if (res.aname === aname) { ingest(res); render(); }
    banner('Bid placed ✓', 'ok');
  } catch (e) {
    banner('network hiccup: ' + e.message);
  } finally {
    $('place').disabled = false;
  }
}

function settingsChanged() {
  settingsDirty = Date.now();
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(pushSettings, 700);
}

async function pushSettings() {
  if (!configured) return;
  const body = {
    action: 'settings',
    aname: aname,
    mode: $('mode-roster').checked ? 'roster' : 'count',
    n: Math.max(1, parseInt($('n').value, 10) || 1),
    roster: roster,
  };
  try {
    const res = await apiPost(body);
    if (res.error) return banner(res.error);
    if (res.aname === aname) { ingest(res); renderStatus(); }
  } catch (e) {
    banner('network hiccup: ' + e.message);
  }
}

function addRosterChip() {
  const uname = sanUname($('roster-input').value);
  $('roster-input').value = '';
  if (!uname || roster.includes(uname)) return;
  roster.push(uname);
  $('mode-roster').checked = true;  // adding people implies roster mode
  renderChips();
  settingsChanged();
}

function switchAuction(a) {
  if (!a || a === aname) return;
  aname = a;
  setPath(aname);
  state = null;
  roster = [];
  seen = {};
  settingsDirty = 0;
  $('status').hidden = true;
  renderMine();
  refresh();
}

/* ------------------------------- wiring ------------------------------- */

function wireUp() {
  $('bid-form').addEventListener('submit', (e) => {
    e.preventDefault();
    placeBid();
  });

  $('aname').addEventListener('input', () => {
    const v = sanAname($('aname').value);
    if (v !== $('aname').value) $('aname').value = v;
    clearTimeout(anameTimer);
    anameTimer = setTimeout(() => switchAuction(v), 500);
  });

  $('uname').addEventListener('input', () => {
    const v = sanUname($('uname').value);
    if (v !== $('uname').value) $('uname').value = v;
    if (state) renderStatus();  // your gray tile tracks the name field
  });

  $('mode-count').addEventListener('change', settingsChanged);
  $('mode-roster').addEventListener('change', settingsChanged);
  $('n').addEventListener('input', () => {
    $('mode-count').checked = true;  // editing n implies count mode
    settingsChanged();
  });

  $('roster-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
      e.preventDefault();
      addRosterChip();
    }
  });
  $('roster-input').addEventListener('blur', addRosterChip);
  $('roster-input').addEventListener('input', () => {
    const v = $('roster-input').value;
    const s = sanUname(v);
    if (s !== v) $('roster-input').value = s;
  });
}

async function init() {
  wireUp();

  const m = location.pathname.match(/^\/([a-zA-Z0-9]{1,40})\/?$/);
  if (m) {
    aname = m[1].toLowerCase();
  } else if (configured) {
    try { aname = (await apiGet({ action: 'fresh' })).aname; } catch (e) { /* fall through */ }
  }
  if (!aname) aname = ANAMES[Math.floor(Math.random() * ANAMES.length)];
  setPath(aname);
  $('aname').value = aname;
  $('uname').value = localStorage.getItem('tauction-uname') || '';
  renderMine();

  if (!configured) {
    banner('No API configured — set the API constant in app.js (see README).');
    return;
  }

  await refresh();
  setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, POLL_MS);
}

init();
