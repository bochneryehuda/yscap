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
const FORM = require('./form');
const drawCommitted = require('../lib/draw-committed');   // "how much of this line is already spoken for"

const usd = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const err = (status, message) => { const e = new Error(message); e.status = status; return e; };

// Trinity document groups (GET /api/v1.1/documents/groups). The group validates the
// file EXTENSION as well as the kind, so each entry records what it will accept.
// The most a single document may be before we decline to send it. Trinity accepted
// 40 MB in 9.6s (measured 2026-08-16) — this ceiling exists to protect OUR 30-second
// client timeout on a POST that is deliberately never retried, not to satisfy theirs.
const MAX_DOC_BYTES = Math.max(1, parseInt(process.env.TRINITY_MAX_DOC_MB || '25', 10) || 25) * 1024 * 1024;

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
async function budgetLines(appId, opts = {}) {
  // THE DRAW BEING INSPECTED IS NOT ITS OWN HISTORY. `excludeDrawId` /
  // `excludePortalRequestId` name the draw this order is for, and its money is left out
  // of the historical sum — otherwise a draw that is already approved on our side when
  // the inspection is ordered would be reported to the inspector BOTH as money already
  // released AND as the amount being requested, which is the same dollars counted twice.
  // It reads as "this line is 50% done, now give me the other 50%" on a line where
  // nothing has been paid at all. Deliberately expressed as an EXCLUSION rather than a
  // status test: what makes a draw not-history is that it is THIS one, not what state it
  // happens to be in.
  const exclDraw = opts.excludeDrawId != null && Number.isFinite(Number(opts.excludeDrawId))
    ? Number(opts.excludeDrawId) : null;
  const exclReq = opts.excludePortalRequestId != null && Number.isFinite(Number(opts.excludePortalRequestId))
    ? Number(opts.excludePortalRequestId) : null;
  const rows = (await db.query(
    `SELECT l.sitewire_job_item_id, l.sow_line_key, l.name, l.budgeted_cents
       FROM sitewire_job_item_links l
      WHERE l.application_id = $1
        AND l.sitewire_job_item_id IS NOT NULL
        AND l.is_media_item = false
        AND (l.state IS NULL OR l.state <> 'deleted')
        AND COALESCE(l.sow_line_key, '') NOT LIKE '\\_\\_media\\_\\_%'
      ORDER BY l.unit_index NULLS FIRST, l.id`, [appId])).rows;

  // WHAT IS ALREADY DRAWN ON EACH LINE — `lib/draw-committed.js`, the ONE definition,
  // shared with the draw composer so the inspector and the borrower can never be shown
  // two different pictures of the same budget.
  //
  // It reads Sitewire's per-line ledger PLUS any portal draw request whose money is
  // approved but whose ledger rows do not exist yet. Both halves are needed, and the
  // second one is not an edge case: Sitewire refuses a manual draw entry, so a Trinity
  // draw lives only as a portal request until it is approved and closed out as a
  // HISTORICAL draw — and even then its per-line rows appear only when the reconcile
  // next runs (default every 300s). Reading Sitewire alone would, in either window, tell
  // the inspector a line still had its whole budget available when the borrower had
  // already been paid for it: the single most expensive thing this integration could get
  // wrong, and the exact opposite of what the historical draws are for.
  //
  // It cannot double count — a portal request stops counting the moment its draw's
  // ledger rows exist — and the draw being ordered right now is excluded by id, so it
  // can never be reported as its own history.
  const drawnBy = await drawCommitted.committedByJobItem(appId, {
    excludeDrawId: exclDraw, excludePortalRequestId: exclReq,
  });

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

  // `phones` is the contact record's extra numbers (mobile, office, …). Trinity needs
  // at least ONE usable number and does not care which field it arrives in, so every
  // number we hold is offered and the mapper picks the first it can clean.
  const contractor = (await db.query(
    `SELECT sc.company_name, sc.contact_name, sc.email, sc.phone, sc.phones
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
      email: contractor.email,
      phone: contractor.phone,
      // The first ALTERNATE number on the contact record (the primary already rode in
      // as `phone`), offered so a contractor whose only good number is the mobile one
      // still produces a sendable order.
      mobilePhone: (Array.isArray(contractor.phones) ? contractor.phones : [])
        .map((p) => String(p || '').trim())
        .filter((p) => p && p !== String(contractor.phone || '').trim())[0] || null,
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
    const lines = await budgetLines(appId, {
      excludeDrawId: o.sitewire_draw_id,
      excludePortalRequestId: o.portal_draw_request_id,
    });

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

    /* ---- WHICH FORM THIS ORDER GOES OUT ON ----
       The record's own choice wins over the configured default, for two reasons that pull the
       same way. A coordinator who deliberately picked a form (`intake.orderManually`) must get the
       one they picked, and a retry of a record that has ALREADY been placed must go out on the
       form the record claims — a resume that switched forms would place a second, different
       product and leave the read-back pointing at neither. `formForRow` is that one rule; the
       form actually used is recorded in the same statement that records the order id below, so
       the record and the read-back can never disagree about it (db/628). */
    const formUsed = FORM.formForRow(o, client.formId());

    // ---- the call ----
    let created = null, trinityOrderId = null, trinityProjectId = null;
    try {
      created = await client.createOrder(payload, { form: formUsed });
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
                trinity_form_id=$6,
                status = CASE WHEN status='requested' THEN 'ordered' ELSE status END,
                ordered_at = COALESCE(ordered_at, now()), ordered_by = COALESCE(ordered_by, $5::uuid),
                blocked_reason = NULL, order_claimed_at = NULL, updated_at = now()
          WHERE id=$1`,
        [orderRowId, trinityOrderId, trinityProjectId, customerKey, staffId, formUsed]);
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

    // ---- the order's first timeline entry: this is where progress starts ----
    await recordEvent(appId, orderRowId, {
      kind: 'ordered', source: 'order', staffId,
      detail: `Ordered from Trinity — ${sentItems.length} budget line${sentItems.length === 1 ? '' : 's'}, ${usd(requestedTotal)} requested.`,
    }).catch(() => {});

    // ---- everything below is BEST-EFFORT: the order exists and must never be undone ----
    // PROVE the budget landed before anything else — a broken crosswalk is worth
    // knowing about now, not when the report comes back and nothing can be matched.
    const proof = await verifyBudget(appId, orderRowId, trinityOrderId, sentItems, formUsed).catch(
      (e) => ({ error: String(e && e.message).slice(0, 200) }));

    const docs = await sendDocuments(appId, orderRowId, trinityOrderId, { lines, requestedTotal }).catch(
      (e) => ({ error: String(e && e.message).slice(0, 200) }));
    // The opening message names what ACTUALLY attached, not what we hoped would — an
    // inspector told to look for a document that is not there wastes a phone call.
    await openingComment(appId, orderRowId, trinityOrderId, { lines, requestedTotal, ctx, sent: (docs && docs.sent) || [] }).catch(() => {});

    return { ok: true, trinityOrderId, trinityProjectId, documents: docs, budget: proof, lines: sentItems.length, requestedTotal };
  } catch (e) {
    await release();
    return { error: true, message: String(e && e.message).slice(0, 300) };
  }
}

// ---------------------------------------------------------------------------
// the progress timeline — Trinity has no history endpoint, so this is the record
// ---------------------------------------------------------------------------
/**
 * Append one entry to the order's timeline.
 *
 * VERIFIED 2026-08-16: Trinity exposes only the CURRENT status —
 * `GET /orders/{id}/history`, `/events`, `/statuses` and `/status` all answer 404. So
 * the sequence the owner asked to see ("ordered, scheduled, inspected, report back")
 * exists ONLY here, and only because we write it down as we watch.
 *
 * APPEND-ONLY and never throws — a timeline is a record of what happened and must never
 * be the reason something fails to happen. A duplicate status collides on
 * `uq_toe_status_once` and is dropped, so the poller re-reading the same order every
 * few minutes cannot fill the timeline with copies of one moment.
 */
async function recordEvent(appId, orderRowId, {
  kind = 'status', state = null, statusId = null, status = null, substatus = null,
  detail = null, percentComplete = null, source = 'poller', staffId = null,
} = {}) {
  try {
    const r = await db.query(
      `INSERT INTO trinity_order_events
         (trinity_inspection_order_id, application_id, state, trinity_status_id, trinity_status,
          trinity_substatus, kind, detail, percent_complete, source, staff_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::uuid)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [orderRowId, appId, state, statusId,
       status ? String(status).slice(0, 120) : null,
       substatus ? String(substatus).slice(0, 120) : null,
       kind, detail ? String(detail).slice(0, 500) : null, percentComplete, source, staffId]);
    return { ok: true, added: r.rows.length > 0 };
  } catch (e) {
    console.warn('[trinity] timeline write failed:', e && e.message);
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// the budget proof — "their system really understands our construction budget"
// ---------------------------------------------------------------------------
/**
 * Read Trinity's budget straight back and reconcile it against what we sent.
 *
 * This is the answer to the owner's *"how we force them to be linked together"*. The
 * link is forced from BOTH ends: Trinity refuses an order whose line keys collide
 * (400, verified), and this proves — on every single order, not once in a lab — that
 * the budget their inspector will work from is the budget we sent, that the money
 * already drawn survived the percentage conversion, and above all that OUR reference
 * came back on EVERY line. Without that reference a completed report is a set of
 * numbers we cannot attach to our own budget lines.
 *
 * A disagreement is recorded in plain words for the desk and does NOT undo the order —
 * the inspection is real and cancelling it over a reconciliation is worse than showing
 * a human what differs. Best-effort throughout: it can never fail a placement.
 */
async function verifyBudget(appId, orderRowId, trinityOrderId, sentItems, form = null) {
  if (!client.available() || !client.enabled()) return { skipped: 'off' };
  let remote;
  // The form THIS order went out on — a budget is only readable at the form it was placed on.
  try { remote = await client.getBudget(trinityOrderId, form); }
  catch (e) { return { skipped: 'unreadable', message: String(e && e.message).slice(0, 200) }; }
  if (remote && remote.__dryrun) return { skipped: 'dryrun' };

  const v = mapper.verifyRemoteBudget(sentItems, remote);
  const s = v.summary || {};

  // Record Trinity's own line ids on our crosswalk. This is what lets a human ask
  // Trinity about "your line 13286139" and get an answer about OUR budget line.
  try {
    for (const it of (remote && remote.lineItems) || []) {
      if (it.customerKey == null || it.id == null) continue;
      await db.query(
        `UPDATE trinity_order_lines SET trinity_line_id=$3, updated_at=now()
          WHERE trinity_inspection_order_id=$1 AND customer_key=$2 AND trinity_line_id IS NULL`,
        [orderRowId, String(it.customerKey), Number(it.id)]);
    }
  } catch (_) { /* the crosswalk already ties on customerKey; their id is a convenience */ }

  const mismatch = v.ok ? null
    : `Trinity's copy of the construction budget does not match ours: ${v.problems.join(' ')}`;
  await db.query(
    `UPDATE trinity_inspection_orders
        SET budget_verified_at=now(), budget_mismatch=$2,
            remote_budget_cents=$3, remote_drawn_cents=$4, updated_at=now()
      WHERE id=$1`,
    [orderRowId, mismatch ? mismatch.slice(0, 2000) : null,
     s.remoteBudgetCents != null ? s.remoteBudgetCents : null,
     s.remoteDrawnCents != null ? s.remoteDrawnCents : null]).catch(() => {});

  await recordEvent(appId, orderRowId, {
    kind: 'note', source: 'order',
    detail: v.ok
      ? `Trinity's budget checked and agrees: ${s.checked} line${s.checked === 1 ? '' : 's'}, `
        + `${usd(s.remoteBudgetCents)} budget, ${usd(s.remoteDrawnCents)} already drawn.`
      : `Trinity's budget does NOT match ours — ${v.problems.length} difference${v.problems.length === 1 ? '' : 's'}.`,
  }).catch(() => {});

  // A line Trinity added on their side is not a fault, but the desk should know it is
  // there before it turns up in the results with no line of ours to belong to.
  if (v.ok && s.extraLines) {
    await recordEvent(appId, orderRowId, {
      kind: 'note', source: 'order',
      detail: `Trinity's budget also carries ${s.extraLines} line${s.extraLines === 1 ? '' : 's'} of their own: ${s.extraNames.join(', ')}.`,
    }).catch(() => {});
  }
  return { ok: v.ok, problems: v.problems, ...s };
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

  // 2. The appraisal report, the scope of work, and the MOST RECENT PRIOR INSPECTION
  //    REPORT, when the file holds them.
  //
  // The prior report is there because of what actually happens on a real file
  // (owner-directed 2026-08-16): *"We need to have a way of giving over to the inspector
  // the current, most recent inspection report in case he's taking over in the middle of
  // the process."* A Trinity inspector arriving at draw 3 has never seen the property.
  // The percentages tell him how much money was released; only the previous report tells
  // him what the last inspector actually SAW, and what they refused and why.
  //
  // "Most recent" spans all three report kinds this system produces, newest first, so it
  // works whichever pipeline the earlier draws ran on:
  //   · `draw_inspection_report`      — a Sitewire VIRTUAL draw's findings report. This
  //                                     is the common case the owner described: the first
  //                                     draws were virtual and this is the first physical.
  //   · `trinity_pilot_report`        — our branded report from a previous Trinity draw.
  //   · `trinity_inspection_report`   — Trinity's own report from a previous draw.
  //
  // It goes into MISCELLANEOUS, deliberately. Group 46 "Draw (Report complete)" is where
  // Trinity files THEIR finished report for an order, and putting a historical document
  // there could be read as this inspection's own result. Miscellaneous plus a
  // self-describing filename cannot be mistaken for anything, and the opening comment
  // (§openingComment) names it so the inspector knows it is waiting for him.
  const wanted = [
    { kinds: ['appraisal_pdf'], codes: ['rtl_cond_appraisaldocs'], group: DOC_GROUP.APPRAISAL, label: 'appraisal report', key: 'appraisal', fileName: 'appraisal-report' },
    { kinds: ['sow_pdf', 'rehab_budget_pdf'], codes: ['rtl_p3_sow', 'rtl_cond_sow'], group: DOC_GROUP.SOW, label: 'scope of work', key: 'sow', fileName: 'scope-of-work' },
    {
      kinds: ['draw_inspection_report', 'trinity_pilot_report', 'trinity_inspection_report'],
      codes: [], group: DOC_GROUP.MISC,
      label: 'the PREVIOUS inspection report', key: 'previous-inspection-report',
      // The filename is the only label Trinity's own screen shows, and an inspector
      // opening "inspection report" on a live order would reasonably assume it is about
      // THIS visit. It says PREVIOUS, in full.
      fileName: 'PREVIOUS-INSPECTION-REPORT-not-this-visit',
    },
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
      // NEVER GAMBLE THE ORDER ON ONE FAT UPLOAD. Measured 2026-08-16: Trinity itself
      // accepted 40 MB (53 MB base64) in 9.6s and showed no rate limiting — the ceiling
      // that actually bites is OUR `TRINITY_TIMEOUT_MS` (30s), and a document POST is
      // never retried in-call. So an oversize document is SKIPPED and NAMED rather than
      // risking a timeout on a placement that has already succeeded.
      if (buf.length > MAX_DOC_BYTES) {
        failed.push(`${w.label} (too large to send — ${(buf.length / 1048576).toFixed(1)} MB)`);
        continue;
      }
      await client.addDocument(trinityOrderId, {
        buffer: buf,
        contentType: row.content_type || 'application/pdf',
        // The group validates the EXTENSION, so the name we send always ends .pdf. The
        // NAME is also what a human reads on Trinity's screen, so it says what the
        // document IS — an inspector must never have to guess whether a report describes
        // this visit or the last one.
        fileName: `${w.fileName || w.key}.pdf`,
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

  /* STAMP THE DRAW ORDER — when this IS one. The pre-closing BUDGET REVIEW (form 159) reuses this
     whole function (same documents, same groups, same size ceiling) but lives in its own table, and
     it passes a non-numeric row id precisely so it can never address a draw order by accident.
     Without this guard that UPDATE raises a type error into a `.catch(() => {})` on every review —
     harmless, and exactly the kind of silently-swallowed failure this repo keeps finding. The
     review records its own document outcome on its own row. */
  if (/^\d+$/.test(String(orderRowId))) {
    await db.query(
      `UPDATE trinity_inspection_orders SET documents_sent_at=now(), updated_at=now() WHERE id=$1`, [orderRowId]).catch(() => {});
  }
  return { sent, failed };
}

// WE DELIBERATELY DO NOT SEND INSPECTION PHOTOS (owner-directed 2026-08-16: *"We don't
// really need to send the photos. The inspection report itself does the job: the PDF of
// the inspection report from the previous inspection."*).
//
// It was built and then removed on purpose, and the reasoning is worth keeping so it is
// not "helpfully" re-added:
//
//   · THE REPORT ALREADY CARRIES THE PICTURES. Our branded draw report embeds the
//     inspection photographs, so attaching the report hands the inspector the images AND
//     the findings and the per-line figures that explain them — one document instead of
//     a dozen loose files with no captions.
//   · IT IS THE EXPENSIVE PART OF PLACING AN ORDER. Measured against the live API on
//     2026-08-16: a document POST costs ~2.6s at 1 MB and ~9.6s at 40 MB. Eight photos
//     is eight more multi-second round trips on the critical path of an order that has
//     already been accepted — the single biggest way this integration could start
//     timing out, and for information the report already contains.
//   · SIZE AND RATE ARE NOT THE CONSTRAINT — OUR OWN TIMEOUT IS. Trinity accepted a
//     40 MB document and showed no 429 at 7.9 requests/second sequential or 20
//     concurrent. What can actually break is `TRINITY_TIMEOUT_MS` (30s) on a single fat
//     upload, which is why `sendDocuments` skips a document too large to be sent
//     comfortably rather than gambling the order on it.
//
// If a future reader genuinely needs loose photographs on Trinity's side: group 86
// "Photo Album" sounds right and accepts **.pdf ONLY** (verified — a .jpg into it is a
// 400). Images go to group 3 (Miscellaneous). Send them AFTER the order is settled,
// never inline with placement.

/** The opening message to the Trinity team — the picture in words. */
async function openingComment(appId, orderRowId, trinityOrderId, { lines, requestedTotal, ctx, sent = [] }) {
  const budget = lines.reduce((s, l) => s + l.budgeted_cents, 0);
  const drawn = lines.reduce((s, l) => s + l.previous_drawn_cents, 0);
  const asking = lines.filter((l) => (l.requested_cents || 0) > 0);
  const drawNo = lines.some((l) => l.previous_drawn_cents > 0);

  // Name only what actually attached. If a previous inspection report went with the
  // order, say so plainly and say WHY it is there — an inspector taking the property
  // over mid-project needs to know the last visit's findings exist and where they are.
  const hasPrior = sent.includes('the PREVIOUS inspection report');
  const attached = sent.length
    ? `Attached: ${sent.join(', ')}.`
    : 'The construction budget with the historical draws is on the order.';

  const body = [
    `Draw inspection requested by YS Capital Group (PILOT) for ${ctx.address.street || 'this property'}.`,
    `Construction budget ${usd(budget)} · already drawn ${usd(drawn)} · still available ${usd(Math.max(0, budget - drawn))}.`,
    `This draw requests ${usd(requestedTotal)} across ${asking.length} line item${asking.length === 1 ? '' : 's'}:`,
    ...asking.slice(0, 20).map((l) => `  • ${l.name}: ${usd(l.requested_cents)} (budget ${usd(l.budgeted_cents)}, drawn to date ${usd(l.previous_drawn_cents)})`),
    asking.length > 20 ? `  • …and ${asking.length - 20} more (see the attached spreadsheet)` : '',
    '',
    attached,
    drawn > 0
      ? 'Every line carries its percent-complete from the draws already released, so the budget shows what is still available on each item.'
      : 'This is the first draw on this project — no money has been released yet.',
    hasPrior
      ? 'ATTACHED UNDER MISCELLANEOUS: the report from the PREVIOUS inspection on this project — not this visit. '
        + 'It shows what the last inspector found, the photographs they took of the property at that visit, '
        + 'and what was approved or held back on each line, so you can see how the project stood before this draw.'
      : (drawNo ? 'Earlier draws on this project were inspected elsewhere; tell us if you would like the previous inspection report and we will attach it.' : ''),
    'Each budget line carries our own reference in the customerKey field — please keep it on the line when you report, so your figures land on the right item in our system.',
    '',
    'Please reply here with any questions.',
  ].filter(Boolean).join('\n').slice(0, 2790);

  return postComment(appId, orderRowId, trinityOrderId, body, { staffId: null, important: false });
}

/** Post a message to Trinity and mirror it into our own thread. */
async function postComment(appId, orderRowId, trinityOrderId, content, { staffId = null, important = false, authorName = 'PILOT' } = {}) {
  const res = await client.addComment(trinityOrderId, {
    content: String(content).slice(0, 2790),
    important: !!important,
    visibleToVendor: true,
    // The address we SIGN WITH is the same constant `ingest.commentIsOurs` recognises on
    // the way back, so our own echo can never be read as a message FROM Trinity.
    commenter: {
      isExternalPerson: false, firstName: 'Draw', lastName: 'Coordinator',
      emailAddress: require('../lib/draw-recipients').DRAW_DESK_INBOX,
    },
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

// ---------------------------------------------------------------------------
// scheduling — "schedule the inspection"
// ---------------------------------------------------------------------------
/** Trinity's own floor: an inspection date must be at least 24 hours out. */
const MIN_LEAD_MS = 24 * 60 * 60 * 1000;

/**
 * Move the inspection date, and/or put the order on rush.
 *
 * Owner-directed 2026-08-14: *"follow up on the status of the inspection, schedule the
 * inspection…"*. `PATCH /api/v1.1/orders/{id}` is how, and it is a PARTIAL patch — a
 * null is read by Trinity as "reset this to its default", not "leave it alone" — so only
 * the fields actually being changed are ever sent.
 *
 * The 24-hour floor is Trinity's, enforced with a clean 400 ("Value cannot be earlier
 * than 24 hours from now."). We check it FIRST and say so in our own words, because a
 * coordinator picking tomorrow morning deserves an answer about the date rather than a
 * validation error out of somebody else's API.
 */
async function reschedule(appId, orderRowId, { dateIso = null, rush = null, staffId = null } = {}) {
  const o = (await db.query(
    `SELECT * FROM trinity_inspection_orders WHERE id=$1 AND application_id=$2`, [orderRowId, appId])).rows[0];
  if (!o) return { skipped: 'not_found' };
  if (!o.trinity_order_id) return { blocked: true, message: 'This inspection has not been ordered from Trinity yet.' };
  if (o.status === 'cancelled') return { blocked: true, message: 'This inspection is cancelled.' };
  if (o.status === 'report_received' || o.status === 'entered') {
    return { blocked: true, message: 'The inspection is already done — there is nothing left to schedule.' };
  }
  if (!client.outboundEnabled() && !client.dryrun()) {
    return { blocked: true, message: 'Trinity writing is switched off.' };
  }

  const patch = { actionBy: { firstName: 'Draw', lastName: 'Coordinator', emailAddress: 'draws@yscapgroup.com' } };
  let when = null;
  if (dateIso != null) {
    when = new Date(dateIso);
    if (Number.isNaN(when.getTime())) return { blocked: true, message: 'That date could not be read.' };
    if (when.getTime() - Date.now() < MIN_LEAD_MS) {
      return { blocked: true, message: 'Trinity needs at least 24 hours’ notice — pick a date from the day after tomorrow onwards.' };
    }
    patch.dateToPerformInspection = when.toISOString();
  }
  if (rush != null) patch.rush = !!rush;
  if (patch.dateToPerformInspection === undefined && patch.rush === undefined) {
    return { skipped: 'nothing_to_change' };
  }

  let res;
  try { res = await client.patchOrder(o.trinity_order_id, patch); }
  catch (e) {
    return { error: true, retryable: !!(e && e.retryable), message: String(e && e.message).slice(0, 300) };
  }
  if (res && res.__dryrun) return { ok: true, dryrun: true, patch };

  await db.query(
    `UPDATE trinity_inspection_orders
        SET inspect_on = COALESCE($2::timestamptz, inspect_on),
            rush = COALESCE($3::boolean, rush),
            reschedule_count = reschedule_count + 1,
            rescheduled_at = now(), rescheduled_by = $4::uuid, updated_at = now()
      WHERE id = $1`,
    [orderRowId, when ? when.toISOString() : null, rush == null ? null : !!rush, staffId]);

  // Tell the Trinity team in words too — a date change they can see on the order is
  // worth more than one buried in an API field.
  const said = [
    when ? `Please perform this inspection on or after ${when.toISOString().slice(0, 10)}.` : '',
    rush === true ? 'This order has been marked RUSH.' : (rush === false ? 'The rush flag on this order has been removed.' : ''),
  ].filter(Boolean).join(' ');
  if (said) await postComment(appId, orderRowId, o.trinity_order_id, said, { staffId, important: !!rush }).catch(() => {});

  return { ok: true, inspectOn: when ? when.toISOString() : null, rush: rush == null ? !!o.rush : !!rush };
}

// ---------------------------------------------------------------------------
// project sync — keeping their picture of the property current
// ---------------------------------------------------------------------------
/**
 * Push the current property/appraisal/borrower/contractor picture onto the Trinity
 * PROJECT, without placing an order (`PATCH /api/v1.1/projects/{id}`).
 *
 * Creating an order already refreshes all of this, so what this is FOR is the thing that
 * changes between draws and that an inspector needs before the next visit — above all a
 * LOCK BOX CODE, which is the difference between getting inside and a wasted trip.
 *
 * PARTIAL PATCH DISCIPLINE: Trinity reads a null as "set this to its default", so a
 * field we do not have is OMITTED, never sent as null. Sending our whole object with
 * blanks in it would quietly erase the borrower's phone number on their side.
 */
async function syncProject(appId, orderRowId, { staffId = null } = {}) {
  const o = (await db.query(
    `SELECT * FROM trinity_inspection_orders WHERE id=$1 AND application_id=$2`, [orderRowId, appId])).rows[0];
  if (!o) return { skipped: 'not_found' };
  if (!o.trinity_project_id) return { skipped: 'no_project' };
  if (!client.outboundEnabled() && !client.dryrun()) return { skipped: 'outbound_off' };

  const ctx = await fileContext(appId);
  const lock = (await db.query(
    `SELECT lock_box_code FROM applications WHERE id=$1`, [appId])).rows[0] || {};

  const property = {
    address: {
      street: ctx.address.street, city: ctx.address.city, state: ctx.address.state,
      zipCode: ctx.address.zip,
      ...(ctx.address.county ? { county: ctx.address.county } : {}),
    },
    type: /commercial|mixed/i.test(String(ctx.app.property_type || '')) ? 'Commercial' : 'Residential',
    ...(lock.lock_box_code ? { lockBoxCode: String(lock.lock_box_code).slice(0, 50) } : {}),
    ...(ctx.appraisal && ctx.appraisal.valueCents
      ? { appraisal: {
        value: Math.round(ctx.appraisal.valueCents) / 100,
        ...(ctx.appraisal.datePerformed ? { datePerformed: ctx.appraisal.datePerformed } : {}),
        ...(ctx.appraisal.performedBy ? { performedBy: String(ctx.appraisal.performedBy).slice(0, 100) } : {}),
      } }
      : {}),
  };
  if (!property.address.street || !property.address.city || !property.address.state || !property.address.zipCode) {
    return { skipped: 'incomplete_address' };
  }

  const patch = {
    property,
    actionBy: { firstName: 'Draw', lastName: 'Coordinator', emailAddress: 'draws@yscapgroup.com' },
  };
  if (ctx.app.loan_amount != null) patch.totalProjectCost = Math.round(Number(ctx.app.loan_amount) * 100) / 100;

  let res;
  try { res = await client.patchProject(o.trinity_project_id, patch); }
  catch (e) { return { error: true, message: String(e && e.message).slice(0, 300) }; }
  if (res && res.__dryrun) return { ok: true, dryrun: true, patch };

  await db.query(
    `UPDATE trinity_inspection_orders SET project_synced_at=now(), updated_at=now() WHERE id=$1`, [orderRowId]).catch(() => {});
  return { ok: true, lockBoxSent: !!lock.lock_box_code };
}

module.exports = {
  DOC_GROUP, MAX_DOC_BYTES, MIN_LEAD_MS, budgetLines, fileContext, placeOrder, sendDocuments, postComment,
  budgetWorkbook, openingComment, reschedule, syncProject, recordEvent, verifyBudget,
};
