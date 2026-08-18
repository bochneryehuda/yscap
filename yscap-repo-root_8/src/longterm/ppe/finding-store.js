'use strict';
/**
 * LT PPE — the durable bridge for the shadow findings ledger (§10.4). Persists to `lt_ppe_finding`
 * (db/561) what the PURE `finding.js` produces, and delegates every MERGE decision to finding.js so
 * "never re-open a settled finding" has ONE definition (no SQL copy to drift).
 *
 * `db` is an injected pg pool/client exposing `.query(text, params)` — same convention as store.js,
 * so the route passes the LT pool and a test passes a throwaway one. Everything is `scope`-scoped
 * (multi-tenant). LT-only; no RTL imports.
 */

const finding = require('./finding');

function msToTs(ms) { return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null; }
function tsToMs(t) { return t == null ? null : new Date(t).getTime(); }

// DB row -> the finding.js record shape (so reconcile/mergeOne can operate on it).
function rowToRecord(row) {
  return {
    key: row.finding_key,
    investor: row.investor,
    program: row.program,
    scenario: row.scenario,
    scenarioFacts: row.scenario_facts,
    kind: row.kind,
    diff: row.diff,
    ourPayload: row.our_payload,
    theirPayload: row.their_payload,
    status: row.status,
    regressed: row.regressed,
    recurrence: row.recurrence,
    firstSeenMs: tsToMs(row.first_seen_at),
    lastSeenMs: tsToMs(row.last_seen_at),
  };
}

// UPSERT one merged record. On conflict the identity columns + first_seen_at are kept; the mutable
// state (status/regressed/recurrence/last_seen/diff/facts/payloads) is written from the merged record.
async function upsertRecord(scope, rec, db) {
  const j = (v) => (v == null ? null : JSON.stringify(v));
  await db.query(
    `INSERT INTO lt_ppe_finding
       (scope, finding_key, investor, program, program_id, scenario, scenario_facts, kind, diff,
        our_payload, their_payload, status, regressed, recurrence, first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16)
     ON CONFLICT (scope, finding_key) DO UPDATE SET
       status = EXCLUDED.status,
       regressed = EXCLUDED.regressed,
       recurrence = EXCLUDED.recurrence,
       last_seen_at = EXCLUDED.last_seen_at,
       diff = EXCLUDED.diff,
       scenario_facts = EXCLUDED.scenario_facts,
       our_payload = EXCLUDED.our_payload,
       their_payload = EXCLUDED.their_payload,
       updated_at = now()`,
    [scope, rec.key, rec.investor || null, rec.program || null, rec.programId || null,
      rec.scenario || null, j(rec.scenarioFacts), rec.kind, j(rec.diff || {}),
      j(rec.ourPayload), j(rec.theirPayload), rec.status, !!rec.regressed, rec.recurrence || 1,
      msToTs(rec.firstSeenMs), msToTs(rec.lastSeenMs)],
  );
}

/**
 * Persist a whole shadow run's incoming findings for a scope, delegating the merge to finding.js.
 *   incoming: records from finding.recordsFromComparison(...) across the run.
 *   opts: { db, nowMs, closeDisappeared=false }
 * Loads the scope's currently-open findings PLUS any settled rows matching an incoming key (so a
 * recurrence is carried and a regression flagged), reconciles, UPSERTs the merged set, and — when
 * closeDisappeared — auto-resolves open findings that no longer reproduced (§10.6). Returns
 * { summary, closed }.
 */
async function persistRun(scope, incoming = [], opts = {}) {
  const db = opts.db;
  const keys = incoming.map((r) => r.key);
  const { rows } = await db.query(
    `SELECT * FROM lt_ppe_finding
      WHERE scope = $1 AND (status IN ('open','triaged') OR finding_key = ANY($2::text[]))`,
    [scope, keys],
  );
  const existing = rows.map(rowToRecord);
  const recon = finding.reconcile(existing, incoming, { nowMs: opts.nowMs });
  for (const rec of recon.records) await upsertRecord(scope, rec, db);

  const closed = [];
  if (opts.closeDisappeared) {
    for (const d of recon.disappeared) {
      const r = await db.query(
        `UPDATE lt_ppe_finding
            SET status = 'verified', decision_reason = $3, decided_at = now(), updated_at = now()
          WHERE scope = $1 AND finding_key = $2 AND status IN ('open','triaged')`,
        [scope, d.key, 'auto-resolved: no longer reproduced'],
      );
      if (r.rowCount) closed.push(d.key);
    }
  }
  return { summary: recon.summary, closed };
}

