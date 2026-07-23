'use strict';
/**
 * Self-training loop — Sovereign 4/4 (owner-directed 2026-07-21).
 *
 * Every underwriter correction becomes a LABELED EXAMPLE PILOT can learn from.
 * Two capture surfaces call in here:
 *   * store.resolveFinding — when a finding is resolved with a terminal action
 *     (grant_exception / dismiss / clear / decline / post_condition), we
 *     capture a `finding_correction` row snapshotting the decision + whether
 *     the committee's action (if any) agreed with the human.
 *   * twin.confirmByHuman — when a staffer explicitly overrides a canonical
 *     fact, we capture a `fact_correction` row (fact_key + observed vs
 *     corrected + the reason).
 *
 * A periodic proposal engine reads the corrections table + surfaces CANDIDATE
 * IMPROVEMENTS to a review queue. NOTHING auto-promotes to production:
 *   * suppress_finding      — a finding code is a false-positive candidate
 *     when >= N staffers dismiss it under similar conditions.
 *   * downgrade / upgrade   — severity drift when the human's decision
 *     consistently rates the finding differently than PILOT does.
 *   * normalizer_alias      — the fact_correction table shows a normalizer
 *     is treating two-equivalent values as different (e.g. "Bochner" vs
 *     "Bochner Jr." on borrower name).
 *   * committee_prompt_tweak — the committee's action disagreed with the human
 *     >= N times on a code; the specialist lenses need refinement.
 *
 * Pure module: no HTTP, no AI. All I/O is Postgres via a `client` argument.
 * Every function is best-effort — a learning-loop error never breaks
 * upstream underwriting.
 */
let _db = null;
const db = () => (_db || (_db = require('../../db')));

// -------------------------------------------------------------------------
// CAPTURE — called from the resolveFinding / confirmByHuman paths.
// -------------------------------------------------------------------------

// Turn a resolve action verb into a decision label.
const DECISION_BY_ACTION = Object.freeze({
  dismiss:          'false_positive',
  grant_exception:  'granted_exception',
  post_condition:   'needs_condition',
  request_document: 'needs_condition',
  request_revision: 'needs_condition',
  clear:            'cleared',
  keep:             'cleared',
  fix_file:         'confirmed_real',
  decline:          'declined',
  acknowledge:      'false_positive',
});

/**
 * Capture the underwriter's decision on a finding as a labeled correction.
 * Called from store.resolveFinding — best-effort, non-blocking.
 * @param {import('pg').ClientBase} client — caller's tx client
 * @param {object} opts
 *   opts.finding — { id, code, severity, doc_value, file_value, application_id,
 *                    committee_action } (the finding row before/after resolve)
 *   opts.action   — the resolve action verb
 *   opts.actorId  — the staffer id
 *   opts.note     — reviewer note
 */
// Best-effort TX-SAFE runner (audit fix 2026-07-23, found by the CI Postgres
// soak): these captures run on the CALLER's client, usually inside the
// caller's BEGIN/COMMIT. A bare catch swallows the JS error but leaves the
// Postgres transaction ABORTED — every later statement fails 25P02 and the
// COMMIT silently acts as ROLLBACK, so the staff decision the capture was
// riding on reports ok:true and never persists (the repo's #1 bug class,
// "returned 200 but didn't save"). SAVEPOINT/ROLLBACK-TO confines a capture
// failure to the capture (mirrors store.js's evidence_pass). Outside a
// transaction the SAVEPOINT itself fails — run bare (a failure there cannot
// poison anything).
async function txSafe(client, fn) {
  let sp = false;
  try { await client.query('SAVEPOINT learning_capture'); sp = true; } catch (_) { /* not in a tx */ }
  try {
    const out = await fn();
    if (sp) await client.query('RELEASE SAVEPOINT learning_capture').catch(() => {});
    return out;
  } catch (_) {
    if (sp) await client.query('ROLLBACK TO SAVEPOINT learning_capture').catch(() => {});
    return null;
  }
}

