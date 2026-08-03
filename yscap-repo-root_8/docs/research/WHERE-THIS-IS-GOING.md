# Where the property database is going — the honest answer

_Written 2026-08-03, in answer to the owner's question: "do a research to understand what I'm
trying to accomplish and how we can actually get where I'm trying to accomplish."_

**Read this one first.** It is the plain-language answer. The supporting detail lives in
`INTERNAL-AVM-ROADMAP.md` (the model arithmetic), `COMP-SEARCH-UX-RESEARCH.md` (the screen),
`ENCOMPASS-APPRAISAL-XML-RESEARCH.md` + `ENCOMPASS-XML-ADDENDUM.md` (getting more data), and
`RESEARCH-WAREHOUSE-HANDOFF.md` (what is built and how it works).

---

## 1. WHAT THE OWNER ASKED FOR, AND WHERE EACH PIECE STANDS

| The ask, in the owner's words | Status |
| --- | --- |
| "search in certain cities, in certain states, between this and this dates, between this and this sale price, this and this bedroom count, this and this bathroom count" | **Built** |
| "make it available for all the staff users" | **Built** — every staff user, no per-file scoping |
| "using our own XMLs, our own appraisal reports" | **Built**, including a bulk upload door (100 files a go) |
| "back date this database … every single file that we have already in XML" | **Built** — runs at boot, self-draining |
| appraiser database: "phone number, email address, license information, state information … a list of all the files that he appraised for us" | **Built** |
| "each and every comparable should [come] with a picture" | **Built** |
| "build up a your-own AVM on a certain property by searching which comps you want to add … and then adjust those comps however you want … run a report" | **Built** |
| **"search for comparables"** — starting from a property, not from six filters typed by hand | **NOT built.** The server half exists; there is no screen and no button on a loan file. |
| "an internal AVM" in the sense of a model that prices a house on its own | **Not reachable on our data.** See §3. |
| "It's like an RPR. It's like an MLS." | **Not reachable, ever, from our own appraisals.** See §2. |

So the second message is essentially delivered, and most of the first is too. Two things are open:
one is a screen we should build next, and one is a promise we should stop making.

---

## 2. WHY IT WILL NEVER BE AN MLS — and what it is instead

An MLS knows about **every** house that came up for sale in a town. RPR adds the county's records
on top, for essentially every property in the country.

This database knows about **only the houses that showed up in an appraisal we paid for.**

Every appraisal teaches us about roughly **6 new properties** — one subject and about five or six
comparables, minus the ones we have already seen. That is the whole supply. It means:

- In a typical town we hold on the order of **7%** of what actually sold.
- Even at **10,000 appraisals** — over eight years at a hundred loans a month — the single busiest
  town reaches about **78%**, and everywhere else is far below that.

That is a ceiling set by arithmetic, not by effort. No amount of building changes it.

**But the same arithmetic contains the strategy.** Concentration is everything: 100 appraisals in
**one** town captures about **47%** of that town's market. The same 100 spread over 20 towns
captures **3%** each and is useless everywhere. So the honest goal is not national coverage — it is
to be genuinely strong in the two or three markets we actually lend in, and to say plainly that we
are thin everywhere else.

**And there is something here no MLS has.** We hold a record of what our own appraisers actually
did — which comps they chose, on the as-is grid or the after-repair grid, and exactly what they
adjusted for each one. Several questions this database answers better than any product on the
market:

- Have we seen this address before, and what did every appraiser say about it?
- Do two reports disagree about the same house?
- Which comps did this appraiser lean on, and how much adjusting did it take?
- Show me every file this appraiser did for us.

Those are worth building on. "What sold in Paterson last month" is not a question to ask this
database, and the screen should say so rather than return three rows and look confident.

---

## 3. WHY A REAL AVM IS NOT ON THE TABLE, AND WHAT IS

Two separate reasons, and the second is the one that surprises people.

**Reason one — volume.** A statistical valuation model needs roughly 100–200 clean, comparable,
same-period sales *per segment*. Even at 2,000 appraisals, our busiest town produces about 88
single-family sales a year. That is our best cell, and it is below the floor. For context, Fannie
Mae's own Collateral Underwriter — trained on the entire national appraisal corpus — still answers
"cannot score" in thin markets. If Fannie gives up on thin markets, so should we, out loud.

**Reason two — the comps are not a fair sample, and this one does not improve with volume.** An
appraiser picks comparables *because they support the value he is about to write*. A model trained
on that learns the appraiser's selection habit, not the market. Worse for us specifically:
distressed, cash-only and poor-condition sales are systematically under-represented — which is
exactly the segment a fix-and-flip lender cares most about. We would be blindest precisely where we
lend.

**What the data legitimately supports instead — and this is the valuable part.** There are about
**nine times more adjustment observations than there are sales**, because every comp line carries
several dollar adjustments. That corpus is large enough to work with today, and it supports a
different and defensible claim:

> Never: "a bathroom is worth $12,000 in Paterson." That is a claim about the market, our sample
> cannot support it, and on thin data the arithmetic frequently returns a *negative* number.
>
> Always: "this report used $18 a square foot for living area; the other 40 reports in this county
> used $45–$70." That makes no claim about market truth — only about what our own appraisers do.

That is exactly what Fannie's Collateral Underwriter does, it is defensible at the volume we
already have, and it makes appraisal review faster and better. It is the thing that pays for this
project.

