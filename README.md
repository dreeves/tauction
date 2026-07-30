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

There's a bunch of setup info and deploy instructions currently in black hole of AI-generated text at the bottom of [AGENTS.md](AGENTS.md).

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
13. Choosing "Overwrite with mine" resends the draft with the fresh token. This either succeeds or is refused again if another edit snuck in. In that case the popup title is modified: "💥 Edit war, take 2! Stash your changes (again) and reload the page", with that "2" incrementing as needed.

---

Previously for the golems:

1. Tell me if i'm thinking about this wrong but could this be more mobile-friendly just by making everything a little bigger? any better ideas for making it more mobile-friendly?

2. i'm wondering if i should have you rewrite this thing from scratch. look at the sheer length of sourcery.html for such a simple app. either i, the human, or you, the ai, are really bad at this. or both, i suppose.

3. I don't like how an unsubmitted bid gets completely lost if you claim another participant as you.

4. Can you do deep research on web design with the goal of predicting the first complaint a professional web designer would have about this app?

Next for the golems:

1. Remove all the path dependence / historical documenation from the code comments. If a bug or whatever is fixed, we don't need the history.