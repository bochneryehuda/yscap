'use strict';
/**
 * LT TERM SHEETS — against a REAL Postgres.
 *
 * The store's rules cannot be proven anywhere else: a unique index, a CHECK
 * constraint, a partial index, a `jsonb` round trip and a foreign key's ON
 * DELETE behaviour are all properties of the DATABASE, and a mocked client would
 * only ever prove that the mock agrees with itself.
 *
 * What is proven here:
 *   · a term sheet is WRITE-ONCE and survives losing the person who issued it
 *   · the ID resolves in every form a human types it, and NOTHING else
 *   · the stored snapshot still hashes to what was recorded — the whole value of
 *     a replay is that it shows what was SENT
 *   · RAW PRICING cannot be stored, on the sheet OR on a member, whoever writes
 *   · the cart is one per officer, positions are taken atomically, and it is not
 *     reachable from anybody else's session
 *
 * DB-GATED: with no DATABASE_URL it SKIPS and says so, like every other -db
 * suite here. A skip is honest; a pass without a database would not be.
 */

if (!process.env.DATABASE_URL) {
  console.log('SKIP test-lt-termsheet-db — no DATABASE_URL');
  process.exit(0);
}

const db = require('../src/longterm/db');
const store = require('../src/longterm/termsheet/store');
const snapshot = require('../src/longterm/termsheet/snapshot');
const code = require('../src/longterm/termsheet/code');

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
  ltv: 75, termYears: 30, dscr: 1.24, state: 'NJ', prepayMonths: 60, prepayStructure: '5 Year',
};
const quote = (label, ratePct, rawPrice, mode) => ({
  label, consumerLabel: 'Platinum', product: '30-Year Fixed DSCR', mode: mode || 'borrowerPaid',
  ratePct, rawPrice, scenario: SCENARIO, pricedAt: '2026-08-30T13:30:00.000Z',
});

