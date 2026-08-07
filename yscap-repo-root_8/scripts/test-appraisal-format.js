/**
 * Assertions for the appraisal-format detector and the UAD 2.6 / UAD 3.6 dispatch
 * (`src/lib/appraisal/extract`).
 *
 * THIS FILE USED TO ASSERT THE OPPOSITE, and the change is deliberate. Until the 3.6
 * reader shipped, a MISMO 3.x file had to fail LOUDLY with a named reason rather than
 * extract nulls from a format we did not understand — the right posture for a format
 * we could not read, and the wrong one from 2 November 2026, when it becomes the only
 * format the GSEs accept. `extract()` now ROUTES a 3.x appraisal to `extract36`.
 *
 * What did NOT change, and is asserted here: a MISMO 3.x file that is not an appraisal
 * at all (an Encompass iLAD loan-application export, an envelope with no comparable
 * grid) is still refused, still named for what it actually is, and a UAD 2.6 report
 * still reads exactly as it always did.
 */
const { extract, _internals } = require('../src/lib/appraisal/extract');
let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// A MISMO 3.6 envelope with a comparable grid — a real appraisal — IMPORTS.
{
  const xml = '<?xml version="1.0"?><MESSAGE MISMOReferenceModelIdentifier="3.6.0">'
    + '<COLLATERAL><SUBJECT_PROPERTY><ADDRESS><AddressLineText>1 Elm St</AddressLineText>'
    + '<StateCode>NJ</StateCode><PostalCode>07001</PostalCode></ADDRESS>'
    + '<PROPERTY_DETAIL><PropertyDwellingUnitCount>1</PropertyDwellingUnitCount></PROPERTY_DETAIL>'
    + '</SUBJECT_PROPERTY><SALES_COMPARISON>'
    + '<COMPARABLE_SALE><ADDRESS><AddressLineText>3 Elm St</AddressLineText></ADDRESS>'
    + '<SalesContractAmount>250000</SalesContractAmount></COMPARABLE_SALE>'
    + '</SALES_COMPARISON><VALUATION><PropertyAppraisedValueAmount>260000</PropertyAppraisedValueAmount>'
    + '</VALUATION></COLLATERAL></MESSAGE>';
  const r = extract(xml);
  assert(r.ok === true, 'a UAD 3.6 appraisal IMPORTS (it is no longer turned away)');
  assert(r.format && r.format.model === '3.6', 'and reports that it was read as 3.6');
  assert(r.format && r.format.uad36 === true, 'and is flagged UAD 3.6');
  assert(r.subject.address === '1 Elm St', 'with the subject read out of the 3.6 shape');
  assert(r.comparables.length === 1, 'and its comparable grid read');
  assert(r.formType === 'FNM1004', 'and the equivalent legacy form derived from the dwelling count');
}

// A MISMO 3.x envelope with NO grid is not an appraisal — refused, and named honestly.
{
  const r = extract('<?xml version="1.0"?><MESSAGE MISMOReferenceModelIdentifier="3.6.0"><DEAL_SETS/></MESSAGE>');
  assert(r.ok === false, 'a 3.x envelope carrying no comparable grid does not import');
  assert(r.format && r.format.notAnAppraisal === true, 'it is flagged as not-an-appraisal');
  assert(/comparable sales grid/i.test(r.error), 'and the reason says so — never "we need a 3.6 reader"');
}

// An Encompass iLAD loan-application export is named for what it is.
{
  const r = extract('<?xml version="1.0"?><MESSAGE MISMOReferenceModelIdentifier="3.4.0">'
    + '<ABOUT_VERSIONS><ABOUT_VERSION><DataVersionIdentifier>ILAD 2.0</DataVersionIdentifier>'
    + '</ABOUT_VERSION></ABOUT_VERSIONS></MESSAGE>');
  assert(r.ok === false, 'a loan-application export does not import');
  assert(r.format && r.format.ilad === true, 'it is flagged iLAD');
  assert(/loan-application/i.test(r.error), 'and the officer is told they attached the wrong document');
}

// The 2009 residential namespace is MISMO 3.x — and, with no grid, still not an appraisal.
{
  const r = extract('<?xml version="1.0"?><message xmlns="http://www.mismo.org/residential/2009/schemas"><x/></message>');
  assert(r.ok === false, 'a 2009-schema file with no grid does not import');
  assert(r.format && r.format.model === '3.x', 'and is recognised as MISMO 3.x');
}

// A genuinely unrelated XML gets the generic error, never a false format claim.
{
  const r = extract('<?xml version="1.0"?><SOMETHING><x/></SOMETHING>');
  assert(r.ok === false, 'an unrelated XML does not import');
  assert(!(r.format && r.format.uad36), 'and is not mislabelled as UAD 3.6');
}

// The UAD 2.6 path is untouched.
{
  const xml = '<?xml version="1.0"?><VALUATION_RESPONSE MISMOVersionID="2.6">'
    + '<REPORT AppraisalFormType="FNM1004"><PROPERTY/></REPORT></VALUATION_RESPONSE>';
  const r = extract(xml);
  assert(r.ok === true, 'a minimal UAD 2.6 REPORT still parses (ok:true)');
  assert(r.formType === 'FNM1004', 'the 2.6 form type is read from the report');
  assert(!(r.format && r.format.model === '3.6'), 'and it is NOT routed through the 3.6 reader');
}

// The detector itself — one definition, reused by the research warehouse's catch.
{
  const d = _internals.detectMismo('<MESSAGE MISMOReferenceModelIdentifier="3.6.0">'
    + '<COMPARABLE_SALE/></MESSAGE>');
  assert(d.model === '3.x' && d.hasGrid === true, 'the detector sees a 3.x file with a grid');
  const two = _internals.detectMismo('<VALUATION_RESPONSE MISMOVersionID="2.6"><SALES_COMPARISON/></VALUATION_RESPONSE>');
  assert(two.model === '2.x' && two.hasGrid === true, 'and a 2.6 file with a grid');
  const none = _internals.detectMismo('<MESSAGE MISMOReferenceModelIdentifier="3.6.0"><DEAL_SETS/></MESSAGE>');
  assert(none.hasGrid === false, 'and reports no grid when there is none');
}

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'ALL format-detector assertions passed'}`);
process.exit(failures ? 1 : 0);
