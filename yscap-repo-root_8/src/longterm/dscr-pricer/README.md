# DSCR Quick Pricer (Long-Term)

A borrower-facing pricing tool for **long-term DSCR investment loans**, priced through
**Lender Price** (Digital Lending PPE) and shown as three simple, white-labeled options.

> **Product scope — LT only.** This is Long-Term work and lives only in the Long-Term
> namespace. It imports nothing from RTL and shares no tables, routes, or code with it.
> Per the current LT posture it is **visibility-only, not live** — built borrower-*ready*,
> but not yet serving real borrowers. See root `AGENTS.md`.

Everything here is currently **standalone prototype + design reference**, decoded from 31
real Lender Price searches. Nothing is wired to the live API yet — the pricing shown is
illustrative until the backend + result-display rules are built.

## What's here

| File | What it is |
|------|------------|
| `quick-pricer.html` | The borrower-facing Quick Pricer — officer-branded form, the 3-option (0/1/2-point) output, RateSaver-style buy-down comparison, and generated term sheet / pre-approval / proof-of-funds / comparison, each stamped with a Term Sheet ID. Self-contained (brand fonts embedded). |
| `pricing-desk.html` | The **staff console** — open a Term Sheet ID (or run a search yourself) to see the *real* Lender Price results: every lender, program, full rate stack, and adjustments. Populated with a real captured search as demo data. |
| `docs/architecture-blueprint.html` | The system plan: backend agent, session isolation, security. |
| `docs/backend-and-search-audit.html` | The storage design (30-day raw + permanent recipe + historical re-pricing) and the field-by-field search audit. |
| `docs/recording-guide.html` | How to capture a Lender Price session for decoding new fields. |

Open any `.html` directly in a browser.

## How the pricing works

1. **Login** — OAuth2 password grant to `auth.digitallending.com/oauth/token`
   (`grant_type=password`, `client_id=acme2`) → 1-hour bearer token + `companyId` + `userId`.
   One shared YSCAP service account, managed by a token manager (never per-user login), so
   concurrent users never bump each other.
2. **Enrich** — zip → county FIPS / AMI / conforming class via the `lp-ppe-integration`
   lookup endpoints.
3. **Price** — `POST /rest/v1/lp-ppe-integration/pricing/searchRaw/{companyId}/{userId}`
   with the built criteria → the full investor rate stack (~7 MB tree).
4. **Parse** — flatten the tree to per-lender/program rate ladders.
5. **Three options** — for the chosen program, interpolate the rate at wholesale price
   **102 / 101 / 100** so we net ~2.0 on each: 0 points (rebate 2.0), 1 point, 2 points.
   Lender Price supports the `date` field for as-of historical re-pricing.

## Field mapping (borrower input → Lender Price), confirmed against recordings

**Ask the borrower:** loan purpose (Purchase / Rate&Term→`Refinance` / Cash-out→`CashoutRefinance`),
property value (fills `purchasePrice` + `appraisedValue`), LTV ⇄ loan amount, FICO band
(sent as the low-end number), DSCR ratio (number is authoritative), property type
(`SingleFamily` / `UnitDwelling_2_4` / `Condos` + `nonWarrantableProject`), units, zip
(→ state/county), prepay term (`60/48/36/24/12 Months` → `5/4/3/2/1 Yr PPP`; none → `null` +
`No PPP`), borrower type (`LLC` / `Corporation` / `Individual`), and the checkboxes below.

**Checkboxes → `criteria.*` booleans:** `interestOnly`, `escrowWaiver` (the "Impound" box
is checked by default = escrow on; unchecking waives it → `true`), `firstTimeHomeBuyer`,
`nonWarrantableProject`.

**Always defaulted / hidden:** `propertyUse=Investment`, `AddlOccupancyType=Long_Term_Rental_Property`,
`loanType=Fixed`, `loanYear=30`, `mortgageTypes=[Conventional]`, `GLOBAL_RESERVES=Reserves_24`,
`ownProperties=1`, `IncomeDocType=DSCR`, `compensationType=BorrowerCompPlan`, `attachmentType=Detached`,
lock 30, AUS all. Term-sheet fees: $1,595 application + $600 commitment on all programs.

## Storage (planned)

Two records per search, in the **database (not RAM)**:

- **Quote (recipe)** — kept forever, small: inputs, defaults, the exact LP request, the
  original date, and the options shown. Keyed by Term Sheet ID.
- **RawResult (blob)** — the full LP response, gzipped, **30-day TTL**, purged nightly.

Within 30 days a staff lookup serves the exact stored raw. After purge, the recipe re-runs
Lender Price with the original date stamped in (`date` field) for a close as-of
reconstruction.

## Still to build

The entire search side is decoded and verified. Remaining work is the **result-display
rules** (which lenders/programs to show, white-labeling, what to reveal vs. hide, and
alternative-option / eligibility warnings) and the live backend wiring — to be defined
before this leaves visibility-only.
