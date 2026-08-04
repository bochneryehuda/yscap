/**
 * Assertions for the UAD 2.6 vs UAD 3.6 / MISMO 3.x format detector
 * (src/lib/appraisal/extract).
 *
 * THE PROPERTY BEING GUARDED, and it has not changed: a MISMO 3.x file must
 * fail LOUDLY with a clear, named reason — never silently extract nulls, which
 * would put an appraisal on the file with every figure blank and nothing
 * saying why.
 *
 * WHAT DID CHANGE (and why three assertions here were rewritten on 2026-08-04):
 * this suite was never wired into `npm test`, so it went on asserting the
 * detector's FIRST shape long after the detector was deliberately refined. It
 * demanded `format.uad36 === true` for any 3.x file. The detector now answers
 * the more specific question first — a file carrying NO comparable sales grid
 * is reported as "this is not an appraisal report" rather than as UAD 3.6 —
 * because, per the note at that branch in extract.js, three real files were
 * being rejected under the wrong name. Both answers refuse the import and both
 * name a reason; the newer one is simply truer, and it is what an officer
 * reads.
 *
 * So this now pins the contract that actually matters — DETECTED as 3.x,
 * REFUSED, and told WHY — rather than one particular label. Asserting `uad36`
 * on these fixtures would be asserting the bug that refinement fixed.
 */
const { extract } = require('../src/lib/appraisal/extract');
let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// A real reason, not a shrug — this is what stops a silent all-null import.
const named = (r) => typeof r.error === 'string' && r.error.trim().length > 20;

// MISMO 3.6 uses a MESSAGE root + a reference-model id.
{
  const r = extract('<?xml version="1.0"?><MESSAGE MISMOReferenceModelIdentifier="3.6.0"><DEAL_SETS/></MESSAGE>');
  assert(r.ok === false, '3.6 MESSAGE file does not import');
  assert(!!r.format && r.format.model === '3.x', 'it is DETECTED as MISMO 3.x (not silently read as 2.6)');
  assert(r.format && r.format.ref === '3.6', 'and the reference model it declared is captured (3.6)');
  assert(named(r), 'the refusal carries a named, human reason');
}
// The 2009+ residential schema namespace is also MISMO 3.x — there is no
// reference-model attribute here, so the namespace alone has to carry it.
{
  const r = extract('<?xml version="1.0"?><message xmlns="http://www.mismo.org/residential/2009/schemas"><x/></message>');
  assert(r.ok === false, '2009-schema namespace file does not import');
  assert(!!r.format && r.format.model === '3.x', '2009-schema namespace is detected as 3.x');
  assert(named(r), 'and it too says why');
}
// A genuinely unrelated / malformed XML gets the generic error, NOT a false
// MISMO-3.x claim. This is the direction that must never over-fire: telling an
// officer "this is the new UAD format" about a PDF they mis-saved sends them
// to the appraiser for a file that was never the problem.
{
  const r = extract('<?xml version="1.0"?><SOMETHING><x/></SOMETHING>');
  assert(r.ok === false, 'unrelated XML does not import');
  assert(!(r.format && r.format.model === '3.x'), 'a random XML is not mislabelled as MISMO 3.x');
  assert(!(r.format && r.format.uad36), 'nor as UAD 3.6');
}
// A normal UAD 2.6 report (has a REPORT element) is NOT flagged as 3.x.
{
  const xml = '<?xml version="1.0"?><VALUATION_RESPONSE MISMOVersionID="2.6"><REPORT AppraisalFormType="FNM1004"><PROPERTY/></REPORT></VALUATION_RESPONSE>';
  const r = extract(xml);
  assert(r.ok === true, 'a minimal 2.6 REPORT still parses (ok:true)');
  assert(r.formType === 'FNM1004', 'the 2.6 form type is read');
  assert(!(r.format && r.format.model === '3.x'), 'and a 2.6 file is never called 3.x');
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL format-detector assertions passed'}`);
process.exit(failures ? 1 : 0);
