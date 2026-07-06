import React, { useState } from 'react';
import { api } from '../lib/api.js';
import { MoneyInput } from './FormattedInputs.jsx';

/* Staff edit of core loan-file data after creation — fix a typo'd price, wrong
   property type, an omitted assignment flag, etc. Collapsed by default. */

const num = (v) => v == null || v === '' ? '' : String(v);

export default function EditFileDetails({ app, onSaved }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [f, setF] = useState({
    program: app.program || '', loanType: app.loan_type || '', propertyType: app.property_type || '',
    units: num(app.units), purchasePrice: num(app.purchase_price), asIsValue: num(app.as_is_value),
    arv: num(app.arv), rehabBudget: num(app.rehab_budget), occupancy: app.occupancy || '',
    isAssignment: !!app.is_assignment, underlyingContractPrice: num(app.underlying_contract_price), assignmentFee: num(app.assignment_fee),
  });
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));

  async function save() {
    setBusy(true); setErr('');
    try {
      const body = {
        program: f.program, loanType: f.loanType, propertyType: f.propertyType, occupancy: f.occupancy,
        units: f.units, purchasePrice: f.purchasePrice, asIsValue: f.asIsValue, arv: f.arv, rehabBudget: f.rehabBudget,
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
          {err && <div className="notice err" style={{ marginBottom: 10 }}>{err}</div>}
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
