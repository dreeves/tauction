# τauction

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

[serve.py](serve.py) mimics GitHub Pages: misses get [404.html](404.html),
which stashes the URL and bounces through `/`, so `/tau`-style paths survive
reloads. Stock `python3 -m http.server` 404s on reload, since app.js rewrites
`/` to `/<slug>`.

## Quals

```sh
npm install   # once, for jsdom
npm run quals
```

Three suites in [quals/](quals/): the Code.gs logic on an in-memory fake
spreadsheet; the real index.html + app.js in jsdom bridged to that same
logic, including the reload stash-and-restore journey (one "Not implemented:
navigation" line is expected); and serve.py's 404 behavior.

## Data model

| tab | columns |
|---|---|
| `auctions` | auction, mode (`count`\|`roster`), n, roster (comma-sep), created, updated |
| `bids` | auction, name, bid, created, updated |

One row per (auction, bidder); re-bids overwrite.

## Behavior

- Bids are sealed until the reveal condition — N distinct bidders (default 2)
  or a named roster has all bid — then everything locks.
- Who-has-bid is public. Re-bids and settings edits are last-write-wins until
  reveal.
- Non-roster people can bid; the reveal just doesn't wait on them.
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

### Limits & alternatives

Latency ~0.5–2s/call;
[quotas](https://developers.google.com/apps-script/guides/services/quotas)
are generous but real. For anonymous append-only writes, a linked Google
Form's `formResponse` endpoint needs no script at all. Outgrowing this means
a real backend with a service account.
