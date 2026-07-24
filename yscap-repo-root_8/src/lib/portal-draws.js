'use strict';
/**
 * PORTAL draw requests (phase 4 — blueprint §2 Path B/C, §5B). A draw cycle that starts
 * on OUR website (staff line-item composer, or the borrower's) on a PHYSICAL-inspection
 * file. There is no Sitewire create-a-live-draw API, so:
 *   trustpoint file → the coordinator hand-enters it into TrustPoint (workflow task +
 *     desk email, same machinery as the Sitewire-intake path); once the TrustPoint draw
 *     is FULLY APPROVED it is closed out into Sitewire as a HISTORICAL draw (owner rule:
 *     historical only for portal-originated draws, only after approval).
 *   trinity file (general physical program, non-Blue-Lake) → a Trinity inspection-order
 *     record + coordinator task (manual ordering now; API-adapter-ready — D8).
 *
 * Gates (never-guess, all surfaced as typed errors): funded file, physical (traditional)
 * method, a live per-line budget ledger (the Sitewire setup), amounts within each line's
 * remaining (staff may override with allow_over), one open portal request per file, and
 * no open Sitewire draw in flight (dual-door dedupe — staff override allowed).
 */

const db = require('../db');
const workflow = require('./workflow');
const notify = require('./notify');
const routing = require('../sitewire/routing');

const usd = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const err = (status, message) => { const e = new Error(message); e.status = status; return e; };

/** The composer's pickable lines with live remaining, from the unified rollup. */
async function composerLines(appId) {
  const rollup = require('../sitewire/rollup');
  const r = await rollup.loadRollup(db, appId).catch(() => null);
  const lines = [];
  for (const ln of ((r && r.lines) || [])) {
    if (String(ln.sow_line_key || '').indexOf('__media__') === 0) continue;
    // per-line ledger ids for this SOW line (the exploded crosswalk rows)
    const ids = (await db.query(
      `SELECT sitewire_job_item_id, name, budgeted_cents FROM sitewire_job_item_links
        WHERE application_id=$1 AND sow_line_key=$2 AND sitewire_job_item_id IS NOT NULL
          AND is_media_item=false AND (state IS NULL OR state<>'deleted') ORDER BY unit_index NULLS FIRST`, [appId, ln.sow_line_key])).rows;
    for (const row of ids) {
      lines.push({
        sitewire_job_item_id: Number(row.sitewire_job_item_id),
        sow_line_key: ln.sow_line_key,
        name: row.name,
        budgeted_cents: Number(row.budgeted_cents || 0),
      });
    }
  }
  // remaining per JOB ITEM = budgeted − approved-to-date on that item (mirror-side sums)
  const appr = (await db.query(
    `SELECT r.sitewire_job_item_id AS jid, COALESCE(SUM(COALESCE(r.approved_cents,0)),0)::bigint AS appr
       FROM sitewire_draw_requests r JOIN sitewire_draws d ON d.sitewire_draw_id=r.sitewire_draw_id
      WHERE d.application_id=$1 AND d.status='approved'
      GROUP BY r.sitewire_job_item_id`, [appId])).rows;
  const apprBy = new Map(appr.map((a) => [Number(a.jid), Number(a.appr)]));
  for (const l of lines) l.remaining_cents = Math.max(0, l.budgeted_cents - (apprBy.get(l.sitewire_job_item_id) || 0));
  return lines;
}

/** Eligibility for the composer: platform + method + setup + dedupe state. */
async function composerState(appId) {
  const a = (await db.query(`SELECT status FROM applications WHERE id=$1 AND deleted_at IS NULL`, [appId])).rows[0];
  if (!a) return { eligible: false, reason: 'not_found' };
  const rp = await routing.resolveFilePlatform(appId);
  // The composer exists only for physical-inspection files PILOT actually runs:
  // 'external' files are handled entirely in the partner's own system — no composer.
  const physical = rp.method === 'traditional' && rp.platform !== 'external';
  const platform = rp.platform === 'trustpoint' ? 'trustpoint' : 'trinity';
  const setUp = (await db.query(
    `SELECT 1 FROM sitewire_job_item_links WHERE application_id=$1 AND sitewire_job_item_id IS NOT NULL LIMIT 1`, [appId])).rows.length > 0;
  const openPortal = (await db.query(
    `SELECT id, status, source, total_requested_cents FROM portal_draw_requests
      WHERE application_id=$1 AND status IN ('submitted','entered','approved') ORDER BY created_at DESC LIMIT 1`, [appId])).rows[0] || null;
  const openSitewire = (await db.query(
    `SELECT sitewire_draw_id, number, status FROM sitewire_draws
      WHERE application_id=$1 AND COALESCE(historical,false)=false
        AND status IN ('drafting','pending_borrower','inspecting','pending','pending_capital_partner') LIMIT 1`, [appId])).rows[0] || null;
  return {
    eligible: a.status === 'funded' && physical && setUp && !openPortal,
    funded: a.status === 'funded', physical, platform, set_up: setUp,
    open_portal_request: openPortal, open_sitewire_draw: openSitewire,
  };
}

