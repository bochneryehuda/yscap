/* Write-safety guards for the ClickUp sync (owner-directed 2026-07-15, post
 * data-loss report; layered ON TOP of the date-incident fixes in #233/#235).
 * Verifies, with no DB / network:
 *   1. client.guardNoFieldClearing — an empty / null-bearing / NaN-bearing value
 *      can NEVER be written (JSON would turn it into a field-clearing null).
 *   2. client.guardTaskUpdatePayload — task updates are STATUS-ONLY (allowlist);
 *      the sync can never rename a task or touch its description.
 *   3. client.guardNoTaskDeletion — still blocks every task DELETE (regression).
 *   4. mapper.buildTaskFields — never emits an empty-valued custom field, never
 *      emits a location without finite coords (null AND NaN rejected), never
 *      builds a truncated "Name - " title from a whitespace-only address, and
 *      still strips synthetic placeholder borrowers (Jul 7 incident guard).
 *   5. mapper.resolveOnly — scoped keys map exactly (incl. the new portal_stamp
 *      duplicate re-stamping key and the ssn / current_address review-apply keys).
 *   6. orchestrator.PII_OVERWRITE_SHIELD — the full-repush identity shield covers
 *      exactly the borrower PII set (DOB excluded: it has its own day-shift guard).
 *   7. fields.sanitizeDateOnly — real calendar dates only, year window [1900,2100]
 *      (the 0026 incident class).
 * Run: node scripts/test-clickup-write-guards.js */
const client = require('../src/clickup/client');
const mapper = require('../src/clickup/mapper');
const orch = require('../src/clickup/orchestrator');
const F = require('../src/clickup/fields');
const { sanitizeDateOnly } = require('../src/lib/fields');

let pass = 0, fail = 0;
const eq = (name, got, exp) => {
  const g = JSON.stringify(got), e = JSON.stringify(exp);
  if (g === e) { pass++; } else { fail++; console.log(`FAIL ${name}: got ${g} expected ${e}`); }
};
const throws = (name, fn, code) => {
  try { fn(); fail++; console.log(`FAIL ${name}: expected throw`); }
  catch (e) { if (!code || e.code === code) pass++; else { fail++; console.log(`FAIL ${name}: code ${e.code} expected ${code}`); } }
};
const ok = (name, fn) => {
  try { fn(); pass++; } catch (e) { fail++; console.log(`FAIL ${name}: threw ${e.message}`); }
};

// ---- 1. field-clearing writes are structurally impossible -------------------
const EMPTY = 'CLICKUP_EMPTY_WRITE_FORBIDDEN';
throws('clear: null', () => client.guardNoFieldClearing('f1', null), EMPTY);
throws('clear: undefined', () => client.guardNoFieldClearing('f1', undefined), EMPTY);
throws('clear: empty string', () => client.guardNoFieldClearing('f1', ''), EMPTY);
throws('clear: whitespace string', () => client.guardNoFieldClearing('f1', '   '), EMPTY);
throws('clear: empty array', () => client.guardNoFieldClearing('f1', []), EMPTY);
throws('clear: empty users add', () => client.guardNoFieldClearing('f1', { add: [] }), EMPTY);
throws('clear: NaN number', () => client.guardNoFieldClearing('f1', NaN), EMPTY);
throws('clear: NaN latitude', () => client.guardNoFieldClearing('f1',
  { location: { lat: NaN, lng: -75.9 }, formatted_address: '129 Carlisle St' }), EMPTY);
throws('clear: NULL latitude (2026-07-15 audit #1)', () => client.guardNoFieldClearing('f1',
  { location: { lat: null, lng: null }, formatted_address: '129 Carlisle St' }), EMPTY);
