#!/usr/bin/env node
'use strict';
/**
 * THE DRILL-IN'S CROSS-LINKS — the local join, offline.
 *
 * WHY THIS FILE EXISTS. The owner asked for the thing Elementix's own screens
 * do: "when you click on a mortgage, it comes up with the property. When you
 * click on the lender, it comes up. All three should be linked together." The
 * rows PILOT already holds carry the ids that make that free — a mortgage
 * carries `deedId`, `lenderId` and the property's address uuid; a deed carries
 * `mortgageId` — so clicking around costs nothing out of the office's shared
 * 1,000 requests an hour.
 *
 * WHICH IS EXACTLY WHY IT HAS TO BE TESTED. A join that quietly picks the WRONG
 * record renders as an ordinary, confident record page: a purchase price from
 * one property beside a loan amount from another, a lender's whole relationship
 * history attributed to a loan they never made. Nothing throws, nothing looks
 * broken, and an officer repeats the number to a borrower.
 *
 * So: every hop is proven to resolve, every hop is proven to REFUSE rather than
 * guess, and the three spellings the vendor uses for one address are proven to
 * be read as one thing.
 *
 * PURE: no database, no network, no browser, and — because everything here is a
 * cache join — NO VENDOR CALL is even possible.
 *
 * Run: node scripts/test-elementix-record-link-pure.js
 */

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

const MOD = pathToFileURL(path.join(__dirname, '..', 'app-v2', 'src', 'lib', 'elementixRows.js')).href;

let passed = 0;
const ok = (m) => { passed += 1; console.log(`  ✓ ${m}`); };

/* THE SHAPES ARE THE VENDOR'S OWN, spelling included. A mortgage says
   `propertyAddresses[{id, addressFull}]` in camelCase and a deed says
   `property_addresses[{id, address_full}]` in SNAKE_CASE — for the same idea,
   from the same API, on the same person. A reader that knows one spelling finds
   the property on the mortgages tab and nothing at all on the deeds tab, which
   is a silent half-broken feature, so both are fixtures here. */
const MORTGAGE = {
  id: 'm1', lenderId: 'l1', deedId: 'd1', satisfactionId: 's1',
  recordingDate: '2021-03-02', mortgageAmount: '380000.00', deedConsideration: '475000.00',
  lenderName: 'Roc Capital', lenderType: 'Private Money', loanTermMonths: 12,
  propertyAddresses: [{ id: 'a1', addressFull: '14 MAPLE ST, TEANECK, NJ 07666' }],
  entityBorrowers: [{ id: 'e1', name: 'MAPLE HOLDINGS LLC', type: 'COMPANY', state: 'NJ' }],
  city: 'Teaneck', countyName: 'Bergen', countyState: 'NJ', zipCode: '07666',
  countyDocumentId: '2021-041183',
};
const DEED = {
  id: 'd1', mortgageId: 'm1', recordingDate: '2021-03-02', totalConsideration: 475000,
  grantors: ['SELLER LLC'], grantees: ['MAPLE HOLDINGS LLC'], isCashPurchase: false,
  property_addresses: [{ id: 'a1', address_full: '14 MAPLE ST, TEANECK, NJ 07666' }],
};
const OWNERSHIP = {
  id: 'p1', addressId: 'a1', addressFull: '14 MAPLE ST, TEANECK, NJ 07666',
  startDate: '2021-03-02', endDate: '2022-01-19', totalConsideration: 475000, soldConsideration: 610000,
  deedId: 'd1', propertyUseCategory: 'SINGLE_FAMILY',
};
const LENDER = { id: 'l1', name: 'Roc Capital / Roc360', lenderType: 'Private Money', mortgageCount: 47, totalVolume: 27208850 };
/* A SECOND property, so every "it found the right one" below is a real choice
   rather than the only row in the list. */
const OTHER_MORTGAGE = { id: 'm2', lenderId: 'l9', recordingDate: '2019-01-01', mortgageAmount: '1.00',
  propertyAddresses: [{ id: 'a9', addressFull: '9 OTHER RD, NEWARK, NJ 07102' }] };
const OTHER_DEED = { id: 'd9', recordingDate: '2019-01-01', property_addresses: [{ id: 'a9', address_full: '9 OTHER RD' }] };
const OTHER_OWNERSHIP = { id: 'p9', addressId: 'a9', startDate: '2019-01-01' };

const PROFILE = {
  sections: {
    mortgages: { rows: [OTHER_MORTGAGE, MORTGAGE] },
    deeds: { rows: [OTHER_DEED, DEED] },
    properties: { rows: [OTHER_OWNERSHIP, OWNERSHIP] },
    lender_network: { rows: [{ id: 'l9', name: 'Somebody Else Bank' }, LENDER] },
  },
};

