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
    // Register a product for a loan so the non-admin export gate (registered +
    // program-match) can pass. Gold↔Blue Lake, Standard↔Fidelis (program-provider.js).
    const reg = (id, program) => db.query(
      `INSERT INTO product_registrations (application_id, program, inputs, quote, is_current)
       VALUES ($1, $2, '{}'::jsonb, '{}'::jsonb, true)`, [id, program]);
    await mk(fidelisApp, `YSCAP-TP-${SUFFIX}-A`, 'Fidelis', '10 Fidelis Way');
    await mk(fidelisApp2, `YSCAP-TP-${SUFFIX}-B`, 'Fidelis', '12 Fidelis Way');
    await mk(bluelakeApp, `YSCAP-TP-${SUFFIX}-C`, 'Blue Lake', '14 Lake Rd');
    await reg(fidelisApp, 'standard'); await reg(fidelisApp2, 'standard'); await reg(bluelakeApp, 'gold');

    // 1) single Fidelis tape — a NON-admin standard+Fidelis loan exports fine.
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

    // 3) availability reflects the loan's provider AND registered program
    const key = require('../src/lib/conditions/field-registry').normNoteBuyer('Fidelis');
    assert.ok(tapes.tapeAvailability(key, 'Fidelis', { registeredProgram: 'standard' })[0].available === true, 'availability true for a standard+Fidelis loan');

    // 4) bulk: two Fidelis files → 2 rows
    const bulk = await tapes.buildBulkTape('fidelis', [fidelisApp, fidelisApp2], db);
    assert.ok(bulk.count === 2, `bulk exported 2 files (got ${bulk.count})`);
    const bsheet = unzip(bulk.buf).find((p) => p.name === 'xl/worksheets/sheet5.xml').data.toString('utf8');
    assert.ok(/<row r="2"[^>]*>/.test(bsheet) && /<row r="3"[^>]*>/.test(bsheet), 'bulk wrote two data rows');

    // 5) mixed batch rejected — a Blue Lake file can't ride the Fidelis bulk tape
    let mixErr = null;
    try { await tapes.buildBulkTape('fidelis', [fidelisApp, bluelakeApp], db); } catch (e) { mixErr = e; }
    assert.ok(mixErr && mixErr.code === 'bulk_gate_failed' && Array.isArray(mixErr.mismatches) && mixErr.mismatches.length === 1, 'mixed bulk rejected with the offending file listed');
    assert.ok(mixErr.mismatches[0].code === 'buyer_mismatch', 'the offending file is flagged as a provider mismatch');

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
    await reg(ncApp, 'standard');
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

    // Persist is gated: a non-new-construction loan can't accrue NC supplemental
    // even if answers are posted (a crafted request), and nothing is written.
    const skip = await tapes.persistSupplemental(fidelisApp, 'fidelis', { asset_purchased: 'Land', build_status: 'Framing' }, db);
    assert.ok(Object.keys(skip).length === 0, 'persist skips a non-new-construction loan');
    const stored = (await db.query('SELECT tape_supplemental FROM applications WHERE id=$1', [fidelisApp])).rows[0].tape_supplemental;
    assert.ok(!stored || Object.keys(stored).length === 0, 'non-NC loan has no supplemental written');

    // 8) Blue Lake tape end-to-end + cross-tape buyer rule
    const bl = await tapes.buildTape(bluelakeApp, 'bluelake', db);
    assert.ok(Buffer.isBuffer(bl.buf) && bl.buf.length > 20000, 'Blue Lake tape produced bytes');
    assert.ok(/BlueLake-BidTape-.*\.xlsx/.test(bl.filename), `Blue Lake filename shaped: ${bl.filename}`);
    const blSheet = unzip(bl.buf).find((p) => p.name === 'xl/worksheets/sheet1.xml').data.toString('utf8');
    assert.ok(blSheet.indexOf(`YSCAP-TP-${SUFFIX}-C`) > -1, 'Blue Lake Bid Tape carries the loan number');
    assert.ok(/<c r="AJ3"[^>]*><f>AF3\+AH3<\/f><\/c>/.test(blSheet), 'Blue Lake per-row formula (total project costs) preserved');
    assert.ok(unzip(bl.buf).find((p) => p.name === 'xl/media/image1.png'), 'Blue Lake logo image preserved');

    let bmErr = null;
    try { await tapes.buildTape(fidelisApp, 'bluelake', db); } catch (e) { bmErr = e; }
    assert.ok(bmErr && bmErr.code === 'buyer_mismatch', 'a Fidelis loan is blocked from the Blue Lake tape');
    let bmErr2 = null;
    try { await tapes.buildTape(bluelakeApp, 'fidelis', db); } catch (e) { bmErr2 = e; }
    assert.ok(bmErr2 && bmErr2.code === 'buyer_mismatch', 'a Blue Lake loan is blocked from the Fidelis tape');
    const blQ = await tapes.tapeQuestions(bluelakeApp, 'bluelake', db);
    assert.ok(blQ.questions.length === 0, 'Blue Lake tape asks no supplemental questions');
    // A brand-new Fidelis file (no draws, no payment dates) is NOT seasoned.
    assert.ok(q3.seasoned === null, 'a fresh loan needs no seasoned confirmation');

    // 9) SEASONED loan: a released draw + past payment dates move the CURRENT
    //    columns. This exercises the real draw_disbursements query in assemble.js
    //    (a pure test can't catch a wrong column name).
    const seasonedApp = uuid();
    created.apps.push(seasonedApp);
    await db.query(
      `INSERT INTO applications (id,borrower_id,status,ys_loan_number,lender,property_address,rehab_budget,requested_ir_amount,property_type,loan_type,units,purchase_price,as_is_value,arv,loan_amount,rate_pct,term,accrual_type,actual_closing,first_payment_date,maturity_date)
       VALUES ($1,$2,'funded',$3,'Fidelis',$4,80000,12000,'Single Family','Purchase',1,300000,310000,450000,360000,10.5,'12 months','non_dutch','2026-01-01','2026-03-01','2027-02-01')`,
      [seasonedApp, bId, `YSCAP-TP-${SUFFIX}-SZ`, JSON.stringify({ line1: '9 Season St', city: 'Newark', state: 'NJ', zip: '07104' })]);
    await reg(seasonedApp, 'standard');
    // Record a $30,000 released rehab draw (integer cents), dated a few months ago.
    await db.query(
      `INSERT INTO draw_disbursements (application_id, approved_cents, net_release_cents, funded_status, kind, release_date)
       VALUES ($1, 3000000, 3000000, 'released', 'draw', '2026-04-01')`, [seasonedApp]);
    // Also a NON-released (pending) draw that must NOT be counted.
    await db.query(
      `INSERT INTO draw_disbursements (application_id, approved_cents, net_release_cents, funded_status, kind, release_date)
       VALUES ($1, 1000000, 1000000, 'pending', 'draw', '2026-05-01')`, [seasonedApp]);

    const sq = await tapes.tapeQuestions(seasonedApp, 'fidelis', db);
    assert.ok(sq.seasoned && sq.seasoned.isSeasoned === true, 'seasoned loan flagged for confirmation');
    assert.ok(sq.seasoned.fields.length === 3, 'seasoned confirmation asks 3 values (balance / reserve / next due)');
    assert.ok(sq.seasoned.breakdown.releasedDraws === 30000, `only the RELEASED draw counts ($30k, got ${sq.seasoned.breakdown.releasedDraws})`);
    assert.ok(sq.seasoned.breakdown.day1 === 268000, `day-1 advance = 360k − 80k holdback − 12k reserve (got ${sq.seasoned.breakdown.day1})`);

    const szTape = await tapes.buildTape(seasonedApp, 'fidelis', db);
    const szSheet = unzip(szTape.buf).find((p) => p.name === 'xl/worksheets/sheet5.xml').data.toString('utf8');
    assert.ok(/<c r="J2"[^>]*><v>50000<\/v><\/c>/.test(szSheet), 'seasoned: J current rehab = 80k − 30k released = 50k');
    assert.ok(/<c r="I2"[^>]*><v>80000<\/v><\/c>/.test(szSheet), 'seasoned: I financed rehab stays at 80k');

    // A confirmed override rides through the export and wins over the computed value.
    const szOver = await tapes.buildTape(seasonedApp, 'fidelis', db, { seasonedOverrides: { current_balance: 305000 } });
    const szOverSheet = unzip(szOver.buf).find((p) => p.name === 'xl/worksheets/sheet5.xml').data.toString('utf8');
    assert.ok(/<c r="K2"[^>]*><v>305000<\/v><\/c>/.test(szOverSheet), 'seasoned override: K current balance uses the confirmed value');

    // 10) EMCAP tape end-to-end: a fix-and-hold EMCAP loan exports its one-sheet
    //     tape, the estimated monthly rent fills the Proj. Rental column (U), and
    //     the buyer rule keeps a non-EMCAP loan off it.
    const emcapApp = uuid();
    created.apps.push(emcapApp);
    await db.query(
      `INSERT INTO applications (id,borrower_id,status,ys_loan_number,lender,property_address,program,loan_type,rehab_type,property_type,units,purchase_price,as_is_value,arv,rehab_budget,requested_ir_amount,loan_amount,rate_pct,term,estimated_rental_income)
       VALUES ($1,$2,'processing',$3,'EMCAP',$4,'Fix & Hold','Purchase','moderate','Single Family',1,300000,310000,450000,80000,12000,360000,10.5,'12 months',2500)`,
      [emcapApp, bId, `YSCAP-TP-${SUFFIX}-EM`, JSON.stringify({ line1: '9 Rent Rd', city: 'Newark', state: 'NJ', zip: '07104' })]);
    // EMCAP↔Silver is PARKED (no live program), so the EMCAP tape is admin-only:
    // export it as an admin (isAdmin) to verify content.
    await reg(emcapApp, 'standard');
    const em = await tapes.buildTape(emcapApp, 'emcap', db, { isAdmin: true });
    assert.ok(Buffer.isBuffer(em.buf) && em.buf.length > 5000 && /EMCAP-Tape-.*\.xlsx/.test(em.filename), 'EMCAP tape produced bytes with a shaped filename');
    const emSheet = unzip(em.buf).find((p) => p.name === 'xl/worksheets/sheet1.xml').data.toString('utf8');
    assert.ok(emSheet.indexOf(`YSCAP-TP-${SUFFIX}-EM`) > -1, 'EMCAP tape carries the loan number');
    assert.ok(/<c r="U2"[^>]*><v>2500<\/v><\/c>/.test(emSheet), 'EMCAP Proj. Rental (U) = estimated monthly rent (2500)');
    assert.ok(/<c r="J2"[^>]*><v>360000<\/v><\/c>/.test(emSheet), 'EMCAP total loan (J) filled');
    // Buyer rule: a Fidelis loan is blocked from the EMCAP tape and vice-versa.
    let emErr = null;
    try { await tapes.buildTape(fidelisApp, 'emcap', db); } catch (e) { emErr = e; }
    assert.ok(emErr && emErr.code === 'buyer_mismatch', 'a Fidelis loan is blocked from the EMCAP tape');
    let emErr2 = null;
    try { await tapes.buildTape(emcapApp, 'fidelis', db); } catch (e) { emErr2 = e; }
    assert.ok(emErr2 && emErr2.code === 'buyer_mismatch', 'an EMCAP loan is blocked from the Fidelis tape');
    // A fix-and-hold EMCAP loan asks no new-construction questions.
    const emQ = await tapes.tapeQuestions(emcapApp, 'emcap', db);
    assert.ok(emQ.questions.length === 0, 'a fix-and-hold EMCAP loan asks no supplemental questions');

    // 11) The NON-ADMIN export gate end-to-end (owner-directed 2026-07-26):
    //     register-first, manual admin-only (+ admin bypass), and program-match.
    const gUnreg = uuid(), gManual = uuid(), gProg = uuid();
    created.apps.push(gUnreg, gManual, gProg);
    await mk(gUnreg, `YSCAP-TP-${SUFFIX}-G1`, 'Fidelis', '20 Gate St');   // NOT registered
    await mk(gManual, `YSCAP-TP-${SUFFIX}-G2`, 'Fidelis', '22 Gate St');
    await mk(gProg, `YSCAP-TP-${SUFFIX}-G3`, 'Fidelis', '24 Gate St');
    await reg(gManual, 'manual');   // admin-approved
    await reg(gProg, 'gold');       // provider Fidelis but registered Gold → program mismatch

    // (a) unregistered → not_registered for a non-admin; admin can still export.
    let e1 = null; try { await tapes.buildTape(gUnreg, 'fidelis', db); } catch (e) { e1 = e; }
    assert.ok(e1 && e1.code === 'not_registered', 'a non-admin can\'t export an unregistered loan');
    const a1 = await tapes.buildTape(gUnreg, 'fidelis', db, { isAdmin: true });
    assert.ok(Buffer.isBuffer(a1.buf) && a1.buf.length > 10000, 'an admin CAN export an unregistered loan');

    // (b) manual → admin-only. Non-admin blocked (403 code); admin exports.
    let e2 = null; try { await tapes.buildTape(gManual, 'fidelis', db); } catch (e) { e2 = e; }
    assert.ok(e2 && e2.code === 'manual_admin_only' && e2.status === 403, 'a manual loan is admin-only for a non-admin');
    const a2 = await tapes.buildTape(gManual, 'fidelis', db, { isAdmin: true });
    assert.ok(Buffer.isBuffer(a2.buf), 'an admin CAN export a manual loan\'s tape');

    // (c) provider matches but wrong program → program_mismatch (Fidelis loan reg. Gold).
    let e3 = null; try { await tapes.buildTape(gProg, 'fidelis', db); } catch (e) { e3 = e; }
    assert.ok(e3 && e3.code === 'program_mismatch' && e3.requiredProgram === 'standard', 'a Fidelis loan registered Gold → program_mismatch (needs Standard)');
    const a3 = await tapes.buildTape(gProg, 'fidelis', db, { isAdmin: true });
    assert.ok(Buffer.isBuffer(a3.buf), 'an admin bypasses the program mismatch');

    // (d) bulk gate: a non-admin bulk of [ok standard+fidelis, manual, unregistered]
    //     rejects the batch listing each offender + reason. Admin bulk exports all.
    let bg = null; try { await tapes.buildBulkTape('fidelis', [fidelisApp, gManual, gUnreg], db); } catch (e) { bg = e; }
    assert.ok(bg && bg.code === 'bulk_gate_failed' && bg.mismatches.length === 2, 'non-admin bulk rejects the manual + unregistered files');
    const abulk = await tapes.buildBulkTape('fidelis', [fidelisApp, gManual, gUnreg], db, { isAdmin: true });
    assert.ok(abulk.count === 3, 'an admin bulk-exports all three regardless of program/registration');

    console.log('test-tape-export-db: OK');
  } finally {
    await db.query('DELETE FROM applications WHERE id = ANY($1::uuid[])', [created.apps]).catch(() => {});
    await db.query('DELETE FROM borrowers WHERE id=$1', [created.borrower]).catch(() => {});
    if (db.pool && db.pool.end) await db.pool.end().catch(() => {});
    else if (db.end) await db.end().catch(() => {});
  }
}

main().catch((e) => { console.error('test-tape-export-db FAILED:', e); process.exit(1); });
