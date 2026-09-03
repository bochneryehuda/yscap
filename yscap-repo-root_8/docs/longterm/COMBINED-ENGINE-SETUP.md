# Combined Pricing Engine — what to enter, and where

Plain-language setup for the second pricing engine (Lender Price + LoanNEX on one
board). Written for the person doing the setup, not for a developer.

---

## 1. What this is

Two new screens, for **super admins only**. Everybody else does not see them in
the menu and gets a "not found" if they try the address directly.

| Screen | Where it lives | What it is |
|---|---|---|
| **Combined Pricing Engine** | `/internal/lt/combined` | The same pricing board you already know, priced on **both** programs at once |
| **Combined Pricing Engine settings** | `/internal/lt/combined-settings` | Every investor, one row: the name a client may see, which program its pricing comes from, whether it shows at all — plus every other Long-term setting |

The **General Pricing Engine** (`/internal/lt/pricer`) is untouched and is still
the one the company prices on.

---

## 2. Where you enter these

**Render dashboard → the PILOT service → Environment → Add environment variable.**
Add them, then **Save**, which restarts the service. Nothing here goes in the
code, and nothing here is ever committed.

---

## 3. The only two you actually have to enter

| Name | What to put in it |
|---|---|
| `NEX_USERNAME` | The LoanNEX portal login (the e-mail address) |
| `NEX_PASSWORD` | That login's password |

That is the whole connection. PILOT signs in to LoanNEX with those, the same way
a person does in a browser, and everything else has a sensible default.

> ### ⚠️ Rotate the password first
> The password that was in the original screen recording is **compromised** and
> must be changed at LoanNEX before it is used here. Change it there, then enter
> the **new** one. Nothing in PILOT's code contains it.

**Lender Price** needs nothing new — the General Pricing Engine already runs on
it, so those settings (`LP_USERNAME`, `LP_PASSWORD`, and the rest) are already in
Render and the combined engine reuses them as they are.

---

## 4. Optional — only if you want them

| Name | Default if you leave it out | What it does |
|---|---|---|
| `LT_COMBINED_PRICING` | on | The **off switch**. Set it to `off` and both new screens answer "not found". The General Pricing Engine is not affected either way. |
| `NEX_PORTAL` | `web` | `web` is the **aggregator** — it prices every investor in one go, which is what you want. Only change it if you deliberately want one investor's own portal (`acracorrespondent`, `nqmfcorr`), which returns that investor alone. |
| `NEX_TOKEN_KEY` | — | A stop-gap only. If the sign-in is ever unavailable you can paste a one-time ticket out of a live LoanNEX browser session instead. It is short-lived and single-use, so it is not a way to set this up permanently. |
| `NEX_DIAG_TOKEN` | — | A secret word that lets us check the two-program pipeline from the server without signing in. Leave it out and that check is switched off entirely. |
| `NEX_TIMEOUT_MS` | `30000` | How long to wait for LoanNEX before giving up (30 seconds). |
| `LT_PRICE_SEAL_KEY` | works it out from `JWT_SECRET` | A private word only the server knows. It locks away one number the rate sheet needs but nobody outside should ever see. **You do not have to set it** — with `JWT_SECRET` already set, the server works one out and everything keeps working across restarts. Set it only if you want that lock to be its own separate word. If you change it, anyone with a price list open on screen will have to search again to see a breakdown; nothing else is affected. |

**Leave these alone** — they already point at the right place:
`NEX_API_BASE`, `NEX_WEBAPP_ORIGIN`.

---

## 5. How to check it worked

1. Sign in as a **super admin**.
2. The menu shows **Combined Pricing Engine** and **Combined Pricing Engine settings**.
3. Open the settings screen. If the investor list loads, LoanNEX answered.
4. Open the pricing screen and price a real scenario. You should see investors
   from both programs on one board.

If something is not set up, the screen **says so in words** — it never shows a
short board as though it were the whole market.

---

## 6. What to do first, on the settings screen

1. **Name a client-safe label for every investor.** The investor's real name may
   never reach a client. Investors with no client-safe name yet are listed at the
   top and flagged — nothing is made up for them, and nothing will be.
2. **Check where each investor is priced from.** Each row lets you choose Lender
   Price or LoanNEX. Some are pre-filled; you can change any of them.
3. **Check the margin holdback.** 0.25 points is held back on every LoanNEX quote
   so the two programs are compared on the same footing. You can raise it, lower
   it, or set it to 0 to remove it.
4. **Link investors that are spelled differently.** Where the two programs spell
   one investor differently, link them so the board treats them as one.

---

## 7. Still open — worth knowing

1. **Whether 0.25 is the right holdback is your number, not a measurement.**
   Nobody has yet priced one scenario on both programs against live Lender Price
   credentials to confirm it.
2. **4 of the 9 live LoanNEX investor names are joined by a best-guess match.**
   They look right today; the settings screen marks them "confirm this", and
   confirming one is a click.
3. **One investor returns no fee breakdown at all.** It may be a permission on
   our LoanNEX account, or that investor may simply not publish one.
