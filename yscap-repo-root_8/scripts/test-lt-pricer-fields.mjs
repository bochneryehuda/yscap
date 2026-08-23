/**
 * THE PRICING ENGINE'S FORM RULES — and the guard that stops the screen offering what the pricer
 * refuses.
 *
 * WHY THIS SUITE EXISTS, in one sentence: the screen shipped a "2–4 family" option whose value was
 * `TwoToFourFamily`, which the server's own registry answers with `null`, so picking it returned
 * `unknown_property_type` (422) instead of a price — an option on the menu, indistinguishable from
 * the ones beside it, that could not work. Nothing caught it because nothing ever ran the screen's
 * option list past the server's resolver.
 *
 * So this does not check spelling. It RUNS THE SERVER'S OWN CODE over everything the form offers:
 *   • every property type must resolve;
 *   • every borrower type must be in the tenant enum;
 *   • every prepay structure must map to a token;
 *   • every prepay term must be one the connector can resolve to an option;
 *   • and the browser's amount triangle must agree with the server's, to the cent, over a battery.
 *
 * Pure + offline: no database, no network, no bundler. Run: node scripts/test-lt-pricer-fields.mjs
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require2 = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const F = await import(path.join(ROOT, 'app-v2/src/longterm/scenarioFields.js'));
const registry = require2(path.join(ROOT, 'src/longterm/lenderprice/field-registry.js'));
const model = require2(path.join(ROOT, 'src/longterm/lenderprice/search-model.js'));

let pass = 0; const fails = [];
const ok = (cond, msg) => { if (cond) pass += 1; else fails.push(msg); };

/* ── A. every option the form offers is one the server accepts ─────────────── */
for (const p of F.PROPERTY_TYPES) {
  const r = registry.resolvePropertyType(p.value);
  ok(r != null, `A1 property type "${p.value}" (${p.label}) must resolve — the server refuses an unknown one with 422`);
}
// The defect this suite was written for, pinned by name so it cannot come back under its old value.
ok(registry.resolvePropertyType('TwoToFourFamily') == null,
  'A2 …and TwoToFourFamily is still NOT a token (if the server learns it, this guard is stale, not the screen)');
ok(F.PROPERTY_TYPES.every((p) => p.value !== 'TwoToFourFamily'),
  'A3 …so the form must not offer it');

for (const b of F.BORROWER_TYPES) {
  ok(registry.BORROWER_TYPES.has(b.value), `A4 borrower type "${b.value}" must be in the tenant enum`);
}
// The owner named three by name; they must all be reachable.
for (const want of ['LLC', 'Corporation', 'Individual']) {
  ok(F.BORROWER_TYPES.some((b) => b.value === want), `A5 the form must offer "${want}" — the owner asked for it by name`);
}
// …AND ONLY THOSE THREE (owner-directed 2026-08-23: "for now, you can park the rest of the
// options"). Asserting the LIST rather than only its members is what makes this a parking somebody
// has to un-park deliberately, instead of a fourth option drifting back in unnoticed.
ok(F.BORROWER_TYPES.length === 3, `A5b exactly three borrower types are offered (found ${F.BORROWER_TYPES.length})`);
// The parked three are still real tenant tokens, so bringing one back is one line and never a
// fresh piece of research. A parked value that has silently stopped being valid is worth knowing.
for (const b of F.BORROWER_TYPES_PARKED) {
  ok(registry.BORROWER_TYPES.has(b.value), `A5c parked borrower type "${b.value}" is still a tenant token`);
}
ok(!F.BORROWER_TYPES.some((b) => F.BORROWER_TYPES_PARKED.some((q) => q.value === b.value)),
  'A5d nothing is both offered and parked');

for (const s of F.PREPAY_STRUCTURES) {
  ok(registry.mapPrepayStructure(s.value) != null, `A6 prepay structure "${s.value}" must map to a token`);
}
// The two the owner asked for by name.
ok(registry.mapPrepayStructure('Fixed 5%') === 'Fixed5', 'A7 "Fixed 5%" maps to the vendor token Fixed5');
ok(registry.mapPrepayStructure('6 Months Interest') === '6MosInt', 'A8 "6 Months Interest" maps to 6MosInt');
for (const want of ['Fixed 5%', '6 Months Interest']) {
  ok(F.PREPAY_STRUCTURES.some((s) => s.value === want), `A9 the form must offer "${want}" — the owner asked for it by name`);
}

