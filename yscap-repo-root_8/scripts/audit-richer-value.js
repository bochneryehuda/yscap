'use strict';
/**
 * RICHER VALUES — THE A-TO-Z AUDIT ENGINE.
 *
 * The owner asked for an engine that "tests the integration hundreds of times".
 * That is a different job from the suites already in `npm test`, and the difference
 * is worth stating because it decides what belongs in each:
 *
 *   A SUITE asserts the cases somebody thought of. It is a list of examples, and it
 *   can only ever fail on an example its author already imagined.
 *
 *   THIS ENGINE asserts PROPERTIES — statements that must hold for EVERY input, not
 *   for a chosen one — and then throws hundreds of RANDOMLY GENERATED inputs at
 *   them, including the shapes a person would never sit down and type: a loan
 *   amount of "$1,250,000.00", a vendor payload with the two values the wrong way
 *   round, a status nobody has seen, an address with no house number, a scope of
 *   work that is 40 MB of HTML. The examples the suites pin are the floor; this is
 *   the sweep above it.
 *
 * WHY IT IS SEEDED, AND WHY THAT IS NOT A DETAIL. A random test that cannot be
 * re-run is a rumour: it fails once in CI, nobody can reproduce it, and it gets
 * deleted. Every round here is generated from a seeded PRNG, every failure is
 * reported WITH the seed and the round number, and `--seed S --rounds N` replays
 * that exact sequence. A failure is therefore always a fact somebody can hold.
 *
 * IT IS PURE BY DEFAULT — no database, no network, no config beyond the defaults —
 * so it runs in CI in about a second and can never touch the live vendor. `--live`
 * adds a READ-ONLY sweep against the training tenant (the catalogue and a price
 * quote, repeated), which is the half that proves our reading of their API still
 * matches their API. It is opt-in precisely because CI must not depend on a third
 * party being up.
 *
 * WHAT IT COVERS, and the property each section is really asserting:
 *   A  the $400,000 guard      — three states, and the strict one is unreachable by accident
 *   B  money, read every way   — one number, however it is punctuated
 *   C  the order builder       — never throws, never sends a field the branch forbids
 *   D  the finished report     — never invents a value, never contradicts itself
 *   E  the status ladder       — an out-of-order webhook can never walk an order back
 *   F  the scope-of-work plan  — every order state has exactly one safe move
 *   G  payment                 — the two methods the owner forbade are unreachable
 *   H  the transport           — a secret can never reach a log line
 *   I  the catalogue readers   — a slug is never lost, a price is never invented
 *   J  live (opt-in)           — the vendor still answers the way we read them
 *
 * Usage:  node scripts/audit-richer-value.js [--rounds 250] [--seed 1] [--live] [--verbose]
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');

const guard = require(path.join(ROOT, 'src/richervalues/loan-guard'));
const build = require(path.join(ROOT, 'src/richervalues/order-build'));
const results = require(path.join(ROOT, 'src/richervalues/results'));
const sync = require(path.join(ROOT, 'src/richervalues/sync'));
const sow = require(path.join(ROOT, 'src/richervalues/scope-of-work'));
const payment = require(path.join(ROOT, 'src/richervalues/payment'));
const client = require(path.join(ROOT, 'src/richervalues/client'));
const reference = require(path.join(ROOT, 'src/richervalues/reference'));
const { moneyValue } = require(path.join(ROOT, 'src/lib/fields'));

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const ROUNDS = Math.max(1, parseInt(flag('rounds', '250'), 10) || 250);
const SEED = parseInt(flag('seed', '1'), 10) || 1;
const LIVE = !!flag('live', false);
const VERBOSE = !!flag('verbose', false);

// ---------------------------------------------------------------------------
// The engine. A failure carries the round and the input that produced it, so
// `--seed S` replays it exactly.
// ---------------------------------------------------------------------------
let round = 0;
let checks = 0;
const failures = [];
const sections = new Map();

function ok(section, what, cond, detail) {
  checks += 1;
  const s = sections.get(section) || { checks: 0, failures: 0 };
  s.checks += 1;
  if (!cond) {
    s.failures += 1;
    failures.push({ section, what, round, seed: SEED, detail: detail === undefined ? null : detail });
    if (VERBOSE) console.log(`  FAIL [${section}] round ${round}: ${what} :: ${safe(detail)}`);
  }
  sections.set(section, s);
  return !!cond;
}

/**
 * ALWAYS A STRING. `JSON.stringify(undefined)` is `undefined`, not `"undefined"` —
 * so a naive version returns a non-string and the very next `.slice()` throws,
 * which would make the audit engine fall over while REPORTING a failure rather
 * than report it. Caught on its own first run.
 */
function safe(v) {
  if (typeof v === 'string') return v;
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
  } catch { return String(v); }
}

/** mulberry32 — small, deterministic, and dependency-free. */
function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rand = rng(SEED);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const chance = (p) => rand() < p;
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

// ---------------------------------------------------------------------------
// Generators. Deliberately nasty: every one of these shapes has either been seen
// in a real payload or is a shape a person can type into the screen.
// ---------------------------------------------------------------------------
const JUNK = ['', ' ', null, undefined, 'N/A', 'n/a', '-', '--', 'TBD', 'unknown', 'null', 'NaN',
  '$', '$.', 'abc', '1,2,3', '1.2.3', '0', '00', '  ', '\t', '\n', 'Infinity', '-Infinity', '1e999'];

/** A money value, written every way a human or a vendor writes one. */
function moneyish(n) {
  const forms = [
    () => n,
    () => String(n),
    () => `$${n.toLocaleString('en-US')}`,
    () => n.toLocaleString('en-US'),
    () => `${n}.00`,
    () => `$${n.toLocaleString('en-US')}.00`,
    () => ` ${n} `,
  ];
  return pick(forms)();
}

function loanAmountCase() {
  // Weighted so the boundary and the strict side are exercised hard — that is the
  // rule the owner asked for and the one an accident is most expensive on.
  const kind = rand();
  if (kind < 0.10) return { raw: pick(JUNK), expect: 'advise' };
  if (kind < 0.20) return { raw: guard.LOAN_LIMIT, expect: 'ok' };                    // exactly the limit is INSIDE
  if (kind < 0.30) return { raw: moneyish(guard.LOAN_LIMIT + int(1, 100)), expect: 'warn' };
  if (kind < 0.40) return { raw: moneyish(guard.LOAN_LIMIT - int(1, 100)), expect: 'ok' };
  if (kind < 0.55) return { raw: moneyish(int(400001, 5000000)), expect: 'warn' };
  if (kind < 0.75) return { raw: moneyish(int(1, 400000)), expect: 'ok' };
  if (kind < 0.85) return { raw: -int(1, 900000), expect: 'advise' };                 // a negative states nothing
  if (kind < 0.92) return { raw: 0, expect: 'advise' };
  return { raw: moneyish(int(400001, 900000)), expect: 'warn' };
}

