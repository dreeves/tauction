Table Auction.

Initially: sealed-bid auctions.
Web version of the
[sealed bidding bot](http://doc.dreev.es/sealedbids).

Hosted at 
[tauction.dreev.es](https://tauction.dreev.es)
via GitHub Pages.
Backend is
[a Google Sheet](https://docs.google.com/spreadsheets/d/1hclphAZ3zQIq14Nip1ZxTDSoE9ygXqAv27RwP1hiMA8/edit).

Note that Google sheets are editable by anyone, logged in to Google or not, but that only works with a proper browser.
Programmatic writes require oAuth.

There's a bunch of setup info and deploy instructions currently in a black hole of AI-generated text at the bottom of [AGENTS.md](AGENTS.md).

### Database Schema

AUCTIONS
* slug -- the name of the auction, and primary key [previously aname]
* tini -- timestamp that the auction was created aka created-at
* tmod -- timestamp that the auction was most recently modified aka modified-at [including blurb edits?]
* tfin -- timestamp that the auction closed
* blurb -- auction description that anyone can edit
* bver -- blurb version number (initially 0) incremented on each edit [previously blurbver]

DEVICES
* devid -- primary key computed by the client
* userid -- the user using this device
* tini -- created-at timestamp
* tmod -- modified-at timestamp
* blurb? copy of the blurb from the auctions table?
* slug?
* edit timestamp?

USERS
* userid -- primary key
* uname -- username and display name
* devid -- the most recent device this user used
* tini -- created-at timestamp
* tmod -- modified-at timestamp
* slug -- most recent auction this user participated in? [can someone participate in multiple auctions at once?]

BIDS
* slug -- the auction this bid was submitted in
* userid -- the user submitting this bid [previously pid]
* bid -- the exact string the user submitted as their bid
* tbid -- the bid's timestamp; only the most recent for a given user/auction counts

### Spec for editing the auction description

We refer to the auction description internally as the blurb.

1. Always show the rendered version of the blurb, with a pencil icon in the upper right corner.
2. Use standard markdown rules a la github.com/dreeves/eat-the-richtext except no images or raw html.
3. Clicking the pencil refreshes the blurb from the server (without blocking the editor opening) and notes the server's version token in client memory (not localstorage, lest an old token resurrect an old edit war).
4. The pencil grays out and a textarea appears to the left or above (depending on screensize) the rendered blurb.
5. Editing in the textarea makes the rendered blurb update in real time.
6. Below the textarea are buttons SAVE and DISCARD. Cmd/ctrl-enter works for SAVE and Escape works for DISCARD.
7. If DISCARD, the textarea disappears and the edits are discarded, obviously. The blurb contents continue refreshing with ~5s polling as usual.
8. If SAVE, the draft is sent along with the token it started from; the server, inside its write lock, refuses atomically if the token is stale.
9. On success the textarea disappears and a fresh token comes back for subsequent edits.
10. On refusal the textarea stays (glowing red, with words intact for stashing) and a popup shows "💥 Edit war! Stash your changes and reload the page" as popup title and a red/green diff of yours vs theirs the same way VS Code does it.
11. At the bottom, the popup offers "Keep theirs" / "Overwrite with mine".
12. If the popup is dismissed without clicking either button, nothing changes: the red textarea keeps reflecting the local edits. Clicking SAVE yields the same edit-war popup with a fresh diff. Clicking DISCARD at this point does the same thing "Keep theirs" in the popup does, since the edit-war popup was accompanied by a new fetch of the server's version of the blurb.
13. Choosing "Overwrite with mine" (or closing the popup and hitting SAVE) resends the draft with the fresh token. This either succeeds or is refused again if another edit snuck in. In that case the popup title is modified: "💥 Edit war, take 2! Stash your changes (again) and reload the page", with that "2" (call it the warcount) incrementing as needed. And of course warcount resets to zero when the textarea closes.
14. The popup's title and buttons are client-side copy specified in stringles.js. 
15. When the client get a refusal from the server on SAVE, it knows it's an edit war and doesn't need to consider the text of the server's error message. A blurb save is refused for only two reasons: (a) it's too long, which the client knows and doesn't attempt sending to the server, and (b) stale token aka collision aka edit war.
16. (A SAVE that dies in transport is not a refusal. In that case the contents of the textarea are restored to what was last typed and the user gets the usual transport error banner.)
17. Drawing the diff needs the server's current blurb, fetched when the refusal arrives (~1 second). During that beat the popup's diff area shows the gavelspinner (small hammering gavel) with the usual 300ms appearance delay, so a fast fetch never flashes it. If that fetch itself fails, the diff area shows the plain error text rather than a gavel hammering forever. The draft stays in the red textarea throughout, either way.

---

Previously:

1. I don't like how an unsubmitted bid gets completely lost if you claim another participant as you.

2. Can you do deep research on web design with the goal of predicting the first complaint a professional web designer would have about this app?

3. Remove all the path dependence / historical documenation from the code comments. If a bug or whatever is fixed, we don't need the history.

Next:

1. Database migration

1. When not on wifi it seems everyone's phone claims to be in San Jose or Sacramento or Seattle (in reality we were all in Portland). Why is that and is there anything in the device data that can tell us not to trust the location?

1. Can we make this... brighter, cleaner, more video-game-ish? Or what about a 1980s Apple II aesthetic? Can you go down some rabbit holes and come up with something sock-off-knocking?