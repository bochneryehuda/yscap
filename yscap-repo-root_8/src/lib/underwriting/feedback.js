'use strict';
/**
 * The feedback loop — "train" the system on what turned out to be a REAL finding vs a FALSE
 * alarm, learned from how underwriters actually resolved findings. This is the owner's ask:
 * "start training you what means real findings and what doesn't." We don't retrain a model;
 * we measure, per finding type, how often the team acted on it (real) vs threw it away (false),
 * so the desk can see which checks earn their keep and which cry wolf.
 *
 * The signal is already captured on every resolution (document_findings.resolution/status):
 *   REAL  — the finding was acted on: post_condition | request_document | fix_file |
 *           grant_exception | decline  (something had to be done about it)
 *   FALSE — the finding was thrown away: dismiss  (not a real problem)
 *   clear — confirmed OK by a human. Ambiguous on its own (the finding did its job by
 *           prompting a look, but nothing was wrong), so it is counted SEPARATELY and left
 *           OUT of the false-alarm rate rather than dumped on either side.
 *
 * A finding is scored by its RESOLUTION verb whenever one is recorded — even while it is still
 * `open` (a posted condition / requested document is an open finding, but the team DID act on
 * it, so it counts as REAL). Only a finding with no resolution yet is 'pending'.
 *
 * Pure + dependency-free so it is unit-testable; the route feeds it the resolved rows.
 */

// Canonical resolution → bucket. Mirrors actions.js outcomes; unknown/unresolved → 'pending'.
const REAL = new Set(['post_condition', 'request_document', 'fix_file', 'grant_exception', 'decline']);
const FALSE = new Set(['dismiss']);
const NEUTRAL = new Set(['clear']);

function bucketOf(resolution) {
  const r = String(resolution || '').trim();
  if (REAL.has(r)) return 'real';
  if (FALSE.has(r)) return 'false';
  if (NEUTRAL.has(r)) return 'cleared';
  return 'pending';
}

/**
 * Build a per-code report from resolved finding rows. Each row needs at least
 * { code, resolution, status, severity? }. Rows still open (status 'open') are counted as
 * pending and never affect a rate. Returns rows sorted worst-signal-first (highest false rate,
 * then most-seen) so the noisiest checks surface at the top.
 *
 * @param {Array<object>} findings
 * @returns {{ byCode: Array, totals: object }}
 */
function falseAlarmReport(findings = []) {
  const map = new Map();
  for (const f of findings) {
    const code = f && f.code;
    if (!code) continue;
    if (!map.has(code)) map.set(code, { code, severity: f.severity || null, real: 0, false: 0, cleared: 0, pending: 0, total: 0 });
    const row = map.get(code);
    // Score by the resolution verb (post_condition/request_document count as REAL even while the
    // finding is still open). A finding with no resolution yet is 'pending'. A 'superseded' row
    // (a re-analysis replaced it) never carried a human decision — treat it as pending, not a signal.
    const bucket = (f.status === 'superseded' && !f.resolution) ? 'pending' : bucketOf(f.resolution);
    row[bucket] += 1;
    row.total += 1;
    if (!row.severity && f.severity) row.severity = f.severity;
  }

  const byCode = [...map.values()].map((r) => {
    const decided = r.real + r.false; // only real+false enter the rate; cleared/pending excluded
    const falseRate = decided > 0 ? r.false / decided : null;
    return Object.assign(r, {
      decided,
      falseAlarmRate: falseRate,               // 0..1, or null when nothing decided yet
      falseAlarmPct: falseRate == null ? null : Math.round(falseRate * 100),
    });
  }).sort((a, b) => {
    // Worst first: a real rate beats null; among rated, higher false rate first, then volume.
    const ar = a.falseAlarmRate, br = b.falseAlarmRate;
    if (ar == null && br == null) return b.total - a.total;
    if (ar == null) return 1;
    if (br == null) return -1;
    if (br !== ar) return br - ar;
    return b.total - a.total;
  });

  const totals = byCode.reduce((t, r) => {
    t.real += r.real; t.false += r.false; t.cleared += r.cleared; t.pending += r.pending; t.total += r.total;
    return t;
  }, { real: 0, false: 0, cleared: 0, pending: 0, total: 0 });
  const decided = totals.real + totals.false;
  totals.falseAlarmRate = decided > 0 ? totals.false / decided : null;
  totals.falseAlarmPct = totals.falseAlarmRate == null ? null : Math.round(totals.falseAlarmRate * 100);

  return { byCode, totals };
}

module.exports = { falseAlarmReport, bucketOf, _internals: { REAL, FALSE, NEUTRAL } };
