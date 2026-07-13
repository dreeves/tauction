// Quals for the frontend: the real index.html + app.js running in jsdom,
// with fetch bridged to the real Code.gs logic on an in-memory fake
// spreadsheet. Covers the bid/reveal flows, URL handling, and the
// 404.html-stash / index.html-restore reload journey.
//
// Run: node quals/frontend-quals.js   (needs `npm install` first, for jsdom)
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..');

/* --------------- backend: Code.gs on the fake spreadsheet -------------- */
// (same stubs as gas-quals.js, minimal repeat)

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  setValues(vals) {
    for (let r = 0; r < this.numRows; r++) {
      const rowIdx = this.row - 1 + r;
      while (this.sheet.data.length <= rowIdx) this.sheet.data.push([]);
      const row = this.sheet.data[rowIdx];
      for (let c = 0; c < this.numCols; c++) {
        const colIdx = this.col - 1 + c;
        while (row.length <= colIdx) row.push('');
        row[colIdx] = vals[r][c];
      }
    }
    return this;
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const row = this.sheet.data[this.row - 1 + r] || [];
      const orow = [];
      for (let c = 0; c < this.numCols; c++) {
        orow.push(row[this.col - 1 + c] !== undefined ? row[this.col - 1 + c] : '');
      }
      out.push(orow);
    }
    return out;
  }
  setNumberFormat() { return this; }
  setFontWeight() { return this; }
}
class FakeSheet {
  constructor(name) { this.name = name; this.data = []; }
  getRange(r, c, nr = 1, nc = 1) { return new FakeRange(this, r, c, nr, nc); }
  getDataRange() {
    return new FakeRange(this, 1, 1, Math.max(1, this.data.length),
      Math.max(1, ...this.data.map((r) => r.length)));
  }
  appendRow(a) { this.data.push(a.slice()); }
  getMaxRows() { return 1000; }
  setFrozenRows() {}
}
const ss = { sheets: {},
  getSheetByName(n) { return this.sheets[n] || null; },
  insertSheet(n) { return (this.sheets[n] = new FakeSheet(n)); } };
