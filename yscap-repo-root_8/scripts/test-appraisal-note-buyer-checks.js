'use strict';
/**
 * PURE tests — the note-buyer (EMCAP) appraisal checks (owner-directed 2026-07-30).
 * src/lib/appraisal/note-buyer-checks.js computeEmcapFindings + compVerdict.
 *
 * The contract under test, owner's words condensed:
 *   • EMCAP files only — every other buyer (and a blank buyer) is silent.
 *   • At least ONE As-Is comp AND (when the appraisal carries an ARV) one ARV comp must be a
 *     settled sale within 12 months of the loan submission date, under 15% net adjustment, in
 *     the subject's ZIP — a provable "no" is FATAL; missing data is a WARNING (never fabricated).
 *   • Rental exit (fix & hold / DSCR) + a non-1025 form + no rent evidence → FATAL (1007 needed).
 *   • Interior photos not evidenced by the report's own metadata → WARNING (heuristic, never fatal).
 *   • A lender named on the appraisal that is not us → FATAL; a BLANK lender → silent.
 *
 * No DB needed. Run: node scripts/test-appraisal-note-buyer-checks.js
 */
const assert = require('assert');
const nb = require('../src/lib/appraisal/note-buyer-checks');

let n = 0;
const ok = (m) => { n++; console.log(`  ok - ${m}`); };
const byCode = (arr, c) => arr.find((f) => f.code === c);

// A fully-qualifying comp + a healthy EMCAP file, overridable per case.
const goodComp = (o) => Object.assign({
  seq: '1', comp_set: 'arv', zip: '08701', sale_date: '2026-03-01',
  net_adj_pct: 8, net_adjustment: 24000, sale_price: 300000, sale_status: 'closed',
}, o);
const baseInput = (o) => Object.assign({
  noteBuyer: 'EMCAP Financial',
  submittedDate: '2026-07-01',
  strategy: 'fix_flip',
  appraisal: {
    form_type: 'FNM1004', subject_zip: '08701', arv_value: 450000, as_is_value: 300000,
    est_market_monthly_rent: null, lender_name: 'YS Capital Group',
    condition_of_appraisal: 'SubjectToCompletion', comp_split_needs_review: false, fields: {},
  },
  comps: [goodComp(), goodComp({ seq: '4', comp_set: 'as_is', sale_price: 280000 })],
  unitRentCount: 0,
}, o);
// Interior-photo evidence, so the photo warning stays out of unrelated cases.
const withInterior = (i) => {
  i.appraisal = Object.assign({}, i.appraisal, {
    fields: Object.assign({}, i.appraisal.fields, {
      'report.forms': { value: [{ name: 'Subject Interior Photos', type: 'SubjectPhotos' }] },
    }),
  });
  return i;
};

// 1 — buyer scoping: only EMCAP fires; blank / other buyers are silent.
{
  assert.strictEqual(nb.computeEmcapFindings(baseInput({ noteBuyer: 'Fidelis' })).length, 0);
  assert.strictEqual(nb.computeEmcapFindings(baseInput({ noteBuyer: null })).length, 0);
  assert.strictEqual(nb.computeEmcapFindings(baseInput({ noteBuyer: 'Blue Lake' })).length, 0);
  assert.ok(nb.computeEmcapFindings(withInterior(baseInput())).length === 0,
    'a fully-healthy EMCAP file raises nothing');
  // Any EMCAP spelling fires (prefix rule): EMCAP / EMCAP Financial / em cap.
  const missingInterior = baseInput();
  assert.ok(byCode(nb.computeEmcapFindings(missingInterior), 'emcap_interior_photos'), 'EMCAP fires on the canonical label');
  assert.ok(byCode(nb.computeEmcapFindings(baseInput({ noteBuyer: 'emcap' })), 'emcap_interior_photos'), '"emcap" fires');
  ok('buyer scoping: EMCAP only, healthy file silent');
}

// 2 — no appraisal → nothing (never judged before the appraisal exists).
{
  assert.strictEqual(nb.computeEmcapFindings(baseInput({ appraisal: null })).length, 0);
  ok('no appraisal → no findings');
}

// 3 — the anchor rule, per grid: a qualifying comp in each grid → silent.
{
  const out = nb.computeEmcapFindings(withInterior(baseInput()));
  assert.ok(!byCode(out, 'emcap_arv_anchor') && !byCode(out, 'emcap_asis_anchor'), 'both anchors satisfied → silent');
  ok('anchor: one qualifying comp per grid satisfies the requirement');
}

