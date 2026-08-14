# Encompass is READ-ONLY — the write-authorization pad

**Owner-directed 2026-08-14. This is the HARDEST rule, on top of every other rule,
and it applies to BOTH products (RTL and Long-Term) and to every program.**

> *"We need to make this a strict rule before we proceed: it should only be one-way.
> We should only read; we should not write into Encompass. We need to make this the
> strongest enforcement. Reading should be massive; we should be able to receive the
> webhooks, everything. We shouldn't write information into Encompass. We should still
> have a pad with written authorization from Super-admin for one-offs to make an
> exception, but it should only be for the one-off exception. It should not be any
> guess of any agent that is typing something … Nobody should ever guess. This hard
> rule should block anyone from writing anything to Encompass unless you have written
> authorization to set something up."*

## The rule

1. **PILOT ↔ Encompass is ONE-WAY. We READ; we never WRITE.** Reading is unlimited —
   pull loans, fields, milestones, settings, and **receive inbound webhooks** (a
   webhook is data coming *in*, which is a read, not a write). None of that needs
   authorization.
2. **No code may write ANYTHING to Encompass** — no PATCH/PUT/POST/DELETE that changes
   a loan, a field, a milestone, an eFolder document, or anything else — **unless that
   exact write is listed in the `encompass-writes` block below.**
3. **An entry here requires the owner / a super-admin's WRITTEN authorization for a
   SPECIFIC thing** — a named endpoint and purpose (and, for a one-off, the specific
   field). **No agent, and no person, may ever GUESS a write.** "It probably needs
   updating" is never authorization. Only what the owner specifically wrote is allowed.
4. **This is enforced in code by `scripts/check-encompass-readonly.js`** (runs in
   `npm test` / CI). Any Encompass write not listed here **fails the build**. The gate
   also proves the read-only clients stay read-only and that no raw Encompass write can
   bypass the guard.
5. **This is the CODE half. The STRONGEST enforcement is also at the credential level —
   see "Enforce it in Encompass too" below.** The owner asked for both.

## How to add an authorized write (the pad)

1. The owner / a super-admin states, **in writing**, the exact write: which endpoint,
   which field(s) if it's a field write, and the purpose.
2. Add **one `write` line** to the `encompass-writes` block below **and** one row to the
   log table, in the **same pull request** as the code that performs the write.
3. The write code must be **isolated** in its own module, **structurally guarded** (its
   own allowlist of exactly the authorized endpoints — the flood module is the model),
   **super-admin-gated at runtime**, and **audited**. A write may never be reachable by
   an agent's inference — only by the specific, authorized action.
4. Authorization is **per item, never blanket.** Approval for one field/endpoint is not
   approval for the next one.

**Only the FIRST `encompass-writes` block in this file counts** (an example later in the
prose can never quietly become a real permission).

```encompass-writes
# Format:  write <module-path> | <allowed endpoint(s)> | <purpose + who authorized>
# Everything not listed here is forbidden — the gate fails the build on any other write.

# The ONE authorized write today: flood-determination ordering. Owner-authorized
# 2026-07-30 ("only be able to order flood right now and not anything extra"). Isolated
# in its own module with its own endpoint allowlist, super-admin-gated, audited, and
# off by default behind ENCOMPASS_FLOOD_OUTBOUND_ENABLED. RTL only — Long-Term has NO
# flood/write path.
write src/encompass/flood-order.js | POST /encompass/v3/loans/{guid}/serviceOrders ; POST /services/v1/partners/{id}/transactions | Flood determination ordering (ICE flood service), owner-authorized 2026-07-30
```

## Log of authorized writes

| Date | Write | Product | The owner's words | PR |
|---|---|---|---|---|
| 2026-07-30 | Flood-determination ordering (`src/encompass/flood-order.js`) | RTL | *"only be able to order flood right now and not anything extra"* | (flood PR) |

## Log of things we did NOT authorize

| Date | Asked | Answer |
|---|---|---|
| 2026-08-14 | Any Encompass write other than flood | **No.** One-way, read-only, everything else forbidden unless added to the pad above with written authorization for the specific thing. |
| 2026-08-14 | An agent updating an Encompass field it inferred was wrong | **Never.** No guessing. Only a specifically-authorized write, super-admin-gated. |

## Enforce it in Encompass too (the credential level — owner-directed 2026-08-14)

The code gate above stops OUR code from writing. The owner also wants the **credentials
themselves** set up so Encompass rejects a write even if code somehow tried:

- **Give the Encompass API user (Developer Connect client / persona) READ-ONLY scopes.**
  The password grant this integration uses requests scope `lp`; the persona attached to
  that API user should be configured in **Encompass Admin Tools → Company/User Setup →
  Personas** with **no write access** — no field-write, no milestone-advance, no eFolder
  upload, no loan create/update. Then any write attempt is refused at ICE, not just in
  our code. This is a defense-in-depth second wall the code cannot provide.
- **Keep the flood-write capability on a SEPARATE, dedicated API user** if flood
  ordering is turned on, so the main read user has zero write scope. The flood config
  already supports separate `ENCOMPASS_FLOOD_*` credentials for exactly this.
- Ask ICE Mortgage Technology Support to confirm the persona's effective write scopes.

## Where this rule lives

| Place | File |
|---|---|
| The pad (this file) | `docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md` |
| The CI gate | `scripts/check-encompass-readonly.js` (in `npm test`) |
| The gate's self-test | `scripts/test-encompass-readonly-gate.js` |
| Per-client read-only proofs | `scripts/test-encompass-readonly.js` (RTL), `scripts/test-lt-encompass-readonly.js` (LT) |
| Master rule | `CLAUDE.md` (top) + `AGENTS.md` (git root) |
