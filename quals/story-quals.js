// Story quals: complete user journeys in REAL headless Chrome, served by the
// real serve.py, backed by the real Code.gs logic (network calls to the API
// are intercepted and answered by fake-gas in-process). jsdom does no layout
// and no navigation, so this suite is what catches "human clicks around and
// it's broken" bugs: dead-end 404s, clipped tooltips, horizontal overflow.
//
// Screenshots land in quals/screenshots/ (gitignored) for eyeballing.
//
// Run: node quals/story-quals.js   (needs Chrome or Chromium installed)
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const makeGas = require('./fake-gas');

const REPO = path.join(__dirname, '..');
const PORT = 8379;
const BASE = 'http://localhost:' + PORT;
const SHOTS = path.join(__dirname, 'screenshots');

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => fs.existsSync(p));

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2 };
const DESKTOP = { width: 1200, height: 800 };

let passed = 0;
function ok(cond, label) {
  if (!cond) { console.error('FAIL: ' + label); process.exit(1); }
  passed++;
}

const gas = makeGas();

// Answer any request to the deployed API URL with the local Code.gs logic
async function bridge(page) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (!req.url().startsWith('https://script.google.com/')) return req.continue();
    const q = req.method() === 'POST'
      ? JSON.parse(req.postData())
      : Object.fromEntries(new URL(req.url()).searchParams);
    req.respond({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(gas.handle(q)),
    });
  });
}

async function makePage(browser, viewport) {
  const context = await browser.createBrowserContext();  // fresh localStorage
  const page = await context.newPage();
  await page.setViewport(viewport);
  await bridge(page);
  return page;
}

const text = (page, sel) =>
  page.$eval(sel, (e) => e.textContent).catch(() => null);

async function shoot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });
}

// The tooltip is a ::after pseudo-element; compute its box from used styles
async function tipBox(page, i) {
  return page.evaluate((idx) => {
    const tip = document.querySelectorAll('.tip')[idx];
    tip.focus();
    const r = tip.getBoundingClientRect();
    const cs = getComputedStyle(tip, '::after');
    return {
      top: r.top + parseFloat(cs.top),
      left: r.left + parseFloat(cs.left),
      w: parseFloat(cs.width), h: parseFloat(cs.height),
      vw: window.innerWidth, vh: window.innerHeight,
    };
  }, i);
}

