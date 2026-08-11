# DocLab integration — research and blueprint (shift 1: foundations)

**Owner-directed 2026-08-09.** DocLab is going to draft our loan documents. This is the research
behind that build, the decision about where it lives in the workflow, and what was built in the
first shift.

Companion documents in this folder:

| File | What it is |
|---|---|
| `DOCLAB-API-REFERENCE-V3.1.md` | The API itself — endpoints, auth, statuses, codes, notifications |
| `DOCLAB-DATA-DICTIONARY.md` | Every variable, the fee templates, and which template uses what |
| `DOCLAB-RTL-SCOPE.md` | What this build is allowed to ask for, and what it refuses |
| `DOCLAB-DATA-MODEL-GAPS.md` | **Where our data model should change to match theirs** |
| `reference/` | The untouched source files PLL gave us, plus machine-readable extracts |

---

## 1. What DocLab is, and who runs it

DocLab is the loan-document platform of **Private Lender Law (PLL)** — `privatelenderlaw.com`, the
Confluence space these documents were exported from. You give it the facts of a loan; it merges them
into its own legal templates and returns a drafted, reviewable loan package: promissory note,
mortgage or deed of trust, loan agreement, guaranty, entity resolutions, and the rest.

**The single most important finding of this research is that we already work with this firm, every
single day, at exactly this step in the file.**

`src/lib/closing-prep.js` — the third order on our Orders desk — emails the closing package to
`TeamAG@privatelenderlaw.com` and opens a closing email chain so the drafting conversation stays
attached to the loan file. `db/005` has carried the condition describing that step since day one:

> `rtl_p5_atty` — *"Attorney email sent: 'File ready for closing prep'"*
> hint: *TeamAG@privatelenderlaw.com — attach term sheet, contract (+assignment), LLC docs,
> insurance invoice, ID*

So DocLab is not a new vendor and not a new step. **It is the same firm and the same step, with a
structured payload instead of an email attachment and a human reading it.** That single fact decides
almost every design question below — where it goes, what it replaces, what it must not break, and
what "done" looks like.

## 2. Where it goes in the workflow

Closing already runs as: **clear to close → order attorney closing prep → the attorney drafts →
documents come back → e-sign → fund**. DocLab slots into the middle three:

```
                       today                                     with DocLab
  ──────────────────────────────────────────  ──────────────────────────────────────────
  Clear to close                              Clear to close
  Order closing prep  (closing-prep.js)       Order closing prep  (unchanged — the firm
    → email + attachments to TeamAG@            still gets the package and the contacts)
  A person at PLL reads it and drafts         PILOT ALSO submits the structured request
  Documents come back on the email chain      DocLab drafts and returns Word + PDF
  Someone files them onto the file            PILOT files them onto the closing conditions
  E-sign  (esign/orchestrate.js)              E-sign — unchanged
  Fund                                        Fund — unchanged
```

**The email order is not replaced, and that is deliberate.** The email carries things the API has no
field for: the title company's contact details handed over in the body (never as a copied
recipient — the rule `rtl_p5_titleinfo` exists for), the borrower's driving licence, the entity
documents, the insurance invoice. The API carries the *numbers and names* that get merged into the
templates. They are complements, and for the first live files they should run side by side so the
firm can compare what the API produced against what they would have drafted by hand.

**Where the button goes:** the Closing workspace (`ClosingPanel.jsx`, `sec-closing`), beside the
existing closing-prep order — because that is where the closer already stands when they are getting
documents drawn, and `closing_workflow.stage` already models `ready_for_docs` as its own stage.

## 3. How the API works

Four steps, and the only difficult one is the third.

1. **Submit.** `POST /api/v3.1/loanprocess/loan-document` with a JSON payload: a `template` object
   that picks the template, and a `variables` object with everything that gets merged.
2. **They review.** A PLL person may ask for more information (status `moreInfo`) or reject it.
3. **Approve.** Approval generates the Word documents; a further call generates the PDF. Both can be
   automatic (`auto_approve`, `auto_approve_pdf`).
4. **Download.** PDF or Word, when they exist. Not-ready answers `202`, which is not an error.

Status moves asynchronously and can move **backwards** — a request that reached `submitted` returns
to `moreInfo` the moment a reviewer asks a question. Two ways to follow it: long-polling
`GET /request/{id}` (their own recommendation) or a SignalR push hub. **The poller is the one to
build first** — a push we miss is a closing that stalls silently, and their own documentation calls
polling "simple and reliable".

### The one thing that makes this dangerous

**DocLab requires exactly three fields: lender name, loan category and state. Everything else is
optional.**

That sounds forgiving. It is the opposite. A missing value does not bounce — it produces a mortgage
with a blank where a number should be, or it surfaces days later as a person at PLL asking a
question. Neither failure is visible at the moment we submit, which is the only moment it is cheap
to fix.

**So the whole shape of what was built this shift is a response to that**: encode which variables
each template actually needs, check the file against that list before submitting, and report exactly
what is missing rather than sending a package with holes in it.

Their per-template matrix is what makes this possible, and it is committed at
`reference/json-key-matrix.csv`.

## 4. Scope — RTL only

Owner-directed: *"Anything related to DSCR and prepayment penalty doesn't belong to our RTL build.
We need to focus on bridge, hold back, New York building loan ground up construction and stuff like
that."*

Full reasoning in `DOCLAB-RTL-SCOPE.md`. In short: DocLab is one API serving both families, and the
two are one string apart, so "we don't do DSCR here" is enforced in the transport
(`src/doclab/scope.js`), not in a comment.