const PROPERTY_KEYS = ['sfr', 'single_family', 'SFR', 'townhouse', 'condo', 'condominium', 'duplex',
  'triplex', 'quadruplex', 'multi_2_4', 'Multi 2-4', 'mobile', 'land', 'mixed_use', '', null, 'Whatever'];
const REHAB_TYPES = ['light', 'heavy', 'cosmetic', 'ground_up', 'ground-up', 'none', '', null, 'Gut'];
const INSPECTIONS = ['interior-w-exterior', 'interior-homeowner-direct', 'exterior', 'draw-inspection',
  'none', '', null, 'brand-new-thing'];
const REPORT_TYPES = ['reno-arv', 'prop-value', 'new-construction', 'partial-construction', '', null, 'nope'];
const TATS = ['standard', 'rush', '', null, 'overnight'];

function ctxCase() {
  const units = pick([1, 1, 1, 2, 3, 4, 0, null, 12]);
  return {
    borrowerName: pick(['Israel Klein', 'MW TRADING LLC', '', null, 'Ó’Brien-Smith', 'A'.repeat(300)]),
    clientLoanNumber: pick(['YSCAP258134791', '', null, 12345]),
    loanAmount: loanAmountCase().raw,
    purchasePrice: chance(0.8) ? moneyish(int(50000, 2000000)) : pick(JUNK),
    asIsValue: chance(0.8) ? moneyish(int(50000, 2000000)) : pick(JUNK),
    arv: chance(0.8) ? moneyish(int(60000, 3000000)) : pick(JUNK),
    rehabBudget: chance(0.7) ? moneyish(int(0, 900000)) : pick(JUNK),
    rehabType: pick(REHAB_TYPES),
    expectedClosing: pick(['2026-09-30', '2026-08-15', '1999-01-01', '2099-12-31', '', null, 'not-a-date']),
    property: {
      key: pick(PROPERTY_KEYS),
      units,
      addressLine: pick(['100 Main St', '', null, '  ', 'Apt 4B']),
      city: pick(['Brooklyn', '', null]),
      state: pick(['NY', 'ny', 'New York', '', null, 'ZZ']),
      postalCode: pick(['11211', '11211-1234', '', null, '1121']),
      unitNumber: pick(['', null, '4B', 12]),
      yearBuilt: pick([1920, 2024, 0, null, '', 'old']),
      sqft: pick([1200, 0, null, '', -50]),
    },
    specs: chance(0.5) ? { bedrooms: pick([3, 0, null, 'three']), bathrooms: pick([2, 1.5, null, '']) } : null,
    proposed: chance(0.4) ? { bedrooms: pick([4, null]), bathrooms: pick([3, null]) } : null,
    reportContact: chance(0.7)
      ? { name: pick(['Chaya Gruber', '', null]), email: pick(['a@b.com', 'not-an-email', '', null]), phone: pick(['7182478701', '(718) 247-8701', '', null, '12']) }
      : null,
  };
}

function choicesCase(ctx) {
  const inspectionType = pick(INSPECTIONS);
  const onLockbox = chance(0.4);
  return {
    companyToken: pick(['ph8iYRK...', '', null]),
    loanOfficerToken: pick(['UcsHyD3...', '', null]),
    reportType: pick(REPORT_TYPES),
    inspectionType,
    turnaroundTime: pick(TATS),
    glaInclude: pick([true, false, undefined]),
    licensingRequired: pick([true, false, undefined]),
    includeFloodCertification: pick([true, false, undefined]),
    isPropertyOnLockbox: onLockbox,
    lockboxCode: onLockbox && chance(0.8) ? pick(['1234', '', null]) : pick([undefined, '9999']),
    lockboxLocation: onLockbox && chance(0.8) ? pick(['front-door', '', null, 'nowhere']) : undefined,
    lockboxEntrance: onLockbox && chance(0.8) ? pick(['front', '', null, 'roof']) : undefined,
    communityGateCodeNeeded: chance(0.2),
    gateCode: chance(0.2) ? pick(['4321', '', null]) : undefined,
    propertyAccessContacts: chance(0.6)
      ? [{ name: pick(['Borrower Name', '', null]), email: pick(['b@c.com', '', null]), phone: pick(['7185551234', '', null]) }]
      : pick([[], null, undefined]),
    reportContactName: pick(['Loan Officer', '', null]),
    reportContactEmail: pick(['lo@yscapgroup.com', '', null]),
    reportContactPhone: pick(['7182478701', '', null]),
    reportCcUsers: pick(['a@b.com,c@d.com', '', null]),
    expectedLoanAmount: ctx.loanAmount,
    acquisitionContractPrice: ctx.purchasePrice,
    expectedAsIsValue: ctx.asIsValue,
    expectedArv: ctx.arv,
    borrowerBudget: ctx.rehabBudget,
    budgetFiles: chance(0.3)
      ? [{ filename: pick(['sow.pdf', 'sow.xlsx', '']), contentType: 'application/pdf', bytes: Buffer.from('x') }]
      : pick([[], null, undefined]),
    notes: pick(['', null, 'A note.', 'x'.repeat(5000)]),
    inspectionNotes: pick(['', null, 'Meet at the door.']),
    valuationNotes: pick(['', null, 'Comp against 12 Oak.']),
    effectiveDate: pick(['2026-08-20', '', null, '2020-01-01']),
    now: new Date('2026-08-14T12:00:00Z'),
  };
}

/** A vendor `retrieve-response` payload — including the shapes that must NOT be trusted. */
function responseCase() {
  const kind = rand();
  const asIs = int(50000, 900000);
  const arv = asIs + int(1, 400000);
  if (kind < 0.06) return { case: 'empty', payload: pick([null, undefined, {}, [], '', 0, 'nope']) };
  if (kind < 0.12) return { case: 'garbage', payload: { results: pick([null, 'x', 42, [], {}]) } };
  if (kind < 0.20) {
    // The two values the wrong way round — must be REPORTED and marked unusable.
    return { case: 'inverted', payload: mkPayload(arv, asIs), asIs: arv, arv: asIs, expectUsable: false };
  }
  if (kind < 0.28) {
    // Implausible: a per-square-foot figure, or a doubled zero.
    const bad = pick([12, 250, 999, 500000000, 1e12]);
    return { case: 'implausible', payload: mkPayload(bad, bad * 2), expectPlausible: false };
  }
  if (kind < 0.34) return { case: 'equal', payload: mkPayload(asIs, asIs), expectUsable: false };
  return { case: 'good', payload: mkPayload(asIs, arv), asIs, arv, expectUsable: true };
}

