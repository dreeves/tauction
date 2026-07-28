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

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2 };
const NARROW = { width: 320, height: 844, deviceScaleFactor: 2 };
const DESKTOP = { width: 1200, height: 800 };


let passed = 0;
function ok(cond, label) {
  if (!cond) { console.error('FAIL: ' + label); process.exit(1); }
  passed++;
}

const gas = makeGas();
// server copy derived from Code.gs (via its vm context), same as the
// frontend suite does
const SCOPY = require('vm')
  .runInContext('({ gavelFellCopy, bidTooLongCopy })', gas);

// Answer any request to the deployed API URL with the local Code.gs
// logic; write ops can be artificially delayed for in-flight-race quals
let opDelay = 0;
async function bridge(page) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url().includes('ipwho.is')) {  // geo fixture: no network
      return req.respond({ status: 200, contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ city: 'Portland', region_code: 'OR' }) });
    }
    if (!req.url().startsWith('https://script.google.com/')) return req.continue();
    const q = req.method() === 'POST'
      ? JSON.parse(req.postData())
      : Object.fromEntries(new URL(req.url()).searchParams);
    const wait = ['add', 'remove', 'claim', 'release', 'bid', 'reveal',
                  'describe'].includes(q.action) ? opDelay : 0;
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
       && document.getElementById('aname').value === ''
       && document.activeElement === document.getElementById('aname')),
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
    await alice.type('#aname', 'brunch');
    await alice.keyboard.press('Enter');  // names commit on deliberate
                                          // gestures only, never a timer
    await alice.waitForFunction(() => location.pathname === '/brunch');
    ok(true, 'naming the auction navigates: /brunch');
    const slug = 'brunch';
    ok((await alice.$$('#status .tile:not(.addrow)')).length === 0,
       'no roster yet: the ledger is just the + row');
    // the description block: no label, placeholder says it; typing
    // markdown and clicking AWAY commits and renders it in place
    // (dreev's pencil-only model: the pencil is the only control,
    // and it only appears in rendered mode)
    ok(await alice.evaluate(() => {
      const t = document.getElementById('descedit');
      return getComputedStyle(t).display !== 'none'
        && t.placeholder.length > 0
        && getComputedStyle(document.getElementById('desctoggle'))
             .display === 'none'
        && !document.getElementById('descgo')
             .checkVisibility({ visibilityProperty: true })
        && getComputedStyle(document.getElementById('desc'))
             .borderTopColor !== 'rgba(0, 0, 0, 0)';
    }), 'the description sits between name and ledger, explaining'
       + ' itself by placeholder, boxed like the field it is — and'
       + ' its SAVE asleep while the field is cold');
    await alice.click('#descedit');
    await alice.type('#descedit', '# Rules\n\nLoser buys **coffee**');
    ok(await alice.evaluate(() =>
      document.getElementById('descgo')
        .checkVisibility({ visibilityProperty: true })
      && document.getElementById('descgo').textContent === saveCopy),
       "typing wakes SAVE on the desc card, wearing dreev's copy");
    await alice.click('#aname');  // clicking away...
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
    opDelay = 900;  // hold the describe in flight: a WRITE shows no
                    // busy sign at all (dreev 2026-07-28, the
                    // no-spinners ruling: the commit pulse is the
                    // feedback; failures banner; the gavel is for
                    // untrusted PICTURES, not writes)
    await alice.click('#descgo');  // SAVE
    ok(await alice.evaluate(() =>
      !document.querySelector('.gavel.mini')
      && !document.getElementById('desc').classList.contains('stale')
      && !document.getElementById('status').classList.contains('stale')
      && getComputedStyle(document.querySelector('#status > .gavel'))
           .opacity === '0'),
       'the in-flight blurb save shows NO busy sign anywhere: no'
       + ' gavel spins for a write');
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
      && document.getElementById('desctoggle').textContent.length > 0),
       'SAVE commits and renders rich (h1 + bold); the'
       + ' pencil appears, the only way back to the source');
    // the commit pulse tints the card green for a beat (your words
    // are away); the resting look this pin is about arrives when the
    // pulse fades — so outwait it, and bank that it fired at all
    await alice.waitForFunction(() => {
      const box = getComputedStyle(document.getElementById('desc'));
      return box.backgroundColor === 'rgba(0, 0, 0, 0)';
    });
    ok(await alice.evaluate(() => {
      const box = getComputedStyle(document.getElementById('desc'));
      return box.borderTopColor === 'rgba(0, 0, 0, 0)'
        && box.backgroundColor === 'rgba(0, 0, 0, 0)'
        && document.getElementById('desc').classList
             .contains('committed');
    }), 'and the rendered blurb pulses its commit, then sheds its box:'
       + ' prose on the page, not a field — the box itself says'
       + ' "editable here" (dreev)');

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
      const star = row.querySelector('.tu').getBoundingClientRect();
      const name = row.querySelector('.tile-name').getBoundingClientRect();
      const who = row.querySelector('.rename').getBoundingClientRect();
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
        && star.right < name.left
        && near(name.left - star.right, parseFloat(getComputedStyle(row).gap))
        && near(textLeft(document.querySelector('.th-person')), who.left)
        && near(addBox.left, name.left)
        && near(addBox.right, name.right)
        && plus && near((plus.left + plus.right) / 2,
                        (star.left + star.right) / 2)
        && near(addAt.left, who.left)
        && near(star.top, name.top) && near(star.bottom, name.bottom)
        && star.width >= 24 && star.height >= 24
        && near(textLeft(document.querySelector('.th-bid')), bidText);
    }), 'headings align with participant and bid text; star and + sit'
       + ' in the control gutter outside equal-height participant fields');
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

    // each ledger line is a FIELD and a CARD, the line itself
    // borderless; flex-start (not stretch) so a wrapped bid grows its
    // own card while the one-line field holds its height
    ok(await alice.evaluate(() => {
      const t = document.querySelector('#tiles .tile');
      const name = getComputedStyle(t.querySelector('.tile-name'));
      const bid = getComputedStyle(t.querySelector('.tile-bid'));
      return getComputedStyle(t).borderBottomWidth === '0px'
        && getComputedStyle(t).alignItems === 'flex-start'
        && name.borderTopWidth === '1px' && bid.borderTopWidth === '0px';
    }), 'a field for the person, a card for the bid, and a tall bid'
       + ' cannot inflate its neighbor');

    /* [FLIPPED twice: 2026-07-17 to blur-commits per frictionless-
       add; 2026-07-27 back — blur commits NOTHING (cletus's clobber).
       A typed name now WAITS with its SAVE, and the star click lands
       trivially: no hidden write, no rebuild mid-gesture.] */
    await alice.type('#roster-input', 'carol');
    await alice.click('.tile[data-uname="bob"] .tu');  // a radio switch
    await alice.waitForSelector('.tile[data-uname="bob"].mine',
                                { timeout: 2000 });
    ok(true, 'clicking a star works even mid-add: no hidden write, no'
       + ' rebuild, nothing to swallow the click');
    await new Promise((r) => setTimeout(r, 150));
    ok(await alice.evaluate(() =>
      !document.querySelector('.tile[data-uname="carol"]')
      && document.getElementById('roster-input').value === 'carol'
      && getComputedStyle(document.getElementById('roster-go'))
           .display !== 'none'),
       'and the tapped-away name is NOT committed: it waits in the'
       + ' + row, SAVE standing (the finger taps the button now)');
    await alice.click('#roster-go');
    await alice.waitForSelector('.tile[data-uname="carol"]');
    ok(await alice.$eval('#roster-input', (e) => e.value) === '',
       'SAVE lands carol and clears the row for the next name');
    await alice.click('.tile[data-uname="carol"] .x');  // tidy the scene
    await alice.waitForFunction(() =>
      !document.querySelector('.tile[data-uname="carol"]'));
    await alice.click('.tile[data-uname="alice"] .tu');  // and back
    await alice.waitForSelector('.tile[data-uname="alice"].mine');

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
    // itself?") — and its SAVE wakes only once the field is dirty
    await alice.click('.tile[data-uname="bob"] .rename input');
    ok(await alice.evaluate(() => {
      const cell = document.querySelector(
        '.tile[data-uname="bob"] .tile-name');
      const inp = cell.querySelector('.rename input');
      return getComputedStyle(cell).outlineWidth === '2px'
        && getComputedStyle(cell).outlineStyle === 'solid'
        && getComputedStyle(inp).boxShadow === 'none'
        && !cell.querySelector('.go')
             .checkVisibility({ visibilityProperty: true });
    }), 'editing a name rings the person cell itself, star lassoed'
       + ' like the + row rings its @ — no underline — and no SAVE'
       + ' yet: a clean field has nothing to commit (hot = dirty)');
    await alice.keyboard.type('by');
    ok(await alice.evaluate(() =>
      document.querySelector('.tile[data-uname="bob"] .rename .go')
        .checkVisibility({ visibilityProperty: true })),
       'the first typed character wakes SAVE');
    await alice.click('.legend');  // wander off mid-edit
    ok(await alice.evaluate(() =>
      document.querySelector('.tile[data-uname="bob"] .rename input')
        .value === 'bobby'
      && document.querySelector('.tile[data-uname="bob"] .rename .go')
           .checkVisibility({ visibilityProperty: true })),
       'a wandering click commits nothing and cannot dismiss the'
       + " draft's SAVE: dirty keeps it standing, focus or no");
    await alice.click('.tile[data-uname="bob"] .rename input');
    await alice.keyboard.press('Escape');  // never mind: bob is bob
    await alice.waitForFunction(() =>  // the 0.35s collapse grace
      !document.querySelector('.tile[data-uname="bob"] .rename .go')
        .checkVisibility({ visibilityProperty: true }));
    ok(await alice.evaluate(() =>
      document.querySelector('.tile[data-uname="bob"] .rename input')
        .value === 'bob'),
       'Escape reverts and SAVE stands down');
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
        document.dispatchEvent(new MouseEvent('mousemove',
          { clientX: r0.left + 3, clientY: r0.top + 3 }));
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
      document.querySelector('label[for="aname"]').focus());
    await alice.hover('.tile:not(.mine) .tu');  // hover wins...
    await alice.waitForFunction(() =>
      !document.getElementById('tip').hidden
      && document.getElementById('tip').textContent
         !== document.querySelector('label[for="aname"]')
              .getAttribute('data-tip'));
    await alice.mouse.move(5, 700);  // ...and leaves
    await alice.waitForFunction(() =>
      !document.getElementById('tip').hidden
      && document.getElementById('tip').textContent
         === document.querySelector('label[for="aname"]')
              .getAttribute('data-tip'));
    ok(true, 'hover gone: the focus-parked tip takes the stage back');
    await alice.evaluate(() =>
      document.querySelector('label[for="aname"]').blur());
    await alice.mouse.move(5, 400);  // park the pointer away from any tip
    await alice.keyboard.press('Tab');  // blur the last tooltip
    const overflow = await alice.evaluate(() =>
      document.scrollingElement.scrollWidth - window.innerWidth);
    ok(overflow <= 0, 'no horizontal overflow on phone (' + overflow + 'px)');
    await alice.setViewport(NARROW);
    await alice.waitForFunction(() => innerWidth === 320);
    ok(await alice.evaluate(() => {
      const near = (a, b) => Math.abs(a - b) < 1;
      const textLeft = (e) => {
        const r = document.createRange();
        r.selectNode(e.firstChild);
        return r.getBoundingClientRect().left;
      };
      const row = document.querySelector('#tiles .tile');
      const name = row.querySelector('.tile-name').getBoundingClientRect();
      const who = row.querySelector('.rename').getBoundingClientRect();
      const add = document.querySelector('.addrow .at-wrap')
        .getBoundingClientRect();
      const bid = row.querySelector('.bid-card, .rebid textarea');
      const box = bid.getBoundingClientRect();
      const css = getComputedStyle(bid);
      const bidText = box.left + parseFloat(css.borderLeftWidth)
        + parseFloat(css.paddingLeft);
      const thBid = document.querySelector('.th-bid');
      return document.scrollingElement.scrollWidth <= innerWidth
        && thBid.scrollWidth <= thBid.clientWidth + 1
        && box.width >= 3 * parseFloat(getComputedStyle(
          document.documentElement).fontSize)
        && near(textLeft(document.querySelector('.th-person')), who.left)
        && near(textLeft(thBid), bidText)
        && near(add.left, name.left) && near(add.right, name.right);
    }), 'at 320px the same text axes hold, both fields stay usable,'
       + ' and nothing scrolls sideways');
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
      const taken = document.querySelector('.tile[data-uname="alice"] .tu');
      const plain = document.querySelector('.tile[data-uname="bob"] .tu');
      // (post-takeover-ruling the taken star is enabled: dibs inform,
      // they don't lock — the fill and tip carry the message)
      return !taken.disabled && !plain.disabled
        && getComputedStyle(taken).opacity === '1'
        && alpha(getComputedStyle(taken).color) > 0.5
        && alpha(getComputedStyle(plain).color) === 0
        && taken.getAttribute('data-tip')
             === claimedByTip('Mac Chrome ' + navigator.language
                              + ' in Portland, OR');
    }), "alice's star fills in on bob's screen — claimed by someone"
       + ' else, says the tip, naming the rig — while open seats stay'
       + ' hollow');
    ok(await bob.evaluate(() => getComputedStyle(
         document.querySelector('#status .seal'), '::after').content)
       .then((c) => c.includes('\u{1F512}')), 'closed padlock while sealed');
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
    // universal button hygiene (dreev keeps catching stragglers): an
    // ACTIVATED button holds no focus — and the revealed seal wears
    // no tip at all now (dreev: obvious is obvious)
    await bob.mouse.move(10, 600);
    ok(await bob.evaluate(() =>
      document.activeElement !== document.getElementById('seal')),
       "pressing the padlock doesn't leave its tooltip stuck (the"
       + ' universal blur-on-activation rule)');
    ok(await bob.$eval('.tile.mine .rebid textarea', (e) => e.value)
       === 'my entire kingdom',
       "pressing the padlock reveals everything: alice's card + his own row");
    await bob.waitForFunction(() =>  // fade-in: wait, don't sample
      parseFloat(getComputedStyle(document.querySelector('#status .seal'))
        .opacity) === 1);
    ok(true, 'the icon comes to full strength at the reveal');
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
      document.querySelector('#status .seal'), '::after').content
        .includes('\u{1F389}'));
    ok(true,
       'the padlock becomes the tada at the strike: one icon, three states');
    ok(await bob.evaluate(() => {
      const alpha = (c) => {
        const m = c.match(/(?:rgba\([^)]+,\s*|\/\s*)([\d.]+)\)\s*$/);
        return m ? parseFloat(m[1]) : 1;
      };
      const s2 = document.getElementById('seal');
      return !s2.disabled && alpha(getComputedStyle(s2).color) === 1;
    }), 'the tada is never a disabled control at all (reveal is'
       + ' idempotent), so no UA sheet can wash it out');
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
        && getComputedStyle(document.querySelector('#status .seal'),
             '::after').content.includes('\u{1F389}')
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
      return Math.abs(textLeft(document.querySelector('.th-person'))
        - textLeft(document.querySelector('#status .closed'))) < 1;
    }), 'the Closed stamp starts on the participant-text axis');
    await bob.waitForFunction(() =>  // the ceremony self-cleans (the
      // confetti canvas is the library's own; it lingers, inert and
      // invisible, until the last long-lived piece times out)
      !document.querySelector('#status .fete'), { timeout: 6000 });
    ok(true, 'the ceremony packs up after itself');
    ok(await bob.$eval('#seal', (e) => e.getAttribute('data-tip'))
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
    await alice.evaluate(() => { document.getElementById('aname').value = ''; });
    // [names-are-chosen-once 2026-07-18: alice travels by URL now]
    await alice.goto(BASE + '/chores', { waitUntil: 'networkidle0' });
    ok(true, 'the URL is the navigation: /chores');
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
    await alice.waitForSelector('.tile.mine .rebid textarea');
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

    // Another machine's zed walks on with a bid (his × grays at once:
    // a bid protects its seat — removal of a bidder no longer exists,
    // dreev 2026-07-19); then alice ends early: × the bidless
    // straggler right off the ledger.
    gas.handle({ action: 'bid', aname: 'chores',
      uname: 'zed', pid: 'pid-chores-zed',
                 bid: 'zed was here' });
    await alice.waitForFunction(() =>
      document.querySelector('.tile[data-uname="zed"]'));
    ok(await alice.evaluate(() =>
      document.querySelector('.tile[data-uname="zed"] .x').disabled),
       "the walk-on's bid grays his × on arrival: a bid protects its"
       + ' seat');
    await alice.click('.tile[data-uname="evy"] .x');
    await alice.waitForFunction(() => !document.getElementById('seal').disabled);
    await alice.click('#seal');
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
    await carol.waitForSelector('.tile[data-uname="dog"].mine .rebid textarea',
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
      !document.querySelector('.gavel.mini')
      && !document.querySelector('#tiles .tile.stale')
      && !document.getElementById('status').classList.contains('stale')
      && getComputedStyle(document.querySelector('#status > .gavel'))
        .opacity === '0'
      && document.querySelector('.tile[data-uname="fox"]') !== null),
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
      && !document.querySelector('.gavel.mini')
      && getComputedStyle(document.querySelector('#status > .gavel'))
           .opacity === '0'
      && document.querySelector('.tile.mine .rebid .go').disabled),
       'a bid in flight: no gavel anywhere — just the quietly grayed'
       + ' SUBMIT holding the words already on the wire');
    opDelay = 0;
    await carol.waitForFunction(() =>
      !document.querySelector('.rebid.busy'));
    ok(true, 'the volley settles invisibly');
    /* ---- names are live text fields: click in, type, enter ------------ */
    await carol.click('.tile[data-uname="fox"] .rename input');
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
        '.tile[data-uname="fox"] .tile-name'));
      const inp = getComputedStyle(
        document.querySelector('.tile[data-uname="fox"] .rename input'));
      return cell.outlineStyle === 'solid' && cell.outlineWidth === '2px'
        && cell.outlineColor === accent
        && inp.outlineStyle === 'none' && inp.boxShadow === 'none';
    }), 'the focused name field highlights its whole cell in the'
       + ' focus accent, the at-wrap ring recipe');
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
    await thumb.waitForSelector('.tile[data-uname="bo"]');
    ok(true, 'the + row takes names from the return key');
    await thumb.waitForSelector('.tile.mine .rebid textarea');
    ok(true, 'her first thumbed-in name is hers (2j): editor ready');
    await thumb.type('.tile.mine .rebid textarea', 'thumb-typed bid');
    await thumb.keyboard.press('Enter');
    await thumb.waitForSelector('.tile.mine.has-bid');
    ok(true, 'return submits the bid: the editor keydown, no'
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
      !document.getElementById('seal').disabled);
    await thumb.tap('#seal');
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
    gas.handle({ action: 'add', aname: 'fatfinger',
      uname: 'alice', pid: 'pid-fat-alice' });
    gas.handle({ action: 'add', aname: 'fatfinger',
      uname: 'bob', pid: 'pid-fat-bob' });
    gas.handle({ action: 'describe', aname: 'fatfinger', base: '',
      blurb: 'A blurb, so the pencil shows.' });
    const fat = await makePage(browser, mobileViewport);
    await fat.goto(BASE + '/fatfinger', { waitUntil: 'networkidle0' });
    await fat.tap('.tile[data-uname="alice"] .tu');
    await fat.waitForSelector('.tile.mine .rebid textarea');
    await fat.type('.tile.mine .rebid textarea', 'draft');  // SUBMIT
                                    // stands only over a draft
    const fatFonts = await fat.evaluate(() =>
      ['#roster-input', '.rename input', '.tile.mine .rebid textarea',
       '#descedit', '.descview'].map((sel) => [sel, parseFloat(
        getComputedStyle(document.querySelector(sel)).fontSize)]));
    ok(fatFonts.every(([, px]) => px >= 16),
       'coarse pointer: every field and the blurb read at >=16px'
       + ' (no iOS zoom-jump): ' + JSON.stringify(fatFonts));
    const fatHits = await fat.evaluate(() =>
      ['.tile:not(.mine) .tu', '.tile:not(.mine) .x', '#seal',
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
    await shoot(fat, 'story5b-fatfinger-narrow');
    // the fence: a fine pointer (desktop) keeps today's exact compact
    // geometry — the touch ergonomics are the coarse pointer's alone
    const fine = await makePage(browser, DESKTOP);
    await fine.goto(BASE + '/fatfinger', { waitUntil: 'networkidle0' });
    ok(await fine.evaluate(() => {
      const star = document.querySelector('.tile .tu')
        .getBoundingClientRect();
      const bid = getComputedStyle(
        document.querySelector('.tile:not(.mine) .bid-card'));
      return Math.round(star.width) === 24 && Math.round(star.height) === 32
        && parseFloat(bid.fontSize) < 16;
    }), 'fine pointer: the compact desktop geometry is untouched');

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
    await fine2.waitForSelector('.tile[data-uname="bob"]');
    await fine2.evaluate(BELOW_JS);
    await fine2.click('.tile[data-uname="bob"] .rename input');
    await fine2.type('.tile[data-uname="bob"] .rename input', 'x');
    await fine2.click('#roster-input');
    await fine2.type('#roster-input', 'x');
    await fine2.click('#desctoggle');
    await fine2.type('#descedit', 'x');
    await fine2.click('.tile[data-uname="alice"] .tu');
    await fine2.waitForSelector('.tile.mine .rebid textarea');
    await fine2.type('.tile.mine .rebid textarea', 'x');
    const placements = await fine2.evaluate(() => [
      window.__below('.tile.mine .rebid textarea',
                     '.tile.mine .rebid .go'),
      window.__below('.tile[data-uname="bob"] .rename input',
                     '.tile[data-uname="bob"] .rename .go'),
      window.__below('#roster-input', '#roster-go'),
      window.__below('#descedit', '#descgo'),
    ]);
    ok(placements.every(([, isBelow, onRightFlank]) =>
         isBelow && onRightFlank),
       'every commit button sits below its field, on its right flank: '
       + JSON.stringify(placements));
    await shoot(fine2, 'story5c-buttons-below');
    const fresh = await makePage(browser, DESKTOP);
    await fresh.goto(BASE + '/', { waitUntil: 'networkidle0' });
    await fresh.evaluate(BELOW_JS);
    await fresh.type('#aname', 'gorows');
    ok((await fresh.evaluate(() =>
         window.__below('#aname', '#namego')))[1],
       "the auction name's Go sits below its field too");

    /* ================= Story 6: two thumbs, one alice ==================
       Roommates both open /squabble on their phones; the roster lists
       alice and bea, unclaimed. Phone 1 taps alice's star. Phone 2 —
       its screen still showing alice open (no poll yet) — taps alice
       too. Post-takeover-ruling (dreev 2026-07-21, after faire's
       lockout): the later tap TAKES the seat, phone 1 converges
       QUIETLY to the filled-but-live star (its tooltip naming the
       rig that took it), takes bea instead, and the game plays out
       normally — one holder per seat throughout, honor system. */
    gas.handle({ action: 'add', aname: 'squabble',
      uname: 'alice', pid: 'pid-squabble-alice' });
    gas.handle({ action: 'add', aname: 'squabble',
      uname: 'bea', pid: 'pid-squabble-bea' });
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
    await p2.waitForSelector('.tile[data-uname="alice"].mine');
    await p1.waitForFunction(() =>
      document.querySelector('.tile[data-uname="alice"] .tu.taken')
      && !document.querySelector('#tiles .rebid'));
    ok(await p1.evaluate(() =>
      document.getElementById('banner').hidden
      && !document.querySelector('.tile[data-uname="alice"] .tu')
           .disabled
      && document.querySelector('.tile[data-uname="alice"] .tu')
           .getAttribute('data-tip')
           // the tip up to the rig, whatever the copy says
           .startsWith(claimedByTip('').slice(0, -1))),
       'phone 1 is unseated QUIETLY: no red banner — the star fills'
       + ' in, stays live, and its tooltip says whose thumb took it');
    await p1.tap('.tile[data-uname="bea"] .tu');
    await p1.waitForSelector('.tile[data-uname="bea"].mine .rebid textarea');
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
      !document.getElementById('seal').disabled);
    await p1.tap('#seal');
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
    gas.handle({ action: 'add', aname: 'wirestory',
      uname: 'ann', pid: 'pid-wirestory-ann' });
    gas.handle({ action: 'add', aname: 'wirestory',
      uname: 'bee', pid: 'pid-wirestory-bee' });
    gas.handle({ action: 'bid', aname: 'wirestory',
      uname: 'bee', pid: 'pid-wirestory-bee',
                 bid: 'bee bid' });
    await wire.goto(BASE + '/wirestory', { waitUntil: 'networkidle0' });
    await claimRow(wire, 'ann');
    await wire.type('.tile.mine .rebid textarea', 'first word');
    await wire.keyboard.press('Enter');
    await wire.waitForSelector('.tile.mine.has-bid');
    await wire.click('.tile.mine .rebid textarea');
    await wire.keyboard.press('End');  // caret to the end, not the click point
    await wire.keyboard.type('!!!');  // a dirty, focused revision
    gas.handle({ action: 'reveal', aname: 'wirestory' });
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
    ok(gas.handle({ action: 'state', aname: 'wirestory' }).bids
         .find((b) => b.pid === 'pid-wirestory-ann').bid === 'first word',
       'the sheet keeps the pre-gavel bid');
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
        && parseFloat(getComputedStyle(
             document.getElementById('closed')).marginTop) > 12;
    }), 'a closed auction changes the weather: the body tints off the'
       + ' resting paper and the Closed line gets its air');

    /* ====== cletus and winifred, in a real browser ===================
       The frontend suite pins the logic; THIS pins the browser's
       event order — the banner's × is a mousedown that blurs the
       editor before the click lands, and that blur must write
       nothing (pre-fix it committed the silently re-based draft). */
    gas.handle({ action: 'describe', aname: 'clobstory',
      blurb: 'original', base: '' });
    const cle = await makePage(browser, DESKTOP);
    await cle.goto(BASE + '/clobstory', { waitUntil: 'networkidle0' });
    await cle.click('#desctoggle');  // pencil: to the source (focuses)
    await cle.keyboard.press('End');  // caret to the line's end
    await cle.keyboard.type(' plus cletus');
    // winifred lands from her own machine mid-draft...
    gas.handle({ action: 'describe', aname: 'clobstory',
      blurb: 'per winifred',
      base: gas.handle({ action: 'state', aname: 'clobstory' }).tblurb });
    await cle.waitForFunction(() =>
      !document.getElementById('banner').hidden);
    // ...cletus ×es the warning — the real mousedown-blur-click
    await cle.click('#banner-x');
    await new Promise((r) => setTimeout(r, 400));  // a blur-commit
                                    // would be on the wire by now
    ok(gas.handle({ action: 'state', aname: 'clobstory' }).blurb
         === 'per winifred'
       && await cle.evaluate(() =>
            document.getElementById('descedit').value
              === 'original plus cletus'
            && getComputedStyle(document.getElementById('descgo'))
                 .display !== 'none'),
       "dismissing the warning writes NOTHING: winifred's words stand"
       + " and cletus's draft waits beside its SAVE");
    // ...and the tab closes (drafts survive it, 2026-07-27): the
    // reload shows him winifred's version RENDERED — what the old
    // clobber never let him see — while his draft waits behind the
    // pencil, still his to insist on or abandon
    await cle.reload({ waitUntil: 'networkidle0' });
    await cle.waitForFunction(() =>
      document.getElementById('desc').classList.contains('viewing'));
    ok(await cle.evaluate(() =>
      document.getElementById('descview').textContent
        .includes('per winifred')
      && document.getElementById('descedit').value
           === 'original plus cletus'
      && !document.getElementById('descgo')
           .checkVisibility({ visibilityProperty: true })
      && getComputedStyle(document.getElementById('desctoggle'))
           .display !== 'none'),
       "the reload finally shows winifred's words, rendered — and"
       + " cletus's draft came home with the tab, parked behind the"
       + ' pencil (SAVE stays edit-mode-only)');
    await cle.click('#desctoggle');  // back to the source: the draft
    ok(await cle.evaluate(() =>
      document.getElementById('descgo')
        .checkVisibility({ visibilityProperty: true })),
       'opening the source wakes the restored draft\'s SAVE');
    // insisting is a deliberate press, and the button must survive
    // its own mousedown's blur to take the click
    await cle.click('#descgo');
    await cle.waitForFunction(() =>
      document.querySelector('#descview') !== null
      && document.getElementById('desc').classList.contains('viewing'));
    ok(gas.handle({ action: 'state', aname: 'clobstory' }).blurb
         === 'original plus cletus',
       'SAVE survives its own blur and lands the informed insist');

    /* ====== name, tab, enter (dreev's own fumble, verbatim) ==========
       He typed the auction name and hit Tab: pre-fix it either
       committed irreversibly (the Tab-commit era) or threw him into
       the browser chrome (the buttonless era). Expectata: Tab lands
       on the name's own commit button — the next control — and
       Enter presses it. */
    const crea = await makePage(browser, DESKTOP);
    await crea.goto(BASE + '/', { waitUntil: 'networkidle0' });
    await crea.type('#aname', 'tabname');
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
      document.getElementById('aname').disabled),
       'enter presses it: name, tab, enter — commit by convention,'
       + ' no hidden gesture');

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
    await zpage.type('#aname', 'chores');  // occupied: sticky banner
    await zpage.keyboard.press('Enter');   // (commit is a gesture now)
    await zpage.waitForFunction(() =>
      !document.getElementById('banner').hidden
      && document.querySelector('#banner a'));
    // The banner overlays the auction card, so the label beneath is
    // honestly unhoverable (hit-testing; the OLD qual compared
    // computed z without ever showing a tip — vacuous). Summon from
    // the seal instead: the tip must show with the banner standing,
    // at a ladder height above the banner's.
    await zpage.hover('#seal');
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
         e.getBoundingClientRect().height > h * 1.8
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
         e.getBoundingClientRect().height > h * 1.8
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
      {}, SCOPY.bidTooLongCopy);
    ok(await mo.$eval(ED, (e) => e.value.length === 170),
       "refused before the wire, in the server's words, draft intact");
    await mo.$eval(ED, (e) => e.select());
    await mo.type(ED, '$100');
    ok(await mo.$eval(ED, (e) => !e.classList.contains('error')),
       'trimmed under the limit, the objection withdraws live');
    await mo.keyboard.press('Enter');
    await mo.waitForFunction(() =>
      document.querySelectorAll('#tiles .tile.has-bid').length === 2);
    ok(await mo.evaluate(() =>
      document.getElementById('banner').hidden),
       'and the successful settle retires the stale objection banner');
    await mo.waitForFunction(() => !document.getElementById('seal').disabled);
    // the reveal, BY KEYBOARD (the 07-16 tab law died 2026-07-27:
    // every control is a tab stop and Enter activates it) — and the
    // keyboard's click must not trip the pointer blur-on-activation
    // rule: focus stays on the seal
    await mo.evaluate(() => document.getElementById('seal').focus());
    await mo.keyboard.press('Enter');
    await mo.waitForFunction((t) => document.getElementById('status')
      .textContent.includes(t), {}, LONGBID);
    ok(await mo.evaluate(() =>
      document.activeElement === document.getElementById('seal')
      && document.getElementById('seal').tabIndex !== -1),
       'the padlock answers the keyboard and keeps its focus: a'
       + ' keyboard-driven auction can actually close');
    ok(await mo.evaluate(() => {
      const long = document.querySelector(
        '.tile[data-uname="leo"] .bid-card');
      const short = document.querySelector(
        '.tile.mine .rebid').firstElementChild;
      return long.getBoundingClientRect().height
             > short.getBoundingClientRect().height * 1.8
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
    gas.handle({ action: 'add', aname: 'poembid', uname: 'zed',
      pid: 'pid-poem-zed' });
    gas.handle({ action: 'bid', aname: 'poembid', uname: 'zed',
      pid: 'pid-poem-zed', bid: 'a limerick' });
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
      !document.getElementById('seal').disabled);
    await poet.click('#seal');
    await reader.waitForFunction(() =>
      document.getElementById('status').classList.contains('revealed'));
    ok(await reader.evaluate(() => {
      const poem = document.querySelector(
        '.tile[data-uname="ann"] .bid-text');
      const one = document.querySelector(
        '.tile[data-uname="zed"] .bid-card');
      return poem.textContent === 'roses are red\nviolets are blue'
        && getComputedStyle(poem).whiteSpace === 'pre-wrap'
        // taller by at least a text line (padding keeps the naive
        // two-to-one height ratio under 1.7, so ratios mislead here)
        && poem.closest('.bid-card').getBoundingClientRect().height
           > one.getBoundingClientRect().height + 12
        && document.documentElement.scrollWidth <= window.innerWidth;
    }), 'revealed, the poem keeps its line break — the card grows'
       + ' downward, never sideways off the page');

    ok(pageErrors.length === 0,
       'ZERO page errors across every story flow (the net catches'
       + ' what asserts miss): ' + pageErrors.join(' | '));

    console.log('story-quals: all ' + passed + ' assertions passed');
  } finally {
    await browser.close();
    server.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });
