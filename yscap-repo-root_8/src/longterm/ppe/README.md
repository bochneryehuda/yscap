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
  (eligibility / rate / price within settings tolerances). `normalizeOurQuote`, `summarize`.
- **`lp-normalize.js`** — LP's parsed result (percent/points) → the canonical milli ladder parity uses.
- **`scenario-matrix.js`** — full cartesian battery generator. **`coverage.js`** (§10.3) — one-field
  goldens (A), numeric boundaries (B), pairwise (C).
- **`shadow.js`** — the runner: both engines over a battery, bounded concurrency, an `engine_error`
  finding per scenario so one LP timeout never loses the batch. **`shadow-report.js`** (§10.5) — the
  legible scoreboard (verdict, disagreements by kind, worst price gaps, errors).
- **`finding.js`** (§10.4) — the findings-ledger LOGIC: stable identity key, reconcile a run against the
  stored ledger, **never re-open a settled finding** (a fixed one that reappears is flagged
  `regressed`), report disappeared findings for auto-close.
- **`cutover.js`** (§10.5/§11) — per-investor scoreboard (open findings, clean-day streak, canary rate)
  + the go-live gate + the `draft→shadow→live→retired` lifecycle (promotion gated, rollback always
  allowed).

## Data flow

```
daily sync:   raw grid ─ ratesheet-ingest ─▶ cells ─ ratesheet-diff ─▶ classify ─▶ auto-apply | review
pricing:      scenario ─ quote(program, settings) ─▶ ladder (reconstruction records)
shadow:       scenario ─ facade ─┬─ ourQuote ─ normalizeOurQuote ─┐
                                 └─ priceLp ─ lp-normalize ────────┴─ parity ─▶ finding ─▶ report ─▶ cutover gate
lock:         a chosen rung ─ lock.freezeSnapshot ─▶ frozen+hashed; extend/relock/reprice append sub-records
```

`scripts/test-lt-ppe-shadow-e2e.js` proves this composes with the **real** engine end-to-end.

## Tests

`node scripts/test-lt-ppe-all.js` runs every `scripts/test-lt-ppe-*.js` suite (pure suites run with no
DB; `-db` suites add a round-trip when `DATABASE_URL` is set). All suites are currently green.

## Pending (deliberately not built yet)

- **`lt_ppe_finding` table + a DB store** for the findings ledger (§10.4). The *logic* is done
  (`finding.js`); the migration is held until this branch's base settles to avoid a migration-number
  collision (main and this branch both currently carry a `db/554`).
- **The `/api/lt/*` route** mounting `facade.js` against the real LP client + `quote.js` + the store.
- **The admin UI** (§12) and wiring these suites into CI's `package.json` test chain (kept out of the
  conflict-prone chain until merge time; `test-lt-ppe-all.js` is the single entry to add).
