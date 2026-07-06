# ClickUp Field Map — site/portal ⇄ ClickUp

Live-pulled field & option IDs. Encoded in `src/clickup/fields.js` and
`src/clickup/mapping.js`. This is the authoritative crosswalk.

## The key finding: shared PII field IDs
These field IDs are **identical** in the CRM list and the Pipeline list, so
borrower PII written once satisfies both the contact card and the loan file:

| Field | Shared ID | Type |
|---|---|---|
| Borrower Name | 474a54a3-a430-4e1f-a3ca-b94d375bece8 | short_text |
| Borrower Email | 743c16d3-68f8-4ea2-bda2-e22bf30bbe3b | email |
| Borrower SSN | 51e0826e-0293-4d13-ba73-04e4547de520 | short_text (PII) |
| Borrower DOB | d4e72161-3688-4653-9d35-bd73e04066f7 | date |
| Borrower FICO | a67357ca-69f0-497b-afd4-39581af60a30 | number |
| Borrower Address | 0b469d1b-a9b0-41de-aac3-b1c3c954d9b4 | location |
| Loan Officer | 14839ebf-b214-4841-af35-ca10703397f3 | users |
| Loan Officer Email | 9f6cc87f-b93d-4dce-a13e-66de8f47616a | email |

## The bidirectional relation (one contact ⇄ many files)
- CRM contact → files: **Pipeline Link** `4952e019-c90f-4003-904b-3ae471263ab7`
- Pipeline file → contact: **CRM Link** `612eed39-0f26-4378-8eda-6346ef9866e8`

## Product dropdowns (option IDs resolved in mapping.js)
- **Program** `50eb857a-…` → Fix & Flip w/ Construction `31e3b89d-…`, Bridge `e8ff7301-…`, DSCR `be62fcc8-…`, Private HM `3222c2ec-…`
- **Loan type** `ee1b564f-…` → Purchase `5eabaafc-…`, Refi R&T `64a66c30-…`, Refi Cash-Out `7b12269e-…`, Ground up `8a1137a5-…`
- **Property type** `541524d9-…` → SFR / Multi 2-4 / Multi 5+ / Mixed Use / New Construction
- **Occupancy** `df9d81b5-…` → Primary / Investment / Secondary
- **Vesting** `173dc79a-…` → Individual / LLC-Corp / Trust

## Checklist status dropdowns (portal item → ClickUp option)
Normalized statuses: `outstanding | requested | received | satisfied | issue`.
Mapped fields: Title, Insurance, Contract, Assignment, Rehab budget, REO,
Assets documentation, Signed term sheet (all IDs in `fields.js#CHECKLIST`).

## Economics = pass-through snapshots
Loan Amount, LTV, DSCR, ARV, rehab, purchase price are written as snapshots.
**The pricing/eligibility math stays in the frozen client-side engine** — the
portal never recomputes it.

## Open mapping items (need the merged site to finalize 1:1)
- Confirm the site's `collectState()` keys line up with `intake` normalize()
  in `routes/intake.js` (co-borrower block, address sub-fields, PPP term).
- Full `Lender` option list (40+ options) is in the live pull; add on demand.
