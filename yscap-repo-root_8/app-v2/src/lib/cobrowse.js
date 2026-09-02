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
 * TAKE CONTROL (Phase B) is a SECOND consent on top of the first. While the
 * register says 'granted', the hub relays the viewer's clicks/keys/scroll here as
 * `{t:'input'}` and THIS module performs them on the real page — through the
 * rrweb mirror ids, never a selector the viewer typed — inside a hard allowlist:
 * nothing blocked from the mirror can be driven, nor a file picker, a download,
 * a new-tab link, an e-sign frame, sign-out, view-as; and on a no-drive route
 * every input is ignored. The watched person takes control back by MOVING (a
 * trusted mouse move or key of their own — the events this module dispatches
 * are never trusted), by pressing Stop, or by ending the session. A red frame
 * says somebody else is driving.
 *
 * The mask itself is ONE definition in ./cobrowseMask.js, shared with the
 * Playwright redaction harness. */
import { record } from '@rrweb/record';
import { getToken, api } from './api.js';
import { BLOCK_SELECTOR, NO_RECORD_ROUTES, NO_DRIVE_SELECTOR, NO_DRIVE_ROUTES, recordOptions } from './cobrowseMask.js';

export { BLOCK_SELECTOR, NO_RECORD_ROUTES, NO_DRIVE_SELECTOR, NO_DRIVE_ROUTES };
export const SESSION_KEY = 'ys_cobrowse_session';
/**
 * Server close codes after which reconnecting is pointless — refused, not ours, no live
 * session (44xx); this screen opened in ANOTHER TAB (4000: the hub keeps ONE guest socket,
 * so two tabs would evict each other forever, each eviction costing a fresh rrweb snapshot);
 * and the hub's own limits (1009 a frame too large, 1008 the byte budget) — reconnecting
 * there re-snapshots the very screen that blew the budget, which is a loop that costs the
 * GUEST'S OWN browser, not just the stream.
 */
export const TERMINAL_CLOSE_CODES = [4400, 4401, 4403, 4404, 4000, 1008, 1009];
/** Why we stopped, in the guest's own words. */
export const CLOSE_REASON = { 4000: 'opened_elsewhere', 1008: 'too_busy', 1009: 'too_busy' };
const MAX_RETRY_MS = 5 * 60 * 1000;

const FLUSH_MS = 80;           // batch rrweb events; ~12 batches/s worst case
const RECONNECT_MS = 2500;
const MOVE_TAKEBACK_PX = 40;   // total pointer travel that reads as "I want it back"

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
  state.stop = record(recordOptions((ev) => {
    // A bound on what is held: a burst nobody can send must never grow without limit in
    // the guest's own tab. Dropping the oldest costs the viewer a snapshot, not the guest.
    if (state.queue.length >= MAX_QUEUE) { state.queue = []; state.needSnapshot = true; }
    state.queue.push(ev);
    if (!state.timer) state.timer = setTimeout(() => flush(state), FLUSH_MS);
  }));
  state.recording = true;
  state.onState && state.onState({ recording: true });
}

function stopRecorder(state) {
  if (state.stop) { try { state.stop(); } catch { /* already stopped */ } state.stop = null; }
  state.recording = false;
  state.onState && state.onState({ recording: false });
}

const MAX_BUFFERED = 2 * 1024 * 1024;   // the socket's own backlog, not ours
const MAX_QUEUE = 4000;                 // events held while disconnected

