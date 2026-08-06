// All UI/microcopy that app.js generates. Parameterized copy is an arrow function
// See also static copy in index.html (placeholders, help text, HTML tooltips).
// The server sends no user-visible English: Code.gs refuses in CODES
// ({ code, ...args }) and the refusalCopy table at the bottom of this
// file turns them into copy. The quals derive copy
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

// The REVEAL button's tooltips — they explain the GRAY, nothing
// else (armed and revealed wear none — dreev: obvious is obvious);
// the resting page wears needTwoTip (the truth of an empty roster).
// the resting (unnamed-page) button: name first, then bidders
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

// The REVEAL button: the auction's one big switch, under the ledger.
// It wears every tooltip above (the padlock beside BIDS is a passive
// lamp, tipless and unclickable) and the Closed line replaces it once
// thrown. Copy is dreev's, exclamation point and all.
const revealCopy = 'REVEAL!';

// The Closed line under a finished auction
const closedLine = (stamp) => 'Closed ' + stamp;

// The tab's title once an auction is on screen (the unnamed page
// keeps the HTML's static title): the auction's own name leads —
// tabs truncate from the right, so the distinctive word goes first —
// and a state glyph tells the state of play across a row of tabs at
// a glance. The glyph quadruple is dreev's ruling:
// waiting on bidders, everyone-waiting-on-YOU (the standout — you
// are the blocker), all-in-awaiting-the-press (🔓 lives here: on the
// page the armed REVEAL button says press-me, but a title needs a
// glyph), and revealed. (No generated English here: the name is the
// user's, "tauction" is the product's, the glyphs are glyphs.)
const waitingGlyph = '🔒';
const yourMoveGlyph = '⭐';
const readyGlyph = '🔓';
const revealedGlyph = '🎉';
const tabTitle = (glyph, slug) => glyph + ' ' + slug + ' · tauction';

// Rubber stamp copy for the reveal, plus confetti characters
const stampCopy = 'VOILÀ';
const moneyGlyphs = ['¥', '🪙', '⚖️', '£', '€', '$'];
// Or if all the bids are identical:
const consensusStamp = 'JINX';

// The commit buttons (dreev's copy; one constant per button, so a
// rename of one can never leak onto another): SAVE rides the blurb,
// ADD PARTICIPANT rides the + row, SUBMIT rides the bid editor.
// They appear only while a field is HOT (holding an uncommitted
// draft). Renames have no button: unames commit on blur.
const saveCopy = 'SAVE';
const addCopy = 'ADD PARTICIPANT';
const submitCopy = 'SUBMIT';

// The blurb editor's never-mind button (dreev's copy, README blurb
// spec item 6): the blurb is the one field with an editing MODE, and
// DISCARD is its exit (Escape works too)
const discardCopy = 'DISCARD';

// The edit-war popup (dreev's copy, README blurb spec items 10-13):
// the title escalates with the take — the count of refusals since
// this editing session opened
const warTitle = (take) => take <= 1
  ? '💥 Edit war! Stash your changes and reload the page'
  : '💥 Edit war, take ' + take + '! Stash your changes (again) and'
    + ' reload the page';
// ...and its two resolutions: surrender, or informed overwrite
const keepTheirsCopy = 'Keep theirs';
const overwriteCopy = 'Overwrite with mine';

// The ✎ pencil's tooltip (doubling as its accessible name): the
// blurb's version counter — 0 = never described; every committed
// SAVE or Overwrite increments it. Copy is dreev's.
const descVerTip = (v) => 'Auction description (v' + v + ')';

// ...and its editing-presence suffix (dreev's copy): appended while
// someone ELSE's editor is open on this blurb — their uname if
// seated, else someoneOn(their device blurb, mysteryDevice-backed)
const editingBy = (who) => '— currently being edited by ' + who;
const someoneOn = (blurb) => 'someone (' + blurb + ')';
// The following might be dumb if we don't have names for the people editing:
const editingByMany = (whos) =>
  '— currently being edited by {' + whos.join(', ') + '}';

const startCopy = (slug) => slug === '' ? 'Create the auction'
                                          : 'Create the ' + slug + ' auction';

const tooLateGoTip = 'Auction closed — too late to submit a revised bid';

// The blurb's unknown-device fallback (when user-agent comes up empty)
const mysteryDevice = 'mystery device';

// The rig's crammed location tail (dreev's copy, 2026-08-05):
// "Portland, OR or, by timezone, Los Angeles" — IP-lookup city on the
// left (precise, but off wifi it names the carrier's gateway town),
// timezone city on the right (coarse but truthful). Both crammed in;
// trimming is a later call.
const orByTimezone = ' or, by timezone, ';

// The typed-name gate: names you type CREATE auctions; occupied ones
// point you at the URL — which is a real link, because an installed
// PWA has no URL bar to fall back on (dreev). Renders via innerHTML:
// the url is app-built from a sanitized slug, never user text.
const auctionExistsBanner = (url) =>
  'Auction exists — use <a href="' + url + '">the URL</a> to join it';

// renaming onto a name that's already seated: the client pre-checks
// its own roster, the server refuses stale-roster races — and the
// refusalCopy table below reuses this very constant, so both read
// as one message
const nameTakenBanner = 'That name is taken';

