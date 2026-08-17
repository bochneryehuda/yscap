'use strict';
/**
 * LT PPE — the durable memory of the ≥200-scenario Lender Price AGREEMENT gate (db/576).
 *
 * `ratesheet-agreement.js` measures the owner's HARD RULE — agree with Lender Price on every LLPA,
 * every eligibility and ineligibility, and the max/min price, to the penny, before a rate sheet is
 * trusted — and returns `summary.gateMet`. Until this module existed that verdict lived exactly as
 * long as the return value was on the stack, and `publishRateSheetVersion` promoted a sheet to the one
 * every quote prices from without consulting it. A rule written down in three places and enforced in
 * none is not a rule; this is what makes it one.
 *
 * THE SPLIT IS THE STANDING ONE HERE: `gateDecision` is PURE (it takes the stored rows and answers
 * whether a sheet is proven) and everything else is a thin reader/writer around it. A rule that lives
 * inside an IO wrapper is a rule no offline test can reach, and this particular rule decides whether a
 * rate sheet may go live.
 *
 * TWO RULES RUN THROUGH ALL OF IT:
 *
 *   1. IT FAILS CLOSED — an unreadable ledger is NOT a passing gate. The whole point is that an
 *      unproven sheet must not be publishable, and "we could not check" is the state most likely to
 *      occur exactly when something is wrong. It is reported as its own reason, never as a pass and
 *      never as a measured failure.
 *   2. "NOT MEASURED" AND "MEASURED AND FAILED" ARE DIFFERENT ANSWERS, and are never collapsed. The
 *      first is the ordinary state of every sheet on the day this lands and is fixed by running the
 *      harness; the second means the sheet disagrees with Lender Price and is fixed by fixing the
 *      sheet. A screen that shows one as the other sends somebody to do the wrong work.
 *
 * LT-only. No RTL imports.
 */

const KIND_RUN = 'run';
const KIND_OVERRIDE = 'override';

// What "measured enough" means, in ONE place. The owner's rule says ~200 scenarios; the number is
// deliberately a named constant rather than a column so it is read in code review rather than found
// in a row somebody edited. A run is only counted on its COMPARABLE scenarios — a 200-scenario battery
// where 190 were incomparable proves almost nothing, and the harness reports both.
const MIN_COMPARABLE_SCENARIOS = 200;

function num(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function int(v) { const n = num(v); return n == null ? 0 : Math.round(n); }

/** A stored row → the reading shape. Postgres returns BIGINT/INTEGER as strings. */
function rowToRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    versionId: row.rate_sheet_version_id,
    kind: row.kind,
    gateMet: row.gate_met === true ? true : (row.gate_met === false ? false : null),
    scenarios: int(row.scenarios),
    comparable: int(row.comparable),
    agreed: int(row.agreed),
    disagreed: int(row.disagreed),
    errors: int(row.errors),
    summary: row.summary || null,
    reason: row.reason || null,
    recordedBy: row.recorded_by || null,
    recordedAt: num(row.recorded_at),
  };
}

/**
 * IS THIS SHEET PROVEN? — PURE, and the one definition.
 *
 * Takes the sheet's records NEWEST FIRST and answers `{ proven, reason, message, run }`. It reads the
 * LATEST word only: a sheet that passed in the morning and failed after a reprice is not proven, and
 * taking "has it ever passed?" would make every regression invisible for the life of the version.
 *
 * An OVERRIDE proves nothing about agreement and never claims to — it is a recorded decision to
 * publish anyway, so it answers `proven:false, reason:'overridden'`. The caller that already applied
 * it knows; a reader must still see that this sheet was never measured.
 */
