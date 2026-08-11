# TPO Pricing Layer — research + design

Owner-directed 2026-08-06. A wholesale/broker (TPO) pricing layer that sits **on top of** the
frozen pricing engines. It changes **no** retail number and **no** frozen engine formula — every
TPO code path is opt-in and inert-by-default, so a retail quote is byte-identical to before.

This is the RTL product's wholesale channel (`is_tpo`), never LT.

## What the owner asked for (5 pieces)

1. **A separate TPO pricing-controls section in the admin Pricing Center** — separate markups + origination
   fees for TPO, **defaulting to the same numbers as retail**, but adjustable independently per program
   (to cut origination or drop/raise markups for TPO). The TPO must NOT have access to it.
2. **A settings screen listing ALL TPO firms** where the admin sets, per firm, special pricing overrides
   that change that firm's term-sheet generator / products & pricing away from the TPO defaults.
3. **Every TPO firm can go into their own pricing settings** — they may NOT mark up the rate ("we generate
   the rate on their side"); the ONLY thing they can edit is **their own origination / broker fee** — they can
   raise or lower it. This broker fee is added **everywhere** origination shows on their products & pricing.
4. **Program → capital-provider auto-resolve** — on a TPO file, the capital provider (note buyer) for the
   registered program fills in automatically **in our backend, hidden from the broker**. Manual program is set
   by hand.
5. **Brokers have NO access to the Attorney Closing Prep.**

## What the research found (already true — build nothing)

- **Piece 5 (closing prep) already holds by construction.** Attorney Closing Prep lives entirely under
  `/api/staff` (`src/routes/staff.js`), whose router-wide `requireRole(...)` requires `kind==='staff'`
  (`src/auth/index.js`). A TPO session is `kind='tpo'` → hard 403. `/api/tpo` exposes no closing/attorney
  route, and no broker screen renders one. We only need a **regression test** pinning it.
- **Piece 4's mapping already exists.** `src/lib/tapes/program-provider.js` `PROVIDER_FOR_PROGRAM =
  { gold:'bluelake', standard:'fidelis', silver:'emcap' }` (Manual intentionally absent = admin-set). Today
  it is only a read-only data-tape consistency gate; it does **not** write `applications.lender`. Piece 4 is
  the small new step of **writing it onto a TPO file at registration** (staff-only, never surfaced to the
  broker). The note buyer is already scrubbed from every borrower/broker surface, so auto-setting it does not
  change who can see it.

## The one funnel every configurable price flows through

The entire configurable pricing surface funnels through:

- `quoteProgram(program, input)` — reads `cd = pricingSettings.current()` for **markup** (`cd.markupStdPct`
  etc.) and pushes it through the frozen `setMarkup`/`setMarkupTiers` hooks (reset in `finally`).
- `normalize(program, input, ev, ladder)` — reads `cd` for **origination** (`cd.origStdPct` etc.) and the flat
  fees, and computes `origination = totalLoan * origPct`.

`buildInputs` does **not** read `cd` (it reads sticky per-file `file_markup_*` values), so it is untouched.
`pricingSettings.current()` is a **synchronous**, 60s-cached read of the `company_pricing_settings` singleton.

So a parallel TPO layer only has to hand `quoteProgram`/`normalize` a **different `cd`** for a TPO file, plus
add one additive broker-fee line — nothing else moves.

## Design

### Precedence (owner's words)

```
frozen engine  →  retail company default  →  TPO channel default  →  that firm's override  →  broker fee
   (frozen)         (company_pricing_settings)   (tpo_pricing_settings)    (tpo_firm_pricing)      (origination only)
```

Every layer is **per field**: a TPO-channel or firm value overrides that one field; a NULL field falls through
to the layer above. So "default all the same" = leave the TPO fields NULL; "cut origination for Gold on TPO" =
set only `tpo_pricing_settings.orig_gold_pct`. The broker fee is the last layer and only ever adds to
**origination / closing costs**, never the rate.

### Storage (db/528)

- **`tpo_pricing_settings`** — the TPO-channel admin defaults. A one-row singleton (`id=1`), all pct columns
  **NULLABLE** (NULL = same as retail): `markup_{std,gold,silver}_pct`, `orig_{std,gold,silver}_pct`,
  `markup_tiers` jsonb. Written by the admin Pricing Center (piece 1), `manage_pricing`-gated.
- **`tpo_firm_pricing`** — per-firm overrides. PK `tpo_firm_id` → `tpo_firms(id)` ON DELETE CASCADE. Same
  NULLABLE pct columns + `markup_tiers`, **plus `broker_orig_pct`** (the firm's own origination/broker fee,
  points). The markup/orig override columns are written by the **admin** (piece 2, `platform_setup`); the
  **`broker_orig_pct` column is the only thing the firm-admin broker route writes** (piece 3), scoped to
  their own firm, never the rate.

Both mirror the established TPO single-row + audit pattern (`tpo_firm_credit_credentials`, db/527), not the
append-only company history — changes are audited to `audit_log`.

### Resolver — `src/lib/tpo-pricing.js` (new, non-frozen)

`effectiveSettingsFor(app)`:
- retail file (`!app.is_tpo`) → returns `pricingSettings.current()` unchanged (byte-identical).
- TPO file → `mergeSettings(retail, channelRow, firmRow)` = a `cd`-shaped object where each markup/orig field
  is retail's default unless the TPO channel or the firm overrode it, plus `brokerFeePct` (the firm's broker
  fee, or null).

Synchronous + 60s cached exactly like `pricingSettings.current()` (the hot quote path never awaits): the
channel singleton and a map of every firm's overrides are cached; `bust()` on save. `mergeSettings` is **pure**
(retail, channelRow, firmRow) for unit testing.

### Injection into the frozen `pricing.js` (additive, inert-by-default)

`quoteAll` / `safeQuote` / `quoteProgram` / `normalize` gain an optional trailing `opts` where `opts.settings`
is the resolved `cd`. Each `cd`-read becomes `const cd = (opts && opts.settings) || pricingSettings.current()`
— **absent `opts` → `current()` → byte-identical retail.** Only the TPO routes (`/api/tpo`) resolve settings
via `tpoPricing.effectiveSettingsFor(f.app)` and pass `opts.settings`; every retail caller passes nothing.

`normalize` adds a **broker fee** line, present ONLY when `cd.brokerFeePct > 0` (which only a resolved TPO
settings object carries — retail's `current()` never has it):
`brokerFee = round2(totalLoan * brokerFeePct/100)`, folded into `closingDueAtClose` (so it cascades into
cash-to-close + liquidity, a real borrower closing cost). The `closingCosts.brokerFee` / top-level `brokerFee`
keys are added **only when > 0**, so the retail quote object is byte-identical.

This is the same authorized pattern as the per-tier markup overlay (`setMarkupTiers`, 2026-08-04): a new
default-inert layer that consumes engine output and changes no frozen number. Proven by a runtime-equivalence
battery (retail byte-identical) and re-frozen in `CLAUDE.md`.

### Why no leak

- The broker fee is the BROKER's own fee — fine for the broker to see (they set it). Origination itself is
  already a **disclosed borrower cost** (it prints on every term sheet), so the broker seeing our TPO-channel
  origination is not a new leak — the borrower sees it too. What stays secret is the **rate markup / YSP**
  (`adminPricing`, `markup*`), which `stripQuoteInternal`/`stripInputsInternal` already remove for every
  borrower/broker surface, and which a broker can never set (the `borrowerPricingOverrides` allowlist carries
  no markup/origination key).
- The TPO-channel and per-firm settings are written through admin routes gated on `manage_pricing` /
  `platform_setup` — a `kind='tpo'` actor holds no capability, so it can never reach them. The broker route is
  `is_firm_admin` + firm-scoped and accepts **only** `broker_orig_pct`.

## Build order (each through the two-audit gate)

1. **Foundation** — db/528 + `tpo-pricing.js` resolver + `pricing.js` threading + tests (this pass).
2. **Piece 1** — TPO section in `admin-pricing.js` + `StaffCompanyPricing.jsx`.
3. **Piece 2** — per-firm overrides in `admin-tpo.js` + `StaffTpoFirms.jsx`.
4. **Piece 3** — broker self-service `broker_orig_pct` route in `tpo.js` + broker UI + the term-sheet display
   line (`termsheet.js`, additive) + studio seeding.
5. **Piece 4** — program→provider auto-set on TPO register (`tpo.js`), staff-only.
6. **Piece 5** — regression test pinning closing-prep broker-inaccessibility.
