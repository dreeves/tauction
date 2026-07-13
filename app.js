'use strict';

/* ------------------------------- config ------------------------------- */

// Paste your Apps Script web-app URL here (Deploy -> Web app -> the /exec URL):
const API = 'https://script.google.com/macros/s/AKfycbxW9MWBy_Q56GIoBnBwcHPdkXO5q15HU8qxpwD9uvxbRbeQPkqZGwRx97Jza_5ZsZwvjA/exec';

// Fallback slugs for when the API isn't configured yet; the server holds the
// master list and picks fresh slugs that avoid existing auctions.
const PARTICLES = [
  'tau', 'muon', 'quark', 'gluon', 'photon', 'boson', 'higgs', 'lepton',
  'hadron', 'baryon', 'meson', 'pion', 'kaon', 'axion', 'fermion',
  'neutrino', 'positron', 'electron', 'proton', 'neutron', 'graviton',
];

// For testing before editing this file: tauction.dreev.es/?api=https://...
const api = new URLSearchParams(location.search).get('api') || API;
const configured = /^https:\/\//.test(api);

const POLL_MS = 5000;

/* ------------------------------ helpers ------------------------------- */

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function splur(x, sing, plur) { return x + ' ' + (x === 1 ? sing : plur); }

const sanSlug = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
const sanName = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
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

let slug = '';
let state = null;         // latest server snapshot of the current auction
let roster = [];          // local working copy of the roster chips
let settingsDirty = 0;    // when the user last touched settings locally
let settingsTimer = null;
let auctionTimer = null;
let refreshing = false;

function setPath(s) {
  history.replaceState(null, '', '/' + s + location.search);
}

async function refresh() {
  if (!configured || refreshing) return;
  refreshing = true;
  try {
    const res = await apiGet({ action: 'state', auction: slug });
    if (res.error) banner(res.error);
    else if (res.slug === slug) { state = res; render(); }  // ignore stale
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
  lockOrUnlock();
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
  for (const name of roster) {
    const chip = el('span', 'chip', '@' + name);
    if (!(state && state.revealed)) {
      const x = el('button', 'x', '×');
      x.type = 'button';
      x.title = 'remove @' + name;
      x.addEventListener('click', () => {
        roster = roster.filter((u) => u !== name);
        renderChips();
        settingsChanged();
      });
      chip.append(x);
    }
    box.append(chip);
  }
}

function chipList(names) {
  const frag = document.createDocumentFragment();
  names.forEach((n) => frag.append(el('span', 'chip', '@' + n), ' '));
  return frag;
}

function renderStatus() {
  const box = $('status');
  box.hidden = false;
  box.replaceChildren();

  if (state.revealed) {
    box.append(el('p', 'card-title', 'Results ⚡'));
    const t = el('table', 'results');
    for (const b of state.bids) {
      const tr = el('tr');
      tr.append(el('td', 'who', '@' + b.name), el('td', 'what', b.bid));
      t.append(tr);
    }
    box.append(t);
    box.append(el('p', 'note',
      'This auction is revealed; bids and settings are now locked.'));
    return;
  }

  const got = state.bidders;
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
  box.append(msg);

  if (got.length) {
    const p = el('p', 'bidders');
    p.append('bids so far: ', chipList(got));
    box.append(p);
  }
}

function lockOrUnlock() {
  const locked = !!(state && state.revealed);
  for (const id of ['name', 'bid', 'place', 'mode-count', 'mode-roster',
                    'n', 'roster-input']) {
    $(id).disabled = locked;
  }
}

/* ------------------------------ actions ------------------------------- */

async function placeBid() {
  const name = sanName($('name').value);
  const bid = $('bid').value.trim();
  if (!name) return banner('name must be alphanumeric, starting with a letter');
  if (!bid) return banner('bid is empty');
  localStorage.setItem('tauction-name', name);
  $('name').value = name;
  $('place').disabled = true;
  try {
    const res = await apiPost({ action: 'bid', auction: slug, name, bid });
    if (res.error) return banner(res.error);
    if (res.slug === slug) { state = res; render(); }
    banner('Bid placed ✓', 'ok');
  } catch (e) {
    banner('network hiccup: ' + e.message);
  } finally {
    if (!(state && state.revealed)) $('place').disabled = false;
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
    auction: slug,
    mode: $('mode-roster').checked ? 'roster' : 'count',
    n: Math.max(1, parseInt($('n').value, 10) || 1),
    roster: roster,
  };
  try {
    const res = await apiPost(body);
    if (res.error) return banner(res.error);
    if (res.slug === slug) { state = res; renderStatus(); lockOrUnlock(); }
  } catch (e) {
    banner('network hiccup: ' + e.message);
  }
}

function addRosterChip() {
  const name = sanName($('roster-input').value);
  $('roster-input').value = '';
  if (!name || roster.includes(name)) return;
  roster.push(name);
  $('mode-roster').checked = true;  // adding people implies roster mode
  renderChips();
  settingsChanged();
}

function switchAuction(v) {
  if (!v || v === slug) return;
  slug = v;
  setPath(slug);
  state = null;
  roster = [];
  settingsDirty = 0;
  $('status').hidden = true;
  refresh();
}

/* ------------------------------- wiring ------------------------------- */

function wireUp() {
  $('bid-form').addEventListener('submit', (e) => {
    e.preventDefault();
    placeBid();
  });

  $('auction').addEventListener('input', () => {
    const v = sanSlug($('auction').value);
    if (v !== $('auction').value) $('auction').value = v;
    clearTimeout(auctionTimer);
    auctionTimer = setTimeout(() => switchAuction(v), 500);
  });

  $('name').addEventListener('input', () => {
    const v = sanName($('name').value);
    if (v !== $('name').value) $('name').value = v;
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
    const s = sanName(v);
    if (s !== v) $('roster-input').value = s;
  });
}

async function init() {
  wireUp();

  const m = location.pathname.match(/^\/([a-zA-Z0-9]{1,40})\/?$/);
  if (m) {
    slug = m[1].toLowerCase();
  } else if (configured) {
    try { slug = (await apiGet({ action: 'fresh' })).slug; } catch (e) { /* fall through */ }
  }
  if (!slug) slug = PARTICLES[Math.floor(Math.random() * PARTICLES.length)];
  setPath(slug);
  $('auction').value = slug;
  $('name').value = localStorage.getItem('tauction-name') || '';

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
