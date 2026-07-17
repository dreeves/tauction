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

// Answer any request to the deployed API URL with the local Code.gs
// logic; write ops can be artificially delayed for in-flight-race quals
let opDelay = 0;
async function bridge(page) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url().includes('ipapi.co')) {  // geo fixture: no network
      return req.respond({ status: 200, contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ city: 'Portland', region_code: 'OR' }) });
    }
    if (!req.url().startsWith('https://script.google.com/')) return req.continue();
    const q = req.method() === 'POST'
      ? JSON.parse(req.postData())
      : Object.fromEntries(new URL(req.url()).searchParams);
    const wait = ['add', 'remove', 'claim', 'release', 'bid', 'reveal']
      .includes(q.action) ? opDelay : 0;
    const body = JSON.stringify(gas.handle(q));
    setTimeout(() => req.respond({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: body,
    }), wait);
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

// No waiting for pending ops here, deliberately: keyed node reuse means
// a render can never destroy the element mid-gesture, so clicking and
// typing straight through in-flight op acks must just work.

// Claim a row as yourself via its star, then wait for the editor
async function claimRow(page, uname) {
  await page.click('.tile[data-uname="' + uname + '"] .tu');
  await page.waitForSelector('.tile.mine .rebid input');
}

// Type a bid into your row and submit it the way a human does: Enter.
// (Implicit form submission — a single-input form with no button — is
// exactly what this exercises; jsdom can't.)
async function bid(page, bidText) {
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
    ok(await alice.evaluate(() => location.pathname === '/'
       && document.getElementById('aname').value === ''
       && document.activeElement === document.getElementById('aname')),
       'a bare visit invents nothing: the empty auction field holds'
       + ' the caret');
    ok(await alice.evaluate(() =>
      getComputedStyle(document.querySelector('#status > .gavel'))
        .opacity === '0'),
       'the unnamed ledger IDLES — no eternal gavel (the busy sign'
       + ' means busy, and nothing is happening)');
    await alice.type('#aname', 'brunch');
    await alice.waitForFunction(() => location.pathname === '/brunch');
    ok(true, 'naming the auction navigates: /brunch');
    const slug = 'brunch';
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
        '#tiles .tile:not(.has-bid):not(.mine) .tile-name'))
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
    // (subs superscript shelved 2026-07-15 for clutter; restore with the
    // commented code in app.js/style.css)
    // ok(await alice.evaluate(() =>
    //   parseFloat(getComputedStyle(document.querySelector(
    //     '.check .tile-subs')).marginLeft) > 0),
    //    'the superscript count keeps a little air from the checkmark');
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
    ok(await alice.evaluate(() => {
      const alpha = (c) => {
        const m = c.match(/(?:rgba\([^)]+,\s*|\/\s*)([\d.]+)\)\s*$/);
        return m ? parseFloat(m[1]) : 1;
      };
      const cs = getComputedStyle(document.querySelector('#status .seal'));
      const ca = getComputedStyle(
        document.querySelector('#status .seal'), '::after');
      // color-emoji glyphs MULTIPLY by the fill color's alpha, and
      // Chrome's UA sheet gives disabled buttons a 0.3-alpha color —
      // the actual culprit behind every grayed padlock/tada sighting
      return ca.opacity === '1' && ca.filter === 'none'
        && alpha(cs.color) === 1;
    }), 'the padlock shows full-strength while sealed: full-alpha'
       + ' color, so the emoji renders solid in every browser');
    ok(await alice.evaluate(() =>
      document.querySelectorAll('#tiles .tu').length === 2
      && document.querySelector('.tile[data-uname="alice"] .tu.selected')
      && !document.querySelector('.tile[data-uname="bob"] .tu.selected')),
       'her first add lit her own star (2j); bob waits hollow');
    ok(await alice.evaluate(() => {
      const alpha = (c) => {
        const m = c.match(/(?:rgba\([^)]+,\s*|\/\s*)([\d.]+)\)\s*$/);
        return m ? parseFloat(m[1]) : 1;
      };
      const cs = getComputedStyle(
        document.querySelector('.tile:not(.mine) .tu'));
      return alpha(cs.color) === 0
        && parseFloat(cs.webkitTextStrokeWidth) >= 1
        && alpha(cs.webkitTextStrokeColor) > 0.5
        && parseFloat(cs.fontSize) > 16;
    }), 'a claimable star is a true radio hollow: same glyph, outline'
       + ' only, big enough to want to press');
    await alice.hover('.tile[data-uname="bob"] .x');
    ok(await alice.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--err-fg)';
      document.body.append(probe);
      const danger = getComputedStyle(probe).color;
      probe.remove();
      return getComputedStyle(
        document.querySelector('.tile[data-uname="bob"] .x')).color === danger;
    }), 'the trailing × reddens on hover: reads as "remove this row"');

    ok(await alice.evaluate(() =>
      document.querySelector('#status .th-person').textContent
        .includes('PARTICIPANTS')
      && !!document.querySelector('#status .th-bid #seal')
      && !document.querySelector('#status .th-person [data-tip]')),
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
    await alice.click('.tile[data-uname="bob"] .tu');  // a radio switch
    await alice.waitForSelector('.tile[data-uname="bob"].mine',
                                { timeout: 2000 });
    ok(true, 'clicking a star works even with an uncommitted name pending');
    ok(await alice.$eval('#roster-input', (e) => e.value) === 'carol',
       'the pending name stays visible in the + row, not lost, not added');
    await alice.click('.tile[data-uname="alice"] .tu');  // and back
    await alice.waitForSelector('.tile[data-uname="alice"].mine');
    await alice.$eval('#roster-input', (e) => { e.value = ''; });

    ok(await alice.evaluate(() =>
      document.activeElement === document.querySelector('.tile.mine .rebid input')),
       'claiming your row drops you straight into the bid editor');
    ok(await alice.evaluate(() => {
      const mine = document.querySelector('.tile.mine .tile-name');
      const other = document.querySelector(
        '.tile:not(.mine):not(.has-bid) .tile-name');
      return getComputedStyle(mine).animationName === 'none'
        && getComputedStyle(mine).boxShadow !== 'none'
        && getComputedStyle(other).animationName === 'breathe';
    }), 'others pulse (awaited); your row sits still, subtly up-popped');
    ok(await alice.evaluate(() =>
      getComputedStyle(document.querySelector('.tile.mine .rebid input'))
        .boxShadow !== 'none'),
       'the pop lifts the whole you-row, bid piece included');
    // the empty editor invites with the caret, not words: no
    // placeholder, a normal solid field, focus already in it — and
    // never a pulse (pulsing means "waiting on THEM")
    ok(await alice.$eval('.tile.mine .rebid input',
        (e) => e.placeholder === ''), 'the editor holds no placeholder');
    ok(await alice.evaluate(() => {
      const e = document.querySelector('.tile.mine .rebid input');
      return getComputedStyle(e).animationName === 'none'
        && getComputedStyle(e).borderTopStyle === 'solid'
        && document.activeElement === e;
    }), 'your empty editor: a normal solid field, focused, not pulsing');
    await bid(alice, 'three tacos');
    await alice.waitForSelector('#tiles .tile.has-bid');
    ok(await alice.$eval('.tile.mine .rebid input', (e) => e.value)
       === 'three tacos', 'her bid lives in her row, editable in place');
    ok(await alice.evaluate(() =>
      getComputedStyle(document.querySelector('.tile.mine .rebid input'))
        .animationName === 'none'),
       'no pulse with the bid in either: only not-you rows ever pulse');
    ok(await alice.evaluate(() => {
      const f = getComputedStyle(document.querySelector('footer'));
      const a = getComputedStyle(document.querySelector('footer a'));
      return f.borderTopWidth === '0px'
        && a.borderBottomStyle === 'none'
        && parseFloat(f.fontSize) < 12;
    }), 'the footer whispers: no rule above, no resting underline, tiny');
    // (green ✅ scrapped 2026-07-16; the green card is the signal)
    // await alice.waitForFunction(() =>  // 0.3s fade: wait, don't sample
    //   getComputedStyle(document.querySelector(
    //     '#tiles .tile.has-bid .check')).filter === 'none');
    // ok(await alice.evaluate(() =>
    //   getComputedStyle(document.querySelector(
    //     '#tiles .tile:not(.has-bid) .check')).filter.includes('grayscale')),
    //    'checkmark green once a bid is in, gray while the count is 0');
    // (subs superscript shelved 2026-07-15)
    // ok(await alice.evaluate(() =>
    //   document.querySelector('#tiles .tile.has-bid .check sup.tile-subs')
    //     .textContent === '1'),
    //    'the submission count rides the checkmark as a superscript');
    ok(await alice.evaluate(() => {
      const cell = document.querySelector('#tiles .tile.has-bid .tile-bid');
      cell.dispatchEvent(new Event('mouseenter'));
      return /^your bid submitted \d+s ago$/.test(cell.dataset.tip);
    }), 'hovering her bid cell tells her when she submitted');
    ok(await alice.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--star)';
      document.body.append(probe);
      const gold = getComputedStyle(probe).color;
      probe.remove();
      const star = document.querySelector('.tile.mine .tu');
      const other = document.querySelector('.tile:not(.mine) .tu');
      return star.classList.contains('selected')
        && getComputedStyle(star).color === gold
        && getComputedStyle(star).webkitTextStrokeColor === gold
        && getComputedStyle(star).webkitTextStrokeWidth
           === getComputedStyle(other).webkitTextStrokeWidth
        && getComputedStyle(star).textShadow !== 'none';
    }), 'her star glows gold — the exact hollow shape, filled: same'
       + ' stroke width, gold stroke plus gold fill');
    ok(await alice.evaluate(() => {
      const cs = getComputedStyle(
        document.querySelector('.tile.mine .tu'), '::before');
      return cs.textShadow === 'none'
        && parseFloat(cs.webkitTextStrokeWidth) === 0;
    }), "the star's glow stays OUT of its tooltip: inherited"
       + ' text-shadow and stroke are reset like the other text styles');
    ok(await alice.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--star)';
      document.body.append(probe);
      const gold = getComputedStyle(probe).color;
      probe.remove();
      return getComputedStyle(document.querySelector('#status .legend'),
        '::first-letter').color === gold;
    }), "the legend's star is the same gold as a lit one");
    ok(await alice.evaluate(() =>
      ['#tiles .tile.has-bid .x', '#seal'].every((sel) => {
        // dreev's bug: opacity on a grayed control dimmed its tooltip
        // AND opened a stacking context that painted it behind the
        // rows below; graying must never touch the tooltip's host
        const el = document.querySelector(sel);
        const cs = getComputedStyle(el);
        return el.disabled && cs.opacity === '1' && cs.filter === 'none'
          && cs.transform === 'none';
      })), 'grayed controls stay full-strength tooltip hosts');
    await alice.hover('#tiles .tile.has-bid .x');
    await alice.waitForFunction(() =>  // 0.15s fade: wait, don't sample
      getComputedStyle(document.querySelector('#tiles .tile.has-bid .x'),
        '::before').opacity === '1');
    ok(true, "the disabled ×'s tooltip shows at full strength");
    ok(await alice.evaluate(() => {
      const edges = [...document.querySelectorAll('#tiles .tile')].map((t) =>
        t.querySelector('.bid-card, .rebid input')
          .getBoundingClientRect().right);
      return edges.every((e) => Math.abs(e - edges[0]) < 1);
    }), 'every bid box matches length: one right edge down the column');

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
    // the tooltip invariant: only one visible at a time — a focus-parked
    // tip must stand down when another is hovered
    await alice.evaluate(() => document.getElementById('help').focus());
    await alice.hover('.field label[data-tip]');
    await alice.waitForFunction(() =>  // fades: wait, don't sample
      [...document.querySelectorAll('[data-tip]')].filter((e) => {
        const cs = getComputedStyle(e, '::before');
        return cs.visibility === 'visible' && cs.opacity === '1';
      }).length === 1);
    ok(true, 'only one tooltip visible at a time: hover trumps parked focus');
    await alice.mouse.move(5, 400);  // park the pointer away from any tip
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
         'Or just use it to play Schelling\u2019s coordination game.'),
       'help dialog shows the sealedbids text');
    await shoot(alice, 'help-dialog');
    ok(await alice.evaluate(() => {
      const r = document.getElementById('help-dlg').getBoundingClientRect();
      return r.top > 0 && r.top <= Math.min(window.innerHeight * 0.1,
                                            8 * 16) + 1;
    }), 'the dialog hangs near the top, not dead center (reads better'
       + ' on big screens, same rule everywhere)');
    await alice.click('#help-dlg .dlg-x');
    await alice.waitForFunction(() => !document.getElementById('help-dlg').open);
    /* Replicata (dreev): open help, click OUTSIDE the box to dismiss.
       Expectata: popup gone and no tooltip. Resultata pre-fix: closing
       restored focus to the ? button, whose focus-tip stuck until the
       next click. */
    await alice.click('#help');
    await alice.waitForFunction(() => document.getElementById('help-dlg').open);
    await alice.mouse.click(10, 500);  // the backdrop, far from the box
    await alice.waitForFunction(() => !document.getElementById('help-dlg').open);
    await alice.waitForFunction(() =>  // 0.15s fade: wait, don't sample
      getComputedStyle(document.getElementById('help'), '::before')
        .opacity === '0');
    ok(await alice.evaluate(() =>
      document.activeElement !== document.getElementById('help')),
       'dismissing the dialog leaves no stuck tooltip on the ? button');
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
      const sh = getComputedStyle(document.querySelector(
        '.tile.has-bid:not(.mine) .tile-name')).boxShadow;
      // the no-op --lift computes as a transparent zero shadow
      return sh === 'none' || sh === 'rgba(0, 0, 0, 0) 0px 0px 0px 0px';
    }), "someone else's green cell sits flat: no glow, no pop");
    ok(await bob.evaluate(() => {
      // the three-state taxonomy: hollow = open, FILLED (neutral ink)
      // = claimed by someone else, gold glow = you — and dimming rides
      // color alpha, never element opacity (the tooltip-host rule)
      const alpha = (c) => {
        const m = c.match(/(?:rgba\([^)]+,\s*|\/\s*)([\d.]+)\)\s*$/);
        return m ? parseFloat(m[1]) : 1;
      };
      const taken = document.querySelector('.tile[data-uname="alice"] .tu');
      const plain = document.querySelector('.tile[data-uname="bob"] .tu');
      return taken.disabled && !plain.disabled
        && getComputedStyle(taken).opacity === '1'
        && alpha(getComputedStyle(taken).color) > 0.5
        && alpha(getComputedStyle(plain).color) === 0
        && taken.getAttribute('data-tip')
             === 'Claimed by someone (Mac Chrome ' + navigator.language
               + ' in Portland, OR)';
    }), "alice's star fills in on bob's screen — claimed by someone"
       + ' else, says the tip, naming the rig — while open seats stay'
       + ' hollow');
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
    opDelay = 900;  // the reveal round-trips like everything else
    ok(await bob.evaluate(() =>
      getComputedStyle(document.getElementById('seal'), '::after')
        .animationName === 'lockpulse'
      && getComputedStyle(document.getElementById('seal')).transform
        === 'none'),
       'the pressable padlock pulses for attention — on the glyph, so'
       + " the button never opens a stacking context under its tooltip");
    await bob.click('#seal');
    await bob.waitForFunction(() => {  // 0.15s fade: wait, don't sample
      const g = document.querySelector('#status > .gavel');
      return getComputedStyle(g).opacity === '1';
    });
    ok(true, 'the big gavel hammers while the reveal is in flight —'
       + ' pressing the padlock visibly DOES something');
    opDelay = 0;
    await bob.waitForFunction(() =>
      document.getElementById('status').textContent.includes('three tacos'));
    // universal tooltip hygiene (dreev keeps catching stragglers): an
    // ACTIVATED button must never sit there wearing its focus-tip
    // once the pointer moves on (hover keeps it, rightly, while you
    // hover)
    await bob.mouse.move(10, 600);
    await bob.waitForFunction(() =>  // 0.15s fade: wait, don't sample
      getComputedStyle(document.getElementById('seal'), '::before')
        .opacity === '0');
    ok(await bob.evaluate(() =>
      document.activeElement !== document.getElementById('seal')),
       "pressing the padlock doesn't leave its tooltip stuck (the"
       + ' universal blur-on-activation rule)');
    ok(await bob.$eval('.tile.mine .rebid input', (e) => e.value)
       === 'my entire kingdom',
       "pressing the padlock reveals everything: alice's card + his own row");
    await bob.waitForFunction(() =>  // fade-in: wait, don't sample
      parseFloat(getComputedStyle(document.querySelector('#status .seal'))
        .opacity) === 1);
    ok(true, 'the icon comes to full strength at the reveal');
    ok(await bob.$eval('.tile.mine .rebid input', (e) => e.disabled),
       'the gavel drop is a bright line: the editor goes dead at the'
       + ' reveal');
    ok(await bob.evaluate(() => getComputedStyle(
         document.querySelector('#status .seal'), '::after').content)
       .then((c) => c.includes('\u{1F389}')),
       'the padlock becomes the tada at the reveal: one icon, three states');
    ok(await bob.evaluate(() => {
      const alpha = (c) => {
        const m = c.match(/(?:rgba\([^)]+,\s*|\/\s*)([\d.]+)\)\s*$/);
        return m ? parseFloat(m[1]) : 1;
      };
      const s2 = document.getElementById('seal');
      return !s2.disabled && alpha(getComputedStyle(s2).color) === 1;
    }), 'the tada is never a disabled control at all (reveal is'
       + ' idempotent), so no UA sheet can wash it out');
    await bob.waitForFunction(() => {  // 0.15s fade: wait, don't sample
      const g = document.querySelector('#status > .gavel');
      return getComputedStyle(g.querySelector('.mallet')).animationName
        === 'gavel-verdict'
        && getComputedStyle(g).opacity === '1';
    });
    ok(true, 'the gavel returns for one ceremonial verdict stroke');
    ok(await bob.evaluate(() => {
      const st = document.querySelector('#status .fete .stamp');
      const c = document.querySelector('#status .fete .confetto');
      return st && getComputedStyle(st).animationName === 'stamp-slam'
        && c && getComputedStyle(c).animationName
             === 'confetti-fly, glitter'
        && document.querySelectorAll('#status .fete .confetto').length >= 60;
    }), 'SOLD slams down and the confetti actually flies');
    ok(await bob.evaluate(() =>
      getComputedStyle(document.querySelector('.addrow')).display
        === 'none'
      && getComputedStyle(document.querySelector('#status .closed'))
           .display !== 'none'
      && /^Closed /.test(document.querySelector('#status .closed')
           .textContent)),
       'the + row retires at the reveal; the Closed stamp takes its'
       + ' place');
    await bob.waitForFunction(() =>  // the ceremony self-cleans
      !document.querySelector('#status .fete'), { timeout: 6000 });
    ok(true, 'the ceremony packs up after itself');
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
      && !!document.querySelector('.tile[data-uname="evy"]'));
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
    // a cut row (bid kept, seat gone — another machine removed dee):
    // the strike-through must read as a confident pen stroke, not a
    // grayed-out row (and no element opacity: the × inside hosts a tip)
    gas.handle({ action: 'remove', aname: 'chores', uname: 'dee' });
    await alice.waitForFunction(() =>
      document.querySelector('.tile[data-uname="dee"].cut'));
    ok(await alice.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--err-fg)';
      document.body.append(probe);
      const ink = getComputedStyle(probe).color;
      probe.remove();
      const t = document.querySelector('.tile[data-uname="dee"].cut');
      const stroke = getComputedStyle(t, '::after');
      return getComputedStyle(t).opacity === '1'
        && stroke.opacity === '1'
        && stroke.backgroundColor === ink;
    }), 'the cut stroke is full-strength cancellation ink; the row'
       + ' beneath stays legible');
    ok(await alice.evaluate(() =>
      !document.querySelector('.tile[data-uname="dee"] .x').disabled),
       "the cut row's × stays alive: the recovery path");
    await shoot(alice, 'story3-roster-reveal');

    /* ================= Story 4: clicks survive op-ack renders ==========
       Replicata: add a name; while the add's ack is in flight, press
       the mouse on a star; let the ack land (which re-renders the
       rows); release the mouse. Expectata: the click lands anyway —
       the row's NODE survived the render (keyed reuse), and a click
       needs mousedown and mouseup on the same node. */
    const carol = await makePage(browser, DESKTOP);
    await carol.goto(BASE + '/gesture', { waitUntil: 'networkidle0' });
    await carol.waitForSelector('#tiles');
    await addName(carol, 'cat');  // self-claims (2j): carol is cat
    await carol.waitForSelector('.tile[data-uname="cat"]');
    opDelay = 400;
    await addName(carol, 'dog');  // its ack lands mid-gesture below
    const starBox = await (await carol.$('.tile[data-uname="dog"] .tu'))
      .boundingBox();
    await carol.mouse.move(starBox.x + starBox.width / 2,
                           starBox.y + starBox.height / 2);
    await carol.mouse.down();
    await new Promise((r) => setTimeout(r, 700));  // ack + render land
    opDelay = 0;
    await carol.mouse.up();
    await carol.waitForSelector('.tile[data-uname="dog"].mine .rebid input',
                                { timeout: 2000 });
    ok(true, 'a click straddling an op-ack render still lands (the very'
       + ' row whose ack was in flight)');

    /* ---- re-bid stacks and the you-row pop share box-shadow: both
       must survive composition (carol switched to dog in the gesture
       test above) ----------------------------------------------------- */
    await carol.waitForSelector('.tile.mine .rebid input');
    await bid(carol, 'one fish');
    await carol.waitForSelector('.tile.mine .rebid input.stack0');
    await carol.$eval('.tile.mine .rebid input', (e) => { e.value = ''; });
    await bid(carol, 'two fish');
    await carol.waitForSelector('.tile.mine .rebid input.stack1');
    ok(await carol.evaluate(() =>
      (getComputedStyle(document.querySelector('.tile.mine .rebid input'))
        .boxShadow.match(/rgba?\(/g) || []).length >= 3),
       'the re-bid stack sheets and the you-pop compose, losing neither');

    /* ---- the busy gavel: graying alone doesn't say "working", so a
       CSS-drawn gavel hammers its block, overlaid on the grayed ledger,
       while the app talks to the server ------------------------------ */
    // a generous window: the gavel is a TRANSIENT (visible only while
    // the op is in flight), and a ~900ms window once lost a race to a
    // runner stall — the wait can't start until the add round-trips
    opDelay = 2500;
    await addName(carol, 'fox');  // an op is now in flight for ~2.5s
    await carol.waitForFunction(() => {  // 0.15s fade: wait, don't sample
      const g = document.querySelector('#status .gavel');
      return getComputedStyle(g).opacity === '1'
        && getComputedStyle(g.querySelector('.mallet')).animationName
           === 'gavel';
    });
    ok(await carol.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--wood)';
      document.body.append(probe);
      const wood = getComputedStyle(probe).color;
      probe.remove();
      const head = getComputedStyle(
        document.querySelector('.gavel .head')).backgroundColor;
      const spin = document.styleSheets;  // (the 360 lives in keyframes)
      return head === wood;
    }), 'the gavel is wood, as gavels are');
    ok(await carol.evaluate(() =>
      getComputedStyle(document.querySelector('.gavel .grip'), '::after')
        .content === 'none'),
       'no pommel knob: it sat at the rotation origin and read as a'
       + ' fixed hub the gavel spun around');
    ok(await carol.evaluate(() => {
      for (const sheet of document.styleSheets) {
        for (const rule of sheet.cssRules) {
          if (rule.name === 'gavel') {
            const last = [...rule.cssRules].find((k) => k.keyText === '100%');
            return last && /33[0-9]deg/.test(last.style.transform);
          }
        }
      }
      return false;
    }), 'after the strike it follows through all the way around: spinner');
    ok(await carol.evaluate(() => {
      // matrix(cos, sin, ...): a negative sin means the ray tilts upward
      const bang = document.querySelector('.gavel .bang');
      const sin = (cs) => parseFloat(cs.transform.split(',')[1]);
      return [getComputedStyle(bang, '::before'),
              getComputedStyle(bang.firstElementChild),
              getComputedStyle(bang, '::after')]
        .every((cs) => sin(cs) < 0);
    }), 'all three spark rays kick up and away from the impact');
    ok(await carol.evaluate(() => {
      const g = document.querySelector('#status .gavel').getBoundingClientRect();
      const t = document.getElementById('tiles').getBoundingClientRect();
      return g.top < t.bottom && g.bottom > t.top
        && g.left > t.left && g.right < t.right;
    }), 'the gavel hammers overlaid on the grayed ledger, spinner-style');
    opDelay = 0;
    await carol.waitForFunction(() =>  // fades out: wait, don't sample
      getComputedStyle(document.querySelector('#status .gavel'))
        .opacity === '0');
    ok(true, 'the gavel rests once the server has confirmed everything');
    /* ---- a bid gets a row-local mini gavel, not the table-wide one ---- */
    opDelay = 1200;
    await carol.$eval('.tile.mine .rebid input', (e) => { e.value = ''; });
    await bid(carol, 'three fish');
    await carol.waitForFunction(() => {
      const m = document.querySelector('.rebid.busy .gavel.mini');
      return m && getComputedStyle(m).display !== 'none'
        && getComputedStyle(m.querySelector('.mallet')).animationName
             === 'gavel'
        && getComputedStyle(document.querySelector('#status > .gavel'))
             .opacity === '0';
    });
    ok(true, 'a bid in flight: the mini gavel hammers at YOUR row while'
       + ' the big one (whole-table ops only) sits out');
    opDelay = 0;
    await carol.waitForFunction(() =>
      !document.querySelector('.rebid.busy'));
    ok(true, 'the mini gavel rests when the bid lands');
    /* ---- names are live text fields: click in, type, enter ------------ */
    await carol.click('.tile[data-uname="fox"] .rename input');
    ok(await carol.evaluate(() => {
      // one focus language: the ring is suppressed here (box-in-a-box),
      // so the stand-in underline must speak the same accent color
      const probe = document.createElement('span');
      probe.style.color = 'var(--accent)';
      document.body.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      const cs = getComputedStyle(
        document.querySelector('.tile[data-uname="fox"] .rename input'));
      return cs.outlineStyle === 'none' && cs.boxShadow.includes(accent);
    }), 'the focused name field underlines itself in the focus accent');
    await carol.$eval('.tile[data-uname="fox"] .rename input',
                      (e) => e.select());
    await carol.keyboard.type('foxy');
    await carol.keyboard.press('Enter');
    await carol.waitForSelector('.tile[data-uname="foxy"]');
    ok(true, 'the name is just an editable field: type and enter renames');

    /* ---- error banners overlay; they never shift the page ------------- */
    const statusTop = await carol.evaluate(() =>
      document.getElementById('status').getBoundingClientRect().top);
    await carol.click('.tile[data-uname="dog"] .rename input');
    await carol.$eval('.tile[data-uname="dog"] .rename input',
                      (e) => e.select());
    await carol.keyboard.type('foxy');  // taken!
    await carol.keyboard.press('Enter');
    await carol.waitForFunction(() =>
      !document.getElementById('banner').hidden);
    ok(await carol.evaluate((t) =>
      document.getElementById('status').getBoundingClientRect().top === t,
      statusTop), 'the error banner overlays without shifting the page');

    /* ================= Story 5: everything works by thumb ==============
       A phone drives the whole flow with touch taps (not mouse clicks —
       Chromium synthesizes the clicks our listeners hear) and the
       keyboard's return key: adding, claiming, bidding, renaming,
       removing, revealing. The return key rides implicit form
       submission (the bid and name fields are single-input forms) or
       the Enter keydown (the + row) — no physical Enter key, no mouse,
       no buttons required. (The real iOS/Android keyboard itself can't
       be driven from Chromium; enterkeyhint attributes are pinned by
       the frontend quals.) */
    const mobileViewport = { width: 390, height: 844,
      deviceScaleFactor: 3, isMobile: true, hasTouch: true };
    const thumb = await makePage(browser, mobileViewport);
    await thumb.goto(BASE + '/thumbs', { waitUntil: 'networkidle0' });
    await thumb.tap('#roster-input');
    await thumb.type('#roster-input', 'ana');
    await thumb.keyboard.press('Enter');
    await thumb.type('#roster-input', 'bo');
    await thumb.keyboard.press('Enter');
    await thumb.waitForSelector('.tile[data-uname="bo"]');
    ok(true, 'the + row takes names from the return key');
    await thumb.waitForSelector('.tile.mine .rebid input');
    ok(true, 'her first thumbed-in name is hers (2j): editor ready');
    await thumb.type('.tile.mine .rebid input', 'thumb-typed bid');
    await thumb.keyboard.press('Enter');
    await thumb.waitForSelector('.tile.mine.has-bid');
    ok(true, 'return submits the bid: implicit form submission, no'
       + ' button, no mouse');
    await thumb.tap('.tile[data-uname="bo"] .rename input');
    await thumb.$eval('.tile[data-uname="bo"] .rename input',
                      (e) => e.select());
    await thumb.keyboard.type('bob');
    await thumb.keyboard.press('Enter');
    await thumb.waitForSelector('.tile[data-uname="bob"]');
    ok(true, 'renaming works by thumb: tap, type, return');
    await thumb.type('#roster-input', 'oops');
    await thumb.keyboard.press('Enter');
    await thumb.waitForSelector('.tile[data-uname="oops"]');
    await thumb.tap('.tile[data-uname="oops"] .x');
    await thumb.waitForFunction(() =>
      !document.querySelector('.tile[data-uname="oops"]'));
    ok(true, 'tapping a × removes the row');
    const thumb2 = await makePage(browser, mobileViewport);
    await thumb2.goto(BASE + '/thumbs', { waitUntil: 'networkidle0' });
    await thumb2.tap('.tile[data-uname="bob"] .tu');
    await thumb2.waitForSelector('.tile.mine .rebid input');
    ok(true, 'tapping a star (a touch, not a click) claims the row');
    await thumb2.type('.tile.mine .rebid input', 'the other thumb');
    await thumb2.keyboard.press('Enter');
    await thumb2.waitForSelector('.tile.mine.has-bid');
    await thumb.waitForFunction(() =>  // the poll delivers bob's bid
      !document.getElementById('seal').disabled);
    await thumb.tap('#seal');
    await thumb.waitForFunction(() =>
      document.getElementById('status').classList.contains('revealed'));
    ok(await thumb.evaluate(() =>
      document.getElementById('status').textContent
        .includes('the other thumb')),
       'tapping the padlock reveals: the whole auction ran by thumb');
    await shoot(thumb, 'story5-thumb-revealed');

    /* ================= Story 6: two thumbs, one alice ==================
       Roommates both open /squabble on their phones; the roster lists
       alice and bea, unclaimed. Phone 1 taps alice's star. Phone 2 —
       its screen still showing alice open (no poll yet) — taps alice
       too. First come, first served: phone 2 loses LOUDLY (no silent
       stealing, no two-alices), watches the star go dibsed as the
       recovery snapshot lands, takes bea instead, and the game plays
       out normally. */
    gas.handle({ action: 'add', aname: 'squabble', uname: 'alice' });
    gas.handle({ action: 'add', aname: 'squabble', uname: 'bea' });
    const p1 = await makePage(browser, mobileViewport);
    const p2 = await makePage(browser, mobileViewport);
    await p1.goto(BASE + '/squabble', { waitUntil: 'networkidle0' });
    await p2.goto(BASE + '/squabble', { waitUntil: 'networkidle0' });
    await p1.tap('.tile[data-uname="alice"] .tu');
    await p1.waitForSelector('.tile[data-uname="alice"].mine');
    ok(await p2.$eval('.tile[data-uname="alice"] .tu',
        (e) => !e.disabled),
       "phone 2's stale screen still offers alice: the race is on");
    await p2.tap('.tile[data-uname="alice"] .tu');
    await p2.waitForFunction(() =>
      document.querySelector('.tile[data-uname="alice"] .tu.taken')
      && !document.querySelector('#tiles .rebid'));
    ok(await p2.evaluate(() =>
      document.getElementById('banner').hidden
      && /^Claimed by someone \(/.test(
           document.querySelector('.tile[data-uname="alice"] .tu')
             .getAttribute('data-tip'))),
       'phone 2 loses the race QUIETLY: no red banner — the star fills'
       + ' in and its tooltip says who beat her');
    await p2.tap('.tile[data-uname="bea"] .tu');
    await p2.waitForSelector('.tile[data-uname="bea"].mine .rebid input');
    ok(true, 'phone 2 takes the open seat instead, one tap');
    await p2.type('.tile.mine .rebid input', 'a dozen eggs');
    await p2.keyboard.press('Enter');
    await p2.waitForSelector('.tile.mine.has-bid');
    await p1.type('.tile.mine .rebid input', 'my parking spot');
    await p1.keyboard.press('Enter');
    await p1.waitForSelector('.tile.mine.has-bid');
    await p1.waitForFunction(() =>
      !document.getElementById('seal').disabled);
    await p1.tap('#seal');
    await p1.waitForFunction(() =>
      document.getElementById('status').textContent
        .includes('a dozen eggs'));
    ok(true, 'and the game plays out: both bids in, revealed by thumb');

    console.log('story-quals: all ' + passed + ' assertions passed');
  } finally {
    await browser.close();
    server.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });
