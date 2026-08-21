'use strict';

/**
 * THE FUNDED DATE READS ITSELF OFF ENCOMPASS (owner-reported 2026-08-21: *"right now
 * you need to enter a funded date in PILOT, and PILOT does not automatically recognize
 * from Encompass the funded date. We need to make sure that whenever it is set up on an
 * automatic basis, whatever the setup is, no matter how long it is, we check any file
 * that gets the funded date in Encompass filled — which I believe is cx.fundeddate — it
 * should automatically fill in the funded date for that file in PILOT and should
 * automatically change the status for that file, but it should still not be reconciled,
 * because reconciled will also require making sure ClickUp matches as well."*)
 *
 * WHAT WAS ALREADY TRUE, AND WHY THE GAP SURVIVED. `CX.FUNDEDDATE` has been READ on every
 * Encompass pull since the field map was written — `encompass-field-map` carries it as a
 * `compare:'reference'` row and `closing.readEncompassFundedDate` digs it back out of the
 * stored loan for the closing desk's three-system reconciliation. So the value was on the
 * screen the whole time and NOTHING ever wrote it onto the file: the closer retyped, by
 * hand, a date PILOT was already holding. Nothing errored, which is exactly why it lasted.
 *
 * THE WRITE DIRECTION IS THE SANCTIONED ONE. Encompass is READ-ONLY and this is the
 * hardest rule in the repository (AGENTS.md §3, `scripts/check-encompass-readonly.js`).
 * Nothing here talks to Encompass at all — it reads the loan JSON the pull ALREADY stored
 * on `applications.encompass_extra` and writes into OUR OWN columns, the same direction
 * `release-party.syncPurchaseAdviceDate` writes the purchase advice date, and the same
 * direction the borrower-profile enrichment writes.
 *
 * ONE DEFINITION OF "what does Encompass say the funded date is" — `closing.readEncompassFundedDate`.
 * It is what the closing desk's reconciliation gate already compares against, so the date
 * this writes onto the file can never disagree with the date that gate is measuring. A
 * second reader here would drift the day the tenant's field or its format changes, and the
 * one that drifts is the one that decides whether a file is reconciled.
 *
 * FOUR RULES, and each one is a decision rather than a detail:
 *
 *  1. THE DATE IS FILL-ONLY. A funded date somebody typed is NEVER overwritten. The
 *     `compare:'reference'` row on the Encompass panel already SHOWS both sides, so a
 *     disagreement is visible to a human — and silently replacing a closer's figure with
 *     a vendor's is how the number that money moved on changes without anyone deciding.
 *
 *  2. THE STATUS MOVES, AND IT IS NOT GATED. Encompass carrying a funded date means the
 *     money moved; refusing to record that because a condition is still open would be
 *     refusing to record a FACT. This is the same reading CLAUDE.md already records for
 *     the inbound path — *"FUNDED / CLOSED IS DELIBERATELY NOT GATED … an inbound `funded`
 *     applies untouched"*. It only ever moves a file FORWARD onto `funded`; a file already
 *     there is untouched, and a DECLINED / WITHDRAWN file is left completely alone (a
 *     funded date on a declined loan is a real conflict and belongs to a human, not to an
 *     automatic writer).
 *
 *  3. RECONCILIATION IS NEVER TOUCHED — the owner's own carve-out. `closing_workflow` is
 *     not written here in any column: not `stage`, not `fully_reconciled_at`, not
 *     `reconciled_ok`. Reconciliation additionally requires ClickUp to agree, which is a
 *     human's check on the closing desk, and `closing.decideReconcile` is still the one
 *     place that decides it.
 *
 *  4. THE BORROWER IS NOT EMAILED FROM HERE, and the watermark is deliberately LEFT ALONE.
 *     `status_notified_external` is what `status-notify.notifyInboundStatusChange` reads,
 *     and moving it in lock-step here would make the borrower's "your loan is funded"
 *     email SILENT forever after — the ClickUp echo that would have sent it reads as an
 *     already-announced status. Leaving it untouched means the borrower is told at the
 *     moment the team actually processes the funding (ClickUp catching up — the very
 *     reconciliation step the owner named), instead of a back book of loans that funded
 *     months ago all being emailed at once the first time this runs. The TEAM is told
 *     here, because nobody in PILOT made this move and somebody has to know it happened.
 *
 * THE LIMIT THIS FILE USED TO RECORD IS NOW CLOSED (owner-directed 2026-08-21). It said:
 * `status` and `internal_status` are CO-OWNED with ClickUp, so until the card also reads a
 * funded stage a re-ingest can move PILOT back off `funded` — and nothing here pushed a
 * status, because landing the card on `closed (6-email funded)` sends an email from ClickUp
 * and that was an outward-facing action nobody had asked an automatic reader to take.
 *
 * It was put to the owner as an open question, and they answered: *"Connect the statuses of
 * our system to ClickUp: when we update our loan as funded, ClickUp updates as closed."* So
 * the card is now moved, through `clickup/post-closing-stage.advanceCard` — the ONE place
 * that knows the post-closing ladder — and the ClickUp email is the accepted consequence of
 * that instruction rather than a side effect nobody chose.
 *
 * IT CANNOT BLAST THE BACK BOOK, by construction rather than by a watermark: the push rides
 * `statusMoved`, and a file already funded in PILOT never moves, so only files funding from
 * now on reach it. Files this module moved to funded BEFORE the push existed keep a card
 * that has not caught up — that is a bounded, visible set and a deliberate one-off decision
 * for the owner, not something to sweep automatically into a few hundred ClickUp emails.
 *
 * Best-effort end to end: it rides an Encompass pull and may NEVER break one.
 */

