'use strict';
/**
 * THE EXPERIENCE RE-ALLOCATION CARVE-OUT + THE SUPER-ADMIN DETAILS OVERRIDE, end to
 * end against a real Postgres (owner-directed 2026-08-13).
 *
 * THE OWNER'S STORY, in order: a term sheet was signed and issued on an application
 * claiming THREE fix-and-flips. Verification came back TWO fix-and-flips and ONE
 * fix-and-hold — the same three deals — and the track-record condition could not be
 * signed off because it must MATCH, and the application could not be edited because
 * the file was term-sheet-frozen. This proves each link of that chain:
 *
 *   A. CONTROL — a plain experience write really does reopen Products & Pricing and
 *      the signed-term-sheet condition and flag the registration stale. Without this
 *      the capture/restore below could be doing nothing and every other assertion
 *      would still pass.
 *   B. THE FREEZE REFUSES a non-neutral experience change, for every role.
 *   C. THE RE-ALLOCATION IS ALLOWED, and — the load-bearing part — the sent term
 *      sheet comes out of it untouched: both conditions still signed off, the
 *      registration still not stale, the loan amount unmoved.
 *   D. THE REGISTRATION'S STORED SPLIT MOVES WITH IT, which is what actually lets the
 *      condition be signed off: `signOffGate` measures the verified track record
 *      against the REGISTRATION, not the application's claim, so without this the
 *      owner would edit the application and the condition would go on demanding
 *      three verified FLIPS.
 *   E. THE QUOTE IS UNCHANGED — re-pricing at the new split reproduces the stored
 *      quote's borrower-visible numbers byte for byte, which is the claim the whole
 *      carve-out rests on.
 *   F. THE SUPER-ADMIN OVERRIDE lets 10 flips → 5 flips + 5 REO through (a plain
 *      admin never), keeps the term sheet, and does NOT rewrite the priced basis.
 *   G. A TRIPWIRE — the capture set stays in lock-step with what the trigger reopens.
 *
 * DB-gated: skips when DATABASE_URL is unset.
 */
if (!process.env.DATABASE_URL) { console.log('test-experience-realloc-db: SKIP (no DATABASE_URL)'); process.exit(0); }

const db = require('../src/db');
const pricing = require('../src/lib/pricing');
const fileLock = require('../src/lib/file-lock');
const detailsFreeze = require('../src/lib/details-freeze');
const experience = require('../src/lib/experience');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const uniq = `exr-${process.pid}-${Date.now()}`;
const rnd = () => Math.random().toString(36).slice(2, 8);

/**
 * A REGISTERED, TERM-SHEET-FROZEN file claiming `flips` fix-and-flips, with the
 * Products & Pricing and signed-term-sheet conditions signed off. Mirrors
 * test-asis-arv-override-db's builder so the two read the same way.
 */
