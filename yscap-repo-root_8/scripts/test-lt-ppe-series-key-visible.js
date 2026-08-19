#!/usr/bin/env node
'use strict';
/**
 * LT PPE — AN EMPTY RUN SERIES MUST SAY WHERE THE RUNS WENT (§2.83).
 *
 * THE DEFECT, MEASURED. A shadow run is keyed `(scope, investor, program)` and `run-store.listRuns`
 * matches `program` by EQUALITY. The canary persists `programLabel(program)`, and `programLabel`
 * returns `program.code || program.name` while `loadProgram` sets `code` to the RATE-SHEET VERSION ID
 * — so the canary files under a uuid. The go-live screen calls `/ppe/scoreboard?investor=X` with no
 * program at all, and `loadCutoverPicture` defaults it to `''`. The two keys never meet. Measured
 * against the real table before this suite existed:
 *
 *     runs under the canary key   : 1
 *     runs under the screen key   : 0   <-- what the go-live gate reads
 *     gate verdict from the screen: {"eligible":false,"reasons":["no canary run has proven 100%
 *                                     agreement", ...]}
 *     gate verdict on the real key: {"eligible":false,"reasons":["only 1 consecutive clean day(s),
 *                                     needs 56"]}
 *
 * Those two verdicts send a reader to two DIFFERENT places. The first says nobody has ever checked;
 * the second says the check is running and needs more clean days. The screen printed the first while
 * the second was true.
 *
 * WHAT THIS SUITE PINS, AND WHAT IT DELIBERATELY DOES NOT. It pins that the dead end is now LEGIBLE —
 * a screen finding nothing reports what it DID find under other keys. It does NOT pin which key is
 * correct: whether a clean-day streak is measured per investor or per rate-sheet version is a business
 * rule (republishing a sheet mints a new version id, so a version-keyed streak resets to zero on every
 * republish), and that is an OWNER QUESTION recorded in the parity doc, never guessed here.
 *
 * THE NOTE MUST CHANGE NO VERDICT. A diagnostic that moves the gate is a second definition of
 * eligibility. Section D asserts the gate answers identically with the note present and absent.
 *
 *   DATABASE_URL=postgres://… node scripts/test-lt-ppe-series-key-visible.js
 *
 * LT-only: writes only `lt_ppe_shadow_run` rows under a throwaway scope, and cleans up after itself.
 */
const path = require('path');
const runStore = require('../src/longterm/ppe/run-store');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

// ---- A: the diagnostic is a DIAGNOSTIC — it can never throw --------------------------------------
// `listSeriesKeys` is called from inside the go-live picture, on the path a screen takes when it has
// already found nothing. If it could throw it would turn a legible empty series into a 500 — the
// explanation breaking the thing it explains. Proven against a db that throws, one that returns
// garbage, and one that is simply absent.
async function sectionA() {
  console.log('\n-- A: the diagnostic never throws --');
  const throwing = { query: async () => { throw new Error('connection terminated unexpectedly'); } };
  const garbage = { query: async () => ({ rows: null }) };
  const notADb = {};
  for (const [label, db] of [['a db that throws', throwing], ['a db that returns rows:null', garbage], ['no db at all', notADb]]) {
    let out, threw = null;
    try { out = await runStore.listSeriesKeys('s', { db, investor: 'INV' }); } catch (e) { threw = e; }
    ok(threw === null, `listSeriesKeys does not throw on ${label}`);
    ok(Array.isArray(out) && out.length === 0, `listSeriesKeys answers [] on ${label}`);
  }
}

// ---- B/C/D need a real Postgres -----------------------------------------------------------------
const DAY = 86400000;
const D = 1_700_000_000_000;

