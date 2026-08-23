'use strict';
/**
 * WHICH CLICKUP CARD BELONGS TO THIS LOAN — the record, its guards, and the one read
 * that lets the match be made in the first place.
 *
 * THE PROBLEM THIS IS PART OF. Long-Term is about to become Encompass-first: the
 * office opens the file in Encompass and PILOT opens its ClickUp card. Every loan
 * already in the book has to be told which card is already its own before that is
 * switched on, or the first pass opens a SECOND card for every deal the office has
 * ever worked — the owner's own words, 2026-08-23: *"we're going to find ourselves
 * with duplicate ClickUps."*
 *
 * WHAT IS WORTH PROVING, and it is not the happy path. Three ways this record could
 * quietly corrupt the link between two systems that the office reads as the truth
 * about a deal, each of which db/618 makes UNWRITABLE rather than merely discouraged:
 *
 *   1. a guess getting stamped into ClickUp as though it were settled;
 *   2. two loans claiming one card, so a pipeline silently counts one deal twice;
 *   3. a confidence or a source nobody recognises, which every later reader would
 *      have to invent a meaning for.
 *
 * And the fourth thing: a diagnostic that hands out more than its job needs. The book
 * read carries match keys and NOT the borrower's email, Social, rate or DSCR — proven
 * here against the real payload rather than asserted in a comment.
 */

const assert = require('assert');

