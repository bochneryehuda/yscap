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
/** Server close codes after which reconnecting is pointless: refused, not ours, no live session. */
export const TERMINAL_CLOSE_CODES = [4400, 4401, 4403, 4404];
const MAX_RETRY_MS = 5 * 60 * 1000;

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
  state.stop = record(recordOptions((ev) => {
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
    state.backoff = RECONNECT_MS; state.retryUntil = 0;
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
    state.onState && state.onState({ connected: false });
    if (state.closedByServer || !live || live !== state) return;
    // Refused / not ours / no live session: reconnecting would only repeat the refusal.
    if (e && TERMINAL_CLOSE_CODES.includes(e.code)) { state.closedByServer = 'refused'; endLocal(state, 'refused'); return; }
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
  document.addEventListener('click', onNotice, true);
  const noticeUnsub = () => document.removeEventListener('click', onNotice, true);
  try { sessionStorage.setItem(SESSION_KEY, sessionId); } catch { /* private mode */ }
  // Route changes: stop on a secret screen, resume (with a fresh snapshot) elsewhere.
  const onRoute = () => {
    if (live !== state) return;
    if (!recordingAllowedHere()) { stopRecorder(state); return; }
    if (!state.stop && state.ws && state.ws.readyState === 1) startRecorder(state);
    if (state.ws && state.ws.readyState === 1) { try { state.ws.send(JSON.stringify({ t: 'route', path: routeNow(), title: document.title })); } catch { /* fine */ } }
  };
  window.addEventListener('hashchange', onRoute);
  state.routeUnsub = () => { window.removeEventListener('hashchange', onRoute); noticeUnsub(); };
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
  const takeBack = (e) => {
    if (!e.isTrusted || live !== state || state.control !== 'granted') return;
    if (Date.now() - armedAt < 400) return;   // the Allow click itself
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
/** Replace the current selection with `text` and tell React. */
function insertText(el, text) {
  const v = String(el.value || '');
  let start = el.selectionStart, end = el.selectionEnd;
  if (!Number.isFinite(start) || !Number.isFinite(end)) { start = v.length; end = v.length; }
  const next = v.slice(0, start) + text + v.slice(end);
  setNativeValue(el, next);
  const caret = start + text.length;
  try { el.setSelectionRange(caret, caret); } catch { /* number inputs refuse; fine */ }
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
/** Apply one keystroke's EDIT to a text control: printable → insert, Backspace/Delete → remove. */
function applyTextKey(el, key, init) {
  if (!editableText(el)) return false;
  if (init.ctrlKey || init.metaKey || init.altKey) return false;
  if (key.length === 1) { insertText(el, key); return true; }
  if (key === 'Backspace' || key === 'Delete') {
    const v = String(el.value || '');
    let start = el.selectionStart, end = el.selectionEnd;
    if (!Number.isFinite(start) || !Number.isFinite(end)) { start = v.length; end = v.length; }
    if (start === end) { if (key === 'Backspace') start = Math.max(0, start - 1); else end = Math.min(v.length, end + 1); }
    if (start === end) return false;
    setNativeValue(el, v.slice(0, start) + v.slice(end));
    try { el.setSelectionRange(start, start); } catch { /* fine */ }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
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
      // meaningless here — the option INDEX the viewer picked is what travels.
      if (el.tagName === 'SELECT' && Number.isFinite(Number(m.idx)) && Number(m.idx) >= 0 && Number(m.idx) < el.options.length) el.selectedIndex = Number(m.idx);
      else setNativeValue(el, String(m.value == null ? '' : m.value));
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
      // Enter on a form control submits the way this person's own Enter would.
      if (key === 'Enter' && el.form && el.tagName !== 'TEXTAREA') { try { el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit(); } catch { /* fine */ } }
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
