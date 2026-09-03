# The Speed Program — research and build design (RTL)

**Status: APPROVED — PHASE 1 BUILT (2026-09-03).** Owner-directed: *"Before you start building, do a
research engine on how exactly this is going to be built."* This document is that research; §9 lists
the decisions and §10 the build order. Every claim below was read out of the code or **measured** by
running the real frozen engines (§4).

**Owner's answer, 2026-09-03, in their own words:** *"Approved on all nine decisions, start building
phase 1. Main goal is not to rebuild anything, just share the code of the two programs. You also need
to keep in mind the lower maximum loan amount for each tier. We also want to put a cap maximum for the
speed program. It's an additional overlay on top of the more conservative programs. Maximum loan out
for the speed program is $1 million. Go ahead."* Two things that adds to the rules in §1:

- **R11 — a Speed-only ceiling of $1,000,000 on the total loan**, applied as one more MIN on top of
  the combined ceiling (`capMin.maxLoan = min(Standard's tier max, Silver's tier max, 1,000,000)`),
  pinned through the engines' existing `targetLoan` lever. It is an overlay of the composition, not a
  number in either engine, and it is a constant of the composition module, `SPEED_MAX_LOAN`.
- **The per-tier maximum loan is already the lesser of the two**: each engine reads its own tier row
  for the deal (Standard `MATRIX`, Silver `TG`, with Silver's tier itself depending on loan size), and
  R3 takes the min of the two `maxLoan` figures for THIS deal — scenario F in §4 shows both walls at
  $2.5M for a 4-comp borrower even though Silver's Tier 1 wall is $4.5M. With R11 the Speed wall is
  `min(those two, $1,000,000)`.

**Phase 1 (this PR): the three engine levers of §5.2 are in both copies of both engines, proven
byte-identical when unset by `scripts/test-speed-levers-pure.js` (in `npm test`); cache-busters
bumped; CLAUDE.md carries the authorization record.** Phases 2–6 follow §10.

**Product: RTL.** The Speed Program is a fourth registerable RTL pricing program beside Standard,
Gold and Silver. It touches nothing on the Long-Term side.

---

## 1. What the owner asked for, in their own words

> *"We want to open up a brand new RTL program … called Speed Program. The Speed Program should be
> combined with the conservativeness from the Standard program and from the Silver program … I
> clearly don't want to start rewriting the guidelines, it should just share … every search you
> also display the Speed Program which is always the lesser loan amount between the two programs,
> the lesser max LTV, the lesser max initial, the lesser max ARV, the more conservative geographic
> restrictions — if there's any geographic restriction that [either] of our programs doesn't allow
> it should enforce both of them … I don't want you to reproduce the code. I want you to use that
> actual code, [so that when] the programs update [Speed] also updates … something that we can
> sell to either note buyer. The rate should be the more expensive rate from the two programs …
> always the lower loan amount, the lower LTV, but the higher rate and the higher origination fees.*
>
> *"This is an RTL program which will come up on the term sheet generator, on the products and
> pricing, and everywhere else. The one restriction … more conservative than both … is that it's
> only going to allow a 10% assignment fee (wholesale fee). The exact type of calculation that we
> have now for 15% is only going to allow the 10%. But … then your loan amount is going to be less
> than both programs. You're going to think you're good because you look at the actual loan amount.
> Technically, even though it's going to be less than both programs, you still need to enforce the
> max LTV cap from both programs. If the effective purchase price is less … if one of those programs
> allows a 70% ARV and one of them allows 75% ARV, you need to be even less with your loan amount
> (because you need to enforce the 70% ARV)."*

Read as rules:

| # | Rule | Direction |
|---|---|---|
| R1 | Speed is **composed from Standard (Fidelis) and Silver (EMCAP)** — no third guideline book. | share, never re-type |
| R2 | On **every** quote/search, Speed is shown beside the other programs. | everywhere Standard/Silver appear |
| R3 | **Leverage = the lesser of the two** on every axis: max loan, max acquisition LTV (= max initial advance), max after-repair LTV, max LTC. | min |
| R4 | **Geography = both programs' exclusions apply.** | union of bans |
| R5 | **Experience:** no extra experience rule of Speed's own — each program's own tiering decides that program's caps, and R3 takes the lesser. (See D2 in §9: the sentence was ambiguous on the recording.) | no invented rule |
| R6 | **Price = the more expensive of the two**: note rate, origination points, and any other price line. | max |
| R7 | **Assignment fee financeable at 10% of the seller's contract price** (same formula as today's 15%, different percentage). | Speed-only, stricter than both |
| R8 | **The loan amount is never the test.** The caps of BOTH programs are enforced against the Speed effective price. A loan that is smaller than either program's own loan can still break a cap. | structural, not a comparison of totals |
| R9 | **Sellable to either note buyer** — the Speed loan must be one Fidelis would buy AND one EMCAP would buy. | dual-sellability is the acceptance test |
| R10 | Speed updates itself when Standard or Silver updates (a new EMCAP workbook, a Fidelis matrix change). | composition, not a copy |

---

## 2. What exists today (verified facts, with where they live)

### 2.1 Two frozen engines, one sizing waterfall, one server wrapper

- **Standard** — `web/tools/standard-program.js` (`window.YSP`, 912 lines). Additive rate build-up
  (`RA`, lines 54–62): base + tier + FICO + leverage + term + cash-out + judicial + heavy, buy rate
  clamped to `[9.25%, 10.5%]`, then `+ effMarkup(tier)`. Leverage matrix `MATRIX` (lines 70–95) keyed
  `regime(NAT|FL|CANY) | LoanType | Strategy | Tier`, row `[maxLoan, minFICO, maxAcqLTV, maxARLTV, maxLTC]`.
  Bans `IN`, `LA` (line 104) plus the city review gate (Philadelphia, Baltimore, Detroit, Chicago → MANUAL,
  no pricing). Tiers `3+ / 1–2 / 0` (line 194). Judicial sub-$100k exception product (Standard only).
