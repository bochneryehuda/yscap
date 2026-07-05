import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAutosave } from '../lib/useAutosave.js';
import AddressAutocomplete from '../components/AddressAutocomplete.jsx';
import LlcPicker from '../components/LlcPicker.jsx';

const STEPS = ['Property', 'Loan', 'Borrower & submit'];
// Ground-Up is a PROGRAM (not a loan type/purpose). DSCR Rental is intentionally
// not offered here for now.
const PROGRAMS = ['Fix & Flip w/ Construction', 'Bridge', 'Ground-Up Construction', 'Not sure yet'];
const LOAN_TYPES = ['Purchase', 'Refinance — Rate & Term', 'Refinance — Cash-Out'];
const PROP_TYPES = ['SFR (1 unit)', 'Multi 2–4', 'Multi 5+', 'Condo', 'Townhouse', 'Mixed use'];
const CITIZENSHIP = ['US Citizen', 'Permanent Resident', 'Foreign National'];

// Fix & Flip / Ground-Up / construction files use ARV + rehab budget; a straight
// Bridge does not, so those fields are hidden for them.
const needsRehab = (program) => !program || /flip|ground|construction|rehab|not sure/i.test(program);
// An assignment only applies to a purchase.
const isPurchase = (loanType) => !loanType || /purchase/i.test(loanType);

// Property type drives the unit-count control. Single-unit types default to 1
// and never ask; 2–4 offers a dropdown; 5+ / mixed-use take a number.
function unitsMode(propType) {
  if (/2.?4/.test(propType || '')) return 'select24';
  if (/5\+|mixed/i.test(propType || '')) return 'multi';
  return 'single'; // SFR / Condo / Townhouse
}
const money = (n) => (n || n === 0) ? '$' + Number(n).toLocaleString() : '—';

function SaveChip({ status }) {
  const map = { idle: '', saving: 'Saving…', saved: 'All changes saved', error: 'Save failed — retrying' };
  return <span className="savechip"><span className={`dot ${status === 'saved' ? 'done' : status === 'error' ? '' : 'outstanding'}`} />{map[status] || ''}</span>;
}