throws('clear: Infinity nested', () => client.guardNoFieldClearing('f1', { amount: Infinity }), EMPTY);
throws('clear: undefined nested', () => client.guardNoFieldClearing('f1', { location: { lat: 41.2, lng: undefined } }), EMPTY);
ok('write: real string', () => client.guardNoFieldClearing('f1', '205775'));
ok('write: zero is a value, not a clear', () => client.guardNoFieldClearing('f1', '0'));
ok('write: users add', () => client.guardNoFieldClearing('f1', { add: [81537660] }));
ok('write: real location', () => client.guardNoFieldClearing('f1',
  { location: { lat: 41.2358955, lng: -75.912095 }, formatted_address: '129 Carlisle St' }));

// ---- 2. task updates are status-only (allowlist) ----------------------------
const RENAME = 'CLICKUP_RENAME_FORBIDDEN';
throws('rename blocked', () => client.guardTaskUpdatePayload({ name: 'Pinches Lichtman - ' }), RENAME);
throws('description blocked', () => client.guardTaskUpdatePayload({ description: 'x' }), RENAME);
throws('markdown blocked', () => client.guardTaskUpdatePayload({ markdown_description: 'x' }), RENAME);
throws('unknown key blocked (allowlist)', () => client.guardTaskUpdatePayload({ status: 'x', priority: 1 }), RENAME);
throws('empty status blocked', () => client.guardTaskUpdatePayload({ status: '' }), EMPTY);
ok('status update allowed', () => client.guardTaskUpdatePayload({ status: 'self procesing' }));

// ---- 3. task deletion still hard-blocked (regression) -----------------------
throws('delete task blocked', () => client.guardNoTaskDeletion('DELETE', '/task/868k2xnbm'), 'CLICKUP_DELETE_FORBIDDEN');
ok('delete webhook allowed', () => client.guardNoTaskDeletion('DELETE', '/webhook/abc'));

// ---- 4. the mapper can never build destructive payloads ---------------------
{
  const built = mapper.buildTaskFields({ app: {}, borrower: {}, llc: null, portalAppId: 'app-1', portalFileLink: 'https://x/portal' }, {});
  const empties = built.customFields.filter((c) =>
    c.value == null || c.value === '' || (Array.isArray(c.value) && !c.value.length));
  eq('mapper: zero empty values on a blank file', empties.length, 0);
  eq('mapper: blank file name has no dangling dash', built.name, 'New Borrower');
}
{
  const built = mapper.buildTaskFields({
    app: { property_address: { oneLine: '   ' } },
    borrower: { first_name: 'Pinches', last_name: 'Lichtman' }, llc: null,
  }, {});
  eq('mapper: whitespace address -> clean name', built.name, 'Pinches Lichtman');
  const built2 = mapper.buildTaskFields({
    app: { property_address: { oneLine: '129 Carlisle St', lat: NaN, lng: NaN } },
    borrower: { first_name: 'P', last_name: 'L' }, llc: null,
  }, {});
  eq('mapper: NaN coords -> no location field',
     built2.customFields.some((c) => c.id === F.PIPELINE.subjectAddress), false);
  const built3 = mapper.buildTaskFields({
    app: { property_address: { oneLine: '129 Carlisle St', lat: null, lng: null } },
    borrower: { first_name: 'P', last_name: 'L' }, llc: null,
  }, {});
  eq('mapper: null coords -> no location field (audit #1)',
     built3.customFields.some((c) => c.id === F.PIPELINE.subjectAddress), false);
}
{
  const built = mapper.buildTaskFields({
    app: {}, borrower: { first_name: 'Unknown', last_name: 'Unknown', email: 'noemail+868k@clickup.local' }, llc: null,
  }, {});
  eq('mapper: placeholder borrower never pushed',
     built.customFields.some((c) => [F.SHARED.borrowerName, F.SHARED.borrowerEmail].includes(c.id)), false);
}

