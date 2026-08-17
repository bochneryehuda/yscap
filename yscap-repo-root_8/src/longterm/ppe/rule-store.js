'use strict';
/**
 * LT PPE — the rule + suggestion STORE (Part 3 P5-store / P6 / P7). The durable bridge for
 * lt_ppe_rule (accepted eligibility/bound/pricing rules) and lt_ppe_rule_suggestion (the proposals the
 * review engine mines from Lender Price declines). `db` is a pg pool/client exposing .query().
 *
 * THE LOOP (owner-directed 2026-08-17): the review engine SUGGESTS per-investor rules from Lender
 * Price's declines (disqualify-analysis) → saved here as proposals → a HUMAN accepts one → this writes
 * an lt_ppe_rule and links it back → the accepted overlay rule feeds the engine (rulesForProgram),
 * so our engine now declines exactly what Lender Price declined. Nothing is auto-applied.
 *
 * All decisions about WHAT a rule/suggestion is live in the pure modules (disqualify-analysis,
 * disqualify-crosswalk, rules.js). This module only persists + reads. Scope-based multi-tenant.
 *
 * LT-only. No RTL imports.
 */

const { suggestionCode } = require('./disqualify-analysis');
const coverage = require('./rule-coverage');

function dedupeKeyOf(adjType, reasonText) { return `${adjType || ''}|${String(reasonText || '').trim()}`; }

/**
 * Save the suggestions from an analyzeDisqualifications(...) result. Idempotent: upserts on
 * (scope, investor_label, dedupe_key) and only REFRESHES an 'open' row's evidence — a decided
 * (accepted/dismissed) suggestion is never reopened by a later run. Unmappable reasons are stored with
 * predicate NULL + needs_human=true so they are surfaced for a human, never guessed. Returns
 * { saved, refreshed }.
 */
async function saveSuggestions(db, scope, analysis) {
  const investors = (analysis && Array.isArray(analysis.investors)) ? analysis.investors : [];
  let saved = 0;
  for (const inv of investors) {
    for (const s of (inv.suggestions || [])) {
      await _upsertSuggestion(db, scope, {
        investorLabel: inv.investor, dedupeKey: dedupeKeyOf(s.adjType, s.declineReason), code: s.code,
        kind: s.kind || 'eligibility', source: s.source || 'overlay', predicate: s.when,
        declineReason: s.declineReason, adjType: s.adjType || null, fact: s.fact || null,
        confidence: s.confidence || null, matchedBy: s.matchedBy || null, needsHuman: false,
        programs: s.programs || [], occurrences: s.occurrences || 1,
      });
      saved += 1;
    }
    for (const u of (inv.unmapped || [])) {
      await _upsertSuggestion(db, scope, {
        investorLabel: inv.investor, dedupeKey: dedupeKeyOf(u.adjType, u.reasonText),
        code: suggestionCode('x', u.reasonText), kind: 'eligibility', source: 'overlay', predicate: null,
        declineReason: u.reasonText, adjType: u.adjType || null, fact: null, confidence: null,
        matchedBy: null, needsHuman: true, programs: u.programs || [], occurrences: u.occurrences || 1,
      });
      saved += 1;
    }
  }
  return { saved };
}

async function _upsertSuggestion(db, scope, s) {
  await db.query(
    `INSERT INTO lt_ppe_rule_suggestion
       (scope, investor_label, dedupe_key, code, kind, source, predicate, decline_reason,
        adj_type, fact, confidence, matched_by, needs_human, programs, occurrences)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)
     ON CONFLICT (scope, investor_label, dedupe_key) DO UPDATE
       SET occurrences = EXCLUDED.occurrences, programs = EXCLUDED.programs,
           predicate = EXCLUDED.predicate, needs_human = EXCLUDED.needs_human, updated_at = now()
       WHERE lt_ppe_rule_suggestion.status = 'open'`,
    [scope, s.investorLabel, s.dedupeKey, s.code, s.kind, s.source,
      s.predicate == null ? null : JSON.stringify(s.predicate), s.declineReason, s.adjType, s.fact,
      s.confidence, s.matchedBy, s.needsHuman, JSON.stringify(s.programs || []), s.occurrences]);
}

// Read one suggestion by id (any status), or null.
async function getSuggestion(db, scope, id) {
  const r = await db.query('SELECT * FROM lt_ppe_rule_suggestion WHERE scope = $1 AND id = $2', [scope, id]);
  return r.rows[0] || null;
}

// List suggestions (default: open only). opts { status, investorLabel }.
async function listSuggestions(db, scope, opts = {}) {
  const where = ['scope = $1'];
  const params = [scope];
  if (opts.status !== 'all') { params.push(opts.status || 'open'); where.push(`status = $${params.length}`); }
  if (opts.investorLabel) { params.push(opts.investorLabel); where.push(`investor_label = $${params.length}`); }
  const r = await db.query(`SELECT * FROM lt_ppe_rule_suggestion WHERE ${where.join(' AND ')} ORDER BY occurrences DESC, id`, params);
  return r.rows;
}

