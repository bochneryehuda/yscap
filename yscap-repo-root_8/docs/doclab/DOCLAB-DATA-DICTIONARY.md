# DocLab data dictionary — the variables, the fees, and which template needs what

The machine-readable source of everything on this page is committed beside it:

| File | Rows | What it is |
|---|---|---|
| `reference/data-dictionary-global.csv` | 111 | The dictionary spreadsheet PLL sent, exactly as sent |
| `reference/data-dictionary-full.csv` | 104 | Their Confluence dictionary — a **superset**, carries the 3.1.4 additions |
| `reference/json-key-matrix.csv` | 82 × 30 | **Which variable each template needs.** The important one |
| `reference/loan-product-names.csv` | 12 | Current → new loan product names |
| `reference/Master_3.1.3.1.jsonc` | — | Their complete example payload, comments intact |

`src/doclab/catalog.js` is a faithful transcription of these, and
`scripts/test-doclab-catalog-pure.js` re-reads the CSVs and fails if the two have drifted. **When PLL
ships a new dictionary: replace the CSV, run the test, and it tells you exactly what moved.**

---

## The matrix is the useful document, not the dictionary

The dictionary lists ~100 variables. It does **not** say which ones a given loan document actually
needs — and since DocLab requires only three fields and treats the rest as optional, "what does this
template need?" is the only question that prevents a mortgage being drafted with a blank in it.

The matrix answers it: one row per variable, one column per template **and security instrument**.

The instruments matter. A loan is secured by a **mortgage (MTG)**, a **deed of trust (DOT)** or a
**deed to secure debt (DTSD)** depending on the state — so `12 Month` is three columns, not one.
**DocLab picks which one from the state, and the matrix does not record which state maps to which.**

That is why `catalog.variablesForCategory()` returns the **union** of a category's columns. We cannot
know in advance which instrument will be chosen, so:

- taking the **union** may ask for a value the chosen instrument does not print — a question to a
  colleague;
- taking the **intersection** would submit without a value the chosen instrument *does* print — a
  blank on a recorded document.

Over-collecting is cheap. Under-collecting is not.

### The fourteen RTL columns

`12 Month` (DOT/DTSD/MTG) · `12 Month with Holdback` (DOT/DTSD/MTG) · `NY Building Loan` (MTG) ·
`Commercial` (DOT/DTSD/MTG) · `Commercial with Holdback` (DOT/DTSD/MTG) · `CEMA Acquisition Building
Loan`

### What each RTL template needs, and how much of it we can fill today

| Loan category | Variables | Ready now | Still missing |
|---|---|---|---|
| 12 Month | 51 | 33 | 17 |
| 12 Month with Holdback | 54 | 35 | 18 |
| NY Building Loan | 53 | 35 | 17 |
| Commercial | 45 | 32 | 12 |
| Commercial with Holdback | 42 | 29 | 12 |
| CEMA RTL | 58 | 38 | 19 |
| **Ground Up Construction** | **unknown** | — | — |

**Ground Up Construction has no column in the matrix at all**, although PLL lists it as a loan
product. So we do not know what it needs, and the code reports that as *unknown* — never as *nothing
missing*, which on a template with no published field list would be the most dangerous thing it could
say. First question to ask PLL.

### Nine variables that are DSCR-only

`collateral_property_name`, `grace_period_days`, `initial_advance_upon_closing`,
`late_charge_percentage`, `mers_number`, `monthly_escrow_payments`, `monthly_payment_with_escrows`,
`property_street_address`, `state` — no RTL column asks for any of them. Recorded so nothing reaches
for them by mistake.

---

## Three variables whose name lies

These are the ones that would put the wrong thing on a recorded document. All three are documented in
`src/doclab/field-map.js`, where anyone wiring a value will actually read them.

### `state_abbrev` is not the state

Their global dictionary says *"Two-letter abbreviation of the state (e.g. NY)"*. Two other sources
disagree, and both are more specific:

- the per-template matrix: *"Abbreviation for the state department of environmental protection (e.g.
  CADEP, NYDEP, TXDEP)"*
- their own example payload: `"FLDEP - Florida Department of Environmental Protection"`, commented
  *"Must be a value from provided list of environmental options"*

