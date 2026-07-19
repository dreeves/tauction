'use strict';

/* --------------------------------- config --------------------------------- */

// "aname" = auction name, also its URL slug
// "uname" = bidder's username, shown with an @ in the UI

// Paste your Apps Script web-app URL here (Deploy -> Web app -> the /exec URL):
const API = 'https://script.google.com/macros/s/AKfycbyJgizZYhYuIj5ASpcV-0Y2MiCCjgGTyi7zEV29wVCf1BNf73b5VLQlrzU2FBGgpCXKLw/exec';

// For testing before editing this file: tauction.dreev.es/?api=https://...
const api = new URLSearchParams(location.search).get('api') || API;
const configured = /^https:\/\//.test(api);

const POLL_MS = 5000;

// Decoy text that we blur out for bids that are still sealed. Obviously can't
// just blur out the actual bid since we'd leak information about it that way.
const MASK = 'noli spectare'; // Latin for "don't peek", I think

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

// A umap is a prototype-less dictionary keyed by uname
const umap = (src = {}) => Object.assign(Object.create(null), src);

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

// A dead-end sign: stays up until replaced or explicitly cleared (a
// timer must not snatch it while you read — dreev). innerHTML, for
// the link inside; ONLY app-built markup may come here, never server
// or user text (that all goes through banner()'s textContent).
function stickyBanner(html) {
  const b = $('banner');
  b.innerHTML = html;
  b.className = 'err';
  b.hidden = false;
  clearTimeout(bannerTimer);
}

/* ------------------------------- state -------------------------------- */

let aname = '';
let state = null;         // latest server snapshot of the current auction
let roster = [];          // local working copy of the roster
let seen = umap();        // uname -> updated stamp at last render (shimmer)
let pendingRenames = new Map();
let wasRevealed = null;   // reveal state at last render (null = unknown)
let lastWriteAt = 0;      // when this client last STARTED a write (bid,
                          // add/remove, claim, reveal); of concurrent
                          // write responses, only the newest is adopted
let writesPending = 0;    // writes queued or in flight, of any kind
let writeSettledAt = 0;   // when the last write's response arrived: a
                          // read snapshot is trustworthy only if it was
                          // requested after that (the server may not
                          // have committed a write before then)
let refreshing = false;
let caretPlaced = false;  // the on-arrival focus into your editor fired

// This browser's anonymous device id. Claims are keyed by it on the
// server, so every page agrees who's taken — two machines can no longer
// both be @alice. It's a consistency marker, not auth (honor system).
if (!localStorage.getItem('tauction-device')) {
  localStorage.setItem('tauction-device', crypto.randomUUID());
}
const DEVICE = localStorage.getItem('tauction-device');

// This browser's self-description, sent with claims and bids and
// shown in the who-claimed-this tooltip: "Mac Chrome en-US in
// Portland, OR". OS and browser from a user-agent lookup table,
// language from the browser, geography appended asynchronously by
// locate(). Decoration on the honor system, all of it. (The server
// can't glean any of this: Apps Script never sees headers.)
let DEVBLURB = (() => {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows PC' : /Linux/.test(ua) ? 'Linux box'
    : mysteryDevice;
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox'
    : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : '';
  return [os, br, navigator.language].filter(Boolean).join(' ');
})();

// Rough geography for the blurb, from a free IP lookup (ipwho.is:
// real CORS headers even on failures, unlike ipapi.co, whose
// rate-limited responses lack them and spam the console). Geography
// is decoration, so a flaky third party must not delay boot or banner
// errors — this is the app's one deliberately quiet catch. The result
// is cached in localStorage for a day: locate() runs every page load,
// dev live-reload loads on every file save, and that burned the free
// rate limit into 429s (~30 lookups/month vs the 10k/month tier).
const GEO_TTL_MS = 24 * 3600 * 1000;
const GEO_RETRY_MS = 3600 * 1000;  // a FAILED lookup backs off this long
async function locate() {
  try {
    let geo = localStorage.getItem('tauction-geo');
    const at = localStorage.getItem('tauction-geo-at');
    if (!(geo && Date.now() - Date.parse(at) < GEO_TTL_MS)) {
      // The attempt is stamped BEFORE it flies (dreev's persisting-
      // 429 report, 2026-07-18): a throttled or down service gets one
      // probe per backoff window, never a console-spamming retry per
      // load — which itself fed the burst limit under dev live-reload
      const tried = localStorage.getItem('tauction-geo-try');
      if (Date.now() - Date.parse(tried) < GEO_RETRY_MS) return;
      localStorage.setItem('tauction-geo-try', new Date().toISOString());
      const r = await (await fetch('https://ipwho.is/')).json();
      if (!(r.city && r.region_code)) return;  // retry after the backoff
      geo = r.city + ', ' + r.region_code;
      localStorage.setItem('tauction-geo', geo);
      localStorage.setItem('tauction-geo-at', new Date().toISOString());
    }
    // The server's deviceBlurb contract is printable ASCII, max 64
    // chars: ASCII-fy the city (São Paulo -> Sao Paulo — NFD splits
    // off the combining marks, the filter drops them) and clamp, so
    // decoration can never cost anyone a claim or a bid
    DEVBLURB = (DEVBLURB + ' in ' + geo).normalize('NFD')
      .replace(/[^ -~]/g, '').slice(0, 64);
  } catch (e) { /* the blurb just goes without */ }
}

/* ------------------------------ tooltips ------------------------------ */

// ONE tooltip for the whole app (see #tip in index.html), positioned
// by vendored Floating UI. Two hosts can want it — the one under the
// pointer and the one holding focus — and hover wins while it lasts,
// with the focus-parked tip resuming after (word-hosts keep
// tap-tips; an activated button's blur — the universal rule — drops
// its focus claim). A host containing the field you are typing in
// keeps its counsel.
let hoverHost = null;  // [data-tip] element under the pointer, if any
let focusHost = null;  // [data-tip] element holding focus, if any
async function showTip() {
  const tip = $('tip');
  const host = hoverHost || focusHost;
  // a host that lost its data-tip while alive (the seal at reveal)
  // has nothing to say: hidden, never an empty bubble
  if (!host || !host.isConnected || !host.getAttribute('data-tip')
      || host.querySelector('input:focus, textarea:focus')) {
    tip.hidden = true;
    return;
  }
  tip.textContent = host.getAttribute('data-tip');
  tip.hidden = false;
  const pos = await FloatingUIDOM.computePosition(host, tip, {
    placement: 'bottom-start',
    middleware: [FloatingUIDOM.offset(7), FloatingUIDOM.flip(),
                 FloatingUIDOM.shift({ padding: 8 })],
  });
  if (host !== (hoverHost || focusHost)) return;  // a newer summons
  tip.style.left = pos.x + 'px';                  // owns the tip now
  tip.style.top = pos.y + 'px';
}

function setPath(a) {
  history.replaceState(null, '', '/' + a + location.search);
}

// The one true stamp shape: what toISOString mints, what the sheet
// stores as text, what compares lexicographically. Asserted in FULL
// (anti-Postel): a stamp a human hand-edits or date-formats reads
// back as "Fri Jul ... GMT-0700 (...)" — whose GMT smuggled a 'T'
// past the old includes-check while silently breaking the stamp
// ordering (and a blank stamp rendered "NaNd ago"). (gridScience,
// 2026-07-18: Sheets' write-parser doesn't coerce the T...Z shape,
// so sheet-side accidents bite bid text, not stamps — this assert
// is the belt for the human-edit path.)
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function assertState(res) {
  assert(res !== null && typeof res === 'object'
    && typeof res.aname === 'string'
    && typeof res.exists === 'boolean'
    && Array.isArray(res.roster)
    && res.roster.every((u) => typeof u === 'string')
    && Array.isArray(res.bidders) && res.bidders.every(
      (b) => typeof b.uname === 'string' && STAMP_RE.test(b.tini)
          && STAMP_RE.test(b.tmod) && typeof b.bcount === 'number')
    && typeof res.revealed === 'boolean'
    && typeof res.tfin === 'string'
    && (res.tfin === '' || STAMP_RE.test(res.tfin))
    && typeof res.blurb === 'string' && typeof res.tblurb === 'string'
    && res.claims !== null && typeof res.claims === 'object'
    && !Array.isArray(res.claims)
    && Object.values(res.claims).every((v) => typeof v === 'string')
    && res.blurbs !== null && typeof res.blurbs === 'object'
    && !Array.isArray(res.blurbs)
    && Object.values(res.blurbs).every((v) => typeof v === 'string')
    && (res.bids === null || (Array.isArray(res.bids)
      && res.bids.every((b) => typeof b.uname === 'string'
        && typeof b.bid === 'string'))),
  'bad state shape — is the deployed Code.gs current?');
}