// The prepay TERMS must be terms the connector can resolve to a special mortgage option. Reading
// the map rather than retyping it means adding a term upstream cannot leave this list stale.
const SMO_PPP = model._internals && model._internals.SMO_PPP;
ok(SMO_PPP && typeof SMO_PPP === 'object', 'A10 the connector exposes its prepay-term map for this guard');
if (SMO_PPP) {
  for (const t of F.PREPAY_TERMS) {
    ok(Object.prototype.hasOwnProperty.call(SMO_PPP, String(Number(t.value))),
      `A11 prepay term ${t.value} months must resolve to an option (have: ${Object.keys(SMO_PPP).join(', ')})`);
  }
}

for (const p of F.PURPOSES) {
  let mapped = null;
  try { mapped = model._internals.mapPurpose(p.value); } catch { mapped = null; }
  ok(mapped != null, `A12 purpose "${p.value}" must map — the server refuses an unknown one`);
}

/* ── B. the units rule matches the server's own refusals ───────────────────── */
// validateInputs refuses a single-family with != 1 unit, a 2–4 outside 2–4, a multifamily under 5.
// So the CONTROL must not be able to produce one of those.
ok(F.unitsMode('SingleFamily').mode === 'fixed' && F.unitsMode('SingleFamily').value === 1,
  'B1 a single family is one unit and the box does not appear');
const u24 = F.unitsMode('Unit2_4');
ok(u24.mode === 'choice' && u24.options.join(',') === '2,3,4', 'B2 a 2–4 family offers exactly 2, 3 and 4');
const umf = F.unitsMode('MultiFamily');
ok(umf.mode === 'free' && umf.min === 5, 'B3 a multifamily is free to type and starts at 5');
ok(F.unitsFor('SingleFamily', '4') === '1', 'B4 switching to a single family drops a leftover 4 (the server calls that a units_conflict)');
ok(F.unitsFor('Unit2_4', '1') === '2', 'B5 …and switching to a 2–4 family lifts a leftover 1 into range');
ok(F.unitsFor('MultiFamily', '2') === '5', 'B6 …and a multifamily cannot start under 5');
ok(F.unitsFor('Unit2_4', '3') === '3', 'B7 …while a value already in range is left alone');

ok(F.showsNonWarrantable('Condo') === true, 'B8 the non-warrantable question appears on a condo');
ok(F.showsNonWarrantable('SingleFamily') === false, 'B9 …and on nothing else');

/* ── C. the amount triangle agrees with the server's, to the cent ──────────── */
// THE POINT OF THIS SECTION: the browser cannot require server code, so `deriveAmount` is a second
// copy of `deriveAmounts`. A second copy drifts. This runs both over the same battery.
const AMOUNTS = [];
for (const value of [500000, 375000, 1250000, 87500, 999999, 250000]) {
  for (const ltv of [75, 80, 65, 70.5, 0.75, 62.375, 55]) AMOUNTS.push({ value, ltv });
  for (const loan of [375000, 400000, 87500, 1, 999998]) AMOUNTS.push({ value, loan });
}
for (const loan of [375000, 250000]) for (const ltv of [75, 80, 0.7]) AMOUNTS.push({ loan, ltv });
let compared = 0;
for (const a of AMOUNTS) {
  const mine = F.deriveAmount(a);
  const theirs = model._internals.deriveAmounts(a);
  const same = (x, y) => (x == null && y == null) || (x != null && y != null && Math.abs(x - y) < 1e-9);
  const agree = same(mine.value, theirs.value) && same(mine.loan, theirs.loan) && same(mine.ltv, theirs.ltv);
  ok(agree, `C1 the two triangles must agree on ${JSON.stringify(a)} — screen ${JSON.stringify(mine)} vs server ${JSON.stringify({ value: theirs.value, loan: theirs.loan, ltv: theirs.ltv })}`);
  compared += 1;
}
ok(compared >= 60, `C2 the battery must actually compare something (compared ${compared})`);
// And that the battery is not vacuously agreeing on nothing: at least one case must DERIVE.
ok(AMOUNTS.some((a) => F.deriveAmount(a).derived.length > 0), 'C3 …and at least one case genuinely derives a figure');
ok(F.deriveAmount({ value: '500000', ltv: '75' }).loan === 375000, 'C4 the owner\'s case: $500k at 75% fills in a $375k loan');
ok(F.deriveAmount({ value: '', ltv: '' }).loan == null, 'C5 …and nothing is invented from nothing');
ok(F.normalizeLtv('75') === 0.75 && F.normalizeLtv('0.75') === 0.75, 'C6 an LTV is read the same typed either way');

/* ── D. what goes on the wire ──────────────────────────────────────────────── */
// ⛔ THE AMOUNT THE PERSON DID NOT TYPE IS NOT SENT. The server refuses a supplied LTV that
// disagrees with loan ÷ value, so shipping both would turn a rounding difference into `ltv_conflict`
// instead of a price.
const sentLtv = F.toScenario({ amountMode: 'ltv', value: '500000', loan: '375000', ltv: '75' });
ok(sentLtv.ltv === 75 && !('loan' in sentLtv), 'D1 in LTV mode the LTV is sent and the derived loan is not');
const sentLoan = F.toScenario({ amountMode: 'loan', value: '500000', loan: '375000', ltv: '75' });
ok(sentLoan.loan === 375000 && !('ltv' in sentLoan), 'D2 in loan mode the loan is sent and the derived LTV is not');
ok(!('amountMode' in sentLoan), 'D3 the mode itself is the form\'s bookkeeping and never travels');

const bools = F.toScenario({ io: true, escrowWaive: false, nonWarrantable: true });
ok(bools.io === true, 'D4 a ticked box is sent as a real boolean');
ok(!('escrowWaive' in bools), 'D5 …and an unticked one is OMITTED, not sent as false — the server reads an explicit false as "turn it off", which is a different instruction from "I did not say"');
ok(bools.nonWarrantable === true, 'D6 a non-warrantable condo is sent');

const conflict = F.toScenario({ propertyType: 'SingleFamily', units: '4' });
ok(conflict.units === 1, 'D7 a units figure that contradicts the type is corrected before it is sent, not refused afterwards');
ok(F.toScenario({ propertyType: 'Unit2_4', units: '3' }).units === 3, 'D8 …while a legitimate one rides through');

const blanks = F.toScenario({ purpose: 'Purchase', value: '500000', fico: '', dscr: null, prepayStructure: '' });
ok(!('fico' in blanks) && !('dscr' in blanks) && !('prepayStructure' in blanks),
  'D9 a blank is OMITTED entirely — an empty string sent as a value is a value the pricer would have to guess at');
ok(blanks.value === 500000 && typeof blanks.value === 'number', 'D10 …and a number travels as a number');

/* ── E. every field the form sends is one the route accepts ────────────────── */
// The same class as A1, one layer out: a key the route does not know is a 422 (`unsupported_field`).
const routeMod = require2(path.join(ROOT, 'src/longterm/routes/dscr-pricer.js'));
const everything = F.toScenario({
  amountMode: 'ltv', purpose: 'Purchase', value: '500000', ltv: '75', fico: '740', dscr: '1.20',
  zip: '33101', propertyType: 'Condo', units: '1', nonWarrantable: true, borrowerType: 'Corporation',
  lockDays: '30', io: true, escrowWaive: true, fthb: true, prepayMonths: '36', prepayStructure: 'Fixed 5%',
  state: 'FL', county: 'Miami-Dade',
});
for (const k of Object.keys(everything)) {
  ok(routeMod.SUPPORTED_FIELDS.has(k) || routeMod.META_FIELDS.has(k),
    `E1 the route must accept "${k}" — an unknown key is refused with 422 unsupported_field`);
}
ok(Object.keys(everything).length >= 14, `E2 …and the full form must actually send a full scenario (sent ${Object.keys(everything).length} keys)`);

/* ── M) MONEY, AS A PERSON WRITES IT ───────────────────────────────────────────
   The owner asked for the property value and the loan amount "laid out as dollars with a dollar
   sign with commas". The moment a box holds grouped text, `Number("500,000")` is NaN — so the risk
   this section exists for is not the formatting, it is what the formatting does to the number that
   reaches the pricer. */
