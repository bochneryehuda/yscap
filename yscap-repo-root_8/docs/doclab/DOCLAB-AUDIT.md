# DocLab ↔ PILOT — the standing audit

`node scripts/doclab-audit.js`

That command is the answer to "where does the DocLab integration actually
stand?". It reads the three files Private Lender Law published (saved under
`docs/doclab/reference/`) and our own source, and computes every figure. Nothing
in it is asserted from memory, so it stays true when PLL publishes a new
dictionary or when somebody edits `src/doclab/field-map.js` — which is the whole
reason it is a program and not a table in a document.

Run it before answering any question about DocLab readiness. Do not quote the
numbers below without re-running it first; they are a snapshot of 2026-08-09.

---

## What it checks, and why each check exists

**A — do we know about every key they publish?** 126 published, 126 recognised,
0 unmapped. "Recognised" means the key appears in at least one of our four
structures: the field map, the catalogue's variable list, the fee tables, or a
repeating block's key list. Comparing against the field map alone is the mistake
that made the first pass of this audit report 40 phantom gaps.

**B — have we DECIDED where each variable's value comes from?** A key can be
recognised and still have nobody's decision recorded against it. 103 published
variables, 86 decided, **17 with no decision** — ten of them the loan
modification / extension set from v3.1.4, a document type we do not build at
all. Two of the 17 (`signatory_name (borrower)`, `signatory_title (borrower)`)
are supplied anyway, because the builder writes them inside the borrower block;
the audit says so on the line rather than counting them as gaps.

**C — per RTL template, how much can we supply?** Reported per template COLUMN,
never per product family. A loan is drafted on exactly one template — one
security instrument — so "what does this document need" is the only figure that
means anything; unioning a product's DOT / DTSD / MTG variants overstates it.

**D — what is blocking the rest, and who unblocks it?** 19 distinct blockers,
grouped by the person who can clear them rather than by field name, because that
is the only grouping anyone can act on: 7 settings (our own lender and servicer
details), 4 decisions (governing law, the deed-of-trust trustee, the last day to
draw, the maximum-LTV covenant), 8 data (county, the title underwriter, the
state environmental agency, the NY tax lot, the CEMA gap amount).

**E — what does the payload builder ACTUALLY emit?** The catalogue declaring a
key is a promise, not a proof. This section runs the real builder against a
fixture that supplies every declared value and reports what comes out, because a
key that is declared and never written prints BLANK on a recorded instrument and
nothing anywhere complains.

---

## Findings that need a person

### 1. A company guarantor has no signer block (a code gap, found by section E)

`buildPayload` writes only `guarantor_name` and `guarantor_address`. It does not
write `guarantor_title`, and it does not write the nested `signatories` array at
all — although the borrower block right above it does, and the catalogue
declares both. So when a **company** guarantees the loan (a parent guaranteeing
its subsidiary's deal, which happens on the 5+ unit commercial products) the
guaranty prints with a blank signature block. Exposure is small today because
most guarantors are individuals, who need no signer block. It is a contained
fix in `src/doclab/payload.js`.

### 2. Two published products have no published field list

`Ground Up Construction` and `CEMA RTL` are in PLL's product list and have **no
column in the variable matrix**, so we cannot know what they ask for. Ground-up
matters most — it is one of the three products the owner named as core to the
RTL build. On CEMA the matrix carries a column called `CEMA Acquisition Building
Loan` that is *not* in the product list, so the two are probably the same thing
under two names; "probably" is not something to draft a recorded mortgage on.

### 3. `catalog.VARIABLES` is missing 8 published variables

`purpose_of_loan`, `servicer_address`, `servicer_name`, `settlement_agent_name`,
`settlement_agent_name_and_address`, `trustee`, `underwriter`,
`underwriting_fee`. All eight ARE decided in the field map, which is what the
payload builder reads, so nothing prints blank because of this — but two lists
of the same thing disagreeing is how a variable ends up decided in one place and
invisible in the other. Worth reconciling the next time that file is touched.

### 4. Open questions for PLL

- The field list for **Ground Up Construction** (and whether `CEMA RTL` and
  `CEMA Acquisition Building Loan` are one product).
- Whether **loan modification / extension** templates exist. Ten v3.1.4
  variables describe them; no template claims any of them.
- `acknowledgement_corporate_status` is published **three different ways for an
  LLC** — one wording in the dictionary, another in the integration document, a
  third in their own sample payload — and **not at all for a partnership or a
  trust**. What we send for those two is our own analogy, and it merges into a
  sentence on a notarised acknowledgement.
- `company_filing_status` (v3.1.4) has an **empty description** and appears in
  no template's variable list. We send nothing for it.

---

## The four traps this audit has already fallen into

Each one produced a confident wrong answer. The script carries the same list in
its header; keep the two in step.

1. **Comparing against `field-map.FIELDS` alone.** Our catalogue also models fee
   templates, array item keys, nested signatories and matrix pseudo-keys, and the
   spreadsheet carries section headers that are not variables. Miss any of those
   and a healthy integration reports 40 missing fields.
2. **Treating a non-blank matrix cell as a claim.** The matrix uses exactly three
   cell values — `✓`, `—` and blank — so a "not blank and not 'no'" test reads
   every em dash as a claim and reports that every template needs every variable.
   That turned 51 variables into 81. **Test for the tick.**
3. **Trusting what the catalogue declares.** See finding 1 — the guarantor signer
   block was declared and never written, and only running the builder found it.
4. **Identifying a section heading by its empty description.** Three heading rows
   in the exported dictionary carry a stray `3.1.0` in the Description column, so
   a no-description test silently folds Lender Information, Loan Terms and
   Property Details into the section above them. A heading is a member of the
   headings list.

## Scope

DSCR and prepayment penalty are **not** part of the RTL build (owner direction).
DSCR template columns are counted separately and never mixed into the RTL
readiness figures; the `pre_payment_penalty` block is skipped in section E with
the reason stated. The focus is bridge, holdback, NY building loan and ground-up
construction.
