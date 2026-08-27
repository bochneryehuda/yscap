#!/usr/bin/env node
'use strict';
/**
 * THE INVESTOR'S APPRAISAL REQUIREMENTS LAND ON THE ORDER. Real Postgres, both
 * vendors, nothing sent.
 *
 * Owner-directed 2026-08-16: "any file that's going to EMCAP, when you order the
 * appraiser … this message should post as a message to the order right after you
 * place the order, so the team can know about the requirement. We already have a
 * system for NAN [and] Class where you can post messages."
 *
 * Proven here:
 *   • an EMCAP file's order carries the requirements, on BOTH vendors' threads,
 *     as a real row in the same table their human messages live in;
 *   • it posts ONCE — a second pass over the same order adds nothing;
 *   • a file with a different investor, and a file with none, post nothing at
 *     all (a message saying "no special requirements" is worse than silence);
 *   • the message that reaches an OUTSIDE company names no capital partner;
 *   • a Silver file whose note buyer has not been stamped yet is still covered;
 *   • both placement paths actually CALL it — a source guard, because no unit
 *     test can see a call site, and a poster nobody calls is the whole bug.
 *
 * Nothing leaves the building: CLASS_DRYRUN short-circuits the Class write, and
 * the NAN transport is injected.
 */
process.env.CLASS_ENABLED = '1';          // the master switch, so the dry-run is reached
process.env.CLASS_DRYRUN = '1';           // build + log, send nothing
process.env.CLASS_OUTBOUND_ENABLED = '1'; // ...but do not refuse before the dry-run

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

