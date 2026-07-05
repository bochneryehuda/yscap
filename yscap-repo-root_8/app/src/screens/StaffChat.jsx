import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';

/* Chat hub — every loan file's conversation in one place, Slack-style:
   unread badges per channel, last-message preview, newest activity first.
   Click through to the file to join the conversation. */
const addrLine = (a) => !a ? '—' : (a.oneLine || [a.street, a.city, a.state].filter(Boolean).join(', ') || '—');
const ago = (t) => {
  const s = (Date.now() - new Date(t).getTime()) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
};
const preview = (r) => {
  const who = r.last_sender_kind === 'borrower' ? `${r.first_name}: ` : r.last_sender_kind === 'staff' ? '' : '';
  const media = { image: '🖼 Photo', video: '🎬 Video', audio: '🎤 Voice note', pdf: '⎙ PDF', file: '📎 File' }[r.last_attachment_kind];
  return who + (r.last_body ? r.last_body.slice(0, 90) : media || '…');
};

export default function StaffChat() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('all');   // all | unread

  useEffect(() => { api.staffChatInbox().then(setRows).catch(e => setErr(e.message)); }, []);

  if (err) return <div className="notice err">{err}</div>;
  if (rows == null) return <div className="panel muted">Loading conversations…</div>;

  const shown = rows.filter(r => filter === 'all' || (r.unread_borrower + r.unread_internal) > 0);
  const totalUnread = rows.reduce((n, r) => n + r.unread_borrower + r.unread_internal, 0);

  return (
    <>
      <div className="row" style={{ marginBottom: 16, alignItems: 'center' }}>
        <h1 style={{ margin: 0 }}>Chat</h1>
        {totalUnread > 0 && <span className="chat-badge" style={{ marginLeft: 10 }}>{totalUnread}</span>}
        <div className="spacer" />
        <div className="row" style={{ gap: 6 }}>
          <button className={`btn ${filter === 'all' ? 'primary' : 'ghost'}`} onClick={() => setFilter('all')}>All</button>
          <button className={`btn ${filter === 'unread' ? 'primary' : 'ghost'}`} onClick={() => setFilter('unread')}>Unread</button>
        </div>
      </div>
      <p className="muted small" style={{ marginBottom: 14 }}>
        Every conversation lives on its loan file — this is your inbox across all of them.
        Mention a teammate with <span className="mention">@name</span> anywhere and they're pinged directly.
      </p>

      {shown.length === 0
        ? <div className="panel muted">{filter === 'unread' ? "You're all caught up." : 'No conversations yet — open any loan file and start one.'}</div>
        : <div className="panel" style={{ padding: 6 }}>
            {shown.map(r => {
              const unread = r.unread_borrower + r.unread_internal;
              return (
                <Link key={r.id} to={`/staff/app/${r.id}`} className={`chat-row ${unread ? 'unread' : ''}`}>
                  <div className="chat-ava">{(r.first_name || '?')[0]}{(r.last_name || '')[0]}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
                      <span className="chat-name">{r.first_name} {r.last_name}</span>
                      <span className="muted small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{addrLine(r.property_address)}</span>
                      <div className="spacer" />
                      <span className="muted small">{r.last_at ? ago(r.last_at) : ''}</span>
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
