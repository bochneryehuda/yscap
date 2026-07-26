'use strict';
/**
 * #197 — Whole-loan run COCKPIT composer (read-only presentational layer).
 *
 * run.js persists an immutable underwriting run per material event (schema
 * db/266). The staff file view wants that run folded into ONE at-a-glance panel:
 *   • the current run's decision (status + the three gates),
 *   • what CHANGED since the previous run (run-diff.js),
 *   • the ordered "what to do next" worklist (next-actions.js), and
 *   • the findings rolled up by category (findings-digest.js).
 *
 * This module is the composer. It has a PURE core — `composeCockpit()` folds two
 * already-loaded runs + the file's conditions into the panel payload, with no DB
 * and no I/O (unit-testable) — and a thin DB loader — `loadRunCockpit()` — that
 * reads the latest two persisted runs (+ their findings) and the file's open
 * conditions, then calls the pure core.
 *
 * ADVISORY / read-only. It SUMMARIZES already-computed, already-persisted runs; it
 * runs nothing, decides nothing, changes no status, clears no condition, and never
 * touches a frozen pricing number. NEVER THROWS from the pure core — hostile input
 * degrades to a safe empty panel. The DB loader returns null on any load failure.
 */

const runDiff = require('./run-diff');
const nextActions = require('./next-actions');
const findingsDigest = require('./findings-digest');
const uwStatus = require('./uw-status');

