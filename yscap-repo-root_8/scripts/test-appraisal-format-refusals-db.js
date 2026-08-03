/**
 * THE APPRAISALS WE CANNOT READ ARE COUNTED (db/438).
 *
 * UAD 3.6 / MISMO 3.x becomes MANDATORY for Fannie Mae and Freddie Mac appraisals
 * on 2 NOVEMBER 2026, and PILOT reads UAD 2.6. From that date the appraisal desk
 * stops working on new reports: no comparables, no as-is value, no ARV, no
 * findings, nothing into the research warehouse.
 *
 * The parser already recognised the format and refused it honestly. What nothing
 * did was REMEMBER — the refusal was a sentence shown to one officer and then
 * discarded, so "how many did we turn away last month?" had no answer, and that
 * is the only question that says whether the exposure is still theoretical.
 *
 * The three kinds are kept apart deliberately: a real appraisal in a format we
 * cannot read is a different problem from somebody attaching a loan-application
 * export instead of the appraisal, and counting them together buries the number
 * that matters inside the number that does not.
 *
 * Needs a database. Skips cleanly without DATABASE_URL.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

if (!process.env.DATABASE_URL) {
  console.log('test-appraisal-format-refusals-db: skipped (no DATABASE_URL)');
  process.exit(0);
}

(async () => {
  const db = require(path.join(ROOT, 'src/db'));
  const { ensureSchema } = require(path.join(ROOT, 'src/migrate-boot'));
  const { importAppraisal, formatRefusalCounts } = require(path.join(ROOT, 'src/lib/appraisal/import'));
  await ensureSchema();

  const bid = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Fmt','T',$1) RETURNING id`,
    [`fmt-${process.pid}@example.test`])).rows[0].id;
  const appId = (await db.query(
    `INSERT INTO applications (borrower_id, property_address, loan_type)
     VALUES ($1,$2,'rtl') RETURNING id`,
    [bid, JSON.stringify({ line1: '1 Format Rd', city: 'New Haven', state: 'CT' })])).rows[0].id;

  // The three real iLAD exports in the corpus — the wrong document, not a 3.6 file.
  // An Encompass iLAD loan-application export — the WRONG DOCUMENT, not a 3.6
  // appraisal. All three of today's real refusals are this shape.
  const iladXml = `<?xml version="1.0"?><MESSAGE MISMOReferenceModelIdentifier="3.4"
    xmlns:ILAD="http://www.datamodelextension.org/Schema/ILAD">
    <DEAL_SETS><DEAL_SET><DEALS><DEAL><LOANS><LOAN/></LOANS></DEAL></DEALS></DEAL_SET></DEAL_SETS></MESSAGE>`;
  let ilad = 0;
  for (let i = 0; i < 3; i++) {
    const r = await importAppraisal(db, { applicationId: appId, xml: iladXml, importedBy: bid });
    if (!r.ok) ilad++;
  }
  ok(ilad === 3, `${ilad} loan-application exports were refused (and the import still returned cleanly)`);

  // A synthetic UAD 3.6 appraisal — the one that matters.
  const uad36 = `<?xml version="1.0"?><MESSAGE MISMOReferenceModelIdentifier="3.6">
    <ABOUT_VERSIONS/><DEAL_SETS><DEAL_SET><DEALS><DEAL>
    <COLLATERALS><COLLATERAL><PROPERTIES><PROPERTY>
    <SALES_COMPARISON><COMPARABLE_SALE/></SALES_COMPARISON></PROPERTY></PROPERTIES></COLLATERAL></COLLATERALS>
    </DEAL></DEALS></DEAL_SET></DEAL_SETS></MESSAGE>`;
  const r36 = await importAppraisal(db, { applicationId: appId, xml: uad36, importedBy: bid });
  ok(!r36.ok && /3\.6|3\.x/.test(r36.error || ''), `a UAD 3.6 file is refused with a named reason`);

  const rows = (await db.query(
    `SELECT kind, count(*)::int n FROM appraisal_format_refusals GROUP BY kind ORDER BY kind`)).rows;
  console.log('  recorded:', JSON.stringify(rows));
  const byKind = Object.fromEntries(rows.map((r) => [r.kind, r.n]));
  ok((byKind.uad_3_6 || 0) === 1, `the UAD 3.6 refusal is recorded as its OWN kind (${byKind.uad_3_6 || 0})`);
  ok((byKind.not_appraisal || 0) >= 2,
    `the wrong-document refusals are recorded SEPARATELY (${byKind.not_appraisal || 0}) — not buried in the number that matters`);

  const counts = await formatRefusalCounts(db);
  ok(counts.ok && counts.uad36.n === 1 && counts.notAppraisal.n >= 2,
    `the count reads back: ${counts.uad36.n} unreadable-format, ${counts.notAppraisal.n} wrong-document, mandatory from ${counts.mandatoryFrom}`);

  // AND IT CANNOT HURT THE IMPORT. Drop the table and refuse again: the caller
  // must still get its clean refusal, not a 500.
  await db.query(`ALTER TABLE appraisal_format_refusals RENAME TO appraisal_format_refusals_x`);
  let survived = true; let err = null;
  try {
    const r2 = await importAppraisal(db, { applicationId: appId, xml: uad36, importedBy: bid });
    survived = !r2.ok && /3\.6|3\.x/.test(r2.error || '');
  } catch (e) { survived = false; err = e.message; }
  if (!survived && err) console.log('     (threw:', err, ')');
  ok(survived, `with the table missing the refusal still comes back clean${err ? ' — threw: ' + err : ''}`);
  await db.query(`ALTER TABLE appraisal_format_refusals_x RENAME TO appraisal_format_refusals`);

  // A GOOD appraisal is completely unaffected.
  const good = `<?xml version="1.0"?><VALUATION_RESPONSE>
<REPORT AppraisalFormType="FNM1004"><PROPERTY><SALES_COMPARISON>
<COMPARABLE_SALE PropertySequenceIdentifier="1" SalesPriceAmount="400000">
 <LOCATION PropertyStreetAddress="4 Good Rd" PropertyCity="Newark" PropertyState="NJ" PropertyPostalCode="07103"/>
</COMPARABLE_SALE></SALES_COMPARISON></PROPERTY></REPORT></VALUATION_RESPONSE>`;
  const before = (await db.query(`SELECT count(*)::int n FROM appraisal_format_refusals`)).rows[0].n;
  const rg = await importAppraisal(db, { applicationId: appId, xml: good, importedBy: bid });
  const after = (await db.query(`SELECT count(*)::int n FROM appraisal_format_refusals`)).rows[0].n;
  ok(rg.ok, 'a readable appraisal still imports');
  ok(after === before, 'and records no refusal');

  await db.query(`DELETE FROM applications WHERE borrower_id=$1`, [bid]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [bid]);
  console.log(fails ? `\ntest-appraisal-format-refusals-db: ${fails} FAILED` : '\ntest-appraisal-format-refusals-db: all passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e && e.message, e && e.stack); process.exit(1); });
