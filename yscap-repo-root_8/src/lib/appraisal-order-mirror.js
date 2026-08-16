'use strict';
/**
 * THE APPRAISAL, ON THE ORDERS DESK — one projection, one writer.
 *
 * (Owner-directed 2026-08-05: *"Ordering lives in the Orders desk. Add 'Order an
 * appraisal' as a NEW ORDER TYPE in the existing Orders section — file_orders,
 * alongside Title, Insurance, Attorney closing prep."* Re-confirmed 2026-08-16:
 * *"add appraisal to the Orders desk"*.)
 *
 * WHY THIS IS A PROJECTION AND NOT AN ORDER PATH
 * ----------------------------------------------
 * Title and insurance are ordered BY the desk: it composes an email to a contact
 * and sends it, so the `file_orders` row is the order. An appraisal is not like
 * that. It is placed through one of three vendor APIs — AppraisalScope / NAN
 * (through Cotality's Digital Gateway), Class Valuation, Richer Values — each with
 * its own credentials, its own message shape, its own lifecycle vocabulary and its
 * own hard-won placement path that the architecture notes say in as many words
 * must be called UNCHANGED.
 *
 * So there is exactly ONE place that talks to those vendors (the appraisal order
 * section), and this module PROJECTS whatever it placed onto the desk. The desk
 * row is the appraisal's clock, owner, notes, history and place in the cross-file
 * queue — precisely what the ATTORNEY row is for closing prep, which owns its own
 * package and chain the same way.
 *
 * NOTHING ELSE MAY WRITE THE 'appraisal' ROW. A second writer would be a second
 * answer to "is this file's appraisal ordered?", which is the failure the desk
 * exists to prevent — and it would be a second way to believe an appraisal had
 * been ordered when no vendor had ever been told.
 *
 * WHAT IT OWNS, AND WHAT IT KEEPS ITS HANDS OFF
 * ---------------------------------------------
 * DERIVED (this module owns, and overwrites on every pass): status, vendor_name,
 * ordered_at, ordered_by, completed_at, and the `meta.appraisal` block (vendor
 * key, their order number, the form, the fee, the live error).
 *
 * HUMAN (never touched): assigned_to / assigned_at / assigned_by, notes, due_on,
 * sla_days, first_response_at, followup_count, last_followup_at. A coordinator who
 * assigns the appraisal to somebody and writes a note must not have it wiped by
 * the next poll. This split is the whole reason the upsert names its columns one
 * by one instead of replacing the row.
 *
 * WHICH ORDER REPRESENTS THE FILE
 * -------------------------------
 * A file can carry several: a draft that was never placed, a cancelled first
 * attempt, a second vendor tried after the first declined. `pickPrimary` prefers
 * the one that is LIVE, then the one that got furthest, then the newest — so the
 * desk shows the order somebody is actually waiting on, and a stale cancelled row
 * can never mask a live one. It NEVER invents a row: a file with no vendor order
 * at all gets no desk row, so "not ordered" is the absence of a row rather than a
 * claim.
 *
 * Never throws. A projection that breaks a poll would be worse than a stale desk.
 */

/* The pool is required LAZILY (the `slot-label.js` arrangement) so the pure half of
   this module — the vendor→desk mapping, which is where the decisions live — loads
   and is testable with no database in reach. */
function db() { return require('../db'); }

/* -------------------------------------------------------------------------- */
/* The three vendors, in the desk's own vocabulary.                            */
/* -------------------------------------------------------------------------- */

/** Display names, exactly as the appraisal section names them. */
const VENDOR_NAME = Object.freeze({
  nan: 'AppraisalScope / NAN',
  class: 'Class Valuation',
  rv: 'Richer Values',
});

/**
 * Each vendor's lifecycle → the desk's five-word vocabulary.
 *
 * `documents_in` is the desk's "they answered and the work came back to us", which
 * on an appraisal is the moment the report is available — the same meaning it
 * carries for a title company that has sent its commitment back.
 *
 * A vendor status this does not recognise maps to `ordered` when the order is
 * plainly live and to null otherwise, so a new vendor state can never silently
 * mark an order complete.
 */
