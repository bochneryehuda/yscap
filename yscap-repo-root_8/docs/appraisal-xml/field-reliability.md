# Field Reliability & Error-Handling Map — across all 33 appraisals

Every field the parser can pull, and how often it is actually present across all 33 files (20× 1004, 13× 1025). Basis for the mapping and error handling.

**Tiers:** ALWAYS = every file · USUALLY ≥80% · SOMETIMES ≥40% · RARELY <40%. See `placement-variability.md` for *how* each field can be built differently.

## Property identity (matching)

| Field | Present | Tier | Notes |
|---|---|---|---|
| address | 33/33 | ALWAYS |  |
| city | 33/33 | ALWAYS |  |
| county | 33/33 | ALWAYS |  |
| state | 33/33 | ALWAYS |  |
| zip | 33/33 | ALWAYS |  |
| apn | 32/33 | USUALLY |  |
| APN (alt GSE location) | 20/33 | SOMETIMES |  |
| census_tract | 33/33 | ALWAYS |  |
| legal | 33/33 | ALWAYS |  |
| neighborhood | 33/33 | ALWAYS |  |
| occupancy | 33/33 | ALWAYS |  |
| rights | 33/33 | ALWAYS |  |
| flood_zone | 32/33 | USUALLY |  |

## Parties (matching)

| Field | Present | Tier | Notes |
|---|---|---|---|
| borrower / entity name | 33/33 | ALWAYS |  |
| name looks like an LLC/entity | 33/33 | ALWAYS | 1 LLC / 32 person |
| a party name exists | 33/33 | ALWAYS | if a file ever has NEITHER borrower nor LLC → hard flag |
| owner_of_record | 32/33 | USUALLY |  |
| lender | 33/33 | ALWAYS |  |
| amc | 20/33 | SOMETIMES | appraisal-management-company; not always named |

## Physical / subject

| Field | Present | Tier | Notes |
|---|---|---|---|
| prop_type | 33/33 | ALWAYS |  |
| units | 32/33 | USUALLY |  |
| year_built | 33/33 | ALWAYS |  |
| eff_age | 32/33 | USUALLY |  |
| gla | 30/33 | USUALLY | blank on non-UAD 1025s (stored per-unit) |
| rooms | 33/33 | ALWAYS |  |
| beds | 33/33 | ALWAYS |  |
| baths | 30/33 | USUALLY | blank on non-UAD 1025s (stored per-unit) |
| stories | 33/33 | ALWAYS |  |
| design | 33/33 | ALWAYS |  |
| lot_area | 33/33 | ALWAYS |  |
| lot_dims | 33/33 | ALWAYS |  |
| zoning_id | 33/33 | ALWAYS |  |
| zoning_desc | 33/33 | ALWAYS |  |
| zoning_compliance | 33/33 | ALWAYS |  |
| basement_sqft | 33/33 | ALWAYS |  |
| heating | 33/33 | ALWAYS |  |
| subject condition (C1–C6) | 30/33 | USUALLY | non-UAD files use words → flag, not a C/Q code |
| subject quality (Q1–Q6) | 30/33 | USUALLY | non-UAD files use words → flag, not a C/Q code |

## Values (critical)

| Field | Present | Tier | Notes |
|---|---|---|---|
| appraised_value | 33/33 | ALWAYS |  |
| condition_of_appraisal | 33/33 | ALWAYS |  |
| value_sales | 33/33 | ALWAYS |  |
| value_cost | 31/33 | USUALLY |  |
| site_value | 32/33 | USUALLY |  |
| income-approach value | 23/33 | SOMETIMES | income files only (all 1025 + a few 1004) |
| grm | 19/33 | SOMETIMES | income files only (all 1025 + a few 1004) |
| contract_price | 31/33 | USUALLY |  |
| effective_date | 33/33 | ALWAYS |  |
| contract_date | 31/33 | USUALLY |  |
| inspection_date | 29/33 | USUALLY |  |
| report_signed | 33/33 | ALWAYS |  |

## Multi-unit (1025)

| Field | Present | Tier | Notes |
|---|---|---|---|
| actual gross monthly rent | 13/33 | RARELY | income files only (all 1025 + a few 1004) |
| market gross monthly rent | 13/33 | RARELY | income files only (all 1025 + a few 1004) |
| per-unit rent rows | 33/33 | ALWAYS |  |

## Appraiser

| Field | Present | Tier | Notes |
|---|---|---|---|
| appraiser_name | 33/33 | ALWAYS |  |
| appraiser_company | 33/33 | ALWAYS |  |
| license_id | 33/33 | ALWAYS |  |
| license_state | 33/33 | ALWAYS |  |
| license_exp | 33/33 | ALWAYS |  |
| appraiser_phone | 33/33 | ALWAYS |  |
| appraiser_email | 33/33 | ALWAYS |  |
| supervisor | 1/33 | RARELY | only when a supervisory appraiser co-signs |

## Comps / photos

| Field | Present | Tier | Notes |
|---|---|---|---|
| n_comps | 33/33 | ALWAYS |  |
| full report PDF | 33/33 | ALWAYS |  |
| per-photo metadata | 33/33 | ALWAYS |  |

## Borrower / LLC matching rule

The appraisal names a party in **33/33** files — usually the **person** (guarantor), not the LLC. Match the file on **either** the borrower name **or** the vesting LLC:
1. Appraisal party = file borrower **or** file LLC → OK.  2. Neither matches → review flag.  3. No party name at all → hard flag.

## Error-handling principles

- Every field carries **source + confidence** (exact / estimate / not-in-XML).
- A missing ALWAYS/USUALLY field on a new file → surface "could not read X", never a silent blank.
- ESTIMATE or non-UAD values → shown but flagged "confirm".
- Route by `AppraisalFormType` (1004 vs 1025); never assume.
