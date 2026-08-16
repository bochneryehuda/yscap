'use strict';
/**
 * The AppraisalScope order's DETAIL — who is doing it, when they are going out,
 * and what it costs.
 *
 * `GetAppraisalStatus`, which the poll has always run, answers ONE question: what
 * stage is the order at (a code and a name). Everything a person actually asks
 * while an appraisal is pending — who the appraiser is, when the inspection is
 * booked, when the vendor says it will be back, what it costs — is answered only
 * by `GetAppraisalDetail`, and NOTHING has ever called it: `cdg.buildGetDetail`
 * has been exported since this integration shipped with zero callers. So the
 * order card said "no appraiser yet" and "no fee" on an order whose vendor record
 * named both.
 *
 * A SENTINEL NEVER WIPES A VALUE WE ALREADY HAVE. The vendor writes an unset
 * field as the STRING "N/A", "null" or "" (see `cdg.parseDetail`, which turns all
 * of those into a real null), and the detail response is not always complete —
 * a field can simply be absent from one poll and present in the next. So every
 * column is written with COALESCE-keep: a value the vendor states REPLACES ours
 * (their record is the authority on their own order), and a value they do not
 * state leaves ours alone. The one thing that would be lost by this is a vendor
 * genuinely RETRACTING an assignment, which is far rarer than a partial response
 * and would show up in the status timeline anyway. Money is not a sentinel:
 * `"0.00"` is a real figure, so a paid amount of zero is written as zero.
 *
 * The datetimes are stored as TEXT exactly as the vendor stated them — the reason
 * is in db/567's header and in `cdg.parseDetail`: their payload carries no
 * timezone, so turning one into an instant would print a guess as a fact.
 *
 * Network is injectable (deps.transport / deps.authContext) so the whole apply
 * path is exercised against a real Postgres with no vendor call.
 */
const cdg = require('./cdg');
const client = require('./client');
const session = require('./session');

// The columns `applyDetail` writes, paired with where each one comes from in the
// parsed detail. ONE table so the UPDATE, its binds and the tests cannot drift.
const FIELDS = [
  ['appraiser_name', (d) => d.appraiser.name],
  ['appraiser_company', (d) => d.appraiser.company],
  ['appraiser_email', (d) => d.appraiser.email],
  ['appraiser_phone', (d) => d.appraiser.phone],
  ['appraiser_city', (d) => d.appraiser.city],
  ['appraiser_state', (d) => d.appraiser.state],
  ['appraiser_license', (d) => d.appraiser.license],
  ['amc_company', (d) => d.amc.company],
  ['amc_license', (d) => d.amc.license],
  ['amc_file_number', (d) => d.amc.fileNumber],
  ['vendor_due_date', (d) => d.dueDate],
  ['inspection_date', (d) => d.inspectionDate],
  ['vendor_completed_date', (d) => d.completedDate],
  ['assigned_at_text', (d) => d.assignedAt],
  ['accepted_at_text', (d) => d.acceptedAt],
  ['inspection_scheduled_at_text', (d) => d.inspectionScheduledAt],
  ['inspection_completed_at_text', (d) => d.inspectionCompletedAt],
  ['report_uploaded_at_text', (d) => d.reportUploadedAt],
  ['vendor_updated_at_text', (d) => d.lastUpdateAt],
  ['client_fee', (d) => d.clientFee],
  ['form_fee', (d) => d.formFee],
  ['job_fee', (d) => d.jobFee],
  ['management_fee', (d) => d.managementFee],
  ['due_amount', (d) => d.dueAmount],
  ['paid_amount', (d) => d.paidAmount],
  ['invoiced_amount', (d) => d.invoicedAmount],
];
// The date columns need an explicit cast: every bind arrives as text or null, and
// Postgres cannot infer a type for a parameter that only ever appears inside a
// COALESCE beside a date column.
const CASTS = {
  vendor_due_date: '::date', inspection_date: '::date', vendor_completed_date: '::date',
  client_fee: '::numeric', form_fee: '::numeric', job_fee: '::numeric',
  management_fee: '::numeric', due_amount: '::numeric', paid_amount: '::numeric',
  invoiced_amount: '::numeric',
};

/**
 * Apply a GetAppraisalDetail response onto the order row. NO NETWORK — this is
 * the seam the tests drive with a real vendor sample.
 * Returns { error } | { ok:true, detail } | { ok:true, detail:null } when the
 * response carried nothing readable.
 */
async function applyDetail(dbh, order, resp) {
  const err = cdg.parseError(resp);
  if (err) {
    // A stale api key surfaces as an auth NACK — drop it so the next call re-logs in.
    if (String(err.code) === '-100' || /authenticat/i.test(err.description || '')) session.invalidate();
    return { error: err };
  }
  const detail = cdg.parseDetail(resp);
  if (!detail) {
    // Readable response, nothing in it. Stamp that we looked so a silent vendor
    // is not mistaken for a poll that never ran.
    await dbh.query(`UPDATE amc_orders SET detail_polled_at=now(), updated_at=now() WHERE id=$1`, [order.id]);
    return { ok: true, detail: null };
  }
  const sets = [];
  const binds = [order.id];
  for (const [col, read] of FIELDS) {
    let v = null;
    try { v = read(detail); } catch (_) { v = null; }
    binds.push(v == null ? null : String(v));
    const p = `$${binds.length}${CASTS[col] || ''}`;
    sets.push(`${col} = COALESCE(${p}, ${col})`);
  }
  binds.push(JSON.stringify(resp));
  sets.push(`last_detail_response = $${binds.length}::jsonb`);
  await dbh.query(
    `UPDATE amc_orders SET ${sets.join(', ')}, detail_polled_at = now(), updated_at = now() WHERE id = $1`,
    binds);
  return { ok: true, detail };
}

/**
 * Fetch one order's detail live and apply it. Best-effort by contract — the
 * caller (the poll) treats a failure as "we learned nothing this tick", never as
 * a reason to stop syncing the order.
 */
async function syncDetail(dbh, order, deps = {}) {
  if (!order || !order.sp_order_number) return { ok: false, error: 'no_order_number' };
  const transport = deps.transport || client;
  const ctx = deps.authContext || (await session.authContext());
  const resp = await transport.read(cdg.buildGetDetail({
    apiKey: ctx.apiKey, subdomain: order.sp_subdomain || ctx.subdomain,
    spOrderNumber: order.sp_order_number, clientOrderNumber: order.client_order_number,
  }), { label: 'GetAppraisalDetail' });
  return applyDetail(dbh, order, resp);
}

module.exports = { applyDetail, syncDetail, _internals: { FIELDS, CASTS } };
