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

const DEFAULTS = {
  valueTolerancePct: 2,        // ARV/As-Is: treat within this % (and $) as a match
  valueToleranceAbs: 5000,
  priceTolerancePct: 1,
  priceToleranceAbs: 2500,
  maxNetAdjPct: 15,            // comp net adjustment guideline
  maxGrossAdjPct: 25,          // comp gross adjustment guideline
  effectiveDateMaxDays: 120,   // appraisal staleness at note
  flipMarkupPct: 20,           // prior-sale markup that flags a flip
  today: null,                 // 'YYYY-MM-DD' — injected (no new Date() in date paths)
};

const money = (n) => (n == null ? null : `$${Number(n).toLocaleString('en-US')}`);
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function withinTol(a, b, pct, abs) {
  if (a == null || b == null) return null;                 // can't compare
  const d = Math.abs(a - b);
  return d <= abs || d <= (Math.abs(b) * pct) / 100;
}
// normalize an address string for comparison (drop punctuation/case/whitespace, expand nothing fancy)
function normAddr(s) { return String(s || '').toLowerCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim(); }
function fileAddress(file) {
  const pa = file && file.property_address;
  if (!pa) return null;
  if (typeof pa === 'string') { try { return JSON.parse(pa); } catch { return { line: pa }; } }
  return pa;
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
  const fa = fileAddress(file);
  const faLine = fa && (fa.line || fa.street || [fa.address, fa.city, fa.state].filter(Boolean).join(', '));
  if (A.subject.address && faLine && normAddr(A.subject.address).split(' ')[0] &&
      !normAddr(faLine).includes(normAddr(A.subject.address).split(' ').slice(0, 2).join(' '))) {
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

  // ---- 3. Property type (soft — text) ----
  // (left as a warning: vendor free-text vs our enum; only flag when clearly different)

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

  return out;
}

// Whole-day difference between two 'YYYY-MM-DD' strings (no Date-of-now dependence).
function daysBetween(a, b) {
  const pa = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a), pb = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b);
  if (!pa || !pb) return null;
  const da = Date.UTC(+pa[1], +pa[2] - 1, +pa[3]), db = Date.UTC(+pb[1], +pb[2] - 1, +pb[3]);
  return Math.round((db - da) / 86400000);
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

module.exports = { computeFindings, summarize, DEFAULTS, _internals: { daysBetween, withinTol, normAddr } };
