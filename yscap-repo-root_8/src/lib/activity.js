/**
 * Per-file activity feed — the file's AUDIT LOG.
 *
 * Owner-directed (2026-08-02): "File activity should be much more enhanced.
 * You should see who uploaded that document, where he uploaded that document,
 * what happened with his document, and every single activity — who did it,
 * what was changed, timestamps. It should be your source of auditing when you
 * want to see what went wrong. Every communication, every notification, every
 * log, everything that happens in that file should be logged in that activity."
 *
 * THE STAFF FEED IS A UNION OF EVERY TRAIL THE FILE LEAVES:
 *   1. The domain tables that carry the application_id — messages, documents
 *      (arrival AND verdict as separate events), conditions, checklist items,
 *      status history, change requests, workflow hand-offs.
 *   2. The whole audit_log for the file — not a hand-maintained whitelist of
 *      ~40 actions, but EVERY row whose subject belongs to this loan: the
 *      application itself, its documents, its conditions, its entity, plus any
 *      row that recorded `applicationId` in its detail. An action nobody has
 *      written wording for is humanized rather than dropped, so a feature
 *      shipped tomorrow shows up here without a change to this file.
 *   3. Everything that LEFT the building — every notification raised, every
 *      email sent or received, and every push queued to ClickUp / Encompass /
 *      SharePoint with its outcome.
 *   4. Optionally (`includeRequests`) the request-level log: one line per HTTP
 *      request touching this file. It is off by default because it is enormous
 *      and mostly page loads; it is the layer you turn on when the business
 *      trail does not explain what happened.
 *
 * THE BORROWER FEED IS DELIBERATELY UNTOUCHED. It is the narrow, hand-audited
 * set of events the borrower THEMSELVES performed (`legacyFeed`, below) — a
 * structural split, not a filter over the wide query, so no amount of widening
 * on the staff side can ever leak an internal action onto a borrower screen.
 *
 * Every source is independently guarded: one unreadable table shortens the
 * feed, it never breaks it.
 */
const db = require('../db');
const { describeAction } = require('./audit-actions');

const money = (v) => {
  const n = Number(v);
  return isFinite(n) ? '$' + Math.round(n).toLocaleString('en-US') : String(v);
};
// Rate display only (note rate) — 3-decimal precision so 10.625% never truncates
// to 10.63% (owner-directed 2026-08-04). Not used for LTC/LTV here.
const { fmtRatePct } = require('./rate-format');
const pct = (v) => {
  const n = Number(v);
  return isFinite(n) ? fmtRatePct(n) + '%' : String(v);
};

// Human names for the application columns the staff edit endpoint can touch.
const FIELD_LABEL = {
  units: 'Units', purchase_price: 'Purchase price', as_is_value: 'As-is value',
  arv: 'ARV', rehab_budget: 'Rehab budget', sqft_pre: 'Existing sq ft', sqft_post: 'Completed sq ft',
  requested_exp_flips: 'Experience — flips', requested_exp_holds: 'Experience — holds',
  requested_exp_ground: 'Experience — ground-up', requested_exp_reo: 'Experience — REO',
  requested_ir_months: 'Interest reserve (months)',
  requested_ir_amount: 'Interest reserve (amount)',
  payoff_amount: 'Payoff amount', original_purchase_price: 'Original purchase price',
  // The payoff section (db/386 + db/267's estimated_cash_out) — named here so the
  // Activity feed says "Lender being paid off: — → Chase" instead of a raw column.
  payoff_lender: 'Lender being paid off', payoff_loan_number: 'Payoff loan number',
  estimated_cash_out: 'Cash out to the borrower',
  acquisition_date: 'Date acquired', underlying_contract_price: 'Underlying contract price',
  assignment_fee: 'Assignment fee', property_type: 'Property type', loan_type: 'Loan type',
  program: 'Program', occupancy: 'Occupancy', rehab_type: 'Rehab type', term: 'Term',
  lender: 'Lender', channel: 'Channel', ppp: 'Prepayment penalty',
  is_assignment: 'Assignment purchase', property_address: 'Property address',
};
const MONEY_FIELDS = new Set(['purchase_price', 'as_is_value', 'arv', 'rehab_budget',
  'payoff_amount', 'estimated_cash_out', 'original_purchase_price', 'underlying_contract_price', 'assignment_fee']);

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

const PROGRAM_NAME = { gold: 'Gold Standard Program', standard: 'Standard Program', silver: 'Silver Program', manual: 'Manual Program' };

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
  // The experience typed in the Term Sheet Studio becomes the file's CLAIM the
  // moment the scenario saves (owner-directed 2026-08-06) — and that claim is
  // what the track-record condition then refuses to be signed off without. STAFF
  // ONLY: it belongs to the underwriter reading "why does this file suddenly need
  // ten verified holds?", not to the borrower's feed.
  studio_experience_claim: {
    borrowerSafe: false, kind: 'product',
    render(d) {
      d = d || {};
      const bits = [
        d.flips != null ? `${d.flips} flip${d.flips === 1 ? '' : 's'}` : null,
        d.holds != null ? `${d.holds} hold${d.holds === 1 ? '' : 's'} / rentals` : null,
        d.ground != null ? `${d.ground} ground-up` : null,
      ].filter(Boolean);
      return {
        verb: 'set the claimed experience from the Term Sheet Studio',
        label: bits.length ? `${bits.join(' · ')} — must be verified on the track record before the experience condition can be signed off` : null,
      };
    },
  },
  link_llc: { borrowerSafe: true, kind: 'llc', render: (d) => ({ verb: (d && d.previous) ? 'switched the vesting entity' : 'linked the vesting entity', label: null }) },
  save_appraisal_card: { borrowerSafe: true, kind: 'card', render: (d) => ({ verb: 'saved the appraisal payment card', label: d && d.last4 ? `Card ending ${d.last4}` : null }) },
  // Clearing is borrower-safe on purpose: the card was THEIR payment detail, so them
  // seeing that it was removed from the file is transparency, not a leak.
  clear_appraisal_card: { borrowerSafe: true, kind: 'card', render: (d) => ({ verb: 'cleared the appraisal payment card from the file', label: d && d.last4 ? `Card ending ${d.last4} — permanently removed` : 'Permanently removed' }) },
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
  archive_application: { borrowerSafe: false, kind: 'status', render: (d) => ({ verb: 'archived the file', label: (d && d.reason) || null }) },
  // Legacy soft-deletes (pre-archive rename) still render on old files.
  delete_application: { borrowerSafe: false, kind: 'status', render: (d) => ({ verb: 'archived the file', label: (d && d.reason) || null }) },
  purge_application: { borrowerSafe: false, kind: 'status', render: (d) => ({ verb: 'deleted the file permanently', label: (d && d.reason) || null }) },
  restore_application: { borrowerSafe: false, kind: 'status', render: () => ({ verb: 'restored the file', label: null }) },
};

/* ══════════════════════════════════════════════════════════════════════════
   THE BORROWER FEED — unchanged, and deliberately its own code path.

   This is the narrow, hand-audited set of events the borrower themselves
   performed. It is NOT the staff query with a filter bolted on: keeping it
   structurally separate is what guarantees that widening the staff audit log
   (which is the whole point of the work below) can never leak an internal
   action, a staff note or a staff-only condition onto a borrower's screen.
   ══════════════════════════════════════════════════════════════════════════ */
