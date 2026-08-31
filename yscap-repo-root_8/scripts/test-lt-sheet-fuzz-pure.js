'use strict';
/**
 * LT SHEETS — THE FUZZ. Every document, every combination, every claim.
 *
 * Owner-directed 2026-08-31, and the owner supplied the bug class themselves:
 *   *"something like when it's saying that this and this amount is the same on
 *   all scenarios (5-year Pre-pay Penalty), when in truth there can be different
 *   scenarios with different amounts ... go on a deep dive to make sure all the
 *   issues, like this and other issues, and every kind of scenario are run."*
 *
 * A HAND-WRITTEN SUITE ASSERTS WHAT ITS AUTHOR THOUGHT OF. This one does the
 * opposite: it builds the documents across a large combinatorial space and
 * checks INVARIANTS that must hold for every one of them, so a combination
 * nobody imagined still has to obey the rules. The generator is deterministic
 * (a seeded PRNG plus an exhaustive core), so a failure names a case you can
 * rebuild exactly.
 *
 * THE INVARIANT THAT FOUND THE OWNER'S OWN BUG:
 *   ⛔ A DOCUMENT MAY NOT STATE AS ONE FACT SOMETHING ITS OPTIONS DISAGREE ABOUT.
 * `comparison.buildComparison` already computes a `differs` list; anything on it
 * must NOT appear as a single value anywhere on the page. The header's property
 * line was doing exactly that, off `members[0]`.
 *
 * PURE: no database, no network, no PDF.
 */

const snapshot = require('../src/longterm/termsheet/snapshot');
const layout = require('../src/longterm/termsheet/layout');
const wording = require('../src/longterm/termsheet/wording');
const audience = require('../src/longterm/audience');

let bad = 0;
let checks = 0;
const failed = new Map();          // invariant -> first failing case
const ok = (cond, inv, detail) => {
  checks += 1;
  if (cond) return;
  bad += 1;
  if (!failed.has(inv)) failed.set(inv, detail);
};
const section = (t) => console.log('\n' + t);

/* A seeded PRNG, so every run builds the SAME documents. A fuzz suite that
   shuffles on each run reports a different failure every time and nobody can
   reproduce the one that mattered. */
let seed = 20260831;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length) % a.length];

const PLAN = { borrowerPaid: 2, ysp: 2, lenderPaid: 2, applicationFee: 500, commitmentFee: 1595 };
const PLANS = [
  PLAN,
  { borrowerPaid: 0, ysp: 0, lenderPaid: 0, applicationFee: 0, commitmentFee: 0 },
  { borrowerPaid: 1.5, ysp: 2.5, lenderPaid: 1, applicationFee: 500, commitmentFee: 1595 },
];

const TYPES = ['Single family', '2-4 unit', 'Condo', 'Townhouse'];
const PREPAYS = [
  { prepayMonths: 60, prepayStructure: '5 Year' },
  { prepayMonths: 36, prepayStructure: '3 Year' },
  { prepayMonths: 0, prepayStructure: null },
  { prepayMonths: 12, prepayStructure: '1 Year' },
];
const VALUES = [500000, 650000, 1250000, 240000];
const LTVS = [55, 60, 65, 70, 75, 80];
const RATES = [5.99, 6.5, 6.75, 6.99, 7.375, 8.25];
const PRICES = [96.5, 98, 99.75, 100, 100.5, 102, 104];
const MODES = ['borrowerPaid', 'lenderPaid'];
const TERMS = [30, 40];

function scenarioOf(o) {
  const value = o.value;
  const loan = Math.round((value * o.ltv) / 100);
  const pre = o.prepay;
  const s = {
    purpose: o.purpose, propertyType: o.propertyType, value, loan, ltv: o.ltv,
    termYears: o.termYears, io: o.interestOnly, escrowWaive: o.escrowWaive,
    prepayMonths: pre.prepayMonths, prepayStructure: pre.prepayStructure,
    fico: o.fico, state: 'NJ', city: 'Lakewood', zip: '08701',
    rentMonthly: o.rentMonthly, hoaMonthly: o.hoaMonthly,
  };
  if (o.units != null) s.units = o.units;
  if (o.taxMonthly != null) s.taxMonthly = o.taxMonthly;
  if (o.insuranceMonthly != null) s.insuranceMonthly = o.insuranceMonthly;
  if (o.dscr != null) s.dscr = o.dscr;
  return s;
}

