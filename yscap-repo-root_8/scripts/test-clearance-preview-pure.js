'use strict';
/**
 * #191 activation 1 — pure tests for the clearance-preview composition
 * (cure.analyze per document + clearance-outcome.aggregate → one advisory
 * answer). No DB, no AI, no writes — the same fixtures the cure pure test
 * uses, so the preview provably runs the SAME analysis the proof pipeline
 * records. The preview is ADVISORY: it produces a display object only.
 */
const assert = require('assert');
const { previewDocuments } = require('../src/lib/underwriting/clearance-preview');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const idIntent = {
  version: 2, primary_goal: 'Verify the borrower is who they say they are.',
  acceptable_evidence: ['drivers_license', 'passport'],
  satisfaction_requirements: [
    { id: 'name_matches_file', label: 'Name matches', assertion: 'equals_file', fact_key: 'borrower.name' },
    { id: 'dob_matches_file',  label: 'DOB matches',  assertion: 'equals_file', fact_key: 'borrower.date_of_birth' },
  ],
};
const twinFacts = {
  'borrower.name': { value_normalized: 'noach mendelovits', status: 'observed' },
  'borrower.date_of_birth': { value_normalized: '1985-05-12', status: 'observed' },
};

// 1. A matching, acceptable document clears (advisory only — a display object).
{
  const r = previewDocuments({
    intent: idIntent,
    documents: [{ documentId: 'd1', docType: 'drivers_license', filename: 'id.pdf',
      fields: { name: 'Noach Mendelovits', dateOfBirth: '05/12/1985' } }],
    twinFacts,
  });
  assert.strictEqual(r.documents.length, 1);
  assert.strictEqual(r.documents[0].result, 'satisfied');
  assert.strictEqual(r.documents[0].clears, true);
  assert.strictEqual(r.overall.clears, true);
  ok('a matching acceptable document previews as clearing');
}

// 2. The wrong DOCUMENT TYPE can never preview as clearing, even with matching fields.
{
  const r = previewDocuments({
    intent: idIntent,
    documents: [{ documentId: 'd2', docType: 'bank_statement', filename: 'stmt.pdf',
      fields: { name: 'Noach Mendelovits', dateOfBirth: '05/12/1985' } }],
    twinFacts,
  });
  assert.strictEqual(r.documents[0].signals.wrongDocument, true);
  assert.strictEqual(r.documents[0].clears, false, 'wrong_document blocks the outcome');
  assert.strictEqual(r.overall.clears, false);
  ok('a wrong document type never previews as clearing (wrong_document signal)');
}

// 3. An unreadable document never clears.
{
  const r = previewDocuments({
    intent: idIntent,
    documents: [{ documentId: 'd3', docType: 'drivers_license',
      fields: { readable: false, name: 'Noach Mendelovits', dateOfBirth: '05/12/1985' } }],
    twinFacts,
  });
  assert.strictEqual(r.documents[0].signals.unreadable, true);
  assert.strictEqual(r.documents[0].clears, false);
  ok('an unreadable document never previews as clearing');
}

// 4. A field mismatch → not clearing, with the unmet requirement surfaced.
{
  const r = previewDocuments({
    intent: idIntent,
    documents: [{ documentId: 'd4', docType: 'drivers_license',
      fields: { name: 'Somebody Else', dateOfBirth: '05/12/1985' } }],
    twinFacts,
  });
  assert.strictEqual(r.documents[0].clears, false);
  assert.ok(r.documents[0].unmet.includes('name_matches_file'), 'the failed requirement is named');
  ok('a mismatching field blocks with the unmet requirement surfaced');
}

// 5. One good document among bad ones clears the OVERALL preview (slot semantics).
{
  const r = previewDocuments({
    intent: idIntent,
    documents: [
      { documentId: 'bad', docType: 'bank_statement', fields: { name: 'X' } },
      { documentId: 'good', docType: 'passport', fields: { name: 'Noach Mendelovits', dateOfBirth: '05/12/1985' } },
    ],
    twinFacts,
  });
  assert.strictEqual(r.overall.clears, true, 'one good document clears the condition preview');
  ok('one good document among bad ones clears the overall preview');
}

// 6. No documents → explicit no_documents outcome, never a throw.
{
  const r = previewDocuments({ intent: idIntent, documents: [], twinFacts });
  assert.strictEqual(r.overall.clears, false);
  assert.strictEqual(r.overall.outcome, 'no_documents');
  ok('no documents → explicit no_documents outcome');
}

// 7. Advisory guarantee: the module exposes ONLY the pure composition —
// no persist, no decide, no DB handle.
{
  const mod = require('../src/lib/underwriting/clearance-preview');
  assert.deepStrictEqual(Object.keys(mod), ['previewDocuments'], 'no write-capable export');
  const src = require('fs').readFileSync(require.resolve('../src/lib/underwriting/clearance-preview'), 'utf8');
  // Call-shaped patterns only (the header COMMENT may name persistProof to say
  // it is untouched — a mention is not a call).
  assert.ok(!/\.persistProof\s*\(|INSERT INTO|UPDATE\s+\w+\s+SET|require\(['"][^'"]*\/db['"]\)/.test(src),
    'no persistence call in the preview module');
  ok('the preview module is structurally read-only (no persist/DB)');
}

console.log(`\nclearance-preview pure — ${passed} checks passed`);
