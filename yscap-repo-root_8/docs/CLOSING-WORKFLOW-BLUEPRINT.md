# Closing Workflow — Blueprint (owner-directed 2026-07-26)

The major closing → funding → post-closing operation for PILOT. Loan officers submit
a scheduled file to a **Closer**; the closer runs a dedicated **Closing workspace**,
confirms funds, funds off a **warehouse line**, ships collateral, **reconciles** the
funded date across our system + Encompass + ClickUp, signs off **TPR** and **investor
delivery**, and hands the file to **purchasing / post-closing**.

This builds ON the existing workflow scaffold (`db/212_workflow.sql`, `src/lib/workflow.js`,
`SubmitFilePanel.jsx`) — the `closer` role, `closer_id` pointer, `closing_workflow`
stage machine (`estimated → ready_for_docs → wire_sent → fully_closed → fully_reconciled`),
and the `POST /applications/:id/closing-workflow` stage door already exist. We do NOT
re-invent them; we add the closer's actual working surface and the money/reconciliation gates.

## Industry grounding (why the shape is what it is)

Correspondent / business-purpose closing operates: clear-to-close (lender + **investor CTC**)
→ schedule closing (confirmed with all parties) → settlement agent issues the **ALTA / final
HUD** with the **final cash to close** → verify funds → **fund off a warehouse line** (the note
is pledged as collateral, shipped to the warehouse bank) → post-closing **reconciliation** and QC
→ **TPR** (third-party review for non-QM) → **investor delivery** → the investor **purchases** the
loan (repaying the warehouse advance). The tracking number the closer records is the FIRST leg —
**collateral → our warehouse bank**, not warehouse → investor.

## Roles & permissions

- `closer` role already exists (`permissions.js`). Default holder **Malky Katz**
  (`Malky@yscapgroup.com`, currently role `processor`, title "Closer & Funder Manager") —
  a migration flips her role to `closer`. "Closer on file" = `applications.closer_id`
  (set automatically to the default closer on submit-to-closing; switch it later to route
  to a different closer's workflow — no code change).
- New capability **`manage_closings`** (permissions.js only, no migration): the closer-only
  actions (warehouse, collateral tracking, actual cash-to-close, HUD sign-off, TPR / investor-
  delivery sign-off, reconcile, purchasing hand-off). Added to `closer` + `admin` defaults;
  `super_admin` implicitly. Team screen picks it up automatically.
- **Everybody on the file** (LO / processor / underwriter) can update the shared fields:
  investor-CTC'd, closing-date-confirmed-with-all-parties, and notes. That is the officer's
  "closing workflow" — they open the same Closing section and keep those fields current.

## Data model (migration `315_closing_workflow.sql`, idempotent + backfilled)

- `applications.funded_date date` — our system's authoritative funded date (the designed-but-
  unbuilt column from `docs/ENCOMPASS-DATA-MAPPING.md`). Read into the Encompass reconciler.
- `closing_workflow` gains: `investor_ctc` (+`_at`/`_by`), `closing_date_confirmed` (+`_at`/`_by`),
  `warehouse`, `collateral_tracking_number`, `collateral_tracking_carrier`,
  `actual_cash_to_close`, `actual_cash_to_close_doc_id`, `liquidity_ok`, `liquidity_shortfall`,
  `liquidity_checked_at`, `tpr_required`, `tpr_uploaded_at/_by`, `tpr_signed_off_at/_by`,
  `investor_delivery_signed_off_at/_by`, `reconciled_ok`, `purchasing_at`.
- `closing_workflow.stage` CHECK widened with `in_purchasing` (after `fully_reconciled`) →
  ClickUp internal status `in purchase review` (external `funded`).
- `closing_notes` — threaded notes on a file's closing (anyone on the file can add).
- `closing_checklists` + `closing_checklist_items` — closer-built checklists (custom or per
  capital provider). `closing_checklist_templates` — reusable per-provider templates the closer
  instantiates onto a file. A starter "General closing checklist" template is seeded.
- Closing document conditions (checklist_templates, attached on submit-to-closing + backfilled):
  `closing_hud_final` (balanced final HUD / ALTA), `closing_pkg_signed` (closed loan package /
  signed docs), `closing_tracking_label` (collateral shipping label). Category `at_closing` /
  `post_closing` so they block funding but never CTC; audience staff; role_scope closer.

## The money gate — actual cash-to-close vs verified liquidity + reserves

Today only the ESTIMATE cash-to-close is checked. At closing the closer enters the **actual**
cash-to-close off the ALTA. We verify (reusing frozen numbers only, never re-derived):