async function legacyFeed(appId, onlySafe) {
  const r = await db.query(
    `SELECT at, kind, actor, actor_name, borrower_safe, verb, label FROM (
        SELECT created_at AS at, 'message' AS kind, sender_kind AS actor, NULL::text AS actor_name,
               (channel='borrower') AS borrower_safe,
               'sent a message' AS verb, NULL::text AS label
          FROM messages WHERE application_id=$1
        UNION ALL
        SELECT d.created_at, 'document', d.uploaded_by_kind, NULL,
               (d.visibility='borrower' AND d.source_type<>'chat_attachment'),
               -- Borrower feed ($2=true): the borrower's own action was the
               -- UPLOAD; accept/flag are staff review actions and must not read
               -- as "Borrower accepted a document". Staff feed keeps the detail.
               CASE WHEN $2::bool THEN 'uploaded a document'
                    WHEN d.review_status='accepted' THEN 'accepted a document'
                    WHEN d.review_status='rejected' THEN 'flagged a document for correction'
                    ELSE 'uploaded a document' END,
               -- WHICH document, and WHICH condition it was uploaded to
               -- (owner-directed 2026-07-31: "you should be able to see which
               -- document the borrower uploaded, and which condition"). The
               -- borrower feed never sees an internal label — borrower_label
               -- first, then a borrower-audience item's own label (what their
               -- checklist already shows), then the slot. Staff see the
               -- internal label. A loose upload keeps just the filename.
               d.filename || COALESCE(E'\nFor: ' || CASE WHEN $2::bool
                     THEN COALESCE(NULLIF(ci.borrower_label,''),
                                   CASE WHEN ci.audience IN ('borrower','both') THEN NULLIF(ci.label,'') END,
                                   NULLIF(d.slot_label,''))
                     ELSE COALESCE(NULLIF(ci.label,''), NULLIF(d.slot_label,'')) END, '')
          FROM documents d LEFT JOIN checklist_items ci ON ci.id = d.checklist_item_id
         WHERE d.application_id=$1 AND d.source_type<>'chat_attachment'
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
     -- Borrower feed ($2=true): only events the borrower THEMSELVES performed
     -- (owner request) — never staff actions, status moves, or conditions.
     WHERE (NOT $2::bool OR (q.borrower_safe AND q.actor = 'borrower'))
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

  // Borrower feed: only audit events the borrower themselves performed (their
  // own uploads / edits) — staff-logged edits, reprices, reminders, closing
  // dates, etc. are internal and stay off the borrower-facing log.
  if (onlySafe) auditRows = auditRows.filter((row) => row.actor === 'borrower');

  const all = [...r.rows, ...auditRows]
    .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0))
    .slice(0, 150);
  return all;
}

/* ══════════════════════════════════════════════════════════════════════════
   THE STAFF AUDIT LOG
   ══════════════════════════════════════════════════════════════════════════ */

// The SQL for a person's display name. `full_name` is the generated column
// (db/346) every surface reads; the join is the fallback for a row written
// before it existed. Never re-inline a bare concatenation (session rule).
const STAFF_NAME_SQL = (a) => `NULLIF(${a}.full_name,'')`;
const BORROWER_NAME_SQL = (a) => `COALESCE(NULLIF(${a}.full_name,''),
  NULLIF(btrim(COALESCE(${a}.first_name,'')||' '||COALESCE(${a}.last_name,'')),''))`;

/* One row of the feed. `kind` drives the icon, `cat` the filter chips.
   `detail` is the raw jsonb an auditor expands to see the exact before/after. */
const row = (o) => ({
  at: o.at || null,
  kind: o.kind || 'other',
  cat: o.cat || 'other',
  source: o.source || 'domain',
  actor: o.actor || null,
  actor_name: o.actor_name || null,
  actor_role: o.actor_role || null,
  // The real human behind an action taken inside a borrower-view session.
  impersonator: o.impersonator || null,
  verb: o.verb || '',
  label: o.label == null ? null : String(o.label),
  entity_type: o.entity_type || null,
  entity_id: o.entity_id || null,
  detail: o.detail || null,
  ip: o.ip || null,
  user_agent: o.user_agent || null,
  borrower_safe: false,
});

const parseDetail = (d) => {
  if (d == null) return null;
  if (typeof d === 'object') return d;
  try { const j = JSON.parse(d); return j && typeof j === 'object' ? j : null; } catch (_) { return null; }
};

const SKIP_DETAIL_KEYS = new Set(['applicationId', 'application_id', 'appId']);

/**
 * Render an audit detail blob as readable lines for the row's summary. The
 * FULL blob still travels in `detail` for the expanded view — this is only the
 * one-glance summary, so it stays short and never prints a nested object.
 */
function summarizeDetail(d) {
  if (!d) return null;
  if (d.changes && typeof d.changes === 'object') {
    const diff = describeChanges(d.changes);
    if (diff) return diff;
  }
  const parts = [];
  for (const [k, v] of Object.entries(d)) {
    if (SKIP_DETAIL_KEYS.has(k) || v == null || v === '') continue;
    if (k === 'changes') continue;
    if (typeof v === 'object') {
      parts.push(`${FIELD_LABEL[k] || k.replace(/_/g, ' ')}: ${Array.isArray(v) ? `${v.length} item${v.length === 1 ? '' : 's'}` : '…'}`);
    } else {
      parts.push(`${FIELD_LABEL[k] || k.replace(/_/g, ' ')}: ${String(v).slice(0, 160)}`);
    }
    if (parts.length >= 6) break;
  }
  return parts.join(' · ') || null;
}

/* audit_log category → the feed's icon `kind`, so a brand-new action still
   gets a sensible icon instead of a bare dot. */
const CAT_KIND = {
  pii: 'security', auth: 'security', file: 'edit', pricing: 'product',
  document: 'document', condition: 'condition', llc: 'llc',
  track_record: 'track', borrower: 'borrower', vendor: 'vendor',
  message: 'message', setup: 'setup', sync: 'sync', other: 'other',
};

/** One guarded source. A source that throws contributes nothing and says so. */
async function source(name, fn, problems) {
  try { return (await fn()) || []; }
  catch (e) { problems.push(`${name}: ${(e && e.message) || 'unavailable'}`); return []; }
}

/**
 * Run tasks with a CEILING on how many are in flight at once.
 *
 * This is not tidiness. The audit log reads ~45 tables, and `DB_POOL_MAX` is 10
 * — firing them all through one `Promise.all` would take every connection in
 * the pool for the duration of the read, and a request that cannot get a
 * connection does not fail fast, it WAITS (the pool-exhaustion incident this
 * repo already has a regression test for). One person opening this tab must
 * never be able to stall the rest of the app, so the fan-out is bounded well
 * under the pool and leaves connections for everyone else.
 */
const DB_FANOUT = 5;
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ── 1. Documents — arrival and verdict are SEPARATE events ─────────────────
// The old feed emitted ONE row per document whose verb depended on the current
// review_status, so accepting a document ERASED the upload from the history.
// An audit log may not lose an event because a later one happened.
async function docEvents(appId) {
  const r = await db.query(
    `SELECT d.id, d.filename, d.created_at, d.reviewed_at, d.review_status, d.rejection_reason,
            d.uploaded_by_kind, d.slot_label, d.source_type, d.visibility, d.doc_kind,
            d.size_bytes, d.is_current, d.sharepoint_backed_up_at,
            ci.label AS item_label, ci.audience AS item_audience,
            ${STAFF_NAME_SQL('rv')} AS reviewed_by_name,
            ${STAFF_NAME_SQL('su')} AS staff_uploader,
            ${BORROWER_NAME_SQL('bu')} AS borrower_uploader
       FROM documents d
       LEFT JOIN checklist_items ci ON ci.id = d.checklist_item_id
       LEFT JOIN staff_users rv ON rv.id = d.reviewed_by
       LEFT JOIN staff_users su ON d.uploaded_by_kind='staff' AND su.id = d.uploaded_by_id
       LEFT JOIN borrowers bu ON d.uploaded_by_kind='borrower' AND bu.id = d.uploaded_by_id
      WHERE d.application_id=$1
      ORDER BY d.created_at DESC LIMIT 400`, [appId]);
  const out = [];
  for (const d of r.rows) {
    const where = d.item_label
      ? `Uploaded to the condition "${d.item_label}"${d.slot_label ? ` · slot "${d.slot_label}"` : ''}`
      : d.slot_label ? `Slot "${d.slot_label}"`
      : 'Filed on the loan — not attached to a condition';
    const meta = [
      SOURCE_LABEL[d.source_type] || null,
      d.visibility === 'borrower' ? 'the borrower can see it' : 'staff only',
      d.is_current === false ? 'since replaced' : null,
    ].filter(Boolean).join(' · ');
    out.push(row({
      at: d.created_at, kind: 'document', cat: 'document', source: 'documents',
      actor: d.uploaded_by_kind, actor_name: d.staff_uploader || d.borrower_uploader || null,
      verb: 'uploaded a document',
      label: [d.filename, where, meta].filter(Boolean).join('\n'),
      entity_type: 'document', entity_id: d.id,
    }));
    if (d.reviewed_at && (d.review_status === 'accepted' || d.review_status === 'rejected')) {
      out.push(row({
        at: d.reviewed_at, kind: 'document', cat: 'document', source: 'documents',
        actor: 'staff', actor_name: d.reviewed_by_name,
        verb: d.review_status === 'accepted' ? 'accepted a document' : 'rejected a document',
        label: [d.filename, d.item_label ? `On the condition "${d.item_label}"` : null,
          d.review_status === 'rejected' && d.rejection_reason ? `Reason: ${d.rejection_reason}` : null,
        ].filter(Boolean).join('\n'),
        entity_type: 'document', entity_id: d.id,
      }));
    }
    if (d.sharepoint_backed_up_at) {
      out.push(row({
        at: d.sharepoint_backed_up_at, kind: 'sync', cat: 'sync', source: 'documents',
        actor: 'system', verb: 'synced a document to SharePoint', label: d.filename,
        entity_type: 'document', entity_id: d.id,
      }));
    }
  }
  return out;
}

const SOURCE_LABEL = {
  borrower_upload: 'borrower upload', staff_upload: 'staff upload',
  chat_attachment: 'chat attachment', document_request: 'requested document',
  condition: 'condition evidence', tpr: 'clean-file export',
  post_closing: 'post-closing', system: 'generated by PILOT',
};

// ── 2. Messages ────────────────────────────────────────────────────────────
async function messageEvents(appId) {
  const r = await db.query(
    `SELECT m.id, m.created_at, m.sender_kind, m.channel, m.body, m.is_task_request, m.deleted_at,
            ${STAFF_NAME_SQL('s')} AS staff_name, ${BORROWER_NAME_SQL('b')} AS borrower_name
       FROM messages m
       LEFT JOIN staff_users s ON m.sender_kind='staff' AND s.id=m.sender_id
       LEFT JOIN borrowers b ON m.sender_kind='borrower' AND b.id=m.sender_id
      WHERE m.application_id=$1
      ORDER BY m.created_at DESC LIMIT 300`, [appId]);
  return r.rows.map((m) => row({
    at: m.created_at, kind: 'message', cat: 'message', source: 'messages',
    actor: m.sender_kind, actor_name: m.staff_name || m.borrower_name || null,
    verb: m.deleted_at ? 'sent a message (since deleted)'
      : m.is_task_request ? 'asked the loan team for something'
      : `sent a message on the ${m.channel === 'borrower' ? 'borrower' : 'internal'} channel`,
    label: String(m.body || '').slice(0, 400) || null,
    entity_type: 'message', entity_id: m.id,
  }));
}

// ── 3. Conditions + checklist items ────────────────────────────────────────
// The checklist items were NEVER in the feed — which is why "who signed this
// off, and when?" could not be answered here at all.
async function conditionEvents(appId) {
  const c = await db.query(
    `SELECT c.id, c.created_at, c.cleared_at, c.status, c.title, c.borrower_title, c.audience,
            c.severity, c.waive_reason, ${STAFF_NAME_SQL('cb')} AS created_by_name,
            ${STAFF_NAME_SQL('cl')} AS cleared_by_name
       FROM conditions c
       LEFT JOIN staff_users cb ON cb.id=c.created_by
       LEFT JOIN staff_users cl ON cl.id=c.cleared_by
      WHERE c.application_id=$1 ORDER BY c.created_at DESC LIMIT 300`, [appId]);
  const out = [];
  for (const x of c.rows) {
    out.push(row({
      at: x.created_at, kind: 'condition', cat: 'condition', source: 'conditions',
      actor: 'staff', actor_name: x.created_by_name, verb: 'added a condition to the file',
      label: [x.title, x.severity && x.severity !== 'standard' ? `Timing: ${x.severity.replace(/_/g, ' ')}` : null,
        `Shown to: ${x.audience}`].filter(Boolean).join('\n'),
      entity_type: 'condition', entity_id: x.id,
    }));
    if (x.cleared_at) {
      out.push(row({
        at: x.cleared_at, kind: 'condition', cat: 'condition', source: 'conditions',
        actor: 'staff', actor_name: x.cleared_by_name,
        verb: x.status === 'waived' ? 'waived a condition' : 'cleared a condition',
        label: [x.title, x.waive_reason ? `Reason: ${x.waive_reason}` : null].filter(Boolean).join('\n'),
        entity_type: 'condition', entity_id: x.id,
      }));
    }
  }
  const ci = await db.query(
    `SELECT ci.id, ci.created_at, ci.label, ci.status, ci.audience, ci.item_kind, ci.is_gate,
            ci.signed_off_at, ci.waived_at, ci.reviewed_at, ci.issue_reason,
            ci.override_at, ci.override_reason, ci.override_blocked_reason,
            ${STAFF_NAME_SQL('so')} AS signed_off_by_name,
            ${STAFF_NAME_SQL('wv')} AS waived_by_name,
            ${STAFF_NAME_SQL('ov')} AS override_by_name
       FROM checklist_items ci
       LEFT JOIN staff_users so ON so.id=ci.signed_off_by
       LEFT JOIN staff_users wv ON wv.id=ci.waived_by
       LEFT JOIN staff_users ov ON ov.id=ci.override_by
      WHERE ci.application_id=$1 ORDER BY ci.created_at DESC LIMIT 400`, [appId]);
  for (const x of ci.rows) {
    out.push(row({
      at: x.created_at, kind: 'condition', cat: 'condition', source: 'checklist',
      actor: 'system', verb: x.is_gate ? 'put a gate on the file' : 'put a condition on the file',
      label: [x.label, `Shown to: ${x.audience}`].filter(Boolean).join('\n'),
      entity_type: 'checklist_item', entity_id: x.id,
    }));
    if (x.signed_off_at) out.push(row({
      at: x.signed_off_at, kind: 'condition', cat: 'condition', source: 'checklist',
      actor: 'staff', actor_name: x.signed_off_by_name, verb: 'signed off a condition',
      label: x.label, entity_type: 'checklist_item', entity_id: x.id,
    }));
    if (x.waived_at) out.push(row({
      at: x.waived_at, kind: 'condition', cat: 'condition', source: 'checklist',
      actor: 'staff', actor_name: x.waived_by_name, verb: 'waived a condition',
      label: x.label, entity_type: 'checklist_item', entity_id: x.id,
    }));
    if (x.override_at) out.push(row({
      at: x.override_at, kind: 'security', cat: 'condition', source: 'checklist',
      actor: 'staff', actor_name: x.override_by_name,
      verb: 'used a super-admin override to clear a condition',
      label: [x.label, x.override_reason ? `Reason: ${x.override_reason}` : null,
        x.override_blocked_reason ? `What was missing: ${x.override_blocked_reason}` : null,
      ].filter(Boolean).join('\n'),
      entity_type: 'checklist_item', entity_id: x.id,
    }));
  }
  return out;
}

// ── 4. Status history ──────────────────────────────────────────────────────
async function statusEvents(appId) {
  const r = await db.query(
    `SELECT h.created_at, h.from_status, h.to_status, ${STAFF_NAME_SQL('s')} AS staff_name
       FROM application_status_history h
       LEFT JOIN staff_users s ON s.id = h.changed_by
      WHERE h.application_id=$1 ORDER BY h.created_at DESC LIMIT 200`, [appId]);
  return r.rows.map((h) => row({
    at: h.created_at, kind: 'status', cat: 'file', source: 'status',
    actor: 'staff', actor_name: h.staff_name,
    verb: `moved the file to ${String(h.to_status || '').replace(/_/g, ' ')}`,
    label: h.from_status ? `From: ${String(h.from_status).replace(/_/g, ' ')}` : null,
  }));
}

// ── 5. The WHOLE audit log for this file ───────────────────────────────────
// Not a whitelist. Every row whose subject belongs to this loan — the file, its
// documents, its conditions, its checklist items, its entity — plus every row
// that recorded `applicationId` in its detail (246 call sites do).
async function auditEvents(appId, limit) {
  const r = await db.query(
    `SELECT al.id, al.created_at AS at, al.actor_kind, al.actor_id, al.action,
            al.entity_type, al.entity_id, al.detail, al.ip_address, al.user_agent,
            ${STAFF_NAME_SQL('s')} AS staff_name, s.role AS staff_role,
            ${BORROWER_NAME_SQL('b')} AS borrower_name,
            ${STAFF_NAME_SQL('imp')} AS impersonator_name
       FROM audit_log al
       LEFT JOIN staff_users s ON al.actor_kind='staff' AND s.id=al.actor_id
       LEFT JOIN borrowers b ON al.actor_kind='borrower' AND b.id=al.actor_id
       LEFT JOIN staff_users imp ON imp.id = al.impersonator_staff_id
      WHERE (al.entity_type='application' AND al.entity_id=$1)
         OR (al.detail->>'applicationId' = $1::text)
         OR (al.entity_type='document' AND al.entity_id IN
              (SELECT id FROM documents WHERE application_id=$1))
         OR (al.entity_type IN ('checklist_item','condition') AND al.entity_id IN
              (SELECT id FROM checklist_items WHERE application_id=$1
               UNION ALL SELECT id FROM conditions WHERE application_id=$1))
      -- One row MORE than we want, so "was this cut short?" is measured rather
      -- than inferred from rows === limit (see trailEvents). The extra is
      -- dropped below, so the events are exactly what they always were.
      ORDER BY al.created_at DESC LIMIT $2`, [appId, limit + 1]);
  const truncated = r.rows.length > limit;
  const events = r.rows.slice(0, limit).map((a) => {
    const d = parseDetail(a.detail);
    const known = AUDIT_RENDER[a.action];
    const meta = describeAction(a.action);
    // A hand-written renderer (richer wording, field-level diffs) wins; anything
    // else falls back to the flat catalog label + a rendered detail blob, so an
    // action added tomorrow appears here with no change to this file.
    const rendered = known ? known.render(d || {}) : null;
    // ON-BEHALF-OF. A staffer inside a borrower-view session acts with the
    // BORROWER's identity (db/320), so without this every one of their actions
    // reads as the borrower having done it — the single most misleading thing
    // an audit log can do. The real human is named, and the row is filed under
    // "Access & security" so it is never buried.
    const impersonated = !!a.impersonator_name;
    return row({
      at: a.at,
      kind: impersonated ? 'security' : (known ? known.kind : (CAT_KIND[meta.cat] || 'other')),
      cat: impersonated ? 'security' : meta.cat, source: 'audit',
      actor: a.actor_kind, actor_name: a.staff_name || a.borrower_name || null,
      actor_role: a.staff_role || null,
      impersonator: a.impersonator_name || null,
      verb: rendered ? rendered.verb : meta.label.toLowerCase().replace(/^(\w)/, (m) => m.toLowerCase()),
      label: [
        impersonated ? `⚠️ Done by ${a.impersonator_name} while signed in as this borrower.` : null,
        (rendered && rendered.label) || summarizeDetail(d),
      ].filter(Boolean).join('\n') || null,
      entity_type: a.entity_type, entity_id: a.entity_id,
      detail: d, ip: a.ip_address, user_agent: a.user_agent,
    });
  });
  // The audit log is the biggest source on a busy file and caps independently
  // of the outer window, so it is the one most likely to be quietly short.
  return withTruncation(events, truncated, limit);
}

// ── 6. Notifications raised on this file ───────────────────────────────────
async function notificationEvents(appId) {
  const r = await db.query(
    `SELECT n.id, n.created_at, n.type, n.title, n.body, n.recipient_kind,
            n.email_status, n.email_error, n.emailed_at, n.read_at,
            ${STAFF_NAME_SQL('s')} AS staff_name, ${BORROWER_NAME_SQL('b')} AS borrower_name
       FROM notifications n
       LEFT JOIN staff_users s ON s.id=n.staff_id
       LEFT JOIN borrowers b ON b.id=n.borrower_id
      WHERE n.application_id=$1 ORDER BY n.created_at DESC LIMIT 300`, [appId]);
  return r.rows.map((n) => {
    const who = n.staff_name || n.borrower_name || (n.recipient_kind === 'borrower' ? 'the borrower' : 'the loan team');
    const mail = n.email_status === 'sent' ? 'emailed'
      : n.email_status === 'error' ? `email FAILED${n.email_error ? ` — ${n.email_error}` : ''}`
      : n.email_status === 'skipped' ? 'in-app only (no email)'
      : 'email pending';
    return row({
      at: n.created_at, kind: 'notification', cat: 'notification', source: 'notifications',
      actor: 'system', verb: `notified ${who}`,
      label: [n.title, n.body ? String(n.body).slice(0, 240) : null,
        `${mail}${n.read_at ? ' · read' : ' · unread'}`].filter(Boolean).join('\n'),
      entity_type: 'notification', entity_id: n.id,
      detail: { type: n.type, recipient: who, emailStatus: n.email_status, emailedAt: n.emailed_at },
    });
  });
}

// ── 7. Email in and out ────────────────────────────────────────────────────
async function emailEvents(appId) {
  const r = await db.query(
    `SELECT id, occurred_at, direction, subject, preview, from_email, from_name,
            to_emails, cc_emails, status, error, msg_type, category, attachments
       FROM email_messages
      WHERE application_id=$1 ORDER BY occurred_at DESC LIMIT 300`, [appId]);
  const addrs = (v) => {
    if (!Array.isArray(v)) return '';
    return v.map((x) => (x && typeof x === 'object' ? (x.email || x.address || '') : String(x || '')))
      .filter(Boolean).join(', ');
  };
  return r.rows.map((e) => {
    const inbound = e.direction === 'inbound';
    const att = Array.isArray(e.attachments) ? e.attachments.length : 0;
    return row({
      at: e.occurred_at, kind: 'email', cat: 'email', source: 'email',
      actor: inbound ? 'external' : 'system',
      actor_name: inbound ? (e.from_name || e.from_email || null) : null,
      verb: inbound ? 'an email came in on this file' : 'an email went out',
      label: [e.subject || '(no subject)',
        inbound ? `From: ${e.from_email || 'unknown'}` : `To: ${addrs(e.to_emails) || 'unknown'}`,
        addrs(e.cc_emails) ? `Cc: ${addrs(e.cc_emails)}` : null,
        att ? `${att} attachment${att === 1 ? '' : 's'}` : null,
        e.status && e.status !== 'sent' && e.status !== 'received' ? `Status: ${e.status}` : null,
        e.error ? `Error: ${e.error}` : null,
        e.preview ? String(e.preview).slice(0, 200) : null,
      ].filter(Boolean).join('\n'),
      entity_type: 'email', entity_id: e.id,
      detail: { type: e.msg_type, category: e.category, status: e.status },
    });
  });
}

// ── 8. What we pushed to the other systems, and whether it landed ──────────
async function syncEvents(appId) {
  const r = await db.query(
    `SELECT q.id, q.created_at, q.updated_at, q.entity_type, q.entity_id, q.target,
            q.direction, q.op, q.status, q.attempts, q.last_error
       FROM sync_queue q
      WHERE (q.entity_type='application' AND q.entity_id=$1)
         OR (q.entity_type='document' AND q.entity_id IN
              (SELECT id FROM documents WHERE application_id=$1))
         OR (q.entity_type='checklist_item' AND q.entity_id IN
              (SELECT id FROM checklist_items WHERE application_id=$1))
      ORDER BY q.updated_at DESC LIMIT 200`, [appId]);
  return r.rows.map((q) => row({
    at: q.updated_at || q.created_at, kind: 'sync', cat: 'sync', source: 'sync_queue',
    actor: 'system',
    verb: q.status === 'done' ? `${q.direction === 'pull' ? 'pulled from' : 'pushed to'} ${q.target}`
      : q.status === 'error' ? `FAILED to ${q.direction === 'pull' ? 'pull from' : 'push to'} ${q.target}`
      : `queued a ${q.direction} with ${q.target}`,
    label: [`${q.op} · ${q.entity_type}`,
      q.attempts ? `${q.attempts} attempt${q.attempts === 1 ? '' : 's'}` : null,
      q.last_error ? `Error: ${q.last_error}` : null].filter(Boolean).join('\n'),
    entity_type: q.entity_type, entity_id: q.entity_id,
  }));
}

// ── 9. Borrower change requests ────────────────────────────────────────────
async function changeRequestEvents(appId) {
  const r = await db.query(
    `SELECT cr.id, cr.created_at, cr.decided_at, cr.field_label, cr.old_value, cr.new_value,
            cr.reason, cr.status, cr.requested_by_kind, cr.decision_note,
            ${STAFF_NAME_SQL('s')} AS decided_by_name
       FROM change_requests cr
       LEFT JOIN staff_users s ON s.id=cr.decided_by
      WHERE cr.application_id=$1 ORDER BY cr.created_at DESC LIMIT 100`, [appId]);
  const out = [];
  for (const c of r.rows) {
    out.push(row({
      at: c.created_at, kind: 'edit', cat: 'file', source: 'change_requests',
      actor: c.requested_by_kind, verb: 'asked for a change to the file',
      label: [`${c.field_label}: ${c.old_value || '—'} → ${c.new_value}`,
        c.reason ? `Why: ${c.reason}` : null].filter(Boolean).join('\n'),
      entity_type: 'change_request', entity_id: c.id,
    }));
    if (c.decided_at) out.push(row({
      at: c.decided_at, kind: 'edit', cat: 'file', source: 'change_requests',
      actor: 'staff', actor_name: c.decided_by_name,
      verb: `${c.status} a requested change`,
      label: [`${c.field_label}: ${c.old_value || '—'} → ${c.new_value}`,
        c.decision_note ? `Note: ${c.decision_note}` : null].filter(Boolean).join('\n'),
      entity_type: 'change_request', entity_id: c.id,
    }));
  }
  return out;
}

// ── 10. Workflow hand-offs between desks ───────────────────────────────────
async function workflowEvents(appId) {
  const r = await db.query(
    `SELECT w.id, w.created_at, w.event_type, w.submission_type, w.outcome_label, w.note,
            ${STAFF_NAME_SQL('a')} AS actor_name,
            ${STAFF_NAME_SQL('f')} AS from_name, ${STAFF_NAME_SQL('t')} AS to_name
       FROM workflow_events w
       LEFT JOIN staff_users a ON a.id=w.actor_staff_id
       LEFT JOIN staff_users f ON f.id=w.from_staff_id
       LEFT JOIN staff_users t ON t.id=w.to_staff_id
      WHERE w.application_id=$1 ORDER BY w.created_at DESC LIMIT 150`, [appId]);
  const VERB = {
    submitted: 'handed the file to another desk', picked_up: 'picked the file up',
    returned: 'sent the file back', reassigned: 'reassigned the file',
    cancelled: 'cancelled a hand-off', note: 'left a note on the hand-off',
  };
  return r.rows.map((w) => row({
    at: w.created_at, kind: 'workflow', cat: 'file', source: 'workflow',
    actor: 'staff', actor_name: w.actor_name,
    verb: VERB[w.event_type] || String(w.event_type || '').replace(/_/g, ' '),
    label: [w.submission_type ? `Type: ${String(w.submission_type).replace(/_/g, ' ')}` : null,
      w.from_name || w.to_name ? `${w.from_name || '—'} → ${w.to_name || '—'}` : null,
      w.outcome_label || null, w.note || null].filter(Boolean).join('\n'),
    entity_type: 'workflow_event', entity_id: w.id,
  }));
}

/* ── 11. EVERY OTHER TRAIL THE FILE LEAVES ──────────────────────────────────
   One entry per trail: a query and a mapper that turns each record into one or
   more events. Adding a trail is ONE entry — never a new bespoke function — and
   each runs inside its own guard, so a table a tenant does not have (several
   are behind feature switches) shortens the log instead of breaking it.

   `$1` is always the application id. Keep every query LIMIT-ed. */
const val = (v) => (v == null || v === '' ? '—' : String(v).slice(0, 200));
// Money on the draw side is stored in CENTS (the file's own money helper
// above takes DOLLARS — do not confuse the two).
const cents = (c) => (c == null ? '—' : `$${Math.round(Number(c) / 100).toLocaleString('en-US')}`);

const TRAILS = [
  // Signatures — the most consequential thing that leaves the building.
  {
    name: 'e-signatures',
    sql: `SELECT e.id, e.purpose, e.status, e.sent_at, e.completed_at, e.declined_at,
                 e.voided_at, e.void_reason, e.cleared_at, e.clear_reason, e.is_test,
                 ${STAFF_NAME_SQL('c')} AS created_by_name, ${STAFF_NAME_SQL('cl')} AS cleared_by_name
            FROM esign_envelopes e
            LEFT JOIN staff_users c ON c.id=e.created_by
            LEFT JOIN staff_users cl ON cl.id=e.cleared_by
           WHERE e.application_id=$1 ORDER BY e.sent_at DESC NULLS LAST LIMIT 60`,
    map: (e) => {
      const what = String(e.purpose || 'package').replace(/_/g, ' ');
      const out = [];
      if (e.sent_at) out.push(row({ at: e.sent_at, kind: 'document', cat: 'document', source: 'e-sign',
        actor: 'staff', actor_name: e.created_by_name, verb: `sent the ${what} out for signature`,
        label: e.is_test ? 'TEST envelope' : null, entity_type: 'esign_envelope', entity_id: e.id }));
      if (e.completed_at) out.push(row({ at: e.completed_at, kind: 'document', cat: 'document', source: 'e-sign',
        actor: 'system', verb: `the ${what} came back fully signed`, entity_type: 'esign_envelope', entity_id: e.id }));
      if (e.declined_at) out.push(row({ at: e.declined_at, kind: 'security', cat: 'document', source: 'e-sign',
        actor: 'external', verb: `someone DECLINED to sign the ${what}`, entity_type: 'esign_envelope', entity_id: e.id }));
      if (e.voided_at) out.push(row({ at: e.voided_at, kind: 'document', cat: 'document', source: 'e-sign',
        actor: 'staff', verb: `voided the ${what}`, label: e.void_reason || null, entity_type: 'esign_envelope', entity_id: e.id }));
      if (e.cleared_at) out.push(row({ at: e.cleared_at, kind: 'condition', cat: 'condition', source: 'e-sign',
        actor: 'staff', actor_name: e.cleared_by_name, verb: `cleared the ${what} package off the file`,
        label: e.clear_reason || null, entity_type: 'esign_envelope', entity_id: e.id }));
      return out;
    },
  },
  // Who actually signed, and who never opened it.
  {
    name: 'signers',
    sql: `SELECT r.id, r.name, r.email, r.role, r.status, r.sent_at, r.delivered_at,
                 r.signed_at, r.declined_at, r.decline_reason, r.is_countersigner, e.purpose
            FROM esign_recipients r
            JOIN esign_envelopes e ON e.id = r.envelope_row_id
           WHERE e.application_id=$1 ORDER BY r.sent_at DESC NULLS LAST LIMIT 120`,
    map: (r) => {
      const who = r.name || r.email || 'a signer';
      const what = String(r.purpose || 'package').replace(/_/g, ' ');
      const out = [];
      if (r.delivered_at) out.push(row({ at: r.delivered_at, kind: 'document', cat: 'document', source: 'e-sign',
        actor: 'external', actor_name: who, verb: `opened the ${what}`, label: r.email || null }));
      if (r.signed_at) out.push(row({ at: r.signed_at, kind: 'document', cat: 'document', source: 'e-sign',
        actor: 'external', actor_name: who, verb: `SIGNED the ${what}`,
        label: [r.email, r.is_countersigner ? 'counter-signer' : (r.role || null)].filter(Boolean).join(' · ') }));
      if (r.declined_at) out.push(row({ at: r.declined_at, kind: 'security', cat: 'document', source: 'e-sign',
        actor: 'external', actor_name: who, verb: `DECLINED to sign the ${what}`, label: r.decline_reason || null }));
      return out;
    },
  },
  // Findings raised on the file, and what a human decided about each.
  {
    name: 'appraisal findings',
    sql: `SELECT f.id, f.created_at, f.resolved_at, f.code, f.severity, f.field,
                 f.appraisal_value, f.file_value, f.status, f.resolution, f.resolution_note,
                 f.blocks_ctc, ${STAFF_NAME_SQL('s')} AS resolved_by_name
            FROM appraisal_findings f
            LEFT JOIN staff_users s ON s.id=f.resolved_by
           WHERE f.application_id=$1 ORDER BY f.created_at DESC LIMIT 150`,
    map: (f) => {
      const out = [row({ at: f.created_at, kind: 'condition', cat: 'condition', source: 'appraisal',
        actor: 'system', verb: `PILOT raised a ${f.severity} appraisal finding${f.blocks_ctc ? ' that blocks clear-to-close' : ''}`,
        label: [String(f.code || '').replace(/_/g, ' '),
          f.field ? `${f.field}: appraisal says ${val(f.appraisal_value)}, the file says ${val(f.file_value)}` : null,
        ].filter(Boolean).join('\n'), entity_type: 'appraisal_finding', entity_id: f.id })];
      if (f.resolved_at) out.push(row({ at: f.resolved_at, kind: 'condition', cat: 'condition', source: 'appraisal',
        actor: 'staff', actor_name: f.resolved_by_name,
        verb: `${f.status === 'dismissed' ? 'dismissed' : 'resolved'} an appraisal finding`,
        label: [String(f.code || '').replace(/_/g, ' '), f.resolution ? `Chose: ${f.resolution}` : null, f.resolution_note || null]
          .filter(Boolean).join('\n'), entity_type: 'appraisal_finding', entity_id: f.id }));
      return out;
    },
  },
  {
    name: 'document findings',
    sql: `SELECT f.id, f.created_at, f.resolved_at, f.code, f.severity, f.field, f.title,
                 f.doc_value, f.file_value, f.status, f.resolution, f.resolution_note,
                 f.blocks_ctc, ${STAFF_NAME_SQL('s')} AS resolved_by_name
            FROM document_findings f
            LEFT JOIN staff_users s ON s.id=f.resolved_by
           WHERE f.application_id=$1 ORDER BY f.created_at DESC LIMIT 150`,
    map: (f) => {
      const out = [row({ at: f.created_at, kind: 'condition', cat: 'condition', source: 'document review',
        actor: 'system', verb: `PILOT raised a ${f.severity} document finding${f.blocks_ctc ? ' that blocks clear-to-close' : ''}`,
        label: [f.title || String(f.code || '').replace(/_/g, ' '),
          f.field ? `${f.field}: the document says ${val(f.doc_value)}, the file says ${val(f.file_value)}` : null,
        ].filter(Boolean).join('\n'), entity_type: 'document_finding', entity_id: f.id })];
      if (f.resolved_at) out.push(row({ at: f.resolved_at, kind: 'condition', cat: 'condition', source: 'document review',
        actor: 'staff', actor_name: f.resolved_by_name,
        verb: `${f.status === 'dismissed' ? 'dismissed' : 'resolved'} a document finding`,
        label: [f.title || String(f.code || '').replace(/_/g, ' '), f.resolution ? `Chose: ${f.resolution}` : null, f.resolution_note || null]
          .filter(Boolean).join('\n'), entity_type: 'document_finding', entity_id: f.id }));
      return out;
    },
  },
  // WHY AN ALARM STOPPED SHOWING — the durable decision ledger.
  {
    name: 'finding decisions',
    sql: `SELECT d.id, d.decided_at, d.finding_key, d.origin, d.decision, d.suppressed, d.note,
                 ${STAFF_NAME_SQL('s')} AS decided_by_name
            FROM finding_decisions d
            LEFT JOIN staff_users s ON s.id=d.decided_by
           WHERE d.application_id=$1 ORDER BY d.decided_at DESC LIMIT 150`,
    map: (d) => [row({ at: d.decided_at, kind: 'condition', cat: 'condition', source: 'finding ledger',
      actor: 'staff', actor_name: d.decided_by_name,
      verb: `decided a finding — ${String(d.decision || '').replace(/_/g, ' ')}${d.suppressed ? ' (it will not be raised again)' : ''}`,
      label: [String(d.finding_key || '').replace(/_/g, ' '), d.note || null].filter(Boolean).join('\n'),
      entity_type: 'finding_decision', entity_id: d.id })],
  },
  {
    name: 'escalations',
    sql: `SELECT e.id, e.created_at, e.decided_at, e.code, e.severity, e.title, e.target_role,
                 e.question, e.status, e.decision, e.decision_note,
                 ${STAFF_NAME_SQL('rq')} AS requested_by_name, ${STAFF_NAME_SQL('dc')} AS decided_by_name
            FROM finding_escalations e
            LEFT JOIN staff_users rq ON rq.id=e.requested_by
            LEFT JOIN staff_users dc ON dc.id=e.decided_by
           WHERE e.application_id=$1 ORDER BY e.created_at DESC LIMIT 60`,
    map: (e) => {
      const out = [row({ at: e.created_at, kind: 'security', cat: 'condition', source: 'escalation',
        actor: 'staff', actor_name: e.requested_by_name,
        verb: `escalated a finding to ${String(e.target_role || 'a reviewer').replace(/_/g, ' ')}`,
        label: [e.title || e.code, e.question || null].filter(Boolean).join('\n'),
        entity_type: 'finding_escalation', entity_id: e.id })];
      if (e.decided_at) out.push(row({ at: e.decided_at, kind: 'security', cat: 'condition', source: 'escalation',
        actor: 'staff', actor_name: e.decided_by_name, verb: `answered an escalation — ${e.decision || e.status}`,
        label: [e.title || e.code, e.decision_note || null].filter(Boolean).join('\n'),
        entity_type: 'finding_escalation', entity_id: e.id }));
      return out;
    },
  },
  // The policy-exception register — every override, with its reason.
  {
    name: 'policy exceptions',
    sql: `SELECT x.id, x.requested_at, x.decided_at, x.withdrawn_at, x.exception_type, x.status,
                 x.reason_code, x.reason_note, x.decision_note, x.exception_seq, x.severity,
                 ${STAFF_NAME_SQL('rq')} AS requested_by_name, ${STAFF_NAME_SQL('dc')} AS decided_by_name
            FROM loan_exceptions x
            LEFT JOIN staff_users rq ON rq.id=x.requested_by
            LEFT JOIN staff_users dc ON dc.id=x.decided_by
           WHERE x.application_id=$1 ORDER BY x.requested_at DESC LIMIT 60`,
    map: (x) => {
      const ref = x.exception_seq ? `EX-${x.exception_seq}` : 'an exception';
      const what = String(x.exception_type || '').replace(/_/g, ' ');
      const out = [row({ at: x.requested_at, kind: 'security', cat: 'security', source: 'exceptions',
        actor: 'staff', actor_name: x.requested_by_name, verb: `raised ${ref} — ${what}`,
        label: [x.reason_code ? `Reason: ${String(x.reason_code).replace(/_/g, ' ')}` : null, x.reason_note || null]
          .filter(Boolean).join('\n'), entity_type: 'loan_exception', entity_id: x.id })];
      if (x.decided_at) out.push(row({ at: x.decided_at, kind: 'security', cat: 'security', source: 'exceptions',
        actor: 'staff', actor_name: x.decided_by_name, verb: `${x.status} ${ref} — ${what}`,
        label: x.decision_note || null, entity_type: 'loan_exception', entity_id: x.id }));
      if (x.withdrawn_at) out.push(row({ at: x.withdrawn_at, kind: 'security', cat: 'security', source: 'exceptions',
        actor: 'staff', verb: `withdrew ${ref}`, entity_type: 'loan_exception', entity_id: x.id }));
      return out;
    },
  },
  // A credit pull is a regulated act on a consumer.
  {
    name: 'credit pulls',
    sql: `SELECT c.id, c.pulled_at, c.vendor, c.pull_type, c.status, c.error, c.middle_score, c.source,
                 ${STAFF_NAME_SQL('s')} AS pulled_by_name, ${BORROWER_NAME_SQL('b')} AS borrower_name
            FROM credit_reports c
            LEFT JOIN staff_users s ON s.id=c.pulled_by
            LEFT JOIN borrowers b ON b.id=c.borrower_id
           WHERE c.application_id=$1 ORDER BY c.pulled_at DESC LIMIT 40`,
    map: (c) => [row({ at: c.pulled_at, kind: 'security', cat: 'security', source: 'credit',
      actor: 'staff', actor_name: c.pulled_by_name,
      verb: `${c.source === 'upload' ? 'filed' : 'pulled'} a ${c.pull_type === 'hard' ? 'HARD' : (c.pull_type || '')} credit report`,
      label: [c.borrower_name ? `For: ${c.borrower_name}` : null, c.vendor || null,
        c.middle_score ? `Middle score ${c.middle_score}` : null,
        c.status && c.status !== 'ok' ? `Status: ${c.status}` : null, c.error || null].filter(Boolean).join(' · '),
      entity_type: 'credit_report', entity_id: c.id })],
  },
  // Vendor orders: title, insurance, the closing attorney.
  {
    name: 'orders',
    sql: `SELECT o.id, o.ordered_at, o.last_followup_at, o.order_type, o.status, o.vendor_name,
                 o.send_count, o.followup_count, ${STAFF_NAME_SQL('s')} AS ordered_by_name
            FROM file_orders o
            LEFT JOIN staff_users s ON s.id=o.ordered_by
           WHERE o.application_id=$1 ORDER BY o.ordered_at DESC NULLS LAST LIMIT 40`,
    map: (o) => {
      const out = [];
      if (o.ordered_at) out.push(row({ at: o.ordered_at, kind: 'vendor', cat: 'file', source: 'orders',
        actor: 'staff', actor_name: o.ordered_by_name, verb: `ordered ${String(o.order_type || '').replace(/_/g, ' ')}`,
        label: [o.vendor_name ? `From: ${o.vendor_name}` : null, `Status: ${o.status}`].filter(Boolean).join(' · '),
        entity_type: 'file_order', entity_id: o.id }));
      if (o.last_followup_at) out.push(row({ at: o.last_followup_at, kind: 'vendor', cat: 'file', source: 'orders',
        actor: 'staff', verb: `chased the ${String(o.order_type || '').replace(/_/g, ' ')} vendor`,
        label: `${o.followup_count || 1} follow-up${(o.followup_count || 1) === 1 ? '' : 's'} so far`,
        entity_type: 'file_order', entity_id: o.id }));
      return out;
    },
  },
  // The priced structure of record — what was actually quoted.
  {
    name: 'registrations',
    sql: `SELECT p.id, p.created_at, p.program, p.product_label, p.status, p.note_rate,
                 p.total_loan, p.is_current, ${STAFF_NAME_SQL('s')} AS registered_by_name
            FROM product_registrations p
            LEFT JOIN staff_users s ON s.id=p.registered_by
           WHERE p.application_id=$1 ORDER BY p.created_at DESC LIMIT 40`,
    map: (p) => [row({ at: p.created_at, kind: 'product', cat: 'pricing', source: 'registrations',
      actor: 'staff', actor_name: p.registered_by_name,
      verb: `registered ${p.product_label || p.program || 'a product'}`,
      label: [p.total_loan != null ? `$${Math.round(Number(p.total_loan)).toLocaleString('en-US')}` : null,
        p.note_rate != null ? `${fmtRatePct(p.note_rate)}%` : null,
        p.status ? `Engine: ${p.status}` : null, p.is_current ? 'current' : 'superseded'].filter(Boolean).join(' · '),
      entity_type: 'product_registration', entity_id: p.id })],
  },
  // Cross-system conflicts we deliberately HELD rather than applied.
  {
    name: 'sync reviews',
    sql: `SELECT q.id, q.created_at, q.resolved_at, q.direction, q.field_key, q.current_value,
                 q.proposed_value, q.reason, q.status, q.resolution_note,
                 ${STAFF_NAME_SQL('s')} AS resolved_by_name
            FROM sync_review_queue q
            LEFT JOIN staff_users s ON s.id=q.resolved_by
           WHERE q.application_id=$1 ORDER BY q.created_at DESC LIMIT 80`,
    map: (q) => {
      const line = `${String(q.field_key || '').replace(/_/g, ' ')}: ours ${val(q.current_value)} · theirs ${val(q.proposed_value)}`;
      const out = [row({ at: q.created_at, kind: 'sync', cat: 'sync', source: 'sync review',
        actor: 'system', verb: 'held a cross-system disagreement for a human to decide',
        label: [line, q.reason ? `Why: ${String(q.reason).replace(/_/g, ' ')}` : null].filter(Boolean).join('\n'),
        entity_type: 'sync_review', entity_id: String(q.id) })];
      if (q.resolved_at) out.push(row({ at: q.resolved_at, kind: 'sync', cat: 'sync', source: 'sync review',
        actor: 'staff', actor_name: q.resolved_by_name, verb: `${q.status} a cross-system disagreement`,
        label: [line, q.resolution_note || null].filter(Boolean).join('\n'),
        entity_type: 'sync_review', entity_id: String(q.id) }));
      return out;
    },
  },
  // Field-level outbound journal — including the writes the PII shield REFUSED.
  {
    name: 'ClickUp writes',
    sql: `SELECT id, created_at, source, field_key, old_value, new_value, changed, blocked
            FROM clickup_write_log WHERE application_id=$1
           ORDER BY created_at DESC LIMIT 150`,
    map: (w) => (!w.changed && !w.blocked ? [] : [row({
      at: w.created_at, kind: w.blocked ? 'security' : 'sync', cat: w.blocked ? 'security' : 'sync',
      source: 'ClickUp', actor: 'system',
      verb: w.blocked ? 'REFUSED to overwrite a field in ClickUp' : 'wrote a field to ClickUp',
      label: `${String(w.field_key || '').replace(/_/g, ' ')}: ${val(w.old_value)} → ${val(w.new_value)}${w.source ? ` (${String(w.source).replace(/_/g, ' ')})` : ''}`,
      entity_type: 'clickup_write', entity_id: String(w.id),
    })]),
  },
  // Every Condition-Center answer. Last-write-wins, so the feed is the ONLY
  // history these values will ever have.
  {
    name: 'field answers',
    sql: `SELECT v.field_key, v.value, v.updated_at, v.updated_by_kind,
                 ${STAFF_NAME_SQL('s')} AS staff_name, ${BORROWER_NAME_SQL('b')} AS borrower_name
            FROM application_field_values v
            LEFT JOIN staff_users s ON v.updated_by_kind='staff' AND s.id=v.updated_by_id
            LEFT JOIN borrowers b ON v.updated_by_kind='borrower' AND b.id=v.updated_by_id
           WHERE v.application_id=$1 ORDER BY v.updated_at DESC LIMIT 150`,
    map: (v) => [row({ at: v.updated_at, kind: 'edit', cat: 'file', source: 'fields',
      actor: v.updated_by_kind, actor_name: v.staff_name || v.borrower_name || null,
      verb: 'answered a field on the file',
      label: `${String(v.field_key || '').replace(/_/g, ' ')}: ${val(typeof v.value === 'object' ? JSON.stringify(v.value) : v.value)}`,
      entity_type: 'field', entity_id: null })],
  },
  // How long the file sat on each desk.
  {
    name: 'desk hand-offs',
    sql: `SELECT w.id, w.received_at, w.picked_up_at, w.returned_at, w.submission_type, w.status,
                 w.outcome_label, w.note, w.to_role,
                 ${STAFF_NAME_SQL('f')} AS from_name, ${STAFF_NAME_SQL('t')} AS to_name
            FROM workflow_items w
            LEFT JOIN staff_users f ON f.id=w.from_staff_id
            LEFT JOIN staff_users t ON t.id=w.to_staff_id
           WHERE w.application_id=$1 ORDER BY w.received_at DESC NULLS LAST LIMIT 60`,
    map: (w) => {
      const what = String(w.submission_type || 'the file').replace(/_/g, ' ');
      const out = [];
      if (w.received_at) out.push(row({ at: w.received_at, kind: 'workflow', cat: 'file', source: 'workflow',
        actor: 'staff', actor_name: w.from_name, verb: `sent ${what} to ${w.to_name || String(w.to_role || 'another desk').replace(/_/g, ' ')}`,
        label: w.note || null, entity_type: 'workflow_item', entity_id: w.id }));
      if (w.picked_up_at) out.push(row({ at: w.picked_up_at, kind: 'workflow', cat: 'file', source: 'workflow',
        actor: 'staff', actor_name: w.to_name, verb: `picked ${what} up`,
        entity_type: 'workflow_item', entity_id: w.id }));
      if (w.returned_at) out.push(row({ at: w.returned_at, kind: 'workflow', cat: 'file', source: 'workflow',
        actor: 'staff', actor_name: w.to_name, verb: `sent ${what} back`,
        label: w.outcome_label || null, entity_type: 'workflow_item', entity_id: w.id }));
      return out;
    },
  },
  // Who was given access to the file, and who lost it.
  {
    name: 'file team',
    sql: `SELECT a.id, a.added_at, a.removed_at, a.role, a.is_primary,
                 ${STAFF_NAME_SQL('s')} AS staff_name, ${STAFF_NAME_SQL('ab')} AS added_by_name
            FROM application_assignees a
            LEFT JOIN staff_users s ON s.id=a.staff_id
            LEFT JOIN staff_users ab ON ab.id=a.added_by
           WHERE a.application_id=$1 ORDER BY a.added_at DESC LIMIT 60`,
    map: (a) => {
      const seat = `${a.is_primary ? 'primary ' : ''}${String(a.role || '').replace(/_/g, ' ')}`;
      const out = [row({ at: a.added_at, kind: 'security', cat: 'security', source: 'access',
        actor: 'staff', actor_name: a.added_by_name,
        verb: `gave ${a.staff_name || 'a staff member'} access as ${seat}`,
        entity_type: 'assignee', entity_id: a.id })];
      if (a.removed_at) out.push(row({ at: a.removed_at, kind: 'security', cat: 'security', source: 'access',
        actor: 'staff', verb: `removed ${a.staff_name || 'a staff member'} from the file (${seat})`,
        entity_type: 'assignee', entity_id: a.id }));
      return out;
    },
  },
  // THE HIGHEST-SENSITIVITY EVENT THE SYSTEM RECORDS: a staffer stepping into
  // the borrower's own portal.
  {
    name: 'borrower-view sessions',
    sql: `SELECT v.id, v.started_at, v.ended_at, v.end_reason, v.request_count, v.ip_address,
                 v.staff_role, ${STAFF_NAME_SQL('s')} AS staff_name, ${BORROWER_NAME_SQL('b')} AS borrower_name
            FROM borrower_view_sessions v
            LEFT JOIN staff_users s ON s.id=v.staff_id
            LEFT JOIN borrowers b ON b.id=v.borrower_id
           WHERE v.application_id=$1 ORDER BY v.started_at DESC LIMIT 60`,
    map: (v) => {
      const out = [row({ at: v.started_at, kind: 'security', cat: 'security', source: 'borrower view',
        actor: 'staff', actor_name: v.staff_name, actor_role: v.staff_role,
        verb: `signed in as ${v.borrower_name || 'the borrower'} to see their portal`,
        label: 'Everything they did during this session is recorded under the borrower’s name — look for the ⚠️ rows.',
        entity_type: 'borrower_view_session', entity_id: v.id, ip: v.ip_address })];
      if (v.ended_at) out.push(row({ at: v.ended_at, kind: 'security', cat: 'security', source: 'borrower view',
        actor: 'staff', actor_name: v.staff_name, verb: 'left the borrower’s portal',
        label: [v.end_reason ? `Ended: ${String(v.end_reason).replace(/_/g, ' ')}` : null,
          v.request_count ? `${v.request_count} actions during the session` : null].filter(Boolean).join(' · '),
        entity_type: 'borrower_view_session', entity_id: v.id, ip: v.ip_address }));
      return out;
    },
  },
  // What PILOT proposed, and what a human did about it.
  {
    name: 'PILOT suggestions',
    sql: `SELECT a.id, a.created_at, a.decided_at, a.source, a.kind, a.title, a.body, a.severity,
                 a.status, a.status_reason, ${STAFF_NAME_SQL('s')} AS decided_by_name
            FROM ai_suggestions a
            LEFT JOIN staff_users s ON s.id=a.decided_by_staff_id
           WHERE a.application_id=$1 ORDER BY a.created_at DESC LIMIT 100`,
    map: (a) => {
      const out = [row({ at: a.created_at, kind: 'condition', cat: 'condition', source: 'PILOT',
        actor: 'system', verb: `suggested something (${String(a.source || '').replace(/_/g, ' ')})`,
        label: [a.title, a.body ? String(a.body).slice(0, 240) : null].filter(Boolean).join('\n'),
        entity_type: 'ai_suggestion', entity_id: a.id })];
      if (a.decided_at) out.push(row({ at: a.decided_at, kind: 'condition', cat: 'condition', source: 'PILOT',
        actor: 'staff', actor_name: a.decided_by_name,
        verb: `${String(a.status || 'decided').replace(/_/g, ' ')} a PILOT suggestion`,
        label: [a.title, a.status_reason || null].filter(Boolean).join('\n'),
        entity_type: 'ai_suggestion', entity_id: a.id }));
      return out;
    },
  },
  // Mail that arrived FOR the file — including the deliveries that failed.
  {
    name: 'inbound mail',
    sql: `SELECT id, received_at, from_email, subject, status, forwarded_to
            FROM inbound_file_emails WHERE application_id=$1
           ORDER BY received_at DESC LIMIT 100`,
    map: (m) => [row({ at: m.received_at, kind: 'email', cat: 'email', source: 'inbound mail',
      actor: 'external', actor_name: m.from_email,
      verb: m.status === 'forwarded' ? 'emailed the file (delivered to the team)'
        : m.status === 'received' ? 'emailed the file'
        : `emailed the file — NOT delivered (${String(m.status || 'unknown').replace(/_/g, ' ')})`,
      label: [m.subject || '(no subject)',
        Array.isArray(m.forwarded_to) && m.forwarded_to.length ? `Forwarded to: ${m.forwarded_to.join(', ')}` : null,
      ].filter(Boolean).join('\n'),
      entity_type: 'inbound_email', entity_id: String(m.id) })],
  },
  // ── CONSTRUCTION DRAWS — money leaving the building ─────────────────────
  {
    name: 'draws',
    sql: `SELECT d.id, d.submitted_at, d.approved_at, d.number, d.name, d.status,
                 d.total_requested_cents, d.total_approved_cents
            FROM sitewire_draws d WHERE d.application_id=$1
           ORDER BY d.submitted_at DESC NULLS LAST LIMIT 60`,
    map: (d) => {
      const which = d.number != null ? `draw #${d.number}` : (d.name || 'a draw');
      const out = [];
      if (d.submitted_at) out.push(row({ at: d.submitted_at, kind: 'workflow', cat: 'draws', source: 'draws',
        actor: 'borrower', verb: `submitted ${which}`,
        label: d.total_requested_cents ? `Requested ${cents(d.total_requested_cents)}` : null,
        entity_type: 'draw', entity_id: d.id }));
      if (d.approved_at) out.push(row({ at: d.approved_at, kind: 'workflow', cat: 'draws', source: 'draws',
        actor: 'staff', verb: `approved ${which}`,
        label: [d.total_approved_cents ? `Approved ${cents(d.total_approved_cents)}` : null,
          d.total_requested_cents && d.total_approved_cents && d.total_requested_cents !== d.total_approved_cents
            ? `(asked for ${cents(d.total_requested_cents)})` : null].filter(Boolean).join(' '),
        entity_type: 'draw', entity_id: d.id }));
      return out;
    },
  },
  {
    name: 'draw money',
    sql: `SELECT b.id, COALESCE(b.release_date::timestamptz, b.created_at) AS at,
                 b.approved_cents, b.fee_cents, b.net_release_cents, b.funded_status, b.note,
                 ${STAFF_NAME_SQL('s')} AS by_name
            FROM draw_disbursements b
            LEFT JOIN staff_users s ON s.id=b.created_by
           WHERE b.application_id=$1 ORDER BY 2 DESC LIMIT 100`,
    map: (b) => [row({ at: b.at, kind: 'card', cat: 'draws', source: 'draws',
      actor: 'staff', actor_name: b.by_name,
      verb: `released ${cents(b.net_release_cents)} on a draw`,
      label: [b.approved_cents ? `Approved ${cents(b.approved_cents)}` : null,
        b.fee_cents ? `less a ${cents(b.fee_cents)} fee` : null,
        b.funded_status ? `Status: ${b.funded_status}` : null, b.note || null].filter(Boolean).join(' · '),
      entity_type: 'disbursement', entity_id: b.id })],
  },
  {
    name: 'inspection results',
    sql: `SELECT f.id, f.delivered_at, f.accepted_at, f.accepted_via, f.status,
                 f.total_requested_cents, f.total_approved_cents
            FROM draw_findings f WHERE f.application_id=$1
           ORDER BY f.delivered_at DESC NULLS LAST LIMIT 60`,
    map: (f) => {
      const out = [];
      if (f.delivered_at) out.push(row({ at: f.delivered_at, kind: 'workflow', cat: 'draws', source: 'draws',
        actor: 'staff', verb: 'sent the inspection result to the borrower',
        label: f.total_approved_cents ? `Approved ${cents(f.total_approved_cents)} of ${cents(f.total_requested_cents)}` : null,
        entity_type: 'draw_finding', entity_id: f.id }));
      if (f.accepted_at) out.push(row({ at: f.accepted_at, kind: 'workflow', cat: 'draws', source: 'draws',
        actor: 'borrower',
        verb: f.status === 'disputed' ? 'DISPUTED the inspection result' : 'accepted the inspection result',
        label: f.accepted_via ? `Via ${f.accepted_via}` : null,
        entity_type: 'draw_finding', entity_id: f.id }));
      return out;
    },
  },
  {
    name: 'lien waivers',
    sql: `SELECT w.id, COALESCE(w.received_at, w.created_at) AS at, w.kind, w.tier, w.party_name,
                 w.amount_cents, w.status, ${STAFF_NAME_SQL('s')} AS by_name
            FROM draw_lien_waivers w
            LEFT JOIN staff_users s ON s.id=w.created_by
           WHERE w.application_id=$1 ORDER BY 2 DESC LIMIT 80`,
    map: (w) => [row({ at: w.at, kind: 'document', cat: 'draws', source: 'draws',
      actor: 'staff', actor_name: w.by_name,
      verb: w.received_at ? 'received a lien waiver' : 'recorded a lien waiver as required',
      label: [w.party_name || null, w.kind ? String(w.kind).replace(/_/g, ' ') : null,
        w.tier || null, w.amount_cents ? cents(w.amount_cents) : null,
        w.status ? `Status: ${w.status}` : null].filter(Boolean).join(' · '),
      entity_type: 'lien_waiver', entity_id: w.id })],
  },
  {
    name: 'TrustPoint draws',
    sql: `SELECT t.id, t.submitted_at, t.approved_at, t.disbursed_at, t.number, t.name, t.status,
                 t.requested_cents, t.approved_cents, t.disbursed_cents, t.coordinator_name
            FROM trustpoint_draws t WHERE t.application_id=$1
           ORDER BY t.submitted_at DESC NULLS LAST LIMIT 60`,
    map: (t) => {
      const which = t.number != null ? `draw #${t.number}` : (t.name || 'a draw');
      const out = [];
      if (t.submitted_at) out.push(row({ at: t.submitted_at, kind: 'workflow', cat: 'draws', source: 'TrustPoint',
        actor: 'borrower', verb: `submitted ${which}`,
        label: t.requested_cents ? `Requested ${cents(t.requested_cents)}` : null }));
      if (t.approved_at) out.push(row({ at: t.approved_at, kind: 'workflow', cat: 'draws', source: 'TrustPoint',
        actor: 'staff', actor_name: t.coordinator_name || null, verb: `approved ${which}`,
        label: t.approved_cents ? `Approved ${cents(t.approved_cents)}` : null }));
      if (t.disbursed_at) out.push(row({ at: t.disbursed_at, kind: 'card', cat: 'draws', source: 'TrustPoint',
        actor: 'system', verb: `disbursed ${which}`,
        label: t.disbursed_cents ? cents(t.disbursed_cents) : null }));
      return out;
    },
  },
  // A whole conversation channel the feed never showed.
  {
    name: 'TrustPoint comments',
    sql: `SELECT c.tp_comment_id, c.commented_at, c.edited_at, c.author, c.body, c.is_pinned
            FROM trustpoint_draw_comments c WHERE c.application_id=$1
           ORDER BY c.commented_at DESC LIMIT 150`,
    map: (c) => [row({ at: c.commented_at, kind: 'message', cat: 'draws', source: 'TrustPoint',
      actor: 'external', actor_name: c.author || null,
      verb: `commented on a draw${c.is_pinned ? ' (pinned)' : ''}${c.edited_at ? ' (later edited)' : ''}`,
      label: String(c.body || '').slice(0, 400) || null,
      entity_type: 'draw_comment', entity_id: String(c.tp_comment_id) })],
  },

  // ── CLOSING ─────────────────────────────────────────────────────────────
  {
    name: 'closing milestones',
    sql: `SELECT w.application_id, w.stage, w.ready_for_docs_at, w.wire_sent_at,
                 w.fully_closed_at, w.fully_reconciled_at, ${STAFF_NAME_SQL('s')} AS by_name
            FROM closing_workflow w
            LEFT JOIN staff_users s ON s.id=w.updated_by
           WHERE w.application_id=$1 LIMIT 1`,
    map: (w) => [
      w.ready_for_docs_at && { at: w.ready_for_docs_at, verb: 'marked the file ready for closing documents' },
      w.wire_sent_at && { at: w.wire_sent_at, verb: 'SENT THE WIRE' },
      w.fully_closed_at && { at: w.fully_closed_at, verb: 'closed the loan' },
      w.fully_reconciled_at && { at: w.fully_reconciled_at, verb: 'fully reconciled the closing' },
    ].filter(Boolean).map((e) => row({ at: e.at, kind: 'status', cat: 'closing', source: 'closing',
      actor: 'staff', actor_name: w.by_name, verb: e.verb, entity_type: 'closing_workflow' })),
  },
  {
    name: 'closing checklist',
    sql: `SELECT i.id, i.checked_at, i.label, ${STAFF_NAME_SQL('s')} AS by_name
            FROM closing_checklist_items i
            JOIN closing_checklists c ON c.id = i.checklist_id
            LEFT JOIN staff_users s ON s.id = i.checked_by
           WHERE c.application_id=$1 AND i.checked_at IS NOT NULL
           ORDER BY i.checked_at DESC LIMIT 150`,
    map: (i) => [row({ at: i.checked_at, kind: 'condition', cat: 'closing', source: 'closing',
      actor: 'staff', actor_name: i.by_name, verb: 'ticked a closing checklist item',
      label: i.label, entity_type: 'closing_checklist_item', entity_id: i.id })],
  },
  {
    name: 'closing notes',
    sql: `SELECT n.id, n.created_at, n.body, ${STAFF_NAME_SQL('s')} AS by_name
            FROM closing_notes n
            LEFT JOIN staff_users s ON s.id=n.author_staff_id
           WHERE n.application_id=$1 ORDER BY n.created_at DESC LIMIT 100`,
    map: (n) => [row({ at: n.created_at, kind: 'message', cat: 'closing', source: 'closing',
      actor: 'staff', actor_name: n.by_name, verb: 'left a closing note',
      label: String(n.body || '').slice(0, 400) || null, entity_type: 'closing_note', entity_id: n.id })],
  },
  {
    name: 'post-closing',
    sql: `SELECT p.id, p.updated_at, p.label, p.status, p.exception_note,
                 ${STAFF_NAME_SQL('s')} AS by_name
            FROM post_closing_items p
            LEFT JOIN staff_users s ON s.id=p.assigned_staff_id
           WHERE p.application_id=$1 AND p.status <> 'pending'
           ORDER BY p.updated_at DESC LIMIT 100`,
    map: (p) => [row({ at: p.updated_at, kind: 'condition', cat: 'closing', source: 'post-closing',
      actor: 'staff', actor_name: p.by_name,
      verb: `moved a post-closing item to ${String(p.status || '').replace(/_/g, ' ')}`,
      label: [p.label, p.exception_note || null].filter(Boolean).join('\n'),
      entity_type: 'post_closing_item', entity_id: p.id })],
  },
  // A SECOND, parallel condition system the feed did not know about.
  {
    name: 'purchasing',
    sql: `SELECT c.id, c.created_at, c.resolved_at, c.label, c.status, c.resolution_note,
                 ${STAFF_NAME_SQL('cb')} AS created_by_name, ${STAFF_NAME_SQL('rb')} AS resolved_by_name
            FROM purchasing_conditions c
            LEFT JOIN staff_users cb ON cb.id=c.created_by
            LEFT JOIN staff_users rb ON rb.id=c.resolved_by
           WHERE c.application_id=$1 ORDER BY c.created_at DESC LIMIT 100`,
    map: (c) => {
      const out = [row({ at: c.created_at, kind: 'condition', cat: 'closing', source: 'purchasing',
        actor: 'staff', actor_name: c.created_by_name, verb: 'added a purchasing condition',
        label: c.label, entity_type: 'purchasing_condition', entity_id: c.id })];
      if (c.resolved_at) out.push(row({ at: c.resolved_at, kind: 'condition', cat: 'closing', source: 'purchasing',
        actor: 'staff', actor_name: c.resolved_by_name,
        verb: `${String(c.status || 'resolved')} a purchasing condition`,
        label: [c.label, c.resolution_note || null].filter(Boolean).join('\n'),
        entity_type: 'purchasing_condition', entity_id: c.id }));
      return out;
    },
  },

  // ── PILOT WRITING REAL LOAN VALUES ──────────────────────────────────────
  // The most audit-shaped rows in the schema: an automated before → after on
  // the two numbers the loan is sized on.
  {
    name: 'appraisal value writes',
    sql: `SELECT a.id, a.imported_at, a.superseded, a.form_type,
                 a.as_is_applied, a.as_is_applied_value, a.as_is_file_value_before,
                 a.as_is_read_source, a.as_is_confirmed_at, a.as_is_confirmed_value,
                 a.arv_applied, a.arv_applied_value, a.arv_file_value_before,
                 a.arv_confirmed_at, a.arv_confirmed_value,
                 ${STAFF_NAME_SQL('ac')} AS as_is_confirmed_by_name,
                 ${STAFF_NAME_SQL('vc')} AS arv_confirmed_by_name
            FROM appraisals a
            LEFT JOIN staff_users ac ON ac.id=a.as_is_confirmed_by
            LEFT JOIN staff_users vc ON vc.id=a.arv_confirmed_by
           WHERE a.application_id=$1 ORDER BY a.imported_at DESC LIMIT 30`,
    map: (a) => {
      const dollars = (v) => (v == null ? '—' : `$${Math.round(Number(v)).toLocaleString('en-US')}`);
      const out = [row({ at: a.imported_at, kind: 'document', cat: 'document', source: 'appraisal',
        actor: 'system', verb: `imported an appraisal${a.form_type ? ` (${a.form_type})` : ''}`,
        label: a.superseded ? 'Since superseded by a newer appraisal' : null,
        entity_type: 'appraisal', entity_id: a.id })];
      if (a.as_is_applied) out.push(row({ at: a.imported_at, kind: 'edit', cat: 'pricing', source: 'appraisal',
        actor: 'system', verb: 'PILOT wrote the As-Is value onto the loan from the appraisal',
        label: `As-is value: ${dollars(a.as_is_file_value_before)} → ${dollars(a.as_is_applied_value)}${a.as_is_read_source ? ` (read from the ${String(a.as_is_read_source).replace(/_/g, ' ')})` : ''}`,
        entity_type: 'appraisal', entity_id: a.id }));
      if (a.arv_applied) out.push(row({ at: a.imported_at, kind: 'edit', cat: 'pricing', source: 'appraisal',
        actor: 'system', verb: 'PILOT wrote the ARV onto the loan from the appraisal',
        label: `ARV: ${dollars(a.arv_file_value_before)} → ${dollars(a.arv_applied_value)}`,
        entity_type: 'appraisal', entity_id: a.id }));
      if (a.as_is_confirmed_at) out.push(row({ at: a.as_is_confirmed_at, kind: 'edit', cat: 'pricing', source: 'appraisal',
        actor: 'staff', actor_name: a.as_is_confirmed_by_name,
        verb: 'typed in the As-Is value by hand',
        label: `Set to ${dollars(a.as_is_confirmed_value)}`, entity_type: 'appraisal', entity_id: a.id }));
      if (a.arv_confirmed_at) out.push(row({ at: a.arv_confirmed_at, kind: 'edit', cat: 'pricing', source: 'appraisal',
        actor: 'staff', actor_name: a.arv_confirmed_by_name,
        verb: 'typed in the ARV by hand',
        label: `Set to ${dollars(a.arv_confirmed_value)}`, entity_type: 'appraisal', entity_id: a.id }));
      return out;
    },
  },
  {
    name: 'pricing approvals',
    sql: `SELECT e.id, e.created_at, e.decided_at, e.status, e.decision_note, e.summary,
                 ${STAFF_NAME_SQL('rq')} AS requested_by_name, ${STAFF_NAME_SQL('dc')} AS decided_by_name
            FROM manual_program_escalations e
            LEFT JOIN staff_users rq ON rq.id=e.requested_by
            LEFT JOIN staff_users dc ON dc.id=e.decided_by
           WHERE e.application_id=$1 ORDER BY e.created_at DESC LIMIT 40`,
    map: (e) => {
      const kind = e.summary && typeof e.summary === 'object' && e.summary.kind
        ? String(e.summary.kind).replace(/_/g, ' ') : 'a manual product';
      const out = [row({ at: e.created_at, kind: 'product', cat: 'pricing', source: 'approvals',
        actor: 'staff', actor_name: e.requested_by_name,
        verb: `sent ${kind} to an admin for approval`,
        entity_type: 'pricing_escalation', entity_id: e.id })];
      if (e.decided_at) out.push(row({ at: e.decided_at, kind: 'product', cat: 'pricing', source: 'approvals',
        actor: 'staff', actor_name: e.decided_by_name, verb: `${e.status} the pricing approval`,
        label: e.decision_note || null, entity_type: 'pricing_escalation', entity_id: e.id }));
      return out;
    },
  },

  // ── DECISIONS + AI ──────────────────────────────────────────────────────
  {
    name: 'decision certificates',
    sql: `SELECT c.id, c.issued_at, c.superseded_at, c.milestone, c.digest_sha256,
                 c.surveillance_state, c.surveillance_reason, ${STAFF_NAME_SQL('s')} AS by_name
            FROM decision_certificates c
            LEFT JOIN staff_users s ON s.id=c.issued_by
           WHERE c.application_id=$1 ORDER BY c.issued_at DESC LIMIT 40`,
    map: (c) => [row({ at: c.issued_at, kind: 'security', cat: 'file', source: 'certificates',
      actor: 'staff', actor_name: c.by_name,
      verb: `issued a decision certificate for ${String(c.milestone || '').replace(/_/g, ' ')}`,
      label: [c.digest_sha256 ? `Seal: ${String(c.digest_sha256).slice(0, 12)}…` : null,
        c.superseded_at ? 'Since superseded' : null,
        c.surveillance_state && c.surveillance_state !== 'ok'
          ? `Watch: ${c.surveillance_state}${c.surveillance_reason ? ` — ${c.surveillance_reason}` : ''}` : null,
      ].filter(Boolean).join(' · '), entity_type: 'decision_certificate', entity_id: c.id })],
  },
  {
    name: 'underwriting runs',
    sql: `SELECT r.id, r.created_at, r.trigger, r.status, r.program_key,
                 r.term_sheet_eligible, r.ctc_eligible, r.funding_eligible, r.superseded_at
            FROM underwriting_runs r WHERE r.application_id=$1
           ORDER BY r.created_at DESC LIMIT 40`,
    map: (r) => [row({ at: r.created_at, kind: 'setup', cat: 'condition', source: 'underwriting',
      actor: 'system', verb: `PILOT re-ran the whole-loan review (${String(r.trigger || '').replace(/_/g, ' ')})`,
      label: [r.status ? `Verdict: ${r.status}` : null,
        `Term sheet ${r.term_sheet_eligible ? 'ok' : 'not ok'} · CTC ${r.ctc_eligible ? 'ok' : 'not ok'} · funding ${r.funding_eligible ? 'ok' : 'not ok'}`,
      ].filter(Boolean).join(' · '), entity_type: 'underwriting_run', entity_id: r.id })],
  },
  {
    name: 'PILOT questions',
    sql: `SELECT q.id, q.asked_at, q.answered_at, q.agent, q.question, q.answer,
                 ${STAFF_NAME_SQL('s')} AS answered_by_name
            FROM ai_admin_questions q
            LEFT JOIN staff_users s ON s.id=q.answered_by_staff_id
           WHERE q.application_id=$1 ORDER BY q.asked_at DESC LIMIT 60`,
    map: (q) => {
      const out = [row({ at: q.asked_at, kind: 'condition', cat: 'condition', source: 'PILOT',
        actor: 'system', verb: 'PILOT asked an admin a question',
        label: [q.agent ? `From: ${String(q.agent).replace(/_/g, ' ')}` : null, q.question || null]
          .filter(Boolean).join('\n'), entity_type: 'ai_question', entity_id: q.id })];
      if (q.answered_at) out.push(row({ at: q.answered_at, kind: 'condition', cat: 'condition', source: 'PILOT',
        actor: 'staff', actor_name: q.answered_by_name, verb: 'answered PILOT\'s question',
        label: q.answer || null, entity_type: 'ai_question', entity_id: q.id }));
      return out;
    },
  },

  // ── THE REST OF THE COMMUNICATION TRAIL ─────────────────────────────────
  // "They say they never got it" — the open receipt answers it.
  {
    name: 'email opens',
    sql: `SELECT o.notification_id, o.first_opened_at, o.last_opened_at, o.open_count, o.last_ip,
                 n.title, n.recipient_kind
            FROM email_opens o
            JOIN notifications n ON n.id = o.notification_id
           WHERE n.application_id=$1 ORDER BY o.first_opened_at DESC LIMIT 150`,
    map: (o) => [row({ at: o.first_opened_at, kind: 'email', cat: 'email', source: 'email opens',
      actor: o.recipient_kind === 'borrower' ? 'borrower' : 'staff',
      verb: 'opened an email we sent',
      label: [o.title, o.open_count > 1 ? `Opened ${o.open_count} times, last ${new Date(o.last_opened_at).toLocaleString()}` : null]
        .filter(Boolean).join('\n'), ip: o.last_ip, entity_type: 'email_open', entity_id: o.notification_id })],
  },
  // Every prior version of an edited message. The feed showed deletions but
  // never edits, so a message could be rewritten without a trace.
  {
    name: 'message edits',
    sql: `SELECT r.id, r.created_at, r.body, r.edited_by_kind,
                 ${STAFF_NAME_SQL('s')} AS staff_name, ${BORROWER_NAME_SQL('b')} AS borrower_name
            FROM message_revisions r
            JOIN messages m ON m.id = r.message_id
            LEFT JOIN staff_users s ON r.edited_by_kind='staff' AND s.id=r.edited_by_id
            LEFT JOIN borrowers b ON r.edited_by_kind='borrower' AND b.id=r.edited_by_id
           WHERE m.application_id=$1 ORDER BY r.created_at DESC LIMIT 100`,
    map: (r) => [row({ at: r.created_at, kind: 'message', cat: 'message', source: 'message edits',
      actor: r.edited_by_kind, actor_name: r.staff_name || r.borrower_name || null,
      verb: 'edited a message — this is what it said before',
      label: String(r.body || '').slice(0, 400) || null,
      entity_type: 'message_revision', entity_id: r.id })],
  },
  {
    name: 'Encompass resolutions',
    sql: `SELECT e.field_key, e.resolution, e.resolved_at, e.note,
                 ${STAFF_NAME_SQL('s')} AS by_name
            FROM encompass_sync_resolutions e
            LEFT JOIN staff_users s ON s.id=e.resolved_by
           WHERE e.application_id=$1 ORDER BY e.resolved_at DESC LIMIT 100`,
    map: (e) => [row({ at: e.resolved_at, kind: 'sync', cat: 'sync', source: 'Encompass',
      actor: 'staff', actor_name: e.by_name,
      verb: `settled a disagreement with the LOS — ${e.resolution === 'replaced' ? 'took theirs' : 'kept ours'}`,
      label: [String(e.field_key || '').replace(/_/g, ' '), e.note || null].filter(Boolean).join('\n'),
      entity_type: 'encompass_resolution', entity_id: null })],
  },

  // Tasks and reminders raised on the file, and whether they actually fired.
  {
    name: 'reminders',
    sql: `SELECT r.id, r.created_at, r.due_at, r.fired_at, r.completed_at, r.kind, r.title, r.status,
                 ${STAFF_NAME_SQL('c')} AS created_by_name, ${STAFF_NAME_SQL('a')} AS assignee_name,
                 ${STAFF_NAME_SQL('d')} AS completed_by_name
            FROM reminders r
            LEFT JOIN staff_users c ON c.id=r.created_by
            LEFT JOIN staff_users a ON a.id=r.assignee_staff_id
            LEFT JOIN staff_users d ON d.id=r.completed_by
           WHERE r.application_id=$1 ORDER BY r.created_at DESC LIMIT 80`,
    map: (r) => {
      const out = [row({ at: r.created_at, kind: 'edit', cat: 'file', source: 'reminders',
        actor: 'staff', actor_name: r.created_by_name, verb: `created a ${String(r.kind || 'reminder').replace(/_/g, ' ')}`,
        label: [r.title, r.assignee_name ? `For: ${r.assignee_name}` : null].filter(Boolean).join('\n'),
        entity_type: 'reminder', entity_id: r.id })];
      if (r.completed_at) out.push(row({ at: r.completed_at, kind: 'edit', cat: 'file', source: 'reminders',
        actor: 'staff', actor_name: r.completed_by_name, verb: 'completed a reminder', label: r.title,
        entity_type: 'reminder', entity_id: r.id }));
      return out;
    },
  },
];

