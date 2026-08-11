# What this build asks DocLab for — and what it refuses

**Owner-directed, 2026-08-09, in the owner's own words:**

> *"Anything related to DSCR and prepend penalty doesn't belong to our RTL build. We need to focus on
> bridge, hold back, New York building loan ground up construction and stuff like that."*

Enforced in code by `src/doclab/scope.js`. This document is why it is code and not a convention.

---

## Why it is a refusal in the transport, not a note in a document

DocLab is **one API serving both families**. There is no separate DSCR endpoint, no separate
credential, no separate base URL. The difference between drafting a bridge loan and drafting a
30-year rental loan is **one string** in the payload:

- `template.loan_category` decides which document set gets drafted, and
- `prepayment_option_code` decides which prepayment clause is merged into the promissory note.

Nothing at PLL's end knows which product *we* are. So "we don't do DSCR here" has to be something the
code cannot do, not something a person remembers — the same reasoning behind
`scripts/check-product-separation.js`.

`scope.assertInScope()` is called in **two** places on purpose: in the payload builder, and again in
the transport on the way out. The second is not redundant. It is what lets the builder be forgiving
about a half-filled file (so a screen can show a closer what is still missing) without weakening the
guarantee, because nothing can be submitted without passing the transport.

## In scope

Every RTL loan category DocLab publishes. PLL is mid-rename, so both spellings are recorded:

| Category (what we send) | Their new name | Holdback |
|---|---|---|
| `12 Month` | Stabilized Bridge 1 to 4 | no |
| `12 Month with Holdback` | Bridge Rehab 1 to 4 | yes |
| `Ground Up Construction` | *(no change)* | yes |
| `NY Building Loan` | *(no change)* | yes |
| `CEMA RTL` | NY CEMA RTL | no |
| `Commercial` | Stabilized Bridge 5+ Unit | no |
| `Commercial with Holdback` | Bridge Rehab 5+ | yes |

Which of the two spellings **our** templates are filed under is a question only DocLab's
lender/category endpoint can answer, so the alternate names are documentation — never an alias we
send.

## Out of scope

`DSCR SFR`, `DSCR Portfolio`, `CEMA DSCR`, `Commercial DSCR SFR`, `Commercial DSCR Portfolio`,
`DSCR - 30 Year Single Family Rental`, and every `DSCR-*` prepayment code.

The gate refuses two ways, and **the second one is the one that matters**:

1. **The published list** — every category and code DocLab has told us about *today*.
2. **A word test** — a category or code containing `DSCR` that we have never seen before. Their names
   are mid-rename, so a name we do not recognise is the *expected* case, not the exotic one. An
   unrecognised DSCR name is refused rather than allowed through on the grounds that it is not in our
   table.

The word test is a **word-boundary** match, not a substring one — `DSCRAMBLER Loan` is not a DSCR
product, and a gate that is merely strict rather than right is its own kind of bug.

An unknown **non-DSCR** category is a *warning*, not a refusal. PLL may genuinely have added a
product, and refusing would make every new one a code change.

## The prepayment subtlety

"No prepayment penalty" cannot be expressed by leaving the field out.

- `prepayment_option_code` is **required at the top level** — their migration note says so twice.
- The `pre_payment_penalty` array is required too, *"even if the selected option does not utilize
  it."*
- A template whose `{{Pre_Payment_Penalty}}` tag never resolves is a promissory note with a hole
  in it.

So omitting it is not "no penalty" — it is an invalid request, or a defective note.

**The RTL answer is the code that asks for no penalty: `RTL-No`, sent deliberately on every file.**
"No prepayment penalty" is a thing we state, not a thing we omit.

And it is checked, not assumed. Prepayment penalties are regulated per state and DocLab publishes the
valid options per state. If a state's list does not offer `RTL-No`, PILOT **does not substitute
something plausible** — it sends nothing, and says so:

> *DocLab does not offer "RTL-No" in this state. Somebody has to choose the right no-penalty option
> from: …*

Picking a prepayment clause on a lender's behalf is not a decision code gets to make.

## Fail closed

A blank loan category is **refused**, not assumed to be fine. With nothing to judge we cannot say a
request is in scope, and "we could not tell" must never read as "yes". Nothing is lost: DocLab would
refuse it too.

## What reopening this would take

The owner said it in their own words, so it takes the owner's own words to change it. A general "make
it better" is not authorisation to start drafting DSCR documents.

If it is ever reopened, the work is genuinely small — the catalog already carries every DSCR
category, every DSCR prepayment rung and the full per-template matrix for the DSCR columns, because
the reference data was transcribed complete rather than filtered. Reopening is a `track` flag, not a
rebuild. That was deliberate: scope decisions change, and the cost of changing one should be a
decision, not a data-entry project.
