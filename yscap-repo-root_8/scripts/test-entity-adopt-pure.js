#!/usr/bin/env node
'use strict';
/**
 * Pure tests for src/lib/underwriting/entity-adopt.js — the "add this LLC to the borrower's
 * profile" button the owner asked for (2026-08-02), and the liquidity guard that comes with it.
 *
 * No database. Every assertion here is about a decision the module makes on its own:
 *   · which findings offer the button (and which must never)
 *   · which document belongs in which entity slot, matched by MEANING not spelling
 *   · which adopted entities are held out of the liquidity total (the over-count guard)
 *   · when the operating agreement counts as the ownership proof that settles the finding
 */
const assert = require('assert');
const ea = require('../src/lib/underwriting/entity-adopt');

// ---- 1. adoptTargetOf: only the two ownership ADVISORIES offer the button -----------------
const other = ea.adoptTargetOf({ code: 'bank_account_other_entity', doc_value: 'Beta Holdings LLC' });
assert.ok(other, 'a different-entity finding names an entity to add');
assert.strictEqual(other.entityName, 'Beta Holdings LLC');

const unver = ea.adoptTargetOf({ code: 'bank_business_entity_unverified', docValue: 'Beta Holdings LLC' });
assert.ok(unver, 'a known-but-unverified business account offers it too (camelCase docValue)');
assert.strictEqual(unver.entityName, 'Beta Holdings LLC');

// The check's own `entityName` wins when present (it is the holder as READ, before any storage
// round-trip) — and a stored row that only kept doc_value still works, which is the real production
// path (document_findings has no entityName column).
assert.strictEqual(
  ea.adoptTargetOf({ code: 'bank_account_other_entity', entityName: 'Alpha LLC', doc_value: 'ignored' }).entityName,
  'Alpha LLC');

// NEVER on the fatal third-party PERSONAL account — that is a question about a human, not an entity
// to put on the profile. Adopting "Jane Doe" as an LLC would be nonsense AND would make her account
// count as the borrower's.
assert.strictEqual(ea.adoptTargetOf({ code: 'bank_account_not_borrower', doc_value: 'Jane Doe' }), null);
// …and never on an unrelated finding, a nameless one, or nothing at all.
assert.strictEqual(ea.adoptTargetOf({ code: 'bank_missing_page', doc_value: 'x' }), null);
assert.strictEqual(ea.adoptTargetOf({ code: 'bank_account_other_entity', doc_value: '   ' }), null);
assert.strictEqual(ea.adoptTargetOf({ code: 'bank_account_other_entity' }), null);
assert.strictEqual(ea.adoptTargetOf(null), null);

// ---- 2. matchEntityDocs: the right document into the right slot, matched by MEANING --------
const exts = [
  { document_id: 'doc-oa', doc_type: 'operating_agreement', fields: { entityLegalName: 'Beta Holdings, L.L.C.' } },
  { document_id: 'doc-art', doc_type: 'llc_formation', fields: { entityLegalName: 'BETA HOLDINGS LLC' } },
  { document_id: 'doc-ein', doc_type: 'ein_letter', fields: { entityLegalName: 'Beta Holdings LLC' } },
  { document_id: 'doc-other', doc_type: 'operating_agreement', fields: { entityLegalName: 'Gamma Ventures LLC' } },
  { document_id: 'doc-stmt', doc_type: 'bank_statement', fields: { accountHolderName: 'Beta Holdings LLC' } },
  { document_id: 'doc-blank', doc_type: 'operating_agreement', fields: {} },
];
const m = ea.matchEntityDocs('Beta Holdings LLC', exts);
const bySlot = Object.fromEntries(m.primary.map((d) => [d.slotCode, d.documentId]));
assert.strictEqual(bySlot.rtl_llc_opagmt, 'doc-oa', 'the operating agreement goes on the OA slot');
assert.strictEqual(bySlot.rtl_llc_formation, 'doc-art', 'the articles go on the formation slot');
assert.strictEqual(bySlot.rtl_llc_ein, 'doc-ein', 'the EIN letter goes on the EIN slot');
assert.strictEqual(m.primary.length, 3, 'exactly the three that belong to this entity');
// NEVER-GUESS: a different entity's agreement, a non-entity document, and an entity document with
// no legal name on it are all left alone — a blank name is not a licence to file it somewhere.
assert.ok(!m.primary.some((d) => d.documentId === 'doc-other'), 'another entity’s OA is never carried');
assert.ok(!m.primary.some((d) => d.documentId === 'doc-blank'), 'an unnamed OA is never carried');
assert.ok(!m.primary.some((d) => d.documentId === 'doc-stmt'), 'a bank statement is not an entity document');
// Shape is CONSTANT — callers destructure `{primary, extra}`, so the blank/empty paths must not
// hand back a bare array (a `for…of undefined` would throw inside the adoption).
assert.deepStrictEqual(ea.matchEntityDocs('', exts), { primary: [], extra: [] }, 'a blank entity name matches nothing');
assert.deepStrictEqual(ea.matchEntityDocs('Beta Holdings LLC', []), { primary: [], extra: [] }, 'no extractions → nothing');
assert.deepStrictEqual(ea.matchEntityDocs('Beta Holdings LLC', null), { primary: [], extra: [] });

