// Story quals: complete user journeys in REAL headless Chrome, served by the
// real serve.py, backed by the real Code.gs logic (network calls to the API
// are intercepted and answered by fake-gas in-process). jsdom does no layout
// and no navigation, so this suite is what catches "human clicks around and
// it's broken" bugs: dead-end 404s, clipped tooltips, horizontal overflow,
// and enter-to-submit in the row editor (real implicit form submission).
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

// Add a person via the ledger's + row
async function addName(page, uname) {
  await page.type('#roster-input', uname);
  await page.keyboard.press('Enter');
}

// Pending roster/claim ops rebuild the rows when they land, which can
// eat a click mid-gesture (mousedown and mouseup need the same node) —
// humans interact after the sub-second confirm, so the helpers wait for
// the box to unstale first
function settled(page) {
  return page.waitForFunction(() =>
    !document.getElementById('status').classList.contains('stale'));
}

// Claim a row as yourself via its star, then wait for the editor
async function claimRow(page, uname) {
  await settled(page);
  await page.click('.tile[data-uname="' + uname + '"] .tu');
  await page.waitForSelector('.tile.mine .rebid input');
}

// Type a bid into your row and submit it the way a human does: Enter.
// (Implicit form submission — a single-input form with no button — is
// exactly what this exercises; jsdom can't.)
async function bid(page, bidText) {
  await settled(page);
  await page.type('.tile.mine .rebid input', bidText);
  await page.keyboard.press('Enter');
}

