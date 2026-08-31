'use strict';
/**
 * LT — THE INVESTOR BEHIND AN ISSUED PRICE, against a REAL Postgres (db/651).
 *
 * The pure suite proves the RULE — what may be recorded, and that the document
 * cannot carry it. This proves the STORAGE, which no mock can: a `jsonb` round
 * trip, a `NOT NULL DEFAULT` on a column added to a table that already has rows,
 * the cart→sheet re-pointing, and — the one that matters most — that the row the
 * PDF and the replay are actually built from does not contain an investor's name.
 *
 * DB-GATED: with no DATABASE_URL it SKIPS and says so, like every other -db suite
 * here. A skip is honest; a pass without a database would not be.
 */

if (!process.env.DATABASE_URL) {
  console.log('SKIP test-lt-sheet-provenance-db — no DATABASE_URL');
  process.exit(0);
}

const db = require('../src/longterm/db');
const store = require('../src/longterm/termsheet/store');
const snapshot = require('../src/longterm/termsheet/snapshot');
const internal = require('../src/longterm/termsheet/internal');
const { ensureSchema } = require('../src/migrate-boot');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};
const section = (t) => console.log(`\n${t}`);

const U = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PLAN = { borrowerPaid: 2, ysp: 2, lenderPaid: 2, applicationFee: 500, commitmentFee: 1595 };
const SCENARIO = {
  purpose: 'Purchase', propertyType: 'Single family', value: 500000, loan: 375000,
  ltv: 75, termYears: 30, dscr: 1.24, fico: 740, state: 'NJ', city: 'Lakewood', zip: '08701',
  rentMonthly: 4161, taxMonthly: 620, insuranceMonthly: 145, hoaMonthly: 0,
  prepayMonths: 60, prepayStructure: '5 Year',
};
/** Real registry spellings, so a leak would be one the scrub itself recognises. */
const DEEPHAVEN = 'Deephaven Mortgage';
const VERUS = 'Verus Mortgage Capital';

const quote = (label, ratePct, rawPrice, prov) => ({
  label,
  consumerLabel: 'Platinum',
  product: '30-Year Fixed DSCR',
  mode: 'borrowerPaid',
  ratePct,
  rawPrice,
  scenario: SCENARIO,
  pricedAt: '2026-08-30T13:30:00.000Z',
  internal: prov || undefined,
});
const prov = (investor, program) => ({
  investor,
  investorKey: investor.split(' ')[0].toLowerCase(),
  lender: `${investor} LLC`,
  program,
  product: 'PRD-1',
  rateSheet: 'Wholesale 08/30 AM',
  rateGridId: 'grid-1188',
  rawPrice: 102,
  adjustedPoints: -1.25,
});

