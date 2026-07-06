/**
 * Per-file activity feed. Built from domain tables (which reliably carry the
 * application_id) rather than the audit_log, and tagged borrower_safe so the
 * borrower feed never surfaces internal chat, staff notes, or internal
 * conditions. onlySafe=true => borrower view; false => full staff view.
 */
const db = require('../db');

async function fileActivity(appId, onlySafe) {
  const r = await db.query(
    `SELECT at, kind, actor, borrower_safe, verb, label FROM (
        SELECT created_at AS at, 'message' AS kind, sender_kind AS actor,
               (channel='borrower') AS borrower_safe,
               'sent a message' AS verb, NULL::text AS label
          FROM messages WHERE application_id=$1
        UNION ALL
        SELECT created_at, 'document', uploaded_by_kind,
               (visibility='borrower' AND source_type<>'chat_attachment'),
               CASE WHEN review_status='accepted' THEN 'accepted a document'
                    WHEN review_status='rejected' THEN 'flagged a document for correction'
                    ELSE 'uploaded a document' END,
               filename
          FROM documents WHERE application_id=$1 AND source_type<>'chat_attachment'
        UNION ALL
        SELECT COALESCE(cleared_at, created_at), 'condition', 'staff',
               (audience IN ('borrower','both')),
               CASE WHEN status='cleared' THEN 'cleared a condition'
                    WHEN status='waived' THEN 'waived a condition'
                    ELSE 'added a condition' END,
               -- Borrower feed ($2=true) never sees the internal title.
               CASE WHEN $2::bool THEN COALESCE(borrower_title, 'a condition')
                    ELSE COALESCE(borrower_title, title) END
          FROM conditions WHERE application_id=$1
        UNION ALL
        SELECT status_changed_at, 'status', 'staff', true,
               'moved the file to '||status, NULL
          FROM applications WHERE id=$1 AND status_changed_at IS NOT NULL
        UNION ALL
        SELECT created_at, 'product', 'staff', true,
               'registered a product', COALESCE(product_label, initcap(program)||' Program')
          FROM product_registrations WHERE application_id=$1
     ) q
     WHERE (NOT $2::bool OR q.borrower_safe)
     ORDER BY at DESC NULLS LAST LIMIT 100`, [appId, !!onlySafe]);
  return r.rows;
}

module.exports = { fileActivity };