// 4 — FATAL only on a PROVABLE failure of every comp in the grid.
{
  // Every ARV comp fails at least one requirement, provably.
  const i = withInterior(baseInput({
    comps: [
      goodComp({ seq: '1', zip: '08702' }),                                  // wrong ZIP
      goodComp({ seq: '2', sale_date: '2024-01-01' }),                       // 30 months before submission
      goodComp({ seq: '3', net_adj_pct: 22 }),                               // over 15% net
      goodComp({ seq: '4', comp_set: 'as_is' }),                             // the as-is anchor stays good
    ],
  }));
  const out = nb.computeEmcapFindings(i);
  const f = byCode(out, 'emcap_arv_anchor');
  assert.ok(f && f.severity === 'fatal' && f.blocksCtc === true, 'no qualifying ARV comp → FATAL, blocks CTC');
  assert.ok(/12 months|net adjustment|ZIP/.test(f.howTo), 'the fatal names the three requirements');
  assert.ok(!byCode(out, 'emcap_asis_anchor'), 'the good as-is anchor stays silent');
  ok('anchor fatal: fires only when every comp in the grid provably fails');
}

// 5 — missing data NEVER fabricates a fatal: unknown → warning; no submission date → warning.
{
  // ZIPs unreadable on every ARV comp → unknown → WARNING (not fatal).
  const noZip = withInterior(baseInput({ comps: [goodComp({ zip: null }), goodComp({ seq: '4', comp_set: 'as_is' })] }));
  const w = byCode(nb.computeEmcapFindings(noZip), 'emcap_arv_anchor');
  assert.ok(w && w.severity === 'warning' && w.blocksCtc === false, 'unreadable comp data → warning, never a fabricated fatal');
  // No submission date at all → the 12-month window is unverifiable → warning.
  const noSub = withInterior(baseInput({ submittedDate: null }));
  const w2 = byCode(nb.computeEmcapFindings(noSub), 'emcap_arv_anchor') || byCode(nb.computeEmcapFindings(noSub), 'emcap_asis_anchor');
  // Both grids have qualifying comps except the window can't be proven → warnings on both.
  assert.ok(w2 && w2.severity === 'warning' && /submission date/.test(w2.title), 'no submission date → warning asking for a hand check');
  // A mix of provable-fail + unknown → still a WARNING (the unknown one may qualify).
  const mix = withInterior(baseInput({ comps: [goodComp({ zip: '08702' }), goodComp({ seq: '2', zip: null }), goodComp({ seq: '4', comp_set: 'as_is' })] }));
  const w3 = byCode(nb.computeEmcapFindings(mix), 'emcap_arv_anchor');
  assert.ok(w3 && w3.severity === 'warning', 'provable fails + an unknown → warning (the unknown may qualify)');
  ok('never-fabricate: unknown data yields warnings, not fatals');
}

// 6 — grid coverage edges: no comps at all; unknown split; ARV-only data file; straight as-is deal.
{
  const none = withInterior(baseInput({ comps: [] }));
  assert.ok(byCode(nb.computeEmcapFindings(none), 'emcap_comps_unreadable'), 'zero readable comps → one "verify by hand" warning');
  const unknown = withInterior(baseInput({ comps: [goodComp({ comp_set: 'unknown' }), goodComp({ seq: '2', comp_set: 'unknown' })] }));
  const u = nb.computeEmcapFindings(unknown);
  assert.ok(byCode(u, 'emcap_asis_anchor') && byCode(u, 'emcap_asis_anchor').severity === 'warning', 'undetermined split → as-is anchor warning');
  assert.ok(byCode(u, 'emcap_arv_anchor') && byCode(u, 'emcap_arv_anchor').severity === 'warning', 'undetermined split → arv anchor warning');
  // Reno file whose data file carries ONLY the ARV grid → the as-is anchor is a hand-check warning.
  const arvOnly = withInterior(baseInput({ comps: [goodComp(), goodComp({ seq: '2' })] }));
  const a = byCode(nb.computeEmcapFindings(arvOnly), 'emcap_asis_anchor');
  assert.ok(a && a.severity === 'warning' && /only the ARV grid/.test(a.title), 'ARV-only data file → as-is anchor hand-check warning');
  // Straight as-is purchase (no ARV on the appraisal): only the As-Is anchor applies.
  const straight = withInterior(baseInput({
    appraisal: Object.assign({}, baseInput().appraisal, { arv_value: null, condition_of_appraisal: 'AsIs' }),
    comps: [goodComp({ comp_set: 'as_is' })],
  }));
  const s = nb.computeEmcapFindings(straight);
  assert.ok(!byCode(s, 'emcap_arv_anchor'), 'no ARV on the appraisal → no ARV-anchor requirement');
  assert.ok(!byCode(s, 'emcap_asis_anchor'), 'the qualifying as-is comp satisfies the as-is anchor');
  ok('grid edges: no comps / unknown split / ARV-only file / straight as-is deal');
}

