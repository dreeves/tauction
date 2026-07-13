// Quals for the frontend: the real index.html + app.js running in jsdom,
// with fetch bridged to the real Code.gs logic on an in-memory fake
// spreadsheet. Covers bid/reveal flows, tiles (gray/green/shimmer), own-bid
// visibility, URL handling, and the 404.html reload journey.
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

function mockFetch(url, opts) {
  url = String(url);
  if (!url.startsWith(API_URL)) return Promise.reject(new Error('unexpected URL ' + url));
  let req;
  if (opts && opts.method === 'POST') req = JSON.parse(opts.body);
  else req = Object.fromEntries(new URL(url).searchParams);
  apiCalls.push(req);
  const res = gas.handle(req);
  return Promise.resolve({ json: () => Promise.resolve(res) });
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
  /* --- 1. fresh visit to root: gets a slug from the server, URL updates */
  let dom = await makePage('/?api=' + API_URL);
  let doc = dom.window.document;
  const slug1 = dom.window.location.pathname.slice(1);
  ok(/^[a-z0-9]+$/.test(slug1), 'root redirected to a slug: ' + slug1);
  ok(doc.getElementById('aname').value === slug1, 'auction field shows slug');
  ok(apiCalls.some((c) => c.action === 'fresh'), 'asked server for fresh slug');
  ok(dom.window.location.search.includes('api='), '?api= survives redirect');
  ok(doc.querySelectorAll('.tip[data-tip][tabindex="0"]').length >= 2,
     'focusable (mobile-friendly) tooltips present');

  /* --- 2. alice bids on /tau; own bid stays visible to her ------------- */
  dom = await makePage('/tau?api=' + API_URL);
  doc = dom.window.document;
  ok(doc.getElementById('status').textContent.includes(
     'Got bids from 0 people, waiting on 2.'), 'virgin status message');
  ok(tiles(doc).length === 2, 'n=2 -> two tiles');
  ok(tiles(doc, '.has-bid').length === 0, 'both tiles gray');
  ok(tiles(doc)[0].textContent.includes('bidder 1')
     && tiles(doc)[1].textContent.includes('bidder 2'),
     'anonymous slots are numbered');
  ok(tiles(doc)[0].textContent.includes('waiting'), 'gray tile shows no-bid label');

  type(dom, 'uname', 'Alice!');
  ok(doc.getElementById('uname').value === 'alice', 'name sanitized while typing');
  ok(tiles(doc)[0].textContent.includes('@alice'),
     'first open slot becomes you once named');

  type(dom, 'bid', 'three tacos');
  submitBid(dom);
  await sleep(50);
  let statusText = doc.getElementById('status').textContent;
  ok(statusText.includes('Got bids from 1 person, waiting on 1.'),
     'splur singular after first bid: ' + statusText);
  ok(statusText.includes('@alice'), 'tile shows @alice');
  ok(statusText.includes('three tacos'), 'own bid visible in own tile');
  ok(tiles(doc, '.has-bid').length === 1 && tiles(doc).length === 2,
     'one green, one gray after first bid');
  ok(doc.getElementById('bid').value === '', 'bid input cleared after placing');
  ok(doc.getElementById('bid').placeholder === 'three tacos',
     'own bid becomes the placeholder');
  ok(JSON.parse(dom.window.localStorage.getItem('tauction-mybid:tau')).bid
     === 'three tacos', 'own bid persisted');
  ok(dom.window.localStorage.getItem('tauction-uname') === 'alice',
     'name persisted');

  /* --- 3. bob's window: alice's bid is sealed there; reveal at n=2 ----- */
  const dom2 = await makePage('/tau?api=' + API_URL);
  const doc2 = dom2.window.document;
  await sleep(20);
  const sealed = doc2.getElementById('status').textContent;
  ok(sealed.includes('waiting on 1'), 'second window sees alice bid');
  ok(!sealed.includes('three tacos'), "others' bids sealed in other windows");
  ok(sealed.includes('•'), 'sealed bid rendered as a mask');
  type(dom2, 'uname', 'bob');
  type(dom2, 'bid', '$40 and my dignity');
  submitBid(dom2);
  await sleep(50);
  const revealed2 = doc2.getElementById('status').textContent;
  ok(revealed2.includes('Results'), 'revealed after 2nd bid');
  ok(revealed2.includes('three tacos') && revealed2.includes('$40 and my dignity'),
     'both bids shown');
  ok(tiles(doc2, '.has-bid').length === 2, 'all tiles green after reveal');
  ok(!doc2.getElementById('place').disabled,
     'bidding stays open after reveal (permissive)');
  ok(!doc2.getElementById('n').disabled,
     'settings stay open after reveal (permissive)');

  // first window catches up via polling (jsdom timers run; wait one poll)
  await sleep(5100);
  ok(doc.getElementById('status').textContent.includes('$40 and my dignity'),
     "first window sees bob's bid via polling after reveal");

  /* --- 3b. shimmer: a re-bid glows anew in every window ---------------- */
  const domA = await makePage('/wobble?api=' + API_URL);
  type(domA, 'uname', 'ann');
  type(domA, 'bid', 'first');
  submitBid(domA);
  await sleep(50);
  ok(tiles(domA.window.document, '.has-bid').length === 1, 'ann tile green');
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
  await sleep(5100);  // domB polls
  const shim = tiles(domB.window.document, '.updated');
  ok(shim.length === 1 && shim[0].textContent.includes('@ann'),
     "ann's tile shimmers in another window after her re-bid");
  await sleep(5100);  // next poll: no further change
  ok(!tiles(domB.window.document, '.updated').length, 'shimmer is one-shot');

  /* --- 4. roster mode on a new auction via the auction field ----------- */
  apiCalls = [];
  type(dom2, 'aname', 'Pie-Split');
  ok(doc2.getElementById('aname').value === 'piesplit', 'slug sanitized');
  await sleep(600); // debounce
  ok(dom2.window.location.pathname === '/piesplit', 'URL follows slug edit');
  ok(!doc2.getElementById('place').disabled, 'controls unlock on new auction');
  ok(doc2.getElementById('bid').placeholder === '',
     'placeholder resets to the stock hint on a new auction');

  type(dom2, 'roster-input', 'dee');
  doc2.getElementById('roster-input').dispatchEvent(
    new dom2.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  type(dom2, 'roster-input', 'evy');
  doc2.getElementById('roster-input').dispatchEvent(
    new dom2.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  ok(doc2.getElementById('mode-roster').checked, 'adding chip selects roster mode');
  ok(doc2.getElementById('chips').textContent.includes('@dee')
     && doc2.getElementById('chips').textContent.includes('@evy'), 'chips render');
  await sleep(800); // settings debounce
  ok(apiCalls.some((c) => c.action === 'settings' && c.mode === 'roster'
     && c.roster.join(',') === 'dee,evy'), 'settings pushed to server');
  ok(doc2.getElementById('status').textContent.includes('waiting on'),
     'roster status message renders');
  ok(tiles(doc2).length === 2
     && doc2.getElementById('status').textContent.includes('@evy'),
     'roster mode: named gray tiles, no self tile for spectators');

  type(dom2, 'uname', 'dee');
  type(dom2, 'bid', 'i bid 2 dishes');
  submitBid(dom2);
  await sleep(50);
  const rosterStatus = doc2.getElementById('status').textContent;
  ok(rosterStatus.includes('Got bids from') && rosterStatus.includes('@dee')
     && rosterStatus.includes('waiting on') && rosterStatus.includes('@evy'),
     'roster waiting message: ' + rosterStatus.trim());
  ok(rosterStatus.includes('i bid 2 dishes'), 'own roster bid visible');
  ok([...tiles(doc2, '.has-bid')].some((t) => t.textContent.includes('@dee'))
     && [...tiles(doc2, ':not(.has-bid)')].some((t) => t.textContent.includes('@evy')),
     'dee green, evy still gray');

  /* --- 5. XSS: a bid with markup renders inert ------------------------- */
  const gasRes = gas.handle({ action: 'bid', aname: 'piesplit', uname: 'evy',
    bid: '<img src=x onerror=alert(1)>' });
  ok(gasRes.revealed, 'roster complete -> revealed');
  await sleep(5100); // poll
  const html2 = doc2.getElementById('status').innerHTML;
  ok(!html2.includes('<img'), 'bid markup not injected as HTML');
  ok(doc2.getElementById('status').textContent.includes('<img src=x'),
     'bid markup shown as text');

  /* --- 6. no 404 dead-ends: 404.html IS the app -------------------------
     Replicata: navigate straight to /tau, or reload there. GitHub Pages
     answers unknown paths with 404.html. Expectata: that IS the app, booted
     at /tau — no bounce, no flash, nothing to dead-end. */
  ok(fs.readFileSync(path.join(REPO, '404.html'), 'utf8') === INDEX_HTML,
     '404.html is an exact copy of index.html (fix: cp index.html 404.html)');
  const domBack = await makePage('/tau?api=' + API_URL);
  ok(domBack.window.document.getElementById('aname').value === 'tau',
     'direct navigation lands on the auction');
  ok(domBack.window.document.getElementById('status').textContent.includes('Results'),
     'auction state loads on direct navigation');

  // a path that isn't a slug just becomes a fresh auction
  const domWeird = await makePage('/no/such/path?api=' + API_URL);
  const weirdPath = domWeird.window.location.pathname;
  ok(/^\/[a-z0-9]+$/.test(weirdPath) && weirdPath !== '/no',
     'non-slug path becomes a fresh aname: ' + weirdPath);
  ok(domWeird.window.location.search.includes('api='),
     '?api= preserved on the fresh-auction redirect');

  console.log('frontend-quals: all ' + passed + ' assertions passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