// Validate + adopt a state snapshot from the server; remember it so the
// next page load can paint instantly instead of flashing a blank roster
function ingest(res) {
  assertState(res);
  reconcileTransportRenames(res);
  res.claims = umap(res.claims);
  res.blurbs = umap(res.blurbs);
  state = res;
  localStorage.setItem('tauction-state:' + res.aname, JSON.stringify(res));
  // Your device's registered claim is authoritative for who you are: if
  // the name it holds changed (someone else fixed your typo), the local
  // identity and bid memory follow it home
  const claimed = Object.keys(res.claims)
    .find((u) => res.claims[u] === DEVICE);
  const remembered = localStorage.getItem('tauction-uname');
  if (claimed !== undefined && claimed !== remembered) {
    if (remembered !== null) rekeyMyBids(res.aname, remembered, claimed);
    localStorage.setItem('tauction-uname', claimed);
  }
}

async function refresh() {
  // (the !aname leg: an unnamed page has nothing to fetch — the user
  // has not picked an auction yet)
  if (!configured || refreshing || !aname) return;
  refreshing = true;
  const a = aname;  // the auction this request is for
  const started = Date.now();
  try {
    const res = await apiGet({ action: 'state', aname: a });
    if (res.error) banner(res.error);
    // adopt only if no writes are pending and this snapshot was requested
    // no earlier than the last write settled — anything less and it can
    // lack a name you just added or a bid you just placed (the server
    // commits a write somewhere between our send and its response). >=
    // because a settle's own recovery fetch goes out in the same
    // millisecond it stamps, and a read issued after a settle is safe.
    else if (res.aname === aname && writesPending === 0
             && started >= writeSettledAt) { ingest(res); render(); }
  } catch (e) {
    banner(e2152(e.message));
  } finally {
    refreshing = false;
    // (the old mid-flight-switch refire died with names-are-chosen-
    // once: polls run only on named pages, where aname is immutable)
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
  renderDesc();
  $('status').classList.remove('stale');  // server truth is on screen
}

// The description block: the view pane always mirrors server truth;
// the editor syncs only when you're not mid-edit (never-clobber, same
// as the bid editor). If someone else's edit lands while yours is in
// progress, warn once and RE-BASE the draft — your next save, made
// informed, wins (the server's compare-and-swap remains the backstop
// for sub-poll races).
let descModeSet = false;  // initial mode chosen once per auction
function renderDesc() {
  const view = $('descview');
  const edit = $('descedit');
  if (view.dataset.md !== state.blurb) {
    view.dataset.md = state.blurb;
    view.innerHTML = mdRender(state.blurb);
  }
  edit.disabled = false;  // only the unnamed idle page keeps it off
  if (edit !== document.activeElement
      && edit.value === edit.defaultValue) {
    edit.value = state.blurb;
    edit.defaultValue = state.blurb;
    edit.dataset.base = state.tblurb;
  } else if (edit.dataset.base !== state.tblurb) {
    edit.defaultValue = state.blurb;
    edit.dataset.base = state.tblurb;
    banner(simulEditsBanner);
    edit.classList.add('error');  // the banner is global; the problem
                                  // is this field (cleared on input)
  }
  if (!descModeSet) {
    descModeSet = true;
    $('desc').classList.toggle('viewing', state.blurb !== '');
  }
}

// The corner ✎ (rendered mode's only control; the glyph lives in
// index.html) reopens the editor. There is no save button: leaving
// the editor saves (dreev killed the 💾 — the blurb obeys the same
// clicking-away-saves rule as bids and names). Escape reverts first,
// so its blur commits nothing.
function editDesc() {
  $('desc').classList.remove('viewing');
  $('descedit').focus();
}

// Save any change and flip back to rendered. Disclosed ifs: dirty →
// save; the flip is gated on having something to show — a blur
// leaving the blurb EMPTY stays in edit mode (flipping would trade
// the placeholder for an invisible empty pane).
function commitDesc() {
  const edit = $('descedit');
  if (edit.value !== edit.defaultValue) {
    const draft = edit.value;
    const cleanBase = edit.defaultValue;  // pre-edit server truth
    queueLazyOp(() => ({ action: 'describe', aname: aname, blurb: draft,
                         base: edit.dataset.base }), () => {
      if (edit.value !== draft || edit.defaultValue !== draft) return;
      // The commit bounced (someone's edit beat ours): back into the
      // editor, your words intact and the field red — the recovery
      // snapshot re-bases the (again-dirty) draft, so saving again,
      // now informed, wins. Hiding a textarea blurs it in real
      // browsers, so never-clobber alone can't protect a bounced
      // draft; this restore is what does.
      edit.value = draft;
      edit.defaultValue = cleanBase;
      edit.classList.add('error');
      $('desc').classList.remove('viewing');
      // reopen but never STEAL: the caret returns only if the page
      // is idle (the arrival-caret law) — if you've moved on to
      // another field, the red editor waits its turn
      if (document.activeElement === document.body) edit.focus();
    }, (res) => { edit.dataset.base = res.tblurb; });
    edit.defaultValue = draft;  // ours is the working base now
    edit.classList.remove('error');
    // paint the draft NOW — rendering is pure client work; the write
    // settles in the background. If its CAS bounces, the recovery
    // snapshot's differing blurb repaints this pane with server truth.
    const view = $('descview');
    view.dataset.md = draft;
    view.innerHTML = mdRender(draft);
  }
  $('desc').classList.toggle('viewing', edit.value !== '');
}

// You are whoever this browser last bid (or claimed a row) as — but only
// while that name has a row in this auction AND the server's claim for
// it (if any) is this device's. Unclaimed-on-the-server plus remembered
// locally counts as yours (the optimistic moment before your claim
// lands); a rival device's registered claim unseats you.
function me() {
  const u = localStorage.getItem('tauction-uname') || '';
  if (!slotUnames().includes(u)) return '';
  // no snapshot yet = no claims are known: optimistically yours (the
  // same optimistic moment as an unclaimed-on-the-server seat)
  const holder = state === null ? undefined : state.claims[u];
  return holder === undefined || holder === DEVICE ? u : '';
}

// Every bid this browser has placed on this auction, keyed by uname —
// so bids stay readable to you even if you switch rows and bid again
function myBids() {
  return umap(JSON.parse(
    localStorage.getItem('tauction-mybids:' + aname) || '{}'));
}

// Re-key this browser's bid memory when an identity changes name:
// your own rename, or one made elsewhere that followed your device home
function rekeyMyBids(a, from, to) {
  assert(from !== to, 'rekeyMyBids to the same name');
  const bids = umap(JSON.parse(
    localStorage.getItem('tauction-mybids:' + a) || '{}'));
  if (bids[from] === undefined) return;
  bids[to] = bids[from];
  delete bids[from];
  localStorage.setItem('tauction-mybids:' + a, JSON.stringify(bids));
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
  // pre-snapshot (a cold page's first seconds, names already typed)
  // the local roster is the whole story: no walk-ons are known yet
  const unames = state === null ? []
    : state.bidders.map((b) => b.uname);
  return roster.concat(unames.filter((u) => !roster.includes(u)));
}

// The BIDS box IS the app: one ledger line per roster member. Dashed,
// breathing cells = no bid yet; solid green = bid in (text if you may
// read it, a blurred decoy if not); struck-through name = bid doesn't
// count toward the reveal (not on the roster — reachable only via roster
// races, never via the UI). Your own row's bid slot is an input: your bid
// lives there, editable in place; enter (re)submits. × removes a row from
// the roster, offered only while it has no bid to protect. Reveal lights
// the 🎉 and glows the card, once.
let lastPrint = '';  // fingerprint of the last-rendered rows
let rowNodes = umap();   // uname -> its living row node (keyed reuse)

function pendingRename(uname) {
  return pendingRenames.get(uname) || [...pendingRenames.values()]
    .find((tx) => tx.confirmed === uname);
}

function renderStatus() {
  // Skip no-op rebuilds: replacing the nodes destroys any button mid-
  // click (mousedown and mouseup must hit the same node), so a rebuild
  // that changes nothing can silently eat a click. wasRevealed and seen
  // are in the fingerprint because the render right after a reveal or a
  // shimmer must still run: it retires those one-shot effects.
  const print = JSON.stringify([aname, wasRevealed, seen,
    [...pendingRenames.values()].map((tx) => [
      tx.confirmed, tx.desired,
      tx.flight === null ? null : [tx.flight.from, tx.flight.to],
    ]), slotUnames(),
    state.bidders, state.roster, state.revealed, state.tfin,
    state.claims, state.blurbs, me(), knownBids()]);
  if (print === lastPrint) return;
  lastPrint = print;

  const box = $('status');
  box.classList.toggle('revealed', state.revealed);
  box.classList.toggle('just-revealed',
    wasRevealed === false && state.revealed);
  if (wasRevealed === false && state.revealed) celebrate();
  wasRevealed = state.revealed;

  const mine = me();

  // The padlock is the reveal button: pressable (and pulsing) only
  // once everyone on the roster — at least two people — has bid.
  // "missing" lists actual roster members without bids, and the tip
  // NAMES them (you tagged as you, Oxford comma at three); a roster
  // below two is a separate, dominating blocker (no amount of bidding
  // unlocks a solo auction), so the tip names THAT then instead.
  const missing = roster.filter(
    (u) => !state.bidders.some((b) => b.uname === u));
  const roll = missing.map((u) => u + (u === mine ? youTag : ''));
  const listed = roll.length <= 2 ? roll.join(' and ')
    : roll.slice(0, -1).join(', ') + ', and ' + roll[roll.length - 1];
  const ready = !state.revealed && roster.length >= 2
    && missing.length === 0;
  // the revealed 🎉 stays ENABLED: reveal is idempotent server-side,
  // so a pointless press is harmless — and a button that is never
  // disabled can never be washed out by a UA stylesheet
  $('seal').disabled = !ready && !state.revealed;
  $('seal').classList.toggle('ready', ready);
  // the roster is CLOSED once revealed (the server refuses adds too)
  $('roster-input').disabled = state.revealed;
  // the lit 🎉 explains itself (dreev): revealed needs no tooltip
  if (state.revealed) $('seal').removeAttribute('data-tip');
  else {
    $('seal').setAttribute('data-tip',
      ready ? revealTip
      : roster.length === 0 ? needTwoTip
      : roster.length === 1 ? needOneMoreTip
      : waitingTip(listed));
  }

  // no row is you yet: the you-star perches on the + row instead, so
  // the legend's ★ always has a referent
  box.classList.toggle('unclaimed', mine === '');

  // Once revealed, the + row retires (CSS, off .revealed) and this
  // stamp takes its place (ingest asserts tfin is empty-or-ISO, so no
  // legacy branch is needed here)
  $('closed').textContent = state.revealed
    ? closedLine(closedStamp(state.tfin)) : '';
  const known = knownBids();
  const placed = myBids();  // bids THIS browser placed (the dibs exception)
  const byName = umap();
  state.bidders.forEach((b) => { byName[b.uname] = b; });
  // Placing a bid locks the who-you-are radio: no switching rows, no
  // releasing — permanently, since your bid never unlists (trying
  // this per dreev)
  const locked = mine !== '' && byName[mine] !== undefined;
  const nextSeen = umap();

  // Keyed reconcile: every uname keeps its living row node for its whole
  // life, so a mid-gesture click (mousedown and mouseup need the same
  // node) or a focused editor can never be destroyed by a render. New
  // rows are built once (structure + listeners), then idempotently
  // synced; vanished rows are removed; survivors move only if the order
  // really changed (essentially never — insertion order is stable).
  const tiles = $('tiles');
  const keep = umap();
  let cursor = null;  // the previous row in the desired order
  slotUnames().forEach((uname) => {
    const b = byName[uname];
    let t = rowNodes[uname] || buildRow(uname);
    keep[uname] = t;
    updateRow(t, uname, b, mine, known, placed, locked);
    if (t.parentElement !== tiles || t.previousElementSibling !== cursor) {
      tiles.insertBefore(t, cursor ? cursor.nextElementSibling
                                   : tiles.firstElementChild);
    }
    cursor = t;
    nextSeen[uname] = b === undefined ? undefined : b.tmod;
  });
  // sweep strays: vanished rows, other auctions' rows
  [...tiles.children].forEach((c) => {
    if (keep[c.dataset.uname] !== c) c.remove();
  });
  rowNodes = keep;
  seen = nextSeen;

  // On your first sight of an auction still waiting on your bid, the
  // caret lands in your editor: the blinking cursor IS the type-here
  // signal (no placeholder words, no pulse). One attempt per auction,
  // and only from an idle page — never stealing focus from a field
  // the user is in, and never re-grabbing it mid-session.
  if (!caretPlaced) {
    caretPlaced = true;
    const editor = tiles.querySelector(
      '.tile.mine:not(.has-bid) .rebid input');
    if (editor && document.activeElement === document.body) editor.focus();
  }

  // a render can retitle (or remove) the very host the open tip
  // describes — the tip follows the truth without waiting for the
  // pointer to move (the old attr()-based tip live-updated; the
  // singleton must too)
  showTip();
}

// The reveal ceremony: the gavel returns for one mighty ceremonial
// stroke — long slow overhead windup, dramatic pause, STRIKE — and at
// the moment of impact the card quakes, a rubber stamp slams
// down, and confetti flies from the point of impact. One shot, wholly
// self-cleaning, and skipped for reduced-motion folks (a still frame
// of falling paper is just litter).
const FETE_MS = 5000;   // stamp + ceremony class linger this long
const STRIKE_MS = 850;  // when the mallet lands (63% of gavel-verdict)
const ECHO_MS = STRIKE_MS + 600;  // when the jackpot answers the strike
const CONFETTI_TICKS = 2000;  // piece lifetime in frames (calpuz's)
function celebrate() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = $('status');
  // THE SCHELLING JACKPOT (disclosed if): the help copy invites
  // playing Schelling's coordination game, and every-revealed-bid-
  // identical is that game won — the ceremony says so (the stamp)
  // and shows it (the convergence, below). Exact string equality,
  // cut rows included; two bids minimum (which reveal guarantees).
  const bids = state.bids || [];
  const consensus = bids.length >= 2
    && bids.every((b) => b.bid === bids[0].bid);
  // prestrike holds the 🔒 (CSS) until the mallet lands, so the 🎉
  // flip, glow, quake, SOLD, and money all land on the strike's one
  // beat (dreev lined them up) — the bids themselves unmask at the
  // render, information ahead of fanfare
  box.classList.add('ceremony', 'prestrike');
  const fete = el('div', 'fete');
  fete.setAttribute('aria-hidden', 'true');
  fete.append(el('span', consensus ? 'stamp consensus' : 'stamp',
                 consensus ? consensusStamp : stampCopy));
  box.append(fete);
  // The confetti is money (dreev's set: dollars, yen, pounds, coins,
  // the scales of justice) on REAL physics: vendored canvas-confetti
  // (v1.9.3, the library and burst recipe — counts, velocities,
  // gravities, stagger — lifted from dreev's calpuz). The library
  // owns its own fixed whole-viewport canvas on <body>. Currency
  // signs bake in the theme's money green; the emoji keep their own
  // colors.
  const green = getComputedStyle(document.documentElement)
    .getPropertyValue('--ok-fg').trim();
  const money = moneyGlyphs.map((g) =>
    confetti.shapeFromText({ text: g, scalar: 2, color: green }));
  // zIndex 5: above the page, BELOW the tooltips' 6 — a summoned tip
  // outranks even the party (the canvas lingers ~30s while stray
  // pieces time out, and money falling across a tooltip read as the
  // tips-behind-things bug to dreev)
  const fire = (opts) => confetti(Object.assign(
    { shapes: money, scalar: 2, ticks: CONFETTI_TICKS, zIndex: 5 },
    opts));
  // one burst, straight off the gavel's sound block — the point of
  // impact (dreev pared back calpuz's side cannons and topper; the
  // SPEED stays calpuz's). Clamped viewport fractions: a scrolled-
  // away gavel still rains on you.
  const block = box.querySelector(':scope > .gavel .block')
    .getBoundingClientRect();
  const ox = Math.min(Math.max(
    (block.left + block.width / 2) / innerWidth, 0), 1);
  const oy = Math.min(Math.max(
    (block.top + block.height / 2) / innerHeight, 0), 1);
  setTimeout(() => {  // the strike is the launch, and the beat drop
    box.classList.remove('prestrike');
    fire({ particleCount: 130, spread: 85, startVelocity: 55,
           gravity: 0.9, origin: { x: ox, y: oy } });
  }, STRIKE_MS);
  // The jackpot's echo: the side cannons dreev pared back RETURN for
  // this one moment — one per viewport corner, each aimed pixel-true
  // (aspect-ratio corrected; confetti's 90° is straight up) at the
  // very point of impact. A Schelling point is a focal point, so the
  // money literally CONVERGES on one.
  if (consensus) {
    setTimeout(() => {
      [[0, 0], [1, 0], [0, 1], [1, 1]].forEach(([cx, cy]) => {
        fire({ particleCount: 45, spread: 18, startVelocity: 65,
               gravity: 0.7, origin: { x: cx, y: cy },
               angle: Math.atan2((cy - oy) * innerHeight,
                                 (ox - cx) * innerWidth)
                 * 180 / Math.PI });
      });
    }, ECHO_MS);
  }
  setTimeout(() => {
    fete.remove();
    box.classList.remove('ceremony');
  }, FETE_MS);
}

