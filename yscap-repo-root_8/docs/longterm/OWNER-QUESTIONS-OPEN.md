# What the long-term pricing build is waiting on from you

**One page, plain language. Every item here is work that is BUILT or ready to build and is stopped
until you answer.** Nothing on this list is a request for more time or more research — each one is a
decision only you can make, or a five-minute action only you can take.

Last measured: 2026-08-18, against the code (not the plan documents).

**How to use it:** answer them in any order. Each answer unblocks the work named under it. Where an
answer would change money that has already been quoted, that is called out.

> **2026-08-18 — you answered nearly all of this page.** Everything you settled has moved to
> **"Answered, for the record"** at the bottom, in your own words. What is left above is only what is
> genuinely still open.

---

## 1. Still outstanding from you

### 1a. Put the Lender Price login into this system's settings

**No longer a rotation request — you have closed that (see the Answered section).** What is still
needed is mechanical: the login has to exist in this system's own settings before any live comparison
can run from here. It is not in this environment today, so the ≥200-scenario agreement check still
cannot run — not for want of permission, only for want of the value being present where the software
reads it.

The one thing that does not change: it goes in the settings, never into the code. A password written
into a file we publish would be readable by anyone who can see the code, which is a different problem
from the one you closed.

### 1b. Your developer's field notes from Lender Price

You said your developer walked through exactly how the Purchase and Cash-out fields behave, and that
those notes are better than a recording. **We could not find them in what has been handed over so
far** — what this system holds is the recorded refinance sessions and the response schema written from
them. Please send them (or point us at where they were shared) and we will encode them directly.

---

## 2. Money rules still open

### 2b. When the rate sheet and the eligibility rules disagree, which one wins?

**You have told us how to answer it rather than answering it, and that is now a build task, not a
question to you:** go into Lender Price's own disqualifier for the scenario, find the actual
disqualifier it names, then look at the rate sheet to see where that same disqualifier is priced —
and put every scenario in front of a person to review.

So this page stops asking you and the work starts: the review queue that lays out, per scenario, the
vendor's disqualifier beside our sheet's own treatment of it. Recorded as a build item.

**BUILT THE SAME DAY (§2.58).** Every scenario Lender Price refuses is now lined up against our rate
sheet and waits as a question in plain words — "they refuse this over the DSCR, our sheet says nothing
about the DSCR at all: should we refuse it, price it, or deliberately allow it?" — with an answer box
beside it. Answering one records what you concluded. **It changes no price and publishes no rule**: a
recorded answer is a decision on paper, and putting a rule in force is still a super admin pressing
Publish. An answer stays answered when the check runs again tomorrow, and only comes back if the
situation behind it actually changes.

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

**Deephaven is settled — you have already given it and it is encoded** (see the Answered section).
For every other investor we have nothing: which penalty types, which terms, and how each one changes
the price. You said you will give these to us one investor at a time; this row stays open until they
arrive, and it is not blocking anything Deephaven does.

### 2e. When a state IS in the matrix but we cannot evaluate its rule, what should happen?

A state that is NOT in the matrix is settled: allowed, no limits (see the Answered section).

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

## 3. Smaller things still unanswered

### 3a. How many clean weeks before an investor goes live?

You have said WHO may switch an investor from watching to live (a super admin). The remaining half is
**how many clean weeks in a row we want first** — we assumed 8 and have never enforced it — and
**whether we keep spot-checking an investor against Lender Price once it is live.**

### 3b. Should the built-in safety checks block a release, or just warn?

Three checks currently warn and do not stop anything: the rule self-audit, the schema drift check, and
the "is this module actually used" check. Making any of them blocking would start failing other
people's work, so it is your call, not ours. (You answered who holds the authority — super admin —
but not whether these particular three should bite.)

---

## Answered, for the record

As you answer, the item moves here with the date and your own words, so nobody has to remember what
was decided or go looking for it in a chat.

### 2026-08-18 — the Lender Price login: use it, stop asking to rotate it

Owner's words:

> "Forget about this. I'm not going to rotate the password. This is not sensitive at all, and I'm
> giving you a written authorization to use it for live comparison at all times. Please don't warn me
> again to rotate the password."

**What this settles:** the login is authorized for live comparison, at all times, without rotation.
The warning is withdrawn from this page and from the status document, and no future report should
raise it again.

**The one thing that is unchanged, and is a different subject:** a password still never goes into the
code itself — it lives in the settings, which is where the software reads it from. That is about where
the value is stored, not about whether it may be used, and it is why 1a above is still on the list.

### 2026-08-18 — the 0.25 holdback COMES OFF the price we offer