/**
 * Create a portal draw request + route it (coordinator task + desk email).
 * @param entries [{sitewire_job_item_id, requested_cents}]
 * @param opts { source: 'staff'|'borrower', staffId?, borrowerId?, allowOver?, allowParallel?, note? }
 */
async function createRequest(appId, entries, opts = {}) {
  const st = await composerState(appId);
  if (!st.funded) throw err(409, 'Draws can be requested once the loan is funded.');
  if (!st.physical) throw err(422, 'This file is not on the physical-inspection draw program.');
  if (!st.set_up) throw err(422, 'The draw setup has not finished yet — the budget lines are not ready.');
  if (st.open_portal_request) throw err(409, 'A draw request from the portal is already in progress on this file.');
  if (st.open_sitewire_draw && !(opts.source === 'staff' && opts.allowParallel)) {
    throw err(409, opts.source === 'staff'
      ? 'A draw is already open in Sitewire for this file. Finish or cancel it first (or pass allowParallel to proceed deliberately).'
      : 'A draw is already in progress on this property — your team is on it.');
  }
  if (!Array.isArray(entries) || !entries.length) throw err(400, 'Pick at least one line and amount.');

  const lines = await composerLines(appId);
  const byId = new Map(lines.map((l) => [l.sitewire_job_item_id, l]));
  const picked = [];
  let total = 0;
  for (const e0 of entries) {
    const jid = Number(e0.sitewire_job_item_id);
    const cents = Math.round(Number(e0.requested_cents));
    if (!byId.has(jid)) throw err(422, 'One of the picked lines is not on this file\'s budget.');
    if (!Number.isFinite(cents) || cents <= 0) continue;   // zero/blank rows are just unpicked
    const l = byId.get(jid);
    if (cents > l.remaining_cents && !(opts.source === 'staff' && opts.allowOver)) {
      throw err(422, `"${l.name}" only has ${usd(l.remaining_cents)} left — ${usd(cents)} was requested.`);
    }
    picked.push({ sitewire_job_item_id: jid, sow_line_key: l.sow_line_key, name: l.name, requested_cents: cents });
    total += cents;
  }
  if (!picked.length || total <= 0) throw err(400, 'Pick at least one line and amount.');

  let row;
  try {
    row = (await db.query(
      `INSERT INTO portal_draw_requests (application_id, source, platform, lines, total_requested_cents, note, created_by_staff, created_by_borrower)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8) RETURNING *`,
      [appId, opts.source === 'staff' ? 'staff' : 'borrower', st.platform, JSON.stringify(picked), total,
       opts.note ? String(opts.note).slice(0, 500) : null, opts.staffId || null, opts.borrowerId || null])).rows[0];
  } catch (e) {
    if (e && e.code === '23505') throw err(409, 'A draw request from the portal is already in progress on this file.');
    throw e;
  }

  // ---- route: the coordinator hand-off + desk email ----
  const addr = (await db.query(`SELECT ys_loan_number, property_address->>'oneLine' AS addr FROM applications WHERE id=$1`, [appId])).rows[0] || {};
  let toStaffId = null;
  try {
    const coords = await workflow.candidatesForRole('draw_coordinator');
    if (coords.length === 1) toStaffId = coords[0].id;
  } catch (_) {}
  const lineNote = picked.slice(0, 12).map((l) => `${l.name}: ${usd(l.requested_cents)}`).join(' · ');
  const isTp = st.platform === 'trustpoint';
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await workflow.submitItem(client, {
      appId, submissionType: isTp ? 'trustpoint_import' : 'trinity_inspection_order',
      fromStaffId: opts.staffId || null, toStaffId, toRole: 'draw_coordinator', priority: 1, auto: true,
      note: (isTp
        ? `Portal draw request #${row.id} (${usd(total)}) needs to be entered into TrustPoint as a REGULAR workflow draw. ${lineNote}`
        : `Portal draw request #${row.id} (${usd(total)}) — order the physical inspection from Trinity, then record the findings. ${lineNote}`).slice(0, 1000),
    });
    if (!isTp) {
      await client.query(
        `INSERT INTO trinity_inspection_orders (application_id, portal_draw_request_id, note)
         VALUES ($1,$2,$3)`, [appId, row.id, `Draw ${usd(total)} across ${picked.length} line(s)`]);
    }
    await client.query('COMMIT');
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} throw e; }
  finally { client.release(); }

  const notifyOpts = {
    type: 'trustpoint_import',
    title: isTp ? `A portal draw needs to be entered into TrustPoint` : `A portal draw needs a Trinity inspection ordered`,
    body: `${opts.source === 'staff' ? 'A team member' : 'The borrower'} requested a draw of ${usd(total)} on ${addr.addr || 'the property'} from the portal. `
      + (isTp ? 'Enter it in TrustPoint as a REGULAR workflow draw — the line-by-line amounts are in your Workflow item.'
              : 'Order the physical inspection from Trinity, then record the findings when the report comes back.'),
    badge: { text: isTp ? 'Enter in TrustPoint' : 'Order inspection', tone: 'gold' },
    applicationId: appId, link: '/internal/workflow', ctaLabel: 'Open my Workflow',
  };
  try {
    if (toStaffId) await notify.notifyStaff(toStaffId, notifyOpts);
    else await notify.notifyAppStaff(appId, notifyOpts);
  } catch (_) {}
  try {
    const mail = require('./email/catalog');
    const { fileReplyTo } = require('./file-address');
    await mail.deliver(
      mail.trustpointImport({
        drawNumber: `P${row.id}`, propertyLabel: addr.addr || null, loanNumber: addr.ys_loan_number || null,
        lines: picked.map((l) => ({ name: l.name, requested_cents: l.requested_cents })), totalCents: total,
      }),
      ['draws@yscapgroup.com'], { replyTo: fileReplyTo(appId), applicationId: appId, type: 'trustpoint_import', audience: 'staff' });
  } catch (_) {}
  // Borrower confirmation (their own submission — a receipt, not marketing).
  if (opts.source === 'borrower') {
    await notify.notifyAppBorrowers(appId, {
      type: 'draw', title: 'Your draw request was received',
      body: `We received your draw request for ${usd(total)} on ${addr.addr || 'your property'}. The inspection and review are next — we'll keep you posted at every step.`,
      applicationId: appId, link: `/app/${appId}`,
    }).catch(() => {});
  }
  return row;
}

