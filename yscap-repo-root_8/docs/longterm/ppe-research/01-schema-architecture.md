<!-- Captured PPE research brief (agent-generated, 2026-08-16). LT-only reference for the MEGA PPE build. Source: docs/longterm/PPE-MEGA-PLAN.md indexes these. -->

# Engineering Brief: Database/Schema Architecture for a Mortgage Product & Pricing Engine

You are not starting from scratch. The repo already runs **idempotent, numbered raw-SQL migrations** (`db/NNN_*.sql`, applied by `db/migrate.js`, gated by `scripts/check-migrations.js`) and already contains the seeds of a pricing/rules store: `product_registrations` (append-only quote snapshots with `is_current`), `guideline_documents`/`guideline_versions`/`guideline_rules` (JSONB `scope`/`expression`/`outcome`), `internal_overlays` (with `precedence_tier` + `effective_from/to`), immutable `underwriting_context_snapshots`, `company_pricing_settings.markup_tiers`, and an investor registry. The recommendation below **extends these patterns into a first-class Product & Pricing Engine (PPE)** rather than replacing them. One hard constraint from `AGENTS.md`: the **investor name is internal-only** — schema is fine, but never surface `investor.name` on a borrower/TPO API.

## 1. Core entities & relationships

Model the domain as a **DAG of versioned config** hanging off two long-lived anchors: `investor` and `program`. Everything price-bearing is a **child version** that is effective-dated, never mutated.

```
investor ──< program ──< product ──< rate_sheet(version) ──< base_price_grid
                                  └──< adjustment_rule (LLPA)   (rows)
                                  └──< eligibility_rule
                                  └──< overlay
                          margin_config, lock_period, prepay_option, state_rule ──> program/product
```

- **investor** — the note buyer (stable identity; `investor_alias` handles the "spelled 151 ways" problem).
- **program** — a product family (Standard, Gold, Silver, DSCR, Bridge).
- **product** — a sellable configuration under a program (term, amortization, IO flag).
- **rate_sheet** — the **effective-dated, versioned** container; the unit that ships daily.
- **base_price_grid** — rows of **coupon × price × lock_period** under one rate_sheet.
- **adjustment_rule / LLPA** — additive **basis-point** deltas keyed by band predicates (FICO×LTV, DSCR, occupancy, units, property type, purpose).
- **eligibility_rule** — pass/fail gates (min FICO, max LTV, allowed states).
- **overlay** — YS rules layered over investor rules with explicit **precedence_tier** (reuse your `internal_overlays` model).
- **margin_config, lock_period, prepay_option, state_rule** — dimension/config tables referenced by rules.

## 2. Versioning & effective dating

Use **effective-dated, append-only versioning**, not row-level system-versioning triggers, as the primary model — it matches your existing `guideline_versions` and `product_registrations` and is what a pricing engine actually needs to *replay a quote as of a date*.

- Every rate_sheet and rule-set gets a `rate_sheet_version` row with `effective_from`/`effective_to` (half-open interval `[from, to)`), `status ∈ {draft, pending, published, superseded}`, and a monotonic `version_no`. Publishing a new version **closes** the prior one's `effective_to` — never deletes it.
- A **"current view"** is a thin predicate: `WHERE status='published' AND now() ∈ [effective_from, effective_to)`. History is every other row.
- Add **bitemporality** only where it earns its keep: pricing needs both **valid-time** (which rate sheet was in force that business day) *and* **transaction-time** (when we recorded/corrected it, e.g. a mispriced sheet reissued retroactively). Store `recorded_at`/`recorded_to` alongside `effective_from/to` on the version header — not on every grid row. That gives you "what did we price on the 14th" vs "what did we *believe* on the 14th" for audit and repurchase disputes.
- Avoid **daily-snapshot storage explosion**: don't copy the full grid when nothing changed. Store a **content hash** per version; if an investor's new sheet is byte-identical, point to the same immutable grid rows (dedupe) and only mint a new version header. This is snapshot-per-*change*, not per-*day*.
- **Event sourcing vs snapshot:** full event sourcing is overkill here. Use **immutable snapshots as the source of truth** (append-only versions) plus a lightweight **change-event/audit log** for who/what/when. You get replayability without rebuilding state from a log on every read.

