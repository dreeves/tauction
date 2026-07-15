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
  setNumberFormat() { return this; }
  setFontWeight() { return this; }
  setFontSize() { return this; }
  setFontColor(c) {  // recorded so quals can check white-on-white sealing
    this.sheet.colors[this.row + ',' + this.col] = c;
    return this;
  }
}

class FakeSheet {
  constructor(name) { this.name = name; this.data = []; this.colors = {}; }
  getRange(row, col, numRows = 1, numCols = 1) {
    return new FakeRange(this, row, col, numRows, numCols);
  }
  getDataRange() {
    return new FakeRange(this, 1, 1, Math.max(1, this.data.length),
      Math.max(1, ...this.data.map((r) => r.length)));
  }
  appendRow(arr) { this.data.push(arr.slice()); }
  deleteRow(n) { this.data.splice(n - 1, 1); }
  getMaxRows() { return 1000; }
  setFrozenRows() {}
}

module.exports = function makeGas() {
  const ss = {
    sheets: {},
    getSheetByName(n) { return this.sheets[n] || null; },
    insertSheet(n) { return (this.sheets[n] = new FakeSheet(n)); },
  };
  const ctx = {
    SpreadsheetApp: { openById: () => ss },
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
  ctx.__ss = ss;  // the fake spreadsheet, for asserting on sheet contents
  return ctx;
};
