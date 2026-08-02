/* WHAT A CONDITION IS ABOUT — the subject groups the one conditions list uses.
 *
 * Move 4b of docs/LOAN-FILE-SIMPLICITY-BLUEPRINT.md. Roughly fifty conditions
 * on a busy file, in one flat list, is a wall. Grouped by what they are ABOUT —
 * Title, Insurance, Entity, Construction — it becomes a page you can scan, and
 * "is the title work done?" is answerable without reading forty rows.
 *
 * WE DID NOT INVENT THIS TAXONOMY. The themes are the investor-guideline
 * `domain` vocabulary that already exists server-side
 * (src/lib/underwriting/investor-guidelines/bluelake-rtl-spec.js: title,
 * entity_vesting, insurance_hazard, flood, identity, credit, assets_liquidity,
 * valuation, construction_feasibility, closing_docs...), reconciled against the
 * condition template codes actually seeded on a file.
 *
 * WHY NOT `checklist_templates.category`: that column holds TIMING
 * (prior_to_docs, at_closing, post_closing) — when a condition is due, not what
 * it is about — and 57 of the templates leave it null. It answers a different
 * question, and this list already shows timing separately.
 *
 * NEVER GUESS LOUDLY. A row is placed by its template code, which is
 * authoritative. A staff-added condition has no code, so its label is matched
 * against the words that only ever mean one subject. Anything still unplaced
 * goes to "Other" — a visible, honest bucket — rather than being forced into a
 * group it may not belong to.
 */

/* The groups, in the order a file naturally works through them: who the
   borrower is, what they are buying, what we are lending against, then what
   has to be true to close. A group with no rows on this file is not shown. */
export const SUBJECTS = [
  { key: 'identity',     label: 'Identity' },
  { key: 'entity',       label: 'Entity & vesting' },
  { key: 'contract',     label: 'Contract & purchase' },
  { key: 'valuation',    label: 'Property & valuation' },
  { key: 'construction', label: 'Construction' },
  { key: 'title',        label: 'Title' },
  { key: 'insurance',    label: 'Insurance & flood' },
  { key: 'assets',       label: 'Assets & liquidity' },
  { key: 'credit',       label: 'Credit & background' },
  { key: 'terms',        label: 'Terms & signing' },
  // The investor's final review + clear-to-close sit BEFORE closing — they gate
  // clear-to-close, they are not the closing package (owner-directed 2026-07-30:
  // "these two conditions are prior to CtC, not closing conditions"). Their own
  // group so they never read as part of the closing docs below.
  { key: 'investor',     label: 'Investor approval' },
  { key: 'closing',      label: 'Closing' },
  { key: 'setup',        label: 'File setup' },
  { key: 'other',        label: 'Other' },
];

export const SUBJECT_LABEL = Object.fromEntries(SUBJECTS.map(s => [s.key, s.label]));
const SUBJECT_ORDER = Object.fromEntries(SUBJECTS.map((s, i) => [s.key, i]));

/* Template code -> subject. Every code seeded by db/schema.sql and the
   migrations is listed, so a standard file never falls through to a guess.
   When a new condition template is added, add its code here too. */
export const CODE_SUBJECT = {
  // who the borrower is — the photo ID, and (db/396, CorrFirst) the Social
  // Security number verified off the card / an SSA-89 / the credit report.
  gov_id: 'identity', rtl_p1_id: 'identity', cond_ssn_verify_corrfirst: 'identity',
  // the borrowing entity
  rtl_llc_formation: 'entity', rtl_llc_ein: 'entity', rtl_llc_opagmt: 'entity',
  rtl_llc_goodstanding: 'entity', llc_docs: 'entity', operating_agmt: 'entity',
  rtl_p1_llc: 'entity', draw_cond_operating_agreement: 'entity',
  // what they are buying
  purchase_contract: 'contract', rtl_p1_contract: 'contract', rtl_p5_assign: 'contract',
  // what we are lending against
  rtl_cond_appraisaldocs: 'valuation', appraisal_as_is_verify: 'valuation',
  appraisal_review_cleared: 'valuation', rtl_p1_arv: 'valuation', rtl_p4_arv: 'valuation',
  rtl_p4_ltc: 'valuation', rtl_p4_ltv: 'valuation', cond_condo_docs: 'valuation',
  // the subject PROPERTY itself — its USPS-standardized, deliverable address is the
  // foundation every valuation and financing export is written against.
  usps_address_verification: 'valuation',
  // the work
  scope_of_work: 'construction', rtl_p3_sow1: 'construction', rtl_p1_plans: 'construction',
  rtl_cond_feasibility: 'construction', draw_cond_signed_request: 'construction',
  // title
  title_commitment: 'title', rtl_cond_title: 'title',
  // insurance
  insurance_binder: 'insurance', rtl_cond_insurance: 'insurance', rtl_cond_flood: 'insurance',
  // db/378 (#909) seeds the flood-INSURANCE policy condition — distinct from
  // rtl_cond_flood, which is the flood CERTIFICATE (the determination). Both
  // belong with Insurance; without this the new condition fell through to the
  // catch-all "Other" group on every file that carries it.
  rtl_cond_flood_insurance: 'insurance',
  // money in the deal
  bank_statements: 'assets', rtl_p3_assets: 'assets', voided_check: 'assets',
  cond_emd_corrfirst: 'assets', cond_cashout_letter: 'assets',
  // the borrower's record
  rtl_cond_credit: 'credit', rtl_cond_fraud: 'credit',
  // the deal's paperwork
  rtl_p4_ts: 'terms', rtl_cond_signedts: 'terms', rtl_cond_signed_app: 'terms',
  rtl_cond_iska: 'terms', rtl_cond_disclosures: 'terms', rtl_p4_ir: 'terms',
  // the investor's clearance BEFORE closing — final review + the investor's
  // clear-to-close. These gate CTC (is_gate=true) and are the last pre-closing
  // step, so they get their own group and stay OUT of the closing-package group
  // below (owner-directed 2026-07-30).
  rtl_f_review: 'investor', rtl_f_ctc: 'investor',
  // getting it closed — the post-CTC closing package (balanced HUD/ALTA, the
  // signed closing docs, the collateral tracking label). Closer-managed; never
  // holds up clear-to-close.
  rtl_cond_settlement: 'closing', closing_hud_final: 'closing',
  closing_pkg_signed: 'closing', closing_tracking_label: 'closing',
  // internal housekeeping
  cond_note_buyer_missing: 'setup', cond_loan_number_missing: 'setup',
  rtl_cond_investorstruct: 'setup', underwriting_review_cleared: 'setup',
};

