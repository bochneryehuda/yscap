import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { askConfirm } from '../lib/dialog.js';
import { useAuth } from '../lib/auth.jsx';
import { InfoTip } from '../components/FileSections.jsx';

/* Broker firms — the INTERNAL admin home for the TPO (wholesale) channel.
   An admin creates a brokerage firm and invites its lead broker; the lead broker
   then invites their own team from inside the broker portal. This screen also holds
   each firm's OWN Xactus credit account (owner roadmap Phase 5b, "own-Xactus"):
   when a firm has an ACTIVE credit account here, credit pulls on that firm's files
   run on the firm's own Xactus login; otherwise every pull uses our shared company
   account, unchanged. Flood is always on our account.

   Firm onboarding is gated `manage_team` (the router default). Setting a firm's own
   credit login is more sensitive, so it needs `platform_setup`; viewing its status
   (presence only, never the password) stays on manage_team.

   HARD RULE (owner-directed): all text is DARK on the white portal — explicit
   #141B22 / #4B585C, never a var(--ink*) token (those resolve LIGHT). */

const INK = '#141B22';
const MUTED = '#4B585C';

function CardHead({ title, right, sub }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, color: INK }}>{title}</h3>
        {right || null}
      </div>
      {sub ? <div className="small" style={{ color: MUTED, marginTop: 4 }}>{sub}</div> : null}
    </div>
  );
}

function StatusPill({ status }) {
  const map = { active: 'sw-approved', suspended: 'sw-pending', closed: 'sw-insp' };
  const label = { active: 'Active', suspended: 'Suspended', closed: 'Closed' };
  return <span className={'pill ' + (map[status] || 'sw-insp')}>{label[status] || status}</span>;
}

