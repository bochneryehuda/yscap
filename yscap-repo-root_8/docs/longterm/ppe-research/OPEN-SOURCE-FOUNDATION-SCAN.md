<!-- LT-only. Research record: is there open-source code to build the PPE on? (owner asked 2026-08-17). -->

# Open-source foundation scan — is there real code to build the PPE on?

**The owner asked (2026-08-17):** just wondering — is there any publicly available code out there that
would give us a rock-solid foundation for a mortgage Product & Pricing Engine, so we don't build
everything from scratch? Only if it's a *real* match.

**The answer: no — nothing out there beats what we already have. Keep building custom.** A parallel
research pass searched all six relevant areas and drilled into every real candidate.

## What genuinely does NOT exist (searched and confirmed)
- **No open-source mortgage PPE / LLPA / rate-sheet pricing engine.** Every mortgage repo on GitHub is a
  simple calculator (amortization, monthly payment, affordability). Zero LLPA stacking, zero rate grids,
  zero coupon→price ladders. The real PPEs (Lender Price, Optimal Blue, LoanPASS, Polly) are all closed
  commercial products.
- **No open-source rate-sheet (Excel) → structured-pricing parser.** The only tooling is commercial OCR.
  This is entirely bespoke — which is exactly what our E5 import must build.
- **No open-source DSCR / Non-QM pricing.** All commercial.
- **No open-source mortgage eligibility / guideline rule sets.** Nobody has published mortgage guideline
  decision tables.

## The only real candidates (generic rule engines), and why we don't adopt one
- **GoRules `zen-engine`** (MIT, actively maintained) — the closest architectural match: it runs true
  decision tables with hit policies, and it ships a **visual table editor**. BUT its core is Rust with a
  **native compiled Node binary** (against our no-native-deps rule), and it knows nothing about
  milli-points, LLPA stacking, margin, floor/cap, or rate-sheet ingestion — all the hard domain work
  stays ours. We've already built the evaluator in pure Node. *Worth revisiting LATER only if
  hand-authoring decision tables becomes painful — for the visual editor, accepting the native-binary
  cost. Not now.*
- **`json-rules-engine`** (ISC, pure JS, maintained) — wrong paradigm (facts→conditions→events, not a
  decision-table/grid model). Adapting it to our rate-grid + LLPA-matrix would fight its grain.
- **`dmn-eval-js`** (MIT, pure JS, right shape) — **abandoned** (~2018), forks stale. Adopting a dead
  dependency for core pricing logic is a liability.

## Why custom wins
The value in a PPE is almost entirely the parts nobody has open-sourced: LLPA stacking semantics,
integer milli-point arithmetic, margin/rounding/floor/cap ordering, rate-sheet ingestion, and the Lender
Price comparison harness. The generic engines only ever offered the rule-evaluation *shell* — and we've
built that shell in pure Node with zero native deps, arguably a better fit for our constraints than the
MIT-but-native GoRules or the MIT-but-dead dmn-eval-js.

**Decision: keep building custom.** Revisit GoRules zen ONLY later, ONLY for its visual editor, ONLY if
authoring tables by hand becomes a real pain point.
