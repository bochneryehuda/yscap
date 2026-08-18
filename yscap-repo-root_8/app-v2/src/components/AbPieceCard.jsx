import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/* A-PIECE / B-PIECE SPLIT (owner-directed 2026-08-18) — INTERNAL ONLY, on a
   MANUAL-program file: tick the box, type the A-piece dollars, and the B-piece
   shows itself as the rest of the loan (total − A). The B-piece is never
   stored — the server derives it from the CURRENT registration, so a
   re-register moves it on its own. Saving never reopens Products & Pricing and
   never touches the term sheet (the columns sit outside every reopen trigger).
   The card self-hides unless the file is registered MANUAL or already carries
   a split. */
const usd = (n) => (n == null ? '—' : `$${Math.round(Number(n)).toLocaleString('en-US')}`);

export default function AbPieceCard({ appId }) {
  const [data, setData] = useState(null);
  const [enabled, setEnabled] = useState(false);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [savedAt, setSavedAt] = useState(0);

  const load = useCallback(() => api.staffAbPiece(appId).then((d) => {
    setData(d); setEnabled(!!d.enabled);
    setAmount(d.aPiece != null ? String(d.aPiece) : '');
  }).catch(() => setData(null)), [appId]);
  useEffect(() => { load(); }, [load]);

  if (!data || (!data.manual && !data.enabled)) return null;

  const liveA = amount !== '' && Number.isFinite(Number(amount)) ? Number(amount) : null;
  const liveB = enabled && liveA != null && data.totalLoan != null
    ? Math.max(0, Math.round((data.totalLoan - liveA) * 100) / 100) : null;

  const save = async () => {
    setBusy(true); setErr(''); setSavedAt(0);
    try {
      const out = await api.staffAbPieceSave(appId, { enabled, aPieceAmount: enabled && amount !== '' ? Number(amount) : null });
      setData(out); setEnabled(!!out.enabled);
      setAmount(out.aPiece != null ? String(out.aPiece) : '');
      setSavedAt(Date.now());
    } catch (e) {
      setErr((e.data && e.data.error) || e.message || 'Could not save.');
    } finally { setBusy(false); }
  };

  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <div className="row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <b style={{ color: '#141B22' }}>A-piece / B-piece split</b>
        <span className="pill">internal</span>
        <span className="small" style={{ color: '#4B585C', flex: 1 }}>
          How this manual-program loan is sold in two pieces. Nothing here changes the loan,
          the pricing, or the term sheet — it’s our own record.
        </span>
      </div>
      <label className="row" style={{ gap: 8, alignItems: 'center', margin: '10px 0 6px', cursor: 'pointer' }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span style={{ color: '#141B22' }}>This loan is sold as an A-piece / B-piece structure</span>
      </label>
      {enabled && (
        <div className="row" style={{ gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label style={{ display: 'block' }}>
            <span className="small" style={{ display: 'block', color: '#4B585C', marginBottom: 4 }}>A-piece ($)</span>
            <input className="input" style={{ width: 160 }} inputMode="numeric" value={amount}
              placeholder="e.g. 250000" onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} />
          </label>
          <div>
            <span className="small" style={{ display: 'block', color: '#4B585C', marginBottom: 4 }}>B-piece (the rest of the loan)</span>
            <b style={{ color: '#141B22', fontSize: 16 }}>{usd(liveB)}</b>
            {data.totalLoan != null && (
              <span className="small" style={{ color: '#4B585C', marginLeft: 8 }}>of {usd(data.totalLoan)} total</span>
            )}
          </div>
        </div>
      )}
      <div className="row" style={{ gap: 10, alignItems: 'center', marginTop: 10 }}>
        <button className="btn ghost small" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        {savedAt > 0 && <span className="small" style={{ color: '#2F7F86' }}>Saved.</span>}
        {err && <span className="small" role="alert" style={{ color: 'var(--danger)' }}>{err}</span>}
      </div>
    </div>
  );
}
