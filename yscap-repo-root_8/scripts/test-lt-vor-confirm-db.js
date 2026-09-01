#!/usr/bin/env node
'use strict';
/**
 * LT — THE RENT FORM IS CONFIRMED BEFORE ANYTHING GOES TO THE LANDLORD.
 *
 * Owner-directed 2026-08-31: *"The verification of rent form fill-out — while we
 * fill in — needs to be confirmed before you can order the VOR. Right now it
 * sounds like it's two different sections: the order, and the actual form we fill
 * in. That needs to be confirmed before."*
 *
 * ── THE TWO SECTIONS ARE REAL, AND BOTH HAVE TO REFUSE ──────────────────────
 *
 * The ORDER is the letter to the landlord (the orders desk, kind `vor`); the FORM
 * is the owner's own blank with items 1 to 9 drawn onto it (the rent desk, sent by
 * DocuSign or as an attachment). Gating one and not the other is the class this
 * repo names by name — the screen hides a button and the door accepts it anyway —
 * so both are proven here.
 *
 * ── AND A CONFIRMATION IS ABOUT THE VERSION IT WAS GIVEN FOR ────────────────
 *
 * Confirm-then-edit would otherwise send content nobody confirmed, and the
 * landlord answers the version we sent. So a save that CHANGES the form clears
 * it, while a save that changes nothing — the ordinary autosave echo — leaves it
 * standing, or the desk would un-confirm itself under somebody reading it.
 *
 * ── PROVEN TO FAIL ──────────────────────────────────────────────────────────
 *
 * Six mutations, each with a green control either side: removing the gate so the
 * form goes out unconfirmed (4 fails — and the send genuinely reached the mailer,
 * which is the point); leaving the ORDER ungated so only one of the owner's two
 * sections refuses (1); dropping the un-confirm, so confirm-then-edit ships
 * content nobody agreed to (2); letting a half-empty form be confirmed (2); the
 * route gone, so the gate has no way through it (1); and the screen offering no
 * button (1).
 *
 * The first of those crashed the battery on its first run rather than failing —
 * a send that goes THROUGH answers with no `blockers` at all — so the assertion
 * reads through a total accessor now. A crashing test looks like proof and is not.
 *
 * DB-GATED.
 */
const crypto = require('crypto');

let pass = 0;
const fails = [];
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); return; }
  fails.push(detail ? `${name} — ${detail}` : name);
  console.log('  ✗ ' + name + (detail ? ` — ${detail}` : ''));
};

