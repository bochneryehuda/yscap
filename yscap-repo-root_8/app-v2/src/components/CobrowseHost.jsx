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
      and type for you. Click anywhere, press a key, or press Stop to take it back."
      Nothing is driven until Allow; the banner turns to "X is controlling your
      screen" with a Take back button; the request cancels itself after 30 seconds.
      TAKING IT BACK IS AN ACT, NOT A MOUSE MOVE — see armDriving in lib/cobrowse.js
      for why a passive move may never release control.

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
  const { token, isBorrowerView, isTpo, isAssistant } = useAuth();
  // A TPO broker (kind 'tpo' — their own login, or a staffer inside a broker view) is refused
  // by every co-browse door, so the host stands down for them rather than polling a 403.
  const eligible = !!token && !isBorrowerView && !isTpo && !isAssistant;
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

  // ONE reading of the register, used by the load and by the safety poll — two copies is
  // how a rejoin quietly loses the control prompt that was waiting with it.
  const adopt = useCallback((r) => {
    if (activeRef.current) return true;
    if (r && r.active && r.active.isWatched) {
      begin(r.active);
      if (r.active.control && r.active.control.status === 'requested') setControlAsk({ sessionId: r.active.id, viewer: r.active.viewer, expiresAt: r.active.control.expiresAt });
      return true;
    }
    if (r && r.pending && r.pending.length) { setPending(r.pending[0]); return true; }
    return false;
  }, [begin]);

  // A door that REFUSES this session (a staffer inside a view-as: the routes answer 403
  // `inside_view`) is refused for as long as that session lasts, so asking again every 10 s
  // is pure noise. One refusal stands the poll down until the token changes.
  const refusedRef = useRef(false);

  // On load / sign-in: any prompt waiting for me, and any live session to rejoin (a
  // reload). On sign-out or entering a view-as: everything down, recording stopped.
  useEffect(() => {
    refusedRef.current = false;   // a new token is a new answer
    if (!eligible) {
      stopGuest('signed_out');
      activeRef.current = null; setActive(null); setPending(null); setControlAsk(null);
      setLink({ connected: false, recording: false, control: 'none' });
      return;
    }
    api.cobrowseMine().then((r) => {
      if (adopt(r)) { /* a live session or a prompt was taken up */ }
      const remembered = rememberedSessionId();
      if (remembered && !(r && r.active)) { try { sessionStorage.removeItem('ys_cobrowse_session'); } catch { /* fine */ } }
    }).catch((e) => {
      const code = e && (e.code || e.body && e.body.code);
      if (code === 'inside_view' || code === 'proxy_actor' || (e && e.status === 403)) refusedRef.current = true;
    });
  }, [adopt, eligible, token]);

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
      if (refusedRef.current) return;
      // A tab nobody is looking at cannot show a prompt anyway; it reads the register when
      // it comes back (the browser fires visibilitychange, and this interval keeps running).
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      api.cobrowseMine().then(adopt).catch((e) => {
        const code = e && (e.code || e.body && e.body.code);
        if (code === 'inside_view' || code === 'proxy_actor' || (e && e.status === 403)) refusedRef.current = true;
      });
    }, POLL_MS);
    return () => clearInterval(t);
  }, [eligible, active, pending, token, adopt]);

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

  // THE BANNER MUST NOT COVER THE APP. It is `position:fixed`, so without this the page's
  // own sticky top bar sits UNDER it — and on a phone that bar holds the hamburger, which is
  // the only way to open the navigation: the guest could not move around their own PILOT
  // while being watched (the two-browser drive reproduced it, as a click that never landed).
  // The height is MEASURED, not assumed: the text wraps to two or three lines at 390px and
  // grows again when the web fonts arrive, so a constant would be wrong on exactly the
  // screens that matter. `--cobrowse-bar` also offsets the other two fixed top banners.
  const bannerRef = useRef(null);
  useEffect(() => {
    const el = bannerRef.current;
    if (!active || !el) return undefined;
    const root = document.documentElement;
    const apply = () => {
      const h = Math.ceil(el.getBoundingClientRect().height || 0);
      root.style.setProperty('--cobrowse-bar', `${h}px`);
      document.body.style.paddingTop = `${h}px`;
      root.style.scrollPaddingTop = `${h}px`;   // an in-page #anchor lands below the bar
    };
    apply();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(apply) : null;
    if (ro) ro.observe(el);
    window.addEventListener('resize', apply);
    window.addEventListener('load', apply);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener('resize', apply); window.removeEventListener('load', apply);
      root.style.removeProperty('--cobrowse-bar');
      document.body.style.paddingTop = '';
      root.style.scrollPaddingTop = '';
    };
  }, [active, link.control, link.connected]);

  // A PROMPT ARRIVES UNANNOUNCED, OVER WHATEVER THEY WERE DOING. Two consequences, both
  // handled here: focusing an ANSWER button would put the guest's next keystroke on
  // "Accept" (a stray Enter or Space would then share their screen), and their sentence
  // would lose its remaining letters. So the DIALOG is focused — the reader is moved, no
  // answer is armed — and Enter/Space are ignored for a beat while their hands catch up.
  const askRef = useRef(null);
  const askArmedRef = useRef(0);
  useEffect(() => {
    if (!pending && !controlAsk) return undefined;
    askArmedRef.current = Date.now();
    const el = askRef.current;
    if (el) { try { el.focus({ preventScroll: true }); } catch { /* fine */ } }
    const swallow = (e) => {
      if (Date.now() - askArmedRef.current > 600) return;
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('keydown', swallow, true);
    return () => window.removeEventListener('keydown', swallow, true);
  }, [pending, controlAsk]);

  const viewerName = (p) => (p && p.viewer && p.viewer.name) || 'A team member';

  return (
    <>
      {active && (
        <>
          {/* The red frame while somebody else is driving — the whole page says so, not only the bar. */}
          <style>{`html.cobrowse-controlled body{outline:4px solid #B3261E;outline-offset:-4px}`}</style>
          <div ref={bannerRef} role="status" aria-live="polite" data-cobrowse-ui="banner" style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 19999,
            background: link.control === 'granted' ? '#B3261E' : '#7A1F1F', color: '#fff', padding: '8px 14px', display: 'flex', alignItems: 'center',
            justifyContent: 'center', gap: 12, fontSize: 14, boxShadow: '0 2px 6px rgba(0,0,0,.25)', flexWrap: 'wrap' }}>
            <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 5, background: link.recording ? '#FF4D4D' : '#BBB', display: 'inline-block' }} />
            {link.control === 'granted' ? (
              <span><strong>{viewerName(active)}</strong> is controlling your screen — they can click and type for you.
                {' '}Click anywhere, press a key, or press Take back, to take control back.</span>
            ) : (
              <span><strong>{viewerName(active)}</strong> is watching your screen{link.connected ? '' : ' (reconnecting…)'}.
                {' '}Your passwords and security codes are hidden from them, and so is your Social Security number everywhere PILOT shows it.</span>
            )}
            {link.control === 'granted' && (
              <button type="button" data-cobrowse-nodrive="take-back" className="btn small" style={{ background: '#fff', color: '#141B22', border: 'none' }} onClick={takeBack}>Take back</button>
            )}
            <button type="button" data-cobrowse-nodrive="stop" className="btn small" style={{ background: '#fff', color: '#141B22', border: 'none' }} onClick={stop}>Stop</button>
          </div>
        </>
      )}
      {active && controlAsk && (
        <div className="cv-modal-back cobrowse-consent" role="presentation">
          <div ref={askRef} tabIndex={-1} className="cv-modal app-dialog" role="dialog" aria-modal="true" aria-labelledby="cb-ctl-title" aria-describedby="cb-ctl-body">
            <div className="app-dialog-head">
              <span className="app-dialog-mark" aria-hidden="true" />
              <div>
                <p className="app-dialog-kicker">PILOT</p>
                <h3 id="cb-ctl-title" className="app-dialog-title">Let them control your screen?</h3>
              </div>
            </div>
            <p id="cb-ctl-body" className="app-dialog-body" style={{ color: '#141B22' }}>
              <strong>{viewerName(controlAsk)}</strong> asks to control your screen — they can click and type for you.
              {'\n'}Click anywhere, press a key, or press Take back at any time to take it back. Your passwords and security codes stay hidden, and so does your Social Security number everywhere PILOT shows it; they cannot sign documents, pick files, or sign you out.
            </p>
            <div className="app-dialog-actions">
              <button type="button" className="btn ghost" onClick={() => answerControl(false)}>No, keep watching only</button>
              <button type="button" className="btn primary" onClick={() => answerControl(true)}>Allow control</button>
            </div>
          </div>
        </div>
      )}
      {pending && !active && (
        <div className="cv-modal-back cobrowse-consent" role="presentation">
          <div ref={askRef} tabIndex={-1} className="cv-modal app-dialog" role="dialog" aria-modal="true" aria-labelledby="cb-ask-title" aria-describedby="cb-ask-body">
            <div className="app-dialog-head">
              <span className="app-dialog-mark" aria-hidden="true" />
              <div>
                <p className="app-dialog-kicker">PILOT</p>
                <h3 id="cb-ask-title" className="app-dialog-title">Share your screen?</h3>
              </div>
            </div>
            <p id="cb-ask-body" className="app-dialog-body" style={{ color: '#141B22' }}>
              <strong>{viewerName(pending)}</strong> from YS Capital wants to see your screen.
              {'\n'}They will see what you see on PILOT while you use it. Your passwords and security codes are always hidden, and so is your Social Security number everywhere PILOT shows it. You can stop at any time.
              {'\n'}Your screen is shared live with this one person only, for this session only. PILOT records who watched and when; it never records the screen itself.
            </p>
            <div className="app-dialog-actions">
              <button type="button" className="btn ghost" onClick={() => answer(false)}>Decline</button>
              <button type="button" className="btn primary" onClick={() => answer(true)}>Accept</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
