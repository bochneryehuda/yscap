/**
 * PILOT collateral scoring — an HONEST, fully-explainable read of the collateral, never a
 * fabricated black-box number. Two independent reads:
 *
 *   collateralScore(...)  -> a 1–5 roll-up of the appraisal's own quality signals (condition,
 *                            quality, valuation confidence, comp support, flood, zoning, open
 *                            findings). Every point of movement is returned as a labelled factor
 *                            so the underwriter sees EXACTLY why — the number is a convenience,
 *                            the factors are the truth.
 *
 *   arvDefensibility(...) -> does the renovation BUDGET support the After-Repair uplift? Compares
 *                            (ARV − As-Is) to the rehab budget. A value-add far larger than the
 *                            spend is the classic inflated-ARV signal; an uplift below the spend is
 *                            a negative-ROI signal. Returns null when the inputs to judge it aren't
 *                            all known (never guessed).
 *
 * Both are ADVISORY reads for the underwriter — they never change the file, never gate CTC, and
 * are recomputed live on every read (no stored score to go stale). Pure + dependency-free.
 * Operates on the STORED appraisal row shape (snake_case) so both read routes can call it.
 */

function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
const money = (n) => (n == null ? null : `$${Number(n).toLocaleString('en-US')}`);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const cCode = (s) => { const m = /^C\s*([1-6])/i.exec(String(s || '')); return m ? Number(m[1]) : null; };
const qCode = (s) => { const m = /^Q\s*([1-6])/i.exec(String(s || '')); return m ? Number(m[1]) : null; };

const BANDS = { 5: 'Strong', 4: 'Solid', 3: 'Adequate', 2: 'Watch', 1: 'Weak' };

/**
 * @param {{a:object, comps?:array, summary?:object}} args
 *   a       — the appraisals row (snake_case: as_is_confidence, condition_uad, quality_uad,
 *             flood_zone, zoning_compliance, arv_value, ...).
 *   comps   — appraisal_comparables rows (for closed-comp count).
 *   summary — { fatal, warning } open-findings roll-up (optional).
 * @returns {{score:number, band:string, factors:Array<{label:string,effect:number,detail:string}>}}
 */
function collateralScore({ a, comps = [], summary = {} } = {}) {
  if (!a) return null;
  const factors = [];
  const add = (label, effect, detail) => { if (effect !== 0) factors.push({ label, effect, detail }); };
  let pts = 3; // neutral baseline = "Adequate"

  // Condition (UAD C1–C6): the single strongest collateral signal.
  const c = cCode(a.condition_uad);
  if (c != null) {
    const eff = c <= 2 ? 1.5 : c === 3 ? 1 : c === 4 ? 0 : c === 5 ? -1 : -2;
    add(`Condition ${a.condition_uad}`, eff, c <= 3 ? 'Well-kept condition supports the value.' : c === 4 ? 'Average condition.' : 'Poor/very-poor condition weakens the collateral.');
    pts += eff;
  }
  // Quality of construction (Q1–Q6).
  const q = qCode(a.quality_uad);
  if (q != null) {
    const eff = q <= 2 ? 0.75 : q === 3 ? 0.5 : q === 4 ? 0 : q === 5 ? -0.75 : -1;
    add(`Quality ${a.quality_uad}`, eff, q <= 3 ? 'Above-average construction quality.' : q === 4 ? 'Average quality.' : 'Low construction quality.');
    pts += eff;
  }
  // Valuation confidence — was the operative value read at all? (A narrative-read As-Is is stored
  // as 'definite' too — it's a real value from the report, not an estimate — so we credit
  // "present" rather than overclaiming "read cleanly", and only penalise a value we could NOT read.)
  if (a.as_is_confidence === 'definite') { add('As-Is value present', 0.5, 'The appraisal carries an As-Is value.'); pts += 0.5; }
  else if (a.as_is_confidence === 'missing') { add('As-Is not read', -0.5, 'The As-Is value could not be read from the appraisal — an officer must confirm it.'); pts -= 0.5; }

  // Comp support — CLOSED sales only. An active/pending listing's "sale price" is an asking price,
  // not a settled comp, so it never counts toward the closed-comp credit (accepts either the
  // stored snake_case sale_status or the parsed saleStatus).
  const isClosedComp = (x) => { const s = x.sale_status != null ? x.sale_status : x.saleStatus; return s == null || s === 'closed'; };
  const closed = (comps || []).filter((x) => num(x.sale_price) != null && isClosedComp(x));
  if (closed.length >= 3) { add(`${closed.length} closed comps`, 0.5, 'A full set of closed comparable sales supports the value.'); pts += 0.5; }
  else if (comps && comps.length > 0) { add(`Only ${closed.length} closed comp${closed.length === 1 ? '' : 's'}`, -0.75, 'A thin comp pool gives the value less support.'); pts -= 0.75; }

  // Flood.
  const fz = String(a.flood_zone || '').toUpperCase();
  if (/^(A|V)/.test(fz)) { add(`Flood zone ${fz}`, -0.75, 'A special flood hazard area — insurance and risk implications.'); pts -= 0.75; }

  // Zoning.
  if (/nonconform|legal.?non/i.test(a.zoning_compliance || '')) { add('Legal non-conforming zoning', -0.5, 'Rebuild-to-current-use may be restricted.'); pts -= 0.5; }
  else if (/illegal|no.?zoning/i.test(a.zoning_compliance || '')) { add('Zoning non-compliance', -1, 'An illegal/non-compliant use is a material risk.'); pts -= 1; }

  // Open findings drag the score down (each fatal is a real blocker).
  const fatal = num(summary.fatal) || 0;
  if (fatal > 0) { add(`${fatal} open fatal finding${fatal === 1 ? '' : 's'}`, -Math.min(2, fatal), 'Unresolved fatal findings must clear before this is lendable.'); pts -= Math.min(2, fatal); }

  const score = clamp(Math.round(pts), 1, 5);
  return { score, band: BANDS[score], factors };
}

