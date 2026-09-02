import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, getToken } from '../lib/api.js';
import { subscribeChat } from '../lib/chatEvents.js';
import { startGuest, stopGuest, rememberedSessionId } from '../lib/cobrowse.js';

/* CO-BROWSING HOST — the GUEST side, mounted ONCE in App (beside AppDialogHost) so
   it covers the borrower portal and the staff console alike (owner-directed
   2026-09-02: borrowers and team members are both people who can be watched).

   Two jobs, both only for the person BEING WATCHED:
   1. THE CONSENT PROMPT. "Malky from YS Capital wants to see your screen.
      Accept / Decline" (the owner's wording). It arrives live over the SSE bus
      (cobrowse:request) and is also re-read from the server on load, so a prompt
      is never lost to a closed tab. Declining, ignoring (it expires on its own),
      or being inside a "view as" session all mean: nothing is recorded.
   2. THE BANNER while a session is live: "X is watching your screen — Stop".
      Always visible, on every screen, with the one button that ends it. Recording
      begins only after Accept and stops the instant they press Stop, sign out, or
      the viewer leaves.

   Text colours are explicit darks (never an --ink* token). */
export default function CobrowseHost() {
  const [pending, setPending] = useState(null);   // the request being shown
  const [active, setActive] = useState(null);     // { id, viewer:{name} }
  const [link, setLink] = useState({ connected: false, recording: false });
  const activeRef = useRef(null);

  const begin = useCallback((session) => {
    activeRef.current = session;
    setActive(session);
    startGuest(session.id, (st) => {
      if (st.ended) { activeRef.current = null; setActive(null); setLink({ connected: false, recording: false }); return; }
      setLink((l) => ({ ...l, ...st }));
    });
  }, []);

  // On load: any prompt waiting for me, and any live session to rejoin (a reload).
  useEffect(() => {
    if (!getToken()) return;
    api.cobrowseMine().then((r) => {
      if (r && r.active && r.active.isWatched) begin(r.active);
      else if (r && r.pending && r.pending.length) setPending(r.pending[0]);
      const remembered = rememberedSessionId();
      if (remembered && !(r && r.active)) { try { sessionStorage.removeItem('ys_cobrowse_session'); } catch { /* fine */ } }
    }).catch(() => {});
  }, [begin]);

  // Live: a new request, or the session ended from the other side.
  useEffect(() => {
    if (!getToken()) return undefined;
    return subscribeChat((event, data) => {
      if (event === 'cobrowse:request' && data && data.sessionId) {
        setPending({ id: data.sessionId, viewer: data.viewer || {}, expiresAt: data.expiresAt });
      } else if (event === 'cobrowse:update' && data && data.sessionId) {
        if (pending && pending.id === data.sessionId && data.status !== 'requested') setPending(null);
        if (activeRef.current && activeRef.current.id === data.sessionId && data.status !== 'active') stopGuest(data.endReason || 'ended');
      } else if (event === 'reconnect') {
        api.cobrowseMine().then((r) => { if (r && r.pending && r.pending.length && !activeRef.current) setPending(r.pending[0]); }).catch(() => {});
      }
    });
  }, [pending]);

  // A request that nobody answers goes away when the server says it expired.
  useEffect(() => {
    if (!pending || !pending.expiresAt) return undefined;
    const ms = Math.max(1000, new Date(pending.expiresAt).getTime() - Date.now() + 1500);
    const t = setTimeout(() => setPending((p) => (p && p.id === pending.id ? null : p)), ms);
    return () => clearTimeout(t);
  }, [pending]);

  const answer = async (accept) => {
    const p = pending; if (!p) return;
    setPending(null);
    try {
      const r = await api.cobrowseRespond(p.id, accept);
      if (accept && r && r.session && r.session.status === 'active') begin(r.session);
    } catch { /* the request expired or was withdrawn — nothing to show */ }
  };
  const stop = async () => {
    const a = activeRef.current; if (!a) return;
    stopGuest('stopped_by_guest');
    api.cobrowseEnd(a.id).catch(() => {});
  };

  const viewerName = (p) => (p && p.viewer && p.viewer.name) || 'A team member';

  return (
    <>
      {active && (
        <div role="status" aria-live="polite" style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 1002,
          background: '#7A1F1F', color: '#fff', padding: '8px 14px', display: 'flex', alignItems: 'center',
          justifyContent: 'center', gap: 12, fontSize: 14, boxShadow: '0 2px 6px rgba(0,0,0,.25)' }}>
          <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 5, background: link.recording ? '#FF4D4D' : '#BBB', display: 'inline-block' }} />
          <span><strong>{viewerName(active)}</strong> is watching your screen{link.connected ? '' : ' (reconnecting…)'}.
            {' '}Passwords and Social Security numbers are hidden from them.</span>
          <button type="button" className="btn small" style={{ background: '#fff', color: '#141B22', border: 'none' }} onClick={stop}>Stop</button>
        </div>
      )}
      {pending && !active && (
        <div className="cv-modal-back" role="presentation">
          <div className="cv-modal app-dialog" role="dialog" aria-modal="true" aria-labelledby="cb-ask-title" aria-describedby="cb-ask-body">
            <div className="app-dialog-head">
              <span className="app-dialog-mark" aria-hidden="true" />
              <div>
                <p className="app-dialog-kicker">PILOT</p>
                <h3 id="cb-ask-title" className="app-dialog-title">Share your screen?</h3>
              </div>
            </div>
            <p id="cb-ask-body" className="app-dialog-body" style={{ color: '#141B22' }}>
              <strong>{viewerName(pending)}</strong> from YS Capital wants to see your screen.
              {'\n'}They will see what you see on PILOT while you use it — but never your passwords or Social Security number — and you can stop at any time.
            </p>
            <div className="app-dialog-actions">
              <button type="button" className="btn ghost" onClick={() => answer(false)}>Decline</button>
              <button type="button" className="btn primary" autoFocus onClick={() => answer(true)}>Accept</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