## 3. Money & precision

**Never floats.** Store all money as **integer minor units** and all rate-like quantities as scaled integers, with the scale documented in the column name:

- **Price** `102.850` → `price_bp INTEGER = 102850` (thousandths of a point; 1 point = 1% of par). Store as basis-of-100.
- **Rate** `7.125%` → `rate_bp INTEGER = 71250` (or `numeric(9,6)` if you prefer exact decimal — but be consistent).
- **LLPA** adjustments are already natural **basis points**: `adj_bp INTEGER` (can be negative). Prices sum in integer space, so **no rounding drift** across a stack of adjustments.
- Dollar amounts (`loan_amount_cents BIGINT`). Convert to major units only at the API/UI edge. Your existing `numeric(7,5)`/`numeric(14,2)` columns are acceptable (Postgres `numeric` is exact), but for a *new* engine that sums many adjustments, integer bp is faster, unambiguous, and impossible to misround.

## 4. Config-as-data (JSONB vs normalized)

Your repo already made the right call: **normalized rows for the dimensions you filter/join on, JSONB for the open-ended predicate.** Keep it.

- **Normalize** the hot lookup keys into typed columns with `CHECK`s: `fico_min`, `fico_max`, `ltv_min`, `ltv_max`, `dscr_min`, `dscr_max`, `state`, `occupancy`, `units`, `lock_days`, `adj_bp`. These get B-tree/range indexes and integrity constraints.
- **JSONB** for the long tail: `scope`, `expression`, `outcome`, `meta` (exactly your `guideline_rules` shape). Editable by a UI, versionable, no schema change per new rule kind.
- Index JSONB with **GIN**. For containment-only queries (`@>`) prefer `jsonb_path_ops` — smaller and faster. Understand GIN's cost: every write re-indexes all keys, so keep frequently-filtered keys in real columns and let JSONB hold the rest.
- Validate JSONB at write time (app-layer JSON Schema, or a Postgres `CHECK (jsonb_matches_schema(...))` via `pg_jsonschema`) so the UI can't persist a malformed rule.

## 5. Big-tech patterns to borrow

The consistent lessons from **AWS AppConfig, Azure App Configuration, and feature-flag control planes**: **immutable, sequentially-numbered versions**; **draft → review/approval → staged publish**; **point-in-time immutable snapshots**; **instant revert** by re-pointing to a prior version; and **cryptographically-anchored audit** capturing actor, timestamp, diff, and approval chain. Applied to pricing:

- A published `rate_sheet_version` is **immutable**; a correction is a *new* version, never an in-place edit.
- Gate publish behind an **approval workflow** (you already have `343_pricing_override_approval`). Store `approved_by`, `approved_at`, `approval_status`.
- **Staged rollout:** a `draft`/`pending` version pricing can be shadow-run against live before flipping `status='published'`.
- **Instant rollback** = re-open the prior version's `effective_to`. Cheap because nothing was destroyed.

## 6. Prisma vs raw SQL — recommendation

**Recommendation: keep raw SQL as the single source of truth for schema; do NOT adopt Prisma Migrate. Optionally add Prisma Client in introspection-only mode for typed reads in the pricing subdomain.**

Rationale: your migrations are **idempotent, numbered, CI-gated, and enforce constraints Prisma cannot express** (partial unique indexes like `idx_product_reg_current`, `WITHOUT OVERLAPS` exclusion constraints, trigger functions like `reopen_conditions_on_budget_change`, precedence logic). Prisma Migrate wants ownership of the migration history; running it alongside your ledger creates **two competing sources of truth** and would fight `check-migrations.js`. Prisma introspection also silently drops constructs it can't model (exclusion constraints, partial indexes, custom triggers) — dangerous for **military-grade** pricing integrity.