function gateDecision(records) {
  const list = Array.isArray(records) ? records : [];
  if (!list.length) {
    return {
      proven: false,
      reason: 'never_measured',
      message: 'This rate sheet has never been measured against Lender Price, so nothing is known about whether it agrees.',
      run: null,
    };
  }
  // Newest first. Sorting here rather than trusting the caller's order is deliberate: this decides
  // whether a sheet may go live, and an unsorted list would silently answer on whichever row the
  // database happened to return.
  const sorted = list.slice().sort((a, b) => (num(b && b.recordedAt) || 0) - (num(a && a.recordedAt) || 0));
  const latest = sorted[0];

  if (latest.kind === KIND_OVERRIDE) {
    return {
      proven: false,
      reason: 'overridden',
      message: `This rate sheet was published without a passing agreement run${latest.reason ? `: ${latest.reason}` : '.'}`,
      run: latest,
    };
  }
  // A THIRD ANSWER, and it only became reachable once something actually ran the harness. `gateMet` is
  // `errors === 0 && disagreed === 0 && comparable > 0`, so a run where Lender Price returned no usable
  // answer on a single scenario — the upstream degraded, the account lost its entitlement, our filter
  // matched none of its programs — fails the gate with ZERO disagreements and ZERO errors. Reporting
  // that as "it disagrees" sends somebody to fix a sheet that may be perfectly correct, which is the
  // same collapse this module's header refuses for "never measured" vs "measured and failed". It is
  // NOT proven either: a run that compared nothing proves nothing.
  if (latest.gateMet !== true && latest.comparable === 0) {
    return {
      proven: false,
      reason: 'nothing_comparable',
      message: `The last agreement run priced ${latest.scenarios} scenario${latest.scenarios === 1 ? '' : 's'} and Lender Price gave a usable answer on none of them, so nothing is known about whether this sheet agrees.`,
      run: latest,
    };
  }
  if (latest.gateMet !== true) {
    return {
      proven: false,
      reason: 'disagrees',
      message: `The last agreement run found ${latest.disagreed} disagreement${latest.disagreed === 1 ? '' : 's'} and ${latest.errors} error${latest.errors === 1 ? '' : 's'} against Lender Price.`,
      run: latest,
    };
  }
  // A PASSING run still has to have measured something. `gateMet` is already `errors === 0 &&
  // disagreed === 0 && comparable > 0`, so a battery of three scenarios can satisfy it — which is
  // true and is not the owner's rule. The scale test lives here rather than inside the harness because
  // it is about TRUSTING a sheet, not about measuring one.
  if (latest.comparable < MIN_COMPARABLE_SCENARIOS) {
    return {
      proven: false,
      reason: 'too_few_scenarios',
      message: `The last agreement run agreed on all ${latest.comparable} comparable scenarios, which is fewer than the ${MIN_COMPARABLE_SCENARIOS} this gate asks for.`,
      run: latest,
    };
  }
  return {
    proven: true,
    reason: null,
    message: `Agreed with Lender Price on all ${latest.comparable} comparable scenarios.`,
    run: latest,
  };
}

/**
 * Record one harness run against a rate-sheet version.
 *   opts — { db, versionId, summary (the harness's own), recordedBy, nowMs }
 * The summary is stored VERBATIM alongside the counts pulled out of it, so a verdict can be re-read in
 * detail later without re-running a battery against a vendor that has since repriced.
 */
async function recordRun(scope, opts = {}) {
  const db = opts.db;
  const versionId = opts.versionId;
  if (!versionId) return { ok: false, reason: 'no_version', message: 'An agreement run belongs to a rate-sheet version.' };
  const nowMs = num(opts.nowMs);
  if (nowMs == null) return { ok: false, reason: 'no_clock', message: 'No clock was supplied, so the run cannot be stamped.' };
  const s = opts.summary || {};
  // THE HARNESS CALLS IT `total`. `ratesheet-agreement.summarize()` returns `{ total, agreed,
  // disagreed, incomparable, errors, comparable, gateMet }` — every key this row stores lines up by
  // name EXCEPT the battery size, which it names `total`. Reading `s.scenarios` alone stored a 0 for
  // every real run: a recorded verdict claiming it had compared nothing, next to counts saying it had
  // compared hundreds. Both names are accepted, `scenarios` first so a caller that states it wins.
  const scenarioCount = s.scenarios != null ? s.scenarios : s.total;
  const r = await db.query(
    `INSERT INTO lt_ppe_ratesheet_agreement
       (scope, rate_sheet_version_id, kind, gate_met, scenarios, comparable, agreed, disagreed, errors, summary, recorded_by, recorded_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
     RETURNING *`,
    [scope || 'company', versionId, KIND_RUN, s.gateMet === true,
      int(scenarioCount), int(s.comparable), int(s.agreed), int(s.disagreed), int(s.errors),
      JSON.stringify(s), opts.recordedBy || null, nowMs],
  );
  return { ok: true, record: rowToRecord(r.rows[0]) };
}

