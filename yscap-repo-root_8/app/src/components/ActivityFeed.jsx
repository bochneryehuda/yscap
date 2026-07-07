import React, { useEffect, useState } from 'react';

const ICON = {
  message: '💬', document: '📄', condition: '❗', status: '📈',
  product: '🏷️', edit: '✏️', llc: '🏢', card: '💳',
};
function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return new Date(ts).toLocaleDateString();
}
const who = (e) => e.actor_name
  || (e.actor === 'borrower' ? 'Borrower' : e.actor === 'staff' ? 'YS' : 'System');

/* Renders a file's activity — a real audit log. Rows carry {at, kind, actor,
   actor_name, verb, label}; `label` may be multi-line (field-level diffs from
   an application edit / reprice). `fetcher` is an async () => rows so the same
   component serves the borrower-safe and full-staff feeds.

   `compact` renders a terse, one-line-per-event audit log (small type, fixed
   time column, no emoji, diffs inlined) — used on the borrower file, where the
   feed should read like an audit trail, not a checklist. */
export default function ActivityFeed({ fetcher, title = 'Activity', limit = 15, compact = false }) {
  const [rows, setRows] = useState(null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { let a = true; fetcher().then(r => a && setRows(r || [])).catch(() => a && setRows([])); return () => { a = false; }; }, [fetcher]);
  if (!rows) return null;
  const shown = showAll ? rows : rows.slice(0, limit);
  return (
    <div className="panel" style={{ marginTop: 18, ...(compact ? { padding: 16 } : null) }}>
      <div className="row" style={{ marginBottom: compact ? 6 : 10 }}>
        <h3>{title}</h3>
        <div className="spacer" />
        <span className="muted small">{rows.length} event{rows.length === 1 ? '' : 's'}</span>
      </div>
      {rows.length === 0
        ? <p className="muted small">Nothing yet.</p>
        : compact
          ? (
            <ul className="auditlog">
              {shown.map((e, i) => (
                <li key={i} className="auditlog-row">
                  <span className="al-time" title={e.at ? new Date(e.at).toLocaleString() : ''}>{ago(e.at)}</span>
                  <span className="al-text">
                    <strong>{who(e)}</strong> {e.verb}
                    {e.label ? <span className="muted"> — {String(e.label).replace(/\n/g, '; ')}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          )
          : shown.map((e, i) => (
            <div key={i} className="row" style={{ gap: 10, padding: '8px 0', borderBottom: i < shown.length - 1 ? '1px solid var(--line)' : 'none', alignItems: 'baseline', flexWrap: 'nowrap' }}>
              <span aria-hidden style={{ flex: 'none' }}>{ICON[e.kind] || '•'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span><strong>{who(e)}</strong> {e.verb}</span>
                {e.label && (
                  <div className="muted small" style={{ whiteSpace: 'pre-line', marginTop: 2, overflowWrap: 'anywhere' }}>{e.label}</div>
                )}
              </div>
              <span className="muted small" style={{ whiteSpace: 'nowrap', flex: 'none' }} title={e.at ? new Date(e.at).toLocaleString() : ''}>{ago(e.at)}</span>
            </div>
          ))}
      {rows.length > limit && (
        <button className="btn link small" style={{ marginTop: 8 }} onClick={() => setShowAll(s => !s)}>
          {showAll ? 'Show recent only' : `Show all ${rows.length} events`}
        </button>
      )}
    </div>
  );
}