// Lazily required so this module can be loaded (and its pure half unit-tested)
// without a database in reach — the `gc-record.js` / `release-party.js` shape.
const getDb = () => require('../db');

// A deal that is over the other way. A funded date arriving on one of these is a real
// contradiction between two systems and belongs to a human, so nothing is written at all
// — not the date, not the status.
const REFUSE_STATUSES = new Set(['declined', 'withdrawn']);

const FUNDED = 'funded';

/**
 * PURE — decide what (if anything) this file should get, given the file's own row and the
 * date Encompass carries. Exported so every branch is unit-testable with no database.
 *
 * @param {object} row   { status, funded_date, deleted_at }
 * @param {string?} encDate  'YYYY-MM-DD' from Encompass, or null
 * @returns {{ skipped?:string, fillDate:string|null, moveStatus:boolean }}
 */
function decideFundedSync(row, encDate) {
  const none = { fillDate: null, moveStatus: false };
  if (!encDate) return { ...none, skipped: 'no_funded_date' };
  if (!row) return { ...none, skipped: 'no_file' };
  if (row.deleted_at) return { ...none, skipped: 'deleted' };
  if (REFUSE_STATUSES.has(row.status)) return { ...none, skipped: 'terminal_negative' };
  // Rule 1 — fill-only. A date already on the file is a human's, and the Encompass panel
  // already shows both sides when they disagree.
  const fillDate = row.funded_date ? null : encDate;
  // Rule 2 — forward onto `funded` only.
  const moveStatus = row.status !== FUNDED;
  if (!fillDate && !moveStatus) return { ...none, skipped: 'already_current' };
  return { fillDate, moveStatus };
}

/**
 * Materialize the Encompass funded date onto the file, and move the file to Funded.
 *
 * Called from the per-file Encompass pull with the SCRUBBED loan it just stored, so it
 * reads exactly what `applications.encompass_extra` now holds. Never throws.
 *
 * @param {object} dbc   a db handle (pool or client)
 * @param {string} appId
 * @param {object} loan  the scrubbed Encompass loan JSON (what encompass_extra holds)
 * @returns {Promise<{skipped?:string, fundedDate?:string|null, filled?:boolean, statusFrom?:string|null, statusMoved?:boolean}>}
 */
async function syncFundedDate(dbc, appId, loan) {
  const q = dbc || getDb();
  try {
    if (!appId) return { skipped: 'no_file' };
    // ONE definition of the Encompass read — the closing desk's own.
    const encDate = require('./closing').readEncompassFundedDate({ encompass_extra: loan });

    const row = (await q.query(
      `SELECT status, funded_date, deleted_at FROM applications WHERE id=$1`, [appId])).rows[0];
    const plan = decideFundedSync(row, encDate);
    if (plan.skipped) return { skipped: plan.skipped, fundedDate: encDate || null };

    let filled = false;
    if (plan.fillDate) {
      // FILL-ONLY at the STATEMENT, not by a check somebody can forget: `funded_date IS NULL`
      // in the WHERE means a value written between our read and this write also wins.
      const r = await q.query(
        `UPDATE applications SET funded_date=$2::date, updated_at=now()
          WHERE id=$1 AND funded_date IS NULL AND deleted_at IS NULL
          RETURNING id`, [appId, plan.fillDate]);
      filled = !!(r && r.rowCount);
    }

    let statusMoved = false;
    if (plan.moveStatus) {
      // Guarded on the status we just read AND on the two refusals, so a file that moved
      // underneath us (a human declining it, a ClickUp pull) is never overwritten. The
      // watermark (`status_notified_external`) is deliberately NOT touched — see rule 4.
      const r = await q.query(
        `UPDATE applications
            SET status=$2, status_changed_at=now(), updated_at=now()
          WHERE id=$1 AND deleted_at IS NULL
            AND status IS DISTINCT FROM $2
            AND status <> ALL($3::text[])
          RETURNING id`, [appId, FUNDED, [...REFUSE_STATUSES]]);
      statusMoved = !!(r && r.rowCount);
    }

    if (!filled && !statusMoved) return { skipped: 'nothing_to_do', fundedDate: encDate };

    // The move is REAL history. `source:'system'` is the honest bucket for an automated
    // move (the column's own comment lists portal | clickup | system); WHICH automation
    // rides the audit row below, which can carry a detail object.
    let cardMoved = null;
    if (statusMoved) {
      try {
        await require('./stage-history').record(appId, row.status, FUNDED,
          { source: 'system', client: dbc || undefined });
      } catch (_) { /* history must never break a pull */ }
      // AND THE CARD FOLLOWS (owner-directed 2026-08-21 — see the header). Guarded,
      // idempotent and never-throwing inside that module; the ClickUp email its stage
      // fires is the instructed outcome.
      cardMoved = await require('../clickup/post-closing-stage')
        .advanceCard(appId, 'funded', { client: dbc || undefined, reason: 'encompass_funded_date' });
    }

    // Nobody in PILOT made this move, so the team is told. Funded is a MAJOR status, so
    // this emails — the same rule the portal door applies (`notifyStatusTransition`).
    try {
      await require('./notify').notifyAppStaff(appId, {
        type: 'status_change',
        title: 'Encompass shows this loan funded',
        body: statusMoved
          ? `Encompass has a funded date of ${encDate}. PILOT filled the funded date in and moved this file to Funded, and moved its ClickUp card to Closed. It is NOT reconciled — reconciling is still a human's three-system check.`
          : `Encompass has a funded date of ${encDate}. PILOT filled it in on this file.`,
        applicationId: appId,
        link: `/internal/app/${appId}`,
      });
    } catch (_) { /* best-effort */ }

    try {
      await q.query(
        `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
         VALUES ('system', NULL, 'encompass_funded_date_synced', 'application', $1, $2)`,
        [appId, JSON.stringify({
          fundedDate: encDate,
          filledDate: filled,
          statusFrom: statusMoved ? row.status : undefined,
          statusTo: statusMoved ? FUNDED : undefined,
          // Said out loud on the record: this door never reconciles.
          reconciled: false,
        })]);
    } catch (_) { /* best-effort */ }

    return { fundedDate: encDate, filled, statusFrom: row.status, statusMoved, cardMoved };
  } catch (_) {
    // Rides a best-effort sync — a failure here must never break an Encompass pull.
    return { skipped: 'error' };
  }
}


