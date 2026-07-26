/**
 * Manual Program + program-scoped flood certificate (owner-directed 2026-07-20).
 *
 * Pure logic (no DB):
 *   - a structural override (LTV/LTC/ARV) is a MANUAL PRODUCT; markup/points/
 *     fees/rate alone are NOT.
 *   - resolveProgram forces 'manual' on a structural override, keeps std/gold
 *     otherwise.
 *   - the Standard engine prices a 'manual' quote labeled "Manual Program".
 *   - the flood rule fires for gold/manual/flood-zone AND for a Blue Lake /
 *     CorrFirst note buyer, NOT plain standard with no note buyer.
 *   - liquidity months honor the manual program's entered asset_months.
 *
 * DB-backed (requires DATABASE_URL with migrations applied; skips otherwise):
 *   - the flood-certificate condition attaches to a Gold/Manual file and to a
 *     Standard file that sits in a flood zone, and retracts (untouched) from a
 *     Standard file that is not in a flood zone.
 *   - the escalation queue round-trips (open → pending → decide).
 *   - the manual-program settings save/load + required asset-months validation.
 */

const mp = require('../src/lib/manual-program');
const pricing = require('../src/lib/pricing');
const rules = require('../src/lib/conditions/rules');
const liq = require('../src/lib/liquidity');
const reg = require('../src/lib/conditions/field-registry');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// ---------------- pure logic ----------------
assert(mp.isManualProduct({ ovrLTCPct: 70 }) === true, 'LTC override => manual product');
assert(mp.isManualProduct({ ovrAcqLTVPct: 80 }) === true, 'acquisition LTV override => manual product');
assert(mp.isManualProduct({ ovrARLTVPct: 75 }) === true, 'after-repair LTV override => manual product');
assert(mp.isManualProduct({ markupStdPct: 1.5 }) === false, 'markup only => NOT a manual product');
assert(mp.isManualProduct({ ovrRatePct: 11, manualPricing: true }) === false, 'rate/force-price only => NOT a manual product');
assert(mp.isManualProduct({ ovrLTCPct: null, ovrAcqLTVPct: '' }) === false, 'empty structural knobs => NOT a manual product');
assert(mp.resolveProgram('gold', { ovrLTCPct: 70 }) === 'manual', 'gold card + structural override => manual');
assert(mp.resolveProgram('standard', { ovrAcqLTVPct: 90 }) === 'manual', 'standard card + structural override => manual');
assert(mp.resolveProgram('gold', { markupGoldPct: 1 }) === 'gold', 'gold + markup-only stays gold');
assert(mp.resolveProgram('standard', {}) === 'standard', 'standard plain stays standard');

assert(pricing.PROGRAM_LABEL.manual === 'Manual Program', 'PROGRAM_LABEL.manual = "Manual Program"');
if (pricing.enginesReady()) {
  const app = { purchase_price: 200000, as_is_value: 200000, arv: 300000, rehab_budget: 50000,
    program: 'Fix & Flip', loan_type: 'Purchase', property_type: 'SFR', units: 1, fico: 720, term: '12',
    property_address: { state: 'NJ' } };
  const inp = pricing.buildInputs(app, { flips: 3, holds: 0, ground: 0 }, { ovrLTCPct: 70, manualPricing: true });
  const q = pricing.quoteProgram('manual', inp);
  assert(q.program === 'manual' && q.programLabel === 'Manual Program', 'quoteProgram(manual) is tagged + labeled manual');
  assert(q.sizing && q.sizing.totalLoan > 0, 'manual product sizes a loan on the Standard engine');
} else {
  console.log('note: pricing engines not loaded — skipping manual quote assertion');
}

