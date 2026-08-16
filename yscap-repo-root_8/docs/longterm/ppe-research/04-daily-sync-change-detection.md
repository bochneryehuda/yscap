<!-- Captured PPE research brief (agent-generated, 2026-08-16). LT-only reference for the MEGA PPE build. Source: docs/longterm/PPE-MEGA-PLAN.md indexes these. -->

# Engineering Brief: Daily Sync + Change-Detection Pipeline for an Internal PPE

## Objective and shape

You are building a sovereign **Product & Pricing Engine (PPE)** while treating **Lender Price** as a live **reference/oracle**. The pipeline runs a nightly cycle: **pull** upstream base pricing, **probe** the reference with a scenario battery, **diff** against yesterday's captured state, **auto-apply** safe changes, **route** rule changes to human review, and **reconcile** our engine against the reference continuously. The design principle throughout is **capture-then-decide**: never mutate the engine directly from a live upstream read. Every upstream observation becomes an immutable **snapshot**; every mutation to our engine flows through an **effective-dated, audited change record**.

## 1. Change-data-capture and diffing

The core problem is separating **signal** (a real rule change) from **noise** (reordering, whitespace, floating-point formatting, timestamp fields, non-deterministic array order). Solve this with aggressive **canonicalization** before any comparison:

- **Normalize** every captured object into a schema-stable form: sort keys, sort arrays by a stable natural key (e.g. LLPA rows keyed by `(fico_band, ltv_band)`), round prices to a fixed precision (basis points), coerce enums, strip volatile fields (`captured_at`, request IDs, session tokens).
- **Content-address** each canonical object with a hash (`sha256` of canonical JSON). Store the hash on the snapshot so a fast top-level equality check short-circuits when nothing changed.
- Represent the ruleset as a **flat map of addressable rule cells** — `rule_key -> canonical_value` — rather than one giant blob. A rule_key encodes the semantic coordinate (e.g. `llpa/dscr/purchase/CA/fico_720_739/ltv_75_80`). Diffing becomes a **keyed set-difference**: keys in today-not-yesterday = **added**, yesterday-not-today = **removed**, present-in-both-with-different-hash = **changed**. This localizes changes and produces a **human-readable diff** naturally.
- Emit each change as a typed record: `{rule_key, change_type, before, after, magnitude}`. For price cells, compute a numeric **delta** and **percent delta**; for eligibility/decline reasons, capture the string/enum transition; for new decline reasons, flag `change_type=added` under the `decline_reason` namespace.

Guard against **false diffs** by running canonicalization identically on both sides and by version-stamping the canonicalizer — a canonicalizer change must not masquerade as a data change, so re-canonicalize the prior snapshot with the new normalizer before diffing, or store the canonicalizer version and force a full re-baseline on bump.

## 2. Rate-sheet and base-price ingestion

Upstream base prices arrive as a **grid** (product × term × rate → price, plus lock-period adjustments). Normalize into our internal **price grid schema**: `(product_id, note_rate, lock_days) -> base_price`, with product identity mapped through a **crosswalk table** from the reference's product codes to ours. Ingestion steps: fetch → validate shape (row/column counts, monotonicity sanity: price should decrease as rate drops, within tolerance) → canonicalize → hash.

**Intraday reprice detection**: rate sheets can reissue mid-day. Poll the reference's sheet identity (its published `effective_timestamp` or sheet version) on a lighter intraday cadence; if the base-grid hash changes versus the last capture, record a new snapshot tagged `reprice_seq` incremented. Treat a reprice as a first-class event, not an overwrite.

**Efficient storage**: keep one **full baseline snapshot** periodically (e.g. weekly) and store intervening days as **deltas** against the prior snapshot (only changed cells). This is a classic **delta-chain**; reads reconstruct a day by replaying deltas over the nearest baseline. Content-addressed hashes let you dedupe unchanged grids entirely — an unchanged day stores only a pointer plus metadata.

## 3. Scenario battery design

You cannot enumerate the full input space, so build a **representative, high-coverage battery**. Use **combinatorial coverage** over the pricing-relevant dimensions: **FICO × LTV × DSCR × loan purpose × state × prepay structure × property type**, plus loan amount and occupancy. Full cartesian product is too large and wastes upstream quota; instead:

- Anchor scenarios at **band boundaries and midpoints**. Rule breaks live at boundaries (FICO 680/700/720, LTV 70/75/80, DSCR 1.0/1.25), so sample *just inside and just outside* each boundary. This gives near-full rule coverage at a fraction of the cost.
- Use **pairwise (t-way) combinatorial** generation to cover all pairs of dimension values with far fewer scenarios than the full grid.
- **Boundary probing / reverse-engineering cutoffs**: to discover a threshold (e.g. max LTV at a given DSCR band), **binary-search** the continuous axis — hold all else fixed, bisect LTV between an eligible and ineligible value until the flip point is localized to your tolerance. This turns opaque eligibility into an explicit learned cutoff you can encode in our engine. Budget these probes; they are the most expensive part.
- Maintain the battery as **versioned, declarative fixtures** so coverage is auditable and reproducible. Tag each scenario with the rule_keys it is expected to exercise, so a diff can be traced to the probing scenario that surfaced it.

## 4. Auto-apply vs. review queue

Classify every detected change by **blast radius and reversibility**:

