'use strict';
/**
 * PREVIOUS AND FUTURE for the duplicate track-record line (owner-reported
 * 2026-08-02: "one track record has twice the same address … there is an issue
 * why we have two addresses on the same. Fix the cause, and merge the existing
 * duplicates").
 *
 * lib/track-record-key.js fixes the CAUSE going forward. This is the repair for
 * the rows four disagreeing normalizers already wrote.
 *
 * JAVASCRIPT, NOT A MIGRATION — deliberately, and for the reason this repo has
 * already learned twice (person-name heal, appraisal property-category heal):
 * a PL/pgSQL twin of `sameAddress` would have to re-implement ordinals, unit
 * keywords, USPS abbreviations, house-number ranges and the ZIP-beats-city rule,
 * and it would drift from the live one the moment either changed. The decision
 * is made by the SAME function the writers use, so the repair and the guard can
 * never disagree about what "the same house" means.
 *
 * IT NEVER MERGES ANYTHING BY ITSELF — A HUMAN CONFIRMS FIRST (owner-directed
 * 2026-08-02, in the owner's own words: "talking about merging files with
 * similar address — NEVER before human review", and "the system should always
 * need a human to confirm, never do this risky stuff itself").
 *
 * The first cut of this pass deleted the losing row at boot whenever it looked
 * provably untouched. That is exactly the risk the owner refused: two lines can
 * LOOK like one property and be two, the judgement is a person's, and the thing
 * being thrown away is underwriting evidence that feeds the experience tier, the
 * deal counts and the experience condition.
 *
 * SO THIS PASS NOW DOES TWO NARROW THINGS, and detects nothing:
 *
 *   1. RE-KEY every row from the one shared function, so a key written by one of
 *      the four old normalizers stops describing text that is no longer there.
 *      Rekeying writes no user-visible value and deletes nothing.
 *   2. Hand the borrower to `track-record-findings`, which is the ONE place that
 *      decides "these two lines look like the same property" and raises it as a
 *      finding ON THE TRACK RECORD — where the person working the file sees it,
 *      and where it holds the experience condition until they settle it.
 *      Owner-directed: "we should NOT send it to the regular manual review
 *      queue … we should have findings on the track record."
 *
 * The merge itself lives in `mergeTrackRecordPair` below and runs ONLY from a
 * reviewer's decision on one of those findings, with their staff id recorded on
 * it. Nothing on this path can remove a track-record line unattributed.
 *
 * NOTHING HANGING OFF A ROW IS LOST. `documents.track_record_id` is ON DELETE
 * CASCADE, so deleting a line takes its closing documents with it; and
 * `checklist_items.track_record_id` is ON DELETE SET NULL, which would strand a
 * document-request condition. Both are RE-POINTED at the keeper first (the
 * pattern db/082 established), inside the same transaction as the delete.
 *
 * Bounded per boot, self-draining, idempotent, and never throws.
 */

const db = require('../db');
const TRK = require('./track-record-key');
const ADDR = require('./address');

const MARKER = 'track_record_dedupe_v1';
const DEFAULT_LIMIT = Number(process.env.TRACK_RECORD_HEAL_BORROWERS || 200);

/* Figures that make a row "worked". A duplicate may only be removed when each of
   these is either absent on it, or absent on the keeper (carried over), or
   already equal — so a merge can never silently drop a number somebody entered. */
const MONEY_COLS = ['purchase_price', 'sale_price', 'rehab_amount', 'rent_amount', 'refi_amount', 'current_value'];
const DATE_COLS = ['purchase_date', 'sale_date', 'rent_date', 'refi_date'];
const CARRY_COLS = [...MONEY_COLS, ...DATE_COLS, 'deal_type', 'property_type', 'entity_name', 'llc_id'];

/* An origin the machine wrote. A 'portal' row is a human's typing. */
const MACHINE_ORIGINS = new Set(['clickup_backfill', 'encompass', 'pilot_funded']);

const norm = (v) => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return String(v);
  const s = String(v).trim();
  return s === '' ? null : s;
};

async function healBorrower(client, borrowerId, out) {
  const rows = (await client.query(
    `SELECT t.*,
            EXISTS (SELECT 1 FROM documents d WHERE d.track_record_id = t.id)       AS has_documents,
            EXISTS (SELECT 1 FROM checklist_items c WHERE c.track_record_id = t.id) AS has_conditions
       FROM track_records t WHERE t.borrower_id = $1 ORDER BY t.created_at`, [borrowerId])).rows;

  // Re-key every row from the ONE shared function first, so the stored key stops
  // describing whatever an older normalizer thought.
  for (const r of rows) {
    const want = TRK.trackRecordKey(r.property_address) || null;
    if (want !== (r.address_key || null)) {
      await client.query(`UPDATE track_records SET address_key=$2 WHERE id=$1`, [r.id, want]);
      out.rekeyed += 1;
      r.address_key = want;
    }
  }

  /* DETECTION IS NOT THIS PASS'S JOB. The findings desk owns "which two lines
     look like the same property", so there is exactly ONE definition of it, and
     it raises the question ON THE TRACK RECORD where the person working the file
     will see it — owner-directed 2026-08-02, "we should NOT send it to the
     regular manual review queue … we should have findings on the track record".
     This pass exists for the re-key above and for reaching borrowers no file
     view has touched. */
  const r = await require('./track-record-findings').syncForBorrower(borrowerId, { client });
  out.proposed += r.raised;
  out.openFindings += r.open;
}

/** The one-line address a reviewer reads on the card. Never throws. */
function addrText(a) {
  try { return ADDR.canonicalOneLine(a) || ADDR.addressTextOf(a) || ''; }
  catch (_) { try { return String(a == null ? '' : a); } catch (_2) { return ''; } }
}

/**
 * THE ONLY PLACE A TRACK-RECORD ROW IS EVER DELETED, and it is reachable only
 * from the review action — i.e. only after a person looked at both addresses
 * and pressed the button. `actorId` is required for exactly that reason: an
 * unattributed merge is the thing the owner forbade.
 *
 * Everything is RE-CHECKED here rather than trusted from the proposal, because
 * the queue row may be days old and the rows may have been worked since.
 */
