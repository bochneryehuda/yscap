'use strict';
/**
 * Trinity mapper — PURE tests (no database, no network).
 *
 * The two things worth proving here are the two that decide money:
 *   OUT  — the historical draws travel correctly, and an inspector is never shown a
 *          line as "already paid for" when it is not;
 *   BACK — what the inspector approved converts to CENTS exactly, reconciles to
 *          Trinity's own total, and REFUSES rather than guesses when it cannot.
 *
 * Several fixtures are the VERBATIM shapes the live sandbox returned on 2026-08-14
 * (order 735310) — a schema can drift, a recorded real response cannot.
 */

const assert = require('assert');
const m = require('../src/trinity/mapper');

let n = 0;
const ok = (cond, label) => { n++; assert.ok(cond, label); };
const eq = (a, b, label) => { n++; assert.strictEqual(a, b, label); };

// ---------------------------------------------------------------------------
// A. historical draws -> previousPercentCompleted
// ---------------------------------------------------------------------------
eq(m.previousPct(0, 40000), 0, 'nothing drawn is 0%');
eq(m.previousPct(20000, 40000), 50, 'half drawn is 50%');
eq(m.previousPct(40000, 40000), 100, 'fully drawn is 100%');
// An over-drawn line is possible after an approved over-limit request. Sending >100
// would be refused outright by Trinity, taking the whole order down with it.
eq(m.previousPct(50000, 40000), 100, 'an over-drawn line clamps at 100, never above');
eq(m.previousPct(-5, 40000), 0, 'a negative can never become a negative percentage');
eq(m.previousPct(100, 0), 0, 'a zero budget never divides by zero');
// 4 decimals keeps even a large line accurate to well under a cent.
eq(m.previousPct(1, 300000000), 0, 'a sub-precision amount rounds to 0, not to junk');
ok(Math.abs(m.previousPct(33333, 100000) - 33.333) < 1e-9, 'four decimals are preserved');

// ---------------------------------------------------------------------------
// B. our lines -> Trinity line items
// ---------------------------------------------------------------------------
const lines = [
  { sitewire_job_item_id: 11, name: 'Roof', budgeted_cents: 4000000, previous_drawn_cents: 2000000, requested_cents: 1000000 },
  { sitewire_job_item_id: 12, name: 'Kitchen', budgeted_cents: 6000000, previous_drawn_cents: 1500000, requested_cents: 1500000 },
  { sitewire_job_item_id: 13, name: 'Windows', budgeted_cents: 2500000, previous_drawn_cents: 2500000, requested_cents: 0 },
  { sitewire_job_item_id: 14, name: 'Zero line', budgeted_cents: 0, previous_drawn_cents: 0, requested_cents: 0 },
];
const items = m.toLineItems(lines);
eq(items.length, 3, 'a $0 budget line is not sent (it tells an inspector nothing)');
eq(items[0].itemCost, 40000, 'cents become dollars');
eq(items[0].amountRequested, 10000, 'the request becomes dollars');
eq(items[0].previousPercentCompleted, 50, 'the historical draw rides as a percentage');
eq(items[0].isRequested, true, 'a line with a request is marked requested');
eq(items[2].isRequested, false, 'a line with no request is sent but not flagged');
ok(items.every((i) => i.customerKey), 'every line carries the crosswalk key');
eq(items[0].customerKey, 'ji-11', 'the crosswalk key is our own job-item id');
// The WHOLE budget is sent, not just the requested lines — that is what carries "how
// much is still available on every line item".
ok(items.some((i) => !i.isRequested), 'unrequested budget lines are still shown to the inspector');

// A line with no job-item id still gets a stable key rather than being dropped.
eq(m.customerKeyForLine({ sow_line_key: 'roof' }), 'sow-roof', 'falls back to the SOW key');

