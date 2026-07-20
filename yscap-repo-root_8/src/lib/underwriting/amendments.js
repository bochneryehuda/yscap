'use strict';
/**
 * Contract amendments / versioning — resolve the GOVERNING terms of a purchase contract.
 *
 * Purchase contracts get amended: the price changes, the closing date slips, a party is swapped.
 * The rule (real-estate contract law) is that a signed amendment PREVAILS over the base term, and
 * among several amendments the LATEST fully-executed one governs. Underwriting to the base
 * contract's first-seen price when a signed amendment changed it is a real, common miss.
 *
 * This resolver takes the base purchase-contract extraction plus every contract-amendment
 * extraction and computes the effective terms (price, closing date, buyer, seller), overlaying
 * the executed amendments in date order (later wins per field). It carries provenance (which
 * document set each effective value) and raises:
 *   - amendment_unexecuted (informational here; the per-doc check also flags it) — a present but
 *     unsigned amendment is NOT applied to the effective terms.
 *   - amendment_ambiguous_precedence — two EXECUTED amendments change the same field with no
 *     orderable date, so which governs is unclear (flag rather than silently pick).
 *   - amendment_supersedes_file — the effective (amended) value differs from the value registered
 *     on the loan file, so the file should be updated (and everything downstream re-checked).
 *
 * Pure: no AI, no DB.
 */
const { num, namesMatchLoose, toISODate } = require('./compare');

// The effective-term fields we resolve, each mapping base + amendment field names + how to compare.
const TERMS = [
  { key: 'purchasePrice', base: 'purchasePrice', amend: 'newPurchasePrice', kind: 'money',  label: 'purchase price', fileKey: 'purchase_price' },
  { key: 'closingDate',   base: 'closingDate',   amend: 'newClosingDate',   kind: 'date',   label: 'closing date',   fileKey: 'closing_date' },
  { key: 'buyerName',     base: 'buyerName',     amend: 'newBuyerName',     kind: 'name',   label: 'buyer',          fileKey: null },
  { key: 'sellerName',    base: 'sellerNames',  amend: 'newSellerName',    kind: 'name',   label: 'seller',         fileKey: null },
];

function baseValue(term, base) {
  const v = base ? base[term.base] : null;
  if (term.key === 'sellerName' && Array.isArray(v)) return v[0] || null;
  return v == null ? null : v;
}

function differs(kind, a, b) {
  if (a == null || b == null) return false;
  if (kind === 'money') { const x = num(a), y = num(b); return x != null && y != null && Math.abs(x - y) > 0.5; }
  if (kind === 'date') { const x = toISODate(a), y = toISODate(b); return !!x && !!y && x !== y; }
  if (kind === 'name') return namesMatchLoose(a, b) === false;
  return String(a) !== String(b);
}

/**
 * @param {object} base                 the current purchase_contract fields (or null)
 * @param {Array<object>} amendments     current contract_amendment fields
 * @param {object} file                  registered file values { purchase_price, closing_date, ... }
 * @returns {{ effective, provenance, findings, hasAmendments, unexecuted }}
 */
function resolveEffectiveTerms(base, amendments = [], file = {}) {
  const findings = [];
  // Executed amendments only, ordered oldest→newest by amendment date (undated sort last, stable).
  const executed = amendments.filter((a) => a && a.executed === true);
  const unexecuted = amendments.filter((a) => a && a.executed === false &&
    (a.newPurchasePrice != null || a.newClosingDate != null || a.newBuyerName != null || a.newSellerName != null));
  const ordered = executed
    .map((a, i) => ({ a, i, d: toISODate(a.amendmentDate) }))
    .sort((x, y) => (x.d && y.d ? (x.d < y.d ? -1 : x.d > y.d ? 1 : x.i - y.i) : x.d ? -1 : y.d ? 1 : x.i - y.i));

  const effective = {};
  const provenance = {};
  for (const term of TERMS) {
    let val = baseValue(term, base);
    if (val != null) provenance[term.key] = { source: 'base_contract' };
    // Overlay each executed amendment that states a new value for this field.
    const setters = ordered.filter((o) => o.a[term.amend] != null);
    for (const o of setters) { val = o.a[term.amend]; provenance[term.key] = { source: 'amendment', date: o.d || null }; }
    if (val != null) effective[term.key] = val;

    // Ambiguous precedence: two+ executed amendments set the SAME field but can't be ordered
    // (missing/identical dates) — which governs is unclear.
    if (setters.length >= 2) {
      const dates = setters.map((o) => o.d);
      const undatedOrTied = dates.some((d) => !d) || new Set(dates).size < dates.length;
      if (undatedOrTied) {
        findings.push({ source: 'contract_amendment', code: 'amendment_ambiguous_precedence', severity: 'warning', status: 'open',
          field: term.key, docValue: `${setters.length} executed amendments change the ${term.label}`, fileValue: null, blocksCtc: false,
          title: `Two amendments change the ${term.label} with unclear precedence`,
          howTo: `More than one fully-executed amendment changes the ${term.label}, and their dates don't establish which governs. Confirm the controlling amendment before underwriting to it.`,
          actions: ['request_document', 'post_condition', 'dismiss'] });
      }
    }

    // The governing value differs from what's registered on the file → the file is stale.
    if (term.fileKey && val != null && file && differs(term.kind, val, file[term.fileKey])) {
      findings.push({ source: 'contract_amendment', code: 'amendment_supersedes_file', severity: 'warning', status: 'open',
        field: term.key, docValue: term.kind === 'money' ? `$${Math.round(num(val)).toLocaleString('en-US')}` : String(val),
        fileValue: file[term.fileKey] == null ? '(not set)' : String(file[term.fileKey]), blocksCtc: false,
        title: `An executed amendment changed the ${term.label}`,
        howTo: `A fully-executed amendment sets the ${term.label} to a value that differs from the loan file. Update the file to the governing amendment value so the tie-out and metrics use the right ${term.label}.`,
        actions: ['fix_file', 'post_condition', 'dismiss'] });
    }
  }

  return { effective, provenance, findings, hasAmendments: amendments.length > 0, unexecuted: unexecuted.length };
}

module.exports = { resolveEffectiveTerms, TERMS };