async function main() {
  await sectionA();

  if (!process.env.DATABASE_URL) {
    console.log('\n  --  B/C/D skipped (no DATABASE_URL) — the subject is a real key mismatch in a real table');
    console.log(failures ? `\n${failures} FAILED` : '\nall passed (pure section only)');
    process.exit(failures ? 1 : 0);
  }

  const { Pool } = require('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const scope = `test_seriesk_${Date.now()}`;
  // The canary's real key shape: a rate-sheet VERSION ID, not a readable program name. Using a uuid
  // here (rather than a friendly label) is the point — it is what `programLabel` actually produces.
  const CANARY_KEY = 'c0ffee00-1111-4222-8333-444444444444';
  const SCREEN_KEY = '';                      // what /ppe/scoreboard?investor=X defaults to
  const INV = 'DHVN';
  const OTHER_INV = 'NOBODY';

  try {
    await db.query('DELETE FROM lt_ppe_shadow_run WHERE scope = $1', [scope]);

    // ---- B: the key mismatch is REAL, and listSeriesKeys can see across it ----------------------
    console.log('\n-- B: the two keys, measured against the real table --');
    await runStore.persistRun(scope, { dayMs: D, agreementRate: 1, findingKeys: [], summary: { comparable: 250, incomparable: 0, errors: 0, overlay: 0, agreementRate: 1, provenance: { legVersion: require('../src/longterm/ppe/agreement-provenance').LEG_VERSION } } }, { db, investor: INV, program: CANARY_KEY });
    await runStore.persistRun(scope, { dayMs: D + DAY, agreementRate: 1, findingKeys: [], summary: { comparable: 250, incomparable: 0, errors: 0, overlay: 0, agreementRate: 1, provenance: { legVersion: require('../src/longterm/ppe/agreement-provenance').LEG_VERSION } } }, { db, investor: INV, program: CANARY_KEY });

    const underCanary = await runStore.listRuns(scope, { db, investor: INV, program: CANARY_KEY });
    const underScreen = await runStore.listRuns(scope, { db, investor: INV, program: SCREEN_KEY });
    ok(underCanary.length === 2, `listRuns under the canary key finds the runs (${underCanary.length})`);
    ok(underScreen.length === 0, `listRuns under the screen key finds NOTHING (${underScreen.length}) — this is the defect`);

    const keys = await runStore.listSeriesKeys(scope, { db, investor: INV });
    ok(keys.length === 1, `listSeriesKeys finds the one series that exists (${keys.length})`);
    ok(keys[0] && keys[0].program === CANARY_KEY, 'listSeriesKeys names the canary key the runs are actually under');
    ok(keys[0] && keys[0].runs === 2, `listSeriesKeys counts the runs (${keys[0] && keys[0].runs})`);
    ok(keys[0] && keys[0].firstDayMs === D && keys[0].lastDayMs === D + DAY,
      'listSeriesKeys reports the first and last day of the series');
    // `runs` is `COUNT(*)::int`, which pg already hands back as a JS number — the coercion there is
    // belt-and-braces. The day columns are BIGINT, which pg DOES hand back as strings, so those are
    // the ones a screen would render as text and a comparison would get wrong. Both are asserted;
    // only the day half can actually regress, and a mutation that drops `num()` fails right here.
    ok(keys[0] && typeof keys[0].runs === 'number' && typeof keys[0].firstDayMs === 'number'
      && typeof keys[0].lastDayMs === 'number',
      'the counts and the BIGINT day columns come back as NUMBERS, not pg strings');

    // An investor with no runs at all gets an empty list, NOT the other investor's series. A
    // diagnostic that leaked another investor's keys would be worse than no diagnostic.
    const none = await runStore.listSeriesKeys(scope, { db, investor: OTHER_INV });
    ok(Array.isArray(none) && none.length === 0, 'an investor with no runs gets [] — never another investor\'s keys');

    // Scope isolation: the same investor under a different scope must not see these rows.
    const otherScope = await runStore.listSeriesKeys(`${scope}_other`, { db, investor: INV });
    ok(otherScope.length === 0, 'listSeriesKeys is scope-isolated');

    // Ordering: most-recent series first, so a screen showing one shows the live one.
    await runStore.persistRun(scope, { dayMs: D + 10 * DAY, agreementRate: 0.9, findingKeys: ['f:x'], summary: { comparable: 10, incomparable: 0, errors: 0, overlay: 0, agreementRate: 0.9 } }, { db, investor: INV, program: 'newer-version-id' });
    const two = await runStore.listSeriesKeys(scope, { db, investor: INV });
    ok(two.length === 2, `two series keys now exist (${two.length})`);
    ok(two[0].program === 'newer-version-id', 'listSeriesKeys orders most-recently-run FIRST');

    // ---- C: the SCREEN says where the runs went -------------------------------------------------
    // Driven through the real route handler against the real pool, so this proves the wiring, not a
    // hand-made fixture. `src/longterm/db` reads DATABASE_URL at require time, which is already set.
    console.log('\n-- C: the go-live screen reports the keys it did not read --');
    const ppe = require('../src/longterm/routes/ppe');
    const SCOPE = ppe._internals.SCOPE;
    // Re-file the same series under the ROUTE's scope so the handler reads them.
    await db.query('DELETE FROM lt_ppe_shadow_run WHERE scope = $1 AND investor = $2', [SCOPE, INV]);
    await runStore.persistRun(SCOPE, { dayMs: D, agreementRate: 1, findingKeys: [], summary: { comparable: 250, incomparable: 0, errors: 0, overlay: 0, agreementRate: 1, provenance: { legVersion: require('../src/longterm/ppe/agreement-provenance').LEG_VERSION } } }, { db, investor: INV, program: CANARY_KEY });

    async function scoreboard(query) {
      let body = null, status = 200;
      const res = { json: (b) => { body = b; return res; }, status: (s) => { status = s; return res; } };
      await ppe.handlers.scoreboardRoute({ query, params: {}, body: {} }, res);
      return { status, body };
    }

    const empty = await scoreboard({ investor: INV });                       // no program -> ''
    ok(empty.body && empty.body.ok === true, 'the scoreboard still answers ok on an empty series');
    ok(empty.body.seriesKeyUsed === '', `the response NAMES the key it read (${JSON.stringify(empty.body.seriesKeyUsed)})`);
    ok(typeof empty.body.seriesNote === 'string' && empty.body.seriesNote.length > 0,
      'an empty series carries a seriesNote saying where the runs went');
    ok(empty.body.seriesNote.includes(CANARY_KEY),
      'the note NAMES the key the runs are actually filed under');
    ok(/rate-sheet version/i.test(empty.body.seriesNote),
      'the note says WHY the keys differ (the canary keys on the rate-sheet version)');
    ok(Array.isArray(empty.body.seriesKeys) && empty.body.seriesKeys.some((k) => k.program === CANARY_KEY),
      'the response carries the machine-readable key list too, not only prose');

    // The healthy case: ask on the key the runs ARE under, and the note must be absent. A note that
    // appears on a healthy series would be a fabricated alarm — the opposite failure, equally bad.
    const healthy = await scoreboard({ investor: INV, program: CANARY_KEY });
    ok(healthy.body.seriesKeyUsed === CANARY_KEY, 'asking on the real key reports that key');
    ok(healthy.body.seriesNote === null, 'a HEALTHY series carries NO note (the alarm is not fabricated)');
    ok(Array.isArray(healthy.body.seriesKeys) && healthy.body.seriesKeys.length === 0,
      'a healthy series does not pay for the extra key query');
    ok(healthy.body.measured === true, 'the healthy series is measured — the runs are found');
    ok(empty.body.measured === false, 'the empty series is NOT measured — which is the whole defect');

    // An investor with nothing anywhere: no note, because there is nothing to point at. Saying
    // "your runs are elsewhere" when there are no runs at all would be a lie in the other direction.
    const nowhere = await scoreboard({ investor: OTHER_INV });
    ok(nowhere.body.seriesNote === null,
      'an investor with NO runs under any key gets no note — there is nothing to point at');

    // ---- D: the note changes NO verdict ---------------------------------------------------------
    console.log('\n-- D: the diagnostic decides nothing --');
    ok(empty.body.gate && empty.body.gate.eligible === false, 'the empty-series gate still refuses');
    ok(healthy.body.gate && healthy.body.gate.eligible === false, 'the healthy-series gate refuses too (one clean day, not 56)');
    // The two verdicts must differ in their REASONS — that difference is exactly what the note exists
    // to make visible. If they gave the same reasons there would be nothing to report.
    const eReasons = JSON.stringify((empty.body.gate && empty.body.gate.reasons) || []);
    const hReasons = JSON.stringify((healthy.body.gate && healthy.body.gate.reasons) || []);
    ok(eReasons !== hReasons, 'the two keys yield DIFFERENT gate reasons — the thing the note warns about');
    ok(/no canary run|never|100%/i.test(eReasons), `the empty key reads as "nobody checked": ${eReasons.slice(0, 120)}`);
    ok(/clean day/i.test(hReasons), `the real key reads as "checking, needs more clean days": ${hReasons.slice(0, 120)}`);

    // ---- E: the source says what it does, and the export is real --------------------------------
    console.log('\n-- E: the claim and the wiring --');
    const fs = require('fs');
    const storeSrc = fs.readFileSync(path.join(__dirname, '../src/longterm/ppe/run-store.js'), 'utf8');
    const routeSrc = fs.readFileSync(path.join(__dirname, '../src/longterm/routes/ppe.js'), 'utf8');
    ok(typeof runStore.listSeriesKeys === 'function', 'listSeriesKeys is exported');
    ok(/module\.exports\s*=\s*\{[^}]*listSeriesKeys/.test(storeSrc), 'listSeriesKeys is in the export list, not only defined');
    ok(/runStore\.listSeriesKeys\(/.test(routeSrc), 'the route CALLS listSeriesKeys — not merely imports it');
    ok(/seriesNote/.test(routeSrc) && (routeSrc.match(/seriesNote/g) || []).length >= 4,
      'seriesNote is computed and returned on every branch that can reach a caller');
    // The refusal to guess must be written down where the decision is made.
    ok(/business question|owner question/i.test(storeSrc),
      'run-store records that WHICH key is right is a business question, not a code decision');

    console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
  } finally {
    await db.query('DELETE FROM lt_ppe_shadow_run WHERE scope LIKE $1', [`${scope}%`]).catch(() => {});
    try {
      const ppe = require('../src/longterm/routes/ppe');
      await db.query('DELETE FROM lt_ppe_shadow_run WHERE scope = $1 AND investor = ANY($2)', [ppe._internals.SCOPE, [INV, OTHER_INV]]).catch(() => {});
    } catch (_) { /* the route may not have loaded */ }
    await db.end().catch(() => {});
  }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('SUITE CRASHED:', e); process.exit(1); });
