# The AHL "Quick Pricer" — a credential-free pricing endpoint, measured

**Date:** 2026-08-30 · **Source:** a browser HAR of `client.ahlend.com/quickpricer/index.php`
(33 entries, one pricing round-trip) · **Status:** research only. Nothing is built, nothing is wired.

> **Product side is NOT decided.** This pricer serves *both* sides — `Investor - DSCR` /
> `Investor Bridge - Rehab - Ground Up` sit in the same dropdown. Per root `AGENTS.md` rule 1 this
> document does not assume RTL or LT and does not create anything in either namespace. **Ask the
> owner which product this is for before any code is written.**

Everything below was **measured live**, not inferred from the HAR. Reproduction commands are inline;
every number in this file came out of an actual request made while writing it.

---

## 1. The whole surface is one endpoint

The capture contains 33 requests. Thirty-one are CSS, JS, fonts and a logo. The application surface
is **two** calls:

| # | Call | Purpose |
|---|------|---------|
| 1 | `POST /quickpricer/index.php` (form-urlencoded → `text/html`) | The pricing engine. Everything. |
| 2 | `POST /ajax/getcitystatecountyfromzip.json` (`zip=06105` → JSON) | zip → city / state / county / AMI / **`licensed`** |

The zip helper answers `{"city":"Hartford","state":"CT","county":"Hartford","zip":"06105","ami_limit":null,"licensed":"yes"}`
— note it hands back the **state licensing answer** for free.

The page's JavaScript references exactly two other endpoints, `/tpo/ratesheets.php` and
`/tpo/ajax/getthirdpartyfees.php`. Both are behind the login:

```
$ curl -so /dev/null -w '%{http_code} %{redirect_url}\n' https://client.ahlend.com/tpo/ratesheets.php
302 https://client.ahlend.com/login/login.php
```

So the public boundary is clean and narrow: **the quick pricer, and nothing else.**

## 2. There is no authentication. Measured, not assumed.

The captured request carries **zero cookies**. The response sets **zero cookies**. There is no bearer
token, no CSRF token, no API key, no `Referer` requirement, no session of any kind. Replayed from
this container with nothing but a User-Agent:

```
$ curl -s -X POST https://client.ahlend.com/quickpricer/index.php \
    -H 'Content-Type: application/x-www-form-urlencoded' --data @body.txt
```

→ HTTP 200, and the price ladder came back **byte-identical to the browser's**:

| Rate | Price | P&I | Rebate |
|---|---|---|---|
| 6.750 | 98.375 | 1968 | $5,688 |
| 6.875 | 99.000 | 2005 | $3,500 |
| 7.000 | 99.500 | 2041 | $1,750 |
| 7.125 | 100.000 | 2078 | $0 |

It is live, not cached: changing **one** field, `FICO=760` → `FICO=680`, moved the whole ladder
+0.500 (6.750 → 7.250). Changing `LoanPurpose=Refinance` → `Purchase` moved it −0.125.

The hidden `search_id` (809791 in the capture, 809792 in the response) is a server-side counter. It is
**not required and not validated** — the replays above omitted it entirely.

## 3. The input contract: 149 fields posted, 17 that matter

The browser posts **149 form fields**; 76 of them are empty strings. Posting only the 73 non-empty
fields returns the identical ladder. A greedy single-pass minimisation — drop one field, keep it
dropped if the ladder is unchanged, 73 live requests — reduced it to **17**:

```
Action=Get Pricing     LoanPurpose=Refinance    DocType=Investor - DSCR   FICO=760
ConsumerPurpose=Business  RefiPurpose=CashOut   LoanTerm=40               DSCR=1.3
InterestOnly=Yes       Channel=CorrNonDel       PropertyValue=500000      LoanAmount=350000
PropState=CT           PropertyType=Condo       Units=4                   Occupancy=Investment
LockTerm=30
```

Seventeen fields, replayed cold, reproduce the browser's ladder exactly. Note what fell away:
`LTV`, `CLTV` and `GrossLoanAmount` are **derived server-side** from `PropertyValue` + `LoanAmount`;
`PropZip`/`PropCity` are cosmetic once `PropState` is present; the entire compensation block
(`compPercent`/`compMin`/`compMax`/`compBase`), the `bp_*`/`lp_*` fee ledger and ~30 `No` flags are
all defaulted.

