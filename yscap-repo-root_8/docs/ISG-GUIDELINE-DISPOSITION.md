# ISG guideline DISPOSITION — how a note-buyer guideline is handled (owner-directed 2026-07-24)

## The problem the owner reported

The Investor Guidelines overlay was turning **back-office reminders** into "no condition on
the file → post one." A real underwriter does not open a *condition* for these — they read the
file, or wait for the right document, or only raise a concern when something looks off. Concrete
examples the owner corrected (these are EXAMPLES of a pattern to apply to EVERY guideline):

- **E-MAIL ADDRESS FOR BORROWER** — informational. Read it off the borrower's contact info on the
  file; only flag an EMPTY slot. Never a condition.
- **NON-ARMS-LENGTH TRANSACTION** (ALL note buyers, not just Blue Lake) — a back-of-mind concern.
  Only surfaces WITH a reason: a relationship found on the fraud report, or a connection between
  the parties on an assignment of contract (flipper↔buyer, signer↔signee). Silent otherwise, and
  when it fires it must EXPLAIN why.
- **RURAL PROPERTY VERIFICATION** — never a standing condition. Read the **appraisal findings**
  once the appraisal is in (rural designation, road access, lot size, comp distance). If rural →
  raise to escalate.
- **APPRAISAL TRANSFER REQUIREMENTS** — read the appraisal when it arrives: in YS Capital's name →
  clears; not in our name → follow the buyer's rule (Blue Lake won't accept even with a transfer
  letter → **fatal**). Not a standing condition.
- **OCCUPANCY / BUSINESS-PURPOSE CERT** — part of the DocuSign/term-sheet package. Only look for it
  AFTER the package comes back.

Root cause in the specs: these rows carry an **empty trigger** (`T.rural = {}`,
`T.non_arms_length = {}`, `T.appraisal_other_lender = {}`), and an empty trigger fail-opens to
"always applies," so the condition is always "applicable → not on file → coverage gap." The trigger
mechanism is the wrong tool. The right tool is a **disposition** on each guideline that says HOW it
is handled.

## The disposition model

Every note-buyer guideline row carries a `disposition` (explicit on the spec row; inferred from
`clears_by`/`domain` when absent). It governs what the overlay does:

| Disposition | Meaning | Overlay behavior |
|---|---|---|
| `document` (default) | A real document/condition the file must carry. | Coverage gap if the mapped PILOT condition is missing (today's behavior). |
| `file_data` | A fact already on the file (email, phone, contact). | Read the field; surface **only if empty**, as an informational "fill this in" — never "post a condition." |
| `appraisal` | Only knowable from the appraisal (rural, transferred appraisal, comps). | **Silent until the appraisal is in.** Once in, read the appraisal findings; surface (escalate) only if the concern is real. |
| `closing_package` | Arrives with the DocuSign / term-sheet closing package (occupancy cert, business-purpose cert). | **Silent until the package is present.** Then treat like a document check. |
| `concern` | A back-of-mind risk (non-arms-length). | **Never proactive.** Surface only when a concern signal exists elsewhere (fraud report, relationship, assignment chain), WITH an explanation. |
| `system` | An automatic eligibility rule the engine already evaluates (loan age, exit strategy, min/max size). | Not a document to post. Silent when it passes / is outstanding; surfaces via the existing CONFLICT path when a value breaks the rule. |

Governing discipline (unchanged): **never fabricate.** When a non-`document` disposition's
triggering signal is absent, the item is SILENT — no coverage gap. So rural/non-arms-length/
email/transfer/occupancy stop appearing as "post this condition" the moment this ships, even before
every upstream signal (borrower email, appraisal findings, concern detectors) is fully wired.

## Where it lives

- `dispositionOf(cond)` in `desk.js` — explicit `cond.disposition` wins; else inferred from
  `clears_by` (`internal_verification`→file_data, `system`→system, `attorney_closing`→
  closing_package) and `domain` (`non_arms_length`→concern, `rural`→appraisal, `occupancy`→
  closing_package). `base()` carries `disposition` onto every verdict.
- `assess()` — `isGap` fires **only for `document`** (and a `closing_package` once its package
  signal is present). `file_data`/`concern`/`appraisal` each get their own handler that stays
  silent without the triggering signal.
- The specs (`corrfirst-fnf-spec.js`, `bluelake-rtl-spec.js`) annotate the owner's named rows with
  an explicit `disposition` (+ a `data_field` for file_data and a `concern_field` for concern).

## Build stages

1. **This PR:** `dispositionOf()` + disposition-aware `isGap` + explicit annotations on the named
   rows + file_data/concern/appraisal silent-without-signal handlers + pure tests. The overlay
   stops posting back-office rules as conditions. Signals not yet populated → correctly silent.
2. **Next:** wire the real signals — `borrower_email` from the file contact (email-condition bug
   #241), appraisal findings (rural, transferred, comps) into the `appraisal` handler, and the
   non-arms-length concern from the fraud report + assignment chain into the `concern` handler.
3. **Then:** the appraisal handler escalates per note buyer (Blue Lake transferred = fatal even
   with a letter; CorrFirst = transfer letter required), reading the appraisal desk output.
