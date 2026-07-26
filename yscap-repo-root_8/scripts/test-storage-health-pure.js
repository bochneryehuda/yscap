'use strict';
/**
 * Storage health card (src/lib/storage-health.js) — owner-directed 2026-07-26, after the R2 cutover.
 * Pure: no network, no DB, no real bucket.
 *
 * Proves the card answers the question the flat storage* fields could NOT: "is the bucket actually
 * reachable", and that it can never break or hang /api/health:
 *   - a configured + reachable S3/R2 bucket reads healthy, with the dual-read migration flag on
 *   - a configured but UNREACHABLE bucket (revoked token) is reported false, with a reason
 *   - the local disk reports reachable:null (nothing remote to reach) — never a fake "reachable"
 *   - a throwing probe()/ping() degrades instead of propagating
 *   - a hanging ping() is abandoned at the timeout (health never blocks)
 */
const R = require('path').resolve(__dirname, '..');
const SH = require(R + '/src/lib/storage-health');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

(async function main() {
  // ---------- buildStorageCard (PURE) ----------
  const s3Probe = { ok: true, base: 's3://pilot-documents', configured: true, persistent: true, error: null };

  const healthy = SH.buildStorageCard({ provider: 's3', probe: s3Probe, ping: { ok: true, reason: 'reachable (HTTP 404)' } });
  ok(healthy.provider === 's3', 's3: provider surfaced');
  ok(healthy.configured === true && healthy.writable === true, 's3: configured + writable');
  ok(healthy.persistent === true, 's3: object storage reports persistent');
  ok(healthy.reachable === true, 's3 reachable: live ping success → reachable true');
  ok(healthy.base === 's3://pilot-documents', 's3: bucket base surfaced');
  ok(healthy.dualReadFallback === true, 's3: dual-read migration fallback flagged');

  // The case the old health output could not express: settings look right, bucket does NOT answer.
  const revoked = SH.buildStorageCard({
    provider: 's3', probe: s3Probe,
    ping: { ok: false, reason: 'credentials rejected (HTTP 403) — check the R2 token + bucket scope' },
  });
  ok(revoked.configured === true, 'revoked token: still reports configured (the settings ARE present)');
  ok(revoked.reachable === false, 'revoked token: reachable false — the real signal');
  ok(/403/.test(revoked.reason || ''), 'revoked token: the reason explains why');

  // A configured-but-unreachable store must always carry SOME reason, even if ping gave none.
  const noReason = SH.buildStorageCard({ provider: 's3', probe: s3Probe, ping: { ok: false } });
  ok(noReason.reachable === false && !!noReason.reason, 'unreachable with no ping reason → a reason is still supplied');

  // Local disk: there is nothing remote to reach — must be null, never a fabricated true.
  const localCard = SH.buildStorageCard({
    provider: 'local',
    probe: { ok: true, base: '/var/data/uploads', persistent: true },
    ping: null,
  });
  ok(localCard.reachable === null, 'local: reachable null (no remote endpoint) — never fabricated');
  ok(localCard.dualReadFallback === false, 'local: no dual-read fallback');
  ok(localCard.configured === true, 'local: configured falls back to writability (no `configured` field)');
  ok(/local disk/i.test(localCard.reason || ''), 'local: reason explains why there is no reachability check');

  // An unconfigured S3 (vars missing) must not claim to be writable.
  const unconfigured = SH.buildStorageCard({
    provider: 's3',
    probe: { ok: false, base: null, configured: false, persistent: false, error: 's3 not configured' },
    ping: { ok: false, reason: 's3 not configured' },
  });
  ok(unconfigured.configured === false && unconfigured.writable === false, 'unconfigured s3: not configured, not writable');

  // Garbage in → a shaped card out (never a throw).
  const junk = SH.buildStorageCard({ provider: 's3', probe: null, ping: undefined });
  ok(junk && junk.provider === 's3' && junk.reachable === null, 'null probe → shaped card, no throw');
  const empty = SH.buildStorageCard();
  ok(empty && typeof empty === 'object' && empty.provider === 'local', 'no args → defaults, no throw');

  // ---------- readStorageHealth (async, bounded) ----------
  const fakeS3 = {
    probe: () => s3Probe,
    ping: async () => ({ ok: true, reason: 'reachable (HTTP 404)' }),
  };
  const live = await SH.readStorageHealth(fakeS3, 's3');
  ok(live.reachable === true && live.provider === 's3', 'readStorageHealth: calls ping() and reports it');

  // A provider with NO ping() (the local disk) must not invent a reachability answer.
  const noPing = await SH.readStorageHealth({ probe: () => ({ ok: true, base: '/var/data/uploads', persistent: true }) }, 'local');
  ok(noPing.reachable === null, 'readStorageHealth: no ping() → reachable stays null');

  // A THROWING probe must degrade, not propagate.
  const throwProbe = await SH.readStorageHealth({ probe: () => { throw new Error('disk exploded'); } }, 'local');
  ok(throwProbe && throwProbe.writable === false, 'readStorageHealth: throwing probe() → degraded card, no throw');

  // A THROWING ping must degrade to unreachable with a reason.
  const throwPing = await SH.readStorageHealth({
    probe: () => s3Probe,
    ping: async () => { throw new Error('socket hang up'); },
  }, 's3');
  ok(throwPing.reachable === false && /hang up/.test(throwPing.reason || ''), 'readStorageHealth: throwing ping() → reachable false + reason');

  // A HANGING ping must be abandoned at the timeout — /api/health can never block on storage.
  const t0 = Date.now();
  const hung = await SH.readStorageHealth({
    probe: () => s3Probe,
    ping: () => new Promise(() => {}),        // never resolves
  }, 's3', { timeoutMs: 120 });
  const elapsed = Date.now() - t0;
  ok(hung.reachable === false, 'hanging ping: reachable false (fails honest, not stuck)');
  ok(/no answer within/i.test(hung.reason || ''), 'hanging ping: reason names the timeout');
  ok(elapsed < 2000, `hanging ping: abandoned quickly (took ${elapsed}ms) — health never blocks`);

  console.log(`test-storage-health-pure: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
