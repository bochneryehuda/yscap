'use strict';
/**
 * PILOT advisory ENGINE (owner-directed 2026-07-24).
 *
 * Goes condition-by-condition over a file's Condition Center and lays PILOT's advisory on
 * top of the human layer for EVERY condition PILOT can judge — open OR already signed off:
 *   ready     — open, PILOT verified it is met → ready to clear
 *   not_ready — open, PILOT still needs something first
 *   agree     — signed off, PILOT confirms it was cleared correctly
 *   dispute   — signed off, but PILOT has evidence it should NOT be → revisit (with reason)
 * PILOT NEVER signs off / clears the condition itself — a human always does that. The
 * advisory only ever writes pilot_advice / pilot_advice_note (see pilot-advice.js + db/295).
 *
 * Each condition template maps to a per-domain evaluator that returns { complete,
 * contradicted, note } — reusing the already-audited completeness checks (credit / gov-ID /
 * SSN / assets / purchase-contract / background). A DISPUTE is only ever raised on real
 * contradicting evidence (an open FATAL finding for that domain), never on mere absence of
 * data. Conditions PILOT has no evaluator for get NO advisory (their stamp is cleared).
 *
 * Best-effort, gated on cfg.pilotReadyStampEnabled (default ON); never throws.
 */
const cfg = require('../../config');
const { verdictFor, setAdvice, clearAdvice, VERDICT } = require('./pilot-advice');

const { contractCompleteness, CONTRACT_FINDING_SOURCES } = require('./contract-autoclear');
const { govIdCompleteness } = require('./gov-id-autoclear');
const { ssnCompleteness } = require('./ssn-autoclear');
const { assetsCompleteness } = require('./assets-autoclear');
const { fraudCompleteness } = require('./fraud-autoclear');
const { creditCompleteness } = require('../credit/completeness');
const { floodCompleteness } = require('./flood-advisory');
const { experienceCompleteness } = require('./experience-advisory');
const { appraisalCompleteness } = require('./appraisal-advisory');
const { signedTermSheetCompleteness } = require('./signed-term-sheet-advisory');

// Count OPEN fatal document_findings for a file across the given sources (the "positive
// contradiction" signal that turns a signed-off condition into a DISPUTE).
async function hasOpenFatal(client, appId, sources) {
  if (!appId || !sources || !sources.length) return false;
  try {
    const r = await client.query(
      `SELECT 1 FROM document_findings
        WHERE application_id=$1 AND status='open' AND severity='fatal' AND source = ANY($2)
        LIMIT 1`, [appId, sources]);
    return !!r.rows[0];
  } catch (_) { return false; }
}

