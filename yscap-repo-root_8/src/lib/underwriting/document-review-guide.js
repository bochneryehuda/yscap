'use strict';
/**
 * document-review-guide — turns the note-buyer condition specs (CorrFirst, Blue Lake,
 * and any future buyer added the same way) into a per-DOCUMENT "what to look for"
 * checklist for the document reviewer.
 *
 * When a document of a given type is opened, this returns the exact check items the note
 * buyer requires on THAT kind of document — e.g. for a hazard-insurance policy: "dwelling
 * coverage = replacement cost", "mortgagee clause ISAOA/ATIMA", "proof of premium paid".
 * The knowledge already lives, per condition, in the note-buyer specs (required_evidence +
 * checks); this projects it onto the document type the condition is cleared by, using the
 * existing condition-map bridge (a condition's pilot_template_code → the doc type(s) that
 * hold it), with a domain→docType fallback for coverage.
 *
 * PURE + advisory: it surfaces guidance and decides nothing, blocks nothing, touches no
 * frozen number, and never throws. Filtered to the file's note buyer when one is set;
 * otherwise it returns every buyer's checklist (deduped).
 */

const condMap = require('./condition-map');

// The note-buyer specs to draw from. Adding a new note buyer = add its spec here (it just
// needs CONDITIONS[] with { name, domain, required_evidence, checks[], pilot_template_code }).
const SPECS = [
  require('./investor-guidelines/corrfirst-fnf-spec'),
  require('./investor-guidelines/bluelake-rtl-spec'),
];

// Domain → document type(s) FALLBACK, for conditions whose pilot_template_code doesn't
// resolve through condition-map (or is absent). The pilot_template_code bridge is PRIMARY;
// this only widens coverage so a condition is never silently dark on its obvious document.
const DOMAIN_TO_DOCTYPES = {
  insurance_hazard: ['insurance', 'insurance_invoice'],
  flood: ['flood', 'insurance'],
  title: ['title'],
  identity: ['government_id'],
  assets_liquidity: ['bank_statement'],
  entity_vesting: ['operating_agreement', 'llc_formation', 'ein_letter', 'good_standing'],
  appraisal: ['appraisal'],
  valuation: ['appraisal'],
  credit: ['credit_report'],
  background_ofac: ['background_report'],
  construction_feasibility: ['scope_of_work', 'plans_permits'],
  seller_concession: ['purchase_contract'],
  occupancy: ['purchase_contract'],
  closing_docs: ['title'],
  // property / program_eligibility / state_overlay / track_record / other are not tied to a
  // single uploaded document — left unmapped so they don't attach to the wrong doc.
};

function normKey(v) { return String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, ''); }

// The document type(s) a note-buyer condition's checklist applies to: PRIMARY via its
// pilot_template_code through condition-map; fallback via its domain. Returns a Set.
function docTypesForCondition(cond) {
  const out = new Set();
  try {
    const c = cond || {};
    if (c.pilot_template_code) {
      for (const dt of (condMap.docTypesForCode(c.pilot_template_code) || [])) out.add(dt);
    }
    for (const dt of (DOMAIN_TO_DOCTYPES[c.domain] || [])) out.add(dt);
  } catch (_e) { /* never throws */ }
  return out;
}

function checkTextsOf(cond) {
  const checks = Array.isArray(cond && cond.checks) ? cond.checks : [];
  return checks.map((k) => (k && (k.text || k.detail)) || (typeof k === 'string' ? k : '')).filter((s) => s && s.trim());
}

/**
 * reviewGuideForDocType(docType, { noteBuyerKey }) → { docType, noteBuyer, items } (PURE).
 * items: [{ noteBuyer, noteBuyerName, condition, cond_no, domain, required_evidence, checks[] }]
 * — one per matching note-buyer condition. When noteBuyerKey is set (raw or normalized —
 * "Blue Lake"/"bluelake" both work), only that buyer's own conditions + the shared
 * (all_note_buyers) ones are returned; otherwise every buyer's, deduped by identical
 * condition+checks so a shared requirement isn't listed twice.
 */
function reviewGuideForDocType(docType, opts = {}) {
  try {
    const dt = String(docType == null ? '' : docType).trim();
    if (!dt) return { docType: null, noteBuyer: (opts && opts.noteBuyerKey) || null, items: [] };
    const nbKey = normKey(opts && opts.noteBuyerKey);
    const items = [];
    const seen = new Set();
    for (const spec of SPECS) {
      const specKey = normKey(spec && spec.NOTE_BUYER);
      for (const cond of ((spec && spec.CONDITIONS) || [])) {
        const scopeAll = cond.scope === 'all_note_buyers' || cond.scope === 'all';
        // With a buyer set: keep the buyer's own conditions + every buyer's shared ones.
        if (nbKey && !scopeAll && specKey !== nbKey) continue;
        if (!docTypesForCondition(cond).has(dt)) continue;
        const checks = checkTextsOf(cond);
        if (!checks.length && !cond.required_evidence) continue;
        const key = `${normKey(cond.name)}|${checks.map(normKey).join('|')}`;
        if (seen.has(key)) continue;   // a shared requirement lands in both specs — list once
        seen.add(key);
        items.push({
          noteBuyer: spec.NOTE_BUYER || null,
          noteBuyerName: spec.NOTE_BUYER_NAME || spec.NOTE_BUYER || null,
          condition: cond.name || null,
          cond_no: cond.cond_no != null ? cond.cond_no : null,
          domain: cond.domain || null,
          noteBuyerSpecific: !scopeAll,
          required_evidence: cond.required_evidence || null,
          checks,
        });
      }
    }
    return { docType: dt, noteBuyer: (opts && opts.noteBuyerKey) || null, items };
  } catch (_e) {
    return { docType: docType || null, noteBuyer: (opts && opts.noteBuyerKey) || null, items: [] };
  }
}

/**
 * reviewGuideText(guide) → string (PURE). A compact grounding block for the AI document
 * read — the note-buyer checklist as plain lines. '' when there is nothing to check.
 */
function reviewGuideText(guide) {
  try {
    const g = guide || {};
    const items = Array.isArray(g.items) ? g.items : [];
    if (!items.length) return '';
    const lines = [`NOTE-BUYER REVIEW CHECKLIST — for this ${g.docType || 'document'}, confirm each item below:`];
    for (const it of items) {
      lines.push(`• ${it.condition || 'requirement'}${it.noteBuyerName ? ` [${it.noteBuyerName}]` : ''}`);
      if (it.required_evidence) lines.push(`    requires: ${it.required_evidence}`);
      for (const c of (it.checks || [])) lines.push(`    - ${c}`);
    }
    return lines.join('\n');
  } catch (_e) { return ''; }
}

module.exports = {
  reviewGuideForDocType, reviewGuideText, docTypesForCondition,
  DOMAIN_TO_DOCTYPES, SPECS, _internals: { normKey, checkTextsOf },
};
