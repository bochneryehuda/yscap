/* THE ARENA — the browser half of the live game board.
 *
 * THREE THINGS LIVE HERE, and nothing else:
 *   1. the API calls, in one place so no screen builds a URL by hand;
 *   2. the live event names, exported so the shared SSE client and the screens
 *      read the SAME list rather than each keeping a copy that drifts;
 *   3. the CLOCK OFFSET, which is what makes one wheel look like one wheel on
 *      thirty different laptops.
 *
 * WHY THE CLOCK OFFSET MATTERS. The server says "this wheel started at T and
 * runs for D milliseconds". Every screen animates from `(now - T) / D`. If a
 * laptop's clock is ninety seconds fast — and office laptops are — that screen
 * would show the wheel already finished while the room is still watching it
 * turn. So `now` is never `Date.now()`: it is `Date.now() + offset`, where the
 * offset is measured against the server the same way NTP does it, from the
 * round trip of a request whose response carries the server's own time.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO: work out who won. The winner is
 * decided on the server, from a seed committed before anybody entered, and this
 * code only ever asks the server to CHECK a draw and shows the answer. A second
 * implementation in the browser is exactly how two answers start disagreeing,
 * and the one people would believe is the one on their own screen.
 */
import { api } from './api.js';

/* The live frames the board listens for. Exported so lib/chatEvents.js and the
   screens share one list — a name added here reaches both. */
export const ARENA_EVENTS = [
  'arena:switch', 'arena:session', 'arena:spin', 'arena:roster',
  'arena:spinning', 'arena:stopping', 'arena:revealed', 'arena:decided', 'arena:deadline',
  'arena:challenge-open', 'arena:challenge-close', 'arena:challenge-entry',
  'arena:challenge-decided', 'arena:challenge-plan', 'arena:tickets',
  'arena:checkin', 'arena:entry', 'arena:claim',
  'arena:chat', 'arena:chat-react', 'arena:chat-moderated', 'arena:suggestion',
];

/* ---------------------------------------------------------------- the clock */

let offsetMs = 0;          // add to Date.now() to get the server's clock
let samples = [];

/** The server's clock, as best this tab can tell. */
export const serverNow = () => Date.now() + offsetMs;
export const clockOffsetMs = () => offsetMs;

/**
 * One NTP-style sample: send at T1, server stamps T2, we receive at T3.
 * offset ≈ T2 - (T1 + T3) / 2, which cancels out half the round trip.
 *
 * A SINGLE sample is noisy, so the MEDIAN of the last few is used rather than
 * the latest — one slow response must not throw the whole room's animation out.
 */
export function recordClockSample(t1, serverIso, t3) {
  const t2 = Date.parse(serverIso);
  if (!Number.isFinite(t2)) return offsetMs;
  samples.push(t2 - (t1 + t3) / 2);
  if (samples.length > 7) samples = samples.slice(-7);
  const sorted = [...samples].sort((a, b) => a - b);
  offsetMs = sorted[Math.floor(sorted.length / 2)];
  return offsetMs;
}

/** GET that measures the clock on its way past. */
async function timedGet(path) {
  const t1 = Date.now();
  const res = await api.get(path);
  if (res && res.serverNow) recordClockSample(t1, res.serverNow, Date.now());
  return res;
}

/**
 * How far through a spin we are, 0..1, on the SERVER's clock.
 * A screen that opens halfway through a spin gets 0.5 and joins the wheel
 * already in motion — the same formula covers "started now" and "joined late",
 * which is why there is no separate catch-up path to get wrong.
 */
export function spinProgress(startedAt, durationMs) {
  const t0 = Date.parse(startedAt);
  const d = Number(durationMs) || 1;
  if (!Number.isFinite(t0)) return 1;
  return Math.max(0, Math.min(1, (serverNow() - t0) / d));
}

/**
 * The easing the wheel decelerates on. Ease-out quartic: fast away, long slow
 * settle. Every screen uses this one function, so a wheel joined late lands at
 * the same angle at the same instant as one watched from the start.
 */
export const easeOutQuart = (t) => 1 - Math.pow(1 - t, 4);

/** Where the wheel is pointing right now, in degrees. */
export function rotationAt(startedAt, durationMs, targetDeg) {
  return easeOutQuart(spinProgress(startedAt, durationMs)) * (Number(targetDeg) || 0);
}

/* ------------------------------------------------------------------- the API */

