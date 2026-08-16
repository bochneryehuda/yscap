'use strict';
/**
 * Trinity ORDER placement — the adapter that replaces the manual "requested → ordered"
 * step the desk has been doing by hand (blueprint D8).
 *
 * What it sends, and why each piece is there (owner-directed 2026-08-14):
 *   · the CONSTRUCTION BUDGET, as Trinity's own line items, so the inspector's system
 *     is set up with our budget;
 *   · the HISTORICAL DRAWS, as each line's previousPercentCompleted — "if the first two
 *     draws were virtual, they need to know how much money was drawn already" — which
 *     also carries how much is still available on every line;
 *   · the APPRAISAL report — "they need to look at how the property started";
 *   · a readable budget + historical-draw spreadsheet and the scope of work;
 *   · an opening comment with the totals, so the Trinity team has the picture in words.
 *
 * SAFETY. Placing an order costs real money and dispatches a real person, so:
 *   · a 10-minute LEASE claim means only one driver ever places an order;
 *   · `customerKey` is an exactly-once key — a lost response cannot create a second
 *     order, because the retry RESOLVES the 409 instead of posting again;
 *   · every gate is checked BEFORE the call and refused in plain language;
 *   · documents and the opening comment are best-effort AFTER the order exists — a
 *     failed attachment never un-places an order or throws into a poller.
 *
 * This module touches nothing owned by the Sitewire virtual pipeline or the
 * TrustPoint/Blue Lake pipeline. It READS the shared budget ledger, which is what makes
 * the numbers agree, and writes only to its own trinity_* tables.
 */

const db = require('../db');
const cfg = require('../config');
const client = require('./client');
const mapper = require('./mapper');

const usd = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const err = (status, message) => { const e = new Error(message); e.status = status; return e; };

// Trinity document groups (GET /api/v1.1/documents/groups). The group validates the
// file EXTENSION as well as the kind, so each entry records what it will accept.
const DOC_GROUP = {
  APPRAISAL: 1,          // .pdf .xls .doc .tif .jpg .png .xlsx …
  COST_BREAKDOWN: 2,     // .pdf .xls .doc .tif .jpg .png .xlsx  (NOT .csv — verified)
  MISC: 3,
  SOW: 23,
  CONSTRUCTION_BUDGET: 151,
};

// ---------------------------------------------------------------------------
// reading the file
// ---------------------------------------------------------------------------
/**
 * The file's budget lines with the money already committed on each.
 *
 * "Committed" is approved by ANYONE on ANY live draw, not only on a finally-approved
 * one — the same reading `portal-draws.composerLines` uses, and for the same reason:
 * an inspector-approved draw still in flight has already spoken for that money, so
 * showing it as available would overstate what is left on the line.
 */
async function budgetLines(appId) {
  const rows = (await db.query(
    `SELECT l.sitewire_job_item_id, l.sow_line_key, l.name, l.budgeted_cents
       FROM sitewire_job_item_links l
      WHERE l.application_id = $1
        AND l.sitewire_job_item_id IS NOT NULL
        AND l.is_media_item = false
        AND (l.state IS NULL OR l.state <> 'deleted')
        AND COALESCE(l.sow_line_key, '') NOT LIKE '\\_\\_media\\_\\_%'
      ORDER BY l.unit_index NULLS FIRST, l.id`, [appId])).rows;

  const drawn = (await db.query(
    `SELECT r.sitewire_job_item_id AS jid, COALESCE(SUM(COALESCE(r.approved_cents,0)),0)::bigint AS c
       FROM sitewire_draw_requests r
       JOIN sitewire_draws d ON d.sitewire_draw_id = r.sitewire_draw_id
      WHERE d.application_id = $1
      GROUP BY r.sitewire_job_item_id`, [appId])).rows;
  const drawnBy = new Map(drawn.map((d) => [Number(d.jid), Number(d.c)]));

  return rows.map((r) => ({
    sitewire_job_item_id: Number(r.sitewire_job_item_id),
    sow_line_key: r.sow_line_key,
    name: r.name,
    budgeted_cents: Number(r.budgeted_cents || 0),
    previous_drawn_cents: drawnBy.get(Number(r.sitewire_job_item_id)) || 0,
    requested_cents: 0,
  }));
}

/** The file's identity, property, borrower and contractor, as Trinity needs them. */
async function fileContext(appId) {
  const a = (await db.query(
    `SELECT a.id, a.ys_loan_number, a.property_address, a.property_type, a.units,
            a.rehab_budget, a.loan_amount, a.loan_type, a.as_is_value,
            b.first_name, b.last_name, b.email, b.cell_phone
       FROM applications a
       LEFT JOIN borrowers b ON b.id = a.borrower_id
      WHERE a.id = $1 AND a.deleted_at IS NULL`, [appId])).rows[0];
  if (!a) throw err(404, 'file not found');

  const contractor = (await db.query(
    `SELECT sc.company_name, sc.contact_name, sc.email, sc.phone
       FROM application_service_contacts asc2
       JOIN service_contacts sc ON sc.id = asc2.service_contact_id
      WHERE asc2.application_id = $1 AND sc.contact_type = 'contractor'
      ORDER BY asc2.created_at DESC NULLS LAST LIMIT 1`, [appId])).rows[0] || null;

  const appraisal = (await db.query(
    `SELECT as_is_value, appraised_value, effective_date, appraiser_company
       FROM appraisals
      WHERE application_id = $1 AND superseded = false
      ORDER BY imported_at DESC NULLS LAST LIMIT 1`, [appId])).rows[0] || null;

  const addr = a.property_address || {};
  return {
    app: a,
    address: {
      street: addr.street || addr.line1 || addr.address1 || null,
      city: addr.city || null,
      state: addr.state || null,
      zip: addr.zip || addr.zipCode || addr.postal_code || null,
      county: addr.county || null,
    },
    borrower: {
      name: [a.first_name, a.last_name].filter(Boolean).join(' '),
      email: a.email, phone: a.cell_phone,
    },
    contractor: contractor ? {
      name: contractor.contact_name, companyName: contractor.company_name,
      email: contractor.email, phone: contractor.phone,
    } : null,
    appraisal: appraisal ? {
      valueCents: appraisal.as_is_value != null ? Math.round(Number(appraisal.as_is_value) * 100)
        : (appraisal.appraised_value != null ? Math.round(Number(appraisal.appraised_value) * 100) : null),
      datePerformed: appraisal.effective_date ? new Date(appraisal.effective_date).toISOString() : null,
      performedBy: appraisal.appraiser_company,
    } : null,
  };
}

// ---------------------------------------------------------------------------
// placing the order
// ---------------------------------------------------------------------------
/**
 * Place (or resume) the Trinity order for one of our order records.
 *
 * Idempotent by construction: the order id is recorded the instant Trinity returns it,
 * and a 409 on the customerKey is RESOLVED (we look the existing order up and adopt it)
 * rather than retried. Returns a plain result — it never throws into a caller that
 * cannot act on the failure.
 */
