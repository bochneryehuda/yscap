'use strict';
/**
 * TrustPoint MIRROR (phase 2 — blueprint §4): hydrate + upsert draws / service orders
 * for LINKED projects, react to genuine inbound transitions (staff notices + the
 * borrower's single-voice milestone emails — D5: PILOT is the only voice, TrustPoint
 * is never named to a borrower), archive the TrustPoint report PDF on approval
 * (staff-only), and drain the webhook inbox.
 *
 * GO-FORWARD discipline (mirrors the Sitewire reconcile): the first sight of a draw
 * BASELINES silently (status_synced claimed with no notification); only transitions
 * that happen while PILOT is watching notify. All reactions are atomic-claim guarded
 * so overlapping webhook drains + polls can never double-notify.
 */

const db = require('../db');
const client = require('./client');
const notify = require('../lib/notify');
const drawLabel = require('../lib/draw-label');   // "Draw 2" — the ONE way a draw is named in a subject

const usd = (c) => c == null ? '—' : '$' + Math.floor(Number(c) / 100).toLocaleString('en-US');
// money-leg amounts keep their cents (a mirrored wire is exact, never floored)
const usd2 = (c) => c == null ? '—' : '$' + (Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const { drawEmailBlocks } = require('../sitewire/draw-email-blocks');

// " #2" for the borrower's SUBJECT LINE (owner-directed 2026-07-27: "in the subject line write
// draw 1 draw 2, how many draw it is"). SUPERSEDED 2026-08-09: the number no longer sits inside
// the title — it LEADS the subject as `drawTag` ("Draw 2 · Your construction draw has been
// released"), built by lib/draw-label so every draw email in the system names a draw the same way.
// The old helper is gone rather than left unused; `drawLabel.drawLabel(row.number)` keeps the same
// never-guess contract (null when the administrator gave the draw no number).

async function audit(appId, tpDrawId, entity, entityId, field, oldV, newV, reacted) {
  try {
    await db.query(
      `INSERT INTO trustpoint_pull_field_change (application_id, tp_draw_id, entity, entity_id, field, old_value, new_value, reacted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [appId, tpDrawId || null, entity, entityId || null, field, oldV == null ? null : String(oldV).slice(0, 500), newV == null ? null : String(newV).slice(0, 500), !!reacted]);
  } catch (_) { /* best-effort audit */ }
}

/** The linked file for a TrustPoint project (null when unlinked/unknown/soft-deleted). */
async function linkFor(tpProjectId) {
  const r = await db.query(
    `SELECT l.application_id, l.baselined_at FROM trustpoint_project_links l
       JOIN applications a ON a.id = l.application_id AND a.deleted_at IS NULL
      WHERE l.tp_project_id=$1 AND l.application_id IS NOT NULL`, [tpProjectId]);
  return r.rows[0] || null;
}
async function linkedAppFor(tpProjectId) {
  const l = await linkFor(tpProjectId);
  return l ? l.application_id : null;
}

// ---- draw upsert (aggregate mirror) ----
const C = client.centsFromTp;
function drawRow(d) {
  return {
    number: d.number != null && Number.isFinite(Number(d.number)) ? Number(d.number) : null,
    name: d.name || d.draw_name || null,
    status: d.status || null,
    draw_type: d.type || null,
    requested_cents: C(d.requested_amount ?? d.amount_requested),
    approved_cents: C(d.approved_amount ?? d.amount_approved),
    disbursed_cents: C(d.disbursed_amount ?? d.amount_disbursed),
    to_disburse_cents: C(d.amount_to_disburse),
    holdback_cents: C(d.construction_holdback),
    borrower_equity_cents: C(d.borrower_equity),
    fees: Array.isArray(d.fees) ? JSON.stringify(d.fees) : null,
    // NULL (not an all-null object) when the payload carried none of the fields, so the
    // upsert's COALESCE protects previously-hydrated detail from thin webhook payloads
    // (phase-2 audit #2 — TrustPoint is the retainage SOR, never wipe the mirror).
    retainage: [d.retainage_release_requested, d.retainage_release_approved, d.retainage_requested_amount_holdback, d.retainage_approved_amount_holdback].some((v) => v !== undefined)
      ? JSON.stringify({
          release_requested: d.retainage_release_requested ?? null,
          release_approved: d.retainage_release_approved ?? null,
          requested_amount_holdback: d.retainage_requested_amount_holdback ?? null,
          approved_amount_holdback: d.retainage_approved_amount_holdback ?? null,
        }) : null,
    contingency: [d.contingency_total, d.contingency_used, d.contingency_used_rate].some((v) => v !== undefined)
      ? JSON.stringify({ total: d.contingency_total ?? null, used: d.contingency_used ?? null, used_rate: d.contingency_used_rate ?? null }) : null,
    inspector_allowance_rate: d.inspector_allowance_rate != null && Number.isFinite(Number(d.inspector_allowance_rate)) ? Number(d.inspector_allowance_rate) : null,
    inspector_recommendation_rate: d.inspector_recommendation_rate != null && Number.isFinite(Number(d.inspector_recommendation_rate)) ? Number(d.inspector_recommendation_rate) : null,
    lender_allowance_rate: d.lender_allowance_rate != null && Number.isFinite(Number(d.lender_allowance_rate)) ? Number(d.lender_allowance_rate) : null,
    coordinator_name: d.coordinator && (d.coordinator.name || require('../lib/person-name').displayName(d.coordinator)) || null,
    submitted_at: d.submitted_at || null, approved_at: d.approved_at || null,
    completed_at: d.completed_at || null, disbursed_at: d.disbursed_at || null,
    tp_created_at: d.created_at || null,
    estimated_reimbursement_date: d.estimated_reimbursement_date || null,
  };
}

/**
 * Upsert a draw's aggregate mirror row. `detail` is a REST detail object when available,
 * else the thinner webhook payload (COALESCE keeps prior detail-only values). Returns
 * { prev, row } — prev is the pre-upsert mirror state (for the reaction).
 */
async function upsertDraw(appId, tpProjectId, tpDrawId, detail) {
  const prev = (await db.query(`SELECT status, status_synced, approved_cents, disbursed_at FROM trustpoint_draws WHERE tp_draw_id=$1`, [tpDrawId])).rows[0] || null;
  const v = drawRow(detail || {});
  const r = await db.query(
    `INSERT INTO trustpoint_draws (application_id, tp_project_id, tp_draw_id, number, name, status, draw_type,
        requested_cents, approved_cents, disbursed_cents, to_disburse_cents, holdback_cents, borrower_equity_cents,
        fees, retainage, contingency, inspector_allowance_rate, inspector_recommendation_rate, lender_allowance_rate,
        coordinator_name, submitted_at, approved_at, completed_at, disbursed_at, tp_created_at,
        estimated_reimbursement_date, raw, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16::jsonb,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27::jsonb,now())
     ON CONFLICT (tp_draw_id) DO UPDATE SET
        application_id=EXCLUDED.application_id, tp_project_id=EXCLUDED.tp_project_id,
        status=COALESCE(EXCLUDED.status, trustpoint_draws.status),
        number=COALESCE(EXCLUDED.number, trustpoint_draws.number),
        name=COALESCE(EXCLUDED.name, trustpoint_draws.name),
        draw_type=COALESCE(EXCLUDED.draw_type, trustpoint_draws.draw_type),
        requested_cents=COALESCE(EXCLUDED.requested_cents, trustpoint_draws.requested_cents),
        approved_cents=COALESCE(EXCLUDED.approved_cents, trustpoint_draws.approved_cents),
        disbursed_cents=COALESCE(EXCLUDED.disbursed_cents, trustpoint_draws.disbursed_cents),
        to_disburse_cents=COALESCE(EXCLUDED.to_disburse_cents, trustpoint_draws.to_disburse_cents),
        holdback_cents=COALESCE(EXCLUDED.holdback_cents, trustpoint_draws.holdback_cents),
        borrower_equity_cents=COALESCE(EXCLUDED.borrower_equity_cents, trustpoint_draws.borrower_equity_cents),
        fees=COALESCE(EXCLUDED.fees, trustpoint_draws.fees),
        retainage=COALESCE(EXCLUDED.retainage, trustpoint_draws.retainage),
        contingency=COALESCE(EXCLUDED.contingency, trustpoint_draws.contingency),
        inspector_allowance_rate=COALESCE(EXCLUDED.inspector_allowance_rate, trustpoint_draws.inspector_allowance_rate),
        inspector_recommendation_rate=COALESCE(EXCLUDED.inspector_recommendation_rate, trustpoint_draws.inspector_recommendation_rate),
        lender_allowance_rate=COALESCE(EXCLUDED.lender_allowance_rate, trustpoint_draws.lender_allowance_rate),
        coordinator_name=COALESCE(EXCLUDED.coordinator_name, trustpoint_draws.coordinator_name),
        submitted_at=COALESCE(EXCLUDED.submitted_at, trustpoint_draws.submitted_at),
        approved_at=COALESCE(EXCLUDED.approved_at, trustpoint_draws.approved_at),
        completed_at=COALESCE(EXCLUDED.completed_at, trustpoint_draws.completed_at),
        disbursed_at=COALESCE(EXCLUDED.disbursed_at, trustpoint_draws.disbursed_at),
        estimated_reimbursement_date=COALESCE(EXCLUDED.estimated_reimbursement_date, trustpoint_draws.estimated_reimbursement_date),
        raw=COALESCE(EXCLUDED.raw, trustpoint_draws.raw),
        updated_at=now()
     RETURNING *`,
    [appId, tpProjectId, tpDrawId, v.number, v.name, v.status, v.draw_type,
     v.requested_cents, v.approved_cents, v.disbursed_cents, v.to_disburse_cents, v.holdback_cents, v.borrower_equity_cents,
     v.fees, v.retainage, v.contingency, v.inspector_allowance_rate, v.inspector_recommendation_rate, v.lender_allowance_rate,
     v.coordinator_name, v.submitted_at, v.approved_at, v.completed_at, v.disbursed_at, v.tp_created_at,
     v.estimated_reimbursement_date, detail ? ((x) => x.length > 100000 ? null : x)(JSON.stringify(detail)) : null]);
  return { prev, row: r.rows[0] };
}

// Best-effort tie to the Sitewire intake draw (same file, open, ~same requested total).
// Phase 3's coordinator UI confirms/corrects; never used for money on its own.
async function linkToSitewireIntake(appId, tpDrawRow) {
  try {
    if (!tpDrawRow || tpDrawRow.requested_cents == null) return;
    let swTied = !!tpDrawRow.sitewire_draw_id;
    if (!swTied) {
      const cand = (await db.query(
        `SELECT sitewire_draw_id FROM sitewire_draws
          WHERE application_id=$1 AND COALESCE(historical,false)=false
            AND status IN ('inspecting','pending','pending_capital_partner')
            AND ABS(COALESCE(total_requested_cents,0) - $2) <= 100
            -- a Sitewire draw already claimed by ANOTHER administered draw is off the
            -- table (audit-5 #3: a double-pointed draw silently loses the second
            -- draw's money mirror) — db/302's unique index is the backstop
            AND NOT EXISTS (SELECT 1 FROM trustpoint_draws t2 WHERE t2.sitewire_draw_id = sitewire_draws.sitewire_draw_id)`,
        [appId, tpDrawRow.requested_cents])).rows;
      if (cand.length === 1) {
        // one draw = ONE cycle both ways (audit-4 #2): a portal-tied draw must never
        // ALSO tie to a live intake — that would run the live write-back AND the
        // historical close-out on the same money.
        const tied = (await db.query(`UPDATE trustpoint_draws SET sitewire_draw_id=$2, updated_at=now() WHERE tp_draw_id=$1 AND sitewire_draw_id IS NULL AND portal_draw_request_id IS NULL RETURNING tp_draw_id`, [tpDrawRow.tp_draw_id, cand[0].sitewire_draw_id])).rows[0];
        // The coordinator's entry task is DONE the moment the entered draw mirrors back and
        // ties to its intake (blueprint §3 auto-complete; audit #13). Recorded as a returned
        // hand-off with the standard outcome, so the SLA nag stops and history reads right.
        if (tied) {
          swTied = true;
          await db.query(
            `UPDATE workflow_items SET status='returned', outcome_label='Entered in TrustPoint', returned_at=now(), updated_at=now()
              WHERE application_id=$1 AND submission_type='trustpoint_import' AND status IN ('open','in_progress')`, [appId]).catch(() => {});
          await db.query(
            `INSERT INTO workflow_events (workflow_item_id, application_id, event_type, submission_type, outcome_label, note)
             SELECT id, application_id, 'returned', 'trustpoint_import', 'Entered in TrustPoint', 'Auto-completed — the draw appeared in TrustPoint and tied to this file.'
               FROM workflow_items WHERE application_id=$1 AND submission_type='trustpoint_import' AND outcome_label='Entered in TrustPoint' AND returned_at > now() - interval '1 minute'`, [appId]).catch(() => {});
        }
      }
    }
    // A portal-originated draw ties to its portal request the same way (phase 4) —
    // but ONLY when the draw is not the mirror of a live Sitewire intake (a TrustPoint
    // draw is one cycle: it belongs to the intake OR to a portal request, never both).
    if (!swTied) {
      try { await require('../lib/portal-draws').tieTrustpointDraw(appId, tpDrawRow); } catch (_) {}
    }
  } catch (_) { /* suggestion only */ }
}

// SSRF-guarded, HOST-PINNED download of a TrustPoint document URL. Reuses the
// media-archive public-https/private-ip guard on every hop; additionally the FIRST
// url must live on the TrustPoint base host (a hostile URL in a payload can never
// point PILOT's fetch elsewhere). Sends the Api-Key — the spec doesn't say whether
// document file URLs are pre-signed or key-authenticated (sandbox item Q-C), and the
// header is harmless on a pre-signed URL. 20s cap, 25MB cap.
// TrustPoint serves document BYTES from its S3 evidence bucket, not from the API host —
// e.g. https://tp-backend-evidence-prod-us-west-2.s3.amazonaws.com/media/private/documents/…
// The original pin accepted ONLY the API host, so EVERY report download threw before it
// began ("report url host … is not the TrustPoint host") and was swallowed by the
// best-effort catch — no inspection report has ever actually been archived to a file
// (owner-reported 2026-07-27: the reports are not on the draws). Verified against the live
// /report/ response. The allow-list stays tight and explicit: the API host, or TrustPoint's
// own evidence bucket. Every hop is still re-checked by assertPublicHttps/isPrivateIp, and
// the Api-Key is sent ONLY to the API host (a pre-signed S3 URL carries its own auth and
// must never receive our key).
// S3 bucket names are GLOBALLY unique but an unclaimed one is registrable by anyone, so a `tp-*`
// prefix is not proof of TrustPoint — `tp-evil.s3.us-east-1.amazonaws.com` would have passed.
// Pinned to the bucket TrustPoint actually serves from (verified live on the /report/ response:
// tp-backend-evidence-prod-us-west-2), with the region/stage segment left open so a regional
// failover or a sandbox bucket still downloads. `TRUSTPOINT_DOC_HOSTS` (comma-separated exact
// hosts) is the escape hatch if they ever move, so this never needs loosening under pressure.
function isTrustpointDocHost(host, apiHost) {
  if (!host) return false;
  if (host === apiHost) return true;
  const extra = String(process.env.TRUSTPOINT_DOC_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (extra.includes(String(host).toLowerCase())) return true;
  // The `.amazonaws.com` suffix is LITERAL and dot-anchored. An earlier form wrote
  // `[a-z0-9-]*\.?amazonaws\.com`, whose OPTIONAL dot let the character class run straight
  // into the suffix — so `tp-backend-evidence-x.s3.notamazonaws.com` and
  // `…s3-evilamazonaws.com` (ordinary registrable domains) both passed and the pin did not
  // keep the fetch inside AWS at all.
  return /^tp-backend-evidence-[a-z0-9-]+\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(host);
}

async function fetchReportBytes(fileUrl) {
  const cfg = require('../config');
  const media = require('../sitewire/media-archive');
  const baseHost = new URL(cfg.trustpointBaseUrl).host;
  const u = new URL(fileUrl);
  if (!isTrustpointDocHost(u.host, baseHost)) throw new Error(`report url host ${u.host} is not a TrustPoint document host`);
  await media.assertPublicHttps(fileUrl);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20000);
  try {
    let current = fileUrl;
    for (let hop = 0; hop <= 3; hop++) {
      await media.assertPublicHttps(current);
      const hop_ = new URL(current).host;
      if (!isTrustpointDocHost(hop_, baseHost)) throw new Error(`redirect left the TrustPoint document hosts (${hop_})`);
      // the API key goes to the API host ONLY — never appended to a pre-signed S3 URL
      const r = await fetch(current, { signal: ac.signal, redirect: 'manual', headers: hop_ === baseHost ? { Authorization: `Api-Key ${cfg.trustpointApiKey}` } : {} });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');
        if (!loc) throw new Error(`redirect ${r.status} with no location`);
        current = new URL(loc, current).href;
        continue;
      }
      if (!r.ok) throw new Error(`report fetch ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 25 * 1024 * 1024) throw new Error('report exceeds the 25MB cap');
      return buf;
    }
    throw new Error('too many redirects');
  } finally { clearTimeout(t); }
}

// ---- the TrustPoint report PDF → staff-only documents row (idempotent per draw+version) ----
async function archiveReport(appId, tpProjectId, tpDrawId) {
  try {
    const meta = await client.getDrawReport(tpProjectId, tpDrawId);
    const fileUrl = meta && meta.file;
    if (!fileUrl) return { archived: false, reason: 'no_report' };
    const already = (await db.query(
      `SELECT report_document_id FROM trustpoint_draws WHERE tp_draw_id=$1`, [tpDrawId])).rows[0];
    // idempotent by TrustPoint's own document id in the stored filename
    const docTag = String(meta.id || '').slice(0, 24) || 'latest';
    const filename = `trustpoint-draw-report-${tpDrawId.slice(0, 8)}-${docTag}.pdf`;
    const dup = (await db.query(
      `SELECT id FROM documents WHERE application_id=$1 AND filename=$2 AND is_current`, [appId, filename])).rows[0];
    if (dup) {
      if (!already || !already.report_document_id) await db.query(`UPDATE trustpoint_draws SET report_document_id=$2 WHERE tp_draw_id=$1`, [tpDrawId, dup.id]);
      return { archived: false, reason: 'already_archived', documentId: dup.id };
    }
    const bytes = await fetchReportBytes(fileUrl);
    if (!bytes || !bytes.length) return { archived: false, reason: 'empty' };
    const storage = require('../lib/storage');
    const saved = await storage.save(bytes, { filename, contentType: meta.mime_type || 'application/pdf' });
    const borrower = (await db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [appId])).rows[0];
    const doc = (await db.query(
      `INSERT INTO documents (application_id, borrower_id, filename, content_type, size_bytes,
          storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id, doc_kind, source_type, visibility, is_current, review_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'staff',NULL,'draw_inspection_report','system','staff_only',true,'accepted')
       RETURNING id`,
      [appId, borrower ? borrower.borrower_id : null, filename, meta.mime_type || 'application/pdf', bytes.length, saved.provider, saved.ref])).rows[0];
    await db.query(`UPDATE trustpoint_draws SET report_document_id=$2, updated_at=now() WHERE tp_draw_id=$1`, [tpDrawId, doc.id]);
    return { archived: true, documentId: doc.id };
  } catch (e) {
    console.warn('[trustpoint] report archive failed (best-effort):', e && e.message);
    return { archived: false, reason: 'error' };
  }
}

