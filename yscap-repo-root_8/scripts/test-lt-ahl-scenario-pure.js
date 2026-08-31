#!/usr/bin/env node
'use strict';
/**
 * AHL — the request is the loan AHL SAYS IT PRICED (pure, offline).
 *
 * WHY THIS IS THE TEST AND NOT A LIST OF ASSERTIONS. A form post is silent about
 * everything it did not like: a misspelled field name is DROPPED, a value the
 * page does not offer is IGNORED and the control falls back to its own default.
 * Neither shows up in the HTTP status. So "it returned 200" proves nothing about
 * which loan was priced, and any assertion of the form "does the body carry a
 * FICO?" is the builder restated in a second place — it passes whenever the
 * builder and the test agree, INCLUDING when both are wrong.
 *
 * AHL re-renders its whole form with the submitted scenario marked `selected` /
 * `checked`. That is the VENDOR stating which loan it just priced. Every fixture
 * in `capture/` is a real answer to a body this builder produced, so comparing
 * the two is a round trip against AHL rather than against ourselves.
 *
 * PROVEN TO FAIL: pin `InterestOnly` to a constant and LEG-2 goes red; drop the
 * prepay coupling and PREPAY-2 goes red; let an unknown enum default instead of
 * throwing and FAILCLOSED-* go red; remove the DocType wall and WALL-1 goes red;
 * emit `Units` as a band instead of the count and UNITS-1 goes red.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const fs = require('fs');
const path = require('path');
const scenario = require('../src/longterm/ahl/scenario');
const parse = require('../src/longterm/ahl/parse');
const registry = require('../src/longterm/ahl/field-registry');
const captured = require('../src/longterm/ahl/capture/legs.json');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass += 1; console.log(`  ok   ${msg}`); } else { fail += 1; console.log(`  FAIL ${msg}`); } }
const CAP = path.join(__dirname, '..', 'src', 'longterm', 'ahl', 'capture');
const read = (f) => fs.readFileSync(path.join(CAP, f), 'utf8');
function refuses(fn, code) { try { fn(); return false; } catch (e) { return e && e.code === code; } }

(async () => {
  console.log('\nAHL — the request AHL says it received\n');

  // ── ECHO: the vendor's own account of the loan it priced ──────────────────
  {
    let legsChecked = 0, mismatches = [];
    for (const [key, rec] of Object.entries(captured.legs)) {
      const echo = parse.echoedScenario(read(rec.file));
      const sent = Object.fromEntries(rec.body);
      for (const [k, v] of Object.entries(sent)) {
        if (echo[k] === undefined) continue;      // AHL does not echo every control
        if (String(echo[k]) !== String(v)) mismatches.push(`${key}.${k}: sent ${JSON.stringify(v)}, AHL echoed ${JSON.stringify(echo[k])}`);
      }
      legsChecked += 1;
    }
    ok(legsChecked === 4, `ECHO-0 all four captured product legs are present (${legsChecked})`);
    ok(mismatches.length === 0, `ECHO-1 every field AHL echoes back matches what we sent${mismatches.length ? ` — ${mismatches.slice(0, 3).join('; ')}` : ''}`);
  }

  // ── The body we build TODAY is still the body those fixtures answered ─────
  {
    const built = scenario.build(captured.scenario, { channel: captured.channel });
    const byKey = Object.fromEntries(built.legs.map((l) => [l.key, scenario.encode(l.body)]));
    const drift = [];
    for (const [key, rec] of Object.entries(captured.legs)) {
      const then = scenario.encode(rec.body);
      if (byKey[key] !== then) drift.push(key);
    }
    ok(drift.length === 0, `BODY-1 the builder still produces the exact body each captured answer was given${drift.length ? ` — drifted: ${drift.join(', ')}` : ''}`);
  }

  // ── The fan-out: AHL's DSCR shelf is two products, not one ────────────────
  {
    const legs = scenario.legsFor({ purpose: 'cashout', value: 500000, loan: 350000, fico: 760, state: 'CT' });
    const shapes = legs.map((l) => `${l.termYears}${l.interestOnly ? 'io' : 'fix'}@${l.lockDays}`).sort();
    ok(shapes.length === 4 && shapes.join(',') === '30fix@30,30fix@45,40io@30,40io@45',
      `LEG-1 an unpinned scenario asks for AHL's WHOLE shelf — both products at both locks (${shapes.join(', ')})`);

    // The IO pairing is the vendor's, and it is derived per term rather than pinned.
    const io40 = scenario.legsFor({ purpose: 'purchase', value: 1, loan: 1, fico: 700, state: 'CT', termYears: 40 });
    const fix30 = scenario.legsFor({ purpose: 'purchase', value: 1, loan: 1, fico: 700, state: 'CT', termYears: 30 });
    ok(io40.every((l) => l.interestOnly === true) && fix30.every((l) => l.interestOnly === false),
      'LEG-2 AHL pairs its 40-year with interest-only and its 30-year without it — measured, and applied per term rather than pinned');

    ok(refuses(() => scenario.legsFor({ termYears: 40, io: false, value: 1, loan: 1, fico: 700, state: 'CT', purpose: 'purchase' }), 'unsupported_interest_only'),
      'LEG-3 an amortizing 40-year is REFUSED by name, not answered with an empty board that would read as AHL declining');
    ok(refuses(() => scenario.legsFor({ termYears: 15, value: 1, loan: 1, fico: 700, state: 'CT', purpose: 'purchase' }), 'unsupported_term'),
      'LEG-4 a term AHL does not offer on its DSCR shelf is refused rather than silently priced at a different one');

    // Derived from AHL's own form, never a list kept in our code.
    const terms = registry.termsForDocType('Investor - DSCR');
    ok(terms && terms.terms.join(',') === '30,40',
      "LEG-5 the shelf's terms come from AHL's own option classes (loanTerm3040yr), not from a list of ours");
  }

  // ── The wall: this adapter may never price the short-term product ─────────
  {
    const base = { purpose: 'purchase', value: 500000, loan: 350000, fico: 760, state: 'CT' };
    ok(refuses(() => scenario.build({ ...base, docType: 'Investor - No Ratio' }), 'rtl_product_refused'),
      "WALL-1 AHL's Bridge / Rehab / Ground-Up shelf is refused BY NAME — it is the short-term product and a separate system");
    ok(refuses(() => scenario.build({ ...base, docType: 'Full Doc' }), 'non_dscr_product_refused'),
      'WALL-2 any other income-verification type is refused too — the wall is a positive pin, not a blocklist of one');
    const built = scenario.build(base);
    ok(built.legs.every((l) => Object.fromEntries(l.body).DocType === 'Investor - DSCR'),
      'WALL-3 every leg of every build carries the DSCR pin');
  }

  // ── Prepay: the coupling is the vendor's, and it moves half a point ───────
  {
    ok(JSON.stringify(scenario.prepayFields(0)) === JSON.stringify({ PrepayPenaltyPeriod: '0', PrepayPenaltyType: '' }),
      "PREPAY-1 no penalty sends period 0 AND type empty — AHL's own pairing");
    const five = scenario.prepayFields(60, {});
    ok(five.PrepayPenaltyPeriod === '5' && five.PrepayPenaltyType === 'Fixed Percentage',
      'PREPAY-2 the standing five-year profile reaches AHL as 5 years with a type, never as a bare period');
    ok(refuses(() => scenario.prepayFields(18, {}), 'unsupported_prepay_term'),
      'PREPAY-3 a term AHL cannot express in whole years is refused, never truncated to a cheaper one');
    ok(scenario.prepayFields(36, { prepayStructure: 'declining' }).PrepayPenaltyType === 'Declining Structure',
      'PREPAY-4 the declining structure is available and named');
    ok(refuses(() => scenario.prepayFields(36, { prepayStructure: 'soft' }), 'unknown_prepay_structure'),
      'PREPAY-5 a structure AHL does not offer is refused rather than defaulted to the fixed one');

    // The DEFAULT is the shared profile's, not a number of this adapter's own.
    const built = scenario.build({ purpose: 'purchase', value: 500000, loan: 350000, fico: 760, state: 'CT' });
    const b = Object.fromEntries(built.legs[0].body);
    ok(b.PrepayPenaltyPeriod === '5' && b.PrepayPenaltyType === 'Fixed Percentage',
      "PREPAY-6 a scenario that says nothing about prepay still reaches AHL with the shared DSCR profile's five years — sending nothing costs half a point of rate");
  }

  // ── Units: AHL's property type IS the unit count ─────────────────────────
  {
    const three = scenario.propertyAndUnits({ propertyType: 'duplex', units: 3 });
    ok(three.PropertyType === '3' && three.Units === '3',
      'UNITS-1 a 2-4 unit property is sent as the COUNT, which is what AHL\'s own PropertyType offers');
    ok(refuses(() => scenario.propertyAndUnits({ propertyType: '2-4 units' }), 'units_required'),
      'UNITS-2 a 2-4 unit property with no count is refused — AHL prices 2, 3 and 4 differently, so guessing would price the cheaper building');
    const sfd = scenario.propertyAndUnits({ propertyType: 'SingleFamily' });
    ok(sfd.PropertyType === 'SFD' && sfd.Units === '1', 'UNITS-3 a single-family with no count is one unit');
  }

  // ── Fail closed: nothing is ever defaulted onto the wire ─────────────────
  {
    const base = { purpose: 'purchase', value: 500000, loan: 350000, fico: 760, state: 'CT' };
    ok(refuses(() => scenario.build({ ...base, purpose: 'construction' }), 'unknown_purpose'),
      'FAILCLOSED-1 an unknown loan purpose is refused by name');
    ok(refuses(() => scenario.build({ ...base, propertyType: 'houseboat' }), 'unknown_property_type'),
      'FAILCLOSED-2 an unknown property type is refused by name');
    ok(refuses(() => scenario.build({ ...base, citizenship: 'martian' }), 'unknown_citizenship'),
      'FAILCLOSED-3 an unknown citizenship is refused by name');
    ok(refuses(() => scenario.build({ ...base, fico: null }), 'fico_required'),
      'FAILCLOSED-4 a scenario with no credit score is refused — every AHL program prices off one');
    ok(refuses(() => scenario.build({ ...base, state: '' }), 'state_required'),
      'FAILCLOSED-5 a scenario with no state is refused — AHL prices by jurisdiction');
    ok(refuses(() => scenario.build({ purpose: 'purchase', value: 500000, fico: 760, state: 'CT' }), 'insufficient_amounts'),
      'FAILCLOSED-6 one figure of the amount triangle alone is refused, never completed with a default');
    ok(refuses(() => registry.assertOption('PropertyType', 'Duplex'), 'unknown_option'),
      "FAILCLOSED-7 a value AHL's own form does not offer is refused before the wire — a form post accepts it silently and prices something else");
    ok(refuses(() => registry.assertOption('PropZipCode', '06105'), 'unknown_field'),
      'FAILCLOSED-8 a field name AHL does not have is refused too — a misspelled field is DROPPED by a form post, invisibly');
  }

  // ── The channel: a business decision, refused rather than guessed ────────
  {
    ok(scenario.channelFor({}) === 'CorrNonDel' && scenario.OWNER_CHANNEL === 'CorrNonDel',
      'CHANNEL-1 the default is CorrNonDel — owner-directed 2026-08-31, the channel we buy through');
    ok(scenario.channelFor({ channel: 'wholesale' }) === 'Wholesale', 'CHANNEL-2 it is settable per call');
    ok(refuses(() => scenario.channelFor({ channel: 'retail' }), 'unknown_channel'),
      'CHANNEL-3 a channel AHL does not price is refused — the three that exist price DIFFERENTLY, so a default would be a silent business decision');
  }

  // ── The money rules are the shared ones, in the shared direction ─────────
  {
    const amounts = require('../src/longterm/pricing/amounts');
    ok(amounts.dscrString(1.299) === '1.29', 'MONEY-1 a DSCR is cut DOWN — a higher ratio prices better, so the safe error is downward');
    ok(amounts.dscrString(0.004) === '0.01', 'MONEY-2 a real ratio under a cent still says one EXISTS rather than becoming "no ratio"');
    ok(amounts.ltvString(0.800002) === '80.01', 'MONEY-3 an LTV is lifted — a higher band prices worse, so the safe error is upward');
    ok(amounts.ltvString(0.70) === '70.00', 'MONEY-4 an LTV exactly on a tier is UNMOVED (the float guard), not pushed a band worse');
    const built = scenario.build({ purpose: 'purchase', value: 500000, loan: 350000, fico: 760, state: 'CT', dscr: 1.299 });
    ok(Object.fromEntries(built.legs[0].body).DSCR === '1.29', 'MONEY-5 the cut-down DSCR is what actually reaches AHL');
    // AHL derives LTV itself from value + loan, so we deliberately send neither.
    const keys = built.legs[0].body.map(([k]) => k);
    ok(!keys.includes('LTV') && !keys.includes('CLTV') && !keys.includes('GrossLoanAmount'),
      'MONEY-6 LTV/CLTV are NOT sent — AHL derives them from value and loan, so there is no second place for them to disagree');
  }

  console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
})();
