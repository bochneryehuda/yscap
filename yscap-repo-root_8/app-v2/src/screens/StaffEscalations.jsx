import React, { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { fullNameOf } from '../lib/personName.js';
import { fmtRatePct } from '../lib/rateFormat.js';

/* Manual Program admin + the super-admin ESCALATION box (owner-directed
 * 2026-07-20; page redesign 2026-07-26).
 *
 * TOP — the Manual Program config (manage_pricing): the default LTV/LTC/ARV
 * ceilings and the REQUIRED default months of assets/liquidity a manual product
 * must show. A manual product is created when a staffer overrides the deal
 * structure (LTV/LTC/ARV) in the Term Sheet Studio — it prices on the Standard
 * Program guidelines but carries the manual leverage and ALWAYS requires the
 * flood certificate. (No capital-partner name here: this file compiles into the
 * one portal bundle every visitor downloads.)
 *
 * BOTTOM — the escalation box: a registration that needs sign-off lands
 * immediately but waits here to be approved or declined. Three kinds arrive
 * (owner-directed 2026-07-27 widened the third):
 *   · Manual Program   — the LTV / LTC / ARV structure was overridden.
 *   · Manual review    — the frozen engine flagged the deal MANUAL.
 *   · Pricing override — any admin-zone knob moved off the company defaults
 *                        (a reduced rate markup, reduced origination points, a
 *                        discounted or waived closing fee, an approved
 *                        effective purchase price).
 * Any ADMIN or super-admin decides — except on an exception they requested
 * themselves, which needs someone else (enforced server-side; the per-row
 * `canDecide` flag mirrors it here).
 */

const money = (v) => (v == null || v === '' || isNaN(Number(v))) ? '—' : '$' + Number(v).toLocaleString('en-US');
const pctOf = (v) => (v == null ? '—' : (Number(v) * 100).toFixed(1) + '%');

function fmtAddr(a) {
  if (!a) return '';
  if (typeof a === 'string') return a;
  return [a.line1 || a.address, a.city, a.state].filter(Boolean).join(', ');
}

/* Inline stroke-icon set (matches the draws dashboard house style). */
function Icon({ name }) {
  const p = {
    sliders: <><line x1="4" y1="6" x2="12" y2="6" /><line x1="17" y1="6" x2="20" y2="6" /><circle cx="14.5" cy="6" r="2.2" /><line x1="4" y1="12" x2="7" y2="12" /><line x1="12" y1="12" x2="20" y2="12" /><circle cx="9.5" cy="12" r="2.2" /><line x1="4" y1="18" x2="14" y2="18" /><line x1="19" y1="18" x2="20" y2="18" /><circle cx="16.5" cy="18" r="2.2" /></>,
    inbox: <><path d="M3 12h4l1.5 2.5h7L17 12h4" /><path d="M5 5h14l2 7v6H3v-6z" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></>,
    gauge: <><path d="M4 19a8 8 0 1 1 16 0" /><path d="M12 19l4.5-6.5" /></>,
    check: <><path d="M4.5 12.5l5 5L20 6.5" /></>,
    inboxEmpty: <><path d="M3 13h4l1.5 2.5h7L17 13h4" /><path d="M5 6h14l2 7v5H3v-5z" /><path d="M12 3v3" /></>,
  }[name] || null;
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{p}</svg>;
}

export default function StaffEscalations() {
  const { can, role } = useAuth();
  const location = useLocation();
  const canManage = can('manage_pricing');
  // Deciding is no longer super-admin-only (owner-directed 2026-07-27 — "sent to
  // the admin for approval"): any admin / super-admin may approve, decline or
  // counter, EXCEPT their own request (the server decides per row and sends
  // `canDecide` on it; `role` is only used for wording).
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
  // Deep-link landed here but the file has no manual escalation — the ask is
  // almost certainly a PRICING EXCEPTION, which now lives in the Exceptions box
  // (redesign 2026-07-24; this page structurally can't show those).
  const [focusMissed, setFocusMissed] = useState(false);
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
    if (!match) { setFocusMissed(true); return; }
    setFocusMissed(false);
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

  const FILTERS = ['open', 'pending', 'countered', 'approved', 'declined', 'all'];

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="esc-eyebrow">Underwriting · Manual products</div>
          <h1>Manual programs &amp; escalations</h1>
          <div className="sub">Set the defaults a manual product must carry, then approve, counter, or decline the ones waiting for a decision.</div>
        </div>
        {pendingCount > 0 && (
          <div className="page-head-actions">
            <span className="ts-badge warn" style={{ fontSize: 12, padding: '6px 12px' }}>
              {pendingCount} awaiting a decision
            </span>
          </div>
        )}
      </div>
      <p className="muted small" style={{ marginTop: -6, marginBottom: 14 }}>
        This box is only for <b>manual-program pricing</b> — deals structured <b>outside the guidelines</b> (custom
        leverage / below-minimum), where an admin approves, declines, or <b>counter-offers</b> (proposes different
        terms). Guaranty waivers, early term-sheet sends, and other one-off rule exceptions live in{' '}
        <Link to="/internal/exceptions">Exceptions</Link>.
      </p>

      {msg && <div className={`notice ${msg.ok ? 'ok' : 'err'}`} style={{ marginBottom: 14 }}>{msg.text}</div>}
      {/* A deep-link pointed here but this file has no manual escalation — the
          ask is almost certainly a pricing/guideline EXCEPTION, which lives in
          the Exceptions box (this queue can only show manual-product rows). */}
      {focusMissed && (
        <div className="notice warn" style={{ marginBottom: 14 }}>
          No manual-product escalation on that file. Looking for its <b>exception request</b>? Pricing/guideline
          exceptions live in the Exceptions box — <Link to={`/internal/exceptions?app=${focusAppId}`}>open it there</Link>.
        </div>
      )}

      {/* --- Manual Program config --- */}
      {canManage && (
        <div className="dd-card" style={{ marginBottom: 16 }}>
          <div className="dd-card-h" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div className="row" style={{ gap: 11, alignItems: 'center' }}>
              <span className="dd-card-ic"><Icon name="sliders" /></span>
              <div>
                <h3>Manual Program settings</h3>
                <div className="dd-sub" style={{ marginTop: 1 }}>The defaults every manual product is built and priced against.</div>
              </div>
            </div>
            <span className={`ts-badge ${form.isActive ? 'ok' : 'err'}`}>{form.isActive ? 'Available' : 'Turned off'}</span>
          </div>

          <div className="esc-callout" style={{ marginTop: 4 }}>
            <span className="ic"><Icon name="info" /></span>
            <div>
              A manual product is created when someone overrides the LTV, LTC or ARV in the studio. It follows the
              Standard Program guidelines for everything else, always requires the flood certificate, and must be
              approved below. Set how many months of assets/liquidity a manual product requires before it can be
              registered — this can be raised per file at registration.
            </div>
          </div>

          {/* Primary, required setting */}
          <div className="esc-primary-field">
            <div className="field" style={{ marginBottom: 0, maxWidth: 260 }}>
              <label>Required months of assets / liquidity *</label>
              <div className="inp-suffix">
                <input className="input" inputMode="numeric" value={form.assetMonths}
                  onChange={(e) => setF('assetMonths', e.target.value.replace(/[^0-9]/g, ''))} placeholder="e.g. 2" />
                <span className="sfx">months</span>
              </div>
              <div className="hint">Required. 1–24. The default a manual product must show; the registrant can raise it.</div>
            </div>
          </div>

          {/* Advisory leverage ceilings */}
          <div className="esc-sublabel">Advisory leverage ceilings</div>
          <div className="esc-ceilings">
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Max acquisition LTV</label>
              <div className="inp-suffix">
                <input className="input" inputMode="decimal" value={form.maxAcqLtv}
                  onChange={(e) => setF('maxAcqLtv', e.target.value.replace(/[^0-9.]/g, ''))} placeholder="none" />
                <span className="sfx">%</span>
              </div>
              <div className="hint">Advisory ceiling (blank = none).</div>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Max after-repair (ARV) LTV</label>
              <div className="inp-suffix">
                <input className="input" inputMode="decimal" value={form.maxArvLtv}
                  onChange={(e) => setF('maxArvLtv', e.target.value.replace(/[^0-9.]/g, ''))} placeholder="none" />
                <span className="sfx">%</span>
              </div>
              <div className="hint">Advisory ceiling (blank = none).</div>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Max loan-to-cost (LTC)</label>
              <div className="inp-suffix">
                <input className="input" inputMode="decimal" value={form.maxLtc}
                  onChange={(e) => setF('maxLtc', e.target.value.replace(/[^0-9.]/g, ''))} placeholder="none" />
                <span className="sfx">%</span>
              </div>
              <div className="hint">Advisory ceiling (blank = none).</div>
            </div>
          </div>

          {/* Availability toggle */}
          <div className="esc-availability">
            <div>
              <label className="esc-switch">
                <input type="checkbox" checked={!!form.isActive} onChange={(e) => setF('isActive', e.target.checked)} />
                <span className="track" />
                <span className="switch-txt">Manual Program is available</span>
              </label>
              <div className="hint" style={{ marginTop: 4 }}>
                {form.isActive
                  ? 'Staffers can register manual products right now.'
                  : 'Turned off — no new manual products can be registered until this is switched back on.'}
              </div>
            </div>
            <button className="btn primary" disabled={busy} onClick={saveSettings}>{busy ? 'Saving…' : 'Save settings'}</button>
          </div>
        </div>
      )}

      {/* --- Escalation box --- */}
      <div className="dd-card">
        <div className="dd-card-h" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
          <div className="row" style={{ gap: 11, alignItems: 'center' }}>
            <span className="dd-card-ic"><Icon name="inbox" /></span>
            <div>
              <h3>Escalations {pendingCount > 0 && <span className="ts-badge warn" style={{ marginLeft: 6 }}>{pendingCount} open</span>}</h3>
              <div className="dd-sub" style={{ marginTop: 1 }}>Manual products and pricing changed from the defaults, waiting for an admin to approve, counter, or decline.</div>
            </div>
          </div>
          <div className="esc-seg" role="tablist" aria-label="Filter escalations">
            {FILTERS.map((s) => (
              <button key={s} className={statusFilter === s ? 'on' : ''} onClick={() => setStatusFilter(s)}>
                {s[0].toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {!canDecide && (
          <div className="esc-callout" style={{ marginTop: 6 }}>
            <span className="ic"><Icon name="info" /></span>
            <div>Only an admin or super-admin can approve, decline, or counter-offer an exception. You can watch the queue here.</div>
          </div>
        )}
        {canDecide && !isSuper && (
          <div className="esc-callout" style={{ marginTop: 6 }}>
            <span className="ic"><Icon name="info" /></span>
            <div>You can approve, decline or counter-offer any exception here — except one you requested yourself. Those need another admin.</div>
          </div>
        )}

        {!rows.length && (
          <div className="esc-empty">
            <div className="ic"><Icon name="inboxEmpty" /></div>
            <div style={{ fontWeight: 600, color: 'var(--text)' }}>No {statusFilter === 'all' ? '' : statusFilter} escalations</div>
            <div className="small" style={{ marginTop: 3 }}>Nothing needs a decision in this view.</div>
          </div>
        )}

        <div style={{ marginTop: rows.length ? 14 : 0 }}>
          {rows.map((r) => {
            const s = r.summary || {};
            const ct = r.counter_terms || {};
            const isOpen = r.status === 'pending' || r.status === 'countered';
            const badgeCls = r.status === 'approved' ? 'ok' : (r.status === 'declined' ? 'err' : 'warn');
            const kindLabel = s.kind === 'manual_review'
              ? `${s.program === 'gold' ? 'Gold Standard' : s.program === 'silver' ? 'Silver' : 'Standard'} — manual-review exception`
              : s.kind === 'pricing_override'
                ? `${s.program === 'gold' ? 'Gold Standard' : s.program === 'silver' ? 'Silver' : 'Standard'} — pricing changed from the defaults`
                : 'Manual Program';
            const acqLabel = (s.kind === 'manual_review' || s.kind === 'pricing_override') ? 'As-is LTV' : 'Acq LTV';
            // Per-row decide right (server-computed): an admin may decide any
            // escalation except one they requested; a super-admin may decide all.
            const rowCanDecide = r.canDecide != null ? !!r.canDecide : canDecide;
            return (
              <div key={r.id} ref={(el) => { rowRefs.current[r.id] = el; }}
                className={`esc-row${highlightId === r.id ? ' hl' : ''}`}>
                <div className="esc-row-top">
                  <div className="esc-row-id">
                    <a href={`#/internal/app/${r.application_id}`}><strong>{r.ys_loan_number || 'File'}</strong></a>
                    {' · '}<span className="esc-row-name">{fullNameOf(r)}</span>
                    {r.property_address ? <><span style={{ color: 'var(--text-soft)' }}> · </span><span className="esc-row-addr">{fmtAddr(r.property_address)}</span></> : null}
                  </div>
                  <span className={`ts-badge ${badgeCls}`}>{r.status}</span>
                </div>

                <div className="esc-row-sub">
                  {kindLabel}
                  {' · '}{money(s.totalLoan != null ? s.totalLoan : r.loan_amount)} loan
                  {s.noteRate != null ? ` @ ${fmtRatePct(s.noteRate)}%` : ''}
                  {r.asset_months != null ? ` · ${r.asset_months} month${r.asset_months === 1 ? '' : 's'} liquidity` : ''}
                  {r.requested_by_name ? ` · requested by ${r.requested_by_name}` : (s.requestedByBorrower ? ' · requested by the borrower' : (s.requestedByTpo ? ' · requested by a broker' : ''))}
                </div>

                {Array.isArray(s.manualReasons) && s.manualReasons.length > 0 && (
                  <div className="esc-callout sm">
                    <span className="ic"><Icon name="info" /></span>
                    <div><strong>Why it needs an exception:</strong> {s.manualReasons.join('; ')}</div>
                  </div>
                )}

                {/* WHAT was moved off the company defaults — a reduced rate
                    markup, reduced origination, a discounted or waived fee, an
                    approved effective price (owner-directed 2026-07-27). This is
                    the thing being approved, so it reads before the numbers. */}
                {Array.isArray(s.overrideLines) && s.overrideLines.length > 0 && (
                  <div className="esc-callout sm">
                    <span className="ic"><Icon name="info" /></span>
                    <div>
                      <strong>Changed from the company defaults:</strong>
                      <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
                        {s.overrideLines.map((line, i) => <li key={i} style={{ color: '#141B22' }}>{line}</li>)}
                      </ul>
                    </div>
                  </div>
                )}

                <div className="esc-metrics">
                  <div className="esc-metric"><span className="k">{acqLabel}</span><span className="v">{pctOf(s.acqLtvPct)}</span></div>
                  <div className="esc-metric"><span className="k">ARV LTV</span><span className="v">{pctOf(s.arvPct)}</span></div>
                  <div className="esc-metric"><span className="k">LTC</span><span className="v">{pctOf(s.ltcPct)}</span></div>
                </div>

                {/* Owner-directed 2026-07-22: the approval must state whether the
                    3-month minimum earned interest is still on (its default for a
                    manual product) or was turned off, plus the accrual type. */}
                {(s.minInterest != null || s.accrual) && (
                  <div className="esc-pills">
                    {s.minInterest != null && (
                      <span className={`esc-tag${s.minInterest ? ' ok' : ''}`}>
                        <span className="dot" />
                        3-month minimum interest: {s.minInterest ? 'ON' : 'OFF'}
                        {s.minInterestDefault != null ? (s.minInterest === s.minInterestDefault ? ' (default)' : ' (changed)') : ''}
                      </span>
                    )}
                    {s.accrual && (
                      <span className="esc-tag">Accrual: {s.accrual === 'dutch' ? 'Dutch / Full-Boat' : 'Non-Dutch / As-Drawn'}</span>
                    )}
                  </div>
                )}

                {/* If a counter has been proposed, show it — everyone (super-admin + admins watching) sees it. */}
                {r.status === 'countered' && (
                  <div className="esc-counter">
                    <div className="small" style={{ fontWeight: 700, color: 'var(--text)' }}>Counter-offer{r.countered_by ? ' — awaiting the loan officer' : ''}</div>
                    {r.counter_note && <div className="small" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{r.counter_note}</div>}
                    {Object.keys(ct).length > 0 && (
                      <div className="muted small" style={{ marginTop: 6 }}>
                        Proposed:{' '}
                        {ct.maxAcqLtv != null && <span>as-is LTV {(ct.maxAcqLtv * 100).toFixed(2)}% · </span>}
                        {ct.maxArvLtv != null && <span>ARV LTV {(ct.maxArvLtv * 100).toFixed(2)}% · </span>}
                        {ct.maxLtc    != null && <span>LTC {(ct.maxLtc * 100).toFixed(2)}% · </span>}
                        {ct.noteRate  != null && <span>rate {fmtRatePct(ct.noteRate)}% · </span>}
                        {ct.origPct   != null && <span>origination {(ct.origPct * 100).toFixed(2)}% · </span>}
                        {ct.loanAmount != null && <span>loan {money(ct.loanAmount)} · </span>}
                      </div>
                    )}
                  </div>
                )}

                {isOpen && rowCanDecide && countering !== r.id && (
                  <div className="esc-actions">
                    <input className="input" style={{ flex: 1, minWidth: 180 }} placeholder="Decision note (optional)"
                      value={notes[r.id] || ''} onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))} />
                    <button className="btn primary small" disabled={busy} onClick={() => decide(r.id, 'approved')}>Approve</button>
                    <button className="btn ghost small" disabled={busy} onClick={() => openCounter(r.id)}>Counter-offer</button>
                    <button className="btn ghost small" disabled={busy} onClick={() => decide(r.id, 'declined')}>Decline</button>
                  </div>
                )}

                {isOpen && rowCanDecide && countering === r.id && (
                  <div className="esc-counter-form">
                    <div className="small" style={{ fontWeight: 700, marginBottom: 6, color: 'var(--text)' }}>Counter-offer — what would you accept?</div>
                    <div className="muted small" style={{ marginBottom: 8 }}>
                      Write the terms plainly in the note (the loan officer sees this verbatim). Optionally fill any of the numbers below — leave blank if the current registered value stands. Enter LTV / LTC / rate / origination as PERCENTS (e.g. 92.5, 11.25, 1.5). Loan amount is a dollar number.
                    </div>
                    <textarea className="input" rows={3} placeholder="e.g. I'll approve at 92.5% LTC (not 91%) if the rate goes up 0.25 to cover the extra risk. Everything else stays." value={counterNote} onChange={(e) => setCounterNote(e.target.value)} style={{ width: '100%' }} />
                    <div className="esc-ceilings" style={{ marginTop: 10 }}>
                      <div className="field" style={{ marginBottom: 0 }}><label>As-is LTV %</label>
                        <input className="input" inputMode="decimal" placeholder="—" value={counterTerms.maxAcqLtv}
                          onChange={(e) => setCT('maxAcqLtv', e.target.value.replace(/[^0-9.]/g, ''))} /></div>
                      <div className="field" style={{ marginBottom: 0 }}><label>ARV LTV %</label>
                        <input className="input" inputMode="decimal" placeholder="—" value={counterTerms.maxArvLtv}
                          onChange={(e) => setCT('maxArvLtv', e.target.value.replace(/[^0-9.]/g, ''))} /></div>
                      <div className="field" style={{ marginBottom: 0 }}><label>LTC %</label>
                        <input className="input" inputMode="decimal" placeholder="—" value={counterTerms.maxLtc}
                          onChange={(e) => setCT('maxLtc', e.target.value.replace(/[^0-9.]/g, ''))} /></div>
                      <div className="field" style={{ marginBottom: 0 }}><label>Note rate %</label>
                        <input className="input" inputMode="decimal" placeholder="—" value={counterTerms.noteRate}
                          onChange={(e) => setCT('noteRate', e.target.value.replace(/[^0-9.]/g, ''))} /></div>
                      <div className="field" style={{ marginBottom: 0 }}><label>Origination %</label>
                        <input className="input" inputMode="decimal" placeholder="—" value={counterTerms.origPct}
                          onChange={(e) => setCT('origPct', e.target.value.replace(/[^0-9.]/g, ''))} /></div>
                      <div className="field" style={{ marginBottom: 0 }}><label>Total loan $</label>
                        <input className="input" inputMode="numeric" placeholder="—" value={counterTerms.loanAmount}
                          onChange={(e) => setCT('loanAmount', e.target.value.replace(/[^0-9]/g, ''))} /></div>
                    </div>
                    <div className="row" style={{ gap: 8, marginTop: 12 }}>
                      <button className="btn primary small" disabled={busy || !counterNote.trim()} onClick={() => submitCounter(r.id)}>Send counter-offer</button>
                      <button className="btn ghost small" onClick={() => { setCountering(null); setCounterNote(''); }}>Cancel</button>
                    </div>
                  </div>
                )}

                {(r.status === 'approved' || r.status === 'declined') && (
                  <div className="muted small" style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ color: r.status === 'approved' ? 'var(--success)' : 'var(--danger)', display: 'inline-flex' }}>
                      {r.status === 'approved' ? <Icon name="check" /> : null}
                    </span>
                    <span>
                      {r.status === 'approved' ? 'Approved' : 'Declined'}{r.decided_by_name ? ` by ${r.decided_by_name}` : ''}
                      {r.decision_note ? ` — ${r.decision_note}` : ''}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
