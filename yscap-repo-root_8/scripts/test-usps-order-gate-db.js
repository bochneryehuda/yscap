'use strict';
/* WAIVING THE USPS CONDITION LETS THE ORDER GO OUT — it did not, and there was no way through.
 * Owner-reported 2026-08-24: *"even though I'm waiving the USPS condition as an admin, he
 * basically requests an exception to waive the USPS. I approve the exception, but he still
 * can't order title and insurance even after I approve the exception."*
 *
 * ROOT CAUSE. `orders.blockers` refused on `data.uspsGate && !data.uspsImported`, and
 * `uspsImported` reads ONE column — `applications.usps_imported_at`, written by exactly one
 * thing: importing a USPS-standardised address. Neither recorded remedy writes it:
 *
 *   · waiving the condition stamps `checklist_items.waived_at`;
 *   · approving a `condition_waiver` exception performs the satisfied-write onto that same
 *     condition (routes/admin-exceptions.js) — and nothing else.
 *
 * So both ways through ended at a cleared condition while the gate looked somewhere else. That
 * is a refusal whose own remedies cannot produce the state it demands — a dead end, and the
 * class this repo already names elsewhere ("a gate whose own remedy the user cannot perform").
 *
 * THE FIX is a SECOND way past the gate, not a replacement: an imported address still satisfies
 * it with nobody having to decide, and a person who cleared the condition has answered the same
 * question by hand. Scoped to the USPS condition BY TEMPLATE CODE, so no other waiver on the
 * file can open this gate.
 *
 * Run: DATABASE_URL=... node scripts/test-usps-order-gate-db.js
 */
const R = require('path').join(__dirname, '..');
const db = require(R + '/src/db');
const orders = require(R + '/src/lib/orders');
const cfg = require(R + '/src/config');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name); } };

(async () => {
  if (!process.env.DATABASE_URL) { console.log('SKIP test-usps-order-gate-db (no DATABASE_URL)'); process.exit(0); }
  const sfx = () => Math.random().toString(36).slice(2, 8);
  const tpl = (await db.query(`SELECT id FROM checklist_templates WHERE code='usps_address_verification' LIMIT 1`)).rows[0];

  console.log('\nA. the USPS order gate');
  ok('the USPS condition template exists (the gate is scoped to its code)', !!tpl);

  /* The gate is live only where USPS is configured AND the condition is required, so both are
     forced ON — otherwise every assertion below would pass on a gate that is simply switched
     off, which is the tautology this kind of suite most easily becomes. */
  const uv = require.resolve(R + '/src/lib/usps-verify');
  require(uv);
  require.cache[uv].exports = Object.assign({}, require.cache[uv].exports, { configured: () => true });
  const prevRequired = cfg.usps.conditionRequired;
  cfg.usps.conditionRequired = true;

  const bor = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('A','B',$1) RETURNING id`, [`u-${sfx()}@x.test`])).rows[0].id;

  // `clear` is HOW the condition was cleared — each is a real, separate door a human can use.
  const mk = async (clear, opts = {}) => {
    const app = (await db.query(
      `INSERT INTO applications (borrower_id, ys_loan_number, status, loan_type, property_address, usps_imported_at)
       VALUES ($1,$2,'in_review','Purchase','{"oneLine":"1 Main St"}'::jsonb,$3) RETURNING id`,
      [bor, `YS-${sfx()}`, opts.imported ? new Date() : null])).rows[0].id;
    // A vendor, so 'contact' is never the blocker under test.
    const sc = (await db.query(
      `INSERT INTO service_contacts (contact_type, company_name, email) VALUES ('title_company','T',$1) RETURNING id`,
      [`t-${sfx()}@x.test`])).rows[0].id;
    await db.query(
      `INSERT INTO application_service_contacts (application_id, service_contact_id, contact_type)
       VALUES ($1,$2,'title_company')`, [app, sc]);
    if (clear !== 'none') {
      // NOTE there is no 'waived' STATUS — checklist_items_status_check allows
      // outstanding|requested|received|satisfied|issue — a waiver is the `waived_at` stamp.
      await db.query(
        `INSERT INTO checklist_items (application_id, template_id, label, status, is_required,
                                      scope, audience, waived_at, signed_off_at, override_at)
         VALUES ($1,$2,'USPS address verification',$3,$4,'application','staff',$5,$6,$7)`,
        [app, tpl.id,
         clear === 'satisfied' ? 'satisfied' : 'outstanding',
         clear !== 'optional',
         clear === 'waived'   ? new Date() : null,
         clear === 'signed'   ? new Date() : null,
         clear === 'override' ? new Date() : null]);
    }
    return app;
  };
  const blocked = async (app) => (orders.blockers('title', await orders.getOrderData(app))).includes('usps');

  // THE CONTROL FIRST. Without it every "can order" below could be a gate that never fires.
  ok('CONTROL: an outstanding USPS condition still blocks the order', await blocked(await mk('none')));
  ok('CONTROL: so does one that exists and is untouched', await blocked(await mk('outstanding')));

  // THE OWNER'S REPORT — each door a person can actually use.
  ok('an admin WAIVING the condition lets title be ordered', !(await blocked(await mk('waived'))));
  ok('an approved exception (its satisfied-write) lets it be ordered', !(await blocked(await mk('satisfied'))));
  ok('a SIGNED-OFF condition lets it be ordered', !(await blocked(await mk('signed'))));
  ok('a super-admin OVERRIDE (db/344) lets it be ordered', !(await blocked(await mk('override'))));
  ok('a condition made NOT REQUIRED lets it be ordered', !(await blocked(await mk('optional'))));

  // The original rule is untouched: an imported address still passes with nobody deciding.
  ok('an IMPORTED USPS address still passes on its own', !(await blocked(await mk('none', { imported: true }))));

  // Insurance is gated by the same rule — the owner named both.
  {
    const app = await mk('waived');
    const d = await orders.getOrderData(app);
    ok('insurance is freed by the same waiver, not just title', !orders.blockers('insurance', d).includes('usps'));
  }

  // SCOPE: another file's waiver must never open this file's gate.
  {
    await mk('waived');                      // a DIFFERENT file, cleared
    const mine = await mk('outstanding');    // this one is not
    ok('another file being cleared does NOT open this file', await blocked(mine));
  }

  /* THE SCOPE IS BY TEMPLATE CODE, AND THIS IS THE CASE THAT PROVES IT. Every fixture above
     puts only the USPS condition on the file, so dropping `AND t.code = ...` from the lookup
     still finds that same row and the suite stays green — measured, not assumed: that mutation
     passed until this case existed. A file carries dozens of conditions and people waive them
     all the time; an unscoped lookup would let ANY of them open the address gate. */
  {
    const app = await mk('outstanding');                       // USPS itself is NOT cleared
    const other = (await db.query(
      `SELECT id FROM checklist_templates WHERE code <> 'usps_address_verification' LIMIT 1`)).rows[0];
    ok('there is another template to test the scope with', !!other);
    if (other) {
      await db.query(
        `INSERT INTO checklist_items (application_id, template_id, label, status, is_required,
                                      scope, audience, waived_at)
         VALUES ($1,$2,'Some other condition','outstanding',true,'application','staff',now())`,
        [app, other.id]);
      ok('waiving a DIFFERENT condition does NOT open the address gate', await blocked(app));
    }
  }

  cfg.usps.conditionRequired = prevRequired;
  console.log(`\ntest-usps-order-gate-db: ${fail ? 'FAILED' : 'OK'} (${pass} assertions${fail ? `, ${fail} failed` : ''})`);
  await db.pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e && e.stack || e); process.exit(1); });
