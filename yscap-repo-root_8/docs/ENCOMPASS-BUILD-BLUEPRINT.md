# Encompass Integration — Phase-1 Build Blueprint

**Date:** 2026-07-19 · **Status:** RESEARCH / DESIGN ONLY — nothing in this document has been implemented. No code, database, configuration, or Encompass call exists yet. This is the executable plan a future build session follows once the owner says "build it."

**Read these first (they are the source of truth; this doc turns them into a build order):**
`ENCOMPASS-INTEGRATION-RESEARCH.md` (master + open-question tracker §10, OQ-01…OQ-31) ·
`ENCOMPASS-READONLY-GUARDRAILS.md` (the write-freeze doctrine — the doc every build session must read before touching Encompass code) ·
`ENCOMPASS-DATA-MAPPING.md` (canonical schema §2.1, match ladder, the three-door CTC gate) ·
`ENCOMPASS-API-ATLAS.md` (auth, allowlist, the 800-operation classification) ·
`ENCOMPASS-IDEAS-AND-ROADMAP.md` (rule catalog, roadmap mapping) ·
`ENCOMPASS-INDUSTRY-LANDSCAPE.md` (practitioner lessons, compliance, ICE questions).

---

## 0. How to use this document

This is a **staged work order**, not a spec to build in one sitting. It sequences Phase 1 into work orders (WO-1 … WO-9) that a future session executes one at a time, each behind this repo's mandatory two-audit-agent gate. Every recommendation reuses an existing, proven portal pattern rather than inventing a new one — the ClickUp integration already solved the hard parts (single-chokepoint client, durable queue, snapshot audit, journaled writes, human-review queue), and the read-only Encompass integration is a **strictly simpler** cousin of it (it never writes, so most of ClickUp's write-safety machinery collapses into one absolute rule).

**Golden rule restated:** Phase 1 is **poll-only** and performs **zero writes to Encompass — not even a webhook subscription** (Decision D2). The integration must be *architecturally incapable* of writing. Everything below serves that.

---

## 1. Phase-1 scope (what WO-1…WO-9 actually build)

| # | Work order | One-line outcome |
|---|---|---|
| WO-1 | Read-only client module + allowlist | One chokepoint every Encompass call funnels through; deny-by-default allowlist; no non-GET/non-read-POST can leave the building |
| WO-2 | CI guard test | A `node scripts/test-encompass-readonly-guards.js` that fails the build if any forbidden call shape is reachable |
| WO-3 | Auth / token manager | OAuth2 password-grant token cache with re-auth-before-expiry; secret only from env |
| WO-4 | DB migrations (4 tables) | `encompass_loan_index`, `encompass_snapshots`, `encompass_pull_log`, `encompass_gate_log` |
| WO-5 | Poll-sync worker | Backfill (pipeline pagination) + incremental (watermark reconciliation); snapshots every fetch |
| WO-6 | Crosswalk / matching | Encompass loan ↔ portal application, SSN/DOB-free match ladder, ambiguity → review |
| WO-7 | Read journal + admin visibility | Every outbound call logged; a read-only admin "Encompass" panel showing match/pull/gate state |
| WO-8 | Rules engine hooks (3 rules) | Mapped-condition gate, rate-lock-expiry warning, and the three-door CTC gate |
| WO-9 | Monitoring + freshness SLO | Heartbeat, staleness metric, mismatch-rate metric, kill-switch verification |

Anything not on this list (webhooks, SSN/DOB pull, any write-back, borrower-facing Encompass timelines) is **out of Phase 1** by design.

---

## 2. WO-1 — The read-only client module (the single chokepoint)

**Pattern to copy:** `src/clickup/client.js`. That file proves the model: every request funnels through one `call()`, and destructive shapes are refused *inside* `call()` so no code path — present, future, refactor slip, or copy-paste — can bypass them. We reuse the *shape* and invert the *policy*: ClickUp allows writes and blocks deletes; Encompass allows **nothing but reads**.

**New file:** `src/encompass/client.js`. Design:

