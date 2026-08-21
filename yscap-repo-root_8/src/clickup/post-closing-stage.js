'use strict';

/**
 * THE CARD FOLLOWS THE FILE AFTER CLOSING (owner-directed 2026-08-21).
 *
 * The owner, answering the open question this file's sibling `encompass-funded.js` left
 * recorded — *"Connect the statuses of our system to ClickUp: when we update our loan as
 * funded, ClickUp updates as closed. When we mark our system investor delivered, ClickUp
 * changes to in purchase review. When we mark it as sold and you get the PA date from
 * Encompass, it should also automatically mark as sold. The status in ClickUp also needs to
 * be changed to waiting for final documents. Please do research on each navigation status
 * to make sure it exists."*
 *
 * THE RESEARCH, AND IT IS WHY THIS FILE CAN BE WRITTEN AT ALL. The three stages were read
 * LIVE off the Loan Pipeline space on 2026-08-21 (two lists — an officer's files list and
 * the Closed Loan Pipeline — carry an identical 38-status set), so this is ClickUp's own
 * vocabulary rather than anybody's memory:
 *
 *   orderindex 25  closed (6-email funded)       ← the owner's "closed"
 *   orderindex 32  in purchase review            ← the owner's "in purchase review"
 *   orderindex 33  purchase conditions
 *   orderindex 34  pa issued-post closing.
 *   orderindex 35  waiting for final docs        ← the owner's "waiting for final documents"
 *   orderindex 36  non del closed reconciled
 *   orderindex 37  closed reconciled
 *
 * ONE NAME DIFFERS FROM THE INSTRUCTION AND THE LIST WINS: the owner wrote "waiting for
 * final documents"; the status is spelled **"waiting for final docs"**. ClickUp refuses a
 * status a list does not carry, so writing the owner's phrasing verbatim would have failed
 * every push — which is exactly what "make sure it exists" was asking about.
 *
 * WHY THE ORDER IS LOAD-BEARING AND WHY IT IS NOT A GUESS. A card must never be dragged
 * BACKWARDS: a tape sent late on a file already waiting for final documents must not pull
 * it back to purchase review. The ladder below is ClickUp's own `orderindex`, read from the
 * live list — not an inference from the names.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO:
 *   · it never RECONCILES anything (`closed reconciled` / `non del closed reconciled` are
 *     on the ladder so a card already there is left alone, never as a target). The owner
 *     carved reconciliation out by name — it needs a human's three-system check, and
 *     `closing.decideReconcile` is still the only thing that decides it;
 *   · it never moves the BORROWER-FACING status. Every stage here derives to `funded`
 *     (`status.EXTERNAL_FOR`), so the word the borrower sees cannot move — which is what
 *     makes these pushes safe to fire automatically;
 *   · it never invents a stage. `STAGE_FOR` is checked against the shared status map at
 *     load, so a typo is a startup failure rather than a push ClickUp rejects in silence.
 *
 * THE ONE OUTWARD-FACING CONSEQUENCE, STATED PLAINLY: `closed (6-email funded)` is one of
 * the stages whose ClickUp automation SENDS AN EMAIL when a card enters it (the "(6-email"
 * in its own name). PILOT landing a card there therefore causes an email from ClickUp. That
 * was raised with the owner as the reason an automatic reader had not been allowed to do it,
 * and the owner has now directed it in their own words. It is go-forward by construction —
 * a file already funded in PILOT never re-enters the funded branch — so switching this on
 * cannot blast a back book. `CLICKUP_POST_CLOSING_STAGE_DISABLED=1` stops all of it.
 */

const statusMap = require('./status');

/** ClickUp's own post-closing order (orderindex 25 → 37), read live 2026-08-21. */
const LADDER = [
  'closed (6-email funded)',
  'in purchase review',
  'purchase conditions',
  'pa issued-post closing.',
  'waiting for final docs',
  'non del closed reconciled',
  'closed reconciled',
];

/** The PILOT event → the ClickUp stage the owner named for it. */
const STAGE_FOR = {
  funded: 'closed (6-email funded)',
  investor_delivered: 'in purchase review',
  sold: 'waiting for final docs',
};

/* A stage this file names but the shared status map does not know is a typo, and a typo
   here is a push ClickUp refuses — silently, from inside a best-effort caller. Checked at
   LOAD so it is a startup failure instead, and asserted by the pure test. */
function verifyStages() {
  const bad = [];
  for (const [event, stage] of Object.entries(STAGE_FOR)) {
    if (!statusMap.isKnownInternal(stage)) bad.push(`${event} → ${stage}`);
    if (!LADDER.includes(stage)) bad.push(`${event} → ${stage} (not on the ladder)`);
    // Every stage here must read back to the SAME borrower-facing word, or an automatic
    // push would move what the borrower sees.
    if (statusMap.externalFor(stage) !== 'funded') bad.push(`${event} → ${stage} (external ${statusMap.externalFor(stage)})`);
  }
  return bad;
}
{
  const bad = verifyStages();
  if (bad.length) throw new Error(`post-closing-stage: unknown or mis-mapped ClickUp stage(s): ${bad.join(', ')}`);
}

