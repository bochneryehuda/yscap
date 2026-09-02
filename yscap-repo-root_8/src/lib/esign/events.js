'use strict';
/**
 * THE FULL LOG OF A SIGNING PACKAGE — one builder, every card.
 *
 * Owner-directed 2026-09-01: "add … a nicely designed log of the changes that were
 * done. You can see a log of that DocuSign file: sent this at this time, changed
 * the email and resent at this time, viewed at this time, signed at this time …
 * You can see if it was resent already, when it was resent, if it was viewed …
 * a full log at the bottom of every DocuSign package across the board — not only
 * the term sheet package and Iska, but also the wire package and everywhere else."
 *
 * Everything the log shows was already being RECORDED, in four places that no
 * screen read together: the envelope row's own lifecycle stamps, each signer's
 * stamps (sent / viewed = delivered / signed / declined + PILOT's own invitation
 * record), and the audit_log rows the staff actions write (resend, email change,
 * void, clear, send, override). This module merges them into ONE time-ordered
 * list per envelope. It is attached to the envelope objects tracking.js already
 * hands to every surface — the cockpit, the per-file section and (via the
 * sitewire read model) the draw wire form — so "the log" cannot mean different
 * things on different cards.
 *
 * ATTRIBUTING AN AUDIT ROW TO AN ENVELOPE. The staff routes now stamp
 * `detail.envelopeRowId` on every e-sign audit row. Rows written before that
 * carry only the file and the purpose; such a row is attributed to an envelope
 * only when it is the ONLY envelope of that purpose on the file — a guess
 * between two re-issued packages would put a "resent" line on the wrong card,
 * which is worse than leaving it off.
 *
 * Read-only. Never throws: a log that cannot be read comes back empty, and the
 * card still renders everything else.
 */

/** Action → what the row means, in plain words. Unlisted esign_* actions are shown with their raw action. */
const AUDIT_LABEL = Object.freeze({
  esign_send: 'Sent for signature',
  esign_test_send: 'Test send',
  esign_resend: 'Reminder re-sent',
  esign_recipient_email_changed: 'Signer email changed and invitation re-sent',
  esign_void: 'Voided',
  esign_clear: 'Package cleared',
  esign_countersign_view: 'Counter-signature opened',
  esign_term_sheet_final_override: 'Sent with the term-sheet check overridden',
});

const ROLE_LABEL = Object.freeze({
  borrower: 'Borrower', co_borrower: 'Co-borrower', admin: 'Counter-signer', loan_officer: 'Loan officer',
});

function ev(at, kind, label, extra = {}) {
  if (!at) return null;
  const t = new Date(at);
  if (!Number.isFinite(t.getTime())) return null;
  return { at: t.toISOString(), kind, label, ...extra };
}

/**
 * @param {object} db
 * @param {string[]} envelopeRowIds
 * @returns {Promise<Object<string, Array>>} envelope row id → events, oldest first
 */