```
BASE = 'https://api.elliemae.com'         // never a hardcoded token; never from the browser

// ── THE ONE RULE: deny-by-default allowlist of method+path patterns. ──
// Unlike ClickUp (blocklist of deletes), Encompass is an ALLOWLIST: a request
// is refused unless its (method, path) matches an explicitly permitted READ.
// Method-only filtering is INSUFFICIENT — several Encompass reads are POSTs
// (fieldReader, loan pipeline query, schema pathGenerator/contractGenerator,
// token introspection, eFolder export-job creation). So the allowlist matches
// on method AND path shape. See ENCOMPASS-API-ATLAS §10.1 for the full table.
const ALLOWED = [
  // ---- auth (token endpoints) ----
  { m:'POST', re:/^\/oauth2\/v1\/token$/ },
  { m:'POST', re:/^\/oauth2\/v1\/token\/introspection$/ },
  // ---- loan reads (GET) ----
  { m:'GET',  re:/^\/encompass\/v3\/loans\/[^/]+$/ },
  { m:'GET',  re:/^\/encompass\/v3\/loans\/[^/]+\/(conditions|milestones|associates|documents|ratelockRequests|disclosureTracking2015|ausTrackingLogs)(\/[^/]+)?$/ },
  { m:'GET',  re:/^\/encompass\/v3\/loanFolders$/ },
  { m:'GET',  re:/^\/encompass\/v3\/schemas\/loan$/ },
  { m:'GET',  re:/^\/encompass\/v3\/settings\/loan\/customFields$/ },
  // ---- reads that ICE models as POST (read semantics, no state change) ----
  { m:'POST', re:/^\/encompass\/v3\/loans\/[^/]+\/fieldReader$/ },     // returns field values
  { m:'POST', re:/^\/encompass\/v1\/loanPipeline$/ },                  // pipeline query
  { m:'POST', re:/^\/encompass\/v3\/loans\/[^/]+\/exportJobsCreator$/ }, // async read job (eFolder export)
  // NOTE: exportJobsCreator's collection variant carries a `skipPersonaChecks`
  // query param — the query validator (below) MUST strip/deny it: persona
  // checks stay ON. (ENCOMPASS-API-ATLAS §7.2 / D17.)
];
// EVERYTHING ELSE — every loan create/update/delete, batch update, resource
// lock, webhook subscription CRUD, custom-field write, fieldWriter — is DENIED.

function guardAllowlisted(method, path) {
  const p = String(path).split('?')[0];
  const ok = ALLOWED.some(a => a.m === String(method).toUpperCase() && a.re.test(p));
  if (!ok) {
    const e = new Error(`BLOCKED: ${method} ${p} is not on the Encompass read-only allowlist. `
      + `Phase 1 never writes to Encompass. To read new data, add the endpoint to the `
      + `allowlist in a reviewed change — never bypass this guard.`);
    e.code = 'ENCOMPASS_WRITE_FORBIDDEN';
    throw e;
  }
}

// Second belt: an env kill switch that hard-disables ALL outbound calls.
function guardKillSwitch() {
  if (process.env.ENCOMPASS_ENABLED !== '1') {
    const e = new Error('BLOCKED: ENCOMPASS_ENABLED is not 1 — integration is off.');
    e.code = 'ENCOMPASS_DISABLED'; throw e;
  }
}

async function call(path, { method='GET', body, query } = {}) {
  guardKillSwitch();
  guardAllowlisted(method, path);           // deny-by-default BEFORE any network
  stripForbiddenQuery(query);               // e.g. skipPersonaChecks
  // …token from tokenManager (WO-3), fetchWithTimeout, retry/backoff on 429/5xx
  //   (port the exact retry contract from clickup/client.js — it is proven),
  //   then JOURNAL the call (WO-7) with NO response body, NO PII: just
  //   {method, path, loanGuid?, status, ms, bytes}.
}
```

**Why an allowlist and not a blocklist:** the Atlas classification found **318 loan-write operations** in the collection. A blocklist would have to enumerate all of them and stay correct forever; an allowlist enumerates the ~15 reads we actually use and refuses the other 785 automatically. This is the single most important design choice in the whole integration.

**Exports:** thin read helpers only — `getLoan(guid, {entities,view})`, `fieldReader(guid, fieldIds[])`, `pipeline(query)`, `getConditions(guid)`, `getMilestones(guid)`, `getRateLocks(guid)`, plus `guardAllowlisted`/`guardKillSwitch` exported *for the CI test* (like ClickUp exports its guards for `test-clickup-write-guards.js`). **No `createLoan`, no `updateLoan`, no `setField`, no `deleteX` — those helpers must never exist in this file.**

