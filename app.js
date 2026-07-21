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

// A hidden tab's entire traffic: one title-only peek a minute — an
// explicit coarse cadence (dreev's ruling, 2026-07-20), never
// outsourced to browser throttling heuristics — and none at all once
// the reveal is seen (peekTitle's latch)
const PEEK_MS = 60000;

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

// A umap parsed out of localStorage (absent key = empty map)
const jmap = (key) => umap(JSON.parse(localStorage.getItem(key) || '{}'));

async function apiGet(params) {
  const r = await fetch(api + '?' + new URLSearchParams(params));
  return r.json();
}

// Body as a plain string => "simple" CORS request, no preflight (Apps Script
// web apps can't answer preflights)
async function apiPost(body) {
  // the chronicle's outbound half: every write announces itself as
  // '(actor) → deed' the moment it flies (the settled truth narrates
  // at ingest; every error warns ✗ inside banner() itself)
  const s = seats.find((z) => z.pid === mypid());
  console.log('(' + (s === undefined ? 'nobody' : '@' + s.uname)
    + ') → ' + body.action + (body.uname ? ' @' + body.uname : '')
    + (body.to ? ' → @' + body.to : ''));
  const r = await fetch(api, { method: 'POST', body: JSON.stringify(body) });
  return r.json();
}

// Banners STICK (dreev's ruling, 2026-07-19): a timer must not
// snatch bad news while you read — the old 5s self-destruct is gone.
// A banner leaves exactly three ways: its × (wired in wireUp), a
// newer banner replacing it, or a later successful settle retiring
// it (settleWrite). Server and user text comes here, through
// textContent — never markup.
function banner(msg, kind) {
  console.warn('✗ ' + msg);  // every bannered error joins the
                             // chronicle — logged HERE so no call
                             // site can forget
  $('banner-msg').textContent = msg;
  $('banner').className = kind || 'err';
  $('banner').hidden = false;
}

// The dead-end-sign variant: innerHTML, for the link inside; ONLY
// app-built markup may come here, never server or user text (that
// all goes through banner()'s textContent).
function linkBanner(html) {
  $('banner-msg').innerHTML = html;
  console.warn('✗ ' + $('banner-msg').textContent);  // the chronicle
                             // gets the words, sans markup
  $('banner').className = 'err';
  $('banner').hidden = false;
}

// THE COMMIT PULSE (dreev's ruling, 2026-07-19): the instant a
// gesture queues a write, flash the field it happened in — submit-
// button legibility without submit buttons; the outgoing twin of the
// incoming shimmer. Only ever called where a write actually queues:
// a pulse on a refused or no-op gesture would be a lie.
function flashCommit(node) {
  node.classList.remove('committed');  // the shimmer's same remove-
  void node.offsetWidth;               // reflow-add dance: back-to-
  node.classList.add('committed');     // back commits restart it
}

/* ------------------------------- state -------------------------------- */

let aname = '';
let state = null;         // latest server snapshot of the current auction
let seats = [];           // local working copy of the seats: one
                          // {pid, uname} per person, insertion order
                          // — the pid is the IDENTITY (2026-07-19,
                          // dreev's spec), the uname just its label
let seen = umap();        // pid -> updated stamp at last render (shimmer)
let wasRevealed = false;  // reveal state at last render
let adopted = false;      // THE ARRIVAL EDGE: has any snapshot —
                          // cached or live — been adopted for this
                          // auction? The one-shot arrival effects
                          // (caret landing, description mode choice,
                          // no-fanfare-for-latecomers) all key off
                          // the first render where this is false;
                          // one named edge, not a latch apiece
                          // (2026-07-19, folding caretPlaced,
                          // descModeSet, and wasRevealed's null)
let writeSeq = 0;         // bumped when a write STARTS (bid, add/
                          // remove, claim, reveal): of concurrent
                          // write responses, only the newest — the
                          // one holding the latest seq — is adopted.
                          // Sequence counters, never wall clocks:
                          // Date.now() is not monotonic (NTP steps
                          // it), and a stepped clock froze adoption
let writesPending = 0;    // writes queued or in flight, of any kind
let settleSeq = 0;        // bumped when a write SETTLES: a read
                          // snapshot is trustworthy only if no
                          // settle landed between its request and
                          // its response (the server may not have
                          // committed a write before then)
let refreshing = false;
let seenRevealed = false; // has ANY response — adopted (ingest) or
                          // merely peeked at (peekTitle) — shown this
                          // page the latch? Reveal is one-way, so
                          // this only ever goes true, and the hidden
                          // peek retires on it: a revealed auction
                          // has no further news to poll for

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
    && Array.isArray(res.seats) && res.seats.every(
      (s) => typeof s.pid === 'string' && typeof s.uname === 'string')
    && Array.isArray(res.bidders) && res.bidders.every(
      (b) => typeof b.pid === 'string' && STAMP_RE.test(b.tini)
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
      && res.bids.every((b) => typeof b.pid === 'string'
        && typeof b.bid === 'string'))),
  'bad state shape — is the deployed Code.gs current?');
}