export default function Apply() {
  const { draftId } = useParams();
  const nav = useNavigate();
  const [id, setId] = useState(draftId || null);
  const [form, setForm] = useState(null);      // null = loading
  const [step, setStep] = useState(1);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [officers, setOfficers] = useState([]);
  const idRef = useRef(id);
  idRef.current = id;

  // load existing draft, or create a fresh one — then prefill the personal
  // section from the borrower's saved profile (empty fields only), so repeat
  // applicants never retype what the portal already knows. Employment is not
  // collected (no-doc / no-income).
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        let data = {}, stepN = 1;
        if (draftId) {
          const d = await api.draft(draftId);
          if (!live) return;
          data = d.data || {}; stepN = d.step || 1; setId(draftId);
        } else {
          const d = await api.createDraft({ label: 'New application', data: {}, step: 1 });
          if (!live) return;
          setId(d.id);
          nav(`/apply/${d.id}`, { replace: true });
        }
        try {
          const p = await api.profile();
          if (!live) return;
          const cur = data.personal || {};
          data.personal = {
            cellPhone: cur.cellPhone || p.cell_phone || '',
            dateOfBirth: cur.dateOfBirth || (p.date_of_birth ? String(p.date_of_birth).slice(0, 10) : ''),
            citizenship: cur.citizenship || p.citizenship || '',
            fico: cur.fico || p.fico || '',
          };
          if (data.ssnOnFile === undefined) data.ssnOnFile = !!p.ssn_last4;
        } catch { /* profile prefill is best-effort */ }
        setForm(data); setStep(stepN);
      } catch (e) { if (live) setErr(e.message); }
    })();
    return () => { live = false; };
  }, [draftId, nav]);

  // The requested-officer dropdown is fed live from the public roster (sales
  // team). We store the chosen officer's name + email; the borrower never types
  // an email, and the backend resolves the officer from it.
  useEffect(() => {
    api.roster().then(r => setOfficers((r.people || []).filter(x => x && x.name))).catch(() => {});
  }, []);

  const doSave = useCallback((patch) => api.saveDraft(idRef.current, patch), []);
  const { status, save, flush } = useAutosave(doSave, 800);

  const set = (k, v) => {
    setForm(f => ({ ...(f || {}), [k]: v }));
    save({ data: { [k]: v } });
  };
  const mergeAddr = (patch) => {
    setForm(f => {
      const address = { ...((f && f.propertyAddress) || {}), ...patch };
      address.oneLine = [[address.street, address.unit].filter(Boolean).join(' '), address.city, [address.state, address.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      save({ data: { propertyAddress: address } });
      return { ...(f || {}), propertyAddress: address };
    });
  };
  const setAddr = (k, v) => mergeAddr({ [k]: v });
  const pickAddr = (a) => mergeAddr({ street: a.line1 || '', unit: a.unit || '', city: a.city || '', state: a.state || '', zip: a.zip || '', county: a.county || '' });
  const setNested = (key) => (k, v) => setForm(f => {
    const obj = { ...((f && f[key]) || {}), [k]: v };
    save({ data: { [key]: obj } });
    return { ...(f || {}), [key]: obj };
  });
  const setPersonal = setNested('personal');
  const setCo = setNested('coBorrower');

  // Choosing the property type auto-resolves units for single-unit types so the
  // borrower never has to answer "units" for a single-family / condo / townhouse.
  const setPropertyType = (v) => {
    setForm(f => {
      const next = { ...(f || {}), propertyType: v };
      if (unitsMode(v) === 'single') next.units = '1';
      else if (String((f || {}).units) === '1') next.units = ''; // clear the auto value when switching to multi
      save({ data: { propertyType: v, units: next.units } });
      return next;
    });
  };

  const pickOfficer = (name) => {
    const o = officers.find(x => x.name === name);
    setForm(f => ({ ...(f || {}), loanOfficerName: name || '', loanOfficerEmail: (o && o.email) || '' }));
    save({ data: { loanOfficerName: name || '', loanOfficerEmail: (o && o.email) || '' } });
  };

  const goStep = async (n) => {
    // Don't let the clickable stepper jump past property basics with an
    // incomplete step 1 (street + type + units) — the file needs them.
    if (n > 1 && !(form && form.propertyAddress && form.propertyAddress.street && form.propertyType && form.units)) { setStep(1); return; }
    await flush(); setStep(n); save({ step: n });
  };

  async function submit() {
    setErr(''); setBusy(true);
    try {
      await flush();
      const r = await api.submitDraft(id, {});
      nav(`/app/${r.applicationId}`);
    } catch (e) { setErr(e.message || 'Could not submit'); setBusy(false); }
  }

  if (err && !form) return <div className="notice err">{err}</div>;
  if (!form) return <div className="panel muted">Loading your application…</div>;
  const a = form.propertyAddress || {};
  const showRehab = needsRehab(form.program);
  const step1Ready = !!a.street && !!form.propertyType && !!form.units;

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <div><h1>New application</h1></div>
        <div className="spacer" />
        <SaveChip status={status} />
      </div>

      <div className="stepper">
        {STEPS.map((s, i) => (
          <div key={s} className={`step ${step === i + 1 ? 'active' : ''} ${step > i + 1 ? 'done' : ''}`}
            onClick={() => goStep(i + 1)} style={{ cursor: 'pointer' }}>
            {step > i + 1 ? '✓ ' : `${i + 1}. `}{s}
          </div>
        ))}
      </div>

      {err && <div className="notice err">{err}</div>}

      {/* autoComplete off on the whole form so the browser never treats the
          subject-property address as the applicant's own contact card. */}
      <form className="panel" autoComplete="off" onSubmit={e => e.preventDefault()}>
        {step === 1 && (
          <>
            <h3 style={{ marginBottom: 14 }}>Subject property</h3>
            <div className="field"><label>Street address *</label>
              <AddressAutocomplete value={a.street || ''} placeholder="Start typing the property address…"
                onChange={v => setAddr('street', v)} onPick={pickAddr} /></div>
            <div className="grid cols-2">
              <div className="field"><label>Apt / Unit</label>
                <input className="input" autoComplete="off" value={a.unit || ''} onChange={e => setAddr('unit', e.target.value)} placeholder="Optional" /></div>
              <div className="field"><label>City</label>
                <input className="input" autoComplete="off" value={a.city || ''} onChange={e => setAddr('city', e.target.value)} /></div>
            </div>
            <div className="grid cols-2">
              <div className="field"><label>State</label>
                <input className="input" autoComplete="off" maxLength={2} value={a.state || ''} onChange={e => setAddr('state', e.target.value.toUpperCase())} placeholder="NY" /></div>
              <div className="field"><label>ZIP</label>
                <input className="input" autoComplete="off" value={a.zip || ''} onChange={e => setAddr('zip', e.target.value)} /></div>
            </div>
            <div className="grid cols-2">
              <div className="field"><label>Property type *</label>
                <select value={form.propertyType || ''} onChange={e => setPropertyType(e.target.value)}>
                  <option value="">Select…</option>{PROP_TYPES.map(p => <option key={p}>{p}</option>)}
                </select></div>
              {unitsMode(form.propertyType) === 'select24' && (
                <div className="field"><label>Number of units *</label>
                  <select value={form.units || ''} onChange={e => set('units', e.target.value)}>
                    <option value="">Select…</option><option>2</option><option>3</option><option>4</option>
                  </select></div>
              )}
              {unitsMode(form.propertyType) === 'multi' && (
                <div className="field"><label>Number of units *</label>
                  <input className="input" type="number" min="5" value={form.units || ''} onChange={e => set('units', e.target.value)} placeholder="5 or more" /></div>
              )}
              {unitsMode(form.propertyType) === 'single' && form.propertyType && (
                <div className="field"><label>Number of units</label>
                  <input className="input" value="1 unit" disabled readOnly /></div>
              )}
            </div>
            {!step1Ready && <p className="muted small">Property address and type are required to continue{unitsMode(form.propertyType) !== 'single' ? ', plus the number of units' : ''}.</p>}
          </>
        )}

        {step === 2 && (
          <>
            <h3 style={{ marginBottom: 14 }}>Loan details</h3>
            <div className="grid cols-2">
              <div className="field"><label>Program</label>
                <select value={form.program || ''} onChange={e => set('program', e.target.value)}>
                  <option value="">Select…</option>{PROGRAMS.map(p => <option key={p}>{p}</option>)}
                </select></div>
              <div className="field"><label>Loan type</label>
                <select value={form.loanType || ''} onChange={e => set('loanType', e.target.value)}>
                  <option value="">Select…</option>{LOAN_TYPES.map(p => <option key={p}>{p}</option>)}
                </select></div>
            </div>
            <div className="grid cols-2">
              <div className="field"><label>Purchase price</label>
                <input className="input" type="number" value={form.purchasePrice || ''} onChange={e => set('purchasePrice', e.target.value)} /></div>
              <div className="field"><label>As-is value</label>
                <input className="input" type="number" value={form.asIsValue || ''} onChange={e => set('asIsValue', e.target.value)} /></div>
            </div>
            {isPurchase(form.loanType) && (
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', margin: '2px 0 12px' }}>
                <input type="checkbox" checked={!!form.isAssignment} onChange={e => set('isAssignment', e.target.checked)} />
                <span>This purchase is an <strong>assignment</strong> of contract</span>
              </label>
            )}
            {form.isAssignment && (
              <>
                <div className="grid cols-2">
                  <div className="field"><label>Underlying contract price</label>
                    <input className="input" type="number" value={form.underlyingContractPrice || ''} onChange={e => set('underlyingContractPrice', e.target.value)} placeholder="Price on the original contract" /></div>
                  <div className="field"><label>Assignment fee</label>
                    <input className="input" type="number" value={form.assignmentFee || ''} onChange={e => set('assignmentFee', e.target.value)} placeholder="Your assignment fee" /></div>
                </div>
                <p className="muted small" style={{ marginBottom: 12 }}>
                  Total purchase price: <strong>{money((Number(form.underlyingContractPrice) || 0) + (Number(form.assignmentFee) || 0))}</strong>.
                  We'll ask for the <strong>assignment contract</strong> and the <strong>underlying purchase contract</strong> on your file.
                </p>
              </>
            )}
            {showRehab && (
              <div className="grid cols-2">
                <div className="field"><label>ARV (after-repair value)</label>
                  <input className="input" type="number" value={form.arv || ''} onChange={e => set('arv', e.target.value)} /></div>
                <div className="field"><label>Rehab budget</label>
                  <input className="input" type="number" value={form.rehabBudget || ''} onChange={e => set('rehabBudget', e.target.value)} /></div>
              </div>
            )}
            <p className="muted small">Final pricing and leverage are confirmed by your loan officer against program guidelines — these figures start the file.</p>
          </>
        )}

        {step === 3 && (
          <>
            <h3 style={{ marginBottom: 4 }}>Your information</h3>
            <p className="muted small" style={{ marginBottom: 12 }}>
              Pulled from your profile where we have it — anything you add here is saved to your
              profile automatically, so you never fill it twice.
            </p>
            {(() => { const p = form.personal || {}; return (
              <>
                <div className="grid cols-2">
                  <div className="field"><label>Cell phone</label>
                    <input className="input" autoComplete="off" value={p.cellPhone || ''} onChange={e => setPersonal('cellPhone', e.target.value)} /></div>
                  <div className="field"><label>Date of birth</label>
                    <input className="input" type="date" value={p.dateOfBirth || ''} onChange={e => setPersonal('dateOfBirth', e.target.value)} /></div>
                </div>
                <div className="grid cols-3">
                  <div className="field"><label>Social Security Number</label>
                    <input className="input" autoComplete="off" value={form.ssn || ''} onChange={e => set('ssn', e.target.value)}
                      placeholder={form.ssnOnFile ? 'On file — leave blank' : '•••-••-••••'} /></div>
                  <div className="field"><label>Estimated FICO</label>
                    <input className="input" type="number" min="300" max="850" value={p.fico || ''} onChange={e => setPersonal('fico', e.target.value)} placeholder="e.g. 720" /></div>
                  <div className="field"><label>Citizenship</label>
                    <select value={p.citizenship || ''} onChange={e => setPersonal('citizenship', e.target.value)}>
                      <option value="">Select…</option>{CITIZENSHIP.map(c => <option key={c}>{c}</option>)}
                    </select></div>
                </div>
              </>
            ); })()}

            <div className="row" style={{ margin: '18px 0 6px', alignItems: 'center' }}>
              <h3 style={{ margin: 0 }}>Co-borrower</h3>
              <span className="muted small">(optional)</span>
              <div className="spacer" />
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                <input type="checkbox" checked={!!form.hasCoBorrower} onChange={e => set('hasCoBorrower', e.target.checked)} />
                <span className="small">Add a co-borrower</span>
              </label>
            </div>
            {form.hasCoBorrower && (() => { const c = form.coBorrower || {}; return (
              <>
                <p className="muted small" style={{ marginBottom: 12 }}>
                  We'll email them an invitation to the portal to join this loan — they can add their own
                  personal information and upload their documents themselves.
                </p>
                <div className="grid cols-2">
                  <div className="field"><label>First name</label>
                    <input className="input" autoComplete="off" value={c.firstName || ''} onChange={e => setCo('firstName', e.target.value)} /></div>
                  <div className="field"><label>Last name</label>
                    <input className="input" autoComplete="off" value={c.lastName || ''} onChange={e => setCo('lastName', e.target.value)} /></div>
                </div>
                <div className="grid cols-2">
                  <div className="field"><label>Email</label>
                    <input className="input" autoComplete="off" value={c.email || ''} onChange={e => setCo('email', e.target.value)} placeholder="They'll receive a portal invitation" /></div>
                  <div className="field"><label>Phone</label>
                    <input className="input" autoComplete="off" value={c.phone || ''} onChange={e => setCo('phone', e.target.value)} /></div>
                </div>
              </>
            ); })()}

            <h3 style={{ margin: '18px 0 14px' }}>Entity &amp; officer</h3>
            <div className="field"><label>Vesting entity / LLC (if any)</label>
              <LlcPicker value={form.entityName || ''} placeholder="e.g. 1420 Bedford Holdings LLC"
                onPick={({ id, name }) => setForm(f => { const next = { ...(f || {}), entityName: name, llcId: id }; save({ data: { entityName: name, llcId: id } }); return next; })} />
              <p className="muted small" style={{ marginTop: 4 }}>Reuse an LLC you've used before, or create a new one — we'll ask for its EIN letter, formation docs, and operating agreement once.</p></div>
            <div className="field"><label>Requested loan officer</label>
              <select value={form.loanOfficerName || ''} onChange={e => pickOfficer(e.target.value)}>
                <option value="">No preference — send to Lead Capture</option>
                {officers.map(o => <option key={o.email || o.name} value={o.name}>{o.name}{o.title ? ` — ${o.title}` : ''}</option>)}
              </select></div>
            <p className="muted small">Leave the officer blank and your file goes to our Lead Capture desk for prompt assignment.</p>
            <div className="panel" style={{ background: 'var(--ink-2)', marginTop: 8 }}>
              <div className="metrow"><span className="k">Property</span><span className="v">{a.oneLine || '—'}</span></div>
              <div className="metrow"><span className="k">Program</span><span className="v">{form.program || '—'}</span></div>
              <div className="metrow"><span className="k">Loan type</span><span className="v">{form.loanType || '—'}</span></div>
            </div>
          </>
        )}

        <div className="row" style={{ marginTop: 18 }}>
          {step > 1 && <button className="btn ghost" type="button" onClick={() => goStep(step - 1)}>Back</button>}
          <div className="spacer" />
          <SaveChip status={status} />
          {step < 3 && <button className="btn primary" type="button" onClick={() => goStep(step + 1)} disabled={step === 1 && !step1Ready}>Continue</button>}
          {step === 3 && <button className="btn primary" type="button" onClick={submit} disabled={busy || !step1Ready}>Submit application</button>}
        </div>
      </form>
    </>
  );
}
