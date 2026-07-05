import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAutosave } from '../lib/useAutosave.js';
import AddressAutocomplete from '../components/AddressAutocomplete.jsx';

const STEPS = ['Property', 'Loan', 'Borrower & submit'];
const PROGRAMS = ['Fix & Flip w/ Construction', 'Bridge', 'Ground Up Construction', 'DSCR Rental', 'Not sure yet'];
const LOAN_TYPES = ['Purchase', 'Refinance — Rate & Term', 'Refinance — Cash-Out', 'Ground up'];
const PROP_TYPES = ['SFR (1 unit)', 'Multi 2–4', 'Multi 5+', 'Condo', 'Townhouse', 'Mixed use'];

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
  const idRef = useRef(id);
  idRef.current = id;

  // load existing draft, or create a fresh one
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        if (draftId) {
          const d = await api.draft(draftId);
          if (!live) return;
          setForm(d.data || {}); setStep(d.step || 1); setId(draftId);
        } else {
          const d = await api.createDraft({ label: 'New application', data: {}, step: 1 });
          if (!live) return;
          setId(d.id); setForm({});
          nav(`/apply/${d.id}`, { replace: true });
        }
      } catch (e) { if (live) setErr(e.message); }
    })();
    return () => { live = false; };
  }, [draftId, nav]);

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
  // Autocomplete returns divided components (street/unit/city/state/zip).
  const pickAddr = (a) => mergeAddr({ street: a.line1 || '', unit: a.unit || '', city: a.city || '', state: a.state || '', zip: a.zip || '' });

  const goStep = async (n) => { await flush(); setStep(n); save({ step: n }); };

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

      <div className="panel">
        {step === 1 && (
          <>
            <h3 style={{ marginBottom: 14 }}>Subject property</h3>
            <div className="field"><label>Street address</label>
              <AddressAutocomplete value={a.street || ''} placeholder="Start typing the property address…"
                onChange={v => setAddr('street', v)} onPick={pickAddr} /></div>
            <div className="grid cols-2">
              <div className="field"><label>Apt / Unit</label>
                <input className="input" value={a.unit || ''} onChange={e => setAddr('unit', e.target.value)} placeholder="Optional" /></div>
              <div className="field"><label>City</label>
                <input className="input" value={a.city || ''} onChange={e => setAddr('city', e.target.value)} /></div>
            </div>
            <div className="grid cols-2">
              <div className="field"><label>State</label>
                <input className="input" maxLength={2} value={a.state || ''} onChange={e => setAddr('state', e.target.value.toUpperCase())} placeholder="NY" /></div>
              <div className="field"><label>ZIP</label>
                <input className="input" value={a.zip || ''} onChange={e => setAddr('zip', e.target.value)} /></div>
            </div>
            <div className="grid cols-2">
              <div className="field"><label>Property type</label>
                <select value={form.propertyType || ''} onChange={e => set('propertyType', e.target.value)}>
                  <option value="">Select…</option>{PROP_TYPES.map(p => <option key={p}>{p}</option>)}
                </select></div>
              <div className="field"><label>Units</label>
                <input className="input" type="number" min="1" value={form.units || ''} onChange={e => set('units', e.target.value)} /></div>
            </div>
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
            <div className="grid cols-2">
              <div className="field"><label>ARV (after-repair value)</label>
                <input className="input" type="number" value={form.arv || ''} onChange={e => set('arv', e.target.value)} /></div>
              <div className="field"><label>Rehab budget</label>
                <input className="input" type="number" value={form.rehabBudget || ''} onChange={e => set('rehabBudget', e.target.value)} /></div>
            </div>
            <p className="muted small">Final pricing and leverage are confirmed by your loan officer against program guidelines — these figures start the file.</p>
          </>
        )}

        {step === 3 && (
          <>
            <h3 style={{ marginBottom: 14 }}>Borrower &amp; entity</h3>
            <div className="field"><label>Vesting entity / LLC (if any)</label>
              <input className="input" value={form.entityName || ''} onChange={e => set('entityName', e.target.value)} placeholder="e.g. 1420 Bedford Holdings LLC" /></div>
            <div className="grid cols-2">
              <div className="field"><label>Requested loan officer (name)</label>
                <input className="input" value={form.loanOfficerName || ''} onChange={e => set('loanOfficerName', e.target.value)} placeholder="Optional" /></div>
              <div className="field"><label>Loan officer email</label>
                <input className="input" type="email" value={form.loanOfficerEmail || ''} onChange={e => set('loanOfficerEmail', e.target.value)} placeholder="Optional" /></div>
            </div>
            <p className="muted small">Leave the officer blank and your file goes to our Lead Capture desk for prompt assignment.</p>
            <div className="panel" style={{ background: 'var(--ink-2)', marginTop: 8 }}>
              <div className="metrow"><span className="k">Property</span><span className="v">{a.oneLine || '—'}</span></div>
              <div className="metrow"><span className="k">Program</span><span className="v">{form.program || '—'}</span></div>
              <div className="metrow"><span className="k">Loan type</span><span className="v">{form.loanType || '—'}</span></div>
            </div>
          </>
        )}

        <div className="row" style={{ marginTop: 18 }}>
          {step > 1 && <button className="btn ghost" onClick={() => goStep(step - 1)}>Back</button>}
          <div className="spacer" />
          <SaveChip status={status} />
          {step < 3 && <button className="btn primary" onClick={() => goStep(step + 1)} disabled={step === 1 && !a.street}>Continue</button>}
          {step === 3 && <button className="btn primary" onClick={submit} disabled={busy || !a.street}>Submit application</button>}
        </div>
      </div>
    </>
  );
}
