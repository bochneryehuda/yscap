import React, { useState } from 'react';
import { api } from '../lib/api.js';
import { MoneyInput } from './FormattedInputs.jsx';
import { US_STATES } from './LlcManager.jsx';
import { PROGRAMS, PROPERTY_TYPES, withCurrent } from '../lib/enums.js';

/* Staff edit of the loan-file data after creation — EVERY field the
   application collects is correctable here (typo'd price, wrong property
   type, missed assignment flag, refi economics, address, term, experience…).
   Collapsed by default. Each save writes a field-level before/after diff to
   the audit log, which the file's Activity feed renders verbatim. */

const num = (v) => v == null || v === '' ? '' : String(v);
const REHAB_TYPES = ['Cosmetic', 'Moderate', 'Heavy / gut rehab', 'Adding square footage', 'Ground-up construction'];
const needsSqft = (rehabType) => /square|adding|ground/i.test(rehabType || '');

export default function EditFileDetails({ app, onSaved }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const a = app.property_address || {};
  const [f, setF] = useState({
    program: app.program || '', loanType: app.loan_type || '', propertyType: app.property_type || '',
    units: num(app.units), purchasePrice: num(app.purchase_price), asIsValue: num(app.as_is_value),
    arv: num(app.arv), rehabBudget: num(app.rehab_budget), occupancy: app.occupancy || '',
    rehabType: app.rehab_type || '', sqftPre: num(app.sqft_pre), sqftPost: num(app.sqft_post),
    requestedExpFlips: num(app.requested_exp_flips), requestedExpHolds: num(app.requested_exp_holds),
    requestedExpGround: num(app.requested_exp_ground), requestedExpReo: num(app.requested_exp_reo),
    requestedIrMonths: num(app.requested_ir_months), requestedIrAmount: num(app.requested_ir_amount), term: app.term || '',
    payoffAmount: num(app.payoff_amount), originalPurchasePrice: num(app.original_purchase_price),
    acquisitionDate: app.acquisition_date ? String(app.acquisition_date).slice(0, 10) : '',
    isAssignment: !!app.is_assignment, underlyingContractPrice: num(app.underlying_contract_price), assignmentFee: num(app.assignment_fee),
    addrLine1: a.line1 || a.street || '', addrUnit: a.unit || '', addrCity: a.city || '',
    addrState: (a.state || '').toUpperCase(), addrZip: a.zip || '',
  });
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const isRefi = /refi/i.test(f.loanType || '');

  async function save() {
    setBusy(true); setErr(''); setMsg('');
    try {
      const addrChanged = f.addrLine1 !== (a.line1 || a.street || '') || f.addrUnit !== (a.unit || '')
        || f.addrCity !== (a.city || '') || f.addrState !== ((a.state || '').toUpperCase()) || f.addrZip !== (a.zip || '');
      const body = {
        program: f.program, loanType: f.loanType, propertyType: f.propertyType, occupancy: f.occupancy,
        units: f.units, purchasePrice: f.purchasePrice, asIsValue: f.asIsValue, arv: f.arv, rehabBudget: f.rehabBudget,
        rehabType: f.rehabType, sqftPre: f.sqftPre, sqftPost: f.sqftPost,
        requestedExpFlips: f.requestedExpFlips, requestedExpHolds: f.requestedExpHolds,
        requestedExpGround: f.requestedExpGround, requestedExpReo: f.requestedExpReo,
        requestedIrMonths: f.requestedIrMonths, requestedIrAmount: f.requestedIrAmount, term: f.term,
        payoffAmount: isRefi ? f.payoffAmount : '',
        originalPurchasePrice: isRefi ? f.originalPurchasePrice : '',
        acquisitionDate: isRefi ? f.acquisitionDate : '',
        isAssignment: f.isAssignment,
        underlyingContractPrice: f.isAssignment ? f.underlyingContractPrice : '',
        assignmentFee: f.isAssignment ? Math.max(0, (Number(f.purchasePrice) || 0) - (Number(f.underlyingContractPrice) || 0)) : '',
      };
      if (addrChanged) {
        const line1 = f.addrLine1.trim();
        body.propertyAddress = line1 || f.addrCity ? {
          line1, unit: f.addrUnit.trim() || undefined, city: f.addrCity.trim(),
          state: f.addrState.trim().toUpperCase(), zip: f.addrZip.trim(),
          oneLine: [[line1, f.addrUnit.trim()].filter(Boolean).join(' '), f.addrCity.trim(), [f.addrState.trim().toUpperCase(), f.addrZip.trim()].filter(Boolean).join(' ')].filter(Boolean).join(', '),
        } : null;
      }
      const r = await api.staffEditApplication(app.id, body);
      setMsg(r && r.changed && r.changed.length
        ? `Saved ✓ — ${r.changed.length} field${r.changed.length === 1 ? '' : 's'} changed (logged in Activity).`
        : 'Saved ✓ — no values actually changed.');
      if (onSaved) onSaved();
    } catch (e) { setErr(e.message || 'Could not save'); } finally { setBusy(false); }
  }

  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }} onClick={() => setOpen((o) => !o)}>
        <h3 style={{ margin: 0 }}>Edit application details</h3>
        <span className="muted small" style={{ marginLeft: 'auto', marginRight: 8 }}>Every field is editable — changes are logged</span>
        <span className="muted">{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div style={{ marginTop: 12 }}>
          {err && <div role="alert" className="notice err" style={{ marginBottom: 10 }}>{err}</div>}
          {msg && <div className="notice ok" style={{ marginBottom: 10 }}>{msg}</div>}
          <p className="muted small" style={{ margin: '0 0 8px', textTransform: 'uppercase', letterSpacing: '.05em' }}>Property</p>
          <div className="edit-grid">
            <label className="col-4"><span>Street address</span>
              <input className="input" value={f.addrLine1} onChange={(e) => set('addrLine1', e.target.value)} /></label>
            <label className="col-2"><span>City</span><input className="input" value={f.addrCity} onChange={(e) => set('addrCity', e.target.value)} /></label>
            <label><span>State</span>
              <select className="input" value={f.addrState} onChange={(e) => set('addrState', e.target.value)}>
                <option value="">—</option>{US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
              </select></label>
            <label><span>ZIP</span><input className="input" value={f.addrZip} onChange={(e) => set('addrZip', e.target.value)} /></label>
            <label><span>Apt / Unit</span><input className="input" value={f.addrUnit} onChange={(e) => set('addrUnit', e.target.value)} /></label>
            <label><span>Property type</span>
              <select className="input" value={f.propertyType} onChange={(e) => set('propertyType', e.target.value)}>
                <option value="">—</option>{withCurrent(PROPERTY_TYPES, f.propertyType).map(x => <option key={x} value={x}>{x}</option>)}
              </select></label>
            <label><span>Units</span><input className="input" type="number" min="0" value={f.units} onChange={(e) => set('units', e.target.value)} /></label>
            {/* Occupancy is intentionally NOT shown (owner-directed) — kept in the
                data model and round-tripped unchanged, never surfaced in the UI. */}
          </div>
          <p className="muted small" style={{ margin: '14px 0 8px', textTransform: 'uppercase', letterSpacing: '.05em' }}>Loan &amp; economics</p>
          <div className="edit-grid">
            <label><span>Program</span>
              <select className="input" value={f.program} onChange={(e) => set('program', e.target.value)}>
                <option value="">—</option>{withCurrent(PROGRAMS, f.program).map(x => <option key={x} value={x}>{x}</option>)}
              </select></label>
            <label><span>Loan type</span>
              <select className="input" value={f.loanType} onChange={(e) => set('loanType', e.target.value)}>
                <option value="">—</option><option>Purchase</option><option>Refinance</option>
                <option>Refinance — Rate &amp; Term</option><option>Refinance — Cash-Out</option>
              </select>
            </label>
            <label><span>Purchase price</span><MoneyInput value={f.purchasePrice} onChange={(v) => set('purchasePrice', v)} /></label>
            <label><span>As-is value</span><MoneyInput value={f.asIsValue} onChange={(v) => set('asIsValue', v)} /></label>
            <label><span>ARV</span><MoneyInput value={f.arv} onChange={(v) => set('arv', v)} /></label>
            <label><span>Rehab budget</span><MoneyInput value={f.rehabBudget} onChange={(v) => set('rehabBudget', v)} /></label>
            <label><span>Rehab type</span>
              <select className="input" value={f.rehabType} onChange={(e) => set('rehabType', e.target.value)}>
                <option value="">-</option>{REHAB_TYPES.map(x => <option key={x}>{x}</option>)}
              </select>
            </label>
            <label><span>Term (months)</span><input className="input" value={f.term} onChange={(e) => set('term', e.target.value)} placeholder="e.g. 12" /></label>
            <label><span>Interest reserve (months)</span><input className="input" type="number" min="0" max="24" value={f.requestedIrMonths} onChange={(e) => set('requestedIrMonths', e.target.value)} /></label>
            <label><span>…or interest reserve (exact $)</span><input className="input" type="number" min="0" step="1000" placeholder="blank = size from months" value={f.requestedIrAmount} onChange={(e) => set('requestedIrAmount', e.target.value)} /></label>
            {needsSqft(f.rehabType) && <>
              <label><span>Existing sq ft</span><input className="input" type="number" min="0" value={f.sqftPre} onChange={(e) => set('sqftPre', e.target.value)} /></label>
              <label><span>Completed sq ft</span><input className="input" type="number" min="0" value={f.sqftPost} onChange={(e) => set('sqftPost', e.target.value)} /></label>
            </>}
          </div>
          {isRefi && <>
            <p className="muted small" style={{ margin: '14px 0 8px', textTransform: 'uppercase', letterSpacing: '.05em' }}>Refinance details</p>
            <div className="edit-grid">
              <label><span>Payoff amount</span><MoneyInput value={f.payoffAmount} onChange={(v) => set('payoffAmount', v)} /></label>
              <label><span>Original purchase price</span><MoneyInput value={f.originalPurchasePrice} onChange={(v) => set('originalPurchasePrice', v)} /></label>
              <label className="col-2"><span>Date acquired</span><input className="input" type="date" value={f.acquisitionDate} onChange={(e) => set('acquisitionDate', e.target.value)} /></label>
            </div>
          </>}
          <p className="muted small" style={{ margin: '14px 0 8px', textTransform: 'uppercase', letterSpacing: '.05em' }}>Experience entered on this file</p>
          <div className="edit-grid">
            <label><span>Exp: flips</span><input className="input" type="number" min="0" value={f.requestedExpFlips} onChange={(e) => set('requestedExpFlips', e.target.value)} /></label>
            <label><span>Exp: holds</span><input className="input" type="number" min="0" value={f.requestedExpHolds} onChange={(e) => set('requestedExpHolds', e.target.value)} /></label>
            <label><span>Exp: ground-up</span><input className="input" type="number" min="0" value={f.requestedExpGround} onChange={(e) => set('requestedExpGround', e.target.value)} /></label>
            <label><span>Exp: REO</span><input className="input" type="number" min="0" value={f.requestedExpReo} onChange={(e) => set('requestedExpReo', e.target.value)} /></label>
          </div>
          <div className="edit-grid" style={{ marginTop: 12 }}>
            <label className="col-4" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={f.isAssignment} onChange={(e) => set('isAssignment', e.target.checked)} />
              <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500, fontSize: '14px', color: 'var(--ivory)' }}>This is an assignment purchase</span>
            </label>
            {f.isAssignment && <>
              <label className="col-2"><span>Original (underlying) price</span><MoneyInput value={f.underlyingContractPrice} onChange={(v) => set('underlyingContractPrice', v)} /></label>
              <label className="col-2"><span>Assignment fee (auto)</span>
                <div className="input" style={{ display: 'flex', alignItems: 'center', background: 'var(--soft, #f4f1ea)' }}>
                  ${Math.max(0, (Number(f.purchasePrice) || 0) - (Number(f.underlyingContractPrice) || 0)).toLocaleString('en-US')}
                </div></label>
            </>}
          </div>
          <p className="muted small" style={{ margin: '8px 0 0' }}>Editing the price/ARV/rehab/assignment re-drives the pricing engine when you re-register a product. Every change lands in the file's Activity log with its before/after values.</p>
          <div className="row" style={{ gap: 8, marginTop: 12 }}>
            <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</button>
            <button className="btn link" onClick={() => setOpen(false)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
