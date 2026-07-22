import React, { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
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
  const location = useLocation();
  const canManage = can('manage_pricing');
  const isSuper = role === 'super_admin';

  // Deep-link support: the workflow "Review exception" button links here with
  // ?app=<application_id> so this page opens SCROLLED to (and briefly
  // highlighting) the specific escalation. Without a match the page shows the
  // normal queue.
  const focusAppId = new URLSearchParams(location.search).get('app') || '';

  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState({ assetMonths: '', maxAcqLtv: '', maxArvLtv: '', maxLtc: '', isActive: true });
  const [rows, setRows] = useState([]);
  const [statusFilter, setStatusFilter] = useState('open');
  const [pendingCount, setPendingCount] = useState(0);
  const [canDecide, setCanDecide] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);       // { ok, text }
  const [notes, setNotes] = useState({});      // per-escalation decision note
  const [countering, setCountering] = useState(null);   // escalation id whose counter form is open
  const [counterNote, setCounterNote] = useState('');
  const [counterTerms, setCounterTerms] = useState({ maxAcqLtv: '', maxArvLtv: '', maxLtc: '', noteRate: '', origPct: '', loanAmount: '' });
  const [highlightId, setHighlightId] = useState('');   // deep-link visual pulse
  const rowRefs = useRef({});

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

  function openCounter(id) {
    setCountering(id);
    setCounterNote('');
    setCounterTerms({ maxAcqLtv: '', maxArvLtv: '', maxLtc: '', noteRate: '', origPct: '', loanAmount: '' });
  }

  async function submitCounter(id) {
    if (!counterNote.trim()) { flash(false, 'Add a plain-language note explaining what you would accept.'); return; }
    setBusy(true);
    try {
      // Only send the numeric fields the super-admin actually filled in — an
      // empty string means "no change." The loan officer sees the note plus
      // any specific numbers proposed.
      const terms = {};
      const asNum = (v) => { const n = Number(String(v).trim()); return Number.isFinite(n) && n > 0 ? n : null; };
      const asRatio = (v) => { const n = asNum(v); if (n == null) return null; return n > 1 ? n / 100 : n; };
      const acq = asRatio(counterTerms.maxAcqLtv); if (acq != null) terms.maxAcqLtv = acq;
      const arv = asRatio(counterTerms.maxArvLtv); if (arv != null) terms.maxArvLtv = arv;
      const ltc = asRatio(counterTerms.maxLtc);    if (ltc != null) terms.maxLtc    = ltc;
      const rt  = asRatio(counterTerms.noteRate);  if (rt  != null) terms.noteRate  = rt;
      const op  = asRatio(counterTerms.origPct);   if (op  != null) terms.origPct   = op;
      const la  = asNum(counterTerms.loanAmount);  if (la  != null) terms.loanAmount = la;
      await api.counterManualEscalation(id, terms, counterNote.trim());
      flash(true, 'Counter-offer sent — the loan officer will see the proposed terms.');
      setCountering(null); setCounterNote('');
      await loadEscalations();
    } catch (e) { flash(false, e.message || 'could not record the counter-offer'); }
    finally { setBusy(false); }
  }

  // When the queue reloads and we arrived with ?app=<id>, scroll to the matching
  // row and pulse it briefly so it's obvious which one to review.
  useEffect(() => {
    if (!focusAppId || !rows.length) return;
    const match = rows.find((r) => r.application_id === focusAppId);
    if (!match) return;
    setHighlightId(match.id);
    const el = rowRefs.current[match.id];
    if (el && typeof el.scrollIntoView === 'function') {
      try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
    }
    const t = setTimeout(() => setHighlightId(''), 3200);
    return () => clearTimeout(t);
  }, [focusAppId, rows]);

  const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setCT = (k, v) => setCounterTerms((t) => ({ ...t, [k]: v }));

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
          <h3 style={{ margin: 0 }}>Escalations {pendingCount > 0 && <span className="ts-badge warn">{pendingCount} open</span>}</h3>
          <div className="row" style={{ gap: 6 }}>
            {['open', 'pending', 'countered', 'approved', 'declined', 'all'].map((s) => (
              <button key={s} className={`btn small ${statusFilter === s ? 'primary' : 'ghost'}`} onClick={() => setStatusFilter(s)}>
                {s[0].toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        </div>
        {!isSuper && (
          <p className="muted small">Only a super-admin can approve, decline, or counter-offer an exception. You can watch the queue here.</p>
        )}
        {!rows.length && <p className="muted" style={{ marginTop: 12 }}>No {statusFilter === 'all' ? '' : statusFilter} escalations.</p>}
        {rows.map((r) => {
          const s = r.summary || {};
          const ct = r.counter_terms || {};
          const isOpen = r.status === 'pending' || r.status === 'countered';
          const badgeCls = r.status === 'approved' ? 'ok' : (r.status === 'declined' ? 'err' : 'warn');
          const rowStyle = {
            border: '1px solid var(--hairline,#e5e0d5)', borderRadius: 10, padding: 12, marginTop: 12,
            transition: 'box-shadow 0.4s ease, border-color 0.4s ease',
            boxShadow: highlightId === r.id ? '0 0 0 3px #AE8746' : 'none',
            borderColor: highlightId === r.id ? '#AE8746' : 'var(--hairline,#e5e0d5)',
          };
          return (
            <div key={r.id} ref={(el) => { rowRefs.current[r.id] = el; }} className="card" style={rowStyle}>
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
                  {/* Owner-directed 2026-07-22: the approval must state whether the
                      3-month minimum earned interest is still on (its default for a
                      manual product) or was turned off, plus the accrual type. */}
                  {(s.minInterest != null || s.accrual) && (
                    <div className="muted small" style={{ marginTop: 2 }}>
                      {s.minInterest != null && (
                        <>3-month minimum interest: <strong>{s.minInterest ? 'ON' : 'OFF'}</strong>
                          {s.minInterestDefault != null ? (s.minInterest === s.minInterestDefault ? ' (left at the default)' : ' (changed from the default)') : ''}
                        </>
                      )}
                      {s.accrual ? `${s.minInterest != null ? ' · ' : ''}Accrual: ${s.accrual === 'dutch' ? 'Dutch / Full-Boat' : 'Non-Dutch / As-Drawn'}` : ''}
                    </div>
                  )}
                </div>
                <span className={`ts-badge ${badgeCls}`}>{r.status}</span>
              </div>

              {/* If a counter has been proposed, show it — everyone (super-admin + admins watching) sees it. */}
              {r.status === 'countered' && (
                <div style={{ marginTop: 10, padding: 10, background: 'rgba(174,135,70,0.08)', border: '1px solid #AE8746', borderRadius: 8 }}>
                  <div className="small" style={{ fontWeight: 600, color: '#141B22' }}>Counter-offer{r.countered_by ? ' — awaiting the loan officer' : ''}</div>
                  {r.counter_note && <div className="small" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{r.counter_note}</div>}
                  {Object.keys(ct).length > 0 && (
                    <div className="muted small" style={{ marginTop: 6 }}>
                      Proposed:{' '}
                      {ct.maxAcqLtv != null && <span>as-is LTV {(ct.maxAcqLtv * 100).toFixed(2)}% · </span>}
                      {ct.maxArvLtv != null && <span>ARV LTV {(ct.maxArvLtv * 100).toFixed(2)}% · </span>}
                      {ct.maxLtc    != null && <span>LTC {(ct.maxLtc * 100).toFixed(2)}% · </span>}
                      {ct.noteRate  != null && <span>rate {(ct.noteRate * 100).toFixed(2)}% · </span>}
                      {ct.origPct   != null && <span>origination {(ct.origPct * 100).toFixed(2)}% · </span>}
                      {ct.loanAmount != null && <span>loan {money(ct.loanAmount)} · </span>}
                    </div>
                  )}
                </div>
              )}

              {isOpen && isSuper && countering !== r.id && (
                <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
                  <input className="input" style={{ flex: 1, minWidth: 180 }} placeholder="Decision note (optional)"
                    value={notes[r.id] || ''} onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))} />
                  <button className="btn primary small" disabled={busy} onClick={() => decide(r.id, 'approved')}>Approve</button>
                  <button className="btn ghost small" disabled={busy} onClick={() => openCounter(r.id)}>Counter-offer</button>
                  <button className="btn ghost small" disabled={busy} onClick={() => decide(r.id, 'declined')}>Decline</button>
                </div>
              )}

              {isOpen && isSuper && countering === r.id && (
                <div style={{ marginTop: 10, padding: 10, background: 'var(--paper,#F6F3EC)', borderRadius: 8 }}>
                  <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>Counter-offer — what would you accept?</div>
                  <div className="muted small" style={{ marginBottom: 8 }}>
                    Write the terms plainly in the note (the loan officer sees this verbatim). Optionally fill any of the numbers below — leave blank if the current registered value stands. Enter LTV / LTC / rate / origination as PERCENTS (e.g. 92.5, 11.25, 1.5). Loan amount is a dollar number.
                  </div>
                  <textarea className="input" rows={3} placeholder="e.g. I'll approve at 92.5% LTC (not 91%) if the rate goes up 0.25 to cover the extra risk. Everything else stays." value={counterNote} onChange={(e) => setCounterNote(e.target.value)} style={{ width: '100%' }} />
                  <div className="grid2" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 8, marginTop: 8 }}>
                    <div className="field"><label>As-is LTV %</label>
                      <input className="input" inputMode="decimal" placeholder="—" value={counterTerms.maxAcqLtv}
                        onChange={(e) => setCT('maxAcqLtv', e.target.value.replace(/[^0-9.]/g, ''))} /></div>
                    <div className="field"><label>ARV LTV %</label>
                      <input className="input" inputMode="decimal" placeholder="—" value={counterTerms.maxArvLtv}
                        onChange={(e) => setCT('maxArvLtv', e.target.value.replace(/[^0-9.]/g, ''))} /></div>
                    <div className="field"><label>LTC %</label>
                      <input className="input" inputMode="decimal" placeholder="—" value={counterTerms.maxLtc}
                        onChange={(e) => setCT('maxLtc', e.target.value.replace(/[^0-9.]/g, ''))} /></div>
                    <div className="field"><label>Note rate %</label>
                      <input className="input" inputMode="decimal" placeholder="—" value={counterTerms.noteRate}
                        onChange={(e) => setCT('noteRate', e.target.value.replace(/[^0-9.]/g, ''))} /></div>
                    <div className="field"><label>Origination %</label>
                      <input className="input" inputMode="decimal" placeholder="—" value={counterTerms.origPct}
                        onChange={(e) => setCT('origPct', e.target.value.replace(/[^0-9.]/g, ''))} /></div>
                    <div className="field"><label>Total loan $</label>
                      <input className="input" inputMode="numeric" placeholder="—" value={counterTerms.loanAmount}
                        onChange={(e) => setCT('loanAmount', e.target.value.replace(/[^0-9]/g, ''))} /></div>
                  </div>
                  <div className="row" style={{ gap: 8, marginTop: 10 }}>
                    <button className="btn primary small" disabled={busy || !counterNote.trim()} onClick={() => submitCounter(r.id)}>Send counter-offer</button>
                    <button className="btn ghost small" onClick={() => { setCountering(null); setCounterNote(''); }}>Cancel</button>
                  </div>
                </div>
              )}

              {(r.status === 'approved' || r.status === 'declined') && (
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
