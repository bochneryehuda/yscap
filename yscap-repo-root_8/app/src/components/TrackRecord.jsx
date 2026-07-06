import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { MoneyInput } from './FormattedInputs.jsx';
import LlcPicker from './LlcPicker.jsx';

/* Investment track record (prior deals = experience). Drives the pricing tier:
   verified deals count toward the borrower's experience tier on the frozen
   engines. Two modes:
     mode="borrower" — the borrower adds/removes their own (unverified) deals.
     mode="staff"    — staff review the record and verify each deal (locking it
                       as underwriting evidence and bumping the tier). */

const DEAL_TYPES = [
  { v: 'flip', label: 'Fix & Flip' },
  { v: 'fix-and-hold', label: 'Fix & Hold' },
  { v: 'ground-up', label: 'Ground-Up' },
  { v: 'rental', label: 'Rental' },
];
const DEAL_LABEL = Object.fromEntries(DEAL_TYPES.map((d) => [d.v, d.label]));
const money = (n) => n == null || n === '' ? '—' : '$' + Math.round(Number(n)).toLocaleString('en-US');
const year = (d) => d ? String(d).slice(0, 4) : '';
const addrOf = (a) => !a ? '—' : (a.oneLine || [a.line1 || a.street, a.city, a.state].filter(Boolean).join(', ') || '—');

const blank = () => ({
  dealType: 'flip', entityName: '', llcId: null, address: '',
  purchasePrice: '', salePrice: '', rehabAmount: '', purchaseDate: '', saleDate: '',
  rentAmount: '', rentDate: '', refiAmount: '', refiDate: '', currentValue: '', notes: '',
});
const num = (v) => Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')) || 0;
const isHoldType = (type) => /hold|rental/i.test(type || '');
const isGroundType = (type) => /ground/i.test(type || '');
const bucketOf = (type) => {
  const s = String(type || '').toLowerCase();
  if (s.includes('ground')) return 'ground';
  if (s.includes('flip')) return 'flips';
  return 'holds';
};
function countRows(rows) {
  const c = { flips: 0, holds: 0, ground: 0 };
  for (const r of rows || []) c[bucketOf(r.deal_type)] += 1;
  return c;
}
function meets(counts, req) {
  req = req || {};
  return (counts.flips || 0) >= (Number(req.flips) || 0)
    && (counts.holds || 0) >= (Number(req.holds) || 0)
    && (counts.ground || 0) >= (Number(req.ground) || 0);
}

