# The borrower-facing DSCR Pricing Engine — the research, and how it gets built

**STATUS: RESEARCH for the BORROWER side — nothing of it is built and nothing is
live. The OFFICER-side term sheet (Phase 1) IS built as of 2026-08-30, behind
`termSheet.officerEnabled`, switched ON 2026-08-30 (owner-directed); see
`TERM-SHEETS-AND-COMPARISON.md` §13a. The owner's answers of 2026-08-30 and what
each one changed are §10a below.**
Owner-directed 2026-08-30: *"we're not putting it live yet we're just starting to work on it …
do the research how to set it up."* This document is the design that a build would follow, the
decisions it rests on, and the questions that must be answered before a line of it ships.

**Product: LONG-TERM (LT) only.** Everything described here lives in `src/longterm/**`,
`app-v2/src/longterm/**`, `/api/lt/*`, `lt_*` tables and `db/NNN_lt_*.sql`. Nothing crosses to
RTL. §12 lists every place where a crossing would be tempting and what would have to happen
first.

**Companion documents**

| Document | What it covers |
|---|---|
| **`BORROWER-PRICING-LANGUAGE.md`** | The wording layer — how 101 / 102 / 99 becomes a sentence an experienced investor reads without being babysat |
| **`TERM-SHEETS-AND-COMPARISON.md`** | The term sheet (ID, snapshot, replay, PDF) and the two comparison workflows |
| **`PRICING-RATE-MOVEMENT-REPORTS.md`** | The daily "what moved" reports for loan officers, priced by PRICE and not by rate |
| **`PREPAY-PENALTY-MAPPING.md`** | The declared blocker: 19 vendor prepay structures vs. the ones we are willing to offer |

---

## 0. What was asked for

The owner's message of 2026-08-30, decomposed into the eleven things it actually asks for. The
order below is the order this document answers them in, not the order they were spoken.

1. **Company default OFF.** Borrowers have no access to the pricing engine.
2. **Per-officer switch ON.** *"every loan officer can turn it on on their self and all their
   borrowers should get access to the pricing engine for long term loans."*
3. **It is called "DSCR Pricing" to a borrower** — never "the pricing engine", never Lender Price.
4. **It prices off the officer's own compensation settings** — borrower-paid, YSP, lender-paid.
5. **Investor visibility is selectable** — *"they can select which investors their borrowers
   should be able to see … by default should be all on but they can turn off certain investors
   for their entire profile and then they could go into each and every borrower profile and they
   can switch on and off."*
6. **Per-borrower pricing overrides** — a DSCR Pricing tab on the borrower's profile where the
   officer can *"set different pricing rules to override their own charge for a certain borrower
   less or for certain more."*
7. **Borrower-friendly comp choice** — *"want to get a better rate and pay origination fees or
   you want to rather get a no point no fee"*, plus the option to waive lender fees.
8. **Borrower-friendly language** — *"they're not going to understand the professional PPE
   language, 101, 102, 99 … more like: for this one you pay no points, get this amount of
   credit"* — and explicitly **not** over-explained: *"our borrowers are experienced investors
   and we don't want to babysit them."*
9. **Term sheets, exportable** — by the borrower, and by the officer **from today**. Raw pricing
   may never export. One program, or many, on one PDF.
10. **Comparison** — two distinct workflows, both using the arithmetic already proven in the
    Investor Suite tools; a comparison cart that survives across separate searches.
11. **Daily rate-movement reports** for loan officers, by price not rate, with a company default
    at 1:30 PM Eastern, weekdays.

Items 8–10 are in `BORROWER-PRICING-LANGUAGE.md` and `TERM-SHEETS-AND-COMPARISON.md`; item 11 is
in `PRICING-RATE-MOVEMENT-REPORTS.md`. This document carries 1–7 and the plumbing all of them
share.

---

## 1. The rules this design is not allowed to break

These are not preferences. Each is already enforced by a gate, a test, or a hard rule in
`CLAUDE.md`, and the borrower surface is the highest-stakes place any of them has ever been
applied.

### 1.1 The investor name never reaches a borrower — HARD RULE

`CLAUDE.md` rule 10, owner-directed 2026-08-14: *"The client should not be able to see the
investor name. Never ever! Not borrowers, not TPOs, only internal staff."* Enforced by
`src/longterm/audience.js` (fails closed — anything not exactly `internal` is a client) and
`scripts/test-lt-investor-block.js`, which sweeps all 150 recorded spellings through five
sentence shapes.

**What this means here, structurally.** The staff pricer today receives the vendor's answer with
`lender`, `investor`, `lenderId` and `rateSheetName` on every row, and decorates it with the
white-label name beside them (`investorPrograms.decorate`). A borrower's board may not be that
object with fields hidden. It must be **a different payload, built for the borrower**, in which
those keys were never selected — the same discipline `routes/my-loans.js` already uses and
documents at length:

> *"Building the payload FOR the client rather than filtering one built for staff is the first of
> the two defences that rule names."*

So the borrower pricing route is **not** `POST /api/lt/dscr/price` with a filter. It is its own
door with its own projection. §7 says so explicitly.

**The white-label sheet is already consumer-safe by construction.** All 24 names in
`src/longterm/lenderprice/investor-programs.js` (Eresi→Platinum, Deephaven→Diamond, Verus→Pearl,
…) are proven by `test-lt-investor-programs-pure.js` to pass the audience scrub untouched. An
investor with **no** white-label name has `consumerLabel: null` — never its own name, never a
guess. That fail-closed behaviour is exactly what the borrower board needs, and §3.4 turns it
into a rule: **a program with no consumer label is not shown to a borrower at all.**

### 1.2 Nothing on this surface may change what is asked of Lender Price

Owner-directed 2026-08-23, and the whole basis of the compensation overlay:

> *"We are building overlays on top of Lender Price. You are not going to actually take this
> switch in Lender Price. You are going to leave Lender Price always searched as borrower-paid.
> This is just overlays on top of them."*

`search-model.js` pins `compensationType: 'BorrowerCompPlan'` on every request. The comp switch,
the investor filter and the saved groups are all **display overlays** that run on the answer.

