#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the CUTOVER DOOR (§11 / P10), against a REAL Postgres.
 *
 * WHAT THIS DOOR IS FOR. `cutover.js` (the pure lifecycle + the go-live gate), `cutover-ledger.js`
 * (the append-only history) and `cutover-store.js` (its durable bridge, db/566) were built, unit
 * tested and reachable by NOTHING — both of the latter two sat in `docs/longterm/LT-UNREACHED.md`
 * waiting on one thing: *"the promote-to-live route (P10) — owner-gated on who may promote."* The
 * owner answered on 2026-08-18 (*"all in the super admin"*), so the door exists. Each of those three
 * modules has its own suite; what is proven HERE is only what they cannot see — the route's promises,
 * every one of which is a way an unproven investor could end up pricing real loans:
 *
 *   A. THE GATE IS COMPUTED, NEVER ACCEPTED. `cutover.transition` promotes only when it is handed
 *      `eligible === true`, so a body field of that name would be the whole ≥200-scenario bar
 *      bypassed by one JSON key. The request's opinion must be ignored entirely.
 *   B. AN UNMET BAR IS A REFUSAL THAT NAMES ITSELF, and writes nothing.
 *   C. A REAL MOVE IS RECORDED, ATTRIBUTED TO THE SESSION, and the mode changes.
 *   D. ROLLBACK IS ALWAYS AVAILABLE — the way out is never harder than the way in.
 *   E. THE MODE IS ACTUALLY READ. A promotion that no pricing path consults is a ledger disagreeing
 *      with the engine in silence, which is worse than no promotion at all.
 *
 *   DATABASE_URL=postgres://… node scripts/test-lt-ppe-cutover-route-db.js
 *
 * LT-only. No RTL imports beyond the shared identity zone (`src/db` for staff_users).
 */
if (!process.env.DATABASE_URL) {
  console.log('SKIP test-lt-ppe-cutover-route-db (no DATABASE_URL)');
  process.exit(0);
}

const fs = require('fs');
const path = require('path');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

function stubRes() {
  const r = { statusCode: 200, body: null, headersSent: false };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; r.headersSent = true; return r; };
  return r;
}
const call = async (fn, req) => {
  const res = stubRes();
  try { await fn(req, res); } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: String((e && e.message) || e), threw: true });
  }
  return res;
};
const REQ = (over = {}) => Object.assign({ params: {}, body: {}, query: {}, actor: { id: null } }, over);

