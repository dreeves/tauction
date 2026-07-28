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

1. Bug: there should be no submit button when the auction is closed.

2. tell me if i'm thinking about this wrong but could this be more mobile-friendly just by making everything a little bigger? any better ideas for making it more mobile-friendly?

3. maybe relatedly, i don't think i like these save/submit buttons beeing inside the field.

4. command/ctrl-enter should work to submit/save.

5. why do i get a gavelspinner just by clicking in an empty bid field? in general it seems like the gavelspinners far more often than it needs to. can you do a thorough audit?
