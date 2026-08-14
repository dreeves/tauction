// Story quals: complete user journeys in REAL headless Chrome, served by the
// real serve.py, backed by the real Code.gs logic (network calls to the API
// are intercepted and answered by fake-gas in-process). jsdom does no layout
// and no navigation, so this suite is what catches "human clicks around and
// it's broken" bugs: dead-end 404s, clipped tooltips, horizontal overflow,
// and enter-to-submit in the row editor (the editor's real keydown wiring).
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

// hasTouch (dreev's 8b go, 2026-08-10): the phone viewport now
// EMULATES TOUCH, so (pointer: coarse) matches and the touch-
// ergonomics block — 44px targets, 16px inputs, the whole layer —
// finally renders in phone captures and geometry asserts. (NARROW
// stays fine-pointer on purpose: it probes the narrow-desktop
// case, whose layout ruling is dreev's pending 320px call.)
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2,
                hasTouch: true };
const NARROW = { width: 320, height: 844, deviceScaleFactor: 2 };
const DESKTOP = { width: 1200, height: 800 };


let passed = 0;
function ok(cond, label) {
  if (!cond) { console.error('FAIL: ' + label); process.exit(1); }
  passed++;
}

const gas = makeGas();
// Copy derived from stringles.js, same as the frontend suite does
// (the server refuses in CODES; stringles renders every refusal's
// words — and the one refusal pinned here is the client's own
// pre-wire objection anyway)
const STR = new Function(
  fs.readFileSync(path.join(REPO, 'stringles.js'), 'utf8')
  + '; return { bidTooLongBanner };')();

// Answer any request to the deployed API URL with the local Code.gs
// logic; write ops can be artificially delayed for in-flight-race
// quals, and reads too (readDelay) — the live API takes 2-3s a call,
// and the fresh-URL dead-screen regression hid in exactly that gap
let opDelay = 0;
let readDelay = 0;
async function bridge(page) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url().includes('ipwho.is')) {  // geo fixture: no network
      return req.respond({ status: 200, contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ city: 'Portland', region_code: 'OR' }) });
    }
    // the CSV pulse (2026-08-06): the sheet's gviz face, served from
    // the fake's pulse tab in the gviz headers=1 shape
    if (req.url().includes('/gviz/tq')) {
      const rows = gas.__ss.sheets.pulse ? gas.__ss.sheets.pulse.data : [];
      const line = rows[1] ? '\n"' + rows[1][0] + '"' : '';
      return req.respond({ status: 200, contentType: 'text/csv',
        headers: { 'access-control-allow-origin': '*' },
        body: '"wver"' + line });
    }
    if (!req.url().startsWith('https://script.google.com/')) return req.continue();
    const q = req.method() === 'POST'
      ? JSON.parse(req.postData())
      : Object.fromEntries(new URL(req.url()).searchParams);
    const wait = ['add', 'remove', 'claim', 'release', 'bid', 'reveal',
                  'describe', 'archive'].includes(q.action) ? opDelay
                                                            : readDelay;
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
  // the zero-page-errors NET: any uncaught exception in any story
  // flow — even one no assert happens to notice — fails the suite
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await bridge(page);
  return page;
}
const pageErrors = [];

const text = (page, sel) =>
  page.$eval(sel, (e) => e.textContent).catch(() => null);

async function shoot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });
}

// Add a person via the ledger's + row
async function addName(page, snym) {
  await page.type('#roster-input', snym);
  await page.keyboard.press('Enter');
}

// No waiting for pending ops here, deliberately: keyed node reuse means
// a render can never destroy the element mid-gesture, so clicking and
// typing straight through in-flight op acks must just work.

// Claim a row as yourself via its star, then wait for the editor
async function claimRow(page, snym) {
  await page.click('.tile[data-snym="' + snym + '"] .tu');
  await page.waitForSelector('.tile.mine .rebid textarea');
}

// Type a bid into your row and submit it the way a human does: Enter.
// (The editor's Enter keydown — a wrapping textarea gets no implicit
// form submission — exercised in a real browser.)
async function bid(page, bidText) {
  await page.type('.tile.mine .rebid textarea', bidText);
  await page.keyboard.press('Enter');
}