const fields = reg.BY_KEY;
// Mirror of the real rtl_cond_flood rule (db/207 + db/281): flood cert required
// for Gold/Manual, OR a known flood zone, OR a Blue Lake / CorrFirst note buyer.
const FLOOD_RULE = { combinator: 'or', rules: [
  { field: 'registered_program', operator: 'in', value: ['gold', 'manual'] },
  { field: 'in_flood_zone', operator: 'is_true' },
  { field: 'note_buyer', operator: 'in', value: ['bluelake', 'corrfirst'] },
] };
assert(rules.evaluateRule(FLOOD_RULE, { registered_program: 'standard', in_flood_zone: false }, fields) === false, 'standard + no flood zone + no note buyer => NO flood cert');
assert(rules.evaluateRule(FLOOD_RULE, { registered_program: 'gold', in_flood_zone: false }, fields) === true, 'gold => flood cert');
assert(rules.evaluateRule(FLOOD_RULE, { registered_program: 'manual', in_flood_zone: false }, fields) === true, 'manual => flood cert');
assert(rules.evaluateRule(FLOOD_RULE, { registered_program: 'standard', in_flood_zone: true }, fields) === true, 'standard + flood zone => flood cert');
assert(rules.evaluateRule(FLOOD_RULE, { registered_program: 'none', in_flood_zone: false }, fields) === false, 'unregistered + no flood zone => NO flood cert');
// note-buyer branch (owner-directed 2026-07-22): Blue Lake / CorrFirst always require it.
assert(rules.evaluateRule(FLOOD_RULE, { registered_program: 'standard', in_flood_zone: false, note_buyer: 'bluelake' }, fields) === true, 'standard + Blue Lake note buyer => flood cert');
assert(rules.evaluateRule(FLOOD_RULE, { registered_program: 'standard', in_flood_zone: false, note_buyer: 'corrfirst' }, fields) === true, 'standard + CorrFirst note buyer => flood cert');
assert(rules.evaluateRule(FLOOD_RULE, { registered_program: 'standard', in_flood_zone: false, note_buyer: 'fidelis' }, fields) === false, 'standard + Fidelis note buyer => NO flood cert');
assert(!!reg.BY_KEY.in_flood_zone && reg.BY_KEY.in_flood_zone.type === 'boolean', 'in_flood_zone is a boolean rule field');
assert((reg.BY_KEY.registered_program.options || []).some((o) => o.v === 'manual'), 'registered_program has a "manual" option');
assert((reg.BY_KEY.note_buyer.options || []).some((o) => o.v === 'bluelake') && (reg.BY_KEY.note_buyer.options || []).some((o) => o.v === 'corrfirst'),
  'note_buyer has bluelake + corrfirst options');

assert(liq.bankStatementMonths('manual', 4) === 4, 'manual liquidity months honor the entered value');
assert(liq.bankStatementMonths('manual') === 2, 'manual liquidity months fall back to 2');
assert(liq.bankStatementMonths('gold') === 2 && liq.bankStatementMonths('standard') === 1, 'gold=2 / standard=1 unchanged');
assert(/2 months of liquidity/.test(liq.bankStatementLine('manual', 2)) && !/gold|standard/i.test(liq.bankStatementLine('manual', 2)), 'manual liquidity line names months, not a program name');

if (!process.env.DATABASE_URL) {
  console.log('SKIP db-backed manual-program tests (no DATABASE_URL)');
  process.exit(failures ? 1 : 0);
}
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
const db = require('../src/db');
const engine = require('../src/lib/conditions/engine');

const floodCount = async (appId) => (await db.query(
  `SELECT count(*)::int n FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
    WHERE ci.application_id=$1 AND t.code='rtl_cond_flood'`, [appId])).rows[0].n;

async function setProgram(appId, program, assetMonths) {
  await db.query(`UPDATE product_registrations SET is_current=false WHERE application_id=$1`, [appId]);
  await db.query(
    `INSERT INTO product_registrations (application_id, program, status, total_loan, inputs, quote, is_current, is_manual, asset_months)
     VALUES ($1,$2,'ELIGIBLE',175000,'{}'::jsonb,'{}'::jsonb,true,$3,$4)`,
    [appId, program, program === 'manual', assetMonths || null]);
}

