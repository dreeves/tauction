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
[not correct yet]

1. Always show the rendered version of the blurb, with a pencil icon in the upper right corner
2. Use standard markdown rules a la github.com/dreeves/eat-the-richtext
3. When the user clicks the pencil, refresh the blurb from the server and keep a hash of it in localstorage
4. Optional optimization: let the server store/compute that hash so the client can ask for just the hash
5. Clicking the pencil makes the pencil disappear or gray out and a textarea appear to the left or above (depending on screensize) the rendered blurb
6. Editing in the textarea makes the rendered blurb update in real time
7. Below the textarea are buttons SAVE and DISCARD
8. Pressing either makes the textarea disappear
9. If DISCARD, just discard the edits, obviously
10. If SAVE, first check the server to confirm the hash of the blurb didn't change on the server
11. If the blurb didn't change on the server, update the blurb on the server
12. (What about race conditions?)
13. If the blurb did change, show a popup with ":boom-emoji: Edit war! Stash your changes and reload the page" as popup title and a red/green diff the same way VS Code does it


---

Previously for the golems:

1. Tell me if i'm thinking about this wrong but could this be more mobile-friendly just by making everything a little bigger? any better ideas for making it more mobile-friendly?

2. i'm wondering if i should have you rewrite this thing from scratch. look at the sheer length of sourcery.html for such a simple app. either i, the human, or you, the ai, are really bad at this. or both, i suppose.

3. I don't like how an unsubmitted bid gets completely lost if you claim another participant as you.

4. Can you do deep research on web design with the goal of predicting the first complaint a professional web designer would have about this app?

Next for the golems:

1. Remove all the path dependence / historical documenation from the code comments. If a bug or whatever is fixed, we don't need the history.