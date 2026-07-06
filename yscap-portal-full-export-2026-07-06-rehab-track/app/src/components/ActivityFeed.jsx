import React, { useEffect, useState } from 'react';

const ICON = { message: '💬', document: '📄', condition: '❗', status: '📈' };
function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return new Date(ts).toLocaleDateString();
}
const who = (a) => a === 'borrower' ? 'Borrower' : a === 'staff' ? 'YS' : 'System';

/* Renders a file's recent activity. `fetcher` is an async () => rows so the same
   component serves the borrower-safe and full-staff feeds. */
export default function ActivityFeed({ fetcher, title = 'Recent activity', limit = 12 }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { let a = true; fetcher().then(r => a && setRows(r || [])).catch(() => a && setRows([])); return () => { a = false; }; }, [fetcher]);
  if (!rows) return null;
  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <h3 style={{ marginBottom: 10 }}>{title}</h3>
      {rows.length === 0
        ? <p className="muted small">Nothing yet.</p>
        : rows.slice(0, limit).map((e, i) => (
          <div key={i} className="row" style={{ gap: 10, padding: '7px 0', borderBottom: i < Math.min(rows.length, limit) - 1 ? '1px solid var(--line)' : 'none', alignItems: 'baseline' }}>
            <span aria-hidden>{ICON[e.kind] || '•'}</span>
            <span style={{ flex: 1 }}><strong>{who(e.actor)}</strong> {e.verb}{e.label ? <span className="muted"> — {e.label}</span> : ''}</span>
            <span className="muted small" style={{ whiteSpace: 'nowrap' }}>{ago(e.at)}</span>
          </div>
        ))}
    </div>
  );
}