// ---- reactions: staff notices + borrower single-voice milestones (D5) ----
// Statuses map: IN_REVIEW = submitted/awaiting; APPROVED; COMPLETED (poll-only).
// 'Returned' has no status of its own (draw returns to DRAFT) — reacted via the
// DRAW_REQUEST_RETURNED webhook event, not the status watermark.
/**
 * Extract cents from the administrator's fees[] payload (shape is sandbox-unverified —
 * sandbox item Q-C). One entry per parsable fee line; anything unparsable is dropped,
 * an empty/absent payload returns null (never guessed as "$0 in fees").
 */
function feeLinesCents(fees) {
  let arr = fees;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (_) { return null; } }
  if (!Array.isArray(arr) || !arr.length) return null;
  // money can only arrive as a number or a decimal string — a boolean/array/object in an
  // amount slot is garbage, never $1.00 (audit-5 #4: Number(true)===1, Number([7])===7)
  const moneyish = (v) => (typeof v === 'number' || typeof v === 'string') ? client.centsFromTp(v) : null;
  const out = [];
  for (const f of arr) {
    if (f == null) continue;
    if (typeof f === 'number' || typeof f === 'string') { const c = moneyish(f); if (c != null) out.push(c); continue; }
    if (typeof f !== 'object' || Array.isArray(f)) continue;
    const c = moneyish(f.amount) ?? moneyish(f.fee_amount) ?? moneyish(f.value) ?? moneyish(f.total) ?? moneyish(f.fee);
    if (c != null) out.push(c);
  }
  return out.length ? out : null;
}

