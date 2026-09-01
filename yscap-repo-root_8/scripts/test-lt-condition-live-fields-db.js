#!/usr/bin/env node
/**
 * A CONDITION IS READ AGAINST THE FILE'S OWN FACTS.
 *
 * `read.forLoan` shapes every condition for the screen. Two of those shapes ask
 * a question about the FILE and not about the condition:
 *
 *   · WHICH SLOTS EXIST — the owner asked for New York's title package to drop
 *     the closing protection letter and the preliminary settlement statement
 *     ("We remove the CPL. We don't ask for the CPL. We don't ask for the
 *     preliminary settlement statement in New York"), which the library encodes
 *     as `notWhenField: 'is_new_york'`.
 *   · WHICH CONTACTS APPLY — a New York settlement agent, a flood insurance
 *     agent. Owner-directed 2026-08-31, these stay VISIBLE and greyed rather
 *     than vanishing: *"Be visible that doesn't belong for this file."*
 *
 * THE DEFECT THIS PINS: `slotsFor` read those values from the condition's own
 * stored `answer.fields`, and NOTHING HAS EVER WRITTEN THAT KEY — the engine
 * reads the rule context and never persists it. So the filter's input was always
 * `{}`, every slot was always kept, and a real New York file still asked for a
 * CPL. It is a silent failure by construction: the rule was written, was
 * correct, and never ran.
 *
 * DB-GATED. It reads the real migrated schema because the whole bug was a
 * mismatch between what a query returns and what a reader expected — which no
 * mock can see.
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
  await require(__dirname + '/lib/db-gate').skipUnlessDb('lt-condition-live-fields');
  const { ensureSchema } = require('../src/migrate-boot.js');
  const db = require('../src/db.js');
  const ltDb = require('../src/longterm/db.js');
  const engine = require('../src/longterm/conditions-center/engine.js');
  const lib = require('../src/longterm/conditions-center/library.js');
  const read = require('../src/longterm/conditions-center/read.js');

  await ensureSchema();
  // ensureSeeded takes the CLIENT, not an options object — the same shape trap
  // that made loadContext answer an all-null context. Passing { db } here seeds
  // NOTHING and every later assertion fails for the wrong reason.
  await lib.ensureSeeded(db);

  const cx = await db.pool.connect();
  let failed = false;
  try {
    await cx.query('BEGIN');

    /** One long-term loan with a property whose facts we choose. */
    const makeLoan = async (tag, { state, flood, propertyType }) => {
      const borrower = (await cx.query(
        `INSERT INTO borrowers (first_name, last_name, email) VALUES ('Live','Probe',$1) RETURNING id`,
        [`live-${tag}@example.test`])).rows[0].id;
      const loan = crypto.randomUUID();
      await cx.query(
        `INSERT INTO lt_loans (id, borrower_id, loan_number, program_name)
         VALUES ($1::uuid,$2::uuid,$3,'DSCR 30yr')`, [loan, borrower, `LIVE-${tag}`]);
      await cx.query(
        `INSERT INTO lt_properties (loan_id, street, city, state, zip, unit_count, gse_property_type, in_flood_zone)
         VALUES ($1::uuid,'1 Probe St','Somewhere',$2,'11111',1,$3,$4)`,
        [loan, state, propertyType, flood]);
      return loan;
    };

    const conditionsOf = async (loanId) => {
      const out = await read.forLoan(loanId, { db: cx, audience: 'internal' });
      const flat = [];
      for (const b of out.buckets) for (const c of b.conditions) flat.push(c);
      return { flat, byCode: new Map(flat.map((c) => [c.code, c])), degraded: out.degraded };
    };

    console.log('\nA. THE VALUES REACH THE READER AT ALL');
    const ny = await makeLoan('ny', { state: 'NY', flood: false, propertyType: 'SFR' });
    await engine.evaluateLoan(ny, { db: cx });
    const nyRead = await conditionsOf(ny);
    ok(!nyRead.degraded, 'the New York file reads without degrading', String(nyRead.degraded));
    ok(nyRead.flat.length > 0, `conditions were attached (${nyRead.flat.length})`);

    // The control: the same read against a file that is NOT in New York.
    const nj = await makeLoan('nj', { state: 'NJ', flood: false, propertyType: 'SFR' });
    await engine.evaluateLoan(nj, { db: cx });
    const njRead = await conditionsOf(nj);

    console.log('\nB. NEW YORK DROPS THE CPL AND THE PRELIMINARY SETTLEMENT STATEMENT');
    const nyTitle = nyRead.byCode.get('lt_title_docs');
    const njTitle = njRead.byCode.get('lt_title_docs');
    ok(!!nyTitle && !!njTitle, 'both files carry the title documents condition');
    if (nyTitle && njTitle) {
      const nyKeys = nyTitle.slots.map((s) => s.key);
      const njKeys = njTitle.slots.map((s) => s.key);
      ok(!nyKeys.includes('cpl'), 'a New York file does NOT ask for a closing protection letter', nyKeys.join(', '));
      ok(!nyKeys.includes('prelim_settlement'), 'a New York file does NOT ask for a preliminary settlement statement', nyKeys.join(', '));
      // THE CONTROL, and it is the half that makes the two above mean anything:
      // a filter that removed every slot everywhere would pass them both.
      ok(njKeys.includes('cpl'), 'a New Jersey file DOES ask for a closing protection letter', njKeys.join(', '));
      ok(njKeys.includes('prelim_settlement'), 'a New Jersey file DOES ask for a preliminary settlement statement', njKeys.join(', '));
      ok(nyKeys.includes('commitment') && njKeys.includes('commitment'),
        'the title commitment is asked for on both — only the two New York items move');
    }

    console.log('\nC. A CONTACT THAT DOES NOT APPLY IS MARKED, NEVER DROPPED');
    //
    // THE ROWS MOVED, THE RULE DID NOT (db/659). Owner-directed 2026-08-31, the
    // pre-submittal CONDITION now asks for the two the file cannot be submitted
    // without, and every other contact — the settlement agent, the flood agent,
    // the HOA, the landlord — is a slot on the File contacts DESK. So the same
    // behaviour is proven where it now lives, through `read.fileContactTypes`,
    // which is the same `contactTypesFor` both surfaces go through.
    const nyContacts = nyRead.byCode.get('lt_file_contacts');
    ok(!!nyContacts && Array.isArray(nyContacts.contactTypes), 'the contacts condition publishes its contact types');
    {
      const keys = ((nyContacts && nyContacts.contactTypes) || []).map((t) => t.key).sort();
      ok(JSON.stringify(keys) === JSON.stringify(['hazard_insurance', 'title']),
        'THE CONDITION ASKS FOR TWO — the title company and the hazard insurance agent, and nobody else', keys.join(', '));
    }

    const nyDesk = await read.fileContactTypes(ny, cx);
    const njDesk = await read.fileContactTypes(nj, cx);
    {
      const find = (rows, k) => (rows || []).find((t) => t.key === k);
      ok(!!find(njDesk, 'ny_settlement_agent'),
        'the settlement agent row is STILL THERE on a New Jersey file — visible, not vanished');
      ok(find(njDesk, 'ny_settlement_agent').applies === false,
        'and it says it does not apply');
      ok(/new york/i.test(find(njDesk, 'ny_settlement_agent').whyNot || ''),
        'with a reason in plain words', String(find(njDesk, 'ny_settlement_agent').whyNot));
      ok(find(nyDesk, 'ny_settlement_agent').applies === true,
        'on a New York file the same row DOES apply');

      ok(find(nyDesk, 'flood_insurance').applies === false,
        'a file that is not in a flood zone does not need a flood agent');
      ok(find(nyDesk, 'title').applies === true,
        'a contact with no condition on it always applies');

      // The owner's two new slots, on a file that wants neither.
      ok(find(nyDesk, 'hoa').applies === false && /condominium/i.test(find(nyDesk, 'hoa').whyNot || ''),
        'the HOA row is greyed on a single-family file, with its reason', String(find(nyDesk, 'hoa') && find(nyDesk, 'hoa').whyNot));
      ok(!!find(nyDesk, 'landlord'),
        'THE LANDLORD ROW EXISTS AT ALL — the owner could not find one on a file where the borrower rents');
    }

    console.log('\nD. A FLOOD-ZONE FILE ASKS FOR THE FLOOD AGENT');
    const fl = await makeLoan('fl', { state: 'NJ', flood: true, propertyType: 'SFR' });
    await engine.evaluateLoan(fl, { db: cx });
    const flRead = await conditionsOf(fl);
    const flDesk = await read.fileContactTypes(fl, cx);
    const floodRow = (flDesk || []).find((t) => t.key === 'flood_insurance');
    ok(!!floodRow && floodRow.applies === true, 'the flood insurance agent applies once the property is in a flood zone');
    // …and the ORDER that needs that agent is on the file, which is the half that
    // makes taking the row off the pre-submittal condition safe: what was
    // genuinely required is still asked for, by its own rule-driven condition.
    ok(flRead.byCode.has('lt_order_flood_insurance'),
      'and the flood insurance ORDER condition attaches on the same file — nothing required became optional',
      [...flRead.byCode.keys()].filter((k) => /flood/.test(k)).join(', '));

    console.log('\nE. AN UNREADABLE FILE SAYS SO — it never guesses "does not apply"');
    // A loan id that is not a loan: the context reads nothing, so every
    // conditional contact must answer `null`, not `false`.
    const types = read._internals.contactTypesFor(
      { config: { contactTypes: [{ key: 'ny_settlement_agent', label: 'x', whenField: 'is_new_york' }] }, answer: {} },
      null);
    ok(types[0].applies === null, 'with no values at all the answer is "we cannot tell", never "no"');
    ok(/yet/i.test(types[0].whyNot || ''), 'and it says so', String(types[0].whyNot));

    // …and a slot is KEPT in that case, because hiding a real requirement on a
    // guess is the expensive direction.
    const kept = read._internals.slotsFor(
      { slots: [{ key: 'cpl', label: 'CPL', notWhenField: 'is_new_york' }], answer: {} }, true, null);
    ok(kept.length === 1, 'and a slot we cannot judge is kept, not silently removed');
  } catch (e) {
    failed = true;
    console.error('\nCRASH:', (e && e.stack) || e);
  } finally {
    try { await cx.query('ROLLBACK'); } catch (_) {}
    cx.release();
    try { await db.pool.end(); } catch (_) {}
    try { if (ltDb && ltDb.pool && ltDb.pool.end) await ltDb.pool.end(); } catch (_) {}
  }

  if (failed || fails.length) {
    console.error(`\n${fails.length} FAILED`);
    process.exit(1);
  }
  console.log(`\nok — ${pass} checks passed`);
})();
