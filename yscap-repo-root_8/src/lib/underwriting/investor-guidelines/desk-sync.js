'use strict';

/**
 * desk-sync — forwards the investor-guideline OVERLAY's "not happy" items into the
 * real staff finding surface (ai_suggestions), so a note-buyer coverage gap or a
 * guideline conflict actually SURFACES (a fatal notifies the LO/processor via the
 * ai-suggestions fatal-notify path) instead of only appearing inside the Investor
 * Guidelines panel when a human happens to open it.
 *
 * OVERLAY SEMANTICS (owner-directed 2026-07-23): the desk stays quiet unless the
 * note buyer would NOT be happy with the file as-is. This forwards ONLY those
 * unhappy items:
 *   - coverage_gap — the note buyer REQUIRES a condition that is not on the file
 *     at all. FATAL for a construction feasibility report on a ground-up / heavy
 *     rehab file (the owner's "pop up something big"); a warning otherwise.
 *   - conflict — a value on the file is outside the note buyer's guideline.
 * An OPEN condition (the document just hasn't arrived) is FINE and is never raised.
 *
 * ADVISORY ONLY — records ai_suggestions, never blocks, never posts/clears a
 * condition, and touches no frozen number. Best-effort; every entry point is
 * guarded and NEVER throws.
 */

const aiSug = require('../ai-suggestions');

const SOURCE = 'investor_guideline_desk';

/**
 * deskToSuggestions(desk) → Array<ai-suggestions.record payload> (PURE, never throws).
 * Maps a desk result's `unhappy[]` into suggestion payloads. Returns [] for a happy,
 * empty, or malformed desk. Does NOT include applicationId — the DB layer adds it.
 */
function deskToSuggestions(desk) {
  try {
    if (!desk || !Array.isArray(desk.unhappy) || !desk.unhappy.length) return [];
    const nb = (desk.noteBuyer && desk.noteBuyer.name) || 'the note buyer';
    const out = [];
    for (const u of desk.unhappy) {
      if (!u || u.cond_no == null) continue;
      const code = u.pilot_template_code || null;
      const sev = u.severity === 'fatal' ? 'fatal' : 'warning';
      if (u.flag === 'coverage_gap') {
        // The guideline→PILOT crosswalk is many-to-one, so the desk COLLAPSES all the
        // note-buyer requirements that map to ONE missing PILOT condition into a single
        // gap (carrying gapKey + coveredConditions[] + coveredCount). Key the suggestion
        // on that collapsed code — NOT on cond_no — so one absent condition raises ONE
        // "post this" row listing every requirement it satisfies, never N duplicates.
        const covered = Array.isArray(u.coveredConditions) && u.coveredConditions.length
          ? u.coveredConditions
          : [u.name].filter(Boolean);
        const count = u.coveredCount || covered.length || 1;
        // Mirror desk.js's key derivation EXACTLY (trim+lowercase FIRST, then fall back) so a
        // raw item with a whitespace-only pilot code keys identically on both sides.
        const normCode = String(u.pilot_template_code || '').trim().toLowerCase();
        const gapKey = u.gapKey || normCode || `cond:${u.cond_no}`;
        const many = count > 1;
        const reqList = covered.join(', ');
        out.push({
          source: SOURCE, kind: 'condition', severity: sev, important: sev === 'fatal',
          title: many
            ? `${nb} needs ${count} requirements — no condition on the file covers them`
            : `${nb} requires "${u.name}" — no condition on the file`,
          body: (many
            ? `${nb}'s own guidelines require ${count} things that all belong on one condition (${reqList}), but there is no condition on the file covering it.`
            : `${nb}'s own guidelines require this, but there is no condition on the file covering it.`)
            + (sev === 'fatal' ? ' Post one now — the note buyer will not take the file without it.' : '')
            + (u.required_evidence ? ` Needs: ${u.required_evidence}` : ''),
          evidence: { code, domain: u.domain || null, cond_no: u.cond_no, noteBuyer: nb, flag: 'coverage_gap', coveredConditions: covered, coveredCount: count },
          proposedAction: { type: 'attach_condition', fields: { code, cond_no: u.cond_no } },
          dedupeKey: `isg-gap:${gapKey}`,
        });
      } else if (u.flag === 'conflict') {
        const conflicts = Array.isArray(u.checks)
          ? u.checks.filter((k) => k && k.status === 'conflict').map((k) => k.detail || k.text).filter(Boolean)
          : [];
        out.push({
          source: SOURCE, kind: 'finding', severity: 'fatal', important: true,
          title: `"${u.name}" conflicts with ${nb}'s guideline`,
          body: u.reason || `A value on this file is outside ${nb}'s guideline for ${u.name}.`,
          evidence: { code, domain: u.domain || null, cond_no: u.cond_no, noteBuyer: nb, flag: 'conflict', conflicts },
          proposedAction: { type: 'review_guideline_conflict', fields: { code, cond_no: u.cond_no } },
          dedupeKey: `isg-conflict:${u.cond_no}`,
        });
      }
    }
    return out;
  } catch (_e) { return []; }
}

/**
 * syncInvestorGuidelineFindings(client, appId, opts?) → { raised, fatal } (DB, best-effort).
 * Runs the desk for the file (or uses opts.desk if the caller already computed it) and
 * records each unhappy item as an ai_suggestion. Dedupe keys collapse re-fires to one
 * OPEN row per condition, so repeated file views never spam. NEVER throws.
 */
async function syncInvestorGuidelineFindings(client, appId, opts) {
  const o = opts || {};
  try {
    if (!appId || !client) return { raised: 0, fatal: 0 };
    let desk = o.desk || null;
    if (!desk) {
      const deskMod = require('./desk');
      desk = await deskMod.runInvestorGuidelineDesk(appId, client).catch(() => null);
    }
    const payloads = deskToSuggestions(desk);
    let raised = 0, fatal = 0;
    for (const p of payloads) {
      try {
        await aiSug.record(client, Object.assign({ applicationId: appId }, p));
        raised += 1;
        if (p.severity === 'fatal') fatal += 1;
      } catch (_e) { /* one bad row never stops the rest */ }
    }
    return { raised, fatal };
  } catch (_e) { return { raised: 0, fatal: 0 }; }
}

module.exports = { deskToSuggestions, syncInvestorGuidelineFindings, SOURCE };