/**
 * HISTORICAL CLOSE-OUT (§5B): after the TrustPoint draw tied to a portal request is
 * fully approved (per-line amounts on file), create the draw in Sitewire as HISTORICAL
 * (+ approve) so the per-line ledger and budget rollups stay whole. Cent-exact hard
 * gate; single-flight via the status flip; park-on-failure. Never for a request tied
 * to a live Sitewire draw (that path is the live write-back).
 */
async function historicalCloseOut(appId, portalRequestId) {
  const swClient = require('../sitewire/client');
  const orchestrator = require('../sitewire/orchestrator');
  const switches = require('./integrations/switches');
  const cfg = require('../config');
  const pr = (await db.query(`SELECT * FROM portal_draw_requests WHERE id=$1 AND application_id=$2`, [portalRequestId, appId])).rows[0];
  if (!pr) return { skipped: 'not_found' };
  if (pr.sitewire_draw_id) return { skipped: 'already_closed_out' };
  if (pr.status !== 'approved') return { skipped: 'not_approved' };
  if (pr.platform !== 'trinity' && !pr.tp_draw_id) return { skipped: 'no_trustpoint_draw' };
  if (!switches.on('SITEWIRE_ENABLED') || (!switches.on('SITEWIRE_OUTBOUND_ENABLED') && !cfg.sitewireDryrun)) return { skipped: 'sitewire_writes_off' };
  const link = (await db.query(`SELECT sitewire_property_id FROM sitewire_property_links WHERE application_id=$1 AND matched_by='created' AND sitewire_property_id IS NOT NULL`, [appId])).rows[0];
  if (!link) return { skipped: 'no_sitewire_property' };

  // The per-line approved amounts: a TrustPoint-administered request reads them from the
  // mirrored crosswalk lines; a Trinity request carries them on its own lines (stamped by
  // the staff approval). Either way the Σ must equal the approved total to the cent.
  const approved = pr.approved_cents != null ? Number(pr.approved_cents) : null;
  if (approved == null) return { skipped: 'no_lines' };
  let lineRows;
  if (pr.tp_draw_id) {
    const tpLines = (await db.query(`SELECT * FROM trustpoint_draw_lines WHERE tp_draw_id=$1`, [pr.tp_draw_id])).rows;
    if (!tpLines.length) return { skipped: 'no_lines' };
    lineRows = tpLines.map((l) => ({ jid: Number(l.sitewire_job_item_id), approved_cents: Number(l.approved_cents) }));
  } else {
    const ls = (Array.isArray(pr.lines) ? pr.lines : []).filter((l) => l && l.approved_cents != null);
    if (!ls.length) return { skipped: 'no_lines' };
    lineRows = ls.map((l) => ({ jid: Number(l.sitewire_job_item_id), approved_cents: Number(l.approved_cents) }));
  }
  const sum = lineRows.reduce((s, l) => s + l.approved_cents, 0);
  if (sum !== approved) return { skipped: 'sum_mismatch' };

  // requested per line from the portal request; every MANDATORY media anchor rides
  // along at $0 (Sitewire refuses a draw without them).
  const reqBy = new Map((Array.isArray(pr.lines) ? pr.lines : []).map((l) => [Number(l.sitewire_job_item_id), Number(l.requested_cents)]));
  const anchors = (await db.query(
    `SELECT sitewire_job_item_id FROM sitewire_job_item_links
      WHERE application_id=$1 AND is_media_item=true AND sitewire_job_item_id IS NOT NULL AND (state IS NULL OR state<>'deleted')`, [appId])).rows;
  const requests = lineRows.map((l) => ({
    job_item_id: l.jid,
    requested_cents: reqBy.get(l.jid) ?? l.approved_cents,
    pending_approved_cents: l.approved_cents,
  }));
  for (const a of anchors) requests.push({ job_item_id: Number(a.sitewire_job_item_id), requested_cents: 0, pending_approved_cents: 0 });

  try {
    await orchestrator.circuitCheck(2);
    const created = await swClient.createHistoricalDraw(link.sitewire_property_id, requests);
    if (created && created.__dryrun) return { ok: true, dryrun: true };
    const drawId = created && created.id;
    if (!drawId) throw new Error('Sitewire returned no draw id');
    await swClient.drawTransition(drawId, 'approve');
    await orchestrator.journal({ appId, entity: 'draw', entityId: Number(drawId), field: 'historical_closeout', newValue: { portal_request: pr.id, approved }, source: 'portal_closeout' }).catch(() => {});
    // status_synced set in lock-step (echo suppression): the reconcile must treat this
    // brand-new approved draw as already-announced — PILOT told everyone at each step.
    await db.query(
      `INSERT INTO sitewire_draws (application_id, sitewire_draw_id, sitewire_property_id, number, status, status_synced, historical, total_requested_cents, total_approved_cents, tp_import_task_opened_at)
       VALUES ($1,$2,$3,$4,'approved','approved',true,$5,$6,now())
       ON CONFLICT (sitewire_draw_id) DO UPDATE SET status='approved', status_synced='approved', historical=true, total_approved_cents=EXCLUDED.total_approved_cents, updated_at=now()`,
      [appId, drawId, link.sitewire_property_id, created.number || null, Number(pr.total_requested_cents), approved]);
    await db.query(`UPDATE portal_draw_requests SET status='closed_out', sitewire_draw_id=$2, updated_at=now() WHERE id=$1`, [pr.id, drawId]);
    // The write-back sweep watches for approved-but-unpushed TrustPoint draws; this one's
    // Sitewire record is the historical close-out, so stamp it done here.
    await db.query(
      `UPDATE trustpoint_draws SET writeback_at=now(), writeback_note='closed out into Sitewire as a historical draw', updated_at=now()
        WHERE tp_draw_id=$1 AND application_id=$2 AND writeback_at IS NULL`, [pr.tp_draw_id, appId]).catch(() => {});
    return { ok: true, sitewire_draw_id: drawId };
  } catch (e) {
    try {
      await orchestrator.park({
        appId, dedupe: `pdrclose:${pr.id}`,
        reason: `sitewire_approve_failed: could not close out portal draw request #${pr.id} into Sitewire as a historical draw (${String(e && e.message).slice(0, 160)}). Retry from the draw desk once Sitewire is reachable.`,
      });
    } catch (_) {}
    return { parked: 'error' };
  }
}

