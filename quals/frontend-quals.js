// Quals for the frontend: the real index.html + app.js running in jsdom,
// with fetch bridged to the real Code.gs logic on an in-memory fake
// spreadsheet. Covers roster/bid/reveal flows, the BIDS box (rows, cards,
// stacks, shimmer, cut, tada), own-bid visibility, URL handling, and the
// 404.html direct-navigation journey.
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

function mockFetch(url, opts) {
  url = String(url);
  if (!url.startsWith(API_URL)) return Promise.reject(new Error('unexpected URL ' + url));
  let req;
  if (opts && opts.method === 'POST') req = JSON.parse(opts.body);
  else req = Object.fromEntries(new URL(url).searchParams);
  apiCalls.push(req);
  const res = gas.handle(req);
  return new Promise((resolve) => setTimeout(
    () => resolve({ json: () => Promise.resolve(res) }), mockDelay));
}

/* ----------------------------- jsdom setup ---------------------------- */

const INDEX_HTML = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const APP_JS = fs.readFileSync(path.join(REPO, 'app.js'), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makePage(pathAndQuery) {
  const dom = new JSDOM(INDEX_HTML, {
    url: 'https://tauction.dreev.es' + pathAndQuery,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  dom.window.fetch = mockFetch;
  dom.window.eval(APP_JS);
  await sleep(50); // let init()'s awaits settle
  return dom;
}

function type(dom, id, text) {
  const input = dom.window.document.getElementById(id);
  input.value = text;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

function addChip(dom, uname) {
  type(dom, 'roster-input', uname);
  dom.window.document.getElementById('roster-input').dispatchEvent(
    new dom.window.KeyboardEvent('keydown',
      { key: 'Enter', bubbles: true, cancelable: true }));
}

function submitBid(dom) {
  dom.window.document.getElementById('bid-form').dispatchEvent(
    new dom.window.Event('submit', { bubbles: true, cancelable: true }));
}

const tiles = (doc, sel = '') => doc.querySelectorAll('#status .tile' + sel);

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
  ok(doc.querySelector('#status .card-title').textContent.includes('BIDS'),
     'BIDS box is present from the start');
  ok(tiles(doc).length === 0, 'an auction with no roster is just an empty box');
  ok(!doc.getElementById('status').classList.contains('revealed'),
     'tada not lit before any reveal');

  /* --- 2. alice sets up /tau and bids; her own bid stays visible ------- */
  dom = await makePage('/tau?api=' + API_URL);
  doc = dom.window.document;
  addChip(dom, 'alice');
  addChip(dom, 'bob');
  await sleep(800);  // roster push debounce
  ok(tiles(doc).length === 2, 'roster of 2 -> two rows');
  ok(tiles(doc, '.has-bid').length === 0, 'both rows empty slots');
  ok(doc.getElementById('status').textContent.includes('@alice')
     && doc.getElementById('status').textContent.includes('@bob'),
     'rows are named');
  ok(tiles(doc)[0].querySelector('.tile-bid').textContent === '',
     'empty bid slot before any bids');
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
       'When the last person has responded, all the responses are revealed.'),
     'help dialog carries the sealedbids text verbatim');
  ok(!doc.getElementById('settings').classList.contains('revealed'),
     'roster box at full strength while sealed');
  ok(/^-\d+ms$/.test(tiles(doc)[0].style.animationDelay),
     'empty rows phase-locked so poll rebuilds do not jump the fade');

  type(dom, 'uname', 'Alice!');
  ok(doc.getElementById('uname').value === 'alice', 'name sanitized while typing');
  type(dom, 'bid', 'three tacos');
  submitBid(dom);
  await sleep(50);
  const statusText = doc.getElementById('status').textContent;
  ok(statusText.includes('three tacos'), 'own bid visible in own row');
  ok(tiles(doc, '.has-bid').length === 1 && tiles(doc).length === 2,
     'one green, one empty after first bid');
  ok(!tiles(doc, '.has-bid')[0].classList.contains('cut'),
     'roster member not crossed out');
  ok(doc.getElementById('bid').value === '', 'bid input cleared after placing');
  ok(doc.getElementById('bid').placeholder === 'three tacos',
     'own bid becomes the placeholder');
  ok(tiles(doc, '.has-bid')[0].querySelector('.tile-subs').textContent === '1',
     'submission counter ticks to 1');
  ok(tiles(doc, '.has-bid')[0].querySelector('.bid-card.stack0'),
     'first bid: a single card, no stack');
  ok(tiles(doc, '.has-bid')[0].style.animationDelay === '',
     'green rows carry no animation delay (shimmer unaffected)');
  ok(JSON.parse(dom.window.localStorage.getItem('tauction-mybids:tau')).alice
     === 'three tacos', 'own bid persisted');
  ok(doc.getElementById('seal').disabled
     && !doc.getElementById('seal').classList.contains('ready'),
     'padlock locked while bob is outstanding');
  ok(dom.window.localStorage.getItem('tauction-uname') === 'alice',
     'name persisted');

  /* --- 2b. bidding on a rosterless auction claims a seat, uncrossed ----- */
  const domF = await makePage('/freshie?api=' + API_URL);
  type(domF, 'uname', 'zoe');
  type(domF, 'bid', 'me first');
  submitBid(domF);
  await sleep(50);
  const zoeRow = tiles(domF.window.document, '.has-bid')[0];
  ok(zoeRow && !zoeRow.classList.contains('cut'),
     'your own fresh-auction bid is never crossed out');
  ok(domF.window.document.getElementById('chips').textContent.includes('@zoe'),
     'bidding added you to the roster chips');
  ok(!domF.window.document.getElementById('status').classList.contains('revealed'),
     'solo bid stays sealed (no instant self-reveal, no latch footgun)');
  ok(domF.window.document.getElementById('seal').disabled,
     'padlock stays locked for a solo bidder');

  /* --- 2c. roster edits register instantly; grayed until confirmed ------ */
  const domO = await makePage('/optimist?api=' + API_URL);
  mockDelay = 300;
  addChip(domO, 'pam');
  await sleep(30);  // long before the 700ms debounce + 300ms latency
  ok(tiles(domO.window.document).length === 1
     && domO.window.document.getElementById('status').textContent.includes('@pam'),
     'added person appears in the BIDS box immediately');
  ok(domO.window.document.getElementById('status').classList.contains('stale'),
     'box grayed while the server has not confirmed');
  await sleep(1300);
  mockDelay = 0;
  ok(!domO.window.document.getElementById('status').classList.contains('stale'),
     'ungrays once the server confirms');
  domO.window.document.querySelector('#chips .chip .x').click();
  await sleep(30);
  ok(tiles(domO.window.document).length === 0,
     'removal empties the row immediately');
  ok(domO.window.document.getElementById('status').classList.contains('stale'),
     'grayed again until the removal is confirmed');

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
  type(dom2, 'uname', 'bob');
  type(dom2, 'bid', '$40 and my dignity');
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
  const revealed2 = doc2.getElementById('status').textContent;
  ok(doc2.querySelector('#status .card-title').textContent.includes('BIDS'),
     'bids box label is BIDS, before and after reveal');
  ok(revealed2.includes('three tacos') && revealed2.includes('$40 and my dignity'),
     'both bids shown');
  ok(tiles(doc2, '.has-bid').length === 2, 'all rows green after reveal');
  ok([...doc2.querySelectorAll('#status .tile.has-bid .tile-subs')]
     .every((e) => parseInt(e.textContent, 10) >= 1),
     'invariant: green rows always count at least 1');
  ok(doc2.getElementById('status').classList.contains('revealed')
     && doc2.getElementById('status').classList.contains('just-revealed'),
     'reveal lights the tada and glows, once');
  ok(!doc2.getElementById('place').disabled,
     'bidding stays open after reveal (permissive)');
  ok(doc2.getElementById('settings').classList.contains('revealed'),
     'roster box grays out at reveal (still editable)');

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

  /* --- 3b. shimmer + stacks: re-bids glow anew in every window ---------- */
  gas.handle({ action: 'settings', aname: 'wobble', roster: ['ann', 'zed'] });
  const domA = await makePage('/wobble?api=' + API_URL);
  type(domA, 'uname', 'ann');
  type(domA, 'bid', 'first');
  submitBid(domA);
  await sleep(50);
  ok(tiles(domA.window.document, '.has-bid').length === 1, 'ann row green');
  const domB = await makePage('/wobble?api=' + API_URL);
  await sleep(20);
  ok(!tiles(domB.window.document, '.updated').length,
     'no shimmer before any update');
  await sleep(5);  // updated stamps must differ
  type(domA, 'bid', 'second');
  submitBid(domA);
  await sleep(50);
  const own = tiles(domA.window.document, '.updated');
  ok(own.length === 1 && own[0].textContent.includes('second'),
     'own re-bid shimmers and shows the new text');
  ok(own[0].querySelector('.tile-subs').textContent === '2',
     'counter ticks on re-submission');
  ok(own[0].querySelector('.bid-card.stack1'),
     're-bid stacks a sheet behind the card');
  await sleep(5100);  // domB polls
  const shim = tiles(domB.window.document, '.updated');
  ok(shim.length === 1 && shim[0].textContent.includes('@ann'),
     "ann's row shimmers in another window after her re-bid");
  await sleep(5100);  // next poll: no further change
  ok(!tiles(domB.window.document, '.updated').length, 'shimmer is one-shot');

  // stack depth caps at 3 layers; the counter stays exact
  for (let k = 0; k < 4; k++) {
    await sleep(4);  // stamps must differ
    type(domA, 'bid', 'edit ' + k);
    submitBid(domA);
    await sleep(30);
  }
  const annRow = tiles(domA.window.document, '.has-bid')[0];
  ok(annRow.querySelector('.bid-card').className === 'bid-card stack3',
     'stack depth caps at 3: ' + annRow.querySelector('.bid-card').className);
  ok(annRow.querySelector('.tile-subs').textContent === '6',
     'counter keeps the exact count past the cap');

  /* --- 3c. identity switch: alice re-bids as bob in the same browser ----
     The browser remembers every bid IT placed, keyed by uname, so both
     rows stay readable here while other windows see two sealed bids. */
  gas.handle({ action: 'settings', aname: 'switcheroo',
               roster: ['alice', 'bob', 'cam'] });
  const domS = await makePage('/switcheroo?api=' + API_URL);
  type(domS, 'uname', 'alice');
  type(domS, 'bid', 'first secret');
  submitBid(domS);
  await sleep(50);
  type(domS, 'uname', 'bob');
  const docS = domS.window.document;
  ok(docS.getElementById('status').textContent.includes('first secret'),
     "alice's bid stays readable after renaming yourself to bob");
  ok(docS.getElementById('bid').placeholder === '',
     'placeholder follows the current name (bob has no bid yet)');
  type(domS, 'bid', 'second secret');
  submitBid(domS);
  await sleep(50);
  ok(docS.getElementById('status').textContent.includes('first secret')
     && docS.getElementById('status').textContent.includes('second secret'),
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
  type(domR, 'uname', 'carl');
  type(domR, 'bid', 'zoom zoom');
  mockDelay = 600;  // response lands after the 500ms auction-switch debounce
  submitBid(domR);
  type(domR, 'aname', 'elsewhere');
  await sleep(1200);
  mockDelay = 0;
  ok(domR.window.localStorage.getItem('tauction-mybids:elsewhere') === null,
     'no bid attributed to the auction you switched to');
  ok(JSON.parse(domR.window.localStorage.getItem('tauction-mybids:race') || '{}')
       .carl === 'zoom zoom',
     'bid remembered under the auction it was placed on');

  /* --- 3g. submitting shows progress on the button ---------------------- */
  const domP = await makePage('/progress?api=' + API_URL);
  type(domP, 'uname', 'pat');
  type(domP, 'bid', 'hurry');
  mockDelay = 200;
  submitBid(domP);
  await sleep(50);
  ok(domP.window.document.getElementById('place').disabled
     && domP.window.document.getElementById('place').classList.contains('busy'),
     'submit button shows busy state while the bid is in flight');
  await sleep(400);
  mockDelay = 0;
  ok(!domP.window.document.getElementById('place').classList.contains('busy')
     && !domP.window.document.getElementById('place').disabled,
     'busy state clears after the response');

  /* --- 3f. legacy bid rows (predating the subs column) still count ------ */
  gas.__ss.sheets['bids'].appendRow(['legacy', 'oldtimer', 'ancient bid',
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
  const domL = await makePage('/legacy?api=' + API_URL);
  const rowL = tiles(domL.window.document, '.has-bid')[0];
  ok(rowL && rowL.querySelector('.tile-subs').textContent === '1',
     'a green row never shows 0, even for legacy data');
  ok(rowL.querySelector('.bid-card.stack0'), 'legacy row: single card');

  /* --- 4. a second auction via the auction field; grayed while loading -- */
  apiCalls = [];
  mockDelay = 150;
  type(dom2, 'aname', 'Pie-Split');
  ok(doc2.getElementById('aname').value === 'piesplit', 'slug sanitized');
  await sleep(550);  // past the switch debounce; response still in flight
  ok(!doc2.getElementById('status').hidden
     && doc2.getElementById('status').classList.contains('stale'),
     'bids box stays visible while loading, just grayed');
  await sleep(300);
  mockDelay = 0;
  ok(!doc2.getElementById('status').classList.contains('stale'),
     'box ungrays once loaded');
  ok(dom2.window.location.pathname === '/piesplit', 'URL follows slug edit');
  ok(doc2.getElementById('bid').placeholder === '',
     'placeholder resets to the stock hint on a new auction');

  addChip(dom2, 'dee');
  addChip(dom2, 'evy');
  ok(doc2.getElementById('chips').textContent.includes('@dee')
     && doc2.getElementById('chips').textContent.includes('@evy'), 'chips render');
  await sleep(800); // settings debounce
  ok(apiCalls.some((c) => c.action === 'settings'
     && c.roster.join(',') === 'dee,evy'), 'settings pushed to server');
  ok(tiles(doc2).length === 2
     && doc2.getElementById('status').textContent.includes('@evy'),
     'named empty rows for the roster');

  type(dom2, 'uname', 'dee');
  type(dom2, 'bid', 'i bid 2 dishes');
  submitBid(dom2);
  await sleep(50);
  ok(doc2.getElementById('status').textContent.includes('i bid 2 dishes'),
     'own roster bid visible');
  ok([...tiles(doc2, '.has-bid')].some((t) => t.textContent.includes('@dee'))
     && [...tiles(doc2, ':not(.has-bid)')].some((t) => t.textContent.includes('@evy')),
     'dee green, evy still empty');
  const evyRow = [...tiles(doc2)].find((t) => t.textContent.includes('@evy'));
  ok(evyRow.querySelector('.tile-bid').textContent === '',
     "evy's row is an empty slot");

  /* --- 4b. bidders cut from the roster stay visible, crossed out -------- */
  gas.handle({ action: 'settings', aname: 'cutcheck',
               roster: ['pat', 'quinn'] });
  gas.handle({ action: 'bid', aname: 'cutcheck', uname: 'pat', bid: 'stays' });
  gas.handle({ action: 'settings', aname: 'cutcheck',
               roster: ['quinn'] });  // pat removed after bidding
  const domC = await makePage('/cutcheck?api=' + API_URL);
  const patRow = [...tiles(domC.window.document)].find((t) =>
    t.textContent.includes('@pat'));
  ok(patRow && patRow.classList.contains('has-bid')
     && patRow.classList.contains('cut'),
     'bid-then-removed bidder stays in the box, crossed out');
  ok(![...tiles(domC.window.document)].find((t) =>
       t.textContent.includes('@quinn')).classList.contains('cut'),
     'roster members are not crossed out');
  gas.handle({ action: 'bid', aname: 'cutcheck', uname: 'pat', bid: 'back in' });
  const domC2 = await makePage('/cutcheck?api=' + API_URL);
  ok(![...tiles(domC2.window.document)].find((t) =>
       t.textContent.includes('@pat')).classList.contains('cut'),
     're-bidding rejoins the roster and uncrosses');

  /* --- 5. XSS: a bid with markup renders inert; walk-ons show cut ------- */
  gas.handle({ action: 'bid', aname: 'piesplit', uname: 'rando', bid: 'me too!' });
  const gasRes = gas.handle({ action: 'bid', aname: 'piesplit', uname: 'evy',
    bid: '<img src=x onerror=alert(1)>' });
  ok(gasRes.revealed === false, 'roster complete -> still sealed');
  ok(gas.handle({ action: 'reveal', aname: 'piesplit' }).revealed,
     'revealed by the button');
  await sleep(5100); // poll
  const html2 = doc2.getElementById('status').innerHTML;
  ok(!html2.includes('<img'), 'bid markup not injected as HTML');
  ok(doc2.getElementById('status').textContent.includes('<img src=x'),
     'bid markup shown as text');
  ok(![...tiles(doc2)].find((t) => t.textContent.includes('@rando'))
     .classList.contains('cut'),
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
