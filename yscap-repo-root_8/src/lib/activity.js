/**
 * Per-file activity feed — a real audit trail, not just uploads.
 *
 * Two sources, merged and sorted:
 *   1. Domain tables (messages, documents, conditions, status history) which
 *      reliably carry the application_id.
 *   2. The audit_log — application edits (with field-level before/after
 *      diffs), product registrations/reprices (with the superseded terms),
 *      LLC links, appraisal card, rehab budget saves, closing dates,
 *      reminders, assignments…
 *
 * Every row is tagged borrower_safe so the borrower feed never surfaces
 * internal chat, staff notes, internal conditions or staff-only actions.
 * onlySafe=true => borrower view; false => full staff view.
 */
const db = require('../db');

const money = (v) => {
  const n = Number(v);
  return isFinite(n) ? '$' + Math.round(n).toLocaleString('en-US') : String(v);
};
const pct = (v) => {
  const n = Number(v);
  return isFinite(n) ? (n * 100).toFixed(2) + '%' : String(v);
};

// Human names for the application columns the staff edit endpoint can touch.
const FIELD_LABEL = {
  units: 'Units', purchase_price: 'Purchase price', as_is_value: 'As-is value',
  arv: 'ARV', rehab_budget: 'Rehab budget', sqft_pre: 'Existing sq ft', sqft_post: 'Completed sq ft',
  requested_exp_flips: 'Experience — flips', requested_exp_holds: 'Experience — holds',
  requested_exp_ground: 'Experience — ground-up', requested_exp_reo: 'Experience — REO',
  requested_ir_months: 'Interest reserve (months)',
  payoff_amount: 'Payoff amount', original_purchase_price: 'Original purchase price',
  acquisition_date: 'Date acquired', underlying_contract_price: 'Underlying contract price',
  assignment_fee: 'Assignment fee', property_type: 'Property type', loan_type: 'Loan type',
  program: 'Program', occupancy: 'Occupancy', rehab_type: 'Rehab type', term: 'Term',
  lender: 'Lender', channel: 'Channel', ppp: 'Prepayment penalty',
  is_assignment: 'Assignment purchase', property_address: 'Property address',
};
const MONEY_FIELDS = new Set(['purchase_price', 'as_is_value', 'arv', 'rehab_budget',
  'payoff_amount', 'original_purchase_price', 'underlying_contract_price', 'assignment_fee']);

const fieldVal = (col, v) => {
  if (v == null || v === '') return '—';
  if (MONEY_FIELDS.has(col)) return money(v);
  if (col === 'property_address') {
    try { const a = typeof v === 'string' ? JSON.parse(v) : v; return a.oneLine || [a.line1 || a.street, a.city, a.state].filter(Boolean).join(', ') || String(v); }
    catch (_) { return String(v); }
  }
  return String(v);
};

function describeChanges(changes) {
  const parts = [];
  for (const [col, ch] of Object.entries(changes || {})) {
    const label = FIELD_LABEL[col] || col.replace(/_/g, ' ');
    parts.push(`${label}: ${fieldVal(col, ch && ch.from)} → ${fieldVal(col, ch && ch.to)}`);
  }
  return parts.join('\n');
}

const PROGRAM_NAME = { gold: 'Gold Standard Program', standard: 'Standard Program' };

/* Audit actions surfaced in the feed. borrowerSafe rows show on the borrower
   feed too; the rest are staff-only. Each render() returns {verb, label}. */
