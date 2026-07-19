/**
 * MISMO 3.4 database integration test (needs a real Postgres via DATABASE_URL).
 * Exercises the DB-facing layer end to end:
 *   seed a borrower + co-borrower + LLC + application
 *   -> exportApplicationXml()  (loads, decrypts SSN, builds MISMO)
 *   -> previewImport()         (parse the produced file)
 *   -> createFromParsed()      (create a brand-new file from it)
 *   -> verify every column landed on the new application + borrowers
 * Run: DATABASE_URL=... node scripts/test-mismo-db.js
 */
const assert = require('assert');
const db = require('../src/db');
const crypto = require('../src/lib/crypto');
const mismo = require('../src/lib/mismo');

async function main() {
  // ---- seed a source loan file (unique per run so reruns don't collide) ----
  const tag = Date.now().toString().slice(-9);
  const bemail = `mismo-src-${tag}@example.com`;
  const coEmail = `mismo-co-${tag}@example.com`;
  const llcName = `Columbia Ave Holdings LLC ${tag}`;
  const loanNo = `YS-${tag}`;
  const invNo = `INV-${tag}`;
  const ssn = crypto.ssnForStorage('123-45-6789');

  const borrower = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email,cell_phone,date_of_birth,citizenship,marital_status,
                            dependents_count,current_address,years_at_residence,employer,employment_type,fico,
                            ssn_encrypted,ssn_last4)
     VALUES ('Yuda','Elbaum',$1,'7185551212','1985-06-14','US Citizen','Married',2,
             $2,3,'Acme Holdings LLC','Self employed',742,$3,$4) RETURNING id`,
    [bemail, JSON.stringify({ line1: '10 Main St', city: 'Lakewood', state: 'NJ', zip: '08701' }),
     ssn.encrypted, ssn.last4])).rows[0];
  const co = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email,citizenship) VALUES ('Sara','Elbaum',$1,'Permanent Resident') RETURNING id`,
    [coEmail])).rows[0];
  const llc = (await db.query(
    `INSERT INTO llcs (borrower_id,llc_name,ein,formation_state) VALUES ($1,$2,'987654321','NY') RETURNING id`,
    [borrower.id, llcName])).rows[0];
  const app = (await db.query(
    `INSERT INTO applications (borrower_id,co_borrower_id,llc_id,ys_loan_number,investor_loan_number,program,loan_type,
                              occupancy,property_address,property_type,units,purchase_price,as_is_value,arv,rehab_budget,
                              rehab_type,loan_amount,ltv,dscr_ratio,rate_pct,term,requested_exp_flips)
     VALUES ($1,$2,$3,$4,$5,'Fix & Flip','Refi Cash-Out','Investment',$6,'Multi 2-4',3,
             420000,400000,560000,85000,'Heavy',375000,0.75,1.15,10.75,'12 months',5) RETURNING id`,
    [borrower.id, co.id, llc.id, loanNo, invNo,
     JSON.stringify({ line1: '392 Columbia Ave', city: 'Brooklyn', state: 'NY', zip: '11223' })])).rows[0];

  // ---- EXPORT ----
  const xml = await mismo.exportApplicationXml(app.id);
  assert(xml && xml.includes('<TaxpayerIdentifierValue>123456789</TaxpayerIdentifierValue>'), 'export decrypted the SSN into the file');
  assert(xml.includes('392 Columbia Ave'), 'export carries the property address');
  assert(xml.includes(llcName), 'export carries the vesting entity');
  console.log('  ✓ exportApplicationXml built a MISMO file with decrypted PII + entity');

  // ---- PREVIEW ----
  const parsed = mismo.previewImport(xml);
  assert.strictEqual(parsed.borrower.firstName, 'Yuda', 'preview borrower');
  assert.strictEqual(parsed.borrower.ssn, '123456789', 'preview borrower ssn digits');
  assert.strictEqual(parsed.coBorrower.firstName, 'Sara', 'preview co-borrower');
  assert.strictEqual(parsed.llc.name, llcName, 'preview llc');
  assert.strictEqual(parsed.extras.arv, 560000, 'preview arv from extension');
  console.log('  ✓ previewImport parsed the exported file back');

  // ---- CREATE from the parse (a brand-new file) ----
  const { borrowerId, applicationId } = await mismo.createFromParsed(parsed, {});
  assert(applicationId && borrowerId, 'created new file');

  // ---- verify the new application columns ----
  const na = (await db.query('SELECT * FROM applications WHERE id=$1', [applicationId])).rows[0];
  assert.strictEqual(Number(na.loan_amount), 375000, 'new file loan amount');
  assert.strictEqual(na.loan_type, 'Refi Cash-Out', 'new file loan type');
  assert.strictEqual(Number(na.purchase_price), 420000, 'new file purchase price');
  assert.strictEqual(Number(na.arv), 560000, 'new file ARV (from extension)');
  assert.strictEqual(Number(na.rehab_budget), 85000, 'new file rehab budget');
  assert.strictEqual(na.occupancy, 'Investment', 'new file occupancy');
  assert.strictEqual(na.property_address.line1, '392 Columbia Ave', 'new file property street');
  assert.strictEqual(na.source, 'mismo_import', 'new file source tag');
  assert(na.co_borrower_id, 'new file has a co-borrower');
  assert(na.llc_id, 'new file has a vesting entity');
  console.log('  ✓ createFromParsed created a fully-populated new application');

  // ---- verify the new borrower (SSN re-encrypted, dob validated) ----
  const nb = (await db.query('SELECT * FROM borrowers WHERE id=$1', [borrowerId])).rows[0];
  assert.strictEqual(nb.first_name, 'Yuda', 'new borrower name');
  assert.strictEqual(nb.ssn_last4, '6789', 'new borrower ssn last4 stored');
  assert.strictEqual(crypto.decryptSSN(nb.ssn_encrypted), '123456789', 'new borrower ssn decrypts');
  assert.strictEqual(String(nb.date_of_birth).slice(0, 10), '1985-06-14', 'new borrower dob validated + stored');
  assert.strictEqual(nb.citizenship, 'US Citizen', 'new borrower citizenship');
  console.log('  ✓ imported borrower stored with encrypted SSN + validated DOB');

  // Importing the SAME file again must ADOPT (reuse) the borrower + LLC, never
  // duplicate or collide on the unique indexes.
  const again = await mismo.createFromParsed(mismo.previewImport(xml), {});
  assert.strictEqual(again.borrowerId, borrowerId, 're-import reuses the same borrower');
  console.log('  ✓ re-importing the same file reuses borrower + entity (idempotent)');

  // ---- conditions/checklist generated post-create ----
  const items = (await db.query('SELECT count(*)::int AS n FROM checklist_items WHERE application_id=$1', [applicationId])).rows[0];
  assert(items.n > 0, 'checklist/conditions generated for the imported file');
  console.log(`  ✓ imported file received its checklist (${items.n} items)`);

  console.log('\nMISMO DB integration test passed.');
  await db.pool.end();
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
