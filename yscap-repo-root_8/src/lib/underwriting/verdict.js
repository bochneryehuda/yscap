'use strict';
/**
 * PILOT verdict — the one plain-English headline that tells the owner, at a glance, where the file
 * stands. It composes the signals the desk already computes (the clear-to-close gate, the fraud
 * score, file completeness, the entity chain) into a single status + a short list of reasons, so a
 * non-technical reader doesn't have to assemble the picture from five sections.
 *
 *   status:  'blocked' — a fatal finding is open; the file CANNOT clear to close yet
 *            'review'  — nothing fatal, but there's something to look at (warnings, missing docs,
 *                        elevated risk, a broken/incomplete entity chain)
 *            'clear'   — everything analyzed ties out and nothing is outstanding
 *
 * Pure: no AI, no DB. Fed the already-computed roll-ups.
 */

function computeVerdict({ summary, risk, completeness, entityChain, extractionsCount = 0 } = {}) {
  const s = summary || { fatal: 0, warning: 0, blocksCtc: false };
  const reasons = [];

  // Nothing analyzed yet → a distinct, honest "not started" state (not a false "clear").
  if (!extractionsCount) {
    return { status: 'pending', headline: 'No documents have been read yet — analyze a document to start the review.', reasons: [] };
  }

  const blocked = s.fatal > 0 && s.blocksCtc;
  if (s.fatal > 0) reasons.push(`${s.fatal} fatal finding${s.fatal === 1 ? '' : 's'} to resolve`);
  if (completeness && completeness.ctcBlockers && completeness.ctcBlockers.length) {
    reasons.push(`${completeness.ctcBlockers.length} required document${completeness.ctcBlockers.length === 1 ? '' : 's'} still needed to close`);
  }
  if (entityChain && entityChain.status === 'broken') reasons.push('the entity/ownership chain is broken');
  if (risk && risk.band === 'high') reasons.push(`high fraud/red-flag risk (${risk.score}/100)`);
  else if (risk && risk.band === 'elevated') reasons.push(`elevated fraud/red-flag risk (${risk.score}/100)`);
  if (s.warning > 0) reasons.push(`${s.warning} warning${s.warning === 1 ? '' : 's'} to review`);
  // The note buyer's own guideline read is counted separately from `fatal`/`warning` — it is not
  // clear-to-close work, and mixing it in made the headline claim more blocking work than the gate
  // reports. But it MUST still reach the headline: without a reason of its own, a file whose only
  // open item is a guideline dealbreaker fell through to `status:'clear'` and announced "nothing is
  // outstanding" directly above a red fatal chip (re-audit 2026-07-27). Saying nothing about a real
  // problem is the one failure direction this system does not get to have.
  const g = s.guideline || {};
  const gFatal = Number(g.fatal) || 0;
  const gWarn = Number(g.warning) || 0;
  if (gFatal > 0) reasons.push(`${gFatal} note-buyer dealbreaker${gFatal === 1 ? '' : 's'} the investor would refuse`);
  else if (gWarn > 0) reasons.push(`${gWarn} note-buyer guideline note${gWarn === 1 ? '' : 's'}`);
  if (completeness && typeof completeness.completenessPct === 'number' && completeness.completenessPct < 100) {
    reasons.push(`file ${completeness.completenessPct}% complete`);
  }

  let status, headline;
  if (blocked) {
    status = 'blocked';
    headline = `Not clear to close — ${reasons[0] || 'a fatal finding is open'}.`;
  } else if (reasons.length) {
    status = 'review';
    headline = `Ready to review — ${reasons.slice(0, 2).join(', ')}.`;
  } else {
    status = 'clear';
    headline = 'Everything read ties out and nothing is outstanding — clear on PILOT’s checks.';
  }
  return { status, headline, reasons };
}

module.exports = { computeVerdict };
