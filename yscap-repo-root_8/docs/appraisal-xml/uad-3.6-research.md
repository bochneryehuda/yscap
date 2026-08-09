# UAD 3.6 / the redesigned URAR — industry research, the GSE artefact list, and what PILOT built

Assembled 2026-08-07. Companion to `mismo-uad-spec-reference.md` (which covers UAD **2.6**, the
standard PILOT read until now) and to `uad-3.6-field-map.md` (the field-by-field map).

**The deadline is the whole reason this exists.** From **2 November 2026**, appraisal reports
delivered to Fannie Mae and Freddie Mac must be UAD 3.6. UAD 2.6 is accepted in parallel until
then and is retired after pipeline clean-up in **May 2027**. Lenders can submit 3.6 today, and the
GSEs are asking them to start. So this is not a future project: from November the appraisal desk
either reads 3.6 or it stops working on new reports, and the transition period is the only time
there is to get it right on real files.

---

## 1. Access — read this before trusting a single xPath in the map

**Every canonical GSE and MISMO source is blocked by this environment's egress policy.**
`singlefamily.fanniemae.com`, `sf.freddiemac.com`, `www.mismo.org` and `www.hud.gov` all answer
**HTTP 403 to CONNECT** at the organization's egress proxy (confirmed 2026-08-07; the proxy's own
status endpoint records each denial). That is a policy decision, not a fault, and it was not routed
around. The same note appears at the top of `mismo-uad-spec-reference.md` for the 2.6 work.

What that means in practice:

- The **normative artefacts below have not been read.** The list is assembled from official titles
  and URLs recovered through search, and is written so a human can download each one directly.
- The **field map in `uad-3.6-field-map.md` is therefore a set of CANDIDATES**, derived from MISMO
  v3 naming conventions, from the v3.4 reader this repo already ships (`src/lib/mismo/`), and from
  the mechanical 2.6→3.6 spelling rules. It is built to be **corrected**, not trusted: every field
  carries several candidate paths plus a name-pattern fallback, and every resolved field records
  which path fired. See §6.
- Where a statement below is sourced from an industry reproduction rather than the GSE original, it
  is marked *(reproduced)*.

---

## 2. The artefacts to download — the "correct tools from Fannie Mae and Freddie Mac"

The GSEs publish UAD 3.6 as a lettered appendix set (A-1 … G-1), jointly, with identical content on
both sites. **Appendix A-1 and Appendix D-1 are the two that finish this build.**

