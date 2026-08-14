# Long-Term — Encompass integration

Long-Term's own copy of the Encompass integration, brought in with the owner's
written authorization (2026-08-14; see `docs/LONG-TERM-AUTHORIZED-COPIES.md`). It is
**self-contained** — imports zero RTL code, reaches no RTL table — and **READ-ONLY**.

**The full explanation is `docs/longterm/ENCOMPASS-INTEGRATION.md`** — read that first.

Files:
- `client.js` — the read-only Encompass API client (OAuth + reads). No write path.
- `completion-rules.js` — the Milestone Completion rules + the base rule's field set + what's missing.
- `reconciliation-map.js` — the RTL field map, brought in for reference, RTL usage labeled.
- `requests.js` — the request / authorization catalog.
- `index.js` — the accessor; builds the unified field catalog (`fieldCatalog()`) and `summary()`.

Nothing here is enforced. It is reference knowledge for the build. Served read-only
at `/api/lt/encompass/*`. Guarded by `scripts/test-lt-encompass-readonly.js`.
