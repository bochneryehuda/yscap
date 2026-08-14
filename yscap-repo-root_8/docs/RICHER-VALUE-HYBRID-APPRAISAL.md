# Richer Value — the Hybrid Appraisal (the THIRD appraisal vendor)

**Owner-directed 2026-08-14.** RTL only. Off by default behind `RV_ENABLED` /
`RV_OUTBOUND_ENABLED`.

---

## 1. What this is, and why it is not a form on one of the other two desks

Richer Value sells **evaluations**, not URAR appraisals. The product we order —
their `reno-arv`, "Renovation Analysis" — comes back with an **As-Is value AND an
After Repair Value on one order**, priced off the renovation budget, for well
under half the price of a full appraisal.

Three things follow from that, and every design decision below is one of them:

1. **There is no MISMO XML, and there never will be.** It is not an appraisal that
   happens to be missing its data file; the product does not have one. So ordering
   one **waives the appraisal data file on the loan file automatically** (§4) —
   the owner's instruction, and the reason this is not simply "another form".
2. **The values come back as DATA, not as something to read off a page.** Their
   API returns the figures, so PILOT fills the As-Is and the ARV in itself (§5).
3. **The report is still a PDF, and it still belongs on the appraisal condition.**
   Owner-confirmed: *"the PDF should go to the appraisal condition instead of a
   traditional appraisal."*

**IT IS NOT THE DEFAULT.** Owner-directed: *"whenever they choose, the default
should still stay NAN."* The vendor selector on the order screen starts on
AppraisalScope / NAN; Richer Value is a deliberate third choice. Nothing in the
code picks between the three vendors.

---

## 2. Where everything lives

| Concern | File |
|---|---|
| Transport / auth / the guarded surface | `src/richervalues/client.js` |
| Their catalogue, cached | `src/richervalues/reference.js` (+ `rv_reference_cache`) |
| PURE order builder + validation | `src/richervalues/order-build.js` |
| Loan file → order, place, apply values | `src/richervalues/order-service.js` |
| PURE report reader (the two figures) | `src/richervalues/results.js` |
| Filing the PDF onto the condition | `src/richervalues/documents.js` |
| Status intake + the poller | `src/richervalues/sync.js` |
| Staff desk | `src/routes/richervalues.js` → `/api/richer-value` |
| Public webhook | `src/routes/richervalues-webhook.js` → `/api/richer-value/webhook` |
| Schema | `db/548_rv_orders.sql` |
| Front end | `app-v2/src/components/AppraisalOrderSection.jsx` (third adapter + its own builder and order card) |
| The XML waiver itself | `src/lib/appraisal/xml-waiver.js` (shared — see §4) |

Tests: `scripts/test-richer-value-order-build.js` (pure, 105 assertions),
`scripts/test-richer-value-xml-waiver.js` (pure, 39), `scripts/test-richer-value-db.js`
(DB-gated schema + FK + trigger). All three are in `npm test`.

---

## 3. Ordering, step by step

Their intake is **multipart/form-data** and their validator is an **allow-list per
branch**: a field that does not belong to the branch you chose fails the WHOLE
order, and fails it as an **HTTP 200 carrying `success:false`**. Verified live — a
pricing call carrying `gla_include` came back `"gla_include" is not allowed`.

So the builder's real job is to send exactly the set the chosen branch allows, and
to **say out loud what it left out** (`dropped[]` on the preview). The branches:

* single vs batch — this desk is **single only**; an order belongs to a loan file
* vacant land vs a structure, and under a structure, partly built or not
* flood certification on or off — the borrower's name rides with it
* a historical valuation date, or none (sending one without the flag is refused)
* the inspection type — lockbox fields, or access contacts, or neither

**An intake is not yet an order.** `POST /order/submit` returns an `intake_token`;
the ORDER (and its `order_token`) only exists once the intake is **paid**. Our
tenant is set up for invoicing (`report_invoicing: "1"`), so `RV_PAYMENT_METHOD`
defaults to `ADD_TO_INVOICE` and the desk settles it in the same action. A submit
that succeeded but did not settle is a **recoverable** state with its own retry
button — never a reason to place a second order.

### Where the property facts come from

This report prices off the property's own figures, and **bedrooms, bathrooms and
lot size are not columns on a loan file**. The order fills them, in this order:

1. what the staffer typed — always wins;
2. the loan file (`year_built`, `living_area_sqft`);
3. **the property warehouse** (`properties`, db/409) — every property any appraisal
   we have imported has described, including as somebody else's comparable, so the
   subject of a new loan is often already in it;
4. nothing — the field is **MISSING** and a human answers it.

Nothing is guessed. Every derived value carries its own sentence and is flagged on
the preview for a human to check.

---

## 4. THE AUTOMATIC XML WAIVER