const NAN_STATUS = Object.freeze({
  draft: null, placing: 'ordered', ordered: 'ordered', in_process: 'ordered',
  assigned: 'ordered', inspected: 'ordered', in_review: 'ordered',
  product_available: 'documents_in', completed: 'completed',
  on_hold: 'ordered', cancel_requested: 'ordered', cancelled: 'cancelled',
  rejected: 'cancelled', error: 'ordered',
});
const CLASS_STATUS = Object.freeze({
  placing: 'ordered', ordered: 'ordered', in_process: 'ordered', assigned: 'ordered',
  inspected: 'ordered', on_hold: 'ordered', completed: 'completed',
  cancelled: 'cancelled', dryrun: null, error: 'ordered',
});
const RV_STATUS = Object.freeze({
  draft: null, dryrun: null, placing: 'ordered', ordered: 'ordered',
  in_process: 'ordered', inspected: 'ordered', in_review: 'ordered',
  on_hold: 'ordered', completed: 'completed', cancelled: 'cancelled',
  rejected: 'cancelled', dismissed: 'cancelled', error: 'ordered',
});

/** How far along an order is, for choosing between several on one file. */
const RANK = Object.freeze({ completed: 4, documents_in: 3, ordered: 2, cancelled: 1 });

function txt(v) { const s = v == null ? '' : String(v).trim(); return s || null; }
function ms(v) { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : 0; }
function cents(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null; }

/**
 * Map ONE vendor row onto the desk's shape. PURE — no database, so the whole
 * mapping is unit-testable and cannot be wrong in a way only production sees.
 * Returns null when the order does not represent a placed appraisal at all
 * (a draft, a dry run), which is what keeps a never-sent draft off the desk.
 */
function describe(vendor, row) {
  if (!row) return null;
  const raw = txt(row.status) || '';
  const table = vendor === 'nan' ? NAN_STATUS : vendor === 'class' ? CLASS_STATUS : RV_STATUS;
  let status = Object.prototype.hasOwnProperty.call(table, raw) ? table[raw] : undefined;
  if (status === undefined) {
    // An unrecognised state: live if the vendor has given us an id for it, and
    // never anything terminal. A new vendor status must not read as "done".
    const placed = vendor === 'nan' ? (row.sp_order_number || row.cdg_order_number)
      : vendor === 'class' ? row.class_order_id
        : (row.order_token || row.intake_token);
    status = placed ? 'ordered' : null;
  }
  if (!status) return null;

  const orderNumber = vendor === 'nan'
    ? (txt(row.appraisal_file_number) || txt(row.sp_order_number) || txt(row.cdg_order_number))
    : vendor === 'class' ? (txt(row.class_order_id) || txt(row.reference_number))
      : (txt(row.order_token) || txt(row.intake_token));

  const fee = vendor === 'nan'
    // NAN's fees are plain dollars on the order row; the other two are integer cents.
    // `client_fee` is the one figure that means "what this order costs US" — the
    // vendor's own total on their record of it — so it wins when they have stated
    // it. Adding the job and management fees is a FALLBACK for an order placed
    // before the detail lookup ran, and it is not the same number: on the vendor's
    // own sample a $450 client fee sits beside a $25 job fee and a $50 management
    // fee, so summing those two would have told a coordinator the appraisal costs
    // $75.
    ? (row.client_fee != null ? cents(Number(row.client_fee) * 100)
      : (row.job_fee != null || row.management_fee != null
        ? cents((Number(row.job_fee) || 0) * 100 + (Number(row.management_fee) || 0) * 100)
        : null))
    : vendor === 'class' ? cents(row.client_fee_cents)
      : cents(row.total_price_cents);

  const product = vendor === 'nan' ? (txt(row.form_description) || txt(row.product_code))
    : vendor === 'class' ? txt(row.product_title)
      : txt(row.report_type);

  // WHO IS DOING IT AND WHEN — read from AppraisalScope's own record of the order
  // by the detail poll (src/amc/detail.js). It is the APPRAISER, never the AMC:
  // both ride in the vendor's one `appraisers[]` array, and telling a coordinator
  // that the management company is inspecting the property would be worse than
  // telling them nothing. Absent until the first detail poll lands, and absent for
  // the other two vendors, whose own equivalents are not wired yet — an absent
  // block reads as "the vendor has not said", never as "nobody is assigned".
  const detail = vendor === 'nan' ? {
    appraiserName: txt(row.appraiser_name),
    appraiserCompany: txt(row.appraiser_company),
    appraiserPhone: txt(row.appraiser_phone),
    appraiserEmail: txt(row.appraiser_email),
    inspectionDate: row.inspection_date || null,
    // The vendor's OWN due date, which is the ETA somebody is really asking for.
    // `need_by_date` is the date WE asked for and can differ from it.
    vendorDueDate: row.vendor_due_date || null,
    requestedDueDate: row.need_by_date || null,
    dueAmountCents: row.due_amount != null ? cents(Number(row.due_amount) * 100) : null,
    paidAmountCents: row.paid_amount != null ? cents(Number(row.paid_amount) * 100) : null,
  } : null;
  const hasDetail = detail && Object.values(detail).some((v) => v != null);

  return {
    detail: hasDetail ? detail : null,
    vendor,
    vendorName: VENDOR_NAME[vendor],
    status,
    rank: RANK[status] || 0,
    orderNumber,
    product,
    feeCents: fee,
    orderedAt: row.ordered_at || row.placed_at || row.created_at || null,
    completedAt: row.completed_at || (status === 'completed' ? (row.updated_at || null) : null),
    orderedBy: row.ordered_by || row.placed_by || null,
    lastError: txt(row.last_error),
    // Their own words for where it is up to, so the desk can show the real state
    // under the mapped one rather than flattening every vendor into five words.
    vendorStatus: txt(row.status_name) || txt(row.vendor_status) || raw || null,
    nativeStatus: raw || null,
    rowId: row.id,
  };
}

/**
 * Choose the order that REPRESENTS the file, out of everything on it.
 * Live beats finished, further-along beats earlier, newer beats older. PURE.
 */
function pickPrimary(list) {
  const real = (Array.isArray(list) ? list : []).filter(Boolean);
  if (!real.length) return null;
  const liveness = (d) => (d.status === 'ordered' || d.status === 'documents_in' ? 2
    : d.status === 'completed' ? 1 : 0);
  return real.slice().sort((a, b) => (
    liveness(b) - liveness(a)
    || b.rank - a.rank
    || ms(b.orderedAt) - ms(a.orderedAt)
  ))[0];
}

/* -------------------------------------------------------------------------- */
/* Reading the three vendor tables.                                            */
/* -------------------------------------------------------------------------- */

async function readVendorOrders(dbh, appId) {
  const out = [];
  // Each read is its own try/catch: a vendor whose table cannot be read must not
  // hide the other two from the desk.
  try {
    const r = await dbh.query(
      `SELECT id, status, status_name, sp_order_number, cdg_order_number, appraisal_file_number,
              product_code, form_description, job_fee, management_fee, client_fee, last_error,
              appraiser_name, appraiser_company, appraiser_phone, appraiser_email,
              inspection_date, vendor_due_date, need_by_date, due_amount, paid_amount,
              ordered_at, completed_at, created_at, updated_at, ordered_by
         FROM amc_orders WHERE application_id=$1`, [appId]);
    for (const row of r.rows) out.push(describe('nan', row));
  } catch (_) { /* a vendor we cannot read is a vendor we say nothing about */ }
  try {
    const r = await dbh.query(
      `SELECT id, status, status_reason, class_order_id, reference_number, product_title,
              client_fee_cents, last_error, placed_at, created_at, updated_at, placed_by
         FROM class_orders WHERE application_id=$1`, [appId]);
    for (const row of r.rows) out.push(describe('class', row));
  } catch (_) { /* as above */ }
  try {
    const r = await dbh.query(
      `SELECT id, status, vendor_status, intake_token, order_token, report_type,
              total_price_cents, last_error, placed_at, created_at, updated_at, placed_by
         FROM rv_orders WHERE application_id=$1`, [appId]);
    for (const row of r.rows) out.push(describe('rv', row));
  } catch (_) { /* as above */ }
  return out.filter(Boolean);
}

/* -------------------------------------------------------------------------- */
/* The write.                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Bring the file's 'appraisal' desk row into step with its vendor orders.
 *
 * @returns {Promise<{ok:boolean, status?:string, vendor?:string, reason?:string}>}
 * Never throws.
 */