(async () => {
  await require(__dirname + '/lib/db-gate').skipUnlessDb('lt-vor-confirm');
  const { ensureSchema } = require('../src/migrate-boot.js');
  const db = require('../src/db.js');
  const desk = require('../src/longterm/vor/desk.js');
  const F = require('../src/longterm/vor/fields.js');
  const orderData = require('../src/longterm/orders/data.js');

  await ensureSchema();

  const cx = await db.pool.connect();
  let failed = false;
  try {
    await cx.query('BEGIN');
    const stamp = Date.now();

    const borrower = (await cx.query(
      `INSERT INTO borrowers (first_name, last_name, email) VALUES ('Vor','Probe',$1) RETURNING id`,
      [`vor-confirm-${stamp}@example.test`])).rows[0].id;
    const loanId = crypto.randomUUID();
    await cx.query(
      `INSERT INTO lt_loans (id, borrower_id, loan_number, program_name)
       VALUES ($1::uuid,$2::uuid,$3,'DSCR 30yr')`, [loanId, borrower, `VORC-${stamp}`]);
    await cx.query(
      `INSERT INTO lt_properties (loan_id, street, city, state, zip, unit_count, gse_property_type)
       VALUES ($1::uuid,'4 Rent Way','Anytown','NJ','07001',1,'SFR')`, [loanId]);

    /* A LANDLORD ON THE FILE, deliberately: without one the send refuses for a
       different reason and the sentence a person reads is somebody else's. The
       gate is only proven when it is the ONLY thing left standing. */
    const card = (await cx.query(
      `INSERT INTO service_contacts (contact_type, company_name, contact_name, email)
       VALUES ('landlord',$1,'Rivka Stein',$2) RETURNING id`,
      [`Rent Management ${stamp}`, `landlord-${stamp}@example.test`])).rows[0].id;
    await cx.query(
      `INSERT INTO lt_loan_vendors (loan_id, kind, service_contact_id, is_primary)
       VALUES ($1::uuid,'landlord',$2::uuid,true)`, [loanId, card]);

    /** Every one of OUR OWN answers, so `missing` is empty and the only thing left
     *  standing between the form and the landlord is the confirmation itself. */
    const fullAnswers = () => {
      const out = {};
      for (const f of F.FIELDS) {
        if (f.who !== 'us' || f.optional) continue;
        out[f.key] = `answer for ${f.key}`;
      }
      return out;
    };

    // ── A. IT REFUSES A HALF-EMPTY FORM ─────────────────────────────────────
    console.log('\nA. CONFIRMING A FORM WITH BLANKS IS REFUSED');
    {
      await desk.saveForm(loanId, { ll_name: 'ignored' }, null, cx);
      const out = await desk.confirmForm(loanId, null, cx);
      ok(out.ok === false && out.reason === 'fields',
        'a form still missing our own answers cannot be confirmed — nobody is asked to agree to blanks',
        JSON.stringify({ ok: out.ok, reason: out.reason }));
      const { rows } = await cx.query(`SELECT confirmed_at FROM lt_vor_forms WHERE loan_id = $1::uuid`, [loanId]);
      ok(!rows.length || rows[0].confirmed_at === null, '…and nothing was recorded');
    }

    // ── B. THE SEND REFUSES UNTIL IT IS CONFIRMED ───────────────────────────
    console.log('\nB. THE FORM DOES NOT GO OUT UNTIL SOMEBODY CONFIRMS IT');
    await desk.saveForm(loanId, fullAnswers(), null, cx);
    {
      const form = await desk.loadForm(loanId, cx);
      ok(F.missing(form.data).length === 0, 'CONTROL: our own answers are all in now', JSON.stringify(F.missing(form.data)));
      const blocked = desk._internals.blockersFor({ form, method: 'email', envelopes: [] });
      ok(blocked.includes('not_confirmed'),
        'THE ONE THAT MATTERS: an unconfirmed form is refused', blocked.join(', '));
      ok(!blocked.includes('fields'),
        '…and it is the CONFIRMATION being asked for, not the fields — they are already in');
      /* Read through a total accessor: a mutation that lets the send THROUGH
         answers with no `blockers` at all, and `sent.blockers.includes` would
         then throw — which stops the battery where it stands and reports a pass
         rate that means nothing. An assertion must fail, not crash. */
      const sent = await desk.send(loanId, { method: 'email', db: cx });
      const sentBlockers = Array.isArray(sent && sent.blockers) ? sent.blockers : [];
      ok(sent && sent.ok === false && sentBlockers.includes('not_confirmed'),
        '…and the real send door refuses it, not only the screen',
        JSON.stringify({ ok: sent && sent.ok, blockers: sentBlockers, reason: sent && sent.reason }));
      ok(/confirm/i.test((sent && sent.message) || ''), '…in words that say what to do', String(sent && sent.message));
    }

    // ── C. THE ORDER REFUSES TOO — the owner's OTHER section ────────────────
    console.log('\nC. AND SO DOES THE ORDER, WHICH IS THE OWNER\'S OTHER SECTION');
    {
      const data = await orderData.getOrderData(loanId, cx);
      ok(data && data.vorFormConfirmed === false, 'the order desk reads the form as unconfirmed', JSON.stringify(data && data.vorFormConfirmed));
      const b = orderData.blockers('vor', data);
      ok(b.includes('form_not_confirmed'), 'THE ONE THAT MATTERS: the rent ORDER is blocked as well', b.join(', '));
      ok(/confirm/i.test(orderData.blockerText('form_not_confirmed', 'vor', data) || ''),
        '…with a sentence that sends the reader to the form', String(orderData.blockerText('form_not_confirmed', 'vor', data)));
      // …and it is the RENT order alone. Every other kind encloses a fixed blank
      // or nothing, so gating them on a rent form would refuse orders for no reason.
      const others = ['title', 'insurance', 'payoff', 'condo'].filter((k) => orderData.blockers(k, data).includes('form_not_confirmed'));
      ok(others.length === 0, 'and NO other order is held up by it', others.join(', '));
    }

    // ── D. CONFIRMED, AND IT GOES ───────────────────────────────────────────
    console.log('\nD. CONFIRMED — AND BOTH SECTIONS OPEN');
    {
      const out = await desk.confirmForm(loanId, null, cx);
      ok(out.ok === true && !!out.confirmedAt, 'a complete form confirms', JSON.stringify(out));
      const form = await desk.loadForm(loanId, cx);
      ok(!desk._internals.blockersFor({ form, method: 'email', envelopes: [] }).includes('not_confirmed'),
        'the form is no longer held', '');
      const data = await orderData.getOrderData(loanId, cx);
      ok(!orderData.blockers('vor', data).includes('form_not_confirmed'),
        'and neither is the order', orderData.blockers('vor', data).join(', '));
    }

    // ── E. AN EDIT ASKS FOR IT AGAIN — AND AN ECHO DOES NOT ─────────────────
    console.log('\nE. A CHANGE UN-CONFIRMS IT; SAVING THE SAME THING AGAIN DOES NOT');
    {
      // The ordinary autosave: the same values, saved again.
      const echo = await desk.saveForm(loanId, fullAnswers(), null, cx);
      ok(!!echo.confirmedAt,
        'saving the same answers again leaves the confirmation standing — an autosave is not an edit',
        JSON.stringify(echo.confirmedAt));

      // A real edit.
      const changed = await desk.saveForm(loanId, { landlord_block: 'Somebody Else\nSomewhere Else' }, null, cx);
      ok(changed.confirmedAt === null,
        'THE ONE THAT MATTERS: changing the form un-confirms it — confirm-then-edit can never send content nobody agreed to',
        JSON.stringify(changed.confirmedAt));
      const form = await desk.loadForm(loanId, cx);
      ok(desk._internals.blockersFor({ form, method: 'email', envelopes: [] }).includes('not_confirmed'),
        '…and the send is held again until somebody reads it through');
    }

    // ── F. THE DOORS ARE WIRED ──────────────────────────────────────────────
    console.log('\nF. THE DESK AND THE SCREEN ARE WIRED TO IT');
    {
      const fs = require('fs');
      const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
      const route = strip(fs.readFileSync(require.resolve('../src/longterm/routes/vor.js'), 'utf8'));
      ok(/desk\.confirmForm\(/.test(route) && /\/confirm'/.test(route),
        'there is a door to confirm it — a gate with no way through is a dead end');
      const screen = strip(fs.readFileSync(require.resolve('../app-v2/src/longterm/LtVor.jsx'), 'utf8'));
      ok(/ltApi\.vorConfirm\(/.test(screen), 'and the screen really offers the button');
      ok(/state\.confirmedAt/.test(screen), '…and says which state the form is in');
      ok(!/var\(--ink/.test(screen), 'every colour on it is an explicit dark, never an --ink token');
    }

    if (fails.length) failed = true;
    await cx.query('ROLLBACK');
  } catch (e) {
    failed = true;
    console.error('  ✗ threw: ' + ((e && e.stack) || e));
    try { await cx.query('ROLLBACK'); } catch (_) { /* already gone */ }
  } finally {
    cx.release();
    await db.pool.end();
  }

  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (failed || fails.length) { fails.forEach((f) => console.error('  FAIL ' + f)); process.exit(1); }
})();
