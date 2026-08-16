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
`criteria` object returns **200**. Two fields inside it are implicated, and the sound comparison is
the one that varies ONE thing against the COMPLETE criteria object — not the earlier
one-key-in-isolation loop, which reached the same two fields but proves less, because a criteria
object stripped to a single key is not a valid request and can fail for that reason alone. The
full-object matrix:

| request (their own defaultSearch, complete) | result |
|---|---|
| untouched | 500 |
| `mortgageTypes: []` only | 500 |
| `fico` deleted only | 500 |
| **`mortgageTypes: []` AND `fico` deleted** | **200** (well-formed, empty) |
| `mortgageTypes: []` + `fico: 760` | 500 |
| `mortgageTypes: []` + `fico: 700` | 500 |

**Neither fix works alone; together they work.** That is why every earlier single-variable attempt
looked like a dead end. Their own template ships `mortgageTypes: null`, which their frontend
overwrites before sending (`l.mortgageTypes = [lineResults.mortgageType]`).

Also measured: `mortgageTypes: ["NonQM"]` → 500 (only the EMPTY array has been seen to work), and
`fico` as a string or an array → 500 (only ABSENCE has been seen to work).

## THE SHARPEST REMAINING LEAD

**Their frontend does send `criteria.fico` as a plain number** — the bundle binds it to an input
(`[(ngModel)]="search.criteria.fico"`) and sets it from `ficoScore.effectiveCreditScore`. So a
numeric `fico` is unquestionably valid in a complete, correctly-shaped request, and it fails for us.

That means **some OTHER field must accompany it** — one their frontend sets and we either omit or
send differently, without which the credit-score path throws. Finding that field is the whole
remaining task, and the captured payload names it immediately. Do not guess it: the wrong-user-id
episode is what guessing costs.

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