/**
 * ACCEPT a suggestion: write an lt_ppe_rule from it (overlay, origin='suggested', carrying the LP
 * decline reason verbatim) and mark the suggestion accepted + linked. ONE transaction. Refuses a
 * suggestion that needs a human (unmapped predicate) or is not open. `opts` { decidedBy, investorId,
 * programId, note }. Returns { ok, ruleId } or { ok:false, error }.
 */
async function acceptSuggestion(db, scope, suggestionId, opts = {}) {
  const client = await (typeof db.getClient === 'function' ? db.getClient() : db.connect());
  try {
    await client.query('BEGIN');
    const sres = await client.query('SELECT * FROM lt_ppe_rule_suggestion WHERE scope = $1 AND id = $2 FOR UPDATE', [scope, suggestionId]);
    const sug = sres.rows[0];
    if (!sug) { await client.query('ROLLBACK'); return { ok: false, error: 'not_found' }; }
    if (sug.status !== 'open') { await client.query('ROLLBACK'); return { ok: false, error: `not_open:${sug.status}` }; }
    if (sug.needs_human || sug.predicate == null) { await client.query('ROLLBACK'); return { ok: false, error: 'needs_human_mapping' }; }

    const rres = await client.query(
      `INSERT INTO lt_ppe_rule
         (scope, investor_id, program_id, code, kind, source, predicate, decline_reason, priority,
          description, origin, lp_decline_reason, created_by)
       VALUES ($1,$2,$3,$4,$5,'overlay',$6::jsonb,$7,$8,$9,'suggested',$10,$11)
       ON CONFLICT (scope,
                    COALESCE(investor_id, '00000000-0000-0000-0000-000000000000'::uuid),
                    COALESCE(program_id, '00000000-0000-0000-0000-000000000000'::uuid), code)
         DO UPDATE SET predicate = EXCLUDED.predicate, decline_reason = EXCLUDED.decline_reason,
                       active = true, updated_at = now()
       RETURNING id`,
      [scope, opts.investorId ?? null, opts.programId ?? null, sug.code, sug.kind,
        JSON.stringify(sug.predicate), sug.decline_reason, 0,
        `Imported from Lender Price: ${sug.decline_reason}`, sug.decline_reason, opts.decidedBy || null]);
    const ruleId = rres.rows[0].id;

    await client.query(
      `UPDATE lt_ppe_rule_suggestion
          SET status = 'accepted', created_rule_id = $3, decided_by = $4, decided_at = now(),
              decision_note = $5, updated_at = now()
        WHERE scope = $1 AND id = $2`,
      [scope, suggestionId, ruleId, opts.decidedBy || null, opts.note || null]);

    await client.query('COMMIT');
    // ADVISORY, AND DELIBERATELY AFTER THE COMMIT. The accept is already durable, so a coverage read
    // that fails can only cost the report, never the rule — and running it inside the transaction
    // would let a read error abort a write a human already authorised.
    const cov = await coverageAfterAcceptSafe(db, scope, opts.investorId ?? null, opts.programId ?? null, sug.code, sug.kind);
    return { ok: true, ruleId, coverage: cov };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* original error matters */ }
    throw e;
  } finally {
    client.release();
  }
}

// Dismiss a suggestion (kept for the record). Returns { ok } or { ok:false, error }.
async function dismissSuggestion(db, scope, suggestionId, opts = {}) {
  const r = await db.query(
    `UPDATE lt_ppe_rule_suggestion
        SET status = 'dismissed', decided_by = $3, decided_at = now(), decision_note = $4, updated_at = now()
      WHERE scope = $1 AND id = $2 AND status = 'open'
      RETURNING id`,
    [scope, suggestionId, opts.decidedBy || null, opts.note || null]);
  return r.rows.length ? { ok: true } : { ok: false, error: 'not_open_or_missing' };
}

// List active rules. opts { investorId, programId, kind }.
async function listRules(db, scope, opts = {}) {
  const where = ['scope = $1', 'active'];
  const params = [scope];
  if (opts.investorId !== undefined) { params.push(opts.investorId); where.push(`investor_id IS NOT DISTINCT FROM $${params.length}`); }
  if (opts.programId !== undefined) { params.push(opts.programId); where.push(`program_id IS NOT DISTINCT FROM $${params.length}`); }
  if (opts.kind) { params.push(opts.kind); where.push(`kind = $${params.length}`); }
  const r = await db.query(`SELECT * FROM lt_ppe_rule WHERE ${where.join(' AND ')} ORDER BY priority, id`, params);
  return r.rows;
}

