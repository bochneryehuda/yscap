import React, { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Replayer } from '@rrweb/replay';
import '@rrweb/replay/dist/style.css';
import { api, getToken } from '../lib/api.js';
import { fitScaleFor, appliedScale, stageOverflow, stageHeight, nextZoom, canZoom } from '../lib/cobrowseZoom.js';
import { startLiveOnce } from '../lib/cobrowseLive.js';
import { fingerprintOf } from '../lib/cobrowseFingerprint.js';

/* THE VIEWER (owner-directed 2026-09-02).
   Replays the watched person's masked page LIVE inside a sandboxed frame. This is
   a MIRROR — the viewer's own PILOT never navigates, downloads, or acts. A click
   here does nothing to the other person UNTIL they allow control (Phase B, a
   second consent on their screen): then clicks, typing, scrolling and the pointer
   are captured on the mirror and sent as `{t:'input'}` with the rrweb mirror id
   of the element under the pointer — the hub relays them only while the register
   says 'granted', and their browser performs them inside its own allowlist. The
   watched person takes control back with a click, a key or Stop. What cannot be mirrored is SAID rather than left blank: their file
   picker and downloads happen on their machine; an outside site (DocuSign,
   SharePoint) opens in a tab we never see.

   Text colours are explicit darks per the HARD RULE. */
const INK = '#141B22', MUTED = '#4B585C';

