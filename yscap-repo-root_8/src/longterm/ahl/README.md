# American Heritage Lending — the third pricing program

Decoded in full from one browser HAR plus ~120 measured live requests on 2026-08-30/31.
`capture/` is the verbatim traffic every claim here rests on: four real AHL answers to bodies
this builder produced, and AHL's own form registry.

> **Long-Term only.** Self-contained: reads `process.env` directly, touches no database,
> imports no RTL code. It is a pricing **viewer** — it never locks, registers or books.
>
> **It cannot price RTL's product.** AHL's dropdown carries `Investor - No Ratio` = *"Investor
> Bridge - Rehab - Ground Up"*. `DocType` is pinned to `Investor - DSCR` and any attempt to
> change it is refused by name. See `docs/longterm/AHL-PRICING-MAPPING.md` §4.

## What AHL is

Not an aggregator. AHL's Quick Pricer prices **AHL's own sheet and nobody else's**, which is why
it enters the board as an additional *layer* for one investor rather than as a third source in
the two-way election — there is never a second quote for American Heritage to be elected
against.

Its transport is a server-rendered PHP page, and that is the least interesting thing about it.

## The whole protocol

| Method | Path | What |
|---|---|---|
| POST | `/quickpricer/index.php` | **Everything.** Form-urlencoded in, 150 KB of HTML out. |
| POST | `/ajax/getcitystatecountyfromzip.json` | zip → city / state / county / AMI / **`licensed`** |

That is the complete allowlist; every other URL is refused before the wire. `/tpo/*` — the rate
sheets and third-party fees the page's own JS references — answers **302 to the login**, so the
public boundary is narrow and clean.

**There is no authentication.** No cookie is sent, none is set, no CSRF, no token, no Referer
requirement. Measured: a bare POST returns a live board, byte-identical to the browser's.

## What it costs, against the other two

| | Lender Price | LoanNEX | **AHL** |
|---|---|---|---|
| Credentials | OAuth2 password grant **+** Basic client credential | a portal sign-in → ticket → JWT | **none** |
| Endpoints to learn | 5-call chain | 8 | **1** |
| Pricing call | ~5–30 s, the FULL cloned search model | ~350–460 ms, a flat object | ~3.5 s, **17 flat form fields** |
| Investors per call | many | 9 | **1 — its own** |
| Products per call | all | all | **ONE** (term × IO × lock are inputs) |
| Itemized LLPAs | inline with the search | **one call per quote** | **inline with the search** |
| Why a program said no | asynchronous poll, minutes | one GET | **inline with the search** |
| Sheet freshness | stated | `rateSheetLastUpdated` | **not stated** — so we say we do not know |

The transport is the worst of the three and the *answer* is among the best: AHL renders the
adjustment stack and the decline reasons beside the price because it was built for a human to
read, so one call answers both layers of the quote.

## The fan-out — the one thing that is genuinely harder

`LoanTerm`, `InterestOnly` and `LockTerm` are **inputs**, so one request returns one product at
one lock. Measured: 40-year pairs with interest-only, 30-year pairs without it, and the other
two combinations return **nothing eligible**. A single guessed pair would show half the shelf.

So an unpinned scenario fans out to **four requests** (2 products × 2 locks), run two at a time,
and `parse.mergeLegs` returns one board where each product carries both locks as rungs — the
shape LoanNEX gets from a single call. The terms are read from AHL's own option classes, never
from a list here.

## The one real parsing trap

AHL's escaping is **inconsistent**. The ineligible tooltips escape correctly (`&lt;= $1.0M`);
the eligible programs' adjustment table emits **raw** operators:

```html
<td>… Max of LTV/CLTV/HCLTV is <=70, And DSCR is >= 1.25</td>
```

A strict DOM parser reads `<=70, And DSCR is >` as a bogus tag and **silently eats** the LTV
band and the DSCR threshold — the two numbers that make the line worth reading. It does not
error; it returns a shorter sentence. `repairOperators` runs first, and `OPS-1`/`OPS-2` assert on
exact strings containing both operators.

A second, related trap: the per-program blocks nest a `<div>` in a `<div>`, so stopping at the
first `</div>` truncates and running to the last one swallows the page. An early cut of this
parser did the latter and attached 90 KB of script to a program's **name**; `NAME-1` caught it.

## Configure

| Var | Required | Default | Notes |
|---|---|---|---|
| `AHL_CHANNEL` | | `CorrNonDel` | Owner-directed 2026-08-31: *"we are CorrNonDel."* `Wholesale` / `Correspondent` / `CorrNonDel` **price differently** — see the mapping doc §7. |
| `AHL_BASE_URL` | | `https://client.ahlend.com` | |
| `AHL_TIMEOUT_MS` | | `30000` | |
| `AHL_MAX_CONCURRENCY` | | `2` | AHL sets no quota, so this client sets its own. |

## Verify

```bash
node scripts/test-lt-ahl-scenario-pure.js   # the request AHL says it received
node scripts/test-lt-ahl-parse-pure.js      # the board, the LLPAs, the refusals
node scripts/test-lt-ahl-layer-pure.js      # one investor changes, nothing else
```

All three are offline and run in CI. To check AHL is still answering and its form still matches
the captured registry:

```js
await require('./client').health();   // { ok, registryChanged, registryChanges }
```

## Still open

1. ~~**Which channel do we buy through?**~~ **Answered: CorrNonDel** (owner-directed
   2026-08-31). Kept as a setting — three channels, three sets of economics.
2. **Do we price against AHL openly?** No credentials is not the same as permission.
3. **The canary.** No contract means no stability promise — `health()` wants scheduling on the
   existing `ppe/canary.js` pattern.
4. **AHL states no rate-sheet date**, so `flags.expired` stays `null` — "we do not know" — and
   never `false`, which would be a reassurance nobody gave us.
