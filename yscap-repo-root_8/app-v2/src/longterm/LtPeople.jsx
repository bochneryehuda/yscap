import React, { useCallback, useEffect, useState } from 'react';
import LtLayout from './LtLayout.jsx';
import { ltApi } from './api.js';
import { ltPost } from './http.js';
import { day } from './format.js';

/**
 * THE PEOPLE MAP — which PILOT person each Encompass login is.
 *
 * Owner-directed: auto-match by email, ADMIN CONFIRMS. So every proposal on this
 * screen is a suggestion, and nothing takes effect until somebody presses Confirm.
 *
 * A row with no proposal says WHY in plain words — a shared placeholder address,
 * two people on one mailbox, nobody in PILOT using it — because "unmatched" alone
 * sends an admin hunting for a reason the server already knows.
 *
 * Anyone may READ this: an officer with an empty pipeline has to be able to see
 * that nobody has linked their account yet. Only an admin sees the buttons.
 */
export default function LtPeople() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState('');
  // Said INLINE rather than in a modal: Long-Term may not import RTL's dialog
  // module (the gate refuses it), and on a table the answer belongs beside the
  // row that produced it anyway.
  const [note, setNote] = useState('');
  // The MANUAL pick, per login (owner-directed 2026-08-23: "the system never let
  // me confirm my name because of this [shared email] … please manually leave
  // this one for me"). The matcher rightly refuses an ambiguous email, so an
  // admin must be able to decide by hand — the server's confirm door has always
  // accepted any (login, person) pair; the screen just never offered one.
  const [pick, setPick] = useState({});

  const load = useCallback(() => {
    setErr(null);
    ltApi.people().then(setData).catch((e) => setErr(e.message || 'Could not load the people map.'));
  }, []);
  useEffect(load, [load]);

  const act = async (loginId, fn, label) => {
    setBusy(loginId);
    setNote('');
    try { await fn(); load(); }
    catch (e) { setNote(e.message || `Could not ${label}.`); }
    finally { setBusy(''); }
  };

  const sync = async () => {
    setBusy('__sync');
    setNote('');
    try {
      const out = await ltApi.syncRoster();
      setNote(`Read ${out.users} Encompass users. ${out.suggested} match a PILOT person and are waiting for you to confirm them.`);
      load();
    } catch (e) { setNote(e.message || 'Could not read the Encompass roster.'); }
    finally { setBusy(''); }
  };

  const th = { textAlign: 'left', fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase',
    color: '#4B585C', fontWeight: 700, padding: '8px 10px' };
  const td = { padding: '10px', fontSize: 14, color: '#141B22', borderTop: '1px solid #EAE4D7', verticalAlign: 'top' };

  const chip = (status) => {
    const map = {
      confirmed: ['#1F6F43', '#E6F4EC', 'Confirmed'],
      suggested: ['#8A6A17', '#FBF3DF', 'Waiting for you'],
      rejected: ['#8A2A2A', '#F8E9E9', 'Not this person'],
      none: ['#4B585C', '#F0EDE6', 'Not linked'],
    };
    const [fg, bg, label] = map[status] || map.none;
    return <span style={{ color: fg, background: bg, padding: '2px 9px', borderRadius: 999,
      fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>{label}</span>;
  };

  return (
    <LtLayout title="Team">
      <p style={{ margin: '0 0 14px', color: '#4B585C', maxWidth: 720, lineHeight: 1.55 }}>
        Encompass names the people on every long-term file by their login. This is where each
        login is matched to the person in PILOT — which is what puts a file in somebody&rsquo;s
        pipeline. We suggest a match by email; you decide.
      </p>

      {data && data.canManage && (
        <button className="btn" onClick={sync} disabled={busy === '__sync'} style={{ marginBottom: 14 }}>
          {busy === '__sync' ? 'Reading Encompass…' : 'Read the Encompass roster'}
        </button>
      )}

      {note && <div className="card" style={{ color: '#141B22', marginBottom: 12 }}>{note}</div>}
      {err && <div className="card" style={{ color: '#141B22' }}>{err}</div>}
      {data && !data.people.length && (
        <div className="card" style={{ color: '#141B22' }}>
          No Encompass users yet. {data.canManage ? 'Read the roster to bring them in.'
            : 'An administrator needs to read the Encompass roster first.'}
        </div>
      )}

      {data && data.people.length > 0 && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
            <thead><tr>
              <th style={th}>Encompass user</th><th style={th}>In PILOT</th>
              <th style={th}>State</th>{data.canManage && <th style={th}>Action</th>}
            </tr></thead>
            <tbody>
              {data.people.map((p) => (
                <tr key={p.loginId}>
                  <td style={td}>
                    <div style={{ fontWeight: 600 }}>{p.name || p.loginId}</div>
                    <div style={{ fontSize: 12, color: '#4B585C' }}>
                      {p.loginId}{p.email ? ` · ${p.email}` : ''}{p.active ? '' : ' · disabled'}
                    </div>
                    {/* WHAT THEY DO IN ENCOMPASS. The roster has recorded each
                        person's roles on every sync since it shipped and nothing
                        showed them — yet they are the evidence this screen exists to
                        weigh: confirming a link on a name alone is how the wrong
                        Nussbaum ends up owning somebody else's files. */}
                    {p.roles && p.roles.length ? (
                      <div style={{ fontSize: 12, color: '#4B585C' }}>{p.roles.join(', ')}</div>
                    ) : null}
                  </td>
                  <td style={td}>
                    {p.staff ? <>
                      <div>{p.staff.name}</div>
                      <div style={{ fontSize: 12, color: '#4B585C' }}>{p.staff.email}</div>
                      {/* SEE THEIR SCREEN (owner-directed 2026-08-23). Calls the
                          staff-view door and swaps the browser token for the one it
                          mints — the identity-zone pattern http.js documents: the
                          same storage key both products already share, no RTL
                          module imported. The server holds every rule (super-admin
                          only, read-only, on the record), so this button can be
                          drawn hopefully and refused honestly. */}
                      <button type="button" className="btn ghost"
                        style={{ marginTop: 4, padding: '2px 10px', fontSize: 12 }}
                        onClick={async () => {
                          try {
                            const r = await ltPost('/api/staff-view/start', { staffId: p.staff.id });
                            try { sessionStorage.setItem('ys_portal_staff_token', localStorage.getItem('ys_portal_token') || ''); } catch { /* private mode */ }
                            try { localStorage.setItem('ys_portal_token', r.token); } catch { /* private mode */ }
                            // The pipeline lives at #/internal/lt (a HashRouter app
                            // served under /portal/) — the old bare path fell to the
                            // wildcard and landed on the WRONG product's dashboard.
                            // A hash-only assign does not reload, and the token just
                            // changed, so the reload is explicit.
                            window.location.assign('/portal/#/internal/lt');
                            window.location.reload();
                          } catch (e) { setErr(e.message || 'Could not open their screen.'); }
                        }}>See their screen</button>
                    </> : <span style={{ color: '#4B585C' }}>{p.whyNoMatch || '—'}</span>}
                  </td>
                  <td style={td}>
                    {chip(p.status)}
                    {/* WHO DECIDED, AND WHEN. Confirming a link decides whose
                        pipeline this person's files land in, and both facts were
                        written on the row from the day it shipped and shown to
                        nobody. Each half draws only if we hold it, so a confirmer
                        since removed never prints as "by  on ". */}
                    {p.status === 'confirmed' && (p.confirmedByName || p.confirmedAt) ? (
                      <div style={{ fontSize: 12, color: '#4B585C', marginTop: 4 }}>
                        {p.confirmedByName ? `by ${p.confirmedByName}` : ''}
                        {p.confirmedByName && p.confirmedAt ? ' · ' : ''}
                        {p.confirmedAt ? day(p.confirmedAt) : ''}
                      </div>
                    ) : null}
                  </td>
                  {data.canManage && (
                    <td style={td}>
                      {p.status === 'suggested' && p.staff && (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <button className="btn small" disabled={busy === p.loginId}
                            onClick={() => act(p.loginId, () => ltApi.confirmPerson(p.loginId, p.staff.id), 'confirm that')}>
                            Yes, that&rsquo;s them
                          </button>
                          <button className="btn small ghost" disabled={busy === p.loginId}
                            onClick={() => act(p.loginId, () => ltApi.rejectPerson(p.loginId), 'record that')}>
                            No
                          </button>
                        </div>
                      )}
                      {(p.status === 'confirmed' || p.status === 'rejected') && (
                        <button className="btn small ghost" disabled={busy === p.loginId}
                          title="The login goes back to unlinked, and the next sync may suggest a match again."
                          onClick={() => act(p.loginId, () => ltApi.unlinkPerson(p.loginId), 'undo that')}>Undo</button>
                      )}
                      {/* THE WAY OUT OF A DEAD END: a login the matcher refuses to
                          guess about (a shared email, no email at all) had NO
                          control here — the owner hit exactly that on their own
                          login. Any non-confirmed row can be linked by hand. */}
                      {p.status !== 'confirmed' && (data.staff || []).length > 0 && (
                        <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                          <select className="input"
                            style={{ fontSize: 12, padding: '3px 6px', maxWidth: 220 }}
                            title="When the automatic match cannot decide — a shared email, say — pick the person yourself."
                            value={pick[p.loginId] || ''}
                            onChange={(e) => setPick((m) => ({ ...m, [p.loginId]: e.target.value }))}>
                            <option value="">Link by hand&hellip;</option>
                            {data.staff.map((s) => (
                              <option key={s.id} value={s.id}>{s.name}{s.email ? ` — ${s.email}` : ''}</option>
                            ))}
                          </select>
                          {pick[p.loginId] ? (
                            <button className="btn small" disabled={busy === p.loginId}
                              onClick={() => act(p.loginId, () => ltApi.confirmPerson(p.loginId, pick[p.loginId]), 'link that')}>
                              Link
                            </button>
                          ) : null}
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </LtLayout>
  );
}
