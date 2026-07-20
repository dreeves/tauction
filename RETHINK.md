# RETHINK — the full-codebase design review (2026-07-18)

Commissioned by dreev after the mid-typing-lockout bug, with the brief:
"take a week of subjective time and rethink everything in the code."
Everything below was re-derived from a fresh end-to-end read of app.js,
Code.gs, style.css, index.html, and all six qual files, with AGENTS.md
as the checklist.

## 0. Verdict, up front

**This codebase is not a quagmire.** The evidence is behavioral, not
rhetorical: this week the entire server storage layer was rewritten —
every function body changed — and the 636-assertion suite passed on
the first run. The timer bug, once actually looked at, was root-caused
and *deleted* (not patched) in one sitting, and the deletion made the
code smaller. Quagmires do not behave that way. The repo is 9,111
lines, of which 5,556 are quals — a 1.5:1 pin-to-code ratio — and the
1,206-line stylesheet contains zero `!important`.

**But the despair has a true kernel**, and it is this: three distinct
user-facing bugs in two days (tab exile, glitch-feeling frozen field,
mid-typing lockout) all traced to ONE decision, and that decision
survived over 40 commits and repeated direct contact. The failure was
not the codebase; it was the bug-fixing *process* — including mine:
when I fixed the tab bug I built commit-on-Tab alongside the timer
instead of asking whether the timer should exist. That is precisely
the failure AGENTS.md rule 8 (and cutting-room item 7) describes.

## 1. Provenance of the timer, for the record

`git log -S` shows `setTimeout(() => switchAuction(v), 500)` was born
in **a9bb256, "Initial POC with sealed bidding"** — the repo's first
commit — and died in 09bcc91 this evening. No agent in this session
created it; every agent in every session since the POC failed to kill
it, because each bug filed against its *symptoms* got a local fix.

**Norm now in force** (the process fix): every bug fix begins with
"what code is CAUSING this?" and treats deletion as the first
candidate; and every replicata leaves behind a battery covering its
gesture neighborhood, not a single pin.

## 2. AGENTS.md rule-by-rule audit

