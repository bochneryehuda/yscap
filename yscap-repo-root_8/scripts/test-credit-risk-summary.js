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
eq('total balance is own debt only (excludes AU $9000)', s.totalBalance, 17300);   // 4500+12000+800+0
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

console.log(`\ncredit-risk-summary: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
