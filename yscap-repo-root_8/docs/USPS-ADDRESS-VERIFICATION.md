# USPS address verification & autocomplete — buying + setup guide

**Goal:** every address in PILOT is exactly how the U.S. Postal Service spells it —
the official, deliverable mailing address — because the note buyers and closing
agents require the USPS-correct address on every file.

This guide is written to be handed to a non-developer. It covers **what to buy from
USPS, how to buy it, and what happens automatically once it's turned on.**

---

## 1. The short version

- PILOT already has the official **USPS address checker built in** — it just needs
  two keys (a username + password from USPS) to turn on. Nothing to build.
- The address box on every form works in two steps: as you type, a suggestion list
  appears (Google / OpenStreetMap); when you pick one, **USPS confirms and fixes it**
  to the exact official mailing address, and shows a small green **"USPS verified"**.
- Once it's on, PILOT can also go back and stamp **every existing file** with its
  USPS-correct address.
- **What you buy from USPS:** a free developer account to get the keys, and — because
  USPS changed its rules in 2026 — a signed license and a small monthly plan (starts
  around **$10/month**) so it keeps working at real volume. Steps are in section 4.

---

## 2. What changed at USPS in 2026 (why this matters now)

USPS retired its old address system and replaced it with a modern one. Two dates
matter:

- **January 25, 2026** — the old "Web Tools" address API was **shut off**. Any system
  still on it stopped working. (PILOT is built on the *new* system, so we're fine.)
- **Around August 1, 2026** (originally announced July 12) — the new **Enhanced
  Addresses API** takes over. To use it you must **sign a USPS license agreement and
  pick a paid plan**. A free developer key still exists for light use, but it's capped
  at **60 address checks per hour** (one a minute), which is too slow for a busy
  pipeline. Businesses that sign the license and pick a plan keep running without
  interruption.

**Bottom line:** to have the "highest level, most up-to-date USPS" — the one the note
buyers expect — you sign the USPS Addressing API license and choose a paid plan. It's
inexpensive.

---

## 3. What you're actually buying (plain terms)

| Thing | What it is | Cost |
|---|---|---|
| **USPS developer account** | A free login at developer.usps.com that gives you the two keys PILOT needs. | Free |
| **Addresses API** | The official service that confirms/corrects an address. This is the "USPS address verification" you asked for. | Free tier = 60/hr. Paid plan for real volume. |
| **Addressing API License Agreement** | A one-time USPS form you sign to use the modern (Enhanced) address service from Aug 2026 on. | Free to sign |
| **A paid tier** | A monthly plan sized by how many address checks you do per month. | **Starts ~$10/month**; USPS gives the exact tiers when you sign. |

There is **no separate "autocomplete" product to buy from USPS** — USPS doesn't sell
the "suggest as you type" list. That part is handled by the autocomplete provider
(free OpenStreetMap by default, or Google if you want the nicest suggestions), and
then **USPS is what makes the final address official.** This is the standard, correct
way every big loan-origination system does it.

---

## 4. How to buy it from USPS — step by step

Do these once. Steps 1–4 get you running on the free tier immediately; steps 5–6 put
you on the paid Enhanced plan the note buyers expect.

1. **Create a USPS Business Account.**
   Go to **https://www.usps.com/business/** and register a business account for YS
   Capital. This gives you a business ID (USPS calls it a **CRID**). Use a company
   email you control (e.g. an admin@ address), not a personal one.

2. **Go to the USPS Developer Portal and sign in.**
   Open **https://developer.usps.com** and sign in with the business account from
   step 1.

3. **Create an "app" and subscribe it to the Addresses API.**
   In the portal, create a new application (any name, e.g. "PILOT"), and add/subscribe
   the **Addresses** API to it. The portal then shows you two values:
   - a **Consumer Key** → this is your `USPS_CLIENT_ID`
   - a **Consumer Secret** → this is your `USPS_CLIENT_SECRET`

   Keep these private. Send them to whoever manages PILOT's settings (they go into
   Render, never into the code). **Do not paste them into chat or email in the clear.**

4. **(Optional, works immediately) Try the free tier.**
   With just those two keys added to PILOT, USPS verification turns on right away — but
   at the free rate of 60 checks/hour. Fine for testing; too slow for a busy day.

5. **Sign the Addressing API License Agreement (for the Enhanced service).**
   From August 2026 the modern Enhanced Addresses service requires a signed license.
   Get it from USPS's PostalPro site (**https://postalpro.usps.com/Addressing_API_License**)
   or ask USPS API Support for it directly. Complete and return it.

6. **Pick a paid tier.**
   When you sign, USPS assigns your plan based on how many address checks per month you
   expect. It starts around **$10/month** for low volume and steps up from there. Tell
   USPS your rough monthly volume (see the estimate below) and they'll place you on the
   right tier. After you're on a paid tier, tell whoever manages PILOT to set
   `USPS_MAX_PER_HOUR=0` (removes the free-tier brake).

**Who to contact at USPS if you get stuck:** the Developer Portal has a support link
and USPS runs daily "Web Tools to USPS APIs" webinars; email address for API support is
listed on developer.usps.com. Ask specifically for the **"Addresses API license and
pricing tiers."**

**Volume estimate for choosing a tier:** count roughly how many *new addresses* you
enter per month (new files + borrower home addresses) and add a one-time bump for the
existing-files backfill (section 7). PILOT caches every result, so re-checking the same
address is free and doesn't count again. Most brokerages your size land in the lowest
one or two tiers.

---

## 5. What happens automatically once it's on