(async () => {
  ok(CHROME, 'found a Chrome/Chromium binary');
  fs.mkdirSync(SHOTS, { recursive: true });
  // fail LOUD if a stale server squats the port (see serve-quals:
  // a silent EADDRINUSE means testing a zombie's stale bytes)
  try {
    await fetch(BASE + '/');
    console.error('FAIL: port ' + PORT + ' is already serving —'
      + ' kill the stale server (lsof -i :' + PORT + ') and rerun');
    process.exit(1);
  } catch (e) { /* connection refused = port free, good */ }
  const server = spawn('python3', [path.join(REPO, 'serve.py'), String(PORT)],
                       { stdio: 'ignore' });
  // a FAILING run exits via process.exit, which skips finally — the
  // orphaned server then squats the port for every later run (the
  // pre-flight guard catches it; this prevents it)
  process.on('exit', () => { try { server.kill(); } catch (e) {} });
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
       && document.getElementById('slug').value === ''
       && document.activeElement === document.getElementById('slug')),
       'a bare visit invents nothing: the empty auction field holds'
       + ' the caret');
    ok(await alice.evaluate(() =>
      getComputedStyle(document.querySelector('#status > .gavel'))
        .opacity === '0'),
       'the unnamed ledger IDLES — no eternal gavel (the busy sign'
       + ' means busy, and nothing is happening)');
    ok(await alice.evaluate(() =>
      getComputedStyle(document.querySelector('#status .addrow')).opacity
        === '0.4'),
       'the disabled + row dims its marker and field together');
    /* THE BUSY VEIL (dreev 2026-08-06: the gavel hammering over
       dimmed-but-still-chunky arcade chrome read janky — opacity
       dims, it doesn't dissolve 2px navy outlines): ONE busy
       mechanism, a frosted pane (backdrop blur + paper tint on
       #status::before) under the gavel, replacing the tiles-dim
       outright; the gavel itself wears the sprite treatment — ink
       outline + hard ground shadow, no soft blur left. The .stale
       class is the app's own signal; it is flipped by hand here
       purely to read the CSS truths. */
    ok(await alice.evaluate(() => {
      const v = getComputedStyle(
        document.getElementById('status'), '::before');
      return v.position === 'absolute'
        && (v.backdropFilter || '').includes('blur')
        && v.opacity === '0' && v.pointerEvents === 'none';
    }), 'the veil rests invisible: backdrop blur armed, opacity 0,'
       + ' stealing no pointer');
    ok(await alice.evaluate(() => {
      const f = getComputedStyle(
        document.querySelector('#status > .gavel')).filter;
      return f.split('drop-shadow').length - 1 >= 5
        && !f.includes('1px 5px');
    }), 'the gavel is a SPRITE: four ink-outline drop-shadows plus'
       + ' a hard ground shadow, the soft halo gone');
    ok(await alice.evaluate(async () => {
      const s = document.getElementById('status');
      s.classList.add('stale');
      await new Promise((r) => setTimeout(r, 600));  // outwait the
                                       // 0.3s no-flash delay
      const veil = getComputedStyle(s, '::before').opacity;
      const tiles = getComputedStyle(s.querySelector('.tiles')).opacity;
      s.classList.remove('stale');
      return veil === '1' && tiles === '1';
    }), 'stale raises the veil past the no-flash delay while the'
       + ' tiles keep full ink: one busy mechanism, not two');
    await alice.type('#slug', 'brunch');
    await alice.keyboard.press('Enter');  // names commit on deliberate
                                          // gestures only, never a timer
    await alice.waitForFunction(() => location.pathname === '/brunch');
    ok(true, 'naming the auction navigates: /brunch');
    const slug = 'brunch';
    ok((await alice.$$('#status .tile:not(.addrow)')).length === 0,
       'no roster yet: the ledger is just the + row');
    // the description block: RESTS RENDERED with its pencil (README
    // blub spec item 1, 2026-07-29 — reversing the edit-at-rest
    // arrival for blank anyms); the pencil opens the editing mode
    // with textarea, live preview, and its SAVE/DISCARD row
    ok(await alice.evaluate(() => {
      const t = document.getElementById('descedit');
      return getComputedStyle(t).display === 'none'
        && document.getElementById('desc').classList
             .contains('viewing')
        && getComputedStyle(document.getElementById('desctoggle'))
             .display !== 'none'
        && !document.getElementById('descgo')
             .checkVisibility({ visibilityProperty: true });
    }), 'the description rests RENDERED, pencil standing: the way in'
       + ' is one click, blank blub or not');
    await alice.click('#desctoggle');
    ok(await alice.evaluate(() => {
      const t = document.getElementById('descedit');
      const p = document.getElementById('desctoggle');
      return getComputedStyle(t).display !== 'none'
        && t.placeholder.length > 0
        && document.activeElement === t
        && !p.checkVisibility({ visibilityProperty: true })
        && document.getElementById('descdiscard')
             .checkVisibility({ visibilityProperty: true });
    }), 'the pencil opens the mode and LEAVES (dreev 2026-07-30,'
       + ' overriding gray-never-suppress here: SAVE/DISCARD are the'
       + " mode's exits): textarea focused, placeholder explaining,"
       + ' DISCARD already reachable as the way out');
    // ...and with no pencil to dodge, the field owns the card's full
    // width: symmetric insets, left and right
    ok(await alice.evaluate(() => {
      const c = document.getElementById('desc').getBoundingClientRect();
      const e = document.getElementById('descedit')
        .getBoundingClientRect();
      return Math.abs((c.right - e.right) - (e.left - c.left)) < 1;
    }), 'the editing field runs the full card width: its left and'
       + ' right insets match');
    await alice.type('#descedit', '# Rules\n\nLoser buys **coffee**');
    ok(await alice.evaluate(() =>
      document.querySelector('#descview h1')
      && document.querySelector('#descview h1').textContent === 'Rules'
      && document.querySelector('#descview strong')
           .textContent === 'coffee'),
       'the pane previews the keystrokes LIVE, rendered (spec item 5)');
    ok(await alice.evaluate(() =>
      document.getElementById('descgo')
        .checkVisibility({ visibilityProperty: true })
      && document.getElementById('descgo').textContent === saveCopy),
       "typing wakes SAVE on the desc card, wearing dreev's copy");
    // the one editing layout, here at phone width: the textarea sits
    // ABOVE the live preview, stacked, with daylight between
    ok(await alice.evaluate(() => {
      const e = document.getElementById('descedit')
        .getBoundingClientRect();
      const v = document.getElementById('descview')
        .getBoundingClientRect();
      return e.bottom <= v.top - 2
        && Math.abs(e.left - v.left) < 1;
    }), 'phone editing mode stacks: source above, rendered preview'
       + ' below, flush left (spec item 4)');
    await shoot(alice, 'story1-blub-editing-phone');
    await alice.click('#slug');  // clicking away...
    await new Promise((r) => setTimeout(r, 150));
    ok(await alice.evaluate(() =>
      document.getElementById('descedit').value
        === '# Rules\n\nLoser buys **coffee**'
      && getComputedStyle(document.getElementById('descedit')).display
           !== 'none'
      && document.getElementById('descgo')
           .checkVisibility({ visibilityProperty: true })),
       'clicking away saves NOTHING (dreev 2026-07-27): the draft'
       + ' sits in the open editor, SAVE still standing');
    opDelay = 900;  // hold the describe in flight: writes are
                    // signless (dreev 2026-07-28, the no-spinners
                    // ruling) — CARVE-OUT, dreev's option A pick
                    // 2026-08-10: the desc save alone wears its
                    // pending mini gavel (the optimistic pane is an
                    // untrusted PICTURE until the ack — so the
                    // gavel's own meaning, not a spinner); the
                    // TABLE stays signless
    await alice.click('#descgo');  // SAVE
    ok(await alice.evaluate(() =>
      !document.getElementById('desc').classList.contains('stale')
      && !document.getElementById('status').classList.contains('stale')
      && getComputedStyle(document.querySelector('#status > .gavel'))
           .opacity === '0'),
       'the in-flight blub save leaves the TABLE signless: no big'
       + " gavel, no gray — the pending sign is the desc card's"
       + ' own (option A)');
    // ...but it does wear the away-tint, held until the settle (the
    // wait rides out the tint's own 0.45s fade-in, safely inside the
    // 900ms flight)
    await alice.waitForFunction(() =>
      document.getElementById('desc').classList.contains('committed')
      && getComputedStyle(document.getElementById('desc'))
           .backgroundColor !== 'rgba(0, 0, 0, 0)', { timeout: 800 });
    ok(true, 'the in-flight save holds the commit tint: yours is'
       + ' away, not yet confirmed');
    opDelay = 0;
    await alice.waitForFunction(() =>
      document.querySelector('#descview h1'));
    ok(await alice.evaluate(() =>
      getComputedStyle(document.getElementById('descedit')).display
        === 'none'
      && document.querySelector('#descview strong').textContent
           === 'coffee'
      && getComputedStyle(document.getElementById('desctoggle'))
           .display !== 'none'
      && document.getElementById('desctoggle').querySelector('svg')
           !== null),
       'SAVE commits and renders rich (h1 + bold); the'
       + ' pencil appears, the only way back to the source');
    ok(await alice.evaluate(() => {
      const p = document.getElementById('desctoggle');
      return getComputedStyle(p).position === 'absolute'
        && getComputedStyle(p, '::before').content === 'none';
    }), 'with words on the record the pencil returns to its corner,'
       + ' invitation shed');
    // the commit tint (your words are away) cleared at the settle
    // above; the resting look this pin is about is what remains
    await alice.waitForFunction(() => {
      const box = getComputedStyle(document.getElementById('desc'));
      return box.backgroundColor === 'rgba(0, 0, 0, 0)';
    });
    ok(await alice.evaluate(() => {
      const box = getComputedStyle(document.getElementById('desc'));
      return box.borderTopColor === 'rgba(0, 0, 0, 0)'
        && box.backgroundColor === 'rgba(0, 0, 0, 0)'
        && !document.getElementById('desc').classList
             .contains('committed');
    }), 'and the settled blub rests boxless and untinted: prose on'
       + ' the page, not a field — the box itself says "editable'
       + ' here" (dreev)');

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
        .animationName === 'breathe-ink'),
       'awaiting names breathe in ink (no box left to breathe in)');
    ok(await alice.evaluate(() => {
      const slot = document.querySelector(
        '#tiles .tile:not(.has-bid) .bid-card.slot');
      return slot && getComputedStyle(slot).borderTopStyle === 'dashed'
        && getComputedStyle(slot).animationName === 'breathe'
        && slot.getBoundingClientRect().height > 10;
    }), 'an empty dashed card breathes where the awaited bid will go');
    ok(await alice.evaluate(() => {
      const name = getComputedStyle(
        document.querySelector('#tiles .tile-name'));
      const wrap = getComputedStyle(
        document.querySelector('#status .addrow .at-wrap'));
      return name.borderTopStyle === 'solid'
        && name.backgroundColor === 'rgba(0, 0, 0, 0)'
        && name.boxShadow === 'none'
        && wrap.borderTopStyle === 'solid'
        && name.borderTopColor === wrap.borderTopColor;
    }), 'person cells are normal one-line fields — solid quiet border,'
       + ' no fill, no shadow — twins of the + row that mints them');
    // fastidious alignment: field and card share border+padding
    // geometry, so their first lines sit level and a one-line row's
    // two pieces are equal heights
    ok(await alice.evaluate(() => {
      const t = document.querySelector(
        '#tiles .tile:not(.mine):not(.has-bid)');
      const name = t.querySelector('.tile-name').getBoundingClientRect();
      const slot = t.querySelector('.bid-card.slot').getBoundingClientRect();
      return Math.abs(name.top - slot.top) < 1
        && Math.abs(name.height - slot.height) < 1;
    }), 'field and awaiting card sit level: same top, same height');
    ok(await alice.evaluate(() => {
      const m = document.querySelector('#tiles .tile.mine');
      const name = m.querySelector('.tile-name').getBoundingClientRect();
      const ed = m.querySelector('.rebid textarea').getBoundingClientRect();
      return Math.abs(name.top - ed.top) < 1
        && Math.abs(name.height - ed.height) < 1;
    }), 'your field and your editor sit level too');
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
      && document.querySelector('#tiles .tile')
           .firstElementChild.classList.contains('tu')
      && !document.querySelector('#tiles .tile-name .tu')),
       'each row leads with its star; the hollow dot is retired');
    ok(await alice.evaluate(() =>
      document.querySelector('#status .addrow .addmark')
        .firstChild.nodeValue === '+'), 'the + row marked with a +');
    ok(await alice.evaluate(() => {
      const rows = document.querySelectorAll('#tiles .tile');
      const last = rows[rows.length - 1].getBoundingClientRect();
      const add = document.querySelector('.addrow').getBoundingClientRect();
      return add.top - last.bottom >= 4;
    }), 'the + row keeps the same breathing room as the rows above it');
    ok(await alice.evaluate(() => {
      const name = document.querySelector('#tiles .tile-name')
        .getBoundingClientRect();
      const wrap = document.querySelector('#status .addrow .at-wrap')
        .getBoundingClientRect();
      return Math.abs(name.left - wrap.left) < 1
        && Math.abs(name.right - wrap.right) < 1;
    }), 'the + row is a true twin of the person fields: both edges on'
       + ' the column');
    /* Replicata: put two names on the ledger and inspect the column
       headings, the identity star, the participant text, the + row,
       and the bid card. Expectata: headings align with data text;
       star/+ are a control gutter outside the participant fields.
       Resultata: PARTICIPANTS aligns with the star inside the field,
       + is boxed with the name, and BIDS aligns with the card edge. */
    ok(await alice.evaluate(() => {
      const near = (a, b) => Math.abs(a - b) < 1;
      const textLeft = (e) => {
        const r = document.createRange();
        r.selectNode(e.firstChild);
        return r.getBoundingClientRect().left;
      };
      const row = document.querySelector('#tiles .tile');
      const starEl = row.querySelector('.tu');
      const star = starEl.getBoundingClientRect();
      // re-derived for touch emulation (dreev's 8b go, 2026-08-10):
      // coarse pointers inflate the star's HIT BOX with negative
      // margins that deliberately overlap neighbors — the coarse
      // block's own promise is that the INK stays put, so the ink
      // (the glyph's own rect) is what alignment is measured on
      const inkR = document.createRange();
      inkR.selectNode(starEl.firstChild);
      const ink = inkR.getBoundingClientRect();
      const name = row.querySelector('.tile-name').getBoundingClientRect();
      const nameStyle = getComputedStyle(row.querySelector('.tile-name'));
      // the box's own text edge (the .rename form is the whole
      // column now, box + button row, since 2026-07-28)
      const whoText = name.left + parseFloat(nameStyle.borderLeftWidth)
        + parseFloat(nameStyle.paddingLeft);
      const mark = document.querySelector('.addrow .addmark');
      const plus = mark && mark.getBoundingClientRect();
      const addBox = document.querySelector('.addrow .at-wrap')
        .getBoundingClientRect();
      const addAt = document.querySelector('.addrow .at')
        .getBoundingClientRect();
      const bid = row.querySelector('.bid-card, .rebid textarea');
      const bidBox = bid.getBoundingClientRect();
      const bidStyle = getComputedStyle(bid);
      const bidText = bidBox.left + parseFloat(bidStyle.borderLeftWidth)
        + parseFloat(bidStyle.paddingLeft);
      return row.firstElementChild.classList.contains('tu')
        && ink.right < name.left
        && name.left - ink.right < 24  // the ink keeps a modest
                                 // gutter; the box may reach further
        && near(textLeft(document.querySelector('.th-person')), whoText)
        && near(addBox.left, name.left)
        && near(addBox.right, name.right)
        && plus && Math.abs((plus.left + plus.right) / 2
                        - (ink.left + ink.right) / 2) < 4
        && near(addAt.left, whoText)
        && Math.abs((ink.top + ink.bottom) / 2
                    - (name.top + name.bottom) / 2) < 4
        && star.width >= 24 && star.height >= 24
        && near(textLeft(document.querySelector('.th-bid')), bidText);
    }), 'headings align with participant and bid text; star and + sit'
       + ' in the control gutter outside equal-height participant fields');
    ok(await alice.evaluate(() => {
      const alpha = (c) => {
        const m = c.match(/(?:rgba\([^)]+,\s*|\/\s*)([\d.]+)\)\s*$/);
        return m ? parseFloat(m[1]) : 1;
      };
      const lamp = document.querySelector('#status .seal');
      return alpha(getComputedStyle(lamp).color) === 1
        && getComputedStyle(lamp.querySelector('.shackle')).transform
             === 'none'
        && !!lamp.querySelector('.lockbody')
        && !!lamp.querySelector('.keyhole');
    }), 'the drawn padlock lamp reads full-ink while sealed, its'
       + ' shackle seated on the body');
    ok(await alice.evaluate(() =>
      document.querySelectorAll('#tiles .tu').length === 2
      && document.querySelector('.tile[data-snym="alice"] .tu.selected')
      && !document.querySelector('.tile[data-snym="bob"] .tu.selected')),
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
    await alice.hover('.tile[data-snym="bob"] .x');
    ok(await alice.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--err-fg)';
      document.body.append(probe);
      const danger = getComputedStyle(probe).color;
      probe.remove();
      return getComputedStyle(
        document.querySelector('.tile[data-snym="bob"] .x')).color === danger;
    }), 'the trailing × reddens on hover: reads as "remove this row"');

    ok(await alice.evaluate(() =>
      document.querySelector('#status .th-person').textContent
        .includes('PARTICIPANTS')
      && !!document.querySelector('#status .th-bid #seal')
      && !document.querySelector('#status .th-person [data-tip]')),
       'column headings lead the section; padlock with BIDS, tip with'
       + ' PARTICIPANTS');

    // each ledger line is a FIELD and a CARD, the line itself
    // borderless; flex-start (not stretch) so a wrapped bid grows its
    // own card while the one-line field holds its height
    ok(await alice.evaluate(() => {
      const t = document.querySelector('#tiles .tile');
      const name = getComputedStyle(t.querySelector('.tile-name'));
      const bid = getComputedStyle(t.querySelector('.tile-bid'));
      return getComputedStyle(t).borderBottomWidth === '0px'
        && getComputedStyle(t).alignItems === 'flex-start'
        && name.borderTopWidth === '2px' && bid.borderTopWidth === '0px';
    }), 'a field for the person, a card for the bid, and a tall bid'
       + ' cannot inflate its neighbor');

    /* [FLIPPED twice: 2026-07-17 to blur-commits per frictionless-
       add; 2026-07-27 back — blur commits NOTHING (cletus's clobber).
       A typed name now WAITS with its SAVE, and the star click lands
       trivially: no hidden write, no rebuild mid-gesture.] */
    await alice.type('#roster-input', 'carol');
    await alice.click('.tile[data-snym="bob"] .tu');  // a radio switch
    await alice.waitForSelector('.tile[data-snym="bob"].mine',
                                { timeout: 2000 });
    ok(true, 'clicking a star works even mid-add: no hidden write, no'
       + ' rebuild, nothing to swallow the click');
    await new Promise((r) => setTimeout(r, 150));
    ok(await alice.evaluate(() =>
      !document.querySelector('.tile[data-snym="carol"]')
      && document.getElementById('roster-input').value === 'carol'
      && getComputedStyle(document.getElementById('roster-go'))
           .display !== 'none'),
       'and the tapped-away name is NOT committed: it waits in the'
       + ' + row, SAVE standing (the finger taps the button now)');
    await alice.click('#roster-go');
    await alice.waitForSelector('.tile[data-snym="carol"]');
    ok(await alice.$eval('#roster-input', (e) => e.value) === '',
       'SAVE lands carol and clears the row for the next name');
    await alice.click('.tile[data-snym="carol"] .x');  // tidy the scene
    await alice.waitForFunction(() =>
      !document.querySelector('.tile[data-snym="carol"]'));
    await alice.click('.tile[data-snym="alice"] .tu');  // and back
    await alice.waitForSelector('.tile[data-snym="alice"].mine');

    ok(await alice.evaluate(() =>
      document.activeElement === document.querySelector('.tile.mine .rebid textarea')),
       'claiming your row drops you straight into the bid editor');
    ok(await alice.evaluate(() => {
      const mine = document.querySelector('.tile.mine .tile-name');
      const other = document.querySelector(
        '.tile:not(.mine):not(.has-bid) .tile-name');
      return getComputedStyle(mine).animationName === 'none'
        && getComputedStyle(mine).boxShadow === 'none'
        && getComputedStyle(other).animationName === 'breathe-ink';
    }), 'others pulse (awaited); your row sits still');
    ok(await alice.evaluate(() =>
      getComputedStyle(document.querySelector('.tile.mine .rebid textarea'))
        .boxShadow !== 'none'),
       'the pop rides your bid editor (the person field stays flat)');
    // the empty editor invites with the caret, not words: no
    // placeholder, a normal solid field, focus already in it — and
    // never a pulse (pulsing means "waiting on THEM")
    ok(await alice.$eval('.tile.mine .rebid textarea',
        (e) => e.placeholder === ''), 'the editor holds no placeholder');
    ok(await alice.evaluate(() => {
      const e = document.querySelector('.tile.mine .rebid textarea');
      return getComputedStyle(e).animationName === 'none'
        && getComputedStyle(e).borderTopStyle === 'solid'
        && document.activeElement === e;
    }), 'your empty editor: a normal solid field, focused, not pulsing');
    // Editing a name highlights the FIELD: the person cell wears the
    // + row's ring recipe — the underline special case is retired
    // (dreev 2026-07-27: "shouldn't the field just highlight
    // itself?"). No SAVE exists here at all: snyms blur-commit
    // (dreev 2026-07-28, the commit taxonomy).
    await alice.click('.tile[data-snym="bob"] .rename input');
    ok(await alice.evaluate(() => {
      const cell = document.querySelector(
        '.tile[data-snym="bob"] .tile-name');
      const inp = cell.querySelector('.rename input');
      return getComputedStyle(cell).outlineWidth === '2px'
        && getComputedStyle(cell).outlineStyle === 'solid'
        && getComputedStyle(inp).boxShadow === 'none'
        && !document.querySelector(
               '.tile[data-snym="bob"] .rename .go');
    }), 'editing a name rings the person cell itself, star lassoed'
       + ' like the + row rings its @ — no underline, and no SAVE:'
       + ' a name field commits by leaving');
    await alice.keyboard.type('by');
    await alice.click('.legend');  // wander off mid-edit: THE commit
    await alice.waitForSelector('.tile[data-snym="bobby"]');
    ok(true, 'wandering off an edited name COMMITS it: cheap label'
       + ' edits are frictionless (dreev 2026-07-28)');
    await alice.click('.tile[data-snym="bobby"] .rename input');
    await alice.keyboard.press('End');
    await alice.keyboard.type('xx');
    await alice.keyboard.press('Escape');  // never mind, pre-blur
    await new Promise((r) => setTimeout(r, 300));
    ok(await alice.evaluate(() =>
      document.querySelector('.tile[data-snym="bobby"] .rename input')
        .value === 'bobby'),
       "Escape still means never-mind: its revert lands before the"
       + ' blur, which then finds a clean field and commits nothing');
    // bob is bobby now; put him back for the legs below
    await alice.click('.tile[data-snym="bobby"] .rename input');
    await alice.$eval('.tile[data-snym="bobby"] .rename input',
      (e) => { e.value = ''; });
    await alice.keyboard.type('bob');
    await alice.keyboard.press('Enter');
    await alice.waitForSelector('.tile[data-snym="bob"]');
    /* Replicata (dreev 2026-07-28: "red outline on snym doesn't
       match the field at all"): rename bob onto a taken name; the
       refusal reddens. Expectata: the ring wraps the person CELL —
       the visible box, where the focus ring lives — not the
       borderless input inside it. */
    await alice.click('.tile[data-snym="bob"] .rename input');
    await alice.$eval('.tile[data-snym="bob"] .rename input',
      (e) => { e.value = ''; });
    await alice.keyboard.type('alice');  // taken: the guard refuses
    await alice.click('.legend');        // the blur-commit
    await alice.waitForFunction(() =>
      !document.getElementById('banner').hidden);
    ok(await alice.evaluate(() => {
      const cell = document.querySelector(
        '.tile[data-snym="bob"] .tile-name');
      const inp = cell.querySelector('input');
      return getComputedStyle(cell).outlineStyle === 'solid'
        && getComputedStyle(cell).filter.includes('drop-shadow')
        && getComputedStyle(inp).outlineStyle === 'none';
    }), 'the name objection rings the person CELL, the visible box —'
       + ' never the borderless input inside it');
    await alice.click('.tile[data-snym="bob"] .rename input');
    await alice.keyboard.press('Escape');  // never mind; tidy the scene
    await alice.evaluate(() =>
      document.getElementById('banner-x').click());
    await bid(alice, 'three tacos');
    await alice.waitForSelector('#tiles .tile.has-bid');
    ok(await alice.$eval('.tile.mine .rebid textarea', (e) => e.value)
       === 'three tacos', 'her bid lives in her row, editable in place');
    ok(await alice.evaluate(() =>
      getComputedStyle(document.querySelector('.tile.mine .rebid textarea'))
        .animationName === 'none'),
       'no pulse with the bid in either: only not-you rows ever pulse');
    ok(await alice.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--ok-fg)';
      document.body.append(probe);
      const green = getComputedStyle(probe).color;
      probe.remove();
      return getComputedStyle(document.querySelector(
        '.tile.has-bid .tile-name')).color === green;
    }), 'the bid-in signal speaks in ink: the name text itself goes'
       + ' green');
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
      cell.dispatchEvent(new Event('mouseover', { bubbles: true }));
      return /^your bid submitted \d+s ago$/.test(cell.dataset.tip);
    }), 'hovering her bid cell tells her when she submitted');
    ok(await alice.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--star)';
      document.body.append(probe);
      const gold = getComputedStyle(probe).color;
      probe.style.color = 'var(--star-rim)';
      const rim = getComputedStyle(probe).color;
      probe.remove();
      const star = document.querySelector('.tile.mine .tu');
      const other = document.querySelector('.tile:not(.mine) .tu');
      return star.classList.contains('selected')
        && getComputedStyle(star).color === gold
        // the rim is its own gold (arcade 2026-08-06: fill-gold
        // stroke vanished into white cards), same silhouette width
        && getComputedStyle(star).webkitTextStrokeColor === rim
        && getComputedStyle(star).webkitTextStrokeWidth
           === getComputedStyle(other).webkitTextStrokeWidth
        && getComputedStyle(star).textShadow !== 'none';
    }), 'her star glows gold — the exact hollow shape, filled: same'
       + ' stroke width, rim-gold stroke plus gold fill');
    await alice.hover('.tile.mine .tu');
    await alice.waitForFunction(() =>
      !document.getElementById('tip').hidden);
    ok(await alice.evaluate(() => {
      const cs = getComputedStyle(document.getElementById('tip'));
      return cs.textShadow === 'none'
        && parseFloat(cs.webkitTextStrokeWidth || '0') === 0;
    }), "the star's glow stays OUT of its tooltip: the singleton"
       + ' lives at body level and inherits nothing from any host');
    ok(await alice.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--star)';
      document.body.append(probe);
      const gold = getComputedStyle(probe).color;
      probe.remove();
      return getComputedStyle(document.querySelector('#status .legend'),
        '::first-letter').color === gold;
    }), "the legend's star is the same gold as a lit one");
    ok(await alice.evaluate(() => {
      const r = document.createRange();
      const legend = document.querySelector('#status .legend');
      r.setStart(legend.firstChild, 0);
      r.setEnd(legend.firstChild, 1);
      const key = r.getBoundingClientRect();
      const star = document.querySelector('.tile.mine .tu')
        .getBoundingClientRect();
      return Math.abs((key.left + key.right) / 2
        - (star.left + star.right) / 2) < 2;
    }), "the legend's star sits on the identity-control axis");
    ok(await alice.evaluate(() =>
      ['#tiles .tile.has-bid .x', '#reveal'].every((sel) => {
        // dreev's bug: opacity on a grayed control dimmed its tooltip
        // AND opened a stacking context that painted it behind the
        // rows below; graying must never touch the tooltip's host
        const el = document.querySelector(sel);
        const cs = getComputedStyle(el);
        return el.disabled && cs.opacity === '1' && cs.filter === 'none'
          && cs.transform === 'none';
      })), 'grayed controls stay full-strength tooltip hosts');
    await alice.hover('#tiles .tile.has-bid .x');
    await alice.waitForFunction(() =>
      !document.getElementById('tip').hidden);
    ok(true, "the disabled ×'s tooltip shows at full strength");
    ok(await alice.evaluate(() => {
      const edges = [...document.querySelectorAll('#tiles .tile')].map((t) =>
        t.querySelector('.bid-card, .rebid textarea')
          .getBoundingClientRect().right);
      return edges.every((e) => Math.abs(e - edges[0]) < 1);
    }), 'every bid box matches length: one right edge down the column');

    await alice.reload({ waitUntil: 'networkidle0' });
    await alice.waitForSelector('.tile.mine .rebid textarea');
    ok(await alice.$eval('.tile.mine .rebid textarea', (e) => e.value)
       === 'three tacos', 'identity and bid survive reload');

    // phone ergonomics: every tooltip in the app fits on screen, nothing
    // scrolls sideways
    const tipCount = await alice.$$eval('[data-tip]',
      (l) => l.length);
    ok(tipCount >= 5, 'tooltips present on tips, buttons, and rows');
    for (let i = 0; i < tipCount; i++) {
      const b = await alice.evaluate(async (idx) => {
        const host = document.querySelectorAll('[data-tip]')[idx];
        host.scrollIntoView({ block: 'center' });
        const r0 = host.getBoundingClientRect();
        // aim at the CENTER: a corner probe misses hosts with big
        // border radii (the arcade pill's +3,+3 point is outside
        // the shape, so elementFromPoint saw the card behind)
        document.dispatchEvent(new MouseEvent('mousemove',
          { clientX: r0.left + r0.width / 2,
            clientY: r0.top + r0.height / 2 }));
        await new Promise((r) => setTimeout(r, 80));  // async positioning
        const t = document.getElementById('tip').getBoundingClientRect();
        return { host: host.className || host.tagName, top: t.top,
                 left: t.left, w: t.width, h: t.height,
                 vw: innerWidth, vh: innerHeight,
                 hid: document.getElementById('tip').hidden };
      }, i);
      ok(!b.hid && b.top >= 0 && b.left >= 0 && b.left + b.w <= b.vw
         && b.top + b.h <= b.vh,
         'tooltip ' + i + " fits the phone viewport (Floating UI's"
         + ' flip+shift): ' + JSON.stringify(b));
    }
    // only one tooltip EXISTS now (the singleton): hover wins it
    await alice.hover('.field label[data-tip]');
    await alice.waitForFunction(() =>
      !document.getElementById('tip').hidden
      && document.getElementById('tip').textContent ===
         document.querySelector('.field label[data-tip]')
           .getAttribute('data-tip'));
    ok(true, 'one tooltip at a time, by construction: the singleton'
       + ' shows whatever is summoned last');
    // ...and when the hover leaves, a focus-PARKED tip resumes (the
    // old CSS behaved this way; the singleton must too)
    await alice.evaluate(() =>
      document.querySelector('label[for="slug"]').focus());
    await alice.hover('.tile:not(.mine) .tu');  // hover wins...
    await alice.waitForFunction(() =>
      !document.getElementById('tip').hidden
      && document.getElementById('tip').textContent
         !== document.querySelector('label[for="slug"]')
              .getAttribute('data-tip'));
    await alice.mouse.move(5, 700);  // ...and leaves
    await alice.waitForFunction(() =>
      !document.getElementById('tip').hidden
      && document.getElementById('tip').textContent
         === document.querySelector('label[for="slug"]')
              .getAttribute('data-tip'));
    ok(true, 'hover gone: the focus-parked tip takes the stage back');
    await alice.evaluate(() =>
      document.querySelector('label[for="slug"]').blur());
    await alice.mouse.move(5, 400);  // park the pointer away from any tip
    await alice.keyboard.press('Tab');  // blur the last tooltip
    const overflow = await alice.evaluate(() =>
      document.scrollingElement.scrollWidth - window.innerWidth);
    ok(overflow <= 0, 'no horizontal overflow on phone (' + overflow + 'px)');
    await alice.setViewport(NARROW);
    await alice.waitForFunction(() => innerWidth === 320);
    // a parked tip refits on resize ASYNCHRONOUSLY (showTip awaits
    // Floating UI): wait out the refit rather than sampling the beat
    // between the narrow and its landing — a real overflow fails
    // this wait loudly by timeout
    await alice.waitForFunction(() =>
      document.scrollingElement.scrollWidth <= innerWidth);
    const narrowLegs = await alice.evaluate(() => {
      const near = (a, b) => Math.abs(a - b) < 1;
      const textLeft = (e) => {
        const r = document.createRange();
        r.selectNode(e.firstChild);
        return r.getBoundingClientRect().left;
      };
      const row = document.querySelector('#tiles .tile');
      const name = row.querySelector('.tile-name').getBoundingClientRect();
      const nameStyle = getComputedStyle(row.querySelector('.tile-name'));
      const whoText = name.left + parseFloat(nameStyle.borderLeftWidth)
        + parseFloat(nameStyle.paddingLeft);
      const add = document.querySelector('.addrow .at-wrap')
        .getBoundingClientRect();
      const bid = row.querySelector('.bid-card, .rebid textarea');
      const box = bid.getBoundingClientRect();
      const css = getComputedStyle(bid);
      const bidText = box.left + parseFloat(css.borderLeftWidth)
        + parseFloat(css.paddingLeft);
      const thBid = document.querySelector('.th-bid');
      const bad = [];  // each failed leg NAMES itself with its numbers
      if (document.scrollingElement.scrollWidth > innerWidth) {
        const wide = [...document.querySelectorAll('*')]
          .filter((e) => e.getBoundingClientRect().right > innerWidth)
          .slice(0, 5)
          .map((e) => e.tagName + '#' + e.id + '.' + e.className + '@'
            + Math.round(e.getBoundingClientRect().right));
        bad.push('sideways scroll ' + document.scrollingElement.scrollWidth
          + ' > ' + innerWidth + ' [' + wide.join(', ') + ']');
      }
      if (thBid.scrollWidth > thBid.clientWidth + 1) {
        bad.push('th-bid clipped ' + thBid.scrollWidth + ' > '
          + thBid.clientWidth);
      }
      // ROOMY + ALIGNED (dreev 2026-08-10, second ruling: "i just
      // want it to look nicer"): at truly-skinny widths the name
      // column and its header are FIXED-EQUAL and the header reads
      // PARTIC. — so the bid column keeps its floor AND the axes
      // hold again (the earlier waiver un-waived)
      if (box.width < 6 * parseFloat(getComputedStyle(
            document.documentElement).fontSize)) {
        bad.push('bid box starved at ' + box.width + 'px');
      }
      const tight = document.querySelector('.th-person .th-tight');
      if (!tight || tight.getBoundingClientRect().width === 0) {
        bad.push('tight header label not shown');
      } else {
        if (!near(textLeft(document.querySelector('.th-person')
              .querySelector('.th-tight')), whoText)) {
          bad.push('person axis (tight) vs ' + whoText);
        }
        if (!near(textLeft(thBid), bidText)) {
          bad.push('bid axis ' + textLeft(thBid) + ' vs ' + bidText);
        }
        if (!near(add.left, name.left) || !near(add.right, name.right)) {
          bad.push('add-row edges ' + [add.left, name.left, add.right,
            name.right].join('/'));
        }
      }
      return bad;
    });
    ok(narrowLegs.length === 0,
       'at 320px the same text axes hold, both fields stay usable,'
       + ' and nothing scrolls sideways — ' + narrowLegs.join('; '));
    await shoot(alice, 'story1-alice-narrow');
    await alice.hover('.tile:not(.mine) .tu');
    await alice.waitForFunction(() =>
      !document.getElementById('tip').hidden);
    ok(await alice.$eval('#tip', (e) => {
      const r = e.getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth;
    }), 'the star moved left and its tooltip still fits at 320px');
    await alice.setViewport(PHONE);
    await alice.waitForFunction(() => innerWidth === 390);
    await alice.mouse.move(5, 400);
    // the earlier Tab parked focus on the pencil, whose version tip
    // (dreev's bver spec) legitimately stays while focused —
    // drop the focus so no summons stands, then the tip must hide
    await alice.evaluate(() => document.activeElement.blur());
    await alice.waitForFunction(() =>
      document.getElementById('tip').hidden);
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

    /* The Copied! beat, per the design-system consensus (GitHub
       Primer, Shoelace, HashiCorp Helios — golem item 6, dreev
       2026-07-27): on success the button ITSELF is the confirmation —
       success green, its label swapped to real Copied! text, natively
       disabled (a status is not a clickable button), same width (no
       jiggle) — then it reverts on its own beat, clickable again. A
       persistent role="status" region echoes the confirmation for
       screen readers (CSS-generated or display-toggled text doesn't
       announce reliably; every design system documents this part). */
    await alice.bringToFront();  // clipboard writes need a focused document
    const idleWidth = await alice.$eval('#copy',
      (b) => b.getBoundingClientRect().width);
    await alice.click('#copy');
    await alice.waitForFunction(() =>
      document.getElementById('copy').classList.contains('copied'));
    const clip = await alice.evaluate(() => navigator.clipboard.readText());
    ok(clip === shareUrl, 'copy button puts the URL on the clipboard: ' + clip);
    ok(await alice.evaluate(() => {
      const b = document.getElementById('copy');
      return getComputedStyle(b.querySelector('.copy-label'))
          .visibility === 'hidden'
        && getComputedStyle(b.querySelector('.copy-done'))
          .visibility === 'visible';
    }), 'the confirmation replaces the button label rather than appending');
    ok(await alice.$eval('#copy', (b) => b.disabled),
       'while it says Copied! it is NOT a clickable button');
    ok(await alice.$eval('#copy',
        (b) => b.getBoundingClientRect().width) === idleWidth,
       'the label swap never changes the button\'s size');
    ok(await alice.$eval('#copy-status', (e) =>
        e.getAttribute('role') === 'status' && /Copied/.test(e.textContent)),
       'the role=status region echoes the confirmation to screen readers');
    await shoot(alice, 'share-dialog');

    /* ...and the beat ends on its own: Copied! retires, the button
       comes back live at the same size, and a second click copies
       again. (Resultata pre-fix: Copied! stuck until the dialog
       reopened.) */
    await alice.waitForFunction(() =>
      !document.getElementById('copy').classList.contains('copied'),
      { timeout: 5000 });
    ok(await alice.$eval('#copy', (b) => !b.disabled
         && getComputedStyle(b.querySelector('.copy-label'))
           .visibility === 'visible'),
       'the Copied! moment passes on its own: the button is back');
    ok(await alice.$eval('#copy-status', (e) => e.textContent === ''),
       'the screen-reader echo clears with it');
    await alice.click('#copy');
    await alice.waitForFunction(() =>
      document.getElementById('copy').classList.contains('copied'));
    ok(await alice.evaluate(() => navigator.clipboard.readText())
         === shareUrl,
       'a second click copies again: the button came back live');

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
       Expectata: popup gone, and focus NOT restored to the ? button
       (that restore used to re-stick its focus-tooltip; the ? lost
       its tip 2026-07-17 but the blur-before-showModal mechanism
       still guards every tipped button). */
    await alice.click('#help');
    await alice.waitForFunction(() => document.getElementById('help-dlg').open);
    await alice.mouse.click(10, 500);  // the backdrop, far from the box
    await alice.waitForFunction(() => !document.getElementById('help-dlg').open);
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
    /* ---- (the universal tooltip-host hygiene sweep RETIRED
       2026-07-18: the singleton #tip lives at body level and is not
       a descendant of any host — ancestor stacking contexts can no
       longer bury tips, by construction. dreev-directed via the
       switch to Floating UI.) ---------------------------------- */
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
      const taken = document.querySelector('.tile[data-snym="alice"] .tu');
      const plain = document.querySelector('.tile[data-snym="bob"] .tu');
      // (the bond, dreev 2026-08-14: alice has BID, so her star is
      // dead for everyone else — the fill and tip carry the message;
      // bob's bidless star stays live)
      return taken.disabled && !plain.disabled
        && getComputedStyle(taken).opacity === '1'
        && alpha(getComputedStyle(taken).color) > 0.5
        && alpha(getComputedStyle(plain).color) === 0
        && taken.getAttribute('data-tip')
             === claimedByTip('Mac Chrome ' + navigator.language
                              + ' in Portland, OR' + orByTimezone
                              + tzcity(Intl.DateTimeFormat()
                                  .resolvedOptions().timeZone));
    }), "alice's star fills in on bob's screen — claimed by someone"
       + ' else, says the tip, naming the anym — while open seats stay'
       + ' hollow');
    ok(await bob.evaluate(() => getComputedStyle(
         document.querySelector('#status .seal .shackle')).transform)
       .then((t) => t === 'none'), 'closed padlock while sealed');
    await shoot(bob, 'story2-bob-sealed');

    await claimRow(bob, 'bob');
    // the desktop cousin of the stuck-tip bug: the mouse rests right
    // where you clicked, so the cell you are TYPING in hovered a tip
    // under your editor — a focused editor's cell keeps its counsel
    await bob.hover('.tile.mine .tile-bid');
    ok(await bob.evaluate(() =>
         document.activeElement === document.querySelector(
           '.tile.mine .rebid textarea')
         && document.getElementById('tip').hidden),
       'no tooltip under your own typing: a bid cell holding your'
       + ' focused editor shows no tip even hovered');
    await bid(bob, 'my entire kingdom');
    await bob.waitForFunction(() =>
      document.querySelectorAll('#tiles .tile.has-bid').length === 2);
    ok(!(await text(bob, '#status')).includes('three tacos'),
       'complete but sealed: nothing reveals without a press');
    await bob.waitForFunction(() => !document.getElementById('reveal').disabled);
    opDelay = 900;  // the reveal round-trips like everything else
    ok(await bob.evaluate(() => {
      const rv = getComputedStyle(document.getElementById('reveal'));
      return rv.animationName === 'armglow' && rv.transform === 'none'
        && rv.opacity === '1' && rv.filter === 'none'
        && getComputedStyle(document.querySelector(
             '#status .seal .shackle')).transform === 'none';
    }),
       'the armed REVEAL button glow-pulses for attention — shadow'
       + ' only, never opening a stacking context under its tooltip —'
       + ' and the lamp holds its shackle shut');
    await bob.click('#reveal');
    await bob.waitForFunction(() => {  // 0.15s fade: wait, don't sample
      const g = document.querySelector('#status > .gavel');
      return getComputedStyle(g).opacity === '1';
    });
    ok(true, 'the big gavel hammers while the reveal is in flight —'
       + ' pressing REVEAL visibly DOES something');
    opDelay = 0;
    await bob.waitForFunction(() =>
      document.getElementById('status').textContent.includes('three tacos'));
    // universal button hygiene (dreev keeps catching stragglers): an
    // ACTIVATED button holds no focus — and the revealed seal wears
    // no tip at all now (dreev: obvious is obvious)
    await bob.mouse.move(10, 600);
    ok(await bob.evaluate(() =>
      document.activeElement !== document.getElementById('reveal')),
       "pressing REVEAL doesn't leave its tooltip stuck (the"
       + ' universal blur-on-activation rule)');
    ok(await bob.evaluate(() =>
      getComputedStyle(document.getElementById('reveal')).display
        === 'none'
      && getComputedStyle(document.getElementById('closed')).display
        !== 'none'),
       'the thrown switch yields its slot to the Closed stamp');
    ok(await bob.$eval('.tile.mine .rebid textarea', (e) => e.value)
       === 'my entire kingdom',
       "pressing REVEAL reveals everything: alice's card + his own row");
    ok(await bob.$eval('.tile.mine .rebid textarea', (e) => e.disabled),
       'the gavel drop is a bright line: the editor goes dead at the'
       + ' reveal');
    /* Replicata (dreev's screenshot): his own revealed bid rendered
       GRAY — the dead editor wears the UA's disabled wash while
       everyone else's card reads in full ink. The record is not gray
       history. And the whole CLASS closes: NO rendered text on any
       disabled control may wear the UA wash (the grayed-🎉 bug's
       family; our own dims always set an explicit color). */
    ok(await bob.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--fg)';
      document.body.append(probe);
      const ink = getComputedStyle(probe).color;
      probe.remove();
      const s = getComputedStyle(document.querySelector(
        '.tile.mine .rebid textarea'));
      return s.color === ink && s.opacity === '1';
    }), 'your own revealed bid reads in FULL ink — color AND opacity'
       + ' (the 0.6 relic dimmed what color alone could not reveal)');
    ok(await bob.evaluate(() => {
      const washed = [];
      document.querySelectorAll(':disabled').forEach((el) => {
        if (!(el.value || el.textContent || '').trim()) return;
        const s = getComputedStyle(el);
        if (s.color === 'rgba(16, 16, 16, 0.3)' || s.opacity !== '1') {
          washed.push((el.className || el.id) + ' opacity:' + s.opacity);
        }
      });
      return washed.length ? washed.join(';') : true;
    }) === true,
       "no rendered control anywhere wears the UA's disabled wash:"
       + ' dimming is always ours, never the browser default');
    // the flip now rides the STRIKE's beat (dreev lined up SOLD and
    // the tada), so wait for it rather than sampling the wind-up
    await bob.waitForFunction(() => getComputedStyle(
      document.querySelector('#status .seal .shackle')).transform
        !== 'none');
    ok(true,
       'the shackle swings open at the strike: one lamp, two states');
    ok(await bob.evaluate(() => {
      const alpha = (c) => {
        const m = c.match(/(?:rgba\([^)]+,\s*|\/\s*)([\d.]+)\)\s*$/);
        return m ? parseFloat(m[1]) : 1;
      };
      return alpha(getComputedStyle(
        document.querySelector('#status .seal')).color) === 1;
    }), 'the open lamp reads full-ink: a span, never a disableable'
       + ' control, so no UA sheet can ever wash it');
    // The ceremony is a transient: gate on its LOUDEST early moment
    // (canvas-confetti mounts its canvas at the strike) and assert
    // everything else in that same beat — sampling at the tail flaked
    // when a loaded machine ate the window
    await bob.waitForFunction(() =>
      document.querySelector('body > canvas'));
    ok(await bob.evaluate(() => {
      const g = document.querySelector('#status > .gavel');
      const st = document.querySelector('#status .fete .stamp');
      const cv = document.querySelector('body > canvas');
      const box = cv.getBoundingClientRect();
      return getComputedStyle(g.querySelector('.mallet')).animationName
             === 'gavel-verdict'
        && getComputedStyle(g).animationName === 'gavel-vanish'
        && st && getComputedStyle(st).animationName === 'stamp-slam'
        && getComputedStyle(document.querySelector(
             '#status .seal .shackle')).transform !== 'none'
        && getComputedStyle(cv).position === 'fixed'
        && getComputedStyle(cv).pointerEvents === 'none'
        && box.width === window.innerWidth
        && box.height === window.innerHeight;
    }), 'one ceremonial gavel stroke, SOLD slammed on the bid box, and'
       + ' real-physics money (vendored canvas-confetti, the calpuz'
       + ' recipe) raining on a fixed whole-viewport canvas');
    // let the volley bloom, then a viewport shot for eyeballing
    await new Promise((r) => setTimeout(r, 500));
    await bob.screenshot({
      path: path.join(SHOTS, 'story3-ceremony-sky.png') });
    await bob.waitForFunction(() =>  // its work done, the gavel bows
      getComputedStyle(document.querySelector('#status > .gavel'))
        .opacity === '0'
      && document.querySelector('#status .fete .stamp'));
    ok(true, 'the gavel disappears right after SOLD is down (dreev),'
       + ' leaving the stamp the stage');
    ok(await bob.evaluate(() =>
      getComputedStyle(document.querySelector('.addrow')).display
        === 'none'
      && getComputedStyle(document.querySelector('#status .closed'))
           .display !== 'none'
      && /^Closed /.test(document.querySelector('#status .closed')
           .textContent)),
       'the + row retires at the reveal; the Closed stamp takes its'
       + ' place');
    ok(await bob.evaluate(() => {
      const textLeft = (e) => {
        const r = document.createRange();
        r.selectNode(e.firstChild);
        return r.getBoundingClientRect().left;
      };
      // (the 2026-08-10 gavel glyph came and went, dreev's call;
      // the stamp TEXT owns the axis, at the tombstone row's rail)
      return Math.abs(textLeft(document.querySelector('.th-person'))
        - textLeft(document.querySelector('#status .closed'))) < 1;
    }), 'the Closed stamp starts on the participant-text axis');
    await bob.waitForFunction(() =>  // the ceremony self-cleans (the
      // confetti canvas is the library's own; it lingers, inert and
      // invisible, until the last long-lived piece times out)
      !document.querySelector('#status .fete'), { timeout: 6000 });
    ok(true, 'the ceremony packs up after itself');
    ok(await bob.$eval('#reveal', (e) => e.getAttribute('data-tip'))
       === null,
       'the revealed tada wears NO tip at all (dreev: obvious is'
       + ' obvious)');
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
    await alice.evaluate(() => { document.getElementById('slug').value = ''; });
    // [names-are-chosen-once 2026-07-18: alice travels by URL now]
    await alice.goto(BASE + '/chores', { waitUntil: 'networkidle0' });
    ok(true, 'the URL is the navigation: /chores');
    await addName(alice, 'dee');
    await addName(alice, 'evy');
    await alice.waitForFunction(() =>
      document.querySelectorAll('#tiles .tile').length === 2
      && !!document.querySelector('.tile[data-snym="evy"]'));
    ok(true, 'empty rows appear for @dee and @evy');
    ok(await alice.evaluate(() =>
      !document.querySelector('.tile.mine')
      && document.querySelectorAll('#tiles .tu').length === 2),
       'alice is nobody here until her name is on the ledger');

    await addName(alice, 'alice');
    await alice.waitForSelector('.tile.mine .rebid textarea');
    ok(true, 'adding her remembered name back re-latches automatically');
    await bid(alice, 'sweep the porch');
    await alice.waitForFunction(() =>
      document.querySelector('.tile[data-snym="alice"]')
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
      const evy = document.querySelector('.tile[data-snym="evy"]');
      return evy && !evy.classList.contains('has-bid');
    }), "alice sees @evy's row still hollow");
    ok(await alice.evaluate(() =>
      document.querySelector('#tiles .tile.has-bid .x').disabled
      && !document.querySelector('.tile[data-snym="evy"] .x').disabled),
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

    // Another machine's zed walks on with a bid (his × grays at once:
    // a bid protects its seat — removal of a bidder no longer exists,
    // dreev 2026-07-19); then alice ends early: × the bidless
    // straggler right off the ledger.
    gas.handle({ action: 'bid', slug: 'chores',
      snym: 'zed', usid: 'usid-chores-zed',
                 xbid: 'zed was here' });
    await alice.waitForFunction(() =>
      document.querySelector('.tile[data-snym="zed"]'));
    ok(await alice.evaluate(() =>
      document.querySelector('.tile[data-snym="zed"] .x').disabled),
       "the walk-on's bid grays his × on arrival: a bid protects its"
       + ' seat');
    await alice.click('.tile[data-snym="evy"] .x');
    await alice.waitForFunction(() => !document.getElementById('reveal').disabled);
    await alice.click('#reveal');
    await alice.waitForFunction(() =>
      document.getElementById('status').textContent.includes('i bid 2 dishes'));
    ok(true, '× the straggler, press the padlock: end-early');
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
    await carol.waitForSelector('.tile[data-snym="cat"]');
    opDelay = 400;
    await addName(carol, 'dog');  // its ack lands mid-gesture below
    const starBox = await (await carol.$('.tile[data-snym="dog"] .tu'))
      .boundingBox();
    await carol.mouse.move(starBox.x + starBox.width / 2,
                           starBox.y + starBox.height / 2);
    await carol.mouse.down();
    await new Promise((r) => setTimeout(r, 700));  // ack + render land
    opDelay = 0;
    await carol.mouse.up();
    await carol.waitForSelector('.tile[data-snym="dog"].mine .rebid textarea',
                                { timeout: 2000 });
    ok(true, 'a click straddling an op-ack render still lands (the very'
       + ' row whose ack was in flight)');

    /* ---- re-bid stacks and the you-row pop share box-shadow: both
       must survive composition (carol switched to dog in the gesture
       test above) ----------------------------------------------------- */
    await carol.waitForSelector('.tile.mine .rebid textarea');
    await bid(carol, 'one fish');
    await carol.waitForSelector('.tile.mine .rebid textarea.bid-card');
    await carol.$eval('.tile.mine .rebid textarea', (e) => { e.value = ''; });
    await bid(carol, 'two fish');
    await carol.waitForFunction(() =>  // one sheet: the 2px pair
      document.querySelector('.tile.mine .rebid textarea')
        .style.boxShadow.includes('2px 2px'));
    ok(await carol.evaluate(() =>
      (getComputedStyle(document.querySelector('.tile.mine .rebid textarea'))
        .boxShadow.match(/rgba?\(/g) || []).length >= 3),
       'the re-bid stack sheets and the you-pop compose, losing neither');

    /* ---- the busy gavel is for untrusted PICTURES only (dreev
       2026-07-28, the no-spinners ruling): a write in flight spins
       NOTHING — the commit pulse already said "yours is away", and
       failures banner. The one gavel hammers over the table only at
       arrival, transport failure, the name probe, and the reveal. */
    opDelay = 2500;
    await addName(carol, 'fox');  // an op is now in flight for ~2.5s
    await new Promise((r) => setTimeout(r, 600));  // past the 0.3s
                                    // appearance delay, mid-flight
    ok(await carol.evaluate(() =>
      // (the desc card's RESIDENT mini gavel is chrome — dreev's
      // option A — visible only during a desc save; a slow ADD
      // must leave it dark)
      [...document.querySelectorAll('.gavel.mini')].every((g) =>
        g.closest('#desc')
        && getComputedStyle(g).opacity === '0')
      && !document.querySelector('#tiles .tile.stale')
      && !document.getElementById('status').classList.contains('stale')
      && getComputedStyle(document.querySelector('#status > .gavel'))
        .opacity === '0'
      && document.querySelector('.tile[data-snym="fox"]') !== null),
       'a slow add spins NO gavel and grays nothing: the optimistic'
       + ' row just stands');
    ok(await carol.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--wood)';
      document.body.append(probe);
      const wood = getComputedStyle(probe).color;
      probe.remove();
      const head = getComputedStyle(  // (#status-scoped: the desc
        // card's mini gavel sits earlier in the DOM now)
        document.querySelector('#status > .gavel .head')).backgroundColor;
      const spin = document.styleSheets;  // (the 360 lives in keyframes)
      return head === wood;
    }), 'the gavel is wood, as gavels are');
    ok(await carol.evaluate(() =>
      getComputedStyle(document.querySelector('#status > .gavel .grip'),
                       '::after')
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
      const bang = document.querySelector('#status > .gavel .bang');
      const sin = (cs) => parseFloat(cs.transform.split(',')[1]);
      return [getComputedStyle(bang, '::before'),
              getComputedStyle(bang.firstElementChild),
              getComputedStyle(bang, '::after')]
        .every((cs) => sin(cs) < 0);
    }), 'all three spark rays kick up and away from the impact');

    opDelay = 0;
    await carol.waitForFunction(() =>  // fades out: wait, don't sample
      getComputedStyle(document.querySelector('#status .gavel'))
        .opacity === '0');
    ok(true, 'the gavel rests once the server has confirmed everything');
    /* ---- a bid in flight likewise spins nothing (no-spinners): its
       volley bookkeeping (.busy) stays, invisible, for the A-B-A
       resubmit semantics and the grayed same-text SUBMIT ---- */
    opDelay = 1200;
    await carol.$eval('.tile.mine .rebid textarea', (e) => { e.value = ''; });
    await bid(carol, 'three fish');
    await new Promise((r) => setTimeout(r, 500));  // mid-flight
    ok(await carol.evaluate(() =>
      document.querySelector('.rebid.busy')
      // (the desc card's resident mini gavel is CSS-dark chrome —
      // option A; a BID must leave it dark)
      && [...document.querySelectorAll('.gavel.mini')].every((g) =>
        g.closest('#desc') && getComputedStyle(g).opacity === '0')
      && getComputedStyle(document.querySelector('#status > .gavel'))
           .opacity === '0'
      && document.querySelector('.tile.mine .rebid .go').disabled),
       'a bid in flight: no gavel LIT anywhere — just the quietly'
       + ' grayed SUBMIT holding the words already on the wire');
    opDelay = 0;
    await carol.waitForFunction(() =>
      !document.querySelector('.rebid.busy'));
    ok(true, 'the volley settles invisibly');
    /* ---- names are live text fields: click in, type, enter ------------ */
    await carol.click('.tile[data-snym="fox"] .rename input');
    ok(await carol.evaluate(() => {
      // one focus language: the person CELL wears the ring, exactly
      // like the + row's wrapper (the stand-in underline retired,
      // dreev 2026-07-27)
      const probe = document.createElement('span');
      probe.style.color = 'var(--accent)';
      document.body.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      const cell = getComputedStyle(document.querySelector(
        '.tile[data-snym="fox"] .tile-name'));
      const inp = getComputedStyle(
        document.querySelector('.tile[data-snym="fox"] .rename input'));
      return cell.outlineStyle === 'solid' && cell.outlineWidth === '2px'
        && cell.outlineColor === accent
        && inp.outlineStyle === 'none' && inp.boxShadow === 'none';
    }), 'the focused name field highlights its whole cell in the'
       + ' focus accent, the at-wrap ring recipe');
    await carol.$eval('.tile[data-snym="fox"] .rename input',
                      (e) => e.select());
    await carol.keyboard.type('foxy');
    await carol.keyboard.press('Enter');
    await carol.waitForSelector('.tile[data-snym="foxy"]');
    ok(true, 'the name is just an editable field: type and enter renames');

    /* ---- error banners overlay; they never shift the page ------------- */
    const statusTop = await carol.evaluate(() =>
      document.getElementById('status').getBoundingClientRect().top);
    await carol.click('.tile[data-snym="dog"] .rename input');
    await carol.$eval('.tile[data-snym="dog"] .rename input',
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
       submission (the name fields are single-input forms) or the
       Enter keydown (the bid editor, the + row) — no physical Enter
       key, no mouse,
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
    await thumb.waitForSelector('.tile[data-snym="bo"]');
    ok(true, 'the + row takes names from the return key');
    await thumb.waitForSelector('.tile.mine .rebid textarea');
    ok(true, 'her first thumbed-in name is hers (2j): editor ready');
    await thumb.type('.tile.mine .rebid textarea', 'thumb-typed bid');
    await thumb.keyboard.press('Enter');
    await thumb.waitForSelector('.tile.mine.has-bid');
    ok(true, 'return submits the bid: the editor keydown, no'
       + ' button, no mouse');
    await thumb.tap('.tile[data-snym="bo"] .rename input');
    await thumb.$eval('.tile[data-snym="bo"] .rename input',
                      (e) => e.select());
    await thumb.keyboard.type('bob');
    await thumb.keyboard.press('Enter');
    await thumb.waitForSelector('.tile[data-snym="bob"]');
    ok(true, 'renaming works by thumb: tap, type, return');
    await thumb.type('#roster-input', 'oops');
    await thumb.keyboard.press('Enter');
    await thumb.waitForSelector('.tile[data-snym="oops"]');
    await thumb.tap('.tile[data-snym="oops"] .x');
    await thumb.waitForFunction(() =>
      !document.querySelector('.tile[data-snym="oops"]'));
    ok(true, 'tapping a × removes the row');
    /* Replicata (dreev, phone, 2026-08-11): "users on mobile are
       confused because they see the persistent tooltip 'awaiting
       bid'". Tap any empty bid cell; "Awaiting bid..." parks under the
       finger until the next tap. Expectata: nothing summoned — the
       empty card already holds the space where the bid will land, and
       the padlock's own tip names the stragglers. Resultata pre-fix:
       the tip showed and stuck, because a tap makes compatibility
       hover events and a summoned tip is DELIBERATELY held readable
       until the next tap (the star's sticky-tap tip, pinned above,
       needs exactly that). The lifetime was never the bug; the
       bidless cell being a tooltip host with nothing to say was.
       The padlock tap is the control: it proves a tap really does
       summon a tip here, so the empty cell's silence is the cell's. */
    await thumb.tap('#reveal');  // disabled: nothing happens but the tip
    ok(await thumb.evaluate(() =>
         !document.getElementById('tip').hidden
         && document.getElementById('tip').textContent.length > 0),
       'control: a tap on the grayed padlock DOES summon its tip'
       + ' (the sticky-hover leg touch relies on)');
    await thumb.tap('.tile[data-snym="bob"] .tile-bid');
    ok(await thumb.evaluate(() =>
         document.getElementById('tip').hidden),
       "no tooltip on a bidless cell under a thumb: the tap clears the"
       + ' padlock\'s tip and the empty card summons nothing of its own');
    const thumb2 = await makePage(browser, mobileViewport);
    await thumb2.goto(BASE + '/thumbs', { waitUntil: 'networkidle0' });
    await thumb2.tap('.tile[data-snym="bob"] .tu');
    await thumb2.waitForSelector('.tile.mine .rebid textarea');
    ok(true, 'tapping a star (a touch, not a click) claims the row');
    /* Replicata (dreev, phone): ALL tooltips vanished, surviving
       reload. The over-broad hover-none rule had killed the sticky-
       hover leg — the ONLY way button/cell tips ever showed on touch
       (activation blurs their focus leg). Expectata: tapping a star
       still shows its tip; only the cell you are TYPING in stays
       quiet. */
    ok(await thumb2.evaluate(() =>
         !document.getElementById('tip').hidden
         && document.getElementById('tip').textContent.length > 0),
       'tooltips LIVE on touch: the star she just tapped wears its'
       + " tip via the tap's sticky hover");
    await thumb2.tap('.tile.mine .rebid textarea');
    /* Replicata (dreev, phone): his is-you row — row two here — wore
       a stuck 'awaiting bid...' tooltip below it while he typed his
       bid. A tap sticks :hover to the bid cell and the tap's
       synthetic mouseenter stocks data-tip. Expectata: a tap is not
       a hover; touch shows no hover-tooltips at all. */
    ok(await thumb2.evaluate(() =>
         document.getElementById('tip').hidden),
       "no tooltip under a thumb's typing: tapping your bid cell is"
       + ' not hovering it');
    await thumb2.keyboard.type('the other thumb');
    // no enter: typing woke SUBMIT and her thumb taps it (2026-07-27:
    // tapping elsewhere commits nothing — the button is the phone's
    // return key now)
    await thumb2.tap('.tile.mine .rebid .go');
    await thumb2.waitForSelector('.tile.mine.has-bid');
    await thumb.waitForFunction(() =>  // the poll delivers bob's bid
      !document.getElementById('reveal').disabled);
    await thumb.tap('#reveal');
    await thumb.waitForFunction(() =>
      document.getElementById('status').classList.contains('revealed'));
    ok(await thumb.evaluate(() =>
      document.getElementById('status').textContent
        .includes('the other thumb')),
       'tapping the padlock reveals: the whole auction ran by thumb');
    await shoot(thumb, 'story5-thumb-revealed');

    /* ================ Story 5b: the fat-finger audit ===================
       Replicata: dreev on his phone (2026-07-27): "could this be more
       mobile-friendly just by making everything a little bigger?"
       Expectata: on a coarse pointer, every text field reads at >=16px
       (below that iOS Safari zoom-jumps into any focused field) and
       every control presents a >=44px hit box (Apple's HIG floor) —
       while the fine-pointer layout stays exactly as it was, and the
       320px phone still doesn't scroll sideways. Resultata pre-fix:
       13.6px fields, 24x32px stars. */
    gas.handle({ action: 'add', slug: 'fatfinger',
      snym: 'alice', usid: 'usid-fat-alice' });
    gas.handle({ action: 'add', slug: 'fatfinger',
      snym: 'bob', usid: 'usid-fat-bob' });
    gas.handle({ action: 'describe', slug: 'fatfinger', base: 0,
      blub: 'A blub, so the pencil shows.' });
    const fat = await makePage(browser, mobileViewport);
    await fat.goto(BASE + '/fatfinger', { waitUntil: 'networkidle0' });
    await fat.tap('.tile[data-snym="alice"] .tu');
    await fat.waitForSelector('.tile.mine .rebid textarea');
    await fat.type('.tile.mine .rebid textarea', 'draft');  // SUBMIT
                                    // stands only over a draft
    const fatFonts = await fat.evaluate(() =>
      ['#roster-input', '.rename input', '.tile.mine .rebid textarea',
       '#descedit', '.descview'].map((sel) => [sel, parseFloat(
        getComputedStyle(document.querySelector(sel)).fontSize)]));
    ok(fatFonts.every(([, px]) => px >= 16),
       'coarse pointer: every field and the blub read at >=16px'
       + ' (no iOS zoom-jump): ' + JSON.stringify(fatFonts));
    const fatHits = await fat.evaluate(() =>
      ['.tile:not(.mine) .tu', '.tile:not(.mine) .x', '#reveal',
       '#desctoggle', '#share', '#help',
       '.tile.mine .rebid .go'].map((sel) => {
        const r = document.querySelector(sel).getBoundingClientRect();
        return [sel, Math.round(r.width), Math.round(r.height)];
      }));
    ok(fatHits.every(([, w, h]) => w >= 43.5 && h >= 43.5),
       'coarse pointer: every control offers a >=44px hit box: '
       + JSON.stringify(fatHits));
    await shoot(fat, 'story5b-fatfinger');
    // park the tap-tip and the caret before measuring, story-1 style:
    // a stale-positioned tooltip is not the layout's overflow
    await fat.evaluate(() => document.activeElement.blur());
    await fat.mouse.move(5, 600);
    await fat.setViewport({ ...NARROW, hasTouch: true });
    await fat.waitForFunction(() => innerWidth === 320);
    await fat.waitForFunction(() =>
      document.getElementById('tip').hidden);
    ok(await fat.evaluate(() =>
         document.scrollingElement.scrollWidth <= innerWidth),
       'the grown touch targets still fit a 320px phone sideways');
    ok(await fat.evaluate(() =>
      [...document.querySelectorAll('#tiles .rename')].every((f) => {
        const cell = f.querySelector('.tile-name').getBoundingClientRect();
        const col = f.getBoundingClientRect();
        return cell.right <= col.right + 1;
      })),
       'squeezed columns CONTAIN their cells: no name field paints'
       + " across the bid column (the input's intrinsic ~200px used"
       + ' to drive the flex line wider than the shrunken column)');
    await shoot(fat, 'story5b-fatfinger-narrow');
    /* Replicata (dreev 2026-07-29): "Can you give the help popup a
       LaTeX style but still super mobile-friendly?" Expectata, at
       320px coarse: book serifs at >=16px, justified AND hyphenated
       (justification without hyphenation makes rivers at phone
       widths), centered title, TeX paragraph indents, and no
       sideways scroll inside the dialog. */
    await fat.tap('#help');
    await fat.waitForSelector('#help-dlg[open]');
    ok(await fat.evaluate(() => {
      const body = document.querySelector('.help-body');
      const cs = getComputedStyle(body);
      const h1 = getComputedStyle(body.querySelector('h1'));
      const p2 = getComputedStyle(body.querySelectorAll('p')[1]);
      return /serif/i.test(cs.fontFamily)
        && !/system-ui/.test(cs.fontFamily)
        && parseFloat(cs.fontSize) >= 16
        && cs.textAlign === 'justify'
        && (cs.hyphens === 'auto' || cs.webkitHyphens === 'auto')
        && h1.textAlign === 'center'
        && parseFloat(p2.textIndent) > 0
        && body.scrollWidth <= body.clientWidth + 1;
    }), 'the help reads like a PAPER: serifs at phone size, justified'
       + ' and hyphenated, centered title, TeX indents, no sideways'
       + ' scroll at 320px');
    await fat.evaluate(() =>
      document.querySelector('#help-dlg .dlg-x').click());
    // the fence: a fine pointer (desktop) keeps today's exact compact
    // geometry — the touch ergonomics are the coarse pointer's alone
    const fine = await makePage(browser, DESKTOP);
    await fine.goto(BASE + '/fatfinger', { waitUntil: 'networkidle0' });
    ok(await fine.evaluate(() => {
      const star = document.querySelector('.tile .tu')
        .getBoundingClientRect();
      const bid = getComputedStyle(
        document.querySelector('.tile:not(.mine) .bid-card'));
      const name = getComputedStyle(
        document.querySelector('.tile .tile-name'));
      const view = getComputedStyle(
        document.getElementById('descview'));
      const go = getComputedStyle(
        document.getElementById('descgo'));
      return Math.round(star.width) === 24
        && Math.round(star.height) === 38  // flush with the 1rem cells
                                           // (24px line + 0.6rem pad
                                           // + 2x2px arcade border)
        && parseFloat(bid.fontSize) >= 16
        && parseFloat(name.fontSize) >= 16
        && parseFloat(view.fontSize) >= 16
        && parseFloat(go.fontSize) >= 12;
    }), 'fine pointer: hit boxes stay desktop-compact, but READING'
       + " text meets the 16px floor there too (Butterick's floor is"
       + ' not a phone-only rule), and the button labels cleared 12px');

    /* ============ THE LAYOUT AUDITOR (dreev 2026-07-28) ===============
       "Do an elaborate audit for how you're failing to spot that kind
       of brokenness yourself." The failure mode: geometry quals only
       asserted RELATIONS I hypothesized (is the button below?), so a
       state nobody hypothesized about — the resting landing page, a
       flush zero-gap abutment — sailed through every suite. The
       remedy is an INVARIANT, not more point asserts: on any audited
       state, every pair of visible interactive boxes must keep 2px of
       daylight — no overlap, no flush abutment — excluding ancestor
       chains, the z-ladder's declared floaters (tip, banner, gavel,
       corner), and open dialogs (their own layer). Fine-pointer only:
       the coarse hit boxes deliberately overlap by design (negative-
       margin hit inflation), so phone geometry keeps its targeted
       asserts and screenshots instead. */
    const auditLayout = async (page, label) => {
      const bad = await page.evaluate(() => {
        const OVERLAYS = '#tip, #banner, .gavel, .corner';
        const els = [...document.querySelectorAll(
          'button, input, textarea, a, .bid-card, .tile-name,'
          + ' .at-wrap')]
          .filter((e) => !e.closest(OVERLAYS) && !e.closest('dialog'))
          .filter((e) =>
            e.checkVisibility({ visibilityProperty: true }));
        const boxes = els.map((e) => [
          e.tagName + '#' + e.id + '.' + e.className,
          e, e.getBoundingClientRect()]);
        const out = [];
        const GAP = 2;  // flush abutment reads as overlap
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const [na, a, ra] = boxes[i];
            const [nb, b, rb] = boxes[j];
            if (a.contains(b) || b.contains(a)) continue;
            if (ra.width === 0 || rb.width === 0) continue;
            if (ra.right > rb.left - GAP && rb.right > ra.left - GAP
                && ra.bottom > rb.top - GAP
                && rb.bottom > ra.top - GAP) {
              out.push(na + ' vs ' + nb);
            }
          }
        }
        return out;
      });
      ok(bad.length === 0, 'layout audit [' + label + ']: every'
         + ' visible control keeps its 2px of daylight — '
         + JSON.stringify(bad));
    };

    // Accessible names: every visible control says what it is —
    // icon-only controls mirror their tooltip words, bare inputs
    // carry their purpose. A control whose computed name has no
    // letters (×, ✎, 🔒, '') is mute to a screen reader.
    const auditNames = async (page, label) => {
      const mute = await page.evaluate(() => {
        const name = (e) => e.getAttribute('aria-label')
          || (e.labels && e.labels[0] && e.labels[0].textContent)
          || e.textContent.trim()
          || e.getAttribute('placeholder') || '';
        return [...document.querySelectorAll(
          'button, input, textarea, a[href]')]
          .filter((e) => e.checkVisibility({ visibilityProperty: true }))
          .filter((e) => !/[a-zA-Z]/.test(name(e)))
          .map((e) => e.tagName + '#' + e.id + '.' + e.className);
      });
      ok(mute.length === 0, 'accessible-name audit [' + label
         + ']: every visible control wears a lettered name — '
         + JSON.stringify(mute));
    };

    /* ...the whisper text keeps its whisper by SIZE, not by fading
       below contrast: the legend and footer wear full muted ink
       (the old 75%-alpha-of-muted double reduction failed WCAG at
       11px) */
    ok(await fine.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--muted)';
      document.body.append(probe);
      const muted = getComputedStyle(probe).color;
      probe.remove();
      const legend = getComputedStyle(document.querySelector('.legend'));
      const foot = getComputedStyle(document.querySelector('footer'));
      return legend.color === muted && foot.color === muted
        && parseFloat(legend.fontSize) >= 12.5;
    }), 'the legend and footer whisper by size, at full muted ink —'
       + ' never by alpha below contrast');

    /* ============= Story 5c: the buttons left the fields ===============
       Replicata: dreev 2026-07-27: "i don't think i like these
       save/submit buttons beeing inside the field." Expectata: every
       hot field's SAVE/SUBMIT sits fully BELOW the words' box, on the
       field's right flank — never overlaying what's typed. Resultata
       pre-fix: the button overlaid the field's right end (and on a
       phone-narrowed bid box, its middle — story 5b's tap-eater). */
    // window-side helper, stamped into each page that measures
    const BELOW_JS = `window.__below = (field, go) => {
      const f = document.querySelector(field).getBoundingClientRect();
      const g = document.querySelector(go);
      const gr = g.getBoundingClientRect();
      const row = g.closest('.gorow').getBoundingClientRect();
      return [field, gr.top >= f.bottom - 0.5,
              row.right > f.left + f.width / 2];
    };`;
    const fine2 = await makePage(browser, DESKTOP);
    await fine2.goto(BASE + '/fatfinger', { waitUntil: 'networkidle0' });
    await fine2.waitForSelector('.tile[data-snym="bob"]');
    await fine2.evaluate(BELOW_JS);
    await fine2.click('.tile[data-snym="bob"] .rename input');
    await fine2.type('.tile[data-snym="bob"] .rename input', 'x');
    await fine2.click('#roster-input');
    await fine2.type('#roster-input', 'x');
    await fine2.click('#desctoggle');
    await fine2.type('#descedit', 'x');
    await fine2.click('.tile[data-snym="alice"] .tu');
    await fine2.waitForSelector('.tile.mine .rebid textarea');
    await fine2.type('.tile.mine .rebid textarea', 'x');
    await auditLayout(fine2, 'named page, every field hot');
    await auditNames(fine2, 'named page, every field hot');
    // ...and the keyboard reaches everything (the every-control-is-a-
    // tab-stop law): no positive tabindex anywhere (DOM order is tab
    // order), and tabbing from the top visits the stars and the ×s —
    // keyboard users can claim and remove
    ok(await fine2.evaluate(() =>
      document.querySelectorAll(
        '[tabindex]:not([tabindex="-1"]):not([tabindex="0"])')
        .length === 0),
       'no positive tabindex anywhere: DOM order is tab order');
    const tabbed = new Set();
    await fine2.evaluate(() => document.body.focus());
    for (let i = 0; i < 40; i++) {
      await fine2.keyboard.press('Tab');
      tabbed.add(await fine2.evaluate(() => {
        const e = document.activeElement;
        return e.id || String(e.className).split(' ')[0] || e.tagName;
      }));
    }
    ok(['share', 'help', 'descedit', 'tu', 'roster-input', 'x']
         .every((s) => tabbed.has(s)),
       'tab reaches the whole hot page — stars and ×s included: '
       + [...tabbed].join(','));
    // the editing mode STACKS at every width (dreev 2026-07-30,
    // killing side-by-side: twin texts at equal weight read as a
    // duplicated render, not source-and-preview), and top to bottom
    // it reads: bordered source field (the person cells' twin — THE
    // "editable here" box), its SAVE/DISCARD row directly under it,
    // then the live preview below as plain prose OUTSIDE any box —
    // the card wears no box of its own in either mode
    ok(await fine2.evaluate(() => {
      const e = document.getElementById('descedit');
      const v = document.getElementById('descview');
      const er = e.getBoundingClientRect();
      const gr = document.getElementById('descgo').closest('.gorow')
        .getBoundingClientRect();
      const vr = v.getBoundingClientRect();
      const es = getComputedStyle(e);
      const card = getComputedStyle(document.getElementById('desc'));
      const wrap = getComputedStyle(
        document.querySelector('#status .addrow .at-wrap'));
      return er.bottom <= gr.top && gr.bottom <= vr.top - 2
        && Math.abs(er.left - vr.left) < 1
        && es.borderTopStyle === 'solid'
        && es.borderTopColor === wrap.borderTopColor
        && card.backgroundColor === 'rgba(0, 0, 0, 0)'
        && card.borderTopColor === 'rgba(0, 0, 0, 0)';
    }), 'editing mode, top to bottom: bordered source field, its'
       + ' SAVE/DISCARD row, then the preview as plain prose below,'
       + ' outside any box');
    // the desktop column offers a comfortable reading MEASURE
    // (designer loop round 2, 2026-07-30: 27rem was a phone column
    // on every screen — 39ch prose, 19ch bid cells; the canonical
    // guidance is 45-75ch, sweet spot ~66)
    ok(await fine2.evaluate(() => {
      const probe = document.createElement('span');
      probe.textContent = '0'.repeat(10);
      document.body.append(probe);
      const ch = probe.getBoundingClientRect().width / 10;
      probe.remove();
      const cpl = document.getElementById('descview')
        .getBoundingClientRect().width / ch;
      return cpl >= 50 && cpl <= 80;
    }), 'desktop prose reads at a comfortable measure: 50-80'
       + ' characters per line');
    const placements = await fine2.evaluate(() => [
      window.__below('.tile.mine .rebid textarea',
                     '.tile.mine .rebid .go'),
      window.__below('#roster-input', '#roster-go'),
      window.__below('#descedit', '#descgo'),
    ]);
    ok(placements.every(([, isBelow, onRightFlank]) =>
         isBelow && onRightFlank),
       'every commit button sits below its field, on its right flank: '
       + JSON.stringify(placements));
    ok(await fine2.evaluate(() => {
      const go = document.getElementById('roster-go');
      const one = document.querySelector('.tile.mine .rebid .go')
        .getBoundingClientRect().height;
      return go.getBoundingClientRect().height <= one + 2;
    }), 'ADD PARTICIPANT is ONE line, like every sibling pill: a'
       + ' label never breaks inside its own button (it rendered'
       + ' two-line beside 370px of empty card)');
    await shoot(fine2, 'story5c-buttons-below');
    const fresh = await makePage(browser, DESKTOP);
    await fresh.goto(BASE + '/', { waitUntil: 'networkidle0' });
    await auditLayout(fresh, 'landing, resting');
    // the corner chips own their strip (designer loop round 3,
    // 2026-07-30): share/help sat straddling the first card's top
    // border — half in, half out, the border line running behind
    // them — on every page at every width (the auditor never saw it:
    // a card is not a control)
    ok(await fresh.evaluate(() =>
      document.querySelector('.corner').getBoundingClientRect().bottom
        <= document.querySelector('main .card').getBoundingClientRect()
             .top - 2),
       'the corner chips sit wholly in the page margin: daylight'
       + ' between them and the first card');
    await shoot(fresh, 'story5d-landing-resting');
    await fresh.evaluate(BELOW_JS);
    // the landing affordances (dreev 2026-07-28): no red on arrival
    // (touched validation), the one action visible but grayed
    ok(await fresh.evaluate(() => {
      const a = document.getElementById('slug');
      const go = document.getElementById('namego');
      return !a.classList.contains('visited')
        && getComputedStyle(a).filter === 'none'
        && go.checkVisibility({ visibilityProperty: true })
        && go.disabled;
    }), 'the landing page: no premature red, and its one action'
       + ' already visible, grayed until there is a name');
    ok(await fresh.evaluate(() => {
      const dim = parseFloat(getComputedStyle(
        document.getElementById('desc')).opacity);
      return document.getElementById('share').disabled
        && !document.getElementById('help').disabled
        && dim < 1 && dim >= 0.55  // dimmed, never illegible
        && parseFloat(getComputedStyle(
             document.getElementById('status')).opacity) === dim;
    }),
       'an unnamed page is a ONE-action page: description and ledger'
       + ' wait grayed, share is a link to nowhere and disabled, help'
       + ' stays live');
    await fresh.keyboard.press('Tab');  // wander off, name still blank
    ok(await fresh.evaluate(() => {
      const cs = getComputedStyle(document.getElementById('slug'));
      return cs.filter.includes('drop-shadow')
        && cs.outlineStyle === 'solid';
    }), 'a blank name left behind GLOWS the objection (red only'
       + ' after you have been and gone — the touched convention)');
    await fresh.click('#slug');
    await fresh.type('#slug', 'gorows');
    ok(await fresh.evaluate(() =>
         document.getElementById('namego').textContent
           === startCopy('gorows')),
       'the commit button narrates the deed live: the typed name'
       + " rides in dreev's copy");
    ok(await fresh.evaluate(() => {
      const go = document.getElementById('namego');
      const cs = getComputedStyle(go);
      return !go.disabled && cs.color === 'rgb(255, 255, 255)'
        && go.getBoundingClientRect().height > 28
        && Math.abs(go.getBoundingClientRect().left
             - document.getElementById('slug')
                 .getBoundingClientRect().left) < 2;
    }), 'armed, the start button is the page hero: big, filled,'
       + " left-justified under its field");
    ok((await fresh.evaluate(() =>
         window.__below('#slug', '#namego')))[1],
       "the auction name's commit button sits below its field too");
    await auditLayout(fresh, 'landing, name typed');
    // ...and the glow rides every field objection (dreev 2026-07-28:
    // "glowy red, not just a red outline" — Bootstrap's convention)
    await fresh.keyboard.press('Enter');
    await fresh.waitForFunction(() => location.pathname === '/gorows');
    ok(await fresh.evaluate(() =>
      !document.getElementById('share').disabled
      && getComputedStyle(document.getElementById('desc')).opacity
           === '1'
      && getComputedStyle(document.getElementById('status')).opacity
           === '1'),
       'naming wakes the whole page: cards at full ink, share live');
    /* Replicata (dreev 2026-07-28: "you forgot to ungray when the
       auction name is chosen"): naming via the START BUTTON left the
       page gray — the body-level :has(#slug:enabled) never
       re-evaluated on the click path's disable, while the Enter path
       (the only one a qual walked) happened to recalc. Expectata:
       BOTH commit gestures wake the page. */
    const clicker = await makePage(browser, DESKTOP);
    await clicker.goto(BASE + '/', { waitUntil: 'networkidle0' });
    await clicker.type('#slug', 'clickstart');
    await clicker.click('#namego');
    await clicker.waitForFunction(() =>
      location.pathname === '/clickstart');
    await clicker.waitForFunction(() =>
      getComputedStyle(document.getElementById('desc')).opacity === '1'
      && getComputedStyle(document.getElementById('status')).opacity
           === '1'
      && !document.getElementById('share').disabled
      && getComputedStyle(document.querySelector('.field .gorow'))
           .display === 'none');
    ok(true, 'clicking the start button wakes the page exactly like'
       + ' Enter: full ink, live share, the button retired');
    await fresh.type('#roster-input', 'x'.repeat(21));
    await fresh.keyboard.press('Enter');  // the overlong objection
    ok(await fresh.evaluate(() =>
      getComputedStyle(document.querySelector('.addrow .at-wrap'))
        .filter.includes('drop-shadow')),
       'the objection ring glows, not just outlines (on the + row it'
       + ' rings the wrapper, where the ring lives)');

    /* ================= Story 6: two thumbs, one alice ==================
       Roommates both open /squabble on their phones; the roster lists
       alice and bea, unclaimed. Phone 1 taps alice's star. Phone 2 —
       its screen still showing alice open (no poll yet) — taps alice
       too. Post-takeover-ruling (dreev 2026-07-21, after faire's
       lockout): the later tap TAKES the seat, phone 1 converges
       QUIETLY to the filled-but-live star (its tooltip naming the
       anym that took it), takes bea instead, and the game plays out
       normally — one holder per seat throughout, honor system. */
    gas.handle({ action: 'add', slug: 'squabble',
      snym: 'alice', usid: 'usid-squabble-alice' });
    gas.handle({ action: 'add', slug: 'squabble',
      snym: 'bea', usid: 'usid-squabble-bea' });
    const p1 = await makePage(browser, mobileViewport);
    const p2 = await makePage(browser, mobileViewport);
    await p1.goto(BASE + '/squabble', { waitUntil: 'networkidle0' });
    await p2.goto(BASE + '/squabble', { waitUntil: 'networkidle0' });
    await p1.tap('.tile[data-snym="alice"] .tu');
    await p1.waitForSelector('.tile[data-snym="alice"].mine');
    ok(await p2.$eval('.tile[data-snym="alice"] .tu',
        (e) => !e.disabled),
       "phone 2's stale screen still offers alice: the race is on");
    await p2.tap('.tile[data-snym="alice"] .tu');
    await p2.waitForSelector('.tile[data-snym="alice"].mine');
    await p1.waitForFunction(() =>
      document.querySelector('.tile[data-snym="alice"] .tu.taken')
      && !document.querySelector('#tiles .rebid'));
    ok(await p1.evaluate(() =>
      document.getElementById('banner').hidden
      && !document.querySelector('.tile[data-snym="alice"] .tu')
           .disabled
      && document.querySelector('.tile[data-snym="alice"] .tu')
           .getAttribute('data-tip')
           // the tip up to the anym, whatever the copy says
           .startsWith(claimedByTip('').slice(0, -1))),
       'phone 1 is unseated QUIETLY: no red banner — the star fills'
       + ' in, stays live, and its tooltip says whose thumb took it');
    await p1.tap('.tile[data-snym="bea"] .tu');
    await p1.waitForSelector('.tile[data-snym="bea"].mine .rebid textarea');
    ok(true, 'phone 1 takes the open seat instead, one tap');
    await p1.type('.tile.mine .rebid textarea', 'a dozen eggs');
    await p1.keyboard.press('Enter');
    await p1.waitForSelector('.tile.mine.has-bid');
    await p2.type('.tile.mine .rebid textarea', 'my parking spot');
    // the OTHER thumb goes by button: typing woke SUBMIT, and the
    // tap's own blur must not vanish it mid-press (the hot class
    // holds through the mousedown-blur-click sequence)
    await p2.waitForFunction(() =>
      document.querySelector('.tile.mine .rebid .go')
        .checkVisibility({ visibilityProperty: true }));
    await p2.tap('.tile.mine .rebid .go');
    await p2.waitForSelector('.tile.mine.has-bid');
    // park the caret back in the (clean) committed editor: hot is
    // DIRTY-only (2026-07-27), so no SUBMIT stands on a committed
    // bid even while the caret sits in it
    await p2.click('.tile.mine .rebid textarea');
    await p1.waitForFunction(() =>
      !document.getElementById('reveal').disabled);
    await p1.tap('#reveal');
    await p1.waitForFunction(() =>  // the OTHER thumb's bid unmasks
      document.getElementById('status').textContent
        .includes('my parking spot'));
    ok(true, 'and the game plays out: both bids in, revealed by thumb');
    // The complement of the caught-draft case (dreev's old bug note
    // "no submit button when the auction is closed"): both bids were
    // COMMITTED, so no SUBMIT stands on the closed auction — nor did
    // one stand before it: hot is dirty-only, and neither field holds
    // a draft. The visibility check pins the CSS half (.gorow hides
    // unless .hot) that the jsdom quals can't see.
    await p2.waitForFunction(() =>
      document.body.classList.contains('revealed'));
    const goGone = async (page) => {
      await page.waitForFunction(() =>  // the 0.35s collapse grace
        !document.querySelector('.tile.mine .rebid .go')
          .checkVisibility({ visibilityProperty: true }));
      return true;
    };
    ok(await goGone(p1) && await goGone(p2),
       'no draft, no button: on the closed auction both committed'
       + " bids' SUBMITs are gone, not grayed");

    /* ====== the gavel catches a half-typed revision ==================
       [FLIPPED 2026-07-27: the emergent auto-submit (blessed
       2026-07-17, when disabling a focused editor blurred it in real
       Chrome and blur-commit raced the draft against the gavel) died
       with blur-commits.] Replicata: ann edits her bid, never
       submits; the reveal lands elsewhere. Expectata: the dying
       draft just STAYS — visible, disabled, unsent, its grayed
       SUBMIT wearing the too-late tip — and no banner, because no
       write was ever made or lost. */
    const wire = await makePage(browser, DESKTOP);
    gas.handle({ action: 'add', slug: 'wirestory',
      snym: 'ann', usid: 'usid-wirestory-ann' });
    gas.handle({ action: 'add', slug: 'wirestory',
      snym: 'bee', usid: 'usid-wirestory-bee' });
    gas.handle({ action: 'bid', slug: 'wirestory',
      snym: 'bee', usid: 'usid-wirestory-bee',
                 xbid: 'bee bid' });
    await wire.goto(BASE + '/wirestory', { waitUntil: 'networkidle0' });
    await claimRow(wire, 'ann');
    await wire.type('.tile.mine .rebid textarea', 'first word');
    await wire.keyboard.press('Enter');
    await wire.waitForSelector('.tile.mine.has-bid');
    await wire.click('.tile.mine .rebid textarea');
    await wire.keyboard.press('End');  // caret to the end, not the click point
    await wire.keyboard.type('!!!');  // a dirty, focused revision
    gas.handle({ action: 'reveal', slug: 'wirestory' });
    await wire.waitForFunction(() =>
      document.querySelector('.tile.mine .rebid textarea').disabled);
    await new Promise((r) => setTimeout(r, 300));  // an auto-submit
                                    // would be on the wire by now
    ok(await wire.evaluate(() => {
      const ed = document.querySelector('.tile.mine .rebid textarea');
      const go = document.querySelector('.tile.mine .rebid .go');
      return ed.value === 'first word!!!'
        && go.disabled
        && go.checkVisibility({ visibilityProperty: true })
        && go.getAttribute('data-tip') === tooLateGoTip
        && document.getElementById('banner').hidden;
    }), 'the dying draft just stays: visible, unsent, its grayed'
       + ' SUBMIT saying why — and no banner, since nothing was lost');
    ok(gas.handle({ action: 'state', slug: 'wirestory' }).bids
         .find((b) => b.usid === 'usid-wirestory-ann').xbid === 'first word',
       'the sheet keeps the pre-gavel bid');
    await auditLayout(wire, 'revealed page, dead draft standing');
    await auditNames(wire, 'revealed page, dead draft standing');
    // ...and the page's weather changed at the close (dreev
    // 2026-07-27: the paper warms as another subtle indicator), with
    // the Closed line sitting a full breath under the ledger
    ok(await wire.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.backgroundColor = 'var(--bg)';
      document.body.append(probe);
      const paper = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return document.body.classList.contains('revealed')
        && getComputedStyle(document.body).backgroundColor !== paper
        // re-derived 2026-08-10: the 1.1rem breath lives on the
        // tombstone ROW now (stamp, Archive, deck share it)
        && parseFloat(getComputedStyle(document
             .querySelector('#status .tombstone')).marginTop) > 12;
    }), 'a closed auction changes the weather: the body tints off the'
       + ' resting paper and the tombstone row gets its air');

    /* ====== the fresh-URL eager typist (dreev 2026-07-30) ============
       Replicata: arrive at a brand-new URL — no cached snapshot — on
       a slow wire (1.5s a call; the live API takes 2-3), and type
       two participants immediately. Expectata: both rows ON SCREEN
       at the keystrokes, the server catching up behind. Resultata
       pre-fix: nothing painted until the LAST write settled — 7-10s
       of dead screen against live Apps Script, the "takes forever
       for anything to get through" report, in both browsers. */
    readDelay = 1500;
    opDelay = 1500;
    const eag = await makePage(browser, DESKTOP);
    await eag.goto(BASE + '/eagertype',
      { waitUntil: 'domcontentloaded' });
    await eag.waitForSelector('#roster-input');
    await addName(eag, 'ann');
    await addName(eag, 'bob');
    ok(await eag.evaluate(() =>
      document.querySelectorAll('#tiles .tile').length === 2),
       'two adds on a fresh slow-wire page paint at the keystrokes');
    readDelay = 0;
    opDelay = 0;
    // The pinned-gavel fix decoupled the gray from the writes: calm
    // arrives at the ARRIVAL ANSWER, mid-adds. So wait on the real
    // condition — the server holding both seats — not on the gavel
    // (which was only ever a proxy for the settle).
    for (let i = 0; gas.handle({ action: 'state', slug: 'eagertype' })
           .seats.length < 2; i++) {
      if (i >= 200) throw new Error('eagertype adds never landed');
      await new Promise((r) => setTimeout(r, 50));
    }
    await eag.waitForFunction(() =>
      !document.getElementById('status').classList.contains('stale'));
    ok(gas.handle({ action: 'state', slug: 'eagertype' })
         .seats.length === 2
       && await eag.evaluate(() =>
            document.querySelectorAll('#tiles .tile').length === 2),
       'and the server catches up to the very same picture');
    // the reported phone bug, at live latency: a submitted bid must
    // never read as awaited — the ledger counts it at SUBMIT, and
    // the volley's away-tint (not a spinner) says not-yet-confirmed.
    // (adding ann latched this page as her: the fresh-add auto-claim)
    await eag.waitForSelector('.tile.mine .rebid textarea');
    opDelay = 1500;
    await bid(eag, 'my kingdom');
    const flying = await eag.evaluate(() => {
      const t = document.querySelector('.tile.mine');
      return { hasBid: t.classList.contains('has-bid'),
               tint: getComputedStyle(
                 t.querySelector('.rebid textarea')).backgroundColor,
               busy: !!t.querySelector('.rebid.busy') };
    });
    ok(flying.hasBid && flying.busy
       && flying.tint !== 'rgba(0, 0, 0, 0)',
       'a flying bid reads as IN, wearing the away-tint: '
       + JSON.stringify(flying));
    opDelay = 0;
    await eag.waitForFunction(() =>
      !document.querySelector('.rebid.busy'));
    ok(await eag.evaluate(() =>
      document.querySelector('.tile.mine').classList
        .contains('has-bid')),
       'the settle confirms the same picture: bid in, volley tint'
       + ' shed (the editor now wears its bid-card green)');

    /* ====== cletus and winifred, in a real browser ===================
       The mid-air-collision convention (dreev 2026-07-28, replacing
       warn-and-rebase): NOTHING warns cletus mid-composition when
       winifred's save lands under his draft; the conflict is found at
       HIS save, refused in the server's words; and a fresh load
       always shows the database's blub — his unsaved words die with
       the tab, exactly what the refusal banner told him to expect. */
    gas.handle({ action: 'describe', slug: 'clobstory',
      blub: 'original', base: 0 });
    const cle = await makePage(browser, DESKTOP);
    await cle.goto(BASE + '/clobstory', { waitUntil: 'networkidle0' });
    await cle.click('#desctoggle');  // pencil: to the source (focuses)
    await cle.keyboard.press('End');  // caret to the line's end
    await cle.keyboard.type(' plus cletus');
    // winifred lands from her own machine mid-draft...
    gas.handle({ action: 'describe', slug: 'clobstory',
      blub: 'per winifred',
      base: gas.handle({ action: 'state', slug: 'clobstory' }).bver });
    // ...and the next polls say NOTHING to cletus: his words, his
    // caret, no banner — conflicts are save-time business
    await new Promise((r) => setTimeout(r, 6000));  // a full poll
    ok(await cle.evaluate(() =>
         document.getElementById('banner').hidden
         && document.getElementById('descedit').value
              === 'original plus cletus'),
       'a foreign save mid-draft warns NOBODY mid-composition:'
       + ' his words and his calm stand');
    // his SAVE is where the collision surfaces: THE WAR POPUP
    // (README items 10-11), a real modal in a real browser, VS-Code
    // red/green diff and all — the banner stands down
    await cle.click('#descgo');
    await cle.waitForFunction(() =>
      document.getElementById('war-dlg').open);
    await cle.waitForFunction(() =>
      document.querySelector('#war-diff .diff-row') !== null);
    ok(await cle.evaluate((take) => {
      const del = document.querySelector('#war-diff .diff-row.del');
      const ins = document.querySelector('#war-diff .diff-row.ins');
      return document.getElementById('war-title').textContent
          === warTitle(take)
        && document.getElementById('banner').hidden
        && del && del.textContent.includes('per winifred')
        && ins && ins.textContent.includes('original plus cletus')
        && getComputedStyle(del).backgroundColor
             === 'rgba(255, 0, 0, 0.2)'
        && getComputedStyle(ins).backgroundColor
             === 'rgba(155, 185, 85, 0.2)'
        && document.querySelector('#war-diff mark.chg') !== null
        && document.getElementById('descedit').value
             === 'original plus cletus'
        && document.getElementById('descedit').classList
             .contains('error');
    }, 1)
       && gas.handle({ action: 'state', slug: 'clobstory' }).blub
            === 'per winifred',
       'the collision surfaces at HIS save as the war popup: her'
       + ' words red-deleted, his green-inserted in VS Code inks,'
       + ' inner marks lit, his draft red below — her words standing');
    await shoot(cle, 'story-editwar-popup');
    // the popup keeps its own house: buttons disjoint with daylight,
    // everything inside the dialog, the dialog inside the viewport
    // (the layout auditor skips dialog innards, so this is its
    // war-popup checkpoint)
    ok(await cle.evaluate(() => {
      const dlg = document.getElementById('war-dlg')
        .getBoundingClientRect();
      const keep = document.getElementById('war-keep')
        .getBoundingClientRect();
      const mine = document.getElementById('war-mine')
        .getBoundingClientRect();
      const diff = document.getElementById('war-diff')
        .getBoundingClientRect();
      const inside = (r) => r.left >= dlg.left && r.right <= dlg.right
        && r.top >= dlg.top && r.bottom <= dlg.bottom;
      return keep.right <= mine.left - 2
        && diff.bottom <= Math.min(keep.top, mine.top) - 2
        && [keep, mine, diff].every(inside)
        && dlg.right <= innerWidth && dlg.bottom <= innerHeight;
    }), 'war popup geometry: diff above the two buttons, daylight'
       + ' everywhere, dialog within the viewport');
    // Keep theirs surrenders: popup and editor close, the record
    // stands rendered
    await cle.click('#war-keep');
    await cle.waitForFunction(() =>
      !document.getElementById('war-dlg').open
      && document.getElementById('desc').classList.contains('viewing'));
    ok(await cle.evaluate(() =>
      document.getElementById('descview').textContent
        .includes('per winifred')),
       'Keep theirs: one click of surrender, the record rendered');
    // round two: he edits again, winifred lands again, he OVERWRITES
    await cle.click('#desctoggle');
    await cle.keyboard.press('End');
    await cle.keyboard.type(' — cletus insists');
    gas.handle({ action: 'describe', slug: 'clobstory',
      blub: 'winifred again',
      base: gas.handle({ action: 'state', slug: 'clobstory' }).bver });
    await cle.click('#descgo');
    await cle.waitForFunction(() =>
      document.getElementById('war-dlg').open);
    await cle.waitForFunction(() =>
      document.querySelector('#war-diff .diff-row') !== null);
    await cle.click('#war-mine');
    await cle.waitForFunction(() =>
      document.getElementById('desc').classList.contains('viewing')
      && !document.getElementById('war-dlg').open);
    await cle.waitForFunction(() =>
      document.getElementById('descview').textContent
        .includes('cletus insists'));
    ok(gas.handle({ action: 'state', slug: 'clobstory' }).blub
         === 'per winifred — cletus insists',
       'Overwrite with mine: the informed win lands — appended to'
       + " HER words, because Keep theirs adopted the record into"
       + ' the editor (item 12)');
    // and a fresh load shows the DATABASE, never a ghost of any
    // dead draft (dreev's firefox haunting)
    await cle.reload({ waitUntil: 'networkidle0' });
    await cle.waitForFunction(() =>
      document.getElementById('desc').classList.contains('viewing'));
    ok(await cle.evaluate(() =>
      document.getElementById('descview').textContent
        .includes('cletus insists')
      && document.getElementById('descedit').value
           .includes('cletus insists')
      && document.getElementById('banner').hidden),
       'the reload shows the database and only the database: no'
       + ' restored draft, no banner, no haunting');
    // ...and the popup on a phone-sized COARSE pointer: its own page
    // (a mid-story hasTouch flip RELOADS the page — puppeteer's
    // setViewport contract), its own quick collision. The resolution
    // buttons must be real touch targets and the dialog must fit.
    const phw = await makePage(browser, { ...PHONE, hasTouch: true });
    await phw.goto(BASE + '/clobstory', { waitUntil: 'networkidle0' });
    await phw.click('#desctoggle');
    await phw.keyboard.type('phone draft ');
    gas.handle({ action: 'describe', slug: 'clobstory',
      blub: 'rival for the phone',
      base: gas.handle({ action: 'state', slug: 'clobstory' }).bver });
    await phw.click('#descgo');
    await phw.waitForFunction(() =>
      document.getElementById('war-dlg').open);
    await phw.waitForFunction(() =>
      document.querySelector('#war-diff .diff-row') !== null);
    const warFit = await phw.evaluate(() => ({
      coarse: matchMedia('(pointer: coarse)').matches,
      keep: document.getElementById('war-keep')
        .getBoundingClientRect().height,
      mine: document.getElementById('war-mine')
        .getBoundingClientRect().height,
      dlg: document.getElementById('war-dlg').getBoundingClientRect()
        .toJSON(),
    }));
    ok(warFit.coarse && warFit.keep >= 44 && warFit.mine >= 44
       && warFit.dlg.right <= PHONE.width && warFit.dlg.left >= 0,
       'coarse pointer: both war buttons offer >=44px and the'
       + ' dialog fits the phone: ' + JSON.stringify(warFit));
    await shoot(phw, 'story-editwar-popup-phone');

    /* ====== name, tab, enter (dreev's own fumble, verbatim) ==========
       He typed the auction name and hit Tab: pre-fix it either
       committed irreversibly (the Tab-commit era) or threw him into
       the browser chrome (the buttonless era). Expectata: Tab lands
       on the name's own commit button — the next control — and
       Enter presses it. */
    const crea = await makePage(browser, DESKTOP);
    await crea.goto(BASE + '/', { waitUntil: 'networkidle0' });
    await crea.type('#slug', 'tabname');
    await crea.keyboard.press('Tab');
    ok(await crea.evaluate(() =>
      document.activeElement === document.getElementById('namego')
      && document.getElementById('namego')
           .checkVisibility({ visibilityProperty: true })),
       'tab out of a typed name lands on its visible commit button,'
       + ' not in the browser chrome');
    await crea.keyboard.press('Enter');
    await crea.waitForFunction(() => location.pathname === '/tabname');
    ok(await crea.evaluate(() =>
      document.getElementById('slug').disabled),
       'enter presses it: name, tab, enter — commit by convention,'
       + ' no hidden gesture');
    // the empty description TEACHES (designer loop round 1,
    // 2026-07-30; NN/g: a blank container damages discoverability —
    // say what belongs here and hand over the action): the pencil
    // steps into the flow wearing the textarea's own invitation —
    // one control, same click, single-sourced human copy
    ok(await crea.evaluate(() => {
      const p = document.getElementById('desctoggle');
      return getComputedStyle(p).position === 'static'
        && getComputedStyle(p, '::before').content
             .includes(document.getElementById('descedit').placeholder)
        && p.checkVisibility({ visibilityProperty: true });
    }), 'an empty description invites: the pencil joins the flow'
       + " wearing the placeholder's words");

    /* ---- tooltips outrank the banner --------------------------------
       Replicata (dreev: "tooltips appearing behind other elements" —
       again, but NOT the old stacking-context class; those quals
       hold): the banner always sat at z 4 over z-3 tips, invisible
       for months because banners self-dismissed in 5s. The sticky
       dead-end banner made the latent ordering observable.
       Expectata: a tip you are actively summoning outranks the
       ambient banner. ---------------------------------------------- */
    // (from a BARE page: typing names is the create flow now)
    const zpage = await makePage(browser, DESKTOP);
    await zpage.goto(BASE + '/', { waitUntil: 'networkidle0' });
    await zpage.type('#slug', 'chores');  // occupied: sticky banner
    await zpage.keyboard.press('Enter');   // (commit is a gesture now)
    await zpage.waitForFunction(() =>
      !document.getElementById('banner').hidden
      && document.querySelector('#banner a'));
    // The banner overlays the auction card, so the label beneath is
    // honestly unhoverable (hit-testing; the OLD qual compared
    // computed z without ever showing a tip — vacuous). Summon from
    // the REVEAL button instead: the tip must show with the banner
    // standing, at a ladder height above the banner's.
    await zpage.hover('#reveal');
    await zpage.waitForFunction(() =>
      !document.getElementById('tip').hidden);
    ok(await zpage.evaluate(() =>
      !document.getElementById('banner').hidden
      && parseInt(getComputedStyle(document.getElementById('tip'))
           .zIndex, 10)
         > parseInt(getComputedStyle(
             document.getElementById('banner')).zIndex, 10)),
       'a summoned tooltip outranks the standing banner (heights'
       + ' pinned in the z-ladder registry too)');

    /* ================= Story 7: the long bid ===========================
       Replicata (dreev, 2026-07-21): type a bid longer than its box.
       Expectata: the box grows to hold it — while typing, and again
       in the revealed record. Sealed is the deliberate exception: a
       sealed card must never leak the bid's SIZE, so it stays one
       decoy line however long the secret. (The editor is queried
       tag-agnostically: these quals judge the box, not the tag.) */
    const ED = '.tile.mine .rebid :is(input, textarea)';
    const leo = await makePage(browser, DESKTOP);
    await leo.goto(BASE + '/longbid', { waitUntil: 'networkidle0' });
    await addName(leo, 'leo');   // self-claims (2j)
    await addName(leo, 'mo');
    await leo.waitForSelector(ED);
    const LONGBID = 'one hundred dollars, my cast-iron skillet, and a'
      + ' month of doing all the dishes';
    ok(LONGBID.length === 78, 'the fixture wraps hard while staying'
       + ' well inside the 160-char limit');
    const h0 = await leo.$eval(ED, (e) => e.getBoundingClientRect().height);
    ok(await leo.evaluate((h) => {
      const slot = document.querySelector('.tile:not(.mine) .bid-card.slot');
      return h < slot.getBoundingClientRect().height * 1.5;
    }, h0), "empty, the editor keeps the ledger's one-line rhythm");
    await leo.click(ED);
    await leo.type(ED, LONGBID);
    ok(await leo.$eval(ED, (e, h) =>
         // > 1.4x: at least one full extra line (the old 1.8 was
         // mono-calibrated — Nunito wraps this fixture to two lines,
         // not three; the second conjunct is the actual law)
         e.getBoundingClientRect().height > h * 1.4
         && e.scrollHeight <= e.clientHeight + 1, h0),
       'the box grows under her fingers: every word of the long bid'
       + ' stays in sight while she types');
    ok(await leo.evaluate(() => {
      const row = document.querySelector('.tile.mine').getBoundingClientRect();
      const star = document.querySelector('.tile.mine .tu')
        .getBoundingClientRect();
      const name = document.querySelector('.tile.mine .tile-name')
        .getBoundingClientRect();
      return row.height > name.height * 1.8
        && Math.abs(star.top - name.top) < 1
        && Math.abs(star.bottom - name.bottom) < 1
        && Math.abs((star.top + star.bottom) / 2
          - (row.top + row.bottom) / 2) > 4;
    }), 'beside a wrapped bid, the star stays on the first line with'
       + ' the name instead of sinking to the tall row center');
    await leo.keyboard.press('Enter');
    await leo.waitForSelector('.tile.mine.has-bid');
    ok(await leo.$eval(ED, (e, h) =>
         // the same 1.4x growth proxy as the typing check above
         e.getBoundingClientRect().height > h * 1.4
         && e.scrollHeight <= e.clientHeight + 1, h0),
       'and the standing bid keeps its tall box after submitting');
    await shoot(leo, 'story7-long-bid-typing');

    const mo = await makePage(browser, DESKTOP);
    await mo.goto(BASE + '/longbid', { waitUntil: 'networkidle0' });
    await mo.waitForSelector('#tiles .tile.has-bid');
    ok(await mo.evaluate(() => {
      const sealed = document.querySelector('.tile.has-bid .bid-card');
      const slot = document.querySelector(
        '.tile:not(.has-bid) .bid-card.slot');
      return sealed.getBoundingClientRect().height
             < slot.getBoundingClientRect().height * 1.5;
    }), 'sealed, the 78-char bid wears a ONE-LINE card: the box must'
       + ' never leak the size of what it hides');
    /* the decoy is clipped by its card (2026-07-30 designer round).
       Replicata: open a sealed auction at phone width. Expectata: the
       blurred decoy stays inside the green card. Resultata pre-fix:
       the fixed one-line decoy was wider than the phone's bid column
       and its haze ran out of the card, under the neighboring ×. */
    const peek = await makePage(browser, PHONE);
    await peek.goto(BASE + '/longbid', { waitUntil: 'networkidle0' });
    await peek.waitForSelector('.tile.has-bid .bid-card');
    ok(await peek.evaluate(() =>
      [...document.querySelectorAll('.bid-text.masked')].every((m) => {
        const card = m.closest('.bid-card').getBoundingClientRect();
        const r = m.getBoundingClientRect();
        return r.right <= card.right + 1 && r.left >= card.left - 1;
      })),
       'on a phone the sealed decoy stays inside its card instead of'
       + ' running under the ×');
    await shoot(peek, 'story7-sealed-decoy-phone');
    await claimRow(mo, 'mo');
    /* the 160-char limit OBJECTS, never chops (dreev: "i don't like
       how it abruptly cuts me off... it should make it obvious"):
       past it every keystroke still lands in sight, the field
       reddens live, and Enter is refused in the server's own words,
       the draft intact for trimming */
    await mo.type(ED, 'x'.repeat(170));
    ok(await mo.$eval(ED, (e) => e.value.length === 170
         && e.scrollHeight <= e.clientHeight + 1),
       'no keystroke eaten past the limit: all 170 chars land, in sight');
    ok(await mo.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--err-fg)';
      document.body.append(probe);
      const red = getComputedStyle(probe).color;
      probe.remove();
      return getComputedStyle(document.querySelector(
        '.tile.mine .rebid textarea')).outlineColor === red;
    }), 'and the field wears the red objection ring, live');
    await mo.keyboard.press('Enter');
    await mo.waitForFunction((womp) =>
      !document.getElementById('banner').hidden
      && document.getElementById('banner-msg').textContent === womp,
      {}, STR.bidTooLongBanner);
    ok(await mo.$eval(ED, (e) => e.value.length === 170),
       "refused before the wire, in the refusal's words, draft intact");
    await mo.$eval(ED, (e) => e.select());
    await mo.type(ED, '$100');
    ok(await mo.$eval(ED, (e) => !e.classList.contains('error')),
       'trimmed under the limit, the objection withdraws live');
    await mo.keyboard.press('Enter');
    await mo.waitForFunction(() =>
      document.querySelectorAll('#tiles .tile.has-bid').length === 2);
    // the flying bid paints has-bid at SUBMIT (the aloft merge); the
    // banner retires at the SETTLE — wait for the volley to land,
    // not the optimistic paint (this sampled the gap and flaked)
    await mo.waitForFunction(() => !document.querySelector('.rebid.busy'));
    ok(await mo.evaluate(() =>
      document.getElementById('banner').hidden),
       'and the successful settle retires the stale objection banner');
    await mo.waitForFunction(() => !document.getElementById('reveal').disabled);
    // the reveal, BY KEYBOARD (the 07-16 tab law died 2026-07-27:
    // every control is a tab stop and Enter activates it). At the
    // settle the button yields its slot to the Closed stamp, so
    // focus falls with it — the pin is that Enter CLOSES the
    // auction, not where focus lands afterward.
    ok(await mo.evaluate(() =>
      document.getElementById('reveal').tabIndex !== -1),
       'the REVEAL button is a tab stop: reachable without a pointer');
    await mo.evaluate(() => document.getElementById('reveal').focus());
    await mo.keyboard.press('Enter');
    await mo.waitForFunction((t) => document.getElementById('status')
      .textContent.includes(t), {}, LONGBID);
    ok(await mo.evaluate(() =>
      document.getElementById('status').classList.contains('revealed')),
       'the REVEAL button answers the keyboard: a keyboard-driven'
       + ' auction can actually close');
    ok(await mo.evaluate(() => {
      const long = document.querySelector(
        '.tile[data-snym="leo"] .bid-card');
      const short = document.querySelector(
        '.tile.mine .rebid').firstElementChild;
      // 1.4x = at least one extra line (mono-era 1.8 assumed a
      // three-line wrap; see the growth checks above)
      return long.getBoundingClientRect().height
             > short.getBoundingClientRect().height * 1.4
        && document.documentElement.scrollWidth <= window.innerWidth;
    }), "revealed, leo's card grows to fit all 78 characters —"
       + ' downward, never sideways off the page');
    await leo.waitForFunction(() =>
      document.getElementById('status').classList.contains('revealed'));
    ok(await leo.$eval(ED, (e) =>
         e.disabled && e.scrollHeight <= e.clientHeight + 1),
       "leo's own frozen record shows every word: the dead editor is"
       + ' as tall as its bid');
    await shoot(leo, 'story7-long-bid-revealed');

    /* ====== story 7b: the poem bid (newlines, dreev 2026-07-27) ======
       Shift+Enter breaks the line; Enter still submits; the sealed
       decoy still betrays nothing; the revealed card keeps the
       poem's shape, growing downward. */
    const poet = await makePage(browser, DESKTOP);
    await poet.goto(BASE + '/poembid', { waitUntil: 'networkidle0' });
    await addName(poet, 'ann');  // self-claims (2j)
    await poet.waitForSelector(ED);
    const hPoem0 = await poet.$eval(ED,
      (e) => e.getBoundingClientRect().height);
    await poet.click(ED);
    await poet.keyboard.type('roses are red');
    await poet.keyboard.down('Shift');
    await poet.keyboard.press('Enter');
    await poet.keyboard.up('Shift');
    await poet.keyboard.type('violets are blue');
    ok(await poet.$eval(ED, (e, h) =>
         e.value === 'roses are red\nviolets are blue'
         // one more LINE of height (the old >1.8x bar was secretly
         // the overlay-era padding-right forcing an extra wrap)
         && e.getBoundingClientRect().height
              >= h + 0.9 * parseFloat(getComputedStyle(e).lineHeight),
       hPoem0),
       'Shift+Enter breaks the line under her fingers, the box'
       + ' growing to show both');
    await poet.keyboard.press('Enter');  // Enter still means SEND
    await poet.waitForSelector('.tile.mine.has-bid');
    gas.handle({ action: 'add', slug: 'poembid', snym: 'zed',
      usid: 'usid-poem-zed' });
    gas.handle({ action: 'bid', slug: 'poembid', snym: 'zed',
      usid: 'usid-poem-zed', xbid: 'a limerick' });
    const reader = await makePage(browser, DESKTOP);
    await reader.goto(BASE + '/poembid', { waitUntil: 'networkidle0' });
    await reader.waitForFunction(() =>
      document.querySelectorAll('#tiles .tile.has-bid').length === 2);
    ok(await reader.evaluate(() => {
      const cards = [...document.querySelectorAll('.bid-card')];
      return Math.abs(cards[0].getBoundingClientRect().height
                      - cards[1].getBoundingClientRect().height) < 1;
    }), "sealed, the two-line poem wears the same one-line decoy as"
       + " the one-liner: a bid's shape is part of its secret");
    await poet.waitForFunction(() =>
      !document.getElementById('reveal').disabled);
    await poet.click('#reveal');
    await reader.waitForFunction(() =>
      document.getElementById('status').classList.contains('revealed'));
    ok(await reader.evaluate(() => {
      const poem = document.querySelector(
        '.tile[data-snym="ann"] .bid-text');
      const one = document.querySelector(
        '.tile[data-snym="zed"] .bid-card');
      return poem.textContent === 'roses are red\nviolets are blue'
        && getComputedStyle(poem).whiteSpace === 'pre-wrap'
        // taller by at least a text line (padding keeps the naive
        // two-to-one height ratio under 1.7, so ratios mislead here)
        && poem.closest('.bid-card').getBoundingClientRect().height
           > one.getBoundingClientRect().height + 12
        && document.documentElement.scrollWidth <= window.innerWidth;
    }), 'revealed, the poem keeps its line break — the card grows'
       + ' downward, never sideways off the page');

    /* ========== The scribbling pencil (dreev 2026-07-31) ==========
       dalia opens the blub editor; on eric's screen the discourse
       pencil takes accent ink and rocks about its tip, its tooltip
       naming her; her DISCARD rests it again — all through the real
       heartbeat, poll, and CSS animation. */
    const dalia = await makePage(browser, DESKTOP);
    await dalia.goto(BASE + '/quillst', { waitUntil: 'networkidle0' });
    await addName(dalia, 'dalia');
    await dalia.waitForSelector('.tile.mine');
    await shoot(dalia, 'story-pencil-discourse');
    const eric = await makePage(browser, DESKTOP);
    await eric.goto(BASE + '/quillst', { waitUntil: 'networkidle0' });
    await eric.waitForSelector('.tile[data-snym="dalia"]');
    // keyboard-open the editor (e.detail 0 keeps focus on the
    // pencil): the mode flip display:none's the pencil while it
    // still holds focus, and the parked tip must go SILENT — not
    // park at the page origin (the hidden-host guard; the defect
    // showed in two phone captures before the fix)
    await dalia.focus('#desctoggle');
    await dalia.keyboard.press('Enter');
    await dalia.waitForFunction(() => !document.getElementById('desc')
      .classList.contains('viewing'));
    ok(await dalia.evaluate(() =>
      document.getElementById('tip').hidden),
       'a hidden host keeps its counsel: the retired pencil parks'
       + ' no origin-tip');
    await eric.waitForFunction(() => document.getElementById('desc')
      .classList.contains('scribbling'));
    ok(await eric.$eval('#desctoggle', (e) => e.dataset.tip)
         === await eric.evaluate(() =>
              descVerTip(0) + ' ' + editingBy('dalia')),
       "eric's pencil tip names dalia the moment her editor opens");
    ok(await eric.$eval('.desctoggle svg',
         (e) => getComputedStyle(e).animationName) === 'scribble',
       'the busy pencil rocks: the scribble animation is live');
    await shoot(eric, 'story-scribbling-pencil');
    await dalia.click('#descdiscard');
    await eric.waitForFunction(() => !document.getElementById('desc')
      .classList.contains('scribbling'));
    ok(await eric.$eval('#desctoggle', (e) => e.dataset.tip)
         === await eric.evaluate(() => descVerTip(0)),
       "dalia's DISCARD rests eric's pencil, the tip back to the"
       + ' bare version');

    /* ============ THE LIVE-WIRE STORY (dreev 2026-07-30: "more
       realistic quals" — he tests with chrome and firefox against
       the live deploy, where every call takes seconds and both
       browsers write at once; the suite's instant wire hid that
       whole regime). Two browsers on one auction at live-shaped
       latency, doing what a real pair does: simultaneous adds
       inside the arrival gray, bids (the instant-feedback laws), a
       blub edit-war (the local verdict), and the reveal — with
       convergence and the busy signs asserted at every beat. */
    readDelay = 1200;
    opDelay = 1200;
    const wa = await makePage(browser, DESKTOP);
    const wb = await makePage(browser, DESKTOP);
    await Promise.all([
      wa.goto(BASE + '/livewire', { waitUntil: 'domcontentloaded' }),
      wb.goto(BASE + '/livewire', { waitUntil: 'domcontentloaded' }),
    ]);
    await wa.waitForSelector('#roster-input');
    await wb.waitForSelector('#roster-input');
    await addName(wa, 'ann');   // both type inside the arrival gray,
    await addName(wb, 'ben');   // simultaneously
    ok(await wa.$eval('#tiles', (e) =>  // the self-claimed row's name
         !!e.querySelector('.tile[data-snym="ann"]'))  // lives in an
       && await wb.$eval('#tiles', (e) =>  // INPUT: key on the row,
         !!e.querySelector('.tile[data-snym="ben"]')),  // not text
       'live wire: both adds paint at the keystroke, both browsers');
    await wa.waitForFunction(() => !document.getElementById('status')
      .classList.contains('stale'));
    await wb.waitForFunction(() => !document.getElementById('status')
      .classList.contains('stale'));
    ok(true, 'the arrival answers retire both gavels without waiting'
       + ' out the contended writes');
    await wa.waitForFunction(() =>
      document.querySelectorAll('#tiles .tile').length === 2);
    await wb.waitForFunction(() =>
      document.querySelectorAll('#tiles .tile').length === 2);
    ok(true, 'both browsers converge on ann and ben over the slow wire');
    await wa.waitForSelector('.tile.mine .rebid textarea');
    await bid(wa, 'a kingdom');
    ok(await wa.evaluate(() => {
      const r = document.querySelector('.tile.mine .rebid');
      return !r.classList.contains('hot')
        && r.classList.contains('busy');
    }), 'the press closes the row at once on the slow wire: the'
       + ' away-tint is the only not-yet-confirmed sign');
    await wb.waitForFunction(() =>
      document.querySelectorAll('#tiles .tile.has-bid').length === 1);
    ok(true, "ann's bid crosses to the other browser");
    await wb.waitForSelector('.tile.mine .rebid textarea');
    await bid(wb, 'a farthing');
    // the edit war: B describes; A's poll delivers it; B saves AGAIN
    // while A edits; A's SAVE wars AT THE CLICK — no round trip
    await wb.click('#desctoggle');
    await wb.type('#descedit', 'rules by ben');
    await wb.click('#descgo');
    await wa.waitForFunction(() =>
      document.getElementById('descview').textContent
        .includes('rules by ben'));
    await wa.click('#desctoggle');
    await wa.type('#descedit', ' plus ann');
    const waLogs = [];  // the chronicle is the observable: it
    wa.on('console', (m) => waLogs.push(m.text()));  // narrates the
    await wb.click('#desctoggle');    // foreign save's arrival with ✎
    await wb.type('#descedit', ' the second');
    await wb.click('#descgo');
    // wait until A's poll has DELIVERED ben's second save (the dirty
    // editor rightly keeps its base; only the state moves)
    for (let i = 0; !waLogs.some((t) => t.startsWith('✎')); i++) {
      if (i >= 300) throw new Error("ben's save never reached ann");
      await new Promise((r) => setTimeout(r, 100));
    }
    await wa.click('#descgo');
    ok(await wa.evaluate(() =>
      document.getElementById('war-dlg').open
      && document.querySelector('#war-diff .diff-row') !== null),
       'a knowable conflict wars AT THE CLICK on the slow wire: the'
       + ' diff is drawn from the state in hand, no fetch, no gavel');
    await wa.click('#war-keep');
    await wa.waitForFunction(() =>
      !document.getElementById('war-dlg').open);
    ok(await wa.$eval('#descedit', (e) =>
         e.value === 'rules by ben the second'),
       'Keep theirs adopts the record on the spot');
    // the reveal, from B; A converges without a touch
    await wb.waitForFunction(() =>
      !document.getElementById('reveal').disabled);
    await wb.click('#reveal');
    await wa.waitForFunction(() =>
      document.getElementById('status').classList.contains('revealed'));
    ok(await wa.evaluate(() =>
         document.getElementById('status').textContent
           .includes('a farthing'))
       && await wb.evaluate(() =>
         document.getElementById('status').textContent
           .includes('a kingdom')),
       'revealed: each browser reads the other\'s bid, converged over'
       + ' the slow wire');
    readDelay = 0;
    opDelay = 0;

    /* ========== The evergreen slug (dreev's archive, 2026-08-09) ===
       flo runs the weekly auction at /weekly: last round closed, she
       clicks Archive — the page reborn empty on the spot, the
       tombstone slot linking its newest archive — and the archived
       round reads whole at its own URL, Archive control grayed,
       with the chain links leading home. */
    gas.handle({ action: 'bid', slug: 'weekly', snym: 'flo',
      usid: 'usid-weekly-flo', xbid: 'first' });
    gas.handle({ action: 'bid', slug: 'weekly', snym: 'gus',
      usid: 'usid-weekly-gus', xbid: 'second' });
    gas.handle({ action: 'reveal', slug: 'weekly' });
    const wkArc = 'weekly-archive1';
    const flo = await makePage(browser, DESKTOP);
    await flo.goto(BASE + '/weekly', { waitUntil: 'networkidle0' });
    await flo.waitForFunction(() => document.getElementById('status')
      .classList.contains('revealed'));
    ok(await flo.evaluate(() => {
      const b = document.getElementById('archive');
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !b.disabled;
    }), 'the Archive control is VISIBLE with the Closed stamp (real'
       + ' layout, not just DOM presence)');
    ok(await flo.evaluate(() => {
      const c = document.getElementById('closed')
        .getBoundingClientRect();
      const b = document.getElementById('archive')
        .getBoundingClientRect();
      const mid = (r) => (r.top + r.bottom) / 2;
      return Math.abs(mid(b) - mid(c)) < 3 && b.left >= c.right - 1;
    }), 'the Archive link SHARES the Closed line, to its right'
       + " (dreev's same-line ruling; centers, not tops — the"
       + ' hit-box padding moves box tops, never ink centers)');
    const open = await makePage(browser, DESKTOP);
    await open.goto(BASE + '/stillon', { waitUntil: 'networkidle0' });
    await addName(open, 'hal');
    await open.waitForSelector('.tile.mine');
    ok(await open.evaluate(() => {
      const r = document.getElementById('archive')
        .getBoundingClientRect();
      return r.width === 0 && r.height === 0;
    }), 'an open auction shows no Archive control (CSS off'
       + " .revealed, the Closed stamp's own convention)");
    // a ledger tip rides RIGHTWARD (the row pitch leaves no room
    // below: a bottom tip sat in the next row's lap) — pinned on an
    // OPEN page, the only place stars still render (the settled-
    // record ruling took them off closed pages)
    await open.hover('.tile .tu');
    await open.waitForFunction(() =>
      !document.getElementById('tip').hidden);
    ok(await open.evaluate(() => {
      const t = document.getElementById('tip').getBoundingClientRect();
      const star = document.querySelector('.tile .tu')
        .getBoundingClientRect();
      return t.left >= star.right && t.top < star.bottom;
    }), "a ledger tip rides its own row's band, to the right —"
       + " never the next row's lap");
    await open.mouse.move(5, 5);  // park the pointer off the ledger
    ok(await flo.evaluate(() => document.getElementById('evergreen')
         .getBoundingClientRect().width === 0),
       'an archive-less page shows no chain links yet: the slot is'
       + ' exactly as visible as its data');
    await shoot(flo, 'story-archive-closed');
    await flo.click('#archive');
    await flo.waitForFunction(() =>
      !document.getElementById('status').classList
        .contains('revealed'));
    await shoot(flo, 'story-archive-reborn');
    ok(await flo.evaluate(() =>
      document.querySelectorAll('#tiles .tile').length === 0), 
       'one click: the page reborn empty in place, ready for the'
       + ' next round');
    await flo.waitForFunction(() =>
      document.querySelector('#evergreen .arc') !== null);
    ok(await flo.evaluate(() => {
      const deck = [...document.querySelectorAll('#evergreen .arc')];
      return deck.length === 3
        && deck[0].dataset.to === 'weekly-archive1'
        && !deck[0].disabled && deck[1].disabled && deck[2].disabled
        && deck[0].getBoundingClientRect().width > 0;
    }), 'the reborn live page wears the transport deck, \u2039'
       + ' leading to its newest archive — visible even while open');
    ok(await flo.evaluate(() => {
      const r = document.getElementById('reveal')
        .getBoundingClientRect();
      const a = document.querySelector('#evergreen .arc')
        .getBoundingClientRect();
      return a.top - r.bottom >= 10;
    }), 'the tombstone slot BREATHES below the reveal button'
       + ' (dreev: "squished against the reveal button" — the'
       + " stamp's own 1.1rem rides every occupant of the slot)");
    const past = await makePage(browser, DESKTOP);
    await past.goto(BASE + '/' + wkArc, { waitUntil: 'networkidle0' });
    await past.waitForFunction(() => document.getElementById('status')
      .classList.contains('revealed'));
    ok(await past.evaluate(() => {
      const b = document.getElementById('archive');
      return b.disabled && document.getElementById('status')
        .textContent.includes('first');
    }), "the archived round reads whole at its archive URL, its own"
       + ' Archive control grayed');
    ok(await past.evaluate(() => {
      // (#evergreen is display:contents — no box of its own; the
      // buttons are the measurable truth)
      const arcs = [...document.querySelectorAll('#evergreen .arc')];
      return arcs.length === 3
        && arcs.every((a) => a.getBoundingClientRect().width > 0);
    }), 'the transport deck is VISIBLE beside the grayed Archive'
       + ' control (re-derived: buttons, not text links)');
    // the deck reads at a GLANCE and sits ON the line (dreev:
    // "too small and not aligned properly" — pinned at birth
    // henceforth, per his fastidiousness ruling)
    ok(await past.evaluate(() => {
      const arc = document.querySelector('#evergreen .arc');
      const cs = getComputedStyle(arc);
      return parseFloat(cs.fontSize) >= 22
        && cs.borderTopWidth === '1px'
        && cs.backgroundColor !== 'rgba(0, 0, 0, 0)';
    }), 'the deck glyphs are at least 1.4rem AND wear their chip'
       + ' (border + card paper): legible, pressable-looking,'
       + ' still quiet');
    ok(await past.evaluate(() => {
      const mid = (e) => {
        const r = e.getBoundingClientRect();
        return (r.top + r.bottom) / 2;
      };
      const c = mid(document.querySelector('#status .closed'));
      const a = mid(document.getElementById('archive'));
      const d = mid(document.querySelector('#evergreen .arc'));
      return Math.abs(d - c) < 2 && Math.abs(a - c) < 2;
    }), 'stamp, Archive, and deck share ONE optical centerline'
       + ' within 2px: the tombstone is a single aligned row');
    // the deck holds ONE screen position across the family (dreev:
    // "consistent place between archived and latest... important
    // for clicking between versions"): right-anchored, so the
    // stamp's variable-width date never moves it
    const deckRightPast = await past.evaluate(() =>
      [...document.querySelectorAll('#evergreen .arc')].pop()
        .getBoundingClientRect().right);
    const deckRightLive = await flo.evaluate(() =>
      [...document.querySelectorAll('#evergreen .arc')].pop()
        .getBoundingClientRect().right);
    ok(Math.abs(deckRightPast - deckRightLive) < 2,
       'the deck right-anchors at the SAME x on archived and live'
       + ' pages: the pointer stays put while paging versions ('
       + deckRightPast + ' vs ' + deckRightLive + ')');
    // the committed-name card balances: the invisible input chrome
    // below the name no longer bottom-weights the page's first card
    ok(await past.evaluate(() => {
      const card = document.querySelector('main > .card');
      return parseFloat(getComputedStyle(card).paddingBottom)
        < parseFloat(getComputedStyle(card).paddingTop);
    }), "the named page's first card trims its bottom padding: the"
       + ' dead input chrome stops bottom-weighting it');
    await auditLayout(past, 'archived round at its archive URL');
    await shoot(past, 'story-archive-wayhome');
    await past.click('#evergreen .arc[data-to="weekly"]:last-child');
    await past.waitForFunction(() =>
      location.pathname === '/weekly'
      && !document.getElementById('status').classList
           .contains('revealed'));
    ok(true, 'one press of \u00bb and flo is home: the live'
       + ' /weekly, open for the next round — no words needed');

    /* ===== THE PENDING GAVEL (dreev picked option A, 2026-08-10:
       the saved-then-failed whiplash fix — while a blub save is
       aloft the desc card wears the mini hammering gavel, so the
       optimistic paint is LEGIBLY unconfirmed) ===== */
    await flo.focus('#desctoggle');
    await flo.keyboard.press('Enter');
    await flo.waitForFunction(() => !document.getElementById('desc')
      .classList.contains('viewing'));
    await flo.type('#descedit', 'round two words');
    opDelay = 800;  // a live-ish settle: the drumroll window opens
    await flo.click('#descgo');
    await flo.waitForFunction(() => {
      const g = document.querySelector('#desc > .gavel.mini');
      return g !== null
        && getComputedStyle(g).opacity === '1';  // FULLY lit, not
                                 // the fade's first frame — the
                                 // shot must show the real thing
    });
    ok(await flo.evaluate(() => {
      const g = document.querySelector('#desc > .gavel.mini')
        .getBoundingClientRect();
      const card = document.getElementById('desc')
        .getBoundingClientRect();
      return g.top >= card.top && g.bottom <= card.bottom;
    }), 'while the save is aloft the desc card wears the hammering'
       + ' mini gavel at full ink, WHOLLY inside the card (it hung'
       + " off a one-line card's bottom edge before the centering)");
    await shoot(flo, 'story-pending-gavel');
    await flo.waitForFunction(() => {
      const g = document.querySelector('#desc > .gavel.mini');
      return !document.getElementById('desc').classList
        .contains('committed')
        && parseFloat(getComputedStyle(g).opacity) === 0;
    });
    ok(true, 'the settle retires gavel and tint together: the fade'
       + ' IS the confirmation, wordlessly');
    opDelay = 0;

    /* ===== THE SETTLED RECORD (dreev 2026-08-10: closed vs open
       was too subtle; his ratified anti-magic exception — a closed
       page's rows shed their controls outright) ===== */
    const rec = await makePage(browser, DESKTOP);
    await rec.goto(BASE + '/weekly-archive1',
      { waitUntil: 'networkidle0' });
    await rec.waitForFunction(() => document.getElementById('status')
      .classList.contains('revealed'));
    ok(await rec.evaluate(() => {
      const stars = [...document.querySelectorAll('#tiles .tu')];
      return stars.length > 0 && stars.every((e) =>
          e.classList.contains('selected')
            ? getComputedStyle(e).visibility === 'visible'
            : getComputedStyle(e).visibility === 'hidden')
        && [...document.querySelectorAll('#tiles .x')]
             .every((e) => e.getBoundingClientRect().width === 0)
        && document.querySelector('#status .addrow')
             .getBoundingClientRect().width === 0
        && document.querySelector('#status .legend')
             .getBoundingClientRect().width > 0;
    }), 'a closed page is a SETTLED RECORD: \u00d7s gone, + row gone'
       + ' (CSS alone retires it — the jsdom suite pins the source),'
       + ' unselected'
       + ' stars invisible but HOLDING THEIR COLUMN (dreev\'s'
       + ' amendment: "just unselected ones"), your star and the'
       + ' footnote stay');
    // the axis pin this page never had (the miss dreev caught):
    // hidden-star rows must keep header text over cell text
    ok(await rec.evaluate(() => {
      const textLeft = (e) => {
        const r = document.createRange();
        r.selectNode(e.firstChild);
        return r.getBoundingClientRect().left;
      };
      const cell = document.querySelector('#tiles .tile-name');
      const cs = getComputedStyle(cell);
      const cellText = cell.getBoundingClientRect().left
        + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
      return Math.abs(textLeft(document.querySelector('.th-person'))
        - cellText) < 1;
    }), 'the closed page keeps the header-over-cell text axis: the'
       + ' hidden stars still hold their column');
    const openBg = await flo.evaluate(() =>
      getComputedStyle(document.body).backgroundColor);
    const closedBg = await rec.evaluate(() =>
      getComputedStyle(document.body).backgroundColor);
    ok(openBg !== closedBg, 'the paper turns decisively at the'
       + ' close: parchment weather, visible across the room ('
       + openBg + ' vs ' + closedBg + ')');

    /* ===== THE RECORD'S STAR, END TO END (dreev's bug report +
       amendment, 2026-08-10): one browser types a bid as its
       first-latched seat, star-clicks the other seat — the
       unsubmitted draft rides along — submits THERE, a rival
       closes the round and then TAKES the browser's seat (the
       radio law leaves the browser's dvid on no claim at all),
       the browser archives and rides the deck back: the archived
       record still stars the seat it bid as, from the bids log's
       forensic column, no claim and no ledger entry needed. */
    const two = await makePage(browser, DESKTOP);
    await two.goto(BASE + '/tworound', { waitUntil: 'networkidle0' });
    await addName(two, 'ann');
    await two.waitForSelector('.tile.mine .rebid textarea');
    await addName(two, 'ben');
    await two.waitForFunction(() =>
      document.querySelectorAll('#tiles .tile').length === 2);
    await two.type('.tile.mine .rebid textarea', 'half a thought');
    await claimRow(two, 'ben');
    await two.waitForFunction(() => {
      const t = document.querySelector('.tile[data-snym="ben"]');
      return t !== null && t.classList.contains('mine');
    });
    ok(await two.evaluate(() => {
      const ed = document.querySelector(
        '.tile[data-snym="ben"] .rebid textarea');
      return ed !== null && ed.value === 'half a thought'
        && ed.getBoundingClientRect().width > 0
        && document.querySelector(
             '.tile[data-snym="ann"] .rebid') === null;
    }), "dreev's amendment in real ink: the unsubmitted draft rides"
       + " the star-switch into the new seat's editor, and the old"
       + ' seat sheds its editor');
    await two.focus('.tile.mine .rebid textarea');
    await two.keyboard.press('Enter');
    await two.waitForFunction(() =>
      document.querySelector('.tile.mine.has-bid') !== null);
    {
      const st = gas.handle({ action: 'state', slug: 'tworound' });
      const annUsid = st.seats.find((s) => s.snym === 'ann').usid;
      const benUsid = st.seats.find((s) => s.snym === 'ben').usid;
      gas.handle({ action: 'bid', slug: 'tworound', snym: 'ann',
        usid: annUsid, xbid: 'rival close', dvid: 'dev-two-rival' });
      gas.handle({ action: 'claim', slug: 'tworound', usid: benUsid,
        dvid: 'dev-two-rival', anym: 'the rival' });
    }
    await two.waitForFunction(() =>
      !document.getElementById('reveal').disabled, { timeout: 20000 });
    await two.click('#reveal');
    await two.waitForFunction(() => document.getElementById('status')
      .classList.contains('revealed'));
    await two.click('#archive');
    await two.waitForFunction(() =>
      !document.getElementById('status').classList.contains('revealed')
      && document.querySelectorAll('#tiles .tile').length === 0);
    await two.waitForFunction(() =>
      document.querySelector('#evergreen .arc') !== null);
    await Promise.all([
      two.waitForNavigation({ waitUntil: 'networkidle0' }),
      two.click('#evergreen .arc'),
    ]);
    await two.waitForFunction(() => document.getElementById('status')
      .classList.contains('revealed'));
    ok(await two.evaluate(() =>
      location.pathname === '/tworound-archive1'), 'the deck’s'
       + ' ‹ rides from the reborn page into the archive');
    ok(await two.evaluate(() => {
      const tu = (n) => document.querySelector(
        '.tile[data-snym="' + n + '"] .tu');
      return tu('ben').classList.contains('selected')
        && getComputedStyle(tu('ben')).visibility === 'visible'
        && !tu('ann').classList.contains('selected')
        && getComputedStyle(tu('ann')).visibility === 'hidden';
    }), 'the archived record stars the seat this browser BID AS —'
       + " ben, by the log's forensic column — through the rival's"
       + ' seat theft and with no ledger entry for the archive slug');
    await shoot(two, 'story-record-star');

    ok(pageErrors.length === 0,
       'ZERO page errors across every story flow (the net catches'
       + ' what asserts miss): ' + pageErrors.join(' | '));

    console.log('story-quals: all ' + passed + ' assertions passed');
  } finally {
    await browser.close();
    server.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });
