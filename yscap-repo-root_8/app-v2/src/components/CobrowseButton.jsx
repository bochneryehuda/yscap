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
   a refusal is shown inline, never a dead button. `kind` is 'staff' | 'borrower'. */
export default function CobrowseButton({ kind, id, name = '', applicationId = null, className = 'btn ghost small', label = 'Co-browse' }) {
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
    setPhase('idle');
  };

  const first = (name || '').split(' ')[0] || (kind === 'borrower' ? 'the borrower' : 'them');
  return (
    <span className="row" style={{ gap: 8, flex: 'none', alignItems: 'center', flexWrap: 'wrap' }}>
      {phase === 'waiting' ? (
        <span className="small" style={{ color: '#3A4550', display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <span className="spin" aria-hidden="true" />
          Waiting for {first} to accept…
          <button type="button" className="btn link small" onClick={cancel}>Cancel</button>
        </span>
      ) : (
        <button type="button" className={className} style={{ flex: 'none' }} disabled={phase === 'asking'} onClick={ask}
          title={name
            ? `Ask ${name} to let you watch their live PILOT screen — they see a request and must accept. You cannot click for them (that is a later step).`
            : 'Ask this person to let you watch their live PILOT screen — they must accept first.'}>
          {phase === 'asking' ? 'Asking…' : label}
        </button>
      )}
      {phase === 'declined' && <span className="small" role="status" style={{ color: '#B3261E' }}>{first} declined.</span>}
      {phase === 'expired' && <span className="small" role="status" style={{ color: '#4B585C' }}>No answer — the request expired.</span>}
      {err && <span className="small" role="alert" style={{ color: '#B3261E' }}>{err}</span>}
    </span>
  );
}