function obj(v) { try { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (_e) { return {}; } }
function arr(v) { try { return Array.isArray(v) ? v : []; } catch (_e) { return []; } }

// Reconstruct a decision.decide()-shaped object from a PERSISTED run row + its
// findings so the pure presentational modules (run-diff / next-actions /
// findings-digest) — which all read a decision's status, gates, and `registry` —
// can consume a stored run exactly like a freshly-computed decision. The stored
// findings table carries snake_case blocks_* + severity/category/code, which is
// precisely the shape those modules already tolerate.
function runToDecision(run, findings) {
  const r = obj(run);
  return {
    status: r.status != null ? String(r.status) : null,
    // both casings so run-diff's snake/camel-tolerant gate reader always matches
    term_sheet_eligible: r.term_sheet_eligible === true,
    ctc_eligible: r.ctc_eligible === true,
    funding_eligible: r.funding_eligible === true,
    termSheetEligible: r.term_sheet_eligible === true,
    ctcEligible: r.ctc_eligible === true,
    fundingEligible: r.funding_eligible === true,
    registry: arr(findings).map((f) => {
      const ff = obj(f);
      return {
        code: ff.code != null ? String(ff.code) : null,
        severity: ff.severity != null ? String(ff.severity) : null,
        category: ff.category != null ? String(ff.category) : null,
        title: ff.title != null ? String(ff.title) : null,
        explanation: ff.explanation != null ? String(ff.explanation) : null,
        governing_rule: ff.governing_rule != null ? String(ff.governing_rule) : null,
        expected_value: ff.expected_value != null ? String(ff.expected_value) : null,
        actual_value: ff.actual_value != null ? String(ff.actual_value) : null,
        blocks_term_sheet: ff.blocks_term_sheet === true,
        blocks_ctc: ff.blocks_ctc === true,
        blocks_funding: ff.blocks_funding === true,
      };
    }),
  };
}

// Take a runToDecision()-shaped object (status + gate flags + registry) and add
// the two derived fields the decision.decide() result carries that the explainer /
// exporter also read — blockingFindings (the registry entries that block a gate or
// are fatal, filtered EXACTLY as decision.js does) and reasons (the same plain
// machine reasons decision.js builds). This lets a PERSISTED run drive the "Why?"
// explainer and the findings CSV exactly like a freshly-computed decision, without
// re-running the whole underwriting engine. PURE. NEVER THROWS.
function enrichDecision(base) {
  try {
    const d = obj(base);
    const registry = arr(d.registry);
    const blockingFindings = registry.filter((f) => {
      const ff = obj(f);
      return ff.blocks_term_sheet === true || ff.blocks_ctc === true || ff.blocks_funding === true
        || String(ff.severity == null ? '' : ff.severity).toLowerCase() === 'fatal';
    });
    const fatal = blockingFindings.filter((f) => String(obj(f).severity == null ? '' : obj(f).severity).toLowerCase() === 'fatal').length;
    const reasons = [];
    try { const br = uwStatus.blockReason(d.status); if (br) reasons.push(br); } catch (_e) { /* keep going */ }
    if (fatal > 0) reasons.push(`${fatal} fatal finding(s) open.`);
    return Object.assign({}, d, { blockingFindings, reasons });
  } catch (_e) {
    return Object.assign({}, obj(base), { blockingFindings: [], reasons: [] });
  }
}

// A compact, presentational summary of a run row (never the raw snapshot).
function runSummary(run) {
  const r = obj(run);
  if (!r.id) return null;
  return {
    id: r.id,
    asOf: r.as_of || r.created_at || null,
    trigger: r.trigger || null,
    programKey: r.program_key || null,
    status: r.status || null,
    gates: {
      termSheet: r.term_sheet_eligible === true,
      ctc: r.ctc_eligible === true,
      funding: r.funding_eligible === true,
    },
    superseded: r.superseded_at != null,
  };
}

/**
 * composeCockpit({ current, previous, conditions, now }, opts?) → {
 *   hasRun: boolean,
 *   current: runSummary | null,
 *   previous: runSummary | null,
 *   decision: { status, gates:{termSheet,ctc,funding} } | null,
 *   diff: diffRuns() result | null,       // null when there is no previous run
 *   nextActions: buildNextActions() result,
 *   findingsDigest: digestFindings() result,
 *   findingCount: number,
 * }
 *   current / previous: { run: <run row>, findings: [<run finding rows>] }
 *   conditions: raw checklist condition rows (aged internally by next-actions)
 *   opts: { borrowerSafe? } — forwarded to the presentational modules
 * NEVER THROWS.
 */
function composeCockpit(input, opts = {}) {
  try {
    const i = obj(input);
    const borrowerSafe = !!(opts && opts.borrowerSafe);
    const cur = obj(i.current);
    const prev = obj(i.previous);
    const curRun = obj(cur.run);
    const hasRun = curRun.id != null;

    const curDecision = hasRun ? runToDecision(curRun, cur.findings) : null;
    const prevRun = obj(prev.run);
    const prevDecision = prevRun.id != null ? runToDecision(prevRun, prev.findings) : null;

    const diff = (curDecision && prevDecision)
      ? runDiff.diffRuns(prevDecision, curDecision, { borrowerSafe })
      : null;

    const actions = nextActions.buildNextActions(
      { decision: curDecision, conditions: arr(i.conditions), now: i.now },
      {}
    );
    const digest = findingsDigest.digestFindings(curDecision, { borrowerSafe });

    return {
      hasRun,
      current: runSummary(curRun),
      previous: runSummary(prevRun),
      decision: hasRun
        ? {
          status: curDecision.status,
          gates: {
            termSheet: curDecision.term_sheet_eligible,
            ctc: curDecision.ctc_eligible,
            funding: curDecision.funding_eligible,
          },
        }
        : null,
      diff,
      nextActions: actions,
      findingsDigest: digest,
      findingCount: hasRun ? arr(cur.findings).length : 0,
    };
  } catch (_e) {
    return {
      hasRun: false, current: null, previous: null, decision: null, diff: null,
      nextActions: nextActions.buildNextActions({}, {}),
      findingsDigest: findingsDigest.digestFindings({}, {}),
      findingCount: 0,
    };
  }
}

// Load a run's findings from the immutable findings table (db/266).
async function loadRunFindings(db, runId) {
  if (!runId) return [];
  const res = await db.query(
    `SELECT code, severity, category, title, explanation, governing_rule,
            expected_value, actual_value, blocks_term_sheet, blocks_ctc, blocks_funding
       FROM underwriting_run_findings WHERE run_id = $1 ORDER BY created_at`, [runId]);
  return res.rows || [];
}

/**
 * loadRunCockpit(applicationId, db, opts?) → composeCockpit() payload | null.
 * Reads the latest TWO persisted runs (+ their findings) and the file's
 * conditions, then composes the panel. Read-only. Returns a hasRun:false payload
 * when the file has never been run, and null on a hard load error.
 */
async function loadRunCockpit(applicationId, db, opts = {}) {
  if (!applicationId || !db) return null;
  try {
    const runsRes = await db.query(
      `SELECT id, application_id, as_of, trigger, source_hash, program_key, status,
              term_sheet_eligible, ctc_eligible, funding_eligible, superseded_at, created_at
         FROM underwriting_runs WHERE application_id = $1
        ORDER BY created_at DESC LIMIT 2`, [applicationId]);
    const runs = runsRes.rows || [];
    const currentRow = runs[0] || null;
    const previousRow = runs[1] || null;

    let curFindings = [];
    let prevFindings = [];
    if (currentRow) curFindings = await loadRunFindings(db, currentRow.id);
    if (previousRow) prevFindings = await loadRunFindings(db, previousRow.id);

    // The file's conditions, for the next-actions worklist (aged internally).
    let conditions = [];
    try {
      const condRes = await db.query(
        `SELECT ci.id, COALESCE(t.label, t.code) AS title, t.code, ci.status,
                ci.created_at AS opened_at, ci.created_at
           FROM checklist_items ci JOIN checklist_templates t ON t.id = ci.template_id
          WHERE ci.application_id = $1`, [applicationId]);
      conditions = condRes.rows || [];
    } catch (_) { conditions = []; }

    return composeCockpit(
      {
        current: { run: currentRow, findings: curFindings },
        previous: { run: previousRow, findings: prevFindings },
        conditions,
        now: opts && opts.now,
      },
      { borrowerSafe: !!(opts && opts.borrowerSafe) }
    );
  } catch (_e) {
    return null;
  }
}

/**
 * loadCurrentDecision(applicationId, db, opts?) → a decision.decide()-shaped object
 * (status, *Eligible flags, registry, blockingFindings, reasons) reconstructed from
 * the file's LATEST persisted underwriting run + its findings, or null when the file
 * has never been run (or on a hard load error). This is the read-only bridge that
 * feeds the "Why?" explainer (decision-explainer.js) and the findings CSV export
 * (findings-export.js) off the immutable run tables — it re-runs nothing and decides
 * nothing. Read-only. NEVER THROWS (returns null).
 */
async function loadCurrentDecision(applicationId, db, opts = {}) {
  if (!applicationId || !db) return null;
  try {
    const runsRes = await db.query(
      `SELECT id, status, term_sheet_eligible, ctc_eligible, funding_eligible, as_of, created_at
         FROM underwriting_runs WHERE application_id = $1
        ORDER BY created_at DESC LIMIT 1`, [applicationId]);
    const run = (runsRes.rows || [])[0] || null;
    if (!run || run.id == null) return null;
    const findings = await loadRunFindings(db, run.id);
    const decision = enrichDecision(runToDecision(run, findings));
    // stamp the run identity so a caller can show "as of <when>" without a second read.
    decision.runId = run.id;
    decision.asOf = run.as_of || run.created_at || null;
    return decision;
  } catch (_e) {
    return null;
  }
}

module.exports = { composeCockpit, loadRunCockpit, loadCurrentDecision, _internals: { runToDecision, enrichDecision, runSummary, loadRunFindings } };
