'use strict';
/**
 * WHO IS DOING THE APPRAISAL, WHEN THEY ARE GOING OUT, AND WHAT IT COSTS —
 * read against AppraisalScope's OWN sample response, which is in this repository
 * at docs/vendor/appraisalscope/samples/Orders/.
 *
 * `GetAppraisalDetail` had never been called: `cdg.buildGetDetail` was exported
 * with zero callers, so the appraiser's name, the inspection date, the vendor's
 * own due date and four separate fees were thrown away on every order. This test
 * reads the vendor's file rather than a hand-typed fixture, so the contract is
 * checked against their artifact and cannot drift from it silently.
 *
 * The three things a shape comparison would happily pass while the feature was
 * dangerously wrong, and which are therefore pinned individually:
 *
 *   • THE SENTINELS. An unset field comes back as the STRING "N/A", "null" or "".
 *     Read naively, the literal text "N/A" becomes the inspection date and the
 *     screen then tells somebody the inspection is booked.
 *   • MONEY IS NOT A SENTINEL. "0.00" is a real figure — `paidAmount: "0.00"`
 *     beside `dueAmount: "450.00"` is what "nothing has been paid yet" looks
 *     like, and swallowing it would erase a fact.
 *   • THE APPRAISER IS NOT THE AMC. Both ride in the vendor's one `appraisers[]`
 *     array under different `partyRoleType`s. Telling a loan officer that the
 *     management company is inspecting their property is worse than telling them
 *     nothing.
 *
 * It also pins the DESK's reading of the same figures (appraisal-order-mirror),
 * because the fee shown there was job + management — $75 on the vendor's own
 * sample, where the client fee is $450.
 *
 * PURE — no database, no network. Runs anywhere.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const cdg = require(path.join(ROOT, 'src/amc/cdg'));
const mirror = require(path.join(ROOT, 'src/lib/appraisal-order-mirror'));
const SAMPLES = path.join(ROOT, 'docs/vendor/appraisalscope/samples/Orders');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.error('FAIL ' + m); } };

const sample = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'CDG JSON getappraisaldetail response.json'), 'utf8'));
const product = sample.message.products[0];
const parties = sample.message.deals[0].appraisers;
const partyOf = (role) => parties.find((a) => String(a.partyRoleType).toLowerCase() === role);

/* ── A. the vendor's file still says what this reader assumes ─────────────── */
// If the sample ever changes shape, every assertion below would pass vacuously
// against a null, so the fixture's own preconditions are asserted first.
ok(parties.length >= 2 && partyOf('appraiser') && partyOf('amc'),
  'A1 the vendor sample carries BOTH an Appraiser and an AMC in one appraisers[] array');
ok(product.inspectionDate === 'N/A', 'A2 the sample really does write an unset date as the string "N/A"');
ok(product.paidAmount === '0.00' && product.dueAmount === '450.00',
  'A3 the sample really does carry a zero paid amount beside a real due amount');

/* ── B. the read ──────────────────────────────────────────────────────────── */
const d = cdg.parseDetail(sample);
ok(!!d, 'B1 the vendor response reads');

ok(d.appraiser.name === partyOf('appraiser').fullName
  && d.appraiser.company === partyOf('appraiser').companyName
  && d.appraiser.email === partyOf('appraiser').contactEmail
  && d.appraiser.phone === partyOf('appraiser').contactPhone,
'B2 the APPRAISER is read from the Appraiser party, field for field');

ok(d.amc.company === partyOf('amc').companyName,
  'B3 the AMC is read separately, into its own block');

// THE ONE THAT MATTERS: the management company must never be presented as the
// person inspecting the property.
ok(d.appraiser.name !== partyOf('amc').companyName
  && d.appraiser.company !== partyOf('amc').companyName,
'B4 the AMC company name is NEVER the appraiser');

ok(d.appraiser.city === 'Edmond' && d.appraiser.state === 'OK',
  'B5 where the appraiser is based is read');

/* ── C. the sentinels ─────────────────────────────────────────────────────── */
ok(d.inspectionDate === null, 'C1 "N/A" is an ABSENT inspection date, not the text "N/A"');
ok(d.amc.fileNumber === null, 'C2 "" is absent');
const { detailText, detailDate, detailMoney } = cdg._internals;
for (const s of ['', 'N/A', 'n/a', 'na', 'null', 'NULL', 'undefined', 'none', '-', '  ']) {
  ok(detailText(s) === null, `C3 the sentinel ${JSON.stringify(s)} reads as absent`);
}
ok(detailText('Edmond') === 'Edmond', 'C4 a real value is untouched');
ok(detailDate('2021-05-15') === '2021-05-15', 'C5 a date-only value is kept');
ok(detailDate('N/A') === null && detailDate('05/07/2021 04:58:19 pm') === null,
  'C6 a sentinel and a datetime are not date-only values');

/* ── D. money is not a sentinel ───────────────────────────────────────────── */
// A money field reads as a NUMBER, and zero is a number — so every check here is
// `!== null` and never a truthiness test, which is the mistake that would let a
// swallowed zero pass.
ok(d.paidAmount !== null && Number(d.paidAmount) === 0,
  'D1 a paid amount of ZERO survives — it is a fact, not an absence');
ok(d.invoicedAmount !== null && Number(d.invoicedAmount) === 0, 'D2 so does a zero invoiced amount');
ok(Number(d.dueAmount) === 450 && Number(d.clientFee) === 450, 'D3 the real figures are read');
ok(detailMoney('0.00') !== null && Number(detailMoney('0.00')) === 0
  && detailMoney('0') !== null && Number(detailMoney('0')) === 0,
'D4 zero money is never swallowed');
ok(detailMoney('N/A') === null && detailMoney('') === null, 'D5 a sentinel amount is still absent');