They **can coexist** safely if scoped: run `prisma db pull` (introspect) to generate a **read-only, typed Prisma Client** over the pricing tables for application code, and keep **all DDL in numbered SQL**. Re-introspect after each migration. This gives the owner the "massive Prisma schema" as a **generated type layer / documentation artifact**, without ceding schema authority. Do not use `prisma migrate dev` against this database.

## 7. Performance

- **Composite/range indexes** on the LLPA hot path: `(rate_sheet_version_id, fico_min, fico_max, ltv_min, ltv_max)`; a **GiST index** over integer ranges enables true band containment. Model bands as `int4range`/`numrange` and query with `@>`.
- **Partition** `base_price_grid` and `adjustment_rule` **by `rate_sheet_version_id`** (or list-partition by investor) so a quote scans only the active version's rows.
- **Cache the current published ruleset** in-process, keyed by `(investor, program, effective_date)` and invalidated on publish — pricing reads vastly outnumber writes.

## 8. Integrity & governance

This is where "strong from the ground up" is won:

- **No overlapping bands:** Postgres **exclusion constraints** — `EXCLUDE USING gist (rate_sheet_version_id WITH =, fico_range WITH &&, ltv_range WITH &&)` — make overlapping FICO×LTV cells *impossible to insert*.
- **No gaps / valid ranges:** `CHECK (fico_min <= fico_max)`, `CHECK (ltv_min >= 0 AND ltv_max <= 100000)`; enforce coverage with a validation query run at publish that asserts the band grid tiles the domain.
- **No overlapping effective periods** per version chain: `EXCLUDE USING gist (product_id WITH =, tstzrange(effective_from, effective_to) WITH &&) WHERE (status='published')`.
- **Audit columns** everywhere (`created_by`, `created_at`, `approved_by`, `approved_at`, `source_hash`) plus a **row-level change log** (append-only `pricing_audit`). PG18's temporal PK/FK (`WITHOUT OVERLAPS`, `PERIOD`) can enforce this declaratively if available.

## Recommended DDL sketch

```sql
CREATE TABLE investor (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL, name text NOT NULL,   -- name = internal-only
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE program (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investor_id uuid REFERENCES investor(id),          -- NULL = base YS program
  code text NOT NULL, name text NOT NULL,
  UNIQUE (investor_id, code));

CREATE TABLE rate_sheet_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id uuid NOT NULL REFERENCES program(id),
  version_no int NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending','published','superseded')),
  effective_from timestamptz NOT NULL,
  effective_to   timestamptz,                          -- NULL = open/current
  recorded_at    timestamptz NOT NULL DEFAULT now(),   -- transaction-time
  content_hash   text NOT NULL,                         -- dedupe identical sheets
  approved_by uuid REFERENCES staff_users(id),
  approved_at timestamptz,
  created_by  uuid REFERENCES staff_users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program_id, version_no),
  EXCLUDE USING gist (program_id WITH =,
    tstzrange(effective_from, coalesce(effective_to,'infinity')) WITH &&)
    WHERE (status = 'published'));

CREATE TABLE base_price_grid (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rate_sheet_version_id uuid NOT NULL REFERENCES rate_sheet_version(id),
  coupon_bp int NOT NULL,          -- 7.125% -> 71250
  lock_days int NOT NULL,          -- 15/30/45/60
  price_bp  int NOT NULL,          -- 102.850 -> 102850
  UNIQUE (rate_sheet_version_id, coupon_bp, lock_days))
  PARTITION BY LIST (rate_sheet_version_id);

CREATE TABLE adjustment_rule (        -- LLPA grid
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rate_sheet_version_id uuid NOT NULL REFERENCES rate_sheet_version(id),
  dimension text NOT NULL,             -- 'fico_ltv','dscr','occupancy',...
  fico_range numrange, ltv_range numrange, dscr_range numrange,
  predicate jsonb NOT NULL DEFAULT '{}',    -- open-ended extra conditions
  adj_bp int NOT NULL,                       -- signed price delta
  cumulative boolean NOT NULL DEFAULT true,
  EXCLUDE USING gist (rate_sheet_version_id WITH =, dimension WITH =,
    fico_range WITH &&, ltv_range WITH &&));

CREATE TABLE eligibility_rule (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rate_sheet_version_id uuid NOT NULL REFERENCES rate_sheet_version(id),
  rule_key text NOT NULL, scope jsonb NOT NULL DEFAULT '{}',
  expression jsonb NOT NULL, outcome jsonb NOT NULL,
  materiality text NOT NULL DEFAULT 'hard_stop');
CREATE INDEX ON eligibility_rule USING gin (expression jsonb_path_ops);
```

