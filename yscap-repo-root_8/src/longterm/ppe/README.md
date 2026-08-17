# LT Product & Pricing Engine (`src/longterm/ppe/`)

The Long-Term (DSCR-first) Product & Pricing Engine. **LT-only** — every file here is
`src/longterm/**`, uses `lt_ppe_*` tables, and imports no RTL code. Design + rationale:
`docs/longterm/PPE-MEGA-PLAN.md`. Lender-Price parity status: `docs/longterm/LENDER-PRICE-PARITY-STATUS.md`.

## The one model (why this exists)

**Lender Price is the source of truth — for now, in every scenario (§1.2, §9).** Our engine runs
*beside* it in **shadow** mode: both price every request, LP's answer is what the business sees, and
every disagreement becomes a **finding** we fix. An investor is promoted to **live** (our engine
authoritative, LP no longer called) only one at a time, only by a human, only once the scoreboard gate
is met (§10.5, §11). That is the whole point of the shadow machinery below.

## Units convention (do not deviate)

Everything numeric is an **integer in milli-**:

- **price** → milli-points. Par = `100000` (100.000 points). `102.850 pts → 102850`.
- **rate** → milli-percent. `7.125% → 7125`.
- **points** = `100000 − price` (positive = borrower pays; negative = a credit).
- **cost-positive sign** on adjustments: `price = base − Σ(signed LLPA) − margin − comp + SRP`. A
  positive LLPA is a **cost** and *lowers* the price. Round ONCE, then clamp to `[floor, cap]` LAST.

