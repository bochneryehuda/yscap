/**
 * PILOT findings — compare a parsed appraisal against the loan file and raise findings.
 *
 * Owner contract (2026-07-19):
 *   - EVERY mapped field that differs between the appraisal and our file becomes a finding.
 *   - We NEVER overwrite the file. Each finding is the underwriter's decision.
 *   - A value/identity mismatch is FATAL and blocks clear-to-close (via the
 *     `appraisal_review_cleared` internal condition); softer signals are warnings.
 *   - Fields we could not read with certainty (confidence !== 'definite') are NOT compared —
 *     they route to the As-Is officer condition / show as "verify", never a false mismatch.
 *
 * Pure + dependency-free. `appraisal` is the object from extract(); `file` is the loan row
 * (applications). `opts` carries owner-tunable thresholds (defaults below). Returns an array of
 * findings; the caller persists them and derives the blocking condition + badge count.
 *
 * Designed to extend to future sources (credit report, title) — a finding just needs a
 * {source, field, appraisalValue|sourceValue, fileValue} shape.
 */

const { arvDefensibility, compImpliedValue } = require('./scoring');

const DEFAULTS = {
  valueTolerancePct: 2,        // ARV/As-Is: treat within this % (and $) as a match
  valueToleranceAbs: 5000,
  priceTolerancePct: 1,
  priceToleranceAbs: 2500,
  maxNetAdjPct: 15,            // comp net adjustment guideline
  maxGrossAdjPct: 25,          // comp gross adjustment guideline
  effectiveDateMaxDays: 120,   // appraisal staleness at note
  flipMarkupPct: 20,           // prior-sale markup that flags a flip
  // ---- comp-grid review checks (Phase 1; all advisory warnings, never CTC-blocking) ----
  minClosedComps: 3,           // fewer closed comps than this is a thin support pool
  compRecencyMaxMonths: 12,    // a comp settled more than this before the effective date is stale
  compDistanceMaxMiles: 2,     // a comp farther than this from the subject is a distance concern (market-dependent)
  glaBracketTolerancePct: 10,  // subject GLA should sit within (±this%) the comp GLA range
  valueVsCompsPct: 10,         // a value this% above the comp median (but still in range) is flagged
  flipSeasoningMonths: 12,     // a subject resold within this window before the appraisal flags for seasoning
  today: null,                 // 'YYYY-MM-DD' — injected (no new Date() in date paths)
};

const money = (n) => (n == null ? null : `$${Number(n).toLocaleString('en-US')}`);
// Number or null. CRUCIAL: null/undefined/'' → null (NOT 0). `Number(null)` is 0, which would
// make an empty file value (e.g. a file with no ARV yet) read as $0 and fire a false "appraisal
// vs file 0" mismatch — exactly the kind of guessed comparison the owner forbids. So a value we
// don't have is "can't compare", never zero.
function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function withinTol(a, b, pct, abs) {
  if (a == null || b == null) return null;                 // can't compare
  const d = Math.abs(a - b);
  return d <= abs || d <= (Math.abs(b) * pct) / 100;
}
// normalize an address string for comparison (drop punctuation/case/whitespace, expand nothing fancy)
function normAddr(s) { return String(s || '').toLowerCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim(); }
// Whole-token containment: does `hayTokens` contain `needleTokens` as a CONTIGUOUS run? A plain
// String.includes() substring test conflates "76 thompson" with "176 thompson" (a real
// wrong-property mismatch that would be silently swallowed) and also false-matches a street word
// buried inside a longer word. Compare whole tokens instead.
function containsTokenSeq(hayTokens, needleTokens) {
  if (!needleTokens.length || needleTokens.length > hayTokens.length) return false;
  for (let i = 0; i + needleTokens.length <= hayTokens.length; i++) {
    let ok = true;
    for (let j = 0; j < needleTokens.length; j++) { if (hayTokens[i + j] !== needleTokens[j]) { ok = false; break; } }
    if (ok) return true;
  }
  return false;
}
function fileAddress(file) {
  const pa = file && file.property_address;
  if (!pa) return null;
  if (typeof pa === 'string') { try { return JSON.parse(pa); } catch { return { line: pa }; } }
  return pa;
}
// The file's best full street line. The portal stores the street under DIFFERENT keys in
// different shapes: `line1` (the normalized shape from src/lib/address.js + intake), `oneLine`
// (the display string the app renders), or `street`/`line`/`address` in older/other shapes.
// Read them ALL (mirroring app-v2 addrLine), then compose with city/state/zip — otherwise a
// file whose street lives in `line1`/`oneLine` collapses to just "City, ST" and fires a false
// address-mismatch fatal.
function fileAddrLine(file) {
  const fa = fileAddress(file);
  if (!fa) return null;
  if (typeof fa === 'string') return fa;
  const street = fa.line1 || fa.street || fa.line || fa.address || fa.address1 || '';
  let line = fa.oneLine || '';
  if (!line || (street && !normAddr(line).includes(normAddr(street)))) {
    line = [street, fa.city, fa.state, fa.zip].filter(Boolean).join(', ');
  }
  return line || null;
}
// Map the file's property_type text to a class key. Mirrors src/lib/mismo/enums.js
// (unitsHint/toMismoAttachment) so the appraisal + loan-interchange modules agree on
// the portal's property-type vocabulary. Returns null when unknown (never guesses).
function fileClass(t) {
  const s = String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!s) return null;
  if (s.startsWith('sfr') || s.includes('singlefamily')) return 'sfr';
  if (s.includes('condo')) return 'condo';
  if (s.includes('town')) return 'town';
  if (s.includes('multi5') || s.includes('multi54')) return 'multi5';
  if (s.includes('multi2') || s.includes('multi24')) return 'multi24';
  if (s.includes('mixed')) return 'mixed';
  return null;
}