// Two agreements for the SAME entity: one fills the slot, the other is REPORTED as an extra rather
// than stacked (a slot showing the same agreement twice helps nobody, and silently dropping it
// would hide that we saw it).
const dup = ea.matchEntityDocs('Beta Holdings LLC', [
  { document_id: 'oa1', doc_type: 'operating_agreement', fields: { entityLegalName: 'Beta Holdings LLC' } },
  { document_id: 'oa2', doc_type: 'operating_agreement', fields: { entityLegalName: 'Beta Holdings LLC' } },
]);
assert.strictEqual(dup.primary.length, 1);
assert.strictEqual(dup.extra.length, 1);

// ---- 3. entityDocsPendingNames — THE OVER-COUNT GUARD --------------------------------------
// bank-liquidity counts an account as the borrower's when its holder matches any entity on the
// profile. So an entity PILOT added from a finding, with nothing yet proving ownership, must stay
// OUT of that set — otherwise one click on the button would move its whole balance into the file's
// provable liquidity.
const pending = ea.entityDocsPendingNames([
  { llc_name: 'Just Adopted LLC', is_verified: false, adopted: true, has_entity_doc: false },
  { llc_name: 'Adopted With Docs LLC', is_verified: false, adopted: true, has_entity_doc: true },
  { llc_name: 'Adopted And Verified LLC', is_verified: true, adopted: true, has_entity_doc: false },
  { llc_name: 'Typed By A Human LLC', is_verified: false, adopted: false, has_entity_doc: false },
  { llc_name: '', is_verified: false, adopted: true, has_entity_doc: false },
]);
assert.deepStrictEqual(pending, ['Just Adopted LLC'],
  'only an adopted, unverified, document-less entity is held back');
// The three release paths, spelled out so none of them can be quietly removed:
assert.ok(!pending.includes('Adopted With Docs LLC'), 'a document landing releases the hold on its own');
assert.ok(!pending.includes('Adopted And Verified LLC'), 'verification releases it too');
assert.ok(!pending.includes('Typed By A Human LLC'), 'an entity a human put on the profile is NEVER held back');
assert.deepStrictEqual(ea.entityDocsPendingNames([]), []);
assert.deepStrictEqual(ea.entityDocsPendingNames(null), []);

// And the liquidity engine really consumes it — the guard is worthless if the wiring is missing.
const { assessBankLiquidity } = require('../src/lib/underwriting/bank-liquidity');
const stmts = [{
  doc_type: 'bank_statement', document_id: 'd1',
  fields: { accountHolderName: 'Just Adopted LLC', holderIsBusiness: true, closingBalance: 250000, bankName: 'Chase' },
}];
const ctxNoGuard = { borrower: { first_name: 'John', last_name: 'Smith' }, entityNames: ['Just Adopted LLC'] };
const withGuard = { ...ctxNoGuard, entityDocsPendingNames: ['Just Adopted LLC'] };
assert.strictEqual(assessBankLiquidity(ctxNoGuard, stmts, {}).qualifyingTotal, 250000,
  'baseline: an entity on the profile makes its balance count (unchanged behaviour)');
const guarded = assessBankLiquidity(withGuard, stmts, {});
assert.strictEqual(guarded.qualifyingTotal, 0, 'a funds-pending entity’s balance does NOT count');
assert.strictEqual(guarded.excludedTotal, 250000, 'it lands in the excluded column, not nowhere');
assert.strictEqual(guarded.accounts[0].tied, false, 'and the account reads as not-tied on the desk');
// Case/spacing must not defeat the guard (the profile name and the statement holder are typed by
// different people), and an unrelated entity is untouched.
const guardedCase = assessBankLiquidity(
  { ...ctxNoGuard, entityNames: ['just adopted llc '], entityDocsPendingNames: ['Just Adopted LLC'] }, stmts, {});
assert.strictEqual(guardedCase.qualifyingTotal, 0, 'the hold is case/whitespace insensitive');

// ---- 4. ownershipProofLanded — what actually SATISFIES the finding -------------------------
assert.strictEqual(ea.ownershipProofLanded({ carried: [{ docType: 'operating_agreement' }] }), true,
  'carrying the operating agreement is the proof the owner named');
