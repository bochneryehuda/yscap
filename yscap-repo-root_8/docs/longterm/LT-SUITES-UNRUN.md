# LT test suites that `npm test` does not run — and why

`scripts/check-lt-suite-coverage.js` compares every `scripts/test-lt-*.js` on disk against what the
`npm test` chain actually executes (suites it names outright, plus the suites an aggregate runner it
invokes globs). Anything executed by **nothing** must appear below with a reason, or the check fails.
It fails the other way too: a row here for a suite that IS run now is struck off in the same commit.

**Why this ledger exists.** Eleven suites — about 167 assertions — were being executed by nothing at
all, because suite membership was kept by hand in two places (`package.json` names 59; the PPE
aggregate globs the rest) and the two had gone stale. Nine of those eleven were real, passing, offline
suites and are now in the chain. A test nobody runs is indistinguishable from a test that does not
exist, except that it looks like coverage on the shelf.

**A row here is a deliberate decision, not a backlog.** If a suite could run in CI, wire it in instead.

| suite | why it cannot run in the `npm test` chain |
|---|---|
| `test-lt-lp-agreement-run.js` | A LIVE RUNNER, not a suite. It drives the ≥200-scenario agreement battery against Lender Price and takes arguments (`--unscoped`, a rate-sheet scope, a program); run bare it exits non-zero telling you so. It needs vendor credentials, makes hundreds of paid upstream calls, and is invoked deliberately by a human. |
| `test-lt-lp-disqualify-crosscheck.js` | A LIVE CAPTURE TOOL. It needs both a real `DATABASE_URL` and live Lender Price credentials, and polls the vendor's asynchronous disqualify tree — run without them it blocks until it is killed rather than skipping politely, so it can never be part of an unattended chain. |
| `test-lt-lp-login-pad.js` | A LIVE PROOF of the vendor login, and it says so in its own header: it exercises every login path against the tenant and needs the three credentials in the environment. Its offline counterparts — `test-lt-lp-login-contract.js` (the wire spec) and `test-lt-lp-token-renewal.js` (the renewal ladder) — are in the chain and cover the shape with no credentials. |
