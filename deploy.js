// Deploy Code.gs: clasp push, then redeploy the deployment whose /exec URL
// the frontend actually uses (single source of truth: the API constant in
// app.js — so the deployed URL and the frontend can't drift apart), then
// smoke-test the live API.
//
// Run: npm run deploy
'use strict';
const { execFileSync } = require('child_process');
const crypto = require('crypto');
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

// THE DEPLOY STAMP (dreev-ratified 2026-08-06): after each
// successful live smoke, .deploy-stamp (gitignored) records a hash
// of the server bytes just shipped; a later run whose bytes match
// exits up front instead of spending the whole quals+clasp+smoke
// cycle re-shipping an unchanged server (the habit-deploy after a
// frontend-only change). Missing or mismatched stamp always
// deploys — the safe direction: skipping can only ever suppress a
// re-ship, never a real change.

// content-addressed server identity: every file clasp would ship,
// name + bytes, order-independent
function serverHash(files) {
  const h = crypto.createHash('sha256');
  Object.keys(files).sort().forEach((name) => {
    h.update(name + '\0' + files[name] + '\0');
  });
  return h.digest('hex');
}

// stampText = raw .deploy-stamp content, or null when no stamp
// exists (a first run, a fresh clone — both defined states, both
// deploy); line 1 is the last smoked hash, line 2 a debugging clock
function alreadyShipped(hash, stampText) {
  return stampText !== null && stampText.split('\n')[0] === hash;
}

const STAMP = path.join(__dirname, '.deploy-stamp');

function gatherServer() {
  const dir = path.join(__dirname, 'apps-script');
  const files = {};
  // dotfiles excluded: clasp ships none of them, and a stray
  // .DS_Store must not move the hash
  fs.readdirSync(dir).filter((n) => !n.startsWith('.'))
    .forEach((n) => {
      files[n] = fs.readFileSync(path.join(dir, n), 'utf8');
    });
  return files;
}

function main() {
  const hash = serverHash(gatherServer());
  let stampText = null;
  try { stampText = fs.readFileSync(STAMP, 'utf8'); } catch (e) {}
  if (alreadyShipped(hash, stampText)) {
    console.log('server unchanged since the last successful deploy'
      + ' (.deploy-stamp ' + hash.slice(0, 12) + ') — nothing to'
      + ' clasp; frontend changes ship by git push alone');
    return;
  }
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
  // (The sync-404 step retired 2026-08-12: Pages derives its own 404
  // file from index.html at publish time, so there is no mirror left
  // for a deploy to re-derive — or for anyone to forget.)
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
  // the smoke passed (either try): these bytes are live — stamp them
  fs.writeFileSync(STAMP, hash + '\n' + new Date().toISOString() + '\n');
  console.log('deploy stamped ' + hash.slice(0, 12));
}

module.exports = { eraGuard, serverHash, alreadyShipped };
if (require.main === module) main();