> *"Whenever you order this type of appraisal on our system, the XML should
> automatically be waived because this appraisal does not require XML and doesn't
> work with XML."* — owner, 2026-08-14

The appraisal-documents condition (`rtl_cond_appraisaldocs`) requires an **XML
slot + a PDF slot + a successful MISMO import**. A Hybrid Appraisal can satisfy the
PDF half and can never satisfy the other two.

PILOT already had the mechanism: the **"no appraisal XML" waiver** (db/370). It had
two kinds of reason — a transferred appraisal, which clears itself, and everything
else, which opens a policy exception for an admin. This adds a **third reason,
`hybrid_appraisal`**, which clears itself too — and it is the strongest of the
three, because it is not a report missing its data file, it is a product that has
none. Sending that to an admin would ask them to approve the same fact on every
order forever, which is a queue nobody reads rather than a control.

**What still binds, and this is the part that keeps it honest:**

* the **PDF report is still required** on the condition;
* the **As-Is value and the ARV must still be on the file** before it can be
  signed off — which is what §5 fills in;
* a waiver a **human** recorded is never overwritten (their note and their
  exception survive);
* a file that already has an **imported appraisal** is never waived — there IS XML,
  so the claim would be false;
* a person **cannot pick this reason by hand** (it is deliberately not in the
  manual reason list): the claim it makes is "an order for a no-XML product exists
  on this file", and only the order desk can know that.

The sign-off gate's wording changes with it, because otherwise a reviewer is sent
hunting for a data file that does not exist for this product. Requirements
identical, sentences different.

---

## 5. READING THE REPORT — the As-Is and the ARV

There is no XML, so `results.js` is this product's equivalent of the MISMO
extractor, and it is held to the As-Is reader's standard: **never store a guess.**

* **As-Is** ← `results.valuation_summary.estimated_as_is_value` (their headline
  conclusion), falling back to the strategy grid's "As Is Value" row.
* **ARV** ← the strategy grid's **"ARV"** row. The grid is the point of this
  report: it prices several renovation strategies side by side (minimum / partial
  / full) and names the one it recommends in a `best` column. The ARV is taken
  from `best`, and `arv_basis` records that — an ARV with no provenance is a number
  nobody can defend to an investor.

Guards, each of which is a real failure mode:

* a percentage or a multiplier is **not money** (their grid mixes "16.30%" and
  "1.43x" in among the dollars — rows are picked by **title**, never by position);
* a value outside \$1,000–\$100,000,000 is a misread, not a property;
* **the ARV must be above the As-Is.** At or below means one of the two was
  misread, and which one is not knowable from here — so they are **both still
  reported**, `valuesUsable` is false, and a human decides. They are never swapped;
* a batch envelope carrying other properties is refused rather than read onto this
  file.

**Applying them** (owner: auto-apply both, audited) goes through the **shared
As-Is desk** (`lib/appraisal/as-is-desk.js`), never an UPDATE here — which buys the
value bounds, the ARV-above-As-Is check, the **file freeze** (a term-sheet-sent /
clear-to-close / funded file is not rewritten by a vendor callback), the audit row
and the condition wording. A refusal is recorded and the order card offers an
**"Put these on the file"** button for a human to settle. A vendor callback never
quietly overrules a person. Off with `RV_AUTO_APPLY_VALUES=0`.

---

## 6. Status: they push, we poll, and both are idempotent

Their webhook posts one small event per change; the poller reads their status and
history endpoints every `RV_POLL_SEC` (default 300s). **Neither is allowed to be
the only road**, because ordering that works and then goes quiet is the worst
failure available here.

* Their status READ answers in Title Case ("On Hold"); the WEBHOOK answers in
  snake_case ("property_analysis"). Both normalize through one table; a status we
  have **never seen maps to null and leaves ours alone** rather than guessing.
* A status only moves **forward**, except a hold and a cancellation — their retries
  routinely redeliver older events, and without that rule one would drag a
  completed order back to "in process".
* The timeline dedupes on a hash of the event; the webhook inbox dedupes on the
  payload **with the day inside the hash** (a byte-identical event on a later day is
  legitimate); the report files itself by **content hash**; the values are written
  once behind `values_applied_at`.
* A failed delivery **backs off** and dies after 6 attempts, so one poison event
  cannot head-of-line-block the inbox.

On completion: the PDF is filed onto the appraisal condition (`doc_kind =
'hybrid_appraisal_pdf'`, slot label `Appraisal report (PDF)`, born **accepted**
because PILOT ordered it, **staff-only**) and the two figures go on the file.

> The PDF is deliberately **not** `doc_kind='appraisal_pdf'`: `undoAppraisalImport`
> deletes every `appraisal_pdf` on a file, so reusing that kind would mean undoing
> an unrelated appraisal import silently destroys a report we paid for.

---

## 7. Configuration