// THE CHRONICLE (dreev's spec, 2026-07-20): every adopted snapshot
// narrates its delta to the console — the ledger's story, one line
// per change, in the app's own glyphs. ONE differ at the ONE
// adoption seam (ingest), so local writes and remote arrivals alike
// surface here when they become table truth, and no per-action
// logging exists anywhere; an unchanged snapshot narrates nothing
// (the 5s poll stays silent by construction). Arrival — no previous
// snapshot — tables the roster as found; the reveal tables the
// unmasked results, the one moment bid TEXT may reach the console
// (sealed bids narrate as ordinals only). Developer-facing
// diagnostics, deliberately plain inline English, not stringles
// copy: the end user never reads here.
function narrate(prev, next) {
  const label = umap();  // pid -> its CURRENT display name
  next.seats.forEach((s) => { label[s.pid] = s.uname; });
  if (prev === null) {
    console.log('· /' + next.aname
      + (next.revealed ? ' (revealed)' : ''));
    if (next.seats.length > 0) {
      console.table(next.seats.map((s) => {
        const b = next.bidders.find((x) => x.pid === s.pid);
        return { who: '@' + s.uname,
                 bids: b === undefined ? 0 : b.bcount,
                 device: next.blurbs[s.pid] || '' };
      }));
    }
    return;
  }
  const was = umap();  // pid -> its name in the PREVIOUS snapshot
  prev.seats.forEach((s) => { was[s.pid] = s.uname; });
  next.seats.forEach((s) => {
    if (was[s.pid] === undefined) console.log('+ @' + s.uname);
    else if (was[s.pid] !== s.uname) {
      console.log('@' + was[s.pid] + ' → @' + s.uname);
    }
  });
  prev.seats.forEach((s) => {
    if (label[s.pid] === undefined) console.log('− @' + s.uname);
  });
  const had = umap();  // pid -> bcount in the previous snapshot
  prev.bidders.forEach((b) => { had[b.pid] = b.bcount; });
  next.bidders.forEach((b) => {
    if (had[b.pid] !== b.bcount) {
      console.log('@' + (label[b.pid] || b.pid) + ': bid #' + b.bcount);
    }
  });
  Object.keys(next.claims).forEach((p) => {
    if (prev.claims[p] !== next.claims[p]) {
      console.log('★ @' + (label[p] || p)
        + (next.blurbs[p] ? ' — ' + next.blurbs[p] : ''));
    }
  });
  Object.keys(prev.claims).forEach((p) => {
    if (next.claims[p] === undefined) {
      console.log('☆ @' + (was[p] || p));
    }
  });
  if (prev.blurb !== next.blurb) {
    console.log('✎ description (' + next.blurb.length + ' chars)');
  }
  if (!prev.revealed && next.revealed) {
    console.log('🎉 revealed');
    console.table((next.bids || []).map((b) =>
      ({ who: '@' + (label[b.pid] || b.pid), bid: b.bid })));
  }
}

// Validate + adopt a state snapshot from the server; remember it so the
// next page load can paint instantly instead of flashing a blank roster
function ingest(res) {
  assertState(res);
  res.claims = umap(res.claims);
  res.blurbs = umap(res.blurbs);
  narrate(state, res);
  state = res;
  seenRevealed = seenRevealed || res.revealed;
  localStorage.setItem('tauction-state:' + res.aname, JSON.stringify(res));
  // Your device's registered claim is authoritative for who you are.
  // (In the uname era this dragged bid memory along to the new name;
  // pids never change, so following the claim home is the whole job.)
  const claimed = Object.keys(res.claims)
    .find((p) => res.claims[p] === DEVICE);
  if (claimed !== undefined && claimed !== myPidStored()) {
    storeMyPid(claimed);
  }
}