- **Auto-apply (safe)**: base **price/rate refreshes** on already-known products within sane bounds. These are numeric, reversible, and monotonic-checkable. Gate them with **guardrails**: reject a delta exceeding a threshold (e.g. price move > N bps or > X%), reject if the grid fails monotonicity, reject if too many cells change at once (a signal of a schema break or bad fetch). Anything tripping a guardrail escalates to review.
- **Human review (rule changes)**: eligibility flips, new/changed **LLPAs**, **prepay-penalty** rules, **state rules**, **qualification cutoffs**, new **decline reasons**. These change *behavior*, not just numbers, and can be legally/operationally sensitive.

The **review queue** presents each **proposed_change** with **before/after**, the **evidence** (the scenario(s) and raw reference responses that produced it), and a magnitude summary. A reviewer **approves** or **rejects**; approval **applies-on-approve** by writing an **effective-dated** rule into our engine (future effective dates supported so changes go live on a chosen date). Rejection records a reason and suppresses re-alerting for the identical change (dedupe by rule_key + after-hash) until it changes again.

## 5. Reconciliation and drift monitoring

Separately from upstream diffing, continuously **replay the full scenario battery against our own engine** and compare each output to the reference's captured output for the same day. Each comparison yields a **parity_result** (`match` / `mismatch`, with field-level deltas). Aggregate into a **parity dashboard**: overall parity %, parity by dimension (which states/products/DSCR bands drift most), and a trend line. **Alert** when parity drops below a threshold or when a previously-matching cell regresses. As you approach independence, parity is your primary confidence metric; a sustained high parity % is the signal that you can safely reduce reliance on the reference.

## 6. Automation and scheduling

Drive the cycle with a **scheduled orchestrator** (cron-triggered worker or a DAG in an orchestrator like a workflow engine). Make every stage **idempotent** and keyed by `(business_date, stage)` so a retry re-runs safely and a partial failure resumes rather than restarts. **Rate-limit** upstream probing (token-bucket, bounded concurrency) and use **exponential backoff with jitter** on transient errors. Persist raw responses immediately so a downstream crash never forces a re-probe. **Partial upstream failure** must not corrupt state: only promote a snapshot to "complete" when the full battery succeeded; otherwise mark it `partial` and diff only the covered subset, flagging the gap. **Observability**: log/metric probe latency and error rate, cells changed per day, guardrail rejections, auto-applied vs. queued counts, review-queue depth and age, and parity %.

## 7. Governance

Maintain an **append-only audit trail** of every mutation — auto-applied and human-approved alike — recording who/what, when, before/after, evidence, and effective date. Support **rollback** by re-applying a prior effective-dated version (never destructive deletes). **Effective dating** means our engine can answer "what were our rules on date X," which is essential for loan-file defensibility. Every auto-apply is a governed event too, not an invisible side effect.

## Concrete data model

```
daily_snapshot
  snapshot_id (pk), business_date, source ("lender_price"),
  kind ("price_grid" | "ruleset"), reprice_seq,
  canonicalizer_version, content_hash,
  storage_mode ("baseline" | "delta"), base_snapshot_id (nullable),
  status ("partial" | "complete"), captured_at, raw_blob_ref

ruleset_diff
  diff_id (pk), business_date, from_snapshot_id, to_snapshot_id,
  rule_key, namespace ("price"|"llpa"|"eligibility"|"decline"|"prepay"|"state"|"cutoff"),
  change_type ("added"|"removed"|"changed"),
  before_value (json), after_value (json),
  numeric_delta (nullable), pct_delta (nullable),
  evidence_scenario_ids (json), created_at

proposed_change            -- the review queue
  change_id (pk), diff_id (fk), rule_key, namespace,
  disposition ("safe_auto"|"needs_review"),
  before_value, after_value, magnitude_summary,
  guardrail_flags (json), evidence (json),
  status ("pending"|"approved"|"rejected"|"applied"|"rolled_back"),
  reviewer, decided_at, decision_reason,
  effective_date, applied_at, applied_version_id, created_at

parity_result
  parity_id (pk), business_date, scenario_id,
  reference_snapshot_id, our_engine_version,
  field ("eligibility"|"base_price"|"llpa"|"decline_reason"|...),
  reference_value, our_value,
  status ("match"|"mismatch"), delta (nullable), created_at
```

## Key pitfalls

- **False diffs from noise** — the single biggest source of reviewer fatigue; solved only by disciplined, versioned canonicalization and re-baselining on canonicalizer bumps.
- **Probing cost / rate limits** — an exhaustive battery or naive binary search can exhaust upstream quota or trip abuse controls; bound concurrency, cache, and probe boundaries only.
- **Partial upstream failure** — diffing an incomplete capture against a complete prior day fabricates "removed" changes; gate diffs on completeness and diff only covered subsets.
- **A bad auto-update** — a malformed fetch or off-by-a-factor price can silently poison the engine; guardrails (magnitude caps, monotonicity checks, mass-change caps), effective dating, and one-click rollback are the safety net.
- **Silent semantic drift** — a rule change that produces no numeric delta (e.g. a reworded decline reason mapping to different behavior) can slip past price-focused guardrails; namespace-aware diffing and the parity dashboard catch these.

---

This is a systems-design brief delivered directly as requested (~1,250 words). I did not create any files or modify the repository, and no web research was needed — the request was reasoning-driven and I answered it in full above. If you want, I can turn any section (e.g. the canonicalizer, the delta-chain storage, or the boundary binary-search prober) into concrete implementation code against a specific stack.