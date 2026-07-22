'use strict';
/**
 * Condition Cure Analysis — Sovereign 2/4 (owner-directed 2026-07-21).
 *
 * When a document is attached to a condition to clear it, PILOT no longer just
 * marks the condition "received." It runs a CURE ANALYSIS: each requirement in
 * the condition's intent is checked one-by-one against the document's extracted
 * fields + the loan digital twin's canonical facts. The output — a clearance
 * proof — tells the underwriter which requirements are satisfied, which aren't,
 * why, and any NEW findings the cure document itself surfaced.
 *
 * Pure module: no HTTP, no AI. All I/O is Postgres via a caller-provided
 * `client` (so callers control transactions). Best-effort — a failure to
 * analyze never blocks the document from attaching to the condition; it just
 * means the underwriter has to review manually (what happens today).
 *
 * Assertion vocabulary (kept small and explicit — new assertions register
 * here). Each assertion is a pure function of:
 *   (extractionFields, twinFacts, subject, expectedContext) → { status, reason }
 * where:
 *   extractionFields   — the document's `fields` map (what THIS document said)
 *   twinFacts          — { fact_key: { value_normalized, status, ... } } for the
 *                        file's current canonical facts
 *   subject            — the file subject (from file-view.subjectFor)
 *   expectedContext    — { programMinFico, requiredMonths, closingDate,
 *                          loanAmount, entityName, borrowerName, ... }
 */
let _db = null;
const db = () => (_db || (_db = require('../../db')));
const twin = require('./twin');

// -------------------------------------------------------------------------
// ASSERTIONS — pure functions returning { status: 'satisfied'|'not_satisfied'|
// 'unable_to_determine', reason }. A missing extractionFields entry usually
// yields 'unable_to_determine' rather than 'not_satisfied' — we never guess.
// -------------------------------------------------------------------------
const trim = (v) => String(v == null ? '' : v).trim().toLowerCase();
const same = (a, b) => trim(a) === trim(b);
const money = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? n : null;
};
const iso = (v) => twin.NORMALIZERS['borrower.date_of_birth'] ? twin.NORMALIZERS['borrower.date_of_birth'](v) : (v ? String(v).slice(0, 10) : null);