// The tooltip is a ::before pseudo-element; compute its box from used
// styles. Right-anchored tooltips hang left from their element's right
// edge, so anchor the math accordingly.
async function tipBox(page, i) {
  return page.evaluate((idx) => {
    const tip = document.querySelectorAll('[data-tip]')[idx];
    tip.focus();
    const r = tip.getBoundingClientRect();
    const cs = getComputedStyle(tip, '::before');
    const left = cs.left === 'auto'
      ? r.right - parseFloat(cs.right) - parseFloat(cs.width)
      : r.left + parseFloat(cs.left);
    return {
      tip: tip.className,
      top: r.top + parseFloat(cs.top),
      left: left,
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
       reloads (no dead end!), names the participants on the ledger,
       claims her row, bids in place, reloads again, and everything is
       still there. */
    const alice = await makePage(browser, PHONE);
    await alice.goto(BASE + '/', { waitUntil: 'networkidle0' });
    await alice.waitForSelector('#tiles');
    const slug = await alice.evaluate(() => location.pathname.slice(1));
    ok(/^[a-z0-9]+$/.test(slug), 'fresh visit lands on a slug: /' + slug);
    ok((await alice.$$('#status .tile:not(.addrow)')).length === 0,
       'no roster yet: the ledger is just the + row');

    await alice.reload({ waitUntil: 'networkidle0' });
    await alice.waitForSelector('#tiles');
    ok(await alice.evaluate(() => location.pathname.slice(1)) === slug,
       'reload before doing anything: same auction, no 404 dead end');

    await addName(alice, 'alice');
    await addName(alice, 'bob');
    await alice.waitForFunction(() =>
      document.querySelectorAll('#tiles .tile').length === 2);
    ok(true, 'named rows appear as the roster is typed');
    ok(await alice.evaluate(() =>
      getComputedStyle(document.querySelector(
        '#tiles .tile:not(.has-bid) .tile-name'))
        .animationName === 'breathe'), 'awaiting person cells breathe');
    ok(await alice.evaluate(() => {
      const slot = document.querySelector(
        '#tiles .tile:not(.has-bid) .bid-card.slot');
      return slot && getComputedStyle(slot).borderTopStyle === 'dashed'
        && getComputedStyle(slot).animationName === 'breathe'
        && slot.getBoundingClientRect().height > 10;
    }), 'an empty dashed card breathes where the awaited bid will go');
    ok(await alice.evaluate(() => {
      const slot = document.querySelector('#tiles .bid-card.slot');
      const name = document.querySelector('#tiles .tile-name');
      return getComputedStyle(slot).padding === getComputedStyle(name).padding
        && getComputedStyle(slot).borderRadius
           === getComputedStyle(name).borderRadius;
    }), 'bid boxes wear the same box recipe as the participant boxes');
    ok(await alice.evaluate(() =>
      parseFloat(getComputedStyle(document.querySelector(
        '.check .tile-subs')).marginLeft) > 0),
       'the superscript count keeps a little air from the checkmark');
    ok(await alice.evaluate(() =>
      getComputedStyle(document.querySelector('#status .addrow .at-wrap'))
        .animationName === 'none'), 'the + row does not breathe (a fixture)');
    ok(await alice.evaluate(() =>
      getComputedStyle(document.querySelector(
        '#tiles .tile:not(.has-bid) .tile-name'),
        '::before').content === 'none'
      && document.querySelector('#tiles .tile-name')
           .firstElementChild.classList.contains('tu')),
       'each row leads with its star; the hollow dot is retired');
    ok(await alice.evaluate(() =>
      getComputedStyle(document.querySelector('#status .addrow .at-wrap'),
        '::before').content.includes('+')), 'the + row marked with a +');
    ok(await alice.evaluate(() => {
      const rows = document.querySelectorAll('#tiles .tile');
      const last = rows[rows.length - 1].getBoundingClientRect();
      const add = document.querySelector('.addrow').getBoundingClientRect();
      return add.top - last.bottom >= 4;
    }), 'the + row keeps the same breathing room as the rows above it');
    ok(await alice.evaluate(() =>
      parseFloat(getComputedStyle(document.querySelector('#status .seal'))
        .opacity) < 1), 'the padlock waits grayed while the roster fills');
    ok(await alice.evaluate(() =>
      document.querySelectorAll('#tiles .tu').length === 2
      && !document.querySelector('#tiles .tu.selected')),
       'nobody claimed: two stars, none lit');

    ok(await alice.evaluate(() =>
      document.querySelector('#status .th-person').textContent
        .includes('PARTICIPANTS')
      && !!document.querySelector('#status .th-bid #seal')
      && !!document.querySelector('#status .th-person .tip')),
       'column headings lead the section; padlock with BIDS, tip with'
       + ' PARTICIPANTS');

    // each ledger line splits into two visible pieces: a bordered person
    // cell and a bordered bid cell, with the line itself borderless
    ok(await alice.evaluate(() => {
      const t = document.querySelector('#tiles .tile');
      const name = getComputedStyle(t.querySelector('.tile-name'));
      const bid = getComputedStyle(t.querySelector('.tile-bid'));
      return getComputedStyle(t).borderBottomWidth === '0px'
        && name.borderTopWidth === '1px' && bid.borderTopWidth === '0px';
    }), 'person cell boxed; the bid floats free (its card is box enough)');

    /* Replicata: type into the + row, then — without pressing enter —
       click a row's (you?) button. Expectata: the click lands (and the
       typed text stays put in the + row, uncommitted but not lost).
       Resultata pre-fix: the input's blur committed the name, which
       synchronously rebuilt every row, destroying the button between
       mousedown and mouseup — the click silently died. */
    await alice.type('#roster-input', 'carol');
    await alice.click('.tile[data-uname="alice"] .tu');
    await alice.waitForSelector('.tile.mine .rebid input', { timeout: 2000 });
    ok(true, 'clicking (you?) works even with an uncommitted name pending');
    ok(await alice.$eval('#roster-input', (e) => e.value) === 'carol',
       'the pending name stays visible in the + row, not lost, not added');
    await alice.$eval('#roster-input', (e) => { e.value = ''; });

    ok(await alice.evaluate(() =>
      document.activeElement === document.querySelector('.tile.mine .rebid input')),
       'claiming your row drops you straight into the bid editor');
    await bid(alice, 'three tacos');
    await alice.waitForSelector('#tiles .tile.has-bid');
    ok(await alice.$eval('.tile.mine .rebid input', (e) => e.value)
       === 'three tacos', 'her bid lives in her row, editable in place');
    ok(await alice.evaluate(() => {
      const lit = document.querySelector('#tiles .tile.has-bid .check');
      const off = document.querySelector(
        '#tiles .tile:not(.has-bid) .check');
      return getComputedStyle(lit).filter === 'none'
        && getComputedStyle(off).filter.includes('grayscale');
    }), 'checkmark green once a bid is in, gray while the count is 0');
    ok(await alice.evaluate(() =>
      document.querySelector('#tiles .tile.has-bid .check sup.tile-subs')
        .textContent === '1'),
       'the submission count rides the checkmark as a superscript');
    ok(await alice.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--star)';
      document.body.append(probe);
      const gold = getComputedStyle(probe).color;
      probe.remove();
      const star = document.querySelector('.tile.mine .tu');
      return star.classList.contains('selected')
        && getComputedStyle(star).color === gold
        && getComputedStyle(star).textShadow !== 'none';
    }), 'her star glows gold: that is how you know which row is you');
    ok(await alice.evaluate(() => {
      const edges = [...document.querySelectorAll('#tiles .tile')].map((t) =>
        t.querySelector('.bid-card, .rebid input')
          .getBoundingClientRect().right);
      return edges.every((e) => Math.abs(e - edges[0]) < 1);
    }), 'every bid box matches length: one right edge down the column');
    ok(await alice.evaluate(() =>
      getComputedStyle(document.querySelector(
        '#tiles .tile.has-bid .tile-name')).boxShadow === 'none'),
       'green person cells sit flat: no glow haze');

    await alice.reload({ waitUntil: 'networkidle0' });
    await alice.waitForSelector('.tile.mine .rebid input');
    ok(await alice.$eval('.tile.mine .rebid input', (e) => e.value)
       === 'three tacos', 'identity and bid survive reload');

    // phone ergonomics: every tooltip in the app fits on screen, nothing
    // scrolls sideways
    const tips = await alice.$$('[data-tip]');
    ok(tips.length >= 5, 'tooltips present on tips, buttons, and rows');
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
        && getComputedStyle(b, '::after').content.includes('Copied');
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
         'You could use it to get independent estimates of how long '
         + 'something will take to implement.'),
       'help dialog shows the sealedbids text');
    await shoot(alice, 'help-dialog');
    await alice.click('#help-dlg .dlg-x');
    await alice.waitForFunction(() => !document.getElementById('help-dlg').open);
    ok(true, 'the × closes the help dialog');

    /* ================= Story 2: Bob joins via the shared link ==========
       Bob deep-links straight to /<slug> on desktop in his own browser.
       He sees who bid but not what, claims his row, bids, and presses
       the padlock. */
    const bob = await makePage(browser, DESKTOP);
    await bob.goto(BASE + '/' + slug, { waitUntil: 'networkidle0' });
    await bob.waitForSelector('#tiles .tile.has-bid');
    const bobSees = await text(bob, '#status');
    ok(!bobSees.includes('three tacos') && await bob.$('#status .tile-bid .masked'),
       "bob can't see alice's bid, only a masked decoy");
    ok(await bob.evaluate(() => getComputedStyle(
         document.querySelector('#status .tile-bid .masked')).filter)
       .then((f) => f.includes('blur')), 'the decoy is actually blurred');
    ok(await bob.evaluate(() => {
      const dibsed = document.querySelector('.tile[data-uname="alice"] .tu');
      const plain = document.querySelector('.tile[data-uname="bob"] .tu');
      return dibsed.disabled && !plain.disabled
        && parseFloat(getComputedStyle(dibsed).opacity)
           < parseFloat(getComputedStyle(plain).opacity);
    }), "alice's bid dibses her star: disabled, visibly dimmer than a"
       + ' claimable one');
    ok(await bob.evaluate(() => getComputedStyle(
         document.querySelector('#status .seal'), '::after').content)
       .then((c) => c.includes('\u{1F512}')), 'closed padlock while sealed');
    await shoot(bob, 'story2-bob-sealed');

    await claimRow(bob, 'bob');
    await bid(bob, 'my entire kingdom');
    await bob.waitForFunction(() =>
      document.querySelectorAll('#tiles .tile.has-bid').length === 2);
    ok(!(await text(bob, '#status')).includes('three tacos'),
       'complete but sealed: nothing reveals without a press');
    await bob.waitForFunction(() => !document.getElementById('seal').disabled);
    ok(await bob.evaluate(() =>
      getComputedStyle(document.getElementById('seal')).animationName
        === 'lockpulse'), 'the pressable padlock pulses for attention');
    await bob.click('#seal');
    await bob.waitForFunction(() =>
      document.getElementById('status').textContent.includes('three tacos'));
    ok(await bob.$eval('.tile.mine .rebid input', (e) => e.value)
       === 'my entire kingdom',
       "pressing the padlock reveals everything: alice's card + his own row");
    await bob.waitForFunction(() =>  // fade-in: wait, don't sample
      parseFloat(getComputedStyle(document.querySelector('#status .seal'))
        .opacity) === 1);
    ok(true, 'the icon comes to full strength at the reveal');
    ok(!(await bob.$eval('.tile.mine .rebid input', (e) => e.disabled)),
       'bidding stays open after reveal (permissive)');
    ok(await bob.evaluate(() => getComputedStyle(
         document.querySelector('#status .seal'), '::after').content)
       .then((c) => c.includes('\u{1F389}')),
       'the padlock becomes the tada at the reveal: one icon, three states');
    ok(await bob.$eval('#seal', (e) => e.getAttribute('data-tip'))
       !== 'Reveal bids!',
       'the tip stops offering to reveal once revealed');
    await shoot(bob, 'story2-bob-desktop');

    // alice reloads and sees the results too
    await alice.reload({ waitUntil: 'networkidle0' });
    await alice.waitForSelector('#tiles .tile.has-bid');
    ok((await text(alice, '#status')).includes('my entire kingdom'),
       'alice sees the reveal');

    /* ================= Story 3: roster auction, ended early ============
       Alice starts a fresh auction for dee+evy by editing the auction
       field. She's nobody there until she adds her own name — which
       re-latches her automatically. Bob (as dee) bids. Evy never shows,
       so alice ×es her off the ledger, force-revealing. */
    await alice.evaluate(() => { document.getElementById('aname').value = ''; });
    await alice.type('#aname', 'chores');
    await alice.waitForFunction(() => location.pathname === '/chores');
    ok(true, 'editing the auction field navigates: /chores');
    await addName(alice, 'dee');
    await addName(alice, 'evy');
    await alice.waitForFunction(() =>
      document.querySelectorAll('#tiles .tile').length === 2
      && document.getElementById('status').textContent.includes('@evy'));
    ok(true, 'empty rows appear for @dee and @evy');
    ok(await alice.evaluate(() =>
      !document.querySelector('.tile.mine')
      && document.querySelectorAll('#tiles .tu').length === 2),
       'alice is nobody here until her name is on the ledger');

    await addName(alice, 'alice');
    await alice.waitForSelector('.tile.mine .rebid input');
    ok(true, 'adding her remembered name back re-latches automatically');
    await bid(alice, 'sweep the porch');
    await alice.waitForFunction(() =>
      document.querySelector('.tile[data-uname="alice"]')
        .classList.contains('has-bid'));
    ok(true, 'she bids in place on her reclaimed row');

    await bob.goto(BASE + '/chores', { waitUntil: 'networkidle0' });
    await bob.waitForSelector('#tiles .tile');
    await claimRow(bob, 'dee');
    await bid(bob, 'i bid 2 dishes');
    await bob.waitForFunction(() =>
      document.querySelectorAll('#tiles .tile.has-bid').length === 2);

    await alice.reload({ waitUntil: 'networkidle0' });
    await alice.waitForFunction(() =>
      document.querySelectorAll('#tiles .tile.has-bid').length === 2);
    ok(await alice.evaluate(() => {
      const evy = document.querySelector('.tile[data-uname="evy"]');
      return evy && !evy.classList.contains('has-bid');
    }), "alice sees @evy's row still hollow");
    ok(await alice.evaluate(() =>
      document.querySelector('#tiles .tile.has-bid .x').disabled
      && !document.querySelector('.tile[data-uname="evy"] .x').disabled),
       'x live on the hollow row, grayed once a bid is in');

    // the ledger reads as a table: person column and bid column line up
    // across rows, whatever the name lengths and row states
    const cols = await alice.evaluate(() =>
      [...document.querySelectorAll('#tiles .tile')].map((t) => ({
        name: t.querySelector('.tile-name').getBoundingClientRect().x,
        bid: t.querySelector('.tile-bid').getBoundingClientRect().x,
      })));
    ok(cols.every((c) => c.name === cols[0].name),
       'person column aligns across rows: ' + JSON.stringify(cols));
    ok(cols.every((c) => c.bid === cols[0].bid),
       'bid column aligns across rows: ' + JSON.stringify(cols));

    // end early: × the straggler right off the ledger
    await alice.click('.tile[data-uname="evy"] .x');
    await alice.waitForFunction(() => !document.getElementById('seal').disabled);
    await alice.click('#seal');
    await alice.waitForFunction(() =>
      document.getElementById('status').textContent.includes('i bid 2 dishes'));
    ok(true, '× the straggler, press the padlock: end-early');
    await shoot(alice, 'story3-roster-reveal');

    console.log('story-quals: all ' + passed + ' assertions passed');
  } finally {
    await browser.close();
    server.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });
