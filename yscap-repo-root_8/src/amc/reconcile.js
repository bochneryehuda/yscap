'use strict';
/**
 * WHAT DOES THE APPRAISAL COMPANY THINK WE HAVE ORDERED?
 *
 * (Audit finding, 2026-08-16: AppraisalScope has always offered an order search
 * — `GetAppraisals` — and nothing ever called it, so PILOT could only ever know
 * about the orders PILOT itself placed.)
 *
 * THE HOLE THIS FILLS. An appraisal ordered on AppraisalScope's OWN website — by
 * a processor working around an outage, by somebody who has always done it that
 * way, by the AMC re-issuing an order under a new number — exists at the vendor
 * and does not exist here. Nothing polls it, its report never files itself onto
 * the condition, it never reaches the Orders desk, and the file reads as though no
 * appraisal was ever ordered. The team finds out when somebody asks where the
 * report is.
 *
 * IT ONLY EVER REPORTS. This module reads their list, compares it with ours, and
 * says what is on their side and not on ours. It does NOT create an `amc_orders`
 * row for what it finds, and it must not be made to: adopting a vendor order means
 * deciding that THIS order is THIS file's appraisal — a judgement with a wrong
 * answer (the wrong property's report filing itself onto a loan) that no matcher
 * should make on its own. It hands a human the evidence and the one-click place to
 * act.
 *
 * It is also a pure READ at the vendor (`client.lookup`, the catalog endpoint,
 * master-switch-gated, never the outbound write gate), so it is safe to run on an
 * account whose ordering is still switched off.
 */

const cdg = require('./cdg');
const client = require('./client');
const session = require('./session');

/** Their date fields are `MM/DD/YYYY` in the samples; ours are ISO. */
function usDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (!Number.isFinite(dt.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(dt.getUTCMonth() + 1)}/${p(dt.getUTCDate())}/${dt.getUTCFullYear()}`;
}

function txt(v) { const s = v == null ? '' : String(v).trim(); return s || null; }

/**
 * One row of their order list, in our words. PURE.
 *
 * Their column names are theirs (`appraisal_id`, `file_no`, `loan_no`, …) and are
 * read defensively: a list endpoint's spelling is exactly the thing that changes
 * between vendor releases, and a rename must degrade to "we could not read that
 * column", never to a confident wrong match.
 */
function normalizeVendorOrder(row) {
  if (!row || typeof row !== 'object') return null;
  const pick = (...keys) => { for (const k of keys) { const v = txt(row[k]); if (v) return v; } return null; };
  const spOrderNumber = pick('appraisal_id', 'appraisalId', 'appraisal_ID');
  if (!spOrderNumber) return null;   // without their id there is nothing to compare
  return {
    spOrderNumber,
    fileNumber: pick('file_no', 'fileNo', 'file_number'),
    loanNumber: pick('loan_no', 'loanNo', 'loan_number'),
    borrowerName: pick('borrower_name', 'borrowerName'),
    address: [pick('address'), pick('city')].filter(Boolean).join(', ') || null,
    status: pick('status'),
    orderedOn: pick('date_ordered', 'dateOrdered', 'order_date'),
    lastUpdate: pick('last_update_time', 'lastUpdateTime'),
    estimatedCompletion: pick('estimated_completion_date', 'estimatedCompletionDate'),
    orderedBy: pick('ordered_by', 'orderedBy'),
    raw: row,
  };
}

/**
 * Compare their list with ours. PURE, so the whole matching rule is testable.
 *
 * @param vendorRows  normalised vendor orders
 * @param ours        [{ sp_order_number, application_id }] — every order PILOT has
 * @param filesByLoan Map of normalised loan number → { id, loanNumber, address }
 * @returns { unknown:[], known:[], unmatchedToFile:[] }
 */
function diff(vendorRows, ours, filesByLoan) {
  const mine = new Set((ours || []).map((o) => String(o.sp_order_number || '').trim()).filter(Boolean));
  const byLoan = filesByLoan instanceof Map ? filesByLoan : new Map();
  const norm = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const unknown = [], known = [];
  for (const v of (vendorRows || []).filter(Boolean)) {
    if (mine.has(String(v.spOrderNumber).trim())) { known.push(v); continue; }
    // Which of OUR files does it look like? Only ever by the loan number they were
    // given — an address match would be a guess, and a wrong one attaches a
    // stranger's appraisal to a loan.
    const file = v.loanNumber ? (byLoan.get(norm(v.loanNumber)) || null) : null;
    unknown.push({ ...v, file });
  }
  return {
    unknown,
    known,
    unmatchedToFile: unknown.filter((u) => !u.file),
  };
}

/**
 * Ask the vendor what they hold, and say what is not on our side.
 *
 * @param db
 * @param opts { days = 90, loanNumber }
 * @returns { ok, unknown, known, checked, since, error }
 * Never throws — this is a report, and a vendor that will not answer is a line of
 * text, not an exception on somebody's screen.
 */
async function findUnknownOrders(db, opts = {}) {
  const days = Math.max(1, Math.min(730, parseInt(opts.days, 10) || 90));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  try {
    let cfgd;
    try { cfgd = client.configured(); } catch (_) { cfgd = null; }
    if (!cfgd || !cfgd.enabled) return { ok: false, error: 'not_enabled', message: 'The appraisal-company connection is switched off.' };
    if (!cfgd.ready) return { ok: false, error: 'not_configured', message: 'The appraisal-company login is not set up yet.' };

    const ctx = await session.authContext();
    const criteria = [
      { fieldName: 'create_date_start', fieldValue: usDate(since) },
      { fieldName: 'create_date_end', fieldValue: usDate(new Date()) },
    ].filter((c) => c.fieldValue);

    const resp = await client.lookup(cdg.buildGetAppraisals({
      apiKey: ctx.apiKey, subdomain: ctx.subdomain,
      loanNumber: opts.loanNumber || null, criteria,
    }), { label: 'GetAppraisals' });

    const err = cdg.parseError(resp);
    if (err) {
      if (String(err.code) === '-100' || /authenticat/i.test(err.description || '')) session.invalidate();
      return { ok: false, error: 'vendor', message: err.description || String(err.code), since };
    }

    const vendorRows = cdg.parseLookup(resp).map(normalizeVendorOrder).filter(Boolean);

    const ours = (await db.query(`SELECT sp_order_number, application_id FROM amc_orders WHERE sp_order_number IS NOT NULL`)).rows;
    // Only the loan numbers we could possibly match — an ordinary index read.
    const files = (await db.query(
      `SELECT id, ys_loan_number, property_address FROM applications
        WHERE ys_loan_number IS NOT NULL AND deleted_at IS NULL`)).rows;
    const byLoan = new Map();
    for (const f of files) {
      const key = String(f.ys_loan_number || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!key || byLoan.has(key)) continue;
      const pa = f.property_address && typeof f.property_address === 'object' ? f.property_address : {};
      byLoan.set(key, {
        id: f.id,
        loanNumber: f.ys_loan_number,
        address: [pa.street || pa.line1, pa.city, pa.state].filter(Boolean).join(', ') || null,
      });
    }

    const out = diff(vendorRows, ours, byLoan);
    return {
      ok: true,
      checked: vendorRows.length,
      since: since.toISOString(),
      days,
      unknown: out.unknown,
      knownCount: out.known.length,
      unmatchedToFileCount: out.unmatchedToFile.length,
    };
  } catch (e) {
    return { ok: false, error: 'error', message: (e && e.message) || String(e), since };
  }
}

module.exports = { findUnknownOrders, normalizeVendorOrder, diff, usDate };
