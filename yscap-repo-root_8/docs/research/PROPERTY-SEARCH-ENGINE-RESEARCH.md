# PROPERTY / COMPARABLE-SALES SEARCH ENGINE — RESEARCH

**Scope.** How to build an MLS/RPR-shaped faceted search over `properties` /
`property_observations` / `property_sales` (db/406) in **plain Postgres**, with
only `express`, `pg`, `pdf-lib`, `unpdf` available. No PostGIS. No Elasticsearch.
No new npm packages. No extension beyond `pgcrypto` may be *assumed* (the
production database is a managed Render Postgres), and every migration is a new
numbered idempotent `db/NNN_*.sql`.

Everything below is written to drop into this codebase: the SQL matches the real
column names in `db/406_property_research_database.sql`, and the JS matches the
house `pg` style already used by `buildPipelineFilter` in `src/routes/staff.js`
(`const add = (val) => { params.push(val); return '$' + params.length; }`).

---

## 0. What we are searching, and the three shapes of the question

| Table | Grain | What it answers |
|---|---|---|
| `properties` | one row per deduped address | "find me houses like this" — **this is the search table** |
| `property_observations` | one row per (report × property × role) | "what did THAT appraiser say" — the ledger; source of `comp_set` (`arv` / `as_is` / `unknown`) and of per-report facts |
| `property_sales` | one row per distinct transaction | "how many times has it traded" — sale *history* filters |

Three different question shapes fall out of that, and they want three different
query strategies. Do not try to serve all three with one query builder:

1. **Browse / filter** — "3-bed 2-bath in Paterson NJ, $300k–$450k, closed in the
   last 9 months, 1,200–1,700 sqft." Faceted, paginated, sorted by a column.
   → §1–§3.
2. **Geographic** — "everything within 1.5 miles of 26 S 10th St." → §4.
3. **Comparable selection** — "the 6 best comps for THIS subject." Ranked, small
   result set, must explain itself. → §5.

The roll-up columns on `properties` are the *most recent report that stated each
fact*. That matters for search honesty: a filter on `gla` is filtering on "what
the last appraiser said the square footage was," not on a public record. The UI
must say so (§6), and the ranking must degrade when a fact is missing rather than
pretend it is zero (§5.4).

---

## 1. QUERY DESIGN — faceted range filters in plain Postgres

### 1.1 The filter inventory

| Filter | Column | Shape |
|---|---|---|
| city / state / zip | `state`, `city`, `zip` | equality (city case-insensitive) |
| price | `last_sale_price` | range |
| sale date | `last_sale_date` | range |
| beds | `beds` | range |
| baths | `baths_full`, `baths_half` | range on a derived total |
| sqft | `gla` | range |
| year built | `year_built` | range |
| lot | `lot_area` | **text today — see §1.6** |
| units | `units` | range |
| condition (UAD) | `condition_uad` | **ordinal range — see §1.2** |
| quality (UAD) | `quality_uad` | **ordinal range — see §1.2** |
| property type | `property_type` / `property_category` | set membership |
| used as ARV vs As-Is comp | `property_observations.comp_set` | EXISTS semi-join |
| free-text address | `display_address` | prefix / token — see §1.5 |

### 1.2 UAD condition and quality are ORDINAL — store a rank, not a string

C1…C6 and Q1…Q6 are ordered scales where **1 is best and 6 is worst**
(C1 = new/no deterioration, C6 = substantial damage; Q1 = highest quality
construction, Q6 = lowest). Three things go wrong if you leave them as `text`:

1. **Range filtering is a string range.** `condition_uad BETWEEN 'C1' AND 'C3'`
   happens to work *only* while every stored value is exactly two uppercase
   characters. The parser feeding this warehouse reads MISMO/UAD from four
   vendors; the real column will eventually hold `'C3'`, `'c3'`, `'C03'`,
   `'C3;C4'`, `'C4 '` and `NULL`. Every one of those silently drops out of, or
   into, a lexicographic range.
2. **The direction is inverted relative to every other filter.** "At least C4"
   means `rank <= 4`. A UI slider labelled "min condition" that emits
   `>= 'C4'` returns *worse* houses. This is the single most common bug in this
   feature; naming the column `_rank` and keeping the inversion in exactly one
   place is the fix.
3. **Ranking arithmetic** (§5) needs a number to take a delta against.

Store a derived **generated column**. It is idempotent, it can never drift from
the text (Postgres computes it on every write), and the ingest does not have to
know about it:

```sql
-- db/NNN_property_search_ordinals.sql  (additive + idempotent)

-- The UAD rating rank: 1 = best, 6 = worst, NULL = the report never stated it.
-- Generated (not a trigger, not application code) so it can NEVER disagree with
-- the text column, on any write path present or future. Reads the FIRST rating
-- token only: a report that states "C3;C4" is telling us the better of the two
-- was observed somewhere, and taking the first token is the reading the appraisal
-- desk already uses. Anything unparseable → NULL (never a guessed 3).
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS condition_rank smallint
  GENERATED ALWAYS AS (
    CASE upper(substring(btrim(condition_uad) from '^[Cc][0-9]'))
      WHEN 'C1' THEN 1 WHEN 'C2' THEN 2 WHEN 'C3' THEN 3
      WHEN 'C4' THEN 4 WHEN 'C5' THEN 5 WHEN 'C6' THEN 6
    END
  ) STORED;

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS quality_rank smallint
  GENERATED ALWAYS AS (
    CASE upper(substring(btrim(quality_uad) from '^[Qq][0-9]'))
      WHEN 'Q1' THEN 1 WHEN 'Q2' THEN 2 WHEN 'Q3' THEN 3
      WHEN 'Q4' THEN 4 WHEN 'Q5' THEN 5 WHEN 'Q6' THEN 6
    END
  ) STORED;

-- Only the rated rows are ever range-filtered, so the index is partial and small.
CREATE INDEX IF NOT EXISTS idx_properties_condition_rank
  ON properties(condition_rank) WHERE condition_rank IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_properties_quality_rank
  ON properties(quality_rank) WHERE quality_rank IS NOT NULL;
```

Do the same on `property_observations` if you ever want "reports that rated it
C3 or better" as opposed to "its current roll-up is C3 or better."

**Why not an `ENUM` type?** `CREATE TYPE uad_condition AS ENUM ('C1',…,'C6')`
gives you ordering and btree indexing for free and is arguably the "right"
relational modelling. It is rejected here for three practical reasons: (a) the
source data is dirty and an enum column *refuses* the write rather than
degrading to NULL, which would break a best-effort fire-and-forget ingest;
(b) `ALTER TYPE … ADD VALUE` cannot run inside a transaction block in older
versions, which fights the "every migration is one idempotent file" rule;
(c) the scoring function (§5) wants integer arithmetic, and casting an enum to
an ordinal in SQL is `array_position(enum_range(NULL::uad_condition), x)` — worse
than a smallint in every way.

**The one place the inversion lives** (server-side, shared by the filter builder
and the scorer):

```js
// src/lib/research/uad.js
'use strict';
/** UAD ratings are ordinal and INVERTED: C1/Q1 is the BEST, C6/Q6 the worst.
 *  Every surface that talks about "min condition" means "no worse than X",
 *  which is rank <= X. This is the ONLY place that inversion is written down. */
const RANK_RE = /^[CQ]([1-6])$/i;

/** 'C3' -> 3 ; 'c3' -> 3 ; 'C03'/'junk'/'' -> null (never a guessed middle). */
function ratingRank(v) {
  const m = RANK_RE.exec(String(v == null ? '' : v).trim());
  return m ? Number(m[1]) : null;
}
/** The UI's {best:'C1', worst:'C4'} -> {minRank:1, maxRank:4}. */
function ratingRange(best, worst) {
  return { minRank: ratingRank(best), maxRank: ratingRank(worst) };
}
module.exports = { ratingRank, ratingRange, RANK_RE };
```

### 1.3 Index strategy

**The governing fact: with 14 optional filters there are 2^14 possible WHERE
shapes. You cannot build a composite index per shape.** So the index set is
deliberately two-tier:

**Tier 1 — a small number of hand-picked composites for the *hot paths*.**
A composite index is worth its maintenance cost only when a *known, frequent*
query uses its leading columns as equalities and (ideally) its trailing column
as the sort. In this product there are exactly two such paths:

```sql
-- HOT PATH 1: "everything in this city, newest sale first" — the default screen.
-- Column order is the rule: EQUALITY columns first, then the ORDER BY column.
-- lower(city) because the UI searches case-insensitively (functional index is
-- what makes that sargable — a plain index on city cannot serve lower(city)=…).
CREATE INDEX IF NOT EXISTS idx_props_city_saledate
  ON properties(state, lower(city), last_sale_date DESC NULLS LAST);

-- HOT PATH 2: same, keyed on ZIP (the comp-search entry point).
CREATE INDEX IF NOT EXISTS idx_props_zip_saledate
  ON properties(zip, last_sale_date DESC NULLS LAST)
  WHERE zip IS NOT NULL;
```

**Tier 2 — one single-column btree per range filter, and let the planner
BitmapAnd them.** These already exist in db/406 (`idx_properties_beds`,
`_gla`, `_year_built`, `_sale_price`, `_sale_date`); add the missing ones:

```sql
CREATE INDEX IF NOT EXISTS idx_properties_units      ON properties(units)        WHERE units IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_properties_type       ON properties(property_type) WHERE property_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_properties_baths_full ON properties(baths_full)   WHERE baths_full IS NOT NULL;
```

**Make the range indexes PARTIAL.** A comparable search is only ever interested
in properties that have actually *sold*, and roughly half of a comp warehouse's
rows are subjects and no-sale observations. A partial index is both smaller and
a stronger planner signal:

```sql
-- The comp-search index: only rows that can BE a comp.
CREATE INDEX IF NOT EXISTS idx_props_sold_price
  ON properties(last_sale_price)
  WHERE last_sale_date IS NOT NULL AND last_sale_price IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_props_sold_date
  ON properties(last_sale_date DESC)
  WHERE last_sale_date IS NOT NULL AND last_sale_price IS NOT NULL;
```

For the planner to *use* a partial index, the query must contain a predicate the
planner can prove implies the index predicate. So the search builder must
**always** emit `AND p.last_sale_date IS NOT NULL AND p.last_sale_price IS NOT NULL`
when the caller asked for sold-only (which the comp screen always does). Emitting
it unconditionally is wrong — it would hide un-sold properties from the general
browse — so it is a mode flag, not a constant.

**Covering / `INCLUDE`.** An index-only scan avoids the heap entirely, which is
the difference between 3 random page reads per row and 0. Worth it on exactly one
index — the default list view:

```sql
CREATE INDEX IF NOT EXISTS idx_props_list_cover
  ON properties(state, lower(city), last_sale_date DESC NULLS LAST)
  INCLUDE (id, display_address, beds, baths_full, baths_half, gla,
           year_built, last_sale_price, property_type);
```

Two caveats that make or break this: (a) an index-only scan still consults the
**visibility map**, so after the big back-fill ingest you must
`VACUUM ANALYZE properties;` or every "index-only" scan degrades to a heap fetch
per row; (b) `INCLUDE` columns are *payload*, not searchable — putting `beds` in
`INCLUDE` does not let the index filter on beds. Keep `INCLUDE` to display
columns only, and keep it short (every included byte is copied into every index
tuple, and this index is on the hottest write path in the warehouse).

### 1.4 When a BitmapAnd of single-column indexes beats a composite

Postgres can scan several indexes, build an in-memory bitmap of matching heap
pages/tuples from each, `AND` them, and then fetch only the surviving heap pages.
The mechanics decide the rule:

