'use strict';
/* DB-free unit tests for the re-pull comparison engine (E6). Pure, no DB. */
const { compareReports } = require('../src/lib/credit/compare');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log(`FAIL - ${n}`); } };
const eq = (n, g, e) => ok(`${n} (got ${JSON.stringify(g)}, want ${JSON.stringify(e)})`, JSON.stringify(g) === JSON.stringify(e));

const NOW = new Date('2026-07-20T00:00:00Z').getTime();
const hl = (r, tag) => r.headlines.filter((h) => h.tag === tag).map((h) => h.text);
const hasText = (r, sub) => r.headlines.some((h) => h.text.includes(sub));

// ---- 1. no previous report -------------------------------------------------
{
  const r = compareReports({ report: { representative_score: 700 } }, null);
  eq('no prev → hasPrevious false', r.hasPrevious, false);
  ok('no prev → current meta echoed', r.current && r.current.representativeScore === 700);
  const r0 = compareReports(null, null);
  eq('null cur → hasPrevious false', r0.hasPrevious, false);
}

// ---- 2. representative score up across a bracket ---------------------------
{
  const cur = { report: { representative_score: 742, representative_bracket: '740-759' }, scores: [], tradelines: [], collections: [], inquiries: [], publicRecords: [] };
  const prev = { report: { representative_score: 700, representative_bracket: '700-719' }, scores: [], tradelines: [], collections: [], inquiries: [], publicRecords: [] };
  const r = compareReports(cur, prev, { nowMs: NOW });
  eq('hasPrevious true', r.hasPrevious, true);
  eq('changed true', r.changed, true);
  eq('score delta', r.representativeScore.delta, 42);
  eq('bracket changed flag', r.representativeScore.bracketChanged, true);
  ok('score-up is a GOOD headline', hl(r, 'good').some((t) => /went up 42 points/.test(t)));
  ok('bracket change is called out', hasText(r, 'pricing bracket changed (700-719 → 740-759)'));
  // score-up + bracket is the heaviest headline → sorted first
  eq('heaviest headline first', r.headlines[0].tag, 'good');
}

// ---- 3. score down, no bracket change → BAD, no bracket text ---------------
{
  const cur = { report: { representative_score: 705, representative_bracket: '700-719' }, scores: [], tradelines: [], collections: [], inquiries: [], publicRecords: [] };
  const prev = { report: { representative_score: 718, representative_bracket: '700-719' }, scores: [], tradelines: [], collections: [], inquiries: [], publicRecords: [] };
  const r = compareReports(cur, prev, { nowMs: NOW });
  eq('score delta negative', r.representativeScore.delta, -13);
  eq('same bracket → not changed', r.representativeScore.bracketChanged, false);
  ok('score-down is a BAD headline', hl(r, 'bad').some((t) => /went down 13 points/.test(t)));
  ok('no bracket-change text when same bracket', !hasText(r, 'pricing bracket changed'));
}

// ---- 4. per-borrower / per-bureau score deltas -----------------------------
{
  const cur = {
    report: { representative_score: 720 },
    scores: [{ report_borrower_id: 1, borrower_id: 'b1', bureau: 'Equifax', model: 'FICO', value: 720 },
             { report_borrower_id: 1, borrower_id: 'b1', bureau: 'Experian', model: 'FICO', value: 710 }],
    tradelines: [], collections: [], inquiries: [], publicRecords: [],
  };
  const prev = {
    report: { representative_score: 700 },
    scores: [{ report_borrower_id: 1, borrower_id: 'b1', bureau: 'Equifax', model: 'FICO', value: 700 },
             { report_borrower_id: 1, borrower_id: 'b1', bureau: 'Experian', model: 'FICO', value: 710 }],
    tradelines: [], collections: [], inquiries: [], publicRecords: [],
  };
  const r = compareReports(cur, prev, { nowMs: NOW });
  eq('only the CHANGED bureau appears', r.scoreDeltas.length, 1);
  eq('bureau delta value', r.scoreDeltas[0].delta, 20);
  eq('bureau delta bureau', r.scoreDeltas[0].bureau, 'Equifax');
}