const AUDIT_RENDER = {
  edit_application: {
    borrowerSafe: true, kind: 'edit',
    render(d) {
      const diff = d && d.changes ? describeChanges(d.changes) : '';
      return {
        verb: 'edited the application',
        label: diff || (d && d.fields ? `fields: ${d.fields.join(', ')}` : null),
      };
    },
  },
  register_product: {
    borrowerSafe: true, kind: 'product',
    render(d) {
      d = d || {};
      const name = d.productLabel || PROGRAM_NAME[d.program] || 'a product';
      const now = `${money(d.totalLoan)} @ ${pct(d.noteRate)}`;
      const lines = [];
      if (d.previous && (d.previous.totalLoan !== d.totalLoan || d.previous.noteRate !== d.noteRate || d.previous.program !== d.program)) {
        lines.push(`Replaced: ${d.previous.productLabel || PROGRAM_NAME[d.previous.program] || d.previous.program} · ${money(d.previous.totalLoan)} @ ${pct(d.previous.noteRate)}`);
      }
      if (d.cashToClose != null) lines.push(`Cash to close ${money(d.cashToClose)}`);
      if (d.liquidity != null) lines.push(`Liquidity to verify ${money(d.liquidity)}`);
      return {
        verb: (d.previous ? 'repriced & re-registered' : 'registered') + ` ${name} — ${now}`,
        label: lines.join('\n') || null,
      };
    },
  },
  link_llc: { borrowerSafe: true, kind: 'llc', render: (d) => ({ verb: (d && d.previous) ? 'switched the vesting entity' : 'linked the vesting entity', label: null }) },
  save_appraisal_card: { borrowerSafe: true, kind: 'card', render: (d) => ({ verb: 'saved the appraisal payment card', label: d && d.last4 ? `Card ending ${d.last4}` : null }) },
  save_rehab_budget: { borrowerSafe: true, kind: 'edit', render: (d) => ({ verb: 'updated the rehab budget / scope of work', label: d && d.total != null ? `New total ${money(d.total)}` : null }) },
  set_closing_date: {
    borrowerSafe: true, kind: 'status',
    render: (d) => ({
      verb: 'set the closing date',
      label: [d && d.expectedClosing ? `Expected: ${d.expectedClosing}` : null, d && d.actualClosing ? `Actual: ${d.actualClosing}` : null].filter(Boolean).join(' · ') || null,
    }),
  },
  nudge_borrower: { borrowerSafe: true, kind: 'message', render: (d) => ({ verb: 'sent a reminder of the outstanding items', label: d && d.count ? `${d.count} open item${d.count === 1 ? '' : 's'}` : null }) },
  create_application: { borrowerSafe: true, kind: 'status', render: () => ({ verb: 'created this loan file', label: null }) },
  // staff-only
  assign_application: { borrowerSafe: false, kind: 'edit', render: () => ({ verb: 'assigned the loan officer', label: null }) },
  assign_processor: { borrowerSafe: false, kind: 'edit', render: () => ({ verb: 'assigned the processor', label: null }) },
  invite_borrower: { borrowerSafe: false, kind: 'message', render: (d) => ({ verb: 'invited the borrower to the portal', label: (d && d.email) || null }) },
  add_checklist_item: { borrowerSafe: false, kind: 'condition', render: (d) => ({ verb: 'requested a document', label: (d && d.label) || null }) },
  add_condition_custom: { borrowerSafe: false, kind: 'condition', render: (d) => ({ verb: 'added a condition to the file', label: (d && d.label) || null }) },
  attach_condition: { borrowerSafe: false, kind: 'condition', render: (d) => ({ verb: 'attached a library condition', label: (d && d.label) || null }) },
  conditions_auto_evaluated: {
    borrowerSafe: false, kind: 'condition',
    render(d) {
      d = d || {};
      const added = (d.added || []).length, removed = (d.removed || []).length;
      const lines = [];
      if (added) lines.push(`Added: ${d.added.join(', ')}`);
      if (removed) lines.push(`Removed (never touched): ${d.removed.join(', ')}`);
      return { verb: 'condition rules ran automatically', label: lines.join('\n') || null };
    },
  },
  export_tpr: { borrowerSafe: false, kind: 'document', render: () => ({ verb: 'exported the clean file (TPR)', label: null }) },
  view_appraisal_card: { borrowerSafe: false, kind: 'card', render: (d) => ({ verb: 'revealed the appraisal card', label: d && d.last4 ? `Card ending ${d.last4} (audited)` : '(audited)' }) },
  delete_application: { borrowerSafe: false, kind: 'status', render: (d) => ({ verb: 'deleted the file', label: (d && d.reason) || null }) },
  restore_application: { borrowerSafe: false, kind: 'status', render: () => ({ verb: 'restored the file', label: null }) },
};