async function mergeTrackRecordPair({ keepId, loserId, actorId }) {
  if (!actorId) throw Object.assign(new Error('a track-record merge must record who approved it'), { status: 400, expose: true });
  if (!keepId || !loserId || String(keepId) === String(loserId)) {
    throw Object.assign(new Error('a merge needs two different track-record lines'), { status: 400, expose: true });
  }
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const both = (await client.query(
      `SELECT t.*,
              EXISTS (SELECT 1 FROM documents d WHERE d.track_record_id = t.id)       AS has_documents,
              EXISTS (SELECT 1 FROM checklist_items c WHERE c.track_record_id = t.id) AS has_conditions
         FROM track_records t WHERE t.id = ANY($1::uuid[]) FOR UPDATE`, [[keepId, loserId]])).rows;
    const keep = both.find((r) => String(r.id) === String(keepId));
    const row = both.find((r) => String(r.id) === String(loserId));
    if (!keep || !row) throw Object.assign(new Error('one of those track-record lines is already gone'), { status: 409, expose: true });
    if (String(keep.borrower_id) !== String(row.borrower_id)) {
      throw Object.assign(new Error('those two lines belong to different borrowers'), { status: 409, expose: true });
    }
    /* A human confirming "these are the same house" is the authority on the
       ADDRESS, so `not_same_property` is not re-imposed here. What is still
       refused is the two things no confirmation can make safe: destroying
       VERIFIED evidence, and silently dropping a figure the two rows disagree
       on — that needs fixing on the track record itself, not in a queue. */
    if (row.is_verified) throw Object.assign(new Error('that line is verified evidence — unverify it first if it really is a duplicate'), { status: 409, expose: true });
    const conflict = CARRY_COLS.find((c) => {
      const a = norm(row[c]), b = norm(keep[c]);
      return a != null && b != null && a !== b;
    });
    if (conflict) {
      throw Object.assign(new Error(`the two lines disagree on ${conflict.replace(/_/g, ' ')} — make them agree on the track record first, then merge`), { status: 409, expose: true });
    }
    /* CARRYING A FIGURE INTO A VERIFIED KEEPER RE-OPENS ITS VERIFICATION, AND
       THAT IS THE INTENDED BEHAVIOUR — do not "fix" it (recorded 2026-08-09,
       docs/TRACK-RECORD-CURRENT-STATE.md D5).

       EVERY ONE of the 14 CARRY_COLS is a material column in db/485's verify
       guard, so the moment this UPDATE fills a blank on a verified keeper the
       trigger returns that row to `is_verified=false` / `pending`. That reads
       like an accident and is not: the figure being carried came off a row NOBODY
       REVIEWED (the loser is refused above if it is verified), so the combined
       line now states something the verification never covered. Re-review is the
       correct answer, and it is the same doctrine db/485 applies to every other
       write — a verified line describes evidence a person checked, not a row id.

       The only reason to touch this is if the guard's material list and this list
       ever diverge; keep them in step rather than exempting the merge. Pinned by
       `scripts/test-track-record-phase0.js` §5b, which asserts every CARRY_COL is
       still material and that a real carry really does un-verify the keeper. */
    const carry = CARRY_COLS.filter((c) => norm(row[c]) != null && norm(keep[c]) == null);
    if (carry.length) {
      await client.query(
        `UPDATE track_records SET ${carry.map((c, i) => `${c}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1`,
        [keep.id, ...carry.map((c) => row[c])]);
    }
    // Re-point everything that hangs off the loser BEFORE deleting it: documents
    // CASCADE (they would be destroyed) and checklist_items SET NULL (they would
    // be stranded).
    await client.query(`UPDATE documents SET track_record_id=$2 WHERE track_record_id=$1`, [row.id, keep.id]);
    await client.query(`UPDATE checklist_items SET track_record_id=$2 WHERE track_record_id=$1`, [row.id, keep.id]);
    await client.query(`DELETE FROM track_records WHERE id=$1`, [row.id]);
    /* THE AUDIT IS BEST-EFFORT, AND THAT IS WHY IT NEEDS A SAVEPOINT.
       A swallowed error inside a transaction is not swallowed by POSTGRES: the
       transaction enters an aborted state, and the later COMMIT silently
       performs a ROLLBACK and returns without throwing — so the merge would be
       discarded while the caller was told it worked. (That is exactly what
       happened here once: the column is `detail`, not `meta`.) The savepoint
       contains the failure so a best-effort write can never take the real work
       down with it — the same discipline finding-decisions uses. */
    await client.query('SAVEPOINT trk_audit');
    try {
      await client.query(
        `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
         VALUES ('staff',$1,'track_record_duplicate_merged','borrower',$2,$3::jsonb)`,
        [actorId, keep.borrower_id,
          JSON.stringify({ removed: row.id, keep: keep.id, carried: carry, origin: row.origin, approvedBy: actorId })]);
      await client.query('RELEASE SAVEPOINT trk_audit');
    } catch (_) {
      await client.query('ROLLBACK TO SAVEPOINT trk_audit').catch(() => {});
    }
    await client.query('COMMIT');
    return { merged: true, keepId: keep.id, removedId: row.id, carried: carry };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    try { client.release(); } catch (_) { /* already gone */ }
  }
}

/**
 * One bounded pass. Borrowers who could still hold a duplicate are those with
 * two or more rows; the marker records how far we got so a big book drains over
 * several boots instead of holding one up.
 */
async function healOnce({ limit = DEFAULT_LIMIT } = {}) {
  // `proposed` = review cards raised for a human. NOTHING is merged by this
  // pass, which is why there is no `merged` counter any more — a merge only
  // ever happens in mergeTrackRecordPair, from the review action.
  const out = { borrowers: 0, rekeyed: 0, proposed: 0, openFindings: 0, left: [], ok: true };
  let client;
  try {
    client = await db.getClient();
  } catch (_) { return { ...out, ok: false, reason: 'no_db' }; }
  try {
    const since = (await client.query(
      `SELECT value FROM sync_runtime_state WHERE key=$1`, [MARKER]).catch(() => ({ rows: [] }))).rows[0];
    const cursor = (since && since.value && since.value.cursor) || null;

    const cand = (await client.query(
      `SELECT borrower_id FROM track_records
        WHERE ($1::uuid IS NULL OR borrower_id > $1)
        GROUP BY borrower_id HAVING count(*) > 1
        ORDER BY borrower_id LIMIT $2`, [cursor, limit])).rows;

    for (const c of cand) {
      try {
        await client.query('BEGIN');
        await healBorrower(client, c.borrower_id, out);
        await client.query('COMMIT');
        out.borrowers += 1;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        out.left.push({ borrowerId: c.borrower_id, reason: 'error' });
      }
    }
    const next = cand.length === limit ? cand[cand.length - 1].borrower_id : null;
    await client.query(
      `INSERT INTO sync_runtime_state (key, value) VALUES ($1,$2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
      [MARKER, JSON.stringify({ cursor: next, at: new Date().toISOString() })]).catch(() => {});
    return out;
  } catch (e) {
    return { ...out, ok: false, reason: (e && e.message) || 'error' };
  } finally {
    try { client.release(); } catch (_) { /* already gone */ }
  }
}

module.exports = {
  healOnce,
  mergeTrackRecordPair,
  _internals: { addrText, MACHINE_ORIGINS, CARRY_COLS },
};