// One-time structure + listeners for a row. The uname IS the key: it
// never changes for a living node, so these closures stay valid for the
// node's whole life. Everything mutable is synced in updateRow.
function buildRow(uname) {
  const t = el('div', 'tile');
  t.dataset.uname = uname;
  // one solid glyph for every star: CSS draws it hollow (outline)
  // until .selected fills it gold — a real radio button
  // buttons act on click or tap; tab is for editable fields (dreev)
  const star = el('button', 'tu', '★');
  star.tabIndex = -1;
  star.type = 'button';
  star.addEventListener('click', () => toggleTu(uname));
  const nameEl = el('div', 'tile-name');
  nameEl.append(star, buildNameField(uname));
  const bidEl = el('div', 'tile-bid');
  // The empty bid box of a takeable row is where dreev's hallway
  // tester kept tapping ("clicking on this box doesn't work"), so it
  // works: while you are NOBODY, tapping it claims the seat and
  // readies the editor — same deal as the star, and the intent is
  // just as unambiguous. Disclosed ifs: only for the unclaimed
  // (misclicks must not switch a claimed identity), only on takeable
  // (star-enabled) rows, only while bidless (a slot, not a card).
  bidEl.addEventListener('click', () => {
    if (me() === '' && !t.querySelector('.tu').disabled
        && !t.classList.contains('has-bid')) {
      toggleTu(uname);
    }
  });
  // the tip is computed on entry, not at render: its "3m ago" ages must
  // be hover-fresh, and render stays idempotent (no clock in the DOM)
  // mouseover, not mouseenter: it must fire BEFORE the document-level
  // mouseover that shows the singleton tip (target phase precedes the
  // bubble), so the tip always reads a fresh attribute
  bidEl.addEventListener('mouseover', () => {
    bidEl.setAttribute('data-tip', bidTip(uname));
  });
  // (green ✅ scrapped 2026-07-16 — it sat confusingly next to the ×,
  // and the card's green styling already says "bid in"; its subs
  // superscript was shelved 2026-07-15. Restore with the matching
  // lines in updateRow and the .check rules in style.css:)
  // const check = el('span', 'check', '✅');
  // check.append(el('sup', 'tile-subs'));
  // bidEl.append(check);
  // × removes the whole row from the roster — grayed out once a bid is
  // in, because a sealed bid is never deletable (its tip is bid-state-
  // dependent, so updateRow owns it)
  const x = el('button', 'x', '×');
  x.tabIndex = -1;
  x.type = 'button';
  x.addEventListener('click', () => {
    roster = roster.filter((u) => u !== uname);
    queueOp({ action: 'remove', aname: aname, uname: uname });
  });
  t.append(nameEl, bidEl, x);
  return t;
}

