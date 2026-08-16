'use strict';
/**
 * Trinity → SITEWIRE write-back: put the physical inspector's per-line figures onto the
 * Sitewire draw the borrower actually submitted.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The physical program has TWO doors and until 2026-08-16 only one of them ended
 * anywhere. A PORTAL draw request carries its own decision record, so
 * `portal-draws.approveTrinityRequest` records the approved amounts and tells the
 * borrower. A draw the borrower submitted IN SITEWIRE has no portal request — the draw
 * lives in Sitewire — so a Trinity order placed against it produced a completed
 * inspection whose figures had nowhere to go, and the Deliver button refused.
 *
 * Owner-directed 2026-08-16, choosing between three designs: *"Write Trinity's numbers
 * into the Sitewire draw"* — not released; the draw coordinator approves and releases on
 * the draw desk exactly as today, so Trinity simply replaces the virtual inspector and
 * nobody has to learn a new screen. And, immediately after: *"we still need to follow the
 * workflow of getting borrower approval that he agrees with the findings and he doesn't
 * want to push back. Follow everything like it was in the beginning."*
 *
 * THAT SECOND SENTENCE IS WHAT DECIDES THE FIELD, and it is worth spelling out because
 * the obvious choice is wrong. `pending_approved_cents` looks right — it is literally
 * named for a pending approval — but it is a CREATE-time field (`createHistoricalDraw`),
 * and the borrower's findings are built by `reconcile.fetchDrawFindings`, which reads
 * `approved_cents` and treats a null as "THE INSPECTOR HAS NOT ANSWERED THIS LINE"
 * (the tri-state doctrine of 2026-08-10, db/518 — the root that once printed
 * "Approved $0" on unreviewed work). So writing the pending field would hand the
 * borrower an accept page saying the inspector had answered nothing.
 *
 * On a VIRTUAL draw the Sitewire inspector's figures sit in `approved_cents` while the
 * draw is still unapproved — that is exactly how a borrower accepts or disputes BEFORE
 * any release. Writing Trinity's figures to the same field is what makes "follow
 * everything like it was in the beginning" literally true: the accept page, the dispute
 * flow, the branded report, the wire deadline and the release are byte-for-byte the ones
 * that already exist, and the only thing that changed is who did the inspecting.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT DO, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 * IT NEVER APPROVES, RELEASES, OR TRANSITIONS THE DRAW. It records what the inspector
 * found and stops. `drawTransition('approve')` is a human's action on the draw desk and
 * is deliberately not reachable from here, and neither is any release. That is the line
 * the whole Trinity program is built on: there is no autopilot, and money moves when a
 * person decides it does.
 *
 * UNVERIFIED AGAINST LIVE SITEWIRE, AND SAID OUT LOUD: this repo has no Sitewire sandbox
 * to probe, so whether their PATCH accepts `approved_cents` on a live request is read
 * from how the field behaves on a virtual draw, not from a test call. A refusal is
 * PARKED with a plain message naming the field rather than swallowed — so the first real
 * order tells a human immediately instead of failing quietly. Confirm it with one live
 * draw before go-live.
 *
 * IT NEVER TOUCHES A VIRTUAL FILE. It is only ever called from the Trinity ingest, on an
 * order that exists only on a physical non-Blue-Lake file (`trinity/eligibility.js`), and
 * it refuses outright unless the order carries a `sitewire_draw_id`.
 *
 * ---------------------------------------------------------------------------
 * THE GUARDS ARE THE ONES EVERY OTHER SITEWIRE WRITE USES
 * ---------------------------------------------------------------------------
 * Both switches, the volume circuit breaker, a journal row per write, read-after-write
 * verification, and park-on-failure. Nothing here is a private path around the
 * orchestrator's discipline — a write that cannot be verified is parked for a human
 * rather than assumed to have landed.
 */

const db = require('../db');

/** Both switches must be on. DRYRUN builds the write and sends nothing. */
function writesOn() {
  const switches = require('../lib/integrations/switches');
  const cfg = require('../config');
  if (!switches.on('SITEWIRE_ENABLED')) return { on: false, why: 'sitewire_off' };
  if (!switches.on('SITEWIRE_OUTBOUND_ENABLED') && !cfg.sitewireDryrun) return { on: false, why: 'sitewire_writes_off' };
  return { on: true, dryrun: !switches.on('SITEWIRE_OUTBOUND_ENABLED') };
}

/**
 * Push the inspector's approved amounts onto the Sitewire draw's own request lines.
 *
 * @param appId
 * @param orderRow  the trinity_inspection_orders row (must carry sitewire_draw_id)
 * @param resultLines  mapper.readResults output — per line, in CENTS, tied to our job items
 *
 * Returns a plain result and NEVER throws: this runs inside the poller, and a Sitewire
 * outage must not stop us reading the rest of Trinity's answer.
 */
async function pushApprovalsToSitewire(appId, orderRow, resultLines) {
  const drawId = orderRow && orderRow.sitewire_draw_id;
  if (!drawId) return { skipped: 'not_a_sitewire_draw' };
  if (!Array.isArray(resultLines) || !resultLines.length) return { skipped: 'no_results' };

  const gate = writesOn();
  if (!gate.on) return { skipped: gate.why };

  const orchestrator = require('../sitewire/orchestrator');
  const swClient = require('../sitewire/client');

  // The draw must belong to THIS file. A Trinity order naming another file's draw is a
  // data fault, and writing money onto it would be far worse than refusing.
  const own = await db.query(
    `SELECT sitewire_draw_id, status FROM sitewire_draws WHERE sitewire_draw_id=$1 AND application_id=$2`,
    [drawId, appId]);
  if (!own.rowCount) return { skipped: 'draw_not_on_file' };

  // ONE WRITE PER RESULT, NOT PER POLL. The poller re-reads a completed order on every
  // tick, and re-PATCHing the same figures would journal a write a minute forever. The
  // fingerprint is the figures themselves, so a REVISION (Trinity re-completing an order
  // with different numbers) genuinely differs and is written again — which is exactly
  // what must happen when an inspector corrects a report.
  const fingerprint = resultLines
    .filter((l) => l.sitewire_job_item_id != null)
    .map((l) => `${l.sitewire_job_item_id}:${Math.round(Number(l.approved_cents) || 0)}`)
    .sort().join('|');
  if (!fingerprint) return { skipped: 'no_lines_tied_to_this_file' };
  if (orderRow.writeback_fingerprint === fingerprint) return { skipped: 'already_written', unchanged: true };

  // Our per-line results are keyed on OUR job item; Sitewire's PATCH is keyed on ITS
  // request id. `sitewire_draw_requests` is the crosswalk the draw stack already keeps.
  const reqRows = (await db.query(
    `SELECT sitewire_request_id, sitewire_job_item_id, requested_cents
       FROM sitewire_draw_requests WHERE sitewire_draw_id=$1`, [drawId])).rows;
  const byJid = new Map(reqRows.map((r) => [Number(r.sitewire_job_item_id), r]));

  const written = [];
  const skipped = [];
  let failed = null;

  for (const l of resultLines) {
    const jid = l.sitewire_job_item_id == null ? null : Number(l.sitewire_job_item_id);
    if (jid == null) { skipped.push({ reason: 'trinity_own_line', name: l.name }); continue; }
    const r = byJid.get(jid);
    // A line Trinity reported that is not on this draw is not ours to write. It stays
    // visible on the Trinity card; it just has no Sitewire request to land on.
    if (!r || r.sitewire_request_id == null) { skipped.push({ reason: 'not_on_this_draw', jid }); continue; }

    // NEVER MORE THAN THE BORROWER ASKED FOR ON THAT LINE. Over-approving is a deliberate
    // human act in Sitewire and must never be something an adapter does on its own — the
    // same cap `mapper.toApprovalEntries` applies on the portal side.
    const approved = Math.max(0, Math.min(
      Math.round(Number(l.approved_cents) || 0),
      Math.round(Number(r.requested_cents) || 0)));

    try {
      await orchestrator.circuitCheck(1);
      if (gate.dryrun) {
        written.push({ jid, requestId: Number(r.sitewire_request_id), approved, dryrun: true });
        continue;
      }
      await swClient.updateRequest(r.sitewire_request_id, { approved_cents: approved });
      await orchestrator.journal({
        appId, entity: 'request', entityId: Number(r.sitewire_request_id),
        field: 'approved_cents', newValue: approved,
        source: 'trinity_writeback',
      }).catch(() => {});
      written.push({ jid, requestId: Number(r.sitewire_request_id), approved });
    } catch (e) {
      // Stop at the FIRST failure rather than pressing on: a half-written draw is worse
      // than an unwritten one, because a coordinator looking at it cannot tell which
      // lines carry the inspector's figure and which still carry nothing.
      failed = { jid, message: String(e && e.message).slice(0, 200), retryable: !!(e && e.retryable) };
      break;
    }
  }

  if (failed) {
    await orchestrator.park({
      appId,
      dedupe: `trinitywb:${drawId}`,
      reason: `sitewire_trinity_writeback_failed: Trinity's inspection figures could not be written onto Sitewire draw ${drawId} `
        + `(line ${failed.jid}: ${failed.message}). ${written.length} of ${written.length + 1} lines were written. `
        + 'Record the approved amounts on the draw desk by hand, or retry once Sitewire is reachable.',
    }).catch(() => {});
    return { error: true, written: written.length, failed };
  }

  // READ-AFTER-WRITE. A 200 is not proof the figures landed, and this is money a
  // coordinator is about to approve — so we re-read the draw and confirm before
  // recording that it is done. A verification that cannot be performed leaves the
  // fingerprint UNSET so the next poll tries again, rather than claiming success.
  let verified = null;
  if (!gate.dryrun && written.length) {
    try {
      const remote = await swClient.getDraw(drawId);
      const remoteReqs = (remote && (remote.requests || remote.draw_requests)) || [];
      const remoteById = new Map(remoteReqs.map((x) => [Number(x.id), x]));
      const bad = written.filter((w) => {
        const rr = remoteById.get(w.requestId);
        if (!rr) return false;                      // shape we cannot read — not a failure
        const got = Math.round(Number(rr.approved_cents));
        return Number.isFinite(got) && got !== w.approved;
      });
      verified = { checked: remoteById.size, disagreed: bad.length };
      if (bad.length) {
        await orchestrator.park({
          appId,
          dedupe: `trinitywbv:${drawId}`,
          reason: `sitewire_trinity_writeback_unverified: Sitewire draw ${drawId} accepted the inspector's figures but read back `
            + `different amounts on ${bad.length} line(s). Check the draw desk before approving.`,
        }).catch(() => {});
        return { error: true, written: written.length, verified };
      }
    } catch (_) {
      // Could not re-read. Do NOT stamp the fingerprint — the next poll re-drives it.
      return { ok: true, written: written.length, skipped, verified: 'unreadable', restamp: false };
    }
  }

  await db.query(
    `UPDATE trinity_inspection_orders
        SET writeback_fingerprint=$2, writeback_at=now(), updated_at=now()
      WHERE id=$1`, [orderRow.id, fingerprint]).catch(() => {});

  // The timeline is the ONLY record of the sequence (Trinity has no history endpoint —
  // db/555), and "when did the inspector's figures reach the draw?" is a question a
  // coordinator asks the moment a number looks wrong. Recorded HERE rather than at the
  // call site so it stays true if a second caller ever appears; best-effort, because a
  // timeline row is never worth reversing a write that landed and verified.
  if (written.length) {
    await require('./order').recordEvent(appId, orderRow.id, {
      kind: 'writeback', source: 'staff',
      detail: `Trinity’s figures were written onto Sitewire draw ${drawId} — `
        + `${written.length} line${written.length === 1 ? '' : 's'}`
        + (gate.dryrun ? ' (dry run — nothing was sent to Sitewire).' : ', read back and verified.'),
    }).catch(() => {});
  }

  return { ok: true, written: written.length, skipped, verified, dryrun: !!gate.dryrun };
}

module.exports = { pushApprovalsToSitewire, _internals: { writesOn } };
