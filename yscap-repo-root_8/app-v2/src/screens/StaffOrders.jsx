import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';

/* ════════════════════════════════════════════════════════════════════════════
   ORDERS QUEUE — every title & insurance order across the files the viewer can
   see, in one place. Files with documents waiting to be classified float to the
   top. Each order links straight into its file's Orders section.
   ════════════════════════════════════════════════════════════════════════════ */

const STATUS_LABEL = {
  not_ordered: 'Not ordered', ordered: 'Ordered', documents_in: 'Documents in',
  completed: 'Completed', cancelled: 'Cancelled',
};
function addrLine(pa) {
  pa = pa || {};
  if (pa.oneLine) return pa.oneLine;
  const street = pa.street || pa.line1 || '';
  const tail = [pa.city, [pa.state, pa.zip || pa.postal].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [street, tail].filter(Boolean).join(', ') || '—';
}
function when(ts) { return ts ? new Date(ts).toLocaleDateString() : ''; }

function OrderCell({ o }) {
  if (!o) return <span className="muted small">—</span>;
  const tone = o.status === 'completed' ? { color: 'var(--ok)', borderColor: 'var(--ok)' }
    : o.status === 'documents_in' ? { color: 'var(--teal,#2F7F86)', borderColor: 'var(--teal,#2F7F86)' }
    : o.status === 'ordered' ? { color: 'var(--teal,#2F7F86)', borderColor: 'var(--teal,#2F7F86)' }
    : { color: 'var(--gold)', borderColor: 'var(--gold)' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span className="pill" style={tone}>{STATUS_LABEL[o.status] || o.status}</span>
      <span className="muted small">
        {o.vendorName ? `${o.vendorName} · ` : ''}{o.orderedAt ? when(o.orderedAt) : 'not sent'}
        {o.followupCount > 0 ? ` · ${o.followupCount} follow-up${o.followupCount === 1 ? '' : 's'}` : ''}
      </span>
      {o.unassignedDocs > 0 && <span className="pill" style={{ color: 'var(--gold)', borderColor: 'var(--gold)' }}>{o.unassignedDocs} to assign</span>}
      {o.unassignedDocs === 0 && o.returnedDocs > 0 && <span className="muted small">{o.returnedDocs} doc{o.returnedDocs === 1 ? '' : 's'} back</span>}
    </div>
  );
}

export default function StaffOrders() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('all');

  useEffect(() => { api.staffAllOrders().then(setRows).catch(e => setErr((e && e.message) || 'Could not load orders.')); }, []);

  const filtered = useMemo(() => {
    const list = rows || [];
    if (filter === 'to_assign') return list.filter(f => (f.title && f.title.unassignedDocs > 0) || (f.insurance && f.insurance.unassignedDocs > 0));
    if (filter === 'open') return list.filter(f => [f.title, f.insurance].some(o => o && (o.status === 'ordered' || o.status === 'documents_in')));
    return list;
  }, [rows, filter]);

  const toAssign = useMemo(() => (rows || []).reduce((n, f) => n + ((f.title && f.title.unassignedDocs) || 0) + ((f.insurance && f.insurance.unassignedDocs) || 0), 0), [rows]);

  if (err) return <div className="notice err">{err}</div>;
  if (!rows) return <div className="panel"><p className="muted small">Loading orders…</p></div>;

  return (
    <div>
      <div className="row" style={{ alignItems: 'center', marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Orders</h1>
        <div className="spacer" />
        {toAssign > 0 && <span className="pill" style={{ color: 'var(--gold)', borderColor: 'var(--gold)' }}>{toAssign} document{toAssign === 1 ? '' : 's'} to classify</span>}
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>Every title and insurance order across your files. Open a file to order, follow up, or classify what came back.</p>

      <div className="cond-tabs" role="tablist" style={{ marginBottom: 10 }}>
        {[{ k: 'all', label: 'All' }, { k: 'open', label: 'In progress' }, { k: 'to_assign', label: `Needs classifying${toAssign ? ` (${toAssign})` : ''}` }].map(t => (
          <button key={t.k} type="button" role="tab" aria-selected={filter === t.k}
            className={`cond-tab${filter === t.k ? ' active' : ''}`} onClick={() => setFilter(t.k)}>{t.label}</button>
        ))}
      </div>

      {filtered.length === 0
        ? <div className="panel"><p className="muted small">No orders match.</p></div>
        : (
          <div className="panel" style={{ overflowX: 'auto' }}>
            <table className="table" style={{ width: '100%', minWidth: 720 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>File</th>
                  <th style={{ textAlign: 'left' }}>Title order</th>
                  <th style={{ textAlign: 'left' }}>Insurance order</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map(f => (
                  <tr key={f.applicationId}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{f.loanNumber || 'Loan # pending'}</div>
                      <div className="muted small">{f.borrowerName || '—'} · {addrLine(f.propertyAddress)}</div>
                    </td>
                    <td><OrderCell o={f.title} /></td>
                    <td><OrderCell o={f.insurance} /></td>
                    <td style={{ textAlign: 'right' }}>
                      <Link className="btn ghost small" to={`/internal/app/${f.applicationId}#sec-orders`}>Open</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}