| Appendix | What it is | Why we need it |
|---|---|---|
| **A-1** | **UAD & Forms Redesign — Appraisal Report Delivery Specification.** The UAD dataset and its **MISMO v3.6 XML mapping** — every data point, its enumerations, its cardinality and its xPath. Published as PDF; A-1 is the preserved source of truth. | **THE ONE THAT MATTERS.** Every candidate path in our field map is checked against this and corrected. Systems are required to support all data points defined here. |
| **B-1** | The same dataset as a **Microsoft Excel** workbook. | Sort/filter the data points; diff our map against it mechanically. |
| **C-1** | **Appraisal forms with numbered fields** — the report template with field reference numbers. | Ties a data point to what the appraiser sees, which is how a finding gets worded for a human. |
| **D-1** | **URAR sample scenarios and XML files** (a ZIP of ~12 published scenarios: XML + a summary of each scenario's characteristics and what changed since the last version). | **THE OTHER ONE THAT MATTERS.** These are the "few examples" the reader needs: run `scripts/uad36-survey.js` over the ZIP and the map finishes itself. |
| **A-3 / D-3** | The same pair for the **Completion Report** (one of the two reports replacing the 1004D). | Needed when we start reading completion reports — a real event on a construction file. |
| **E-1** | Data point **change log** vs. the previous publication. | How the map is maintained after go-live without re-reading A-1 end to end. |
| **F-1** | The **URAR "master manual"** — the comprehensive field guide for completing the dynamic report. | The definitions behind the data: what an appraiser is being asked, which is what our findings must reflect. |
| **G-1** | Appendix set index / supporting material. | — |

**Where to get them** (open directly in a browser; both sites carry the same set):

- Fannie Mae — Uniform Appraisal Dataset hub:
  `https://singlefamily.fanniemae.com/delivering/uniform-mortgage-data-program/uniform-appraisal-dataset`
- Fannie Mae — UAD and Forms Redesign, additional documentation:
  `https://singlefamily.fanniemae.com/news-events/uad-and-forms-redesign-additional-documentation`
- Freddie Mac — Uniform Appraisal Dataset:
  `https://sf.freddiemac.com/tools-learning/uniform-mortgage-data-program/uad`
- Freddie Mac — UAD 3.6 FAQ: `https://sf.freddiemac.com/faqs/uad-and-forms-redesign`
- Fannie Mae — UAD 3.6 FAQ (PDF): `https://singlefamily.fanniemae.com/media/23286/display`
- Freddie Mac — **Submission Summary Report (SSR) guide for UAD 3.6**:
  `https://sf.freddiemac.com/docs/pdf/ssr-guide-uad-3.6.pdf`
- Freddie Mac — UCDP proprietary messages (the actual edit codes we can mirror as findings):
  `https://sf.freddiemac.com/docs/pdf/update/ucdp_proprietary_messages.pdf`
- Freddie Mac — URAR update & completion report rules announcement:
  `https://sf.freddiemac.com/docs/pdf/urarupdatecompletionrulesannouncement.pdf`
- MISMO — **Version 3.6 reference model** (logical data model, XML schema, data dictionary; the
  GSEs publish a UAD **subschema** carrying only the elements UAD 3.6 uses):
  `https://www.mismo.org/standards-resources/mismo-product/mismo-version-3-6`
- MISMO — XML schema:
  `https://www.mismo.org/standards-resources/residential-specifications/reference-model/xml-schema`
- FHA — UAD 3.6 implementation preparedness toolbox (FHA/EAD side of the same transition):
  `https://www.hud.gov/sites/dfiles/SFH/documents/sfh_ead_FHA_UAD-3.6_Implementation_Preparedness_Toolbox_v1.pdf`

**A faster route than the appendices:** the AMC or appraisal vendor already delivering our reports
(AppraisalScope / CoreLogic, a la mode TOTAL, ACI, ClickFORMS) can hand over a **real 3.6 XML from
one of our own files**. One real report is worth more than the whole appendix set for finishing the
map, because it shows what the producer actually emits rather than what the spec permits.

---

## 3. What changed, and which parts of PILOT each change touches

Sourced from the GSE announcements and industry reproductions; every line below is something the
reader or the appraisal screen had to account for.

### 3.1 The form number is gone
Twelve-plus legacy forms — **1004, 1025, 1073, 2055, 1004D, and the Freddie equivalents 70, 72,
465, 442**, plus every hybrid and exterior-only variant — collapse into **one dynamic URAR** whose
sections switch on and off according to the property and the scope of work. One report now covers
single-family, condo, co-op, 2–4 unit, manufactured housing and leasehold. **Property data drives
the report; there is no form type to route on.**

> **What this cost us.** `extract()` routes on `REPORT/@AppraisalFormType` (`FNM1004` / `FNM1025` /
> `FNM1073`), and so does everything downstream — `property-category.js`, the findings engine, the
> 1025 rent-schedule path, the 1073 condo card, the stored `appraisals.form_type`. Rather than fork
> a dozen consumers, `uad36-map.deriveFormType` **derives** the equivalent legacy form from the two
> facts that always drove the choice (the ownership kind and the dwelling count) and records the
> basis in words, so a screen can say "derived from a UAD 3.6 report". When the report states
> neither, the form is `null` and a warning is raised — never a silent default to 1004.

### 3.2 The 1004D splits in two
The update/completion form is replaced by **two separate reports**: a **Restricted Appraisal Update
Report** and a **Completion Report** (which has its own delivery specification, Appendix A-3).
Not yet read by PILOT — see §7.

### 3.3 Structured data instead of narrative
The GSEs are moving away from commentary addenda. Room-level and system-level detail, energy and
efficiency features, site and location attributes, and — importantly for us — **assumptions,
extraordinary assumptions, hypothetical conditions and limiting conditions** are now discrete,
machine-readable fields.

> **This is a genuine improvement to our highest-risk read.** The As-Is/ARV decision in 2.6 has to
> scan prose for hypothetical-condition language, because a renovation report states the
> after-repair value in the same attribute an as-is report uses (`docs/appraisal-xml/as-is-value-sources.md`
> measured: 64% narrative, 21% comp-estimate-only, 15% absent). In 3.6 that disclosure is its own
> data point, so `extract36.decideValues` reads it **structurally** and keeps the prose scan only as
> a backstop for producers still writing it as narrative. The decision output — `basis` of `'ARV'`
> or `'ASIS'`, the confidences, the sources — is byte-identical in vocabulary to the 2.6 path, so
> `comp-grid.splitComps`, the officer condition and the CTC tie-out are unchanged.

### 3.4 Condition and quality: same scales, split by interior and exterior
**C1–C6 and Q1–Q6 survive**, with rewritten definitions to reduce subjectivity (C1 now carries a
12-month age limit; C2 means remodelled to the studs within 36 months with no deferred maintenance).
What is new: ratings are assessed **separately for interior and exterior** and at component level,
and they now apply to **all** residential property types including **manufactured housing**, which
2.6 exempted.

> PILOT reads the overall pair into the existing `conditionUad` / `qualityUad` (so `uad-rating.js`,
> the findings and the C6/Q6 UCDP-fatal warnings work unchanged) and carries the interior/exterior
> pair as new `subject.*` facts. A **two-step gap between interior and exterior raises a warning** —
> that divergence is the exact thing the split was introduced to surface, and on a renovation file it
> is the difference between a cosmetic refresh and a gut.

### 3.5 The comparable grid
A minimum of **three closed sales** as before, with **additional comparables permitted** to support
the opinion. Contract offerings and current listings may be used as supporting data. Two new
requirements matter to us: the appraiser must **state how each comparable was weighted, in the
grid**, and any comparable **considered but not used** must be documented in an "Additional Sales
Analyzed" / "Additional Properties Analyzed" section rather than simply omitted.

> The reader carries `weighting`, `listingStatus` and `listPrice` per comparable, and its container
> list includes the additional-properties-analyzed spellings. A grid under three comparables raises
> a warning naming the minimum.

### 3.6 The delivery package is a ZIP — the ENV file is retired
This is the change most easily missed, because it is not in the data model at all. UAD 2.6 arrives
as **one XML with the report PDF carried inside it, base64** (`<EMBEDDED_FILE _Type="PDF">`) — which
is why `xml.embeddedPdfBase64()` exists and why our whole photo pipeline mines pixels out of that
PDF. UAD 3.6 delivers a **ZIP**: the MISMO 3.6 XML, a PDF rendering, and an **`Images/`** folder
(case-sensitive) with every photo as its own file. UCDP accepts exactly that package, capped at
**60 MB**, images in the standard raster formats.

> A system that only swallows a bare XML rejects the very file appraisers start delivering — not
> because it cannot read 3.6, but because it never gets to the 3.6. `src/lib/appraisal/package36.js`
> opens the package (dependency-free, `zlib` only, STORED and DEFLATE, ZIP64-aware, path-traversal
> refused). The XML carries a photo **manifest** (identifier, caption, filename, type) which is how
> the ZIP's image files are matched to the report.

### 3.7 The report itself
Roughly 25–30 pages, **29 sections** (17 fixed, 12 conditional, several repeatable), opening with a
**Summary** section giving the property overview, the value conclusion and key findings, then
reading top-to-bottom through Subject Property → Sales Comparison → Reconciliation → Certifications
and Scope of Work, with dedicated sections for site, improvements, additional structures and rental
analysis.

### 3.8 Scope of work replaces the form variant
Interior-and-exterior, exterior-only, desktop and hybrid are now **scope-of-work data** on one
report rather than different forms. PILOT normalizes it (`inspectionScope`) and stores it in the
existing `inspection_type` column, so the existing "desktop / no-inspection appraisal" warning keeps
firing.

---

## 4. What PILOT built

| File | What it does |
|---|---|
| `src/lib/appraisal/xml36.js` | The MISMO 3.x reader. Iterative (no recursion in parse or navigation), tolerant (never throws — a malformed document yields what parsed plus a `damaged` flag), namespace-agnostic (everything matches on the LOCAL name), and **text-bearing** — which is the whole point, since the 2.6 reader deliberately drops element text. |
| `src/lib/appraisal/uad36-map.js` | The field map (candidate paths per canonical field), the enum crosswalk onto PILOT's existing vocabulary, the value normalizers, and the resolver that records provenance. |
| `src/lib/appraisal/extract36.js` | Builds **the same canonical object** `extract()` returns for 2.6, plus `format` and `coverage`. |
| `src/lib/appraisal/package36.js` | Opens the UAD 3.6 ZIP delivery. |
| `src/lib/appraisal/extract.js` | Unchanged for 2.6; a MISMO 3.x appraisal is now **routed** to `extract36` instead of refused. |
| `scripts/uad36-survey.js` | The tool for finishing the map against a real report — see §6. |

**The contract, and why it is the design.** Roughly a dozen modules are built on `extract()`'s
output: the findings engine, the desk, the as-is desk and reader, the comp grid, the scoring, the
note-buyer checks, the property-category derivation, the research-warehouse ingest,
`importAppraisal`'s column mapping, and the Appraisal screen the officer reads. **None of them is
version-aware and none of them should become version-aware** — the moment a finding rule asks "is
this 2.6 or 3.6?", every rule has two behaviours and the second one is the untested one. So
`extract36` returns the identical shape, key for key, in the identical vocabulary. A regression test
asserts that shape field by field.

**Both doors are covered, which is what was asked for.** The appraisal findings on a single loan
file (`importAppraisal` → the Appraisal tab) and the property research warehouse
(`lib/research/xml-import.js`, `xml-catch.js`, `xml-sweep.js`) both go through the one `extract()`,
so a 3.6 report imports onto a file **and** files its comparables into the research database with no
second code path. `detectMismo`'s "is there an appraisal in here?" grid test — which the warehouse's
catch reuses as its own definition — now shares the 3.6 reader's container list, so the two can
never disagree about what an appraisal is.

**Two things `extract36` deliberately does NOT do.** It never invents a value: a field that does not
resolve is `null` and is reported as unresolved, never guessed. And it never puts a new key on
`enrich` — `importAppraisal` does `Object.assign(cols, A.enrich)` straight into an INSERT, so an
`enrich` key that is not an existing column fails the whole import. The 3.6-only facts ride on
`subject.*`, which `buildFieldsJson` persists verbatim into the fields jsonb. New columns are a
migration and a deliberate decision, not a side effect of a reader.

---

## 5. What is still unverified

Stated plainly, because the honest limits are the useful part of this document.

1. **The xPaths are candidates.** They have not been checked against Appendix A-1. They are
   structured to survive being one container off (several candidates each, plus a name-pattern
   sweep), and every resolution is recorded — but a field whose 3.6 data-point NAME differs from
   what we guessed will read as unresolved until corrected.
2. **No real 3.6 report has been read.** The tests run against a synthetic report built to the
   conventions the map targets, and it is labelled synthetic in the test file. It proves the reader,
   the shape contract and the value logic; it proves nothing about the paths.
3. **The Update and Completion reports are not read.** They are separate report types with their
   own specification (A-3/D-3).
4. **The UCDP Submission Summary Report for 3.6** (the SSR guide above) is not mirrored as findings.
   Our note-buyer checks and UCDP-fatal warnings are still written against the 2.6 edit set.
5. **Photos.** The reader reads the 3.6 image **manifest**; wiring the ZIP's `Images/` files into
   `appraisal_photos` (replacing the 2.6 path, which mines pixels out of the embedded PDF) is not
   built. On a bare-XML 3.6 import there are no photo bytes at all.
6. **Per-comparable adjustments** are read generically (any `*_ADJUSTMENT` element below the
   comparable). The normative adjustment element names will come from A-1.

---

## 6. How to finish it when a real report arrives

This is the whole point of the coverage instrumentation, and it is three commands.

```
# a bare XML, or the whole ZIP delivery — both work
node scripts/uad36-survey.js ~/Downloads/URAR_sample_1.xml
node scripts/uad36-survey.js ~/Downloads/uad36-appendix-d1.zip

# just the element census, to see what the producer actually emits
node scripts/uad36-survey.js --tags ~/Downloads/URAR_sample_1.xml
```

Read the output in this order:

1. **`*** RESOLVED ONLY BY THE NAME SWEEP`** — these resolved through the last-resort fallback, which
   means the mapped path was wrong but the data-point name was right. The survey prints the element
   it actually found. **Correct the first candidate for each of these; it is the cheapest, highest-value
   pass.**
2. **`DID NOT RESOLVE`** — grouped by section, with a count per comparable field. A whole section
   missing means a container path is wrong; scattered fields mean individual data-point names differ.
   Find the real name in the element census and add it as the first candidate.
3. **`WARNINGS`** — the reader's own tripwires against this report.

Then re-run the survey. When `coverage` stops moving, run the reader against every sample in
Appendix D-1 (the scenarios deliberately cover different property types and scopes of work, which is
exactly the coverage a single report cannot give), and add the real report as a fixture to
`scripts/test-uad36-reader-pure.js`, replacing the synthetic one.

---

## Sources

Normative (blocked here — open directly, see §2): Fannie Mae UAD hub and UAD-and-forms-redesign
documentation; Freddie Mac UAD page and UAD 3.6 FAQ; the A-1/B-1/C-1/D-1/E-1/F-1 appendix set;
Freddie Mac SSR guide for UAD 3.6 and UCDP proprietary messages; MISMO v3.6 reference model and XML
schema; HUD/FHA UAD 3.6 implementation toolbox.

Industry reproductions used for §3 *(reproduced)*: Dart Appraisal UAD 3.6 overview; ValueLink
(rollout, review-workflow, field-by-field URAR breakdown); Clear Capital "What is UAD 3.6"; CSS
"UAD 3.6 changes: what lenders need to know"; McKissock (implementation timeline and policy changes;
condition C1–C6 and quality Q1–Q6 updated for 3.6; the appendices); Appraisal Buzz / Appraiser
eLearning key changes; a la mode TOTAL UAD 3.6 user's guide and demo notes; Opteon UAD 3.6 knowledge
hub; Stewart / NAN UAD 3.6; Class Valuation software readiness; Swish Appraisal UAD 3.6 + ULDD
Phase 5 readiness guide; Working RE "Flooded with change".
