# What DocLab needs for a partnership and a trust

*Research, 2026-08-09. Owner's question: "do research what else DocLab needs for partnership and
trust — let's set up that tables as well."*

## The short answer

**DocLab needs nothing new.** Their published dictionary is 103 variables
(`reference/data-dictionary-full.csv`, `reference/json-key-matrix.csv`, and the integration
document). There is **no partnership-specific field and no trust-specific field in any of them.**
Every borrowing entity, whatever kind it is, goes out through the same handful:

| DocLab variable | RTL templates that use it | Where ours comes from |
|---|---|---|
| `type_of_organization` | 14 of 14 | `llcs.entity_type` (+ `entity_subtype`) |
| `acknowledgement_corporate_status` | 13 | derived from the type |
| `bylaws_operating_agreement` | 8 | derived from the type |
| `operating_agreement_or_bylaws` | — (pseudo-key, same value) | derived from the type |
| `membership_interest_percentage` | 12 | each owner's `ownership_pct` |
| `number_of_shares` + `certificate_number` | 13 each | each owner's `shares` / `certificate_number` |
| `signatory_title` | 14 | each owner's `member_title` |

A partnership and a trust travel the **percentage** road, exactly as an LLC does. Only a corporation
takes the shares road. That was already wired by `db/506` and `src/lib/entity-type.js`.

So this document is mostly about the thing the research actually turned up, which is on **our** side.

## The real finding: a family trust could never be verified

`llc.missingForVerification` is a **hard gate**. A verified entity is what satisfies the
vesting-entity condition, and that condition gates clear to close. Until now it demanded three things
from every entity without exception:

- an **EIN**
- a **formation state**
- a **formation date**

But:

- a **revocable living trust has no EIN of its own.** While the grantor is alive it uses the
  grantor's own Social Security number. It is also not filed with any state — it is created by a
  signed declaration.
- a **general partnership is filed with no state either.** It exists because the partners signed an
  agreement. (It *does* have an EIN — it files a partnership return, Form 1065.)

So an ordinary family trust would have been asked for two documents that do not exist, could never be
marked verified, its condition could never clear, and the file could never reach clear to close —
**and nobody could have resolved it**, because the missing documents are not obtainable. That is a
dead end, not an inconvenience, and it is what `entity_subtype` fixes.

## What we added, and why each piece earns its place

### `llcs.entity_subtype` (db/508)

One column, `NULL` everywhere on the back book. Only a partnership or a trust can carry a value at
all — the CHECK is written per type, so `revocable` cannot be stored on a partnership and `general`
cannot be stored on an LLC. That matters: a sub-kind on the wrong type would silently relax the
wrong requirement.

| Type | Sub-kind | EIN | State filing |
|---|---|---|---|
| LLC | — | required | required |
| Corporation | — | required | required |
| Partnership | General | required | **not required** |
| Partnership | Limited (LP) | required | required |
| Partnership | LLP | required | required |
| Trust | Revocable | **not required** | **not required** |
| Trust | Irrevocable | required | **not required** |
| Partnership / Trust | *not yet stated* | **not required** | **not required** |

"Not required" never means unwanted: a value that IS present is still stored, still validated and
still sent. It means we may not refuse to finish the entity for the want of it.

**An unstated sub-kind relaxes rather than blocks**, and that is a deliberate asymmetry. Demand an
EIN a revocable trust does not have and the file dead-ends with nobody able to fix it. Fail to demand
a limited partnership's state certificate and a reviewer simply asks for it — the requirement is
togglable on the condition itself. The screens ask the sub-kind question instead, and the closing
desk nudges when it is still blank.

The **date is never relaxed.** A trust is legally identified by its name *and* its date — "The Smith
Family Trust, dated March 3, 2019" — so the date completes its legal name. The box is labelled
"Trust date" on a trust and "Partnership agreement date" on a partnership, because "formation date"
asks the wrong question.

### The document slots follow the sub-kind

The two slots that can be unfillable stop gating verification when the document genuinely does not
exist (`rtl_llc_formation` when there is no state filing, `rtl_llc_ein` when there is no EIN), and
the state-filing slot re-words itself:

- **General partnership** → "State registration (if the partnership has one)", with a hint saying a
  general partnership is created by its agreement and is usually filed nowhere.
- **Limited partnership** → "Certificate of Limited Partnership (formation state)".
- **LLP** → "LLP registration (formation state)".
- **Trust** → "Trust formation documents", and the governing-document hint says a
  **certification (abstract) of trust** naming the trustees and their powers is usually enough — most
  trustees will not hand over the whole instrument, and most lenders do not need it.

Both passes run **in both directions**, so correcting a partnership from general to limited restores
the wording *and* the requirement. Neither ever overrides a slot somebody has already worked.

### `type_of_organization` is refined for a partnership, and deliberately not for a trust

DocLab prints this word **verbatim onto a recorded instrument**. A general partnership and a limited
partnership are different legal entities with different liability, so the sub-kind refines it:
`general partnership` / `limited partnership` / `limited liability partnership`.

A trust's sub-kind deliberately does **not** refine it. "Trust" is never wrong, "revocable trust"
would be wrong if the sub-kind were mis-set, and the trust's own name carries the rest. A closer can
still override it per file.

## Two traps worth writing down

**1. `trustee` is not the trust's trustee.** This is a fourth false friend alongside `lender`,
`underwriter` and `state_abbrev`. DocLab's own description:

> Trustee of the Deed of Trust (most often the title company at closing, but some will need you to
> identify your own. PLL can help with this as needed)

It is used by three RTL templates, all **deed-of-trust** ones. Wiring a borrowing trust's trustee
into it would name the borrower's own family member as the party holding legal title to the property
for the lender. The trust's trustees reach the documents the ordinary way — as signatories with the
title "Trustee".

**2. `acknowledgement_corporate_status` has no published wording for a partnership or a trust — and
three different ones for an LLC.** DocLab documents it three ways:

- the dictionary: `operating agreement and its members`
- the integration document: *Enter "Bylaws and Board of Directors" or "Operating Agreement and
  Members"*
- their own master payload sends: `"operating agreement and members "` (with a trailing space)

and covers only LLC and Corporation. Ours for the other two — `partnership agreement and its
partners`, `trust agreement and its trustees` — is an **analogy, not their text**, and it merges into
a sentence on a recorded instrument.

**→ Confirm all four wordings with Private Lender Law before going live.** It is overridable per file
(`acknowledgementCorporateStatus`), so a closer is never stuck waiting for that answer.

## One more thing DocLab publishes that nobody can use yet

`company_filing_status` (version 3.1.4) is in the dictionary with an **empty description** and is in
**no template's variable list**, RTL or DSCR. It is the newest key they have shipped. Nothing is sent
for it, and nothing should be until PLL says what it is — worth asking in the same conversation as
the wording above.

## What is still open

| | |
|---|---|
| The four `acknowledgement_corporate_status` wordings | Ask PLL. Overridable meanwhile. |
| `company_filing_status` | Ask PLL what it is. Unused by every template. |
| Signing **authority** (which owner may sign alone) | Not recorded anywhere. The title is the nearest thing we have. Trust and partnership documents state it; nobody reads it into a field yet. |
| Beneficiaries of a trust | Not a DocLab field and not a lending fact for us — the trustees sign, the trust owns. Recorded only in the trust agreement we collect. |