async function trailEvents(appId, trail) {
  // TRUNCATION IS MEASURED, NOT INFERRED — the root cause of the owner's
  // 2026-08-16 report ("This log is incomplete · closing milestones: read 1
  // records, which is all this page reads").
  //
  // The old rule was `rows >= LIMIT` ⇒ "this trail was cut short". That reads a
  // trail's LIMIT as a BOUND when it can equally be a STATEMENT OF SHAPE:
  // `application_id` is the PRIMARY KEY of `closing_workflow`, so that trail can
  // structurally never have a second row and is written `LIMIT 1` to say so —
  // every file that has ever reached closing read 1 of 1, and the whole audit
  // log declared itself incomplete, in red, permanently, on the files that
  // matter most. Every other trail carries the same latent false alarm the day a
  // file holds exactly `LIMIT` rows.
  //
  // So ask the database instead of guessing: run the trail's own SQL with its
  // LIMIT raised by one. If the extra row comes back the trail really was cut
  // short; the extra is dropped before mapping, so the events are byte-for-byte
  // what they always were and only the VERDICT changes.
  const cap = capOf(trail.sql);
  const r = await db.query(cap ? overRead(trail.sql, cap) : trail.sql, [appId]);
  const rows = cap ? r.rows.slice(0, cap) : r.rows;
  const out = [];
  for (const rec of rows) {
    for (const e of (trail.map(rec) || [])) if (e && e.at) out.push(e);
  }
  // The number of EVENTS is not the number of ROWS — one envelope emits a sent,
  // a signed and a voided event — so the truncation check cannot count events.
  return withTruncation(out, cap ? r.rows.length > cap : false, cap);
}