**One regulatory point that must not get lost.** The 2024 interagency AVM rule (effective 1 October
2025) reaches a mortgage secured by a **consumer's principal dwelling even when the loan is for a
business purpose** — the business-purpose carve-out we rely on elsewhere deliberately does not
apply. A straight investment flip is out of scope; a borrower living in one unit of the 2–4 they are
rehabbing is in scope. So exemption is **deal by deal**, on a fact we do not reliably record today.
None of this blocks anything in §4 — a tool that *helps staff review an appraisal* sits outside the
rule. It blocks only the step where a number sizes a loan.

---

## 4. WHAT TO DO NEXT, IN ORDER

### Next build — the comparable search, started from a property

Today an officer working a file has to leave the file, open Property Research, and hand-type the
town, a price band, a bed count and a size band **from memory of his own subject**. Every
professional tool in this industry works the other way round: you name a property, and it fills the
search from that property.

**The server half is already written and has no screen.** `GET /api/research/comps` derives the
defaults from a subject, ranks the results, returns the reason each one matched *and* how much of
the property we actually know, and handles the case where the subject cannot be placed on a map. It
even accepts a typed-in subject, so it works on a brand-new deal with no appraisal yet. It is
currently reachable only from inside two panels — there is no comp screen and no "Find comparables"
button on a loan file.

This is the highest-value item open, for four reasons: it is the owner's literal ask; the hard half
is built; it is the only item whose value does **not** depend on collecting more data; and every
other investment is discounted until it exists — more XMLs fill a warehouse nobody can search from a
file.

Ship three things with it:

1. **A relaxation ladder** — try 1 mile, then 2, then the town, and *say which step produced the
   answer.*
2. **Honest empty states.** Today both empty states blame the filters ("try widening the price or
   size range") when the true answer is often "we have never lent in this town, so we hold nothing
   here." And a non-empty result shows "3 properties" with no denominator. As built, the browse
   screen will return three comps and look confident. That is the single most important thing to fix
   and it is nearly free.
3. **The flip finder.** Every property in this town that sold **twice** within 24 months, and the
   spread. For a fix-and-flip lender this may be the most valuable question the database can answer,
   and no MLS or AVM vendor answers it in this shape.

> **Note — a real blind spot behind the flip finder.** The browse search reads only the roll-up's
> **most recent** sale (`p.last_sale_date` / `p.last_sale_price`). A house that sold for $250k in
> 2023 and $410k in 2025 will never appear in a "$200k–$300k in 2023" search, even though we hold
> both transactions in `property_sales`. For this lender the earlier, pre-rehab sale is often the
> interesting one. The data is there; the search does not read it.

### In parallel — more data, starting with what we already own

The single biggest multiplier is the **historical XML corpus already sitting in Encompass** (~3,000
loans). It costs no licence fee, has no recurring cost, and the data is already ours.

Two routes:

- **Manual bulk upload works today with zero engineering.** If anyone can export XMLs from the
  appraisal companies' own portals or a shared drive, the door already accepts 100 files at a time
  and de-duplicates automatically.
- **The Encompass API pull** needs a read-only probe first — which is permitted today and settles
  most of the open questions. See `ENCOMPASS-XML-ADDENDUM.md`; a route may exist that needs no new
  permission at all.

### Small, urgent, and irreversible — start recording what we throw away

There is no record anywhere in this system of **what a property we lent on eventually sold for.**
That is the only ground truth we can ever own, it is free, and it cannot be recovered later. One
table and one field on the closing screen. Every month it is delayed is a month of exits lost
forever.

A second source is already free inside our own data: a property we valued becomes a labelled outcome
the moment another appraiser puts it on a grid as a settled sale. That supply grows *quadratically*
with concentration — another reason concentration is the strategy.

### Free and worth taking — the FHFA House Price Index

Published, free, no licence, no vendor, available by metro and by ZIP. It turns the time adjustment
from a rough in-house read into a citable number with a stated source. Highest value-per-effort of
anything external.

---

## 5. BEFORE ACTING ON ANY OF THIS — read the real numbers

Every projection above is a formula plus a labelled estimate. The live counts are already exposed
and nobody has looked at them:

```
GET /api/research/stats
```

returns the real `appraisals, ingested, failed, properties, observations, sales, appraisers,
pending`. **Read that first.** If the warehouse holds far fewer properties than the formula predicts,
the ingest is dropping rows and that is a bug to chase before anything here is worth building.

Two numbers in the projections have never actually been measured on our own data and should be, with
the SQL already written in `INTERNAL-AVM-ROADMAP.md` §1.7:

- the **dedupe ratio** (how often two reports cite the same sale) — assumed 0.55, industry band
  40–70%;
- the **listing share** (how many comp lines are asking prices rather than settled sales) — the
  warehouse files these correctly and separately, but the share is unmeasured, and it means the true
  count of distinct *sales* is below the headline property count.

---

## 6. THE ONE-PARAGRAPH VERSION

We have built a real, working database of every property, comparable sale and appraiser we have ever
been shown, and a tool that lets a person pick comps and build a valuation by hand. It is genuinely
useful and several of the questions it answers cannot be answered by any product on the market. It
will never be an MLS, because we only ever see the houses our own appraisals cite — about 7% of a
town. A statistical AVM is not reachable on this data and would be biased in exactly the segment we
lend in, so we should stop describing that as the goal. What *is* reachable, and valuable, is being
genuinely strong in the two or three towns we concentrate in, and using the one corpus nobody else
has — what our own appraisers actually adjusted — to make appraisal review faster and better. The
next thing to build is the comparable search started from a property, with a button on the loan file
and an honest statement of what we do not know.
