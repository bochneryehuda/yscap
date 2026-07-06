import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';

/* Chat hub — every loan file is a conversation, Slack-style: unread badges per
   channel, last-message preview, newest activity first. Every file the staffer
   can see is here, even before its first message, so there's always somewhere
   to start. Click a file to open its Borrower / Team conversation. */
const addrLine = (a) => !a ? '' : (a.oneLine || [a.street, a.city, a.state].filter(Boolean).join(', ') || '');
const ago = (t) => {
  if (!t) return '';
  const s = (Date.now() - new Date(t).getTime()) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
};
const preview = (r) => {
  if (!r.last_body && !r.last_attachment_kind) return 'No messages yet — start the conversation';
  const who = r.last_sender_kind === 'borrower' ? `${r.first_name}: ` : '';
  const media = { image: '🖼 Photo', video: '🎬 Video', audio: '🎤 Voice note', pdf: '⎙ PDF', file: '📎 File' }[r.last_attachment_kind];
  return who + (r.last_body ? r.last_body.slice(0, 90) : media || '…');
};

export default function StaffChat() {
  const nav = useNavigate();
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('all');   // all | unread
  const [q, setQ] = useState('');

  useEffect(() => { api.staffChatInbox().then(setRows).catch(e => setErr(e.message)); }, []);

  const shown = useMemo(() => {
    if (!rows) return [];
    const needle = q.trim().toLowerCase();
    return rows.filter(r => {
      if (filter === 'unread' && (r.unread_borrower + r.unread_internal) === 0) return false;
      if (!needle) return true;
      const hay = `${r.first_name || ''} ${r.last_name || ''} ${addrLine(r.property_address)} ${r.ys_loan_number || ''}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [rows, filter, q]);

  if (err) return <div className="notice err">{err}</div>;
  if (rows == null) return <div className="panel muted">Loading conversations…</div>;

  const totalUnread = rows.reduce((n, r) => n + r.unread_borrower + r.unread_internal, 0);

  return (
    <>
      <div className="row" style={{ marginBottom: 12, alignItems: 'center' }}>
        <h1 style={{ margin: 0 }}>Chat</h1>
        {totalUnread > 0 && <span className="chat-badge" style={{ marginLeft: 10 }}>{totalUnread}</span>}
        <div className="spacer" />
        <div className="row" style={{ gap: 6 }}>
          <button className={`btn ${filter === 'all' ? 'primary' : 'ghost'}`} onClick={() => setFilter('all')}>All</button>
          <button className={`btn ${filter === 'unread' ? 'primary' : 'ghost'}`} onClick={() => setFilter('unread')}>Unread</button>
          <button className="btn ghost" onClick={() => nav('/internal/new')} title="Open a new loan file and start a conversation">+ New file</button>
        </div>
      </div>
      <p className="muted small" style={{ marginBottom: 12 }}>
        Every loan file is a conversation. Open one to message the <strong>borrower</strong> or your <strong>team</strong> (internal).
        Mention a teammate with <span className="mention">@name</span> anywhere and they're pinged directly.
      </p>

      {rows.length > 6 && (
        <input className="input" style={{ marginBottom: 12 }} value={q} onChange={e => setQ(e.target.value)}
          placeholder="Search by borrower, address, or loan #…" />
      )}

      {rows.length === 0
        ? <div className="panel muted">
            No loan files yet. <Link to="/internal/new">Open a new file</Link> — you can start chatting on it right away,
            and invite the borrower to join whenever you're ready.
          </div>
        : shown.length === 0
          ? <div className="panel muted">{filter === 'unread' ? "You're all caught up." : 'No files match your search.'}</div>
          : <div className="panel" style={{ padding: 6 }}>
              {shown.map(r => {
                const unread = r.unread_borrower + r.unread_internal;
                return (
                  <Link key={r.id} to={`/internal/app/${r.id}`} className={`chat-row ${unread ? 'unread' : ''}`}>
                    <div className="chat-ava" style={{ position: 'relative' }}>{(r.first_name || '?')[0]}{(r.last_name || '')[0]}
                      {r.borrower_online && <span className="presence-dot" title="Borrower is online now" />}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
                        <span className="chat-name">{r.first_name} {r.last_name}</span>
                        {r.borrower_online && <span className="muted small" style={{ color: '#4ccf8f' }}>● online</span>}
                        <span className="muted small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{addrLine(r.property_address)}</span>
                        <div className="spacer" />
                        <span className="muted small">{ago(r.last_at)}</span>
                      </div>
                      <div className="chat-prev">
                        {r.last_channel === 'internal' && <span className="pill" style={{ marginRight: 6, fontSize: '.62rem' }}>internal</span>}
                        {preview(r)}
                      </div>
                    </div>
                    <div className="chat-badges">
                      {r.unread_borrower > 0 && <span className="chat-badge" title="Unread borrower messages">{r.unread_borrower}</span>}
                      {r.unread_internal > 0 && <span className="chat-badge gold" title="Unread team messages">{r.unread_internal}</span>}
                    </div>
                  </Link>
                );
              })}
            </div>}
    </>
  );
}
