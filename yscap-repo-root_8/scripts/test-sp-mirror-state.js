'use strict';
/* Unit tests for the pure SharePoint-mirror state-transition core
 * (src/lib/sp-mirror-state.js). No DB, no network — exercises every verdict,
 * every state transition, backoff bounds, throttle-header parsing, the reaper
 * decision, and the legacy-column derivation (the twin of db/220's backfill).
 * Run: node scripts/test-sp-mirror-state.js
 */
const assert = require('assert');
const S = require('../src/lib/sp-mirror-state');

let n = 0;
const ok = (m) => { n++; console.log('  ok -', m); };
// deterministic rng helpers
const rng = (v) => () => v;

// ---- 1. static sets / predicates ------------------------------------------
assert.deepStrictEqual(S.STATES, ['PENDING', 'IN_PROGRESS', 'DONE', 'FAILED', 'DEAD', 'SKIPPED']);
['DONE', 'DEAD', 'SKIPPED'].forEach((s) => assert.ok(S.isTerminal(s), `${s} terminal`));
['PENDING', 'IN_PROGRESS', 'FAILED'].forEach((s) => assert.ok(!S.isTerminal(s), `${s} not terminal`));
assert.ok(S.isClaimable('PENDING') && S.isClaimable('FAILED'));
assert.ok(!S.isClaimable('IN_PROGRESS') && !S.isClaimable('DONE') && !S.isClaimable('DEAD') && !S.isClaimable('SKIPPED'));
ok('state sets: terminal / claimable classification correct');

// ---- 2. transition guard ---------------------------------------------------
assert.ok(S.canTransition('PENDING', 'IN_PROGRESS'));
assert.ok(S.canTransition('FAILED', 'IN_PROGRESS'));
assert.ok(S.canTransition('IN_PROGRESS', 'DONE'));
assert.ok(S.canTransition('IN_PROGRESS', 'FAILED'));
assert.ok(S.canTransition('IN_PROGRESS', 'PENDING'));   // reaper reclaim
assert.ok(S.canTransition('IN_PROGRESS', 'DEAD'));
assert.ok(S.canTransition('DONE', 'PENDING'));          // anti-entropy re-mirror
assert.ok(S.canTransition('DEAD', 'PENDING'));          // manual requeue
assert.ok(S.canTransition('SKIPPED', 'PENDING'));       // un-skip
// illegal edges
assert.ok(!S.canTransition('PENDING', 'DONE'), 'cannot skip IN_PROGRESS');
assert.ok(!S.canTransition('DONE', 'DEAD'));
assert.ok(!S.canTransition('IN_PROGRESS', 'SKIPPED'));
assert.ok(!S.canTransition('DONE', 'IN_PROGRESS'));
assert.ok(!S.canTransition('bogus', 'PENDING'));
ok('transition guard: legal edges allowed, illegal edges rejected');

// ---- 3. classifier ---------------------------------------------------------
const v = (st, h) => S.classify(st, h).verdict;
assert.strictEqual(v(201), 'SUCCESS');
assert.strictEqual(v(200), 'SUCCESS');
assert.strictEqual(v(204), 'SUCCESS');
assert.strictEqual(v(429), 'THROTTLE');
assert.strictEqual(v(409), 'ADOPT');
assert.strictEqual(v(404), 'SESSION_RESTART');
assert.strictEqual(v(401), 'AUTH');
assert.strictEqual(v(412), 'BENIGN');
assert.strictEqual(v(416), 'BENIGN');
[400, 403, 405, 411, 413, 415].forEach((s) => assert.strictEqual(v(s), 'PERMANENT', `${s} permanent`));
[500, 502, 503, 504, 423].forEach((s) => assert.strictEqual(v(s), 'TRANSIENT', `${s} transient`));
assert.strictEqual(v(null), 'TRANSIENT', 'network error transient');
assert.strictEqual(v(418), 'PERMANENT', 'unknown 4xx -> permanent');
// throttle & benign do not consume the retry budget
assert.strictEqual(S.classify(429).countsAttempt, false);
assert.strictEqual(S.classify(412).countsAttempt, false);
assert.strictEqual(S.classify(500).countsAttempt, true);
ok('classifier: every known status maps to the right verdict + countsAttempt');

// ---- 4. backoff (AWS full jitter, capped) ---------------------------------
// upper bound = min(cap, base*2^attempt); rng=1 hits (just under) the ceiling.
assert.strictEqual(S.backoffMs(0, { base: 1000, cap: 300000, rng: rng(0) }), 0);
assert.strictEqual(S.backoffMs(3, { base: 1000, cap: 300000, rng: rng(1) }), 8000);   // 1000*2^3
assert.strictEqual(S.backoffMs(4, { base: 1000, cap: 300000, rng: rng(1) }), 16000);
// capped: 2^20 * 1000 >> 300000 -> ceiling clamps to cap
assert.strictEqual(S.backoffMs(20, { base: 1000, cap: 300000, rng: rng(1) }), 300000);
// monotonic-ish growth with fixed rng until the cap
let prev = -1;
for (let a = 0; a <= 8; a++) { const b = S.backoffMs(a, { rng: rng(1) }); assert.ok(b >= prev, 'grows'); prev = b; }
// full jitter stays within [0, ceiling)
for (let i = 0; i < 50; i++) { const b = S.backoffMs(5); assert.ok(b >= 0 && b <= 32000, 'within jittered band'); }
// no Infinity / NaN at absurd attempt counts
assert.ok(Number.isFinite(S.backoffMs(1000, { rng: rng(1) })));
ok('backoff: full-jitter bounds, exponential growth, hard cap, finite at extremes');

