'use strict';
/**
 * A BRIDGE WITHOUT CONSTRUCTION CARRIES NO BUDGET / SOW CONDITIONS — against a
 * real database (owner-directed 2026-09-03). Two things only a database can prove:
 *
 *   A. THE TWO HALVES AGREE. The JS rule (`conditions/bridge-construction.js`)
 *      and its SQL twin (`pilot_bridge_without_construction()`, db/691) are run
 *      over the SAME battery (scripts/lib/bridge-construction-battery.js) and
 *      must answer identically on every row — the mirror rule, asserted.
 *   B. THE TRIGGER'S LIFECYCLE. A fix & flip file carries the three; flipping
 *      it to a bridge takes the untouched ones off; a budget typed onto the
 *      bridge puts them back; flipping back to a bridge leaves alone the one a
 *      person has worked (a document on it); and generateChecklist never adds
 *      them to a bridge in the first place.
 *
 * Requires DATABASE_URL with migrations applied (incl. db/691); skips otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-bridge-construction-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { isBridgeWithoutConstruction, CONSTRUCTION_ONLY_CODES } = require('../src/lib/conditions/bridge-construction');
const BATTERY = require('./lib/bridge-construction-battery');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

async function codesOn(appId) {
  const r = await db.query(
    `SELECT t.code FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
      WHERE ci.application_id=$1 AND t.code = ANY($2::text[]) ORDER BY t.code`, [appId, CONSTRUCTION_ONLY_CODES]);
  return r.rows.map((x) => x.code);
}

(async () => {
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let borrowerId;
  try {
    console.log('\nA. the JS rule and the SQL twin agree on every row of the battery');
    for (const c of BATTERY) {
      const r = c.row || {};
      // The column is numeric(14,2): a typed string reaches SQL as the number it parses to.
      const budget = typeof r.rehab_budget === 'string' ? Number(r.rehab_budget.replace(/[^0-9.-]/g, '')) : (r.rehab_budget == null ? null : r.rehab_budget);
      const sql = (await db.query(
        `SELECT pilot_bridge_without_construction($1, $2, $3, $4::numeric) AS v`,
        [r.program == null ? null : r.program, r.loan_type == null ? null : r.loan_type, r.rehab_type == null ? null : r.rehab_type, budget])).rows[0].v;
      const js = isBridgeWithoutConstruction(r);
      assert(sql === js && js === c.expect, `${c.why}: JS=${js} SQL=${sql} expected=${c.expect}`);
    }

    console.log('\nB. the trigger keeps a live file in step');
    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Bridge','Test',$1) RETURNING id`,
      [`bridge-bo-${sfx}@test.local`])).rows[0].id;
    // A fix & flip first, with the three on it the way generateChecklist puts them.
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, status, program) VALUES ($1,'processing','Fix & Flip With Construction') RETURNING id`,
      [borrowerId])).rows[0].id;
    const { generateChecklist } = require('../src/routes/borrower');
    await generateChecklist(appId, borrowerId, 'Fix & Flip With Construction', 'Purchase', {});
    let have = await codesOn(appId);
    assert(have.length === 3, `a fix & flip carries all three (${have.join(', ')})`);

    // Put a document on the SOW-from-borrower condition: that one is a person's work.
    const sowItem = (await db.query(
      `SELECT ci.id FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
        WHERE ci.application_id=$1 AND t.code='rtl_p3_sow1'`, [appId])).rows[0];
    await db.query(
      `INSERT INTO documents (application_id, checklist_item_id, borrower_id, filename, content_type, size_bytes, storage_provider, storage_ref, uploaded_by_kind, doc_kind)
       VALUES ($1,$2,$3,'sow.pdf','application/pdf',10,'local',$4,'borrower','scope_of_work')`,
      [appId, sowItem.id, borrowerId, `test/${sfx}/sow.pdf`]);

    // Flip to a bridge → the two untouched come off, the worked one stays.
    await db.query(`UPDATE applications SET program='bridge Without Construction' WHERE id=$1`, [appId]);
    have = await codesOn(appId);
    assert(JSON.stringify(have) === JSON.stringify(['rtl_p3_sow1']),
      `flipping to a bridge takes the UNTOUCHED budget and appraiser-SOW off and leaves the SOW with a document (${have.join(', ')})`);

    // Type a rehab budget on the bridge → it builds after all → the two come back.
    await db.query(`UPDATE applications SET rehab_budget=40000 WHERE id=$1`, [appId]);
    have = await codesOn(appId);
    assert(have.length === 3, `a budget typed on the bridge puts them back (${have.join(', ')})`);

    // Clear the budget → off again (untouched ones only), no duplicates anywhere.
    await db.query(`UPDATE applications SET rehab_budget=NULL WHERE id=$1`, [appId]);
    have = await codesOn(appId);
    assert(JSON.stringify(have) === JSON.stringify(['rtl_p3_sow1']), `clearing the budget takes them off again (${have.join(', ')})`);
    await db.query(`UPDATE applications SET program='Fix & Hold With Construction' WHERE id=$1`, [appId]);
    await db.query(`UPDATE applications SET loan_type='Purchase' WHERE id=$1`, [appId]);
    const cnt = (await db.query(
      `SELECT count(*)::int n FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
        WHERE ci.application_id=$1 AND t.code = ANY($2::text[])`, [appId, CONSTRUCTION_ONLY_CODES])).rows[0].n;
    assert(cnt === 3, `a fix & hold carries exactly one of each — no duplicates on repeated flips (${cnt})`);

    // An unrelated column change never touches them (the trigger is OF four columns).
    await db.query(`UPDATE applications SET status='underwriting' WHERE id=$1`, [appId]);
    assert((await codesOn(appId)).length === 3, 'a status change leaves the three alone');

    console.log('\nC. generateChecklist never puts them on a bridge to begin with');
    const app2 = (await db.query(
      `INSERT INTO applications (borrower_id, status, program) VALUES ($1,'processing','bridge Without Construction') RETURNING id`,
      [borrowerId])).rows[0].id;
    await generateChecklist(app2, borrowerId, 'bridge Without Construction', 'Purchase', {});
    have = await codesOn(app2);
    assert(have.length === 0, `a new bridge file has none of the three (${have.join(', ') || 'none'})`);
    const others = (await db.query(`SELECT count(*)::int n FROM checklist_items WHERE application_id=$1`, [app2])).rows[0].n;
    assert(others > 0, `…and still has its other conditions (${others})`);
    await db.query(`UPDATE applications SET program='Fix & Flip With Construction' WHERE id=$1`, [app2]);
    assert((await codesOn(app2)).length === 3, 'and becomes a fix & flip with all three the moment its program says so');

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL bridge-construction assertions passed');
  } catch (e) {
    console.error('ERROR', e); failures++;
  } finally {
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) {}
    try { await db.end(); } catch (_) {}
  }
  process.exit(failures ? 1 : 0);
})();
