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

## The live census (2026-08-14)

The files above say what Encompass *requires*. These say what it actually *contains*,
measured by reading all 772 loans in the tenant and all 24,560 field definitions:

- `field-intelligence.js` — what every field id holds: declared vs observed type, the
  enum, fill rate on DSCR vs Fix & Flip, the milestone it fills up at, value ranges.
  3,783 field ids have evidence. → `docs/longterm/ENCOMPASS-FIELD-INTELLIGENCE.md`
- `loan-anatomy.js` — how a loan file is shaped: borrower pairs, property, terms,
  interest-only, the PITIA block, milestones. → `docs/longterm/ENCOMPASS-LOAN-ANATOMY.md`
- `formulas.js` — the tenant's own calculated fields decoded, including the DSCR ratio
  (`Round([1005]/[912],2)`) and the `CX.PITIA` defect. **Never read CX.PITIA.**
- `conditions.js` — the Enhanced Conditions + eFolder model, and the authorized-but-
  unbuilt upload path. → `docs/longterm/ENCOMPASS-CONDITIONS-AND-EFOLDER.md`
- `api-surface.js` — which requests work, which 403, and which lie by answering
  `200 []`. → `docs/longterm/ENCOMPASS-ACCESS-AND-PERSONA.md`
- `dictionary/*.json` — the generated data behind all of the above. Borrower PII is
  withheld by construction and the test proves it.

Tenant-specific choices (field ids, thresholds, program names, statuses) do NOT belong
in this code — they belong in `src/longterm/settings/encompass-settings.js`, where our
values are the defaults and a future buyer can change them.

Nothing here is enforced. It is reference knowledge for the build. Served read-only
at `/api/lt/encompass/*`. Guarded by `scripts/test-lt-encompass-readonly.js` and
`scripts/test-lt-encompass-intelligence.js`.
