import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { BrandLockup } from '../components/Layout.jsx';

/* #75 — magic-link guest chat. An external email participant opens the chat
   online via their unguessable key (chat+<key>@… reply address ↔ this page). The
   key authorizes ONLY this one conversation — read + post, no files, no other
   chats, no portal login. Email keeps flowing regardless; this just lets them
   come online. Self-contained (plain fetch, no auth token). */

const api = {
  async load(key) {
    const r = await fetch(`/api/guest/${encodeURIComponent(key)}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'This chat link is no longer active.');
    return r.json();
  },
  async poll(key) {
    const r = await fetch(`/api/guest/${encodeURIComponent(key)}`);
    if (!r.ok) return null;
    return r.json();
  },
  async send(key, body) {
    const r = await fetch(`/api/guest/${encodeURIComponent(key)}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not send your message.');
    return r.json();
  },
};

const fmtTime = (iso) => { try { return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };

export default function GuestChat() {
  const { key } = useParams();
  const [state, setState] = useState({ loading: true, error: '', me: null, conv: null, messages: [] });
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);

  const scrollDown = () => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; };

  const apply = useCallback((d) => {
    setState({ loading: false, error: '', me: d.me, conv: d.conversation, messages: d.messages || [] });
  }, []);

  useEffect(() => {
    let live = true;
    api.load(key).then(d => { if (live) { apply(d); setTimeout(scrollDown, 30); } })
      .catch(e => { if (live) setState({ loading: false, error: e.message, me: null, conv: null, messages: [] }); });
    // Light polling so a reply from the team appears without a refresh.
    const t = setInterval(() => {
      api.poll(key).then(d => { if (live && d) { const atBottom = (() => { const el = scrollRef.current; return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80; })(); apply(d); if (atBottom) setTimeout(scrollDown, 30); } }).catch(() => {});
    }, 6000);
    return () => { live = false; clearInterval(t); };
  }, [key, apply]);

  async function submit(e) {
    e.preventDefault();
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const r = await api.send(key, text);
      setBody('');
      setState(s => ({ ...s, messages: [...s.messages, r.message] }));
      setTimeout(scrollDown, 30);
    } catch (err) {
      setState(s => ({ ...s, error: err.message }));
    } finally { setSending(false); }
  }

  if (state.loading) return <div className="wrap" style={{ padding: 40 }}><p className="muted">Loading…</p></div>;

  if (state.error && !state.conv) {
    return (
      <div className="wrap" style={{ maxWidth: 460, padding: '48px 24px', textAlign: 'center' }}>
        <BrandLockup />
        <div className="panel" style={{ marginTop: 20 }}>
          <h3>Chat link expired</h3>
          <p className="muted">{state.error}</p>
          <p className="muted small">If you still need to reach the team, just reply to any email they sent you.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="wrap" style={{ maxWidth: 640, padding: '20px 16px', display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <BrandLockup />
      </div>
      <div className="panel" style={{ padding: '12px 16px', marginBottom: 10 }}>
        <strong>{state.conv.emoji ? `${state.conv.emoji} ` : ''}{state.conv.name}</strong>
        <div className="muted small">You’re in this chat as {state.me.name}. Messages you send go to the YS Capital team; you can also just reply to their emails.</div>
      </div>

      <div ref={scrollRef} className="panel" style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 240 }}>
        {state.messages.length === 0 && <p className="muted small">No messages yet.</p>}
        {state.messages.map((m) => m.system ? (
          <div key={m.seq} className="muted small" style={{ textAlign: 'center', padding: '2px 0' }}>{m.body}</div>
        ) : (
          <div key={m.seq} style={{ alignSelf: m.mine ? 'flex-end' : 'flex-start', maxWidth: '82%' }}>
            <div className="muted small" style={{ marginBottom: 2, textAlign: m.mine ? 'right' : 'left' }}>
              {m.mine ? 'You' : m.from} · {fmtTime(m.at)}
            </div>
            <div style={{ padding: '8px 12px', borderRadius: 12, background: m.mine ? 'var(--primary-soft)' : 'var(--surface-soft)', border: '1px solid var(--line)', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
              {m.body}
              {m.attachment && <span className="muted small" style={{ display: 'block', marginTop: 4 }}>({m.attachment} — view with the team)</span>}
            </div>
          </div>
        ))}
      </div>

      {state.error && <div className="notice err small" style={{ marginTop: 8 }}>{state.error}</div>}
      <form onSubmit={submit} style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <input className="input" style={{ flex: 1 }} placeholder="Write a message…" value={body}
          onChange={e => setBody(e.target.value)} disabled={sending} />
        <button className="btn primary" type="submit" disabled={sending || !body.trim()}>{sending ? 'Sending…' : 'Send'}</button>
      </form>
      <p className="muted small" style={{ marginTop: 14, textAlign: 'center' }}>
        YS Capital Group · NMLS #2609746 · Business-purpose lending only.
      </p>
    </div>
  );
}
