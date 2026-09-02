import React, { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Replayer } from '@rrweb/replay';
import '@rrweb/replay/dist/style.css';
import { api, getToken } from '../lib/api.js';

/* THE VIEWER (owner-directed 2026-09-02).
   Replays the watched person's masked page LIVE inside a sandboxed frame. This is
   a MIRROR — the viewer's own PILOT never navigates, downloads, or acts. A click
   here does nothing to the other person UNTIL they allow control (Phase B, a
   second consent on their screen): then clicks, typing, scrolling and the pointer
   are captured on the mirror and sent as `{t:'input'}` with the rrweb mirror id
   of the element under the pointer — the hub relays them only while the register
   says 'granted', and their browser performs them inside its own allowlist. The
   watched person takes control back by moving their own mouse or pressing Stop. What cannot be mirrored is SAID rather than left blank: their file
   picker and downloads happen on their machine; an outside site (DocuSign,
   SharePoint) opens in a tab we never see.

   Text colours are explicit darks per the HARD RULE. */
const INK = '#141B22', MUTED = '#4B585C';

export default function StaffCobrowse() {
  const { sessionId } = useParams();
  const [session, setSession] = useState(null);
  const [err, setErr] = useState('');
  const [state, setState] = useState({ connected: false, guestOnline: false, route: '', ended: null, control: 'none', notice: null });
  const controlRef = useRef('none');
  const captureRef = useRef(null);
  const hostRef = useRef(null);
  const replayerRef = useRef(null);
  const wsRef = useRef(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    let alive = true;
    api.cobrowseGet(sessionId).then((r) => { if (alive) setSession(r.session); }).catch((e) => { if (alive) setErr(e.message || 'Could not open the session.'); });
    return () => { alive = false; };
  }, [sessionId]);

  // Fit the mirrored page into the panel: rrweb draws at the guest's viewport size.
  const fit = () => {
    const host = hostRef.current; const rp = replayerRef.current;
    if (!host || !rp) return;
    const iframe = rp.iframe; if (!iframe) return;
    const w = Number(iframe.width) || 1280; const h = Number(iframe.height) || 800;
    const s = Math.min(1, (host.clientWidth - 8) / w);
    setScale(s);
    host.style.height = `${Math.ceil(h * s) + 8}px`;
  };

  useEffect(() => {
    if (!session || session.status !== 'active' || !hostRef.current) return undefined;
    const rp = new Replayer([], {
      root: hostRef.current, liveMode: true, mouseTail: false, UNSAFE_replayCanvas: false,
      // Nothing inside the mirror may run: the frame is sandboxed by rrweb; we add nothing.
      speed: 1, showWarning: false, showDebug: false,
    });
    replayerRef.current = rp;
    // A 600ms buffer smooths the stream; a longer one only adds lag.
    rp.startLive(Date.now() - 600);
    rp.on('resize', fit);
    window.addEventListener('resize', fit);

    let retry = null; let closed = false; let backoff = 2500; let retryUntil = 0;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const connect = () => {
      if (closed) return;
      const ws = new WebSocket(`${proto}//${window.location.host}/ws/cobrowse?token=${encodeURIComponent(getToken())}&session=${encodeURIComponent(sessionId)}&role=viewer`);
      wsRef.current = ws;
      ws.onopen = () => { backoff = 2500; retryUntil = 0; setState((s) => ({ ...s, connected: true })); ws.send(JSON.stringify({ t: 'snapshot' })); };
      ws.onmessage = (e) => {
        let m = null; try { m = JSON.parse(String(e.data)); } catch { return; }
        if (!m) return;
        if (m.t === 'rrweb' && Array.isArray(m.events)) { for (const ev of m.events) { try { rp.addEvent(ev); } catch { /* one bad event never stops the stream */ } } setTimeout(fit, 0); }
        else if (m.t === 'route') setState((s) => ({ ...s, route: m.path || '', title: m.title || '' }));
        else if (m.t === 'hello') { controlRef.current = m.control || 'none'; setState((s) => ({ ...s, guestOnline: !!m.guestOnline, control: m.control || 'none' })); }
        else if (m.t === 'control') { controlRef.current = m.status || 'none'; setState((s) => ({ ...s, control: m.status || 'none' })); }
        else if (m.t === 'notice') setState((s) => ({ ...s, notice: { kind: m.kind, at: Date.now() } }));
        else if (m.t === 'error' && m.code === 'no_control') { controlRef.current = 'released'; setState((s) => ({ ...s, control: 'released' })); }
        // Every other refusal is SAID. A frame the hub would not carry (a paste past its
        // size cap, a kind it does not know) used to do nothing at all: the page simply
        // did not move and the viewer was left guessing whether the other side had frozen.
        else if (m.t === 'error') {
          const said = { too_large: 'That was too big to send — paste it in smaller pieces.', bad_input: 'PILOT would not send that action.' }[m.code];
          setState((s) => ({ ...s, notice: { kind: m.code || 'error', text: said || m.message || 'That action was not sent.', at: Date.now() } }));
        }
        else if (m.t === 'guest_online') { setState((s) => ({ ...s, guestOnline: true })); ws.send(JSON.stringify({ t: 'snapshot' })); }
        else if (m.t === 'guest_offline') setState((s) => ({ ...s, guestOnline: false }));
        else if (m.t === 'ended') { closed = true; setState((s) => ({ ...s, ended: m.reason || 'ended', connected: false })); }
      };
      ws.onclose = (ev) => {
        setState((s) => ({ ...s, connected: false }));
        if (closed) return;
        // Refused / not ours / no live session: say so once instead of retrying forever.
        if (ev && [4400, 4401, 4403, 4404].includes(ev.code)) { closed = true; setState((s) => ({ ...s, ended: ev.code === 4404 ? 'no_session' : 'refused' })); return; }
        if (!retryUntil) retryUntil = Date.now() + 5 * 60 * 1000;
        if (Date.now() > retryUntil) { closed = true; setState((s) => ({ ...s, ended: 'connection_lost' })); return; }
        const wait = Math.min(20000, backoff) + Math.floor(Math.random() * 500);
        backoff = Math.min(20000, backoff * 2);
        retry = setTimeout(connect, wait);
      };
      ws.onerror = () => { try { ws.close(); } catch { /* onclose */ } };
    };
    connect();
    return () => {
      closed = true; if (retry) clearTimeout(retry);
      window.removeEventListener('resize', fit);
      try { wsRef.current && wsRef.current.close(1000, 'viewer left'); } catch { /* fine */ }
      try { rp.pause(); rp.destroy && rp.destroy(); } catch { /* fine */ }
      replayerRef.current = null;
    };
  }, [session && session.status, sessionId]);

  const end = async () => { try { await api.cobrowseEnd(sessionId); } catch { /* the hub tells us either way */ } };
  const askControl = async () => { try { await api.cobrowseControlRequest(sessionId); setState((s) => ({ ...s, control: 'requested' })); } catch (e) { setErr(e.message || 'Could not ask for control.'); } };
  const releaseControl = async () => { try { await api.cobrowseControlRelease(sessionId, 'viewer_release'); } catch { /* the hub tells us */ } };

  // A notice ("they opened a file picker") shows for a few seconds, then clears.
  useEffect(() => {
    if (!state.notice) return undefined;
    const t = setTimeout(() => setState((s) => (s.notice && s.notice.at === state.notice.at ? { ...s, notice: null } : s)), 6000);
    return () => clearTimeout(t);
  }, [state.notice]);

  // CAPTURE while in control: listeners on the mirror's document translate what
  // the viewer does into input events addressed by rrweb mirror id. rrweb's own
  // stylesheet makes the frame click-through (pointer-events:none) — while driving
  // it is switched on; the frame stays sandboxed with scripts off.
  useEffect(() => {
    const rp = replayerRef.current;
    const on = state.control === 'granted' && rp && rp.iframe;
    if (captureRef.current) { captureRef.current(); captureRef.current = null; }
    if (!on) return undefined;
    const iframe = rp.iframe;
    const doc = iframe.contentDocument; if (!doc) return undefined;
    const mirror = rp.getMirror ? rp.getMirror() : null;
    const idOf = (node) => { try { return mirror ? mirror.getId(node) : null; } catch { return null; } };
    const sendInput = (obj) => { const ws = wsRef.current; if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'input', ...obj })); };
    const pageXY = (e) => ({ x: e.clientX + (doc.defaultView ? doc.defaultView.scrollX : 0), y: e.clientY + (doc.defaultView ? doc.defaultView.scrollY : 0) });
    iframe.style.pointerEvents = 'auto';
    // ONLY THE VIEWER'S OWN HANDS. The replayer PAINTS the mirror by dispatching events into
    // this very document — scrolls, focus, value changes — and every one of them was being
    // captured and sent BACK to the guest: a feedback loop that scrolled their page around
    // and, worse, echoed a MASKED value into their real box, wiping what they had typed (the
    // two-browser drive caught it as 446 relayed events where 6 were real). A replayed event
    // is synthetic, a person's is trusted, so that single test tells them apart — the same
    // rule the guest's own take-back is built on.
    const mine = (e) => e && e.isTrusted;
    // A SCROLL IS NOT EVIDENCE OF A PERSON. The browser fires `scroll` with isTrusted TRUE
    // even when a script did the scrolling — and the replayer scrolls this document on every
    // frame it paints. So the guest's own scroll came back as a relayed scroll, moved their
    // page, was recorded, replayed, and came back again: the drive measured 91 relayed
    // scrolls oscillating (104 → 98 → 88 → 79 …) on a viewer who touched nothing. A scroll
    // is relayed only in the second after a real gesture that could have caused one.
    let gestureAt = 0;
    const GESTURE_MS = 1000;
    const noteGesture = (e) => { if (mine(e)) gestureAt = Date.now(); };
    let lastMove = 0, lastX = null, lastY = null;
    // A STATIONARY POINTER STILL FIRES `mousemove`: the mirror repaints under it constantly,
    // and the browser reports a move every time the element beneath the pointer changes. The
    // position is therefore compared, not just the clock — otherwise a viewer who touched
    // nothing sent 25 cursor updates a second for the whole session (the drive counted 446).
    const onMove = (e) => {
      if (!mine(e)) return;
      const now = Date.now(); if (now - lastMove < 40) return;
      const p = pageXY(e);
      if (p.x === lastX && p.y === lastY) return;
      lastMove = now; lastX = p.x; lastY = p.y;
      sendInput({ k: 'cursor', ...p });
    };
    // WHERE THE VIEWER IS WORKING. rrweb's replay makes the mirror click-through, so a real
    // click there does not move the viewer's OWN focus — `document.activeElement` stays on
    // the body and every keystroke afterwards was addressed to the wrong element, so nothing
    // a person typed ever arrived. The clicked element is remembered (and focused locally
    // where the mirror allows it), and that is what typing is addressed to.
    let target = null;
    const onClick = (e) => {
      if (!mine(e)) return;
      e.preventDefault(); e.stopPropagation();
      const id = idOf(e.target); if (id == null || id < 0) return;
      target = e.target;
      try { e.target.focus && e.target.focus({ preventScroll: true }); } catch { /* the mirror may refuse; `target` still holds it */ }
      sendInput({ k: e.detail >= 2 ? 'dblclick' : 'click', id, ...pageXY(e) });
    };
    const onKey = (e) => {
      if (!mine(e)) return;
      e.preventDefault(); e.stopPropagation();
      // The active element when the mirror actually moved focus, else the box the viewer
      // last clicked — never the body, which is where a click-through mirror leaves focus.
      const live = doc.activeElement && doc.activeElement !== doc.body && doc.activeElement !== doc.documentElement ? doc.activeElement : null;
      const el = live || target || e.target;
      const id = idOf(el); if (id == null || id < 0) return;
      // Every keystroke is relayed AS A KEY. The mirror is masked (a typed value
      // shows as the fixed-length marker), so this side cannot know the real
      // value or the caret — the guest's own browser inserts the character into
      // its real box (applyInput → applyTextKey). Deriving a whole value from the
      // mirror here sent `'' + key` on every press and nothing ever accumulated.
      sendInput({ k: 'key', id, key: e.key, code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey });
    };
    const onChange = (e) => { if (!mine(e)) return; const id = idOf(e.target); if (id == null || id < 0) return; const t = e.target; if (t.type === 'checkbox' || t.type === 'radio') sendInput({ k: 'change', id, checked: !!t.checked }); else sendInput({ k: 'change', id, value: String(t.value || ''), idx: t.tagName === 'SELECT' ? t.selectedIndex : undefined }); };
    const onScroll = (e) => { if (!mine(e) || Date.now() - gestureAt > GESTURE_MS) return; const t = e.target; if (t === doc || t === doc.documentElement || t === doc.body) { const w = doc.defaultView; sendInput({ k: 'scroll', id: 1, sx: w ? w.scrollX : 0, sy: w ? w.scrollY : 0 }); return; } const id = idOf(t); if (id == null || id < 0) return; sendInput({ k: 'scroll', id, sx: t.scrollLeft, sy: t.scrollTop }); };
    const onPaste = (e) => { if (!mine(e)) return; e.preventDefault(); const id = idOf((doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null) || target); if (id == null || id < 0) return; const text = (e.clipboardData && e.clipboardData.getData('text')) || ''; if (text) sendInput({ k: 'paste', id, value: text }); };
    for (const g of ['wheel', 'pointerdown', 'touchstart', 'keydown']) doc.addEventListener(g, noteGesture, true);
    doc.addEventListener('mousemove', onMove, true);
    doc.addEventListener('click', onClick, true);
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('change', onChange, true);
    doc.addEventListener('scroll', onScroll, true);
    doc.addEventListener('paste', onPaste, true);
    // Keyboard focus lands on the frame so typing goes to the mirror, not to this page.
    try { iframe.focus(); } catch { /* fine */ }
    const off = () => {
      iframe.style.pointerEvents = 'none';
      doc.removeEventListener('mousemove', onMove, true); doc.removeEventListener('click', onClick, true);
      doc.removeEventListener('keydown', onKey, true); doc.removeEventListener('change', onChange, true);
      doc.removeEventListener('scroll', onScroll, true); doc.removeEventListener('paste', onPaste, true);
      for (const g of ['wheel', 'pointerdown', 'touchstart', 'keydown']) doc.removeEventListener(g, noteGesture, true);
    };
    captureRef.current = off;
    return off;
  }, [state.control, state.connected]);

  const who = session ? session.watched : null;
  const reasonText = {
    stopped_by_guest: `${who ? who.name : 'They'} stopped sharing.`, stopped_by_viewer: 'You ended the session.',
    guest_left: `${who ? who.name : 'They'} closed PILOT or lost their connection.`, viewer_left: 'This viewer was closed.',
    expired: 'The session reached its time limit.', signed_out: `${who ? who.name : 'They'} signed out.`, superseded: 'A newer session replaced this one.',
    no_session: 'This session is no longer live.', refused: 'PILOT refused this connection — sign in again and reopen the session.',
    connection_lost: 'The connection could not be restored. Reopen the session to try again.',
  };

  if (err) return <div className="panel pad"><div className="notice err">{err}</div><Link className="btn ghost small" to="/internal">Back</Link></div>;
  if (!session) return <div className="panel muted pad">Opening…</div>;
  if (session.status !== 'active' && !state.ended) {
    return (
      <div className="panel pad">
        <h2 style={{ color: INK, marginTop: 0 }}>Co-browse</h2>
        <p style={{ color: INK }}>{session.status === 'requested' ? `Waiting for ${who.name} to accept…` : `This session is ${session.status}${session.endReason ? ` (${reasonText[session.endReason] || session.endReason})` : ''}.`}</p>
        <Link className="btn ghost small" to="/internal">Back</Link>
      </div>
    );
  }
  return (
    <div>
      <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        <div>
          <h2 style={{ color: INK, margin: 0 }}>Watching {who.name}’s screen</h2>
          <div className="small" style={{ color: MUTED }}>
            {state.ended ? (reasonText[state.ended] || 'Session ended.')
              : !state.connected ? 'Connecting…'
                : !state.guestOnline ? `${who.name} is not on PILOT right now — the picture appears when they are.`
                  : `Live · they are on ${state.route || 'PILOT'}${state.title ? ` — ${state.title}` : ''}`}
            {' '}· {state.control === 'granted' ? 'You are in control: what you click and type here happens on their screen. Passwords and Social Security numbers stay hidden.'
              : state.control === 'requested' ? `Asked ${who.name} for control — waiting for them to allow it…`
                : state.control === 'refused' ? `${who.name} chose to keep it watch-only.`
                  : 'Watch-only: clicking here does nothing on their screen. Passwords and Social Security numbers are hidden.'}
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {!state.ended && state.guestOnline && state.control !== 'granted' && state.control !== 'requested' && (
            <button type="button" className="btn ghost small" onClick={askControl} title="Ask them to let you click and type on their screen. They see the request and choose.">Ask to control</button>
          )}
          {!state.ended && state.control === 'granted' && (
            <button type="button" className="btn ghost small" onClick={releaseControl}>Hand control back</button>
          )}
          {!state.ended && <button type="button" className="btn ghost small" onClick={() => wsRef.current && wsRef.current.readyState === 1 && wsRef.current.send(JSON.stringify({ t: 'snapshot' }))}>Refresh picture</button>}
          {!state.ended ? <button type="button" className="btn small" style={{ background: '#7A1F1F', color: '#fff', border: 'none' }} onClick={end}>End session</button>
            : <Link className="btn ghost small" to={session.applicationId ? `/internal/app/${session.applicationId}` : '/internal'}>Back</Link>}
        </div>
      </div>
      <div className="small" style={{ color: MUTED, marginBottom: 8 }}>
        What you will not see: their file chooser (they pick the file), files they download (those land on their computer), and any outside site they open in a new tab such as DocuSign.
      </div>
      {state.notice && (
        <div className="notice" role="status" style={{ marginBottom: 8, color: INK }}>
          {state.notice.kind === 'file_picker' ? `${who.name} opened their file chooser — that window is on their computer and cannot be shown here.`
            : state.notice.kind === 'file_picked' ? `${who.name} chose a file on their computer — it uploads from their side.`
              : state.notice.kind === 'file_picker_blocked' ? 'A file chooser can only be opened by them — ask them to pick the file.'
              : state.notice.kind === 'download' ? `${who.name} downloaded a file — it landed on their computer.`
                : state.notice.kind === 'new_tab' ? `${who.name} opened a link in a new tab — that page is outside PILOT and is not mirrored.`
                  : state.notice.kind === 'redacted' ? 'One frame was held back because it carried a number shaped like a Social Security or card number in plain text — the mirror will catch up on its own.'
                    : (state.notice.text || '')}
        </div>
      )}
      <div ref={hostRef} className="cobrowse-stage" tabIndex={-1} style={{ position: 'relative', border: state.control === 'granted' ? '3px solid #B3261E' : '1px solid #D9D2C5', borderRadius: 10, background: '#F6F3EC', overflow: 'hidden', minHeight: 320 }}>
        <style>{`.cobrowse-stage .replayer-wrapper{transform-origin:0 0;transform:scale(${scale});position:absolute;left:4px;top:4px}.cobrowse-stage .replayer-mouse{z-index:20}`}</style>
        {state.ended && <div style={{ position: 'absolute', inset: 0, background: 'rgba(246,243,236,.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: INK, fontWeight: 600, zIndex: 30 }}>{reasonText[state.ended] || 'Session ended.'}</div>}
      </div>
    </div>
  );
}