/**
 * Record a deliberate publish of an unproven sheet.
 *
 * A REASON IS REQUIRED, and the length floor is not decoration: "ok" is not a reason, and the one
 * question asked when a sheet turns out to be wrong is why it was published unmeasured. `gate_met`
 * stays NULL — an override is not a measurement, and writing false would claim the sheet was measured
 * and failed, which is a different and more damning statement than "nobody has measured it".
 */
async function recordOverride(scope, opts = {}) {
  const db = opts.db;
  const versionId = opts.versionId;
  if (!versionId) return { ok: false, reason: 'no_version', message: 'An override belongs to a rate-sheet version.' };
  const by = opts.recordedBy ? String(opts.recordedBy) : '';
  if (!by) return { ok: false, reason: 'no_author', message: 'Publishing an unmeasured rate sheet records who decided it.' };
  const reason = opts.reason ? String(opts.reason).trim() : '';
  if (reason.length < 8) {
    return { ok: false, reason: 'no_reason', message: 'Say why this rate sheet is being published without a passing agreement run.' };
  }
  const nowMs = num(opts.nowMs);
  if (nowMs == null) return { ok: false, reason: 'no_clock', message: 'No clock was supplied, so the override cannot be stamped.' };
  const r = await db.query(
    `INSERT INTO lt_ppe_ratesheet_agreement
       (scope, rate_sheet_version_id, kind, gate_met, reason, recorded_by, recorded_at)
     VALUES ($1,$2,$3,NULL,$4,$5,$6)
     RETURNING *`,
    [scope || 'company', versionId, KIND_OVERRIDE, reason, by, nowMs],
  );
  return { ok: true, record: rowToRecord(r.rows[0]) };
}

/** Every recorded word about one version, newest first. Append-only, so this is its whole history. */
async function listForVersion(scope, versionId, opts = {}) {
  const db = opts.db;
  const r = await db.query(
    `SELECT * FROM lt_ppe_ratesheet_agreement
      WHERE scope = $1 AND rate_sheet_version_id = $2
      ORDER BY recorded_at DESC`,
    [scope || 'company', versionId],
  );
  return (r.rows || []).map(rowToRecord);
}

/**
 * The gate as a caller asks it: is this version proven?
 *
 * FAILS CLOSED. An unreadable ledger answers `proven:false, reason:'unreadable'` — never a pass, and
 * never `never_measured`, because "we could not check" and "nobody has checked" send a reader to two
 * different places and the first is the one that occurs when something else is already wrong.
 */
async function gateStatus(scope, versionId, opts = {}) {
  if (!versionId) {
    return { proven: false, reason: 'no_version', message: 'No rate-sheet version was named.', run: null };
  }
  let records;
  try {
    records = await listForVersion(scope, versionId, opts);
  } catch (e) {
    return {
      proven: false,
      reason: 'unreadable',
      message: `The agreement record could not be read, so this sheet cannot be treated as proven: ${String((e && e.message) || e).slice(0, 160)}`,
      run: null,
    };
  }
  return gateDecision(records);
}

module.exports = {
  gateDecision, gateStatus, recordRun, recordOverride, listForVersion, rowToRecord,
  MIN_COMPARABLE_SCENARIOS, KIND_RUN, KIND_OVERRIDE,
};
