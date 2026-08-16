'use strict';
/**
 * FINAL APPROVE FINISHES THE DRAW — the money ledger, when the INVESTOR releases
 * (owner-directed 2026-08-09: "the last step that we have access to do on the draws is final
 * approved, and since, by default, we don't release the wire, final approved means, technically,
 * the wire is released for now" … "if it's released directly by the investor, then the final
 * approval means that the investor approves it, and they're going to release it and wire us the
 * fee. The money ledger should just save our fee and this date related to this property, how much
 * money we're supposed to make from the investor directly").
 *
 * THE GAP. `draw_disbursements` only ever got a row when a human typed one in — the wire WE sent.
 * The default is now that the INVESTOR wires the borrower directly, and on those draws nobody
 * types anything, so the draw left NO financial record at all. That is not merely a missing
 * report: `src/lib/tapes/assemble.js` reads released draws to work out a SOLD loan's current
 * balance and current rehab for the capital provider's data tape, so an investor-released draw
 * made every one of those tapes understate what has actually been drawn.
 *
 * WHAT THIS DOES, AND ONLY WHEN THE INVESTOR RELEASES. On final approve, PILOT writes the ledger
 * row itself — because on those files the final approval IS the release. The row carries the FULL
 * record (approved / fee / retainage / net to the borrower / released / release date), which is
 * what the data tape needs, PLUS the receivable the owner asked for: `fee_receivable_cents`,
 * `fee_status='owed'` and the note buyer, so "how much are the investors supposed to send us, and
 * for which property" is one query.
 *
 * WHEN **WE** RELEASE, THIS WRITES NOTHING. The manual `POST /disbursements` stays exactly as it
 * is — that is the wire we actually send, and a human records it. A `manual` delivery likewise
 * writes nothing: PILOT did not witness that money moving and must not claim to know.
 *
 * EVERY MONEY GUARD IS REUSED, NOT BYPASSED: `money.computeRelease` (the fee, the retainage, the
 * out-of-pocket floor and the running prior-approved total), the per-file advisory lock, and the
 * one-release-per-draw unique index — which is also what makes this idempotent against a manual
 * entry, a TrustPoint-observed release, and a second final approve.
 *
 * THE MONEY IS NEVER RECOMPUTED. The approved amount and the fee come from `rollup.loadRollup` →
 * `approval.drawMoney`, the same figures the desk, the borrower's screen, the branded report and
 * the Excel packet read; `computeRelease` then splits them exactly as the manual route does. So a
 * draw's ledger row can never disagree with the report attached to its own email.
 *
 * Never throws. A failure here must never reverse or 500 a final approval that already happened
 * in Sitewire — it returns a reason instead, and the coordinator can still record the release by
 * hand exactly as before.
 */

const db = require('../db');
const RP = require('./release-party');
const SETTINGS = require('./draw-settings');   // retainage % + the lien-waiver switch, ONE definition
const { computeRelease, waiverGate } = require('./money');
// The investor's cut of OUR draw fee — the ONE definition, shared with the hand-recorded release.
const INVESTOR_FEE = require('./investor-fee');

