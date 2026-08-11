'use strict';

// SINGLE DEFINITION of the borrower-safe appraisal ("property profile report") payload.
//
// This scrub is the real staff-only boundary on the appraisal: it hides the lender's
// internal scrutiny (inflated-ARV signals, value-not-carried-by-comps, over-paying vs as-is),
// every capital-partner / note-buyer finding (their titles name a note buyer), the free-text
// lender / AMC / owner-of-record fields, the appraiser's direct contact + supervisor + tooling,
// the raw parser warnings, and the ARV-defensibility cross-check — while still showing the
// property report, the comparables (as property facts) and the neutral collateral read.
//
// It lived inline in the BORROWER appraisal route; it is now shared so the BORROWER portal and
// the TPO (broker) portal return the IDENTICAL borrower-safe payload and can never drift — a
// drift here would leak the lender's internal view to an external broker, the TPO #1 risk.
// The CALLER owns access control (borrower OWN_FILE_SQL / TPO firm scope); this function only
// loads + scrubs. It never throws for a missing appraisal — it returns the empty shape.

const apprScore = require('./scoring');
const { scrubText } = require('../borrower-safe');

// Underwriting-scrutiny findings reveal how hard the lender is scrutinizing the deal. Neither a
// borrower nor a broker may see the lender's internal skepticism, so these codes are dropped from
// the set entirely (they stay open + visible on the staff desk).
const SCRUTINY_CODES = new Set(['arv_defensibility', 'value_vs_comps', 'value_not_bracketed', 'asis_below_price', 'comp_split_review']);
// NOTE-BUYER findings (source='note_buyer') are STAFF-ONLY as a CLASS: their titles name a note
// buyer. Filter by SOURCE, not by code list, so a future buyer's checks are covered automatically.
const hiddenFromBorrower = (f) => SCRUTINY_CODES.has(f.code) || f.source === 'note_buyer';

const EMPTY = () => ({ appraisal: null, comparables: [], units: [], findings: [], photos: [], summary: { fatal: 0, warning: 0, info: 0, blocksCtc: false } });

