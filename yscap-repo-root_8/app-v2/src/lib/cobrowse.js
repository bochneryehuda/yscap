/* CO-BROWSING — the GUEST side (owner-directed 2026-09-02).
 *
 * When this person has ACCEPTED a request, their own browser records a masked
 * copy of the page with rrweb and streams it to PILOT over one WebSocket, where
 * the hub relays it to the one viewer. Nothing runs as anybody else, and the
 * viewer never receives what this module never sends.
 *
 * MASKING HAPPENS HERE, BEFORE ANYTHING LEAVES THE BROWSER. rrweb serialises an
 * input's value through maskInputValue, so with `maskAllInputs` every typed
 * character becomes '*' in the serialised node — the real text never crosses the
 * wire. Text NODES are not inputs, so the places that PRINT a secret are marked
 * `data-cobrowse-block` (the SSN row, the two-factor panel, a firm's credit
 * login) and replaced by a same-size grey box. Password and one-time-code inputs
 * are blocked outright as belt-and-suspenders. `maskTextFn` fixes the length so
 * a masked value cannot leak how long it was.
 *
 * RECORDING STOPS on the routes where a secret is the whole screen (sign-in,
 * accept-invite, reset) and resumes with a fresh full snapshot afterwards; the
 * session ends on sign-out (the server ends it too). A reload rejoins: the live
 * session id is kept in sessionStorage so the socket comes back on its own.
 *
 * WATCH-ONLY (Phase A): the only message the viewer may send back is
 * `{t:'snapshot'}`; anything else the hub refuses before it reaches us. */
import { record } from '@rrweb/record';
import { getToken } from './api.js';

export const SESSION_KEY = 'ys_cobrowse_session';
export const BLOCK_SELECTOR = '[data-cobrowse-block], input[type="password"], input[autocomplete="one-time-code"], .cobrowse-block';
/** Routes on which nothing is recorded at all — the screen IS the secret. */
export const NO_RECORD_ROUTES = /^\/(login|internal\/login|tpo\/login|verify|forgot|internal\/forgot|reset|accept|accept-terms|assistant\/(login|accept)|tpo\/accept|esign\/done)(\/|$)/;

const FLUSH_MS = 80;           // batch rrweb events; ~12 batches/s worst case
const RECONNECT_MS = 2500;

let live = null;   // { sessionId, ws, stop, timer, queue, closedByServer, onState }