async function envelopeEvents(db, envelopeRowIds) {
  const ids = (envelopeRowIds || []).map(String).filter(Boolean);
  const out = {};
  for (const id of ids) out[id] = [];
  if (!ids.length) return out;
  try {
    const envs = (await db.query(
      `SELECT e.id, e.application_id, e.purpose, e.created_at, e.sent_at, e.delivered_at, e.completed_at,
              e.declined_at, e.voided_at, e.void_reason, e.cleared_at, e.clear_reason, e.dead_lettered_at, e.last_error,
              e.countersign_notified_at, e.ts_final_override_at, e.ts_final_override_reason,
              cb.full_name AS cleared_by_name, cr.full_name AS created_by_name, ov.full_name AS override_by_name,
              (SELECT count(*) FROM esign_envelopes s WHERE s.application_id = e.application_id AND s.purpose = e.purpose) AS siblings
         FROM esign_envelopes e
         LEFT JOIN staff_users cb ON cb.id = e.cleared_by
         LEFT JOIN staff_users cr ON cr.id = e.created_by
         LEFT JOIN staff_users ov ON ov.id = e.ts_final_override_by
        WHERE e.id = ANY($1::uuid[])`, [ids])).rows;
    const recips = (await db.query(
      `SELECT r.envelope_row_id, r.role, r.name, r.email, r.sent_at, r.delivered_at, r.signed_at, r.declined_at,
              r.decline_reason, r.invited_at, r.invite_count
         FROM esign_recipients r WHERE r.envelope_row_id = ANY($1::uuid[])
        ORDER BY r.routing_order, r.role`, [ids])).rows;

    const appIds = [...new Set(envs.map((e) => e.application_id).filter(Boolean))];
    let audits = [];
    if (appIds.length) {
      audits = (await db.query(
        `SELECT l.action, l.entity_id, l.detail, l.created_at, l.actor_kind, su.full_name AS actor_name
           FROM audit_log l
           LEFT JOIN staff_users su ON su.id = l.actor_id AND l.actor_kind = 'staff'
          WHERE l.action LIKE 'esign\\_%'
            AND ((l.entity_type = 'application' AND l.entity_id = ANY($1::uuid[]))
                 OR (l.entity_type = 'esign_envelope' AND l.entity_id = ANY($2::uuid[])))
          ORDER BY l.created_at ASC`, [appIds, ids])).rows;
    }

    for (const e of envs) {
      const id = String(e.id);
      const list = [];
      const who = (n) => (n ? { who: n } : {});
      list.push(ev(e.created_at, 'created', 'Package prepared', who(e.created_by_name)));
      list.push(ev(e.sent_at, 'sent', 'Sent to DocuSign'));
      list.push(ev(e.delivered_at, 'delivered', 'Delivered by DocuSign'));
      list.push(ev(e.countersign_notified_at, 'countersign_notified', 'Counter-signer notified'));
      list.push(ev(e.completed_at, 'completed', 'All parties signed — package completed'));
      list.push(ev(e.declined_at, 'declined', 'Declined'));
      list.push(ev(e.voided_at, 'voided', e.void_reason ? `Voided — ${e.void_reason}` : 'Voided'));
      list.push(ev(e.cleared_at, 'cleared', e.clear_reason ? `Package cleared — ${e.clear_reason}` : 'Package cleared', who(e.cleared_by_name)));
      list.push(ev(e.dead_lettered_at, 'failed', e.last_error ? `Send failed — ${e.last_error}` : 'Send failed'));
      list.push(ev(e.ts_final_override_at, 'override', 'Sent with the term-sheet check overridden'
        + (e.ts_final_override_reason ? ` — ${e.ts_final_override_reason}` : ''), who(e.override_by_name)));

      for (const r of recips.filter((x) => String(x.envelope_row_id) === id)) {
        const signer = `${r.name || r.email || ''}${r.role ? ` (${ROLE_LABEL[r.role] || r.role})` : ''}`;
        const s = { signer, role: r.role, email: r.email };
        list.push(ev(r.invited_at, 'invited', `Invitation emailed to ${signer}`, s));
        list.push(ev(r.sent_at, 'signer_sent', `DocuSign marked ${signer} as sent`, s));
        list.push(ev(r.delivered_at, 'viewed', `${signer} opened the package`, s));
        list.push(ev(r.signed_at, 'signed', `${signer} signed`, s));
        list.push(ev(r.declined_at, 'signer_declined', `${signer} declined${r.decline_reason ? ` — ${r.decline_reason}` : ''}`, s));
      }

      for (const a of audits) {
        const d = a.detail && typeof a.detail === 'object' ? a.detail : {};
        const stamped = d.envelopeRowId ? String(d.envelopeRowId) : (a.entity_id && String(a.entity_id) === id ? id : null);
        let mine = false;
        if (stamped) mine = stamped === id;
        else if (a.entity_id && String(a.entity_id) === String(e.application_id)) {
          // Legacy row (no envelope id): attributable only when unambiguous.
          mine = d.purpose === e.purpose && Number(e.siblings) === 1;
        }
        if (!mine) continue;
        const base = AUDIT_LABEL[a.action] || a.action.replace(/^esign_/, '').replace(/_/g, ' ');
        let label = base;
        if (a.action === 'esign_recipient_email_changed' && (d.from || d.to)) {
          label = `Signer email changed${d.from ? ` from ${d.from}` : ''}${d.to ? ` to ${d.to}` : ''} and invitation re-sent`;
        } else if (a.action === 'esign_resend' && Array.isArray(d.recipients) && d.recipients.length) {
          label = `Reminder re-sent to ${d.recipients.join(', ')}`;
        } else if (a.action === 'esign_resend' && d.sent === 0) {
          label = 'Resend attempted — no invitation went out';
        } else if (a.action === 'esign_void' && d.reason) {
          label = `Voided by staff — ${d.reason}`;
        }
        list.push(ev(a.created_at, `audit:${a.action}`, label, { who: a.actor_name || (a.actor_kind === 'system' ? 'PILOT' : null) }));
      }

      out[id] = list.filter(Boolean).sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
    }
  } catch (e) {
    console.warn('[esign-events] could not build the envelope log (non-fatal):', e && e.message);
  }
  return out;
}

/** Attach `events` to each envelope object IN PLACE (the tracking.js shape). */
async function attachEvents(db, envelopes) {
  for (const e of envelopes) e.events = [];
  if (!envelopes.length) return;
  const byId = await envelopeEvents(db, envelopes.map((e) => e.id));
  for (const e of envelopes) e.events = byId[String(e.id)] || [];
}

module.exports = { envelopeEvents, attachEvents, AUDIT_LABEL };