This is a greedy minimisation, so the set is minimal **for this scenario**, not proven globally
minimal — a purchase or a bridge scenario will need its own pass. (Verified: the same 17 with
`LoanPurpose=Purchase` and `RefiPurpose` removed prices correctly.)

**The input domain is self-documenting.** A plain `GET` of the page (no POST, no session) returns the
complete form: 23 `<select>`s with every option value spelled out — `DocType` (17 income-verification
types), `Channel` (`Wholesale` / `Correspondent` / `CorrNonDel`), `PropertyType`, `Occupancy`,
`CitizenshipType`, `LockTerm`, all 50 states. The cascading rules (which `LoanTerm` values a given
`DocType` allows, when `DSCR` becomes required, when `Units` 5–6 unlock) are visible as CSS classes
on the options — `loanTerm3040yr`, `loanTerm1218mo`, `loanTerm12mo`, `forNonQM`, `forDSCR` — plus
about 400 lines of readable jQuery. Nothing needs to be guessed.

## 4. The output is HTML, and it is *richer* than a typical JSON quote

`text/html`, ~150 KB, ~26 KB gzipped. That sounds like the bad part. It is not, because of what is in it.

Each eligible rate row carries a `selectPrice(...)` call with thirteen positional arguments — the
lender's own internal payload, handed over in the clear:

```js
selectPrice(this,'6.750','98.375','98.375','59994848',
            'AHL CORR - NON-DEL Invest Star - Fixed 40 Yr I/O','DSCR40FG75IO',
            '6.750','101.750','1968','0','5688','30','Fixed')
//          rate    buy price  sell price  P&I   —   rebate$ lock  amort
```

Program id, **program code** (`DSCR40FG75IO`), buy price *and* sell price, P&I, rebate in dollars,
lock term, amortisation. And alongside it, per program:

- **the full adjustment stack, as rule text with its price hit** —
  `LTV is <=70, And Prepayment Term is None … −1.875`,
  `… Interest Only is Yes … −0.500`, `… Property Type is Condo … −0.500`,
  `… Number of Units is 2-4 Units … −0.625`, `… Representative Credit Score is >= 760, And Loan Purpose is Cash Out Refi … −0.250`;
- **for every ineligible program, the exact rules that failed** —
  `AHL CORR - NON-DEL All Star`: *Income Verification Type is Investor - DSCR* ✗,
  *Placeholder_Consumer Purpose is Business* ✗.

In this one response: 4 programs, 4 rate rows, 12 adjustment rows and 6 ineligibility reasons. A
**~40-line** regex parser turns the whole page into clean JSON — written and run against the capture
while producing this document; output verified against the browser's rendering.

Most vendor JSON APIs do not give you the adjustment stack or the *reasons* a program was declined.
This one does, because it was built to render a tooltip.

### The one real parsing trap

Their HTML escaping is inconsistent. The **ineligible** tooltips escape correctly (`&lt;= $1.0M`),
but the **eligible** adjustment table emits raw comparison operators:

```html
<td>Placeholder_FinancedDiscountPoints is No, And Max of LTV/CLTV/HCLTV is <=70, And DSCR is >= 1.25</td>
```

A strict DOM parser reads `<=70, And DSCR is >` as a bogus tag and silently eats the LTV band and the
DSCR threshold — exactly the two numbers that matter. Use a tolerant parser (or a pre-pass that
escapes `<`/`>` when not followed by a tag name), and **assert on a known adjustment string** in the
test so a silent swallow fails loudly.

---

## 5. How hard is this, against the two we have already done

