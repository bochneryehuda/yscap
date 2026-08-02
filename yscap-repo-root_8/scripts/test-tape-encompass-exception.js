'use strict';
/**
 * Data-tape export before Encompass matches — the super-admin exception
 * (owner-directed 2026-08-02).
 *
 * PURE part (always runs): the `tape_encompass_override` exception type contract —
 * it exists, is super-admin-decide-only (decideRoleFor), file-subject, expirable,
 * with the right reason codes; the db/396 migration widens the type CHECK; the
 * notify maps register the two new event types.
 *
 * DB part (runs only with DATABASE_URL): the lifecycle — request → approve (a
 * super-admin decision) → approvedForApp finds it; a super-admin INLINE override
 * (recordTapeEncompassOverride) is born-approved and found by approvedForApp; an
 * EXPIRED approval grants nothing (fails closed at read time).
 *
 *   node scripts/test-tape-encompass-exception.js
 *   DATABASE_URL=postgres://… node scripts/test-tape-encompass-exception.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const R = path.resolve(__dirname, '..');
const LE = require(R + '/src/lib/loan-exceptions');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

// ───────────────────────── PURE: the type contract ─────────────────────────
(function pure() {
  const T = 'tape_encompass_override';
  ok(LE.isExceptionType(T), 'the tape exception type is registered');
  const cfg = LE.typeConfig(T);
  ok(cfg && cfg.subject === 'file', 'subject is the file (not a co-borrower)');
  ok(cfg && cfg.expirable === true, 'expirable — a grant can carry a validity window');
  ok(cfg && cfg.recordOnly === false, 'a real request → decision (not record-only)');
  ok(cfg && cfg.slaHours === 24, 'review SLA is 24h');
  ok(cfg && cfg.decideRole === 'super_admin', 'decideRole pins it to super_admin');

  // Only a SUPER-ADMIN may decide this one; every other type keeps the default
  // (null = the register's manage_pricing gate — admins + super-admins).
  ok(LE.decideRoleFor(T) === 'super_admin', 'decideRoleFor(tape) === super_admin');
  for (const other of ['guaranty_waiver', 'esign_before_ctc', 'pricing_exception', 'oop_rehab', 'issuance_override']) {
    ok(LE.decideRoleFor(other) === null, `decideRoleFor(${other}) is null (default gate)`);
  }

  // Reasons.
  const reasons = LE.TAPE_ENCOMPASS_REASONS;
  ok(reasons && typeof reasons === 'object', 'TAPE_ENCOMPASS_REASONS exists');
  for (const code of ['no_loan_number', 'not_in_encompass', 'fields_differ', 'other']) {
    ok(Object.prototype.hasOwnProperty.call(reasons, code), `reason code present: ${code}`);
  }
  ok(LE.reasonCodesFor(T) === reasons, 'reasonCodesFor(tape) returns the tape reasons');
  ok(LE.isReasonCodeFor(T, 'no_loan_number') === true, 'isReasonCodeFor accepts a real code');
  ok(LE.isReasonCodeFor(T, 'nonsense') === false, 'isReasonCodeFor rejects an unknown code');

  // The new helper functions exist.
  ok(typeof LE.requestTapeEncompassOverride === 'function', 'requestTapeEncompassOverride exported');
  ok(typeof LE.recordTapeEncompassOverride === 'function', 'recordTapeEncompassOverride exported');
  ok(typeof LE.approvedForApp === 'function', 'approvedForApp exported');
})();

// ───────────────────────── PURE: migration widens the CHECK ─────────────────
(function migration() {
  const sql = fs.readFileSync(R + '/db/396_tape_encompass_exception.sql', 'utf8');
  ok(/loan_exceptions_exception_type_check/.test(sql), 'db/396 touches the exception_type CHECK');
  ok(/tape_encompass_override/.test(sql), 'db/396 adds tape_encompass_override to the CHECK');
  // It must re-assert the STATUS check verbatim too (the rollback-collateral rule
  // documented on db/344/388) — every prior-boot value must survive.
  ok(/loan_exceptions_status_check[\s\S]*'requested'[\s\S]*'expired'/.test(sql), 'db/396 re-asserts the status CHECK incl. expired');
  // Numbered last (highest number) so it wins the boot ordering.
  const nums = fs.readdirSync(R + '/db').filter((f) => /^\d+_.*\.sql$/.test(f)).map((f) => parseInt(f, 10));
  ok(396 >= Math.max(...nums), 'db/396 is the highest-numbered migration (re-asserts the full list last)');
})();

// ───────────────────────── PURE: notify maps register the events ────────────
(function notifyMaps() {
  const src = fs.readFileSync(R + '/src/lib/notify.js', 'utf8');
  // Both the request and the decision types must appear in the KICKER + CATEGORY
  // maps or the emails won't fire / won't be categorized.
  const req = (src.match(/tape_encompass_exception\b(?!_)/g) || []).length;
  const dec = (src.match(/tape_encompass_exception_decided/g) || []).length;
  ok(req >= 2, 'tape_encompass_exception appears in both notify maps (kicker + category)');
  ok(dec >= 2, 'tape_encompass_exception_decided appears in both notify maps');
})();

// ───────────────────────── DB: the lifecycle ────────────────────────────────
(async function dbPart() {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP tape-exception DB lifecycle (no DATABASE_URL)'); return; }
  const db = require(R + '/src/db');
  const rnd = () => `tape-exc-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const created = [];
  try {
    const b = await db.query("INSERT INTO borrowers(first_name,last_name,email) VALUES('T','Ape',$1) RETURNING id", [rnd()]);
    const su = await db.query("INSERT INTO staff_users(email,full_name,role,is_active) VALUES($1,'Sue Super','super_admin',true) RETURNING id", [rnd()]);
    const app = await db.query('INSERT INTO applications(borrower_id) VALUES($1) RETURNING id', [b.rows[0].id]);
    const appId = app.rows[0].id;
    const suId = su.rows[0].id;
    created.push(['applications', appId], ['borrowers', b.rows[0].id], ['staff_users', suId]);

    // 1) Nothing granted yet.
    ok((await LE.approvedForApp(appId, 'tape_encompass_override')) === null, 'no approved exception on a fresh file');

    // 2) Request → an OPEN row exists; approvedForApp still null.
    let c = await db.getClient(); await c.query('BEGIN');
    const r1 = await LE.requestTapeEncompassOverride(c, { appId, reasonCode: 'not_in_encompass', reasonNote: 'buyer needs it now', requestedBy: suId,
      gateSnapshot: { at: new Date().toISOString(), blocked: true, reason: 'not_in_encompass' } });
    await c.query('COMMIT'); c.release();
    ok(r1 && r1.status === 'requested', 'request creates a requested row');
    ok((await LE.openForApp(appId, 'tape_encompass_override')) !== null, 'openForApp finds the request');
    ok((await LE.approvedForApp(appId, 'tape_encompass_override')) === null, 'a requested (not approved) exception grants nothing');

    // 3) Approve → approvedForApp finds it.
    const dec = await LE.decideException(r1.id, 'approved', suId, 'ok — allowed by super admin');
    ok(dec && dec.status === 'approved', 'the request approves');
    const appr = await LE.approvedForApp(appId, 'tape_encompass_override');
    ok(appr && appr.id === r1.id, 'approvedForApp returns the approved exception');

    // 4) An EXPIRED approval grants nothing (read-time fail-closed).
    await db.query(`UPDATE loan_exceptions SET expires_at = now() - interval '1 day' WHERE id=$1`, [r1.id]);
    ok((await LE.approvedForApp(appId, 'tape_encompass_override')) === null, 'a lapsed approval grants nothing (fails closed at read)');

    // 5) A super-admin INLINE override is born-approved and found immediately.
    const rec = await LE.recordTapeEncompassOverride({ appId, staffId: suId, note: 'inline super allow', snapshot: { action: 'export_tape', reason_code: 'buyer_deadline' } });
    ok(rec && rec.status === 'approved' && rec.exception_type === 'tape_encompass_override', 'recordTapeEncompassOverride is born approved');
    ok(rec.reason_code === 'buyer_deadline', 'the snapshot reason_code is adopted when valid');
    const appr2 = await LE.approvedForApp(appId, 'tape_encompass_override');
    ok(appr2 && appr2.id === rec.id, 'approvedForApp returns the inline override (newest approved wins)');

    // cleanup
    await db.query(`DELETE FROM loan_exceptions WHERE application_id=$1`, [appId]);
  } catch (e) {
    fail++; console.log('  FAIL (DB):', e.message);
  } finally {
    for (const [tbl, id] of created.reverse()) {
      try { await db.query(`DELETE FROM ${tbl} WHERE id=$1`, [id]); } catch (_) { /* best-effort */ }
    }
    try { await db.pool.end(); } catch (_) {}
  }
})().then(() => {
  console.log(`\ntape Encompass exception — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
