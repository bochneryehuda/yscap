/**
 * THE MISSING-INVESTOR REVIEW, AGAINST A REAL POSTGRES.
 *
 * ── WHAT THIS PROVES, AND WHY EACH PART NEEDS A DATABASE ───────────────────
 * The owner's rule (2026-09-03) is that an investor the second rate sheet answered about and did
 * not carry is left off the board *"silently"*, the super admin is emailed, and the search is
 * recorded for review. Four of those properties are SQL properties and a pure test cannot see any
 * of them:
 *
 *   1. ONE ROW PER INVESTOR PER DAY, COUNTED. A search asks the sheets once per DSCR band, so
 *      without the unique index one press of Search files seven identical rows. The count is what
 *      answers a reviewer's first question — "is this every search, or one odd scenario?"
 *   2. THE EMAIL GOES OUT ONCE. The claim is an `IS NULL`-guarded UPDATE taken BEFORE the send;
 *      two searches finishing in the same second would otherwise both read "not told yet".
 *   3. A FAILED SEND GIVES THE CLAIM BACK. The stamp means "somebody was told", not "we tried" —
 *      leaving it set after a provider blip would silence that investor for the rest of the day.
 *   4. AN UNREADABLE LOG SAYS SO rather than answering with an empty list, which would read as
 *      "nothing has ever gone wrong" — the one thing this record may never claim.
 *
 * The mailer is STUBBED and INSPECTED: a send against a `none` provider succeeds whatever it was
 * handed, so asserting on the return value proves nothing about who was addressed.
 *
 * Needs DATABASE_URL. Skips cleanly without one.
 */
'use strict';
const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..');

if (!process.env.DATABASE_URL) {
  console.log('SKIP test-lt-source-misses-db: DATABASE_URL not set');
  process.exit(0);
}

/* The mailer is replaced BEFORE the module under test is required, so it can never
   reach a real provider and every send is inspected rather than trusted. */
const sent = [];
let mailFails = false;
const mailPath = require.resolve(path.join(ROOT, 'src/lib/email'));
require(mailPath);
require.cache[mailPath].exports = {
  sendMail: async (payload) => {
    if (mailFails) throw new Error('the provider refused');
    sent.push(payload);
    return { ok: true };
  },
};

const db = require(path.join(ROOT, 'src/longterm/db'));
const misses = require(path.join(ROOT, 'src/longterm/pricing/source-misses'));