The prepayment half has a subtlety worth repeating: **`prepayment_option_code` is a required field**,
so leaving it out is an invalid request, not "no penalty". The RTL answer is the code that asks for
**no** penalty — `RTL-No` — sent deliberately on every file, and validated against DocLab's live
per-state list.

## 5. What was built in this shift

Everything here is pure or off-by-default. **Nothing is wired to a screen and nothing can reach
DocLab yet** — there are no credentials.

| Piece | What it does |
|---|---|
| `docs/doclab/reference/` | Every source file PLL gave us, plus CSV extracts of the dictionary, the per-template matrix and the product names |
| `src/doclab/catalog.js` | What DocLab publishes about itself, as data. Statuses, categories, fee templates, the variable dictionary, the matrix |
| `src/doclab/scope.js` | The RTL gate. Refuses a DSCR category or a DSCR prepayment code, structurally |
| `src/doclab/field-map.js` | Where every variable comes from in PILOT — and, for the ones nothing feeds yet, exactly what is missing |
| `src/doclab/payload.js` | Builds the request. Pure. Never fabricates a value |
| `src/doclab/client.js` | The guarded transport. Three switches, dry-run, token lifecycle, retries |
| `db/509_doclab.sql` | Requests, their event history, and the cached template/prepayment catalogues |
| Config, switches, API-Health card | Off by default, flippable without a deploy |
| 3 test suites, 59 checks | In `npm test` |

**The reference data and the code cannot drift.** `test-doclab-catalog-pure.js` re-reads the
committed CSVs and re-derives what the catalog claims. When PLL ships a new dictionary, you replace
the CSV, run the test, and it tells you exactly what moved.

### How complete a package can PILOT build today?

Measured by running the field map against each template's own published variable list:

| Loan category | Variables it needs | Ready now | Still missing |
|---|---|---|---|
| 12 Month | 51 | 33 | 17 |
| 12 Month with Holdback | 54 | 35 | 18 |
| NY Building Loan | 53 | 35 | 17 |
| Commercial | 45 | 32 | 12 |
| Commercial with Holdback | 42 | 29 | 12 |
| CEMA RTL | 58 | 38 | 19 |
| **Ground Up Construction** | **unknown** | — | — |

About two thirds ready, and every gap is named with a reason rather than left as a surprise. What
the gaps actually are, and what to change on our side: **`DOCLAB-DATA-MODEL-GAPS.md`**.

**Ground Up Construction is the one to raise with PLL first.** They list it as a loan product, but
their per-template matrix has no column for it — so we do not know what it needs. The code reports
that as *unknown*, never as *nothing missing*, because "nothing missing" on a template we have no
field list for is the most dangerous thing it could say.

## 6. Open questions for Private Lender Law

Ordered by what blocks the most.

1. **Credentials** — a client id and secret, and the base URL. Sandbox and production share a base
   URL and are told apart only by the credential, which is worth confirming out loud.
2. **Our template lender name** — the exact string our templates are filed under. It is a routing
   key and is not necessarily our legal name.
3. **Which loan categories are configured for us**, in sandbox and in production. Their own
   documentation warns the two do not share templates.
4. **The exact endpoint paths.** Their Confluence export renders several endpoint blocks as images,
   so only three paths came through as text. All are overridable by environment variable and the
   API-Health card reports which are still unconfirmed.
5. **The `/api` prefix.** Their create endpoint is printed as `/api/v3.1/...` and their prepayment
   endpoint as `/v3.1/...` on a full sandbox URL. Both spellings are reproduced exactly rather than
   tidied into agreement.
6. **`state_abbrev`.** Their global dictionary says it is the two-letter state code. Their
   per-template matrix and their own example payload both say it is the state *environmental
   protection agency* ("FLDEP — Florida Department of Environmental Protection"). We need the list
   of environmental options. Until then the field is not sent at all.
7. **Ground Up Construction's field list** — see above.
8. **Which fee templates our packages support**, and whether the flat fee variables or the dynamic
   fee array wins when both are sent.
9. **Is `exit_fee_percentage` the same thing as our deferred origination fee?** They look
   identical — a percentage charged at payoff — but they are printed on a note, so guessing is not
   acceptable.

## 7. The next shift

In dependency order, once credentials exist:

1. **Preflight against the sandbox.** Confirm the paths, the token shape, and pull the lender /
   category / state catalogue into `doclab_templates`.
2. **Load the file.** A `getDocLabData(applicationId)` alongside `getClosingPrepData` — the same
   shape, so the two can never disagree about what a file says.
3. **The category rule.** Programme + loan type + holdback → DocLab category. A decision, written
   down once, never inferred silently.
4. **The desk.** A card in the Closing workspace: what is ready, what is missing, submit, and the
   live status.
5. **The poller.** Follow the status, pull the documents when they exist, file them onto the closing
   conditions through the ordinary upload path so they mirror to SharePoint for free.
6. **The two-way conversation.** Their comments and issues surfaced on the file, so a `moreInfo`
   request is something the closer sees rather than something that stalls.

## 8. Guardrails this build must keep

- **No frozen number is ever recomputed.** Every figure comes off the registered quote exactly as
  the engine sized it. This module reads and formats; it never re-derives.
- **The note buyer never reaches a loan document.** `applications.lender` is the capital partner
  (Fidelis, Blue Lake, EMCAP), not the lender on the note. A loan document is borrower-facing, and
  the test asserts no DocLab field is fed from that column.
- **RTL only**, enforced in the transport.
- **Nothing is fabricated.** A value we do not have is absent and reported.
- **Off by default**, with a test mode that wins over the send gate.
- **Previous and future.** Nothing here changes an existing file; the tables are additive and the
  email closing-prep order is untouched.
