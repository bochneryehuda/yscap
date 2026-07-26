# Findings cleanup — the owner's 2026-07-26 review of a real file (Moses Weil / MW TRADING LLC)

The owner walked one live file end to end and found the findings surface unusable: the same issue
posted up to six times, blank "requirement exists" notices on every file, findings that read the
WRONG document, and reasoning too thin to act on. This is the spec for fixing it. It is written
from their words; nothing here is inferred.

## The four root causes (fix these, not the symptoms)

### ROOT 1 — three separate finding surfaces, each with its own layout, each re-emitting the same issue
The file view renders findings from three different producers that never reconcile:
1. `investor_guideline_desk` — "note buyer requires X — no condition on the file" (blank coverage gaps)
2. `investor_guideline_ai` — "AI review: the cleared document may not meet the rule for X"
3. the unified **Open findings** list (entity chain, tie-out, chain of title, risk, document findings)

The SAME issue therefore appears 4–6 times. The owner counted the contract-buyer/vesting mismatch
**six** times across sections. Verbatim: *"congratulations for the sixth time posting the same
condition… go to the root cause and merge every section."*

**Target:** ONE finding list, ONE layout — the **Open findings** style, which the owner explicitly
picked as the best: severity chip · source document link · "Where we saw this" quote · plain-language
reasoning · the action row. Every producer feeds that one deduped registry. The other two surfaces
stop rendering their own lists.

**Dedupe must be by ROOT ISSUE, not by code+file.** The six copies of the vesting mismatch came from
different producers with different codes describing one fact: the contract buyer is a person and the
vesting entity is an LLC. Dedupe needs a semantic key (subject + claim), not a string match.

### ROOT 2 — the guideline desk posts a BLANK notice for every rule, on every file
A note-buyer guideline is being turned into a finding merely because the rule EXISTS, with no
evidence the file has a problem. Verbatim: *"you're just bombarding with stupidities"*, *"this
should be silent in the background"*, *"you're stupid"* (borrower email).

**Governing rule:** the findings section is for **things actually observed in documents**. The
CONDITIONS section is what tracks "we need document X". A guideline with no triggering signal is
SILENT. Per-rule dispositions the owner dictated:

| Rule | Correct behaviour |
|---|---|
| **Rural property verification** | SILENT until the **appraisal XML** says rural. Parse the neighbourhood/location field (Urban / Suburban / **Rural**). Only if Rural → post "confirm rural per the appraisal". Most files are not rural; never ask blind. |
| **Appraisal transfer requirements** | SILENT until the **appraisal XML lender name ≠ YS Capital Group**. Only a genuinely transferred appraisal raises it. **Blue Lake does NOT accept transferred appraisals at all → that case is FATAL for Blue Lake.** Other note buyers → request the transfer letter + AIR cert + paid invoice. |
| **Occupancy cert** | SILENT. It is part of the DocuSign term-sheet package. Only after that package returns signed, and only if it is missing from the returned package, does it raise. |
| **Non-arms-length** | SILENT. We never have to PROVE a deal is arm's length. Watch for red flags only — matching last names between seller and borrower, matching addresses, or similar. No signal → no finding. |
| **Borrower email address** | NEVER blank. The email is on the file — application details / completeness. Read it. Only raise if genuinely absent. |
| **Contact info for title/escrow/settlement + insurance** | The ONLY requirement is the **email address** for the title company and the insurance company. Everything else (address, phone, contact full name, carrier address, separate flood/liability insurer contacts) is optional enrichment and must NOT be listed as "Missing". |

### ROOT 3 — findings read the WRONG document
- **Mortgagee clause**: "the insurance does not name the lender as mortgagee" opened the insurance
  **INVOICE**. Only the **BINDER** carries the mortgagee clause — and the binder DOES have it. The
  finding is false. Bind mortgagee-clause checks to the binder/policy, never the invoice.
- **Business-purpose disclosure**: opened the **1003**. It belongs to the term-sheet package (not
  sent yet) → should be silent, and it is reading the wrong document regardless.