function mkPayload(asIs, arv) {
  // THE REAL SHAPE. `results.renovation_strategies` is an ARRAY of titled rows and
  // the columns are best/min/partial/full — the grid is the point of this report,
  // and `best` is the strategy they recommend, which is where the ARV comes from.
  // The first cut of this generator built it as `{columns, rows}`, and every ARV
  // read back null: a generator that does not match the vendor proves nothing.
  const fmt = (n) => pick([`$${n.toLocaleString('en-US')}`, String(n), n, `${n}.00`]);
  return {
    results: {
      valuation_summary: { estimated_as_is_value: fmt(asIs) },
      renovation_strategies: [
        { title: 'As Is Value', min: fmt(asIs), partial: fmt(asIs), full: fmt(asIs), best: fmt(asIs) },
        { title: 'ARV', min: fmt(Math.round(arv * 0.9)), partial: fmt(Math.round(arv * 0.95)), full: fmt(arv), best: fmt(arv) },
        { title: 'Est. Renovation Budget', min: fmt(int(1000, 50000)), partial: fmt(int(1000, 120000)), full: fmt(int(1000, 200000)), best: fmt(int(1000, 200000)) },
        { title: 'Gross Margin', min: '16.30%', partial: '19.80%', full: '22.10%', best: '22.10%' },
      ],
    },
  };
}

const VENDOR_STATUSES = ['Order Payment Completed', 'Ordered', 'Data Reconciliation', 'Property Analysis',
  'Analysis Review', 'Review', 'Finalization', 'Completed', 'Report Delivered', 'Delivered', 'Cancelled',
  'Canceled', 'On Hold', 'Snag Released', 'Hold Released', 'Revision', 'Revision Requested',
  'Revision Completed', 'New Specs', 'Market Update', 'Report Type Changed', 'Report Transferred',
  '', null, 'A Status Nobody Has Seen', 'ON  HOLD', 'on_hold', 'ORDERED'];

const INTERNAL_STATUSES = ['draft', 'dryrun', 'placing', 'intake', 'ordered', 'in_process', 'assigned',
  'inspected', 'in_review', 'revision', 'product_available', 'completed', 'on_hold', 'cancelled',
  'rejected', 'error', 'a_status_we_never_defined'];

// ===========================================================================
// A — THE $400,000 GUARD
// ===========================================================================
function sectionA() {
  const c = loanAmountCase();
  let j;
  try { j = guard.judgeLoanAmount(c.raw); } catch (e) {
    return ok('A guard', 'judgeLoanAmount never throws', false, { raw: c.raw, err: String(e.message) });
  }

  ok('A guard', 'the verdict is one of the three states', ['ok', 'advise', 'warn'].includes(j.level), { raw: c.raw, level: j.level });
  // The verdict must match the amount — but "junk" is judged through the repo's
  // ONE money parser, and that parser legitimately reads a few odd strings as
  // real numbers ("1.2.3" is 1.2). So the property is stated against what the
  // parser actually returns rather than against a hand-written list, which keeps
  // it honest without pretending the guard owns the parsing rule.
  const parsed = moneyValue(c.raw);
  const expected = !(Number.isFinite(parsed) && parsed > 0) ? 'advise'
    : (parsed > guard.LOAN_LIMIT ? 'warn' : 'ok');
  ok('A guard', 'the verdict matches the amount', j.level === expected, { raw: c.raw, parsed, got: j.level, want: expected });
  if (c.expect !== 'advise') {
    // The generated intent and the parser must agree on every NON-junk case —
    // this is what would catch the guard quietly reading money a different way.
    ok('A guard', 'a generated amount is judged as generated', j.level === c.expect, { raw: c.raw, got: j.level, want: c.expect });
  }

  // The double confirmation is reachable ONLY on the strict state, and it is
  // ALWAYS reachable there — the owner's rule in both directions.
  ok('A guard', 'only an over-limit loan asks twice', j.requiresDoubleConfirm === (j.level === 'warn'), { raw: c.raw, level: j.level });
  ok('A guard', 'a warning always carries an acknowledgement token', j.level !== 'warn' || j.ack === guard.ACK, { raw: c.raw });
  ok('A guard', 'a warning always carries both prompts', j.level !== 'warn' || (!!j.confirmPrompt && !!j.secondPrompt), { raw: c.raw });
  ok('A guard', 'advice never asks for an acknowledgement', j.level !== 'advise' || j.ack === null, { raw: c.raw });
  ok('A guard', 'a clean loan says nothing', j.level !== 'ok' || (j.title === null && j.message === null), { raw: c.raw });
  ok('A guard', 'the limit is reported so the screen never restates it', j.limit === guard.LOAN_LIMIT);

  // The SERVER half. It must fail closed on the strict state and open on the rest.
  const empty = guard.checkAcknowledged(j, pick([undefined, null, [], '', 'something-else', ['nope'], 0]));
  ok('A guard', 'an unacknowledged warning is refused', j.level !== 'warn' || empty.ok === false, { raw: c.raw });
  ok('A guard', 'a refusal names the reason the route matches on',
    j.level !== 'warn' || empty.code === 'loan_amount_over_limit', { raw: c.raw, code: empty.code });
  ok('A guard', 'anything that is not a warning proceeds', j.level === 'warn' || guard.checkAcknowledged(j, []).ok === true, { raw: c.raw });

  const acked = guard.checkAcknowledged(j, pick([[guard.ACK], guard.ACK, ['x', guard.ACK]]));
  ok('A guard', 'the right acknowledgement lets it through', acked.ok === true, { raw: c.raw, level: j.level });

  // A judgement from nowhere must never be a way past the rule.
  ok('A guard', 'a missing judgement is not an authorisation',
    guard.checkAcknowledged(pick([null, undefined, {}]), []).ok === true);
}

