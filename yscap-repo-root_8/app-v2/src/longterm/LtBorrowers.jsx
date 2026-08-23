import React, { useCallback, useEffect, useState } from 'react';
import LtLayout from './LtLayout.jsx';
import { ltApi } from './api.js';
import { ltPost } from './http.js';

/**
 * THE BORROWER MAP — which client each long-term loan belongs to.
 *
 * This is the screen behind the owner's *"we need to make sure we are mapping it to
 * the correct borrower profile so the borrower can also see it on their login."*
 * The doors have existed since `GET/POST /api/lt/borrowers` shipped and nothing
 * rendered them, so no borrower link could be confirmed at all — which is why the
 * long-term side of a client's login is empty even with the switch on.
 *
 * IT SUGGESTS AND NEVER DECIDES. Same shape as the staff People map, and the stakes
 * are higher: a wrong staff link shows an officer the wrong pipeline; a wrong
 * borrower link shows a CLIENT somebody else's loan. So every row here is a
 * proposal, nothing takes effect until an administrator presses the button, and a
 * row we will not propose says WHY in plain words rather than sitting there as an
 * unexplained blank.
 *
 * THE DECISION IS ABOUT THE ADDRESS, NOT THE LOAN. One confirmation governs every
 * long-term loan on that email — including the ones that arrive next month — and a
 * rejection is just as durable, so a match somebody turned down never comes back on
 * the next sync. The screen says the count out loud before you press anything,
 * because "confirm" here can move four files at once.
 */

