// All UI/microcopy that app.js generates. Parameterized copy is an arrow function
// See also static copy in index.html (placeholders, help text, HTML tooltips).
// Code.gs's user-visible errors live in the microcopy block at the top of 
// Code.gs (separate deployment, can't share this file). The quals derive copy
// from here, so edits here never break them.
'use strict';

// The auction-name LABEL's frozen-state tooltip (dreev's copy; its
// editable-state sibling lives on the label in index.html). Once the
// name commits, the field is the page's title and its URL — no
// longer a place to type — and the label's tip flips to say so
// rather than cluttering the UI with a second tip. Alea iacta est.
const nameStoneTip = 'Name of this auction; also its URL';

// The star radio's tooltips: yours, locked yours, someone else's
// (with their self-reported rig), too-late, and claimable
const disclaimTip = 'Disclaim as you';
const lockedTip = 'Locked in as you';
const tooLateTip = 'Too late to claim as you';
const claimTip = 'Claim as you';
const claimedByTip = (blurb) => 'Claimed by someone (' + blurb + ')';

// The ×'s tooltips: live and grayed
const removeTip = (uname) => 'Remove @' + uname;
const tooLateRemoveTip = (uname) => 'Too late to remove @' + uname;

// The padlock's tooltips (the revealed 🎉 wears none — dreev:
// obvious is obvious). revealTip moved here verbatim from
// index.html 2026-07-18, retiring the SEAL_TIP cache hack; the
// resting page wears needTwoTip (the truth of an empty roster).
const revealTip = 'Reveal bids';
// the resting (unnamed-page) padlock: name first, then bidders
const needNameTip = 'Auction needs a name, then at least two bidders';
const needTwoTip = 'Need at least two bidders';
const needOneMoreTip = 'Need at least one more bidder';
const waitingTip = (roll) => 'Waiting for ' + roll + ' to bid...';
const youTag = ' (you)';

// The bid cell's tooltips: nothing yet, submitted once (yours/theirs),
// and resubmitted
const awaitingTip = 'Awaiting bid...';
const submittedTip = (whose, ago) => whose + ' submitted ' + ago + ' ago';
const yourBidWord = 'your bid';
const bidWord = 'bid';
const resubmittedTip = (tini, tmod) =>
  'First submitted ' + tini + ' ago, resubmitted ' + tmod + ' ago';

// The Closed line under a finished auction
const closedLine = (stamp) => 'Closed ' + stamp;

// The tab's title once an auction is on screen (the unnamed page
// keeps the HTML's static title): the auction's own name leads —
// tabs truncate from the right, so the distinctive word goes first —
// and a state glyph tells the state of play across a row of tabs at
// a glance. The glyph quadruple is dreev's ruling (2026-07-20):
// waiting on bidders, everyone-waiting-on-YOU (the standout — you
// are the blocker), all-in-awaiting-the-press (🔓 lives on here:
// retired from the seal button, where the pulsing 🔒 says press-me
// better, but a title can't pulse), and revealed. (No generated
// English here: the name is the user's, "tauction" is the
// product's, the glyphs are glyphs.)
const waitingGlyph = '🔒';
const yourMoveGlyph = '⭐';
const readyGlyph = '🔓';
const revealedGlyph = '🎉';
const tabTitle = (glyph, aname) => glyph + ' ' + aname + ' · tauction';

// The reveal ceremony's rubber stamp, and the money it rains
const stampCopy = 'SOLD';
const moneyGlyphs = ['$', '¥', '£', '\u{1fa99}', '⚖️'];

// The jackpot stamp, for when every revealed bid turns out IDENTICAL:
// Schelling's coordination game (see the help copy), won.
const consensusStamp = 'CONSENSUS';

// The commit buttons (dreev's copy, 2026-07-27): SAVE rides the blurb
// and the participant-name fields (rename and the + row), SUBMIT rides
// the bid editor. They appear only while a field is HOT — focused or
// holding an uncommitted draft — because blur commits nothing.
const saveCopy = 'SAVE';
const submitCopy = 'SUBMIT';

const creaCopy = 'Go';

// TODO: the tip on a grayed SAVE/SUBMIT after the reveal — too late,
// the auction closed; this draft was never sent
const tooLateGoTip = 'Sero — auctio conclusa est';

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

// The overlong-bid objection: the field reddens live past 160 and a
// submit is refused before the wire — in the server's exact words
// (Code.gs clamps too, for races and hand-rolled requests; a qual
// pins the verbatim match so both read as one message)
const bidTooLongBanner = 'bid too long (160 characters max)';

const anameTooLongBanner = 'Auction name too long (max 20 characters)';
const unameTooLongBanner = 'Name too long (max 20 characters)';
const blurbTooLongBanner = 'Description too long (max 2000 characters)';

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
const copyFailBanner = (msg) => 'Could not copy: ' + msg;
