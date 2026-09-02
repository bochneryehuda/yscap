import React, { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Replayer } from '@rrweb/replay';
import '@rrweb/replay/dist/style.css';
import { api, getToken } from '../lib/api.js';

/* THE VIEWER (owner-directed 2026-09-02, Phase A: watch-only).
   Replays the watched person's masked page LIVE inside a sandboxed frame. This is
   a MIRROR — the viewer's own PILOT never navigates, downloads, or acts; a click
   here does nothing to the other person (take control is Phase B, behind its own
   consent). What cannot be mirrored is SAID rather than left blank: their file
   picker and downloads happen on their machine; an outside site (DocuSign,
   SharePoint) opens in a tab we never see.

   Text colours are explicit darks per the HARD RULE. */
const INK = '#141B22', MUTED = '#4B585C';

export default function StaffCobrowse() {
  const { sessionId } = useParams();
  const [session, setSession] = useState(null);
  const [err, setErr] = useState('');
  const [state, setState] = useState({ connected: false, guestOnline: false, route: '', ended: null });
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

    let retry = null; let closed = false;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const connect = () => {
      if (closed) return;
      const ws = new WebSocket(`${proto}//${window.location.host}/ws/cobrowse?token=${encodeURIComponent(getToken())}&session=${encodeURIComponent(sessionId)}&role=viewer`);
      wsRef.current = ws;
      ws.onopen = () => { setState((s) => ({ ...s, connected: true })); ws.send(JSON.stringify({ t: 'snapshot' })); };
      ws.onmessage = (e) => {
        let m = null; try { m = JSON.parse(String(e.data)); } catch { return; }
        if (!m) return;
        if (m.t === 'rrweb' && Array.isArray(m.events)) { for (const ev of m.events) { try { rp.addEvent(ev); } catch { /* one bad event never stops the stream */ } } setTimeout(fit, 0); }
        else if (m.t === 'route') setState((s) => ({ ...s, route: m.path || '', title: m.title || '' }));
        else if (m.t === 'hello') setState((s) => ({ ...s, guestOnline: !!m.guestOnline }));
        else if (m.t === 'guest_online') { setState((s) => ({ ...s, guestOnline: true })); ws.send(JSON.stringify({ t: 'snapshot' })); }
        else if (m.t === 'guest_offline') setState((s) => ({ ...s, guestOnline: false }));
        else if (m.t === 'ended') { closed = true; setState((s) => ({ ...s, ended: m.reason || 'ended', connected: false })); }
      };
      ws.onclose = () => { setState((s) => ({ ...s, connected: false })); if (!closed) retry = setTimeout(connect, 2500); };
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

  const who = session ? session.watched : null;
  const reasonText = {
    stopped_by_guest: `${who ? who.name : 'They'} stopped sharing.`, stopped_by_viewer: 'You ended the session.',
    guest_left: `${who ? who.name : 'They'} closed PILOT or lost their connection.`, viewer_left: 'This viewer was closed.',
    expired: 'The session reached its time limit.', signed_out: `${who ? who.name : 'They'} signed out.`, superseded: 'A newer session replaced this one.',
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
            {' '}· Watch-only: clicking here does nothing on their screen. Passwords and Social Security numbers are hidden.
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {!state.ended && <button type="button" className="btn ghost small" onClick={() => wsRef.current && wsRef.current.readyState === 1 && wsRef.current.send(JSON.stringify({ t: 'snapshot' }))}>Refresh picture</button>}
          {!state.ended ? <button type="button" className="btn small" style={{ background: '#7A1F1F', color: '#fff', border: 'none' }} onClick={end}>End session</button>
            : <Link className="btn ghost small" to={session.applicationId ? `/internal/app/${session.applicationId}` : '/internal'}>Back</Link>}
        </div>
      </div>
      <div className="small" style={{ color: MUTED, marginBottom: 8 }}>
        What you will not see: their file chooser (they pick the file), files they download (those land on their computer), and any outside site they open in a new tab such as DocuSign.
      </div>
      <div ref={hostRef} className="cobrowse-stage" style={{ position: 'relative', border: '1px solid #D9D2C5', borderRadius: 10, background: '#F6F3EC', overflow: 'hidden', minHeight: 320 }}>
        <style>{`.cobrowse-stage .replayer-wrapper{transform-origin:0 0;transform:scale(${scale});position:absolute;left:4px;top:4px}.cobrowse-stage .replayer-mouse{z-index:20}`}</style>
        {state.ended && <div style={{ position: 'absolute', inset: 0, background: 'rgba(246,243,236,.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: INK, fontWeight: 600, zIndex: 30 }}>{reasonText[state.ended] || 'Session ended.'}</div>}
      </div>
    </div>
  );
}