---

## 3. WO-2 — The CI guard test (fails the build on any forbidden shape)

**Pattern to copy:** `scripts/test-clickup-write-guards.js` (no DB, no network — pure guard assertions). **New file:** `scripts/test-encompass-readonly-guards.js`, added to the `npm test` chain in `package.json`. It asserts:

1. `guardAllowlisted` **throws** `ENCOMPASS_WRITE_FORBIDDEN` for: `POST /encompass/v3/loans` (create), `PATCH /encompass/v3/loans/{id}` (update), `DELETE /encompass/v3/loans/{id}`, `POST /encompass/v3/loans/{id}/fieldWriter`, `POST /encompass/v1/loanBatch/updateRequests`, `POST /encompass/v1/loans/{id}/resourceLocks`, `POST /webhook/v1/subscriptions`, `PATCH /webhook/v1/subscriptions/{id}`.
2. `guardAllowlisted` **allows** each read on the allowlist (loan GET, fieldReader POST, pipeline POST, conditions/milestones GET, token, introspection).
3. `guardKillSwitch` throws unless `ENCOMPASS_ENABLED === '1'`.
4. **Static source scan** (the strongest guard): grep `src/` for any string that looks like a mutating Encompass call — `fieldWriter`, `loanBatch`, `resourceLocks`, `webhook/v1/subscriptions`, or a `method:'PUT'|'PATCH'|'DELETE'` addressed at an `elliemae`/`encompass` path outside `src/encompass/client.js`. Any hit **fails the test**. (This is the analog of the ClickUp delete-guard regression test, but broadened to "no write verb reaches Encompass from anywhere.")
5. `stripForbiddenQuery` removes `skipPersonaChecks`.

This test is the enforcement that survives refactors: even if someone later writes a raw `fetch('https://api.elliemae.com/...')`, the static scan catches it.

---

## 4. WO-3 — Auth / token manager

**Source:** `ENCOMPASS-API-ATLAS §2` + `ENCOMPASS-INDUSTRY-LANDSCAPE §4.1 lesson 1`. **New file:** `src/encompass/auth.js`.

- **Flow:** OAuth2 **Resource Owner Password Credentials** (lenders use `grant_type=password`; `client_credentials` is ISV-only and would break — see Industry §6.1). Username format `serviceuser@encompass:BE11397907`.
- **Secret handling:** `ENCOMPASS_CLIENT_ID`, `ENCOMPASS_CLIENT_SECRET`, `ENCOMPASS_SVC_USERNAME`, `ENCOMPASS_SVC_PASSWORD`, `ENCOMPASS_INSTANCE_ID` come **only from env** (`src/config.js`), never source. ⚠️ **The client secret the owner pasted in chat on 2026-07-17 is burned — it must be regenerated in ICE's API Key Management before first use** (OQ-13/RESOLVED note in Master §10). Never log a token or secret.
- **Token cache:** design for the **stricter** of the two documented lifetime regimes (treat as ~30 min, re-authenticate a few minutes early). There is **no refresh token** — "refresh" = re-run the password grant. Cache one token per process; introspect if a call 401s, then re-auth once and retry.
- **Least privilege (Encompass side):** the service user should be a **read-scoped persona** so that even a bug cannot write — belt-and-suspenders with the code allowlist. This is a provisioning ask (§9), not code.

---

## 5. WO-4 — Database migrations (the canonical schema)

