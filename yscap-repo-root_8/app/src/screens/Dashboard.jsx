import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';

const money = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const addrLine = (a) => !a ? '—' : (a.oneLine || [a.street, a.city, a.state].filter(Boolean).join(', ') || '—');
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

  const load = () => {
    Promise.all([api.applications(), api.drafts(), api.notifications()])
      .then(([a, d, n]) => { setApps(a || []); setDrafts(d || []); setNotifs(n || []); })
      .catch(e => setErr(e.message));
  };
  useEffect(() => {
    load();
    api.chatInbox().then(rows => {
      const map = {}; (rows || []).forEach(r => { if (r.unread > 0) map[r.id] = r.unread; });
      setUnread(map);
    }).catch(() => {});
  }, []);

  async function newApplication() {
    try { const d = await api.createDraft({ label: 'New application', data: {}, step: 1 }); nav(`/apply/${d.id}`); }
    catch (e) { setErr(e.message); }
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

  return (
    <>
      <div className="row" style={{ marginBottom: 20 }}>
        <div><h1>Your loans</h1><p className="muted small">Track every file with YS Capital in one place.</p></div>
        <div className="spacer" />
        <button className="btn primary" onClick={newApplication}>+ New application</button>
      </div>
      {err && <div className="notice err">{err}</div>}
      {msg && <div className="notice ok">{msg}</div>}

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

      {apps == null ? <div className="panel muted">Loading…</div>
        : apps.length === 0 && drafts.length === 0 ? (
          <div className="panel">
            <h3>No applications yet</h3>
            <p className="muted" style={{ margin: '8px 0 16px' }}>
              Start your first loan application. Everything saves automatically as you go.
            </p>
            <button className="btn primary" onClick={newApplication}>Start an application</button>
          </div>
        ) : (
          <div className="grid cols-2">
            {apps.map(a => (
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
            ))}
          </div>
        )}

      {notifs.length > 0 && (
        <div className="panel" style={{ marginTop: 18 }}>
          <h3 style={{ marginBottom: 6 }}>Recent activity</h3>
          {notifs.slice(0, 6).map(n => (
            <div className="checkitem" key={n.id}>
              <span className={`dot ${n.read_at ? 'done' : 'outstanding'}`} />
              <div style={{ flex: 1 }}>
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