/**
 * Tag a source's events with whether its own query was CUT SHORT. Non-enumerable:
 * this must never reach the wire or change how the array behaves anywhere else.
 */
function withTruncation(events, truncated, cap) {
  if (!cap) return events;
  Object.defineProperty(events, '__truncated', { value: !!truncated, enumerable: false });
  Object.defineProperty(events, '__cap', { value: cap, enumerable: false });
  return events;
}

/** The LIMIT a trail's own SQL declares, so the cap is never restated by hand. */
function capOf(sql) {
  const m = /LIMIT\s+(\d+)\s*$/i.exec(String(sql || '').trim());
  return m ? Number(m[1]) : null;
}

/** The same SQL asking for one more row than it wants — the truncation probe. */
function overRead(sql, cap) {
  return String(sql).replace(/LIMIT\s+\d+\s*$/i, `LIMIT ${cap + 1}`);
}

// ── 12. The request log — every HTTP call that touched this file ───────────
// OFF by default: it is enormous and mostly page loads. It is the layer you
// turn on when the business trail above does not explain what happened.
async function requestEvents(appId, limit) {
  const r = await db.query(
    `SELECT ra.id, ra.at, ra.actor_kind, ra.actor_email, ra.actor_role, ra.method, ra.path,
            ra.route, ra.status, ra.duration_ms, ra.ip, ra.user_agent, ra.error,
            ra.body_summary, ra.request_id, ra.impersonator_role,
            ${STAFF_NAME_SQL('imp')} AS impersonator_name
       FROM request_audit_log ra
       LEFT JOIN staff_users imp ON imp.id = ra.impersonator_staff_id
      WHERE ra.entity_id=$1 ORDER BY ra.at DESC LIMIT $2`, [appId, limit]);
  return r.rows.map((q) => row({
    at: q.at, kind: 'request', cat: 'request', source: 'requests',
    actor: q.actor_kind, actor_name: q.actor_email || null, actor_role: q.actor_role || null,
    impersonator: q.impersonator_name || null,
    verb: `${q.method} ${q.path}`,
    label: [`Answered ${q.status}${q.duration_ms != null ? ` in ${q.duration_ms}ms` : ''}`,
      q.impersonator_name ? `⚠️ ran inside ${q.impersonator_name}'s borrower-view session` : null,
      q.error ? `Error: ${q.error}` : null].filter(Boolean).join(' · '),
    detail: q.body_summary || null, ip: q.ip, user_agent: q.user_agent,
  }));
}

