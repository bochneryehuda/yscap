# Per-Field Validation Ruleset — "never store a guessed or wrong value"

Strict accept/reject/normalize rules for extracting Fannie Mae appraisal XML (MISMO 2.6,
`<VALUATION_RESPONSE MISMOVersionID="2.6">`, data in element **attributes**). Owner rule:
**never guess; only store fields we KNOW.** Every rule below was re-audited against the **37**
stripped sample files (20× FNM1004, 13× FNM1025, 4× FNM1073) and cites the real counter-examples
where a naive rule would store garbage.

Read alongside: `field-reliability.md` (how often present), `placement-variability.md` (where it
hides), `error-handling-and-confidence.md` (confidence model), `expanded-field-catalog.md` (paths),
`1073-condo-notes.md` (condo delta).

## How to read the confidence column
- **definite** — passed the acceptance test from a trusted anchor → **auto-store**.
- **non_uad** — present but not in the standard code (e.g. condition written "Good"/"BRICK") →
  **store + "verify" badge**, never treated as a C/Q code.
- **needs_verify** — stored but soft-flagged because a cross-check tripped or the source is a decoy-prone
  location.
- **missing** — failed the test / absent / placeholder → **leave blank**, surface "could not read X",
  optionally open an officer condition. Never a silent blank.

**Global normalizations (apply before every test below):** trim; collapse internal double-spaces;
decode XML entities (`&amp;`→`&`, `&quot;`→`"`); strip a value that is only `--`, `-`, `.`, `N/A`,
`n/a`, `NA`, `none`, `unknown`, `tbd`, `see addendum`, `see attached`, `xxx`, `0000` → treat as MISSING.
**Money/count normalization:** strip `$`, spaces and thousands **commas**, then parse — commas are
everywhere in this corpus (appraised value `"850,000"`, GLA `"3,748"`, tax `"9,630"`, site-improvements
`"15,000"`) and Node's `Number("850,000")` is `NaN`, so an un-stripped money field silently drops to
MISSING or, worse, parses the pre-comma chunk.

---

## Section A — Property identity (matching keys)

| Field | Accept test | Reject if (→ result) | Normalize | Cross-checks | Confidence / store? |
|---|---|---|---|---|---|
| **state** | exactly 2 letters `^[A-Za-z]{2}$` **and** ∈ US-state set, read from the **subject `<PROPERTY>` element's `_State`** only | not 2 alpha (e.g. `"06"`) → missing; numeric → missing | **uppercase** | must be consistent with ZIP's state prefix (soft) | definite. ⚠ Kleinman `_State="Ct"` needs uppercase; **10421150** first `_State` in file is `"06"` (a mis-mapped comp) — anchoring to `<PROPERTY>` gives correct `"NY"` |
| **zip** | `^\d{5}(-\d{4})?$` from subject `<PROPERTY>` `_PostalCode` | <5 digits (`"02"`), letters, empty → missing | keep 5-digit core; store +4 separately if present | ZIP↔state consistency (soft) | definite. ⚠ ZIP+4 common (`07960-2758`); **10421150** first `_PostalCode`=`"02"` is garbage from a comp; **08821926** first `_PostalCode` in file = appraiser office `07960-2758`, subject is `07036-3050` → **must read from `<PROPERTY>`, not first match** |
| **address / city / county** | non-empty after trim, from subject `<PROPERTY>` attributes | empty / placeholder → missing | trim; title-case city optional | address house-number should appear in APN-independent match | definite |
| **apn** | non-empty after trim; `[A-Za-z0-9].*` (contains ≥1 alphanumeric) | empty, only punctuation/`--` → missing | trim; collapse spaces; **do not** split multi-parcel | — | definite. Formats vary wildly and that is OK: `"57 / 135"` (09432272), `"11-21401-00020&11-21401-00021"` (09769678), `"0229-S-00180 & 0229-S-00179"` (Werzberger) are all valid; keep verbatim, never "clean" out the second parcel |
| **apn source** | prefer core `_IDENTIFICATION@AssessorsParcelIdentifier`; fall back to `PARCEL_IDENTIFIER@GSEAssessorsParcelIdentifier` (1004 only) | both empty → missing | — | if both present and differ → needs_verify | definite (record which source) |
| **census_tract / legal / neighborhood** | non-empty | empty → missing | trim | — | definite (always present 37/37) |
| **occupancy / rights** | enum ∈ {Vacant, TenantOccupied, OwnerOccupied} / {FeeSimple, Leasehold} | value not in enum → non_uad | — | — | definite |
| **flood_zone** | `NFIPFloodZoneIdentifier` short code (`X`, `AE`, `A`, …) | empty → missing | uppercase | special-hazard flag consistency (soft) | definite |