- **Silver** — `web/tools/silver-program.js` (`window.SVP`, 1,640 lines). **A dependent of Standard, not a
  sibling**: `module.exports = factory(require("./standard-program.js"))` (line 56); it calls
  `YSP.sizeLoan`, `YSP.normStrategy`, `YSP.projectCount`. Pure grid lookup (1,555 EMCAP cells, 54 per block:
  3 AR × 3 FICO × 6 LTC) — *the grid IS the leverage policy*, with a step-down lattice that lowers the
  ceiling to the highest structure the grid actually prices. Tier grid `TG` (lines 220–239). Bans `NV MN ND SD`,
  ZIP-precision bans for Philadelphia/Chicago/Detroit/Baltimore, an NYC market with its own limits.
  Tiers depend on loan size (`3+/1–2/0` under $2.5M, `5+/2–4/<2` above) and GC-only experience caps the tier.
  Markup hard-capped at 1.00%.
- **`sizeLoan` is genuinely one definition** (`standard-program.js:251–545`). Gold and Silver both call it. It
  takes a deal and a caps row `{maxLoan, minFico, maxAcqLTV, maxARLTV, maxLTC[, minDownPayment]}` and finances
  rehab first, then the initial advance as the plug `min(maxAcqLTV × acqDenom, capHard − rehab − R, LTC term)`,
  then fits the interest reserve, and reports which wall bound (`bindKey`: `arv|maxloan|ltc|acq|rehabonly|none`).
- **Server wrapper** — `src/lib/pricing.js`. `quoteProgram(program, input, opts)` (line 1260) dispatches to
  the engine, applies the company markup through the sanctioned `setMarkup`/`setMarkupTiers` hooks and resets
  them in `finally`; `normalize()` (line 693) turns an engine result into the one UI-agnostic quote shape
  (origination, fees, title, cash to close, liquidity, ladder, `adminPricing.rateBuildUp`).
  **`quoteAll` (line 1335) is the "search"**: a hand-written three-liner returning `{ inputs, standard, gold, silver }`.
- **Manual is the precedent for a program that is a TAG over another engine**: `quoteProgram('manual')`
  prices on `YSP` and only the label/tag differ (`docs/MANUAL-PROGRAM-AND-FLOOD-RESEARCH.md`).

### 2.2 The levers the engines already accept (the composition hangs on these)

Every engine input is a flat object. Two kinds of leverage knob exist and they are **not** interchangeable:

| Knob | Standard | Silver | Semantics |
|---|---|---|---|
| `targetLTC` | ✔ (line 668) | ✔ (line 1047) | **voluntary ceiling** — `MIN` against the program cap; can only lower; inert when unset |
| `targetLoan` | ✔ (line 679) | ✔ (line 1067) | voluntary ceiling on the dollar wall (authorized 2026-08-06) |
| `targetARLTV` | **✘** | ✔ (line 1062) | voluntary ceiling on the after-repair wall (authorized 2026-08-06, Silver only) |
| `targetAcqLTV` | **✘** | **✘** | does not exist on either engine |
| `ovrAcqLTV` / `ovrARLTV` / `ovrLTC` | ✔ | ✔ | **admin basis override** — can RAISE; flips the product to **Manual** (`manual-program.js isManualProduct`), disables Standard's judicial floor (`manualBasis`), routes to super-admin approval |
| `ovrEffPrice` | ✔ | ✔ | admin exception on the assignment effective price — marks `assignment.overridden`, emits a MANUAL "Admin exception" reason |
| `assignment cap` | literal `0.15` (line 582) | literal `0.15` (line 911) | not a knob today |

So Speed **cannot** be expressed with today's inputs alone: pinning the combined ceiling needs `targetAcqLTV`
on both engines and `targetARLTV` on Standard, and the 10% rule needs a percentage the engines read instead
of the literal. Using the `ovr*` knobs would turn every Speed quote into a Manual product; using `ovrEffPrice`
would stamp every assignment as an admin exception. Both are the wrong tool. **§5.2 is the authorized-change
request this creates.**

### 2.3 The 15% assignment rule (the formula Speed reuses at 10%)

Identical in Standard (`standard-program.js:569–602`) and Silver (`silver-program.js:899–927`):

```js
var rawFee         = Math.max(0, totalPP - sellerPP);
var maxFee         = 0.15 * sellerPP;              // 15% of the SELLER's contract price, never the total
var financeableFee = Math.min(rawFee, maxFee);
var excessFee      = Math.max(0, rawFee - financeableFee);
effPurchase        = sellerPP + financeableFee;    // the recognized / effective price
```

`effPurchase` is the ONLY thing that changes downstream: it becomes `dealForSize.purchasePrice`, so inside
`sizeLoan` it drives `acqDenom = min(effPurchase, asIsValue)` (the acquisition-LTV base and the LTC cost basis).
The ARV wall and the dollar wall do not read it. The excess is never financed; it is published as
`sizing.assignmentExcessOOP` and added to cash to close (`pricing.js:955`). Over-cap is an ELIGIBLE disclosure,
not a status change (owner 2026-07-21). The reason strings hard-code the words "15%".

### 2.4 There is no program registry

There is no single list of programs. The registry agent counted **47 hand-kept enumerations** (26 back end,
8 front end, 6 browser studio/marketing, 7 tests) plus three database column families. The three closest to
canonical: `src/lib/vesting-program-rule.js programKey()` (the normalizer), `src/lib/tapes/program-provider.js`
(program ↔ note buyer), `src/lib/program-availability.js PROGRAM_KEYS` (the on/off switch). Every one of these
is on the build list in §7. Two of them **fail the moment a fourth key exists**:
`scripts/test-program-availability-pure.js:37` asserts the literal `'standard,gold,silver'`, and every consumer of
`quoteAll` destructures `{standard, gold, silver}` by name (`routes/staff.js:3060`, `routes/borrower.js:1050`,
`routes/tpo.js:641`, `borrower-safe.js:181–186`).

