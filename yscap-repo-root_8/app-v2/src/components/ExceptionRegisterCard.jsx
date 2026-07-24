import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { STATUS_TONE, STATUS_LABEL, fmtWhen, fmtDay, agingOf } from './ExceptionCard.jsx';

/* The FILE's exception register (redesign 2026-07-24,
   docs/EXCEPTION-WORKFLOW-REDESIGN.md) — every policy deviation this loan
   carries or ever asked for, on the file itself: guaranty waivers, early
   term-sheet sends, pricing/guideline exceptions, and recorded super-admin
   overrides. This is the "what exceptions does this loan carry" answer a
   diligence/note-buyer conversation starts with, so it shows the whole
   history (any status), newest first, with EX-n references. Compact rows —
   the full detail lives in the Exceptions box (deep-linked). Staff-only. */

export default function ExceptionRegisterCard({ appId, canSeeBox }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let dead = false;
    api.fileExceptions(appId)
      .then((d) => { if (!dead) setData(d); })
      .catch((e) => { if (!dead) setErr((e && e.message) || 'could not load the exception register'); });
    return () => { dead = true; };
  }, [appId]);

  if (err) return <div className="notice err">{err}</div>;
  if (!data) return <div className="muted small">Loading the exception register…</div>;

  const rows = data.register || [];
  const typeLabels = data.typeLabels || {};
  const open = rows.filter((r) => r.status === 'requested');
  const granted = rows.filter((r) => r.status === 'approved');

  return (
    <div>
      <p className="muted small" style={{ marginTop: 0 }}>
        Every exception to loan policy on this file — asked for, granted, denied, or recorded. This is the
        history a note buyer or reviewer will ask about; each entry carries its EX-number for reference.
        {open.length > 0 && <> <b>{open.length} awaiting a super-admin decision.</b></>}
      </p>

      {rows.length === 0 && (
        <div className="notice">No exceptions on this file — it follows every policy as written. Requests are made
          from the section they belong to (the guaranty and pricing asks under Loan structure &amp; pricing, the early
          send under E-sign).</div>
      )}

      {rows.map((r) => {
        const aging = agingOf(r);
        const drift = Array.isArray(r.deal_drift) ? r.deal_drift : [];
        return (
          <div key={r.id} className="row" style={{
            gap: 8, alignItems: 'baseline', flexWrap: 'wrap', padding: '8px 0',
            borderTop: '1px solid var(--hair,#e7e2d6)',
          }}>
            <span className="ts-badge">{r.exception_seq != null ? `EX-${r.exception_seq}` : '—'}</span>
            <b>{typeLabels[r.exception_type] || r.exception_type}</b>
            <span className={`ts-badge ${STATUS_TONE[r.status] || ''}`}>{STATUS_LABEL[r.status] || r.status}</span>
            {aging && <span className={`ts-badge ${aging.overdue ? 'err' : ''}`}>{aging.overdue ? `overdue · ${aging.label}` : aging.label}</span>}
            {r.status === 'approved' && r.expires_at && <span className="ts-badge" title="Approval validity — past this date it expires on its own.">until {fmtDay(r.expires_at)}</span>}
            <span className="muted small">
              {r.reason_label || r.reason_code || ''}
              {r.requested_by_kind === 'borrower' ? ' · asked by the borrower' : r.requested_by_name ? ` · by ${r.requested_by_name}` : ''}
              {' · '}{fmtWhen(r.requested_at || r.created_at)}
            </span>
            {drift.length > 0 && r.status !== 'cleared' && (
              <span className="ts-badge warn" title="The deal's numbers moved since this was requested — re-check before relying on it.">deal changed</span>
            )}
          </div>
        );
      })}

      {granted.length > 0 && (
        <div className="muted small" style={{ marginTop: 8 }}>
          {granted.length === 1 ? 'One granted exception rides with this loan' : `${granted.length} granted exceptions ride with this loan`} — they appear on the decision
          certificate and the register export automatically.
        </div>
      )}

      {canSeeBox && (
        <div className="row" style={{ gap: 8, marginTop: 10 }}>
          <Link className="btn ghost small" to={`/internal/exceptions?app=${appId}`}>Open in the Exceptions box</Link>
        </div>
      )}
    </div>
  );
}