async function captureFindingDecision(client, { finding, action, actorId, note } = {}) {
  if (!finding || !finding.id || !action) return null;
  const decision = DECISION_BY_ACTION[String(action)] || null;
  if (!decision) return null;
  const committeeAgreed = finding.committee_action == null ? null : matchesDecision(finding.committee_action, decision);
  return txSafe(client, async () => {
    const r = await client.query(
      `INSERT INTO finding_corrections
         (application_id, finding_id, finding_code, finding_severity,
          original_doc_value, original_file_value, decision, action_taken,
          corrected_by, reviewer_note, committee_action, committee_agreed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [finding.application_id || null, finding.id, finding.code || null, finding.severity || null,
       finding.doc_value != null ? String(finding.doc_value).slice(0, 500) : null,
       finding.file_value != null ? String(finding.file_value).slice(0, 500) : null,
       decision, action, actorId || null,
       note ? String(note).slice(0, 1000) : null,
       finding.committee_action || null,
       committeeAgreed]);
    return r.rows[0].id;
  });
}

// Loose match: did the committee's action (confirm|dismiss|modify|hold) point
// the same way the human's decision did?
function matchesDecision(committeeAction, decision) {
  if (committeeAction === 'confirm' && ['confirmed_real','needs_condition','granted_exception','declined'].includes(decision)) return true;
  if (committeeAction === 'dismiss' && decision === 'false_positive') return true;
  if (committeeAction === 'modify' && ['severity_too_high','severity_too_low','needs_condition','granted_exception'].includes(decision)) return true;
  return false;
}

/**
 * Capture a human's override of a canonical fact.
 * Called from twin.confirmByHuman.
 */
async function captureFactCorrection(client, { appId, factKey, observedValue, correctedValue, actorId, reason } = {}) {
  if (!appId || !factKey) return null;
  return txSafe(client, async () => {
    const r = await client.query(
      `INSERT INTO fact_corrections
         (application_id, fact_key, observed_value, corrected_value, corrected_by, reason)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [appId, factKey,
       observedValue != null ? String(observedValue).slice(0, 500) : null,
       correctedValue != null ? String(correctedValue).slice(0, 500) : null,
       actorId || null,
       reason ? String(reason).slice(0, 500) : null]);
    return r.rows[0].id;
  });
}

// -------------------------------------------------------------------------
// PROPOSE — periodic engine. Aggregates corrections + emits candidate
// improvement rows into training_proposals. Idempotent per (proposal_type,
// scope) — the caller de-dupes by scope hash.
// -------------------------------------------------------------------------

/**
 * Aggregate the finding corrections + fact corrections into a set of pure
 * proposals. Does NOT persist — caller decides which to write, per shadow /
 * champion-challenger rules. Returns an array of candidate proposals.
 *
 * Thresholds (kept conservative — the safer default is FEWER proposals):
 *   * suppress_finding: >= 5 dismisses of the same code across >= 3 files
 *     with false-positive rate >= 70%.
 *   * downgrade_severity: >= 5 corrections marking the severity too high on
 *     the same code, >= 70% of the code's decisions in that direction.
 *   * upgrade_severity: symmetric.
 *   * normalizer_alias: two-equivalent-looking values on the same fact_key
 *     with >= 3 human corrections against the observed form.
 *   * committee_prompt_tweak: >= 5 disagreements between committee and human
 *     on the same finding code, and disagreement rate >= 60%.
 */
