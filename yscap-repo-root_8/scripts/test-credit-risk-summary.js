'use strict';
/* DB-free unit tests for the credit risk summary (E5-safe). Pure, no DB. */
const { summarizeRisk } = require('../src/lib/credit/risk-summary');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log(`FAIL - ${n}`); } };
const eq = (n, g, e) => ok(`${n} (got ${JSON.stringify(g)})`, JSON.stringify(g) === JSON.stringify(e));

// A fixed clock so "recent inquiry" / account-age math is deterministic.
const NOW = new Date('2026-07-19T00:00:00Z').getTime();
const hasFlag = (s, k) => s.flags.some((f) => f.key === k);

// ---- a mixed file ----
const blocks = {
  tradelines: [
    // revolving: $4,500 of $5,000 → 90% util, 1x30
    { account_type: 'Revolving', account_status_type: 'Open', unpaid_balance: '4500', credit_limit: '5000', late_30_count: 1, is_authorized_user: false, date_opened: '2018-01-01' },
    // installment open, no lates
    { account_type: 'Installment', account_status_type: 'Open', unpaid_balance: '12000', late_30_count: 0, is_authorized_user: false, date_opened: '2020-06-01' },
    // a collection tradeline (derogatory)
    { account_type: 'Collection', account_status_type: 'Open', unpaid_balance: '800', is_collection: true, is_authorized_user: false, date_opened: '2024-02-01' },
    // authorized-user card — excluded from the borrower's own debt
    { account_type: 'Revolving', account_status_type: 'Open', unpaid_balance: '9000', credit_limit: '10000', is_authorized_user: true, date_opened: '2015-01-01' },
    // closed/paid account — not counted as open
    { account_type: 'Installment', account_status_type: 'Paid', unpaid_balance: '0', is_authorized_user: false, date_opened: '2016-01-01' },
  ],
  collections: [{ amount: '800' }],
  publicRecords: [{ record_type: 'Bankruptcy' }],
  inquiries: [
    { inquiry_date: '2026-06-01' },   // ~1.5 mo ago
    { inquiry_date: '2026-05-01' },   // ~2.5 mo
    { inquiry_date: '2026-03-01' },   // ~4.5 mo
    { inquiry_date: '2025-01-01' },   // ~18 mo (outside 12)
  ],
};
const s = summarizeRisk(blocks, { nowMs: NOW });
eq('own tradelines exclude authorized-user', s.tradelineCount, 4);
eq('authorized-user counted separately', s.authorizedUserCount, 1);
eq('open tradelines exclude the paid one', s.openTradelineCount, 3);
eq('total balance excludes AU ($9000) AND the collection ($800, shown separately)', s.totalBalance, 16500);   // 4500+12000+0
eq('revolving utilization = 90% (own revolving only)', s.revolvingUtilizationPct, 90);
eq('derogatory count (collection)', s.derogatoryCount, 1);
eq('collections count', s.collectionsCount, 1);
eq('collections total', s.collectionsTotal, 800);
eq('public records', s.publicRecordCount, 1);
eq('30-day lates summed', s.late30Count, 1);
eq('recent inquiries (6mo)', s.recentInquiries6mo, 3);
eq('recent inquiries (12mo)', s.recentInquiries12mo, 3);
ok('oldest account age computed', s.oldestAccountMonths != null && s.oldestAccountMonths > 90);
ok('flag: high utilization', hasFlag(s, 'high_utilization'));
ok('flag: collections', hasFlag(s, 'collections'));
ok('flag: public records', hasFlag(s, 'public_records'));
ok('flag: 30-day late', hasFlag(s, 'late30'));
ok('no thin-file flag (4 own accounts)', !hasFlag(s, 'thin_file'));

// ---- a thin, clean file ----
const thin = summarizeRisk({
  tradelines: [{ account_type: 'Revolving', account_status_type: 'Open', unpaid_balance: '100', credit_limit: '2000', is_authorized_user: false, date_opened: '2024-01-01' }],
  collections: [], publicRecords: [], inquiries: [],
}, { nowMs: NOW });
ok('thin file flagged', hasFlag(thin, 'thin_file'));
eq('low utilization → no util flag', thin.revolvingUtilizationPct, 5);
ok('no high-util flag at 5%', !hasFlag(thin, 'high_utilization') && !hasFlag(thin, 'elevated_utilization'));

// ---- empty file → all zeros, no crash ----
const empty = summarizeRisk({}, { nowMs: NOW });
eq('empty: zero tradelines', empty.tradelineCount, 0);
eq('empty: null utilization', empty.revolvingUtilizationPct, null);
eq('empty: no flags', empty.flags.length, 0);
eq('empty: null oldest', empty.oldestAccountMonths, null);

// ---- elevated (35%) vs high (50%) utilization boundary ----
const util35 = summarizeRisk({ tradelines: [{ account_type: 'Revolving', account_status_type: 'Open', unpaid_balance: '3500', credit_limit: '10000', is_authorized_user: false }] }, { nowMs: NOW });
ok('35% → elevated, not high', hasFlag(util35, 'elevated_utilization') && !hasFlag(util35, 'high_utilization'));
// exact-boundary edges: 30% → elevated (>=30), 50% → high (>=50)
const util30 = summarizeRisk({ tradelines: [{ account_type: 'Revolving', account_status_type: 'Open', unpaid_balance: '3000', credit_limit: '10000', is_authorized_user: false }] }, { nowMs: NOW });
ok('exactly 30% → elevated', hasFlag(util30, 'elevated_utilization') && !hasFlag(util30, 'high_utilization'));
const util50 = summarizeRisk({ tradelines: [{ account_type: 'Revolving', account_status_type: 'Open', unpaid_balance: '5000', credit_limit: '10000', is_authorized_user: false }] }, { nowMs: NOW });
ok('exactly 50% → high', hasFlag(util50, 'high_utilization'));

