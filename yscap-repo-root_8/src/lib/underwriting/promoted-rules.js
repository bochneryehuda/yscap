'use strict';
/**
 * Promoted training-proposal APPLIER — R2.7 (owner-directed 2026-07-22).
 *
 * The self-training loop (Sovereign 4/4) already captures every underwriter
 * correction and produces CANDIDATE improvements in `training_proposals`. A
 * super-admin promotes each one (`status='promoted'`) from the admin queue.
 * Until now, `status='promoted'` was purely descriptive — no runtime path
 * READ that column. This module closes the loop: the store's finding-insert
 * path consults `effectiveRules(client)` and APPLIES the promoted rules to
 * every finding before it's persisted.
 *
 * Supported proposal_type values (matches learning.proposeImprovements):
 *   * suppress_finding    — drop any finding with the matching code entirely
 *                            (still audit-visible via a `pilot_suppressed`
 *                            log so a reviewer can inspect what was dropped
 *                            when opening the training queue).
 *   * downgrade_severity  — lower a finding's severity by one step per
 *                            proposed_change.direction === 'down_one_step'
 *                            (fatal → warning → info).
 *   * upgrade_severity    — raise a finding's severity by one step per
 *                            proposed_change.direction === 'up_one_step'.
 *
 * TTL cache: rules change on a super-admin action, not per request, so a
 * 60-second in-process cache is fine — the trade-off is a rule promoted at
 * 14:00 takes effect at most 60s later. Cheap to invalidate manually by
 * calling `_reset()` if a promoter wants immediate effect.
 *
 * Pure module: no HTTP, no AI. Every DB call is on the caller's client so
 * a rollback rolls back nothing here (we never write from this path).
 */
// document_findings.severity CHECK allows 'fatal' | 'warning' | 'info'.
// 'dismiss' is a synthetic terminal — a rule that downgrades an 'info' to
// 'dismiss' means "suppress it entirely" (moved into `suppressed` alongside
// direct suppress_finding hits so the reviewer sees it in the training log).
const SEVERITY_ORDER = ['dismiss', 'info', 'warning', 'fatal'];

let _cache = { at: 0, rules: null };
const TTL_MS = 60 * 1000;

// The pure applier — takes an array of findings + a shape { suppress: Set,
// downgrade: Set, upgrade: Set } and returns { findings, suppressed:[...],
// protectedFatal:[...] }.
//
// R5.4 SAFETY GATE (owner-directed 2026-07-22 review): a LEARNED rule may
// never remove a FATAL finding from a file. Until the full offline evaluation
// gate (replay + shadow + release approval) exists, a promoted suppress_finding
// or downgrade_severity rule is INERT on a fatal finding — the finding is KEPT
// at fatal and recorded in `protectedFatal` so a reviewer sees the rule tried
// to hide a fatal. This preserves fatal recall (the single most important
// mortgage-safety invariant) no matter what a learned rule says. Non-fatal
// suppress/downgrade behavior is unchanged.
function applyRules(findings, rules) {
  if (!Array.isArray(findings) || !findings.length || !rules) {
    return { findings: findings || [], suppressed: [], protectedFatal: [] };
  }
  const out = [];
  const suppressed = [];
  const protectedFatal = [];
  for (const f of findings) {
    const code = String(f && f.code || '');
    if (!code) { out.push(f); continue; }
    const isFatal = (f.severity || 'warning') === 'fatal';
    const wantsSuppress = rules.suppress && rules.suppress.has(code);
    const wantsDowngrade = rules.downgrade && rules.downgrade.has(code);
    // A learned rule that would suppress OR downgrade a FATAL finding is refused.
    if (isFatal && (wantsSuppress || wantsDowngrade)) {
      protectedFatal.push({ code, severity: 'fatal', title: f.title, wouldHave: wantsSuppress ? 'suppress' : 'downgrade' });
      out.push(f);
      continue;
    }
    if (wantsSuppress) {
      suppressed.push({ code, severity: f.severity, title: f.title });
      continue;
    }
    let sev = f.severity || 'warning';
    if (wantsDowngrade) sev = stepDown(sev);
    else if (rules.upgrade && rules.upgrade.has(code)) sev = stepUp(sev);
    // If a downgrade lands at 'dismiss', treat it like a suppress (still record).
    // (Only reachable for a NON-fatal finding — a fatal never gets here.)
    if (sev === 'dismiss') { suppressed.push({ code, severity: f.severity, title: f.title }); continue; }
    out.push({ ...f, severity: sev });
  }
  return { findings: out, suppressed, protectedFatal };
}

function stepDown(sev) {
  const i = SEVERITY_ORDER.indexOf(sev);
  if (i <= 0) return sev;
  return SEVERITY_ORDER[Math.max(0, i - 1)];
}
function stepUp(sev) {
  const i = SEVERITY_ORDER.indexOf(sev);
  if (i < 0) return 'warning';
  return SEVERITY_ORDER[Math.min(SEVERITY_ORDER.length - 1, i + 1)];
}

/**
 * DB — load every promoted rule from the training queue, cache for 60s.
 * Returns { suppress: Set<code>, downgrade: Set<code>, upgrade: Set<code> }.
 * Best-effort: on a DB error returns EMPTY rules (never blocks the caller's
 * finding-insert path).
 */
async function effectiveRules(client) {
  const now = Date.now();
  if (_cache.rules && (now - _cache.at) < TTL_MS) return _cache.rules;
  try {
    const r = await client.query(
      `SELECT proposal_type, scope FROM training_proposals WHERE status='promoted'`);
    const suppress = new Set(), downgrade = new Set(), upgrade = new Set();
    for (const row of r.rows) {
      const scope = row.scope || {};
      const code = scope.finding_code;
      if (!code) continue;
      if (row.proposal_type === 'suppress_finding') suppress.add(code);
      else if (row.proposal_type === 'downgrade_severity') downgrade.add(code);
      else if (row.proposal_type === 'upgrade_severity') upgrade.add(code);
    }
    _cache = { at: now, rules: { suppress, downgrade, upgrade } };
    return _cache.rules;
  } catch (_) {
    // On any DB error — return empty rules AND don't cache the failure, so
    // the next call retries. Never block finding inserts on rule loading.
    return { suppress: new Set(), downgrade: new Set(), upgrade: new Set() };
  }
}

/**
 * Filter+transform a batch of findings through the current promoted rules.
 * Best-effort — an internal error returns the original findings untouched
 * (never blocks the caller's persist).
 */
async function applyPromotedRules(client, findings) {
  try {
    const rules = await effectiveRules(client);
    return applyRules(findings, rules);
  } catch (_) { return { findings: findings || [], suppressed: [], protectedFatal: [] }; }
}

// Force cache invalidation — called by the admin decide route when a
// proposal is promoted or unpromoted so the next finding-insert picks it up
// immediately (no 60s wait).
function _reset() { _cache = { at: 0, rules: null }; }

module.exports = { applyRules, applyPromotedRules, effectiveRules, _reset, _internals: { stepDown, stepUp } };
