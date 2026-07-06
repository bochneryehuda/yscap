import React, { useState } from 'react';
import { api } from '../lib/api.js';
import { MoneyInput } from './FormattedInputs.jsx';

/* Staff edit of core loan-file data after creation — fix a typo'd price, wrong
   property type, an omitted assignment flag, etc. Collapsed by default. */

const num = (v) => v == null || v === '' ? '' : String(v);
const REHAB_TYPES = ['Cosmetic', 'Moderate', 'Heavy / gut rehab', 'Adding square footage', 'Ground-up construction'];
const needsSqft = (rehabType) => /square|adding|ground/i.test(rehabType || '');

export default function EditFileDetails({ app, onSaved }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [f, setF] = useState({
    program: app.program || '', loanType: app.loan_type || '', propertyType: app.property_type || '',
    units: num(app.units), purchasePrice: num(app.purchase_price), asIsValue: num(app.as_is_value),
    arv: num(app.arv), rehabBudget: num(app.rehab_budget), occupancy: app.occupancy || '',
    rehabType: app.rehab_type || '', sqftPre: num(app.sqft_pre), sqftPost: num(app.sqft_post),
    requestedExpFlips: num(app.requested_exp_flips), requestedExpHolds: num(app.requested_exp_holds), requestedExpGround: num(app.requested_exp_ground),
    isAssignment: !!app.is_assignment, underlyingContractPrice: num(app.underlying_contract_price), assignmentFee: num(app.assignment_fee),
  });
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));

  async function save() {
    setBusy(true); setErr('');
    try {
      const body = {
        program: f.program, loanType: f.loanType, propertyType: f.propertyType, occupancy: f.occupancy,
        units: f.units, purchasePrice: f.purchasePrice, asIsValue: f.asIsValue, arv: f.arv, rehabBudget: f.rehabBudget,
        rehabType: f.rehabType, sqftPre: f.sqftPre, sqftPost: f.sqftPost,
        requestedExpFlips: f.requestedExpFlips, requestedExpHolds: f.requestedExpHolds, requestedExpGround: f.requestedExpGround,
        isAssignment: f.isAssignment,
        underlyingContractPrice: f.isAssignment ? f.underlyingContractPrice : '',
        assignmentFee: f.isAssignment ? f.assignmentFee : '',
      };
      await api.staffEditApplication(app.id, body);
      setOpen(false);
      if (onSaved) onSaved();
    } catch (e) { setErr(e.message || 'Could not save'); } finally { setBusy(false); }
  }

  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }} onClick={() => setOpen((o) => !o)}>
        <h3 style={{ margin: 0 }}>Edit file details</h3>
        <span className="muted">{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div style={{ marginTop: 12 }}>
          {err && <div role="alert" className="notice err" style={{ marginBottom: 10 }}>{err}</div>}
          <div className="ts-inputs">
            <label><span>Program</span><input className="input" value={f.program} onChange={(e) => set('program', e.target.value)} /></label>
            <label><span>Loan type</span>
              <select className="input" value={f.loanType} onChange={(e) => set('loanType', e.target.value)}>
                <option value="">—</option><option>Purchase</option><option>Refinance</option>
              </select>
            </label>
            <label><span>Property type</span><input className="input" value={f.propertyType} onChange={(e) => set('propertyType', e.target.value)} /></label>
            <label><span>Units</span><input className="input" type="number" min="0" value={f.units} onChange={(e) => set('units', e.target.value)} /></label>
            <label><span>Purchase price</span><MoneyInput value={f.purchasePrice} onChange={(v) => set('purchasePrice', v)} /></label>
            <label><span>As-is value</span><MoneyInput value={f.asIsValue} onChange={(v) => set('asIsValue', v)} /></label>
            <label><span>ARV</span><MoneyInput value={f.arv} onChange={(v) => set('arv', v)} /></label>
            <label><span>Rehab budget</span><MoneyInput value={f.rehabBudget} onChange={(v) => set('rehabBudget', v)} /></label>
            <label><span>Rehab type</span>
              <select className="input" value={f.rehabType} onChange={(e) => set('rehabType', e.target.value)}>
                <option value="">-</option>{REHAB_TYPES.map(x => <option key={x}>{x}</option>)}
              </select>
            </label>
            {needsSqft(f.rehabType) && <>
              <label><span>Existing sq ft</span><input className="input" type="number" min="0" value={f.sqftPre} onChange={(e) => set('sqftPre', e.target.value)} /></label>
              <label><span>Completed sq ft</span><input className="input" type="number" min="0" value={f.sqftPost} onChange={(e) => set('sqftPost', e.target.value)} /></label>
            </>}
            <label><span>Exp: flips</span><input className="input" type="number" min="0" value={f.requestedExpFlips} onChange={(e) => set('requestedExpFlips', e.target.value)} /></label>
            <label><span>Exp: holds</span><input className="input" type="number" min="0" value={f.requestedExpHolds} onChange={(e) => set('requestedExpHolds', e.target.value)} /></label>
            <label><span>Exp: ground-up</span><input className="input" type="number" min="0" value={f.requestedExpGround} onChange={(e) => set('requestedExpGround', e.target.value)} /></label>
            <label style={{ gridColumn: '1 / -1', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={f.isAssignment} onChange={(e) => set('isAssignment', e.target.checked)} />
              <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>This is an assignment purchase</span>
            </label>
            {f.isAssignment && <>
              <label><span>Underlying price</span><MoneyInput value={f.underlyingContractPrice} onChange={(v) => set('underlyingContractPrice', v)} /></label>
              <label><span>Assignment fee</span><MoneyInput value={f.assignmentFee} onChange={(v) => set('assignmentFee', v)} /></label>
            </>}
          </div>
          <p className="muted small" style={{ margin: '8px 0 0' }}>Editing the price/ARV/rehab/assignment re-drives the pricing engine when you re-register a product.</p>
          <div className="row" style={{ gap: 8, marginTop: 12 }}>
            <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</button>
            <button className="btn link" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
