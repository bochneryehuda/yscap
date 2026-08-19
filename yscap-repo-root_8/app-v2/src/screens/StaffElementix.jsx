import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { askConfirm } from '../lib/dialog.js';

/**
 * ELEMENTIX — the admin desk. Who our Elementix users are, which PILOT officer
 * each one is, and the import of everything they have already looked up.
 *
 * ── WHY THERE ARE TWO LISTS AND NOT ONE ─────────────────────────────────────
 * "Connections" is who has approved an OAuth login HERE. Under the shared model
 * the owner chose, that is usually the single company connection and nothing
 * else — it says almost nothing about who uses Elementix.
 *
 * "Elementix users" is who has actually DONE something over there, derived from
 * the email stamped on every contact the office has unlocked. THAT is the list
 * the owner asked for, and it is the one that turns out to be true: thirteen
 * logins on this account, and the two lists barely overlap.
 *
 * Every text colour is an explicit dark hex — the `--ink*` tokens in this
 * palette are LIGHT, so `color: var(--ink)` renders white on white.
 */

const INK = '#141B22';
const MUTED = '#4B585C';
const LINE = '#E4DECF';

const day = (v) => (v ? String(v).slice(0, 10) : '—');
const n = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : '—');

export default function StaffElementix() {
  const [roster, setRoster] = useState(null);
  const [team, setTeam] = useState([]);
  const [usage, setUsage] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [listed, setListed] = useState(null);

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 4200); };

  const load = () => {
    api.elxConnections().then(setRoster).catch((e) => setErr(e.message));
    api.elxUsage().then(setUsage).catch(() => {});
    api.staffTeam().then(setTeam).catch(() => {});
  };
  useEffect(load, []);

  const runList = async () => {
    const yes = await askConfirm(
      'Read the whole history from Elementix? This lists every contact the office has ever unlocked and who unlocked it. It uses a handful of lookups and spends no credits.',
      { confirmLabel: 'Read the history' });
    if (!yes) return;
    setErr(''); setBusy('list');
    try {
      const out = await api.elxBackfillList();
      setListed(out);
      load();
      if (out.partial) {
        flash(`Read ${n(out.peopleSeen)} so far, then Elementix stopped answering on page ${out.partial.page}. Press it again to carry on.`);
      } else {
        flash(`Found ${n(out.peopleSeen)} unlocked contacts across ${out.users.length} Elementix logins. ${n(out.newlyQueued)} are new.`);
      }
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  const runWork = async () => {
    setErr(''); setBusy('work');
    try {
      const out = await api.elxBackfillWork(50);
      load();
      flash(`Brought in ${n(out.worked)} — ${n(out.leads)} became leads${out.noOfficer ? `, ${n(out.noOfficer)} are waiting on whose login it was` : ''}. ${n(out.remaining)} left.`);
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  const link = async (email, staffId) => {
    setErr(''); setBusy(`link:${email}`);
    try {
      // Clearing the dropdown UN-links; it never means "nobody here", which is
      // its own deliberate button below — the two are different answers.
      const out = await api.elxLinkUser({ email, staffId: staffId || null, ignore: false });
      load();
      flash(out.requeued
        ? `Linked. ${n(out.requeued)} contact(s) already imported for that login will become their leads on the next import.`
        : 'Linked.');
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  const ignore = async (email) => {
    const yes = await askConfirm(`Mark ${email} as nobody here? Contacts it unlocked stay imported, but no lead is made for them.`, { confirmLabel: 'Nobody here' });
    if (!yes) return;
    setBusy(`link:${email}`);
    try { await api.elxLinkUser({ email, staffId: null, ignore: true }); load(); flash('Noted.'); }
    catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  if (!roster) return <div className="panel pad" style={{ color: MUTED }}>{err || 'Loading…'}</div>;

  const users = roster.users || [];
  const bf = roster.backfill;
  const officers = team.filter((m) => !m.is_external);

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-h"><h3>Elementix</h3></div>
        <div className="panel-b">
          {err && <div role="alert" className="notice err" style={{ marginBottom: 10 }}>{err}</div>}
          {msg && <div className="notice ok" style={{ marginBottom: 10 }}>{msg}</div>}
          <p style={{ color: MUTED, fontSize: 14, marginTop: 0 }}>
            Elementix is used two ways here. The back office uses it to verify a borrower’s track record —
            that is untouched by anything on this page. This page is the CRM side: the contacts your officers
            look up, and the leads they become.
          </p>
          {usage && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Stat label="Lookups this hour" value={`${n(usage.hourCount)} of ${n(usage.hourCap)}`} />
              <Stat label="Paid unlocks this month" value={`${n(usage.paidCount)} of ${n(usage.paidCap)}`} />
              <Stat label="Shared office ceiling" value={`${n(usage.platformCeilingPerHour)} an hour`} />
              <Stat label="Connection" value={usage.enabled ? (usage.dryrun ? 'On (test mode)' : 'On') : 'Off'} />
            </div>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-h" style={{ flexWrap: 'wrap', gap: 8 }}>
          <h3>Our Elementix users</h3>
          <span style={{ color: MUTED, fontSize: 13 }}>{users.length} login(s) seen</span>
          <span style={{ flex: 1 }} />
          <button className="btn primary btn-sm" disabled={!!busy} onClick={runList}>
            {busy === 'list' ? 'Reading…' : 'Read the history from Elementix'}
          </button>
        </div>
        <div className="panel-b">
          <p style={{ color: MUTED, fontSize: 14, marginTop: 0 }}>
            Elementix stamps every unlocked contact with the email of whoever unlocked it. This is that list —
            so it shows who really uses Elementix, not who happens to have signed in here.
            Matching is on the exact email address and nothing else: two of these differ by one letter,
            so a clever guess would put one officer’s leads in another’s pipeline.
          </p>
          {!users.length && (
            <div style={{ color: MUTED, fontSize: 14 }}>
              Nothing read yet. Press <strong style={{ color: INK }}>Read the history from Elementix</strong> above — it costs no credits.
            </div>
          )}
          {users.length > 0 && (
            <div style={{ overflowX: 'auto', border: `1px solid ${LINE}`, borderRadius: 10, background: '#FFFFFF' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
                <thead><tr>
                  {['Elementix login', 'Contacts unlocked', 'First', 'Last', 'PILOT officer'].map((h) => (
                    <th key={h} style={{ textAlign: 'left', padding: '9px 11px', color: MUTED, fontSize: 11, letterSpacing: '.05em', textTransform: 'uppercase', fontWeight: 700, borderBottom: `1px solid ${LINE}` }}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.email} style={{ borderBottom: `1px solid ${LINE}` }}>
                      <td style={{ padding: '9px 11px', color: INK, fontWeight: 600 }}>{u.email}</td>
                      <td style={{ padding: '9px 11px', color: INK }}>{n(u.unlocks)}</td>
                      <td style={{ padding: '9px 11px', color: MUTED }}>{day(u.firstAt)}</td>
                      <td style={{ padding: '9px 11px', color: MUTED }}>{day(u.lastAt)}</td>
                      <td style={{ padding: '9px 11px' }}>
                        {u.ignored ? <span style={{ color: MUTED }}>Nobody here</span> : (
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                            <select className="input" style={{ fontSize: 16, minWidth: 180 }}
                              value={u.officer ? u.officer.id : ''}
                              disabled={busy === `link:${u.email}`}
                              onChange={(e) => link(u.email, e.target.value)}>
                              <option value="">— not linked —</option>
                              {officers.map((o) => <option key={o.id} value={o.id}>{o.full_name}</option>)}
                            </select>
                            {!u.officer && (
                              <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => ignore(u.email)}>Nobody here</button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {listed && listed.unmatchedUsers && listed.unmatchedUsers.length > 0 && (
            <div style={{ border: '1px solid #D9A441', background: '#FDF6E7', borderRadius: 10, padding: '10px 12px', color: INK, fontSize: 14, marginTop: 12 }}>
              {listed.unmatchedUsers.length} Elementix login(s) don’t match anybody on the team by email.
              Pick the officer above, or say nobody here — their contacts are imported either way, only the leads wait.
            </div>
          )}
        </div>
      </div>

      {bf && bf.total > 0 && (
        <div className="panel">
          <div className="panel-h" style={{ flexWrap: 'wrap', gap: 8 }}>
            <h3>Bringing the history in</h3>
            <span style={{ flex: 1 }} />
            {bf.pending > 0 && (
              <button className="btn primary btn-sm" disabled={!!busy} onClick={runWork}>
                {busy === 'work' ? 'Bringing in…' : `Bring in the next ${Math.min(50, bf.pending)}`}
              </button>
            )}
          </div>
          <div className="panel-b">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
              <Stat label="Found" value={n(bf.total)} />
              <Stat label="Brought in" value={n(bf.done)} />
              <Stat label="Still to do" value={n(bf.pending)} />
              <Stat label="Waiting on a login" value={n(bf.skipped)} />
              <Stat label="Wouldn’t read" value={n(bf.failed)} />
            </div>
            <p style={{ color: MUTED, fontSize: 14, margin: 0 }}>
              Each contact is read back from Elementix in full — every phone number with its carrier and how sure
              they are, every email address with whether it is live or risky — and becomes a lead for the officer
              whose login unlocked it. None of this spends a credit: these were all paid for already.
              {bf.skipped > 0 && ' The ones waiting need somebody to say whose login that was, above.'}
              {bf.failed > 0 && ' The ones it wouldn’t read were tried three times and left alone rather than guessed at.'}
            </p>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-h"><h3>Connections</h3></div>
        <div className="panel-b">
          <p style={{ color: MUTED, fontSize: 14, marginTop: 0 }}>
            The login PILOT itself connects with. One shared super-admin connection runs everything —
            the back office’s track-record checks and this CRM side both — which is why this list is short
            and the one above is not.
          </p>
          {(roster.connections || []).map((c) => (
            <div key={c.staffId || 'company'} style={{ border: `1px solid ${LINE}`, borderRadius: 10, padding: '10px 12px', marginBottom: 8, background: '#FFFFFF' }}>
              <div style={{ color: INK, fontWeight: 600 }}>
                {c.scope === 'company' ? 'Company-wide connection' : (c.officer && c.officer.name) || 'An officer'}
              </div>
              <div style={{ color: MUTED, fontSize: 13 }}>
                {c.elementix && c.elementix.user ? `Elementix: ${c.elementix.user}` : 'Elementix name not read yet'}
                {c.elementix && c.elementix.email ? ` · ${c.elementix.email}` : ''}
                {c.connectedAt ? ` · connected ${day(c.connectedAt)}` : ''}
                {c.selfRenewing ? ' · renews itself' : ''}
              </div>
              {c.emailMismatch && (
                <div style={{ color: '#8A6100', fontSize: 13, marginTop: 4 }}>
                  The Elementix account uses a different email address from this person’s PILOT login — worth a look, but not necessarily wrong.
                </div>
              )}
              {c.lastError && <div style={{ color: '#8A2E2E', fontSize: 13, marginTop: 4 }}>Last problem: {c.lastError}</div>}
            </div>
          ))}
          {!(roster.connections || []).length && (
            <div style={{ color: MUTED, fontSize: 14 }}>Nothing is connected yet — connect Elementix on the API Health page.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, padding: '9px 12px', background: '#FFFFFF', minWidth: 132 }}>
      <div style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: MUTED, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 650, color: INK, marginTop: 2 }}>{value}</div>
    </div>
  );
}
