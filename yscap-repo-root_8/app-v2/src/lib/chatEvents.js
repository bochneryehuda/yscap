/* Shared SSE client — one EventSource per tab, fanned out to any number of
   subscribers (thread views, the hub list, the nav badge). EventSource can't
   send an Authorization header, so the token rides as a query parameter (the
   backend re-verifies it exactly like the auth middleware).

   Auto-heals: the browser reconnects on its own; on a hard error we tear down
   and rebuild with a FRESH token (the sliding session may have rotated it) and
   emit a synthetic 'reconnect' so views refetch anything they missed. */
import { getToken } from './api.js';

const EVENT_NAMES = [
  'hello', 'message:new', 'message:edited', 'message:deleted', 'reaction:update',
  'receipt:read', 'receipt:delivered', 'typing', 'presence:diff',
  'unread:update', 'conversation:updated', 'notify',
];

let es = null;
let connId = null;
let retryTimer = null;
let wasConnected = false;
const listeners = new Set();

function dispatch(event, data) {
  for (const fn of [...listeners]) { try { fn(event, data); } catch { /* one bad listener can't break the bus */ } }
}

function teardown() {
  if (es) { try { es.close(); } catch { /* already closed */ } es = null; }
  connId = null;
}

function connect() {
  if (es || !getToken() || typeof window.EventSource === 'undefined') return;
  es = new EventSource(`/api/events?token=${encodeURIComponent(getToken())}`);
  for (const name of EVENT_NAMES) {
    es.addEventListener(name, (e) => {
      let data = null; try { data = JSON.parse(e.data); } catch { /* ignore */ }
      if (name === 'hello') {
        connId = data && data.connId;
        if (wasConnected) dispatch('reconnect', {});   // refetch after a gap
        wasConnected = true;
      }
      dispatch(name, data);
    });
  }
  es.onerror = () => {
    teardown();
    // Rebuild with a fresh token after a short backoff (EventSource's own
    // retry can't pick up a rotated token).
    if (!retryTimer && listeners.size) {
      retryTimer = setTimeout(() => { retryTimer = null; connect(); }, 4000);
    }
  };
}

/** Subscribe to the live stream. Returns an unsubscribe function. */
export function subscribeChat(fn) {
  listeners.add(fn);
  connect();
  return () => {
    listeners.delete(fn);
    if (!listeners.size) teardown();   // no one listening → close the stream
  };
}

/** This tab's connection id (for typing/open declarations). */
export const getConnId = () => connId;