/* Tool-backed conditions carry a tool_key even when the template code varies. */
const TOOL_SUBJECT = {
  product_pricing: 'terms',
  rehab_budget: 'construction',
  appraisal_card: 'valuation',
  appraisal_review: 'valuation',
  track_record: 'credit',
  esign: 'terms',
};

/* Label fallback for a condition a human typed. Ordered — the FIRST match wins,
   so the more specific phrases come before the words that appear everywhere.
   Every entry is a phrase that has only one plausible reading on a loan file;
   a word like "report" or "letter" is deliberately absent. */
const LABEL_RULES = [
  [/\bflood\b/i, 'insurance'],
  [/\binsurance|\bbinder\b|\bhazard\b|\bhoi\b/i, 'insurance'],
  // "owner of record", "chain of title" and a deed are all read off the title
  // commitment — on a loan file none of them means anything else.
  [/\btitle\b|\blien\b|\bpayoff\b|\bdeed\b|\bescrow\b|\bowner of record\b|\bchain of title\b/i, 'title'],
  [/\boperating agreement\b|\barticles\b|\bein\b|\bllc\b|\bentity\b|\bgood standing\b|\bcertificate of formation\b/i, 'entity'],
  [/\bphoto id\b|\bdriver'?s licen[cs]e\b|\bpassport\b|\bgovernment[- ]issued\b/i, 'identity'],
  [/\bcredit report\b|\bfico\b|\bbackground\b|\bfraud\b|\bofac\b/i, 'credit'],
  [/\bbank statement|\bproof of funds\b|\bliquidity\b|\bearnest money\b|\bemd\b|\bvoided check\b|\bwire instruction/i, 'assets'],
  [/\bappraisal\b|\barv\b|\bas[- ]is value\b|\bbpo\b|\bltv\b|\bltc\b|\bvaluation\b|\bcomp(arable)?s\b/i, 'valuation'],
  [/\bscope of work\b|\bsow\b|\brehab\b|\bbudget\b|\bpermit|\bplans\b|\bdraw\b|\bcontractor\b|\bfeasibility\b/i, 'construction'],
  [/\bpurchase contract\b|\bassignment\b|\bcontract of sale\b|\bseller\b/i, 'contract'],
  [/\bterm sheet\b|\biska\b|\bdisclosure\b|\bsigned application\b|\binterest reserve\b/i, 'terms'],
  // "clear to close" / "CTC" and the investor's final review come BEFORE closing —
  // this must run before the closing rule below so those words don't fall into it.
  [/\binvestor (final )?review\b|\bclear to close\b|\bctc\b/i, 'investor'],
  [/\bhud\b|\balta\b|\bsettlement statement\b|\bclosing package\b|\bcollateral\b/i, 'closing'],
];

/* The subject for one row. Accepts a checklist item, an underwriting-conditions
   row, or anything else carrying a code/tool/title — so the one list can place
   every source it merges without each caller knowing the rules. */
export function subjectOf(row) {
  if (!row) return 'other';
  if (row.subject && SUBJECT_ORDER[row.subject] != null) return row.subject;   // caller pinned it
  const code = String(row.template_code || row.code || '').trim();
  if (code && CODE_SUBJECT[code]) return CODE_SUBJECT[code];
  const tool = String(row.tool_key || '').trim();
  if (tool && TOOL_SUBJECT[tool]) return TOOL_SUBJECT[tool];
  const text = String(row.label || row.title || row.borrower_label || '');
  if (text) {
    for (const [re, key] of LABEL_RULES) if (re.test(text)) return key;
  }
  return 'other';
}

/* Group rows into the SUBJECTS order, dropping groups with nothing in them.
   Returns [{key, label, rows, done, total}] — the counts drive the group
   header ("Title — 2 of 5 done"), so the header can never disagree with the
   rows beneath it. `isDone` is passed in because "done" means something
   slightly different per surface (signed off vs satisfied vs cleared). */
export function groupBySubject(rows, isDone) {
  const buckets = new Map();
  for (const r of (rows || [])) {
    const k = subjectOf(r);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }
  return SUBJECTS
    .filter(s => buckets.has(s.key))
    .map(s => {
      const list = buckets.get(s.key);
      const done = typeof isDone === 'function' ? list.filter(isDone).length : 0;
      return { key: s.key, label: s.label, rows: list, done, total: list.length };
    });
}