// Build the borrower-safe appraisal payload for an APPLICATION id (the current, non-superseded
// appraisal). `db` is a pg-style client/pool with `.query`. Returns the same shape the borrower
// route has always returned; `{ appraisal: null, ... }` when the file has no appraisal.
async function buildBorrowerSafeAppraisalView(db, appId) {
  const appr = (await db.query(
    `SELECT * FROM appraisals WHERE application_id=$1 AND superseded=false ORDER BY imported_at DESC LIMIT 1`, [appId])).rows[0];
  if (!appr) return EMPTY();
  // The property TYPE is the category (single family / 2–4 / condo), never the Detached / Attached
  // attachment style (owner-reported 2026-08-02).
  require('./property-category').applyPropertyType(appr);
  const [comps, units, findings, photos] = await Promise.all([
    db.query(`SELECT * FROM appraisal_comparables WHERE appraisal_id=$1 ORDER BY seq`, [appr.id]),
    db.query(`SELECT * FROM appraisal_units WHERE appraisal_id=$1 ORDER BY unit_seq`, [appr.id]),
    db.query(`SELECT id, source, code, severity, field, appraisal_value, file_value, title, blocks_ctc, created_at
                FROM appraisal_findings WHERE application_id=$1 AND status='open'
               ORDER BY (severity='fatal') DESC, created_at`, [appId]),
    db.query(
      `SELECT ap.id, ap.document_id, ap.category, ap.caption, ap.sequence, ap.width, ap.height
         FROM appraisal_photos ap JOIN documents d ON d.id=ap.document_id
        WHERE ap.appraisal_id=$1 AND d.is_current AND ap.document_id IS NOT NULL
        ORDER BY ap.sequence`, [appr.id]),
  ]);
  const open = findings.rows
    .filter((f) => !hiddenFromBorrower(f))
    .map((f) => ({ ...f, title: scrubText(f.title) }));
  // A hidden scrutiny/note-buyer finding can still be a REAL clear-to-close blocker. Don't tell the
  // reader their file is clear while it's actually gated — but don't reveal the underwriting reason.
  const hiddenBlocker = findings.rows.some((f) => hiddenFromBorrower(f) && f.severity === 'fatal' && f.blocks_ctc);
  if (hiddenBlocker) {
    open.push({ id: 'appraisal_review', code: 'appraisal_under_review', severity: 'fatal', field: 'value',
      appraisal_value: null, file_value: null, blocks_ctc: true, created_at: null,
      title: 'Your appraisal is in final underwriting review' });
  }
  // Borrower-safe appraisal object: drop staff-only bookkeeping AND the free-text lender/AMC/client
  // fields OUTRIGHT — a capital-partner name can never reach a borrower/broker. Dropping the columns
  // removes the whole class. `fields`/`warnings` carry un-scrubbed lender/AMC + the raw scrutiny
  // warnings, so they are dropped too. The appraiser's DIRECT CONTACT + supervisor + tooling are
  // internal (the reader reaches their loan team, never the appraiser); the "Prepared by" card still
  // shows WHO appraised the property (name/firm/license) — standard disclosure.
  // The free-text APPRAISER NARRATIVE columns are dropped alongside the structured lender/AMC
  // fields, and for the same reason: an appraiser's reconciliation / addendum / intended-use /
  // contract narrative routinely NAMES the client / ordering lender / AMC / capital partner
  // ("prepared for the exclusive use of …"). A denylist that dropped only the structured columns
  // would leak the very same class of name through the narrative — and `scrubText` only catches
  // the KNOWN partner patterns, so it can't be trusted to strip an arbitrary AMC / lender / owner
  // / intended-user name on an external (broker) surface. Dropping is the only robust option.
  // `appraiser_id` (a research-warehouse FK) is internal bookkeeping, dropped like the comp ids.
  // `as_is_read_quote` / `as_is_read_detail` are a VERBATIM slice of the appraiser's narrative around
  // the As-Is figure — and by the As-Is reader's own design that figure is often a NOTE in the
  // addendum / reconciliation, which is precisely where the client / ordering lender / AMC / intended
  // user is named. So this is the same narrative class, and it is dropped for the same reason.
  // `appraisal_purpose_other` is appraiser free text (the "Other" purpose) → dropped for completeness.
  // NOTE: the drop list is the ONLY boundary — neither the borrower nor the TPO route re-scrubs this
  // object — so a name-bearing free-text column MUST be dropped here, never left to a downstream scrub.
  const safeAppr = (() => {
    const { imported_by, source_xml_document_id, pdf_document_id, fields, warnings, appraiser_id,
      lender_name, amc_name, owner_of_record, lender_address,
      appraiser_email, appraiser_phone, appraiser_company_address,
      supervisor_name, supervisor_license_id, supervisor_license_state, supervisor_license_exp,
      software_vendor,
      addendum_text, reconciliation_comment, market_conditions_comment, market_reconciliation_comment,
      conditions_comment, condition_comment, contract_review_comment, sales_agreement_analysis,
      nbhd_boundaries, as_is_read_quote, as_is_read_detail, appraisal_purpose_other,
      ...rest } = appr; // eslint-disable-line no-unused-vars
    return rest;
  })();
  const bSummary = {
    fatal: open.filter((f) => f.severity === 'fatal').length,
    warning: open.filter((f) => f.severity === 'warning').length,
    info: open.filter((f) => f.severity === 'info').length,
    blocksCtc: open.some((f) => f.severity === 'fatal' && f.blocks_ctc),
  };
  // The neutral collateral read (a quality summary of the property) but NOT the ARV-defensibility
  // cross-check — that's an underwriting-scrutiny signal, staff-only (arv: null).
  const gridKey = safeAppr.arv_value != null ? 'arv' : 'as_is';
  const hasSplit = comps.rows.some((c) => c.comp_set);
  const impliedComps = hasSplit ? comps.rows.filter((c) => c.comp_set === gridKey) : comps.rows;
  const score = {
    collateral: apprScore.collateralScore({ a: safeAppr, comps: comps.rows, summary: bSummary }),
    arv: null,
    impliedValue: apprScore.compImpliedValue({ comps: impliedComps, subjectGla: safeAppr.gla }),
  };
  // Every comparable states what it is + how many doors — property facts, borrower-safe — but our
  // internal warehouse bookkeeping (property_id, how many of our reports named it, where it came
  // from) is dropped.
  const borrowerComps = (await require('../research/comp-identity')
    .attachCompIdentity(comps.rows, { db, appraisal: safeAppr }))
    .map(({ property_id, identity_observations, identity_source, ...c }) => c); // eslint-disable-line no-unused-vars
  return {
    appraisal: safeAppr, comparables: borrowerComps, units: units.rows, findings: open, photos: photos.rows,
    summary: bSummary, score,
  };
}

module.exports = { buildBorrowerSafeAppraisalView, SCRUTINY_CODES, hiddenFromBorrower };
