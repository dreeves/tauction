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
let roster = [];          // local working copy of the roster
let seen = {};            // uname -> updated stamp at last render (shimmer)
let wasRevealed = null;   // reveal state at last render (null = unknown)
let lastWriteAt = 0;      // when this client last STARTED a write (bid,
                          // add/remove, claim, reveal): state snapshots
                          // requested before that are obsolete on arrival
let anameTimer = null;
let refreshing = false;

const BID_HINT = 'your bid';  // row-editor placeholder when you have no bid

// The padlock's tip, cached from the HTML so the copy lives in one place;
// once revealed the icon is a 🎉 and offers nothing, so the tip changes
const SEAL_TIP = $('seal').getAttribute('data-tip');

// This browser's anonymous device id. Claims are keyed by it on the
// server, so every page agrees who's taken — two machines can no longer
// both be @alice. It's a consistency marker, not auth (honor system).
if (!localStorage.getItem('tauction-device')) {
  localStorage.setItem('tauction-device', crypto.randomUUID());
}
const DEVICE = localStorage.getItem('tauction-device');

function setPath(a) {
  history.replaceState(null, '', '/' + a + location.search);
}

// Validate + adopt a state snapshot from the server; remember it so the
// next page load can paint instantly instead of flashing a blank roster
function ingest(res) {
  assert(Array.isArray(res.bidders) && res.bidders.every(
    (b) => typeof b.uname === 'string' && typeof b.updated === 'string'
        && typeof b.subs === 'number')
    && res.claims !== null && typeof res.claims === 'object',
    'bad state shape — is the deployed Code.gs current?');
  state = res;
  localStorage.setItem('tauction-state:' + res.aname, JSON.stringify(res));
}

async function refresh() {
  if (!configured || refreshing) return;
  refreshing = true;
  const a = aname;  // the auction this request is for
  const started = Date.now();
  try {
    const res = await apiGet({ action: 'state', aname: a });
    if (res.error) banner(res.error);
    // adopt only if nothing was written since this snapshot was requested
    // (else it can lack a name you just added or a bid you just placed)
    else if (res.aname === aname && lastWriteAt < started) { ingest(res); render(); }
  } catch (e) {
    banner('network hiccup: ' + e.message);
  } finally {
    refreshing = false;
    // the auction switched mid-flight, and the refreshing guard swallowed
    // that switch's own refresh: fetch the current auction now
    if (a !== aname) refresh();
  }
}

/* ------------------------------ rendering ----------------------------- */

function render() {
  if (!state) return;
  // adopt the server's roster: every adopted snapshot is gated on being
  // newer than this client's newest write, so it contains every local
  // edit — no shielding needed
  roster = state.roster.slice();
  renderStatus();
  $('status').classList.remove('stale');  // server truth is on screen
}

// You are whoever this browser last bid (or claimed a row) as — but only
// while that name has a row in this auction AND the server's claim for
// it (if any) is this device's. Unclaimed-on-the-server plus remembered
// locally counts as yours (the optimistic moment before your claim
// lands); a rival device's registered claim unseats you.
function me() {
  const u = localStorage.getItem('tauction-uname') || '';
  if (!slotUnames().includes(u)) return '';
  const holder = state.claims[u];
  return holder === undefined || holder === DEVICE ? u : '';
}

// Every bid this browser has placed on this auction, keyed by uname —
// so bids stay readable to you even if you switch rows and bid again
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

// The BIDS box IS the app: one ledger line per roster member. Hollow ○ +
// breathing empty slot = no bid yet; ✅ + card = bid in (text if you may
// read it, a blurred decoy if not); struck-through name = bid doesn't
// count toward the reveal (not on the roster — reachable only via roster
// races, never via the UI). Your own row's bid slot is an input: your bid
// lives there, editable in place; enter (re)submits. × removes a row from
// the roster, offered only while it has no bid to protect. Reveal lights
// the 🎉 and glows the card, once.
let lastPrint = '';  // fingerprint of the last-rendered rows

