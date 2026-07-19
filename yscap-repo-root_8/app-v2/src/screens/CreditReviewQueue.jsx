import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';

/* Credit review queue — the underwriter's triage list of credit reports that need
   a human: a frozen bureau / no-score / vendor-error review, a timed-out order to
   reconcile, and a file BLOCKED by a fatal underwriting finding (FICO mismatch or
   a fraud / OFAC / deceased / SSN / address alert). Read-only list; each row deep-
   links to the file's credit section to act. Company-wide for staff who pull
   credit; a scoped officer sees only their own files. */

const KIND = {
  finding: { text: 'Fatal finding', cls: 'err' },
  review: { text: 'Needs review', cls: 'err' },
  in_doubt: { text: 'Order in doubt', cls: '' },
};

const day = (v) => {
  if (!v) return '';
  try { return new Date(v).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); } catch (_) { return ''; }
};

export default function CreditReviewQueue() {
  const [queue, setQueue] = useState(null);
  const [err, setErr] = useState('');

  const load = () => api.creditReviewQueue().then((r) => setQueue(r.queue || [])).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  return (
    <div className="screen" style={{ maxWidth: 960, margin: '0 auto' }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1>Credit review</h1>
        <button className="btn ghost small" onClick={load}>Refresh</button>
      </div>
      <p className="muted small">
        Credit reports that need an underwriter — a frozen bureau or no-score file, an order
        that timed out, or a file blocked by a fatal finding (a FICO mismatch or a fraud /
        OFAC / deceased / SSN / address alert). Open the file to review and clear it.
      </p>
      {err && <div className="notice err" role="alert">{err}</div>}
      {queue === null && !err && <p className="muted">Loading…</p>}
      {queue && queue.length === 0 && <div className="notice ok" style={{ marginTop: 8 }}>Nothing needs review — every credit file is clear.</div>}
      {queue && queue.length > 0 && (
        <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
          {queue.map((r) => {
            const k = KIND[r.kind] || { text: r.kind, cls: '' };
            const name = `${r.first_name || ''} ${r.last_name || ''}`.trim() || 'Borrower';
            return (
              <Link key={`${r.kind}-${r.id}`} to={`/internal/app/${r.application_id}`} className="panel" style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <strong>{name}</strong>
                    {r.representative_score != null && <span className="muted small" style={{ marginLeft: 6 }}>FICO {r.representative_score}</span>}
                    <span className="muted small" style={{ marginLeft: 6 }}>· {day(r.created_at)}</span>
                    {r.reason && <div className="small" style={{ marginTop: 2, color: r.kind === 'in_doubt' ? undefined : 'var(--danger)' }}>{r.reason}</div>}
                  </div>
                  <span className={`notice ${k.cls}`} style={{ padding: '2px 8px', fontSize: 12, whiteSpace: 'nowrap' }}>{k.text}</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
