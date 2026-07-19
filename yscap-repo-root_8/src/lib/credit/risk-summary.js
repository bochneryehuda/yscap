'use strict';

/**
 * Credit RISK SUMMARY — digest the stored report "blocks" into an underwriting-
 * ready snapshot (the owner's "import high-risk details into the file"). PURE:
 * block rows in, a summary object out. No DB, no I/O.
 *
 * It reads the credit_tradelines / credit_collections / credit_inquiries /
 * credit_public_records column shapes (snake_case) exactly as the detail endpoint
 * returns them, so the endpoint can compute the summary from the same rows.
 *
 * This is ADVISORY (a heads-up for the underwriter) — it never gates sign-off.
 * The blocking signals are the alert findings (E2); this just summarizes the
 * numbers a human would otherwise tally by hand.
 */

const num = (v) => { if (v == null || v === '') return null; const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; };
const numOr0 = (v) => num(v) || 0;
const isClosed = (t) => /paid|closed/i.test(String(t.account_status_type || ''));
const isRevolving = (t) => /revolving/i.test(String(t.account_type || ''));
// Months between a 'YYYY-MM-DD' date and now (UTC arithmetic — never a displayed
// date, so no timezone-shift concern; returns null on a bad/empty date).
function monthsAgo(dateStr, nowMs) {
  if (!dateStr) return null;
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`).getTime();
  if (!Number.isFinite(d)) return null;
  return (nowMs - d) / (1000 * 60 * 60 * 24 * 30.44);
}
const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

function summarizeRisk(blocks = {}, opts = {}) {
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  const tradelines = Array.isArray(blocks.tradelines) ? blocks.tradelines : [];
  const collections = Array.isArray(blocks.collections) ? blocks.collections : [];
  const inquiries = Array.isArray(blocks.inquiries) ? blocks.inquiries : [];
  const publicRecords = Array.isArray(blocks.publicRecords) ? blocks.publicRecords : [];

  // The borrower's OWN debt excludes authorized-user tradelines (not their debt).
  const own = tradelines.filter((t) => !t.is_authorized_user);

  let totalBalance = 0, revBalance = 0, revLimit = 0, late30 = 0, late60 = 0, late90 = 0, derog = 0, openCount = 0;
  for (const t of own) {
    const bal = numOr0(t.unpaid_balance);
    totalBalance += bal;
    if (!isClosed(t)) openCount++;
    if (isRevolving(t)) { revBalance += bal; revLimit += numOr0(t.credit_limit); }
    late30 += numOr0(t.late_30_count);
    late60 += numOr0(t.late_60_count);
    late90 += numOr0(t.late_90_count);
    if (t.derogatory_indicator === true || t.is_collection === true) derog++;
  }
  const revolvingUtilizationPct = revLimit > 0 ? Math.round((revBalance / revLimit) * 100) : null;
  const collectionsTotal = collections.reduce((s, c) => s + numOr0(c.amount), 0);
  const inq6 = inquiries.filter((q) => { const m = monthsAgo(q.inquiry_date, nowMs); return m != null && m >= 0 && m <= 6; }).length;
  const inq12 = inquiries.filter((q) => { const m = monthsAgo(q.inquiry_date, nowMs); return m != null && m >= 0 && m <= 12; }).length;
  const ages = own.map((t) => monthsAgo(t.date_opened, nowMs)).filter((m) => m != null && m >= 0);
  const oldestAccountMonths = ages.length ? Math.round(Math.max(...ages)) : null;

  // Advisory risk FLAGS (severity high|medium|low — never a hard gate here).
  const flags = [];
  if (revolvingUtilizationPct != null && revolvingUtilizationPct >= 50) flags.push({ key: 'high_utilization', severity: 'high', label: `High revolving utilization (${revolvingUtilizationPct}%)` });
  else if (revolvingUtilizationPct != null && revolvingUtilizationPct >= 30) flags.push({ key: 'elevated_utilization', severity: 'medium', label: `Elevated revolving utilization (${revolvingUtilizationPct}%)` });
  if (collections.length) flags.push({ key: 'collections', severity: 'high', label: `${collections.length} collection${collections.length > 1 ? 's' : ''} (${money(collectionsTotal)})` });
  if (publicRecords.length) flags.push({ key: 'public_records', severity: 'high', label: `${publicRecords.length} public record${publicRecords.length > 1 ? 's' : ''}` });
  if (late90 > 0) flags.push({ key: 'late90', severity: 'high', label: `${late90} account(s) 90+ days late` });
  else if (late60 > 0) flags.push({ key: 'late60', severity: 'medium', label: `${late60} account(s) 60 days late` });
  else if (late30 > 0) flags.push({ key: 'late30', severity: 'low', label: `${late30} account(s) 30 days late` });
  if (own.length > 0 && own.length < 3) flags.push({ key: 'thin_file', severity: 'medium', label: `Thin file — only ${own.length} of the borrower's own account${own.length === 1 ? '' : 's'}` });
  if (inq6 >= 4) flags.push({ key: 'many_inquiries', severity: 'medium', label: `${inq6} inquiries in the last 6 months` });

  return {
    tradelineCount: own.length,
    openTradelineCount: openCount,
    authorizedUserCount: tradelines.length - own.length,
    totalBalance: Math.round(totalBalance),
    revolvingBalance: Math.round(revBalance),
    revolvingLimit: Math.round(revLimit),
    revolvingUtilizationPct,
    derogatoryCount: derog,
    collectionsCount: collections.length,
    collectionsTotal: Math.round(collectionsTotal),
    publicRecordCount: publicRecords.length,
    late30Count: late30, late60Count: late60, late90Count: late90,
    recentInquiries6mo: inq6, recentInquiries12mo: inq12,
    oldestAccountMonths,
    flags,
  };
}

module.exports = { summarizeRisk };