/**
 * DID THE ADMINISTRATOR ACTUALLY WIRE THIS DRAW? — the ONE definition, and the one
 * thing on a TrustPoint draw that may ever be described as released.
 *
 * `disbursed_amount` is NOT that answer and never was: TrustPoint pre-populates it at
 * SUBMISSION with the projected net (requested minus the per-draw fee), so a draft draw
 * nobody has inspected carries a plausible-looking dollar figure. Reading it as money
 * that moved has now produced two live incidents — YSCAP258134754 ("your construction
 * draw of $49,750.00 is on its way" on a $50,000 request) and YSCAP258134629 ("Released
 * to you $6,200" on a $6,450 draft) — and the second happened because the LEDGER writer
 * below was fixed in 2026-07-27 while the SCREEN and db/302 kept reading the raw field.
 *
 * So the rule lives here and every surface asks it: the wire DATE must exist (the only
 * field TrustPoint sets when money actually goes out) and the draw must have been
 * decided. Pure; never throws; a row it cannot read is not a release.
 */
function releaseConfirmed(row) {
  if (!row || typeof row !== 'object') return false;
  const wired = row.disbursed_at != null;
  const decided = row.status === 'APPROVED' || row.status === 'COMPLETED';
  return wired && decided;
}

// The calendar DAY of a wire, in the office timezone — never UTC (a 9pm ET wire is
// that evening's date, not tomorrow's; house rule: dates are calendar strings).
function nyDay(ts) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts)); }
  catch (_) { return null; }
}