The borrower surface inherits this unchanged. The borrower's own choice between "better rate" and
"no points", their fee waive, their officer's comp plan, the per-borrower override — **none of it
reaches the wire.** One search is run, the same search staff run, and everything the borrower sees
is arithmetic on that answer. This matters for three reasons: it keeps one vendor cost per
scenario, it keeps the borrower board and the officer board provably the same numbers, and it
means a term sheet exported by the officer and one exported by the borrower can never disagree.

### 1.3 Investor *narrowing* for a borrower is the one place the overlay rule inverts

`investorFilter.js` states the staff rule plainly:

> *"a program the server could not resolve (`investorKey` null — a brand-new lender nobody has
> mapped) is KEPT whatever the selection, because hiding a row nobody chose to hide is the
> silent-drop this engine exists not to do."*

That is right for staff and **wrong for a borrower**. On the staff board an unmapped lender is a
row to investigate; on a borrower's board it is an unnamed investor we have no consumer-safe label
for, which is a rule-10 exposure. So on the borrower surface the same fact produces the opposite
behaviour: **an unmapped program is dropped, and the drop is reported to staff, never to the
borrower.** §3.4.

This inversion is the single most important design decision in this document, and it is why the
borrower board cannot be the staff board with a flag.

### 1.4 Everything tenant-specific is a setting, pre-filled with our answer

The sellable-LOS rule. Every default in this design — the company OFF switch, the 1:30 PM report
time, the wording strings, the term-sheet expiry — is declared in
`src/longterm/settings/encompass-settings.js` with our value as its `default`, and a `notWired`
line until something reads it (`scripts/test-lt-settings-wired-pure.js` fails the build on a knob
that changes nothing and does not say so).

### 1.5 Fail closed, everywhere, and say so

A settings read that fails is not permission to show a borrower anything. An officer whose comp
plan cannot be resolved does not price at a guessed 2.0 — `comp-plan.js` already refuses the whole
plan and `compOverlay.normalizePlan` returns null. On the **staff** board that falls back to raw
pricing with a notice. **On the borrower board there is no raw pricing to fall back to** (§5.1),
so the answer is: the board does not render, and it says *"pricing is temporarily unavailable —
your loan officer has been notified."* A borrower must never see a number nobody chose.

---

## 2. The entitlement chain — who may open the DSCR Pricing tab

### 2.1 Four gates, ANDed, every one fail-closed

A borrower sees the DSCR Pricing tab only when **all four** are true:

| # | Gate | Where it lives | Default |
|---|---|---|---|
| 1 | The long-term borrower surface is on at all | `borrower.longTermVisible` (existing) | **on** (owner, 2026-08-17) |
| 2 | The company permits borrower pricing at all | `borrowerPricing.companyEnabled` (new) | **OFF** — the owner's first sentence |
| 3 | The borrower's officer has switched it on for themselves | `borrowerPricing.officerEnabled` at scope `user:<staff id>` (new) | **off** |
| 4 | This particular borrower is not individually suppressed | `lt_borrower_pricing_profile.enabled` (new, nullable → inherit) | inherit |

Gate 2 is the company kill switch. It exists separately from gate 3 because the owner asked for
the *company* default to be off — which is a different statement from "every officer's personal
default is off". Gate 2 off means **no** borrower prices, however many officers switched
themselves on; it is what makes "we are not live yet" a single setting rather than a deploy, and
it is what a future buyer of this system flips to turn the whole feature on.

Gate 4 exists because the owner asked for per-borrower control of investors and pricing; the same
row is the natural place to say "not this borrower at all", and an officer will want it the first
time a deal goes sideways.

### 2.2 Which officer is "theirs" — the hard part, and the honest answer

*"all their borrowers should get access"* presumes each borrower has **one** officer. The data
does not guarantee that.

- `borrower_officers` (db/327, identity zone, LT holds `sql-write` authorization) has primary key
  `(borrower_id, staff_id)` — it is explicitly **many-to-many**. A borrower who has done business
  with two officers has two rows.
- `lt_loan_contacts` carries the officer per long-term loan, with an `override_staff_id` a human
  can set. A borrower with three LT files can have three different officers on them.

So "the borrower's officer" is not a column; it is a decision. Three sub-questions fall out, and
each has an expensive wrong answer:

1. **Whose switch decides access?** If officer A has pricing on and officer B has it off, and both
   are linked to this borrower — does the borrower see pricing?
2. **Whose comp plan prices it?** A and B may have different borrower-paid figures. The number on
   the screen is somebody's income.
3. **Whose investor list and whose per-borrower overrides apply?**

**The recommendation, and it is deliberately the narrow one.** Resolve a single
**pricing officer** per borrower, by this ladder, and refuse to price when it does not land:

```
1. The officer on the borrower's MOST RECENT long-term loan
   (lt_loan_contacts, role='loan_officer', override_staff_id ?? staff_id,
    newest lt_loans row for this borrower_id)
2. else, if borrower_officers holds EXACTLY ONE staff_id → that person
3. else → NO PRICING OFFICER. The tab does not appear.
   The ambiguity is reported on the staff side as a named, workable row.
```

Rung 1 is first because it is the only rung grounded in a **long-term** fact, and because a human
has already had the chance to correct it (`override_staff_id`). Rung 2 catches the prospect who
has no LT file yet — exactly the person an officer most wants to hand a pricer to. Rung 3 is the
fail-closed floor: two officers disagreeing is not a tie to be broken by `ORDER BY created_at`; it
is a question for a human, and pricing the wrong officer's comp is worse than not pricing.

**The staff-side consequence, which must be built with it:** a screen listing every borrower whose
pricing officer could not be resolved, with the reason and a one-press assignment. Without it,
rung 3 is a silent hole and officers will report "my borrower can't see pricing" with no way to
find out why. This is the same discipline `LtBorrowers.jsx` already applies to borrower links —
*"a row we will not propose says WHY in plain words rather than sitting there as an unexplained
blank."*

