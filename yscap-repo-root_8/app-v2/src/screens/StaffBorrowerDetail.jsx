import React, { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, saveBlob } from '../lib/api.js';
import { useSubmitGate } from '../lib/useSubmitGate.js';
import { fmtDay, dayInputValue } from '../lib/dates.js';
import LlcManager from '../components/LlcManager.jsx';
import BorrowerViewButton from '../components/BorrowerViewButton.jsx';
import { PhoneInput, ZipInput, EmailInput } from '../components/FormattedInputs.jsx';
import { passwordProblem } from '../lib/password.js';
import { CITIZENSHIP, MARITAL, CONTACT_TYPE, HOUSING, withCurrent } from '../lib/enums.js';
import { formatSSN } from '../lib/validators.js';
import { fullNameOf, splitName, rejoin, nameChanged } from '../lib/personName.js';

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

const TABS = ['Overview', 'Files', 'Entities', 'Track record', 'Conditions', 'Tasks', 'Documents', 'Duplicates', 'Activity', 'Notes'];

export default function StaffBorrowerDetail() {
  const { id } = useParams();
  const [b, setB] = useState(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState('Overview');

  const load = () => api.staffBorrower(id).then(setB).catch(e => setErr(e.message || 'Could not load borrower'));
  useEffect(() => { setB(null); setErr(''); load(); /* eslint-disable-next-line */ }, [id]);

  if (err) return <><div role="alert" className="notice err">{err}</div><p><Link to="/internal/borrowers">← Back to borrowers</Link></p></>;
  if (!b) return <p className="muted">Loading…</p>;

  // THE ONE BIG NAME FIELD (db/344) — the whole name, middle name and suffix
  // included. Falls back to the parts so nothing breaks on an older response.
  const name = fullNameOf(b) || '(no name)';
  return (
    <>
      <p style={{ marginTop: 0 }}><Link to="/internal/borrowers" className="small">← Borrowers</Link></p>
      <NameSplitPrompt b={b} onChanged={load} />
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
      {tab === 'Duplicates' && <Duplicates id={id} name={name} onMerged={load} />}
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
          {/* Step into this borrower's portal from their profile (owner-directed
              2026-07-26). Only offered once they actually have a login. */}
          {b.has_account && <BorrowerViewButton borrowerId={b.id} borrowerName={name} />}
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
// "Please check this name" — PILOT had to make a judgement call about where a
// borrower's name splits (db/343 `name_review_needed`), so it asks a human once.
// It is a PROMPT, never a gate: nothing on the file waits for it. One click
// confirms; the Edit form clears it too, because typing the parts IS the answer.
const NAME_SPLIT_HELP = {
  only_one_word: 'Only one word was given, so we could not tell the first name from the last name.',
  three_words: 'Three words — we made the middle word the middle name. Please check that is right.',
  four_or_more_words: 'More than three words — please check we picked the right first, middle and last name.',
  surname_particle: 'The last name looks like it has a small word in it (like "van" or "de la"). Please check.',
  comma_form: 'The name was written last-name-first, so please check we read it the right way round.',
  surname_only: 'This looks like a last name with no first name. Please check.',
};
function NameSplitPrompt({ b, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);
  if (!b || !b.name_review_needed || gone) return null;
  const why = NAME_SPLIT_HELP[b.name_review_reason] || 'Please check this name is split correctly.';
  const confirm = async () => {
    setBusy(true);
    try { await api.staffUpdateBorrower(b.id, { confirmNameSplit: true }); setGone(true); onChanged(); }
    catch (_) { setBusy(false); }
  };
  return (
    <div className="notice" style={{ borderLeft: '4px solid #AE8746', background: '#FFFDF7', color: '#141B22' }}>
      <b style={{ color: '#141B22' }}>Please check this name</b>
      <div style={{ marginTop: 4, color: '#4B585C' }}>{why}</div>
      <div style={{ marginTop: 8, color: '#141B22' }}>
        First <b>{b.first_name || '—'}</b>
        {'  ·  '}Middle <b>{b.middle_name || 'none'}</b>
        {'  ·  '}Last <b>{b.last_name || '—'}</b>
        {b.name_suffix ? <>{'  ·  '}Suffix <b>{b.name_suffix}</b></> : null}
      </div>
      <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn primary small" onClick={confirm} disabled={busy}>
          {busy ? 'Saving…' : 'Yes, that is right'}
        </button>
        <span className="small" style={{ color: '#4B585C', alignSelf: 'center' }}>
          Not right? Use <b>Edit</b> below and fix the boxes — that clears this too.
        </span>
      </div>
    </div>
  );
}

function Overview({ b, onChanged }) {
  const [team, setTeam] = useState([]);
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { api.staffTeam().then(setTeam).catch(() => {}); }, []);
  // A shared mailbox (a husband and wife on one address) is a real situation, not
  // an error — the save offers to keep BOTH profiles rather than dead-ending.
  const [shareOffer, setShareOffer] = useState(false);
  const start = () => setF({
    fullName: fullNameOf(b),
    firstName: b.first_name || '', middleName: b.middle_name || '', lastName: b.last_name || '',
    nameSuffix: b.name_suffix || '',
    email: b.email || '', cellPhone: b.cell_phone || '', contactType: b.contact_type || '',
    maritalStatus: b.marital_status || '', citizenship: b.citizenship || '',
    dob: dayInputValue(b.date_of_birth) || '',
    primaryOfficerId: b.primary_officer_id || '',
    housingStatus: b.housing_status || '', housingPayment: b.housing_payment ?? '',
    yearsAtResidence: b.years_at_residence ?? '', monthsAtResidence: b.months_at_residence ?? '',
    employmentType: b.employment_type || '', employer: b.employer || '',
    dependentsCount: b.dependents_count ?? '',
    ca: b.current_address || {}, ma: b.mailing_address || {},
  });
  async function save(allowSharedEmail = false) {
    setBusy(true); setErr('');
    try {
      await api.staffUpdateBorrower(b.id, {
        // Send the NAME only when it actually changed — a correction here is a
        // deliberate human decision, so it also goes out to every ClickUp card
        // (otherwise the next sync would read the old name straight back).
        ...(nameChanged(f, b) ? {
          firstName: f.firstName, middleName: f.middleName,
          lastName: f.lastName, nameSuffix: f.nameSuffix,
        } : {}),
        email: f.email, cellPhone: f.cellPhone, contactType: f.contactType,
        maritalStatus: f.maritalStatus, citizenship: f.citizenship,
        // Send the DOB only when it actually changed — setting it applies to
        // the profile AND every linked ClickUp task (audited + journaled).
        ...(f.dob && f.dob !== (dayInputValue(b.date_of_birth) || '') ? { dob: f.dob } : {}),
        primaryOfficerId: f.primaryOfficerId || null,
        // Where they live and what they pay for it — the same columns the
        // borrower's own portal edits and the same ones that sync both ways with
        // ClickUp's Primary Housing fields, so the profile and the card agree.
        housingStatus: f.housingStatus, housingPayment: f.housingPayment,
        yearsAtResidence: f.yearsAtResidence, monthsAtResidence: f.monthsAtResidence,
        employmentType: f.employmentType, employer: f.employer,
        dependentsCount: f.dependentsCount,
        currentAddress: Object.values(f.ca).some(Boolean) ? f.ca : null,
        mailingAddress: Object.values(f.ma).some(Boolean) ? f.ma : null,
        ...(allowSharedEmail ? { allowSharedEmail: true } : {}),
      });
      setMsg('Saved ✓'); setTimeout(() => setMsg(''), 3000); setF(null); setShareOffer(false); onChanged();
    } catch (e) {
      setErr(e.message || 'Could not save');
      setShareOffer(!!(e.data && e.data.sharedEmail && e.data.sharedEmail.canShare));
    }
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
          {/* The legal name is correctable here (owner-directed 2026-07-26): a file
              opened under a nickname created the profile under that nickname, and
              there was nowhere to fix it. Saving pushes it to ClickUp too.

              THE ONE BIG NAME FIELD stays (owner-directed 2026-07-27): typing the
              whole name in the big box splits it into the parts below as you type,
              and typing the parts rebuilds the big box. Either way the same four
              fields are saved, so nothing that reads the name changes. */}
          <label style={{ gridColumn: '1 / -1' }}><span>Full name</span>
            <input className="input" value={f.fullName}
              onChange={e => setF({ ...f, fullName: e.target.value, ...splitName(e.target.value) })}
              title="Their whole legal name. This is what every screen, email, term sheet and ClickUp card shows." /></label>
          <label><span>First name</span><input className="input" value={f.firstName}
            onChange={e => setF(s => rejoin({ ...s, firstName: e.target.value }))}
            title="Their real legal first name. Saving updates the profile and every linked ClickUp card." /></label>
          <label><span>Middle name <span style={{ color: '#4B585C', fontWeight: 400 }}>(optional)</span></span>
            <input className="input" value={f.middleName}
              onChange={e => setF(s => rejoin({ ...s, middleName: e.target.value }))}
              title="Leave empty if they do not have one." /></label>
          <label><span>Last name</span><input className="input" value={f.lastName}
            onChange={e => setF(s => rejoin({ ...s, lastName: e.target.value }))} /></label>
          <label><span>Suffix <span style={{ color: '#4B585C', fontWeight: 400 }}>(optional)</span></span>
            <input className="input" placeholder="Jr., III" value={f.nameSuffix}
              onChange={e => setF(s => rejoin({ ...s, nameSuffix: e.target.value }))} /></label>
          <label><span>Email</span><EmailInput value={f.email} onChange={v => setF({ ...f, email: v })} /></label>
          <label><span>Cell phone</span><PhoneInput value={f.cellPhone} onChange={v => setF({ ...f, cellPhone: v })} /></label>
          <label><span>Contact type</span>
            <select className="input" value={f.contactType} onChange={e => setF({ ...f, contactType: e.target.value })}>
              <option value="">Select…</option>{withCurrent(CONTACT_TYPE, f.contactType).map(c => <option key={c} value={c}>{c}</option>)}
            </select></label>
          <label><span>Marital status</span>
            <select className="input" value={f.maritalStatus} onChange={e => setF({ ...f, maritalStatus: e.target.value })}>
              <option value="">Select…</option>{withCurrent(MARITAL, f.maritalStatus).map(c => <option key={c} value={c}>{c}</option>)}
            </select></label>
          <label><span>Citizenship</span>
            <select className="input" value={f.citizenship} onChange={e => setF({ ...f, citizenship: e.target.value })}>
              <option value="">Select…</option>{withCurrent(CITIZENSHIP, f.citizenship).map(c => <option key={c} value={c}>{c}</option>)}
            </select></label>
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
        {/* Housing: do they own or rent, and what does it cost them each month.
            Collected on the loan file and on the borrower's own application — the
            profile is where it belongs, and it rides along to every new file. */}
        <div style={{ fontWeight: 600, margin: '12px 0 6px', color: '#141B22' }}>Housing</div>
        <div className="ts-inputs">
          <label><span>Owns or rents</span>
            <select className="input" value={f.housingStatus} onChange={e => setF({ ...f, housingStatus: e.target.value })}>
              <option value="">Select…</option>{withCurrent(HOUSING, f.housingStatus).map(c => <option key={c} value={c}>{c}</option>)}
            </select></label>
          <label><span>Rent / mortgage per month</span>
            <input className="input" inputMode="decimal" placeholder="e.g. 2,800" value={f.housingPayment}
              onChange={e => setF({ ...f, housingPayment: e.target.value })} /></label>
          <label><span>Years at this address</span>
            <input className="input" inputMode="decimal" value={f.yearsAtResidence}
              onChange={e => setF({ ...f, yearsAtResidence: e.target.value })} /></label>
          <label><span>…plus months</span>
            <input className="input" inputMode="numeric" value={f.monthsAtResidence}
              onChange={e => setF({ ...f, monthsAtResidence: e.target.value })} /></label>
          <label><span>Employment</span>
            <input className="input" value={f.employmentType} placeholder="W-2 / 1099 / Self employed"
              onChange={e => setF({ ...f, employmentType: e.target.value })} /></label>
          <label><span>Employer</span>
            <input className="input" value={f.employer} onChange={e => setF({ ...f, employer: e.target.value })} /></label>
          <label><span>Dependents</span>
            <input className="input" inputMode="numeric" value={f.dependentsCount}
              onChange={e => setF({ ...f, dependentsCount: e.target.value })} /></label>
        </div>
        <p className="small" style={{ color: '#4B585C', marginTop: 8 }}>
          Housing, employment and address save to the borrower's profile and go out to their ClickUp cards,
          so every file this person opens starts with the same details already filled in.
        </p>
        {shareOffer && (
          <div className="notice" style={{ marginTop: 10, color: '#141B22' }}>
            <strong>Do two people share this email?</strong> A husband and wife often use one mailbox.
            Keep both as separate profiles on the same address — only the first one can sign in to the portal.
            <div style={{ marginTop: 8 }}>
              <button className="btn small" disabled={busy} onClick={() => save(true)}>
                Yes — they share the mailbox, save anyway
              </button>
            </div>
          </div>
        )}
        <div className="row" style={{ gap: 8, marginTop: 12 }}>
          <button className="btn primary small" disabled={busy} onClick={() => save(false)}>{busy ? 'Saving…' : 'Save'}</button>
          <button className="btn ghost small" onClick={() => { setF(null); setShareOffer(false); }}>Cancel</button>
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
        <Row k="Email" v={b.email && !/@clickup\.local$/i.test(b.email) ? b.email : null} />
        <Row k="Cell phone" v={b.cell_phone} />
        <Row k="Date of birth" v={fmtDate(b.date_of_birth)} />
        <SsnRow b={b} onChanged={onChanged} />
        <Row k="FICO" v={b.fico} />
        <Row k="Citizenship" v={b.citizenship} />
        <Row k="Marital status" v={b.marital_status} />
        <Row k="Contact type" v={b.contact_type} />
        <Row k="Primary officer" v={b.primary_officer_name} />
        {/* ADDITIONAL contact info accumulated across the borrower's files
            (owner-directed 2026-07-15 night): extra emails/phones ADD here —
            the primary above never gets replaced by another file's contact. */}
        <Row k="Current address" v={addr(b.current_address)} />
        <Row k="Mailing address" v={b.mailing_address ? addr(b.mailing_address) : 'same as current'} />
        <Row k="Housing" v={b.housing_status
          ? `${b.housing_status.replace(/_/g, ' ')}${b.housing_payment ? ` · ${money(b.housing_payment)}/mo` : ''}`
          : null} />
        <Row k="Time at address" v={b.years_at_residence != null || b.months_at_residence != null
          ? [b.years_at_residence ? `${b.years_at_residence} yr` : null,
             b.months_at_residence ? `${b.months_at_residence} mo` : null].filter(Boolean).join(' ') || null
          : null} />
        <Row k="Employment" v={[b.employment_type, b.employer].filter(Boolean).join(' · ')} />
        <Row k="Dependents" v={b.dependents_count} />
        <Row k="In system since" v={fmtDate(b.created_at)} />
      </div>
      <ContactBook b={b} onChanged={onChanged} />
      {(b.sharing || []).length > 0 && (
        <div className="notice" style={{ marginTop: 12, color: '#141B22' }}>
          <strong>This email is shared.</strong>{' '}
          {(b.sharing || []).map(s => fullNameOf(s)).join(', ')}{' '}
          {b.sharing.length === 1 ? 'also uses' : 'also use'} this address. They are separate people with their own
          profiles and files — only one of them can sign in to the portal with it.
        </div>
      )}
      <OtherDeals rows={b.otherDeals || []} />
    </div>
  );
}

/* ---------------- SSN: reveal, add, correct, and un-stick a duplicate --------
   The profile could only ever REVEAL an SSN — adding one had to be done from
   inside a loan file, which is exactly backwards for a person who has no file
   yet (owner-directed 2026-07-26). And when the number is already sitting on a
   DUPLICATE profile the old error just said "another borrower has it" with no
   way to see who, or to fix it. Now it names the profile and offers the move. */
function SsnRow({ b, onChanged }) {
  const [full, setFull] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [conflict, setConflict] = useState(null);

  async function reveal() {
    if (full) { setFull(''); return; }
    setBusy(true); setErr('');
    try { const r = await api.staffBorrowerSsn(b.id); setFull(r.ssn || ''); }
    catch (e) { setErr(e.message || 'Could not reveal the number'); }
    finally { setBusy(false); }
  }
  async function save(resolveConflict) {
    if (draft.replace(/\D/g, '').length !== 9) return;
    setBusy(true); setErr('');
    try {
      await api.staffSetBorrowerSsn(b.id, draft, resolveConflict ? { resolveConflict } : {});
      setEditing(false); setDraft(''); setFull(''); setConflict(null); onChanged();
    } catch (e) {
      setErr(e.message || 'Could not save the number');
      setConflict(e.data && e.data.conflict ? e.data.conflict : null);
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="metrow">
        <span className="k">SSN</span>
        <span className="v" style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
          {editing ? (
            <>
              <input className="input" type="password" inputMode="numeric" autoComplete="off"
                placeholder="•••-••-••••" value={draft} disabled={busy} style={{ maxWidth: 160 }}
                onChange={(e) => { setDraft(formatSSN(e.target.value)); setConflict(null); setErr(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setEditing(false); setConflict(null); setErr(''); } }} />
              <button className="btn small" disabled={busy || draft.replace(/\D/g, '').length !== 9} onClick={() => save()}>
                {busy ? '…' : 'Save'}</button>
              <button className="btn ghost small" onClick={() => { setEditing(false); setDraft(''); setConflict(null); setErr(''); }}>Cancel</button>
            </>
          ) : (
            <>
              <span style={{ fontVariantNumeric: 'tabular-nums', letterSpacing: '.02em', color: '#141B22' }}>
                {full || (b.ssn_last4 ? `•••-••-${b.ssn_last4}` : '—')}
              </span>
              {b.ssn_last4 && (
                <button className="btn ghost small" disabled={busy} onClick={reveal}
                  title={full ? 'Hide the full number' : 'Show the full number (this is logged)'}>
                  {busy ? '…' : (full ? 'Hide' : 'Show')}
                </button>
              )}
              <button className="btn ghost small" onClick={() => { setDraft(''); setEditing(true); }}
                title={b.ssn_last4 ? 'Correct the Social Security number (logged, and sent to ClickUp)' : 'Add the Social Security number (logged, and sent to ClickUp)'}>
                {b.ssn_last4 ? 'Change' : 'Add'}
              </button>
            </>
          )}
        </span>
      </div>
      {err && (
        <div role="alert" className="notice err" style={{ marginTop: 6 }}>
          {err}
          {conflict && conflict.canResolve && (
            <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {conflict.borrowerId && (
                <Link className="btn ghost small" to={`/internal/borrowers/${conflict.borrowerId}`}>
                  Open {conflict.name || 'the other profile'}
                </Link>
              )}
              <button className="btn small" disabled={busy} onClick={() => save('same_person')}>
                Same person — move the number to this profile
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/* ---------------- primary contact + everything else we can reach them on -----
   Every synced file can bring another email or phone for the same person, and
   they ADD to the profile instead of replacing what is already there. Until now
   that list was read-only: a staffer could SEE a better number but not make
   PILOT use it, and could not type in a new one at all. */
function ContactBook({ b, onChanged }) {
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(null);   // {kind, value}
  const primaryEmail = String(b.email || '').toLowerCase();
  const primaryPhone = String(b.cell_phone || '').replace(/\D/g, '').slice(-10);
  const isPrimary = (c) => (c.kind === 'email'
    ? String(c.value).toLowerCase() === primaryEmail
    : String(c.value).replace(/\D/g, '').slice(-10) === primaryPhone && !!primaryPhone);
  const others = (b.contacts || []).filter((c) => !isPrimary(c));

  async function promote(c, allowSharedEmail = false) {
    setBusy(c.value); setErr('');
    try { await api.staffSetPrimaryContact(b.id, { kind: c.kind, value: c.value, allowSharedEmail }); onChanged(); }
    catch (e) {
      setErr(e.message || 'Could not make that the primary');
      if (e.data && e.data.sharedEmail && e.data.sharedEmail.canShare
          && window.confirm(`${e.message}\n\nKeep both people on this email address?`)) {
        return promote(c, true);
      }
    } finally { setBusy(''); }
  }
  async function add() {
    if (!adding || !adding.value.trim()) return;
    setBusy('add'); setErr('');
    try { await api.staffAddBorrowerContact(b.id, { kind: adding.kind, value: adding.value.trim(), makePrimary: !!adding.makePrimary }); setAdding(null); onChanged(); }
    catch (e) { setErr(e.message || 'Could not add that contact'); }
    finally { setBusy(''); }
  }

  return (
    <div style={{ marginTop: 14, borderTop: '1px solid var(--line, #E7E1D3)', paddingTop: 12 }}>
      <div className="row" style={{ alignItems: 'center' }}>
        <h4 style={{ margin: 0, color: '#141B22' }}>How to reach them</h4>
        <div className="spacer" />
        <button className="btn ghost small" onClick={() => setAdding(adding ? null : { kind: 'phone', value: '', makePrimary: false })}>
          {adding ? 'Cancel' : '+ Add email or phone'}
        </button>
      </div>
      <p className="small" style={{ color: '#4B585C', marginTop: 4 }}>
        The <strong>primary</strong> email and phone are what PILOT actually uses — every notification,
        term sheet and ClickUp card. Anything else here is kept as a way to reach them.
      </p>
      {err && <div role="alert" className="notice err" style={{ marginTop: 8 }}>{err}</div>}
      {adding && (
        <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select className="input" style={{ maxWidth: 120 }} value={adding.kind}
            onChange={(e) => setAdding({ ...adding, kind: e.target.value })}>
            <option value="phone">Phone</option><option value="email">Email</option>
          </select>
          <input className="input" style={{ maxWidth: 260 }} value={adding.value}
            placeholder={adding.kind === 'email' ? 'name@email.com' : '(555) 123-4567'}
            onChange={(e) => setAdding({ ...adding, value: e.target.value })} />
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', color: '#141B22' }}>
            <input type="checkbox" checked={!!adding.makePrimary}
              onChange={(e) => setAdding({ ...adding, makePrimary: e.target.checked })} />
            <span className="small">Make this the primary</span>
          </label>
          <button className="btn small" disabled={busy === 'add'} onClick={add}>{busy === 'add' ? 'Saving…' : 'Add'}</button>
        </div>
      )}
      <div style={{ marginTop: 8 }}>
        <div className="metrow"><span className="k">Primary email</span>
          <span className="v" style={{ color: '#141B22' }}>{b.email && !/@clickup\.local$/i.test(b.email) ? b.email : '—'}</span></div>
        <div className="metrow"><span className="k">Primary phone</span>
          <span className="v" style={{ color: '#141B22' }}>{b.cell_phone || '—'}</span></div>
        {others.length === 0
          ? <p className="small" style={{ color: '#4B585C' }}>Nothing else on file for this person yet.</p>
          : others.map((c, i) => (
            <div key={i} className="metrow">
              <span className="k">{c.kind === 'email' ? 'Other email' : 'Other phone'}</span>
              <span className="v" style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', color: '#141B22' }}>
                {c.value}
                <button className="btn ghost small" disabled={busy === c.value} onClick={() => promote(c)}>
                  {busy === c.value ? '…' : 'Make primary'}
                </button>
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}

/* ---------------- the person's other business with us ------------------------
   DSCR / long-term deals live in ClickUp and never become loan files here, so a
   client who has only ever done that kind of business used to look like an empty
   record. This lists what ClickUp knows about them (owner-directed 2026-07-26:
   "build up an entire profile from ClickUp for all the information available,
   even if they never took an RTL loan"). Read-only — ClickUp owns these. */
function OtherDeals({ rows }) {
  if (!rows.length) return null;
  return (
    <div style={{ marginTop: 14, borderTop: '1px solid var(--line, #E7E1D3)', paddingTop: 12 }}>
      <h4 style={{ margin: '0 0 4px', color: '#141B22' }}>Other deals with us ({rows.length})</h4>
      <p className="small" style={{ color: '#4B585C', marginTop: 0 }}>
        DSCR and long-term deals from ClickUp. These are not fix-and-flip loan files, so they don't
        open in PILOT — they're here so you can see everything this borrower has done with us.
      </p>
      {rows.map((r) => (
        <div key={r.task_id} className="metrow">
          <span className="k" style={{ flex: 1, color: '#141B22' }}>
            {r.property || r.task_name || 'Untitled deal'}
            <div className="small" style={{ color: '#4B585C' }}>
              {[r.raw_program, r.internal_status, r.loan_officer_name].filter(Boolean).join(' · ')}
            </div>
          </span>
          <span className="v" style={{ color: '#141B22' }}>
            {r.loan_amount ? money(r.loan_amount) : ''}
            <a className="small" style={{ marginLeft: 8 }} target="_blank" rel="noreferrer"
              href={`https://app.clickup.com/t/${r.task_id}`}>open in ClickUp →</a>
          </span>
        </div>
      ))}
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

/* ---------------- duplicate profiles: compare + merge ---------------- */
// The sync deliberately OVER-SPLITS (an email it can't corroborate creates a
// separate profile rather than risk hanging one person's loans and PII on
// another), so genuine duplicates happen. This is where they are put back
// together: pick a candidate, see the two side by side, choose a winner for every
// field they disagree on, and merge. Emails, phones, entities and track records
// are never a choice — they ADD UP.
//
// Merging is the most destructive thing here: it re-points every file, document,
// condition and message and then removes a profile. So it takes two deliberate
// clicks, the survivor is always THIS profile (never a surprise), and the whole
// losing record is snapshotted server-side before anything moves.
const CONF = { certain: { cls: 'ok', t: 'Certain' }, likely: { cls: '', t: 'Likely' }, possible: { cls: '', t: 'Possible' } };

function Duplicates({ id, name, onMerged }) {
  const [rows, err, reload] = useLoad(() => api.staffBorrowerDuplicates(id), [id]);
  const [history] = useLoad(() => api.staffBorrowerMerges(id), [id]);
  const [openId, setOpenId] = useState(null);

  if (err) return <div className="notice err">{err}</div>;
  if (!rows) return <Empty t="Looking for duplicate profiles…" />;

  return (
    <div>
      <div className="panel" style={{ marginBottom: 12 }}>
        <h3 style={{ marginTop: 0 }}>Possible duplicates of {name}</h3>
        {!rows.length ? (
          <p className="muted small" style={{ margin: 0 }}>
            No other profile shares this person’s social, email, phone, or name and date of birth.
          </p>
        ) : (
          <>
            <p className="muted small" style={{ marginTop: 0 }}>
              Merging keeps <strong>this</strong> profile and absorbs the other one into it. Every
              loan file, document and condition follows the person; emails, phone numbers, entities
              and track-record properties add up. Nothing is thrown away — the absorbed profile is
              saved in full first.
            </p>
            <div style={{ overflowX: 'auto' }}>
              <table className="tbl" style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr style={{ textAlign: 'left' }}>
                  {['Name', 'Email', 'Phone', 'SSN', 'Files', 'Why we think so', ''].map(h => <th key={h} style={{ padding: '10px 12px' }}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {rows.map(d => (
                    <tr key={d.id} style={{ borderTop: '1px solid var(--line, rgba(127,169,176,.2))' }}>
                      <td style={{ padding: '10px 12px' }}>
                        <Link to={`/internal/borrowers/${d.id}`}>{fullNameOf(d) || '(no name)'}</Link>
                        {' '}<span className={`pill ${CONF[d.confidence]?.cls || ''}`}>{CONF[d.confidence]?.t || d.confidence}</span>
                      </td>
                      <td style={{ padding: '10px 12px' }} className="small">{d.email || '—'}</td>
                      <td style={{ padding: '10px 12px' }} className="small">{d.cell_phone || '—'}</td>
                      <td style={{ padding: '10px 12px' }} className="small">{d.ssn_last4 ? `•••-••-${d.ssn_last4}` : '—'}</td>
                      <td style={{ padding: '10px 12px' }}>{d.files}</td>
                      <td style={{ padding: '10px 12px' }} className="small">
                        {d.allowedShare
                          // Somebody already decided these are two real people who
                          // share a mailbox (husband and wife). Never present that
                          // as a duplicate — say so plainly.
                          ? <span className="muted">Confirmed as a different person sharing an email — do not merge</span>
                          : (d.why || []).join(' · ')}
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <button className="btn ghost small" onClick={() => setOpenId(openId === d.id ? null : d.id)}>
                          {openId === d.id ? 'Close' : 'Compare'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {openId && (
        <CompareMerge
          key={openId} id={id} otherId={openId}
          onDone={() => { setOpenId(null); reload(); onMerged && onMerged(); }}
          onCancel={() => setOpenId(null)}
        />
      )}

      {!!(history && history.length) && (
        <div className="panel" style={{ marginTop: 12 }}>
          <h3 style={{ marginTop: 0 }}>Already merged into this profile</h3>
          {history.map(h => (
            <div key={h.id} className="small" style={{ padding: '6px 0', borderTop: '1px solid var(--line, rgba(127,169,176,.2))' }}>
              <strong>{h.merged_name || '(no name)'}</strong>{h.merged_email ? ` · ${h.merged_email}` : ''}
              {' — '}<span className="muted">{fmtDateTime(h.created_at)}{h.merged_by_name ? ` by ${h.merged_by_name}` : ''}</span>
              <div className="muted" style={{ marginTop: 2 }}>
                {Object.entries(h.moved || {}).filter(([, n]) => n).map(([t, n]) => `${n} ${t.replace(/_/g, ' ')}`).join(' · ') || 'nothing had to move'}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CompareMerge({ id, otherId, onDone, onCancel }) {
  const [cmp, err, reload] = useLoad(() => api.staffBorrowerCompare(id, otherId), [id, otherId]);
  const [choices, setChoices] = useState({});
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  // A merge is not idempotent — a double-click must not run it twice, and
  // `disabled={busy}` is state that only lands on the NEXT render.
  const gate = useSubmitGate();

  if (err) return <div className="notice err">{err}</div>;
  if (!cmp) return <div className="panel"><Empty t="Loading both profiles…" /></div>;

  const conflicts = cmp.fields.filter(f => f.conflict);
  const undecided = conflicts.filter(f => !choices[f.key]);
  const gains = cmp.fields.filter(f => f.onlyMerged);
  const show = (v) => (v == null || v === '' ? <span className="muted">— empty —</span>
    : (typeof v === 'object' ? (v.oneLine || [v.line1, v.city, v.state].filter(Boolean).join(', ') || JSON.stringify(v)) : String(v)));

  async function doMerge() {
    if (!gate.enter()) return;
    setMsg(''); setBusy(true);
    try {
      const out = await api.staffBorrowerMerge(id, { mergeId: otherId, choices });
      const moved = Object.entries(out.moved || {}).filter(([, n]) => n)
        .map(([t, n]) => `${n} ${t.replace(/_/g, ' ')}`).join(', ');
      setMsg(`Merged. ${moved ? `Moved ${moved}.` : 'Nothing needed to move.'}`);
      setTimeout(onDone, 1200);
    } catch (e) {
      // The server refuses a merge with an undecided conflict — surface exactly
      // which fields it is still waiting on rather than a generic failure.
      setMsg(e.message || 'Could not merge those profiles — nothing was changed.');
      setConfirm(false); reload();
    } finally { setBusy(false); gate.leave(); }
  }

  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <h3 style={{ marginTop: 0 }}>Compare and merge</h3>
      <div className="row small" style={{ gap: 18, marginBottom: 10 }}>
        <div><strong>Keeping:</strong> {cmp.survivor.name || '(no name)'} — {cmp.survivor.files} files, {cmp.survivor.llcs} entities, {cmp.survivor.trackRecords} properties, {cmp.survivor.documents} documents{cmp.survivor.hasLogin ? ', has a portal login' : ''}</div>
        <div><strong>Absorbing:</strong> {cmp.merged.name || '(no name)'} — {cmp.merged.files} files, {cmp.merged.llcs} entities, {cmp.merged.trackRecords} properties, {cmp.merged.documents} documents{cmp.merged.hasLogin ? ', has a portal login' : ''}</div>
      </div>

      {!conflicts.length ? (
        <p className="notice ok small">These two profiles do not contradict each other anywhere — nothing to decide.</p>
      ) : (
        <>
          <p className="small" style={{ marginBottom: 6 }}>
            <strong>{conflicts.length} field{conflicts.length === 1 ? '' : 's'} disagree.</strong> Choose which value the
            one profile should keep. (The value you don’t pick is not lost for emails and phones —
            both are kept as extra contacts.)
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ textAlign: 'left' }}>
                {['Field', 'This profile', 'The other profile'].map(h => <th key={h} style={{ padding: '8px 12px' }}>{h}</th>)}
              </tr></thead>
              <tbody>
                {conflicts.map(f => (
                  <tr key={f.key} style={{ borderTop: '1px solid var(--line, rgba(127,169,176,.2))' }}>
                    <td style={{ padding: '8px 12px' }}>{f.label}</td>
                    {['survivor', 'merged'].map(side => (
                      <td key={side} style={{ padding: '8px 12px' }}>
                        <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                          <input type="radio" name={`c-${f.key}`} checked={choices[f.key] === side}
                            onChange={() => setChoices(c => ({ ...c, [f.key]: side }))} />
                          <span>{show(f[side])}</span>
                        </label>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!!gains.length && (
        <p className="muted small" style={{ marginTop: 10 }}>
          Filled in automatically from the other profile (this one is empty there):{' '}
          {gains.map(f => f.label).join(', ')}.
        </p>
      )}

      {msg && <div className={`notice ${/^Merged/.test(msg) ? 'ok' : 'err'} small`} style={{ marginTop: 10 }}>{msg}</div>}

      <div className="row" style={{ gap: 8, marginTop: 12, alignItems: 'center' }}>
        {!confirm ? (
          <button className="btn" disabled={!!undecided.length} onClick={() => { setMsg(''); setConfirm(true); }}>
            Merge into this profile
          </button>
        ) : (
          <>
            <span className="small">
              This removes <strong>{cmp.merged.name || 'the other profile'}</strong> and moves its{' '}
              {cmp.merged.files} file{cmp.merged.files === 1 ? '' : 's'} onto this one. It cannot be undone from the app.
            </span>
            <button className="btn danger" disabled={busy} onClick={doMerge}>{busy ? 'Merging…' : 'Yes, merge them'}</button>
            <button className="btn ghost" disabled={busy} onClick={() => setConfirm(false)}>Back</button>
          </>
        )}
        {!confirm && <button className="btn ghost" onClick={onCancel}>Cancel</button>}
        {!!undecided.length && (
          <span className="muted small">Still to decide: {undecided.map(f => f.label).join(', ')}</span>
        )}
      </div>
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