// A human's decision on a finding (triage / fix / verify / dismiss). Validates the status.
//
// ⛔ A DECISION CLEARS THE REGRESSION FLAG, and that is not tidying — it is what gives the go-live gate's
// regression term a remedy (§2.74). `regressed` means "this was settled and it came back"; the moment a
// human looks at it again and records a decision, that sentence is answered. Leave it set and the gate
// would refuse promotion forever with nothing anybody could do about it — the dead-end class this repo
// has closed twice now. `finding.mergeOne` sets it again if the same finding comes back AGAIN, which is
// the whole point; `recurrence` keeps the permanent count of how often it has been seen, so no history
// is lost by clearing a flag that is about the LAST settlement.
async function decideFinding(scope, findingKey, decision = {}, db) {
  if (!finding.OPEN_STATUSES.has(decision.status) && !finding.SETTLED_STATUSES.has(decision.status)) {
    throw new Error(`finding-store:bad_status ${decision.status}`);
  }
  const r = await db.query(
    `UPDATE lt_ppe_finding
        SET status = $3, decided_by = $4, decision_reason = $5, regressed = false,
            decided_at = now(), updated_at = now()
      WHERE scope = $1 AND finding_key = $2`,
    [scope, findingKey, decision.status, decision.decidedBy || null, decision.reason || null],
  );
  return r.rowCount > 0;
}

/**
 * Read the ledger.
 *   opts: { status, statusIn[], investor, limit }
 *
 * EVERY option here is a SQL PREDICATE, never a post-filter — that is the whole point
 * of them existing. The route used to fetch the entire scope and narrow by investor in
 * JS, so a growing ledger slowed down every read of every investor.
 *
 * `limit` is offered but is NOT how the review queue should be paged, and the
 * distinction matters: `review-queue.buildQueue` RANKS by severity, and severity is a
 * function of the record (kind, price-gap magnitude, regressed, recurrence, age) that
 * only exists in JS. Truncating in SQL therefore drops rows BEFORE anything knows how
 * important they are, so the "top 100" would be the 100 most RECENT, presented as the
 * 100 most important. Use `statusIn` to bound the set by something true (a settled
 * finding is never in the queue) and let the ranker see all of what remains. Real
 * paging needs severity expressed in SQL, which would be a SECOND definition of it.
 */
async function listFindings(scope, opts = {}, db) {
  const params = [scope];
  let sql = 'SELECT * FROM lt_ppe_finding WHERE scope = $1';
  if (opts.status) { params.push(opts.status); sql += ` AND status = $${params.length}`; }
  if (Array.isArray(opts.statusIn) && opts.statusIn.length) {
    params.push(opts.statusIn); sql += ` AND status = ANY($${params.length}::text[])`;
  }
  if (opts.investor) { params.push(opts.investor); sql += ` AND investor = $${params.length}`; }
  sql += ' ORDER BY last_seen_at DESC NULLS LAST, finding_key';
  if (Number.isInteger(opts.limit) && opts.limit > 0) { params.push(opts.limit); sql += ` LIMIT $${params.length}`; }
  const { rows } = await db.query(sql, params);
  return rows;
}

async function getFinding(scope, findingKey, db) {
  const { rows } = await db.query('SELECT * FROM lt_ppe_finding WHERE scope = $1 AND finding_key = $2', [scope, findingKey]);
  return rows[0] || null;
}

module.exports = { persistRun, decideFinding, listFindings, getFinding, upsertRecord, rowToRecord, _internals: { msToTs, tsToMs } };