// 7 — derived net adjustment: no % but $ + sale price → derived; a derived 20% fails the comp.
{
  const derived = withInterior(baseInput({
    comps: [goodComp({ net_adj_pct: null, net_adjustment: -60000, sale_price: 300000 }),   // 20% derived → fail
      goodComp({ seq: '4', comp_set: 'as_is' })],
  }));
  const f = byCode(nb.computeEmcapFindings(derived), 'emcap_arv_anchor');
  assert.ok(f && f.severity === 'fatal' && /20% net adjustment/.test(f.howTo), 'derived |net adj|/price over 15% provably fails');
  ok('net adjustment derives from dollars when the % is missing');
}

// 8 — the 12-month window is judged against SUBMISSION, and a sale after submission qualifies.
//     (compVerdict takes the MAPPED camelCase comp shape computeEmcapFindings builds internally.)
{
  const v = nb._internals.compVerdict;
  const cc = (o) => Object.assign({ seq: '1', zip: '08701', saleDate: '2026-03-01', netAdjPct: 8, netAdjustment: 24000, salePrice: 300000, saleStatus: 'closed' }, o);
  assert.strictEqual(v(cc({ saleDate: '2025-07-01' }), { submittedDate: '2026-07-01', subjectZip: '08701' }).verdict, 'pass', 'exactly 12 months → qualifies');
  assert.strictEqual(v(cc({ saleDate: '2025-06-01' }), { submittedDate: '2026-07-01', subjectZip: '08701' }).verdict, 'fail', '13 months → fails');
  assert.strictEqual(v(cc({ saleDate: '2026-08-01' }), { submittedDate: '2026-07-01', subjectZip: '08701' }).verdict, 'pass', 'a sale after submission is even more recent → qualifies');
  assert.strictEqual(v(cc({ saleStatus: 'active' }), { submittedDate: '2026-07-01', subjectZip: '08701' }).verdict, 'fail', 'an active listing is not a settled sale');
  assert.strictEqual(v(cc({ zip: '08701-1234' }), { submittedDate: '2026-07-01', subjectZip: '08701' }).verdict, 'pass', 'ZIP+4 matches its 5-digit ZIP');
  ok('window/status/zip verdicts: 12mo boundary, post-submission sale, listing, ZIP+4');
}

// 9 — rental analysis (1007): rental exit + 1004 + no rent evidence → FATAL; every evidence path clears it.
{
  const rental = (extra, apprExtra) => nb.computeEmcapFindings(withInterior(baseInput(Object.assign({ strategy: 'fix_hold' }, extra, {
    appraisal: Object.assign({}, baseInput().appraisal, apprExtra || {}),
  }))));
  const f = byCode(rental(), 'emcap_rental_analysis');
  assert.ok(f && f.severity === 'fatal' && /1007/.test(f.title), 'fix & hold + 1004 + no rent evidence → fatal');
  assert.ok(byCode(nb.computeEmcapFindings(withInterior(baseInput({ strategy: 'rental_dscr' }))), 'emcap_rental_analysis'), 'DSCR exit counts as a rental exit too');
  assert.ok(!byCode(rental({}, { form_type: 'FNM1025' }), 'emcap_rental_analysis'), 'a 1025 includes the rent schedule → silent');
  assert.ok(!byCode(rental({}, { est_market_monthly_rent: 2400 }), 'emcap_rental_analysis'), 'a market rent on the report → silent');
  assert.ok(!byCode(rental({ unitRentCount: 2 }), 'emcap_rental_analysis'), 'per-unit rents on the report → silent');
  // (built WITHOUT the withInterior wrapper — it overwrites the same 'report.forms' key.)
  const rentFormInput = baseInput({ strategy: 'fix_hold' });
  rentFormInput.appraisal = Object.assign({}, rentFormInput.appraisal, {
    fields: { 'report.forms': { value: [{ name: 'Comparable Rent Schedule (1007)' }] } },
  });
  assert.ok(!byCode(nb.computeEmcapFindings(rentFormInput), 'emcap_rental_analysis'), 'a 1007 named in the page listing → silent');
  const withGrid = { fields: { 'report.rentalGrids': { value: 2 } } };
  assert.ok(!byCode(rental({}, withGrid), 'emcap_rental_analysis'), 'rental-comp grids in the data → silent');
  assert.ok(!byCode(nb.computeEmcapFindings(withInterior(baseInput({ strategy: 'fix_flip' }))), 'emcap_rental_analysis'), 'a flip exit needs no rental analysis');
  assert.ok(!byCode(nb.computeEmcapFindings(withInterior(baseInput({ strategy: null }))), 'emcap_rental_analysis'), 'an unknown strategy is never guessed into a rental exit');
  ok('rental analysis: fatal on rental exit + 1004 + no evidence; every evidence path clears');
}