/** Tie a mirrored TrustPoint draw to its portal request (amount+time match) + advance status. */
async function tieTrustpointDraw(appId, tpDrawRow) {
  if (!tpDrawRow || tpDrawRow.requested_cents == null) return { tied: false };
  const cand = (await db.query(
    `SELECT id FROM portal_draw_requests
      WHERE application_id=$1 AND platform='trustpoint' AND tp_draw_id IS NULL
        AND status IN ('submitted','entered')
        AND ABS(total_requested_cents - $2) <= 100`, [appId, Number(tpDrawRow.requested_cents)])).rows;
  if (cand.length !== 1) return { tied: false };
  // never tie a draw that is the mirror of a live Sitewire intake (one cycle, one home)
  const claimed = (await db.query(
    `UPDATE trustpoint_draws SET portal_draw_request_id=$2, updated_at=now()
      WHERE tp_draw_id=$1 AND portal_draw_request_id IS NULL AND sitewire_draw_id IS NULL RETURNING tp_draw_id`,
    [tpDrawRow.tp_draw_id, cand[0].id])).rows[0];
  if (!claimed) return { tied: false };
  await db.query(`UPDATE portal_draw_requests SET tp_draw_id=$2, status='entered', updated_at=now() WHERE id=$1 AND tp_draw_id IS NULL`, [cand[0].id, tpDrawRow.tp_draw_id]);
  // The coordinator's hand-entry task is DONE the moment the entered draw mirrors back
  // and ties to the portal request (same auto-complete as the Sitewire-intake tie).
  await db.query(
    `UPDATE workflow_items SET status='returned', outcome_label='Entered in TrustPoint', returned_at=now(), updated_at=now()
      WHERE application_id=$1 AND submission_type='trustpoint_import' AND status IN ('open','in_progress')`, [appId]).catch(() => {});
  await db.query(
    `INSERT INTO workflow_events (workflow_item_id, application_id, event_type, submission_type, outcome_label, note)
     SELECT id, application_id, 'returned', 'trustpoint_import', 'Entered in TrustPoint', 'Auto-completed — the draw appeared in TrustPoint and tied to portal request #' || $2
       FROM workflow_items WHERE application_id=$1 AND submission_type='trustpoint_import' AND outcome_label='Entered in TrustPoint' AND returned_at > now() - interval '1 minute'`,
    [appId, String(cand[0].id)]).catch(() => {});
  return { tied: true, portalRequestId: cand[0].id };
}

/** On a TrustPoint approval of a portal-tied draw: record + attempt the close-out. */
async function onTrustpointApproval(appId, tpDrawRow) {
  const pr = (await db.query(
    `SELECT id FROM portal_draw_requests WHERE application_id=$1 AND tp_draw_id=$2 AND status IN ('submitted','entered','approved')`,
    [appId, tpDrawRow.tp_draw_id])).rows[0];
  if (!pr) return { skipped: 'no_portal_request' };
  await db.query(
    `UPDATE portal_draw_requests SET status=CASE WHEN status='closed_out' THEN status ELSE 'approved' END,
        approved_cents=$2, updated_at=now() WHERE id=$1`, [pr.id, tpDrawRow.approved_cents]);
  return historicalCloseOut(appId, pr.id);
}

/**
 * Cancel an open portal request (staff): frees the one-open-per-file slot, folds the
 * coordinator's live task + any Trinity order into the cancel, and unties a mirrored
 * TrustPoint draw so a later cycle can tie cleanly. A closed-out request is immutable.
 */
async function cancelRequest(appId, portalRequestId, { staffId = null, reason = null } = {}) {
  const pr = (await db.query(`SELECT * FROM portal_draw_requests WHERE id=$1 AND application_id=$2`, [portalRequestId, appId])).rows[0];
  if (!pr) throw err(404, 'request not found');
  if (pr.status === 'closed_out') throw err(409, 'This request already closed out into Sitewire — it can no longer be cancelled.');
  if (pr.status === 'cancelled') return pr;
  const row = (await db.query(
    `UPDATE portal_draw_requests SET status='cancelled', cancelled_reason=$3, updated_at=now()
      WHERE id=$1 AND application_id=$2 AND status<>'closed_out' RETURNING *`,
    [portalRequestId, appId, reason ? String(reason).slice(0, 300) : null])).rows[0];
  if (!row) throw err(409, 'This request just changed — reload and try again.');
  const type = pr.platform === 'trustpoint' ? 'trustpoint_import' : 'trinity_inspection_order';
  const live = (await db.query(
    `SELECT id FROM workflow_items WHERE application_id=$1 AND submission_type=$2 AND status IN ('open','in_progress')`, [appId, type])).rows;
  for (const it of live) {
    await db.query(`UPDATE workflow_items SET status='cancelled', updated_at=now() WHERE id=$1`, [it.id]).catch(() => {});
    await db.query(
      `INSERT INTO workflow_events (workflow_item_id, application_id, event_type, submission_type, note)
       VALUES ($1,$2,'cancelled',$3,$4)`,
      [it.id, appId, type, `Portal draw request #${pr.id} was cancelled${reason ? ` — ${String(reason).slice(0, 200)}` : ''}.`]).catch(() => {});
  }
  await db.query(
    `UPDATE trinity_inspection_orders SET status='cancelled', updated_at=now()
      WHERE portal_draw_request_id=$1 AND status IN ('requested','ordered','report_received')`, [pr.id]).catch(() => {});
  // A mirrored TrustPoint draw pointing at this request goes back to being a plain
  // administered draw (it may still be real in TrustPoint) — never left aimed at a
  // cancelled request where an approval would go nowhere.
  await db.query(
    `UPDATE trustpoint_draws SET portal_draw_request_id=NULL, updated_at=now()
      WHERE application_id=$1 AND portal_draw_request_id=$2 AND writeback_at IS NULL`, [appId, pr.id]).catch(() => {});
  if (pr.source === 'borrower') {
    await notify.notifyAppBorrowers(appId, {
      type: 'draw', title: 'Your draw request was cancelled',
      body: `Your draw request for ${usd(pr.total_requested_cents)} was cancelled by your loan team${reason ? `: ${String(reason).slice(0, 200)}` : ''}. You can submit a new request whenever you're ready — or reply to this email with any questions.`,
      applicationId: appId, link: `/app/${appId}`,
    }).catch(() => {});
  }
  return row;
}