// ---- 5. throttle delay parsing --------------------------------------------
assert.strictEqual(S.throttleDelayMs({ 'Retry-After': '10' }), 10000);
assert.strictEqual(S.throttleDelayMs({ 'retry-after': '5', 'RateLimit-Reset': '31' }), 31000); // honor greater
assert.strictEqual(S.throttleDelayMs({ 'RateLimit-Reset': '7', 'Retry-After': '2' }), 7000);
assert.strictEqual(S.throttleDelayMs({}), 1000);              // floor 1s
assert.strictEqual(S.throttleDelayMs({ 'Retry-After': 'garbage' }), 1000);
assert.strictEqual(S.throttleDelayMs(null), 1000);
assert.strictEqual(S.throttleDelayMs({ 'Retry-After': '3' }, { jitterMs: 500 }), 3500);
// HTTP-date form of Retry-After is honored (converted to seconds-from-now), not floored
const now = Date.UTC(2026, 0, 1, 0, 0, 0);
assert.strictEqual(
  S.throttleDelayMs({ 'Retry-After': new Date(now + 42000).toUTCString() }, { now }),
  42000, 'HTTP-date Retry-After -> seconds-from-now');
// a past HTTP-date -> floored to 1s (never negative)
assert.strictEqual(S.throttleDelayMs({ 'Retry-After': new Date(now - 5000).toUTCString() }, { now }), 1000);
ok('throttle delay: honors greater of Retry-After / RateLimit-Reset, HTTP-date form, floors, tolerates junk');

// ---- 6. decideAfterAttempt: the decision surface --------------------------
// success -> DONE, strikes reset
let d = S.decideAfterAttempt(201, {}, 1, 0);
assert.strictEqual(d.status, 'DONE'); assert.strictEqual(d.permanentStrikes, 0);
// 409 adopt with confirmed-own provenance -> DONE (unresolved case tested below)
assert.strictEqual(S.decideAfterAttempt(409, {}, 1, 0, { adoptProvenance: 'match' }).status, 'DONE');
// throttle -> PENDING, does NOT count attempt, delay from header
d = S.decideAfterAttempt(429, { 'Retry-After': '12' }, 3, 0, { rng: rng(0) });
assert.strictEqual(d.status, 'PENDING'); assert.strictEqual(d.countsAttempt, false); assert.strictEqual(d.delayMs, 12000);
// benign 416 -> PENDING immediate, no penalty
d = S.decideAfterAttempt(416, {}, 3, 0);
assert.strictEqual(d.status, 'PENDING'); assert.strictEqual(d.countsAttempt, false); assert.strictEqual(d.delayMs, 0);
// 404 session gone -> FAILED, restart upload, CONSUMES an attempt (not a free re-queue)
d = S.decideAfterAttempt(404, {}, 2, 0, { rng: rng(1) });
assert.strictEqual(d.status, 'FAILED'); assert.strictEqual(d.countsAttempt, true);
assert.strictEqual(d.restartUpload, true); assert.ok(d.delayMs > 0);
// transient below cap -> FAILED with backoff
d = S.decideAfterAttempt(503, {}, 2, 0, { rng: rng(1) });
assert.strictEqual(d.status, 'FAILED'); assert.ok(d.delayMs > 0);
// transient AT cap -> DEAD(transient_exhausted)
d = S.decideAfterAttempt(503, {}, 8, 0, { maxAttempts: 8 });
assert.strictEqual(d.status, 'DEAD'); assert.strictEqual(d.deadReason, 'transient_exhausted');
// permanent needs 2 confirmations: first -> FAILED, second -> DEAD
d = S.decideAfterAttempt(400, {}, 1, 0);
assert.strictEqual(d.status, 'FAILED'); assert.strictEqual(d.permanentStrikes, 1);
d = S.decideAfterAttempt(400, {}, 2, 1);
assert.strictEqual(d.status, 'DEAD'); assert.strictEqual(d.deadReason, 'permanent_http_400');
// unambiguous permanent -> DEAD on first strike
d = S.decideAfterAttempt(413, {}, 1, 0, { unambiguousPermanent: true });
assert.strictEqual(d.status, 'DEAD');
// auth: first refresh-retry -> FAILED (with backoff), repeat -> DEAD(auth)
d = S.decideAfterAttempt(401, {}, 1, 0, { rng: rng(1) });
assert.strictEqual(d.status, 'FAILED'); assert.strictEqual(d.permanentStrikes, 1);
d = S.decideAfterAttempt(401, {}, 2, 1);
assert.strictEqual(d.status, 'DEAD'); assert.strictEqual(d.deadReason, 'auth');
ok('decideAfterAttempt: success/adopt/throttle/benign/restart/transient/permanent/auth all correct');