async function proposeImprovements(client, opts = {}) {
  client = client || db();
  const proposals = [];

  // 1. suppress_finding: high-dismiss codes.
  const dismissQ = await client.query(
    `SELECT finding_code,
            count(*)::int AS total,
            sum((decision = 'false_positive')::int)::int AS dismisses,
            count(DISTINCT application_id)::int AS files
       FROM finding_corrections
      WHERE captured_at > now() - interval '90 days' AND finding_code IS NOT NULL
      GROUP BY finding_code
      HAVING count(*) >= 5`);
  for (const r of dismissQ.rows) {
    const rate = r.total > 0 ? r.dismisses / r.total : 0;
    if (r.dismisses >= 5 && r.files >= 3 && rate >= 0.7) {
      proposals.push({
        proposal_type: 'suppress_finding',
        scope: { finding_code: r.finding_code },
        supporting_sample_size: r.total,
        proposed_change: { current_behavior: 'raise', proposed_behavior: 'suppress_by_default_unless_review_flag' },
        rationale: `Underwriters dismissed ${r.dismisses}/${r.total} occurrences of ${r.finding_code} across ${r.files} file(s) in the last 90 days (${Math.round(rate * 100)}% false-positive rate).`,
      });
    }
  }

  // 2. severity drift — the human's decision consistently rates the finding
  //    differently than PILOT does.
  const severityQ = await client.query(
    `SELECT finding_code,
            count(*) FILTER (WHERE decision = 'severity_too_high')::int AS too_high,
            count(*) FILTER (WHERE decision = 'severity_too_low')::int AS too_low,
            count(*)::int AS total
       FROM finding_corrections
      WHERE captured_at > now() - interval '90 days' AND finding_code IS NOT NULL
      GROUP BY finding_code
      HAVING count(*) >= 5`);
  for (const r of severityQ.rows) {
    if (r.too_high >= 5 && r.too_high / r.total >= 0.7) {
      proposals.push({
        proposal_type: 'downgrade_severity',
        scope: { finding_code: r.finding_code },
        supporting_sample_size: r.total,
        proposed_change: { direction: 'down_one_step' },
        rationale: `${r.too_high}/${r.total} corrections on ${r.finding_code} in the last 90 days flagged the severity as too high.`,
      });
    }
    if (r.too_low >= 5 && r.too_low / r.total >= 0.7) {
      proposals.push({
        proposal_type: 'upgrade_severity',
        scope: { finding_code: r.finding_code },
        supporting_sample_size: r.total,
        proposed_change: { direction: 'up_one_step' },
        rationale: `${r.too_low}/${r.total} corrections on ${r.finding_code} in the last 90 days flagged the severity as too low.`,
      });
    }
  }

  // 3. committee prompt drift — the panel keeps disagreeing with the human.
  const commQ = await client.query(
    `SELECT finding_code,
            count(*)::int AS total,
            sum((committee_agreed IS FALSE)::int)::int AS disagreements
       FROM finding_corrections
      WHERE captured_at > now() - interval '90 days'
        AND finding_code IS NOT NULL AND committee_agreed IS NOT NULL
      GROUP BY finding_code
      HAVING count(*) >= 5`);
  for (const r of commQ.rows) {
    if (r.disagreements >= 5 && r.disagreements / r.total >= 0.6) {
      proposals.push({
        proposal_type: 'committee_prompt_tweak',
        scope: { finding_code: r.finding_code },
        supporting_sample_size: r.total,
        proposed_change: { hint: 'The panel needs an additional lens or a refined applies_to for this code.' },
        rationale: `Committee action disagreed with the human decision on ${r.disagreements}/${r.total} recent resolves for ${r.finding_code} (${Math.round(r.disagreements / r.total * 100)}%).`,
      });
    }
  }

  // 4. normalizer aliases from fact_corrections — the same fact_key sees
  //    repeated corrections where observed vs corrected differ only in
  //    format (case / whitespace / suffix). Flags the normalizer.
  const aliasQ = await client.query(
    `SELECT fact_key, count(*)::int AS n
       FROM fact_corrections
      WHERE captured_at > now() - interval '90 days'
      GROUP BY fact_key
      HAVING count(*) >= 3`);
  for (const r of aliasQ.rows) {
    proposals.push({
      proposal_type: 'normalizer_alias',
      scope: { fact_key: r.fact_key },
      supporting_sample_size: r.n,
      proposed_change: { hint: 'Review the recent fact_corrections for this fact_key and extend the normalizer for the observed-vs-corrected pairs.' },
      rationale: `${r.n} human corrections on ${r.fact_key} in the last 90 days — the reconciler is treating two-equivalent values as different.`,
    });
  }

  return proposals;
}