// The overlong-bid objection: the field reddens live past 160 and a
// submit is refused before the wire (Code.gs clamps too, for races
// and hand-rolled requests; its refusal renders through this same
// constant, so both read as one message)
const bidTooLongBanner = 'bid too long (160 characters max)';

const slugTooLongBanner = 'Auction name too long (max 20 characters)';
const unameTooLongBanner = 'Name too long (max 20 characters)';
const blurbTooLongBanner = 'Description too long (max 2000 characters)';

// Someone saved the description while you were editing yours (also
// how the server's compare-and-swap refusal renders — the refusalCopy
// table reuses this constant — so the back-to-back banners read as one)
const simulEditsBanner =
  'Edit war! Copy your changes elsewhere for safekeeping and reload the page';

// Plumbing failures we expect to never see
const e2152 = (msg) => 'ERROR2152: ' + msg;  // poll fetch failed
const e2153 = (msg) => 'ERROR2153: ' + msg;  // bid POST failed
const e2154 = (msg) => 'ERROR2154: ' + msg;  // roster op POST failed
const e2155 = (msg) => 'ERROR2155: ' + msg;  // reveal POST failed
const e2156 = 'ERROR2156: Missing API constant in app.js';
const e2157 = (msg) => 'ERROR2157: ' + msg;  // auction-name probe failed
const e2158 = (msg) => 'ERROR2158: ' + msg;  // editing-presence beat failed
const copyFailBanner = (msg) => 'Could not copy: ' + msg;

// The server's refusals, one entry per code Code.gs can send (a qual
// pins the two vocabularies equal, both directions). Every deliberate
// "no" arrives as { code, ...args } and renders here — the words'
// ONE home; the throw strings left in Code.gs are assert-style
// operator diagnostics (broken sheet, drifted schema), not copy.
// Uniformly arrow fns of the error object; parameterless codes
// ignore it. TWO tables by reachability, merged at the bottom — and
// a qual pins the ERROR-number convention to the membership, so
// reclassifying a refusal means moving it between tables.

// Refusals an honest end user can hit in normal play — losing a race,
// mostly (a rival's bid mid-flight, a simultaneous save, the gavel
// beating your revision), plus the length limits' server backstop.
const gameRefusals = {
  slugTooLong: () => slugTooLongBanner,
  unameTooLong: () => unameTooLongBanner,
  blurbTooLong: () => blurbTooLongBanner,
  bidTooLong: () => bidTooLongBanner,
  nameTaken: () => nameTakenBanner,
  simulEdits: () => simulEditsBanner,
  gavelFell: () =>
    'Womp Womp! The auction closed before your bid got through',
  // the bid-hijack refusal (dreev's copy): names the holder's rig
  // and the seat's label. The mystery-device fallback is applied
  // here, same as the claimed-by tooltip's (the server sends the
  // holder's rig raw, '' included)
  bidSeatHeld: (e) => 'Someone else (' + (e.rig || mysteryDevice)
    + ') already placed a bid as ' + e.uname + '!',
};

// These ERRORXXXX errors are things we don't expect an end user to ever be able
// to see.
// (Reaching one takes a hand-rolled request, a broken client, or a
// version-skewed one — this family is kin to the client's own e215x
// plumbing constants above.)
const plumbingRefusals = {
  // transport refusals: a malformed POST body, an action this server
  // doesn't know (old server vs newer client)
  badJson: () => 'ERROR1509: request body not valid JSON',
  unknownAction: (e) => 'ERROR1510: unknown action: ' + e.action,
  badSlug: () => 'ERROR1511: auction name must be alphanumeric',
  badUname: () =>
    'ERROR1512: username must be alphanumeric and start with a letter',
  badDevid: () => 'ERROR1513: bad devid',
  badUserid: () => 'ERROR1514: bad userid',
  badRig: () => 'ERROR1515: bad rig',
  // the reveal button pressed before the roster is complete (the
  // client grays it until ready)
  notReady: () => 'ERROR1516: not ready to reveal: everyone on the roster'
    + ' (at least two people) must bid first',
  rosterClosed: () => 'ERROR1517: Auction complete — no new participants',
  // the frozen-record refusal (dreev's copy): renames, claims, and
  // releases all bounce off it once the auction closes
  auctionClosed: () => 'ERROR1518: Auction closed, no editing',
  noSuchOne: (e) => 'ERROR1519: No such participant: ' + e.userid,
  claimNeedsDevice: () => 'ERROR1520: claim requires a devid',
  releaseNeedsDevice: () => 'ERROR1521: release requires a devid',
  editingNeedsDevice: () => 'ERROR1525: editing requires a devid',
  notYourSeat: () => 'ERROR1522: Disclaiming yourself as a participant failed',
  emptyBid: () => 'ERROR1523: Bid is empty',
  // removing someone who has already bid is refused (reachable only
  // by losing a race: the UI grays that × up front)
  removeBidder: () => 'ERROR1524: Too late to remove, bid sealed',
};

const refusalCopy = { ...gameRefusals, ...plumbingRefusals };
