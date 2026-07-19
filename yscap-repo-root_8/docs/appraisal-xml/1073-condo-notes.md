# Form 1073 (Individual Condominium Unit) — support notes

Verdict: **not a major difference — include condos.** The 4 sample FNM1073 files parse with the
existing engine out of the box (address, APN, year, GLA, beds, appraiser, license, comps, values,
photos, PDF all extract). It's the same MISMO 2.6 structure and the **same value logic** — condos
just **add a small set of condo-specific fields**.

Samples (all As-Is only — no renovation): Wieder $1,300,000; Stern $646,000; Wieder $620,000;
Danziger $1,050,000. All `_CONDITION_OF_APPRAISAL/@_Type = AsIs`.

## As-Is vs ARV on a 1073 — works the same, no special code

The value lives in the **identical** place as 1004/1025: `VALUATION/@PropertyAppraisedValueAmount`,
with `_CONDITION_OF_APPRAISAL/@_Type` telling us what it is. These samples are all `AsIs`, so the
figure is the **As-Is value** and there is **no ARV** — which is correct: a straight as-is condo
purchase has no after-repair value.

**A future 1073 with an ARV would encode it exactly like the other forms** — `_Type` would read
`SubjectToRepairs` / `SubjectToCompletion` (or hypothetical-completion language in the narrative),
and `PropertyAppraisedValueAmount` would be the ARV. The value engine is **form-agnostic**, so it
would read a 1073 ARV automatically the day we get one. No sample needed to support it.

> Design note — "ARV mandatory" applies to **reno / ground-up** deals. An **as-is-only** appraisal
> (condition = AsIs, no as-repaired language) genuinely has **no ARV**; the system should treat ARV
> as N/A there rather than forcing one. (Small refinement to the value engine so it doesn't echo the
> as-is figure as the ARV on a pure as-is report.)

## Condo-specific fields to add (the only new work)

| Field | Element | Attribute | Example | Present |
|-------|---------|-----------|---------|---------|
| Project / condo name | `PROJECT` | `_Name` | `Throopway Condominium` | 4/4 |
| Project design type | `PROJECT` | `_DesignType` | `MidriseProject`, `HighriseProject`, `GardenProject`, `RowhouseProject` | 4/4 |
| Elevator count | `PROJECT` | `ElevatorCount` | `1` | most |
| Phase | `PROJECT` | `_PhaseIdentifier` | `1` | most |
| Primary occupancy | `PROJECT` | `_PrimaryOccupancyType` | `PrincipleResidence` | 4/4 |
| Unit number | `_UNIT` | `UnitIdentifier` | `2A` | 4/4 |
| Floor | `_UNIT` | `FloorIdentifier` | `2` | 4/4 |
| Levels in unit | `_UNIT` | `LevelCount` | `1` | 4/4 |
| **HOA / condo fee** | `_PER_UNIT_FEE` | `_Amount` + `_PeriodType` | `$410 Monthly`, `$782 Monthly` | 4/4 |
| Fee includes (utilities) | `SITE_UTILITY` / assessment | `_IncludedInAssessmentIndicator` | `Y` | 4/4 |

That's the whole delta. In the property report these surface as a small **"Condo / association"** card
(project name, unit + floor, monthly HOA fee, what the fee covers) shown only when the form is 1073.

## Routing

Add `FNM1073` to the form router alongside `FNM1004` / `FNM1025`. The 1073 uses the single-dwelling
value/subject/comp path (like a 1004, one unit) **plus** the condo card above. It does **not** use the
1025 per-unit rent schedule (a condo is one unit, not 2–4).

## Corpus now

37 files total: **20× FNM1004** (SFR) · **13× FNM1025** (2–4 unit) · **4× FNM1073** (condo).
