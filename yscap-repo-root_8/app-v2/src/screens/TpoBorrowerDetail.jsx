import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api.js';

/* A borrower's full profile — the broker gets the borrower's PII (their own
   firm's borrowers only). Edit the profile fields; reveal or set the SSN
   (audited server-side). */

const addrStr = (a) => !a ? '' : (a.oneLine || [a.line1, a.city, a.state, a.zip].filter(Boolean).join(', '));

export default function TpoBorrowerDetail() {
  const { id } = useParams();
  const [b, setB] = useState(null);       // loaded profile
  const [form, setForm] = useState(null); // editable copy
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  // SSN
  const [ssnShown, setSsnShown] = useState('');
  const [ssnInput, setSsnInput] = useState('');

  const load = () => api.tpoBorrower(id).then((r) => {
    const row = r?.borrower || null;
    setB(row);
    if (row) setForm({
      firstName: row.first_name || '', middleName: row.middle_name || '', lastName: row.last_name || '',
      cellPhone: row.cell_phone || '', dateOfBirth: row.date_of_birth ? String(row.date_of_birth).slice(0, 10) : '',
      citizenship: row.citizenship || '', maritalStatus: row.marital_status || '',
      employmentType: row.employment_type || '', employer: row.employer || '',
      fico: row.fico == null ? '' : String(row.fico),
    });
  }).catch((e) => setErr(e.message || 'Could not load this borrower'));

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  const set = (k) => (e) => setForm((s) => ({ ...s, [k]: e.target.value }));

  async function save() {
    setErr(''); setMsg(''); setBusy(true);
    try {
      await api.tpoUpdateBorrower(id, {
        firstName: form.firstName, middleName: form.middleName, lastName: form.lastName,
        cellPhone: form.cellPhone, dateOfBirth: form.dateOfBirth || null,
        citizenship: form.citizenship, maritalStatus: form.maritalStatus,
        employmentType: form.employmentType, employer: form.employer,
        fico: form.fico === '' ? null : form.fico,
      });
      setMsg('Saved.');
      await load();
    } catch (e) { setErr(e.message || 'Could not save'); }
    finally { setBusy(false); }
  }

  async function revealSsn() {
    setErr('');
    try { const r = await api.tpoBorrowerSsn(id); setSsnShown(r.ssn || ''); }
    catch (e) { setErr(e.message || 'No SSN on file'); }
  }
  async function saveSsn() {
    setErr(''); setMsg('');
    try {
      const r = await api.tpoSetBorrowerSsn(id, ssnInput.trim());
      setMsg(`SSN saved (ending ${r.last4}).`); setSsnInput(''); setSsnShown('');
      await load();
    } catch (e) { setErr(e.message || 'Could not save the SSN'); }
  }

  if (err && !b) return <div className="notice err">{err}</div>;
  if (!b || !form) return <div className="muted">Loading…</div>;

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{ marginBottom: 12 }}><Link to="/tpo/borrowers" className="btn link small">← Back to borrowers</Link></div>
      <div className="page-head" style={{ marginBottom: 18 }}>
        <h1 style={{ margin: 0 }}>{b.full_name || b.email}</h1>
        <p className="muted small" style={{ marginTop: 6 }}>{b.email}</p>
      </div>

      {err && <div role="alert" className="notice err" style={{ marginBottom: 12 }}>{err}</div>}
      {msg && <div className="notice info" style={{ marginBottom: 12 }}>{msg}</div>}

      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 10 }}>Profile</div>
        <div className="grid cols-3">
          <div className="field"><label>First name</label><input className="input" value={form.firstName} onChange={set('firstName')} /></div>
          <div className="field"><label>Middle name</label><input className="input" value={form.middleName} onChange={set('middleName')} /></div>
          <div className="field"><label>Last name</label><input className="input" value={form.lastName} onChange={set('lastName')} /></div>
        </div>
        <div className="grid cols-2">
          <div className="field"><label>Phone</label><input className="input" value={form.cellPhone} onChange={set('cellPhone')} /></div>
          <div className="field"><label>Date of birth</label><input className="input" type="date" value={form.dateOfBirth} onChange={set('dateOfBirth')} /></div>
        </div>
        <div className="grid cols-2">
          <div className="field"><label>Citizenship</label><input className="input" value={form.citizenship} onChange={set('citizenship')} /></div>
          <div className="field"><label>Marital status</label><input className="input" value={form.maritalStatus} onChange={set('maritalStatus')} /></div>
        </div>
        <div className="grid cols-3">
          <div className="field"><label>Employment type</label><input className="input" value={form.employmentType} onChange={set('employmentType')} /></div>
          <div className="field"><label>Employer</label><input className="input" value={form.employer} onChange={set('employer')} /></div>
          <div className="field"><label>Credit score</label><input className="input" inputMode="numeric" value={form.fico} onChange={set('fico')} /></div>
        </div>
        {addrStr(b.current_address) && <p className="muted small" style={{ marginTop: 2 }}>Home address: {addrStr(b.current_address)}</p>}
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save profile'}</button>
        </div>
      </div>

      <div className="card" style={{ padding: 20 }}>
        <div style={{ fontWeight: 600, marginBottom: 10 }}>Social Security number</div>
        <div className="row" style={{ alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
          <span>{b.has_ssn ? (ssnShown || `On file — ending ${b.ssn_last4 || '····'}`) : <span className="muted">Not on file</span>}</span>
          {b.has_ssn && !ssnShown && <button className="btn ghost small" onClick={revealSsn}>Reveal</button>}
        </div>
        <div className="grid cols-2">
          <div className="field"><label>{b.has_ssn ? 'Replace SSN' : 'Add SSN'}</label>
            <input className="input" value={ssnInput} onChange={(e) => setSsnInput(e.target.value)} placeholder="XXX-XX-XXXX" /></div>
          <div className="field" style={{ alignSelf: 'end' }}>
            <button className="btn primary" disabled={!ssnInput.trim()} onClick={saveSsn}>Save SSN</button>
          </div>
        </div>
      </div>
    </div>
  );
}