export default function StaffTpoFirms() {
  const { can } = useAuth();
  const canManage = can('manage_team');
  const [firms, setFirms] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [draft, setDraft] = useState({ name: '', nmls: '', notes: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.adminTpoFirms()
      .then((d) => setFirms(d.firms || []))
      .catch((e) => setErr(e?.data?.error || e.message || 'Could not load firms.'));
  }, []);
  useEffect(() => { if (canManage) load(); }, [canManage, load]);

  async function createFirm() {
    const name = draft.name.trim();
    if (!name) { setErr('Enter the firm name.'); return; }
    setBusy(true); setMsg(''); setErr('');
    try {
      await api.adminCreateTpoFirm({ name, nmls: draft.nmls.trim(), notes: draft.notes.trim() });
      setMsg(`Created ${name}.`); setDraft({ name: '', nmls: '', notes: '' }); load();
    } catch (e) { setErr(e?.data?.error || e.message || 'Could not create the firm.'); }
    finally { setBusy(false); }
  }

  if (!canManage) return <div className="wrap"><div className="panel" style={{ color: INK }}>You don't have access to broker firms.</div></div>;

  return (
    <div className="wrap">
      <div className="dd-wrap">
        <div className="dd-head">
          <div>
            <h1 className="dd-title" style={{ color: INK }}>Broker firms</h1>
            <div className="dd-sub" style={{ color: MUTED }}>Onboard a brokerage firm, invite its lead broker, and — if the firm pulls credit on its own Xactus account — set that up here.</div>
          </div>
        </div>

        {/* Add a firm */}
        <div className="dd-card">
          <CardHead title="Add a firm" sub="Create the firm, then invite its lead broker below. The lead broker invites the rest of their team from inside the broker portal." />
          <div className="grid cols-3" style={{ gap: 12 }}>
            <label className="small" style={{ color: INK }}>Firm name
              <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Acme Mortgage Brokers" />
            </label>
            <label className="small" style={{ color: INK }}>NMLS # (optional)
              <input className="input" value={draft.nmls} onChange={(e) => setDraft({ ...draft, nmls: e.target.value })} placeholder="e.g. 1234567" />
            </label>
            <label className="small" style={{ color: INK }}>Internal notes (optional)
              <input className="input" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="anything to remember" />
            </label>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 12, alignItems: 'center' }}>
            <button className="btn btn-sm primary" disabled={busy || !draft.name.trim()} onClick={createFirm}>Create firm</button>
            {msg && <span className="small" style={{ color: 'var(--success)', fontWeight: 600 }}>{msg}</span>}
            {err && <span className="small" style={{ color: 'var(--danger,#B4453C)', fontWeight: 600 }}>{err}</span>}
          </div>
        </div>

        {/* Firm list */}
        <div className="dd-card">
          <CardHead title={`Firms (${firms.length})`} />
          {firms.length === 0 && <div className="small" style={{ color: MUTED }}>No firms yet — add one above.</div>}
          {firms.map((f) => (
            <div key={f.id} style={{ borderTop: '1px solid var(--line)', padding: '12px 0' }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <div>
                  <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                    <b style={{ color: INK }}>{f.name}</b>
                    <StatusPill status={f.status} />
                  </div>
                  <div className="small" style={{ color: MUTED, marginTop: 2 }}>
                    {f.nmls ? `NMLS ${f.nmls} · ` : ''}{f.user_count} user{Number(f.user_count) === 1 ? '' : 's'} · {f.file_count} file{Number(f.file_count) === 1 ? '' : 's'}
                  </div>
                </div>
                <button className="btn btn-sm ghost" onClick={() => setOpenId(openId === f.id ? null : f.id)}>
                  {openId === f.id ? 'Close' : 'Manage'}
                </button>
              </div>
              {openId === f.id && <FirmDetail firm={f} onChanged={load} />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* One firm's detail: team + invites, suspend/activate, and its own-Xactus credit account. */
function FirmDetail({ firm, onChanged }) {
  const { can } = useAuth();
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    api.adminTpoFirm(firm.id)
      .then(setDetail)
      .catch((e) => setErr(e?.data?.error || e.message || 'Could not load the firm.'));
  }, [firm.id]);
  useEffect(() => { load(); }, [load]);

  async function setStatus(status) {
    const verb = status === 'active' ? 'reactivate' : status === 'suspended' ? 'suspend' : 'close';
    if (status !== 'active' && !(await askConfirm(`${verb[0].toUpperCase() + verb.slice(1)} ${firm.name}? Their brokers are signed out immediately.`))) return;
    setErr('');
    try { await api.adminTpoFirmStatus(firm.id, status); load(); onChanged && onChanged(); }
    catch (e) { setErr(e?.data?.error || e.message || 'Could not change the firm status.'); }
  }

  return (
    <div style={{ marginTop: 12, padding: '14px 16px', borderRadius: 10, background: 'var(--surface-soft,#F4F1EA)', border: '1px solid var(--line)' }}>
      {err && <div className="small" style={{ color: 'var(--danger,#B4453C)', fontWeight: 600, marginBottom: 8 }}>{err}</div>}

      {/* Status controls */}
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <span className="small" style={{ color: MUTED }}>Firm status:</span>
        <StatusPill status={detail?.firm?.status || firm.status} />
        {(detail?.firm?.status || firm.status) !== 'active'
          ? <button className="btn btn-sm ghost" onClick={() => setStatus('active')}>Reactivate</button>
          : <button className="btn btn-sm ghost" onClick={() => setStatus('suspended')}>Suspend</button>}
        {(detail?.firm?.status || firm.status) !== 'closed' && <button className="btn btn-sm ghost" onClick={() => setStatus('closed')}>Close</button>}
      </div>

      {/* Own-Xactus credit account (the point of Phase 5b) */}
      <CreditAccountCard firmId={firm.id} firmName={firm.name} canSet={can('platform_setup')} />

      {/* Special pricing for this firm (owner-directed 2026-08-06) */}
      <FirmPricingCard firmId={firm.id} firmName={firm.name} canSet={can('platform_setup')} />

      {/* Team + invites */}
      <TeamPanel firm={firm} detail={detail} onChanged={load} />
    </div>
  );
}

/* Team roster + pending invites + invite form. */
function TeamPanel({ firm, detail, onChanged }) {
  const [invite, setInvite] = useState({ email: '', fullName: '', role: 'tpo_officer', isFirmAdmin: false });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);   // { token, acceptUrl, emailed }
  const [err, setErr] = useState('');
  const firmActive = (detail?.firm?.status || firm.status) === 'active';

  async function sendInvite() {
    const email = invite.email.trim();
    if (!email) { setErr('Enter an email.'); return; }
    setBusy(true); setErr(''); setResult(null);
    try {
      const r = await api.adminInviteTpoUser(firm.id, {
        email, fullName: invite.fullName.trim(), role: invite.role, isFirmAdmin: invite.isFirmAdmin,
      });
      setResult(r); setInvite({ email: '', fullName: '', role: invite.role, isFirmAdmin: false }); onChanged && onChanged();
    } catch (e) { setErr(e?.data?.error || e.message || 'Could not send the invite.'); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ marginTop: 14 }}>
      <div className="small" style={{ fontWeight: 700, color: INK, marginBottom: 6 }}>Team</div>
      {detail?.users?.length ? (
        <div style={{ marginBottom: 8 }}>
          {detail.users.map((u) => (
            <div key={u.id} className="row" style={{ justifyContent: 'space-between', gap: 8, padding: '4px 0' }}>
              <span className="small" style={{ color: INK }}>
                {u.full_name || u.email}
                {u.is_firm_admin ? <span className="pill sw-approved" style={{ marginLeft: 6 }}>Lead</span> : null}
                {!u.is_active ? <span className="pill sw-insp" style={{ marginLeft: 6 }}>Off</span> : null}
              </span>
              <span className="small" style={{ color: MUTED }}>{u.role === 'tpo_processor' ? 'Processor' : 'Loan officer'}{u.has_login ? '' : ' · invited'}</span>
            </div>
          ))}
        </div>
      ) : <div className="small" style={{ color: MUTED, marginBottom: 8 }}>No users yet.</div>}

      {detail?.pendingInvites?.length ? (
        <div className="small" style={{ color: MUTED, marginBottom: 8 }}>
          Pending invites: {detail.pendingInvites.map((i) => i.email).join(', ')}
        </div>
      ) : null}

      {firmActive ? (
        <div style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          <div className="small" style={{ fontWeight: 700, color: INK, marginBottom: 6 }}>Invite a user</div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input className="input" style={{ width: 220 }} placeholder="email@firm.com" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} />
            <input className="input" style={{ width: 160 }} placeholder="Full name (optional)" value={invite.fullName} onChange={(e) => setInvite({ ...invite, fullName: e.target.value })} />
            <select className="input" style={{ width: 150 }} value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>
              <option value="tpo_officer">Loan officer (broker)</option>
              <option value="tpo_processor">Processor</option>
            </select>
            <label className="small row" style={{ gap: 6, alignItems: 'center', color: INK }}>
              <input type="checkbox" checked={invite.isFirmAdmin} onChange={(e) => setInvite({ ...invite, isFirmAdmin: e.target.checked })} /> Lead broker
              <InfoTip tip="The lead broker can invite and manage the rest of their firm's team from inside the broker portal." />
            </label>
            <button className="btn btn-sm primary" disabled={busy || !invite.email.trim()} onClick={sendInvite}>Send invite</button>
          </div>
          {result && (
            <div className="small" style={{ color: INK, marginTop: 8 }}>
              Invite created. {result.emailed ? 'The email was sent.' : 'Email is off — share this link with them:'}
              {!result.emailed && result.acceptUrl && (
                <input className="input" readOnly value={result.acceptUrl} onFocus={(e) => e.target.select()} style={{ marginTop: 4, width: '100%' }} />
              )}
            </div>
          )}
          {err && <div className="small" style={{ color: 'var(--danger,#B4453C)', fontWeight: 600, marginTop: 8 }}>{err}</div>}
        </div>
      ) : (
        <div className="small" style={{ color: MUTED }}>Reactivate the firm to invite users.</div>
      )}
    </div>
  );
}

