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

// Sealed bids render as this fixed decoy, blurred by CSS. Constant for
// everyone, so it leaks nothing — not even length. Latin as a treat for
// anyone who unblurs it in devtools: "don't peek".
const MASK = 'noli spectare';

/* ------------------------------ helpers ------------------------------- */

const $ = (id) => document.getElementById(id);

function assert(cond, msg) { if (!cond) throw new Error('assert: ' + msg); }

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

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
let wasRevealed = null;   // reveal state at last render (null = unknown)
let settingsDirty = 0;    // when the user last touched the roster locally
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
    (b) => typeof b.uname === 'string' && typeof b.updated === 'string'
        && typeof b.subs === 'number'),
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
  renderSettings();  // sync the local roster from the server unless mid-edit
  renderStatus();    // rows render from the local roster
  renderMine();
  $('status').classList.remove('stale');  // server truth is on screen
}

// You are whoever the name field says you are
function me() { return sanUname($('uname').value); }

// Every bid this browser has placed on this auction, keyed by uname —
// so bids stay readable to you even if you rename yourself and bid again
function myBids() {
  return JSON.parse(localStorage.getItem('tauction-mybids:' + aname) || '{}');
}

// Bids whose text this client knows: the ones it placed, plus everyone's
// once revealed. Rows render whatever is known and mask the rest — the
// same rule makes your bids visible to you and sealed for everyone else.
function knownBids() {
  const known = myBids();
  (state.bids || []).forEach((b) => { known[b.uname] = b.bid; });
  return known;
}

// One row per expected bidder: the roster, plus any walk-on bidders.
// Uses the LOCAL roster so your chip edits show up instantly (the box
// stays grayed via .stale until the server confirms them).
function slotUnames() {
  const unames = state.bidders.map((b) => b.uname);
  return roster.concat(unames.filter((u) => !roster.includes(u)));
}

// The BIDS box. Rows say it all: hollow ○ + breathing empty slot = no bid
// yet; ✅ + card = bid in (text if you may read it, a blurred decoy if
// not); struck-through name = bid doesn't count toward the reveal (not on
// the roster). Reveal lights the 🎉 and glows the card, once.
function renderStatus() {
  const box = $('status');
  box.classList.toggle('revealed', state.revealed);
  box.classList.toggle('just-revealed',
    wasRevealed === false && state.revealed);
  $('settings').classList.toggle('revealed', state.revealed);
  wasRevealed = state.revealed;

  // the padlock is the reveal button: pressable (and pulsing) only once
  // everyone on the roster — at least two people — has bid
  const ready = !state.revealed && state.roster.length >= 2
    && state.roster.every((u) => state.bidders.some((b) => b.uname === u));
  $('seal').disabled = !ready;
  $('seal').classList.toggle('ready', ready);

  const known = knownBids();
  const byName = {};
  state.bidders.forEach((b) => { byName[b.uname] = b; });
  const nextSeen = {};
  const rows = slotUnames().map((uname) => {
    const t = el('div', 'tile');
    t.append(el('div', 'tile-name', '@' + uname));
    const b = byName[uname];
    const stamp = b === undefined ? undefined : b.updated;
    t.classList.toggle('has-bid', stamp !== undefined);
    t.classList.toggle('cut',
      stamp !== undefined && !roster.includes(uname));
    t.classList.toggle('updated',
      seen[uname] !== undefined && seen[uname] !== stamp);
    // phase-lock breathe to the wall clock (period must match the CSS 3s)
    // so the 5s poll rebuilds don't visibly restart the fade mid-cycle
    t.style.animationDelay =
      stamp === undefined ? -(Date.now() % 3000) + 'ms' : '';
    const sealed = stamp !== undefined && known[uname] === undefined;
    const bidEl = el('div', 'tile-bid');
    if (stamp !== undefined) {
      // a received bid is a card; each re-submission stacks a sheet
      // behind it (visual depth caps at 3; the counter stays exact)
      const card = el('span', 'bid-card stack' + Math.min(b.subs - 1, 3));
      card.append(el('span', sealed ? 'bid-text masked' : 'bid-text',
                     sealed ? MASK : known[uname]));
      bidEl.append(card);
    }
    t.append(bidEl);
    // (re)submission counter — server-counted, so it's per-bidder truth
    t.append(el('div', 'tile-subs', String(b === undefined ? 0 : b.subs)));
    nextSeen[uname] = stamp;
    return t;
  });
  seen = nextSeen;
  $('tiles').replaceChildren(...rows);
}

// Your current bid doubles as the placeholder, ready to edit and resubmit
function renderMine() {
  const mine = myBids()[me()];
  $('bid').placeholder = mine !== undefined ? mine : BID_HINT;
}

// Don't clobber the roster chips while the user is mid-edit
function settingsBusy() {
  return Date.now() - settingsDirty < 4000
    || document.activeElement === $('roster-input');
}