export default function LtBorrowers() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  // SEE THEIR SCREEN (owner-directed 2026-08-23) — the EXISTING borrower-view
  // door, reached the identity-zone way http.js documents: the shared token key,
  // no RTL module imported. The server holds every rule (who may, what is
  // blocked inside, the 4-hour cap); this only parks our own token and adopts
  // the one the door mints, then boots the borrower app the person really uses.
  const seeTheirScreen = async (borrowerId) => {
    try {
      const r = await ltPost('/api/borrower-view/start', { borrowerId });
      try { sessionStorage.setItem('ys_portal_staff_token', localStorage.getItem('ys_portal_token') || ''); } catch { /* private mode */ }
      try { localStorage.setItem('ys_portal_token', r.token); } catch { /* private mode */ }
      window.location.assign(r.landing || '/dashboard');
    } catch (e) { setErr(e.message || 'Could not open their screen.'); }
  };
  const [busy, setBusy] = useState('');
  // Said INLINE rather than in a modal: Long-Term may not import RTL's dialog
  // module (the separation gate refuses it), and on a table the answer belongs
  // beside the row that produced it anyway.
  const [note, setNote] = useState('');

  const load = useCallback(() => {
    setErr(null);
    ltApi.borrowerMap().then(setData).catch((e) => setErr(e.message || 'Could not read the borrower map.'));
  }, []);
  useEffect(load, [load]);

  const act = async (key, fn, label) => {
    setBusy(key);
    setNote('');
    try {
      const out = await fn();
      if (out && out.loansLinked != null) {
        setNote(`Done. ${out.loansLinked} long-term file${out.loansLinked === 1 ? '' : 's'} now show on that client's login.`);
      }
      load();
    } catch (e) { setNote(e.message || `Could not ${label}.`); }
    finally { setBusy(''); }
  };

  const th = { textAlign: 'left', fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase',
    color: '#4B585C', fontWeight: 700, padding: '8px 10px' };
  const td = { padding: '10px', fontSize: 14, color: '#141B22', borderTop: '1px solid #EAE4D7', verticalAlign: 'top' };

  const counts = (data && data.counts) || {};
  const canManage = !!(data && data.canManage);

  return (
    <LtLayout title="Borrowers">
      <p style={{ margin: '0 0 14px', color: '#4B585C', maxWidth: 760, lineHeight: 1.55 }}>
        A long-term file only appears on a client&rsquo;s own login once somebody has
        confirmed the file is theirs. We suggest a match by email address and never
        adopt a profile on our own — you decide. One answer covers every long-term
        file on that address, including the ones that arrive later.
      </p>

      {note && <div className="card" style={{ color: '#141B22', marginBottom: 12 }}>{note}</div>}
      {err && <div className="card" style={{ color: '#141B22' }}>{err}</div>}
      {!data && !err && <div className="card" style={{ color: '#4B585C' }}>Reading the borrower map…</div>}

      {data && (
        <>
          <div className="card" style={{ marginBottom: 14, color: '#141B22', fontSize: 13, lineHeight: 1.6 }}>
            <strong>{counts.addresses ?? '—'}</strong> email addresses across{' '}
            <strong>{counts.loans ?? '—'}</strong> long-term files.{' '}
            <strong>{counts.suggested ?? '—'}</strong> are waiting for your answer,{' '}
            <strong>{counts.unmatched ?? '—'}</strong> we will not guess at, and{' '}
            <strong>{counts.loansWithoutEmail ?? '—'}</strong> file
            {counts.loansWithoutEmail === 1 ? '' : 's'} carry no email at all.
            {!canManage && (
              <div style={{ marginTop: 8, color: '#4B585C' }}>
                You can see the map. Only an administrator can confirm a match.
              </div>
            )}
          </div>

          {/* WAITING FOR YOU — the only rows with an action on them. */}
          <h2 style={{ fontSize: 16, color: '#141B22', margin: '0 0 8px' }}>Waiting for your answer</h2>
          {!data.suggestions.length && (
            <div className="card" style={{ color: '#4B585C', marginBottom: 18 }}>
              Nothing is waiting. Every address we can match has been answered.
            </div>
          )}
          {data.suggestions.length > 0 && (
            <div className="card" style={{ padding: 0, overflowX: 'auto', marginBottom: 18 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 820 }}>
                <thead><tr>
                  <th style={th}>On the loan (Encompass)</th><th style={th}>We think this is</th>
                  <th style={th}>Files it covers</th>{canManage && <th style={th}>Action</th>}
                </tr></thead>
                <tbody>
                  {data.suggestions.map((s) => (
                    <tr key={s.email}>
                      <td style={td}>
                        <div style={{ fontWeight: 600 }}>{s.encompassName || '(no name on the loan)'}</div>
                        <div style={{ fontSize: 12, color: '#4B585C' }}>{s.email}</div>
                      </td>
                      <td style={td}>
                        <div>{s.borrowerName || '(profile has no name)'}</div>
                        {/* NEVER a gate, only a flag: a client whose Encompass record
                            still carries a maiden name is the same person, and
                            refusing on that would leave the honest matches
                            unconfirmable. It just deserves a second look. */}
                        {!s.nameAgrees && (
                          <div style={{ fontSize: 12, color: '#8A6A17', marginTop: 2 }}>
                            The names are spelled differently — worth a second look.
                          </div>
                        )}
                      </td>
                      <td style={td}>
                        {s.loanCount} file{s.loanCount === 1 ? '' : 's'}
                        {s.alreadyLinked > 0 && (
                          <div style={{ fontSize: 12, color: '#4B585C' }}>
                            {s.alreadyLinked} already on somebody&rsquo;s login
                          </div>
                        )}
                      </td>
                      {canManage && (
                        <td style={td}>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            <button className="btn small" disabled={busy === s.email}
                              onClick={() => act(s.email, () => ltApi.confirmBorrower(s.email, s.borrowerId), 'confirm that')}>
                              Yes, that&rsquo;s them
                            </button>
                            <button className="btn small ghost" disabled={busy === s.email}
                              onClick={() => seeTheirScreen(s.borrowerId)}>See their screen</button>
                            <button className="btn small ghost" disabled={busy === s.email}
                              title="Recorded for good — this match is never suggested again."
                              onClick={() => act(s.email, () => ltApi.rejectBorrower(s.email), 'record that')}>
                              No
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* EVERYTHING ELSE, each with the reason we did not propose it. An
              unexplained blank sends an admin hunting for something the server
              already knows. */}
          <h2 style={{ fontSize: 16, color: '#141B22', margin: '0 0 8px' }}>
            Not proposed
          </h2>
          {!data.unmatched.length && (
            <div className="card" style={{ color: '#4B585C', marginBottom: 18 }}>Nothing here.</div>
          )}
          {data.unmatched.length > 0 && (
            <div className="card" style={{ padding: 0, overflowX: 'auto', marginBottom: 18 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 820 }}>
                <thead><tr>
                  <th style={th}>On the loan (Encompass)</th><th style={th}>Why not</th>
                  <th style={th}>Files</th>{canManage && <th style={th}>Action</th>}
                </tr></thead>
                <tbody>
                  {data.unmatched.map((u) => (
                    <tr key={u.email}>
                      <td style={td}>
                        <div style={{ fontWeight: 600 }}>
                          {u.encompassNames && u.encompassNames.length > 1
                            ? u.encompassNames.join(' / ')
                            : (u.encompassName || '(no name on the loan)')}
                        </div>
                        <div style={{ fontSize: 12, color: '#4B585C' }}>{u.email}</div>
                      </td>
                      <td style={{ ...td, color: '#4B585C' }}>{u.reason}</td>
                      <td style={td}>{u.loanCount}</td>
                      {canManage && (
                        <td style={td}>
                          {/* UNDO is offered only where a person made the decision.
                              Everywhere else there is nothing to undo, and a button
                              that does nothing is worse than none. */}
                          {u.decided && (
                            <button className="btn small ghost" disabled={busy === u.email}
                              title={u.decided === 'confirmed'
                                ? 'The files come off that client’s login and the decision is forgotten.'
                                : 'The address goes back to unanswered and may be suggested again.'}
                              onClick={() => act(u.email, () => ltApi.unlinkBorrower(u.email), 'undo that')}>
                              Undo ({u.decided === 'confirmed' ? 'linked' : 'said no'})
                            </button>
                          )}
                          {u.decided === 'confirmed' && u.borrowerId && (
                            <button className="btn small ghost" style={{ marginLeft: 6 }} disabled={busy === u.email}
                              onClick={() => seeTheirScreen(u.borrowerId)}>See their screen</button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* NO EMAIL AT ALL — real files, counted so the census reconciles, but
              there is nothing here to match on. Listed rather than summarised so
              somebody can go and put an address on them in Encompass. */}
          {data.noEmail && data.noEmail.length > 0 && (
            <>
              <h2 style={{ fontSize: 16, color: '#141B22', margin: '0 0 8px' }}>
                No email on the loan
              </h2>
              <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 620 }}>
                  <thead><tr>
                    <th style={th}>File</th><th style={th}>Borrower</th><th style={th}>Folder</th>
                  </tr></thead>
                  <tbody>
                    {data.noEmail.map((l) => (
                      <tr key={l.id}>
                        <td style={{ ...td, fontWeight: 600 }}>{l.loan_number || '(no loan number)'}</td>
                        <td style={td}>{l.borrower_name || <span style={{ color: '#4B585C' }}>—</span>}</td>
                        <td style={td}>{l.loan_folder || <span style={{ color: '#4B585C' }}>—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p style={{ color: '#4B585C', fontSize: 13, marginTop: 8, maxWidth: 700 }}>
                Add an email address to these loans in Encompass and the next sync will
                bring them here to be matched.
              </p>
            </>
          )}
        </>
      )}
    </LtLayout>
  );
}
