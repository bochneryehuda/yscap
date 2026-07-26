'use strict';
/**
 * Document CLASSIFIER — "know the purpose of every document" without the team tagging it. Given a
 * document's OCR text (and/or filename), score each known document type by the distinctive
 * phrases that appear on that kind of document, and return the best guess + a confidence. Pure +
 * dependency-free (works offline on OCR text — no AI call needed), so it's fast and testable; the
 * engine uses it to pre-select the type, and a human always confirms before findings are trusted.
 *
 * Never guesses onto the file: a low/none confidence returns docType null so the underwriter
 * picks. The signals are ordered by how distinctive they are; a strong signal (a title unique to
 * one document, e.g. "operating agreement") outweighs many weak generic ones.
 */

// [docType, strongSignals[], weakSignals[]]. Strong = a phrase that essentially only appears on
// that document; weak = supportive but generic terms.
const SIGNALS = [
  ['government_id', ["driver's license", 'driver license', 'identification card', 'passport', 'department of motor vehicles', 'dmv'], ['date of birth', 'class', 'endorsements', 'sex', 'height', 'eyes', 'expires']],
  ['purchase_contract', ['purchase and sale', 'purchase agreement', 'agreement of sale', 'contract of sale', 'residential contract', 'purchase contract'], ['earnest money', 'closing date', 'seller', 'buyer', 'contingency', 'as-is']],
  ['contract_amendment', ['amendment to', 'addendum to', 'contract amendment', 'amendment to contract', 'amendment to purchase', 'first amendment', 'second amendment', 'amendment agreement'], ['amendment', 'addendum', 'amended', 'amends']],
  ['scope_of_work', ['scope of work', 'rehab budget', 'renovation budget', 'construction budget', 'line item budget', 'draw schedule'], ['rehab', 'renovation', 'contractor', 'line item', 'remodel']],
  ['assignment', ['assignment of contract', 'assignment agreement', 'assignor', 'assignee', 'assignment fee'], ['assign', 'wholesale']],
  ['title', ['title commitment', 'preliminary report', 'commitment for title insurance', 'proposed insured', 'schedule b'], ['schedule a', 'vested', 'exceptions', 'legal description', 'title company']],
  ['appraisal', ['uniform residential appraisal', 'appraisal report', 'small residential income', 'sales comparison approach', 'after repair value', 'opinion of value'], ['as-is', 'arv', 'comparable', 'gross living area', 'appraiser', '1004', '1025', '1073']],
  ['insurance', ['evidence of property insurance', 'evidence of commercial property', 'acord', 'declarations page', 'mortgagee clause', 'named insured', "builder's risk"], ['dwelling', 'coverage', 'policy number', 'hazard', 'premium', 'isaoa']],
  // The paid-premium invoice/receipt — anchored on distinctly-invoice phrases so it isn't confused
  // with the binder (which carries coverage/mortgagee-clause language an invoice does not).
  ['insurance_invoice', ['insurance invoice', 'premium invoice', 'installment premium', 'insurance premium due', 'premium due', 'paid in full', 'amount paid', 'invoice number'], ['invoice', 'amount due', 'balance due', 'please remit', 'due date', 'premium', 'payment received']],
  ['flood', ['standard flood hazard determination', 'special flood hazard area', 'flood zone', 'firm panel', 'national flood insurance'], ['fema', 'sfha', 'flood']],
  ['operating_agreement', ['operating agreement', 'limited liability company agreement', 'managing member', 'membership interest', 'member-managed', 'manager-managed'], ['members', 'ownership', 'capital contribution']],
  ['ein_letter', ['employer identification number', 'cp 575', 'cp575', '147c', 'ein assignment'], ['internal revenue service', 'ein', 'tax id']],
  ['good_standing', ['certificate of good standing', 'certificate of existence', 'certificate of status', 'in good standing'], ['secretary of state', 'active', 'in existence']],
  ['llc_formation', ['articles of organization', 'certificate of formation', 'certificate of organization', 'registered agent'], ['organizer', 'state file number', 'formation']],
  ['settlement', ['settlement statement', 'closing disclosure', 'alta settlement', 'hud-1', 'hud 1', 'disbursement date'], ['cash to close', 'seller credit', 'sources and uses', 'payoff', 'settlement agent']],
  ['bank_statement', ['beginning balance', 'ending balance', 'statement period', 'available balance'], ['deposits', 'withdrawals', 'account number', 'account summary']],
  ['credit_report', ['credit report', 'tradeline', 'credit score', 'fico', 'trans union', 'transunion', 'equifax', 'experian'], ['inquiries', 'revolving', 'installment', 'derogatory']],
  ['background_report', ['ofac', 'specially designated nationals', 'sdn list', 'sanctions screening', 'watchlist', 'background check'], ['criminal', 'pep', 'politically exposed']],
  ['payoff_statement', ['payoff statement', 'payoff quote', 'payoff demand', 'statement of payoff', 'good through date', 'unpaid principal balance', 'per diem interest'], ['payoff', 'servicer', 'reinstatement', 'loan number']],
  ['voided_check', ['voided check', 'void check', 'wire instructions', 'ach instructions', 'routing number', 'aba routing'], ['void', 'routing', 'account number', 'disbursement']],
  ['plans_permits', ['building permit', 'construction permit', 'permit number', 'plans and specifications', 'certificate of occupancy', 'zoning permit'], ['permit', 'plans', 'construction', 'municipality']],
  ['signed_term_sheet', ['term sheet', 'loan term sheet', 'summary of terms', 'conditional loan approval'], ['terms', 'loan amount', 'accepted', 'signature']],
  ['signed_application', ['loan application', 'business purpose', 'business-purpose', 'non-owner occupied', 'borrower certification', '1003'], ['application', 'certify', 'occupancy']],
  ['investor_structure', ['investor structure', 'deal structure', 'structure printout', 'pricing structure'], ['structure', 'investor', 'points', 'rate']],
  // --- Expanded RTL taxonomy (owner-directed 2026-07-22) — clean, distinct families the packet
  // classifier previously left as "unknown". Each anchored on phrases unique to it so it never
  // steals from an existing family (verified against the classify test suite). ---
  // Closing Protection Letter — a title-adjacent letter, distinct from the title commitment.
  ['cpl', ['closing protection letter', 'insured closing letter', 'closing protection coverage'], ['cpl', 'closing protection', 'issuing agent', 'underwriter']],
  // A REVISED / updated appraisal or a reconsideration-of-value — anchored so it beats plain 'appraisal'.
  ['appraisal_revision', ['revised appraisal', 'appraisal update', 'reconsideration of value', 'updated appraisal report', 'appraisal revision'], ['revised', 'reconsideration', 'rov', 'updated value']],
  // A lease / rental agreement (rented subject, DSCR support).
  ['lease', ['lease agreement', 'residential lease', 'rental agreement', 'term of lease', 'landlord and tenant'], ['landlord', 'tenant', 'monthly rent', 'lessee', 'lessor']],
  // A rent roll — the per-unit schedule of rents for a multi-unit/DSCR subject.
  // Anchored on the schedule phrasing so a single lease never becomes a rent roll.
  ['rent_roll', ['rent roll', 'schedule of rents', 'rental income schedule', 'unit rent schedule', 'tenant rent roll'], ['unit', 'monthly rent', 'occupancy', 'vacant', 'lease expiration', 'tenant']],
  // A servicer's periodic mortgage statement — distinct from a payoff and from a bank statement.
  ['mortgage_statement', ['mortgage statement', 'monthly mortgage statement', 'escrow account summary', 'your mortgage'], ['escrow balance', 'principal balance', 'servicer', 'amount due']],
  // An entity borrowing / corporate resolution authorizing the loan + signer.
  ['entity_resolution', ['borrowing resolution', 'resolution of the members', 'corporate resolution', 'certificate of resolution', 'unanimous written consent'], ['resolved', 'authorized to', 'resolution', 'members']],
  // A construction draw / disbursement request (distinct from the Scope of Work).
  ['draw_request', ['draw request', 'request for draw', 'disbursement request', 'request for disbursement', 'draw reconciliation'], ['percent complete', 'draw number', 'disbursement', 'inspection']],
  // Borrower experience documentation — a schedule of real estate owned / prior projects.
  ['experience_docs', ['schedule of real estate owned', 'real estate owned schedule', 'reo schedule', 'track record of', 'prior projects completed'], ['reo', 'properties owned', 'flips completed', 'experience']],
];