Two of three sources agree it is an environmental-agency code, and one of those is a live example.
Sending `"NY"` would merge the wrong text into an environmental-indemnity clause. **We do not have
their list, so PILOT sends nothing at all for this field** — the one place where the safest reading
of the documentation is to ask rather than to guess.

### `underwriter` is the title underwriter

*"The name of the title underwriter issuing the loan policy"* — Fidelity National, First American,
Old Republic. It is on the title commitment.

PILOT has a staff role literally called `underwriter`. Wiring that in would print the name of the
person who approved the credit onto a title clause.

### `loan_to_value_percent` is a covenant, not a measurement

*"The maximum loan to value ratio permitted under the terms of the loan. If the property value falls
and the LTV percentage increases, the borrower must pay down the loan to this percentage to avoid
default. Also known as a mark to market provision."*

That is a term of the deal, not our calculated LTV. Sending our computed figure would write a
mark-to-market covenant at whatever this deal happens to price at.

---

## The fees

Two structures, and the difference is real rather than stylistic.

**Single fees** each have their **own paragraph of legal language** and may appear **once**:

`Legal Fee` · `Prepaid Interest` · `Origination Fee` · `Interest Reserve` · `Initial Draw Fee` ·
`Draw Set-Up Fee` · `Subsequent Draw Fees` · `Appraisal Holdback` · `Exit Fee`

**Multiple fees** (`Standard Fee`) repeat **one generic sentence** with a different name and amount
each time. This is how an arbitrary named fee gets into the documents at all — their own example
produces:

> *The sum of $2,000 shall be disbursed by Lender on behalf of Borrower and simultaneously paid to
> Lender (the "Radon Testing")*

So a fee typed as free text called "Interest Reserve" comes out as that generic sentence instead of
the proper interest-reserve clause — which is a real paragraph of the loan agreement, several
sentences long, with default consequences in it.

**`sort_order` is one sequence across both arrays**, not one per array — their example numbers seven
single fees 1–7 and then the multiple-fee group 8. Getting it wrong reorders the fee paragraphs in
the loan agreement.

### The legacy flat variables

The old per-fee variables still exist and their example payload still sends them, commented *"Not
required if template supports dynamic fees"*. Which of the two a given template wants is a
per-template fact we do not have — so PILOT sends both, exactly as their own example does. Worth
confirming with PLL.

| Flat variable | Dynamic fee template | Repeatable |
|---|---|---|
| `interest_reserve` | Interest Reserve | no |
| `counsel_fee` | Legal Fee | no |
| `origination_fee` | Origination Fee | no |
| `prepaid_interest` | Prepaid Interest | no |
| `initial_draw_fee` | Initial Draw Fee | no |
| `draw_setup_fee` | Draw Set-Up Fee | no |
| `subsequent_draw_fee` | Subsequent Draw Fees | no |
| `funding_fee` | Standard Fee | **yes** |
| `processing_fee` | Standard Fee | **yes** |
| `underwriting_fee` | Standard Fee | **yes** |
| `other_fee` | Standard Fee | **yes** |

---

## The repeating sections

`borrowers[]` (each with `signatories[]`), `guarantors[]`, `collateral_properties[]`,
`pre_payment_penalty[]`, and `fees` — which is not an array but an object of two arrays.

The matrix names these by their **inner** key (`borrower_name`, `signatory_name`) because that is
what the template merges; it never names the array. So the matrix telling you a template needs
`borrower_name` is what tells you it needs the `borrowers` array.

**A spelling quirk to leave alone:** it is `pre_payment_penalty` (with the underscore) inside
`variables`, and `prepayment_option_code` (without) at the root. That is DocLab's inconsistency,
reproduced verbatim. Do not "correct" either one.

---

## Everything else PILOT does not hold

Roughly a third of what each template needs has no source in PILOT yet. Every one is named with a
reason in `src/doclab/field-map.js`, and what to change on our side is
**`DOCLAB-DATA-MODEL-GAPS.md`** — the entity type, the signatory titles, the county, the legal
description, the NY tax-map numbers, the trustee and the title underwriter.
