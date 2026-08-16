<!--
  MEGA PPE BUILD PLAN — Long-Term (LT) product only.
  Source of truth for the sellable, multi-tenant Product & Pricing Engine.
  Grounded in docs/longterm/ppe-research/01-08 + docs/longterm/RATE-SHEET-KNOWLEDGE.md.
  LT-ONLY: everything lives in src/longterm/**, /api/lt/*, lt_* tables, db/NNN_lt_*.sql,
  scripts/test-lt-*.js. No RTL code, tables, or mappings are touched or reused.
  STATUS: v1 (2026-08-16). All sections grounded in the four research digests + owner directives.
-->

# MEGA PPE — Product & Pricing Engine: Architecture & Build Plan

> **What this is.** A ground-up, **sellable**, multi-tenant Product & Pricing Engine (PPE) for
> mortgage / DSCR lending — the kind of system a very large company would license. It holds any
> number of **investors**, each with **several programs**, and lets a business author **eligibility**,
> **ineligibility**, **pricing**, and **LLPA** rules against them. For now it runs **alongside Lender
> Price**, which stays our **source of truth**, and a **shadow-reliability** layer flags every
> disagreement so we can fix our engine before an investor is ever trusted on its own.

---

## 0. How to read this plan

- **§1–§2** — the vision and the one-picture product model. Read first.
- **§3–§8** — the engine itself: data model, settings layer, pricing/LLPAs, rules, ingestion, locks.
- **§9–§11** — the Lender-Price relationship: backend-for-now, shadow reliability, per-investor cutover.
- **§12–§13** — interfaces, multi-tenancy, security, and the LT separation guarantees.
- **§14** — the step-by-step build roadmap (phases, each shippable and testable).
- **§15** — open decisions for the owner.

---

## 1. Non-negotiable principles

These govern every later decision. If a later section ever contradicts one of these, the principle wins.

### 1.1 Rule #1 — SELLABLE AS-IS. Nothing is customized to us; our choices are *seed defaults*.

The product must be shippable to any lender with **zero code changes**. Therefore:

- **No YS-Capital-specific value is ever hardcoded** in engine logic — not a margin, a FICO floor, a
  cap, an investor name, a program, a rate sheet, a tolerance, a lock table. Every such value lives in
  a **typed setting** in a configuration layer.
- **Every setting exposes all the industry-standard options** a company could reasonably want, and is
  **pre-filled with our chosen default**. Our configuration is nothing more than **seed data** loaded
  into a fresh tenant; another company overrides it without touching code.
- For **every** requirement, the design question is always: *"what is the industry-standard way to do
  this, and what are the other standard ways?"* — all of them become selectable options; ours is the
  pre-filled default.
- A feature is not "done" until the thing we'd otherwise hardcode is a switchable setting with a
  documented default and the full option set.

### 1.2 Lender Price is the source of truth — for now, in every scenario.

- Our PPE **runs by itself** AND **calls Lender Price as a backend** in **every** pricing scenario,
  today. We build our overlays *on top of* Lender Price fully as backend.
- When our engine and Lender Price **disagree**, **Lender Price wins** and is what the business sees.
  The disagreement becomes a **finding** for manual review so we can fix our engine.
- An investor is rolled **live without the Lender Price backend** only after a sustained period (weeks)
  of **zero disagreements** for that investor — one investor at a time (§11).

### 1.3 Strict product separation (LT only).

- All PPE code is LT: `src/longterm/**`, HTTP under `/api/lt/*`, tables named `lt_*`, migrations
  `db/NNN_lt_*.sql`, tests `scripts/test-lt-*.js`. No RTL table, trigger, mapping, enum, or module is
  read, written, imported, or generalized. The one shared zone (identity) is untouched by the PPE.
- The Lender Price connector already lives at `src/longterm/lenderprice/**` and stays the only bridge
  to Lender Price.

### 1.4 Multi-tenant from line one.

- Every row that can differ per company carries a **tenant** scope. A single deployment serves many
  lenders; one lender's investors, programs, rules, rate sheets, settings, and findings are invisible
  to another. (For our own use there is exactly one tenant — but the schema never assumes that.)

### 1.5 Everything is versioned, effective-dated, and audited.

- Rate sheets, rules, programs, and settings are **immutable versions** with **effective dates**, so we
  can price **as of** any date and always explain *why* a number came out the way it did. Every change
  records who/when/what.

---

## 2. The product in one picture

```
Tenant (a lending company)
  └── Settings (typed, industry-standard options, pre-filled defaults)   ← Rule #1 lives here
  └── Investors  (capital providers / note buyers — a MASSIVE registry)
        └── Programs  (several per investor: e.g. DSCR 30yr, DSCR I/O, Bridge, …)
              └── Rate Sheets      (versioned, effective-dated rate×price grids + lock columns)
              └── LLPAs / Adjustments  (stackable, attribute-driven grids)
              └── Eligibility rules     (does this scenario qualify?)
              └── Ineligibility rules   (why not? — human-readable reasons)
              └── Pricing rules         (base-rate build-up, margins, caps, rounding)
              └── Guidelines            (documentation shown to staff)

A PRICING REQUEST = a Scenario (borrower + loan + property + product inputs)
  → validate & normalize (reject bad input BEFORE any pricing)
  → for each program: run eligibility → if eligible, price it (base → LLPAs → margin → caps → round)
                                        → if ineligible, collect the reasons
  → RESULT = { eligible: [priced programs with rate/point ladders],
               ineligible: [programs with reasons] }

SHADOW: the SAME scenario also goes to Lender Price. A reliability layer compares
        eligible sets, ineligible sets + reasons, and priced rungs. Any mismatch → a FINDING.
        Lender Price's answer is what the business uses until an investor is cleared to go live.
```

The rest of the plan builds each box, then the shadow/validation machinery around it.

---

## 3. Core data model / schema (`lt_ppe_*`)

Two long-lived **anchors** — `investor` and `program` — and everything price-bearing hangs off them as
an **effective-dated, append-only version** that is never mutated. Two hard disciplines run through
every table: **integer basis points, never floats** (price `102.850` → `102850`; rate `7.125%` →
`71250`; every LLPA a signed integer — sums stay associative and never drift), and **half-open
`[min,max)` ranges everywhere** (the single most effective defense against the "740 FICO falls in two
bands" boundary bug).

### 3.1 The tables (canonical names; all carry `tenant_id`)

- **`lt_ppe_tenant`** — a lending company. `branding_json`, `parent_org_id` (for org inheritance).
- **`lt_ppe_investor`** — a note buyer / capital provider. `code` (stable), `name` (**internal-only**),
  `active`. **`lt_ppe_investor_alias`** absorbs the "spelled 151 ways" problem (one canonical investor,
  many recorded spellings) — reusing the discipline the RTL investor registry already proved.
- **`lt_ppe_program`** — a product family under an investor (DSCR 30yr, DSCR I/O, Bridge…). Several per
  investor. First-class eligibility-domain fields the research calls for: `max_loan_amount`, `max_ltv`,
  `min_fico`, `min_dscr` (+ a sub-1.0 tier with reduced LTV caps), `cash_out_allowed`, product variant
  (e.g. second-lien), `property_type_set`, `channel` (correspondent / wholesale / retail — the channel
  splits the sheet). `investor_id` NULL = a house/base program.
- **`lt_ppe_rate_sheet_version`** — THE effective-dated, versioned container; the unit that ships daily.
  `program_id`, `version_no` (monotonic), `status ∈ {draft, pending, published, superseded}`,
  `effective_from`/`effective_to` (half-open; NULL = current), `recorded_at` (**transaction-time**, for
  bitemporal "what did we believe on the 14th"), `content_hash` (dedupe byte-identical sheets),
  `reprice_seq` (an intraday reprice is a first-class event, never an overwrite), `channel`,
  `approved_by`/`approved_at` (maker-checker). A **GiST exclusion constraint** makes two `published`
  versions with overlapping effective periods impossible.
- **`lt_ppe_base_price`** — the rate-sheet grid: rows of **coupon × lock_days × price_bp** (+ product
  column where a sheet prices several products, e.g. 15yr/ARM vs 30yr fixed). `UNIQUE (version, coupon,
  lock_days, product)`; partitioned by `version_id` so a quote scans only the active version.
- **`lt_ppe_adjustment`** — an LLPA / price adjustment, as a **flat row** (never a nested JSON cube).
  `version_id`, `dimension` ('fico_ltv' | 'dscr' | 'occupancy' | 'purpose' | 'prepay' | 'units' |
  'loan_amount' | 'property' | 'state' | …), the band columns as ranges (`fico_range`, `ltv_range`,
  `dscr_range` as `numrange`/`int4range`), an open-ended `predicate jsonb` for the long tail,
  `adj_bp` (**signed**), `adjustment_target ∈ {price, rate}` (most are price; some non-QM sheets publish
  rate add-ons — normalize to price internally but **retain the original unit**), `sign_convention`,
  `cumulative`, `priority`. A **GiST exclusion constraint** on `(version, dimension, fico_range,
  ltv_range)` makes overlapping cells impossible to insert; a publish-time coverage check asserts the
  grid **tiles** its domain (a gap makes a loan unpriceable — as dangerous as an overlap).
- **`lt_ppe_price_limit`** — per version: `min_price_bp` (floor, e.g. 98000), `max_price_bp` tiers by
  loan size, `rounding_increment_bp` (e.g. nearest 1/8 point = 125), `on_exceed` behavior.
- **`lt_ppe_rule`** — the unified eligibility / ineligibility / bound rule table (§6). `version_id`,
  `kind ∈ {eligibility, bound, pricing}`, `source ∈ {base, overlay}`, `conditions_json` (nested all/any
  predicate tree over scenario facts), `outcome`/`decline_reason`/`bound_target`+`bound_op`+`bound_value`
  or `adjustment_*`, `priority`, `description`.
- **`lt_ppe_overlay`** — the house/lender layer over an investor's rules, with an explicit
  `precedence_tier`. **Overlays may only tighten/restrict, never loosen** (enforced): a bound overlay
  takes `min(base_max, overlay_max)`; adjustment overlays sum into the same accumulator; a higher-
  priority overlay row shadows a base row.
- **`lt_ppe_guideline`** — human-readable documentation shown to staff per program.
- **`lt_ppe_scenario`** — a saved scenario (a flat bag of facts: `fico`, `ltv`, `cltv`, `dscr`,
  `loan_amount`, `state`, `occupancy`, `property_type`, `units`, `doc_type`, `loan_purpose`, `prepay`,
  `lock_days`, `term`, `io`, …). Also used for the test-scenario / canary corpus.
- **`lt_ppe_pricing_run`** — one pricing request + its full **trace** (every rule matched, every bp
  applied) as a first-class output — the explanation/audit record, not a log line. Stores the pinned
  `rate_sheet_version_id` so a quote is reproducible and a later sheet never silently reprices it.
- **`lt_ppe_finding`** — a shadow disagreement (§10.4).
- **Settings tables** — §4.

### 3.2 Cross-cutting

- **Effective-dated, append-only versioning** (not row-level system-versioning). Publishing a new
  version closes the prior's `effective_to`; nothing is deleted. "Current" is a thin predicate
  (`status='published' AND now() ∈ [from,to)`). **Instant rollback** = re-point effective dates.
- **Bitemporal on the version HEADER only** (valid-time + transaction-time) — enough for "re-price this
  lock as of last Tuesday" and repurchase/audit disputes, without the cost of bitemporal grid rows.
- **Content-hash dedupe** avoids a daily-snapshot storage explosion: a byte-identical new sheet reuses
  the immutable grid rows and only mints a new version header. Snapshot-per-**change**, not per-day.
- **Config-as-data:** normalize the hot lookup keys into typed columns with CHECKs (indexed, integrity-
  enforced); JSONB (GIN, `jsonb_path_ops`) only for the open-ended predicate/long tail, **validated at
  write time** so the UI can't persist a rule the engine can't read.
- **Raw SQL numbered migrations stay the single source of truth** (`db/NNN_lt_*.sql`); no Prisma
  Migrate (introspection silently drops exclusion constraints / partial indexes / triggers — fatal for
  pricing integrity). A read-only introspected typed client is optional.

---

## 4. Settings / configuration layer (Rule #1, made mechanical)

The governing principle from the research: **"behavior is data, not code branches"** (the Salesforce
metadata-driven model — one engine that materializes rules from config at runtime; tenants customize by
writing config rows, never by forking code). The named anti-patterns are banned outright: no
`if (tenant == 'us')`, no hardcoded investor name, no compiled eligibility matrix, no lock policy
written in TypeScript instead of a table. **"If a requirement can only be met by editing code, the
design has failed."**

### 4.1 The method — every requirement becomes an axis

For **every** knob we'd otherwise hardcode: (1) name the industry-standard option, (2) enumerate the
other real-world options, (3) model them as a typed setting exposing all choices, (4) pre-select ours
as the default. *"If a stakeholder says 'we want X,' the job is not to build X but to build the axis X
sits on, expose the whole axis, and default it to X."*

### 4.2 The typed settings registry

- **`lt_ppe_setting_definition`** (`key` PK, `datatype`, `enum_values[]`, `constraints_json`,
  `product_default`, `ui_metadata_json` [control type, group, label, help], `effective_dating` bool).
  This metadata lets the front end **render every setting screen generically** — no bespoke UI per
  feature — and is the **single source of truth for enums** (kills DB↔UI enum drift).
- **`lt_ppe_setting_value`** (`tenant_id`, `key`, `value_json`, `effective_from/to`, `version`,
  `updated_by/at`). **Resolution is a strict override chain: tenant → org/parent → product default,
  first hit wins.** Effective-dated (rate-sheet/LLPA changes are time-boxed), immutable audit, config
  versioning so any priced scenario reproduces against the exact config in force at that timestamp.
  Validated on write against the definition (unknown keys / out-of-enum rejected).

### 4.3 Settings categories (each an axis, pre-filled with our default)

Pricing knobs; **margin** (incl. the verified **0.25 correspondent margin** — a setting, not a
constant); **caps** (price cap, cumulative-adjustment cap) & **floors**; **rounding** (mode +
increment, default nearest 1/8); **FICO minimums**; **reserves**; **income/doc types**; **prepay
structures**; **lock days table**; **compensation** (LPC/BPC, %, subtract-from-price); **tolerances**
(the parity tolerances of §10); **eligibility result mode** (`hard_fail_only` / `show_with_reasons`
[industry std, default] / `soft_warn`, per-rule severity); **float-down / relock / worst-case basis**;
branding; per-tenant terminology glossary; **investor-name masking / aliases**; feature flags.

### 4.4 Templates & seed (how our choices become seed data)

- Ship **`lt_ppe_ruleset_template`** — versioned, read-only, product-owned rulesets ("Conventional
  Conforming eligibility", "Agency LLPA", "Standard Best-Efforts Lock Policy").
- A tenant **clones** a template into **`lt_ppe_tenant_ruleset`** and edits the copy → versioned
  product-defaults vs tenant-overrides, with a Salesforce-style **diff/merge upgrade** flow so we can
  ship template v2 without clobbering a tenant that forked.
- **Our go-live config is nothing but a seed manifest** of template clones + a handful of overridden
  values — reproducible, deletable, and identical in mechanism to what any buyer gets on day one.

### 4.5 Guardrails that keep it sellable (build them as tests, not intentions)

- A **CI lint** that fails the build on a tenant-name / investor-name string literal in engine code.
- An **architecture test** asserting the engine reads only resolved config (never a hardcoded value).
- A **"fresh-tenant" test**: provision an empty tenant from product defaults with **zero seed** and it
  must still produce valid (if generic) pricing. If it can't, something is hardcoded.
- Investor masking is a **`lt_ppe_program_alias`** row (per-tenant, per-role — LOs see the alias, the
  secondary desk sees the true investor), **never a code literal**.

---

## 5. Pricing engine — rate sheets, LLPAs, the pipeline

**The one mental model:** almost everything is denominated in **price (points)**, not rate. A rate is
*chosen* (the coupon row); a **price** is what that rate is worth. `points = 100 − price` (par = 100;
one point = 1% of loan amount). LLPAs move the **price**. Getting the price↔rate duality exact is the
crux — do **not** invent new rates ("par rate → base rate → final note rate" is wrong).

### 5.1 The numeric pipeline (bottom-up; each layer transforms a price)

```
final_price = base_price(coupon, product, lock_days)         # Layer 1: the grid cell (par = 100)
            + FICO×LTV/CLTV_adj(dscr_band, fico, cltv)       # Layer 2: the primary matrix cell (signed bp)
            + Σ other_LLPAs(purpose, prepay, IO, units,      # Layer 2: flat add-on rows
                            property, loan_amount, state, …)
            + SRP                                            # Layer 3: correspondent/retail servicing value (optional)
            − margin                                         # Layer 4: corporate margin (the 0.25 rule — a SETTING)
            − comp_if_LPC                                    # Layer 5: LPC subtracts; BPC does not
final_price = clamp(final_price, min_price, max_price_tier)  # floor/ceiling LAST
points      = 100 − final_price                             # positive = borrower pays; negative = credit
```

Every **rung** (coupon) is priced, so the LO/borrower sees a **ladder** (pay points for a lower rate,
or take a higher rate for a credit). Between-rung prices are **interpolated** (linear blend of the two
nearest coupons by rate distance) — **record the interpolation provenance** or a result can't be
reproduced.

### 5.2 The invariants to encode (from the verified knowledge doc)

1. `points = 100 − price`; dollars = points% × loan amount.
2. `adjusted_price = base_price − Σ(signed LLPAs)` (cost-positive convention) — equivalently in points
   `adjustedPoints = basePoints + adjustmentPoints`, `price = 100 − adjustedPoints`. **Sign convention
   is the #1 place a reconstruction breaks** — store each adjustment's signed value AND its convention;
   never infer globally. Positive LLPA = a cost (lowers price); negative = a credit (raises price).
3. LLPAs are **cumulative**, integer bp, order-independent; cap/floor applied **last**; round **once,
   last**, by the declared increment.
4. **The FICO×CLTV grid is 3-D on DSCR sheets** — a full FICO×CLTV block per DSCR band (≥1.25 /
   1.15–1.24 / 1.00–1.14 / <1.00; the sub-1.0 band both costs price and caps LTV, with `N/A` = not
   eligible). Grid cells are **step functions, not interpolated**; only the rate↔price axis interpolates.
5. **Ineligible ≠ dropped** — a declined program returns **structured reasons** (rule ref + failing
   value vs limit: "Max LTV 80% exceeded (requested 85%)"), distinguishing hard fails from advisories.

### 5.3 The verified 0.25 margin rule (our seed default, proven against Lender Price)

Lender Price is uniformly **0.25 more expensive on price** than the raw investor sheet, because 0.25 is
the correspondent margin, **applied to base price before LLPAs, across the board** — verified live
2026-08-16 across all 28 coupons of a Deephaven DSCR scenario (every coupon exactly 0.250, modulo 3rd-
decimal workbook rounding). So `Lender Price price = sheet price − 0.25`. In our engine this is
**Layer 4, a configurable margin setting whose seed default is 0.25** — never a hardcoded constant, and
any final price inherits it (don't re-derive per adjustment).

### 5.4 What we store per priced rung (the reconstruction record — the crown jewel)

note rate; base price (+ base points); the **itemized signed adjustment array** (each with reason,
category, value in points and/or rate, unit, sign convention); margin / SRP / comp as **separate
components** (flag what was folded in); interpolation flag + which rungs; final rate / points / price;
APR, monthly P&I (+ IO vs amortizing for I/O), qualifying/PITIA for DSCR; lock/expiration; sheet
effective date/time + version. This 1:1 maps to Lender Price's `priceBuild` (`parRate`/note rate,
`basePoints`, `adjustmentPoints`, `adjustedPoints`, `price`, itemized `adjustments[]`) — which is
exactly what §10 validates against.

> **Warning the research stresses:** the representative LLPA magnitudes in the briefs are
> industry aggregations, **NOT authoritative**. The actual values in a live `searchRaw` response are
> authoritative for that lender and must be captured **verbatim** from the itemized adjustment stack,
> never inferred.

---

## 6. Rules engine — eligibility, ineligibility, pricing, LLPAs

**One representation for all rule kinds: decision tables** (the DMN — Decision Model & Notation —
conceptual model: a table of rules, each a set of input conditions → output entries, under a declared
**hit policy**). We do **not** invent a bespoke DSL and we do **not** model adjustment cubes as nested
JSON — flat rows so the UI renders a grid and gap/overlap validation stays tractable. The evaluator is
a small **ordered decision-table interpreter** (json-rules-engine-style condition trees), **not RETE /
Drools** — mortgage pricing is bounded, stateless, single-pass; the interpreter is faster, cache-
friendly, trivially explainable, and emits a full trace.

### 6.1 Three rule shapes, kept separate (they compose and fail differently)

| Shape | Output | Evaluation |
|---|---|---|
| **Eligibility** | `pass` / `fail(decline_reason)` | all-match, **short-circuit** — any failure declines, carrying a human reason |
| **Bound** | a min/max constraint (`{target:'ltv', op:'max', value:60}`) | collect all, take **most restrictive per target**; scenario fails only if the requested value violates the tightened bound |
| **Pricing (LLPA)** | signed `±bp` | **accumulative** (never declines) — they sum |

A max-price cap / min-price floor is itself a bound applied to the **final accumulated price**.

### 6.2 Conditions, hit policy, ordering

- **Condition operators — a small closed set:** `between` (range, the workhorse), `equals`, `in`,
  `not_in`, `gt/gte/lt/lte`, `is_null`. Compound via nested **`all` (AND) / `any` (OR)** groups. Each
  leaf is `{ fact: <scenario field>, operator, value }`; numeric conditions are **half-open `[min,max)`
  ranges**.
- **Hit policy per table:** **Unique/First** for the base-price grid and bounds (exactly one base price;
  a `First`-by-`priority` lets a specific row shadow a general one; a mandatory **default row**
  guarantees a match); **Collect(+)** for LLPAs (gather every match and sum — LLPA stacking). Every rule
  carries an integer `priority` for deterministic ordering.

### 6.3 Versioning, overlays, testability

- **Immutable versioned rule sets** (`rule_set_version`: draft/published/retired + `effective_from`).
  Editing publishes a *new* version; evaluation selects the one version whose interval contains the
  as-of date. Bitemporal (valid + transaction time) for as-of replay.
- **Overlays** concatenate onto the base set (base first, overlays at higher priority), keeping `source`
  on every row so the trace shows *who* imposed each bp or decline. **Restrict-only, enforced.**
- **Testable at publish time (all mandatory):** **no gaps** (the band union tiles the declared domain),
  **no overlaps** (interval-overlap check per dimension + the DB exclusion constraint), type/range
  sanity, and a **saved-scenario regression suite** (`lt_ppe_scenario` rows with expected outcomes, run
  against the whole rule set on every edit). A rule authored once is both **executable and
  explainable** — which is exactly what makes §10's parity diff meaningful.

---

## 7. Rate-sheet ingestion & daily sync

The core principle from the research: **capture-then-decide.** Never mutate the engine from a live
upstream read — every observation becomes an **immutable snapshot**; every engine change becomes an
**effective-dated, audited change record**. Lender Price is a live **oracle**, not a source of writes.

### 7.1 The nightly cycle

**pull** base pricing → **probe** the oracle with a scenario battery (§10.3) → **diff** vs yesterday →
**auto-apply** safe numeric changes under guardrails → **route** rule changes to human review with
evidence → **reconcile** our engine vs the oracle continuously (the parity loop).

### 7.2 Change detection (signal, not noise)

- **Canonicalize before compare:** sort keys, sort arrays by a stable natural key (LLPA rows keyed by
  `(fico_band, ltv_band)`), round prices to fixed bp, coerce enums, strip volatile fields (timestamps,
  request IDs, tokens). **Content-address** each canonical object (`sha256`) → O(1) equality
  short-circuit.
- The ruleset is a **flat map of addressable cells** (`rule_key → canonical_value`, e.g.
  `llpa/dscr/cashout/CA/fico_720_739/ltv_75_80`), never one blob — so a diff is a **keyed set-difference**
  yielding a localized, human-readable change per cell.
- **Version-stamp the canonicalizer** — a canonicalizer change must never masquerade as a data change
  (re-baseline on bump). This is the #1 cure for reviewer fatigue.

### 7.3 Ingestion, storage, reprices

- Upstream = a grid (product × term × rate → price + lock columns). Normalize into
  `(product_id, note_rate, lock_days) → base_price` via a first-class **crosswalk table** (reference
  codes ↔ ours). Validate shape (row/column counts, **monotonicity** — price falls as rate falls,
  within tolerance) → canonicalize → hash.
- **Intraday reprice = a first-class event** (`reprice_seq`), never an overwrite.
- **As-of history via a delta-chain:** a periodic full **baseline** snapshot + daily **deltas** (only
  changed cells); reads reconstruct a day by replaying deltas over the nearest baseline; unchanged
  grids dedupe by hash. Answers "what were our rules on date X" — essential for loan-file defensibility.

### 7.4 Auto-apply vs review (classify by blast radius & reversibility)

- **Auto-apply (safe):** base price/rate refreshes on known products, within bounds. **Guardrails:**
  reject a delta > N bp or > X%, reject on monotonicity failure, reject if too many cells change at once
  (a schema break / bad fetch). Any tripped guardrail escalates.
- **Human review (rule changes):** eligibility flips, new/changed LLPAs, prepay/state/cutoff rules, new
  decline reasons — shown with before/after + **evidence** (the probing scenarios + raw oracle
  responses). Approve → writes an **effective-dated** rule (future dates supported). Reject → records
  reason and **dedupes re-alerting** (`rule_key + after-hash`) until it changes again.
- **Idempotent orchestrator** keyed by `(business_date, stage)`; rate-limit + backoff/jitter; persist
  raw responses immediately; only promote a snapshot to "complete" when the **full battery** succeeded
  (a partial capture diffed against a complete prior day fabricates phantom "removed" changes).

_(Data model to lift directly: `daily_snapshot`, `ruleset_diff`, `proposed_change`, `parity_result` —
as `lt_ppe_*` tables.)_

---

## 8. Locks & secondary market

Downstream of pricing but built on the same engine — an investor can only go live once its **lock
snapshot** reproduces its pricing exactly.

### 8.1 Lock lifecycle & the frozen stack

- **Lock periods** 15/30/45/60 days (longer = worse price). States:
  `floating → lock_requested → locked → {extension, reprice_pending, renegotiation} → expired →
  relocked`; terminal `cancelled/withdrawn`, `purchased`.
- A lock **snapshots and freezes the FULL price build** at the lock instant — base price + itemized
  adjustments + margin components + lock-period adjustment + exceptions — and **hashes it**. Persist:
  `lock_id`, `loan_id`, `locked_at`, `expires_at`, `lock_period`, `channel`, `commitment_type` (BE /
  mandatory), `investor`/`commitment_id`, `product`, `note_rate`, `base_price`, `adjustments[]`,
  `margin`, `lock_period_adj`, `exception_adj`, `net_price`, `SRP`, the eligibility fields that drove
  the adjusters, `rate_sheet_version_id` + effective time, `snapshot_hash`, actor/role. **Extensions and
  relocks APPEND cost-bearing sub-records — never mutate the original snapshot.**

### 8.2 The policies (each a setting)

- **Extension:** per-day debit (~1–2 bp/day, tiered), often capped (e.g. 2 max); weekend/holiday roll
  is free.
- **Worst-case / relock:** `new_price = min(original_locked, current_market)` + a relock fee (~0.25 pt);
  one relock, no further extension after.
- **Renegotiation** (≠ float-down): discretionary on material market improvement (~¼-pt threshold),
  cost passed through, re-snapshot.
- **Reprice-on-change:** a change to any snapshot-driving field (loan amount / LTV / FICO / product /
  occupancy) re-prices under **worst-case**, never silently keeps the old price.

### 8.3 Secondary-market concepts to model (config, feed hedging — don't compute it)

Best-execution across investors (rank all eligible priced results by price or by rate; target-rate vs
target-price query modes); **best-efforts vs mandatory** (mandatory ~10–50 bp better, pair-off on
fallout); **pull-through / fallout** (sizes hedge coverage, drives BE pricing); investor **commitment**
fields on the lock record; **delivery & purchase advice**; **SRP** (finalized at delivery). The
workflow **feeds** hedging (accurate locked position, expirations, pull-through inputs) but need not
compute hedges.

### 8.4 Governance

The **lock desk is a governed role** (LOs request; the desk approves extensions/relocks/renegotiations/
exceptions) with segregation of duties, an immutable audit entry on every transition (actor, role,
before/after, reason, approval), expired-lock disbursement **hard-blocked** by a sweep, and **Reg Z
LO-comp** protection (comp cannot flex with rate/terms; exceptions need reason codes + dual approval).

---

## 9. Lender Price as backend — the "runs together, LP wins" model

This is the heart of the near-term architecture and is fully specified here (not research-dependent).

### 9.1 Two engines, one answer

Every pricing request runs through **both**:

1. **Our PPE** (§3–§8) produces its own eligible/ineligible/priced result.
2. **The Lender Price connector** (`src/longterm/lenderprice/**`, already built) produces Lender
   Price's result.

**What the business sees is Lender Price's answer** — always, until an investor is cleared (§11). Our
result is computed **in parallel** and recorded, but it never overrides Lender Price while that
investor is in shadow mode.

### 9.2 The pricing façade

A single façade endpoint (`POST /api/lt/ppe/price`) hides the two engines behind one contract:

- It calls the LP connector and (in parallel) our engine.
- It returns the **LP result** as the authoritative body, annotated with:
  - `source: "lender_price"` (or `"ppe"` once the investor is live), and
  - `shadow: { agreed: bool, findingId?: string }` so a caller can see whether our engine matched.
- It **fires the comparison** (§10) as a side effect — the response is never blocked waiting on the
  shadow comparison to be stored.
- A **per-investor mode flag** (`shadow` | `live`) decides whether LP or our engine is authoritative
  for that investor's programs. Default `shadow`.

### 9.3 Why both, not just LP

- LP is the truth today, but it is a **third-party dependency**: outages, session/500 issues (already
  hardened), rate limits, and the fact that we don't control its config. Running our engine in shadow
  from day one means that the day an investor is proven, we flip one flag and stop depending on LP for
  that investor — with **weeks of evidence** that we match.
- The shadow record is also the **training/QA signal**: every disagreement is a concrete, reproducible
  defect in our engine, with the exact scenario attached.

### 9.4 Non-negotiables

- Shadow comparison is **best-effort and asynchronous** — it can never slow, break, or change the
  authoritative LP answer.
- We **never** show our engine's answer to the business while an investor is in shadow mode, even if we
  think ours is "more correct." LP wins by rule.
- Disagreements are **not** auto-resolved. Every one goes to a human review queue (§10.4).

---

## 10. Validation strategy — proving every scenario against Lender Price

The owner's explicit requirement: **validate all scenarios — eligible, ineligible, and pricing —
directly against Lender Price, our source of truth.** This section is the QA backbone of the whole
product and is specified in full here.

### 10.1 What "agreement" means (three comparisons, per scenario)

For one scenario, we compare our engine's output to Lender Price's on **three axes**:

1. **Eligibility set** — the set of `(investor, program)` combinations each engine returns as
   **eligible** must match (same programs qualify).
2. **Ineligibility set + reasons** — the set each returns as **ineligible** must match, **and the
   reason text/codes must line up** for the same program (not just the count). Reason parity is graded
   at the canonical-reason level so wording differences don't count as a mismatch, but a *missing* or
   *extra* reason does.
3. **Pricing** — for each commonly-eligible program, the **priced rungs** (note rate → price/points,
   per lock period) must match **within a configurable tolerance** (e.g. price within ±0.001, rate
   exact). Tolerance is a **setting** (Rule #1), per axis.

A scenario **agrees** only if all three axes agree. Anything else is a **finding**.

### 10.2 The parity harness (the core tool)

A dedicated tool — `src/longterm/ppe/shadow/parity.js` (LT) — takes a scenario, runs both engines
(reusing the §9 façade in a "compare" mode that returns *both* raw results), and computes a structured
**diff**:

```
{
  scenario: {...normalized...},
  eligibility: { onlyPPE: [...], onlyLP: [...], both: [...] },
  ineligibility: { onlyPPE: [...], onlyLP: [...], reasonDiffs: [{program, missing:[...], extra:[...]}] },
  pricing:   [{ program, lock, rate, ppePrice, lpPrice, delta, withinTolerance }],
  verdict: "agree" | "disagree",
  axes: { eligibility: bool, ineligibility: bool, pricing: bool }
}
```

The harness runs in two modes:

- **Live shadow** (production): every real pricing request through the façade also runs the harness in
  the background and records a finding on `disagree`.
- **Batch canary** (scheduled + on-demand): a generated scenario matrix (§10.3) is run through the
  harness on a cadence, producing a coverage + agreement report per investor.

### 10.3 Scenario coverage — how we generate the test matrix

"Every scenario" is achieved as **representative coverage**, not an impossible full Cartesian product.
Four layers (adapted from the field-audit's exhaustive strategy):

- **Layer A — one-field goldens.** Start from a baseline scenario; change exactly one field/value at a
  time across every enumerated field and option (purpose, property type, occupancy, citizenship,
  income-doc, prepay, term, lock, reserves, credit events, etc.). Each becomes a stored golden scenario
  with the expected LP behavior captured. This is the backbone — one golden per option.
- **Layer B — numeric boundaries.** For every numeric field: below-min, min, representative, max,
  above-max, and the tier edges (FICO bands, LTV bands, DSCR thresholds, loan-amount conforming/jumbo
  edges). These catch off-by-one band boundaries in LLPAs and eligibility.
- **Layer C — interaction coverage.** Pairwise across all enumerated fields, plus **three-way** for the
  high-risk combos (mortgage-type × purpose × AUS; occupancy × property-type × units; income-doc ×
  self-employed × citizenship; DSCR × rental-term × I/O; prepay-term × prepay-structure × state; term ×
  amortization × lock; adverse-credit × FICO × purpose). Generated by a pairwise/three-way tool, not
  hand-listed.
- **Layer D — live canaries.** A small, curated set run against **live** Lender Price on a schedule
  (15/15 conventional, 30/30 DSCR, each purpose, each prepay incl. None, one guaranteed-ineligible case
  with a known reason, etc.), tracking latency and program/rung counts against a tolerance.

The battery is **anchored at band boundaries + midpoints** (FICO 680/700/720, LTV 70/75/80, DSCR
1.0/1.25 — sampled just inside and just outside each edge, where the LLPA grid and eligibility flip),
generated **pairwise (t-way)** to cover value pairs cheaply, and stored as **versioned declarative
fixtures**, each **tagged with the `rule_key`s it should exercise** so a disagreement traces straight
to the probing scenario. **Boundary/cutoff reverse-engineering** uses a bounded **binary search** along
one axis (hold all else fixed, bisect LTV between eligible/ineligible until the flip point is
localized) to learn an investor's exact cutoff — budgeted, because probing is the most expensive part
(rate-limit + cache).

Each generated scenario is **built once, validated as legal input** (our §26/§27 validators — reject
before any upstream call), then run through both engines.

### 10.3a The continuous reconciliation loop + parity dashboard

Beyond per-request shadow, the full battery is **replayed against our engine** on a cadence and each
output compared to the oracle's captured output for the same day (`lt_ppe_parity_result` rows,
field-level deltas). A **parity dashboard** shows overall parity %, **parity sliced by dimension**
(which states / products / DSCR bands / FICO / LTV drift), and a trend line. An alert fires below
threshold **or when a previously-matching cell regresses** — that regression alarm is what protects an
already-live investor (§11.2 rollback). **Sustained high parity %, sliced, is the primary go-live
confidence metric** (§10.5).

### 10.4 Findings — what a disagreement produces

Every `disagree` verdict creates a **finding** (`lt_ppe_findings`) with:

- the **normalized scenario** and the **exact request payloads** both engines sent (sanitized — no
  credentials/PII),
- the **structured diff** (which axis, which programs, the numeric deltas),
- the **investor(s)** involved (so findings roll up per investor for the cutover scoreboard),
- a **status** (`open` → `triaged` → `fixed` → `verified` / `wontfix`) and a durable **decision** so a
  fixed/dismissed finding never re-opens itself on the next run (same pattern as the RTL finding
  ledger),
- a **first-seen / last-seen** and a **recurrence count**.

Findings feed a **review queue** (§12) where a human reads the disagreement, decides whether our engine
is wrong (fix it) or the finding is a known/acceptable difference (record why), and the fix is
re-validated by re-running the exact scenario.

### 10.5 The per-investor agreement scoreboard

The cutover gate (§11) is driven by a rolling metric per investor:

- **agreement rate** over the trailing window (e.g. % of scenarios that agree on all three axes),
- **consecutive clean days** (days with zero new findings across the canary matrix + live shadow),
- **open finding count** and **finding age**.

An investor becomes eligible for live cutover only when it has **N consecutive clean weeks** (a
setting) with **zero open findings** and the canary matrix at **100% agreement**.

### 10.6 What we deliberately do NOT do

- We never treat "our engine looks more correct" as agreement. LP is truth.
- We never silently truncate a comparison — a scenario the harness couldn't fully compare is recorded
  as `incomparable` with the reason, never as `agree`.
- We never auto-cutover. A human promotes an investor after reading the scoreboard.

---

## 11. Per-investor onboarding & gradual cutover

### 11.1 Investor lifecycle

Each investor (really, each of its programs) moves through explicit modes:

```
draft → shadow → live → (retired)
```

- **draft** — being configured (rate sheets, rules, LLPAs authored); not priced for the business yet.
- **shadow** — priced by BOTH engines; **LP is authoritative**; every request compared; findings
  raised. This is the default and the long-lived state.
- **live** — our engine is authoritative; LP is **no longer called** for that investor's programs (or
  is called only as an occasional spot-check canary, configurable). Reached only via the §10.5 gate +
  a human promotion.
- **retired** — no longer offered.

The mode is **per-investor** (extensible to per-program) so the book cuts over one investor at a time,
never all at once.

### 11.2 Promotion & rollback

- **Promotion** (shadow → live) is a deliberate human action, gated on the scoreboard, recorded with
  who/when/why, and **reversible**.
- **Rollback** (live → shadow) is instant and automatic-capable: if a live investor later diverges from
  a spot-check canary beyond tolerance, it drops back to shadow and raises a finding. Safety first.

### 11.3 The onboarding workflow for a new investor

1. Create the investor (draft).
2. Author its programs, ingest its rate sheets, write its eligibility/ineligibility/pricing/LLPA rules
   (§6) — all from the admin UI (§12), all config, no code.
3. Flip to **shadow**. From here the parity harness + canary matrix accumulate evidence.
4. Work the findings queue until the canary matrix is 100% and the clean-weeks gate is met.
5. Promote to **live**.

---

## 12. Interfaces (the "massive" admin surface)

All V2/PILOT-styled, LT-only, staff-facing. Investor/program/rule authoring is the centerpiece.

- **Investor registry** — a large, searchable list of investors; create/edit; per-investor mode
  (draft/shadow/live) with the agreement scoreboard inline. Built to hold **many** investors.
- **Program manager** — under each investor, several programs; create/clone/version; attach rate
  sheets, LLPAs, rules, guidelines.
- **Rule authoring** — a real editor for eligibility / ineligibility / pricing / LLPA rules: pick a
  scenario field, an operator, a value, an action; see the rule's plain-language rendering; test it
  against sample scenarios inline. Versioned, effective-dated.
- **Rate-sheet console** — upload/import/parse rate sheets; view the rate×price×lock grid; see the
  daily change diff; effective-date and version history.
- **LLPA manager** — build attribute grids (FICO×LTV etc.), stack order, caps/floors — all visual.
- **Settings center** — every configurable knob (Rule #1) with its option set and our pre-filled
  default; per-tenant override; effective dating.
- **Scenario / pricing playground** — enter a scenario, see the priced result, and see the **shadow
  diff vs Lender Price** side by side (eligible/ineligible/pricing, with the exact deltas).
- **Findings review queue** — the disagreements from §10, grouped by investor, with the scenario, the
  diff, and the triage actions (fix / accept-with-reason / re-verify).
- **Agreement scoreboard** — per-investor agreement rate, clean-weeks, open findings; the cutover gate.

_(Front end built on V2/PILOT, `app-v2/src/longterm/**`, rebuilt into the V2 bundle. Investor names and
capital-partner identities stay staff-only — never on any borrower/TPO surface.)_

---

## 13. Multi-tenancy, security, audit, separation

- **Tenancy** — `tenant_id` on every configurable row; all queries scoped; a shared settings-default
  layer seeds a new tenant. One deployment, many lenders.
- **Durable, shared state** — rate sheets, rules, settings, findings, and the pricing/searchKey store
  live in **Postgres** (`lt_ppe_*`), not process memory (fixes the §26.7 single-instance limitation).
- **Audit** — every rule/rate-sheet/setting/mode change and every promotion/rollback is audit-logged
  (who/when/before/after).
- **Secrets** — Lender Price credentials and any investor-feed credentials come from env only; never
  committed, never in a rate-sheet fixture.
- **LT separation** — enforced by the existing product-separation gate; the PPE adds only `lt_*` tables
  and `/api/lt/*` routes; no RTL crossing.

---

## 14. Step-by-step build roadmap

Each phase is shippable and testable on its own. Phases 0–2 are the foundation; 3–5 make it price and
prove; 6–7 make it sellable and let investors go live.

- **Phase 0 — Foundation & separation.** `lt_ppe_*` schema skeleton (tenant, investor, program,
  version/effective-date envelope), the config/settings layer with our defaults as seed data, the
  `/api/lt/ppe/*` router skeleton, and the pricing façade (§9) that today just proxies Lender Price and
  records the shadow slot. Pure tests for the settings layer + separation gate green.
- **Phase 1 — Rate-sheet store + ingestion.** `lt_ppe_rate_sheets` (+ rows), import/parse, versioning,
  effective-dating, change detection (§7). Admin rate-sheet console (read-only first).
- **Phase 2 — Rules engine.** The declarative rule model (§6) for eligibility/ineligibility/pricing/
  LLPA, the evaluator, versioning, and the rule authoring UI (§12). Extensive pure tests (a rule is
  executable AND explainable).
- **Phase 3 — Pricing pipeline.** Base-price lookup → LLPA stack → margin → caps → round → rate/point
  ladder (§5). Our engine now produces a real eligible/ineligible/priced result for a configured
  investor. Pure numeric tests.
- **Phase 4 — Shadow reliability harness.** The parity harness (§10.2), the findings ledger + review
  queue (§10.4), and wiring the façade to compare both engines on every request. LP stays
  authoritative. DB + HTTP tests.
- **Phase 5 — Validation matrix.** Scenario generators (Layers A–D, §10.3), the canary scheduler, and
  the agreement scoreboard (§10.5). Now we can measure per-investor agreement continuously.
- **Phase 6 — Admin interfaces.** The full investor/program/rule/rate-sheet/LLPA/settings/playground/
  findings/scoreboard surface (§12).
- **Phase 7 — Cutover machinery.** Per-investor mode flag end to end, the promotion gate + human
  promote/rollback, and the spot-check canary for live investors (§11).

_Locks & secondary market (§8) slot in after Phase 3 as their own increment; they are needed for
as-of/lock pricing but not for the core shadow-validation loop._

---

## 15. Open decisions for the owner

_(To be finalized; captured here so nothing is silently assumed.)_

- How investors' rate sheets arrive in practice today (PDF, Excel, portal, API) — drives the Phase-1
  ingestion parser priorities.
- The exact agreement tolerances and the clean-weeks threshold for cutover (defaults proposed; owner
  confirms the numbers).
- Whether "live" investors keep a periodic LP spot-check canary on (recommended) or go fully
  independent.
- Which investor to onboard first into shadow mode as the pilot.