export default function TrackRecord({ mode = 'borrower', borrowerId, onChange, bare = false, requirement }) {
  const staff = mode === 'staff';
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [f, setF] = useState(blank());
  const [busy, setBusy] = useState(false);

  const load = () => (staff ? api.staffBorrowerTrackRecords(borrowerId) : api.trackRecords())
    .then((r) => setRows(r || [])).catch((e) => setErr(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [borrowerId, mode]);

  async function add() {
    setBusy(true); setErr('');
    try {
      const hold = isHoldType(f.dealType);
      const ground = isGroundType(f.dealType);
      if (!f.address.trim()) throw new Error('Property address is required.');
      if (!num(f.purchasePrice)) throw new Error('Purchase price is required.');
      if (!f.purchaseDate) throw new Error('Purchase date is required.');
      if (!num(f.rehabAmount)) throw new Error('Rehab budget is required.');
      if (!hold && !ground && (!num(f.salePrice) || !f.saleDate)) throw new Error('Sale price and sale date are required for a fix-and-flip deal.');
      if (hold && (!num(f.rentAmount) && !num(f.refiAmount))) throw new Error('Monthly rent or refinance amount is required for a fix-and-hold deal.');
      if (hold && (!f.rentDate && !f.refiDate)) throw new Error('Rent date or refinance date is required for a fix-and-hold deal.');
      if (ground && !((num(f.salePrice) && f.saleDate) || (num(f.rentAmount) && f.rentDate) || (num(f.refiAmount) && f.refiDate))) throw new Error('Ground-up experience needs a sale, rent, or refinance exit.');
      await api.addTrackRecord({
        dealType: f.dealType, llcId: f.llcId || undefined,
        propertyAddress: f.address ? { oneLine: f.address } : undefined,
        purchasePrice: f.purchasePrice || undefined, salePrice: f.salePrice || undefined,
        rehabAmount: f.rehabAmount || undefined,
        purchaseDate: f.purchaseDate || undefined, saleDate: f.saleDate || undefined,
        rentAmount: f.rentAmount || undefined, rentDate: f.rentDate || undefined,
        refiAmount: f.refiAmount || undefined, refiDate: f.refiDate || undefined,
        currentValue: f.currentValue || undefined, notes: f.notes || undefined,
      });
      setF(blank()); setShowAdd(false); await load(); onChange && onChange();
    } catch (e) { setErr(e.message || 'Could not add'); } finally { setBusy(false); }
  }
  async function del(id) {
    if (!window.confirm('Remove this deal from your track record?')) return;
    try { await api.deleteTrackRecord(id); await load(); onChange && onChange(); }
    catch (e) { setErr(e.message || 'Could not remove'); }
  }
  async function verify(id) {
    try { await api.staffVerifyTrackRecord(id); await load(); onChange && onChange(); }
    catch (e) { setErr(e.message || 'Could not verify'); }
  }

  const verifiedCount = (rows || []).filter((r) => r.is_verified).length;
  const counts = countRows(rows || []);
  const required = requirement || {};
  const hasReq = (Number(required.flips) || 0) + (Number(required.holds) || 0) + (Number(required.ground) || 0) > 0;
  const reqMet = !hasReq || meets(counts, required);
  const byType = DEAL_TYPES.map((d) => ({ ...d, n: (rows || []).filter((r) => (r.deal_type || '') === d.v).length })).filter((d) => d.n);

  const body = (
    <>
      {err && <div className="notice err" style={{ marginBottom: 10 }}>{err}</div>}

      {rows && rows.length > 0 && (
        <p className="muted small" style={{ margin: '0 0 10px' }}>
          {rows.length} deal{rows.length === 1 ? '' : 's'}{verifiedCount ? ` · ${verifiedCount} verified` : ''}
          {byType.length ? ' · ' + byType.map((d) => `${d.n} ${d.label.toLowerCase()}`).join(' · ') : ''}
        </p>
      )}

      {hasReq && (
        <div className={`notice ${reqMet ? 'ok' : 'err'}`} style={{ marginBottom: 10 }}>
          File requirement: {counts.flips}/{required.flips || 0} flips, {counts.holds}/{required.holds || 0} holds, {counts.ground}/{required.ground || 0} ground-up.
          {reqMet ? ' This task is ready for your file.' : ' Add the missing matching experience to clear this task.'}
        </div>
      )}

      {rows == null ? <p className="muted small">Loading…</p>
        : rows.length === 0 ? <p className="muted small">No prior deals recorded yet. {staff ? '' : 'Add your completed projects — verified deals improve your pricing tier.'}</p>
          : (
            <div className="tr-list">
              {rows.map((r) => (
                <div key={r.id} className="tr-row">
                  <div className="tr-main">
                    <span className="tr-type">{DEAL_LABEL[r.deal_type] || r.deal_type || 'Deal'}</span>
                    <span className="tr-addr">{addrOf(r.property_address)}</span>
                    {r.entity_name && <span className="muted small">{r.entity_name}</span>}
                  </div>
                  <div className="tr-nums muted small">
                    {money(r.purchase_price)} -> {r.sale_price ? money(r.sale_price) : (r.rent_amount ? `${money(r.rent_amount)}/mo` : (r.refi_amount ? `refi ${money(r.refi_amount)}` : 'exit'))}
                    {r.rehab_amount ? ` · rehab ${money(r.rehab_amount)}` : ''}
                    {year(r.sale_date || r.rent_date || r.refi_date) ? ` · ${year(r.sale_date || r.rent_date || r.refi_date)}` : ''}
                  </div>
                  <div className="tr-act">
                    <span className={`ts-badge ${r.is_verified ? 'ok' : 'warn'}`}>{r.is_verified ? 'Verified' : 'Unverified'}</span>
                    {staff && !r.is_verified && <button className="btn ghost small" onClick={() => verify(r.id)}>Verify</button>}
                    {!staff && !r.is_verified && <button className="btn link small" onClick={() => del(r.id)}>Remove</button>}
                  </div>
                </div>
              ))}
            </div>
          )}

      {!staff && !showAdd && <button className="btn ghost small" style={{ marginTop: 10 }} onClick={() => setShowAdd(true)}>+ Add a deal</button>}

      {!staff && showAdd && (
        <div className="tr-add">
          <div className="ts-inputs">
            <label><span>Deal type</span>
              <select className="input" value={f.dealType} onChange={(e) => setF({ ...f, dealType: e.target.value })}>
                {DEAL_TYPES.map((d) => <option key={d.v} value={d.v}>{d.label}</option>)}
              </select>
            </label>
            <label style={{ gridColumn: '1 / -1' }}><span>Entity / LLC (optional)</span>
              <LlcPicker value={f.entityName} placeholder="Which entity held this deal?"
                onPick={(l) => setF({ ...f, entityName: l.name, llcId: l.id })} />
            </label>
            <label style={{ gridColumn: '1 / -1' }}><span>Property address</span>
              <input className="input" value={f.address} placeholder="123 Main St, City, ST" onChange={(e) => setF({ ...f, address: e.target.value })} />
            </label>
            <label><span>Purchase price</span><MoneyInput value={f.purchasePrice} onChange={(v) => setF({ ...f, purchasePrice: v })} /></label>
            <label><span>Rehab amount</span><MoneyInput value={f.rehabAmount} onChange={(v) => setF({ ...f, rehabAmount: v })} /></label>
            <label><span>Purchase date</span><input className="input" type="date" value={f.purchaseDate} onChange={(e) => setF({ ...f, purchaseDate: e.target.value })} /></label>
            {!isHoldType(f.dealType) && <>
              <label><span>Sale price</span><MoneyInput value={f.salePrice} onChange={(v) => setF({ ...f, salePrice: v })} /></label>
              <label><span>Sale date</span><input className="input" type="date" value={f.saleDate} onChange={(e) => setF({ ...f, saleDate: e.target.value })} /></label>
            </>}
            {(isHoldType(f.dealType) || isGroundType(f.dealType)) && <>
              <label><span>Monthly rent</span><MoneyInput value={f.rentAmount} onChange={(v) => setF({ ...f, rentAmount: v })} /></label>
              <label><span>Rent / stabilized date</span><input className="input" type="date" value={f.rentDate} onChange={(e) => setF({ ...f, rentDate: e.target.value })} /></label>
              <label><span>Refinance amount</span><MoneyInput value={f.refiAmount} onChange={(v) => setF({ ...f, refiAmount: v })} /></label>
              <label><span>Refinance date</span><input className="input" type="date" value={f.refiDate} onChange={(e) => setF({ ...f, refiDate: e.target.value })} /></label>
              <label><span>Current value</span><MoneyInput value={f.currentValue} onChange={(v) => setF({ ...f, currentValue: v })} /></label>
            </>}
            <label style={{ gridColumn: '1 / -1' }}><span>Notes</span>
              <input className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Optional context for underwriting" />
            </label>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <button className="btn primary" disabled={busy} onClick={add}>{busy ? 'Saving…' : 'Save deal'}</button>
            <button className="btn link" onClick={() => { setShowAdd(false); setF(blank()); }}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );

  if (bare) return body;
  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <h3 style={{ marginBottom: 10 }}>Track record{staff ? '' : ' & experience'}</h3>
      {body}
    </div>
  );
}
