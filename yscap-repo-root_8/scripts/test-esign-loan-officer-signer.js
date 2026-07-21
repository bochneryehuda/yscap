/* Term-sheet loan-officer signer (owner-directed 2026-07-21): the assigned LO
 * signs the term sheet at routingOrder 1 alongside the borrower(s); the
 * super_admin lender counter-signs at routingOrder 2. This pure test drives the
 * roster builder + tabsFor + resolveRecipientIdentity + the subject helpers +
 * the address one-liner — no DB, no network. Run: node scripts/test-esign-loan-officer-signer.js
 */
const orch = require('../src/lib/esign/orchestrate');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('FAIL ' + n); } };

// The three package specs the send layer uses. Mirror shape only — no engine
// call. loanOfficerRequired is on term_sheet_package, not the others.
const tsSpec = { soloBorrower: false, countersignRequired: true, loanOfficerRequired: true,
  docs: [
    { kind: 'term_sheet', prefix: 'ts', signedKind: 'term_sheet_signed', condition: 'x' },
    { kind: 'application_export', prefix: 'app', signedKind: 'application_signed', condition: 'y', generate: true },
    { kind: 'bp_disclosure', prefix: 'bpd', signedKind: 'bp_disclosure_signed', condition: 'z', generate: true },
  ],
};
const iskaSpec = { soloBorrower: false, countersignRequired: false,
  docs: [{ kind: 'heter_iska', prefix: 'iska', signedKind: 'heter_iska_signed', condition: 'q' }] };
const drawSpec = { soloBorrower: true, countersignRequired: false, skipAppraisalGate: true,
  docs: [{ kind: 'draw_request', prefix: 'dr', signedKind: 'draw_request_signed', condition: 'd', wireForm: true }] };

const appNoCoNoLo = {
  b_id: 'B1', b_first: 'Moshe', b_last: 'Spitzer', b_email: 'moshe@example.com',
  cb_id: null, cb_first: null, cb_last: null, cb_email: null, co_borrower_id: null,
  loan_officer_id: null, officer_name: null, officer_email: null,
};
const appCoNoLo = { ...appNoCoNoLo,
  cb_id: 'C1', cb_first: 'Sarah', cb_last: 'Spitzer', cb_email: 'sarah@example.com', co_borrower_id: 'C1' };
const appNoCoLo = { ...appNoCoNoLo,
  loan_officer_id: 'S1', officer_name: 'Mendel Bochner', officer_email: 'mendelb@yscapgroup.com' };
const appCoLo = { ...appCoNoLo,
  loan_officer_id: 'S1', officer_name: 'Mendel Bochner', officer_email: 'mendelb@yscapgroup.com' };

// ================================================================
// buildRoster: LO is appended at routingOrder 1, admin at 2, when the file
// has an assigned LO with an email AND the spec has loanOfficerRequired.
// Recipient-id numbering must not collide.
// ================================================================
{ const r = orch.buildRoster(appNoCoNoLo, tsSpec, 'ENV1');
  ok('ts no-co no-lo: borrower + admin', r.length === 2);
  ok('ts no-co no-lo: borrower recipientId 1', r[0].recipientId === '1' && r[0].role === 'borrower');
  ok('ts no-co no-lo: admin recipientId 2', r[1].recipientId === '2' && r[1].role === 'admin' && r[1].routingOrder === 2);
  ok('ts no-co no-lo: NO loan_officer seat', !r.some((x) => x.role === 'loan_officer')); }

{ const r = orch.buildRoster(appCoNoLo, tsSpec, 'ENV2');
  ok('ts co no-lo: borrower + co + admin', r.length === 3);
  ok('ts co no-lo: co recipientId 2', r[1].role === 'co_borrower' && r[1].recipientId === '2');
  ok('ts co no-lo: admin recipientId 3', r[2].role === 'admin' && r[2].recipientId === '3' && r[2].routingOrder === 2);
  ok('ts co no-lo: NO loan_officer seat', !r.some((x) => x.role === 'loan_officer')); }

{ const r = orch.buildRoster(appNoCoLo, tsSpec, 'ENV3');
  ok('ts no-co lo: borrower + LO + admin', r.length === 3);
  ok('ts no-co lo: LO recipientId 2', r[1].role === 'loan_officer' && r[1].recipientId === '2' && r[1].routingOrder === 1);
  ok('ts no-co lo: LO email/name from officer', r[1].email === 'mendelb@yscapgroup.com' && r[1].name === 'Mendel Bochner');
  ok('ts no-co lo: LO not counter-signer', r[1].isCountersigner === false);
  ok('ts no-co lo: admin recipientId 3, order 2', r[2].role === 'admin' && r[2].recipientId === '3' && r[2].routingOrder === 2); }

{ const r = orch.buildRoster(appCoLo, tsSpec, 'ENV4');
  ok('ts co lo: borrower + co + LO + admin', r.length === 4);
  ok('ts co lo: numbering 1..4', r[0].recipientId === '1' && r[1].recipientId === '2' && r[2].recipientId === '3' && r[3].recipientId === '4');
  ok('ts co lo: roles in order', r[0].role === 'borrower' && r[1].role === 'co_borrower' && r[2].role === 'loan_officer' && r[3].role === 'admin');
  ok('ts co lo: LO at routing 1, admin at 2', r[2].routingOrder === 1 && r[3].routingOrder === 2); }