const ASSERTIONS = Object.freeze({
  // Present: a value is set and non-empty.
  present({ getField, factKey }) {
    const v = getField(factKey);
    if (v == null || v === '') return { status: 'unable_to_determine', reason: 'value not extracted or absent' };
    return { status: 'satisfied', reason: `value present: ${String(v).slice(0, 120)}` };
  },
  // Equals the current canonical fact for this key (with the twin's normalizer).
  equals_file({ getField, factKey, twinFacts }) {
    const observed = getField(factKey);
    if (observed == null || observed === '') return { status: 'unable_to_determine', reason: 'value not extracted from this document' };
    const canonical = twinFacts && twinFacts[factKey];
    if (!canonical || canonical.value_normalized == null) return { status: 'unable_to_determine', reason: 'no canonical fact recorded yet' };
    const observedNorm = twin.normalize(factKey, observed);
    if (observedNorm === canonical.value_normalized) return { status: 'satisfied', reason: `matches the file (${observedNorm})` };
    return { status: 'not_satisfied', reason: `document says "${observedNorm}", file says "${canonical.value_normalized}"` };
  },
  // Boolean-true assertion (e.g. good_standing: true).
  is_true({ getField, factKey }) {
    const v = getField(factKey);
    if (v == null || v === '') return { status: 'unable_to_determine', reason: 'value not extracted' };
    const s = String(v).toLowerCase();
    if (v === true || s === 'true' || s === 'yes' || s === 'active' || s === 'in good standing' || s === 'existing' || s === '1') return { status: 'satisfied', reason: `document reads as active/true` };
    return { status: 'not_satisfied', reason: `document reads as "${v}" (not active/true)` };
  },
  // Clear OFAC — the ofac_result normalizer returns the trimmed lowercase text.
  is_clear({ getField, factKey }) {
    const v = String(getField(factKey) || '').trim().toLowerCase();
    if (!v) return { status: 'unable_to_determine', reason: 'OFAC result not extracted' };
    if (/confirm/.test(v)) return { status: 'not_satisfied', reason: `OFAC result is a confirmed match — HARD STOP` };
    if (/potential|possible|review/.test(v)) return { status: 'not_satisfied', reason: `OFAC returned a potential match that must be adjudicated` };
    if (/^clear|^no\b|^negative/.test(v)) return { status: 'satisfied', reason: `OFAC returned clear` };
    return { status: 'unable_to_determine', reason: `OFAC result phrasing not recognized: "${v}"` };
  },
  // Date > closing date.
  after_closing({ getField, factKey, expected }) {
    const v = iso(getField(factKey));
    const closing = expected && expected.closingDate ? iso(expected.closingDate) : null;
    if (!v) return { status: 'unable_to_determine', reason: 'date not extracted' };
    if (!closing) return { status: 'unable_to_determine', reason: 'closing date not on file' };
    if (v > closing) return { status: 'satisfied', reason: `${v} > closing ${closing}` };
    return { status: 'not_satisfied', reason: `${v} is not after closing ${closing}` };
  },
  before_closing({ getField, factKey, expected }) {
    const v = iso(getField(factKey));
    const closing = expected && expected.closingDate ? iso(expected.closingDate) : null;
    if (!v) return { status: 'unable_to_determine', reason: 'date not extracted' };
    if (!closing) return { status: 'unable_to_determine', reason: 'closing date not on file' };
    if (v <= closing) return { status: 'satisfied', reason: `${v} is on/before closing ${closing}` };
    return { status: 'not_satisfied', reason: `${v} is AFTER closing ${closing}` };
  },
  within_days_90({ getField, factKey }) {
    const v = iso(getField(factKey));
    if (!v) return { status: 'unable_to_determine', reason: 'date not extracted' };
    // Compare against today.
    const d = new Date(v + 'T00:00:00Z');
    if (isNaN(d)) return { status: 'unable_to_determine', reason: `date could not be parsed: ${v}` };
    const now = new Date();
    const ninety = 90 * 24 * 3600 * 1000;
    if (now - d <= ninety && now - d >= 0) return { status: 'satisfied', reason: `${v} is within the last 90 days` };
    return { status: 'not_satisfied', reason: `${v} is older than 90 days` };
  },
  gte_program_min({ getField, factKey, expected }) {
    const v = money(getField(factKey)) || (Number.isFinite(Number(getField(factKey))) ? Number(getField(factKey)) : null);
    const min = expected && expected.programMinFico != null ? Number(expected.programMinFico) : null;
    if (v == null) return { status: 'unable_to_determine', reason: 'FICO not extracted' };
    if (min == null) return { status: 'unable_to_determine', reason: 'program minimum FICO unknown' };
    if (v >= min) return { status: 'satisfied', reason: `${v} >= min ${min}` };
    return { status: 'not_satisfied', reason: `${v} is below program minimum ${min}` };
  },
  gte_loan_amount({ getField, factKey, expected }) {
    const v = money(getField(factKey));
    const loan = expected && expected.loanAmount != null ? money(expected.loanAmount) : null;
    if (v == null) return { status: 'unable_to_determine', reason: 'coverage amount not extracted' };
    if (loan == null) return { status: 'unable_to_determine', reason: 'loan amount not on file' };
    if (v >= loan) return { status: 'satisfied', reason: `coverage ${v} >= loan ${loan}` };
    return { status: 'not_satisfied', reason: `coverage ${v} < loan ${loan}` };
  },
  statement_period_covers_months({ extractionFields, expected }) {
    const months = expected && expected.requiredMonths != null ? Number(expected.requiredMonths) : null;
    if (months == null) return { status: 'unable_to_determine', reason: 'program required month count unknown' };
    const start = iso(extractionFields.periodStart || extractionFields.statementStart);
    const end = iso(extractionFields.periodEnd || extractionFields.statementEnd);
    if (!start || !end) return { status: 'unable_to_determine', reason: 'statement period not extracted' };
    const startD = new Date(start + 'T00:00:00Z'), endD = new Date(end + 'T00:00:00Z');
    const spanMs = endD - startD;
    const wantMs = months * 30 * 24 * 3600 * 1000;
    if (spanMs >= wantMs) return { status: 'satisfied', reason: `${start} → ${end} covers ~${Math.round(spanMs / (30 * 24 * 3600 * 1000))} months (need ${months})` };
    return { status: 'not_satisfied', reason: `${start} → ${end} is under ${months} months` };
  },
  no_undocumented_deposits({ extractionFields }) {
    // The bank-statement extractor exposes deposits[] with { amount, source? }.
    const deposits = Array.isArray(extractionFields.largeDeposits) ? extractionFields.largeDeposits : [];
    const undocumented = deposits.filter((d) => d && (!d.source || String(d.source).trim() === ''));
    if (!deposits.length) return { status: 'satisfied', reason: 'no large deposits flagged' };
    if (undocumented.length === 0) return { status: 'satisfied', reason: `${deposits.length} large deposit(s), all sourced` };
    return { status: 'not_satisfied', reason: `${undocumented.length} large deposit(s) without documented source`, newFinding: {
      code: 'undocumented_large_deposit',
      severity: 'warning',
      title: 'Large deposit(s) on the statement have no documented source',
      docValue: undocumented.map((d) => `${d.amount || ''}`.trim()).join(', '),
      howTo: 'Ask the borrower for the source of each undocumented deposit (transfer receipt, sale document, gift letter, business distribution). An accepted source is either the borrower/entity moving their own money, or an approved gift/loan-with-terms.',
    } };
  },
  no_recent_bankruptcy({ extractionFields }) {
    const bk = extractionFields.recentBankruptcy || extractionFields.bankruptcy;
    if (bk == null || bk === '' || bk === false || bk === 'none' || bk === 'no') return { status: 'satisfied', reason: 'no bankruptcy on the report' };
    return { status: 'not_satisfied', reason: `bankruptcy on report: ${JSON.stringify(bk).slice(0, 200)}`, newFinding: {
      code: 'bankruptcy_on_credit', severity: 'warning',
      title: 'Recent bankruptcy on the credit report — review guideline eligibility',
      howTo: 'Confirm the bankruptcy discharge date meets the program\'s seasoning requirement; if not, this is a decline / exception.',
    } };
  },
  entity_screened_when_present({ extractionFields, subject }) {
    const en = subject && subject.entity_name;
    if (!en) return { status: 'satisfied', reason: 'no borrowing entity on the file — nothing to screen' };
    const screened = extractionFields.entityName || extractionFields.subjectEntity;
    if (!screened) return { status: 'not_satisfied', reason: `entity ${en} was not screened (report screened no entity)`, newFinding: {
      code: 'entity_not_screened', severity: 'warning',
      title: 'The borrowing entity was not screened for OFAC / sanctions',
      docValue: '(no entity screened)', fileValue: en,
      howTo: `Run the screen on ${en} and re-upload the report — an entity can itself be on a sanctions list.`,
    } };
    if (twin.normalize(twin.FACT_KEYS.ENTITY_NAME, screened) === twin.normalize(twin.FACT_KEYS.ENTITY_NAME, en)) {
      return { status: 'satisfied', reason: `entity screened: ${screened}` };
    }
    return { status: 'not_satisfied', reason: `report screened "${screened}" but the file vests in "${en}"` };
  },
  fraud_alerts_cleared({ extractionFields }) {
    const flags = Array.isArray(extractionFields.fraudFlags) ? extractionFields.fraudFlags.filter((s) => String(s || '').trim()) : [];
    if (!flags.length) return { status: 'satisfied', reason: 'no fraud alerts on the report' };
    return { status: 'not_satisfied', reason: `${flags.length} fraud alert(s) to adjudicate: ${flags.slice(0, 3).join(' | ')}` };
  },
  liens_clearable({ extractionFields }) {
    const liens = Array.isArray(extractionFields.liens) ? extractionFields.liens : [];
    const unclearable = liens.filter((l) => l && (l.clearable === false || /judgment|tax/.test(String(l.type || '').toLowerCase())));
    if (!liens.length) return { status: 'satisfied', reason: 'no liens listed' };
    if (unclearable.length === 0) return { status: 'satisfied', reason: `${liens.length} lien(s), all clearable at closing` };
    return { status: 'not_satisfied', reason: `${unclearable.length} lien(s) may not be clearable at closing`, newFinding: {
      code: 'lien_may_not_clear', severity: 'warning',
      title: 'Title report shows a lien that may not clear at closing',
      howTo: 'Confirm each judgment/tax lien can be paid off or released at closing; obtain payoff or release letters.',
    } };
  },
  mortgagee_present({ extractionFields }) {
    const mc = extractionFields.mortgageeClause || extractionFields.mortgagee;
    if (!mc) return { status: 'not_satisfied', reason: 'no mortgagee clause on the binder' };
    return { status: 'satisfied', reason: `mortgagee clause present` };
  },
  flood_policy_when_in_zone({ extractionFields }) {
    const zone = String(extractionFields.floodZone || '').toUpperCase();
    if (!zone) return { status: 'unable_to_determine', reason: 'flood zone not on the determination' };
    if (!/^[AV]/.test(zone)) return { status: 'satisfied', reason: `zone ${zone} does not require flood coverage` };
    const policy = extractionFields.floodPolicyNumber || extractionFields.floodPolicy;
    if (!policy) return { status: 'not_satisfied', reason: `zone ${zone} requires a flood policy — none on file`, newFinding: {
      code: 'flood_policy_missing', severity: 'fatal',
      title: 'Property is in a flood zone but no flood policy is on file',
      howTo: 'Obtain a flood insurance policy or an approved private flood policy for the property before closing.',
    } };
    return { status: 'satisfied', reason: `zone ${zone}, flood policy on file: ${policy}` };
  },
});

