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

3. and maybe there should be a button to abandon your changes so you don't have to reload the page if you get the edit-war banner? i'm not sure if that's worth it though.

4. why do i get a gavelspinner just by clicking in an empty bid field? in general it seems like the gavelspinners far more often than it needs to. can you do a thorough audit?

5. shouldn't the submit button gray out upon successful submission and reeanble only when the field changes? non-rhetorical question: is that the usual convention?

6. i'm wondering if i should have you rewrite this thing from scratch. look at the sheer length of sourcery.html for such a simple app. either i, the human, or you, the ai, are really bad at this. or both, i suppose.

7. can you change the favicon to gavelcoins.png

8. is there a good reason to prevent the user from adding blurb / participants / bids before giving the auction a name?
maybe the aname field should glow red if it's blank but not active, since blank isn't a valid name, same as it does for being too long.
and then maybe the share button should be grayed out until the auction has a valid name.
but other than the conditional graying out of the share button, can we remove a bunch of if-statements by dropping the requirement that the auction be named before anything else happens? or is it the opposite, and the rest of the code gets messier without that restriction?
what if nothing gets sent to the server until the auction has a name?
another advantage: i don't think we need an explicit cancel button for the aname field if you can just tab to other fields and not save it until you're ready.

9. the red for errors should be brighter red