**Source:** `ENCOMPASS-DATA-MAPPING §2.1` (canonical). **Numbering:** highest existing migration is `db/125_sync_runtime_state.sql`, so these are **`db/126`…`db/129`** *at time of writing* — re-check for collisions at build time and renumber yours (never another session's) per the migration-numbering rule. All idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE TYPE … IF NOT EXISTS` via `DO $$`), applied on boot by `migrate-boot.js`.

| Migration | Table | Purpose & key columns |
|---|---|---|
| `db/126` | `encompass_loan_index` | One row per Encompass loan GUID seen. `loan_guid` (unique), `application_id` (FK, nullable), `match_state` enum, `matched_at`, `last_fetched_at`, `last_seen_milestone`, cheap denormalized status fields for the admin list. **Binding lives here** — `application_id` is the ONLY link; no new column on `applications` in Phases 1–2. |
| `db/127` | `encompass_snapshots` | Append-only raw JSON per loan per fetch. `loan_guid`, `fetched_at`, `payload` jsonb, `content_sha256` (skip storing an identical consecutive snapshot). Diffable, replayable, forensic. |
| `db/128` | `encompass_pull_log` | The **read journal** — one row per outbound call. `at`, `method`, `path`, `loan_guid`, `status`, `duration_ms`, `bytes`. **No response body, no PII.** (Analog of `clickup_write_log`, but for reads.) |
| `db/129` | `encompass_gate_log` | One row per rule/gate evaluation. `at`, `rule_key`, `application_id`, `decision` (pass/block/warn/stale), `snapshot_id`, `snapshot_age_sec`, `evidence` jsonb (the Encompass values shown to the user), `override_by`/`override_reason` (nullable). |

**`match_state` enum (7 states, D4):** `unmatched`, `auto_matched`, `manual_confirmed`, `ambiguous`, `conflict`, `data_only`, `ignored`.
- `data_only` = enrichment-only loans (historical/closed) that will never gate a portal file.
- `conflict` = a match that data later disputed.
- `ambiguous` = multiple candidates → manual review.
- Gate precondition everywhere: **match_state ∈ {auto_matched, manual_confirmed}**.

Optional typed convenience projections (`encompass_conditions`, `encompass_milestones` as flattened views of the latest snapshot) are an *implementation detail* if querying raw jsonb proves awkward — they are **not** separate sources of truth. Snapshots are the truth.

---

## 6. WO-5 — The poll-sync worker

**Pattern to copy:** `src/sync/queue.js` (interval-driven `tick()` that claims work `FOR UPDATE SKIP LOCKED`, retries with capped exponential backoff) + the ClickUp reconcile watermark (`db/125 sync_runtime_state`, captured pre-query, advanced only on fully-clean passes, with an overlap window). **New file:** `src/encompass/sync.js`, started from `src/server.js` only when `RUN_SYNC=1` **and** `ENCOMPASS_ENABLED=1`.

Two loops, both **pull-only**:

1. **Backfill (one-time / resumable):** page through the lender's book with the pipeline query (`POST /encompass/v1/loanPipeline`, `start`/`limit` pagination), writing an `encompass_loan_index` row per loan and an initial `encompass_snapshots` row. Throttled well under the rate limit (port ClickUp's token-bucket pacing). Resumable via a cursor in `sync_runtime_state`.
2. **Incremental (steady state):** every N minutes, pipeline-query loans changed since the durable watermark (`lastModified` filter), re-fetch each changed loan (`GET /encompass/v3/loans/{guid}` with a narrow `entities`/`view` set — see Data-Mapping field maps), write a new snapshot **only if the content hash changed**, and advance the watermark **only on a clean pass** (keep a 2-minute overlap; clamp catch-up). Polling is the **source of truth** (Decision D2 — webhooks are a later accelerator, never a Phase-1 dependency).

**Call-volume budget:** roughly **500–1,750 calls/day** depending on book size and poll cadence (Atlas §5). Pace under ICE's rate limits; honor `Retry-After`; 429/5xx retried patiently by the queue, never dead-lettered on a blip.

---

## 7. WO-6 — Crosswalk / matching (SSN/DOB-free)

**Source:** `ENCOMPASS-DATA-MAPPING §2/§4` (Decision D3 — Tier 3 SSN/DOB pull is **disabled at launch**). Matching ladder, **primary → fallback**:

1. **`ys_loan_number` ↔ Encompass Loan Number** — strongest available key. Exact match on a live application (respect the partial-unique-on-live-rows rule, `db/048`) → `auto_matched`.
2. **Canonical property address + borrower/entity last name** — reuse `src/lib/address-canon.js`. High-confidence pair → `auto_matched`; single-signal only → `ambiguous`.
3. **Borrower/entity name + loan amount + date corroboration** — weakest; never auto-attaches alone → `ambiguous` → manual review.

