'use strict';

/**
 * LOAN SOLD — the post-funding stage, its date, and the one rule for who gets it.
 *
 * Owner-directed 2026-08-21: *"We need to enhance our system with the status Loan Sold: only for
 * loans that are not table funded. Loans that are table funded should not have such a status … The
 * files that are being sold should have a status of 'Sold', and that status should automatically
 * change when the PA date is filled. You can backfill this on the table."*
 *
 * IT IS A STAGE ON TOP OF FUNDED, NOT A REPLACEMENT FOR IT — see db/611 for the full reasoning.
 * A sold loan is still funded and still serviced by us: every draw continues, the investor
 * delivery continues. `applications.status` is the SERVICING state and 139 places read it, 27 of
 * them testing `funded` in SQL — the purchase-advice sweep itself among them — so moving the
 * stored status would switch all of that off silently. The stage is recorded on `sold_at` and
 * DISPLAYED as the file's status wherever a status is shown.
 *
 * TABLE FUNDING IS NOT RESTATED HERE. Which loans may be table funded is `funding-channel.js`,
 * and whether THIS loan was is `release-party.soldStatus` — the same answer the draw desk's
 * "who releases the money" card shows. Asking those keeps one definition; a local test would be a
 * second copy, and the one that drifts is the one that stamps a table-funded loan as newly sold
 * months after it closed.
 */

const SOURCE = Object.freeze({
  ENCOMPASS_PA: 'encompass_pa',   // the purchase advice date Encompass carries
  DESK: 'desk',                   // our own purchasing desk recorded the advice
  MANUAL: 'manual',               // a human said so
});

const SOURCE_LABEL = Object.freeze({
  encompass_pa: 'the purchase advice date in Encompass',
  desk: 'the purchasing desk’s own record',
  manual: 'recorded by hand',
});

/** The label the file shows. One word, because it sits where a status sits. */
const SOLD_LABEL = 'Sold';

/**
 * WHAT A FILE'S STATUS SHOULD SAY, given the stored status and the sold stage.
 *
 * PURE. Returns the stored status untouched for every file that is not a sold, funded one — so a
 * screen can call it unconditionally and nothing else on the pipeline moves.
 */
function displayStatus(row) {
  const r = row || {};
  if (r.sold_at && r.status === 'funded') return 'sold';
  return r.status || null;
}

/** The same question, as a boolean, for a screen that wants to badge rather than relabel. */
const isSold = (row) => !!(row && row.sold_at);

/**
 * SHOULD THIS FILE BE MARKED SOLD, AND ON WHAT DATE — pure, so the whole rule is testable
 * without a database or a network.
 *
 * @param {object} row     { status, sold_at, purchase_advice_date, deleted_at }
 * @param {object} sold    what `release-party.soldStatus` said about this file
 * @returns {{mark?:string, source?:string, clear?:boolean, skipped?:string}}
 */
function decideSold(row, sold) {
  const r = row || {};
  if (r.deleted_at) return { skipped: 'deleted' };
  /* A LOAN IS NOT SOLD BEFORE IT IS FUNDED. Every source of a sale date here describes something
     that happens after closing, so a date on a file that has not funded is a data error rather
     than a sale, and stamping it would put "Sold" on a live pipeline file. */
  if (r.status !== 'funded') return { skipped: 'not_funded' };

  /* TABLE FUNDED NEVER GETS THE STAGE — the owner's exclusion, in the one place it is decided.
     `soldStatus` answers `sold` for a table-funded loan (it WAS sold, at the table), so the
     stage cannot be keyed on "is it sold" alone; it is keyed on HOW. */
  const via = sold && sold.via;
  /* `releaseStateFor` reports table funding BOTH ways — as `tableFunded` and as the
     `table_funding` via — and a caller may pass either spelling. Both are the exclusion. */
  if (via === 'table_funded' || via === 'table_funding') return { skipped: 'table_funded' };

  const date = (sold && sold.paDate) || r.purchase_advice_date || null;
  if (!date) {
    /* THE STAGE IS CLEARED WHEN ITS EVIDENCE GOES. A purchase advice date can be corrected away
       in Encompass, and a file left reading "Sold" on evidence that no longer exists is the same
       class of confident-wrong-answer the read-state work exists to stop. */
    return r.sold_at ? { clear: true } : { skipped: 'not_sold_yet' };
  }
  const iso = String(date).slice(0, 10);
  if (r.sold_at && String(r.sold_at).slice(0, 10) === iso) return { skipped: 'unchanged' };
  return { mark: iso, source: via === 'our_purchase_advice' ? SOURCE.DESK : SOURCE.ENCOMPASS_PA };
}

/**
 * Apply the decision to one file: stamp (or clear) the stage, record the history, move the
 * ClickUp card and tell the team.
 *
 * `announce:false` is what the back-book backfill passes — see `backfillSoldOnce`. Never throws:
 * this rides the purchase-advice sync, which is itself best-effort on a pull.
 */
