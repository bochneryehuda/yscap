/**
 * WHICH VENDOR ACTUALLY DELIVERS — the arithmetic, then the real database.
 *
 * A scorecard people act on has to be right about the boring things: a median
 * that is not dragged by one disaster, an "on time" judged against the SAME due
 * date the desk uses, and an honest "we do not have enough to go on" instead of a
 * confident percentage off two orders.
 *
 * The DB half skips cleanly with no DATABASE_URL.
 */
'use strict';
const scorecard = require('../src/lib/vendor-scorecard');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ok ' : '  FAIL'} ${m}`); if (!c) failures++; };
const eq = (a, b, m) => ok(a === b, `${m}${a === b ? '' : ` — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`}`);

const NOW = new Date('2026-08-14T12:00:00Z');
// Monday 2026-08-03 → title (3 business days) is due Thursday 2026-08-06.
const order = (o) => ({ order_type: 'title', status: 'completed', ordered_at: '2026-08-03T14:00:00Z', followup_count: 0, ...o });

console.log('1. the median is the middle, and it is a real turnaround');
{
  eq(scorecard.median([5]), 5, 'one value is its own median');
  eq(scorecard.median([1, 2, 3]), 2, 'the middle of three');
  eq(scorecard.median([1, 2, 3, 4]), 2, 'an even count takes the LOWER middle — never an average nobody experienced');
  eq(scorecard.median([]), null, 'nothing to average is null, not 0');
  eq(scorecard.median(['a', null, undefined, 4]), 4, 'junk is ignored');
  eq(scorecard.median(null), null, 'and hostile input is safe');
  // THE POINT of a median here: one file a vendor sat on for six weeks must not
  // make an otherwise-good company look terrible.
  const rows = [
    order({ first_response_at: '2026-08-04T14:00:00Z' }),   // 24h
    order({ first_response_at: '2026-08-04T14:00:00Z' }),   // 24h
    order({ first_response_at: '2026-08-05T14:00:00Z' }),   // 48h
    order({ first_response_at: '2026-09-14T14:00:00Z' }),   // ~1008h — the disaster
  ];
  const card = scorecard.scoreOrders(rows, NOW);
  eq(card.medianHours, 24, 'the median ignores the six-week outlier a mean would be ruined by');
}

console.log('\n2. on time is judged against the SAME due date the desk uses');
{
  // Due Thursday 2026-08-06.
  const early = scorecard.scoreOrders([order({ first_response_at: '2026-08-05T10:00:00Z' })], NOW);
  eq(early.onTimePct, 100, 'documents back on the Wednesday are on time');
  const onDay = scorecard.scoreOrders([order({ first_response_at: '2026-08-06T23:00:00Z' })], NOW);
  eq(onDay.onTimePct, 100, 'back ON the due date is on time — a deadline is a day, not an instant');
  const late = scorecard.scoreOrders([order({ first_response_at: '2026-08-07T10:00:00Z' })], NOW);
  eq(late.onTimePct, 0, 'the day after is not');
  // A HUMAN'S OWN DUE DATE WINS, exactly as it does everywhere else.
  const pinned = scorecard.scoreOrders([order({ due_on: '2026-08-20', first_response_at: '2026-08-07T10:00:00Z' })], NOW);
  eq(pinned.onTimePct, 100, 'a vendor who beat the date WE agreed with them is on time');
  // A weekend does not count against them.
  const fri = scorecard.scoreOrders([order({ order_type: 'insurance', ordered_at: '2026-08-07T14:00:00Z', first_response_at: '2026-08-11T10:00:00Z' })], NOW);
  eq(fri.onTimePct, 100, 'a Friday order answered Tuesday is on time — insurance waits two BUSINESS days');
}

console.log('\n3. chasing, and what is still out');
{
  const card = scorecard.scoreOrders([
    order({ first_response_at: '2026-08-04T14:00:00Z', followup_count: 0 }),
    order({ first_response_at: '2026-08-04T14:00:00Z', followup_count: 2 }),
    order({ status: 'ordered', first_response_at: null }),
    order({ status: 'ordered', ordered_at: '2026-07-01T14:00:00Z', first_response_at: null }),
  ], NOW);
  eq(card.orders, 4, 'four orders placed');
  eq(card.delivered, 2, 'two came back');
  eq(card.chasedPct, 50, 'half the delivered ones needed chasing');
  eq(card.openNow, 2, 'two are still out');
  eq(card.overdueNow, 2, 'and both are past their date');
  eq(card.oldestOpenDays, 44, 'the oldest has been out 44 days');
}