// Map a stored rule row into the rules.js rule shape (so evaluateRules can consume it directly). This
// is the P7 read: accepted overlay rules feed the engine.
function rowToRule(row) {
  const r = { code: row.code, kind: row.kind, source: row.source, priority: row.priority || 0, description: row.description || null };
  if (row.predicate != null) r.when = row.predicate;
  if (row.kind === 'eligibility') r.declineReason = row.decline_reason || 'ineligible';
  else if (row.kind === 'bound') { r.target = row.bound_target; r.op = row.bound_op; r.value = row.bound_value == null ? null : Number(row.bound_value); }
  else if (row.kind === 'pricing') r.adjustment = row.adjustment || null;
  return r;
}

// Load a program's active rules already in the rules.js shape — house rules (investor_id NULL) plus the
// investor's + the program's. Ready to concat onto a base rule set for evaluateRules.
async function rulesForProgram(db, scope, investorId, programId) {
  const r = await db.query(
    `SELECT * FROM lt_ppe_rule
      WHERE scope = $1 AND active
        AND (investor_id IS NULL OR investor_id = $2)
        AND (program_id IS NULL OR program_id = $3)
        AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now())
      ORDER BY priority, id`,
    [scope, investorId ?? null, programId ?? null]);
  return r.rows.map(rowToRule);
}

/**
 * COVERAGE of the rule set a program will actually evaluate — overlapping PRICING rules (a double
 * charge) and holes between banded rules. Delegates every judgement to `rule-coverage.analyzeRuleSet`;
 * this is only the read that hands it the right set.
 *
 * ⛔ THE SET IS `rulesForProgram`, NOT `listRules`, AND THAT IS THE WHOLE POINT. Two rules collide only
 * if they can both fire on ONE loan, so the set to analyze is exactly the set that evaluates together —
 * house rules plus this investor's plus this program's, effective-dated. Analyzing everything in the
 * table instead would report a house rule against another investor's rule as a double charge, which is
 * a false alarm on two rules that can never meet.
 */
async function coverageForProgram(db, scope, investorId, programId) {
  const rules = await rulesForProgram(db, scope, investorId, programId);
  return coverage.analyzeRuleSet(rules, {
    note: 'the rules this program evaluates: house rules plus this investor\'s plus this program\'s',
  });
}

/**
 * What accepting ONE rule did to the set — the report a human wants right after pressing Accept.
 *
 * ⛔ IT NEVER REFUSES AN ACCEPT, and it is not written to be able to. Coverage is ADVISORY by design
 * (`rule-coverage.js`): it reports, it never blocks a rule. Blocking a human's accept on an advisory
 * finding would also be a dead end — the finding is about the rule set, and the only way to act on it
 * is to look at both rules, which you cannot do from a refused button.
 *
 * ⛔ AN ELIGIBILITY OR BOUND RULE IS NOT OVERLAP-CHECKED, AND IT SAYS SO RATHER THAN RETURNING AN EMPTY
 * LIST. Only PRICING rules can double-charge; declines are collected and bounds tighten, both by
 * design. Nearly every mined suggestion is an eligibility rule, so returning `overlaps: []` for one
 * would put a clean bill of health on the screen for a check that was never run — the exact "silence
 * reads as all-clear" shape this module's own header warns about.
 *
 * ⛔ IT REPORTS THE NEW RULE'S OWN COLLISIONS FIRST. A pre-existing overlap between two OTHER rules is
 * real but is not news about this accept, and re-announcing it on every accept is how a report becomes
 * background noise. It is still counted (`otherOverlaps`) so nothing is hidden.
 */
async function coverageForAcceptedRule(db, scope, investorId, programId, code, kind) {
  if (kind !== 'pricing') {
    return {
      checked: false,
      kind: kind || null,
      why: `a ${kind || 'non-pricing'} rule is not overlap-checked: two matching declines are collected on purpose (a borrower hears both reasons) and two matching bounds tighten — only PRICING adjustments accumulate into a double charge`,
    };
  }
  const report = await coverageForProgram(db, scope, investorId, programId);
  const mine = report.overlaps.filter((o) => (o.rules || []).includes(code));
  return {
    checked: true,
    kind,
    overlaps: mine,
    otherOverlaps: report.overlaps.length - mine.length,
    gaps: report.gaps,
    unanalyzable: report.unanalyzable,
    analyzed: report.analyzed,
  };
}

// Best-effort wrapper for the accept path: a coverage read may never turn a committed accept into a
// failure, so an error becomes a stated `checked:false` rather than a throw or a silent empty report.
async function coverageAfterAcceptSafe(db, scope, investorId, programId, code, kind) {
  try {
    return await coverageForAcceptedRule(db, scope, investorId, programId, code, kind);
  } catch (e) {
    return { checked: false, kind: kind || null, why: `the coverage check could not run (${e && e.message ? e.message : 'unknown error'}) — the rule was accepted either way` };
  }
}

module.exports = {
  dedupeKeyOf, saveSuggestions, listSuggestions, getSuggestion, acceptSuggestion, dismissSuggestion,
  listRules, rowToRule, rulesForProgram,
  coverageForProgram, coverageForAcceptedRule, coverageAfterAcceptSafe,
};