(async () => {
  const staff = (await db.query(
    "INSERT INTO staff_users (id, email, full_name, role) VALUES (gen_random_uuid(), $1, 'TS Officer', 'loan_officer') RETURNING id",
    [`lt-ts-${U}@yscapgroup.com`],
  )).rows[0].id;
  const other = (await db.query(
    "INSERT INTO staff_users (id, email, full_name, role) VALUES (gen_random_uuid(), $1, 'Another Officer', 'loan_officer') RETURNING id",
    [`lt-ts2-${U}@yscapgroup.com`],
  )).rows[0].id;
  const borrower = (await db.query(
    "INSERT INTO borrowers (id, first_name, last_name, email) VALUES (gen_random_uuid(), 'Jonathan', 'Reyes', $1) RETURNING id",
    [`lt-ts-${U}@example.com`],
  )).rows[0].id;

  // =========================================================================
  section('issuing a term sheet');
  // =========================================================================
  // THE OWNER'S THREE OFFERS ON ONE SHEET: borrower-paid beside lender-paid,
  // which is why the comp mode lives on each MEMBER and not only on the sheet.
  const built = snapshot.buildSnapshot({
    selections: [
      quote('No points', 7.375, 102),
      quote('Buy the rate down', 6.875, 99.75),
      quote('Lender paid, fees waived', 7.625, 101.5, 'lenderPaid'),
    ],
    plan: PLAN,
    anchorIndex: 0,
    prepared: { borrowerName: 'Jonathan Reyes', officerName: 'Sara Klein' },
  });
  check(built.ok, `a mixed-mode comparison builds${built.ok ? '' : ` — ${built.error}`}`);

  const issued = await store.issueSheet({
    snapshot: built.snapshot,
    snapshotHash: snapshot.hashSnapshot(built.snapshot),
    compPlan: PLAN,
    staffId: staff,
    borrowerId: borrower,
    borrowerName: 'Jonathan Reyes',
  });
  check(code.isCode(issued.code), `a code is minted in the shape we mint (${issued.code})`);
  check(new Date(issued.expiresAt).getTime() > Date.now(), 'and it is good for a while yet');

  const members = (await db.query(
    "SELECT position, label, mode, waive_lender_fees FROM lt_term_sheet_scenario WHERE cart_id = $1::uuid AND parent_kind = 'sheet' ORDER BY position",
    [issued.id],
  )).rows;
  check(members.length === 3 && members.map((m) => m.position).join(',') === '0,1,2',
    'every option is stored, in the order it appears on the document');
  check(members.map((m) => m.mode).join(',') === 'borrowerPaid,borrowerPaid,lenderPaid',
    'EACH MEMBER KEEPS ITS OWN COMP MODE — the owner\'s three offers put borrower-paid and lender-paid side by side on ONE sheet');

  // =========================================================================
  section('pulling it up by the ID somebody read down a telephone');
  // =========================================================================
  for (const typed of [issued.code, issued.code.slice(3), issued.code.toLowerCase(), ` ${issued.code} `, issued.code.replace('-', '')]) {
    // eslint-disable-next-line no-await-in-loop
    const found = await store.findByCode(typed);
    check(found && found.code === issued.code, `found when typed as ${JSON.stringify(typed)}`);
  }
  check((await store.findByCode('TS-ZZZZZZ')) === null, 'an ID nobody issued finds nothing');
  check((await store.findByCode('nonsense')) === null, 'and junk finds nothing rather than throwing');

  const row = await store.findByCode(issued.code);
  const integrity = store.verifyIntegrity(row);
  check(integrity.ok,
    `THE STORED SNAPSHOT STILL HASHES TO WHAT WE RECORDED after a jsonb round trip — Postgres hands the object back in its own key order, so this is what proves the canonicalisation works${integrity.ok ? '' : ` (${integrity.reason})`}`);
  check(row.snapshot.members.length === 3 && row.kind === 'comparison', 'and the whole document comes back');

  // A replay must be able to SAY when it is looking at something that has been
  // altered, rather than presenting it as the document we sent.
  const tampered = JSON.parse(JSON.stringify(row.snapshot));
  tampered.members[0].ratePct = 9.99;
  await db.query('UPDATE lt_term_sheet SET snapshot = $2::jsonb WHERE id = $1::uuid', [issued.id, JSON.stringify(tampered)]);
  const after = store.verifyIntegrity(await store.findByCode(issued.code));
  check(!after.ok && after.reason === 'hash_mismatch',
    'a snapshot changed behind our back is REPORTED, never quietly served as authoritative');
  await db.query('UPDATE lt_term_sheet SET snapshot = $2::jsonb WHERE id = $1::uuid', [issued.id, JSON.stringify(row.snapshot)]);

  // =========================================================================
  section('raw pricing cannot be stored, whoever writes it');
  // =========================================================================
  // The application refuses it by name; this is the layer under that. A CHECK
  // constraint is the only thing that also binds a writer added next year.
  try {
    await db.query(
      "INSERT INTO lt_term_sheet (id, code, mode, snapshot_hash, expires_at) VALUES (gen_random_uuid(), $1, 'raw', 'x', now())",
      [`TS-RAW${U.slice(-3).toUpperCase()}`],
    );
    check(false, 'the database refuses a raw-priced SHEET');
  } catch (e) {
    check(e.code === '23514' && String(e.constraint).includes('mode'),
      `the database refuses a raw-priced SHEET (${e.constraint})`);
  }
  try {
    await db.query(
      "INSERT INTO lt_term_sheet_scenario (id, cart_id, parent_kind, position, mode) VALUES (gen_random_uuid(), $1::uuid, 'sheet', 99, 'raw')",
      [issued.id],
    );
    check(false, 'and a raw-priced MEMBER — covering the sheet whose first option is issuable while a later one is not');
  } catch (e) {
    check(e.code === '23514' && String(e.constraint).includes('mode'),
      `and a raw-priced MEMBER (${e.constraint}) — covering the sheet whose first option is issuable while a later one is not`);
  }

  // =========================================================================
  section('the comparison cart');
  // =========================================================================
  const a1 = await store.addToCart({ staffId: staff, member: { label: 'A', mode: 'borrowerPaid', scenario: SCENARIO } });
  const a2 = await store.addToCart({ staffId: staff, member: { label: 'B', mode: 'lenderPaid', scenario: SCENARIO } });
  check(a1.ok && a2.ok && a1.position === 0 && a2.position === 1,
    'positions are taken inside the INSERT, so two quick clicks cannot collide on the unique index');
  check((await store.readCart(staff)).members.length === 2, 'and both are in the cart');

  check((await store.setAnchor(staff, 1)).ok, 'the anchor can be moved to an option that is there');
  check(!(await store.setAnchor(staff, 9)).ok, '…and refused for one that is not, rather than pointing at nothing');
  check((await store.readCart(staff)).cart.anchor_position === 1, 'the move stuck');

  check(!(await store.removeFromCart(other, a1.id)).ok,
    'ANOTHER OFFICER CANNOT REACH THIS CART — the WHERE is the whole authorisation');
  check((await store.readCart(staff)).members.length === 2, '…and nothing of theirs was removed');
  check((await store.removeFromCart(staff, a1.id)).ok, 'its owner can');
  check(!(await store.removeFromCart(staff, a1.id)).ok, 'and removing the same thing twice does nothing');

  // One cart per officer is db/642's unique index, and it is what makes "start a
  // comparison" on a SECOND search add to the same one rather than open a rival.
  const c1 = await store.openCart(staff);
  const c2 = await store.openCart(staff);
  check(c1.id === c2.id, 'opening a comparison twice is the SAME comparison — the owner\'s "you go back into another search"');

  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await store.addToCart({ staffId: staff, member: { label: `x${i}`, mode: 'lenderPaid', scenario: SCENARIO } });
  }
  const over = await store.addToCart({ staffId: staff, member: { label: 'one too many', mode: 'lenderPaid', scenario: SCENARIO } });
  check(!over.ok && over.reason === 'full' && /catalogue/.test(over.message || ''),
    'past the cap it is refused with the reason, not silently dropped');
  check((await store.readCart(staff)).members.length === 8, 'and the cart holds exactly the cap');

  // =========================================================================
  section('issuing FROM the cart empties it, in one transaction');
  // =========================================================================
  const cartNow = await store.readCart(staff);
  const fromCart = await store.issueSheet({
    snapshot: built.snapshot,
    snapshotHash: snapshot.hashSnapshot(built.snapshot),
    compPlan: PLAN,
    staffId: staff,
    cartId: cartNow.cart.id,
  });
  check(code.isCode(fromCart.code), `a second sheet is issued (${fromCart.code})`);
  check(fromCart.code !== issued.code, 'with its own ID');
  check((await store.readCart(staff)).members.length === 0,
    'and the cart is emptied — leaving it would offer the officer a comparison they have already sent');

  // =========================================================================
  section('a term sheet outlives the people and the arrangements around it');
  // =========================================================================
  const list = await store.listForStaff(staff);
  check(list.length === 2 && list[0].option_count === 3,
    `both sheets are listed with what is on them (${list.length} sheets, ${list[0] && list[0].option_count} options on the newest)`);

  // The cart is scratch — and it is STILL SET NULL, not CASCADE. The first cut
  // of db/642 made it CASCADE on exactly the argument that reads best ("a cart
  // with no owner is unreachable anyway, since every read is scoped to me"), and
  // `test-lt-loan-schema-db` refused it — the same argument db/634's header
  // records being made and refused about the investor groups. The long-term side
  // holds "losing a person never deletes a row" as ONE uniform invariant, and an
  // invariant with a convenience exception is how invariants stop being believed.
  await store.addToCart({ staffId: staff, member: { label: 'left behind', mode: 'lenderPaid', scenario: SCENARIO } });
  const cartsBefore = (await db.query('SELECT count(*)::int AS n FROM lt_term_sheet_cart WHERE staff_id = $1::uuid', [staff])).rows[0].n;

  await db.query('DELETE FROM staff_users WHERE id = $1::uuid', [staff]);
  const cartsAfter = (await db.query(
    'SELECT count(*)::int AS n FROM lt_term_sheet_cart WHERE staff_id IS NULL AND created_at > now() - interval \'1 hour\'',
  )).rows[0].n;
  check(cartsBefore === 1 && cartsAfter >= 1,
    'even the CART is SET NULL rather than cascaded — it keeps its row and simply stops appearing, because every read is scoped to the person');

  const orphan = await store.findByCode(issued.code);
  check(orphan && orphan.created_by_staff === null,
    'LOSING THE OFFICER NEVER LOSES THE SHEET — every identity link on the long-term side is ON DELETE SET NULL, and an invariant with a convenience exception is how invariants stop being believed');
  check(store.verifyIntegrity(orphan).ok, '…and it still hashes true, so it still replays');

  await db.query('DELETE FROM lt_term_sheet WHERE id = ANY($1::uuid[])', [[issued.id, fromCart.id]]);
  await db.query('DELETE FROM staff_users WHERE id = $1::uuid', [other]);
  await db.query('DELETE FROM borrowers WHERE id = $1::uuid', [borrower]);

  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('THREW', e);
  process.exit(1);
});
