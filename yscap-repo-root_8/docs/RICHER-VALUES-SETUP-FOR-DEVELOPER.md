# Richer Values — setup guide for the developer

**What this is.** Everything a developer needs to switch the Richer Values connection
on, in order, with every key named and the exact place each one goes. Nothing here
requires a code change — the whole connection is driven by environment variables on
the Render service.

**Where the keys go:** Render dashboard → the `ys-capital` web service → **Environment**
→ *Add Environment Variable* → Save (Render restarts the service on save).

> **Secrets never go in the repository.** Not in a file, not in a commit message, not
> in a pull request. They are typed into Render only. Any credential that has been
> pasted into a chat, an email or a ticket is considered compromised and must be
> rotated with Richer Values before it is used for real orders.

---

## Step 1 — Get the four things from Richer Values

Ask their tech team (tech@richervalues.com) for:

| What to ask for | What it looks like | What it is for |
|---|---|---|
| **API username** | `YehudaBochner` | Signing in to their API |
| **API password** | a password | Signing in to their API |
| **Production base URL** | `https://intake.richervalues.com` | Where real orders go |
| **Training base URL** | `https://training-intake.richervalues.com` | Where test orders go |

That is all. **Do not** ask for a company token or a loan-officer token — PILOT works
both of those out by itself from the username and password (their sign-in reply
contains them). They are only needed if Richer Values ever gives us a bare token
instead of a login; see the optional table in Step 5.

---

## Step 2 — Put the keys in, with everything still switched OFF

Add these five. **Leave `RV_ENABLED` out for now** — the connection stays completely
dormant until Step 4.

| Key | Value to enter | Notes |
|---|---|---|
| `RV_USERNAME` | the API username | |
| `RV_PASSWORD` | the API password | |
| `RV_ENVIRONMENT` | `training` | Start on training. Change to `production` only at Step 6. |
| `RV_DRYRUN` | `1` | Builds the order and writes it to the log, sends nothing. |
| `RV_PAYMENT_METHOD` | `COMPANY_CARD` | Pay with the card YS Capital keeps at Richer Values. This is the default and the owner's choice — do not set it to anything else without asking; invoicing and ACH are not permitted. |

Save. The service restarts.

---

## Step 3 — Check it can see them (nothing is ordered)

Sign in to PILOT as an admin and open **Integrations / API Health**. Find the
**Richer Values** row. It should say it is configured and reachable.

If it does not, the row says which of these is the problem:

- *not configured* → `RV_USERNAME` or `RV_PASSWORD` is missing or misspelled.
- *cannot reach* → wrong `RV_ENVIRONMENT`, or their host is down.
- *rejected* → the username/password is wrong. Ask them to confirm it.

---

## Step 4 — Switch it on in test mode

Add:

| Key | Value |
|---|---|
| `RV_ENABLED` | `1` |

Save. Now open any loan file → **Appraisal** → order section. Richer Values appears
as a third vendor beside NAN and Class. Pick it and go as far as the confirmation
screen — the price, the product, the inspection and the scope of work all show. With
`RV_DRYRUN=1` still set, pressing the order button **sends nothing**; it writes the
exact order to the service log so you can read it.

Check the log line beginning `[rv][DRYRUN] would POST /api/v1/order/submit` and
confirm the property, the four figures and the scope-of-work file are all there.

---

## Step 5 — Let it place real (training) orders

Add:

| Key | Value |
|---|---|
| `RV_OUTBOUND_ENABLED` | `1` |

…and **remove** `RV_DRYRUN` (or set it to `0`).

Place one real order on the **training** tenant. It costs nothing. Confirm on their
side that the order arrives and reads **Ordered** (not *On Hold* — *On Hold* means the
scope of work did not go with it).

### Optional keys — only if you need to change a default

Every one of these has a working default. Do not add them unless there is a reason.

| Key | Default | What it changes |
|---|---|---|
| `RV_DEFAULT_REPORT_TYPE` | `reno-arv` | Which product a new order starts on |
| `RV_DEFAULT_INSPECTION_TYPE` | `interior-w-exterior` | Which inspection it starts on |
| `RV_DEFAULT_TURNAROUND` | `standard` | Standard or `rush` (rush costs $100 more) |
| `RV_DEFAULT_GLA_INCLUDE` | on | Set `0` to turn the floor plan / measurement off |
| `RV_DEFAULT_LICENSING` | off | Set `1` to require a licensed inspector |
| `RV_DEFAULT_FLOOD_CERT` | off | Leave off — PILOT already orders its own flood determination on every file |
| `RV_AUTO_APPLY_VALUES` | on | Set `0` to review the As-Is / ARV before they reach the file |
| `RV_POLL_SEC` | `300` | How often PILOT re-checks open orders |
| `RV_TIMEOUT_MS` | `60000` | How long to wait on one call |
| `RV_COMPANY_TOKEN` | worked out automatically | **Only** if they give us a bare token instead of a login |
| `RV_LOAN_OFFICER_TOKEN` | worked out automatically | Same |
| `RV_API_TOKEN` | not used | **Only** if they give us a bare token instead of a login |
| `RV_BASE_URL` | from `RV_ENVIRONMENT` | Only to point at a host that is neither of theirs |

---

## Step 6 — Go live

Change one key:

| Key | Change to |
|---|---|
| `RV_ENVIRONMENT` | `production` |

Everything else stays as it is. Confirm with Richer Values that the **same username
and password** work on production — often they are different, in which case update
`RV_USERNAME` / `RV_PASSWORD` at the same time.

**From this point every order costs real money** (about $490 for the standard Hybrid
appraisal). There is no further confirmation step in the code beyond the one on the
ordering screen.

---

## Step 7 — The webhook