/* ── E. the four fees the desk never had ──────────────────────────────────── */
ok(Number(d.formFee) === 400 && Number(d.jobFee) === 25 && Number(d.managementFee) === 50,
  'E1 the form / job / management fees are read');
// The reason the desk's own number had to change: these two do not add up to the
// client fee, so summing them answers the wrong question.
ok(Number(d.jobFee) + Number(d.managementFee) !== Number(d.clientFee),
  'E2 job + management is NOT the client fee (it is $75 against $450 here)');

/* ── F. when ──────────────────────────────────────────────────────────────── */
ok(d.dueDate === '2021-05-15', 'F1 the vendor states its OWN due date — the ETA somebody asks for');
ok(d.completedDate === '2021-05-14', 'F2 and its completed date');
// Kept verbatim: the vendor sends no timezone anywhere, so reading one in would be
// a guess printed as a fact.
ok(typeof d.lastUpdateAt === 'string' && /\d/.test(d.lastUpdateAt),
  'F3 a datetime is kept as the vendor stated it');

/* ── G. a response with nothing in it ─────────────────────────────────────── */
ok(cdg.parseDetail(null) === null, 'G1 nothing reads as nothing');
ok(cdg.parseDetail({ message: {} }) === null, 'G2 an empty envelope reads as nothing');
ok(cdg.parseDetail({ message: { products: [], deals: [] } }) === null, 'G3 empty arrays read as nothing');

/* ── H. the DESK's reading of the same order ──────────────────────────────── */
// `describe` is the pure vendor→desk mapping, so the number a coordinator sees is
// checkable without a database.
const row = {
  id: 7, status: 'assigned', sp_order_number: 'SP1', appraisal_file_number: 'F1',
  client_fee: '450.00', job_fee: '25.00', management_fee: '50.00',
  appraiser_name: 'appraiserFName appraiserLName', appraiser_company: 'Appraisal Company Name',
  appraiser_phone: '777-888-9999', appraiser_email: 'appraiser@fake.com',
  vendor_due_date: '2021-05-15', need_by_date: '2021-05-20',
  inspection_date: null, due_amount: '450.00', paid_amount: '0.00',
  created_at: '2021-05-01T00:00:00Z',
};
const desk = mirror.describe('nan', row);
ok(!!desk, 'H1 a placed AppraisalScope order maps onto the desk');
// THE FEE THE COORDINATOR SEES. Before the detail poll existed the desk summed the
// job and management fees, which on this very order is $75 against the $450 the
// vendor is charging us.
ok(desk.feeCents === 45000, 'H2 the desk shows the CLIENT fee ($450), not job + management ($75)');
ok(mirror.describe('nan', { ...row, client_fee: null }).feeCents === 7500,
  'H3 with no client fee stated it falls back to job + management, rather than showing nothing');
ok(desk.detail && desk.detail.appraiserName === 'appraiserFName appraiserLName'
  && desk.detail.appraiserPhone === '777-888-9999',
'H4 the desk carries the appraiser');
ok(desk.detail.vendorDueDate === '2021-05-15' && desk.detail.requestedDueDate === '2021-05-20',
  'H5 and keeps the vendor’s own due date apart from the one we asked for');
ok(desk.detail.dueAmountCents === 45000 && desk.detail.paidAmountCents === 0,
  'H6 and reports a zero paid amount as zero, not as absent');
// An order the vendor has said nothing about yet must not render an empty
// "Appraiser —" block, which would read as "nobody is assigned".
const bare = mirror.describe('nan', { id: 8, status: 'ordered', sp_order_number: 'SP2', created_at: '2021-05-01T00:00:00Z' });
ok(bare && bare.detail === null, 'H7 an order with nothing stated yet carries NO detail block at all');
ok(mirror.describe('class', { id: 9, status: 'ordered', class_order_id: 'C1', created_at: '2021-05-01T00:00:00Z' }).detail === null,
  'H8 and the block is AppraisalScope-only for now — the other vendors are not guessed at');

/* ── I. the guard that the panel asks the ADAPTER, not one vendor's columns ── */
// The AppraisalScope due date and inspection date never appeared on the card
// because it read `order.due_date` / `order.appointment_date` — Class's column
// names — on every vendor's row. This is a SOURCE guard: it fails the moment
// somebody puts a vendor-specific column read back into the shared card.
const panel = fs.readFileSync(path.join(ROOT, 'app-v2/src/components/AppraisalOrderSection.jsx'), 'utf8');
const card = panel.slice(panel.indexOf('function ActiveOrderCard'), panel.indexOf('function StatusTimeline'));
ok(/ad\.dueDate/.test(card) && /ad\.inspectionDate/.test(card),
  'I1 the shared order card asks the adapter for the due + inspection dates');
ok(!/order\.appointment_date/.test(card) && !/order\.due_date/.test(card),
  'I2 and reaches for no vendor-specific date column of its own');
ok(/nan:[\s\S]*?dueDate:/.test(panel) && /nan:[\s\S]*?inspectionDate:/.test(panel),
  'I3 the AppraisalScope adapter answers for its own rows');
ok(!/orderFee:\s*\(\)\s*=>\s*null/.test(panel),
  'I4 no adapter still claims its vendor exposes no per-order fee');

console.log(`\ntest-amc-detail-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
