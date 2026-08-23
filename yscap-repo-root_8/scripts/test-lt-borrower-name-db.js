'use strict';
/**
 * THE BORROWER'S NAME — compared without tripping on a comma, and SHOWN when we have it.
 *
 * Two defects the owner reported together on 2026-08-23, both about the same fact
 * (who the borrower is) and both making a correct book look broken.
 *
 *   1. Every row of the borrower-match screen read "The names are spelled
 *      differently — worth a second look", including "Bluming, Yisroel" against
 *      "Yisroel bluming". Case and word order were already handled; what was not is
 *      that ENCOMPASS WRITES A NAME AS "Last, First", so the comma stayed glued to
 *      the surname and no token ever matched. A warning that fires on every row is
 *      worse than no warning: it asked a human to second-guess a whole book of
 *      correct matches.
 *
 *   2. The pipeline's BORROWER column was a dash on every loan — on a book where
 *      discovery had stored the name Encompass gave us for every single one. The
 *      column read only the LINKED profile, and that link is made by a human on the
 *      very screen defect 1 had made unusable. Showing a dash over a fact we hold is
 *      the confident wrong answer in its cheapest form.
 *
 * The two are pinned together because they are one story: the match screen is how a
 * loan GETS a linked profile, and the pipeline is what looks broken until it does.
 */

const assert = require('assert');

async function main() {
  await require(`${__dirname}/lib/db-gate`).skipUnlessDb('lt-borrower-name');

  const match = require('../src/longterm/people/match');
  const db = require('../src/longterm/db');
  const pipeline = require('../src/longterm/pipeline');
  const columns = require('../src/longterm/pipeline-columns');

  let checks = 0;
  const ok = (c, w) => { assert.ok(c, w); console.log('  ok  ', w); checks++; };
  const eq = (a, b, w) => { assert.strictEqual(a, b, w); console.log('  ok  ', w); checks++; };

  // ── A. the owner's own four rows ───────────────────────────────────────────
  console.log('\nA. the four the owner was shown — all the same person, all flagged as different');
  for (const [enc, prof] of [
    ['Bluming, Yisroel', 'Yisroel bluming'],
    ['Bayer, Nisan', 'Nisan Bayer'],
    ['SPITZER, SHLOME', 'SHLOME SPITZER'],
    ['Goldberg, Avrohom', 'avrohom goldberg'],
  ]) {
    eq(match.nameLooksLike(enc, prof), true, `"${enc}" is "${prof}" — no second look needed`);
  }

  // ── B. what it must STILL warn about ───────────────────────────────────────
  // The expensive direction here is a false agreement that quietly waves two
  // different people onto one profile, so this half matters more than section A.
  console.log('\nB. two different people are still flagged');
  eq(match.nameLooksLike('Bluming, Yisroel', 'Nisan Bayer'), false, 'two unrelated names still warn');
  eq(match.nameLooksLike('Yisroel Bluming', 'Yisroel Katz'), false, 'a shared FIRST name is not a match');
  eq(match.nameLooksLike('Bluming, Yisroel', 'Shloime Bluming'), false, 'a shared SURNAME is not a match');
  eq(match.nameLooksLike('Bluming', 'Yisroel Bluming'), false,
    'a lone surname inside a full name is not evidence — it would gather a family onto one profile');
  eq(match.nameLooksLike('', 'Yisroel Bluming'), false, 'nothing on one side is never a match');
  eq(match.nameLooksLike('   ', 'Yisroel Bluming'), false, '…and neither is whitespace');

  // ── C. the ordinary shapes a real book carries ────────────────────────────
  console.log('\nC. the shapes a real Encompass book actually carries');
  eq(match.nameLooksLike('Katz Malky', 'Malky Katz'), true, 'word order, which already worked, still does');
  eq(match.nameLooksLike('Bluming, Yisroel M.', 'Yisroel Bluming'), true,
    'a middle initial on one side only is the same person');
  eq(match.nameLooksLike("O'Brien, Sean", "Sean O'Brien"), true, 'an apostrophe does not split a surname');
  eq(match.nameLooksLike('Klein, Bat-Sheva', 'Bat-Sheva Klein'), true, '…nor does a hyphen');

  // ── D. THE PIPELINE SHOWS THE NAME IT HAS ─────────────────────────────────
  console.log('\nD. the pipeline shows the name we already hold, on a loan nobody has linked');
  const tag = `bn${Date.now().toString(36)}`;
  const gid = `${tag}-guid`;
  await db.query(
    `INSERT INTO lt_loans (id, encompass_loan_guid, loan_number, borrower_name, stage_key,
                           program_name, term_months)
     VALUES (gen_random_uuid(), $1, $2, $3, 'setup', 'Investor DSCR', 360)`,
    [gid, `${tag}-LN`, 'Bluming, Yisroel']);

  const admin = { id: '00000000-0000-0000-0000-000000000001', role: 'super_admin', perms: {} };
  const out = await pipeline.loadPipeline(admin, {});
  const row = (out.rows || out.loans || []).find((r) => String(r.loan_number || '').startsWith(tag));
  ok(row, 'the loan is on the pipeline at all — an unlinked borrower never hides a loan');
  eq(row.borrower_name, 'Bluming, Yisroel',
    'THE ONE THAT MATTERS: the BORROWER column carries the name Encompass gave us, not a dash');
  eq(row.borrower_is_linked, false,
    '…and says nobody has matched it to a PILOT profile, so an unconfirmed name never passes for a confirmed one');

  // ── E. a linked profile still wins ────────────────────────────────────────
  // The fallback must not shadow the name a human actually confirmed, or correcting
  // a borrower's name in PILOT would silently do nothing on this screen.
  console.log('\nE. once a human links a profile, THAT name wins');
  const b = await db.query(
    `INSERT INTO borrowers (id, first_name, last_name, email)
     VALUES (gen_random_uuid(), 'Yisroel', 'Bluming', $1) RETURNING id, full_name`,
    [`${tag}@example.com`]);
  await db.query('UPDATE lt_loans SET borrower_id = $1 WHERE encompass_loan_guid = $2',
    [b.rows[0].id, gid]);
  const out2 = await pipeline.loadPipeline(admin, {});
  const row2 = (out2.rows || out2.loans || []).find((r) => String(r.loan_number || '').startsWith(tag));
  eq(row2.borrower_name, b.rows[0].full_name,
    'the linked profile\'s name is what shows — the Encompass copy is only a fallback');
  eq(row2.borrower_is_linked, true, '…and the row says so');

  // ── F. the SERVER decides the column ──────────────────────────────────────
  // The screen's own list is documented as a fallback for "a server too old to
  // answer", so setting the kind only there would have shipped a cell nothing draws.
  console.log('\nF. the server catalog is what tells the screen to draw it that way');
  const cat = columns.COLUMNS || (columns._internals && columns._internals.COLUMNS) || {};
  eq(cat.borrower && cat.borrower.kind, 'borrower',
    'the server names the borrower cell kind — the screen list alone would never reach production');

  await db.query('DELETE FROM lt_loans WHERE encompass_loan_guid = $1', [gid]);
  await db.query('DELETE FROM borrowers WHERE id = $1', [b.rows[0].id]);
  console.log(`\nall good — ${checks} checks`);
  process.exit(0);
}

main().catch((e) => { console.error('\nFAILED:', e && e.message); process.exit(1); });