### 2.5 Where Standard and Silver disagree (why "the lesser" is not one number)

| Axis | Standard (Fidelis) | Silver (EMCAP) | Speed takes |
|---|---|---|---|
| Max loan | $2.5M (NAT), $3.5M (CA/NY FF), $1.5M (FL) | $4.5M T1, $2.5M T2, $950k T3 | min per deal |
| F&F purchase T2 ARV | 70% | 75% | **70%** — the owner's own example |
| Ground-up T1 | 70/70/85, FICO 680 | 80/75/92.5, FICO 640 | 70/70/85, FICO ≥ 680 (MANUAL below) |
| F&F refi | T1 80/70/85, T2 75/65/80 | T1 75/70/85, T2 65/70/75 | T1 75/70/85, T2 65/65/75 |
| F&F refi in CA/NY/FL | banned | allowed outside NYC | **banned** |
| Geography | IN, LA banned; 4 cities → review | NV MN ND SD banned; ZIP bans; NYC rules | **all of it** |
| Min FICO | 600 hard | 640 hard | 640 hard |
| Experience tier | 3+/1–2/0 | size-dependent; GC-only capped | each program's own, lesser caps win |
| Value-add gate | ARV < basis → MANUAL | ARV ≤ basis → INELIGIBLE | INELIGIBLE (worst status wins) |
| DSCR / cash-out ≤ 50% profit / seller financing | none | INELIGIBLE gates | enforced |
| Rate | 9.25%–10.5% buy + markup | 7.88%–12.37% grid + markup (≤1%) | **max of the two note rates** |
| Reserve months, min loan $100k, draw fees, 2-month bank statements | same | same | same |

The prototype in §4 measured all of this on live engines; no row above is inferred.

### 2.6 Surfaces a program reaches today

- **Term Sheet Studio** (`web/v2/tools/term-sheet.html` + `termsheet.js`): the program cards are a fixed
  **2×2 grid, four cards** (owner-directed 2026-07-30, CLAUDE.md line 527; `.prog-compare{grid-template-columns:1fr 1fr}`
  at `term-sheet.html:209`) — Standard + Gold on row 1, Silver + Manual on row 2. Each card is painted by element id
  (`silverLoanBig`, `silverRateBig`, …) from its own `calcSilver()`; `progs = [standard, gold, silver]` at
  `termsheet.js:1190` is the "which programs qualify" comparison, filtered by the availability toggles. The studio's
  six-pager **is the only term sheet** (CLAUDE.md line 974) — its derivation page is where Speed's composition
  will be explained.
- **Products & Pricing panel** (`app-v2/src/components/ProductStudioPanel.jsx`): five separate hard-coded label
  ternary chains (lines 342, 1472, 1497, 1597, 1849) and the "tap one of the four program cards" wording.
- **Pricing Admin Center** (`app-v2/src/screens/StaffCompanyPricing.jsx`): `PROGRAMS = [standard, gold, silver]`
  drives the markup-tier grid, the on/off toggles and the history table.
- **Registration doors** (six): staff, borrower, TPO, accept-counter, term-sheet-offer auto-register, intake
  auto-register — each carries a `program === 'gold' ? … : program === 'silver' ? … : 'standard'` ternary.
- **Note buyer**: `tapes/program-provider.js PROVIDER_FOR_PROGRAM` is **1:1** (gold→bluelake, standard→fidelis,
  silver→emcap); `note-buyer-for-program.js` derives the buyer at registration from that table; `buyer-rule.js
  exportGate` lets a non-admin export a provider's tape only when program AND buyer line up; `manual` is
  deliberately absent (open selection, admin-only tape).
- **Everything keyed on the buyer, not the program** (appraisal note-buyer checks, ISG rules, SOW contingency,
  bank-statement months) follows whichever buyer is stamped on the file.
- **ClickUp** `registered_program` crosswalk (the dropdown option must be added by hand in ClickUp, as for Silver);
  **Encompass** is read-only (nothing to write); dashboards filter; emails; borrower-safe scrub
  (`borrower-safe.js PARTNER_PATTERNS` already covers Fidelis and EMCAP).

---

## 3. The design: Speed is a COMPOSITION, not an engine

### 3.1 One sentence

**Run both frozen engines on the Speed input (assignment financeable at 10%), take the elementwise minimum of
the ceilings each engine says THIS deal may reach, pin both engines to that combined ceiling through their
own voluntary levers, and report the evaluation with the higher note rate. Refuse if either refuses.**

Nothing is re-typed: no matrix, no grid, no geography list, no tier ladder, no assignment formula. When EMCAP
sends a new workbook or Fidelis changes a cell, Speed moves with it (R10).

### 3.2 The algorithm

```
speedQuote(input):
  in10 = input + { assignmentMaxPct: 0.10 }                              # R7 (new inert lever, §5.2)

  # Pass A — each program's OWN ceiling for THIS deal, on the Speed basis
  evS = YSP.evaluate(in10);  evV = SVP.evaluate(in10)
  if evS.status == INELIGIBLE or evV.status == INELIGIBLE:               # R4, R8, R9
      return INELIGIBLE, reasons = both programs' non-ELIGIBLE reasons, each tagged "[Standard]" / "[Silver]"
  capS = evS.caps                     # Standard: the effective ceiling it sized on
  capV = evV.pricedCeiling            # Silver: what THIS deal was priced at (never `caps`, which is the program max)
  capMin = { maxLoan: min(capS, capV, SPEED_MAX_LOAN = 1,000,000),        # R3 + R11 (owner 2026-09-03)
             maxAcqLTV: min, maxARLTV: min, maxLTC: min }

  # Pass B — both engines under the SAME ceiling (fixed point: Silver may step down again)
  repeat ≤ 4 times:
      pin = { targetLoan: capMin.maxLoan, targetAcqLTV: capMin.maxAcqLTV,
              targetARLTV: capMin.maxARLTV, targetLTC: capMin.maxLTC }
      evS = YSP.evaluate(in10 + pin);  evV = SVP.evaluate(in10 + pin)
      if either INELIGIBLE: return INELIGIBLE (as above)
      capMin' = elementwise min(capMin, evV.pricedCeiling, evS.caps)
      if capMin' == capMin: break   else capMin = capMin'
  if not converged: return MANUAL "Speed could not settle on a structure both programs price"

  # The Speed answer
  donor  = the evaluation with the HIGHER noteRate (tie → the smaller totalLoan)   # R6
  status = worst of (evS.status, evV.status)   (MANUAL if either is MANUAL)
  quote  = donor.sizing + donor.noteRate                                          # the frozen waterfall, sized once at the Speed rate
  origination = max(resolved origStdPct, resolved origSilverPct)                 # R6
  minimumEarnedInterest = ON if ON for either program                            # more conservative
  explain = { capDonor: {maxLoan, maxAcqLTV, maxARLTV, maxLTC} → 'standard'|'silver'|'both',
              rateDonor, standardRateAtThisStructure, silverRateAtThisStructure,
              standardOwnLoan, silverOwnLoan, assignment: {pct: 0.10, financeable, excessOOP} }
```