**This is open question OQ-1 (§11) and the build should not start until the owner answers it.**
A defensible alternative he may prefer: let the officer *claim* pricing for a borrower explicitly
on the borrower's DSCR Pricing tab, making the relationship a decision rather than an inference —
which is more work to set up and has no ambiguity at all.

### 2.3 One resolver, and everything reads it

`src/longterm/borrower-pricing-access.js` — **pure**, no database, handed what it needs, exactly
like `access.js` and `comp-plan.js`. One function answers the whole question:

```js
resolveBorrowerPricing({
  companySettings,      // lt_settings scope 'company'
  officerSettings,      // lt_settings scope `user:<staffId>`
  officerStored,        // Set of keys the officer actually holds a row for
  defaults,             // settingsStore.defaults()
  pricingOfficer,       // { staffId, source: 'lt_loan' | 'borrower_officers' } | null
  borrowerProfile,      // lt_borrower_pricing_profile row | null
})
// →
{
  allowed: false,
  reason: 'no_pricing_officer' | 'company_off' | 'officer_off' | 'borrower_off' | 'no_comp_plan',
  officerStaffId: null,
  plan: null,            // the effective comp plan, comp-plan.js shape
  planSource: null,      // 'yours' | 'company' | 'standard' | 'borrower-override', per figure
  investors: [],         // canonical keys the borrower may see — never a wildcard
  reasonForStaff: '…',   // a sentence a human can act on; NEVER shown to the borrower
}
```

Two properties make this worth being its own module rather than logic inside a route:

- **`reason` is never rendered to the borrower.** The borrower sees a tab or does not. The reason
  is for the officer's screen and for the staff diagnostic list. A borrower learning that "your
  officer has not enabled pricing" is a conversation we did not choose to have.
- **`investors` is a concrete list, never `null` meaning "all".** On the staff overlay, an empty
  selection means *show everything* — the right default for a person allowed to see everything.
  Carrying that convention onto the borrower surface would make an empty or unreadable setting
  mean "show every investor", which is the failure that leaks. Here, empty means **nothing
  prices**, and the resolver expands "all on" into the explicit roster at resolution time.

### 2.4 What the borrower's session actually gets

The resolver runs **server-side, per request, on the borrower's own session** — never from a
client-supplied officer id, exactly as `routes/settings.js` derives scope from the session:
*"the scope is derived from the session, never taken from the request, so there is no id to
tamper with."*

`GET /api/lt/my/pricing/profile` answers, for a permitted borrower:

```json
{ "enabled": true,
  "label": "DSCR Pricing",
  "modes": ["lowerRate", "noPoints"],
  "mayWaiveLenderFees": true,
  "lenderFees": { "application": 1595, "commitment": 500 },
  "investorCount": 14,
  "termSheetsEnabled": true }
```

Note what is **not** there: no officer id, no officer name unless the officer's branding says so,
no comp figures, no investor keys, no white-label names (those arrive per answer, with the
results). `investorCount` is a count and not a list because a list of 14 jewel names before a
search invites "why did Diamond not show up", which is a staff question.

---

## 3. Investor visibility

### 3.1 Three layers, and they only ever narrow

| Layer | Scope | Stored as | Default |
|---|---|---|---|
| **Company roster** | the whole tenant | `borrowerPricing.companyInvestors` (list of canonical keys, or the sentinel `"*"`) | `"*"` — every white-labelled investor |
| **Officer allow-list** | one officer, all their borrowers | `borrowerPricing.investors` at scope `user:<staff id>` | `"*"` — *"by default should be all on"* |
| **Borrower exceptions** | one borrower | `lt_borrower_pricing_profile.investors_off` (array of keys to REMOVE) | `[]` |

The effective set is:

```
effective = expand(companyRoster) ∩ expand(officerAllowList) − borrowerExceptions
```

**Intersection, never union**, and the borrower layer subtracts only. Three consequences worth
stating because each is a bug someone will otherwise write:

- An officer cannot re-enable an investor the company turned off. The company layer is a ceiling.
- A borrower exception cannot *add* an investor. It is a deny list by construction — which is why
  it stores `investors_off` and not `investors`. A stored allow-list on the borrower row would
  silently expand the officer's set the day the officer *removes* an investor.