// The bid cell's content comes in three kinds; swapped wholesale when
// the kind changes, synced in place otherwise
function buildBidContent(kind, uname) {
  if (kind === 'editor') {
    const form = el('form', 'rebid');
    const input = el('input');
    input.maxLength = 80;
    input.autocomplete = 'off';
    // the mobile return key names the deed
    input.setAttribute('enterkeyhint', 'send');
    // typing withdraws the empty-bid objection
    input.addEventListener('input', () => input.classList.remove('error'));
    // Clicking/tapping away SAVES, like the name fields (dreev).
    // Empty = nothing to place (no objection: leaving an empty
    // editor is normal); unchanged = nothing new; already-sent =
    // enter-then-blur (the mobile keyboard closing right after a
    // submit) must not fire twice.
    input.addEventListener('blur', () => {
      const v = input.value.trim();
      if (v === '') input.value = input.defaultValue;
      else if (v !== input.defaultValue
               && v !== input.dataset.sent) placeBid(uname, form);
    });
    form.append(input);
    // the row-local busy sign: a mini gavel, shown by .rebid.busy
    const g = el('span', 'gavel mini');
    g.setAttribute('aria-hidden', 'true');
    g.innerHTML = '<span class="mallet"><span class="head"></span>'
      + '<span class="grip"></span></span>'
      + '<span class="bang"><span></span></span>'
      + '<span class="block"></span>';
    form.append(g);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      placeBid(uname, form);
    });
    return form;
  }
  if (kind === 'card') {
    const card = el('span', 'bid-card');
    card.append(el('span', 'bid-text'));
    return card;
  }
  // an empty card holds the space where their bid will land (the nbsp
  // gives it a text line's height)
  return el('span', 'bid-card slot', ' ');
}