Credentials live in Render env only, never committed.

| Variable | What it is |
|---|---|
| `RV_ENABLED` | master switch — reading + polling (default off) |
| `RV_OUTBOUND_ENABLED` | ordering + writing (default off) |
| `RV_DRYRUN` | build the order and log it, send nothing |
| `RV_ENVIRONMENT` | `training` (default) or `production` |
| `RV_API_TOKEN` | their bearer token — **or** the login below |
| `RV_USERNAME` / `RV_PASSWORD` | a login PILOT exchanges for a token |
| `RV_COMPANY_TOKEN` | required **only** with a raw token (see below) |
| `RV_LOAN_OFFICER_TOKEN` | who the order is placed by at their end (optional) |
| `RV_PAYMENT_METHOD` | `ADD_TO_INVOICE` (default), `USE_EXISTING_SOURCE`, or `NONE` |
| `RV_AUTO_APPLY_VALUES` | `0` to stop PILOT writing the figures itself |
| `RV_DEFAULT_*` | what a new order starts as (§8) |
| `RV_WEBHOOK_URL` / `_USER` / `_PASSWORD` | what we give them to call us back on |

**A login is the easier credential**, and not for convenience: their sign-in reply
also names the **company token** (which of their companies we order for) and the
API user's own token. A raw bearer token cannot tell us either, so a token-only
deployment must also set `RV_COMPANY_TOKEN`. The API-Health page says exactly which
of the two states a deployment is in.

The webhook half is independent: ordering works without it and then only learns
where an order is up to from our own poll. The health page says so out loud, which
is the confusing failure it exists to pre-empt.

---

## 8. What a new order starts as (owner-directed 2026-08-14)

Every one of these is a **starting point the staffer can change on the screen**,
never a value forced onto an order.

| | Default | Why |
|---|---|---|
| Report | **Reno ARV** — As-Is + ARV | the product the owner picked |
| Inspection | **Interior (w Exterior)**, +$70 | best basis for an ARV on a rehab file |
| Turnaround | **Standard** (3–5 biz days, no fee) | rush (+$100) is selectable per order |
| GLA / floor plan | **ON** | owner's pick |
| Licensed inspector | off | surcharge, not needed by default |
| Their flood certificate | off | PILOT orders a flood determination on **every** file (db/374); buying theirs would double-order |

Live training price for the default combination: **$489.99** ($419.99 report + $70
inspection). The screen prices the **actual property** before anybody commits —
their pricing moves with the state and the ZIP.

---

## 9. Verified against their live training tenant

Driven through **these modules**, not by hand: sign-in → company + loan-officer
tokens resolved from the reply → catalogue (4 reports, 5 inspections, 2
turnarounds, with fees) → build → live price **$489.99** → **submit** → **settle**
(`ADD_TO_INVOICE`) → order token → status → history → the status mapping.

Two things worth knowing from that run:

* their status went to **On Hold** shortly after ordering — their own workflow for
  a renovation report whose scope-of-work document has not been attached. The
  identical order **with** the scope of work attached came back **"Ordered"**. That
  measurement is why the scope of work is now attached automatically (§11).
* `retrieve-response` and `pdf-file` answer **"not completed yet"** until the report
  is finished. That is an expected state and is not recorded as an error.

---

## 11. PAYING (owner-directed 2026-08-14)

> *"We don't want to allow Add to Invoice. We don't want to allow ACH. We want the
> system to automatically be able to put in the credit card details and process the
> payment from the credit card that was entered under conditions. If there is no
> credit card entered yet under conditions, you can pay it manually right over here,
> put in the credit card information in our system, or we can send payment links."*

Exactly three ways, in `src/richervalues/payment.js`. **Add to Invoice and ACH are
not offered anywhere** — not as a config value, not as a control, not as an accepted
request field.

| | What it does |
|---|---|
| `CARD_ON_FILE` | charges the card on the file's **appraisal-card condition**, revealed through the one audited chokepoint (`view_appraisal_card` is written) |
| `NEW_CARD` | a card typed at the moment of ordering: **saved onto the file first** through the shared `lib/appraisal-card.js` chokepoint — so paying also answers that condition — then charged |
| `PAYMENT_LINK` | Richer Value emails the borrower their own hosted payment page; the order exists and starts once they pay |

**The card is taken back off their account.** Their `add-card` is COMPANY-level, so
a borrower's card added there is chargeable for anybody's order. The charge runs
**add → pay → DELETE**, the delete in a `finally` so a failed *charge* cannot strand
one either, and a failed delete is logged loudly rather than swallowed.

**A card method with no card is not an error — it is the payment link.** Refusing
would throw away an intake that already exists at the vendor. `payIntake` never
throws for a payment problem; it records what happened in words on the row.

### The one thing that is not in our hands — measured, not guessed