// 409 ADOPT provenance resolution (the DEFECT-B fix): unknown -> stay IN_PROGRESS
// + needsProvenanceCheck; match -> DONE; foreign -> DEAD(path_collision).
d = S.decideAfterAttempt(409, {}, 1, 0);
assert.strictEqual(d.status, 'IN_PROGRESS'); assert.strictEqual(d.needsProvenanceCheck, true);
assert.strictEqual(d.countsAttempt, false);
assert.strictEqual(S.decideAfterAttempt(409, {}, 1, 0, { adoptProvenance: 'match' }).status, 'DONE');
d = S.decideAfterAttempt(409, {}, 1, 0, { adoptProvenance: 'foreign' });
assert.strictEqual(d.status, 'DEAD'); assert.strictEqual(d.deadReason, 'path_collision');
ok('decideAfterAttempt: 409 needs provenance, resolves to DONE (own) or DEAD path_collision (foreign)');

// a run of transient failures never DEADs before the cap, always after
for (let a = 1; a < 8; a++) assert.strictEqual(S.decideAfterAttempt(500, {}, a, 0).status, 'FAILED', `attempt ${a} still FAILED`);
assert.strictEqual(S.decideAfterAttempt(500, {}, 8, 0).status, 'DEAD', 'attempt 8 -> DEAD');
ok('decideAfterAttempt: transient budget exhausts to DEAD exactly at maxAttempts');

// THE INVARIANT (DEFECT-A fix + backstop): EVERY attempt-consuming verdict must
// DEAD at the cap — no status can loop forever. Below cap they retry; at cap all DEAD.
const CONSUMING = [500, 404, 401, 400, null, 423]; // transient, session-restart, auth, permanent, network, locked
for (const st of CONSUMING) {
  assert.notStrictEqual(S.decideAfterAttempt(st, {}, 7, 0, { rng: rng(0.5) }).status, 'DEAD', `status ${st} at 7 still retrying`);
  assert.strictEqual(S.decideAfterAttempt(st, {}, 8, 0).status, 'DEAD', `status ${st} at cap -> DEAD (no infinite loop)`);
}
// even an ambiguous PERMANENT that never reaches 2 confirmations DEADs at the cap
assert.strictEqual(S.decideAfterAttempt(400, {}, 8, 0).status, 'DEAD', 'unconfirmed permanent still DEADs at cap');
// 409 that can never be resolved also fails closed at the cap (no eternal IN_PROGRESS)
d = S.decideAfterAttempt(409, {}, 8, 0);
assert.strictEqual(d.status, 'DEAD'); assert.strictEqual(d.deadReason, 'path_collision_unresolved');
ok('decideAfterAttempt: no-infinite-loop invariant — every consuming verdict DEADs at the cap');

// ---- 7. lease-expiry reaper decision --------------------------------------
assert.deepStrictEqual(S.decideOnLeaseExpiry(3), { status: 'PENDING', deadReason: null });
assert.deepStrictEqual(S.decideOnLeaseExpiry(8), { status: 'DEAD', deadReason: 'lease_exhausted' });
assert.strictEqual(S.decideOnLeaseExpiry(2, { maxAttempts: 2 }).status, 'DEAD');
ok('lease-expiry: reclaims below cap (PENDING), DEADs at/above cap (lease_exhausted)');

// ---- 8. deriveStatus: JS twin of db/220 backfill CASE ---------------------
const der = (r) => S.deriveStatus(r).status;
assert.strictEqual(der({ sharepoint_backed_up_at: new Date() }), 'DONE');
assert.strictEqual(der({ sharepoint_skipped_reason: 'never mirrored' }), 'SKIPPED');
assert.strictEqual(der({ sharepoint_skipped_reason: '' }), 'SKIPPED');  // '' IS NOT NULL, matches SQL
assert.strictEqual(der({ sharepoint_backup_attempts: 8 }), 'DEAD');
assert.strictEqual(der({ sharepoint_backup_attempts: 3 }), 'FAILED');
assert.strictEqual(der({ sharepoint_backup_attempts: 0 }), 'PENDING');
assert.strictEqual(der({}), 'PENDING');
// precedence: DONE beats skipped/attempts; skipped beats attempts
assert.strictEqual(der({ sharepoint_backed_up_at: new Date(), sharepoint_backup_attempts: 8 }), 'DONE');
assert.strictEqual(der({ sharepoint_skipped_reason: 'x', sharepoint_backup_attempts: 8 }), 'SKIPPED');
assert.strictEqual(S.deriveStatus({ sharepoint_backup_attempts: 8 }).deadReason, 'transient_exhausted');
ok('deriveStatus: matches the migration backfill CASE, precedence DONE > SKIPPED > DEAD > FAILED > PENDING');

console.log(`\nAll ${n} sp-mirror-state checks passed.`);
process.exit(0);