async function syncOne(appId, dbc) {
  const dbh = dbc || db();
  if (!appId) return { ok: false, reason: 'no_app' };
  try {
    const primary = pickPrimary(await readVendorOrders(dbh, appId));

    if (!primary) {
      /* NOTHING PLACED. The row is not deleted — a coordinator may have written a
         note or taken ownership before the order went out, and throwing that away
         because a draft was abandoned would be the desk losing a human's work.
         It is put back to 'not_ordered' only if THIS module had previously said
         otherwise, so a row somebody else owns is never touched. */
      await dbh.query(
        `UPDATE file_orders
            SET status='not_ordered', ordered_at=NULL, completed_at=NULL,
                meta = COALESCE(meta,'{}'::jsonb) - 'appraisal', updated_at=now()
          WHERE application_id=$1 AND order_type='appraisal'
            AND status <> 'not_ordered'`, [appId]);
      return { ok: true, status: 'not_ordered' };
    }

    const meta = {
      vendor: primary.vendor,
      vendorName: primary.vendorName,
      // THE VENDOR ORDER ROW'S OWN ID — not the vendor's order NUMBER below, which
      // is their reference and is not unique across the three companies. This is
      // what `appraisal_payment_intents` is keyed on, so without it the desk can
      // carry a payment instruction it can never find again.
      orderId: primary.rowId,
      orderNumber: primary.orderNumber,
      product: primary.product,
      feeCents: primary.feeCents,
      vendorStatus: primary.vendorStatus,
      nativeStatus: primary.nativeStatus,
      lastError: primary.lastError,
      // Who is doing it, when they are going out, and what is still owed. NULL until
      // the vendor has said — the desk shows the block only when it carries something,
      // so an empty one can never read as "nobody assigned".
      detail: primary.detail || null,
      // The section the desk's "open it" action jumps to. Named here so the desk
      // never has to know how the appraisal section is built.
      section: 'sec-order-appraisal',
      syncedAt: new Date().toISOString(),
    };

    /* THE UPSERT NAMES ITS COLUMNS ONE BY ONE, and that is the load-bearing part:
       everything a human owns on this row — the assignment, the note, an agreed
       due date, the follow-up count — is absent from both the insert and the
       update, so a poll can never wipe it. `meta` is MERGED rather than replaced
       for the same reason (the desk stores the borrower-Cc choice in there). */
    await dbh.query(
      `INSERT INTO file_orders
         (application_id, order_type, status, vendor_name, ordered_at, ordered_by, completed_at, meta, updated_at)
       VALUES ($1,'appraisal',$2,$3,$4,$5,$6,$7::jsonb, now())
       ON CONFLICT (application_id, order_type) DO UPDATE
          SET status       = EXCLUDED.status,
              vendor_name  = EXCLUDED.vendor_name,
              ordered_at   = EXCLUDED.ordered_at,
              -- fill-only: whoever the desk already records as having placed it
              -- stays, so a re-projection cannot rewrite the person.
              ordered_by   = COALESCE(file_orders.ordered_by, EXCLUDED.ordered_by),
              completed_at = EXCLUDED.completed_at,
              meta         = COALESCE(file_orders.meta,'{}'::jsonb) || EXCLUDED.meta,
              updated_at   = now()`,
      [appId, primary.status, primary.vendorName,
        primary.orderedAt || null, primary.orderedBy || null, primary.completedAt || null,
        JSON.stringify({ appraisal: meta })]);

    return { ok: true, status: primary.status, vendor: primary.vendor };
  } catch (e) {
    console.error('[appraisal-orders] could not mirror the desk row for', appId, (e && e.message) || e);
    return { ok: false, reason: 'error' };
  }
}

/** Fire-and-forget, for a caller on a request or poll path. Never awaited-for. */
function fire(appId) {
  try { setImmediate(() => { syncOne(appId).catch(() => {}); }); } catch (_) { /* never */ }
}

/**
 * BRING THE BACK BOOK ONTO THE DESK — every file that already has a vendor order
 * and no desk row (the standing "previous AND future" rule). Bounded per boot and
 * self-draining: a file gains its row on the first pass and is then excluded by
 * the NOT EXISTS, so a finished sweep costs one query.
 */
async function backfillOnce(dbc, limit = 200) {
  const dbh = dbc || db();
  const cap = Math.max(1, Math.min(2000, parseInt(process.env.APPRAISAL_ORDER_MIRROR_BATCH || String(limit), 10) || limit));
  if (process.env.APPRAISAL_ORDER_MIRROR_DISABLED === '1') return { swept: 0, skipped: 'disabled' };
  try {
    const rows = (await dbh.query(
      `SELECT DISTINCT application_id FROM (
            SELECT application_id FROM amc_orders
            UNION ALL SELECT application_id FROM class_orders
            UNION ALL SELECT application_id FROM rv_orders
          ) v
        WHERE application_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM file_orders o
             WHERE o.application_id = v.application_id AND o.order_type='appraisal')
        LIMIT $1`, [cap])).rows;
    let synced = 0;
    for (const r of rows) {
      const out = await syncOne(r.application_id, dbh);
      if (out && out.ok) synced += 1;
    }
    if (synced) console.log(`[appraisal-orders] desk backfill: ${synced} file(s) now on the Orders desk`);
    return { swept: rows.length, synced, more: rows.length >= cap };
  } catch (e) {
    console.error('[appraisal-orders] desk backfill failed (non-fatal):', (e && e.message) || e);
    return { swept: 0, reason: 'error' };
  }
}

module.exports = {
  syncOne, fire, backfillOnce,
  VENDOR_NAME,
  // pure — exported for the unit tests
  describe, pickPrimary, _internals: { NAN_STATUS, CLASS_STATUS, RV_STATUS, RANK },
};