Why each choice:

- **Pass A before Pass B.** Silver's ceiling for a deal is not its tier row; it is the tier row narrowed by the
  grid and by the step-down lattice, and both depend on the structure — which depends on the effective price.
  So the ceilings must be read off a run on the **10% basis**, never off the 15% run. This is exactly R8.
- **Pin, don't reimplement.** Both engines already know how to size under a voluntary ceiling (that is what
  `targetLTC`/`targetLoan`/`targetARLTV` are). Pinning both to `capMin` makes them size the **same** structure
  with the **same** frozen waterfall; the only thing left different is each engine's rate on that structure.
- **The donor's evaluation IS the Speed structure.** The two engines under `capMin` differ only in the financed
  interest reserve, because the reserve is priced at each engine's own rate. Taking the higher-rate engine's
  full evaluation means the reserve is funded at the rate the borrower will actually pay. (Measured in §4,
  scenario B: Standard $229,715 vs Silver $228,272 under identical caps — the $1,443 is six months of interest
  at 10.20% instead of 9.00%.) The alternative — hard-min the two totals and carry the higher rate — under-funds
  the reserve by exactly that amount. See D3.
- **Worst status wins.** MANUAL on either side (FICO under a tier minimum, city review, missing ARV, rehab over
  cap) is MANUAL on Speed; INELIGIBLE on either side is INELIGIBLE. A Speed quote therefore never shows terms
  that one of the two buyers would not honour (R9).
- **Reasons are carried, not rewritten**, prefixed with the program that raised them, so the person reading the
  term sheet sees *"[Silver] Properties in Nevada are not eligible for the Silver Program"* rather than a new
  sentence nobody authorised.
- **No Speed-specific markup or origination knob in v1.** The rate is the max of two note rates that already
  carry each program's own company markup, per-file sticky markup and tier overlay; origination is the max of
  the two resolved figures. Adding a Speed knob would reopen "which of the two rates is being marked up". See D5.

### 3.3 Where the composition lives — one module, used by the server AND the browser

`web/tools/speed-program.js` (+ the byte-identical `web/v2/tools/` copy), the same UMD shape as
`silver-program.js`: `module.exports = factory(require('./standard-program.js'), require('./silver-program.js'))`
in Node, `root.SPP = browserView(factory(root.YSP, root.SVP))` in the browser. It exposes `evaluate(input)` in the
same result shape the other engines return (`status, eligible, reasons, tier, caps, pricedCeiling, noteRate,
sizing, assignment`) plus a `speed` block (the `explain` above), and `priceLadder(input)` built by pinning the
donor's ladder rungs through the composition.

Why this and not a server-only function in `pricing.js`: the Term Sheet Studio computes its cards in the browser
from the engine globals for instant what-if, and the server recomputes on register so a tampered client can never
inject terms. A server-only Speed would force a second, hand-kept browser copy of the min/max logic — the exact
"second definition" the build rules forbid. As a module beside the engines it is registered in
`scripts/test-engine-copies-match.js ENGINES` and covered by the same byte-identity proof.

**It is not a frozen engine** in the guideline sense — it holds no number. But it is load-bearing for pricing,
so it gets the same treatment: two copies, copies-match, a pure battery, a soak, and a CLAUDE.md entry.

### 3.4 Server wiring

