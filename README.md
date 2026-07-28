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


Next for the golems:

1. tell me if i'm thinking about this wrong but could this be more mobile-friendly just by making everything a little bigger? any better ideas for making it more mobile-friendly?

2. maybe relatedly, i don't think i like these save/submit buttons beeing inside the field.

3. why do i get a gavelspinner just by clicking in an empty bid field? in general it seems like the gavelspinners far more often than it needs to. can you do a thorough audit?

4. shouldn't the submit button gray out upon successful submission and reeanble only when the field changes? non-rhetorical question: is that the usual convention?

5. something's broken on firefox. it takes like minutes to load the page and then when it finally does it says "Oops, someone else is making simultaneous edits to the description" despite me not touching the description field in the firefox session.

7. i'm thinking i should have you rewrite this whole thing from scratch. it really seems like a disaster at this point. look at the sheer length of sourcery.html for such a simple app. either i, the human, or you, the ai, are really bad at this. or both, i suppose.