Never introduce a float price/rate on a stored or compared value; never re-derive a rate ("par → base
→ note" is wrong — a rate is chosen, a price is computed).

## Modules

### Pricing engine (§5–§6)
- **`pricing.js`** — the pure numeric pipeline. `priceRung` produces the full **reconstruction record**
  (base, itemized adjustments, margin, srp, comp, final, floor/cap, rounding) — the crown jewel that
  §10 validates and §8 freezes. `priceLadder`, `interpolatePrice`, `roundPrice`.
- **`rules.js`** — DMN-style decision-table evaluator: eligibility (declines), bounds (most-restrictive
  tightening), pricing (accumulate adjustments). Half-open `[min,max)` bands; a missing fact fails
  safe (false + surfaced as unknown).
- **`quote.js`** — façade composing rules + pricing for one program+scenario → `ineligible(reasons)` or
  `eligible(ladder)`. Rounding/margin/floor/cap all resolved from settings (nothing hardcoded).
- **`ratesheet.js`** — pure sheet → program mapper (grid + pricing rules from band columns + priceLimit).
- **`settings.js`** — the typed settings registry + coded defaults (Rule #1: our choices are seed
  defaults). **`store.js`** — the DB bridge (per-tenant overrides; degrades to coded defaults on any
  read failure) + investor/program/rate-sheet creates.

### Daily rate-sheet sync (§7)
- **`ratesheet-ingest.js`** — raw upstream grid → normalized Layer-1 base-price **cells**
  (`productId/noteRateMilli/lockDays → basePriceMilli`) via a product **crosswalk**; unmapped product
  is a problem, never guessed; shape validation (monotonicity, min rungs, missing locks). Fail closed.
- **`ratesheet-diff.js`** — canonicalize + content-hash cells, keyed set-difference diff (version-
  stamped so a canonicalizer bump is a rebaseline, not churn), and the §7.4 **auto-apply vs review**
  classifier (numeric within guardrails auto-applies; rule changes / bound exceeded / bulk change →
  review). `priceMonotonicityViolations` guardrail.

### Locks (§8)
- **`lock.js`** — the lock state machine (`floating → lock_requested → locked → … → expired →
  relocked`; terminal cancelled/withdrawn/purchased), `freezeSnapshot` (freezes + hashes the full
  price build), append-never-mutate sub-records, `worstCasePrice = min(original, market)` used by
  relock + reprice-on-change, expired-lock disbursement hard-block. **Every policy number is a
  setting** the caller supplies.
- **`best-execution.js`** (§8.3) — rank eligible investors' ladders by target-rate or target-price.

### Lender-Price shadow + validation + cutover (§9–§11)
- **`facade.js`** (§9.2) — "runs together, LP wins": returns LP's answer in shadow mode while comparing
  ours and recording findings **without ever blocking the response or letting a shadow failure break
  the business answer**. Live mode + optional canary.
- **`parity.js`** (§10.1) — compare our quote vs LP's for one scenario → agreement + findings
  (eligibility / rate / price within settings tolerances). §10.6 honesty: a side that produced no
  result is `incomparable` (never scored as agreement, and kept out of the agreement-rate
  denominator), never read as a silent "ineligible". `normalizeOurQuote`, `summarize`.
- **`lp-normalize.js`** — LP's parsed result (percent/points) → the canonical milli ladder parity uses.
- **`scenario-matrix.js`** — full cartesian battery generator. **`coverage.js`** (§10.3) — one-field
  goldens (A), numeric boundaries (B), pairwise (C).
- **`shadow.js`** — the runner: both engines over a battery, bounded concurrency, an `engine_error`
  finding per scenario so one LP timeout never loses the batch. **`shadow-report.js`** (§10.5) — the
  legible scoreboard (verdict, disagreements by kind, worst price gaps, errors).
- **`finding.js`** (§10.4) — the findings-ledger LOGIC: stable identity key, reconcile a run against the
  stored ledger, **never re-open a settled finding** (a fixed one that reappears is flagged
  `regressed`), report disappeared findings for auto-close.
- **`finding-store.js`** (§10.4) — the durable BRIDGE for the findings ledger: persists to
  `lt_ppe_finding` (db/561) what pure `finding.js` produces and **delegates every merge to
  `finding.reconcile`** (no SQL copy of the "never re-open a settled finding" rule to drift). `db` is an
  injected pool (same convention as `store.js`); everything is `scope`-scoped.
- **`cutover.js`** (§10.5/§11) — per-investor scoreboard (open findings, clean-day streak, canary rate,
  compared/incomparable scenario counts) + the go-live gate + the `draft→shadow→live→retired` lifecycle
  (promotion gated, rollback always allowed). Two coverage gates: an **incomparable** scenario blocks
  promotion always (§10.6, no setting turns it off — "100% agreement" over scenarios that couldn't all
  be compared isn't 100%), and an opt-in `minCanaryScenarios` coverage floor (off by default, fails
  closed when set).

### The shadow LOOP (canary → measure → decide → record)
- **`canary.js`** (§10.3/§10.5) — the CANARY run: prices one scenario matrix beside Lender Price in ONE
  reusable call and packages the result for every consumer — `records` (→ `finding-store.persistRun`),
  `runRecord` (→ the `scoreboard.assemble` series), `report` (→ a human). It MEASURES one run; it never
  DECIDES (cutover) and never PERSISTS (finding-store).
- **`canary-schedule.js`** (§10.3a) — the PURE decision of WHEN a canary runs and on WHAT. Validates a
  saved schedule (cadence bounds, exactly one non-empty battery) and answers due/not-due against an
  INJECTED clock and the last-run instant read from the run series the canary already writes (never a
  second stamp of its own — the one that drifts is the one the gate reads). Its hard rule: **a schedule
  never invents a battery**; an absent one refuses and says why, because a made-up battery still
  produces an agreement rate and that number feeds the promotion gate. Fails toward NOT running.
- **`scoreboard.js`** (§10.5) — the continuous-measurement layer BETWEEN the canary and the gate:
  collapses a dated series of run records into the `{ canaryAgreementRate, dailyNewFindings }` shape
  `cutover` consumes plus a `trend` an admin reads. It MEASURES; `assemble` DELEGATES the eligibility
  decision to `cutover.buildScoreboard`/`eligibleForLive` (one definition of "eligible").
- **`cutover-ledger.js`** (§11) — the append-only, replayable DECISION history of an investor's
  lifecycle moves (who/when/from→to/reason/scoreboard). It manages the SEQUENCE; it never re-implements
  legality — every step delegates to `cutover.transition`, and promotion to live requires the
  scoreboard gate's `eligible:true`.
- **`review-queue.js`** (§10.4/§12) — turns the stored ledger into a prioritized, human-workable list:
  a `severity` per finding (kind + price-gap magnitude; a broken fix is bumped; an unknown/`incomparable`
  item is surfaced, never hidden), a deterministic priority ordering (severity → regressed → recurrence
  → age), and a per-investor/kind/severity roll-up. It only ORGANIZES — decisions stay in `cutover`,
  persistence in `finding-store`, the per-gap prose in `divergence`.
- **`divergence.js`** (§10.1/§10.4) — makes ONE disagreement actionable: shows our full `pricing.priceRung`
  build-up beside Lender Price's single number and ranks the component whose magnitude most closely
  matches the gap (`strong`/`possible`/`none`). Honest by design — LP gives only a final price, so a
  suspect is a HYPOTHESIS, never a claim that either side is wrong.

### Investor layers as DATA — the scalable foundation (PPE #47)

Layers 2 (eligibility matrix) and 3 (PPP state matrix) started as hand-written JavaScript for ONE
investor. They are now expressible as **DATA + pure compilers** that emit the SAME canonical rules
`rules.evaluateRules` already runs, so onboarding investor #2 is *two JSON files and one registry
entry*, not a second module.

- **`investor-data/*.json`** — an investor's eligibility matrix / PPP matrix as data. Versioned by
  effective date (`deephaven-dscr.eligibility.v2026-08-04.json`, `deephaven-dscr.ppp.v2026-03.json`).
- **`layer-facts.js`** — the CLOSED derived-fact vocabulary (`string`, `is_number`, `truthy`,
  `number_gt`, `substring_any`, `classify`). It exists because `LEAF_OPS` deliberately has no regex,
  no substring test and no "is a finite number" test, while the hand-written modules normalize and
  type-check before comparing. Derivations chain in declaration order. An unknown kind is REFUSED.
- **`layer-compile-eligibility.js`** / **`layer-compile-ppp.js`** — the pure compilers. They build
  every rule through **`rule-builder`** and validate through **`rule-builder.validateRule`** (never a
  second rule shape, never a second validator), inject the numeric guard leaf-LOCALLY, and carry the
  presentation the canonical shape has no field for (`dimension`, `citation`) in a CATALOG keyed by
  each rule's unique internal code. Diagnostics that are not declines (the resolved grid cell, which
  PPP rule matched) ride BOUNDS on non-fact targets, which are inert by construction.
