import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { passwordProblem, PASSWORD_HINT } from '../lib/password.js';

// Fallback role list (replaced live by GET /permissions-meta).
const FALLBACK_ROLES = [
  { key: 'loan_officer', label: 'Loan Officer' },
  { key: 'loan_coordinator', label: 'Loan Coordinator' },
  { key: 'processor', label: 'Loan Processor' },
  { key: 'underwriter', label: 'Underwriter' },
  { key: 'software_setup', label: 'Software Setup' },
  { key: 'admin', label: 'Admin' },
  { key: 'super_admin', label: 'Super Admin' },
];
const blankForm = () => ({
  fullName: '', email: '', role: 'loan_officer', title: '', department: 'sales',
  phone: '', cell: '', ext: '', siteSelectable: true, provision: 'invite', password: '',
});

export default function StaffTeam() {
  const { can } = useAuth();
  const isAdmin = can('manage_team');
  const [rows, setRows] = useState(null);
  const [meta, setMeta] = useState({ roles: FALLBACK_ROLES, capabilities: [], roleDefaults: {} });
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [form, setForm] = useState(blankForm());
  const [busy, setBusy] = useState(false);
  const [pwFor, setPwFor] = useState(null);
  const [pwVal, setPwVal] = useState('');
  const [permFor, setPermFor] = useState(null);   // staffer id whose permissions panel is open
  const [shareOpen, setShareOpen] = useState(false); // "see specific officers' files" picker expanded
  // Guards the welcome / password-reset email actions — a double-click was
  // sending the same email twice.
  const [mailBusy, setMailBusy] = useState(null);

  const ROLES = meta.roles || FALLBACK_ROLES;
  const ROLE_LABEL = Object.fromEntries(ROLES.map(r => [r.key, r.label]));

  const load = () => api.adminStaff().then(setRows).catch(e => setErr(e.message));
  useEffect(() => {
    if (!isAdmin) return;
    load();
    api.adminPermissionsMeta().then(setMeta).catch(() => {});
  }, [isAdmin]);

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
        { const w = passwordProblem(form.password); if (w) throw new Error(w); }
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
      { const w = passwordProblem(pwVal); if (w) throw new Error(w); }
      await api.adminSetStaffPassword(id, pwVal);
      setPwFor(null); setPwVal(''); flash('Password set. They can log in now.');
      await load();
    } catch (e) { setErr(e.message); }
  }

  if (!isAdmin) return <div role="alert" className="notice err">You do not have permission to manage the team.</div>;

  // Effective capability for a staffer given their (possibly overridden) grants.
  const effectiveFor = (s) => new Set(s.effectivePermissions || meta.roleDefaults[s.role] || []);
  async function togglePermission(s, cap, on) {
    const defaults = new Set(meta.roleDefaults[s.role] || []);
    const eff = effectiveFor(s);
    // Start from the existing explicit overrides, then set/clear this cap.
    const overrides = { ...(s.permissions || {}) };
    const desired = new Set(eff); if (on) desired.add(cap); else desired.delete(cap);
    // Only keep overrides that differ from the role default.
    for (const c of (meta.capabilities || []).map(x => x.key)) {
      const def = defaults.has(c), want = desired.has(c);
      if (def === want) delete overrides[c]; else overrides[c] = want;
    }
    await patch(s.id, { permissions: overrides }, 'Permissions updated.');
  }

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
        <button className="btn ghost" disabled={mailBusy === 'all'} title="Email a welcome (with set-up link) to everyone who can't log in yet"
          onClick={async () => { if (mailBusy) return; setMailBusy('all'); setErr(''); flash('Sending welcome emails…'); try { const r = await api.adminWelcomeAll(false); flash(`Welcome emails: ${r.sent} sent${r.failed ? `, ${r.failed} failed` : ''} (of ${r.total} without a login).`); } catch (e) { setErr(e.message); } finally { setMailBusy(null); } }}>
          Send welcome to all
        </button>
        <span className="muted small" style={{ marginLeft: 10 }}>{rows ? `${rows.length} team members` : ''}</span>
      </div>

      {msg && <div className="notice ok" style={{ marginBottom: 12 }}>{msg}</div>}
      {err && <div role="alert" className="notice err" style={{ marginBottom: 12 }}>{err}</div>}

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
              {ROLES.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
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
              <input className="input" type="text" value={form.password} onChange={e => set('password', e.target.value)} placeholder="Set a starting password" />
              <div className="hint" style={{ marginTop: 6 }}>{PASSWORD_HINT}</div></div>
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
                <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <label className="muted small" style={{ display: 'flex', gap: 5, alignItems: 'center' }} title="Change this person's role">
                    Role
                    <select className="input" style={{ padding: '4px 8px', minHeight: 0 }} value={s.role}
                      onChange={e => patch(s.id, { role: e.target.value }, 'Role updated.')}>
                      {ROLES.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
                    </select>
                  </label>
                  <button className="btn link" onClick={() => setPermFor(permFor === s.id ? null : s.id)}>
                    {permFor === s.id ? 'Hide permissions' : 'Permissions'}
                  </button>
                  <label className="muted small" style={{ display: 'flex', gap: 5, alignItems: 'center', cursor: 'pointer' }} title="Show on public site roster">
                    <input type="checkbox" checked={!!s.site_selectable}
                      onChange={e => patch(s.id, { siteSelectable: e.target.checked }, 'Roster updated.')} /> Site
                  </label>
                  <label className="muted small" style={{ display: 'flex', gap: 5, alignItems: 'center', cursor: 'pointer' }} title="Active (can log in & be assigned)">
                    <input type="checkbox" checked={!!s.is_active}
                      onChange={e => patch(s.id, { isActive: e.target.checked }, s.is_active ? 'Deactivated.' : 'Activated.')} /> Active
                  </label>
                  <label className="muted small" style={{ display: 'flex', gap: 5, alignItems: 'center', cursor: 'pointer' }} title="Email notifications (their in-app notifications stay on either way)">
                    <input type="checkbox" checked={s.notificationsEnabled !== false}
                      onChange={e => patch(s.id, { notificationsEnabled: e.target.checked }, e.target.checked ? 'Email notifications on.' : 'Email notifications off.')} /> Notify
                  </label>
                  <button className="btn link" onClick={() => { setPwFor(pwFor === s.id ? null : s.id); setPwVal(''); }}>
                    {s.has_login ? 'Reset password' : 'Set password'}
                  </button>
                  <button className="btn link" disabled={mailBusy === `w${s.id}`} title="Email them their console welcome (sign-in or set-up link)"
                    onClick={async () => { if (mailBusy) return; setMailBusy(`w${s.id}`); setErr(''); try { const r = await api.adminWelcome(s.id); flash(r.sent ? `Welcome email sent to ${r.email}.` : `Could not deliver to ${r.email} — check the email provider.`); } catch (e) { setErr(e.message); } finally { setMailBusy(null); } }}>
                    Send welcome
                  </button>
                  <button className="btn link" disabled={mailBusy === `r${s.id}`} title="Email them a link to set a new password"
                    onClick={async () => { if (mailBusy) return; setMailBusy(`r${s.id}`); setErr(''); try { const r = await api.adminResetStaffEmail(s.id); flash(r.sent ? `Password-reset email sent to ${r.email}.` : `Could not deliver to ${r.email} — check the email provider.`); } catch (e) { setErr(e.message); } finally { setMailBusy(null); } }}>
                    Send password reset
                  </button>
                </div>
                {pwFor === s.id && (
                  <div style={{ width: '100%', marginTop: 8 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <input className="input" style={{ maxWidth: 240 }} type="text" placeholder="New password"
                        value={pwVal} onChange={e => setPwVal(e.target.value)} />
                      <button className="btn primary" onClick={() => savePassword(s.id)}>Save password</button>
                      <button className="btn ghost" onClick={() => { setPwFor(null); setPwVal(''); }}>Cancel</button>
                    </div>
                    <div className="hint" style={{ marginTop: 6 }}>{PASSWORD_HINT}</div>
                  </div>
                )}
                {permFor === s.id && (
                  <div style={{ width: '100%', marginTop: 10, padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--ink-2)' }}>
                    <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                      <strong className="small">What {s.full_name.split(' ')[0]} can do</strong>
                      {s.role === 'super_admin'
                        ? <span className="muted small">Super Admin — full access</span>
                        : s.permissions && Object.keys(s.permissions).length > 0
                          ? <button className="btn link small" onClick={() => patch(s.id, { permissions: {} }, 'Reset to role defaults.')}>Reset to {ROLE_LABEL[s.role]} defaults</button>
                          : <span className="muted small">Using {ROLE_LABEL[s.role]} defaults</span>}
                    </div>
                    <div className="grid cols-2" style={{ gap: 6 }}>
                      {(meta.capabilities || []).map(cap => {
                        const eff = effectiveFor(s);
                        const isDefault = new Set(meta.roleDefaults[s.role] || []).has(cap.key);
                        const overridden = s.permissions && cap.key in s.permissions;
                        return (
                          <label key={cap.key} className="small" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: s.role === 'super_admin' ? 'not-allowed' : 'pointer', opacity: s.role === 'super_admin' ? 0.7 : 1 }} title={cap.hint}>
                            <input type="checkbox" style={{ marginTop: 3 }} disabled={s.role === 'super_admin'}
                              checked={s.role === 'super_admin' ? true : eff.has(cap.key)}
                              onChange={e => togglePermission(s, cap.key, e.target.checked)} />
                            <span>
                              {cap.label}
                              {overridden && <span className="pill" style={{ marginLeft: 6, fontSize: 10, borderColor: 'var(--gold)', color: 'var(--gold)' }}>{eff.has(cap.key) ? 'granted' : 'revoked'}</span>}
                              {!overridden && isDefault && <span className="muted" style={{ marginLeft: 6, fontSize: 10 }}>(default)</span>}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                    {/* Shared file access: grant this staffer access to specific
                        loan officers' files even when unassigned. Hidden if they
                        already see every file. */}
                    {s.role !== 'super_admin' && !effectiveFor(s).has('see_all_files') && (() => {
                      const officers = (rows || []).filter(o => o.role === 'loan_officer' && o.id !== s.id);
                      const sel = new Set(s.visibleOfficerIds || []);
                      const on = sel.size > 0 || shareOpen;
                      return (
                        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--line)' }}>
                          <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}
                            title="Share specific officers' files with this person without assigning them.">
                            <input type="checkbox" checked={on}
                              onChange={e => { if (e.target.checked) setShareOpen(true); else { setShareOpen(false); if (sel.size) patch(s.id, { visibleOfficerIds: [] }, 'Cleared shared file access.'); } }} />
                            <strong>See files from specific loan officers</strong>
                            <span className="muted">(even if unassigned)</span>
                          </label>
                          {on && (
                            <div className="grid cols-2" style={{ gap: 6, marginTop: 8, paddingLeft: 26 }}>
                              {officers.length === 0 && <span className="muted small">No other loan officers yet.</span>}
                              {officers.map(o => (
                                <label key={o.id} className="small" style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                                  <input type="checkbox" checked={sel.has(o.id)}
                                    onChange={e => { const next = new Set(s.visibleOfficerIds || []); if (e.target.checked) next.add(o.id); else next.delete(o.id); patch(s.id, { visibleOfficerIds: [...next] }, 'Updated shared file access.'); }} />
                                  <span>{o.full_name}</span>
                                </label>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })()}
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