// Trinity order lifecycle — the future ordering API replaces ONLY requested→ordered (D8).
const TRINITY_NEXT = {
  requested: ['ordered', 'cancelled'],
  ordered: ['report_received', 'cancelled'],
  report_received: ['entered', 'cancelled'],
  entered: [], cancelled: [],
};

/** Advance a Trinity inspection order (desk action; validated transitions only). */
async function advanceTrinityOrder(appId, orderId, action, { staffId = null, note = null } = {}) {
  const o = (await db.query(`SELECT * FROM trinity_inspection_orders WHERE id=$1 AND application_id=$2`, [orderId, appId])).rows[0];
  if (!o) throw err(404, 'order not found');
  const allowed = TRINITY_NEXT[o.status] || [];
  if (!allowed.includes(action)) {
    throw err(409, `This order is "${String(o.status).replace(/_/g, ' ')}" — from here it can only move to: ${allowed.map((s) => s.replace(/_/g, ' ')).join(', ') || 'nowhere'}.`);
  }
  const row = (await db.query(
    `UPDATE trinity_inspection_orders SET status=$3,
        ordered_at=CASE WHEN $3='ordered' THEN now() ELSE ordered_at END,
        ordered_by=CASE WHEN $3='ordered' THEN $4::uuid ELSE ordered_by END,
        note=CASE WHEN $5::text IS NOT NULL THEN left(COALESCE(note || ' · ', '') || $5::text, 800) ELSE note END,
        updated_at=now()
      WHERE id=$1 AND application_id=$2 AND status=$6 RETURNING *`,
    [orderId, appId, action, staffId, note ? String(note).slice(0, 300) : null, o.status])).rows[0];
  if (!row) throw err(409, 'This order just changed — reload and try again.');
  return row;
}

