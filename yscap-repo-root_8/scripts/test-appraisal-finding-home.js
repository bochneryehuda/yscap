/**
 * ONE HOME FOR APPRAISAL FINDINGS + the "main picture is the appraiser's signature" fix.
 * (owner-reported 2026-08-02). Pure — no DB, no network.
 *
 * Covers, in order:
 *   A. finding-subject: which findings belong on the Appraisal page, and — just as important —
 *      which must STAY on the document desk (a cross-document conflict).
 *   B. tie-out: the appraisal no longer raises a SECOND card for a fact the appraisal desk already
 *      owns, while every other document's discrepancy is untouched (proven both directions, so a
 *      regression that over-suppresses is caught too).
 *   C. photos: a scanned signature / map / sketch is never classified as a photograph, and real
 *      photographs — including hard ones (overcast sky, blown-out sky, a white house) — always are.
 */
const { buildTieout } = require('../src/lib/underwriting/tieout');
const subject = require('../src/lib/appraisal/finding-subject');
const { imageStats, classifyImage } = require('../src/lib/appraisal/photos');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// ---------------------------------------------------------------- A. the predicate
{
  const tie = (code, docTypes) => ({
    source: 'tie_out', code,
    sources: [{ kind: 'file', label: 'Loan file' }].concat(docTypes.map((d) => ({ kind: 'document', docType: d, label: d }))),
  });
  assert(subject.isAppraisalSubject({ source: 'avm_consensus', code: 'avm_consensus_disagreement' }) === true,
    'the AVM-vs-appraised-value finding is an appraisal finding');
  assert(subject.isAppraisalSubject({ source: 'appraisal', code: 'stale_before_closing' }) === true,
    'a finding sourced from the appraisal document is an appraisal finding');
  assert(subject.isAppraisalSubject(tie('tieout_occupancy', ['appraisal'])) === true,
    'a tie-out row whose only disagreeing document is the appraisal moves to the Appraisal page');
  assert(subject.isAppraisalSubject(tie('tieout_purchase_price', ['appraisal', 'settlement'])) === false,
    'a tie-out row the appraisal shares with ANOTHER document stays on the document desk');
  assert(subject.isAppraisalSubject(tie('tieout_seller_name', ['title'])) === false,
    'a tie-out row with no appraisal in it stays on the document desk');
  assert(subject.isAppraisalSubject({ source: 'tie_out', code: 'legacy' }) === false,
    'a tie-out row with no machine-keyed sources fails toward the document desk, never into limbo');
  assert(subject.isAppraisalSubject({ source: 'bank_statement', code: 'x' }) === false,
    'an unrelated document finding is not an appraisal finding');
  assert(subject.isAppraisalSubject(null) === false && subject.isAppraisalSubject({}) === false,
    'junk input is never claimed');

  const s = subject.split([
    { source: 'avm_consensus', code: 'a' }, { source: 'bank_statement', code: 'b' },
    tie('tieout_occupancy', ['appraisal']), tie('tieout_entity_name', ['operating_agreement']),
  ]);
  assert(s.appraisal.length === 2 && s.document.length === 2, 'split() sorts a mixed list into the two desks');
  assert(s.appraisal[0].code === 'a' && s.document[0].code === 'b', 'split() preserves the input order in both halves');
}

// ---------------------------------------------------------------- B. the tie-out duplicate
{
  // A file whose appraisal disagrees with it on EVERY fact the appraisal desk owns, plus a
  // settlement statement that disagrees on the purchase price.
  const ctx = {
    app: {
      property_address: { line1: '76 Thompson St', city: 'Springfield', state: 'MA', zip: '01109' },
      purchase_price: 300000, as_is_value: 250000, arv: 500000, units: 2,
      property_type: 'Multi 2-4', occupancy: 'Vacant', is_assignment: false,
    },
    borrower: null, vestingName: null,
  };
  const appraisalSource = {
    id: 'appraisal', docType: 'appraisal',
    fields: {
      propertyAddress: { line1: '999 Elsewhere Rd', city: 'Springfield', state: 'MA', zip: '01109' },
      contractPrice: 275000, asIsValue: 190000, arvValue: 410000, units: 4,
      propertyType: 'Condominium', occupancy: 'TenantOccupied',
    },
  };
  const settlementSource = {
    id: 'settlement', docType: 'settlement',
    fields: { contractSalesPrice: 412000 },
  };

  const { discrepancies } = buildTieout(ctx, [appraisalSource, settlementSource]);
  const codes = discrepancies.map((d) => d.code);
  const namesAppraisal = (d) => (d.sources || []).some((s) => s.docType === 'appraisal');

  for (const fact of subject.APPRAISAL_DESK_FACTS) {
    const dup = discrepancies.find((d) => d.code === `tieout_${fact}` && namesAppraisal(d));
    assert(!dup, `the tie-out raises no duplicate for ${fact} — the appraisal desk owns that finding`);
  }
  const price = discrepancies.find((d) => d.code === 'tieout_purchase_price');
  assert(!!price, 'the settlement’s price disagreement is still raised');
  assert(price && !namesAppraisal(price),
    'and it names only the settlement — the appraisal is not re-added to a shared row');

  // The appraisal is still a live comparison source: the facts it carries that the appraisal desk
  // does NOT own must still surface (otherwise this suppression would have hidden real work).
  const occ = discrepancies.find((d) => d.code === 'tieout_occupancy');
  assert(!!occ && namesAppraisal(occ), 'an appraisal fact the appraisal desk does NOT own still surfaces');
  assert(occ && subject.isAppraisalSubject(occ),
    'and it is routed to the Appraisal page rather than left on the document desk');

  // Every source entry carries the machine key the routing depends on.
  const allSources = discrepancies.flatMap((d) => (d.sources || []).filter((s) => s.kind === 'document'));
  assert(allSources.length > 0 && allSources.every((s) => typeof s.docType === 'string' && s.docType),
    'every disagreeing document source carries docType (the routing key, never the display label)');
  assert(codes.length > 0, 'the fixture actually produced discrepancies (the test is not vacuous)');
}

