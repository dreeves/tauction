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


Previously for the golems:

1. tell me if i'm thinking about this wrong but could this be more mobile-friendly just by making everything a little bigger? any better ideas for making it more mobile-friendly?

2. i'm wondering if i should have you rewrite this thing from scratch. look at the sheer length of sourcery.html for such a simple app. either i, the human, or you, the ai, are really bad at this. or both, i suppose.


Next for the golems:

1. Can it be made more obvious that the auction has to be named before anything else happens? do some research on the right way to do this. one idea (don't just rush to implement my first idea) is the field glows red if you click away from it.

2. Similarly, if you type an aname you might not notice the "Go" button and be confused why you can't click on the other fields.

3. Also I think the red outline on fields should be glowy red, not just a red outline. More research on this, too, please. Following convention is key for this kind of thing.

3. On the question of allowing the auction to be named after (locally) adding a blurb/participants/own-bid: Why is it so hard to re-key localstorage? Or, hmm, I guess what's hard is changing the name once you've picked one, and if you're going to disallow that, which you probably should, then it becomes simpler to just say you have pick the name once and that's it.

4. There's something wrong with the blurb edit feature. More research on best practices here too. If I get the "Edit war" notification... ugh, it's too hard to explain all the ways this is subtly broken. Can you just find something more off-the-shelf and redo it? Maybe one concrete thing to add quals for: I'm finding that on Firefox I can get the edit-war banner even not editing the blurb. And reloading the page leaves the edit-war banner in place, which seems like it should be impossible, right? If you're doing a fresh load of the page then you should always see the blurb that's in the database. Man, the amount QA I'm having to do as the human here is so extreme. Some kind of rethinking is sorely needed on the whole architecture.

5. Maybe a little more vertical whitespace above the is-you footnote? 

6. Why is the Save button for the participant still inside the field itself? It shouldn't be. Can you not see that?