// -------------------------------------------------------------------------
// analyze — the top-level cure function. Given a condition + a document
// (identified by their ids) + the extracted fields of that document + the
// file's twin facts, produce a clearance proof.
//
// Pure — no DB writes. Persistence is a separate step (persistProof).
// -------------------------------------------------------------------------
function analyze({ intent, extractionFields = {}, twinFacts = {}, subject = {}, expected = {} } = {}) {
  if (!intent || typeof intent !== 'object') {
    return { result: 'unable_to_determine', requirements: [], newFindings: [], summary: 'condition has no intent registered' };
  }
  const reqs = Array.isArray(intent.satisfaction_requirements) ? intent.satisfaction_requirements : [];
  if (!reqs.length) {
    return { result: 'unable_to_determine', requirements: [], newFindings: [], summary: 'condition intent has no satisfaction requirements' };
  }
  const getField = (factKey) => {
    if (!factKey) return null;
    // Map the fact_key back to an extraction field name via the twin's EXTRACTED_FIELD_MAP.
    // For each doc_type, find the field name whose value maps to factKey.
    for (const [_docType, fieldMap] of Object.entries(twin.EXTRACTED_FIELD_MAP)) {
      for (const [fieldName, mappedKey] of Object.entries(fieldMap)) {
        if (mappedKey === factKey && extractionFields[fieldName] != null) return extractionFields[fieldName];
      }
    }
    // Fall through to the extractionFields keyed by dot-path fragment.
    const last = String(factKey).split('.').pop();
    if (extractionFields[last] != null) return extractionFields[last];
    return null;
  };
  const requirements = [];
  const newFindings = [];
  let satisfiedCount = 0, unableCount = 0;
  for (const req of reqs) {
    const fn = ASSERTIONS[req.assertion];
    let outcome;
    if (!fn) {
      outcome = { status: 'unable_to_determine', reason: `no assertion function registered for "${req.assertion}"` };
    } else {
      try {
        outcome = fn({ getField, factKey: req.fact_key, extractionFields, twinFacts, subject, expected });
      } catch (e) {
        outcome = { status: 'unable_to_determine', reason: `assertion threw: ${e && e.message ? e.message : 'error'}` };
      }
    }
    if (outcome.status === 'satisfied') satisfiedCount += 1;
    if (outcome.status === 'unable_to_determine') unableCount += 1;
    if (outcome.newFinding) newFindings.push({ ...outcome.newFinding, from_requirement: req.id });
    requirements.push({
      id: req.id, label: req.label, assertion: req.assertion, fact_key: req.fact_key || null,
      status: outcome.status, reason: outcome.reason,
    });
  }
  // Result priority — the MOST INFORMATIVE outcome wins so the underwriter's
  // eye goes to the most-important state:
  //   creates_new_finding — any new finding surfaced (dominates because the new
  //     finding is a separate risk that needs its own workflow, and a reviewer
  //     must see it whether or not the primary requirements passed).
  //   satisfied           — every requirement satisfied AND no new findings.
  //   unable_to_determine — nothing satisfied AND every requirement was unable
  //                         (evidence didn't address anything).
  //   not_satisfied       — nothing satisfied but at least one requirement was
  //                         actively refuted.
  //   partially_satisfied — some met, some not / unable.
  let result;
  if (newFindings.length > 0) result = 'creates_new_finding';
  else if (satisfiedCount === reqs.length) result = 'satisfied';
  else if (satisfiedCount === 0 && unableCount === reqs.length) result = 'unable_to_determine';
  else if (satisfiedCount === 0) result = 'not_satisfied';
  else result = 'partially_satisfied';

  const recommended_action = ({
    satisfied: 'clear',
    partially_satisfied: 'request_more',
    not_satisfied: 'request_more',
    creates_new_finding: 'post_condition',
    unable_to_determine: 'request_more',
  })[result];

  const summary = summarize(result, requirements, newFindings);
  return { result, requirements, newFindings, recommended_action, summary };
}