// HOW FAR BEHIND THE GUEST THE PICTURE PLAYS. rrweb's live scheduler draws an event
// older than the baseline at once and queues a newer one for `baseline + elapsed`, so
// this is a smoothing buffer: every change is drawn this many milliseconds after it
// happened. It was 200 ms, and MEASURED end to end on localhost the mirror ran at a
// 533 ms floor (min 532 / median 533 / max 546 over six probes) — most of it this
// constant plus the guest's own batching, and the owner's word for the result was
// "extremely slow" (2026-09-02). 40 ms still orders a burst without being felt.
// Do not raise it without re-running the drive's latency check.
const LIVE_BUFFER_MS = 40;

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
  // ZOOM. A mirror is a picture of somebody else's screen, and a picture scaled to fit
  // a page column is not readable: MEASURED, a 1280-wide guest in this screen's stage
  // renders at 0.736 and a 1920-wide guest at about 0.50 — half-size body text, which
  // is what "extremely unclear" means (owner-reported 2026-09-02). `fit` keeps the whole
  // screen in view; a number is an explicit zoom the person chose, and past the stage
  // the stage SCROLLS rather than clipping. Never capped at the fit scale: leaning in
  // on one figure is the whole reason somebody watches a screen.
  const [zoom, setZoom] = useState('fit');
  const [fitScale, setFitScale] = useState(1);
  const zoomRef = useRef('fit');
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  // Re-fit when the chosen size changes, and AGAIN on the next frame. The second pass is
  // load-bearing: leaving a zoomed stage flips `overflow` back to hidden and REMOVES its
  // scrollbar, so the width the first pass measured was ~15px short and Fit came back
  // about 1% small until some later event happened to re-fit. `fit` is redefined each
  // render and reads the zoom through a ref, so it is deliberately not a dependency.
  useEffect(() => {
    fit();
    const id = requestAnimationFrame(() => fit());
    return () => cancelAnimationFrame(id);
  }, [zoom]);

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
    // The FIT scale is what shows the whole screen; it is reported separately so the
    // zoom buttons can say "Fit" without recomputing it, and so 100% is a real choice
    // rather than a cap. `clientWidth` is read AFTER any scrollbar, so a zoomed stage
    // does not fight itself for width.
    const f = fitScaleFor(host.clientWidth, w);
    setFitScale(f);
    const s = appliedScale(zoomRef.current, f);
    setScale(s);
    host.style.height = `${stageHeight(h, s, f)}px`;
  };

  useEffect(() => {
    if (!session || session.status !== 'active' || !hostRef.current) return undefined;
    const rp = new Replayer([], {
      root: hostRef.current, liveMode: true, mouseTail: false, UNSAFE_replayCanvas: false,
      // Nothing inside the mirror may run: the frame is sandboxed by rrweb; we add nothing.
      speed: 1, showWarning: false, showDebug: false,
    });
    replayerRef.current = rp;
    // THE LIVE BASELINE COMES OFF THE FIRST EVENT'S OWN CLOCK, NEVER OURS. rrweb
    // schedules each event by comparing its `timestamp` to this baseline plus the
    // elapsed time — and those timestamps are stamped on the GUEST's machine. Two
    // office computers are routinely seconds apart, so seeding it with our own
    // Date.now() means every event is "in the future" (nothing is ever drawn — a
    // blank stage with a moving cursor) or far in the past. Started lazily below,
    // 200ms behind the first event we actually receive, so the picture plays at once.
    // ⛔ THE WHOLE START DECISION LIVES IN `lib/cobrowseLive.js`, and nothing about
    // it is reconstructable here. Two audits walked through the previous shapes:
    // the arithmetic was pinned as a string and a restamp one line earlier
    // (`ev.timestamp = Date.now()`) restored the blank mirror; then the arithmetic
    // moved out but the caller still held the answer, and re-seeding
    // `base = Date.now() - LIVE_BUFFER_MS` after the call restored it again. Both
    // times every pinned string was still present and the suite read 232/0.
    // Which event, what number, and "only once" are now ONE call, tested by calling
    // it — but that is not the same as "nothing can slip between", and an earlier
    // draft of this comment claimed it was. The caller still chooses the OBJECT it
    // passes: `startFrom({ ...ev, timestamp: Date.now() })` restores the blank
    // mirror with the whole pure suite at 251/0 (pre-merge audit, 2026-09-02).
    // `test-cobrowse-pure` trips on a constructed argument, and the browser drive
    // — made authoritative over this file by `check-bundle-fresh.js` — is what
    // actually catches it, in the same way it catches the take-back drift.
    const liveState = { started: false };
    const startFrom = (ev) => startLiveOnce(rp, liveState, ev, LIVE_BUFFER_MS);
    rp.on('resize', fit);
    window.addEventListener('resize', fit);

    let retry = null; let closed = false; let backoff = 2500; let retryUntil = 0;
    // Healing a picture that never arrived: ask the guest to re-send a full snapshot,
    // at most once every SNAPSHOT_RETRY_MS and at most SNAPSHOT_RETRIES times, so a
    // page we genuinely cannot replay can never turn into a request storm.
    let sawSnapshot = false; let askedAt = 0; let asks = 0;
    const SNAPSHOT_RETRY_MS = 4000, SNAPSHOT_RETRIES = 4;
    const askSnapshot = (why) => {
      const now = Date.now();
      if (now - askedAt < SNAPSHOT_RETRY_MS || asks >= SNAPSHOT_RETRIES) return;
      askedAt = now; asks += 1;
      const ws = wsRef.current;
      if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ t: 'snapshot' })); } catch { /* the reconnect asks again */ } }
      setState((s) => ({ ...s, notice: { kind: why, text: 'The picture has not come through yet — asking for a fresh one.', at: now } }));
    };
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const connect = () => {
      if (closed) return;
      const ws = new WebSocket(`${proto}//${window.location.host}/ws/cobrowse?token=${encodeURIComponent(getToken())}&session=${encodeURIComponent(sessionId)}&role=viewer`);
      wsRef.current = ws;
      ws.onopen = () => { backoff = 2500; retryUntil = 0; asks = 0; askedAt = Date.now(); setState((s) => ({ ...s, connected: true })); ws.send(JSON.stringify({ t: 'snapshot' })); };
      ws.onmessage = (e) => {
        let m = null; try { m = JSON.parse(String(e.data)); } catch { return; }
        if (!m) return;
        if (m.t === 'rrweb' && Array.isArray(m.events)) {
          for (const ev of m.events) {
            startFrom(ev);
            if (ev && ev.type === 2) { sawSnapshot = true; setState((s) => (s.notice && s.notice.kind === 'no_picture' ? { ...s, notice: null } : s)); }
            // A REFUSED EVENT IS NEVER SILENT — BUT ONLY WHILE THERE IS NO PICTURE.
            // An rrweb stream is STATEFUL: every mutation is expressed against node
            // ids the full snapshot established, so if that snapshot never arrived
            // each one throws here and the stage stays empty for ever. Once a picture
            // IS on screen, a single mutation the replayer will not take is the
            // ordinary "one bad event never stops the stream" case and must stay
            // swallowed: asking for a snapshot then REBUILDS the mirrored document,
            // which throws away the caret and the focus a controller is typing into.
            // (Measured: healing on every failure made the two-browser drive drop
            // keystrokes about one run in three.)
            try { rp.addEvent(ev); } catch { if (!sawSnapshot) askSnapshot('no_picture'); }
          }
          setTimeout(fit, 0);
          // Events flowing with no snapshot behind them is the same illness with no error.
          if (!sawSnapshot) askSnapshot('no_picture');
        }
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
    // WHAT WE MEANT TO ACT ON, so the guest can refuse a stale id. An rrweb mirror id is
    // re-minted by every full snapshot, and a stale one does NOT resolve to nothing on the
    // guest — it resolves to a DIFFERENT live element. The pre-merge audit instrumented
    // exactly that: a relayed click on a search box pressed the guest's own co-browse
    // "Stop" button and ended the session, recorded against the WATCHED person. This
    // fingerprint travels with every addressed input and the guest drops a mismatch.
    // It carries no content — the tag, the input type and the first class — so it is safe
    // on a masked mirror and cannot leak what a person typed.
    // ⛔ THE SAME FUNCTION THE GUEST USES, not a copy of it. This was a second copy,
    // and it read the element off rrweb's REPLAYED document, which decorates hovered
    // elements with a class literally named `:hover` — so the viewer sent
    // `BODY||:hover`, the guest computed `BODY||`, and every relayed click and
    // keystroke was refused. See `lib/cobrowseFingerprint.js`.
    const fpOf = fingerprintOf;
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
      sendInput({ k: e.detail >= 2 ? 'dblclick' : 'click', id, fp: fpOf(e.target), ...pageXY(e) });
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
      sendInput({ k: 'key', id, fp: fpOf(e.target), key: e.key, code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey });
    };
    const onChange = (e) => { if (!mine(e)) return; const id = idOf(e.target); if (id == null || id < 0) return; const t = e.target; if (t.type === 'checkbox' || t.type === 'radio') sendInput({ k: 'change', id, fp: fpOf(t), checked: !!t.checked }); else sendInput({ k: 'change', id, fp: fpOf(t), value: String(t.value || ''), idx: t.tagName === 'SELECT' ? t.selectedIndex : undefined }); };
    const onScroll = (e) => { if (!mine(e) || Date.now() - gestureAt > GESTURE_MS) return; const t = e.target; if (t === doc || t === doc.documentElement || t === doc.body) { const w = doc.defaultView; sendInput({ k: 'scroll', id: 1, sx: w ? w.scrollX : 0, sy: w ? w.scrollY : 0 }); return; } const id = idOf(t); if (id == null || id < 0) return; sendInput({ k: 'scroll', id, fp: fpOf(t), sx: t.scrollLeft, sy: t.scrollTop }); };
    const onPaste = (e) => { if (!mine(e)) return; e.preventDefault(); const node = (doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null) || target; const id = idOf(node); if (id == null || id < 0) return; const text = (e.clipboardData && e.clipboardData.getData('text')) || ''; if (text) sendInput({ k: 'paste', id, fp: fpOf(node), value: text }); };
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
            {' '}· {state.control === 'granted' ? 'You are in control: what you click and type here happens on their screen. Their passwords and security codes stay hidden, and so does a Social Security number anywhere PILOT prints one.'
              : state.control === 'requested' ? `Asked ${who.name} for control — waiting for them to allow it…`
                : state.control === 'refused' ? `${who.name} chose to keep it watch-only.`
                  : 'Watch-only: clicking here does nothing on their screen. Their passwords and security codes are hidden, and so is a Social Security number anywhere PILOT prints one.'}
          </div>
        </div>
        {/* ACTIONS ARE GROUPED AND WEIGHTED, never a row of identical outlines (the
            2026-08-03 action-design rule): what you are ASKING for is the primary,
            the utility (refresh the picture) is soft, and ending the session — the
            one thing that cannot be undone — is separated and destructive. */}
        <div className="act-bar" style={{ marginTop: 0 }}>
          {!state.ended && (
            <span className="act-group">
              <span className="act-label">Control</span>
              {state.guestOnline && state.control !== 'granted' && state.control !== 'requested' && (
                <button type="button" className="btn primary small" onClick={askControl} title="Ask them to let you click and type on their screen. They see the request and choose.">Ask to control</button>
              )}
              {state.control === 'requested' && <button type="button" className="btn soft small" disabled>Waiting for them…</button>}
              {state.control === 'granted' && (
                <button type="button" className="btn ghost small" onClick={releaseControl}>Hand control back</button>
              )}
              <button type="button" className="btn soft small" title="Ask them for a fresh picture of their whole screen." onClick={() => wsRef.current && wsRef.current.readyState === 1 && wsRef.current.send(JSON.stringify({ t: 'snapshot' }))}>Refresh picture</button>
            </span>
          )}
          {!state.ended && <span className="act-sep" aria-hidden="true" />}
          {/* SIZE. Fit shows their whole screen; 100% shows it at the size THEY see it,
              with the stage scrolling. Below the fit scale there is nothing more to see,
              so the floor is Fit ITSELF — never the fit scale as a number, which would
              look like nothing happened and then clip the picture the next time the
              window narrowed. Both steps are DISABLED at their end rather than doing
              nothing. The buttons carry `data-zoom` because the readout can read "100%"
              too, and a harness matching on the text would find two elements. */}
          {!state.ended && (
            <span className="act-group">
              <span className="act-label">Size</span>
              <span className="cb-seg" role="group" aria-label="Mirror size">
                <button type="button" data-zoom="fit" className={`btn small ${zoom === 'fit' ? 'primary' : 'ghost'}`} onClick={() => setZoom('fit')}>Fit</button>
                <button type="button" data-zoom="actual" className={`btn small ${zoom !== 'fit' && Number(zoom) === 1 ? 'primary' : 'ghost'}`} onClick={() => setZoom(1)} title="Show it at the size they see it — the stage scrolls.">100%</button>
              </span>
              <button type="button" data-zoom="out" className="btn soft small" aria-label="Smaller" title="Smaller"
                disabled={!canZoom(zoom, fitScale, -1)}
                onClick={() => setZoom((z) => nextZoom(z, fitScale, -1))}>−</button>
              <span data-zoom-readout className="small" style={{ color: MUTED, minWidth: 44, textAlign: 'center' }} aria-live="polite">{Math.round(scale * 100)}%</span>
              <button type="button" data-zoom="in" className="btn soft small" aria-label="Bigger" title="Bigger"
                disabled={!canZoom(zoom, fitScale, 1)}
                onClick={() => setZoom((z) => nextZoom(z, fitScale, 1))}>+</button>
            </span>
          )}
          {!state.ended && <span className="act-sep" aria-hidden="true" />}
          {!state.ended ? <button type="button" className="btn small" style={{ background: '#7A1F1F', color: '#fff', border: 'none' }} onClick={end}>End session</button>
            : <Link className="btn soft small" to={session.applicationId ? `/internal/app/${session.applicationId}` : '/internal'}>Back to the file</Link>}
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
                  : (state.notice.text || '')}
        </div>
      )}
      <div ref={hostRef} className="cobrowse-stage" tabIndex={-1} style={{ position: 'relative', border: state.control === 'granted' ? '3px solid #B3261E' : '1px solid #D9D2C5', borderRadius: 10, background: '#F6F3EC', overflow: stageOverflow(scale, fitScale), minHeight: 320 }}>
        <style>{`.cobrowse-stage .replayer-wrapper{transform-origin:0 0;transform:scale(${scale});position:absolute;left:4px;top:4px}.cobrowse-stage .replayer-mouse{z-index:20}`}</style>
        {state.ended && <div style={{ position: 'absolute', inset: 0, background: 'rgba(246,243,236,.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: INK, fontWeight: 600, zIndex: 30 }}>{reasonText[state.ended] || 'Session ended.'}</div>}
      </div>
    </div>
  );
}
