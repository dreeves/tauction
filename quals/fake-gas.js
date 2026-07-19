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
  setNumberFormat() { this.sheet.tally.writes++; return this; }
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

class FakeSheet {
  constructor(name, tally = { reads: 0, writes: 0, opens: 0 }) {
    this.name = name;
    this.tally = tally;  // shared service-call meter (budget quals)
    this.data = [];
    this.colors = {};
    this.fonts = {};
    this.backgrounds = {};
  }
  getName() { return this.name; }
  getRange(row, col, numRows = 1, numCols = 1) {
    return new FakeRange(this, row, col, numRows, numCols);
  }
  getDataRange() {
    return new FakeRange(this, 1, 1, Math.max(1, this.data.length),
      Math.max(1, ...this.data.map((r) => r.length)));
  }
  appendRow(arr) { this.tally.writes++; this.data.push(arr.slice()); }
  deleteRow(n) { this.tally.writes++; this.data.splice(n - 1, 1); }
  getMaxRows() { return 1000; }
  setFrozenRows() {}
}

module.exports = function makeGas() {
  const tally = { reads: 0, writes: 0, opens: 0 };  // service-call meter
  const ss = {
    sheets: {},
    getSheetByName(n) { return this.sheets[n] || null; },
    insertSheet(n) { return (this.sheets[n] = new FakeSheet(n, tally)); },
  };
  const ctx = {
    SpreadsheetApp: { openById: () => { tally.opens++; return ss; } },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      createTextOutput: (s) => ({ body: s, setMimeType() { return this; } }),
      MimeType: { JSON: 'json' },
    },
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
    + clear('sheetMemo') + clear('rowsMemo') + clear('tabsChecked');
  const reset = () => vm.runInContext(RESET, ctx);
  ['handle', 'doGet', 'doPost'].forEach((f) => {
    const raw = ctx[f];
    ctx[f] = (e) => { reset(); return raw(e); };
  });
  ctx.__ss = ss;  // the fake spreadsheet, for asserting on sheet contents
  ctx.__tally = tally;  // reads/writes/opens, for the budget quals
  return ctx;
};
