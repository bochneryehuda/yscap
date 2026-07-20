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
  ['flood', ['standard flood hazard determination', 'special flood hazard area', 'flood zone', 'firm panel', 'national flood insurance'], ['fema', 'sfha', 'flood']],
  ['operating_agreement', ['operating agreement', 'limited liability company agreement', 'managing member', 'membership interest', 'member-managed', 'manager-managed'], ['members', 'ownership', 'capital contribution']],
  ['ein_letter', ['employer identification number', 'cp 575', 'cp575', '147c', 'ein assignment'], ['internal revenue service', 'ein', 'tax id']],
  ['good_standing', ['certificate of good standing', 'certificate of existence', 'certificate of status', 'in good standing'], ['secretary of state', 'active', 'in existence']],
  ['llc_formation', ['articles of organization', 'certificate of formation', 'certificate of organization', 'registered agent'], ['organizer', 'state file number', 'formation']],
  ['settlement', ['settlement statement', 'closing disclosure', 'alta settlement', 'hud-1', 'hud 1', 'disbursement date'], ['cash to close', 'seller credit', 'sources and uses', 'payoff', 'settlement agent']],
  ['bank_statement', ['beginning balance', 'ending balance', 'statement period', 'available balance'], ['deposits', 'withdrawals', 'account number', 'account summary']],
  ['credit_report', ['credit report', 'tradeline', 'credit score', 'fico', 'trans union', 'transunion', 'equifax', 'experian'], ['inquiries', 'revolving', 'installment', 'derogatory']],
  ['background_report', ['ofac', 'specially designated nationals', 'sdn list', 'sanctions screening', 'watchlist', 'background check'], ['criminal', 'pep', 'politically exposed']],
];

// Filename keyword → docType hints (a strong nudge when the OCR text is thin).
const FILENAME_HINTS = [
  [/operating\s*ag|op\s*agmt/i, 'operating_agreement'],
  [/articles|formation|cert.*org/i, 'llc_formation'],
  [/good\s*stand|existence|status/i, 'good_standing'],
  [/ein|cp.?575|147c|tax.?id/i, 'ein_letter'],
  [/amend|addend/i, 'contract_amendment'],
  [/scope.?of.?work|\bsow\b|rehab|renovation|rehab.?budget/i, 'scope_of_work'],
  [/assign/i, 'assignment'],
  [/title|commitment|prelim/i, 'title'],
  [/apprais|1004|1025|1073/i, 'appraisal'],
  [/acord|insur|dec.?page|binder|hazard/i, 'insurance'],
  [/flood/i, 'flood'],
  [/settle|closing.?disc|hud|alta/i, 'settlement'],
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
  const scores = {};
  for (const [docType, strong, weak] of SIGNALS) {
    const s = countHits(hay, strong), w = countHits(hay, weak);
    // A strong signal (a title unique to one document) dominates; generic weak terms are capped
    // so several of them can't outvote one strong match. A filename hint is a strong nudge.
    let score = s * 3 + Math.min(w, 2);
    for (const [re, t] of FILENAME_HINTS) { if (t === docType && re.test(fname)) { score += 3; break; } }
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