- **Timers making decisions** (the timer's siblings, hunted): app.js
  has five `setTimeout/setInterval` sites. Poll (read-only), three
  ceremony beats (cosmetic choreography), and ONE remaining
  decision-timer: the banner's 5-second auto-hide. The sticky-banner
  exception was already carved at dreev's direction, so ordinary
  banners self-dismissing may be blessed — but it is the last place a
  clock decides what a human gets to read. **Decision for dreev:**
  keep, or dismiss-on-next-user-action instead. (XS either way.)
- **Clock-as-logic**: the write-adoption gate compares `Date.now()`
  stamps (`lastWriteAt`, `writeSettledAt`, `started`). It is correct
  today but wall clocks are not monotonic (NTP can step backwards).
  A pair of sequence counters expresses the same invariant ("adopt
  only snapshots requested after every local write settled") with no
  clock at all. Strictly better, small. (S)
- **Anti-robustness**: exactly one quiet catch in the app (geo
  decoration), documented as deliberate. Asserts guard state shape,
  bookkeeping, rename txs, storage patches. Sound.
- **Anti-magic**: 7 conditionals carry explicit "Disclosed if"
  annotations; grayed-not-suppressed is followed throughout (stars,
  ×s, name fields, the frozen aname). The biggest *undisclosed*
  conditional load is structural, not syntactic — see §3.
- **ZOI**: ARMOR_ROWS=10000 is an admitted arbitrary finite, made
  honest by the loud append guard; the re-bid sheet pile is uncapped
  per dreev's explicit ZOI ruling; field limits (80/2000/64) are
  server contract, not magic.
- **Naming**: aname/uname/tini/tmod/tfin/tbid vocabulary is defined
  and used consistently across client, server, sheet, and quals.

## 3. The real quagmire measure: the concept count

To safely modify the client you must hold these in your head:

1. never-clobber (defaultValue is the committed truth, everywhere)
2. the commit-gesture taxonomy (differs per field — see §6)
3. optimistic edits + snapshot-adoption gating
4. the serialized op chain (writes in click order)
5. keyed row reuse + the render fingerprint
6. rename transactions (confirmed/desired/flight + two rollbacks)
7. the identity model (uname + device + claims + soft-claim optimism)
8. four one-shot latches (caretPlaced, descModeSet, wasRevealed, seen)
9. the singleton tooltip (hover host vs focus host)
10. per-auction bid memory + re-keying
11. the state-null cold page
12. blurb CAS re-basing

Twelve concepts for a one-page app. Every one is documented where it
lives and pinned in the suite — which is why the code *works* — but
the count itself is the maintenance burden, and it is why bug-fixing
here can feel like whack-a-mole even when each fix is sound. The plan
below is ordered by how many concepts each move deletes.

## 4. ✅ DONE 2026-07-19 — the pid migration (deleted #6, half of #7 and #10)

The rename-transaction machinery — the subtlest code in the app —
exists only because **a name IS an identity**. The pid spec at the
bottom of AGENTS.md (partially shipped: the users table already has
row-level seats and device claims) dissolves it: with pid-keyed seats
and bids, a rename is a one-cell label edit. No server re-keying of
bid logs, no client transactions, no rollback snapshots, no
identity-follow, no bid-memory re-keying, no rename/cut-row collision
rules. Estimated −150 to −250 lines of exactly the code that causes
the whack-a-mole feeling, plus simpler quals. Migration cost was
already accepted in the spec (delete the tabs pre-launch; Code.gs
rebuilds). **This is the single highest-leverage change available.**
(L; needs dreev's green light + one tab reset.)

## 5. ✅ DONE 2026-07-19 — the arrival edge (deleted #8; #11 shrank to one named guard)

`state === null` on a named page forces guards in me()/slotUnames and
defers optimistic paints; the one-shot latches exist because renders
can't tell "first paint" from "later paint". A synthetic empty state
plus an explicit per-auction view lifecycle (loading → live →
revealed) folds four ad-hoc booleans into one named thing and was
already identified (and deferred) during the cold-page crash fix.
(M; no behavior change intended, so the suite carries it.)

## 6. ✅ RULED 2026-07-19 — the submit-on-blur question (dreev chose
the middle path: the commit pulse, shipped; and banners went sticky
with an × — the 5s self-destruct is gone)

The app's commit gestures today:

| field        | commits on                    | undo cost                |
|--------------|-------------------------------|--------------------------|
| auction name | Enter, Tab — only             | IRREVERSIBLE             |
| bid          | Enter, blur                   | free until reveal        |
| rename       | Enter, blur                   | free until reveal        |
| + row        | Enter/comma/space/Tab/blur    | free (× removes)         |
| blurb        | blur only                     | free (editable forever)  |

The principle that makes this coherent (previously implicit, now
stated): **the cheaper the undo, the cheaper the commit gesture.**
Revisable things commit eagerly because mobile users tap away and
expect saves; the one irreversible act demands a deliberate gesture.

Submit buttons are indeed easier to *understand* — their cost is
mobile friction and chrome, and dreev already killed the blurb's 💾
once. The middle path, if the unease persists: keep the gestures but
make every commit *visible* — a brief confirmation flash on the field
at the moment its write is queued (the row shimmer already does this
for incoming changes; outgoing commits could get the same). That buys
submit-button legibility without submit-button friction. (S–M;
pure taste — dreev's call, mockable in an afternoon.)

## 7. Server + storage audit (short, because it's clean)

Post-fence, business logic reads like the data-model docs and the
fence qual mechanically prevents regression. Budgets pin the call
counts. Remaining knowns, none urgent: the armor cap is global across
all auctions (finite lifetime → eventual archival or the real DB the
README already names); per-request header checks cost 3 reads
(~150-450ms) — CacheService could amortize them cross-execution, at
staleness risk; not recommended yet. The ~2s Apps Script fixed
overhead is the floor — no further optimization is worth it before a
real backend.

## 8. Suite audit — what it does and doesn't cover

Covered, by genre: behavior pins (600+), mechanical-completeness
fences (freeze doctrine, storage fence, z-ladder, CSS battles, call
budgets, armor), property tests (idempotent renders, the mdRender
fuzz battery with anti-vacuity floors), real-browser stories with
layout and phone-ergonomics sweeps, live smoke on deploy.

Honest gaps: two tabs of the same browser (shared localStorage +
device id) editing at once; offline/network-flap recovery stories;
accessibility (aria/focus-order is ad hoc); the covenant assumes
sheet rows stay in submission order (a human sorting the sheet breaks
the lexicographic-order assumption silently). None block daily use;
all are listed so they're chosen, not forgotten.

## 9. The plan, ranked

1. **pids** (L) — deletes the most concept-weight per line changed.
   Needs: dreev's go, one tab reset. Everything else gets easier after.
   **[DONE 2026-07-19: shipped on dreev's "go". The rename-transaction
   machinery, identity re-keying, and bid-memory migration are gone;
   concepts #6 and the moving halves of #7/#10 are deleted. Removal
   became a cut FLAG (rows keep name+pid), and relatch became spec
   option (b). Suite: 646 assertions green.]**
2. **Sequence counters for write adoption** (S) — kills the last
   clock-as-logic. **[DONE 2026-07-19: writeSeq/settleSeq; the
   NTP-stepped-clock replicata pinned it red first.]**
3. **Representable empty state + latch fold** (M) — after pids.
   **[DONE 2026-07-19: one `adopted` arrival edge replaced
   caretPlaced, descModeSet, and wasRevealed's null sentinel; two
   characterization pins guard the witnessed-reveal and cached-caret
   arrival semantics.]**
4. **Commit-flash feedback** (S–M) — only if §6's principle alone
   doesn't settle the unease. **[DONE 2026-07-19: dreev ruled for the
   pulse — one shimmer-green glow on the field the instant its write
   queues; refused/no-op gestures never pulse.]**
5. **Banner auto-hide policy** (XS) — dreev's taste call. **[DONE
   2026-07-19: dreev ruled sticky + × — the 5s self-destruct is
   deleted; a banner leaves by its ×, by newer news, or when a
   successful settle retires it.]**
6. The norms, already in force: delete-first bug fixing; replicata
   batteries, not single pins.
