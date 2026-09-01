#!/usr/bin/env node
'use strict';
/**
 * LT — THE LANDLORD A BORROWER ALREADY HAD FILLS ITSELF IN ON THEIR NEXT FILE,
 * AND STOPS THE MOMENT THEY MOVE.
 *
 * Owner-directed 2026-08-31: *"We need to make the landlord contact information
 * also be saved directly to the borrower's profile for next time to pre-fill. As
 * long as he is still living at the same primary address — if his primary address
 * has been updated in Encompass, then you should not automatically populate his
 * landlord, because probably the landlord changed. Add this logic."*
 *
 * ── WHY A DATABASE TEST ─────────────────────────────────────────────────────
 *
 * The key rules are pure and proven next door. What only a real database can show
 * is the STORY the owner described: a landlord put on one file, a second file for
 * the same person, and whether the card appears on it — which depends on rows in
 * four tables (`lt_parties`, `lt_residences`, `lt_loan_vendors`,
 * `lt_borrower_landlords`) and on the borrower link that ties two long-term files
 * to one person.
 *
 * ── PROVEN TO FAIL ──────────────────────────────────────────────────────────
 *
 * Six mutations, each with a green control either side: keying the memory on the
 * person rather than the home, so a borrower who moved is filled in with their
 * old landlord (2 fails, and the output is the owner's own fear verbatim);
 * remembering a landlord for a home the borrower OWNS (2); dropping the
 * fill-only guard, so a memory overrules the card a person picked (2); picking
 * one of two remembered landlords instead of refusing (2); a sweep that never
 * stamps and so re-does the whole book on every boot (2); and the file-contacts
 * screen no longer filling anything in (1).
 *
 * The fill-only mutation is also why the module writes behind a SAVEPOINT: the
 * first run of it aborted the suite's transaction rather than failing cleanly,
 * which is a real defect for any caller that hands this module a connection of
 * their own — a never-throws promise is only half true if the caller loses their
 * transaction to it.
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

const HOME = { street: '3 Home St', city: 'Anytown', state: 'NJ', zip: '07001' };
const MOVED = { street: '9 New Rd', city: 'Anytown', state: 'NJ', zip: '07001' };

(async () => {
  await require(__dirname + '/lib/db-gate').skipUnlessDb('lt-landlord-memory');
  const { ensureSchema } = require('../src/migrate-boot.js');
  const db = require('../src/db.js');
  const memory = require('../src/longterm/landlord-memory.js');

  await ensureSchema();

  const cx = await db.pool.connect();
  let failed = false;
  try {
    await cx.query('BEGIN');
    const stamp = Date.now();

    const makeBorrower = async (tag) => (await cx.query(
      `INSERT INTO borrowers (first_name, last_name, email) VALUES ('Land',$1,$2) RETURNING id`,
      [tag, `landlord-${tag}-${stamp}@example.test`])).rows[0].id;

    const makeCard = async (name) => (await cx.query(
      `INSERT INTO service_contacts (contact_type, company_name, contact_name, email)
       VALUES ('landlord',$1,$2,$3) RETURNING id`,
      [name, name, `${name.replace(/\W+/g, '').toLowerCase()}@example.test`])).rows[0].id;

    /** A long-term loan for one borrower, with that borrower renting (or owning) a home. */
    const makeLoan = async (tag, borrowerId, home, basis) => {
      const id = crypto.randomUUID();
      await cx.query(
        `INSERT INTO lt_loans (id, borrower_id, loan_number, program_name)
         VALUES ($1::uuid,$2::uuid,$3,'DSCR 30yr')`, [id, borrowerId, `LL-${tag}-${stamp}`]);
      const pair = (await cx.query(
        `INSERT INTO lt_borrower_pairs (id, loan_id, pair_number) VALUES ($1::uuid,$2::uuid,1) RETURNING id`,
        [crypto.randomUUID(), id])).rows[0].id;
      const party = (await cx.query(
        `INSERT INTO lt_parties (id, pair_id, role, party_type, borrower_id, first_name, last_name)
         VALUES ($1::uuid,$2::uuid,'borrower','individual',$3::uuid,'Land','Probe') RETURNING id`,
        [crypto.randomUUID(), pair, borrowerId])).rows[0].id;
      await cx.query(
        `INSERT INTO lt_residences (id, party_id, residency_type, residency_basis, street, city, state, zip)
         VALUES ($1::uuid,$2::uuid,'current',$3,$4,$5,$6,$7)`,
        [crypto.randomUUID(), party, basis || 'rent', home.street, home.city, home.state, home.zip]);
      return { id, pair };
    };

    const addParty = async (pairId, borrowerId, home, basis) => {
      const party = (await cx.query(
        `INSERT INTO lt_parties (id, pair_id, role, party_type, borrower_id, first_name, last_name)
         VALUES ($1::uuid,$2::uuid,'coborrower','individual',$3::uuid,'Land','Two') RETURNING id`,
        [crypto.randomUUID(), pairId, borrowerId])).rows[0].id;
      await cx.query(
        `INSERT INTO lt_residences (id, party_id, residency_type, residency_basis, street, city, state, zip)
         VALUES ($1::uuid,$2::uuid,'current',$3,$4,$5,$6,$7)`,
        [crypto.randomUUID(), party, basis || 'rent', home.street, home.city, home.state, home.zip]);
    };

    const linkLandlord = async (loanId, contactId) => cx.query(
      `INSERT INTO lt_loan_vendors (loan_id, kind, service_contact_id, is_primary)
       VALUES ($1::uuid,'landlord',$2::uuid,true)`, [loanId, contactId]);

    const landlordOn = async (loanId) => {
      const { rows } = await cx.query(
        `SELECT service_contact_id FROM lt_loan_vendors WHERE loan_id = $1::uuid AND kind = 'landlord'`,
        [loanId]);
      return rows.map((r) => String(r.service_contact_id));
    };

    // ── A. IT IS REMEMBERED ─────────────────────────────────────────────────
    console.log('\nA. A LANDLORD PUT ON A FILE IS REMEMBERED AGAINST THE HOME');
    const bob = await makeBorrower('bob');
    const acme = await makeCard(`Acme Management ${stamp}`);
    const first = await makeLoan('first', bob, HOME);
    await linkLandlord(first.id, acme);
    const remembered = await memory.rememberForLoan(first.id, { db: cx });
    ok(remembered.remembered === 1, 'the landlord on the file is recorded for that borrower', JSON.stringify(remembered));
    {
      const { rows } = await cx.query(
        `SELECT address_key, address_text, service_contact_id FROM lt_borrower_landlords WHERE borrower_id = $1::uuid`, [bob]);
      ok(rows.length === 1 && String(rows[0].service_contact_id) === String(acme),
        'against that borrower and that card', JSON.stringify(rows));
      ok(rows[0].address_key === memory.addressKey(HOME),
        '…keyed on the home they rent, by the one definition');
      ok(/3 Home St/.test(rows[0].address_text || ''),
        '…with the home written the way a person reads it', String(rows[0].address_text));
    }

    // ── B. THE NEXT FILE FILLS IT IN ────────────────────────────────────────
    console.log('\nB. THE SAME BORROWER, THE SAME HOME — IT FILLS ITSELF IN');
    const second = await makeLoan('second', bob, HOME);
    ok((await landlordOn(second.id)).length === 0, 'CONTROL: the new file starts with no landlord');
    const applied = await memory.applyForLoan(second.id, { db: cx });
    ok(applied.applied === true && String(applied.contactId) === String(acme),
      'THE ONE THAT MATTERS: their landlord is filled in on the new file', JSON.stringify(applied));
    ok((await landlordOn(second.id)).join() === String(acme),
      '…and it is really on the loan, as the card an order would be addressed to');
    ok(/3 Home St/.test(applied.addressText || '') && /Acme/.test(applied.name || ''),
      '…and it says WHICH home and WHOSE card, so nobody has to re-check it', JSON.stringify(applied));

    // ── C. THE OWNER'S RULE ─────────────────────────────────────────────────
    console.log('\nC. THE OWNER\'S RULE: THEY MOVED, SO NOTHING IS FILLED IN');
    const third = await makeLoan('moved', bob, MOVED);
    const movedOut = await memory.applyForLoan(third.id, { db: cx });
    ok(movedOut.applied === false && movedOut.why === 'nothing_remembered',
      'a borrower at a NEW address gets no landlord — "probably the landlord changed"', JSON.stringify(movedOut));
    ok((await landlordOn(third.id)).length === 0, '…and the file really is left empty');

    // ── D. A PERSON'S ANSWER IS NEVER OVERRULED ─────────────────────────────
    console.log('\nD. FILL-ONLY — A LANDLORD SOMEBODY PUT THERE IS LEFT ALONE');
    const other = await makeCard(`Other Management ${stamp}`);
    const fourth = await makeLoan('fourth', bob, HOME);
    await linkLandlord(fourth.id, other);
    const untouched = await memory.applyForLoan(fourth.id, { db: cx });
    ok(untouched.applied === false && untouched.why === 'already_on_file',
      'a file that already carries a landlord is not touched', JSON.stringify(untouched));
    ok((await landlordOn(fourth.id)).join() === String(other),
      '…and the card the person picked is still the one on it');
    // …and running it twice is the same as running it once.
    const again = await memory.applyForLoan(second.id, { db: cx });
    ok(again.applied === false && (await landlordOn(second.id)).length === 1,
      'a second pass adds nothing — safe to call on every read of the screen');

    // ── E. ONLY A HOME THEY RENT ────────────────────────────────────────────
    console.log('\nE. A LANDLORD IS ONLY EVER REMEMBERED FOR A HOME THEY RENT');
    const owner = await makeBorrower('owner');
    const ownerLoan = await makeLoan('owns', owner, HOME, 'own');
    await linkLandlord(ownerLoan.id, acme);
    const ownRemember = await memory.rememberForLoan(ownerLoan.id, { db: cx });
    ok(ownRemember.remembered === 0,
      'a borrower who OWNS their home has no landlord to remember', JSON.stringify(ownRemember));
    const ownerNext = await makeLoan('owns2', owner, HOME, 'own');
    ok((await memory.applyForLoan(ownerNext.id, { db: cx })).applied === false,
      '…so nothing is filled in on their next file either');

    // ── F. TWO ANSWERS IS A REFUSAL ─────────────────────────────────────────
    console.log('\nF. TWO BORROWERS WITH TWO DIFFERENT LANDLORDS — IT REFUSES');
    const ann = await makeBorrower('ann');
    const annCard = await makeCard(`Ann Management ${stamp}`);
    const annLoan = await makeLoan('ann', ann, MOVED);
    await linkLandlord(annLoan.id, annCard);
    await memory.rememberForLoan(annLoan.id, { db: cx });
    // A file the two of them are on together: Bob rents at HOME, Ann at MOVED,
    // and the two remembered landlords disagree.
    const joint = await makeLoan('joint', bob, HOME);
    await addParty(joint.pair, ann, MOVED);
    const jointOut = await memory.applyForLoan(joint.id, { db: cx });
    ok(jointOut.applied === false && jointOut.why === 'more_than_one',
      'two remembered landlords is no answer, so it fills in nothing rather than picking one',
      JSON.stringify(jointOut));
    ok((await landlordOn(joint.id)).length === 0, '…and the file is left for a person to answer');

    // ── G. THE BACK BOOK ────────────────────────────────────────────────────
    console.log('\nG. THE FILES THAT ALREADY HAVE A LANDLORD ARE SWEPT ONCE');
    {
      // Nothing above stamped `remembered_at`, so every landlord link made in this
      // transaction is exactly the back book the sweep exists for.
      const before = (await cx.query(
        `SELECT count(*)::int AS n FROM lt_loan_vendors WHERE kind='landlord' AND remembered_at IS NULL`)).rows[0].n;
      ok(before > 0, 'CONTROL: there is a back book to sweep', String(before));
      const swept = await memory.backfillOnce({ db: cx, limit: 500 });
      ok(swept.loans >= 4, 'the sweep considers every landlord link nobody has looked at', JSON.stringify(swept));
      const after = (await cx.query(
        `SELECT count(*)::int AS n FROM lt_loan_vendors WHERE kind='landlord' AND remembered_at IS NULL`)).rows[0].n;
      ok(after === 0, 'THE DRAIN: every one is stamped, so it empties itself', String(after));
      const twice = await memory.backfillOnce({ db: cx, limit: 500 });
      ok(twice.loans === 0, '…and a second boot finds nothing to do');
    }

    // ── H. THE SCREEN ACTUALLY CALLS IT ─────────────────────────────────────
    console.log('\nH. THE DESK IS WIRED TO IT — the half no run here can reach');
    {
      /* A module with no caller is the defect this repo names by name. The route
         is HTTP and the sweep is a worker tick, so both are read from the SOURCE
         — comments stripped first, or the note explaining the wiring would
         satisfy the guard that the wiring exists. */
      const fs = require('fs');
      const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const orders = strip(fs.readFileSync(require.resolve('../src/longterm/routes/orders.js'), 'utf8'));
      ok(/landlordMemory\.applyForLoan\(/.test(orders),
        'the file-contacts read fills the remembered landlord in');
      ok(/landlordFilled,/.test(orders), '…and hands the screen what it did, so it can say so');
      ok((orders.match(/rememberLandlord\(/g) || []).length >= 3,
        'and BOTH ways a contact reaches a loan record it — one door wired and the other not is how half the book is forgotten',
        String((orders.match(/rememberLandlord\(/g) || []).length));
      ok(/kind !== 'landlord'\) return;/.test(orders),
        '…and only a landlord: the other kinds are about the property, not about a borrower\'s home');
      const worker = strip(fs.readFileSync(require.resolve('../src/longterm/sync/worker.js'), 'utf8'));
      ok(/landlordMemory\.backfillOnce\(/.test(worker), 'and the sweep really runs on the worker tick');
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