// ---- 5. scoped-push key resolution ------------------------------------------
{
  const r = mapper.resolveOnly(['date_of_birth', 'email', 'cell_phone']);
  eq('scope: dob maps', r.cuIds.has(F.SHARED.borrowerDOB), true);
  eq('scope: email maps', r.cuIds.has(F.SHARED.borrowerEmail), true);
  eq('scope: cell maps', r.cuIds.has(F.SHARED.borrowerCell), true);
  const unknown = mapper.resolveOnly(['no_such_column']);
  eq('scope: unknown key maps to nothing', unknown.cuIds.size, 0);
  // Review-apply keys: a sync-review APPROVAL re-pushes only:[field_key] — these
  // must resolve so approved identity changes can actually apply.
  const ssn = mapper.resolveOnly(['ssn']);
  eq('scope: ssn -> borrower SSN field', ssn.cuIds.has(F.SHARED.borrowerSSN), true);
  const addr = mapper.resolveOnly(['current_address']);
  eq('scope: current_address -> borrower address field', addr.cuIds.has(F.SHARED.borrowerAddress), true);
  // Duplicated-task stamp switch-over: 'portal_stamp' scopes EXACTLY the two
  // binding fields, so a newly-linked file re-stamps its task with its own id.
  const stamp = mapper.resolveOnly(['portal_stamp']);
  eq('scope: portal_stamp -> file id', stamp.cuIds.has(F.SYNC.portalFileId), true);
  eq('scope: portal_stamp -> file link', stamp.cuIds.has(F.SYNC.portalFileLink), true);
  eq('scope: portal_stamp maps nothing else', stamp.cuIds.size, 2);
}

// ---- 6. the PII shield covers the borrower identity set ---------------------
for (const [label, fid] of Object.entries({
  name: F.SHARED.borrowerName, ssn: F.SHARED.borrowerSSN,
  email: F.SHARED.borrowerEmail, cell: F.SHARED.borrowerCell, address: F.SHARED.borrowerAddress,
})) eq(`pii shield covers ${label}`, orch.PII_OVERWRITE_SHIELD.has(fid), true);
eq('pii shield: DOB governed by its own day-shift guard, not the shield',
   orch.PII_OVERWRITE_SHIELD.has(F.SHARED.borrowerDOB), false);
eq('pii shield does NOT cover loan amount', orch.PII_OVERWRITE_SHIELD.has(F.PIPELINE.loanAmount), false);
// every shielded field has a review-apply key that resolveOnly can map back
for (const fid of orch.PII_OVERWRITE_SHIELD) {
  const key = orch.PII_REVIEW_KEY[fid];
  eq(`review key exists for ${key}`, typeof key, 'string');
  eq(`review key '${key}' resolves to its field`, mapper.resolveOnly([key]).cuIds.has(fid), true);
}

// ---- 7. sanitizeDateOnly — the 0026 class stops at every entry point --------
eq('date: valid passes', sanitizeDateOnly('2026-07-17'), '2026-07-17');
eq('date: year 0026 rejected', sanitizeDateOnly('0026-07-17'), null);
eq('date: year 9999 rejected', sanitizeDateOnly('9999-01-01'), null);
eq('date: impossible day rejected', sanitizeDateOnly('2026-02-31'), null);
eq('date: garbage rejected', sanitizeDateOnly('07/17/26'), null);
eq('date: blank -> null', sanitizeDateOnly(''), null);
eq('date: null -> null', sanitizeDateOnly(null), null);
eq('date: ISO datetime accepted as its day', sanitizeDateOnly('2026-07-17T14:30:00Z'), '2026-07-17');
eq('date: 1900 boundary passes', sanitizeDateOnly('1900-01-01'), '1900-01-01');
eq('date: 2100 boundary passes', sanitizeDateOnly('2100-12-31'), '2100-12-31');

// ---- 8. normalizeTypedDate — a typed 2-digit year resolves to the REAL year --
// (owner-directed 2026-07-15: "everybody should look on the data the same way —
// a real date, not typed 26 or 2026" — on EVERY date in the system.)
const { normalizeTypedDate } = require('../src/lib/fields');
eq('typed 26 closing -> 2026', normalizeTypedDate('0026-07-17'), '2026-07-17');
eq('typed 26 DOB -> 1926 (a borrower is an adult)', normalizeTypedDate('0026-07-17', 'dob'), '1926-07-17');
eq('typed 99 DOB -> 1999', normalizeTypedDate('0099-11-27', 'dob'), '1999-11-27');
eq('typed 05 DOB -> 2005 (already an adult)', normalizeTypedDate('0005-03-03', 'dob'), '2005-03-03');
eq('year 0203 has no safe interpretation', normalizeTypedDate('0203-01-01'), null);
eq('valid date passes through', normalizeTypedDate('2026-07-17'), '2026-07-17');
eq('valid DOB passes through', normalizeTypedDate('1972-02-26', 'dob'), '1972-02-26');
eq('garbage still rejected', normalizeTypedDate('26'), null);