Nothing to click. The moment the two keys are set, PILOT starts using USPS everywhere
an address is entered:

- **On every address box** (loan application on the marketing site, borrower portal,
  staff file screens, all the tools): you type → pick a suggestion → **USPS confirms
  and, if needed, fixes it** to the exact official mailing address, and shows a small
  **"USPS verified"** (green) or, if USPS fixed something, **"USPS verified — corrected
  to the official mailing address."** If USPS can't confirm an address, it says so and
  keeps what you typed so the form never gets stuck.
- **The address is stored USPS-correct**, so the file, ClickUp card, term sheet and
  every downstream system carry the official version.
- **API Health page** shows a live "USPS — official address verification is active"
  indicator so you can confirm it's working.

---

## 6. Turning it on (for whoever manages PILOT's settings)

Set these in Render (Environment), then redeploy:

```
USPS_CLIENT_ID=<Consumer Key from the USPS portal>
USPS_CLIENT_SECRET=<Consumer Secret from the USPS portal>
# Leave as-is unless USPS gives you a different host:
USPS_API_BASE=https://apis.usps.com
# Free-tier brake (defaults to 55 if unset). Keep ~55 while on the free tier so a
# traffic burst can't burn the 60/hour quota; set 0 once on a paid tier:
USPS_MAX_PER_HOUR=55
```

That's all that's required for live verification on new addresses.

**Note on high traffic:** the address-verify endpoint is public (it also powers the
marketing loan application). It's protected by a per-visitor request limit and the
hourly brake above, and every result is cached so repeats are free. If you ever run
PILOT on more than one server instance at once, the hourly brake counts per instance,
so on the free tier either run a single instance or lower `USPS_MAX_PER_HOUR`.

---

## 7. Fixing the addresses on EXISTING files (the backfill)

To make *every* file already in the system carry its USPS-correct address (not just
new ones), turn on the backfill. It's **non-destructive** — it stamps each file with
the USPS-correct address in a separate field and never overwrites the working address,
so nothing about pricing or underwriting can shift underneath you.

```
USPS_BACKFILL_ENABLED=1
USPS_BACKFILL_PER_TICK=40      # address checks per pass — keep at/under your hourly plan
USPS_BACKFILL_EVERY_MIN=60     # run a pass every hour
```

It paces itself so it never blows past your USPS plan's limit, and it's resumable — it
works through the backlog over time and stops touching a file once it's been checked.
Run this **after** you're on a paid tier (the free 60/hour is too slow for a bulk pass).

---

## 8. The autocomplete "suggest as you type" (optional upgrade)

USPS confirms addresses but doesn't provide the typeahead suggestion list. PILOT's list
comes from a provider, auto-selected:

- **OpenStreetMap** (default, free, no key) — works out of the box.
- **Google Places** (nicest suggestions) — set `GOOGLE_PLACES_API_KEY`. Recommended if
  you want the smoothest "as you type" experience; USPS still makes the final address
  official.
- **Smarty** — set `SMARTY_AUTH_ID` / `SMARTY_AUTH_TOKEN`. Smarty is itself a
  CASS-certified USPS data vendor, an alternative if you'd rather one paid vendor do
  both suggestions and USPS-grade verification.

Whichever you use, **USPS is the authority on the final stored address.**

---

## 9. How it's built (for a developer)

- `src/lib/integrations/usps.js` — the raw USPS Addresses API v3 client (OAuth2
  client-credentials against `apis.usps.com`; `/oauth2/v3/token` + `/addresses/v3/address`).
  Returns the standardized address + deliverability (DPV) indicators.
- `src/lib/usps-verify.js` — the standardizer service: maps USPS output to PILOT's
  canonical address shape, classifies it (verified / corrected / unverified), and caches
  every lookup in `usps_address_verifications` so re-checks are free. Never throws.
- `src/routes/address.js` — `POST /api/address/verify` (and `GET`): the endpoint the
  forms call after a pick. Accepts discrete components or a one-line string (`q`).
  Degrades gracefully when USPS isn't configured.
- `app-v2/src/components/AddressAutocomplete.jsx` (the shared React address box, used by
  the loan application, borrower profile and staff new-file screens), the vanilla
  `web/(v2/)tools/address-autocomplete.js` (marketing loan application, term sheet,
  track record) and the Scope-of-Work tool's own field in `web/(v2/)tools/rehab-budget.js`
  — all verify with USPS after a pick and show the status badge.
- `src/lib/address-usps-verify.js` — the paced, non-destructive backfill for existing
  files (`applications.usps_address` / `usps_match` / `usps_verified_at`, added in
  `db/343`). Booted from `src/server.js`, gated by `USPS_BACKFILL_ENABLED`.
- Config: `src/config.js` `cfg.usps`. Tests: `scripts/test-usps-verify.js` (in `npm test`).

Nothing here touches the frozen pricing/guideline engines.

---

## Sources (verified July 2026)

- USPS Developer Portal — API catalog & Addresses API: https://developers.usps.com/apis
- USPS Web Tools → USPS APIs migration (retirement Jan 25, 2026): https://www.usps.com/business/web-tools-apis/
- USPS industry alert, retirement of API v1/v2: https://developers.usps.com/industry-alert-api-retirement
- USPS Addressing API License Agreement (PostalPro): https://postalpro.usps.com/Addressing_API_License
- Enhanced Addresses API license + tier fees, effective July 12 → Aug 1, 2026: https://postalup.com/apis/usps-address-api-pricing
- USPS API rate limits (60/hour default): https://www.smarty.com/blog/usps-api-rate-limit