/**
 * Staff record the Trinity decision: per-line approved amounts (each ≤ its requested —
 * over-approving is a human Sitewire super-admin flow, never done here), Σ = the approved
 * total. Marks the request approved, completes the coordinator task + order, tells the
 * borrower, and attempts the historical close-out.
 */
async function approveTrinityRequest(appId, portalRequestId, entries, { staffId = null } = {}) {
  const pr = (await db.query(`SELECT * FROM portal_draw_requests WHERE id=$1 AND application_id=$2`, [portalRequestId, appId])).rows[0];
  if (!pr) throw err(404, 'request not found');
  if (pr.platform !== 'trinity') throw err(422, 'This request is administered in TrustPoint — its approval mirrors from there automatically.');
  if (pr.status === 'closed_out' || pr.status === 'cancelled') throw err(409, `This request is already ${String(pr.status).replace(/_/g, ' ')}.`);
  if (!Array.isArray(entries) || !entries.length) throw err(400, 'Enter the approved amount for each line.');
  const byId = new Map((Array.isArray(pr.lines) ? pr.lines : []).map((l) => [Number(l.sitewire_job_item_id), { ...l }]));
  const seen = new Set();
  let total = 0;
  for (const e0 of entries) {
    const jid = Number(e0.sitewire_job_item_id);
    const cents = Math.round(Number(e0.approved_cents));
    const l = byId.get(jid);
    if (!l) throw err(422, 'One of the lines is not on this request.');
    if (seen.has(jid)) throw err(422, 'The same line was entered twice.');
    seen.add(jid);
    if (!Number.isFinite(cents) || cents < 0) throw err(400, 'Every approved amount must be zero or more.');
    if (cents > Number(l.requested_cents)) throw err(422, `"${l.name}" can't be approved above the ${usd(l.requested_cents)} that was requested.`);
    l.approved_cents = cents;
    total += cents;
  }
  for (const l of byId.values()) if (l.approved_cents == null) l.approved_cents = 0;  // untouched = $0 (explicit)
  const newLines = [...byId.values()];
  const row = (await db.query(
    `UPDATE portal_draw_requests SET status='approved', approved_cents=$3, lines=$4::jsonb, updated_at=now()
      WHERE id=$1 AND application_id=$2 AND status IN ('submitted','entered','approved') RETURNING *`,
    [portalRequestId, appId, total, JSON.stringify(newLines)])).rows[0];
  if (!row) throw err(409, 'This request just changed — reload and try again.');
  await db.query(
    `UPDATE trinity_inspection_orders SET status='entered', updated_at=now()
      WHERE portal_draw_request_id=$1 AND status IN ('requested','ordered','report_received')`, [pr.id]).catch(() => {});
  await db.query(
    `UPDATE workflow_items SET status='returned', outcome_label='Reviewed', returned_at=now(), updated_at=now()
      WHERE application_id=$1 AND submission_type='trinity_inspection_order' AND status IN ('open','in_progress')`, [appId]).catch(() => {});
  await notify.notifyAppBorrowers(appId, {
    type: 'draw', title: 'Your draw was reviewed',
    body: `Good news — your draw request was reviewed and ${usd(total)} was approved. The release is being processed; we'll confirm when the funds are on the way.`,
    applicationId: appId, link: `/app/${appId}`,
  }).catch(() => {});
  return { request: row, closeout: await historicalCloseOut(appId, pr.id) };
}

module.exports = {
  composerState, composerLines, createRequest, historicalCloseOut, tieTrustpointDraw,
  onTrustpointApproval, cancelRequest, advanceTrinityOrder, approveTrinityRequest, _usd: usd,
};
