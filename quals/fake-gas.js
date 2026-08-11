// In-memory stand-in for the Apps Script services, hosting the REAL
// apps-script/Code.gs. Shared by every qual suite: gas-quals asserts on the
// fake sheet directly, frontend-quals bridges jsdom's fetch to handle(), and
// story-quals bridges headless Chrome's network to handle().
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  setValues(vals) {
    this.sheet.tally.writes++;
    this.sheet.tally.unflushed = true;
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
    this.sheet.tally.reads++;
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
  setValue(v) { return this.setValues([[v]]); }
  setNumberFormat(f) {
    this.sheet.tally.writes++;
    if (f === '@') {  // record armor depth for the armor quals
      this.sheet.plainTextRows = Math.max(
        this.sheet.plainTextRows, this.row + this.numRows - 1);
    }
    return this;
  }
  setFontWeight() { this.sheet.tally.writes++; return this; }
  setFontSize() { this.sheet.tally.writes++; return this; }
  setFontColor(c) {  // recorded so quals can check white-on-white sealing
    this.sheet.tally.writes++;
    this.sheet.colors[this.row + ',' + this.col] = c;
    return this;
  }
  setFontFamily(f) {  // recorded so quals can check header cosmetics
    this.sheet.tally.writes++;
    this.sheet.fonts[this.row + ',' + this.col] = f;
    return this;
  }
  setBackground(b) {  // ditto
    this.sheet.tally.writes++;
    this.sheet.backgrounds[this.row + ',' + this.col] = b;
    return this;
  }
}

let nextSheetId = 0;  // real tabs carry a numeric gid; so do fakes

class FakeSheet {
  constructor(name, tally = { reads: 0, writes: 0, opens: 0 }) {
    this.name = name;
    this.tally = tally;  // shared service-call meter (budget quals)
    this.data = [];
    this.colors = {};
    this.fonts = {};
    this.backgrounds = {};
    this.plainTextRows = 0;  // deepest row armored '@' (armor quals)
    this.sheetId = ++nextSheetId;
  }
  getName() { return this.name; }
  getSheetId() { return this.sheetId; }
  insertRowsAfter() { this.tally.writes++; }
  getRange(row, col, numRows = 1, numCols = 1) {
    return new FakeRange(this, row, col, numRows, numCols);
  }
  getDataRange() {
    return new FakeRange(this, 1, 1, Math.max(1, this.data.length),
      Math.max(1, ...this.data.map((r) => r.length)));
  }
  appendRow(arr) {
    this.tally.writes++;
    this.tally.unflushed = true;
    this.data.push(arr.slice());
  }
  deleteRow(n) {
    this.tally.writes++;
    this.tally.unflushed = true;
    this.data.splice(n - 1, 1);
  }
  getMaxRows() { return 1000; }
  setFrozenRows() {}
}

