# The crossing ledger — what the owner has authorized, in writing

**Nothing built for RTL may be re-used by Long-Term (or the reverse) unless it is written down here.**
This is the machine-readable record of rule 2 of the two-product law
(`CLAUDE.md` → "TWO PRODUCTS, TWO SYSTEMS", mirrored in `.github/PRODUCT-SEPARATION.md` and `AGENTS.md`).

`scripts/check-product-separation.js` reads the block below on every `npm test` run and in CI. **A crossing that
is not listed here fails the build.** That is the point: "written authorization" is not a memory or a chat
message that scrolls away — it is an entry in this file, in the same commit as the code it permits.

## How to add an entry

1. Ask the owner for the specific thing, by name. *"May Long-Term re-use the password-hashing module we built
   for RTL?"* — never *"may I re-use some of the RTL code?"*
2. Get a **yes in writing**. Quote it.
3. Add one line to the `authorized` block below **and** one row to the log table, in the same pull request as
   the code that relies on it.

Authorization is **per item, never blanket**. A yes for one module is not a yes for the module next to it.
A yes for LT→RTL is not a yes for RTL→LT. If the owner's answer was "not for now", it does not go in this file.

## Entry kinds

| Kind | Means | Example |
|---|---|---|
| `import <path>` | Long-Term code (`src/longterm/**`, `app-v2/src/longterm/**`) may `require()`/`import` this RTL module — including a shared front-end component. Path is repo-relative (from `yscap-repo-root_8/`). | `import src/lib/crypto.js` |
| `rtl-import <path>` | This one RTL file may `require()` Long-Term code. `src/server.js` (the mount seam) and `scripts/test-lt-*.js` are already allowed and need no entry. | `rtl-import src/worker.js` |
| `sql-ref <table>` | An `lt_*` table may carry a foreign key to this RTL table. | `sql-ref borrowers` |
| `sql-read <table>` | Long-Term code may **read** this table in SQL (`FROM` / `JOIN`). Reading is not writing. | `sql-read borrowers` |
| `sql-write <table>` | Long-Term code may **change** this table (`INSERT` / `UPDATE` / `DELETE`). Implies read. | `sql-write borrowers` |

Lines starting with `#` are comments. Everything else must match one of the five kinds exactly.

**Only the FIRST `authorized` block in this file counts.** An example block written later in the prose can never
quietly become a real permission.

```authorized
# ---------------------------------------------------------------------------
# SHARED IDENTITY — authorized in writing by the owner, 2026-08-03:
#   "same login same borrower record, keep it separate everything else …
#    all the borrowers should be able to see all their files even if its long
#    term or short term … officers should be able to see all of their files
#    even if it's long term or short term."
#
# This is the ONLY zone that crosses. Everything else — workflow, statuses,
# integrations, documents, money, screens — is a brand-new Long-Term build.
# Do not add a line here to make a build pass; add it only after the owner has
# said yes, in writing, to that exact item.
# ---------------------------------------------------------------------------

# One login for both products (staff and borrowers alike).
import src/auth/index.js

# One borrower = one person record, whichever product the file belongs to.
# READ only: Long-Term shows the borrower, it does not rewrite the person record.
sql-ref  borrowers
sql-read borrowers

# A Long-Term file knows its officer, so "officers see all of their files"
# can be true across both products. Same staff accounts as the login above.
sql-ref  staff_users
sql-read staff_users
```

## Log of authorizations

| Date | Kind + item | Direction | The owner's words | PR |
|---|---|---|---|---|
| 2026-08-03 | `import src/auth/index.js` — one login for both products | RTL → LT | *"same login same borrower record, keep it separate everything else"* | #975 |
| 2026-08-03 | `sql-ref borrowers` + `sql-read borrowers` — one person record, read by Long-Term | RTL → LT | *"same borrower record … all the borrowers should be able to see all their files even if its long term or short term"* | #975 |
| 2026-08-03 | `sql-ref staff_users` + `sql-read staff_users` — a Long-Term file knows its officer | RTL → LT | *"officers should be able to see all of their files even if it's long term or short term"* (an officer can only see their Long-Term files if a Long-Term file records its officer, and officers are the same accounts as the shared login) | #975 |

**That is the whole list.** The owner's same sentence closed everything else: *"keep it separate everything else …
the back end of the entire thing will be different, the workflow will be different, the sets will be different,
integrations will be different, it will be a brand new build. Don't assume anything that we're building on one
thing to build that also on the other thing — it's totally separate."*

## Log of things we ASKED for and were told NO / not yet

Keeping the refusals is as important as keeping the approvals — it stops the same question being re-asked and
stops a "no" quietly turning into a "yes" months later.

| Date | What was asked | Answer |
|---|---|---|
| 2026-08-02 | Conditions, document underwriting, and orders for Long-Term | **Not for now** — "we're not going to build conditions we're not going to bring in document underwriting we're not going to bring in orders for now" |
| 2026-08-02 | New columns / new field mappings anywhere for Long-Term | **No** — "don't add any columns don't add any mapping unless we specifically ask you to" |
| 2026-08-02 | Sharing the database connection pool (`src/db.js`) with Long-Term | **Not asked yet** — until it is, Long-Term opens its own pool in `src/longterm/db.js`, which needs no authorization (open question 11 in the charter) |
| 2026-08-03 | **Long-Term WRITING the borrower record** (`sql-write borrowers`) | **Not authorized.** The owner authorized the *same borrower record*, which Long-Term reads. Creating and editing a borrower stays in the one existing flow, so the person record keeps a single owner — a dozen RTL modules already heal, enrich and de-duplicate it (Encompass enrich, ClickUp sync, credit store, name-heal, merge). Ask before Long-Term changes a borrower. |
| 2026-08-03 | Long-Term re-using RTL's **workflow, statuses, document sets, conditions or integrations** | **No — explicitly.** *"the workflow will be different, the sets will be different, integrations will be different, it will be a brand new build."* |
