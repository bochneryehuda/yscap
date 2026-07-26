'use strict';
/**
 * DB-gated end-to-end test for the data-tape export.
 * Creates two loan files (one assigned to Fidelis, one to Blue Lake) and checks:
 *   · buildTape produces a real .xlsx with the loan's number in the Data Tape row,
 *   · the capital-provider rule blocks the Blue Lake file from the Fidelis tape,
 *   · a bulk tape writes one row per Fidelis file, and a mixed batch is rejected.
 *
 * Run: DATABASE_URL=... node scripts/test-tape-export-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-tape-export-db (no DATABASE_URL)'); process.exit(0); }

const assert = require('assert');
const crypto = require('crypto');
const db = require('../src/db');
const { unzip } = require('../src/lib/zip');
const tapes = require('../src/lib/tapes');

const uuid = () => crypto.randomUUID();
const SUFFIX = Date.now().toString(36);

async function main() {
  const bId = uuid();
  const fidelisApp = uuid();
  const fidelisApp2 = uuid();
  const bluelakeApp = uuid();
  const email = `tape-test-${SUFFIX}@example.com`;
  const created = { apps: [fidelisApp, fidelisApp2, bluelakeApp], borrower: bId };

  try {
    await db.query(`INSERT INTO borrowers (id,first_name,last_name,email,fico) VALUES ($1,'Tammy','Tapeworth',$2,741)`, [bId, email]);
    const addr = (s) => JSON.stringify({ line1: s, city: 'Newark', state: 'NJ', zip: '07104' });
    const mk = (id, ln, lender, addrLine) => db.query(
      `INSERT INTO applications (id,borrower_id,status,ys_loan_number,lender,property_address,rehab_budget,property_type,loan_type,units,purchase_price,as_is_value,arv,loan_amount,rate_pct,term)
       VALUES ($1,$2,'funded',$3,$4,$5,80000,'Single Family','Purchase',1,300000,310000,450000,360000,10.5,'12 months')`,
      [id, bId, ln, lender, addr(addrLine)]);
    await mk(fidelisApp, `YSCAP-TP-${SUFFIX}-A`, 'Fidelis', '10 Fidelis Way');
    await mk(fidelisApp2, `YSCAP-TP-${SUFFIX}-B`, 'Fidelis', '12 Fidelis Way');
    await mk(bluelakeApp, `YSCAP-TP-${SUFFIX}-C`, 'Blue Lake', '14 Lake Rd');

    // 1) single Fidelis tape
    const single = await tapes.buildTape(fidelisApp, 'fidelis', db);
    assert.ok(Buffer.isBuffer(single.buf) && single.buf.length > 10000, 'single tape produced bytes');
    assert.ok(/Fidelis-Tape-.*\.xlsx/.test(single.filename), `filename shaped: ${single.filename}`);
    const parts = unzip(single.buf);
    const sheet = parts.find((p) => p.name === 'xl/worksheets/sheet5.xml').data.toString('utf8');
    assert.ok(sheet.indexOf(`YSCAP-TP-${SUFFIX}-A`) > -1, 'Data Tape row carries the loan number');
    assert.ok(sheet.indexOf('<v>360000</v>') > -1, 'Data Tape row carries the loan amount');
    assert.ok(parts.find((p) => p.name === 'xl/workbook.xml').data.toString('utf8').indexOf('fullCalcOnLoad="1"') > -1, 'workbook recalcs on open');

    // 2) buyer rule blocks Blue Lake file from the Fidelis tape
    let mismatch = null;
    try { await tapes.buildTape(bluelakeApp, 'fidelis', db); } catch (e) { mismatch = e; }
    assert.ok(mismatch && mismatch.code === 'buyer_mismatch', 'Blue Lake file blocked from Fidelis tape');
    assert.ok(/Blue Lake/.test(mismatch.message) && /Fidelis/.test(mismatch.message), 'block message names both providers');

    // 3) availability reflects the loan's current provider
    const key = require('../src/lib/conditions/field-registry').normNoteBuyer('Fidelis');
    assert.ok(tapes.tapeAvailability(key, 'Fidelis')[0].available === true, 'availability true for Fidelis loan');

    // 4) bulk: two Fidelis files → 2 rows
    const bulk = await tapes.buildBulkTape('fidelis', [fidelisApp, fidelisApp2], db);
    assert.ok(bulk.count === 2, `bulk exported 2 files (got ${bulk.count})`);
    const bsheet = unzip(bulk.buf).find((p) => p.name === 'xl/worksheets/sheet5.xml').data.toString('utf8');
    assert.ok(/<row r="2"[^>]*>/.test(bsheet) && /<row r="3"[^>]*>/.test(bsheet), 'bulk wrote two data rows');

    // 5) mixed batch rejected
    let mixErr = null;
    try { await tapes.buildBulkTape('fidelis', [fidelisApp, bluelakeApp], db); } catch (e) { mixErr = e; }
    assert.ok(mixErr && mixErr.code === 'buyer_mismatch' && Array.isArray(mixErr.mismatches) && mixErr.mismatches.length === 1, 'mixed bulk rejected with the offending file listed');

    // 6) a soft-deleted file is not exportable (parity with the eligibility route)
    await db.query('UPDATE applications SET deleted_at = now() WHERE id=$1', [fidelisApp2]);
    let delErr = null;
    try { await tapes.buildTape(fidelisApp2, 'fidelis', db); } catch (e) { delErr = e; }
    assert.ok(delErr && delErr.code === 'loan_not_found', 'soft-deleted file is not exportable');

    // 7) New-Construction questionnaire: a ground-up loan needs the 5 NC fields,
    //    answering them persists + fills, and a later export doesn't re-ask.
    const ncApp = uuid();
    created.apps.push(ncApp);
    await db.query(
      `INSERT INTO applications (id,borrower_id,status,ys_loan_number,lender,property_address,program,loan_type,rehab_type,property_type,units,purchase_price,as_is_value,arv,loan_amount,rate_pct,term)
       VALUES ($1,$2,'processing',$3,'Fidelis',$4,'Ground-Up Construction','Purchase','ground','Single Family',1,300000,150000,600000,420000,11,'18 months')`,
      [ncApp, bId, `YSCAP-TP-${SUFFIX}-NC`, JSON.stringify({ line1: '1 Builder Rd', city: 'Newark', state: 'NJ', zip: '07104' })]);
    const q1 = await tapes.tapeQuestions(ncApp, 'fidelis', db);
    assert.ok(q1.newConstruction === true && q1.questions.length === 5, `ground-up loan asks 5 questions (got ${q1.questions.length})`);
    assert.ok(q1.questions.some((f) => f.key === 'build_status' && Array.isArray(f.options)), 'a question is a dropdown with options');
    // Answer them (with one invalid select to prove validation drops it) + export.
    const saved = await tapes.persistSupplemental(ncApp, 'fidelis', { asset_purchased: 'Land', entitlement_status: 'BAD_VALUE', build_status: 'Framing', lot_purchase_price: '95000', lot_purchase_date: '2026-02-15', junk: 'x' }, db);
    assert.ok(!('entitlement_status' in saved) && saved.build_status === 'Framing' && saved.lot_purchase_price === 95000, 'persist validates: drops out-of-list select, keeps valid');
    const q2 = await tapes.tapeQuestions(ncApp, 'fidelis', db);
    assert.ok(q2.questions.length === 1 && q2.questions[0].key === 'entitlement_status', 'only the still-unanswered field is re-asked');
    const ncTape = await tapes.buildTape(ncApp, 'fidelis', db);
    const ncSheet = unzip(ncTape.buf).find((p) => p.name === 'xl/worksheets/sheet5.xml').data.toString('utf8');
    assert.ok(/<c r="AT2"[^>]*>[\s\S]*?Framing/.test(ncSheet), 'build status fills column AT');
    assert.ok(ncSheet.indexOf('<v>95000</v>') > -1, 'lot purchase price fills column AU');

    // A non-new-construction loan asks nothing.
    const q3 = await tapes.tapeQuestions(fidelisApp, 'fidelis', db);
    assert.ok(q3.newConstruction === false && q3.questions.length === 0, 'a non-NC loan needs no questionnaire');

    console.log('test-tape-export-db: OK');
  } finally {
    await db.query('DELETE FROM applications WHERE id = ANY($1::uuid[])', [created.apps]).catch(() => {});
    await db.query('DELETE FROM borrowers WHERE id=$1', [created.borrower]).catch(() => {});
    if (db.pool && db.pool.end) await db.pool.end().catch(() => {});
    else if (db.end) await db.end().catch(() => {});
  }
}

main().catch((e) => { console.error('test-tape-export-db FAILED:', e); process.exit(1); });