const N = (x) => Number(x || 0) || 0;
const usd = (c) => '$' + (Math.round(N(c)) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Today as a plain calendar string in New York — the day the desk would have typed. */
function todayNy() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const g = (t) => (p.find((x) => x.type === t) || {}).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

/**
 * Record the investor's release for one finally-approved draw.
 *
 * Returns one of:
 *   { skipped: <reason> }                      nothing to do (and nothing was written)
 *   { recorded, row, money, waiversMissing }   a ledger row exists for this draw
 *
 * `waiversMissing` is non-empty when the lien-waiver gate did not pass: the row is still written,
 * as `held` rather than `released`, so the money is never silently unrecorded AND never silently
 * reported as released. The caller alerts the coordinator naming the outstanding waivers.
 */
async function recordInvestorRelease(appId, drawId, { staffId = null, note = null } = {}) {
  try {
    if (!appId || drawId == null || !/^\d+$/.test(String(drawId))) return { skipped: 'bad_args' };

    // 1. Does the INVESTOR release this draw's money? Anything else — we release, a manual
    //    delivery, or an answer we could not read — writes nothing.
    const release = await RP.releaseStateFor(db, appId, { sitewireDrawId: drawId });
    if (!release || !release.autoLedger) return { skipped: 'not_investor_released' };

    // 2. A TrustPoint-administered file's releases are OBSERVED from the administrator's own
    //    disbursements (src/trustpoint/mirror.js) — that mirror is the record there, and its rows
    //    are already stamped release_party='investor'. Writing here as well would be a second
    //    claim about one wire; the unique index would refuse it, but refusing is not the same as
    //    never asking, and the mirror's row carries the administrator's real figures.
    try {
      const rp = await require('./routing').resolveFilePlatform(appId);
      if (rp && rp.platform === 'trustpoint') return { skipped: 'trustpoint_administered' };
      // `resolved:false` means we could not actually look. Never fail open on money.
      if (rp && rp.resolved === false) return { skipped: 'platform_unreadable' };
    } catch (_) { return { skipped: 'platform_unreadable' }; }

    // 3. The draw must really be finally approved, with a real approved amount. reconcileOne is
    //    best-effort, so a mirror that has not caught up yet would look like a $0 approval — and a
    //    $0 ledger row would tell the data tape this draw drew nothing.
    const rollupMod = require('./rollup');
    let sowState = null;
    try {
      const s = (await db.query(`SELECT tool_payload FROM checklist_items WHERE application_id=$1 AND tool_key='rehab_budget' ORDER BY created_at LIMIT 1`, [appId])).rows[0];
      sowState = s && s.tool_payload && s.tool_payload.state ? s.tool_payload.state : null;
    } catch (_) {}
    const rollup = await rollupMod.loadRollup(db, appId, { sowState });
    const d = (rollup && rollup.draws || []).find((x) => String(x.sitewire_draw_id) === String(drawId));
    if (!d) return { skipped: 'draw_not_in_rollup' };
    if (!d.is_final_approved) return { skipped: 'not_final_approved' };
    const approved = Math.max(0, Math.round(N(d.final_approved_cents) || N(d.approved_cents)));
    if (approved <= 0) return { skipped: 'nothing_approved' };
    const fee = Math.max(0, Math.round(N(d.fee_cents)));

    // 4. Already recorded? Both shapes the manual route checks: a direct row for this draw, and a
    //    TrustPoint-observed row that mirrored before its draw tie landed.
    if ((await db.query(`SELECT 1 FROM draw_disbursements WHERE sitewire_draw_id=$1 AND kind='draw'`, [drawId])).rowCount) {
      return { skipped: 'already_recorded' };
    }
    if ((await db.query(
      `SELECT 1 FROM draw_disbursements dd JOIN trustpoint_draws t ON t.tp_draw_id = dd.trustpoint_draw_id
        WHERE dd.kind='draw' AND (t.sitewire_draw_id=$1
           OR t.portal_draw_request_id IN (SELECT id FROM portal_draw_requests WHERE sitewire_draw_id=$1))`, [drawId])).rowCount) {
      return { skipped: 'already_recorded_by_administrator' };
    }

    // The note buyer, keyed the SAME way every other note-buyer lookup in this codebase keys it,
    // so the fees-owed list and the conditions engine agree about who owes us.
    const app = (await db.query(`SELECT lender FROM applications WHERE id=$1`, [appId])).rows[0] || {};
    let buyerKey = null;
    try { buyerKey = require('../lib/conditions/field-registry').normNoteBuyer(app.lender) || null; } catch (_) {}

    // The SAME resolvers the manual release route uses — never a second copy. `investorRates` is the
    // owner's admin-settings table (db/545) — read here, outside the money transaction, so a release
    // PILOT books itself uses the same rates a coordinator sees on the screen.
    const investorRates = await INVESTOR_FEE.loadConfiguredRates(db);
    const pct = await SETTINGS.retainagePctFor(appId);
    const lienOn = await SETTINGS.lienGateEnabled(appId);

    // 5. The money transaction, byte-for-byte the manual route's shape: the per-file advisory lock
    //    so two draws recorded at once cannot both read the same running prior-approved total and
    //    each under-reimburse against the out-of-pocket floor.
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`sw-disb:${appId}`]);
      // Read exactly as the manual release route reads it — unscoped is unambiguous here because
      // `application_id` is UNIQUE on this table, and the two paths writing one ledger must never
      // disagree about the floor.
      const floorCents = Number(((await client.query(`SELECT oop_floor_cents FROM sitewire_property_links WHERE application_id=$1`, [appId])).rows[0] || {}).oop_floor_cents) || 0;
      const priorApproved = Number((await client.query(`SELECT COALESCE(sum(approved_cents),0) s FROM draw_disbursements WHERE application_id=$1 AND kind='draw'`, [appId])).rows[0].s) || 0;
      const split = computeRelease({ approvedCents: approved, feeCents: fee, retainagePct: pct, oopFloorCents: floorCents, priorApprovedCents: priorApproved });
      // A split that cannot balance (a fee bigger than the reimbursable amount) is a real problem
      // for a human, not something to record a guess about.
      if (!split.ok) { await client.query('ROLLBACK'); return { skipped: 'split_violation', violation: split.violation }; }

      // 6. THE LIEN-WAIVER GATE STILL RUNS. The manual route REFUSES, because there is a human at
      //    it who can go and collect the waivers. Here there is nobody to refuse to: the money has
      //    already moved. So the row is recorded as HELD — never silently released, never silently
      //    dropped — and the caller alerts the coordinator naming exactly what is outstanding.
      let missing = [];
      if (lienOn) {
        const waivers = (await client.query(`SELECT status, tier, party_name, kind FROM draw_lien_waivers WHERE sitewire_draw_id=$1`, [drawId])).rows;
        const gate = waiverGate(waivers, { enabled: true });
        if (!gate.ok) missing = gate.missing;
      }
      const fundedStatus = missing.length ? 'held' : 'released';

      // 7. THE INVESTOR'S CUT OF OUR FEE (owner-directed 2026-08-13), through the SAME shared rule
      //    the hand-recorded release uses — so a release PILOT books itself and one a coordinator
      //    types can never book different income. It splits OUR fee only: the approved amount, the
      //    retainage and the borrower's net above are untouched. It applies only once the loan is
      //    actually sold to that buyer, which `release.soldEffective` already answered (the sold fact,
    //    or the draw desk's "process this file as sold"). This path only runs on an investor-released
    //    draw, which the same sold rule already restricts to a sold loan.
      const feeSplit = INVESTOR_FEE.splitFee({
        feeCents: fee,
        investorFeeCents: INVESTOR_FEE.defaultInvestorFeeCents({
          noteBuyer: release.noteBuyer || app.lender, sold: release.soldEffective, feeCents: fee, rates: investorRates,
        }),
      });

      // 8. THE RECEIVABLE. On an investor-released draw the investor wires the borrower the net and
      //    wires US the fee separately, so our fee is money we are owed rather than money we have
      //    already netted. `fee_cents` records what came out of the borrower's release (unchanged
      //    meaning); `fee_receivable_cents` records what the investor still owes us — and that is
      //    the NET fee, because a buyer who keeps $95 of our $299 sends us $204 and owes us $204,
      //    never $299. A Blue Lake draw, where they keep the whole fee, therefore owes us nothing
      //    and is 'n_a' — exactly how the observed TrustPoint rows have always been stamped. A draw
      //    with no fee left for us is 'n_a' too: an owed row of $0 would clutter the chase list
      //    forever.
      const owedToUs = feeSplit.net_fee_cents;
      const row = (await client.query(
        `INSERT INTO draw_disbursements
           (application_id, sitewire_draw_id, approved_cents, fee_cents, retainage_held_cents,
            net_release_cents, release_date, funded_status, kind, note, created_by,
            release_party, fee_receivable_cents, fee_status, note_buyer_label, note_buyer_key,
            investor_fee_cents, investor_fee_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draw',$9,$10,'investor',$11,$12,$13,$14,$15,$16) RETURNING *`,
        [appId, drawId, approved, fee, split.retainage_held_cents, split.net_release_cents,
          todayNy(), fundedStatus,
          (note ? String(note).slice(0, 1800) + ' — ' : '')
            + `Recorded automatically on final approval: ${app.lender || 'the investor'} releases this file's draws directly.`
            + (feeSplit.investor_fee_cents > 0
              ? ` They keep ${usd(feeSplit.investor_fee_cents)} of our ${usd(fee)} draw fee, so ${usd(owedToUs)} is due to us.`
              : ''),
          staffId, owedToUs > 0 ? owedToUs : 0, owedToUs > 0 ? 'owed' : 'n_a', app.lender || null, buyerKey,
          feeSplit.investor_fee_cents,
          feeSplit.investor_fee_cents > 0 ? (INVESTOR_FEE.ruleFor(release.noteBuyer || app.lender, investorRates) || {}).key || null : null])).rows[0];
      await client.query('COMMIT');
      return { recorded: true, row, money: split, waiversMissing: missing, release };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      // The unique index caught a race with a manual entry — which is the right outcome, not an error.
      if (e && e.code === '23505') return { skipped: 'already_recorded' };
      throw e;
    } finally { client.release(); }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[sitewire] auto release ledger:', e && e.message);
    return { skipped: 'error', error: e && e.message };
  }
}

