# PILOT has TWO products. They are TWO systems. They never mix.

**Owner-directed, 2026-08-02. Strict, hard rule, no exceptions.** This file is the GitHub-side copy of the law
that also lives in `yscap-repo-root_8/CLAUDE.md` ("TWO PRODUCTS, TWO SYSTEMS") and in `AGENTS.md` at the git root.
If the three ever disagree, `CLAUDE.md` wins and the others must be corrected to match.

| | **RTL** | **LT** |
|---|---|---|
| Full name | Residential Transition Loans | Long-Term Loans |
| What it covers | Bridge, ground-up construction, fix & flip | Long-term / stabilized lending |
| Status | **The main product.** Everything built before 2026-08-02 | **Brand new, starts at zero.** Side build, **not live**, no borrowers, no production traffic |
| Where it lives | Everywhere else in the repo | `src/longterm/**`, `/api/lt/*`, `lt_*` tables, `db/NNN_lt_*.sql`, `scripts/test-lt-*.js` |

Think of them as **two different companies' software that happen to share one repository** — the owner's own
comparison: *"if I'm telling you to build something you don't know if you should build this for Amazon or for
eBay — you ask."*

## The eight rules

1. **Never assume which side a request is for.** Not stated, or not 100% obvious? **Stop and ask.** Never guess,
   never "do both to be safe," never pick the likelier one.
2. **Nothing crosses without the owner's explicit written authorization, per item.** No copying, moving, re-using,
   importing, extending, generalizing or "sharing" of code, tables, columns, migrations, conditions, templates,
   endpoints, screens, components, prompts, mappings or integrations — in either direction. Wanting to re-use
   something is fine and expected: **ask, get it in writing, record it in
   `yscap-repo-root_8/docs/LONG-TERM-AUTHORIZED-COPIES.md`, then build.** Authorization is per item, never blanket.
3. **The back end is separate, always.** LT code only in `src/longterm/**`; LT HTTP only under `/api/lt/*`; LT tables
   only named `lt_*`; LT schema only in its own `db/NNN_lt_*.sql` files; LT tests only `scripts/test-lt-*.js`.
   No LT table may reference an RTL table. No trigger crosses. No shared writer, service module, queue row, or
   condition/checklist template. The **only** permitted seam in the back end is `src/server.js` mounting the LT router.
4. **Do not touch RTL in order to build LT.** No new column on `applications` or any RTL table, no new ClickUp
   mapping, no new Encompass / SharePoint / DocuSign / Sitewire / Trustpoint wiring, no new checklist template,
   no new enum value — unless the owner asked for **that exact thing**.
5. **LT is explicitly NOT getting, for now: conditions, document underwriting, orders.** Don't build them, don't
   stub them, don't "leave room" for them by copying RTL shapes.
6. **The front end may show both; the back end may not.** One pipeline may list both, with filters
   (Both / RTL only / Long-Term only) and a **visible product stamp** on every row and every file header. The merge
   happens in the read/view layer only — never a SQL join, a shared table, or a shared write path.
7. **A feature built for one side never automatically applies to the other.** "Every fix is all-sides" means every
   surface of *that* product. It never reaches across.
8. **When in doubt, ask. Silence is never permission.**

## How this is enforced

| Where | What |
|---|---|
| CI (`npm test` → `scripts/check-product-separation.js`) | Blocks a PR and the auto-deploy on any crossing: an LT module importing RTL code, RTL importing LT, an `lt_*` table with a foreign key to an RTL table, an LT-named column added to an RTL table, or a migration that touches both sides. |
| Pull requests | `.github/pull_request_template.md` — the "which product" answer and the separation checklist are mandatory. |
| AI agents | `AGENTS.md` (git root) and `yscap-repo-root_8/CLAUDE.md`. |
| Written authorization | `yscap-repo-root_8/docs/LONG-TERM-AUTHORIZED-COPIES.md` — the ledger. The CI gate reads it; an entry there is the only thing that makes a crossing legal. |
| Design / research | `yscap-repo-root_8/docs/LONG-TERM-LOANS-SEPARATION-CHARTER.md`. |

**Do not weaken, bypass, baseline, or "temporarily" disable the gate.** If it blocks you, the answer is either to fix
the crossing or to get written authorization and record it in the ledger — never to edit the gate.