---

## Section B — Parties

| Field | Accept test | Reject if | Normalize | Cross-checks | Confidence / store? |
|---|---|---|---|---|---|
| **borrower / entity name** | ≥1 party name non-empty (person or LLC) | ALL party slots empty → **hard flag** (never store blank) | trim | must match file borrower OR vesting LLC (soft review) | definite |
| **owner_of_record** | `_OWNER@_Name` non-empty | empty / `"N/A"` → missing | trim | — | definite (32/37) |
| **lender** | non-empty | empty → missing | trim | — | definite |
| **amc** | `GSEManagementCompanyName` non-empty | empty → missing (do **not** invent) | trim | — | definite when present (20/37); else blank, NOT an error (optional field) |

---

## Section C — Physical / subject

| Field | Accept test | Reject if | Normalize | Cross-checks | Confidence / store? |
|---|---|---|---|---|---|
| **year_built** | integer `∈ [1700, currentYear]` | 0, empty, >currentYear, <1700, non-numeric → missing | parse int | — | definite. Stern `2026` (new-build condo) valid == currentYear; nothing here is out of range |
| **units** | 1004→exactly `1`; 1025→`∈ {2,3,4}`; 1073→`1` | 1025 with units 1 or >4 → needs_verify; 0 → missing | parse int from `LivingUnitCount` | must agree with form type; 1025 with `_UNIT_GROUP` row count | definite. 1004 all `1`; 1025 `2/3/4` (Kaufman=4); **1073 `LivingUnitCount` is BLANK → imply 1 for condo, do not error** |
| **gla** | integer > 250 and < 25000 sqft | 0, empty, non-numeric → missing | **strip commas** then int | comp GLAs within a band (soft) | definite. Commas present: `"1,994"`,`"3,748"`,`"2,494"`. On non-UAD 1025 subject GLA may be blank → sum `_UNIT_GROUP` GLAs or leave blank (never 0) |
| **beds / rooms** | integer ≥ 0, rooms ≥ beds | negative, non-numeric → missing | int | rooms ≥ beds ≥ 0 (soft) | definite |
| **baths** | `^\d+(\.\d)?$` (UAD `full.half`) or plain int | empty, non-numeric → missing | **parse `2.1` = 2 full + 1 half**; `1.0`=1 full; plain `3`=3 full | — | definite. Formats: `"2.1"`,`"1.0"`,`"3"`,Stern `"3.1"`,Danziger `"1.1"`. On 1025 baths are per-unit — read from `_UNIT_GROUP`, the subject-level first match may be an aggregate |
| **stories / design** | non-empty | empty → missing | trim | — | definite |
| **lot_area** | numeric part > 0 after stripping unit suffix (`"16117 sf"`) | 0, empty, `"Subject to Survey"` → missing | strip `sf`/commas → int | — | definite |
| **lot_dims** | free text non-empty | empty, placeholder → missing | trim | — | definite (free text; `"92.5 x 145'…"`) |
| **zoning_id / desc / compliance** | non-empty (compliance enum ∈ {Legal, LegalNonConforming, NoZoning, Illegal}) | empty → missing | trim; enum for compliance | — | definite |
| **basement_sqft** | integer ≥ 0 | non-numeric → missing (**0 is meaningful** = no/none) | int | — | definite (keep 0) |
| **heating** | non-empty enum/string | empty → missing | trim | — | definite |
| **subject condition (C1–C6)** | `^C[1-6]$` from **seq-0** `COMPARISON_DETAIL@GSEOverallConditionType` (1004/1073) or seq-0 `SALE_PRICE_ADJUSTMENT[_Type=Condition]@_Description` | not `C1–C6` (word rating) → **non_uad** (store word, flag); wrong seq → reject | uppercase | — | definite if `C#`, else non_uad. Words seen: `"GOOD"` (10636060), `"Avg-Good"` (09282104), `"Good"` (Kaufman) → non_uad, never coerced to a C-code |
| **subject quality (Q1–Q6)** | `^Q[1-6]$` from seq-0 same containers | not `Q1–Q6` → **non_uad** | uppercase | — | definite if `Q#`, else non_uad. ⚠ **`Q="BRICK"` (10636060)** is a wall MATERIAL, not a quality code — the classic decoy; also `"Average"` (09282104, Kaufman) → non_uad |