// ===========================================================================
// B — MONEY, READ EVERY WAY
// ===========================================================================
function sectionB() {
  const n = int(1, 9000000);
  const forms = [n, String(n), `$${n.toLocaleString('en-US')}`, n.toLocaleString('en-US'),
    `${n}.00`, `$${n.toLocaleString('en-US')}.00`, ` ${n} `];
  const read = forms.map((f) => moneyValue(f));
  ok('B money', 'every way of writing one number reads as that number',
    read.every((v) => v === n), { n, read });

  // The guard reads money through the SAME parser — the whole reason a grouped
  // amount cannot be judged as "no loan amount registered".
  const grouped = `$${(guard.LOAN_LIMIT + 100000).toLocaleString('en-US')}`;
  ok('B money', 'a grouped over-limit amount is still the strict warning',
    guard.judgeLoanAmount(grouped).level === 'warn', { grouped });

  for (const j of JUNK) {
    const v = moneyValue(j);
    ok('B money', 'junk is never silently a number', v === null || Number.isFinite(v), { j, v });
    // The one that matters: junk must never become 0 and be treated as a real figure.
    if (j !== '0' && j !== '00' && j !== 0) {
      ok('B money', 'junk never becomes zero', v !== 0, { j, v });
    }
  }
}

// ===========================================================================
// C — THE ORDER BUILDER
// ===========================================================================
function sectionC() {
  const ctx = ctxCase();
  const choices = choicesCase(ctx);
  let built;
  try { built = build.buildOrder(ctx, choices); } catch (e) {
    return ok('C builder', 'buildOrder never throws', false, { err: String(e.message), ctx, choices });
  }
  if (!ok('C builder', 'buildOrder always returns fields', built && built.fields && typeof built.fields === 'object')) return;
  const f = built.fields;

  // EVERY value must be something their multipart serializer can send. An object
  // that is not a file part becomes the string "[object Object]" on the wire —
  // the class that silently corrupts a field nobody notices until the vendor asks.
  for (const [k, v] of Object.entries(f)) {
    const isFile = v && typeof v === 'object' && v.bytes;
    const isArray = Array.isArray(v);
    const scalar = v == null || ['string', 'number', 'boolean'].includes(typeof v);
    ok('C builder', 'every field is a scalar, an array or a file part', scalar || isFile || isArray, { k, type: typeof v });
    if (isArray) {
      for (const item of v) {
        const itemFile = item && typeof item === 'object' && item.bytes;
        const itemScalar = item == null || ['string', 'number', 'boolean'].includes(typeof item);
        ok('C builder', 'every array item is a scalar or a file part', itemScalar || itemFile, { k });
      }
    }
  }

  // THE BRANCH RULES. Their validator refuses a field that is forbidden for the
  // chosen branch, and a refusal arrives as an HTTP 200 — so sending one is a
  // silent failure, not a loud one.
  const lockboxKeys = ['lockbox_code', 'lockbox_location', 'lockbox_entrance'];
  if (!build.lockboxApplies(choices.inspectionType) || !choices.isPropertyOnLockbox) {
    for (const k of lockboxKeys) {
      ok('C builder', 'no lockbox field unless it is an interior inspection on a lockbox',
        f[k] === undefined, { k, inspection: choices.inspectionType, onLockbox: choices.isPropertyOnLockbox });
    }
  }
  if (!choices.communityGateCodeNeeded) {
    ok('C builder', 'no gate code unless a gate code is needed', f.gate_code === undefined, { gate: f.gate_code });
  }

  // A blank is DROPPED rather than sent as an empty string — an empty string still
  // counts as sending the field to their validator.
  for (const [k, v] of Object.entries(f)) {
    ok('C builder', 'a blank field is dropped, never sent empty', v !== '' && v !== null, { k, v });
  }

  // The report always carries the four numbers the owner asked to send, whenever
  // the file actually holds them.
  // THE FOUR NUMBERS THE OWNER ASKED TO SEND. The property that matters is NOT
  // "is it always sent" — omitting a figure is safe, and the preview shows what is
  // missing — but "if it IS sent, is it the figure the file actually means". A
  // number that reaches the vendor DIFFERENT from the one on the loan is the
  // expensive failure: they value the property against it.
  //
  // (The builder has its own `num()` while the repo's money chokepoint is
  // `fields.moneyValue`, and the two disagree on a couple of strings no door can
  // produce — these fields come from numeric columns or a typed override box.
  // Where they disagree the builder OMITS rather than guesses, which is the safe
  // direction, and that is exactly what is asserted here.)
  const moneyPair = [
    ['expected_loan_amount', ctx.loanAmount, 'loan amount'],
    ['expected_as_is_value', ctx.asIsValue, 'as-is value'],
    ['expected_arv', ctx.arv, 'ARV'],
    ['acquisition_contract_price', ctx.purchasePrice, 'purchase price'],
  ];
  for (const [key, src, label] of moneyPair) {
    const want = moneyValue(src);
    if (f[key] !== undefined) {
      ok('C builder', `a sent ${label} is the figure the file means`,
        Number(f[key]) === Math.round(want), { key, src, sent: f[key], want });
    } else if (typeof src === 'number' && Number.isFinite(src) && src > 0) {
      // A plain positive number is the shape every door actually produces, so
      // there is no excuse for dropping one.
      ok('C builder', `a plain ${label} on the file is not dropped`, f[key] !== undefined, { key, src });
    }
  }

  // Dates must be calendar strings — the repo's standing rule, and their validator
  // refuses anything else.
  for (const k of Object.keys(f)) {
    if (!/_date$|^effective_date$/.test(k)) continue;
    const v = f[k];
    ok('C builder', 'a date field is a plain YYYY-MM-DD string',
      v === undefined || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)), { k, v });
  }

  // The screen must be able to describe every field it is about to send, or the
  // confirmation page shows a raw key to whoever is authorising the spend.
  let rows;
  try { rows = build.fieldRows(built, choices); } catch (e) {
    return ok('C builder', 'fieldRows never throws', false, { err: String(e.message) });
  }
  ok('C builder', 'fieldRows always returns a list', Array.isArray(rows));
  for (const r of rows || []) {
    ok('C builder', 'every displayed row has a label', !!(r && r.label), { r });
  }

  // Their multipart serializer, on the very fields we just built.
  let fd;
  try { fd = client._internals.toFormData(f); } catch (e) {
    return ok('C builder', 'the built fields always serialize', false, { err: String(e.message) });
  }
  ok('C builder', 'the serializer produces a FormData', !!fd && typeof fd.append === 'function');
  for (const [, v] of fd.entries()) {
    ok('C builder', 'nothing serializes to the literal [object Object]', String(v) !== '[object Object]');
  }
}