async function placeOrder(appId, orderRowId, { staffId = null } = {}) {
  const o = (await db.query(
    `SELECT * FROM trinity_inspection_orders WHERE id=$1 AND application_id=$2`, [orderRowId, appId])).rows[0];
  if (!o) return { skipped: 'not_found' };
  if (o.status === 'cancelled') return { skipped: 'cancelled' };
  if (o.trinity_order_id) return { ok: true, already: true, trinityOrderId: Number(o.trinity_order_id) };
  if (!client.available()) return { skipped: 'not_configured', message: 'Trinity credentials are not set up yet.' };
  if (!client.enabled()) return { skipped: 'off', message: 'The Trinity connection is switched off.' };
  if (!client.outboundEnabled() && !client.dryrun()) {
    return { skipped: 'outbound_off', message: 'Placing Trinity orders is switched off.' };
  }

  // ---- the LEASE: exactly one driver proceeds; a crashed run frees in 10 minutes ----
  const claimed = (await db.query(
    `UPDATE trinity_inspection_orders
        SET order_claimed_at = now(), updated_at = now()
      WHERE id = $1 AND trinity_order_id IS NULL
        AND (order_claimed_at IS NULL OR order_claimed_at < now() - interval '10 minutes')
      RETURNING id`, [orderRowId])).rows[0];
  if (!claimed) return { skipped: 'in_flight' };
  const release = () => db.query(
    `UPDATE trinity_inspection_orders SET order_claimed_at = NULL WHERE id = $1`, [orderRowId]).catch(() => {});

  try {
    const ctx = await fileContext(appId);
    const lines = await budgetLines(appId);

    // Fold this draw's requested amounts onto the budget lines.
    let requestedTotal = 0;
    if (o.portal_draw_request_id) {
      const pr = (await db.query(
        `SELECT lines, total_requested_cents FROM portal_draw_requests WHERE id=$1`, [o.portal_draw_request_id])).rows[0];
      const want = new Map();
      for (const l of (pr && Array.isArray(pr.lines) ? pr.lines : [])) {
        if (l && l.sitewire_job_item_id != null) want.set(Number(l.sitewire_job_item_id), Number(l.requested_cents || 0));
      }
      for (const l of lines) {
        const c = want.get(l.sitewire_job_item_id);
        if (c > 0) { l.requested_cents = c; requestedTotal += c; }
      }
    } else if (o.sitewire_draw_id) {
      const rows = (await db.query(
        `SELECT sitewire_job_item_id AS jid, COALESCE(requested_cents,0) AS c
           FROM sitewire_draw_requests WHERE sitewire_draw_id = $1`, [o.sitewire_draw_id])).rows;
      const want = new Map(rows.map((r) => [Number(r.jid), Number(r.c)]));
      for (const l of lines) {
        const c = want.get(l.sitewire_job_item_id);
        if (c > 0) { l.requested_cents = c; requestedTotal += c; }
      }
    }

    // A line the borrower is drawing on has NOT yet been drawn — the requested amount
    // must never also appear as historical, or the inspector is told the work is
    // already paid for.
    for (const l of lines) {
      l.previous_drawn_cents = Math.max(0, Math.min(l.previous_drawn_cents, l.budgeted_cents));
    }

    const customerKey = o.customer_key || `pdr-${o.portal_draw_request_id || o.id}`;
    const companyId = await client.companyId();
    const { payload, problems } = mapper.buildOrderPayload({
      companyId,
      projectNumber: ctx.app.ys_loan_number,
      projectCustomerKey: `app-${appId}`,
      orderCustomerKey: customerKey,
      address: ctx.address,
      appraisal: ctx.appraisal,
      units: ctx.app.units,
      propertyType: /commercial|mixed/i.test(String(ctx.app.property_type || '')) ? 'Commercial' : 'Residential',
      projectType: /ground.?up|construction/i.test(String(ctx.app.loan_type || '')) ? 'NewConstruction' : 'Remodel',
      totalProjectCostCents: ctx.app.loan_amount != null ? Math.round(Number(ctx.app.loan_amount) * 100) : null,
      borrower: ctx.borrower,
      contractor: ctx.contractor,
      analyst: { name: 'Draw Coordinator', email: 'draws@yscapgroup.com' },
      lines,
    });

    if (problems.length) {
      const reason = `Trinity needs a few things first: ${problems.join('; ')}.`;
      await db.query(
        `UPDATE trinity_inspection_orders SET blocked_reason=$2, order_claimed_at=NULL, updated_at=now() WHERE id=$1`,
        [orderRowId, reason.slice(0, 500)]);
      return { blocked: true, message: reason, problems };
    }

    // ---- the call ----
    let created = null, trinityOrderId = null, trinityProjectId = null;
    try {
      created = await client.createOrder(payload);
      if (created && created.__dryrun) {
        await release();
        return { ok: true, dryrun: true, wouldSend: { lines: payload.order.lineItems.length, requestedTotal } };
      }
      trinityOrderId = created && created.order && created.order.id;
      trinityProjectId = created && created.id;
    } catch (e) {
      // 409 = the exactly-once key says this order already exists. Adopt it rather
      // than ever posting a second one.
      if (e && e.conflict) {
        const found = await client.findOrderByCustomerKey(customerKey).catch(() => null);
        if (found && found.id) {
          trinityOrderId = found.id;
          trinityProjectId = found.projectId || null;
        } else {
          const reason = `Trinity refused the order: ${String(e.body && e.body.detail || e.message).slice(0, 200)}`;
          await db.query(
            `UPDATE trinity_inspection_orders SET blocked_reason=$2, order_claimed_at=NULL, updated_at=now() WHERE id=$1`,
            [orderRowId, reason.slice(0, 500)]);
          return { blocked: true, message: reason };
        }
      } else {
        await release();
        return { error: true, retryable: !!(e && e.retryable), message: String(e && e.message).slice(0, 300) };
      }
    }

    if (!trinityOrderId) { await release(); return { error: true, message: 'Trinity returned no order id' }; }

    // ---- RECORD IMMEDIATELY: from here every retry is a resume, never a re-create ----
    try {
      await db.query(
        `UPDATE trinity_inspection_orders
            SET trinity_order_id=$2, trinity_project_id=$3, customer_key=$4,
                status = CASE WHEN status='requested' THEN 'ordered' ELSE status END,
                ordered_at = COALESCE(ordered_at, now()), ordered_by = COALESCE(ordered_by, $5::uuid),
                blocked_reason = NULL, order_claimed_at = NULL, updated_at = now()
          WHERE id=$1`,
        [orderRowId, trinityOrderId, trinityProjectId, customerKey, staffId]);
    } catch (e) {
      // `uq_tio_trinity_order` refusing means ANOTHER of our records already holds this
      // Trinity order — the 409-recovery path resolved to an order a different draw is
      // already following. Refusing is right (two of our draws must never share one
      // inspection), but it needs to read as a thing a human can act on rather than as a
      // database error, so it is recorded as a block on this record and NOT retried.
      if (e && e.code === '23505') {
        const other = (await db.query(
          `SELECT id FROM trinity_inspection_orders WHERE trinity_order_id=$1 AND id<>$2 LIMIT 1`,
          [trinityOrderId, orderRowId])).rows[0];
        const reason = `Trinity order ${trinityOrderId} is already being followed by another draw on this file`
          + `${other ? ` (record #${other.id})` : ''}. Two draws can't share one inspection — check the draw desk before ordering again.`;
        await db.query(
          `UPDATE trinity_inspection_orders SET blocked_reason=$2, order_claimed_at=NULL, updated_at=now() WHERE id=$1`,
          [orderRowId, reason.slice(0, 500)]).catch(() => {});
        return { blocked: true, message: reason };
      }
      throw e;
    }

    // ---- the per-line crosswalk (what we SENT — the record of what the inspector saw) ----
    const sentItems = payload.order.lineItems;
    const byKey = new Map(lines.map((l) => [mapper.customerKeyForLine(l), l]));
    for (const it of sentItems) {
      const src = byKey.get(it.customerKey) || {};
      // The ON CONFLICT target must carry the index's own WHERE clause: `uq_tol_order_key`
      // is a PARTIAL unique index, and Postgres cannot infer a partial index without it
      // (42P10). Getting this wrong is silent if the error is swallowed — and the
      // crosswalk is what ties Trinity's answer back to OUR job items, so a missing row
      // here would leave a completed inspection unable to say which line it approved.
      // It is deliberately NOT wrapped in a catch for that reason.
      await db.query(
        `INSERT INTO trinity_order_lines
           (trinity_inspection_order_id, application_id, sitewire_job_item_id, sow_line_key, name,
            customer_key, budgeted_cents, requested_cents, previous_drawn_cents, previous_pct)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (trinity_inspection_order_id, customer_key) WHERE customer_key IS NOT NULL DO UPDATE
           SET budgeted_cents=EXCLUDED.budgeted_cents, requested_cents=EXCLUDED.requested_cents,
               previous_drawn_cents=EXCLUDED.previous_drawn_cents, previous_pct=EXCLUDED.previous_pct,
               name=EXCLUDED.name, updated_at=now()`,
        [orderRowId, appId, src.sitewire_job_item_id || null, src.sow_line_key || null,
         it.description, it.customerKey, src.budgeted_cents || 0, src.requested_cents || 0,
         src.previous_drawn_cents || 0, it.previousPercentCompleted]);
    }

    // ---- everything below is BEST-EFFORT: the order exists and must never be undone ----
    const docs = await sendDocuments(appId, orderRowId, trinityOrderId, { lines, requestedTotal }).catch(
      (e) => ({ error: String(e && e.message).slice(0, 200) }));
    await openingComment(appId, orderRowId, trinityOrderId, { lines, requestedTotal, ctx }).catch(() => {});

    return { ok: true, trinityOrderId, trinityProjectId, documents: docs, lines: sentItems.length, requestedTotal };
  } catch (e) {
    await release();
    return { error: true, message: String(e && e.message).slice(0, 300) };
  }
}

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------
/**
 * The readable budget + historical draws, as an .xlsx.
 *
 * The percentages we send drive Trinity's system; THIS is what a human reads. It states
 * every line's budget, what has already been drawn, what is left, and what this draw is
 * asking for — the owner's "how much money is still available for each and every line
 * item" in the plainest possible form.
 */
function budgetWorkbook(lines, requestedTotal) {
  const { buildXlsx } = require('../lib/xlsx');
  const rows = [['Line item', 'Construction budget', 'Already drawn', 'Still available', 'Requested this draw']];
  let b = 0, d = 0, r = 0;
  for (const l of lines) {
    const avail = Math.max(0, l.budgeted_cents - l.previous_drawn_cents);
    rows.push([l.name, l.budgeted_cents / 100, l.previous_drawn_cents / 100, avail / 100, (l.requested_cents || 0) / 100]);
    b += l.budgeted_cents; d += l.previous_drawn_cents; r += (l.requested_cents || 0);
  }
  rows.push([]);
  rows.push(['TOTAL', b / 100, d / 100, Math.max(0, b - d) / 100, r / 100]);
  rows.push([]);
  rows.push(['Prepared by PILOT (YS Capital Group) for this draw inspection.']);
  rows.push([`Requested on this draw: ${usd(requestedTotal)}`]);
  return buildXlsx(rows, 'Budget & draws');
}

/** Send the appraisal, the budget/historical spreadsheet and the scope of work. */
async function sendDocuments(appId, orderRowId, trinityOrderId, { lines, requestedTotal }) {
  if (!client.outboundEnabled() && !client.dryrun()) return { skipped: 'outbound_off' };
  const storage = require('../lib/storage');
  const uploader = { firstName: 'Draw', lastName: 'Coordinator', emailAddress: 'draws@yscapgroup.com' };
  const sent = [], failed = [];

  // 1. The budget + historical draws (always available — we build it ourselves).
  try {
    const buf = budgetWorkbook(lines, requestedTotal);
    await client.addDocument(trinityOrderId, {
      buffer: buf,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileName: 'construction-budget-and-draws.xlsx',
      groupId: DOC_GROUP.COST_BREAKDOWN,
      customerKey: `o${orderRowId}-budget`,
      uploader,
    });
    sent.push('construction budget + historical draws');
  } catch (e) {
    if (!(e && e.conflict)) failed.push(`budget (${String(e && e.message).slice(0, 80)})`);
    else sent.push('construction budget + historical draws');   // already there
  }

  // 2. The appraisal report and the scope of work, when the file holds them.
  const wanted = [
    { kinds: ['appraisal_pdf'], codes: ['rtl_cond_appraisaldocs'], group: DOC_GROUP.APPRAISAL, label: 'appraisal report', key: 'appraisal' },
    { kinds: ['sow_pdf', 'rehab_budget_pdf'], codes: ['rtl_p3_sow', 'rtl_cond_sow'], group: DOC_GROUP.SOW, label: 'scope of work', key: 'sow' },
  ];
  for (const w of wanted) {
    try {
      const row = (await db.query(
        `SELECT d.id, d.filename, d.content_type, d.storage_ref, d.storage_provider
           FROM documents d
           LEFT JOIN checklist_items ci ON ci.id = d.checklist_item_id
           LEFT JOIN checklist_templates t ON t.id = ci.template_id
          WHERE d.application_id = $1
            AND COALESCE(d.is_current, true) = true
            AND COALESCE(d.review_status,'') <> 'rejected'
            AND d.storage_ref IS NOT NULL
            AND (COALESCE(d.doc_kind,'') = ANY($2::text[]) OR COALESCE(t.code,'') = ANY($3::text[]))
            AND lower(COALESCE(d.filename,'')) LIKE '%.pdf'
          ORDER BY d.created_at DESC LIMIT 1`,
        [appId, w.kinds, w.codes])).rows[0];
      if (!row) continue;
      const buf = await storage.forRow(row).read(row.storage_ref);
      if (!buf || !buf.length) continue;
      await client.addDocument(trinityOrderId, {
        buffer: buf,
        contentType: row.content_type || 'application/pdf',
        // The group validates the EXTENSION, so the name we send always ends .pdf.
        fileName: `${w.key}.pdf`,
        groupId: w.group,
        customerKey: `o${orderRowId}-${w.key}`,
        uploader,
      });
      sent.push(w.label);
    } catch (e) {
      if (e && e.conflict) sent.push(w.label);
      else failed.push(`${w.label} (${String(e && e.message).slice(0, 80)})`);
    }
  }

  await db.query(
    `UPDATE trinity_inspection_orders SET documents_sent_at=now(), updated_at=now() WHERE id=$1`, [orderRowId]).catch(() => {});
  return { sent, failed };
}

/** The opening message to the Trinity team — the picture in words. */
async function openingComment(appId, orderRowId, trinityOrderId, { lines, requestedTotal, ctx }) {
  const budget = lines.reduce((s, l) => s + l.budgeted_cents, 0);
  const drawn = lines.reduce((s, l) => s + l.previous_drawn_cents, 0);
  const asking = lines.filter((l) => (l.requested_cents || 0) > 0);
  const body = [
    `Draw inspection requested by YS Capital Group (PILOT) for ${ctx.address.street || 'this property'}.`,
    `Construction budget ${usd(budget)} · already drawn ${usd(drawn)} · still available ${usd(Math.max(0, budget - drawn))}.`,
    `This draw requests ${usd(requestedTotal)} across ${asking.length} line item${asking.length === 1 ? '' : 's'}:`,
    ...asking.slice(0, 20).map((l) => `  • ${l.name}: ${usd(l.requested_cents)} (budget ${usd(l.budgeted_cents)}, drawn to date ${usd(l.previous_drawn_cents)})`),
    asking.length > 20 ? `  • …and ${asking.length - 20} more (see the attached spreadsheet)` : '',
    '',
    'The construction budget with the historical draws, the appraisal and the scope of work are attached. Please reply here with any questions.',
  ].filter(Boolean).join('\n').slice(0, 2790);

  return postComment(appId, orderRowId, trinityOrderId, body, { staffId: null, important: false });
}

/** Post a message to Trinity and mirror it into our own thread. */
async function postComment(appId, orderRowId, trinityOrderId, content, { staffId = null, important = false, authorName = 'PILOT' } = {}) {
  const res = await client.addComment(trinityOrderId, {
    content: String(content).slice(0, 2790),
    important: !!important,
    visibleToVendor: true,
    commenter: { isExternalPerson: false, firstName: 'Draw', lastName: 'Coordinator', emailAddress: 'draws@yscapgroup.com' },
  });
  if (res && res.__dryrun) return { dryrun: true };
  await db.query(
    `INSERT INTO trinity_order_comments
       (trinity_inspection_order_id, application_id, trinity_comment_id, direction, content, important, author_name, sent_by_staff, trinity_created_at)
     VALUES ($1,$2,$3,'out',$4,$5,$6,$7,$8)
     ON CONFLICT (trinity_comment_id) WHERE trinity_comment_id IS NOT NULL DO NOTHING`,
    [orderRowId, appId, res && res.id ? Number(res.id) : null, String(content).slice(0, 4000),
     !!important, authorName, staffId, res && res.createdAt ? new Date(res.createdAt) : new Date()]).catch(() => {});
  return { ok: true, id: res && res.id };
}

module.exports = {
  DOC_GROUP, budgetLines, fileContext, placeOrder, sendDocuments, postComment,
  budgetWorkbook, openingComment,
};