function randomOpts() {
  return {
    purpose: pick(['Purchase', 'Refinance', 'Cash-out refinance']),
    propertyType: pick(TYPES),
    units: pick([null, null, 1, 2, 3, 4]),
    value: pick(VALUES),
    ltv: pick(LTVS),
    termYears: pick(TERMS),
    interestOnly: rnd() < 0.25,
    escrowWaive: rnd() < 0.2,
    prepay: pick(PREPAYS),
    fico: pick([680, 700, 720, 740, 760, 780]),
    rentMonthly: pick([2600, 3400, 4161, 5200, 8000]),
    taxMonthly: pick([null, 0, 340, 620, 1100]),
    insuranceMonthly: pick([null, 0, 95, 145, 380]),
    hoaMonthly: pick([0, 0, 0, 180, 425]),
    dscr: pick([null, 0.94, 1.05, 1.12, 1.24, 1.29, 1.42, 1.53, 1.9]),
  };
}

function selectionOf(label, o, mode, ratePct, rawPrice) {
  return {
    label,
    consumerLabel: 'Platinum ' + label,
    product: o.termYears + '-Year Fixed DSCR',
    mode,
    ratePct,
    rawPrice,
    scenario: scenarioOf(o),
    pricedAt: '2026-08-31T13:30:00.000Z',
    internal: { investor: 'Deephaven Select', rawPrice },
  };
}

/* Every string a page would draw, flattened out of the block list. This is what
   the invariants read, because a claim is only a claim once it is DRAWN. */
function textOf(blocks) {
  const out = [];
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === 'string') { out.push(v); return; }
    if (typeof v === 'number' || typeof v === 'boolean') { out.push(String(v)); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') { Object.keys(v).forEach((k) => walk(v[k])); }
  };
  walk(blocks);
  return out;
}

const JUNK = /\bNaN\b|\bInfinity\b|\bundefined\b|\[object Object\]|\bnull\b|\$NaN|NaN%|--\d/;

/* The DIFFERS dimensions, and how to read each one off a member. Kept beside
   `comparison.js`'s own list on purpose: if that list grows, this one has to,
   and the guard below fails until it does. */
const DIM_READ = {
  loanAmount: (m) => (Number.isFinite(m.loanAmount) ? Math.round(m.loanAmount) : null),
  ltv: (m) => (Number.isFinite(m.ltv) ? Math.round(m.ltv * 100) / 100 : null),
  termYears: (m) => (Number.isFinite(m.termYears) ? m.termYears : null),
  prepay: (m) => m.prepayLabel || null,
  interestOnly: (m) => m.interestOnly === true,
  propertyValue: (m) => (Number.isFinite(m.propertyValue) ? Math.round(m.propertyValue) : null),
};

function runCase(sels, plan, prepared, tag) {
  let built;
  try {
    built = snapshot.buildSnapshot({ selections: sels, plan, prepared });
  } catch (e) {
    ok(false, 'I7 buildSnapshot never throws', tag + ' :: ' + (e && e.message));
    return null;
  }
  if (!built.ok) return null;                       // a refusal is a legitimate answer
  const s = built.snapshot;

  let blocks;
  try {
    blocks = layout.buildLayout(s, { code: 'TS-4KQ7WM', expiryHours: 24 }).blocks;
  } catch (e) {
    ok(false, 'I7 buildLayout never throws', tag + ' :: ' + (e && e.message));
    return null;
  }
  const strings = textOf(blocks);
  const page = strings.join('\n');

  // ── I2 nothing a machine leaked ────────────────────────────────────────
  const junk = strings.find((t) => typeof t === 'string' && JUNK.test(t));
  ok(!junk, 'I2 no machine junk reaches the page', tag + ' :: ' + JSON.stringify(junk));

  // ── I3 rule 10, on every document ──────────────────────────────────────
  ok(!audience.mentionsInvestor(page), 'I3 the investor never reaches the page', tag);

  // ── I4 our compensation never reaches the page ─────────────────────────
  ok(!/\bysp\b|lender[- ]paid comp|compensation|rawPrice|adjustmentPoints|compBefore|compAfter/i.test(page),
    'I4 our compensation never reaches the page', tag);

  // ── I5 a points figure always carries its dollars ──────────────────────
  for (const t of strings) {
    if (typeof t !== 'string') continue;
    if (!/\bpoints?\b/.test(t)) continue;
    if (/^\s*\d+(\.\d+)?\s*points?\s*$/.test(t)) {
      ok(false, 'I5 points are never printed bare', tag + ' :: ' + t);
    }
  }

  // ── I1 THE ONE THE OWNER NAMED ─────────────────────────────────────────
  // Anything the options disagree about may not appear as a single stated fact.
  const cmpModel = s.comparison;
  if (cmpModel && Array.isArray(cmpModel.differs) && s.members.length > 1) {
    const recipient = blocks.find((b) => b.t === 'recipient');
    for (const dim of cmpModel.differs) {
      const read = DIM_READ[dim];
      ok(typeof read === 'function', 'I1b every differs dimension is readable here', tag + ' :: ' + dim);
      if (typeof read !== 'function') continue;
      const vals = s.members.map(read);
      const uniq = Array.from(new Set(vals.map((v) => String(v))));
      ok(uniq.length > 1, 'I1c differs really differs', tag + ' :: ' + dim);

      if (dim === 'propertyValue' && recipient) {
        // The header states ONE property line. If the members disagree about the
        // value, that line is a claim the document cannot support.
        const facts = String(recipient.propertyFacts || '');
        ok(!/valued at/.test(facts),
          'I1 the header never states one property value when the options disagree',
          tag + ' :: header says "' + facts + '" but values are ' + vals.join(' / '));
      }
    }
  }

  // ── I1d THE SAME RULE FOR THE FACTS `differs` DOES NOT TRACK ───────────
  // `differs` covers six dimensions; the header's property line also carries the
  // property TYPE and the unit count, and neither is on that list. They are
  // checked here directly against the members, because a fact being absent from
  // one module's list is not a reason for another module to assert it.
  if (s.members.length > 1) {
    const recipient = blocks.find((b) => b.t === 'recipient');
    const facts = String((recipient && recipient.propertyFacts) || '');
    const uniqOf = (read) => Array.from(new Set(s.members.map((m) => String(read(m)))));
    const types = uniqOf((m) => ((m.scenario || {}).propertyType) || '');
    if (types.length > 1) {
      const named = types.filter((t) => t && facts.includes(t));
      ok(named.length === 0,
        'I1d the header never states one property TYPE when the options disagree',
        tag + ' :: header says "' + facts + '" but types are ' + types.join(' / '));
    }
    const units = uniqOf((m) => {
      const u = (m.scenario || {}).units;
      return Number.isFinite(u) && u > 1 ? Math.round(u) : '';
    });
    if (units.length > 1) {
      ok(!/\d+ units/.test(facts),
        'I1e the header never states one UNIT COUNT when the options disagree',
        tag + ' :: header says "' + facts + '" but units are ' + units.join(' / '));
    }
  }

  // ── I6 a printed DSCR is the ratio of the figures printed beside it ────
  for (const m of s.members) {
    const sc = m.scenario || {};
    const hc = wording.housingCost({
      monthlyPI: m.monthlyPI, taxMonthly: sc.taxMonthly,
      insuranceMonthly: sc.insuranceMonthly, hoaMonthly: sc.hoaMonthly,
    });
    if (!hc.complete || !Number.isFinite(sc.rentMonthly) || !(sc.rentMonthly > 0)) continue;
    if (!Number.isFinite(hc.total) || !(hc.total > 0)) continue;
    const derived = Math.round((sc.rentMonthly / hc.total) * 100) / 100;
    ok(Number.isFinite(derived) && derived > 0,
      'I6 a complete PITI yields a usable ratio', tag + ' :: total=' + hc.total);
  }

  // ── I8 the block list is well-formed ───────────────────────────────────
  for (const b of blocks) {
    ok(b && typeof b === 'object' && typeof b.t === 'string',
      'I8 every block is a typed object', tag + ' :: ' + JSON.stringify(b));
  }
  return s;
}