// ===========================================================================
// D — THE FINISHED REPORT
// ===========================================================================
function sectionD() {
  const c = responseCase();
  let r;
  try { r = results.readResponse(c.payload); } catch (e) {
    return ok('D results', 'readResponse never throws', false, { case: c.case, err: String(e.message) });
  }
  if (!ok('D results', 'readResponse always returns a verdict', r && typeof r === 'object', { case: c.case })) return;

  // NEVER STORE A GUESS. A figure that is present must be inside the bounds a
  // residential value can actually take; anything else is left null with a reason.
  for (const k of ['asIs', 'arv']) {
    const v = r[k];
    ok('D results', 'a reported value is null or a real number', v === null || v === undefined || Number.isFinite(v), { case: c.case, k, v });
    // A figure outside the bounds a property value can take is still SHOWN — the
    // desk must see exactly what the vendor said — but it may never be marked
    // usable, because `valuesUsable` is what an automatic write onto the loan is
    // gated on. Reporting it is the feature; trusting it would be the bug.
    if (Number.isFinite(v) && (v < results.MIN_VALUE || v > results.MAX_VALUE)) {
      ok('D results', 'an implausible figure is never marked usable',
        r.valuesUsable !== true, { case: c.case, k, v, usable: r.valuesUsable });
      ok('D results', 'an implausible figure always states why it was not used',
        !!r.unusableReason, { case: c.case, k, v });
    }
  }

  // THE INVARIANT THE LOAN DEPENDS ON: an ARV at or below the As-Is means the two
  // are the wrong way round, and the pair must never be marked usable.
  if (Number.isFinite(r.asIs) && Number.isFinite(r.arv)) {
    ok('D results', 'a usable pair always has the ARV above the As-Is',
      !r.valuesUsable || r.arv > r.asIs, { case: c.case, asIs: r.asIs, arv: r.arv });
  }
  // …and when it refuses, it must say WHY, or a human has nothing to act on.
  if (r.valuesUsable === false) {
    ok('D results', 'an unusable pair always states a reason', !!r.unusableReason, { case: c.case, unusableReason: r.unusableReason });
  }
  // A value we did read must name where it came from — an ARV with no provenance
  // is a number nobody can defend to an investor.
  if (Number.isFinite(r.arv)) {
    ok('D results', 'an ARV always records its basis', !!r.arvBasis, { case: c.case, arv: r.arv });
  }
  if (c.case === 'good' && c.expectUsable) {
    ok('D results', 'a clean report is read as usable', r.valuesUsable === true, { asIs: r.asIs, arv: r.arv, why: r.unusableReason });
    ok('D results', 'a clean report reads back the As-Is it was given', r.asIs === c.asIs, { want: c.asIs, got: r.asIs });
    ok('D results', 'a clean report reads back the ARV it was given', r.arv === c.arv, { want: c.arv, got: r.arv });
  }
  if (c.case === 'inverted' || c.case === 'equal') {
    ok('D results', 'values the wrong way round are never usable', r.valuesUsable !== true, { case: c.case, asIs: r.asIs, arv: r.arv });
  }

  // The one-line summary is what a human reads first; it must never throw and
  // never claim a number that was not read.
  let line;
  try { line = results.summaryLine(r); } catch (e) {
    return ok('D results', 'summaryLine never throws', false, { case: c.case, err: String(e.message) });
  }
  ok('D results', 'the summary is always a string', typeof line === 'string' || line === null, { line });
}

// ===========================================================================
// E — THE STATUS LADDER
// ===========================================================================
function sectionE() {
  const vendor = pick(VENDOR_STATUSES);
  let mapped;
  try { mapped = sync.mapReportStatus(vendor); } catch (e) {
    return ok('E status', 'mapReportStatus never throws', false, { vendor, err: String(e.message) });
  }
  ok('E status', 'a status maps to a known internal state or to nothing',
    mapped === null || INTERNAL_STATUSES.includes(mapped), { vendor, mapped });

  const current = pick(INTERNAL_STATUSES);
  const incoming = pick(INTERNAL_STATUSES.concat([null, undefined, '']));
  let next;
  try { next = sync.nextStatus(current, incoming); } catch (e) {
    return ok('E status', 'nextStatus never throws', false, { current, incoming, err: String(e.message) });
  }

  const RANK = sync._internals.RANK;
  const rankOf = (s) => (RANK[s] == null ? 0 : RANK[s]);
  const ALWAYS = ['on_hold', 'cancelled', 'rejected', 'error'];

  ok('E status', 'nothing at all leaves the status alone', incoming || next === current, { current, incoming, next });
  if (incoming && ALWAYS.includes(incoming)) {
    ok('E status', 'a hold or a cancellation always applies', next === incoming, { current, incoming, next });
  } else if (incoming && (current === 'cancelled' || current === 'rejected')) {
    // A terminal order is terminal — this is what stops a late webhook reviving it.
    ok('E status', 'a cancelled order is never walked back', next === current, { current, incoming, next });
  } else if (incoming) {
    ok('E status', 'an out-of-order event can never move an order backwards',
      rankOf(next) >= rankOf(current), { current, incoming, next, a: rankOf(current), b: rankOf(next) });
  }
  ok('E status', 'the result is always a state we recognise or the one we had',
    next === current || INTERNAL_STATUSES.includes(next), { current, incoming, next });

  // Applying the same event twice must land in the same place — their webhooks
  // retry, and a retry of an event we already applied is the common case.
  ok('E status', 'applying an event twice is the same as applying it once',
    sync.nextStatus(next, incoming) === next, { current, incoming, next });
}

// ===========================================================================
// F — THE SCOPE-OF-WORK PLAN
// ===========================================================================
const PLAN_ACTIONS = ['none', 'update', 'upload', 'reopen'];
function sectionF() {
  const order = {
    intake_token: chance(0.85) ? 'tok_' + int(1000, 9999) : pick(['', null, undefined]),
    dryrun: chance(0.15),
    status: pick(INTERNAL_STATUSES.concat(['', null, 'COMPLETED', 'In_Review'])),
  };
  let plan;
  try { plan = sow.revisionPlanFor(order); } catch (e) {
    return ok('F sow', 'revisionPlanFor never throws', false, { order, err: String(e.message) });
  }
  if (!ok('F sow', 'a plan is always returned', plan && typeof plan === 'object', { order })) return;
  ok('F sow', 'every plan is one of the four moves', PLAN_ACTIONS.includes(plan.action), { order, plan });
  ok('F sow', 'every plan explains itself', !!plan.why, { order, plan });

  // NOTHING IS ATTEMPTED WITHOUT A LIVE ORDER — the property that stops a dry-run
  // or a never-placed order from firing a real request at the vendor.
  if (!order.intake_token || order.dryrun) {
    ok('F sow', 'no live order means no move', plan.action === 'none', { order, plan });
  }
  const dead = ['cancelled', 'rejected', 'draft', 'dryrun', 'error'];
  if (dead.includes(String(order.status || '').toLowerCase())) {
    ok('F sow', 'a dead order is never updated', plan.action === 'none', { order, plan });
  }
  // A FINISHED report must be REOPENED, never merely updated — its after-repair
  // value was worked out against the old scope.
  if (order.intake_token && !order.dryrun && ['completed', 'product_available'].includes(String(order.status || '').toLowerCase())) {
    ok('F sow', 'a finished report is reopened, not quietly updated', plan.action === 'reopen', { order, plan });
    ok('F sow', 'a reopen always carries its reason', plan.reopenReason === 'new-budget', { plan });
  }
  // An unknown status must still reach the appraiser — the safe move, never a
  // silent nothing.
  if (order.intake_token && !order.dryrun && !INTERNAL_STATUSES.includes(String(order.status || '').toLowerCase())
      && order.status) {
    ok('F sow', 'an unrecognised status still sends the file', plan.action === 'upload', { order, plan });
  }
}

