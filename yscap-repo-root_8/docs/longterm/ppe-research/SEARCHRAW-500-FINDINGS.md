# Why `searchRaw` returns 500 — what is MEASURED (2026-08-16)

All of this is live, against the real vendor, with the owner's written authorization.
Reproducible with `LP_USERNAME` / `LP_PASSWORD` / `LP_CLIENT_SECRET` set.

## Settled, do not re-litigate

**The pricing path uses the LOGIN's user id.** Controlled A/B, same token, company, payload
and minute:

| user id in the path | result |
|---|---|
| `68e9a60f…` — the login's | **HTTP 200**, 19 eligible programs |
| `68e9a4e5…` — `ppe-user-link`'s | HTTP 500 "Loan Officer Pricing Configuration not setup" |

Their own frontend calls `searchRaw(userInfo.companyId, userInfo.userId, …)` and never calls
`ppe-user-link` before pricing. **The "not setup" message does not describe the account** — it means
"no pricing configuration exists under the id you sent". The account is fully configured. A brief
substitution of the PPE id here manufactured that error and has been removed.

**The account, the login and the foundation are all fine:** password grant 200, refresh grant 200
(chained ×4), `GET defaultSearch` 200, `GET smo` 200.

## The payload defect, isolated by bisection

Posting Lender Price's OWN `defaultSearch` back to them unchanged returns 500. Removing the whole
`criteria` object returns **200**. Testing each of the 102 criteria keys IN ISOLATION identifies
exactly two that break the request on their own:

| criteria field | value in their own template | effect |
|---|---|---|
| `mortgageTypes` | `null` | 500 on its own |
| `fico` | `760` | 500 on its own |

With **`mortgageTypes: []` and `fico` ABSENT**, the same request returns **HTTP 200** (8,700 bytes,
a well-formed empty result set). So there is nothing wrong with our credentials, our path, our
options list or our transport — the request shape is the whole story.

Further measured, and not yet explained:

- `mortgageTypes: ["NonQM"]` → 500. Only the EMPTY array has been seen to work.
- `fico` as a string or an array → 500. Only ABSENCE has been seen to work.
- `ficoScore` / `creditScore` beside an absent `fico` → 200, but still **0 programs**.

## What is still open

We can now get a 200, but not yet the 19 programs their frontend gets. Their working request is
**6,805 bytes**; their `defaultSearch` template is 7,815 and our built body is 8,454 — so the
frontend REMOVES roughly a thousand bytes of the template before sending, and we ADD to it.

**The one artifact that would close this in minutes** is the captured frontend payload: open Quick
Pricer, DevTools → Network → the `searchRaw` request → Request Payload. Diff it against
`buildSearch`'s output field by field, ignoring dates and request ids. Everything above was derived
without it; this last step should not be guessed at, because a field-by-field diff against a known
-good body is exactly the evidence that ends the question.

## How to reproduce any of the above

The bisection is a loop over `Object.keys(defaultSearch.criteria)`, POSTing
`{...defaultSearch, criteria: {[k]: v}}` and recording the status. Two keys answer 500; the rest
answer 200.
