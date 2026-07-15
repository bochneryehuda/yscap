import React, { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, saveBlob } from '../lib/api.js';
import { useSubmitGate } from '../lib/useSubmitGate.js';
import { fmtDay, dayInputValue } from '../lib/dates.js';
import LlcManager from '../components/LlcManager.jsx';
import { PhoneInput, ZipInput } from '../components/FormattedInputs.jsx';
import { passwordProblem } from '../lib/password.js';

// Borrower CRM hub — the single place staff see everything about a person:
// personal info + editable CRM fields, their loan files ("mortgages with us"),
// entities (with verify), track record (with verify), conditions & tasks rolled
// up across their files, a document vault, an activity timeline, and internal
// notes. Portal-account actions (invite / reset / set password) and the audited
// SSN / government-ID reveals live in the header. Access is scoped server-side
// (admins, underwriters, processors: all borrowers; loan officers: their own).

const money = (n) => (n == null || n === '' ? '—' : '$' + Math.round(Number(n)).toLocaleString('en-US'));
function ago(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!isFinite(then)) return null;
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30); if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}
const fmtDate = (iso) => (fmtDay(iso, { year: 'numeric', month: 'short', day: 'numeric' }, 'en-US') || '—');
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
function addr(a) {
  if (!a) return '—';
  const parts = [a.line1, a.line2, a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean);
  return parts.length ? parts.join(', ') : '—';
}
const statusPill = (s) => {
  const cls = /fund|clear|closed|done|verified/i.test(s || '') ? 'ok' : /declin|withdraw|cancel/i.test(s || '') ? 'bad' : '';
  return <span className={`pill ${cls}`}>{(s || '—').replace(/_/g, ' ')}</span>;
};

const TABS = ['Overview', 'Files', 'Entities', 'Track record', 'Conditions', 'Tasks', 'Documents', 'Activity', 'Notes'];