// ---- 5. findings: a fraud alert CLEARS, an OFAC alert APPEARS ---------------
{
  const cur = {
    report: { representative_score: 700, underwriting_finding: { findings: [
      { type: 'ofac', code: 'ofac', severity: 'fatal', reportBorrowerId: 1, reconciled: false, message: 'OFAC hit' },
    ] } },
    scores: [], tradelines: [], collections: [], inquiries: [], publicRecords: [],
  };
  const prev = {
    report: { representative_score: 700, underwriting_finding: { findings: [
      { type: 'fraud_alert', code: 'fraud_alert', severity: 'fatal', reportBorrowerId: 1, reconciled: false, message: 'Fraud alert' },
    ] } },
    scores: [], tradelines: [], collections: [], inquiries: [], publicRecords: [],
  };
  const r = compareReports(cur, prev, { nowMs: NOW });
  eq('one finding cleared', r.findings.cleared.length, 1);
  eq('cleared is the fraud alert', r.findings.cleared[0].type, 'fraud_alert');
  eq('one finding new', r.findings.new.length, 1);
  eq('new is the OFAC alert', r.findings.new[0].type, 'ofac');
  ok('cleared → GOOD headline', hasText(r, 'Fraud alert cleared since the last pull'));
  ok('new → BAD headline', hasText(r, 'New ofac alert on this pull'));
}

// ---- 5b. a RECONCILED finding on either side is treated as absent ----------
{
  const cur = { report: { underwriting_finding: { findings: [
    { type: 'fraud_alert', code: 'fraud_alert', severity: 'fatal', reportBorrowerId: 1, reconciled: true, message: 'x' },
  ] } }, scores: [], tradelines: [], collections: [], inquiries: [], publicRecords: [] };
  const prev = { report: { underwriting_finding: { findings: [
    { type: 'fraud_alert', code: 'fraud_alert', severity: 'fatal', reportBorrowerId: 1, reconciled: false, message: 'x' },
  ] } }, scores: [], tradelines: [], collections: [], inquiries: [], publicRecords: [] };
  const r = compareReports(cur, prev, { nowMs: NOW });
  // reconciled on cur → active set empty on cur, still active on prev → CLEARED
  eq('reconciled-now counts as cleared', r.findings.cleared.length, 1);
  eq('no new finding', r.findings.new.length, 0);
}

// ---- 6. collections new vs cleared -----------------------------------------
{
  const cur = { report: {}, scores: [], tradelines: [], inquiries: [], publicRecords: [],
    collections: [{ bureau: 'Equifax', collection_agency_name: 'ABC Collections', original_creditor_name: 'Verizon', amount: '1200' }] };
  const prev = { report: {}, scores: [], tradelines: [], inquiries: [], publicRecords: [],
    collections: [{ bureau: 'Equifax', collection_agency_name: 'Old Collector', original_creditor_name: 'Comcast', amount: '500' }] };
  const r = compareReports(cur, prev, { nowMs: NOW });
  eq('one new collection', r.collections.added.length, 1);
  eq('one cleared collection', r.collections.removed.length, 1);
  ok('new collection headline shows amount', hasText(r, '1 new collection ($1,200)'));
  ok('cleared collection headline', hasText(r, '1 collection cleared'));
}

// ---- 6b. a collection unchanged across pulls is neither new nor cleared -----
{
  const c = { bureau: 'Equifax', collection_agency_name: 'ABC, N.A.', original_creditor_name: 'Verizon', amount: '1200' };
  const cSame = { bureau: 'Equifax', collection_agency_name: 'ABC NA', original_creditor_name: 'VERIZON', amount: '1200.00' }; // normalizes equal
  const r = compareReports(
    { report: {}, scores: [], tradelines: [], inquiries: [], publicRecords: [], collections: [cSame] },
    { report: {}, scores: [], tradelines: [], inquiries: [], publicRecords: [], collections: [c] },
    { nowMs: NOW });
  eq('normalized-equal collection is unchanged (none added)', r.collections.added.length, 0);
  eq('normalized-equal collection is unchanged (none removed)', r.collections.removed.length, 0);
}

// ---- 7. public records: new bankruptcy ------------------------------------
{
  const cur = { report: {}, scores: [], tradelines: [], collections: [], inquiries: [],
    publicRecords: [{ bureau: 'TransUnion', record_type: 'Bankruptcy', filed_date: '2026-01-15', amount: '0' }] };
  const prev = { report: {}, scores: [], tradelines: [], collections: [], inquiries: [], publicRecords: [] };
  const r = compareReports(cur, prev, { nowMs: NOW });
  eq('one new public record', r.publicRecords.added.length, 1);
  ok('new public record is BAD + heaviest', r.headlines[0].tag === 'bad' && /new public record/.test(r.headlines[0].text));
}