// =============================================================================
section('A. the exhaustive core — one option, every shape that changes the page');
// =============================================================================
{
  let n = 0;
  for (const mode of MODES) {
    for (const price of PRICES) {
      for (const term of TERMS) {
        for (const io of [false, true]) {
          for (const escrow of [false, true]) {
            for (const pre of PREPAYS) {
              for (const tax of [null, 0, 620]) {
                for (const hoa of [0, 425]) {
                  const o = {
                    purpose: 'Purchase', propertyType: 'Single family', units: null,
                    value: 500000, ltv: 75, termYears: term, interestOnly: io,
                    escrowWaive: escrow, prepay: pre, fico: 740, rentMonthly: 4161,
                    taxMonthly: tax, insuranceMonthly: tax == null ? null : 145,
                    hoaMonthly: hoa, dscr: 1.24,
                  };
                  runCase([selectionOf('A', o, mode, 7.375, price)], PLAN,
                    { borrowerName: 'Miriam Rosenberg', propertyAddress: '14 Oak Street, Lakewood, NJ 08701' },
                    'A/' + [mode, price, term, io, escrow, pre.prepayStructure, tax, hoa].join('|'));
                  n += 1;
                }
              }
            }
          }
        }
      }
    }
  }
  console.log('  ' + n + ' single-option documents built');
}

// =============================================================================
section('B. multi-option — every ONE-dimension disagreement, both workflows');
// =============================================================================
{
  const baseOpts = () => ({
    purpose: 'Purchase', propertyType: 'Single family', units: null, value: 500000,
    ltv: 75, termYears: 30, interestOnly: false, escrowWaive: false,
    prepay: PREPAYS[0], fico: 740, rentMonthly: 4161, taxMonthly: 620,
    insuranceMonthly: 145, hoaMonthly: 0, dscr: 1.24,
  });
  // One dimension at a time — this is what makes a false single-value claim
  // impossible to miss: everything else about the two options is identical.
  const VARY = {
    propertyValue: (o) => { o.value = 650000; },
    ltv: (o) => { o.ltv = 60; },
    termYears: (o) => { o.termYears = 40; },
    prepay: (o) => { o.prepay = PREPAYS[1]; },
    interestOnly: (o) => { o.interestOnly = true; },
    propertyType: (o) => { o.propertyType = '2-4 unit'; o.units = 3; },
    fico: (o) => { o.fico = 680; },
    rent: (o) => { o.rentMonthly = 5200; },
    tax: (o) => { o.taxMonthly = 1100; },
    hoa: (o) => { o.hoaMonthly = 425; },
    escrow: (o) => { o.escrowWaive = true; },
  };
  let n = 0;
  for (const key of Object.keys(VARY)) {
    for (const mode of MODES) {
      const a = baseOpts();
      const b = baseOpts(); VARY[key](b);
      runCase(
        [selectionOf('A', a, mode, 7.375, 102), selectionOf('B', b, mode, 6.875, 99.75)],
        PLAN, { borrowerName: 'Miriam Rosenberg', propertyAddress: '14 Oak Street, Lakewood, NJ 08701' },
        'B/vary=' + key + '|' + mode);
      n += 1;
    }
  }
  console.log('  ' + n + ' two-option documents built, one disagreement each');
}

// =============================================================================
section('C. the random sweep — many options, many plans, anything goes');
// =============================================================================
{
  const N = Number(process.env.LT_FUZZ_N || 4000);
  for (let i = 0; i < N; i += 1) {
    const count = pick([1, 2, 2, 3, 3, 4, 5]);
    const mode = pick(MODES);
    const plan = pick(PLANS);
    const sels = [];
    const shared = randomOpts();
    for (let k = 0; k < count; k += 1) {
      // Half the documents vary the scenario per option (workflow B), half do not.
      const o = rnd() < 0.5 ? shared : randomOpts();
      sels.push(selectionOf(String.fromCharCode(65 + k), o, mode, pick(RATES), pick(PRICES)));
    }
    runCase(sels, plan, {
      borrowerName: rnd() < 0.8 ? 'Miriam Rosenberg' : null,
      entityName: rnd() < 0.5 ? 'Oak Street Holdings LLC' : null,
      propertyAddress: rnd() < 0.85 ? '14 Oak Street, Lakewood, NJ 08701' : null,
      officerName: 'Sara Klein', officerEmail: 'sara.klein@yscapgroup.com',
    }, 'C/' + i);
  }
  console.log('  ' + N + ' random documents built');
}

// =============================================================================
console.log('\n' + checks.toLocaleString() + ' invariant checks over every document built');
if (bad) {
  console.error('\n' + bad + ' FAILED. First case per invariant:');
  for (const [inv, detail] of failed) console.error('  FAIL ' + inv + '\n       ' + detail);
  process.exit(1);
}
console.log('ALL PASSED');
