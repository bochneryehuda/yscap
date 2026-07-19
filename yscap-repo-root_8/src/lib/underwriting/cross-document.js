'use strict';
/**
 * Cross-document reconciliation — the marquee check the owner described: the SAME facts
 * must agree ACROSS a file's documents. Specifically:
 *   - the SELLER on the purchase contract must match the vested owner on the title
 *     (and the seller on the appraisal, when present);
 *   - the PURCHASE PRICE must match across the contract and the appraisal;
 *   - the PROPERTY ADDRESS must match across every document that carries one.
 * Any disagreement is FATAL and blocks clear-to-close — a mismatched seller or price
 * across documents is a top fraud/misrepresentation signal (per the fraud research).
 *
 * Pure. Input is a normalized map the caller builds from the file's stored extractions:
 *   {
 *     purchase_contract: { sellerNames:[], buyerName, price, address },
 *     title:             { sellerNames:[], address },
 *     appraisal:         { sellerNames:[], price, address },
 *     ...any doc type with these normalized fields...
 *   }
 * Only document types actually present are compared (pairwise). Fuzzy name matching so
 * "Maple Grove Holdings LLC" == "Maple Grove Holdings, L.L.C." is not a false mismatch.
 */
const { namesMatchLoose, entityMatch, withinMoney, addrMatches, addrLine, num, norm } = require('./compare');

const LABEL = {
  purchase_contract: 'purchase contract', title: 'title report', appraisal: 'appraisal',
  government_id: 'ID', bank_statement: 'bank statement',
};
const lbl = (t) => LABEL[t] || t;

function finding(f) {
  return Object.assign({ source: 'cross_document', severity: 'fatal', status: 'open', blocksCtc: true }, f);
}

// Do any names in list A match any in list B (person- or entity-tolerant)?
function anyNameMatch(a, b) {
  for (const x of a) for (const y of b) {
    if (namesMatchLoose(x, y) === true || entityMatch(x, y) === true) return true;
  }
  return false;
}

function present(docs, key, pred) {
  return Object.entries(docs || {})
    .filter(([, d]) => d && pred(d[key]))
    .map(([t, d]) => [t, d[key]]);
}

function computeCrossDocumentFindings(docs = {}) {
  const out = [];

  // ---- SELLER: every pair of documents that names a seller must agree ----
  const sellers = present(docs, 'sellerNames', (v) => Array.isArray(v) && v.filter((s) => norm(s)).length);
  for (let i = 0; i < sellers.length; i++) {
    for (let j = i + 1; j < sellers.length; j++) {
      const [ta, la] = sellers[i], [tb, lb] = sellers[j];
      const A = la.filter((s) => norm(s)), B = lb.filter((s) => norm(s));
      if (!anyNameMatch(A, B)) {
        out.push(finding({ code: 'cross_seller_mismatch', field: 'seller',
          docValue: A.join(' / '), fileValue: B.join(' / '),
          title: `Seller differs between the ${lbl(ta)} and the ${lbl(tb)}`,
          howTo: `The ${lbl(ta)} shows "${A.join(', ')}" but the ${lbl(tb)} shows "${B.join(', ')}". The seller must be the same across documents — reconcile before clear-to-close.`,
          actions: ['open_condition', 'request_document', 'custom', 'dismiss', 'decline'], opensCondition: 'underwriting_review_cleared' }));
      }
    }
  }

  // ---- PRICE: every pair that carries a price must agree ----
  const prices = present(docs, 'price', (v) => num(v) != null);
  for (let i = 0; i < prices.length; i++) {
    for (let j = i + 1; j < prices.length; j++) {
      const [ta, pa] = prices[i], [tb, pb] = prices[j];
      if (withinMoney(pa, pb, 1) === false) {
        out.push(finding({ code: 'cross_price_mismatch', field: 'purchase_price',
          docValue: `$${num(pa).toLocaleString('en-US')}`, fileValue: `$${num(pb).toLocaleString('en-US')}`,
          title: `Purchase price differs between the ${lbl(ta)} and the ${lbl(tb)}`,
          howTo: `The ${lbl(ta)} shows $${num(pa).toLocaleString('en-US')} but the ${lbl(tb)} shows $${num(pb).toLocaleString('en-US')}. The price must match across documents — it flows into every leverage cap.`,
          actions: ['open_condition', 'request_document', 'custom', 'dismiss', 'decline'], opensCondition: 'underwriting_review_cleared' }));
      }
    }
  }

  // ---- PROPERTY ADDRESS: every pair that carries an address must agree ----
  const addrs = present(docs, 'address', (v) => v && addrLine(v));
  for (let i = 0; i < addrs.length; i++) {
    for (let j = i + 1; j < addrs.length; j++) {
      const [ta, aa] = addrs[i], [tb, ab] = addrs[j];
      if (addrMatches(aa, ab) === false) {
        out.push(finding({ code: 'cross_address_mismatch', field: 'property_address',
          docValue: addrLine(aa), fileValue: addrLine(ab),
          title: `Property address differs between the ${lbl(ta)} and the ${lbl(tb)}`,
          howTo: `The ${lbl(ta)} and the ${lbl(tb)} describe different properties. Confirm which documents belong to this file.`,
          actions: ['open_condition', 'request_document', 'custom', 'dismiss', 'decline'], opensCondition: 'underwriting_review_cleared' }));
      }
    }
  }

  return out;
}

module.exports = { computeCrossDocumentFindings };
