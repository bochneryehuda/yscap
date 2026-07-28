# Where the As-Is value actually lives — XML first, then OCR + AI

**Owner's question (2026-07-28):** *"a lot of times you can find as is value as well on top of the
ARV value in the XML, so that should be perfect — but if you can't find it in XML, do a lot of
research: which XML you can find, which XML you cannot find, based on the information we have
already built on the appraisal findings. If you can't find it, use the strongest OCR and AI."*

This is the answer, measured on the **33 real appraisal XMLs** in the research corpus (20× Form 1004
URAR, 13× Form 1025 Small Residential Income — per-file evidence in
`per-file-extraction-proof.md`). It is the specification the shipped reader
(`src/lib/appraisal/as-is-reader.js`) implements.

---

## 1. The short answer

| Where the As-Is came from | Files | Share | Does PILOT use it? |
|---|---:|---:|---|
| **XML narrative** — an As-Is sentence inside a comment/addendum attribute | 21 / 33 | **64%** | **Yes — `definite`.** No OCR needed, no cost. |
| **XML comp cluster** — no As-Is sentence; only the lower cluster of adjusted comp prices | 7 / 33 | 21% | **No.** That is an *estimate*, and PILOT never stores an estimated value as fact. → OCR + AI. |
| **Not in the XML at all** — the As-Is exists only in the report PDF | 5 / 33 | 15% | **No.** → OCR + AI. |

So the owner's instinct is right on both halves: **about two thirds of the time the XML "is
perfect"**, and **about one third of the time (12 / 33 files) the XML cannot give it** and the only
honest source is the report PDF.

The ARV, by contrast, was recovered from the XML on **33 / 33** files — it is always the structured
`VALUATION/@PropertyAppraisedValueAmount`. That asymmetry is the whole reason this exists: **there is
no dedicated As-Is attribute in a MISMO 2.6 appraisal.** The form has one "opinion of value" box, and
on a renovation appraisal that box holds the *after-repair* value. The As-Is is whatever the
appraiser chose to write in prose.

---

## 2. Which XML you CAN read it from

### 2a. The headline value IS the As-Is (a straight as-is report)

`VALUATION/_RECONCILIATION/_CONDITION_OF_APPRAISAL/@_Type = "AsIs"` **and** no
hypothetical-completion language anywhere in the narrative → the structured
`PropertyAppraisedValueAmount` **is** the As-Is. Confidence `definite`.

Both halves are required. File `CP_09709435` says `AsIs` in the enum while the narrative plainly
values the property *"under the hypothetical condition that all repairs have been completed"* — the
number is the ARV. The enum alone would have written an ARV into the As-Is field.

### 2b. An As-Is sentence in the narrative (the common renovation case — 21 files)

`_CONDITION_OF_APPRAISAL/@_Type` is `SubjectToRepairs` / `SubjectToCompletion` /
`SubjectToInspection`, so the headline number is the ARV and the As-Is — when it is there at all — is
a **sentence**, not a field. It appears in different attributes per vendor, and there is no way to
know in advance which one:

| Attribute | Vendor pattern |
|---|---|
| `_RECONCILIATION/@_ConditionsComment` | a la mode TOTAL |
| `_RECONCILIATION/@_SummaryComment` | a la mode TOTAL, ACI |
| `SALES_COMPARISON/@_CurrentSalesAgreementAnalysisComment` | ACI |
| `SALES_COMPARISON/@_Comment` | ClickFORMS |
| `VALUATION_METHODS/@_AdditionalDescription` | Appraise-It |
| `FORM/@AppraisalAddendumText` | all four (the addendum page) |
| any other `*Comment` / `*Description` / `*Text` attribute | — |

**PILOT therefore sweeps EVERY attribute in the document**, not a fixed list of seven
(`extract.js narrativeTexts` + `ASIS_RE`). A vendor that puts the sentence somewhere new is read for
free, with no code change. Typical wording:

> *"The 'as is' market value of the subject property is $430,000 as of the effective date."*
> *"As-Is Value: $312,500"*
> *"the as is value before renovation is $91,000; the as repaired value is $140,000"*

Three traps the sweep must survive, all of which cost real money if missed:

1. **Paired "As-Repaired … As-Is …" phrasing** — grab the As-Is, never the As-Repaired. The word
   nearest the amount decides, not the first amount on the line.
2. **`COST_ANALYSIS/@SiteOtherImprovementsAsIsAmount` is a DECOY.** The attribute name literally
   contains "AsIs", but it is a cost-approach *site improvements* figure (a driveway, a fence) — a
   four-figure number that would have been catastrophic to write in as a property value. It is
   explicitly skipped by name.
3. **Word boundaries.** "as is" without a leading word boundary false-matches inside *basis* and
   *gas is*; "as complete" inside *gas complete*. A fabricated match here would be stored as
   `definite`, which is the worst possible failure mode.

---

## 3. Which XML you CANNOT read it from

### 3a. Comp-cluster only — 7 files (21%)

On these the appraiser ran two comparable grids (one at as-is condition, one at as-renovated) but
never wrote the As-Is figure in words. You can *infer* it — the lower cluster of
`AdjustedSalesPriceAmount` averages out near the As-Is — and the research prototype did exactly that
(e.g. `nan_Weil` → $308,567 from 3 as-is comps).

