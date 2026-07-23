/**
 * Fix the loan file IN PLACE from a finding (owner-directed 2026-07-22).
 * "Fix the file" used to be records-only (it set resolution_value on the finding
 * but never changed the loan file). Now, when the finding's field maps to a real
 * economic column (purchase_price / as_is_value / arv / rehab_budget), the
 * corrected value is written straight onto the application through the guarded,
 * economics-freeze-honoring path. Requires DATABASE_URL.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-finding-fix-in-place (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { applyFindingFixToFile, fixableColumn } = require('../src/lib/underwriting/apply-fix');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

async function seedApp(sfx) {
  const superId = (await db.query(`INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version) VALUES ($1,'S','super_admin',true,false,'x',0) RETURNING id`, [`ff-s-${sfx}@test.local`])).rows[0].id;
  const borrowerId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('F','F',$1) RETURNING id`, [`ff-b-${sfx}@test.local`])).rows[0].id;
  const appId = (await db.query(`INSERT INTO applications (borrower_id, loan_officer_id, status, purchase_price, arv) VALUES ($1,$2,'processing',400000,600000) RETURNING id`, [borrowerId, superId])).rows[0].id;
  return { superId, borrowerId, appId };
}
async function cleanup(ids) {
  try { if (ids.borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [ids.borrowerId]); } catch (_) {}
  try { if (ids.superId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [ids.superId]); } catch (_) {}
}

(async () => {
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const created = [];
  try {
    // The fixable-field map: only the four safe economic columns.
    assert(fixableColumn('purchase_price') === 'purchase_price' && fixableColumn('arv') === 'arv'
      && fixableColumn('as_is_value') === 'as_is_value' && fixableColumn('rehab_budget') === 'rehab_budget',
      'map: the four economic fields map to their application columns');
    assert(fixableColumn('seller_name') === null && fixableColumn('borrower_dob') === null && fixableColumn('entity_name') === null,
      'map: non-economic / other-table fields are NOT auto-appliable');

    // (A) applies the corrected value to the loan file (coercing "$425,000" → 425000).
    {
      const ids = await seedApp(`${sfx}a`); created.push(ids);
      const actor = { kind: 'staff', role: 'super_admin', id: ids.superId };
      const out = await applyFindingFixToFile({ appId: ids.appId, field: 'purchase_price', value: '$425,000', actor, db });
      assert(out.applied === true && out.column === 'purchase_price' && out.value === 425000, 'A: the purchase_price fix applied (money coerced)');
      const row = (await db.query(`SELECT purchase_price FROM applications WHERE id=$1`, [ids.appId])).rows[0];
      assert(Number(row.purchase_price) === 425000, 'A: the loan file purchase_price is now 425000');
    }

    // (B) a field with no application column → records-only (no throw, applied:false).
    {
      const ids = await seedApp(`${sfx}b`); created.push(ids);
      const actor = { kind: 'staff', role: 'super_admin', id: ids.superId };
      const out = await applyFindingFixToFile({ appId: ids.appId, field: 'seller_name', value: 'John Smith', actor, db });
      assert(out.applied === false && out.reason === 'not-a-file-field', 'B: a non-economic field stays records-only (nothing written)');
    }

    // (C) a non-numeric value is rejected — the file is untouched.
    {
      const ids = await seedApp(`${sfx}c`); created.push(ids);
      const actor = { kind: 'staff', role: 'super_admin', id: ids.superId };
      const out = await applyFindingFixToFile({ appId: ids.appId, field: 'arv', value: 'not a number', actor, db });
      assert(out.applied === false && out.reason === 'bad-value', 'C: a non-numeric value is rejected');
      const row = (await db.query(`SELECT arv FROM applications WHERE id=$1`, [ids.appId])).rows[0];
      assert(Number(row.arv) === 600000, 'C: the file arv is unchanged after a bad value');
    }

    // (D) a FROZEN file (term-sheet package sent) → 409 locked, nothing written — even a super_admin.
    {
      const ids = await seedApp(`${sfx}d`); created.push(ids);
      await db.query(`INSERT INTO esign_envelopes (application_id, purpose, status) VALUES ($1,'term_sheet_package','sent')`, [ids.appId]);
      const actor = { kind: 'staff', role: 'super_admin', id: ids.superId };
      let threw = false;
      try { await applyFindingFixToFile({ appId: ids.appId, field: 'purchase_price', value: '450000', actor, db }); }
      catch (e) { threw = true; assert(e.status === 409 && e.locked === true, 'D: a term-sheet-sent (frozen) file throws 409 locked'); }
      assert(threw, 'D: the fix is refused on a frozen file');
      const row = (await db.query(`SELECT purchase_price FROM applications WHERE id=$1`, [ids.appId])).rows[0];
      assert(Number(row.purchase_price) === 400000, 'D: the frozen file was NOT changed');
    }

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL finding-fix-in-place assertions passed');
  } catch (e) {
    console.error('ERROR', e); failures++;
  } finally {
    for (const ids of created) await cleanup(ids);
    process.exit(failures ? 1 : 0);
  }
})();