---

## Section D — Values (critical)

| Field | Accept test | Reject if | Normalize | Cross-checks | Confidence / store? |
|---|---|---|---|---|---|
| **appraised_value** | integer > 0, from `VALUATION@PropertyAppraisedValueAmount` | 0, empty, non-numeric → **CRITICAL flag** (never blank-store an always-present field) | **strip commas** → int | should ≈ `ValueIndicatedBySalesComparisonApproachAmount` (holds **37/37** in corpus) | definite. Commas in 8 files (`"850,000"`,`"650,000"`,`"2,230,000"`…) |
| **value_sales (sales-comparison indicated)** | integer > 0 | 0, empty → missing | strip commas | == appraised in every sample; large gap → needs_verify | definite |
| **arv / as_is** | see **Section G** (special rules) | — | — | As-Is ≤ ARV | governed by Section G — no estimates stored |
| **value_cost / site_value** | integer > 0 | 0, empty → missing | strip commas | site_value < cost value (soft) | definite when present |
| **income value / grm** | value > 0 | 0/empty → missing (income files only) | strip commas | GRM × monthly rent ≈ income value (soft) | definite on 1025/ACI-1004; blank on plain 1004 is NOT an error |
| **contract_price** | integer > 0 | 0, empty, or **refinance (no contract)** → missing, not 0 | strip commas | ≤ ~1.5× appraised (soft) | definite when present; many are refis → legitimately blank |
| **effective_date** | valid calendar date | invalid / empty → missing | → `YYYY-MM-DD` | **effective_date ≤ report_signed** (holds 37/37) | definite |
| **report_signed** | valid calendar date, ≤ today | invalid, future > today → needs_verify | → `YYYY-MM-DD` | ≥ effective_date | definite |
| **inspection_date / contract_date** | valid date | invalid/empty → missing | → `YYYY-MM-DD` | inspection ≤ signed (soft) | definite when present |

**Date normalization detail:** two vendor formats coexist — ISO `2026-05-11` (a la mode/ACI) and
`MM/DD/YYYY` `01/28/2026` (blank-vendor 1025s). Accept both, **normalize to `YYYY-MM-DD`**, reject a
2-digit year or a swapped `DD/MM`. License-expiry dates mix the same two formats (`2026-04-30` vs
`12/31/2027`).

---

## Section E — Multi-unit (1025) & condo (1073)

| Field | Accept test | Reject if | Normalize | Cross-checks | Confidence / store? |
|---|---|---|---|---|---|
| **per-unit rent (actual/market)** | numeric > 0 | 0/empty → missing | strip commas | actual vs market within band (soft) | definite on 1025; blank on 1004 |
| **actual/market gross monthly rent** | numeric > 0 | 0/empty → missing | strip commas | = Σ per-unit (soft) | definite on 1025 |
| **condo HOA fee (1073)** | numeric ≥ 0 with period | empty → missing | strip `$`, capture `_PeriodType` | — | definite on 1073 |
| **project name / design type (1073)** | non-empty; design ∈ {Midrise, Highrise, Garden, Rowhouse, …}Project | empty → missing | trim | only when form=1073 | definite on 1073; **empty `PROJECT@_Name` on 1004/1025 is normal → blank, not error** |

---

## Section F — Appraiser & metadata