- **`layer-data-registry.js`** — the versioned catalog: `(investor, layer, version) → document`, a
  memoized compile, and the compiled program descriptor `program-engine.runProgram` runs. A program
  PINS the version of each layer it prices on; `getData` never guesses a version. Overlay and
  informational are still code, and `describeProgram()` says so rather than implying otherwise.

The hand-written `deephaven-matrix.js` / `deephaven-ppp-matrix.js` remain in place and are the
**ORACLE**: `scripts/test-lt-ppe-layer-compilers.js` drives both forms with the same facts over
~330,000 scenarios and demands a byte-identical verdict, then mutation-proves the harness bites.

## Data flow

```
layer data:   investor-data/*.json ─ layer-compile-* ─▶ canonical rules ─ rules.evaluateRules ─▶ verdict
                                   └─ layer-data-registry (investor × layer × VERSION) ─▶ program descriptor
daily sync:   raw grid ─ ratesheet-ingest ─▶ cells ─ ratesheet-diff ─▶ classify ─▶ auto-apply | review
pricing:      scenario ─ quote(program, settings) ─▶ ladder (reconstruction records)
shadow:       scenario ─ facade ─┬─ ourQuote ─ normalizeOurQuote ─┐
                                 └─ priceLp ─ lp-normalize ────────┴─ parity ─▶ finding ─▶ report
loop:         canary ─▶ records ─ finding-store.persistRun ─▶ ledger
                    └─▶ runRecord ─ scoreboard.assemble ─▶ cutover gate ─ cutover-ledger (human decision)
                    findings ─ divergence ─▶ ranked suspect (actionable for a human)
lock:         a chosen rung ─ lock.freezeSnapshot ─▶ frozen+hashed; extend/relock/reprice append sub-records
```

`scripts/test-lt-ppe-shadow-e2e.js` proves this composes with the **real** engine end-to-end.

## Tests

`node scripts/test-lt-ppe-all.js` runs every `scripts/test-lt-ppe-*.js` suite (pure suites run with no
DB; `-db` suites add a round-trip when `DATABASE_URL` is set). All suites are currently green.

## Pending (deliberately not built yet)

- **The canary WORKER.** The cadence DECISION now exists (`canary-schedule.js`, below) and is fully
  tested; what is still missing is the thin IO wrapper around it — the tick that reads each scope's
  saved schedule, takes a per-scope Postgres advisory lock (so N Render instances fire one battery,
  not N), re-checks due-ness under the lock, calls the same `runCanary` → persist path the admin
  button uses, and is OFF unless switched on. Deliberately not half-wired: a scheduler that fires
  live vendor batteries is a "stage anything that touches production" change, and the piece worth
  getting right first was the rule, not the plumbing.
- **Storing a saved battery.** `canary-schedule` describes what a schedule must contain; nothing
  persists one yet (no table, no `PUT /canary/schedule`). Note the ordering constraint that follows
  from the module's one hard rule: the worker cannot ship before the store, because a schedule with
  no saved battery never runs — and it must never invent one.

_(Done 2026-08-16 — **the `/api/lt/ppe/*` route and the admin UI both shipped**; this section used to
list them as pending and was simply stale. The route mounts `facade.js` against the real LP client +
`quote.js` + the store and carries `POST /canary` (the "run canary now" button) → `canary.runCanary`
→ `finding-store.persistRun` + `run-store.persistRun` → `GET /scoreboard`. The admin screen carries
the scoreboard/trend surface, the findings ledger with `divergence` diagnoses, and the human-gated
promote/rollback controls.)_
_(Done 2026-08-16 — **the suites now run in CI.** `node scripts/test-lt-ppe-all.js` is wired into
`package.json`'s `test` chain as ONE entry, right after `test-lt-dscr-routes.js`. One entry, not 27,
because the aggregator auto-discovers every `test-lt-ppe-*.js` — so a suite added later is picked up
with no second list to keep in step. That it goes RED was PROVEN, not assumed: flipping the
cost-positive sign in `pricing.js` (`base + Σcost` instead of `base − Σcost`, i.e. a fee that RAISES
the price) turned 4 suites red and the aggregator exited 1; reverted, it exits 0. Until now all 27
suites existed and CI ran none of them.)_