/* A firm's OWN Xactus credit account (own-Xactus, Phase 5b).
   The password is write-only: never shown, only set/replaced. When nothing is set,
   the firm's files use our shared company account — this whole card is optional. */
function CreditAccountCard({ firmId, firmName, canSet }) {
  const [status, setStatus] = useState(null);
  const [form, setForm] = useState(blankForm());
  const [showAdv, setShowAdv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  function blankForm() {
    return { endpoint: '', username: '', password: '', account: '', clientId: '', version: '', requestingParty: '', authMode: 'basic' };
  }

  const load = useCallback(() => {
    api.adminTpoFirmCredit(firmId)
      .then((d) => setStatus(d.credit || { configured: false, isActive: false }))
      .catch((e) => setErr(e?.data?.error || e.message || 'Could not load the credit account.'));
  }, [firmId]);
  useEffect(() => { load(); }, [load]);

  async function save() {
    if (!form.endpoint.trim() || !form.username.trim() || !form.password) {
      setErr('The Xactus web address, username and password are all required.'); return;
    }
    setBusy(true); setMsg(''); setErr(''); setTest(null);
    try {
      const d = await api.adminTpoFirmCreditSet(firmId, {
        endpoint: form.endpoint.trim(), username: form.username.trim(), password: form.password,
        account: form.account.trim(), clientId: form.clientId.trim(), version: form.version.trim(),
        requestingParty: form.requestingParty.trim(), authMode: form.authMode,
      });
      setStatus(d.credit); setForm(blankForm()); setShowAdv(false); setMsg('Credit account saved.');
    } catch (e) { setErr(e?.data?.error || e.message || 'Could not save the credit account.'); }
    finally { setBusy(false); }
  }
  async function toggleActive(active) {
    setBusy(true); setMsg(''); setErr(''); setTest(null);
    try { const d = await api.adminTpoFirmCreditActive(firmId, active); setStatus(d.credit); setMsg(active ? 'Turned on.' : 'Turned off.'); }
    catch (e) { setErr(e?.data?.error || e.message || 'Could not change that.'); }
    finally { setBusy(false); }
  }
  async function clearAccount() {
    if (!(await askConfirm(`Remove ${firmName}'s own credit account? Their files will go back to our shared account.`))) return;
    setBusy(true); setMsg(''); setErr(''); setTest(null);
    try { const d = await api.adminTpoFirmCreditClear(firmId); setStatus(d.credit); setMsg('Removed — this firm now uses our shared account.'); }
    catch (e) { setErr(e?.data?.error || e.message || 'Could not remove it.'); }
    finally { setBusy(false); }
  }
  async function runTest() {
    setBusy(true); setMsg(''); setErr(''); setTest(null);
    try { setTest(await api.adminTpoFirmCreditTest(firmId)); }
    catch (e) { setErr(e?.data?.error || e.message || 'Could not test the connection.'); }
    finally { setBusy(false); }
  }

  const configured = !!status?.configured;

  return (
    <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="small" style={{ fontWeight: 700, color: INK }}>Own credit account (Xactus)</div>
        {configured
          ? <span className={'pill ' + (status.isActive ? 'sw-approved' : 'sw-insp')}>{status.isActive ? 'On — pulls on the firm’s login' : 'Off — using our account'}</span>
          : <span className="pill sw-insp">Using our shared account</span>}
        <InfoTip tip="Optional. When a firm has its own credit account turned on here, credit pulls on that firm's files use the firm's Xactus login. Otherwise every pull uses our shared company account. Flood is always ordered on our account. The password is stored securely and never shown again." />
      </div>

      {configured && (
        <div className="small" style={{ color: MUTED, marginTop: 6 }}>
          {status.endpoint} · user <b style={{ color: INK }}>{status.username}</b>{status.hasPassword ? ' · password saved ✓' : ''}
          {status.authMode ? ` · login sent by ${status.authMode === 'query' ? 'web address' : 'header'}` : ''}
        </div>
      )}

      {canSet ? (
        <>
          {configured && (
            <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <button className="btn btn-sm ghost" disabled={busy} onClick={runTest}>Test connection</button>
              {status.isActive
                ? <button className="btn btn-sm ghost" disabled={busy} onClick={() => toggleActive(false)}>Turn off</button>
                : <button className="btn btn-sm ghost" disabled={busy} onClick={() => toggleActive(true)}>Turn on</button>}
              <button className="btn btn-sm ghost" disabled={busy} onClick={clearAccount}>Remove</button>
            </div>
          )}

          {test && (
            <div className="small" style={{ marginTop: 8, color: test.live ? 'var(--success)' : (test.configured ? 'var(--danger,#B4453C)' : MUTED), fontWeight: 600 }}>
              {test.live ? 'Reachable ✓' : test.configured ? 'Could not reach it' : 'Not configured'}{test.detail ? ` — ${test.detail}` : ''}
            </div>
          )}

          {/* Set / replace credentials */}
          <div style={{ marginTop: 12 }}>
            <div className="small" style={{ fontWeight: 700, color: INK, marginBottom: 6 }}>{configured ? 'Replace the login' : 'Set up the firm’s credit login'}</div>
            <div className="grid cols-3" style={{ gap: 10 }}>
              <label className="small" style={{ color: INK }}>Xactus web address
                <input className="input" placeholder="https://…" value={form.endpoint} onChange={(e) => setForm({ ...form, endpoint: e.target.value })} />
              </label>
              <label className="small" style={{ color: INK }}>Username
                <input className="input" autoComplete="off" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
              </label>
              <label className="small" style={{ color: INK }} data-cobrowse-block="credential">Password
                <input className="input" type="password" autoComplete="new-password" placeholder={configured ? 'enter a new password' : ''} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              </label>
            </div>
            <button className="btn btn-sm ghost" type="button" style={{ marginTop: 8 }} onClick={() => setShowAdv(!showAdv)}>
              {showAdv ? 'Hide advanced settings' : 'Advanced settings'}
            </button>
            {showAdv && (
              <div className="grid cols-3" style={{ gap: 10, marginTop: 8 }}>
                <label className="small" style={{ color: INK }}>How the login is sent
                  <select className="input" value={form.authMode} onChange={(e) => setForm({ ...form, authMode: e.target.value })}>
                    <option value="basic">Header (Basic auth) — default</option>
                    <option value="query">In the web address (query)</option>
                  </select>
                </label>
                <label className="small" style={{ color: INK }}>Account (optional)
                  <input className="input" value={form.account} onChange={(e) => setForm({ ...form, account: e.target.value })} />
                </label>
                <label className="small" style={{ color: INK }}>Client ID (optional)
                  <input className="input" value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} />
                </label>
                <label className="small" style={{ color: INK }}>Version (optional)
                  <input className="input" placeholder="leave blank for the default" value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} />
                </label>
                <label className="small" style={{ color: INK }}>Requesting party (optional)
                  <input className="input" value={form.requestingParty} onChange={(e) => setForm({ ...form, requestingParty: e.target.value })} />
                </label>
              </div>
            )}
            <div className="row" style={{ gap: 8, marginTop: 10, alignItems: 'center' }}>
              <button className="btn btn-sm primary" disabled={busy} onClick={save}>{configured ? 'Replace login' : 'Save credit account'}</button>
              {msg && <span className="small" style={{ color: 'var(--success)', fontWeight: 600 }}>{msg}</span>}
              {err && <span className="small" style={{ color: 'var(--danger,#B4453C)', fontWeight: 600 }}>{err}</span>}
            </div>
          </div>
        </>
      ) : (
        <div className="small" style={{ color: MUTED, marginTop: 6 }}>
          Only a platform administrator can set up a firm's own credit login.
          {err && <span style={{ color: 'var(--danger,#B4453C)', fontWeight: 600, marginLeft: 6 }}>{err}</span>}
        </div>
      )}
    </div>
  );
}

