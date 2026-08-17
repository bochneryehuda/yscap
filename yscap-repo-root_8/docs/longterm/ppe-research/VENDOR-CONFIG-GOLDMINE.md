# The vendor config document — what it is, whether to trust it, and what (not) to do with it

Research round, 2026-08-16. **Read-only. NOTHING in this round changed how we price.** Four
background agents mined the document in parallel and a fifth pass validated it against real captured
requests; this is the consolidated result and the decisions taken.

The owner's framing was the right test: *if it's wildly off from what works, stay away; if it agrees
with what we have AND lights up on the fields we've struggled with, it's gold.* The answer is
measured below.

## What the document is

`GET /rest/v1/lp-ppe-integration/company/config/{companyId}` (Accept `application/json-no-enum`),
1.45 MB. It is our TENANT'S PRICING-FORM DEFINITION — a field dictionary plus company policy flags
and the vendor's own form JavaScript. It is **not** an API schema and **not** a lender/fee catalog.

Five large sections; all five are the same object shape. `quickPricer` carries the field model;
`pricingConfig` / `pricerConfigs` / `quickPricerConfig` / `publicPricings` are sibling form configs
(three of them share a byte-identical parsed body). Each field node under
`…customConfig` (a stringified JSON blob you must `JSON.parse`) carries: `path`, `type`, `label`,
`values[].code`/`.label`, a `definition.values` server-enum list, `required`, `hasBlank`,
`minValue`, `maxValue`, and the form's `initScript` / `changeScript` / `hideScript` logic.

## Is it trustworthy? Measured yes — it is the same source we reverse-engineered from

- **Enum values agree perfectly.** 41/41 distinct (path, value) pairs in the 7 real captured
  requests are published by the document; 49/49 of the values *we* send are published. **Zero
  contradicted values** across 37 enum-bearing paths.
- **It matches our hand-built token tables character-for-character** — 25/25 income-doc types,
  20/20 property types, 8/8 bankruptcy seasonings, 7/7 citizenships — **including the vendor's own
  typos** (`ForeignNationalwithITIN)` with a stray paren, `< 3 years` lowercase among Title-Case
  siblings, `Reserve_6` singular beside `Reserves_12`). Two independent derivations do not coincide
  on typos; this is the same source, confirmed.
- **Its `initScript` defaults match our `BASE` and the captures on 30/30 invariant fields** —
  interest-only off, escrow off, `mortgageTypes:['Conventional']`, credit counters `'0'`, DSCR
  defaulting to 1.5, address sub-fields `''` not null.

So the document does **not** give "totally different information." It corroborates our system.

## Where it "shines" — exactly on the fields we had trouble with

- **The `"4+"` mortgage-late bug (fixed this session):** the document publishes
  `MORT30LATESLAST12M` as `{code:"4", label:"4+"}` with `pathToId:"it.code"`. **66% of its published
  option pairs have code ≠ label** — it is the direct antidote to the whole "we sent the label, they
  wanted the code" class.
- **Off vs unanswered:** checkbox fields publish a real tri-state `[null, true, false]`, so
  `false` (off) is a different thing from `null` (unanswered).
- **A live trap it uniquely reveals:** `criteria.escrowWaiver` carries `checkBoxValueReverse:true`
  and is labelled "Impounds?" — the checkbox is the logical INVERSE of the transmitted value. Our
  code already handles escrow correctly; worth knowing before anyone touches it.

## Where it is silent — do NOT read these as answers

- **`required` is `false` on all 253 nodes.** The document CANNOT tell us which fields are
  mandatory. It does not predict any of our three known HTTP-500 causes (null `mortgageTypes`,
  missing FICO, null county) — it only corroborates the right *values* for them. Our hard-won
  knowledge of what makes pricing 500 is not overturned by this file.
- **`minValue`/`maxValue` are null on 71 of 72 nodes**, and `hasBlank:false` is a dropdown-rendering
  flag, not an "API rejects blank" rule (proved by captures that send `''`/`null` on `hasBlank:false`
  paths and price fine).
- **`@class` is a UI-widget name** (`FieldPricingItem`, `DynamicFieldPricingItem`, …), 1,199
  occurrences, 10 values — NONE of them the Jackson request type discriminators
  (`com.cre8techlabs.entity.range.*`) our request needs. Those come from recorded traffic; the
  document has zero of them.
- **No lender list, no fee table, no product catalog.** `sponsoredLenders`/`topLenders` are `[]`;
  closing costs are external (`closingCostSource:"DLPro"`).

## `values[]` vs `definition.values` — one refinement to make later

`definition.values` is the SERVER'S permitted superset; `values[]` is the tenant's UI-exposed
subset (e.g. `MortgageType` 10→7, `PropertyType` 20→9). Our committed
`vendor-token-registry.json` snapshot and the offline guard currently use `values[].code` (the
display subset). That is the safe direction — we never emit outside it today — but if we ever need
a value the tenant's form hides, the guard would flag a legitimate token. **When the guard is next
touched, base it on `definition.values`.** Not urgent; recorded so it isn't forgotten.

## The one code-candidate it surfaced — TESTED LIVE, not a bug that hurts us

`field-registry.js` sends `GLOBAL_MixedUse` (line ~262) and `GLOBAL_NoMortgageHistory` (~317) as
JSON booleans, while every other dynamic flag — ours and all 16 in the captures — sends a STRING.
Cross-checked against the captured working requests (ground truth), not just the document.

**Tested live before any change**, same scenario three ways, alternated and repeated:

| `GLOBAL_MixedUse` | HTTP | options | programs |
|---|---|---|---|
| absent (normal loan) | 200 | 394 | 11 |
| boolean `true` | 200 | 0 | 0 |
| string `"true"` | 200 | 0 | 0 |

The boolean and the string **price identically** — both accepted, both correctly make a mixed-use
property ineligible (0 is the right answer; mixed-use doesn't qualify for these DSCR programs). So
the inconsistency does **not** mess up pricing. It is a cosmetic mismatch with the frontend's
string convention. **Deliberately NOT changed** — there is no functional difference, and working
pricing code should not be edited for a zero-impact tidy-up without a specific reason. Left as a
recorded, frontend-parity nicety for a future decision.

## Also found while probing (read-only)

- **`/v2/api-docs` on `api.digitallending.com` is a real OpenAPI doc — but a DIFFERENT service.**
  It defines `Search`/`BorrowerCriteria`/`Property` and looks like ours, but matches a real capture
  only 17% at top level and is missing the entire non-QM/DSCR surface (no `dynamicPropertiesMap`,
  no `rateGridIds`). It is the loan-origination product's API, not the PPE pricer's. Its enum lists
  DO agree with the config document and the captures where they overlap, so it is corroboration —
  but **it must not be used as the source for what we send.**
- **The real pricing host** (`lenderpriceApiUrl = https://ppe-rapi-dlpro.lenderprice.com/`) publishes
  no OpenAPI contract. It exposes a Spring Boot actuator that answers to our tenant token, but only
  `health` and `info` are enabled — nothing sensitive. **Vendor/security note to pass on:** their
  pricing host's actuator accepts our tenant's access token; worth a line to the developer.

## Bottom line

The document is gold as a **reference for enum spellings and form defaults** — it independently
confirmed our tables and lit up on the exact bug we'd just fixed. It is **not** a source for
required-ness, bounds, or request type discriminators, and it is **not** a reason to change anything
that prices correctly today. Full agent reports (field dictionary, form scripts, section map,
validation) are archived outside the repo; this page is the durable summary and the decisions.