/**
 * ARV defensibility — is the After-Repair uplift backed by the renovation budget?
 * @param {{arv:number, asIs:number, rehab:number, isReno?:boolean}} args
 * @returns {null|{band:string, verdict:string, uplift:number, rehab:number|null, ratio:number|null, title:string, detail:string}}
 *   band: 'strong'|'moderate'|'thin'|'no_uplift'|'no_budget'. null when ARV or As-Is is unknown
 *   (nothing to judge — never guessed).
 */
function arvDefensibility({ arv, asIs, rehab, isReno = true } = {}) {
  const A = num(arv), I = num(asIs), R = num(rehab);
  if (A == null || I == null) return null;      // no ARV/As-Is → nothing to defend
  const uplift = A - I;

  if (uplift <= 0) {
    return { band: 'no_uplift', verdict: 'No after-repair uplift', uplift, rehab: R, ratio: null,
      title: 'The After-Repair Value is not above the As-Is value',
      detail: `ARV ${money(A)} is not above As-Is ${money(I)} — the renovation shows no value created. Confirm the ARV basis and the scope of work.` };
  }
  if (R == null || R <= 0) {
    // An ARV uplift with no renovation budget on file is only notable on a reno deal.
    if (!isReno) return null;
    return { band: 'no_budget', verdict: 'Uplift with no budget on file', uplift, rehab: R, ratio: null,
      title: 'After-repair uplift with no renovation budget on the file',
      detail: `The appraisal shows a ${money(uplift)} after-repair uplift but the file has no rehab budget to support it. Confirm the scope of work is registered.` };
  }
  const ratio = uplift / R;
  if (ratio <= 1.5) {
    return { band: 'strong', verdict: 'Uplift backed by the budget', uplift, rehab: R, ratio,
      title: 'After-repair value is well supported by the renovation budget',
      detail: `The ${money(uplift)} uplift is ${ratio.toFixed(1)}× the ${money(R)} renovation budget — a defensible value-add.` };
  }
  if (ratio <= 2.5) {
    return { band: 'moderate', verdict: 'Uplift outruns the budget somewhat', uplift, rehab: R, ratio,
      title: 'After-repair uplift is somewhat larger than the renovation budget',
      detail: `The ${money(uplift)} uplift is ${ratio.toFixed(1)}× the ${money(R)} budget. Some forced appreciation is normal, but confirm the comps carry the after-repair value.` };
  }
  return { band: 'thin', verdict: 'Uplift far exceeds the budget', uplift, rehab: R, ratio,
    title: 'After-repair uplift is far larger than the renovation budget',
    detail: `The ${money(uplift)} uplift is ${ratio.toFixed(1)}× the ${money(R)} renovation budget — a value-add much bigger than the spend is the classic inflated-ARV signal. Scrutinize the after-repair comps.` };
}

function median(arr) {
  const a = arr.filter((n) => n != null).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * Independent value cross-check — what the COMPS themselves imply, computed independently of the
 * appraiser's reconciliation. Two lenses: the median adjusted sale price, and the median comp
 * $/GLA applied to the subject's size. Never guessed: needs ≥3 comps with an adjusted price, and
 * returns null otherwise. Accepts either the STORED comp rows (adjusted_price/price_per_gla/gla)
 * or the parsed shape (adjustedPrice/pricePerGla/gla).
 * @returns {null|{median:number, low:number, high:number, perGlaValue:number|null, medianPerGla:number|null, n:number}}
 */
function compImpliedValue({ comps, subjectGla } = {}) {
  // Exclude the subject AND any active/pending listing — the implied value is what CLOSED sales
  // say, never an asking price (accepts stored sale_status or parsed saleStatus).
  const real = (comps || []).filter((c) => !(c.is_subject) && (() => { const s = c.sale_status != null ? c.sale_status : c.saleStatus; return s == null || s === 'closed'; })());
  const adj = real.map((c) => num(c.adjusted_price != null ? c.adjusted_price : c.adjustedPrice)).filter((n) => n != null && n > 0);
  if (adj.length < 3) return null;                         // too thin to form an independent opinion
  const gSub = num(subjectGla);
  const perGlas = real.map((c) => num(c.price_per_gla != null ? c.price_per_gla : c.pricePerGla)).filter((n) => n != null && n > 0);
  const medianPerGla = perGlas.length >= 3 ? median(perGlas) : null;
  const perGlaValue = (medianPerGla != null && gSub != null && gSub > 0) ? Math.round(medianPerGla * gSub) : null;
  return { median: Math.round(median(adj)), low: Math.min(...adj), high: Math.max(...adj), perGlaValue, medianPerGla: medianPerGla != null ? Math.round(medianPerGla) : null, n: adj.length };
}

module.exports = { collateralScore, arvDefensibility, compImpliedValue, _internals: { cCode, qCode, median } };