// Iska has no counter-sign / no LO — even with an LO assigned, no LO seat is added.
{ const r = orch.buildRoster(appCoLo, iskaSpec, 'ENV5');
  ok('iska: no admin, no LO', r.length === 2 && !r.some((x) => x.role === 'admin' || x.role === 'loan_officer')); }

// Draw request (soloBorrower) is unchanged by the LO flag — one signer only.
{ const r = orch.buildRoster(appCoLo, drawSpec, 'ENV6');
  ok('draw solo: one signer, no LO/admin', r.length === 1 && r[0].role === 'borrower'); }

// A file with loan_officer_id but no officer_email → NO LO seat (the send would
// have no address to deliver to; the flow must not block on it).
{ const r = orch.buildRoster({ ...appNoCoLo, officer_email: null }, tsSpec, 'ENV7');
  ok('ts lo w/o email: NO LO seat', !r.some((x) => x.role === 'loan_officer'));
  ok('ts lo w/o email: still has admin', r.some((x) => x.role === 'admin')); }

// ================================================================
// tabsFor: LO gets tabs on the TERM SHEET ONLY (like admin), never on
// application/disclosure/iska/draw docs. The suffix is `lo`.
// ================================================================
const docIdByKind = { term_sheet: 1, application_export: 2, bp_disclosure: 3 };
{ const t = orch.tabsFor('loan_officer', tsSpec, docIdByKind);
  ok('tabsFor LO: has TS tab only', !!t[1] && !t[2] && !t[3]);
  ok('tabsFor LO: uses /ts_lo_sig/ anchor', t[1] && t[1].sign && t[1].sign[0] === '/ts_lo_sig/');
  ok('tabsFor LO: uses /ts_lo_dt/ anchor', t[1] && t[1].date && t[1].date[0] === '/ts_lo_dt/');
  ok('tabsFor LO: no wire text tabs on TS', !t[1].text); }

// admin still signs term sheet only, and borrower/co sign every doc — the LO
// addition must not change that.
{ const b = orch.tabsFor('borrower', tsSpec, docIdByKind);
  ok('tabsFor borrower: signs all 3', !!b[1] && !!b[2] && !!b[3]);
  ok('tabsFor borrower: b1 suffix', b[1].sign[0] === '/ts_b1_sig/'); }
{ const a = orch.tabsFor('admin', tsSpec, docIdByKind);
  ok('tabsFor admin: TS only', !!a[1] && !a[2] && !a[3]);
  ok('tabsFor admin: admin suffix', a[1].sign[0] === '/ts_admin_sig/'); }

// ================================================================
// resolveRecipientIdentity: LO row re-resolves from the CURRENT file's officer
// (a reassignment between seed and send reaches the actual send).
// ================================================================
const resolve = orch.resolveRecipientIdentity;
{ const r = resolve({ role: 'loan_officer', borrower_id: null }, appNoCoLo);
  ok('resolve LO: email from officer', r.email === 'mendelb@yscapgroup.com');
  ok('resolve LO: name from officer', r.name === 'Mendel Bochner'); }

// LO row on a file that LOST its officer between seed and send → returns null
// identity so the send-time re-load path can DROP the row (never a stale email).
{ const r = resolve({ role: 'loan_officer', borrower_id: null }, appNoCoNoLo);
  ok('resolve LO w/o officer: null identity', r.email === null && r.name === null); }

// Borrower / co-borrower / admin unchanged.
{ const r = resolve({ role: 'borrower', borrower_id: 'B1' }, appNoCoLo);
  ok('resolve borrower unchanged', r.email === 'moshe@example.com'); }
{ const r = resolve({ role: 'admin', borrower_id: null }, appNoCoLo);
  ok('resolve admin unchanged', r.email === null && r.name === null); }

// ================================================================
// Packages carry the loanOfficerRequired flag correctly (regression guard so
// a refactor doesn't silently drop it from the term-sheet package).
// ================================================================
const P = orch.PACKAGES;
ok('term_sheet_package.loanOfficerRequired true', P.term_sheet_package.loanOfficerRequired === true);
ok('heter_iska.loanOfficerRequired NOT set', !P.heter_iska.loanOfficerRequired);
ok('draw_request.loanOfficerRequired NOT set', !P.draw_request.loanOfficerRequired);

// ================================================================
// Subject helpers: address + loan number appear together; a null property_address
// (subjectAddress on a bare app) never throws and yields empty; every package
// subject accepts the two-arg form.
// ================================================================
const sub1 = P.term_sheet_package.subject('YS1234', '12 Churchill Lane, Brooklyn, NY 11213');
ok('subject: loan# and address in TS', /Loan #YS1234/.test(sub1) && /12 Churchill Lane/.test(sub1));
const sub2 = P.term_sheet_package.subject('YS1234', '');
ok('subject: no address, just loan#', /Loan #YS1234/.test(sub2) && !/·/.test(sub2));
const sub3 = P.term_sheet_package.subject('', '12 Main St');
ok('subject: no loan#, just address', /12 Main St/.test(sub3) && !/Loan #/.test(sub3));
const sub4 = P.term_sheet_package.subject('', '');
ok('subject: neither → no suffix', !/—/.test(sub4) && !/·/.test(sub4));
const sub5 = P.heter_iska.subject('YS1234', '12 Main St');
ok('subject: iska takes two args', /Loan #YS1234/.test(sub5) && /12 Main St/.test(sub5));
const sub6 = P.draw_request.subject('YS1234', '12 Main St');
ok('subject: draw takes two args', /Loan #YS1234/.test(sub6) && /12 Main St/.test(sub6));

console.log(`\ntest-esign-loan-officer-signer: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
