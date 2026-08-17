'use strict';
/**
 * LT PPE — the CANONICAL ≥200-scenario battery for the Lender Price agreement gate (E3, owner HARD
 * RULE 2026-08-17). One definition of "the scenarios we agree with Lender Price on", so the live run
 * (scripts/test-lt-lp-agreement-run.js) and any offline replay price the SAME deals. Every scenario is
 * a plain LENDER PRICE scenario object (the shape client.price / search-model.validateScenario consume:
 * value/loan/fico/dscr/purpose/state/zip/countyFps/prepayTerm/propertyType/units), so it drives the LP
 * leg directly; the OUR leg derives its engine facts from the same object (lp-agreement-legs).
 *
 * The axes are chosen to EXERCISE EVERY LLPA TABLE ON THE DSCR SHEET, one axis at a time (the tables are
 * separable — FICO×CLTV is one table, the DSCR band another, state another — so a full cross is wasteful
 * and a per-axis sweep reveals each table cell for cell). Grouped by `_group` and labelled by `_label`.
 *
 * Deliberately data, not cleverness: known-good addresses so ZIP enrichment is never in the hot path,
 * and a small set of INELIGIBLE probes (fico/ltv/dscr/loan-size out of bounds) so the harness proves the
 * ineligibility side, not just the priced side. LT-only. No RTL imports, no network, no DB.
 */

// Known-good (state, zip, countyFps, county, city) tuples. NY is the core address; the others exist for
// the state-LLPA sweep (DC/MA/NJ/NY carry a state adder on the DSCR sheet; CA/FL/TX should not).
const ADDR = {
  NY: { state: 'NY', zip: '11211', countyFps: '36047', county: 'Kings', city: 'Brooklyn' },
  NJ: { state: 'NJ', zip: '07731', countyFps: '34025', county: 'Monmouth', city: 'Howell' },
  MA: { state: 'MA', zip: '02118', countyFps: '25025', county: 'Suffolk', city: 'Boston' },
  CA: { state: 'CA', zip: '90001', countyFps: '06037', county: 'Los Angeles', city: 'Los Angeles' },
  FL: { state: 'FL', zip: '33101', countyFps: '12086', county: 'Miami-Dade', city: 'Miami' },
  TX: { state: 'TX', zip: '75201', countyFps: '48113', county: 'Dallas', city: 'Dallas' },
};

const FICOS = [800, 780, 760, 740, 720, 700, 680, 660, 640];
// loan on a $500k value → CLTV 50/55/60/65/70/75/80
const CLTV_LOANS = { 50: 250000, 55: 275000, 60: 300000, 65: 325000, 70: 350000, 75: 375000, 80: 400000 };
const DSCRS = [1.5, 1.25, 1.2, 1.15, 1.1, 1.05, 1.0, 0.95, 0.85];

// Field names are the Lender Price scenario contract's (search-model validateScenario): prepayMonths
// (number; omitted/60 → the 5-yr DSCR default), io, escrowWaive. Using prepayTerm/interestOnly/
// escrowWaiver instead is silently IGNORED by the builder (it priced a 5-yr prepay + no flag every time).
function core(extra) { return { purpose: 'Purchase', value: 500000, prepayMonths: 60, ...ADDR.NY, ...extra }; }

/**
 * Build the canonical scenario battery.
 *   opts.include — optional array of group keys to keep (default all):
 *     ['ficoxcltv','dscrxcltv','purpose','loansize','property','prepay','flags','state','ineligible']
 * Returns { scenarios:[{ ...lpScenario, _label, _group, _ineligible? }], count, byGroup }.
 */