export const arena = {
  visibility: () => api.get('/api/arena/visibility'),
  getSettings: () => api.get('/api/arena/settings'),
  saveSettings: (b) => api.put('/api/arena/settings', b),

  catalog: () => api.get('/api/arena/catalog'),
  board: (sessionId) => timedGet(`/api/arena/board${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`),

  sessions: () => api.get('/api/arena/sessions'),
  // The whole internal roster, for picking who plays BEFORE a session exists.
  roster: () => api.get('/api/arena/roster'),
  // ONE press builds the whole day — "Elementix Day" with the Early Bird and
  // the Mega Spin inside it, as a DRAFT. Safe to press twice (the server
  // reports what was already there). day = 'YYYY-MM-DD' where the room is.
  setupDay: (b) => api.post('/api/arena/setup-day', b),
  createSession: (b) => api.post('/api/arena/sessions', b),
  updateSession: (id, b) => api.put(`/api/arena/sessions/${id}`, b),
  setSessionState: (id, state) => api.post(`/api/arena/sessions/${id}/state`, { state }),
  people: (id) => api.get(`/api/arena/sessions/${id}/people`),

  createSpin: (sessionId, b) => api.post(`/api/arena/sessions/${sessionId}/spins`, b),
  updateSpin: (id, b) => api.put(`/api/arena/spins/${id}`, b),
  openSpin: (id) => api.post(`/api/arena/spins/${id}/open`, {}),
  lockSpin: (id) => api.post(`/api/arena/spins/${id}/lock`, {}),
  cancelSpin: (id, reason) => api.post(`/api/arena/spins/${id}/cancel`, { reason }),
  reviveSpin: (id) => api.post(`/api/arena/spins/${id}/revive`, {}),
  turnWheel: (id, seq, clientSeed) => api.post(`/api/arena/spins/${id}/spin`, { seq, clientSeed }),
  freezeWheel: (id, seq) => api.post(`/api/arena/spins/${id}/freeze`, { seq }),
  preview: (id, seq) => api.get(`/api/arena/spins/${id}/preview?seq=${seq}`),
  verify: (drawId) => api.get(`/api/arena/draws/${drawId}/verify`),
  pressStop: (drawId) => api.post(`/api/arena/draws/${drawId}/stop`, {}),
  buttons: (spinId) => api.get(`/api/arena/spins/${spinId}/buttons`),
  spinRoster: (spinId) => api.get(`/api/arena/spins/${spinId}/roster`),
  setSpinRoster: (spinId, excludedStaffIds) => api.put(`/api/arena/spins/${spinId}/roster`, { excludedStaffIds }),

  // Templates — the two ready-to-go plans.
  templates: () => api.get('/api/arena/templates'),
  loadTemplate: (sessionId, key, body) => api.post(`/api/arena/sessions/${sessionId}/templates/${key}`, body),

  // Challenges — the things that land on everybody's screen during the day.
  challengeLibrary: () => api.get('/api/arena/challenges/library'),
  challenges: (sessionId) => api.get(`/api/arena/sessions/${sessionId}/challenges`),
  planChallenges: (sessionId, b) => api.post(`/api/arena/sessions/${sessionId}/challenges/plan`, b),
  addChallenge: (sessionId, b) => api.post(`/api/arena/sessions/${sessionId}/challenges`, b),
  updateChallenge: (id, b) => api.put(`/api/arena/challenges/${id}`, b),
  fulfil: (id, b) => api.post(`/api/arena/challenges/${id}/fulfil`, b),
  decideFulfilment: (id, status, reason) => api.post(`/api/arena/challenge-entries/${id}/decide`, { status, reason }),
  myTickets: (sessionId) => api.get(`/api/arena/sessions/${sessionId}/my-tickets`),
  monitor: (sessionId) => api.get(`/api/arena/sessions/${sessionId}/monitor`),
  room: (sessionId) => api.get(`/api/arena/sessions/${sessionId}/room`),
  recap: (sessionId, staffId) => api.get(`/api/arena/sessions/${sessionId}/recap${staffId ? `?staff=${encodeURIComponent(staffId)}` : ''}`),
  rematchSuggestion: (sessionId) => api.get(`/api/arena/sessions/${sessionId}/rematch-suggestion`),
  rematch: (sessionId, b) => api.post(`/api/arena/sessions/${sessionId}/rematch`, b),
  giveTickets: (sessionId, b) => api.post(`/api/arena/sessions/${sessionId}/tickets`, b),

  // The AI helper. Every one of these is optional: the screens work without it.
  aiStatus: () => api.get('/api/arena/ai/status'),
  aiSpin: (text) => api.post('/api/arena/ai/spin', { text }),
  aiPrizes: (b) => api.post('/api/arena/ai/prizes', b),
  aiChallenges: (b) => api.post('/api/arena/ai/challenges', b),
  aiRewrite: (text, purpose) => api.post('/api/arena/ai/rewrite', { text, purpose }),
  aiSubjects: (text) => api.post('/api/arena/ai/subjects', { text }),

  checkIn: (spinId, note, attested) => api.post(`/api/arena/spins/${spinId}/checkin`, { note, attested: attested === true }),
  decideCheckin: (id, status, reason) => api.post(`/api/arena/checkins/${id}/decide`, { status, reason }),
  enter: (spinId, b) => api.post(`/api/arena/spins/${spinId}/entries`, b),
  decideEntry: (id, status, reason) => api.post(`/api/arena/entries/${id}/decide`, { status, reason }),
  withdrawEntry: (id) => api.del(`/api/arena/entries/${id}`),
  claim: (qualifierId, b) => api.post(`/api/arena/qualifiers/${qualifierId}/claim`, b),
  decideClaim: (id, status, reason) => api.post(`/api/arena/claims/${id}/decide`, { status, reason }),

  chat: (sessionId, before) => api.get(`/api/arena/sessions/${sessionId}/chat${before ? `?before=${before}` : ''}`),
  say: (sessionId, b) => api.post(`/api/arena/sessions/${sessionId}/chat`, b),
  react: (messageId, emoji) => api.post(`/api/arena/chat/${messageId}/react`, { emoji }),
  moderate: (messageId, action) => api.post(`/api/arena/chat/${messageId}/moderate`, { action }),

  suggestions: (sessionId) => api.get(`/api/arena/sessions/${sessionId}/suggestions`),
  suggest: (sessionId, body) => api.post(`/api/arena/sessions/${sessionId}/suggestions`, { body }),
  voteSuggestion: (id, vote) => api.post(`/api/arena/suggestions/${id}/vote`, { vote }),
  setSuggestionStatus: (id, status) => api.post(`/api/arena/suggestions/${id}/status`, { status }),

  prizes: () => api.get('/api/arena/prizes'),
  addPrize: (b) => api.post('/api/arena/prizes', b),
  updatePrize: (id, b) => api.put(`/api/arena/prizes/${id}`, b),
  deletePrize: (id) => api.del(`/api/arena/prizes/${id}`),

  awards: (sessionId) => api.get(`/api/arena/sessions/${sessionId}/awards`),
  awardsCsvUrl: (sessionId) => `/api/arena/sessions/${sessionId}/awards.csv`,
  // The CSV is behind the login, so it is FETCHED with the token and saved as a
  // file — a plain <a href> cannot carry the Authorization header, and clicking
  // one navigated the admin onto a raw {"error":"unauthenticated"} JSON page
  // (owner-reported 2026-08-19). downloadAwardsCsv is the only way to get it.
  downloadAwardsCsv: async (id) => {
    const { downloadAuthed, saveBlob } = await import('./api.js');
    const { blob, filename } = await downloadAuthed(`/api/arena/sessions/${id}/awards.csv`);
    saveBlob(blob, filename || 'arena-prizes.csv');
  },
};

/* ------------------------------------------------------------------ helpers */

export function money(cents) {
  const n = Number(cents) || 0;
  return n % 100 === 0
    ? `$${(n / 100).toLocaleString('en-US')}`
    : `$${(n / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A countdown people can read out loud. */
export function countdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

/** Distinct, readable slice colours. Generated, so a wheel of 40 still works. */
export function sliceColour(i, total) {
  // Walk the hue wheel by the GOLDEN ANGLE rather than by an even split. An
  // even split puts near-identical colours next to each other on a big wheel;
  // 137.5 degrees never repeats a neighbour, however many slices there are.
  // Alternating lightness gives every boundary a second cue, which is also
  // what makes the wheel readable to somebody who cannot separate the hues.
  const hue = Math.round((i * 137.508 + 18) % 360);
  return `hsl(${hue} ${i % 2 ? 74 : 66}% ${i % 2 ? 52 : 43}%)`;
}

/** Does this person want less motion? Asked once, honoured everywhere. */
export const prefersReducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch { return false; }
};
