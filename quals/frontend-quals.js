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
const OPS = ['add', 'remove', 'claim'];
let opsInFlight = 0;
let opsOverlapped = false;

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
  const res = gas.handle(req);
  return new Promise((resolve) => setTimeout(() => {
    if (OPS.includes(req.action)) opsInFlight--;
    resolve({ json: () => Promise.resolve(res) });
  }, mockDelay));
}

/* ----------------------------- jsdom setup ---------------------------- */

const INDEX_HTML = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const APP_JS = fs.readFileSync(path.join(REPO, 'app.js'), 'utf8');

// Microcopy derived from the app so copy edits there don't break here
const BID_HINT = APP_JS.match(/BID_HINT = '([^']+)'/)[1];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makePage(pathAndQuery, seed) {
  const dom = new JSDOM(INDEX_HTML, {
    url: 'https://tauction.dreev.es' + pathAndQuery,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  dom.window.fetch = mockFetch;
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

const myInput = (doc) => doc.querySelector('#tiles .tile.mine .rebid input');

const tiles = (doc, sel = '') => doc.querySelectorAll('#tiles .tile' + sel);

/* ------------------------------- quals -------------------------------- */

let passed = 0;
function ok(cond, label) {
  if (!cond) { console.error('FAIL: ' + label); process.exit(1); }
  passed++;
}

(async () => {
  /* --- 1. fresh visit to root: fresh slug, empty BIDS box --------------- */
  let dom = await makePage('/?api=' + API_URL);
  let doc = dom.window.document;
  const slug1 = dom.window.location.pathname.slice(1);
  ok(/^[a-z0-9]+$/.test(slug1), 'root redirected to a slug: ' + slug1);
  ok(doc.getElementById('aname').value === slug1, 'auction field shows slug');
  ok(apiCalls.some((c) => c.action === 'fresh'), 'asked server for fresh slug');
  ok(dom.window.location.search.includes('api='), '?api= survives redirect');
  ok(doc.querySelectorAll('.tip[data-tip][tabindex="-1"]').length >= 2,
     'tooltips tap-focusable but not tab stops');
  ok(doc.querySelector('#status .thead .th-person').textContent
       .includes('PARTICIPANTS')
     && doc.querySelector('#status .thead .th-bid').textContent
       .includes('BIDS'),
     'column headings PARTICIPANTS | BIDS lead the section');
  ok(!doc.querySelector('#status .card-title'),
     'no separate section heading above the column headings');
  ok(doc.querySelector('#status .th-person .tip'),
     'the mechanic tooltip sits with PARTICIPANTS');
  ok(doc.querySelector('#status .th-bid #seal'),
     'the padlock sits with BIDS');
  ok(tiles(doc).length === 0, 'an auction with no roster is just an empty box');
  ok(doc.querySelector('#status .addrow #roster-input'),
     'the + row is part of the ledger from the start');
  ok(!doc.getElementById('status').classList.contains('revealed'),
     'tada not lit before any reveal');

  /* --- 1b. no blank-roster flash while an auction loads ------------------
     Replicata: open an auction page; the first state fetch takes a
     second (real Apps Script latency). Expectata: a visitor never sees
     what looks like a confirmed-empty roster — a returning browser
     paints its cached rows instantly (grayed till the live fetch), and
     a first-time browser sees a loading pulse, swept by the first
     render. */
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
  ok(domCold.window.document.querySelector('#tiles .loading')
     && tiles(domCold.window.document).length === 0,
     'first-ever visit: a loading pulse, not a confirmed-empty roster');
  await sleep(1000);
  mockDelay = 0;
  ok(!domWarm.window.document.getElementById('status').classList.contains('stale'),
     'warm page ungrays once the live fetch lands');
  ok(!domCold.window.document.querySelector('#tiles .loading'),
     'the first render sweeps the loading pulse away');
  ok(JSON.parse(domWarm.window.localStorage.getItem('tauction-state:warm'))
       .roster.join(',') === 'ann,ben',
     'every ingested state refreshes the cache');

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
  ok(doc.getElementById('status').textContent.includes('@alice')
     && doc.getElementById('status').textContent.includes('@bob'),
     'rows are named');
  ok(tiles(doc)[0].querySelector('.bid-card.slot')
     && !tiles(doc)[0].querySelector('.rebid'),
     'an empty card holds the space where the bid will land');
  ok(tiles(doc)[0].querySelector('.tile-subs').textContent === '0',
     'submission counter reads 0 before bidding');
  ok(doc.getElementById('seal'), 'seal-state badge present');
  ok(doc.getElementById('seal').getAttribute('data-tip') === 'Reveal bids!',
     'padlock carries its tooltip');
  ok(doc.getElementById('share') && doc.getElementById('help'),
     'share and help buttons present');
  ok(doc.getElementById('share-dlg') && doc.getElementById('help-dlg'),
     'share and help dialogs present');
  ok(doc.getElementById('help-dlg').textContent.includes(
       'You could use it to get independent estimates of how long '
       + 'something will take to implement.'),
     'help dialog carries the sealedbids text verbatim');
  ok(/^-\d+ms$/.test(tiles(doc)[0].style.animationDelay),
     'empty rows phase-locked so poll rebuilds do not jump the fade');

  // nobody claimed yet: every row leads with a claimable star, none is
  // editable
  ok([...tiles(doc)].every((t) => t.querySelector('.tu')
       && !t.querySelector('.tu').disabled
       && !t.querySelector('.tu').classList.contains('selected')),
     'unclaimed: every row leads with a claimable star');
  ok(!doc.querySelector('#tiles .rebid'), 'unclaimed: no row is editable');
  ok([...tiles(doc)].every((t) => t.querySelector('.x')
       && !t.querySelector('.x').disabled),
     'every row offers a live × while bidless');

  claimRow(dom, 'alice');
  ok(dom.window.localStorage.getItem('tauction-uname') === 'alice',
     'claiming a row latches the name');
  ok(row(doc, 'alice').classList.contains('mine')
     && myInput(doc), 'claimed row becomes yours, with an in-place editor');
  ok(doc.activeElement === myInput(doc), 'claiming focuses the editor');
  ok(myInput(doc).placeholder === BID_HINT && myInput(doc).value === '',
     'fresh editor: stock hint, no text');
  ok(row(doc, 'alice').querySelector('.tu').classList.contains('selected'),
     "your row's star is lit");
  ok(row(doc, 'bob').querySelector('.tu')
     && !row(doc, 'bob').querySelector('.tu').disabled,
     'other bidless rows keep live stars (radio: one click to switch)');

  typeBid(dom, 'three tacos');
  submitBid(dom);
  await sleep(50);
  ok(myInput(doc).value === 'three tacos',
     'own bid lives in your row, editable in place');
  ok(tiles(doc, '.has-bid').length === 1 && tiles(doc).length === 2,
     'one green, one empty after first bid');
  ok(!tiles(doc, '.has-bid')[0].classList.contains('cut'),
     'roster member not crossed out');
  ok(myInput(doc).className === 'bid-card stack0',
     'first bid: your editor becomes a single card, no stack');
  ok(tiles(doc, '.has-bid')[0].querySelector('.tile-subs').textContent === '1',
     'submission counter ticks to 1');
  ok(tiles(doc, '.has-bid')[0].style.animationDelay === '',
     'green rows carry no animation delay (shimmer unaffected)');
  ok(JSON.parse(dom.window.localStorage.getItem('tauction-mybids:tau')).alice
     === 'three tacos', 'own bid persisted');
  ok(!row(doc, 'alice').querySelector('.tu').disabled,
     'your own bid never dibses you out of your own row');
  ok(row(doc, 'alice').querySelector('.x').disabled,
     'the × grays out once a bid is in (a sealed bid is never deletable)');
  ok(!row(doc, 'bob').querySelector('.x').disabled,
     'the bidless row keeps its live ×');
  ok(row(doc, 'alice').querySelector('.x').parentElement
       === row(doc, 'alice'),
     'the × belongs to the whole row, not the bid cell');
  ok(doc.getElementById('seal').disabled
     && !doc.getElementById('seal').classList.contains('ready'),
     'padlock locked while bob is outstanding');

  /* --- 2b. fresh auction: add yourself, claim, bid — seat uncut --------- */
  const domF = await makePage('/freshie?api=' + API_URL);
  addName(domF, 'zoe');
  claimRow(domF, 'zoe');
  typeBid(domF, 'me first');
  submitBid(domF);
  await sleep(50);
  const zoeRow = tiles(domF.window.document, '.has-bid')[0];
  ok(zoeRow && !zoeRow.classList.contains('cut'),
     'your own fresh-auction bid is never crossed out');
  ok(!domF.window.document.getElementById('status').classList.contains('revealed'),
     'solo bid stays sealed (no instant self-reveal, no latch footgun)');
  ok(domF.window.document.getElementById('seal').disabled,
     'padlock stays locked for a solo bidder');

  /* --- 2c. roster edits register instantly; grayed until confirmed ------ */
  const domO = await makePage('/optimist?api=' + API_URL);
  mockDelay = 300;
  addName(domO, 'pam');
  await sleep(30);  // long before the 700ms debounce + 300ms latency
  ok(tiles(domO.window.document).length === 1
     && domO.window.document.getElementById('status').textContent.includes('@pam'),
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
  addName(domO, 'pam');
  claimRow(domO, 'pam');
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
  await sleep(2400);           // three serialized ops land
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

  /* --- 2f. two machines can't both be alice ------------------------------
     Replicata (dreev's bug report): machine 1 adds alice to the roster
     and claims her; machine 2 opens the auction and clicks alice's star
     too; both machines bid as alice. Resultata pre-fix: both believed
     they were alice and silently overwrote each other's bid. Expectata:
     claims are server truth — as soon as machine 1's claim lands, every
     other machine shows alice dibsed and gets no editor for her. */
  const m1 = await makePage('/twoalices?api=' + API_URL);
  addName(m1, 'alice');
  claimRow(m1, 'alice');
  await sleep(800);  // roster push + claim land on the server
  const m2 = await makePage('/twoalices?api=' + API_URL);
  await sleep(20);
  ok(row(m2.window.document, 'alice').querySelector('.tu').disabled,
     "machine 2 sees alice dibsed: machine 1's claim is server truth");
  ok(!m2.window.document.querySelector('#tiles .rebid'),
     'machine 2 gets no editor for alice');
  typeBid(m1, 'the real bid');
  submitBid(m1);
  await sleep(50);
  ok(myInput(m1.window.document).value === 'the real bid',
     'machine 1, the claim holder, bids normally');
  ok(row(m2.window.document, 'alice').querySelector('.tu').disabled,
     'alice stays dibsed on machine 2');

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
  claimRow(dom2, 'bob');
  typeBid(dom2, '$40 and my dignity');
  submitBid(dom2);
  await sleep(50);
  ok(!doc2.getElementById('status').classList.contains('revealed')
     && !doc2.getElementById('status').textContent.includes('three tacos'),
     'roster complete: still sealed until someone presses reveal');
  const seal2 = doc2.getElementById('seal');
  ok(!seal2.disabled && seal2.classList.contains('ready'),
     'padlock unlocks when the roster is complete');
  seal2.click();
  await sleep(50);
  ok(doc2.querySelector('#status .th-bid').textContent.includes('BIDS'),
     'BIDS column heading, before and after reveal');
  ok(doc2.getElementById('status').textContent.includes('three tacos')
     && myInput(doc2).value === '$40 and my dignity',
     "both bids shown: alice's card and bob's own editable row");
  ok(tiles(doc2, '.has-bid').length === 2, 'all rows green after reveal');
  ok([...doc2.querySelectorAll('#status .tile.has-bid .tile-subs')]
     .every((e) => parseInt(e.textContent, 10) >= 1),
     'invariant: green rows always count at least 1');
  ok(doc2.getElementById('status').classList.contains('revealed')
     && doc2.getElementById('status').classList.contains('just-revealed'),
     'reveal lights the tada and glows, once');
  ok(myInput(doc2) && !myInput(doc2).disabled,
     'bidding stays open after reveal (permissive)');

  // first window catches up via polling (jsdom timers run; wait one poll)
  await sleep(5100);
  ok(doc.getElementById('status').textContent.includes('$40 and my dignity'),
     "first window sees bob's bid via polling after reveal");
  ok(doc.getElementById('status').classList.contains('just-revealed'),
     'the reveal moment animates in every watching window');
  ok(doc2.getElementById('status').classList.contains('revealed')
     && !doc2.getElementById('status').classList.contains('just-revealed'),
     'the reveal animation is one-shot');
  const late = await makePage('/tau?api=' + API_URL);
  await sleep(20);
  ok(late.window.document.getElementById('status').classList.contains('revealed')
     && !late.window.document.getElementById('status').classList
          .contains('just-revealed'),
     'arriving after the fact: lit tada, no fanfare');
  ok(late.window.document.getElementById('status').textContent
       .includes('three tacos')
     && late.window.document.getElementById('status').textContent
       .includes('$40 and my dignity'),
     'a fresh window sees both revealed bids as cards');

  /* --- 3b. shimmer + stacks: re-bids glow anew in every window ---------- */
  gas.handle({ action: 'add', aname: 'wobble', uname: 'ann' });
  gas.handle({ action: 'add', aname: 'wobble', uname: 'zed' });
  const domA = await makePage('/wobble?api=' + API_URL);
  claimRow(domA, 'ann');
  typeBid(domA, 'first');
  submitBid(domA);
  await sleep(50);
  ok(tiles(domA.window.document, '.has-bid').length === 1, 'ann row green');
  const domB = await makePage('/wobble?api=' + API_URL);
  await sleep(20);
  ok(!tiles(domB.window.document, '.updated').length,
     'no shimmer before any update');
  await sleep(5);  // updated stamps must differ
  typeBid(domA, 'second');
  submitBid(domA);
  await sleep(50);
  const own = tiles(domA.window.document, '.updated');
  ok(own.length === 1 && own[0].querySelector('.rebid input').value === 'second',
     'own re-bid shimmers and holds the new text');
  ok(own[0].querySelector('.tile-subs').textContent === '2',
     'counter ticks on re-submission');
  ok(own[0].querySelector('.rebid input').className === 'bid-card stack1',
     're-bid stacks a sheet behind your card');
  await sleep(5100);  // domB polls
  const shim = tiles(domB.window.document, '.updated');
  ok(shim.length === 1 && shim[0].textContent.includes('@ann'),
     "ann's row shimmers in another window after her re-bid");
  await sleep(5100);  // next poll: no further change
  ok(!tiles(domB.window.document, '.updated').length, 'shimmer is one-shot');

  // stack depth caps at 3 layers; the counter stays exact
  for (let k = 0; k < 4; k++) {
    await sleep(4);  // stamps must differ
    typeBid(domA, 'edit ' + k);
    submitBid(domA);
    await sleep(30);
  }
  const annRow = tiles(domA.window.document, '.has-bid')[0];
  ok(annRow.querySelector('.bid-card').className === 'bid-card stack3',
     'stack depth caps at 3: ' + annRow.querySelector('.bid-card').className);
  ok(annRow.querySelector('.tile-subs').textContent === '6',
     'counter keeps the exact count past the cap');

  /* --- 3c. identity switch: alice re-bids as bob in the same browser ----
     The stars are a radio: one click on another star switches who you
     are; a click on your own lit star releases you to nobody. The
     browser remembers every bid IT placed, keyed by uname, so both rows
     stay readable here while other windows see two sealed bids. */
  gas.handle({ action: 'add', aname: 'switcheroo', uname: 'alice' });
  gas.handle({ action: 'add', aname: 'switcheroo', uname: 'bob' });
  gas.handle({ action: 'add', aname: 'switcheroo', uname: 'cam' });
  const domS = await makePage('/switcheroo?api=' + API_URL);
  const docS = domS.window.document;
  claimRow(domS, 'alice');
  typeBid(domS, 'first secret');
  submitBid(domS);
  await sleep(50);
  claimRow(domS, 'bob');  // radio: one click switches alice -> bob
  ok(domS.window.localStorage.getItem('tauction-uname') === 'bob'
     && row(docS, 'bob').querySelector('.tu').classList.contains('selected'),
     'one click on another star switches who you are');
  ok(!row(docS, 'alice').querySelector('.tu').disabled,
     'your own placed bid does not dibs the row against you');
  ok(docS.getElementById('status').textContent.includes('first secret'),
     "alice's bid stays readable after switching away");
  claimRow(domS, 'bob');  // your own lit star: release to nobody
  ok(!docS.querySelector('#tiles .tu.selected')
     && !docS.querySelector('#tiles .rebid'),
     'clicking your lit star releases: nobody again, no editor');
  claimRow(domS, 'bob');
  ok(myInput(docS).value === '' && myInput(docS).placeholder === BID_HINT,
     'a fresh claim starts a fresh editor (bob has no bid yet)');
  typeBid(domS, 'second secret');
  submitBid(domS);
  await sleep(50);
  ok(docS.getElementById('status').textContent.includes('first secret')
     && myInput(docS).value === 'second secret',
     'both of your identities\' bids readable in your window');
  ok(!docS.querySelector('#status .tile-bid .masked'),
     'nothing masked in the window that placed both bids');
  const mybids = JSON.parse(
    domS.window.localStorage.getItem('tauction-mybids:switcheroo'));
  ok(mybids.alice === 'first secret' && mybids.bob === 'second secret',
     'both bids remembered per uname');
  const domT = await makePage('/switcheroo?api=' + API_URL);
  await sleep(20);
  const otherSees = domT.window.document.getElementById('status').textContent;
  ok(domT.window.document.querySelectorAll('#status .tile-bid .masked').length === 2
     && !otherSees.includes('secret'),
     'other windows see two sealed bids, no text');

  /* --- 3e. bid response landing after you switch auctions ---------------
     Replicata: submit a bid, then switch to another auction while the POST
     is in flight. Expectata: the bid is remembered under the auction it
     was placed on. */
  const domR = await makePage('/race?api=' + API_URL);
  addName(domR, 'carl');
  claimRow(domR, 'carl');
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
  addName(domP, 'pat');
  await sleep(800);  // roster push done: the bid is the only POST in flight
  claimRow(domP, 'pat');
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
  addName(domD, 'dan');
  claimRow(domD, 'dan');
  typeBid(domD, 'half a tho');
  myInput(domD.window.document).setSelectionRange(4, 4);
  await sleep(5100);  // a poll rebuilds the rows
  ok(myInput(domD.window.document).value === 'half a tho',
     'draft bid survives the poll rebuild');
  ok(domD.window.document.activeElement === myInput(domD.window.document),
     'focus survives the poll rebuild');
  ok(myInput(domD.window.document).selectionStart === 4,
     'caret position survives the poll rebuild');

  /* --- 3f. legacy bid rows (predating the subs column) still count ------ */
  gas.__ss.sheets['bids'].appendRow(['legacy', 'oldtimer', 'ancient bid',
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
  const domL = await makePage('/legacy?api=' + API_URL);
  const rowL = tiles(domL.window.document, '.has-bid')[0];
  ok(rowL && rowL.querySelector('.tile-subs').textContent === '1',
     'a green row never shows 0, even for legacy data');
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
     && doc4.getElementById('status').textContent.includes('@evy'),
     'named empty rows for the roster');
  await sleep(800); // settings debounce
  ok(apiCalls.some((c) => c.action === 'add' && c.uname === 'dee')
     && apiCalls.some((c) => c.action === 'add' && c.uname === 'evy'),
     'adds pushed to the server as row ops');

  claimRow(dom4, 'dee');
  typeBid(dom4, 'i bid 2 dishes');
  submitBid(dom4);
  await sleep(50);
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

  // a path that isn't a slug just becomes a fresh auction
  const domWeird = await makePage('/no/such/path?api=' + API_URL);
  const weirdPath = domWeird.window.location.pathname;
  ok(/^\/[a-z0-9]+$/.test(weirdPath) && weirdPath !== '/no',
     'non-slug path becomes a fresh auction: ' + weirdPath);
  ok(domWeird.window.location.search.includes('api='),
     '?api= preserved on the fresh-auction redirect');

  console.log('frontend-quals: all ' + passed + ' assertions passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
