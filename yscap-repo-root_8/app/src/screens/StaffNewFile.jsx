import React, { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import AddressAutocomplete from '../components/AddressAutocomplete.jsx';
import { MoneyInput } from '../components/FormattedInputs.jsx';

/* Staff-side file origination. An admin, loan officer, or operations user opens
   a mortgage file from their end — the borrower does NOT need to be signed up.
   We match-or-create the borrower by email, create the application + checklist,
   assign the team, and (optionally) invite the borrower to the portal for this
   specific file right away. */

const PROGRAMS = ['Fix & Flip w/ Construction', 'Bridge', 'Ground Up Construction', 'DSCR Rental', 'Not sure yet'];
const LOAN_TYPES = ['Purchase', 'Refinance — Rate & Term', 'Refinance — Cash-Out', 'Ground up'];
const PROP_TYPES = ['SFR (1 unit)', 'Multi 2–4', 'Multi 5+', 'Condo', 'Townhouse', 'Mixed use'];

const REHAB_TYPES = ['Cosmetic', 'Moderate', 'Heavy / gut rehab', 'Adding square footage', 'Ground-up construction'];
const needsSqft = (rehabType) => /square|adding|ground/i.test(rehabType || '');

const numOrNull = (v) => (v === '' || v == null) ? null : Number(String(v).replace(/[^0-9.]/g, '')) || null;

export default function StaffNewFile() {
  const nav = useNavigate();
  const { role } = useAuth();
  const seesAll = ['admin', 'super_admin', 'underwriter'].includes(role);
  const [team, setTeam] = useState([]);
  const [f, setF] = useState({
    firstName: '', lastName: '', email: '', phone: '',
    program: '', loanType: '', propertyType: '', units: '',
    purchasePrice: '', asIsValue: '', arv: '', rehabBudget: '', rehabType: '', sqftPre: '', sqftPost: '',
    requestedExpFlips: '', requestedExpHolds: '', requestedExpGround: '',
    loanOfficerId: '', processorId: '', inviteBorrower: true,
  });
  const [addr, setAddr] = useState({ street: '', unit: '', city: '', state: '', zip: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { api.staffTeam().then(setTeam).catch(() => {}); }, []);

  const set = (k, v) => setF(s => ({ ...s, [k]: v }));
  const setA = (k, v) => setAddr(s => ({ ...s, [k]: v }));
  const pickAddr = (a) => setAddr(s => ({
    ...s, street: a.line1 || s.street, unit: a.unit || s.unit,
    city: a.city || s.city, state: a.state || s.state, zip: a.zip || s.zip,
  }));

  const officers = team.filter(m => ['loan_officer', 'admin', 'super_admin'].includes(m.role));
  const processors = team.filter(m => m.role === 'processor');

  function buildAddress() {
    const oneLine = [
      [addr.street, addr.unit].filter(Boolean).join(' '),
      addr.city,
      [addr.state, addr.zip].filter(Boolean).join(' '),
    ].filter(Boolean).join(', ');
    return { line1: addr.street || '', street: addr.street || '', unit: addr.unit || '',
             city: addr.city || '', state: addr.state || '', zip: addr.zip || '', oneLine };
  }

  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (!f.firstName.trim()) return setErr('Borrower first name is required.');
    if (!f.email.trim()) return setErr('Borrower email is required.');
    if (!addr.street.trim() && !addr.city.trim()) return setErr('Enter the property address.');
    setBusy(true);
    try {
      const body = {
        borrower: { firstName: f.firstName.trim(), lastName: f.lastName.trim(), email: f.email.trim(), phone: f.phone.trim() || undefined },
        propertyAddress: buildAddress(),
        propertyType: f.propertyType || undefined,
        units: f.units ? Number(f.units) : undefined,
        program: f.program || undefined,
        loanType: f.loanType || undefined,
        purchasePrice: numOrNull(f.purchasePrice),
        asIsValue: numOrNull(f.asIsValue),
        arv: numOrNull(f.arv),
        rehabBudget: numOrNull(f.rehabBudget),
        rehabType: f.rehabType || undefined,
        sqftPre: f.sqftPre ? Number(f.sqftPre) : undefined,
        sqftPost: f.sqftPost ? Number(f.sqftPost) : undefined,
        requestedExpFlips: f.requestedExpFlips ? Number(f.requestedExpFlips) : 0,
        requestedExpHolds: f.requestedExpHolds ? Number(f.requestedExpHolds) : 0,
        requestedExpGround: f.requestedExpGround ? Number(f.requestedExpGround) : 0,
        loanOfficerId: f.loanOfficerId || undefined,
        processorId: f.processorId || undefined,
        inviteBorrower: !!f.inviteBorrower,
      };
      const r = await api.staffCreateFile(body);
      nav(`/internal/app/${r.applicationId}`);
    } catch (e2) {
      setErr(e2.message || 'Could not create the file.');
      setBusy(false);
    }
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <Link to="/internal" className="btn link">← Pipeline</Link>
        <div className="spacer" />
      </div>
      <h1 style={{ marginBottom: 4 }}>New loan file</h1>
      <p className="muted small" style={{ marginBottom: 18 }}>
        Open a file from your side — the borrower doesn't need an account. You can invite them
        to this file at any time; once they join they'll see everything and can message you.
      </p>

      {err && <div className="notice err" style={{ marginBottom: 14 }}>{err}</div>}

      <form onSubmit={submit}>
        <div className="panel" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 12 }}>Borrower</h3>
          <div className="grid cols-2">
            <div className="field"><label>First name *</label>
              <input className="input" value={f.firstName} onChange={e => set('firstName', e.target.value)} required /></div>
            <div className="field"><label>Last name</label>
              <input className="input" value={f.lastName} onChange={e => set('lastName', e.target.value)} /></div>
            <div className="field"><label>Email *</label>
              <input className="input" type="email" value={f.email} onChange={e => set('email', e.target.value)} required
                placeholder="borrower@email.com" /></div>
            <div className="field"><label>Cell phone</label>
              <input className="input" value={f.phone} onChange={e => set('phone', e.target.value)} placeholder="Optional" /></div>
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', marginTop: 4 }}>
            <input type="checkbox" checked={f.inviteBorrower} onChange={e => set('inviteBorrower', e.target.checked)} />
            <span>Email the borrower an invite to join this file now</span>
          </label>
          <p className="muted small" style={{ marginTop: 6 }}>
            If unchecked, you can invite them later from the file. Nothing is sent to them until you do.
          </p>
        </div>

        <div className="panel" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 12 }}>Property</h3>
          <div className="field"><label>Street address</label>
            <AddressAutocomplete value={addr.street} onChange={v => setA('street', v)} onPick={pickAddr}
              placeholder="Start typing the property address…" /></div>
          <div className="grid cols-2">
            <div className="field"><label>Unit / Apt</label>
              <input className="input" value={addr.unit} onChange={e => setA('unit', e.target.value)} placeholder="Optional" /></div>
            <div className="field"><label>City</label>
              <input className="input" value={addr.city} onChange={e => setA('city', e.target.value)} /></div>
            <div className="field"><label>State</label>
              <input className="input" maxLength={2} value={addr.state} onChange={e => setA('state', e.target.value.toUpperCase())} placeholder="NY" /></div>
            <div className="field"><label>ZIP</label>
              <input className="input" value={addr.zip} onChange={e => setA('zip', e.target.value)} /></div>
          </div>
          <div className="grid cols-2">
            <div className="field"><label>Property type</label>
              <select className="input" value={f.propertyType} onChange={e => set('propertyType', e.target.value)}>
                <option value="">Select…</option>{PROP_TYPES.map(p => <option key={p}>{p}</option>)}
              </select></div>
            <div className="field"><label>Units</label>
              <input className="input" type="number" min="1" value={f.units} onChange={e => set('units', e.target.value)} /></div>
          </div>
        </div>

        <div className="panel" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 12 }}>Loan</h3>
          <div className="grid cols-2">
            <div className="field"><label>Program</label>
              <select className="input" value={f.program} onChange={e => set('program', e.target.value)}>
                <option value="">Select…</option>{PROGRAMS.map(p => <option key={p}>{p}</option>)}
              </select></div>
            <div className="field"><label>Loan type</label>
              <select className="input" value={f.loanType} onChange={e => set('loanType', e.target.value)}>
                <option value="">Select…</option>{LOAN_TYPES.map(p => <option key={p}>{p}</option>)}
              </select></div>
            <div className="field"><label>Purchase price</label>
              <MoneyInput value={f.purchasePrice} onChange={v => set('purchasePrice', v)} /></div>
            <div className="field"><label>As-is value</label>
              <MoneyInput value={f.asIsValue} onChange={v => set('asIsValue', v)} /></div>
            <div className="field"><label>ARV</label>
              <MoneyInput value={f.arv} onChange={v => set('arv', v)} /></div>
            <div className="field"><label>Rehab budget</label>
              <MoneyInput value={f.rehabBudget} onChange={v => set('rehabBudget', v)} /></div>
            <div className="field"><label>Rehab type</label>
              <select className="input" value={f.rehabType} onChange={e => set('rehabType', e.target.value)}>
                <option value="">Select...</option>{REHAB_TYPES.map(x => <option key={x}>{x}</option>)}
              </select></div>
            {needsSqft(f.rehabType) && <>
              <div className="field"><label>Existing sq ft</label>
                <input className="input" type="number" min="0" value={f.sqftPre} onChange={e => set('sqftPre', e.target.value)} /></div>
              <div className="field"><label>Completed sq ft</label>
                <input className="input" type="number" min="0" value={f.sqftPost} onChange={e => set('sqftPost', e.target.value)} /></div>
            </>}
          </div>
          <h3 style={{ margin: '12px 0 8px' }}>Experience used for this request</h3>
          <div className="grid cols-3">
            <div className="field"><label>Fix &amp; flip deals</label>
              <input className="input" type="number" min="0" value={f.requestedExpFlips} onChange={e => set('requestedExpFlips', e.target.value)} /></div>
            <div className="field"><label>Fix &amp; hold deals</label>
              <input className="input" type="number" min="0" value={f.requestedExpHolds} onChange={e => set('requestedExpHolds', e.target.value)} /></div>
            <div className="field"><label>Ground-up deals</label>
              <input className="input" type="number" min="0" value={f.requestedExpGround} onChange={e => set('requestedExpGround', e.target.value)} /></div>
          </div>
          <p className="muted small">Final pricing and leverage are confirmed against program guidelines — these figures start the file.</p>
        </div>

        <div className="panel" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 12 }}>Assignment</h3>
          <div className="grid cols-2">
            <div className="field"><label>Loan officer</label>
              <select className="input" value={f.loanOfficerId} onChange={e => set('loanOfficerId', e.target.value)}>
                <option value="">{seesAll ? '— Lead Capture (unassigned) —' : 'Me'}</option>
                {officers.map(m => <option key={m.id} value={m.id}>{m.full_name} ({m.role})</option>)}
              </select></div>
            <div className="field"><label>Processor</label>
              <select className="input" value={f.processorId} onChange={e => set('processorId', e.target.value)}>
                <option value="">— none yet —</option>
                {processors.map(m => <option key={m.id} value={m.id}>{m.full_name}</option>)}
              </select></div>
          </div>
          {!seesAll && <p className="muted small">Left unassigned, this file lands on your pipeline.</p>}
        </div>

        <div className="row" style={{ gap: 10 }}>
          <button className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create file'}</button>
          <Link to="/internal" className="btn ghost">Cancel</Link>
        </div>
      </form>
    </>
  );
}