ok(F.formatMoney('500000') === '500,000', 'M1 a plain figure groups');
ok(F.formatMoney('1250000') === '1,250,000', 'M2 …at every thousand');
ok(F.formatMoney('') === '', 'M3 an empty box stays empty — never 0, which is a figure somebody chose');
ok(F.formatMoney('abc') === '', 'M4 …and so does text with no digits in it');
ok(F.formatMoney('007') === '7', 'M5 leading zeros are dropped');
// ⛔ THE HUNDREDFOLD ERROR. Stripping every non-digit from a pasted "$1,250,000.00" glues the cents
// on and reads $1.25M as $125M — on the property value, silently, from an ordinary paste.
ok(F.formatMoney('$1,250,000.00') === '1,250,000', 'M6 a pasted figure with cents keeps its WHOLE dollars');
ok(F.formatMoney('$1,250,000') === '1,250,000', 'M7 …and a pasted figure without them is unchanged');
ok(F.toNumber('500,000') === 500000, 'M8 grouped text parses back to the number');
ok(F.toNumber('75%') === 75, 'M9 …and so does a percent');
ok(F.toNumber('abc') === null && F.toNumber('') === null, 'M10 …and anything unreadable is null, never NaN');

// The whole point: a formatted form still puts NUMBERS on the wire.
const grouped = F.toScenario({
  amountMode: 'loan', purpose: 'Purchase', value: '1,250,000', loan: '937,500', fico: '740',
  dscr: '1.20', zip: '11211', propertyType: 'SingleFamily', units: '1', borrowerType: 'LLC',
  lockDays: '30', prepayMonths: '60', prepayStructure: 'Standard',
});
ok(grouped.value === 1250000 && grouped.loan === 937500,
  `M11 a grouped money box reaches the pricer as a number (got ${grouped.value} / ${grouped.loan})`);
ok(Object.values(grouped).every((v) => typeof v !== 'number' || Number.isFinite(v)),
  'M12 …and no key is ever NaN');
// A figure that cannot be read is OMITTED, so the server refuses by name instead of pricing a guess.
const junk = F.toScenario({ value: 'abc', fico: '740', purpose: 'Purchase' });
ok(!('value' in junk), 'M13 an unreadable money box is omitted, never sent as NaN');

/* ── N) THE FIRST-TIME-HOMEBUYER FLAG ──────────────────────────────────────────
   The owner asked for the checkbox to be "connected to the checkbox that we have in the lender
   price". It is the same fact: the route has accepted `fthb` all along and the builder writes it to
   `criteria.firstTimeHomeBuyer` — it had simply never been reachable from a screen. */
const withFthb = F.toScenario({ purpose: 'Purchase', value: '500,000', loan: '375,000', fthb: true });
ok(withFthb.fthb === true, 'N1 a ticked first-time-homebuyer box reaches the scenario');
const withoutFthb = F.toScenario({ purpose: 'Purchase', value: '500,000', loan: '375,000', fthb: false });
ok(!('fthb' in withoutFthb), 'N2 …and an unticked one is omitted, so the vendor default stands');

/* ── P) THE HAND-TYPED STATE AND COUNTY ───────────────────────────────────────
   The escape hatch for a ZIP the Census table cannot resolve. On the ordinary path these are blank,
   and a blank must be omitted ENTIRELY — a supplied-but-empty state would be a value the server has
   to interpret, on the one field that decides which state's rules a loan is priced under. */
const blankLoc = F.toScenario({ purpose: 'Purchase', zip: '11211', state: '', county: '' });
ok(!('state' in blankLoc) && !('county' in blankLoc), 'P1 a blank state/county is omitted entirely');
const typedLoc = F.toScenario({ purpose: 'Purchase', zip: '00501', state: 'NY', county: 'Suffolk' });
ok(typedLoc.state === 'NY' && typedLoc.county === 'Suffolk', 'P2 …and a typed one is carried');

/* ── report ───────────────────────────────────────────────────────────────── */
if (fails.length) {
  console.error(`\nFAILED ${fails.length} of ${pass + fails.length}:`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`test-lt-pricer-fields: ${pass} checks passed`);
