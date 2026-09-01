# LoanNEX — the second pricing program

Decoded in full from three browser recordings made on 2026-08-30. This file is the
protocol; `capture/` is the verbatim traffic every claim here rests on, and the two
pure tests (`scripts/test-lt-loannex-{scenario,merge}-pure.js`) prove the request we
build against the request LoanNEX itself accepted.

> **Long-Term only.** Self-contained: reads `process.env` directly, touches no
> database, imports no RTL code. It is a pricing **viewer** — it never locks,
> registers or books.

## What LoanNEX is

A second multi-investor pricing aggregator alongside Lender Price. Its web app is an
Angular single-page app talking to a plain JSON REST API at `nexapi.loannex.com`.
**One POST prices every investor at once** — the recorded call answered in **460 ms**
with **1,718 price rows across 9 investors and 14 programs**.

## The three-stage session

| # | Call | What it does |
|---|------|--------------|
| 1 | *(the portal sign-in form)* | A session on the portal host. **NOT IN ANY RECORDING — see below.** |
| 2 | `GET {portal}/iframe/loadiframe?_id=&page=nex-app` | Returns HTML whose iframe `src` carries `tokenKey={guid}` — a one-time hand-off ticket. |
| 3 | `GET {api}/tokens/{tokenKey}` | Exchanges the ticket for a JWT (1 h) + a refresh token (4 h). **No `Authorization` header** — the ticket *is* the credential. |

Every later call sends `Authorization: Bearer <jwt>` and `Origin: https://webapp.loannex.com`.
The JWT's own claims carry the `userGuid` every pricing URL needs, so nothing is
hardcoded.

### Stage 1 — CLOSED (kept for the history)

> **Superseded.** What follows describes the position on the morning of 2026-08-30, before
> the fifth recording. Stage 1 is now implemented in `portal-login.js` AND has been run
> against the live portal end to end. `NEX_USERNAME` / `NEX_PASSWORD` are the normal way to
> configure this — see **Configure** below. The paragraph is left standing because the
> reasoning (refuse rather than guess a login) is why the client behaves as it does when it
> is NOT configured.

All three recordings begin **after** the browser was already signed in, so the login
form's URL, its field names and any second factor are unknown. This client therefore
**refuses rather than guesses** (`loannex_login_unrecorded`): a guessed login fails in
a way that looks exactly like a wrong password, which is the worst kind of wrong.

Two ways forward, and the first needs nothing from anyone:

* **`NEX_TOKEN_KEY`** — paste a `tokenKey` out of a live browser session and stages 2–3
  and everything downstream run for real, today.
* **A recording that includes the sign-in submit** — then stage 1 is a short, verified
  addition and the whole thing runs unattended.

## Portals

Each investor portal is its own tenant of one API. Same organisation (`12501`), same
`nexapi`, different `PortalId`:

| Portal host | PortalId | What it sees |
|---|---|---|
| `web.loannex.com` | 1 | The aggregator — all 9 investors in one answer |
| `acracorrespondent.loannex.com` | 27 | Acra's own portal |
| `nqmfcorr.loannex.com` | 54 | NQM Funding's own portal |

`NEX_PORTAL` picks one; `opts.portal` overrides per call. **The recordings do not show
pricing from an investor-specific portal**, so whether those quote differently from the
aggregator is an open question — one scenario priced on each answers it.

## The endpoints

**Read + pricing (the whole allowlist — anything else is refused before the wire):**

| Method | Path | What |
|---|---|---|
| GET | `/tokens/{tokenKey}` | Ticket → bearer token |
| GET | `/users/profiles/current` | Who the session belongs to |
| GET | `/loans/apps/{userGuid}/settings` | **The field registry** — 95 fields with their exact enum keys |
| GET | `/lookups/counties?stateValue={ST}` | LoanNEX's own county keys |
| POST | `/loans/apps/{userGuid}/quick-prices` | **Price everything.** A read despite the verb — the scenario is too big for a query string |
| GET | `/loans/evidences/{userGuid}/{txn}/fails` | **Why each investor said no** — synchronous |
| POST | `/loans/evidences/{userGuid}/{txn}` | The LLPA breakdown behind one quote |
| GET | `/loans/rate-stacks/{userGuid}/{txn}/{priceHashKey}` | The full rate ladder |

**Never allowed:** `/loans/locks`, `/loans/registrations/*` and everything else. The
guard is a *positive allowlist*, not a blocklist of verbs — a blocklist is only as good
as the last endpoint somebody knew about. A priced answer literally carries
`availableLockActions: [RequestLock, RegisterProduct, …]`, so this matters.

## Where LoanNEX is better than Lender Price

| | Lender Price | LoanNEX |
|---|---|---|
| Pricing call | ~5–30 s, needs the FULL cloned search model | **~350–460 ms**, a flat scenario object |
| Field vocabulary | 27 KB decoded by hand from captures | **The vendor ships it** — one GET returns all 95 fields with their enums |
| Why an investor said no | Two-phase **asynchronous poll**, minutes | **One GET**, returns with the price call |
| LLPA breakdown | Parsed out of the price build | Base price + each adjustment + floor/ceiling, structured |
| Sheet freshness | — | `rateSheetLastUpdated` per program |

## Configure