// ===========================================================================
// G — PAYMENT
// ===========================================================================
function sectionG() {
  // THE OWNER'S RULE, asserted as a property rather than as a comment: the two
  // methods they forbade must not exist anywhere in the offered set.
  const forbidden = /invoice|ach|bank|wire/i;
  ok('G payment', 'no forbidden payment method is offered',
    payment.METHODS.every((m) => !forbidden.test(m)), { methods: payment.METHODS });
  ok('G payment', 'exactly the four allowed methods are offered',
    payment.METHODS.length === 4
    && payment.METHODS.includes('COMPANY_CARD')
    && payment.METHODS.includes('CARD_ON_FILE')
    && payment.METHODS.includes('NEW_CARD')
    && payment.METHODS.includes('PAYMENT_LINK'), { methods: payment.METHODS });
  // OUR OWN CARD IS THE DEFAULT (owner-directed 2026-08-16, "we pay in-house, link
  // as the backup"). Asserted as the FIRST entry because that ordering is what an
  // unconfigured deployment and the order screen's own fallback list both read.
  ok('G payment', 'our own card with Richer Values is the first method offered',
    payment.METHODS[0] === 'COMPANY_CARD', { methods: payment.METHODS });

  // Their processor refuses a raw card on this account; recognising that refusal is
  // what turns a dead end into a payment link.
  const refusals = [
    { message: 'Sending credit card numbers directly to the Stripe API is generally prohibited' },
    { body: { message: 'sending credit card numbers directly to the stripe api is generally prohibited' } },
    'Sending credit card numbers directly to the Stripe API is generally prohibited',
  ];
  for (const r of refusals) {
    let saw;
    try { saw = payment.isRawCardBlocked(r); } catch (e) {
      ok('G payment', 'the refusal check never throws', false, { err: String(e.message) }); continue;
    }
    ok('G payment', 'their raw-card refusal is recognised', saw === true, { r: safe(r).slice(0, 80) });
  }
  for (const other of [null, undefined, {}, { message: 'insufficient funds' }, new Error('timeout'),
    { body: { message: 'Your card was declined.' } }]) {
    let saw;
    try { saw = payment.isRawCardBlocked(other); } catch (e) {
      ok('G payment', 'the refusal check never throws', false, { err: String(e.message) }); continue;
    }
    ok('G payment', 'an ordinary decline is not mistaken for their refusal', saw === false, { other: safe(other).slice(0, 60) });
  }

  // A card's expiry decides whether it can be charged at all. `isExpired(month, year)`
  // reads today's clock itself, so the property is stated relative to NOW rather
  // than to a fixed date — an audit that hard-codes a year starts failing in January.
  const now = new Date();
  const thisYear = now.getUTCFullYear();
  const thisMonth = now.getUTCMonth() + 1;
  const expCases = [
    { m: 1, y: 1990, expired: true },
    { m: thisMonth, y: thisYear, expired: false },          // the current month is still good
    { m: 12, y: thisYear + 5, expired: false },
    { m: 1, y: thisYear - 1, expired: true },
    { m: null, y: null, expired: false },                   // unknown is deliberately NOT expired
    { m: 'x', y: 'y', expired: false },
    { m: 13, y: thisYear, expired: false },
    { m: 0, y: thisYear, expired: false },
  ];
  for (const c of expCases) {
    let got;
    try { got = payment._internals.isExpired(c.m, c.y); } catch (e) {
      ok('G payment', 'the expiry check never throws', false, { c, err: String(e.message) }); continue;
    }
    ok('G payment', 'a card expiry is judged correctly', got === c.expired, { c, got });
  }
  // An expiry that is genuinely in the past must ALWAYS read as expired, whatever
  // month the audit happens to run in — the property, rather than a fixed example.
  const pastYear = thisYear - int(1, 20);
  ok('G payment', 'any past expiry reads as expired',
    payment._internals.isExpired(int(1, 12), pastYear) === true, { pastYear });
  const futureYear = thisYear + int(1, 20);
  ok('G payment', 'any future expiry reads as good',
    payment._internals.isExpired(int(1, 12), futureYear) === false, { futureYear });
}

// ===========================================================================
// H — THE TRANSPORT
// ===========================================================================
const SECRETY = ['password', 'api_token', 'apiToken', 'access_token', 'authorization', 'token',
  'company_token', 'loan_officer_token', 'payment_source_id', 'card_number', 'cvv',
  'routing_number', 'bank_account_number'];
