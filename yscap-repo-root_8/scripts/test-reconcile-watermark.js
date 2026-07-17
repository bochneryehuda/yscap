/* WO-4 (F-M7 / F-H4) — the durable reconcile "bookmark".
 *
 * The reconcile watermark lived only in process memory (reset to 0 on every
 * restart), so each of the day's 13 deploys re-scanned the last 24h of ClickUp
 * tasks — a portfolio-wide re-ingest storm on every boot. And it advanced to
 * now() at the END of the pass, so a task updated DURING the pass, or a task
 * whose ingest threw, was skipped forever. The fix persists the bookmark and
 * moves it forward ONLY on a fully-successful pass, captured BEFORE the query,
 * with a small overlap and a 72h catch-up clamp.
 *
 * Verifies, with no DB / no network, the two pure helpers the fix is built on.
 * Run: node scripts/test-reconcile-watermark.js */
const sync = require('../src/sync/clickup-sync');

let pass = 0, fail = 0;
const eq = (name, got, exp) => {
  const g = JSON.stringify(got), e = JSON.stringify(exp);
  if (g === e) { pass++; } else { fail++; console.log(`FAIL ${name}: got ${g} expected ${e}`); }
};
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

const NOW = 1_800_000_000_000;       // a fixed "now" so the test is deterministic
const H = 3600 * 1000, DAY = 24 * H;

// ---- reconcileSince: where the next scan starts ----------------------------
// No bookmark yet → default 24h lookback (not the whole history).
eq('no bookmark → 24h lookback', sync.reconcileSince({ persisted: 0, preQueryMs: NOW }), NOW - DAY);
eq('null bookmark → 24h lookback', sync.reconcileSince({ persisted: null, preQueryMs: NOW }), NOW - DAY);
// A recent bookmark is used verbatim → a restart RESUMES, no 24h re-scan storm.
eq('recent bookmark resumes exactly', sync.reconcileSince({ persisted: NOW - 10 * 60 * 1000, preQueryMs: NOW }), NOW - 10 * 60 * 1000);
// A very old bookmark (long outage) is clamped to a 72h catch-up, not a
// month-long scan that would hammer ClickUp.
eq('ancient bookmark clamped to 72h', sync.reconcileSince({ persisted: NOW - 30 * DAY, preQueryMs: NOW }), NOW - 72 * H);
ok('since is never in the future', sync.reconcileSince({ persisted: NOW + DAY, preQueryMs: NOW }) <= NOW);

// ---- nextWatermark: the bookmark to persist after a pass -------------------
// Clean pass → advance to just-before-this-pass, minus a 2-min overlap so a task
// updated on the boundary is re-covered (re-ingest is idempotent).
eq('clean pass advances to preQuery - 2min overlap',
  sync.nextWatermark({ preQueryMs: NOW, hadFailure: false, current: NOW - DAY }), NOW - 2 * 60 * 1000);
// The advance uses the PRE-query time, never end-of-pass — so a task updated
// while the pass was running is caught next time, not skipped.
ok('advance ceiling is the pre-query time (mid-pass updates not skipped)',
  sync.nextWatermark({ preQueryMs: NOW, hadFailure: false, current: 0 }) < NOW);
// Any failure in the pass → do NOT advance; keep the old bookmark so the task
// that choked is re-covered next time (the F-M7 fix).
eq('failed pass keeps the old bookmark',
  sync.nextWatermark({ preQueryMs: NOW, hadFailure: true, current: NOW - DAY }), NOW - DAY);
eq('failed pass with no prior bookmark stays 0 (re-scan default next time)',
  sync.nextWatermark({ preQueryMs: NOW, hadFailure: true, current: 0 }), 0);

// ---- the round trip: a clean pass then a resume ----------------------------
{
  const after = sync.nextWatermark({ preQueryMs: NOW, hadFailure: false, current: 0 });
  const resumeSince = sync.reconcileSince({ persisted: after, preQueryMs: NOW + 5 * 60 * 1000 });
  ok('a restart resumes near the last pass, not 24h back', resumeSince >= NOW - 5 * 60 * 1000);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
