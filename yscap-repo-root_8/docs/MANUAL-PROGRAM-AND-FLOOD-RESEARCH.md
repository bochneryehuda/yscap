# Manual Program + program-scoped flood certificate

Owner-directed 2026-07-20. Two linked changes to how a product is registered and
how the flood certificate condition is required.

## 1. Flood certificate is program-scoped

**Intent.** The flood-determination certificate (life-of-loan FEMA flood-zone
determination) was previously required on *every* RTL file (db/177). The owner
wants it required only when it actually matters:

- the **Gold** program → always required;
- the new **Manual** program → always required;
- **any** program (including **Standard**) when a **flood zone is known** — the
  appraisal / appraisal XML findings place the property in a FEMA Special Flood
  Hazard Area (an A* or V* zone);
- a plain **Standard** file that is **not** in a known flood zone → **not**
  required (no flood condition populated).

**How.** The `rtl_cond_flood` checklist template is converted from an
unconditional legacy template to a **rule-driven Condition Center template**
(`auto_apply='rules'`), gated on:

```
registered_program IN (gold, manual)  OR  in_flood_zone = true
```

- `registered_program` gains a `manual` option (`field-registry.js`).
- `in_flood_zone` is a new boolean rule field derived in
  `engine.loadRuleContext` from the current appraisal (`fema_flood_sfha`, or the
  FEMA/appraiser zone starting with A/V).
- The appraisal FEMA cross-check (`appraisal/desk.js`) re-runs the Condition
  Center after storing its result, so a newly-found flood zone attaches the cert
  immediately.
- `db/207` re-asserts the rule and **deletes the untouched** flood items db/177
  put on Standard/no-flood files (untouched = still outstanding, no upload, no
  sign-off/review, no notes). The engine attaches/retracts it going forward
  (`origin_kind='auto'`, retract-only-if-clean).

Note: db/177 still runs every boot and re-adds a flood item to any file missing
it; db/207 runs *after* it (higher number) and re-removes the ones that should
not carry it, so the post-boot state is deterministic and correct. The re-add /
re-remove only ever touches *untouched* items, so no work is lost.

## 2. Manual Program (custom LTV/LTC/ARV)

**Intent.** Manually moving the margin/markup, points, or fees is *manual
pricing* — still a Standard/Gold product. But overriding the deal **structure**
(acquisition LTV, after-repair LTV, or LTC) is a different product: it should no
longer be bound to Standard/Gold. It becomes a **Manual Program**:

- priced on the **Standard (Fidelis) guideline engine** — asset requirements and
  everything other than the overridden LTV/LTC/ARV follow the Standard program;
- the registrant must state **how many months of assets/liquidity** the file
  must show (there is no fixed reserve table for a manual product);
- it **always requires the flood certificate** (rule above);
- every manual product goes to a **super-admin escalation** for approval — the
  file registers immediately but the product is *pending approval*;
- you **cannot** register a structural override under Standard/Gold — the program
  is forced to `manual`.

**Detection** (`src/lib/manual-program.js`). `STRUCTURAL_OVERRIDE_KEYS` =
`ovrAcqLTV(Pct)`, `ovrARLTV(Pct)`, `ovrLTC(Pct)`. `isManualProduct(overrides)` is
true when any is *meaningfully engaged* (a real, non-zero value). Rate
(`ovrRatePct`), interest-reserve months, markup/points/fees, and the assignment
effective-price exception (`ovrEffPrice`, which has its own approval clamp) are
pricing, not structure — they never flip to manual. `resolveProgram` forces
`manual` on a structural override, keeps the requested program otherwise.

**Pricing** (`src/lib/pricing.js`). `quoteProgram('manual', input)` runs the same
frozen **Standard** engine (`YSP`) with the manual leverage carried on `input`;
`normalize()` and the markup/origination/reserve helpers already treat any
non-`gold` program as Standard, so only the program TAG + label differ. **No
engine math is changed.** `PROGRAM_LABEL.manual = 'Manual Program'`.

**Registration** (`src/routes/staff.js`). Structural override keys are already
admin-only, so only an admin/super-admin can create a manual product. On
register: resolve program → if `manual`, require `assetMonths` (1–24, else 422
`manual_asset_months_required`); force-price; persist with `is_manual` +
`asset_months`; open a `manual_program_escalations` row **in the same
transaction** (a prior pending row for the file is superseded — one pending per
file). Borrowers can never create a manual product (their override set is clamped
to safe knobs and their register path forces Standard/Gold).

**Liquidity** (`src/lib/liquidity.js`). The bank-statement / assets condition
month count for a manual product comes from the registration's `asset_months`
(Gold=2, Standard=1 unchanged).

## 3. Escalation workflow + admin config

- `manual_program_escalations` (db/207): one row per manual registration;
  `pending | approved | declined`; carries the leverage overrides + a summary +
  the stated asset months. Partial-unique index: one `pending` per file.
- `manual_program_settings` (db/207): company-level Manual Program config —
  advisory LTV/LTC/ARV ceilings + the **required** default asset months. Seeded
  with 2 months. Append-only history mirroring `company_pricing_settings`.
- Routes (`src/routes/admin-manual-programs.js`, mounted `/api/admin/manual-programs`):
  - `GET/PUT /settings` — `manage_pricing`.
  - `GET /escalations` + `GET /escalations/count` — any staff (admins/super-admins
    see the box; `canDecide` = super-admin).
  - `POST /escalations/:id/decide` — **super-admin only**.
- Frontend (`app-v2`): `StaffEscalations.jsx` screen at `/internal/escalations`
  (config panel + escalation box), nav link + pending badge in `StaffLayout.jsx`,
  and the asset-months field + manual/escalation state in `ProductStudioPanel.jsx`.

## Tests

`scripts/test-manual-program.js` (in `npm test`): manual detection vs pricing,
`resolveProgram`, the Standard-engine manual quote, the flood rule for
standard/gold/manual/flood-zone, liquidity months, and DB-backed flood
attach/retract + escalation round-trip + settings validation.
