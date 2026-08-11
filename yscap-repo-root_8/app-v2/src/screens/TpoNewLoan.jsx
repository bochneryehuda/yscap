import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';

/* Enter a loan — the broker's origination entry point. Collects the borrower,
   the subject property, and the loan basics, then creates a TPO-stamped file
   (the broker becomes the loan officer on it). Pricing / registration comes
   later in its own studio; this just opens the file. */

const LOAN_TYPES = ['Purchase', 'Refinance', 'Cash-Out Refinance', 'Delayed Purchase Financing'];
const PROPERTY_TYPES = ['Single Family', 'Multi 2-4', 'Condo', 'Townhouse', 'Multi 5+', 'Mixed Use'];
const PROGRAMS = ['Standard', 'Gold Standard'];

function isRefi(t) { return /refi/i.test(String(t || '')); }

export default function TpoNewLoan() {
  const nav = useNavigate();
  const [f, setF] = useState({
    firstName: '', lastName: '', email: '', phone: '',
    line1: '', city: '', state: '', zip: '',
    loanType: 'Purchase', propertyType: 'Single Family', program: '',
    purchasePrice: '', asIsValue: '', arv: '', rehabBudget: '',
  });
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const refi = isRefi(f.loanType);

  async function submit() {
    setErr('');
    if (!f.firstName.trim()) return setErr('Enter the borrower\'s first name.');
    if (!f.email.trim()) return setErr('Enter the borrower\'s email.');
    if (!f.line1.trim()) return setErr('Enter the property address.');
    setBusy(true);
    try {
      const body = {
        borrower: { firstName: f.firstName.trim(), lastName: f.lastName.trim(), email: f.email.trim(), phone: f.phone.trim() || undefined },
        propertyAddress: { line1: f.line1.trim(), city: f.city.trim(), state: f.state.trim(), zip: f.zip.trim() },
        loanType: f.loanType,
        propertyType: f.propertyType || undefined,
        program: f.program || undefined,
        asIsValue: f.asIsValue || undefined,
        arv: f.arv || undefined,
        rehabBudget: f.rehabBudget || undefined,
      };
      if (!refi) body.purchasePrice = f.purchasePrice || undefined;
      const r = await api.tpoEnterLoan(body);
      if (r && r.id) nav(`/tpo/file/${r.id}`);
      else nav('/tpo');
    } catch (e) { setErr(e.message || 'Could not create the loan'); }
    finally { setBusy(false); }
  }

  const num = (k, label) => (
    <div className="field"><label>{label}</label>
      <input className="input" inputMode="numeric" value={f[k]} onChange={set(k)} placeholder="$" /></div>
  );

  return (
    <div style={{ maxWidth: 720 }}>
      <div className="page-head" style={{ marginBottom: 18 }}>
        <h1 style={{ margin: 0 }}>Enter a loan</h1>
        <p className="muted small" style={{ marginTop: 6 }}>Start a new file with YS Capital. You'll be the loan officer on it.</p>
      </div>

      {err && <div role="alert" className="notice err" style={{ marginBottom: 14 }}>{err}</div>}

      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 10 }}>Borrower</div>
        <div className="grid cols-2">
          <div className="field"><label>First name</label><input className="input" value={f.firstName} onChange={set('firstName')} autoFocus /></div>
          <div className="field"><label>Last name</label><input className="input" value={f.lastName} onChange={set('lastName')} /></div>
        </div>
        <div className="grid cols-2">
          <div className="field"><label>Email</label><input className="input" type="email" value={f.email} onChange={set('email')} /></div>
          <div className="field"><label>Phone</label><input className="input" value={f.phone} onChange={set('phone')} /></div>
        </div>
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 10 }}>Subject property</div>
        <div className="field"><label>Street address</label><input className="input" value={f.line1} onChange={set('line1')} placeholder="123 Main St" /></div>
        <div className="grid cols-3">
          <div className="field"><label>City</label><input className="input" value={f.city} onChange={set('city')} /></div>
          <div className="field"><label>State</label><input className="input" maxLength={2} value={f.state} onChange={set('state')} placeholder="NJ" /></div>
          <div className="field"><label>ZIP</label><input className="input" value={f.zip} onChange={set('zip')} /></div>
        </div>
        <div className="field"><label>Property type</label>
          <select className="input" value={f.propertyType} onChange={set('propertyType')}>
            {PROPERTY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select></div>
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 10 }}>Loan</div>
        <div className="grid cols-2">
          <div className="field"><label>Loan type</label>
            <select className="input" value={f.loanType} onChange={set('loanType')}>
              {LOAN_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select></div>
          <div className="field"><label>Program (optional)</label>
            <select className="input" value={f.program} onChange={set('program')}>
              <option value="">Decide at pricing</option>
              {PROGRAMS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select></div>
        </div>
        <div className="grid cols-2">
          {refi
            ? num('asIsValue', 'As-is value')
            : num('purchasePrice', 'Purchase price')}
          {refi && num('arv', 'After-repair value (ARV)')}
          {!refi && num('asIsValue', 'As-is value (optional)')}
        </div>
        <div className="grid cols-2">
          {!refi && num('arv', 'After-repair value (ARV)')}
          {num('rehabBudget', 'Rehab budget (optional)')}
        </div>
        {refi && <p className="muted small" style={{ marginTop: 2 }}>A refinance is sized on the as-is value — no purchase price is needed.</p>}
      </div>

      <div className="row" style={{ gap: 12 }}>
        <button className="btn primary" disabled={busy} onClick={submit}>{busy ? 'Creating…' : 'Create loan'}</button>
        <button className="btn ghost" onClick={() => nav('/tpo')}>Cancel</button>
      </div>
    </div>
  );
}
