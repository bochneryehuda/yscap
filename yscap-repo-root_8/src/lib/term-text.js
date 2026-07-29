'use strict';

/**
 * term-text.js — ONE semantic reading of the free-text loan term (owner-reported
 * 2026-07-24: "Term: 12 → 12 Months" forced a re-register loop).
 *
 * `applications.term` is TEXT and is written by several doors in DIFFERENT
 * formats for the SAME term: the ClickUp dropdown stores "12 Months", the
 * application-details form stores whatever label the form used, and the product
 * registration write-back used to store the bare parsed number "12". Every
 * change-detector that compared the RAW text (the db/190 reopen trigger, the
 * inbound economics freeze) therefore saw "12" vs "12 Months" as a pricing
 * change, flagged the registration stale, and demanded a pointless re-register —
 * which wrote "12" again, so the next ClickUp echo re-flagged it forever.
 *
 * The ROOT fix is one shared semantic key: two term texts are the SAME term when
 * they parse to the same month count (or, when neither carries a number, the
 * same words). This module is the JS half; db/288 defines the SQL twin
 * `pilot_term_norm(text)` used by the reopen trigger. KEEP THE TWO IN SYNC.
 *
 * PURE — no requires, no DB — so it unit-tests anywhere (test-term-text-pure.js).
 */

/**
 * Canonical comparison key for a term text.
 *   '12' / '12 Months' / '12-month' / ' 12 mo '  → '12'   (months)
 *   '30 year' / '30 Years'                       → '360'  (years ×12)
 *   'Interest only' / 'Other'                    → 'interest only' / 'other'
 *   null / '' / '   '                            → null
 * A change-detector must treat two texts as EQUAL when their keys are equal.
 */
function termKey(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  // Years first ("30 year", "2 yrs") — a year term is NOT the same as the same
  // number of months, so it must not collapse onto the bare-number key.
  const y = /^(\d+(?:\.\d+)?)\s*(?:years?|yrs?|y)\b/i.exec(s);
  if (y) return String(Math.round(parseFloat(y[1]) * 12));
  // A leading number ("12", "12 Months", "18-month", "12mo") → that many months.
  const m = /^(\d+)/.exec(s);
  if (m) return String(parseInt(m[1], 10));
  // No number at all ("Interest only", "Other") → compare the words.
  return s.toLowerCase();
}

/** True when two term texts mean the same term (equal keys; both-blank counts). */
function termsEquivalent(a, b) {
  return termKey(a) === termKey(b);
}

/**
 * What the product-registration write-back should store in applications.term.
 * PRESERVES the file's existing text when it already means the registered month
 * count (so "12 Months" is never cosmetically rewritten to "12" — the rewrite is
 * what kept re-tripping the change detectors). Only a REAL term change writes a
 * new value, in the human/ClickUp-friendly "<n> Months" form. A non-numeric
 * existing text ("Interest only") never masquerades as a month count — a numeric
 * registered term always replaces it.
 */
function termWritebackText(existingText, months) {
  const n = Number(months);
  if (!Number.isFinite(n) || n <= 0) return existingText == null ? null : String(existingText);
  const cur = existingText == null ? '' : String(existingText);
  if (/\d/.test(cur) && termKey(cur) === String(Math.round(n))) return cur;
  return `${Math.round(n)} Months`;
}

module.exports = { termKey, termsEquivalent, termWritebackText };