Without it PILOT still learns everything, by re-checking each open order every five
minutes. With it, PILOT is told the moment something changes.

**The receiver is already live in production and already refuses everything.** Verified
2026-08-16: a POST with no credentials answers `401 {"error":"unauthorized"}`, which is
the whole of our half working — it fails closed until a secret is configured, because an
unauthenticated public URL that writes rows is worse than one that is switched off.

**The URL to give Richer Values:**

```
https://pilot.yscapgroup.com/api/richer-value/webhook
```

> **A NOTE ON WHAT WAS FIXED HERE, because it would have been invisible.** Until
> 2026-08-16 the receiver stored their tokens JSON-QUOTED — `"intake-tok"` rather than
> `intake-tok` — because the five TEXT columns were run through `F.jsonbText`, which is
> `JSON.stringify` and belongs only to the jsonb column. `sync.js` resolves a delivery
> with `WHERE intake_token = $1` against `rv_orders`, which holds the token clean, so
> **not one delivery could ever have been matched to an order.** Every event would have
> authenticated, stored and answered 200, and the five-minute poll would have kept the
> desk up to date — so the push half would simply never have done anything, and nothing
> would have looked wrong. It is now guarded by `scripts/test-richer-value-webhook-db.js`,
> which asserts the JOIN rather than the row, because testing the receiver alone cannot
> see this class at all.

Ask them to send a header with it, and set the matching keys here:

| Key | Value |
|---|---|
| `RV_WEBHOOK_TOKEN` | a long random string you generate |
| `RV_WEBHOOK_TOKEN_HEADER` | `x-api-key` (default — only change it if they insist on another header name) |

Give them the **same random string** to put in that header. PILOT refuses any webhook
that does not carry it.

If they prefer a username/password instead of a header, use these two instead:

| Key | Value |
|---|---|
| `RV_WEBHOOK_USER` | a username you choose |
| `RV_WEBHOOK_PASSWORD` | a password you generate |

---

## Step 8 — Save our card at Richer Values (this is how orders get paid)

**Do this once, by hand, and everything else pays itself.** A human signs in to the
Richer Values portal on the YS Capital account and saves a company credit card
(Company → payment methods). PILOT never sees that card number — it only tells them
"charge the card you already hold."

That is why it works when the other card options do not: their Stripe account
**refuses a raw card number**, so *"charge the card on this file"* and *"enter a card
now"* both end in a refusal today. Saving the card in their portal is the way round
it, and it is the route their CEO named.

**If the account holds more than one card,** PILOT will not choose between them — it
says so and stops, because charging the wrong company card is silent. Add
`RV_PAYMENT_SOURCE_ID` with the id of the card you want charged.

| Key | Value | When |
|---|---|---|
| `RV_PAYMENT_SOURCE_ID` | the card's id from Richer Values | **Only** if more than one card is saved on the account |

Nothing breaks while the card is missing: every order falls through to **"Send the
borrower a payment link"**, and the order screen says plainly that there is no card
saved yet.

### The card surcharge — settled

They add **$3.50** to every card payment, and it sits **outside** the price they
quote. Owner-directed 2026-08-16: **the borrower is quoted the all-in total**, so the
order screen's headline is their price plus the $3.50 (a $489.99 report reads
$493.49). The fee is named in the breakdown and their own price is shown beside it,
so our figure still reconciles to their invoice.

---

## Quick reference — every key, one table

| Key | Required? | Value |
|---|---|---|
| `RV_ENABLED` | **yes** | `1` |
| `RV_USERNAME` | **yes** | from Richer Values |
| `RV_PASSWORD` | **yes** | from Richer Values |
| `RV_ENVIRONMENT` | **yes** | `training` then `production` |
| `RV_OUTBOUND_ENABLED` | **yes, to order** | `1` |
| `RV_PAYMENT_METHOD` | recommended | `COMPANY_CARD` |
| `RV_PAYMENT_SOURCE_ID` | only if 2+ cards | the card id from Richer Values |
| `RV_DRYRUN` | while testing | `1`, then remove |
| `RV_WEBHOOK_TOKEN` | recommended | a long random string |
| `RV_WEBHOOK_TOKEN_HEADER` | only if they insist | default `x-api-key` |
| everything else | no | leave unset |

---

## How to prove it works, at any time

From the project folder (`yscap-repo-root_8`):

```bash
# The whole integration, checked hundreds of times, no network, no database:
node scripts/audit-richer-value.js --rounds 250

# The same, plus read-only calls to the live training tenant
# (catalogue + real price quotes — it never places an order):
RV_ENABLED=1 RV_ENVIRONMENT=training \
RV_USERNAME=... RV_PASSWORD=... \
node scripts/audit-richer-value.js --rounds 40 --live
```

Both print `all checks passed` when the connection is healthy. The pure run is also
part of `npm test`, so it runs on every build.

---

## If something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| Order button greyed with *"writes are gated off"* | `RV_OUTBOUND_ENABLED` is not `1` | Add it |
| *"the master switch is off"* | `RV_ENABLED` is not `1` | Add it |
| Order comes back **On Hold** | No scope of work went with it | Add the scope of work to the file and re-send it from the order card |
| *"Richer Values cannot take a card number"* | Their Stripe account blocks it | Save our card in their portal and use **Charge our card with Richer Values**; see Step 8 |
| *"There is no card saved on the YS Capital account"* | Nobody has saved one in their portal yet | Save one; see Step 8. The payment link works meanwhile |
| *"Richer Values holds more than one card for YS Capital"* | PILOT will not choose between them | Set `RV_PAYMENT_SOURCE_ID` to the card you want charged |
| Nothing updates on an order | Webhook not set up | Fine — PILOT re-checks every 5 minutes anyway |
| A field is refused by name | Their validator rejected it | The message names the field; the order screen shows it |