// Idempotently sync a row node to the current state: same state in,
// same DOM out, whatever the node rendered before (a property qual
// holds this to a fresh build, byte for byte).
function updateRow(t, uname, b, mine, known, placed, locked) {
  const stamp = b === undefined ? undefined : b.tmod;
  const bcount = b === undefined ? 0 : b.bcount;
  const rename = pendingRename(uname);
  const pending = rename !== undefined;
  // Every row leads with its star, a radio for who-you-are: hollow =
  // claimable, dimmed hollow = dibsed, gold fill = you. A row is dibsed by
  // a rival device's registered claim, or (for claim-less legacy rows)
  // by a bid this browser didn't place. Clicking your own lit star
  // releases you to nobody. A bid placed by THIS browser never dibses
  // you out of the row (that keeps re-attach working if localStorage
  // forgot who you are). Once YOUR bid is in, the whole radio locks.
  const holder = state.claims[uname];
  const dibsed = uname !== mine
    && ((holder !== undefined && holder !== DEVICE)
        || (stamp !== undefined && placed[uname] === undefined));
  const star = t.querySelector('.tu');
  // revealed: identity is part of the frozen record, like the names
  star.disabled = dibsed || locked || state.revealed || pending;
  star.classList.toggle('selected', uname === mine);
  // a rival's REGISTERED claim fills the star in (hollow = open,
  // filled = claimed by someone else, gold = you)...
  const rival = holder !== undefined && holder !== DEVICE;
  star.classList.toggle('taken', rival);
  // ...and its tip names the claimant's rig when they reported one
  // (dreev's ask — the one cause-flavored branch in the tip logic);
  // everything else stays a pure function of (pressable, whose)
  star.setAttribute('data-tip',
    uname === mine
      ? (star.disabled ? lockedTip : disclaimTip)
      : rival && state.blurbs[uname]
      ? claimedByTip(state.blurbs[uname])
      : (star.disabled ? tooLateTip : claimTip));

  t.classList.toggle('has-bid', stamp !== undefined);
  t.classList.toggle('mine', uname === mine);
  // names freeze at the gavel, like bids (dreev: a post-close rename
  // could swap around who bid what) — grayed, never suppressed
  t.querySelector('.rename input').disabled = state.revealed
    || (pending && uname !== rename.desired);
  t.classList.toggle('cut',
    stamp !== undefined && !roster.includes(uname));
  // one-shot shimmer; a reused node needs the remove-reflow-add dance
  // so back-to-back re-bids restart the animation
  const shimmer = seen[uname] !== undefined && seen[uname] !== stamp;
  if (shimmer && t.classList.contains('updated')) {
    t.classList.remove('updated');
    void t.offsetWidth;
  }
  t.classList.toggle('updated', shimmer);
  // phase-lock breathe to the wall clock (period must match the CSS 3s)
  // so a freshly built row doesn't restart the fade mid-cycle; a reused
  // breathing row keeps its running animation untouched
  if (stamp !== undefined) t.style.animationDelay = '';
  else if (t.style.animationDelay === '') {
    t.style.animationDelay = -(Date.now() % 3000) + 'ms';
  }

  const bidEl = t.querySelector('.tile-bid');
  const kind = uname === mine ? 'editor'
    : stamp !== undefined ? 'card' : 'slot';
  let content = bidEl.firstElementChild;  // null on a fresh row
  // (when the shelved ✅ returns, it rides after the content, so a
  // firstElementChild that IS the check means "no content yet":
  // if (content && content.classList.contains('check')) content = null;)
  if (!content || content.dataset.kind !== kind) {
    const fresh = buildBidContent(kind, uname);
    fresh.dataset.kind = kind;
    if (content) content.replaceWith(fresh);
    else bidEl.prepend(fresh);
    content = fresh;
  }
  // One sheet of shadow per re-submission, UNCAPPED (dreev, per ZOI:
  // zero, one, or infinity — never three): heavy revisers wear their
  // pile, and that's the disinducement. Each sheet = a fill ring + an
  // outline ring stepping 2px down-right; var(--lift) rides along.
  const sheets = [];
  for (let i = 1; i < bcount; i++) {
    sheets.push(2 * i + 'px ' + 2 * i + 'px 0 -1px var(--ok-bg)',
                2 * i + 'px ' + 2 * i + 'px 0 0 var(--ok-fg)');
  }
  const stackShadow = sheets.concat('var(--lift)').join(', ');
  if (kind === 'editor') {
    const input = content.querySelector('input');
    // the gavel drop is a bright line: your bid stays readable in
    // your own editor, but the field goes dead at the reveal
    input.disabled = state.revealed || pending;
    input.className = stamp === undefined ? 'bid-slot' : 'bid-card';
    input.style.boxShadow = stamp === undefined ? '' : stackShadow;
    // never clobber what the user is typing: leave a focused or dirty
    // input alone (a draft = live value differs from defaultValue)
    if (input !== document.activeElement
        && input.value === input.defaultValue) {
      const baseline = known[uname] === undefined ? '' : known[uname];
      input.value = baseline;
      input.defaultValue = baseline;
    }
  } else if (kind === 'card') {
    // a received bid is a card; each re-submission stacks a sheet
    // behind it (visual depth caps at 3; the counter stays exact)
    const sealed = known[uname] === undefined;
    content.className = 'bid-card';
    content.style.boxShadow = stackShadow;
    const text = content.firstElementChild;
    text.className = sealed ? 'bid-text masked' : 'bid-text';
    text.textContent = sealed ? MASK : known[uname];
  }
  // (subs superscript shelved 2026-07-15)
  // t.querySelector('.tile-subs').textContent = String(subs);
  // the × guards SEATED bids only; a cut row (bid, no seat — races or
  // tampering) keeps a live × as the recovery path: clicking it purges
  // the zombie bid outright (server-side second-remove semantics)
  const seated = stamp !== undefined && roster.includes(uname);
  // the record freezes at the gavel: every × grays once revealed —
  // even the cut-row zombie purge, which would delete a REVEALED bid
  const frozen = seated || state.revealed || pending;
  const x = t.querySelector('.x');
  x.disabled = frozen;
  x.setAttribute('data-tip',
    frozen ? tooLateRemoveTip(uname) : removeTip(uname));
}