/**
 * §5C MONEY MIRROR (D2): the administrator wires the draw directly — PILOT observes the
 * disbursement by poll (`disbursed_at`/`disbursed_cents` never arrive on webhooks) and
 * records ONE mirror ledger row per draw. Insert-once via the uq_dd_tp_draw claim, so a
 * re-read can never double-record; the borrower's single NET email rides the claim.
 * Runs OUTSIDE the status watermark — money can move without a status transition.
 */
async function mirrorDisbursement(appId, row, { baseline = false, addr = 'the property' } = {}) {
  try {
    const disbursedCents = row.disbursed_cents != null ? Number(row.disbursed_cents) : null;
    // ---- PROOF-OF-PAYMENT GATE (owner-reported 2026-07-27; file YSCAP258134754) ----
    // A borrower was told "your construction draw of $49,750.00 is on its way" on a draw
    // that had only just been SUBMITTED — inspection merely scheduled, nothing approved,
    // no wire. Root cause, verified against TrustPoint's live records for that draw
    // (483ed3a0…, status IN_REVIEW): **`disbursed_amount` is NOT a record of money that
    // moved.** TrustPoint pre-populates it at submission with the PROJECTED net —
    // requested minus the draw fee ($50,000 − $250 = the $49,750 the borrower was told
    // was on its way) — while `approved_amount`, `approved_at` and `disbursed_at` were
    // all still null. The old gate treated a positive `disbursed_amount` as sufficient
    // on its own, so it fired the moment the draw was keyed in.
    //
    // The ONLY field that records an actual disbursement is `disbursed_at` — a date
    // TrustPoint sets when the wire goes out (null on every un-wired draw, set on both
    // genuinely completed ones). So: require the wire DATE, and require the draw to have
    // been decided. Never infer a release from an amount alone.
    // Under-announcing is safe — `drawReleaseOverdueOnce` already alerts the team when an
    // accepted draw's wire has not been recorded in time.
    // ONE definition, shared with the desk and with db/623 (restated there in SQL,
    // because a migration cannot require this module) — see `releaseConfirmed`.
    if (!releaseConfirmed(row)) return { skipped: 'not_disbursed' };
    // the Sitewire draw this money belongs to: the live intake tie, or the portal close-out
    let swDrawId = row.sitewire_draw_id != null ? Number(row.sitewire_draw_id) : null;
    if (swDrawId == null && row.portal_draw_request_id != null) {
      const pr = (await db.query(`SELECT sitewire_draw_id FROM portal_draw_requests WHERE id=$1`, [row.portal_draw_request_id])).rows[0];
      if (pr && pr.sitewire_draw_id != null) swDrawId = Number(pr.sitewire_draw_id);
    }
    const feeList = feeLinesCents(row.fees);
    const feeSum = feeList ? feeList.reduce((s, c) => s + c, 0) : 0;
    const approved = row.approved_cents != null ? Number(row.approved_cents) : 0;
    // NET: what the administrator says actually went out. Now that a real wire DATE is
    // required above, `disbursed_amount` is a settled figure and is already net of the
    // draw fee (verified on the wired draws: $21,000 approved → $20,750 disbursed, and
    // $10,687.50 → $10,437.50 — each exactly the $250 fee). `amount_to_disburse` is not a
    // field TrustPoint publishes (absent from their OpenAPI spec), so `to_disburse_cents`
    // is only ever populated by a future/other source; it stays first if it appears.
    // The approved−fees arithmetic is a LAST resort, never the basis of an announcement
    // on its own — deriving a "released" amount that way is what mis-stated the $49,750.
    const net = row.to_disburse_cents != null ? Number(row.to_disburse_cents)
      : (disbursedCents != null ? disbursedCents : Math.max(0, approved - feeSum));
    const relDate = row.disbursed_at ? nyDay(row.disbursed_at) : null;
    const feesJson = row.fees == null ? null : ((x) => (x && x.length <= 20000 ? x : null))(JSON.stringify(row.fees));
    // Go-forward (audit-5 #2): a wire that went out well before PILOT was watching this
    // draw is HISTORY — record the row for the ledger, tell no one (a "your money is on
    // its way, 1–2 business days" email about a weeks-old wire would be nonsense).
    const stale = row.disbursed_at != null && (Date.now() - new Date(row.disbursed_at).getTime() > 14 * 86400000);
    // Out-of-pocket-first (owner-directed 2026-07-31): this path deliberately does NOT apply the
    // OOP-rehab floor. On a note-buyer-administered file the capital partner wires draws in their OWN
    // system, so PILOT records what ACTUALLY moved (net = the administrator's wired amount) — overriding
    // it with a computed floor would make the ledger disagree with the real bank wire. The out-of-pocket
    // rehab is enforced for these files through the DATA TAPE instead: the tape reports the FINANCED
    // holdback (rehabHoldback), which caps how much the note buyer funds, so the borrower funds the OOP
    // portion. PILOT's own /disbursements route is where the floor is enforced when PILOT releases.
    const ins = (await db.query(
      `INSERT INTO draw_disbursements (application_id, sitewire_draw_id, trustpoint_draw_id, approved_cents, fee_cents,
          retainage_held_cents, net_release_cents, release_date, funded_status, kind, source, fees, note)
       VALUES ($1,$2,$3,$4,$5,0,$6,$7,'released','draw','trustpoint',$8::jsonb,
               'Mirrored from the draw administrator — the note buyer wires these draws directly.')
       ON CONFLICT DO NOTHING RETURNING id`,
      [appId, swDrawId, row.tp_draw_id, approved, feeSum, net, relDate, feesJson])).rows[0];
    if (!ins) {
      // A row already exists — an earlier mirror pass, or a staff manual entry that
      // claimed the per-draw slot. REPAIR the linkage (audit-5 #1/#3), never duplicate,
      // never re-announce, and never leave a split-ledger silently.
      if (swDrawId != null) {
        // (a) an earlier UNTIED mirror row (tie landed late): retro-tie it to the draw
        const retro = (await db.query(
          `UPDATE draw_disbursements SET sitewire_draw_id=$2, updated_at=now()
            WHERE trustpoint_draw_id=$1 AND sitewire_draw_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM draw_disbursements x WHERE x.sitewire_draw_id=$2 AND x.kind='draw')
            RETURNING id`, [row.tp_draw_id, swDrawId]).catch(() => ({ rows: [] }))).rows[0];
        if (!retro) {
          // (b) a manual staff row holds the draw slot: adopt it (stamp the tp linkage)
          let adopted = null;
          try {
            adopted = (await db.query(
              `UPDATE draw_disbursements SET trustpoint_draw_id=$2, fees=COALESCE(fees,$3::jsonb), updated_at=now()
                WHERE sitewire_draw_id=$1 AND kind='draw' AND trustpoint_draw_id IS NULL RETURNING id`,
              [swDrawId, row.tp_draw_id, feesJson])).rows[0];
          } catch (e) {
            // 23505 = the tp id already lives on ANOTHER row → a mirror row AND a manual
            // row both exist for this one wire (split ledger, double-counted money)
            adopted = null;
          }
          if (!adopted) {
            const mine = (await db.query(
              `SELECT count(*)::int c FROM draw_disbursements
                WHERE kind='draw' AND (trustpoint_draw_id=$1 OR sitewire_draw_id=$2)`, [row.tp_draw_id, swDrawId])).rows[0];
            if (Number(mine.c) > 1) {
              const orchestrator = require('../sitewire/orchestrator');
              await orchestrator.park({
                appId, dedupe: `tpdup:${row.tp_draw_id}`,
                reason: `sitewire_money_duplicate: draw ${swDrawId} has BOTH a mirrored release from the administrator and a hand-recorded release — the same wire is in the money ledger twice. Delete the hand-entered duplicate on the draw desk.`,
              }).catch(() => {});
            }
          }
        }
      } else {
        // No Sitewire draw known and the insert still conflicted: the tp id row exists
        // (fine — already recorded), OR nothing carries this tp id at all (impossible via
        // the uq claim) — either way there is nothing to repair without a draw to tie to.
      }
      return { skipped: 'already_recorded' };
    }
    await audit(appId, row.tp_draw_id, 'draw', row.tp_draw_id, 'disbursement_mirrored', null, String(net), !(baseline || stale));
    if (baseline || stale) return { ok: true, silent: true };
    try { await verifyPartnerFee(appId, row); } catch (_) {}   // straight-to-completed draws still get the fee check
    // The dormant markup knob (D9): when the note buyer later allows a YS markup, it is
    // deducted from what reaches the borrower — the shown NET honors it the day it's set.
    let markup = 0;
    try {
      const rp = await require('../sitewire/routing').resolveFilePlatform(appId);
      if (rp && rp.rule && Number(rp.rule.markup_cents) > 0) markup = Number(rp.rule.markup_cents);
    } catch (_) {}
    const shown = Math.max(0, net - markup);
    if (shown > 0) {
      // The released wire is the one moment where the amount that MOVED is the whole message, so
      // it stays the headline — now with the approval it came out of, and the request behind
      // that, ranked beneath it. ONE email, the desk and the officer visibly on it.
      const blocks = await drawEmailBlocks(db, appId, {
        sitewireDrawId: row.sitewire_draw_id != null ? row.sitewire_draw_id : null,
        tpDraw: row, borrower: true,
      });
      // `shown` is the borrower-facing net AFTER our platform markup — a deduction the rollup does
      // not model. So the HEADLINE is always `shown` (anything else would promise the borrower
      // more than actually lands in their account), while the supporting approved / requested /
      // held-back figures come from the rollup unchanged.
      let figures = blocks && blocks.figures;
      if (figures) {
        figures = { ...figures, primary: { label: 'Released to you', value: usd2(shown), sub: 'typically arrives in 1–2 business days' } };
      }
      await notify.notifyAppThread(appId, {
        type: 'draw', title: 'Your construction draw has been released',
        drawTag: drawLabel.drawLabel(row.number),
        hero: figures ? null : { label: 'Released to you', value: usd2(shown), sub: 'typically arrives in 1–2 business days', tone: 'positive' },
        figures: figures || null,
        facts: (blocks && blocks.facts) || null,
        badge: { text: 'Draw released', tone: 'positive' },
        body: `Your construction draw of ${usd2(shown)} is on its way. Depending on your bank, funds typically take 1–2 business days to arrive.`,
        lines: ['Questions about this draw? Just reply to this email — your whole loan team is on it.'],
        applicationId: appId, link: `/app/${appId}`, ctaLabel: 'View your draws',
        // The desk's own in-app row, in the desk's voice — the email above is one message and
        // keeps the borrower's subject, but the team's feed should not read as if the file were
        // theirs. Same facts, stated for the reader who is working the loan.
        staffTitle: 'Draw funds released',
        staffBody: `Draw #${row.number == null ? '—' : row.number} for ${addr}: ${usd2(net)} net was released by the administrator${feeSum ? ` (fees ${usd2(feeSum)})` : ''}. Recorded in the money ledger automatically.`,
      }).catch(() => {});
    } else {
      // No borrower-facing wire (fully absorbed by fees/markup) — the desk still needs to know.
      await notify.notifyAppStaff(appId, {
        type: 'draw_inbound', title: 'Draw funds released',
        body: `Draw #${row.number == null ? '—' : row.number} for ${addr}: ${usd2(net)} net was released by the administrator${feeSum ? ` (fees ${usd2(feeSum)})` : ''}. Recorded in the money ledger automatically.`,
        badge: { text: 'Released', tone: 'positive' }, applicationId: appId, link: `/internal/app/${appId}/draws`, inAppOnly: true,
      }).catch(() => {});
    }
    return { ok: true, net };
  } catch (e) { console.warn('[trustpoint] disbursement mirror failed:', e && e.message); return { error: true }; }
}

