#!/usr/bin/env node
'use strict';
/**
 * LT PPE — ONE FUNCTION WAS DOING TWO JOBS: the frame conversion and the input sanitizer (§2.117).
 *
 * `client.num` stripped every non-digit, INCLUDING the minus sign. On an ADJUSTMENT that is not a bug
 * and must not be "fixed": Lender Price states an adjustment CHARGE-POSITIVE and our rate sheet states
 * the same adjustment PREMIUM-POSITIVE, so taking the magnitude IS the conversion between the two
 * frames — measured family by family, and enforced by `test-lt-ppe-llpa-sign-frames.js` (§2.104).
 *
 * The SAME function also read every input fact — fico, dscr, loan amount, property value, prepay
 * months, a monthly payment. None of those is ever negative, so the two jobs coincided and nothing
 * broke. What that coincidence hid is the failure mode: a negative arriving on an INPUT was silently
 * turned positive. A loan amount of −500,000 priced as +500,000; a garbage DSCR of −1.25 priced as a
 * healthy 1.25. That is fail-open on money, and no suite could have caught it — the sign-frame suite
 * only covers adjustment families, by design.
 *
 * So the conversion is now named (`magnitude`, reachable from the four adjustment call sites and
 * nothing else) and `num` REFUSES a sign it should never see. This suite pins the three things that
 * makes true: the conversion still converts, on REAL captured vendor data; the refusal is real; and
 * nothing else moved — every non-negative input parses byte-for-byte as it did before.
 *
 *   node scripts/test-lt-ppe-vendor-sign-split.js
 */
const fs = require('fs');
const path = require('path');
const client = require('../src/longterm/lenderprice/client');
const { mapPrepay, num, magnitude } = client._internals;

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }
const readFix = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8'));

console.log('LT PPE — vendor sign split (magnitude vs num) — offline\n');

// The function EXACTLY as it stood before the split. Kept here, in the test, so the equivalence claim
// is measured against the old behaviour rather than asserted about it — and so that reading this file
// tells you what changed.
function oldNum(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
  return isFinite(n) ? n : null;
}

// ---- A. THE CONVERSION STILL CONVERTS, ON REAL CAPTURED DATA -------------------------------------
// Not a hand-typed −0.25: the value is read out of the live capture that recorded it.
{
  const fx = readFix('lp-dscr-band-containers.json');
  const negs = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    for (const [k, v] of Object.entries(n)) {
      if ((k === 'llpa' || k === 'adj') && typeof v === 'number' && v < 0) negs.push({ key: n.key || null, value: v });
      else walk(v);
    }
  })(fx);
  ok(negs.length > 0, `A1 the live capture really does carry NEGATIVE adjustments — found ${negs.length}`);
  const sample = negs[0];
  ok(sample.value === -0.25, `A2 …and the one this was found on is −0.25 — got ${sample.value}`);

  // Drive it through the REAL parser, in the shape the vendor sends, so what is proven is the parse
  // path and not a helper called directly.
  const leaf = {
    companyName: 'Deephaven Mortgage',
    programName: 'DSCR >= 1.25  -  30 Yr Fixed',
    rate: 7.5,
    adjustedPoints: 1.25,
    groupAdjustmentProperties: [
      { name: 'DSCR', adjustments: negs.map((n) => ({ key: n.key || 'DSCR Ratio', llpa: n.value })) },
    ],
  };
  const raw = { results: { qualifiedNonQMData: { type: 'LenderKey', keyLabel: 'Deephaven Mortgage', leafs: [leaf] } } };
  const parsed = client.parseFull(raw);
  const opt = parsed.programs[0] && parsed.programs[0].options[0];
  ok(!!opt, 'A3 the minimal vendor envelope parses to one priced option');
  const values = opt.adjustments.map((a) => a.value);
  ok(values.length === negs.length && values.every((v) => v > 0),
    `A4 every NEGATIVE captured adjustment reads back POSITIVE — the frame conversion, intact — got ${JSON.stringify(values)}`);
  ok(values[0] === Math.abs(sample.value), `A5 …at exactly its magnitude — ${values[0]} for ${sample.value}`);

  // And a POSITIVE adjustment is untouched, or "magnitude" would be indistinguishable from "negate".
  const pos = { ...leaf, groupAdjustmentProperties: [{ name: 'FICO', adjustments: [{ key: 'FICO 660-679', llpa: 1.125 }] }] };
  const parsedPos = client.parseFull({ results: { qualifiedNonQMData: { type: 'LenderKey', keyLabel: 'L', leafs: [pos] } } });
  ok(parsedPos.programs[0].options[0].adjustments[0].value === 1.125,
    'A6 a POSITIVE adjustment is carried through unchanged — the conversion takes a magnitude, it does not negate');
}