(async () => {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP investor order message DB (no DATABASE_URL)'); process.exit(0); }
  const R = require('path').resolve(__dirname, '..');
  const db = require(R + '/src/db');
  const poster = require(R + '/src/lib/appraisal/order-requirements-post');
  const reqs = require(R + '/src/lib/appraisal/investor-appraisal-requirements');
  const borrowerSafe = require(R + '/src/lib/borrower-safe');
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;

  // A stubbed NAN transport: records what would have gone out, sends nothing.
  const sent = [];
  const deps = {
    authContext: { apiKey: 'test', subdomain: 'test' },
    transport: { write: async (body, o) => { sent.push({ body, o }); return { Status: 'Success' }; } },
  };

  const mkFile = async (lender, program) => {
    const bId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Req','Test',$1) RETURNING id`,
      [`req-${sfx}-${Math.random().toString(36).slice(2, 8)}@req.test`])).rows[0].id;
    return (await db.query(
      `INSERT INTO applications (borrower_id,status,property_address,loan_type,lender,program,ys_loan_number)
       VALUES ($1,'underwriting','{"line1":"27 Beacon St","city":"Lakewood","state":"NJ","zip":"08701"}','Purchase',$2,$3,$4)
       RETURNING id`, [bId, lender, program, `YSCAP-${sfx}-${Math.random().toString(36).slice(2, 8)}`])).rows[0].id;
  };
  let seq = 0;
  const uniq = (p) => `${p}-${sfx}-${++seq}`;

  /* THE REQUIREMENTS, WITHOUT THE IDENTIFIER HEADER. Line 0 is
     "Appraisal requirements for this loan — Loan #<number> · <address>", and the
     loan number is built from `sfx`, which embeds the PROCESS PID. Testing a
     rent-schedule regex against the WHOLE body therefore matched digits in the
     loan number: a run whose pid+random happened to contain 1025 (observed:
     YSCAP-11025-145766-gwzaas) failed "a Purchase file is told nothing at all
     about a rent schedule" with nothing wrong in the message, and a stray 1007
     would have made the RENTAL assertion pass for the wrong reason. The claim in
     both cases is about the REQUIREMENTS, so that is what is read. */
  const reqsOnly = (body) => String(body || '').split('\n').slice(1).join('\n');
  const mkAmcOrder = async (appId) => (await db.query(
    `INSERT INTO amc_orders (application_id, status, cdg_order_number, sp_order_number, client_order_number)
     VALUES ($1,'ordered',$2,$3,$4) RETURNING *`, [appId, uniq('CDG'), uniq('SP'), uniq('CO')])).rows[0];
  const mkClassOrder = async (appId) => (await db.query(
    `INSERT INTO class_orders (application_id, status, class_order_id, api_version, uad, order_path)
     VALUES ($1,'ordered',$2,'v1','2.6','/orders') RETURNING id`, [appId, uniq('CL')])).rows[0].id;

  try {
    // ── 1. NAN (AppraisalScope) ─────────────────────────────────────────────
    const emcapApp = await mkFile('EMCAP Financial', 'silver');
    const amcOrder = await mkAmcOrder(emcapApp);
    const r1 = await poster.postForAmcOrder(db, amcOrder, { deps });
    ok(r1 && r1.posted === true, `the requirements post to a NAN order (got ${JSON.stringify(r1)})`);

    const nanRows = (await db.query(
      `SELECT direction, body FROM amc_order_comments WHERE order_id=$1`, [amcOrder.id])).rows;
    ok(nanRows.length === 1 && nanRows[0].direction === 'outbound', 'exactly one outbound comment is on the thread');
    const nanBody = nanRows[0] ? nanRows[0].body : '';
    ok(nanBody.startsWith(reqs.MARKER), 'the message leads with the stable marker');
    ok(/within 1 mile/.test(nanBody), 'it carries the 1-mile rule');
    ok(/12 months/.test(nanBody) && /15% net adjustment/.test(nanBody), 'it carries the anchor rule');
    ok(/YSCAP-/.test(nanBody) && /27 Beacon St/.test(nanBody), 'it names the loan and the property');
    ok(!borrowerSafe.hasPartnerName(nanBody) && !/emcap/i.test(nanBody),
      'the message to an OUTSIDE company names no capital partner');
    // THE ANCHOR'S THREE CRITERIA, ON THE REAL POSTED ROW (owner-directed
    // 2026-08-16: "EMCAP needs three things for the anchor comp").
    ok(/all THREE of/.test(nanBody) && nanBody.split('\n').filter((l) => /^ *[abc]\. /.test(l)).length === 3,
      'the posted message spells the anchor comp out as three criteria');
    // AND NOTHING ABOUT RENT ON A NON-RENTAL FILE — read through the file's real
    // program / loan type, not a hand-passed flag.
    ok(!/rent(al)? (analysis|schedule)|1007|1025/i.test(reqsOnly(nanBody)),
      'a Purchase file is told nothing at all about a rent schedule');
    ok(sent.length === 1, 'exactly one AddComment was built for the vendor');

    // ── 2. IT POSTS ONCE ───────────────────────────────────────────────────
    const again = await poster.postForAmcOrder(db, amcOrder, { deps });
    ok(again && again.posted === false && again.reason === 'already_posted', 'a second pass posts nothing');
    ok((await db.query(`SELECT count(*)::int n FROM amc_order_comments WHERE order_id=$1`, [amcOrder.id])).rows[0].n === 1,
      'the thread still holds exactly one requirements message');

    // ── 3. Class Valuation ─────────────────────────────────────────────────
    const classOrder = await mkClassOrder(emcapApp);
    const r2 = await poster.postForClassOrder(db, classOrder, emcapApp, {});
    ok(r2 && r2.posted === true, `the requirements post to a Class order (got ${JSON.stringify(r2)})`);
    const clsRows = (await db.query(
      `SELECT direction, content FROM class_notes WHERE class_order_row=$1`, [classOrder])).rows;
    ok(clsRows.length === 1 && clsRows[0].direction === 'FromClient', 'exactly one note is on the Class thread');
    ok(clsRows[0] && clsRows[0].content.startsWith(reqs.MARKER) && /within 1 mile/.test(clsRows[0].content),
      'the Class note carries the same requirements');
    ok(clsRows[0] && clsRows[0].content === nanBody, 'both vendors are told EXACTLY the same thing (one definition)');
    const cAgain = await poster.postForClassOrder(db, classOrder, emcapApp, {});
    ok(cAgain && cAgain.posted === false && cAgain.reason === 'already_posted', 'a second Class pass posts nothing');

    // ── 4. EVERY OTHER FILE IS SILENT ──────────────────────────────────────
    const blueApp = await mkFile('Blue Lake Capital', 'gold');
    const blueOrder = await mkAmcOrder(blueApp);
    const r3 = await poster.postForAmcOrder(db, blueOrder, { deps });
    ok(r3 && r3.posted === false && r3.reason === 'no_requirements', 'a different investor gets no message');
    ok((await db.query(`SELECT count(*)::int n FROM amc_order_comments WHERE order_id=$1`, [blueOrder.id])).rows[0].n === 0,
      'nothing at all is written on the other investor\'s thread');

    const noneApp = await mkFile(null, null);
    const noneOrder = await mkAmcOrder(noneApp);
    ok((await poster.postForAmcOrder(db, noneOrder, { deps })).posted === false, 'a file with no investor gets no message');

    // ── 5. A SILVER FILE NOT YET STAMPED IS STILL COVERED ─────────────────
    // `applications.lender` is stamped from the registered program, but an order
    // can be placed before that has happened. The fallback reads the SAME
    // derivation, so the two can never disagree about who a Silver loan is for.
    const silverApp = await mkFile(null, 'silver');
    const silverOrder = await mkAmcOrder(silverApp);
    const r5 = await poster.postForAmcOrder(db, silverOrder, { deps });
    ok(r5 && r5.posted === true, 'a Silver file whose note buyer is not stamped yet still gets the message');

    // ── 6. A RENTAL EXIT IS TOLD ABOUT THE 1007 ───────────────────────────
    const rentalApp = await mkFile('EMCAP Financial', 'silver');
    await db.query(`UPDATE applications SET rehab_type='Fix & Hold', loan_type='Fix & Hold' WHERE id=$1`, [rentalApp]);
    const rentalOrder = await mkAmcOrder(rentalApp);
    await poster.postForAmcOrder(db, rentalOrder, { deps });
    const rentalBody = (await db.query(`SELECT body FROM amc_order_comments WHERE order_id=$1`, [rentalOrder.id])).rows[0];
    ok(rentalBody && /1007/.test(reqsOnly(rentalBody.body)), 'a rental-exit file is told a rent schedule is required');

    // ── 7. BOTH PLACEMENT PATHS ACTUALLY CALL IT ──────────────────────────
    // A poster nobody calls is the entire bug this feature exists to avoid, and
    // no unit test can see a call site.
    const fs = require('fs');
    const amcSrc = fs.readFileSync(R + '/src/amc/order-service.js', 'utf8');
    const clsSrc = fs.readFileSync(R + '/src/routes/class.js', 'utf8');
    ok(/order-requirements-post[\s\S]{0,120}postForAmcOrder/.test(amcSrc),
      'the NAN order path posts the requirements after placing');
    ok(/order-requirements-post[\s\S]{0,140}postForClassOrder/.test(clsSrc),
      'the Class order path posts the requirements after placing');
    // ...and AFTER the order is recorded as placed, never before it exists.
    ok(amcSrc.indexOf('postForAmcOrder') > amcSrc.indexOf('const ack = cdg.parseAck(resp)'),
      'the NAN post happens after the vendor acknowledged the order');
    ok(clsSrc.indexOf('postForClassOrder') > clsSrc.indexOf("status: 'ordered'"),
      'the Class post happens after the order is recorded as placed');

    // ── 8. IT CAN NEVER FAIL AN ORDER ─────────────────────────────────────
    // The appraisal is already placed by the time this runs, so every failure
    // path must come back as a verdict rather than a throw.
    const broken = { transport: { write: async () => { throw new Error('vendor on fire'); } }, authContext: {} };
    const burnApp = await mkFile('EMCAP Financial', 'silver');
    const burnOrder = await mkAmcOrder(burnApp);
    const r8 = await poster.postForAmcOrder(db, burnOrder, { deps: broken });
    ok(r8 && r8.posted === false, 'a vendor failure comes back as a verdict, not a throw');
    ok((await poster.postForAmcOrder(db, null, { deps })).posted === false, 'no order at all → a verdict, not a throw');
    ok((await poster.postForClassOrder(db, null, null, {})).posted === false, 'no Class order → a verdict, not a throw');
    // A failed Class send still leaves the message ON the thread with the reason,
    // so nobody has to retype it — the vendor module's own contract.
    ok((await db.query(`SELECT count(*)::int n FROM class_notes WHERE class_order_row=$1`, [classOrder])).rows[0].n === 1,
      'the Class note row survives regardless of the send');
  } catch (e) {
    fail++; console.log('  FAIL: harness threw:', e && e.stack ? e.stack : e);
  }

  await db.pool.end().catch(() => {});
  console.log(`investor order message: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