let pass = 0;
const ok = (c, n) => { assert.ok(c, n); pass++; console.log('  ok  ' + n); };
const eq = (a, b, n) => { assert.deepStrictEqual(a, b, `${n} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); pass++; console.log('  ok  ' + n); };

const SC = {
  purpose: 'Purchase', state: 'CT', county: 'Hartford', zip: '06001',
  value: 500000, loan: 375000, fico: 760, dscr: 1.3, prepayMonths: 60,
  // Two things that must NEVER be recorded, handed in deliberately.
  borrowerName: 'A Real Person', ssn: '123-45-6789',
};

const KEY = 'ztest_misses_investor';
const KEY2 = 'ztest_misses_other';

async function clean() {
  await db.query('DELETE FROM lt_pricing_source_misses WHERE investor_key LIKE $1', ['ztest_%']);
}

(async () => {
  await clean();

  console.log('\nA · the table is there, and it is Long-Term’s own');
  {
    const r = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'lt_pricing_source_misses'`);
    const cols = r.rows.map((x) => x.column_name).sort();
    for (const c of ['investor_key', 'source', 'seen_day', 'hits', 'other_source_had', 'scenario', 'alerted_at', 'reviewed_at']) {
      ok(cols.includes(c), `A1 the column ${c} exists — a phantom column inside a swallowing catch reads as "nothing to record", for ever`);
    }
    const u = await db.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'lt_pricing_source_misses' AND indexname = 'lt_pricing_source_misses_day_uk'`);
    ok(u.rows.length === 1 && /UNIQUE/.test(u.rows[0].indexdef),
      'A2 the (investor, source, day) key is UNIQUE — that index IS the "one row per day, counted" rule');
  }

  console.log('\nB · one search, one row — and the scenario is an allowlist');
  {
    const r = await misses.record([{ key: KEY, label: 'Test Investor', otherSourceHad: true }],
      { source: 'loannex', scenario: SC, note: 'the sheet answered and did not carry them' });
    eq(r.ok, true, 'B1 the miss is recorded');
    eq(r.recorded, 1, 'B1b one investor, one record');

    const row = (await db.query('SELECT * FROM lt_pricing_source_misses WHERE investor_key = $1', [KEY])).rows[0];
    eq(row.hits, 1, 'B2 the first search counts one');
    eq(row.other_source_had, true, 'B3 whether the OTHER sheet had them is recorded — the owner’s own question');
    eq(row.scenario.loan, 375000, 'B4 the loan’s shape is recorded, so the miss can be re-run');
    ok(!('borrowerName' in row.scenario), 'B5 THE BORROWER’S NAME IS NOT — the scenario is an allowlist, never a redaction');
    ok(!('ssn' in row.scenario), 'B5b …and neither is anything else the search happened to carry');
  }

  console.log('\nC · the same investor again the same day is a COUNT, never a second row');
  {
    await misses.record([{ key: KEY, label: 'Test Investor', otherSourceHad: false }],
      { source: 'loannex', scenario: { ...SC, loan: 400000 } });
    const rows = (await db.query('SELECT * FROM lt_pricing_source_misses WHERE investor_key = $1', [KEY])).rows;
    eq(rows.length, 1, 'C1 still ONE row — a search asks the sheets once per band, so this is what stops seven rows a press');
    eq(rows[0].hits, 2, 'C2 …with the count moved on');
    eq(rows[0].scenario.loan, 400000, 'C3 the NEWEST search’s facts win — a reviewer wants the most recent example');
    eq(rows[0].other_source_had, false, 'C3b …including whether the other sheet had them this time');
  }

  console.log('\nD · the super admin is told ONCE');
  {
    eq(sent.length, 1, 'D1 exactly one email went out — the first sighting, not the second');
    const m = sent[0];
    ok(Array.isArray(m.to) && m.to.length > 0, 'D2 …addressed to somebody');
    ok(/did not carry/.test(m.subject), 'D3 the subject says what happened');
    ok(/Test Investor/.test(m.text), 'D4 the body names the investor');
    ok(/Hartford, CT/.test(m.text), 'D5 …and the loan, so it can be acted on without opening anything');
    ok(!/A Real Person|123-45-6789/.test(m.text + m.html), 'D6 and nothing about the borrower reaches it');

    const row = (await db.query('SELECT alerted_at FROM lt_pricing_source_misses WHERE investor_key = $1', [KEY])).rows[0];
    ok(row.alerted_at, 'D7 the row records that somebody was told, where a reviewer is already looking');
  }

  console.log('\nE · a failed send GIVES THE CLAIM BACK');
  {
    const before = sent.length;
    mailFails = true;
    await misses.record([{ key: KEY2, label: 'Other Investor', otherSourceHad: null }],
      { source: 'loannex', scenario: SC });
    eq(sent.length, before, 'E1 nothing was sent');
    let row = (await db.query('SELECT alerted_at, hits FROM lt_pricing_source_misses WHERE investor_key = $1', [KEY2])).rows[0];
    ok(row && !row.alerted_at,
      'E2 THE STAMP IS OFF — it means "somebody was told", not "we tried", so a two-second blip cannot silence this investor for the day');

    mailFails = false;
    await misses.record([{ key: KEY2, label: 'Other Investor' }], { source: 'loannex', scenario: SC });
    row = (await db.query('SELECT alerted_at, hits FROM lt_pricing_source_misses WHERE investor_key = $1', [KEY2])).rows[0];
    eq(row.hits, 2, 'E3 the second search counts…');
    ok(row.alerted_at,
      'E4 …and because the claim was given back, the alert is sent on the retry rather than lost');
    ok(sent.some((m) => /Other Investor/.test(m.text)), 'E4b …naming the right investor');
  }

  console.log('\nF · a sheet that did not answer records nothing');
  {
    const before = (await db.query('SELECT count(*)::int AS n FROM lt_pricing_source_misses WHERE investor_key LIKE $1', ['ztest_%'])).rows[0].n;
    const r = await misses.record([], { source: 'loannex', scenario: SC });
    eq(r.recorded, 0, 'F1 an empty miss list records nothing');
    const after = (await db.query('SELECT count(*)::int AS n FROM lt_pricing_source_misses WHERE investor_key LIKE $1', ['ztest_%'])).rows[0].n;
    eq(after, before, 'F1b …and files no row — one outage is not forty missing investors');
  }

  console.log('\nG · the review list, and marking one looked at');
  {
    const l = await misses.list({});
    eq(l.ok, true, 'G1 the log reads');
    const mine = l.rows.filter((x) => x.investor_key.startsWith('ztest_'));
    eq(mine.length, 2, 'G2 both investors are on the list');
    ok(mine.every((x) => !x.reviewed_at), 'G3 …and nobody has looked at either yet');
    eq(l.openCount >= 2, true, 'G3b the waiting count says so');

    const target = mine[0];
    const r = await misses.review(target.id, { note: 'they have no product in Connecticut', staffId: null });
    eq(r.ok, true, 'G4 a row can be marked looked at');
    const after = await misses.list({ openOnly: true });
    ok(!after.rows.some((x) => x.id === target.id), 'G5 …and drops out of the waiting list');
    const all = await misses.list({});
    const settled = all.rows.find((x) => x.id === target.id);
    ok(settled && settled.review_note === 'they have no product in Connecticut',
      'G6 the reviewer’s own note is kept — the record is what somebody FOUND, not only that they clicked');

    const back = await misses.review(target.id, { reviewed: false });
    eq(back.ok, true, 'G7 …and a row settled by mistake can be put back');
    const reopened = await misses.list({ openOnly: true });
    ok(reopened.rows.some((x) => x.id === target.id), 'G7b …into the waiting list');

    const missing = await misses.review('999999999', {});
    eq(missing.ok, false, 'G8 a row that does not exist is refused, never silently ignored');
  }

  console.log('\nH · an unreadable log SAYS so');
  {
    const real = db.query;
    db.query = async () => { throw new Error('the log is unreachable'); };
    const l = await misses.list({});
    db.query = real;
    eq(l.ok, false,
      'H1 A READ THAT FAILED IS REPORTED — answering with an empty list would read as "nothing has ever gone wrong"');
    ok(l.problem, 'H1b …and says why');

    db.query = async () => { throw new Error('the log is unreachable'); };
    const r = await misses.record([{ key: 'ztest_unreachable' }], { source: 'loannex', scenario: SC });
    db.query = real;
    eq(r.ok, false, 'H2 a write that failed is reported…');
    ok(r.problem, 'H2b …and never throws into the search that has already answered');
  }

  await clean();
  console.log('\n' + pass + ' checks passed\n');
  process.exit(0);
})().catch((e) => { console.error('\nFAILED: ' + (e && e.message) + '\n'); process.exit(1); });