* **BitmapAnd wins when** each predicate is *individually* weak (say each keeps
  5–30% of the table) but their conjunction is strong (< 1%), **and** the set of
  predicates varies from query to query. Cost ≈ (sum of the index scans) +
  (heap fetches for the surviving rows). Three indexes each returning 40k of a
  500k-row table, intersecting to 900 rows, reads three index ranges and ~900
  heap tuples. A seq scan reads all 500k.
* **A composite wins when** the leading columns are equalities that *every* query
  in that path supplies, and especially when the composite also supplies the sort
  order (a `LIMIT 50` over an already-ordered index reads 50 rows; a bitmap scan
  must materialise and sort the *entire* matching set first). This is why hot
  paths 1 and 2 above exist and nothing else does.
* **BitmapAnd loses when** the bitmap exceeds `work_mem` and goes **lossy** —
  it degrades from per-tuple to per-*page* granularity and every candidate page
  must be re-checked with `Recheck Cond`. You see this in `EXPLAIN (ANALYZE)` as
  `Heap Blocks: exact=… lossy=…`. A non-zero `lossy` on a search that should be
  selective means either the filters are too weak to be worth indexing, or
  `work_mem` is too low for this workload.
* **BitmapAnd is useless for the ORDER BY.** It never returns sorted output. Any
  query that bitmap-scans and then sorts pays for the whole result set even for
  page 1. That is the strongest single argument for the keyset design in §2 and
  for keeping the two composites.

Practical rule for this codebase: **two composites for the two hot paths, one
partial single-column btree per range filter, and stop.** Adding a third
composite is almost always a mistake — verify with `EXPLAIN (ANALYZE, BUFFERS)`
on real data before adding one, and delete any index that
`pg_stat_user_indexes.idx_scan` shows at zero after a month.

### 1.5 Free-text address search — why leading-wildcard ILIKE kills the index, and what to do without `pg_trgm`

**The mechanism.** A btree index stores keys in sorted order. `LIKE 'abc%'` is a
*range* scan (`>= 'abc' AND < 'abd'`) — indexable. `ILIKE '%abc%'` has no
leading anchor, so there is no range to seek to; every key must be examined,
which is a full index scan at best and a seq scan in practice. Two extra traps
specific to this repo:

* **`ILIKE` is not `LIKE`.** Even `ILIKE 'abc%'` cannot use a plain btree,
  because the index is ordered by the *collation of the stored value*, not of
  its lowercase form. db/406 already does the right thing:
  `CREATE INDEX idx_properties_addr_lower ON properties(lower(display_address) text_pattern_ops)`.
  You must then query `lower(display_address) LIKE lower($1) || '%'` — **`LIKE`,
  on `lower(...)`**, never `ILIKE`.
* **`text_pattern_ops` is required** for pattern matching under any non-C
  collation. Without it, `LIKE 'abc%'` still will not use the index on a
  `en_US.UTF-8` database.

**The four extension-free workarounds, in the order you should reach for them:**

**(a) Prefix search on a normalised key — the 80% answer.** Address search is
overwhelmingly "start typing the street number and street." Anchor it:

```sql
-- fast: uses idx_properties_addr_lower
WHERE lower(p.display_address) LIKE lower($1) || '%'
```

**(b) Core full-text search — no extension needed.** `tsvector`, `tsquery`,
`to_tsvector` and **GIN indexes on tsvector are all core Postgres**, unlike
`pg_trgm`. This is the workaround most teams miss. It gives you word-order-free,
multi-token AND matching *and* per-word prefix matching:

```sql
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS address_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple',
      coalesce(display_address,'') || ' ' ||
      coalesce(city,'')  || ' ' || coalesce(state,'') || ' ' ||
      coalesce(zip,'')   || ' ' || coalesce(county,'') || ' ' ||
      coalesce(apn,''))
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_properties_address_tsv
  ON properties USING GIN (address_tsv);
```

Use the `'simple'` configuration, **not** `'english'`: an address is not prose,
and the English stemmer will happily turn "Manning" into "man" and stopword away
"A" in "Apt A". `simple` lowercases and splits on non-word characters, which is
exactly what an address needs.

Query it with per-token prefix matching, built server-side (never interpolated):

```js
/** "26 s 10th piscat" -> tsquery '26:* & s:* & 10th:* & piscat:*'
 *  Tokens are stripped to [a-z0-9] so nothing a user types can be tsquery
 *  syntax (&, |, !, parentheses, ':'), which is why this is safe to bind. */
function addressTsQuery(raw) {
  const toks = String(raw || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0)
    .slice(0, 8);                       // bound the work: 8 tokens is plenty
  if (!toks.length) return null;
  return toks.map((t) => t + ':*').join(' & ');
}
```

```sql
WHERE p.address_tsv @@ to_tsquery('simple', $1)
```

This answers "10th st piscataway", "piscataway 10th", "08854 10th" and
"26 s 10th st #2" identically — which plain `LIKE` cannot do at all — and it is
a GIN index lookup, not a scan.

**(c) Reverse-string btree for suffix search.** If you genuinely need
`'%Avenue'`:

```sql
CREATE INDEX IF NOT EXISTS idx_properties_addr_rev
  ON properties(reverse(lower(display_address)) text_pattern_ops);
-- query:  WHERE reverse(lower(display_address)) LIKE reverse(lower($1)) || '%'
```

**(d) `pg_trgm` if — and only if — it turns out to be available.** True infix
and fuzzy matching ("shington", "Piscatway") needs trigrams. You may not
*assume* it, but you can *attempt* it idempotently and fall through:

```sql
-- OPTIONAL ACCELERATION. pg_trgm is contrib, not core, and this database is a
-- managed Render Postgres — so the migration must survive its absence.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_trgm unavailable (%) — address search falls back to FTS + prefix', SQLERRM;
  END;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_properties_addr_trgm
               ON properties USING GIN (lower(display_address) gin_trgm_ops)';
  END IF;
END $$;
```

The application then *probes once at boot* and records the capability, so the
query builder emits the fuzzy branch only when it is real:

```js
// src/lib/research/search-caps.js
let caps = null;
async function searchCaps(db) {
  if (caps) return caps;
  try {
    const r = await db.query(`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_trgm') AS trgm`);
    caps = { trgm: !!(r.rows[0] && r.rows[0].trgm) };
  } catch { caps = { trgm: false }; }   // fail toward the portable path
  return caps;
}
```

**What NEVER to ship:** a bare `display_address ILIKE '%' || $1 || '%'` with no
minimum length. On a 500k-row warehouse a one-character query returns and sorts
essentially the whole table. See §7.4 for the guard.

### 1.6 The two columns that need a shape change before they can be filtered

* **`lot_area text`** — stored as the appraiser wrote it: `"7,405 sf"`,
  `"0.17 ac"`, `"50x100"`, `"6534 Square Feet"`. A range filter on that is not
  possible. Add a derived numeric alongside it (never *replace* the text — the
  ledger records what the report said):

```sql
ALTER TABLE properties ADD COLUMN IF NOT EXISTS lot_sqft numeric(12,2);
CREATE INDEX IF NOT EXISTS idx_properties_lot_sqft
  ON properties(lot_sqft) WHERE lot_sqft IS NOT NULL;
```

  Fill it from a **pure JS parser** in the ingest (acres × 43,560; `AxB` →
  `A*B`; bare numbers over 1,000 assumed square feet, under 100 assumed acres,
  and anything in between left **NULL** rather than guessed). Do the parsing in
  JS, not in a PL/pgSQL generated column: a SQL twin of a JS parser drifts, and
  this repo has already been bitten by that class (`pilot_term_norm` /
  `pilot_property_type_norm`).

* **Baths.** `baths_full` and `baths_half` are separate. Users think in "2.5
  baths". Filter on a generated total so the index is on the thing being
  compared:

```sql
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS baths_total numeric(4,1)
  GENERATED ALWAYS AS (
    CASE WHEN baths_full IS NULL AND baths_half IS NULL THEN NULL
         ELSE coalesce(baths_full,0) + 0.5 * coalesce(baths_half,0) END
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_properties_baths_total
  ON properties(baths_total) WHERE baths_total IS NOT NULL;
```

  Note the `CASE`: `coalesce(NULL,0)+0.5*coalesce(NULL,0)` is `0`, and a house
  with unknown baths must not filter in as a 0-bath house.

### 1.7 "Used as an ARV comp vs an As-Is comp"

That fact lives on `property_observations.comp_set` (`'arv'` / `'as_is'` /
`'unknown'`, produced by `src/lib/appraisal/comp-grid.js`). It is a
one-to-many, so it is a **semi-join**, and `EXISTS` is the right operator —
never a `JOIN` (which would multiply the property row by its observation count
and silently inflate every facet count and every `LIMIT`):

```sql
-- filter: "has ever been used as an ARV comparable"
AND EXISTS (
      SELECT 1 FROM property_observations o
       WHERE o.property_id = p.id
         AND o.role = 'comparable'
         AND o.comp_set = $n)
```

`idx_prop_obs_property` already exists, but the semi-join wants the
discriminators in the index or it degrades to a heap fetch per candidate:

```sql
CREATE INDEX IF NOT EXISTS idx_prop_obs_property_set
  ON property_observations(property_id, comp_set)
  WHERE role = 'comparable';
```

If this filter turns out to be used on nearly every comp search (likely), the
cheaper design is to **denormalise two counters onto `properties`**, maintained
by the same ingest that already maintains `comp_count`:

```sql
ALTER TABLE properties ADD COLUMN IF NOT EXISTS arv_comp_count   integer NOT NULL DEFAULT 0;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS as_is_comp_count integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_properties_arv_comp   ON properties(arv_comp_count)   WHERE arv_comp_count   > 0;
CREATE INDEX IF NOT EXISTS idx_properties_as_is_comp ON properties(as_is_comp_count) WHERE as_is_comp_count > 0;
```

…which turns the filter into `AND p.arv_comp_count > 0` — a partial-index
lookup instead of a semi-join, and it can participate in a BitmapAnd with the
other filters. Back-fill it in the same migration from the observations table so
previous *and* future rows agree:

```sql
UPDATE properties p SET
  arv_comp_count   = c.arv,
  as_is_comp_count = c.as_is
FROM (
  SELECT property_id,
         count(*) FILTER (WHERE comp_set = 'arv')   ::int AS arv,
         count(*) FILTER (WHERE comp_set = 'as_is') ::int AS as_is
    FROM property_observations WHERE role = 'comparable' GROUP BY property_id) c
WHERE c.property_id = p.id
  AND (p.arv_comp_count, p.as_is_comp_count) IS DISTINCT FROM (c.arv, c.as_is);
```

(The `IS DISTINCT FROM` guard makes the statement a no-op on re-run — required,
because migrations here run on every boot.)

### 1.8 The `($1 IS NULL OR col = $1)` planner trap — what is actually true

This is the classic "one query, all filters optional" shortcut:

```sql
-- DO NOT SHIP THIS
SELECT * FROM properties p
 WHERE ($1::text    IS NULL OR p.state = $1)
   AND ($2::text    IS NULL OR lower(p.city) = lower($2))
   AND ($3::numeric IS NULL OR p.last_sale_price >= $3)
   AND ($4::numeric IS NULL OR p.last_sale_price <= $4)
   ... 20 more ...
```

**The folklore is "it always seq-scans." The truth is worse: it depends on
whether Postgres chose a *custom* plan or a *generic* plan, and that changes
under you at runtime.** Getting this exactly right matters, because the failure
mode is intermittent:

* **Custom plan.** When Postgres plans with the actual bind values available, it
  passes them to `eval_const_expressions`, which substitutes the `Param` nodes
  with `Const`s. `'NJ' IS NULL` folds to `false`, `false OR p.state = 'NJ'` folds
  to `p.state = 'NJ'`, and you get a perfectly good index plan. `node-postgres`
  sends *unnamed* prepared statements by default, and unnamed statements are
  planned at Bind time with the values in hand — so in the common case **this
  pattern appears to work**, which is exactly why it survives code review.
* **Generic plan.** The moment the statement gets a *name* — you pass `name:` to
  `client.query`, or an ORM/pooler caches it — Postgres builds a custom plan for
  the first five executions, then compares the average custom-plan cost against
  the generic-plan cost and, if the generic is not worse, **switches to it
  permanently**. In a generic plan the parameters are unknown, nothing folds, and
  every one of those 24 `OR` expressions becomes a non-indexable `Filter`. The
  result is a `Seq Scan` on `properties` with 24 filter expressions evaluated per
  row — and it happens on the *sixth* call, in production, on a query that
  passed every test.
* **The estimates are garbage even before the plan is.** In a generic plan,
  `nulltestsel()` on a non-`Var` returns the `DEFAULT_UNK_SEL` constant of
  **0.005**, and `p.state = $1` gets `1/n_distinct`. The `OR` selectivity is
  `s1 + s2 − s1·s2`. With ~40 states that is `0.005 + 0.025 − 0.000125 ≈ 0.0299`
  per clause. Multiply twelve of them together (the planner assumes
  independence): `0.0299^12 ≈ 5×10⁻¹⁹`. On 500k rows the planner estimates **1
  row** and picks a plan tuned for one row — typically a nested loop against
  `property_observations` — which then executes 40,000 times. That is the
  1000× blow-up, and it is a *plan-shape* catastrophe, not just a seq scan.

**Reproduce it deterministically before you argue about it** (this is the single
most useful diagnostic in this whole document):

```sql
SET plan_cache_mode = force_generic_plan;   -- PG12+
PREPARE s(text, text, numeric) AS
  SELECT count(*) FROM properties p
   WHERE ($1 IS NULL OR p.state = $1)
     AND ($2 IS NULL OR lower(p.city) = lower($2))
     AND ($3 IS NULL OR p.last_sale_price >= $3);
EXPLAIN (ANALYZE, BUFFERS) EXECUTE s('NJ','Paterson',300000);
RESET plan_cache_mode;
```

You will see `Seq Scan on properties … Filter: (($1 IS NULL) OR …)` with
`Rows Removed by Filter` equal to nearly the whole table.

**The right pattern: build the WHERE clause dynamically, bind every value.**
Dynamic SQL and SQL injection are orthogonal — the *structure* is chosen by
your code from a fixed vocabulary, and every *value* is a `$n` placeholder. This
is exactly the accumulator `buildPipelineFilter` already uses in
`src/routes/staff.js`; the property search reuses the shape verbatim:

```js
// src/lib/research/property-filter.js
'use strict';
const { ratingRank } = require('./uad');

const SORTS = {                       // whitelist — never a client string in SQL
  recent:      'COALESCE(p.last_sale_date, DATE \'0001-01-01\') DESC, p.id DESC',
  price_desc:  'COALESCE(p.last_sale_price, -1) DESC, p.id DESC',
  price_asc:   'COALESCE(p.last_sale_price, 9e14) ASC, p.id DESC',
  gla_desc:    'COALESCE(p.gla, -1) DESC, p.id DESC',
  address:     'lower(p.display_address) ASC, p.id DESC',
};

const num  = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const int  = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const str  = (v, max) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, max || 80) : null; };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const day  = (v) => (DATE_RE.test(String(v || '')) ? String(v) : null);

