import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { subscribeChat } from '../lib/chatEvents.js';

/* "Co-browse" launcher (owner-directed 2026-09-02). Sits BESIDE "See their screen"
   / "Borrower view" wherever a person is on screen — the Team roster, a loan file
   header, a borrower profile — and is deliberately a different thing from those
   two: nothing runs as the other person. It ASKS them, waits for their answer,
   and only then opens the live viewer.

   Who may press it is the server's decision (one rule, src/lib/cobrowse/sessions.js);
   a refusal is shown inline, never a dead button. `kind` is 'staff' | 'borrower'.

   THE DESIGN IS REAL BUTTONS, NEVER TEXT (owner-directed 2026-09-02: "the CoBrowse
   button a little bit nicer and the cancel button a little bit nicer, with real
   buttons, not just text"). Cancel was a `.btn.link`, which on a crowded roster row
   reads as a sentence; it is a real button on a bordered waiting chip now, and a
   declined / expired ask offers Ask again rather than leaving a dead sentence
   behind. The styles are the `cb-` block in styles.css. */

/** A small screen-and-stand glyph — this is about somebody's SCREEN, not an eye. */
function ScreenIcon() {
  return (
    <svg className="cb-ico" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <rect x="1" y="2" width="14" height="9.5" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 14h5M8 11.5V14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export default function CobrowseButton({ kind, id, name = '', applicationId = null, className = 'btn soft small', label = 'Co-browse' }) {
  const nav = useNavigate();
  const [phase, setPhase] = useState('idle');   // idle | asking | waiting | declined | expired
  const [err, setErr] = useState('');
  const sessionRef = useRef(null);
  const pollRef = useRef(null);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  // The answer arrives live (SSE cobrowse:update) — and, in case that stream is
  // not open on this tab, by a slow poll that stops the moment either resolves.
  useEffect(() => {
    if (phase !== 'waiting') return undefined;
    const settle = (s) => {
      if (!s || !sessionRef.current || s.sessionId !== sessionRef.current && s.id !== sessionRef.current) return;
      const st = s.status;
      if (st === 'active') { setPhase('idle'); nav(`/internal/cobrowse/${sessionRef.current}`); }
      else if (st === 'declined') setPhase('declined');
      else if (st === 'expired' || st === 'ended') setPhase('expired');
    };
    const unsub = subscribeChat((event, data) => { if (event === 'cobrowse:update') settle(data); });
    pollRef.current = setInterval(() => {
      api.cobrowseGet(sessionRef.current).then((r) => settle(r && r.session)).catch(() => {});
    }, 3000);
    return () => { unsub(); if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [phase, nav]);

  if (!id || !kind) return null;

  const ask = async () => {
    if (phase === 'asking' || phase === 'waiting') return;
    setErr(''); setPhase('asking');
    try {
      const r = await api.cobrowseRequest(kind, id, applicationId);
      sessionRef.current = r.session.id;
      setPhase('waiting');
    } catch (e) {
      setErr(e.message || 'Could not send the request.');
      setPhase('idle');
    }
  };
  const cancel = async () => {
    if (sessionRef.current) api.cobrowseEnd(sessionRef.current).catch(() => {});
    sessionRef.current = null;
    setPhase('idle');
  };

  const first = (name || '').split(' ')[0] || (kind === 'borrower' ? 'the borrower' : 'them');
  const answered = phase === 'declined' || phase === 'expired';
  return (
    <span className="row" style={{ gap: 8, flex: 'none', alignItems: 'center', flexWrap: 'wrap' }}>
      {phase === 'waiting' ? (
        <span className="cb-wait" role="status">
          <span className="cb-spin" aria-hidden="true" />
          <span className="cb-wait-text">Waiting for {first} to accept…</span>
          <button type="button" className="btn ghost small" onClick={cancel}>Cancel</button>
        </span>
      ) : answered ? (
        <span className="cb-answer" role="status">
          <span className={phase === 'declined' ? 'cb-answer-no' : 'cb-answer-quiet'}>
            {phase === 'declined' ? `${first} declined.` : 'No answer — the request expired.'}
          </span>
          <button type="button" className="btn soft small cb-btn" onClick={ask}><ScreenIcon />Ask again</button>
        </span>
      ) : (
        <button type="button" className={`${className} cb-btn`} style={{ flex: 'none' }} disabled={phase === 'asking'} onClick={ask}
          title={name
            ? `Ask ${name} to let you watch their live PILOT screen — they see a request and must accept. You cannot click for them until they allow that too.`
            : 'Ask this person to let you watch their live PILOT screen — they must accept first.'}>
          <ScreenIcon />{phase === 'asking' ? 'Asking…' : label}
        </button>
      )}
      {err && <span className="small" role="alert" style={{ color: '#B3261E' }}>{err}</span>}
    </span>
  );
}