// ---- B. THE REFUSAL — the failure the coincidence was hiding ------------------------------------
{
  ok(oldNum(-500000) === 500000 && oldNum('-1.25') === 1.25,
    'B1 the OLD reader turned a negative input into a positive one — this is what was fixed');
  ok(num(-500000) === null && num('-1.25') === null && num('(0.25)') === null,
    'B2 the input reader now REFUSES a sign it should never see — a minus, and an accounting parenthesis');

  // Through the real builder this reader feeds. A refused value must land as NULL — never as its own
  // magnitude, and never as a number derived from it.
  const good = client.buildSearchPayload({ purpose: 'Purchase', value: 500000, loan: 350000, fico: 760, dscr: 1.25 });
  const bad = client.buildSearchPayload({ purpose: 'Purchase', value: -500000, loan: 350000, fico: 760, dscr: 1.25 });
  ok(good.criteria.purchasePrice === 500000 && good.criteria.ltv === 0.7, 'B3 a good scenario is unchanged — price 500,000, LTV 0.70');
  ok(bad.criteria.purchasePrice === null, `B4 a NEGATIVE property value lands as null, not 500,000 — got ${bad.criteria.purchasePrice}`);
  ok(bad.criteria.ltv === null, `B5 …and the LTV derived from it is null too, never a ratio computed off a sign-flipped value — got ${bad.criteria.ltv}`);

  // ⛔ WHAT THIS DOES **NOT** CLOSE, stated so nobody reads more into it. The LIVE request builder is
  // `buildSearch`, which reads its facts through `search-model.num` — a sign-PRESERVING parser fixed
  // separately (§27.10) — and then validates. So the live request path was never exposed to this; what
  // was exposed is `buildSearchPayload` (the decoded field-mapping builder) and the monthly-payment
  // read in the parse path. This closes the second door, not the first, and the first was already shut.
  const live = client.buildSearch({ purpose: 'Purchase', value: -500000, loan: 350000, fico: 760, dscr: 1.25, state: 'NY', zip: '11211' });
  ok(live.criteria.purchasePrice === -500000,
    'B6 the LIVE builder carries the negative through to its own validator UNCHANGED — it never went through this reader');
}

// ---- C. NOTHING ELSE MOVED — equivalence over every shape a vendor or caller actually sends -------
{
  // Real shapes: the vendor's prepay term is TEXT with the number inside it, money arrives formatted,
  // and percentages carry their sign-free symbol. Every one of these must parse exactly as before.
  const battery = [
    500000, 350000, 760, 1.25, 0, 0.0, '0', '500000', '350000.00', '$1,250.50', '1,250', '80%',
    '60 Months', '36 Months', 'No Prepay', '7.125', '  7.125  ', '', null, undefined, 'abc',
    1e6, '1250.5', '.75', '100.000',
  ];
  let same = 0;
  const drift = [];
  for (const v of battery) {
    const a = oldNum(v);
    const b = num(v);                    // the REAL shipped reader, not a copy of it written here
    if (a === b || (a == null && b == null)) same += 1; else drift.push({ v, old: a, now: b });
  }
  ok(drift.length === 0, `C1 every non-negative shape parses identically — ${same}/${battery.length} same, drift ${JSON.stringify(drift)}`);
  // …and the conversion is byte-identical to what `num` used to be, on the same battery — which is what
  // makes "the adjustment path did not move" a measurement rather than a claim.
  const magDrift = battery.filter((v) => {
    const a = oldNum(v); const b = magnitude(v);
    return !(a === b || (a == null && b == null));
  });
  ok(magDrift.length === 0, `C1b the frame conversion IS the old reader, unchanged — drift ${JSON.stringify(magDrift)}`);
  // The one place they now differ, stated directly.
  ok(num(-0.25) === null && magnitude(-0.25) === 0.25,
    'C1c the two disagree on exactly one thing: a negative. The conversion takes it; the input reader refuses it');

  // The one that would have been a silent regression: "60 Months". A strict sign-preserving parser
  // (the kind search-model.js correctly uses to BUILD a payload) returns null for it, which would turn
  // every prepay term into "No PPP". The split deliberately keeps the lenient extraction.
  ok(mapPrepay('60 Months').ppp === '5 Yr PPP',
    'C2 "60 Months" still reads as a 5-year prepay — the lenient extraction was kept on purpose');
  ok(mapPrepay(36).ppp === '3 Yr PPP', 'C3 …and a bare number still works');
  ok(mapPrepay('No Prepay').ppp === 'No PPP', 'C4 …and a term with no number in it is No PPP, not a guess');
  // A NEGATIVE month count is garbage and must not become a prepay term.
  ok(mapPrepay('-60').ppp === 'No PPP', 'C5 a negative month count is refused, not read as 60');
}

console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
process.exit(failures ? 1 : 0);

/* ---------------------------------------------------------------------------------------------
 * MUTATION LOG — each applied on its own to src/longterm/lenderprice/client.js, control green either
 * side.
 *   M1  magnitude: `return digitsOnly(v)` → return the SIGNED value   → A fails (the frame flips)
 *   M2  magnitude: negate instead of taking the magnitude             → A6 fails (a charge becomes a credit)
 *   M3  num: drop the sign refusal                                    → B fails (the pre-fix state)
 *   M3b magnitude: refuse a negative too (i.e. undo the split)        → A4 fails (the conversion gone)
 *   M4  num: use a STRICT sign-preserving parse (search-model's)      → C2 fails ("60 Months" → No PPP,
 *                                                                       the silent regression this
 *                                                                       split was careful to avoid)
 * ------------------------------------------------------------------------------------------- */
