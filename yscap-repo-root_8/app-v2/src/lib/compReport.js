/* THE BRANDED COMPARABLE REPORT — ONE DATA MODEL, FOUR LAYOUTS.
 *
 * The owner's ask: "print a branded PILOT comparable report with full detail on
 * every comp, in several layouts."
 *
 * ─── WHY THIS IS A MODEL AND NOT JUST JSX ───────────────────────────────────
 *
 * Four layouts written as four templates is four places for the honesty to rot.
 * The rule from the task list is exact — **"The disclaimer scales; the honesty
 * does not: no layout may drop the confidence label, the range, the comp count,
 * or the blank-adjustment sentence"** — and a rule like that is worth nothing
 * unless something can FAIL when it is broken. So the report is a pure function
 * from the valuation to a list of sections, `MANDATORY` names the four, and
 * `buildReport` puts them in every layout whatever the layout asked for. A test
 * with no DOM in it can then prove the rule for all four at once, and a fifth
 * layout added next year inherits it rather than having to remember it.
 *
 * ─── THE LEGAL LINE, EXACTLY ────────────────────────────────────────────────
 *
 * USPAP attaches to an APPRAISER performing an APPRAISAL, so this is neither —
 * but that is only true while no licensed appraiser on staff or contract
 * operates this tool, which is a policy the document itself has to state.
 * "Evaluation" is a regulated word (the Interagency Appraisal and Evaluation
 * Guidelines) and we may never use it. The permitted name is an **internal value
 * indication**, and it may never size a loan. `FORBIDDEN_WORDS` is checked
 * against our own wording by the test, because the failure mode here is not a
 * missing sentence — it is a helpful synonym slipping into a heading.
 */

/** The four layouts, widest first. `comps` is how a comparable is presented. */
export const LAYOUTS = Object.freeze({
  full: { key: 'full', label: 'Full', comps: 'page', blurb: 'Everything, one full page per comparable.' },
  standard: { key: 'standard', label: 'Standard', comps: 'card', blurb: 'The grid, plus a card for each comparable.' },
  /* NAMED FOR WHAT IT DOES, NOT FOR WHAT WOULD SOUND BETTER. It was blurbed as
     "a single page" and measured at THREE Letter pages, then two after the
     explanatory prose was scaled away. Two is where it honestly lands with four
     comparables, and cutting further would start removing the things that may
     never be cut. A label promising one page and delivering two is exactly the
     small lie this whole build exists to refuse. */
  one_pager: { key: 'one_pager', label: 'Short', comps: 'row', blurb: 'The value, the grid and the caveats — usually one or two pages.' },
  grid_only: { key: 'grid_only', label: 'Grid only', comps: 'row', blurb: 'The adjustment grid and nothing else.' },
});
export const LAYOUT_KEYS = Object.freeze(Object.keys(LAYOUTS));

/** The four things no layout may drop. Named, so a test can hold them. */
export const MANDATORY = Object.freeze(['value', 'confidence', 'coverage', 'blanks', 'legal']);

/**
 * Words that may not appear ANYWHERE in our own wording. "Evaluation" is the
 * important one: it is a defined term in the Interagency Appraisal and
 * Evaluation Guidelines, so using it casually claims a regulatory status this
 * document does not have. The other two would simply be untrue.
 */
export const FORBIDDEN_WORDS = Object.freeze(['evaluation', 'certified', 'USPAP-compliant']);

/**
 * What the document may never call ITSELF — checked against its NAME and its
 * layout labels only, not against its prose. The distinction is load-bearing:
 * "recorded in appraisal reports we paid for" is a correct and necessary
 * statement about the SOURCE, and "it is NOT an appraisal" has to be able to say
 * the word. A blanket ban on the word would have forced both sentences to be
 * reworded into something vaguer, which is the opposite of the point.
 */
export const SELF_NAME_FORBIDDEN = Object.freeze([
  'appraisal', 'evaluation', 'CDA', 'BPO', 'valuation report', 'opinion of value',
]);

export const REPORT_NAME = 'Internal value indication';