// Filename keyword → docType hints (a strong nudge when the OCR text is thin).
const FILENAME_HINTS = [
  // Expanded taxonomy hints — placed BEFORE any generic pattern they could collide with.
  [/reconsideration|revised.*apprais|apprais.*(revis|updat|rov)|\brov\b|appraisal.?update/i, 'appraisal_revision'], // before 'apprais' → appraisal
  [/closing.?protection|insured.?closing|\bcpl\b/i, 'cpl'],
  [/draw.?request|disbursement.?request|request.?for.?draw|draw.?recon/i, 'draw_request'], // before scope-of-work/sow
  [/mortgage.?stmt|mortgage.?statement/i, 'mortgage_statement'], // before bank/statement
  [/rent.?roll|schedule.?of.?rents|rent.?schedule/i, 'rent_roll'], // before lease (both mention rent)
  [/\blease\b|rental.?agreement|landlord/i, 'lease'],
  [/borrowing.?resolution|corporate.?resolution|member.?resolution|written.?consent/i, 'entity_resolution'],
  [/\breo\b|schedule.?of.?real|real.?estate.?owned|experience.?(doc|schedule)/i, 'experience_docs'],
  [/operating\s*ag|op\s*agmt/i, 'operating_agreement'],
  [/articles|formation|cert.*org/i, 'llc_formation'],
  [/good\s*stand|existence|status/i, 'good_standing'],
  [/ein|cp.?575|147c|tax.?id/i, 'ein_letter'],
  [/amend|addend/i, 'contract_amendment'],
  [/scope.?of.?work|\bsow\b|rehab|renovation|rehab.?budget/i, 'scope_of_work'],
  [/assign/i, 'assignment'],
  [/title|commitment|prelim/i, 'title'],
  [/apprais|1004|1025|1073/i, 'appraisal'],
  [/insur\w*\s*(invoice|receipt|paid|premium)|(invoice|receipt|premium).*insur|premium.*(invoice|receipt|paid)/i, 'insurance_invoice'], // before 'insurance' — "Insurance Invoice.pdf" is the receipt, not the binder
  [/acord|insur|dec.?page|binder|hazard/i, 'insurance'],
  [/flood/i, 'flood'],
  [/settle|closing.?disc|hud|alta/i, 'settlement'],
  [/pay.?off|payoff.?demand/i, 'payoff_statement'], // before bank_statement — a "payoff statement" contains "statement"
  [/void|wire.?instruction|ach.?instruction/i, 'voided_check'],
  [/permit|plans.?(and|&).?spec|cert.*occupan/i, 'plans_permits'], // NB: no bare "C.O." — it matches "CO" (Colorado) / co-borrower; certificate-of-occupancy is covered by cert.*occupan
  [/term.?sheet|summary.?of.?terms/i, 'signed_term_sheet'],
  [/loan.?application|signed.?app|business.?purpose|\b1003\b/i, 'signed_application'], // require loan/signed prefix — bare "application" catches credit_application etc.
  [/investor.?structure|deal.?structure|structure.?printout/i, 'investor_structure'],
  [/bank|statement/i, 'bank_statement'],
  [/credit/i, 'credit_report'],
  [/ofac|background|sanction/i, 'background_report'],
  [/licen|passport|\bid\b|driver/i, 'government_id'],
  [/contract|purchase|psa/i, 'purchase_contract'],
];