async function refresh() {
  // (the !aname leg: an unnamed page has nothing to fetch — the user
  // has not picked an auction yet)
  if (!configured || refreshing || !aname) return;
  refreshing = true;
  const a = aname;  // the auction this request is for
  const seqAtRequest = settleSeq;
  // Only the network call sits in its own try (placeBid's precedent):
  // transport death is WEATHER, not news (dreev's ruling, 2026-07-20)
  // — no user action was lost, so nothing banners. The ledger grays
  // under the hammering gavel (the app's one signal for "this picture
  // may be stale") until a poll lands and render clears it, and the
  // diagnostic detail goes to the console, greppable by its code.
  // Anything downstream of a SUCCESSFUL response — a spoken refusal,
  // version skew — still banners loudly: polling heals outages,
  // never drift.
  let res = null;
  try {
    res = await apiGet({ action: 'state', aname: a });
  } catch (e) {
    console.warn(e2152(e.message));
    $('status').classList.add('stale');
  }
  try {
    if (res !== null) {
      if (res.error) banner(res.error);
      // adopt only if no writes are pending and no write SETTLED while
      // this snapshot was in flight — anything less and it can lack a
      // name you just added or a bid you just placed (the server
      // commits a write somewhere between our send and its response)
      else if (res.aname === aname && writesPending === 0
               && settleSeq === seqAtRequest) { ingest(res); render(); }
    }
  } catch (e) {
    banner(e2152(e.message));
  } finally {
    refreshing = false;
    // (the old mid-flight-switch refire died with names-are-chosen-
    // once: polls run only on named pages, where aname is immutable)
  }
}

// THE TITLE PEEK: a hidden tab's entire participation — a slow bare
// state GET spent ONLY on the tab's title (Sol's title-only law).
// Nothing is ingested: the witnessed-reveal fanfare and every
// never-clobber invariant sleep until the tab is actually looked at
// (the visibilitychange refresh). No banner on failure — a hidden
// tab has no reader to alarm, and the return-refresh re-raises
// anything real the moment one exists — but the diagnostic goes to
// the console like the poll's (transport detail is console
// business, dreev's ruling).
// Disclosed ifs: unnamed/unconfigured/latched pages have nothing to
// peek at, and a peek landing after the tab turned visible yields to
// the adopted pipeline (its snapshot may predate the return-
// refresh's).
async function peekTitle() {
  if (!configured || !aname || seenRevealed) return;
  try {
    const res = await apiGet({ action: 'state', aname: aname });
    assertState(res);  // an {error} payload fails this shape check
    seenRevealed = seenRevealed || res.revealed;
    if (document.visibilityState !== 'hidden') return;
    document.title = tabTitle(
      titleGlyph(res.seats, res.bidders, res.revealed,
                 pidAmong(res.seats, umap(res.claims))), aname);
  } catch (e) { console.warn(e2152(e.message)); }
}

/* ------------------------------ rendering ----------------------------- */

function render() {
  if (!state) return;
  // adopt the server's seats: every adopted snapshot is gated on being
  // newer than this client's newest write, so it contains every local
  // edit — no shielding needed (cloned: local edits mutate labels)
  seats = state.seats.map((s) => ({ pid: s.pid, uname: s.uname }));
  renderStatus();
  renderDesc();
  adopted = true;  // the arrival edge is consumed exactly once
  $('status').classList.remove('stale');  // server truth is on screen
}

// The description block: the view pane always mirrors server truth;
// the editor syncs only when you're not mid-edit (never-clobber, same
// as the bid editor). If someone else's edit lands while yours is in
// progress, warn once and RE-BASE the draft — your next save, made
// informed, wins (the server's compare-and-swap remains the backstop
// for sub-poll races).
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
  if (!adopted) {  // the arrival picks the mode, once per auction
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
    flashCommit($('desc'));  // the card glows: your words are away
  }
  $('desc').classList.toggle('viewing', edit.value !== '');
}

// This browser's identity ledger: aname -> pid (which seat is YOU,
// per auction). The pid never changes, so nothing downstream — bid
// memory, claims, row keys — ever needs re-keying. tauction-uname
// lives on only as a display-name HINT for the add-yourself flow.
function myPidStored() {
  return jmap('tauction-pids')[aname] || '';
}
function storeMyPid(p) {
  const m = jmap('tauction-pids');
  if (p === '') delete m[aname];
  else m[aname] = p;
  localStorage.setItem('tauction-pids', JSON.stringify(m));
}

// You are whoever this browser holds the pid of — but only while that
// pid has a rendered seat here AND the server's claim for it (if any)
// is this device's. Unclaimed-on-the-server plus remembered locally
// counts as yours (the optimistic moment before your claim lands); a
// rival device's registered claim unseats you.
// The rule itself lives in pidAmong, over ANY (seats, claims) pair:
// mypid answers for the adopted state; the hidden title peek asks
// the same question of a raw snapshot it never adopts.
function pidAmong(ss, claims) {
  const p = myPidStored();
  if (!p || !ss.some((s) => s.pid === p)) return '';
  const holder = claims[p];
  return holder === undefined || holder === DEVICE ? p : '';
}
function mypid() {
  // no snapshot yet = no claims are known: optimistically yours (the
  // same optimistic moment as an unclaimed-on-the-server seat)
  return pidAmong(seats, state === null ? umap() : state.claims);
}