const PROPERTY_TYPES = new Set(['SFR','Multi 2-4','Multi 5+','Condo','Townhouse/PUD','Land','Mixed Use']);

/**
 * THE ONE FILTER BUILDER. Returns { where, params, add, order, error }.
 * Every VALUE is bound; only whitelisted FRAGMENTS are concatenated. `add`
 * returns its own placeholder so the numbering stays right no matter which
 * filters are active — the same contract as buildPipelineFilter (staff.js).
 */
function buildPropertyFilter(q, opts) {
  const o = opts || {};
  const params = [];
  const add = (val) => { params.push(val); return `$${params.length}`; };
  const where = ['TRUE'];

  // ---- mode: a COMP search only ever wants rows that actually sold. Emitting
  // these two predicates is ALSO what lets the planner use the partial indexes.
  if (o.soldOnly) where.push('p.last_sale_date IS NOT NULL AND p.last_sale_price IS NOT NULL');

  // ---- location
  const st = str(q.state, 2);
  if (st) where.push(`p.state = ${add(st.toUpperCase())}`);
  const city = str(q.city, 60);
  if (city) where.push(`lower(p.city) = lower(${add(city)})`);
  if (Array.isArray(q.zips) && q.zips.length) {
    const zips = q.zips.map((z) => str(z, 5)).filter(Boolean).slice(0, 50);
    if (zips.length) where.push(`p.zip = ANY(${add(zips)}::text[])`);
  } else {
    const zip = str(q.zip, 5);
    if (zip) where.push(`p.zip = ${add(zip)}`);
  }

  // ---- ranges. One helper, so a new range filter is one line and cannot get
  // the bind numbering wrong.
  const range = (col, lo, hi, coerce) => {
    const a = coerce(lo), b = coerce(hi);
    if (a !== null) where.push(`${col} >= ${add(a)}`);
    if (b !== null) where.push(`${col} <= ${add(b)}`);
  };
  range('p.last_sale_price', q.minPrice, q.maxPrice, num);
  range('p.last_sale_date',  q.soldAfter, q.soldBefore, day);
  range('p.beds',            q.minBeds, q.maxBeds, int);
  range('p.baths_total',     q.minBaths, q.maxBaths, num);
  range('p.gla',             q.minSqft, q.maxSqft, num);
  range('p.year_built',      q.minYear, q.maxYear, int);
  range('p.lot_sqft',        q.minLot, q.maxLot, num);
  range('p.units',           q.minUnits, q.maxUnits, int);

  // ---- UAD ordinals. "best" is the LOW rank; the inversion lives in uad.js.
  const cBest = ratingRank(q.conditionBest), cWorst = ratingRank(q.conditionWorst);
  if (cBest  !== null) where.push(`p.condition_rank >= ${add(cBest)}`);
  if (cWorst !== null) where.push(`p.condition_rank <= ${add(cWorst)}`);
  const qBest = ratingRank(q.qualityBest), qWorst = ratingRank(q.qualityWorst);
  if (qBest  !== null) where.push(`p.quality_rank >= ${add(qBest)}`);
  if (qWorst !== null) where.push(`p.quality_rank <= ${add(qWorst)}`);

  // ---- property type (set membership, whitelisted)
  if (Array.isArray(q.propertyTypes) && q.propertyTypes.length) {
    const types = q.propertyTypes.map((t) => str(t, 40)).filter((t) => t && PROPERTY_TYPES.has(t));
    if (!types.length) return { error: 'unknown propertyType' };
    where.push(`p.property_type = ANY(${add(types)}::text[])`);
  }

  // ---- ARV vs As-Is comp usage (denormalised counters — see §1.7)
  if (q.compSet === 'arv')   where.push('p.arv_comp_count > 0');
  if (q.compSet === 'as_is') where.push('p.as_is_comp_count > 0');

  // ---- free text
  const text = str(q.q, 120);
  if (text) {
    const tsq = addressTsQuery(text);
    if (tsq) where.push(`p.address_tsv @@ to_tsquery('simple', ${add(tsq)})`);
  }

  const order = SORTS[String(q.sort || 'recent')] || SORTS.recent;
  return { where: where.join('\n   AND '), params, add, order };
}
```

Two properties of that builder worth naming, because they are what make it safe:

1. **Nothing derived from user input is ever concatenated.** `state`, `city`,
   dates, numbers — all `$n`. The only concatenated strings are `SORTS[...]`
   (whitelisted map lookup with a fallback) and column names written literally in
   this file. `q.sort = "id; DROP TABLE"` resolves to `SORTS.recent`.
2. **An absent filter emits no SQL at all**, so the planner sees exactly the
   predicates that exist and can const-fold, use partial indexes, and estimate
   selectivity from real statistics.

**Cost of the dynamic approach:** more distinct query texts, so more parse+plan
work and more entries in `pg_stat_statements`. That is a real but small cost
(single-digit milliseconds of planning), and it is dwarfed by the difference
between a bitmap scan of 900 rows and a seq scan of 500,000.

---

## 2. PAGINATION AND COUNTS AT SCALE

### 2.1 OFFSET is O(offset); keyset is O(1)

`ORDER BY x LIMIT 50 OFFSET 25000` makes Postgres produce and discard 25,000
rows. Page 501 costs 500× page 1. Worse, `OFFSET` is *incorrect under
concurrency*: an ingest inserting a row that sorts before your cursor shifts
every subsequent page by one, so a user paging through results sees a row twice
and never sees another. In a warehouse whose whole point is a continuously
running back-fill, that is not hypothetical.

**Keyset (seek) pagination** carries the last row's sort key forward:

```sql
-- page 1
SELECT p.id, p.display_address, p.last_sale_date, p.last_sale_price, …
  FROM properties p
 WHERE <filters>
 ORDER BY COALESCE(p.last_sale_date, DATE '0001-01-01') DESC, p.id DESC
 LIMIT 51;                                  -- 51 = page size + 1 sentinel

