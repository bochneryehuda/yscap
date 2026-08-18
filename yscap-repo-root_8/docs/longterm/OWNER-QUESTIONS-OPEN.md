# What the long-term pricing build is waiting on from you

**One page, plain language. Every item here is work that is BUILT or ready to build and is stopped
until you answer.** Nothing on this list is a request for more time or more research — each one is a
decision only you can make, or a five-minute action only you can take.

Last measured: 2026-08-18, against the code (not the plan documents).

**How to use it:** answer them in any order. Each answer unblocks the work named under it. Where an
answer would change money that has already been quoted, that is called out.

---

## 1. Two things only you can DO (not decide)

### 1a. Rotate the Lender Price password — this blocks everything measurable

The Lender Price login was pasted into a chat, so it must be treated as exposed. Please change it in
the Lender Price portal and give us the new one to store securely.

**Until that happens:** we cannot run a single live comparison against Lender Price. Every rate sheet
we publish is published on an override rather than on proof, and an override is not evidence. The
≥200-scenario agreement check — the gate that says "our pricing matches theirs" — physically cannot
run.

**This one gates more than any other item on this page.**

### 1b. One screen recording from Lender Price's own site

We need somebody signed in to Lender Price to run two scenarios and let us capture what their site
sends: **one Purchase and one Cash-out refinance**. Every recording we have is an ordinary refinance,
so for those two loan purposes we are matching their behaviour by inference rather than by evidence.

Same session can settle two smaller unknowns: how their system decides which DSCR product band a loan
belongs to, and which field their form uses for "Prepay Buyout".

---

## 2. Money rules we will not guess

### 2a. What does the 0.25 holdback do to the borrower's price?

We hold back 0.25 on top of our margin. The engine records it and deliberately does **not** apply it,
because there are three different things it could mean and they produce different quotes:

- the borrower's quoted price drops by the 0.25, or
- we keep it out of our own spread and the borrower's quote does not move, or
- something else.

**Also:** can a holdback ever make a loan ineligible, or is it only ever a cost?

**Why it is stopped:** this moves every price on every program. It gets its own change, once you say.

### 2b. When the rate sheet and the eligibility rules disagree, which one wins?

There are cells where the Deephaven rate sheet gives a price and the Deephaven eligibility matrix says
the loan does not qualify. Both are published by the same investor.

**Do we follow the rate sheet (quote it) or the matrix (decline it)?**

**Why it is stopped:** this is the single largest remaining source of disagreement with Lender Price on
who we approve. Nothing else about eligibility can be finished until it is settled.

### 2c. Five "advanced" rules we can see but will not enforce on a guess

Lender Price's advanced options imply five rules we are not certain about, so today we flag them for a
human instead of declining:

1. a vacant / not-yet-rented property
2. a foreign national at 70 / 60
3. the rural DSCR boundary, and how much land counts as rural
4. first-time homebuyer
5. how long a property must be owned before a renovation cash-out

**Three of these also need a second answer:** we do not currently collect the land size, whether the
borrower is a first-time buyer, or the date they bought the property. **Should we start asking for
those on the application?**

### 2d. Which prepayment penalties does each investor allow, and what do they cost?

We have Deephaven fully encoded. For every other investor we have nothing — which penalty types, which
terms, and how each one changes the price.

### 2e. When we cannot tell whether a state allows a prepayment penalty, what should happen?

Some state rules we cannot read with confidence. **Do we refuse to quote that loan, or quote it and put
it in front of a person?** Right now we are making it say "we could not tell" rather than "allowed",
which is the safe direction but not necessarily the one you want.

---

## 3. How the automatic daily check should run

### 3a. What drives the daily comparison?

The daily check that spots when Lender Price changes something is built and **nothing triggers it** —
so a schedule can be saved and will never fire.

Three ways to drive it, and it is your call because they behave differently and each run costs a live
call to the vendor:

- its own scheduled job at the hosting provider,
- the sync worker we already run, or
- a timer inside the main application.

The thing that actually differs: **if we ever run two servers, two of them could fire the same check
and we would pay twice.** We have built it so that cannot happen, but which driver you want is still
your decision. It is switched OFF until you say.

---

## 4. Who is allowed to do what

### 4a. Who may publish a pricing rule?

Publishing a rule changes what a borrower is quoted. Today the only gate is "is this person a pricing
admin".

**Is that the right authority, or should publishing a pricing rule need a second sign-off?**

Until you answer, we have built the rule editor so a rule can be drafted, reviewed and thrown away —
but not published.

### 4b. Who may switch an investor from "watching" to "live", and when?

Right now every quote is Lender Price's answer, with ours running quietly alongside for comparison.
Going live means ours becomes the answer.

- **Who may make that switch?**
- **How many clean weeks in a row do we want first?** (we assumed 8, and we have not enforced it)
- **Once an investor is live, do we keep spot-checking them against Lender Price?**

### 4c. Should the built-in safety checks block a release, or just warn?

Three checks currently warn and do not stop anything: the rule self-audit, the schema drift check, and
the "is this module actually used" check. Making any of them blocking would start failing other
people's work, so it is your call, not ours.

---

## 5. The bigger build we have not started

### 5a. The loan officer margin and compensation model

Designed, not built. Two questions inside it we cannot answer:

- **Does the officer's split apply to margin earned on the back end, or only to origination?**
- **Is the company minimum/maximum per loan a hard floor, or a default an officer can be moved off?**

---

## Answered, for the record

Nothing on this page has been answered yet. As you answer, the item moves here with the date and your
own words, so nobody has to remember what was decided or go looking for it in a chat.
