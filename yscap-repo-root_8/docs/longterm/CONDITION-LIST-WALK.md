# Walking the owner's condition list, item by item

The owner's directive (`SHARE-THE-CODE-DIRECTIVE.md`) carries two numbered
lists: the **sharing set** (what one implementation must serve both products)
and the **standing clarifications** (specific rules recovered from the whole
conversation). This file walks both and records, for each, *what was checked
and what the evidence is* — not "done", which is an opinion, but where the
proof lives.

The rule this file exists to enforce on itself: **an item is only ticked when
something would FAIL if it stopped being true.** Where the only evidence is a
reading of the code, it says so.

---

## The standing clarifications

| # | The owner's rule | Where it is enforced | Evidence |
|---|---|---|---|
| 1 | NAN appraisal ordering is OFF the list | nothing built | no `nan` order kind in `src/longterm/orders/kinds.js` |
| 2 | REO/mortgages: one of three ways per line | `src/lib/conditions/answers.js` `lt_reo_liabilities` — `statement` / `primary` / `address` | `test-lt-condition-field-types-pure.js` derives the ways' field types from this plan |
| 3 | Vesting entity: RTL logic, pre-filled, + optional good standing | `entity-prefill.js` → `src/lib/llc.js`; slot `good_standing` is `required: false` | `test-lt-vesting-entity-profile-db.js`; the expiry rule is `llc.js`'s own, not a copy |
| 4 | Subject-property mortgage is a FORM, not upload-first | `answers.js` `mode: 'choice'` — `statement` / `typed` (all three fields) / `fci_serviced` | the three fields are required together, in the plan itself |
| 5 | Cash-out letter is prior to CLEAR TO CLOSE | `library.js` `lt_cash_out_letter`, `bucket: B.CTC`, in the `PRIOR_TO_CTC` array | the bucket is the array it lives in — it cannot drift from its own list |
| 6 | VOR on the owner's exact blank PDF | `src/longterm/vor/**` + `assets/blank-vor.pdf` | task #17's suites |
| 7 | FR0115 rents-vs-owns; the condo field | FR0115 → `field-registry.js` residency basis, `vor/data.js`, `clickup/mapper.js`; condo → `is_condo` derived from `gse_property_type` | **measured**: see below |
| 8 | The pasted Render API key is compromised | never used, never stored, never written to a tracked file | still awaiting the owner's rotation |

### On item 7, and why PILOT does *not* read the field the owner named

The owner named `cx.propertytype` / `urla.x205` for the condo question. PILOT
reads Encompass field **1041** (`loanProductData.gsePropertyType`) instead, and
that is deliberate rather than an oversight:

`src/longterm/encompass/loan-anatomy.js` records the MEASURED fill on this
tenant's own long-term book — 1041 is filled on **100%** of DSCR loans and is
enumerated (`Detached, Attached, Condominium, PUD, …`), while the sparser
`1553` sits at **54.3%** and is annotated *"Do not treat as authoritative."*
`CX.PROPERTYTYPE` is recorded in `reconciliation-map.js` as the tenant's own
cross-check (`altFieldId`) and is used as a preferred override on the ClickUp
push, where the tenant's wording is what matters.

So the owner named the field they see on their screen, and the field that is
actually reliable carries the same answer on every loan. `is_condo` is DERIVED
from it and answers **null** — never `false` — when the type has not been read,
so a file nobody has read is never treated as "not a condo".

---

## The sharing set

| # | The owner's rule | Status |
|---|---|---|
| 1 | The Condition Center — UI, documents, slots, sign-off | shared |
| 2 | The Orders centre — box, drafts, reply routing, follow-ups | shared |
| 3 | FileContacts + the vendor directory | shared (`service_contacts`) |
| 4 | The entity/LLC logic | shared (`src/lib/llc.js`) |
| 5 | SharePoint syncing | shared |
| 6 | The Cloudflare / off-site backup | shared |
| 7 | Profile-linked conditions — photo ID, the card, REO | photo ID + card shared and bidirectional; **the REO write-back is NOT built** — see below |
| 8 | The address lookup inside LT conditions | **fixed 2026-08-31** — see below |

### Item 8 was built and wired to the wrong screen

`AddressField.jsx` (the look-up, calling the product-neutral `/api/address/*`
proxy) existed and was wired to the term sheet only. The one condition that
asks for an address — the REO/mortgages line, *"say which property this
mortgage is secured by"* — rendered a plain text box, because the long-term
field renderer branched on `choice` and let everything else fall through to an
`<input>`. The server had described the field as `type: 'address'` all along.

Nothing errored; the screen simply looked finished. `test-lt-condition-field-types-pure.js`
now derives every declared field type from the shared plans and fails the build
if one has no branch, so the class cannot recur.

### Item 7's REO write-back is deliberately NOT built

A long-term REO answer records what the borrower said about a mortgage on the
loan. Whether it should also become a line on the borrower's PERMANENT record
(`track_records`) is a **business rule nobody has stated**, and the two readings
lead to different data:

* a mortgage the borrower merely *names* is not evidence they own the property;
* a `track_records` line is what the short-term side prices experience from.

Writing one from the other could silently move a borrower's experience tier on
the short-term product. That is squarely the "NEVER GUESS A BUSINESS RULE"
rule, so it is recorded here and asked rather than inferred.

---

## Open questions for the owner

1. **Should a photo ID uploaded on a long-term loan reopen the gov-ID condition
   on that borrower's short-term files?** The ID is on the shared profile, so
   the read direction already works; the write direction is a workflow choice.
2. **What does a long-term REO answer become on a person's permanent record?**
   (above)
3. **The Render API key pasted in chat must be rotated** before it is used
   anywhere.
