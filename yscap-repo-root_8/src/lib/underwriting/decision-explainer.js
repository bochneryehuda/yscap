'use strict';
/**
 * R6.16 / R6.19 — Whole-loan decision EXPLAINER (deterministic core, ADVISORY / display).
 *
 * decision.js (R6.14) turns a whole-loan run into ONE final status plus the term-
 * sheet / CTC / funding eligibility gates, a list of blocking findings, and terse
 * machine reasons. The file-view "Why?" panel — and any human-facing surface —
 * needs that turned into a plain, structured explanation: what the verdict IS in
 * everyday words, WHICH gate is blocked and by what, and WHAT to do next. This is
 * that formatter: a DETERMINISTIC, non-authoritative explainer (the authoritative
 * decision stays decision.js; the AI explainer R6.19 is separate and advisory).
 *
 * A `borrowerSafe` mode swaps in borrower-friendly status language and scrubs any
 * note-buyer / capital-partner name out of finding text (CLAUDE.md hard rule).
 *
 * PURE: no DB, no AI, no I/O. It FORMATS an already-computed decision; it decides
 * nothing, changes no status, gates nothing. Advisory / presentational. NEVER
 * THROWS — hostile input degrades to a safe "cannot explain" result.
 */

// Per-status plain-language copy. `verdict` buckets the status for UI coloring.
const STATUS_COPY = Object.freeze({
  ELIGIBLE: {
    verdict: 'ready',
    staff: 'Eligible — clears the program and is ready to move forward.',
    borrower: 'Your loan is on track — everything checks out so far.',
  },
  MANUAL_APPROVED: {
    verdict: 'ready',
    staff: 'Approved with an exception — a super-admin has signed off, terms may issue.',
    borrower: 'Your loan is approved and ready to move forward.',
  },
  MANUAL_PENDING: {
    verdict: 'needs_review',
    staff: 'Needs a super-admin exception approval before terms can issue.',
    borrower: 'Your file is with our team for a final review before we send terms.',
  },
  NOT_READY: {
    verdict: 'needs_review',
    staff: 'Not ready — required facts are still missing.',
    borrower: 'We still need a few items before we can finalize your terms.',
  },
  DATA_CONFLICT: {
    verdict: 'blocked',
    staff: 'A material value disagrees across systems/documents — resolve before proceeding.',
    borrower: 'We are double-checking a detail on your file before moving ahead.',
  },
  STALE: {
    verdict: 'needs_review',
    staff: 'The structure changed after pricing/approval — underwriting must be re-run.',
    borrower: 'A change was made, so our team is refreshing your numbers.',
  },
  INELIGIBLE: {
    verdict: 'blocked',
    staff: 'Ineligible — the loan fails a non-waivable program rule.',
    borrower: 'This scenario does not fit the program as structured — your loan officer will reach out with options.',
  },
});
const UNKNOWN_COPY = { verdict: 'needs_review', staff: 'Status not recognized — review by hand.', borrower: 'Your file is under review.' };

const GATE_LABEL = Object.freeze({ term_sheet: 'Term sheet', ctc: 'Clear to close', funding: 'Funding' });

// Defense-in-depth partner-name scrub (pure). Loaded lazily + guarded.
let _scrubText = null;
try { _scrubText = require('../borrower-safe').scrubText; } catch (_e) { _scrubText = null; }
function scrub(s, on) { try { return on && _scrubText && typeof s === 'string' ? _scrubText(s) : s; } catch (_e) { return s; } }

function str(v) {
  try { if (v == null) return null; if (typeof v === 'string') return v.trim() || null; if (typeof v === 'number' || typeof v === 'boolean') return String(v); return null; }
  catch (_e) { return null; }
}
function arr(v) { try { return Array.isArray(v) ? v : []; } catch (_e) { return []; } }

// Pull the per-gate eligibility flag, tolerating camel/snake shapes.
function gateAllowed(d, gate) {
  try {
    switch (gate) {
      case 'term_sheet': return pick(d, 'termSheetEligible', 'term_sheet_eligible');
      case 'ctc': return pick(d, 'ctcEligible', 'ctc_eligible');
      case 'funding': return pick(d, 'fundingEligible', 'funding_eligible');
      default: return false;
    }
  } catch (_e) { return false; }
}
function pick(o, camel, snake) { if (o && o[camel] !== undefined) return !!o[camel]; if (o && o[snake] !== undefined) return !!o[snake]; return false; }

/**
 * explainDecision(decision, opts?) → {
 *   status, verdict: 'ready'|'needs_review'|'blocked',
 *   headline,                       // one-line plain status
 *   reasons: [string],              // the decision's machine reasons, kept
 *   gates: [{ gate, label, allowed }],
 *   blockers: [{ title, severity, howTo }],   // from the blocking findings
 *   nextSteps: [string],            // what to do to move forward
 *   plain,                          // a single human paragraph
 * }
 *   decision: a decision.decide() result (status, *Eligible flags, blockingFindings, reasons, summary)
 *   opts: { borrowerSafe? }
 * NEVER THROWS.
 */
