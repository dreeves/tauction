// Quals for the frontend: the real index.html + app.js running in jsdom,
// with fetch bridged to the real Code.gs logic on an in-memory fake
// spreadsheet. Covers the merged ledger (rows, cards, stacks, shimmer,
// cut, tada, the + row, per-row ×), the (tu) identity latch, in-place
// bidding, own-bid visibility, URL handling, and the 404.html
// direct-navigation journey.
//
// Run: node quals/frontend-quals.js   (needs `npm install` first, for jsdom)
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..');

// The real Code.gs logic on the shared in-memory fake spreadsheet
const gas = require('./fake-gas')();

/* ------------------------- the fetch bridge --------------------------- */

const API_URL = 'https://script.example/exec';
// pid-era payloads carry seats [{pid, uname}]; names() flattens the
// labels for roster-shaped asserts (mirrors gas-quals)
const names = (st) => st.seats.map((s) => s.uname).join(',');
// a seat's pid, looked up by its label (UI-minted pids are random)
const pidOf = (st, uname) =>
  (st.seats.find((s) => s.uname === uname) || {}).pid;
const bidderNamed = (st, uname) =>
  st.bidders.find((b) => b.pid === pidOf(st, uname));
const bidNamed = (st, uname) =>
  (st.bids || []).find((b) => b.pid === pidOf(st, uname));
let apiCalls = [];
let geoHits = 0;  // ipwho.is fixture servings (the cache quals count)
let geoFixture = { city: 'Portland', region_code: 'OR' };  // what it serves
let mockDelay = 0;  // artificial latency, for in-flight race quals

// Overlapping write ops pile onto the server's script lock; track
// whether the client ever has two in flight at once
const OPS = ['add', 'remove', 'claim', 'release'];
let opsInFlight = 0;
let opsOverlapped = false;
let writesInFlight = 0;  // ALL writes on the wire (drained() below)

const WRITES = [
  'add', 'remove', 'rename', 'claim', 'release', 'bid', 'describe', 'reveal',
];

// Simulate an outdated deployed server whose payloads predate the
// current shape (it was bidders[].created when this bit dreev)
let stripTini = false;

// Simulate a sheet whose stamp cells lost their plain-text armor: set
// to a string and every served stamp becomes it — bidder tini/tmod on
// sealed auctions, tfin on revealed ones (split so each assertState
// leg gets its own isolated red)
let stampSwap = null;

// Simulate transport death (the wifi blink, the wake race): every API
// fetch rejects the way Chrome does, before any response exists
let fetchDown = false;
// Simulate the ambiguous transport case: the server commits a write,
// but its response dies on the way back to the browser.
let dropWriteResponse = null;

function mockFetch(url, opts) {
  url = String(url);
  // the geo lookup gets a fixture: quals must never touch the network
  if (url.includes('ipwho.is')) {
    geoHits++;
    return Promise.resolve({ json: () => Promise.resolve(geoFixture) });
  }
  if (!url.startsWith(API_URL)) return Promise.reject(new Error('unexpected URL ' + url));
  if (fetchDown) return Promise.reject(new TypeError('Failed to fetch'));
  let req;
  if (opts && opts.method === 'POST') req = JSON.parse(opts.body);
  else req = Object.fromEntries(new URL(url).searchParams);
  apiCalls.push(req);
  if (OPS.includes(req.action)) {
    opsInFlight++;
    if (opsInFlight > 1) opsOverlapped = true;
  }
  if (WRITES.includes(req.action)) writesInFlight++;
  // Fidelity matters here: reads snapshot the moment they're requested
  // (a slow response still shows old state), but writes only commit
  // when they land — like the real locked server working its queue.
  const read = WRITES.includes(req.action) ? null : gas.handle(req);
  return new Promise((resolve, reject) => setTimeout(() => {
    if (OPS.includes(req.action)) opsInFlight--;
    if (WRITES.includes(req.action)) writesInFlight--;
    const res = read !== null ? read : gas.handle(req);
    if (dropWriteResponse === req.action) {
      dropWriteResponse = null;
      reject(new TypeError('Response lost after commit'));
      return;
    }
    if (stripTini && res.bidders) {
      res.bidders.forEach((b) => { delete b.tini; });
    }
    if (stampSwap !== null && res.bidders) {
      if (res.revealed) res.tfin = stampSwap;
      else res.bidders.forEach((b) => { b.tini = b.tmod = stampSwap; });
    }
    resolve({ json: () => Promise.resolve(JSON.parse(JSON.stringify(res))) });
  }, mockDelay));
}

/* ----------------------------- jsdom setup ---------------------------- */

const INDEX_HTML = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const APP_JS = fs.readFileSync(path.join(REPO, 'app.js'), 'utf8');
const STRINGLES = fs.readFileSync(path.join(REPO, 'stringles.js'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(REPO, 'style.css'), 'utf8');

// Microcopy DERIVED from stringles.js, so dreev's copy edits there
// never break the quals — the quals pin that the right string shows
// in the right state, not what the string says
const STR = new Function(STRINGLES
  + '; return { needTwoTip, needOneMoreTip, waitingTip, youTag,'
  + ' awaitingTip, auctionExistsBanner, stampCopy,'
  + ' consensusStamp,'
  + ' claimedByTip, claimTip, mysteryDevice, nameTakenBanner,'
  + ' bidTooLongBanner,'
  + ' moneyGlyphs, revealTip, needNameTip, removeTip,'
  + ' tooLateRemoveTip, resubmittedTip, nameStoneTip,'
  + ' waitingGlyph, yourMoveGlyph, readyGlyph, revealedGlyph,'
  + ' tabTitle, saveCopy, submitCopy, tooLateGoTip, startCopy,'
  + ' anameTooLongBanner, unameTooLongBanner, blurbTooLongBanner };')();
const STAMP = STR.stampCopy;

// ...and the server's half, out of the vm context hosting Code.gs
const SCOPY = require('vm')
  .runInContext('({ gavelFellCopy, simulEditsCopy, mysteryDeviceCopy,'
    + ' nameTakenCopy, removeBidderCopy, bidTooLongCopy,'
    + ' blurbTooLongCopy, anameTooLongCopy, unameTooLongCopy })', gas);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait (bounded) for a condition instead of sampling at a fixed delay:
// a loaded machine stretches the 5s poll past any fixed sleep's slack,
// which made fixed-sleep asserts flake ~1 run in 5. Timeout itself
// throws, so no forgotten follow-up assertion can pass vacuously.
async function until(fn, ms = 10000) {
  await sleep(0);  // flush the microtask queue first: a just-queued
                   // op has not hit the fetch bridge yet, and a
                   // synchronous first check would see a drained wire
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 >= ms) {
      throw new Error('until timed out after ' + ms + 'ms');
    }
    await sleep(25);
  }
}

