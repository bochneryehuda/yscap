/**
 * Assertions for the UAD 2.6 vs UAD 3.6 / MISMO 3.x format detector (src/lib/appraisal/extract).
 * A 3.x file must fail LOUDLY with a clear, named reason — never silently extract nulls.
 */
const { extract } = require('../src/lib/appraisal/extract');
let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// MISMO 3.6 uses a MESSAGE root + a reference-model id.
{
  const r = extract('<?xml version="1.0"?><MESSAGE MISMOReferenceModelIdentifier="3.6.0"><DEAL_SETS/></MESSAGE>');
  assert(r.ok === false, '3.6 MESSAGE file does not import');
  assert(r.format && r.format.uad36 === true, 'it is flagged as UAD 3.6');
  assert(/3\.6|MISMO 3/.test(r.error) && /2\.6/.test(r.error), 'the error names the 3.6 format and that we read 2.6');
}
// The 2009+ residential schema namespace is also MISMO 3.x.
{
  const r = extract('<?xml version="1.0"?><message xmlns="http://www.mismo.org/residential/2009/schemas"><x/></message>');
  assert(r.ok === false && r.format && r.format.uad36, '2009-schema namespace is detected as 3.x');
}
// A genuinely unrelated / malformed XML gets the generic error, NOT a false 3.6 claim.
{
  const r = extract('<?xml version="1.0"?><SOMETHING><x/></SOMETHING>');
  assert(r.ok === false && !(r.format && r.format.uad36), 'a random XML is not mislabelled as 3.6');
}
// A normal UAD 2.6 report (has a REPORT element) is NOT flagged as 3.x.
{
  const xml = '<?xml version="1.0"?><VALUATION_RESPONSE MISMOVersionID="2.6"><REPORT AppraisalFormType="FNM1004"><PROPERTY/></REPORT></VALUATION_RESPONSE>';
  const r = extract(xml);
  assert(r.ok === true, 'a minimal 2.6 REPORT still parses (ok:true)');
  assert(r.formType === 'FNM1004', 'the 2.6 form type is read');
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL format-detector assertions passed'}`);
process.exit(failures ? 1 : 0);