// ---- 9. object-value equivalence (post-merge audit #2) -----------------------
// An IDENTICAL borrower address must be recognized as a no-op, or every full
// repush blocks it via the PII shield and queues a pointless review row.
{
  const feq = mapper.fieldValueEquivalent;
  const ADDR = F.SHARED.borrowerAddress;
  const cuLoc = (lat, lng, fa) => ({ location: { lat, lng }, formatted_address: fa, place_id: 'x' });
  const ourLoc = (lat, lng, fa) => ({ location: { lat, lng }, formatted_address: fa });
  eq('loc: identical coords equivalent', feq(ADDR, cuLoc(40.6980404, -73.956911, '74 Kent Ave'), ourLoc(40.6980404, -73.956911, '74 Kent Ave')), true);
  eq('loc: near-identical coords equivalent (~10m)', feq(ADDR, cuLoc(40.69805, -73.95692, 'x'), ourLoc(40.69804, -73.95691, 'y')), true);
  eq('loc: different address NOT equivalent', feq(ADDR, cuLoc(40.69, -73.95, 'a'), ourLoc(41.23, -75.91, 'b')), false);
  eq('loc: formatted fallback matches', feq(ADDR, { formatted_address: '74 Kent Ave, Brooklyn, NY' }, ourLoc(40.69, -73.95, '74 Kent Ave Brooklyn NY')), true);
  const USERS = F.SHARED.loanOfficer;
  eq('users: already assigned = no-op', feq(USERS, [{ id: 81537660 }], { add: [81537660] }), true);
  eq('users: new assignee NOT equivalent', feq(USERS, [{ id: 111 }], { add: [81537660] }), false);
  eq('unknown object shape always writes', feq('f1', 'old', { some: 'thing' }), false);
}

// ---- 10. a DOB is a human decision and belongs to an adult -------------------
// (owner-directed 2026-07-15 after the Shaindel Schwimmer rewrite + the
// 12/11/2022 toddler-DOB discovery.)
const { sanitizeDob } = require('../src/lib/fields');
eq('dob: adult passes', sanitizeDob('1995-10-19'), '1995-10-19');
eq('dob: toddler rejected (the 12/11/2022 class)', sanitizeDob('2022-12-11'), null);
eq('dob: 130-year-old rejected', sanitizeDob('1890-01-01'), null);
eq('dob: typed 2-digit pivots to adult century', sanitizeDob('0095-10-19'), '1995-10-19');
eq('dob: typed 26 -> 1926', sanitizeDob('0026-11-19'), '1926-11-19');
eq('dob: garbage rejected', sanitizeDob('not-a-date'), null);
{
  const DOB = F.SHARED.borrowerDOB;
  eq('dobChange: any-magnitude change detected',
     mapper.isDobChange(DOB, Date.UTC(1995, 9, 19, 8), Date.UTC(1996, 10, 19, 8)), true);
  eq('dobChange: exactly one day also detected',
     mapper.isDobChange(DOB, Date.UTC(1988, 11, 3, 8), Date.UTC(1988, 11, 2, 8)), true);
  eq('dobChange: same day, different convention = no change',
     mapper.isDobChange(DOB, Date.UTC(1995, 9, 19), Date.UTC(1995, 9, 19, 8)), false);
  eq('dobChange: blank old = a FILL, not a change',
     mapper.isDobChange(DOB, null, Date.UTC(1995, 9, 19, 8)), false);
  eq('dobChange: never fires on non-DOB fields',
     mapper.isDobChange(F.PIPELINE.loanAmount, 100, 200), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
