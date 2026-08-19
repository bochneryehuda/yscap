import React, { useCallback, useEffect, useRef, useState } from 'react';
import { showMessage } from '../../lib/dialog.js';
import { subscribeChat } from '../../lib/chatEvents.js';
import { arena } from '../../lib/arena.js';

/* THE ROOM — chat beside the wheel.
 *
 * OPTIMISTIC SEND, because a chat that waits for a round trip feels broken when
 * forty people type at the reveal. The message appears immediately in a pending
 * state and is replaced by the real row when the server confirms it; a failure
 * turns it red and leaves the text in the box rather than silently losing it.
 *
 * LIVE MESSAGES ARRIVE AS FRAMES, not as a refetch — chat is the one thing on
 * this screen where the frame IS the payload, because re-reading the whole
 * board for every "🎉" would be absurd. A message this tab sent is recognised by
 * its id and does not appear twice.
 *
 * OLDER MESSAGES PAGE BY CURSOR, never by offset: people are typing while
 * somebody scrolls up, and an offset page would skip or repeat lines.
 */
export default function ArenaChat({ sessionId, spinId, isSuper, compact = false }) {
  const [messages, setMessages] = useState([]);
  const [pinned, setPinned] = useState([]);
  const [body, setBody] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [sending, setSending] = useState(false);
  const listRef = useRef(null);
  const stick = useRef(true);

  const load = useCallback(async (before) => {
    try {
      const r = await arena.chat(sessionId, before);
      setMessages((cur) => {
        if (!before) return r.messages || [];
        const seen = new Set(cur.map((m) => String(m.id)));
        return [...(r.messages || []).filter((m) => !seen.has(String(m.id))), ...cur];
      });
      setPinned(r.pinned || []);
      setHasMore(!!r.hasMore);
    } catch { /* the wheel matters more than the chat */ }
  }, [sessionId]);

  useEffect(() => { if (sessionId) load(); }, [sessionId, load]);

  useEffect(() => subscribeChat((event, data) => {
    if (event === 'arena:chat' && data && data.message) {
      if (String(data.message.session_id) !== String(sessionId)) return;
      setMessages((cur) => (cur.some((m) => String(m.id) === String(data.message.id))
        ? cur
        // Replace this tab's optimistic copy if the server row is the same text
        // from the same person; otherwise append.
        : [...cur.filter((m) => !(m.pending && m.body === data.message.body)), data.message]));
    }
    if (event === 'arena:chat-react' && data) {
      setMessages((cur) => cur.map((m) => (String(m.id) === String(data.messageId)
        ? { ...m, reaction_counts: data.reactions } : m)));
    }
    if (event === 'arena:chat-moderated' && data) {
      if (data.action === 'delete') setMessages((cur) => cur.filter((m) => String(m.id) !== String(data.messageId)));
      else load();
    }
  }), [sessionId, load]);

  // Follow the bottom, but only if the person was already at the bottom —
  // yanking somebody back down while they are reading is worse than a badge.
  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = async () => {
    const text = body.trim();
    if (!text || sending) return;
    const temp = { id: `tmp-${Date.now()}`, body: text, full_name: 'You', pending: true, created_at: new Date().toISOString() };
    setMessages((cur) => [...cur, temp]);
    setBody('');
    setSending(true);
    try {
      await arena.say(sessionId, { body: text, spinId });
      // The confirmed row arrives over the stream and replaces the pending one.
    } catch (e) {
      setMessages((cur) => cur.map((m) => (m.id === temp.id ? { ...m, failed: true, pending: false } : m)));
      setBody(text);                                     // never lose what they typed
      showMessage((e && e.message) || 'That message did not send.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={`arena-card arena-chat${compact ? ' compact' : ''}`}>
      <h3>The room</h3>
      {!!pinned.length && (
        <ul className="arena-pinned">
          {pinned.map((p) => (
            <li key={p.id}><strong>{p.full_name}</strong> {p.body}</li>
          ))}
        </ul>
      )}
      {hasMore && (
        <button className="btn ghost small" onClick={() => load(messages[0] && messages[0].id)}>
          Show earlier
        </button>
      )}
      <ul
        className="arena-messages"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {messages.map((m) => (
          <li key={m.id} className={`${m.pending ? 'pending' : ''}${m.failed ? ' failed' : ''}`}>
            <span className="arena-msg-who">{m.full_name || 'Someone'}</span>
            <span className="arena-msg-body">{m.body}</span>
            <span className="arena-msg-acts">
              {['🎉', '🔥', '👏'].map((e) => (
                <button
                  key={e} className="arena-react" title={`React ${e}`}
                  onClick={() => { if (!m.pending) arena.react(m.id, e).catch(() => {}); }}
                >{e}{(m.reaction_counts && m.reaction_counts[e]) ? ` ${m.reaction_counts[e]}` : ''}</button>
              ))}
              {isSuper && !m.pending && (
                <>
                  <button className="arena-react" title="Pin it" onClick={() => arena.moderate(m.id, 'pin').catch(() => {})}>📌</button>
                  <button className="arena-react" title="Remove it" onClick={() => arena.moderate(m.id, 'delete').catch(() => {})}>✕</button>
                </>
              )}
            </span>
            {m.failed && <span className="arena-msg-failed">did not send</span>}
          </li>
        ))}
        {!messages.length && <li className="muted">Nobody has said anything yet.</li>}
      </ul>
      <div className="arena-say">
        <input
          className="input" value={body} maxLength={1000} placeholder="Say something…"
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
        />
        <button className="btn small" disabled={!body.trim() || sending} onClick={send}>Send</button>
      </div>
    </div>
  );
}