// Render a small, safe markdown subset to HTML. Escape-first: the
// raw text is entity-escaped before any markup applies, so nothing an
// author writes can smuggle live HTML in — only OUR transforms emit
// tags, and link hrefs must be http(s), so javascript: links never
// become links at all. Covers #/##/### headings, **bold**, *italic*,
// `code`, [text](url), - and 1. lists, > quotes, --- rules, and
// blank-line paragraphs (single newlines are <br>s).
function mdRender(md) {
  const esc = md.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // Code spans are LITERAL, so they're stashed behind placeholders
  // while the other transforms run (`*x*` must not italicize) and
  // restored after — which also lets a code span label a link. The
  // placeholder is unforgeable: the escape pass left no raw '<' in
  // the text, and emitted tags never put two in a row.
  const inline = (s) => {
    const stash = [];
    return s
      .replace(/`([^`]+)`/g, (_, c) =>
        '<<' + (stash.push('<code>' + c + '</code>') - 1) + '>>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/<<(\d+)>>/g, (_, i) => stash[i]);
  };
  return esc.split(/\n{2,}/).map((b) => {
    const lines = b.split('\n');
    const h = lines.length === 1 && lines[0].match(/^(#{1,3}) (.*)$/);
    if (h) {
      const n = h[1].length;
      return '<h' + n + '>' + inline(h[2]) + '</h' + n + '>';
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(b)) return '<hr>';
    if (lines.every((l) => /^\s*[-*] /.test(l))) {
      return '<ul>' + lines.map((l) =>
        '<li>' + inline(l.replace(/^\s*[-*] /, '')) + '</li>').join('')
        + '</ul>';
    }
    if (lines.every((l) => /^\s*\d+[.)] /.test(l))) {
      return '<ol>' + lines.map((l) =>
        '<li>' + inline(l.replace(/^\s*\d+[.)] /, '')) + '</li>')
        .join('') + '</ol>';
    }
    if (lines.every((l) => /^\s*&gt; ?/.test(l))) {
      return '<blockquote>' + inline(lines.map((l) =>
        l.replace(/^\s*&gt; ?/, '')).join('<br>')) + '</blockquote>';
    }
    return '<p>' + inline(lines.join('<br>')) + '</p>';
  }).join('');
}

// "2026-07-16 13:01 Thu" — dreev's exact Closed-line format, in the
// viewer's local time
// (deliberately local, and with no zone marker: two viewers in
// different zones see different wall-clock text for the same tfin
// instant — the line is for reading in place, not for quoting
// across timezones)
function closedStamp(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ' ' + day;
}

// Compact age for the bid-cell tooltip: 20s, 3m, 2h, 5d (floored; a
// client clock behind the server's floors to 0s rather than going weird)
function ago(iso) {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

// The bid cell's tooltip: whether a bid is in, and when. Three cases:
// no bid yet; submitted once ("your" on your own row); resubmitted
// (first vs latest submission times, same wording for every row).
function bidTip(uname) {
  const b = state.bidders.find((x) => x.uname === uname);
  if (b === undefined) return awaitingTip;
  if (b.bcount === 1) {
    return submittedTip(uname === me() ? yourBidWord : bidWord,
                        ago(b.tini));
  }
  return resubmittedTip(ago(b.tini), ago(b.tmod));
}

// The name is a live text field, like the + row's: click in and type.
// Enter commits the rename; Escape or clicking away restores the name
// (never commit-on-blur: that class of bug is dead and buried). The
// uname is the row's key, so the field's resting value never changes
// for a living node — a successful rename re-keys into a fresh row.
function buildNameField(uname) {
  const form = el('form', 'rename');
  form.append('@');
  const input = el('input');
  input.value = uname;
  input.defaultValue = uname;
  input.maxLength = 30;
  input.autocomplete = 'off';
  // the mobile return key names the deed
  input.setAttribute('enterkeyhint', 'done');
  input.addEventListener('input', () => {
    input.classList.remove('error');  // objection acknowledged
    const v = sanUname(input.value);
    if (v !== input.value) input.value = v;
  });
  // Clicking/tapping away SAVES (dreev, 2026-07-17, reversing the
  // old restore-on-blur: on a phone nobody expects the return key to
  // be load-bearing). Escape above still reverts first, so its blur
  // arrives with to === from and commits nothing. The old blur-
  // rebuild click-swallow is gone with keyed node reuse; the one
  // remaining edge is clicking a control on the SAME row you are
  // renaming (the re-key replaces that node mid-click).
  input.addEventListener('blur', () => {
    commitRename(uname, input.value, input);
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    commitRename(uname, input.value, input);
  });
  form.append(input);
  return form;
}

// Snapshot this browser's identity pair (uname + the raw bid-memory
// string) as it stands RIGHT NOW; the returned restorer reapplies it
// byte for byte — but only if the identity still rides the given tx
// (the user may have moved to another row via a star meanwhile:
// never clobber that)
function identitySnap(tx) {
  const key = 'tauction-mybids:' + aname;
  const uname = localStorage.getItem('tauction-uname');
  const bids = localStorage.getItem(key);
  return () => {
    if (localStorage.getItem('tauction-uname') !== tx.desired) return;
    if (uname === null) localStorage.removeItem('tauction-uname');
    else localStorage.setItem('tauction-uname', uname);
    if (bids === null) localStorage.removeItem(key);
    else localStorage.setItem(key, bids);
  };
}

// Fix a typo'd name — anyone may, honor system, like all roster edits.
// The server re-keys the seat and any bid together and refuses names
// already seated.
//
// A rename is a TRANSACTION: confirmed = the name the server last
// acknowledged for this seat, desired = the name on screen, flight =
// the one leg on the wire. Edits to a settling row stay LIVE: they
// advance the screen and identity instantly but ride the wire only
// as the NEXT leg, launched after the current one confirms — so a
// chain can never send a from-name the server never granted us (the
// stale alice→beta→gamma edit that renamed someone else's remote
// beta). rollback restores identity to the confirmed point when a
// leg is refused; nextRollback remembers the newest point consistent
// with the flight, for chained edits.
function commitRename(from, raw, field) {
  const to = sanUname(raw);
  if (!to || to === from) { field.value = field.defaultValue; return; }
  // A commit for a row the local roster no longer knows is a STALE
  // EVENT, not a request: the enter-then-blur pair fires this twice,
  // and the second run arrives after the first already remapped
  // 'from' away — its pre-check then found its own success and
  // falsely cried "taken" (dreev's bug). Also quiets a row removed
  // mid-edit, and cut rows (rosterless by definition), which used to
  // error server-side instead of declining.
  if (!roster.includes(from)) return;
  let tx = pendingRename(from);
  assert(tx === undefined || tx.desired === from,
    'rename edit on a name that is not the on-screen one');
  // Typing the pending edit's ORIGINAL name back is the undo of that
  // edit, never a collision with its own ghost (the old name's bid
  // row walks on until the wire catches up), so the tx's own
  // confirmed name is always a legal destination — the leg machinery
  // below then walks the server back of its own accord.
  if (slotUnames().includes(to)
      && !(tx !== undefined && to === tx.confirmed)) {
    banner(nameTakenBanner);
    field.classList.add('error');  // the problem is THIS field
    return;
  }
  let fresh = false;
  if (tx === undefined) {
    fresh = true;
    tx = { confirmed: from, desired: to, flight: null,
           rollback: null, nextRollback: null };
    tx.rollback = identitySnap(tx);  // the pre-rename state
  } else {
    // a dependent edit: remember the newest flight-consistent state
    // once per leg (later edits before the next leg keep the first)
    if (tx.nextRollback === null) tx.nextRollback = identitySnap(tx);
    pendingRenames.delete(tx.desired);
    tx.desired = to;
  }
  if (from === me()) {
    // your own rename must not unseat you while the op flies: local
    // identity and bid memory follow immediately
    localStorage.setItem('tauction-uname', to);
    rekeyMyBids(aname, from, to);
  }
  roster = roster.map((u) => (u === from ? to : u));
  pendingRenames.set(to, tx);
  if (fresh) launchRename(tx);
  if (state) renderStatus();  // a dependent edit repaints without a queue
}

// Put a rename transaction's next leg on the op chain: always from
// the CONFIRMED name, so the server is only ever asked about names
// it granted us.
function launchRename(tx) {
  // the leg is fixed NOW, not at send: an edit made while it waits
  // in the queue must ride as the next leg, never rewrite this one
  const leg = { from: tx.confirmed, to: tx.desired };
  queueLazyOp(() => {
    tx.flight = leg;
    return { action: 'rename', aname: aname,
             from: leg.from, to: leg.to };
  }, () => {
    // refused (a stale-roster race the local guard can't see): the
    // whole tx rolls back to its confirmed point — identity, memory,
    // roster — and the field reddens there, same as a local objection
    pendingRenames.delete(tx.desired);
    tx.rollback();
    roster = roster.map((u) => (u === tx.desired ? tx.confirmed : u));
    renderStatus();
    const recovered = rowNodes[tx.confirmed];
    assert(recovered, 'rename rollback lost its source row');
    recovered.querySelector('.rename input').classList.add('error');
  }, () => {
    // this leg is the confirmed truth now; a dependent edit made
    // meanwhile launches as the next leg, re-based on it
    tx.confirmed = tx.flight.to;
    tx.flight = null;
    if (tx.desired === tx.confirmed) {
      pendingRenames.delete(tx.desired);
      renderStatus();  // the row's controls come back to life
    } else {
      tx.rollback = tx.nextRollback;
      tx.nextRollback = null;
      launchRename(tx);
    }
  });
}

// The transport-loss sweep, run on every adopted snapshot: adoption
// is gated on all writes having settled, so any transaction still
// pending here lost its response in transport — the server's roster
// is the verdict on whether its flight committed. Committed: keep
// the leg that landed (walking a dependent edit back onto it); lost:
// the whole tx rolls back. Either way the tx retires — the adopted
// snapshot repaints the roster itself.
function reconcileTransportRenames(res) {
  const serverUnames = new Set(res.roster.concat(
    res.bidders.map((b) => b.uname)));
  pendingRenames.forEach((tx, key) => {
    assert(tx.flight !== null, 'a settled rename left its tx behind');
    const committed = serverUnames.has(tx.flight.to)
      && !serverUnames.has(tx.flight.from);
    if (!committed) tx.rollback();
    else if (tx.nextRollback !== null) tx.nextRollback();
    pendingRenames.delete(key);
  });
}

// Claim a row as yourself, or release it if it's already yours
function toggleTu(uname) {
  if (me() === uname) {
    localStorage.removeItem('tauction-uname');
    queueOp({ action: 'release', aname: aname, uname: uname,
              deviceID: DEVICE }); // only the holder can vacate the seat
  } else {
    localStorage.setItem('tauction-uname', uname);
    queueOp({ action: 'claim', aname: aname, uname: uname,
              deviceID: DEVICE,     // stake it: rival pages show dibs
              deviceBlurb: DEVBLURB }); // ...and who by, humanely
  }
  const input = $('tiles').querySelector('.rebid input');
  if (input) input.focus();
}



/* ------------------------------ actions ------------------------------- */

let bidsAloft = 0;  // submissions still flying; busy shows till zero

async function placeBid(uname, form) {
  const a = aname;  // pin the auction this bid belongs to; the user might
                    // switch auctions while the POST is in flight
  const input = form.querySelector('input');
  const bid = input.value.trim();
  assert(uname, 'placeBid without an identity');
  // your editor only exists while me() === uname, and me() can only
  // ever echo localStorage — so this holds or the model is broken
  assert(localStorage.getItem('tauction-uname') === uname,
    'editor identity out of sync with localStorage');
  // a local slip gets a local objection: the field itself reddens
  // (cleared on the next keystroke); banners are for the server's news
  if (!bid) { input.classList.add('error'); return; }
  input.dataset.sent = bid;  // this exact text is on its way: the
                             // blur that follows an enter is a no-op
  // The editor stays HOT during flight: down to the wire you can
  // change your mind and resubmit while the last bid still flies.
  // Bids ride the op chain, so submissions land in the order you made
  // them — your last word always wins on the sheet. busy clears only
  // when the whole volley has settled.
  form.classList.add('busy');
  bidsAloft++;
  // the radio locks the moment you commit: a mid-flight identity hop
  // orphaned the bid under the old name and left a blank editor (the
  // settle's render recomputes the lock from state truth)
  $('tiles').querySelectorAll('.tu').forEach((s) => { s.disabled = true; });
  const at = startWrite();
  opChain = opChain.then(async () => {
    // only the network call sits in the try: an exception downstream
    // of a SUCCESSFUL write (say, a render bug) must crash loudly, not
    // settle the same write twice via the catch (the bookkeeping
    // assert caught exactly that)
    let res = null;
    try {
      res = await apiPost({ action: 'bid', aname: a, uname: uname,
                            bid: bid, deviceID: DEVICE,
                            deviceBlurb: DEVBLURB });
    } catch (e) {
      banner(e2153(e.message));
    }
    if (res && !res.error) {
      const mine = umap(JSON.parse(
        localStorage.getItem('tauction-mybids:' + a) || '{}'));
      mine[uname] = bid;
      localStorage.setItem('tauction-mybids:' + a, JSON.stringify(mine));
      input.defaultValue = bid;  // the submitted text is the new
                                 // baseline, not a draft to shield
    }
    bidsAloft--;
    if (bidsAloft === 0) form.classList.remove('busy');
    settleWrite(res, at);
  });
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

// (The opener arrives here already blurred by the universal
// blur-on-activation rule in wireUp, so the dialog records BODY as
// its focus-restore target and closing leaves no stuck tooltip.)
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
    banner(copyFailBanner(e.message));
  }
}


// Roster and claim writes are row-level ops, serialized client-side so
// a burst of adds can't pile onto the server's script lock. The UI is
// optimistic (the local roster already changed); the box grays until
// the server confirms. Only the NEWEST op's snapshot is adopted —
// earlier ones predate later local edits.
let opChain = Promise.resolve();
function queueOp(body, onRefusal, onSuccess) {
  queueLazyOp(() => body, onRefusal, onSuccess);
}

function queueLazyOp(request, onRefusal, onSuccess = () => {}) {
  $('status').classList.add('stale');
  if (state) renderStatus();
  if (!configured) return;
  const at = startWrite();
  opChain = opChain.then(async () => {
    let res = null;
    try {
      res = await apiPost(request());
    } catch (e) {
      banner(e2154(e.message));
    }
    if (res && !res.error) onSuccess(res);
    settleWrite(res, at, onRefusal);  // exactly once, whatever happened
  });
}

// Bookkeeping for starting any write; returns the write's birth stamp
// for settleWrite's last-write-standing test
function startWrite() {
  lastWriteAt = Date.now();
  writesPending++;
  return lastWriteAt;
}

// Every write response funnels here. Only the LAST write standing gets
// to paint — earlier responses can lack later local edits — and it
// paints directly only when it's also the newest write; otherwise (out-
// of-order settles, failures, stale aname) fetch a snapshot that's
// guaranteed to postdate everything.
// onRefusal (optional): the op's own recovery beyond the banner —
// e.g. a bounced describe turns its field red and reopens the editor
// (the banner is global; the problem is one specific field)
function settleWrite(res, at, onRefusal) {
  writesPending--;
  assert(writesPending >= 0, 'write bookkeeping went negative');
  writeSettledAt = Date.now();
  if (res && res.error) {
    // Disclosed if: losing a seat race (ERROR1304) is normal auction
    // physics, not an exceptional failure — the recovery snapshot
    // itself shows the truth (filled star + claimed-by tooltip), so
    // no red banner for that one. Everything else stays loud.
    if (!/^ERROR1304/.test(res.error)) banner(res.error);
    if (onRefusal) onRefusal();
    res = null;
  }
  if (writesPending > 0) return;
  if (res && res.aname === aname && at === lastWriteAt) {
    ingest(res);
    render();
  } else {
    refresh();
  }
}

function pressReveal() {
  $('seal').disabled = true;  // no double-fire; render recomputes it
  // the reveal is the most table-wide op there is: the big gavel
  // hammers over the grayed ledger while it round-trips (the settle's
  // render lifts the stale)
  $('status').classList.add('stale');
  const at = startWrite();
  // the reveal rides the op chain like every other write: it must
  // never overtake your own still-flying revision on the wire (your
  // clicks land in the order you made them)
  opChain = opChain.then(async () => {
    let res = null;
    try {
      res = await apiPost({ action: 'reveal', aname: aname });
    } catch (e) {
      banner(e2155(e.message));
    }
    settleWrite(res, at);  // exactly once, whatever happened
  });
}


function addName() {  // returns the added uname ('' if refused)
  const uname = sanUname($('roster-input').value);
  if (!uname) {
    $('roster-input').classList.add('error');
    return '';
  }
  if (roster.includes(uname)) {
    // Typing an existing name is POINTING at that row (the hallway
    // test: "maybe i type in the name i want to make a bid for?" —
    // yes): a takeable seat is taken, with the editor readied.
    // Already you = nothing to do, quietly. A held/dibsed/locked
    // seat objects: red ring, text kept for fixing — never silently
    // swallowing what you typed.
    const trow = rowNodes[uname];
    if (uname === me()) {
      $('roster-input').value = '';
      return '';
    }
    if (trow && !trow.querySelector('.tu').disabled) {
      $('roster-input').value = '';
      toggleTu(uname);  // claims the seat and focuses the editor
      return uname;
    }
    $('roster-input').classList.add('error');
    return '';
  }
  $('roster-input').value = '';
  // Disclosed if: on a browser with NO remembered identity at all,
  // the first name typed into the (you-starred) + row is YOURS —
  // dreev's expectata: "load a new auction, add a name = i've added
  // myself". Locally only: no server claim is registered, so a real
  // person claiming this name from their own device unseats the
  // assumption cleanly; your first bid stakes it for real. A browser
  // that already knows who you are (dreev seeding a roster for
  // others) adds plain rows — your own name re-latches by the row
  // gate when it appears.
  if (localStorage.getItem('tauction-uname') === null) {
    localStorage.setItem('tauction-uname', uname);
  }
  roster.push(uname);
  queueOp({ action: 'add', aname: aname, uname: uname });
  return uname;
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

// Typed names CREATE auctions; joining an existing one is by URL or
// link only (every caller of this is the typed path — URL arrivals go
// through init). So a typed name that already has data is refused,
// and nobody stumbles into a stranger's auction by picking "pizza".
async function switchAuction(a) {
  if (!a || a === aname) return;
  $('status').classList.add('stale');  // busy while we look the name up
  try {
    const res = await apiGet({ action: 'state', aname: a });
    // the user kept typing: a newer probe owns the field now
    if (a !== sanAname($('aname').value)) return;
    if (res.error) { banner(res.error); return; }
    assertState(res);
    if (res.exists) {
      stickyBanner(auctionExistsBanner('/' + a));
      return;
    }
    aname = a;
    setPath(aname);
    $('aname').defaultValue = a;  // the committed baseline...
    $('aname').disabled = true;   // ...and NAMES ARE CHOSEN ONCE
                                  // (dreev): the field's one job is
                                  // done; the URL is the navigation
    // the dead field explains itself (dreev's glitch report: mid-
    // blurb he clicked the name and nothing happened) — the CSS
    // sheds its box and the LABEL's tip flips to the committed-name
    // copy (no new tooltip: dreev's anti-clutter call)
    document.querySelector('label[for="aname"]')
      .setAttribute('data-tip', nameStoneTip);
    $('banner').hidden = true;  // landing somewhere real clears any
                                // dead-end sign still standing
    state = null;
    roster = [];
    seen = umap();
    wasRevealed = null;
    caretPlaced = false;  // the new auction gets its own arrival focus
    descModeSet = false;  // and picks its description mode afresh
    ingest(res);  // the probe IS a live snapshot: paint it, no refetch
    render();
  } catch (e) {
    banner(e2157(e.message));
  } finally {
    // on any non-commit path the old (or unnamed) page is back in
    // charge and isn't busy; after a commit render() already unstaled
    $('status').classList.remove('stale');
  }
}

/* ------------------------------- wiring ------------------------------- */

function wireUp() {
  // The resting truth of an empty page, stamped unconditionally
  // (dreev caught the padlock resting on the HTML's old "Reveal
  // bids!"): first a name, then bidders. Any real render paints
  // over it.
  $('seal').setAttribute('data-tip', needNameTip);

  // Universal button hygiene: an activated button doesn't keep
  // focus — you pressed it, you know what it is (none is a tab stop,
  // so focus on one serves nothing). This also drops any focus-tip
  // and, in capture phase, lands before showModal records its
  // focus-restore target (dialog-close used to re-stick the opener's
  // tip). Word-hosts (the auction label) keep their tap-to-focus tips.
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) b.blur();
  }, true);

  // Universal field hygiene, part two: Escape means "never mind" —
  // revert to the baseline and leave. defaultValue IS the committed
  // truth in every field (the never-clobber convention), so ONE rule
  // covers them all; the blur that follows finds a clean field and
  // commits nothing. No per-field Escape wiring anywhere.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const f = e.target.closest('input, textarea');
    if (f) { f.value = f.defaultValue; f.blur(); }
  }, true);

  // The singleton tip's reasons: pointer and focus, tracked globally.
  // Pointer via mousemove + elementFromPoint, NOT mouseover: Chrome
  // does not dispatch mouse events on disabled form controls, and the
  // grayed stars/×s wear load-bearing tips ("Too late to..."). Hit-
  // testing sees disabled elements fine, and it respects
  // pointer-events:none, so the tip and the confetti canvas never
  // block the probe.
  document.addEventListener('mousemove', (e) => {
    const over = document.elementFromPoint(e.clientX, e.clientY);
    const host = (over && over.closest('[data-tip]')) || null;
    if (host === hoverHost) return;
    hoverHost = host;
    showTip();
  });
  document.addEventListener('focusin', (e) => {
    focusHost = e.target.closest('[data-tip]');
    showTip();
  });
  document.addEventListener('focusout', () => {
    focusHost = null;
    showTip();
  });

  $('seal').addEventListener('click', pressReveal);
  $('desctoggle').addEventListener('click', editDesc);
  $('descedit').addEventListener('blur', commitDesc);
  $('descedit').addEventListener('input', () => {
    $('descedit').classList.remove('error');  // objection acknowledged
  });

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
  });
  // NAMES COMMIT ON DELIBERATE GESTURES ONLY — Enter or Tab — never
  // on a timer, and deliberately not even on blur (dreev's mid-typing
  // lockout, 2026-07-18: the old 500ms debounce committed his half-
  // typed name and froze the field; blur-commit would let a stray tap
  // elsewhere do the same). Committing a name is IRREVERSIBLE (names
  // are chosen once), so a thinking pause or a wandering click costs
  // nothing: the typed text just waits in the live field. Tab (the
  // + row's commit-on-Tab precedent) also carries the caret on to
  // the description; shift-tab still means backwards, away.
  // Disclosed ifs: only a nonempty name commits, and the caret moves
  // only if the name actually took — a refusal keeps you in the
  // field, beside the sticky gate banner.
  $('aname').addEventListener('keydown', async (e) => {
    if ((e.key !== 'Enter' && (e.key !== 'Tab' || e.shiftKey))
        || $('aname').value === '') return;
    const wasTab = e.key === 'Tab';
    e.preventDefault();
    await switchAuction(sanAname($('aname').value));
    if (aname !== '' && wasTab) $('descedit').focus();
  });

  // Enter/comma/space commit; deliberately NO commit-on-blur — the blur
  // fires mid-click when you tap a row control, and the rebuild it
  // triggered used to destroy the very button being clicked. An
  // uncommitted name just stays visible in the + row.
  // Commit the + row and — iff the fresh row is YOURS (the gold
  // star: you just added yourself) — land in its bid editor: name,
  // tab (or tap away, or enter), bid. Frictionless self-add is the
  // whole game (dreev's hallway test); adding someone ELSE keeps the
  // caret here for the next name.
  const commitAdd = () => {
    const added = addName();
    const t = rowNodes[added];
    if (t && t.classList.contains('mine')) {
      t.querySelector('.rebid input').focus();
    }
  };
  $('roster-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
      e.preventDefault();
      commitAdd();
    }
    if (e.key === 'Tab' && !e.shiftKey
        && $('roster-input').value !== '') {
      e.preventDefault();
      commitAdd();
    }
  });
  // tapping away commits here too (the + row is a field like any
  // other; an empty blur commits nothing and objects to nothing)
  $('roster-input').addEventListener('blur', () => {
    if ($('roster-input').value !== '') commitAdd();
  });
  $('roster-input').addEventListener('input', () => {
    $('roster-input').classList.remove('error');  // objection withdrawn
    const v = $('roster-input').value;
    const s = sanUname(v);
    if (s !== v) $('roster-input').value = s;
  });
}

async function init() {
  wireUp();

  const m = location.pathname.match(/^\/([a-zA-Z0-9]{1,40})\/?$/);
  if (m) aname = m[1].toLowerCase();
  $('aname').value = aname;
  $('aname').defaultValue = aname;  // the baseline Escape reverts to

  if (!configured) {
    banner(e2156);
    return;
  }

  // Disclosed if: a bare visit invents no name (the particle list is
  // gone) — the ledger idles with the + row disabled and the caret
  // waiting in the empty auction field; switchAuction wakes
  // everything when the user picks. NOT marked stale: stale means
  // busy (the gavel hammers), and an unnamed page is idle, not busy.
  // geography first (fire-and-forget): the earlier it resolves, the
  // more claims and bids carry it in their deviceBlurb
  locate();
  if (!aname) {
    $('roster-input').disabled = true;
    $('descedit').disabled = true;  // nothing to describe yet
    $('aname').focus();
  } else {
    setPath(aname);
    $('aname').disabled = true;  // arrived named: the name is stone
    document.querySelector('label[for="aname"]')  // ...and the label's
      .setAttribute('data-tip', nameStoneTip);    // tip says so
    paintCached();
    await refresh();
  }
  setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, POLL_MS);
}

init();
