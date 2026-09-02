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
    ok(/12 months/.test(nanBody) && /15% net adjustment/.test(nanBody) && /within 1 mile/.test(nanBody),
      'it carries the anchor rule: 12 months, under 15%, within the mile');
    // THE WITHDRAWN WORDING NEVER GOES OUT AGAIN (owner-directed 2026-09-01).
    ok(!/Comparable sales must be within/.test(nanBody) && !/[Ii]nterior photograph/.test(nanBody)
      && !/lender\/client/.test(nanBody), 'the posted message carries none of the three withdrawn items');
    ok(!reqs.isSupersededMessage(nanBody), 'what goes out today is not something the correction job would correct');
    ok(/YSCAP-/.test(nanBody) && /27 Beacon St/.test(nanBody), 'it names the loan and the property');
    ok(!borrowerSafe.hasPartnerName(nanBody) && !/emcap/i.test(nanBody),
      'the message to an OUTSIDE company names no capital partner');
    // THE ANCHOR'S THREE CRITERIA, ON THE REAL POSTED ROW, NUMBERED 1-3
    // (owner-directed 2026-09-01: "name it 1, 2, 3").
    ok(/all THREE of/.test(nanBody) && nanBody.split('\n').filter((l) => /^[123]\. /.test(l)).length === 3,
      'the posted message spells the anchor comp out as three numbered criteria');
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
    ok(clsRows[0] && clsRows[0].content.startsWith(reqs.MARKER) && /all THREE of/.test(clsRows[0].content),
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

    // ── 9. THE ONE-TIME CORRECTION reaches every order that got the old message ──
    // (owner-directed 2026-09-01). The withdrawn 2026-08-16 wording is planted on
    // real thread rows exactly as it was posted, then the job runs.
    const OLD = (loan) => [
      `${reqs.MARKER} — Loan #${loan} · 27 Beacon St, Lakewood, NJ 08701`, '',
      'Before this report is submitted, please make sure it meets the following.', '',
      '1. Comparable sales must be within 1 mile of the subject.',
      '2. At least one As-Is comparable — must be an "anchor" comp that meets all THREE of:',
      '      a. within 1 mile of the subject;', '      b. sold within the last 12 months;', '      c. under 15% net adjustment.',
      '3. Interior photographs of the subject are required.',
      '4. The report must name YS Capital as the lender/client.',
    ].join('\n');
    const plantNan = (orderId, body) => db.query(
      `INSERT INTO amc_order_comments (order_id, direction, body, author_name) VALUES ($1,'outbound',$2,'PILOT')`, [orderId, body]);
    const plantClass = (rowId, appId, body) => db.query(
      `INSERT INTO class_notes (class_order_row, application_id, direction, content, sent_at) VALUES ($1,$2,'FromClient',$3,now())`, [rowId, appId, body]);
    const nanCorrections = (orderId) => db.query(
      `SELECT body FROM amc_order_comments WHERE order_id=$1 AND body LIKE $2`, [orderId, reqs.CORRECTION_MARKER + '%']).then((r) => r.rows);
    const classCorrections = (rowId) => db.query(
      `SELECT content FROM class_notes WHERE class_order_row=$1 AND content LIKE $2`, [rowId, reqs.CORRECTION_MARKER + '%']).then((r) => r.rows);

    // (a) a live NAN order and a COMPLETED one — both told the wrong rule → both corrected ("everybody").
    const cApp = await mkFile('EMCAP Financial', 'silver');
    const liveNan = await mkAmcOrder(cApp);      await plantNan(liveNan.id, OLD('LIVE'));
    const doneNan = await mkAmcOrder(cApp);
    await db.query(`UPDATE amc_orders SET status='completed' WHERE id=$1`, [doneNan.id]);
    await plantNan(doneNan.id, OLD('DONE'));
    // (b) a CANCELLED order told the wrong rule → left alone (nobody is working it).
    const deadNan = await mkAmcOrder(cApp);
    await db.query(`UPDATE amc_orders SET status='cancelled' WHERE id=$1`, [deadNan.id]);
    await plantNan(deadNan.id, OLD('DEAD'));
    // (c) an order that got TODAY's wording → nothing to correct.
    const freshNan = await mkAmcOrder(cApp);
    await poster.postForAmcOrder(db, freshNan, { deps });
    // (d) a Class order told the wrong rule → corrected on ITS thread.
    const cClass = await mkClassOrder(cApp);     await plantClass(cClass, cApp, OLD('CLASS'));
    // (e) a file whose investor has since CHANGED → no correction (it would state a requirement the file no longer has).
    const movedApp = await mkFile('EMCAP Financial', 'silver');
    const movedNan = await mkAmcOrder(movedApp); await plantNan(movedNan.id, OLD('MOVED'));
    await db.query(`UPDATE applications SET lender='Blue Lake Capital' WHERE id=$1`, [movedApp]);
    // (f) a rental-exit file → its correction carries the rent line.
    const rentApp = await mkFile('EMCAP Financial', 'silver');
    await db.query(`UPDATE applications SET rehab_type='Fix & Hold', loan_type='Fix & Hold' WHERE id=$1`, [rentApp]);
    const rentNan = await mkAmcOrder(rentApp);   await plantNan(rentNan.id, OLD('RENT'));

    const sentBefore = sent.length;
    const run1 = await poster.correctSupersededOnce(db, { deps, limit: 500 });
    // The selection is global (every superseded order in the database), so other
    // test data may be in it — assert on OUR orders, and that ours are counted.
    ok(run1 && run1.corrected >= 4, `the pass corrected at least our four (got ${JSON.stringify(run1)})`);
    ok((await nanCorrections(liveNan.id)).length === 1, 'the live NAN order got exactly one correction');
    ok((await nanCorrections(doneNan.id)).length === 1, 'the COMPLETED NAN order got one too — "everybody"');
    ok((await nanCorrections(deadNan.id)).length === 0, 'the cancelled order was left alone');
    ok((await nanCorrections(freshNan.id)).length === 0, 'an order that got today\'s wording is not corrected');
    ok((await classCorrections(cClass)).length === 1, 'the Class order got exactly one correction on its own thread');
    ok((await nanCorrections(movedNan.id)).length === 0, 'a file whose investor changed gets no correction');
    const rentCorr = (await nanCorrections(rentNan.id))[0];
    ok(rentCorr && /1007/.test(reqsOnly(rentCorr.body)), 'a rental-exit file\'s correction carries the rent line');
    const liveCorr = (await nanCorrections(liveNan.id))[0];
    ok(liveCorr && liveCorr.body === reqs.correctionMessage({ investorKey: 'emcap', loanNumber: null, propertyAddress: null,
      rentalExit: false }).replace(reqs.CORRECTION_MARKER, liveCorr.body.split('\n')[0]),
      'the posted correction is the module\'s own text (one definition), with the file\'s identifier line');
    ok(/every comparable sale must be within 1 mile/.test(liveCorr ? liveCorr.body : '')
      && !borrowerSafe.hasPartnerName(liveCorr ? liveCorr.body : ''),
      'it says what was wrong, and names no capital partner on the way out');
    ok(sent.length - sentBefore >= 3, 'each NAN correction was actually handed to the vendor transport (Class goes through its own dry-run)');
    // The requirements poster and the correction never confuse each other's marker:
    // the original message is still the only REQUIREMENTS message on the thread.
    ok((await poster.postForAmcOrder(db, liveNan, { deps })).reason === 'already_posted',
      'a corrected order still counts as "requirements already posted" (the correction is not a second copy)');

    // IT RUNS ONCE. A second boot adds nothing to any of them.
    const run2 = await poster.correctSupersededOnce(db, { deps, limit: 500 });
    ok(run2 && run2.corrected === 0, `a second pass posts nothing (got ${JSON.stringify(run2)})`);
    ok((await nanCorrections(liveNan.id)).length === 1 && (await nanCorrections(doneNan.id)).length === 1
      && (await classCorrections(cClass)).length === 1, 'still exactly one correction per order');

    // A VENDOR FAILURE IS A RETRY, NEVER A DUPLICATE: with the transport down the
    // order stays selected; once it is back, one correction lands.
    const retryApp = await mkFile('EMCAP Financial', 'silver');
    const retryNan = await mkAmcOrder(retryApp); await plantNan(retryNan.id, OLD('RETRY'));
    const down = await poster.correctSupersededOnce(db, { deps: broken, limit: 500 });
    ok(down && down.failed >= 1 && (await nanCorrections(retryNan.id)).length === 0,
      'with the vendor down, the failure is counted and nothing is written as if it had gone out');
    const up = await poster.correctSupersededOnce(db, { deps, limit: 500 });
    ok(up && up.corrected === 1 && (await nanCorrections(retryNan.id)).length === 1,
      'once the vendor is back, the pending order gets its one correction');

    // ── 10. WHAT THE ORDER SCREEN IS TOLD BEFORE THE ORDER (owner-directed 2026-09-01) ──
    const sEmcap = await poster.summaryFor(db, emcapApp);
    ok(sEmcap && sEmcap.investor === 'emcap' && sEmcap.needsProvider === false && typeof sEmcap.message === 'string'
      && sEmcap.message === reqs.orderMessage({ investorKey: 'emcap', loanNumber: sEmcap.message.match(/Loan #(\S+)/)[1],
        propertyAddress: '27 Beacon St, Lakewood, NJ 08701', rentalExit: false }),
      'an EMCAP file: the screen sees the investor and the EXACT message that will be posted');
    const sBlue = await poster.summaryFor(db, blueApp);
    ok(sBlue && sBlue.investor === null && sBlue.needsProvider === false && sBlue.message === null
      && sBlue.noteBuyer === 'Blue Lake Capital',
      'a file with a named provider that has no requirements: a decision exists ("nothing"), so no ask');
    const sNone = await poster.summaryFor(db, noneApp);
    ok(sNone && sNone.needsProvider === true && sNone.investor === null && sNone.message === null,
      'a file with NO note buyer and NO program: the officer is asked to pick (optional)');
    const sSilver = await poster.summaryFor(db, silverApp);
    ok(sSilver && sSilver.needsProvider === false && sSilver.investor === 'emcap',
      'a Silver file with no stamped buyer is NOT asked — the program already decides');
    ok((await poster.summaryFor(db, '00000000-0000-0000-0000-000000000000')) === null, 'an unknown file → null, never a half answer');
    // Picking the provider through the ONE write path flips the ask off.
    await db.query(`UPDATE applications SET lender='EMCAP Financial' WHERE id=$1`, [noneApp]);
    const sPicked = await poster.summaryFor(db, noneApp);
    ok(sPicked && sPicked.needsProvider === false && sPicked.investor === 'emcap' && !!sPicked.message,
      'once a provider is on the file, the ask is gone and the message is shown');
    // The route that serves it exists and is the file-scoped staff router (never a borrower surface).
    const staffSrc = fs.readFileSync(R + '/src/routes/staff.js', 'utf8');
    ok(/router\.get\('\/applications\/:id\/appraisal-requirements'/.test(staffSrc), 'the staff router serves the summary');
    ok(!/appraisal-requirements/.test(fs.readFileSync(R + '/src/routes/borrower.js', 'utf8')), 'no borrower route serves it');

    // THE BOOT CALLS IT — a job nobody runs is the whole bug.
    const serverSrc = fs.readFileSync(R + '/src/server.js', 'utf8');
    ok(/order-requirements-post'\)\.correctSupersededOnce\(/.test(serverSrc), 'server.js runs the correction on boot');
    ok(/APPRAISAL_REQS_CORRECTION_DISABLED/.test(fs.readFileSync(R + '/src/lib/appraisal/order-requirements-post.js', 'utf8')),
      'it has a kill switch');
  } catch (e) {
    fail++; console.log('  FAIL: harness threw:', e && e.stack ? e.stack : e);
  }

  await db.pool.end().catch(() => {});
  console.log(`investor order message: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