function routeNow() {
  const h = String(window.location.hash || '#/').replace(/^#/, '');
  return h.split('?')[0] || '/';
}
export function recordingAllowedHere() { return !NO_RECORD_ROUTES.test(routeNow()); }

function wsUrl(sessionId) {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws/cobrowse?token=${encodeURIComponent(getToken())}&session=${encodeURIComponent(sessionId)}&role=guest`;
}

function startRecorder(state) {
  if (state.stop) return;
  if (!recordingAllowedHere()) return;   // resumes on the next route change
  state.stop = record({
    emit(ev) {
      state.queue.push(ev);
      if (!state.timer) state.timer = setTimeout(() => flush(state), FLUSH_MS);
    },
    maskAllInputs: true,
    maskTextSelector: BLOCK_SELECTOR,
    blockSelector: BLOCK_SELECTOR,
    // Fixed-length mask: the viewer must not learn how long a hidden value is.
    maskTextFn: () => '••••••',
    maskInputFn: () => '••••••',
    // A password input's value never reaches the serialiser even when masking is on.
    maskInputOptions: { password: true },
    recordCanvas: false,
    collectFonts: false,
    inlineImages: false,
    // Keep the batch small: last-value-wins for typing, mouse sampled.
    sampling: { input: 'last', mousemove: 50, scroll: 100, media: 800 },
    slimDOMOptions: { script: true, comment: true },
  });
  state.recording = true;
  state.onState && state.onState({ recording: true });
}

function stopRecorder(state) {
  if (state.stop) { try { state.stop(); } catch { /* already stopped */ } state.stop = null; }
  state.recording = false;
  state.onState && state.onState({ recording: false });
}

function flush(state) {
  state.timer = null;
  if (!state.queue.length) return;
  const events = state.queue; state.queue = [];
  if (state.ws && state.ws.readyState === 1) {
    try { state.ws.send(JSON.stringify({ t: 'rrweb', events })); } catch { /* dropped; a snapshot request will heal the viewer */ }
  }
}

function connect(state) {
  if (!getToken()) return;
  let ws;
  try { ws = new WebSocket(wsUrl(state.sessionId)); } catch { return; }
  state.ws = ws;
  ws.onopen = () => {
    state.onState && state.onState({ connected: true });
    // Tell the viewer where we are, then start (or restart) recording so the
    // hub's snapshot request lands on a live recorder.
    try { ws.send(JSON.stringify({ t: 'route', path: routeNow(), title: document.title })); } catch { /* fine */ }
    startRecorder(state);
  };
  ws.onmessage = (e) => {
    let m = null; try { m = JSON.parse(String(e.data)); } catch { return; }
    if (!m) return;
    if (m.t === 'snapshot') {
      // A viewer joined or reconnected: give them a complete picture.
      if (state.stop) { try { record.takeFullSnapshot(true); } catch { /* recorder restarts below */ } }
      else startRecorder(state);
    } else if (m.t === 'ended') {
      state.closedByServer = m.reason || 'ended';
      endLocal(state, m.reason || 'ended');
    }
  };
  ws.onclose = () => {
    state.ws = null;
    state.onState && state.onState({ connected: false });
    if (state.closedByServer || !live || live !== state) return;
    // The server keeps the room ~60s for us to come back (a deploy, a blip).
    state.retry = setTimeout(() => { if (live === state) connect(state); }, RECONNECT_MS);
  };
  ws.onerror = () => { try { ws.close(); } catch { /* onclose handles it */ } };
}

function endLocal(state, reason) {
  if (live === state) live = null;
  stopRecorder(state);
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  if (state.retry) { clearTimeout(state.retry); state.retry = null; }
  if (state.routeUnsub) { state.routeUnsub(); state.routeUnsub = null; }
  if (state.ws) { try { state.ws.close(1000, 'guest stopped'); } catch { /* fine */ } state.ws = null; }
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* private mode */ }
  state.onState && state.onState({ ended: true, reason });
}

/**
 * Begin streaming this session (the person has already accepted). Idempotent per
 * session id. `onState` receives { connected, recording, ended, reason }.
 */
export function startGuest(sessionId, onState) {
  if (live && live.sessionId === sessionId) { live.onState = onState || live.onState; return live; }
  if (live) endLocal(live, 'superseded');
  const state = { sessionId, ws: null, stop: null, timer: null, retry: null, queue: [], closedByServer: null, onState, recording: false };
  live = state;
  try { sessionStorage.setItem(SESSION_KEY, sessionId); } catch { /* private mode */ }
  // Route changes: stop on a secret screen, resume (with a fresh snapshot) elsewhere.
  const onRoute = () => {
    if (live !== state) return;
    if (!recordingAllowedHere()) { stopRecorder(state); return; }
    if (!state.stop && state.ws && state.ws.readyState === 1) startRecorder(state);
    if (state.ws && state.ws.readyState === 1) { try { state.ws.send(JSON.stringify({ t: 'route', path: routeNow(), title: document.title })); } catch { /* fine */ } }
  };
  window.addEventListener('hashchange', onRoute);
  state.routeUnsub = () => window.removeEventListener('hashchange', onRoute);
  connect(state);
  return state;
}

/** Stop streaming (the person pressed Stop, or the session ended elsewhere). */
export function stopGuest(reason = 'stopped_by_guest') {
  if (live) endLocal(live, reason);
}

export function guestSessionId() { return live ? live.sessionId : null; }

/** The session id a reload should rejoin, if any. */
export function rememberedSessionId() {
  try { return sessionStorage.getItem(SESSION_KEY) || null; } catch { return null; }
}
