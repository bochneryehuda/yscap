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

## ANSWERED — the lead this file used to end on is closed

This file previously ended with *"some OTHER field must accompany `fico`"* and asked for the
frontend's captured payload. That payload was obtained, and the answer is not a companion field.

**The cause was that we were posting the wrong DOCUMENT.** `GET /pricing/defaultSearch` returns the
company's CONFIGURATION model; the browser transforms it into a request before calling `searchRaw`.
Our builder cloned it and posted it as the request — 8,576 bytes against the frontend's 6,808, 203
structural differences, HTTP 500 every time. Bisected against the frontend's own body (posted
verbatim as a control, HTTP 200) by applying our differences one at a time:
`criteria.mortgageTypes` arrives **null** on the configuration model, and patching only that value
turned the failing request into a 200.

**So the bisection recorded above was right about the symptom and wrong about the reading.** It saw
that `mortgageTypes: []` alone failed, `fico` deleted alone failed, and both together returned a
well-formed empty 200 — and concluded a companion field was missing. What was actually happening is
that the whole document was wrong, and those two edits happened to move it toward a shape their
parser could survive. The `fico`-must-be-absent inference in particular is FALSE of a real request:
the frontend sends a numeric `fico` and prices, and so do we now.

**`fico` is in fact REQUIRED and may not be null** — probed directly, on a body otherwise proven to
price: `criteria.fico` set to null → 500, and REMOVED → 500. The full measured contract for every
leaf is `SEARCHRAW-FIELD-CONTRACT.md`, generated from the raw probe results.

**Current state: pricing works.** 11 programs / 309 priced options / 8 lenders on the captured
baseline scenario — identical to what the vendor's own website returns for the same deal. The
remaining known deviation is the special-mortgage-option list (we substitute an id-less DSCR band
option for the frontend's "Prepay Buyout"), which was MEASURED to make no difference to the result
and is tracked as its own item rather than assumed harmless.

**What generalises from this file:** every wrong conclusion in it came from reasoning about a
measurement instead of re-measuring against a control that works. When the vendor answers with a
bare status code and no message, get a body that prices and change it one field at a time.

## How to reproduce any of the above

The bisection is a loop over `Object.keys(defaultSearch.criteria)`, POSTing
`{...defaultSearch, criteria: {[k]: v}}` and recording the status. Two keys answer 500; the rest
answer 200.
