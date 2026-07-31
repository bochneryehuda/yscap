import React, { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api.js';
import { MoneyInput } from './FormattedInputs.jsx';
import { moneyNum } from '../lib/money.js';
import { US_STATES } from './LlcManager.jsx';
import { PROGRAMS, PROPERTY_TYPES, LOAN_TYPES, selectOptions, unitsMode, unitsForType } from '../lib/enums.js';
import LlcPicker from './LlcPicker.jsx';
import AddressAutocomplete from './AddressAutocomplete.jsx';
import { goToSection } from './FileSections.jsx';
import { refiKind } from '../lib/payoff.js';

/* Staff edit of the loan-file data after creation — EVERY field the
   application collects is correctable here (typo'd price, wrong property
   type, missed assignment flag, refi economics, address, term, experience…).
   Collapsed by default. Each save writes a field-level before/after diff to
   the audit log, which the file's Activity feed renders verbatim. */

const num = (v) => v == null || v === '' ? '' : String(v);
const REHAB_TYPES = ['Cosmetic', 'Moderate', 'Heavy / gut rehab', 'Adding square footage', 'Ground-up construction'];
const needsSqft = (rehabType) => /square|adding|ground/i.test(rehabType || '');

// Column name -> the wording on this form, so a refusal names the field the
// officer actually sees ("Program") rather than a database column ("program").
const FIELD_LABEL = {
  program: 'Program', loan_type: 'Loan type', property_type: 'Property type', rehab_type: 'Rehab type',
  units: 'Units', purchase_price: 'Purchase price', as_is_value: 'As-is value', arv: 'ARV',
  rehab_budget: 'Rehab budget', term: 'Term (months)', occupancy: 'Occupancy',
  requested_ir_months: 'Interest reserve (months)', requested_ir_amount: 'Interest reserve ($)',
  requested_exp_flips: 'Exp: flips', requested_exp_holds: 'Exp: holds',
  requested_exp_ground: 'Exp: ground-up', requested_exp_reo: 'Exp: REO',
  payoff_amount: 'Payoff amount', original_purchase_price: 'Original purchase price',
  acquisition_date: 'Date acquired', is_assignment: 'Assignment purchase',
  underlying_contract_price: 'Original (underlying) price', assignment_fee: 'Assignment fee',
  sqft_pre: 'Existing sq ft', sqft_post: 'Completed sq ft', property_address: 'Property address',
};
const LABEL = (col) => FIELD_LABEL[col] || col;

/* The form's values, read off the file. Extracted so a save can RE-SYNC the form
   from the server's authoritative row instead of leaving the officer looking at
   what they typed. The old code built this inline in useState, whose initializer
   runs once — so after a save the form kept showing the typed value even when
   the server had stored something else (or the sync had reverted it), and the
   disagreement only showed up on the next full page load. That is a large part
   of why a save that didn't stick looked like it had worked. */
function formFrom(app) {
  const a = (app && app.property_address) || {};
  return {
    program: app.program || '', loanType: app.loan_type || '', propertyType: app.property_type || '',
    units: num(app.units), purchasePrice: num(app.purchase_price), asIsValue: num(app.as_is_value),
    arv: num(app.arv), rehabBudget: num(app.rehab_budget), occupancy: app.occupancy || '',
    llcId: app.llc_id || '', entityName: app.entity_name || '',
    rehabType: app.rehab_type || '', sqftPre: num(app.sqft_pre), sqftPost: num(app.sqft_post),
    requestedExpFlips: num(app.requested_exp_flips), requestedExpHolds: num(app.requested_exp_holds),
    requestedExpGround: num(app.requested_exp_ground), requestedExpReo: num(app.requested_exp_reo),
    requestedIrMonths: num(app.requested_ir_months), requestedIrAmount: num(app.requested_ir_amount), term: app.term || '',
    payoffAmount: num(app.payoff_amount), originalPurchasePrice: num(app.original_purchase_price),
    payoffLender: app.payoff_lender || '', payoffLoanNumber: app.payoff_loan_number || '',
    acquisitionDate: app.acquisition_date ? String(app.acquisition_date).slice(0, 10) : '',
    isAssignment: !!app.is_assignment, underlyingContractPrice: num(app.underlying_contract_price), assignmentFee: num(app.assignment_fee),
    addrLine1: a.line1 || a.street || '', addrUnit: a.unit || '', addrCity: a.city || '',
    addrState: (a.state || '').toUpperCase(), addrZip: a.zip || '',
  };
}

export default function EditFileDetails({ app, onSaved }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [warn, setWarn] = useState('');
  const a = app.property_address || {};
  const [f, setF] = useState(() => formFrom(app));
  // Re-sync the form from the reloaded file — but ONLY straight after the
  // officer's own save, never while they are mid-edit (a background refresh must
  // not wipe what they are typing).
  const resyncPending = useRef(false);
  useEffect(() => {
    if (!resyncPending.current) return;
    resyncPending.current = false;
    setF(formFrom(app));
  }, [app]);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  // Property type drives the units control (single → 1 locked; "Multi 2–4" →
  // 2/3/4 dropdown; "Multi 5+" / "Mixed Use" → free number ≥ 5) — same rule as
  // the borrower application and the new-file form.
  const setPropertyType = (v) => setF((s) => ({ ...s, propertyType: v, units: unitsForType(v, s.units) }));
  // The SHARED reading of the loan purpose (lib/payoff.js), so this form, the
  // Payoff section and the server can never disagree about whether there is a
  // loan to pay off — including on "Delayed Purchase Financing", which is a
  // purchase however it is spelled.
  const isRefi = refiKind(f.loanType) !== 'purchase';
  // The SAVED purpose, as the file screen reads it — that is what decides whether
  // the Payoff section exists, so it is what the pointer button must be gated on.
  const savedIsRefi = refiKind(app.loan_type) !== 'purchase';

  async function save() {
    setBusy(true); setErr(''); setMsg(''); setWarn('');
    try {
      const addrChanged = f.addrLine1 !== (a.line1 || a.street || '') || f.addrUnit !== (a.unit || '')
        || f.addrCity !== (a.city || '') || f.addrState !== ((a.state || '').toUpperCase()) || f.addrZip !== (a.zip || '');
      const body = {
        program: f.program, loanType: f.loanType, propertyType: f.propertyType, occupancy: f.occupancy,
        units: unitsForType(f.propertyType, f.units), purchasePrice: f.purchasePrice, asIsValue: f.asIsValue, arv: f.arv, rehabBudget: f.rehabBudget,
        rehabType: f.rehabType, sqftPre: f.sqftPre, sqftPost: f.sqftPost,
        requestedExpFlips: f.requestedExpFlips, requestedExpHolds: f.requestedExpHolds,
        requestedExpGround: f.requestedExpGround, requestedExpReo: f.requestedExpReo,
        requestedIrMonths: f.requestedIrMonths, requestedIrAmount: f.requestedIrAmount, term: f.term,
        /* THE PAYOFF TRIO IS ONLY EVER CLEARED HERE, NEVER WRITTEN (owner-directed
           2026-07-31). The Payoff section owns entry, so this form must not send
           the values it loaded — a form opened before somebody edited the payoff
           there would save its own stale copy straight back over the fix. It DOES
           still clear all three when the purpose is switched to a purchase, which
           is a cleanup only this form can do: there is no Payoff section to do it
           from once the file stops being a refinance. */
        ...(isRefi ? {} : { payoffAmount: '', payoffLender: '', payoffLoanNumber: '', estimatedCashOut: '' }),
        /* A rate-&-term refinance takes no cash out by definition, so switching the
           purpose off cash-out must clear any cash-out figure the file carries —
           another cleanup the Payoff section cannot do, because it stops offering
           the field the moment the purpose changes. */
        ...(isRefi && refiKind(f.loanType) !== 'cash_out' ? { estimatedCashOut: '' } : {}),
        originalPurchasePrice: isRefi ? f.originalPurchasePrice : '',
        acquisitionDate: isRefi ? f.acquisitionDate : '',
        // Assignment is a purchase concept — never send it on a refinance.
        isAssignment: f.isAssignment && !isRefi,
        underlyingContractPrice: (f.isAssignment && !isRefi) ? f.underlyingContractPrice : '',
        assignmentFee: (f.isAssignment && !isRefi) ? Math.max(0, moneyNum(f.purchasePrice) - moneyNum(f.underlyingContractPrice)) : '',
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
      // Vesting entity (owner-directed 2026-07-20): an LLC change goes through the
      // dedicated vesting endpoint (its own guarded chokepoint that wires the LLC
      // condition + docs). A picked LLC carries an id; a typed-but-new name is
      // created on the borrower first. Best-effort — the field edits already saved.
      try {
        let llcId = f.llcId;
        if (!llcId && f.entityName.trim()) {
          const c = await api.staffCreateLlc(app.borrower_id, { llcName: f.entityName.trim() });
          llcId = c.llcId || c.id;
        }
        if (llcId && String(llcId) !== String(app.llc_id || '')) await api.staffSetVestingLlc(app.id, llcId);
      } catch (_) { /* vesting is best-effort */ }
      // HONEST RESULT (owner-reported 2026-07-27: "the Save button doesn't save
      // anything — at least come up with an error that it's not saving"). A 200
      // is not the same as "your change stuck": the server now re-reads the row
      // and reports which requested fields did NOT land (`refused`) and which
      // saved here but have no matching ClickUp option (`unsynced`). Say so
      // plainly instead of printing "Saved ✓" over a change that didn't happen.
      const refused = (r && r.refused) || [];
      const unsynced = (r && r.unsynced) || [];
      const changedN = ((r && r.changed) || []).length;
      if (refused.length) {
        setErr(`NOT saved — ${refused.map(LABEL).join(', ')} did not change. `
          + 'The file still has its previous value. This is usually a locked file or a value the system refused; '
          + 'the file’s Activity log records what happened. Please tell an admin if it keeps happening.');
      } else {
        setMsg(changedN
          ? `Saved ✓ — ${changedN} field${changedN === 1 ? '' : 's'} changed (logged in Activity).`
          : 'Saved ✓ — no values actually changed (everything already matched).');
      }
      if (unsynced.length) {
        setWarn(`Saved in PILOT, but ClickUp has no matching option for ${unsynced.map((u) => `${u.label} “${u.value}”`).join(', ')}. `
          + 'The file keeps this value and the sync will no longer overwrite it, but the ClickUp card still shows the old one. '
          + 'To make both match, add that option to the ClickUp dropdown.');
      }
      if (onSaved) { resyncPending.current = true; onSaved(); }
    } catch (e) {
      setErr(e.message || 'Could not save — nothing was changed.');
    } finally { setBusy(false); }
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
          {warn && <div className="notice warn" style={{ marginBottom: 10, color: '#141B22' }}>{warn}</div>}
          <p className="muted small" style={{ margin: '0 0 8px', textTransform: 'uppercase', letterSpacing: '.05em' }}>Property</p>
          <div className="edit-grid">
            <label className="col-4"><span>Street address</span>
              <AddressAutocomplete value={f.addrLine1}
                onChange={(v) => set('addrLine1', v)}
                onPick={(addr) => setF((s) => ({ ...s, addrLine1: addr.line1 || '', addrUnit: addr.unit || s.addrUnit || '',
                  addrCity: addr.city || '', addrState: (addr.state || '').toUpperCase(), addrZip: addr.zip || '' }))} /></label>
            <label className="col-2"><span>City</span><input className="input" value={f.addrCity} onChange={(e) => set('addrCity', e.target.value)} /></label>
            <label><span>State</span>
              <select className="input" value={f.addrState} onChange={(e) => set('addrState', e.target.value)}>
                <option value="">—</option>{US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
              </select></label>
            <label><span>ZIP</span><input className="input" value={f.addrZip} onChange={(e) => set('addrZip', e.target.value)} /></label>
            <label><span>Apt / Unit</span><input className="input" value={f.addrUnit} onChange={(e) => set('addrUnit', e.target.value)} /></label>
            <label><span>Property type</span>
              <select className="input" value={f.propertyType} onChange={(e) => setPropertyType(e.target.value)}>
                <option value="">—</option>{selectOptions(PROPERTY_TYPES, f.propertyType).map(x => <option key={x.value} value={x.value}>{x.label}</option>)}
              </select></label>
            {unitsMode(f.propertyType) === 'select24' ? (
              <label><span>Units</span>
                <select className="input" value={f.units || ''} onChange={(e) => set('units', e.target.value)}>
                  <option value="">—</option><option>2</option><option>3</option><option>4</option>
                </select></label>
            ) : unitsMode(f.propertyType) === 'multi' ? (
              <label><span>Units</span><input className="input" type="number" min="5" value={f.units || ''} onChange={(e) => set('units', e.target.value)} placeholder="5 or more" /></label>
            ) : unitsMode(f.propertyType) === 'single' ? (
              <label><span>Units</span><input className="input" value="1 unit" disabled readOnly /></label>
            ) : (
              // 'open' (e.g. New Construction / Commercial from ClickUp) or no type
              // yet: a free, editable count — never locked or forced to 1.
              <label><span>Units</span><input className="input" type="number" min="0" value={f.units} onChange={(e) => set('units', e.target.value)} /></label>
            )}
            <label className="col-4"><span>Vesting entity / LLC</span>
              <LlcPicker value={f.entityName} staff borrowerId={app.borrower_id}
                placeholder="Which LLC is this property purchased under?"
                onPick={({ id, name }) => setF((s) => ({ ...s, entityName: name, llcId: id || '' }))} />
            </label>
            {/* Occupancy is intentionally NOT shown (owner-directed) — kept in the
                data model and round-tripped unchanged, never surfaced in the UI. */}
          </div>
          <p className="muted small" style={{ margin: '14px 0 8px', textTransform: 'uppercase', letterSpacing: '.05em' }}>Loan &amp; economics</p>
          <div className="edit-grid">
            <label><span>Program</span>
              <select className="input" value={f.program} onChange={(e) => set('program', e.target.value)}>
                <option value="">—</option>{selectOptions(PROGRAMS, f.program).map(x => <option key={x.value} value={x.value}>{x.label}</option>)}
              </select></label>
            <label><span>Loan type</span>
              <select className="input" value={f.loanType} onChange={(e) => set('loanType', e.target.value)}>
                <option value="">—</option>{selectOptions(LOAN_TYPES, f.loanType).map(x => <option key={x.value} value={x.value}>{x.label}</option>)}
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
              <label><span>Original purchase price</span><MoneyInput value={f.originalPurchasePrice} onChange={(v) => set('originalPurchasePrice', v)} /></label>
              <label><span>Date acquired</span><input className="input" type="date" value={f.acquisitionDate} onChange={(e) => set('acquisitionDate', e.target.value)} /></label>
            </div>
            {/* THE PAYOFF HAS ITS OWN SECTION (owner-directed 2026-07-31), so it is
                NOT edited here as well. Two editors for the same three fields on one
                page is worse than one — the same reason the note buyer's second
                editor was retired to a read-only line. This says where they live and
                shows what is on the file, and nothing more. */}
            <div style={{ margin: '10px 0 0', padding: '10px 12px', background: 'var(--soft,#FAF8F3)', borderRadius: 8 }}>
              <div style={{ fontSize: 13.5, color: '#141B22' }}>
                <b>Payoff:</b>{' '}
                {f.payoffAmount ? `$${Number(moneyNum(f.payoffAmount)).toLocaleString('en-US')}` : 'not entered'}
                {f.payoffLender ? ` to ${f.payoffLender}` : ''}
                {f.payoffLoanNumber ? ` (loan #${f.payoffLoanNumber})` : ''}
              </div>
              <div style={{ marginTop: 4, fontSize: 13, color: '#4B585C' }}>
                The payoff has its own section on this file — how much, who holds the loan, their loan
                number, and what the borrower walks away with on a cash-out.{' '}
                {/* The BUTTON is gated on the SAVED loan purpose, not the one being
                    typed. The Payoff section only exists once the file is really a
                    refinance, so on a purchase whose dropdown was just switched (and
                    not yet saved) this button would scroll to a section that isn't
                    there and silently do nothing. It says "save first" instead. */}
                {savedIsRefi
                  ? <button type="button" className="btn ghost small" style={{ marginLeft: 4 }}
                      onClick={() => goToSection('sec-payoff')}>Open the Payoff section</button>
                  : <em>Save this change first and the Payoff section appears on the file.</em>}
              </div>
            </div>
          </>}
          <p className="muted small" style={{ margin: '14px 0 8px', textTransform: 'uppercase', letterSpacing: '.05em' }}>Experience entered on this file</p>
          <div className="edit-grid">
            <label><span>Exp: flips</span><input className="input" type="number" min="0" value={f.requestedExpFlips} onChange={(e) => set('requestedExpFlips', e.target.value)} /></label>
            <label><span>Exp: holds</span><input className="input" type="number" min="0" value={f.requestedExpHolds} onChange={(e) => set('requestedExpHolds', e.target.value)} /></label>
            <label><span>Exp: ground-up</span><input className="input" type="number" min="0" value={f.requestedExpGround} onChange={(e) => set('requestedExpGround', e.target.value)} /></label>
            <label><span>Exp: REO</span><input className="input" type="number" min="0" value={f.requestedExpReo} onChange={(e) => set('requestedExpReo', e.target.value)} /></label>
          </div>
          {/* Assignment of contract is a purchase concept — hide it on a refinance. */}
          {!isRefi && (
          <div className="edit-grid" style={{ marginTop: 12 }}>
            <label className="col-4" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={f.isAssignment} onChange={(e) => set('isAssignment', e.target.checked)} />
              <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500, fontSize: '14px', color: 'var(--ivory)' }}>This is an assignment purchase</span>
            </label>
            {f.isAssignment && <>
              <label className="col-2"><span>Original (underlying) price</span><MoneyInput value={f.underlyingContractPrice} onChange={(v) => set('underlyingContractPrice', v)} /></label>
              <label className="col-2"><span>Assignment fee (auto)</span>
                <div className="input" style={{ display: 'flex', alignItems: 'center', background: 'var(--soft, #f4f1ea)' }}>
                  ${Math.max(0, moneyNum(f.purchasePrice) - moneyNum(f.underlyingContractPrice)).toLocaleString('en-US')}
                </div></label>
            </>}
          </div>
          )}
          <p className="muted small" style={{ margin: '8px 0 0' }}>Editing the price/ARV/rehab/assignment re-drives the pricing engine when you re-register a product. Every change lands in the file's Activity log with its before/after values.</p>
          {/* The result belongs NEXT TO the button that produced it. This form is
              long enough that the notice at the top of the panel is off-screen by
              the time you reach Save, so a refused save (a locked file, a bad
              date, a duplicate) read as "nothing happened" — owner-reported
              2026-07-27. Same state, rendered where the click was. */}
          {err && <div role="alert" className="notice err" style={{ marginTop: 12 }}>{err}</div>}
          {msg && <div className="notice ok" style={{ marginTop: 12 }}>{msg}</div>}
          {warn && <div className="notice warn" style={{ marginTop: 12, color: '#141B22' }}>{warn}</div>}
          <div className="row" style={{ gap: 8, marginTop: 12 }}>
            <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</button>
            <button className="btn link" onClick={() => setOpen(false)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
