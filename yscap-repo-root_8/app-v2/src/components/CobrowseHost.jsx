import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { subscribeChat } from '../lib/chatEvents.js';
import { startGuest, stopGuest, rememberedSessionId, releaseFromGuest } from '../lib/cobrowse.js';

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
   3. THE SECOND CONSENT (Phase B): "X asks to control your screen — they can click
      and type for you. Move your mouse or press Stop to take it back." Nothing is
      driven until Allow; the banner turns to "X is controlling your screen" with
      a Take back button; the request cancels itself after 30 seconds.

   Text colours are explicit darks (never an --ink* token). */
/** While nothing is showing, the register is re-read this often — the SSE stream is the fast path, not the only one. */
const POLL_MS = 10000;

export default function CobrowseHost() {
  // THE TOKEN COMES FROM THE AUTH CONTEXT, NOT A ONE-TIME READ (pre-merge audit
  // 2026-09-02): sign-in is in-SPA and this host is mounted above the routes, so an
  // effect keyed on a value read once at mount would never run for the ordinary
  // "land on /login, sign in" flow — no prompt would ever arrive until a reload.
  // And NEVER inside a view-as: a staffer standing in a borrower's portal is not
  // that borrower and must be neither prompted nor recorded (the server refuses
  // too; this keeps the banner and the reconnect loop off their console).
  const { token, isBorrowerView, isTpoView, isAssistant } = useAuth();
  const eligible = !!token && !isBorrowerView && !isTpoView && !isAssistant;
  const [pending, setPending] = useState(null);   // the request being shown
  const [active, setActive] = useState(null);     // { id, viewer:{name} }
  const [link, setLink] = useState({ connected: false, recording: false, control: 'none' });
  const [controlAsk, setControlAsk] = useState(null);   // { sessionId, viewer, expiresAt }
  const activeRef = useRef(null);

  const begin = useCallback((session) => {
    activeRef.current = session;
    setActive(session);
    startGuest(session.id, (st) => {
      if (st.ended) { activeRef.current = null; setActive(null); setControlAsk(null); setLink({ connected: false, recording: false, control: 'none' }); return; }
      setLink((l) => ({ ...l, ...st }));
      if (st.control && st.control !== 'requested') setControlAsk(null);
    });
  }, []);

  // On load / sign-in: any prompt waiting for me, and any live session to rejoin (a
  // reload). On sign-out or entering a view-as: everything down, recording stopped.
  useEffect(() => {
    if (!eligible) {
      stopGuest('signed_out');
      activeRef.current = null; setActive(null); setPending(null); setControlAsk(null);
      setLink({ connected: false, recording: false, control: 'none' });
      return;
    }
    api.cobrowseMine().then((r) => {
      if (r && r.active && r.active.isWatched) {
        begin(r.active);
        if (r.active.control && r.active.control.status === 'requested') setControlAsk({ sessionId: r.active.id, viewer: r.active.viewer, expiresAt: r.active.control.expiresAt });
      } else if (r && r.pending && r.pending.length) setPending(r.pending[0]);
      const remembered = rememberedSessionId();
      if (remembered && !(r && r.active)) { try { sessionStorage.removeItem('ys_cobrowse_session'); } catch { /* fine */ } }
    }).catch(() => {});
  }, [begin, eligible, token]);

  // Live: a new request, or the session ended from the other side.
  useEffect(() => {
    if (!eligible) return undefined;
    return subscribeChat((event, data) => {
      if (event === 'cobrowse:request' && data && data.sessionId) {
        setPending({ id: data.sessionId, viewer: data.viewer || {}, expiresAt: data.expiresAt });
      } else if (event === 'cobrowse:update' && data && data.sessionId) {
        if (pending && pending.id === data.sessionId && data.status !== 'requested') setPending(null);
        if (activeRef.current && activeRef.current.id === data.sessionId && data.status !== 'active') stopGuest(data.endReason || 'ended');
      } else if (event === 'cobrowse:control' && data && data.sessionId) {
        const a = activeRef.current;
        if (!a || a.id !== data.sessionId) return;
        if (data.status === 'requested') setControlAsk({ sessionId: data.sessionId, viewer: data.viewer || a.viewer || {}, expiresAt: data.expiresAt });
        else setControlAsk(null);
      } else if (event === 'reconnect') {
        api.cobrowseMine().then((r) => { if (r && r.pending && r.pending.length && !activeRef.current) setPending(r.pending[0]); }).catch(() => {});
      }
    });
  }, [pending, eligible, token]);

  // SAFETY POLL. A request reaches this screen live over the SSE stream — and a stream
  // is not a guarantee: it may not be open yet (a request that lands a second after the
  // page rendered), it may be between reconnects with no 'reconnect' event fired, or a
  // laptop may have just woken. A request nobody sees expires in 90 s and the viewer sits
  // on "waiting…". So while NOTHING is showing — no live session, no prompt — the register
  // is re-read every POLL_MS (one indexed query); the moment something is showing, the
  // stream carries the rest. Proven by the two-browser drive, which asks the instant the
  // Team screen renders.
  useEffect(() => {
    if (!eligible || active || pending) return undefined;
    const t = setInterval(() => {
      api.cobrowseMine().then((r) => {
        if (activeRef.current) return;
        if (r && r.active && r.active.isWatched) begin(r.active);
        else if (r && r.pending && r.pending.length) setPending(r.pending[0]);
      }).catch(() => {});
    }, POLL_MS);
    return () => clearInterval(t);
  }, [eligible, active, pending, token, begin]);

  // A request that nobody answers goes away when the server says it expired.
  useEffect(() => {
    if (!pending || !pending.expiresAt) return undefined;
    const ms = Math.max(1000, new Date(pending.expiresAt).getTime() - Date.now() + 1500);
    const t = setTimeout(() => setPending((p) => (p && p.id === pending.id ? null : p)), ms);
    return () => clearTimeout(t);
  }, [pending]);

  // A control request nobody answers cancels itself (the server's 30 s; we mirror it).
  useEffect(() => {
    if (!controlAsk || !controlAsk.expiresAt) return undefined;
    const ms = Math.max(1000, new Date(controlAsk.expiresAt).getTime() - Date.now() + 1500);
    const t = setTimeout(() => setControlAsk((c) => (c && c.sessionId === controlAsk.sessionId ? null : c)), ms);
    return () => clearTimeout(t);
  }, [controlAsk]);

  const answerControl = async (accept) => {
    const c = controlAsk; if (!c) return;
    setControlAsk(null);
    try { await api.cobrowseControlRespond(c.sessionId, accept); } catch { /* it expired or the session ended */ }
  };
  const takeBack = () => { releaseFromGuest(null, 'guest_stop'); };

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
        <>
          {/* The red frame while somebody else is driving — the whole page says so, not only the bar. */}
          <style>{`html.cobrowse-controlled body{outline:4px solid #B3261E;outline-offset:-4px}`}</style>
          <div role="status" aria-live="polite" style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 19999,
            background: link.control === 'granted' ? '#B3261E' : '#7A1F1F', color: '#fff', padding: '8px 14px', display: 'flex', alignItems: 'center',
            justifyContent: 'center', gap: 12, fontSize: 14, boxShadow: '0 2px 6px rgba(0,0,0,.25)', flexWrap: 'wrap' }}>
            <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 5, background: link.recording ? '#FF4D4D' : '#BBB', display: 'inline-block' }} />
            {link.control === 'granted' ? (
              <span><strong>{viewerName(active)}</strong> is controlling your screen — they can click and type for you.
                {' '}Move your mouse, or press Take back, to take control back.</span>
            ) : (
              <span><strong>{viewerName(active)}</strong> is watching your screen{link.connected ? '' : ' (reconnecting…)'}.
                {' '}Passwords and Social Security numbers are hidden from them.</span>
            )}
            {link.control === 'granted' && (
              <button type="button" className="btn small" style={{ background: '#fff', color: '#141B22', border: 'none' }} onClick={takeBack}>Take back</button>
            )}
            <button type="button" className="btn small" style={{ background: '#fff', color: '#141B22', border: 'none' }} onClick={stop}>Stop</button>
          </div>
        </>
      )}
      {active && controlAsk && (
        <div className="cv-modal-back cobrowse-consent" role="presentation">
          <div className="cv-modal app-dialog" role="dialog" aria-modal="true" aria-labelledby="cb-ctl-title" aria-describedby="cb-ctl-body">
            <div className="app-dialog-head">
              <span className="app-dialog-mark" aria-hidden="true" />
              <div>
                <p className="app-dialog-kicker">PILOT</p>
                <h3 id="cb-ctl-title" className="app-dialog-title">Let them control your screen?</h3>
              </div>
            </div>
            <p id="cb-ctl-body" className="app-dialog-body" style={{ color: '#141B22' }}>
              <strong>{viewerName(controlAsk)}</strong> asks to control your screen — they can click and type for you.
              {'\n'}Move your mouse or press Stop at any time to take it back. They still cannot see your passwords or Social Security number, and they cannot sign documents, pick files, or sign you out.
            </p>
            <div className="app-dialog-actions">
              <button type="button" className="btn ghost" onClick={() => answerControl(false)}>No, keep watching only</button>
              <button type="button" className="btn primary" autoFocus onClick={() => answerControl(true)}>Allow control</button>
            </div>
          </div>
        </div>
      )}
      {pending && !active && (
        <div className="cv-modal-back cobrowse-consent" role="presentation">
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
              {'\n'}Your screen is shared live with this one person only, for this session only. PILOT records who watched and when; it never records the screen itself.
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
