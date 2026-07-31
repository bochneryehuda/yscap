# Out-of-Pocket Rehab Exception — Research & Build Blueprint

**Status:** IMPLEMENTED (owner-authorized 2026-07-31 — the owner gave explicit written
authorization for the exact frozen change: *"re-slice an already-sized loan so the initial
advance rises toward the acquisition-LTV cap and the displaced rehab is brought out of pocket —
total loan, rate and every cap unchanged; byte-identical when the exception amount is zero."*)
The sections below are the original research; **§9 records what was built.**

Owner decisions (2026-07-31): entry = **a dollar box AND a "raise the initial to max" toggle**
(the financed-% option was dropped); approval = **both** an escalation and a tracked
loan_exceptions record; available on **all four programs**.

---

## 1. What the owner asked for (intent)

Today **every YS program finances 100% of the rehab budget**. When a cap (ARV or LTC) shrinks
the loan, our rule is fixed:

- the **initial (acquisition) advance is cut** to keep the total under the cap,
- the **scope of work / rehab stays fully financed**,
- **out-of-pocket rehab = $0** (never allowed).

The owner wants a **per-deal exception** (off by default, all programs) that, when a cap has
**cut the initial below its own maximum**, lets us:

1. **raise the initial advance back up** toward the real initial cap, and
2. **push the displaced rehab dollars out of pocket** — the borrower funds part of the rehab.

The Manual section of Products & Pricing / Term Sheet Studio should, on such a deal:

- **show two numbers first** — how much the initial is being cut, and the **maximum
  out-of-pocket rehab** that could be allowed with an exception;
- offer a **box to enter** the out-of-pocket amount;
- send it through **the same approval** as an out-of-pocket rehab approval (admin / super-admin);
- then flow correctly into the **three investor tapes, the term sheet, the loan-file structure,
  and the Encompass out-of-pocket / financed-rehab mapping**.

It is an **exception basis only** — the default rule (no OOP rehab) is unchanged.

---

## 2. The mechanic (the math)

**Key insight: the total loan does NOT change.** The exception only re-slices the same total —
a bigger initial advance, a smaller rehab holdback, and a new out-of-pocket-rehab number. No
leverage cap, rate, LTC bucket, matrix value, or reserve moves.

### Worked example

| Input | Value |
|---|---|
| Purchase price | $200,000 |
| Max acquisition LTV | 90% → **max initial `A` = $180,000** |
| Rehab / construction budget | $100,000 |
| ARV | $300,000; max ARV LTV 70% → **total wall = $210,000** |

**Today (default rule):** total is pinned at the $210k ARV wall; rehab is 100% financed = $100k;
so **initial = $210k − $100k = $110k** — cut $70k below the $180k acquisition max. Down payment
= $90k. OOP rehab = $0.

**With the exception (borrower brings rehab out of pocket):** raise the initial to the $180k
acquisition max; total still $210k; so **financed rehab = $210k − $180k = $30k**, and the
remaining **$70k of the $100k budget is out of pocket**.

| | Default | Exception (maxed) |
|---|---|---|
| Initial advance | $110,000 | **$180,000** |
| Financed rehab (holdback) | $100,000 | **$30,000** |
| Out-of-pocket rehab | $0 | **$70,000** |
| Total loan | $210,000 | $210,000 (unchanged) |
| Down payment | $90,000 | $20,000 |

The two headline numbers the owner wants shown:

- **Initial being cut** = `A − initial` = $180k − $110k = **$70k**
- **Max potential OOP rehab** = `min(A − initial, financed rehab)` = min($70k, $100k) = **$70k**

The admin enters any amount `X` from `$0` up to the max; `initial += X`, `financed rehab −= X`,
`OOP rehab = X`. (They come out equal here because the total is fixed at the wall — every $1
added to the initial removes $1 of financed rehab.)

### Trigger condition (when the exception is offered)

Only when the initial was **cut by a total cap** — the sizing's binding constraint is the ARV,
LTC, or program-max wall (`bindKey ∈ {arv, ltc, maxloan}` or the rehab-only case) **and** the
initial sits **below** its own acquisition cap (`acquisition < A`). If the acquisition LTV is
already the binding cap (`bindKey='acq'`), the initial is already maxed — nothing to shift, no
exception offered. This is exactly the owner's "a cut on the Max initial… because it needs to
fully finance your rehab."

Both headline numbers are derivable **purely from what the engine already returns** — no frozen
change needed for the *information display*: `A = caps.maxAcqLTV × sizing.acqDenom`,
`initial = sizing.acquisition`, `financed rehab = sizing.rehabLoan` (all present on the
`evaluate()` result).

---

## 3. Where everything lives (the map)

### 3.1 The sizing engine — ONE shared function for ALL programs

All four programs size through the **single** function `YSP.sizeLoan` in `standard-program.js`:

- Standard: `web/tools/standard-program.js` (+ 5 other copies) — `sizeLoan` at line 206.
- Gold: `gold-standard.js:24,358` calls `YSP.sizeLoan`.
- Silver: `silver-program.js:41,1048` calls `YSP.sizeLoan`.
- Manual: uses the Standard-engine numbers (per CLAUDE.md Term Sheet Studio rule).

The 100%-financed rule is one line: **`standard-program.js:240` `var rehabLoan = rehab; // 100%
financed, no OOP`**, with the initial as the plug: `initialAt(R) = min(A, capHard − rehab − R,
byLtc)` (lines 253-259). The nearest existing analog is the `rehabOverCap` MANUAL message
(`standard-program.js:571`) — the only place OOP rehab exists today, when the budget alone
exceeds the wall.

**Consequence:** the re-slice logic is written **once** and every program inherits it.

### 3.2 Structure persistence — the saved quote, not a DB column

The initial/holdback/reserve/OOP split lives **only** in `product_registrations.quote.sizing`
(jsonb) — there is **no `applications` column** for it (grep-confirmed across `db/*.sql`).
`applications.rehab_budget` = the **full** budget; `applications.loan_amount` = the total.

- `src/lib/pricing.js` `normalize()` maps the engine output to the persisted names
  (`pricing.js:308-313`): `rehabHoldback = floor(s.rehabLoan)`, `initialAdvance =
  floor(s.acquisition)`, financed reserve as the residual. The persisted `quote.sizing`
  (`pricing.js:397-412`) already carries `assignmentExcessOOP` (`pricing.js:326`) — **the exact
  template for a new `oopRehab` key** — folded into `cashToClose` (`pricing.js:333`).
- `src/lib/product-registration.js` writes the whole `quote` jsonb (`:232`); `borrowerTermsKey`
  already includes `initialAdvance` + `rehabHoldback` (`:106-107`), so a split change re-notifies
  the borrower automatically.

**Invariant to preserve:** `rehab_budget = financed_rehab + oop_rehab` and
`total_loan = initial_advance + financed_rehab + financed_reserve`.

### 3.3 The three investor tapes

Source of truth for all three: `product_registrations.quote.sizing.rehabHoldback` (financed) and
`applications.rehab_budget` (total). OOP = total − financed.

| Tape | OOP field | Total-budget field | Status |
|---|---|---|---|
| **Fidelis** (`src/lib/tapes/fidelis.js`) | **N** `e.oopRehab` (auto-computed `:215-218`) | **O** `e.totalRehab` (`:265`) | ✅ **Ready — no code change.** Column N fills automatically once financed < budget; I keeps financed, O keeps the full budget. |
| **Blue Lake** (`bluelake.js`) | none (derivable as **AH − U**) | **AH** `e.rehabBudget` (`:175`) | ⚠️ Carries both totals (**U** financed `:159`, **AH** total `:175`); cost/LTC formulas already use the full budget. **Add one OOP column only if Blue Lake's workbook has a dedicated field.** |
| **EMCAP** (`emcap.js`) | none | none | ❌ **Needs work.** **K** "Original Rehab Amount" (`:193`) reads the *financed* holdback; no total-budget and no OOP column — would under-report. Needs a getter/column decision. |

Seasoning (`seasoning.js`) already works off the financed holdback only — OOP (an upfront
constant) needs no seasoning change.

### 3.4 Encompass mapping (READ-ONLY — nothing is ever written to Encompass)

Encompass already models the exact trio (`docs/ENCOMPASS-FIXFLIP-MASTER-MAPPING.md §5.3`):

| Concept | Encompass field | PILOT status |
|---|---|---|
| Total rehab budget | `CX.REHABBUDGET` | ✅ mapped `rehab_budget` (`encompass-field-map.js:103`) |
| Financed rehab / holdback | `CX.FINANCEDREHABBUDGET` | ✅ mapped `financed_rehab_budget` (`:104`) — note already says *"modelled distinct for future out-of-pocket rehab"* |
| **Out-of-pocket rehab** | `CX.OUTOFPOCKETREHAB` | ❌ **not mapped — add** (money, category rehab, `zeroMeansNone:true`) |
| Initial advance (final) | `CX.FINALINITIALLOAN` | ✅ mapped `final_initial_loan` (`:102`) |
| Max initial loan | `CX.MAXINITIALLOAN` | ❌ not mapped (optional cross-check) |

`reconcile.js buildOurValues` (`:132-137`) already computes `financed_rehab_budget =
sizing.rehabHoldback ?? rehab_budget`. Adding the OOP field to the registry auto-reads it (via
`allFieldIds()`) and reconciles it (advisory finding on mismatch, never blocks CTC). PILOT side:
`oop_rehab = rehab_budget − sizing.rehabHoldback`.

### 3.5 Term sheet (studio, PDF, Excel, borrower email)

`assignmentExcessOOP` is the working template everywhere:

- **Studio** rows: `rAdvance`/`rHoldback`/`rDown`/`rCash` (`termsheet.js:1324/1338/1348/1358`;
  `term-sheet.html:831/833/863/865`). Add an "Out-of-pocket rehab" line after Down payment;
  `rCash` updates automatically once OOP is in `cashToClose` (`termsheet.js:439`).
- **PDF**: Loan-structure section `:1995-2006`; cash-to-close section `:2032-2043` — the
  assignment-OOP line at **`:2040`** is the exact template for an OOP-rehab row.
- **Excel / derivation**: `:1650-1740` (splice a row into the fee block before cash-to-close).
- **Borrower email**: `product-registration.js borrowerTermsEmail:435-457` (add a "Rehab paid out
  of pocket" meta row); flows through `terms-notify.js` automatically.

### 3.6 The exception / approval machinery

- **Register (`loan_exceptions`)** — `src/lib/loan-exceptions.js`: `EXCEPTION_TYPES` registry
  (`:144`), lifecycle `requested → approved | denied | withdrawn`, governance columns,
  `EX-n` reference, xlsx export. Adding a type = one registry entry + reason const + `requestX`
  wrapper + a migration widening the CHECK (mirror `db/370`) + a `TYPE_META` in
  `ExceptionCard.jsx` + audit strings in `admin-exceptions.js`.
- **Manual escalation** — `src/lib/manual-program.js`: `needsSuperAdminApproval` (`:87`),
  `openEscalation` (`:191`), decided in the Escalations box (`manage_pricing`, requester ≠
  approver, super-admin exempt). `pricing-overrides.js pricingOverridesEngaged` (`:145`) detects
  any admin knob off default; `ENGAGED_OVERRIDE_KEYS` (`:78-91`) is the list a new admin knob
  joins to auto-trigger approval + withhold the borrower email + block the DocuSign issuance
  (`esign/gate.js:73`).
- **Studio admin zone** — `term-sheet.html .ts-admin-zone` (`:630`), inputs like `tsEffPrice`
  (`:671`), `tsManualOn` (`:676`), `tsMLtv/Arv/Ltc` (`:678-680`); read in `termsheet.js` gather
  (`:243-251`); carried by `ProductStudioPanel.jsx overridesFromSnapshot` (`:116`) →
  `register()` (`:724`); the **"This goes to an admin for approval"** banner already exists
  (`ProductStudioPanel.jsx:1182`).
- **Request-an-exception routes**: `POST /api/{staff,borrower}/applications/:id/pricing/
  request-exception` (`staff.js:2611`, `borrower.js:1142`); register at `staff.js:2176`.

---

## 4. Recommended design

**Footprint: ~90% non-frozen.** The workflow, the exception record, persistence, the tapes, the
Encompass read/reconcile, the borrower email, and the React studio panel are all **non-frozen**
files. Only the client term-sheet tool (`termsheet.js` + `term-sheet.html`) must be touched to
add the box, the two info numbers, and the OOP line on the sheet — that single **additive**
change is byte-identical when the OOP amount is `0`, exactly like the earlier `irAmount` /
`ovrEffPrice` work, and needs the owner's written sign-off + a runtime-equivalence test.

### The one input, threaded like `ovrEffPrice`

Add `tsOopRehab` (a dollar box) to the Manual/admin zone. When `> 0`, a small **pure re-slice**
of the sizing output (used by the studio preview, the register/normalize, and the tape/Encompass
values):

```
A            = caps.maxAcqLTV × sizing.acqDenom     // max initial
X            = clamp(oopRehab, 0, min(A − sizing.acquisition, sizing.rehabLoan))
initialAdvance = sizing.acquisition + X
rehabHoldback  = sizing.rehabLoan   − X
oopRehab       = X
totalLoan      = unchanged
```

Persist `oopRehab` into `quote.sizing` (beside `assignmentExcessOOP`); fold it into
`cashToClose`. Everything downstream (tapes, Encompass, term sheet, borrower email) reads from
there.

### Approval — recommended: reuse the existing escalation, optionally add a tracked type

The owner's "same level as an out-of-pocket rehab approval" maps to the existing
admin/super-admin escalation. Two composable choices:

1. **Minimal:** add `oopRehab` to `ENGAGED_OVERRIDE_KEYS` (`pricing-overrides.js`). It is then
   auto-detected, opens a `manual_program_escalations` row (`summary.kind='pricing_override'`),
   withholds borrower terms, and blocks issuance until approved — **no new table**.
2. **First-class + tracked:** also add an `oop_rehab` `loan_exceptions` type so it appears on the
   Exceptions screen with an `EX-n` reference, reason codes ("finance less of the rehab"), and
   the xlsx register export.

**Recommendation:** do **both** — (1) makes it work end-to-end with the least code; (2) gives the
owner the audit trail they asked for ("goes through the same level of exception and needs to be
approved").

### Grant = studio admin-override + re-register

The admin approves the escalation, then enters the approved OOP amount in `tsOopRehab` and
re-registers — identical to today's pricing-override grant. Approval clears
`product_registrations.needs_approval`, unblocking the term-sheet issuance.

---

## 5. The ONE thing that needs the owner's written authorization

CLAUDE.md HARD RULE: no pricing/guideline number or sizing formula changes to the frozen files
(`standard-program.js`, `gold-standard.js`, `termsheet.js`, `pricing.js`, …) without the owner's
explicit written authorization.

This feature changes **no** leverage cap, rate, matrix value, FICO min, or total loan amount. It
adds **one optional input** (default 0) that re-slices an already-sized total. The authorization
ask, in the owner's own words to grant:

> *"Allow, as an approved exception, re-slicing an already-sized loan so the initial advance
> rises toward the acquisition-LTV cap and the displaced rehab is brought out of pocket — total
> loan, rate, and every cap unchanged; byte-identical when the exception amount is zero."*

We prove byte-identical behavior with a runtime-equivalence battery (thousands of scenarios,
old vs new engine, every numeric field identical when OOP = 0) and re-freeze, per the standard
discipline.

---

## 6. Open decisions for the owner

1. **How the admin enters it** — a **dollar box** for the OOP amount (0…max, with a "max it out"
   button) is the recommended default. Alternative: a financed-rehab % or a plain "raise initial
   to max" toggle.
2. **Approval channel** — reuse the pricing-override escalation only, or also add a first-class
   tracked `oop_rehab` exception type (recommended: both).
3. **Programs** — offer on all four (Standard/Gold/Silver/Manual), since they share the sizer, or
   restrict to some.
4. **Blue Lake & EMCAP tape fields** — Fidelis is ready. Does **Blue Lake's** workbook have a
   dedicated out-of-pocket-rehab cell (needs a new column) or is "financed + full budget"
   enough? **EMCAP's** tape needs a decision (add total-budget + OOP columns, or point its rehab
   column at the full budget with a financed/OOP split). The owner knows these sheets — the exact
   column/header for each is needed.
5. **Encompass field IDs** — the owner offered to provide the correct Encompass fields. Research
   found `CX.OUTOFPOCKETREHAB`, `CX.FINANCEDREHABBUDGET`, `CX.REHABBUDGET`, `CX.FINALINITIALLOAN`,
   `CX.MAXINITIALLOAN` — please confirm these are the ones in use.

---

## 7. Phased build plan (after authorization)

1. **Info display (non-frozen, no authorization):** compute + show "initial being cut" and "max
   OOP rehab" in the studio admin zone / React panel from the existing engine result. Nothing is
   entered yet.
2. **Re-slice + persistence (frozen additive — authorization):** `tsOopRehab` box → `termsheet.js`
   gather → engine input; the pure re-slice; persist `quote.sizing.oopRehab`; fold into
   cash-to-close; runtime-equivalence test. Term sheet PDF/Excel/studio OOP line.
3. **Approval (non-frozen):** add `oopRehab` to `ENGAGED_OVERRIDE_KEYS` (+ optional `oop_rehab`
   exception type); "goes to an admin for approval" banner; grant = re-register.
4. **Tapes (non-frozen):** Fidelis (verify), Blue Lake (+column if needed), EMCAP (add
   columns/getters).
5. **Encompass (non-frozen):** add `CX.OUTOFPOCKETREHAB` to the registry + `oop_rehab` to
   `buildOurValues`; reconcile advisory only.
6. **Borrower email + structure surfaces (non-frozen):** OOP meta row; `borrowerTermsKey`.
7. **Two-audit-agent gate + tests** per CLAUDE.md before merge.

---

## 8. Files touched (reference index)

**Frozen (authorization required):** `web/(v2/)tools/termsheet.js`, `web/(v2/)tools/term-sheet.html`
(× the tool copies); `src/lib/pricing.js` (normalize/buildInputs) *if* the re-slice is done there
rather than a non-frozen post-processor. Engines (`standard/gold/silver`) do **not** need
changes — the re-slice is a post-sizing transform.

**Non-frozen:** `src/lib/product-registration.js`, `src/lib/terms-notify.js`,
`src/lib/pricing-overrides.js`, `src/lib/manual-program.js`, `src/lib/loan-exceptions.js`,
`src/routes/staff.js` + `borrower.js` + `admin-exceptions.js`, `src/lib/tapes/{emcap,bluelake}.js`,
`src/lib/integrations/encompass-field-map.js`, `src/encompass/reconcile.js`,
`app-v2/src/components/{ProductStudioPanel,TermSheetStudio,ExceptionCard}.jsx`, new
`db/NNN_oop_rehab_exception.sql`.

---

## 9. What was built (2026-07-31)

The engine matrix/caps/rate math is **untouched** — the re-slice is a pure transform of the
already-sized structure, done in the two mirrored renderers.

- **Backend re-slice** — `src/lib/pricing.js` `normalize()`: gated re-slice (initial↑ / holdback↓
  / `oopRehab`=X), new `quote.sizing` keys `oopRehab / maxOopRehab / initialCut / maxInitial`;
  cash-to-close drops by X, liquidity-to-show unchanged; `buildInputs` whitelists `oopRehab`
  (NUMK) + `oopRehabMax` (BOOLK). Uses the effective acquisition cap (`pricedCeiling || caps`).
  Byte-identical when off — proven by a 4,000-scenario old-vs-new equivalence sweep + the pure
  test `scripts/test-oop-rehab-pricing.js`.
- **Studio** — `web/v2/tools/term-sheet.html` + `termsheet.js` (V2 only; V1 untouched): a
  "Out-of-pocket rehab exception" admin group with an info line (initial cut / max OOP), a
  dollar box (`tsOopRehab`) and a "raise the initial to its max" toggle (`tsOopRehabMax`); one
  shared `oopReslice()` helper drives `calc()/calcGold()/calcSilver()`; the loan structure, PDF
  and Excel gain an OOP line.
- **React** — `ProductStudioPanel.jsx` forwards `oopRehab`/`oopRehabMax` and lists them in the
  "goes to an admin for approval" banner; `TermSheetStudio.jsx` reads + restores them. Rebuilt
  into `web/v2/portal`.
- **Approval** — `pricing-overrides.js` `ENGAGED_OVERRIDE_KEYS` gains both keys, so any amount
  opens the manual-program escalation, withholds the borrower email, and blocks the DocuSign
  issuance. **Tracked record:** a first-class `oop_rehab` `loan_exceptions` type
  (`loan-exceptions.js` + `db/386` + `ExceptionCard.jsx` + `admin-exceptions.js` audit); the
  register route records an EX-n row after commit (best-effort, on the pool).
- **Downstream** — Fidelis tape fills its OOP column automatically; EMCAP economics now derive
  `totalRehab`/`oopRehab` (column mapping pending the owner's EMCAP workbook cell); Encompass
  reads/reconciles `CX.OUTOFPOCKETREHAB` (read-only); the borrower email gains a "Rehab paid out
  of pocket" row and `borrowerTermsKey` re-notifies on a change.

**Still owner-dependent (from §6):** the exact out-of-pocket **column** on the Blue Lake & EMCAP
workbooks (Fidelis is done; EMCAP has the data ready to wire), and confirmation of the Encompass
field IDs.