-- page N (cursor = the 50th row's sort tuple)
   AND (COALESCE(p.last_sale_date, DATE '0001-01-01'), p.id) < ($c1::date, $c2::uuid)
 ORDER BY COALESCE(p.last_sale_date, DATE '0001-01-01') DESC, p.id DESC
 LIMIT 51;
```

Three details that are load-bearing:

* **The row-value comparison `(a, b) < ($1, $2)`** is what makes this a single
  index seek. Writing it as `a < $1 OR (a = $1 AND b < $2)` is logically the same
  but Postgres does *not* always turn that back into an index range — always use
  the row-value form.
* **NULLs must be folded out of the sort key, not handled with `NULLS LAST`.**
  Row-value comparison has no `NULLS LAST` variant. Wrapping the key in
  `COALESCE(last_sale_date, DATE '0001-01-01')` under a `DESC` sort puts unsold
  properties last *and* makes the tuple comparison total. The index must match
  the expression exactly:

```sql
CREATE INDEX IF NOT EXISTS idx_props_keyset_recent
  ON properties((COALESCE(last_sale_date, DATE '0001-01-01')) DESC, id DESC);
```

* **A tie-breaker is mandatory.** Thousands of properties share a `last_sale_date`
  (the appraisal grid records month precision). Without `id` in the sort, the
  cursor cannot resume deterministically and rows are skipped or repeated.

**The cursor is opaque, signed by the filter set, and validated:**

```js
const crypto = require('crypto');

/** The cursor encodes the sort tuple AND a fingerprint of the filters+sort it
 *  was produced under. Replaying a cursor against a DIFFERENT filter set is
 *  meaningless (the sort key means something else), so we refuse it rather than
 *  return a silently wrong page. */
function filterFingerprint(q, sortKey) {
  return crypto.createHash('sha1')
    .update(JSON.stringify({ q, sortKey })).digest('base64url').slice(0, 12);
}
function encodeCursor(row, sortKey, fp) {
  return Buffer.from(JSON.stringify({ k: [row.sort_key, row.id], s: sortKey, f: fp }))
    .toString('base64url');
}
function decodeCursor(raw, sortKey, fp) {
  if (!raw) return null;
  let c;
  try { c = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8')); }
  catch { return { error: 'bad cursor' }; }
  if (!c || !Array.isArray(c.k) || c.k.length !== 2) return { error: 'bad cursor' };
  if (c.s !== sortKey || c.f !== fp) return { error: 'cursor does not match these filters' };
  return { key: c.k[0], id: c.k[1] };
}
```

**When you still need OFFSET.** Keyset cannot do "jump to page 7." If the
product requires numbered pages (§6 says it should not), cap the offset hard —
`OFFSET` above ~2,000 is refused with "narrow your search" — and treat that as a
product decision, not a limitation.

### 2.2 Getting a total count cheaply — four options, ranked

| Option | Cost | Accuracy | Use when |
|---|---|---|---|
| `count(*) OVER ()` | full scan of the filtered set, **on every page** | exact | never, for a large corpus |
| second `SELECT count(*)` | full scan of the filtered set, **once**, index-only if lucky | exact | small/medium result sets |
| capped count | `LIMIT cap+1` — stops early | exact ≤ cap, "cap+" above | **default** |
| planner estimate | one `EXPLAIN`, ~0.5 ms | ±2× | huge result sets |

**`count(*) OVER ()` is the trap.** It looks free because it rides along on the
page query, but the `WindowAgg` must see the *entire* partition before it can emit
the first row — so it silently converts your `LIMIT 50` into a full materialisation
of every matching row, on every page. It also defeats keyset pagination's entire
premise (stop early). Its one genuine advantage is *consistency*: the count and
the rows come from one snapshot. That is rarely worth it here.

**Capped count — the default.** This is what Google and every large search product
does, and it is honest:

```sql
SELECT count(*)::int AS n
  FROM (SELECT 1 FROM properties p WHERE <filters> LIMIT 1001) t;
```

Postgres stops the inner scan at 1,001 rows. `n <= 1000` → exact ("1,000 results").
`n = 1001` → "1,000+ results". The cost is bounded regardless of corpus size.

**Planner estimate — for when you want a number above the cap.** Reads the
optimiser's own row estimate without executing anything:

```sql
CREATE OR REPLACE FUNCTION pilot_count_estimate(query text) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE plan json;
BEGIN
  EXECUTE 'EXPLAIN (FORMAT JSON) ' || query INTO plan;
  RETURN (plan->0->'Plan'->>'Plan Rows')::bigint;
END $$;
```

Because it takes SQL *text*, it can only ever be called with a query this
codebase built — never with anything a user typed. Safer and simpler: do the
`EXPLAIN` from JS, where the parameters are still bound:

```js
async function estimateRows(db, sql, params) {
  try {
    const r = await db.query('EXPLAIN (FORMAT JSON) ' + sql, params);
    const plan = r.rows[0]['QUERY PLAN'][0].Plan;
    return Math.max(0, Math.round(plan['Plan Rows']));
  } catch { return null; }               // never break a search over a count
}
```

Accuracy depends entirely on `ANALYZE` freshness. A warehouse fed by a batch
back-fill must `ANALYZE properties;` at the end of every ingest pass, or the
estimate is anchored to whatever the table looked like at creation.

### 2.3 Rendering "about N results" honestly

The rule: **the number the user sees must never be more precise than the number
we actually have.** Three states, and the UI must be able to render all three:

```js
/** { mode:'exact'|'capped'|'estimated', total, cap } -> the string to render. */
function resultCountLabel(c) {
  if (!c || c.total == null) return 'Results';
  if (c.mode === 'exact')     return `${c.total.toLocaleString()} ${c.total === 1 ? 'property' : 'properties'}`;
  if (c.mode === 'capped')    return `${c.cap.toLocaleString()}+ properties — narrow your search to see a total`;
  return `About ${roundish(c.total).toLocaleString()} properties`;   // estimated
}
/** An estimate rendered to its own precision: 4,317 -> "4,300", 41,732 -> "42,000". */
function roundish(n) {
  if (n < 100) return n;
  const mag = Math.pow(10, Math.floor(Math.log10(n)) - 1);
  return Math.round(n / mag) * mag;
}
```

Rendering an estimate as `4,317` is a lie with four significant figures; `About
4,300` is the same information told truthfully. And never show a number that
changes after the fact — no "loading… 50 → 4,317". Pick the mode before the first
paint.

---

## 3. FACETS — counts per city / per bed count / per price band, in one round trip

### 3.1 The shape: one materialised CTE, scanned twice, one round trip

```sql
WITH filtered AS MATERIALIZED (
  SELECT p.id, p.city, p.beds, p.property_type, p.last_sale_price,
         p.last_sale_date, p.gla, p.condition_rank,
         COALESCE(p.last_sale_date, DATE '0001-01-01') AS sort_key
    FROM properties p
   WHERE <filters>
   LIMIT 20000                       -- FACET CEILING, see §3.4
),
page AS (
  SELECT f.* FROM filtered f
   WHERE (f.sort_key, f.id) < ($c1::date, $c2::uuid)     -- keyset, omitted on page 1
   ORDER BY f.sort_key DESC, f.id DESC
   LIMIT 51
),
facet_city AS (
  SELECT city AS value, count(*)::int AS n
    FROM filtered WHERE city IS NOT NULL
   GROUP BY city ORDER BY n DESC, city LIMIT 15
),
facet_beds AS (
  SELECT LEAST(beds, 6)::text AS value, count(*)::int AS n
    FROM filtered WHERE beds IS NOT NULL
   GROUP BY LEAST(beds, 6) ORDER BY 1
),
facet_type AS (
  SELECT property_type AS value, count(*)::int AS n
    FROM filtered WHERE property_type IS NOT NULL
   GROUP BY property_type ORDER BY n DESC LIMIT 12
),
facet_price AS (
  SELECT (width_bucket(last_sale_price, 0, 2000000, 20))::text AS value,
         count(*)::int AS n
    FROM filtered WHERE last_sale_price IS NOT NULL
   GROUP BY 1 ORDER BY 1
)
SELECT
  (SELECT json_agg(row_to_json(page)  ORDER BY sort_key DESC, id DESC) FROM page)  AS rows,
  (SELECT count(*)::int FROM filtered)                                             AS matched,
  (SELECT json_agg(row_to_json(facet_city))  FROM facet_city)                      AS by_city,
  (SELECT json_agg(row_to_json(facet_beds))  FROM facet_beds)                      AS by_beds,
  (SELECT json_agg(row_to_json(facet_type))  FROM facet_type)                      AS by_type,
  (SELECT json_agg(row_to_json(facet_price)) FROM facet_price)                     AS by_price;
```

**`AS MATERIALIZED` is the whole trick.** Without it (Postgres 12+ inlines CTEs
by default) the planner would push the filter down into each of the five
consumers and evaluate it five times. With it, the filter runs **once**, the
result lives in a tuplestore, and the five aggregations scan that. One round
trip, one index pass.

### 3.2 GROUPING SETS — one aggregation node instead of four

If you would rather have one pass over `filtered` than four:

```sql
SELECT
  CASE WHEN GROUPING(city)  = 0 THEN 'city'
       WHEN GROUPING(beds)  = 0 THEN 'beds'
       WHEN GROUPING(band)  = 0 THEN 'price'
       WHEN GROUPING(ptype) = 0 THEN 'type'
       ELSE 'total' END                                    AS facet,
  COALESCE(city, beds::text, band::text, ptype, 'all')     AS value,
  count(*)::int                                            AS n
FROM (
  SELECT city, LEAST(beds,6) AS beds, property_type AS ptype,
         width_bucket(last_sale_price, 0, 2000000, 20) AS band
    FROM filtered) s
GROUP BY GROUPING SETS ((city), (beds), (band), (ptype), ())
ORDER BY facet, n DESC;
```

That returns every facet *and* the grand total in one long-format result set,
which the Express layer pivots into an object. It is measurably cheaper than four
separate `GROUP BY`s on a large `filtered` set, at the cost of a shape the client
has to reassemble. Use it when `filtered` is big; use §3.1 when readability
matters more.

### 3.3 `FILTER` aggregates — for fixed, known buckets

When the buckets are a fixed list (not data-driven), a single scan with `FILTER`
is the cheapest form of all, and it returns a *wide* row that needs no pivoting:

```sql
SELECT
  count(*)::int                                                                       AS total,
  count(*) FILTER (WHERE beds = 1)::int                                               AS beds_1,
  count(*) FILTER (WHERE beds = 2)::int                                               AS beds_2,
  count(*) FILTER (WHERE beds = 3)::int                                               AS beds_3,
  count(*) FILTER (WHERE beds >= 4)::int                                              AS beds_4p,
  count(*) FILTER (WHERE last_sale_price <  200000)::int                              AS px_u200,
  count(*) FILTER (WHERE last_sale_price >= 200000 AND last_sale_price < 350000)::int AS px_200_350,
  count(*) FILTER (WHERE last_sale_price >= 350000 AND last_sale_price < 500000)::int AS px_350_500,
  count(*) FILTER (WHERE last_sale_price >= 500000)::int                              AS px_500p,
  count(*) FILTER (WHERE condition_rank <= 3)::int                                    AS cond_c1_c3,
  count(*) FILTER (WHERE last_sale_date >= current_date - 180)::int                   AS sold_6mo,
  count(*) FILTER (WHERE arv_comp_count   > 0)::int                                   AS used_as_arv,
  count(*) FILTER (WHERE as_is_comp_count > 0)::int                                   AS used_as_as_is
FROM filtered;
```

### 3.4 The three honesty problems every faceted search has

**(a) A facet must exclude its own filter.** If the user has already selected
"Paterson", the city facet computed over the filtered set shows exactly one city
with count = total — useless. Real MLS/Redfin behaviour is that each facet's
counts are computed with *that facet's own predicate removed*, so the user can
see "Clifton (214)" and switch to it. Computing that properly means N+1 scans.

The honest compromise, and what to build: **compute at most one
filter-excluded facet — the one the user is currently interacting with — and
compute the rest post-filter.** Pass the excluded facet name into the builder:

```js
// buildPropertyFilter(q, { excludeFacet: 'city' }) omits the city predicate,
// and the route runs at most TWO filtered CTEs: the main one, and (only when a
// facet is open in the UI) one with that facet excluded.
```

**(b) Facets on page 2+ are wasted work.** The facet counts cannot change while
the filters do not change. Compute facets **only when `cursor` is absent** (page
1) and let the client hold them. This alone removes ~90% of facet cost.

**(c) Facet counts on an unbounded result set are unbounded work.** The
`LIMIT 20000` inside the `filtered` CTE caps it. It makes the counts *partial*,
so the UI must say so — "counts based on the first 20,000 matches" — and it must
be a real ceiling, not a silent truncation. If `matched = 20000`, the client
renders the caveat.

---

## 4. GEO WITHOUT POSTGIS

### 4.1 The correct degree-per-mile math

* **Latitude.** One degree of latitude is very nearly constant:
  **69.0546 statute miles** (it varies from 68.703 mi at the equator to 69.407 mi
  at the poles — under ±0.5%, irrelevant at comp-search distances). So
  `Δlat_degrees = miles / 69.0546`.
* **Longitude.** One degree of longitude is 69.1710 miles **at the equator** and
  shrinks with the cosine of the latitude:
  `miles_per_lng_degree = 69.1710 × cos(latitude_in_radians)`, so
  `Δlng_degrees = miles / (69.1710 × cos(φ))`.

At Piscataway NJ (φ ≈ 40.55°), `cos φ ≈ 0.7597`, so one degree of longitude is
≈ 52.55 miles. A **1.0-mile** box is therefore ±0.01448° of latitude and
±0.01903° of longitude — the longitude box is ~31% *wider* in degrees, which is
exactly the error you get if you (as many implementations do) use the same delta
for both.

**Guard the cosine.** At φ = 90° it is 0 and you divide by zero; clamp:

```js
const MI_PER_LAT_DEG = 69.0546;
const MI_PER_LNG_DEG_EQUATOR = 69.1710;
const EARTH_RADIUS_MI = 3958.7613;

/** The bounding box for `miles` around (lat,lng). Latitude is clamped to the
 *  poles and longitude deltas are clamped to 180 so a huge radius or a polar
 *  point degenerates to "the whole world" instead of NaN. */
function boundingBox(lat, lng, miles) {
  const dLat = miles / MI_PER_LAT_DEG;
  const cos = Math.cos((lat * Math.PI) / 180);
  const dLng = Math.abs(cos) < 1e-6 ? 180 : miles / (MI_PER_LNG_DEG_EQUATOR * Math.abs(cos));
  return {
    minLat: Math.max(-90,  lat - dLat),
    maxLat: Math.min( 90,  lat + dLat),
    minLng: Math.max(-180, lng - Math.min(dLng, 180)),
    maxLng: Math.min( 180, lng + Math.min(dLng, 180)),
  };
}
```

(Antimeridian wrap is a real edge case for a global product; for a US lending
book it cannot occur and the clamp is the honest handling.)

### 4.2 The pattern: cheap box prefilter, exact refine

The box is a **btree range** — indexable. Haversine is a transcendental function
of two columns — not indexable, ever. So: filter with the box (index), refine
with haversine (a few hundred rows).

```sql
-- Radius search: box prefilter (btree) + haversine refine + distance sort.
-- $1 lat, $2 lng, $3 radius_mi, $4..$7 the precomputed box, $8 limit.
WITH box AS (
  SELECT p.id, p.display_address, p.city, p.state, p.zip,
         p.latitude, p.longitude, p.beds, p.baths_total, p.gla, p.year_built,
         p.last_sale_price, p.last_sale_date, p.property_type, p.condition_rank
    FROM properties p
   WHERE p.latitude  BETWEEN $4 AND $5
     AND p.longitude BETWEEN $6 AND $7
     AND p.latitude IS NOT NULL
     <other filters>
)
SELECT b.*,
       (2 * 3958.7613 * asin(sqrt(
            power(sin(radians(b.latitude - $1) / 2), 2)
          + cos(radians($1)) * cos(radians(b.latitude))
          * power(sin(radians(b.longitude - $2) / 2), 2)
       )))::numeric(8,3) AS distance_mi
  FROM box b
 WHERE (2 * 3958.7613 * asin(sqrt(
            power(sin(radians(b.latitude - $1) / 2), 2)
          + cos(radians($1)) * cos(radians(b.latitude))
          * power(sin(radians(b.longitude - $2) / 2), 2)
       ))) <= $3
 ORDER BY distance_mi ASC, b.id
 LIMIT $8;
```

Repeating the haversine expression in `WHERE` and `SELECT` is ugly; Postgres
evaluates it twice. Two ways to write it once — a `LATERAL`:

```sql
SELECT b.*, d.distance_mi
  FROM box b
  CROSS JOIN LATERAL (
    SELECT (2 * 3958.7613 * asin(sqrt(
              power(sin(radians(b.latitude - $1)/2),2)
            + cos(radians($1)) * cos(radians(b.latitude))
            * power(sin(radians(b.longitude - $2)/2),2))))::numeric(8,3) AS distance_mi) d
 WHERE d.distance_mi <= $3
 ORDER BY d.distance_mi, b.id
 LIMIT $8;
```

…or an `IMMUTABLE` SQL function, which is what you actually want because the
formula then exists in exactly one place:

```sql
-- db/NNN: the great-circle distance in statute miles. IMMUTABLE + STRICT so it
-- can be used in an index expression and returns NULL for a missing coordinate
-- (never 0 — a property with no coordinates is not "at the subject").
CREATE OR REPLACE FUNCTION pilot_distance_mi(
  lat1 double precision, lng1 double precision,
  lat2 double precision, lng2 double precision)
RETURNS double precision
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT 2 * 3958.7613 * asin(sqrt(
      power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2))
    * power(sin(radians(lng2 - lng1) / 2), 2)))