| Field | Accept test | Reject if | Normalize | Cross-checks | Confidence / store? |
|---|---|---|---|---|---|
| **appraiser_name / company** | non-empty | empty → **hard flag** (always present) | trim | — | definite |
| **license_id / state / exp** | id non-empty; state 2-alpha; exp valid date | empty → missing; exp < effective_date → needs_verify (expired) | uppercase state; date→ISO | license_state plausibility | definite |
| **appraiser_phone / email** | phone ≥10 digits; email `^[^@]+@[^@]+\.[^@]+$` | malformed → missing | digits only / lower email | — | definite |
| **form_type** | `∈ {FNM1004, FNM1025, FNM1073}` | anything else → **CRITICAL** (route halts; unknown form) | — | drives units/section routing | definite — **route by this, never assume** |
| **loan id (YSCAP)** | `AppraiserAdditionalFileIdentifier` non-empty | empty → missing | trim | — | definite (33/33) |
| **supervisor** | name non-empty | element present but empty → missing (not error) | trim | — | definite only when co-signed (rare) |

---

## Section G — The As-Is / ARV special rules (restate exactly)

**Owner directive:** ARV is mandatory on reno/ground-up; **As-Is is stored ONLY when DEFINITE** — no
OCR, no estimate-as-truth. When not definite → **do not store**, open officer condition
`appraisal_as_is_verify`.

### ARV (after-repair value)
1. **Gate:** the headline `VALUATION@PropertyAppraisedValueAmount` is an ARV **only when** the report
   is subject-to — decided by `_RECONCILIATION/_CONDITION_OF_APPRAISAL@_Type ∈
   {SubjectToRepairs, SubjectToCompletion}` **OR** hypothetical-/as-repaired language in the narrative.
   **Never trust the enum alone** (it can mislabel) and never the value alone.
   - Accept: integer > 0 after comma-strip; corroborated by sales/cost approach values (all equal in corpus).
2. **Pure As-Is report** (`_Type = AsIs`, no as-repaired language — all 4 condos + the 3 `AsIs` files):
   there is **no ARV**; store ARV = N/A, do **not** echo the as-is figure as the ARV.
3. If subject-to but no value resolves → **CRITICAL blocking flag** + officer condition. (Resolved
   37/37 at step 1 in this corpus.)
4. **Multi-row `_CONDITION_OF_APPRAISAL`:** 08108509 and Kleinman carry **both** `SubjectToRepairs`
   **and** `AsIs` rows — presence of a `SubjectTo*` row means the headline is the ARV; the `AsIs` row
   does not downgrade it.

### As-Is value — definite-only
**Definite** = one of:
- the structured value **only when** the sole condition type is `AsIs` **and no** hypothetical
  language (then the headline value *is* the As-Is), **or**
- an **exact As-Is figure mined from the narrative**, priority sweep in order:
  `_ConditionsComment` → `_SummaryComment` → `_CurrentSalesAgreementAnalysisComment` → `_Comment`
  → `_AdditionalDescription` → `FORM/@AppraisalAddendumText`.
  Accept a match only when the number is explicitly labeled as-is, e.g. regex
  `(?:"?AS[\s-]?IS"?\s*VALUE|as[- ]is\s+value(?:\s+is)?)\s*[:=]?\s*\$?([\d,]{4,})` → strip commas → int.
  ✅ Real definite hit: 09405263 `_ConditionsComment="…"AS IS" VALUE $420,000"` (with ARV = 640000).

**Reject (→ do NOT store, open `appraisal_as_is_verify`):**
- **The decoy `COST_ANALYSIS@SiteOtherImprovementsAsIsAmount`** — this is the cost-approach *as-is
  value of site improvements*, small figures like `"5000"`, `"15,000"`, `"50000"` (present ~30/37).
  A naive "grab anything with AsIs in the name" would store **$5,000** as the As-Is of a $575,000
  property. **Never** read As-Is from this attribute.
- A comp-cluster estimate (only a derived number) → not definite → suggestion only, never saved.
- Narrative that is subject-to but carries **no** as-is figure → officer condition. ✅ 10182152, LOEFFLER,
  08108509 say "subject to the attached scope of work" with no dollar figure → each opens the condition.
- PDF-only figure → officer condition.