**PILOT deliberately does not use it.** A number like $308,567 is a cluster average, not the
appraiser's opinion, and As-Is drives the As-Is LTV and LTC caps — an estimated value written onto a
loan file is a guess wearing a fact's clothing. `extract.js` says so at the point of decision:
`// NEVER estimate-store`. These files go to OCR + AI, and if that fails, to a human.

The comp split is still used, for what it legitimately proves: which comps belong to which grid
(`comp-grid.js`), which is how the report renders two grids instead of one mixed one.

### 3b. Genuinely absent — 5 files (15%)

`CP_10182152`, `CP_10394133`, `CP_10484851`, `nan_Altman`, `nan_LOEFFLER`. The XML carries the ARV
and nothing else; the As-Is exists only in the PDF — usually one line in the reconciliation or a note
on the addendum page. This is precisely the owner's *"a lot of times it's a note on the appraisal
report, it's not even part of the data"*.

---

## 4. What happens when the XML cannot answer

`src/lib/appraisal/as-is-reader.js`, in order:

1. **Read the PDF with the strongest reader available** — `src/lib/ai/ocr-router.js`: Azure Document
   Intelligence → Google Document AI → Mistral, with the legacy OCR.space reader as a last resort for
   small files. (The old path was OCR.space only, which caps at ~1 MB — most appraisal PDFs are
   5–30 MB, so it usually could not even try.)
2. **Ctrl-F that text** — literally the owner's instruction. Two passes: line by line, and every
   adjacent line PAIR joined, because an OCR page or column break routinely lands between the label
   and the amount (`As-Is Value:` / `$312,500`). Same ARV exclusions as the XML sweep, plus a
   currency-signal requirement so a zip / APN / phone number on an "as is" line is never money.
3. **Ask the AI to LOCATE it** — Azure OpenAI, over the same OCR text, returning a **verbatim quote**.
   The AI is a locator, never a source of truth: its answer survives only if (a) the quote really
   appears in the OCR text, and (b) our own scanner independently reads the same amount out of that
   quote. So it can point us at a line the line-scan missed; it can never introduce a number the
   report does not label as the As-Is.

**Confidence, and what it unlocks**

| Result | Confidence | May it change the loan file? |
|---|---|---|
| XML, definite | `definite` | yes (subject to the rule below) |
| One unambiguous labelled hit in the PDF, or the AI's quote confirmed by the scanner | `high` | yes (subject to the rule below) |
| Several amounts near "as is" wording, or the AI alone | `low` | **no** — reported to a human |
| Nothing | — | **no** — the condition asks a human to read it off the report |

Every candidate is bounded ($10k–$100M) and checked against the ARV: an "As-Is" at or above the ARV
is the ARV misread, and is dropped.

---

## 5. The write rule — confidence, and only confidence

> *"As long as you're confident you can write it no matter what it was — I just made a mistake when
> I said that only if it's a reduction. As long as you're confident you should write it as this
> value, and if you're not confident you should always ask in the condition for the loan officer to
> look on the appraisal and enter it."* — owner, 2026-07-28

A `definite` / `high` reading is written **whichever direction it moves** the file's As-Is, and
whether or not it lands below the purchase price. That is the right rule: the appraisal is the
authority on what the property is worth today, and this is exactly the "replace" action a human was
already doing by hand on the `asis_mismatch` finding.

What still stops a write is only ever about whether the number can be **trusted**, or whether anyone
is allowed to write at all — never about direction (`as-is-reader.js decideAsIsApply`):

* **confidence** — anything below `high` is reported to a human and never written;
* the file is **not frozen** (term sheet sent / clear-to-close / funded). PILOT gets no private door
  through a freeze that binds every human;
* it is a **real change** — rewriting the value already on file would churn the reprice trigger for
  nothing.

Being below the purchase price is still *reported*: it is what the condition's wording says out loud
(the borrower would be paying more than the property is worth as it stands) and what the existing
fatal `asis_below_price` finding turns on.

**A raise can never quietly increase a loan.** Any change to `as_is_value` reopens the Products &
Pricing condition through the reprice trigger (`db/071`/`db/072`), so the loan amount does not move
until a human re-registers the product on the new number.

**And a reading we are not confident in always asks.** The `Confirm the As-Is value` condition
carries the internal read-out (what came in, from where, the exact words, what the file said before
and now) and a box to type over it. The only state that raises no condition at all is the settled
one: PILOT is confident **and** the file already shows exactly that value — the appraisal and the
loan file agree, confirmed from two sides. `signOffGate` refuses to clear the condition while the
file has no As-Is on it.

### The guards that make "confident" mean something

Because a confident reading is now written in either direction, precision matters more than recall.
Beyond the ARV ceiling and the $10k–$100M bounds:

* **a line that is not about our subject's value is dropped whole** — a comparable's sale price
  (`Comparable 3 sold as is for $430,000`), an asking/listing price, a tax assessment, a rent, an
  insurance replacement cost;
* **a LABELLED hit must read as a statement of value** — the clause has to carry
  *value / opinion / apprais* / market / worth / estimat / indicat*. A terse `as-is: $430,000` still
  surfaces, as a weak candidate a human or the AI confirms;
* **the ten-fold digit slip is caught** — `$430,000` OCR'd as `$43,000` is plausible, below the ARV,
  and properly labelled; every other check passes it. A candidate within 1% of the ARV, the purchase
  price or the file's own As-Is after ×10, ×100, ÷10 or ÷100 is treated as a misread and can never be
  confident.