/** A deal that ended the other way is never advanced — that is a human's contradiction. */
const REFUSE_EXTERNAL = new Set(['declined', 'withdrawn']);

const enabled = () => process.env.CLICKUP_POST_CLOSING_STAGE_DISABLED !== '1';

/** Where a card sits on the post-closing ladder, or -1 when it is not on it yet. */
function ladderIndex(internalStatus) {
  const n = statusMap.norm(internalStatus);
  return LADDER.findIndex((s) => statusMap.norm(s) === n);
}

/**
 * PURE — what should happen to this card, given the file's own row and the event.
 * Exported so every branch is testable with no database and no ClickUp.
 *
 * @param {object|null} row  { status, internal_status, deleted_at }
 * @param {string} event     a key of STAGE_FOR
 * @returns {{ stage:string|null, push:boolean, skipped?:string }}
 */
function decideStage(row, event) {
  const none = { stage: null, push: false };
  const stage = STAGE_FOR[event];
  if (!stage) return { ...none, skipped: 'unknown_event' };
  if (!row) return { ...none, skipped: 'no_file' };
  if (row.deleted_at) return { ...none, skipped: 'deleted' };
  if (REFUSE_EXTERNAL.has(row.status)) return { ...none, skipped: 'terminal_negative' };

  const at = ladderIndex(row.internal_status);
  const want = ladderIndex(stage);
  // Already there, or further along — a card is never dragged backwards, and re-asserting
  // the funded stage would re-fire its ClickUp email.
  if (at >= want) return { ...none, skipped: at === want ? 'already_there' : 'already_past' };

  /* THE TWO LATER STAGES REQUIRE THE FILE TO BE FUNDED ALREADY. They derive to the
     borrower-facing word `funded`, so pushing one onto a file still in underwriting would
     move a borrower's status by a side door. The `funded` event is the one that MAKES a
     file funded, so it is exempt — its own caller has just established the fact. */
  if (event !== 'funded' && row.status !== 'funded' && at < 0) {
    return { ...none, skipped: 'not_funded_yet' };
  }
  return { stage, push: true };
}

/**
 * Move the file's ClickUp card onto the stage the owner named for this event.
 *
 * Writes `applications.internal_status` (guarded on the value we read, so a human or an
 * inbound pull that moved it underneath us is never overwritten) and enqueues the ordinary
 * scoped push — the SAME door the portal's own status dropdown uses, so every write guard,
 * the no-op suppression and the volume breaker all still apply.
 *
 * `status_notified_external` is deliberately NOT touched: the borrower's "your loan is
 * funded" email is fired by the ClickUp echo of this very move, and moving the watermark
 * here would silence it forever.
 *
 * Never throws — it rides best-effort callers (an Encompass pull, an investor email).
 */
async function advanceCard(appId, event, opts = {}) {
  const q = opts.client || require('../db');
  try {
    if (!appId) return { skipped: 'no_file' };
    if (!enabled()) return { skipped: 'disabled' };
    const row = (await q.query(
      `SELECT status, internal_status, deleted_at FROM applications WHERE id=$1`, [appId])).rows[0];
    const plan = decideStage(row, event);
    if (!plan.push) return { skipped: plan.skipped };

    const r = await q.query(
      `UPDATE applications SET internal_status=$2, updated_at=now()
        WHERE id=$1 AND deleted_at IS NULL
          AND internal_status IS NOT DISTINCT FROM $3
        RETURNING id`, [appId, plan.stage, row.internal_status]);
    if (!r.rowCount) return { skipped: 'moved_underneath_us' };

    try {
      await require('./enqueue').enqueueClickupPush(appId, ['internal_status']);
    } catch (_) { /* the queue retries; the file already records the stage */ }

    try {
      await q.query(
        `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
         VALUES ('system', NULL, 'clickup_post_closing_stage', 'application', $1, $2)`,
        [appId, JSON.stringify({ event, from: row.internal_status || null, to: plan.stage, reason: opts.reason || null })]);
    } catch (_) { /* best-effort */ }

    return { moved: true, event, from: row.internal_status || null, stage: plan.stage };
  } catch (e) {
    console.warn('[clickup] post-closing stage failed:', e && e.message);
    return { skipped: 'error' };
  }
}

module.exports = { LADDER, STAGE_FOR, decideStage, advanceCard, ladderIndex, verifyStages, REFUSE_EXTERNAL };