/* A firm's special PRICING overrides (owner-directed 2026-08-06) — markup +
   origination just for this broker firm's files. A blank box uses the TPO channel
   default (which uses retail). The broker never sets the rate; the firm's OWN
   broker fee is set by the firm in their portal and shown here read-only.
   platform_setup to change. Dark text on white per the HARD RULE. */
const FP_KEYS = ['markupStdPct', 'markupGoldPct', 'markupSilverPct', 'markupSpeedPct', 'origStdPct', 'origGoldPct', 'origSilverPct', 'origSpeedPct'];
// Speed (owner reversal of D5, 2026-09-03) has knobs of its own, per firm like Silver's.
// It charges the higher of the two parents' rates with both run at the Speed margin;
// Silver's engine caps a margin at 1.00%, so above that it is earned only when
// Standard sets the rate — the label says so where the hint would not fit.
export const FP_ROWS = [
  { k: 'markupStdPct', label: 'Standard markup (%)' },
  { k: 'markupGoldPct', label: 'Gold markup (%)' },
  { k: 'markupSilverPct', label: 'Silver markup (%, max 1)' },
  { k: 'markupSpeedPct', label: 'Speed markup (%; above 1 earned only when Standard sets the rate)' },
  { k: 'origStdPct', label: 'Standard origination (%)' },
  { k: 'origGoldPct', label: 'Gold origination (%)' },
  { k: 'origSilverPct', label: 'Silver origination (%)' },
  { k: 'origSpeedPct', label: 'Speed origination (%)' },
];
const fpToForm = (o) => { const f = {}; for (const k of FP_KEYS) f[k] = (o && o[k] != null) ? String(o[k]) : ''; return f; };