(async () => {
  const R = await import(MOD);

  console.log('\n1. ONE ADDRESS, THREE SPELLINGS');
  {
    assert.strictEqual(R.addressIdOf(MORTGAGE), 'a1', 'camelCase propertyAddresses');
    assert.strictEqual(R.addressIdOf(DEED), 'a1', 'snake_case property_addresses');
    assert.strictEqual(R.addressIdOf(OWNERSHIP), 'a1', 'a bare addressId');
    assert.strictEqual(R.addressIdOf({ addressesIds: ['a1'] }), 'a1', 'the flat id list');
    ok('all three of the vendor’s spellings read as the same address');

    assert.strictEqual(R.addressIdOf({}), null, 'a row with no address says so');
    assert.strictEqual(R.addressIdOf(null), null, 'and so does nothing at all');
    assert.strictEqual(R.addressIdOf({ propertyAddresses: [{ addressFull: 'somewhere' }] }), null,
      'an address with no id is not an id');
    ok('…and a row that cannot name an address returns null, never a guess');
  }

  console.log('\n2. THE HOPS THE OWNER ASKED FOR');
  {
    const d = R.recordDetail(MORTGAGE, 'mortgages', PROFILE);
    assert.ok(d, 'a mortgage row resolves');
    assert.strictEqual(d.deed && d.deed.id, 'd1', 'mortgage → deed, by deedId');
    assert.strictEqual(d.ownership && d.ownership.id, 'p1', 'mortgage → the property, by address');
    assert.strictEqual(d.lender && d.lender.id, 'l1', 'mortgage → lender, by lenderId');
    assert.strictEqual(d.place.line, '14 MAPLE ST, TEANECK, NJ 07666', 'and it knows where it is');
    assert.strictEqual(d.place.area, 'Teaneck, Bergen County, NJ, 07666', '…in as much detail as the row carries');
    assert.strictEqual(d.entities[0].name, 'MAPLE HOLDINGS LLC', 'and which company holds it');
    assert.strictEqual(d.countyDocumentId, '2021-041183', 'and the number the county filed it under');
    ok('click a mortgage: the property, the deed, the lender and the company all come with it');

    const fromDeed = R.recordDetail(DEED, 'deeds', PROFILE);
    assert.strictEqual(fromDeed.mortgage && fromDeed.mortgage.id, 'm1', 'deed → mortgage, by mortgageId');
    assert.strictEqual(fromDeed.ownership && fromDeed.ownership.id, 'p1', 'deed → the property');
    ok('click a deed: the loan that paid for it comes with it');

    const fromProp = R.recordDetail(OWNERSHIP, 'properties', PROFILE);
    assert.strictEqual(fromProp.deed && fromProp.deed.id, 'd1', 'property → deed');
    assert.strictEqual(fromProp.ownership && fromProp.ownership.id, 'p1', 'the property is its own ownership record');
    assert.strictEqual(fromProp.alsoMortgages.length, 1, 'and the loans recorded against it are listed');
    assert.strictEqual(fromProp.alsoMortgages[0].id, 'm1', '…the right ones');
    ok('click a property: its deed and every loan recorded against it come with it');
  }

  console.log('\n3. IT PICKS THE RIGHT RECORD, NOT THE FIRST ONE');
  {
    const other = R.recordDetail(OTHER_MORTGAGE, 'mortgages', PROFILE);
    assert.strictEqual(other.ownership && other.ownership.id, 'p9', 'the other property, not the first in the list');
    assert.strictEqual(other.deed, null, 'that mortgage names no deed, so none is shown');
    assert.strictEqual(other.alsoDeeds.length, 1, 'the deed at ITS address is listed separately');
    assert.strictEqual(other.alsoDeeds[0].id, 'd9', '…and it is the right one');
    ok('a second property resolves to its own records — the join is by id, not by position');

    const d = R.recordDetail(MORTGAGE, 'mortgages', PROFILE);
    assert.ok(!d.alsoMortgages.some((m) => m.id === 'm1'), 'the row you opened is never listed under itself');
    assert.ok(!d.alsoDeeds.some((x) => x.id === 'd1'), '…nor is the deed already shown above');
    ok('nothing is shown twice on one record');
  }

  console.log('\n4. IT REFUSES RATHER THAN GUESSES');
  {
    const empty = { sections: {} };
    const d = R.recordDetail(MORTGAGE, 'mortgages', empty);
    assert.strictEqual(d.deed, null, 'no deeds read → no deed shown');
    assert.strictEqual(d.ownership, null, 'no properties read → no property shown');
    assert.strictEqual(d.lender, null, 'no lender network read → no lender shown');
    assert.deepStrictEqual(d.alsoMortgages, [], 'and nothing invented at the address');
    ok('a section that was never read produces an ABSENT link, never a wrong one');

    const noId = R.recordDetail({ id: 'x', deedId: 'nope' }, 'mortgages', PROFILE);
    assert.strictEqual(noId.deed, null, 'a deedId matching nothing resolves to nothing');
    assert.strictEqual(noId.ownership, null, 'and a row with no address matches no property');
    ok('an id that matches nothing is not quietly matched to something');

    assert.strictEqual(R.recordDetail(null, 'mortgages', PROFILE), null, 'no row, no record');
    assert.strictEqual(R.recordDetail('nonsense', 'mortgages', PROFILE), null, 'and nothing that is not a row');
    ok('…and it never throws on a shape it did not expect');
  }

  console.log('\n5. THE LENDER ROLL-UP ONLY SPEAKS WHEN BOTH SIDES AGREE');
  {
    // THE HAZARD: "47 loans totalling $27m from Roc Capital" printed under a
    // mortgage recorded by somebody else is a sentence an officer repeats.
    assert.ok(R.lenderNamesAgree('Roc Capital / Roc360', 'Roc Capital', ''),
      'the directory name and the recorded name are the same lender');
    assert.ok(R.lenderNamesAgree('ROC CAPITAL', 'Roc Capital, LLC', ''), 'casing and punctuation are not a disagreement');
    assert.ok(R.lenderNamesAgree('Alpha Funding', '', 'Alpha Funding Solutions'), 'the county’s alias counts too');
    assert.ok(!R.lenderNamesAgree('CoreVest Finance', 'Alpha Funding', ''), 'two different lenders do NOT agree');
    assert.ok(!R.lenderNamesAgree('', 'Alpha Funding', ''), 'an unnamed directory row cannot vouch for anything');
    ok('the name check accepts an alias and refuses a different lender');

    const crossed = {
      sections: { ...PROFILE.sections, lender_network: { rows: [{ id: 'l1', name: 'CoreVest Finance', mortgageCount: 39 }] } },
    };
    const d = R.recordDetail(MORTGAGE, 'mortgages', crossed);
    assert.strictEqual(d.lender, null,
      'a lender id resolving to a DIFFERENT name is dropped rather than printed');
    ok('a crossed lender join shows nothing at all — never another lender’s history');
  }

  console.log('\n6. A LENDER AND A COMPANY ARE SUBJECTS TOO');
  {
    // "When you click on the lender, it comes up" — half the owner's request.
    // Opening one used to draw an almost empty card, because a lender has no
    // address and is not a mortgage. Their loans are a filter over rows we
    // already hold, so this costs nothing either.
    const d = R.recordDetail(LENDER, 'lender_network', PROFILE);
    assert.strictEqual(d.loansFrom.length, 1, 'the loans THIS borrower took from that lender');
    assert.strictEqual(d.loansFrom[0].id, 'm1', '…the right ones, by lenderId');
    assert.deepStrictEqual(d.heldHere, [], 'and a lender holds no company records');
    ok('opening a lender shows what this borrower took from them');

    const other = R.recordDetail({ id: 'l9', name: 'Somebody Else Bank' }, 'lender_network', PROFILE);
    assert.strictEqual(other.loansFrom.length, 1, 'a different lender resolves to a different loan');
    assert.strictEqual(other.loansFrom[0].id, 'm2', '…by id, not by position');
    ok('two lenders never share each other’s loans');

    const ent = R.recordDetail({ id: 'e1', name: 'MAPLE HOLDINGS LLC' }, 'entities', PROFILE);
    const kinds = ent.heldHere.map((x) => x.section).sort();
    assert.deepStrictEqual(kinds, ['mortgages'], 'the company’s own records, from every section that names it');
    assert.strictEqual(ent.heldHere[0].row.id, 'm1', '…and the right record');
    assert.deepStrictEqual(ent.loansFrom, [], 'and a company is not a lender');
    ok('opening a company shows the deals recorded in it');

    const nobody = R.recordDetail({ id: 'e-none', name: 'A COMPANY WITH NOTHING' }, 'entities', PROFILE);
    assert.deepStrictEqual(nobody.heldHere, [], 'a company nothing names holds nothing — not everything');
    const mort = R.recordDetail(MORTGAGE, 'mortgages', PROFILE);
    assert.deepStrictEqual(mort.loansFrom, [], 'and a mortgage is never given a lender’s list');
    assert.deepStrictEqual(mort.heldHere, [], '…nor a company’s');
    ok('every other kind of row gets neither list — the panel is not padded');
  }

  console.log('\n7. HOW LONG THEY HELD IT');
  {
    assert.strictEqual(R.holdPeriod('2021-03-02', '2022-01-19'), '10.6 months', 'months for under two years');
    assert.strictEqual(R.holdPeriod('2015-01-01', '2020-01-01'), '5 years', 'years beyond that, without a trailing .0');
    assert.strictEqual(R.holdPeriod('2021-03-02', null), null, 'a property still held has no hold PERIOD yet');
    assert.strictEqual(R.holdPeriod(null, '2022-01-19'), null, 'and one with no start date cannot be measured');
    assert.strictEqual(R.holdPeriod('2022-01-19', '2021-03-02'), null, 'a sale before the purchase is refused, not negative');
    assert.strictEqual(R.holdPeriod('rubbish', '2022-01-19'), null, 'and unreadable dates say nothing');
    ok('the hold period is measured or absent — never estimated');
  }

  console.log(`\n${passed} checks passed — every hop resolves, and every one of them refuses rather than guesses.\n`);
})().catch((e) => { console.error('\nFAILED:', e && e.message); console.error(e && e.stack); process.exit(1); });
