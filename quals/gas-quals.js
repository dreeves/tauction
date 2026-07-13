// Quals for apps-script/Code.gs: stub the Apps Script services
// (SpreadsheetApp/LockService/ContentService) with an in-memory fake
// spreadsheet, load Code.gs, and run the API through its paces.
//
// Run: node quals/gas-quals.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const CODE_GS = path.join(__dirname, '..', 'apps-script', 'Code.gs');

/* ------------------------- fake Apps Script --------------------------- */

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  setValues(vals) {
    assert.strictEqual(vals.length, this.numRows, 'setValues row count');
    for (let r = 0; r < this.numRows; r++) {
      assert.strictEqual(vals[r].length, this.numCols, 'setValues col count');
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
  setNumberFormat() { return this; }
  setFontWeight() { return this; }
}

class FakeSheet {
  constructor(name) { this.name = name; this.data = []; }
  getRange(row, col, numRows = 1, numCols = 1) {
    return new FakeRange(this, row, col, numRows, numCols);
  }
  getDataRange() {
    const rows = Math.max(1, this.data.length);
    const cols = Math.max(1, ...this.data.map(r => r.length));
    return new FakeRange(this, 1, 1, rows, cols);
  }
  appendRow(arr) { this.data.push(arr.slice()); }
  getMaxRows() { return 1000; }
  setFrozenRows() {}
}

class FakeSpreadsheet {
  constructor() { this.sheets = {}; }
  getSheetByName(n) { return this.sheets[n] || null; }
  insertSheet(n) { return (this.sheets[n] = new FakeSheet(n)); }
}

const ss = new FakeSpreadsheet();
const ctx = {
  SpreadsheetApp: { openById: () => ss },
  LockService: {
    getScriptLock: () => ({ waitLock() {}, releaseLock() {} }),
  },
  ContentService: {
    createTextOutput: (s) => ({ body: s, setMimeType() { return this; } }),
    MimeType: { JSON: 'json' },
  },
  Logger: { log: () => {} },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(CODE_GS, 'utf8'), ctx);

const call = (req) => ctx.handle(req);

/* ------------------------------ quals --------------------------------- */

let passed = 0;
function ok(cond, label) {
  if (!cond) { console.error('FAIL: ' + label); process.exit(1); }
  passed++;
}

// 1. state of a virgin auction: defaults, creates no rows
let st = call({ action: 'state', auction: 'TAU' });
ok(st.slug === 'tau' && st.mode === 'count' && st.n === 2, 'virgin defaults');
ok(st.revealed === false && st.bids === null && st.bidders.length === 0,
   'virgin unrevealed');
ok(ss.sheets['auctions'].data.length === 1, 'state read creates no rows');

// 2. doGet / doPost plumbing
let viaGet = JSON.parse(ctx.doGet({ parameter: { action: 'state', auction: 'tau' } }).body);
ok(viaGet.slug === 'tau', 'doGet plumbing');
let viaPost = JSON.parse(ctx.doPost({ postData: { contents:
  JSON.stringify({ action: 'state', auction: 'tau' }) } }).body);
ok(viaPost.slug === 'tau', 'doPost plumbing');
ok(JSON.parse(ctx.doPost({ postData: { contents: '{oops' } }).body).error,
   'doPost bad JSON -> error');
ok(JSON.parse(ctx.doGet({}).body).ok, 'bare GET -> friendly liveness JSON');

// 3. first bid (mixed case + padding get normalized)
st = call({ action: 'bid', auction: 'Tau', name: 'Alice', bid: '  3 tacos ' });
ok(!st.error, 'bid accepted: ' + st.error);
ok(st.bidders.length === 1 && st.bidders[0] === 'alice', 'bidder recorded');
ok(st.revealed === false && st.bids === null, 'sealed at 1 of 2');
ok(ss.sheets['bids'].data[1][2] === '3 tacos', 'bid trimmed');
ok(ss.sheets['auctions'].data[1][0] === 'tau', 'default settings row created');

// 4. re-bid overwrites, doesn't duplicate
st = call({ action: 'bid', auction: 'tau', name: 'alice', bid: 'sushi' });
ok(st.bidders.length === 1, 're-bid does not duplicate');
ok(ss.sheets['bids'].data.length === 2, 'still one bid row');
ok(ss.sheets['bids'].data[1][2] === 'sushi', 're-bid overwrites');

// 5. second bidder triggers reveal (count mode, n=2)
st = call({ action: 'bid', auction: 'tau', name: 'bob', bid: '$40' });
ok(st.revealed === true, 'revealed at n=2');
ok(st.bids.length === 2 && st.bids[0].name === 'alice'
   && st.bids[0].bid === 'sushi' && st.bids[1].bid === '$40', 'bids exposed');

// 6. locked after reveal
ok(call({ action: 'bid', auction: 'tau', name: 'carl', bid: 'late' })
   .error.includes('revealed'), 'late bid rejected');
ok(call({ action: 'settings', auction: 'tau', mode: 'count', n: 5 })
   .error.includes('revealed'), 'settings locked after reveal');

// 7. roster mode
st = call({ action: 'settings', auction: 'gluon', mode: 'roster', n: 2,
            roster: ['Dee', 'evy', 'dee'] });
ok(!st.error && st.mode === 'roster', 'roster settings saved');
ok(st.roster.join(',') === 'dee,evy', 'roster deduped + normalized');
st = call({ action: 'bid', auction: 'gluon', name: 'dee', bid: 'I bid 2 dishes' });
ok(st.revealed === false, 'waiting on evy');
st = call({ action: 'bid', auction: 'gluon', name: 'rando', bid: 'me too!' });
ok(st.revealed === false, 'non-roster bidder does not trigger reveal');
st = call({ action: 'bid', auction: 'gluon', name: 'evy', bid: '1 dish + dessert' });
ok(st.revealed === true && st.bids.length === 3, 'reveals when roster complete');

// 8. settings update on existing auction (upsert, not append)
st = call({ action: 'settings', auction: 'muon', mode: 'count', n: 3 });
st = call({ action: 'settings', auction: 'muon', mode: 'count', n: 4 });
ok(st.n === 4, 'settings updated');
ok(ss.sheets['auctions'].data.filter(r => r[0] === 'muon').length === 1,
   'settings upsert, not append');

// 9. validation
ok(call({ action: 'bid', auction: 'ta_u', name: 'a', bid: 'x' }).error,
   'bad slug rejected');
ok(call({ action: 'bid', auction: 'tau2', name: '1abc', bid: 'x' }).error,
   'name starting with digit rejected');
ok(call({ action: 'bid', auction: 'tau2', name: 'a b', bid: 'x' }).error,
   'name with space rejected');
ok(call({ action: 'bid', auction: 'tau2', name: 'abc', bid: '' }).error,
   'empty bid rejected');
ok(call({ action: 'bid', auction: 'tau2', name: 'abc', bid: 'y'.repeat(81) })
   .error, '81-char bid rejected');
ok(!call({ action: 'bid', auction: 'tau2', name: 'abc', bid: 'y'.repeat(80) })
   .error, '80-char bid accepted');
ok(call({ action: 'nonsense' }).error, 'unknown action rejected');

// 10. fresh avoids used slugs
for (let i = 0; i < 30; i++) {
  const s = call({ action: 'fresh' }).slug;
  ok(!['tau', 'gluon', 'muon', 'tau2'].includes(s), 'fresh slug unused: ' + s);
}

console.log('gas-quals: all ' + passed + ' assertions passed');
