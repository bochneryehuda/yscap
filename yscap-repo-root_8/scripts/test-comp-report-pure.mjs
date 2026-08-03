/**
 * THE BRANDED REPORT — the honesty is proved for every layout at once.
 *
 * The rule is exact: "The disclaimer scales; the honesty does not: no layout may
 * drop the confidence label, the range, the comp count, or the blank-adjustment
 * sentence." A rule like that is worth nothing unless something FAILS when it is
 * broken, so this walks every layout — including any added later, since it reads
 * LAYOUT_KEYS rather than a list typed here — and refuses each one that drops
 * any of them.
 *
 * The legal line is checked the same way. The failure mode is not a missing
 * sentence; it is a helpful synonym slipping into a heading, and "evaluation" is
 * a regulated word we may never use about ourselves.
 *
 * Pure. Run: node scripts/test-comp-report-pure.mjs
 */
import {
  buildReport, blankReasons, missingMandatory, LAYOUTS, LAYOUT_KEYS,
  FORBIDDEN_WORDS, SELF_NAME_FORBIDDEN, LEGAL, REPORT_NAME, MANDATORY,
} from '../app-v2/src/lib/compReport.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };

const GRID_LINES = [
  { key: 'gla', label: 'Gross living area' },
  { key: 'condition', label: 'Condition' },
  { key: 'garage', label: 'Garage / carport' },
  { key: 'view', label: 'View' },
];

const comp = (over = {}) => Object.assign({
  id: 'c1', display_address: '12 Oak St', sale_price: 400000, adjustedPrice: 412000,
  sale_date: '2026-05-01', distance_miles: 0.42, property_type: 'SFR (1 unit)', units: 1,
  gla: 1800, beds: 3, baths: 2, year_built: 1962, condition_uad: 'C3', include: true,
  lines: [{ key: 'gla', label: 'Gross living area', amount: 12000 }],
  warnings: [], photo_count: 0,
}, over);

const DATA = {
  valuation: {
    title: 'Research on 40 Elm', subject_address: '40 Elm St', effective_date: '2026-08-01',
    purpose: 'as_is', status: 'draft', method: 'weighted', created_by_name: 'A Staffer',
  },
  grid: {
    subject: { display_address: '40 Elm St', gla: 1900, beds: 3 },
    gridLines: GRID_LINES,
    disclaimer: 'the engine disclaimer',
    warnings: [{ code: 'few_comps', message: 'only three sales' }],
    comps: [comp(), comp({ id: 'c2', display_address: '18 Pine Ave', include: false }),
      comp({ id: 'c3', display_address: '9 Ash Rd' })],
    value: {
      indicatedValue: 415000, likelyLow: 398000, likelyHigh: 432000,
      confidence: { label: 'fair', reasons: ['only three sales'], basis: 'a rule, not a model' },
    },
  },
};

// ---------------------------------------------------------------------------
// THE HONESTY SURVIVES EVERY LAYOUT — INCLUDING ONE ADDED LATER
// ---------------------------------------------------------------------------
ok(LAYOUT_KEYS.length >= 4, `there are at least the four layouts asked for (${LAYOUT_KEYS.join(', ')})`);
for (const key of LAYOUT_KEYS) {
  const r = buildReport(DATA, key);
  const gone = missingMandatory(r);
  ok(gone.length === 0, `${key}: keeps every mandatory element (missing: ${gone.join(', ')})`);
  ok(r.value.indicated === '$415,000', `${key}: states the indicated value`);
  ok(r.value.low === '$398,000' && r.value.high === '$432,000',
    `${key}: states the RANGE — a single number invites a reader to treat it as precise`);
  ok(r.confidence.label === 'fair', `${key}: states the confidence label`);
  ok(/2 comparables used of the 3/.test(r.coverage.sentence),
    `${key}: the comp count is a sentence, not a bare number (${r.coverage.sentence})`);
  ok(/7%/.test(r.coverage.note), `${key}: and the coverage caveat travels with it`);
  ok(typeof r.blanks.total === 'number' && r.blanks.total > 0,
    `${key}: the blank adjustment lines are counted`);
  ok(/NOT an appraisal/i.test(r.legal.notAnAppraisal) && /NEVER/.test(r.legal.neverSizes),
    `${key}: the legal line is present in full`);
}
// The grid-only layout is the narrowest, and is the one most likely to be
// "simplified" into dropping something. Named explicitly so the intent is clear.
{
  const r = buildReport(DATA, 'grid_only');
  ok(r.showComps === false, 'grid only really does drop the comparable cards');
  ok(missingMandatory(r).length === 0, '…and still carries all five mandatory elements');
}

// ---------------------------------------------------------------------------
// THE LAYOUTS GENUINELY DIFFER — otherwise "four layouts" is a lie
// ---------------------------------------------------------------------------
{
  const shapes = LAYOUT_KEYS.map((k) => {
    const r = buildReport(DATA, k);
    return `${r.compPresentation}|${r.showComps}|${r.showPhotos}|${r.showBlankDetail}|${r.showWarnings}`;
  });
  ok(new Set(shapes).size === shapes.length,
    `every layout is genuinely different from every other — four names for three things would be a lie (${shapes.join(' ; ')})`);
  ok(buildReport(DATA, 'full').compPresentation === 'page',
    'the full layout gives each comparable its own page, as asked');
  ok(buildReport(DATA, 'full').showPhotos === true, 'and is the one that carries photographs');
  ok(buildReport(DATA, 'one_pager').showComps === false,
    'the one-pager drops the per-comparable cards — the grid already lists every one of them, and '
    + 'with the cards it printed THREE pages, which makes its own name untrue');
  ok(buildReport(DATA, 'one_pager').showWarnings === true
    && buildReport(DATA, 'grid_only').showWarnings === false,
    'and it still differs from grid-only, which drops the warnings too');
}

