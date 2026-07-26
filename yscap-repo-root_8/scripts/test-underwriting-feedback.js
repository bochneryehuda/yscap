'use strict';
/**
 * Unit tests for the feedback loop (src/lib/underwriting/feedback.js) — the per-finding-type
 * real-vs-false-alarm report the underwriter resolutions "train". Pure — no DB/network.
 */
const assert = require('assert');
const { falseAlarmReport, readabilityReport, bucketOf } = require('../src/lib/underwriting/feedback');

// bucketOf maps each resolution verb to its signal.
assert.strictEqual(bucketOf('post_condition'), 'real');
assert.strictEqual(bucketOf('request_document'), 'real');
assert.strictEqual(bucketOf('fix_file'), 'real');
assert.strictEqual(bucketOf('grant_exception'), 'real');
assert.strictEqual(bucketOf('decline'), 'real');
assert.strictEqual(bucketOf('dismiss'), 'false');
assert.strictEqual(bucketOf('clear'), 'cleared');
assert.strictEqual(bucketOf(null), 'pending');
assert.strictEqual(bucketOf('unknown_verb'), 'pending');

// A finding type dismissed 3 of 4 decided times → 75% false-alarm rate; clears/pending excluded.
const rows = [
  { code: 'id_address_mismatch', severity: 'warning', resolution: 'dismiss', status: 'dismissed' },
  { code: 'id_address_mismatch', severity: 'warning', resolution: 'dismiss', status: 'dismissed' },
  { code: 'id_address_mismatch', severity: 'warning', resolution: 'dismiss', status: 'dismissed' },
  { code: 'id_address_mismatch', severity: 'warning', resolution: 'fix_file', status: 'resolved' },
  { code: 'id_address_mismatch', severity: 'warning', resolution: 'clear', status: 'resolved' },     // cleared — excluded from rate
  { code: 'id_address_mismatch', severity: 'warning', resolution: null, status: 'open' },            // pending — excluded
  // A rock-solid check: always acted on → 0% false.
  { code: 'cross_seller_mismatch', severity: 'fatal', resolution: 'post_condition', status: 'open' }, // open posted condition → pending
  { code: 'cross_seller_mismatch', severity: 'fatal', resolution: 'request_document', status: 'resolved' },
  { code: 'cross_seller_mismatch', severity: 'fatal', resolution: 'fix_file', status: 'resolved' },
];
const { byCode, totals } = falseAlarmReport(rows);

const idRow = byCode.find((r) => r.code === 'id_address_mismatch');
assert.strictEqual(idRow.false, 3, '3 dismissals counted false');
assert.strictEqual(idRow.real, 1, '1 fix_file counted real');
assert.strictEqual(idRow.cleared, 1, '1 clear counted separately');
assert.strictEqual(idRow.pending, 1, '1 open finding pending');
assert.strictEqual(idRow.decided, 4, 'only real+false are decided');
assert.strictEqual(idRow.falseAlarmPct, 75, '3 of 4 decided = 75% false-alarm rate');

const crossRow = byCode.find((r) => r.code === 'cross_seller_mismatch');
assert.strictEqual(crossRow.real, 3, 'a posted condition counts as real even while still open');
assert.strictEqual(crossRow.pending, 0, 'nothing pending — every one was acted on');
assert.strictEqual(crossRow.falseAlarmPct, 0, 'a check that is always acted on has a 0% false rate');

// Worst-signal-first ordering: the 75% false type sorts above the 0% type.
assert.strictEqual(byCode[0].code, 'id_address_mismatch', 'noisiest check surfaces first');

// Totals: 3 false + 4 real decided across the file (the open posted condition is real now).
assert.strictEqual(totals.real, 4);
assert.strictEqual(totals.false, 3);
assert.strictEqual(totals.falseAlarmPct, Math.round((3 / 7) * 100), '3 of 7 decided = 43% false');

// Empty input is safe.
const empty = falseAlarmReport([]);
assert.deepStrictEqual(empty.byCode, []);
assert.strictEqual(empty.totals.falseAlarmRate, null);

// ---- readabilityReport (Item 13): per-doc-type read outcomes + second-look rescue rate ----------
const reads = [
  // bank_statement: 2 clean, 1 unreadable, 1 error → 50% unreadable; 1 read was rescued by second-look.
  { doc_type: 'bank_statement', confidence: 'high', status: 'analyzed', second_look: false },
  { doc_type: 'bank_statement', confidence: 'medium', status: 'analyzed', second_look: true },   // clean, but only via the backup vision read
  { doc_type: 'bank_statement', confidence: 'unreadable', status: 'analyzed', second_look: false },
  { doc_type: 'bank_statement', confidence: 'high', status: 'error', second_look: false },        // an error read
  // government_id: all clean → 0% unreadable (should sort below the failing type).
  { doc_type: 'government_id', confidence: 'high', status: 'analyzed', second_look: false },
  { doc_type: 'government_id', confidence: 'high', status: 'analyzed', second_look: false },
  { doc_type: null, confidence: 'high', status: 'analyzed' },  // no doc_type → ignored
];
const rep = readabilityReport(reads);

const bank = rep.byType.find((r) => r.docType === 'bank_statement');
assert.strictEqual(bank.total, 4, '4 bank-statement reads');
assert.strictEqual(bank.clean, 2, '2 clean reads (one via second-look)');
assert.strictEqual(bank.unreadable, 1, '1 unreadable read');
assert.strictEqual(bank.error, 1, '1 error read');
assert.strictEqual(bank.failed, 2, 'unreadable + error = 2 failed');
assert.strictEqual(bank.secondLook, 1, '1 read was rescued by the backup vision second-look');
assert.strictEqual(bank.unreadablePct, 50, '2 of 4 reads failed = 50%');
assert.strictEqual(bank.readablePct, 50, 'the complement is 50% readable');

const gid = rep.byType.find((r) => r.docType === 'government_id');
assert.strictEqual(gid.total, 2, '2 government-id reads');
assert.strictEqual(gid.failed, 0, 'both clean → nothing failed');
assert.strictEqual(gid.unreadablePct, 0, 'a doc type that always reads has 0% unreadable');

// Worst-read-rate first: the 50%-failing bank statement sorts above the 0%-failing government ID.
assert.strictEqual(rep.byType[0].docType, 'bank_statement', 'the hardest-to-read type surfaces first');
// A null doc_type row never becomes its own bucket.
assert.ok(!rep.byType.some((r) => r.docType == null), 'rows without a doc_type are skipped');

// Totals across both types: 6 reads, 2 failed → 33%, 1 second-look rescue.
assert.strictEqual(rep.totals.total, 6);
assert.strictEqual(rep.totals.failed, 2);
assert.strictEqual(rep.totals.secondLook, 1);
assert.strictEqual(rep.totals.unreadablePct, Math.round((2 / 6) * 100), '2 of 6 reads failed = 33%');

// Empty input is safe.
const emptyRead = readabilityReport([]);
assert.deepStrictEqual(emptyRead.byType, []);
assert.strictEqual(emptyRead.totals.unreadableRate, null);

console.log('✓ test-underwriting-feedback: real-vs-false-alarm + readability self-audit cases pass');