// ---- M1: a revolving line with a balance but NO reported limit ----
// no limit anywhere → skipped entirely → null utilization (not inflated).
const noLimit = summarizeRisk({ tradelines: [{ account_type: 'Revolving', account_status_type: 'Open', unpaid_balance: '5000', is_authorized_user: false }] }, { nowMs: NOW });
eq('limitless revolving line → null utilization (not inflated)', noLimit.revolvingUtilizationPct, null);
// a mix: $2000/$10000 (20%) + a $5000 limitless line → still 20%, not 70%.
const mixLimit = summarizeRisk({ tradelines: [
  { account_type: 'Revolving', account_status_type: 'Open', unpaid_balance: '2000', credit_limit: '10000', is_authorized_user: false },
  { account_type: 'Revolving', account_status_type: 'Open', unpaid_balance: '5000', is_authorized_user: false },
] }, { nowMs: NOW });
eq('limitless line does not pollute utilization (stays 20%)', mixLimit.revolvingUtilizationPct, 20);
// high_credit is the fallback limit when credit_limit is missing.
const hcFallback = summarizeRisk({ tradelines: [{ account_type: 'Revolving', account_status_type: 'Open', unpaid_balance: '4000', high_credit: '5000', is_authorized_user: false }] }, { nowMs: NOW });
eq('high_credit used as the limit fallback → 80%', hcFallback.revolvingUtilizationPct, 80);

// ---- inquiry windows: future-dated excluded; 6-vs-12 distinct; null date safe ----
const inqWin = summarizeRisk({ inquiries: [
  { inquiry_date: '2026-06-01' },   // ~1.5 mo
  { inquiry_date: '2025-10-01' },   // ~9.5 mo → in 12, not 6
  { inquiry_date: '2027-01-01' },   // FUTURE → excluded
  { inquiry_date: null },           // null → excluded, no NaN
  { inquiry_date: 'garbage' },      // malformed → excluded
] }, { nowMs: NOW });
eq('6-month window counts only recent', inqWin.recentInquiries6mo, 1);
eq('12-month window is distinct from 6', inqWin.recentInquiries12mo, 2);

// ---- derogatory_indicator===true (not just is_collection) counts ----
const derogInd = summarizeRisk({ tradelines: [{ account_type: 'Installment', account_status_type: 'Open', unpaid_balance: '100', derogatory_indicator: true, is_authorized_user: false }] }, { nowMs: NOW });
eq('derogatory_indicator true counts as derogatory', derogInd.derogatoryCount, 1);

// ---- thin-file boundary: 2 flags, 3 does not ----
const mk = (n) => Array.from({ length: n }, () => ({ account_type: 'Installment', account_status_type: 'Open', unpaid_balance: '100', is_authorized_user: false }));
ok('2 own accounts → thin file', hasFlag(summarizeRisk({ tradelines: mk(2) }, { nowMs: NOW }), 'thin_file'));
ok('3 own accounts → not thin', !hasFlag(summarizeRisk({ tradelines: mk(3) }, { nowMs: NOW }), 'thin_file'));

// ---- late-flag precedence (90 wins) + many-inquiries flag ----
const late = summarizeRisk({ tradelines: [{ account_type: 'Installment', account_status_type: 'Open', unpaid_balance: '100', late_30_count: 2, late_60_count: 1, late_90_count: 1, is_authorized_user: false }] }, { nowMs: NOW });
ok('90-day late flag wins precedence', hasFlag(late, 'late90') && !hasFlag(late, 'late60') && !hasFlag(late, 'late30'));
const manyInq = summarizeRisk({ inquiries: [{ inquiry_date: '2026-06-01' }, { inquiry_date: '2026-06-02' }, { inquiry_date: '2026-06-03' }, { inquiry_date: '2026-06-04' }] }, { nowMs: NOW });
ok('4 inquiries in 6mo → many-inquiries flag', hasFlag(manyInq, 'many_inquiries'));

// ---- AU account excluded from the oldest-account age ----
const auAge = summarizeRisk({ tradelines: [
  { account_type: 'Revolving', account_status_type: 'Open', unpaid_balance: '0', is_authorized_user: true, date_opened: '2010-01-01' },  // very old AU
  { account_type: 'Installment', account_status_type: 'Open', unpaid_balance: '100', is_authorized_user: false, date_opened: '2024-01-01' },
] }, { nowMs: NOW });
ok('oldest-account age ignores the AU account', auAge.oldestAccountMonths != null && auAge.oldestAccountMonths < 40);

// ---- summarizeRisk(null) must not throw (N3) ----
ok('null blocks → no throw', (() => { try { const z = summarizeRisk(null, { nowMs: NOW }); return z.tradelineCount === 0; } catch (_) { return false; } })());

console.log(`\ncredit-risk-summary: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