export default function StaffBorrowerDetail() {
  const { id } = useParams();
  const [b, setB] = useState(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState('Overview');

  const load = () => api.staffBorrower(id).then(setB).catch(e => setErr(e.message || 'Could not load borrower'));
  useEffect(() => { setB(null); setErr(''); load(); /* eslint-disable-next-line */ }, [id]);

  if (err) return <><div role="alert" className="notice err">{err}</div><p><Link to="/internal/borrowers">← Back to borrowers</Link></p></>;
  if (!b) return <p className="muted">Loading…</p>;

  const name = `${b.first_name || ''} ${b.last_name || ''}`.trim() || '(no name)';
  return (
    <>
      <p style={{ marginTop: 0 }}><Link to="/internal/borrowers" className="small">← Borrowers</Link></p>
      <Header b={b} name={name} onChanged={load} />
      <div className="tabs" style={{ margin: '18px 0 14px' }}>
        {TABS.map(t => (
          <button key={t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>
      {tab === 'Overview' && <Overview b={b} onChanged={load} />}
      {tab === 'Files' && <Files id={id} />}
      {tab === 'Entities' && <Entities id={id} />}
      {tab === 'Track record' && <TrackRecord id={id} />}
      {tab === 'Conditions' && <Conditions id={id} />}
      {tab === 'Tasks' && <Tasks id={id} />}
      {tab === 'Documents' && <Documents id={id} />}
      {tab === 'Activity' && <Activity id={id} />}
      {tab === 'Notes' && <Notes id={id} />}
    </>
  );
}

/* ---------------- header ---------------- */
function Header({ b, name, onChanged }) {
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [ssn, setSsn] = useState(null);
  const [pw, setPw] = useState(null);
  const flash = (t) => { setMsg(t); setErr(''); setTimeout(() => setMsg(''), 4000); };
  const fail = (t) => { setErr(t); setTimeout(() => setErr(''), 5000); };

  async function act(kind) {
    setBusy(kind); setErr('');
    try {
      if (kind === 'invite') { await api.staffBorrowerInvite(b.id); flash(`PILOT invite sent to ${b.email}.`); onChanged(); }
      else if (kind === 'reset') { await api.staffBorrowerResetPassword(b.id); flash(`Reset link emailed to ${b.email}.`); }
      else if (kind === 'ssn') { const r = await api.staffBorrowerSsn(b.id); setSsn(r.ssn); }
      else if (kind === 'photo') { const { blob, filename } = await api.staffDownloadDoc(b.photo_id_document_id); saveBlob(blob, filename || 'government-id'); }
    } catch (e) { fail(e.message || 'Action failed'); }
    finally { setBusy(''); }
  }
  async function savePw() {
    { const w = passwordProblem(pw); if (w) { fail(w); return; } }
    setBusy('setpw');
    try { await api.staffBorrowerSetPassword(b.id, pw); flash('Password set — open sessions were signed out.'); setPw(null); onChanged(); }
    catch (e) { fail(e.message || 'Could not set password'); }
    finally { setBusy(''); }
  }

  return (
    <div className="panel">
      <div className="row" style={{ alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
            <span className="mono" style={{ width: 46, height: 46, fontSize: 16 }}>
              {(name.match(/\b[A-Za-z]/g) || []).slice(0, 2).join('').toUpperCase() || '—'}
            </span>
            <div style={{ minWidth: 0 }}>
              <h1 style={{ margin: 0 }}>{name}
                {b.tier ? <span className="pill" style={{ marginLeft: 10 }}>Tier {b.tier}</span> : null}
              </h1>
              <div className="muted small" style={{ marginTop: 4 }}>
                {b.email || 'no email'}{b.cell_phone ? ` · ${b.cell_phone}` : ''}
                {b.primary_officer_name ? ` · Officer: ${b.primary_officer_name}` : ''}
              </div>
            </div>
          </div>
          <div className="small" style={{ marginTop: 10 }}>
            {b.has_account === false ? <span className="pill">No account</span>
              : <span className="pill ok">Active{b.last_login_at ? ` · ${ago(b.last_login_at)}` : ''}</span>}
            {b.fico ? <span className="pill" style={{ marginLeft: 6 }}>FICO {b.fico}</span> : null}
            {b.has_ssn ? <span className="pill" style={{ marginLeft: 6 }}>SSN on file</span> : null}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {b.has_account
            ? <button className="btn ghost small" disabled={busy === 'reset' || !b.email} onClick={() => act('reset')}>Reset password</button>
            : <button className="btn primary small" disabled={busy === 'invite' || !b.email} onClick={() => act('invite')}>Invite to PILOT</button>}
          <button className="btn ghost small" onClick={() => setPw(pw == null ? '' : null)}>{pw == null ? 'Set password' : 'Cancel'}</button>
          <button className="btn ghost small" disabled={busy === 'ssn'} onClick={() => act('ssn')} title="Revealing the SSN is audited">
            {ssn ? `SSN ${ssn}` : 'Reveal SSN'}</button>
          {b.photo_id_document_id &&
            <button className="btn ghost small" disabled={busy === 'photo'} onClick={() => act('photo')}>Government ID</button>}
        </div>
      </div>
      {pw != null && (
        <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
          <input className="input" type="text" autoComplete="off" placeholder="New password (≥ 8 chars)" value={pw} onChange={e => setPw(e.target.value)} style={{ maxWidth: 260 }} />
          <button className="btn primary small" disabled={busy === 'setpw'} onClick={savePw}>{busy === 'setpw' ? 'Saving…' : 'Set password'}</button>
        </div>
      )}
      {msg && <div className="notice ok" style={{ marginTop: 10 }}>{msg}</div>}
      {err && <div role="alert" className="notice err" style={{ marginTop: 10 }}>{err}</div>}
    </div>
  );
}

/* ---------------- overview / editable CRM ---------------- */
function Overview({ b, onChanged }) {
  const [team, setTeam] = useState([]);
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { api.staffTeam().then(setTeam).catch(() => {}); }, []);
  const start = () => setF({
    email: b.email || '', cellPhone: b.cell_phone || '', contactType: b.contact_type || '',
    maritalStatus: b.marital_status || '', citizenship: b.citizenship || '',
    dob: dayInputValue(b.date_of_birth) || '',
    primaryOfficerId: b.primary_officer_id || '',
    ca: b.current_address || {}, ma: b.mailing_address || {},
  });
  async function save() {
    setBusy(true); setErr('');
    try {
      await api.staffUpdateBorrower(b.id, {
        email: f.email, cellPhone: f.cellPhone, contactType: f.contactType,
        maritalStatus: f.maritalStatus, citizenship: f.citizenship,
        // Send the DOB only when it actually changed — setting it applies to
        // the profile AND every linked ClickUp task (audited + journaled).
        ...(f.dob && f.dob !== (dayInputValue(b.date_of_birth) || '') ? { dob: f.dob } : {}),
        primaryOfficerId: f.primaryOfficerId || null,
        currentAddress: Object.values(f.ca).some(Boolean) ? f.ca : null,
        mailingAddress: Object.values(f.ma).some(Boolean) ? f.ma : null,
      });
      setMsg('Saved ✓'); setTimeout(() => setMsg(''), 3000); setF(null); onChanged();
    } catch (e) { setErr(e.message || 'Could not save'); }
    finally { setBusy(false); }
  }
  const Row = ({ k, v }) => (<div className="metrow"><span className="k">{k}</span><span className="v">{v || '—'}</span></div>);

  if (f) {
    const setCa = (k, val) => setF(s => ({ ...s, ca: { ...s.ca, [k]: val } }));
    const setMa = (k, val) => setF(s => ({ ...s, ma: { ...s.ma, [k]: val } }));
    return (
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Edit contact & CRM details</h3>
        {err && <div role="alert" className="notice err">{err}</div>}
        <div className="ts-inputs">
          <label><span>Email</span><input className="input" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></label>
          <label><span>Cell phone</span><PhoneInput value={f.cellPhone} onChange={v => setF({ ...f, cellPhone: v })} /></label>
          <label><span>Contact type</span><input className="input" placeholder="INVESTOR / PRIMARY / …" value={f.contactType} onChange={e => setF({ ...f, contactType: e.target.value })} /></label>
          <label><span>Marital status</span><input className="input" value={f.maritalStatus} onChange={e => setF({ ...f, maritalStatus: e.target.value })} /></label>
          <label><span>Citizenship</span><input className="input" value={f.citizenship} onChange={e => setF({ ...f, citizenship: e.target.value })} /></label>
          <label><span>Date of birth</span><input className="input" type="date" value={f.dob}
            onChange={e => setF({ ...f, dob: e.target.value })}
            title="Saving applies to the borrower profile and every linked ClickUp task (audited)" /></label>
          <label><span>Primary officer</span>
            <select className="input" value={f.primaryOfficerId} onChange={e => setF({ ...f, primaryOfficerId: e.target.value })}>
              <option value="">—</option>
              {team.map(t => <option key={t.id} value={t.id}>{t.full_name}</option>)}
            </select></label>
        </div>
        <div style={{ fontWeight: 600, margin: '12px 0 6px' }}>Current address</div>
        <div className="ts-inputs">
          <label style={{ gridColumn: '1 / -1' }}><span>Street</span><input className="input" value={f.ca.line1 || ''} onChange={e => setCa('line1', e.target.value)} /></label>
          <label><span>City</span><input className="input" value={f.ca.city || ''} onChange={e => setCa('city', e.target.value)} /></label>
          <label><span>State</span><input className="input" value={f.ca.state || ''} onChange={e => setCa('state', e.target.value)} /></label>
          <label><span>ZIP</span><ZipInput value={f.ca.zip || ''} onChange={v => setCa('zip', v)} /></label>
        </div>
        <div style={{ fontWeight: 600, margin: '12px 0 6px' }}>Mailing address (if different)</div>
        <div className="ts-inputs">
          <label style={{ gridColumn: '1 / -1' }}><span>Street</span><input className="input" value={f.ma.line1 || ''} onChange={e => setMa('line1', e.target.value)} /></label>
          <label><span>City</span><input className="input" value={f.ma.city || ''} onChange={e => setMa('city', e.target.value)} /></label>
          <label><span>State</span><input className="input" value={f.ma.state || ''} onChange={e => setMa('state', e.target.value)} /></label>
          <label><span>ZIP</span><ZipInput value={f.ma.zip || ''} onChange={v => setMa('zip', v)} /></label>
        </div>
        <div className="row" style={{ gap: 8, marginTop: 12 }}>
          <button className="btn primary small" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
          <button className="btn ghost small" onClick={() => setF(null)}>Cancel</button>
        </div>
      </div>
    );
  }
  return (
    <div className="panel">
      <div className="row" style={{ alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Personal information</h3>
        <div className="spacer" />
        <button className="btn ghost small" onClick={start}>Edit contact & CRM</button>
      </div>
      {msg && <div className="notice ok" style={{ marginTop: 8 }}>{msg}</div>}
      <div style={{ marginTop: 10 }}>
        <Row k="Email" v={b.email} />
        <Row k="Cell phone" v={b.cell_phone} />
        <Row k="Date of birth" v={fmtDate(b.date_of_birth)} />
        <Row k="SSN" v={b.ssn_last4 ? `•••-••-${b.ssn_last4}` : null} />
        <Row k="FICO" v={b.fico} />
        <Row k="Citizenship" v={b.citizenship} />
        <Row k="Marital status" v={b.marital_status} />
        <Row k="Contact type" v={b.contact_type} />
        <Row k="Primary officer" v={b.primary_officer_name} />
        <Row k="Current address" v={addr(b.current_address)} />
        <Row k="Mailing address" v={b.mailing_address ? addr(b.mailing_address) : 'same as current'} />
        <Row k="Housing" v={b.housing_status ? `${b.housing_status.replace(/_/g, ' ')}${b.housing_payment ? ` · ${money(b.housing_payment)}/mo` : ''}` : null} />
        <Row k="In system since" v={fmtDate(b.created_at)} />
      </div>
    </div>
  );
}

/* ---------------- generic loader ---------------- */
function useLoad(fn, deps) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const reload = () => { setErr(''); fn().then(setData).catch(e => { setErr(e.message || 'Could not load'); setData([]); }); };
  useEffect(reload, deps); // eslint-disable-line
  return [data, err, reload];
}
const Empty = ({ t }) => <p className="muted small">{t}</p>;

/* ---------------- files / mortgages ---------------- */
function Files({ id }) {
  const [rows, err] = useLoad(() => api.staffBorrowerApplications(id), [id]);
  if (err) return <div className="notice err">{err}</div>;
  if (!rows) return <Empty t="Loading…" />;
  if (!rows.length) return <div className="panel"><Empty t="No loan files for this borrower." /></div>;
  return (
    <div className="panel" style={{ padding: 0, overflowX: 'auto' }}>
      <table className="tbl" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr style={{ textAlign: 'left' }}>
          {['Property', 'Loan #', 'Program', 'Amount', 'Status', 'Officer', 'Role', ''].map(h => <th key={h} style={{ padding: '10px 12px' }}>{h}</th>)}
        </tr></thead>
        <tbody>
          {rows.map(a => (
            <tr key={a.id} style={{ borderTop: '1px solid var(--line, rgba(127,169,176,.2))' }}>
              <td style={{ padding: '10px 12px' }}>{(a.property_address && a.property_address.oneLine) || addr(a.property_address)}</td>
              <td style={{ padding: '10px 12px' }} className="small">{a.ys_loan_number || '—'}</td>
              <td style={{ padding: '10px 12px' }} className="small">{[a.program, a.loan_type].filter(Boolean).join(' · ') || '—'}</td>
              <td style={{ padding: '10px 12px' }}>{money(a.loan_amount)}</td>
              <td style={{ padding: '10px 12px' }}>{statusPill(a.internal_status || a.status)}</td>
              <td style={{ padding: '10px 12px' }} className="small">{a.loan_officer_name || '—'}</td>
              <td style={{ padding: '10px 12px' }} className="small">{a.is_co_borrower && !a.is_primary ? 'Co-borrower' : 'Borrower'}</td>
              <td style={{ padding: '10px 12px' }}><Link className="btn ghost small" to={`/internal/app/${a.id}`}>Open</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- entities ---------------- */
function Entities({ id }) {
  const [rows, err, reload] = useLoad(() => api.staffBorrowerLlcs(id), [id]);
  if (err) return <div className="notice err">{err}</div>;
  if (!rows) return <Empty t="Loading…" />;
  if (!rows.length) return <div className="panel"><Empty t="No entities on this borrower." /></div>;
  return (
    <div>
      {rows.map(l => (
        <div className="panel" key={l.id} style={{ marginBottom: 12 }}>
          <div className="row" style={{ alignItems: 'center', marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>{l.llc_name}
              {l.is_verified ? <span className="pill ok" style={{ marginLeft: 8 }}>Verified ✓</span> : <span className="pill" style={{ marginLeft: 8 }}>Unverified</span>}
            </h3>
          </div>
          <LlcManager llcId={l.id} onChanged={reload} compactHeader staff />
        </div>
      ))}
    </div>
  );
}

/* ---------------- track record ---------------- */
function TrackRecord({ id }) {
  const [rows, err, reload] = useLoad(() => api.staffBorrowerTrackRecords(id), [id]);
  const [busy, setBusy] = useState('');
  async function verify(t) {
    setBusy(t.id);
    try { await api.staffVerifyTrackRecord(t.id, { status: 'verified' }); reload(); } catch (e) { alert(e.message || 'Could not verify'); }
    finally { setBusy(''); }
  }
  async function revoke(t) {
    const reason = window.prompt('Revoke this project’s verification. The borrower is notified with this reason:');
    if (reason == null) return;                       // cancelled
    if (!reason.trim()) { alert('A reason is required to revoke verification.'); return; }
    setBusy(t.id);
    try { await api.staffVerifyTrackRecord(t.id, { status: 'pending', reason: reason.trim() }); reload(); }
    catch (e) { alert(e.message || 'Could not revoke verification'); }
    finally { setBusy(''); }
  }
  if (err) return <div className="notice err">{err}</div>;
  if (!rows) return <Empty t="Loading…" />;
  if (!rows.length) return <div className="panel"><Empty t="No track-record entries." /></div>;
  return (
    <div className="panel" style={{ padding: 0, overflowX: 'auto' }}>
      <table className="tbl" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr style={{ textAlign: 'left' }}>
          {['Property', 'Type', 'Entity', 'Purchase', 'Sale/Value', 'Verified', ''].map(h => <th key={h} style={{ padding: '10px 12px' }}>{h}</th>)}
        </tr></thead>
        <tbody>
          {rows.map(t => (
            <tr key={t.id} style={{ borderTop: '1px solid var(--line, rgba(127,169,176,.2))' }}>
              <td style={{ padding: '10px 12px' }}>{(t.property_address && t.property_address.oneLine) || addr(t.property_address)}</td>
              <td style={{ padding: '10px 12px' }} className="small">{(t.deal_type || '').replace(/_/g, ' ') || '—'}</td>
              <td style={{ padding: '10px 12px' }} className="small">{t.owned_personally ? 'Personal name' : (t.entity_name || '—')}</td>
              <td style={{ padding: '10px 12px' }}>{money(t.purchase_price)}</td>
              <td style={{ padding: '10px 12px' }}>{money(t.sale_price || t.current_value)}</td>
              <td style={{ padding: '10px 12px' }}>{t.is_verified ? <span className="pill ok">✓</span> : <span className="pill">no</span>}</td>
              <td style={{ padding: '10px 12px' }}>{t.is_verified
                ? <button className="btn ghost small" disabled={busy === t.id} onClick={() => revoke(t)} title="Revoke this project’s verification (borrower is notified)">Revoke</button>
                : <button className="btn ghost small" disabled={busy === t.id} onClick={() => verify(t)}>Verify</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- conditions roll-up ---------------- */
function Conditions({ id }) {
  const [rows, err] = useLoad(() => api.staffBorrowerConditions(id), [id]);
  if (err) return <div className="notice err">{err}</div>;
  if (!rows) return <Empty t="Loading…" />;
  if (!rows.length) return <div className="panel"><Empty t="No open conditions across this borrower's files." /></div>;
  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>Open conditions ({rows.length})</h3>
      {rows.map(c => (
        <div key={c.id} className="metrow">
          <span className="k" style={{ flex: 1 }}>{c.title}
            <span className="muted small" style={{ marginLeft: 8 }}>{c.ys_loan_number || ((c.property_address && c.property_address.city) || '')}</span>
          </span>
          <span className="v">{statusPill(c.status)} <Link className="small" to={`/internal/app/${c.application_id}`}>open file →</Link></span>
        </div>
      ))}
    </div>
  );
}

/* ---------------- tasks / reminders roll-up ---------------- */
function Tasks({ id }) {
  const [rows, err, reload] = useLoad(() => api.staffBorrowerReminders(id), [id]);
  const [nf, setNf] = useState(null);   // new task form
  const [busy, setBusy] = useState(false);
  const [e2, setE2] = useState('');
  const gate = useSubmitGate();
  async function create() {
    if (!nf.title.trim() || !nf.dueAt) { setE2('Title and a due date are required.'); return; }
    if (!gate.enter()) return;             // a create is already in flight
    setBusy(true); setE2('');
    try {
      await api.staffCreateBorrowerReminder(id, { kind: nf.kind, title: nf.title.trim(), body: nf.body || undefined, dueAt: new Date(nf.dueAt).toISOString() });
      setNf(null); reload();
    } catch (e) { setE2(e.message || 'Could not create'); }
    finally { setBusy(false); gate.leave(); }
  }
  async function complete(r) {
    try { await api.staffUpdateReminder(r.application_id, r.id, { status: 'done' }); reload(); } catch (e) { alert(e.message || 'Failed'); }
  }
  if (err) return <div className="notice err">{err}</div>;
  if (!rows) return <Empty t="Loading…" />;
  return (
    <div className="panel">
      <div className="row" style={{ alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Reminders & tasks</h3>
        <div className="spacer" />
        <button className="btn primary small" onClick={() => setNf(nf ? null : { kind: 'task', title: '', body: '', dueAt: '' })}>{nf ? 'Cancel' : '+ New task'}</button>
      </div>
      {nf && (
        <div className="panel" style={{ marginTop: 10, background: 'var(--ink-2)' }}>
          {e2 && <div role="alert" className="notice err">{e2}</div>}
          <div className="ts-inputs">
            <label><span>Type</span><select className="input" value={nf.kind} onChange={e => setNf({ ...nf, kind: e.target.value })}><option value="task">Task</option><option value="reminder">Reminder</option></select></label>
            <label><span>Due</span><input className="input" type="datetime-local" value={nf.dueAt} onChange={e => setNf({ ...nf, dueAt: e.target.value })} /></label>
            <label style={{ gridColumn: '1 / -1' }}><span>Title</span><input className="input" value={nf.title} onChange={e => setNf({ ...nf, title: e.target.value })} placeholder="Follow up with borrower…" /></label>
            <label style={{ gridColumn: '1 / -1' }}><span>Notes</span><input className="input" value={nf.body} onChange={e => setNf({ ...nf, body: e.target.value })} /></label>
          </div>
          <p className="muted small">The task is attached to the borrower's latest file so it flows through the reminder system.</p>
          <button className="btn primary small" disabled={busy} onClick={create}>{busy ? 'Saving…' : 'Create'}</button>
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        {rows.length === 0 ? <Empty t="No reminders or tasks yet." /> : rows.map(r => (
          <div key={r.id} className="metrow">
            <span className="k" style={{ flex: 1 }}>
              <span className="pill" style={{ marginRight: 6 }}>{r.kind}</span>{r.title}
              <div className="muted small">{fmtDateTime(r.due_at)}{r.assignee_name ? ` · ${r.assignee_name}` : ''}{r.ys_loan_number ? ` · ${r.ys_loan_number}` : ''}</div>
            </span>
            <span className="v">
              {r.status === 'scheduled'
                ? <button className="btn ghost small" onClick={() => complete(r)}>Mark done</button>
                : <span className="pill ok">{r.status}</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------- documents vault ---------------- */
function Documents({ id }) {
  const [rows, err] = useLoad(() => api.staffBorrowerDocuments(id), [id]);
  const [busy, setBusy] = useState('');
  async function dl(d) {
    setBusy(d.id);
    try { const { blob, filename } = await api.staffDownloadDoc(d.id); saveBlob(blob, filename || d.filename); }
    catch (e) { alert(e.message || 'Download failed'); }
    finally { setBusy(''); }
  }
  if (err) return <div className="notice err">{err}</div>;
  if (!rows) return <Empty t="Loading…" />;
  if (!rows.length) return <div className="panel"><Empty t="No documents on file for this borrower." /></div>;
  return (
    <div className="panel" style={{ padding: 0, overflowX: 'auto' }}>
      <table className="tbl" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr style={{ textAlign: 'left' }}>
          {['File', 'Kind', 'Loan #', 'Added', ''].map(h => <th key={h} style={{ padding: '10px 12px' }}>{h}</th>)}
        </tr></thead>
        <tbody>
          {rows.map(d => (
            <tr key={d.id} style={{ borderTop: '1px solid var(--line, rgba(127,169,176,.2))' }}>
              <td style={{ padding: '10px 12px' }}>{d.filename}</td>
              <td style={{ padding: '10px 12px' }} className="small">{(d.doc_kind || '').replace(/_/g, ' ') || '—'}</td>
              <td style={{ padding: '10px 12px' }} className="small">{d.ys_loan_number || (d.llc_id ? 'entity' : d.track_record_id ? 'track record' : '—')}</td>
              <td style={{ padding: '10px 12px' }} className="small">{ago(d.created_at)}</td>
              <td style={{ padding: '10px 12px' }}><button className="btn ghost small" disabled={busy === d.id} onClick={() => dl(d)}>Download</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- activity ---------------- */
function Activity({ id }) {
  const [rows, err] = useLoad(() => api.staffBorrowerActivity(id), [id]);
  if (err) return <div className="notice err">{err}</div>;
  if (!rows) return <Empty t="Loading…" />;
  if (!rows.length) return <div className="panel"><Empty t="No recorded activity." /></div>;
  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>Activity</h3>
      {rows.map(a => (
        <div key={a.id} className="metrow">
          <span className="k" style={{ flex: 1 }}>{(a.action || '').replace(/_/g, ' ')}
            <span className="muted small" style={{ marginLeft: 8 }}>{a.actor_name || a.actor_kind}</span>
          </span>
          <span className="v muted small" title={a.created_at ? new Date(a.created_at).toLocaleString() : ''}>{ago(a.created_at)}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------------- notes ---------------- */
function Notes({ id }) {
  const [rows, err, reload] = useLoad(() => api.staffBorrowerNotes(id), [id]);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const gate = useSubmitGate();
  async function add() {
    if (!body.trim()) return;
    if (!gate.enter()) return;             // a note add is already in flight
    setBusy(true);
    try { await api.staffAddBorrowerNote(id, body.trim()); setBody(''); reload(); } catch (e) { alert(e.message || 'Could not add note'); }
    finally { setBusy(false); gate.leave(); }
  }
  async function del(n) {
    if (!window.confirm('Delete this note?')) return;
    try { await api.staffDeleteBorrowerNote(id, n.id); reload(); } catch (e) { alert(e.message || 'Could not delete'); }
  }
  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>Internal notes</h3>
      <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
        <textarea className="input" rows={2} style={{ flex: 1 }} placeholder="Log a call, a preference, a heads-up…" value={body} onChange={e => setBody(e.target.value)} />
        <button className="btn primary small" disabled={busy || !body.trim()} onClick={add}>{busy ? 'Adding…' : 'Add note'}</button>
      </div>
      {err && <div className="notice err" style={{ marginTop: 8 }}>{err}</div>}
      <div style={{ marginTop: 12 }}>
        {!rows ? <Empty t="Loading…" /> : rows.length === 0 ? <Empty t="No notes yet." /> : rows.map(n => (
          <div key={n.id} className="checkitem" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
            <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
            <div className="muted small">{n.author_name || 'staff'} · {fmtDateTime(n.created_at)}
              <button className="btn link small" style={{ marginLeft: 8 }} onClick={() => del(n)}>delete</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