(async () => {
  ok(CHROME, 'found a Chrome/Chromium binary');
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = spawn('python3', [path.join(REPO, 'serve.py'), String(PORT)],
                       { stdio: 'ignore' });
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  try {
    /* ================= Story 1: Alice starts an auction ================
       On her phone, Alice hits the bare domain, gets a fresh auction,
       reloads (no dead end!), enters her name and bid, reloads again,
       and everything is still there. */
    const alice = await makePage(browser, PHONE);
    await alice.goto(BASE + '/', { waitUntil: 'networkidle0' });
    await alice.waitForSelector('#status .tile');
    const slug = await alice.evaluate(() => location.pathname.slice(1));
    ok(/^[a-z0-9]+$/.test(slug), 'fresh visit lands on a slug: /' + slug);
    ok((await alice.$$('#status .tile')).length === 2, 'two waiting tiles');

    await alice.reload({ waitUntil: 'networkidle0' });
    await alice.waitForSelector('#status .tile');
    ok(await alice.evaluate(() => location.pathname.slice(1)) === slug,
       'reload before bidding: same auction, no 404 dead end');

    await alice.type('#uname', 'alice');
    await alice.type('#bid', 'three tacos');
    await alice.click('#place');
    await alice.waitForSelector('#status .tile.has-bid');
    ok((await text(alice, '#status')).includes('three tacos'),
       'alice sees her own bid');
    ok(await alice.$eval('#bid', (e) => e.value) === '', 'bid input cleared');
    ok(await alice.$eval('#bid', (e) => e.placeholder) === 'three tacos',
       'her bid became the placeholder');

    await alice.reload({ waitUntil: 'networkidle0' });
    await alice.waitForSelector('#status .tile.has-bid');
    ok(await alice.$eval('#uname', (e) => e.value) === 'alice',
       'name survives reload');
    ok((await text(alice, '#status')).includes('three tacos'),
       'own bid still visible after reload');

    // phone ergonomics: tooltips fit on screen, nothing scrolls sideways
    const tips = await alice.$$('.tip');
    ok(tips.length >= 2, 'tooltips present');
    for (let i = 0; i < tips.length; i++) {
      const b = await tipBox(alice, i);
      ok(b.top >= 0 && b.left >= 0 && b.left + b.w <= b.vw && b.top + b.h <= b.vh,
         'tooltip ' + i + ' fits the phone viewport: ' + JSON.stringify(b));
    }
    await alice.keyboard.press('Tab');  // blur the last tooltip
    const overflow = await alice.evaluate(() =>
      document.scrollingElement.scrollWidth - window.innerWidth);
    ok(overflow <= 0, 'no horizontal overflow on phone (' + overflow + 'px)');
    await shoot(alice, 'story1-alice-phone');

    /* ================= Story 2: Bob joins via the shared link ==========
       Bob deep-links straight to /<slug> on desktop in his own browser.
       He sees who bid but not what. His bid triggers the reveal. */
    const bob = await makePage(browser, DESKTOP);
    await bob.goto(BASE + '/' + slug, { waitUntil: 'networkidle0' });
    await bob.waitForSelector('#status .tile.has-bid');
    const bobSees = await text(bob, '#status');
    ok(!bobSees.includes('three tacos') && bobSees.includes('•'),
       "bob can't see alice's bid, only that it exists");

    await bob.type('#uname', 'bob');
    await bob.type('#bid', 'my entire kingdom');
    await bob.click('#place');
    await bob.waitForFunction(() =>
      document.querySelectorAll('#status .tile.has-bid').length === 2);
    const revealed = await text(bob, '#status');
    ok(revealed.includes('three tacos') && revealed.includes('my entire kingdom'),
       'second bid reveals everything');
    ok(!(await bob.$eval('#place', (e) => e.disabled)),
       'bidding stays open after reveal (permissive)');
    await shoot(bob, 'story2-bob-desktop');

    // alice reloads and sees the results too
    await alice.reload({ waitUntil: 'networkidle0' });
    await alice.waitForSelector('#status .tile.has-bid');
    ok((await text(alice, '#status')).includes('my entire kingdom'),
       'alice sees the reveal');

    /* ================= Story 3: roster auction, ended early ============
       Alice starts a roster auction for dee+evy by editing the auction
       field. Bob (as dee) bids. Evy never shows, so alice removes her from
       the roster, force-revealing. */
    await alice.evaluate(() => { document.getElementById('aname').value = ''; });
    await alice.type('#aname', 'chores');
    await alice.waitForFunction(() => location.pathname === '/chores');
    ok(true, 'editing the auction field navigates: /chores');
    await alice.type('#roster-input', 'dee\n');
    await alice.type('#roster-input', 'evy\n');
    await alice.waitForFunction(() =>
      document.querySelectorAll('#status .tile').length === 2
      && document.getElementById('status').textContent.includes('@evy'));
    ok(true, 'roster tiles appear for @dee and @evy');

    await bob.goto(BASE + '/chores', { waitUntil: 'networkidle0' });
    await bob.waitForSelector('#status .tile');
    await bob.evaluate(() => { document.getElementById('uname').value = ''; });
    await bob.type('#uname', 'dee');
    await bob.type('#bid', 'i bid 2 dishes');
    await bob.click('#place');
    await bob.waitForSelector('#status .tile.has-bid');

    await alice.reload({ waitUntil: 'networkidle0' });
    await alice.waitForFunction(() =>
      document.querySelectorAll('#status .tile.has-bid').length === 1);
    ok((await text(alice, '#status')).includes('waiting on'),
       'alice sees the auction waiting on @evy');

    // end early: drop the straggler from the roster
    for (const chip of await alice.$$('#chips .chip')) {
      const label = await chip.evaluate((e) => e.textContent);
      if (label.includes('@evy')) await (await chip.$('.x')).click();
    }
    await alice.waitForFunction(() =>
      document.getElementById('status').textContent.includes('Results'));
    ok((await text(alice, '#status')).includes('i bid 2 dishes'),
       'removing the straggler force-reveals (end-early)');
    await shoot(alice, 'story3-roster-reveal');

    console.log('story-quals: all ' + passed + ' assertions passed');
  } finally {
    await browser.close();
    server.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });
