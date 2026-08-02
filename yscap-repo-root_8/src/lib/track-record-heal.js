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
 * WHAT IT WILL AND WILL NOT DO. A track record is underwriting evidence: it
 * feeds the experience tier, the deal counts and the experience condition. So a
 * row is only ever REMOVED when it is provably a duplicate that nobody has
 * worked:
 *
 *   * the two rows must be the same property by `sameAddress` — not by a key,
 *     which is unit-free and would collapse two condo units in one building;
 *   * the loser must be UNVERIFIED (a verified row is locked evidence);
 *   * the loser must be machine-written (origin clickup_backfill / encompass /
 *     pilot_funded, or inferred) — a line a human typed is theirs;
 *   * the loser must carry NO economics the keeper contradicts. Every figure it
 *     has must be absent on the keeper (in which case it is CARRIED OVER, so
 *     merging never loses a number) or already equal;
 *   * the loser must have no note beyond the machine's own.
 *
 * Anything else — two rows that both carry real work, a disagreement on a
 * figure — is LEFT ALONE and counted, because picking a winner there is a
 * human's call and a wrong guess deletes evidence.
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

/** Is this row safe to fold into `keep`? Returns a reason string, or null when safe. */
function refuseReason(row, keep) {
  if (row.is_verified) return 'verified';
  const machine = MACHINE_ORIGINS.has(String(row.origin || '')) || row.inferred === true;
  if (!machine) return 'human_authored';
  if (row.has_documents) return 'has_documents';
  if (row.has_conditions) return 'has_conditions';
  const note = String(row.notes || '').trim();
  if (note && !/unverified|auto-derived|added from|added automatically/i.test(note)) return 'has_note';
  for (const c of CARRY_COLS) {
    const a = norm(row[c]), b = norm(keep[c]);
    if (a != null && b != null && a !== b) return `conflict:${c}`;
  }
  return null;
}

/** Which row of a same-property group survives: the one carrying the most. */
function pickKeeper(rows) {
  const score = (r) => (r.is_verified ? 1000 : 0)
    + (r.has_documents ? 100 : 0)
    + (r.has_conditions ? 50 : 0)
    + (MACHINE_ORIGINS.has(String(r.origin || '')) || r.inferred ? 0 : 25)   // a human's line outranks a machine's
    + CARRY_COLS.reduce((n, c) => n + (norm(r[c]) != null ? 1 : 0), 0);
  return rows.slice().sort((a, b) => {
    const d = score(b) - score(a);
    if (d) return d;
    return new Date(a.created_at || 0) - new Date(b.created_at || 0);   // then the original
  })[0];
}

/** Group a borrower's rows into same-PROPERTY sets, decided by sameAddress. */
function groupByProperty(rows) {
  const groups = [];
  for (const r of rows) {
    const g = groups.find((grp) => grp.some((x) => TRK.sameProperty(x.property_address, r.property_address)));
    if (g) g.push(r); else groups.push([r]);
  }
  return groups.filter((g) => g.length > 1);
}

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

  for (const group of groupByProperty(rows)) {
    const keep = pickKeeper(group);
    for (const row of group) {
      if (row.id === keep.id) continue;
      const refuse = refuseReason(row, keep);
      if (refuse) { out.left.push({ borrowerId, id: row.id, keep: keep.id, reason: refuse }); continue; }
      // Carry over any figure only the loser has — merging must never lose data.
      const carry = CARRY_COLS.filter((c) => norm(row[c]) != null && norm(keep[c]) == null);
      if (carry.length) {
        await client.query(
          `UPDATE track_records SET ${carry.map((c, i) => `${c}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1`,
          [keep.id, ...carry.map((c) => row[c])]);
        for (const c of carry) keep[c] = row[c];
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
         performs a ROLLBACK and returns without throwing — so every merge in
         this borrower's batch would be discarded while the counters said it
         worked. (That is exactly what happened here: the column is `detail`, not
         `meta`, and the pass reported "merged 1, rekeyed 2" with nothing written.)
         The savepoint contains the failure so a best-effort write can never take
         the real work down with it — the same discipline finding-decisions uses. */
      await client.query('SAVEPOINT trk_audit');
      try {
        await client.query(
          `INSERT INTO audit_log (actor_kind, action, entity_type, entity_id, detail)
           VALUES ('system','track_record_duplicate_merged','borrower',$1,$2::jsonb)`,
          [borrowerId, JSON.stringify({ removed: row.id, keep: keep.id, carried: carry, origin: row.origin })]);
        await client.query('RELEASE SAVEPOINT trk_audit');
      } catch (_) {
        await client.query('ROLLBACK TO SAVEPOINT trk_audit').catch(() => {});
      }
      out.merged += 1;
    }
  }
}

/**
 * One bounded pass. Borrowers who could still hold a duplicate are those with
 * two or more rows; the marker records how far we got so a big book drains over
 * several boots instead of holding one up.
 */
async function healOnce({ limit = DEFAULT_LIMIT } = {}) {
  const out = { borrowers: 0, rekeyed: 0, merged: 0, left: [], ok: true };
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

module.exports = { healOnce, _internals: { refuseReason, pickKeeper, groupByProperty, MACHINE_ORIGINS, CARRY_COLS } };
