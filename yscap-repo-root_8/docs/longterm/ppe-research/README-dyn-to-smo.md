# The vendor's own dynamic-field → special-mortgage-option table

`lp-frontend-dyn-to-smo.json` — 99 unique mappings extracted from Lender Price's OWN
frontend bundle (`main.f70cc3e63bb955c2d62c.js`, 18.5 MB, served by
`yscapgroup.digitallending.com`), 2026-08-16. Each entry is
`{ fieldId, value, smoName, smoId, type }`, carrying the vendor's REAL special-mortgage-option
ids across 20 dynamic fields.

## Why this exists, and what it settles

The frontend does not send special mortgage options the way we assumed. Before every
`searchRaw` it runs `smoDynaUtils.fixSearch(search)`, which:

1. **empties `criteria.specialMortgageOptions`**, keeping only ids in its `smoNoChange` set; then
2. when `search.dynaToSmo` is true, walks this table and **re-derives** the options from the
   `dynamicPropertiesMap` values — `dynamicPropertiesMap[fieldId].value === value` → push that SMO.

So the DYNAMIC FIELD is the input and the OPTION is derived from it. That is one mechanism, not
two competing ones.

**This closes the §31.8 item 7 contradiction, and the answer is that neither half of the audit was
wrong.** §13.3 read `GLOBAL_NoMortgageHistory` out of the bundle as a rule-backed dynamic field;
§31.7 captured a live request carrying a "No Mortgage History" OPTION and no such field. Both are
true, because the table contains exactly:

    GLOBAL_NoMortgageHistory = true  →  SMO "No Mortgage History" (5835b01ee4b0753819a39937)

The field is what a client SETS; the option is what `fixSearch` DERIVES from it before sending —
which is why the capture shows the option and the bundle shows the field. **Our current behaviour
is correct**: we set the dynamic field and send `dynaToSmo: true`, and the derivation happens
upstream. The audit's instruction to "replace the dynamic key with the captured SMO flow" would
have removed the input and kept only the output.

## The one parity gap it exposes

    DSCRRATIO = "NoDSCR"  →  SMO "No Ratio"

Our §32.3 band table maps `NoDSCR` to NO option at all. The vendor derives "No Ratio" from it.
Worth closing — but note we send `dynaToSmo: true`, so upstream may already derive it for us;
confirm against a capture before changing the table, rather than adding a second derivation.

## Provenance and standing

This is READ from the vendor's own shipped code, so it is evidence of the same kind as a network
capture — stronger than inference, weaker than a written vendor statement. It is a SNAPSHOT: the
bundle hash is in the filename above and these ids will move when they redeploy. Re-extract rather
than hand-edit.