// ---------------------------------------------------------------------------
// Fees owed by investors — a REPORT, never a gate
// ---------------------------------------------------------------------------

/**
 * Every draw whose fee the investor still owes us, oldest first. Cross-file, because this is an
 * accounting question ("how much are we supposed to make, from whom, on which property") and not a
 * per-file one. A REPORT — nothing here gates anything.
 *
 * `scopeWhere` / `scopeParams` come from the ROUTE's own file-scope builder (the same one the
 * portfolio uses) so an officer sees exactly the files they may see, and this module never has to
 * know how visibility is decided. Callers with no viewer — the chase reminder — pass nothing.
 */
async function feesOwed({ scopeWhere = '', scopeParams = [], olderThanDays = null, limit = 500 } = {}) {
  const params = [].concat(scopeParams || []);
  let ageClause = '';
  if (Number.isFinite(Number(olderThanDays)) && Number(olderThanDays) > 0) {
    params.push(Math.round(Number(olderThanDays)));
    ageClause = ` AND COALESCE(dd.release_date, dd.created_at::date) <= CURRENT_DATE - ($${params.length}::int)`;
  }
  const rows = (await db.query(
    `SELECT dd.id, dd.application_id, dd.sitewire_draw_id, dd.fee_receivable_cents, dd.release_date,
            dd.created_at, dd.note_buyer_label, dd.note_buyer_key, dd.fee_status,
            sd.number AS draw_number,
            a.ys_loan_number, a.property_address->>'oneLine' AS address, a.lender,
            GREATEST(0, (CURRENT_DATE - COALESCE(dd.release_date, dd.created_at::date)))::int AS days_outstanding
       FROM draw_disbursements dd
       LEFT JOIN sitewire_draws sd ON sd.sitewire_draw_id = dd.sitewire_draw_id
       JOIN applications a ON a.id = dd.application_id
      WHERE dd.fee_status = 'owed' AND a.deleted_at IS NULL${scopeWhere}${ageClause}
      ORDER BY COALESCE(dd.release_date, dd.created_at::date) ASC
      LIMIT ${Number(limit) > 0 ? Math.min(2000, Math.round(Number(limit))) : 500}`,
    params)).rows;
  const total = rows.reduce((s, r) => s + N(r.fee_receivable_cents), 0);
  // Grouped by investor too — "who owes us what" is the question an accountant actually asks.
  const byBuyer = new Map();
  for (const r of rows) {
    const k = r.note_buyer_key || 'unknown';
    const e = byBuyer.get(k) || { key: k, label: r.note_buyer_label || r.lender || 'Unknown investor', count: 0, cents: 0, oldest_days: 0 };
    e.count += 1; e.cents += N(r.fee_receivable_cents);
    e.oldest_days = Math.max(e.oldest_days, Number(r.days_outstanding) || 0);
    byBuyer.set(k, e);
  }
  return { rows, total_cents: total, count: rows.length, by_buyer: [...byBuyer.values()].sort((a, b) => b.cents - a.cents) };
}

/**
 * Mark a fee received. Only ever moves 'owed' → 'received', so a second click is a no-op rather
 * than re-dating a fee that was already settled, and a fee that was never owed (a we-release draw,
 * or a TrustPoint fee that is not our revenue) can never be marked received by accident.
 */
async function markFeeReceived(disbursementId, { receivedDate = null, staffId = null } = {}) {
  const day = receivedDate || todayNy();
  const r = await db.query(
    `UPDATE draw_disbursements SET fee_status='received', fee_received_date=$2::date, updated_at=now()
      WHERE id=$1 AND fee_status='owed' RETURNING *`, [disbursementId, day]);
  if (!r.rowCount) return { changed: false };
  try {
    await require('./orchestrator').journal({
      appId: r.rows[0].application_id, entity: 'draw', entityId: Number(r.rows[0].sitewire_draw_id) || null,
      field: 'investor_fee_received', oldValue: { fee_status: 'owed' },
      newValue: { fee_status: 'received', date: day, cents: N(r.rows[0].fee_receivable_cents), actor: staffId },
      source: 'money_override' });
  } catch (_) {}
  return { changed: true, row: r.rows[0] };
}

module.exports = { recordInvestorRelease, feesOwed, markFeeReceived, _internals: { todayNy, usd } };