function renderStatus() {
  // Skip no-op rebuilds: replacing the nodes destroys any button mid-
  // click (mousedown and mouseup must hit the same node), so a rebuild
  // that changes nothing can silently eat a click. wasRevealed and seen
  // are in the fingerprint because the render right after a reveal or a
  // shimmer must still run: it retires those one-shot effects.
  const print = JSON.stringify([aname, wasRevealed, seen, slotUnames(),
    state.bidders, state.roster, state.revealed, state.claims, me(),
    knownBids()]);
  if (print === lastPrint) return;
  lastPrint = print;

  const box = $('status');
  box.classList.toggle('revealed', state.revealed);
  box.classList.toggle('just-revealed',
    wasRevealed === false && state.revealed);
  wasRevealed = state.revealed;

  // the padlock is the reveal button: pressable (and pulsing) only once
  // everyone on the roster — at least two people — has bid
  const ready = !state.revealed && state.roster.length >= 2
    && state.roster.every((u) => state.bidders.some((b) => b.uname === u));
  $('seal').disabled = !ready;
  $('seal').classList.toggle('ready', ready);
  // TODO English for the revealed tip: "Revealed!"
  $('seal').setAttribute('data-tip',
    state.revealed ? 'Patefactum!' : SEAL_TIP);

  // Preserve a mid-composition draft in the row editor: this rebuild runs
  // on every 5s poll and would otherwise eat your typing
  const live = $('tiles').querySelector('.rebid input');
  const draft = live && (live === document.activeElement
                         || live.value !== live.defaultValue)
    ? { uname: live.closest('.tile').dataset.uname, value: live.value,
        focused: live === document.activeElement,
        start: live.selectionStart, end: live.selectionEnd }
    : null;

  const mine = me();
  const known = knownBids();
  const placed = myBids();  // bids THIS browser placed (the dibs exception)
  const byName = {};
  state.bidders.forEach((b) => { byName[b.uname] = b; });
  const nextSeen = {};
  const rows = slotUnames().map((uname) => {
    const b = byName[uname];
    const stamp = b === undefined ? undefined : b.updated;
    const t = el('div', 'tile');
    t.dataset.uname = uname;
    // Every row leads with its star, a radio for who-you-are: ☆ =
    // claimable, dimmed ☆ = dibsed, glowing ★ = you. A row is dibsed by
    // a rival device's registered claim, or (for claim-less legacy rows)
    // by a bid this browser didn't place. Clicking your own lit star
    // releases you to nobody. A bid placed by THIS browser never dibses
    // you out of the row (else releasing after bidding would strand you).
    const holder = state.claims[uname];
    const dibsed = uname !== mine
      && ((holder !== undefined && holder !== DEVICE)
          || (stamp !== undefined && placed[uname] === undefined));
    const star = el('button', 'tu', uname === mine ? '★' : '☆');
    star.type = 'button';
    star.disabled = dibsed;
    star.classList.toggle('selected', uname === mine);
    star.setAttribute('data-tip',
      uname === mine ? "Renounce, i.e., not you"
      : dibsed       ? "Too late to claim this is you"
      :                "Claim as you");
    star.addEventListener('click', () => toggleTu(uname));
    const nameEl = el('div', 'tile-name');
    nameEl.append(star, '@' + uname);
    t.append(nameEl);
    t.classList.toggle('has-bid', stamp !== undefined);
    t.classList.toggle('mine', uname === mine);
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
    if (uname === mine) {
      const form = el('form', 'rebid');
      const input = document.createElement('input');
      input.maxLength = 80;
      input.autocomplete = 'off';
      input.placeholder = BID_HINT;
      const baseline = known[uname] === undefined ? '' : known[uname];
      input.value = baseline;
      input.defaultValue = baseline;  // a draft = live value differs
      input.className = stamp === undefined
        ? 'bid-slot' : 'bid-card stack' + Math.min(b.subs - 1, 3);
      form.append(input);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        placeBid(uname, form);
      });
      bidEl.append(form);
    } else if (stamp !== undefined) {
      // a received bid is a card; each re-submission stacks a sheet
      // behind it (visual depth caps at 3; the counter stays exact)
      const card = el('span', 'bid-card stack' + Math.min(b.subs - 1, 3));
      card.append(el('span', sealed ? 'bid-text masked' : 'bid-text',
                     sealed ? MASK : known[uname]));
      bidEl.append(card);
    } else {
      // an empty card holds the space where their bid will land (the
      // nbsp gives it a text line's height)
      bidEl.append(el('span', 'bid-card slot', ' '));
    }
    // the (re)submission counter — server-counted, per-bidder truth —
    // rides the ✅ as a superscript; the ✅ grays while the count is 0
    const check = el('span', 'check', '✅');
    check.append(el('sup', 'tile-subs', String(b === undefined ? 0 : b.subs)));
    bidEl.append(check);
    t.append(bidEl);
    // × removes the whole row from the roster — grayed out once a bid is
    // in, because a sealed bid is never deletable
    const x = el('button', 'x', '×');
    x.type = 'button';
    x.disabled = stamp !== undefined;
    x.setAttribute('data-tip', 'remove @' + uname);
    x.addEventListener('click', () => {
      roster = roster.filter((u) => u !== uname);
      queueOp({ action: 'remove', aname: aname, uname: uname });
    });
    t.append(x);
    nextSeen[uname] = stamp;
    return t;
  });
  seen = nextSeen;
  $('tiles').replaceChildren(...rows);
  if (draft) restoreDraft(draft);
}

