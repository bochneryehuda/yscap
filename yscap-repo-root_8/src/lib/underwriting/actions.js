'use strict';
/**
 * The underwriter workflow for a finding — what an underwriter can DO about it. Every
 * finding the engine raises is a decision the underwriter resolves one of these ways.
 * This maps cleanly onto the industry "automated conditioning" model the research
 * recommended (Fannie/Freddie QC + LOS conditioning): a finding either becomes a
 * clearable CONDITION, a DOCUMENT REQUEST, or is cleared/dismissed by a human.
 *
 * Pure + dependency-free. `outcome` is the finding's resulting status:
 *   'open'      — still open (and still blocks CTC if fatal) until the follow-up clears
 *   'resolved'  — closed as handled
 *   'dismissed' — closed as not-an-issue
 */

const ACTIONS = {
  post_condition:   { label: 'Post a condition',        outcome: 'open',      needs: 'note',
    desc: 'Add an underwriting condition the borrower must satisfy; the finding stays open until it clears.' },
  request_document: { label: 'Request a document',      outcome: 'open',      needs: 'note',
    desc: 'Ask the borrower for a specific document; the finding stays open until it arrives and is reviewed.' },
  fix_file:         { label: 'Fix the file',            outcome: 'resolved',  needs: 'value',
    desc: 'The value on the file was wrong; correct it, which resolves the finding.' },
  clear:            { label: 'Clear (confirmed OK)',    outcome: 'resolved',  needs: null,
    desc: 'You verified this is fine; close the finding.' },
  grant_exception:  { label: 'Grant an exception',      outcome: 'resolved',  needs: 'note',
    desc: 'Approve despite the finding, with the reason on record.' },
  dismiss:          { label: 'Dismiss (not an issue)',  outcome: 'dismissed', needs: null,
    desc: 'This is not a real problem; dismiss it.' },
  decline:          { label: 'Decline the file',        outcome: 'resolved',  needs: 'note',
    desc: 'This finding is grounds to decline the loan.' },
  // Severity-adjust actions (#200): the human tells PILOT its severity was
  // mis-rated. The finding STAYS OPEN (still needs a real resolution) — this only
  // records a labeled severity correction the self-training loop learns from
  // (learning.proposeImprovements downgrades/upgrades a code after enough of these).
  downgrade_severity: { label: 'Severity too high',      outcome: 'open',      needs: 'note',
    desc: 'PILOT rated this more serious than it is; record that (the finding stays open) so PILOT rates this kind lower over time.' },
  upgrade_severity:   { label: 'Severity too low',       outcome: 'open',      needs: 'note',
    desc: 'PILOT rated this less serious than it is; record that (the finding stays open) so PILOT rates this kind higher over time.' },
};

// Map the check modules' suggested-action verbs onto canonical underwriter actions.
const ALIAS = {
  keep: 'clear', acknowledge: 'dismiss', custom: 'fix_file',
  request_revision: 'request_document', open_condition: 'post_condition',
  replace: 'fix_file',
};
function canon(a) { return ALIAS[a] || a; }

// Default action menus by severity when a finding doesn't specify its own.
const DEFAULT_FATAL = ['post_condition', 'request_document', 'fix_file', 'grant_exception', 'clear', 'dismiss', 'decline', 'downgrade_severity', 'upgrade_severity'];
const DEFAULT_WARN = ['post_condition', 'request_document', 'fix_file', 'clear', 'dismiss', 'downgrade_severity', 'upgrade_severity'];

/**
 * The ordered list of actions to offer the underwriter for a finding, as catalog entries
 * ({key,label,desc,outcome,needs}). Built from the finding's own suggested `actions`
 * (canonicalized) plus the severity default, deduped, and always allowing clear/dismiss.
 */
function underwriterActions(finding) {
  const f = finding || {};
  const fromFinding = (Array.isArray(f.actions) ? f.actions : []).map(canon);
  const defaults = f.severity === 'fatal' ? DEFAULT_FATAL : DEFAULT_WARN;
  const seen = new Set();
  const keys = [];
  for (const k of [...fromFinding, ...defaults, 'clear', 'dismiss']) {
    if (ACTIONS[k] && !seen.has(k)) { seen.add(k); keys.push(k); }
  }
  return keys.map((k) => ({ key: k, ...ACTIONS[k] }));
}

/** Validate an action + its required input. Returns {ok, outcome} or {ok:false, reason}. */
function validateResolution(action, { note, value } = {}) {
  const a = ACTIONS[canon(action)];
  if (!a) return { ok: false, reason: `unknown action: ${action}` };
  if (a.needs === 'note' && !String(note || '').trim()) return { ok: false, reason: `${a.label} requires a note` };
  if (a.needs === 'value' && (value == null || value === '')) return { ok: false, reason: `${a.label} requires the corrected value` };
  return { ok: true, outcome: a.outcome, action: canon(action) };
}

module.exports = { ACTIONS, underwriterActions, validateResolution, canon };
