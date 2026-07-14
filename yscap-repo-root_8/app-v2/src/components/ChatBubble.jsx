import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { api } from '../lib/api.js';

/* Global "message your loan team" launcher — a fixed bottom-right bubble present
 * on every authenticated portal page, so chat is one tap away from anywhere.
 *   - staff  → the Chat hub (/internal/chat)
 *   - borrower → the Messages of the file they're looking at, or (from elsewhere)
 *                their most recent file's Messages.
 * `mode` is passed by the layout that renders it (borrower vs staff), so the
 * bubble needs no auth introspection. `unread` (optional) drives the badge.
 */

const ChatGlyph = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 4h14a1.6 1.6 0 0 1 1.6 1.6v8.8A1.6 1.6 0 0 1 19 16h-7l-4 3.6V16H5a1.6 1.6 0 0 1-1.6-1.6V5.6A1.6 1.6 0 0 1 5 4Z" />
  </svg>
);

// Poll briefly for the Messages section (it mounts after the file page loads)
// and scroll it into view. No-ops out after ~2s so it never loops forever.
function scrollToMessages(retries = 20) {
  const el = document.getElementById('sec-messages');
  if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  if (retries > 0) setTimeout(() => scrollToMessages(retries - 1), 100);
}

export default function ChatBubble({ mode = 'borrower', unread = 0 }) {
  const nav = useNavigate();
  const loc = useLocation();
  const [latestFile, setLatestFile] = useState(null);
  const fetched = useRef(false);

  // Borrowers: learn their most-recent file once, so the bubble can jump there
  // from any non-file page. Best-effort; the bubble still works without it.
  useEffect(() => {
    if (mode !== 'borrower' || fetched.current) return;
    fetched.current = true;
    api.applications().then((rows) => {
      const list = Array.isArray(rows) ? rows : (rows && rows.applications) || [];
      const active = list.find((a) => a && a.status !== 'declined') || list[0];
      if (active && active.id) setLatestFile(active.id);
    }).catch(() => {});
  }, [mode]);

  function open() {
    if (mode === 'staff') { nav('/internal/chat'); return; }
    const onFile = /^\/app\/([^/]+)/.exec(loc.pathname);
    if (onFile) { scrollToMessages(); return; }              // already on a file → jump to its Messages
    if (latestFile) { nav(`/app/${latestFile}`); scrollToMessages(); return; }
    nav('/dashboard');                                        // no file yet → the hub
  }

  const label = mode === 'staff' ? 'Open team chat' : 'Message your loan team';
  return (
    <button type="button" className="chat-fab" onClick={open} title={label} aria-label={label}>
      <ChatGlyph />
      {unread > 0 && <span className="chat-fab-badge" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
      <span className="chat-fab-label">{mode === 'staff' ? 'Chat' : 'Messages'}</span>
    </button>
  );
}
