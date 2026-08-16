<!-- Captured PPE research brief (agent-generated, 2026-08-16). LT-only reference for the MEGA PPE build. Source: docs/longterm/PPE-MEGA-PLAN.md indexes these. -->

# Engineering Brief: Modeling Mortgage Pricing, Eligibility & LLPAs for a UI-Driven Rule Engine

## 1. Core insight: everything is a decision table

Mortgage pricing decomposes cleanly into **decision tables** (rule matrices) evaluated against a **loan scenario** (a flat bag of facts: `fico`, `ltv`, `cltv`, `dscr`, `loan_amount`, `state`, `occupancy`, `property_type`, `doc_type`, `loan_purpose`, `units`, `program_id`). The industry's canonical artifact is the **LLPA matrix** — a FICO×LTV grid of basis-point adjustments — and the whole domain is a stack of such grids plus pass/fail gates. Rather than invent a bespoke DSL, borrow the **DMN (Decision Model & Notation)** conceptual model: a table of **rules**, each rule a set of **input entries** (conditions) producing **output entries** (outcomes), evaluated under a declared **hit policy**.

A single rule is best stored as a row whose condition columns are **typed predicates**, not free text. The key representational choice is that a numeric condition is a **range** with explicit inclusivity, e.g. FICO band `[720, 740)`. Store ranges half-open (`min` inclusive, `max` exclusive) as a hard convention — it is the single most effective defense against the classic "740 falls in two bands" bug. A **grid lookup** (FICO×LTV) is just a two-input decision table; an **N-dimensional adjustment cube** (FICO × LTV × occupancy × units) is the same table with more input columns. Do not model cubes as nested JSON — model them as flat rows so the UI can render them as a grid and so gap/overlap validation stays tractable.

## 2. Eligibility vs. pricing: two different verbs

Keep these as **separate rule types with different output shapes**, because they compose differently and fail differently.

- **Eligibility rules** are **hard gates**: they emit `pass` or `fail(decline_reason)`. Example: `state == 'NY' → ineligible(reason: "NY not permitted on Program Z")`. These are evaluated **all-match**; any single failure declines the scenario. The output carries a human-readable reason for the adverse-action/decline trail.
- **Bound rules** are a special eligibility flavor emitting a **min/max constraint** rather than a boolean: `dscr < 1.0 → max_ltv = 60`. These don't decline on their own — they *tighten a limit*, and the scenario fails only if the requested value violates the tightened bound. Model them as `{ target: "ltv", op: "max", value: 60 }`. Collect all applicable bound rules and take the **most restrictive** per target (min of maxes, max of mins).
- **Pricing rules (LLPAs)** are **soft adjustments**: `+X` or `−X` basis points. They never decline; they accumulate.

This separation matters because eligibility is **short-circuit-able** (fail fast, skip pricing) while pricing is **accumulative**. A **max price cap / min price floor** is itself a bound applied to the *final accumulated price*, not to individual adjustments.

## 3. Condition operators

Support a small, closed operator set — enough to express real rate sheets, small enough to validate and render:

