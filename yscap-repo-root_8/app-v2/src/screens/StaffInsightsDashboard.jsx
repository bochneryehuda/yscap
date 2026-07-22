import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { Link } from 'react-router-dom';

/**
 * Sovereign Insights portfolio dashboard (R2.6, owner-directed 2026-07-22).
 *
 * At-a-glance portfolio view for admins and super-admins — everything the
 * AI + Sovereign spine surfaced across all files:
 *   * Open findings by severity + open AI suggestions by source
 *   * Certificates issued in the last 30 days by milestone
 *   * AI spend (30 days) + call count
 *   * Top AI-surfaced issue codes across the portfolio
 *   * Latest human decisions on AI suggestions (audit trail)
 *
 * Admin+ role only.
 */

const SOURCE_LABEL = {
  cure_analysis: 'Condition cure',
  promoted_rules: 'Promoted rule',
  committee: 'Model committee',
  section_1071: 'Section 1071',
  twin_reconcile: 'Loan twin',
  authenticity: 'Doc authenticity',
  entity_chain: 'Entity chain',
  assignment_fraud: 'Assignment fraud',
  wrong_condition: 'Wrong condition',
  ask_admin: 'Ask super-admin',
  splitter: 'Document splitter',
};
const SEV_COLOR = { fatal: 'var(--crit,#B4483C)', warning: 'var(--amber,#B7791F)', info: 'var(--teal-deep,#256168)' };

export default function StaffInsightsDashboard() {
  const { role } = useAuth();
  const isAdmin = role === 'admin' || role === 'super_admin';
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = React.useCallback(async () => {
    setBusy(true); setErr('');
    try { const r = await api.insightsDashboard(); setData(r || null); }
    catch (e) { setErr((e && e.message) || 'could not load'); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { if (isAdmin) load(); }, [isAdmin, load]);

  if (!isAdmin) return <div className="notice">Admin only. This shows what PILOT sees across every file.</div>;

  if (busy && !data) return <div className="page">Loading…</div>;
  if (err) return <div className="page"><div className="error">{err}</div></div>;
  const d = data || {};

  return (
    <div className="page">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>Sovereign Insights</h2>
        <span style={{ fontSize: 12, color: 'var(--muted,#4B585C)' }}>Portfolio-wide view of what the AI has surfaced</span>
        <button className="btn ghost" onClick={load} disabled={busy} style={{ marginLeft: 'auto', fontSize: 11 }}>{busy ? '…' : '↻ Refresh'}</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 12, marginTop: 16 }}>
        {/* Open findings by severity */}
        <Card title="Open findings">
          {(d.openFindings || []).length === 0 && <Empty>No open findings across the portfolio.</Empty>}
          {(d.openFindings || []).map((r) => (
            <Row key={r.severity} label={r.severity} count={r.n} color={SEV_COLOR[r.severity]} />
          ))}
        </Card>

        {/* AI suggestions by source */}
        <Card title="Open AI suggestions">
          {(d.openSuggestions || []).length === 0 && <Empty>Nothing waiting on the AI panel.</Empty>}
          {(d.openSuggestions || []).map((r) => (
            <Row key={r.source} label={SOURCE_LABEL[r.source] || r.source} count={r.n} />
          ))}
        </Card>

        {/* Certificates issued (30 days) */}
        <Card title="Certificates issued — 30 days">
          {(d.certificates30d || []).length === 0 && <Empty>No certificates issued in the last 30 days.</Empty>}
          {(d.certificates30d || []).map((r) => (
            <Row key={r.milestone} label={r.milestone} count={r.n} />
          ))}
        </Card>

        {/* AI spend */}
        <Card title="AI spend — 30 days">
          <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--ivory,#141B22)' }}>
            ${(((d.aiSpend30d && d.aiSpend30d.cents) || 0) / 100).toFixed(2)}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)' }}>
            across {((d.aiSpend30d && d.aiSpend30d.n) || 0)} AI calls
          </div>
        </Card>

        {/* Training proposals */}
        <Card title="Training proposals">
          {(d.trainingProposals || []).length === 0 && <Empty>No learning proposals right now.</Empty>}
          {(d.trainingProposals || []).map((r) => (
            <Row key={r.status} label={r.status} count={r.n} />
          ))}
          <Link to="/internal/training" style={{ fontSize: 11, color: 'var(--teal-deep,#256168)', display: 'block', marginTop: 8 }}>
            Open training proposals →
          </Link>
        </Card>
      </div>

      <h3 style={{ marginTop: 22 }}>Top AI-surfaced issues (portfolio)</h3>
      {(d.topSuggestionCodes || []).length === 0 && <Empty>None yet.</Empty>}
      {(d.topSuggestionCodes || []).map((r) => (
        <div key={r.bucket} style={{ display: 'flex', gap: 10, padding: '4px 0', borderBottom: '1px dashed var(--paper,#E9E4D3)', fontSize: 13 }}>
          <span style={{ flex: 1 }}>{r.bucket}</span>
          <span style={{ fontWeight: 700 }}>{r.n}</span>
        </div>
      ))}

      <h3 style={{ marginTop: 22 }}>Recent human decisions on AI suggestions</h3>
      {(d.recentDecisions || []).length === 0 && <Empty>No recent decisions.</Empty>}
      {(d.recentDecisions || []).map((r) => (
        <div key={r.id} style={{ padding: '6px 0', borderBottom: '1px dashed var(--paper,#E9E4D3)', fontSize: 12 }}>
          <span style={{ color: 'var(--muted,#4B585C)' }}>{new Date(r.decided_at).toLocaleString()}</span>
          {' · '}<b>{SOURCE_LABEL[r.source] || r.source}</b>
          {' · '}<span style={{ color: 'var(--teal-deep,#256168)' }}>{r.status.replace(/_/g, ' ')}</span>
          {' · '}<span>{r.title}</span>
          {r.application_id && <Link to={`/staff/applications/${r.application_id}`} style={{ marginLeft: 6, fontSize: 11 }}>open file →</Link>}
        </div>
      ))}
    </div>
  );
}

function Card({ title, children }) {
  return (
    <div style={{ border: '1px solid var(--paper,#E9E4D3)', borderRadius: 10, padding: 12, background: 'var(--card,#fff)' }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted,#4B585C)', marginBottom: 6, fontWeight: 700 }}>{title}</div>
      {children}
    </div>
  );
}
function Row({ label, count, color }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '3px 0', fontSize: 13 }}>
      <span style={{ color: color || 'var(--ivory,#141B22)' }}>{label}</span>
      <span style={{ fontWeight: 700 }}>{count}</span>
    </div>
  );
}
function Empty({ children }) {
  return <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)', fontStyle: 'italic' }}>{children}</div>;
}