Rules: **conservative auto-attach** (a single weak signal never attaches); every `ambiguous`/`conflict` becomes a **manual-review row** (reuse the `sync_review_queue` pattern and the file-review action model, `src/lib/sync-file-review.js`) offering "link to candidate / mark data-only / ignore." SSN-hash matching is documented as a **future** stronger key that *only exists if the owner later enables Tier 3* — do not build it in Phase 1. Wrong-loan matching is the scariest failure in the risk register (F5) — that is why weak matches wait for a human.

---

## 8. WO-8 — Rules engine hooks (three Phase-1 rules)

**Source:** `ENCOMPASS-DATA-MAPPING §5`, `ENCOMPASS-IDEAS §5`, and the conditions engine (`src/lib/conditions/engine.js`, `rules.js`, `signOffGate` in `src/routes/staff.js`). **Core principle (D1):** the evaluator holds **no HTTP client** — it reads the **latest local snapshot**, never a live call in the request path. Freshness is enforced by a ceiling; stale → **fail closed** + enqueue a high-priority refresh.

Ship exactly three rules in Phase 1 (engine designed for more):

1. **Mapped-condition agreement gate.** A portal condition may be gated **only if an admin explicitly maps it** to an Encompass condition (opt-in mapping table). A *mapped* portal condition cannot be cleared unless its Encompass counterpart is cleared/received. **Unmapped conditions behave exactly as today.** Enforcement turns on only after mapping coverage of active-pipeline conditions reaches the ≥90% gate (Ideas §7). Never auto-clears anything in either direction — it is a *gate*, not an actor.
2. **Rate-lock-expiry warning (soft).** When the local snapshot shows the Encompass lock expiring within N days, surface a warning on the file. Soft-warn only; tolerates normal snapshot age.
3. **Three-door clear-to-close gate (hard, fail-closed).** CTC cannot be issued unless the local Encompass snapshot shows CTC evidence (configurable milestone reached **and** all prior-to-closing conditions cleared). Covers **all three doors** (Decision D6): (a) the status-PATCH endpoint, (b) the internal-status endpoint (`staff.js:4298`, which today bypasses `advancementBlockers`), and (c) ClickUp-inbound status application — where "block" means the inbound CTC change is **not applied locally** and instead lands in `sync_review_queue` with reason `encompass_gate_blocked`. **Freshness:** requires the snapshot to be ≤ **15 minutes** old (configurable); older → gate returns "refreshing Encompass data — retry shortly," enqueues an immediate refresh, and **does not pass**. Every evaluation writes an `encompass_gate_log` row with the evidence shown and any override.

**Override path:** a hard block is overridable by an authorized role with a **required reason**, fully audited in `encompass_gate_log`. Rules must *help, not nag* — severity tiers (hard-block / soft-warn / silent-record), quiet by default.

---

## 9. WO-7 & WO-9 — Read journal, admin visibility, monitoring

- **Read journal (WO-7):** already written by `call()` into `encompass_pull_log`. Add a **read-only** admin panel (mirror `src/routes/admin-clickup.js` / `admin-sharepoint.js` style) showing, per loan: match state, last-fetched age, latest milestone, recent pulls, recent gate decisions. **No action buttons that write to Encompass** — the panel is a window, not a remote control. The only actions are portal-side: confirm/adjust a match, mark data-only, re-enqueue a refresh.
- **Monitoring (WO-9):** heartbeat (last successful poll timestamp on `/api/health`), **freshness SLO** (max snapshot age across active-pipeline loans), **mismatch-rate** metric (share of gate evaluations returning block/conflict), and a startup assertion that the **kill switch works** (with `ENCOMPASS_ENABLED≠1`, every `call()` throws). Silent sync death is on the never-again list (A6) — a stalled poller must page, not go quiet.

---

## 10. Provisioning (owner + ICE — before any code runs)

Plain-language asks for the owner, mostly one-time:

