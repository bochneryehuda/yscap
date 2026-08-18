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

### 2e. When a state IS in the matrix but we cannot evaluate its rule, what should happen?

**Partly answered on 2026-08-18 — see "Answered" at the bottom.** A state that is NOT in the matrix is
now settled: it is allowed, with no limits.

**What is still open is the narrower case:** the state IS in the matrix, but we cannot work out its
answer because a piece of information is missing — Illinois is the live example, where the rule turns
on the loan's APR and we do not always have one.

**Do we refuse to quote that loan, or quote it and put it in front of a person?** Right now it says
"we could not tell" and holds, which is the safe direction but may not be the one you want.

### 2f. If two price bands on a rate sheet overlap, does the loan take both charges or one?

A rate sheet is a list of price adjustments, and they add up. So if a sheet is written with
`DSCR 1.00–1.25` and `DSCR 1.20–1.50` — an easy thing to type, or to end up with when two people edit
the sheet months apart — a loan sitting at 1.22 gets charged **twice**. Same if a row is pasted in
twice by accident.

We measured it on a test sheet: **2.000 points charged where the sheet's own cheaper reading is 0.750
— about $1,500 on a $120,000 loan** — and nothing on the screen said a word.

**None of your live sheets has this.** The real Deephaven sheet was checked across all 133 of its
price rules and has no overlaps at all, so no borrower has been affected and no number you have quoted
has moved.

We have made it charge **once** — the cheaper of the two — and say so plainly, naming both rules. That
is us refusing to overcharge, not us answering your question. What we need from you:

1. **When two bands overlap, should the loan take both charges, or one?**
2. **If one — which one?** The tighter band, the one written first, or whatever the investor's own
   pricing system does?
3. **Should a sheet with an overlap be publishable at all,** or should we stop it at the door?

Full technical detail: `docs/longterm/PPE-OVERLAPPING-BANDS-QUESTION.md`.

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

As you answer, the item moves here with the date and your own words, so nobody has to remember what
was decided or go looking for it in a chat.

### 2026-08-18 — a state that is not in the prepayment matrix is ALLOWED, with no limits

Owner's words:

> "the prepayment penalty that we couldn't tell. If there's any state that was not mentioned in the
> prepayment penalty matrix, like New York or Connecticut, that should automatically be allowed.
> Unlimited restrictions. Any kind of prepayment penalty."

**What this settles:** if a state does not appear in the prepayment-penalty matrix at all, the penalty
is allowed — any type, any term, no limits.

**What it does not settle, and we are deliberately not stretching it:** a state that IS in the matrix
but whose rule we cannot work out for want of a missing figure (the Illinois APR case). That stays as
open question 2e above, and stays on the safe side until you answer it.

**One honest correction that came out of this.** We had reported it as a defect that the matrix says
"allowed" when it has not matched a state. For a state that is simply not on the list, your answer
means that behaviour was **right all along** — so what we are fixing there is narrower than we first
said. The three outcomes are now kept apart in the code and on the answer, so nobody can ever confuse
"allowed because the state has no rule" with "allowed because we checked a rule and it permits it":

  1. state not in the matrix → allowed, unlimited (your direction, above)
  2. state in the matrix, rule checked → whatever the rule says
  3. state in the matrix, rule not checkable → we could not tell, and we hold
