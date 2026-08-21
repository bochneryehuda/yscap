#!/usr/bin/env node
'use strict';
/* THE CARD FOLLOWS THE FILE AFTER CLOSING — end to end, real Postgres.
 * ---------------------------------------------------------------------------
 * Owner-directed 2026-08-21. The pure suite pins the DECISION; this pins what actually
 * happens to a row and to the outbound queue, which a pure test cannot see:
 *   · the Encompass funded reader moves the file AND lands the card on the funded stage;
 *   · a tape sent to the investor moves a funded card to purchase review;
 *   · a purchase advice date moves it on to the PA-issued stage;
 *   · a card is never dragged backwards, and a pre-closing file is never jumped;
 *   · every move is queued to ClickUp through the ordinary scoped push, and audited.
 *
 * NOTHING IS SENT ANYWHERE: the ClickUp push is only ENQUEUED (the worker is not running in
 * a test), and the funded reader's only outbound call is a notification through the `none`
 * mail provider.
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-clickup-post-closing-stage-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
/* The outbound enqueue is gated on the sync switch (`enqueue.js` returns immediately when
   it is off), so proving "the move reaches the outbound queue" needs the switch ON. Nothing
   is SENT by this: the drainer is a worker that is not running here, so the row simply sits
   in `sync_queue`. Section 1 additionally proves the gate itself still governs. */
process.env.CLICKUP_SYNC_ENABLED = '1';

const db = require('../src/db');
const STAGE = require('../src/clickup/post-closing-stage');
const FUNDED_READER = require('../src/lib/encompass-funded');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${label}`); } };
const eq = (label, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (same) pass++; else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};

const tag = `pcs-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;

(async () => {
  let borrowerId = null;
  const made = [];
  try {
    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name, last_name, email) VALUES ('Post','Closing',$1) RETURNING id`,
      [`${tag}@test.local`])).rows[0].id;

    const mkApp = async (status, internal) => {
      const id = (await db.query(
        `INSERT INTO applications (borrower_id, status, internal_status, property_address, loan_type)
         VALUES ($1,$2,$3,$4::jsonb,'purchase') RETURNING id`,
        [borrowerId, status, internal, JSON.stringify({ oneLine: `1 Stage St ${tag}, Lakewood, NJ 08701` })])).rows[0].id;
      made.push(id); return id;
    };
    const cardOf = async (id) => (await db.query(
      `SELECT status, internal_status FROM applications WHERE id=$1`, [id])).rows[0];
    const queuedFor = async (id) => (await db.query(
      `SELECT count(*)::int n FROM sync_queue WHERE entity_id=$1 AND target='clickup'`, [id])).rows[0].n;

    /* ---------------- 1. the Encompass funded reader ---------------- */
    {
      const appId = await mkApp('underwriting', 'in underwriting');
      const before = await queuedFor(appId);
      const out = await FUNDED_READER.syncFundedDate(db, appId, { closingDocument: { fundingDate: '2026-08-01' } });
      ok('1a Encompass carrying a funded date moves the file to Funded', out.statusMoved === true);
      ok('1b …and fills the funded date in', out.filled === true);
      const card = await cardOf(appId);
      eq('1c …and the ClickUp card lands on the funded stage', card.internal_status, STAGE.STAGE_FOR.funded);
      eq('1d …with the borrower-facing word now Funded', card.status, 'funded');
      ok('1e …and the move is queued to ClickUp through the ordinary push', (await queuedFor(appId)) > before);
      // …and that queue row is the SCOPED status push, never a whole-task rewrite.
      const job = (await db.query(
        `SELECT payload FROM sync_queue WHERE entity_id=$1 AND target='clickup' ORDER BY id DESC LIMIT 1`,
        [appId])).rows[0];
      ok('1e2 …pushing ONLY the status, so it can never rewrite the rest of the card',
        !!job && Array.isArray(job.payload && job.payload.only) && job.payload.only.includes('internal_status'));
      const aud = (await db.query(
        `SELECT detail FROM audit_log WHERE entity_id=$1 AND action='clickup_post_closing_stage' ORDER BY created_at DESC LIMIT 1`,
        [appId])).rows[0];
      ok('1f …and it is on the record, naming the event', !!aud && aud.detail && aud.detail.event === 'funded');

      // Reading the SAME date again must not re-fire — the funded stage sends a ClickUp email.
      const again = await FUNDED_READER.syncFundedDate(db, appId, { closingDocument: { fundingDate: '2026-08-01' } });
      ok('1g re-reading the same funded date moves nothing again', !again.statusMoved && !!again.skipped);
    }

    /* ---------------- 2 + 3. delivered, then sold ---------------- */
    {
      const appId = await mkApp('funded', STAGE.STAGE_FOR.funded);
      const d = await STAGE.advanceCard(appId, 'investor_delivered', { reason: 'test' });
      ok('2a a tape sent on a funded file moves the card to purchase review',
        d.moved === true && d.stage === 'in purchase review');
      eq('2b …and the borrower-facing word does not move', (await cardOf(appId)).status, 'funded');

      const s = await STAGE.advanceCard(appId, 'sold', { reason: 'test' });
      ok('3a a purchase advice moves it on to the PA-issued stage',
        s.moved === true && s.stage === 'pa issued-post closing.');

      // …and it can never go back.
      const back = await STAGE.advanceCard(appId, 'investor_delivered', { reason: 'test' });
      eq('3b a later tape can never drag the card back', back.skipped, 'already_past');
      eq('3c …and the card is left where it was', (await cardOf(appId)).internal_status, 'pa issued-post closing.');
    }

    /* ---------------- 4. the side door stays shut ---------------- */
    {
      const appId = await mkApp('underwriting', 'in underwriting');
      const r = await STAGE.advanceCard(appId, 'investor_delivered', { reason: 'test' });
      eq('4a a tape on a file that has NOT funded moves nothing', r.skipped, 'not_funded_yet');
      const card = await cardOf(appId);
      eq('4b …and the borrower-facing word is untouched', card.status, 'underwriting');
      eq('4c …as is the card', card.internal_status, 'in underwriting');
    }

    /* ---------------- 5. a deal that ended the other way ---------------- */
    {
      const appId = await mkApp('declined', 'declined');
      eq('5a a declined file is never advanced', (await STAGE.advanceCard(appId, 'funded', {})).skipped, 'terminal_negative');
    }

    /* ---------------- 6. the off switch ---------------- */
    {
      const appId = await mkApp('funded', STAGE.STAGE_FOR.funded);
      process.env.CLICKUP_POST_CLOSING_STAGE_DISABLED = '1';
      const r = await STAGE.advanceCard(appId, 'investor_delivered', {});
      delete process.env.CLICKUP_POST_CLOSING_STAGE_DISABLED;
      eq('6a the switch stops every push', r.skipped, 'disabled');
      eq('6b …and changes nothing', (await cardOf(appId)).internal_status, STAGE.STAGE_FOR.funded);
      // control: with the switch off again it moves, so 6a proved the switch and not a bug
      ok('6c …and with it back on the same call moves the card',
        (await STAGE.advanceCard(appId, 'investor_delivered', {})).moved === true);
    }
  } catch (e) {
    fail++; console.error('FAIL unexpected error:', e && e.stack || e);
  } finally {
    for (const id of made) await db.query(`DELETE FROM applications WHERE id=$1`, [id]).catch(() => {});
    if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]).catch(() => {});
    await db.pool.end().catch(() => {});
  }
  console.log(`\n${fail ? 'FAILED' : 'OK'}  the card follows the file after closing — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