// Claim a row as yourself, or release it if it's already yours
function toggleTu(uname) {
  if (me() === uname) {
    localStorage.removeItem('tauction-uname');
    queueOp({ action: 'claim', aname: aname, uname: uname,
              device: '' });     // release the seat for everyone
  } else {
    localStorage.setItem('tauction-uname', uname);
    queueOp({ action: 'claim', aname: aname, uname: uname,
              device: DEVICE }); // stake it: rival pages show dibs
  }
  renderStatus();
  const input = $('tiles').querySelector('.rebid input');
  if (input) input.focus();
}

function restoreDraft(d) {
  const input = $('tiles').querySelector(
    '.tile[data-uname="' + d.uname + '"] .rebid input');
  if (!input) return;  // the row was removed mid-composition
  input.value = d.value;
  if (d.focused) { input.focus(); input.setSelectionRange(d.start, d.end); }
}


/* ------------------------------ actions ------------------------------- */

async function placeBid(uname, form) {
  const a = aname;  // pin the auction this bid belongs to; the user might
                    // switch auctions while the POST is in flight
  const input = form.querySelector('input');
  const bid = input.value.trim();
  assert(uname, 'placeBid without an identity');
  if (!bid) return banner('bid is empty');
  localStorage.setItem('tauction-uname', uname);
  input.disabled = true;
  form.classList.add('busy');
  lastWriteAt = Date.now();
  const at = lastWriteAt;
  try {
    const res = await apiPost({ action: 'bid', aname: a, uname: uname,
                                bid: bid, device: DEVICE });
    if (res.error) return banner(res.error);
    const mine = JSON.parse(localStorage.getItem('tauction-mybids:' + a) || '{}');
    mine[uname] = bid;
    localStorage.setItem('tauction-mybids:' + a, JSON.stringify(mine));
    if (res.aname === aname && at === lastWriteAt) { ingest(res); render(); }
    banner('Bid placed ✓', 'ok');
  } catch (e) {
    banner('network hiccup: ' + e.message);
  } finally {
    input.disabled = false;
    form.classList.remove('busy');
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


// Roster and claim writes are row-level ops, serialized client-side so
// a burst of adds can't pile onto the server's script lock. The UI is
// optimistic (the local roster already changed); the box grays until
// the server confirms. Only the NEWEST op's snapshot is adopted —
// earlier ones predate later local edits.
let opChain = Promise.resolve();
function queueOp(body) {
  lastWriteAt = Date.now();
  const at = lastWriteAt;
  $('status').classList.add('stale');
  if (state) renderStatus();
  if (!configured) return;
  opChain = opChain.then(async () => {
    try {
      const res = await apiPost(body);
      if (res.error) return banner(res.error);
      if (res.aname === aname && at === lastWriteAt) { ingest(res); render(); }
    } catch (e) {
      banner('network hiccup: ' + e.message);
    }
  });
}

async function pressReveal() {
  $('seal').disabled = true;  // no double-fire; render recomputes it
  lastWriteAt = Date.now();
  const at = lastWriteAt;
  try {
    const res = await apiPost({ action: 'reveal', aname: aname });
    if (res.error) return banner(res.error);
    if (res.aname === aname && at === lastWriteAt) { ingest(res); render(); }
  } catch (e) {
    banner('network hiccup: ' + e.message);
  }
}


function addName() {
  const uname = sanUname($('roster-input').value);
  $('roster-input').value = '';
  if (!uname || roster.includes(uname)) return;
  roster.push(uname);
  queueOp({ action: 'add', aname: aname, uname: uname });
}

// Instant paint from the last-known state of this auction, grayed until
// the live fetch confirms — a page must never flash what looks like a
// confirmed-empty roster while loading
function paintCached() {
  const key = 'tauction-state:' + aname;
  try {
    const cached = JSON.parse(localStorage.getItem(key) || 'null');
    if (cached) { ingest(cached); render(); }
  } catch (e) {
    localStorage.removeItem(key);  // cache from an old schema: purge
  }
  $('status').classList.add('stale');
}

function switchAuction(a) {
  if (!a || a === aname) return;
  aname = a;
  setPath(aname);
  state = null;
  roster = [];
  seen = {};
  wasRevealed = null;
  paintCached();
  refresh();
}

/* ------------------------------- wiring ------------------------------- */

function wireUp() {
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

  // Enter/comma/space commit; deliberately NO commit-on-blur — the blur
  // fires mid-click when you tap a row control, and the rebuild it
  // triggered used to destroy the very button being clicked. An
  // uncommitted name just stays visible in the + row.
  $('roster-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
      e.preventDefault();
      addName();
    }
  });
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

  if (!configured) {
    banner('No API configured — set the API constant in app.js (see README).');
    return;
  }

  paintCached();
  await refresh();
  setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, POLL_MS);
}

init();
