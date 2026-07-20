import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { scenarioToDraft, scenarioLabelFromState } from '../lib/scenario.js';
import BorrowerCreditCard from '../components/BorrowerCreditCard.jsx';
import ActionNeeded from '../components/ActionNeeded.jsx';

// Files that are muted OUTSIDE the file (owner-directed): funded/terminal AND
// ON-HOLD loans never nag in the cross-file "to complete" rollup or the per-loan
// outstanding badge (#109) — their items stay visible inside the file itself.
// Mirrors the staff-side inactive set (funded/declined/withdrawn/on_hold), plus
// file_intake (#151): a pre-processing intake file never prompts tasks (the
// server mutes its reminders the same way); its items wait inside the file.
const QUIET_STATUSES = ['funded', 'closed', 'on_hold', 'declined', 'withdrawn', 'cancelled', 'file_intake'];
const money = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const addrLine = (a) => !a ? '—' : (a.oneLine || [a.street || a.line1, a.city, a.state].filter(Boolean).join(', ') || '—');
const dstr = (s) => s ? new Date(s).toLocaleDateString() : '';

export default function Dashboard() {
  const nav = useNavigate();
  const [apps, setApps] = useState(null);
  const [drafts, setDrafts] = useState([]);
  const [notifs, setNotifs] = useState([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [unread, setUnread] = useState({});
  const [drawBusy, setDrawBusy] = useState(null);
  const [archived, setArchived] = useState([]);      // archived (hidden) drafts
  const [showArchived, setShowArchived] = useState(false);
  const [draftBusy, setDraftBusy] = useState(null);
  const [scenarios, setScenarios] = useState([]);    // saved pricing scenarios
  const [scenBusy, setScenBusy] = useState(null);

  const load = () => {
    // Each panel loads independently: a failing drafts/notifications call must
    // not blank the loans list (or leave the page on "Loading…" forever).
    api.applications().then(a => setApps(a || [])).catch(e => { setApps([]); setErr(e.message); });
    api.drafts().then(d => setDrafts(d || [])).catch(() => {});
    api.archivedDrafts().then(d => setArchived(d || [])).catch(() => {});
    api.notifications().then(n => setNotifs(n || [])).catch(() => {});
    api.pricingScenarios().then(s => setScenarios(Array.isArray(s) ? s : [])).catch(() => {});
  };

  // Tidy in-progress applications. Delete is permanent (confirm first); archive
  // just hides a draft so it can be restored. All idempotent server-side, so the
  // per-row busy flag is enough — no duplicate rows are ever created here.
  async function archiveDraft(id) {
    setDraftBusy(id);
    try { await api.archiveDraft(id); load(); } catch (e) { setErr(e.message || 'Could not archive'); } finally { setDraftBusy(null); }
  }
  async function unarchiveDraft(id) {
    setDraftBusy(id);
    try { await api.unarchiveDraft(id); load(); } catch (e) { setErr(e.message || 'Could not restore'); } finally { setDraftBusy(null); }
  }
  async function removeDraft(id, label) {
    if (!window.confirm(`Delete "${label || 'this draft application'}"? This can't be undone.`)) return;
    setDraftBusy(id);
    try { await api.deleteDraft(id); load(); } catch (e) { setErr(e.message || 'Could not delete'); } finally { setDraftBusy(null); }
  }

  // Saved pricing scenarios (#119b): reopen one in the studio to reprice it,
  // start a real application pre-filled from it, or delete it. Starting a loan
  // from a scenario carries every number the borrower already priced (deal,
  // property, economics, experience, FICO) into a new draft — the application
  // then adds their personal profile on top, so only the missing details remain.
  const reopenScenario = (s) => nav('/pricing', { state: { openScenarioId: s.id } });
  async function startLoanFromScenario(s) {
    setScenBusy(s.id);
    try {
      const data = scenarioToDraft(s.inputs || {});
      const d = await api.createDraft({ label: s.label || scenarioLabelFromState(s.inputs) || 'New application', data, step: 1 });
      nav(`/apply/${d.id}`);
    } catch (e) { setErr(e.message || 'Could not start the loan'); setScenBusy(null); }
  }
  async function removeScenario(s) {
    if (!window.confirm(`Delete the saved scenario "${s.label}"?`)) return;
    setScenBusy(s.id);
    try { await api.deletePricingScenario(s.id); load(); } catch (e) { setErr(e.message || 'Could not delete the scenario'); } finally { setScenBusy(null); }
  }
  useEffect(() => {
    load();
    api.chatInbox().then(rows => {
      const map = {}; (rows || []).forEach(r => { if (r.unread > 0) map[r.id] = r.unread; });
      setUnread(map);
    }).catch(() => {});
  }, []);

  // "What you still need to do" now loads in ONE call via the <ActionNeeded> card
  // (GET /api/borrower/action-items) instead of a checklist fetch per file, so it
  // paints instantly at the top — see the component below.

  const [creating, setCreating] = useState(false);
  async function newApplication() {
    if (creating) return;   // double-click created two duplicate drafts
    setCreating(true);
    try { const d = await api.createDraft({ label: 'New application', data: {}, step: 1 }); nav(`/apply/${d.id}`); }
    catch (e) { setErr(e.message); }
    finally { setCreating(false); }
  }
  const [drawConfirm, setDrawConfirm] = useState(null);   // { id, address } | null
  async function requestDraw(e, id) {
    e.preventDefault(); e.stopPropagation();
    // Confirm first (owner-directed 2026-07-14): the click used to silently
    // fire the email fan-out with no feedback, so borrowers clicked it dozens
    // of times → dozens of emails. Now a popup confirms; the server enforces
    // one request per file; the button greys out afterward.
    const a = (apps || []).find(x => x.id === id);
    setDrawConfirm({ id, address: a ? addrLine(a.property_address) : 'this property' });
  }
  async function confirmDraw() {
    const id = drawConfirm && drawConfirm.id;
    if (!id) return;
    setDrawBusy(id); setErr(''); setDrawConfirm(null);
    try {
      const r = await api.requestDraw(id);
      setMsg(r && r.already
        ? 'Your draw request is already in — our draws team has it and will follow up. No need to request again.'
        : 'Draw request received ✓ — our draws team and your loan officer will follow up shortly.');
      setTimeout(() => setMsg(''), 6000);
      load();
    } catch (e2) { setErr(e2.message || 'Could not send the draw request'); }
    finally { setDrawBusy(null); }
  }
  const pct = (a) => a.borrower_total > 0 ? Math.round((a.borrower_done / a.borrower_total) * 100) : 0;
  const scrollToLoans = () => document.getElementById('loans')?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Notifications: mark read on open (clears the header bell badge) and navigate
  // to the linked file; plus a "mark all read".
  async function openNotif(n) {
    if (!n.read_at) { try { await api.readNotif(n.id); } catch { /* non-fatal */ } }
    setNotifs(ns => ns.map(x => x.id === n.id ? { ...x, read_at: x.read_at || new Date().toISOString() } : x));
    if (n.link) { const r = String(n.link).includes('#') ? String(n.link).split('#')[1] : n.link; if (r && r.startsWith('/')) nav(r); }
  }
  async function markAllRead() {
    const unread = notifs.filter(n => !n.read_at);
    setNotifs(ns => ns.map(x => ({ ...x, read_at: x.read_at || new Date().toISOString() })));
    try { await Promise.all(unread.map(n => api.readNotif(n.id))); } catch { /* non-fatal */ }
  }

  // Cross-file "what's next" roll-up, computed from the list we already loaded.
  const activeApps = (apps || []).filter(a => !['declined', 'withdrawn'].includes(a.status));
  // Funded/terminal AND on-hold files are muted OUTSIDE the file (owner-directed
  // 2026-07-14, #109): their remaining items stay visible inside the file but
  // never count toward the borrower's cross-file "to complete" rollup.
  const outstanding = (apps || []).filter(a => !QUIET_STATUSES.includes(a.status))
    .reduce((s, a) => s + Math.max(0, (a.borrower_total || 0) - (a.borrower_done || 0)), 0);
  const unreadTotal = Object.values(unread).reduce((s, n) => s + n, 0);
  // Borrower dashboard order (owner-directed #149/#150): lead with the loans —
  // ACTIVE files (in-progress applications) first, then MORTGAGES (funded/closed
  // loans the borrower actually took — the section is named "Mortgages", not
  // "files"), then the task/document rollups + activity at the BOTTOM.
  const isDead = (a) => ['declined', 'withdrawn', 'cancelled'].includes(a.status);
  const isMortgage = (a) => ['funded', 'closed'].includes(a.status);
  const inProgress = (apps || []).filter(a => !isDead(a) && !isMortgage(a));
  const mortgages = (apps || []).filter(isMortgage);
  const loanCard = (a) => (
    <Link to={`/app/${a.id}`} key={a.id} className="panel" style={{ textDecoration: 'none', color: 'inherit' }}>
      <div className="row" style={{ marginBottom: 10 }}>
        <span className={`pill ${a.status}`}>{String(a.status || 'new').replace(/_/g, ' ')}</span>
        {unread[a.id] && <span className="chat-badge" style={{ marginLeft: 8 }} title="New messages">{unread[a.id]}</span>}
        <div className="spacer" />
        <span className="muted small">{a.ys_loan_number || 'Pending #'}</span>
      </div>
      <h3 style={{ marginBottom: 10 }}>{addrLine(a.property_address)}</h3>
      <div className="metrow"><span className="k">Program</span><span className="v">{a.program || '—'}</span></div>
      <div className="metrow"><span className="k">Loan type</span><span className="v">{a.loan_type || '—'}</span></div>
      <div className="metrow"><span className="k">Loan amount</span><span className="v ln-amount">{money(a.loan_amount)}</span></div>
      <div className="metrow"><span className="k">Officer</span><span className="v">{a.loan_officer_name || 'Lead Capture'}</span></div>
      {a.borrower_total > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="row" style={{ marginBottom: 4 }}>
            <span className="muted small">Your checklist</span>
            <div className="spacer" />
            <span className="muted small">{a.borrower_done}/{a.borrower_total} · {pct(a)}%</span>
          </div>
          <div className="progress"><div className="progress-fill" style={{ width: pct(a) + '%' }} /></div>
        </div>
      )}
      {a.status === 'funded' && (
        a.draw_setup_requested_at ? (
          <button className="btn" style={{ marginTop: 12, width: '100%', opacity: 0.6, cursor: 'default' }}
            disabled title="Your draw request is in — our team will follow up."
            onClick={e => { e.preventDefault(); e.stopPropagation(); }}>
            Draw requested ✓
          </button>
        ) : (
          <button className="btn primary" style={{ marginTop: 12, width: '100%' }}
            disabled={drawBusy === a.id} onClick={e => requestDraw(e, a.id)}>
            {drawBusy === a.id ? 'Sending…' : 'Request a draw'}
          </button>
        )
      )}
    </Link>
  );

  return (
    <>
      <div className="row" style={{ marginBottom: 20, flexWrap: 'wrap', gap: 8 }}>
        <div><h1>Your loans</h1><p className="muted small">Track every file with YS Capital in one place.</p></div>
        <div className="spacer" />
        {/* #103: a discoverable entry point to self-service pricing right where
            borrowers land — build a term sheet from your own numbers, save it,
            come back to it. */}
        <Link className="btn ghost" to="/pricing" title="Price a loan and save scenarios — build a term sheet from your own numbers">Price a loan</Link>
        <button className="btn primary" onClick={newApplication}>+ New application</button>
      </div>
      {err && <div role="alert" className="notice err">{err}
        <button className="btn link small" onClick={() => { setErr(''); load(); }}>Retry</button></div>}
      {msg && <div className="notice ok">{msg}</div>}

      {/* Lead with what the borrower must DO right now — signatures, fixes, documents
          — pulled cross-file in one call so it paints immediately on login (#39). */}
      <ActionNeeded />

      {drawConfirm && (
        <div className="cv-modal-back" onClick={() => setDrawConfirm(null)}>
          <div className="cv-modal" style={{ maxWidth: 460, width: '92%' }} role="dialog" aria-modal="true"
            aria-label="Request a construction draw" onClick={e => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Request a construction draw</h3>
            <p className="muted" style={{ lineHeight: 1.5 }}>
              We'll notify our draws team and your loan officer to start the draw
              process on <strong>{drawConfirm.address}</strong>. They'll reach out
              with the inspection and disbursement steps.
            </p>
            <p className="muted small">You only need to request this once per loan.</p>
            <div className="row" style={{ gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <button className="btn ghost" onClick={() => setDrawConfirm(null)}>Cancel</button>
              <button className="btn primary" onClick={confirmDraw}>Request the draw</button>
            </div>
          </div>
        </div>
      )}

      {apps && apps.length > 0 && (
        <div className="next-strip">
          {outstanding > 0 ? (
            <div className="next-item warn">
              <span className="ni-n">{outstanding}</span>
              <span className="ni-l">document{outstanding === 1 ? '' : 's'} & item{outstanding === 1 ? '' : 's'} to complete across your files</span>
            </div>
          ) : (
            <div className="next-item ok"><span className="ni-l">✓ You're all caught up — nothing outstanding right now.</span></div>
          )}
          {unreadTotal > 0 && (
            <div className="next-item"><span className="ni-n">{unreadTotal}</span><span className="ni-l">new message{unreadTotal === 1 ? '' : 's'} from your loan team</span></div>
          )}
          <div className="next-item next-clickable" role="button" tabIndex={0}
            onClick={scrollToLoans}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); scrollToLoans(); } }}
            title="View your loans">
            <span className="ni-n">{activeApps.length}</span>
            <span className="ni-l">active file{activeApps.length === 1 ? '' : 's'} — view your loans →</span>
          </div>
        </div>
      )}

      {/* ACTIVE FILES + MORTGAGES first — the loans are the main thing on login
          (#149). Task/document rollups and activity move below. */}
      {apps == null ? <div className="panel muted">Loading…</div>
        : (apps.length === 0 && drafts.length === 0) ? (
          <div className="panel">
            <h3>No applications yet</h3>
            <p className="muted" style={{ margin: '8px 0 16px' }}>
              Start your first loan application, or price a scenario first to see your numbers.
              PILOT saves your progress automatically as you go.
            </p>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button className="btn primary" onClick={newApplication}>Start an application</button>
              <Link className="btn ghost" to="/pricing">Price a loan</Link>
            </div>
          </div>
        ) : (
          <>
            {inProgress.length > 0 && (
              <div id="loans" style={{ marginBottom: 18 }}>
                <h3 style={{ marginBottom: 10 }}>Active files</h3>
                <div className="grid cols-2">{inProgress.map(loanCard)}</div>
              </div>
            )}
            {mortgages.length > 0 && (
              <div style={{ marginBottom: 18 }}>
                <h3 style={{ marginBottom: 4 }}>Mortgages</h3>
                <p className="muted small" style={{ marginBottom: 10 }}>Loans you've closed with YS Capital.</p>
                <div className="grid cols-2">{mortgages.map(loanCard)}</div>
              </div>
            )}
          </>
        )}

      {scenarios.length > 0 && (
        <div className="panel" style={{ marginBottom: 18 }}>
          <h3 style={{ marginBottom: 4 }}>Saved scenarios</h3>
          <p className="muted small" style={{ marginBottom: 12 }}>
            Term sheets you priced and saved. Reopen one to reprice it, or start an
            application straight from it — pre-filled with everything you already entered.
          </p>
          {scenarios.map(s => {
            const v = (s.inputs && s.inputs.v) || {};
            const sub = [v.dealType, v.dealPurpose].filter(Boolean).join(' · ');
            return (
              <div className="item" key={s.id}>
                <div>
                  <div className="ttl">{s.label || 'Pricing scenario'}</div>
                  <div className="muted small">{sub ? sub + ' · ' : ''}Saved {dstr(s.updated_at || s.created_at)}</div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn ghost small" disabled={scenBusy === s.id} onClick={() => reopenScenario(s)}
                    title="Reopen this scenario in the pricer to reprice it">Reopen</button>
                  <button className="btn primary small" disabled={scenBusy === s.id} onClick={() => startLoanFromScenario(s)}
                    title="Start a loan application pre-filled from this scenario">{scenBusy === s.id ? 'Starting…' : 'Start loan →'}</button>
                  <button className="btn ghost small" disabled={scenBusy === s.id} onClick={() => removeScenario(s)}
                    title="Delete this saved scenario" style={{ color: 'var(--danger)' }}>Delete</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {(drafts.length > 0 || archived.length > 0) && (
        <div className="panel" style={{ marginBottom: 18 }}>
          <h3 style={{ marginBottom: 12 }}>Continue where you left off</h3>
          {drafts.map(d => (
            <div className="item" key={d.id}>
              <div>
                <div className="ttl">{d.label || 'Draft application'}</div>
                <div className="muted small">Saved {dstr(d.updated_at)} · step {d.step}</div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <Link className="btn ghost" to={`/apply/${d.id}`}>Resume</Link>
                <button className="btn ghost small" disabled={draftBusy === d.id} onClick={() => archiveDraft(d.id)}
                  title="Hide this draft — you can restore it any time">Archive</button>
                <button className="btn ghost small" disabled={draftBusy === d.id} onClick={() => removeDraft(d.id, d.label)}
                  title="Delete this draft permanently" style={{ color: 'var(--danger)' }}>Delete</button>
              </div>
            </div>
          ))}
          {drafts.length === 0 && <div className="muted small">No active drafts — your archived ones are below.</div>}
          {archived.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <button className="btn link small" onClick={() => setShowArchived(v => !v)}>
                {showArchived ? 'Hide' : 'Show'} archived drafts ({archived.length})
              </button>
              {showArchived && archived.map(d => (
                <div className="item" key={d.id} style={{ opacity: 0.75 }}>
                  <div>
                    <div className="ttl">{d.label || 'Draft application'} <span className="muted small">· archived</span></div>
                    <div className="muted small">Saved {dstr(d.updated_at)} · step {d.step}</div>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <button className="btn ghost small" disabled={draftBusy === d.id} onClick={() => unarchiveDraft(d.id)}>Restore</button>
                    <button className="btn ghost small" disabled={draftBusy === d.id} onClick={() => removeDraft(d.id, d.label)}
                      style={{ color: 'var(--danger)' }}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <BorrowerCreditCard />


      {notifs.length > 0 && (
        <div className="panel" style={{ marginTop: 18 }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <h3 style={{ margin: 0 }}>Recent activity</h3>
            {notifs.some(n => !n.read_at) && <button className="btn link small" onClick={markAllRead}>Mark all read</button>}
          </div>
          {notifs.slice(0, 6).map(n => (
            <div className="checkitem" key={n.id} style={{ cursor: n.read_at ? 'default' : 'pointer' }}
              onClick={() => openNotif(n)} title={n.read_at ? '' : 'Mark as read'}>
              <span className={`dot ${n.read_at ? 'done' : 'outstanding'}`} />
              <div style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>
                <div style={{ fontWeight: 600 }}>{n.title}</div>
                {n.body && <div className="muted small">{n.body}</div>}
              </div>
              <span className="muted small">{dstr(n.created_at)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
