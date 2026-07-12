/**
 * Echo / loop suppression (blueprint §3.3).
 *
 * Because the integration authenticates as a real user, ClickUp fires webhooks
 * for OUR OWN writes, and the actor is indistinguishable from a human edit. So
 * we cannot suppress by actor. Instead:
 *
 *   1. Shadow copy — the last value we wrote/read per (task, field). An inbound
 *      value equal to the shadow is an echo → recorded, not re-applied.
 *   2. Suppression window — after we push (task, field), we stamp its hash for
 *      ~90s; inbound events matching within the window are dropped.
 *   3. Loopback guard — writes we make while APPLYING an inbound change are
 *      flagged so the app's own write-path doesn't re-enqueue an outbound job.
 *
 * The window store is per-process (fine: a missed suppression just costs one
 * idempotent no-op write, never a loop, because shadow-equality still blocks it).
 */
const crypto = require('crypto');

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
function valueHash(value) {
  return crypto.createHash('sha256').update(stableStringify(value == null ? null : value)).digest('hex').slice(0, 16);
}
/** Hash a whole field map { fieldId: value } for the per-file shadow. */
function shadowHash(fieldMap = {}) {
  return crypto.createHash('sha256').update(stableStringify(fieldMap)).digest('hex');
}

const DEFAULT_TTL_MS = 90 * 1000;
const _window = new Map();          // key `${taskId}::${fieldId}` -> { hash, expiresAt }
const keyOf = (taskId, fieldId) => `${taskId}::${fieldId}`;

function prune(now) {
  for (const [k, v] of _window) if (v.expiresAt <= now) _window.delete(k);
}

/** Call right after WE push a field value, so the echo webhook is ignored. */
function markPushed(taskId, fieldId, value, ttlMs = DEFAULT_TTL_MS) {
  const now = Date.now();
  prune(now);
  _window.set(keyOf(taskId, fieldId), { hash: valueHash(value), expiresAt: now + ttlMs });
}

/**
 * Is an inbound (task, field, value) an echo of our own recent write, OR equal
 * to the shadow copy? `shadowValue` is what we last stored for that field.
 *
 * NOTE (2026-07-12 audit — I-B): inbound ingest does NOT currently call this.
 * Loop-safety on pull is achieved STRUCTURALLY, not by echo comparison:
 *   • ingest writes every column via `COALESCE(pulled, col)` — re-applying our own
 *     just-pushed value is an idempotent no-op (pull value == push value), so
 *     there is no ping-pong even without suppression;
 *   • checklist statuses use `shouldApplyInbound` (no-downgrade + skip-when-equal),
 *     which cannot ping-pong; and
 *   • outbound is scoped enqueue-on-write only (no dirty-sweep), so a pull never
 *     re-enqueues a push.
 * `markPushed`/the shadow are retained as an audit trail and as the ready hook if
 * a future NON-idempotent `both`-field is ever added (where pull != push and a
 * real echo could occur). Do not assume inbound suppression is active today.
 */
function isEcho(taskId, fieldId, value, shadowValue) {
  const h = valueHash(value);
  const w = _window.get(keyOf(taskId, fieldId));
  if (w && w.expiresAt > Date.now() && w.hash === h) return true;   // suppression window
  if (arguments.length >= 4 && valueHash(shadowValue) === h) return true; // shadow equality
  return false;
}

/** Test/maintenance helpers. */
function _clear() { _window.clear(); }
function _size() { return _window.size; }

module.exports = { valueHash, shadowHash, stableStringify, markPushed, isEcho, _clear, _size };