$$;
```

```sql
SELECT b.*, pilot_distance_mi($1, $2, b.latitude, b.longitude)::numeric(8,3) AS distance_mi
  FROM box b
 WHERE pilot_distance_mi($1, $2, b.latitude, b.longitude) <= $3
 ORDER BY distance_mi, b.id
 LIMIT $8;
```

**For radii under ~25 miles an equirectangular approximation is ~3× cheaper and
accurate to well under 0.1%** — worth it only if profiling says the haversine
matters, which at a few hundred candidate rows it will not:

```sql
sqrt( power((b.latitude  - $1) * 69.0546, 2)
    + power((b.longitude - $2) * 69.1710 * cos(radians(($1 + b.latitude)/2)), 2) )
```

### 4.3 The index that makes the box cheap

```sql
-- db/406 already has:  (latitude, longitude) WHERE latitude IS NOT NULL
CREATE INDEX IF NOT EXISTS idx_properties_latlng
  ON properties(latitude, longitude) WHERE latitude IS NOT NULL;
```

Understand what a composite btree actually does with two range predicates: it
**seeks on `latitude` only**, and `longitude` is applied as an in-index filter
over that band. That is still a big win (no heap fetch for rows outside the
longitude band), but the *scan width is set by the latitude band alone*. For a
1-mile search that band is 0.029° — a tiny sliver of a state — so it is fine.
For a 25-mile search across a dense metro it is a 0.72° band spanning the whole
state's width, and the longitude filter is doing all the work.

**The upgrade path when that becomes a problem — a grid-cell column, which is a
poor man's spatial index built entirely from core types:**

```sql
-- A ~0.69 mi × (0.69·cos φ) mi cell. Integer, btree-indexable, and a bounding
-- box becomes a bounded array of cell ids -> `= ANY(...)`, which is a set of
-- index seeks instead of one wide range scan.
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS geo_cell integer
  GENERATED ALWAYS AS (
    CASE WHEN latitude IS NULL OR longitude IS NULL THEN NULL
         ELSE (floor(latitude * 100)::int + 9000) * 40000
            + (floor(longitude * 100)::int + 18000) END
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_properties_geo_cell
  ON properties(geo_cell) WHERE geo_cell IS NOT NULL;
```

```js
/** Cell ids covering a bounding box. 0.01 deg cells: a 1-mile radius is ~3x4
 *  cells, a 5-mile radius ~15x20 = 300. Refuse to build more than MAX_CELLS —
 *  above that the plain lat/lng box is the better plan. */
const MAX_CELLS = 2000;
function cellsForBox(box) {
  const cells = [];
  const y0 = Math.floor(box.minLat * 100), y1 = Math.floor(box.maxLat * 100);
  const x0 = Math.floor(box.minLng * 100), x1 = Math.floor(box.maxLng * 100);
  if ((y1 - y0 + 1) * (x1 - x0 + 1) > MAX_CELLS) return null;   // caller falls back to the box
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells.push((y + 9000) * 40000 + (x + 18000));
  return cells;
}
// WHERE p.geo_cell = ANY($n::int[])   -- then the haversine refine as before
```

### 4.4 Sorting by distance efficiently

**You cannot index a sort by distance from an arbitrary point.** The sort key
depends on the query. What you *can* do is make the candidate set small enough
that sorting it is free, and that is the whole game:

* **Bound the candidate set with the box, always.** Never `ORDER BY
  pilot_distance_mi(...) LIMIT 20` over an unfiltered table — that computes
  500,000 distances and sorts them.
* **Expanding-ring search** when the radius is not user-specified. Try 0.5 mi;
  if fewer than N results, try 1 mi, then 2, then 5, stopping at a hard ceiling.
  Each ring is a cheap indexed box. The user sees "6 comps within 1.0 mile" which
  is *more* informative than a fixed radius, and it matches how an appraiser
  actually works (tightest ring that yields enough comps).

```js
const RINGS = [0.5, 1, 2, 3, 5, 10];
async function compsNearby(db, subject, want, filterSql, filterParams) {
  for (const miles of RINGS) {
    const rows = await radiusQuery(db, subject, miles, filterSql, filterParams, want * 3);
    if (rows.length >= want || miles === RINGS[RINGS.length - 1]) {
      return { rows, radiusMi: miles, exhausted: rows.length < want };
    }
  }
}
```

* **Distance keyset pagination is not worth building.** Distance searches are
  intrinsically small (a radius search that returns 5,000 rows is a badly posed
  question). Cap at 500 and paginate in memory, or make the radius smaller.

### 4.5 A property with no coordinates

`properties.latitude/longitude` are nullable and, in a warehouse fed by appraisal
XML, a meaningful fraction will be NULL — MISMO carries coordinates on the
comparables grid inconsistently across vendors. The rules:

1. **Never treat a missing coordinate as distance 0 or as "far".** `STRICT` on
   `pilot_distance_mi` guarantees NULL, and NULL sorts last under
   `ORDER BY distance_mi ASC NULLS LAST`. This mirrors the repo's never-guess
   doctrine: an unknown distance is unknown, not a number.
2. **Offer a coordinate-free fallback branch, clearly labelled.** A UNION with
   an explicit `match_kind` so the UI can group them:

```sql
-- Within 1.5 miles by coordinates, PLUS same-ZIP properties whose coordinates
-- we never learned. The second group is labelled and always sorts last.
(SELECT p.id, p.display_address,
        pilot_distance_mi($1,$2,p.latitude,p.longitude)::numeric(8,3) AS distance_mi,
        'geo'::text AS match_kind
   FROM properties p
  WHERE p.latitude BETWEEN $4 AND $5 AND p.longitude BETWEEN $6 AND $7
    AND pilot_distance_mi($1,$2,p.latitude,p.longitude) <= $3)
UNION ALL
(SELECT p.id, p.display_address, NULL::numeric(8,3), 'zip'::text
   FROM properties p
  WHERE p.latitude IS NULL AND p.zip = $8 AND p.zip IS NOT NULL)
ORDER BY distance_mi ASC NULLS LAST, match_kind, id
LIMIT $9;
```

3. **Back-fill coordinates opportunistically, never on the search path.** The
   repo already has `src/lib/address-canon.js` with a Google→OSM geocoder,
   a permanent `address_canon_cache`, and — critically —
   `address.geocodeRewriteIsSafe`, which exists precisely because a geocoder that
   cannot place a house number answers with the *road*. A warehouse back-fill
   must reuse that guard: adopt the **coordinates** but never let the geocoder's
   text overwrite the address, and never cache a non-definitive answer (see the
   2026-07-28 geocode-downgrade rule in `CLAUDE.md`). Run it as a bounded,
   resumable boot sweep, exactly like `clickup/address-backfill.js`.
4. **The comp scorer must penalise a missing distance, not skip the property.**
   See §5.4.

---

## 5. RANKING — "the best comparables for THIS subject"

### 5.1 The factors, and what each is actually measuring

| Factor | Source | Why an appraiser cares |
|---|---|---|
| Distance | haversine (§4) | same market / same school district |
| Sale recency | `last_sale_date` | a 3-year-old sale is not evidence of today's value |
| GLA delta | `gla` vs subject | the single biggest driver of price |
| Bed / bath match | `beds`, `baths_total` | functional equivalence |
| Property type | `property_type` | a 2-family is not a comp for an SFR, ever |
| Units | `units` | ditto, and it is a hard gate for 2–4 family |
| Condition / quality | `condition_rank`, `quality_rank` | C4 vs C2 is a large adjustment |
| Year built | `year_built` | proxy for systems/style |
| Lot size | `lot_sqft` | matters in some markets, not others |
| Was it already used as a comp | `comp_count`, `arv_comp_count` | an appraiser already accepted it — a real quality signal |

### 5.2 Hard gates vs soft scores

**Gate in SQL, score in JS.** A gate is a fact that makes a property *not a
comp at all*, and gating in SQL is what keeps the candidate set at ~200 rows
instead of 20,000:

* property type must match the subject's category (SFR↔SFR, 2–4↔2–4, condo↔condo)
* unit count must be in the same band
* must have a `last_sale_price` and `last_sale_date`
* sale within the window (default 12 months; widen to 24 only if starved)
* within the search radius
* GLA within ±50% (a 900 sqft sale is not a comp for a 3,000 sqft subject at
  *any* score)

Everything else is a soft score.

### 5.3 The scoring function

Normalise every factor to a **0…1 penalty** against an explicit tolerance, weight
it, and subtract from 100. The tolerance is what makes the weights comparable —
"0.25 of the GLA penalty" only means something once you have said that 25% GLA
difference is the full penalty.

```js
// src/lib/research/comp-score.js
'use strict';
/**
 * COMPARABLE SCORING. 100 = a perfect twin next door that sold last month.
 *
 * Every factor is (a) a normalised 0..1 penalty against an explicit TOLERANCE,
 * (b) weighted, (c) DROPPED — not zeroed — when the data is missing, with the
 * total renormalised over the weights that actually applied. A comp scored on 4
 * of 8 factors is reported as such (`coverage`), because "88 out of 100" from
 * half the data is not the same claim as "88" from all of it. This is the same
 * never-guess discipline the appraisal desk uses: a missing fact is missing, not
 * a favourable default.
 */
const FACTORS = [
  { key: 'distance',  weight: 22, tol: 1.0,   label: 'Distance' },          // tol = miles for a full penalty
  { key: 'recency',   weight: 18, tol: 12,    label: 'Sale recency' },      // tol = months
  { key: 'gla',       weight: 20, tol: 0.25,  label: 'Square footage' },    // tol = fractional difference
  { key: 'beds',      weight: 9,  tol: 2,     label: 'Bedrooms' },
  { key: 'baths',     weight: 6,  tol: 2,     label: 'Bathrooms' },
  { key: 'condition', weight: 9,  tol: 2,     label: 'Condition (UAD)' },   // tol = rank steps
  { key: 'quality',   weight: 6,  tol: 2,     label: 'Quality (UAD)' },
  { key: 'age',       weight: 6,  tol: 30,    label: 'Year built' },        // tol = years
  { key: 'lot',       weight: 4,  tol: 0.50,  label: 'Lot size' },
];
const TOTAL_WEIGHT = FACTORS.reduce((s, f) => s + f.weight, 0);   // 100

const n = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Months between two 'YYYY-MM-DD' calendar strings — string math only, no
 *  Date parsing, so there is no timezone drift (the repo's date-only rule). */
function monthsBetween(fromDay, toDay) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fromDay || ''))) return null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(toDay || '')) ? String(toDay)
           : new Date().toISOString().slice(0, 10);
  const [fy, fm] = fromDay.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

