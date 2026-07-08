'use strict';

// Co-borrower conditions (#73, #100).
//
// The co-borrower's government-issued ID is a REAL document condition on the
// file — named with the co-borrower's name ("Government-issued ID — Jane Doe
// (co-borrower)") — created when a co-borrower is linked and removed when the
// co-borrower is unlinked. It's marked with field_key='cob_gov_id' so it is
// found / renamed / removed idempotently no matter how often sync runs.
//
// When a co-borrower exists, the PRIMARY borrower's own gov-ID condition
// (template rtl_p1_id) is ALSO renamed to carry the primary borrower's name, so
// the two ID conditions are distinguishable, and the co-borrower's is placed
// right next to the primary's (#100). Unlinking reverts the primary's label.
//
// The co-borrower's PERSONAL INFO is NOT a condition — it's enforced as required
// fields on the file completeness (see the Completeness UI), per owner direction.

const db = require('../db');

const MARKER = 'cob_gov_id';
const PRIMARY_ID_DEFAULT_LABEL = 'Borrower photo ID (government-issued)';

function nameOf(row) {
  return row ? `${row.first_name || ''} ${row.last_name || ''}`.trim() : '';
}

// Load the file's PRIMARY gov-ID condition (template rtl_p1_id) with the primary
// borrower's name and its current sort position.
async function loadPrimaryIdItem(appId, client) {
  return (await client.query(
    `SELECT ci.id, ci.sort_order, b.first_name, b.last_name
       FROM checklist_items ci
       JOIN applications a ON a.id = ci.application_id
       JOIN borrowers b ON b.id = a.borrower_id
       JOIN checklist_templates t ON t.id = ci.template_id
      WHERE ci.application_id = $1 AND t.code = 'rtl_p1_id'
      ORDER BY ci.created_at LIMIT 1`, [appId])).rows[0] || null;
}

async function ensureCoBorrowerIdCondition(appId, coBorrowerId, client = db) {
  try {
    const primary = await loadPrimaryIdItem(appId, client);

    if (!coBorrowerId) {
      // Unlinked → drop the co-borrower ID condition and revert the primary's
      // gov-ID label back to the generic template wording.
      await client.query(`DELETE FROM checklist_items WHERE application_id=$1 AND field_key=$2`, [appId, MARKER]);
      if (primary) {
        await client.query(
          `UPDATE checklist_items SET label=$2, borrower_label=$2, updated_at=now() WHERE id=$1`,
          [primary.id, PRIMARY_ID_DEFAULT_LABEL]);
      }
      return { removed: true };
    }

    // Rename the PRIMARY borrower's gov-ID condition to carry their name, so it
    // reads distinctly from the co-borrower's.
    if (primary) {
      const pName = nameOf(primary);
      const pLabel = `Government-issued ID — ${pName || 'primary borrower'} (borrower)`;
      await client.query(
        `UPDATE checklist_items SET label=$2, borrower_label=$2, updated_at=now() WHERE id=$1`,
        [primary.id, pLabel]);
    }

    const cb = (await client.query(`SELECT first_name, last_name FROM borrowers WHERE id=$1`, [coBorrowerId])).rows[0];
    const cbName = nameOf(cb);
    const label = `Government-issued ID — ${cbName || 'co-borrower'} (co-borrower)`;
    // Co-locate with the primary's gov-ID condition (sort right after it).
    const sortOrder = primary && primary.sort_order != null ? primary.sort_order : 125;

    const existing = (await client.query(
      `SELECT id FROM checklist_items WHERE application_id=$1 AND field_key=$2 LIMIT 1`, [appId, MARKER])).rows[0];
    if (existing) {
      await client.query(
        `UPDATE checklist_items SET label=$2, borrower_label=$2, sort_order=$3, updated_at=now() WHERE id=$1`,
        [existing.id, label, sortOrder]);
      return { itemId: existing.id, updated: true };
    }
    const ins = await client.query(
      `INSERT INTO checklist_items
         (scope, application_id, label, borrower_label, audience, item_kind, is_required, category, field_key, sort_order, status, created_by_kind)
       VALUES ('application',$1,$2,$2,'both','document',true,'prior_to_docs',$3,$4,'outstanding','system')
       RETURNING id`,
      [appId, label, MARKER, sortOrder]);
    return { itemId: ins.rows[0].id, created: true };
  } catch (e) { console.error('[co-borrower] ensureCoBorrowerIdCondition', appId, e.message); return null; }
}

module.exports = { ensureCoBorrowerIdCondition, MARKER };