(async () => {
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  try {
    const borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Manual','Test',$1) RETURNING id`,
      [`mp-${sfx}@test.local`])).rows[0].id;

    // (1) Standard file, no flood zone → no flood cert.
    const std = (await db.query(
      `INSERT INTO applications (borrower_id,status,loan_type) VALUES ($1,'processing','Fix & Flip') RETURNING id`, [borrowerId])).rows[0].id;
    await setProgram(std, 'standard');
    await engine.evaluateApplication(std, { reason: 'test', notify: false });
    assert((await floodCount(std)) === 0, 'Standard file (no flood zone) has NO flood-cert condition');

    // (2) Switch to Gold → flood cert attaches.
    await setProgram(std, 'gold');
    await engine.evaluateApplication(std, { reason: 'test', notify: false });
    assert((await floodCount(std)) === 1, 'Gold file gets the flood-cert condition');

    // (3) Switch to Manual → still attached (rule matches). Then back to Standard → retracts (untouched).
    await setProgram(std, 'manual', 3);
    await engine.evaluateApplication(std, { reason: 'test', notify: false });
    assert((await floodCount(std)) === 1, 'Manual file keeps the flood-cert condition');
    await setProgram(std, 'standard');
    await engine.evaluateApplication(std, { reason: 'test', notify: false });
    assert((await floodCount(std)) === 0, 'flood-cert retracts (untouched) when the file goes back to Standard, no flood zone');

    // (4) Standard file IN a flood zone (appraisal SFHA) → flood cert required.
    const fz = (await db.query(
      `INSERT INTO applications (borrower_id,status,loan_type) VALUES ($1,'processing','Fix & Flip') RETURNING id`, [borrowerId])).rows[0].id;
    await setProgram(fz, 'standard');
    await db.query(
      `INSERT INTO appraisals (application_id, superseded, fema_flood_sfha) VALUES ($1,false,true)`, [fz]);
    await engine.evaluateApplication(fz, { reason: 'test', notify: false });
    assert((await floodCount(fz)) === 1, 'Standard file in a FEMA SFHA gets the flood-cert condition');

    // (5) Escalation round-trip.
    const esc = (await db.query(
      `INSERT INTO applications (borrower_id,status,loan_type) VALUES ($1,'processing','Fix & Flip') RETURNING id`, [borrowerId])).rows[0].id;
    await setProgram(esc, 'manual', 4);
    const regId = (await db.query(`SELECT id FROM product_registrations WHERE application_id=$1 AND is_current`, [esc])).rows[0].id;
    const escId = await mp.openEscalation(db, { appId: esc, registrationId: regId, assetMonths: 4, overrides: { ovrLTCPct: 72 }, summary: { totalLoan: 175000 }, requestedBy: null });
    assert(!!escId, 'openEscalation returns an id');
    const pend = await mp.pendingForApp(esc);
    assert(pend && pend.status === 'pending' && pend.asset_months === 4, 'file has a pending escalation with the stated asset months');
    assert((await mp.pendingCount()) >= 1, 'pendingCount sees the open escalation');
    // Re-open supersedes the prior pending row (one pending per app).
    const escId2 = await mp.openEscalation(db, { appId: esc, registrationId: regId, assetMonths: 5, overrides: { ovrLTCPct: 73 }, summary: {}, requestedBy: null });
    assert(escId2 !== escId, 're-register opens a fresh escalation');
    const pend2 = await mp.pendingForApp(esc);
    assert(pend2 && pend2.id === escId2 && pend2.asset_months === 5, 'the newer escalation is the only pending one');
    const decided = await mp.decideEscalation(escId2, 'approved', null, 'ok');
    assert(decided && decided.status === 'approved', 'decideEscalation approves the pending escalation');
    assert((await mp.pendingForApp(esc)) === null, 'no pending escalation remains after a decision');

    // Re-registering a manual file as NON-manual closes its stale pending row.
    await mp.openEscalation(db, { appId: esc, registrationId: regId, assetMonths: 6, overrides: { ovrLTCPct: 71 }, summary: {}, requestedBy: null });
    assert(!!(await mp.pendingForApp(esc)), 'a fresh pending escalation exists before the non-manual re-register');
    const closed = await mp.closePendingForApp(db, esc);
    assert(closed >= 1 && (await mp.pendingForApp(esc)) === null, 'closePendingForApp declines the stale pending escalation');

    // (6) Settings save/load + required asset-months validation.
    const saved = await mp.saveSettings({ assetMonths: 3, maxAcqLtv: 85, maxLtc: 90 }, null);
    assert(saved.assetMonths === 3 && saved.maxAcqLtv === 85 && saved.maxLtc === 90, 'saveSettings persists config');
    const loaded = await mp.loadSettings();
    assert(loaded.assetMonths === 3, 'loadSettings reads the current config');
    let threw = false;
    try { await mp.saveSettings({ assetMonths: 0 }, null); } catch (e) { threw = e.status === 400; }
    assert(threw, 'saveSettings rejects a missing/zero asset-months (required field)');

    // cleanup — applications cascade to registrations/escalations/checklist items.
    await db.query(`DELETE FROM applications WHERE borrower_id=$1`, [borrowerId]);
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]);
  } catch (e) {
    console.log('FAIL threw', e && e.message); failures++;
  } finally {
    await db.pool.end().catch(() => {});
  }
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