- `"*"` is expanded to the concrete roster **at resolution time**, from
  `investorPrograms.fullRoster()`. So an investor christened next month is automatically on, which
  is the behaviour the owner already asked for on the staff side (*"CorrFirst is not available yet
  … when they come up, they should be there"*). If an officer wants a new investor off, they turn
  it off — the same as staff.

### 3.2 Why the borrower narrowing must happen on the SERVER

On the staff board the investor filter is a browser-side display overlay, and the docs are emphatic
that it must stay one. On the borrower board it cannot be: a filter in the browser means the
suppressed programs — with their white-label names, their prices, and in the `full:true` payload
their lender and investor strings — were **sent to the borrower's machine** and merely not drawn.
That is a rule-10 exposure recoverable with the network tab open.

So: `POST /api/lt/my/pricing/search` runs the same one search upstream, and **projects** the answer
down to the permitted set before it leaves the server. The wire to the vendor is unchanged (§1.2);
what changes is what crosses our own boundary to a client.

### 3.3 What the borrower is told about what is missing

The staff rule is *"nothing is silently dropped"* — a selected investor that returned nothing is
named. The borrower rule is the opposite and for the same reason: **naming an investor that was
excluded tells the borrower an investor exists that they cannot see**, which invites the one
question we may not answer.

So the borrower board says nothing about exclusions. It says what it has: *"14 programs matched
your scenario."* If the permitted set produced zero rows, it says so plainly and without cause —
*"No programs matched this scenario. Try a lower LTV or a different prepayment term."* — and the
same event is logged for staff with the full reason.

### 3.4 The unmapped-investor rule (the inversion from §1.3)

A program row reaches a borrower **only if** `consumerLabel` is non-null — i.e. the vendor row
resolved to a canonical investor key AND that key is on the owner's white-label sheet.

Everything else is dropped **before** the payload is built, and each drop appends to a staff-side
`unmappedForBorrowers` counter surfaced on the pricing admin screen with the vendor's own lender /
investor strings, so the owner can christen it — the same job `investorsUnmapped` already does on
the staff board. A borrower is never told a row was dropped and never told why.

This is a real, current condition and not a hypothetical: Amwest quoted in Lender Price on
2026-08-27 with no white-label name.

---

## 4. Per-borrower pricing overrides

### 4.1 What exists today

`comp-plan.js` resolves five figures through **person → company → declared default**, with a hard
floor: *"an officer may set their own figure only AT OR ABOVE the company's"* — enforced twice, at
the settings door and again at read time, so raising the company default lifts every officer's
floor. The two lender fees are company-only. The owner's words, 2026-08-23: *"They cannot put it
on their profile as a setting for lower … For now, on both sides, they can only put it higher."*
And, in the same breath: *"Going lower on a specific file is an exception the company approves"* —
explicitly deferred at the time.

### 4.2 What is being asked for now

*"the loan officers should be able to go to the borrower profile, go into a DSCR pricing tab and
set different pricing rules to override their own charge for a certain borrower less or for
certain more."*

This is that deferred exception, reopened — and it is now **per borrower**, not per file. It adds a
**fourth source** below the person's own row:

```
borrower override → the person's own row → the company's value → our declared default
```

### 4.3 The two directions are not the same thing, and must not share a door

**Upward** (charge this borrower more) is an ordinary officer decision. It needs no approval; it
is bounded by the existing typo guard (0–10 points).

**Downward** (charge this borrower less) crosses the company floor. The floor exists because a
company figure is what the company earns, and the owner was explicit that an officer may not sit
below it as a standing setting. A per-borrower downward override is exactly the *"exception the
company approves"* he described.

**The recommendation:** build both, in one row, but gate them differently.

- Above the officer's own effective figure → saves immediately, audited.
- At or below the **company** figure → requires a second person. The narrowest door that already
  exists in this codebase for a money-governing change is the super-admin gate
  (`SUPERADMIN_KEYS` in `routes/settings.js`, owner-directed 2026-08-23: *"you need to set
  superadmin settings to control the company defaults"*). A downward override should be
  **requested** by the officer and **approved** by a super admin, with the row storing
  `requested_by`, `approved_by`, `approved_at` and a reason — and pricing the *unapproved* figure
  never, at any point, not even to preview.
- Between the company figure and the officer's own higher figure → the officer is only giving up
  their own margin, not the company's. **This should save immediately**, and it is probably the
  common case. Worth confirming (OQ-2).

**Fees are not overridable per borrower.** The application and commitment fees are what the
company charges (`comp-plan.js` is explicit: *"a fee a person could set for themselves would be a
person deciding what the company charges"*). Waiving them per quote is already a borrower-facing
option under lender-paid (§5.2) and is the right mechanism; a per-borrower fee override is a
second, quieter one. Recommend: **no**.

### 4.4 Where the resolution lives

Extend `comp-plan.js` — do **not** write a second resolver. It is pure, CI-tested
(`scripts/test-lt-comp-plan.mjs`), and its floor logic is the thing that must not be duplicated.
The new signature takes an optional `borrowerOverride` and an `approvals` object, and `source[k]`
gains `'borrower'`. Everything downstream — `compOverlay`, the fee list, the closing sheet — is
untouched, because it already consumes a resolved plan and does not care where the figures came
from.

That is the whole point of the existing shape, and it is why this feature is smaller than it
sounds.

---

## 5. The borrower's pricing board

### 5.1 There is no raw pricing for a borrower

The staff switch has three positions with **raw in the middle as the default**. A borrower's board
has two, and raw is not one of them.

Raw pricing is the vendor's answer before our compensation is applied. Showing it to a borrower
would show them what we make — and the owner's rule for both comp modes is that *"the lender-paid
compensation should always also be kept invisible on both of the sides"*. It is also the state the
owner explicitly barred from export: *"raw pricing you should not be able to export anything."*

So: raw is staff-only, on the staff board, unchanged. The borrower board is built from
`quoteCharges(mode, plan, rawPrice, loan, waive)` in the two comp modes only, and the `'raw'` value
is not a legal input on the borrower door — a request carrying it is a 400, not a fallback.

**Consequence for §1.5:** when the plan cannot be resolved, the staff board degrades to raw with a
notice. The borrower board **has nowhere to degrade to**. It must not render.

### 5.2 The two questions the borrower is actually answering

The owner's framing: *"want to get a better rate and pay origination fees, or you want to rather
get a no point no fee."*

That is one question with two answers, and it maps exactly onto the two comp modes we already
compute. The mapping — and the reason it is not a lie — is:

| Borrower's choice | Comp mode | What actually happens |
|---|---|---|
| **Pay points, get the lower rate** | `borrowerPaid` | The board keeps the raw price (less any YSP); our compensation is charged as origination on the fee list. |
| **No points — I'll take the rate** | `lenderPaid` | The displayed price drops by the lender-paid comp; at raw 102 with a 2.0 comp the borrower is at par and pays no origination. |

The second question, offered **only** under "no points" because the owner scoped it there
(*"borrower-paid compensation should not have the option to waive lender fees"*):

| **Waive the lender fees** | The $1,595 + $500 do not populate as fees; the $2,095 comes out in **cash** — off the credit first, onto the buydown when the credit cannot cover it. |

`compOverlay.quoteCharges` already implements every line of that table, including the cash-not-
points waive arithmetic and its scale check (*"on a $100k loan the waive is worth ~2.1 points, on a
$1M loan ~0.21"*). **The borrower board is a new presentation of an engine that already exists and
is already tested.** The wording of the choice is `BORROWER-PRICING-LANGUAGE.md` §2.

**A named risk.** Under "no points", `quoteCharges` returns a credit when the shifted price is over
par. That credit is real and the borrower may keep it — but if the officer's comp plan is high
enough that most rows price under par, the "no points" option shows a **buydown** on nearly every
row, which reads as a bait-and-switch against the label. The board must therefore never label the
choice "no cost"; it labels it by what it is, per row (`BORROWER-PRICING-LANGUAGE.md` §3), and the
officer's preview (§9, Phase 1) exists partly so an officer sees what their own settings do to that
option before a borrower does.

### 5.3 The search form: what a borrower may set

The staff form exposes the full registry — every adverse-credit dynamic, bankruptcy seasoning,
citizenship, tradelines, charge-offs. A borrower filling in *"Foreclosure: FC_3yr"* about
themselves is not a pricing screen; it is an application, and a worse one than the application we
already have.

**Recommended split:**

| Borrower sets | Borrower does not set | Why |
|---|---|---|
| Purpose (Purchase / Rate-term / Cash-out) | Income doc type | Fixed: DSCR |
| Property value / purchase price | Compensation type | It is the two-question choice above |
| Loan amount **or** LTV (the amount triangle derives the third) | Broker comp percent | Not a borrower concept |
| Credit score — as a **band**, not a number (§below) | Every adverse-credit registry field | An officer's field, on a call |
| Property type, units, ZIP | Lock days | Not a borrower decision pre-application |
| Rent, taxes, insurance, HOA → the DSCR calculator | Subordinate financing | Rare; officer-assisted |
| Prepayment term + structure | Rate sheet / program selection | Ours |
| Interest-only | | |
| Escrow waiver | | |

**Credit score as a band is a deliberate softening, and it may be wrong.** The vendor prices off a
FICO number and our existing form takes one. A band (e.g. 760+, 740–759, …) is friendlier and
avoids a borrower typing an aspirational 800. But the owner said *"we don't want to babysit
them"* and an experienced investor knows their score. **Recommend: take the number, exactly as
staff do**, with helper text that it is an estimate and will be verified. Flagged as OQ-3.

**Every field the borrower does not set still has to be sent**, because the vendor's answer depends
on the full DSCR profile. They take the same defaults the staff pricer takes — the profile default
of five-year Standard prepay, `IncomeDocType: DSCR`, borrower type LLC — via exactly the same
`search-model.js` path. There is no second set of defaults and there must never be, because two
default sets is how the borrower board and the officer board start quoting different numbers for
the same deal. `scripts/test-lt-borrower-pricer-parity.*` (§10) exists to prove they do not.

### 5.4 The DSCR calculator is the same calculator

`dscrCalc.js` is already pure, already mirrored against the server's `computeDscr` by
`scripts/test-lt-dscr-calc.mjs`, and already carries the owner's monthly/yearly toggle and the
interest-only rule. It ships to the borrower board unchanged. Its *labels* change
(`BORROWER-PRICING-LANGUAGE.md` §5); its arithmetic does not.

Its refusal behaviour is exactly right for a borrower: *"a blank field must never silently become
a zero and produce a 0.00 ratio"* — it names what is still needed instead of showing a confident
wrong number.

---

## 6. Data model

Five new `lt_*` tables. **Every number below is a placeholder** — run
`npm run migration:new -- "…"` to get the real one; never hand-pick from `db/` (`AGENTS.md` §4).

### `lt_borrower_pricing_profile`
One row per borrower, written by their pricing officer or an admin. This is the borrower's DSCR
Pricing tab, persisted.

```
borrower_id        uuid  PK  -- REFERENCES borrowers(id): sql-ref/sql-read already authorized
enabled            boolean NULL      -- NULL = inherit the officer's switch; false = off for this borrower
investors_off      text[]  NOT NULL DEFAULT '{}'   -- canonical keys to SUBTRACT (§3.1)
comp_override      jsonb   NULL      -- { lenderPaid?, borrowerPaid?, ysp? } — points, the officer's figures
override_direction text    NULL      -- 'up' | 'down' — derived and stored, so the gate is queryable
requested_by       uuid    NULL REFERENCES staff_users(id)
approved_by        uuid    NULL REFERENCES staff_users(id)   -- required when direction='down'
approved_at        timestamptz NULL
note               text    NULL      -- why; shown to staff, never to the borrower
updated_by         uuid, updated_at timestamptz
```

`borrower_id` as the primary key, not `(borrower_id, staff_id)`: the profile describes **the
borrower**, and a second officer's competing profile for the same person is the §2.2 ambiguity
wearing a different hat. If the owner picks the explicit-claim model in OQ-1 this becomes
`(borrower_id, staff_id)` — which is one of the reasons OQ-1 must be answered first.

### `lt_term_sheet`
See `TERM-SHEETS-AND-COMPARISON.md` §4. The frozen snapshot behind a term-sheet ID.

### `lt_term_sheet_scenario`
The comparison cart's members — one row per selected program, each carrying its own scenario, so a
comparison can span separate searches. `TERM-SHEETS-AND-COMPARISON.md` §6.

### `lt_price_snapshot`
The daily price observation per investor × program × canonical scenario, which is the only thing
that makes "what moved since yesterday" answerable. `PRICING-RATE-MOVEMENT-REPORTS.md` §3.

### `lt_pricing_report_subscription`
A person's own report subscriptions, following the `lt_pricer_investor_groups` (db/634) shape — a
named per-user arrangement is a row, never a code change.
`PRICING-RATE-MOVEMENT-REPORTS.md` §5.

**Settings, not tables** (declared in `settings/encompass-settings.js`, group **Borrower pricing**):
`borrowerPricing.companyEnabled` (bool, **false**), `borrowerPricing.officerEnabled` (bool, false,
personal), `borrowerPricing.companyInvestors` (list, `["*"]`), `borrowerPricing.investors` (list,
`["*"]`, personal), `borrowerPricing.label` (string, `"DSCR Pricing"`),
`borrowerPricing.termSheetsEnabled` (bool, false), `termSheet.officerEnabled` (bool — the one that
can go on now, §9), `termSheet.expiryDays` (number, 2 — OQ-5),
`termSheet.showLenderFees` (bool, true).

---

## 7. API surface

### Borrower doors — `/api/lt/my/pricing/*`
Mounted at the **existing borrower seam** (`src/server.js` line 512: `requireAuth`,
`requireBorrower`), never inside the staff `/api/lt` router. New file
`src/longterm/routes/my-pricing.js`.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/profile` | §2.4. 200 with `{enabled:false}` when not permitted — never 403, so the portal can tell "off" from "broken" (the `my-loans.js` precedent) |
| `POST` | `/search` | The borrower's scenario. Runs one upstream search; **projects** the answer (§3.2). Returns consumer-labelled programs, both comp modes pre-computed, no lender/investor/rateSheet keys |
| `POST` | `/compare` | The comparison cart → the comparison payload |
| `POST` | `/term-sheet` | Mints a term sheet ID + PDF |
| `GET` | `/term-sheet/:id` | The borrower's own, only |

**The projection is a whitelist, not a filter**, and it is the payload builder — the same
structural defence `my-loans.js` documents: *"a column added to `lt_loans` tomorrow, an investor
field, a funding channel, a buy rate, cannot reach a client through this door because nobody asked
for it."*

### Officer doors — inside the staff `/api/lt` router

| Method | Path | Notes |
|---|---|---|
| `GET`/`PUT` | `/api/lt/dscr/borrower-pricing/:borrowerId` | The borrower's DSCR Pricing tab |
| `POST` | `/api/lt/dscr/borrower-pricing/:borrowerId/preview` | *Price as this borrower sees it* — the same projection, run by the officer. Non-negotiable: an officer must be able to see exactly what they are handing out |
| `GET` | `/api/lt/dscr/borrower-pricing/unresolved` | The §2.2 ambiguity list |
| `POST` | `/api/lt/dscr/term-sheet` | Officer-side export (Phase 1 — can go live now) |
| `GET` | `/api/lt/dscr/term-sheet/:id` | Replay (`TERM-SHEETS-AND-COMPARISON.md` §5) |
| `GET`/`PUT` | `/api/lt/dscr/reports/subscriptions` | `PRICING-RATE-MOVEMENT-REPORTS.md` |

`GET /api/lt/dscr/comp-plan` (existing) gains an optional `?borrowerId=` so the officer's board can
show the effective plan **for that borrower** — reusing the one resolver rather than a second copy.

---

## 8. Front end

```
app-v2/src/longterm/
  borrowerPricing.js         PURE. Vendor answer + entitlement → the borrower's board model.
                             Plain .js, not .jsx — the priceBuild.js/compOverlay.js rule:
                             "a rule inside the screen is a rule CI cannot run."
  borrowerWording.js         PURE. Every borrower-facing string and number→sentence rule.
                             BORROWER-PRICING-LANGUAGE.md is its spec; the doc's worked
                             examples are its test fixtures.
  comparison.js              PURE. Both comparison workflows + the break-even arithmetic.
  BorrowerDscrPricer.jsx     The borrower's board.
  BorrowerPricingTab.jsx     The officer's per-borrower tab (investors, overrides, preview).
  TermSheetPanel.jsx         Selection → export, on the officer board and the borrower board.
```

`BorrowerLongTerm.jsx` gains the tab. It is already the LT borrower screen, reached through the
one authorized RTL seam (`rtl-import app-v2/src/screens/Dashboard.jsx`) — **no new crossing is
needed for the borrower entry point**, which is worth knowing before someone goes looking for one.

---

## 9. Phasing — what can ship, and what waits

The owner drew the line himself: *"the entire borrower-facing is not going live yet we're just
prepping it, but we can add live right away on the officer side to export term sheets."*

**Phase 1 — officer-side term sheets. Can go live.**
`termSheet.officerEnabled`. The officer board gains selection, the comparison cart, and export in
the two comp modes (raw cannot export). Everything it produces is already borrower-safe by
construction, because the white-label + consumer-label chain is what a term sheet prints. It needs
none of §2, none of §3, none of §4. **This is the piece to build first**, and building it first is
what proves the borrower-facing wording and the PDF before a borrower ever sees one.

**Phase 2 — the rate-movement reports. Can go live.**
Independent of everything borrower-facing; staff only; the company default at 1:30 PM Eastern.
Its one real dependency is the daily price snapshot, which needs to start collecting **before** the
first report can compare anything to yesterday — so the snapshot job ships first and the emails
follow a day later, by construction.

**Phase 3 — the entitlement chain and the officer's controls. Built dark.**
§2, §3, §4, and the officer's `/preview` door. `borrowerPricing.companyEnabled` stays **false**, so
no borrower can reach any of it. The preview is what makes this phase testable by real people
without a real borrower.

**Phase 4 — the borrower's board. Behind the company switch, still off.**
§5 plus the language layer. Ships dark.

**Phase 5 — the prepayment mapping.** `PREPAY-PENALTY-MAPPING.md`. **The gate on Phase 4 going
live**, by the owner's own instruction: *"before we're putting it live I want to work on the
prepayment penalty structures … we cannot offer for the borrower so many prepayment penalty
structures, we need to map them out according to our own structures."*

---

## 10. How this gets proven

The house rule: *"make every test fail on purpose before you trust it."* The suites this needs,
and what each one exists to catch:

| Suite | Proves | The mutation it must fail on |
|---|---|---|
| `test-lt-borrower-pricing-access-pure.mjs` | The four gates, the officer ladder, the fail-closed floor | Flip any default to `true`; make rung 3 pick an officer |
| `test-lt-borrower-investor-scope-pure.mjs` | Intersection-not-union; `"*"` expansion; exceptions subtract only | Make the borrower layer an allow-list |
| `test-lt-borrower-payload-pure.mjs` | The projection is a whitelist | Add `investor` to the projected shape — must fail |
| `test-lt-borrower-investor-block.js` | Every one of the 150 recorded spellings, swept through a **rendered borrower board and a generated term sheet PDF** | Any spelling that survives |
| `test-lt-borrower-pricer-parity.mjs` | The same scenario through the staff path and the borrower path yields identical prices | Give the borrower path its own default |
| `test-lt-comp-plan.mjs` (extend) | The borrower override's four-source resolution; the down-gate | Let an unapproved downward override price |
| `test-lt-borrower-wording.mjs` | The worked examples in `BORROWER-PRICING-LANGUAGE.md`, verbatim | Any drift between the doc and the strings |
| `test-lt-term-sheet-*.mjs` | ID, snapshot, replay, raw-cannot-export | Allow a raw-mode export — must fail |
| `test-lt-price-snapshot-*.js` | The daily snapshot + delta arithmetic | Compare by rate instead of price |

The investor-block suite is the one that must be written **first and run against a real rendered
page and a real PDF**, not against an object. The existing `test-lt-investor-block.js` proves the
scrubber; this one has to prove the whole borrower surface, because the expensive failure here is
not a bad number — it is a name.

---

## 10a. ANSWERED BY THE OWNER, 2026-08-30 — and what each answer changed

These were put to the owner while Phase 1 was being built. Each one is recorded
with what it settled, because the reasoning behind a design is worth more later
than the design itself.

### The three findings, and the correction to the first two

The research reported three things. The owner confirmed all three and corrected
the framing of the first two, which is the more useful half.

**Finding 1 — borrower-paid and lender-paid cost the borrower the same at every
price.** The arithmetic is
`net(borrowerPaid) − net(lenderPaid) = loan/100 × (borrowerPaid + YSP − lenderPaid)`,
which is zero under the company defaults. The owner:

> *"That's basically right but it's the way you phrase it … if you say borrower
> paid and you give him four points credit, then two points goes for the
> origination and two points goes for him, but if you want to phrase it in a
> better nicer way, it's no points and two points back to him. So it's
> technically the same."*

And then the shape it is actually for:

> *"Let's say I want to give someone 3 offers: borrower paid 2 points and you
> give him basically a par rate and he pays the two points. You give him lender
> paid and you're waiving him the two points so it's a higher rate and he doesn't
> pay the points. You give him a point credit back, lender paid plus a point
> credit back. Same thing with waiving the lender fees. It's technically a wash
> that comes off of his credit but it's phrasing it nicer for him, and it's all
> the way the officer wants to phrase it for his client."*

**WHAT THIS CHANGED, and it is a real design change rather than a note.** The
comp mode and the fee waive had been SHEET-level columns — one position, one
document. They are now **per OPTION**: `lt_term_sheet_scenario.mode` and
`.waive_lender_fees`, each with its own CHECK. Three offers on one sheet, one
borrower-paid and two lender-paid, is the ordinary case rather than an
impossible one. `snapshot.buildMember` reads the mode off the member, and the
DB refuses `raw` on a MEMBER as well as on the sheet — otherwise a sheet whose
first option is issuable while a later one is not would slip past.

**Finding 2 — waiving the lender fees is net-neutral**; the $2,095 comes out of
the borrower's own credit. The owner:

> *"You're right, that's correct. It's a wash. It's the same thing but it's how
> we present it for the client, how the officer wants to present it, whether he
> wants to charge fees and give a credit or he wants to remove the credit and not
> charge fees."*

So the waive is a PRESENTATION choice, not an economic one — which is exactly
why it sits per option beside the mode.

**Finding 3 — Lender Price has no soft/hard prepay selector** while soft-vs-hard
is 63% of the live typed book. The owner:

> *"Leave this aside. We're going to work on prepayment penalties later on. Now
> just know that you're building something that will take it from the prepayment
> penalty options available. We're going to narrow this down like crazy to give
> only a few options."*

So the term sheet prints the prepayment term it is given and never invents a
structure. `wording.prepaySentence` maps what the vendor returns to plain words
and falls back to the plain term rather than guessing — which is what makes the
narrowing a later change to ONE map instead of a change to the document.

### The pricing officer, when there is none

> *"If no officer is involved then it should follow the company defaults. The
> company defaults for now should be off."*

This settles **OQ-1's fallback**, not OQ-1 itself: a borrower nobody has claimed
is governed by the company setting, which is OFF, so they see nothing. The
ladder in §2.2 still decides WHICH officer when there is more than one.

### Email

The owner gave written authorization to use the existing sender credentials for
the Long-Term side rather than provisioning a second account:

> *"Yes I'm giving you a written authorization to use the sender credentials from
> the short-term side. Send it out from lock desk @ YS Capital … but follow the
> resend credentials."*

Recorded as a crossing in `docs/LONG-TERM-AUTHORIZED-COPIES.md` — it is an
IMPORT of `src/lib/email/index.js`, which is a crossing rule 3 requires be
written down before the first line, and the sender address is a setting.

---

## 10b. ANSWERED BY THE OWNER, 2026-08-30 (second pass) — the two questions, settled

### The unnamed investor

> *"We give each investor a made-up name for clients — Platinum, Diamond, Pearl. If a new investor
> comes back with a price and nobody has given them a made-up name yet, our staff screen still shows
> that price (you shouldn't lose a good rate over paperwork). But a term sheet goes to the borrower,
> and there we can't leave the program name blank and we can't print the real investor. So the term
> sheet refuses that one option and tells the officer: this investor needs a name first. Everything
> else on the sheet still goes."*
>
> *"the loan officer can put in manually a program name. You warn him not to put in an investor name
> as a program name."*

**Settled: the rule INVERTS between the board and the document, and the officer now has a way through.**
The staff board keeps an unnamed investor's price (hiding a row nobody chose to hide is a silent drop);
the document refuses it, by name, so the officer learns the investor needs christening — and may type a
programme name for this sheet instead of being stuck.

**The warning is advice; the REFUSAL is the control.** A sentence under a text box does not enforce
rule 10, and the one thing that must never happen is an investor's name reaching a borrower's document.
`snapshot.resolveProgramName()` puts the typed name through `audience.mentionsInvestor` — the ONE
definition, built on the registry, never a second `!== 'Deephaven'` check that `Deepahven Select` walks
straight past — and all 115 recorded spellings are swept in CI. A programme that HAS a white-label name
is never renamed by hand: two sheets would otherwise call one programme two things.

### Can one sheet carry more than one compensation setup

> *"I was asking whether one term sheet could carry more than one compensation setup. Your 'three
> offers' answer settled it — yes, and that's the normal case. So each offer now carries its own setup:
> one borrower-paid, one lender-paid with fees waived, one lender-paid with a credit, all on the same
> page."*

**Settled, and already built that way**: the comp mode and the fee waive live on each MEMBER, not on the
sheet (`lt_term_sheet_scenario.mode` / `.waive_lender_fees`, each with its own CHECK). The three-offer
comparison is the normal case, not an edge case — which is exactly why the lender fees are now LISTED
on the waived option at zero with what they would have been, so the difference between the columns is
on the page rather than in the reader's head.

### The three export documents

> *"A term sheet should only have one option. It should be a comparison sheet, which should be the same
> scenario, different options. There should be a scenario sheet, which is different scenarios and
> different options broken down."*

**Settled**, and the kind is DERIVED from the options rather than chosen — see
`docs/longterm/TERM-SHEETS-AND-COMPARISON.md` §13b, which works through the whole of this message.

### Still open, and flagged rather than guessed

- **Whether the borrower's name and the property address should be REQUIRED for a term sheet.** They
  are, today: a term sheet is the formal one-programme offer and carries a signature block, and a
  signature line over a blank "Prepared for" is a defective document. The owner asked for the ABILITY
  to enter them; requiring them is our reading. A comparison requires neither. Easy to relax.
- **Whether the DSCR a term sheet prints should be the vendor's qualifying ratio or `rent ÷ PITI`.** It
  is the second, because a comparison prints three different total payments and printing one ratio
  under all three made two of the three wrong. If an investor qualifies on a different basis (an
  interest-only payment, PITIA including something we do not carry), the printed ratio and the
  qualifying ratio could differ — worth the owner's answer.

## 11. Open questions — the owner's to answer

| # | Question | Why it blocks | Recommendation |
|---|---|---|---|
| **OQ-1** | Which officer is a borrower's pricing officer when there is more than one — the §2.2 ladder, or an explicit per-borrower claim? | Decides the `lt_borrower_pricing_profile` primary key and the whole resolver | **Explicit claim.** It has no ambiguity, and the officer already has to visit the tab to set investors |
| **OQ-2** | A per-borrower override **below the officer's own figure but at or above the company's** — officer alone, or approval? | §4.3 | Officer alone. They are giving up only their own margin |
| **OQ-3** | Credit score: a number, or a band? | §5.3 | The number, as staff. *"We don't want to babysit them"* |
| **OQ-4** | May a borrower run unlimited searches, or is there a cap? Each search is a real vendor call (~12 s measured) | Cost and vendor load | A per-borrower daily cap as a setting, generous (say 50), silent until hit |
| **OQ-5** | How long is a borrower's term sheet good for before the ID replays as "expired pricing"? | Term sheet design | 2 business days, as a setting |
| **OQ-6** | Does a borrower see the loan officer's name and contact on their board and term sheet? | Branding, and it is a trust question | Yes on the term sheet, yes on the board |
| **OQ-7** | Does an officer get notified when their borrower exports a term sheet? | It is a buying signal | Yes — and it belongs in the daily digest, not as an instant email |
| **OQ-8** | ~~The prepay question in `PREPAY-PENALTY-MAPPING.md` §4~~ | ~~Gates Phase 4 going live~~ | **ANSWERED 2026-08-30 — set aside.** *"We're going to work on prepayment penalties later on… we're going to narrow this down like crazy."* The term sheet prints the term it is given and never invents a structure, so the narrowing is a later change to one wording map |

---

## 12. Crossings — what would need the owner's written authorization

Per `AGENTS.md` rule 3 and `docs/LONG-TERM-AUTHORIZED-COPIES.md`, each of these needs a per-item
"yes" in writing **and** a ledger entry in the same PR as the code. **None has been requested and
none is assumed here.**

| # | The temptation | Verdict |
|---|---|---|
| 1 | Import RTL's term-sheet machinery (`src/lib/term-sheet-offer.js`, `app-v2/src/components/TermSheetStudio.jsx`) | **Needs authorization, and is probably the wrong shape anyway.** RTL's term sheet is a bridge/fix-and-flip product sheet driven by RTL's own product studio. LT's is a DSCR rate quote. Recommend a fresh LT build |
| 2 | Import the Investor Suite's break-even tool (`web/v2/tools/ratesaver.html`) | **Not a crossing, and does not need one.** The formula — `break-even months = cost ÷ monthly saving` — is standard mortgage arithmetic, not RTL property. A fresh LT implementation in `comparison.js` copies nothing. The RTL tool is cited as the **presentation** we are matching (`TERM-SHEETS-AND-COMPARISON.md` §7), and the owner's *"use our investor suite comparison"* is read as "the same answer, in the same shape" — which is what a fresh implementation gives. **If the owner instead wants the literal RTL code, that is a crossing and needs a ledger entry.** |
| 3 | Import RTL's report scheduler (`src/lib/report-scheduler.js`) or its email stack (`src/lib/email/**`) | **Needs authorization.** LT has no mailer of its own today, and this is the first LT feature that sends email. This is the most likely place a real authorization will be needed — see `PRICING-RATE-MOVEMENT-REPORTS.md` §7, which sets out the three options and their costs |
| 4 | Read `borrowers` / `staff_users` / `borrower_officers` for the entitlement chain | **Already authorized** (2026-08-03). `sql-read borrowers`, `sql-read staff_users`, `sql-ref`+`sql-write borrower_officers`. Nothing new needed |
| 5 | The borrower entry point on the LT borrower screen | **Already authorized** (2026-08-17), and the tab is inside `BorrowerLongTerm.jsx`, which is LT's own file. Nothing new needed |
| 6 | A new column on an RTL table for any of this | **Forbidden** (rule 5). Nothing in this design needs one |

---

## 13. What this document is not

It is not a promise about dates, it does not authorize the crossings in §12, and it has measured
nothing new — every fact about existing behaviour above is cited to the file that holds it or the
document that recorded the measurement. Where this design rests on an assumption rather than a
measurement, it is in §11 with a recommendation attached, which is the only honest place for it.