// ---------------------------------------------------------------------------
// A BLANK ADJUSTMENT LINE IS A SENTENCE, NEVER AN EMPTY CELL
// ---------------------------------------------------------------------------
{
  const b = blankReasons({ lines: [
    { key: 'gla', amount: 12000 },
    { key: 'condition', amount: 0 },
    { key: 'view', amount: null, why: 'neither report states a view' },
  ] }, GRID_LINES);
  const by = Object.fromEntries(b.map((x) => [x.key, x.why]));
  ok(!('gla' in by), 'a line that WAS adjusted needs no explanation');
  ok(/judged the same|not to matter/.test(by.condition || ''),
    'a zero says the two were judged the same OR the difference judged not to matter…');
  ok(/does not record which/.test(by.condition || ''),
    '…and admits the grid does not record which of the two it was');
  ok(by.view === 'neither report states a view', 'a line with its own reason keeps that reason');
  ok(/nobody has worked this line yet/.test(by.garage || ''),
    'and a line nobody has touched says so — the one that actually matters');
  ok(b.every((x) => x.why && x.why.length > 10), 'every blank carries WORDS, never an empty cell');
}

// ---------------------------------------------------------------------------
// THE LEGAL LINE, EXACTLY
// ---------------------------------------------------------------------------
{
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const all = Object.values(LEGAL).join(' ') + ' ' + REPORT_NAME
    + ' ' + LAYOUT_KEYS.map((k) => `${LAYOUTS[k].label} ${LAYOUTS[k].blurb}`).join(' ');
  for (const w of FORBIDDEN_WORDS) {
    ok(!new RegExp(esc(w), 'i').test(all),
      `the word "${w}" appears nowhere in our own wording — it is regulated or untrue`);
  }
  // …but the PROSE must still be able to name the source and to deny the thing
  // it is not. A blanket word ban would have forced both into something vaguer.
  ok(/appraisal reports/i.test(LEGAL.what),
    'the prose CAN name the real appraisal reports the data came from');
  ok(/NOT an appraisal/i.test(LEGAL.notAnAppraisal),
    'and CAN say the word in order to deny it');
  // What the document may never call ITSELF — its name and its layout labels.
  const selfNames = [REPORT_NAME, ...LAYOUT_KEYS.map((k) => LAYOUTS[k].label)].join(' | ');
  for (const w of SELF_NAME_FORBIDDEN) {
    ok(!new RegExp(esc(w), 'i').test(selfNames),
      `the document never calls itself "${w}" (${selfNames})`);
  }
  ok(REPORT_NAME === 'Internal value indication', 'the document calls itself an internal value indication');
  ok(/licensed appraiser/i.test(LEGAL.whoMayRun) && /may operate/i.test(LEGAL.whoMayRun),
    'and states the policy USPAP-avoidance actually rests on: who may run it');
  ok(/never/i.test(LEGAL.neverSizes) && /size/i.test(LEGAL.neverSizes),
    'and that it may never size a loan');
  // "evaluation" must not sneak in through a layout label either.
  const labels = LAYOUT_KEYS.map((k) => `${LAYOUTS[k].label} ${LAYOUTS[k].blurb}`).join(' ');
  ok(!/evaluation/i.test(labels), 'nor through a layout name or its description');
}

// ---------------------------------------------------------------------------
// NOTHING IS INVENTED, AND NOTHING THROWS
// ---------------------------------------------------------------------------
for (const junk of [undefined, null, {}, { grid: null }, { valuation: null, grid: {} },
  { grid: { comps: 'x', value: null } }]) {
  let r = null;
  let threw = null;
  try { r = buildReport(junk, 'full'); } catch (e) { threw = e; }
  ok(!threw, `${JSON.stringify(junk)} does not throw`);
  ok(r && r.coverage.compsTotal === 0, `${JSON.stringify(junk)} reports no comparables rather than inventing some`);
  ok(r && r.value.indicated === null, 'and no value at all rather than a zero');
  ok(r && r.legal && r.legal.neverSizes, 'and the legal line is STILL there — a refusal is still a document');
}
{
  const r = buildReport({ ...DATA, valuation: { ...DATA.valuation, title: '' } }, 'standard');
  ok(r.title === REPORT_NAME, 'an untitled valuation is named for what it is, never left blank');
  const bad = buildReport(DATA, 'no_such_layout');
  ok(bad.layout.key === 'standard', 'an unknown layout falls back to standard rather than rendering nothing');
}
{
  // A comparable switched OFF is still SHOWN — the reader needs to see what was
  // considered and set aside, or the set looks hand-picked with no evidence.
  const r = buildReport(DATA, 'standard');
  ok(r.comps.length === 3 && r.comps.filter((c) => !c.included).length === 1,
    'a comparable that was switched off is still in the report, marked as not used');
  ok(r.coverage.compsUsed === 2, 'but it does not count toward the number the value rests on');
}
ok(MANDATORY.length === 5, 'the mandatory list is the five this test walks');

console.log(fail
  ? `\ntest-comp-report-pure: ${pass} passed, ${fail} FAILED`
  : `\ntest-comp-report-pure: ${pass} passed`);
process.exit(fail ? 1 : 0);
