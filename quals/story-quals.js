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
const jsQR = require('jsqr');
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

const BASE_URL_FOR_QUAL = BASE;  // the QR/share URL is origin-based

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
  // puppeteer's overridePermissions can't grant clipboard access in
  // headless; CDP can — and it must target this page's own context
  const cdp = await browser.target().createCDPSession();
  await cdp.send('Browser.grantPermissions', {
    origin: BASE,
    browserContextId: context.id,
    permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
  });
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

async function addChip(page, uname) {
  await page.type('#roster-input', uname);
  await page.keyboard.press('Enter');
}

// The tooltip is a ::after pseudo-element; compute its box from used styles
async function tipBox(page, i) {
  return page.evaluate((idx) => {
    const tip = document.querySelectorAll('.tip')[idx];
    tip.focus();
    const r = tip.getBoundingClientRect();
    const cs = getComputedStyle(tip, '::before');
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
       reloads (no dead end!), names the participants, bids, reloads
       again, and everything is still there. */
    const alice = await makePage(browser, PHONE);
    await alice.goto(BASE + '/', { waitUntil: 'networkidle0' });
    await alice.waitForSelector('#tiles');
    const slug = await alice.evaluate(() => location.pathname.slice(1));
    ok(/^[a-z0-9]+$/.test(slug), 'fresh visit lands on a slug: /' + slug);
    ok((await alice.$$('#status .tile')).length === 0,
       'no roster yet: the BIDS box is simply empty');

    await alice.reload({ waitUntil: 'networkidle0' });
    await alice.waitForSelector('#tiles');
    ok(await alice.evaluate(() => location.pathname.slice(1)) === slug,
       'reload before doing anything: same auction, no 404 dead end');

    await addChip(alice, 'alice');
    await addChip(alice, 'bob');
    await alice.waitForFunction(() =>
      document.querySelectorAll('#status .tile').length === 2);
    ok(true, 'named rows appear as the roster is typed');
    ok(await alice.evaluate(() =>
      getComputedStyle(document.querySelector('#status .tile:not(.has-bid)'))
        .animationName === 'breathe'), 'empty slots breathe');
    ok(await alice.evaluate(() =>
      getComputedStyle(document.querySelector('#status .tile:not(.has-bid)'),
        '::before').content.includes('○')), 'empty slot marked with a hollow dot');
    ok(await alice.evaluate(() =>
      parseFloat(getComputedStyle(document.querySelector('#status .tada'))
        .opacity) < 1), 'tada waits in grayscale before the reveal');

    await alice.type('#uname', 'alice');
    await alice.type('#bid', 'three tacos');
    await alice.click('#place');
    await alice.waitForSelector('#status .tile.has-bid');
    ok((await text(alice, '#status')).includes('three tacos'),
       'alice sees her own bid');
    ok(await alice.evaluate(() =>
      getComputedStyle(document.querySelector('#status .tile.has-bid'),
        '::before').content.includes('✅')), 'received bid marked with ✅');
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

    /* ---- share dialog: copy button + a QR that actually scans ---------- */
    await alice.click('#share');
    await alice.waitForFunction(() =>
      document.getElementById('share-dlg').open);
    ok(true, 'share button opens the share dialog');
    const shareUrl = await alice.$eval('#share-url', (e) => e.textContent);
    ok(shareUrl === BASE_URL_FOR_QUAL + '/' + slug,
       'share dialog shows the canonical auction URL: ' + shareUrl);

    // decode the rendered QR straight from the canvas: it must scan to the URL
    const pixels = await alice.evaluate(() => {
      const c = document.getElementById('qr');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height);
      return { data: Array.from(d.data), width: d.width, height: d.height };
    });
    const decoded = jsQR(new Uint8ClampedArray(pixels.data),
                         pixels.width, pixels.height);
    ok(decoded && decoded.data === shareUrl,
       'the QR code scans back to the auction URL: '
         + (decoded ? decoded.data : 'UNDECODABLE'));

    await alice.bringToFront();  // clipboard writes need a focused document
    await alice.click('#copy');
    await alice.waitForFunction(() =>
      document.getElementById('copy').classList.contains('copied'));
    const clip = await alice.evaluate(() => navigator.clipboard.readText());
    ok(clip === shareUrl, 'copy button puts the URL on the clipboard: ' + clip);
    ok(await alice.evaluate(() => {
      const b = document.getElementById('copy');
      return getComputedStyle(b.querySelector('.copy-label')).display === 'none'
        && getComputedStyle(b, '::after').content.includes('Copiatum');
    }), 'the confirmation replaces the button label rather than appending');
    await shoot(alice, 'share-dialog');

    await alice.keyboard.press('Escape');
    await alice.waitForFunction(() =>
      !document.getElementById('share-dlg').open);
    ok(true, 'escape closes the share dialog');

    /* ---- help dialog: dreev's sealedbids text, verbatim ----------------- */
    await alice.click('#help');
    await alice.waitForFunction(() => document.getElementById('help-dlg').open);
    const helpText = await text(alice, '#help-dlg');
    ok(helpText.includes(
         'When the last person has responded, all the responses are revealed.'),
       'help dialog shows the sealedbids text');
    await shoot(alice, 'help-dialog');
    await alice.click('#help-dlg .dlg-x');
    await alice.waitForFunction(() => !document.getElementById('help-dlg').open);
    ok(true, 'the × closes the help dialog');

    /* ================= Story 2: Bob joins via the shared link ==========
       Bob deep-links straight to /<slug> on desktop in his own browser.
       He sees who bid but not what. His bid triggers the reveal. */
    const bob = await makePage(browser, DESKTOP);
    await bob.goto(BASE + '/' + slug, { waitUntil: 'networkidle0' });
    await bob.waitForSelector('#status .tile.has-bid');
    const bobSees = await text(bob, '#status');
    ok(!bobSees.includes('three tacos') && await bob.$('#status .tile-bid .masked'),
       "bob can't see alice's bid, only a masked decoy");
    ok(await bob.evaluate(() => getComputedStyle(
         document.querySelector('#status .tile-bid .masked')).filter)
       .then((f) => f.includes('blur')), 'the decoy is actually blurred');
    ok(await bob.evaluate(() => getComputedStyle(
         document.querySelector('#status .seal'), '::after').content)
       .then((c) => c.includes('\u{1F512}')), 'closed padlock while sealed');
    await shoot(bob, 'story2-bob-sealed');

    await bob.type('#uname', 'bob');
    await bob.type('#bid', 'my entire kingdom');
    await bob.click('#place');
    await bob.waitForFunction(() =>
      document.querySelectorAll('#status .tile.has-bid').length === 2);
    ok(!(await text(bob, '#status')).includes('three tacos'),
       'complete but sealed: nothing reveals without a press');
    await bob.waitForFunction(() => !document.getElementById('seal').disabled);
    ok(await bob.evaluate(() =>
      getComputedStyle(document.getElementById('seal')).animationName
        === 'lockpulse'), 'the pressable padlock pulses for attention');
    await bob.click('#seal');
    await bob.waitForFunction(() =>
      document.getElementById('status').textContent.includes('three tacos'));
    const revealed = await text(bob, '#status');
    ok(revealed.includes('three tacos') && revealed.includes('my entire kingdom'),
       'pressing the padlock reveals everything');
    await bob.waitForFunction(() =>  // 0.4s fade-in: wait, don't sample
      parseFloat(getComputedStyle(document.querySelector('#status .tada'))
        .opacity) === 1);
    ok(true, 'tada lights up at the reveal');
    ok(!(await bob.$eval('#place', (e) => e.disabled)),
       'bidding stays open after reveal (permissive)');
    ok(await bob.evaluate(() => getComputedStyle(
         document.querySelector('#status .seal'), '::after').content)
       .then((c) => c.includes('\u{1F513}')), 'padlock opens at the reveal');
    await bob.waitForFunction(() =>  // 0.4s fade: wait, don't sample
      parseFloat(getComputedStyle(document.getElementById('settings'))
        .opacity) < 1);
    ok(true, 'roster box grays out once revealed');
    await shoot(bob, 'story2-bob-desktop');

    // alice reloads and sees the results too
    await alice.reload({ waitUntil: 'networkidle0' });
    await alice.waitForSelector('#status .tile.has-bid');
    ok((await text(alice, '#status')).includes('my entire kingdom'),
       'alice sees the reveal');

    /* ================= Story 3: roster auction, ended early ============
       Alice starts a fresh auction for dee+evy by editing the auction
       field. Bob (as dee) bids. Evy never shows, so alice removes her
       from the roster, force-revealing. */
    await alice.evaluate(() => { document.getElementById('aname').value = ''; });
    await alice.type('#aname', 'chores');
    await alice.waitForFunction(() => location.pathname === '/chores');
    ok(true, 'editing the auction field navigates: /chores');
    await addChip(alice, 'dee');
    await addChip(alice, 'evy');
    await alice.waitForFunction(() =>
      document.querySelectorAll('#status .tile').length === 2
      && document.getElementById('status').textContent.includes('@evy'));
    ok(true, 'empty rows appear for @dee and @evy');

    // alice bids too: bidding claims her a roster seat, visibly
    await alice.type('#bid', 'sweep the porch');
    await alice.click('#place');
    await alice.waitForFunction(() =>
      document.getElementById('chips').textContent.includes('@alice'));
    ok(true, 'bidding added @alice to the roster chips');

    await bob.goto(BASE + '/chores', { waitUntil: 'networkidle0' });
    await bob.waitForSelector('#status .tile');
    await bob.evaluate(() => { document.getElementById('uname').value = ''; });
    await bob.type('#uname', 'dee');
    await bob.type('#bid', 'i bid 2 dishes');
    await bob.click('#place');
    await bob.waitForSelector('#status .tile.has-bid');

    await alice.reload({ waitUntil: 'networkidle0' });
    await alice.waitForFunction(() =>
      document.querySelectorAll('#status .tile.has-bid').length === 2);
    ok(await alice.evaluate(() => {
      const evy = [...document.querySelectorAll('#status .tile')]
        .find((t) => t.textContent.includes('@evy'));
      return evy && !evy.classList.contains('has-bid');
    }), "alice sees @evy's row still hollow");

    // end early: drop the straggler from the roster
    for (const chip of await alice.$$('#chips .chip')) {
      const label = await chip.evaluate((e) => e.textContent);
      if (label.includes('@evy')) await (await chip.$('.x')).click();
    }
    await alice.waitForFunction(() => !document.getElementById('seal').disabled);
    await alice.click('#seal');
    await alice.waitForFunction(() =>
      document.getElementById('status').textContent.includes('i bid 2 dishes'));
    ok(true, 'ex the straggler, press the padlock: end-early');

    // exing someone who bid crosses out their whole line, not just the name
    for (const chip of await alice.$$('#chips .chip')) {
      const label = await chip.evaluate((e) => e.textContent);
      if (label.includes('@dee')) await (await chip.$('.x')).click();
    }
    await alice.waitForFunction(() => {
      const dee = [...document.querySelectorAll('#status .tile')]
        .find((t) => t.textContent.includes('@dee'));
      return dee && dee.classList.contains('cut');
    });
    ok(await alice.evaluate(() => {
      const dee = [...document.querySelectorAll('#status .tile')]
        .find((t) => t.textContent.includes('@dee'));
      const bar = getComputedStyle(dee, '::after');
      return bar.position === 'absolute' && parseFloat(bar.height) >= 2
        && getComputedStyle(dee.querySelector('.tile-name'))
             .textDecorationLine === 'none';
    }), 'one thick bar crosses the whole entry, no per-text strikeout');
    await shoot(alice, 'story3-roster-reveal');

    console.log('story-quals: all ' + passed + ' assertions passed');
  } finally {
    await browser.close();
    server.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });
