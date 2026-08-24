'use strict';
/**
 * THE IO HALF OF A DRAW EMAIL — load the file's money once, hand it to the pure composer.
 *
 * `lib/email/draw-email.js` decides what a draw email SHOWS; this decides where the numbers come
 * from. They are separate files because the composer must stay unit-testable with no database,
 * and because this half is the part that must never, ever grow arithmetic of its own.
 *
 * THERE IS NO NEW MONEY PATH HERE, AND THAT IS THE ENTIRE POINT. The figures come out of
 * `rollup.loadRollup()` — the same call the draw desk, the borrower's screen, the branded PDF and
 * the Excel packet already read, and whose per-draw entries are built by `approval.drawMoney()`,
 * the ONE source of per-draw money (CLAUDE.md draw rule 13). So an email can never quote a figure
 * that disagrees with the report attached to it, or with the screen the reader opens next. A
 * second query that "just adds up the requests" here would be the exact bug the release-headline
 * work spent a whole session removing.
 *
 * NEVER THROWS. A notification path must not fail because a rollup could not be read — the email
 * still goes, just without its figure band. Every caller can treat the result as optional.
 */

const rollupMod = require('./rollup');
const APPROVAL = require('./approval');
const drawEmail = require('../lib/email/draw-email');
const parked = require('../trustpoint/parked');

/**
 * A TrustPoint-administered draw, expressed in the ONE money vocabulary.
 *
 * TrustPoint and Sitewire number draws independently (`trustpoint_draws.tp_draw_id` vs
 * `sitewire_draws.sitewire_draw_id`), and a TrustPoint file may have no Sitewire rollup entry at
 * all. Feeding a `tp_draw_id` to the rollup lookup would therefore either find nothing — or, far
 * worse, find a DIFFERENT draw that happens to carry that number and put another draw's money in
 * the email. So a TrustPoint row is converted HERE, through `drawMoney`, rather than the caller
 * hand-building figures: one money definition, two sources.
 */
function moneyFromTrustpoint(row) {
  if (!row) return null;
  // PARKED → a TrustPoint figure never reaches a reader (owner-directed 2026-08-24). The mirror
  // is already switched off upstream, so in practice nothing calls this while parked — this is
  // the belt to that brace, and it belongs HERE rather than at the callers because this is the
  // ONE place a TrustPoint row becomes money in an email. Rows already mirrored stay in the
  // database; they simply stop being stated. Required at the top, not lazily: `parked` is pure
  // with no requires of its own, so it cannot cycle and cannot fail to load — and a lazy require
  // wrapped in a catch would fail OPEN, stating the very figure this exists to withhold.
  if (parked.isParked()) return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const approved = n(row.approved_cents);
  // The administrator's own fee lines on THIS draw, through the mirror's one reader (which already
  // rejects a boolean/array/object in an amount slot — Number(true) === 1). Lazily required: this
  // module is loaded on email paths that have nothing to do with TrustPoint, and a failure here may
  // never cost the email — an unreadable fee is simply unknown.
  let tpFee = null;
  try {
    const lines = require('../trustpoint/mirror')._feeLinesCents(row.fees);
    if (Array.isArray(lines) && lines.length) tpFee = Math.max(0, lines.reduce((s, c) => s + n(c), 0));
  } catch (_) { tpFee = null; }
  const m = APPROVAL.drawMoney({
    draw: {
      total_requested_cents: n(row.requested_cents),
      total_approved_cents: approved,
      status: row.status === 'APPROVED' || row.status === 'COMPLETED' ? 'approved' : String(row.status || ''),
      number: row.number,
    },
    // TrustPoint states the inspector's approved total directly; there are no per-line request
    // rows on our side to re-derive it from, so it is passed as the single approved line.
    requests: approved > 0 ? [{ requested_cents: n(row.requested_cents), approved_cents: approved }] : [],
    // `to_disburse_cents` is TrustPoint's own net — the administrator's arithmetic, already net of
    // their fees. It is authoritative for what actually wires, so it is passed as the net rather
    // than recomputed from a fee we did not charge.
    netReleaseCents: row.to_disburse_cents != null ? n(row.to_disburse_cents) : null,
    // THE FEE TRUSTPOINT ITSELF STATES, off the draw's own fee lines. Passing nothing here had two
    // consequences and both reached the reader: the email printed "no draw fee on this release" on
    // a draw whose wire IS net of the administrator's fee, and — whenever `to_disburse_cents` is
    // absent, which `mirror.mirrorDisbursement` records TrustPoint does not always publish — the
    // net fell back to the approved total, OVERSTATING the wire by exactly that fee. Same source
    // `verifyPartnerFee` compares against the agreed rule, so the email and that check can never
    // read different fees. Nothing readable → the fee is UNKNOWN, not zero, and the wording says so.
    feeCents: tpFee != null ? tpFee : 0,
    feeKnown: tpFee != null,
    feeRecorded: tpFee != null,
    released: !!row.disbursed_at,
  });
  m.number = row.number;
  return m;
}

/**
 * A PORTAL-originated draw request, expressed in the ONE money vocabulary.
 *
 * A portal request (§5B — the borrower's or the staff composer's line-item pick on a physical-
 * inspection file) does not exist in Sitewire until it is closed out as a historical draw, so it
 * has no rollup entry to read. Its OWN row is the source of record in the meantime, and it is
 * converted here — through the same `drawMoney` — rather than the caller hand-building figures.
 *
 * THE STATUS IT IS GIVEN IS DELIBERATE. An approved portal request is NOT passed as `approved`
 * (which `drawMoney` reads as our FINAL approval): that would make the composer lead with a
 * "to be released" headline and, with no fee resolved on this path, state "no draw fee on this
 * release" — a claim we cannot make, because the file's draw fee is netted out later by the
 * close-out. `pending_capital_partner` is the honest reading: a decision has been recorded and
 * the release has not happened yet, so the APPROVED amount leads and no net is promised.
 */
function moneyFromPortalRequest(row) {
  if (!row) return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const decided = row.status === 'approved' || row.status === 'closed_out';
  const lines = Array.isArray(row.lines) ? row.lines : [];
  const m = APPROVAL.drawMoney({
    draw: {
      total_requested_cents: n(row.total_requested_cents),
      total_approved_cents: row.approved_cents != null ? n(row.approved_cents) : 0,
      status: decided ? 'pending_capital_partner' : 'inspecting',
    },
    // The per-line decision, once there is one. A null approved amount on a line means "not
    // answered yet" and must stay null — `inspectorApproved` reads that as "no amounts", never
    // as a confident $0.
    requests: decided
      ? lines.map((l) => ({
        requested_cents: n(l && l.requested_cents),
        approved_cents: (l && l.approved_cents != null) ? n(l.approved_cents) : null,
      }))
      : [],
  });
  m.number = `P${row.id}`;
  return m;
}

/**
 * Build {figures, facts, stage, copy, money} for one draw, or null if it cannot be resolved.
 *
 * @param db              a pg pool/client
 * @param appId           the application
 * @param sitewireDrawId  the draw; when null the FILE-level blocks are built (facts only — the
 *                        project's budget picture, with no per-draw money, because there is no
 *                        single draw to be the headline)
 * @param borrower        borrower voice (never names the capital partner) vs the staff voice
 * @param tpDraw          a `trustpoint_draws` row, for a TrustPoint-administered draw
 * @param portalRequest   a `portal_draw_requests` row, for a draw that has not reached Sitewire yet
 */
async function drawEmailBlocks(db, appId, { sitewireDrawId = null, borrower = false, tpDraw = null, portalRequest = null } = {}) {
  try {
    // The SOW state supplies the human labels for the budget lines. Optional everywhere else, so
    // a file whose Scope of Work has not been built still rolls up.
    let sowState = null;
    try {
      const s = (await db.query(
        `SELECT tool_payload FROM checklist_items WHERE application_id=$1 AND tool_key='rehab_budget' ORDER BY created_at LIMIT 1`,
        [appId])).rows[0];
      sowState = s && s.tool_payload && s.tool_payload.state ? s.tool_payload.state : null;
    } catch (_) { /* labels only */ }

    const rollup = await rollupMod.loadRollup(db, appId, { sowState });
    if (!rollup) return null;

    const draws = Array.isArray(rollup.draws) ? rollup.draws : [];
    // The Sitewire rollup is preferred — it is the same object the desk, the screen and the PDFs
    // read. A TrustPoint-administered draw falls back to its own row (converted through the same
    // `drawMoney`), so an email never loses its numbers just because the file is on the other
    // platform. NEVER match a tp_draw_id against sitewire_draw_id — different id spaces.
    const money = (sitewireDrawId != null
      ? draws.find((d) => Number(d.sitewire_draw_id) === Number(sitewireDrawId)) || null
      : null) || moneyFromTrustpoint(tpDraw) || moneyFromPortalRequest(portalRequest);

    // The dates a draw email should carry. Read from the draw row itself rather than the rollup,
    // which is a money view and deliberately carries no inspection/release timestamps.
    let dates = {};
    if (sitewireDrawId != null) {
      try {
        const r = (await db.query(
          `SELECT d.submitted_at, d.approved_at,
                  (SELECT max(f.delivered_at) FROM draw_findings f
                    WHERE f.application_id=$1 AND f.sitewire_draw_id=$2) AS inspected_at,
                  (SELECT max(dd.release_date) FROM draw_disbursements dd
                    WHERE dd.application_id=$1 AND dd.sitewire_draw_id=$2 AND dd.kind='draw'
                      AND dd.funded_status='released') AS released_at,
                  -- wire_due_at lives on draw_findings (the promise made when the findings were
                  -- delivered), NOT on the disbursement ledger. Reading it off the wrong table
                  -- throws, and this whole block is inside a catch — so the mistake would have
                  -- silently emptied the facts box rather than failed loudly. Pinned by a test.
                  (SELECT max(f2.wire_due_at) FROM draw_findings f2
                    WHERE f2.application_id=$1 AND f2.sitewire_draw_id=$2) AS wire_due_at
             FROM sitewire_draws d
            WHERE d.application_id=$1 AND d.sitewire_draw_id=$2 LIMIT 1`, [appId, sitewireDrawId])).rows[0];
        if (r) dates = r;
      } catch (_) { /* a missing date is simply a row the facts box omits */ }
    }

    const figures = money ? drawEmail.drawFigures(money, { borrower }) : null;
    const facts = drawEmail.drawFacts({
      money, rollup, dates, borrower,
      draw: money ? { number: money.number } : null,
    });
    const stage = money ? money.approval_stage : null;

    return {
      money, rollup, figures, stage,
      facts: (facts && (facts.rows.length || facts.progress)) ? facts : null,
      copy: stage ? drawEmail.stageCopy(stage, { borrower }) : null,
    };
  } catch (e) {
    // A notification must never fail because its decoration could not be built.
    console.error('[draw-email] blocks', appId, sitewireDrawId, (e && e.message) || e);
    return null;
  }
}

module.exports = { drawEmailBlocks, _internals: { moneyFromTrustpoint, moneyFromPortalRequest } };