// Plain-language note per domain + verdict. Kept borrower-safe / free of note-buyer names.
const NOTES = {
  contract: {
    ready: 'PILOT read the purchase contract and its price, address, and buyer line up with the loan.',
    not_ready: 'PILOT has not been able to confirm the purchase contract against the loan yet.',
    agree: 'PILOT read the purchase contract and it lines up with the loan.',
    dispute: "PILOT sees a purchase-contract issue that isn't resolved — the price, address, or buyer doesn't line up. Worth another look.",
  },
  gov_id: {
    ready: 'PILOT read the government ID and the name, date of birth, and address line up.',
    not_ready: 'PILOT is still waiting on a clean government-ID read for everyone on the loan.',
    agree: 'PILOT read the government ID and everything lines up.',
    dispute: 'PILOT sees a government-ID issue that isn\'t resolved. Worth another look.',
  },
  ssn: {
    ready: 'PILOT matched the Social Security number on file to the credit report.',
    not_ready: 'PILOT has not been able to confirm the Social Security number from the credit report yet.',
    agree: 'PILOT confirmed the Social Security number against the credit report.',
    dispute: 'PILOT can\'t confirm the Social Security number from the credit report. Worth another look.',
  },
  assets: {
    ready: 'PILOT read the bank statements and the required funds are covered.',
    not_ready: 'PILOT has not been able to confirm the required funds from the statements yet.',
    agree: 'PILOT read the bank statements and the required funds are covered.',
    dispute: 'PILOT sees a funds/assets issue that isn\'t resolved. Worth another look.',
  },
  credit: {
    ready: 'PILOT has the credit report on file for everyone on the loan.',
    not_ready: 'PILOT is still waiting on the credit report for everyone on the loan.',
    agree: 'PILOT has the credit report on file for everyone on the loan.',
    dispute: 'PILOT sees a credit-report gap that isn\'t resolved. Worth another look.',
  },
  background: {
    ready: 'PILOT read the background report and it\'s clear (no OFAC or criminal hit).',
    not_ready: 'PILOT is still waiting on a clean background/OFAC read.',
    agree: 'PILOT read the background report and it\'s clear.',
    dispute: 'PILOT sees a background/OFAC issue that isn\'t resolved. Worth another look.',
  },
  flood: {
    ready: 'PILOT read the flood determination and the flood zone is confirmed (with flood insurance where the zone requires it).',
    not_ready: 'PILOT has not been able to confirm the flood determination for the property yet.',
    agree: 'PILOT read the flood determination and it lines up.',
    dispute: 'PILOT sees a flood issue that isn\'t resolved — the property is in a flood zone and a flood policy isn\'t on file. Worth another look.',
  },
  experience: {
    ready: 'PILOT checked the track record and the experience this loan needs is verified.',
    not_ready: 'PILOT is still waiting on enough verified past deals to cover the experience this loan needs.',
    agree: 'PILOT checked the track record and the experience this loan needs is verified.',
    dispute: 'PILOT can\'t confirm enough verified past deals for the experience this loan needs. Worth another look.',
  },
  appraisal: {
    ready: 'PILOT read the appraisal and everything checks out — the property, the value, and the report all line up.',
    not_ready: 'PILOT has not been able to read a clean appraisal for this property yet.',
    agree: 'PILOT read the appraisal and everything lines up.',
    dispute: 'PILOT sees an appraisal issue that isn\'t resolved — something about the property, the value, or the report doesn\'t line up. Worth another look.',
  },
  signed_term_sheet: {
    ready: 'PILOT sees the borrower-signed term sheet on file.',
    not_ready: 'PILOT is still waiting on the borrower-signed term sheet.',
    agree: 'PILOT sees the borrower-signed term sheet on file.',
    dispute: 'PILOT can\'t find a current signed term sheet on file. Worth another look.',
  },
};

// Registry: condition template code (or the co-borrower gov-ID marker field_key) → evaluator.
// Each evaluator returns { complete, contradicted }. `note` is picked from NOTES by verdict.
const EVALUATORS = {
  rtl_p1_contract: {
    domain: 'contract',
    async evaluate(client, appId) {
      const c = await contractCompleteness(client, appId);
      return { complete: !!c.complete, contradicted: (c.openFatal || 0) > 0 };
    },
  },
  rtl_p1_id: {
    domain: 'gov_id',
    async evaluate(client, appId, item) {
      const c = await govIdCompleteness(client, appId, item.field_key);
      const contradicted = await hasOpenFatal(client, appId, ['government_id']);
      return { complete: !!c.complete, contradicted };
    },
  },
  rtl_p1_ssn: {
    domain: 'ssn',
    async evaluate(client, appId) {
      const c = await ssnCompleteness(client, appId);
      // SSN has no findings row; only advise when CorrFirst is the accepted verification.
      if (!c.corrfirst) return null;
      return { complete: !!c.complete, contradicted: false };
    },
  },
  rtl_p3_assets: {
    domain: 'assets',
    async evaluate(client, appId) {
      const c = await assetsCompleteness(client, appId);
      const contradicted = await hasOpenFatal(client, appId, ['bank_statement']);
      return { complete: !!c.complete, contradicted };
    },
  },
  rtl_cond_credit: {
    domain: 'credit',
    async evaluate(client, appId, item) {
      const c = await creditCompleteness(client, appId, item.field_key);
      return { complete: !!c.complete, contradicted: false };
    },
  },
  rtl_cond_fraud: {
    domain: 'background',
    async evaluate(client, appId, item) {
      const c = await fraudCompleteness(client, appId, item.id);
      const contradicted = await hasOpenFatal(client, appId, ['background_report']);
      return { complete: !!c.complete, contradicted };
    },
  },
  rtl_cond_flood: {
    domain: 'flood',
    async evaluate(client, appId) {
      const c = await floodCompleteness(client, appId);
      return { complete: !!c.complete, contradicted: (c.openFatal || 0) > 0 };
    },
  },
  rtl_p3_reo: {
    domain: 'experience',
    async evaluate(client, appId) {
      const c = await experienceCompleteness(client, appId);
      // No experience required on this file → nothing to judge; lay no advisory.
      if (!c.hasRequirement) return null;
      // Experience has no "positive contradiction" signal — a verified shortfall is the
      // absence of a (human) verification step, not evidence the experience is wrong — so
      // contradicted is always false (never a false DISPUTE). ready/not_ready/agree only.
      return { complete: !!c.complete, contradicted: false };
    },
  },
  appraisal_review_cleared: {
    domain: 'appraisal',
    async evaluate(client, appId) {
      const c = await appraisalCompleteness(client, appId);
      // An open FATAL blocks_ctc appraisal finding is POSITIVE contradicting evidence (the
      // SAME signal the human gate reads), so appraisal — like flood — supports DISPUTE.
      return { complete: !!c.complete, contradicted: (c.openFatal || 0) > 0 };
    },
  },
  rtl_cond_signedts: {
    domain: 'signed_term_sheet',
    async evaluate(client, appId, item) {
      const c = await signedTermSheetCompleteness(client, item.id);
      // A term sheet has no "positive contradiction" finding, and a stale/changed term sheet
      // is REOPENED (un-signed) by the economics/experience triggers, so a signed-off
      // condition never coexists with a stale one — contradicted is always false (never a
      // false DISPUTE). ready/not_ready/agree only.
      return { complete: !!c.complete, contradicted: false };
    },
  },
};
// The co-borrower gov-ID marker item (field_key='cob_gov_id') shares the gov-ID evaluator.
const CO_GOV_ID_MARKER = 'cob_gov_id';

