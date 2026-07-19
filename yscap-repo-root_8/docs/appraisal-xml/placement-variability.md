# Field Placement Variability — the "cannot use one-size-fits-all" map (all 33 files)

Across all 33 appraisals (20× 1004, 13× 1025, 4 vendors). Each field is one of three kinds:

- **ONE WAY** — same element/format in every file → simple, safe logic.
- **NEEDS FALLBACK** — the *same* field lives in a different place or format on different files → must try multiple sources / normalize, or it silently returns the wrong value. **These are the error-prone fields.**
- **SOMETIMES MISSING** — absent on some files → leave blank, not an error.

## The error-prone fields (must try multiple sources / normalize)

| Field | Ways seen | What varies | How to handle |
|---|---|---|---|
| **As-Is value** | 8+ | No dedicated field; hides in 7 different comment attributes, or estimated from comps, or only in the PDF | Sweep all narrative attrs in priority order + comp-cluster fallback + PDF flag (see README) |
| **ARV basis** | 2 | Meaning of the headline value set by an enum OR by hypothetical-condition wording | Check `_CONDITION_OF_APPRAISAL/@_Type` **and** narrative; never the enum alone |
| **APN / parcel #** | 2 | `_IDENTIFICATION@AssessorsParcelIdentifier` (32) vs `PARCEL_IDENTIFIER@GSEAssessorsParcelIdentifier` (1) | Try both locations |
| **Subject condition/quality** | 2 src × 2 fmt | Source: seq-0 `COMPARISON_DETAIL@GSE` (20) vs seq-0 `SALE_PRICE_ADJUSTMENT` (13); format: UAD `C#/Q#` (30) vs words like "Good"/"BRICK" (3) | Try both sources; accept only `C1–C6/Q1–Q6`, else flag "non-UAD wording" |
| **Bathrooms** | 3 | `full.half` UAD decimal (21) vs plain int (9) vs missing (3) | Parse `2.1` = 2 full + 1 half; handle int; blank if per-unit |
| **Signed date** | 2 | `MM/DD/YYYY` (12) vs ISO `YYYY-MM-DD` (21) | Normalize both to one calendar format |
| **Money numbers** | 2 | with commas (8) vs plain (25) | Strip commas before parsing |
| **GLA** | 2 | subject-level (30) vs blank on non-UAD 1025 stored per-unit (3) | 1025: sum/fallback per-unit; else blank |

## Safe & optional fields

| Field | Kind | Note |
|---|---|---|
| Address, city, county, state, zip, legal, census tract, neighborhood | ONE WAY (always) | Safe to match on |
| Lot size | ONE WAY | Always `SITE@_AreaDescription` (string w/ "sf" suffix — strip unit) |
| Borrower / entity name | ONE WAY (always present) | 1 place; match person **or** LLC (see field-reliability.md) |
| Appraiser name / company / license / effective date / appraised value | ONE WAY (always) | Reliable |
| Units | mostly one way | 1 file blank → imply 1 for a 1004 |
| AMC (management company) | SOMETIMES MISSING | 20 present / 13 blank — optional |
| Income value, GRM, per-unit rents, market rent | SOMETIMES MISSING | Income files only (all 1025) — blank on a 1004 |
| Supervisory appraiser | SOMETIMES MISSING | Only when a co-signer exists |