function flush(state) {
  state.timer = null;
  if (!state.queue.length) return;
  // BACK-PRESSURE. On a phone's uplink `send` never blocks — the browser just buffers, and
  // an unbounded buffer is the GUEST'S OWN memory and main thread. Past the mark we drop
  // this batch and ask for a fresh snapshot once it drains: the viewer catches up whole
  // rather than the guest's browser paying for a backlog nobody will ever see.
  const ws = state.ws;
  if (ws && ws.readyState === 1 && ws.bufferedAmount > MAX_BUFFERED) {
    state.queue = []; state.needSnapshot = true;
    if (!state.drainTimer) state.drainTimer = setInterval(() => {
      const w = state.ws;
      if (!w || w.readyState !== 1) { clearInterval(state.drainTimer); state.drainTimer = null; return; }
      if (w.bufferedAmount > MAX_BUFFERED / 2) return;
      clearInterval(state.drainTimer); state.drainTimer = null;
      if (state.needSnapshot) { state.needSnapshot = false; try { record.takeFullSnapshot(true); } catch { /* fine */ } }
    }, 500);
    return;
  }
  const events = state.queue; state.queue = [];
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify({ t: 'rrweb', events })); } catch { /* dropped; a snapshot request will heal the viewer */ }
  }
}

function connect(state) {
  if (!getToken()) return;
  let ws;
  try { ws = new WebSocket(wsUrl(state.sessionId)); } catch { return; }
  state.ws = ws;
  ws.onopen = () => {
    state.backoff = RECONNECT_MS;
    // The five-minute give-up clock is reset only once a connection has HELD for a while.
    // Resetting it on `open` means a socket that opens and dies in the same second resets
    // it every time, and the loop never gives up.
    state.openedAt = Date.now();
    if (state.stableTimer) clearTimeout(state.stableTimer);
    state.stableTimer = setTimeout(() => { if (live === state && state.ws && state.ws.readyState === 1) state.retryUntil = 0; }, 10000);
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
    } else if (m.t === 'control' || m.t === 'hello') {
      setControlLocal(state, m.t === 'hello' ? (m.control || 'none') : m.status);
    } else if (m.t === 'input') {
      if (state.control === 'granted') applyInput(state, m);
    } else if (m.t === 'ended') {
      state.closedByServer = m.reason || 'ended';
      endLocal(state, m.reason || 'ended');
    }
  };
  ws.onclose = (e) => {
    state.ws = null;
    // Nobody is receiving: stop paying for rrweb's observers in the guest's own tab. The
    // recorder restarts on the next `open`, which requests a full snapshot anyway.
    stopRecorder(state);
    state.queue = [];
    if (state.drainTimer) { clearInterval(state.drainTimer); state.drainTimer = null; }
    state.onState && state.onState({ connected: false });
    if (state.closedByServer || !live || live !== state) return;
    // Refused / not ours / no live session: reconnecting would only repeat the refusal.
    if (e && TERMINAL_CLOSE_CODES.includes(e.code)) {
      const why = CLOSE_REASON[e.code] || 'refused';
      state.closedByServer = why; endLocal(state, why); return;
    }
    // The server keeps the room ~60s for us to come back (a deploy, a blip); back
    // off up to ~20s with jitter so a hundred tabs do not reconnect in the same
    // instant after a deploy, and give up after five minutes of nothing.
    if (!state.retryUntil) state.retryUntil = Date.now() + MAX_RETRY_MS;
    if (Date.now() > state.retryUntil) { endLocal(state, 'connection_lost'); return; }
    const wait = Math.min(20000, (state.backoff || RECONNECT_MS)) + Math.floor(Math.random() * 500);
    state.backoff = Math.min(20000, (state.backoff || RECONNECT_MS) * 2);
    state.retry = setTimeout(() => { if (live === state) connect(state); }, wait);
  };
  ws.onerror = () => { try { ws.close(); } catch { /* onclose handles it */ } };
}