async function makePage(pathAndQuery, seed) {
  const dom = new JSDOM(INDEX_HTML, {
    url: 'https://tauction.dreev.es' + pathAndQuery,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  dom.window.fetch = mockFetch;
  // jsdom has no matchMedia; the app (a browser program) rightly
  // assumes it — the harness fills its own gap
  dom.window.matchMedia = (q) => ({ matches: false, media: q });
  // canvas-confetti (a vendor script in the real page) can't run in
  // jsdom (no canvas): the harness records each burst's parameters
  // instead, and the ceremony quals assert the calpuz-modeled physics
  const bursts = [];
  dom.window.__confettiCalls = bursts;
  dom.window.confetti = Object.assign((opts) => { bursts.push(opts); },
    { shapeFromText: (o) => o });
  // Floating UI (a vendor script in the real page) positions the
  // singleton tooltip; jsdom has no layout, so a zero stub suffices —
  // the attribute and hidden-state are the assertable truths here
  dom.window.FloatingUIDOM = {
    computePosition: async () => ({ x: 0, y: 0 }),
    offset: () => ({}), flip: () => ({}), shift: () => ({}),
  };
  // Record every interval the app registers (callback + cadence), so
  // quals can fire the slow hidden-tab peek on demand instead of
  // waiting out its real minute-scale cadence
  const realSetInterval = dom.window.setInterval;
  dom.window.__intervals = [];
  dom.window.setInterval = (fn, ms) => {
    dom.window.__intervals.push({ fn: fn, ms: ms });
    return realSetInterval(fn, ms);
  };
  // Capture the app's console diagnostics per page — warnings
  // (transport weather) and the chronicle (log lines + table rows):
  // assertable where a qual cares, and never leaking into the suite's
  // own output when a zombie page's poll hits simulated weather
  dom.window.__warns = [];
  dom.window.console.warn = (m) => dom.window.__warns.push(String(m));
  dom.window.__logs = [];
  dom.window.console.log = (m) => dom.window.__logs.push(String(m));
  dom.window.console.table = (rows) => dom.window.__logs.push(rows);
  if (seed) seed(dom.window);  // e.g. pre-populate localStorage
  // one eval: eval-scoped consts aren't visible across separate
  // evals the way script tags share scope, so copy + code go together
  dom.window.eval(STRINGLES + '\n;\n' + APP_JS);
  await sleep(50); // let init()'s awaits settle
  return dom;
}

function type(dom, id, text) {
  const input = dom.window.document.getElementById(id);
  input.value = text;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

// Commit whatever is typed in the auction-name field (the enter
// path: names commit only on deliberate gestures, never a timer)
function commitName(dom) {
  dom.window.document.getElementById('aname').dispatchEvent(
    new dom.window.KeyboardEvent('keydown',
      { key: 'Enter', bubbles: true, cancelable: true }));
}

// Commit whatever is typed in the + row (the enter path)
function submitName(dom) {
  dom.window.document.getElementById('roster-input').dispatchEvent(
    new dom.window.KeyboardEvent('keydown',
      { key: 'Enter', bubbles: true, cancelable: true }));
}

// Add a person via the ledger's + row
function addName(dom, uname) {
  type(dom, 'roster-input', uname);
  dom.window.document.getElementById('roster-input').dispatchEvent(
    new dom.window.KeyboardEvent('keydown',
      { key: 'Enter', bubbles: true, cancelable: true }));
}

const row = (doc, uname) =>
  doc.querySelector('#status .tile[data-uname="' + uname + '"]');

// Click a row's (tu?)/(tu) button: claim it as yourself, or release it
function claimRow(dom, uname) {
  row(dom.window.document, uname).querySelector('.tu').click();
}

// Type into your row's in-place editor (jsdom does no implicit form
// submission, so submitBid dispatches the submit event itself)
function typeBid(dom, text) {
  dom.window.document.querySelector('#tiles .rebid textarea').value = text;
}

function submitBid(dom) {
  dom.window.document.querySelector('#tiles .rebid').dispatchEvent(
    new dom.window.Event('submit', { bubbles: true, cancelable: true }));
}

// A submitted bid has settled once the editor sheds its busy state
// (set synchronously at submit, cleared after the response) AND the
// box is no longer stale. The stale check matters when a claim op was
// queued just before the bid: the bid's own settle skips painting
// (writes still pending) and the paint arrives via the recovery
// refresh, after busy has already cleared.
const settled = (dom) => until(() => {
  const doc = dom.window.document;
  const f = doc.querySelector('#tiles .rebid');
  return f && !f.classList.contains('busy')
    && !doc.getElementById('status').classList.contains('stale')
    && drained(dom);
});

// Writes show no busy sign at all (dreev 2026-07-28, the no-spinners
// ruling), so the quals watch the wire instead of the DOM: the fetch
// bridge counts write requests in flight. (Zero here can precede the
// app's own settle only by a microtask flush, and until() polls on
// macrotasks, so a passing check always sees the settled world.)
const drained = () => writesInFlight === 0;

const myEditor = (doc) => doc.querySelector('#tiles .tile.mine .rebid textarea');

// Rename in place: every name IS a live text field; set it and submit
function renameTo(dom, uname, to) {
  const r = row(dom.window.document, uname);
  r.querySelector('.rename input').value = to;
  r.querySelector('.rename').dispatchEvent(
    new dom.window.Event('submit', { bubbles: true, cancelable: true }));
}

// Hover a row's bid cell and read the tooltip it computes on entry
// (lazily, so the "3m ago" ages are hover-fresh, not render-time relics)
function hoverBid(dom, uname) {
  const cell = row(dom.window.document, uname).querySelector('.tile-bid');
  // mouseover (matching the app's attr-refresh listener), non-bubbling:
  // the attribute is the assertable truth in jsdom
  cell.dispatchEvent(new dom.window.Event('mouseover'));
  return cell.getAttribute('data-tip');
}

// Flip a page's visibility (jsdom is permanently 'visible' on its
// own): shadow the prototype getter, then announce the change the way
// a real browser would
function setVisibility(dom, vis) {
  Object.defineProperty(dom.window.document, 'visibilityState',
    { value: vis, configurable: true });
  dom.window.document.dispatchEvent(
    new dom.window.Event('visibilitychange'));
}

const tiles = (doc, sel = '') => doc.querySelectorAll('#tiles .tile' + sel);

/* ------------------------------- quals -------------------------------- */

let passed = 0;
function ok(cond, label) {
  if (!cond) { console.error('FAIL: ' + label); process.exit(1); }
  passed++;
}

// The z-LADDER is a registry, not folklore (dreev: "still sounds
// whack-a-moley" — the tips-behind-banner bug was a latent ordering
// no one had declared). Every z-index in style.css must appear here,
// at exactly this height; a new overlay must join the ladder
// CONSCIOUSLY or the suite fails. Heights: summoned beats ambient.
const Z_LADDER = {
  '#tip': 10,                // a summoned tip outranks everything ours
  '.fete': 5,                // the SOLD stamp moment
  '#banner': 4,              // ambient news over content
  '.gavel': 2,               // the busy sign over the grayed ledger
  '.corner': 2,              // share/help float over the aname card
};                           // (the confetti canvas is fired at
                             // zIndex 5: above the page, below the
                             // summoned tips at 6)
const zFound = {};
for (const m of STYLE_CSS.matchAll(/z-index:\s*(\d+)/g)) {
  const start = STYLE_CSS.lastIndexOf('}', m.index) + 1;
  const sel = STYLE_CSS.slice(start, m.index)
    .replace(/\/\*[^]*?\*\//g, '').split('{')[0].trim()
    .replace(/\s+/g, ' ');
  zFound[sel] = parseInt(m[1], 10);
}

// The 0.6-RELIC detector (dreev's grayed bid: a forgotten
// `.rebid input:disabled { opacity: 0.6 }` later in the file
// silently beat the intended rule). Its mechanical signature: the
// same selector assigning the same property two different values.
// The rare INTENTIONAL cases live in this registry; anything else
// is a silent battle and fails loudly.
const CSS_OVERRIDE_REGISTRY = [
  // the + row zeroes the shared row-cell gap: its 1.9rem marker slot
  // absorbs it so the @s align down the column
  '.addrow .at-wrap|gap',
  // the spark's middle ray is longer than its ::before/::after mates
  '.gavel .bang > span|width',
];
const cssBattles = [];
{
  const flatCss = STYLE_CSS.replace(/\/\*[^]*?\*\//g, '')
    .replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')
    .replace(/@media[^{]*\{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g, '');
  const assign = {};  // 'selector|prop' -> value first seen
  for (const m of flatCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const rawSel of m[1].split(',')) {
      const sel = rawSel.trim().replace(/\s+/g, ' ');
      for (const d of m[2].split(';')) {
        if (!d.includes(':')) continue;
        const i = d.indexOf(':');
        const key = sel + '|' + d.slice(0, i).trim();
        const val = d.slice(i + 1).trim();
        if (key in assign && assign[key] !== val
            && !CSS_OVERRIDE_REGISTRY.includes(key)) {
          cssBattles.push(key + ': ' + assign[key] + ' VS ' + val);
        }
        assign[key] = val;
      }
    }
  }
}

(async () => {
  let timeoutFailed = false;
  try { await until(() => false, 10); }
  catch (e) { timeoutFailed = true; }
  ok(timeoutFailed,
     'until fails loudly on timeout instead of letting a stale'
     + ' scenario pass vacuously');

  ok(cssBattles.length === 0,
     'no unregistered same-selector CSS battles (the 0.6-relic'
     + ' class): ' + cssBattles.join('; '));
  ok(JSON.stringify(zFound) === JSON.stringify(Z_LADDER)
     || (Object.keys(zFound).length === Object.keys(Z_LADDER).length
         && Object.keys(zFound).every((k) => zFound[k] === Z_LADDER[k])),
     'every z-index in style.css sits declared on the ladder: '
       + JSON.stringify(zFound));
  /* --- installable: a real manifest, with the gavel as the icon ------- */
  const MANIFEST = JSON.parse(
      fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8'));
  ok(MANIFEST.name === 'tauction' && MANIFEST.start_url === '/'
     && MANIFEST.display === 'standalone'
     && MANIFEST.icons.length >= 1  // the 192/512/maskable trio died
     // with the handle-down art (dreev 2026-07-28, "just kill the
     // one where the handle points down"); gavelcoins.png stands
     // alone until maskable/size variants exist
     && MANIFEST.icons.every((i) =>
          fs.existsSync(path.join(REPO, i.src.replace(/^\//, '')))),
     'manifest.json: a standalone app whose every icon file exists'
     + " (dreev's Android install was manifest-less Chrome fallback)");
  ok(INDEX_HTML.includes('rel="manifest"'),
     'index.html links the manifest');
  /* --- link previews, the static tier (dreev chose (a): crawlers
     don't run JS, so per-auction blurbs/counts are unreachable from
     static Pages — same card for every link) --------------------- */
  const og = (p) => (INDEX_HTML.match(
    new RegExp('property="og:' + p + '" content="([^"]*)"')) || [])[1];
  ok(og('title') === 'tauction'
     && og('image') === 'https://tauction.dreev.es/icons/gavelcoins.png'
     && og('url') === 'https://tauction.dreev.es/',
     'open graph card: title, ABSOLUTE gavel image (crawlers resolve'
     + ' nothing), canonical url');
  ok(og('description') && og('description').length > 20
     && INDEX_HTML.replace(/\s+/g, ' ')
          .split(og('description').replace(/\s+/g, ' ')).length >= 3,
     "the preview description is dreev's own words from the help copy"
     + ' (both places, compared wrapping-insensitively: he rewraps'
     + ' prose at will)');
  ok(/name="twitter:card" content="summary"/.test(INDEX_HTML),
     'twitter falls back to the summary card');
  ok(/rel="icon" type="image\/png" href="\/icons\/favicon\.png"/
       .test(INDEX_HTML)
     && fs.existsSync(path.join(REPO, 'icons', 'favicon.png'))
     && fs.existsSync(path.join(REPO, 'icons', 'gavelbox-512.png')),
     "the favicon is dreev's boxed-gavel art (2026-07-18, retiring"
     + ' the inline-SVG gavel), favicon and full-size source both'
     + ' on disk');

  /* Replicata: ann and bob have both bid, then carol is added while
     that write is still optimistic. Expectata: carol immediately
     blocks reveal and the tip names her. Resultata pre-fix: reveal
     stayed ready because its computation read the old server roster. */
  gas.handle({ action: 'add', aname: 'localready',
    uname: 'ann', pid: 'pid-localready-ann' });
  gas.handle({ action: 'add', aname: 'localready',
    uname: 'bob', pid: 'pid-localready-bob' });
  gas.handle({ action: 'bid', aname: 'localready',
    uname: 'ann', pid: 'pid-localready-ann',
    bid: 'ann bid', deviceID: 'ann-device', deviceBlurb: 'Ann rig' });
  gas.handle({ action: 'bid', aname: 'localready',
    uname: 'bob', pid: 'pid-localready-bob',
    bid: 'bob bid', deviceID: 'bob-device', deviceBlurb: 'Bob rig' });
  const dLocalReady = await makePage('/localready?api=' + API_URL);
  const localSeal = dLocalReady.window.document.getElementById('seal');
  ok(!localSeal.disabled && localSeal.classList.contains('ready'),
     'the two complete server seats begin reveal-ready');
  mockDelay = 300;
  addName(dLocalReady, 'carol');
  ok(localSeal.disabled && !localSeal.classList.contains('ready')
     && localSeal.getAttribute('data-tip')
          === STR.waitingTip('carol' + STR.youTag),
     'an optimistic local seat immediately blocks reveal and its tip'
     + ' names the locally missing bidder');
  await settled(dLocalReady);
  mockDelay = 0;

  /* Replicata (Sol's audit #7): submit "  same bid  ". The server
     stores the trimmed words. Expectata: the editor settles CLEAN —
     normalized to what was actually sent — so no phantom dirtiness,
     no armed SUBMIT whose press does nothing, no immortal draft.
     Resultata pre-fix: the padded value stayed visibly dirty
     forever. */
  gas.handle({ action: 'add', aname: 'padbid',
    uname: 'ann', pid: 'pid-padbid-ann' });
  const dPad = await makePage('/padbid?api=' + API_URL, (w) => {
    w.localStorage.setItem('tauction-pids', '{"padbid":"pid-padbid-ann"}');
  });
  typeBid(dPad, '  same bid  ');
  myEditor(dPad.window.document).dispatchEvent(
    new dPad.window.Event('input', { bubbles: true }));
  submitBid(dPad);
  await settled(dPad);
  ok(myEditor(dPad.window.document).value === 'same bid'
     && !myEditor(dPad.window.document).closest('.rebid')
          .classList.contains('hot')
     && !('bid' in JSON.parse(dPad.window.localStorage
          .getItem('tauction-drafts:padbid') || '{}')),
     'a padded bid settles clean: the editor normalizes to the words'
     + ' actually sent, SUBMIT retires, the draft store empties');

  /* Replicata (dreev 2026-07-28, README #2: "an unsubmitted bid
     gets completely lost if you claim another participant as you"):
     claim alice, type an unsubmitted bid, then claim bob — the usual
     reason being "typed into the wrong row". Expectata: the words
     FOLLOW YOU — the draft is the browser's, not the seat's — into
     bob's editor; Escape discards them there; and a SUBMIT carried
     this way commits as BOB. Resultata pre-fix: the draft sat parked
     invisibly under alice's pid. */
  gas.handle({ action: 'add', aname: 'follow',
    uname: 'alice', pid: 'pid-follow-alice' });
  gas.handle({ action: 'add', aname: 'follow',
    uname: 'bob', pid: 'pid-follow-bob' });
  const dFollow = await makePage('/follow?api=' + API_URL);
  claimRow(dFollow, 'alice');
  await until(() => myEditor(dFollow.window.document) !== null
    && drained());
  const followEd1 = myEditor(dFollow.window.document);
  followEd1.value = 'wrong row words';
  followEd1.dispatchEvent(new dFollow.window.Event('input',
    { bubbles: true }));
  claimRow(dFollow, 'bob');
  await until(() => row(dFollow.window.document, 'bob')
    .classList.contains('mine') && drained());
  ok(myEditor(dFollow.window.document).value === 'wrong row words'
     && JSON.parse(dFollow.window.localStorage
          .getItem('tauction-drafts:follow')).bid === 'wrong row words',
     "the unsubmitted words follow you to bob's editor: the draft is"
     + ' yours, not the seat\'s');
  submitBid(dFollow);
  await settled(dFollow);
  ok(gas.handle({ action: 'state', aname: 'follow' }).bidders
       .some((b) => b.pid === 'pid-follow-bob')
     && !gas.handle({ action: 'state', aname: 'follow' }).bidders
       .some((b) => b.pid === 'pid-follow-alice')
     && !('bid' in JSON.parse(dFollow.window.localStorage
          .getItem('tauction-drafts:follow') || '{}')),
     'SUBMIT commits the carried words as BOB, alice untouched, the'
     + ' draft slot pruned');

  /* Replicata (Sol's audit #4): type a bid draft, release your
     seat (editor gone), then claim it back. Expectata: the reborn
     editor holds the waiting draft. Resultata pre-fix: the restore
     ran only at the arrival edge, so the late-born editor came up
     empty — and the clean-sweep then DELETED the stored draft. */
  gas.handle({ action: 'add', aname: 'latedraft',
    uname: 'ann', pid: 'pid-latedraft-ann' });
  gas.handle({ action: 'add', aname: 'latedraft',
    uname: 'bo', pid: 'pid-latedraft-bo' });
  const dLate = await makePage('/latedraft?api=' + API_URL, (w) => {
    w.localStorage.setItem('tauction-pids',
      '{"latedraft":"pid-latedraft-ann"}');
  });
  const lateDoc = dLate.window.document;
  const lateEd = myEditor(lateDoc);
  lateEd.value = 'half a thought';
  lateEd.dispatchEvent(new dLate.window.Event('input', { bubbles: true }));
  claimRow(dLate, 'ann');   // the star toggle: release the seat
  await until(() => !myEditor(lateDoc));
  claimRow(dLate, 'ann');   // ...and claim it back
  await until(() => myEditor(lateDoc) !== null);
  await sleep(80);
  ok(myEditor(lateDoc).value === 'half a thought'
     && JSON.parse(dLate.window.localStorage
          .getItem('tauction-drafts:latedraft'))['bid']
          === 'half a thought',
     'the reborn editor holds the waiting draft, and the store still'
     + ' holds it too: a draft outlives the editor, not vice versa');
  const lateLong = 'x'.repeat(161);
  myEditor(lateDoc).value = lateLong;
  myEditor(lateDoc).dispatchEvent(
    new dLate.window.Event('input', { bubbles: true }));
  claimRow(dLate, 'ann');
  await until(() => !myEditor(lateDoc));
  claimRow(dLate, 'ann');
  await until(() => myEditor(lateDoc) !== null);
  ok(myEditor(lateDoc).value === lateLong
     && myEditor(lateDoc).classList.contains('error'),
     'a reborn editor revalidates its restored draft: an overlong'
     + ' draft returns with its live red objection');

  /* Replicata (Sol's audit #3): the wifi dies exactly as SAVE (or a
     rename, or an add) flies. Expectata: the banner tells the
     weather AND the words come back — a failed write must never
     eat typed work. Resultata pre-fix: the error survived, the
     words did not (the recovery only ran for server refusals). */
  gas.handle({ action: 'describe', aname: 'wifieat', base: '',
    blurb: 'the record' });
  gas.handle({ action: 'add', aname: 'wifieat',
    uname: 'ann', pid: 'pid-wifieat-ann' });
  const dEat = await makePage('/wifieat?api=' + API_URL);
  const eatDoc = dEat.window.document;
  eatDoc.getElementById('desctoggle').click();
  const eatEd = eatDoc.getElementById('descedit');
  eatEd.value = 'the record, amended';
  eatEd.dispatchEvent(new dEat.window.Event('input', { bubbles: true }));
  fetchDown = true;
  eatDoc.getElementById('descgo').click();
  await until(() => !eatDoc.getElementById('banner').hidden);
  await sleep(80);
  ok(eatEd.value === 'the record, amended'
     && eatEd.classList.contains('error')
     && !eatDoc.getElementById('desc').classList.contains('viewing'),
     'a transport-dead SAVE hands the words back: draft red in the'
     + ' reopened editor, nothing eaten');
  const eatName = row(eatDoc, 'ann').querySelector('.rename input');
  eatName.focus();
  eatName.value = 'annette';
  eatName.dispatchEvent(new dEat.window.Event('input', { bubbles: true }));
  eatName.blur();  // the blur-commit, into the dead wifi
  await sleep(120);
  ok(eatName.value === 'annette' && eatName.classList.contains('error'),
     'a transport-dead rename keeps the typed name in the field, red');
  type(dEat, 'roster-input', 'mo');
  submitName(dEat);
  await sleep(120);
  ok(eatDoc.getElementById('roster-input').value === 'mo',
     'a transport-dead add returns the typed name to the + row');
  fetchDown = false;

  /* A rejected fetch does not prove the write was rejected: the
     server may have committed and only its response died. Recovery
     must compare the next state with the submitted goal, settling it
     clean when it landed and keeping it dirty only when it did not. */
  gas.handle({ action: 'describe', aname: 'maybeate', base: '',
    blurb: 'the record' });
  gas.handle({ action: 'add', aname: 'maybeate',
    uname: 'ann', pid: 'pid-maybeate-ann' });
  const dMaybe = await makePage('/maybeate?api=' + API_URL);
  const maybeDoc = dMaybe.window.document;
  maybeDoc.getElementById('desctoggle').click();
  const maybeDesc = maybeDoc.getElementById('descedit');
  maybeDesc.value = 'the committed amendment';
  maybeDesc.dispatchEvent(new dMaybe.window.Event('input',
    { bubbles: true }));
  dropWriteResponse = 'describe';
  maybeDoc.getElementById('descgo').click();
  await until(() => gas.handle({ action: 'state', aname: 'maybeate' })
    .blurb === 'the committed amendment');
  await sleep(100);
  const maybeState = gas.handle({ action: 'state', aname: 'maybeate' });
  ok(maybeDesc.value === 'the committed amendment'
     && maybeDesc.defaultValue === 'the committed amendment'
     && maybeDesc.dataset.base === maybeState.tblurb
     && !maybeDesc.classList.contains('error')
     && !maybeDoc.getElementById('desc').classList.contains('hot'),
     'a SAVE whose response alone was lost reconciles as committed:'
     + ' clean words and the accepted CAS token');

  const maybeName = row(maybeDoc, 'ann').querySelector('.rename input');
  maybeName.focus();
  maybeName.value = 'annette';
  maybeName.dispatchEvent(new dMaybe.window.Event('input',
    { bubbles: true }));
  dropWriteResponse = 'rename';
  maybeName.form.requestSubmit();
  await until(() => pidOf(gas.handle({ action: 'state',
    aname: 'maybeate' }), 'annette') === 'pid-maybeate-ann');
  await sleep(100);
  ok(maybeName.value === 'annette'
     && maybeName.defaultValue === 'annette'
     && !maybeName.classList.contains('error')
     && !maybeName.closest('.rename').classList.contains('hot'),
     'a rename whose response alone was lost reconciles as committed');

  gas.handle({ action: 'add', aname: 'maybeate',
    uname: 'bob', pid: 'pid-maybeate-bob-remote' });
  type(dMaybe, 'roster-input', 'bob');
  dropWriteResponse = 'add';
  submitName(dMaybe);
  await until(() => pidOf(gas.handle({ action: 'state',
    aname: 'maybeate' }), 'bob') === 'pid-maybeate-bob-remote');
  await sleep(100);
  const maybeAdd = maybeDoc.getElementById('roster-input');
  ok(maybeAdd.value === ''
     && !maybeAdd.closest('.fieldcol').classList.contains('hot')
     && !('addrow' in JSON.parse(dMaybe.window.localStorage
          .getItem('tauction-drafts:maybeate') || '{}')),
     'an add whose response alone was lost reconciles as committed'
     + ' instead of returning a false retry draft');

  /* Replicata (Sol's audit #2): rename bob to a name the local
     roster can't see is taken (the stale-roster race), then — while
     that refusal is still in flight — rename him again to gamma.
     Expectata: the OLD refusal never repaints the field; gamma wins
     and the field agrees with the server. Resultata pre-fix: the
     late refusal restored 'carl' over the committed 'gamma' — DOM
     said gamma, eyes saw carl. */
  gas.handle({ action: 'add', aname: 'staleref',
    uname: 'ann', pid: 'pid-staleref-ann' });
  gas.handle({ action: 'add', aname: 'staleref',
    uname: 'bob', pid: 'pid-staleref-bob' });
  const dRef = await makePage('/staleref?api=' + API_URL);
  gas.handle({ action: 'add', aname: 'staleref',
    uname: 'carl', pid: 'pid-staleref-carl' });  // remote; no poll yet
  mockDelay = 300;
  renameTo(dRef, 'bob', 'carl');   // local guard blind; server refuses
  renameTo(dRef, 'carl', 'gamma'); // the newer intent, queued behind
  await until(() => pidOf(gas.handle({ action: 'state',
    aname: 'staleref' }), 'gamma') === 'pid-staleref-bob');
  mockDelay = 0;
  const refInp = row(dRef.window.document, 'gamma')
    && row(dRef.window.document, 'gamma').querySelector('.rename input');
  ok(refInp && refInp.value === 'gamma'
     && refInp.defaultValue === 'gamma',
     "a stale refusal never repaints a newer name: the field says"
     + ' gamma, the server says gamma, nobody says carl');

  gas.handle({ action: 'add', aname: 'staletype',
    uname: 'ann', pid: 'pid-staletype-ann' });
  gas.handle({ action: 'add', aname: 'staletype',
    uname: 'bob', pid: 'pid-staletype-bob' });
  const dType = await makePage('/staletype?api=' + API_URL);
  gas.handle({ action: 'add', aname: 'staletype',
    uname: 'carl', pid: 'pid-staletype-carl' });
  const typeInp = row(dType.window.document, 'bob')
    .querySelector('.rename input');
  typeInp.focus();
  typeInp.value = 'carl';
  typeInp.dispatchEvent(new dType.window.Event('input',
    { bubbles: true }));
  mockDelay = 300;
  typeInp.form.requestSubmit();
  typeInp.value = 'gamma';
  typeInp.dispatchEvent(new dType.window.Event('input',
    { bubbles: true }));
  await until(() => !dType.window.document
    .getElementById('banner').hidden);
  await sleep(350);
  mockDelay = 0;
  ok(typeInp.value === 'gamma'
     && typeInp.defaultValue === 'bob'
     && typeInp.closest('.rename').classList.contains('hot')
     && !typeInp.classList.contains('error')
     && pidOf(gas.handle({ action: 'state', aname: 'staletype' }), 'bob')
          === 'pid-staletype-bob',
     'a refused rename preserves newer typing but rebases it on the'
     + ' accepted server name, so Escape still tells the truth');

  /* Replicata (Sol's audit #1, the worst of the eight): focus bob's
     name, type NOTHING; another browser renames him robert; click
     away. Expectata: no edit, no commit — the row converges to
     robert. Resultata pre-fix: the blur posted the STALE text and
     undid the remote rename. */
  gas.handle({ action: 'add', aname: 'stalefocus',
    uname: 'ann', pid: 'pid-stalefocus-ann' });
  gas.handle({ action: 'add', aname: 'stalefocus',
    uname: 'bob', pid: 'pid-stalefocus-bob' });
  const dStale = await makePage('/stalefocus?api=' + API_URL);
  const staleDoc = dStale.window.document;
  const staleInp = row(staleDoc, 'bob').querySelector('.rename input');
  staleInp.focus();  // parked caret, no edit
  gas.handle({ action: 'rename', aname: 'stalefocus',
    pid: 'pid-stalefocus-bob', to: 'robert' });
  await until(() => row(staleDoc, 'robert') !== null);
  ok(staleInp.value === 'bob' && staleInp.defaultValue === 'bob',
     'the remote label is adopted while the focused field keeps its'
     + ' untouched visible words until the user leaves');
  staleInp.blur();
  await sleep(150);
  ok(apiCalls.every((c) => c.action !== 'rename'
       || c.aname !== 'stalefocus')
     && names(gas.handle({ action: 'state', aname: 'stalefocus' }))
          === 'ann,robert',
     'leaving an untouched name commits NOTHING: a parked caret'
     + " can't undo somebody else's rename");
  await until(() => row(staleDoc, 'robert') !== null);
  ok(row(staleDoc, 'robert') !== null
     && staleInp.value === 'robert'
     && staleInp.defaultValue === 'robert',
     '...and leaving the field reconciles its visible words and'
     + ' baseline to the remote truth');
  const staleEnter = row(staleDoc, 'robert')
    .querySelector('.rename input');
  staleEnter.focus();
  gas.handle({ action: 'rename', aname: 'stalefocus',
    pid: 'pid-stalefocus-bob', to: 'roberta' });
  await until(() => row(staleDoc, 'roberta') !== null);
  const staleRenamePosts = apiCalls.filter((c) => c.action === 'rename'
    && c.aname === 'stalefocus').length;
  staleEnter.form.requestSubmit();
  await sleep(150);
  ok(apiCalls.filter((c) => c.action === 'rename'
       && c.aname === 'stalefocus').length === staleRenamePosts
     && names(gas.handle({ action: 'state', aname: 'stalefocus' }))
          === 'ann,roberta'
     && staleEnter.value === 'roberta'
     && staleEnter.defaultValue === 'roberta',
     'pressing Enter on an untouched stale name also commits NOTHING:'
     + " it can't undo somebody else's rename, and it reconciles to"
     + ' that truth');
  /* Replicata (Sol's audit #6): the gavel falls while a rename draft
     is mid-edit; the freeze disables the field, which blurs it.
     Expectata: a disabled field's blur commits nothing — the dying
     draft just stays, the bid editor's own frozen-draft law. */
  const staleAnn = row(staleDoc, 'ann').querySelector('.rename input');
  staleAnn.focus();
  staleAnn.value = 'annette';
  staleAnn.dispatchEvent(new dStale.window.Event('input',
    { bubbles: true }));
  staleAnn.disabled = true;  // what updateRow does at the reveal
  staleAnn.blur();           // ...and the blur the disable fires
  await sleep(150);
  ok(apiCalls.every((c) => c.action !== 'rename'
       || c.aname !== 'stalefocus'),
     "a frozen field's blur posts nothing: the dying draft stays,"
     + ' unsent, like a bid caught by the gavel');
  staleAnn.disabled = false;  // (jsdom fixture cleanup)

  /* Replicata: erase a persisted participant name and leave its field.
     Expectata (2026-07-28, save-on-blur unames): a name can't be
     nothing — the blur-commit's empty path snaps the committed name
     straight back, and nothing goes to the wire. */
  gas.handle({ action: 'add', aname: 'emptyrename',
    uname: 'ann', pid: 'pid-emptyrename-ann' });
  gas.handle({ action: 'add', aname: 'emptyrename',
    uname: 'bob', pid: 'pid-emptyrename-bob' });
  const dEmptyRename = await makePage('/emptyrename?api=' + API_URL);
  const emptyName = row(dEmptyRename.window.document, 'bob')
    .querySelector('.rename input');
  emptyName.focus();
  emptyName.value = '';
  emptyName.dispatchEvent(
    new dEmptyRename.window.Event('input', { bubbles: true }));
  emptyName.blur();
  await sleep(80);
  ok(emptyName.value === 'bob' && emptyName.defaultValue === 'bob'
     && !emptyName.closest('.rename').classList.contains('hot')
     && apiCalls.every((r) => r.action !== 'rename'
          || r.aname !== 'emptyrename'),
     'leaving an emptied name snaps the committed name back — a name'
     + " can't be nothing, and nothing went to the wire");

  /* Replicata: erase a standing bid and leave the editor. Expectata
     (2026-07-27): the empty draft stays, hot, and nothing is sent —
     no phantom withdrawal, bcount untouched; Escape restores. */
  gas.handle({ action: 'add', aname: 'emptybid',
    uname: 'ann', pid: 'pid-emptybid-ann' });
  gas.handle({ action: 'add', aname: 'emptybid',
    uname: 'bob', pid: 'pid-emptybid-bob' });
  gas.handle({ action: 'bid', aname: 'emptybid',
    uname: 'ann', pid: 'pid-emptybid-ann',
    bid: 'standing bid', deviceID: 'empty-device',
    deviceBlurb: 'Empty rig' });
  const dEmptyBid = await makePage('/emptybid?api=' + API_URL, (w) => {
    w.localStorage.setItem('tauction-device', 'empty-device');
    w.localStorage.setItem('tauction-pids',
      '{"emptybid":"pid-emptybid-ann"}');
    w.localStorage.setItem('tauction-mybids:emptybid',
      '{"pid-emptybid-ann":"standing bid"}');
  });
  const standingBid = row(dEmptyBid.window.document, 'ann')
    .querySelector('.rebid textarea');
  standingBid.focus();
  standingBid.value = '';
  standingBid.dispatchEvent(
    new dEmptyBid.window.Event('input', { bubbles: true }));
  standingBid.blur();
  await sleep(80);
  ok(standingBid.value === ''
     && standingBid.defaultValue === 'standing bid'
     && standingBid.closest('.rebid').classList.contains('hot')
     && gas.handle({ action: 'state', aname: 'emptybid' })
          .bidders.find((b) => b.pid === 'pid-emptybid-ann').bcount === 1,
     'leaving an emptied standing bid sends no withdrawal: the empty'
     + ' draft waits, hot');
  standingBid.focus();
  standingBid.dispatchEvent(new dEmptyBid.window.KeyboardEvent(
    'keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  ok(standingBid.value === 'standing bid'
     && !standingBid.closest('.rebid').classList.contains('hot'),
     'Escape restores the standing bid and the field cools');
  gas.handle({ action: 'add', aname: 'blankbid',
    uname: 'ann', pid: 'pid-blankbid-ann' });
  gas.handle({ action: 'add', aname: 'blankbid',
    uname: 'bob', pid: 'pid-blankbid-bob' });
  const dBlankBid = await makePage('/blankbid?api=' + API_URL, (w) => {
    w.localStorage.setItem('tauction-pids',
      '{"blankbid":"pid-blankbid-ann"}');
  });
  const blankBid = row(dBlankBid.window.document, 'ann')
    .querySelector('.rebid textarea');
  blankBid.focus();
  blankBid.value = '   ';
  blankBid.dispatchEvent(
    new dBlankBid.window.Event('input', { bubbles: true }));
  blankBid.blur();
  await sleep(80);
  ok(blankBid.value === '   ' && blankBid.defaultValue === ''
     && !blankBid.classList.contains('error')
     && bidderNamed(gas.handle(
          { action: 'state', aname: 'blankbid' }), 'ann') === undefined,
     'a blank never-saved draft is likewise nobody\'s business: it'
     + ' waits, and no write ever went');

  /* Replicata: save B, then save C before B's response arrives.
     Expectata: this client's serialized saves both land in order.
     Resultata pre-fix: C carried A's compare-and-swap stamp and
     falsely collided with this same client's successful B. */
  gas.handle({ action: 'describe', aname: 'rapiddesc', base: '',
    blurb: 'A version' });
  gas.handle({ action: 'add', aname: 'rapiddesc',
    uname: 'ann', pid: 'pid-rapiddesc-ann' });
  const dRapidDesc = await makePage('/rapiddesc?api=' + API_URL);
  const rapidDoc = dRapidDesc.window.document;
  mockDelay = 300;
  rapidDoc.getElementById('desctoggle').click();
  rapidDoc.getElementById('descedit').value = 'B version';
  rapidDoc.getElementById('descedit').dispatchEvent(
    new dRapidDesc.window.Event('input', { bubbles: true }));
  rapidDoc.getElementById('descgo').click();
  rapidDoc.getElementById('desctoggle').click();
  rapidDoc.getElementById('descedit').value = 'C version';
  rapidDoc.getElementById('descedit').dispatchEvent(
    new dRapidDesc.window.Event('input', { bubbles: true }));
  rapidDoc.getElementById('descgo').click();
  await until(() => gas.handle({ action: 'state', aname: 'rapiddesc' })
    .blurb === 'C version'
    || !rapidDoc.getElementById('banner').hidden);
  await until(() => !rapidDoc.getElementById('status').classList
    .contains('stale'));
  mockDelay = 0;
  ok(gas.handle({ action: 'state', aname: 'rapiddesc' }).blurb
       === 'C version'
     && rapidDoc.getElementById('descedit').value === 'C version'
     && !rapidDoc.getElementById('descedit').classList.contains('error')
     && rapidDoc.getElementById('banner').hidden,
     'rapid same-client descriptions serialize without a false'
     + ' compare-and-swap conflict; the last draft wins');

  /* Replicata: draft B waits behind another local write; another page
     saves A2, and this page has already begun newer draft C when B is
     refused. Expectata: B's old refusal never restores over C — and
     under the mid-air-collision convention (2026-07-28) C's own save
     bounces too, in the server's words, rather than silently winning
     an edit war C's author never saw. */
  gas.handle({ action: 'describe', aname: 'newerdesc', base: '',
    blurb: 'A version' });
  gas.handle({ action: 'add', aname: 'newerdesc',
    uname: 'ann', pid: 'pid-newerdesc-ann' });
  const dNewerDesc = await makePage('/newerdesc?api=' + API_URL);
  const newerDoc = dNewerDesc.window.document;
  mockDelay = 400;
  addName(dNewerDesc, 'bob');
  newerDoc.getElementById('desctoggle').click();
  newerDoc.getElementById('descedit').value = 'B version';
  newerDoc.getElementById('descedit').dispatchEvent(
    new dNewerDesc.window.Event('input', { bubbles: true }));
  newerDoc.getElementById('descgo').click();
  newerDoc.getElementById('desctoggle').click();
  newerDoc.getElementById('descedit').value = 'C version';
  newerDoc.getElementById('descedit').dispatchEvent(
    new dNewerDesc.window.Event('input', { bubbles: true }));
  newerDoc.getElementById('descedit').focus();
  const beforeA2 = gas.handle({ action: 'state', aname: 'newerdesc' });
  gas.handle({ action: 'describe', aname: 'newerdesc',
    base: beforeA2.tblurb, blurb: 'A2 version' });
  await until(() => !newerDoc.getElementById('banner').hidden);
  mockDelay = 0;
  ok(newerDoc.getElementById('descedit').value === 'C version'
     && gas.handle({ action: 'state', aname: 'newerdesc' }).blurb
          === 'A2 version',
     'an older refused description never overwrites a newer local draft');
  newerDoc.getElementById('banner-x').click();
  newerDoc.getElementById('descgo').click();
  await until(() => !newerDoc.getElementById('banner').hidden);
  ok(newerDoc.getElementById('banner-msg').textContent
       === SCOPY.simulEditsCopy
     && gas.handle({ action: 'state', aname: 'newerdesc' }).blurb
          === 'A2 version'
     && newerDoc.getElementById('descedit').value === 'C version',
     "saving C bounces too — same collision, same server words: no"
     + ' save ever silently wins an edit war its author never saw');

  /* Replicata: a fresh URL is opened and the visitor types in the
     blurb box before the first snapshot lands (dreev, 2026-07-27, on
     Chrome at a brand-new /test2103). Expectata: no one else exists,
     so no banner — the arrival slides under the draft silently.
     Resultata pre-fix: "Oops, someone else is making simultaneous
     edits to the description" — the virgin editor's missing base
     stamp read as foreign against the never-described blurb's ''. */
  mockDelay = 300;
  const dVirgin = await makePage('/virgindesc?api=' + API_URL);
  const virginDoc = dVirgin.window.document;
  const virginEdit = virginDoc.getElementById('descedit');
  ok(virginDoc.getElementById('status').classList.contains('stale'),
     'the first snapshot is still in flight when typing begins');
  virginEdit.focus();
  type(dVirgin, 'descedit', 'my words');
  mockDelay = 0;
  await until(() => !virginDoc.getElementById('status').classList
    .contains('stale'));
  ok(!virginDoc.getElementById('status').classList.contains('stale'),
     'the first snapshot has arrived under the draft');
  ok(virginDoc.getElementById('banner').hidden
     && virginEdit.value === 'my words'
     && !virginEdit.classList.contains('error'),
     'typing in the blurb before the first snapshot is not a'
     + ' simultaneous edit: no banner, the draft undisturbed');
  virginDoc.getElementById('descgo').click();
  await until(() => gas.handle({ action: 'state', aname: 'virgindesc' })
    .blurb === 'my words');
  ok(gas.handle({ action: 'state', aname: 'virgindesc' })
       .blurb === 'my words'
     && virginDoc.getElementById('banner').hidden,
     'and the pre-arrival draft saves cleanly');

  /* Replicata: same eager typing, but the visitor SAVEs too before
     the first snapshot lands. Expectata: the save carries the virgin
     base, passes the server's compare-and-swap, and settles without
     drama. (Fences the fix's other face: the base a commit puts on
     the wire must be the same virgin '' the render compares.) */
  mockDelay = 300;
  const dEager = await makePage('/eagerdesc?api=' + API_URL);
  const eagerDoc = dEager.window.document;
  eagerDoc.getElementById('descedit').focus();
  type(dEager, 'descedit', 'first words');
  eagerDoc.getElementById('descgo').click();
  mockDelay = 0;
  await until(() => gas.handle({ action: 'state', aname: 'eagerdesc' })
    .blurb === 'first words');
  await until(() => !eagerDoc.getElementById('status').classList
    .contains('stale'));
  ok(gas.handle({ action: 'state', aname: 'eagerdesc' })
       .blurb === 'first words'
     && eagerDoc.getElementById('banner').hidden
     && !eagerDoc.getElementById('descedit').classList.contains('error'),
     'typing AND saving before the first snapshot lands cleanly');

  /* Replicata: the eager typist again, but at a URL where someone
     already left a description this browser has never seen (no cached
     snapshot). Expectata (mid-air-collision convention, 2026-07-28):
     the arrival says nothing — his words and the rendered pane both
     stand — and HIS save is refused in the server's words, because
     his draft was based on nothing. */
  gas.handle({ action: 'describe', aname: 'preexdesc', base: '',
    blurb: 'House rules.' });
  mockDelay = 300;
  const dPreex = await makePage('/preexdesc?api=' + API_URL);
  const preexDoc = dPreex.window.document;
  const preexEdit = preexDoc.getElementById('descedit');
  preexEdit.focus();
  type(dPreex, 'descedit', 'my addendum');
  mockDelay = 0;
  await until(() => !preexDoc.getElementById('status').classList
    .contains('stale'));
  ok(preexDoc.getElementById('banner').hidden
     && preexEdit.value === 'my addendum'
     && preexDoc.getElementById('descview').textContent
          .includes('House rules.'),
     'an unseen pre-existing description arriving under a pre-arrival'
     + ' draft warns nobody: the pane shows the record, the draft'
     + ' waits');
  preexDoc.getElementById('desctoggle').click();
  preexDoc.getElementById('descgo').click();
  await until(() => !preexDoc.getElementById('banner').hidden);
  ok(preexDoc.getElementById('banner-msg').textContent
       === SCOPY.simulEditsCopy
     && gas.handle({ action: 'state', aname: 'preexdesc' })
          .blurb === 'House rules.',
     "and his save bounces in the server's words: a draft based on"
     + ' nothing never silently overwrites the record');

  /* Replicata (dreev's Firefox haunting, 2026-07-28): weeks ago this
     browser typed in the blurb and never saved; the blurb has since
     moved; the browser also holds a stale cached snapshot. Fresh
     load. Expectata: the database's blurb, rendered; no banner; the
     dead draft stays dead. Resultata pre-fix: the ghost draft came
     home, met the moved blurb, and cried edit-war on a fresh page —
     and again on every reload. */
  gas.handle({ action: 'add', aname: 'ghost',
    uname: 'ann', pid: 'pid-ghost-ann' });
  gas.handle({ action: 'describe', aname: 'ghost', base: '',
    blurb: 'first words' });
  const ghostCache = JSON.stringify(
    gas.handle({ action: 'state', aname: 'ghost' }));
  gas.handle({ action: 'describe', aname: 'ghost',
    base: gas.handle({ action: 'state', aname: 'ghost' }).tblurb,
    blurb: 'moved on' });
  const dGhost = await makePage('/ghost?api=' + API_URL, (w) => {
    w.localStorage.setItem('tauction-state:ghost', ghostCache);
    w.localStorage.setItem('tauction-drafts:ghost',
      '{"blurb":"the ghost draft"}');
  });
  const ghostDoc = dGhost.window.document;
  await until(() =>
    ghostDoc.getElementById('descedit').value === 'moved on');
  ok(ghostDoc.getElementById('banner').hidden
     && ghostDoc.getElementById('descedit').value === 'moved on'
     && ghostDoc.getElementById('desc').classList.contains('viewing')
     && ghostDoc.getElementById('descview').textContent
          .includes('moved on'),
     'a fresh load always shows the database: the stale draft and'
     + ' stale cache raise no banner and restore no ghost');

  /* Replicata: a description write reserved an auction without adding
     a participant or bid, and a bare page types that name. Expectata:
     the occupied-name gate offers its URL. Resultata pre-fix: the gate
     inferred existence from roster/bids and entered the auction. */
  gas.handle({ action: 'describe', aname: 'desconly', base: '',
    blurb: '' });
  const dDescOnly = await makePage('/?api=' + API_URL);
  type(dDescOnly, 'aname', 'desconly');
  commitName(dDescOnly);
  await until(() => dDescOnly.window.location.pathname !== '/'
    || !dDescOnly.window.document.getElementById('banner').hidden);
  const descOnlyLink = dDescOnly.window.document.querySelector('#banner a');
  ok(dDescOnly.window.location.pathname === '/'
     && descOnlyLink && descOnlyLink.getAttribute('href') === '/desconly',
     'a description-only auction is occupied even when its description'
     + ' is explicitly empty');

  /* Replicata: the active typed-name probe returns a server error.
     Expectata: the banner repeats those words exactly. Resultata
     pre-fix: switchAuction dereferenced the error as state and wrapped
     the resulting TypeError in its own ERROR2157 text. */
  const dProbeError = await makePage('/?api=' + API_URL);
  const ordinaryFetch = dProbeError.window.fetch;
  dProbeError.window.fetch = (url, opts) => String(url).startsWith(API_URL)
    ? Promise.resolve({ json: () => Promise.resolve(
      { error: SCOPY.nameTakenCopy }) })
    : ordinaryFetch(url, opts);
  type(dProbeError, 'aname', 'probeerror');
  commitName(dProbeError);
  await until(() => !dProbeError.window.document
    .getElementById('banner').hidden);
  ok(dProbeError.window.location.pathname === '/'
     && dProbeError.window.document.getElementById('banner-msg')
          .textContent === SCOPY.nameTakenCopy,
     'a typed-name probe displays res.error verbatim and stays put');

  /* Replicata: an active typed-name probe returns a state payload from
     before the exists field joined the contract. Expectata: reject the
     malformed state before naming or navigating. Resultata pre-fix:
     undefined looked false, so the page committed the name and only
     then crashed when ingest finally checked the shape. */
  const malformedState = JSON.parse(JSON.stringify(
    gas.handle({ action: 'state', aname: 'malformedprobe' })));
  delete malformedState.exists;
  const dMalformed = await makePage('/?api=' + API_URL);
  const malformedFetch = dMalformed.window.fetch;
  dMalformed.window.fetch = (url, opts) => String(url).startsWith(API_URL)
    ? Promise.resolve({ json: () => Promise.resolve(malformedState) })
    : malformedFetch(url, opts);
  type(dMalformed, 'aname', 'malformedprobe');
  commitName(dMalformed);
  await until(() => dMalformed.window.location.pathname !== '/'
    || !dMalformed.window.document.getElementById('banner').hidden);
  ok(dMalformed.window.location.pathname === '/'
     && !dMalformed.window.document.getElementById('aname').disabled
     && dMalformed.window.document.getElementById('banner').textContent
          .includes('assert: bad state shape'),
     'a malformed probe fails loudly while the page stays unnamed');

  /* Replicata: JSON turns the server's safe dictionaries back into
     ordinary objects, and an unclaimed, unbid participant is literally
     named constructor. Expectata: constructor is an ordinary row.
     Resultata pre-fix: inherited Object members impersonated claim,
     bid, and row entries, and rendering crashed before building it. */
  gas.handle({ action: 'add', aname: 'constructormap',
    uname: 'constructor', pid: 'constructor' });
  const dConstructor = await makePage('/constructormap?api=' + API_URL,
    (w) => { w.localStorage.setItem('tauction-pids',
      '{"constructormap":"constructor"}'); });
  const constructorRow = row(dConstructor.window.document, 'constructor');
  ok(constructorRow && constructorRow.classList.contains('mine')
     && constructorRow.querySelector('.rebid textarea').value === ''
     && dConstructor.window.document.getElementById('banner').hidden,
     'constructor survives real JSON semantics as an ordinary unclaimed'
     + ' participant, with an ordinary blank bid editor');
  typeBid(dConstructor, 'constructor bid');
  submitBid(dConstructor);
  await settled(dConstructor);
  const constructorState = gas.handle(
    { action: 'state', aname: 'constructormap' });
  ok(myEditor(dConstructor.window.document).value === 'constructor bid'
     && constructorState.bidders.find((b) => b.pid === 'constructor')
          .bcount === 1,
     'constructor submits and remembers its bid through the same safe'
     + ' pid maps');

  /* --- renames in the pid era: plain ops on a fixed identity -----------
     (2026-07-19, the migration that DELETED the client's rename-
     transaction machinery: a rename is a label edit keyed by pid, so
     the old stale-chain hazard — alice→beta→gamma grabbing someone
     else's remote beta — is unrepresentable: the wire never carries
     a from-name at all. These quals replace the four transaction-era
     pins whose machinery no longer exists.) */
  gas.handle({ action: 'add', aname: 'renops',
    uname: 'alice', pid: 'pid-renops-alice' });
  gas.handle({ action: 'add', aname: 'renops',
    uname: 'carol', pid: 'pid-renops-carol' });
  gas.handle({ action: 'bid', aname: 'renops',
    uname: 'alice', pid: 'pid-renops-alice', bid: 'alice bid',
    deviceID: 'ren-device', deviceBlurb: 'Ren rig' });
  const dRen = await makePage('/renops?api=' + API_URL, (w) => {
    w.localStorage.setItem('tauction-device', 'ren-device');
    w.localStorage.setItem('tauction-pids',
      '{"renops":"pid-renops-alice"}');
    w.localStorage.setItem('tauction-mybids:renops',
      '{"pid-renops-alice":"alice bid"}');
  });
  // chained edits, mid-flight: two plain serialized ops, both keyed
  // by the pid — no dependency, no transaction, nothing to roll back
  mockDelay = 300;
  renameTo(dRen, 'alice', 'beta');
  renameTo(dRen, 'beta', 'gamma');
  ok(row(dRen.window.document, 'gamma') !== null
     && row(dRen.window.document, 'gamma').classList.contains('mine')
     && dRen.window.localStorage.getItem('tauction-mybids:renops')
          === '{"pid-renops-alice":"alice bid"}'
     && dRen.window.localStorage.getItem('tauction-pids')
          === '{"renops":"pid-renops-alice"}',
     'chained renames advance the label instantly; identity and bid'
     + ' memory never move — the pid IS the identity');
  await until(() => gas.handle({ action: 'state', aname: 'renops' })
    .seats.some((s) => s.uname === 'gamma'));
  mockDelay = 0;
  const renCalls = apiCalls.filter((c) => c.action === 'rename'
    && c.aname === 'renops');
  ok(renCalls.length === 2
     && renCalls.every((c) => c.pid === 'pid-renops-alice')
     && renCalls[1].to === 'gamma',
     'both legs went out as pid-keyed ops: no from-name exists to go'
     + ' stale');
  await settled(dRen);
  ok(row(dRen.window.document, 'gamma').classList.contains('mine')
     && myEditor(dRen.window.document).value === 'alice bid',
     'after the dust: same seat, same you, same bid — only the label'
     + ' changed');
  // the server-side label race (a collision the local guard cannot
  // see): the refusal reddens the field, keeps the typed text for
  // fixing, and the recovery snapshot restores the committed label
  gas.handle({ action: 'add', aname: 'renops',
    uname: 'zeta', pid: 'pid-renops-zeta' });  // unseen: no poll yet
  renameTo(dRen, 'gamma', 'zeta');
  await until(() => !dRen.window.document
    .getElementById('banner').hidden);
  await settled(dRen);
  ok(dRen.window.document.getElementById('banner').textContent
       .includes(SCOPY.nameTakenCopy)
     && row(dRen.window.document, 'gamma') !== null
     && row(dRen.window.document, 'gamma')
          .querySelector('.rename input').classList.contains('error')
     && row(dRen.window.document, 'gamma')
          .querySelector('.rename input').value === 'zeta'
     && row(dRen.window.document, 'gamma').classList.contains('mine'),
     'a lost label race: banner in the server\'s words, the field red'
     + ' with your text kept, the committed label restored — and you'
     + ' are still you (nothing to roll back: identity never moved)');

  /* Replicata: focus alice's live name field, submit alicia, wait for
     the server to accept it, then press Escape without first leaving
     the field. Expectata: alicia is now the committed baseline, so
     Escape is a no-op. Resultata pre-fix: defaultValue was still alice,
     so Escape submitted a second rename and reversed the first one. */
  gas.handle({ action: 'add', aname: 'renescape',
    uname: 'alice', pid: 'pid-renescape-alice' });
  gas.handle({ action: 'add', aname: 'renescape',
    uname: 'bob', pid: 'pid-renescape-bob' });
  const dRenEscape = await makePage('/renescape?api=' + API_URL);
  const renEscapeDoc = dRenEscape.window.document;
  const renEscapeInput = row(renEscapeDoc, 'alice')
    .querySelector('.rename input');
  renEscapeInput.focus();
  renEscapeInput.value = 'alicia';
  renEscapeInput.form.dispatchEvent(new dRenEscape.window.Event('submit',
    { bubbles: true, cancelable: true }));
  await until(() => names(gas.handle({ action: 'state',
    aname: 'renescape' })) === 'alicia,bob'
    && !renEscapeDoc.getElementById('status').classList.contains('stale'));
  ok(renEscapeInput.value === 'alicia'
     && renEscapeInput.defaultValue === 'alicia'
     && renEscapeDoc.activeElement === renEscapeInput,
     'an accepted focused rename advances value and committed baseline');
  const renEscapeCalls = apiCalls.filter((c) => c.action === 'rename'
    && c.aname === 'renescape').length;
  renEscapeInput.dispatchEvent(new dRenEscape.window.KeyboardEvent('keydown',
    { key: 'Escape', bubbles: true }));
  await sleep(50);
  ok(row(renEscapeDoc, 'alicia') !== null
     && names(gas.handle({ action: 'state', aname: 'renescape' }))
          === 'alicia,bob'
     && apiCalls.filter((c) => c.action === 'rename'
          && c.aname === 'renescape').length === renEscapeCalls,
     'Escape after an accepted focused rename is a no-op: one request,'
     + ' one committed label');

  /* --- 1. bare visit: no server-invented name — the user picks ---------- */
  let dom = await makePage('/?api=' + API_URL);
  let doc = dom.window.document;
  ok(dom.window.location.pathname === '/', 'a bare visit stays at /');
  ok(doc.getElementById('seal').disabled
     && doc.getElementById('seal').getAttribute('data-tip')
          === STR.needNameTip,
     "the unnamed page's padlock is gray with dreev's"
     + ' name-first tip (it once rested on the HTML\'s "Reveal'
     + ' bids!" — the resting stamp needs no branch)');
  ok(!apiCalls.some((c) => c.action === 'fresh'),
     'no fresh-name round trip: particle names are gone');
  ok(doc.activeElement === doc.getElementById('aname')
     && doc.getElementById('aname').value === '',
     'the empty auction field holds the caret: naming it is your move');
  ok(!doc.getElementById('aname').hasAttribute('data-tip')
     && doc.querySelector('label[for="aname"]').getAttribute('data-tip')
          !== STR.nameStoneTip,
     'the LIVE name field needs no tooltip of its own, and its label'
     + ' wears the editable-state copy');
  ok(!doc.getElementById('status').classList.contains('stale')
     && doc.getElementById('roster-input').disabled,
     'the unnamed ledger IDLES (+ row disabled) — never BUSY: stale'
     + ' here meant a gavel hammering forever');
  type(dom, 'aname', 'Fresh-1!');
  commitName(dom);
  ok(doc.getElementById('aname').value === 'fresh1', 'slug sanitized');
  await until(() =>  // debounce + the gate's lookup: wait, don't sample
    dom.window.location.pathname === '/fresh1');
  ok(dom.window.location.pathname === '/fresh1'
     && dom.window.location.search.includes('api='),
     'naming it navigates, keeping ?api=');
  ok(doc.getElementById('aname').disabled,
     'NAMES ARE CHOSEN ONCE (dreev, dissolving the navigator/name'
     + ' dual meaning): the field disables the moment the name'
     + ' commits — the URL is the navigation now');
  /* Replicata (dreev, 2026-07-18): name the auction, start on the
     blurb, then click the name to edit it. Nothing happens — correct,
     but it read as a GLITCH. Expectata: the dead field explains
     itself without cluttering the UI with a NEW tooltip (dreev's
     call, retiring the input's own alea-iacta-est tip): the field
     sheds its box (CSS) and the LABEL's existing tip flips to the
     committed-name copy — the name is the URL now, not a field. */
  ok(!doc.getElementById('aname').hasAttribute('data-tip')
     && doc.querySelector('label[for="aname"]').getAttribute('data-tip')
          === STR.nameStoneTip,
     "the committed name's label flips to the frozen-state copy; the"
     + ' input itself hosts no tip');
  ok(!doc.getElementById('roster-input').disabled
     && !doc.getElementById('status').classList.contains('stale'),
     'the named ledger wakes: + row live, gray gone');
  // (was a count of [data-tip][tabindex="-1"] === 1, from when the
  // label was the only tap-focusable non-tab-stop; every button joined
  // that club 2026-07-16 per dreev, so pin the label itself instead)
  ok(doc.querySelector('label[for="aname"]').getAttribute('data-tip')
     && doc.querySelector('label[for="aname"]').tabIndex === -1
     && !doc.querySelector('.tip'),
     'the auction label is its own tooltip host (tap-focusable, not a'
     + ' tab stop); the ? icons are gone');
  ok(doc.querySelector('#status .thead .th-person').textContent
       .includes('PARTICIPANTS')
     && doc.querySelector('#status .thead .th-bid').textContent
       .includes('BIDS'),
     'column headings PARTICIPANTS | BIDS lead the section');
  ok(!doc.querySelector('#status .card-title'),
     'no separate section heading above the column headings');
  ok(!doc.querySelector('#status .th-person [data-tip]')
     && doc.querySelector('label[for="aname"][data-tip]'),
     'PARTICIPANTS explains itself in the help popup — no tooltip; the'
     + ' auction label keeps its own');
  ok(doc.querySelector('#status .th-bid #seal'),
     'the padlock sits with BIDS');
  ok(tiles(doc).length === 0, 'an auction with no roster is just an empty box');
  ok(doc.getElementById('seal').getAttribute('data-tip')
       === STR.needTwoTip,
     'empty roster: the tip names the real blocker — and counts it'
     + ' right (two needed, not "one more" than nobody)');
  ok(doc.querySelector('#status .addrow #roster-input'),
     'the + row is part of the ledger from the start');
  ok(doc.querySelector('#status .legend')
     && doc.querySelector('#status .legend').textContent === '\u2605 = you',
     'the star gets a footnote: \u2605 = you');
  ok(doc.querySelector('#status .addrow .you-hint')
     && doc.getElementById('status').classList.contains('unclaimed'),
     "nobody is you yet: the legend's \u2605 perches on the + row, where"
     + ' you would appear');
  ok(doc.getElementById('roster-input').getAttribute('enterkeyhint')
       === 'next'
     && doc.getElementById('aname').getAttribute('enterkeyhint') === 'done',
     "mobile return keys: Next over the + row (add, keep adding), Done"
     + " over the auction name");
  ok(!doc.getElementById('status').classList.contains('revealed'),
     'tada not lit before any reveal');

  /* --- 1b. no blank-roster flash while an auction loads ------------------
     Replicata: open an auction page; the first state fetch takes a
     second (real Apps Script latency). Expectata: a visitor never sees
     what looks like a confirmed-empty roster — a returning browser
     paints its cached rows instantly (grayed till the live fetch), and
     a first-time browser sees just the grayed box and the gavel (the
     old ⋯ pulse sat as a phantom blank line above the + row). */
  gas.handle({ action: 'add', aname: 'warm',
    uname: 'ann', pid: 'pid-warm-ann' });
  gas.handle({ action: 'add', aname: 'warm',
    uname: 'ben', pid: 'pid-warm-ben' });
  const seeded = gas.handle({ action: 'state', aname: 'warm' });
  mockDelay = 800;
  const domWarm = await makePage('/warm?api=' + API_URL, (win) =>
    win.localStorage.setItem('tauction-state:warm', JSON.stringify(seeded)));
  ok(tiles(domWarm.window.document).length === 2,
     'cached rows paint instantly, before the live fetch lands');
  ok(domWarm.window.document.getElementById('status').classList.contains('stale'),
     'the instant paint is grayed until the live fetch confirms');
  const domCold = await makePage('/coldload?api=' + API_URL);
  ok(tiles(domCold.window.document).length === 0
     && !domCold.window.document.querySelector('#tiles .loading')
     && domCold.window.document.getElementById('status').classList
          .contains('stale'),
     'first-ever visit: no phantom rows above the + — the gray and the'
     + ' gavel alone say loading');
  await sleep(1000);
  mockDelay = 0;
  ok(!domWarm.window.document.getElementById('status').classList.contains('stale'),
     'warm page ungrays once the live fetch lands');
  ok(!domCold.window.document.getElementById('status').classList
       .contains('stale'),
     'the cold page ungrays once the state lands');
  ok(names(JSON.parse(
       domWarm.window.localStorage.getItem('tauction-state:warm')))
       === 'ann,ben',
     'every ingested state refreshes the cache');
  ok(domCold.window.document.getElementById('banner').hidden
     && domWarm.window.document.getElementById('banner').hidden,
     'no banner on a routine load: red is for the genuinely exceptional');

  /* --- 1c. version skew fails loudly (the red flash dreev saw) -----------
     Replicata: the deployed Code.gs lags the frontend's expected
     payload shape, which the frontend asserts on every ingest.
     Expectata: a loud, honest banner naming the state-shape problem —
     the fix is deploying @17, never softening the assert. */
  stripTini = true;
  gas.handle({ action: 'add', aname: 'skew',
    uname: 'old', pid: 'pid-skew-old' });
  gas.handle({ action: 'bid', aname: 'skew',
    uname: 'old', pid: 'pid-skew-old', bid: 'relic' });
  const domSkew = await makePage('/skew?api=' + API_URL);
  ok(!domSkew.window.document.getElementById('banner').hidden
     && domSkew.window.document.getElementById('banner').textContent
          .includes('bad state shape'),
     'an old-server payload banners loudly, naming the skew');
  stripTini = false;

  /* --- 1c2. the WHOLE stamp shape is the contract, not "has a T" --------
     (anti-Postel, dreev-ratified 2026-07-18.) Replicata: a stamp a
     human hand-edits or date-formats reads back as "Fri Jul 17 2026
     18:23:45 GMT-0700 (...)" — whose GMT smuggled a 'T' past the old
     includes-check while silently breaking the lexicographic stamp
     ordering; and a hand-written blank tbid rendered a "NaNd ago"
     tooltip. (gridScience 2026-07-18: growth alone doesn't coerce
     the T...Z shape — this is the human-edit belt.) Expectata: every
     stamp is full-ISO or the ingest refuses loudly. */
  const COERCED = String(new Date('2026-07-18T01:23:45.678Z'));
  stampSwap = COERCED;
  gas.handle({ action: 'add', aname: 'coerced',
    uname: 'old', pid: 'pid-coerced-old' });
  gas.handle({ action: 'bid', aname: 'coerced',
    uname: 'old', pid: 'pid-coerced-old', bid: 'x' });
  const domCo = await makePage('/coerced?api=' + API_URL);
  ok(!domCo.window.document.getElementById('banner').hidden
     && domCo.window.document.getElementById('banner').textContent
          .includes('bad state shape'),
     'a Sheets-coerced bidder stamp refuses loudly: GMT can no longer'
     + ' smuggle a T past the shape check');
  stampSwap = '';
  const domNan = await makePage('/coerced?api=' + API_URL);
  ok(!domNan.window.document.getElementById('banner').hidden
     && domNan.window.document.getElementById('banner').textContent
          .includes('bad state shape'),
     'a blank stamp (the old "NaNd ago" tooltip) refuses loudly too');
  gas.handle({ action: 'add', aname: 'coercedtfin',
    uname: 'a1', pid: 'pid-coercedtfin-a1' });
  gas.handle({ action: 'add', aname: 'coercedtfin',
    uname: 'b2', pid: 'pid-coercedtfin-b2' });
  gas.handle({ action: 'bid', aname: 'coercedtfin',
    uname: 'a1', pid: 'pid-coercedtfin-a1', bid: 'x' });
  gas.handle({ action: 'bid', aname: 'coercedtfin',
    uname: 'b2', pid: 'pid-coercedtfin-b2', bid: 'y' });
  gas.handle({ action: 'reveal', aname: 'coercedtfin' });
  stampSwap = COERCED;
  const domCt = await makePage('/coercedtfin?api=' + API_URL);
  ok(!domCt.window.document.getElementById('banner').hidden
     && domCt.window.document.getElementById('banner').textContent
          .includes('bad state shape'),
     'a coerced tfin refuses loudly instead of stamping a wrong'
     + ' Closed line');
  stampSwap = null;

  // A no-change poll must not rebuild the rows: a rebuild destroys
  // buttons mid-click (mousedown and mouseup need the same node), so a
  // click near a poll tick would silently die
  const nodeBefore = row(domWarm.window.document, 'ann');
  await sleep(5100);  // one no-change poll
  ok(row(domWarm.window.document, 'ann') === nodeBefore,
     'a no-change poll leaves the DOM alone (no swallowed clicks)');

  /* --- 1c3. transport death is WEATHER, not news -----------------------
     Replicata: a live page's poll dies at the network layer — the
     wifi blink, or the return-refresh racing a laptop wake (dreev hit
     this in a test auction right after a reveal). Expectata (dreev's
     ruling): no banner — nothing the user did was lost, so the only
     honest signal is the existing one for "this picture may be
     stale": the ledger grays under the hammering gavel until a poll
     lands, and the diagnostic detail goes to the console for whoever
     is debugging. Banners keep carrying SPOKEN news only (server
     refusals, failed user writes, version skew — see 1c, which pins
     that drift still banners: polling heals outages, never drift).
     Resultata pre-fix: a sticky ERROR2152 banner over a bright,
     normal-looking ledger — claiming catastrophe while looking fine,
     the exact inverse of the truth. */
  gas.handle({ action: 'add', aname: 'wifi',
    uname: 'ann', pid: 'pid-wifi-ann' });
  const dWifi = await makePage('/wifi?api=' + API_URL);
  const wifiDoc = dWifi.window.document;
  await until(() => row(wifiDoc, 'ann')
    && !wifiDoc.getElementById('status').classList.contains('stale'));
  const warns = dWifi.window.__warns;
  fetchDown = true;
  setVisibility(dWifi, 'hidden');  // the return-refresh IS the racy
  setVisibility(dWifi, 'visible'); // fetch: fire it into dead air
  await sleep(100);
  ok(wifiDoc.getElementById('banner').hidden,
     'a dead fetch banners NOTHING: no user action was lost, so there'
     + ' is no news to read');
  ok(wifiDoc.getElementById('status').classList.contains('stale'),
     'instead the ledger grays under the gavel: the one honest'
     + ' statement is that this picture may be stale');
  ok(warns.some((w) => w.includes('ERROR2152')
       && w.includes('Failed to fetch')),
     'the detail lands on the console, greppable by its code, for'
     + ' whoever is debugging');
  ok(row(wifiDoc, 'ann') !== null,
     'the last-known rows stand while the weather passes — grayed,'
     + ' never wiped');
  fetchDown = false;
  setVisibility(dWifi, 'hidden');  // the weather passes; the next
  setVisibility(dWifi, 'visible'); // fetch heals the gray
  await until(() =>
    !wifiDoc.getElementById('status').classList.contains('stale'));
  ok(!wifiDoc.getElementById('status').classList.contains('stale')
     && wifiDoc.getElementById('banner').hidden
     && row(wifiDoc, 'ann') !== null,
     'the first landed poll re-brightens the ledger — self-healing by'
     + ' construction, still bannerless in both directions');

  /* --- 1c4. THE CHRONICLE: the console narrates the ledger's story -----
     Replicata: debug any hallway session by opening the console.
     Expectata (dreev's spec, 2026-07-20): a transaction log in the
     app's own glyphs — boot names the build; arrival tables the
     roster as found; then one line per observed change (+ @join,
     − @leave, @old → @new, '@who: bid #n', ★ claim, ✎ description,
     🎉 revealed with the unmasked results tabled); this page's own
     writes announce themselves as '(actor) → deed' when SENT and
     narrate like everything else when their settle becomes table
     truth; refusals log ✗ with the server's words. One differ at the
     one adoption seam — an unchanged snapshot logs NOTHING, so the
     5s poll stays silent. Resultata pre-fix: a silent console. */
  gas.handle({ action: 'add', aname: 'diary',
    uname: 'ann', pid: 'pid-diary-ann' });
  const dDiary = await makePage('/diary?api=' + API_URL);
  const diaryDoc = dDiary.window.document;
  const logs = dDiary.window.__logs;
  const has = (s) => logs.some((l) => typeof l === 'string'
    && l.includes(s));
  const jog = async () => {  // force an immediate poll: hide + return
    setVisibility(dDiary, 'hidden');
    setVisibility(dDiary, 'visible');
    await sleep(120);
  };
  await until(() => row(diaryDoc, 'ann') !== null);
  ok(logs[0] === 'tauction '
       + diaryDoc.querySelector('.version').textContent,
     'boot names the build (dreev hand-bumps it; "which version am I'
     + ' looking at" is question zero)');
  ok(has('· /diary') && logs.some((l) => Array.isArray(l)
       && l.some((r) => r.who === '@ann')),
     'arrival: the auction named, the roster tabled as found');
  addName(dDiary, 'me');
  await until(() => row(diaryDoc, 'me') && drained(dDiary));
  ok(has('→ add @me'),
     'an outbound write announces itself at the send');
  ok(has('+ @me'),
     '...and narrates like any other change when its settle becomes'
     + ' table truth');
  gas.handle({ action: 'add', aname: 'diary',
    uname: 'bob', pid: 'pid-diary-bob' });
  gas.handle({ action: 'add', aname: 'diary',
    uname: 'tmp', pid: 'pid-diary-tmp' });
  await jog();
  ok(has('+ @bob') && has('+ @tmp'),
     'remote joins narrate on the poll that shows them');
  row(diaryDoc, 'tmp').querySelector('.x').click();
  await until(() => has('− @tmp'));  // a removal wears no busy sign
                                     // (its row is already gone), so
                                     // the narration IS the settle
  ok(has('→ remove') && has('− @tmp'),
     'a removal: announced outbound, narrated at the settle');
  renameTo(dDiary, 'bob', 'rob');
  await until(() => row(diaryDoc, 'rob') && drained(dDiary));
  ok(has('→ rename → @rob') && has('@bob → @rob'),
     'a rename narrates as old → new');
  const warned = (s) => dDiary.window.__warns.some((w) => w.includes(s));
  const renPosts = () => apiCalls.filter((c) => c.action === 'rename'
    && c.aname === 'diary').length;
  const renBefore = renPosts();
  renameTo(dDiary, 'rob', 'ann');  // ann is live: the LOCAL guard
  await sleep(30);
  ok(warned('✗ ' + STR.nameTakenBanner) && renPosts() === renBefore,
     'even a client-side refusal warns ✗ — every bannered error, from'
     + ' ANY path, reaches the chronicle (structurally: banner()'
     + ' itself warns, so no site can forget)');
  gas.handle({ action: 'bid', aname: 'diary',
    uname: 'ann', pid: 'pid-diary-ann', bid: 'aa' });
  await jog();
  ok(has('@ann: bid #1'), "a bid narrates by owner and ordinal —"
     + ' never its sealed text');
  typeBid(dDiary, 'mm');  // (the fresh add already auto-claimed me)
  submitBid(dDiary);
  await settled(dDiary);
  ok(has('→ bid @me') && has('@me: bid #1'),
     'your own bid: announced at the send, narrated at the settle');
  ok(has('★ @me'),
     "the bid's registered claim narrates too (★ = taken, as on the"
     + ' ledger)');
  gas.handle({ action: 'bid', aname: 'diary',
    uname: 'ann', pid: 'pid-diary-ann', bid: 'aaa' });
  await jog();
  ok(has('@ann: bid #2'), 're-bids narrate by their bumped ordinal');
  gas.handle({ action: 'add', aname: 'diary',
    uname: 'zed', pid: 'pid-diary-zed-remote' });
  addName(dDiary, 'zed');  // the 2d2 race: this page loses, quietly
  await until(() => row(diaryDoc, 'zed')
    && row(diaryDoc, 'zed').dataset.pid === 'pid-diary-zed-remote'
    && drained(dDiary));
  ok(diaryDoc.getElementById('banner').hidden && has('+ @zed'),
     'a lost add race converges quietly: one + entry, no error — the'
     + ' loser is an ordinary latecomer (dreev 2026-07-21)');
  gas.handle({ action: 'add', aname: 'diary',
    uname: 'kim', pid: 'pid-diary-kim' });
  renameTo(dDiary, 'rob', 'kim');  // stale roster: the local guard is
                                   // blind, the server refuses
  await until(() => !diaryDoc.getElementById('banner').hidden);
  await until(() => row(diaryDoc, 'rob') && drained(dDiary));
  ok(warned('✗ ' + SCOPY.nameTakenCopy) && row(diaryDoc, 'rob') !== null,
     "a server refusal warns ✗ with the server's words (a rename onto"
     + ' a live label is a real error: the requested CHANGE did not'
     + ' happen — unlike the add race)');
  const quiet = logs.length;
  await jog();
  ok(logs.length === quiet,
     'an unchanged snapshot narrates NOTHING: the 5s poll is silent'
     + ' by construction');
  const base = gas.handle({ action: 'state', aname: 'diary' });
  gas.handle({ action: 'describe', aname: 'diary',
    blurb: 'de rebus emptis', base: base.tblurb });
  await jog();
  ok(has('✎ description (15 chars)'),
     'a description edit narrates its new length, not its text');
  gas.handle({ action: 'bid', aname: 'diary',
    uname: 'rob', pid: 'pid-diary-bob', bid: 'rr' });
  gas.handle({ action: 'bid', aname: 'diary',
    uname: 'zed', pid: 'pid-diary-zed-remote', bid: 'zz' });
  gas.handle({ action: 'bid', aname: 'diary',
    uname: 'kim', pid: 'pid-diary-kim', bid: 'kk' });
  gas.handle({ action: 'reveal', aname: 'diary' });
  await jog();
  ok(has('@rob: bid #1') && has('@zed: bid #1') && has('🎉 revealed'),
     'the finale narrates: the last bids in, then the latch');
  ok(logs.some((l) => Array.isArray(l)
       && l.some((r) => r.who === '@rob' && r.bid === 'rr')),
     'the unmasked results land as a table — public now, so the'
     + ' console may finally say them');

  /* --- 1d. tab in the typed name is NAVIGATION, like everywhere --------
     [FLIPPED 2026-07-27, dreev: "we don't ever want commit-on-tab
     anymore. consistency." — the last Tab-commit dies. The old
     name-tab-describe flow (his 2026-07-18 ask) survives by
     convention instead: Enter commits, the committed name DISABLES
     its field, and native Tab then lands in the description because
     it is the page's first enabled field.] */
  const dTabName = await makePage('/?api=' + API_URL);
  const tabDoc = dTabName.window.document;
  const tabProbes = () => apiCalls.filter((c) => c.action === 'state'
    && c.aname === 'tabflow2').length;
  type(dTabName, 'aname', 'tabflow2');
  const tabUneaten = tabDoc.getElementById('aname').dispatchEvent(
    new dTabName.window.KeyboardEvent('keydown',
      { key: 'Tab', bubbles: true, cancelable: true }));
  await sleep(80);
  ok(tabUneaten
     && dTabName.window.location.pathname === '/'
     && !tabDoc.getElementById('aname').disabled
     && tabDoc.getElementById('aname').value === 'tabflow2'
     && tabProbes() === 0,
     'tab in the auction name commits NOTHING, uneaten — it moves'
     + ' focus like Tab should; the typed name just waits');
  commitName(dTabName);  // Enter is the one gesture
  await until(() => dTabName.window.location.pathname === '/tabflow2');
  await sleep(20);
  ok(tabDoc.getElementById('aname').disabled
     && !tabDoc.getElementById('descedit').disabled,
     'Enter commits and stones the name field, leaving the'
     + ' description as the first enabled field — native Tab now'
     + ' does the old name-tab-describe carry by convention');

  /* --- 1e. a thinking pause mid-name commits NOTHING -------------------
     Replicata (dreev, 2026-07-18, mid-whack-a-mole): start typing
     the auction name, pause to think longer than any debounce, keep
     typing. Resultata pre-fix: a 500ms timer committed the half-
     typed name and froze the field — locked out of your own auction
     name mid-word, irreversibly (names are chosen once). Expectata:
     an IRREVERSIBLE commit rides ONE deliberate gesture — Enter —
     never a clock, never Tab (navigation), and deliberately not
     even blur: a stray tap elsewhere must not commit half a name
     either. Typed text just waits in the live field. */
  const dPause = await makePage('/?api=' + API_URL);
  const pauseDoc = dPause.window.document;
  // other pages keep polling their own auctions; only probes for the
  // names typed HERE would betray a timer
  const pizProbes = () => apiCalls.filter((c) => c.action === 'state'
    && (c.aname === 'piz' || c.aname === 'pizzanight')).length;
  type(dPause, 'aname', 'piz');
  await sleep(900);  // the fatal thinking pause, well past 500ms
  ok(dPause.window.location.pathname === '/'
     && !pauseDoc.getElementById('aname').disabled
     && pizProbes() === 0,
     'a mid-name pause commits nothing, freezes nothing, and sends'
     + ' NOTHING: no timer, not even a speculative probe');
  type(dPause, 'aname', 'pizzanight');  // the thought completes
  pauseDoc.getElementById('aname').dispatchEvent(
    new dPause.window.Event('blur'));
  await sleep(100);
  ok(dPause.window.location.pathname === '/'
     && !pauseDoc.getElementById('aname').disabled
     && pauseDoc.getElementById('aname').value === 'pizzanight'
     && pizProbes() === 0,
     'BLUR commits nothing here either (since 2026-07-27, nowhere):'
     + ' wandering off must not irreversibly name the auction');
  commitName(dPause);
  await until(() => dPause.window.location.pathname === '/pizzanight');
  ok(pauseDoc.getElementById('aname').disabled
     && pauseDoc.querySelector('label[for="aname"]')
          .getAttribute('data-tip') === STR.nameStoneTip,
     'Enter commits deliberately: the name takes, the field freezes,'
     + ' the label tip flips');

  /* --- 1f. the tab wears the auction's name and its state of play ------
     Replicata: open /alpha and /beta in two tabs, bid in both, come
     back later to reveal one. Expectata: the tab bar itself tells
     the auctions apart — the auction's own name leads the title —
     and a glyph tells the state of play, dreev's ruled quadruple
     (2026-07-20): waiting on bidders, everyone-waiting-on-YOU (the
     standout: you are the blocker), all-in-awaiting-the-press, and
     revealed. The unnamed page rests on the HTML's static title.
     Resultata pre-fix: every tab read the static "tauction". */
  const dBareTitle = await makePage('/?api=' + API_URL);
  ok(dBareTitle.window.document.title === 'tauction',
     "the unnamed page keeps the HTML's static title");
  gas.handle({ action: 'add', aname: 'titular',
    uname: 'ann', pid: 'pid-titular-ann' });
  gas.handle({ action: 'add', aname: 'titular',
    uname: 'bo', pid: 'pid-titular-bo' });
  gas.handle({ action: 'bid', aname: 'titular',
    uname: 'ann', pid: 'pid-titular-ann', bid: 'a' });
  gas.handle({ action: 'bid', aname: 'titular',
    uname: 'bo', pid: 'pid-titular-bo', bid: 'b' });
  const dTitle = await makePage('/titular?api=' + API_URL);
  const titleDoc = dTitle.window.document;
  await until(() => !titleDoc.getElementById('status')
    .classList.contains('stale'));
  ok(titleDoc.title === STR.tabTitle(STR.readyGlyph, 'titular'),
     'all bids in, unrevealed: the tab offers the press (ready is the'
     + ' state that calls SOMEONE back), got '
     + JSON.stringify(titleDoc.title));
  gas.handle({ action: 'reveal', aname: 'titular' });  // from elsewhere
  await until(() => titleDoc.getElementById('status')
    .classList.contains('revealed'));
  ok(titleDoc.title === STR.tabTitle(STR.revealedGlyph, 'titular'),
     'the reveal flips the tab glyph: done auctions are tellable from'
     + ' the tab bar');
  // the cached instant paint titles the tab too, before the live
  // fetch lands (the same never-flash-blank promise as the roster)
  const seededTitle = gas.handle({ action: 'state', aname: 'titular' });
  mockDelay = 400;
  const dWarmTitle = await makePage('/titular?api=' + API_URL, (win) =>
    win.localStorage.setItem('tauction-state:titular',
      JSON.stringify(seededTitle)));
  ok(dWarmTitle.window.document.title
       === STR.tabTitle(STR.revealedGlyph, 'titular'),
     'a returning browser titles the tab from the cached paint,'
     + ' before the live fetch lands');
  mockDelay = 0;
  // the typed-name road runs through switchAuction, not init
  const dTypedTitle = await makePage('/?api=' + API_URL);
  type(dTypedTitle, 'aname', 'titulus');
  commitName(dTypedTitle);
  await until(() =>
    dTypedTitle.window.location.pathname === '/titulus');
  ok(dTypedTitle.window.document.title
       === STR.tabTitle(STR.waitingGlyph, 'titulus'),
     'the typed-name road titles the tab the instant the name takes'
     + ' (empty roster: plain waiting)');
  // a solo roster is never "everyone waiting on you": nobody's there
  // to wait — the ⭐ needs at least one actual waiter
  const dSolo = await makePage('/solome?api=' + API_URL);
  addName(dSolo, 'me');
  await until(() => drained(dSolo));
  ok(dSolo.window.document.title === STR.tabTitle(STR.waitingGlyph, 'solome'),
     'alone on the roster, bidless: waiting, never the ⭐');

  /* --- 1f2. the hidden tab: the minute peek, title-only ----------------
     Replicata: join /peekaboo, background the tab, and let the others
     bid — then reveal — while you're away. Expectata (dreev's ruling
     + Sol's title-only law): a hidden tab spends one bare state GET a
     minute on its TITLE alone — ⭐ when the missing bid is yours, 🔓
     when all are in, 🎉 at the latch (where peeking retires forever)
     — while ingesting NOTHING, so the witnessed-reveal ceremony law
     holds: returning to the tab refreshes at once and the party fires
     THEN, seen. Resultata pre-fix: hidden tabs were fully silent and
     a returning glance waited out the poll interval. */
  gas.handle({ action: 'add', aname: 'peekaboo',
    uname: 'ann', pid: 'pid-peekaboo-ann' });
  const dPeek = await makePage('/peekaboo?api=' + API_URL);
  const peekDoc = dPeek.window.document;
  ok(peekDoc.title === STR.tabTitle(STR.waitingGlyph, 'peekaboo'),
     'a spectator over a bidless pair-less roster: plain waiting');
  addName(dPeek, 'me');
  await until(() => row(peekDoc, 'me') && drained(dPeek));
  const peek = dPeek.window.__intervals.find((i) => i.ms === 60000);
  ok(peek !== undefined,
     'the hidden peek is registered at its explicit minute cadence'
     + ' (never outsourced to browser throttling heuristics)');
  const peekCalls = () => apiCalls.filter((c) => c.action === 'state'
    && c.aname === 'peekaboo').length;
  setVisibility(dPeek, 'hidden');
  gas.handle({ action: 'bid', aname: 'peekaboo',
    uname: 'ann', pid: 'pid-peekaboo-ann', bid: 'a' });
  peek.fn();
  await sleep(150);
  ok(peekDoc.title === STR.tabTitle(STR.yourMoveGlyph, 'peekaboo'),
     'everyone has bid but YOU: the tab bar says so while you are'
     + ' away — the standout state (dreev), got '
     + JSON.stringify(peekDoc.title));
  ok(!row(peekDoc, 'ann').classList.contains('has-bid')
     && !peekDoc.getElementById('status').classList.contains('stale'),
     "the peek is title-ONLY: ann's bid is NOT ingested and the box"
     + ' is untouched — never-clobber sleeps until the tab is looked at');
  const mePid = pidOf(gas.handle({ action: 'state', aname: 'peekaboo' }),
                      'me');
  gas.handle({ action: 'bid', aname: 'peekaboo',
    uname: 'me', pid: mePid, bid: 'b' });  // you, from your phone
  peek.fn();
  await sleep(150);
  ok(peekDoc.title === STR.tabTitle(STR.readyGlyph, 'peekaboo'),
     'all in: the hidden tab offers the press');
  gas.handle({ action: 'reveal', aname: 'peekaboo' });
  peek.fn();
  await sleep(150);
  ok(peekDoc.title === STR.tabTitle(STR.revealedGlyph, 'peekaboo'),
     'the latch reaches the hidden title');
  ok(!peekDoc.getElementById('status').classList.contains('revealed')
     && dPeek.window.__confettiCalls.length === 0,
     'but the reveal is NOT witnessed hidden: no flip, no ceremony —'
     + ' the party waits for a viewer');
  const latched = peekCalls();
  peek.fn();
  await sleep(150);
  ok(peekCalls() === latched,
     'peeking retires forever at the latch: a revealed auction has no'
     + ' further news');
  setVisibility(dPeek, 'visible');
  await until(() =>
    peekDoc.getElementById('status').classList.contains('revealed'));
  ok(peekDoc.getElementById('status').classList.contains('just-revealed')
     && peekDoc.title === STR.tabTitle(STR.revealedGlyph, 'peekaboo'),
     'returning WITNESSES the reveal: the tada lights on the glance,'
     + ' not into the void');
  await until(() => dPeek.window.__confettiCalls.length >= 1);
  ok(dPeek.window.__confettiCalls.length >= 1,
     "...and the strike's money flies for the returned viewer");

  /* --- 1f3. returning to a tab refreshes AT ONCE -----------------------
     Replicata: background a tab inside its first poll interval, then
     return to it. Expectata: the glance meets a fresh fetch
     immediately, not up-to-POLL_MS-stale state; and the visible-tab
     peek gate holds (the minute cadence belongs to hidden tabs
     alone). Both pinned inside the first interval's 5s dead zone, so
     no poll tick can confound the counts. */
  const dRet = await makePage('/retvisit?api=' + API_URL);
  const retCalls = () => apiCalls.filter((c) => c.action === 'state'
    && c.aname === 'retvisit').length;
  const retBoot = retCalls();
  ok(retBoot === 1, 'one boot fetch, no poll tick yet: the dead zone'
     + ' holds (got ' + retBoot + ')');
  dRet.window.__intervals.find((i) => i.ms === 60000).fn();
  await sleep(150);
  ok(retCalls() === 1,
     'a visible tab never peeks: the minute cadence is hidden-only');
  setVisibility(dRet, 'hidden');
  setVisibility(dRet, 'visible');
  await sleep(300);
  ok(retCalls() === 2,
     'becoming visible refreshes at once — no waiting out the poll');

  /* --- 2. alice sets up /tau and bids in place; her bid stays visible --- */
  dom = await makePage('/tau?api=' + API_URL);
  doc = dom.window.document;
  ok(doc.getElementById('aname').disabled
     && doc.querySelector('label[for="aname"]').getAttribute('data-tip')
          === STR.nameStoneTip,
     'arriving by URL: the name is set in stone here too, the label'
     + ' tip flipped to match');
  type(dom, 'roster-input', 'Alice!');
  ok(doc.getElementById('roster-input').value === 'alice',
     'name sanitized while typing');
  addName(dom, 'alice');
  addName(dom, 'bob');
  await sleep(800);  // roster push debounce
  ok(tiles(doc).length === 2, 'roster of 2 -> two rows');
  ok(tiles(doc, '.has-bid').length === 0, 'both rows empty slots');
  ok(row(doc, 'alice').querySelector('.rename input').value === 'alice'
     && row(doc, 'bob').querySelector('.rename input').value === 'bob',
     'rows are named (in live name fields)');
  // [reworked 2026-07-17: typing an existing name now MEANS that
  // row (the hallway test); your own name = quietly nothing to do.
  // The red-ring objection lives on for HELD names — pinned in the
  // hallway section]
  addName(dom, 'alice');  // again!
  ok(doc.getElementById('roster-input').value === ''
     && !doc.getElementById('roster-input').classList.contains('error')
     && tiles(doc).length === 2,
     're-adding yourself clears quietly: nothing to do, nothing to'
     + ' object to');
  type(dom, 'roster-input', 'alicia');
  ok(!doc.getElementById('roster-input').classList.contains('error'),
     'typing withdraws the objection');
  doc.getElementById('roster-input').value = '';

  // her first add self-claimed (2j): row 0 is already hers
  ok(row(doc, 'bob').querySelector('.bid-card.slot')
     && !row(doc, 'bob').querySelector('.rebid'),
     "an empty card holds the space where bob's bid will land");
  // (subs superscript shelved 2026-07-15 for clutter; restore with the
  // commented code in app.js/style.css)
  // ok(tiles(doc)[0].querySelector('.tile-subs').textContent === '0',
  //    'submission counter reads 0 before bidding');
  ok(hoverBid(dom, 'bob') === STR.awaitingTip,
     'bidless cell tooltip: awaiting the bid');
  ok(doc.querySelector('#status .closed').textContent === '',
     'no Closed line while the auction lives');
  ok(doc.getElementById('seal'), 'seal-state badge present');
  ok(doc.getElementById('seal').getAttribute('data-tip')
       === STR.waitingTip('alice' + STR.youTag + ' and bob'),
     'padlock tip NAMES the stragglers, tagging you as you');
  addName(dom, 'carol');
  await until(() => names(gas.handle({ action: 'state', aname: 'tau' })) === 'alice,bob,carol');
  ok(doc.getElementById('seal').getAttribute('data-tip')
       === STR.waitingTip('alice' + STR.youTag + ', bob, and carol'),
     'three stragglers: Oxford comma and all');
  row(doc, 'carol').querySelector('.x').click();
  await until(() => names(gas.handle({ action: 'state', aname: 'tau' })) === 'alice,bob');
  ok(doc.getElementById('share') && doc.getElementById('help'),
     'share and help buttons present');
  ok(doc.getElementById('share-dlg') && doc.getElementById('help-dlg'),
     'share and help dialogs present');
  ok(doc.getElementById('help-dlg').textContent.includes(
       'Or just use it to play Schelling\u2019s coordination game.'),
     'help dialog carries the sealedbids text verbatim');
  ok(/^-?\d+ms$/.test(row(doc, 'bob').style.animationDelay),
     'empty rows phase-locked so poll rebuilds do not jump the fade'
     + ' (-0 stringifies to 0, hence the optional minus)');

  // her first add made her you (2j): her row is the editable one,
  // bob's leads with a claimable hollow star
  ok(dom.window.localStorage.getItem('tauction-uname') === 'alice',
     'the first add latched her name');
  ok(row(doc, 'alice').classList.contains('mine')
     && myEditor(doc), 'her row is hers, with an in-place editor');
  ok([...tiles(doc)].every((t) => t.querySelector('.x')
       && !t.querySelector('.x').disabled),
     'every row offers a live × while bidless');
  ok(myEditor(doc).placeholder === '' && myEditor(doc).value === '',
     'fresh editor: blank — the caret invites the bid, not words');
  ok(myEditor(doc).getAttribute('enterkeyhint') === 'send',
     "the mobile return key reads Send over the bid editor");
  ok(!doc.getElementById('status').classList.contains('unclaimed'),
     'someone is you now: the + row stops wearing the you-star');
  ok([...tiles(doc)].every((t) =>
       t.firstElementChild === t.querySelector('.tu')
       && !t.querySelector('.tile-name .tu'))
     && doc.querySelector('.addrow > .addmark')
     && doc.querySelector('.addrow > .fieldcol > .at-wrap'),
     'stars and + occupy the identity gutter, outside the participant'
     + ' fields');
  ok(row(doc, 'alice').querySelector('.tu').classList.contains('selected'),
     "your row's star is lit");
  ok(row(doc, 'alice').querySelector('.tu').getAttribute('aria-label')
       === '@alice'
     && row(doc, 'alice').querySelector('.tu')
          .getAttribute('aria-pressed') === 'true'
     && row(doc, 'bob').querySelector('.tu').getAttribute('aria-label')
       === '@bob'
     && row(doc, 'bob').querySelector('.tu')
          .getAttribute('aria-pressed') === 'false',
     'identity buttons name their participant and expose their toggle'
     + ' state');
  ok(row(doc, 'bob').querySelector('.tu')
     && !row(doc, 'bob').querySelector('.tu').disabled,
     'other bidless rows keep live stars (radio: one click to switch)');

  submitBid(dom);  // empty: the field itself objects, inline
  ok(myEditor(doc).classList.contains('error')
     && doc.getElementById('banner').hidden,
     'an empty bid reddens the field itself — no banner for a local'
     + ' slip');
  typeBid(dom, 'three tacos');
  myEditor(doc).dispatchEvent(new dom.window.Event('input',
    { bubbles: true }));
  ok(!myEditor(doc).classList.contains('error'),
     'typing clears the objection');
  submitBid(dom);
  await settled(dom);
  ok(myEditor(doc).value === 'three tacos',
     'own bid lives in your row, editable in place');
  ok(tiles(doc, '.has-bid').length === 1 && tiles(doc).length === 2,
     'one green, one empty after first bid');
  ok(!tiles(doc, '.has-bid')[0].classList.contains('cut'),
     'roster member not crossed out');
  ok(myEditor(doc).className === 'bid-card'
     && myEditor(doc).style.boxShadow === 'var(--lift)',
     'first bid: your editor becomes a single card, no sheets — just'
     + ' the composable lift');
  // (subs superscript shelved 2026-07-15)
  // ok(tiles(doc, '.has-bid')[0].querySelector('.tile-subs').textContent === '1',
  //    'submission counter ticks to 1');
  ok(/^your bid submitted \d+[sm] ago$/.test(hoverBid(dom, 'alice')),
     "own single-submission tooltip: 'your bid submitted Ns ago', got "
     + hoverBid(dom, 'alice'));
  ok(tiles(doc, '.has-bid')[0].style.animationDelay === '',
     'green rows carry no animation delay (shimmer unaffected)');
  ok(Object.values(JSON.parse(
       dom.window.localStorage.getItem('tauction-mybids:tau')))
       .includes('three tacos'), 'own bid persisted (pid-keyed)');
  ok(doc.getElementById('banner').hidden,
     'no banner for a placed bid: the green card already says it');
  ok(!doc.querySelector('#tiles .check'),
     'no checkmark either: the green card itself is the signal, and the'
     + ' ✅ sat confusingly next to the ×');
  ok(row(doc, 'alice').querySelector('.tu').disabled
     && row(doc, 'alice').querySelector('.tu').classList
          .contains('selected')
     && row(doc, 'alice').querySelector('.tu').getAttribute('data-tip')
          === 'Locked in as you',
     'your bid locks even your own star: still lit, no release');
  ok(row(doc, 'bob').querySelector('.tu').disabled
     && row(doc, 'bob').querySelector('.tu').getAttribute('data-tip')
          === 'Too late to claim as you',
     "and locks everyone else's star: the tip is a pure function of"
     + ' what you see (unpressable, not yours), not of why');
  ok(row(doc, 'alice').querySelector('.x').disabled,
     'the × grays out once a bid is in (a sealed bid is never deletable)');
  ok(row(doc, 'alice').querySelector('.x').getAttribute('data-tip')
       === STR.tooLateRemoveTip('alice')
     && row(doc, 'bob').querySelector('.x').getAttribute('data-tip')
       === STR.removeTip('bob'),
     "the grayed ×'s tip says why: too late to remove (copy derived —"
     + ' dreev recapitalized it mid-flight, the literal broke)');
  ok(!row(doc, 'bob').querySelector('.x').disabled,
     'the bidless row keeps its live ×');
  ok(row(doc, 'alice').querySelector('.x').parentElement
       === row(doc, 'alice'),
     'the × belongs to the whole row, not the bid cell');
  ok(doc.getElementById('seal').disabled
     && !doc.getElementById('seal').classList.contains('ready'),
     'padlock locked while bob is outstanding');
  ok(doc.getElementById('seal').getAttribute('data-tip')
       === STR.waitingTip('bob'),
     'one straggler: named alone, no (you) since he is not');

  /* --- 2b. fresh auction: add yourself, claim, bid — seat uncut --------- */
  const domF = await makePage('/freshie?api=' + API_URL);
  addName(domF, 'zoe');  // the first add self-claims (2j): she is you
  typeBid(domF, 'me first');
  submitBid(domF);
  await settled(domF);
  const zoeRow = tiles(domF.window.document, '.has-bid')[0];
  ok(zoeRow && !zoeRow.classList.contains('cut'),
     'your own fresh-auction bid is never crossed out');
  ok(!domF.window.document.getElementById('status').classList.contains('revealed'),
     'solo bid stays sealed (no instant self-reveal, no latch footgun)');
  ok(domF.window.document.getElementById('seal').disabled,
     'padlock stays locked for a solo bidder');
  ok(domF.window.document.getElementById('seal').getAttribute('data-tip')
       === STR.needOneMoreTip,
     'solo bidder: bidding cannot unlock a roster of one, and the tip'
     + ' says so instead of inventing someone to wait for');

  /* --- 2c. roster edits register instantly and fly SIGNLESS (dreev
     2026-07-28, the no-spinners ruling: a write's feedback is the
     commit pulse and, on failure, the banner — no gray, no gavel,
     nothing to wait on) ---------------------------------------------- */
  const domO = await makePage('/optimist?api=' + API_URL);
  mockDelay = 300;
  addName(domO, 'pam');
  await sleep(30);  // long before the 700ms debounce + 300ms latency
  ok(tiles(domO.window.document).length === 1
     && row(domO.window.document, 'pam'),
     'added person appears in the BIDS box immediately');
  ok(!domO.window.document.querySelector('.stale')
     && !domO.window.document.querySelector('.gavel.mini'),
     'and NOTHING wears a busy sign while the server has not'
     + ' confirmed: no gray, no gavel, anywhere');
  await sleep(2000);
  row(domO.window.document, 'pam').querySelector('.x').click();
  await sleep(30);  // the remove op is still in flight (mockDelay 300)
  ok(tiles(domO.window.document).length === 0,
     'removal empties the row immediately');
  ok(!domO.window.document.querySelector('.stale'),
     'and flies signless too');
  await sleep(600);
  mockDelay = 0;
  await sleep(2000);

  // ×ing your own (bidless) row makes you nobody; re-adding the name
  // re-latches without re-claiming (the latch remembers, the row gates)
  addName(domO, 'pam');  // self-claims (2j): pam is own already
  row(domO.window.document, 'pam').querySelector('.x').click();
  ok(tiles(domO.window.document).length === 0
     && !domO.window.document.querySelector('#tiles .rebid'),
     '×ing your own row removes it and your editor with it');
  addName(domO, 'pam');
  ok(row(domO.window.document, 'pam').classList.contains('mine')
     && myEditor(domO.window.document),
     'adding your remembered name back re-latches automatically');
  await sleep(2000);

  /* --- 2d. rapid roster adds queue: never two ops in flight -------------
     Replicata: add names in rapid succession while the server is slow.
     Expectata: the ops serialize client-side (one write in flight at a
     time — a burst can't pile onto the server's script lock) and every
     name arrives. */
  const domQ = await makePage('/coalesce?api=' + API_URL);
  opsOverlapped = false;
  mockDelay = 700;
  addName(domQ, 'quickone');
  addName(domQ, 'quicktwo');   // enqueued while op 1 is in flight
  addName(domQ, 'quickthree');
  await until(() =>  // three serialized ops drain (~2.1s at 700ms each)
    names(gas.handle({ action: 'state', aname: 'coalesce' }))
    === 'quickone,quicktwo,quickthree');
  mockDelay = 0;
  ok(!opsOverlapped, 'write ops serialize: never two in flight');
  ok(names(gas.handle({ action: 'state', aname: 'coalesce' }))
     === 'quickone,quicktwo,quickthree', 'every added name arrives');
  ok(!domQ.window.document.getElementById('status').classList.contains('stale'),
     'box settles unstale after the queued ops');

  /* --- 2d2. a stale duplicate add converges QUIETLY --------------------
     Replicata: a page loads an empty ledger; another browser seats
     alice; before the stale page polls, it submits alice under its
     own fresh pid. Expectata (dreev 2026-07-21, reversing the 07-20
     loud refusal — "the error seems wrong": alice IS added, exactly
     as requested): the goal state already holds, so the server
     answers idempotent success — the losing row is discarded, the
     winning row adopted, the loser left unseated as an ordinary
     latecomer (the claimable star is the re-attach affordance), and
     NO banner, because nothing failed. Resultata pre-flip: "That
     name is taken" glared over a ledger showing alice, freshly
     added. */
  const dAddRace = await makePage('/addrace?api=' + API_URL);
  const remoteAddPid = 'pid-addrace-remote-alice';
  gas.handle({ action: 'add', aname: 'addrace', uname: 'alice',
    pid: remoteAddPid });
  addName(dAddRace, 'alice');
  const addRaceDoc = dAddRace.window.document;
  await until(() => {
    const r = row(addRaceDoc, 'alice');
    return r && r.dataset.pid === remoteAddPid
      && !addRaceDoc.getElementById('status').classList.contains('stale');
  });
  const addRaceState = gas.handle({ action: 'state', aname: 'addrace' });
  ok(addRaceDoc.getElementById('banner').hidden
     && !row(addRaceDoc, 'alice').classList.contains('mine')
     && addRaceState.seats.length === 1
     && addRaceState.seats[0].pid === remoteAddPid,
     'the stale duplicate converges quietly onto the winning row');

  /* --- 2e. a name you typed must never vanish ----------------------------
     Replicata: add a name after a poll's GET has left but before its
     response lands; wait out the 4s edit shield so the stale response is
     free to overwrite the local roster. Resultata pre-fix: the new row
     vanishes until the add's own push lands (and the ledger flickers).
     Expectata: responses to requests that predate a local write are
     discarded; typed names never disappear. */
  const domV = await makePage('/keepname?api=' + API_URL);
  addName(domV, 'uno');
  await sleep(800);            // push 1 lands; edit shield resets
  mockDelay = 5000;            // now every response is slow
  await sleep(4300);           // t~5100: the 5s poll is in flight with a
                               // roster snapshot that predates...
  addName(domV, 'dos');        // ...this add (its push lands t~10800)
  await sleep(5200);           // t~10300: the stale poll has landed
  mockDelay = 0;
  ok(row(domV.window.document, 'dos'),
     'a freshly added name survives a stale poll landing');
  await sleep(6000);           // pushes and a fresh poll settle
  ok(names(gas.handle({ action: 'state', aname: 'keepname' }))
     === 'uno,dos', 'both names reach the server');

  /* --- 2e2. the wall clock is not a logic input ------------------------
     Replicata: a write settles; the machine's clock then steps BACK
     (NTP does this — wall clocks are not monotonic); someone else's
     edit lands and the next poll fetches it. Resultata pre-fix: the
     adoption gate compared the poll's request TIME to the last
     write's settle TIME, so every post-stepback poll looked older
     than the settle and was rejected — the remote edit stayed
     invisible until the clock caught back up (ten stubbed minutes
     here, so no poll can sneak past inside this qual). Expectata:
     adoption is gated on SEQUENCE, not clocks; the next poll
     adopts. */
  gas.handle({ action: 'add', aname: 'clockstep',
    uname: 'ann', pid: 'pid-clockstep-ann' });
  const dClock = await makePage('/clockstep?api=' + API_URL);
  addName(dClock, 'bee');       // a write, so a settle gets recorded
  await settled(dClock);
  const realNow = dClock.window.Date.now;
  dClock.window.Date.now = () => realNow() - 600000;  // NTP steps back
  gas.handle({ action: 'add', aname: 'clockstep',
    uname: 'cee', pid: 'pid-clockstep-cee' });  // the remote edit
  await until(() => row(dClock.window.document, 'cee') !== null);
  ok(row(dClock.window.document, 'cee') !== null,
     'a backwards clock step cannot freeze snapshot adoption: the'
     + ' next poll still adopts the remote edit');
  dClock.window.Date.now = realNow;

  /* --- 2w. the cold-page double-add must not dead-key --------------------
     Replicata: first-ever visit to an auction URL (no cache to paint)
     on a slow server; type your name, enter. No snapshot has landed,
     so no row can render — nothing visibly happens — and you type the
     name again. Resultata pre-fix: me() dereferenced the null state
     and the keystroke died silently in the listener; the + row was a
     dead key from then on. Expectata: the retype clears quietly (that
     pending name is already you) and one seat lands. */
  mockDelay = 900;
  const dCold2 = await makePage('/coldadd?api=' + API_URL);
  addName(dCold2, 'ann');
  addName(dCold2, 'ann');  // the impatient retype, everything in flight
  ok(dCold2.window.document.getElementById('roster-input').value === ''
     && !dCold2.window.document.getElementById('roster-input')
          .classList.contains('error'),
     'retyping your own cold-pending name clears quietly: no dead key,'
     + ' no objection');
  mockDelay = 0;
  await until(() => names(gas.handle({ action: 'state', aname: 'coldadd' })) === 'ann');
  ok(names(gas.handle({ action: 'state', aname: 'coldadd' }))
       === 'ann'
     && dCold2.window.localStorage.getItem('tauction-uname') === 'ann',
     'one seat, once, when the dust settles — and it is yours');

  /* --- 2h. fix a typo: rename in place -----------------------------------
     Anyone can rename anyone (honor system, like all roster edits) via
     the ✎, which uses window.prompt — no in-place edit state. The seat,
     its claim, and any bid re-key together; a rename made on another
     machine follows your device id home: you stay latched, your bid
     memory migrates. */
  gas.handle({ action: 'add', aname: 'typo',
    uname: 'alicw', pid: 'pid-typo-alicw' });
  gas.handle({ action: 'add', aname: 'typo',
    uname: 'bob', pid: 'pid-typo-bob' });
  const domT2 = await makePage('/typo?api=' + API_URL);
  const docT2 = domT2.window.document;
  ok([...tiles(docT2)].every((t) => t.querySelector('.rename input')
       && !t.querySelector('.rename input').hasAttribute('data-tip')),
     'every name IS a live text field, bid or not, no tooltip needed');
  ok([...tiles(docT2)].every((t) => t.querySelector('.rename input')
       .getAttribute('enterkeyhint') === 'done'),
     "the mobile return key reads Done over a name field");
  const nameInp = row(docT2, 'alicw').querySelector('.rename input');
  ok(nameInp.value === 'alicw', 'the field holds the name');
  nameInp.value = 'wrong';
  nameInp.dispatchEvent(new domT2.window.KeyboardEvent('keydown',
    { key: 'Escape', bubbles: true }));
  ok(nameInp.value === 'alicw', 'escape restores the name, commits nothing');
  nameInp.focus();
  nameInp.value = 'wronger';
  nameInp.dispatchEvent(
    new domT2.window.Event('input', { bubbles: true }));
  nameInp.blur();
  // [dreev flipped this pin THRICE: 07-17 tap-away-saves, 07-27 blur
  // commits nothing anywhere, 07-28 the commit taxonomy — a uname is
  // a cheap clobber-tolerant label, so blur commits IT alone]
  await sleep(80);
  ok(row(docT2, 'wronger') !== null && !row(docT2, 'alicw')
     && nameInp.defaultValue === 'wronger',
     'clicking away COMMITS the rename: cheap label edits are'
     + ' frictionless again');
  await until(() => names(gas.handle({ action: 'state', aname: 'typo' }))
    === 'wronger,bob');
  renameTo(domT2, 'wronger', 'alicw');  // back, for the legs below
  await until(() => names(gas.handle({ action: 'state', aname: 'typo' }))
    === 'alicw,bob');
  renameTo(domT2, 'alicw', 'alice');
  ok(row(docT2, 'alice') && !row(docT2, 'alicw')
     && tiles(docT2)[0].dataset.uname === 'alice',
     'the typo is fixed in place immediately, order kept');
  await until(() => names(gas.handle({ action: 'state', aname: 'typo' })) === 'alice,bob');
  ok(names(gas.handle({ action: 'state', aname: 'typo' }))
     === 'alice,bob', 'the rename reached the server');
  renameTo(domT2, 'alice', 'bob');
  ok(row(docT2, 'alice') && docT2.getElementById('banner').textContent
       .length > 0 && !docT2.getElementById('banner').hidden,
     'renaming onto an existing name: refused loudly, nothing changes');

  // self-rename with a bid in: you stay you, your bid memory follows
  claimRow(domT2, 'alice');
  typeBid(domT2, 'first dibs');
  submitBid(domT2);
  await settled(domT2);
  renameTo(domT2, 'alice', 'alicia');
  await sleep(100);
  ok(row(docT2, 'alicia').classList.contains('mine')
     && myEditor(docT2).value === 'first dibs',
     'renaming yourself keeps you latched, bid and editor intact'
     + ' (nothing to migrate: the pid never moved)');

  // cross-device: machine 2 fixes machine 1's typo; machine 1's identity
  // follows its device id home on the next poll
  gas.handle({ action: 'add', aname: 'xdev',
    uname: 'carow', pid: 'pid-xdev-carow' });
  gas.handle({ action: 'add', aname: 'xdev',
    uname: 'dan', pid: 'pid-xdev-dan' });
  const mA = await makePage('/xdev?api=' + API_URL);
  claimRow(mA, 'carow');
  typeBid(mA, 'a carrot');
  submitBid(mA);
  await sleep(100);
  const mB = await makePage('/xdev?api=' + API_URL);
  renameTo(mB, 'carow', 'carol');
  await sleep(100);
  await sleep(5100);  // machine 1 polls
  ok(row(mA.window.document, 'carol').classList.contains('mine')
     && myEditor(mA.window.document).value === 'a carrot',
     "a rename from another machine changes machine 1's LABEL only:"
     + ' the pid held firm, so identity and bid rode along untouched');

  /* --- 2i. arriving claimed and bidless: the caret waits in your editor
     (Replicata of dreev's pulse bug: load — don't click — a page where
     you're claimed with no bid. Expectata: your editor is a normal
     field with the caret in it, and only not-you rows ever pulse.
     Resultata pre-fix: the editor sat unfocused, pulsing.) ----------- */
  gas.handle({ action: 'add', aname: 'caret',
    uname: 'ann', pid: 'pid-caret-ann' });
  gas.handle({ action: 'add', aname: 'caret',
    uname: 'bee', pid: 'pid-caret-bee' });
  gas.handle({ action: 'claim', aname: 'caret',
    uname: 'ann', pid: 'pid-caret-ann',
               deviceID: 'dev-caret' });
  const seedK = (w) => {
    w.localStorage.setItem('tauction-device', 'dev-caret');
    w.localStorage.setItem('tauction-pids', '{"caret":"pid-caret-ann"}');
  };
  const domK = await makePage('/caret?api=' + API_URL, seedK);
  const docK = domK.window.document;
  ok(docK.activeElement === myEditor(docK),
     'arriving claimed and bidless: the caret is already in your editor');
  // the CACHED paint is an arrival too: with the live fetch still in
  // flight, the caret lands from the cached snapshot (pinned before
  // folding the arrival latches into the one adopted-edge)
  const caretSnap = JSON.stringify(
    gas.handle({ action: 'state', aname: 'caret' }));
  mockDelay = 800;
  const domKc = await makePage('/caret?api=' + API_URL, (w) => {
    seedK(w);
    w.localStorage.setItem('tauction-state:caret', caretSnap);
  });
  ok(domKc.window.document.activeElement
       === myEditor(domKc.window.document),
     'a cache-painted arrival seats the caret before the live fetch'
     + ' even lands');
  mockDelay = 0;
  await settled(domKc);
  myEditor(docK).blur();
  const pollsK = apiCalls.filter((c) => c.action === 'state'
    && c.aname === 'caret').length;
  await until(() => apiCalls.filter((c) => c.action === 'state'
    && c.aname === 'caret').length > pollsK);
  await sleep(100);  // the poll's response lands and renders
  ok(docK.activeElement !== myEditor(docK),
     'focus placement is one-shot: a poll never steals the caret back');
  typeBid(domK, 'ann bid');
  submitBid(domK);
  await settled(domK);
  const domK2 = await makePage('/caret?api=' + API_URL, seedK);
  ok(domK2.window.document.activeElement
       !== myEditor(domK2.window.document),
     'arriving with your bid already in: no auto-focus (nothing owed)');

  /* --- 2j. your first add, on a browser with no memory, adds YOURSELF ---
     (dreev's expectata: "load a new auction, add a name — i've added
     myself".) The + row wears the you-star, so the name typed there
     is yours — locally only: no server claim, so a real person
     claiming that name from their own device still unseats the
     assumption cleanly. Later adds are other people, and a browser
     that already remembers an identity (a facilitator seeding a
     roster) never self-claims at all — story 3 pins that side. */
  const domJ2 = await makePage('/mefirst?api=' + API_URL);
  addName(domJ2, 'dree');
  ok(row(domJ2.window.document, 'dree').classList.contains('mine')
     && row(domJ2.window.document, 'dree').querySelector('.tu')
          .classList.contains('selected'),
     'your first add on a fresh page is you: gold star, no extra click');
  ok(!domJ2.window.document.getElementById('status').classList
       .contains('unclaimed'),
     'the + row hands its you-star to your new row');
  addName(domJ2, 'pal');
  ok(!row(domJ2.window.document, 'pal').classList.contains('mine')
     && row(domJ2.window.document, 'dree').classList.contains('mine'),
     'later adds are other people: the star stays on your row');
  await until(() => names(gas.handle({ action: 'state', aname: 'mefirst' })) === 'dree,pal');
  ok(Object.keys(gas.handle({ action: 'state', aname: 'mefirst' })
       .claims).length === 0,
     'the self-add registers no server claim: a real dree on another'
     + ' device can still claim the seat out from under it');

  /* --- 2p. the auction description: markdown, a corner toggle, and
     compare-and-swap against clobbers (the compact eat-the-richtext:
     one field, source and rendered modes) ------------------------------ */
  gas.handle({ action: 'add', aname: 'descy',
    uname: 'ann', pid: 'pid-descy-ann' });
  const domDs = await makePage('/descy?api=' + API_URL);
  const dsDoc = domDs.window.document;
  ok(dsDoc.getElementById('descedit')
     && !dsDoc.getElementById('desc').classList.contains('viewing')
     && dsDoc.getElementById('descedit').placeholder.length > 0,
     'an undescribed auction opens in edit mode, placeholder explaining');
  dsDoc.getElementById('descedit').value = '# Brunch\n\n**bring** cash';
  dsDoc.getElementById('descedit').dispatchEvent(
    new domDs.window.Event('input', { bubbles: true }));
  ok(!dsDoc.getElementById('desctoggle').hasAttribute('data-tip'),
     'the pencil explains itself by icon: no tooltip [dreev retired'
     + ' his toggle-tip copy 2026-07-17]');
  // SAVE = commit + flip to rendered (dreev revived the button
  // 2026-07-27; clicking away commits nothing, anywhere)
  dsDoc.getElementById('descgo').click();
  await until(() => gas.handle({ action: 'state', aname: 'descy' })
    .blurb === '# Brunch\n\n**bring** cash');
  await until(() => !!dsDoc.querySelector('#descview h1'));
  ok(dsDoc.getElementById('desc').classList.contains('viewing')
     && dsDoc.querySelector('#descview h1').textContent === 'Brunch'
     && dsDoc.querySelector('#descview strong').textContent === 'bring',
     'SAVE commits, and the markdown renders (h1, bold)');
  // the mode flip is gated on having something to show: pencil-only
  // model edge cases (dreev's redesign 2026-07-17)
  dsDoc.getElementById('desctoggle').click();  // pencil: back to edit
  ok(!dsDoc.getElementById('desc').classList.contains('viewing'),
     'the pencil reopens the editor');
  const descOps = () =>
    apiCalls.filter((c) => c.action === 'describe').length;
  const opsBefore = descOps();
  dsDoc.getElementById('descedit').focus();
  dsDoc.getElementById('descedit').dispatchEvent(
    new domDs.window.Event('blur'));
  ok(dsDoc.getElementById('desc').classList.contains('viewing')
     && descOps() === opsBefore,
     'a CLEAN blur just flips back to rendered: nothing to save,'
     + ' nothing sent');
  dsDoc.getElementById('desctoggle').click();
  dsDoc.getElementById('descedit').focus();
  dsDoc.getElementById('descedit').value = '# Brunch\n\nno wait';
  dsDoc.getElementById('descedit').dispatchEvent(
    new domDs.window.Event('input', { bubbles: true }));
  dsDoc.getElementById('descedit').dispatchEvent(
    new domDs.window.KeyboardEvent('keydown',
      { key: 'Escape', bubbles: true }));
  ok(dsDoc.getElementById('descedit').value
       === '# Brunch\n\n**bring** cash'
     && dsDoc.getElementById('desc').classList.contains('viewing')
     && descOps() === opsBefore,
     'Escape abandons the edit: reverted, back to rendered, nothing'
     + ' sent');
  const domBk = await makePage('/blank?api=' + API_URL);
  await sleep(20);
  domBk.window.document.getElementById('descedit').focus();
  domBk.window.document.getElementById('descedit').dispatchEvent(
    new domBk.window.Event('blur'));
  ok(!domBk.window.document.getElementById('desc').classList
       .contains('viewing'),
     'a clean blur of a BLANK blurb stays in edit mode: flipping'
     + ' would trade the placeholder for an invisible empty pane');

  /* code spans are LITERAL. Replicata: describe an auction with
     backticked text containing markdown syntax. Resultata pre-fix:
     the bold/italic/link passes ran over the <code> contents the
     code pass had just emitted, so `a*b*c` rendered with live
     italics inside the code span. Expectata: what's in backticks
     comes out verbatim — while code can still LABEL a link, and
     emphasis outside code still works. */
  gas.handle({ action: 'describe', aname: 'codespan', base: '',
    blurb: 'ecce `a*b*c` et `**x**` et [`y`](https://e.com) et *z*' });
  gas.handle({ action: 'add', aname: 'codespan',
    uname: 'c', pid: 'pid-codespan-c' });
  const domCs = await makePage('/codespan?api=' + API_URL);
  const csDoc = domCs.window.document;
  const codeEls = [...csDoc.querySelectorAll('#descview code')];
  ok(codeEls.length === 3
     && codeEls[0].textContent === 'a*b*c'
     && codeEls[1].textContent === '**x**'
     && !csDoc.querySelector('#descview code em')
     && !csDoc.querySelector('#descview code strong'),
     'code spans are literal: stars inside backticks never'
     + ' italicize or bold');
  ok(csDoc.querySelector('#descview a code')
     && csDoc.querySelector('#descview a').textContent === 'y',
     'a code span can still label a link');
  ok(csDoc.querySelector('#descview em')
     && csDoc.querySelector('#descview em').textContent === 'z',
     'emphasis outside the backticks still works');

  // hostile markdown renders inert (escape-first, whitelisted links)
  gas.handle({ action: 'describe', aname: 'evil', base: '',
    blurb: '<script>window.pwned=1</script>\n\n'
      + '[x](javascript:alert(1)) <img src=x onerror=alert(1)>' });
  gas.handle({ action: 'add', aname: 'evil',
    uname: 'e', pid: 'pid-evil-e' });
  const domEv = await makePage('/evil?api=' + API_URL);
  const evDoc = domEv.window.document;
  ok(evDoc.getElementById('desc').classList.contains('viewing'),
     'an existing description arrives rendered');
  ok(!evDoc.querySelector('#descview script')
     && !evDoc.querySelector('#descview img')
     && !evDoc.querySelector('#descview a')
     && evDoc.getElementById('descview').textContent
          .includes('<script>'),
     'hostile markdown is inert: tags mere text, javascript: links'
     + ' never become links at all');

  /* --- 2p4. the mdRender fuzz battery ----------------------------------
     500 deterministic rounds of adversarial markdown soup (seeded, so
     a failure is a permanent replicata: the label prints the exact
     input). The renderer's promises, held under fire: it never
     throws, it's a pure function, only whitelisted tags materialize,
     attributes appear only on <a> (href http(s)-only), the code-stash
     placeholder neither leaks nor can be counterfeited, and code
     spans admit no markup. The soup leans into collisions: half-open
     syntax, nested markers, hostile HTML, and a forged <<0>>. */
  const domMd = await makePage('/?api=' + API_URL);
  // the app's eval scope is sealed ('use strict'), so re-eval the
  // same sources with mdRender as the completion value; the duplicate
  // init() idles harmlessly on this throwaway unnamed page
  const mdRender = domMd.window.eval(
    STRINGLES + '\n;\n' + APP_JS + '\n;mdRender');
  const mdProbe = domMd.window.document.createElement('div');
  const MD_TAGS = ['P', 'BR', 'H1', 'H2', 'H3', 'HR', 'UL', 'OL', 'LI',
                   'BLOCKQUOTE', 'CODE', 'STRONG', 'EM', 'A'];
  // (the whole-link tokens are load-bearing: random shards of [ ] ( )
  // essentially never assemble a valid link, so without them the <a>
  // invariants sat unexercised — caught by the coverage floor below)
  const MD_SOUP = ['`', '*', '**', '[', ']', '(', ')', '# ', '## ',
    '### ', '[t](https://e.co/x)', '[`t`](https://e.co/x)',
    '- ', '1. ', '> ', '---', '\n', '\n\n', ' ', 'tau',
    'https://e.co/p?a=1&b=2', '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>', '](javascript:alert(1))', '"',
    '&amp;', '&', '<<0>>', '\\', '_', '\u{1f4b8}'];
  // mulberry32: tiny, seeded, deterministic — the same soup every run
  let mdSeed = 0x5eed;
  const mdRand = () => {
    mdSeed = mdSeed + 0x6d2b79f5 | 0;
    let t = Math.imul(mdSeed ^ mdSeed >>> 15, 1 | mdSeed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  const mdSins = {};  // broken promise -> the first input that broke it
  const sin = (label, input) => {
    if (mdSins[label] === undefined) mdSins[label] = input;
  };
  const mdSeen = {};  // tag -> times materialized (the vacuity guard)
  for (let i = 0; i < 500; i++) {
    let input = '';
    const n = 1 + Math.floor(mdRand() * 30);
    for (let j = 0; j < n; j++) {
      input += MD_SOUP[Math.floor(mdRand() * MD_SOUP.length)];
    }
    let html;
    try { html = mdRender(input); } catch (e) { sin('throws', input); }
    if (html === undefined) continue;
    if (typeof html !== 'string') { sin('non-string', input); continue; }
    if (html !== mdRender(input)) sin('impure', input);
    if (/<<\d+>>/.test(html)) sin('placeholder leak', input);
    mdProbe.innerHTML = html;
    for (const el of mdProbe.querySelectorAll('*')) {
      mdSeen[el.tagName] = (mdSeen[el.tagName] || 0) + 1;
      if (!MD_TAGS.includes(el.tagName)) {
        sin('tag off the whitelist (' + el.tagName + ')', input);
      }
      const attrs = el.getAttributeNames().sort().join();
      if (attrs !== (el.tagName === 'A' ? 'href,rel,target' : '')) {
        sin('attribute off the whitelist (' + attrs + ')', input);
      }
      if (el.tagName === 'A'
          && !/^https?:\/\//.test(el.getAttribute('href'))) {
        sin('non-http(s) href', input);
      }
    }
    for (const code of mdProbe.querySelectorAll('code')) {
      // (a <br> may ride inside: line joins precede the inline pass)
      if ([...code.querySelectorAll('*')]
            .some((e) => e.tagName !== 'BR')) {
        sin('markup inside a code span', input);
      }
    }
  }
  mdProbe.innerHTML = '';  // leave no fuzz behind
  ok(Object.keys(mdSins).length === 0,
     'the fuzz battery: 500 rounds of markdown soup keep every promise'
       + Object.entries(mdSins).map(([k, v]) =>
           '; BROKEN, ' + k + ', by input ' + JSON.stringify(v)).join(''));
  // a battery with no coverage passes vacuously: every whitelisted
  // tag must actually have materialized under fire (deterministic
  // soup, so this can never flake — only rot, loudly)
  ok(MD_TAGS.every((t) => mdSeen[t] > 0),
     'the soup exercises every whitelisted tag, sat: '
       + JSON.stringify(mdSeen));
  // the clobber dance: two windows, one description
  const dA = await makePage('/descy?api=' + API_URL);
  const dB = await makePage('/descy?api=' + API_URL);
  dA.window.document.getElementById('desctoggle').click();  // to edit
  dA.window.document.getElementById('descedit').value = 'A version';
  dA.window.document.getElementById('descedit').dispatchEvent(
    new dA.window.Event('input', { bubbles: true }));
  dA.window.document.getElementById('descgo').click();  // SAVE
  await until(() => gas.handle({ action: 'state', aname: 'descy' })
    .blurb === 'A version');
  dB.window.document.getElementById('desctoggle').click();  // stale base
  dB.window.document.getElementById('descedit').value = 'B version';
  dB.window.document.getElementById('descedit').dispatchEvent(
    new dB.window.Event('input', { bubbles: true }));
  dB.window.document.getElementById('descgo').click();  // SAVE, stale
  // ...and B moves on: clicks into the + row and starts thinking
  dB.window.document.getElementById('roster-input').focus();
  await until(() =>
    !dB.window.document.getElementById('banner').hidden);
  ok(dB.window.document.getElementById('banner').textContent
       .includes(SCOPY.simulEditsCopy),
     "the clobber bounces off the compare-and-swap, loudly, in dreev's"
     + ' words');
  ok(STR.mysteryDevice === SCOPY.mysteryDeviceCopy,
     'stringles.js and Code.gs agree verbatim on the nameless-rig'
     + " fallback (both ends decorate tooltips with the holder's rig)");
  ok(STR.nameTakenBanner === SCOPY.nameTakenCopy,
     'stringles.js and Code.gs agree verbatim on the name-taken copy'
     + ' (the client pre-check and the server refusal must read as one'
     + ' message)');
  ok(STR.bidTooLongBanner === SCOPY.bidTooLongCopy,
     'stringles.js and Code.gs agree verbatim on the bid-too-long copy'
     + ' (the client refuses before the wire; the server clamps the'
     + ' races and the hand-rolled requests)');
  ok(STR.anameTooLongBanner === SCOPY.anameTooLongCopy
     && STR.unameTooLongBanner === SCOPY.unameTooLongCopy
     && STR.blurbTooLongBanner === SCOPY.blurbTooLongCopy,
     'stringles.js and Code.gs agree verbatim on all three too-long'
     + ' copies (same pattern as the bid: local refusal and server'
     + ' backstop read as one message)');

  /* --- 2q. BLUR COMMITS NOTHING, anywhere (dreev 2026-07-27) ----------
     Cletus's clobber, verbatim from the bug report: winifred and
     cletus edit the blurb at once; winifred's save lands; cletus gets
     the simultaneous-edits banner (so far so good), copies his draft
     somewhere safe, ×es the banner — a CLICK, which blurs his editor —
     and reloads to go read winifred's version. Expectata: blur is not
     a gesture, so nothing is written; winifred's words stand and the
     reload shows them; cletus's draft needs a deliberate SAVE to
     insist. Resultata (pre-fix): the ×'s blur committed cletus's
     silently re-based draft — the clobbered became the clobberer and
     nobody ever saw winifred's words. ------------------------------ */
  const cw = await makePage('/clob?api=' + API_URL);
  const cwEd = cw.window.document.getElementById('descedit');
  cwEd.focus();
  cwEd.value = 'per cletus';
  cwEd.dispatchEvent(new cw.window.Event('input', { bubbles: true }));
  // winifred's save lands from her own machine...
  gas.handle({ action: 'describe', aname: 'clob', blurb: 'per winifred',
    base: gas.handle({ action: 'state', aname: 'clob' }).tblurb });
  // ...and the next poll says NOTHING to cletus (dreev 2026-07-28,
  // the mid-air-collision convention: conflicts surface at SAVE,
  // never mid-composition) — wait for her words to be ingested (the
  // chronicle narrates the change), then check the calm
  await until(() => cw.window.__logs.some((l) => typeof l === 'string'
    && l.includes('\u270e description')));
  ok(cw.window.document.getElementById('banner').hidden,
     "winifred's edit landing under cletus's open draft warns nobody");
  const cwWrites = () =>
    apiCalls.filter((r) => r.action === 'describe').length;
  const cwBefore = cwWrites();
  // a click anywhere else blurs the editor
  // (jsdom moves no focus on click, so the focus loss is explicit)
  cwEd.blur();
  await sleep(150);  // an outbound write would be in apiCalls by now
  ok(cwWrites() === cwBefore,
     'the blur writes NOTHING: blur is not a gesture');
  ok(gas.handle({ action: 'state', aname: 'clob' }).blurb
       === 'per winifred',
     "winifred's words stand on the sheet");
  ok(cwEd.value === 'per cletus',
     "cletus's draft stays his own business, visibly unsaved");
  ok(cw.window.document.getElementById('desc').classList.contains('hot'),
     'the desc card is HOT (an uncommitted draft): its SAVE stands');
  ok(cw.window.document.querySelector('#desc .go').textContent
       === STR.saveCopy,
     "the blurb's commit button wears dreev's copy: SAVE");
  // the reload that used to arrive too late now just shows him
  // winifred's version (his draft died with the page, as drafts do)
  const cw2 = await makePage('/clob?api=' + API_URL);
  await until(() => cw2.window.document.getElementById('descedit').value
    === 'per winifred');
  ok(cw2.window.document.getElementById('descedit').value
       === 'per winifred',
     'the reload shows cletus what winifred actually wrote');
  // ...and cletus's own SAVE is where the collision surfaces:
  // refused by the compare-and-swap in the server's words, his
  // draft kept red and copyable, winifred's words standing
  cw.window.document.querySelector('#desc .go').click();
  await until(() =>
    !cw.window.document.getElementById('banner').hidden);
  ok(cw.window.document.getElementById('banner-msg').textContent
       === SCOPY.simulEditsCopy
     && cwEd.value === 'per cletus'
     && cwEd.classList.contains('error')
     && gas.handle({ action: 'state', aname: 'clob' }).blurb
          === 'per winifred',
     'his save bounces off the compare-and-swap: refused in the'
     + " server's words, draft red for copying, her words standing");

  // The same law for the bid editor: clicking away sends nothing
  const nb = await makePage('/noblur?api=' + API_URL);
  addName(nb, 'bea');  // self-add: the fresh row is yours, editor live
  await until(() =>
    nb.window.document.querySelector('#tiles .rebid textarea') !== null);
  const nbEd = nb.window.document.querySelector('#tiles .rebid textarea');
  nbEd.focus();
  nbEd.value = '42';
  nbEd.dispatchEvent(new nb.window.Event('input', { bubbles: true }));
  const nbBids = () => apiCalls.filter((r) => r.action === 'bid').length;
  const nbBefore = nbBids();
  nbEd.blur();
  await sleep(150);
  ok(nbBids() === nbBefore,
     'clicking away from a typed bid sends nothing');
  ok(nbEd.value === '42' && nb.window.document
       .querySelector('#tiles .rebid').classList.contains('hot'),
     'the unsent bid stays put, its field hot');
  ok(nb.window.document.querySelector('#tiles .rebid .go').textContent
       === STR.submitCopy,
     "the bid's commit button wears dreev's copy: SUBMIT");
  nb.window.document.querySelector('#tiles .rebid').dispatchEvent(
    new nb.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => gas.handle({ action: 'state', aname: 'noblur' })
    .bidders.length === 1);
  ok(gas.handle({ action: 'state', aname: 'noblur' })
       .bidders.length === 1, 'SUBMIT (or Enter) still commits');
  await until(() => !nb.window.document
    .querySelector('#tiles .rebid').classList.contains('hot'));
  ok(!nb.window.document.querySelector('#tiles .rebid')
       .classList.contains('hot'),
     'settled and left: the field cools and its button stands down');

  // ...but the RENAME field commits on blur (dreev 2026-07-28, the
  // commit taxonomy: a uname is a cheap idempotent label edit —
  // clobber-tolerant, trivially redone — so it gets save-on-blur
  // frictionlessness; bids, the blurb, and the auction name keep
  // their deliberate gestures, and the + row keeps its explicit
  // commit because a stray blur must not MINT a seat)
  const nbRow = row(nb.window.document, 'bea');
  const nbName = nbRow.querySelector('.rename input');
  nbName.focus();
  nbName.value = 'beatrix';
  nbName.dispatchEvent(new nb.window.Event('input', { bubbles: true }));
  nbName.blur();
  ok(nbName.defaultValue === 'beatrix',
     'clicking away from an edited name COMMITS it: the baseline'
     + ' follows the label at once');
  ok(!nbRow.querySelector('.rename .go'),
     'no SAVE stands on a blur-committing field: the button retired'
     + ' with the friction');
  await until(() => gas.handle({ action: 'state', aname: 'noblur' })
    .seats.some((s) => s.uname === 'beatrix'));
  ok(gas.handle({ action: 'state', aname: 'noblur' })
       .seats.some((s) => s.uname === 'beatrix'),
     'Enter/SAVE still renames');

  // ...and the + row: a tapped-away name is NOT added — it waits in
  // the field with its SAVE (the hallway fumble is answered by the
  // visible button now, not by a hidden write)
  const nbAdds = () => apiCalls.filter((r) => r.action === 'add').length;
  const nbAddsBefore = nbAdds();
  const nbPlus = nb.window.document.getElementById('roster-input');
  nbPlus.focus();
  type(nb, 'roster-input', 'carol');
  nbPlus.blur();
  await sleep(150);
  ok(nbAdds() === nbAddsBefore && nbPlus.value === 'carol',
     'a tapped-away + row adds nobody; the name and its SAVE wait');
  ok(nbPlus.closest('.fieldcol').classList.contains('hot'),
     "the + row is hot while it holds an uncommitted name");
  submitName(nb);
  await until(() => row(nb.window.document, 'carol') !== null);
  ok(row(nb.window.document, 'carol') !== null,
     'Enter (or SAVE) still adds');

  // Escape stays the universal never-mind: revert, leave, cool
  nbPlus.focus();
  type(nb, 'roster-input', 'dave');
  nbPlus.dispatchEvent(new nb.window.KeyboardEvent('keydown',
    { key: 'Escape', bubbles: true, cancelable: true }));
  ok(nbPlus.value === '' &&
       !nbPlus.closest('.fieldcol').classList.contains('hot'),
     'Escape reverts and cools the field: no button left standing');

  // At the gavel, a half-typed revision just STAYS — no phantom
  // auto-submit riding the disable's blur (that magic died with
  // blur-commits): the draft sits in the frozen editor, its SUBMIT
  // grayed and saying why, and the sheet keeps the pre-gavel bid
  nbEd.focus();
  nbEd.value = '43';
  nbEd.dispatchEvent(new nb.window.Event('input', { bubbles: true }));
  gas.handle({ action: 'add', aname: 'noblur', uname: 'zed',
    pid: 'pid-nb-zed' });
  gas.handle({ action: 'bid', aname: 'noblur', pid: 'pid-nb-zed',
    bid: '7', uname: 'zed' });
  gas.handle({ action: 'reveal', aname: 'noblur' });
  await until(() =>
    nb.window.document.body.classList.contains('revealed'));
  ok(nb.window.document.body.classList.contains('revealed'),
     'the page itself changes weather at the close (body.revealed'
     + ' drives the closed tint)');
  ok(nbEd.disabled && nbEd.value === '43',
     'a half-typed revision at the gavel stays put, unsent');
  const nbGo = nb.window.document.querySelector('#tiles .rebid .go');
  ok(nbGo.disabled
       && nbGo.getAttribute('data-tip') === STR.tooLateGoTip,
     'its SUBMIT grays with the editor and its tip says why');
  const nbFinal = gas.handle({ action: 'state', aname: 'noblur' });
  const nbBeaPid =
    nbFinal.seats.find((s) => s.uname === 'beatrix').pid;
  ok(nbFinal.bids.some((b) => b.pid === nbBeaPid && b.bid === '42'),
     "the sheet keeps the pre-gavel bid — the dead draft never went");
  ok(nbFinal.bids.some((b) => b.pid === 'pid-nb-zed'),
     'sanity: the reveal actually landed');

  /* --- 2q2. drafts survive the tab (dreev 2026-07-27) -----------------
     Replicata: start typing a bid, close the tab, come back to the
     auction's URL. Expectata: the draft is right there — hot, its
     button standing — because every uncommitted field lives in
     tauction-drafts:<aname> (this browser only, like tauction-mybids)
     until committed or Escaped. */
  gas.handle({ action: 'add', aname: 'draftkeep', uname: 'lou',
    pid: 'pid-dk-lou' });
  const dk1 = await makePage('/draftkeep?api=' + API_URL);
  addName(dk1, 'kim');  // self-claims (2j)
  await settled(dk1);
  const kimPid = JSON.parse(
    dk1.window.localStorage.getItem('tauction-pids')).draftkeep;
  const dk1ed = myEditor(dk1.window.document);
  dk1ed.value = 'half a tho';
  dk1ed.dispatchEvent(new dk1.window.Event('input', { bubbles: true }));
  type(dk1, 'descedit', 'work in prog');  // the one field whose draft
                                          // deliberately DIES with the
                                          // tab (2026-07-28)
  type(dk1, 'roster-input', 'mel');
  const dk1drafts = JSON.parse(
    dk1.window.localStorage.getItem('tauction-drafts:draftkeep'));
  ok(dk1drafts.bid === 'half a tho'
     && !('blurb' in dk1drafts)
     && !('rename:pid-dk-lou' in dk1drafts)
     && dk1drafts.addrow === 'mel',
     'every keystroke of a surviving draft is already in'
     + ' tauction-drafts, keyed by slot — and neither the shared'
     + ' blurb (its ghosts read as mid-air collisions) nor renames'
     + ' (they blur-commit; nothing uncommitted outlives focus) are'
     + ' among them (2026-07-28)');
  // the tab closes; the same browser returns to the URL
  const dk1keys = {};
  for (let i = 0; i < dk1.window.localStorage.length; i++) {
    const k = dk1.window.localStorage.key(i);
    dk1keys[k] = dk1.window.localStorage.getItem(k);
  }
  const dk2 = await makePage('/draftkeep?api=' + API_URL, (w) => {
    Object.entries(dk1keys).forEach(([k, v]) =>
      w.localStorage.setItem(k, v));
  });
  await until(() => myEditor(dk2.window.document)
    && myEditor(dk2.window.document).value === 'half a tho');
  const dk2ed = myEditor(dk2.window.document);
  ok(dk2ed.value === 'half a tho' && dk2ed.defaultValue === ''
     && dk2ed.closest('.rebid').classList.contains('hot')
     && dk2.window.document.getElementById('descedit').value === ''
     && dk2.window.document.getElementById('roster-input').value
          === 'mel'
     && row(dk2.window.document, 'lou').querySelector('.rename input')
          .value === 'lou'
     && dk2.window.document.getElementById('banner').hidden,
     'the returning tab holds the surviving drafts — hot, buttons'
     + ' standing — while the blurb editor and the names show the'
     + ' database, no ghosts and no alarm');
  submitBid(dk2);
  await settled(dk2);
  await until(() => !('bid' in JSON.parse(
    dk2.window.localStorage.getItem('tauction-drafts:draftkeep'))));
  ok(!('bid' in JSON.parse(
      dk2.window.localStorage.getItem('tauction-drafts:draftkeep'))),
     'a committed bid leaves the draft store: only unsubmitted words'
     + ' persist');
  const dk2lou = row(dk2.window.document, 'lou')
    .querySelector('.rename input');
  dk2lou.focus();
  dk2lou.dispatchEvent(new dk2.window.KeyboardEvent('keydown',
    { key: 'Escape', bubbles: true, cancelable: true }));
  ok(dk2lou.value === 'lou'
     && JSON.parse(dk2.window.localStorage
          .getItem('tauction-drafts:draftkeep'))['rename:pid-dk-lou']
        === undefined,
     'Escape is still never-mind: the draft dies in storage too');

  /* --- 2q3. every limit OBJECTS, never chops (dreev 2026-07-27:
     20 characters for both name kinds; the bid's no-clamp ruling
     goes universal) — keystrokes always land, the field reddens
     live, and the commit is refused before the wire in the server's
     exact words, the draft kept for trimming. ---------------------- */
  const LONGA = 'a'.repeat(21);
  const dLim = await makePage('/?api=' + API_URL);
  const limDoc = dLim.window.document;
  type(dLim, 'aname', LONGA);
  ok(limDoc.getElementById('aname').value === LONGA
     && limDoc.getElementById('aname').classList.contains('error'),
     'all 21 characters of an overlong auction name land, ringed red');
  const limProbes = () => apiCalls.filter((c) =>
    c.aname === LONGA).length;
  commitName(dLim);
  await sleep(80);
  ok(dLim.window.location.pathname === '/'
     && !limDoc.getElementById('banner').hidden
     && limDoc.getElementById('banner').textContent
          .includes(STR.anameTooLongBanner)
     && limProbes() === 0,
     "enter on it is refused before the wire, in the server's words");
  type(dLim, 'aname', 'a'.repeat(20));
  ok(!limDoc.getElementById('aname').classList.contains('error'),
     'trimmed to 20, the objection withdraws live');
  commitName(dLim);
  await until(() => dLim.window.location.pathname !== '/');
  ok(dLim.window.location.pathname === '/' + 'a'.repeat(20),
     'a 20-character auction name commits: the boundary is exact');

  const dLim2 = await makePage('/limits?api=' + API_URL);
  await sleep(20);
  const lim2Doc = dLim2.window.document;
  type(dLim2, 'roster-input', LONGA);
  ok(lim2Doc.getElementById('roster-input').value === LONGA
     && lim2Doc.getElementById('roster-input').classList
          .contains('error'),
     'an overlong participant name lands whole, ringed red live');
  const limAdds = () => apiCalls.filter((c) => c.action === 'add'
    && c.aname === 'limits').length;
  const limAdds0 = limAdds();
  submitName(dLim2);
  await sleep(80);
  ok(limAdds() === limAdds0
     && lim2Doc.getElementById('roster-input').value === LONGA
     && lim2Doc.getElementById('banner').textContent
          .includes(STR.unameTooLongBanner),
     "enter is refused before the wire, in the server's words, text"
     + ' kept for trimming');
  type(dLim2, 'roster-input', 'a'.repeat(20));
  ok(!lim2Doc.getElementById('roster-input').classList
       .contains('error'), 'at 20 the ring withdraws');
  submitName(dLim2);
  await until(() => row(lim2Doc, 'a'.repeat(20)) !== null);
  ok(row(lim2Doc, 'a'.repeat(20)) !== null,
     'a 20-character participant name commits');
  const limName = row(lim2Doc, 'a'.repeat(20))
    .querySelector('.rename input');
  limName.focus();
  limName.value = 'b'.repeat(21);
  limName.dispatchEvent(new dLim2.window.Event('input',
    { bubbles: true }));
  ok(limName.value === 'b'.repeat(21)
     && limName.classList.contains('error'),
     'an overlong RENAME draft also lands whole, ringed live');
  const limRens = () => apiCalls.filter((c) =>
    c.action === 'rename').length;
  const limRens0 = limRens();
  limName.form.dispatchEvent(new dLim2.window.Event('submit',
    { bubbles: true, cancelable: true }));
  await sleep(80);
  ok(limRens() === limRens0 && limName.value === 'b'.repeat(21)
     && lim2Doc.getElementById('banner').textContent
          .includes(STR.unameTooLongBanner),
     'the rename is refused before the wire, in the same words');
  limName.dispatchEvent(new dLim2.window.KeyboardEvent('keydown',
    { key: 'Escape', bubbles: true, cancelable: true }));
  const bigBlurb = 'x'.repeat(2001);
  lim2Doc.getElementById('descedit').value = bigBlurb;
  lim2Doc.getElementById('descedit').dispatchEvent(
    new dLim2.window.Event('input', { bubbles: true }));
  lim2Doc.getElementById('descedit').dispatchEvent(
    new dLim2.window.Event('input', { bubbles: true }));
  ok(lim2Doc.getElementById('descedit').value.length === 2001
     && lim2Doc.getElementById('descedit').classList.contains('error'),
     'all 2001 blurb characters land (the silent maxlength clamp is'
     + ' dead), ringed red live');
  const limDescs = () => apiCalls.filter((c) =>
    c.action === 'describe').length;
  const limDescs0 = limDescs();
  lim2Doc.getElementById('descgo').click();
  await sleep(80);
  ok(limDescs() === limDescs0
     && lim2Doc.getElementById('descedit').value === bigBlurb
     && !lim2Doc.getElementById('desc').classList.contains('viewing')
     && lim2Doc.getElementById('banner').textContent
          .includes(STR.blurbTooLongBanner),
     "SAVE is refused before the wire in the server's words; the"
     + ' draft stays in the open editor');
  // Cmd/Ctrl+Enter commits the blurb from the keyboard (the textarea
  // convention; plain Enter stays a newline)
  lim2Doc.getElementById('descedit').value = 'shipshape';
  lim2Doc.getElementById('descedit').dispatchEvent(
    new dLim2.window.Event('input', { bubbles: true }));
  lim2Doc.getElementById('descedit').dispatchEvent(
    new dLim2.window.Event('input', { bubbles: true }));
  lim2Doc.getElementById('descedit').dispatchEvent(
    new dLim2.window.KeyboardEvent('keydown',
      { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
  await until(() => gas.handle({ action: 'state', aname: 'limits' })
    .blurb === 'shipshape');
  ok(gas.handle({ action: 'state', aname: 'limits' })
       .blurb === 'shipshape'
     && lim2Doc.getElementById('desc').classList.contains('viewing'),
     'Cmd/Ctrl+Enter commits the blurb from the keyboard');

  /* --- 2q4. the auction name wears its button too (dreev, after
     finding it buttonless: the ONE irreversible field must show its
     commit, not hide it behind an invisible Enter) ----------------- */
  const dCrea = await makePage('/?api=' + API_URL);
  const creaDoc = dCrea.window.document;
  ok(creaDoc.activeElement === creaDoc.getElementById('aname')
     && creaDoc.getElementById('namego').disabled
     && creaDoc.getElementById('namego').textContent === STR.startCopy(''),
     'the landing page parks the caret in the name field (the'
     + " arrival-caret law) beside its one visible action, in dreev's"
     + ' copy, grayed until there is a name to commit');
  ok(creaDoc.getElementById('share').disabled
     && !creaDoc.getElementById('help').disabled,
     'unnamed: share is a link to nowhere, disabled; help stays live');
  type(dCrea, 'aname', 'poker');
  ok(!creaDoc.getElementById('namego').disabled
     && creaDoc.querySelector('.field').classList.contains('hot')
     && creaDoc.getElementById('namego').textContent
          === STR.startCopy('poker'),
     'the first typed characters arm it — and the label narrates the'
     + ' deed, live: the typed name rides in the button copy');
  creaDoc.getElementById('namego').click();
  await until(() => dCrea.window.location.pathname === '/poker');
  // disabling a focused field blurs it in real Chrome but not in
  // jsdom (the long-known gap, and jsdom won't blur() a disabled
  // element either) — moving focus on models the browser truth
  creaDoc.getElementById('roster-input').focus();
  /* Replicata (dreev 2026-07-28: "you click a button, it becomes
     disabled while it's processing" — the standard double-submit
     guard): Start is the one button gated on a real round-trip (the
     name probe). Expectata: disabled the moment it's pressed, until
     the probe settles; a double-click fires ONE probe. Resultata
     pre-fix: armed throughout — a double-click double-probed. */
  const dBusyGo = await makePage('/?api=' + API_URL);
  const busyDoc = dBusyGo.window.document;
  type(dBusyGo, 'aname', 'busygo');
  mockDelay = 300;
  const busyProbes = () => apiCalls.filter((c) => c.action === 'state'
    && c.aname === 'busygo').length;
  busyDoc.getElementById('namego').click();
  busyDoc.getElementById('namego').click();  // the double-click
  ok(busyDoc.getElementById('namego').disabled,
     'Start disables the moment it is pressed: processing');
  await until(() => dBusyGo.window.location.pathname === '/busygo');
  mockDelay = 0;
  ok(busyProbes() === 1,
     'the double-click fired ONE probe: the disable is the guard');
  /* ...and the KEYBOARD path honors the same guard (Sol's audit #8:
     Enter bypassed the disabled button and double-probed) */
  const dEnterGo = await makePage('/?api=' + API_URL);
  type(dEnterGo, 'aname', 'entergo');
  mockDelay = 300;
  const enterProbes = () => apiCalls.filter((c) => c.action === 'state'
    && c.aname === 'entergo').length;
  commitName(dEnterGo);
  commitName(dEnterGo);  // the double-Enter
  await until(() => dEnterGo.window.location.pathname === '/entergo');
  mockDelay = 0;
  ok(enterProbes() === 1,
     'double-Enter likewise fires ONE probe: processing gates the'
     + ' gesture, not just the button');
  /* ...and the SAME convention's fences on the optimistic buttons,
     where instant retirement plays the disable's role: a double
     press sends ONE write. */
  gas.handle({ action: 'describe', aname: 'dblsave', base: '',
    blurb: '' });
  const dDbl = await makePage('/dblsave?api=' + API_URL);
  const dblDoc = dDbl.window.document;
  dblDoc.getElementById('descedit').value = 'once';
  dblDoc.getElementById('descedit').dispatchEvent(
    new dDbl.window.Event('input', { bubbles: true }));
  dblDoc.getElementById('descgo').click();
  dblDoc.getElementById('descgo').click();  // the double-click
  await until(() => gas.handle({ action: 'state', aname: 'dblsave' })
    .blurb === 'once');
  ok(apiCalls.filter((c) => c.action === 'describe'
       && c.aname === 'dblsave').length === 1,
     'a double-pressed blurb SAVE sends one write: the field went'
     + ' clean at the first press and a clean commit is a no-op');

  ok(dCrea.window.location.pathname === '/poker'
     && creaDoc.getElementById('aname').disabled
     && !creaDoc.getElementById('share').disabled
     && !creaDoc.querySelector('.field').classList.contains('hot'),
     'pressing it commits exactly like Enter: the auction exists,'
     + ' the name is stone, the button stands down, share wakes');

  /* --- 2p2. a rename that loses the race reddens the FIELD ------------
     Replicata: the local roster is a poll behind — someone else just
     added zed — and you rename bob to zed. The client's own dupe guard
     can't know, the server refuses. Expectata: the banner plus the
     name field itself turning red (cleared on input), same recipe as
     every other field objection. --------------------------------- */
  gas.handle({ action: 'add', aname: 'renrace',
    uname: 'alice', pid: 'pid-renrace-alice' });
  gas.handle({ action: 'add', aname: 'renrace',
    uname: 'bob', pid: 'pid-renrace-bob' });
  const dR = await makePage('/renrace?api=' + API_URL);
  await sleep(20);
  gas.handle({ action: 'add', aname: 'renrace',
    uname: 'zed', pid: 'pid-renrace-zed' });
  const bobName = dR.window.document
    .querySelector('.tile[data-uname="bob"] .rename input');
  bobName.value = 'zed';
  bobName.form.dispatchEvent(
    new dR.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => !dR.window.document.getElementById('banner').hidden);
  const recoveredBobName = dR.window.document
    .querySelector('.tile[data-uname="bob"] .rename input');
  ok(dR.window.document.getElementById('banner').textContent
       .includes(SCOPY.nameTakenCopy)
     && recoveredBobName.classList.contains('error')
     && recoveredBobName.isConnected,
     'the lost rename race: banner in the server\'s words AND the name'
     + ' field itself red — the problem localized');
  recoveredBobName.dispatchEvent(
    new dR.window.Event('input', { bubbles: true }));
  ok(!recoveredBobName.classList.contains('error'),
     'the red clears at the next keystroke');

  /* --- 2p2a. a refused self-rename cannot move identity ---------------
     Replicata: this browser is alice; before its next poll, someone
     adds zed and alice renames herself to zed. Expectata: the stale
     collision refuses loudly; identity and bid memory are untouched
     BY CONSTRUCTION (they key on the pid, which no rename request
     ever changes) — the field reddens with the text kept, and zed's
     row is never claimed. */
  gas.handle({ action: 'add', aname: 'selfrenrace',
    uname: 'alice', pid: 'pid-selfrenrace-alice' });
  gas.handle({ action: 'add', aname: 'selfrenrace',
    uname: 'bob', pid: 'pid-selfrenrace-bob' });
  const selfBids = '{"pid-selfrenrace-alice":"alice draft"}';
  const dSelfRen = await makePage('/selfrenrace?api=' + API_URL, (w) => {
    w.localStorage.setItem('tauction-pids',
      '{"selfrenrace":"pid-selfrenrace-alice"}');
    w.localStorage.setItem('tauction-mybids:selfrenrace', selfBids);
  });
  gas.handle({ action: 'add', aname: 'selfrenrace',
    uname: 'zed', pid: 'pid-selfrenrace-zed' });
  renameTo(dSelfRen, 'alice', 'zed');
  await until(() => !dSelfRen.window.document
    .getElementById('banner').hidden);
  await until(() => row(dSelfRen.window.document, 'alice')
    && row(dSelfRen.window.document, 'alice').classList.contains('mine'));
  const restoredAlice = row(dSelfRen.window.document, 'alice')
    .querySelector('.rename input');
  ok(dSelfRen.window.localStorage.getItem('tauction-pids')
       === '{"selfrenrace":"pid-selfrenrace-alice"}'
     && dSelfRen.window.localStorage.getItem(
       'tauction-mybids:selfrenrace') === selfBids
     && restoredAlice.classList.contains('error')
     && restoredAlice.isConnected
     && !row(dSelfRen.window.document, 'zed').classList.contains('mine'),
     'the refused self-rename leaves identity and bid memory untouched'
     + ' by construction; the field objects, zed is never claimed');
  ok(dB.window.document.getElementById('descedit').value === 'B version'
     && gas.handle({ action: 'state', aname: 'descy' }).blurb
          === 'A version',
     "B's words survive in B's editor; A's words survive on the server");
  await until(() =>  // the bounce boots B straight back into the editor
    !dB.window.document.getElementById('desc').classList
      .contains('viewing'));
  ok(dB.window.document.getElementById('descedit').classList
       .contains('error')
     && dB.window.document.getElementById('descedit').value
          === 'B version',
     'a bounced commit reopens the EDITOR with the field red (the'
     + ' banner is global; the problem is THIS box) and your words'
     + ' intact');
  ok(dB.window.document.activeElement
       === dB.window.document.getElementById('roster-input'),
     "...but it never STEALS the caret from the field B moved on to"
     + ' (the arrival-caret law): the red editor waits its turn');
  await until(() => dB.window.document.getElementById('descview')
    .textContent.includes('A version'));
  ok(!dB.window.document.getElementById('descview').textContent
       .includes('B version'),
     "meanwhile the (hidden) view pane holds the server's truth: flip"
     + ' over to read what won before insisting');
  dB.window.document.getElementById('descedit')
    .dispatchEvent(new dB.window.Event('input', { bubbles: true }));
  ok(!dB.window.document.getElementById('descedit').classList
       .contains('error'),
     'the red clears at the next keystroke, like every field objection');
  // [Sol's audit, 2026-07-29: this tail waited on the re-base and
  // blur-commit behaviors DELETED with the mid-air-collision redo,
  // timed out twice in silence, and passed on ok(true). Rewritten to
  // the current law — and every until() below re-asserts.]
  // B mashes SAVE unrepentant: the collision refuses again, same
  // words — no save ever silently wins an edit war
  dB.window.document.getElementById('banner-x').click();
  dB.window.document.getElementById('descgo').click();
  await until(() => !dB.window.document.getElementById('banner').hidden);
  ok(dB.window.document.getElementById('banner-msg').textContent
       === SCOPY.simulEditsCopy
     && gas.handle({ action: 'state', aname: 'descy' }).blurb
          === 'A version',
     'insisting bounces again, in the same server words: repeat SAVEs'
     + " never clobber A's win");

  /* --- 2k. the alice race: two machines, one seat ------------------------
     Replicata (dreev's report, re-ruled 2026-07-21 after faire's
     /carnoon lockout): machine 1 and machine 2 both have the auction
     open, alice unclaimed on both screens. Machine 1 claims alice;
     before machine 2's page hears about it (no poll yet), machine 2
     clicks alice's star too. Expectata (claims are a consistency
     marker, not auth): the later claim TAKES the seat — last write
     wins, one holder at a time — and machine 1 converges to the new
     truth bannerlessly, its unseated star filled but LIVE (one tap
     takes it back). Resultata pre-flip: first come, first served,
     which locked faire out of her own seat when Safari re-minted her
     device id. */
  gas.handle({ action: 'add', aname: 'race2',
    uname: 'alice', pid: 'pid-race2-alice' });
  gas.handle({ action: 'add', aname: 'race2',
    uname: 'bea', pid: 'pid-race2-bea' });
  const r1 = await makePage('/race2?api=' + API_URL);
  const r2 = await makePage('/race2?api=' + API_URL);
  claimRow(r1, 'alice');
  await until(() => gas.handle({ action: 'state', aname: 'race2' })
    .claims['pid-race2-alice'] !== undefined);
  ok(!row(r2.window.document, 'alice').querySelector('.tu').disabled,
     "machine 2 hasn't polled yet: its stale screen still offers alice");
  claimRow(r2, 'alice');  // the race click: the takeover
  await until(() => gas.handle({ action: 'state', aname: 'race2' })
    .claims['pid-race2-alice']
      === r2.window.localStorage.getItem('tauction-device'));
  ok(row(r2.window.document, 'alice').classList.contains('mine')
     && r2.window.document.getElementById('banner').hidden,
     'the later claim TAKES the seat: machine 2 is alice, no drama');
  await until(() => row(r1.window.document, 'alice')
    .querySelector('.tu').classList.contains('taken'));
  ok(!row(r1.window.document, 'alice').classList.contains('mine')
     && !row(r1.window.document, 'alice').querySelector('.tu').disabled
     && r1.window.document.getElementById('banner').hidden,
     'machine 1 converges bannerlessly: unseated, its star filled but'
     + ' LIVE — one more tap would take the seat right back');
  // machine 1's consolation: bea is open, and life goes on
  claimRow(r1, 'bea');
  await until(() => gas.handle({ action: 'state', aname: 'race2' })
    .claims['pid-race2-bea'] !== undefined);
  ok(row(r1.window.document, 'bea').classList.contains('mine'),
     'machine 1 claims the open seat instead and lives happily');

  /* --- 2k2. seat-race stress battery (dreev: "stress-qual it") ----------
     Every way two machines can want the same seat in a NEW auction. */
  // (i) truly simultaneous clicks: both ops in flight at once
  gas.handle({ action: 'add', aname: 'race4',
    uname: 'alice', pid: 'pid-race4-alice' });
  const s1 = await makePage('/race4?api=' + API_URL);
  const s2 = await makePage('/race4?api=' + API_URL);
  mockDelay = 250;  // both claims fly together
  claimRow(s1, 'alice');
  claimRow(s2, 'alice');
  ok(row(s1.window.document, 'alice').classList.contains('mine')
     && row(s2.window.document, 'alice').classList.contains('mine'),
     'both machines are optimistic while their claims fly');
  await sleep(900);
  mockDelay = 0;
  const claim4 = gas.handle({ action: 'state', aname: 'race4' })
    .claims['pid-race4-alice'];
  const dev1 = s1.window.localStorage.getItem('tauction-device');
  const dev2 = s2.window.localStorage.getItem('tauction-device');
  ok(claim4 === dev1 || claim4 === dev2,
     'exactly one of the simultaneous claims wins on the server');
  const winner = claim4 === dev1 ? s1 : s2;
  const loser = claim4 === dev1 ? s2 : s1;
  await until(() =>
    row(loser.window.document, 'alice').querySelector('.tu').classList
      .contains('taken'));
  ok(row(winner.window.document, 'alice').classList.contains('mine')
     && !row(loser.window.document, 'alice').classList.contains('mine')
     && loser.window.document.getElementById('banner').hidden,
     'the loser converges to taken, bannerlessly; the winner holds');
  // (ii) tapping the taken star TAKES the seat back (faire's one-tap
  // recovery: a new browser identity reclaims her own seat)
  claimRow(loser, 'alice');
  await until(() => gas.handle({ action: 'state', aname: 'race4' })
    .claims['pid-race4-alice']
      === loser.window.localStorage.getItem('tauction-device'));
  await until(() => row(winner.window.document, 'alice')
    .querySelector('.tu').classList.contains('taken'));
  ok(row(loser.window.document, 'alice').classList.contains('mine')
     && !row(winner.window.document, 'alice').classList.contains('mine')
     && winner.window.document.getElementById('banner').hidden,
     'the taken star is LIVE: one tap takes the seat back, and the'
     + ' unseated machine converges quietly');
  // (iii) the new holder releases; the seat reopens and the unseated
  // machine re-latches by its remembered hint — no click, no noise
  claimRow(loser, 'alice');  // own lit star: release
  await until(() => gas.handle({ action: 'state', aname: 'race4' })
    .claims['pid-race4-alice'] === undefined);
  await until(() =>
    row(winner.window.document, 'alice').classList.contains('mine'));
  ok(!row(winner.window.document, 'alice').querySelector('.tu').classList
       .contains('taken')
     && winner.window.document.getElementById('banner').hidden,
     'released seats RE-LATCH the unseated automatically: their'
     + ' machine never forgot who they wanted to be — gold star, no'
     + ' click, no noise');

  /* --- 2l. the takeover bid: claim + bid while the ops fly ---------------
     Replicata: same stale-screen setup, but machine 2 clicks alice's
     star and IMMEDIATELY types a bid while its claim op is still in
     flight (the optimistic editor appears at once). Expectata
     (post-takeover-ruling): the claim TAKES the seat mid-race, the
     bid follows it in on the op chain and lands — exactly faire's
     recovery gesture, star-tap then bid — and machine 1 converges to
     the new truth. (A bare bid carrying a RIVAL device on a held
     seat still refuses server-side, pinned in gas-quals; the UI
     always claims first, so its chain arrives in order.) */
  gas.handle({ action: 'add', aname: 'race3',
    uname: 'alice', pid: 'pid-race3-alice' });
  const r3 = await makePage('/race3?api=' + API_URL);
  const r4 = await makePage('/race3?api=' + API_URL);
  claimRow(r3, 'alice');
  await until(() => gas.handle({ action: 'state', aname: 'race3' })
    .claims['pid-race3-alice'] !== undefined);
  mockDelay = 300;        // r4's ops fly slowly: the window for typing
  claimRow(r4, 'alice');  // stale screen, optimistic editor appears
  typeBid(r4, 'takeover bid');
  submitBid(r4);
  await sleep(900);       // claim + bid land, in chain order
  mockDelay = 0;
  const race3st = gas.handle({ action: 'state', aname: 'race3' });
  ok(bidderNamed(race3st, 'alice') !== undefined
     && race3st.claims['pid-race3-alice']
          === r4.window.localStorage.getItem('tauction-device'),
     'the takeover claim and its bid both land: machine 2 is alice,'
     + ' bid in');
  await until(() =>  // the RENDERED truth on the unseated machine
    row(r3.window.document, 'alice').querySelector('.tu').classList
      .contains('taken'));
  ok(!r3.window.document.querySelector('#tiles .rebid')
     && r3.window.document.getElementById('banner').hidden,
     'machine 1 converges to the new truth: taken star, no editor,'
     + ' no banner');

  /* --- 2m. the radio locks at SUBMIT, not at the server's ack ------------
     Replicata (dreev: "claim a participant, submit a bid, then see a
     blank field — possibly switching identities?"): claim alice,
     submit, and click bob's star while the bid is still in flight.
     Resultata pre-fix: the switch went through — the bid landed under
     alice while you faced bob's blank editor. Expectata: the stars
     lock the instant you commit. */
  gas.handle({ action: 'add', aname: 'flightlock',
    uname: 'alice', pid: 'pid-flightlock-alice' });
  gas.handle({ action: 'add', aname: 'flightlock',
    uname: 'bob', pid: 'pid-flightlock-bob' });
  const domFL = await makePage('/flightlock?api=' + API_URL);
  claimRow(domFL, 'alice');
  await until(() => gas.handle({ action: 'state', aname: 'flightlock' })
    .claims['pid-flightlock-alice'] !== undefined);
  mockDelay = 400;
  typeBid(domFL, 'my treasure');
  submitBid(domFL);
  ok([...tiles(domFL.window.document)].every(
       (t) => t.querySelector('.tu').disabled),
     'the radio locks the instant you submit: no identity hop while'
     + ' your bid is in flight');
  claimRow(domFL, 'bob');  // the mid-flight click must be inert
  await settled(domFL);
  mockDelay = 0;
  ok(domFL.window.localStorage.getItem('tauction-uname') === 'alice'
     && row(domFL.window.document, 'alice').classList.contains('mine')
     && myEditor(domFL.window.document).value === 'my treasure',
     'your bid stays in YOUR editor: no blank field, no orphaned bid');

  /* --- 2g. rapid adds must never flash-vanish ----------------------------
     Replicata (dreev's bug): type several names in rapid succession;
     the ops queue up behind real server latency; a poll's snapshot —
     requested after the last keystroke but reflecting only the ops that
     had landed by then — gets adopted, and every not-yet-landed name
     vanishes until the last op's response restores it. Expectata: a
     snapshot is adopted only when no writes are pending AND it was
     requested after the last write settled; typed names never flicker
     away. */
  const domB2 = await makePage('/burst?api=' + API_URL);
  mockDelay = 1200;  // each op takes a while, like the real Apps Script
  addName(domB2, 'aa');
  addName(domB2, 'bb');
  addName(domB2, 'cc');
  addName(domB2, 'dd');
  addName(domB2, 'ee');  // five serialized ops: the chain drains at ~6s;
                         // the ~5s poll's snapshot predates op 5
  // probe the ledger CONTINUOUSLY while the chain drains: the vanish
  // showed between the stale poll landing (~5s) and the last op (~6s),
  // so one fixed-time sample could miss it (and flaked under load)
  let vanished = false;
  await until(() => {
    if (!['aa', 'bb', 'cc', 'dd', 'ee'].every((u) =>
          row(domB2.window.document, u))) vanished = true;
    return names(gas.handle({ action: 'state', aname: 'burst' }))
      === 'aa,bb,cc,dd,ee';
  }, 15000);
  mockDelay = 0;
  ok(!vanished && ['aa', 'bb', 'cc', 'dd', 'ee'].every((u) =>
       row(domB2.window.document, u)),
     'every rapidly-typed name stayed on the ledger throughout'
     + ' (no flash-vanish)');
  ok(names(gas.handle({ action: 'state', aname: 'burst' }))
     === 'aa,bb,cc,dd,ee', 'and they all reached the server');

  /* --- 2f. two machines both wanting alice: dibs, not locks --------------
     Replicata (dreev's bug report): machine 1 adds alice (self-claim,
     2j); machine 2 opens the auction and clicks alice's star too; both
     machines bid as alice. Resultata pre-fix: both believed they were
     alice and silently overwrote each other's bid. Expectata: the
     self-claim is SOFT (registered on the server only by a bid or an
     explicit claim), so machine 2 sees alice claimable at first — but
     the moment machine 1 bids, every other machine shows dibs: the
     filled star and its rig-naming tip. (Post-takeover-ruling the
     star stays LIVE — dibs inform, they don't lock.) */
  const m1 = await makePage('/twoalices?api=' + API_URL);
  addName(m1, 'alice');
  await sleep(800);  // roster push lands on the server
  const m2 = await makePage('/twoalices?api=' + API_URL);
  await sleep(20);
  ok(!row(m2.window.document, 'alice').querySelector('.tu').disabled,
     "machine 1's self-add is soft: machine 2 still sees alice"
     + ' claimable until a bid registers the claim');
  typeBid(m1, 'the real bid');
  submitBid(m1);
  await settled(m1);
  ok(myEditor(m1.window.document).value === 'the real bid',
     'machine 1, the (self-)claim holder, bids normally');
  await until(() =>  // machine 2's next poll delivers the dibs
    row(m2.window.document, 'alice').querySelector('.tu').classList
      .contains('taken'));
  ok(!row(m2.window.document, 'alice').querySelector('.tu').disabled
     && !row(m2.window.document, 'alice').classList.contains('mine')
     && !m2.window.document.querySelector('#tiles .rebid'),
     "machine 1's bid registered the claim: alice dibsed on machine 2"
     + ' — no editor there, though the star stays live (dibs inform,'
     + " they don't lock)");
  ok(row(m2.window.document, 'alice').querySelector('.tu').classList
       .contains('taken')
     && row(m2.window.document, 'alice').querySelector('.tu')
          .getAttribute('data-tip')
          === STR.claimedByTip(STR.mysteryDevice + ' '
            + m1.window.navigator.language + ' in Portland, OR'),
     "the taken star FILLS in, and its tip blurbs the claimant's rig,"
     + " language, and rough geography (jsdom's UA parses to dreev's"
     + ' mystery-device fallback; the geo comes from the fixture)');

  /* --- 2r. geography is looked up ONCE A WEEK, not once a load ----------
     Replicata (dreev's 429 report): locate() fetched ipwho.is on every
     page load, and dev live-reload means a load per file save — the
     free rate limit burned into console spam. Expectata: first load
     fetches and stamps a localStorage cache; loads within the TTL use
     the cache (NO network); a stale stamp refetches. ---------------- */
  const geoBefore = geoHits;
  const g1 = await makePage('/geocache1?api=' + API_URL);
  await until(() => g1.window.localStorage.getItem('tauction-geo'));
  ok(geoHits === geoBefore + 1
     && g1.window.localStorage.getItem('tauction-geo') === 'Portland, OR'
     && !Number.isNaN(Date.parse(
          g1.window.localStorage.getItem('tauction-geo-at'))),
     'first load fetches geography once and stamps the dated cache');
  const g2 = await makePage('/geocache2?api=' + API_URL, (win) => {
    win.localStorage.setItem('tauction-geo', 'Rainbow City, AL');
    win.localStorage.setItem('tauction-geo-at', new Date().toISOString());
  });
  addName(g2, 'gina');
  typeBid(g2, 'a rainbow');
  submitBid(g2);
  await settled(g2);
  ok(geoHits === geoBefore + 1,
     'a fresh cache means NO lookup: reload-heavy dev must not burn'
     + ' the rate limit');
  ok(gas.handle({ action: 'state', aname: 'geocache2' })
       .blurbs[pidOf(gas.handle({ action: 'state', aname: 'geocache2' }), 'gina')]
       === STR.mysteryDevice + ' ' + g2.window.navigator.language
         + ' in Rainbow City, AL',
     "...and the cached geography actually decorates the blurb (the"
     + ' seeded city shows, proving no silent refetch either)');
  const g3 = await makePage('/geocache3?api=' + API_URL, (win) => {
    win.localStorage.setItem('tauction-geo', 'Nowhere, ZZ');
    win.localStorage.setItem('tauction-geo-at',
      new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString());
  });
  await until(() =>
    g3.window.localStorage.getItem('tauction-geo') === 'Portland, OR');
  ok(geoHits === geoBefore + 2,
     'a stale stamp (8 days) refetches and re-stamps: cities do'
     + ' occasionally move');

  /* --- 2r3. a FAILED lookup backs off, never retries per load ----------
     Replicata (dreev's persisting-429 report, 2026-07-18): the geo
     service throttles (or is down); reload the page — dev live-reload
     means a load per file save. Resultata pre-fix: only success wrote
     the cache stamp, so every load re-probed and console-logged a
     fresh 429, itself feeding the burst limit. Expectata: the ATTEMPT
     is stamped, so a throttled service gets one probe per backoff
     window; once the window lapses, the next load probes again. */
  geoFixture = { success: false };  // the 429 body: no city in it
  const geoBefore2 = geoHits;
  const gF1 = await makePage('/geofail?api=' + API_URL);
  await until(() => geoHits === geoBefore2 + 1);
  ok(geoHits === geoBefore2 + 1
     && gF1.window.localStorage.getItem('tauction-geo') === null
     && !Number.isNaN(Date.parse(
          gF1.window.localStorage.getItem('tauction-geo-try'))),
     'a failed lookup caches no city but stamps the attempt');
  const gF2 = await makePage('/geofail2?api=' + API_URL, (w) =>
    w.localStorage.setItem('tauction-geo-try', new Date().toISOString()));
  await sleep(100);
  ok(geoHits === geoBefore2 + 1,
     'a reload inside the backoff window does not probe at all: no'
     + ' 429 spam, no burst-limit feedback loop');
  geoFixture = { city: 'Portland', region_code: 'OR' };
  const gF3 = await makePage('/geofail3?api=' + API_URL, (w) =>
    w.localStorage.setItem('tauction-geo-try',
      new Date(Date.now() - 2 * 3600 * 1000).toISOString()));
  await until(() => gF3.window.localStorage.getItem('tauction-geo'));
  ok(geoHits === geoBefore2 + 2
     && gF3.window.localStorage.getItem('tauction-geo')
          === 'Portland, OR',
     'a lapsed backoff probes again on the next load and primes the'
     + ' cache');

  /* --- 2r2. accented geography must never cost a bid -------------------
     Replicata: the IP lookup names a city with non-ASCII characters
     (São Paulo, Zürich, Montréal); claim a seat or place a bid.
     Resultata pre-fix: DEVBLURB carried the accents into the request
     and Code.gs's printable-ASCII deviceBlurb contract refused the
     WHOLE thing — 'bad deviceBlurb', a bid lost to decoration.
     Expectata: the client ASCII-fies its own decoration (São -> Sao)
     and clamps it to the contract's 64 chars; the bid always lands. */
  geoFixture = { city: 'São Paulo', region_code: 'SP' };
  const gSp = await makePage('/geosp?api=' + API_URL);
  await until(() => gSp.window.localStorage.getItem('tauction-geo'));
  addName(gSp, 'ze');
  typeBid(gSp, 'dez reais');
  submitBid(gSp);
  await settled(gSp);
  ok(gSp.window.document.getElementById('banner').hidden
     && gas.handle({ action: 'state', aname: 'geosp' }).bidders
          .length === 1,
     'a São Paulo bidder bids fine: decoration never blocks the act');
  ok((gas.handle({ action: 'state', aname: 'geosp' })
       .blurbs[pidOf(gas.handle({ action: 'state', aname: 'geosp' }), 'ze')] || '')
       .endsWith(' in Sao Paulo, SP'),
     'the blurb arrives ASCII-fied (São -> Sao), got '
       + gas.handle({ action: 'state', aname: 'geosp' })
       .blurbs[pidOf(gas.handle({ action: 'state', aname: 'geosp' }), 'ze')]);
  geoFixture = { city: 'Portland', region_code: 'OR' };
  // a city cached by PRE-FIX code sanitizes at use, not just at
  // store: the day-long TTL must not keep the bug alive for a day
  const gZu = await makePage('/geozu?api=' + API_URL, (win) => {
    win.localStorage.setItem('tauction-geo', 'Zürich, ZH');
    win.localStorage.setItem('tauction-geo-at', new Date().toISOString());
  });
  addName(gZu, 'ueli');
  typeBid(gZu, 'zehn franken');
  submitBid(gZu);
  await settled(gZu);
  ok((gas.handle({ action: 'state', aname: 'geozu' })
       .blurbs[pidOf(gas.handle({ action: 'state', aname: 'geozu' }), 'ueli')] || '')
       .endsWith(' in Zurich, ZH'),
     'a cached pre-fix city sanitizes on use (Zürich -> Zurich), got '
       + gas.handle({ action: 'state', aname: 'geozu' })
       .blurbs[pidOf(gas.handle({ action: 'state', aname: 'geozu' }), 'ueli')]);
  // the length half of the contract: a Welsh-length city clamps to 64
  const gLl = await makePage('/geoll?api=' + API_URL, (win) => {
    win.localStorage.setItem('tauction-geo',
      'Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch, GW');
    win.localStorage.setItem('tauction-geo-at', new Date().toISOString());
  });
  addName(gLl, 'wyn');
  typeBid(gLl, 'a leek');
  submitBid(gLl);
  await settled(gLl);
  ok(gas.handle({ action: 'state', aname: 'geoll' }).bidders.length === 1
     && (gas.handle({ action: 'state', aname: 'geoll' })
       .blurbs[pidOf(gas.handle({ action: 'state', aname: 'geoll' }), 'wyn')] || '')
          .length <= 64,
     "a Welsh-length blurb clamps to the contract's 64 chars and the"
     + ' bid still lands, got '
       + gas.handle({ action: 'state', aname: 'geoll' })
       .blurbs[pidOf(gas.handle({ action: 'state', aname: 'geoll' }), 'wyn')]);

  /* --- 2s. flipping to view paints INSTANTLY --------------------------
     Replicata (dreev): type markdown, click the toggle, and the box
     basically disappears for a while — the view pane waited for the
     describe write to round-trip the server. Expectata: rendering is
     pure client work; the committed draft paints synchronously and
     the write settles in the background (a CAS bounce repaints). --- */
  const dI = await makePage('/instadesc?api=' + API_URL);
  await sleep(20);
  dI.window.document.getElementById('descedit').value
    = '# Big News\n\nmuch **bold**';
  dI.window.document.getElementById('descedit').dispatchEvent(
    new dI.window.Event('input', { bubbles: true }));
  mockDelay = 500;  // a slow server must not delay the paint
  dI.window.document.getElementById('descgo').click();
  const instaView = dI.window.document.getElementById('descview');
  ok(dI.window.document.getElementById('desc').classList
       .contains('viewing')
     && instaView.querySelector('h1')
     && instaView.querySelector('h1').textContent === 'Big News'
     && instaView.querySelector('strong').textContent === 'bold',
     'the rendered markdown appears the instant SAVE is pressed,'
     + ' not when the database answers');
  await until(() => gas.handle({ action: 'state', aname: 'instadesc' })
    .blurb === '# Big News\n\nmuch **bold**');
  mockDelay = 0;
  ok(gas.handle({ action: 'state', aname: 'instadesc' }).blurb
       === '# Big News\n\nmuch **bold**'
     && instaView.querySelector('h1') !== null,
     '...and the background write lands the same text; the settle'
     + ' repaints nothing');

  /* --- 2t. every CONTROL is a tab stop (dreev 2026-07-27, reversing
     his 07-16 tab law after the conventions audit: keyboard-only
     users could not claim a star, remove a row, press the reveal
     padlock, share, or reopen a rendered blurb). Buttons and links
     are tabbable, per convention; only the auction LABEL keeps
     tabindex -1 (focusable for tap-tips, never a stop — a label is
     not a control). This is a structural fence: it sweeps every
     button and link on a live page, built rows included. ----------- */
  const dTab = await makePage('/taborder?api=' + API_URL);
  addName(dTab, 'tia');
  await settled(dTab);
  const allControls = Array.from(
    dTab.window.document.querySelectorAll('button, a'));
  ok(allControls.length >= 10
     && allControls.every((b) => b.tabIndex !== -1),
     'every button and link is a tab stop (stars, ×s, SAVE/SUBMIT,'
     + ' pencil, share, help, seal, copy, dialog ×s, footer link):'
     + ' no keyboard dead ends');
  ok(dTab.window.document.getElementById('descedit').tabIndex === 0
     && dTab.window.document.getElementById('roster-input').tabIndex === 0
     && dTab.window.document.getElementById('aname').tabIndex === 0,
     '...and the editable fields remain tab stops themselves');
  ok(dTab.window.document.querySelector(
       '.tile[data-uname="tia"] .rebid textarea').tabIndex === 0,
     'your own bid editor included');
  ok(dTab.window.document.querySelector('label[for="aname"]')
       .tabIndex === -1,
     'the auction label alone stays out of the ring: tap-focusable'
     + ' for its tip, but not a control');
  // THE COMMIT-BUTTON FENCE (dreev, after the auction name turned
  // up buttonless: consistency by construction, not by remembering):
  // every text field in the app sits in a wrapper that carries its
  // own .go — a field without a visible commit gesture can no
  // longer exist, it fails this sweep
  ok([...dTab.window.document.querySelectorAll('input, textarea')]
       .every((f) => {
         const home = f.closest(
           '.rebid, .rename, .fieldcol, .desc, .field');
         if (home === null) return false;
         // a blur-committing field (renames, 2026-07-28) needs no
         // button: leaving IS its commit gesture
         return home.matches('.rename')
           || home.querySelector('.go') !== null;
       }),
     'EVERY text field either carries a commit button or commits on'
     + ' blur: the gesture table stays closed by construction');

  /* --- 2t2. dead ends are STICKY and walkable (dreev's PWA report:
     an installed app has no URL bar, so "use the URL" must BE the
     URL, and the sign must not vanish while you read it) --------- */
  const dPwa = await makePage('/?api=' + API_URL);
  await sleep(20);
  gas.handle({ action: 'add', aname: 'occupied',
    uname: 'zoe', pid: 'pid-occupied-zoe' });
  dPwa.window.document.getElementById('aname').focus();
  type(dPwa, 'aname', 'occupied');
  commitName(dPwa);
  await until(() => !dPwa.window.document.getElementById('banner').hidden);
  const gateLink = dPwa.window.document.querySelector('#banner a');
  ok(gateLink && gateLink.getAttribute('href') === '/occupied'
     && dPwa.window.document.getElementById('banner-msg').textContent
          === STR.auctionExistsBanner('/occupied')
              .replace(/<[^>]+>/g, ''),
     'the exists-banner offers the URL as a real LINK (a PWA has no'
     + ' URL bar to fall back on), in dreev\'s words');
  await sleep(5300);  // outlives the RETIRED 5s self-destruct (this
                      // pin predates all banners going sticky)
  ok(!dPwa.window.document.getElementById('banner').hidden,
     'and the dead-end sign does NOT dismiss itself (dreev: you are'
     + ' stuck until you act on it)');
  type(dPwa, 'aname', 'gate3');
  commitName(dPwa);
  await until(() =>
    dPwa.window.location.pathname === '/gate3');
  ok(dPwa.window.document.getElementById('banner').hidden,
     'landing somewhere real finally clears it');
  ok(dPwa.window.document.getElementById('aname').disabled,
     "...and the chosen name freezes: creating is the field's one"
     + ' job, done');

  /* --- 2t3. Escape means "never mind" in EVERY field -------------------
     One universal rule: Escape reverts a field to its baseline
     (defaultValue, the committed truth everywhere) and leaves. New
     ground covered: the auction-name field — abandoning a half-typed
     switch used to be impossible (the debounce fired regardless). */
  const dEsc0 = await makePage('/?api=' + API_URL);
  await sleep(20);
  dEsc0.window.document.getElementById('aname').focus();
  type(dEsc0, 'aname', 'somewhereelse');
  dEsc0.window.document.getElementById('aname').dispatchEvent(
    new dEsc0.window.KeyboardEvent('keydown',
      { key: 'Escape', bubbles: true }));
  await sleep(700);  // outlive the create debounce
  ok(dEsc0.window.document.getElementById('aname').value === ''
     && dEsc0.window.location.pathname === '/',
     'Escape in the auction field abandons the half-typed CREATE:'
     + ' field cleared, nobody navigates');
  const dEsc = await makePage('/eschome?api=' + API_URL);
  await sleep(20);
  dEsc.window.document.getElementById('roster-input').focus();
  type(dEsc, 'roster-input', 'oops');
  dEsc.window.document.getElementById('roster-input').dispatchEvent(
    new dEsc.window.KeyboardEvent('keydown',
      { key: 'Escape', bubbles: true }));
  await sleep(50);
  ok(dEsc.window.document.getElementById('roster-input').value === ''
     && !row(dEsc.window.document, 'oops'),
     'Escape in the + row abandons the typed name: cleared, not'
     + ' committed (the blur that follows finds nothing)');

  /* --- 2t4. the singleton tip's three regression pins ------------------
     (found by inspection in the Floating UI glue, pinned after the
     fact: the async race, the live retitle, the dead host) -------- */
  const dTip = await makePage('/?api=' + API_URL);
  await sleep(20);
  {
    const w = dTip.window;
    const held = [];
    w.FloatingUIDOM.computePosition = (host) =>
      new w.Promise((res) => held.push([host, res]));
    w.document.querySelector('label[for="aname"]').focus();  // summons 1
    // summons 2: the resting seal is DISABLED, which jsdom won't
    // focus() since it lost its tabindex (2t) — the focusin dispatch
    // is the summons the app actually listens for (3095's pattern)
    w.document.getElementById('seal').dispatchEvent(
      new w.FocusEvent('focusin', { bubbles: true }));
    held[1][1]({ x: 222, y: 22 });   // newest resolves first...
    await sleep(10);
    held[0][1]({ x: 111, y: 11 });   // ...stale one limps in late
    await sleep(10);
    ok(w.document.getElementById('tip').style.left === '222px'
       && w.document.getElementById('tip').textContent
            === w.document.getElementById('seal')
                 .getAttribute('data-tip'),
       'a stale async position never lands on a newer tip: the newest'
       + ' summons owns it');
  }
  gas.handle({ action: 'add', aname: 'tipflow',
    uname: 'ann', pid: 'pid-tipflow-ann' });
  gas.handle({ action: 'add', aname: 'tipflow',
    uname: 'bo', pid: 'pid-tipflow-bo' });
  const dTip2 = await makePage('/tipflow?api=' + API_URL,
    (w) => w.localStorage.setItem('tauction-uname', 'bo'));
  await sleep(20);  // arriving as bo: further adds are facilitator-
                    // style and steal no focus from the parked tip
  const annStar = row(dTip2.window.document, 'ann').querySelector('.tu');
  annStar.focus();
  annStar.dispatchEvent(new dTip2.window.FocusEvent('focusin',
    { bubbles: true }));
  await sleep(10);
  ok(!dTip2.window.document.getElementById('tip').hidden
     && dTip2.window.document.getElementById('tip').textContent
          === STR.claimTip,
     'a focused star summons its tip (the tap-tip path)');
  // a rival claims ann elsewhere; OUR next render must retitle the
  // OPEN tip without the pointer moving (the live-refresh)
  gas.handle({ action: 'claim', aname: 'tipflow',
    uname: 'ann', pid: 'pid-tipflow-ann',
               deviceID: 'd-rival', deviceBlurb: 'rival rig' });
  // (no focus moves: focusing elsewhere would rightly drop the
  // parked tip — the pin is about the RENDER retitling it)
  type(dTip2, 'roster-input', 'zed');
  submitName(dTip2);
  await until(() => dTip2.window.document.getElementById('tip').textContent
    === STR.claimedByTip('rival rig'));
  ok(dTip2.window.document.getElementById('tip').textContent
       === STR.claimedByTip('rival rig'),
     "the render retitles the open tip in place: it follows the truth"
     + ' without waiting for the pointer');
  // ann's row vanishes entirely; the tip must not haunt a dead host
  gas.handle({ action: 'remove', aname: 'tipflow', pid: 'pid-tipflow-ann' });
  annStar.dispatchEvent(new dTip2.window.FocusEvent('focusin',
    { bubbles: true }));
  type(dTip2, 'roster-input', 'yaz');
  submitName(dTip2);
  await until(() => dTip2.window.document.getElementById('tip').hidden);
  ok(dTip2.window.document.getElementById('tip').hidden,
     'a removed host takes its tip with it: no haunting');
  // ...and a host that merely LOSES its data-tip while alive (the
  // seal is the one that does: the lit 🎉 explains itself, so the
  // reveal strips its tip) must take the open tip with it too.
  // Replicata: park on the ready padlock; the reveal lands from
  // elsewhere. Resultata pre-fix: the tip stayed up as an EMPTY
  // bubble until the pointer moved. Expectata: it vanishes.
  gas.handle({ action: 'add', aname: 'tipgone',
    uname: 'ann', pid: 'pid-tipgone-ann' });
  gas.handle({ action: 'add', aname: 'tipgone',
    uname: 'bo', pid: 'pid-tipgone-bo' });
  gas.handle({ action: 'bid', aname: 'tipgone',
    uname: 'ann', pid: 'pid-tipgone-ann', bid: 'a' });
  gas.handle({ action: 'bid', aname: 'tipgone',
    uname: 'bo', pid: 'pid-tipgone-bo', bid: 'b' });
  const dTip3 = await makePage('/tipgone?api=' + API_URL);
  await sleep(20);
  const sealT = dTip3.window.document.getElementById('seal');
  sealT.focus();
  sealT.dispatchEvent(new dTip3.window.FocusEvent('focusin',
    { bubbles: true }));
  await sleep(10);
  ok(!dTip3.window.document.getElementById('tip').hidden
     && dTip3.window.document.getElementById('tip').textContent
          === STR.revealTip,
     'parked on the ready padlock: its tip is up');
  gas.handle({ action: 'reveal', aname: 'tipgone' });  // from elsewhere
  await until(() => dTip3.window.document.getElementById('status')
    .classList.contains('revealed'));
  await sleep(10);
  ok(!sealT.hasAttribute('data-tip')
     && dTip3.window.document.getElementById('tip').hidden,
     "the reveal takes the padlock's tip: the open tip vanishes"
     + ' instead of lingering as an empty bubble');

  /* --- 2u. name, enter, bid (dreev's add-self flow) --------------------
     [Tab retired as a commit 2026-07-27 — it wrote alice to the
     database; Tab-adds-nobody is pinned in 2u3.] Adding YOURSELF
     lands the caret in your fresh bid editor: type your name, enter,
     type your bid. Only when the fresh row is yours (the gold star);
     a facilitator adding others keeps the caret in the + row for
     the next name. */
  const dSelf = await makePage('/tabflow?api=' + API_URL);
  await sleep(20);
  dSelf.window.document.getElementById('roster-input').focus();
  addName(dSelf, 'dree');
  ok(dSelf.window.document.activeElement
       === myEditor(dSelf.window.document)
     && row(dSelf.window.document, 'dree').classList.contains('mine'),
     'add yourself, enter: the caret lands in YOUR fresh bid editor');
  dSelf.window.document.getElementById('roster-input').focus();
  addName(dSelf, 'gwen');
  ok(row(dSelf.window.document, 'gwen') !== null
     && !row(dSelf.window.document, 'gwen').classList.contains('mine')
     && dSelf.window.document.activeElement
          === dSelf.window.document.getElementById('roster-input'),
     "adding someone ELSE books the row but doesn't jump: the"
     + ' caret stays in the + row for the next name');

  /* --- 2p3. enter-then-blur on a RENAME fires once ---------------------
     Replicata (dreev 2026-07-17): fresh auction, add yourself as
     alice, bid immediately, add bob, immediately rename bob to
     bob123 (never used anywhere). Resultata pre-fix: "That name is
     taken" — the enter commit remapped the local roster and the
     trailing blur commit re-ran against its own success. Expectata:
     it just lets you. */
  const dRn = await makePage('/freshren?api=' + API_URL);
  await sleep(20);
  dRn.window.document.getElementById('roster-input').focus();
  type(dRn, 'roster-input', 'alice');
  submitName(dRn);
  typeBid(dRn, 'my bid');
  submitBid(dRn);
  type(dRn, 'roster-input', 'bob');
  submitName(dRn);
  const bobInp = row(dRn.window.document, 'bob')
    .querySelector('.rename input');
  bobInp.focus();
  bobInp.value = 'bob123';
  bobInp.form.dispatchEvent(new dRn.window.Event('submit',
    { bubbles: true, cancelable: true }));
  bobInp.dispatchEvent(new dRn.window.Event('blur'));
  await settled(dRn);
  ok(dRn.window.document.getElementById('banner').hidden
     && row(dRn.window.document, 'bob123') !== null
     && names(gas.handle({ action: 'state', aname: 'freshren' })).includes('bob123'),
     'enter-then-blur renames ONCE: no false "taken" (structural now —'
     + ' a blur commits nothing, so a trailing one cannot re-fire)');

  /* --- 2q2. a bid protects its seat, before and after the gavel -------
     [REWRITTEN 2026-07-19, dreev deleting the cut-flag model: a
     bidder simply cannot be removed, so the crossed-out-row state no
     longer exists to defend.] Every bid-bearing row's × is gray from
     the moment the bid lands; the gavel grays the rest. */
  gas.handle({ action: 'add', aname: 'frozencut',
    uname: 'pam', pid: 'pid-frozencut-pam' });
  gas.handle({ action: 'add', aname: 'frozencut',
    uname: 'quinn', pid: 'pid-frozencut-quinn' });
  gas.handle({ action: 'add', aname: 'frozencut',
    uname: 'rex', pid: 'pid-frozencut-rex' });
  gas.handle({ action: 'bid', aname: 'frozencut',
    uname: 'pam', pid: 'pid-frozencut-pam', bid: 'p' });
  gas.handle({ action: 'bid', aname: 'frozencut',
    uname: 'quinn', pid: 'pid-frozencut-quinn', bid: 'q' });
  const dFz = await makePage('/frozencut?api=' + API_URL);
  await sleep(20);
  ok(row(dFz.window.document, 'pam').querySelector('.x').disabled
     && row(dFz.window.document, 'quinn').querySelector('.x').disabled
     && !row(dFz.window.document, 'rex').querySelector('.x').disabled,
     "a bid grays its row's × the moment it lands; the bidless"
     + ' straggler stays removable (the end-early flow)');
  // the raced removal the UI can't produce: the server refuses it,
  // atomically, in the Latin
  const rmRes = gas.handle({ action: 'remove', aname: 'frozencut',
    pid: 'pid-frozencut-pam' });
  ok(String(rmRes.error) === SCOPY.removeBidderCopy
     && names(gas.handle({ action: 'state', aname: 'frozencut' }))
          === 'pam,quinn,rex',
     'a raced remove of a bidder bounces off the server: nothing'
     + ' changes');
  gas.handle({ action: 'remove', aname: 'frozencut',
    pid: 'pid-frozencut-rex' });
  gas.handle({ action: 'reveal', aname: 'frozencut' });
  await until(() => dFz.window.document.getElementById('status')
    .classList.contains('revealed'));
  ok([...dFz.window.document.querySelectorAll('#tiles .x')]
       .every((x) => x.disabled),
     'every × grays at the gavel: a revealed record never loses'
     + ' anything');

  /* --- 2u2. the hallway test (dreev + bee, verbatim fumbles) -----------
     Scene: bee's row exists, unclaimed and bidless. A fresh visitor
     (a) taps bee's empty bid box — "clicking on this box doesn't
     work"; (b) types "bee" into the + row — "maybe i type in the
     name i want to make a bid for?". Both intents are OBVIOUS, so
     both now work: they claim bee's seat and ready the editor. --- */
  gas.handle({ action: 'add', aname: 'hallway',
    uname: 'bee', pid: 'pid-hallway-bee' });
  const dHall = await makePage('/hallway?api=' + API_URL);
  await sleep(20);
  row(dHall.window.document, 'bee').querySelector('.tile-bid').click();
  await settled(dHall);
  ok(row(dHall.window.document, 'bee').classList.contains('mine')
     && dHall.window.document.activeElement
          === myEditor(dHall.window.document),
     "tapping a takeable row's empty bid box claims it and puts the"
     + ' caret in the editor: the intent was never ambiguous');
  claimRow(dHall, 'bee');  // release again (radio) for scene (b)
  await until(() => gas.handle({ action: 'state', aname: 'hallway' })
    .claims['pid-hallway-bee'] === undefined);
  const dHall2 = await makePage('/hallway?api=' + API_URL);
  await sleep(20);
  dHall2.window.document.getElementById('roster-input').focus();
  type(dHall2, 'roster-input', 'bee');
  submitName(dHall2);
  await settled(dHall2);
  ok(row(dHall2.window.document, 'bee').classList.contains('mine')
     && dHall2.window.document.activeElement
          === myEditor(dHall2.window.document)
     && dHall2.window.document.getElementById('roster-input').value === ''
     && !dHall2.window.document.getElementById('roster-input')
          .classList.contains('error'),
     'typing an existing takeable name claims that seat (no red-ring'
     + ' rejection when the intent is "I am bee")');
  typeBid(dHall2, 'bee bids at last');
  submitBid(dHall2);
  await settled(dHall2);
  ok(bidderNamed(gas.handle(
       { action: 'state', aname: 'hallway' }), 'bee') !== undefined,
     '...and the bid lands: the whole hallway flow, frictionless');
  const dHall3 = await makePage('/hallway?api=' + API_URL);
  await sleep(20);
  row(dHall3.window.document, 'bee').querySelector('.tile-bid').click();
  await sleep(50);
  ok(!row(dHall3.window.document, 'bee').classList.contains('mine'),
     "a DIBSED row's bid box stays dead: bee's registered seat can't"
     + ' be tapped away');
  dHall3.window.document.getElementById('roster-input').focus();
  type(dHall3, 'roster-input', 'bee');
  submitName(dHall3);
  ok(dHall3.window.document.getElementById('roster-input').value === 'bee'
     && dHall3.window.document.getElementById('roster-input').classList
          .contains('error')
     && !row(dHall3.window.document, 'bee').classList.contains('mine'),
     'typing a HELD name still objects: red ring, text kept — that'
     + ' seat is spoken for');

  /* --- 2u3. committing a typed name never needs enter (mobile) ---------
     The finger's gesture is the + row's SAVE now (dreev 2026-07-27:
     blur commits nothing, anywhere — a tapped-away name waits in the
     field with its button standing, the hallway fumble answered by a
     visible control instead of a hidden write). ------------------- */
  const dAdd = await makePage('/blurauda?api=' + API_URL);
  await sleep(20);
  dAdd.window.document.getElementById('roster-input').focus();
  type(dAdd, 'roster-input', 'gala');
  dAdd.window.document.getElementById('roster-input').blur();
  await sleep(80);
  ok(row(dAdd.window.document, 'gala') === null
     && dAdd.window.document.getElementById('roster-input').value
          === 'gala'
     && dAdd.window.document.getElementById('roster-input')
          .closest('.fieldcol').classList.contains('hot'),
     'a tapped-away name is not yet anybody: it waits in the + row,'
     + ' hot, its SAVE standing');
  dAdd.window.document.getElementById('roster-go').click();
  await settled(dAdd);
  ok(row(dAdd.window.document, 'gala') !== null
     && row(dAdd.window.document, 'gala').classList.contains('mine')
     && dAdd.window.document.activeElement
          === myEditor(dAdd.window.document),
     'SAVE commits the typed name — and a self-add lands the caret in'
     + ' YOUR fresh bid editor, no enter anywhere (dreev: show up,'
     + ' add your name, bid)');
  dAdd.window.document.getElementById('roster-input').focus();
  dAdd.window.document.getElementById('roster-input').blur();
  ok(!dAdd.window.document.getElementById('roster-input').classList
       .contains('error'),
     'an empty blur of the + row objects to nothing');
  // Tab is NAVIGATION, never a commit (dreev 2026-07-27, after Tab
  // wrote alice to the database: the whole point of SAVE is that
  // nothing but SAVE — or Enter, or the separators — writes)
  dAdd.window.document.getElementById('roster-input').focus();
  type(dAdd, 'roster-input', 'hank');
  const tabAdds = apiCalls.filter((r) => r.action === 'add').length;
  const tabFree = dAdd.window.document.getElementById('roster-input')
    .dispatchEvent(new dAdd.window.KeyboardEvent('keydown',
      { key: 'Tab', bubbles: true, cancelable: true }));
  await sleep(80);
  ok(tabFree
     && apiCalls.filter((r) => r.action === 'add').length === tabAdds
     && dAdd.window.document.getElementById('roster-input').value
          === 'hank'
     && row(dAdd.window.document, 'hank') === null,
     'Tab adds NOBODY, uneaten: it moves focus like Tab should, and'
     + ' the typed name waits with its SAVE');
  // ...and the separators died with it (dreev 2026-07-27,
  // uniformity): comma and space commit nothing — the live charset
  // constraint just declines the character, exactly as the rename
  // fields always have. Enter and SAVE are the + row's only commits.
  for (const sep of [',', ' ']) {
    const sepAdds = apiCalls.filter((r) => r.action === 'add').length;
    const sepFree = dAdd.window.document.getElementById('roster-input')
      .dispatchEvent(new dAdd.window.KeyboardEvent('keydown',
        { key: sep, bubbles: true, cancelable: true }));
    await sleep(60);
    ok(sepFree
       && apiCalls.filter((r) => r.action === 'add').length === sepAdds
       && dAdd.window.document.getElementById('roster-input').value
            === 'hank'
       && row(dAdd.window.document, 'hank') === null,
       'typing "' + sep + '" commits nobody: separators are not'
       + ' gestures anymore');
  }

  /* --- 2v. the bid editor's SUBMIT is the finger's enter (dreev
     2026-07-27: clicking away sends nothing) — and enter-then-blur
     (the mobile keyboard closing right after submit) fires ONCE. -- */
  const dBlur = await makePage('/blursave?api=' + API_URL);
  await sleep(20);
  addName(dBlur, 'bea');
  await settled(dBlur);
  typeBid(dBlur, 'saved by press');
  myEditor(dBlur.window.document).dispatchEvent(
    new dBlur.window.Event('input', { bubbles: true }));
  myEditor(dBlur.window.document).blur();
  await sleep(80);
  ok(bidderNamed(gas.handle(
       { action: 'state', aname: 'blursave' }), 'bea') === undefined
     && myEditor(dBlur.window.document).value === 'saved by press'
     && myEditor(dBlur.window.document).closest('.rebid')
          .classList.contains('hot'),
     'clicking away places NOTHING: the draft waits, hot, SUBMIT'
     + ' standing');
  myEditor(dBlur.window.document).closest('.rebid')
    .querySelector('.go').click();
  submitBid(dBlur);  // (jsdom fires no implicit submit off the click)
  await until(() => (bidderNamed(gas.handle(
    { action: 'state', aname: 'blursave' }), 'bea') || {}).bcount === 1);
  ok(true, 'pressing SUBMIT places the bid: no enter required');
  await settled(dBlur);
  typeBid(dBlur, 'enter then blur');
  submitBid(dBlur);
  myEditor(dBlur.window.document).dispatchEvent(
    new dBlur.window.Event('blur'));  // the keyboard closes
  await settled(dBlur);
  ok(bidderNamed(gas.handle(
       { action: 'state', aname: 'blursave' }), 'bea').bcount === 2,
     'enter then blur is ONE submission, not two (structural now: the'
     + ' closing mobile keyboard can no longer fire anything)');
  ok(myEditor(dBlur.window.document).value === 'enter then blur'
     && dBlur.window.document.getElementById('banner').hidden,
     'and an idle blur of a clean editor commits nothing');
  typeBid(dBlur, 'abandoned thought');
  myEditor(dBlur.window.document).dispatchEvent(
    new dBlur.window.KeyboardEvent('keydown',
      { key: 'Escape', bubbles: true }));
  await settled(dBlur);
  ok(myEditor(dBlur.window.document).value === 'enter then blur'
     && bidderNamed(gas.handle(
          { action: 'state', aname: 'blursave' }), 'bea').bcount === 2,
     'Escape abandons a bid edit (the only way out now that clicking'
     + ' away saves): reverted, nothing submitted');

  /* --- 2w. an unchanged bid is NO submission -----------------------------
     Replicata: send a bid, then send the same words again — after the
     first settles or while it is still flying.
     Expectata: the repeat is a client-side no-op: no POST, no new log
     row/count/card sheet, no busy sign, and no commit pulse.
     Resultata pre-fix: every form submit appended another identical row
     and made the card pile one sheet deeper. ---------------------------- */
  const dDupe = await makePage('/dupebid?api=' + API_URL);
  addName(dDupe, 'dot');
  await settled(dDupe);
  const dupePosts = () => apiCalls.filter((c) =>
    c.action === 'bid' && c.aname === 'dupebid').length;

  // Two immediate identical sends: the second gesture lands while the
  // first request is aloft, before defaultValue can become the baseline.
  mockDelay = 150;
  typeBid(dDupe, 'same bid');
  submitBid(dDupe);
  submitBid(dDupe);
  await settled(dDupe);
  mockDelay = 0;
  let dupeState = gas.handle({ action: 'state', aname: 'dupebid' });
  ok(dupePosts() === 1
     && bidderNamed(dupeState, 'dot').bcount === 1,
     'rapid same→same sends one POST and leaves one bid-log row');
  ok(myEditor(dDupe.window.document).style.boxShadow === 'var(--lift)',
     'rapid same→same leaves a single card, with no extra stack sheet');

  // Once settled, equality is judged on the server-normalized text:
  // whitespace around the same bid is still the same bid.
  const settledPosts = dupePosts();
  const settledShadow = myEditor(dDupe.window.document).style.boxShadow;
  myEditor(dDupe.window.document).classList.remove('committed');
  typeBid(dDupe, '  same bid  ');
  submitBid(dDupe);
  ok(!myEditor(dDupe.window.document).closest('.rebid').classList
       .contains('busy')
     && !myEditor(dDupe.window.document).classList.contains('committed'),
     'settled same→same is inert immediately: no busy sign or pulse');
  await sleep(30);
  dupeState = gas.handle({ action: 'state', aname: 'dupebid' });
  ok(dupePosts() === settledPosts
     && bidderNamed(dupeState, 'dot').bcount === 1
     && myEditor(dDupe.window.document).style.boxShadow === settledShadow,
     'settled same→same sends no POST and changes no count or card layer');

  /* Replicata: dreev 2026-07-27: "shouldn't the submit button gray
     out upon successful submission and reenable only when the field
     changes?" Expectata: the button is never live when pressing it
     would send nothing — mid-flight, holding exactly the words
     already on the wire, it grays (the same lastBid test placeBid's
     silent no-op uses); diverge and it wakes; and after a successful
     settle it doesn't merely gray, it RETIRES with the cooling field
     (hot = dirty). Resultata pre-fix: the visible button was always
     enabled, a live-looking control whose press did nothing. */
  const dRegray = await makePage('/regray?api=' + API_URL);
  addName(dRegray, 'ree');  // self-claims (2j)
  await settled(dRegray);
  mockDelay = 150;
  typeBid(dRegray, 'regrayed bid');
  submitBid(dRegray);
  ok(dRegray.window.document.querySelector('#tiles .rebid .go').disabled,
     'mid-flight, holding the words already on the wire: SUBMIT'
     + ' grays — pressing it would send nothing');
  typeBid(dRegray, 'regrayed bid!!');
  myEditor(dRegray.window.document).dispatchEvent(
    new dRegray.window.Event('input', { bubbles: true }));
  ok(!dRegray.window.document.querySelector('#tiles .rebid .go').disabled,
     'diverge from the flying text and SUBMIT wakes');
  typeBid(dRegray, 'regrayed bid');
  myEditor(dRegray.window.document).dispatchEvent(
    new dRegray.window.Event('input', { bubbles: true }));
  ok(dRegray.window.document.querySelector('#tiles .rebid .go').disabled,
     'return to the flying text and it grays again');
  await settled(dRegray);
  mockDelay = 0;
  ok(!dRegray.window.document.querySelector('#tiles .rebid')
       .classList.contains('hot'),
     'a successful settle retires the button outright: clean field,'
     + ' no dead control left standing');

  // Only CONSECUTIVE equality disappears. Returning to the standing
  // words while a different revision flies must queue the return;
  // comparing only with defaultValue would incorrectly eat it.
  mockDelay = 150;
  typeBid(dDupe, 'different bid');
  submitBid(dDupe);
  typeBid(dDupe, 'same bid');
  submitBid(dDupe);
  await settled(dDupe);
  mockDelay = 0;
  dupeState = gas.handle({ action: 'state', aname: 'dupebid' });
  ok(dupePosts() === 3
     && bidderNamed(dupeState, 'dot').bcount === 3,
     'same→different→same keeps all three submissions: only adjacent'
       + ' duplicates are no-ops');

  // A transport failure submits nothing, so retrying the same words is
  // not a duplicate. The first request dies before reaching mockFetch;
  // the recovery refresh and retry use the real bridge.
  const bridgedFetch = dDupe.window.fetch;
  let failNextBid = true;
  dDupe.window.fetch = (url, opts) => {
    const body = opts && opts.method === 'POST'
      ? JSON.parse(opts.body) : null;
    if (failNextBid && body && body.action === 'bid') {
      failNextBid = false;
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    return bridgedFetch(url, opts);
  };
  typeBid(dDupe, 'retry me');
  submitBid(dDupe);
  await until(() => !myEditor(dDupe.window.document).closest('.rebid')
    .classList.contains('busy'));
  submitBid(dDupe);
  await settled(dDupe);
  dupeState = gas.handle({ action: 'state', aname: 'dupebid' });
  ok(dupePosts() === 4
     && bidderNamed(dupeState, 'dot').bcount === 4,
     'a failed bid may be retried unchanged: one successful POST and row');

  /* --- 3. bob's window: alice's bid sealed there; his bid reveals ------- */
  const dom2 = await makePage('/tau?api=' + API_URL);
  const doc2 = dom2.window.document;
  await sleep(20);
  const sealed = doc2.getElementById('status').textContent;
  ok(tiles(doc2, '.has-bid').length === 1, 'second window sees alice bid');
  ok(!sealed.includes('three tacos'), "others' bids sealed in other windows");
  ok(doc2.querySelector('#status .tile-bid .masked')
     && !doc2.querySelector('#status .tile-bid .masked').textContent
          .includes('three tacos'),
     'sealed bid rendered as a masked decoy, not the real text');
  ok(row(doc2, 'alice').querySelector('.tu').classList.contains('taken')
     && !row(doc2, 'alice').querySelector('.tu').disabled,
     "alice's bid dibses her row — filled star, still live: usurping"
     + ' is possible (honor system) but never accidental');
  ok(/^bid submitted \d+[sm] ago$/.test(hoverBid(dom2, 'alice')),
     "someone else's single-submission tooltip drops the 'your', got "
     + hoverBid(dom2, 'alice'));
  claimRow(dom2, 'bob');
  typeBid(dom2, '$40 and my dignity');
  submitBid(dom2);
  await settled(dom2);
  ok(!doc2.getElementById('status').classList.contains('revealed')
     && !doc2.getElementById('status').textContent.includes('three tacos'),
     'roster complete: still sealed until someone presses reveal');
  const seal2 = doc2.getElementById('seal');
  ok(!seal2.disabled && seal2.classList.contains('ready'),
     'padlock unlocks when the roster is complete');
  ok(seal2.getAttribute('data-tip') === STR.revealTip,
     'everyone in: the tip offers the reveal');
  const preRevealTau = gas.handle({ action: 'state', aname: 'tau' });
  mockDelay = 150;
  seal2.click();
  ok(doc2.getElementById('status').classList.contains('stale'),
     'pressing the padlock shows busy AT ONCE: the gavel hammers while'
     + ' the reveal round-trips (dreev: "nothing seems to happen")');
  await until(() =>
    doc2.getElementById('status').classList.contains('revealed'));
  mockDelay = 0;
  ok(doc2.querySelector('#status .th-bid').textContent.includes('BIDS'),
     'BIDS column heading, before and after reveal');
  ok(doc2.getElementById('status').textContent.includes('three tacos')
     && myEditor(doc2).value === '$40 and my dignity',
     "both bids shown: alice's card and bob's own editable row");
  ok(tiles(doc2, '.has-bid').length === 2, 'all rows green after reveal');
  // (subs superscript shelved 2026-07-15)
  // ok([...doc2.querySelectorAll('#status .tile.has-bid .tile-subs')]
  //    .every((e) => parseInt(e.textContent, 10) >= 1),
  //    'invariant: green rows always count at least 1');
  ok(doc2.getElementById('status').classList.contains('revealed')
     && doc2.getElementById('status').classList.contains('just-revealed'),
     'reveal lights the tada and glows, once');
  ok(doc2.getElementById('status').classList.contains('prestrike'),
     'but until the mallet lands the seal still SAYS sealed: the 🎉'
     + " flip joins the strike's beat with SOLD (dreev lined them up)"
     + ' — the bids themselves unmask right away');
  await until(() => !doc2.getElementById('status').classList
    .contains('prestrike'));
  ok(true, 'the beat drops at STRIKE_MS: prestrike retires, the flip'
     + ' and the slam land together');
  ok(doc2.getElementById('roster-input').disabled,
     'the roster is closed once revealed: the + row is off');
  ok(/^Closed \d{4}-\d{2}-\d{2} \d{2}:\d{2} (Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/
       .test(doc2.querySelector('#status .closed').textContent),
     "the Closed line stamps the moment, dreev's exact format: "
     + doc2.querySelector('#status .closed').textContent);
  ok(doc2.querySelector('#status .fete .stamp')
     && doc2.querySelector('#status .fete .stamp').textContent === STAMP,
     'the reveal ceremony: the stamp slams down on the bid box');
  // the money flies on real physics: vendored canvas-confetti at
  // calpuz's speed (velocity 55, gravity 0.9), in ONE burst straight
  // off the gavel (dreev pared back the side cannons and topper) —
  // pinned here from the recorded call
  await until(() => dom2.window.__confettiCalls.length === 1);
  const burst = dom2.window.__confettiCalls[0];
  ok(burst.particleCount === 130
     && burst.startVelocity === 55 && burst.gravity === 0.9
     && burst.zIndex === 5  // below the tooltips' 6: tips beat money
     && burst.spread === 85 && burst.ticks === 2000
     && burst.shapes.length === STR.moneyGlyphs.length
     && burst.shapes.every((s, i) => s.text === STR.moneyGlyphs[i]),
     'one calpuz-speed burst: 130 money glyphs at velocity 55 under'
     + ' gravity 0.9');
  ok(burst.origin.x >= 0 && burst.origin.x <= 1
     && burst.origin.y >= 0 && burst.origin.y <= 1,
     "erupting from the gavel's block (a clamped viewport-fraction"
     + " origin — jsdom's zero-layout puts it at 0,0)");
  ok([...doc2.querySelectorAll('#tiles .tu')]
       .every((s) => s.disabled),
     'every star grays at the gavel: identity is part of the frozen'
     + ' record (found hunting dreev\'s one-more-bug)');
  ok(row(doc2, 'alice').querySelector('.rename input').disabled
     && !dom2.window.document.getElementById('seal')
          .hasAttribute('data-tip'),
     'the gavel freezes the NAMES too (dreev: a post-close rename'
     + ' could swap who bid what), and the lit tada needs no tip —'
     + ' revealed is self-evident');
  ok(myEditor(doc2) && myEditor(doc2).disabled
     && myEditor(doc2).value === '$40 and my dignity',
     'the gavel drop is a bright line: your bid stays READABLE in your'
     + ' editor but the field goes dead (2026-07-16, dreev — reversing'
     + ' the old permissive pin)');

  /* --- the under-the-wire race, LOST: an explicit notice ----------------
     Replicata: submit a revision while the last straggler's bid — and
     the reveal — land first. Expectata: the revision bounces with the
     gavel-fell error; the sheet keeps the pre-reveal bid. */
  gas.handle({ action: 'add', aname: 'wire',
    uname: 'ann', pid: 'pid-wire-ann' });
  gas.handle({ action: 'add', aname: 'wire',
    uname: 'zed', pid: 'pid-wire-zed' });
  gas.handle({ action: 'bid', aname: 'wire',
    uname: 'zed', pid: 'pid-wire-zed', bid: 'safe',
               deviceID: 'dz' });
  const domWire = await makePage('/wire?api=' + API_URL);
  claimRow(domWire, 'ann');
  typeBid(domWire, 'first thoughts');
  submitBid(domWire);
  await settled(domWire);
  mockDelay = 300;
  typeBid(domWire, 'second thoughts');
  submitBid(domWire);         // the revision takes flight...
  gas.handle({ action: 'reveal', aname: 'wire' });  // ...the gavel falls
  await settled(domWire);
  mockDelay = 0;
  ok(!domWire.window.document.getElementById('banner').hidden
     && domWire.window.document.getElementById('banner').textContent
          .includes(SCOPY.gavelFellCopy),
     'losing the under-the-wire race is announced explicitly, in'
     + " dreev's words");
  ok(bidNamed(gas.handle({ action: 'state', aname: 'wire' }), 'ann').bid === 'first thoughts',
     'the sheet keeps the bid that beat the gavel');

  /* --- the under-the-wire race you can't lose AGAINST YOURSELF ----------
     Replicata: everyone's in; you submit a revision and press the
     (lit) padlock while the revision still flies. Resultata pre-fix:
     the reveal bypassed the op chain and could overtake your own bid
     on the wire — Womp Womp by your own hand, with the OLD bid
     standing revealed under an editor showing the new text.
     Expectata: writes land in the order you made them — the reveal
     rides the same chain as every other write, so the revision
     stands. */
  gas.handle({ action: 'add', aname: 'selfwire',
    uname: 'ann', pid: 'pid-selfwire-ann' });
  gas.handle({ action: 'add', aname: 'selfwire',
    uname: 'zed', pid: 'pid-selfwire-zed' });
  gas.handle({ action: 'bid', aname: 'selfwire',
    uname: 'zed', pid: 'pid-selfwire-zed', bid: 'z',
               deviceID: 'dz' });
  const domSW = await makePage('/selfwire?api=' + API_URL);
  claimRow(domSW, 'ann');
  typeBid(domSW, 'first thoughts');
  submitBid(domSW);
  await settled(domSW);
  mockDelay = 500;             // the revision is slow...
  typeBid(domSW, 'final answer');
  submitBid(domSW);
  // a real reveal press blurs the editor first (any pointer gesture
  // does — and Chrome blurs on the disable itself, which jsdom does
  // not), so the qual supplies the blur the gesture implies
  myEditor(domSW.window.document).blur();
  mockDelay = 0;               // ...and the reveal press is instant
  domSW.window.document.getElementById('seal').click();
  await settled(domSW);
  await until(() => gas.handle({ action: 'state', aname: 'selfwire' })
    .revealed);
  ok(domSW.window.document.getElementById('banner').hidden,
     'no Womp Womp by your own hand: your reveal press never overtakes'
     + ' your still-flying revision');
  ok(bidNamed(gas.handle({ action: 'state', aname: 'selfwire' }), 'ann').bid === 'final answer',
     'the revision beat the gavel: writes land in click order');
  ok(myEditor(domSW.window.document).value === 'final answer'
     && myEditor(domSW.window.document).disabled,
     'and the frozen editor agrees with the revealed record');
  // The complement of the draft-at-the-gavel case (dreev's old bug
  // note "no submit button when the auction is closed"): a COMMITTED
  // bid's field is clean, so once the caret leaves it's cold, and the
  // reveal's repaints must not reheat it — no SUBMIT stands; only a
  // caught draft keeps its grayed, tip-wearing button
  ok(!myEditor(domSW.window.document).closest('.rebid')
       .classList.contains('hot'),
     'a clean frozen editor is cold: no SUBMIT on a closed auction'
     + ' without a draft');

  // first window catches up via polling (jsdom timers run; wait for it)
  await until(() =>
    doc.getElementById('status').textContent.includes('$40 and my dignity'));
  ok(doc.getElementById('status').textContent.includes('$40 and my dignity'),
     "first window sees bob's bid via polling after reveal");
  ok(doc.getElementById('status').classList.contains('just-revealed'),
     'the reveal moment animates in every watching window');
  ok(doc.querySelector('#status .fete'),
     'the watching window gets the ceremony too');
  await until(() =>  // window 2's own next poll retires its fanfare
    !doc2.getElementById('status').classList.contains('just-revealed'));
  ok(doc2.getElementById('status').classList.contains('revealed')
     && !doc2.getElementById('status').classList.contains('just-revealed'),
     'the reveal animation is one-shot');
  const late = await makePage('/tau?api=' + API_URL);
  await sleep(20);
  ok(late.window.document.getElementById('status').classList.contains('revealed')
     && !late.window.document.getElementById('status').classList
          .contains('just-revealed'),
     'arriving after the fact: lit tada, no fanfare');
  ok(!late.window.document.querySelector('#status .fete')
     && late.window.__confettiCalls.length === 0,
     'and no ceremony either: it belongs to the moment');
  ok(late.window.document.getElementById('status').textContent
       .includes('three tacos')
     && late.window.document.getElementById('status').textContent
       .includes('$40 and my dignity'),
     'a fresh window sees both revealed bids as cards');
  // ...but a STALE-CACHED window is a witness, not a latecomer: its
  // cache painted the auction still sealed, so the live snapshot's
  // reveal is news it watched arrive — fanfare and all (pinned as a
  // characterization of the arrival-latch semantics before folding
  // the latches into the one adopted-edge, 2026-07-19)
  const staleSeed = JSON.stringify(preRevealTau);
  const domStale = await makePage('/tau?api=' + API_URL, (w) =>
    w.localStorage.setItem('tauction-state:tau', staleSeed));
  await until(() => domStale.window.document.getElementById('status')
    .classList.contains('revealed'));
  ok(domStale.window.document.getElementById('status').classList
       .contains('just-revealed'),
     'a stale-unrevealed cache makes the arrival a WITNESSED reveal:'
     + ' the ceremony fires');
  await until(() => domStale.window.__confettiCalls.length > 0);
  ok(domStale.window.__confettiCalls.length > 0,
     '...money and all (the strike lands at its usual beat)');

  // the ceremony self-cleans: nothing left in the DOM afterward
  await sleep(4100);  // FETE_MS
  ok(!doc2.querySelector('#status .fete')
     && !doc2.getElementById('status').classList.contains('ceremony'),
     'the ceremony packs up after itself: no confetti litter');

  /* --- 3b0. the Schelling jackpot: every bid identical ------------------
     The help copy invites playing Schelling's coordination game, and
     all-identical revealed bids are that game WON. Replicata: two
     bidders, the same bid, reveal. Expectata: the ceremony knows —
     the stamp comes down reading the consensus copy (derived from
     stringles), and an echo after the strike, four corner cannons
     fire money that CONVERGES on the gavel's point of impact: a
     Schelling point is a focal point, made literal. The aim is
     pixel-true (aspect-ratio corrected), pinned here by recomputing
     every cannon's bearing from its own recorded burst. */
  gas.handle({ action: 'add', aname: 'jackpot',
    uname: 'ann', pid: 'pid-jackpot-ann' });
  gas.handle({ action: 'add', aname: 'jackpot',
    uname: 'bo', pid: 'pid-jackpot-bo' });
  gas.handle({ action: 'bid', aname: 'jackpot',
    uname: 'bo', pid: 'pid-jackpot-bo',
               bid: 'york', deviceID: 'db' });
  const domJk = await makePage('/jackpot?api=' + API_URL);
  claimRow(domJk, 'ann');
  typeBid(domJk, 'york');   // the minds meet
  submitBid(domJk);
  await settled(domJk);
  domJk.window.document.getElementById('seal').click();
  await until(() => domJk.window.document.getElementById('status')
    .classList.contains('revealed'));
  const jkStamp = domJk.window.document
    .querySelector('#status .fete .stamp');
  ok(jkStamp && jkStamp.textContent === STR.consensusStamp
     && jkStamp.classList.contains('consensus'),
     'all bids identical: the stamp comes down reading the consensus'
     + ' copy, not the sale');
  await until(() => domJk.window.__confettiCalls.length === 5);
  const jk = domJk.window.__confettiCalls;
  ok(jk.length === 5 && jk[0].particleCount === 130
     && jk[0].spread === 85,
     'the gavel-strike burst still fires first: the jackpot adds an'
     + ' echo, never replaces the verdict');
  const jkFocal = jk[0].origin;
  const jkCorners = jk.slice(1).map((c) => c.origin.x + ',' + c.origin.y)
    .sort().join(' ');
  ok(jkCorners === '0,0 0,1 1,0 1,1',
     'four cannons, one per viewport corner, got ' + jkCorners);
  ok(jk.slice(1).every((c) => {
    const want = Math.atan2(
      (c.origin.y - jkFocal.y) * domJk.window.innerHeight,
      (jkFocal.x - c.origin.x) * domJk.window.innerWidth)
      * 180 / Math.PI;
    return Math.abs(c.angle - want) < 1e-9
      && c.spread === 18 && c.startVelocity === 65 && c.gravity === 0.7
      && c.particleCount === 45 && c.ticks === 2000 && c.zIndex === 5
      && c.shapes.length === STR.moneyGlyphs.length;
  }), 'every cannon aims pixel-true at the point of impact: the money'
     + ' CONVERGES on the focal point');

  /* --- 3b. shimmer + stacks: re-bids glow anew in every window ---------- */
  gas.handle({ action: 'add', aname: 'wobble',
    uname: 'ann', pid: 'pid-wobble-ann' });
  gas.handle({ action: 'add', aname: 'wobble',
    uname: 'zed', pid: 'pid-wobble-zed' });
  const domA = await makePage('/wobble?api=' + API_URL);
  claimRow(domA, 'ann');
  typeBid(domA, 'first');
  submitBid(domA);
  await settled(domA);
  ok(tiles(domA.window.document, '.has-bid').length === 1, 'ann row green');
  const domB = await makePage('/wobble?api=' + API_URL);
  await sleep(20);
  ok(!tiles(domB.window.document, '.updated').length,
     'no shimmer before any update');
  await sleep(5);  // updated stamps must differ
  typeBid(domA, 'second');
  submitBid(domA);
  await settled(domA);
  const own = tiles(domA.window.document, '.updated');
  ok(own.length === 1 && own[0].querySelector('.rebid textarea').value === 'second',
     'own re-bid shimmers and holds the new text');
  // (subs superscript shelved 2026-07-15)
  // ok(own[0].querySelector('.tile-subs').textContent === '2',
  //    'counter ticks on re-submission');
  // the shape is DERIVED from stringles (dreev recapitalizes copy at
  // will): the template with the ago-slots as patterns
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const resubRe = new RegExp('^'
    + escRe(STR.resubmittedTip('@A@', '@B@'))
        .replace('@A@', '\\d+[smhd]').replace('@B@', '\\d+[smhd]')
    + '$');
  ok(resubRe.test(hoverBid(domA, 'ann')),
     're-submission tooltip matches the stringles template, got '
     + hoverBid(domA, 'ann'));
  ok(own[0].querySelector('.rebid textarea').style.boxShadow
       .includes('2px 2px'),
     're-bid stacks a sheet behind your card');
  await until(() =>  // domB polls
    tiles(domB.window.document, '.updated').length > 0);
  const shim = tiles(domB.window.document, '.updated');
  ok(shim.length === 1 && shim[0].dataset.uname === 'ann',
     "ann's row shimmers in another window after her re-bid");
  await until(() =>  // the next poll retires it
    !tiles(domB.window.document, '.updated').length);
  ok(!tiles(domB.window.document, '.updated').length, 'shimmer is one-shot');

  // [FLIPPED 2026-07-18, dreev per ZOI: the cap at 3 was an arbitrary
  // constant — sheets are UNCAPPED now; heavy revisers wear the pile]
  for (let k = 0; k < 4; k++) {
    await sleep(4);  // stamps must differ
    typeBid(domA, 'edit ' + k);
    submitBid(domA);
    await settled(domA);
  }
  const annRow = tiles(domA.window.document, '.has-bid')[0];
  ok(annRow.querySelector('.bid-card').style.boxShadow
       .includes('10px 10px'),
     'six submissions = five sheets, uncapped: the pile IS the'
     + ' disinducement');
  // (subs superscript shelved 2026-07-15)
  // ok(annRow.querySelector('.tile-subs').textContent === '6',
  //    'counter keeps the exact count past the cap');

  /* --- 3c. the stars are a radio — until your bid locks it --------------
     One click on another star switches who you are; your own lit star
     releases you to nobody. Placing a bid ends the shopping: every
     star locks, yours included (trying this per dreev; the old
     switch-after-bidding flow, with its multi-identity bid memory,
     died here with his blessing). */
  gas.handle({ action: 'add', aname: 'switcheroo',
    uname: 'alice', pid: 'pid-switcheroo-alice' });
  gas.handle({ action: 'add', aname: 'switcheroo',
    uname: 'bob', pid: 'pid-switcheroo-bob' });
  gas.handle({ action: 'add', aname: 'switcheroo',
    uname: 'cam', pid: 'pid-switcheroo-cam' });
  const domS = await makePage('/switcheroo?api=' + API_URL);
  const docS = domS.window.document;
  claimRow(domS, 'alice');
  claimRow(domS, 'bob');  // radio: one click switches alice -> bob
  ok(domS.window.localStorage.getItem('tauction-uname') === 'bob'
     && row(docS, 'bob').querySelector('.tu').classList.contains('selected'),
     'one click on another star switches who you are (bidless: free)');
  claimRow(domS, 'bob');  // your own lit star: release to nobody
  ok(!docS.querySelector('#tiles .tu.selected')
     && !docS.querySelector('#tiles .rebid'),
     'clicking your lit star releases: nobody again, no editor');
  claimRow(domS, 'bob');
  ok(myEditor(docS).value === '' && myEditor(docS).placeholder === '',
     'a fresh claim starts a fresh, blank editor (bob has no bid yet)');
  typeBid(domS, 'second secret');
  submitBid(domS);
  await settled(domS);
  ok([...tiles(docS)].every((t) => t.querySelector('.tu').disabled)
     && row(docS, 'bob').querySelector('.tu').classList
          .contains('selected'),
     'your bid locks the whole radio; your star stays lit');
  claimRow(domS, 'cam');  // a locked star: the click must be inert
  ok(domS.window.localStorage.getItem('tauction-uname') === 'bob'
     && row(docS, 'cam').querySelector('.tu').getAttribute('data-tip')
          === 'Too late to claim as you',
     'clicking a locked star does nothing, and its tip says so');
  const domT = await makePage('/switcheroo?api=' + API_URL);
  await sleep(20);
  const otherSees = domT.window.document.getElementById('status').textContent;
  ok(domT.window.document.querySelectorAll('#status .tile-bid .masked')
       .length === 1
     && !otherSees.includes('secret'),
     "other windows see bob's sealed bid, no text");

  /* --- 3e. bid response landing after you switch auctions ---------------
     Replicata: submit a bid, then switch to another auction while the POST
     is in flight. Expectata: the bid is remembered under the auction it
     was placed on. */
  const domR = await makePage('/race?api=' + API_URL);
  addName(domR, 'carl');  // self-claims (2j)
  typeBid(domR, 'zoom zoom');
  mockDelay = 600;  // response lands after the 500ms auction-switch debounce
  submitBid(domR);
  // [REWRITTEN 2026-07-18, names-are-chosen-once: the old hazard —
  // switching auctions while the bid flew — is unrepresentable now,
  // and the pin is that it IS]
  ok(domR.window.document.getElementById('aname').disabled,
     'no auction-hopping mid-bid or ever: the name field is stone');
  await until(() => domR.window.localStorage
    .getItem('tauction-mybids:race') !== null);
  mockDelay = 0;
  ok(Object.values(JSON.parse(
       domR.window.localStorage.getItem('tauction-mybids:race') || '{}'))
       .includes('zoom zoom'),
     'bid remembered under the auction it was placed on (pid-keyed)');

  /* --- 3g. submitting shows progress; the editor stays HOT --------------
     (dreev: down to the wire you might change your mind while your
     bid is still in flight — resubmitting must work. The old pinned
     behavior disabled the input mid-flight; reversed at his ask.) */
  const domP = await makePage('/progress?api=' + API_URL);
  addName(domP, 'pat');  // self-claims (2j)
  await sleep(800);  // roster push done: the bid is the only POST in flight
  await sleep(50);   // the claim's response lands; no mid-bid rebuild
  typeBid(domP, 'hurry');
  mockDelay = 200;
  submitBid(domP);
  await sleep(50);
  ok(domP.window.document.querySelector('#tiles .rebid').classList
       .contains('busy')
     && !myEditor(domP.window.document).disabled,
     'your row shows busy while the bid flies — and the editor stays'
     + ' live for a change of heart');
  // the change of heart, mid-flight:
  typeBid(domP, 'hurry HARDER');
  submitBid(domP);
  ok(domP.window.document.querySelector('#tiles .rebid').classList
       .contains('busy'),
     'the resubmission rides along (still busy)');
  await until(() => gas.handle({ action: 'state', aname: 'progress' })
    .bidders.length === 1 && gas.handle({ action: 'state',
    aname: 'progress' }).bidders[0].bcount === 2);
  await settled(domP);
  mockDelay = 0;
  ok(!domP.window.document.querySelector('#tiles .rebid').classList
       .contains('busy'),
     'busy clears only after the LAST submission settles');
  // (the bids tab is an append-only log now: the standing bid is the
  // LAST row, and both submissions are on the record)
  const progressRows = gas.__ss.sheets['bids'].data
    .filter((r) => r[0] === 'progress');
  ok(progressRows.length === 2
     && progressRows[1][2] === 'hurry HARDER',
     'the log holds both; the later row wins: client-serialized, last'
     + ' word standing');
  ok(myEditor(domP.window.document).value === 'hurry HARDER',
     'and the editor agrees');

  /* --- 3h. the 5s poll must not eat a bid you are mid-typing ------------
     Replicata: claim your row, type a draft, don't submit, wait out a
     poll (which rebuilds every row). Expectata: draft, focus, and caret
     survive the rebuild. */
  const domD = await makePage('/draft?api=' + API_URL);
  addName(domD, 'dan');  // self-claims (2j)
  myEditor(domD.window.document).focus();  // click into your editor
  typeBid(domD, 'half a tho');
  myEditor(domD.window.document).setSelectionRange(4, 4);
  // wait for a poll to actually go out (a fixed sleep can miss a late
  // one, making "survives the poll" pass vacuously), then let its
  // response land and render
  const polls0 = apiCalls.filter((c) => c.action === 'state'
    && c.aname === 'draft').length;
  await until(() => apiCalls.filter((c) => c.action === 'state'
    && c.aname === 'draft').length > polls0);
  await sleep(100);
  ok(myEditor(domD.window.document).value === 'half a tho',
     'draft bid survives the poll rebuild');
  ok(domD.window.document.activeElement === myEditor(domD.window.document),
     'focus survives the poll rebuild');
  ok(myEditor(domD.window.document).selectionStart === 4,
     'caret position survives the poll rebuild');

  /* --- 3j. long bids: a wrapping, MULTILINE editor ----------------------
     [The one-line semantics retired 2026-07-27 on dreev's "sure to
     newline thing": Enter still commits (42⏎ is sacred) and eats the
     keystroke; Shift+Enter is the newline gesture; a pasted newline
     stays a newline. Box-growth layout truths live in story-quals.] */
  const domW = await makePage('/wrap?api=' + API_URL);
  addName(domW, 'wes');  // self-claims (2j)
  typeBid(domW, 'a very fine bid');
  const swallowed = !myEditor(domW.window.document).dispatchEvent(
    new domW.window.KeyboardEvent('keydown',
      { key: 'Enter', bubbles: true, cancelable: true }));
  await settled(domW);
  ok(swallowed
     && gas.handle({ action: 'state', aname: 'wrap' }).bidders.length === 1,
     "Enter commits the bid via the editor's own keydown — and eats"
     + ' the keystroke (it must never become a newline)');
  const wrapBids = () => apiCalls.filter((c) => c.action === 'bid'
    && c.aname === 'wrap').length;
  const wrapBids0 = wrapBids();
  const passedThrough = myEditor(domW.window.document).dispatchEvent(
    new domW.window.KeyboardEvent('keydown',
      { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
  await sleep(60);
  ok(passedThrough && wrapBids() === wrapBids0,
     'Shift+Enter is no commit: the keystroke passes through to'
     + ' become a newline (jsdom does no text editing; the Chrome'
     + ' truth lives in story 7b)');
  typeBid(domW, 'line one\nline two');
  // a real paste is a value change plus one input event (typeBid
  // alone skips the event; nothing else in the suite needs it)
  myEditor(domW.window.document).dispatchEvent(
    new domW.window.Event('input', { bubbles: true }));
  ok(myEditor(domW.window.document).value === 'line one\nline two',
     'a pasted newline STAYS a newline: bids are multiline now');
  submitBid(domW);
  await settled(domW);
  ok(myEditor(domW.window.document).defaultValue === 'line one\nline two',
     'the multiline bid is accepted verbatim: the newline reaches'
     + ' the record');
  // [the maxLength clamp REPLACED same-day (dreev: "i don't like how
  // it abruptly cuts me off... it should make it obvious"): no
  // keystroke is ever eaten — past 160 the field objects live, and
  // submit is refused LOCALLY, in the server's exact words]
  typeBid(domW, 'x'.repeat(161));
  myEditor(domW.window.document).dispatchEvent(
    new domW.window.Event('input', { bubbles: true }));
  ok(myEditor(domW.window.document).value.length === 161
     && myEditor(domW.window.document).classList.contains('error'),
     'past 160 chars every keystroke still lands, and the field'
     + ' reddens live');
  const bids0 = apiCalls.filter((c) => c.action === 'bid').length;
  submitBid(domW);
  await sleep(60);
  ok(apiCalls.filter((c) => c.action === 'bid').length === bids0
     && !domW.window.document.getElementById('banner').hidden
     && domW.window.document.getElementById('banner-msg').textContent
          === SCOPY.bidTooLongCopy
     && myEditor(domW.window.document).value === 'x'.repeat(161),
     'an overlong submit is refused before the wire, in the'
     + " server's exact words, the draft intact for trimming");
  typeBid(domW, 'x'.repeat(160));
  myEditor(domW.window.document).dispatchEvent(
    new domW.window.Event('input', { bubbles: true }));
  ok(!myEditor(domW.window.document).classList.contains('error'),
     'trimmed back under the limit, the objection withdraws itself');

  /* --- 3k. writes fly SIGNLESS (dreev 2026-07-28, the no-spinners
     ruling, superseding both 2026-07-21's desc-local mini gavel and
     2026-07-27's row-local ones): no roster op, claim, release, or
     blurb save grays or gavels ANYTHING. The commit pulse is the
     feedback; failures banner; the one gavel + table gray remain
     for untrusted-picture moments only (arrival, transport failure,
     the typed-name probe, the reveal). ----------------------------- */
  const domY = await makePage('/descbusy?api=' + API_URL);
  mockDelay = 250;
  addName(domY, 'gia');  // self-claims (2j)
  const docY = domY.window.document;
  const noSigns = () => !docY.querySelector('.stale')
    && !docY.querySelector('.gavel.mini');
  ok(noSigns(), 'an add in flight: no gray, no gavel, anywhere');
  await until(() => drained(domY));
  addName(domY, 'hal');
  await until(() => drained(domY));
  renameTo(domY, 'hal', 'harold');
  ok(noSigns(), 'a rename in flight: nothing');
  await until(() => drained(domY));
  row(docY, 'harold').querySelector('.x').click();
  ok(noSigns(), 'a remove in flight: nothing');
  await until(() => names(gas.handle(
    { action: 'state', aname: 'descbusy' })) === 'gia');
  row(docY, 'gia').querySelector('.tu').click();  // release the seat
  ok(noSigns(), 'a release in flight: nothing');
  await until(() => drained(domY));
  row(docY, 'gia').querySelector('.tu').click();  // claim it back
  ok(noSigns(), 'a claim in flight: nothing — clicking into an empty'
     + ' bid cell hammers no gavel at all');
  mockDelay = 0;
  await until(() => drained(domY));
  mockDelay = 250;
  docY.getElementById('descedit').value = 'brunch rules';
  docY.getElementById('descedit').dispatchEvent(
    new domY.window.Event('input', { bubbles: true }));
  docY.getElementById('descgo').click();
  ok(noSigns(),
     'a blurb save in flight: nothing busy either — the instant'
     + ' rendered paint is the whole show');
  mockDelay = 0;
  await until(() => drained(domY));

  /* --- 3i. keyed node reuse: rows keep their DOM nodes across CHANGE-ful
     renders too, so a mid-gesture click or focused editor can never be
     destroyed by someone else's update arriving. */
  gas.handle({ action: 'add', aname: 'reuse',
    uname: 'ann', pid: 'pid-reuse-ann' });
  gas.handle({ action: 'add', aname: 'reuse',
    uname: 'zed', pid: 'pid-reuse-zed' });
  const domN = await makePage('/reuse?api=' + API_URL);
  const annBefore = row(domN.window.document, 'ann');
  gas.handle({ action: 'bid', aname: 'reuse',
    uname: 'zed', pid: 'pid-reuse-zed', bid: 'zzz' });
  await until(() =>  // a poll brings a genuinely CHANGED state
    row(domN.window.document, 'zed').classList.contains('has-bid'));
  ok(row(domN.window.document, 'zed').classList.contains('has-bid'),
     "the poll landed: zed's row went green");
  ok(row(domN.window.document, 'ann') === annBefore,
     "ann's node survived the change-ful render (keyed reuse)");

  // property: row updates are idempotent — a row that went A -> B -> A
  // must render identical to a fresh page's row at A (modulo the
  // wall-clock breathe phase)
  const strip = (h) => h.replace(/animation-delay:[^;"]*;?/g, '');
  gas.handle({ action: 'add', aname: 'idem',
    uname: 'pip', pid: 'pid-idem-pip' });
  gas.handle({ action: 'add', aname: 'idem',
    uname: 'quo', pid: 'pid-idem-quo' });
  const domI = await makePage('/idem?api=' + API_URL);
  claimRow(domI, 'pip');   // A -> B: pip becomes mine (editor appears)
  claimRow(domI, 'pip');   // B -> A: released again
  await sleep(100);        // the claim/release ops land
  const domJ = await makePage('/idem?api=' + API_URL);
  await sleep(20);
  ok(strip(row(domI.window.document, 'pip').outerHTML)
     === strip(row(domJ.window.document, 'pip').outerHTML),
     'row updates are idempotent: A->B->A equals a fresh render of A');

  /* --- 3f. a hand-written log row (sheet surgery) still counts ----------
     [reworked for the 2026-07-17 append-only log: the old fixture
     seeded a blank-bcount legacy row; bcount is derived now, so a
     bare (aname, uname, bid, tbid) row IS the whole story] ------- */
  gas.__ss.sheets['users'].appendRow(['legacy', 'pid-legacy-oldtimer',
    'oldtimer', '', '', '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z', '']);
  gas.__ss.sheets['bids'].appendRow(['legacy', 'pid-legacy-oldtimer',
    'ancient bid', '2026-01-01T00:00:00.000Z']);
  const domL = await makePage('/legacy?api=' + API_URL);
  const rowL = tiles(domL.window.document, '.has-bid')[0];
  ok(rowL && /^bid submitted \d+d ago$/
       .test(hoverBid(domL, 'oldtimer')),
     'a lone log row derives one submission: tooltip takes the single-'
     + 'submission branch, got ' + hoverBid(domL, 'oldtimer'));
  ok(rowL.querySelector('.bid-card').style.boxShadow === 'var(--lift)',
     'legacy row: single card, no sheets');

  /* Replicata (Sol's audit #5): the route regex accepted 40 chars
     while the server refuses past 20, so /twentyoneletterslong21
     adopted an unusable name — every poll refused, page dead.
     Expectata: an overlong slug is NOT a name; the page lands as
     the unnamed one-action page, name field ready. */
  const dLongSlug = await makePage('/' + 'x'.repeat(21) + '?api='
    + API_URL);
  await sleep(80);
  ok(!dLongSlug.window.document.getElementById('aname').disabled
     && dLongSlug.window.document.getElementById('aname').value === ''
     && dLongSlug.window.document.body.classList.contains('unnamed')
     && apiCalls.every((c) => c.aname !== 'x'.repeat(21)),
     'an overlong slug is no name at all: the page lands unnamed,'
     + ' ready to start fresh, and nothing unaskable goes to the'
     + ' wire');

  /* --- 4. switching auctions via the auction field; grayed while loading
     (a fresh page: its first 5s poll can't be mid-flight during the
     switch, which would defer the reload to the next poll) ------------- */
  apiCalls = [];
  const dom4 = await makePage('/?api=' + API_URL);
  const doc4 = dom4.window.document;
  mockDelay = 150;
  type(dom4, 'aname', 'Pie-Split');
  ok(doc4.getElementById('aname').value === 'piesplit', 'slug sanitized');
  commitName(dom4);  // the deliberate gesture; the probe is in flight
  ok(!doc4.getElementById('status').hidden
     && doc4.getElementById('status').classList.contains('stale'),
     'bids box stays visible while loading, just grayed');
  await sleep(600);
  mockDelay = 0;
  ok(!doc4.getElementById('status').classList.contains('stale'),
     'box ungrays once loaded');
  ok(dom4.window.location.pathname === '/piesplit', 'URL follows slug edit');

  addName(dom4, 'dee');
  addName(dom4, 'evy');
  ok(tiles(doc4).length === 2
     && row(doc4, 'evy') !== null,
     'named empty rows for the roster');
  await sleep(800); // settings debounce
  ok(apiCalls.some((c) => c.action === 'add' && c.uname === 'dee')
     && apiCalls.some((c) => c.action === 'add' && c.uname === 'evy'),
     'adds pushed to the server as row ops');

  // dee self-claimed at her add (2j)
  typeBid(dom4, 'i bid 2 dishes');
  submitBid(dom4);
  await until(() => row(doc4, 'dee').classList.contains('has-bid'));
  ok(myEditor(doc4).value === 'i bid 2 dishes', 'own roster bid visible');
  ok(row(doc4, 'dee').classList.contains('has-bid')
     && !row(doc4, 'evy').classList.contains('has-bid'),
     'dee green, evy still empty');
  ok(row(doc4, 'evy').querySelector('.bid-card.slot')
     && !row(doc4, 'evy').querySelector('.rebid'),
     "evy's row holds an empty card, awaiting her bid");

  /* --- 4b. bid-then-removed no longer EXISTS as a state ----------------
     [REWRITTEN 2026-07-19, dreev: "just say no removing someone if
     they've bid" — the whole crossed-out-row state died with that
     rule.] A concurrent remove that races a bid bounces off the
     server; the other order self-heals because a bid rebuilds its
     seat. Either way every rendered row is a full member. */
  gas.handle({ action: 'add', aname: 'cutcheck',
    uname: 'pat', pid: 'pid-cutcheck-pat' });
  gas.handle({ action: 'add', aname: 'cutcheck',
    uname: 'quinn', pid: 'pid-cutcheck-quinn' });
  gas.handle({ action: 'bid', aname: 'cutcheck',
    uname: 'pat', pid: 'pid-cutcheck-pat', bid: 'stays' });
  const cutRefusal = gas.handle({ action: 'remove', aname: 'cutcheck',
    pid: 'pid-cutcheck-pat' });  // the raced removal, refused
  const domC = await makePage('/cutcheck?api=' + API_URL);
  const patRow = row(domC.window.document, 'pat');
  ok(String(cutRefusal.error) === SCOPY.removeBidderCopy
     && patRow && patRow.classList.contains('has-bid')
     && !patRow.classList.contains('cut')
     && patRow.querySelector('.x').disabled
     && patRow.querySelector('.x').getAttribute('data-tip')
          === STR.tooLateRemoveTip('pat'),
     'a raced remove of a bidder is refused: the row stands, whole,'
     + " its × gray with dreev's too-late tip");
  // the other race order: quinn's seat is removed while her first
  // bid flies; the bid rebuilds the seat — same pid, self-healed
  gas.handle({ action: 'remove', aname: 'cutcheck',
    pid: 'pid-cutcheck-quinn' });
  gas.handle({ action: 'bid', aname: 'cutcheck',
    uname: 'quinn', pid: 'pid-cutcheck-quinn', bid: 'back in' });
  const domC2 = await makePage('/cutcheck?api=' + API_URL);
  ok(row(domC2.window.document, 'quinn') !== null
     && row(domC2.window.document, 'quinn').classList.contains('has-bid'),
     "quinn's in-flight bid rebuilt her removed seat: the race heals");

  /* --- 4c. RETIRED 2026-07-18 (names-are-chosen-once): its replicata
     — switching auctions while a poll's response was in flight — is
     unrepresentable now. Polls run only on named pages; the name
     field is stone there. The refresh() mid-flight refire it pinned
     is deleted as dead code. ------------------------------------- */

  /* --- 5. XSS: a bid with markup renders inert; walk-ons show cut ------- */
  gas.handle({ action: 'bid', aname: 'piesplit',
    uname: 'rando', pid: 'pid-piesplit-rando', bid: 'me too!' });
  const gasRes = gas.handle({ action: 'bid', aname: 'piesplit',
    uname: 'evy',
    pid: pidOf(gas.handle({ action: 'state', aname: 'piesplit' }), 'evy'),
    bid: '<img src=x onerror=alert(1)>' });
  ok(gasRes.revealed === false, 'roster complete -> still sealed');
  ok(gas.handle({ action: 'reveal', aname: 'piesplit' }).revealed,
     'revealed by the button');
  await sleep(5100); // poll
  const html4 = doc4.getElementById('status').innerHTML;
  ok(!html4.includes('<img'), 'bid markup not injected as HTML');
  ok(doc4.getElementById('status').textContent.includes('<img src=x'),
     'bid markup shown as text');
  ok(!row(doc4, 'rando').classList.contains('cut'),
     "bidding joined @rando to the roster: not crossed out");

  /* --- 6. no 404 dead-ends: 404.html IS the app -------------------------
     (404.html is a derived artifact; quals inspect rather than rewriting
     it, so forgetting the explicit sync-404 step fails loudly.)
     Replicata: navigate straight to /tau, or reload there. GitHub Pages
     answers unknown paths with 404.html. Expectata: that IS the app, booted
     at /tau — no bounce, no flash, nothing to dead-end. */
  ok(fs.readFileSync(path.join(REPO, '404.html'), 'utf8') === INDEX_HTML,
     '404.html is an exact copy of index.html (fix: npm run sync-404)');
  const domBack = await makePage('/tau?api=' + API_URL);
  ok(domBack.window.document.getElementById('aname').value === 'tau',
     'direct navigation lands on the auction');
  ok(domBack.window.document.getElementById('status').textContent.includes('three tacos'),
     'revealed bids visible on direct navigation');

  /* --- 4d. typed names CREATE; joining is by URL only (dreev's rule) ----
     Typing a name that already has data refuses with a pointer to the
     URL, so nobody stumbles into a stranger's auction by picking
     "pizza". Following a link always joins. */
  gas.handle({ action: 'add', aname: 'occupied',
    uname: 'stranger', pid: 'pid-occupied-stranger' });
  const domG = await makePage('/?api=' + API_URL);
  type(domG, 'aname', 'occupied');
  commitName(domG);
  await until(() =>  // the refusal banner is the positive signal
    !domG.window.document.getElementById('banner').hidden);
  ok(domG.window.location.pathname === '/',
     'typing an occupied name does not navigate');
  ok(!domG.window.document.getElementById('banner').hidden
     && domG.window.document.getElementById('banner-msg').textContent
          === STR.auctionExistsBanner('/fresh1').replace(/<[^>]+>/g, ''),
     "the refusal says why, in dreev's words");
  ok(!domG.window.document.getElementById('status').classList
       .contains('stale'),
     'the old ledger comes back to life after the refusal');
  // dreev saw (or thought he saw) a SILENT failure once: pin that a
  // repeat attempt after the banner is dismissed banners again
  domG.window.document.getElementById('banner').hidden = true;
  type(domG, 'aname', 'occupied');
  commitName(domG);
  await until(() =>
    !domG.window.document.getElementById('banner').hidden);
  ok(!domG.window.document.getElementById('banner').hidden
     && domG.window.location.pathname === '/',
     'retyping the taken name banners again: refusal is never silent');
  const domG2 = await makePage('/occupied?api=' + API_URL);
  await sleep(20);
  ok(row(domG2.window.document, 'stranger'),
     'the URL always joins: that is what links are for');

  // a path that isn't a slug is nobody's auction: the unnamed idle
  // state, ready for the user to pick (no invented names)
  const domWeird = await makePage('/no/such/path?api=' + API_URL);
  ok(domWeird.window.document.getElementById('aname').value === ''
     && domWeird.window.document.getElementById('roster-input').disabled,
     'a non-slug path lands on the unnamed idle state, not an invented'
     + ' auction');
  ok(domWeird.window.location.search.includes('api='),
     '?api= preserved on the fresh-auction redirect');

  /* --- 7. the commit pulse: a gesture visibly TAKES (dreev's ruling,
     2026-07-19: submit-button legibility without submit buttons — a
     one-shot ring on the field the instant its write queues; the
     outgoing twin of the incoming shimmer). The negatives matter as
     much as the positives: a gesture that queues NOTHING must never
     flash, or the pulse becomes a lie. ------------------------------- */
  const dPulse = await makePage('/?api=' + API_URL);
  const pdoc = dPulse.window.document;
  // negative first: naming an OCCUPIED auction is refused at the gate
  type(dPulse, 'aname', 'occupied');
  commitName(dPulse);
  await until(() => !pdoc.getElementById('banner').hidden);
  ok(!pdoc.getElementById('aname').classList.contains('committed'),
     'a gate-refused name does not pulse: nothing was committed');
  // positive: a fresh name takes, and the field says so
  type(dPulse, 'aname', 'pulse');
  commitName(dPulse);
  await until(() =>
    pdoc.getElementById('aname').classList.contains('committed'), 2000);
  ok(pdoc.getElementById('aname').classList.contains('committed'),
     'a name that takes pulses once: the commit is visible');
  // the + row: an add queues a write and pulses; junk does not
  addName(dPulse, 'pip');
  ok(pdoc.getElementById('roster-input').classList.contains('committed'),
     'adding a person pulses the + row the instant the write queues');
  await settled(dPulse);
  pdoc.getElementById('roster-input').classList.remove('committed');
  addName(dPulse, '@#$%');
  ok(!pdoc.getElementById('roster-input').classList.contains('committed')
     && pdoc.getElementById('roster-input').classList.contains('error'),
     'junk in the + row reddens but never pulses: no write queued');
  // the bid editor: an empty submit is a local slip (no pulse); a
  // real bid pulses at submit time, before any response lands
  typeBid(dPulse, '');
  submitBid(dPulse);
  ok(!myEditor(pdoc).classList.contains('committed')
     && myEditor(pdoc).classList.contains('error'),
     'an empty bid reddens but never pulses');
  typeBid(dPulse, '7 tacos');
  submitBid(dPulse);
  ok(myEditor(pdoc).classList.contains('committed'),
     'a bid pulses the moment it is away, not when the server answers');
  await settled(dPulse);
  // a rename: same-name snap-back is a non-event; a real edit pulses
  renameTo(dPulse, 'pip', 'pip');
  ok(!row(pdoc, 'pip').querySelector('.rename input').classList
       .contains('committed'),
     'a rename to the same name snaps back without a pulse');
  renameTo(dPulse, 'pip', 'quinn');
  ok(row(pdoc, 'quinn').querySelector('.rename input').classList
       .contains('committed'),
     'a real rename pulses its field');
  await settled(dPulse);
  // the description: an untouched blur commits nothing; SAVE
  // commits, and the card ring says so
  const pedit = pdoc.getElementById('descedit');
  pedit.dispatchEvent(new dPulse.window.Event('blur'));
  ok(!pdoc.getElementById('desc').classList.contains('committed'),
     'an untouched description blur commits nothing and shows nothing');
  pedit.value = 'pulse notes';
  pedit.dispatchEvent(new dPulse.window.Event('input', { bubbles: true }));
  pdoc.getElementById('descgo').click();
  ok(pdoc.getElementById('desc').classList.contains('committed'),
     'SAVE commits the description and pulses the card');
  await settled(dPulse);

  /* --- 8. banners STICK (dreev's ruling, 2026-07-19): bad news stays
     until dismissed by its × or retired by a later successful settle —
     no timer may snatch it while you read. --------------------------- */
  const dStick = await makePage('/?api=' + API_URL);
  const sdoc = dStick.window.document;
  type(dStick, 'aname', 'stick');
  commitName(dStick);
  await until(() => dStick.window.location.pathname === '/stick');
  addName(dStick, 'sam');    // mine (the fresh-add latch)
  addName(dStick, 'tara');   // a guest
  await settled(dStick);
  // capture everything the page schedules while the bad news arrives:
  // a self-destruct timer here is the exact bug this section outlaws
  const scheduled = [];
  const pageSetTimeout = dStick.window.setTimeout;
  dStick.window.setTimeout = function (fn, ms) {
    scheduled.push(ms);
    return pageSetTimeout.apply(this, arguments);
  };
  renameTo(dStick, 'tara', 'sam');  // local collision: instant bad news
  dStick.window.setTimeout = pageSetTimeout;
  ok(!sdoc.getElementById('banner').hidden
     && !scheduled.some((ms) => ms >= 1000),
     'bad news arrives with NO self-destruct scheduled: it waits to be'
     + ' read');
  // the × dismisses (short-circuit: the click only fires if the
  // button exists, so a missing × fails the assert, not the run)
  const bx = sdoc.getElementById('banner-x');
  ok(bx !== null && (bx.click(), sdoc.getElementById('banner').hidden),
     'the banner carries its own × and the × dismisses it');
  // a later SUCCESSFUL settle retires stale bad news (the error it
  // answered is over; the durable signal — the red field — remains)
  renameTo(dStick, 'tara', 'sam');  // bad news again
  ok(!sdoc.getElementById('banner').hidden, 'the collision banners again');
  renameTo(dStick, 'tara', 'uma');  // a good op
  await settled(dStick);
  ok(sdoc.getElementById('banner').hidden
     && row(sdoc, 'uma') !== null,
     'a successful settle retires the stale banner');

  console.log('frontend-quals: all ' + passed + ' assertions passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