assert.strictEqual(
  ea.ownershipProofLanded({ carried: [], skipped: [{ docType: 'operating_agreement', reason: 'already_on_this_slot' }] }), true,
  'an agreement already on the slot from an earlier click counts the same — a second click must agree with the first');
assert.strictEqual(ea.ownershipProofLanded({ carried: [{ docType: 'llc_formation' }, { docType: 'ein_letter' }] }), false,
  'articles + EIN prove the company EXISTS, not who controls it — the finding stays open');
assert.strictEqual(
  ea.ownershipProofLanded({ carried: [], skipped: [{ docType: 'operating_agreement', reason: 'copy_failed' }] }), false,
  'an agreement we FAILED to copy is not on the profile — never treat a failure as proof');
assert.strictEqual(ea.ownershipProofLanded({ carried: [], skipped: [] }), false);
assert.strictEqual(ea.ownershipProofLanded(null), false);

// ---- 5. The slot map points at REAL, live template codes ----------------------------------
// The class of bug this replaces: the suggestion proposed `rtl_llc_opagmt`, a real template that is
// scope='llc' and therefore cannot be posted onto a FILE — every click 400'd. Pin both halves.
// (Read from the migration text rather than src/lib/llc so this test stays free of the DB layer.)
const fs = require('fs');
const path = require('path');
const DB_DIR = path.join(__dirname, '..', 'db');
const allMigrations = fs.readdirSync(DB_DIR).filter((f) => f.endsWith('.sql'))
  .map((f) => fs.readFileSync(path.join(DB_DIR, f), 'utf8')).join('\n');
for (const code of Object.values(ea.SLOT_FOR_DOC_TYPE)) {
  assert.ok(allMigrations.includes(`'${code}'`), `the slot template ${code} is a real seeded template`);
}
assert.strictEqual(ea.SLOT_FOR_DOC_TYPE.operating_agreement, 'rtl_llc_opagmt');
// The specific trap: the operating-agreement SLOT is llc-scoped (db/005), which is why it can never
// be the template a file-level condition button posts.
const rtl005 = fs.readFileSync(path.join(DB_DIR, '005_rtl_workflow.sql'), 'utf8');
assert.ok(/'rtl_llc_opagmt','[^']*','llc'/.test(rtl005), 'rtl_llc_opagmt is a slot ON THE ENTITY, not a file condition');
const { OA_CASCADE_TEMPLATE_CODES } = require('../src/lib/underwriting/bank-statement-suggestions');
assert.strictEqual(OA_CASCADE_TEMPLATE_CODES[0], ea.ENTITY_DOCS_TEMPLATE_CODE,
  'the condition the suggestion proposes is the application-scoped entity-documents template');
assert.notStrictEqual(OA_CASCADE_TEMPLATE_CODES[0], 'rtl_llc_opagmt',
  'never propose an llc-scoped slot as a FILE condition — the route cannot instantiate it');

// The migration that installs it must actually be there, with that scope.
const sql = fs.readFileSync(path.join(__dirname, '..', 'db', '397_entity_adoption.sql'), 'utf8');
assert.ok(sql.includes(`'${ea.ENTITY_DOCS_TEMPLATE_CODE}'`), 'db/397 seeds the entity-documents template');
assert.ok(/'application', 'both', 'document'/.test(sql), 'and seeds it application-scoped so it can be posted on a file');
assert.ok(/adopted_from_application_id/.test(sql) && /adopted_at/.test(sql), 'db/397 adds the adoption stamp the liquidity guard reads');

// ---- 6. adoptionSummary — the sentence recorded on the finding -----------------------------
const s1 = ea.adoptionSummary({ entityName: 'Beta Holdings LLC', created: true,
  carried: [{ docType: 'operating_agreement' }], conditionId: 'c1', conditionExisted: false });
assert.match(s1, /Added "Beta Holdings LLC" to the borrower's profile/);
assert.match(s1, /operating agreement/);
assert.match(s1, /Posted the entity-documents condition/);
const s2 = ea.adoptionSummary({ entityName: 'Beta Holdings LLC', created: false, carried: [], conditionId: null });
assert.match(s2, /already on the borrower's profile/);
assert.match(s2, /No entity documents for it were on this file/);
// A SECOND click carries nothing because the agreement is already on the slot — the note must
// describe the STATE, not this run's activity, or it would contradict the decision it explains.
const s3 = ea.adoptionSummary({ entityName: 'Beta Holdings LLC', created: false, carried: [],
  skipped: [{ docType: 'operating_agreement', reason: 'already_on_this_slot' }],
  conditionId: 'c1', conditionExisted: true });
assert.match(s3, /operating agreement was already on the entity/);
assert.ok(!/slots are still empty/.test(s3), 'never claims the slots are empty when the agreement is on them');

console.log('OK test-entity-adopt-pure');
