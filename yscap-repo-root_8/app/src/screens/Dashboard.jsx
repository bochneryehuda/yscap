import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';

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
  const [outByLoan, setOutByLoan] = useState({});

  const load = () => {
    // Each panel loads independently: a failing drafts/notifications call must
    // not blank the loans list (or leave the page on "Loading…" forever).
    api.applications().then(a => setApps(a || [])).catch(e => { setApps([]); setErr(e.message); });
    api.drafts().then(d => setDrafts(d || [])).catch(() => {});
    api.notifications().then(n => setNotifs(n || [])).catch(() => {});
  };
  useEffect(() => {
    load();
    api.chatInbox().then(rows => {
      const map = {}; (rows || []).forEach(r => { if (r.unread > 0) map[r.id] = r.unread; });
      setUnread(map);
    }).catch(() => {});
  }, []);

  // Pull each active loan's outstanding checklist items so the dashboard can
  // show WHAT is still needed, grouped by loan — the loans list endpoint only
  // returns per-file counts, not the item names.
  useEffect(() => {
    if (!apps) return;
    let live = true;
    const DONE = ['received', 'satisfied', 'waived', 'cleared', 'accepted'];
    apps
      .filter(a => !['declined', 'withdrawn'].includes(a.status) && (a.borrower_total || 0) > (a.borrower_done || 0))
      .forEach(a => api.checklist(a.id)
        .then(items => { if (live) setOutByLoan(m => ({ ...m, [a.id]: (items || []).filter(i => !DONE.includes(i.status)) })); })
        .catch(() => {}));
    return () => { live = false; };
  }, [apps]);

  const [creating, setCreating] = useState(false);
  async function newApplication() {
    if (creating) return;   // double-click created two duplicate drafts
    setCreating(true);
    try { const d = await api.createDraft({ label: 'New application', data: {}, step: 1 }); nav(`/apply/${d.id}`); }
    catch (e) { setErr(e.message); }
    finally { setCreating(false); }
  }
  async function requestDraw(e, id) {
    e.preventDefault(); e.stopPropagation();
    setDrawBusy(id); setErr('');
    try {
      await api.requestDraw(id);
      setMsg('Draw request sent ✓ — our draws team and your loan officer will follow up.');
      setTimeout(() => setMsg(''), 5000);
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
  const outstanding = (apps || []).reduce((s, a) => s + Math.max(0, (a.borrower_total || 0) - (a.borrower_done || 0)), 0);
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
        {unread[a.id] && <span className="chat-badge" style={{ marginLeft: 8 }} title="New messages">💬 {unread[a.id]}</span>}
        <div className="spacer" />
        <span className="muted small">{a.ys_loan_number || 'Pending #'}</span>
      </div>
      <h3 style={{ marginBottom: 10 }}>{addrLine(a.property_address)}</h3>
      <div className="metrow"><span className="k">Program</span><span className="v">{a.program || '—'}</span></div>
      <div className="metrow"><span className="k">Loan type</span><span className="v">{a.loan_type || '—'}</span></div>
      <div className="metrow"><span className="k">Loan amount</span><span className="v">{money(a.loan_amount)}</span></div>
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
        <button className="btn primary" style={{ marginTop: 12, width: '100%' }}
          disabled={drawBusy === a.id} onClick={e => requestDraw(e, a.id)}>
          {drawBusy === a.id ? 'Sending…' : '💰 Request a draw'}
        </button>
      )}
    </Link>
  );

  return (
    <>
      <div className="row" style={{ marginBottom: 20 }}>
        <div><h1>Your loans</h1><p className="muted small">Track every file with YS Capital in one place.</p></div>
        <div className="spacer" />
        <button className="btn primary" onClick={newApplication}>+ New application</button>
      </div>
      {err && <div role="alert" className="notice err">{err}
        <button className="btn link small" onClick={() => { setErr(''); load(); }}>Retry</button></div>}
      {msg && <div className="notice ok">{msg}</div>}

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
            <div className="next-item"><span className="ni-n">💬 {unreadTotal}</span><span className="ni-l">new message{unreadTotal === 1 ? '' : 's'} from your loan team</span></div>
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
              Start your first loan application. Everything saves automatically as you go.
            </p>
            <button className="btn primary" onClick={newApplication}>Start an application</button>
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

      {drafts.length > 0 && (
        <div className="panel" style={{ marginBottom: 18 }}>
          <h3 style={{ marginBottom: 12 }}>Continue where you left off</h3>
          {drafts.map(d => (
            <div className="item" key={d.id}>
              <div>
                <div className="ttl">{d.label || 'Draft application'}</div>
                <div className="muted small">Saved {dstr(d.updated_at)} · step {d.step}</div>
              </div>
              <div className="row">
                <Link className="btn ghost" to={`/apply/${d.id}`}>Resume</Link>
              </div>
            </div>
          ))}
        </div>
      )}

      {apps && (() => {
        const groups = (apps || []).filter(a => (outByLoan[a.id] || []).length > 0);
        if (!groups.length) return null;
        const itemLabel = (it) => it.label || it.borrower_label || it.field_label || 'Item';
        const st = (s) => s === 'issue' ? 'Needs attention' : s === 'received' ? 'In review' : 'To do';
        return (
          <div className="panel" style={{ marginBottom: 18 }}>
            <h3 style={{ marginBottom: 4 }}>Outstanding documents &amp; items</h3>
            <p className="muted small" style={{ marginBottom: 6 }}>Everything your loans still need, grouped by property. Click any item to open the file.</p>
            {groups.map(a => (
              <div key={a.id} style={{ marginTop: 12 }}>
                <div className="row" style={{ marginBottom: 2 }}>
                  <Link to={`/app/${a.id}`} style={{ fontWeight: 600 }}>{addrLine(a.property_address)}</Link>
                  <div className="spacer" />
                  <span className="muted small">{(outByLoan[a.id] || []).length} outstanding</span>
                </div>
                {(outByLoan[a.id] || []).map(it => (
                  <Link to={`/app/${a.id}`} key={it.id} className="checkitem" style={{ textDecoration: 'none', color: 'inherit' }}>
                    <span className="dot outstanding" style={it.status === 'issue' ? { background: 'var(--danger)' } : undefined} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 500 }}>{itemLabel(it)}</div>
                      {it.status === 'issue' && it.rejection_reason && <div className="small" style={{ color: 'var(--danger)' }}>Needs a fix: {it.rejection_reason}</div>}
                    </div>
                    <span className="muted small" style={{ whiteSpace: 'nowrap' }}>{st(it.status)}</span>
                  </Link>
                ))}
              </div>
            ))}
          </div>
        );
      })()}

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