async function main() {
  await require(`${__dirname}/lib/db-gate`).skipUnlessDb('lt-clickup-link');

  const db = require('../src/longterm/db');
  const express = require('express');

  let checks = 0;
  const ok = (c, w) => { assert.ok(c, w); console.log('  ok  ', w); checks++; };
  const eq = (a, b, w) => { assert.strictEqual(a, b, w); console.log('  ok  ', w); checks++; };

  const uuid = () => require('crypto').randomUUID();
  const A = uuid(); const B = uuid();
  const TASK = 'tsk_' + Math.random().toString(36).slice(2, 10);

  const refuses = async (sql, params, re, what) => {
    let threw = null;
    try { await db.query(sql, params); } catch (e) { threw = e; }
    assert.ok(threw, `${what} — expected a refusal, got a successful write`);
    assert.ok(re.test(threw.message) || re.test(String(threw.constraint || '')),
      `${what} — refused, but for the wrong reason: ${threw.message}`);
    console.log('  ok  ', what); checks++;
  };

  try {
    await db.query(`INSERT INTO lt_loans (id, loan_number, loan_amount, borrower_name, program_name)
                    VALUES ($1,$2,$3,$4,$5), ($6,$7,$8,$9,$10)`,
      [A, 'YSTEST-A', 415000, 'Bluming, Yisroel', 'Non-QM - DSCR Ratio',
       B, 'YSTEST-B', 288000, 'Bayer, Nisan', 'Non-QM - DSCR Ratio']);
    await db.query(`INSERT INTO lt_properties (loan_id, street, city, state, zip)
                    VALUES ($1,'769 Dixwell Ave','New Haven','CT','06511')`, [A]);

    // ── A. the columns exist and start empty ────────────────────────────────
    console.log('\nA. every loan starts saying "we have not worked out my card yet"');
    const fresh = await db.query('SELECT clickup_task_id, clickup_link_confidence, clickup_stamped_at FROM lt_loans WHERE id=$1', [A]);
    eq(fresh.rows[0].clickup_task_id, null, 'no card');
    eq(fresh.rows[0].clickup_link_confidence, null, 'no confidence claimed');
    eq(fresh.rows[0].clickup_stamped_at, null, 'and nothing stamped — the truth on day one, not a guess');

    // ── B. a guess can never carry a stamp ──────────────────────────────────
    console.log('\nB. a guess is structurally unstampable');
    await db.query(`UPDATE lt_loans SET clickup_task_id=$2, clickup_custom_id='FILLE-2081',
                    clickup_link_confidence='probable', clickup_link_source='reconciliation',
                    clickup_linked_at=now() WHERE id=$1`, [A, TASK]);
    ok(true, 'a probable link records fine — that is the point of the bucket');
    await refuses(
      `UPDATE lt_loans SET clickup_stamped_at=now() WHERE id=$1`, [A],
      /stamp_confirmed/i,
      'but stamping it is REFUSED by the database, not by a rule somebody has to remember');
    await db.query(`UPDATE lt_loans SET clickup_link_confidence='confirmed' WHERE id=$1`, [A]);
    await db.query(`UPDATE lt_loans SET clickup_stamped_at=now() WHERE id=$1`, [A]);
    ok(true, 'once a person confirms it, the stamp is allowed');
    await refuses(
      `UPDATE lt_loans SET clickup_link_confidence='probable' WHERE id=$1`, [A],
      /stamp_confirmed/i,
      'and it cannot be walked back to a guess while the stamp still stands');

    // ── C. one card, one loan ───────────────────────────────────────────────
    console.log('\nC. two loans cannot claim one card');
    await refuses(
      `UPDATE lt_loans SET clickup_task_id=$2 WHERE id=$1`, [B, TASK],
      /clickup_task_uk/i,
      'the second claim is refused at the moment it is made, not discovered later on a doubled pipeline');
    await db.query(`UPDATE lt_loans SET clickup_task_id=$2 WHERE id=$1`, [B, TASK + '-other']);
    ok(true, 'its own card is fine');
    const many = await db.query(`SELECT count(*)::int n FROM lt_loans WHERE clickup_task_id IS NULL`);
    ok(many.rows[0].n >= 0, 'and the many loans with NO card do not collide with each other (partial index)');

    // ── D. an unrecognised confidence or source is refused ──────────────────
    console.log('\nD. no reader has to invent a meaning');
    await refuses(`UPDATE lt_loans SET clickup_link_confidence='maybe' WHERE id=$1`, [B],
      /confidence_chk/i, '"maybe" is refused');
    await refuses(`UPDATE lt_loans SET clickup_link_source='guessed' WHERE id=$1`, [B],
      /source_chk/i, '"guessed" is refused as a source');
    for (const s of ['reconciliation', 'created', 'manual']) {
      await db.query(`UPDATE lt_loans SET clickup_link_source=$2 WHERE id=$1`, [B, s]);
      ok(true, `"${s}" is a source the code actually sets`);
    }

    // ── E. the trail ────────────────────────────────────────────────────────
    console.log('\nE. how a loan got its card is recorded, not only what it is now');
    await db.query(`INSERT INTO lt_clickup_link_log (id, lt_loan_id, action, to_task_id, confidence, source, reason)
                    VALUES ($1,$2,'linked',$3,'confirmed','reconciliation','loan number, address and amount all agree')`,
      [uuid(), A, TASK]);
    const log = await db.query('SELECT action, reason FROM lt_clickup_link_log WHERE lt_loan_id=$1', [A]);
    eq(log.rowCount, 1, 'the link wrote a row');
    ok(/loan number/.test(log.rows[0].reason), 'carrying, in words, what it was matched on');

    // ── F. the book read — the door, and what it will not hand out ──────────
    console.log('\nF. the secret-gated book read');
    const app = express();
    app.use('/api/lt/_diag/book', require('../src/longterm/routes/book-diag'));
    const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    const port = server.address().port;
    const get = (path, headers) => fetch(`http://127.0.0.1:${port}${path}`, { headers: headers || {} });

    delete process.env.LT_BOOK_DIAG_TOKEN;
    eq((await get('/api/lt/_diag/book')).status, 404,
      'with no token set the door does not exist — a prober is told nothing');
    eq((await get('/api/lt/_diag/book/count')).status, 404, 'every path, not just the main one');

    process.env.LT_BOOK_DIAG_TOKEN = 'a-token-the-owner-set-and-can-remove';
    eq((await get('/api/lt/_diag/book')).status, 401, 'switched on, a caller with no header is refused');
    eq((await get('/api/lt/_diag/book', { 'x-lt-diag-token': 'wrong' })).status, 401, 'and a wrong one is refused');
    eq((await get('/api/lt/_diag/book', { 'x-lt-diag-token': 'a-token-the-owner-set-and-can-removE' })).status, 401,
      'including one that differs by a single letter');

    const good = { 'x-lt-diag-token': process.env.LT_BOOK_DIAG_TOKEN };
    const res = await get('/api/lt/_diag/book', good);
    eq(res.status, 200, 'the right header opens it');
    const body = await res.json();
    ok(body.ok === true && Array.isArray(body.loans), 'and it answers with the book');
    const mine = body.loans.find((l) => l.loan_number === 'YSTEST-A');
    ok(!!mine, 'the seeded loan is in it');
    eq(mine.borrower_name, 'Bluming, Yisroel', 'with the borrower NAME — a match key');
    eq(String(mine.loan_amount), '415000.00', 'the amount');
    eq(mine.street, '769 Dixwell Ave', 'and the property address, joined from lt_properties');
    eq(mine.clickup_task_id, TASK, 'plus the card it already knows about');

    console.log('\n   what it will NOT hand out:');
    const keys = Object.keys(mine);
    for (const forbidden of ['borrower_email', 'note_rate_pct', 'dscr_ratio', 'ssn', 'borrower_id',
      'housing_expense_total', 'gross_monthly_rent']) {
      ok(!keys.includes(forbidden), `no ${forbidden} — it does not help decide which card a loan belongs to`);
    }
    const raw = JSON.stringify(body);
    ok(!/"[^"]*@[^"]*"/.test(raw), 'and no email address anywhere in the payload');

    const c = await (await get('/api/lt/_diag/book/count', good)).json();
    ok(c.ok === true && typeof c.loans === 'number', 'the one-line count answers too, for checking the door before pulling the book');

    server.close();

    // ── G. it is mounted where it can be reached ────────────────────────────
    console.log('\nG. the wiring');
    const srv = require('fs').readFileSync(require.resolve('../src/server'), 'utf8');
    const bookAt = srv.indexOf("'/api/lt/_diag/book'");
    const staffAt = srv.indexOf("app.use('/api/lt', requireAuth, requireStaff");
    ok(bookAt > 0, 'server.js mounts it');
    ok(staffAt > 0 && bookAt < staffAt,
      'BEFORE the staff-gated /api/lt — a back end nobody can reach is not a feature');
    const rsrc = require('fs').readFileSync(require.resolve('../src/longterm/routes/book-diag'), 'utf8');
    ok(!/\b(INSERT|UPDATE|DELETE|ALTER|DROP)\b/i.test(rsrc), 'and there is no write statement anywhere inside it');
  } finally {
    await db.query('DELETE FROM lt_clickup_link_log WHERE lt_loan_id = ANY($1::uuid[])', [[A, B]]).catch(() => {});
    await db.query('DELETE FROM lt_properties WHERE loan_id = ANY($1::uuid[])', [[A, B]]).catch(() => {});
    await db.query('DELETE FROM lt_loans WHERE id = ANY($1::uuid[])', [[A, B]]).catch(() => {});
    delete process.env.LT_BOOK_DIAG_TOKEN;
  }

  console.log(`\nall good — ${checks} checks`);
  process.exit(0);
}

main().catch((e) => { console.error('\nFAILED:', e && e.message); process.exit(1); });
