'use strict';
/**
 * Pure test for the AppraisalScope JOB TYPE ADD-ONS — the lookup that was answering
 * nothing, and the selection it feeds. No DB, no network.
 *
 * WHAT WAS WRONG. `GetJobTypeAddOns` sat in `lookups.js`'s account-wide LOOKUP_TYPES
 * list, so it was built by the generic `cdg.buildLookup`, which sends no `products`
 * at all. Their own sample request carries `products[0].productcode` — the FORM you
 * are asking about — so the refresh was asking an unanswerable question on every
 * cycle. `refreshAll` is best-effort, so the failure landed in a `failed[]` array
 * nobody reads: nothing errored, nothing was logged, and no screen ever showed an
 * add-on.
 *
 * WHY IT MATTERS. The ids it returns are the SAME ids an order carries as
 * `products[].subproducts[].identifier` (mapping workbook, Request row 4 —
 * "Additional Products", Optional on CreateAppraisal / AddForm / UpdateAppraisal),
 * which this codebase has been able to SEND since the integration was written. The
 * missing half was any way to find out what the codes are, so an add-on could only
 * be ordered by somebody who already knew its number.
 */
const fs = require('fs');
const path = require('path');
const cdg = require('../src/amc/cdg');
const lookups = require('../src/amc/lookups');
const addOns = require('../src/amc/add-ons');

