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

// THE ERA GUARD (dreev-ratified 2026-08-06): clasp ships the WORKING
// TREE while Pages serves origin/main, so a deploy from a tree git
// hasn't fully blessed splits production into two eras (it happened,
// 2026-08-05: refactor committed, never pushed, deployed — every
// visitor ate ERROR2157 until the push). The tree must be clean of
// tracked changes ANYWHERE (Pages ships everything tracked), carry
// nothing untracked under apps-script/ (clasp would ship bytes no
// commit pins), and HEAD must be contained in origin/main:
// push-then-deploy is the enforced order, and the transient window
// that leaves is the direction the ERROR2157 hint names. Pure
// function over git's own facts (status --porcelain text + the
// merge-base ancestry bit) so the quals drive it without a repo;
// returns null to stand aside, else the marching orders.
function eraGuard(porcelain, pushed) {
  const lines = porcelain.split('\n').filter((l) => l !== '');
  const blockers = lines.filter((l) => !l.startsWith('??')
    || l.slice(3).startsWith('apps-script/'));
  if (blockers.length > 0) {
    return 'uncommitted work would deploy an era git never blessed:\n'
      + blockers.join('\n')
      + '\ncommit and push first — the tree that deploys must be the'
      + ' tree the site serves';
  }
  if (!pushed) {
    return 'HEAD is not contained in origin/main: Pages would keep'
      + ' serving the old page against the new Code.gs (ERROR2157'
      + ' for everyone, as on 2026-08-05). Push main, THEN deploy.';
  }
  return null;
}

function main() {
  const porcelain = execFileSync('git', ['status', '--porcelain'],
    { cwd: __dirname, encoding: 'utf8' });
  let pushed = true;
  try {
    execFileSync('git',
      ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'],
      { cwd: __dirname, stdio: 'ignore' });
  } catch (e) { pushed = false; }
  const orders = eraGuard(porcelain, pushed);
  if (orders !== null) {
    console.error('deploy refused — ' + orders);
    process.exit(1);
  }
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
}

module.exports = { eraGuard };
if (require.main === module) main();