- **LLC vesting documents**: the AI review says EIN / formation / operating agreement are all
  missing while the file has dedicated **LLC section slots** for exactly those. It is not connected
  to them. Wire the check to the real LLC slots.
- **Title mortgagee clause**: the title DOES carry the clause — read deeper before flagging.

### ROOT 4 — reads that give up instead of trying harder
- **Credit report**: "could not be read with confidence" when a **credit XML exists**. Parse the XML.
- **Government ID**: an unreadable ID is not an underwriting finding — it is a READ failure. Retry
  through the other OCR engines / AI, and only then surface it as low confidence.
- **Operating agreement** `members[0].type`: same — a good document we failed to read. Escalate the
  read, don't emit a finding.
- **OFAC entity screening**: the entity **IS** screened. The fraud report has a **Watch list**
  section (≈ p.23 on this report, position varies) listing every screened entity including
  MW TRADING LLC. Search the whole document for the entity name before claiming it wasn't screened.
- **Fraud alerts "must be cleared"**: they were ALREADY cleared by an admin, with the clearing
  reason on the following page ("The borrower is a professional investor", "backed by the
  appraisal"). Read the Cleared Variance section before raising.

## Individually reported defects

1. **Liquidity double-counts one account.** The table lists MOSES WEIL / Vanderbilt ••0120 $88,454
   AND MOSES WEIL / Vanderbilt (no acct#) $89,474 — the **same account from two statements**,
   counted twice. Owner: *"a major major major major issue."* Dedupe by account identity across
   statements and use the LATEST statement only. Fix for all files.
2. **Blue Lake needs 2 months of bank statements**, not 1. The rule text says 1.
3. **Property type tie-out maps the wrong fields** — comparing appraisal "Detached" (a STYLE) to
   file "Multi 2–4" (a RANGE). Compare **unit COUNT to unit COUNT**, both from the appraisal XML and
   the file. Wrong-field mapping, not a real mismatch.
4. **Chain-of-title breaks at the wrong step.** Owner-of-record → seller → buyer is CONSISTENT
   (Michael Moran → Michael Moran → Moshe Weil). The break belongs at the NEXT hop (person → LLC),
   not where the ✗ currently sits.
5. **Name-order finding needs reasoning**: "WEIL MOSES" vs "Moses Weil" is surname-first formatting,
   not a discrepancy. Say so.
6. **Risk score 55/100 must explain itself** — what specifically drives it, not just code names.
7. **Mortgage lates finding must list WHICH mortgage, WHEN, and the most recent late** + a link
   straight into the credit report.
8. **Langfuse "AI reasoning trace →" link 404s** ("trace not found"). Either point it at a real
   trace or remove the link. A dead link on every finding erodes trust in all of them.
9. **Insurance/title mortgagee-address findings must say WHICH document** they refer to (one is
   insurance, one is title) and should auto-clear when an address is present.

## Cross-cutting requirement — every finding must be actionable in place

The owner's standard, verbatim: *"we need a direct link to open up the document that you looked on,
or the snips that you looked on and highlighted fields that you looked on… so we should be able to
live on that and look on everything and work on everything right here."*

Every finding, from every producer:
- the source document, opening directly to the **right page**
- the exact snippet / highlighted field that produced it
- what was expected vs what was found, and **why** that is a problem
- the action row

## Fix order

1. **Dedupe + unify** the three surfaces into the one Open-findings layout (ROOT 1) — the loudest
   problem and the one that makes everything else readable.
2. **Silence the blank guideline notices** and implement the per-rule dispositions (ROOT 2).
3. **Fix the wrong-document bindings** — mortgagee→binder, business-purpose, LLC slots (ROOT 3).
4. **Liquidity double-count** (its own item — it misstates money).
5. **Read deeper**: OFAC watch-list search, cleared fraud variances, credit XML, appraisal XML for
   rural / transfer / unit count (ROOT 4 + items 2, 3).
6. **Evidence links + reasoning** on every finding; fix or remove the trace link.

**Backfill:** all of this must apply to EXISTING files, not just new ones — per the standing
"previous AND future" rule.
