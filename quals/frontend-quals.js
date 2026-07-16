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

// Microcopy derived from the app, so copy edits there don't break here
const STAMP = APP_JS.match(/el\('span', 'stamp', '([^']+)'\)/)[1];

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
  if (seed) seed(dom.window);  // e.g. pre-populate localStorage
  dom.window.eval(APP_JS);
  await sleep(50); // let init()'s awaits settle
  return dom;
}

function type(dom, id, text) {
  const input = dom.window.document.getElementById(id);
  input.value = text;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
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

(async () => {
  /* --- 1. bare visit: no server-invented name — the user picks ---------- */
  let dom = await makePage('/?api=' + API_URL);
  let doc = dom.window.document;
  ok(dom.window.location.pathname === '/', 'a bare visit stays at /');
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
  await sleep(600);  // past the switch debounce
  ok(dom.window.location.pathname === '/fresh1'
     && dom.window.location.search.includes('api='),
     'naming it navigates, keeping ?api=');
  ok(!doc.getElementById('roster-input').disabled
     && !doc.getElementById('status').classList.contains('stale'),
     'the named ledger wakes: + row live, gray gone');
  ok(doc.querySelectorAll('[data-tip][tabindex="-1"]').length === 1
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
       === 'Need at least one more bidder',
     'empty roster: the tip names the real blocker — too few'
     + ' participants, not phantom people to wait on');
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
  // her first add self-claimed (2j): row 0 is already hers
  ok(row(doc, 'bob').querySelector('.bid-card.slot')
     && !row(doc, 'bob').querySelector('.rebid'),
     "an empty card holds the space where bob's bid will land");
  // (subs superscript shelved 2026-07-15 for clutter; restore with the
  // commented code in app.js/style.css)
  // ok(tiles(doc)[0].querySelector('.tile-subs').textContent === '0',
  //    'submission counter reads 0 before bidding');
  ok(hoverBid(dom, 'bob') === 'awaiting bid...',
     'bidless cell tooltip: awaiting bid...');
  ok(doc.querySelector('#status .closed').textContent === '',
     'no Closed line while the auction lives');
  ok(doc.getElementById('seal'), 'seal-state badge present');
  ok(doc.getElementById('seal').getAttribute('data-tip')
       === 'Waiting for alice (you) and bob to bid...',
     'padlock tip NAMES the stragglers, tagging you as you');
  addName(dom, 'carol');
  await until(() => gas.handle({ action: 'state', aname: 'tau' })
    .roster.join(',') === 'alice,bob,carol');
  ok(doc.getElementById('seal').getAttribute('data-tip')
       === 'Waiting for alice (you), bob, and carol to bid...',
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
  ok(myInput(doc).className === 'bid-card stack0',
     'first bid: your editor becomes a single card, no stack');
  // (subs superscript shelved 2026-07-15)
  // ok(tiles(doc, '.has-bid')[0].querySelector('.tile-subs').textContent === '1',
  //    'submission counter ticks to 1');
  ok(/^your bid submitted \d+s ago$/.test(hoverBid(dom, 'alice')),
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
       === 'Waiting for bob to bid...',
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
       === 'Need at least one more bidder',
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
  ok(nameInp.value === 'alicw' && row(docT2, 'alicw'),
     'clicking away restores it too: enter is the only commit');
  renameTo(domT2, 'alicw', 'alice');
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
    !r2.window.document.getElementById('banner').hidden);
  ok(/^ERROR1304: Claimed by someone on /.test(
       r2.window.document.getElementById('banner').textContent),
     "the loser is told loudly — naming the winner's rig — not"
     + ' silently unseated later');
  await until(() =>
    row(r2.window.document, 'alice').querySelector('.tu').disabled);
  ok(row(r2.window.document, 'alice').querySelector('.tu').disabled
     && !r2.window.document.querySelector('#tiles .rebid'),
     'the recovery snapshot shows machine 2 the dibsed truth');
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
  await until(() =>
    row(r4.window.document, 'alice').querySelector('.tu').disabled);
  ok(!r4.window.document.querySelector('#tiles .rebid'),
     'machine 2 recovers to reality: dibsed star, no editor');

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
          === 'Claimed by someone on machina ignota',
     "the taken star FILLS in, and its tip names the claimant's rig"
     + " (jsdom's UA parses to the Latin unknown-device fallback)");

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
  ok(/^bid submitted \d+s ago$/.test(hoverBid(dom2, 'alice')),
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
  ok(seal2.getAttribute('data-tip') === 'Reveal bids!',
     'everyone in: the tip offers the reveal');
  seal2.click();
  await sleep(50);
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
  ok(doc2.getElementById('roster-input').disabled,
     'the roster is closed once revealed: the + row is off');
  ok(/^Closed \d{4}-\d{2}-\d{2} \d{2}:\d{2} (Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/
       .test(doc2.querySelector('#status .closed').textContent),
     "the Closed line stamps the moment, dreev's exact format: "
     + doc2.querySelector('#status .closed').textContent);
  ok(doc2.querySelector('#status .fete .stamp')
     && doc2.querySelector('#status .fete .stamp').textContent === STAMP
     && doc2.querySelectorAll('#status .fete .confetto').length >= 60,
     'the reveal ceremony: the stamp (copy derived from app.js, since'
     + ' dreev iterates it live) slams down amid confetti');
  ok(myInput(doc2) && !myInput(doc2).disabled,
     'bidding stays open after reveal (permissive)');

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
  ok(!late.window.document.querySelector('#status .fete'),
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
  ok(/^first submitted \d+s ago, resubmitted \d+s ago$/
       .test(hoverBid(domA, 'ann')),
     "re-submission tooltip: 'first submitted ..., resubmitted ...', got "
     + hoverBid(domA, 'ann'));
  ok(own[0].querySelector('.rebid input').className === 'bid-card stack1',
     're-bid stacks a sheet behind your card');
  await until(() =>  // domB polls
    tiles(domB.window.document, '.updated').length > 0);
  const shim = tiles(domB.window.document, '.updated');
  ok(shim.length === 1 && shim[0].dataset.uname === 'ann',
     "ann's row shimmers in another window after her re-bid");
  await until(() =>  // the next poll retires it
    !tiles(domB.window.document, '.updated').length);
  ok(!tiles(domB.window.document, '.updated').length, 'shimmer is one-shot');

  // stack depth caps at 3 layers; the counter stays exact
  for (let k = 0; k < 4; k++) {
    await sleep(4);  // stamps must differ
    typeBid(domA, 'edit ' + k);
    submitBid(domA);
    await settled(domA);
  }
  const annRow = tiles(domA.window.document, '.has-bid')[0];
  ok(annRow.querySelector('.bid-card').className === 'bid-card stack3',
     'stack depth caps at 3: ' + annRow.querySelector('.bid-card').className);
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
  await sleep(1800);  // settings flush + bid POST, both at 600ms
  mockDelay = 0;
  ok(domR.window.localStorage.getItem('tauction-mybids:elsewhere') === null,
     'no bid attributed to the auction you switched to');
  ok(JSON.parse(domR.window.localStorage.getItem('tauction-mybids:race') || '{}')
       .carl === 'zoom zoom',
     'bid remembered under the auction it was placed on');

  /* --- 3g. submitting shows progress on your row ------------------------ */
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
     && myInput(domP.window.document).disabled,
     'your row shows busy state while the bid is in flight');
  await sleep(400);
  mockDelay = 0;
  ok(!domP.window.document.querySelector('#tiles .rebid').classList
       .contains('busy')
     && !myInput(domP.window.document).disabled,
     'busy state clears after the response');

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

  /* --- 3f. legacy bid rows (blank bcount) still count -------------------- */
  gas.__ss.sheets['bids'].appendRow(['legacy', 'oldtimer', 'ancient bid',
    '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
  const domL = await makePage('/legacy?api=' + API_URL);
  const rowL = tiles(domL.window.document, '.has-bid')[0];
  // (subs superscript shelved 2026-07-15; the floor-at-1 rule now shows
  // in the tooltip taking the single-submission branch)
  ok(rowL && /^bid submitted \d+d ago$/
       .test(hoverBid(domL, 'oldtimer')),
     'legacy row floors at 1 submission: tooltip takes the single-'
     + 'submission branch, got ' + hoverBid(domL, 'oldtimer'));
  ok(rowL.querySelector('.bid-card.stack0'), 'legacy row: single card');

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
  await sleep(700);  // debounce + the gate's lookup
  ok(domG.window.location.pathname === '/mineown',
     'typing an occupied name does not navigate');
  ok(!domG.window.document.getElementById('banner').hidden
     && domG.window.document.getElementById('banner').textContent
          === 'Auction exists \u2014 use the URL to join it',
     "the refusal says why, in dreev's words");
  ok(!domG.window.document.getElementById('status').classList
       .contains('stale'),
     'the old ledger comes back to life after the refusal');
  // dreev saw (or thought he saw) a SILENT failure once: pin that a
  // repeat attempt after the banner auto-hides banners again
  domG.window.document.getElementById('banner').hidden = true;
  type(domG, 'aname', 'occupied');
  await sleep(700);  // debounce + the gate's lookup
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