- `pricing.js`: `SPP = require('../../web/tools/speed-program.js')`; `enginesReady()` includes it;
  `engineFor('speed')`; a `quoteProgram('speed')` branch that sets the markup hooks on **both** underlying
  engines (Speed's markup state is Standard's + Silver's — it has none of its own) and resets both in `finally`;
  `normalize('speed', …)` resolves origination as the max of the two per-program chains; `quoteAll` returns
  `{ inputs, standard, gold, silver, speed }`; `PROGRAM_LABEL.speed = 'Speed Program'`; `econVersionFor` needs
  nothing new (every input Speed reads is already fingerprinted).
- `program-availability.js`: `PROGRAM_KEYS` gains `speed` (so it can be switched off company-wide and
  re-enabled per file like the others). No migration — `program_availability` is jsonb.
- `tapes/program-provider.js`: the pairing becomes one-to-many for Speed only:
  `PROVIDERS_FOR_PROGRAM.speed = ['fidelis', 'emcap']`. `providerForProgram('speed')` returns `null`
  (no single buyer is implied → `noteBuyerForProgram('speed')` leaves `applications.lender` untouched, exactly
  the Manual behaviour the owner already chose); `programMatchesBuyer('speed', key)` is true for either;
  `programForProvider` (the reverse, used only in error copy) is unchanged for the three 1:1 rows. A non-admin
  on a Speed file exports the Fidelis tape once the buyer is Fidelis, the EMCAP tape once it is EMCAP, and
  neither while the buyer is blank. See D6.
- The six registration doors accept `program: 'speed'` (replace each `gold ? … : silver ? … : 'standard'`
  ternary with the one normalizer, `vesting-program-rule.programKey`, which already exists for this purpose).
- `liquidity.js` wording, `term-options.js resolveMinInterest` (Speed = ON if ON for either), `field-registry.js`
  `registered_program` enum (`speed`), `dashboards/registry.js` filter, `clickup/crosswalk.js` ("The Speed
  program"), `intake-auto-register.js` / `term-sheet-offer.js` `PROGRAMS` sets, `underwriting/structuring.js`
  `swap_program_speed` lever, `underwriting/program-guidelines.js` `PROGRAM_KEYS` (it composes facts, it holds no
  numbers — Speed's entry says "bank statements: 2 months; owner threshold: the stricter of the two").
- `borrower-safe.js borrowerSafeQuoteBundle` strips `speed` too. Borrower copy says "Speed Program"; Fidelis and
  EMCAP are already in `PARTNER_PATTERNS`.
- TPO channel (`routes/tpo.js`, `tpo-pricing.js`): Speed prices on the TPO-resolved settings of Standard and
  Silver; no Speed row in `tpo_pricing_settings` in v1 (D5).

### 3.5 Database

**No migration is required for v1.** `product_registrations.program` and the rule-field enum are free text
(no CHECK constraint — verified across `db/*.sql`); `program_availability` is jsonb; Speed has no markup or
origination column because it has no knob of its own (D5). If D5 goes the other way, the migration is the
`db/373_silver_program.sql` three-section shape: two `company_pricing_settings` columns, one
`applications.file_markup_speed_pct`, and the current `reopen_conditions_on_budget_change()` (head: `db/486`)
re-created byte-identically plus one clause — created with `npm run migration:new`, never a hand-picked number.

### 3.6 Studio and Products & Pricing

- **The card.** The grid rule is two per row, never three across. Recommended: a **third row** (Speed + an empty
  slot, or Speed + Manual with Silver moving up) is NOT needed on most deals, because Gold is discontinued
  (2026-08-18) and its card already disappears through `program-availability` — on a normal deal the grid reads
  Standard + Silver / Speed + Manual, still 2×2. When Gold is re-enabled for a file, the grid becomes 2×2 + 1.
  The CSS already collapses to one column under 560px. See D7.
- `termsheet.js`: `calcSpeed()` shaped like `calcSilver()` (it calls `SPP.evaluate`, no math of its own);
  `chosenProgram` spans `standard|gold|silver|speed|manual` and **every** label/export/dispatch on it handles
  `speed`; `PROG_CARD`, `FIT_IDS`, the `progs` array, the leverage ladder per program.
- **The derivation page** gains a "How the Speed Program was composed" block: a four-row table (max loan, max
  acquisition LTV, max after-repair LTV, max LTC) showing Standard's figure, Silver's figure, the one Speed
  enforced and which program set it; the two rates at this structure and which one Speed charges; the
  assignment line at 10%; and both programs' own loan amounts for reference. This is the "research engine to
  understand" the owner described, and it is what makes a Speed term sheet auditable against either buyer's
  guidelines.
- Exports (PDF / Excel / proof of funds / deal profile): a fourth data variable and a fourth column region in
  `scripts/lib/fee-roster.js` so the fee-audit engine names every fee on the Speed column too.
- `ProductStudioPanel.jsx`: replace the five label ternary chains with ONE label map (root fix, not a sixth
  branch); "tap one of the four program cards" → count-free wording.
- `StaffCompanyPricing.jsx`: a Speed row in the availability toggles only; no markup/origination fields (D5).
- Rebuild `web/v2/portal/`, bump every `?v=` on edited `web/v2/tools/*` assets, update
  `scripts/fixtures/tool-cache-busters.json`.

---

## 4. Measured, not hoped: the prototype on the live engines

A scratch script (not committed) required the two frozen engines exactly as `pricing.js` does and ran the
algorithm of §3.2. The only emulation: because the 10% lever and `targetAcqLTV` do not exist yet, the 10%
effective price was pre-computed and the ceiling was pinned through the admin `ovr*` knobs (whose sizing effect
is identical; only their Manual side-effect differs). Reserve months 0 or 6 as noted.

**Scenario A — F&F purchase, NJ, Tier 2 (2 flips), FICO 700, seller $200k + $40k fee, AIV $250k, rehab $60k, ARV $330k.**

| Run | Total | Initial | Binding | Rate | Caps enforced |
|---|---|---|---|---|---|
| Standard alone, 15% | $231,000 | $171,000 | 70% ARV | 10.400% | 90 / **70** / 92.5 |
| Silver alone, 15% | $247,500 | $187,500 | 75% ARV | 9.625% | 90 / 75 / 92.5 |
| Standard under capMin, 10% | $231,000 | $171,000 | 70% ARV | 10.500% | 90 / 70 / 92.5 |
| Silver under capMin, 10% | $231,000 | $171,000 | 70% ARV | 9.250% | 90 / 70 / 92.5 |
| **Speed** | **$231,000** | $171,000 | 70% ARV | **10.500%** | 70% ARV from Standard; rate from Standard |

Dual-sellability check — the Speed loan handed back to each program standalone (15%, own caps): Standard
ELIGIBLE at 10.400%, Silver ELIGIBLE at 9.125%; the Speed rate covers both. Note the Speed rate (10.500%) is
higher than Standard's own quote (10.400%) because the 10% basis raised the achieved LTC into the next
Standard leverage bucket — the rate belongs to the structure, as it must.

**Scenario B — F&F purchase, TX, Tier 1 both, FICO 720, seller $200k + $30k fee, AIV $260k, rehab $20k, ARV $400k, 6-month reserve. This is the owner's trap, measured.**

| Run | Total | Initial | Reserve | Acq LTV | Rate |
|---|---|---|---|---|---|
| Standard alone, 15% | $239,199 | $207,000 | $12,199 | 90.00% of $230k | 10.20% |
| Silver alone, 15% | $237,696 | $207,000 | $10,696 | 90.00% of $230k | 9.00% |
| Standard under capMin, 10% | $229,715 | $198,000 | $11,715 | 90.00% of $220k | 10.20% |
| Silver under capMin, 10% | $228,272 | $198,000 | $10,272 | 90.00% of $220k | 9.00% |
| **Speed (donor = Standard)** | **$229,715** | **$198,000** | $11,715 | 90.00% | **10.20%** |

"The lesser of the two programs' loan amounts" would be **$237,696** — below both programs' own quotes, and
**$9,424 over what Speed may lend**: its $207,000 initial advance is **93.6%** of the $220,000 Speed effective
price against a 90% cap. Exactly the failure the owner described. The composition never compares totals, so it
cannot make this mistake.

**Scenario E — ground-up, TX, 2 ground-up comps, FICO 690, seller $350k + $50k fee, budget $500k, ARV $1.3M.**
Standard is Tier 2 with FICO 690 under its 700 minimum → MANUAL; Silver Tier 2 ELIGIBLE at 10.25%. Speed:
**MANUAL, $786,512 at 10.55%**, ARV cap 65% (Standard) over Silver's 75%. The lesser-loan-amount shortcut
would have lent **$799,843 — $13,331 too much**.

**Scenario F — $3.2M purchase, 4 flips.** Both programs cap at $2.5M (Standard's national wall; Silver's
Tier 2 wall because 4 comps is not 5 above $2.5M). Speed $2,500,000 at 9.75% (Standard) over Silver's 8.50%.

**Scenarios C and D — geography.** Indiana: Standard refuses ("Properties in Indiana are not eligible"),
Silver prices it → **Speed INELIGIBLE**. Nevada: Silver refuses, Standard prices it → **Speed INELIGIBLE**. R4 by
construction.

Measured properties across all runs: pinning both engines to the same ceiling produced the **same initial
advance and holdback** every time; the only difference was the reserve (rate-driven); both programs standalone
accepted every Speed loan; the Speed rate was never below either program's rate at that structure.

---

## 5. What has to change in a frozen file, and the proof that goes with it

**BUILT 2026-09-03 (phase 1).** The three levers below are in `web/tools/` and `web/v2/tools/` copies of
`standard-program.js` and `silver-program.js`; the proof is `scripts/test-speed-levers-pure.js`
(8,640 scenarios × 3 engines byte-identical when unset; 362,880 zero/blank checks; 76,260 non-binding
no-op checks; ~24k/~22k pinned pairs per engine for the reduce/bite/ceiling properties; 4,320 assignment
scenarios per engine for the 10% math). One measured nuance: under Silver's pre-existing after-repair
lever the step-down lattice may re-allocate between reserve and initial while the loan still shrinks under
the ceiling — reported as INFO, owned by `test-silver-arv-lever-pure.js`. The engine `?v=` busters carry
`-speedlev1`.

### 5.1 The rule

CLAUDE.md line 258: no pricing/guideline LOGIC or NUMBERS change without the owner's explicit written
authorization naming the change. The composition module changes no number. But three **inert voluntary levers**
must be added to the frozen engines, in the pattern already used three times (`targetLoan` 2026-08-06,
`targetARLTV` 2026-08-06, `MARKUP_TIERS` 2026-08-04):

### 5.2 The authorization request (what the owner is asked to approve, in one place)

| Lever | Engine(s) | Line pattern | Semantics |
|---|---|---|---|
| `assignmentMaxPct` | Standard (line 582), Silver (line 911) | `var maxPct = (input.assignmentMaxPct > 0) ? Math.min(0.15, input.assignmentMaxPct) : 0.15; var maxFee = maxPct * sellerPP;` and `maxPct: maxPct` on the assignment object; the two reason strings read the percentage instead of the literal "15%" | can only LOWER the financeable share; unset → byte-identical |
| `targetAcqLTV` | Standard (after line 679), Silver (after line 1067) | `if (input.targetAcqLTV > 0) capsEff.maxAcqLTV = Math.min(capsEff.maxAcqLTV, input.targetAcqLTV);` | a MIN, like `targetLTC`; unset → byte-identical |
| `targetARLTV` | Standard only (after line 679) | the one line Silver already has at 1062 | a MIN; unset → byte-identical |

Nothing else in either engine moves. Gold is untouched (Speed does not read it).

### 5.3 The proof (written before the change, per the build rules)

- **Byte-identical when unset**, proven with `scripts/lib/engine-baseline.js`: the baseline is built by stripping
  the lever lines from today's source (never `git show HEAD:`), the strip regex is `/g` with the expected match
  count asserted per file and no surviving `input.<lever>` reference, and the battery compares **every** numeric
  field including the rate. Scale like the precedents: `test-tier-markup-pure.js` ran 77,760 scenarios,
  `test-target-loan-pure.js` the full programs × states × loan types × FICO × tiers × deals × assignment × IR
  cross product.
- **A lever set above anything that could bind is a complete no-op** (the third guard from CLAUDE.md line 283).
- **Each lever only lowers**: for every scenario, the pinned total ≤ the unpinned total and the pinned ratio ≤
  the lever value.
- **Each test is shown to fail**: the lever line is mutated (a MAX instead of a MIN; 0.15 → 0.16) and the suite goes
  red, with a green control either side.

---

## 6. The Speed acceptance tests (the evidence that Speed is what the owner said)

`scripts/test-speed-program-pure.js`, in `npm test`, no DB, over the same scenario cross product the engine
batteries use, asserting for every scenario:

| # | Invariant | Rule |
|---|---|---|
| S1 | Speed is INELIGIBLE whenever Standard OR Silver is INELIGIBLE on the Speed basis; MANUAL whenever either is MANUAL. | R4, R9 |
| S2 | **Dual-sellability**: for every ELIGIBLE/MANUAL Speed quote, each program standalone (its own 15% rule, its own caps) pinned to `targetLoan = speedTotal` returns the same total, is not INELIGIBLE, and every achieved ratio of the Speed structure (acq LTV on the Speed basis, ARV, LTC) is ≤ that program's own cap. | R3, R8, R9 |
| S3 | Speed's note rate ≥ each program's note rate at the Speed structure; Speed's origination ≥ each program's. | R6 |
| S4 | The financeable assignment fee ≤ 10% of the seller price; `excessOOP` = fee − financeable; the effective price = seller + financeable. | R7 |
| S5 | Speed's initial advance ≤ min over programs of (that program's acq cap × the Speed acqDenom); Speed's total ≤ min over programs of (that program's ARV cap × ARV) and ≤ min max loan. | R3, R8 — the trap, asserted directly |
| S6 | Every cap Speed enforced is attributed to a program (`capDonor`), and that program's own figure equals it. | the derivation page is truthful |
| S7 | Determinism and purity: same input → same output; no engine markup state leaks (both engines' markup hooks read `null` after every quote). | build rule |
| S8 | Hostile input never throws (strings, NaN, negative, missing fields) — an ERROR status, never a crash. | fail closed |
| S9 | Mutation proofs: 0.10 → 0.15 in the composition fails S4; max → min on the rate fails S3; dropping one cap from `capMin` fails S5; each with the unmutated control green. | rule 2 |

Plus: `scripts/soak-speed-scenarios.js` (seeded, `SOAK_N`), the copies-match registration, and the updates to every
list test in §7. `scripts/test-speed-levers-pure.js` is the §5.3 proof.

---

## 7. The full surface checklist (grep `-i silver` and answer every hit)

Grouped; each line is a file that changes or a test that must be extended. Line numbers are today's.

**Engines / shared modules**
`web/tools/standard-program.js`, `web/tools/silver-program.js` (+ the two `web/v2/tools` copies) — §5.2 levers ·
NEW `web/tools/speed-program.js` + `web/v2/tools/speed-program.js` · `scripts/test-engine-copies-match.js:36 ENGINES` ·
`scripts/lib/engine-baseline.js ALL_ENGINES`.

**Server**
`src/lib/pricing.js` (require, `enginesReady`, `PROGRAM_LABEL:68`, `engineFor:568`, `markupKeyFor:520`,
`tierMapKey:543`, `normalize` origination :697–712, `quoteProgram:1260`, `quoteAll:1335`) ·
`src/lib/program-availability.js:51–52` · `src/lib/tapes/program-provider.js:28–47` · `src/lib/note-buyer-for-program.js` ·
`src/lib/tapes/buyer-rule.js:113–158` (one-to-many messages) · `src/lib/borrower-safe.js:181–186` ·
`src/lib/liquidity.js:63` · `src/lib/term-options.js:35–46` · `src/lib/conditions/field-registry.js:309` ·
`src/lib/dashboards/registry.js:81–84` · `src/clickup/crosswalk.js:167,176` · `src/lib/intake-auto-register.js:42` ·
`src/lib/term-sheet-offer.js:58` · `src/lib/manual-program.js:103` · `src/lib/underwriting/structuring.js:29–46` ·
`src/lib/underwriting/program-guidelines.js:32–41` · `src/lib/underwriting/metrics.js:63` (advisory fallback caps —
Speed's row is the min of Standard's and Silver's, or better, derived at load from the two) ·
`src/lib/email/pricing-email.js`, `src/lib/email/template.js` labels · `src/lib/file-overview.js:165` ·
`src/lib/markup-drift.js` (no Speed row while D5 = no knob) · `src/lib/underwriting/loan-primer.js`,
`underwriter-prompt.js` (the AI grounding text describes Speed as "the stricter of Standard and Silver, 10%
assignment, sold to Fidelis or EMCAP").

**Routes**
`src/routes/staff.js` (:3060 quoteAll, :3241 "Pick a real program", :3339 register ternary, :4614 accept-counter,
:498 parked check) · `src/routes/borrower.js` (:1050, :1104, :1141) · `src/routes/tpo.js` (:123 loop, :641, :702,
:676–688 availability payload) · `src/routes/admin-pricing.js` (availability only) · `src/server.js:432–439`
`/api/pricing-defaults`.

**Browser studio and app-v2**
`web/v2/tools/term-sheet.html` (:209 grid, :1020–1030 card block, :800/:815/:927 admin zone — availability only,
:1262 script tag + cache-buster, :1358 card detection) · `web/v2/tools/termsheet.js` (:47 `CO`, :78 `chosenProgram`,
:425–436 dispatch, `calcSpeed()`, :998 `FIT_IDS`, :1019 `PROG_CARD`, :1095 render, :1190 `progs`, :1243 ladder,
derivation page, exports) · `app-v2/src/components/ProductStudioPanel.jsx` (:342, :1472, :1497, :1597, :1849 → one
label map; :566 assignment row wording reads the percentage) · `app-v2/src/components/TermSheetStudio.jsx:251–263, 410` ·
`app-v2/src/screens/StaffCompanyPricing.jsx:27–31` · `Apply.jsx:974`, `Application.jsx:1236,1383`,
`StaffApplication.jsx:4127,5703`, `StaffEscalations.jsx:411` · `web/v2/index.html` hero (optional, D8) · rebuild
`web/v2/portal/` · `scripts/fixtures/tool-cache-busters.json`.

**Tests to extend** (all in `npm test`)
`test-program-availability-pure.js:37` (the literal list) · `test-rate-build-up.js:51` · `test-tier-markup-pure.js:87` ·
`test-tape-access-gate-pure.js:44–49` + `test-tape-export-db.js` (one-to-many) · `test-note-buyer-for-program-pure.js`
(`speed → null`) · `scripts/lib/fee-roster.js:300–330` + `test-fee-audit-pure.js` (fourth column) ·
`test-company-default-markup-pure.js`, `test-term-options-pure.js`, `test-liquidity-buffer-pure.js`,
`test/borrower-safe.test.js` (bundle has four programs) · `test-one-term-sheet.js` (unchanged, must stay green).

**Docs**
This file → `docs/SPEED-PROGRAM.md` once built (the `SILVER-PROGRAM-EMCAP.md` shape) · CLAUDE.md: the
authorization record for the three levers, the Speed composition rule, and `quoteAll` now returning four programs ·
`docs/DATA-TAPE-EXPORT.md` (Speed exports either tape once a buyer is set).

**Outside the repo**
ClickUp: add "The Speed program" to the RTL Loan Program dropdown by hand (the crosswalk must map to a live option,
CLAUDE.md line 646). Encompass: nothing — read-only, and the capital provider is whichever buyer is later chosen.

---

## 8. What this design deliberately does NOT do

- It does not write a Speed matrix, grid, geography list, tier ladder or assignment formula anywhere.
- It does not use `ovr*` or `ovrEffPrice` to pin the ceiling (they mean "admin exception" and route to approval).
- It does not compare or min loan **amounts** at any point. Only ceilings are combined; the amount falls out of the
  frozen waterfall.
- It does not touch Gold, and it does not change Standard's or Silver's own quotes by one cent (proven, §5.3).
- It does not give Speed its own markup/origination knobs, note-buyer stamp or database columns in v1 (D5, D6).
- It does not add a third card column to the studio grid.

---

## 9. Decisions the owner has to make before the build

| # | Question | Recommendation |
|---|---|---|
| **D1** | Authorize the three inert engine levers in §5.2 (`assignmentMaxPct` on both engines, `targetAcqLTV` on both, `targetARLTV` on Standard), including the two assignment reason strings reading the percentage instead of the literal "15%". | **Yes** — it is the only way to reuse the real assignment code and the real sizing code without a second copy. Without it Speed would have to re-implement the effective price and the two-pass reserve loop outside the engines. |
| **D2** | Experience. The recording says *"it shouldn't force more extreme experience requirements."* Reading A (recommended): Speed invents no experience rule; each program's own tiering decides that program's caps, and the lesser wins — so a 2-comp borrower is Standard Tier 2 and Silver Tier 2 (or Tier 3 on a large loan) and gets the lesser of those rows. Reading B: Speed ignores the stricter program's tiering and uses the looser tier. | **Reading A.** Reading B would produce a loan EMCAP would not buy on a large deal (its 5-comp rule), which breaks R9. |
| **D3** | Reserve reconciliation. Under identical ceilings the two engines differ only in the financed reserve (priced at each engine's own rate). Option 1 (recommended): Speed's structure is the higher-rate engine's evaluation — the reserve is funded at the rate actually charged (scenario B: $229,715). Option 2: hard-min the two totals and carry the higher rate — the reserve is short by the rate difference (scenario B: $228,272, 6 months of reserve become ~5.3). | **Option 1.** Both are within both programs' caps (S2 proves it); Option 1 is the only one where the note buyer sees a fully funded reserve. |
| **D4** | Rate basis. Speed charges the higher of the two programs' rates **at the Speed structure** (each engine re-prices the pinned, lower-leverage deal). Alternative: the higher of the two programs' **standalone** rates (at their own, higher leverage) — always ≥, sometimes a band more expensive than either program would charge for this loan. | **At the Speed structure.** It is "the more expensive of the two" for the loan actually being made, and it is what each engine would print for that loan. |
| **D5** | Knobs. No Speed-specific markup/origination defaults, per-file sticky markup, TPO row or columns in v1 — Speed inherits both programs' knobs through the max. | **No knobs in v1.** Revisit if the desk needs to price Speed independently; the db/373 shape is ready. |
| **D6** | Note buyer at registration. `noteBuyerForProgram('speed')` returns nothing (like Manual) and the buyer is set when the loan is placed; the tape gate then admits the Fidelis or EMCAP tape by the buyer on the file. Until a buyer is set, both buyers' **advisory** overlays (ISG, appraisal note-buyer findings) run so nothing is discovered late. | **As stated.** A Speed file must stay sellable to both until someone chooses. |
| **D7** | Studio card slot. Recommended: Speed takes the fourth slot beside Manual on row 2 while Gold is discontinued (Standard + Silver / Speed + Manual = still 2×2); when Gold is enabled for a file the grid shows a third row with Gold alone. Alternative: always three rows. | **Recommended layout.** The two-per-row rule holds; nothing is ever three across. |
| **D8** | Marketing. Show Speed on the public site's program switcher (`web/v2/index.html`) and in `/api/pricing-defaults`? | **Not in v1** — the public figures there are hand-typed, and Speed's are derived. Add after the desk has used it. |
| **D9** | Wording on the term sheet and borrower emails: "Speed Program" (never a buyer name). Confirm the label and whether the borrower-facing eligibility notes carry the program prefixes ("[Standard] …") or plain sentences. | Staff surfaces prefixed; borrower surfaces plain. |

---

## 10. Build order (after §9 is answered), with the evidence written first

1. **Levers** (D1): write `scripts/test-speed-levers-pure.js` per §5.3 and watch it fail against a deliberate
   mutation; add the three lever lines to both copies of both engines; suite green; `test-engine-copies-match`
   green; bump the two engines' `?v=`.
2. **Composition module**: write `scripts/test-speed-program-pure.js` (§6) first; build `web/tools/speed-program.js`
   until S1–S9 pass; soak; register in copies-match.
3. **Server**: `pricing.js` (branch, `quoteAll`, label, origination), availability, program-provider one-to-many
   with the tape-gate tests, six register doors through `programKey`, the borrower-safe bundle, liquidity,
   minimum-interest, field registry, crosswalk, dashboards, structuring, underwriting grounding.
4. **Studio + app-v2**: card, `calcSpeed`, exports and fee-roster column, derivation block, one label map in the
   panel, availability row, bundle rebuild, cache-busters.
5. **List tests + docs + CLAUDE.md** entries; pre-merge audit agent, merge, post-merge audit agent.
6. **ClickUp** dropdown option added by hand; verify the crosswalk round-trip on a test file.

Each step ships only with the measured numbers (scenario counts, mutation results) in its PR, per CLAUDE.md line 43.
