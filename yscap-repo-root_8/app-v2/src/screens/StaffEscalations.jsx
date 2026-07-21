import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

/* Manual Program admin + the super-admin ESCALATION box (owner-directed
 * 2026-07-20).
 *
 * TOP — the Manual Program config (manage_pricing): the default LTV/LTC/ARV
 * ceilings and the REQUIRED default months of assets/liquidity a manual product
 * must show. A manual product is created when a staffer overrides the deal
 * structure (LTV/LTC/ARV) in the Term Sheet Studio — it prices on the Standard
 * (Fidelis) guidelines but carries the manual leverage and ALWAYS requires the
 * flood certificate.
 *
 * BOTTOM — the escalation box: every manual product registers immediately but
 * waits here for a super-admin to approve or decline it. Admins can watch the
 * box; only a super-admin decides.
 */

const money = (v) => (v == null || v === '' || isNaN(Number(v))) ? '—' : '$' + Number(v).toLocaleString('en-US');
const pctOf = (v) => (v == null ? '—' : (Number(v) * 100).toFixed(1) + '%');

function fmtAddr(a) {
  if (!a) return '';
  if (typeof a === 'string') return a;
  return [a.line1 || a.address, a.city, a.state].filter(Boolean).join(', ');
}

export default function StaffEscalations() {
  const { can, role } = useAuth();
  const canManage = can('manage_pricing');
  const isSuper = role === 'super_admin';

  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState({ assetMonths: '', maxAcqLtv: '', maxArvLtv: '', maxLtc: '', isActive: true });
  const [rows, setRows] = useState([]);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [pendingCount, setPendingCount] = useState(0);
  const [canDecide, setCanDecide] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);       // { ok, text }
  const [notes, setNotes] = useState({});      // per-escalation decision note

  const flash = (ok, text) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 7000); };

  const loadSettings = () => canManage && api.manualProgramSettings()
    .then((d) => {
      setSettings(d.settings);
      setForm({
        assetMonths: d.settings.assetMonths != null ? String(d.settings.assetMonths) : '',
        maxAcqLtv: d.settings.maxAcqLtv != null ? String(d.settings.maxAcqLtv) : '',
        maxArvLtv: d.settings.maxArvLtv != null ? String(d.settings.maxArvLtv) : '',
        maxLtc: d.settings.maxLtc != null ? String(d.settings.maxLtc) : '',
        isActive: d.settings.isActive !== false,
      });
    })
    .catch((e) => flash(false, e.message || 'could not load manual program settings'));

  const loadEscalations = () => api.manualEscalations(statusFilter)
    .then((d) => { setRows(d.escalations || []); setPendingCount(d.pendingCount || 0); setCanDecide(!!d.canDecide); })
    .catch((e) => flash(false, e.message || 'could not load escalations'));

  useEffect(() => { loadSettings(); /* eslint-disable-next-line */ }, [canManage]);
  useEffect(() => { loadEscalations(); /* eslint-disable-next-line */ }, [statusFilter]);

  async function saveSettings() {
    setBusy(true);
    try {
      const body = {
        assetMonths: form.assetMonths === '' ? '' : Number(form.assetMonths),
        maxAcqLtv: form.maxAcqLtv === '' ? null : Number(form.maxAcqLtv),
        maxArvLtv: form.maxArvLtv === '' ? null : Number(form.maxArvLtv),
        maxLtc: form.maxLtc === '' ? null : Number(form.maxLtc),
        isActive: !!form.isActive,
      };
      const d = await api.saveManualProgramSettings(body);
      setSettings(d.settings);
      flash(true, 'Manual program settings saved.');
    } catch (e) { flash(false, e.message || 'could not save'); }
    finally { setBusy(false); }
  }

  async function decide(id, decision) {
    setBusy(true);
    try {
      await api.decideManualEscalation(id, decision, notes[id] || '');
      flash(true, `Exception ${decision === 'approved' ? 'approved — the borrower will be sent their terms' : 'declined'}.`);
      await loadEscalations();
    } catch (e) { flash(false, e.message || 'could not record the decision'); }
    finally { setBusy(false); }
  }

  const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div>
      <div className="page-head"><h1>Manual programs &amp; escalations</h1></div>
      {msg && <div className={`notice ${msg.ok ? 'ok' : 'err'}`} style={{ marginBottom: 12 }}>{msg.text}</div>}

      {/* --- Manual Program config --- */}
      {canManage && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>Manual Program settings</h3>
          <p className="muted small" style={{ marginTop: 0 }}>
            A manual product is created when someone overrides the LTV, LTC or ARV in the studio. It follows the
            Standard (Fidelis) guidelines for everything else, always requires the flood certificate, and must be
            approved below. You must set how many months of assets/liquidity a manual product requires before it can be
            registered — this can be raised per file at registration.
          </p>
          <div className="grid2" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 12 }}>
            <div className="field">
              <label>Required months of assets / liquidity *</label>
              <input className="input" inputMode="numeric" value={form.assetMonths}
                onChange={(e) => setF('assetMonths', e.target.value.replace(/[^0-9]/g, ''))} placeholder="e.g. 2" />
              <div className="hint">Required. 1–24. The default a manual product must show; the registrant can raise it.</div>
            </div>
            <div className="field">
              <label>Max acquisition LTV %</label>
              <input className="input" inputMode="decimal" value={form.maxAcqLtv}
                onChange={(e) => setF('maxAcqLtv', e.target.value.replace(/[^0-9.]/g, ''))} placeholder="none" />
              <div className="hint">Advisory ceiling (blank = none).</div>
            </div>
            <div className="field">
              <label>Max after-repair (ARV) LTV %</label>
              <input className="input" inputMode="decimal" value={form.maxArvLtv}
                onChange={(e) => setF('maxArvLtv', e.target.value.replace(/[^0-9.]/g, ''))} placeholder="none" />
              <div className="hint">Advisory ceiling (blank = none).</div>
            </div>
            <div className="field">
              <label>Max loan-to-cost (LTC) %</label>
              <input className="input" inputMode="decimal" value={form.maxLtc}
                onChange={(e) => setF('maxLtc', e.target.value.replace(/[^0-9.]/g, ''))} placeholder="none" />
              <div className="hint">Advisory ceiling (blank = none).</div>
            </div>
          </div>
          <label className="row" style={{ gap: 8, alignItems: 'center', marginTop: 10 }}>
            <input type="checkbox" checked={!!form.isActive} onChange={(e) => setF('isActive', e.target.checked)} />
            <span>Manual Program is available</span>
          </label>
          <div style={{ marginTop: 12 }}>
            <button className="btn primary" disabled={busy} onClick={saveSettings}>{busy ? 'Saving…' : 'Save settings'}</button>
          </div>
        </div>
      )}

      {/* --- Escalation box --- */}
      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>Escalations {pendingCount > 0 && <span className="ts-badge warn">{pendingCount} pending</span>}</h3>
          <div className="row" style={{ gap: 6 }}>
            {['pending', 'approved', 'declined', 'all'].map((s) => (
              <button key={s} className={`btn small ${statusFilter === s ? 'primary' : 'ghost'}`} onClick={() => setStatusFilter(s)}>
                {s[0].toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        </div>
        {!isSuper && (
          <p className="muted small">Only a super-admin can approve or decline a manual product. You can watch the queue here.</p>
        )}
        {!rows.length && <p className="muted" style={{ marginTop: 12 }}>No {statusFilter === 'all' ? '' : statusFilter} escalations.</p>}
        {rows.map((r) => {
          const s = r.summary || {};
          return (
            <div key={r.id} className="card" style={{ border: '1px solid var(--hairline,#e5e0d5)', borderRadius: 10, padding: 12, marginTop: 12 }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                <div>
                  <div>
                    <a href={`#/internal/app/${r.application_id}`}><strong>{r.ys_loan_number || 'File'}</strong></a>
                    {' · '}{[r.first_name, r.last_name].filter(Boolean).join(' ')}
                    {r.property_address ? ` · ${fmtAddr(r.property_address)}` : ''}
                  </div>
                  <div className="muted small" style={{ marginTop: 4 }}>
                    {s.kind === 'manual_review'
                      ? `${s.program === 'gold' ? 'Gold Standard' : 'Standard'} — manual-review exception`
                      : 'Manual Program'}
                    {' · '}{money(s.totalLoan != null ? s.totalLoan : r.loan_amount)} loan
                    {s.noteRate != null ? ` @ ${(Number(s.noteRate) * 100).toFixed(2)}%` : ''}
                    {r.asset_months != null ? ` · ${r.asset_months} month${r.asset_months === 1 ? '' : 's'} liquidity` : ''}
                  </div>
                  {Array.isArray(s.manualReasons) && s.manualReasons.length > 0 && (
                    <div className="muted small" style={{ marginTop: 2 }}>
                      Why it needs an exception: {s.manualReasons.join('; ')}
                    </div>
                  )}
                  <div className="muted small" style={{ marginTop: 2 }}>
                    {s.kind === 'manual_review'
                      ? `Leverage: ${pctOf(s.acqLtvPct)} as-is · ${pctOf(s.arvPct)} ARV · ${pctOf(s.ltcPct)} LTC`
                      : `Leverage: acq LTV ${pctOf(s.acqLtvPct)} · ARV ${pctOf(s.arvPct)} · LTC ${pctOf(s.ltcPct)}`}
                    {r.requested_by_name ? ` · requested by ${r.requested_by_name}` : (s.requestedByBorrower ? ' · requested by the borrower' : '')}
                  </div>
                </div>
                <span className={`ts-badge ${r.status === 'pending' ? 'warn' : r.status === 'approved' ? 'ok' : 'err'}`}>{r.status}</span>
              </div>
              {r.status === 'pending' && isSuper && (
                <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
                  <input className="input" style={{ flex: 1, minWidth: 180 }} placeholder="Decision note (optional)"
                    value={notes[r.id] || ''} onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))} />
                  <button className="btn primary small" disabled={busy} onClick={() => decide(r.id, 'approved')}>Approve</button>
                  <button className="btn ghost small" disabled={busy} onClick={() => decide(r.id, 'declined')}>Decline</button>
                </div>
              )}
              {r.status !== 'pending' && (
                <div className="muted small" style={{ marginTop: 8 }}>
                  {r.status === 'approved' ? 'Approved' : 'Declined'}{r.decided_by_name ? ` by ${r.decided_by_name}` : ''}
                  {r.decision_note ? ` — ${r.decision_note}` : ''}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