// ---- 8. inquiries: only NEW ones since last pull ---------------------------
{
  const shared = { bureau: 'Equifax', inquiring_party_name: 'Chase', inquiry_date: '2026-05-01' };
  const cur = { report: {}, scores: [], tradelines: [], collections: [], publicRecords: [],
    inquiries: [shared, { bureau: 'Equifax', inquiring_party_name: 'Rocket', inquiry_date: '2026-07-01' }] };
  const prev = { report: {}, scores: [], tradelines: [], collections: [], publicRecords: [],
    inquiries: [shared] };
  const r = compareReports(cur, prev, { nowMs: NOW });
  eq('only the brand-new inquiry is added', r.inquiries.added.length, 1);
  eq('added inquiry party', r.inquiries.added[0].party, 'Rocket');
  ok('new inquiry headline is neutral', hasText(r, '1 new inquiry since the last pull'));
}

// ---- 9. tradelines: new account, newly derogatory, newly late, now paid ----
{
  const base = (over) => ({ bureau: 'Equifax', creditor_name: 'Chase Card', account_type: 'Revolving', account_identifier_masked: '••1234', ...over });
  const inst = (over) => ({ bureau: 'Equifax', creditor_name: 'Auto Loan', account_type: 'Installment', account_identifier_masked: '••9999', ...over });
  const cur = { report: {}, scores: [], collections: [], inquiries: [], publicRecords: [], tradelines: [
    base({ derogatory_indicator: true, late_30_count: 2 }),   // was clean → newly derogatory + newly late
    inst({ account_status_type: 'Paid' }),                    // was open → now paid
    { bureau: 'Equifax', creditor_name: 'New Store Card', account_type: 'Revolving', account_identifier_masked: '••5555' }, // brand new
  ] };
  const prev = { report: {}, scores: [], collections: [], inquiries: [], publicRecords: [], tradelines: [
    base({ derogatory_indicator: false, late_30_count: 0 }),
    inst({ account_status_type: 'Open' }),
  ] };
  const r = compareReports(cur, prev, { nowMs: NOW });
  eq('one new account', r.tradelines.added.length, 1);
  eq('one newly derogatory', r.tradelines.newlyDerogatory, 1);
  eq('one newly late', r.tradelines.newlyLate, 1);
  eq('one now paid', r.tradelines.nowPaid, 1);
  ok('newly derogatory → BAD headline', hasText(r, '1 account newly reported derogatory'));
  ok('now paid → GOOD headline', hasText(r, '1 account now paid/closed'));
}

// ---- 10. risk deltas + utilization headline --------------------------------
{
  const cur = { report: {}, scores: [], collections: [], inquiries: [], publicRecords: [], tradelines: [
    { account_type: 'Revolving', account_status_type: 'Open', unpaid_balance: '2000', credit_limit: '10000', is_authorized_user: false },
  ] };
  const prev = { report: {}, scores: [], collections: [], inquiries: [], publicRecords: [], tradelines: [
    { account_type: 'Revolving', account_status_type: 'Open', unpaid_balance: '6000', credit_limit: '10000', is_authorized_user: false },
  ] };
  const r = compareReports(cur, prev, { nowMs: NOW });
  eq('util now 20%', r.risk.current.revolvingUtilizationPct, 20);
  eq('util was 60%', r.risk.previous.revolvingUtilizationPct, 60);
  eq('util delta', r.risk.deltas.revolvingUtilizationPct.delta, -40);
  ok('utilization drop → GOOD headline', hasText(r, 'Revolving utilization dropped from 60% to 20%'));
}

// ---- 11. two identical reports → nothing changed ---------------------------
{
  const one = () => ({ report: { representative_score: 700, representative_bracket: '700-719', underwriting_finding: null },
    scores: [{ report_borrower_id: 1, bureau: 'Equifax', model: 'FICO', value: 700 }],
    tradelines: [{ bureau: 'Equifax', creditor_name: 'Chase', account_type: 'Revolving', account_identifier_masked: '••1', unpaid_balance: '100', credit_limit: '1000', is_authorized_user: false }],
    collections: [], inquiries: [], publicRecords: [] });
  const r = compareReports(one(), one(), { nowMs: NOW });
  eq('identical reports → not changed', r.changed, false);
  eq('identical reports → no headlines', r.headlines.length, 0);
}

console.log(`\ncredit-compare: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
