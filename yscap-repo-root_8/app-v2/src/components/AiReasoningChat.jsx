import React, { useState, useRef, useEffect } from 'react';
import { api } from '../lib/api.js';

/**
 * AiReasoningChat — a real back-and-forth "ask PILOT why" for one loan file (AI Command Center
 * phase 2, owner-directed 2026-07-24). The underwriter types a question ("why did you flag the
 * bank statement?", "what does the file say about the ARV?") and PILOT answers grounded ONLY on
 * the loan-file facts — it never invents a number, and it never changes or clears anything (it
 * explains; a human decides). The conversation is ephemeral (held here, sent back each turn).
 *
 * Degrades gracefully: if the AI brain isn't turned on for the workspace, or the file hit its
 * AI spending cap, PILOT says so plainly instead of erroring. Collapsed by default so it never
 * clutters the findings panel.
 */
export default function AiReasoningChat({ appId }) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState([]);   // { role:'user'|'assistant'|'note', text }
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [msgs, open]);

  async function send() {
    const q = input.trim();
    if (!q || busy || !appId) return;
    setInput('');
    const next = [...msgs, { role: 'user', text: q }];
    setMsgs(next);
    setBusy(true);
    try {
      // Send only the real Q/A turns (not local notes) as history.
      const history = next.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, text: m.text }));
      const r = await api.aiReason(appId, q, history.slice(0, -1)); // history BEFORE this question
      if (r && r.available === false) {
        setMsgs((m) => [...m, { role: 'note', text: r.reason || 'PILOT’s reasoning assistant isn’t turned on here yet.' }]);
      } else if (r && r.answer) {
        setMsgs((m) => [...m, { role: 'assistant', text: r.answer }]);
      } else {
        setMsgs((m) => [...m, { role: 'note', text: (r && r.reason) || 'PILOT couldn’t answer just now — try again in a moment.' }]);
      }
    } catch (e) {
      setMsgs((m) => [...m, { role: 'note', text: (e && e.message) || 'Something went wrong reaching PILOT.' }]);
    } finally {
      setBusy(false);
    }
  }

  if (!appId) return null;

  return (
    <div style={{ marginBottom: 10, border: '1px solid var(--line,#E4DECF)', borderRadius: 10, background: 'var(--paper,#F6F3EC)' }}>
      <div onClick={() => setOpen(!open)}
        style={{ cursor: 'pointer', padding: '7px 11px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 700 }}>
        <span>Ask PILOT</span>
        <span style={{ fontWeight: 400, color: 'var(--muted,#4B585C)' }}>— “why did you flag this?”, “what does the file say about…?”</span>
        <span style={{ marginLeft: 'auto', color: 'var(--muted,#4B585C)' }}>{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div style={{ padding: '0 11px 11px' }}>
          <div ref={scrollRef} style={{ maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 7, padding: '6px 0' }}>
            {msgs.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--muted,#4B585C)' }}>
                PILOT answers only from this file’s facts and never changes anything — it explains, you decide.
              </div>
            )}
            {msgs.map((m, i) => {
              if (m.role === 'note') {
                return <div key={i} style={{ fontSize: 11.5, color: 'var(--muted,#4B585C)', fontStyle: 'italic' }}>{m.text}</div>;
              }
              const mine = m.role === 'user';
              return (
                <div key={i} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '88%' }}>
                  <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted,#4B585C)', marginBottom: 1 }}>{mine ? 'You' : 'PILOT'}</div>
                  <div style={{
                    fontSize: 12.5, lineHeight: 1.45, whiteSpace: 'pre-wrap',
                    background: mine ? 'var(--teal,#2F7F86)' : 'var(--card,#fff)',
                    color: mine ? '#fff' : 'var(--ink,#141B22)',
                    border: mine ? 'none' : '1px solid var(--line,#E4DECF)',
                    borderRadius: 9, padding: '6px 9px',
                  }}>{m.text}</div>
                </div>
              );
            })}
            {busy && <div style={{ fontSize: 11.5, color: 'var(--muted,#4B585C)', fontStyle: 'italic' }}>PILOT is thinking…</div>}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder="Ask about this file…"
              disabled={busy}
              style={{ flex: 1, fontSize: 13, padding: '7px 10px', borderRadius: 8, border: '1px solid var(--line,#E4DECF)', background: 'var(--card,#fff)' }}
            />
            <button className="btn" onClick={send} disabled={busy || !input.trim()} style={{ fontSize: 12, padding: '6px 14px' }}>Ask</button>
          </div>
        </div>
      )}
    </div>
  );
}