function finding(f) {
  return Object.assign({ source: 'appraisal', severity: 'fatal', status: 'open', blocksCtc: f.severity !== 'warning' && f.severity !== 'info' }, f);
}

function computeFindings(appraisal, file, opts = {}) {
  const o = Object.assign({}, DEFAULTS, opts);
  const out = [];
  if (!appraisal || !appraisal.ok) return out;
  const A = appraisal;
  const v = A.values || {};

  // ---- 1. Identity: address ----
  // Compare on the appraisal's house-number + first street word (e.g. "76 thompson"). Only
  // fire when the appraisal actually carries a street number, and only when the file's full
  // line (all address-key shapes) does not contain that key — so a differently-keyed but
  // matching file address never triggers a false "wrong property" fatal.
  const faLine = fileAddrLine(file);
  const subjStreet = normAddr(A.subject.address);
  const subjTokens = subjStreet.split(' ').filter(Boolean).slice(0, 2); // house-number + first street word
  if (subjStreet && /\d/.test(subjStreet) && faLine && subjTokens.length &&
      !containsTokenSeq(normAddr(faLine).split(' ').filter(Boolean), subjTokens)) {
    out.push(finding({ code: 'address_mismatch', severity: 'fatal', field: 'address',
      appraisalValue: [A.subject.address, A.subject.city, A.subject.state].filter(Boolean).join(', '),
      fileValue: faLine,
      title: 'Appraisal address does not match the file',
      howTo: 'Confirm this is the right property. A different address means the appraisal may be for the wrong file.',
      actions: ['replace', 'keep', 'custom', 'dismiss', 'decline'] }));
  }

  // ---- 2. Units ----
  const fUnits = num(file && file.units);
  if (A.subject.units != null && fUnits != null && A.subject.units !== fUnits) {
    out.push(finding({ code: 'units_mismatch', severity: 'fatal', field: 'units',
      appraisalValue: A.subject.units, fileValue: fUnits, delta: A.subject.units - fUnits,
      title: `Units don't match — appraisal ${A.subject.units}, file ${fUnits}`,
      howTo: 'A different unit count changes the form, program and sizing. Replace re-prices the loan; keeping the file value may mean the appraisal is the wrong property.',
      actions: ['replace', 'keep', 'custom', 'dismiss', 'decline'], reprices: true }));
  }

  // ---- 3. Property type ----
  // The appraisal form implies a property class; flag when the file clearly disagrees.
  // Class keys mirror src/lib/mismo/enums.js so the two modules never drift on the
  // portal's property-type vocabulary ('SFR (1 unit)' | 'Multi 2–4' | 'Condo' | …).
  const formClass = { FNM1004: 'sfr', FNM1025: 'multi24', FNM1073: 'condo' }[A.formType];
  const fc = fileClass(file && file.property_type);
  if (formClass && fc && fc !== formClass && !(formClass === 'multi24' && fc === 'multi5')) {
    out.push(finding({ code: 'property_type_mismatch', severity: 'fatal', field: 'property_type',
      appraisalValue: A.formType, fileValue: file.property_type,
      title: `Property type disagrees — appraisal is a ${formClass === 'sfr' ? 'single-family (1004)' : formClass === 'condo' ? 'condo (1073)' : '2–4 unit (1025)'} form, file says ${file.property_type}`,
      howTo: 'The appraisal form and the file describe different property kinds. Confirm which is right — a wrong type changes the program and eligibility.',
      actions: ['replace', 'keep', 'custom', 'dismiss', 'decline'], reprices: true }));
  }

  // ---- 4. ARV ----
  const fArv = num(file && file.arv);
  if (v.arv != null && v.arvConfidence === 'definite' && fArv != null) {
    const match = withinTol(v.arv, fArv, o.valueTolerancePct, o.valueToleranceAbs);
    if (match === false) {
      const lower = v.arv < fArv;
      out.push(finding({ code: 'arv_mismatch', severity: 'fatal', field: 'arv',
        appraisalValue: v.arv, fileValue: fArv, delta: v.arv - fArv,
        title: `ARV differs from the file (${lower ? 'appraisal lower' : 'appraisal higher'})`,
        howTo: lower
          ? `Appraisal ARV is ${money(v.arv)} vs file ${money(fArv)} — ${money(fArv - v.arv)} lower. Replacing writes the appraisal value and re-prices; a lower ARV may reduce the loan.`
          : `Appraisal ARV is ${money(v.arv)} vs file ${money(fArv)} — ${money(v.arv - fArv)} higher. Replacing re-prices; a higher ARV may allow more loan.`,
        actions: ['replace', 'keep', 'custom', 'dismiss'], reprices: true }));
    }
  }

  // ---- 5. As-Is ----
  const fAsIs = num(file && file.as_is_value);
  if (v.asIs != null && v.asIsConfidence === 'definite' && fAsIs != null) {
    if (withinTol(v.asIs, fAsIs, o.valueTolerancePct, o.valueToleranceAbs) === false) {
      out.push(finding({ code: 'asis_mismatch', severity: 'fatal', field: 'as_is_value',
        appraisalValue: v.asIs, fileValue: fAsIs, delta: v.asIs - fAsIs,
        title: 'As-Is value differs from the file',
        howTo: `Appraisal As-Is ${money(v.asIs)} vs file ${money(fAsIs)}. Replacing re-prices (As-Is drives the As-Is LTV and LTC caps).`,
        actions: ['replace', 'keep', 'custom', 'dismiss'], reprices: true }));
    }
  }

  // ---- 6. Purchase / contract price ----
  const fPP = num(file && file.purchase_price);
  if (v.contractPrice != null && fPP != null &&
      withinTol(v.contractPrice, fPP, o.priceTolerancePct, o.priceToleranceAbs) === false) {
    out.push(finding({ code: 'price_mismatch', severity: 'fatal', field: 'purchase_price',
      appraisalValue: v.contractPrice, fileValue: fPP, delta: v.contractPrice - fPP,
      title: 'Contract price on the appraisal differs from the file',
      howTo: `Appraisal shows a ${money(v.contractPrice)} contract vs file ${money(fPP)}. Reconcile — a wrong price flows into every leverage cap.`,
      actions: ['replace', 'keep', 'custom', 'dismiss'], reprices: true }));
  }

  // ---- 7. As-Is below purchase price (equity / collateral concern) ----
  if (v.asIs != null && v.asIsConfidence === 'definite' && fPP != null && v.asIs < fPP) {
    out.push(finding({ code: 'asis_below_price', severity: 'fatal', field: 'as_is_value',
      appraisalValue: v.asIs, fileValue: fPP,
      title: 'As-Is value is below the purchase price',
      howTo: `As-Is ${money(v.asIs)} < purchase ${money(fPP)}. The borrower is paying over the as-is collateral value — requires an exception or decline.`,
      actions: ['grant_exception', 'dismiss', 'decline'] }));
  }

  // ---- 8. As-Is could not be read (route to officer condition, not a mismatch) ----
  if ((v.asIs == null || v.asIsConfidence !== 'definite')) {
    out.push(finding({ code: 'asis_unreadable', severity: 'warning', field: 'as_is_value',
      appraisalValue: null, fileValue: fAsIs,
      title: 'As-Is value could not be read from the appraisal data',
      howTo: 'Opens the “Verify As-Is value” task — an officer reads it off the report (OCR may pre-fill a candidate for confirmation). Never guessed.',
      actions: ['open_condition'], opensCondition: 'appraisal_as_is_verify' }));
  }

  // ---- 9. ARV must exist on a reno deal ----
  if (v.arv == null && A.formType !== 'FNM1073' && v.conditionOfAppraisal && /SubjectTo/.test(v.conditionOfAppraisal)) {
    out.push(finding({ code: 'arv_unreadable', severity: 'fatal', field: 'arv',
      title: 'ARV could not be read on a subject-to (renovation) appraisal',
      howTo: 'ARV is required to price a renovation loan (LTARV). Verify the report and enter the ARV.',
      actions: ['open_condition', 'custom'], opensCondition: 'appraisal_as_is_verify' }));
  }

  // ---- 10. Comp adjustment magnitude (warnings, from the review-platform research) ----
  (A.comparables || []).forEach((c) => {
    if (c.netAdjPct != null && Math.abs(c.netAdjPct) > o.maxNetAdjPct) {
      out.push(finding({ code: 'comp_net_adj', severity: 'warning', field: 'comps',
        appraisalValue: `${c.netAdjPct}%`, title: `Comp ${c.seq} net adjustment ${c.netAdjPct}% exceeds ${o.maxNetAdjPct}%`,
        howTo: 'Large adjustments weaken the comp. Acknowledge or note it — not a blocker.',
        actions: ['acknowledge', 'dismiss'] }));
    } else if (c.grossAdjPct != null && Math.abs(c.grossAdjPct) > o.maxGrossAdjPct) {
      out.push(finding({ code: 'comp_gross_adj', severity: 'warning', field: 'comps',
        appraisalValue: `${c.grossAdjPct}%`, title: `Comp ${c.seq} gross adjustment ${c.grossAdjPct}% exceeds ${o.maxGrossAdjPct}%`,
        howTo: 'High gross adjustments indicate a weak comp. Acknowledge or note it.',
        actions: ['acknowledge', 'dismiss'] }));
    }
  });

  // ---- 11. Appraiser license expired ----
  if (A.appraiser && A.appraiser.licenseExp && o.today && A.appraiser.licenseExp < o.today) {
    out.push(finding({ code: 'license_expired', severity: 'fatal', field: 'appraiser',
      appraisalValue: A.appraiser.licenseExp,
      title: 'Appraiser license is expired', howTo: `License expired ${A.appraiser.licenseExp}. A valid license is required — request a corrected/updated appraisal.`,
      actions: ['dismiss', 'decline', 'request_revision'] }));
  }

  // ---- 12. C6 / Q6 (surfaced from the parser warnings) ----
  for (const w of A.warnings || []) {
    if (w.code === 'condition_c6' || w.code === 'quality_q6') {
      out.push(finding({ code: w.code, severity: 'fatal', field: 'condition',
        title: w.msg, howTo: 'A C6/Q6 property is typically ineligible — requires an exception or repairs before funding.',
        actions: ['grant_exception', 'dismiss', 'decline'] }));
    }
  }

  // ---- 13. Effective date staleness ----
  if (v.effectiveDate && o.today) {
    const days = daysBetween(v.effectiveDate, o.today);
    if (days != null && days > o.effectiveDateMaxDays) {
      out.push(finding({ code: 'stale_effective_date', severity: 'fatal', field: 'effective_date',
        appraisalValue: v.effectiveDate,
        title: `Appraisal effective date is ${days} days old (over ${o.effectiveDateMaxDays})`,
        howTo: 'A recert of value or a new appraisal is typically required past this window.',
        actions: ['dismiss', 'request_revision'] }));
    }
  }

  // ---- 14–20. Comp-grid review checks (advisory warnings from the appraisal-review
  //   research — they inform the underwriter, they never block clear-to-close and never
  //   change the file). Each fires ONLY when the data it needs was actually read. ----
  const comps = A.comparables || [];
  const closed = comps.filter((c) => num(c.salePrice) != null);

  // 14. Comp pool adequacy — a thin closed-sale pool weakens the value opinion.
  if (comps.length > 0 && closed.length < o.minClosedComps) {
    out.push(finding({ code: 'comp_pool_thin', severity: 'warning', field: 'comps',
      appraisalValue: `${closed.length} closed`, fileValue: null,
      title: `Only ${closed.length} closed comparable sale${closed.length === 1 ? '' : 's'} (guideline is ${o.minClosedComps}+)`,
      howTo: 'A thin comp pool gives the value less support. Confirm the appraiser could not find more closed sales, or request additional comps.',
      actions: ['acknowledge', 'dismiss', 'request_revision'] }));
  }

  // 15. Comp recency — comps settled long before the effective date are stale support.
  if (v.effectiveDate) {
    const stale = closed
      .map((c) => ({ c, mo: monthsBetween(c.saleDate, v.effectiveDate) }))
      .filter((x) => x.mo != null && x.mo > o.compRecencyMaxMonths);
    if (stale.length) {
      out.push(finding({ code: 'comp_recency', severity: 'warning', field: 'comps',
        appraisalValue: stale.map((x) => `#${x.c.seq} (${x.mo}mo)`).join(', '),
        title: `${stale.length} comp${stale.length === 1 ? '' : 's'} sold more than ${o.compRecencyMaxMonths} months before the effective date`,
        howTo: 'Older sales reflect an older market. Confirm no more recent comps exist, or ask for updated support.',
        actions: ['acknowledge', 'dismiss', 'request_revision'] }));
    }
  }

  // 16. Value bracketing — the opinion of value should sit within the adjusted comp range.
  const adj = closed.map((c) => num(c.adjustedPrice)).filter((n) => n != null);
  const subjVal = num(v.appraisedValue) != null ? num(v.appraisedValue) : num(v.valueSalesApproach);
  if (subjVal != null && adj.length >= o.minClosedComps) {
    const hi = Math.max(...adj), lo = Math.min(...adj);
    if (subjVal > hi || subjVal < lo) {
      const above = subjVal > hi;
      out.push(finding({ code: 'value_not_bracketed', severity: 'warning', field: 'value',
        appraisalValue: money(subjVal), fileValue: `${money(lo)}–${money(hi)}`,
        title: `Opinion of value is ${above ? 'above' : 'below'} the adjusted comparable range`,
        howTo: `The value ${money(subjVal)} sits ${above ? 'above the highest' : 'below the lowest'} adjusted comp (${money(lo)}–${money(hi)}). A value the comps don't bracket is worth a second look — confirm the adjustments support it.`,
        actions: ['acknowledge', 'dismiss', 'request_revision'] }));
    }
  }

  // 16b. Independent value cross-check — even WITHIN the comp range, a value well above what the
  //   comps imply (their median adjusted price) is worth a second look. Fires only when the value
  //   is inside the CLOSED-comp bracket (the same `adj`/`hi` value_not_bracketed uses, so the two
  //   can never double-flag — even when a listing comp with no sale price lifts the implied high)
  //   and materially above the comp median. Advisory.
  if (subjVal != null && adj.length >= o.minClosedComps) {
    const implied = compImpliedValue({ comps: A.comparables, subjectGla: A.subject.gla });
    const hiClosed = Math.max(...adj);
    if (implied && subjVal <= hiClosed && subjVal > implied.median * (1 + o.valueVsCompsPct / 100)) {
      const overPct = Math.round(((subjVal - implied.median) / implied.median) * 100);
      out.push(finding({ code: 'value_vs_comps', severity: 'warning', field: 'value',
        appraisalValue: money(subjVal), fileValue: `comps imply ${money(implied.median)}`,
        title: `Opinion of value is ${overPct}% above what the comps imply`,
        howTo: `The reconciled value ${money(subjVal)} is ${overPct}% above the median adjusted comp (${money(implied.median)}${implied.perGlaValue ? `; $/sqft implies ${money(implied.perGlaValue)}` : ''}). It's still within the comp range, but sits at the top — confirm the adjustments carry it.`,
        actions: ['acknowledge', 'dismiss', 'request_revision'] }));
    }
  }

  // 17. GLA bracketing — the subject size should be bracketed by the comps.
  const glas = closed.map((c) => num(c.gla)).filter((n) => n != null && n > 0);
  const subjGla = num(A.subject.gla);
  if (subjGla != null && glas.length >= o.minClosedComps) {
    const hi = Math.max(...glas), lo = Math.min(...glas);
    const band = (o.glaBracketTolerancePct / 100);
    if (subjGla > hi * (1 + band) || subjGla < lo * (1 - band)) {
      const above = subjGla > hi;
      out.push(finding({ code: 'gla_not_bracketed', severity: 'warning', field: 'gla',
        appraisalValue: `${subjGla.toLocaleString('en-US')} sqft`, fileValue: `${lo.toLocaleString('en-US')}–${hi.toLocaleString('en-US')} sqft`,
        title: `Subject size is not bracketed by the comps (${above ? 'larger' : 'smaller'} than the comp range)`,
        howTo: `The subject is ${subjGla.toLocaleString('en-US')} sqft vs a comp range of ${lo.toLocaleString('en-US')}–${hi.toLocaleString('en-US')} sqft. Comps that don't bracket the size lean on larger GLA adjustments — review those adjustments.`,
        actions: ['acknowledge', 'dismiss', 'request_revision'] }));
    }
  }

  // 18. Comp distance — comps well beyond the subject's neighborhood weaken locality.
  const far = closed
    .map((c) => ({ c, mi: parseMiles(c.proximity) }))
    .filter((x) => x.mi != null && x.mi > o.compDistanceMaxMiles);
  if (far.length) {
    out.push(finding({ code: 'comp_distance', severity: 'warning', field: 'comps',
      appraisalValue: far.map((x) => `#${x.c.seq} (${x.mi} mi)`).join(', '),
      title: `${far.length} comp${far.length === 1 ? '' : 's'} more than ${o.compDistanceMaxMiles} miles from the subject`,
      howTo: 'Distant comps may be a different market. Confirm the appraiser justified crossing the neighborhood, or ask for closer sales.',
      actions: ['acknowledge', 'dismiss', 'request_revision'] }));
  }

  // 19. Appraiser geographic competency — licensed in the subject's state?
  if (A.appraiser && A.appraiser.licenseState && A.subject.state &&
      A.appraiser.licenseState.toUpperCase() !== A.subject.state.toUpperCase()) {
    out.push(finding({ code: 'appraiser_geo', severity: 'warning', field: 'appraiser',
      appraisalValue: A.appraiser.licenseState, fileValue: A.subject.state,
      title: `Appraiser is licensed in ${A.appraiser.licenseState}, subject is in ${A.subject.state}`,
      howTo: 'An appraiser should be licensed in the state where the property sits. Confirm licensure (or a valid reciprocal) before relying on the report.',
      actions: ['acknowledge', 'dismiss', 'request_revision'] }));
  }

  // 20. Flip / recent resale of the subject — a fresh prior sale before the appraisal is a
  //   seasoning / value-inflation signal. Advisory for a fix-and-flip lender (often expected),
  //   with the markup called out when both the prior price and current value are known.
  const ps = A.subject.priorSale || {};
  if (ps.priorDate && v.effectiveDate) {
    const mo = monthsBetween(ps.priorDate, v.effectiveDate);
    if (mo != null && mo >= 0 && mo <= o.flipSeasoningMonths) {
      const cur = subjVal != null ? subjVal : num(v.asIs);
      const prior = num(ps.priorAmount);
      // A nominal transfer ($1 quitclaim / intra-family) is NOT an arm's-length price — computing
      // a markup off it yields an absurd % (e.g. "+63,999,900%"). Only show a markup when the prior
      // price is a real sale (≥ $1,000); a nominal prior is flagged as a transfer without a %.
      const armsLength = prior != null && prior >= 1000;
      let markup = null;
      if (cur != null && armsLength) markup = Math.round(((cur - prior) / prior) * 100);
      out.push(finding({ code: 'subject_recent_resale', severity: 'warning', field: 'value',
        appraisalValue: [ps.priorAmount != null ? money(ps.priorAmount) : null, ps.priorDate].filter(Boolean).join(' on '),
        fileValue: cur != null ? money(cur) : null,
        title: `Subject was ${armsLength ? 'sold' : 'transferred'} within ${o.flipSeasoningMonths} months before the appraisal${markup != null ? ` (${markup >= 0 ? '+' : ''}${markup}% since)` : ''}`,
        howTo: `The subject last transferred ${ps.priorDate}${prior != null ? ` for ${money(prior)}` : ''}${!armsLength && prior != null ? ' — a nominal amount, likely a non-arm’s-length transfer; confirm the true prior price' : markup != null && markup >= o.flipMarkupPct ? ` — a ${markup}% jump warrants a close look at what supports the increase` : '. Confirm the prior sale and any value change is supported'}.`,
        actions: ['acknowledge', 'dismiss', 'request_revision'] }));
    }
  }

  // ---- 21. ARV defensibility — is the after-repair uplift backed by the rehab budget? ----
  // Only on a renovation/subject-to deal, and only when BOTH ARV and As-Is are known. Advisory:
  // flags a thin (uplift ≫ budget), no-uplift, or no-budget case. Never blocks CTC.
  const isReno = A.formType !== 'FNM1073' && (v.arv != null || /SubjectTo/i.test(String(v.conditionOfAppraisal || '')));
  if (isReno && v.arv != null && v.asIs != null) {
    const rehab = o.rehab != null ? o.rehab : (file && file.rehab_budget);
    const def = arvDefensibility({ arv: v.arv, asIs: v.asIs, rehab, isReno: true });
    if (def && (def.band === 'thin' || def.band === 'no_uplift' || def.band === 'no_budget')) {
      out.push(finding({ code: 'arv_defensibility', severity: 'warning', field: 'arv',
        appraisalValue: def.uplift != null ? `+${money(def.uplift)} uplift` : null,
        fileValue: def.rehab != null ? `${money(def.rehab)} rehab` : null,
        title: def.title, howTo: def.detail,
        actions: ['acknowledge', 'dismiss', 'request_revision'] }));
    }
  }

  return out;
}