function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' '); }
function countHits(hay, phrases) { let n = 0; for (const p of phrases) if (hay.indexOf(p) !== -1) n++; return n; }

/**
 * @param {{text?:string, filename?:string}} input
 * @returns {{docType:string|null, confidence:'high'|'medium'|'low'|'none', scores:object}}
 */
function classify({ text, filename } = {}) {
  const hay = norm(text);
  const fname = String(filename || '');
  // The filename hints are an ORDERED list — the FIRST pattern that matches wins, and nudges exactly
  // ONE docType. (A "payoff statement" matches both the payoff and the generic "statement"/bank
  // pattern; taking only the first-listed match keeps the more specific payoff hint from tying with
  // bank_statement.) So resolve the single hinted type once, up front.
  let fnameHint = null;
  for (const [re, t] of FILENAME_HINTS) { if (re.test(fname)) { fnameHint = t; break; } }
  const scores = {};
  for (const [docType, strong, weak] of SIGNALS) {
    const s = countHits(hay, strong), w = countHits(hay, weak);
    // A strong signal (a title unique to one document) dominates; generic weak terms are capped
    // so several of them can't outvote one strong match. A filename hint is a strong nudge.
    let score = s * 3 + Math.min(w, 2);
    if (fnameHint === docType) score += 3;
    if (score > 0) scores[docType] = score;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { docType: null, confidence: 'none', scores };
  const [topType, topScore] = ranked[0];
  const second = ranked[1] ? ranked[1][1] : 0;
  const margin = topScore - second;
  let confidence = 'low';
  if (topScore >= 6 && margin >= 3) confidence = 'high';
  else if (topScore >= 3 && margin >= 1) confidence = 'medium';
  // Below one strong signal / filename hint (score < 3) we don't guess — the underwriter picks.
  return { docType: topScore < 3 ? null : topType, confidence, scores };
}

module.exports = { classify, _internals: { SIGNALS, FILENAME_HINTS } };
