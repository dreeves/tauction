Table Auction.

Initially: sealed-bid auctions.
Web version of the
[sealed bidding bot](http://doc.dreev.es/sealedbids).

Hosted at 
[tauction.dreev.es](https://tauction.dreev.es)
via GitHub Pages.

---

AI-Generated text follows

---

## Architecture

Static frontend (this repo) on GitHub Pages. The database is
[a Google Sheet](https://docs.google.com/spreadsheets/d/1hclphAZ3zQIq14Nip1ZxTDSoE9ygXqAv27RwP1hiMA8/edit)
fronted by an Apps Script web app ([apps-script/Code.gs](apps-script/Code.gs))
that creates its own tabs on first use. The script exists because browsers
can read a public sheet but all programmatic writes require OAuth (see
appendix).

## One-time setup

1. Sheet → Extensions → Apps Script → paste in
   [apps-script/Code.gs](apps-script/Code.gs) → save. Run `authorize` from
   the toolbar's function dropdown and grant permissions (details in
   appendix). Deploy → New deployment → **Web app**, Execute as **Me**,
   access **Anyone** → copy the `/exec` URL.
2. Paste that URL into the `API` constant in [app.js](app.js). (To test
   first: append `?api=<exec-url>` to any tauction URL.)
3. Push to `main`; Settings → Pages → Deploy from branch → `main` / root.
   [CNAME](CNAME) claims tauction.dreev.es.
4. DNS: CNAME record `tauction` → `dreeves.github.io`.

## Local dev

```sh
python3 serve.py
# http://localhost:8000/?api=<exec-url>
```

Using VS Code's Live Server instead: [.vscode/settings.json](.vscode/settings.json)
sets `liveServer.settings.file` so unknown paths serve the app there too.

[serve.py](serve.py) mimics GitHub Pages: misses get [404.html](404.html) —
which is an exact copy of index.html (quals enforce it; after editing
index.html run `cp index.html 404.html`). So every `/slug` serves the app
directly: 404 status, but never a 404 page.

## Deploying Code.gs

```sh
npm run deploy   # quals, then clasp push + redeploy same URL + live smoke
```

One-time setup: toggle on the [Apps Script API](https://script.google.com/home/usersettings),
run `npx clasp login`, and put the script ID (Apps Script editor → Project
Settings → IDs) into [.clasp.json](.clasp.json). After that, no browser —
the repo is the source of truth and the manifest
([appsscript.json](apps-script/appsscript.json)) pins the web app's
execute-as-me/anyone settings.

## Quals

```sh
npm install   # once, for jsdom
npm run quals
```

Four suites in [quals/](quals/), all backed by the real Code.gs running on
an in-memory fake spreadsheet ([fake-gas.js](quals/fake-gas.js)): unit-level
API quals; the real index.html + app.js in jsdom; serve.py's 404 behavior;
and story quals that drive full user journeys in headless Chrome (needs
Chrome installed) with layout assertions, dropping screenshots in
`quals/screenshots/` for eyeballing.

## Data model

Vocabulary: an **aname** is an auction's name (also its URL slug); a
**uname** is a bidder's username.

| tab | columns |
|---|---|
| `auctions` | aname, created, updated, revealed |
| `participants` | aname, uname, device, created, updated |
| `bids` | aname, uname, bid, created, updated, subs |

A participants row IS a roster seat (insertion order = display order);
`device` is the claiming browser's anonymous uuid, '' when unclaimed.
Roster edits are row-level `add`/`remove` actions — commutative, so
concurrent edits from different people can't clobber each other. Future
per-person attributes (weights/shares, pids) append as columns on the
right, which positional reads tolerate. Bids: one row per (aname,
uname); re-bids overwrite and bump `subs`.

## Behavior

- Nothing ever reveals automatically. The padlock on the BIDS box is the
  reveal button: it unlocks (and pulses) once everyone on the roster — at
  least two people — has bid, and anyone may press it. Ending early =
  ex the straggler, then press.
- Bidding claims a roster seat. The only road to a struck-through row is
  being removed from the roster after bidding (the bid stays visible but
  no longer gates the reveal); re-bidding takes the seat back.
- Reveal is a one-way latch: nothing can ever reseal revealed bids.
- Everything stays editable, even after reveal: re-bids and roster edits
  are last-write-wins. Late bidders join publicly. Honor system throughout.
- Who-has-bid is public, with a per-bidder (re)submission counter; only bid
  contents are sealed (you always see the bids your own browser placed).
- Sealing is honor-system: the sheet itself is link-visible.

## Appendix: making any Google Sheet writable from a static site

Browsers can *read* a link-shared sheet directly (CORS is open):

```
https://docs.google.com/spreadsheets/d/<SHEET_ID>/export?format=csv
```

But all programmatic *writes* require OAuth, even on an
anyone-with-link-can-edit sheet. Anonymous incognito editing doesn't
contradict this: Google's own frontend treats the link as the credential and
mints an anonymous session against private endpoints — first-party machinery.
The public API has no anonymous principal; unauthenticated writes die with
401 `CREDENTIALS_MISSING` before sharing settings are consulted, and API keys
(which identify a project, not a person) are read-only by design.

The fix: a small Apps Script bound to the sheet, deployed as a web app. It
executes as you, so it can write; the static site calls it as a JSON API.

### 1. Create the script

Sheet → **Extensions → Apps Script** → paste over `Code.gs` → save. Nothing
runs yet: the script only runs when a function is invoked, never when the
sheet is edited. Minimal skeleton:

```js
const SHEET_ID = '<the long id from the sheet URL>';

function doGet(e)  { return respond(handle(e.parameter || {})); }
function doPost(e) { return respond(handle(JSON.parse(e.postData.contents))); }

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function handle(req) {
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  if (req.action === 'read')   return sh.getDataRange().getValues();
  if (req.action === 'append') { sh.appendRow([req.a, req.b]); return { ok: true }; }
  return { error: 'unknown action: ' + req.action };
}

// Run me once from the editor toolbar to trigger the permissions prompt
// (step 2 below)
function authorize() {
  Logger.log('Can touch sheet: ' + SpreadsheetApp.openById(SHEET_ID).getName());
}
```

Gotchas:

- No custom HTTP statuses or headers from Apps Script; return `{error: ...}`
  in the body and check client-side.
- Wrap writes in `LockService.getScriptLock()` against races.
- Sheets coerces values (`007` → `7`, `MAR1` → a date); format data columns
  as plain text: `range.setNumberFormat('@')`.
- Anyone with the URL can call it: validate everything server-side.

### 2. Authorize (once)

Toolbar function dropdown → `authorize` → **▷ Run** → "Authorization
required" → **Review permissions** → pick your account → "Google hasn't
verified this app" (expected; it's your own code) → **Advanced** → **Go to
\<project\> (unsafe)** → **Allow**. Checkpoint: the execution log prints the
sheet's name. The grant covers the whole project, so the deployed web app
inherits it.

**"Error 401: invalid_client (The OAuth client was not found)"**: Google
plumbing, usually multiple signed-in accounts. Pick the account the editor
runs as (avatar, top right); failing that, redo everything in an incognito
window with one account. Also check Project Settings → GCP project says
*Default*, or wait a few minutes if the project is brand new. (On a
world-editable sheet it doesn't matter *which* account deploys; the consent
account just has to match the editor's.)

### 3. Deploy

**Deploy → New deployment** → gear icon → **Web app**:

- **Execute as: Me**
- **Who has access: Anyone** — *not* "Anyone with Google account", which
  breaks `fetch` with an HTML login page.

Copy the `/exec` URL and sanity-check it (`-L` matters — it 302s to
`script.googleusercontent.com`):

```sh
curl -sL '<exec-url>?action=read'
```

### 4. Call it from the browser

```js
// read
const data = await (await fetch(EXEC_URL + '?action=read')).json();

// write — body is a plain string; do NOT set a Content-Type header
const res = await (await fetch(EXEC_URL, {
  method: 'POST',
  body: JSON.stringify({ action: 'append', a: 1, b: 2 }),
})).json();
```

Apps Script can't answer CORS preflights, so requests must be
["simple"](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS#simple_requests):
GETs, and POSTs with no custom headers. A string body defaults to
`text/plain` (just `JSON.parse` it in `doPost`); setting
`Content-Type: application/json` triggers a preflight and fails mysteriously.

### 5. Updating code (the #1 gotcha)

Saving edits does **not** change what `/exec` serves — that URL pins a
version. After every edit: **Deploy → Manage deployments → ✏️ → Version: New
version → Deploy**. Same URL, new code. ("New deployment" instead mints a
*different* URL — avoid.)

Or skip the browser entirely with [clasp](https://github.com/google/clasp):
`clasp push --force && clasp deploy -i <deploymentId>` — the deploymentId is
the `AKfycb...` chunk of the `/exec` URL. See "Deploying Code.gs" above for
the one-time setup.

### Limits & alternatives

Latency ~0.5–2s/call;
[quotas](https://developers.google.com/apps-script/guides/services/quotas)
are generous but real. For anonymous append-only writes, a linked Google
Form's `formResponse` endpoint needs no script at all. Outgrowing this means
a real backend with a service account.

## Spec (proposal, partially implemented): renameable people via person ids

**Update 2026-07-15:** the participants table shipped (subsuming the
earlier claims tab): a row per seat with the claiming device's uuid as a
column, row-level add/remove/claim actions, roster order from row order.
Claiming or bidding registers the device, one device holds at most one
name per auction, and every other page shows the row dibsed as soon as
a claim lands. Renames and pid-keyed bids below remain unimplemented;
weights/shares would be one more column here.

### Problem

A uname currently *is* the identity: it keys the bids rows, the roster
column, and the browser's memory of who you are (`tauction-uname`) and what
you bid (`tauction-mybids`). So names can't be edited — "renaming" would
orphan the old bid and mint a new person. Typo'd a name into the roster?
Only fix: remove it and add a corrected one, and only until they've bid.

### Proposal

Introduce a **pid** (person id, a UUID minted client-side at add-time).
Names become display labels hanging off pids; everything else keys by pid.

New tab, one person per row (this also answers "should each name live in
its own cell" — yes, and the auctions tab's comma-separated `roster` column
dies; roster membership = having a `people` row):

| tab | columns |
|---|---|
| `people` | aname, pid, uname, created, updated |
| `bids` | aname, **pid**, bid, created, updated, subs |
| `auctions` | aname, created, updated, revealed |

API becomes: `add(aname, uname) → pid`, `remove(aname, pid)`,
`rename(aname, pid, uname)`, `bid(aname, pid, bid)`, `reveal(aname)`;
`state` returns the people list (pid + uname) alongside bidders.

Client identity: `tauction-pids` = `{aname: pid}` map, written when you
claim a row (the (you) button) or add yourself. `tauction-mybids` re-keys
by pid. The global `tauction-uname` survives only as a display-name hint.

Renaming: an editable person cell (same in-place pattern as the bid cell —
your row's name becomes an input, enter commits `rename`). Bids, seals,
counters, reveal-gating all ride the pid and don't notice.

### What UUIDs do and don't buy

They buy **continuity** (renames don't orphan bids; two @sams can't collide
in the data), not **auth**: pids are readable in the public sheet, so any
device can claim any pid. Real device-binding would need a secret claim
token whose hash lives in the sheet, verified by Code.gs on bid/rename —
doable later, but it breaks the honor-system simplicity (lost device =
locked-out row = needs an escape hatch = no longer auth). Recommendation:
pids without tokens; sealing stays honor-system, exactly as today.

### Tricky cases

- **Duplicate names**: allowed in the data model (pids differ), but
  confusing on the ledger. Server rejects `add`/`rename` colliding with a
  live name in the same auction (fail loudly).
- **Rename to empty / invalid**: reject server-side (same `cleanUname`).
- **Who may rename whom**: consistent with roster edits — anyone, honor
  system, last-write-wins. (Tokens would change this; see above.)
- **Auto-relatch across auctions** (today: your remembered name re-latches
  you when it appears): names no longer prove identity, so auto-claiming a
  pid because its label matches your remembered name would hijack rows.
  Options: (a) drop auto-relatch, claiming is always explicit; (b) auto-
  claim only rows *you* just added from this device. (b) preserves the
  common flow; lean (b).
- **× semantics**: unchanged — removing a person deletes their people row;
  grayed out once they've bid (bids stay immortal, still keyed by their
  pid, name frozen at last value... which argues for keeping the people
  row and adding a `removed` flag instead. Open question.)
- **Claim races**: two devices claim one pid — both believe it; same as
  two devices typing the same uname today. Honor system.
- **Migration**: none. Delete the tabs (already planned for the schema
  cleanup); Code.gs recreates the new shape. Old auction URLs come up
  empty, acceptable pre-launch.
- **Ordering**: ledger order = people.created, so rows stop reshuffling
  when the roster is edited (a small win over the CSV roster).

### Open questions

1. Tokens (device-bound rows) — worth the honor-system break? Default no.
2. Removed-after-bidding: delete the people row or flag it?
3. Should `fresh`/first-visit mint a pid for you eagerly, or only on claim?

Estimated shape: Code.gs gains ~4 small actions and loses joinRoster's
CSV surgery; app.js's renderStatus keys rows by pid; quals for rename,
collision, re-claim, and the localStorage migration of nothing.
