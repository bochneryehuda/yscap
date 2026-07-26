'use strict';
/**
 * "It isn't there" is only a finding if we were looking at the RIGHT DOCUMENT.
 *
 * ROOT CAUSE (owner-reported 2026-07-26, live file review). A finding said "the insurance does not
 * name the lender as mortgagee" — a FATAL — and its "open the source document" link opened the
 * insurance INVOICE. The owner's words: *"the insurance invoice doesn't have US listed as the
 * mortgagee, but the only thing that needs us listed is the binder, not the invoice. So you're
 * looking on the wrong document."* Their very next finding proved it: *"this is the actual insurance
 * binder … I do see our mortgage clause."* The clause was there all along.
 *
 * The mechanism is a whole CLASS, not one bug. A reader is asked "is the mortgagee clause present?"
 * and answers `false` — which is TRUE of an invoice, a receipt, a cover page, a fax sheet, anything
 * that was never going to carry the clause. The check then turned that honest `false` into an
 * accusation about the LOAN. `false` from the wrong document and `false` from the right document are
 * completely different facts, and the code could not tell them apart.
 *
 * A "did we read the document at all?" guard does NOT catch this: an invoice read under the policy
 * schema fills in the named insured, the carrier and the premium, so it looks perfectly readable.
 * What is missing is anything only a POLICY carries.
 *
 * So the rule this module enforces, for every absence-based finding anywhere:
 *
 *   An "X is missing" finding requires positive proof that this document is the KIND of document
 *   that carries X. No such proof → we are looking at the wrong document (or read the wrong part of
 *   it), which is a READ problem to fix, never an underwriting defect to accuse the file of.
 *
 * Pure. No I/O.
 */

/**
 * hasEvidence(markers) → true when at least ONE marker is real.
 * A marker is a field only the RIGHT document carries. `null` / `undefined` / `''` / `[]` are
 * absent; `false` and `0` are REAL readings (a policy that says "builders risk: no" and a coverage
 * amount of 0 both prove we are holding a policy).
 */
function hasEvidence(markers) {
  const list = Array.isArray(markers) ? markers : [markers];
  for (const m of list) {
    if (m == null) continue;
    if (typeof m === 'string' && m.trim() === '') continue;
    if (Array.isArray(m) && m.length === 0) continue;
    return true;
  }
  return false;
}

/**
 * provenAbsent(flag, markers) → true ONLY when the reader said "not present" AND this document
 * proves it is the kind that would have carried it. That is the ONLY state in which an "X is
 * missing" finding may be raised.
 *
 * `flag` true (it IS present) or null/undefined (could not tell) is never an absence.
 */
function provenAbsent(flag, markers) {
  if (flag !== false) return false;
  return hasEvidence(markers);
}

/**
 * wrongDocument(flag, markers) → true when the reader said "not present" but NOTHING in the
 * document shows it is the right kind. This is the invoice-instead-of-binder case: not a defect in
 * the loan, a defect in what we were handed. Callers surface it as "get us the real document",
 * never as a finding against the file.
 */
function wrongDocument(flag, markers) {
  return flag === false && !hasEvidence(markers);
}

/**
 * affirmed(flag) → `true` when the reader positively said yes, `null` otherwise.
 *
 * `hasEvidence` deliberately counts `false` and `0` as real readings, because a policy that says
 * "builders risk: no" or shows $0 coverage still proves it IS a policy. That is exactly wrong for a
 * SIGNATURE flag: "signed: false" is not proof we are holding the executed package — it is the
 * opposite. Wrap any yes/no marker in this so the distinction is stated at the call site instead of
 * living in a `x === true ? true : null` ternary that the next caller will forget to write.
 */
function affirmed(flag) { return flag === true ? true : null; }

module.exports = { provenAbsent, wrongDocument, hasEvidence, affirmed };