// 10 — interior photos: warning unless the metadata names them; both metadata shapes count.
{
  const bare = nb.computeEmcapFindings(baseInput());
  const w = byCode(bare, 'emcap_interior_photos');
  assert.ok(w && w.severity === 'warning' && w.blocksCtc === false, 'no interior evidence → WARNING (never fatal)');
  const viaCaption = baseInput();
  viaCaption.appraisal = Object.assign({}, viaCaption.appraisal, {
    fields: { 'report.images': { value: [{ id: 'Photo3', caption: 'Kitchen' }] } },
  });
  assert.ok(!byCode(nb.computeEmcapFindings(viaCaption), 'emcap_interior_photos'), 'a kitchen/interior photo caption satisfies it');
  assert.ok(!byCode(nb.computeEmcapFindings(withInterior(baseInput())), 'emcap_interior_photos'), 'an interior photo page in the listing satisfies it');
  ok('interior photos: metadata-evidenced or a confirm-by-hand warning');
}

// 11 — lender name: named and not ours → FATAL; ours (any spelling) or blank → silent.
{
  const other = withInterior(baseInput());
  other.appraisal = Object.assign({}, other.appraisal, { lender_name: 'Kiavi Funding Inc' });
  const f = byCode(nb.computeEmcapFindings(other), 'emcap_lender_name');
  assert.ok(f && f.severity === 'fatal' && /Kiavi/.test(f.title), 'a different lender named → fatal, naming the lender');
  for (const ours of ['YS Capital Group', 'YS Capital Group LLC', 'Y.S. Capital']) {
    const i = withInterior(baseInput()); i.appraisal = Object.assign({}, i.appraisal, { lender_name: ours });
    assert.ok(!byCode(nb.computeEmcapFindings(i), 'emcap_lender_name'), `${ours} reads as ours`);
  }
  const blank = withInterior(baseInput()); blank.appraisal = Object.assign({}, blank.appraisal, { lender_name: null });
  assert.ok(!byCode(nb.computeEmcapFindings(blank), 'emcap_lender_name'), 'a blank lender is never guessed into a finding');
  ok('lender name: fatal only when a non-YS lender is actually named');
}

// 12 — hostile input never throws; every finding is source=note_buyer with required keys.
{
  for (const bad of [null, undefined, {}, { noteBuyer: 'EMCAP' }, { noteBuyer: 'EMCAP', appraisal: {} }]) {
    assert.doesNotThrow(() => nb.computeEmcapFindings(bad));
    assert.ok(Array.isArray(nb.computeEmcapFindings(bad)));
  }
  const all = nb.computeEmcapFindings(baseInput({ strategy: 'fix_hold', comps: [], appraisal: Object.assign({}, baseInput().appraisal, { lender_name: 'Other Bank' }) }));
  for (const f of all) {
    assert.strictEqual(f.source, 'note_buyer', `${f.code} carries source=note_buyer`);
    assert.ok(f.code && f.severity && f.title && f.howTo, `${f.code} carries code/severity/title/howTo`);
    assert.ok(typeof f.blocksCtc === 'boolean', `${f.code} carries a concrete blocksCtc`);
  }
  ok('hostile input never throws; finding shape is complete and tagged note_buyer');
}

console.log(`\nappraisal-note-buyer-checks: ${n} checks passed`);