async function fileActivity(appId, onlySafe) {
  const r = await db.query(
    `SELECT at, kind, actor, actor_name, borrower_safe, verb, label FROM (
        SELECT created_at AS at, 'message' AS kind, sender_kind AS actor, NULL::text AS actor_name,
               (channel='borrower') AS borrower_safe,
               'sent a message' AS verb, NULL::text AS label
          FROM messages WHERE application_id=$1
        UNION ALL
        SELECT created_at, 'document', uploaded_by_kind, NULL,
               (visibility='borrower' AND source_type<>'chat_attachment'),
               CASE WHEN review_status='accepted' THEN 'accepted a document'
                    WHEN review_status='rejected' THEN 'flagged a document for correction'
                    ELSE 'uploaded a document' END,
               filename
          FROM documents WHERE application_id=$1 AND source_type<>'chat_attachment'
        UNION ALL
        SELECT COALESCE(cleared_at, created_at), 'condition', 'staff', NULL,
               (audience IN ('borrower','both')),
               CASE WHEN status='cleared' THEN 'cleared a condition'
                    WHEN status='waived' THEN 'waived a condition'
                    ELSE 'added a condition' END,
               -- Borrower feed ($2=true) never sees the internal title.
               CASE WHEN $2::bool THEN COALESCE(borrower_title, 'a condition')
                    ELSE COALESCE(borrower_title, title) END
          FROM conditions WHERE application_id=$1
        UNION ALL
        SELECT created_at, 'status', 'staff', NULL, true,
               'moved the file to '||replace(to_status,'_',' '), NULL
          FROM application_status_history WHERE application_id=$1
     ) q
     WHERE (NOT $2::bool OR q.borrower_safe)
     ORDER BY at DESC NULLS LAST LIMIT 120`, [appId, !!onlySafe]);

  // The audit-log trail: what changed, exactly, and by whom.
  const actions = Object.keys(AUDIT_RENDER).filter((a) => !onlySafe || AUDIT_RENDER[a].borrowerSafe);
  let auditRows = [];
  try {
    const ar = await db.query(
      `SELECT al.created_at AS at, al.actor_kind AS actor, al.action, al.detail,
              CASE WHEN al.actor_kind='staff' THEN s.full_name
                   WHEN al.actor_kind='borrower' THEN NULLIF(btrim(coalesce(b.first_name,'')||' '||coalesce(b.last_name,'')), '')
                   ELSE NULL END AS actor_name
         FROM audit_log al
         LEFT JOIN staff_users s ON al.actor_kind='staff' AND s.id=al.actor_id
         LEFT JOIN borrowers b ON al.actor_kind='borrower' AND b.id=al.actor_id
        WHERE al.entity_type='application' AND al.entity_id=$1 AND al.action = ANY($2::text[])
        ORDER BY al.created_at DESC LIMIT 150`, [appId, actions]);
    auditRows = ar.rows.map((row) => {
      const meta = AUDIT_RENDER[row.action];
      let detail = row.detail;
      if (typeof detail === 'string') { try { detail = JSON.parse(detail); } catch (_) { detail = null; } }
      const { verb, label } = meta.render(detail || {});
      return {
        at: row.at, kind: meta.kind, actor: row.actor, actor_name: row.actor_name,
        borrower_safe: meta.borrowerSafe, verb, label,
      };
    });
  } catch (_) { /* the feed must never fail on an audit hiccup */ }

  const all = [...r.rows, ...auditRows]
    .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0))
    .slice(0, 150);
  return all;
}

module.exports = { fileActivity };