function renderSettings() {
  if (settingsBusy()) return;
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
  const a = aname;  // pin the auction this bid belongs to; the user might
                    // switch auctions while the POST is in flight
  const uname = sanUname($('uname').value);
  const bid = $('bid').value.trim();
  if (!uname) return banner('name must be alphanumeric, starting with a letter');
  if (!bid) return banner('bid is empty');
  localStorage.setItem('tauction-uname', uname);
  $('uname').value = uname;
  $('place').disabled = true;
  $('place').classList.add('busy');
  try {
    if (settingsDirty) {  // flush unconfirmed roster edits before bidding,
                          // lest they overwrite the seat this bid claims
      clearTimeout(settingsTimer);
      await pushSettings();
    }
    const res = await apiPost({ action: 'bid', aname: a, uname: uname, bid: bid });
    if (res.error) return banner(res.error);
    const mine = JSON.parse(localStorage.getItem('tauction-mybids:' + a) || '{}');
    mine[uname] = bid;
    localStorage.setItem('tauction-mybids:' + a, JSON.stringify(mine));
    $('bid').value = '';
    if (res.aname === aname) { ingest(res); render(); }
    banner('Bid placed ✓', 'ok');
  } catch (e) {
    banner('network hiccup: ' + e.message);
  } finally {
    $('place').disabled = false;
    $('place').classList.remove('busy');
  }
}

/* ------------------------------- share -------------------------------- */

// The canonical URL of this auction: origin + aname, sans any ?api= override
function shareUrl() { return location.origin + '/' + aname; }

// QR straight onto a canvas, with the 4-module quiet zone scanners need
// (the library's own renderer omits it, which breaks scanning)
function drawQr(url, canvas) {
  const qr = qrcode(0, 'M');  // auto version, medium error correction
  qr.addData(url);
  qr.make();
  const n = qr.getModuleCount();
  const margin = 4;
  const cell = Math.max(2, Math.floor(280 / (n + 2 * margin)));
  const size = (n + 2 * margin) * cell;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';  // always light: scanners want dark-on-light
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) {
        ctx.fillRect((c + margin) * cell, (r + margin) * cell, cell, cell);
      }
    }
  }
}

function openShare() {
  const url = shareUrl();
  $('share-url').textContent = url;
  drawQr(url, $('qr'));
  $('copy').classList.remove('copied');
  $('share-dlg').showModal();
}

async function copyUrl() {
  try {
    await navigator.clipboard.writeText(shareUrl());
    $('copy').classList.add('copied');
  } catch (e) {
    banner('could not copy: ' + e.message);
  }
}

async function pressReveal() {
  $('seal').disabled = true;  // no double-fire; render recomputes it
  try {
    const res = await apiPost({ action: 'reveal', aname: aname });
    if (res.error) return banner(res.error);
    if (res.aname === aname) { ingest(res); render(); }
  } catch (e) {
    banner('network hiccup: ' + e.message);
  }
}

function settingsChanged() {
  settingsDirty = Date.now();
  $('status').classList.add('stale');  // grayed until the server confirms
  if (state) renderStatus();           // rows track your edit immediately
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(pushSettings, 700);
}

async function pushSettings() {
  if (!configured) return;
  const sentAt = Date.now();
  const body = { action: 'settings', aname: aname, roster: roster };
  try {
    const res = await apiPost(body);
    if (res.error) return banner(res.error);
    if (res.aname === aname) {
      // your edits are server truth now: stop shielding the chips from
      // sync — unless you made newer edits while this push was in flight
      if (settingsDirty <= sentAt) settingsDirty = 0;
      ingest(res);
      render();
    }
  } catch (e) {
    banner('network hiccup: ' + e.message);
  }
}

function addRosterChip() {
  const uname = sanUname($('roster-input').value);
  $('roster-input').value = '';
  if (!uname || roster.includes(uname)) return;
  roster.push(uname);
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
  wasRevealed = null;
  settingsDirty = 0;
  $('status').classList.add('stale');
  renderMine();
  refresh();
}

/* ------------------------------- wiring ------------------------------- */

function wireUp() {
  $('bid-form').addEventListener('submit', (e) => {
    e.preventDefault();
    placeBid();
  });

  $('seal').addEventListener('click', pressReveal);

  $('share').addEventListener('click', openShare);
  $('copy').addEventListener('click', copyUrl);
  $('help').addEventListener('click', () => $('help-dlg').showModal());
  document.querySelectorAll('.dlg-x').forEach((x) =>
    x.addEventListener('click', () => x.closest('dialog').close()));
  document.querySelectorAll('dialog').forEach((d) =>
    d.addEventListener('click', (e) => {  // click the backdrop to dismiss
      if (e.target === d) d.close();
    }));

  $('aname').addEventListener('input', () => {
    const v = sanAname($('aname').value);
    if (v !== $('aname').value) $('aname').value = v;
    clearTimeout(anameTimer);
    anameTimer = setTimeout(() => switchAuction(v), 500);
  });

  $('uname').addEventListener('input', () => {
    const v = sanUname($('uname').value);
    if (v !== $('uname').value) $('uname').value = v;
    renderMine();  // your-bid-as-placeholder follows the name field
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
