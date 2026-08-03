<!--
  Two products live in this repo and they never mix: RTL (Residential Transition Loans — bridge,
  ground-up, fix & flip) and LT (Long-Term Loans). Full rules: .github/PRODUCT-SEPARATION.md
-->

## Which product is this for?

<!-- Tick exactly one. If you cannot tick one with certainty, STOP and ask the owner before opening this PR. -->

- [ ] **RTL** — Residential Transition Loans (bridge / ground-up / fix & flip)
- [ ] **LT** — Long-Term Loans
- [ ] **Neither / shared plumbing** (build, CI, docs, infra) — explain below why it is genuinely neither

## What changed and why

<!-- Plain language: what the owner asked for, what this does, what it means for the business. -->

## Product-separation checklist (required)

- [ ] I did **not assume** which product this belongs to — it was stated by the owner, or I asked and got an answer.
- [ ] Nothing was copied, moved, re-used, imported, or generalized **from one product to the other**. If anything
      was, the owner's **written authorization** is recorded in `yscap-repo-root_8/docs/LONG-TERM-AUTHORIZED-COPIES.md`
      and linked here.
- [ ] **LT changes stay inside** `src/longterm/**`, `/api/lt/*`, `lt_*` tables, `db/NNN_lt_*.sql`, `scripts/test-lt-*.js`.
- [ ] **No RTL table, trigger, mapping, enum, or checklist template was changed to make LT work** (no new column on
      `applications`, no new ClickUp/Encompass/SharePoint/DocuSign/Sitewire/Trustpoint wiring for LT).
- [ ] No `lt_*` table references an RTL table, and no migration touches both sides.
- [ ] No conditions, document underwriting, or orders were added to LT (explicitly out of scope for now).
- [ ] Any place both products appear together is **front-end read-only**, with a visible product stamp and a
      Both / RTL only / Long-Term only filter.
- [ ] `npm test` passes, including `scripts/check-product-separation.js`.

## Verification

<!-- What you actually ran / clicked, and what you saw. Not "should work". -->

## Audits (required by CLAUDE.md)

- [ ] Pre-merge audit run and clean
- [ ] Post-merge audit planned/run