function buildAgreementScenarios(opts = {}) {
  const groups = {
    ficoxcltv: [],
    dscrxcltv: [],
    purpose: [],
    loansize: [],
    property: [],
    prepay: [],
    flags: [],
    state: [],
    advanced: [],
    borrower: [],
    pppstruct: [],
    eliggrid: [],
    ineligible: [],
  };
  const push = (g, label, s, extra) => groups[g].push({ ...s, _label: label, _group: g, ...(extra || {}) });

  // A) FICO × CLTV at TWO DSCR bands (1.25 in the ≥1.25 band, 1.00 in the 1.00–1.14 band) — the
  // "DSCR (All)" FICO×CLTV cell table, swept at two bands to prove the cell is DSCR-INDEPENDENT (LP
  // labels it "DSCR (All)"; the band penalty is a separate additive LLPA, so the same cell must appear
  // under both — a disagreement here means our grid folded DSCR into the cell when LP does not).
  for (const dscr of [1.25, 1.0]) for (const fico of FICOS) for (const [ltv, loan] of Object.entries(CLTV_LOANS)) {
    push('ficoxcltv', `fico=${fico} cltv=${ltv} dscr=${dscr}`, core({ fico, loan, dscr }));
  }
  // B) DSCR × CLTV at FICO 760 — the DSCR-band adjustment (CLTV-segmented on the live sheet).
  for (const dscr of DSCRS) for (const [ltv, loan] of Object.entries(CLTV_LOANS)) {
    push('dscrxcltv', `fico=760 cltv=${ltv} dscr=${dscr}`, core({ fico: 760, loan, dscr }));
  }
  // C) purpose (Purchase / Refinance / Cash out) at a few anchors.
  for (const fico of [760, 700]) for (const [ltv, loan] of [[70, 350000], [80, 400000]]) {
    push('purpose', `refi fico=${fico} cltv=${ltv}`, core({ fico, loan, dscr: 1.25, purpose: 'Refinance' }));
    push('purpose', `cashout fico=${fico} cltv=${ltv}`, core({ fico, loan, dscr: 1.25, purpose: 'Cash out', cashoutAmount: 50000 }));
  }
  // D) loan-size / max-price tiers at FICO 760 DSCR 1.25 (70% CLTV).
  for (const [v, l, tag] of [[150000, 105000, '150k'], [200000, 140000, '200k'], [800000, 560000, '800k'], [1200000, 840000, '1.2M'], [1600000, 1120000, '1.6M'], [2000000, 1400000, '2.0M'], [2400000, 1680000, '2.4M']]) {
    push('loansize', `loansize ${tag}`, core({ fico: 760, value: v, loan: l, dscr: 1.25 }));
  }
  // E) property type / units / condo at an anchor.
  push('property', 'condo', core({ fico: 760, loan: 350000, dscr: 1.25, propertyType: 'Condo' }));
  push('property', '2-4 units', core({ fico: 760, loan: 350000, dscr: 1.25, propertyType: 'Unit2_4', units: 2 }));
  push('property', '3 units', core({ fico: 760, loan: 350000, dscr: 1.25, propertyType: 'Unit2_4', units: 3 }));
  // F) prepay term at an anchor (prepayMonths: 0 = No PPP).
  for (const pm of [36, 24, 12, 0]) push('prepay', `prepay ${pm}mo`, core({ fico: 760, loan: 350000, dscr: 1.25, prepayMonths: pm }));
  // G) interest-only / escrow waiver at an anchor.
  push('flags', 'interest-only', core({ fico: 760, loan: 350000, dscr: 1.25, io: true }));
  push('flags', 'escrow-waiver', core({ fico: 760, loan: 350000, dscr: 1.25, escrowWaive: true }));
  // H) state sweep at an anchor.
  for (const k of Object.keys(ADDR)) push('state', `state ${k}`, { purpose: 'Purchase', value: 500000, loan: 350000, fico: 760, dscr: 1.25, prepayMonths: 60, ...ADDR[k] });
  // J) ADVANCED overlay facts (D27–D29) — each toggled at an eligible anchor, so the battery covers the
  // advanced section. LP does not see these; our overlay is what reads them (enforcement gated on D36).
  {
    const A = { fico: 760, loan: 350000, dscr: 1.25 };
    push('advanced', 'occupancy vacant', core({ ...A, occupancy: 'vacant' }));
    push('advanced', 'rural property', core({ ...A, rural_property: true }));
    push('advanced', 'short-term rental', core({ ...A, short_term_rental: true }));
    push('advanced', 'first-time investor', core({ ...A, first_time_investor: true }));
    push('advanced', 'first-time homebuyer', core({ ...A, first_time_homebuyer: true }));
    push('advanced', 'foreign national', core({ ...A, foreign_national: true }));
    push('advanced', 'declining market', core({ ...A, declining_market: true }));
    push('advanced', 'renovation cash-out', core({ ...A, purpose: 'Cash out', cashoutAmount: 50000, renovation: true }));
  }
  // K) BORROWER TYPE × PPP (Layer 3) — LLC (default, allowed) vs Individual (natural person) in the
  // restriction states, with a No-PPP control (never disqualified). Proves the PPP layer end to end.
  {
    const B = { purpose: 'Purchase', value: 500000, loan: 350000, fico: 760, dscr: 1.25 };
    for (const st of ['NJ', 'MA', 'NY']) {
      push('borrower', `${st} LLC 5yr PPP`, { ...B, prepayMonths: 60, borrowerType: 'LLC', ...ADDR[st] });
      push('borrower', `${st} Individual 5yr PPP`, { ...B, prepayMonths: 60, borrowerType: 'Individual', ...ADDR[st] });
      push('borrower', `${st} Individual No-PPP`, { ...B, prepayMonths: 0, borrowerType: 'Individual', ...ADDR[st] });
    }
  }
  // L) PPP STRUCTURE library (D30–D33) — each distinct prepay TERM at an anchor (the structure library's
  // LP mapping resolves the term); plus the two custom softer overlays (carry ppp_structure_key so the
  // margin-holdback overlay can add its +0.375). Exercises the prepay dimension across terms.
  {
    const P = { purpose: 'Purchase', value: 500000, loan: 350000, fico: 760, dscr: 1.25, ...ADDR.CA };
    for (const [m, tag] of [[60, '5yr'], [48, '4yr'], [36, '3yr'], [24, '2yr'], [12, '1yr'], [0, 'none']]) {
      push('pppstruct', `ppp ${tag}`, { ...P, prepayMonths: m });
    }
    push('pppstruct', 'custom 3/3/3/2/1 (5yr)', { ...P, prepayMonths: 60, ppp_structure_key: '33321' });
    push('pppstruct', 'custom 3/3/2/1 (4yr)', { ...P, prepayMonths: 48, ppp_structure_key: '3321' });
  }
  // M) ELIGIBILITY GRID tiers (T2/T3) — the per-tier FICO floors + tier-aware caps, at each tier's floor
  // rows × purpose × DSCR band. Covers the grid cells the flat envelope used to miss (R10 divergence B).
  {
    for (const [v, l, tier] of [[2600000, 1750000, 'T2'], [3300000, 2250000, 'T3']]) {
      for (const fico of [700, 680, 660]) for (const purpose of ['Purchase', 'Cash out']) for (const dscr of [1.25, 0.95]) {
        const extra = purpose === 'Cash out' ? { cashoutAmount: 50000 } : {};
        push('eliggrid', `${tier} fico=${fico} ${purpose} dscr=${dscr}`, core({ fico, value: v, loan: l, dscr, purpose, ...extra }));
      }
    }
    // T1 (loan <= $1.5M) — the tier the flat caps already agree on; a full floor × purpose × band sweep.
    for (const fico of [720, 700, 680, 640]) for (const purpose of ['Purchase', 'Cash out']) for (const dscr of [1.25, 0.95]) {
      const extra = purpose === 'Cash out' ? { cashoutAmount: 50000 } : {};
      push('eliggrid', `T1 fico=${fico} ${purpose} dscr=${dscr}`, core({ fico, value: 500000, loan: 350000, dscr, purpose, ...extra }));
    }
  }
  // M2) more property / flag coverage to round out the angles.
  push('property', 'non-warrantable condo', core({ fico: 760, loan: 400000, dscr: 1.25, propertyType: 'Condo', nonWarrantable: true }));
  push('property', 'condo 80% cltv', core({ fico: 760, loan: 400000, dscr: 1.25, propertyType: 'Condo' }));
  push('property', '4 units 80% cltv', core({ fico: 760, loan: 400000, dscr: 1.25, propertyType: 'Unit2_4', units: 4 }));
  push('flags', 'io + escrow waiver', core({ fico: 760, loan: 350000, dscr: 1.25, io: true, escrowWaive: true }));
  push('flags', 'io at dscr 1.0', core({ fico: 760, loan: 350000, dscr: 1.0, io: true }));
  // N) INELIGIBLE probes — the harness must prove the disqualifier matches, not only the price.
  const dq = (label, s) => push('ineligible', label, core(s), { _ineligible: true });
  dq('fico 600', { fico: 600, loan: 350000, dscr: 1.25 });
  dq('ltv 85', { fico: 760, loan: 425000, dscr: 1.25 });
  dq('dscr 0.6', { fico: 760, loan: 350000, dscr: 0.6 });
  dq('tiny loan 60k', { fico: 760, value: 100000, loan: 60000, dscr: 1.25 });
  dq('huge loan 3.5M', { fico: 760, value: 5000000, loan: 3500000, dscr: 1.25 });
  dq('fico 640 ltv 80 dscr 0.9', { fico: 640, loan: 400000, dscr: 0.9 });
  // min-loan DSCR-gated (the R10 fix): $150k @ DSCR 0.90 must decline on the $200k floor.
  dq('min-loan 150k dscr 0.9', { fico: 760, value: 250000, loan: 150000, dscr: 0.9 });
  // grid tier FICO floors: 640 in T2/T3 (below the 660 floor) must decline.
  dq('T2 fico 640', { fico: 640, value: 2600000, loan: 1750000, dscr: 1.25 });
  dq('T3 fico 640', { fico: 640, value: 3300000, loan: 2250000, dscr: 1.25 });
  // NJ natural person with a PPP requested → PPP prohibited (Layer 3).
  push('ineligible', 'NJ Individual PPP prohibited', { purpose: 'Purchase', value: 500000, loan: 350000, fico: 760, dscr: 1.25, prepayMonths: 60, borrowerType: 'Individual', ...ADDR.NJ }, { _ineligible: true });

  const keep = Array.isArray(opts.include) && opts.include.length ? new Set(opts.include) : null;
  const scenarios = [];
  const byGroup = {};
  for (const [g, list] of Object.entries(groups)) {
    if (keep && !keep.has(g)) continue;
    byGroup[g] = list.length;
    scenarios.push(...list);
  }
  return { scenarios, count: scenarios.length, byGroup };
}

module.exports = { buildAgreementScenarios, _internals: { ADDR, FICOS, CLTV_LOANS, DSCRS } };
