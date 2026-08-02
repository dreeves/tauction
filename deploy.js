// Deploy Code.gs: clasp push, then redeploy the deployment whose /exec URL
// the frontend actually uses (single source of truth: the API constant in
// app.js — so the deployed URL and the frontend can't drift apart), then
// smoke-test the live API.
//
// Run: npm run deploy
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const APP_JS = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const DEPLOYMENT_ID = APP_JS.match(/\/macros\/s\/([A-Za-z0-9_-]+)\/exec/)[1];

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
// Deploying is a BUILD, so derived artifacts are re-derived first;
// the quals then audit the result. (The qual command itself must
// never run sync-404 — an auditor doesn't rewrite what it inspects;
// serve-quals pins that.)
run('npm', ['run', 'sync-404']);
run('npm', ['run', 'quals']);  // never deploy on red
run('npx', ['clasp', 'push', '--force']);
run('npx', ['clasp', 'deploy', '-i', DEPLOYMENT_ID, '-d', 'redeploy']);
// The /exec URL can serve the PREVIOUS version for a few seconds
// after a redeploy (it happened: the live smoke hit the stale code
// and failed, then passed seconds later by hand). One bounded retry
// after a breath, then fail for real.
try {
  run('node', [path.join(__dirname, 'quals', 'live-quals.js')]);
} catch (e) {
  console.log('live smoke failed once — possibly redeploy'
    + ' propagation; retrying in 15s');
  execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 15000)']);
  run('node', [path.join(__dirname, 'quals', 'live-quals.js')]);
}
