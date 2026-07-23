'use strict';
/**
 * R6.16 (findings-export) — pure tests for the whole-loan findings export serializer.
 * Proves it (1) flattens a decision's findings into stable columns, (2) CSV-escapes
 * commas/quotes/newlines and neutralizes formula-injection, (3) prepends a decision
 * summary line + gate flags, (4) filters to only-blocking on request, (5) scrubs a
 * capital-partner name in borrowerSafe mode, and (6) never throws.
 */
const assert = require('assert');
const fx = require('../src/lib/underwriting/findings-export');
const { decide } = require('../src/lib/underwriting/decision');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- rows from a real decision ---
let d = decide({
  engineStatus: 'ELIGIBLE',
  findings: [
    { code: 'title_defect', severity: 'fatal', category: 'title', title: 'Open lien on title', explanation: 'Clear the lien.', blocks_ctc: true, evidence: [{ id: 1 }] },
    { code: 'reserve_note', severity: 'advisory', title: 'Prefers 6mo reserves' },
  ],
});
let rows = fx.findingRows(d);
assert.strictEqual(rows.length, 2);
const lien = rows.find((r) => r.code === 'title_defect');
assert.strictEqual(lien.severity, 'fatal');
assert.strictEqual(lien.blocks_ctc, true);
assert.strictEqual(lien.evidence_count, 1);
ok('findingRows flattens a decision registry into stable columns');

// --- onlyBlocking filters to blocking/fatal ---
rows = fx.findingRows(d, { onlyBlocking: true });
assert.strictEqual(rows.length, 1, 'only the fatal/blocking finding survives onlyBlocking');
assert.strictEqual(rows[0].code, 'title_defect');
ok('onlyBlocking keeps just the blocking/fatal findings');

// --- CSV escaping: comma, quote, newline, and formula injection ---
const esc = fx._internals.csvEscape;
assert.strictEqual(esc('plain'), 'plain');
assert.strictEqual(esc('a,b'), '"a,b"', 'a comma forces quoting');
assert.strictEqual(esc('she said "hi"'), '"she said ""hi"""', 'quotes are doubled');
assert.strictEqual(esc('line1\nline2'), '"line1\nline2"', 'a newline forces quoting');
assert.strictEqual(esc('=SUM(A1)'), "'=SUM(A1)", 'a leading = is neutralized (CSV injection)');
assert.strictEqual(esc('+49'), "'+49");
ok('CSV escaping quotes commas/quotes/newlines and neutralizes a leading formula char');

// --- full CSV has a summary line, a header, and one row per finding ---
let csv = fx.toCSV(d);
const lines = csv.split('\r\n');
assert.ok(/^# status=ELIGIBLE;/.test(lines[0]), 'the first line is the decision summary');
assert.ok(/ctc=no/.test(lines[0]), 'the CTC gate is blocked by the fatal finding');
assert.strictEqual(lines[1], 'Code,Severity,Category,Finding,Detail,Sources,Blocks term sheet,Blocks CTC,Blocks funding,Evidence items', 'the header row');
assert.strictEqual(lines.length, 4, 'summary + header + 2 findings');
assert.ok(lines.some((l) => /title_defect/.test(l) && /yes/.test(l)), 'the fatal finding row is present with a yes flag');
ok('toCSV emits a summary line, the header, and one escaped row per finding');

// --- a finding title with a comma stays one cell ---
d = decide({ engineStatus: 'INELIGIBLE', findings: [{ code: 'x', severity: 'fatal', title: 'LTV 82%, over the 80% cap', blocks_funding: true }] });
csv = fx.toCSV(d);
assert.ok(/"LTV 82%, over the 80% cap"/.test(csv), 'the comma-bearing title is quoted as one cell');
ok('a comma inside a finding title does not break the row (stays one quoted cell)');

// --- toExport gives gates + counts + csv together ---
let ex = fx.toExport(d);
assert.strictEqual(ex.status, 'INELIGIBLE');
assert.strictEqual(ex.gates.funding, false);
assert.strictEqual(ex.counts.total, 1);
assert.strictEqual(ex.counts.fatal, 1);
assert.ok(typeof ex.csv === 'string' && ex.csv.length > 0);
assert.deepStrictEqual(ex.columns.map((c) => c.key), fx.COLUMNS.map((c) => c.key));
ok('toExport returns status + gates + rows + counts + csv together');

// --- borrowerSafe scrubs a capital-partner name from the free-form text ---
d = decide({ engineStatus: 'INELIGIBLE', findings: [{ code: 'y', severity: 'fatal', title: 'BlueLake will not buy this note', explanation: 'BlueLake needs 2mo reserves', blocks_funding: true }] });
const safe = fx.toExport(d, { borrowerSafe: true });
assert.ok(!/bluelake|blue lake/i.test(JSON.stringify(safe)), 'no capital-partner name in the borrower-safe export');
ok('borrowerSafe scrubs a capital-partner name from the exported finding text');

// --- empty / junk / hostile input is safe ---
assert.doesNotThrow(() => fx.toExport(null));
assert.strictEqual(fx.toExport(null).counts.total, 0);
assert.ok(/Code,Severity/.test(fx.toCSV(null)), 'a null decision still yields a valid header-only CSV');
assert.doesNotThrow(() => fx.findingRows({ registry: 'notarray', blockingFindings: 42 }));
assert.doesNotThrow(() => fx.toCSV({ findings: [null, 'x', 7, {}] }));
assert.doesNotThrow(() => fx.toExport({ get status() { throw new Error('boom'); } }));
assert.doesNotThrow(() => fx.findingRows({ findings: [{ get title() { throw new Error('boom'); }, severity: 'fatal' }] }));
ok('empty / null / junk / throwing-getter input is safe (never throws)');

console.log(`\nR6.16 findings-export pure — ${passed} checks passed`);
