// All UI/microcopy that app.js generates. Parameterized copy is an arrow function
// See also static copy in index.html (placeholders, help text, HTML tooltips).
// Code.gs's user-visible errors live in the microcopy block at the top of 
// Code.gs (separate deployment, can't share this file). The quals derive copy
// from here, so edits here never break them.
'use strict';

// The star radio's tooltips: yours, locked yours, someone else's
// (with their self-reported rig), too-late, and claimable
const disclaimTip = 'Disclaim as you';
const lockedTip = 'Locked in as you';
const tooLateTip = 'Too late to claim as you';
const claimTip = 'Claim as you';
const claimedByTip = (blurb) => 'Claimed by someone (' + blurb + ')';

// The ×'s tooltips: live and grayed
const removeTip = (uname) => 'remove @' + uname;
const tooLateRemoveTip = (uname) => 'too late to remove @' + uname;

// The padlock's tooltips (the "Reveal bids!" one lives in index.html;
// the revealed 🎉 wears none — dreev: obvious is obvious)
const needTwoTip = 'Need at least two bidders';
const needOneMoreTip = 'Need at least one more bidder';
const waitingTip = (roll) => 'Waiting for ' + roll + ' to bid...';
const youTag = ' (you)';

// The bid cell's tooltips: nothing yet, submitted once (yours/theirs),
// and resubmitted
const awaitingTip = 'awaiting bid...';
const submittedTip = (whose, ago) => whose + ' submitted ' + ago + ' ago';
const yourBidWord = 'your bid';
const bidWord = 'bid';
const resubmittedTip = (tini, tmod) =>
  'first submitted ' + tini + ' ago, resubmitted ' + tmod + ' ago';

// The Closed line under a finished auction
const closedLine = (stamp) => 'Closed ' + stamp;

// The reveal ceremony's rubber stamp, and the money it rains
const stampCopy = 'SOLD';
const moneyGlyphs = ['$', '¥', '£', '\u{1fa99}', '⚖️'];

// The blurb's unknown-device fallback (when user-agent comes up empty)
const mysteryDevice = 'mystery device';

// The typed-name gate: names you type CREATE auctions; occupied ones
// point you at the URL — which is a real link, because an installed
// PWA has no URL bar to fall back on (dreev). Renders via innerHTML:
// the url is app-built from a sanitized slug, never user text.
const auctionExistsBanner = (url) =>
  'Auction exists — use <a href="' + url + '">the URL</a> to join it';

// renaming onto a name that's already seated: the client pre-checks
// its own roster, the server refuses stale-roster races — identical
// words (a qual pins the match), so both read as one message
const nameTakenBanner = 'That name is taken';

// Someone saved the description while you were editing yours (also
// thrown by the server's compare-and-swap; must match it exactly so
// the back-to-back banners read as one)
const simulEditsBanner = 
  'Oops, someone else is making simultaneous edits to the description';

// Plumbing failures we expect to never see
const e2152 = (msg) => 'ERROR2152: ' + msg;  // poll fetch failed
const e2153 = (msg) => 'ERROR2153: ' + msg;  // bid POST failed
const e2154 = (msg) => 'ERROR2154: ' + msg;  // roster op POST failed
const e2155 = (msg) => 'ERROR2155: ' + msg;  // reveal POST failed
const e2156 = 'ERROR2156: Missing API constant in app.js';
const e2157 = (msg) => 'ERROR2157: ' + msg;  // auction-name probe failed
const copyFailBanner = (msg) => 'could not copy: ' + msg;