/**
 * Persist a batch of proposals to the review queue. Never insert a duplicate
 * of an already-pending proposal with the same (proposal_type, scope).
 */
async function persistProposals(client, proposals) {
  client = client || db();
  let inserted = 0;
  for (const p of proposals || []) {
    try {
      const dup = await client.query(
        `SELECT 1 FROM training_proposals
          WHERE proposal_type=$1 AND scope=$2::jsonb AND status='pending'`,
        [p.proposal_type, JSON.stringify(p.scope || {})]);
      if (dup.rowCount) continue;
      await client.query(
        `INSERT INTO training_proposals
           (proposal_type, scope, supporting_correction_ids, supporting_sample_size,
            proposed_change, rationale, status)
         VALUES ($1,$2::jsonb,$3,$4,$5::jsonb,$6,'pending')`,
        [p.proposal_type, JSON.stringify(p.scope || {}),
         Array.isArray(p.supporting_correction_ids) ? p.supporting_correction_ids : [],
         p.supporting_sample_size || 0,
         JSON.stringify(p.proposed_change || {}),
         p.rationale || '']);
      inserted += 1;
    } catch (_) { /* per-proposal failures don't stop the batch */ }
  }
  return { inserted };
}

/**
 * The full "training run" — aggregate + persist. Called periodically (e.g.
 * from a nightly job). Best-effort — returns { proposalsFound, inserted }.
 */
async function runTraining(client) {
  client = client || db();
  const proposals = await proposeImprovements(client);
  const { inserted } = await persistProposals(client, proposals);
  return { proposalsFound: proposals.length, inserted };
}

/**
 * captureAdminAnswer — R3.7/R3.20. When the AI asks the super-admin via
 * ai-suggestions.askAdmin() and the super-admin answers, this records the
 * Q+A as a training_proposal (proposal_type='admin_answer'). Best-effort:
 * a DB failure returns null; never throws.
 *
 * Scope shape: { agent, question, application_id, context } — enough for
 * a future runTraining pass to spot patterns ("agent X keeps asking about
 * bank statements missing pages — auto-suggest missing-page finding
 * from now on").
 */
async function captureAdminAnswer(client, { applicationId, agent, question, answer, context } = {}) {
  if (!agent || !question || !answer) return null;
  const c = client || db();
  return txSafe(c, async () => {
    // Idempotent per (agent, hash(question) — same question re-asked doesn't
    // stack). Uses a small SELECT-first + INSERT; no unique index needed.
    const key = `admin_answer:${agent}:${Buffer.from(String(question)).toString('base64').slice(0, 40)}`;
    const scope = { agent, question: String(question).slice(0, 4000), application_id: applicationId || null,
      context: context || {}, key };
    const exists = await c.query(
      `SELECT id FROM training_proposals WHERE proposal_type='admin_answer' AND scope->>'key'=$1 LIMIT 1`, [key]);
    let id;
    if (exists.rows[0]) {
      // Overlay the latest answer + timestamp so re-asks refresh the row instead of stacking.
      await c.query(
        `UPDATE training_proposals
            SET scope = jsonb_set(jsonb_set(scope, '{answer}', to_jsonb($2::text), true),
                                  '{answered_at}', to_jsonb($3::text), true),
                proposed_at = now()
          WHERE id=$1`,
        [exists.rows[0].id, String(answer), new Date().toISOString()]);
      id = exists.rows[0].id;
    } else {
      scope.answer = String(answer);
      scope.answered_at = new Date().toISOString();
      const ins = await c.query(
        `INSERT INTO training_proposals (proposal_type, scope, status, evidence_json)
         VALUES ('admin_answer', $1::jsonb, 'pending', $2::jsonb)
         RETURNING id`,
        [JSON.stringify(scope), JSON.stringify({ source: 'ask_admin' })]);
      id = ins.rows[0].id;
    }
    return id;
  });
}

module.exports = {
  DECISION_BY_ACTION, matchesDecision,
  captureFindingDecision, captureFactCorrection, captureAdminAnswer,
  proposeImprovements, persistProposals, runTraining,
};