function endLocal(state, reason) {
  if (state.stableTimer) { clearTimeout(state.stableTimer); state.stableTimer = null; }
  if (state.drainTimer) { clearInterval(state.drainTimer); state.drainTimer = null; }
  if (live === state) live = null;
  setControlLocal(state, 'none');
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
  const state = { sessionId, ws: null, stop: null, timer: null, retry: null, queue: [], closedByServer: null, onState, recording: false,
    control: 'none', backoff: RECONNECT_MS, retryUntil: 0, driving: false, cursor: null, releaseUnsub: null };
  live = state;
  // NOTICES: what the viewer cannot see is SAID. This person's own real click on a
  // file chooser, a download or a new-tab link tells the viewer why the mirror did
  // not change (the owner's question 2026-09-02: "how does it usually work?").
  const onNotice = (e) => {
    if (live !== state || !e.isTrusted) return;
    const t = e.target && e.target.closest ? e.target.closest('input[type="file"], a[download], a[target="_blank"]') : null;
    if (!t) return;
    const kind = t.matches('input[type="file"]') ? 'file_picker' : t.matches('a[download]') ? 'download' : 'new_tab';
    sendWs(state, { t: 'notice', kind });
  };
  // AND THE ONE THAT ALMOST NEVER FIRED. Nearly every upload here is a HIDDEN
  // `<input type=file>` that a button opens with `.click()` — synthetic, so the handler
  // above (rightly) ignores it and the viewer was never told why the mirror had frozen.
  // The file input's own `change` is the honest signal: a file was actually chosen.
  const onPicked = (e) => {
    if (live !== state) return;
    const t = e.target;
    if (t && t.matches && t.matches('input[type="file"]') && t.files && t.files.length) sendWs(state, { t: 'notice', kind: 'file_picked' });
  };
  document.addEventListener('click', onNotice, true);
  document.addEventListener('change', onPicked, true);
  const noticeUnsub = () => { document.removeEventListener('click', onNotice, true); document.removeEventListener('change', onPicked, true); };
  try { sessionStorage.setItem(SESSION_KEY, sessionId); } catch { /* private mode */ }
  // Route changes: stop on a secret screen, resume (with a fresh snapshot) elsewhere.
  const onRoute = () => {
    if (live !== state) return;
    if (!recordingAllowedHere()) { stopRecorder(state); return; }
    if (!state.stop && state.ws && state.ws.readyState === 1) startRecorder(state);
    if (state.ws && state.ws.readyState === 1) { try { state.ws.send(JSON.stringify({ t: 'route', path: routeNow(), title: document.title })); } catch { /* fine */ } }
  };
  // A HASH ROUTER NAVIGATES WITH pushState, WHICH FIRES NO `hashchange`. React Router's
  // hash history pushes and listens on `popstate`, so every ordinary link click was
  // invisible here: a secret screen (`NO_RECORD_ROUTES`) reached from INSIDE the app was
  // still being recorded, and a recorder stopped on one never resumed. So the location is
  // polled on an animation-frame-cheap interval as the source of truth, with hashchange
  // and popstate kept as the instant path.
  window.addEventListener('hashchange', onRoute);
  window.addEventListener('popstate', onRoute);
  let lastRoute = routeNow();
  const routePoll = setInterval(() => { const r = routeNow(); if (r !== lastRoute) { lastRoute = r; onRoute(); } }, 400);
  state.routeUnsub = () => {
    window.removeEventListener('hashchange', onRoute); window.removeEventListener('popstate', onRoute);
    clearInterval(routePoll); noticeUnsub();
  };
  connect(state);
  return state;
}

function sendWs(state, obj) {
  if (state.ws && state.ws.readyState === 1) { try { state.ws.send(JSON.stringify(obj)); } catch { /* fine */ } }
}

/* ── Phase B: THE DRIVER ─────────────────────────────────────────────────────── */

function routeAllowsDriving() { return recordingAllowedHere() && !NO_DRIVE_ROUTES.test(routeNow()); }

/** Control state as the hub reports it. Draws the red frame, arms the take-back. */
function setControlLocal(state, status) {
  const st = String(status || 'none');
  if (state.control === st) return;
  state.control = st;
  const on = st === 'granted';
  if (on && !state.driving) armDriving(state);
  if (!on && state.driving) disarmDriving(state);
  state.onState && state.onState({ control: st });
}

