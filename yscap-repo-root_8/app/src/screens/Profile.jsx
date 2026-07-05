import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api.js';
import { useAutosave } from '../lib/useAutosave.js';

const F = [
  ['first_name', 'First name'], ['last_name', 'Last name'], ['email', 'Email'],
  ['cell_phone', 'Cell phone'], ['mailing_street', 'Mailing street'],
  ['mailing_city', 'City'], ['mailing_state', 'State'], ['mailing_zip', 'ZIP'],
];

export default function Profile() {
  const [p, setP] = useState(null);
  const [err, setErr] = useState('');
  const doSave = useCallback((patch) => api.saveProfile(patch), []);
  const { status, save } = useAutosave(doSave, 900);

  useEffect(() => { api.profile().then(setP).catch(e => setErr(e.message)); }, []);
  const set = (k, v) => { setP(x => ({ ...x, [k]: v })); save({ [k]: v }); };

  if (err) return <div className="notice err">{err}</div>;
  if (!p) return <div className="panel muted">Loading…</div>;

  const chip = { idle: '', saving: 'Saving…', saved: 'All changes saved', error: 'Save failed' }[status];
  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <div><h1>Your profile</h1><p className="muted small">Used across all your loan files. Changes save automatically.</p></div>
        <div className="spacer" />
        <span className="savechip"><span className={`dot ${status === 'saved' ? 'done' : 'outstanding'}`} />{chip}</span>
      </div>
      <div className="panel">
        <div className="grid cols-2">
          {F.map(([k, label]) => (
            <div className="field" key={k}>
              <label>{label}</label>
              <input className="input" value={p[k] || ''} onChange={e => set(k, e.target.value)} />
            </div>
          ))}
        </div>
        <p className="muted small">Sensitive items like SSN and dates of birth are collected securely during your application and are never shown here.</p>
      </div>
    </>
  );
}
