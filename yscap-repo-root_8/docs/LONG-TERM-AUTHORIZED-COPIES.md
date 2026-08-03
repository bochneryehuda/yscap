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
| `sql-read <table>` | Long-Term code may read or write this RTL table directly in SQL. | `sql-read borrowers` |

Lines starting with `#` are comments. Everything else must match one of the four kinds exactly.

**Only the FIRST `authorized` block in this file counts.** An example block written later in the prose can never
quietly become a real permission.

```authorized
# ---------------------------------------------------------------------------
# EMPTY ON PURPOSE — as of 2026-08-02 the owner has authorized NOTHING to cross
# between Residential Transition Loans and Long-Term Loans. Long-Term starts at
# zero. Do not add a line here to make a build pass; add it only after the owner
# has said yes, in writing, to that exact item.
# ---------------------------------------------------------------------------
```

## Log of authorizations

| Date | Kind + item | Direction | The owner's words | PR |
|---|---|---|---|---|
| — | *(none yet)* | — | — | — |

## Log of things we ASKED for and were told NO / not yet

Keeping the refusals is as important as keeping the approvals — it stops the same question being re-asked and
stops a "no" quietly turning into a "yes" months later.

| Date | What was asked | Answer |
|---|---|---|
| 2026-08-02 | Conditions, document underwriting, and orders for Long-Term | **Not for now** — "we're not going to build conditions we're not going to bring in document underwriting we're not going to bring in orders for now" |
| 2026-08-02 | New columns / new field mappings anywhere for Long-Term | **No** — "don't add any columns don't add any mapping unless we specifically ask you to" |
| 2026-08-02 | Sharing the database connection pool (`src/db.js`) with Long-Term | **Not asked yet** — until it is, Long-Term opens its own pool in `src/longterm/db.js`, which needs no authorization (open question 11 in the charter) |
