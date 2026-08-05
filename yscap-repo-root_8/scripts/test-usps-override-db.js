/**
 * SUPER-ADMIN EXCEPTION FOR THE USPS HOLD-BACK (owner-directed 2026-08-05).
 *
 * "The hold-back and the gate for ALL the orders that need USPS — we should be
 *  able to ask a super admin for an exception for it … I shouldn't be stuck …
 *  and we need to see the correct language [when it fails]."
 *
 * Two things this suite holds:
 *
 *   1. THE ERROR NAMES ITSELF. When a live USPS lookup fails, the /check route no
 *      longer answers a generic "try again" — it returns the plain reason AND the
 *      exact technical detail USPS gave, plus whether the override door is open.
 *   2. THE OVERRIDE LIFTS THE WHOLE HOLD-BACK. Import is the only thing that sets
 *      `usps_imported_at`, and that ONE flag is what every USPS gate reads — the
 *      condition sign-off AND the title / insurance / attorney ordering gates. So
 *      a super admin, with a reason, can stamp it (adopting the file's address, or
 *      an edited candidate) and every one of those gates opens at once. Only a
 *      super admin, only with a reason, and it is recorded like a condition
 *      override (stamp on the condition + audit row + policy-exception register).
 *
 * Boots the real Express app and drives the real endpoints over HTTP. Requires
 * DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-usps-override-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const app = require('../src/server');
const uspsVerify = require('../src/lib/usps-verify');
const orders = require('../src/lib/orders');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b, json: (() => { try { return JSON.parse(b); } catch { return null; } })() })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

const appRow = async (id) => (await db.query(
  `SELECT usps_imported_at, usps_match, property_address FROM applications WHERE id=$1`, [id])).rows[0];
const condRow = async (appId, tplId) => (await db.query(
  `SELECT status, signed_off_at, override_by, override_at, override_reason, override_blocked_reason
     FROM checklist_items WHERE application_id=$1 AND template_id=$2`, [appId, tplId])).rows[0];

// The 'usps' blocker every order gate computes from the same flag the override sets.
const titleBlocked = (imported) => orders.blockers('title', { hasLoanNumber: true, vendors: { title: { email: 'x@t.co' } }, uspsGate: true, uspsImported: imported }).includes('usps');
const insBlocked = (imported) => orders.blockers('insurance', { hasLoanNumber: true, vendors: { insurance: { email: 'x@i.co' } }, uspsGate: true, uspsImported: imported }).includes('usps');

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const tplId = (await db.query(`SELECT id FROM checklist_templates WHERE code='usps_address_verification'`)).rows[0].id;
  let superId, adminId, borrowerId;
  const CURRENT = { line1: '12 Main St', city: 'Lakewood', state: 'NJ', zip: '08701', oneLine: '12 Main St, Lakewood, NJ 08701' };

  try {
    superId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Usps Super','super_admin',true,false,'x',0) RETURNING id`, [`usps-super-${sfx}@test.local`])).rows[0].id;
    adminId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Usps Admin','admin',true,false,'x',0) RETURNING id`, [`usps-admin-${sfx}@test.local`])).rows[0].id;
    const sToken = C.signJwt({ sub: superId, kind: 'staff', role: 'super_admin', tv: 0 });
    const aToken = C.signJwt({ sub: adminId, kind: 'staff', role: 'admin', tv: 0 });
    borrowerId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Usps','Ovr',$1) RETURNING id`, [`usps-bo-${sfx}@test.local`])).rows[0].id;

    async function newFile() {
      const id = (await db.query(
        `INSERT INTO applications (borrower_id, loan_officer_id, status, property_address)
         VALUES ($1,$2,'processing',$3::jsonb) RETURNING id`, [borrowerId, superId, JSON.stringify(CURRENT)])).rows[0].id;
      await db.query(
        `INSERT INTO checklist_items (template_id, scope, application_id, label, audience, item_kind, is_required, status, created_by_kind)
         VALUES ($1,'application',$2,'USPS Address Verification','staff','condition',true,'outstanding','system')`, [tplId, id]);
      return id;
    }
    const overridePath = (id) => `/api/staff/applications/${id}/usps-verification/override`;
    const REASON = 'USPS lookup down; address confirmed against county records and the appraisal.';

    // ── 1. THE ERROR NAMES ITSELF (the /check route surfaces the reason) ──────
    {
      const appId = await newFile();
      const saved = uspsVerify.standardize;
      uspsVerify.standardize = async () => ({ status: 'error', detail: 'USPS 400: {"error":"Invalid address"}' });
      try {
        const r = await call(server, 'POST', `/api/staff/applications/${appId}/usps-verification/check`, sToken, { address: CURRENT });
        assert(r.status === 502, 'a USPS failure answers 502, not a silent 200');
        assert(r.json && /could not read this address/i.test(r.json.error), 'the reason is plain language, not "try again" — got ' + (r.json && r.json.error));
        assert(r.json && r.json.detail === 'USPS 400: {"error":"Invalid address"}', 'the EXACT technical detail is included so we can see why');
        assert(r.json && r.json.canOverride === true, 'a super admin is told the override door is open');
      } finally { uspsVerify.standardize = saved; }
      // A non-super admin is told the door is NOT open.
      uspsVerify.standardize = async () => ({ status: 'error', detail: 'USPS 503: down' });
      try {
        const r = await call(server, 'POST', `/api/staff/applications/${appId}/usps-verification/check`, aToken, { address: CURRENT });
        assert(r.json && r.json.canOverride === false, 'a plain admin is not offered the override');
        assert(r.json && r.json.retryable === true, 'a USPS 5xx is marked retryable');
      } finally { uspsVerify.standardize = saved; }
    }

    // ── 2. WHO MAY OVERRIDE — and the hold-back is real first ─────────────────
    {
      const appId = await newFile();
      assert(titleBlocked(false) && insBlocked(false), 'with no import, title AND insurance orders are held back on USPS');

      const asAdmin = await call(server, 'POST', overridePath(appId), aToken, { overrideReason: REASON });
      assert(asAdmin.status === 403, 'an ordinary ADMIN is refused (403) — super admin only');
      assert(/super admin/i.test(asAdmin.body), 'the refusal says who can do it');
      assert((await appRow(appId)).usps_imported_at === null, 'the refused override changed nothing');

      const noReason = await call(server, 'POST', overridePath(appId), sToken, {});
      assert(noReason.status === 400, 'a super admin WITHOUT a reason is refused (400)');
      assert((await appRow(appId)).usps_imported_at === null, 'the reason-less refusal changed nothing');
    }

    // ── 3. THE OVERRIDE, no edited address — keeps the file's address, lifts all
    {
      const appId = await newFile();
      const before = (await appRow(appId)).property_address;
      // An AUTO-CLEARED, unsigned contract condition: db/292 reopens one to 'received'
      // on ANY property_address change. A no-op override must not rewrite the address,
      // so this must stay satisfied — the exact wrinkle the pre-merge audit flagged.
      const contractTpl = (await db.query(`SELECT id FROM checklist_templates WHERE code='rtl_p1_contract'`)).rows[0];
      let contractItem = null;
      if (contractTpl) {
        contractItem = (await db.query(
          `INSERT INTO checklist_items (template_id, scope, application_id, label, audience, item_kind, is_required, status, created_by_kind, signed_off_at)
           VALUES ($1,'application',$2,'Purchase contract','staff','document',true,'satisfied','system',now()) RETURNING id`,
          [contractTpl.id, appId])).rows[0].id;   // signed_off_by left NULL = auto-cleared
      }

      // Reproduce the real UI: the dialog PREFILLS the box with the current address,
      // so an unedited override arrives carrying that same place (a different object
      // shape). The server must recognize it as the same place and NOT rewrite.
      const prefilled = { line1: '12 Main St', city: 'Lakewood', state: 'NJ', zip: '08701' };
      const r = await call(server, 'POST', overridePath(appId), sToken, { overrideReason: REASON, address: prefilled, lastError: 'USPS 400: Invalid address' });
      assert(r.status === 200 && r.json && r.json.override === true, 'a super admin with a reason clears the hold (200)');

      const a = await appRow(appId);
      assert(!!a.usps_imported_at, 'usps_imported_at is stamped — THE flag every order gate reads');
      assert(!titleBlocked(!!a.usps_imported_at) && !insBlocked(!!a.usps_imported_at),
        'so title AND insurance ordering are no longer held back (attorney reads the same flag)');
      assert(a.property_address && a.property_address.oneLine === CURRENT.oneLine, 'with no edit, the file keeps its current address');
      // The address jsonb is untouched (not even re-serialized), so nothing keyed on
      // a property_address change is disturbed.
      const same = (await db.query(`SELECT property_address IS NOT DISTINCT FROM $2::jsonb AS same FROM applications WHERE id=$1`,
        [appId, JSON.stringify(before)])).rows[0].same;
      assert(same === true, 'a no-edit override does not rewrite property_address at all');
      if (contractItem) {
        const cc = (await db.query(`SELECT status FROM checklist_items WHERE id=$1`, [contractItem])).rows[0];
        assert(cc.status === 'satisfied', 'a no-edit override does NOT reopen the auto-cleared contract condition (db/292)');
      }

      const c = await condRow(appId, tplId);
      assert(c.status === 'satisfied' && !!c.signed_off_at, 'the USPS condition is cleared');
      assert(String(c.override_by) === String(superId) && !!c.override_at, 'who + when are stamped on the condition');
      assert(c.override_reason === REASON, 'why is stamped on the condition');
      assert(/USPS did not confirm/i.test(c.override_blocked_reason || '') && /invalid address/i.test(c.override_blocked_reason || ''),
        'what was skipped (incl. the last USPS error) is stamped too');

      const aud = (await db.query(
        `SELECT detail FROM audit_log WHERE action='usps_hold_override' AND entity_id=$1 ORDER BY id DESC LIMIT 1`, [appId])).rows[0];
      assert(!!aud && aud.detail.reason === REASON, 'the override is in the audit trail with its reason');

      const exc = (await db.query(
        `SELECT status, gate_snapshot FROM loan_exceptions
          WHERE application_id=$1 AND exception_type='condition_override' ORDER BY created_at DESC LIMIT 1`, [appId])).rows[0];
      assert(!!exc && exc.status === 'approved', 'it lands in the policy-exception register, born approved');
      assert(!!exc && exc.gate_snapshot && exc.gate_snapshot.action === 'usps_hold_override', 'the register row names it as the USPS hold override');
    }

    // ── 4. THE OVERRIDE, with an edited candidate — adopts THAT address ───────
    {
      const appId = await newFile();
      const edited = { line1: '400 Cedar Avenue', city: 'Lakewood', state: 'NJ', zip: '08701' };
      const r = await call(server, 'POST', overridePath(appId), sToken, { overrideReason: REASON, address: edited });
      assert(r.status === 200, 'the override with an edited address succeeds');
      const a = await appRow(appId);
      assert(!!a.usps_imported_at, 'the import is still stamped');
      assert(a.property_address && /cedar ave/i.test(a.property_address.oneLine || ''),
        'the edited candidate becomes the working address (normalized) — got ' + (a.property_address && a.property_address.oneLine));
      assert(a.property_address && a.property_address.oneLine !== CURRENT.oneLine, 'it replaced the old address');
    }

    console.log(failures ? `\n${failures} FAILURE(S)` : `\nAll USPS-override checks passed.`);
  } finally {
    try { if (borrowerId) { await db.query(`DELETE FROM applications WHERE borrower_id=$1`, [borrowerId]); await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } } catch (_) {}
    try { if (superId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [superId]); } catch (_) {}
    try { if (adminId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [adminId]); } catch (_) {}
    server.close();
  }
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