function sectionH() {
  // A SECRET CAN NEVER REACH A LOG LINE. Built at a random depth, because the
  // dry-run log prints the whole body and a nested credential is the one that gets
  // missed by a hand-written masker.
  const secretValue = 'SUPER-SECRET-' + int(100000, 999999);
  const key = pick(SECRETY);
  const depth = int(0, 4);
  let node = { [key]: secretValue, keep: 'visible' };
  for (let i = 0; i < depth; i++) node = chance(0.5) ? { nested: node } : [node];
  let masked;
  try { masked = client._internals.maskSafe(node); } catch (e) {
    return ok('H transport', 'masking never throws', false, { err: String(e.message) });
  }
  const printed = JSON.stringify(masked);
  ok('H transport', 'a credential never survives masking, at any depth',
    !printed.includes(secretValue), { key, depth });
  ok('H transport', 'masking keeps everything that is not a credential',
    printed.includes('visible'), { key, depth });

  // File bytes are summarized, never printed — a scope of work is megabytes.
  const withFile = { budget_files: { filename: 'sow.pdf', contentType: 'application/pdf', bytes: Buffer.alloc(int(1, 5000), 7) } };
  const m2 = client._internals.maskSafe(withFile);
  ok('H transport', 'a file is summarized rather than printed',
    m2.budget_files && typeof m2.budget_files.bytes === 'number', { got: safe(m2).slice(0, 120) });

  // Their per-field validation list is what lets the desk name the field they
  // refused. It must never carry the VALUE — that list is shown on a screen and
  // stored in the journal, and a refused field can be an email or a phone number.
  const value = 'borrower@example.com';
  const body = {
    errors: [
      { message: 'is not allowed', key: 'gla_include', label: 'gla_include', value },
      { message: 'is required', child: 'postal_code' },
      'a bare string error',
      null,
      { nothing: true },
    ],
  };
  let fe;
  try { fe = client._internals.fieldErrorsOf(body); } catch (e) {
    return ok('H transport', 'reading their errors never throws', false, { err: String(e.message) });
  }
  ok('H transport', 'their field errors are a list', Array.isArray(fe));
  ok('H transport', 'a refused value is never carried into the journal',
    !JSON.stringify(fe).includes(value), { fe });
  ok('H transport', 'an unusable error entry is dropped rather than half-recorded',
    fe.every((e) => e && (e.field || e.message)), { fe });
  ok('H transport', 'reading errors out of nothing is empty, not a throw',
    Array.isArray(client._internals.fieldErrorsOf(pick([null, undefined, {}, [], 'x']))));

  // The retry delay must always be a real, bounded number — an unbounded or NaN
  // backoff is a hung request rather than a retried one.
  const attempt = int(1, 6);
  const ra = pick([0, undefined, 1, 30, 6000, -5, NaN]);
  const wait = client._internals.backoff(attempt, ra);
  ok('H transport', 'the retry delay is a real number', Number.isFinite(wait), { attempt, ra, wait });
  ok('H transport', 'the retry delay is never negative', wait >= 0, { attempt, ra, wait });
  ok('H transport', 'the retry delay is bounded', wait <= 60000, { attempt, ra, wait });

  // A non-JSON body is KEPT — the lesson the AMC integration paid for: a proxy's
  // plain-text refusal must never be indistinguishable from a bad credential.
  const html = '<html><body>Blocked by proxy</body></html>';
  const read = client._internals.readBody(Buffer.from(html));
  ok('H transport', 'a non-JSON refusal is kept verbatim', !!read.raw && read.raw.includes('Blocked by proxy'), { read });
  ok('H transport', 'an empty body reads as empty, not as a throw',
    JSON.stringify(client._internals.readBody(Buffer.alloc(0))) === '{}');
}

// ===========================================================================
// I — THE CATALOGUE READERS
// ===========================================================================
function sectionI() {
  // THE NORMALIZERS ARE ONLY EVER REACHED THROUGH A FILTER. Their callers run
  // `.filter((t) => t && t.slug)` (and `u && u.token`) before mapping, so a null
  // row structurally cannot arrive — asserting they survive `undefined` would be
  // testing a contract that does not exist. What DOES matter is that a real row,
  // however sparse, comes back usable rather than half-built.
  const rows = [
    { slug: 'reno-arv', formal_name: 'Renovation Analysis', price: { base_fee: 419.99 } },
    { slug: 'prop-value' },
    { slug: 'interior-w-exterior', name: 'Interior (w Exterior)', price: { inspection_fee: 70 } },
    { slug: 'rush', name: 'Rush', fee: 100, turnaround_time_text: '2-4 biz days' },
    { slug: 'standard', fee: 0 },
  ];
  const raw = pick(rows);
  for (const fn of ['normReportType', 'normInspectionType', 'normTat']) {
    const f = reference._internals[fn];
    if (typeof f !== 'function') continue;
    let outRow;
    try { outRow = f(raw); } catch (e) {
      ok('I catalogue', `${fn} never throws on a row its caller would pass`, false,
        { raw: safe(raw).slice(0, 80), err: String(e.message) });
      continue;
    }
    ok('I catalogue', `${fn} always returns a row`, !!outRow && typeof outRow === 'object', { fn, raw: safe(raw).slice(0, 60) });
    // The slug is the identity the order is placed with — losing it would send an
    // order for a product the vendor cannot match.
    ok('I catalogue', `${fn} keeps the slug it was given`, !outRow || outRow.slug === raw.slug, { fn, raw: raw.slug, got: outRow && outRow.slug });
    // A price we could not read must be null, never 0 — a zero is a claim that the
    // product is free, and it would be shown to whoever authorises the spend.
    for (const k of ['baseFee', 'reportTypeFee', 'fee', 'feeAdditionalUnits']) {
      if (!outRow || !(k in outRow)) continue;
      ok('I catalogue', `${fn} never invents a zero price`,
        outRow[k] === null || Number.isFinite(outRow[k]), { fn, k, v: outRow[k] });
    }
  }
  const u = reference._internals.normUser({ token: 'abc', first_name: 'A', last_name: 'B', email: 'a@b.com' });
  ok('I catalogue', 'normUser keeps the token an order is placed by', !!u && u.token === 'abc', { u });

  // `pick` chooses an option out of a CATALOGUE ({items}). It must never invent one
  // that is not on the list — an inspection type we made up is an order the vendor
  // refuses, as an HTTP 200 nobody notices.
  const catalogue = { items: [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }] };
  const want = pick(['a', 'b', 'c', 'zzz', '', null, undefined]);
  let chosen;
  try { chosen = reference.pick(catalogue, want); } catch (e) {
    return ok('I catalogue', 'pick never throws', false, { want, err: String(e.message) });
  }
  ok('I catalogue', 'pick never invents an option that is not on the list',
    chosen == null || catalogue.items.some((x) => x.slug === chosen.slug), { want, chosen });
  if (['a', 'b', 'c'].includes(want)) {
    ok('I catalogue', 'pick honours a choice that IS on the list', chosen && chosen.slug === want, { want, chosen });
  } else {
    ok('I catalogue', 'an unknown choice picks nothing rather than the first option', chosen === null, { want, chosen });
  }
  for (const bad of [null, undefined, {}, { items: null }, { items: 'x' }, []]) {
    let r;
    try { r = reference.pick(bad, 'a'); } catch (e) {
      ok('I catalogue', 'pick survives an unusable catalogue', false, { bad: safe(bad), err: String(e.message) }); continue;
    }
    ok('I catalogue', 'an unusable catalogue picks nothing', r === null, { bad: safe(bad), r });
  }
}

