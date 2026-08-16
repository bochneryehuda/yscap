# Lender Price backend client (Long-Term DSCR)

The **pricing agent** from the architecture blueprint: our own backend logs into Lender
Price once, keeps one warm token, and drives the same internal calls the
`yscapgroup.digitallending.com` web app makes — **login → enrich → price → parse**.
It is a pricing **viewer**: it reads pricing and never books, locks, registers, or touches
favorites.

> **Long-Term only.** Self-contained — reads `process.env` directly, imports no RTL code,
> touches no database. Passes the product-separation gate.

## The 401 fix (why the backend login was rejected)

Confirmed from two clean live login recordings (2026-08-16): the token request authenticates
both the borrower and the OAuth client. The borrower email/password are form fields, while
the OAuth client uses `Authorization: Basic base64(client_id:client_secret)`. The original
backend omitted that Basic header, so it returned `401 Unauthorized` even with the right
borrower password. `client.js` now sends the Basic credential plus the same Origin, Referer,
content type, and form fields as the browser.

## Configure on Render (environment variables)

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `LP_USERNAME` | ✅ | — | The service login email (lowercase). Never commit it. |
| `LP_PASSWORD` | ✅ | — | The service login password. Render env only. |
| `LP_CLIENT_SECRET` | ✅ | — | OAuth client secret used with `LP_CLIENT_ID` in HTTP Basic auth. Render env only. |
| `LP_ORIGIN` | | `https://yscapgroup.digitallending.com` | The company page the login must come "from". |
| `LP_CLIENT_ID` | | `acme2` | OAuth client id. |
| `LP_AUTH_BASE` | | `https://auth.digitallending.com` | Token host. |
| `LP_API_BASE` | | `https://api.digitallending.com` | Pricing + enrichment host. |
| `LP_COMPANY_ID` / `LP_USER_ID` | | (from login) | Fallbacks; normally discovered from the token response. |
| `LP_DEFAULTSEARCH_PATH` | | `/rest/v1/lp-ppe-integration/pricing/defaultSearch/{companyId}/{userId}` | Live default-search model to clone. Falls back to the captured `search-base.json` if unavailable. |
| `LP_SMO_PATH` | | `/rest/v1/lp-ppe-integration/pricing/smo/{companyId}` | Live special-mortgage-option registry (current `{id,name}`). Falls back to captured ids. |
| `LP_FOUNDATION_TTL_MS` | | `1800000` | How long the fetched default-search + SMO registry are cached (30 min). |

## How the searchRaw body is built (the 500 fix)

Lender Price rejects a hand-built minimal payload with 500 — it wants the FULL search model
(`brokerCriteria`, `accessCriteria`, `filter`, `miCriteria`, closing-cost defaults, `{fieldId,value}`
dynamic properties, `{id,name}` special-mortgage-options). So `price()` mirrors the web app:

1. Fetch the company's LIVE `/pricing/defaultSearch` (cached) and its `/pricing/smo` registry.
2. Deep-clone that model and overlay ONLY the scenario fields (borrower / property / loan /
   compensation / DSCR) — every unknown default is preserved.
3. Resolve DSCR + prepay options to the company's CURRENT SMO ids.
4. Keep the 30-day lock (`brokerCriteria.dayLocks = 30`, `dayLocksCriteria = [30]`); the 30-YEAR
   term is separate (`termsCriteria = [30]`, `termsInMonths = false`).

If the live endpoints are unavailable the captured `search-base.json` (a real accepted search,
returned 27 programs) and the built-in SMO ids are used — so pricing never falls back to the
minimal payload that returned 500. On any non-200 the routes surface up to 600 chars of the
scrubbed upstream body so Lender Price's validation message is visible.

The login response returns `companyId` and `userId`, which the pricing URL
(`…/pricing/searchRaw/{companyId}/{userId}`) needs — so those are discovered at login,
not hardcoded.

## HTTP endpoints (mounted in `src/server.js`)

**Staff-gated** (behind the normal staff login, under the existing `/api/lt` mount):

| Method | Path | What |
|--------|------|------|
| GET | `/api/lt/dscr/health` | Up? Are credentials configured? (no login attempted) |
| GET | `/api/lt/dscr/login-check` | Actually log in and report ok/failure + companyId/userId |
| POST | `/api/lt/dscr/price` | Body = a scenario (or `{scenario}`) → parsed program summary |
| POST | `/api/lt/dscr/disqualify` | Body = a scenario → qualified summary **plus** the disqualify reasons per lender |
| POST | `/api/lt/dscr/selftest` | Run the fixed scenario battery |

### How the disqualify workflow works (the "show disqualified" button)

A normal search returns only the **qualified** programs, fast. To also learn WHY each lender turned
the scenario down, Lender Price mirrors its web app's two-phase, **asynchronous** flow:

1. Re-send the same searchRaw body with the disqualify flags — `showDisqualify`,
   `showDisqualifyRules` (include the actual failing rule text), `disqualifyAsync`, `fillLenderMap`,
   and `cachedDisqualified:false`. This returns the qualified programs immediately and **kicks off**
   the disqualify computation on Lender Price's side.
2. Poll the same body with `cachedDisqualified:true`. While Lender Price is still computing (a few
   minutes) it answers with an **empty body**; once ready it returns the full result with a populated
   `results.disqualifiedData` tree (lender → program → failing rules + reasons).

`priceDisqualified()` does both, polling within a bounded window (`LP_DISQUALIFY_MAX_WAIT_MS`, default
80s; `LP_DISQUALIFY_POLL_MS`, default 5s). The poll body differs from the kickoff only in
`cachedDisqualified`, so Lender Price's cache key matches — which means calling the endpoint **again**
rebuilds the identical body and picks up the cached result quickly. If the window elapses the endpoint
returns `ready:false` with the qualified data; call it again shortly. `parseDisqualified()` flattens
the tree to `{ lenders: [{ lender, items: [{ program, reasons }] }] }`.

**Secret-gated diagnostics** (no staff login; for backend verification):
`/api/lt/_diag/lenderprice/{health,login-check,price,selftest}` — identical handlers, gated
by the `x-lp-diag-token` header matching **`LP_DIAG_TOKEN`**. **OFF by default**: with
`LP_DIAG_TOKEN` unset every path 404s. Set `LP_DIAG_TOKEN` in Render to enable, then:

```bash
curl -s https://<app-host>/api/lt/_diag/lenderprice/login-check -H "x-lp-diag-token: $LP_DIAG_TOKEN"
curl -s -X POST https://<app-host>/api/lt/_diag/lenderprice/selftest -H "x-lp-diag-token: $LP_DIAG_TOKEN"
```

## Verify (scripts)

```bash
# offline — proves the request shapes (no network); runs anywhere, incl. CI
node scripts/test-lt-lenderprice.js
# routes load + the secret gate (no network, no DB)
node scripts/test-lt-dscr-routes.js

# live — logs in and runs a scenario battery; run on Render where the request
# originates from a trusted server (LP_USERNAME/LP_PASSWORD must be set)
LP_LIVE=1 node scripts/test-lt-lenderprice.js
```

## Still to verify on the first live Render run

- The exact `searchRaw` request body (built here from the decoded field mapping) against a
  real live pricing call, and the response field names the `parse()` walker keys on
  (`rate`/`price`/`points`/`apr`/`monthlyPayment`). Both are written defensively and are
  easy to tighten once we have one real capture from the server.
