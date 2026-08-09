'use strict';
/**
 * THE BACK-BOOK PASS — connect every existing line to the entity its own free
 * text already named.
 *
 * Owner-directed 2026-08-09, twice. "Any LLC that he enters should be a real LLC
 * on his profile." And, asked directly what should happen to lines that are
 * already verified: **"Stay verified."**
 *
 * Thousands of existing track-record lines name their entity ONLY as free text
 * in `entity_name`. Phase 2's chokepoint fixes that going forward; this is the
 * repair for what is already on disk.
 *
 * ── THE ONE DANGEROUS THING, AND HOW IT IS CONTAINED ────────────────────────
 * `llc_id` is MATERIAL to the verify guard, so writing it un-verifies the line.
 * Across the back book that would drop every borrower's experience tier and
 * reopen the experience condition on live files — the exact outcome the owner
 * ruled out.
 *
 * db/501 adds ONE narrow exemption: a NULL -> value FILL of `llc_id`, and only
 * while the transaction-local GUC `pilot.track_record_entity_backfill` is on.
 * This module is the only thing that sets it, with `SET LOCAL`, inside each
 * batch's own transaction — so it is scoped to one transaction on one
 * connection and is gone the moment that transaction ends, however it ends.
 * There is deliberately NO `ALTER TABLE ... DISABLE TRIGGER` anywhere here: that
 * would drop the guard for every connection including live staff edits, and
 * would stay down if this pass died. See db/501's header.
 *
 * ── IT SETS A LINK, NEVER A VERDICT ─────────────────────────────────────────
 * Every entity still has to pass Check A on its own before it proves ownership
 * for anything, and each line still needs its own Check B. The ownership pillar
 * is not touched by this pass at all. So the worst case of a wrong link is a
 * property attached to the wrong company and NOT verified — which is why the
 * matcher used here is the strict one, and why ambiguity writes nothing.
 *
 * ── AND IT IS DELIBERATELY NOT AUTOMATIC ────────────────────────────────────
 * This is NOT wired into boot. It is a deliberate, invoked pass, for the same
 * reason the appraisal As-Is sweep is: it writes to the loan book, and a
 * migration that runs itself on every deploy is the wrong shape for something
 * whose blast radius is "every track record the company has". Run it, read the
 * summary, run it again. It is idempotent and resumable.
 */

const DEFAULT_BATCH = Number(process.env.TRACK_RECORD_ENTITY_BACKFILL_BATCH || 200);
const MARKER = 'track_record_entity_backfill_v1';

/**
 * One bounded batch. Returns a summary and NEVER throws.
 *
 * Each batch is its own transaction: the GUC is set with SET LOCAL, the rows are
 * written, and the cursor advances — so a crash loses at most one batch and
 * cannot leave the exemption on.
 */
async function backfillOnce(opts = {}) {
  const db = require('../db');
  const T = require('./track-record-entity');
  const limit = Math.max(1, Math.min(2000, Number(opts.limit || DEFAULT_BATCH)));
  const out = {
    scanned: 0, linked: 0, created: 0, ambiguous: 0, junk: 0, unmatched: 0,
    verifiedPreserved: 0, done: false, ok: true,
  };

  let client;
  try {
    client = await db.getClient();
    await client.query('BEGIN');

    /* THE EXEMPTION. SET LOCAL — transaction-scoped, this connection only. */
    await client.query(`SET LOCAL pilot.track_record_entity_backfill = 'on'`);

    const cur = (await client.query(
      `SELECT value FROM sync_runtime_state WHERE key=$1`, [MARKER]).catch(() => ({ rows: [] }))).rows[0];
    const after = (cur && cur.value && cur.value.after) || '00000000-0000-0000-0000-000000000000';

    /* Candidates: free text naming an entity, no link yet. Ordered by id so the
       cursor is stable and the pass is resumable. */
    const rows = (await client.query(
      `SELECT id, borrower_id, entity_name, is_verified
         FROM track_records
        WHERE llc_id IS NULL
          AND entity_name IS NOT NULL
          AND btrim(entity_name) <> ''
          AND COALESCE(owned_personally, false) = false
          AND id > $1::uuid
        ORDER BY id
        LIMIT $2`, [after, limit])).rows;

    out.scanned = rows.length;
    if (!rows.length) {
      out.done = true;
      await client.query('COMMIT');
      return out;
    }

    for (const row of rows) {
      const junk = T.junkEntityName(row.entity_name);
      if (junk) { out.junk += 1; continue; }

      /* THE STRICT MATCHER, and CREATE ONLY WHEN opts.create IS ON. By default
         this pass LINKS to entities that already exist and does not mint new
         ones — creating thousands of companies from historical free text in one
         unattended pass is a much bigger act than connecting names that already
         have a home, and it deserves its own deliberate run. */
      const existing = (await client.query(
        `SELECT id, llc_name FROM llcs WHERE borrower_id=$1`, [row.borrower_id])).rows;
      const pick = T.pickEntity(row.entity_name, existing);

      let llcId = null; let created = false;
      if (pick.ambiguous) { out.ambiguous += 1; continue; }
      if (pick.llcId) { llcId = pick.llcId; }
      else if (opts.create) {
        const made = await T.promoteEntityName(row.borrower_id, row.entity_name,
          { client, firstSeenOn: 'track_record' });
        if (!made.llcId) { out.unmatched += 1; continue; }
        llcId = made.llcId; created = !!made.created;
      } else { out.unmatched += 1; continue; }

      /* PINNED TO WHAT WE READ. `llc_id IS NULL` in the UPDATE means a concurrent
         writer that linked this line first wins, and we simply do nothing. */
      const upd = await client.query(
        `UPDATE track_records SET llc_id=$2, updated_at=now()
          WHERE id=$1 AND llc_id IS NULL RETURNING is_verified`, [row.id, llcId]);
      if (!upd.rowCount) continue;

      out.linked += 1;
      if (created) out.created += 1;
      if (upd.rows[0].is_verified) out.verifiedPreserved += 1;

      /* AUDITED PER ROW. Every automatic link is attributable — the name it
         matched and the entity it chose — because nothing else records that this
         link was made by a machine rather than by a person. */
      await client.query(
        `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
         VALUES ('system', NULL, 'track_record_entity_backfilled', 'track_record', $1, $2::jsonb)`,
        [row.id, JSON.stringify({
          borrowerId: row.borrower_id,
          matchedName: row.entity_name,
          llcId,
          created,
          wasVerified: upd.rows[0].is_verified === true,
        })]).catch(() => { /* the link is the work; the audit is best-effort */ });
    }

    await client.query(
      `INSERT INTO sync_runtime_state (key, value) VALUES ($1,$2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [MARKER, JSON.stringify({ after: rows[rows.length - 1].id, at: new Date().toISOString() })]);

    await client.query('COMMIT');
    return out;
  } catch (e) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    out.ok = false;
    out.error = e && e.message;
    return out;
  } finally {
    if (client) { try { client.release(); } catch (_) { /* already gone */ } }
  }
}

/** Drain the whole book in bounded batches. Stops on the first failure. */
async function backfillAll(opts = {}) {
  const total = { scanned: 0, linked: 0, created: 0, ambiguous: 0, junk: 0, unmatched: 0, verifiedPreserved: 0, batches: 0, ok: true };
  const maxBatches = Math.max(1, Number(opts.maxBatches || 500));
  for (let i = 0; i < maxBatches; i += 1) {
    const r = await backfillOnce(opts);
    total.batches += 1;
    for (const k of ['scanned', 'linked', 'created', 'ambiguous', 'junk', 'unmatched', 'verifiedPreserved']) total[k] += r[k];
    if (!r.ok) { total.ok = false; total.error = r.error; break; }
    if (r.done) { total.done = true; break; }
  }
  return total;
}

/** Start again from the beginning. The pass is idempotent, so this is safe. */
async function resetCursor() {
  const db = require('../db');
  await db.query(`DELETE FROM sync_runtime_state WHERE key=$1`, [MARKER]).catch(() => {});
}

module.exports = { backfillOnce, backfillAll, resetCursor, MARKER };