Their `add-card` forwards the number straight to Stripe and **Stripe refuses it on
their account**: *"Sending credit card numbers directly to the Stripe API is
generally unsafe… To enable testing raw card data APIs, see …"*. A Stripe **token**
cannot be used instead, because their own validator rejects it first: `"card_number"
must be a number`. That is a setting on **their** Stripe account. The code is
written the documented way and will work the day they enable it; until then that
specific refusal is recognised, said in plain words with **tech@richervalues.com**
named, and the order falls through to the payment link, which works today.

---

## 12. THE $400,000 GUARD (owner-directed 2026-08-14)

> *"If any loan amount is more than $400,000, we don't recommend Richer Value, and
> our investors might not accept… If there is no loan amount registered yet, just let
> them know that it's better if they registered the loan amount before, because
> Richer Value sees what we expect."*

`src/richervalues/loan-guard.js` is **pure** and is the single definition, because
both halves of a double confirmation have to agree about what is being confirmed —
a threshold retyped in a React file is how a button comes to say one thing while the
server does another.

| Loan amount | What happens |
|---|---|
| ≤ $400,000 | orders normally, nothing said |
| **> $400,000** | strict warning naming **both** numbers and the real cost (an investor may refuse the report, so the file could need a full appraisal on top) + a **double confirmation** whose two prompts deliberately say different things |
| none registered | **advice, not a refusal** — register first, because they are *shown* what we expect — and the limit is stated |

Exactly $400,000 is **inside** the product: the owner said *"more than"*.

**The second confirmation is enforced on the server.** `placeOrder` refuses without
the acknowledgement token, so a screen that never renders the warning cannot order.
It is never a hard block — the owner's words are *"we don't recommend"*, a business
judgement — and who ordered anyway, knowing, is on the audit row.

---

## 13. THE SCOPE OF WORK — attached, and kept in step

> *"Auto-attach the scope of work."* … *"updated scopes of work can be sent for
> revisions… we should be able to update the scope of work in their system if the
> scope of work updates in our system."*

`src/richervalues/scope-of-work.js`. **Which document counts** is the same
definition the investor TPR package uses (`doc_kind='rehab_budget_export'`,
`is_current`), so PILOT can never send an investor one scope of work and an
appraiser another. PDF preferred (an appraiser opens it on a phone at a property),
then the spreadsheet; the HTML snapshot never goes. With no tool export, a document
a human filed on the scope-of-work condition is used — a contractor's own bid is
still a scope of work, and sending it beats an order going On Hold.

**A scope of work we cannot read never refuses the order.** The order goes and the
row says the appraiser is waiting on the document.

The **revision** reads what the order is DOING, never a clock:

| Their order is | We |
|---|---|
| not started (intake / ordered / on hold / assigned / scheduled) | **update** the order's budget + re-send the file |
| being worked on (inspected / in review) | **upload** the new file with a note |
| finished (completed / delivered) | **reopen** with their `new-budget` reason — an ARV priced against a scope nobody is building any more is worse than no report |
| cancelled / rejected / test | nothing |
| a status we have never seen | **upload** — it can never undo work, and silence would not be safe |

Nothing here ever **re-orders**: a reopen is their own revision of an order already
paid for.

---

## 14. WHO IS ON THE ORDER

They are not interchangeable, and mixing them up is how a lender's own valuation
reaches a borrower:

* **Report contact** — the loan officer, falling back to the processor. The finished
  report carries **our** valuation, so this is never the borrower.
* **Report Cc** — whichever of those two is not already the contact, so both people
  who chase an appraisal see it land.
* **Access contacts** — the borrower **and their cell phone**. A homeowner-led
  inspection runs through a link Richer Value **texts**, so an access contact with no
  mobile is an order that cannot start. This is the only place the borrower belongs.

Every one of these is pre-filled and every one is changeable on the screen.

### The communication surface, stated plainly

Their API has **no message thread**. What exists is mapped onto what they do have:
notes on **reopen** (a revision), **place-hold** / **release-hold**, a **cancel**
reason, and **upload-documents** with a comment. There is no way to send Richer
Value a free-form message and no way to read one back, and pretending otherwise
would be worse than saying so.

---

## 10. What was deliberately NOT built

* **Batch / portfolio ordering.** The client supports their batch endpoints; the
  desk refuses them, because a PILOT order belongs to a loan file and a loan file
  is one property. A portfolio surface is separate, deliberate work.
* **Their AVM / EPO product** (`/api/v2`, `aivm` / `rental-aivm` / `epo`) and their
  **standalone inspection** and **Oversight appraisal-review** products. Owner-
  directed: *"we're going to build up now only evaluation."* The report reader
  already tolerates an AVM-shaped response so one arriving is never silently empty.
* **Anything that picks between the three vendors.** Still a human's choice, and
  the default stays NAN.