function evaluatorFor(item) {
  if (item.field_key === CO_GOV_ID_MARKER) return EVALUATORS.rtl_p1_id;
  return EVALUATORS[item.template_code] || null;
}

/**
 * Advise ONE condition (row must carry id, status, signed_off_by, template_code, field_key).
 * @returns {Promise<string|null>} the verdict written, or null if none/cleared.
 */
async function adviseOne(client, appId, item) {
  const ev = evaluatorFor(item);
  if (!ev) { await clearAdvice(client, item.id); return null; }
  const res = await ev.evaluate(client, appId, item);
  if (!res) { await clearAdvice(client, item.id); return null; }
  const signedOff = item.status === 'satisfied' && item.signed_off_by != null;
  const verdict = verdictFor(res.complete, res.contradicted, signedOff);
  const note = verdict ? (NOTES[ev.domain] || {})[verdict] || null : null;
  await setAdvice(client, item.id, verdict, note);
  return verdict;
}

const ITEM_COLS = `ci.id, ci.status, ci.signed_off_by, ci.field_key, COALESCE(t.code,'') AS template_code`;

/**
 * Run PILOT's advisory over EVERY condition on a file. Best-effort; never throws.
 * Call on file view (the auto-sync pass) and after any document is AI-read.
 */
async function runFileAdvice(client, appId) {
  try {
    if (!cfg.pilotReadyStampEnabled || !appId) return;
    const conds = await client.query(
      `SELECT ${ITEM_COLS}
         FROM checklist_items ci
         LEFT JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ci.application_id=$1 AND ci.item_kind IN ('document','condition','task')`, [appId]);
    for (const item of conds.rows) {
      // eslint-disable-next-line no-await-in-loop
      await adviseOne(client, appId, item).catch(() => {});
    }
  } catch (e) {
    console.error('[pilot-advice] runFileAdvice', appId, e && e.message);
  }
}

/**
 * Advise just the conditions of ONE domain on a file (used by the per-document store hooks —
 * e.g. after a gov-ID doc is read, refresh the gov-ID condition's advisory). Best-effort.
 */
async function adviseDomainConditions(client, appId, codes) {
  try {
    if (!cfg.pilotReadyStampEnabled || !appId || !codes || !codes.length) return;
    const conds = await client.query(
      `SELECT ${ITEM_COLS}
         FROM checklist_items ci
         LEFT JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ci.application_id=$1
          AND (COALESCE(t.code,'') = ANY($2) OR ci.field_key = ANY($2))`, [appId, codes]);
    for (const item of conds.rows) {
      // eslint-disable-next-line no-await-in-loop
      await adviseOne(client, appId, item).catch(() => {});
    }
  } catch (e) {
    console.error('[pilot-advice] adviseDomainConditions', appId, e && e.message);
  }
}

module.exports = { runFileAdvice, adviseDomainConditions, adviseOne, EVALUATORS, VERDICT };