// Whole-day difference between two 'YYYY-MM-DD' strings (no Date-of-now dependence).
function daysBetween(a, b) {
  const pa = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a), pb = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b);
  if (!pa || !pb) return null;
  const da = Date.UTC(+pa[1], +pa[2] - 1, +pa[3]), db = Date.UTC(+pb[1], +pb[2] - 1, +pb[3]);
  return Math.round((db - da) / 86400000);
}
// Whole-month difference between two 'YYYY-MM-DD' (or 'YYYY-MM-01') strings — b minus a.
// Positive = b is later. No new Date()/now dependence. Null if either isn't a calendar date.
function monthsBetween(a, b) {
  const pa = /^(\d{4})-(\d{2})/.exec(String(a || '')), pb = /^(\d{4})-(\d{2})/.exec(String(b || ''));
  if (!pa || !pb) return null;
  return (+pb[1] - +pa[1]) * 12 + (+pb[2] - +pa[2]);
}
// Miles from a MISMO proximity description ("0.35 miles", "1.2 mi", "0.08 miles SW").
// Only reads an explicit mile figure — a description in blocks/feet/none returns null (never
// guessed into miles). "adjacent" / "abuts" reads as 0.
function parseMiles(s) {
  const t = String(s || '').toLowerCase();
  if (!t) return null;
  if (/\b(adjacent|abuts|abutting)\b/.test(t)) return 0;
  const m = /(\d+(?:\.\d+)?)\s*(?:mi\b|mile)/.exec(t);
  if (m) { const n = Number(m[1]); return Number.isFinite(n) ? n : null; }
  return null;
}

// Severity roll-up for the badge + blocking condition.
function summarize(findings) {
  const open = findings.filter((f) => f.status === 'open');
  return {
    fatal: open.filter((f) => f.severity === 'fatal').length,
    warning: open.filter((f) => f.severity === 'warning').length,
    info: open.filter((f) => f.severity === 'info').length,
    blocksCtc: open.some((f) => f.severity === 'fatal' && f.blocksCtc),
  };
}

module.exports = { computeFindings, summarize, DEFAULTS, _internals: { daysBetween, monthsBetween, parseMiles, withinTol, normAddr } };