async function syncSoldStage(db, appId, { announce = true, client = null } = {}) {
  const q = client || db;
  try {
    const row = (await q.query(
      `SELECT id, status, sold_at, purchase_advice_date, deleted_at FROM applications WHERE id=$1`,
      [appId])).rows[0];
    if (!row) return { skipped: 'no_file' };

    /* HOW THIS LOAN FUNDED, from the ONE place that answers it — `releaseStateFor` is what the
       draw desk's own "who releases the money" card reads, so this and that card can never
       disagree about whether a loan was table funded. */
    const releaseParty = require('../sitewire/release-party');
    let state = null;
    try { state = await releaseParty.releaseStateFor(q, appId); }
    catch (_) { state = null; }
    const sold = state ? { via: state.tableFunded ? 'table_funded' : state.soldVia, paDate: state.paDate } : null;
    /* FAIL CLOSED ON AN UNREADABLE ANSWER. Without knowing HOW a loan funded we cannot tell a
       table-funded one from a sold one, and stamping the stage on a guess is exactly what the
       owner excluded. */
    if (!sold) return { skipped: 'unreadable' };

    const plan = decideSold(row, sold);
    if (plan.skipped) return { skipped: plan.skipped };

    if (plan.clear) {
      const r = await q.query(
        `UPDATE applications SET sold_at=NULL, sold_source=NULL, updated_at=now()
          WHERE id=$1 AND sold_at IS NOT NULL RETURNING id`, [appId]);
      return { cleared: !!(r && r.rowCount) };
    }

    const r = await q.query(
      `UPDATE applications SET sold_at=$2::date, sold_source=$3, updated_at=now()
        WHERE id=$1 AND deleted_at IS NULL
          AND (sold_at IS NULL OR sold_at IS DISTINCT FROM $2::date)
        RETURNING id`, [appId, plan.mark, plan.source]);
    if (!r || !r.rowCount) return { skipped: 'unchanged' };

    if (announce) {
      /* THE CARD FOLLOWS, through the ONE post-closing stage mover — the same call the purchase
         advice sync already makes, so a file cannot be Sold here and somewhere else in ClickUp. */
      try {
        await require('../clickup/post-closing-stage')
          .advanceCard(appId, 'sold', { client: client || undefined, reason: 'sold_stage' });
      } catch (_) { /* the card is best-effort */ }
      try {
        await require('./notify').notifyAppStaff(appId, {
          type: 'status_change',
          title: 'This loan is now marked Sold',
          body: `PILOT read ${SOURCE_LABEL[plan.source] || 'the purchase advice'} and marked this loan SOLD as of ${plan.mark}. `
            + 'It stays a funded, serviced file — draws and investor delivery are unchanged.',
          applicationId: appId,
          link: `/internal/app/${appId}`,
        });
      } catch (_) { /* best-effort */ }
    }
    return { marked: plan.mark, source: plan.source };
  } catch (e) {
    return { skipped: (e && e.message) ? String(e.message).slice(0, 120) : 'error' };
  }
}

/**
 * THE BACK BOOK — the owner's *"You can backfill this on the table. All the previous files that
 * have a PA date filled … update the status."*
 *
 * SILENT, DELIBERATELY (`announce:false`). Every file it reaches was sold weeks or months ago;
 * announcing them would fan a "this loan is now Sold" notice across the whole funded book on the
 * first deploy and move every ClickUp card at once — a blast dressed as a notification, which is
 * the exact mistake the purchase-advice sweep's silent first read exists to avoid. The stage still
 * lands, so every screen reads correctly from that moment; only the announcement is withheld.
 *
 * Bounded and self-draining: it looks only at funded files that have a purchase advice date and no
 * stage yet, so once they are stamped the query returns nothing and the pass costs one index scan.
 * Never throws — a boot pass may not break boot.
 */
async function backfillSoldOnce(db, { limit = 500 } = {}) {
  const out = { looked: 0, marked: 0, skipped: 0 };
  try {
    const rows = (await db.query(
      `SELECT id FROM applications
        WHERE deleted_at IS NULL
          AND status = 'funded'
          AND purchase_advice_date IS NOT NULL
          AND sold_at IS NULL
        ORDER BY purchase_advice_date
        LIMIT $1`, [Math.max(1, Math.min(2000, Number(limit) || 500))])).rows;
    for (const r of rows) {
      out.looked += 1;
      const res = await syncSoldStage(db, r.id, { announce: false });
      if (res && res.marked) out.marked += 1; else out.skipped += 1;
    }
    return out;
  } catch (e) {
    out.error = (e && e.message) ? String(e.message).slice(0, 120) : 'error';
    return out;
  }
}

module.exports = {
  SOURCE, SOURCE_LABEL, SOLD_LABEL,
  displayStatus, isSold, decideSold, syncSoldStage, backfillSoldOnce,
};