function FirmPricingCard({ firmId, firmName, canSet }) {
  const [data, setData] = useState(null);   // { firm, fallback, effective }
  const [form, setForm] = useState(fpToForm(null));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    api.adminTpoFirmPricing(firmId)
      .then((d) => { setData(d); setForm(fpToForm(d.firm)); })
      .catch((e) => setErr(e?.data?.error || e.message || 'Could not load the firm pricing.'));
  }, [firmId]);
  useEffect(() => { load(); }, [load]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: String(v).replace(/[^0-9.]/g, '') }));

  async function save() {
    setBusy(true); setMsg(''); setErr('');
    try {
      const body = {};
      for (const k of FP_KEYS) body[k] = form[k] === '' ? null : Number(form[k]);
      const d = await api.adminTpoFirmPricingSet(firmId, body);
      setForm(fpToForm(d.firm)); setMsg('Saved.'); load();
    } catch (e) { setErr(e?.data?.error || e.message || 'Could not save.'); }
    finally { setBusy(false); }
  }
  async function clearAll() {
    if (!(await askConfirm(`Clear ${firmName}'s special pricing? Their files go back to the TPO channel defaults.`))) return;
    setBusy(true); setMsg(''); setErr('');
    try { const d = await api.adminTpoFirmPricingClear(firmId); setForm(fpToForm(d.firm)); setMsg('Cleared — back to the channel defaults.'); load(); }
    catch (e) { setErr(e?.data?.error || e.message || 'Could not clear.'); }
    finally { setBusy(false); }
  }

  if (!data) return null;
  const fb = data.fallback || {};
  const brokerFee = data.firm ? data.firm.brokerFeePct : null;

  return (
    <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12, marginTop: 12 }}>
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="small" style={{ fontWeight: 700, color: INK }}>Special pricing for this firm</div>
        <InfoTip tip="Optional. Markup and origination just for this broker firm's files. A blank box uses the TPO channel default (which uses retail). The rate is never something the broker controls; the firm sets only their own broker fee." />
      </div>
      <div className="small" style={{ color: MUTED, marginTop: 4 }}>
        This firm’s own broker fee: <b style={{ color: INK }}>{brokerFee != null ? brokerFee + '%' : 'none'}</b> — set by the firm in their portal.
      </div>
      {canSet ? (
        <>
          <div className="grid cols-3" style={{ gap: 10, marginTop: 10 }}>
            {FP_ROWS.map((r) => (
              <label key={r.k} className="small" style={{ color: INK }}>{r.label}
                <input className="input" inputMode="decimal" value={form[r.k]}
                  placeholder={fb[r.k] != null ? `default ${fb[r.k]}%` : 'default'}
                  onChange={(e) => set(r.k, e.target.value)} />
              </label>
            ))}
          </div>
          <div className="row" style={{ gap: 8, marginTop: 10, alignItems: 'center' }}>
            <button className="btn btn-sm primary" disabled={busy} onClick={save}>Save special pricing</button>
            <button className="btn btn-sm ghost" disabled={busy} onClick={clearAll}>Clear (use channel defaults)</button>
            {msg && <span className="small" style={{ color: 'var(--success)', fontWeight: 600 }}>{msg}</span>}
            {err && <span className="small" style={{ color: 'var(--danger,#B4453C)', fontWeight: 600 }}>{err}</span>}
          </div>
        </>
      ) : (
        <div className="small" style={{ color: MUTED, marginTop: 6 }}>Only a platform administrator can set special pricing for a firm.</div>
      )}
    </div>
  );
}