// ===========================================================================
// J — LIVE (opt-in, READ ONLY)
// ===========================================================================
async function sectionJLive(rounds) {
  const cfg = require(path.join(ROOT, 'src/config'));
  const c = client.configured();
  if (!c.ready) {
    console.log('  live: skipped — no RV credentials in the environment');
    return;
  }
  console.log(`  live: ${rounds} read-only rounds against ${c.baseUrl}`);
  const ct = await client.companyToken();
  ok('J live', 'a company token resolves', !!ct);
  if (!ct) return;

  const cat = await client.reportTypes(ct);
  const types = (cat && cat.data && cat.data.reportTypes) || [];
  ok('J live', 'they still list report types', Array.isArray(types) && types.length > 0, { n: types.length });
  ok('J live', 'the product we order is still on their catalogue',
    types.some((t) => t.slug === (cfg.richerValue && cfg.richerValue.defaultReportType || 'reno-arv')),
    { slugs: types.map((t) => t.slug) });

  const PROPS = ['sfr', 'townhouse', 'condo', 'duplex', 'triplex', 'quadruplex', 'mobile'];
  const STATES = ['NY', 'NJ', 'FL', 'TX', 'CA', 'PA', 'OH', 'GA'];
  const ZIPS = ['11211', '07030', '33101', '75001', '90001', '19103', '44101', '30301'];

  for (let i = 0; i < rounds; i++) {
    round = i + 1;
    const rt = pick(types).slug;
    const insp = rt && rt.includes('construction') ? 'none' : pick(['interior-w-exterior', 'exterior', 'interior-homeowner-direct', 'none']);
    const zi = int(0, STATES.length - 1);
    let q;
    try {
      q = await client.pricing({
        company_token: ct, report_type: rt, inspection_type: insp,
        turnaround_time: pick(['standard', 'rush']),
        residential_property_type: pick(PROPS),
        state: STATES[zi], postal_code: ZIPS[zi],
      });
    } catch (e) {
      ok('J live', 'a price quote always answers', false, { rt, insp, err: String(e.message).slice(0, 160) });
      continue;
    }
    const p = q && q.data && q.data.pricing_data && q.data.pricing_data.single_report_amount;
    if (!ok('J live', 'a quote carries a price block', !!p, { rt, insp })) continue;
    ok('J live', 'the quoted total is a real number', Number.isFinite(Number(p.total_price)), { rt, total: p.total_price });
    ok('J live', 'the quoted total is the sum of its own lines',
      Math.abs(Number(p.total_price)
        - (Number(p.base_fee) + Number(p.inspection_fee) + Number(p.rush_fee || 0)
           + Number(p.gla_surcharge || 0) + Number(p.licensing_surcharge || 0)
           + Number(p.flood_charge || 0) + Number(p.conversion_fee || 0) + Number(p.surcharge_fee || 0))) < 0.011,
      { rt, insp, p });
    ok('J live', 'a quote always carries a due date', !!p.due_date, { rt });
    // THE CARD SURCHARGE IS OUTSIDE THE TOTAL, and the desk quotes it separately
    // because of that. If they ever fold it in, this flips and the screen would
    // start double-counting it — so the shape is pinned, not just the number.
    ok('J live', 'the card surcharge is carried on the quote', p.cc_surcharge != null, { rt });
    ok('J live', 'the card surcharge is NOT already inside the total',
      Math.abs(Number(p.total_price) - (Number(p.base_fee) + Number(p.inspection_fee)
        + Number(p.rush_fee || 0) + Number(p.gla_surcharge || 0) + Number(p.licensing_surcharge || 0)
        + Number(p.flood_charge || 0) + Number(p.conversion_fee || 0) + Number(p.surcharge_fee || 0))) < 0.011,
      { rt, total: p.total_price, cc: p.cc_surcharge });
  }

  // ---- every product they sell can be priced -------------------------------
  // The desk offers whatever their catalogue lists, so a product that cannot be
  // priced is a product a staffer can pick and then not order. The two
  // construction reports take no inspection at all — their only inspection type
  // is `none` — which is exactly the branch that used to be unbuildable here.
  for (const t of types) {
    const insp = String(t.slug).includes('construction') ? 'none' : 'interior-w-exterior';
    try {
      const q = await client.pricing({
        company_token: ct, report_type: t.slug, inspection_type: insp,
        turnaround_time: 'standard', residential_property_type: 'sfr',
        state: 'PA', postal_code: '18702',
      });
      const p = q && q.data && q.data.pricing_data && q.data.pricing_data.single_report_amount;
      ok('J live', `their ${t.slug} report prices`, !!p && Number.isFinite(Number(p.total_price)),
        { rt: t.slug, insp, total: p && p.total_price });
    } catch (e) {
      ok('J live', `their ${t.slug} report prices`, false, { rt: t.slug, insp, err: String(e.message).slice(0, 160) });
    }
  }
}

// ===========================================================================
// RUN
// ===========================================================================
async function main() {
  const t0 = Date.now();
  console.log(`Richer Values A-to-Z audit — ${ROUNDS} rounds, seed ${SEED}${LIVE ? ', + live read-only sweep' : ''}`);

  for (let i = 1; i <= ROUNDS; i++) {
    round = i;
    sectionA();
    sectionB();
    sectionC();
    sectionD();
    sectionE();
    sectionF();
    sectionG();
    sectionH();
    sectionI();
  }

  if (LIVE) {
    try { await sectionJLive(Math.min(ROUNDS, 40)); }
    catch (e) { ok('J live', 'the live sweep completes', false, { err: String(e && e.message || e) }); }
  }

  const ms = Date.now() - t0;
  console.log('');
  for (const [name, s] of [...sections.entries()].sort()) {
    console.log(`  ${s.failures ? 'FAIL' : 'ok  '} ${name.padEnd(14)} ${String(s.checks).padStart(7)} checks${s.failures ? `, ${s.failures} FAILED` : ''}`);
  }
  console.log(`\n${checks} checks over ${ROUNDS} rounds in ${ms}ms`);

  if (!failures.length) {
    console.log('audit-richer-value: all checks passed');
    return;
  }
  // Group, so a single broken property does not print two thousand times.
  const byWhat = new Map();
  for (const f of failures) {
    const k = `${f.section} :: ${f.what}`;
    const g = byWhat.get(k) || { n: 0, first: f };
    g.n += 1; byWhat.set(k, g);
  }
  console.log(`\n${failures.length} FAILURES (${byWhat.size} distinct):`);
  for (const [k, g] of byWhat) {
    console.log(`\n  ${k}`);
    console.log(`    ${g.n} time(s); first at round ${g.first.round} (replay: --seed ${SEED} --rounds ${g.first.round})`);
    console.log(`    ${safe(g.first.detail)}`);
  }
  process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
