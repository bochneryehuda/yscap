import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { showMessage, askConfirm, askPrompt } from '../lib/dialog.js';

/* THE RATE-AND-TERM $2,000 CASH WARNING + "Validate closing costs" (owner-directed
 * 2026-08-18). Self-fetching, so it mounts anywhere with just an appId; renders
 * NOTHING unless the file is a rate-&-term refinance whose registered structure
 * hands the borrower more than $2,000 (or has itemized costs to show while open).
 * The red warning is ADVISORY here — the real block is the term-sheet SEND gate
 * (esign/gate.js, code rate_term_cash) — and every way out is on the card:
 * switch to a cash-out (an application-details edit), validate the closing costs
 * (real fees reduce the cash), or request the super-admin exception.
 *
 * Colors are explicit darks per the HARD RULE (never a var(--ink*) token). */

const INK = '#141B22';
const MUTED = '#4B585C';
const usd = (n) => `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

export default function RateTermCashCard({ appId, onChanged }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ kind: 'title_fee', label: '', amount: '', note: '' });
  const [err, setErr] = useState('');

  const load = useCallback(() => api.rateTermGate(appId).then(setData).catch(() => setData(null)), [appId]);
  useEffect(() => { load(); }, [load]);

  if (!data || !data.check) return null;
  const c = data.check;
  // Silent unless this file is a rate-&-term that is over (or has been over and
  // carries validated costs / an approved exception worth still showing).
  const show = c.applies && c.registered && (c.over || (data.items || []).length > 0 || c.exception);
  if (!show) return null;

  const addCost = async () => {
    setErr('');
    const amount = Number(form.amount);
    if (!form.label.trim() || !Number.isFinite(amount)) { setErr('Name the fee and enter a dollar amount.'); return; }
    setBusy(true);
    try {
      const r = await api.closingCostAdd(appId, { kind: form.kind, label: form.label.trim(), amount, note: form.note.trim() || undefined });
      setData((d) => ({ ...d, check: r.check, items: r.items }));
      setForm({ kind: form.kind, label: '', amount: '', note: '' });
      if (onChanged) onChanged();
    } catch (e) { setErr((e && e.message) || 'Could not save the fee.'); }
    finally { setBusy(false); }
  };

  const removeCost = async (id, label) => {
    if (!(await askConfirm(`Remove "${label}" from the validated closing costs?`))) return;
    setBusy(true);
    try {
      const r = await api.closingCostDelete(appId, id);
      setData((d) => ({ ...d, check: r.check, items: r.items }));
      if (onChanged) onChanged();
    } catch (e) { showMessage((e && e.message) || 'Could not remove the fee.'); }
    finally { setBusy(false); }
  };

  const requestException = async () => {
    const note = await askPrompt(
      'Ask a super-admin to approve sending this term sheet even though the rate-&-term hands the borrower more than $2,000. Explain why (they see this):',
      { multiline: true, confirmLabel: 'Send the request' });
    if (note == null || !note.trim()) return;
    setBusy(true);
    try {
      await api.rateTermException(appId, { reason: 'other', note: note.trim() });
      await load();
      showMessage('Sent — a super-admin decides it on the Exceptions screen. The term sheet stays held until it is approved (or the deal is fixed).');
    } catch (e) { showMessage((e && e.message) || 'Could not send the request.'); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ marginTop: 12, border: `1px solid ${c.over && !c.exception ? '#C43D3D' : '#E7E0D4'}`,
      background: c.over && !c.exception ? '#FBEFEE' : '#FFFFFF', borderRadius: 10, padding: '12px 14px' }}>
      {c.over ? (
        <div style={{ color: '#8A1F1F', fontWeight: 700, fontSize: 14.5 }}>
          {c.exception ? 'Rate-&-term cash over $2,000 — super-admin exception APPROVED' : 'Too much cash to the borrower for a rate-&-term'}
        </div>
      ) : (
        <div style={{ color: INK, fontWeight: 700, fontSize: 14.5 }}>Rate-&-term cash check — within the $2,000 limit</div>
      )}
      <div style={{ marginTop: 6, fontSize: 13.5, color: c.over && !c.exception ? '#8A1F1F' : MUTED, lineHeight: 1.5 }}>
        Initial loan {usd(c.initialAdvance)} − payoff {usd(c.payoff)}{c.freeAndClear ? ' (free and clear)' : ''} − closing costs {usd(c.closingCosts)}
        {c.itemizedClosingCosts > 0 ? <> (incl. {usd(c.itemizedClosingCosts)} validated below)</> : null}
        {' '}= <b style={{ color: c.over ? '#8A1F1F' : INK }}>{usd(c.cashToBorrower)} to the borrower</b> · limit {usd(c.limit)}.
        {c.over && !c.exception && <> Switch the transaction to a <b>cash-out</b>, validate the closing costs below, or request a super-admin exception — the term sheet will not send for e-signature until one of those happens.</>}
      </div>

      <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button className="btn btn-sm ghost" onClick={() => setOpen(!open)}>
          {open ? 'Hide the closing costs' : `Validate closing costs${(data.items || []).length ? ` (${data.items.length})` : ''}`}
        </button>
        {c.over && !c.exception && (
          <button className="btn btn-sm ghost" disabled={busy} onClick={requestException}>Request a super-admin exception…</button>
        )}
      </div>

      {open && (
        <div style={{ marginTop: 10, borderTop: '1px solid #E7E0D4', paddingTop: 10 }}>
          <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 8 }}>
            The real closing-statement fees the borrower pays — each one reduces the cash to the borrower, so a deal
            the system mis-costed can come back under the limit and stay a rate-&-term.
          </div>
          {(data.items || []).map((it) => (
            <div key={it.id} className="row" style={{ gap: 8, alignItems: 'baseline', padding: '5px 0', borderBottom: '1px solid #F0EBE1' }}>
              <div style={{ flex: 1, minWidth: 0, color: INK, fontSize: 13.5 }}>
                <b>{it.label}</b>
                <span style={{ color: MUTED }}> — {(data.costKinds || {})[it.kind] || it.kind}{it.note ? ` · ${it.note}` : ''}</span>
              </div>
              <div style={{ fontWeight: 700, color: INK }}>{usd(it.amount)}</div>
              <button className="btn btn-sm ghost" disabled={busy} onClick={() => removeCost(it.id, it.label)}>Remove</button>
            </div>
          ))}
          <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label className="small" style={{ color: MUTED }}>Fee type
              <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} style={{ display: 'block', marginTop: 4 }}>
                {Object.entries(data.costKinds || {}).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <label className="small" style={{ color: MUTED, flex: '1 1 180px' }}>Name
              <input className="input" placeholder='e.g. "Title search", "NY mortgage tax"' value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })} style={{ display: 'block', marginTop: 4, width: '100%' }} />
            </label>
            <label className="small" style={{ color: MUTED }}>Amount $
              <input className="input" style={{ display: 'block', marginTop: 4, maxWidth: 120 }} value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })} />
            </label>
            <button className="btn btn-sm primary" disabled={busy} onClick={addCost}>Add fee</button>
          </div>
          {err && <div className="small" style={{ color: '#8A1F1F', marginTop: 6 }}>{err}</div>}
        </div>
      )}
    </div>
  );
}