async function mkRegisteredFrozen({ flips = 3, holds = 0, ground = 0 } = {}) {
  const staffId = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Ada Admin','super_admin',true) RETURNING id`,
    [`${uniq}-${rnd()}@x.test`])).rows[0].id;
  const bId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email,fico) VALUES ('Bo','Rrower',$1,720) RETURNING id`,
    [`${uniq}-${rnd()}@x.test`])).rows[0].id;
  const appId = (await db.query(
    `INSERT INTO applications (borrower_id, ys_loan_number, property_address, status, loan_type, program, term,
                               purchase_price, as_is_value, arv, rehab_budget, units, property_type,
                               requested_exp_flips, requested_exp_holds, requested_exp_ground, requested_exp_reo)
     VALUES ($1,$2,$3,'underwriting','Purchase','Standard','12 Months',100000,200000,500000,50000,1,'sfr',$4,$5,$6,0)
     RETURNING id`,
    [bId, `YSX${String(Math.random()).slice(-9)}`,
      JSON.stringify({ line1: '1 Main St', city: 'Lakewood', state: 'NJ', zip: '08701' }),
      flips, holds, ground])).rows[0].id;

  const app = (await db.query(`SELECT * FROM applications WHERE id=$1`, [appId])).rows[0];
  app.fico = 720;
  const inputs = pricing.buildInputs(app, { flips, holds, ground }, {});
  const quote = pricing.quoteProgram('standard', inputs);
  await db.query(
    `INSERT INTO product_registrations (application_id, is_current, program, product_label, quote, inputs,
                                        total_loan, note_rate, registered_by, stale)
     VALUES ($1,true,'standard','Standard Program',$2,$3,$4,$5,$6,false)`,
    [appId, JSON.stringify(quote), JSON.stringify(inputs),
      quote.sizing ? Math.round(quote.sizing.totalLoan || 0) : 0, quote.noteRate || 0, staffId]);

  // Term-sheet-FROZEN: a SENT term_sheet_package envelope.
  await db.query(
    `INSERT INTO esign_envelopes (application_id, purpose, status, countersign_required, product_version, envelope_id)
     VALUES ($1,'term_sheet_package','sent',true,0,$2)`, [appId, `${uniq}-ENV-${rnd()}`]);

  const ppTpl = (await db.query(`SELECT id FROM checklist_templates WHERE code='rtl_p1_product'`)).rows[0];
  await db.query(
    `INSERT INTO checklist_items (application_id, template_id, scope, label, tool_key, item_kind, status, signed_off_at, signed_off_by)
     VALUES ($1,$2,'application','Products & pricing','product_pricing','condition','satisfied',now(),$3)`,
    [appId, ppTpl ? ppTpl.id : null, staffId]);
  const stsTpl = (await db.query(`SELECT id FROM checklist_templates WHERE code='rtl_cond_signedts'`)).rows[0];
  await db.query(
    `INSERT INTO checklist_items (application_id, template_id, scope, label, item_kind, status, signed_off_at, signed_off_by)
     VALUES ($1,$2,'application','Signed term sheet','document','satisfied',now(),$3)`,
    [appId, stsTpl ? stsTpl.id : null, staffId]);

  return { appId, staffId, inputs, quote };
}

const ppState = async (appId) => (await db.query(
  `SELECT status, signed_off_at FROM checklist_items WHERE application_id=$1 AND tool_key='product_pricing' LIMIT 1`, [appId])).rows[0];
const stsState = async (appId) => (await db.query(
  `SELECT ci.status, ci.signed_off_at FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
    WHERE ci.application_id=$1 AND t.code='rtl_cond_signedts' LIMIT 1`, [appId])).rows[0];
const reg = async (appId) => (await db.query(
  `SELECT stale, total_loan, inputs, quote FROM product_registrations WHERE application_id=$1 AND is_current LIMIT 1`, [appId])).rows[0];
const appExp = async (appId) => (await db.query(
  `SELECT requested_exp_flips f, requested_exp_holds h, requested_exp_ground g, requested_exp_reo r
     FROM applications WHERE id=$1`, [appId])).rows[0];

/* THE FULL FORM BODY the details editor really posts — every field, echoed back
   unchanged except the experience counts. Using anything smaller here would test a
   request the screen never sends, and would hide the whole reason the scope test had
   to become a VALUE test rather than a key test. */
function fullBody(app, over = {}) {
  return {
    program: app.program, loanType: app.loan_type, propertyType: app.property_type,
    occupancy: app.occupancy || '', units: String(app.units ?? ''),
    purchasePrice: String(app.purchase_price ?? ''), asIsValue: String(app.as_is_value ?? ''),
    arv: String(app.arv ?? ''), rehabBudget: String(app.rehab_budget ?? ''),
    rehabType: app.rehab_type || '', sqftPre: '', sqftPost: '',
    requestedExpFlips: String(app.requested_exp_flips ?? 0),
    requestedExpHolds: String(app.requested_exp_holds ?? 0),
    requestedExpGround: String(app.requested_exp_ground ?? 0),
    requestedExpReo: String(app.requested_exp_reo ?? 0),
    /* MIRROR THE FORM EXACTLY: EditFileDetails renders a NULL column as '' (its
       `num()` helper), never as '0'. Writing `?? 0` here made the fixture post a
       value the real screen never sends — which is how the first run of this suite
       reported a failure the product did not have, while ALSO exposing a real one
       (blank vs NULL vs '0' are the same stored value on a zero-default column, and
       the comparison did not know it). Keep this in step with `formFrom`. */
    requestedIrMonths: app.requested_ir_months == null ? '' : String(app.requested_ir_months),
    requestedIrAmount: '',
    term: app.term || '', payoffAmount: '', payoffLender: '', payoffLoanNumber: '',
    estimatedCashOut: '', originalPurchasePrice: '', acquisitionDate: '',
    isAssignment: !!app.is_assignment, underlyingContractPrice: '', assignmentFee: '',
    ...over,
  };
}
const load = async (appId) => (await db.query(`SELECT * FROM applications WHERE id=$1`, [appId])).rows[0];

(async () => {
  const lo = { kind: 'staff', role: 'loan_officer' };
  const admin = { kind: 'staff', role: 'admin' };
  const superA = { kind: 'staff', role: 'super_admin' };

  /* ── 0. EVERY MAPPED COLUMN REALLY EXISTS ON `applications` ──────────────────
     `evaluate` SELECTs every column in details-fields.ALL to compare the request
     against the file. A key mapped to a column that does not exist would throw
     there, be caught, and refuse EVERY re-allocation forever — reading, to anyone
     looking, exactly like the ordinary freeze doing its job. That is the
     phantom-column-inside-a-swallowing-catch class this repo has been bitten by
     more than once (`b.full_name`, `a.registered_program`, `is_current` on
     appraisals), and only a real database can catch it. Asserted FIRST so a
     mis-mapped field fails here with a clear message rather than as a confusing
     "mode: refused" three sections down. */
  {
    const fields = require('../src/lib/details-fields');
    const cols = [...new Set(Object.values(fields.ALL))];
    let readOk = true; let err = '';
    try { await db.query(`SELECT ${cols.join(', ')} FROM applications WHERE false`); }
    catch (e) { readOk = false; err = e.message; }
    assert(readOk, `0.1 every column in details-fields.ALL exists on applications (${cols.length} columns)${readOk ? '' : ' — ' + err}`);
  }

  /* ── A. CONTROL: the trigger really fires on an experience write ─────────────── */
  {
    const c = await mkRegisteredFrozen({ flips: 3 });
    assert((await ppState(c.appId)).status === 'satisfied', 'A1 control: P&P starts satisfied');
    await db.query(`UPDATE applications SET requested_exp_flips=2, requested_exp_holds=1 WHERE id=$1`, [c.appId]);
    const pp = await ppState(c.appId);
    assert(pp.status === 'received' && pp.signed_off_at === null,
      'A2 control: a PLAIN experience write REOPENS Products & Pricing — the capture/restore has real work to do');
    assert((await stsState(c.appId)).signed_off_at === null,
      'A3 control: …and un-signs the signed-term-sheet condition');
    assert((await reg(c.appId)).stale === true, 'A4 control: …and marks the registration stale');
  }

  /* ── B. A NON-NEUTRAL EXPERIENCE CHANGE STAYS FROZEN ─────────────────────────── */
  {
    const t = await mkRegisteredFrozen({ flips: 10 });
    const app = await load(t.appId);
    // 10 flips → 5 flips + 5 REO: the owner's own counter-example.
    const body = fullBody(app, { requestedExpFlips: '5', requestedExpReo: '5' });
    const v = await detailsFreeze.evaluate(t.appId, body, db, { actor: lo });
    assert(v.mode === 'refused', 'B1 10 flips → 5 flips + 5 REO is REFUSED (the qualified total drops)');
    assert(/fix-and-flip and fix-and-hold/i.test(v.reason || ''),
      'B2 …and the refusal explains the flip/hold rule instead of only saying "clear the term sheet"');

    // A change to another field alongside a perfectly neutral swap.
    const body2 = fullBody(app, { requestedExpFlips: '5', requestedExpHolds: '5', purchasePrice: '260000' });
    const v2 = await detailsFreeze.evaluate(t.appId, body2, db, { actor: lo });
    assert(v2.mode === 'refused', 'B3 a neutral swap does NOT license a price change riding along');

    // Lowering ground-up.
    /* THE ZERO-DEFAULT COLUMNS, against a REAL row where they are NULL. This is the
       case that failed the first time this suite ran against Postgres: the form posts
       a blank interest-reserve box, the column is NULL, the door would store 0, and
       the comparison called it a change — blocking the carve-out on essentially every
       real file over a field nobody had touched. All three spellings of zero must
       read as the same stored value, and a REAL number must still block. */
    const z = await mkRegisteredFrozen({ flips: 3 });
    const zapp = await load(z.appId);
    assert(zapp.requested_ir_months == null, 'B5 (fixture) the interest-reserve column really is NULL');
    for (const [blankish, label] of [['', 'a blank box'], ['0', 'a typed 0']]) {
      const v = await detailsFreeze.evaluate(z.appId,
        fullBody(zapp, { requestedExpFlips: '2', requestedExpHolds: '1', requestedIrMonths: blankish }),
        db, { actor: lo });
      assert(v.mode === 'reallocation', `B6 ${label} on a NULL zero-default column is NOT a change (got ${v.mode})`);
    }
    const vReal = await detailsFreeze.evaluate(z.appId,
      fullBody(zapp, { requestedExpFlips: '2', requestedExpHolds: '1', requestedIrMonths: '6' }),
      db, { actor: lo });
    assert(vReal.mode === 'refused', 'B7 …but a REAL interest-reserve figure still blocks it');

    const g = await mkRegisteredFrozen({ flips: 3, ground: 2 });
    const gapp = await load(g.appId);
    const v3 = await detailsFreeze.evaluate(g.appId,
      fullBody(gapp, { requestedExpFlips: '1', requestedExpHolds: '2', requestedExpGround: '1' }), db, { actor: superA });
    assert(v3.mode === 'refused', 'B4 a valid flip/hold swap does not license lowering ground-up');
  }

  /* ── C + D + E. THE OWNER'S FILE, END TO END ─────────────────────────────────── */
  {
    const t = await mkRegisteredFrozen({ flips: 3 });
    const app = await load(t.appId);
    const loanBefore = (await reg(t.appId)).total_loan;

    const body = fullBody(app, { requestedExpFlips: '2', requestedExpHolds: '1' });
    const v = await detailsFreeze.evaluate(t.appId, body, db, { actor: lo });
    assert(v.mode === 'reallocation',
      `C1 3 flips → 2 flips + 1 hold is ALLOWED on a frozen file, for a loan officer (got ${v.mode}: ${v.reason || ''})`);

    // Drive the door's own sequence: capture → write → sync the registration → restore.
    const snap = await detailsFreeze.capture(t.appId, v.mode, db);
    assert(!!snap && snap.items.length >= 2, 'C2 the capture picked up both conditions');
    await db.query(`UPDATE applications SET requested_exp_flips=2, requested_exp_holds=1 WHERE id=$1`, [t.appId]);
    await detailsFreeze.syncRegistrationExperience(t.appId, v.after, db);
    await detailsFreeze.restore(t.appId, snap, db);

    const e = await appExp(t.appId);
    assert(e.f === 2 && e.h === 1, 'C3 the application now matches what was verified (2 flips + 1 hold)');

    // THE LOAD-BEARING PART: the sent term sheet came out untouched.
    const pp = await ppState(t.appId);
    assert(pp.status === 'satisfied' && pp.signed_off_at !== null,
      'C4 Products & Pricing is STILL signed off — no re-registration is demanded');
    assert((await stsState(t.appId)).signed_off_at !== null,
      'C5 the signed-term-sheet condition is STILL signed off — the sheet is not superseded');
    const r = await reg(t.appId);
    assert(r.stale === false, 'C6 the registration is STILL not stale — nothing to re-price');
    assert(Number(r.total_loan) === Number(loanBefore), 'C7 the registered loan amount did not move');

    // D. The registration's stored split moved with it — which is what actually
    //    unblocks the condition, because signOffGate reads the REGISTRATION.
    const need = await experience.registeredExperienceNeed(t.appId, db, { flips: 0, holds: 0, ground: 0 });
    assert(need.flips === 2 && need.holds === 1 && need.ground === 0,
      `D1 the experience the CONDITION now requires is 2 flips + 1 hold (got ${JSON.stringify(need)}) — `
      + 'without this the file would still demand three verified FLIPS');

    // E. And the quote it was priced on is byte-identical at the new split — the
    //    claim the whole carve-out rests on, checked rather than asserted.
    const inputs = typeof r.inputs === 'string' ? JSON.parse(r.inputs) : r.inputs;
    const storedQuote = typeof r.quote === 'string' ? JSON.parse(r.quote) : r.quote;
    const reQuote = pricing.quoteProgram('standard', inputs);
    assert(fileLock.finalNumbersKey(reQuote, inputs.term) === fileLock.finalNumbersKey(storedQuote, inputs.term),
      'E1 re-pricing at the NEW split reproduces the stored quote exactly — not one borrower-visible number moves');
    assert(inputs.expFlips === 2 && inputs.expHolds === 1,
      'E2 the registration records the corrected split (a truthful record: the engines read expFlips + expHolds as one number)');
  }

  /* ── F. THE SUPER-ADMIN OVERRIDE ─────────────────────────────────────────────── */
  {
    const t = await mkRegisteredFrozen({ flips: 10 });
    const app = await load(t.appId);
    const over = { requestedExpFlips: '5', requestedExpReo: '5', adminOverride: true, overrideReason: 'Verified: five were REO.' };

    // "Only superadmin, not regular admins."
    const asAdmin = await detailsFreeze.evaluate(t.appId, fullBody(app, over), db, { actor: admin });
    assert(asAdmin.mode === 'refused' && asAdmin.code === 403, 'F1 a plain admin cannot override');
    const asLo = await detailsFreeze.evaluate(t.appId, fullBody(app, over), db, { actor: lo });
    assert(asLo.mode === 'refused', 'F2 a loan officer cannot override');

    // A reason is required.
    const noReason = await detailsFreeze.evaluate(t.appId,
      fullBody(app, { ...over, overrideReason: '   ' }), db, { actor: superA });
    assert(noReason.mode === 'refused' && noReason.code === 400, 'F3 a typed reason is required');

    // The super-admin gets through — for a change that is NOT neutral.
    const v = await detailsFreeze.evaluate(t.appId, fullBody(app, over), db, { actor: superA });
    assert(v.mode === 'admin_override', `F4 a super-admin may force 10 flips → 5 flips + 5 REO (got ${v.mode}: ${v.reason || ''})`);
    assert(v.reason === 'Verified: five were REO.', 'F5 the reason is carried for the audit record');

    const snap = await detailsFreeze.capture(t.appId, v.mode, db);
    await db.query(`UPDATE applications SET requested_exp_flips=5, requested_exp_reo=5 WHERE id=$1`, [t.appId]);
    await detailsFreeze.restore(t.appId, snap, db);

    assert((await ppState(t.appId)).signed_off_at !== null, 'F6 the term sheet is kept — P&P still signed off');
    assert((await reg(t.appId)).stale === false, 'F7 …and the registration is still not stale');
    const need = await experience.registeredExperienceNeed(t.appId, db, { flips: 0, holds: 0, ground: 0 });
    assert(need.flips === 10,
      'F8 the PRICED BASIS is NOT rewritten by an override — the registration still records the 10 the loan was quoted on '
      + '(the db/344 condition override is the recorded way to clear the condition from here)');

    // A super-admin editing a MONEY field is covered too — the owner chose "every
    // field on the Application Details screen".
    const t2 = await mkRegisteredFrozen({ flips: 3 });
    const app2 = await load(t2.appId);
    const money = await detailsFreeze.evaluate(t2.appId,
      fullBody(app2, { purchasePrice: '260000', adminOverride: true, overrideReason: 'Corrected contract price.' }),
      db, { actor: superA });
    assert(money.mode === 'admin_override', 'F9 the override covers every details field, not only experience');
    const moneyAsLo = await detailsFreeze.evaluate(t2.appId, fullBody(app2, { purchasePrice: '260000' }), db, { actor: lo });
    assert(moneyAsLo.mode === 'refused', 'F10 …and without it a price change is still frozen for everyone else');
  }

  /* ── G. TRIPWIRE: the capture set vs what the trigger actually reopens ────────── */
  {
    /* `capture()` restores a FIXED set of conditions. If a future migration widens the
       reopen trigger to touch ANOTHER condition on an experience change, a carved-out
       save would silently leave that one reopened — the restore would not know about
       it. This proves the two are in lock-step: on a plain experience write, the ONLY
       conditions that lose their sign-off are ones the capture set covers. If it
       fires, extend EXPERIENCE_CONDITION_SQL in src/lib/details-freeze.js. */
    const c = await mkRegisteredFrozen({ flips: 3 });
    // Add every other condition the trigger is known to touch, signed off, so a
    // widened trigger would visibly un-sign one of them.
    for (const code of ['rtl_cond_iska']) {
      const tpl = (await db.query(`SELECT id FROM checklist_templates WHERE code=$1`, [code])).rows[0];
      if (!tpl) continue;
      await db.query(
        `INSERT INTO checklist_items (application_id, template_id, scope, label, item_kind, status, signed_off_at, signed_off_by)
         VALUES ($1,$2,'application',$3,'document','satisfied',now(),$4)`,
        [c.appId, tpl.id, code, c.staffId]);
    }
    const captured = new Set((await detailsFreeze.capture(c.appId, 'reallocation', db)).items.map((i) => String(i.id)));
    const before = (await db.query(
      `SELECT id, signed_off_at FROM checklist_items WHERE application_id=$1`, [c.appId])).rows;
    await db.query(`UPDATE applications SET requested_exp_flips=2, requested_exp_holds=1 WHERE id=$1`, [c.appId]);
    const after = (await db.query(
      `SELECT id, signed_off_at FROM checklist_items WHERE application_id=$1`, [c.appId])).rows;
    const afterById = Object.fromEntries(after.map((r) => [String(r.id), r]));
    const unsignedNotCaptured = before
      .filter((r) => r.signed_off_at !== null && afterById[String(r.id)].signed_off_at === null)
      .filter((r) => !captured.has(String(r.id)));
    assert(unsignedNotCaptured.length === 0,
      `G1 every condition the trigger reopens on an experience change is in the capture set `
      + `(un-restorable: ${unsignedNotCaptured.map((r) => r.id).join(', ') || 'none'})`);
  }

  console.log(failures ? `\ntest-experience-realloc-db: ${failures} FAILURE(S)` : '\ntest-experience-realloc-db: all checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('test-experience-realloc-db CRASHED:', e); process.exit(1); });
