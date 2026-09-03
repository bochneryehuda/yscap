# The Speed Program (RTL) — sold to Fidelis OR EMCAP

**Status: BUILT 2026-09-03, owner-directed.** The fourth registerable RTL program beside Standard
(Fidelis), Gold (Blue Lake) and Silver (EMCAP). It is **not a fourth guideline book**: it is a
composition of the Standard and Silver engines — the stricter of the two on every axis, the more
expensive of the two on every price line, with two overlays of its own (a $1,000,000 maximum loan
and a 10% financeable assignment fee). The research, the measurements and the owner's decisions
are in `docs/SPEED-PROGRAM-RESEARCH.md`; this is the shipped record.

The owner, 2026-09-03: *"Approved on all nine decisions … Main goal is not to rebuild anything, just
share the code of the two programs. You also need to keep in mind the lower maximum loan amount for
each tier. We also want to put a cap maximum for the speed program. It's an additional overlay on
top of the more conservative programs. Maximum loan out for the speed program is $1 million."*

---

## 1. What the program enforces (all of it read from the two parents, live)

| Axis | Speed = |
|---|---|
| Max loan | the lesser of Standard's tier wall and Silver's tier wall for **this** deal, and never above **$1,000,000** |
| Max acquisition LTV (max initial advance) | the lesser of the two |
| Max after-repair LTV | the lesser of the two (the owner's own example: 70% beats 75%) |
| Max loan-to-cost | the lesser of the two |
| Geography | **both** books apply — Indiana and Louisiana (Standard) AND Nevada, Minnesota, the Dakotas, the ZIP-precision bans and the NYC rules (Silver) |
| Experience | each parent's own tiering decides that parent's caps; the lesser caps win (decision D2 — no invented rule) |
| Eligibility gates | both parents' — value-add, DSCR, cash-out ≤ 50% of profit, seller financing, min FICO 640, F&F refinance bans in CA/NY/FL, the judicial sub-$100k exception … |
| Status | the worse of the two: INELIGIBLE if either refuses, MANUAL if either is MANUAL or either has no price |
| Note rate | the **higher** of the two parents' rates **for the Speed structure** (each parent re-prices the pinned, lower-leverage deal at its own markup) |
| Origination | the higher of the two parents' resolved origination |
| Minimum earned interest | ON if ON for either parent |
| Assignment fee | financeable to **10%** of the seller's contract price — the company's 15% formula with 0.10; the excess is cash to close |
| Interest reserve | **never financed** (owner 2026-09-03, second message). A requested reserve is zeroed before either parent prices; the quote carries "Interest reserve is not financed on the Speed Program — the N months requested are not in this loan"; the borrower pays interest from own funds and the liquidity to show is measured on the full payment as before |
| Loan-to-cost wall | **never more than 90%**, even where both parents allow 92.5% — applied as a MIN through the parents' `targetLTC` lever and credited to the Speed Program on the derivation page |
| Bank statements / reserve months / draw fees / min loan | as Standard and Silver (identical on both) |

**Never "the lesser of the two loan amounts."** A 10% effective price is a smaller base; a loan below either
parent's own figure can still sit above 90% of that base. Ceilings are combined and the loan falls out of the one
frozen waterfall. Measured: the shortcut over-lends by $9,424 and $13,331 on two of the research scenarios.

## 2. How it is built

- **The one definition: `web/tools/speed-program.js`** (`window.SPP`; byte-identical copy `web/v2/tools/`;
  registered in `scripts/test-engine-copies-match.js`). Loaded after `standard-program.js` and
  `silver-program.js`. `SPP.evaluate(input)` returns the same shape as the engines plus a `speed` block
  (`capDonor`, `rateDonor`, `standard`, `silver`, `maxLoanCap`, `assignmentMaxPct`); `SPP.priceLadder(input)`
  returns Standard's ladder shape.
- **The four overlays of Speed's own** (`speed-program.js` constants, the only numbers in the file): `SPEED_MAX_LOAN`
  1,000,000 · `SPEED_MAX_LTC` 0.90 · `FINANCED_RESERVE_ALLOWED` false · `ASSIGNMENT_MAX_PCT` 0.10. The owner's reasoning
  for the reserve rule: *"interest reserve usually helps bring up the cap … this program is gonna have even a smaller loan
  amount because we don't allow financed interest reserve"* — the reserve sits in both parents' cost basis, so refusing it
  is one more way the Speed loan is smaller while still under every parent cap. Measured on scenario B of the research
  ($200k seller + $30k fee, 6-month reserve requested): $229,715 with the reserve → **$216,000** without it at the 90% wall.
- **The algorithm.** Speed basis = the caller's input + `assignmentMaxPct 0.10` + `targetLoan ≤ $1M` + `targetLTC ≤ 0.90`
  + `irMonths = irAmount = 0` (the request is remembered on `speed.reserveRequested`). Pass A: each
  parent's own ceiling for the deal on that basis (Standard `caps`, Silver `pricedCeiling`). Combine: elementwise
  MIN (+ the $1M wall), with who-set-it recorded per axis. Pass B: pin both parents to the combined ceiling
  through `targetLoan / targetAcqLTV / targetARLTV / targetLTC`, iterated to a fixed point (≤ 4 passes — Silver's
  step-down lattice may lower its ceiling again under a pin). Donor = the higher note rate. Reasons are the
  parents' own sentences prefixed `[Standard]` / `[Silver]` / `[Both]`, behind one composition sentence
  (`code: speed_composition`). Two more steps, each found by the soak before it shipped:
  - **The lesser max initial, floors included.** Under one ceiling the parents differ only by the reserve — except
    where one carries its own floor on the initial (Standard's judicial-state sub-$100k exception holds the initial
    $20,000 below the price). When the rate donor's initial exceeds the other parent's by more than the reserve
    difference, the donor is re-sized with its acquisition lever pinned to the other's initial. Measured: a $77,772
    Pittsburgh bridge, Standard $57,772 vs Silver $58,329 — Speed takes $57,772.
  - **Each buyer's own book, on its own basis.** A gate that reads the recognized price can pass on the 10% basis
    and fail under the parent's own 15% rule, where the cost basis is higher (Silver's "the after-repair value must
    exceed the cost basis"). So each parent is asked once more on the caller's own input, pinned only to the Speed
    loan amount: INELIGIBLE there is INELIGIBLE here, MANUAL there is MANUAL here, and the sentence is carried with
    "(on that program's own guidelines for this loan amount)". Measured: 106 of 24,750 priced soak deals.
- **The three engine levers this needed** (phase 1, owner-authorized; `scripts/test-speed-levers-pure.js`):
  `targetAcqLTV` (both engines), `targetARLTV` (Standard), `assignmentMaxPct` (both) — each a MIN, inert when
  unset, proven byte-identical over 8,640 scenarios × 3 engines.
- **Server:** `pricing.quoteProgram('speed')` sets BOTH parents' markups (each through its own chain) and resets
  both; `normalize('speed')` takes the higher origination; `quoteAll` → `{ inputs, standard, gold, silver, speed }`;
  `quote.speed` carries the explain block; `borrowerSafeQuoteBundle` strips all four.
- **No knobs, no migration (decision D5).** No `markup_speed_pct` / `orig_speed_pct` / sticky per-file Speed
  markup / TPO row / database column. Speed inherits both parents' knobs through the max.
- **Note buyer (decision D6).** `tapes/program-provider.PROVIDERS_FOR_PROGRAM.speed = ['fidelis','emcap']`:
  registration stamps no buyer (the team chooses when the loan is placed, like Manual); once the file's buyer is
  set, that buyer's tape may be exported. Borrower copy says "Speed Program", never a buyer name.
- **Availability.** `program-availability.PROGRAM_KEYS` = standard, gold, silver, speed — togglable company-wide
  and per file like the others. Every other server list now DERIVES from it (`intake-auto-register` and
  `term-sheet-offer` program sets, the six register doors through `manual-program.requestedProgramKey`, the
  TPO own-stamp loop, the "pick a real program" wording).
- **Derived, never re-typed, on the underwriting side.** The owner-KYC threshold for Speed
  (`underwriting/entity-chain.js PROGRAM_OWNER_RULES.speed`) is derived at load as the lower-percentage parent
  (Standard's 15% and its treatment); the advisory fallback caps (`underwriting/metrics.js`) are the frozen
  elementwise MIN of the Standard and Silver rows. `tapes/buyer-rule.programsForProvider(buyer)` derives
  "which programs may export this buyer's tape" from `programMatchesBuyer`, so the tape picker and its
  mismatch messages read "Standard or Speed" / "Silver or Speed" without a second list.

## 3. Where it is wired (system inventory)

- **Engines / shared:** `web/tools/speed-program.js` + `web/v2/tools/speed-program.js`; the three levers in both
  copies of `standard-program.js` and `silver-program.js`.
- **Server:** `src/lib/pricing.js`, `program-availability.js`, `tapes/program-provider.js`, `borrower-safe.js`,
  `vesting-program-rule.js programKey`, `liquidity.js`, `conditions/field-registry.js` (`registered_program`
  enum), `dashboards/registry.js`, `clickup/crosswalk.js` ("The Speed program"), `intake-auto-register.js`,
  `term-sheet-offer.js`, `manual-program.js`, `underwriting/structuring.js` (`swap_program_speed`),
  `underwriting/program-guidelines.js`, `underwriting/metrics.js` (fallback caps derived as the min of the two
  parents), the underwriting grounding text, the six registration doors in `routes/staff.js`, `routes/borrower.js`,
  `routes/tpo.js`.
- **Term Sheet Studio (V2):** the fifth card `#pcardSpeed` (two per row is preserved — with Gold discontinued the
  grid reads Standard + Silver / Speed + Manual), `calcSpeed()` / `window.TS._calcSpeed`, the ladder, the PDF /
  Excel / proof-of-funds / deal-profile exports, and the derivation page's **"How the Speed Program was composed"**
  block (each ceiling, who set it, both rates, the donor, the 10% assignment line).
- **Products & Pricing / app screens:** `app-v2/src/lib/programLabel.js` (the one label map), the Speed quote card
  and composition detail in `ProductStudioPanel.jsx`, the studio bridge in `TermSheetStudio.jsx`, the availability
  toggle in `StaffCompanyPricing.jsx` (no markup fields), labels everywhere else.
- **ClickUp:** the RTL Loan Program dropdown needs the option **"The Speed program"** added by hand (as for Silver).
  **Encompass:** nothing — read-only.

## 4. Evidence

- `scripts/test-speed-program-pure.js` (in `npm test`) — 20,746 scenarios (8 places incl. IN and NV × 4 strategies ×
  purchase/refi × FICO × ARV × rehab × experience × reserve × assignment, plus ten pinned edge shapes): worst status wins; **dual-sellability** —
  each parent alone, at its own 15% rule and own caps, accepts every Speed loan and every ratio sits under that
  parent's ceiling; the rate is exactly the higher of the two; the 10% share; the trap asserted directly; truthful
  attribution; the $1M wall binds (3,168 scenarios held at exactly $1,000,000) and a typed amount above it is refused
  by name; determinism, no input mutation, no markup leak; never throws; the ladder only steps down; Indiana and
  Nevada refused. Mutation evidence: share 0.10 → 0.15 (red), rate donor flipped to the lower rate (red, 12,924
  violations), the $1M wall removed (red), Silver's program maximum read instead of its deal ceiling (red).
- `scripts/test-speed-levers-pure.js` — the engine levers (phase 1).
- Studio and app screen harnesses — see the PR.

## 5. Deliberate interpretations and known gaps (flag to the owner if wrong)

1. **Experience (D2):** no Speed rule of its own; each parent's tiering, the lesser caps.
2. **Reserve (D3):** the higher-rate parent's evaluation is the structure, so the reserve is funded at the rate charged.
3. **Rate basis (D4):** the higher of the two rates at the Speed structure, not at each parent's own higher leverage.
4. **Ties in attribution:** a ceiling both parents set at the same figure is credited to "both programs"; the $1M wall is
   credited only when it is genuinely below both parents' tier walls.
5. **Reason tags (D9) — server-side plain, browser what-if tagged.** Every quote a borrower receives through the API
   goes through `borrower-safe.stripQuoteInternal`, which drops the `[Standard]` / `[Silver]` / `[Both]` prefixes.
   The studio's instant what-if banner runs the composition in the browser and shows the tags as-is; they name our
   own programs, never a buyer. Making the browser banner role-aware is a follow-up.
6. **D6's second half is NOT built — disclosed.** The owner approved "until a buyer is set, both buyers' advisory
   overlays run". The appraisal note-buyer checks and the ISG rules key on the buyer label on the file, and a Speed
   registration deliberately leaves the buyer blank, so today a Speed file carries neither parent's overlay until a
   buyer is chosen. The build is a union over `providersForProgram('speed')` in `appraisal/note-buyer-checks.js` and
   `underwriting/investor-guideline-review.js` when the buyer is blank and the program is Speed. Follow-up.
7. **The Silver shadow-parity monitor watches Silver registrations only.** A Speed file's Silver-side evaluation is not
   re-checked against the EMCAP workbook transcription (the monitor reads a registered quote's structure; Speed's is
   the donor's). Watch-only; extend when `program === 'speed'` from `quote.speed.silver` as a follow-up.
8. **Speed's ladder** is Standard-shaped but carries no `maxBucket` (no consumer of the Speed ladder reads it).