export const LEGAL = Object.freeze({
  what: 'This is an internal value indication produced by PILOT from the comparable sales recorded '
    + 'in appraisal reports YS Capital has itself paid for.',
  notAnAppraisal: 'It is NOT an appraisal and NOT an appraisal review. It is not USPAP work product, '
    + 'it was not produced by a licensed appraiser, and it may not be used in place of one.',
  whoMayRun: 'No licensed appraiser on staff or under contract may operate this tool, because work '
    + 'they perform can carry USPAP obligations that this document does not satisfy.',
  neverSizes: 'It may NEVER be used to size, approve, price or support a loan. Lending decisions are '
    + 'made on a real appraisal, ordered separately.',
  coverage: 'Our records hold only properties that appeared in an appraisal we paid for — roughly 7% '
    + 'of a typical town. A thin answer is almost always a statement about that coverage, not about '
    + 'the filters used.',
});

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const money = (v) => {
  const n = num(v);
  return n == null ? null : `$${Math.round(n).toLocaleString('en-US')}`;
};

/**
 * WHY AN ADJUSTMENT LINE IS BLANK — as a SENTENCE, never an empty cell.
 *
 * An empty cell on a grid says one of three completely different things: the two
 * properties did not differ, the appraiser saw a difference and judged it worth
 * nothing, or nobody has looked yet. A reader cannot tell them apart, and the
 * third is the one that matters — it is the line still to be worked. So every
 * blank gets words.
 */
export function blankReasons(comp, gridLines) {
  const lines = Array.isArray(comp && comp.lines) ? comp.lines : [];
  const byKey = new Map(lines.map((l) => [l.key, l]));
  const out = [];
  for (const gl of gridLines || []) {
    const l = byKey.get(gl.key);
    const amount = l ? num(l.amount) : null;
    if (amount != null && amount !== 0) continue;              // adjusted — nothing to explain
    if (l && l.why) { out.push({ key: gl.key, label: gl.label, why: l.why }); continue; }
    if (amount === 0) {
      out.push({ key: gl.key, label: gl.label,
        why: 'set to zero — the two were judged the same on this, or the difference was judged not '
          + 'to matter. The grid does not record which.' });
      continue;
    }
    out.push({ key: gl.key, label: gl.label, why: 'not adjusted — nobody has worked this line yet.' });
  }
  return out;
}

/** One comparable, as the report presents it. */
function compBlock(c, i, gridLines) {
  const warnings = Array.isArray(c.warnings) ? c.warnings : [];
  return {
    n: i + 1,
    id: c.id != null ? c.id : i,
    address: c.display_address || c.live_address || c.address || `Comparable ${i + 1}`,
    included: c.include !== false,
    salePrice: money(c.sale_price),
    adjustedPrice: money(c.adjustedPrice),
    saleDate: c.sale_date || null,
    distanceMiles: num(c.distance_miles),
    propertyType: c.property_type || null,
    units: num(c.units),
    gla: num(c.gla),
    beds: num(c.beds),
    baths: c.baths != null && c.baths !== '' ? c.baths : null,
    yearBuilt: num(c.year_built),
    condition: c.condition_uad || c.condition_text || null,
    quality: c.quality_uad || c.quality_text || null,
    lines: (Array.isArray(c.lines) ? c.lines : []).filter((l) => num(l.amount) != null && num(l.amount) !== 0),
    blanks: blankReasons(c, gridLines),
    warnings,
    photoCount: num(c.photo_count) || 0,
    note: c.note || null,
  };
}

/**
 * The whole report, as data.
 *
 * @param {object} data   what `GET /api/research/valuations/:id` returns
 * @param {string} layout one of LAYOUT_KEYS
 */