/**
 * The full staff audit log for a file.
 *
 * @param {string} appId
 * @param {{limit?:number, includeRequests?:boolean}} opts
 */
async function staffFeed(appId, opts) {
  const o = opts || {};
  const limit = Math.min(Math.max(Number(o.limit) || 600, 50), 2000);
  const problems = [];
  // ONE list of every source, run through a bounded fan-out (see mapLimit):
  // this reads ~45 tables and the connection pool holds 10, so they may not all
  // be in flight at once.
  const jobs = [
    ['documents', () => docEvents(appId)],
    ['messages', () => messageEvents(appId)],
    ['conditions', () => conditionEvents(appId)],
    ['status', () => statusEvents(appId)],
    ['audit log', () => auditEvents(appId, Math.min(limit, 800))],
    ['notifications', () => notificationEvents(appId)],
    ['email', () => emailEvents(appId)],
    ['integrations', () => syncEvents(appId)],
    ['change requests', () => changeRequestEvents(appId)],
    ['workflow', () => workflowEvents(appId)],
    ...TRAILS.map((t) => [t.name, () => trailEvents(appId, t)]),
    ...(o.includeRequests ? [['requests', () => requestEvents(appId, Math.min(limit, 500))]] : []),
  ];
  const lists = await mapLimit(jobs, DB_FANOUT, ([name, fn]) => source(name, fn, problems));
  const merged = [].concat(...lists)
    .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  const all = merged.slice(0, limit);

  // COMPLETENESS. Two DIFFERENT ways this log can be short of the truth, and
  // both are reported at the TOP — an audit log with a silent hole in it is
  // worse than one that says where the hole is. This is what lets a reader
  // trust the rest of the page.
  //
  // The meta rows are added AFTER the slice on purpose: the warning must
  // never be the row that truncation throws away.

  // (1) A TRAIL THREW. Its whole table is missing from the log.
  if (problems.length) {
    all.unshift(row({
      at: null, kind: 'security', cat: 'other', source: 'meta', actor: 'system',
      verb: `could not read ${problems.length} of the file's trails — this log is INCOMPLETE`,
      label: problems.join('\n'),
      detail: { unreadableSources: problems },
    }));
  }

  // (2) THE WINDOW IS TRUNCATED — the failure the first version could not see.
  // `problems` only ever caught a source that THREW. A busy file simply has
  // more events than `limit`, so the oldest were dropped by the slice above
  // and the page asserted nothing was missing: the category counts, the
  // search and the actor list all describe the WINDOW while reading as if
  // they described the FILE. That is the one thing an audit log may not do,
  // and it goes wrong precisely on the files worth auditing.
  if (merged.length > all.length) {
    const oldest = all.length ? all[all.length - 1].at : null;
    all.unshift(row({
      at: null, kind: 'security', cat: 'other', source: 'meta', actor: 'system',
      verb: `showing the most recent ${all.length} of ${merged.length} events — this log is TRUNCATED`,
      label: [
        oldest ? `Nothing before ${new Date(oldest).toLocaleString()} is on this page.` : null,
        'Everything below — the counts, the search and the people list — describes only what is shown, not the whole file.',
        'Raise the limit or narrow the dates to see earlier activity.',
      ].filter(Boolean).join('\n'),
      detail: { shown: all.length, matched: merged.length, limit, oldestShown: oldest },
    }));
  }

  // (3) A SINGLE TRAIL WAS CUT SHORT. Each source caps independently, so a file
  // with 900 audit rows loses 100 of them even when the merged total is under
  // `limit` and (2) stays silent. Reported by NAME so the reader knows which
  // part of the record is partial, rather than being told the whole log is
  // short and left to guess where.
  // A source only reports here if it PROVED it (see trailEvents: the query asks
  // for one row more than it wants, so a trail whose LIMIT merely states its
  // shape — `closing_workflow` is one row per file — can no longer cry wolf).
  const capped = jobs
    .map((j, i) => ({ name: j[0], cap: lists[i] && lists[i].__cap, truncated: !!(lists[i] && lists[i].__truncated) }))
    .filter((s) => s.truncated);
  if (capped.length) {
    all.unshift(row({
      at: null, kind: 'security', cat: 'other', source: 'meta', actor: 'system',
      verb: `${capped.length} of the file's trails hit their own limit — those parts are PARTIAL`,
      label: capped.map((s) => `${s.name}: only the most recent ${s.cap} are on this page — there are older ones`).join('\n'),
      detail: { cappedSources: capped },
    }));
  }
  return all;
}

/**
 * @param {string} appId
 * @param {boolean} onlySafe  true = the borrower's own feed (narrow, unchanged)
 * @param {{limit?:number, includeRequests?:boolean}} [opts] staff feed options
 */
async function fileActivity(appId, onlySafe, opts) {
  if (onlySafe) return legacyFeed(appId, true);
  return staffFeed(appId, opts);
}

module.exports = {
  fileActivity,
  staffFeed,
  // TRAILS is exported for the DB test ONLY: every query here is guarded in
  // production, so a query naming a column that does not exist would report
  // "nothing happened" forever rather than an error. The test runs each one
  // against a real schema and names the trail that broke.
  _internals: { summarizeDetail, describeChanges, row, TRAILS, trailEvents },
};