Owner's words:

> "It's basically: instead of offering for the bar or the investors' raw pricing, like a 102, we're
> only gonna offer him a 101.75."

**What this settles:** the holdback is a reduction in the price we offer. Take the investor's raw
price, take our margin off it as we already do, then take the holdback off as well — a 0.25 holdback
on a 102.000 raw price is offered as 101.750. It is not a fee, it is not added to anything the
borrower pays at closing, and it never makes a loan ineligible: it is simply a smaller price.

**What it moves:** every price on every program that carries a holdback. It was recorded on every
quote and deliberately not applied until you said this.

### 2026-08-18 — the daily check runs on a schedule, six times a day

Owner's words:

> "This should be a scheduled run: Every day at 9:00 a.m. Eastern, 10:00 a.m. Eastern, 11:00 a.m.
> Eastern, 12:00 p.m. Eastern, 4:00 p.m. Eastern, and 7:00 a.m. Eastern."

**What this settles:** the driver question is answered — a SCHEDULED run, not the sync worker and not
a timer inside the site. Six times every day, Eastern time: **7am, 9am, 10am, 11am, 12pm and 4pm.**

**What we still guarantee regardless:** two servers can never both fire the same check and pay twice
for it — that protection is already built and does not depend on which driver you picked.

### 2026-08-18 — every one of these authorities is the super admin

Owner's words:

> "Who may publish a pricing rule; who may switch an investor from watching to live and after how many
> clean weeks; and whether the built-in safety checks should block a release or only warn. All in the
> super admin."

**What this settles:** publishing a pricing rule, and switching an investor from watching to live, are
super-admin actions. Not a pricing admin, not an ordinary admin.

**Built the same day.** The publish button now exists on the rule board and only a super admin can use
it — an ordinary administrator pressing it is turned back with a plain reason, and nothing is written.
It asks twice before it publishes, because publishing changes what the next borrower is quoted, and it
records who pressed it.

**What it does not settle, and stays open above:** how many clean weeks an investor needs first (3a),
and whether the three safety checks should block or only warn (3b). Those are about the RULE, not
about who presses the button.

### 2026-08-18 — the loan officer margin and compensation model

Owner's words:

> "Company default: the minimum is not enforced. It's not a hard rule. It's a movable default, and
> every loan officer can set this movable default differently. The split does not apply for the
> margin. The entire margin hold back goes for the company."

**What this settles, both open questions inside it:**

1. The company minimum per loan is a **movable default, not a floor** — and each loan officer can
   carry a different default.
2. The officer's split applies to **origination only**. The margin holdback is **entirely the
   company's** and no part of it is split with the officer.

**BUILT THE SAME DAY (§2.59).** Both answers are now in the product: each officer carries their own
compensation numbers, a minimum set for one officer is simply that officer's (nothing bumps it back up
to the company's), and the holdback is the company's in full — never split, never counted toward what
an officer must make on a loan, and structurally impossible for an officer to set. Nothing here changes
a price.

**One number is still missing before anybody's pay can be worked out: what share of the origination the
officer keeps.** It is deliberately left blank rather than filled with a figure we chose — the screen
says "nobody has set it" and works out no net until you do.

### 2026-08-18 — Deephaven's prepayment penalties are already given, and encoded

Owner's words:

> "I gave you the information previously in the chat for DeepAven, exactly how it works. They offer the
> standard, which has three meanings. They also offer the 5% fix for a better price, and then we have
> our custom on top of it with our additional marginal back."

**What this settles:** Deephaven is complete and needs nothing further — the standard soft-declining
structure, the 5% Fixed promotion at a better price, and our own softer custom structure carried as an
additional margin holdback on top. All three are encoded and tested.

**What is still owed by you:** the same for every OTHER investor, one at a time, which is why 2d above
stays open with Deephaven struck out of it.

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

### 3c. Should the standard 0.25 holdback apply to every investor, or only where somebody sets it?

**This is new, and it came out of building your answer — not out of a plan.** You told us what the
holdback DOES to a price ("102 becomes 101.75"), and that is built. What that answer does not say is
**which investors carry one.**

Right now the 0.25 is a pre-filled suggestion sitting in the settings for every investor, not a number
anybody typed. So we have made it work this way: **set a holdback and it comes off the price; leave it
alone and nothing changes.** That way no price moves without somebody deciding it should.

The alternative is that the 0.25 is simply how we do business and should come off everywhere by
default. That is a reasonable reading of your answer — but it would quietly move the price on every
loan on every program the moment it shipped, so we are not going to assume it.

**Which is it?** If it is "everywhere by default", say so and it is a one-line change.
