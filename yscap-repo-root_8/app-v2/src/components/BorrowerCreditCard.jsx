import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/* Borrower read-only credit view: once staff have pulled/reissued the report,
   the borrower sees THEIR verified FICO, every bureau score, and the report PDF.
   Renders nothing until a report exists, so it's safe to drop on the dashboard. */
export default function BorrowerCreditCard() {
  const [data, setData] = useState(null);

  useEffect(() => { api.borrowerCredit().then(setData).catch(() => setData({ reports: [] })); }, []);

  if (!data || !data.reports || data.reports.length === 0) return null;

  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>Your credit</h3>
        {data.verifiedFico && (
          <span className="notice ok" style={{ padding: '2px 10px' }}>Verified FICO: <strong>{data.verifiedFico}</strong></span>
        )}
      </div>
      {data.reports.map((r) => (
        <div key={r.id} className="panel" style={{ background: 'var(--ink-2)', marginTop: 8 }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="muted small">{r.pulledOn ? `Pulled ${r.pulledOn}` : 'Credit report'}</span>
            {r.hasPdf && (
              <a className="btn ghost small" href={api.borrowerCreditPdfUrl(r.id)} target="_blank" rel="noopener noreferrer">
                View report (PDF)
              </a>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            {(r.scores || []).length === 0 && <span className="muted small">Scores are being finalized.</span>}
            {(r.scores || []).map((s, i) => (
              <span key={i} className="kpi" style={{ minWidth: 96 }}>
                <span className="k">{s.bureau}</span>
                <span className="v">{s.score}</span>
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