/**
 * §5E fee verification (D6): every administered draw's fee lines are checked ONCE
 * against the rule's agreed per-draw physical fee (Blue Lake: $250, deducted from the
 * net wire). A missing/different fee alerts staff — the borrower's NET depends on it.
 * Absent fee DATA skips silently (never guessed); the check stamps fee_check_at.
 */
async function verifyPartnerFee(appId, row) {
  try {
    if (row.fee_check_at) return { skipped: 'checked' };
    const rp = await require('../sitewire/routing').resolveFilePlatform(appId);
    if (!rp || rp.platform !== 'trustpoint' || !rp.rule) return { skipped: 'not_applicable' };
    // The expected fee is what the file actually charges: the resolved method's fee with
    // the coordinator's per-file override honored (audit-5 #5) — falling back to the
    // rule's physical fee when the resolution can't run.
    let expected = null;
    try {
      const orchestrator = require('../sitewire/orchestrator');
      const link = await orchestrator.getLink(appId);
      const insp = orchestrator.resolveInspection(link, rp.rule);
      if (insp && Number.isFinite(Number(insp.feeCents))) expected = Number(insp.feeCents);
    } catch (_) {}
    if (expected == null) expected = rp.rule.fee_cents_physical != null ? Number(rp.rule.fee_cents_physical) : null;
    if (expected == null || !Number.isFinite(expected)) return { skipped: 'no_expected_fee' };
    const fees = feeLinesCents(row.fees);
    if (fees == null) return { skipped: 'no_fee_data' };
    const stamped = (await db.query(
      `UPDATE trustpoint_draws SET fee_check_at=now(), updated_at=now() WHERE tp_draw_id=$1 AND fee_check_at IS NULL RETURNING tp_draw_id`,
      [row.tp_draw_id])).rows[0];
    if (!stamped) return { skipped: 'checked' };
    if (fees.includes(expected)) return { ok: true };
    const total = fees.reduce((s, c) => s + c, 0);
    await notify.notifyAppStaffThread(appId, {
      type: 'draw_inbound', title: 'Draw fee doesn’t match the agreed amount',
      // The draw leads the SUBJECT rather than sitting inside the sentence; a draw the
      // administrator never numbered carries no tag at all rather than a guessed one, so
      // the body keeps saying which draw it is either way.
      drawTag: drawLabel.drawLabel(row.number),
      body: `Draw #${row.number == null ? '—' : row.number} carries fee lines totaling ${usd2(total)}, but the agreed per-draw fee for this program is ${usd2(expected)}. The borrower's net wire depends on this — please double-check the fee with the draw administrator.`,
      badge: { text: 'Fee check', tone: 'action' }, applicationId: appId, link: `/internal/app/${appId}/draws`,
    }).catch(() => {});
    return { alerted: true };
  } catch (e) { return { error: true }; }
}

async function reactDraw(appId, row, prev, { baseline = false, addrText = null } = {}) {
  const tpDrawId = row.tp_draw_id;
  const newStatus = row.status || null;
  if (!newStatus) return;
  const addr = addrText || (await db.query(`SELECT property_address->>'oneLine' AS a FROM applications WHERE id=$1`, [appId])).rows[0]?.a || 'the property';
  const nLabel = row.number == null ? '—' : row.number;
  const link = `/internal/app/${appId}/draws`;

  // §5C money mirror — BEFORE (and independent of) the status watermark: a disbursement
  // can land with no status change, and the mirror row has its own insert-once claim.
  try { await mirrorDisbursement(appId, row, { baseline, addr }); } catch (_) {}

  // The conversation on the draw is the answer to "why did this move / why is it STUCK?",
  // so it must be mirrored on EVERY pass — not on a transition. This used to sit in the
  // APPROVED branch, below the watermark claim, which meant a draw sitting in IN_REVIEW was
  // never synced at all: precisely the draw whose messages matter ("Please update the ZIP
  // code … therefore the draw request has failed" is on an un-approved draw). A settled draw
  // is skipped so a finished project stops costing an API call on every poll.
  if (newStatus !== 'COMPLETED' && newStatus !== 'DELETED') {
    try { await require('./comments').syncDrawComments(appId, row.tp_project_id, tpDrawId); } catch (_) {}
  }

  // RETRY an archive that never landed. The pull below fires once, on the APPROVED transition,
  // and TrustPoint's links expire in about a day — so one blip at that exact moment lost the
  // inspection report and its photographs for good. This re-attempts only while the draw is
  // recent AND has nothing archived, so it self-limits; re-running is safe (the store dedupes
  // on content hash and the photo insert is ON CONFLICT DO NOTHING).
  if (newStatus !== 'DELETED') {
    try { await require('./documents').archiveDrawIfIncomplete(tpDrawId); } catch (_) {}
  }

  // Atomic watermark claim (same shape as the Sitewire reconcile) — one reactor wins.
  const won = (await db.query(
    `UPDATE trustpoint_draws SET status_synced=$2 WHERE tp_draw_id=$1 AND status_synced IS DISTINCT FROM $2 RETURNING tp_draw_id`,
    [tpDrawId, newStatus])).rowCount === 1;
  if (!won) return;
  // Only FORWARD transitions notify (audit #19): a stale read regressing the status and
  // re-advancing must never re-send the borrower approval email. Rank unknown = 0.
  const RANK = { DRAFT: 1, IN_REVIEW: 2, APPROVED: 3, COMPLETED: 4, DELETED: 5 };
  if (prev && prev.status_synced && (RANK[newStatus] || 0) <= (RANK[prev.status_synced] || 0)) {
    await audit(appId, tpDrawId, 'draw', tpDrawId, 'status_nonforward', prev.status_synced, newStatus, false);
    return;
  }
  const firstSight = !prev || prev.status_synced == null;
  // A BASELINE hydrate (a just-linked project's history) claims the watermark silently —
  // go-forward: PILOT never notifies for history it wasn't watching.
  if (baseline) { await audit(appId, tpDrawId, 'draw', tpDrawId, 'baseline', prev && prev.status_synced, newStatus, false); return; }
  await audit(appId, tpDrawId, 'draw', tpDrawId, firstSight ? 'first_status' : 'status', prev && prev.status_synced, newStatus, true);

  if (newStatus === 'IN_REVIEW') {
    await notify.notifyAppStaff(appId, {
      type: 'draw_inbound', title: 'Draw in review on TrustPoint',
      body: `Draw #${nLabel} for ${addr} (${usd(row.requested_cents)}) is now in TrustPoint's review pipeline.`,
      badge: { text: 'TrustPoint', tone: 'gold' }, applicationId: appId, link, inAppOnly: true,
    }).catch(() => {});
    // PRE-approval milestone snapshot — the derivation's "before" picture (phase 3 §6).
    try { await require('./lines').snapshotMilestones(appId, row.tp_project_id, tpDrawId, 'pre'); } catch (_) {}
  } else if (newStatus === 'APPROVED') {
    // ONE email, everybody on it — the borrower in To, the draw desk and the loan officer in a
    // VISIBLE Cc, and no separate staff copy (owner-directed 2026-08-03). This event used to send
    // two: a staff blast AND a borrower note, so the coordinator received the same sentence twice
    // in two threads and a reply to either reached nobody else.
    //
    // The money is no longer a sentence. `drawEmailBlocks` reads the file's rollup — the same one
    // behind the desk, the borrower's screen and the PDF — so the ranked figures here and the
    // report attached later can never disagree.
    // `row.sitewire_draw_id` — NOT tpDrawId — is the Sitewire key; the row itself is the fallback
    // for a TrustPoint draw that has no Sitewire counterpart.
    const blocks = await drawEmailBlocks(db, appId, {
      sitewireDrawId: row.sitewire_draw_id != null ? row.sitewire_draw_id : null,
      tpDraw: row, borrower: true,
    });
    const copy = (blocks && blocks.copy) || { title: 'Your draw is approved — funds are on the way', badge: 'Approved', tone: 'positive' };
    await notify.notifyAppThread(appId, {
      type: 'draw', title: copy.title,
      drawTag: drawLabel.drawLabel(row.number),
      badge: { text: copy.badge, tone: copy.tone },
      body: `Your draw for ${addr} has been approved. Here is exactly what was approved and what reaches you.`,
      figures: (blocks && blocks.figures) || null,
      facts: (blocks && blocks.facts) || null,
      applicationId: appId, link: `/app/${appId}`, ctaLabel: 'View your draws',
    }).catch(() => {});
    await archiveReport(appId, row.tp_project_id, tpDrawId).catch(() => {});
    // Owner-directed 2026-07-27: pull EVERYTHING TrustPoint holds for this draw — the draw
    // report, the inspection paperwork, and the inspector's photos — the moment we hear about
    // it. Their links are pre-signed and expire in about a day, so a late pull is a lost one.
    try { await require('./documents').archiveDrawEverything(tpDrawId); } catch (_) {}
    // (the conversation mirror runs on every pass, above the watermark — see reactDraw's head)
    // §5E: the once-per-draw fee check runs at approval (the NET depends on the fee).
    try { await verifyPartnerFee(appId, row); } catch (_) {}
    // Phase 3 §5A/§6: POST-approval snapshot → per-line derivation → Sitewire write-back.
    // Fully best-effort; each stage records why it waited (writeback_note) when it can't run.
    try { await require('./lines').snapshotMilestones(appId, row.tp_project_id, tpDrawId, 'post'); } catch (_) {}
    try { await require('./writeback').onTrustpointApproval(appId, tpDrawId); } catch (_) {}
    // A PORTAL-originated draw closes out into Sitewire as a HISTORICAL draw instead
    // of the live write-back (phase 4 §5B — needs the per-line amounts, so it runs
    // after the derive; re-triggered from the lines-save route as well).
    try { await require('../lib/portal-draws').onTrustpointApproval(appId, row); } catch (_) {}
  } else if (newStatus === 'COMPLETED') {
    await notify.notifyAppStaff(appId, {
      type: 'draw_inbound', title: 'Draw completed on TrustPoint',
      body: `Draw #${nLabel} for ${addr} is completed on TrustPoint${row.disbursed_cents != null ? ` (disbursed ${usd(row.disbursed_cents)})` : ''}.`,
      badge: { text: 'Completed', tone: 'positive' }, applicationId: appId, link, inAppOnly: true,
    }).catch(() => {});
  }
}

/** A DRAW_REQUEST_RETURNED webhook: the draw went back to the borrower/coordinator. */
async function reactReturned(appId, row, addrText) {
  const addr = addrText || 'the property';
  const nLabel = row && row.number != null ? row.number : '—';
  // ONE email, everybody on it (rule 15 — never a bare notifyAppBorrowers+notifyAppStaff pair for
  // a draw email): the borrower is told in their voice, the draw team rides the visible Cc keyed on
  // the 'draws' category (drawLoopInBcc — coordinator + officer + draws@ desk), and the desk's feed
  // keeps its own staff-voiced line. `link` is omitted so each audience gets its default (borrower →
  // /app, staff → /internal).
  await notify.notifyAppThread(appId, {
    type: 'draw', title: 'Your draw needs attention',
    drawTag: drawLabel.drawLabel(row.number),
    body: `Your draw request for ${addr} needs a little more before it can be approved. Your loan team will reach out with exactly what's needed.`,
    staffTitle: 'Draw returned on TrustPoint',
    staffBody: `Draw #${nLabel} for ${addr} was returned in TrustPoint's review — something needs attention before it can be approved.`,
    applicationId: appId,
  }).catch(() => {});
}

// ---- service orders ----
async function upsertServiceOrder(appId, so, { baseline = false } = {}) {
  const prev = (await db.query(`SELECT status, status_synced FROM trustpoint_service_orders WHERE tp_service_order_id=$1`, [so.id])).rows[0] || null;
  await db.query(
    `INSERT INTO trustpoint_service_orders (tp_service_order_id, application_id, tp_project_id, tp_draw_id, service_type, status,
        service_number, ordered_at, scheduled_at, completed_at, cancelled_at, inspector_allowance_rate, raw, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,now())
     ON CONFLICT (tp_service_order_id) DO UPDATE SET
        application_id=EXCLUDED.application_id, tp_project_id=EXCLUDED.tp_project_id,
        status=COALESCE(EXCLUDED.status, trustpoint_service_orders.status),
        tp_draw_id=COALESCE(EXCLUDED.tp_draw_id, trustpoint_service_orders.tp_draw_id),
        service_number=COALESCE(EXCLUDED.service_number, trustpoint_service_orders.service_number),
        ordered_at=COALESCE(EXCLUDED.ordered_at, trustpoint_service_orders.ordered_at),
        scheduled_at=COALESCE(EXCLUDED.scheduled_at, trustpoint_service_orders.scheduled_at),
        completed_at=COALESCE(EXCLUDED.completed_at, trustpoint_service_orders.completed_at),
        cancelled_at=COALESCE(EXCLUDED.cancelled_at, trustpoint_service_orders.cancelled_at),
        inspector_allowance_rate=COALESCE(EXCLUDED.inspector_allowance_rate, trustpoint_service_orders.inspector_allowance_rate),
        raw=COALESCE(EXCLUDED.raw, trustpoint_service_orders.raw), updated_at=now()`,
    [so.id, appId, so.project_id || so.tp_project_id, so.draw_request_id || null, so.service_type || null, so.status || null,
     so.service_number || null, so.ordered_at || null, so.scheduled_at || null, so.completed_at || null, so.cancelled_at || null,
     so.inspector_allowance_rate != null && Number.isFinite(Number(so.inspector_allowance_rate)) ? Number(so.inspector_allowance_rate) : null,
     ((x) => x.length > 20000 ? null : x)(JSON.stringify(so))]);
  // Silent by default (in-app timeline data); a COMPLETED inspection gets ONE in-app staff note.
  //
  // ---- ONE NOTICE PER INSPECTION, AND ONLY GOING FORWARD (owner-reported 2026-07-27) ----
  // File YSCAP258134727 produced THREE "inspection completed" notices for TWO real
  // inspections. Verified against TrustPoint's records, both causes were here:
  //   (1) NO BASELINE. Draws hydrate a just-linked project's history silently (reactDraw's
  //       `baseline`), but service orders had no such notion — so linking this project on
  //       Jul 26 announced its Jul 20 inspection (8.55%) as if it had just happened.
  //   (2) NO FORWARD-ONLY CLAIM. The dedupe was a non-atomic read of `status`, so any
  //       regression-then-re-advance re-armed it: the draw-2 inspection (23.66%) was
  //       completed, revised, and completed again, and was announced BOTH times. Draws are
  //       protected by an atomic `status_synced` claim + a forward-only RANK; the
  //       `status_synced` column existed on this table but was read and never written.
  // The claim below is a single atomic UPDATE, so overlapping webhook drains and polls
  // cannot both win, and a completed inspection can never be announced a second time.
  if (so.status === 'COMPLETED') {
    const won = (await db.query(
      `UPDATE trustpoint_service_orders SET status_synced='COMPLETED', updated_at=now()
        WHERE tp_service_order_id=$1 AND status_synced IS DISTINCT FROM 'COMPLETED'
        RETURNING tp_service_order_id`, [so.id])).rowCount === 1;
    if (!won) return;
    await audit(appId, so.draw_request_id || null, 'service_order', String(so.id), 'completed',
      prev && prev.status, 'COMPLETED', !baseline);
    // The inspection paperwork + the inspector's photos land WITH the completion, on
    // pre-signed links that expire in about a day — pull them now, even on a baseline pass
    // (the documents are worth having whether or not the completion is announced).
    if (so.draw_request_id) {
      try { await require('./documents').archiveDrawEverything(String(so.draw_request_id)); } catch (_) {}
    }
    if (baseline) return;   // history for a project we had not started watching yet
    await notify.notifyAppStaff(appId, {
      type: 'draw_inbound', title: `${so.service_type === 'INSPECTION' ? 'Inspection' : (so.service_type || 'Service order')} completed`,
      body: `TrustPoint marked the ${String(so.service_type || 'service order').toLowerCase().replace(/_/g, ' ')} complete${so.inspector_allowance_rate != null ? ` — overall progress ${so.inspector_allowance_rate}%` : ''}.`,
      applicationId: appId, link: `/internal/app/${appId}/draws`, inAppOnly: true,
    }).catch(() => {});
  }
}

// ---- full hydrate of one linked project's draws (poll + just-after-link) ----
async function hydrateProject(appId, tpProjectId, { baseline = false } = {}) {
  const draws = await client.listProjectDraws(tpProjectId);
  let n = 0;
  for (const d of draws) {
    try {
      let detail = d;
      try { detail = await client.getDraw(tpProjectId, d.id); } catch (_) {}
      const { prev, row } = await upsertDraw(appId, tpProjectId, String(d.id), detail);
      await linkToSitewireIntake(appId, row);
      await reactDraw(appId, row, prev, { baseline: baseline && (!prev || prev.status_synced == null) });
      n++;
    } catch (e) { console.warn(`[trustpoint] hydrate draw ${d && d.id} failed: ${e && e.message}`); }
  }
  try {
    const sos = await client.listServiceOrders({ project_id: tpProjectId });
    // Service orders baseline with the project, exactly like its draws — a just-linked
    // project's finished inspections are HISTORY, never fresh news (owner-reported 2026-07-27).
    for (const so of sos) await upsertServiceOrder(appId, { ...so, project_id: tpProjectId }, { baseline });
  } catch (_) {}
  return { draws: n };
}

// ---- webhook inbox drain ----
const DRAW_EVENTS = new Set(['DRAW_REQUEST_CREATED', 'DRAW_REQUEST_SUBMITTED', 'DRAW_REQUEST_REVIEW_ADDED', 'DRAW_REQUEST_FINALIZED', 'DRAW_REQUEST_RETURNED', 'DRAW_REQUEST_DELETED']);
const SO_EVENTS = new Set(['SERVICE_ORDER_ORDERED', 'SERVICE_ORDER_COMPLETED', 'SERVICE_ORDER_CANCELLED']);

async function processEvent(evt) {
  const p = evt.payload || {};
  let tpProjectId = evt.tp_project_id || p.project_id || null;
  // The delivery shape may omit project_id (the documented event schema carries only
  // draw_id/loan_id — audit #3). Resolve from what we already know before giving up.
  if (!tpProjectId && (evt.tp_draw_id || p.draw_id)) {
    const known = (await db.query(`SELECT tp_project_id FROM trustpoint_draws WHERE tp_draw_id=$1`, [String(evt.tp_draw_id || p.draw_id)])).rows[0];
    if (known) tpProjectId = known.tp_project_id;
  }
  if (!tpProjectId && (evt.loan_id || p.loan_id)) {
    const byLoan = (await db.query(`SELECT tp_project_id FROM trustpoint_project_links WHERE loan_external_id=$1 AND application_id IS NOT NULL`, [String(evt.loan_id || p.loan_id)])).rows;
    if (byLoan.length === 1) tpProjectId = byLoan[0].tp_project_id;
  }
  if (!tpProjectId) return { skipped: 'no_project' };
  const link = await linkFor(String(tpProjectId));
  const appId = link ? link.application_id : null;
  if (!appId) {
    // Just-in-time discovery: an event for an unknown/unlinked project seeds the linking
    // desk (park-and-replay: the row is left unprocessed=processed with a note; the next
    // poll after linking re-hydrates everything, so nothing is lost).
    try { await require('./discovery').noteUnknownProject(String(tpProjectId), evt.loan_id || p.loan_id || null); } catch (_) {}
    return { skipped: 'unlinked_project' };
  }
  const addr = (await db.query(`SELECT property_address->>'oneLine' AS a FROM applications WHERE id=$1`, [appId])).rows[0]?.a || 'the property';

  if (DRAW_EVENTS.has(evt.event)) {
    const tpDrawId = String(evt.tp_draw_id || p.draw_id || '');
    if (!tpDrawId) return { skipped: 'no_draw' };
    if (evt.event === 'DRAW_REQUEST_DELETED') {
      await db.query(`UPDATE trustpoint_draws SET status='DELETED', status_synced='DELETED', updated_at=now() WHERE tp_draw_id=$1`, [tpDrawId]);
      await audit(appId, tpDrawId, 'draw', tpDrawId, 'deleted', null, 'DELETED', false);
      return { ok: true };
    }
    // hydrate the detail (webhook payloads are thin); fall back to the payload alone
    let detail = null;
    try { detail = await client.getDraw(tpProjectId, tpDrawId); } catch (_) {}
    const { prev, row } = await upsertDraw(appId, String(tpProjectId), tpDrawId, detail || { ...p, id: tpDrawId });
    await linkToSitewireIntake(appId, row);
    if (evt.event === 'DRAW_REQUEST_REVIEW_ADDED') {
      await audit(appId, tpDrawId, 'draw', tpDrawId, 'review_added', null, `${p.review_action || ''} ${p.reviewed_by_team || ''}→${p.assigned_team || ''}`.trim(), false);
      return { ok: true };   // ticker data only — no notification per review hop
    }
    if (evt.event === 'DRAW_REQUEST_RETURNED') {
      await audit(appId, tpDrawId, 'draw', tpDrawId, 'returned', prev && prev.status, row.status, true);
      await reactReturned(appId, row, addr);
      return { ok: true };
    }
    await reactDraw(appId, row, prev, { addrText: addr, baseline: !link.baselined_at });
    return { ok: true };
  }
  if (SO_EVENTS.has(evt.event)) {
    const soId = String(evt.tp_service_order_id || p.service_order_id || '');
    if (!soId) return { skipped: 'no_service_order' };
    await upsertServiceOrder(appId, { ...p, id: soId, project_id: tpProjectId }, { baseline: !link.baselined_at });
    return { ok: true };
  }
  if (evt.event === 'PROJECT_CHANGED') {
    for (const ch of (Array.isArray(p.changes) ? p.changes : [])) {
      await audit(appId, null, 'project', String(tpProjectId), ch.field || 'change', ch.old_value ?? ch.old, ch.new_value ?? ch.new, false);
    }
    return { ok: true };
  }
  return { skipped: 'unknown_event' };
}

async function drainInbox(limit = 50) {
  // The switch gates the whole MIRROR (its label says so): while off, deliveries sit in
  // the inbox untouched and drain when it turns back on (audit #4).
  if (!client.enabled()) return { skipped: 'off' };
  const rows = (await db.query(
    `SELECT * FROM trustpoint_webhook_events WHERE processed_at IS NULL AND attempts < 3 ORDER BY received_at LIMIT $1`, [limit])).rows;
  let ok = 0, failed = 0;
  for (const evt of rows) {
    // claim so overlapping drains never double-process
    const claim = await db.query(
      `UPDATE trustpoint_webhook_events SET processed_at=now(), attempts=attempts+1 WHERE id=$1 AND processed_at IS NULL RETURNING id`, [evt.id]);
    if (!claim.rows[0]) continue;
    try { await processEvent(evt); ok++; }
    catch (e) {
      failed++;
      // TrustPoint never redelivers — a TRANSIENT failure must not eat the event (audit
      // #11): release the claim so the next drain retries, up to the attempts cap.
      await db.query(`UPDATE trustpoint_webhook_events SET processed_at=NULL, process_error=$2 WHERE id=$1`, [evt.id, String(e && e.message).slice(0, 500)]).catch(() => {});
    }
  }
  return { ok, failed, drained: rows.length };
}

module.exports = { upsertDraw, reactDraw, reactReturned, upsertServiceOrder, hydrateProject, processEvent, drainInbox, archiveReport, linkedAppFor, linkFor, linkToSitewireIntake, mirrorDisbursement, releaseConfirmed, verifyPartnerFee, _drawRow: drawRow, _feeLinesCents: feeLinesCents, _fetchDocumentBytes: fetchReportBytes, _isTrustpointDocHost: isTrustpointDocHost };
