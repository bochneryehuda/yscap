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
  // BOTH CI jobs run the one chain and `test` has no database at all, so this must
  // skip rather than dial one — an unguarded DB suite in the chain takes the build
  // down, and with it the deploy. The probe is a plain SELECT 1 and answers in
  // milliseconds; it is deliberately not a try/catch around ensureSchema, which
  // does not throw when the database is unreachable (it retries ~75s, then
  // RESOLVES, so the suite would sail past and die on its first real query).
  await require(__dirname + '/lib/db-gate').skipUnlessDb('mismo');
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
                              rehab_type,loan_amount,ltv,dscr_ratio,rate_pct,term,ppp,requested_exp_flips,sqft_pre,sqft_post,
                              rental_income,property_taxes,title_company,expected_closing,is_assignment,underlying_contract_price,assignment_fee)
     VALUES ($1,$2,$3,$4,$5,'Fix & Flip','Refinance — Cash-Out','Investment',$6,'Multi 2-4',3,
             420000,400000,560000,85000,'Heavy',375000,0.75,1.15,10.75,'12 months','3-2-1',5,1800,2400,
             3800,6000,'ABC Title','2026-08-15',true,400000,20000) RETURNING id`,
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
  assert.strictEqual(parsed.loan.loanType, 'Refinance — Cash-Out', 'preview real refi loan type');
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
  assert.strictEqual(na.loan_type, 'Refinance — Cash-Out', 'new file loan type (real vocab)');
  // A REFINANCE CARRIES NO PURCHASE PRICE — and this file is 'Refinance — Cash-Out'
  // (asserted twice above). Owner-directed 2026-08-02: a refinance is sized on the
  // AS-IS VALUE and never stores a purchase price at ANY door, the MISMO import
  // named among them. The fixture below writes one with raw SQL, which no real
  // door would accept, so this asserts the import NORMALISES that contradiction
  // rather than reproducing it. This block used to expect 420000 — written before
  // that rule existed, and never once run because the suite was outside the chain.
  assert.strictEqual(na.purchase_price, null, 'a refinance imports with NO purchase price');
  assert.strictEqual(Number(na.as_is_value), 400000, 'new file as-is value — the basis a refinance is actually sized on');
  assert.strictEqual(Number(na.arv), 560000, 'new file ARV (from extension)');
  assert.strictEqual(Number(na.rehab_budget), 85000, 'new file rehab budget');
  assert.strictEqual(na.occupancy, 'Investment', 'new file occupancy');
  assert.strictEqual(na.property_address.line1, '392 Columbia Ave', 'new file property street');
  assert.strictEqual(na.property_type, 'Multi 2-4', 'new file property type (from extension)');
  assert.strictEqual(na.ppp, '3-2-1', 'new file prepayment penalty');
  assert.strictEqual(na.requested_exp_flips, 5, 'new file experience (drives sizing) preserved');
  assert.strictEqual(na.sqft_pre, 1800, 'new file sqft pre');
  assert.strictEqual(na.sqft_post, 2400, 'new file sqft post');
  assert.strictEqual(Number(na.rental_income), 3800, 'new file rental income (from MISMO PROPERTY_DETAIL)');
  assert.strictEqual(Number(na.property_taxes), 6000, 'new file property taxes (from extension)');
  assert.strictEqual(na.title_company, 'ABC Title', 'new file title company (from extension)');
  assert.strictEqual(String(na.expected_closing).slice(0, 10), '2026-08-15', 'new file estimated closing date');
  // AND THE ASSIGNMENT IS FORCED OFF ON A REFINANCE — you cannot be assigned a
  // purchase contract on a property you already own. `fields.assignmentFields` has
  // done this since #96 and is the same chokepoint that drops the purchase price.
  // The PARSE still carries the assignment faithfully (parsed.extras really does
  // hold isAssignment:true, underlyingContractPrice:400000, assignmentFee:20000),
  // so this pins WHERE the refusal happens: at the write door, not by losing data
  // on the way in — which is what makes it a guard rather than a coincidence.
  assert.strictEqual(parsed.extras.isAssignment, true, 'the preview still PARSES the assignment from the file');
  assert.strictEqual(na.is_assignment, false, '…but a refinance is never stored as an assignment');
  assert.strictEqual(na.assignment_fee, null, 'no assignment fee on a refinance');
  assert.strictEqual(na.underlying_contract_price, null, 'no underlying contract price on a refinance');
  assert.strictEqual(na.source, 'mismo_import', 'new file source tag');
  assert.strictEqual(na.status, 'file_intake', 'imported file starts in DATA INTAKE status (not active)');
  assert(na.co_borrower_id, 'new file has a co-borrower');
  assert(na.llc_id, 'new file has a vesting entity');
  console.log('  ✓ createFromParsed created a fully-populated new application (incl. experience, PPP, sqft, property type)');

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
  // The import fans out "needs assignment" email, and notify._track()s that write
  // WITHOUT awaiting it — so the sent_emails INSERT was still in flight when the
  // pool closed, printing "Cannot use a pool after calling end on the pool". Same
  // shape #1226 drained in twelve suites; harmless here only because this teardown
  // has no cleanup DELETE to deadlock against, which is luck rather than design.
  await require('../src/lib/notify').drainEmails();
  await db.pool.end();
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