(async () => {
  const route = require('../src/longterm/routes/ppe');
  const H = route.handlers;
  const I = route._internals;
  const cutover = require('../src/longterm/ppe/cutover');
  const cutoverStore = require('../src/longterm/ppe/cutover-store');
  const runStore = require('../src/longterm/ppe/run-store');
  const ltDb = require('../src/longterm/db');
  const idDb = require('../src/db');

  const SCOPE = I.SCOPE;
  const stamp = `C${process.pid}${Date.now() % 100000}`;
  const INVESTOR = `ZZCUT${stamp}`.slice(0, 40);
  const email = `cut.${stamp}@ys.test`;

  let staffId = null;
  const cleanup = async () => {
    await ltDb.query('DELETE FROM lt_ppe_cutover_ledger WHERE scope = $1 AND investor = $2', [SCOPE, INVESTOR]).catch(() => {});
    await ltDb.query('DELETE FROM lt_ppe_shadow_run WHERE scope = $1 AND investor = $2', [SCOPE, INVESTOR]).catch(() => {});
    await idDb.query('DELETE FROM staff_users WHERE email = $1', [email]).catch(() => {});
  };

  const modeNow = () => cutoverStore.currentMode(SCOPE, { db: ltDb, investor: INVESTOR });
  const historyLen = async () => (await cutoverStore.listHistory(SCOPE, { db: ltDb, investor: INVESTOR })).length;

  // A clean run of the canary, recorded for enough days in a row to satisfy the gate. The gate's own
  // thresholds are read out of the pure module rather than retyped — a test that hard-codes the bar
  // is a second copy of the policy and would pass a day after somebody moved it.
  const DAY = cutover.DAY_MS;
  const seedCleanDays = async (n, nowMs) => {
    for (let i = 0; i < n; i += 1) {
      await runStore.persistRun(
        SCOPE,
        {
          dayMs: nowMs - (i * DAY),
          agreementRate: 1,
          findingKeys: [],
          // `comparable` and `incomparable` are what the gate actually reads (§10.5/§10.6): a battery
          // that compared nothing is never proof of agreement, whatever its rate says.
          summary: { total: 300, comparable: 300, agreed: 300, disagreed: 0, incomparable: 0 },
        },
        { db: ltDb, investor: INVESTOR, program: '' },
      );
    }
  };

  try {
    for (const f of ['558_lt_ppe_foundation.sql', '561_lt_ppe_finding.sql',
      '565_lt_ppe_shadow_run.sql', '566_lt_ppe_cutover_ledger.sql']) {
      await ltDb.query(fs.readFileSync(path.join(__dirname, '..', 'db', f), 'utf8'));
    }
    await cleanup();

    const made = await idDb.query(
      `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1, 'Cutover Super', 'super_admin', true) RETURNING id`,
      [email]);
    staffId = made.rows[0].id;
    const ACTOR = { id: staffId, role: 'super_admin' };

    // =========================================================================
    console.log('\nA. the door refuses what it cannot identify, and writes nothing\n');
    // =========================================================================

    let res = await call(H.cutoverDecisionRoute, REQ({ actor: ACTOR, body: { action: 'activate', reason: 'starting the shadow' } }));
    ok(res.statusCode === 400 && /investor/i.test(res.body.error || ''),
      'A1 no investor is refused — an omitted one would move the whole company, not the one somebody meant');

    res = await call(H.cutoverDecisionRoute, REQ({ actor: ACTOR, body: { investor: INVESTOR, reason: 'starting the shadow' } }));
    ok(res.statusCode === 400 && /action/i.test(res.body.error || ''), 'A2 no action is refused');

    res = await call(H.cutoverDecisionRoute, REQ({ actor: ACTOR, body: { investor: INVESTOR, action: 'activate', reason: 'ok' } }));
    ok(res.statusCode === 400 && /8 characters/.test(res.body.error || ''),
      'A3 a two-letter reason is refused — this ledger is append-only, so the note is the whole record of why');

    res = await call(H.cutoverDecisionRoute, REQ({ actor: { id: null }, body: { investor: INVESTOR, action: 'activate', reason: 'starting the shadow' } }));
    ok(res.statusCode === 401, 'A4 a decision with nobody signed in is refused — a trail with no author is not a trail');

    ok(await historyLen() === 0, 'A5 …and after all four refusals the ledger is still empty');

    // =========================================================================
    console.log('\nB. THE ONE THAT MATTERS: eligibility is computed, never accepted\n');
    // =========================================================================

    res = await call(H.cutoverDecisionRoute, REQ({ actor: ACTOR, body: { investor: INVESTOR, action: 'activate', reason: 'begin shadowing this investor' } }));
    ok(res.statusCode === 200 && res.body.mode === 'shadow', 'B1 draft → shadow is recorded');

    // Nothing has been measured for this investor, so the gate cannot pass. The body SHOUTS that it
    // is eligible; the door must not hear it.
    res = await call(H.cutoverDecisionRoute, REQ({
      actor: ACTOR,
      body: { investor: INVESTOR, action: 'promote', reason: 'taking this investor live now', eligible: true, gate: { eligible: true } },
    }));
    ok(res.statusCode === 409 && res.body.reason === 'gate_not_met',
      'B2 a request that ASSERTS its own eligibility is refused anyway — the bar is a measurement, not a claim');
    ok(Array.isArray(res.body.blockers) && res.body.blockers.length > 0,
      `B3 …and the refusal NAMES every gate that failed (${(res.body.blockers || []).length})`);
    ok(await modeNow() === 'shadow' && await historyLen() === 1,
      'B4 …and nothing was written — a refused promotion leaves no trace of having nearly happened');

    // =========================================================================
    console.log('\nC. a measured investor promotes, and the record says who and why\n');
    // =========================================================================

    const nowMs = Date.now();
    // §2.73: the route reads the CONFIGURED clean-week setting (weeks x7), not a hard-coded 14 days —
    // so the streak is seeded from the gate's own numbers rather than a literal, and a run one day
    // short is seeded FIRST to prove the door really is enforcing the configured length end to end.
    const GATE = cutover.settingsToGate({});
    await seedCleanDays(GATE.minCleanDays - 1, nowMs);

    res = await call(H.cutoverStateRoute, REQ({ actor: ACTOR, query: { investor: INVESTOR } }));
    ok(res.statusCode === 200 && res.body.gate && res.body.gate.eligible === false
      && (res.body.gate.reasons || []).some((r) => /consecutive clean day/.test(r)),
      `C0 one day short of the CONFIGURED streak is refused by the real route — the setting is wired, not decorative (${JSON.stringify((res.body.gate || {}).reasons || [])})`);
    ok(res.body.thresholds && res.body.thresholds.settingKey === cutover.SETTING_CLEAN_WEEKS,
      'C0b …and the door publishes WHICH setting it is running, so the number on screen is the number enforced');

    // ⛔ AND THE DIAL IS PROVEN THROUGH THE REAL DOOR, not just in the pure module. `eligibleForLive`
    // now DEFAULTS to the strict numbers (§2.73), which is deliberate — a caller that forgets the
    // thresholds cannot loosen the gate — but it also means the route's threading is invisible while the
    // setting sits at its default: reverting the threading changes no answer. So the SETTING is changed
    // here and the door must follow it, or "the route reads the settings" would have no test that bites.
    const ppeStore = require('../src/longterm/ppe/store');
    await ppeStore.setSetting(ltDb, SCOPE, cutover.SETTING_CLEAN_WEEKS, 1, null);
    res = await call(H.cutoverStateRoute, REQ({ actor: ACTOR, query: { investor: INVESTOR } }));
    ok(res.statusCode === 200 && res.body.gate && res.body.gate.eligible === true,
      `C0c a super admin lowering the clean-weeks setting to 1 really does let this investor through the REAL door (${JSON.stringify((res.body.gate || {}).reasons || [])})`);
    ok(res.body.thresholds && res.body.thresholds.source && res.body.thresholds.source.cleanWeeksValue === 1,
      'C0d …and the door publishes the number it is actually running, read from that setting');

    await ppeStore.clearSetting(ltDb, SCOPE, cutover.SETTING_CLEAN_WEEKS);
    res = await call(H.cutoverStateRoute, REQ({ actor: ACTOR, query: { investor: INVESTOR } }));
    ok(res.statusCode === 200 && res.body.gate && res.body.gate.eligible === false,
      'C0e …and clearing the override puts the strict default straight back');

    await seedCleanDays(GATE.minCleanDays, nowMs);

    res = await call(H.cutoverStateRoute, REQ({ actor: ACTOR, query: { investor: INVESTOR } }));
    ok(res.statusCode === 200 && res.body.gate && res.body.gate.eligible === true,
      `C1 with a clean measured streak the gate now passes (${JSON.stringify((res.body.gate || {}).reasons || [])})`);
    ok(res.body.integrity && res.body.integrity.ok === true,
      'C2 …and the recorded history replays cleanly from draft — the tamper check is reported, not assumed');

    // The body names a DIFFERENT author on purpose. A governance trail whose author the caller
    // supplies records whoever they say they are, so the forged value must be ignored entirely — an
    // assertion that only checked the session id would pass either way and prove nothing.
    const FORGED = '00000000-0000-0000-0000-000000000000';
    res = await call(H.cutoverDecisionRoute, REQ({
      actor: ACTOR,
      body: { investor: INVESTOR, action: 'promote', reason: 'agreement proven over a clean month', by: FORGED, decidedBy: FORGED },
    }));
    ok(res.statusCode === 200 && res.body.mode === 'live', 'C3 the promotion is accepted');
    ok(res.body.entry && res.body.entry.by === staffId && res.body.entry.by !== FORGED,
      'C4 …recorded against the SESSION, and the author the request tried to supply is ignored');
    ok(res.body.entry && res.body.entry.eligible === true && res.body.entry.scoreboard,
      'C5 …carrying the scoreboard it was decided on, so a year from now the decision is readable');
    ok(await modeNow() === 'live', 'C6 …and the durable mode is LIVE');

    // =========================================================================
    console.log('\nD. the way out is never harder than the way in\n');
    // =========================================================================

    res = await call(H.cutoverDecisionRoute, REQ({
      actor: ACTOR, body: { investor: INVESTOR, action: 'promote', reason: 'promoting it a second time' },
    }));
    ok(res.statusCode === 422 && res.body.reason === 'not_allowed',
      'D1 promoting an already-live investor is refused by the lifecycle itself');

    res = await call(H.cutoverDecisionRoute, REQ({
      actor: ACTOR, body: { investor: INVESTOR, action: 'rollback', reason: 'a price looked wrong this morning' },
    }));
    ok(res.statusCode === 200 && res.body.mode === 'shadow',
      'D2 rollback is always allowed — and needs no gate, which is the point');
    ok(await historyLen() === 3, 'D3 …and every move is kept: the ledger appends, it never rewrites');

    // =========================================================================
    console.log('\nE. the mode is actually READ by the thing that prices\n');
    // =========================================================================

    // The quote route hard-coded `mode: () => 'shadow'`. A promotion nothing consults is a ledger and
    // an engine confidently disagreeing in silence, so this asserts the wiring by SOURCE — the quote
    // route itself needs a live vendor and a published sheet, which a unit test must not reach for.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'routes', 'ppe.js'), 'utf8');
    ok(!/mode:\s*\(\)\s*=>\s*'shadow'/.test(src),
      'E1 the pricing path no longer hard-codes shadow');
    ok(/cutoverStore\.currentMode\(/.test(src) && /mode:\s*\(\)\s*=>\s*cutoverMode/.test(src),
      'E2 …it reads the lifecycle ledger instead');
    ok(/cutoverMode\s*=\s*cutover\.MODES\.SHADOW/.test(src) && /catch \(e\) \{ cutoverModeError/.test(src),
      'E3 …and it FAILS CLOSED: an unreadable ledger keeps Lender Price authoritative, never promotes anybody');

    // The ledger the pricing path consults is the same one the door writes — proven by reading it back
    // through the store the route uses, on the investor the door just moved.
    await call(H.cutoverDecisionRoute, REQ({
      actor: ACTOR, body: { investor: INVESTOR, action: 'promote', reason: 'back live after the check' },
    }));
    ok(await cutoverStore.currentMode(SCOPE, { db: ltDb, investor: INVESTOR }) === cutover.MODES.LIVE,
      'E4 …and what the door wrote is exactly what that read returns');

    // =========================================================================
    console.log('\nF. the read door\n');
    // =========================================================================

    res = await call(H.cutoverStateRoute, REQ({ actor: ACTOR, query: {} }));
    ok(res.statusCode === 400, 'F1 the read door names the investor it needs');

    res = await call(H.cutoverStateRoute, REQ({ actor: ACTOR, query: { investor: INVESTOR } }));
    ok(res.statusCode === 200 && res.body.mode === 'live', 'F2 it reports the mode');
    ok(Array.isArray(res.body.summary && res.body.summary.history) && res.body.summary.history.length === 4,
      `F3 …with the whole history behind it (${((res.body.summary || {}).history || []).length})`);
    ok(res.body.thresholds && Array.isArray(res.body.thresholds.reasonsWhenNothingIsProven)
      && res.body.thresholds.reasonsWhenNothingIsProven.length > 0,
      'F4 …and it STATES the bar it is running, because a number nobody can see is a number nobody can question');
    ok(/never been confirmed by the owner/.test((res.body.thresholds || {}).note || ''),
      'F5 …saying plainly that the clean-day count is an assumption, not settled policy');

    res = await call(H.cutoverStateRoute, REQ({ actor: ACTOR, query: { investor: `${INVESTOR}NOPE` } }));
    ok(res.statusCode === 200 && res.body.mode === 'draft'
      && (res.body.summary.history || []).length === 0,
      'F6 an investor nobody has ever decided about reads as DRAFT with an empty history — never as an error');
  } finally {
    await cleanup();
    if (ltDb.pool && typeof ltDb.pool.end === 'function') await ltDb.pool.end().catch(() => {});
    if (idDb.pool && typeof idDb.pool.end === 'function') await idDb.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures} FAILED` : '\nok - lt ppe cutover door (all passed)');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