function armDriving(state) {
  state.driving = true;
  document.documentElement.classList.add('cobrowse-controlled');
  // TAKE IT BACK: any TRUSTED mouse move, wheel, touch or key of this person's own
  // hand. Every event the driver dispatches below is synthetic (isTrusted false),
  // so the controller can never release themselves through this path.
  const armedAt = Date.now();
  // A MOUSE MOVE MUST BE A DECISION, NOT A BRUSH. A trackpad reports a move when a palm
  // touches it, so releasing on the first pixel meant the guest could not even watch their
  // own screen while somebody helped them. A keystroke, a wheel or a touch is deliberate on
  // its own; a pointer has to travel MOVE_TAKEBACK_PX before it counts.
  let from = null, travelled = 0;
  const takeBack = (e) => {
    if (!e.isTrusted || live !== state || state.control !== 'granted') return;
    if (Date.now() - armedAt < 400) return;   // the Allow click itself
    if (e.type === 'mousemove') {
      if (!from) { from = { x: e.clientX, y: e.clientY }; return; }
      travelled += Math.abs(e.clientX - from.x) + Math.abs(e.clientY - from.y);
      from = { x: e.clientX, y: e.clientY };
      if (travelled < MOVE_TAKEBACK_PX) return;
    }
    releaseFromGuest(state, 'guest_moved');
  };
  window.addEventListener('mousemove', takeBack, true);
  window.addEventListener('keydown', takeBack, true);
  window.addEventListener('wheel', takeBack, true);
  window.addEventListener('touchstart', takeBack, true);
  state.releaseUnsub = () => {
    window.removeEventListener('mousemove', takeBack, true);
    window.removeEventListener('keydown', takeBack, true);
    window.removeEventListener('wheel', takeBack, true);
    window.removeEventListener('touchstart', takeBack, true);
  };
  ensureCursor(state);
}

function disarmDriving(state) {
  state.driving = false;
  document.documentElement.classList.remove('cobrowse-controlled');
  if (state.releaseUnsub) { state.releaseUnsub(); state.releaseUnsub = null; }
  if (state.cursor) { try { state.cursor.remove(); } catch { /* fine */ } state.cursor = null; }
}

/** The watched person takes control back (their own mouse, their Take back / Stop). */
export function releaseFromGuest(state, reason) {
  const st = state || live; if (!st) return;
  setControlLocal(st, 'released');
  api.cobrowseControlRelease(st.sessionId, reason).catch(() => {});
}

/** The controller's pointer, drawn on the real page so the person sees where the hand is. */
function ensureCursor(state) {
  if (state.cursor) return state.cursor;
  const c = document.createElement('div');
  c.setAttribute('aria-hidden', 'true');
  c.setAttribute('data-cobrowse-block', 'pointer');   // not mirrored back (the viewer has their own pointer)
  c.style.cssText = 'position:fixed;z-index:2147483000;pointer-events:none;width:18px;height:18px;transform:translate(-3px,-3px);'
    + 'background:#AE8746;border:2px solid #fff;border-radius:50% 50% 50% 0;box-shadow:0 1px 4px rgba(0,0,0,.4);left:-100px;top:-100px;transition:left .04s linear,top .04s linear';
  document.body.appendChild(c);
  state.cursor = c;
  return c;
}

const KEY_CODES = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, ' ': 32 };

/** Mirror id → the real element, or null when it may not be driven. */
function drivable(id) {
  const node = record.mirror && typeof record.mirror.getNode === 'function' ? record.mirror.getNode(Number(id)) : null;
  if (!node) return null;
  const el = node.nodeType === 1 ? node : node.parentElement;
  if (!el || !document.contains(el)) return null;
  if (el.closest && el.closest(NO_DRIVE_SELECTOR)) return null;
  return el;
}