// Every bid this browser has placed on this auction, keyed by pid —
// pids never change, so this memory never needs migrating
function myBids() {
  return jmap('tauction-mybids:' + aname);
}

// Bids whose text this client knows: the ones it placed, plus everyone's
// once revealed. Rows render whatever is known and mask the rest — the
// same rule makes your bids visible to you and sealed for everyone else.
function knownBids() {
  const known = myBids();
  (state.bids || []).forEach((b) => { known[b.pid] = b.bid; });
  return known;
}

// The BIDS box IS the app: one ledger line per roster member. Dashed,
// breathing cells = no bid yet; solid green = bid in (text if you may
// read it, a blurred decoy if not); struck-through name = bid doesn't
// count toward the reveal (not on the roster — reachable only via roster
// races, never via the UI). Your own row's bid slot is an input: your bid
// lives there, editable in place; enter (re)submits. × removes a row from
// the roster, offered only while it has no bid to protect. Reveal lights
// the 🎉 and glows the card, once.
// The tab-title state glyph — dreev's ruled quadruple (2026-07-20) —
// derived per-viewer from ANY snapshot: the adopted state, or a raw
// glimpse the hidden peek never adopts. Disclosed ifs, one per ruled
// state: revealed; all in (two-plus, none missing) awaiting the
// press; everyone waiting on YOU (the standout — the one missing bid
// is your own, with at least one other person actually waiting; a
// solo roster never stars, nobody's there to wait); else waiting on
// bidders.
function titleGlyph(ss, bidders, revealed, mine) {
  if (revealed) return revealedGlyph;
  const missing = ss.filter(
    (s) => !bidders.some((b) => b.pid === s.pid));
  if (ss.length >= 2 && missing.length === 0) return readyGlyph;
  if (ss.length >= 2 && missing.length === 1
      && missing[0].pid === mine) {
    return yourMoveGlyph;
  }
  return waitingGlyph;
}

let lastPrint = '';  // fingerprint of the last-rendered rows
let rowNodes = umap();   // pid -> its living row node (keyed reuse;
                         // the pid never changes, so a rename never
                         // re-keys a living node)