// ---------------------------------------------------------------------------
// C. the order payload refuses rather than invents
// ---------------------------------------------------------------------------
const goodArgs = {
  companyId: 39400, projectNumber: 'YSCAP-1', orderCustomerKey: 'pdr-1',
  address: { street: '128 Maple Ave', city: 'Lakewood', state: 'NJ', zip: '08701' },
  borrower: { name: 'Test Borrower', email: 'b@example.com', phone: '7325550134' },
  // A contractor PHONE is required by Trinity, whatever the swagger says it is — see
  // section C2 below. This fixture used to omit it and still expected zero problems,
  // which is precisely the payload the live API refuses with a 400.
  contractor: { name: 'Sam Builder', companyName: 'Builder Co', email: 'sam@example.com', phone: '7325550199' },
  analyst: { name: 'Draw Coordinator', email: 'draws@yscapgroup.com' },
  lines,
};
const good = m.buildOrderPayload(goodArgs);
eq(good.problems.length, 0, 'a complete file builds cleanly');
eq(good.payload.order.lineItems.length, 3, 'the payload carries the budget');
// A value that ALREADY satisfies Trinity's pattern is passed through untouched — we
// never rewrite a contact detail that is fine as it stands.
eq(good.payload.borrower.phone, '7325550134', 'an already-valid phone is left exactly as it is');
// One that does not match is normalized rather than sent malformed (a bad phone is
// refused by Trinity and takes the whole order down with it).
eq(m._internals.cleanPhone('1 (732) 555-0134'), '732-555-0134', 'a non-matching phone is normalized');

// Trinity REQUIRES a contractor email. Inventing one would send a real inspector to
// chase a fake address, so it is refused in plain words instead.
const noContractor = m.buildOrderPayload({ ...goodArgs, contractor: null });
ok(noContractor.problems.some((p) => /contractor/i.test(p)), 'a missing contractor is named, not invented');

const badZip = m.buildOrderPayload({ ...goodArgs, address: { ...goodArgs.address, zip: 'nope' } });
ok(badZip.problems.some((p) => /ZIP/i.test(p)), 'an unusable ZIP is refused');

const noRequest = m.buildOrderPayload({
  ...goodArgs,
  lines: lines.map((l) => ({ ...l, requested_cents: 0 })),
});
ok(noRequest.problems.some((p) => /requested/i.test(p)), 'an order with nothing requested is refused');

// A junk phone is dropped, never sent malformed (a bad phone fails the whole order).
eq(m._internals.cleanPhone('call me'), undefined, 'an unparseable phone is omitted');
eq(m._internals.cleanEmail('not-an-email'), undefined, 'an unparseable email is omitted');