/** React reads the DOM through the native setter; typing must go the same way. */
function setNativeValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(el, value); else el.value = value;
}

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number', '']);
/** A real, editable text control (input of a text kind, or a textarea). */
function editableText(el) {
  if (!el || el.disabled || el.readOnly) return false;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  return TEXT_INPUT_TYPES.has(String(el.getAttribute('type') || '').toLowerCase());
}
/**
 * A number / email / tel input REPORTS NO CARET and SANITISES what is set on it: typing
 * 1 . 5 sets '1', then '1.' — which the browser stores as '' — then '5', so a naive
 * read-back-and-append types "5" where a person typed "1.5", and a leading '-' is eaten.
 * So the string being composed is remembered per element, and the box's own value is
 * trusted again the moment it stops matching what the browser kept from our last set —
 * which is exactly what happens when the guest (or the app) changes it themselves.
 */
const composing = new WeakMap();   // el → { text: what we meant, set: what the browser kept }
function caretless(el) { return el.selectionStart == null || el.selectionEnd == null; }
function composedValue(el) {
  const c = composing.get(el);
  return c && c.set === el.value ? c.text : String(el.value || '');
}
/** Set the value, remember it when the element has no caret, and tell React. */
function putValue(el, next) {
  const capped = el.maxLength > 0 ? next.slice(0, el.maxLength) : next;   // a programmatic set bypasses maxlength
  setNativeValue(el, capped);
  if (caretless(el)) composing.set(el, { text: capped, set: el.value });
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return capped;
}

/** Replace the current selection with `text` and tell React. */
function insertText(el, text) {
  const noCaret = caretless(el);
  const v = noCaret ? composedValue(el) : String(el.value || '');
  const start = noCaret ? v.length : el.selectionStart, end = noCaret ? v.length : el.selectionEnd;
  const capped = putValue(el, v.slice(0, start) + text + v.slice(end));
  if (!noCaret) { const caret = Math.min(capped.length, start + text.length); try { el.setSelectionRange(caret, caret); } catch { /* fine */ } }
}
/** Apply one keystroke's EDIT to a text control: printable → insert, Backspace/Delete → remove. */
function applyTextKey(el, key, init) {
  if (!editableText(el)) return false;
  if (init.ctrlKey || init.metaKey || init.altKey) return false;
  if (key.length === 1) { insertText(el, key); return true; }
  if (key === 'Backspace' || key === 'Delete') {
    const noCaret = caretless(el);
    const v = noCaret ? composedValue(el) : String(el.value || '');
    let start = noCaret ? v.length : el.selectionStart, end = noCaret ? v.length : el.selectionEnd;
    if (start === end) { if (key === 'Backspace') start = Math.max(0, start - 1); else end = Math.min(v.length, end + 1); }
    if (start === end) return false;
    putValue(el, v.slice(0, start) + v.slice(end));
    if (!noCaret) { try { el.setSelectionRange(start, start); } catch { /* fine */ } }
    return true;
  }
  // A contenteditable region is deliberately not driven: this portal has none, and
  // guessing at rich-text editing is how a controller destroys somebody's document.
  return false;
}

function mouseAt(el, type, x, y) {
  const r = el.getBoundingClientRect();
  const cx = Number.isFinite(x) ? x - window.scrollX : r.left + r.width / 2;
  const cy = Number.isFinite(y) ? y - window.scrollY : r.top + r.height / 2;
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 }));
}