function renderStatus() {
  // Skip no-op rebuilds: replacing the nodes destroys any button mid-
  // click (mousedown and mouseup must hit the same node), so a rebuild
  // that changes nothing can silently eat a click. wasRevealed and seen
  // are in the fingerprint because the render right after a reveal or a
  // shimmer must still run: it retires those one-shot effects.
  const print = JSON.stringify([aname, wasRevealed, seen, seats,
    state.bidders, state.seats, state.revealed, state.tfin,
    state.claims, state.blurbs, mypid(), knownBids()]);
  if (print === lastPrint) return;
  lastPrint = print;

  const box = $('status');
  box.classList.toggle('revealed', state.revealed);
  // fanfare belongs to the WITNESSED false->true flip: a latecomer's
  // arrival render (the adopted edge) sets the baseline silently
  const justNow = adopted && wasRevealed === false && state.revealed;
  box.classList.toggle('just-revealed', justNow);
  if (justNow) celebrate();
  wasRevealed = state.revealed;

  const mine = mypid();

  // The padlock is the reveal button: pressable (and pulsing) only
  // once everyone on the roster — at least two people — has bid.
  // "missing" lists actual roster members without bids, and the tip
  // NAMES them (you tagged as you, Oxford comma at three); a roster
  // below two is a separate, dominating blocker (no amount of bidding
  // unlocks a solo auction), so the tip names THAT then instead.
  const missing = seats.filter(
    (s) => !state.bidders.some((b) => b.pid === s.pid));
  const roll = missing.map((s) =>
    s.uname + (s.pid === mine ? youTag : ''));
  const listed = roll.length <= 2 ? roll.join(' and ')
    : roll.slice(0, -1).join(', ') + ', and ' + roll[roll.length - 1];
  const ready = !state.revealed && seats.length >= 2
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
      : seats.length === 0 ? needTwoTip
      : seats.length === 1 ? needOneMoreTip
      : waitingTip(listed));
  }

  // the tab wears the auction's name and its state of play (the
  // ruled glyph quadruple), so a row of tauction tabs is legible —
  // and calls you back — without clicking through
  document.title = tabTitle(
    titleGlyph(seats, state.bidders, state.revealed, mine), aname);

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
  const byPid = umap();
  state.bidders.forEach((b) => { byPid[b.pid] = b; });
  // Placing a bid locks the who-you-are radio: no switching rows, no
  // releasing — permanently, since your bid never unlists (trying
  // this per dreev)
  const locked = mine !== '' && byPid[mine] !== undefined;
  const nextSeen = umap();

  // Keyed reconcile: every pid keeps its living row node for its whole
  // life, so a mid-gesture click (mousedown and mouseup need the same
  // node) or a focused editor can never be destroyed by a render. New
  // rows are built once (structure + listeners), then idempotently
  // synced; vanished rows are removed; survivors move only if the order
  // really changed (essentially never — insertion order is stable).
  const tiles = $('tiles');
  const keep = umap();
  let cursor = null;  // the previous row in the desired order
  seats.forEach((seat) => {
    const b = byPid[seat.pid];
    let t = rowNodes[seat.pid] || buildRow(seat.pid);
    keep[seat.pid] = t;
    updateRow(t, seat, b, mine, known, placed, locked);
    if (t.parentElement !== tiles || t.previousElementSibling !== cursor) {
      tiles.insertBefore(t, cursor ? cursor.nextElementSibling
                                   : tiles.firstElementChild);
    }
    cursor = t;
    nextSeen[seat.pid] = b === undefined ? undefined : b.tmod;
  });
  // sweep strays: vanished rows, other auctions' rows
  [...tiles.children].forEach((c) => {
    if (keep[c.dataset.pid] !== c) c.remove();
  });
  rowNodes = keep;
  seen = nextSeen;

  // On your first sight of an auction still waiting on your bid, the
  // caret lands in your editor: the blinking cursor IS the type-here
  // signal (no placeholder words, no pulse). One attempt per auction,
  // and only from an idle page — never stealing focus from a field
  // the user is in, and never re-grabbing it mid-session.
  if (!adopted) {
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

// One-time structure + listeners for a row. The PID is the key: it
// never changes for a living node — not even across renames — so
// these closures stay valid for the node's whole life. Everything
// mutable (the label included) is synced in updateRow.
function buildRow(pid) {
  const t = el('div', 'tile');
  t.dataset.pid = pid;
  // one solid glyph for every star: CSS draws it hollow (outline)
  // until .selected fills it gold — a real radio button
  // buttons act on click or tap; tab is for editable fields (dreev)
  const star = el('button', 'tu', '★');
  star.tabIndex = -1;
  star.type = 'button';
  star.addEventListener('click', () => toggleTu(pid));
  const nameEl = el('div', 'tile-name');
  nameEl.append(star, buildNameField(pid));
  const bidEl = el('div', 'tile-bid');
  // The empty bid box of a takeable row is where dreev's hallway
  // tester kept tapping ("clicking on this box doesn't work"), so it
  // works: while you are NOBODY, tapping it claims the seat and
  // readies the editor — same deal as the star, and the intent is
  // just as unambiguous. Disclosed ifs: only for the unclaimed
  // (misclicks must not switch a claimed identity), only on takeable
  // (star-enabled) rows, only while bidless (a slot, not a card).
  bidEl.addEventListener('click', () => {
    if (mypid() === '' && !t.querySelector('.tu').disabled
        && !t.classList.contains('has-bid')) {
      toggleTu(pid);
    }
  });
  // the tip is computed on entry, not at render: its "3m ago" ages must
  // be hover-fresh, and render stays idempotent (no clock in the DOM)
  // mouseover, not mouseenter: it must fire BEFORE the document-level
  // mouseover that shows the singleton tip (target phase precedes the
  // bubble), so the tip always reads a fresh attribute
  bidEl.addEventListener('mouseover', () => {
    bidEl.setAttribute('data-tip', bidTip(pid));
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
    // the × only lives on bidless rows (a bid protects its seat, and
    // the server refuses removing a bidder outright), so removal is
    // a plain optimistic delete
    seats = seats.filter((z) => z.pid !== pid);
    queueOp({ action: 'remove', aname: aname, pid: pid });
  });
  t.append(nameEl, bidEl, x);
  return t;
}

// The bid cell's content comes in three kinds; swapped wholesale when
// the kind changes, synced in place otherwise
function buildBidContent(kind, pid) {
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
               && v !== input.dataset.sent) placeBid(pid, form);
    });
    form.append(input);
    // the row-local busy sign: a mini gavel, shown by .rebid.busy —
    // its anatomy copied from the page's one true gavel (index.html),
    // never spelled twice
    const g = el('span', 'gavel mini');
    g.setAttribute('aria-hidden', 'true');
    g.innerHTML = $('status').querySelector(':scope > .gavel').innerHTML;
    form.append(g);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      placeBid(pid, form);
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
function updateRow(t, seat, b, mine, known, placed, locked) {
  const pid = seat.pid;
  const stamp = b === undefined ? undefined : b.tmod;
  const bcount = b === undefined ? 0 : b.bcount;
  // the label is data, not a key: it syncs like any other mutable
  // (dataset.uname rides along for humans reading the DOM and quals)
  t.dataset.uname = seat.uname;
  // Every row leads with its star, a radio for who-you-are: hollow =
  // claimable, dimmed hollow = dibsed, gold fill = you. A row is dibsed by
  // a rival device's registered claim, or (for claim-less legacy rows)
  // by a bid this browser didn't place. Clicking your own lit star
  // releases you to nobody. A bid placed by THIS browser never dibses
  // you out of the row (that keeps re-attach working if localStorage
  // forgot who you are). Once YOUR bid is in, the whole radio locks.
  const holder = state.claims[pid];
  const dibsed = pid !== mine
    && ((holder !== undefined && holder !== DEVICE)
        || (stamp !== undefined && placed[pid] === undefined));
  const star = t.querySelector('.tu');
  // revealed: identity is part of the frozen record, like the names
  star.disabled = dibsed || locked || state.revealed;
  star.classList.toggle('selected', pid === mine);
  // a rival's REGISTERED claim fills the star in (hollow = open,
  // filled = claimed by someone else, gold = you)...
  const rival = holder !== undefined && holder !== DEVICE;
  star.classList.toggle('taken', rival);
  // ...and its tip names the claimant's rig when they reported one
  // (dreev's ask — the one cause-flavored branch in the tip logic);
  // everything else stays a pure function of (pressable, whose)
  star.setAttribute('data-tip',
    pid === mine
      ? (star.disabled ? lockedTip : disclaimTip)
      : rival && state.blurbs[pid]
      ? claimedByTip(state.blurbs[pid])
      : (star.disabled ? tooLateTip : claimTip));

  t.classList.toggle('has-bid', stamp !== undefined);
  t.classList.toggle('mine', pid === mine);
  // names freeze at the gavel, like bids (dreev: a post-close rename
  // could swap around who bid what) — grayed, never suppressed
  const nameInput = t.querySelector('.rename input');
  nameInput.disabled = state.revealed;
  // the label under never-clobber: sync unless mid-edit (a rename is
  // a plain optimistic op now — no transactions, nothing to lock)
  if (nameInput !== document.activeElement
      && nameInput.value === nameInput.defaultValue) {
    nameInput.value = seat.uname;
    nameInput.defaultValue = seat.uname;
  }
  // one-shot shimmer; a reused node needs the remove-reflow-add dance
  // so back-to-back re-bids restart the animation
  const shimmer = seen[pid] !== undefined && seen[pid] !== stamp;
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
  const kind = pid === mine ? 'editor'
    : stamp !== undefined ? 'card' : 'slot';
  let content = bidEl.firstElementChild;  // null on a fresh row
  // (when the shelved ✅ returns, it rides after the content, so a
  // firstElementChild that IS the check means "no content yet":
  // if (content && content.classList.contains('check')) content = null;)
  if (!content || content.dataset.kind !== kind) {
    const fresh = buildBidContent(kind, pid);
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
    input.disabled = state.revealed;
    input.className = stamp === undefined ? 'bid-slot' : 'bid-card';
    input.style.boxShadow = stamp === undefined ? '' : stackShadow;
    // never clobber what the user is typing: leave a focused or dirty
    // input alone (a draft = live value differs from defaultValue)
    if (input !== document.activeElement
        && input.value === input.defaultValue) {
      const baseline = known[pid] === undefined ? '' : known[pid];
      input.value = baseline;
      input.defaultValue = baseline;
    }
  } else if (kind === 'card') {
    // a received bid is a card; each re-submission stacks a sheet
    // behind it (visual depth caps at 3; the counter stays exact)
    const sealed = known[pid] === undefined;
    content.className = 'bid-card';
    content.style.boxShadow = stackShadow;
    const text = content.firstElementChild;
    text.className = sealed ? 'bid-text masked' : 'bid-text';
    text.textContent = sealed ? MASK : known[pid];
  }
  // (subs superscript shelved 2026-07-15)
  // t.querySelector('.tile-subs').textContent = String(subs);
  // a bid protects its seat: the × grays the moment a bid is in
  // (and the server refuses the removal outright if a race slips
  // one past), and the whole record freezes at the gavel
  const frozen = stamp !== undefined || state.revealed;
  const x = t.querySelector('.x');
  x.disabled = frozen;
  x.setAttribute('data-tip',
    frozen ? tooLateRemoveTip(seat.uname) : removeTip(seat.uname));
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
function bidTip(pid) {
  const b = state.bidders.find((x) => x.pid === pid);
  if (b === undefined) return awaitingTip;
  if (b.bcount === 1) {
    return submittedTip(pid === mypid() ? yourBidWord : bidWord,
                        ago(b.tini));
  }
  return resubmittedTip(ago(b.tini), ago(b.tmod));
}

// The name is a live text field, like the + row's: click in and type.
// Enter or clicking away commits the rename; Escape restores it. The
// pid is the row's key, so a rename never re-keys a living node —
// updateRow syncs the label under never-clobber like any field.
function buildNameField(pid) {
  const form = el('form', 'rename');
  form.append('@');
  const input = el('input');
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
  // arrives clean and commits nothing.
  input.addEventListener('blur', () => {
    commitRename(pid, input.value, input);
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    commitRename(pid, input.value, input);
  });
  form.append(input);
  return form;
}

// Fix a typo'd name — anyone may, honor system, like all roster
// edits. A rename is a LABEL EDIT on a fixed identity (the pid), so
// it is just an optimistic op like any other: no transactions, no
// rollback snapshots, no re-keying of bids or memory. (That whole
// machinery — confirmed/desired/flight, the alice→beta→gamma hazard,
// the transport-loss sweep — died with the pid migration, 2026-07-19:
// the server can no longer be asked to rename a name it never
// granted, because it is asked about pids.) Renaming onto a live
// label is refused, locally and server-side, in the same words.
function commitRename(pid, raw, field) {
  const to = sanUname(raw);
  const seat = seats.find((s) => s.pid === pid);
  // nothing usable, or nothing changed: the field just snaps back
  // (also quiets the enter-then-blur double fire: by the blur, the
  // label already IS the committed value)
  if (seat === undefined || !to || to === seat.uname) {
    field.value = field.defaultValue;
    return;
  }
  if (seats.some((s) => s.uname === to && s.pid !== pid)) {
    banner(nameTakenBanner);
    field.classList.add('error');  // the problem is THIS field
    return;
  }
  seat.uname = to;  // the optimistic label; server truth re-adopts
  flashCommit(field);
  // a server-side refusal (a stale-roster race the local guard can't
  // see) reddens the field too; the recovery snapshot restores the
  // label itself
  queueOp({ action: 'rename', aname: aname, pid: pid, to: to },
          () => {
            const node = rowNodes[pid];
            if (node) {
              node.querySelector('.rename input').classList.add('error');
            }
          },
          () => { field.defaultValue = to; });
}

// Claim a row as yourself, or release it if it's already yours
function toggleTu(pid) {
  if (mypid() === pid) {
    storeMyPid('');
    queueOp({ action: 'release', aname: aname, pid: pid,
              deviceID: DEVICE }); // only the holder can vacate the seat
  } else {
    storeMyPid(pid);
    const seat = seats.find((s) => s.pid === pid);
    if (seat !== undefined) {  // remember the label as the name HINT
      localStorage.setItem('tauction-uname', seat.uname);
    }
    queueOp({ action: 'claim', aname: aname, pid: pid,
              deviceID: DEVICE,     // stake it: rival pages show dibs
              deviceBlurb: DEVBLURB }); // ...and who by, humanely
  }
  const input = $('tiles').querySelector('.rebid input');
  if (input) input.focus();
}



/* ------------------------------ actions ------------------------------- */

let bidsAloft = 0;  // submissions still flying; busy shows till zero

async function placeBid(pid, form) {
  const a = aname;  // pin the auction this bid belongs to; the user might
                    // switch auctions while the POST is in flight
  const input = form.querySelector('input');
  const bid = input.value.trim();
  assert(pid, 'placeBid without an identity');
  // your editor only exists while mypid() === pid, and mypid() can
  // only ever echo localStorage — so this holds or the model is broken
  assert(myPidStored() === pid,
    'editor identity out of sync with localStorage');
  // the seat's label rides along so a walk-on bid (re-bid after a
  // purge, mostly) can rebuild its seat server-side
  const seat = seats.find((s) => s.pid === pid);
  assert(seat !== undefined, 'placeBid without a seat');
  // a local slip gets a local objection: the field itself reddens
  // (cleared on the next keystroke); banners are for the server's news
  if (!bid) { input.classList.add('error'); return; }
  input.dataset.sent = bid;  // this exact text is on its way: the
                             // blur that follows an enter is a no-op
  flashCommit(input);  // the pulse marks the SUBMIT, not the settle
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
      res = await apiPost({ action: 'bid', aname: a, pid: pid,
                            uname: seat.uname, bid: bid,
                            deviceID: DEVICE,
                            deviceBlurb: DEVBLURB });
    } catch (e) {
      banner(e2153(e.message));
    }
    if (res && !res.error) {
      const mine = jmap('tauction-mybids:' + a);
      mine[pid] = bid;
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

// Bookkeeping for starting any write; returns the write's birth seq
// for settleWrite's last-write-standing test
function startWrite() {
  writesPending++;
  return ++writeSeq;
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
  settleSeq++;
  if (res && res.error) {
    // Disclosed if: losing a seat race (ERROR1304) is normal auction
    // physics, not an exceptional failure — the recovery snapshot
    // itself shows the truth (filled star + claimed-by tooltip), so
    // no red banner for that one. Everything else stays loud.
    if (!/^ERROR1304/.test(res.error)) banner(res.error);
    else console.warn('✗ ' + res.error);  // suppressed from the
                                          // banner, never the chronicle
    if (onRefusal) onRefusal();
    res = null;
  }
  // Disclosed if: a SUCCESSFUL settle retires stale bad news — the
  // question the banner answered is over (the durable signal, a red
  // field, stays). One of the three exits of a sticky banner.
  if (res) $('banner').hidden = true;
  if (writesPending > 0) return;
  if (res && res.aname === aname && at === writeSeq) {
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


function addName() {  // returns the added seat's pid ('' if refused)
  const uname = sanUname($('roster-input').value);
  if (!uname) {
    $('roster-input').classList.add('error');
    return '';
  }
  const live = seats.find((s) => s.uname === uname);
  if (live !== undefined) {
    // Typing an existing name is POINTING at that row (the hallway
    // test: "maybe i type in the name i want to make a bid for?" —
    // yes): a takeable seat is taken, with the editor readied.
    // Already you = nothing to do, quietly. A held/dibsed/locked
    // seat objects: red ring, text kept for fixing — never silently
    // swallowing what you typed.
    const trow = rowNodes[live.pid];
    if (live.pid === mypid()) {
      $('roster-input').value = '';
      return '';
    }
    if (trow && !trow.querySelector('.tu').disabled) {
      $('roster-input').value = '';
      toggleTu(live.pid);  // claims the seat and focuses the editor
      return live.pid;
    }
    $('roster-input').classList.add('error');
    return '';
  }
  $('roster-input').value = '';
  const pid = crypto.randomUUID();
  seats.push({ pid: pid, uname: uname });
  // Disclosed if: a FRESH add is yours when you are nobody here yet
  // and either this browser has no name hint at all (dreev's
  // expectata: "load a new auction, add a name = i've added myself")
  // or the typed name IS your remembered name (alice, nobody yet on
  // a fresh ledger, puts her own name down — that's her; dee and evy
  // are guests). This is the pid spec's option (b): auto-claim only
  // rows you just added yourself — a matching LABEL on a row someone
  // else created proves nothing and claims nothing. Locally only: no
  // server claim is registered, so a real person claiming this seat
  // from their own device unseats the assumption cleanly; your first
  // bid stakes it for real.
  const hint = localStorage.getItem('tauction-uname');
  // mypid(), not the raw ledger: a pid whose seat you ×ed away means
  // you are nobody here again, and re-adding your name re-latches
  if (mypid() === '' && (hint === null || hint === uname)) {
    if (hint === null) localStorage.setItem('tauction-uname', uname);
    storeMyPid(pid);
  }
  queueOp({ action: 'add', aname: aname, uname: uname, pid: pid });
  return pid;
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
      linkBanner(auctionExistsBanner('/' + a));
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
    seats = [];
    seen = umap();
    wasRevealed = false;
    adopted = false;  // the new auction gets its own arrival edge
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

  // Returning to a tab refreshes AT ONCE: the glance meets current
  // truth instead of up-to-POLL_MS-stale state — and it is the
  // moment a reveal that happened while hidden gets WITNESSED (the
  // peek never ingests, so the ceremony fires here, seen)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });

  // the sticky banner's ×: bad news leaves when YOU say so (or when
  // newer news or a successful settle replaces it) — never a timer
  $('banner-x').addEventListener('click', () => {
    $('banner').hidden = true;
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
    const want = sanAname($('aname').value);
    await switchAuction(want);
    // the pulse only if the name TOOK (a gate refusal keeps the
    // field pulseless beside its banner)
    if (aname === want) flashCommit($('aname'));
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
    // pulse iff a write queued (addName returns '' on every refusal
    // and no-op; the taken-seat path queues a claim, so it counts)
    if (added !== '') flashCommit($('roster-input'));
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
  // the chronicle's first line: which build (dreev hand-bumps the
  // footer version) — question zero of any console session
  console.log('tauction ' + document.querySelector('.version').textContent);

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
  // the hidden sibling: the minute-scale title peek (each cadence
  // self-gates on visibility, so each fires only in its own regime)
  setInterval(() => {
    if (document.visibilityState === 'hidden') peekTitle();
  }, PEEK_MS);
}

init();
