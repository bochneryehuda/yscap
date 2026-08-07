/**
 * THE APPRAISALS WE CANNOT READ ARE COUNTED (db/438) — and UAD 3.6 is no longer
 * one of them.
 *
 * UAD 3.6 / MISMO 3.6 becomes MANDATORY for Fannie Mae and Freddie Mac appraisals
 * on 2 NOVEMBER 2026. This file used to assert that such a report was REFUSED with
 * a named reason, which was the right posture while PILOT read only UAD 2.6 — and
 * from that date would have been the answer to every new report. `extract()` now
 * ROUTES a MISMO 3.x appraisal to `extract36`, so a real 3.6 report IMPORTS and
 * records no refusal at all. The assertions below were rewritten for that.
 *
 * What did NOT change, and is still asserted: the ledger itself, and the fact that
 * the three kinds are kept apart. Somebody attaching a loan-application export
 * instead of the appraisal is a different problem with a different answer (no
 * reader fixes it), and counting the two together buries the number that matters
 * inside the number that does not. `uad_3_6` is kept — a 3.6 file can still be
 * refused for an ordinary reason — and it should now read ZERO; a number there
 * means the READER has a gap, not that the format has arrived.
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

  // THE ID PRODUCTION ACTUALLY PASSES. `importedBy` is `req.actor.id`, and both
  // import routes sit behind `requireStaff`, so it is a `staff_users` id — the
  // one value the first version of this test never used, which is exactly why a
  // foreign key to `borrowers` sat here discarding every real refusal while the
  // test stayed green.
  const staffId = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active)
     VALUES ($1,'Fmt Staff','admin',true) RETURNING id`,
    [`fmtstaff-${process.pid}@example.test`])).rows[0].id;

  // A UAD 3.6 envelope carrying NO comparable grid — a 3.6-labelled file that is
  // still not an appraisal. It must be filed under the DOCUMENT problem, never
  // under the version: `uad_3_6` means "a real appraisal the reader cannot read".
  const uad36NoGrid = `<?xml version="1.0"?><MESSAGE MISMOReferenceModelIdentifier="3.6">
    <ABOUT_VERSIONS/><DEAL_SETS><DEAL_SET><DEALS><DEAL>
    <COLLATERALS><COLLATERAL><PROPERTIES><PROPERTY/></PROPERTIES></COLLATERAL></COLLATERALS>
    </DEAL></DEALS></DEAL_SET></DEAL_SETS></MESSAGE>`;
  const rNoGrid = await importAppraisal(db, { applicationId: appId, xml: uad36NoGrid, importedBy: staffId });
  ok(!rNoGrid.ok && /comparable sales grid/i.test(rNoGrid.error || ''),
    'a UAD 3.6 envelope with no comparable grid is refused for the DOCUMENT, not the version');
  const asStaff = (await db.query(
    `SELECT count(*)::int n FROM appraisal_format_refusals
      WHERE application_id = $1 AND refused_by = $2`, [appId, staffId])).rows[0].n;
  ok(asStaff === 1, `a refusal by a STAFF user is recorded (${asStaff}) — the id every production route passes`);

  // A REAL UAD 3.6 appraisal — the one that used to be turned away. It IMPORTS now,
  // and records NOTHING in the refusal ledger.
  const uad36 = `<?xml version="1.0"?><MESSAGE MISMOReferenceModelIdentifier="3.6.0">
    <DEAL_SETS><DEAL_SET><DEALS><DEAL><COLLATERALS><COLLATERAL>
      <SUBJECT_PROPERTY>
        <ADDRESS><AddressLineText>9 Redesign Way</AddressLineText><CityName>Newark</CityName>
          <StateCode>NJ</StateCode><PostalCode>07103</PostalCode></ADDRESS>
        <PROPERTY_DETAIL><PropertyStructureBuiltYear>1978</PropertyStructureBuiltYear>
          <PropertyDwellingUnitCount>1</PropertyDwellingUnitCount></PROPERTY_DETAIL>
        <STRUCTURE><STRUCTURE_DETAIL>
          <GrossLivingAreaSquareFeetNumber>1420</GrossLivingAreaSquareFeetNumber>
          <TotalBedroomCount>3</TotalBedroomCount></STRUCTURE_DETAIL></STRUCTURE>
      </SUBJECT_PROPERTY>
      <SALES_COMPARISON><COMPARABLE_SALE>
        <ADDRESS><AddressLineText>11 Redesign Way</AddressLineText></ADDRESS>
        <SalesContractAmount>402000</SalesContractAmount>
        <ClosedDate>2026-04-11</ClosedDate>
        <GrossLivingAreaSquareFeetNumber>1400</GrossLivingAreaSquareFeetNumber>
      </COMPARABLE_SALE></SALES_COMPARISON>
      <VALUATION><PROPERTY_VALUATION_DETAIL>
        <PropertyAppraisedValueAmount>410000</PropertyAppraisedValueAmount>
        <PropertyValuationEffectiveDate>2026-05-02</PropertyValuationEffectiveDate>
        <AppraisalConditionType>AsIs</AppraisalConditionType>
      </PROPERTY_VALUATION_DETAIL></VALUATION>
    </COLLATERAL></COLLATERALS></DEAL></DEALS></DEAL_SET></DEAL_SETS></MESSAGE>`;
  const before36 = (await db.query(
    `SELECT count(*)::int n FROM appraisal_format_refusals WHERE application_id=$1`, [appId])).rows[0].n;
  const r36 = await importAppraisal(db, { applicationId: appId, xml: uad36, importedBy: staffId });
  ok(r36.ok === true, `a real UAD 3.6 appraisal IMPORTS${r36.ok ? '' : ' — ' + (r36.error || '')}`);
  const after36 = (await db.query(
    `SELECT count(*)::int n FROM appraisal_format_refusals WHERE application_id=$1`, [appId])).rows[0].n;
  ok(after36 === before36, 'and records no refusal — the format is no longer an exposure');
  const stored36 = (await db.query(
    `SELECT subject_address, gla, beds FROM appraisals
      WHERE application_id=$1 AND superseded=false ORDER BY imported_at DESC LIMIT 1`, [appId])).rows[0];
  ok(stored36 && stored36.subject_address === '9 Redesign Way' && Number(stored36.gla) === 1420 && stored36.beds === 3,
    `and the 3.6 subject actually landed in the appraisals table (${stored36 ? stored36.subject_address : 'no row'})`);

  // SCOPED TO THIS FILE'S OWN APPLICATION, never global. The suite shares ONE
  // database, other tests import appraisals, and a global count therefore
  // depends on what ran before it — which is how this test passed locally and
  // failed in CI. It also makes the file re-runnable: the rows deliberately
  // survive their application (ON DELETE SET NULL), so a second run against the
  // same database would otherwise see the first run's rows.
  const rows = (await db.query(
    `SELECT kind, count(*)::int n FROM appraisal_format_refusals
      WHERE application_id = $1 GROUP BY kind ORDER BY kind`, [appId])).rows;
  console.log('  recorded:', JSON.stringify(rows));
  const byKind = Object.fromEntries(rows.map((r) => [r.kind, r.n]));
  ok((byKind.uad_3_6 || 0) === 0,
    `nothing is filed as an unreadable UAD 3.6 (${byKind.uad_3_6 || 0}) — the reader handles the format now`);
  ok((byKind.not_appraisal || 0) >= 4,
    `the wrong-document refusals are recorded SEPARATELY (${byKind.not_appraisal || 0}) — including the 3.6-labelled one, filed for the DOCUMENT rather than the version`);

  const counts = await formatRefusalCounts(db);
  ok(counts.ok && counts.uad36.n === 0 && counts.notAppraisal.n >= 4,
    `the count reads back: ${counts.uad36.n} unreadable-format, ${counts.notAppraisal.n} wrong-document, mandatory from ${counts.mandatoryFrom}`);
  ok(counts.mandatoryFrom === '2026-11-02' && /2\.6/.test(counts.reads || '') && /3\.6/.test(counts.reads || ''),
    `and it states the deadline and BOTH standards we read (${counts.reads})`);

  // AND IT CANNOT HURT THE IMPORT. Drop the table and refuse again: the caller
  // must still get its clean refusal, not a 500.
  await db.query(`ALTER TABLE appraisal_format_refusals RENAME TO appraisal_format_refusals_x`);
  let survived = true; let err = null;
  try {
    const r2 = await importAppraisal(db, { applicationId: appId, xml: uad36NoGrid, importedBy: bid });
    survived = !r2.ok && /comparable sales grid/i.test(r2.error || '');
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

  // The refusal rows deliberately OUTLIVE their application (the count must not
  // be erasable by deleting a loan file), so this file cleans up its own.
  await db.query(`DELETE FROM appraisal_format_refusals WHERE application_id=$1`, [appId]);
  await db.query(`DELETE FROM applications WHERE borrower_id=$1`, [bid]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [bid]);
  await db.query(`DELETE FROM staff_users WHERE email=$1`, [`fmtstaff-${process.pid}@example.test`]);
  console.log(fails ? `\ntest-appraisal-format-refusals-db: ${fails} FAILED` : '\ntest-appraisal-format-refusals-db: all passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e && e.message, e && e.stack); process.exit(1); });