// ---------------------------------------------------------------------------
// C2. PHONES ARE REQUIRED — the swagger says otherwise and the swagger is wrong
// ---------------------------------------------------------------------------
// Verified live against the sandbox on 2026-08-16: an order with no phone on either
// party is refused 400 with
//   Borrower.['Phone','OtherPhone','HomePhone,'MobilePhone']  : At least one is required
//   Contractor.['Phone','MobilePhone']                        : At least one is required
// even though EVERY phone field on both models is documented `nullable: true`.
//
// `cleanPhone` deliberately omits a number it cannot parse rather than sending junk, so
// before this check a file with a missing or malformed phone produced a payload that was
// guaranteed to be rejected — and the desk saw a raw validation error rather than
// something it could fix. These assertions are what keep that from coming back.
const noBorrowerPhone = m.buildOrderPayload({ ...goodArgs, borrower: { name: 'Test Borrower', email: 'b@example.com' } });
ok(noBorrowerPhone.problems.some((p) => /borrower's phone/i.test(p)), "a missing borrower phone is refused before sending");

const noContractorPhone = m.buildOrderPayload({
  ...goodArgs, contractor: { name: 'Sam Builder', companyName: 'Builder Co', email: 'sam@example.com' },
});
ok(noContractorPhone.problems.some((p) => /contractor's phone/i.test(p)), "a missing contractor phone is refused before sending");

// An UNPARSEABLE phone must not read as a missing one — the desk needs to know the
// number on file is unusable, not absent.
const junkPhone = m.buildOrderPayload({ ...goodArgs, borrower: { name: 'Test Borrower', email: 'b@example.com', phone: 'call me' } });
ok(junkPhone.problems.some((p) => /not a number Trinity can accept/i.test(p)), 'an unusable phone says so, rather than reading as missing');

// Trinity does not care WHICH phone field carries the number, so a party whose only
// good number is the mobile one is still perfectly orderable.
const mobileOnly = m.buildOrderPayload({
  ...goodArgs,
  borrower: { name: 'Test Borrower', email: 'b@example.com', mobilePhone: '732-555-0134' },
  contractor: { name: 'Sam Builder', companyName: 'Builder Co', email: 'sam@example.com', mobilePhone: '732-555-0199' },
});
eq(mobileOnly.problems.length, 0, 'a mobile-only contact still builds cleanly');
eq(mobileOnly.payload.borrower.phone, '732-555-0134', 'the usable number is promoted into the field Trinity checks');
// '(732) 555-0134' already satisfies Trinity's pattern, so it is passed through exactly
// as it stands — we never rewrite a contact detail that is already fine.
eq(m._internals.firstUsablePhone(['call me', '', '(732) 555-0134']), '(732) 555-0134', 'the first USABLE number wins, junk is skipped');
eq(m._internals.firstUsablePhone(['call me', '1 (732) 555-0134']), '732-555-0134', 'a usable-but-unformatted number is normalized');
eq(m._internals.firstUsablePhone(['nope', 'also nope']), undefined, 'all-junk yields nothing rather than a fake');

// ---------------------------------------------------------------------------
// C3. PERCENTAGE PRECISION — the historical draws must survive the round trip
// ---------------------------------------------------------------------------
// MEASURED against the live API (sandbox order 735315): Trinity preserves exactly SIX
// decimal places on previousPercentCompleted. The first build sent FOUR, believing that
// kept "even a $1,000,000 line accurate to well under a cent". It does not — the error
// scales with the line, and a $1,000,000 line drawn to $333,333.33 was being shown to
// the inspector as $333,333.00.
eq(m.PCT_DECIMALS, 6, 'six decimals — the precision Trinity actually preserves');

const bigCost = 100000000;      // $1,000,000.00 in cents
const bigDrawn = 33333333;      // $333,333.33 in cents
const p6 = m.previousPct(bigDrawn, bigCost);
// What Trinity will show the inspector as already drawn on that line, in cents.
const shown = Math.round(bigCost * (p6 / 100));
eq(shown, bigDrawn, 'a $1,000,000 line round-trips to the exact cent');
ok(Math.abs(shown - bigDrawn) < 1, 'no drift is introduced by the percentage conversion');

// Still clamped and still safe at the edges.
eq(m.previousPct(50000, 0), 0, 'a zero budget never divides by zero');
eq(m.previousPct(200000, 100000), 100, 'an over-drawn line is clamped to 100, never refused by Trinity');

// ---------------------------------------------------------------------------
// C4. THE CLAMP IS THE ONLY THING STOPPING CORRUPT MONEY ON THEIR SIDE
// ---------------------------------------------------------------------------
// VERIFIED LIVE 2026-08-16 (order 735321): Trinity does NOT validate this ceiling.
// `previousPercentCompleted: 120` was accepted 200, stored VERBATIM, and their own
// `total.previousCostCompleted` then read $93,000 on a project where $90,000 had
// actually been drawn — a $3,000 overstatement shown to the inspector as money already
// released. An over-drawn line is a real thing (an approved over-limit request), so this
// is reachable in production. The clamp is not politeness; it is the guard.
eq(m.previousPct(1500000, 1500000), 100, 'a fully drawn line reads exactly 100');
ok(m.previousPct(1800000, 1500000) <= 100, 'an over-drawn line can NEVER send more than 100 — Trinity would store it and overstate the money drawn');
const overdrawn = m.toLineItems([{ sitewire_job_item_id: 7, name: 'Roof', budgeted_cents: 1500000, previous_drawn_cents: 1800000, requested_cents: 1000 }]);
eq(overdrawn[0].previousPercentCompleted, 100, 'the clamp survives the whole toLineItems path, not just the helper');

// ---------------------------------------------------------------------------
// C5. LINE KEYS MUST BE UNIQUE — Trinity REFUSES THE WHOLE ORDER OTHERWISE
// ---------------------------------------------------------------------------
// VERIFIED LIVE 2026-08-16: two line items sharing a customerKey answers
//   400 `2 line items have CustomerKey "ji-3001", line item keys must be unique within
//        an order.`
// So a collision is not a degraded line — it is a REFUSED INSPECTION. Our last-resort
// key is a slug of the line's NAME, so two identically-named lines with no ids collide.
const collide = m.toLineItems([
  { name: 'Kitchen', budgeted_cents: 100000, requested_cents: 5000 },
  { name: 'Kitchen', budgeted_cents: 200000, requested_cents: 6000 },
  { name: 'Kitchen', budgeted_cents: 300000, requested_cents: 0 },
]);
eq(new Set(collide.map((i) => i.customerKey)).size, 3, 'three identically-named lines get three distinct keys');
eq(collide[0].customerKey, 'line-kitchen', 'the FIRST line keeps the stable key — it must not move between re-orders');
eq(collide[0].itemCost, 1000, 'and the de-duplication never reorders or rewrites the money');
eq(collide[1].itemCost, 2000, 'second line intact');
// A budget whose keys are already unique is untouched.
const alreadyUnique = m.toLineItems(lines);
eq(new Set(alreadyUnique.map((i) => i.customerKey)).size, alreadyUnique.length, 'ordinary keyed lines are left exactly as they are');

// ---------------------------------------------------------------------------
// C6. THE BUDGET PROOF — did their system really take what we sent?
// ---------------------------------------------------------------------------
// Sending a budget and having the order accepted is NOT the same as knowing it arrived.
// verifyRemoteBudget is the check that runs on every order.
const sentItems = m.toLineItems([
  { sitewire_job_item_id: 8001, name: 'Framing', budgeted_cents: 5000000, previous_drawn_cents: 3750000, requested_cents: 1250000 },
  { sitewire_job_item_id: 8002, name: 'Roofing', budgeted_cents: 2200000, previous_drawn_cents: 550000, requested_cents: 800000 },
]);
// The shape Trinity actually returns (verified against order 735319).
const remoteGood = {
  lineItems: [
    { customerKey: 'ji-8001', description: 'Framing', itemCost: 50000, amountRequested: 12500, previousPercentCompleted: 75, percentCompleted: 75, id: 1 },
    { customerKey: 'ji-8002', description: 'Roofing', itemCost: 22000, amountRequested: 8000, previousPercentCompleted: 25, percentCompleted: 25, id: 2 },
  ],
  total: { totalCost: 72000, previousCostCompleted: 43000, costCompleted: 43000 },
};
const vGood = m.verifyRemoteBudget(sentItems, remoteGood);
ok(vGood.ok, 'a budget Trinity stored correctly verifies clean');
eq(vGood.problems.length, 0, 'and reports no problems');
eq(vGood.summary.checked, 2, 'both lines were actually checked, not skipped');
eq(vGood.summary.remoteBudgetCents, 7200000, 'their budget total is read back in cents');
eq(vGood.summary.remoteDrawnCents, 4300000, 'their already-drawn total is read back in cents');

// A line of OURS missing from their budget breaks the crosswalk — whatever the inspector
// approves on it, we could not say which of our lines it belongs to.
const vMissing = m.verifyRemoteBudget(sentItems, { ...remoteGood, lineItems: [remoteGood.lineItems[0]] });
ok(!vMissing.ok, 'a line missing from their budget is caught');
ok(/not on Trinity/i.test(vMissing.problems.join(' ')), 'and says so in plain words');

// The money checks, one at a time.
const bend = (patch) => ({ ...remoteGood, lineItems: remoteGood.lineItems.map((l, i) => (i === 0 ? { ...l, ...patch } : l)) });
ok(!m.verifyRemoteBudget(sentItems, bend({ itemCost: 49000 })).ok, 'a different construction budget on their side is caught');
ok(!m.verifyRemoteBudget(sentItems, bend({ amountRequested: 9999 })).ok, 'a different requested amount is caught');
ok(!m.verifyRemoteBudget(sentItems, bend({ previousPercentCompleted: 50 })).ok, 'a different already-drawn figure is caught — the one that matters most');
ok(/already drawn/i.test(m.verifyRemoteBudget(sentItems, bend({ previousPercentCompleted: 50 })).problems.join(' ')),
  'and the already-drawn message names what it is about');
// The key check is about OUR reference, not their description — an inspector renaming a
// line on their side must not read as a broken crosswalk.
ok(m.verifyRemoteBudget(sentItems, bend({ description: 'Framing & sheathing' })).ok,
  'a line RENAMED on their side still verifies — the tie is the key, never the description');
// A cent of dust from the percentage round trip is not an alarm.
ok(m.verifyRemoteBudget(sentItems, bend({ itemCost: 50000.009 })).ok, 'a sub-cent difference is tolerated, not flagged');

// A line THEY added is not a fault, but the desk must be told it is there.
const vExtra = m.verifyRemoteBudget(sentItems, {
  ...remoteGood,
  lineItems: [...remoteGood.lineItems, { customerKey: null, description: 'Trip fee', itemCost: 500, amountRequested: 0, previousPercentCompleted: 0, percentCompleted: 0, id: 3 }],
});
ok(vExtra.ok, 'a line Trinity added on their own side is not an error');
eq(vExtra.summary.extraLines, 1, 'but it is counted');
eq(vExtra.summary.extraNames[0], 'Trip fee', 'and named, so it is not a surprise in the results');

// Never throws, never guesses.
ok(!m.verifyRemoteBudget(sentItems, null).ok, 'no budget at all is reported, never assumed fine');
ok(!m.verifyRemoteBudget(sentItems, {}).ok, 'an empty answer is reported too');
ok(m.verifyRemoteBudget([], remoteGood).ok, 'nothing sent means nothing to disagree about');
// A badly broken order must not write a novel into a text column.
const manySent = m.toLineItems(Array.from({ length: 40 }, (_, i) => ({ sitewire_job_item_id: 9000 + i, name: `Line ${i}`, budgeted_cents: 100000, requested_cents: 1000 })));
const vMany = m.verifyRemoteBudget(manySent, { lineItems: [], total: {} });
ok(vMany.problems.length <= 13, 'the problem list is capped');
ok(/more/.test(vMany.problems[vMany.problems.length - 1]), 'and says how many it did not list');

// ---------------------------------------------------------------------------
// D. reading the result — the money path
// ---------------------------------------------------------------------------
// The VERBATIM shape the sandbox returned for order 735310, with the percentages moved
// forward as a completed inspection would leave them.
const budget = {
  lineItems: [
    { amountRequested: 10000, itemCost: 40000, isRequested: true, previousPercentCompleted: 50, percentCompleted: 70, id: 13286103, number: 0, customerKey: 'ji-11', description: 'Roof', remarks: 'Roof complete, flashing still open' },
    { amountRequested: 15000, itemCost: 60000, isRequested: true, previousPercentCompleted: 25, percentCompleted: 40, id: 13286104, number: 0, customerKey: 'ji-12', description: 'Kitchen', remarks: 'Cabinets in, counters not installed' },
    { amountRequested: 0, itemCost: 25000, isRequested: false, previousPercentCompleted: 100, percentCompleted: 100, id: 13286105, number: 0, customerKey: 'ji-13', description: 'Windows', remarks: null },
  ],
  total: { previousPercentCompleted: 42.857, percentCompleted: 55.71, previousCostCompleted: 60000, costCompleted: 77000, totalCost: 140000 },
};
const sent = [
  { customer_key: 'ji-11', sitewire_job_item_id: 11, sow_line_key: 'roof' },
  { customer_key: 'ji-12', sitewire_job_item_id: 12, sow_line_key: 'kitchen' },
  { customer_key: 'ji-13', sitewire_job_item_id: 13, sow_line_key: 'windows' },
];
const res = m.readResults(budget, sent);
ok(res.ok, 'a well-formed completed budget reads cleanly');
eq(res.approvedCents, 1700000, 'the approved total is $17,000 — Trinity’s own total, to the cent');
eq(res.lines[0].approved_cents, 800000, 'Roof: 20% of $40,000 = $8,000');
eq(res.lines[1].approved_cents, 900000, 'Kitchen: 15% of $60,000 = $9,000');
eq(res.lines[2].approved_cents, 0, 'a line that did not move is approved at nothing');
eq(res.lines[0].sitewire_job_item_id, 11, 'the result ties back to OUR job item, not an ordinal');
eq(res.lines[0].inspector_remarks, 'Roof complete, flashing still open', "the inspector's note is carried");
// Σ lines === total, always. This is the invariant the reconciliation exists for.
eq(res.lines.reduce((s, l) => s + l.approved_cents, 0), res.approvedCents, 'the lines sum to the total exactly');

// Trinity's budget read-back returns `number: 0` on every line (verified live), so
// identity must never come from the ordinal.
ok(budget.lineItems.every((l) => l.number === 0), 'the fixture keeps the real number:0 quirk');
ok(res.lines.every((l) => l.customer_key), 'identity comes from the customerKey');

// ---------------------------------------------------------------------------
// E. it REFUSES rather than guesses
// ---------------------------------------------------------------------------
const backwards = m.readResults({
  lineItems: [{ itemCost: 40000, previousPercentCompleted: 50, percentCompleted: 30, description: 'Roof', customerKey: 'ji-11' }],
  total: { previousCostCompleted: 20000, costCompleted: 12000 },
}, sent);
eq(backwards.ok, false, 'a line going backwards is refused');
ok(/backwards/i.test(backwards.reason), 'and says so in plain words');

const disagrees = m.readResults({
  lineItems: [{ itemCost: 40000, previousPercentCompleted: 50, percentCompleted: 70, description: 'Roof', customerKey: 'ji-11' }],
  total: { previousCostCompleted: 20000, costCompleted: 99999 },   // wildly inconsistent
}, sent);
eq(disagrees.ok, false, "a total that disagrees with its own lines is refused, never averaged");

eq(m.readResults({ lineItems: [] }, sent).ok, false, 'an empty budget is refused');
eq(m.readResults(null, sent).ok, false, 'a missing budget is refused');

// Sub-cent dust is absorbed, not refused — the residual lands on the largest line.
const dusty = m.readResults({
  lineItems: [
    { itemCost: 1000.01, previousPercentCompleted: 0, percentCompleted: 33.3333, description: 'A', customerKey: 'ji-11' },
    { itemCost: 2000.02, previousPercentCompleted: 0, percentCompleted: 33.3333, description: 'B', customerKey: 'ji-12' },
  ],
  total: { previousCostCompleted: 0, costCompleted: 1000.01 },
}, sent);
ok(dusty.ok, 'rounding dust is absorbed rather than refused');
eq(dusty.lines.reduce((s, l) => s + l.approved_cents, 0), dusty.approvedCents, 'and still sums exactly');

// ---------------------------------------------------------------------------
// F. the delivery entries never exceed what was requested
// ---------------------------------------------------------------------------
const entries = m.toApprovalEntries(res.lines, [
  { sitewire_job_item_id: 11, requested_cents: 1000000 },
  { sitewire_job_item_id: 12, requested_cents: 1500000 },
]);
eq(entries.length, 2, 'only lines on this draw are delivered');
eq(entries[0].approved_cents, 800000, 'the approved amount passes through');
const capped = m.toApprovalEntries(
  [{ sitewire_job_item_id: 11, approved_cents: 9999999 }],
  [{ sitewire_job_item_id: 11, requested_cents: 1000000 }],
);
eq(capped[0].approved_cents, 1000000, 'an approval above the request is capped at the request');
eq(m.toApprovalEntries([{ sitewire_job_item_id: 99, approved_cents: 5 }], []).length, 0,
  'a line that is not on the draw is never delivered');

console.log(`test-trinity-mapper-pure: ${n} assertions passed`);