`between` (range, the workhorse), `equals`, `in` (set membership, e.g. `state in ['FL','TX','AZ']`), `not_in`, `gt`/`gte`/`lt`/`lte`, `is_null`. Compound logic via nested **`all` (AND)** / **`any` (OR)** groups — exactly the [json-rules-engine](https://github.com/CacheControl/json-rules-engine/blob/master/docs/rules.md) model, which is a good off-the-shelf fit. Each rule table declares a **hit policy** (per DMN, see [Camunda's hit-policy guide](https://docs.camunda.io/docs/components/best-practices/modeling/choosing-the-dmn-hit-policy/)):

- **Unique/First** for grid lookups and bounds — exactly one base price per scenario; `First` by explicit `priority` order lets specific rows shadow general ones, and a final **default row** (all conditions wildcard) guarantees a match.
- **Collect(+)** for LLPAs — gather every matching adjustment and sum. This is the DMN "collect with sum aggregation" policy and is precisely LLPA stacking.

Give every rule an integer `priority` for deterministic ordering and tie-breaking.

## 4. LLPA stacking semantics

Adjustments **accumulate as a cumulative sum** across all matched pricing rules (Collect+). Precision rules that must be explicit in the model:

- **Use integer basis points everywhere.** Never floats. A price of 100.375 is stored as `10037` (bps of price) or track price-adjustment as signed bps. Floating-point `0.1 + 0.2` errors are unacceptable in money; integer bps eliminate them and make sums associative/order-independent.
- Distinguish **price adjustments (LLPAs)** from **rate adjustments (LLRAs/margin bumps)** with an `adjustment_target` enum (`price` | `rate`). They live in the same table but sum into different accumulators.
- Apply the **cap/floor last**: `final_price = clamp(base_price + Σ adjustments, floor, cap)`. Round only at the very end, using a declared rounding rule (e.g. round to nearest 1/8 point = 125 bps), never mid-stream.

## 5. Effective dating & versioning

Every price and rule is **effective-dated**. Adopt a **bitemporal** stance (see [bitemporal modeling](https://softwarepatternslexicon.com/103/3/30/)): `effective_date`/`expiry_date` (**valid time** — when the price applies in the world) plus `created_at` (**transaction time** — when it entered the system). This enables **as-of-date evaluation** ("re-price this lock as of last Tuesday") and full audit reconstruction. Model this as immutable **versioned rule sets**: a `rule_set_version` header row (status `draft` | `published` | `retired`, `effective_from`) owns a snapshot of rows. Editing publishes a *new* version; you never mutate a published version. Evaluation selects the single version where `effective_from <= as_of < next.effective_from`.

## 6. Engine choice: ordered interpreter, not RETE

**RETE / forward-chaining** engines (Drools) shine when many rules share conditions and facts trigger cascading re-derivation. Mortgage pricing is a **bounded, stateless, single-pass** domain: one scenario in, one priced/declined result out, no chaining. RETE's node-network overhead and operational weight are unjustified. A **decision-table interpreter** — read the versioned rows, filter by matching conditions, apply hit policy — is faster to run, trivially explainable, and cache-friendly. **Recommendation: a small ordered-rule/decision-table interpreter** (DMN-shaped semantics, json-rules-engine-style condition trees), with the engine emitting a **full trace** (every rule matched, every bps applied) for the pricing-explanation UI and compliance.

## 7. Making rules editable — and safe

Store rules **as data** (rows/JSON), and the UI becomes a grid editor. The hard part is **validation**, run at publish time:

- **No gaps**: the union of FICO×LTV bands must cover the declared domain (e.g. FICO 500–850, LTV 0–100). Detect uncovered cells.
- **No overlaps**: no two `Unique`-policy rows may both match a cell. Interval-overlap check per dimension.
- **Type/range sanity**: `min < max`, bps within bounds, referenced fields exist.
- **Scenario tests**: let the user save named **test scenarios** with expected outcomes and run the whole rule set against them on every edit (a regression suite for pricing). This is how you prevent a one-cell typo from mispricing thousands of loans.

## 8. Overlays

An **overlay** is a company-specific rule set **layered on top of an investor base**. Composition semantics:

- **Tighten bounds**: overlay adds a `max_ltv = 75` bound; the engine takes `min(base_max, overlay_max)` — overlays can only restrict, never loosen (enforce this).
- **Add restrictions**: overlay contributes extra eligibility rows (`state == 'NY' → ineligible`) unioned into the base gate set.
- **Add adjustments**: overlay LLPA rows sum into the same accumulator as base rows.
- **Override**: an overlay row with higher `priority` and matching key shadows a base row under `First` policy.

Resolve by **concatenating base + overlay rows** into one evaluation set, base first, overlays at higher priority, then run normally. Keep `source` (`base` | `overlay`) on each row so the trace shows *who* imposed each bps or decline.

---

## Concrete schema sketches

```sql
investor(id, name, active)

program(id, investor_id, name, product_type,   -- 'DSCR','BankStmt','Agency'
        fico_domain_min, fico_domain_max, ltv_domain_min, ltv_domain_max)

rule_set_version(id, program_id, kind,          -- 'base' | 'overlay'
                 status,                          -- 'draft'|'published'|'retired'
                 effective_from, effective_to,
                 created_at, created_by, parent_version_id)

-- Base price grid: one row per FICO×LTV cell
base_price(id, version_id,
           fico_min, fico_max,                   -- half-open [min,max)
           ltv_min, ltv_max,
           price_bps,                            -- integer bps of par (e.g. 10025 = 100.25)
           priority)

-- Pricing adjustment (LLPA/LLRA) — Collect+ semantics
adjustment_rule(id, version_id, source,         -- 'base'|'overlay'
                conditions_json,                 -- nested all/any predicate tree
                adjustment_target,               -- 'price'|'rate'
                adjustment_bps,                  -- signed integer
                priority, description)

-- Eligibility + bounds — all-match, hard gate
eligibility_rule(id, version_id, source,
                 conditions_json,
                 outcome,                         -- 'ineligible' | 'bound'
                 decline_reason,                  -- when 'ineligible'
                 bound_target, bound_op, bound_value,  -- when 'bound': ('ltv','max',60)
                 priority)

-- Final price shaping
price_limit(id, version_id, cap_bps, floor_bps, rounding_increment_bps)

test_scenario(id, program_id, inputs_json, expected_outcome_json)
```

Example `conditions_json` (json-rules-engine shape):
```json
{ "all": [
    { "fact": "dscr", "operator": "lessThan", "value": 1.0 },
    { "fact": "ltv",  "operator": "greaterThan", "value": 0 }
] }
```

## Pitfalls (design against these explicitly)

- **Grid gaps** — a scenario matching no cell. Guard with coverage validation + a mandatory default row.
- **Overlapping ranges** — double-counting under Collect, ambiguity under Unique. Enforce half-open intervals and overlap checks at publish.
- **Boundary ambiguity** — 740 FICO / 80% LTV on a band edge. Half-open `[min,max)` convention resolves it globally.
- **Rule ordering** — non-deterministic results. Every rule carries an integer `priority`; ties broken deterministically.
- **Floating-point money** — use **integer basis points** end to end; round once, last.
- **Mutating published versions** — breaks as-of reproducibility. Versions are immutable; edits create new versions.
- **Overlays loosening limits** — enforce that overlays may only tighten bounds and add restrictions, never relax them.

**Sources:** [Fannie Mae LLPA Matrix](https://singlefamily.fanniemae.com/media/7336/display), [DMN hit policies (Camunda)](https://docs.camunda.io/docs/components/best-practices/modeling/choosing-the-dmn-hit-policy/), [json-rules-engine docs](https://github.com/CacheControl/json-rules-engine/blob/master/docs/rules.md), [LoanPASS Non-QM PPE](https://www.loanpass.io/pricing-non-qm-loans), [Optimal Blue Non-QM pricing](https://www2.optimalblue.com/blog/non-qm-lending-a-data-driven-approach-to-pricing-hedging-and-risk-management), [Bitemporal modeling](https://softwarepatternslexicon.com/103/3/30/).