/** The raw, un-normalised deltas. null = "we cannot compute this factor". */
function deltas(subject, cand, asOfDay) {
  const sg = n(subject.gla), cg = n(cand.gla);
  const sl = n(subject.lot_sqft), cl = n(cand.lot_sqft);
  const months = monthsBetween(cand.last_sale_date, asOfDay);
  return {
    distance:  n(cand.distance_mi),
    recency:   months == null ? null : Math.max(0, months),
    gla:       sg && cg ? Math.abs(cg - sg) / sg : null,
    beds:      n(subject.beds) != null && n(cand.beds) != null ? Math.abs(n(cand.beds) - n(subject.beds)) : null,
    baths:     n(subject.baths_total) != null && n(cand.baths_total) != null
                 ? Math.abs(n(cand.baths_total) - n(subject.baths_total)) : null,
    condition: n(subject.condition_rank) != null && n(cand.condition_rank) != null
                 ? Math.abs(n(cand.condition_rank) - n(subject.condition_rank)) : null,
    quality:   n(subject.quality_rank) != null && n(cand.quality_rank) != null
                 ? Math.abs(n(cand.quality_rank) - n(subject.quality_rank)) : null,
    age:       n(subject.year_built) != null && n(cand.year_built) != null
                 ? Math.abs(n(cand.year_built) - n(subject.year_built)) : null,
    lot:       sl && cl ? Math.abs(cl - sl) / sl : null,
  };
}

/**
 * scoreComp(subject, cand, {asOfDay}) ->
 *   { score, coverage, appliedWeight, breakdown:[{label, delta, penalty, points}], missing:[...] }
 */
function scoreComp(subject, cand, opts) {
  const o = opts || {};
  const d = deltas(subject, cand, o.asOfDay);
  const breakdown = [], missing = [];
  let penaltyPoints = 0, appliedWeight = 0;

  for (const f of FACTORS) {
    const raw = d[f.key];
    if (raw == null) { missing.push(f.label); continue; }
    const penalty = clamp01(raw / f.tol);            // 0 = identical, 1 = at/over tolerance
    const points  = penalty * f.weight;
    penaltyPoints += points;
    appliedWeight += f.weight;
    breakdown.push({ key: f.key, label: f.label, delta: raw, penalty, points: -points });
  }

  // Renormalise: the score is out of 100 REGARDLESS of how many factors applied,
  // and `coverage` reports how much of the model we could actually evaluate.
  const score = appliedWeight === 0 ? null
              : Math.round((100 - (penaltyPoints / appliedWeight) * 100) * 10) / 10;

  // Small, explicit BONUSES for signals that are not deltas. Capped at +6 total
  // so they can never outrank a genuinely closer, more recent, more similar comp.
  let bonus = 0;
  if (subject.property_type && cand.property_type === subject.property_type) { bonus += 3; breakdown.push({ key:'type', label:'Same property type', points: +3 }); }
  if (n(cand.arv_comp_count) > 0 || n(cand.comp_count) > 0)                  { bonus += 2; breakdown.push({ key:'used', label:'Previously used as a comparable', points: +2 }); }
  if (n(subject.units) != null && n(cand.units) === n(subject.units))        { bonus += 1; breakdown.push({ key:'units', label:'Same unit count', points: +1 }); }

  return {
    score: score == null ? null : Math.max(0, Math.min(100, Math.round((score + bonus) * 10) / 10)),
    coverage: Math.round((appliedWeight / TOTAL_WEIGHT) * 100),
    appliedWeight, missing, breakdown,
  };
}
module.exports = { scoreComp, FACTORS, TOTAL_WEIGHT, _internals: { deltas, monthsBetween } };
```

### 5.4 The missing-data rule, stated plainly

Three wrong ways to handle a missing GLA, and the right one:

* `gla ?? 0` → delta is 100%, the comp is buried. **Wrong**: we punished it for
  our own ignorance.
* `gla ?? subject.gla` → delta is 0, perfect score. **Wrong and dangerous**: an
  empty record outranks a real one.
* skip the factor and score out of 100 anyway → the score silently means
  something different per row. **Wrong**: incomparable numbers in one list.
* **drop the factor, renormalise over the applied weight, and report
  `coverage`.** Scores stay comparable, and the UI can show "82 · 7 of 9 factors"
  and grey out a comp whose coverage is below, say, 60%.

### 5.5 Rank in SQL or in JS?

**Both, at different stages — and the reason is explainability, not
performance.**

* **SQL does the gating and the ordering-for-truncation.** It must, because
  `LIMIT` has to happen in the database or you ship 20,000 rows to Node.
* **JS does the final score and the explanation.** The product deliverable is
  not a number, it is *"why is this comp #1?"* — an appraiser and an underwriter
  both need "−4.2 for 0.19 mi, −6.0 for 1,240 vs 1,600 sqft". Encoding that
  breakdown in SQL means a dozen expressions repeated in `SELECT` and `ORDER BY`,
  no unit tests without a database, and a formula that cannot be changed without
  a migration. Encoding it in JS gives a **pure, unit-testable function** — which
  is what this codebase does for every other piece of business logic
  (`comp-grid.js`, `person-name.js`, `term-options.js`).

The pipeline:

```js
// 1. SQL: hard gates + a cheap PROXY order + a bounded candidate set.
const CANDIDATE_CAP = 300;
const sql = `
  WITH box AS (
    SELECT p.*, pilot_distance_mi($1,$2,p.latitude,p.longitude) AS distance_mi
      FROM properties p
     WHERE p.latitude BETWEEN $4 AND $5 AND p.longitude BETWEEN $6 AND $7
       AND p.last_sale_price IS NOT NULL AND p.last_sale_date IS NOT NULL
       AND p.last_sale_date >= $8                      -- sale window
       AND p.property_type = $9                        -- hard gate
       AND (p.units IS NULL OR p.units BETWEEN $10 AND $11)
       AND (p.gla IS NULL OR p.gla BETWEEN $12 AND $13)  -- +/-50% GLA gate
       AND p.id <> $14)                                -- never the subject itself
  SELECT * FROM box
   WHERE distance_mi <= $3
   ORDER BY distance_mi ASC, last_sale_date DESC
   LIMIT ${CANDIDATE_CAP}`;

// 2. JS: full score + breakdown, then the real ordering.
const scored = rows.map((r) => ({ ...r, ...scoreComp(subject, r, { asOfDay }) }))
  .filter((r) => r.score != null && r.coverage >= 50)
  .sort((a, b) => b.score - a.score || a.distance_mi - b.distance_mi);
```

The one thing to watch: **the SQL proxy order must not systematically exclude
what the JS scorer would have ranked first.** Ordering the candidate set by
distance and truncating at 300 is safe when the radius is tight; it is *not*
safe if you order by, say, `last_sale_price`. Distance is the right proxy
because it is also the factor with the hardest physical gate.

**A pure-SQL variant**, for when you need the database to do the `ORDER BY`
(e.g. a paged "all comps ranked" screen). Same formula, less explainable:

```sql
SELECT b.*,
  round((100
    - 22 * least(b.distance_mi / 1.0, 1)
    - 18 * least(greatest((EXTRACT(YEAR FROM age($15::date, b.last_sale_date)) * 12
                         + EXTRACT(MONTH FROM age($15::date, b.last_sale_date))), 0) / 12.0, 1)
    - 20 * least(abs(b.gla - $16) / nullif($16,0), 1)
    -  9 * least(abs(b.beds - $17) / 2.0, 1)
    -  6 * least(abs(b.baths_total - $18) / 2.0, 1)
    -  9 * least(abs(b.condition_rank - $19) / 2.0, 1)
    + CASE WHEN b.property_type = $9 THEN 3 ELSE 0 END
  )::numeric, 1) AS score