**Outcome:** definite As-Is → store (`confidence: definite`). Otherwise → blank + condition; a
comp-cluster number may be shown **next to the officer input as a suggestion only**, never auto-saved.

---

## Section H — Comps grid

| Field | Accept test | Reject if | Normalize | Cross-checks | Confidence / store? |
|---|---|---|---|---|---|
| **n_comps** | count of **distinct `PropertySequenceIdentifier ≥ 1`** with a `PropertySalesAmount` | counting seq-0 as a comp; using MAX(seq) as the count → wrong | — | 1004/1073 ≥ 3; 1025 ≥ 3 | definite. ⚠ **seq-0 is the SUBJECT** — exclude it. ⚠ Sequences skip numbers: 08821926/09405263/10391589 run `0,1,2,3,4,5,7,8,9` (**no 6**) — `MAX(seq)` overcounts; count distinct present seqs |
| **comp sale price / adjusted price** | integer > 0 | 0/empty → drop that comp row | strip commas | adjusted within a sane band (e.g. 0.5–1.75×) of appraised → else needs_verify | definite per row |
| **comp gross adj %** | numeric ≥ 0, read `SalesPriceTotalAdjustmentGrossPercent` | wrong attribute spelling → 0/missing | float | > 25% net or > 100% gross → soft flag | definite |
| **comp net adj %** | numeric (**may be negative**), read `SalePriceTotalAdjustmentNetPercent` | reading the *Gross* spelling by mistake | float | — | definite. ⚠ **Attribute spelling differs:** gross = `Sales`Price…, net = `Sale`Price… — a copy-paste that reuses one spelling silently returns the wrong column or NaN |
| **comp condition/quality (coded)** | `C1–C6` / `Q1–Q6` per comp | word rating → non_uad | uppercase | — | definite/non_uad, same rule as subject |

---

## Tripwires — automated regression / weird-vendor catches

Run these on **every** import; a hit means "a parser assumption just broke or a new vendor arrived,"
not a silent pass:

1. **Always-present field came back blank** — appraised_value, form_type, address, state, zip, year_built,
   appraiser_name, effective_date, report_signed missing on ANY file → block + "could not read X".
2. **form_type not in {FNM1004, FNM1025, FNM1073}** → halt routing (unknown form / new vendor).
3. **1004 or 1073 with `units ≠ 1`, or 1025 with `units ∉ {2,3,4}`** → flag (mis-parse or new product).
4. **0 comps** (no seq ≥ 1 with a sale price) on any form → flag; a URAR/condo always has ≥3.
5. **Comp count from MAX(seq) ≠ count of distinct seq ≥ 1** → flag the sequence-gap case (08821926 pattern)
   so we never count a skipped number as a comp.
6. **state is not 2 uppercase letters after normalize**, or **zip not `\d{5}(-\d{4})?`** → flag the
   mis-mapped-element decoy (10421150 `"06"`/`"02"`).
7. **appraised_value ≠ sales-comparison value by > ~5%** → soft flag (held 37/37; a break is suspicious).
8. **effective_date > report_signed**, or either date's year outside `[2000, currentYear]` → flag
   (date-format / 2-digit-year corruption).
9. **year_built outside `[1700, currentYear]`** → flag.
10. **As-Is equals `SiteOtherImprovementsAsIsAmount`** (or As-Is < 10% of ARV) → almost certainly the
    cost-approach decoy was stored → block and re-open the officer condition.
11. **subject condition/quality is not `C1–C6`/`Q1–Q6`** → non_uad badge (catches `BRICK`,`Avg-Good`,`Good`);
    if the share of non_uad files jumps vs baseline (3/37 today) → a vendor changed its encoding.
12. **A money field still contains a comma or `$` after normalization** → the comma-strip chokepoint was
    bypassed (would turn `"850,000"` into NaN downstream).
13. **subject-to report but no ARV resolved**, or **pure-AsIs report that emitted an ARV** → value-engine
    regression (ARV must be mandatory on reno, N/A on pure as-is).
14. **A field read as the file's first attribute match differs from the same field on `<PROPERTY>`**
    (zip/state) → anchor drift (grabbing appraiser-office or comp values — 08821926 office `07960` decoy).