const SAMPLES = path.join(__dirname, '../docs/vendor/appraisalscope/samples/Lookups');
const readSample = (n) => JSON.parse(fs.readFileSync(path.join(SAMPLES, n), 'utf8'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// ---- the request matches the vendor's own sample ---------------------------
(() => {
  const sample = readSample('CDG JSON getjobtypeaddons request.json').message;
  const built = cdg.buildJobTypeAddOns({ apiKey: 'KEY123', subdomain: 'integrations.uat', productCode: '131' }).message;

  eq(built.requestActionType, sample.requestActionType, 'the action is GetJobTypeAddOns');
  ok(Array.isArray(built.products), 'products is an array, as the sample has it');
  // THE FIELD NAME IS THE VENDOR'S, lower-case 'c' — the spelling they use on this
  // action and on CheckFHA, and the whole reason the generic lookup answered nothing.
  eq(built.products[0].productcode, sample.products[0].productcode, 'the form rides on products[0].productcode');
  eq(built.products[0].productCode, undefined, 'no second spelling is invented here — the sample has one');
  eq(cdg.refValue(built.clientSystem.referenceIdentifiers, 'ApiKey'), 'KEY123', 'the api key is on the envelope');
  eq(cdg.refValue(built.serviceProviderSystem.referenceIdentifiers, 'ServiceProviderSubDomain'),
    cdg.refValue(sample.serviceProviderSystem.referenceIdentifiers, 'ServiceProviderSubDomain'), 'the subdomain matches the sample');

  eq(cdg.buildJobTypeAddOns({ apiKey: 'K', subdomain: 's', productCode: 1004 }).message.products[0].productcode, '1004',
    'a numeric form code is sent as a string');
  eq(cdg.buildJobTypeAddOns({ apiKey: 'K', subdomain: 's' }).message.products[0].productcode, '',
    'a missing form is an empty string, never the literal "undefined"');
})();

// ---- the response parses to {id, name} rows --------------------------------
(() => {
  const rows = cdg.parseLookup(readSample('CDG JSON getjobtypeaddons response.json'));
  ok(rows.length === 3, 'the vendor’s sample response parses to its three add-ons');
  const list = addOns.normalize(rows);
  eq(list.length, 3, 'all three survive normalization');
  eq(list[0].id, '1', 'the id is the subproduct identifier an order will send');
  eq(list[0].name, 'Test Form - 1004 Conventional', 'the name is what a person picks by');
})();

// ---- normalize: never a code an order could not use ------------------------
(() => {
  const list = addOns.normalize([
    { id: '5', name: 'Rent schedule (1007)' },
    { id: '5', name: 'a duplicate of the same code' },
    { name: 'no id at all' },
    { id: '  6  ', name: '  ' },
    null, 'nonsense', { id: '' },
  ]);
  eq(list.length, 2, 'a duplicate id, an idless row and junk are all dropped');
  eq(list[0].id, '5', 'the first of a duplicated id wins');
  eq(list[1].id, '6', 'a padded id is trimmed');
  // The ID is what an order SENDS, so a nameless code is still usable and is kept
  // with an honest placeholder; an id-less NAME could only ever produce an order
  // asking for "".
  eq(list[1].name, 'Add-on 6', 'a code with no name is still offerable, and says so');
  eq(addOns.normalize(null).length, 0, 'nothing in, nothing out');
})();

// ---- the account-wide refresh no longer asks an unanswerable question ------
ok(!lookups.LOOKUP_TYPES.includes('GetJobTypeAddOns'),
  'GetJobTypeAddOns is OUT of the parameterless account-wide lookup list (it takes a form)');
ok(lookups.LOOKUP_TYPES.includes('GetJobType') && lookups.LOOKUP_TYPES.includes('GetPropertyType'),
  'the genuinely account-wide lookups are untouched');

// ---- what an order has selected, named where we can ------------------------
(async () => {
  const CACHED = [{ id: '5', name: 'Rent schedule (1007)' }, { id: '6', name: 'Operating income (216)' }];
  const dbWith = (payload, fetchedAt) => ({
    query: async () => ({ rows: payload === null ? [] : [{ payload, fetched_at: fetchedAt || new Date().toISOString() }] }),
  });

  {
    const out = await addOns.addOnsFor(dbWith(CACHED), { productCode: '1004', selectedCodes: ['5'] });
    eq(out.available.length, 2, 'the form’s add-ons come back');
    eq(out.selected.length, 1, 'the selected one is reported');
    eq(out.selected[0].name, 'Rent schedule (1007)', 'and it is NAMED, not left as a bare number');
    eq(out.unknownSelected.length, 0, 'nothing is unaccounted for');
  }

  {
    // A form rule can carry a code the account has since retired. Sending it comes
    // back as a vendor refusal nobody can explain, so it is NAMED on the preview —
    // the one moment it is still fixable.
    const out = await addOns.addOnsFor(dbWith(CACHED), { productCode: '1004', selectedCodes: ['5', '99'] });
    eq(out.selected.length, 1, 'the code the vendor offers is matched');
    eq(out.unknownSelected.join(','), '99', 'a code the vendor does not list is surfaced, never silently dropped');
  }

  {
    // A cold cache must never hold a preview open on the vendor.
    const out = await addOns.addOnsFor(dbWith(null), { productCode: '1004', selectedCodes: ['5'] });
    eq(out.available.length, 0, 'a cold cache answers an empty list');
    eq(out.unknownSelected.join(','), '5', 'and the order’s own codes are still stated, unnamed');
  }

  {
    const out = await addOns.addOnsFor(dbWith(CACHED), { productCode: '', selectedCodes: ['5'] });
    eq(out.available.length, 0, 'with no form chosen there is nothing to ask about');
    eq(out.unknownSelected.join(','), '5', 'the order’s codes are still reported');
  }

  {
    // NEVER THROWS: a database that will not answer must not take the preview down.
    const out = await addOns.addOnsFor({ query: async () => { throw new Error('db down'); } },
      { productCode: '1004', selectedCodes: ['5'] });
    eq(out.available.length, 0, 'an unreadable cache degrades to an empty list');
    ok(Array.isArray(out.unknownSelected), 'and still answers a shaped object');
  }

  {
    const out = await addOns.addOnsFor(null, { productCode: '1004', selectedCodes: [] });
    ok(out && Array.isArray(out.available), 'no db at all is a shaped answer, not a throw');
  }

  // A stale cache still SHOWS while it refreshes — a screen that blanks itself
  // because the vendor is slow is worse than one showing yesterday's list.
  {
    const old = new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString();
    const out = await addOns.addOnsFor(dbWith(CACHED, old), { productCode: '1004', selectedCodes: [] });
    eq(out.available.length, 2, 'a stale list is still shown');
    eq(out.stale, true, 'and is reported as refreshing');
  }

  // ---- the two shapes the selection arrives in mean the same thing ---------
  // The preview is a GET, where URLSearchParams flattens an array to a comma string;
  // the place is a POST with a real array. Both had to be read, or a ticked box was
  // silently ignored on the preview and the form rule's default kept showing.
  const { readOverrides } = require('../src/routes/amc');
  const codes = (src) => (readOverrides(src).subproductCodes || []).join(',');
  eq(codes({ subproductCodes: ['5', '6'] }), '5,6', 'a POST body’s array is read');
  eq(codes({ subproductCodes: '5,6' }), '5,6', 'a GET query’s comma-joined string means exactly the same thing');
  eq(codes({ subproductCodes: ' 5 , 6 ' }), '5,6', 'whitespace around a code is not part of it');
  eq(codes({ subproductCodes: 5 }), '', 'a number is not a selection — it is ignored rather than guessed at');
  // "NONE OF THEM" IS A REAL ANSWER, and it has to survive as one: if an empty
  // selection read as "not stated", unticking the last box would silently put the
  // form rule's default add-ons back on the order.
  ok(Array.isArray(readOverrides({ subproductCodes: [] }).subproductCodes)
    && readOverrides({ subproductCodes: [] }).subproductCodes.length === 0,
    'an empty array means "none", not "unstated"');
  ok(Array.isArray(readOverrides({ subproductCodes: '' }).subproductCodes)
    && readOverrides({ subproductCodes: '' }).subproductCodes.length === 0,
    'an empty query value means "none" too');
  eq(readOverrides({}).subproductCodes, undefined, 'an ABSENT key leaves the form rule’s own default alone');
  // The rest of the override reader is untouched by any of this.
  eq(readOverrides({ productCode: '1004' }).productCode, '1004', 'the form override still reads');

  console.log(`\n[test-amc-addons-pure] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