function summarize(result, requirements, newFindings) {
  const sat = requirements.filter((r) => r.status === 'satisfied').length;
  const unsat = requirements.filter((r) => r.status === 'not_satisfied').length;
  const unable = requirements.filter((r) => r.status === 'unable_to_determine').length;
  const parts = [];
  parts.push(`${sat}/${requirements.length} requirements satisfied`);
  if (unsat) parts.push(`${unsat} not met`);
  if (unable) parts.push(`${unable} couldn't be checked`);
  if (newFindings.length) parts.push(`${newFindings.length} new finding(s) surfaced`);
  const outcomeText = {
    satisfied: 'The condition is fully cured by this document.',
    partially_satisfied: 'The document cures part of the condition — more evidence needed for the rest.',
    not_satisfied: 'The document does not address this condition — request the right kind of evidence.',
    creates_new_finding: 'The document technically cures the condition but reveals a NEW issue that must be resolved separately.',
    unable_to_determine: 'PILOT could not verify any requirement from this document — a reviewer should look at it.',
  }[result];
  return `${outcomeText} (${parts.join(' · ')})`;
}

// -------------------------------------------------------------------------
// PERSIST — write the clearance proof + spawn any new findings the analysis
// surfaced. Runs on the caller's transaction (they pass a `client`).
// -------------------------------------------------------------------------
async function persistProof(client, { appId, checklistItemId, intentId, documentId, extractionId, analysis } = {}) {
  if (!appId || !checklistItemId || !analysis) throw new Error('persistProof: appId, checklistItemId, analysis required');
  // Owner hard rule (2026-07-22): the AI does NOT create findings on its own. Every
  // new-finding the cure analysis surfaces becomes an AI SUGGESTION on the file's AI
  // panel — a human clicks "Convert to condition" / "Escalate" / etc. to act on it.
  // The proof itself still records the AI's reasoning (that's a report, not an action).
  const suggestionIds = [];
  const aiSug = require('./ai-suggestions');
  for (const f of (analysis.newFindings || [])) {
    try {
      const r = await aiSug.record(client, aiSug.fromCureNewFinding({
        applicationId: appId, documentId, checklistItemId, extractionId, finding: f,
      }));
      suggestionIds.push(r.id);
    } catch (_) { /* one bad suggestion never stops the proof */ }
  }
  const ins = await client.query(
    `INSERT INTO condition_clearance_proofs
       (application_id, checklist_item_id, intent_id, document_id, extraction_id,
        result, requirements_json, recommended_action, reviewer_summary,
        new_findings_json, linked_finding_ids, analyzer_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11,$12) RETURNING *`,
    [appId, checklistItemId, intentId || null, documentId || null, extractionId || null,
     analysis.result, JSON.stringify(analysis.requirements || []),
     analysis.recommended_action, analysis.summary,
     JSON.stringify(analysis.newFindings || []),
     // linked_finding_ids used to hold document_findings ids; now the AI panel's
     // suggestion ids sit here (schema is uuid[] — same shape). The routes read
     // the row as a report, not as a set of active findings.
     suggestionIds, 'cure.v1']);
  return ins.rows[0];
}

// -------------------------------------------------------------------------
// READ HELPERS
// -------------------------------------------------------------------------
async function proofsForItem(itemId, client) {
  client = client || db();
  const r = await client.query(
    `SELECT * FROM condition_clearance_proofs WHERE checklist_item_id=$1 ORDER BY created_at DESC`, [itemId]);
  return r.rows;
}
async function latestProofForItem(itemId, client) {
  client = client || db();
  const r = await client.query(
    `SELECT * FROM condition_clearance_proofs WHERE checklist_item_id=$1 ORDER BY created_at DESC LIMIT 1`, [itemId]);
  return r.rows[0] || null;
}
async function intentForCode(code, client) {
  client = client || db();
  const r = await client.query(`SELECT * FROM condition_intents WHERE code=$1`, [code]);
  return r.rows[0] || null;
}
async function intentsAll(client) {
  client = client || db();
  const r = await client.query(`SELECT * FROM condition_intents ORDER BY code`);
  return r.rows;
}

module.exports = {
  ASSERTIONS,
  analyze, persistProof,
  proofsForItem, latestProofForItem, intentForCode, intentsAll,
  _internals: { summarize },
};