console.log('\n4. it says when it does not know');
{
  eq(scorecard.scoreOrders([], NOW).orders, 0, 'no orders is zero, not a crash');
  eq(scorecard.scoreOrders(null, NOW).onTimePct, null, 'and null input is safe');
  eq(scorecard.scoreOrders([order({ status: 'ordered', first_response_at: null })], NOW).onTimePct, null,
    'nothing delivered means NO percentage — never a confident 0%');
  const thin = scorecard.scoreOrders([order({ first_response_at: '2026-08-04T14:00:00Z' })], NOW);
  eq(thin.thinSample, true, 'one delivered order is flagged as too thin to judge on');
  const enough = scorecard.scoreOrders(
    Array.from({ length: 6 }, () => order({ first_response_at: '2026-08-04T14:00:00Z' })), NOW);
  eq(enough.thinSample, false, 'six is a track record');
  // An order that was never SENT is not a data point about the vendor at all.
  eq(scorecard.scoreOrders([{ order_type: 'title', status: 'not_ordered', ordered_at: null }], NOW).orders, 0,
    'an order nobody sent tells us nothing about them');
  // A reply timestamped BEFORE the order is data corruption, not a negative
  // turnaround — it must never produce a nonsense median.
  const backwards = scorecard.scoreOrders([order({ first_response_at: '2026-07-01T14:00:00Z' })], NOW);
  eq(backwards.delivered, 0, 'a reply dated before the order is not counted as a delivery');
}

console.log('\n5. the one-line summary a human reads');
{
  const good = scorecard.scoreOrders(
    Array.from({ length: 6 }, () => order({ first_response_at: '2026-08-04T14:00:00Z' })), NOW);
  const s = scorecard.summarize(good, { vendorName: 'Acme Title' });
  ok(/Acme Title/.test(s) && /1 day/.test(s) && /100%/.test(s), `it reads plainly: "${s}"`);
  ok(!/thin|only/.test(s), 'and does not hedge when the sample is real');
  const thin = scorecard.summarize(scorecard.scoreOrders([order({ first_response_at: '2026-08-04T14:00:00Z' })], NOW), {});
  ok(/only 1 order/.test(thin), `a thin sample says so: "${thin}"`);
  ok(/no orders/i.test(scorecard.summarize(scorecard.scoreOrders([], NOW), {})), 'no history says no history');
  ok(typeof scorecard.summarize(null, {}) === 'string', 'and a missing card still produces a sentence');
}

if (!process.env.DATABASE_URL) {
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nvendor-scorecard pure — all checks passed (DB half skipped: no DATABASE_URL)');
  process.exit(failures ? 1 : 0);
}

/* ─────────────────────────── the real database ─────────────────────────── */
process.env.EMAIL_PROVIDER = 'none';
process.env.NOTIFY_DIGESTS_ENABLED = '0';
const db = require('../src/db');
const uniq = `vsc-${process.pid}-${Date.now()}`;

(async () => {
  console.log('\n6. against real rows');
  const borrower = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Bo','Rrower',$1) RETURNING id`,
    [`${uniq}@example.test`])).rows[0].id;
  const vendor = (await db.query(
    `INSERT INTO service_contacts (borrower_id, contact_type, company_name, email)
     VALUES ($1,'title_company','Acme Title',$2) RETURNING id`, [borrower, `${uniq}-v@vendor.test`])).rows[0].id;
  const mkApp = async () => (await db.query(
    `INSERT INTO applications (borrower_id, status, loan_type, property_address)
     VALUES ($1,'underwriting','Purchase','{}'::jsonb) RETURNING id`, [borrower])).rows[0].id;

  // Two delivered next-day, one still sitting there three weeks.
  for (const back of ['1 day', '1 day']) {
    const a = await mkApp();
    await db.query(
      `INSERT INTO file_orders (application_id, order_type, status, vendor_contact_id, ordered_at, first_response_at, followup_count)
       VALUES ($1,'title','completed',$2, now() - interval '10 days', now() - interval '10 days' + interval '${back}', 0)`, [a, vendor]);
  }
  const stuck = await mkApp();
  await db.query(
    `INSERT INTO file_orders (application_id, order_type, status, vendor_contact_id, ordered_at, followup_count)
     VALUES ($1,'title','ordered',$2, now() - interval '21 days', 3)`, [stuck, vendor]);

  const card = await scorecard.scorecardFor(vendor);
  eq(card.orders, 3, 'three orders on the real row');
  eq(card.delivered, 2, 'two delivered');
  eq(card.medianDays, 1, 'usually back the next day');
  eq(card.openNow, 1, 'one still out');
  eq(card.overdueNow, 1, 'and it is late');
  ok(card.oldestOpenDays >= 20, 'which we have been waiting on for three weeks');

  // A SOFT-DELETED file's orders must not score anybody.
  await db.query(`UPDATE applications SET deleted_at = now() WHERE id=$1`, [stuck]);
  const after = await scorecard.scorecardFor(vendor);
  eq(after.orders, 2, 'a deleted file stops counting against the vendor');
  eq(after.openNow, 0, 'and stops showing as work they are sitting on');

  const board = await scorecard.vendorLeaderboard({ contactType: 'title_company' });
  ok(board.some((v) => v.id === vendor), 'the vendor appears on the leaderboard');
  ok(board.every((v) => v.card && v.card.orders > 0), 'and every row on it has real orders behind it');
  eq(await scorecard.scorecardFor(null), null, 'no vendor id is null, never a throw');
  eq(Object.keys(await scorecard.scorecardsFor([])).length, 0, 'an empty ask is an empty answer');

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nvendor-scorecard — all checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