/** Perform one relayed input on the real page. Never throws; never touches a blocked element. */
export function applyInput(state, m) {
  if (!m || live !== state || state.control !== 'granted') return false;
  if (!routeAllowsDriving()) return false;
  try {
    if (m.k === 'cursor') {
      const c = ensureCursor(state);
      c.style.left = `${(Number(m.x) || 0) - window.scrollX}px`; c.style.top = `${(Number(m.y) || 0) - window.scrollY}px`;
      return true;
    }
    if (m.k === 'scroll') {
      if (m.id == null || m.id === 0 || m.id === 1) { window.scrollTo({ left: Number(m.sx) || 0, top: Number(m.sy) || 0, behavior: 'auto' }); return true; }
      const el = drivable(m.id); if (!el) return false;
      el.scrollLeft = Number(m.sx) || 0; el.scrollTop = Number(m.sy) || 0; return true;
    }
    const el = drivable(m.id); if (!el) return false;
    if (m.k === 'click' || m.k === 'dblclick') {
      mouseAt(el, 'mousedown', m.x, m.y); mouseAt(el, 'mouseup', m.x, m.y);
      if (typeof el.focus === 'function') { try { el.focus({ preventScroll: true }); } catch { /* fine */ } }
      if (m.k === 'dblclick') mouseAt(el, 'dblclick', m.x, m.y);
      else if (typeof el.click === 'function') el.click(); else mouseAt(el, 'click', m.x, m.y);
      return true;
    }
    if (m.k === 'focus') { try { el.focus({ preventScroll: true }); } catch { /* fine */ } return true; }
    if (m.k === 'blur') { try { el.blur(); } catch { /* fine */ } return true; }
    if (m.k === 'input' || m.k === 'change') {
      const isCheck = el.matches && el.matches('input[type="checkbox"], input[type="radio"]');
      if (isCheck) { if (typeof m.checked === 'boolean' && el.checked !== m.checked) el.click(); return true; }
      if (!('value' in el)) return false;
      // A <select> on the mirror is MASKED like every other input, so its value is
      // meaningless here — the option INDEX the viewer picked is what travels. With no
      // usable index we REFUSE: falling through would set the masked marker as the value,
      // which leaves selectedIndex at -1 and wipes the guest's own choice.
      if (el.tagName === 'SELECT') {
        const i = Number(m.idx);
        if (!Number.isFinite(i) || i < 0 || i >= el.options.length) return false;
        el.selectedIndex = i;
      } else setNativeValue(el, String(m.value == null ? '' : m.value));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      if (m.k === 'change' || el.tagName === 'SELECT') el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (m.k === 'key') {
      const key = String(m.key || '');
      if (!key) return false;
      const init = { bubbles: true, cancelable: true, key, code: String(m.code || ''), keyCode: KEY_CODES[key] || 0, which: KEY_CODES[key] || 0,
        ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt, metaKey: !!m.meta };
      const notCancelled = el.dispatchEvent(new KeyboardEvent('keydown', init));
      // THE GUEST'S OWN BROWSER EDITS THE TEXT. The viewer only ever sees a MASKED
      // mirror (every typed value is the fixed-length marker), so it cannot know
      // the real value or the caret — a whole-value echo from that side wipes what
      // the person had typed. A synthetic KeyboardEvent inserts nothing on its own
      // either, so the edit is applied here, against the real value, at the real
      // selection, through the native setter React reads (setNativeValue).
      if (notCancelled) applyTextKey(el, key, init);
      el.dispatchEvent(new KeyboardEvent('keyup', init));
      // Enter on a form control submits the way this person's own Enter would — and only
      // when the page did NOT cancel the keydown (a typeahead picking a suggestion cancels
      // it precisely so Enter does not submit; submitting anyway files the form early).
      if (notCancelled && key === 'Enter' && el.form && el.tagName !== 'TEXTAREA') { try { el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit(); } catch { /* fine */ } }
      return true;
    }
    if (m.k === 'paste') {
      // Pasted text is inserted at the real selection too, never appended to a value
      // the viewer guessed at.
      if (!editableText(el)) return false;
      insertText(el, String(m.value == null ? '' : m.value));
      return true;
    }
    if (m.k === 'submit') { if (el.form) { try { el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit(); } catch { /* fine */ } return true; } return false; }
  } catch { /* one bad event never breaks the page */ }
  return false;
}

/** The current control state ('none' | 'requested' | 'granted' | 'released' | 'refused'). */
export function guestControlState() { return live ? live.control : 'none'; }

/** Stop streaming (the person pressed Stop, or the session ended elsewhere). */
export function stopGuest(reason = 'stopped_by_guest') {
  if (live) endLocal(live, reason);
}

export function guestSessionId() { return live ? live.sessionId : null; }

/** The session id a reload should rejoin, if any. */
export function rememberedSessionId() {
  try { return sessionStorage.getItem(SESSION_KEY) || null; } catch { return null; }
}