1. **Regenerate the client secret** in ICE's API Key Management (the one shared in chat is burned). Set it, the client ID, and the instance ID as Render environment variables — never in a file. *(Owner action.)*
2. **Create a dedicated read-only service user** on instance BE11397907 with a **least-privilege, read-scoped persona** (loan read, pipeline, conditions, milestones, eFolder metadata). This is the account the integration logs in as. *(Encompass super-admin action.)*
3. **Confirm Developer Connect API entitlement** and ask the ICE account manager the questions in `ENCOMPASS-INDUSTRY-LANDSCAPE §8` (licensing tier, sandbox vs prod, rate limits, data-replication terms). *(Owner + ICE.)*
4. Set env: `ENCOMPASS_ENABLED` (default `0` — off until explicitly turned on), `ENCOMPASS_INSTANCE_ID`, `ENCOMPASS_CLIENT_ID`, `ENCOMPASS_CLIENT_SECRET`, `ENCOMPASS_SVC_USERNAME`, `ENCOMPASS_SVC_PASSWORD`, plus tunables (`ENCOMPASS_POLL_SEC`, `ENCOMPASS_MAX_RPM`, `ENCOMPASS_CTC_FRESHNESS_SEC` default 900).

---

## 11. Test plan (this repo has no test runner — follow its conventions)

Per CLAUDE.md, verification is ad-hoc Node scripts against a local Postgres, plus no-DB guard tests. Phase-1 tests:

- **`scripts/test-encompass-readonly-guards.js`** (no DB/network) — the WO-2 allowlist + kill-switch + static-source-scan assertions. **In the `npm test` chain.**
- **`scripts/test-encompass-match.js`** (local PG) — the match ladder: exact loan-number → auto; address+lastname → auto; single weak signal → ambiguous → review row created; SSN/DOB path absent.
- **`scripts/test-encompass-gate.js`** (local PG, no network) — feed a synthetic snapshot: fresh CTC-complete snapshot → gate passes; stale snapshot → fail-closed + refresh enqueued; all three doors blocked; override writes an audited `encompass_gate_log` row.
- **Sync worker** — exercised against recorded/synthetic snapshots (never live Encompass); watermark advances only on clean passes; identical snapshot is not re-stored.
- **Boot** — server boots against a throwaway PG with the new migrations applied and the module graph loading (the standard smoke check).

Every WO passes through the **two-audit-agent gate** (pre-merge on the diff, post-merge on `main`).

---

## 12. Build sequencing & dependencies

```
WO-1 client ─┬─ WO-2 CI guard test        (WO-2 depends on WO-1 exports)
             └─ WO-3 auth  ─ WO-5 sync ─┬─ WO-6 matching ─ WO-8 rules
WO-4 migrations ───────────────────────┘                 └─ WO-7 journal/admin ─ WO-9 monitoring
```

Recommended order: **WO-1 → WO-2 → WO-4 → WO-3 → WO-5 → WO-6 → WO-7 → WO-8 → WO-9.** Ship WO-1/WO-2 first so the write-freeze guarantee exists *before* any live call is even possible; ship WO-4 early so everything has tables to write to; leave the rules (WO-8) last so they sit on a trusted, well-matched data foundation.

**Stop-and-ask checkpoints (do not proceed without the owner):** (a) before the very first *live* poll against production Encompass; (b) before turning on the CTC hard-block for real files; (c) before any consideration of webhooks or write-back (Phase 2+, which needs the Guardrails unfreeze ceremony).

---

## 13. Anti-goals (things this build must NOT do)

- **No writes to Encompass, ever, in Phase 1** — including webhook subscriptions, resource locks, and batch updates.
- **No auto-clearing** of conditions in either system — Encompass agreement is a gate, not an actor.
- **No SSN/DOB pull** at launch (Tier 3 disabled).
- **No live Encompass call inside a user request** — gates read local snapshots only.
- **No new column on `applications`/`borrowers`** for the link in Phases 1–2 — binding lives in `encompass_loan_index`.
- **No noisy alerts** — severity tiers, quiet by default.
- **No secret in any file, commit, PR, or log.**

---

## 14. Open questions carried into build

The canonical tracker is **Master §10 (OQ-01…OQ-31)**; this build depends most on: OQ around webhook adoption timing (D2), CTC milestone-name configuration per instance (lender-configurable, never hardcoded), tolerance thresholds for economics mismatches, outage/fail-closed tolerance duration, and the ICE-account-manager items (licensing, sandbox, data-replication terms). Resolve the CTC milestone-name mapping and the service-user persona scope **before WO-8**.

---

*This blueprint is documentation only. No part of it has been built, and no Encompass call has been made. Building begins only on the owner's explicit go-ahead, one work order at a time, behind the standard audit gate.*
