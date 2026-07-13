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
run('npx', ['clasp', 'push', '--force']);
run('npx', ['clasp', 'deploy', '-i', DEPLOYMENT_ID, '-d', 'redeploy']);
run('node', [path.join(__dirname, 'quals', 'live-quals.js')]);