FROM box b
ORDER BY score DESC NULLS LAST, b.distance_mi
LIMIT 25;
```

Note every `abs(x - $n)` becomes NULL when either side is NULL, which makes the
whole expression NULL and drops the row to the bottom under `NULLS LAST`. That
is *a* defensible behaviour, but it is not the renormalising behaviour of §5.3 —
which is the second reason the JS scorer is the primary implementation.

### 5.6 Show the work

The comp panel must render, per comp: the score, the coverage, the breakdown, and
the *provenance* — "stated by 3 reports, most recently the 2026-04-11 appraisal
by J. Smith." That last part is a query against `property_observations`, and it
is what distinguishes this warehouse from a black-box AVM. It is also the same
"always show your work" rule db/406's own header states.

---

## 6. SEARCH UX — what real estate search products actually do

### 6.1 What the incumbents get right, concretely

**MLS / Matrix (the professional tool).** The things worth copying:
* **Saved searches with auto-notification.** Matrix's killer feature is not
  search, it is the *standing* search: "email me when anything matching this
  lands." For a lender that becomes "tell me when a new appraisal adds a comp
  within 0.5 mi of an active file."
* **The "cart".** Agents tick results into a cart across multiple searches, then
  act on the cart (email, print, CMA). The cart survives navigation. This is
  exactly the comp-selection flow.
* **Hotsheet.** A pre-canned "what changed in the last 24h/7d" view. Zero
  configuration, one click.
* **Column-configurable result grid** with saved layouts. Professionals want a
  dense table, not cards.

**Redfin.** Copy: the **split map/list with hover sync** (hovering a row pulls
the pin, hovering a pin highlights the row); **"draw your own boundary"** —
which without PostGIS you can still do as a point-in-polygon test in JS over a
bounded candidate set from a bounding box; filter state fully encoded in the
URL so a search is a shareable link; and the **sold-comps toggle** that flips the
whole map from listings to sales.

**RPR (Realtors Property Resource) — the closest analogue to what we are
building.** Copy: comp selection *with an adjustment grid* — you pick comps, then
adjust each for GLA/condition/site, and RPR shows the adjusted value indication
live. That is precisely the "select comps → build a valuation" flow, and it is
the thing that makes the product more than a list.

**Zillow.** Copy: filter **chips** (each active filter is a removable pill —
users lose track of what they filtered otherwise), the "similar homes" rail, and
the discipline of never showing a facet with a zero count.

### 6.2 The filters that actually matter (in priority order)

Ship these first, and resist the temptation to ship all 14 at once:

1. Location (city/ZIP/radius-from-subject) — **required**, everything else is a refinement
2. Sale date window — a comp search with no date window is not a comp search
3. Price range
4. Beds / baths
5. Square footage
6. Property type
7. — the fold —
8. Year built, lot size, units
9. Condition / quality (UAD) — professional filter, low usage, high value
10. "Used as an ARV comp" / "Used as an As-Is comp" — our unique filter, and it
    deserves prominent placement precisely because no one else has it

### 6.3 Result list vs map

* **Default to the list.** The map is a *filter*, not a browser; it is slow to
  scan and hostile on mobile. Redfin defaults to split; Matrix defaults to list.
  For a lender's desk, list-first is right.
* **Map as an optional right pane on desktop**, hidden on phones (the repo's
  mobile rule: the portal renders at device width and the map is the first thing
  that breaks that). Cluster pins above ~200 results.
* **The list row must be scannable in one line**: address · beds/baths · sqft ·
  sale price · sale date · distance · score. Anything else goes in the expanded
  row.
* **Hover sync both ways**, and keep the map viewport out of the filter set
  unless the user explicitly enables "search this area" — an implicit
  viewport filter makes results change when the user pans, which is disorienting.

### 6.4 The compare / "select these" tray

The single most important interaction in this product:

* A checkbox on every row. Selection is **global**, not per-page — it survives
  paging, re-filtering and navigating to a property detail.
* A **sticky bottom tray** showing "4 selected" with thumbnails/addresses, a
  "Clear" and two primary actions: **Compare** and **Build valuation**.
* Cap the selection at ~10 with a plain message ("An appraisal grid holds 6;
  pick your best 6"), because the downstream valuation is a grid.
* The tray persists in `sessionStorage` keyed by subject, so a refresh does not
  lose 20 minutes of work.
* **Compare** opens a side-by-side column-per-property table with the subject
  pinned in the first column and every differing cell highlighted — this is the
  UAD adjustment grid in embryo.

### 6.5 The "select comps → build a valuation" flow

```
subject file → "Find comps" → search (pre-filled from the subject's own facts)
   → tick 6 → tray → "Build valuation"
   → adjustment grid (per-comp $ adjustments, defaults suggested by the deltas)
   → value indication (weighted mean of adjusted prices) + a shown-work panel
   → save to the file as an internal value opinion (never an appraisal)
```

Non-negotiables for this codebase:

* **Pre-fill the search from the subject.** Radius 1 mi, sale window 12 months,
  same property type, GLA ±25%, same unit band. A user who has to type all that
  will not use the feature.
* **The output is an internal value indication, labelled as such**, and it may
  never be presented as, or used in place of, an appraisal. It shows how many
  comps, which ones, and every adjustment — db/406's own header commits to this.
* **Persist the selection**, not just the number. A valuation whose comps cannot
  be re-listed a year later is not evidence.

### 6.6 Saved searches

* Save = the filter object + a name + a `notify` flag. Store the *filter object*,
  not the SQL and not the URL.
* Notification runs as a bounded, self-gating digest sweep — the repo already has
  exactly this machinery in `src/lib/notification-digests.js` (audit-log-stamped
  once-per-period gates, business-hours windowing). Reuse it; do not invent a
  second scheduler.
* Show "12 new since you last looked" on the saved search, based on
  `properties.first_seen_at` / `last_seen_at`.

### 6.7 CSV export

* Export **exactly what is on screen** — same filters, same sort, same columns —
  or users will not trust it. This is the same lesson as `buildPipelineFilter`
  being shared by the pipeline list and the pipeline export (#152) so the
  spreadsheet can never drift from the view.
* Cap it (10,000 rows), stream it (`res.write` per row, never build the whole
  string in memory), and set `Content-Disposition`.
* **CSV injection guard**: any cell whose first character is `= + - @` or a tab
  must be prefixed with `'`. Address fields regularly start with `=` after a bad
  OCR read.
* Include a provenance header row: the filter description, the export timestamp,
  and "facts as stated by the most recent appraisal report — not public record."

```js
const CSV_UNSAFE = /^[=+\-@\t\r]/;
const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (CSV_UNSAFE.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
```

---

## 7. PERFORMANCE + SAFETY

### 7.1 Statement timeouts

A search screen is the easiest place in an application to write an accidental
cross join. Bound it in three layers:

**(a) Pool-wide default** — in `src/db.js`, node-postgres passes these straight
through:

```js
const pool = new Pool({
  connectionString: cfg.databaseUrl,
  ssl: sslConfig(),
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: parseInt(process.env.DB_POOL_MAX || '10', 10),
  // Server-side: Postgres cancels the query itself. This is the one that
  // actually frees the backend — a client-side timeout leaves it running.
  statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || '15000', 10),
  // Client-side backstop: pg rejects even if the server never answers.
  query_timeout: parseInt(process.env.DB_QUERY_TIMEOUT_MS || '20000', 10),
});
```

**(b) A tighter, per-query timeout for search** — search is user-facing and
should fail fast, while a nightly back-fill legitimately runs for minutes:

```js
/** Run one read with its own statement timeout. SET LOCAL only lives for the
 *  transaction, so it cannot leak onto the next user of this pooled client —
 *  which is exactly why a bare `SET statement_timeout` is wrong here. */
async function searchQuery(sql, params, ms) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${parseInt(ms || 8000, 10)}`);
    const r = await client.query(sql, params);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw e;
  } finally {
    client.release();
  }
}
```

Note `parseInt(...)` before interpolation — `SET LOCAL` cannot take a bind
parameter, so the value must be *proved* to be an integer. That is the one place
in this whole document where a value is concatenated into SQL, and it is
concatenated as a parsed integer, never as a string.

**(c) Translate the timeout into a useful message.** Postgres raises SQLSTATE
`57014` (`query_canceled`):

```js
if (e && e.code === '57014') {
  return res.status(400).json({
    error: 'That search was too broad to finish. Add a city, a ZIP, or a smaller date range.',
    code: 'search_timeout',
  });
}
```

### 7.2 Bounding page size and every other unbounded knob

```js
const PAGE_MAX = 100, PAGE_DEFAULT = 25;
const pageSize = Math.min(PAGE_MAX, Math.max(1, parseInt(req.query.limit, 10) || PAGE_DEFAULT));

const RADIUS_MAX_MI = 25;
const radiusMi = Math.min(RADIUS_MAX_MI, Math.max(0.1, Number(req.query.radiusMi) || 1));

