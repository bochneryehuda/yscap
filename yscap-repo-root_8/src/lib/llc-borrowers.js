'use strict';

// Borrower-owners of an LLC (#81). The subject vesting LLC on a co-borrower file
// is owned by BOTH borrowers, each with their own ownership %, and stays linked
// to both. This is an additive layer over the single-owner `llcs` row — it never
// touches the existing LLC verification math.

const db = require('../db');

function pct(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!isFinite(n) || n < 0 || n > 100) return { error: 'ownership % must be between 0 and 100' };
  return Math.round(n * 100) / 100;
}

// Link (or update) a borrower as an owner of an LLC with an optional stake.
async function linkBorrower(llcId, borrowerId, ownershipPct, client = db) {
  if (!llcId || !borrowerId) return;
  await client.query(
    `INSERT INTO llc_borrowers (llc_id, borrower_id, ownership_pct)
     VALUES ($1,$2,$3)
     ON CONFLICT (llc_id, borrower_id)
       DO UPDATE SET ownership_pct = COALESCE(EXCLUDED.ownership_pct, llc_borrowers.ownership_pct), updated_at = now()`,
    [llcId, borrowerId, ownershipPct == null ? null : ownershipPct]);
}

async function unlinkBorrower(llcId, borrowerId, client = db) {
  if (!llcId || !borrowerId) return;
  await client.query(`DELETE FROM llc_borrowers WHERE llc_id=$1 AND borrower_id=$2`, [llcId, borrowerId]);
}

// The borrower-owners of an LLC, primary first.
async function getOwners(llcId, client = db) {
  if (!llcId) return [];
  const r = await client.query(
    `SELECT lb.borrower_id, lb.ownership_pct,
            b.first_name, b.last_name,
            (l.borrower_id = lb.borrower_id) AS is_primary
       FROM llc_borrowers lb
       JOIN llcs l ON l.id = lb.llc_id
       JOIN borrowers b ON b.id = lb.borrower_id
      WHERE lb.llc_id = $1
      ORDER BY (l.borrower_id = lb.borrower_id) DESC, b.last_name, b.first_name`, [llcId]);
  return r.rows;
}

// Ensure the file's borrowers (primary + co-borrower) are linked to the file's
// vesting LLC. Called when a co-borrower is set or a vesting LLC is linked.
async function syncVestingLlcBorrowers(appId, client = db) {
  const a = (await client.query(
    `SELECT llc_id, borrower_id, co_borrower_id FROM applications WHERE id=$1`, [appId])).rows[0];
  if (!a || !a.llc_id) return;
  if (a.borrower_id) await linkBorrower(a.llc_id, a.borrower_id, null, client);
  if (a.co_borrower_id) await linkBorrower(a.llc_id, a.co_borrower_id, null, client);
}

module.exports = { pct, linkBorrower, unlinkBorrower, getOwners, syncVestingLlcBorrowers };