| Var | Required | Default | Notes |
|---|---|---|---|
| `NEX_USERNAME` / `NEX_PASSWORD` | ✅ *(this is the normal way)* | — | The LoanNEX portal sign-in. Stage 1 is implemented in `portal-login.js` and has been **run against the live site**: the three-stage hand-off signed in and priced a real loan on the real account (2026-08-30). Set these two and nothing else is needed. |
| `NEX_TOKEN_KEY` | *(alternative)* | — | A hand-off ticket pasted out of a live browser session. Only needed if the sign-in is unavailable — short-lived and single-use, so it is a stop-gap, not a configuration. Never commit one. |
| `NEX_PORTAL` | | `web` | `web` is the AGGREGATOR and prices every investor in one answer — leave it alone unless you specifically want one investor's own portal (`acracorrespondent`, `nqmfcorr`, …), which returns that investor alone. |
| `NEX_API_BASE` | | `https://nexapi.loannex.com` | Leave unset. |
| `NEX_WEBAPP_ORIGIN` | | `https://webapp.loannex.com` | Sent as `Origin`; the API expects it. Leave unset. |
| `NEX_TIMEOUT_MS` | | `30000` | |
| `NEX_DIAG_TOKEN` | | — | Unset ⇒ the diagnostic seam at `/api/lt/_diag/loannex/*` is 404. Set it to check the two-vendor pipeline from the server without a browser session. |
| `LT_COMBINED_PRICING` | | on | The kill switch. `off` makes every combined-engine path 404 without touching the General Pricing Engine. |

Either `NEX_USERNAME`+`NEX_PASSWORD` **or** `NEX_TOKEN_KEY` must be set; with neither,
`/health` reports the engine unconfigured and the combined board says so in words rather
than showing a short board as though it were the whole market.

**Operator setup guide (plain language): `docs/longterm/COMBINED-ENGINE-SETUP.md`.**

## The Combined Pricing Engine

`src/longterm/pricing/merge.js` puts both programs on one board and elects a source
per investor. Mounted at **`/api/lt/dscr/combined/*`** and **SUPER ADMIN ONLY** — every
path answers 404 to anybody else while the owner audits it (2026-08-30). It is a SECOND
engine beside the General Pricing Engine at `/api/lt/dscr/*`, which is untouched.
`LT_COMBINED_PRICING=off` is the kill switch.

The rule, in one line: **at the same product, the same lock and the same note rate,
the higher price is the better execution.** Three refusals keep it honest —
an investor whose name resolves to no canonical key is never merged (reported instead),
nothing is compared across product classes or lock periods, and a tie elects nobody.
Election is a *recommendation carried beside the data*, never a filter: both vendors'
programs stay on the board for every investor.

## Verify

```bash
node scripts/test-lt-loannex-scenario-pure.js   # the request shape, against the recorded body
node scripts/test-lt-loannex-merge-pure.js      # parse, election, read-only wall
```

Both are offline and run in CI. To run the real thing once a ticket is in hand:

```bash
NEX_TOKEN_KEY=… NEX_DIAG_TOKEN=… \
  curl -s https://<host>/api/lt/_diag/loannex/loannex/login-check -H "x-nex-diag-token: $NEX_DIAG_TOKEN"
```

## Still open

1. **The portal sign-in (stage 1)** — needs one recording that includes the form submit.
2. **Do the investor-specific portals price differently?** Not in the recordings.
3. **Button Finance, Inc.** quotes on this board and is on no white-label sheet, so it
   has no consumer-safe name. It is reported as unmapped until the owner names it.
4. **The refresh-token endpoint** was not captured; the client re-mints from the ticket
   instead, so a session lasts as long as the JWT (1 h).
5. **Neither board asks for the borrower's CITIZENSHIP, and the two programs fill the gap
   differently.** The scenario vocabulary has a real `citizenship` field and both connectors
   honour it — but no screen offers a control for it, so on an ordinary quote it is unstated.
   LoanNEX is then sent `UsCitizen` (the value the recorded live body carries, and what this
   connector has always sent for an unstated scenario); Lender Price OMITS the field entirely
   and takes the vendor's own default. So a foreign-national borrower is priced as a US citizen
   on both boards until somebody states it, and the two programs are not being asked exactly
   the same question. Adding the control would change the GENERAL board, which is off limits
   without the owner's word — raised rather than guessed at.

---

## Update, 2026-08-30 (second pass)

A fifth recording — the investor portals, with pricing — settled several things. The full write-up is
`docs/longterm/LOANNEX-PARITY-AND-ROUTING.md`; the headlines:

- **Stage 1 (sign-in) is implemented**, in `portal-login.js`. Decoded field for field from the
  capture, which records the sequence six times across three portals. It is implemented but has **not
  yet been run against the live site** — `/health` says so rather than implying otherwise.
- ⚠️ **The recording contains the portal password in plain text.** It is compromised and must be
  rotated at LoanNEX before use. Nothing here stores it; credentials come from the environment only.
- **An investor portal returns exactly ONE investor** (`nqmfcorr` → NQM Funding alone) and carries
  `?portal={name}` on the iframe hand-off. Whether it prices that investor the same as the aggregator
  is NOT known and is not assumed.
- **The `/rate-stacks` call is not needed for the board.** Measured inside one transaction: it returns
  the ladder already present in `quick-prices` — 102 of 102 (rate, lock) pairs identical to the
  thousandth. Fixture: `capture/rate-stack-vs-board.json`.
- **The itemised LLPAs are the one thing that costs a call per quote.** `basePrice + Σ adjustments =
  price` reconciles exactly on the captured evidence, and `priceFloor`/`priceCeiling` do bite.
- **Interest-only is not an input here.** Across all 19 recorded pricing bodies LoanNEX takes no such
  field; it is a product the answer returns.
- **The scenario defaults and the button names are now shared** with Lender Price
  (`../pricing/scenario-defaults.js`) — before that the two programs were priced on different loans.
