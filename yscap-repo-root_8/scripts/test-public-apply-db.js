/**
 * DB-level test of the PUBLIC marketing intake core (src/routes/intake.js
 * siteIntake — shared by the key-gated /api/intake and the site's own
 * /api/apply): full field mapping (experience claims, interest reserve,
 * assignment, rehab/sqft, DOB/FICO fill-if-blank), the same-email/different-
 * person guard, the borrowerExisted/hasAuth account-offer flags, and the
 * followUp side effects (co-borrower attach, vesting LLC wiring, checklist
 * generation). Also round-trips the shared form token (lib/form-token).
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-public-apply-db (no DATABASE_URL)'); process.exit(0); }
let failures = 0;
const assert = (c, m, extra) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}${!c && extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`); if (!c) failures++; };

const db = require('../src/db');
const { siteIntake } = require('../src/routes/intake');
const formToken = require('../src/lib/form-token');

(async () => {
  // ---- shared form token round-trip (pure) ----
  const tok = formToken.signFormToken(String(Date.now() - 5000));
  assert(formToken.formTokenAgeMs(tok) >= 5000, 'form token verifies and reports age');
  assert(formToken.formTokenAgeMs('123.deadbeef') === null, 'malformed form token rejected');
  assert(formToken.formTokenOk(formToken.signFormToken(String(Date.now()))) === false, 'too-fresh token fails the dwell check');

  const uniq = `${process.pid}.${Date.now()}`;
  const email = `apply.core.${uniq}@example.test`;
  const p = {
    b1First: 'Public', b1Last: 'Applytest', b1Email: email, b1Phone: '9175550190',
    b1Citizen: 'US Citizen', b1Ssn: '123-45-6789', b1Dob: '1985-06-15', fico: '731',
    b2First: 'Co', b2Last: 'Applytest', b2Email: `apply.co.${uniq}@example.test`,
    dealType: 'Fix & Flip', purpose: 'Purchase', rehabType: 'Heavy Reno',
    pStreet: '21 Intake Core Way', pCity: 'Albany', pState: 'NY', pZip: '12207',
    propType: 'Single Family', units: '1',
    price: '$510,000', asIs: '$525,000', arv: '$720,000', rehab: '$90,000',
    isAssignment: true, underlyingContractPrice: '$490,000', assignmentFee: '$20,000',
    sqftPre: '1,500', sqftPost: '2,300',
    requestedIrMonths: '7', expFlips: '4', expBrrrr: '2', expGround: '1',
    eName: `Apply Core Holdings ${uniq} LLC`, eState: 'NY', eEin: '12-3456789',
  };

  // ---- fresh submission: full mapping ----
  const out = await siteIntake(p, { source: 'website_form' });
  assert(!!out.borrowerId && !!out.applicationId, 'fresh submission creates borrower + application');
  assert(out.dup === false && out.borrowerExisted === false && out.hasAuth === false, 'fresh submission flags → account mode create', out);
  await out.followUp();

  const a = (await db.query(
    `SELECT source, program, loan_type, is_assignment, underlying_contract_price::numeric AS ucp,
            assignment_fee::numeric AS fee, requested_ir_months, requested_exp_flips,
            requested_exp_holds, requested_exp_ground, rehab_type, sqft_pre, sqft_post,
            co_borrower_id, llc_id
       FROM applications WHERE id=$1`, [out.applicationId])).rows[0];
  assert(a.source === 'website_form', 'source recorded', a.source);
  assert(a.is_assignment === true && Number(a.ucp) === 490000 && Number(a.fee) === 20000, 'assignment trio mapped', a);
  assert(a.requested_ir_months === 7, 'interest-reserve months mapped (clamped 0..24)', a.requested_ir_months);
  assert(a.requested_exp_flips === 4 && a.requested_exp_holds === 2 && a.requested_exp_ground === 1, 'experience claims mapped (holds ← expBrrrr)', a);
  assert(a.rehab_type === 'Heavy Reno' && a.sqft_pre === 1500 && a.sqft_post === 2300, 'rehab type + sqft mapped', a);
  assert(!!a.co_borrower_id, 'co-borrower attached in followUp');
  assert(!!a.llc_id, 'vesting LLC wired in followUp');
  const b = (await db.query(`SELECT date_of_birth::text AS dob, fico, ssn_last4 FROM borrowers WHERE id=$1`, [out.borrowerId])).rows[0];
  assert(b.dob === '1985-06-15' && b.fico === 731 && b.ssn_last4 === '6789', 'DOB/FICO/SSN stored', b);
  const cl = (await db.query(`SELECT count(*)::int AS n FROM checklist_items WHERE application_id=$1`, [out.applicationId])).rows[0];
  assert(cl.n > 0, `checklist generated (${cl.n} items)`);

  // ---- DOB/FICO are fill-if-blank: a second submission never overwrites ----
  const out2 = await siteIntake({ ...p, b1Dob: '1999-01-01', fico: '600', pStreet: '22 Intake Core Way' }, { source: 'website_form' });
  assert(out2.borrowerId === out.borrowerId, 'same person reuses the profile');
  assert(out2.borrowerExisted === true, 'existing profile flagged (→ claim/login offer)');
  const b2 = (await db.query(`SELECT date_of_birth::text AS dob, fico FROM borrowers WHERE id=$1`, [out.borrowerId])).rows[0];
  assert(b2.dob === '1985-06-15' && b2.fico === 731, 'second submission did NOT overwrite DOB/FICO', b2);

  // ---- hasAuth flips once credentials exist ----
  await db.query(`INSERT INTO borrower_auth (borrower_id, password_hash, token_version) VALUES ($1,'x',0)
                  ON CONFLICT (borrower_id) DO NOTHING`, [out.borrowerId]);
  const out3 = await siteIntake({ ...p, pStreet: '23 Intake Core Way' }, { source: 'website_form' });
  assert(out3.borrowerExisted === true && out3.hasAuth === true, 'existing credentials flagged (→ login offer)', out3.hasAuth);

  // ---- same email, DIFFERENT person: never adopts the profile ----
  const outDup = await siteIntake({ ...p, b1First: 'Different', b1Last: 'Person', pStreet: '24 Intake Core Way' }, { source: 'website_form' });
  assert(outDup.dup === true, 'shared-email/different-name flagged as dup');
  assert(outDup.borrowerId !== out.borrowerId, 'dup submission got its OWN profile');
  const dupB = (await db.query(`SELECT email FROM borrowers WHERE id=$1`, [outDup.borrowerId])).rows[0];
  assert(/@clickup\.local$/.test(dupB.email), 'dup profile carries a placeholder email (real one preserved as contact)', dupB.email);

  /* ---- THE PUBLIC FORM'S OWN DIALECT IS STORED CANONICALLY -------------------
     Owner-reported 2026-08-26 (YSCAP258134859): a fix & hold whose ClickUp
     *Program field was blank. The form's <option value> attributes were written
     for DISPLAY and were never made the values the system stores, so this door
     filed them raw and the ClickUp push had no key for them — it dropped each
     field in silence. Measured against the live dropdowns it was four fields:
     3 of 4 programs, BOTH refinances, 5 of 7 property types, 2 of 5 rehab types.

     Posted here through the REAL door with the REAL strings the shipped form
     sends, because a unit test of the folder proves the rule and not the wiring. */
  const XW = require('../src/clickup/crosswalk');
  const formPost = await siteIntake({
    ...p,
    pStreet: '25 Intake Core Way',
    dealType: 'Fix & Hold (BRRRR)',      // #dealType, verbatim from the form
    purpose: 'Cash-Out Refi',            // radio name="purpose"
    propType: '2–4 Unit',           // #propType (en dash, as the form writes it)
    rehabType: 'Heavy',                  // #rehabType — note this is ClickUp's label, not ours
    // A refinance carries no purchase side; keep the post honest.
    isAssignment: false, underlyingContractPrice: null, assignmentFee: null,
  }, { source: 'website_form' });
  const fp = (await db.query(
    `SELECT program, loan_type, property_type, rehab_type FROM applications WHERE id=$1`,
    [formPost.applicationId])).rows[0];
  assert(fp.program === 'Fix & Hold', 'the form\'s "Fix & Hold (BRRRR)" is stored as the canonical Fix & Hold', fp.program);
  assert(fp.loan_type === 'Refinance — Cash-Out', 'the form\'s "Cash-Out Refi" is stored canonically', fp.loan_type);
  assert(fp.property_type === 'Multi 2–4', 'the form\'s "2–4 Unit" is stored canonically', fp.property_type);
  assert(fp.rehab_type === 'Heavy / gut rehab', 'the form\'s "Heavy" (a ClickUp label) is stored as our own value', fp.rehab_type);
  // And every one of them now reaches a real ClickUp option — the actual symptom.
  for (const [col, val, want] of [
    ['program', fp.program, 'Fix & Hold With Construction'],
    ['loan_type', fp.loan_type, 'Refi Cash-Out'],
    ['property_type', fp.property_type, 'Multi 2-4'],
    ['rehab_type', fp.rehab_type, 'Heavy'],
  ]) {
    assert(XW.toClickUpLabel(col, val) === want, `${col} pushes to the ClickUp option "${want}" instead of being dropped`, XW.toClickUpLabel(col, val));
  }
  // A value we do not recognise still reaches the file exactly as typed — never
  // blanked, never nudged into a neighbouring option (the 'Heavy Reno' case above
  // is the same rule on the rehab type).
  const oddPost = await siteIntake({ ...p, pStreet: '26 Intake Core Way', dealType: 'Some Brand New Program' }, { source: 'website_form' });
  const odd = (await db.query(`SELECT program FROM applications WHERE id=$1`, [oddPost.applicationId])).rows[0];
  assert(odd.program === 'Some Brand New Program', 'an unrecognised program is stored unchanged, never blanked', odd.program);

  console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('test-public-apply-db crashed:', e); process.exit(2); });