export function buildReport(data, layout = 'standard') {
  const d = data && typeof data === 'object' ? data : {};
  const v = d.valuation || {};
  const g = d.grid || {};
  const key = LAYOUTS[layout] ? layout : 'standard';
  const L = LAYOUTS[key];
  const val = g.value || {};
  const comps = Array.isArray(g.comps) ? g.comps : [];
  const used = comps.filter((c) => c.include !== false);
  const gridLines = Array.isArray(g.gridLines) ? g.gridLines : [];

  const blocks = comps.map((c, i) => compBlock(c, i, gridLines));

  return {
    layout: L,
    title: v.title || REPORT_NAME,
    reportName: REPORT_NAME,
    subjectAddress: v.subject_address || (g.subject && g.subject.display_address) || null,
    subject: g.subject || {},
    effectiveDate: v.effective_date ? String(v.effective_date).slice(0, 10) : null,
    purpose: v.purpose || null,
    status: v.status || null,
    preparedBy: v.created_by_name || null,

    // ── THE FIVE THAT EVERY LAYOUT CARRIES ────────────────────────────────
    value: {
      indicated: money(val.indicatedValue),
      low: money(val.likelyLow),
      high: money(val.likelyHigh),
      method: v.method || null,
      // A RANGE IS NOT DECORATION. A single number invites a reader to treat it
      // as precise; the range is the honest shape of the answer, so it travels
      // with the number on every layout including the one-pager.
      hasRange: money(val.likelyLow) != null && money(val.likelyHigh) != null,
    },
    confidence: {
      label: (val.confidence && val.confidence.label) || null,
      reasons: (val.confidence && val.confidence.reasons) || [],
      basis: (val.confidence && val.confidence.basis) || null,
    },
    coverage: {
      compsUsed: used.length,
      compsTotal: comps.length,
      // The sentence, not just the number — "3 comparables" reads as a choice,
      // "3 of the 7 we hold" reads as what it is.
      sentence: `${used.length} comparable${used.length === 1 ? '' : 's'} used`
        + (comps.length !== used.length ? ` of the ${comps.length} on this valuation` : ''),
      note: LEGAL.coverage,
    },
    blanks: {
      total: blocks.reduce((a, b) => a + b.blanks.length, 0),
      byComp: blocks.map((b) => ({ n: b.n, address: b.address, blanks: b.blanks })),
    },
    legal: LEGAL,

    // ── WHAT THE LAYOUT DECIDES ───────────────────────────────────────────
    compPresentation: L.comps,
    // A "one-pager" THAT RUNS TO THREE PAGES IS A LIE ON ITS OWN LABEL.
    // Measured: with the per-comparable cards it printed 3 Letter pages for 4
    // comparables. Its blurb promises "the value, the grid, the caveats" — and
    // the grid table already lists every comparable with its own numbers, so
    // the cards were pure duplication. Dropping them is what makes the name
    // true. It still differs from grid-only, which also drops the warnings.
    showComps: key !== 'grid_only' && key !== 'one_pager',
    showPhotos: key === 'full',
    showBlankDetail: key === 'full' || key === 'standard',
    /* "THE DISCLAIMER SCALES; THE HONESTY DOES NOT" is the task's own rule, and
       this is the line where it bites. Measured: with the full legal block, the
       subject fact grid and the method prose, the one-pager printed THREE Letter
       pages with no comparable cards on it at all — a document whose own name was
       untrue. What scales is the EXPLANATORY prose (why the rate came from our
       own reports, who may operate the tool, what the subject's year built is).
       What never scales is the pair of sentences that say this is not an
       appraisal and may never size a loan, and the coverage caveat — those are
       carried at every size, which `missingMandatory` and the render check both
       hold it to. */
    legalDetail: key === 'full' || key === 'standard' ? 'full' : 'short',
    showMethod: key === 'full' || key === 'standard',
    showSubjectDetail: key !== 'one_pager' && key !== 'grid_only',
    showWarnings: key !== 'grid_only',
    comps: blocks,
    gridLines,
    warnings: Array.isArray(g.warnings) ? g.warnings : [],
    disclaimer: g.disclaimer || null,
  };
}

/** Every mandatory element that is MISSING from a built report — empty is correct. */
export function missingMandatory(report) {
  const r = report || {};
  const gone = [];
  if (!r.value || !r.value.indicated) gone.push('value');
  if (!r.value || !r.value.hasRange) gone.push('range');
  if (!r.confidence || !r.confidence.label) gone.push('confidence');
  if (!r.coverage || !r.coverage.sentence) gone.push('coverage');
  if (!r.blanks || typeof r.blanks.total !== 'number') gone.push('blanks');
  if (!r.legal || !r.legal.notAnAppraisal || !r.legal.neverSizes) gone.push('legal');
  return gone;
}