| | **AHL Quick Pricer** | **Lender Price** (`digitallending.com`) | **Encompass** (ICE) |
|---|---|---|---|
| Auth | **none** | OAuth2 password grant **+** HTTP Basic client credential; 1-hour token, refresh chain, service account | OAuth2 + client credentials, instance id, persona/access config |
| Credentials to obtain | **zero** | `LP_USERNAME`, `LP_PASSWORD`, `LP_CLIENT_SECRET`, client id, origin, company id, user id | issued client, secret, instance, seat |
| Endpoints to learn | **1** (+1 zip helper) | `token` → `defaultSearch` → `smo` → `searchRaw/{companyId}/{userId}` → enrichment lookups | dozens |
| Request body | 17 flat form fields | a ~6.8 KB nested search **model** that must be transformed from `defaultSearch`, not cloned from it | JSON per resource |
| Response | 150 KB HTML, hand-parseable | **~7 MB** nested tree, flattened to rate ladders | JSON, deep schema |
| Discovery cost paid | **one HAR, one afternoon** | **31 recorded searches**, a token registry, a field registry, an agreement harness, and a documented 500-error bisection campaign | vendor docs + a live-probe programme |
| What it cost to build | *(not built)* | `src/longterm/lenderprice` **4,009 lines** + `src/longterm/ppe` **5,898 lines** + **19 research docs / 3,084 lines** | ~10,028 lines of client + **23 docs** |
| Failure modes | their HTML changes | token expiry, 500s that mean "wrong document posted", per-user pricing config, vendor-side model drift | webhooks, field-id drift, write authorisations |
| Legal / relationship | **an open public page, no agreement** | contracted vendor, written authorisation on file for live probing | contracted, with a write-authorisation pad |

**The answer, plainly: this is the easiest of the three by a wide margin — roughly an order of
magnitude.** Lender Price cost thousands of lines and a documented forensic campaign just to make the
*first successful call*; the hard part there was never parsing, it was authentication, the
`defaultSearch`-vs-request-document distinction, and a 500 that only cleared when two unrelated
fields were changed together. Encompass cost ~10k lines and 23 documents. Here, the first successful
call took one `curl` and no credentials, and the field contract fell out of a 73-request
minimisation that ran unattended in five minutes.

The **only** axis on which this one is harder is that the response is HTML rather than JSON — and
that is a ~40-line parser plus one escaping workaround, against which you get the adjustment stack
and the decline reasons that Lender Price makes you reconstruct.

### Where the real risk actually sits

Not in the engineering. In three places:

1. **No contract, therefore no stability promise and no rate-limit promise.** A public PHP page can
   change its markup on any deploy. Whatever gets built needs a **canary** — the repo already has
   this pattern in `src/longterm/ppe/canary.js` — that prices a fixed scenario on a schedule and
   fails loudly when the parse shape or a known adjustment string moves.
2. **Politeness and volume.** No auth means no quota *and* no goodwill. Cache aggressively (identical
   scenarios are deterministic), keep concurrency at 1, and back off. Rate limiting was **not**
   tested here — deliberately; ~80 requests total were made, spaced, which is browser-scale.
3. **Terms of use and the relationship with AHL.** Absent authentication is not the same as granted
   permission, and this is a lender we may deal with. This is the owner's call, not an engineering
   call, and it should be answered **before** anything is built.

## 6. Open questions for the owner

1. **RTL or LT?** The same pricer covers DSCR (long-term) and Bridge / Rehab / Ground-Up (RTL). Rule 1
   says ask. Nothing gets built until this is answered.
2. **Is AHL a counterparty we price against openly**, or does this need their sign-off first?
3. **What is it for** — a comp/benchmark feed against our own pricing, an ingest into the pricing
   board, or a borrower-facing surface? That decides caching, storage and whether the AHL name is
   ever shown.

## Appendix — reproduce it

```bash
curl -s -X POST https://client.ahlend.com/quickpricer/index.php \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'Action=Get Pricing' \
  --data-urlencode 'ConsumerPurpose=Business' \
  --data-urlencode 'LoanPurpose=Refinance' \
  --data-urlencode 'RefiPurpose=CashOut' \
  --data-urlencode 'DocType=Investor - DSCR' \
  --data-urlencode 'LoanTerm=40' \
  --data-urlencode 'FICO=760' \
  --data-urlencode 'DSCR=1.3' \
  --data-urlencode 'InterestOnly=Yes' \
  --data-urlencode 'Channel=CorrNonDel' \
  --data-urlencode 'PropertyValue=500000' \
  --data-urlencode 'LoanAmount=350000' \
  --data-urlencode 'PropState=CT' \
  --data-urlencode 'PropertyType=Condo' \
  --data-urlencode 'Units=4' \
  --data-urlencode 'Occupancy=Investment' \
  --data-urlencode 'LockTerm=30' \
| grep -o "selectPrice(this,[^)]*)"
```