(async () => {
  /* ⛔ THE MIGRATIONS FIRST. Booting the server kicks them off asynchronously, so
     a suite that starts straight away races a brand-new column into existence and
     reads "does not exist" on the very run meant to prove it. */
  await ensureSchema();

  const staff = (await db.query(
    "INSERT INTO staff_users (id, email, full_name, role) VALUES (gen_random_uuid(), $1, 'Prov Officer', 'loan_officer') RETURNING id",
    [`lt-prov-${U}@yscapgroup.com`],
  )).rows[0].id;

  // ==========================================================================
  section('A. the column exists, and every existing row already answers');
  // ==========================================================================
  {
    const { rows } = await db.query(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'lt_term_sheet_scenario' AND column_name = 'internal'`,
    );
    check(rows.length === 1, 'A1 db/651 added the column');
    check(rows.length === 1 && rows[0].data_type === 'jsonb', 'A2 …as jsonb');
    check(rows.length === 1 && rows[0].is_nullable === 'NO', 'A3 …NOT NULL, so there is no third state to read');
    check(rows.length === 1 && /\{\}/.test(rows[0].column_default || ''),
      'A4 …defaulting to an empty object, which is what every sheet issued before this says');
    const { rows: none } = await db.query(
      "SELECT count(*)::int AS n FROM lt_term_sheet_scenario WHERE internal IS NULL",
    );
    check(none[0].n === 0, 'A5 no stored member anywhere carries a null');
  }

  // ==========================================================================
  section('B. an issued sheet records who was behind each price');
  // ==========================================================================
  let code = null;
  {
    const built = snapshot.buildSnapshot({
      selections: [
        quote('First', 7.375, 102, prov(DEEPHAVEN, 'DSCR Elite 30yr Fixed')),
        quote('Second', 7.625, 101, prov(VERUS, 'Investor Cash Flow')),
        quote('Third', 7.875, 100),
      ],
      plan: PLAN,
      prepared: { borrowerName: 'A Borrower', propertyAddress: '1 Main St, Lakewood, NJ 08701' },
    });
    check(built.ok, 'B1 a three-option comparison builds');
    const issued = await store.issueSheet({
      snapshot: built.snapshot,
      snapshotHash: snapshot.hashSnapshot(built.snapshot),
      compPlan: PLAN,
      staffId: staff,
      borrowerName: 'A Borrower',
      internal: built.internal,
    });
    code = issued.code;
    check(!!code, `B2 it was issued as ${code}`);

    const recs = await store.readInternal(issued.id);
    check(recs.length === 3, 'B3 three members, three records');
    check(recs[0].internal.investor === DEEPHAVEN && recs[1].internal.investor === VERUS,
      'B4 …each one against its own option, in the members\' order');
    check(recs[0].internal.program === 'DSCR Elite 30yr Fixed',
      'B5 …carrying THEIR programme name, which the document never prints');
    check(recs[0].internal.rawPrice === 102 && recs[0].internal.adjustedPoints === -1.25,
      'B6 …and the numbers survive the jsonb round trip as numbers');
    check(internal.isEmpty(recs[2].internal),
      'B7 the option nobody sent a record for stores an empty object, not a guess');
  }

  // ==========================================================================
  section('C. ⛔ the row the DOCUMENT is drawn from carries no investor');
  // ==========================================================================
  {
    const row = await store.findByCode(code);
    check(!!row, 'C1 the sheet is found by its code');
    const asText = JSON.stringify(row);
    check(!asText.includes('Deephaven') && !asText.includes('Verus'),
      'C2 nothing in that row names an investor — this is what `pdf.js` is handed');
    check(!asText.includes('DSCR Elite') && !asText.includes('grid-1188'),
      'C3 …nor their programme name or their grid id');
    check(store.verifyIntegrity(row).ok === true,
      'C4 …and the stored snapshot still hashes to what was recorded');
  }

  // ==========================================================================
  section('D. it survives the cart, which is where a comparison is assembled');
  // ==========================================================================
  {
    await store.clearCart(staff);
    const one = snapshot.buildMember(quote('Parked', 7.375, 102), PLAN);
    check(one.ok, 'D1 an option builds for the cart');
    const added = await store.addToCart({
      staffId: staff,
      member: {
        label: one.member.label,
        mode: one.member.mode,
        waiveLenderFees: one.member.waiveLenderFees,
        scenario: one.member.scenario,
        charges: one.member.charges,
        closing: one.member.closing,
        pricedAt: one.member.pricedAt,
        program: { consumerLabel: one.member.consumerLabel, ratePct: one.member.ratePct, rawPrice: 102 },
        internal: prov(DEEPHAVEN, 'DSCR Elite 30yr Fixed'),
      },
    });
    check(added.ok, 'D2 it is parked in the cart');
    const { members } = await store.readCart(staff);
    check(members.length === 1 && members[0].internal && members[0].internal.investor === DEEPHAVEN,
      'D3 the cart hands the record back, so an option parked today can be issued tomorrow');

    // Issue FROM the cart, exactly as the panel does: the members come back off
    // the cart and go up as selections again.
    const rebuilt = snapshot.buildSnapshot({
      selections: [quote('Parked', 7.375, 102, members[0].internal)],
      plan: PLAN,
      prepared: { borrowerName: 'A Borrower', propertyAddress: '1 Main St, Lakewood, NJ 08701' },
    });
    check(rebuilt.ok, 'D4 …and it re-builds from what the cart returned');
    const issued = await store.issueSheet({
      snapshot: rebuilt.snapshot,
      snapshotHash: snapshot.hashSnapshot(rebuilt.snapshot),
      compPlan: PLAN,
      staffId: staff,
      borrowerName: 'A Borrower',
      internal: rebuilt.internal,
      cartId: added.cartId,
    });
    const recs = await store.readInternal(issued.id);
    check(recs.length === 1 && recs[0].internal.investor === DEEPHAVEN,
      'D5 the issued sheet names the same investor the cart was holding');
    const { members: after } = await store.readCart(staff);
    check(after.length === 0, 'D6 …and the cart went with it, as it always did');
  }

  // ==========================================================================
  section('E. a caller cannot widen what is recorded by assembling its own list');
  // ==========================================================================
  {
    const built = snapshot.buildSnapshot({
      selections: [quote('Only', 7.375, 102)], plan: PLAN, prepared: { borrowerName: 'B' },
    });
    const issued = await store.issueSheet({
      snapshot: built.snapshot,
      snapshotHash: snapshot.hashSnapshot(built.snapshot),
      compPlan: PLAN,
      staffId: staff,
      borrowerName: 'B',
      // `issueSheet` is a public function, so this is what a caller that
      // assembled its own list would hand it. Only the declared fields survive.
      internal: [{ investor: DEEPHAVEN, ssn: '123-45-6789', borrowerName: 'A Real Person', buyRate: 6.5 }],
    });
    const recs = await store.readInternal(issued.id);
    check(recs[0].internal.investor === DEEPHAVEN, 'E1 the declared field is stored');
    check(!('ssn' in recs[0].internal) && !('borrowerName' in recs[0].internal) && !('buyRate' in recs[0].internal),
      'E2 ⛔ …and everything else is dropped at the store, not only at the door');
  }

  // ==========================================================================
  section('F. a member of somebody else\'s sheet is not readable by position');
  // ==========================================================================
  {
    // `readInternal` is keyed on the SHEET id, so a cart id must answer nothing:
    // the two share a table and only `parent_kind` tells them apart.
    const cart = await store.openCart(staff);
    const recs = await store.readInternal(cart.id);
    check(recs.length === 0, 'F1 a cart id reads no sheet members');
    check((await store.readInternal('not-a-uuid')).length === 0, 'F2 junk reads nothing rather than throwing');
    await store.clearCart(staff);
  }

  await db.query('DELETE FROM staff_users WHERE id = $1::uuid', [staff]);
  console.log('');
  if (failures) { console.error(`DB: ${failures} failed`); process.exit(1); }
  console.log('DB: all passed');
  process.exit(0);
})().catch((e) => {
  console.error('DB suite crashed:', e);
  process.exit(1);
});