const gas = {
  SpreadsheetApp: { openById: () => ss },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  ContentService: { createTextOutput: (s) => ({ body: s, setMimeType() { return this; } }),
                    MimeType: { JSON: 'json' } },
  Logger: { log: () => {} },
};
vm.createContext(gas);
vm.runInContext(fs.readFileSync(path.join(REPO, 'apps-script/Code.gs'), 'utf8'), gas);

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
const HTML_404 = fs.readFileSync(path.join(REPO, '404.html'), 'utf8');
// The inline <script> bodies actually shipped in the pages:
const RESTORE_SRC = INDEX_HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
const STASH_SRC = HTML_404.match(/<script>([\s\S]*?)<\/script>/)[1];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makePage(pathAndQuery, stash) {
  const dom = new JSDOM(INDEX_HTML, {
    url: 'https://tauction.dreev.es' + pathAndQuery,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  dom.window.fetch = mockFetch;
  if (stash) dom.window.sessionStorage.setItem('tauction-path', stash);
  dom.window.eval(RESTORE_SRC);  // index.html's inline restore script
  dom.window.eval(APP_JS);
  await sleep(50); // let init()'s awaits settle
  return dom;
}

function type(dom, id, text) {
  const input = dom.window.document.getElementById(id);
  input.value = text;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

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
  ok(doc.getElementById('auction').value === slug1, 'auction field shows slug');
  ok(apiCalls.some((c) => c.action === 'fresh'), 'asked server for fresh slug');
  ok(dom.window.location.search.includes('api='), '?api= survives redirect');

  /* --- 2. alice bids on /tau */
  dom = await makePage('/tau?api=' + API_URL);
  doc = dom.window.document;
  ok(doc.getElementById('status').textContent.includes(
     'Got bids from 0 people, waiting on 2.'), 'virgin status message');

  type(dom, 'name', 'Alice!');
  ok(doc.getElementById('name').value === 'alice', 'name sanitized while typing');
  type(dom, 'bid', 'three tacos');
  doc.getElementById('bid-form').dispatchEvent(
    new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(50);
  let statusText = doc.getElementById('status').textContent;
  ok(statusText.includes('Got bids from 1 person, waiting on 1.'),
     'splur singular after first bid: ' + statusText);
  ok(statusText.includes('@alice'), 'bids-so-far chips show @alice');
  ok(!statusText.includes('three tacos'), 'bid content still sealed');
  ok(dom.window.localStorage.getItem('tauction-name') === 'alice',
     'name persisted');

  /* --- 3. bob bids in a second window: reveal at n=2, both windows see it */
  const dom2 = await makePage('/tau?api=' + API_URL);
  const doc2 = dom2.window.document;
  await sleep(20);
  ok(doc2.getElementById('status').textContent.includes('waiting on 1'),
     'second window sees alice bid');
  type(dom2, 'name', 'bob');
  type(dom2, 'bid', '$40 and my dignity');
  doc2.getElementById('bid-form').dispatchEvent(
    new dom2.window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(50);
  const revealed2 = doc2.getElementById('status').textContent;
  ok(revealed2.includes('Results'), 'revealed after 2nd bid');
  ok(revealed2.includes('three tacos') && revealed2.includes('$40 and my dignity'),
     'both bids shown');
  ok(doc2.getElementById('place').disabled, 'bid button locked after reveal');
  ok(doc2.getElementById('n').disabled, 'settings locked after reveal');

  // first window catches up via polling (jsdom timers run; wait one poll)
  await sleep(5100);
  ok(doc.getElementById('status').textContent.includes('three tacos'),
     'first window sees reveal via polling');

  /* --- 4. roster mode on a new auction via the auction field */
  apiCalls = [];
  type(dom2, 'auction', 'Pie-Split');
  ok(doc2.getElementById('auction').value === 'piesplit', 'slug sanitized');
  await sleep(600); // debounce
  ok(dom2.window.location.pathname === '/piesplit', 'URL follows slug edit');
  ok(!doc2.getElementById('place').disabled, 'controls unlock on new auction');

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

  type(dom2, 'name', 'dee');
  type(dom2, 'bid', 'i bid 2 dishes');
  doc2.getElementById('bid-form').dispatchEvent(
    new dom2.window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(50);
  const rosterStatus = doc2.getElementById('status').textContent;
  ok(rosterStatus.includes('Got bids from') && rosterStatus.includes('@dee')
     && rosterStatus.includes('waiting on') && rosterStatus.includes('@evy'),
     'roster waiting message: ' + rosterStatus.trim());

  /* --- 5. XSS: a bid with markup renders inert */
  const gasRes = gas.handle({ action: 'bid', auction: 'piesplit', name: 'evy',
    bid: '<img src=x onerror=alert(1)>' });
  ok(gasRes.revealed, 'roster complete -> revealed');
  await sleep(5100); // poll
  const html2 = doc2.getElementById('status').innerHTML;
  ok(!html2.includes('<img'), 'bid markup not injected as HTML');
  ok(doc2.getElementById('status').textContent.includes('<img src=x'),
     'bid markup shown as text');

  /* --- 6. reload journey: URL rewrite -> 404.html stash -> restore ------
     Replicata: visit /, app.js rewrites the URL to /<slug>, user reloads.
     The server (GitHub Pages, or serve.py locally) answers with 404.html.
     Expectata: 404.html stashes path+query and bounces to /, where
     index.html restores the URL and the app loads that auction. */
  const dom404 = new JSDOM(HTML_404, {
    url: 'https://tauction.dreev.es/tau?api=' + API_URL,
    runScripts: 'outside-only',
  });
  dom404.window.eval(STASH_SRC);  // jsdom can't navigate; the stash still runs
  const stashed = dom404.window.sessionStorage.getItem('tauction-path');
  ok(stashed === '/tau?api=' + API_URL,
     '404.html stashes path + query: ' + stashed);
  ok(STASH_SRC.includes("location.replace('/')"), '404.html bounces to /');

  // simulate the browser carrying sessionStorage into the next page load
  const domBack = await makePage('/', stashed);
  ok(domBack.window.location.pathname === '/tau', 'restore lands on /tau');
  ok(domBack.window.sessionStorage.getItem('tauction-path') === null,
     'stash is single-use');
  ok(domBack.window.document.getElementById('auction').value === 'tau',
     'app loads the restored auction');
  ok(domBack.window.document.getElementById('status').textContent.includes('Results'),
     'auction state (revealed tau) survives the reload');

  console.log('frontend-quals: all ' + passed + ' assertions passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