## Pitfalls specific to versioned pricing data

- **Never mutate a published version** — a "quick fix" that edits a live grid retroactively silently changes every past quote. Always mint a new version.
- **Half-open intervals** `[from, to)` prevent the midnight double-count where two versions both claim an instant.
- **Pin the version at quote time.** A registered quote must store `rate_sheet_version_id` (as your `product_registrations`/`underwriting_context_snapshots` already do) so a later sheet never silently reprices a locked loan.
- **Timezone the lock cutoff** — rate-sheet effectivity is business-day/lock-desk bound; store `timestamptz` and pin the desk timezone, never bare `date`.
- **Coverage gaps** are as dangerous as overlaps — a missing FICO×LTV cell makes a loan unpriceable; validate tiling at publish.
- **JSONB drift** — without write-time validation the UI will eventually persist a rule shape the engine can't read.

**Sources:** [PostgreSQL 19 Temporal Tables](https://www.postgresql.org/docs/19/ddl-temporal-tables.html) · [Understanding Bitemporal Primary Keys](https://lord.technology/2025/01/28/understanding-temporal-primary-keys.html) · [Modern Treasury — Floats Don't Work for Cents](https://www.moderntreasury.com/journal/floats-dont-work-for-storing-cents) · [Crunchy Data — Indexing JSONB in Postgres](https://www.crunchydata.com/blog/indexing-jsonb-in-postgres) · [pganalyze — Postgres GIN Indexes](https://pganalyze.com/blog/gin-index) · [Prisma — Introspection](https://www.prisma.io/docs/orm/prisma-schema/introspection) · [Prisma — Add to Existing Project](https://www.prisma.io/docs/prisma-orm/add-to-existing-project/prisma-postgres) · [InfoQ — Configuration as a Control Plane](https://www.infoq.com/articles/configuration-control-plane/) · [AWS AppConfig Feature Flags](https://aws.amazon.com/blogs/dotnet/safely-roll-out-changes-in-net-with-aws-appconfig-feature-flags/) · [Fannie Mae LLPA Matrix](https://singlefamily.fanniemae.com/media/9391/display)

---

Key finding worth flagging to the owner: the repo **already has 80% of the right architecture** (append-only versions, JSONB rule pattern, precedence overlays, immutable decision snapshots, approval gates). The engineering move is to extend those patterns into typed `rate_sheet_version` / `base_price_grid` / `adjustment_rule` tables with **exclusion constraints** for band integrity — not to bolt on Prisma Migrate, which would collide with the CI-gated numbered-SQL ledger. Relevant existing files: `/home/user/yscap/yscap-repo-root_8/db/025_product_registration.sql`, `/home/user/yscap/yscap-repo-root_8/db/259_guideline_overlays.sql`, `/home/user/yscap/yscap-repo-root_8/db/260_seed_program_rules.sql`, `/home/user/yscap/yscap-repo-root_8/db/466_pricing_markup_tiers.sql`, and the migration runner/gate `/home/user/yscap/yscap-repo-root_8/db/migrate.js` + `/home/user/yscap/yscap-repo-root_8/scripts/check-migrations.js`.