'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — VSLICE-6 V1-vs-V2 diff (src/pipeline/v1v2-diff.js).
 * Pure: no DB, no network.
 *
 * Proves: a real field-by-field comparison between V1's document_extractions.fields and V2's canonical
 * facts — agree / disagree / v1_only / v2_only; camelCase (V1) aligns with snake_case (V2); money/name
 * normalization; document-type comparison; nested V1 fields flatten; disagreements sort first; never throws.
 */
const R = require('path').resolve(__dirname, '..');
const D = require(R + '/src/pipeline/v1v2-diff');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const fieldFor = (res, keyNorm) => res.fields.find((f) => String(f.key).toLowerCase().replace(/[^a-z0-9]/g, '') === keyNorm);

(function main() {
  // ---- camelCase (V1) aligns with snake_case (V2); agree/disagree by value ----
  {
    const v1 = { doc_type: 'bank_statement', fields: { accountHolder: 'John A. Smith', balance: '$1,200.00', bankName: 'Chase' } };
    const v2 = [
      { fieldKey: 'account_holder', value: 'john a smith', status: 'verified' },
      { fieldKey: 'balance', value: '1200', status: 'verified' },
      { fieldKey: 'routing_number', value: '021000021', status: 'unverified' },
    ];
    const res = D.diffV1V2(v1, v2);
    ok(fieldFor(res, 'accountholder').agreement === 'agree', 'accountHolder(V1)==account_holder(V2), name-normalized → agree');
    ok(fieldFor(res, 'balance').agreement === 'agree', 'balance "$1,200.00"==="1200" money-normalized → agree');
    ok(fieldFor(res, 'bankname').agreement === 'v1_only', 'bankName only V1 → v1_only');
    ok(fieldFor(res, 'routingnumber').agreement === 'v2_only', 'routing_number only V2 → v2_only');
    ok(res.counts.agree === 2 && res.counts.v1Only === 1 && res.counts.v2Only === 1, 'counts tally');
    ok(res.docType.agreement === 'v1_only', 'V1 has doc_type but V2 surfaced no document_type fact/family → docType v1_only');
  }

  // ---- disagreement is flagged ----
  {
    const v1 = { doc_type: 'insurance', fields: { coverageAmount: 500000 } };
    const v2 = [{ fieldKey: 'coverage_amount', value: '400000', status: 'verified' }];
    const res = D.diffV1V2(v1, v2);
    ok(fieldFor(res, 'coverageamount').agreement === 'disagree', 'coverage 500000 vs 400000 → disagree');
    ok(res.counts.disagree === 1, 'disagree counted');
    ok(res.fields[0].agreement === 'disagree', 'disagreements sort first');
  }

  // ---- document type comparison ----
  {
    const agree = D.diffV1V2({ doc_type: 'bank_statement', fields: {} }, [{ fieldKey: 'document_type', value: 'bank_statement', status: 'verified' }]);
    ok(agree.docType.agreement === 'agree', 'doc_type bank_statement == V2 document_type fact → agree');
    const dis = D.diffV1V2({ doc_type: 'insurance', fields: {} }, [{ fieldKey: 'document_type', value: 'bank_statement', status: 'verified' }]);
    ok(dis.docType.agreement === 'disagree', 'doc_type insurance vs V2 bank_statement → disagree');
    const v2only = D.diffV1V2(null, [{ fieldKey: 'document_type', value: 'title', status: 'verified' }]);
    ok(v2only.docType.agreement === 'v2_only' && v2only.hasV1 === false, 'no V1 extraction → docType v2_only, hasV1 false');
  }

  // ---- V2 falls back to family when there is no document_type fact ----
  {
    const res = D.diffV1V2({ doc_type: 'bank_statement', fields: {} }, [{ fieldKey: 'balance', family: 'bank_statement', value: '10', status: 'verified' }]);
    ok(res.docType.v2 === 'bank_statement' && res.docType.agreement === 'agree', 'V2 doc type falls back to the facts family');
  }

  // ---- nested V1 fields flatten by leaf key ----
  {
    const v1 = { doc_type: 'government_id', fields: { address: { line1: '12 Main St', city: 'Lakewood' }, documentNumber: 'X1' } };
    const v2 = [{ fieldKey: 'city', value: 'lakewood', status: 'verified' }, { fieldKey: 'document_number', value: 'X1', status: 'verified' }];
    const res = D.diffV1V2(v1, v2);
    ok(fieldFor(res, 'city') && fieldFor(res, 'city').agreement === 'agree', 'nested address.city flattens by leaf key → aligns with V2 city');
    ok(fieldFor(res, 'documentnumber').agreement === 'agree', 'documentNumber==document_number → agree');
  }

  // ---- accepts the full selectCanonicalFacts() object (with .facts) ----
  {
    const res = D.diffV1V2({ doc_type: 'x', fields: { a: '1' } }, { facts: [{ fieldKey: 'a', value: '1', status: 'verified' }] });
    ok(fieldFor(res, 'a').agreement === 'agree', 'accepts {facts:[...]} shape');
  }

  // ---- never throws / empty inputs ----
  ok(D.diffV1V2(null, null).counts.total === 0, 'null,null → empty, no throw');
  ok(D.diffV1V2({}, []).hasV1 === false, 'empty V1 → hasV1 false');
  ok(D.diffV1V2({ fields: 'garbage' }, 'garbage').counts.total === 0, 'garbage → empty (no throw)');
  ok(D.diffV1V2({ doc_type: 'x', fields: { a: 1 } }, [{ fieldKey: 'a', value: 1 }]).fields.length === 1, 'numbers compare');

  console.log(`test-v1v2-diff-pure: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
