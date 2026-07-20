import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import DrawsPanel from '../components/DrawsPanel.jsx';

/* Full-window construction-draw desk for one file (owner-directed 2026-07-20). The same DrawsPanel that
   lives in the file's "Construction draws" section, opened in its own window so the whole draw process —
   rollup, draws, money ledger, findings, reallocations — has room to live. Gated by manage_draws; only
   funded files have a draw process. */

const addr = (a) => {
  const p = a && a.property_address;
  if (!p) return '';
  if (typeof p === 'string') return p;
  return p.oneLine || [p.line1 || p.street, [p.city, p.state].filter(Boolean).join(', '), p.zip].filter(Boolean).join(', ');
};

export default function StaffFileDraws() {
  const { id } = useParams();
  const { can } = useAuth();
  const [app, setApp] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let live = true;
    api.staffApplication(id).then((a) => { if (live) setApp(a); }).catch((e) => { if (live) setErr(e?.data?.error || e.message || ''); });
    return () => { live = false; };
  }, [id]);

  if (!can('manage_draws')) return <div className="panel" style={{ margin: 24 }}>You don’t have access to construction draws.</div>;

  const title = app ? (addr(app) || app.ys_loan_number || 'Construction draws') : 'Construction draws';
  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', padding: '20px 20px 60px' }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <div>
          <h1 style={{ margin: 0 }}>Construction draws</h1>
          <div className="muted small" style={{ marginTop: 2 }}>
            {title}{app && app.ys_loan_number ? ` · ${app.ys_loan_number}` : ''}
          </div>
        </div>
        <Link className="btn ghost btn-sm" to={`/internal/app/${id}`}>← Back to the file</Link>
      </div>
      {err && <div className="panel" style={{ color: 'var(--bad,#b04a3f)' }}>{err}</div>}
      {app && app.status !== 'funded'
        ? <div className="panel" style={{ marginTop: 12 }}>This file isn’t funded yet — the draw process is the last phase and opens once the file is funded.</div>
        : <DrawsPanel appId={id} />}
    </div>
  );
}