```
verified_liquidity (assessBankLiquidity().qualifyingTotal, bank statements)
   >=  actual_cash_to_close (ALTA)  +  reserveRequirement (rtl_p3_assets tool_payload.liquidity)
```

If short → a **fatal** alert in the closing workspace (mirrors `assets-autoclear.js`'s
`qualifyingTotal >= required - 1` with the $1 tolerance + `haveCountableTied` data-gap guard,
but blocking/fatal). Reserve stays the frozen engine number; only the cash-to-close term swaps
estimate → actual.

## The reconciliation gate — 3-system funded-date match

Before `fully_reconciled` may be set, all three must be present AND equal (calendar-string
`YYYY-MM-DD`, null-safe `agree()` primitive from `system-reconciliation.js`):

- **our system** — `applications.funded_date`
- **ClickUp** — `applications.actual_closing` (pull from field `0846edc7…`)
- **Encompass** — field `1401` Funded Date (read from `applications.encompass_extra` via the
  read-only field map; a new advisory `pull()` registry entry — Encompass stays READ-ONLY).

A missing or disagreeing value blocks the reconcile with a plain-language reason
("ClickUp closing date not set yet", "Encompass funded date 07/10 ≠ ours 07/11"). Nothing is
auto-written to any system — the closer fixes the source and re-checks.

## The closer's Closing workspace (V2 `ClosingPanel.jsx`, `sec-closing`)

The closer lands here on opening a file (role-default `goToSection('sec-closing')` + deep-link
`#sec-closing`; closer login lands on `/internal/closing`). Contents:

1. **Deal details** — borrower, address, investor (note buyer, staff-only), loan coordinator,
   program, original purchase price, assignment amount, loan structure, rehab budget, financed
   interest reserve, effective/recognized price — read-only, with a direct link to the file.
2. **Money** — estimated cash-to-close + reserve requirement, the closer's **actual
   cash-to-close** input, and the **full verified-liquidity table** (every counted account:
   holder / bank / last-4 / ending balance) with **direct "open" links to the bank-statement
   documents**. Fatal alert if the actual won't cover.
3. **Document quick-links** — one-click open for insurance, purchase contract, assignment of
   contract, LLC docs, bank statements, title, plus "all documents".
4. **Closing conditions** — upload the balanced final HUD / ALTA, the closed loan package, and
   the collateral shipping label (each a real condition with the existing upload/download flow;
   HUD AI structural check is a future hook).
5. **Funding** — warehouse dropdown (Stride, Bank of the Sierra, Banc of California, Northpointe,
   Fidelis, CorrFirst), collateral tracking number (labeled "collateral → our warehouse"),
   funded date.
6. **Checklists** — closer-built custom + per-capital-provider checklists with check-off.
7. **Sign-offs** — investor-CTC'd + closing-date-confirmed (shared), TPR uploaded/signed-off,
   investor-delivery signed-off; and the reconcile button (gated by the 3-system match).
8. **Notes** — threaded, anyone on the file.

Stage flow driven by the existing closing stage door: submit → `estimated`; ready for docs /
wire sent → `ready_for_docs`/`wire_sent`; closed → `fully_closed` (→ `funded`); reconciled →
`fully_reconciled` (gated); investor delivery + reconciled → `in_purchasing` (→ post-closer,
built next).

## Endpoints (all `src/routes/staff.js`, business logic in `src/lib/closing.js`)

- `GET  /applications/:id/closing` — the whole workspace payload.
- `PATCH /applications/:id/closing` — shared fields (any file staff) + closer-only fields
  (`manage_closings`).
- `POST /applications/:id/closing/notes` — add a note.
- `POST /applications/:id/closing/cash-to-close` — set actual CTC, run the money gate.
- `POST /applications/:id/closing/checklists` (+ `/:cid/items`, `PATCH /closing/checklist-items/:iid`).
- `POST /applications/:id/closing/sign-off` — `{ kind: 'tpr' | 'investor_delivery' }`.
- `POST /applications/:id/closing-workflow` — existing stage door, now with the `manage_closings`
  gate + reconciliation guard on `fully_reconciled` and investor-delivery guard on `in_purchasing`.

## Guardrails honored

- No frozen pricing/guideline number is touched — reserves and liquidity are reused as computed.
- Encompass stays strictly READ-ONLY (advisory pull entry only).
- Status only ever moves through the shared doors (`applyInternalStatus` / stage door).
- ClickUp date writes (if any) go through `dateOnlyToClickUpEpoch`; dates are `YYYY-MM-DD` strings.
- Note-buyer / capital-partner names stay on staff surfaces only.
- Previous AND future: every schema add ships an idempotent backfill onto open files.
- Two-audit-agent gate on every change; pure + DB tests wired into `npm test`.