// ---------------------------------------------------------------------------
// PREVIOUS AND FUTURE — the back book, at ZERO Encompass cost
//
// The hook above only fires on a PULL, and the per-file pull is a round-robin that
// takes ONE file every 15 minutes — so a file's turn comes round once every
// (files ÷ ~96) days. Every file already pulled since the field map was written is
// therefore sitting on a stored loan JSON that ALREADY carries CX.FUNDEDDATE and was
// never written onto the file. This walks that stored JSON.
//
// IT IS A ONE-SHOT, NOT A TIMER, and that is the whole point: a blob only GAINS a
// funded date on a pull, and every pull now runs `syncFundedDate` itself. So there is
// exactly one population to catch up — the files pulled before this shipped — and a
// recurring sweep would re-read the same thousands of blobs forever to find nothing.
//
// It walks by id with a durable cursor (`sync_runtime_state`) so it RESUMES across
// boots instead of restarting, and the marker is stamped only when the walk genuinely
// reached the end — a truncated pass is finished by the next boot rather than declared
// done. It never throws (a boot pass may not break boot) and is bounded per pass.
// Off with ENCOMPASS_FUNDED_BACKFILL_DISABLED=1.
// ---------------------------------------------------------------------------

const STATE_KEY = 'encompass_funded_backfill_v1';
const BATCH = Math.max(1, Number(process.env.ENCOMPASS_FUNDED_BACKFILL_BATCH) || 200);

async function _loadState(q) {
  try {
    const r = await q.query(`SELECT value FROM sync_runtime_state WHERE key=$1`, [STATE_KEY]);
    return (r.rows[0] && r.rows[0].value) || null;
  } catch (_) { return null; }
}
async function _saveState(q, value) {
  try {
    await q.query(
      `INSERT INTO sync_runtime_state (key, value, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [STATE_KEY, JSON.stringify(value)]);
  } catch (_) { /* a lost bookmark only means we re-walk — never fatal */ }
}

/**
 * One bounded step of the back-book walk. Returns a summary; never throws.
 * @param {object} [opts] { dbc, limit }
 */
async function backfillStoredFundedDatesOnce(opts = {}) {
  const q = opts.dbc || getDb();
  const out = { scanned: 0, filled: 0, moved: 0, done: false, skipped: null };
  try {
    if (String(process.env.ENCOMPASS_FUNDED_BACKFILL_DISABLED || '').trim() === '1') {
      out.skipped = 'disabled'; return out;
    }
    const state = await _loadState(q);
    if (state && state.finishedAt) { out.skipped = 'already_done'; out.done = true; return out; }
    const cursor = (state && state.cursor) || null;
    const limit = Math.max(1, Number(opts.limit) || BATCH);

    // The candidate set is everything this door could still change. A file already
    // Funded with a funded date on it drops out in SQL, so the walk shrinks as it goes;
    // the cursor is what stops the (large) "synced but not funded" majority being
    // re-read on the next pass.
    const rows = (await q.query(
      `SELECT id, encompass_extra
         FROM applications
        WHERE encompass_extra IS NOT NULL
          AND deleted_at IS NULL
          AND status <> ALL($1::text[])
          AND (funded_date IS NULL OR status <> $2)
          AND ($3::uuid IS NULL OR id > $3::uuid)
        ORDER BY id
        LIMIT $4`, [[...REFUSE_STATUSES], FUNDED, cursor, limit])).rows;

    for (const r of rows) {
      out.scanned += 1;
      // The whole read + write rule is `syncFundedDate` — never a second copy of it
      // here. It answers `no_funded_date` for the overwhelming majority, which is a
      // pure in-process read of a blob we already had to fetch.
      const res = await syncFundedDate(q, r.id, r.encompass_extra);
      if (res && res.filled) out.filled += 1;
      if (res && res.statusMoved) out.moved += 1;
    }

    const last = rows.length ? rows[rows.length - 1].id : cursor;
    // A SHORT batch means the walk reached the end of the candidate set — only then is
    // the marker stamped, so a truncated pass is resumed rather than declared finished.
    out.done = rows.length < limit;
    await _saveState(q, {
      cursor: out.done ? null : last,
      startedAt: (state && state.startedAt) || new Date().toISOString(),
      finishedAt: out.done ? new Date().toISOString() : null,
    });
    return out;
  } catch (e) {
    out.skipped = 'error';
    // eslint-disable-next-line no-console
    console.warn('[encompass-funded] back-book pass failed:', (e && e.message) || e);
    return out;
  }
}

module.exports = {
  syncFundedDate, decideFundedSync, backfillStoredFundedDatesOnce,
  REFUSE_STATUSES, FUNDED, STATE_KEY,
};
