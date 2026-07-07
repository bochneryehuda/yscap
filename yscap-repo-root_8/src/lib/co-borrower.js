'use strict';

// Co-borrower conditions (#73).
//
// The co-borrower's government-issued ID is a REAL document condition on the
// file — named with the co-borrower's name for clarity ("Government-issued ID —
// Jane Doe (co-borrower)") — created when a co-borrower is linked and removed
// when the co-borrower is unlinked. It's marked with field_key='cob_gov_id' so
// it is found / renamed / removed idempotently no matter how often sync runs.
//
// The co-borrower's PERSONAL INFO is NOT a condition — it's enforced as required
// fields on the file completeness (see the Completeness UI), per owner direction.

const db = require('../db');

const MARKER = 'cob_gov_id';

async function ensureCoBorrowerIdCondition(appId, coBorrowerId, client = db) {
  try {
    if (!coBorrowerId) {
      // Unlinked → drop the co-borrower ID condition.
      await client.query(`DELETE FROM checklist_items WHERE application_id=$1 AND field_key=$2`, [appId, MARKER]);
      return { removed: true };
    }
    const b = (await client.query(`SELECT first_name, last_name FROM borrowers WHERE id=$1`, [coBorrowerId])).rows[0];
    const name = b ? `${b.first_name || ''} ${b.last_name || ''}`.trim() : '';
    const label = `Government-issued ID — ${name || 'co-borrower'} (co-borrower)`;
    const existing = (await client.query(
      `SELECT id FROM checklist_items WHERE application_id=$1 AND field_key=$2 LIMIT 1`, [appId, MARKER])).rows[0];
    if (existing) {
      // Keep the name in step if the co-borrower record changed.
      await client.query(`UPDATE checklist_items SET label=$2, borrower_label=$2, updated_at=now() WHERE id=$1`, [existing.id, label]);
      return { itemId: existing.id, updated: true };
    }
    const ins = await client.query(
      `INSERT INTO checklist_items
         (scope, application_id, label, borrower_label, audience, item_kind, is_required, category, field_key, sort_order, status, created_by_kind)
       VALUES ('application',$1,$2,$2,'both','document',true,'prior_to_docs',$3,125,'outstanding','system')
       RETURNING id`,
      [appId, label, MARKER]);
    return { itemId: ins.rows[0].id, created: true };
  } catch (e) { console.error('[co-borrower] ensureCoBorrowerIdCondition', appId, e.message); return null; }
}

module.exports = { ensureCoBorrowerIdCondition, MARKER };
