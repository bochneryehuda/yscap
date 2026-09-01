#!/usr/bin/env node
'use strict';
/**
 * LT — THE HOUSING HISTORY FOLLOWS HOW THE BORROWER LIVES, AND BOTH IT AND THE
 * PAYOFF SAY WHAT FEEDS THEM.
 *
 * Owner-directed 2026-08-31:
 *
 *   *"Housing history verified — if he is renting, then the housing history
 *   verified condition is tied directly to the verification of rent order and
 *   gets the documents from there. You can either upload it manually as well…
 *   If he is owning, then that housing history verified should have a note that
 *   it is a verification of mortgage of primary residence. If he is living
 *   rent-free, then the housing history verified should be the rent-free
 *   letter."*
 *
 *   *"The payoff received should be tied directly to the payoff order, and you
 *   should also be able to upload manually."*
 *
 * ── WHAT WAS ALREADY TRUE, AND WHAT WAS NOT ─────────────────────────────────
 *
 * The wiring existed: `orders/kinds.js` names each condition as its order's
 * `docCondition` and names the slot a returned document lands in. What did not
 * exist is anything SAYING so — a slot that fills itself in looked exactly like
 * one waiting to be uploaded, so somebody chased a document already on its way —
 * and the owning branch did not say PRIMARY RESIDENCE, which is the one thing
 * that tells it apart from the subject property's own verification of mortgage
 * on the same file.
 *
 * ── WHY A DATABASE TEST ─────────────────────────────────────────────────────
 *
 * The three branches are decided per FILE, from the borrower's residence, and the
 * slot list is COPIED onto each condition when it is created — so both the
 * branching and whether the new wording reached files that already exist are
 * facts about rows, not about the source.
 *
 * ── PROVEN TO FAIL ──────────────────────────────────────────────────────────
 *
 * Seven mutations of the production code, each with a green control either side:
 * the rent order naming a different condition (1 fail); a returned payoff landing
 * in a slot the condition does not have (1); the LIBRARY edited without the
 * migration, so every existing file keeps the old wording (12); the MIGRATION
 * written without the library, so a brand-new tenant gets the old wording (1);
 * the owning branch losing its `whenField`, so a renting borrower is asked for a
 * mortgage verification on a home they do not own (2); the subject property's own
 * verification of mortgage renaming itself the primary one (1); and the wording
 * dropping the promise that any of them can still be uploaded (3).
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
  await require(__dirname + '/lib/db-gate').skipUnlessDb('lt-housing-history-and-payoff');
  const { ensureSchema } = require('../src/migrate-boot.js');
  const db = require('../src/db.js');
  const engine = require('../src/longterm/conditions-center/engine.js');
  const lib = require('../src/longterm/conditions-center/library.js');
  const read = require('../src/longterm/conditions-center/read.js');
  const kinds = require('../src/longterm/orders/kinds.js');

  await ensureSchema();
  await lib.ensureSeeded(db);

  const cx = await db.pool.connect();
  let failed = false;
  try {
    await cx.query('BEGIN');

    // ── A. AN ORDER'S ANSWER HAS SOMEWHERE TO LAND ──────────────────────────
    console.log('\nA. EACH ORDER NAMES THE CONDITION AND THE SLOT ITS ANSWER FILLS');
    {
      const vor = kinds.orderKind('vor');
      const payoff = kinds.orderKind('payoff');
      ok(vor && vor.docCondition === 'lt_housing_history',
        'the verification of rent order files into the housing history', String(vor && vor.docCondition));
      ok(payoff && payoff.docCondition === 'lt_payoff_received',
        'the payoff order files into payoff received', String(payoff && payoff.docCondition));
      ok(kinds.slotForFilename('vor', 'Verification of Rent - completed.pdf') === 'vor',
        '…and a completed rent verification lands in the rent slot');
      ok(kinds.slotForFilename('payoff', 'Payoff Demand 2026-09-30.pdf') === 'payoff',
        '…and a payoff demand lands in the payoff slot');
      // THE SLOT THE ORDER NAMES MUST EXIST ON THE CONDITION IT NAMES, or the
      // document is filed against a key nothing draws — which reads as missing.
      const slotsOf = (code) => (lib.library().find((c) => c.code === code).slots || []).map((s) => s.key);
      ok(slotsOf('lt_housing_history').includes('vor'), 'the housing history really has that slot', slotsOf('lt_housing_history').join(', '));
      ok(slotsOf('lt_payoff_received').includes('payoff'), 'and payoff received really has its one');
    }

    // ── B. THE WORDING SAYS WHAT FEEDS IT ───────────────────────────────────
    console.log('\nB. A SLOT THAT FILLS ITSELF IN SAYS SO');
    {
      const { rows } = await cx.query(
        `SELECT code, hint, slots FROM checklist_templates
          WHERE code IN ('lt_housing_history','lt_payoff_received')`);
      const by = Object.fromEntries(rows.map((r) => [r.code, r]));
      const slot = (code, key) => (by[code].slots || []).find((s) => s.key === key) || {};

      ok(/fills itself in|files itself/i.test(by.lt_housing_history.hint),
        'the housing history says the rent one arrives on its own');
      ok(/uploaded/i.test(by.lt_housing_history.hint),
        '…AND that it can still be uploaded — "tied directly" adds a route, it never closes the manual one');
      ok(/files itself/i.test(slot('lt_housing_history', 'vor').hint || ''),
        'the rent slot itself says where it comes from');
      ok(/files itself/i.test(by.lt_payoff_received.hint) && /uploaded/i.test(by.lt_payoff_received.hint),
        'payoff received says both things too', String(by.lt_payoff_received.hint));

      // THE OWNER'S OWN WORDS, and the reason they matter on this file.
      ok(/primary residence/i.test(slot('lt_housing_history', 'vom_primary').label || ''),
        'THE OWNER\'S NOTE: the owning branch is a verification of mortgage of the PRIMARY RESIDENCE');
      const subject = lib.library().find((c) => c.code === 'lt_vom_subject');
      ok(subject && !/primary/i.test(subject.label),
        '…and the SUBJECT property\'s own verification of mortgage is a different row that does not claim to be it', String(subject && subject.label));
      ok(/not the subject property/i.test(slot('lt_housing_history', 'vom_primary').hint || ''),
        '…said out loud, because two slots both called "verification of mortgage" is how the wrong one gets uploaded');
    }

    // ── A loan per way of living ────────────────────────────────────────────
    const stamp = Date.now();
    const borrower = (await cx.query(
      `INSERT INTO borrowers (first_name, last_name, email) VALUES ('House','Probe',$1) RETURNING id`,
      [`housing-${stamp}@example.test`])).rows[0].id;
    const makeLoan = async (tag, basis) => {
      const id = crypto.randomUUID();
      await cx.query(
        `INSERT INTO lt_loans (id, borrower_id, loan_number, program_name, loan_purpose)
         VALUES ($1::uuid,$2::uuid,$3,'DSCR 30yr','cash_out_refinance'::lt_loan_purpose)`,
        [id, borrower, `HH-${tag}-${stamp}`]);
      await cx.query(
        `INSERT INTO lt_properties (loan_id, street, city, state, zip, unit_count, gse_property_type)
         VALUES ($1::uuid,'2 Housing Way','Anytown','NJ','07001',1,'SFR')`, [id]);
      const pair = (await cx.query(
        `INSERT INTO lt_borrower_pairs (id, loan_id, pair_number) VALUES ($1::uuid,$2::uuid,1) RETURNING id`,
        [crypto.randomUUID(), id])).rows[0].id;
      const party = (await cx.query(
        `INSERT INTO lt_parties (id, pair_id, role, party_type, first_name, last_name)
         VALUES ($1::uuid,$2::uuid,'borrower','individual','House','Probe') RETURNING id`,
        [crypto.randomUUID(), pair])).rows[0].id;
      await cx.query(
        `INSERT INTO lt_residences (id, party_id, residency_type, residency_basis, street, city, state, zip)
         VALUES ($1::uuid,$2::uuid,'current',$3,'3 Home St','Anytown','NJ','07001')`,
        [crypto.randomUUID(), party, basis]);
      await engine.evaluateLoan(id, { db: cx });
      return id;
    };
    /* Read it the way the SCREEN does — through `forLoan`, which is what applies
       the per-slot `whenField` against the file's own live facts. Reading the row
       out of `checklist_items` would show all three on every file and prove
       nothing about the branching. */
    const housingSlots = async (loanId) => {
      const out = await read.forLoan(loanId, { db: cx, audience: 'internal' });
      const rows = (out.buckets || []).flatMap((b) => b.conditions || []);
      const row = rows.find((c) => c.code === 'lt_housing_history');
      if (!row) throw new Error(`no housing-history condition on ${loanId} (${rows.length} conditions read)`);
      return (row.slots || []).map((s) => s.key);
    };

    // ── C. ONE BRANCH AT A TIME ─────────────────────────────────────────────
    console.log('\nC. THE FILE PICKS THE BRANCH, AND ONLY ONE');
    // `no_primary_housing_expense` is the URLA's own word for living rent free, and
    // it is the value `lt_residency_basis` actually carries — the rule field reads
    // it, so the fixture uses it rather than a friendlier invention.
    for (const [basis, expect] of [['rent', 'vor'], ['own', 'vom_primary'], ['no_primary_housing_expense', 'rent_free_letter']]) {
      const loan = await makeLoan(basis, basis);
      const keys = await housingSlots(loan);
      ok(keys.includes(expect), `a borrower who lives "${basis}" is asked for ${expect}`, keys.join(', '));
      const others = ['vor', 'vom_primary', 'rent_free_letter'].filter((k) => k !== expect);
      ok(others.every((k) => !keys.includes(k)),
        `…and NOT for ${others.join(' or ')} — they are alternatives, and two of the three cannot exist`, keys.join(', '));
    }
    {
      // AND THE THIRD ANSWER. A file whose residence we have not read must not be
      // told it needs nothing — hiding a real requirement on a guess is the
      // expensive direction, so an unjudged slot is KEPT.
      const unknown = crypto.randomUUID();
      await cx.query(
        `INSERT INTO lt_loans (id, borrower_id, loan_number, program_name, loan_purpose)
         VALUES ($1::uuid,$2::uuid,$3,'DSCR 30yr','cash_out_refinance'::lt_loan_purpose)`,
        [unknown, borrower, `HH-unknown-${stamp}`]);
      await engine.evaluateLoan(unknown, { db: cx });
      const keys = await housingSlots(unknown);
      ok(keys.length === 3,
        'a file whose residence nobody has read keeps ALL THREE — an unread file has not been determined to live any particular way',
        keys.join(', '));
    }

    // ── D. THE WORDING REACHED THE FILES THAT ALREADY EXIST ─────────────────
    console.log('\nD. AND THE FILES THAT ALREADY EXIST GOT THE NEW WORDING');
    {
      // The slot list is COPIED onto each condition when it is created, so the
      // template alone would leave every live file showing the old words. What is
      // asserted is the ITEM.
      const loan = await makeLoan('worded', 'own');
      const { rows } = await cx.query(
        `SELECT ci.slots, ci.hint FROM checklist_items ci
           JOIN checklist_templates t ON t.id = ci.template_id
          WHERE ci.lt_loan_id = $1::uuid AND t.code = 'lt_housing_history'`, [loan]);
      const vom = ((rows[0] || {}).slots || []).find((s) => s.key === 'vom_primary') || {};
      ok(/primary residence/i.test(vom.label || ''),
        'the CONDITION on the file — not only the template — names the primary residence', JSON.stringify(vom));
      ok(/uploaded/i.test((rows[0] || {}).hint || ''),
        '…and carries the wording that says it can also be uploaded');
    }


    // ── E. A BRAND-NEW DATABASE AND THIS ONE SAY THE SAME THING ─────────────
    console.log('\nE. THE LIBRARY AND THE SEEDED TEMPLATE CANNOT DRIFT APART');
    {
      /* THE TRAP THIS SECTION EXISTS FOR. `ensureSeeded` inserts a template with
         ON CONFLICT (code) DO NOTHING, so it NEVER rewrites a row that is already
         there: the library is what a brand-new database gets, and a migration is
         the only thing that reaches the databases that already exist. Change one
         and not the other and the two quietly say different things — a fresh
         tenant reading one wording while this one reads another, with nothing
         anywhere failing. So the two are compared directly, in BOTH directions.

         Compared CANONICALLY, because jsonb re-orders an object's keys on the way
         in: a raw JSON.stringify comparison would fail on two identical slots. */
      const canon = (v) => {
        if (Array.isArray(v)) return v.map(canon);
        if (v && typeof v === 'object') {
          return Object.keys(v).sort().reduce((o, k) => { o[k] = canon(v[k]); return o; }, {});
        }
        return v;
      };
      const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
      const { rows } = await cx.query(
        `SELECT code, label, hint, slots FROM checklist_templates
          WHERE code IN ('lt_housing_history','lt_payoff_received')`);
      for (const code of ['lt_housing_history', 'lt_payoff_received']) {
        const row = rows.find((r) => r.code === code);
        const src = lib.library().find((c) => c.code === code);
        ok(!!row && !!src, `${code} exists in both the library and the database`);
        if (!row || !src) continue;
        ok(row.label === src.label, `${code}: the label a new database gets is the label this one holds`,
          `${src.label} vs ${row.label}`);
        ok(row.hint === src.hint, `${code}: …and so is the note`,
          `${String(src.hint).slice(0, 60)} vs ${String(row.hint).slice(0, 60)}`);
        ok(same(row.slots, src.slots), `${code}: …and so is every slot, word for word`,
          JSON.stringify(row.slots));
      }
    }

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
