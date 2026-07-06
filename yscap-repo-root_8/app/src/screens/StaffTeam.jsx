import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

const ROLES = [
  { v: 'loan_officer', label: 'Loan Officer' },
  { v: 'processor', label: 'Processor' },
  { v: 'underwriter', label: 'Underwriter' },
  { v: 'admin', label: 'Admin' },
  { v: 'super_admin', label: 'Super Admin' },
];
const ROLE_LABEL = Object.fromEntries(ROLES.map(r => [r.v, r.label]));
const blankForm = () => ({
  fullName: '', email: '', role: 'loan_officer', title: '', department: 'sales',
  phone: '', cell: '', ext: '', siteSelectable: true, provision: 'invite', password: '',
});

export default function StaffTeam() {
  const { role } = useAuth();
  const isAdmin = role === 'admin' || role === 'super_admin';
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [form, setForm] = useState(blankForm());
  const [busy, setBusy] = useState(false);
  const [pwFor, setPwFor] = useState(null);
  const [pwVal, setPwVal] = useState('');

  const load = () => api.adminStaff().then(setRows).catch(e => setErr(e.message));
  useEffect(() => { if (isAdmin) load(); }, [isAdmin]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 4000); };

  async function create(e) {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const body = {
        fullName: form.fullName.trim(), email: form.email.trim(), role: form.role,
        title: form.title.trim() || undefined, department: form.department,
        phone: form.phone.trim() || undefined, cell: form.cell.trim() || undefined,
        ext: form.ext.trim() || undefined, siteSelectable: form.siteSelectable,
      };
      if (form.provision === 'password') {
        if (form.password.length < 8) throw new Error('Password must be at least 8 characters.');
        body.password = form.password;
      } else { body.sendInvite = true; }
      const r = await api.adminCreateStaff(body);
      let note = `${form.fullName} added.`;
      if (form.provision === 'invite') note += r.invited ? ' Invitation emailed.' : ` Invite link: /portal/#/accept?token=${r.inviteToken}`;
      else note += ' They can log in now.';
      flash(note);
      setForm(blankForm()); await load();
    } catch (e2) { setErr(e2.message || 'Could not add team member'); }
    finally { setBusy(false); }
  }

  async function patch(id, patchBody, okMsg) {
    setErr('');
    try { await api.adminUpdateStaff(id, patchBody); if (okMsg) flash(okMsg); await load(); }
    catch (e) { setErr(e.message); }
  }
  async function savePassword(id) {
    setErr('');
    try {
      if (pwVal.length < 8) throw new Error('Password must be at least 8 characters.');
      await api.adminSetStaffPassword(id, pwVal);
      setPwFor(null); setPwVal(''); flash('Password set. They can log in now.');
      await load();
    } catch (e) { setErr(e.message); }
  }

  if (!isAdmin) return <div className="notice err">Team management is available to admins only.</div>;

  const groups = [
    { key: 'sales', label: 'Sales & Loan Coordinators' },
    { key: 'operations', label: 'Operations & Back Office' },
    { key: null, label: 'Other' },
  ];
  const byDept = (d) => (rows || []).filter(r => (r.department || null) === d);

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>Team</h1>
        <div className="spacer" />
        <button className="btn ghost" title="Email a welcome (with set-up link) to everyone who can't log in yet"
          onClick={async () => { setErr(''); flash('Sending welcome emails…'); try { const r = await api.adminWelcomeAll(false); flash(`Welcome emails: ${r.sent} sent${r.failed ? `, ${r.failed} failed` : ''} (of ${r.total} without a login).`); } catch (e) { setErr(e.message); } }}>
          Send welcome to all
        </button>
        <span className="muted small" style={{ marginLeft: 10 }}>{rows ? `${rows.length} team members` : ''}</span>
      </div>

      {msg && <div className="notice ok" style={{ marginBottom: 12 }}>{msg}</div>}
      {err && <div className="notice err" style={{ marginBottom: 12 }}>{err}</div>}

      {/* ---- add new staff ---- */}
      <div className="panel" style={{ marginBottom: 20 }}>
        <h3 style={{ marginBottom: 4 }}>Add a team member</h3>
        <p className="muted small" style={{ marginBottom: 14 }}>
          They immediately become assignable to files. Sales members marked “Show on site” also
          appear on the public “select your loan officer” list. Choose how they get login access.
        </p>
        <form onSubmit={create} className="grid cols-2" style={{ gap: 12 }}>
          <div className="field"><label>Full name *</label>
            <input className="input" value={form.fullName} onChange={e => set('fullName', e.target.value)} required /></div>
          <div className="field"><label>Email *</label>
            <input className="input" type="email" value={form.email} onChange={e => set('email', e.target.value)} required /></div>
          <div className="field"><label>Role</label>
            <select className="input" value={form.role} onChange={e => set('role', e.target.value)}>
              {ROLES.map(r => <option key={r.v} value={r.v}>{r.label}</option>)}
            </select></div>
          <div className="field"><label>Department</label>
            <select className="input" value={form.department} onChange={e => set('department', e.target.value)}>
              <option value="sales">Sales & Loan Coordinators</option>
              <option value="operations">Operations & Back Office</option>
            </select></div>
          <div className="field"><label>Title</label>
            <input className="input" value={form.title} onChange={e => set('title', e.target.value)} placeholder="Loan Coordinator" /></div>
          <div className="field"><label>Direct phone</label>
            <input className="input" value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="718-247-8700" /></div>
          <div className="field"><label>Cell</label>
            <input className="input" value={form.cell} onChange={e => set('cell', e.target.value)} /></div>
          <div className="field"><label>Ext.</label>
            <input className="input" value={form.ext} onChange={e => set('ext', e.target.value)} /></div>
          <div className="field">
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={form.siteSelectable} onChange={e => set('siteSelectable', e.target.checked)} />
              Show on public site roster
            </label>
          </div>
          <div className="field"><label>Login access</label>
            <select className="input" value={form.provision} onChange={e => set('provision', e.target.value)}>
              <option value="invite">Email an invite (they set their own password)</option>
              <option value="password">Set a password now</option>
            </select></div>
          {form.provision === 'password' && (
            <div className="field"><label>Temporary password</label>
              <input className="input" type="text" value={form.password} onChange={e => set('password', e.target.value)} placeholder="min 8 characters" /></div>
          )}
          <div className="field" style={{ alignSelf: 'end' }}>
            <button className="btn primary" disabled={busy}>{busy ? 'Adding…' : 'Add team member'}</button>
          </div>
        </form>
      </div>

      {/* ---- roster ---- */}
      {rows == null ? <div className="panel muted">Loading…</div> : groups.map(g => {
        const list = byDept(g.key);
        if (!list.length) return null;
        return (
          <div className="panel" key={g.label} style={{ marginBottom: 16 }}>
            <h3 style={{ marginBottom: 12 }}>{g.label} <span className="muted small">({list.length})</span></h3>
            {list.map(s => (
              <div key={s.id} className="checkitem" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ fontWeight: 600 }}>{s.full_name} <span className="muted small">· {ROLE_LABEL[s.role] || s.role}</span></div>
                  <div className="muted small">{s.title || '—'} · {s.email}{s.phone ? ` · ${s.phone}` : ''}{s.ext ? ` x${s.ext}` : ''}</div>
                  <div className="muted small">
                    {s.has_login ? 'Has login' : 'No login yet'}
                    {s.last_login_at ? ` · last in ${new Date(s.last_login_at).toLocaleDateString()}` : ''}
                    {s.mfa_enabled ? ' · MFA on' : ''}
                  </div>
                </div>
                <div className="row" style={{ gap: 10, alignItems: 'center' }}>
                  <label className="muted small" style={{ display: 'flex', gap: 5, alignItems: 'center', cursor: 'pointer' }} title="Show on public site roster">
                    <input type="checkbox" checked={!!s.site_selectable}
                      onChange={e => patch(s.id, { siteSelectable: e.target.checked }, 'Roster updated.')} /> Site
                  </label>
                  <label className="muted small" style={{ display: 'flex', gap: 5, alignItems: 'center', cursor: 'pointer' }} title="Active (can log in & be assigned)">
                    <input type="checkbox" checked={!!s.is_active}
                      onChange={e => patch(s.id, { isActive: e.target.checked }, s.is_active ? 'Deactivated.' : 'Activated.')} /> Active
                  </label>
                  <button className="btn link" onClick={() => { setPwFor(pwFor === s.id ? null : s.id); setPwVal(''); }}>
                    {s.has_login ? 'Reset password' : 'Set password'}
                  </button>
                  <button className="btn link" title="Email them their console welcome (sign-in or set-up link)"
                    onClick={async () => { setErr(''); try { const r = await api.adminWelcome(s.id); flash(r.sent ? `Welcome email sent to ${r.email}.` : `Could not deliver to ${r.email} — check the email provider.`); } catch (e) { setErr(e.message); } }}>
                    Send welcome
                  </button>
                  <button className="btn link" title="Email them a link to set a new password"
                    onClick={async () => { setErr(''); try { const r = await api.adminResetStaffEmail(s.id); flash(r.sent ? `Password-reset email sent to ${r.email}.` : `Could not deliver to ${r.email} — check the email provider.`); } catch (e) { setErr(e.message); } }}>
                    Send password reset
                  </button>
                </div>
                {pwFor === s.id && (
                  <div className="row" style={{ gap: 8, width: '100%', marginTop: 8 }}>
                    <input className="input" style={{ maxWidth: 240 }} type="text" placeholder="New password (min 8)"
                      value={pwVal} onChange={e => setPwVal(e.target.value)} />
                    <button className="btn" onClick={() => savePassword(s.id)}>Save password</button>
                    <button className="btn ghost" onClick={() => { setPwFor(null); setPwVal(''); }}>Cancel</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </>
  );
}