function explainDecision(decision, opts = {}) {
  try {
    const d = decision && typeof decision === 'object' ? decision : {};
    const borrowerSafe = !!(opts && opts.borrowerSafe);
    const status = str(d.status) || 'NOT_READY';
    const copy = STATUS_COPY[status] || UNKNOWN_COPY;
    const headline = borrowerSafe ? copy.borrower : copy.staff;

    // The machine reasons, scrubbed on a borrower surface.
    const reasons = arr(d.reasons).map((r) => scrub(str(r), borrowerSafe)).filter(Boolean);

    const gates = ['term_sheet', 'ctc', 'funding'].map((g) => ({
      gate: g, label: GATE_LABEL[g], allowed: gateAllowed(d, g),
    }));

    // Blocking findings → plain blockers. On a borrower surface, scrub names and
    // drop staff-only internal codes.
    const blockers = arr(d.blockingFindings).map((f) => blockerOf(f, borrowerSafe)).filter(Boolean);

    // The status buckets the verdict, but a status that reads "ready" can still
    // have a gate blocked by an open finding (the finding registry gates
    // independently). Downgrade ready → needs_review when a gate is blocked or a
    // blocker is open, so the verdict never says "ready" while something blocks.
    let verdict = copy.verdict;
    if (verdict === 'ready' && (gates.some((g) => !g.allowed) || blockers.length > 0)) verdict = 'needs_review';

    const nextSteps = nextStepsFor(status, blockers, borrowerSafe);

    const plain = composePlain({ headline, reasons, gates, blockers, verdict, borrowerSafe });

    return { status, verdict, headline, reasons, gates, blockers, nextSteps, plain };
  } catch (_e) {
    return { status: null, verdict: 'needs_review', headline: 'Unable to explain this decision — review by hand.', reasons: [], gates: [], blockers: [], nextSteps: [], plain: 'Unable to explain this decision — review by hand.' };
  }
}

function blockerOf(f, borrowerSafe) {
  try {
    const ff = f || {};
    const severity = (str(ff.severity) || 'fatal').toLowerCase();
    // A finding title / explanation is FREE-FORM, partner-authorable text — a
    // note-buyer name in it can be any string, and scrubText only knows a fixed
    // list. So on a borrower surface we NEVER surface the raw finding text:
    // the title becomes a generic placeholder and the how-to is dropped entirely
    // (the borrower gets the friendly headline + generic next step instead).
    if (borrowerSafe) return { title: 'An item needs attention', severity, howTo: null };
    // the consolidated finding-registry shape carries the detail as `explanation`;
    // a raw finding may carry it as howTo/advice — accept any.
    const title = str(ff.title) || str(ff.message) || str(ff.code) || 'A blocking issue';
    const howTo = str(ff.howTo) || str(ff.how_to) || str(ff.advice) || str(ff.explanation) || null;
    return { title, severity, howTo };
  } catch (_e) { return null; }
}

// Concrete next steps by status — plain and actionable.
function nextStepsFor(status, blockers, borrowerSafe) {
  const steps = [];
  switch (status) {
    case 'NOT_READY':
      steps.push(borrowerSafe ? 'Send the remaining items your loan officer requested.' : 'Collect the missing required facts, then re-run underwriting.');
      break;
    case 'MANUAL_PENDING':
      steps.push(borrowerSafe ? 'No action needed — our team is finishing a review.' : 'Request the super-admin exception approval.');
      break;
    case 'DATA_CONFLICT':
      steps.push(borrowerSafe ? 'No action needed — we are confirming a detail.' : 'Resolve the system/document disagreement (sync review), then re-run.');
      break;
    case 'STALE':
      steps.push(borrowerSafe ? 'No action needed — your numbers are being refreshed.' : 'Re-run underwriting so the decision reflects the current structure.');
      break;
    case 'INELIGIBLE':
      steps.push(borrowerSafe ? 'Your loan officer will follow up with alternatives.' : 'The loan fails a non-waivable rule — restructure or decline.');
      break;
    case 'ELIGIBLE':
    case 'MANUAL_APPROVED':
      steps.push(borrowerSafe ? 'Nothing needed right now — your loan is moving forward.' : 'Proceed — terms may issue.');
      break;
    default:
      steps.push('Review by hand.');
  }
  // Each open blocker suggests clearing it (staff only — borrower gets the generic line above).
  if (!borrowerSafe) {
    for (const b of (blockers || [])) if (b && b.howTo) steps.push(b.howTo);
  }
  // de-dup preserving order
  return steps.filter((s, i) => s && steps.indexOf(s) === i);
}

function composePlain({ headline, reasons, gates, blockers, verdict, borrowerSafe }) {
  try {
    const parts = [headline];
    if (verdict !== 'ready') {
      const blocked = (gates || []).filter((g) => !g.allowed).map((g) => g.label);
      if (blocked.length) parts.push(`Blocked: ${blocked.join(', ')}.`);
      if (!borrowerSafe && reasons && reasons.length) parts.push(reasons.join(' '));
      if (!borrowerSafe && blockers && blockers.length) {
        const n = blockers.length;
        parts.push(`${n} blocking issue${n === 1 ? '' : 's'}: ${blockers.slice(0, 3).map((b) => b.title).join('; ')}${n > 3 ? `; +${n - 3} more` : ''}.`);
      }
    }
    return parts.filter(Boolean).join(' ');
  } catch (_e) { return headline || 'Under review.'; }
}

module.exports = {
  explainDecision,
  STATUS_COPY,
  _internals: { blockerOf, nextStepsFor, composePlain, gateAllowed },
};
