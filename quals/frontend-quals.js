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
let apiCalls = [];
let geoHits = 0;  // ipwho.is fixture servings (the cache quals count)
let mockDelay = 0;  // artificial latency, for in-flight race quals

// Overlapping write ops pile onto the server's script lock; track
// whether the client ever has two in flight at once
const OPS = ['add', 'remove', 'claim', 'release'];
let opsInFlight = 0;
let opsOverlapped = false;

const WRITES = ['add', 'remove', 'claim', 'release', 'bid', 'reveal'];

// Simulate an outdated deployed server whose payloads predate the
// current shape (it was bidders[].created when this bit dreev)
let stripTini = false;

function mockFetch(url, opts) {
  url = String(url);
  // the geo lookup gets a fixture: quals must never touch the network
  if (url.includes('ipwho.is')) {
    geoHits++;
    return Promise.resolve({ json: () =>
      Promise.resolve({ city: 'Portland', region_code: 'OR' }) });
  }
  if (!url.startsWith(API_URL)) return Promise.reject(new Error('unexpected URL ' + url));
  let req;
  if (opts && opts.method === 'POST') req = JSON.parse(opts.body);
  else req = Object.fromEntries(new URL(url).searchParams);
  apiCalls.push(req);
  if (OPS.includes(req.action)) {
    opsInFlight++;
    if (opsInFlight > 1) opsOverlapped = true;
  }
  // Fidelity matters here: reads snapshot the moment they're requested
  // (a slow response still shows old state), but writes only commit
  // when they land — like the real locked server working its queue.
  const read = WRITES.includes(req.action) ? null : gas.handle(req);
  return new Promise((resolve) => setTimeout(() => {
    if (OPS.includes(req.action)) opsInFlight--;
    const res = read !== null ? read : gas.handle(req);
    if (stripTini && res.bidders) {
      res.bidders.forEach((b) => { delete b.tini; });
    }
    resolve({ json: () => Promise.resolve(res) });
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
  + ' awaitingTip, auctionExistsBanner, simulEditsBanner, stampCopy,'
  + ' claimedByTip, mysteryDevice, nameTakenBanner,'
  + ' moneyGlyphs, revealTip };')();
const STAMP = STR.stampCopy;

// ...and the server's half, out of the vm context hosting Code.gs
const SCOPY = require('vm')
  .runInContext('({ gavelFellCopy, simulEditsCopy, mysteryDeviceCopy,'
    + ' nameTakenCopy })', gas);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait (bounded) for a condition instead of sampling at a fixed delay:
// a loaded machine stretches the 5s poll past any fixed sleep's slack,
// which made fixed-sleep asserts flake ~1 run in 5. The caller re-asserts
// the condition right after, so a timeout still fails loudly there.
async function until(fn, ms = 10000) {
  const t0 = Date.now();
  while (!fn() && Date.now() - t0 < ms) await sleep(25);
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
  dom.window.document.querySelector('#tiles .rebid input').value = text;
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
    && !doc.getElementById('status').classList.contains('stale');
});

const myInput = (doc) => doc.querySelector('#tiles .tile.mine .rebid input');

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
  cell.dispatchEvent(new dom.window.Event('mouseenter'));
  return cell.getAttribute('data-tip');
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
  '[data-tip]::before': 6,   // a summoned tip outranks everything ours
  '.fete': 5,                // ...except it: the SOLD stamp moment
  '#banner': 4,              // ambient news over content
  '.gavel': 2,               // the busy sign over the grayed ledger
  '.corner': 2,              // share/help float over the aname card
  '.rebid .gavel.mini': 1,   // the row-local busy sign
};                           // (the confetti canvas rides above all
                             // at the library's 100, by design)
const zFound = {};
for (const m of STYLE_CSS.matchAll(/z-index:\s*(\d+)/g)) {
  const start = STYLE_CSS.lastIndexOf('}', m.index) + 1;
  const sel = STYLE_CSS.slice(start, m.index)
    .replace(/\/\*[^]*?\*\//g, '').split('{')[0].trim()
    .replace(/\s+/g, ' ');
  zFound[sel] = parseInt(m[1], 10);
}

(async () => {
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
     && MANIFEST.icons.length >= 3
     && MANIFEST.icons.every((i) =>
          fs.existsSync(path.join(REPO, i.src.replace(/^\//, '')))),
     'manifest.json: a standalone app whose every icon file exists'
     + " (dreev's Android install was manifest-less Chrome fallback)");
  ok(INDEX_HTML.includes('rel="manifest"'),
     'index.html links the manifest');
  ok(/rel="icon" href="data:image\/svg\+xml,[^"]*%238a5a2b/
       .test(INDEX_HTML),
     'the favicon is the gavel too — all gavel, no more \u03c4'
     + " (dreev killed the tau 2026-07-17); it shares the app icons'"
     + ' wood');

  /* --- 1. bare visit: no server-invented name — the user picks ---------- */
  let dom = await makePage('/?api=' + API_URL);
  let doc = dom.window.document;
  ok(dom.window.location.pathname === '/', 'a bare visit stays at /');
  ok(doc.getElementById('seal').disabled
     && doc.getElementById('seal').getAttribute('data-tip')
          === STR.needTwoTip,
     "the unnamed page's padlock is gray with the standard"
     + ' need-two-bidders tip (dreev caught it resting on "Reveal'
     + ' bids!" — the truth of an empty page needs no branch)');
  ok(!apiCalls.some((c) => c.action === 'fresh'),
     'no fresh-name round trip: particle names are gone');
  ok(doc.activeElement === doc.getElementById('aname')
     && doc.getElementById('aname').value === '',
     'the empty auction field holds the caret: naming it is your move');
  ok(!doc.getElementById('status').classList.contains('stale')
     && doc.getElementById('roster-input').disabled,
     'the unnamed ledger IDLES (+ row disabled) — never BUSY: stale'
     + ' here meant a gavel hammering forever');
  type(dom, 'aname', 'Fresh-1!');
  ok(doc.getElementById('aname').value === 'fresh1', 'slug sanitized');
  await until(() =>  // debounce + the gate's lookup: wait, don't sample
    dom.window.location.pathname === '/fresh1');
  ok(dom.window.location.pathname === '/fresh1'
     && dom.window.location.search.includes('api='),
     'naming it navigates, keeping ?api=');
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
  gas.handle({ action: 'add', aname: 'warm', uname: 'ann' });
  gas.handle({ action: 'add', aname: 'warm', uname: 'ben' });
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
  ok(JSON.parse(domWarm.window.localStorage.getItem('tauction-state:warm'))
       .roster.join(',') === 'ann,ben',
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
  gas.handle({ action: 'add', aname: 'skew', uname: 'old' });
  gas.handle({ action: 'bid', aname: 'skew', uname: 'old', bid: 'relic' });
  const domSkew = await makePage('/skew?api=' + API_URL);
  ok(!domSkew.window.document.getElementById('banner').hidden
     && domSkew.window.document.getElementById('banner').textContent
          .includes('bad state shape'),
     'an old-server payload banners loudly, naming the skew');
  stripTini = false;

  // A no-change poll must not rebuild the rows: a rebuild destroys
  // buttons mid-click (mousedown and mouseup need the same node), so a
  // click near a poll tick would silently die
  const nodeBefore = row(domWarm.window.document, 'ann');
  await sleep(5100);  // one no-change poll
  ok(row(domWarm.window.document, 'ann') === nodeBefore,
     'a no-change poll leaves the DOM alone (no swallowed clicks)');

  /* --- 2. alice sets up /tau and bids in place; her bid stays visible --- */
  dom = await makePage('/tau?api=' + API_URL);
  doc = dom.window.document;
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
  await until(() => gas.handle({ action: 'state', aname: 'tau' })
    .roster.join(',') === 'alice,bob,carol');
  ok(doc.getElementById('seal').getAttribute('data-tip')
       === STR.waitingTip('alice' + STR.youTag + ', bob, and carol'),
     'three stragglers: Oxford comma and all');
  row(doc, 'carol').querySelector('.x').click();
  await until(() => gas.handle({ action: 'state', aname: 'tau' })
    .roster.join(',') === 'alice,bob');
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
     && myInput(doc), 'her row is hers, with an in-place editor');
  ok([...tiles(doc)].every((t) => t.querySelector('.x')
       && !t.querySelector('.x').disabled),
     'every row offers a live × while bidless');
  ok(myInput(doc).placeholder === '' && myInput(doc).value === '',
     'fresh editor: blank — the caret invites the bid, not words');
  ok(myInput(doc).getAttribute('enterkeyhint') === 'send',
     "the mobile return key reads Send over the bid editor");
  ok(myInput(doc).closest('.rebid').querySelector('.gavel.mini'),
     'your editor carries its own mini gavel for bid-in-flight');
  ok(!doc.getElementById('status').classList.contains('unclaimed'),
     'someone is you now: the + row stops wearing the you-star');
  ok(row(doc, 'alice').querySelector('.tu').classList.contains('selected'),
     "your row's star is lit");
  ok(row(doc, 'bob').querySelector('.tu')
     && !row(doc, 'bob').querySelector('.tu').disabled,
     'other bidless rows keep live stars (radio: one click to switch)');

  submitBid(dom);  // empty: the field itself objects, inline
  ok(myInput(doc).classList.contains('error')
     && doc.getElementById('banner').hidden,
     'an empty bid reddens the field itself — no banner for a local'
     + ' slip');
  typeBid(dom, 'three tacos');
  myInput(doc).dispatchEvent(new dom.window.Event('input',
    { bubbles: true }));
  ok(!myInput(doc).classList.contains('error'),
     'typing clears the objection');
  submitBid(dom);
  await settled(dom);
  ok(myInput(doc).value === 'three tacos',
     'own bid lives in your row, editable in place');
  ok(tiles(doc, '.has-bid').length === 1 && tiles(doc).length === 2,
     'one green, one empty after first bid');
  ok(!tiles(doc, '.has-bid')[0].classList.contains('cut'),
     'roster member not crossed out');
  ok(myInput(doc).className === 'bid-card'
     && myInput(doc).style.boxShadow === 'var(--lift)',
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
  ok(JSON.parse(dom.window.localStorage.getItem('tauction-mybids:tau')).alice
     === 'three tacos', 'own bid persisted');
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
       === 'too late to remove @alice'
     && row(doc, 'bob').querySelector('.x').getAttribute('data-tip')
       === 'remove @bob',
     "the grayed ×'s tip says why: too late to remove");
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

  /* --- 2c. roster edits register instantly; grayed until confirmed ------ */
  const domO = await makePage('/optimist?api=' + API_URL);
  mockDelay = 300;
  addName(domO, 'pam');
  await sleep(30);  // long before the 700ms debounce + 300ms latency
  ok(tiles(domO.window.document).length === 1
     && row(domO.window.document, 'pam'),
     'added person appears in the BIDS box immediately');
  ok(domO.window.document.getElementById('status').classList.contains('stale'),
     'box grayed while the server has not confirmed');
  await sleep(2000);
  ok(!domO.window.document.getElementById('status').classList.contains('stale'),
     'ungrays once the server confirms');
  row(domO.window.document, 'pam').querySelector('.x').click();
  await sleep(30);  // the remove op is still in flight (mockDelay 300)
  ok(tiles(domO.window.document).length === 0,
     'removal empties the row immediately');
  ok(domO.window.document.getElementById('status').classList.contains('stale'),
     'grayed again until the removal is confirmed');
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
     && myInput(domO.window.document),
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
    gas.handle({ action: 'state', aname: 'coalesce' }).roster.join(',')
    === 'quickone,quicktwo,quickthree');
  mockDelay = 0;
  ok(!opsOverlapped, 'write ops serialize: never two in flight');
  ok(gas.handle({ action: 'state', aname: 'coalesce' }).roster.join(',')
     === 'quickone,quicktwo,quickthree', 'every added name arrives');
  ok(!domQ.window.document.getElementById('status').classList.contains('stale'),
     'box settles unstale after the queued ops');

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
  ok(gas.handle({ action: 'state', aname: 'keepname' }).roster.join(',')
     === 'uno,dos', 'both names reach the server');

  /* --- 2h. fix a typo: rename in place -----------------------------------
     Anyone can rename anyone (honor system, like all roster edits) via
     the ✎, which uses window.prompt — no in-place edit state. The seat,
     its claim, and any bid re-key together; a rename made on another
     machine follows your device id home: you stay latched, your bid
     memory migrates. */
  gas.handle({ action: 'add', aname: 'typo', uname: 'alicw' });
  gas.handle({ action: 'add', aname: 'typo', uname: 'bob' });
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
  nameInp.value = 'wronger';
  nameInp.dispatchEvent(new domT2.window.Event('blur'));
  // [dreev FLIPPED the old enter-only-commit pin 2026-07-17: mobile
  // users never hit enter — clicking/tapping away now SAVES]
  await until(() => row(docT2, 'wronger') !== undefined);
  ok(!row(docT2, 'alicw') && row(docT2, 'wronger'),
     'clicking away SAVES the rename, like every field edit');
  renameTo(domT2, 'wronger', 'alice');
  ok(row(docT2, 'alice') && !row(docT2, 'alicw')
     && tiles(docT2)[0].dataset.uname === 'alice',
     'the typo is fixed in place immediately, order kept');
  await until(() => gas.handle({ action: 'state', aname: 'typo' })
    .roster.join(',') === 'alice,bob');
  ok(gas.handle({ action: 'state', aname: 'typo' }).roster.join(',')
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
     && myInput(docT2).value === 'first dibs'
     && domT2.window.localStorage.getItem('tauction-uname') === 'alicia',
     'renaming yourself keeps you latched, bid and editor intact');

  // cross-device: machine 2 fixes machine 1's typo; machine 1's identity
  // follows its device id home on the next poll
  gas.handle({ action: 'add', aname: 'xdev', uname: 'carow' });
  gas.handle({ action: 'add', aname: 'xdev', uname: 'dan' });
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
     && myInput(mA.window.document).value === 'a carrot'
     && mA.window.localStorage.getItem('tauction-uname') === 'carol',
     "a rename from another machine follows machine 1's device home");

  /* --- 2i. arriving claimed and bidless: the caret waits in your editor
     (Replicata of dreev's pulse bug: load — don't click — a page where
     you're claimed with no bid. Expectata: your editor is a normal
     field with the caret in it, and only not-you rows ever pulse.
     Resultata pre-fix: the editor sat unfocused, pulsing.) ----------- */
  gas.handle({ action: 'add', aname: 'caret', uname: 'ann' });
  gas.handle({ action: 'add', aname: 'caret', uname: 'bee' });
  gas.handle({ action: 'claim', aname: 'caret', uname: 'ann',
               deviceID: 'dev-caret' });
  const seedK = (w) => {
    w.localStorage.setItem('tauction-device', 'dev-caret');
    w.localStorage.setItem('tauction-uname', 'ann');
  };
  const domK = await makePage('/caret?api=' + API_URL, seedK);
  const docK = domK.window.document;
  ok(docK.activeElement === myInput(docK),
     'arriving claimed and bidless: the caret is already in your editor');
  myInput(docK).blur();
  const pollsK = apiCalls.filter((c) => c.action === 'state'
    && c.aname === 'caret').length;
  await until(() => apiCalls.filter((c) => c.action === 'state'
    && c.aname === 'caret').length > pollsK);
  await sleep(100);  // the poll's response lands and renders
  ok(docK.activeElement !== myInput(docK),
     'focus placement is one-shot: a poll never steals the caret back');
  typeBid(domK, 'ann bid');
  submitBid(domK);
  await settled(domK);
  const domK2 = await makePage('/caret?api=' + API_URL, seedK);
  ok(domK2.window.document.activeElement
       !== myInput(domK2.window.document),
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
  await until(() => gas.handle({ action: 'state', aname: 'mefirst' })
    .roster.join(',') === 'dree,pal');
  ok(Object.keys(gas.handle({ action: 'state', aname: 'mefirst' })
       .claims).length === 0,
     'the self-add registers no server claim: a real dree on another'
     + ' device can still claim the seat out from under it');

  /* --- 2p. the auction description: markdown, a corner toggle, and
     compare-and-swap against clobbers (the compact eat-the-richtext:
     one field, source and rendered modes) ------------------------------ */
  gas.handle({ action: 'add', aname: 'descy', uname: 'ann' });
  const domDs = await makePage('/descy?api=' + API_URL);
  const dsDoc = domDs.window.document;
  ok(dsDoc.getElementById('descedit')
     && !dsDoc.getElementById('desc').classList.contains('viewing')
     && dsDoc.getElementById('descedit').placeholder.length > 0,
     'an undescribed auction opens in edit mode, placeholder explaining');
  dsDoc.getElementById('descedit').value = '# Brunch\n\n**bring** cash';
  ok(!dsDoc.getElementById('desctoggle').hasAttribute('data-tip'),
     'the pencil explains itself by icon: no tooltip [dreev retired'
     + ' his toggle-tip copy 2026-07-17]');
  // clicking away = save + flip to rendered (dreev killed the 💾:
  // the blurb obeys the same rule as bids and names now)
  dsDoc.getElementById('descedit').dispatchEvent(
    new domDs.window.Event('blur'));
  await until(() => gas.handle({ action: 'state', aname: 'descy' })
    .blurb === '# Brunch\n\n**bring** cash');
  await until(() => !!dsDoc.querySelector('#descview h1'));
  ok(dsDoc.getElementById('desc').classList.contains('viewing')
     && dsDoc.querySelector('#descview h1').textContent === 'Brunch'
     && dsDoc.querySelector('#descview strong').textContent === 'bring',
     'flipping to view commits, and the markdown renders (h1, bold)');
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
    new domDs.window.KeyboardEvent('keydown',
      { key: 'Escape', bubbles: true }));
  ok(dsDoc.getElementById('descedit').value
       === '# Brunch\n\n**bring** cash'
     && dsDoc.getElementById('desc').classList.contains('viewing')
     && descOps() === opsBefore,
     'Escape abandons the edit: reverted, back to rendered, nothing'
     + ' sent (mobile is out of luck — tapping away saves)');
  const domBk = await makePage('/blank?api=' + API_URL);
  await sleep(20);
  domBk.window.document.getElementById('descedit').focus();
  domBk.window.document.getElementById('descedit').dispatchEvent(
    new domBk.window.Event('blur'));
  ok(!domBk.window.document.getElementById('desc').classList
       .contains('viewing'),
     'a clean blur of a BLANK blurb stays in edit mode: flipping'
     + ' would trade the placeholder for an invisible empty pane');

  // hostile markdown renders inert (escape-first, whitelisted links)
  gas.handle({ action: 'describe', aname: 'evil', base: '',
    blurb: '<script>window.pwned=1</script>\n\n'
      + '[x](javascript:alert(1)) <img src=x onerror=alert(1)>' });
  gas.handle({ action: 'add', aname: 'evil', uname: 'e' });
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
  // the clobber dance: two windows, one description
  const dA = await makePage('/descy?api=' + API_URL);
  const dB = await makePage('/descy?api=' + API_URL);
  dA.window.document.getElementById('desctoggle').click();  // to edit
  dA.window.document.getElementById('descedit').value = 'A version';
  dA.window.document.getElementById('descedit').dispatchEvent(
    new dA.window.Event('blur'));  // click away = commit
  await until(() => gas.handle({ action: 'state', aname: 'descy' })
    .blurb === 'A version');
  dB.window.document.getElementById('desctoggle').click();  // stale base
  dB.window.document.getElementById('descedit').value = 'B version';
  dB.window.document.getElementById('descedit').blur();  // = commit!
  // ...and B moves on: clicks into the + row and starts thinking
  dB.window.document.getElementById('roster-input').focus();
  await until(() =>
    !dB.window.document.getElementById('banner').hidden);
  ok(dB.window.document.getElementById('banner').textContent
       .includes(SCOPY.simulEditsCopy),
     "the clobber bounces off the compare-and-swap, loudly, in dreev's"
     + ' words');
  // the load-bearing cross-runtime pin: the client warns about a
  // simultaneous edit in EXACTLY the server's words, so the locally-
  // and remotely-detected banners read as one message
  ok(STR.simulEditsBanner === SCOPY.simulEditsCopy,
     'stringles.js and Code.gs agree verbatim on the simultaneous-edits'
     + ' copy');
  ok(STR.mysteryDevice === SCOPY.mysteryDeviceCopy,
     'stringles.js and Code.gs agree verbatim on the nameless-rig'
     + " fallback (both ends decorate tooltips with the holder's rig)");
  ok(STR.nameTakenBanner === SCOPY.nameTakenCopy,
     'stringles.js and Code.gs agree verbatim on the name-taken copy'
     + ' (the client pre-check and the server refusal must read as one'
     + ' message)');

  /* --- 2p2. a rename that loses the race reddens the FIELD ------------
     Replicata: the local roster is a poll behind — someone else just
     added zed — and you rename bob to zed. The client's own dupe guard
     can't know, the server refuses. Expectata: the banner plus the
     name field itself turning red (cleared on input), same recipe as
     every other field objection. --------------------------------- */
  gas.handle({ action: 'add', aname: 'renrace', uname: 'alice' });
  gas.handle({ action: 'add', aname: 'renrace', uname: 'bob' });
  const dR = await makePage('/renrace?api=' + API_URL);
  await sleep(20);
  gas.handle({ action: 'add', aname: 'renrace', uname: 'zed' });
  const bobName = dR.window.document
    .querySelector('.tile[data-uname="bob"] .rename input');
  bobName.value = 'zed';
  bobName.form.dispatchEvent(
    new dR.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => !dR.window.document.getElementById('banner').hidden);
  ok(dR.window.document.getElementById('banner').textContent
       .includes(SCOPY.nameTakenCopy)
     && bobName.classList.contains('error'),
     'the lost rename race: banner in the server\'s words AND the name'
     + ' field itself red — the problem localized');
  bobName.dispatchEvent(new dR.window.Event('input', { bubbles: true }));
  ok(!bobName.classList.contains('error'),
     'the red clears at the next keystroke');
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
  // B, now informed, insists: the recovery poll re-based the draft
  await until(() =>
    dB.window.document.getElementById('descedit').dataset.base
    === gas.handle({ action: 'state', aname: 'descy' }).tblurb);
  dB.window.document.getElementById('descedit').dispatchEvent(
    new dB.window.Event('blur'));  // click away again = re-commit
  await until(() => gas.handle({ action: 'state', aname: 'descy' })
    .blurb === 'B version');
  ok(true, 'saving again, informed, wins: one warning per clobber');

  /* --- 2k. the alice race: two machines, one seat ------------------------
     Replicata (dreev's report): machine 1 and machine 2 both have the
     auction open, alice unclaimed on both screens. Machine 1 claims
     alice; before machine 2's page hears about it (no poll yet),
     machine 2 clicks alice's star too. Resultata pre-fix: the server
     was last-write-wins — machine 2 silently STOLE the seat and both
     machines believed they were alice. Expectata: first come, first
     served; the loser is told loudly and recovers to the dibsed
     truth; the winner is untouched. */
  gas.handle({ action: 'add', aname: 'race2', uname: 'alice' });
  gas.handle({ action: 'add', aname: 'race2', uname: 'bea' });
  const r1 = await makePage('/race2?api=' + API_URL);
  const r2 = await makePage('/race2?api=' + API_URL);
  claimRow(r1, 'alice');
  await until(() => gas.handle({ action: 'state', aname: 'race2' })
    .claims.alice !== undefined);
  ok(!row(r2.window.document, 'alice').querySelector('.tu').disabled,
     "machine 2 hasn't polled yet: its stale screen still offers alice");
  claimRow(r2, 'alice');  // the race click
  await until(() =>
    row(r2.window.document, 'alice').querySelector('.tu').disabled);
  ok(r2.window.document.getElementById('banner').hidden,
     'losing a seat race is normal auction physics: NO red banner'
     + " (dreev's call) — the UI itself shows the truth");
  ok(row(r2.window.document, 'alice').querySelector('.tu').classList
       .contains('taken')
     && row(r2.window.document, 'alice').querySelector('.tu')
          .getAttribute('data-tip')
          // the tip up to the parenthesized rig, whatever the copy says
          .startsWith(STR.claimedByTip('').slice(0, -1))
     && !r2.window.document.querySelector('#tiles .rebid'),
     'instead: the filled star and its tooltip explain who beat you');
  ok(gas.handle({ action: 'state', aname: 'race2' }).claims.alice
       === r1.window.localStorage.getItem('tauction-device'),
     "machine 1's claim survived: first come, first served");
  ok(row(r1.window.document, 'alice').classList.contains('mine'),
     'machine 1 never even notices the skirmish');
  // machine 2's consolation: bea is open, and life goes on
  claimRow(r2, 'bea');
  await until(() => gas.handle({ action: 'state', aname: 'race2' })
    .claims.bea !== undefined);
  ok(row(r2.window.document, 'bea').classList.contains('mine'),
     'machine 2 claims the open seat instead and lives happily');

  /* --- 2k2. seat-race stress battery (dreev: "stress-qual it") ----------
     Every way two machines can want the same seat in a NEW auction. */
  // (i) truly simultaneous clicks: both ops in flight at once
  gas.handle({ action: 'add', aname: 'race4', uname: 'alice' });
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
    .claims.alice;
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
  // (ii) spam-clicking the taken star stays inert and quiet
  claimRow(loser, 'alice');
  claimRow(loser, 'alice');
  await sleep(200);
  ok(loser.window.document.getElementById('banner').hidden
     && gas.handle({ action: 'state', aname: 'race4' }).claims.alice
          === claim4,
     'spamming a lost seat: still quiet, still theirs');
  // (iii) the winner releases; the seat reopens everywhere by poll
  claimRow(winner, 'alice');  // own lit star: release
  await until(() => gas.handle({ action: 'state', aname: 'race4' })
    .claims.alice === undefined);
  await until(() =>
    row(loser.window.document, 'alice').classList.contains('mine'));
  ok(!row(loser.window.document, 'alice').querySelector('.tu').classList
       .contains('taken')
     && loser.window.document.getElementById('banner').hidden,
     'released seats RE-LATCH the loser automatically: their machine'
     + ' never forgot who they wanted to be, and the seat is open'
     + ' again — gold star, no click, no noise');

  /* --- 2l. the stolen-seat bid: the race, lost mid-keystroke -------------
     Replicata: same stale-screen setup, but machine 2 clicks alice's
     star and IMMEDIATELY types a bid while its claim op is still in
     flight (the optimistic editor appears at once). Expectata: the
     claim is refused AND the bid is refused — a bid must never hijack
     a held seat — and machine 1's world is intact. */
  gas.handle({ action: 'add', aname: 'race3', uname: 'alice' });
  const r3 = await makePage('/race3?api=' + API_URL);
  const r4 = await makePage('/race3?api=' + API_URL);
  claimRow(r3, 'alice');
  await until(() => gas.handle({ action: 'state', aname: 'race3' })
    .claims.alice !== undefined);
  mockDelay = 300;        // r4's ops fly slowly: the window for typing
  claimRow(r4, 'alice');  // stale screen, optimistic editor appears
  typeBid(r4, 'stolen goods');
  submitBid(r4);
  await sleep(900);       // claim + bid both land and are refused
  mockDelay = 0;
  ok(gas.handle({ action: 'state', aname: 'race3' }).bidders.length === 0,
     "the hijack bid never reached the sheet: alice's seat held firm");
  ok(gas.handle({ action: 'state', aname: 'race3' }).claims.alice
       === r3.window.localStorage.getItem('tauction-device'),
     "and machine 1 still holds the seat");
  await until(() =>  // the RENDERED truth, not the submit-time lock
    row(r4.window.document, 'alice').querySelector('.tu').classList
      .contains('taken'));
  ok(!r4.window.document.querySelector('#tiles .rebid'),
     'machine 2 recovers to reality: taken star, no editor');

  /* --- 2m. the radio locks at SUBMIT, not at the server's ack ------------
     Replicata (dreev: "claim a participant, submit a bid, then see a
     blank field — possibly switching identities?"): claim alice,
     submit, and click bob's star while the bid is still in flight.
     Resultata pre-fix: the switch went through — the bid landed under
     alice while you faced bob's blank editor. Expectata: the stars
     lock the instant you commit. */
  gas.handle({ action: 'add', aname: 'flightlock', uname: 'alice' });
  gas.handle({ action: 'add', aname: 'flightlock', uname: 'bob' });
  const domFL = await makePage('/flightlock?api=' + API_URL);
  claimRow(domFL, 'alice');
  await until(() => gas.handle({ action: 'state', aname: 'flightlock' })
    .claims.alice !== undefined);
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
     && myInput(domFL.window.document).value === 'my treasure',
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
    return gas.handle({ action: 'state', aname: 'burst' }).roster.join(',')
      === 'aa,bb,cc,dd,ee';
  }, 15000);
  mockDelay = 0;
  ok(!vanished && ['aa', 'bb', 'cc', 'dd', 'ee'].every((u) =>
       row(domB2.window.document, u)),
     'every rapidly-typed name stayed on the ledger throughout'
     + ' (no flash-vanish)');
  ok(gas.handle({ action: 'state', aname: 'burst' }).roster.join(',')
     === 'aa,bb,cc,dd,ee', 'and they all reached the server');

  /* --- 2f. two machines can't both be alice ------------------------------
     Replicata (dreev's bug report): machine 1 adds alice (self-claim,
     2j); machine 2 opens the auction and clicks alice's star too; both
     machines bid as alice. Resultata pre-fix: both believed they were
     alice and silently overwrote each other's bid. Expectata: the
     self-claim is SOFT (registered on the server only by a bid or an
     explicit claim), so machine 2 sees alice claimable at first — but
     the moment machine 1 bids, every other machine shows dibs. */
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
  ok(myInput(m1.window.document).value === 'the real bid',
     'machine 1, the (self-)claim holder, bids normally');
  await until(() =>  // machine 2's next poll delivers the dibs
    row(m2.window.document, 'alice').querySelector('.tu').disabled);
  ok(row(m2.window.document, 'alice').querySelector('.tu').disabled
     && !m2.window.document.querySelector('#tiles .rebid'),
     "machine 1's bid registered the claim: alice dibsed on machine 2,"
     + ' no editor for her');
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
  ok(gas.handle({ action: 'state', aname: 'geocache2' }).blurbs.gina
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
  mockDelay = 500;  // a slow server must not delay the paint
  dI.window.document.getElementById('descedit').dispatchEvent(
    new dI.window.Event('blur'));
  const instaView = dI.window.document.getElementById('descview');
  ok(dI.window.document.getElementById('desc').classList
       .contains('viewing')
     && instaView.querySelector('h1')
     && instaView.querySelector('h1').textContent === 'Big News'
     && instaView.querySelector('strong').textContent === 'bold',
     'the rendered markdown appears the instant the toggle is clicked,'
     + ' not when the database answers');
  await settled(dI);
  mockDelay = 0;
  ok(gas.handle({ action: 'state', aname: 'instadesc' }).blurb
       === '# Big News\n\nmuch **bold**'
     && instaView.querySelector('h1') !== null,
     '...and the background write lands the same text; the settle'
     + ' repaints nothing');

  /* --- 2t. tab walks EDITABLE FIELDS only (dreev): buttons act on
     click or tap; none of them is a tab stop. ----------------------- */
  const dTab = await makePage('/taborder?api=' + API_URL);
  addName(dTab, 'tia');
  await settled(dTab);
  const allButtons
    = Array.from(dTab.window.document.querySelectorAll('button'));
  ok(allButtons.length >= 8 && allButtons.every((b) => b.tabIndex === -1),
     'no button is a tab stop (stars, ×s, desc toggle, share, help,'
     + ' seal, copy, dialog ×s) — tab is for editable fields');
  ok(dTab.window.document.getElementById('descedit').tabIndex === 0
     && dTab.window.document.getElementById('roster-input').tabIndex === 0
     && dTab.window.document.getElementById('aname').tabIndex === 0,
     '...which all remain tab stops themselves');
  ok(dTab.window.document.querySelector(
       '.tile[data-uname="tia"] .rebid input').tabIndex === 0,
     "your own bid editor is an editable field: in the ring (dreev's"
     + ' checklist pinned it)');
  ok(dTab.window.document.querySelector('footer a').tabIndex === -1,
     'the footer github link is not a tab stop (the help dialog\'s'
     + ' inner links stay tabbable: an open dialog is navigated by'
     + ' them)');

  /* --- 2t2. dead ends are STICKY and walkable (dreev's PWA report:
     an installed app has no URL bar, so "use the URL" must BE the
     URL, and the sign must not vanish while you read it) --------- */
  const dPwa = await makePage('/gate2?api=' + API_URL);
  await sleep(20);
  gas.handle({ action: 'add', aname: 'occupied', uname: 'zoe' });
  type(dPwa, 'aname', 'occupied');
  await until(() => !dPwa.window.document.getElementById('banner').hidden);
  const gateLink = dPwa.window.document.querySelector('#banner a');
  ok(gateLink && gateLink.getAttribute('href') === '/occupied'
     && dPwa.window.document.getElementById('banner').textContent
          === STR.auctionExistsBanner('/occupied')
              .replace(/<[^>]+>/g, ''),
     'the exists-banner offers the URL as a real LINK (a PWA has no'
     + ' URL bar to fall back on), in dreev\'s words');
  await sleep(5300);  // outlive the ordinary banner timer
  ok(!dPwa.window.document.getElementById('banner').hidden,
     'and the dead-end sign does NOT dismiss itself (dreev: you are'
     + ' stuck until you act on it)');
  type(dPwa, 'aname', 'gate3');
  await until(() =>
    dPwa.window.location.pathname === '/gate3');
  ok(dPwa.window.document.getElementById('banner').hidden,
     'landing somewhere real finally clears it');

  /* --- 2t3. Escape means "never mind" in EVERY field -------------------
     One universal rule: Escape reverts a field to its baseline
     (defaultValue, the committed truth everywhere) and leaves. New
     ground covered: the auction-name field — abandoning a half-typed
     switch used to be impossible (the debounce fired regardless). */
  const dEsc = await makePage('/eschome?api=' + API_URL);
  await sleep(20);
  dEsc.window.document.getElementById('aname').focus();
  type(dEsc, 'aname', 'somewhereelse');
  dEsc.window.document.getElementById('aname').dispatchEvent(
    new dEsc.window.KeyboardEvent('keydown',
      { key: 'Escape', bubbles: true }));
  await sleep(700);  // outlive the switch debounce
  ok(dEsc.window.document.getElementById('aname').value === 'eschome'
     && dEsc.window.location.pathname === '/eschome',
     'Escape in the auction field abandons the half-typed switch:'
     + ' name restored, nobody navigates');
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

  /* --- 2u. name, TAB, bid (dreev's add-self flow) ----------------------
     Adding YOURSELF should leave the bid field one tab away: type
     your name, tab, type your bid. Only when the fresh row is yours
     (the gold star); a facilitator tab-adding others keeps the caret
     in the + row for the next name. */
  const dSelf = await makePage('/tabflow?api=' + API_URL);
  await sleep(20);
  dSelf.window.document.getElementById('roster-input').focus();
  type(dSelf, 'roster-input', 'dree');
  dSelf.window.document.getElementById('roster-input').dispatchEvent(
    new dSelf.window.KeyboardEvent('keydown',
      { key: 'Tab', bubbles: true, cancelable: true }));
  ok(dSelf.window.document.activeElement
       === myInput(dSelf.window.document)
     && row(dSelf.window.document, 'dree').classList.contains('mine'),
     'add yourself, tab: the caret lands in YOUR fresh bid editor');
  dSelf.window.document.getElementById('roster-input').focus();
  type(dSelf, 'roster-input', 'gwen');
  dSelf.window.document.getElementById('roster-input').dispatchEvent(
    new dSelf.window.KeyboardEvent('keydown',
      { key: 'Tab', bubbles: true, cancelable: true }));
  ok(row(dSelf.window.document, 'gwen') !== undefined
     && !row(dSelf.window.document, 'gwen').classList.contains('mine')
     && dSelf.window.document.activeElement
          === dSelf.window.document.getElementById('roster-input'),
     "tab-adding someone ELSE books the row but doesn't jump: the"
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
     && row(dRn.window.document, 'bob123') !== undefined
     && gas.handle({ action: 'state', aname: 'freshren' })
          .roster.includes('bob123'),
     'enter-then-blur renames ONCE: no false "taken" (the trailing'
     + ' commit of a row already renamed away is a stale event, not'
     + ' a request)');

  /* --- 2q2. the record freezes at the gavel, × included ----------------
     Replicata (dreev): "it just let me remove someone from a closed
     auction" — and a cut row's zombie-purge × could even delete a
     REVEALED bid (whose seatless remains then tooltip'd 'awaiting
     bid...', his other sighting). Expectata: every × grays at the
     gavel. -------------------------------------------------------- */
  gas.handle({ action: 'add', aname: 'frozencut', uname: 'pam' });
  gas.handle({ action: 'add', aname: 'frozencut', uname: 'quinn' });
  gas.handle({ action: 'add', aname: 'frozencut', uname: 'rex' });
  gas.handle({ action: 'bid', aname: 'frozencut', uname: 'pam', bid: 'p' });
  gas.handle({ action: 'bid', aname: 'frozencut', uname: 'quinn', bid: 'q' });
  gas.handle({ action: 'bid', aname: 'frozencut', uname: 'rex', bid: 'r' });
  gas.handle({ action: 'remove', aname: 'frozencut', uname: 'rex' });
  gas.handle({ action: 'reveal', aname: 'frozencut' });
  const dFz = await makePage('/frozencut?api=' + API_URL);
  await sleep(20);
  ok(row(dFz.window.document, 'rex').classList.contains('cut')
     && [...dFz.window.document.querySelectorAll('#tiles .x')]
          .every((x) => x.disabled),
     "every × grays at the gavel — even the cut row's zombie-purge ×:"
     + ' a revealed bid never leaves the record');

  /* --- 2u2. the hallway test (dreev + bee, verbatim fumbles) -----------
     Scene: bee's row exists, unclaimed and bidless. A fresh visitor
     (a) taps bee's empty bid box — "clicking on this box doesn't
     work"; (b) types "bee" into the + row — "maybe i type in the
     name i want to make a bid for?". Both intents are OBVIOUS, so
     both now work: they claim bee's seat and ready the editor. --- */
  gas.handle({ action: 'add', aname: 'hallway', uname: 'bee' });
  const dHall = await makePage('/hallway?api=' + API_URL);
  await sleep(20);
  row(dHall.window.document, 'bee').querySelector('.tile-bid').click();
  await settled(dHall);
  ok(row(dHall.window.document, 'bee').classList.contains('mine')
     && dHall.window.document.activeElement
          === myInput(dHall.window.document),
     "tapping a takeable row's empty bid box claims it and puts the"
     + ' caret in the editor: the intent was never ambiguous');
  claimRow(dHall, 'bee');  // release again (radio) for scene (b)
  await settled(dHall);
  const dHall2 = await makePage('/hallway?api=' + API_URL);
  await sleep(20);
  dHall2.window.document.getElementById('roster-input').focus();
  type(dHall2, 'roster-input', 'bee');
  submitName(dHall2);
  await settled(dHall2);
  ok(row(dHall2.window.document, 'bee').classList.contains('mine')
     && dHall2.window.document.activeElement
          === myInput(dHall2.window.document)
     && dHall2.window.document.getElementById('roster-input').value === ''
     && !dHall2.window.document.getElementById('roster-input')
          .classList.contains('error'),
     'typing an existing takeable name claims that seat (no red-ring'
     + ' rejection when the intent is "I am bee")');
  typeBid(dHall2, 'bee bids at last');
  submitBid(dHall2);
  await settled(dHall2);
  ok(gas.handle({ action: 'state', aname: 'hallway' }).bidders
       .some((b) => b.uname === 'bee'),
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
     Blur commits the + row too now (dreev: frictionless self-add;
     the old click-swallow that banned this died with keyed node
     reuse), and an empty blur objects to nothing. --------------- */
  const dAdd = await makePage('/blurauda?api=' + API_URL);
  await sleep(20);
  dAdd.window.document.getElementById('roster-input').focus();
  type(dAdd, 'roster-input', 'gala');
  dAdd.window.document.getElementById('roster-input').dispatchEvent(
    new dAdd.window.Event('blur'));
  await settled(dAdd);
  ok(row(dAdd.window.document, 'gala') !== undefined
     && row(dAdd.window.document, 'gala').classList.contains('mine')
     && dAdd.window.document.activeElement
          === myInput(dAdd.window.document),
     'tapping away commits the typed name — and a self-add lands the'
     + ' caret in YOUR fresh bid editor, no enter anywhere (dreev:'
     + ' show up, add your name, bid)');
  dAdd.window.document.getElementById('roster-input').dispatchEvent(
    new dAdd.window.Event('blur'));
  ok(!dAdd.window.document.getElementById('roster-input').classList
       .contains('error'),
     'an empty blur of the + row objects to nothing');

  /* --- 2v. clicking away from the bid editor SAVES (dreev, esp.
     mobile: nobody expects enter) — and the enter-then-blur pair
     (the mobile keyboard closing right after submit) fires ONCE. -- */
  const dBlur = await makePage('/blursave?api=' + API_URL);
  await sleep(20);
  addName(dBlur, 'bea');
  await settled(dBlur);
  typeBid(dBlur, 'saved by blur');
  myInput(dBlur.window.document).dispatchEvent(
    new dBlur.window.Event('blur'));
  await until(() => (gas.handle({ action: 'state', aname: 'blursave' })
    .bidders.find((b) => b.uname === 'bea') || {}).bcount === 1);
  ok(true, 'clicking away places the bid: no enter required');
  await settled(dBlur);
  typeBid(dBlur, 'enter then blur');
  submitBid(dBlur);
  myInput(dBlur.window.document).dispatchEvent(
    new dBlur.window.Event('blur'));  // the keyboard closes
  await settled(dBlur);
  ok(gas.handle({ action: 'state', aname: 'blursave' })
       .bidders.find((b) => b.uname === 'bea').bcount === 2,
     'enter then blur is ONE submission, not two (the closing mobile'
     + ' keyboard must not double-fire)');
  ok(myInput(dBlur.window.document).value === 'enter then blur'
     && dBlur.window.document.getElementById('banner').hidden,
     'and an idle blur of a clean editor commits nothing');
  typeBid(dBlur, 'abandoned thought');
  myInput(dBlur.window.document).dispatchEvent(
    new dBlur.window.KeyboardEvent('keydown',
      { key: 'Escape', bubbles: true }));
  await settled(dBlur);
  ok(myInput(dBlur.window.document).value === 'enter then blur'
     && gas.handle({ action: 'state', aname: 'blursave' })
          .bidders.find((b) => b.uname === 'bea').bcount === 2,
     'Escape abandons a bid edit (the only way out now that clicking'
     + ' away saves): reverted, nothing submitted');

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
  ok(row(doc2, 'alice').querySelector('.tu').disabled,
     "alice's bid dibses her row: a fresh browser can't usurp it");
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
     && myInput(doc2).value === '$40 and my dignity',
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
  ok(myInput(doc2) && myInput(doc2).disabled
     && myInput(doc2).value === '$40 and my dignity',
     'the gavel drop is a bright line: your bid stays READABLE in your'
     + ' editor but the field goes dead (2026-07-16, dreev — reversing'
     + ' the old permissive pin)');

  /* --- the under-the-wire race, LOST: an explicit notice ----------------
     Replicata: submit a revision while the last straggler's bid — and
     the reveal — land first. Expectata: the revision bounces with the
     gavel-fell error; the sheet keeps the pre-reveal bid. */
  gas.handle({ action: 'add', aname: 'wire', uname: 'ann' });
  gas.handle({ action: 'add', aname: 'wire', uname: 'zed' });
  gas.handle({ action: 'bid', aname: 'wire', uname: 'zed', bid: 'safe',
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
  ok(gas.handle({ action: 'state', aname: 'wire' }).bids
       .find((b) => b.uname === 'ann').bid === 'first thoughts',
     'the sheet keeps the bid that beat the gavel');

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

  // the ceremony self-cleans: nothing left in the DOM afterward
  await sleep(4100);  // FETE_MS
  ok(!doc2.querySelector('#status .fete')
     && !doc2.getElementById('status').classList.contains('ceremony'),
     'the ceremony packs up after itself: no confetti litter');

  /* --- 3b. shimmer + stacks: re-bids glow anew in every window ---------- */
  gas.handle({ action: 'add', aname: 'wobble', uname: 'ann' });
  gas.handle({ action: 'add', aname: 'wobble', uname: 'zed' });
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
  ok(own.length === 1 && own[0].querySelector('.rebid input').value === 'second',
     'own re-bid shimmers and holds the new text');
  // (subs superscript shelved 2026-07-15)
  // ok(own[0].querySelector('.tile-subs').textContent === '2',
  //    'counter ticks on re-submission');
  ok(/^first submitted \d+[sm] ago, resubmitted \d+s ago$/
       .test(hoverBid(domA, 'ann')),
     "re-submission tooltip: 'first submitted ..., resubmitted ...', got "
     + hoverBid(domA, 'ann'));
  ok(own[0].querySelector('.rebid input').style.boxShadow
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
  gas.handle({ action: 'add', aname: 'switcheroo', uname: 'alice' });
  gas.handle({ action: 'add', aname: 'switcheroo', uname: 'bob' });
  gas.handle({ action: 'add', aname: 'switcheroo', uname: 'cam' });
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
  ok(myInput(docS).value === '' && myInput(docS).placeholder === '',
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
  type(domR, 'aname', 'elsewhere');
  // wait on the CONDITIONS, not the clock (the old 1800ms sleep left
  // ~100ms slack over the delayed hops and flaked under load): the
  // switch must commit and the delayed bid response must land
  await until(() => domR.window.location.pathname === '/elsewhere');
  await until(() => domR.window.localStorage
    .getItem('tauction-mybids:race') !== null);
  mockDelay = 0;
  ok(domR.window.localStorage.getItem('tauction-mybids:elsewhere') === null,
     'no bid attributed to the auction you switched to');
  ok(JSON.parse(domR.window.localStorage.getItem('tauction-mybids:race') || '{}')
       .carl === 'zoom zoom',
     'bid remembered under the auction it was placed on');

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
     && !myInput(domP.window.document).disabled,
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
  ok(myInput(domP.window.document).value === 'hurry HARDER',
     'and the editor agrees');

  /* --- 3h. the 5s poll must not eat a bid you are mid-typing ------------
     Replicata: claim your row, type a draft, don't submit, wait out a
     poll (which rebuilds every row). Expectata: draft, focus, and caret
     survive the rebuild. */
  const domD = await makePage('/draft?api=' + API_URL);
  addName(domD, 'dan');  // self-claims (2j)
  myInput(domD.window.document).focus();  // click into your editor
  typeBid(domD, 'half a tho');
  myInput(domD.window.document).setSelectionRange(4, 4);
  // wait for a poll to actually go out (a fixed sleep can miss a late
  // one, making "survives the poll" pass vacuously), then let its
  // response land and render
  const polls0 = apiCalls.filter((c) => c.action === 'state'
    && c.aname === 'draft').length;
  await until(() => apiCalls.filter((c) => c.action === 'state'
    && c.aname === 'draft').length > polls0);
  await sleep(100);
  ok(myInput(domD.window.document).value === 'half a tho',
     'draft bid survives the poll rebuild');
  ok(domD.window.document.activeElement === myInput(domD.window.document),
     'focus survives the poll rebuild');
  ok(myInput(domD.window.document).selectionStart === 4,
     'caret position survives the poll rebuild');

  /* --- 3i. keyed node reuse: rows keep their DOM nodes across CHANGE-ful
     renders too, so a mid-gesture click or focused editor can never be
     destroyed by someone else's update arriving. */
  gas.handle({ action: 'add', aname: 'reuse', uname: 'ann' });
  gas.handle({ action: 'add', aname: 'reuse', uname: 'zed' });
  const domN = await makePage('/reuse?api=' + API_URL);
  const annBefore = row(domN.window.document, 'ann');
  gas.handle({ action: 'bid', aname: 'reuse', uname: 'zed', bid: 'zzz' });
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
  gas.handle({ action: 'add', aname: 'idem', uname: 'pip' });
  gas.handle({ action: 'add', aname: 'idem', uname: 'quo' });
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
  gas.__ss.sheets['bids'].appendRow(['legacy', 'oldtimer', 'ancient bid',
    '2026-01-01T00:00:00.000Z']);
  const domL = await makePage('/legacy?api=' + API_URL);
  const rowL = tiles(domL.window.document, '.has-bid')[0];
  ok(rowL && /^bid submitted \d+d ago$/
       .test(hoverBid(domL, 'oldtimer')),
     'a lone log row derives one submission: tooltip takes the single-'
     + 'submission branch, got ' + hoverBid(domL, 'oldtimer'));
  ok(rowL.querySelector('.bid-card').style.boxShadow === 'var(--lift)',
     'legacy row: single card, no sheets');

  /* --- 4. switching auctions via the auction field; grayed while loading
     (a fresh page: its first 5s poll can't be mid-flight during the
     switch, which would defer the reload to the next poll) ------------- */
  apiCalls = [];
  const dom4 = await makePage('/switchme?api=' + API_URL);
  const doc4 = dom4.window.document;
  mockDelay = 150;
  type(dom4, 'aname', 'Pie-Split');
  ok(doc4.getElementById('aname').value === 'piesplit', 'slug sanitized');
  await sleep(550);  // past the switch debounce; response still in flight
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
  ok(myInput(doc4).value === 'i bid 2 dishes', 'own roster bid visible');
  ok(row(doc4, 'dee').classList.contains('has-bid')
     && !row(doc4, 'evy').classList.contains('has-bid'),
     'dee green, evy still empty');
  ok(row(doc4, 'evy').querySelector('.bid-card.slot')
     && !row(doc4, 'evy').querySelector('.rebid'),
     "evy's row holds an empty card, awaiting her bid");

  /* --- 4b. bidders cut from the roster stay visible, crossed out --------
     No UI produces this state anymore (rows with bids have no ×), but
     concurrent roster edits from another device still can. */
  gas.handle({ action: 'add', aname: 'cutcheck', uname: 'pat' });
  gas.handle({ action: 'add', aname: 'cutcheck', uname: 'quinn' });
  gas.handle({ action: 'bid', aname: 'cutcheck', uname: 'pat', bid: 'stays' });
  gas.handle({ action: 'remove', aname: 'cutcheck',
               uname: 'pat' });  // pat removed after bidding
  const domC = await makePage('/cutcheck?api=' + API_URL);
  const patRow = row(domC.window.document, 'pat');
  ok(patRow && patRow.classList.contains('has-bid')
     && patRow.classList.contains('cut'),
     'bid-then-removed bidder stays in the box, crossed out');
  ok(!row(domC.window.document, 'quinn').classList.contains('cut'),
     'roster members are not crossed out');
  // the recovery path (dreev): a cut row's × comes back to life —
  // clicking it purges the zombie bid outright
  ok(!patRow.querySelector('.x').disabled
     && patRow.querySelector('.x').getAttribute('data-tip')
          === 'remove @pat',
     "a cut row's × works: the one way back from a tampered/raced"
     + ' state');
  patRow.querySelector('.x').click();
  await until(() => gas.handle({ action: 'state', aname: 'cutcheck' })
    .bidders.length === 0);
  await until(() => !row(domC.window.document, 'pat'));
  ok(!row(domC.window.document, 'pat'),
     'clicking it purges the zombie bid: the row is gone for good');
  gas.handle({ action: 'add', aname: 'cutcheck', uname: 'pat' });
  gas.handle({ action: 'bid', aname: 'cutcheck', uname: 'pat', bid: 'back in' });
  const domC2 = await makePage('/cutcheck?api=' + API_URL);
  ok(!row(domC2.window.document, 'pat').classList.contains('cut'),
     're-bidding rejoins the roster and uncrosses');

  /* --- 4c. switching while a poll is in flight must not strand the box --
     Replicata: let a 5s poll fire and, while its response is in flight,
     switch auctions (the refreshing guard makes the switch's own refresh
     a no-op). Expectata: the box unstales as soon as the stale response
     lands, not a full poll cycle later. */
  const domW = await makePage('/inflight?api=' + API_URL);
  mockDelay = 800;                     // widen the in-flight window
  await sleep(4750);                   // first poll fires at ~5000ms
  type(domW, 'aname', 'poleposition'); // 500ms debounce -> switch lands
                                       // ~5250, inside the poll's flight
  await sleep(2400);                   // stale response + one refetch
  mockDelay = 0;
  ok(!domW.window.document.getElementById('status').classList.contains('stale'),
     'switching mid-poll: box unstales without waiting out another poll');

  /* --- 5. XSS: a bid with markup renders inert; walk-ons show cut ------- */
  gas.handle({ action: 'bid', aname: 'piesplit', uname: 'rando', bid: 'me too!' });
  const gasRes = gas.handle({ action: 'bid', aname: 'piesplit', uname: 'evy',
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
     (404.html is a derived artifact; `npm run quals` regenerates it via
     sync-404 before running, so this only fires when the suites are
     invoked directly with node)
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
  gas.handle({ action: 'add', aname: 'occupied', uname: 'stranger' });
  const domG = await makePage('/mineown?api=' + API_URL);
  type(domG, 'aname', 'occupied');
  await until(() =>  // the refusal banner is the positive signal
    !domG.window.document.getElementById('banner').hidden);
  ok(domG.window.location.pathname === '/mineown',
     'typing an occupied name does not navigate');
  ok(!domG.window.document.getElementById('banner').hidden
     && domG.window.document.getElementById('banner').textContent
          === STR.auctionExistsBanner('/fresh1').replace(/<[^>]+>/g, ''),
     "the refusal says why, in dreev's words");
  ok(!domG.window.document.getElementById('status').classList
       .contains('stale'),
     'the old ledger comes back to life after the refusal');
  // dreev saw (or thought he saw) a SILENT failure once: pin that a
  // repeat attempt after the banner auto-hides banners again
  domG.window.document.getElementById('banner').hidden = true;
  type(domG, 'aname', 'occupied');
  await until(() =>
    !domG.window.document.getElementById('banner').hidden);
  ok(!domG.window.document.getElementById('banner').hidden
     && domG.window.location.pathname === '/mineown',
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

  console.log('frontend-quals: all ' + passed + ' assertions passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