const FACET_CEILING   = 20000;   // rows the facet CTE will consider
const CANDIDATE_CAP   = 300;     // rows the comp ranker will score
const COUNT_CAP       = 1000;    // capped-count ceiling
const EXPORT_MAX_ROWS = 10000;
const ZIP_LIST_MAX    = 50;      // items in a `= ANY($1)` array
const TEXT_MAX_CHARS  = 120;
```

Every one of those is a hard clamp on the server, not a validation error, with
exactly one exception: an out-of-range enum (`propertyType`, `sort`) is a 400,
because silently substituting a different *meaning* is worse than refusing.

### 7.3 Dynamic WHERE without SQL injection — the accumulator, stated as a rule

The pattern in §1.8. The rule that makes it safe, in one sentence:

> **Structure is chosen by our code from a closed vocabulary; every value is a
> `$n` placeholder. Nothing derived from a request is ever concatenated into
> SQL — with the single, parsed-integer exception of `SET LOCAL
> statement_timeout`.**

The four ways teams break that rule, and the guard for each:

| Break | Guard |
|---|---|
| `ORDER BY ${req.query.sort}` | whitelist map with a default (`SORTS[...] \|\| SORTS.recent`) |
| `WHERE ${col} = $1` with a client column name | whitelist map of column names |
| `IN (${ids.join(',')})` | `= ANY($1::uuid[])` — one bind, an array |
| `ILIKE '%${q}%'` | bind the *whole pattern*: `add('%' + q + '%')` |

And for `LIKE` specifically, escape the wildcards inside the user's text or a
user typing `%` matches everything:

```js
const likeValue = (s) => '%' + String(s).replace(/[\\%_]/g, (m) => '\\' + m) + '%';
```

A small self-check worth adding to the test suite, in the spirit of
`test-encompass-readonly.js` (which asserts a *property of the source* rather
than a behaviour):

```js
// scripts/test-property-search-injection.js
// Every SQL template literal in the search module must be free of ${...} except
// inside a `${add(...)}` call or a whitelisted-fragment interpolation.
const src = fs.readFileSync('src/lib/research/property-filter.js', 'utf8');
const bad = src.match(/\$\{(?!add\(|params\.length|SORTS|col\b)/g);
assert(!bad, 'raw interpolation in a SQL template: ' + JSON.stringify(bad));
```

### 7.4 Unbounded `ILIKE '%x%'` on a large table

Layered, cheapest guard first:

1. **Minimum length.** Under 3 characters, return `[]` with
   `{ hint: 'Type at least 3 characters' }`. Never issue the query. (The repo's
   `/borrowers/search` already does this at 2 chars — 3 is right for a much
   larger table.)
2. **Debounce client-side at 250 ms**, and cancel the in-flight request.
   Type-ahead against a warehouse without a debounce is a self-inflicted DoS.
3. **Prefer the anchored/FTS path** (§1.5). Route `ILIKE '%…%'` only as a
   *last-resort* branch, and only when a location filter is also present so the
   scan is bounded by an index:

```js
// The infix branch is allowed ONLY inside an already-narrowed set. On its own
// it is a seq scan of the warehouse; combined with a state/city/zip predicate
// the planner bitmap-ands and the pattern is a filter over a few thousand rows.
if (wantsInfix && !(q.state || q.city || q.zip)) {
  return { error: 'Add a state, city or ZIP to search inside an address' };
}
```

4. **Cap it.** `LIMIT 20` on a typeahead, always, and no count.
5. **Its own, shorter timeout** — `searchQuery(sql, params, 3000)`. A typeahead
   that takes 3 seconds has already failed the user; killing it protects the
   pool.
6. **Watch it.** `pg_stat_statements` (if available) or a simple duration log
   above 500 ms with the filter shape (never the user's text — it can contain
   PII) so a bad pattern is visible before it is a report.

### 7.5 Warehouse maintenance — the part that gets forgotten

The back-fill writes hundreds of thousands of rows in bursts, which is exactly
the workload that leaves autovacuum behind and makes every plan in this document
wrong:

```js
// At the end of every ingest/back-fill pass. Cheap, and without it the planner
// is estimating against a table that looked empty when it last analysed.
await db.query('ANALYZE properties');
await db.query('ANALYZE property_observations');
```

Also raise the statistics target on the columns the planner has to estimate
ranges over — the default 100 buckets is thin for a nationwide price distribution:

```sql
ALTER TABLE properties ALTER COLUMN last_sale_price SET STATISTICS 500;
ALTER TABLE properties ALTER COLUMN gla             SET STATISTICS 500;
ALTER TABLE properties ALTER COLUMN city            SET STATISTICS 500;
```

And tell the planner that `state`, `city` and `zip` are **correlated** — without
this it multiplies their selectivities as if independent and estimates ~0 rows
for `state='NJ' AND city='Paterson'`, which is how you get a nested loop where
you wanted a bitmap scan:

```sql
CREATE STATISTICS IF NOT EXISTS stx_properties_geo (dependencies, ndistinct)
  ON state, city, zip FROM properties;
```

(Extended statistics are core Postgres from 10 onward — no extension.)

---

## RECOMMENDED IMPLEMENTATION

An opinionated blueprint. Build it in this order; each stage ships independently.

### R1 — Migration `db/408_property_search.sql` (one file, idempotent)

*(`db/406` is the research warehouse and `db/407` is "build your own valuation";
408 is the next free number at the time of writing. Re-check before creating the
file — two sessions grabbing the same number is a real collision here, and the
standing rule is that **you** renumber, never the other session.)*

1. Generated ordinals: `condition_rank`, `quality_rank`, `baths_total` (§1.2, §1.6).
2. Derived `lot_sqft numeric` (filled by JS in the ingest — **no PL/pgSQL twin**).
3. Denormalised `arv_comp_count`, `as_is_comp_count` + the guarded back-fill (§1.7).
4. Generated `address_tsv` + `GIN` index (§1.5b).
5. `geo_cell` generated integer + btree (§4.3) — build it now, use it when the
   plain lat/lng box stops being enough.
6. `pilot_distance_mi()` — `IMMUTABLE STRICT PARALLEL SAFE` (§4.2).
7. Indexes: the two hot composites, the keyset expression index, the partial
   sold-only price/date indexes, the partial rank indexes, the covering list
   index, `idx_prop_obs_property_set`.
8. Extended statistics on `(state, city, zip)`; `SET STATISTICS 500` on
   `last_sale_price`, `gla`, `city`.
9. The optional `pg_trgm` attempt inside a swallowing `DO $$ … EXCEPTION $$`,
   with the trigram index created only if the extension actually materialised.
10. `ANALYZE properties;` as the last statement.

### R2 — `src/lib/research/` (pure, unit-testable, no route knowledge)

| Module | Responsibility |
|---|---|
| `uad.js` | `ratingRank` / `ratingRange` — **the one place the C1-is-best inversion is written down** |
| `lot-area.js` | text → `lot_sqft`, returning `null` rather than guessing |
| `property-filter.js` | `buildPropertyFilter(q, opts)` → `{ where, params, add, order, error }` — the ONE filter builder, shared by list, facets, count, map and CSV export so they can never drift |
| `geo.js` | `boundingBox`, `cellsForBox`, `RINGS`, the mile constants |
| `comp-score.js` | `scoreComp(subject, cand, opts)` — pure, with a breakdown and a coverage figure |
| `search-caps.js` | one-shot `pg_trgm` capability probe |
| `cursor.js` | `encodeCursor` / `decodeCursor` with the filter fingerprint |

### R3 — `src/routes/property-search.js`, mounted at `/api/research`

| Route | Returns |
|---|---|
| `GET /properties` | one page (keyset), plus facets **only when `cursor` is absent**, plus a capped count |
| `GET /properties/:id` | the roll-up + every `property_observations` row + `property_sales` + photos — "show your work" |
| `GET /properties/nearby` | expanding-ring radius search from a lat/lng or a `subjectId` |
| `GET /comps` | `?subjectId=` → gated candidates, JS-scored, ranked, with breakdowns |
| `GET /properties/export.csv` | streamed, same builder, capped at 10,000, injection-guarded |
| `GET/POST /saved-searches` | the filter object + a `notify` flag |

Every route: `searchQuery(...)` with an 8-second `SET LOCAL statement_timeout`;
`57014` → a 400 that tells the user how to narrow; page size clamped to 100;
staff-only (`properties` carries no borrower PII, but it does carry our whole
comp book and it is not a borrower-facing surface).

### R4 — The default query, end to end

```js
router.get('/properties', async (req, res) => {
  try {
    const q = req.query;
    const f = buildPropertyFilter(q, { soldOnly: q.soldOnly !== '0' });
    if (f.error) return res.status(400).json({ error: f.error });

    const sortKey = String(q.sort || 'recent');
    const fp = filterFingerprint(q, sortKey);
    const cur = decodeCursor(q.cursor, sortKey, fp);
    if (cur && cur.error) return res.status(400).json({ error: cur.error, code: 'bad_cursor' });

    const pageSize = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 25));
    const params = [...f.params];
    const add = (v) => { params.push(v); return `$${params.length}`; };

    let keyset = '';
    if (cur) keyset = `AND (COALESCE(p.last_sale_date, DATE '0001-01-01'), p.id) < (${add(cur.key)}::date, ${add(cur.id)}::uuid)`;
    const lim = add(pageSize + 1);

    const rowsSql = `
      SELECT p.id, p.display_address, p.city, p.state, p.zip,
             p.beds, p.baths_full, p.baths_half, p.baths_total, p.gla, p.year_built,
             p.units, p.property_type, p.condition_uad, p.quality_uad,
             p.last_sale_price, p.last_sale_date, p.comp_count, p.subject_count,
             p.arv_comp_count, p.as_is_comp_count,
             COALESCE(p.last_sale_date, DATE '0001-01-01') AS sort_key
        FROM properties p
       WHERE ${f.where}
         ${keyset}
       ORDER BY ${f.order}
       LIMIT ${lim}`;

    // The page and the capped count are INDEPENDENT queries on the pool, issued
    // together. That is one network round trip's worth of latency, and it keeps
    // count(*) OVER () — which would force a full materialisation of the filtered
    // set on EVERY page — out of the page query entirely.
    const countSql = `SELECT count(*)::int AS n FROM (SELECT 1 FROM properties p WHERE ${f.where} LIMIT 1001) t`;
    const [rowsR, cntR] = await Promise.all([
      searchQuery(rowsSql, params, 8000),
      searchQuery(countSql, f.params, 5000),
    ]);

    const rows = rowsR.rows.slice(0, pageSize);
    const hasMore = rowsR.rows.length > pageSize;
    const n = cntR.rows[0].n;
    const count = n > 1000 ? { mode: 'capped', total: 1000, cap: 1000 }
                           : { mode: 'exact',  total: n };

    // Facets on page 1 only — they cannot change while the filters do not.
    const facets = cur ? null : await loadFacets(f);

    res.json({
      rows, count, facets,
      nextCursor: hasMore ? encodeCursor(rows[rows.length - 1], sortKey, fp) : null,
      provenance: 'Facts as most recently stated by an appraisal report — not public record.',
    });
  } catch (e) {
    if (e && e.code === '57014') {
      return res.status(400).json({ error: 'That search was too broad to finish. Add a city, a ZIP, or a smaller date range.', code: 'search_timeout' });
    }
    console.error('[property-search]', db.describeError ? db.describeError(e) : e);
    res.status(500).json({ error: 'server error' });
  }
});
```

### R5 — The decisions, restated as rules

1. **No `($1 IS NULL OR col = $1)`, anywhere.** Build the WHERE dynamically,
   bind every value. The pattern *appears* to work under node-postgres' unnamed
   statements and collapses to a seq scan the moment a plan goes generic — an
   intermittent production failure that no test catches (§1.8). Add
   `SET plan_cache_mode = force_generic_plan` to the DB test so a regression is
   caught deterministically.
2. **One filter builder, shared by list, count, facets, map and CSV.** The
   pipeline list/export precedent (#152) exists because a second copy always
   drifts.
3. **Keyset pagination by default; OFFSET only behind a hard cap.** The corpus
   grows monotonically and the ingest writes constantly, so OFFSET is both slow
   and *wrong*.
4. **Capped count by default, planner estimate above the cap, exact only when
   small — and the UI renders which one it got.** "About 4,300" is honest;
   "4,317" from an estimate is not.
5. **Facets on page 1 only, over a `LIMIT 20000` materialised CTE, with at most
   one filter-excluded facet.** Say "counts based on the first 20,000 matches"
   when the ceiling is hit.
6. **UAD ratings are ordinal smallints, and the inversion (C1 is best) lives in
   `uad.js` and nowhere else.**
7. **Geo is bounding box (btree) + haversine refine, with `pilot_distance_mi`
   `STRICT` so a missing coordinate is NULL, never zero.** No coordinates → a
   labelled ZIP-match fallback branch that sorts last. Coordinate back-fill runs
   as a bounded boot sweep through `address-canon`'s existing
   `geocodeRewriteIsSafe` guard — a geocoder supplies coordinates, never address
   text.
8. **Gate in SQL, score in JS.** SQL narrows to ≤300 candidates; `comp-score.js`
   produces the score *and the breakdown*, because the deliverable is the
   explanation. A missing factor is dropped and the score renormalised, with
   `coverage` reported — never defaulted to a favourable value.
9. **Every value bound; whitelist every fragment; `SET LOCAL statement_timeout`
   is the only parsed-integer interpolation in the module.**
10. **`ANALYZE` after every ingest pass, extended statistics on
    `(state, city, zip)`, and `SET STATISTICS 500` on the wide-range columns.**
    Every plan in this document assumes the planner has current statistics.
11. **The search says what it is.** Every response and every export carries the
    provenance line: these are facts *stated by appraisal reports*, rolled up to
    the most recent statement — not public record, not an AVM, not an appraisal.
    That is db/406's own commitment, and the search engine is the first surface
    where a user could forget it.

### R6 — Tests to ship with it

| Test | Kind | Asserts |
|---|---|---|
| `test-property-filter-pure.js` | pure | every filter emits the right SQL + bind count; an absent filter emits nothing; `sort` injection resolves to the default; UAD inversion (min "C4" → `rank <= 4`) |
| `test-comp-score-pure.js` | pure | the full breakdown; a missing factor is dropped and renormalised (never 0, never subject-equals-candidate); bonuses capped; identical twin next door scores 100 |
| `test-geo-pure.js` | pure | degree math at several latitudes against known distances; polar clamp; cell coverage |
| `test-property-search-db.js` | real Postgres | the generated columns compute correctly for dirty inputs (`'c3'`, `'C03'`, `NULL`); keyset paging visits every row exactly once across a full walk; the capped count caps; the radius search finds a planted property at a known distance and excludes one just outside; `EXPLAIN` shows an index scan, **not** a seq scan, for the default city query |
| `test-property-search-plan-db.js` | real Postgres | with `plan_cache_mode = force_generic_plan`, the dynamic builder still produces an index plan (the guard against anyone reintroducing the `$1 IS NULL` pattern) |
| `test-property-search-injection.js` | pure/source | no raw `${}` interpolation in any SQL template in `src/lib/research/` |
