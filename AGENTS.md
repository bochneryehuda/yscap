# AGENTS.md — read this before you touch anything

This file is for **every AI agent and every developer** working in this repository. The full project guide is
`yscap-repo-root_8/CLAUDE.md`. Two things must be understood before any work begins.

## 1. The project lives in a subfolder

`package.json`, `src/`, `db/`, `web/`, `app/`, `app-v2/`, `docs/`, `scripts/` are all inside
**`yscap-repo-root_8/`**, not at the git root. Run every `npm` command from inside that folder.

## 2. There are TWO products, and they are TWO systems that never mix

**Owner-directed, 2026-08-02. Strict, hard rule, no exceptions.**

- **RTL — Residential Transition Loans** (bridge + ground-up construction + fix & flip). Everything built in this
  repo before 2026-08-02 is RTL. It is the **main product**.
- **LT — Long-Term Loans.** Brand new, starts at **zero**. A **side build for visibility only — not live**, no
  borrowers, no production traffic. It may become a full system later.

Treat them as two different companies' software that happen to share one repository. The owner's comparison:
*"if I'm telling you to build something you don't know if you should build this for Amazon or for eBay — you ask."*

1. **Never assume which side a request is for.** If it is not stated or not 100% obvious — **stop and ask**. Never
   guess, never do both, never pick the likelier one.
2. **Nothing crosses without the owner's explicit written authorization, per item** — no copying, re-using,
   importing, extending, generalizing or sharing of code, tables, columns, migrations, conditions, templates,
   endpoints, screens, components, prompts, mappings or integrations, in either direction. Ask → get it in writing →
   record it in `yscap-repo-root_8/docs/LONG-TERM-AUTHORIZED-COPIES.md` → then build.
3. **The back end is separate.** LT lives only in `src/longterm/**`, `/api/lt/*`, `lt_*` tables,
   `db/NNN_lt_*.sql`, `scripts/test-lt-*.js`. No LT table references an RTL table, no trigger crosses, no shared
   writer or service module. The only permitted seam is `src/server.js` mounting the LT router.
4. **Never change RTL to make LT work** — no new column on `applications`, no new ClickUp/Encompass/SharePoint/
   DocuSign/Sitewire/Trustpoint mapping, no new checklist template, unless the owner asked for that exact thing.
5. **LT is explicitly not getting, for now: conditions, document underwriting, orders.**
6. **The front end may show both; the back end may not.** A combined pipeline is allowed, read-only, with a visible
   product stamp on every row and a Both / RTL only / Long-Term only filter. Never a SQL join or a shared write path.
7. **A feature built for one side never automatically applies to the other.**
8. **When in doubt, ask. Silence is never permission.**

Enforced by `yscap-repo-root_8/scripts/check-product-separation.js` (runs in `npm test`, blocks CI and the deploy),
`.github/pull_request_template.md`, and `.github/PRODUCT-SEPARATION.md`. Do not weaken or bypass the gate —
fix the crossing, or get written authorization and record it in the ledger.

Design and research behind the split: `yscap-repo-root_8/docs/LONG-TERM-LOANS-SEPARATION-CHARTER.md`.
