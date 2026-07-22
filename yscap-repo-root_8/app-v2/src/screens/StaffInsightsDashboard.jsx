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
          <AiCostSpark />
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
          <FilesLink bucket={r.bucket} />
        </div>
      ))}

      <AiStackTile />

      <h3 style={{ marginTop: 22 }}>AI spend by loan officer — last 30 days</h3>
      {(d.aiCostByOfficer || []).length === 0 && <Empty>No per-officer AI spend recorded.</Empty>}
      {(d.aiCostByOfficer || []).map((r) => (
        <div key={r.officer_email} style={{ display: 'flex', gap: 10, padding: '3px 0', borderBottom: '1px dashed var(--paper,#E9E4D3)', fontSize: 12 }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <b>{r.officer_name}</b>
            <span style={{ color: 'var(--muted,#4B585C)', marginLeft: 6 }}>· {r.files} file{r.files === 1 ? '' : 's'} · {r.calls} call{r.calls === 1 ? '' : 's'}</span>
          </span>
          <span style={{ fontWeight: 700, color: 'var(--ivory,#141B22)', minWidth: 70, textAlign: 'right' }}>${(r.cents / 100).toFixed(2)}</span>
        </div>
      ))}

      <h3 style={{ marginTop: 22 }}>AI decisions this week</h3>
      {(d.decisionsThisWeek || []).length === 0 && <Empty>No AI decisions logged in the last 7 days.</Empty>}
      {(d.decisionsThisWeek || []).length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {(d.decisionsThisWeek || []).map((r) => {
            const label = String(r.status || '').replace(/_/g, ' ');
            const tone = r.status === 'dismissed' ? 'var(--muted,#4B585C)'
              : r.status === 'converted_to_condition' || r.status === 'converted_to_task' ? 'var(--good,#3F7A5B)'
              : r.status === 'escalated' || r.status === 'marked_important' ? 'var(--amber,#B7791F)'
              : r.status === 'asked_admin' || r.status === 'answered' ? 'var(--gold,#AE8746)'
              : 'var(--teal-deep,#256168)';
            return (
              <span key={r.status} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderRadius: 8, background: 'var(--card,#fff)', border: `1px solid ${tone}`, color: tone, fontSize: 12, fontWeight: 600 }}>
                {label} <b style={{ fontSize: 13 }}>{r.n}</b>
              </span>
            );
          })}
        </div>
      )}

      <h3 style={{ marginTop: 22 }}>Files with aging fatal AI findings</h3>
      {(d.agedFatalAiFiles || []).length === 0 && <Empty>None — no open fatal AI findings on any file.</Empty>}
      {(d.agedFatalAiFiles || []).map((r) => {
        const days = Math.floor(Number(r.oldest_days) || 0);
        const tint = days >= 3 ? 'var(--crit,#B4483C)' : days >= 1 ? 'var(--amber-strong,#A05F0A)' : 'var(--amber,#B7791F)';
        const addr = (r.property_address && (r.property_address.line1 || r.property_address.address || r.property_address.oneLine)) || r.application_id.slice(0, 8);
        return (
          <div key={r.application_id} style={{ display: 'flex', gap: 10, padding: '4px 0', borderBottom: '1px dashed var(--paper,#E9E4D3)', fontSize: 12, alignItems: 'center' }}>
            <span style={{ minWidth: 70, color: tint, fontWeight: 700 }}>{days >= 1 ? `${days}d old` : '<1d'}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <Link to={`/staff/applications/${r.application_id}`} style={{ color: 'var(--teal-deep,#256168)' }}>{addr}</Link>
              {' — '}<span style={{ color: 'var(--muted,#4B585C)' }}>{r.first_name} {r.last_name} · {r.program || 'no program'} · {r.app_status}</span>
            </span>
            <Link to={`/staff/applications/${r.application_id}?focus=ai-findings`}
              title="Jump to the AI Findings panel on this file"
              style={{ fontSize: 10.5, padding: '2px 6px', borderRadius: 8, border: `1px solid ${tint}`, color: tint, textDecoration: 'none', fontWeight: 700, whiteSpace: 'nowrap' }}>
              Review AI →
            </Link>
            <span style={{ color: tint, fontWeight: 700, minWidth: 24, textAlign: 'right' }}>{r.open_fatal}</span>
          </div>
        );
      })}

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
// R4.11 — AI stack status tile. Reads /api/admin/insights/ai-stack (super_admin
// only). Silent for non-super_admins (403 returns null). Green pill per enabled
// component; muted grey per disabled component.
function AiStackTile() {
  const [data, setData] = React.useState(null);
  React.useEffect(() => { api.insightsAiStack().then((r) => setData((r && r.stack) ? r : null)).catch(() => setData(null)); }, []);
  if (!data) return null;
  const S = data.stack || {};
  const items = [
    ['Langfuse tracer', S.langfuse],
    ['Azure OpenAI (GPT)', S.azureOpenAI],
    ['Azure Document AI', S.azureDocumentAI],
    ['Azure Custom classifier', S.azureCustomClassifier],
    ['Azure Neural extractor', S.azureNeuralExtractor],
    ['Google Document AI', S.googleDocumentAI],
    ['Mistral OCR', S.mistralOcr],
    ['Per-file cost cap', S.perFileCostCap],
    ['Nightly cross-doc sweep', S.nightlyCrossdocSweep],
    ['Scheduled digests', S.notifyDigests],
    ['Render auto-deploy hook', S.renderDeployHook],
  ];
  return (
    <div style={{ marginTop: 22, border: '1px solid var(--paper,#E9E4D3)', borderRadius: 12, padding: 12, background: 'var(--card,#fff)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>AI stack — what's live on this deploy</h3>
        <span className="muted small">{Object.values(S).filter(v => v && v.enabled).length}/{items.length} configured</span>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {items.map(([label, v]) => {
          const on = !!(v && v.enabled);
          const tone = on ? 'var(--good,#3F7A5B)' : 'var(--muted,#4B585C)';
          return (
            <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 8, fontSize: 11, border: `1px solid ${tone}`, color: tone, background: on ? 'rgba(63,122,91,.08)' : 'transparent' }}>
              <span aria-hidden="true">{on ? '●' : '○'}</span>
              {label}
              {on && v.capUsd ? ` · $${v.capUsd.toFixed(2)}` : ''}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// R3.36 — 7-day mini-sparkline. Pure inline SVG, no chart lib.
function AiCostSpark() {
  const [rows, setRows] = React.useState([]);
  React.useEffect(() => {
    api.insightsAiCostTrend().then((r) => setRows((r && r.days) || [])).catch(() => setRows([]));
  }, []);
  const days = [];
  const now = new Date();
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const hit = rows.find((r) => String(r.d).slice(0, 10) === iso);
    days.push({ iso, cents: (hit && hit.cents) || 0 });
  }
  const max = Math.max(1, ...days.map((d) => d.cents));
  return (
    <svg width="100%" height="28" viewBox="0 0 140 28" preserveAspectRatio="none" style={{ marginTop: 6 }}>
      {days.map((d, i) => {
        const bh = Math.max(1, Math.round((d.cents / max) * 24));
        return (
          <rect key={d.iso} x={i * 20 + 2} y={28 - bh} width="14" height={bh}
            fill="var(--teal-deep,#256168)" opacity={d.cents ? 0.8 : 0.25}>
            <title>{d.iso}: ${(d.cents / 100).toFixed(2)}</title>
          </rect>
        );
      })}
    </svg>
  );
}

function Empty({ children }) {
  return <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)', fontStyle: 'italic' }}>{children}</div>;
}

// R3.30 — Given a top-code bucket (either a `code` string from the finding
// evidence or a source name), fetch the list of files with matching open
// suggestions and render them inline as an expandable panel.
function FilesLink({ bucket }) {
  const [open, setOpen] = React.useState(false);
  const [rows, setRows] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const load = async () => {
    setBusy(true);
    try {
      // Bucket may be a source (e.g. 'assignment_fraud') OR a finding code
      // (from evidence.code). We try 'code' first, fall back to 'source'.
      const byCode = await api.insightsFilesWithSuggestion({ code: bucket, limit: 50 }).catch(() => null);
      let files = (byCode && byCode.files) || [];
      if (!files.length) {
        const bySrc = await api.insightsFilesWithSuggestion({ source: bucket, limit: 50 }).catch(() => null);
        files = (bySrc && bySrc.files) || [];
      }
      setRows(files);
    } catch (_) { setRows([]); }
    finally { setBusy(false); }
  };
  const toggle = () => {
    setOpen(!open);
    if (!open && !rows) load();
  };
  return (
    <>
      <button className="btn ghost" onClick={toggle} disabled={busy} style={{ fontSize: 10, padding: '2px 6px' }}>
        {open ? 'hide' : (busy ? '…' : 'files →')}
      </button>
      {open && rows && (
        <div style={{ flexBasis: '100%', paddingLeft: 20, marginTop: 4 }}>
          {rows.length === 0 && <div style={{ fontSize: 11, color: 'var(--muted,#4B585C)' }}>No open files match.</div>}
          {rows.map((f) => (
            <div key={f.application_id + '|' + f.created_at} style={{ fontSize: 11, padding: '2px 0' }}>
              <Link to={`/staff/applications/${f.application_id}`} style={{ color: 'var(--teal-deep,#256168)' }}>
                {(f.property_address && (f.property_address.line1 || f.property_address.address)) || f.application_id.slice(0, 8)}
              </Link>
              {' — '}{f.first_name} {f.last_name}
              {' · '}<span style={{ color: 'var(--muted,#4B585C)' }}>{f.app_status}</span>
              {' · '}<span style={{ color: 'var(--muted,#4B585C)' }}>{new Date(f.created_at).toLocaleDateString()}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