module.exports = function makeGas() {
  const tally = { reads: 0, writes: 0, opens: 0 };  // service-call meter
  tally.unflushedLockReleases = 0;
  tally.flushes = 0;
  // CacheService, honest: persistent across executions (unlike the
  // per-execution memos RESET clears) with TTL expiry — but against
  // a FAKE clock this harness owns. Default schedule: the clock hops
  // past any sane TTL at each entry point, so every request lands in
  // a fresh cache era and the rest of the suite keeps its
  // fresh-read-per-request semantics (direct __ss pokes stay visible
  // immediately). The cache quals freeze the clock to hold a window
  // open and advance it by hand to test expiry.
  let cacheNow = 0;
  let cacheFrozen = false;
  const cacheStore = {};
  // one-shot quota simulation: the next batchGet throws the
  // Google-shaped exception the real meter throws (2026-08-06's
  // production banner), then the meter breathes again
  let quotaTripAfter = Infinity;
  const ss = {
    sheets: {},
    getSheetByName(n) { return this.sheets[n] || null; },
    insertSheet(n) { return (this.sheets[n] = new FakeSheet(n, tally)); },
  };
  const ctx = {
    SpreadsheetApp: {
      openById: () => { tally.opens++; return ss; },
      flush: () => {
        tally.flushes++;
        tally.unflushed = false;
      },
    },
    LockService: { getScriptLock: () => ({
      waitLock() {},
      releaseLock() {
        if (tally.unflushed) tally.unflushedLockReleases++;
      },
    }) },
    ContentService: {
      createTextOutput: (s) => ({ body: s, setMimeType() { return this; } }),
      MimeType: { JSON: 'json' },
    },
    // The Advanced Sheets Service, batchGet only: ONE metered read
    // for any number of ranges. Fidelity quirks mirrored from the
    // real values API: trailing empty cells are trimmed from each
    // row, and a blank sheet's valueRange carries no values key.
    Sheets: { Spreadsheets: { Values: {
      batchGet: (id, opts) => {
        if (--quotaTripAfter === 0) {
          quotaTripAfter = Infinity;
          throw new Error("GoogleJsonResponseException: API call to"
            + ' sheets.spreadsheets.values.batchGet failed with'
            + " error: Quota exceeded for quota metric 'Read"
            + " requests' and limit 'Read requests per minute per"
            + " user' of service 'sheets.googleapis.com'");
        }
        // The real values API reads the backend over REST and CANNOT
        // see buffered SpreadsheetApp writes (live-quals caught a
        // claim missing from its own response). The fake enforces
        // the barrier loudly so the offline suite catches what only
        // the live smoke caught. (Direct ss.sheets pokes model
        // out-of-band sheet edits, which the REST read WOULD see.)
        if (tally.unflushed) {
          throw new Error('batchGet with unflushed SpreadsheetApp'
            + ' writes — the real values API cannot see them; call'
            + ' SpreadsheetApp.flush() first');
        }
        tally.reads++;
        return { valueRanges: opts.ranges.map((name) => {
          const rows = ss.sheets[name].data.map((r) => {
            let n = r.length;
            while (n > 0 && (r[n - 1] === '' || r[n - 1] === undefined)) {
              n--;
            }
            return r.slice(0, n);
          });
          while (rows.length > 0 && rows[rows.length - 1].length === 0) {
            rows.pop();
          }
          return rows.length === 0 ? { range: name }
                                   : { range: name, values: rows };
        }) };
      },
    },
    // The Advanced Sheets Service's WRITE face: ONE metered call
    // applying every request all-or-nothing — validated first,
    // applied second, mirroring Google's documented batch semantics
    // ("if one request is unsuccessful, none of the other ...
    // changes are written"). Only the updateCells shape batchWrite
    // emits is spoken; anything else refuses loudly before touching
    // a cell. REST writes are server-side commits: visible to the
    // next batchGet with no flush, so unflushed stays untouched.
    batchUpdate: (resource, id) => {
      const byId = {};
      Object.keys(ss.sheets).forEach((n) => {
        byId[ss.sheets[n].sheetId] = ss.sheets[n];
      });
      const reqs = (resource && resource.requests) || [];
      reqs.forEach((r) => {
        const u = r.updateCells;
        if (!u || !u.start || byId[u.start.sheetId] === undefined
            || u.fields !== 'userEnteredValue'
            || !Array.isArray(u.rows)) {
          throw new Error('fake batchUpdate: unsupported request '
            + JSON.stringify(r));
        }
      });
      tally.writes++;
      reqs.forEach((r) => {
        const u = r.updateCells;
        const sheet = byId[u.start.sheetId];
        u.rows.forEach((row, dr) => {
          const rowIdx = u.start.rowIndex + dr;
          while (sheet.data.length <= rowIdx) sheet.data.push([]);
          const cells = sheet.data[rowIdx];
          row.values.forEach((v, dc) => {
            const colIdx = u.start.columnIndex + dc;
            while (cells.length <= colIdx) cells.push('');
            cells[colIdx] = v.userEnteredValue.stringValue;
          });
        });
      });
    } } },
    CacheService: { getScriptCache: () => ({
      get: (k) => {
        const e = cacheStore[k];
        return e !== undefined && e.exp > cacheNow ? e.val : null;
      },
      put: (k, v, ttlS) => {
        cacheStore[k] = { val: String(v), exp: cacheNow + ttlS * 1000 };
      },
      remove: (k) => { delete cacheStore[k]; },
    }) },
    Logger: { log: () => {} },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(
    path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8'), ctx);
  // Real Apps Script resets globals every execution; one vm context
  // hosts the whole suite, so mirror that per request: clear the
  // per-execution memos before each entry point runs (defensively by
  // name, so the harness spans Code.gs versions of the memo scheme).
  // Correctness depends on it — quals also mutate the fake sheets
  // directly, which no memo invalidation can see.
  const clear = (g) => "if (typeof " + g + " !== 'undefined')"
    + " Object.keys(" + g + ").forEach(function (k) {"
    + " delete " + g + "[k]; });";
  const RESET = "if (typeof ssMemo !== 'undefined') ssMemo = null;"
    + "if (typeof wroteAny !== 'undefined') wroteAny = false;"
    + clear('sheetMemo') + clear('rowsMemo') + clear('tabsChecked');
  const reset = () => vm.runInContext(RESET, ctx);
  ['handle', 'doGet', 'doPost'].forEach((f) => {
    const raw = ctx[f];
    // an execution boundary auto-flushes in real Apps Script — and,
    // unless a cache qual froze the clock, lands in a fresh cache era
    ctx[f] = (e) => {
      reset();
      tally.unflushed = false;
      if (!cacheFrozen) cacheNow += 3600 * 1000;
      return raw(e);
    };
  });
  ctx.__ss = ss;  // the fake spreadsheet, for asserting on sheet contents
  ctx.__tally = tally;  // reads/writes/opens, for the budget quals
  ctx.__cacheCtl = {  // the cache quals' time machine
    freeze: () => { cacheFrozen = true; },
    thaw: () => { cacheFrozen = false; },
    advance: (ms) => { cacheNow += ms; },
  };
  ctx.__quotaTrip = () => { quotaTripAfter = 1; };
  ctx.__quotaTripAfter = (n) => { quotaTripAfter = n; };
  ctx.__quotaClear = () => { quotaTripAfter = Infinity; };
  return ctx;
};