// ---------------------------------------------------------------- C. photograph vs the form
// Build raw RGB buffers that mimic the real shapes. EVERY fixture carries sensor/scanner grain —
// a deterministic ±10 levels — because real pixels always do, and a fixture without it would let a
// "this image is perfectly flat" shortcut pass the test while doing nothing on a real appraisal.
// Deterministic LCG, so a failure is always reproducible.
let _seed = 12345;
function noise(amp) { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return ((_seed % (2 * amp + 1)) - amp); }
function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }
function buf(w, h, paint, amp = 10) {
  _seed = 12345;
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y);
      const n = noise(amp);
      const o = (y * w + x) * 3;
      px[o] = clamp(r + n); px[o + 1] = clamp(g + n); px[o + 2] = clamp(b + n);
    }
  }
  return px;
}
const verdict = (px, w, h) => classifyImage(imageStats(px, w, h, 3));

{
  // A scanned appraiser signature: white paper, thin dark strokes, ~3:1.
  const w = 600, h = 200;
  const px = buf(w, h, (x, y) => {
    const onStroke = Math.abs(y - (100 + 40 * Math.sin(x / 25))) < 3;
    return onStroke ? [25, 25, 28] : [252, 251, 250];
  });
  const v = verdict(px, w, h);
  assert(v.photo === false, `the appraiser’s signature is NOT a photograph (${v.why})`);
}
{
  // A location map: white with grey roads and a couple of coloured markers.
  const w = 500, h = 400;
  const px = buf(w, h, (x, y) => {
    if (y % 60 < 2 || x % 70 < 2) return [140, 140, 145];
    if (x > 240 && x < 254 && y > 190 && y < 204) return [200, 40, 40];
    return [250, 250, 248];
  });
  const v = verdict(px, w, h);
  assert(v.photo === false, `a location map is NOT a photograph (${v.why})`);
}
{
  // A floor-plan sketch: white with black line work.
  const w = 480, h = 360;
  const px = buf(w, h, (x, y) => ((x % 80 < 2 || y % 90 < 2) ? [15, 15, 15] : [255, 255, 255]));
  const v = verdict(px, w, h);
  assert(v.photo === false, `a floor-plan sketch is NOT a photograph (${v.why})`);
}
{
  // A lender logo strip (wide banner).
  const w = 900, h = 120;
  const px = buf(w, h, (x) => (x % 30 < 15 ? [30, 60, 120] : [255, 255, 255]));
  const v = verdict(px, w, h);
  assert(v.photo === false, `a wide logo/banner strip is NOT a photograph (${v.why})`);
}
{
  // The subject front photo: blue sky, brown roof, beige walls, green grass.
  const w = 640, h = 480;
  const px = buf(w, h, (x, y) => {
    if (y < 150) return [135, 206, 235];                       // sky
    if (y < 230) return [120, 74, 52];                          // roof
    if (y < 380) return [214, 196, 165];                        // siding
    return [86, 130, 62];                                       // lawn
  });
  const v = verdict(px, w, h);
  assert(v.photo === true, `the subject front photo IS a photograph (${v.why})`);
}
{
  // The hard case that must not be demoted: an OVERCAST shot — grey sky, muted everything.
  const w = 640, h = 480;
  const px = buf(w, h, (x, y) => {
    if (y < 190) return [206, 208, 210];                        // flat grey sky (not near-white)
    if (y < 300) return [96, 92, 88];
    return [150, 146, 138];
  });
  const v = verdict(px, w, h);
  assert(v.photo === true, `an overcast exterior shot IS a photograph (${v.why})`);
}
{
  // The other hard case: a WHITE house under a blown-out sky — lots of near-white, but the
  // building still fills the frame in midtones.
  const w = 640, h = 480;
  const px = buf(w, h, (x, y) => {
    if (y < 170) return [252, 252, 250];                        // blown sky (near-white)
    if (y < 240) return [118, 96, 80];                          // roof
    if (y < 390) return [236, 234, 228];                        // white siding
    return [98, 124, 70];                                       // lawn
  });
  const v = verdict(px, w, h);
  assert(v.photo === true, `a white house under a blown-out sky IS a photograph (${v.why})`);
}
{
  // An interior room shot — dim, low colour, but plenty of midtones and no white page.
  const w = 600, h = 450;
  const px = buf(w, h, (x, y) => {
    if (y < 120) return [188, 184, 176];                        // ceiling
    if (x < 200) return [126, 118, 104];                        // wall in shadow
    return [158, 140, 118];                                     // wall + floor
  });
  const v = verdict(px, w, h);
  assert(v.photo === true, `a dim interior room shot IS a photograph (${v.why})`);
}
{
  // Degenerate inputs never throw and never demote.
  assert(classifyImage(null).photo === true, 'unreadable statistics keep the image as a photograph');
  assert(imageStats(Buffer.alloc(4), 100, 100, 3) === null, 'a short buffer returns no statistics rather than throwing');
}

console.log(failures ? `\nFAILED (${failures})` : '\nAll appraisal finding-home + photo-classification checks passed');
process.exit(failures ? 1 : 0);
