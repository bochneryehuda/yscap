'use strict';
/* =====================================================================
   A DRAFT WRITTEN THE OLD WAY STILL HAS TO SUBMIT.

   Found by the pre-merge audit of the studio money hand-off (2026-07-31), in a
   real browser + real Postgres. The hand-off fix stops `lib/scenario.js
   scenarioToDraft` copying the Term Sheet Studio's DISPLAY text into an
   application draft. It cannot repair the drafts that are ALREADY THERE.

   Since #915 shipped "Start this loan →" (borrower Pricing screen and Dashboard),
   every draft a borrower started from a saved pricing scenario was written with
   the studio's own strings:

       { purchasePrice: "412,500", underlyingContractPrice: "380,000",
         asIsValue: "445,000", arv: "689,000", rehabBudget: "90,000" }

   POST /api/borrower/drafts/:id/submit reads that `data` back verbatim and binds
   it into applications' numeric(14,2) columns. Postgres answers:

       invalid input syntax for type numeric: "445,000"

   — a 500. Those borrowers cannot submit their application AT ALL, and no amount
   of fixing the WRITE side reaches a row that is already written. So the last
   mile is guarded instead of trusted: `fields.moneyValue` parses every money
   value on its way to a money column, on every create path.

   THIS TEST FAILS ON THE PRE-FIX SERVER: the legacy-shaped submit throws, and
   assignmentFields hands back the raw string / a NaN purchase price.

   Needs DATABASE_URL (skips the DB half cleanly without it).
   Run: DATABASE_URL=… node scripts/test-studio-draft-submit-db.js
   ===================================================================== */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const F = require('../src/lib/fields');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

/* The EXACT draft `data` the pre-fix scenarioToDraft produced for the audit's
   scenario — total price $412,500, seller's contract $380,000, fee $32,500. */
const LEGACY_DRAFT = {
  loanType: 'Purchase', program: 'Fix & Flip', isAssignment: true,
  purchasePrice: '412,500', underlyingContractPrice: '380,000', assignmentFee: '32,500',
  asIsValue: '445,000', arv: '689,000', rehabBudget: '90,000',
};

console.log('--- the parser at the money column ---');
assert(typeof F.moneyValue === 'function', 'src/lib/fields.js exports moneyValue');
// On the PRE-FIX server it does not exist at all; stand in for it so the rest of
// the run reports what is actually missing instead of dying on the first call.
const mv = typeof F.moneyValue === 'function' ? F.moneyValue : ((v) => (v == null || v === '' ? null : v));
assert(mv('445,000') === 445000, `a grouped value parses (got ${JSON.stringify(mv('445,000'))})`);
assert(mv(null) === null && mv('') === null && mv('abc') === null,
  'blank / nothing-numeric is NULL, never a fabricated 0');
assert(mv('-32,500') === -32500, `a negative keeps its sign (got ${JSON.stringify(mv('-32,500'))})`);

/* ---------------------------------------------------------------------
   PARSING AND "WAS IT PROVIDED?" ARE TWO QUESTIONS (re-audit, 2026-07-31).

   The first cut of this change bound `moneyValue(b.asIsValue) || null`, which
   moved the provided/not-provided test off the RAW value and onto the parsed
   NUMBER. Zero is falsy, and the portal's money contract stores a plain numeric
   STRING — so "0", which is what a MoneyInput holds the instant a human types a
   single 0, went from storing 0.00 to storing NULL on all three create paths.

   That is not a harmless spelling: `rehab_budget != null` is the file's "Rehab
   budget provided" completeness row, `as_is_value IS NULL` is the appraisal
   import's licence to overwrite, the investor-guideline rules answer "not
   evaluated" instead of a verdict on a NULL budget, and db/072 reopens pricing
   on IS DISTINCT FROM. `moneyColumn` is the bind: the raw value decides whether
   anything was provided (exactly as `x || null` always did), and only then is it
   parsed. Both halves are asserted against every shape that reaches a door.
   --------------------------------------------------------------------- */
console.log('\n--- the money BIND: parse, without changing what counts as provided ---');
{
  assert(typeof F.moneyColumn === 'function', 'src/lib/fields.js exports moneyColumn — the bind for a money column');
  const mc = typeof F.moneyColumn === 'function' ? F.moneyColumn : ((v) => (F.moneyValue ? (F.moneyValue(v) || null) : (v || null)));

  // A TYPED ZERO IS A VALUE. Every spelling a MoneyInput can hold.
  const ZEROS = ['0', '0.00', '0.0', '00'];
  const kept = ZEROS.filter((z) => mc(z) === 0);
  assert(kept.length === ZEROS.length,
    `an entered zero still stores 0, never NULL${kept.length === ZEROS.length ? '' : ' — lost ' + ZEROS.filter((z) => mc(z) !== 0).map((z) => `${JSON.stringify(z)} -> ${JSON.stringify(mc(z))}`).join(', ')}`);
  // …while an ABSENT value is still NULL, exactly as the `x || null` bind said.
  assert(mc(0) === null && mc('') === null && mc(null) === null && mc(undefined) === null,
    'an absent value — including the JSON number 0 — is still NULL, exactly as before');
  // and it still parses.
  assert(mc('445,000') === 445000 && mc('$1,200,000.50') === 1200000.50 && mc('abc') === null,
    'and it still parses a formatted value and refuses a non-numeric one');

  /* THE DROP-IN PROOF. For every shape whose OLD bind Postgres accepted, the new
     one has to store the same thing. "Postgres accepted it" is what makes the
     shape a formerly-WORKING path; the shapes it rejected are the 500s this
     change exists to remove. Compared as: was it NULL, and if not, what number. */
  const SHAPES = ['0', '0.00', '00', '-0', '412500', '412500.50', '412500.00', '412.', '.5',
    '-32500', ' 412500 ', '99999999999.99', 412500, 412500.5, -32500, 0, '', null, undefined];
  const oldStores = (v) => (v || null);                       // the bind every create path used
  const bad = SHAPES.filter((v) => {
    const o = oldStores(v), n = mc(v);
    if (o === null || n === null) return (o === null) !== (n === null);
    return Number(o) !== Number(n);
  });
  assert(bad.length === 0,
    `every shape Postgres already accepted stores the SAME value as before${bad.length ? ' — diverges on ' + bad.map((v) => `${JSON.stringify(v)}: ${JSON.stringify(oldStores(v))} -> ${JSON.stringify(mc(v))}`).join(', ') : ''}`);

  // assignmentFields uses the same bind, so a typed zero fee survives there too.
  const zf = F.assignmentFields({ isAssignment: true, loanType: 'Purchase', underlyingContractPrice: '380000', assignmentFee: '0' });
  assert(zf.assignFee === 0, `an assignment fee typed as "0" stores 0, not NULL (got ${JSON.stringify(zf.assignFee)})`);
  const nf = F.assignmentFields({ isAssignment: true, loanType: 'Purchase', underlyingContractPrice: '380000', assignmentFee: 0 });
  assert(nf.assignFee === null, `while an absent fee is still NULL (got ${JSON.stringify(nf.assignFee)})`);
}

(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('SKIP the Postgres half (no DATABASE_URL)');
    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL studio draft-submit (pure) assertions passed');
    process.exit(failures ? 1 : 0);
  }
  const db = require('../src/db');
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let borrowerId = null, staffId = null, server = null;
  try {
    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Draft','Submit',$1) RETURNING id`,
      [`draft-submit-${sfx}@test.local`])).rows[0].id;

    /* 1. PIN THE BUG: the bind the submit route used to build, straight into the
          real table. This is the 500 the borrower hits. */
    console.log('\n--- pinned: the pre-fix bind really is a Postgres error ---');
    let rawError = null;
    try {
      await db.query(
        `INSERT INTO applications (borrower_id,status,loan_type,as_is_value) VALUES ($1,'new','Purchase',$2)`,
        [borrowerId, LEGACY_DRAFT.asIsValue || null]);
    } catch (e) { rawError = e && e.message; }
    assert(rawError && /invalid input syntax for type numeric/.test(rawError),
      `binding the draft's as-is value RAW is a numeric error — this is the borrower's 500 (${rawError || 'no error!'})`);

    /* 2. THE FIX: the same legacy draft, through the same chokepoints the create
          routes now use, lands the right numbers. */
    console.log('\n--- the same legacy draft now submits, with the right numbers ---');
    const asg = F.assignmentFields(LEGACY_DRAFT);
    const appId = (await db.query(
      `INSERT INTO applications
         (borrower_id,status,loan_type,purchase_price,as_is_value,arv,rehab_budget,
          is_assignment,underlying_contract_price,assignment_fee)
       VALUES ($1,'new',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [borrowerId, F.sanitizeLoanType(LEGACY_DRAFT.loanType), asg.purchasePrice,
       mv(LEGACY_DRAFT.asIsValue) || null, mv(LEGACY_DRAFT.arv) || null,
       mv(LEGACY_DRAFT.rehabBudget) || null,
       asg.isAssignment, asg.underlying, asg.assignFee])).rows[0].id;

    const row = (await db.query(
      `SELECT purchase_price, as_is_value, arv, rehab_budget, is_assignment,
              underlying_contract_price, assignment_fee FROM applications WHERE id=$1`, [appId])).rows[0];
    const n = (v) => (v == null ? null : Number(v));
    assert(n(row.purchase_price) === 412500, `purchase_price = the REAL total price (got ${row.purchase_price})`);
    assert(n(row.underlying_contract_price) === 380000, `underlying_contract_price = the seller's contract (got ${row.underlying_contract_price})`);
    assert(n(row.assignment_fee) === 32500, `assignment_fee = the wholesaler's fee (got ${row.assignment_fee})`);
    assert(n(row.as_is_value) === 445000, `as_is_value stored (got ${row.as_is_value})`);
    assert(n(row.arv) === 689000, `arv stored (got ${row.arv})`);
    assert(n(row.rehab_budget) === 90000, `rehab_budget stored (got ${row.rehab_budget})`);
    assert(row.is_assignment === true, 'and the file is still flagged as an assignment');

    /* 3. THE THREE REAL DOORS (re-audit, 2026-07-31). Everything above rebuilds
          the routes' binds by hand, which proves the chokepoint but not that the
          routes USE it — and the three create paths are live doors that worked
          before this change, so "the same value still lands" has to be measured
          through the doors themselves and read back out of Postgres:

            POST /api/borrower/applications      (borrower direct create)
            POST /api/borrower/drafts/:id/submit (the legacy-draft door)
            POST /api/staff/applications         (staff new file)

          Every case runs through ALL THREE, because the whole point of
          lib/fields is that the three can never disagree. */
    console.log('\n--- the same money, through all three real create doors ---');
    const http = require('http');
    const C = require('../src/lib/crypto');
    const app = require('../src/server');
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const call = (method, p, token, body) => new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const rq = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
          ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
        (res) => { let s = ''; res.on('data', (c) => s += c); res.on('end', () => { let j = null; try { j = s ? JSON.parse(s) : null; } catch (_) { j = { _raw: s.slice(0, 120) }; } resolve({ status: res.statusCode, body: j }); }); });
      rq.on('error', reject); if (data) rq.write(data); rq.end();
    });

    const bEmail = `draft-submit-${sfx}@test.local`;
    await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,'x',0) ON CONFLICT DO NOTHING`, [borrowerId]);
    staffId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Studio Officer','loan_officer',true,false,'x',0) RETURNING id`,
      [`draft-submit-lo-${sfx}@test.local`])).rows[0].id;
    const bTok = C.signJwt({ sub: borrowerId, kind: 'borrower', tv: 0 });
    const sTok = C.signJwt({ sub: staffId, kind: 'staff', role: 'loan_officer', tv: 0 });
    const ADDR = { line1: '144 Hewes St', city: 'Brooklyn', state: 'NY', zip: '11211' };

    const DOOR_CASES = [
      // THE BUG THIS CHANGE EXISTS FOR: a pre-#919 draft's display text. Every one
      // of these was `invalid input syntax for type numeric` — a 500, on all three.
      { n: 'a legacy studio assignment (comma-formatted)',
        b: { ...LEGACY_DRAFT },
        want: { purchase_price: 412500, underlying_contract_price: 380000, assignment_fee: 32500,
          as_is_value: 445000, arv: 689000, rehab_budget: 90000, is_assignment: true } },
      { n: 'a plain purchase, comma-formatted',
        b: { loanType: 'Purchase', purchasePrice: '412,500', asIsValue: '445,000', arv: '689,000', rehabBudget: '90,000' },
        want: { purchase_price: 412500, as_is_value: 445000, arv: 689000, rehab_budget: 90000, is_assignment: false } },
      { n: 'a currency symbol and real cents',
        b: { loanType: 'Purchase', purchasePrice: '$1,200,000.50', asIsValue: '$1,250,000.25' },
        want: { purchase_price: 1200000.50, as_is_value: 1250000.25 } },
      // AND THE PATHS THAT ALREADY WORKED — these must be untouched.
      { n: 'clean MoneyInput strings (the normal case)',
        b: { loanType: 'Purchase', purchasePrice: '412500', asIsValue: '445000', arv: '689000', rehabBudget: '90000' },
        want: { purchase_price: 412500, as_is_value: 445000, arv: 689000, rehab_budget: 90000 } },
      { n: 'a TYPED ZERO — still a value, never NULL',
        b: { loanType: 'Purchase', purchasePrice: '350000', asIsValue: '0', arv: '0', rehabBudget: '0' },
        want: { purchase_price: 350000, as_is_value: 0, arv: 0, rehab_budget: 0 } },
      { n: 'a typed zero assignment fee — still a value',
        b: { loanType: 'Purchase', isAssignment: true, purchasePrice: '380000', underlyingContractPrice: '380000', assignmentFee: '0' },
        want: { purchase_price: 380000, underlying_contract_price: 380000, assignment_fee: 0, is_assignment: true } },
      { n: 'blanks — still NULL',
        b: { loanType: 'Purchase', purchasePrice: '', asIsValue: '', arv: '', rehabBudget: '' },
        want: { purchase_price: null, as_is_value: null, arv: null, rehab_budget: null } },
      { n: 'an ABSENT (JSON number 0) value — still NULL',
        b: { loanType: 'Purchase', purchasePrice: 350000, asIsValue: 0, arv: 0, rehabBudget: 0 },
        want: { purchase_price: 350000, as_is_value: null, arv: null, rehab_budget: null } },
      /* UPDATED 2026-08-02 (owner-directed): a refinance stores NO purchase price
         at all. It is sized on the AS-IS VALUE — the frozen engine's own
         denominator — and what the borrower paid when they BOUGHT the property is
         `original_purchase_price`, a different field. This case previously
         asserted `purchase_price: 412500`, which is exactly the purchase-style
         economics the owner reported on a cash-out file. The as-is value is still
         parsed from its comma-formatted form, which is what this battery is
         really about; the assignment is still forced off. */
      { n: 'a refinance — assignment forced off AND no purchase price is stored',
        b: { loanType: 'Refinance', isAssignment: true, purchasePrice: '412,500',
          underlyingContractPrice: '380,000', assignmentFee: '32,500', asIsValue: '445,000' },
        want: { is_assignment: false, underlying_contract_price: null, assignment_fee: null,
          purchase_price: null, as_is_value: 445000 } },
    ];
    const COLS = `purchase_price,as_is_value,arv,rehab_budget,is_assignment,underlying_contract_price,assignment_fee`;
    const readBack = async (id, door, name, want) => {
      const r = (await db.query(`SELECT ${COLS} FROM applications WHERE id=$1`, [id])).rows[0];
      if (!r) { assert(false, `${door} | ${name} :: no row was created`); return; }
      const wrong = Object.entries(want).filter(([k, v]) => {
        const got = r[k];
        if (v === null) return got !== null;
        if (typeof v === 'boolean') return got !== v;
        return got === null || Number(got) !== v;
      });
      assert(wrong.length === 0,
        `${door} | ${name}${wrong.length ? ' — ' + wrong.map(([k, v]) => `${k}: want ${JSON.stringify(v)}, stored ${JSON.stringify(r[k])}`).join('; ') : ''}`);
    };
    for (const c of DOOR_CASES) {
      // door 1 — borrower direct create
      let r = await call('POST', '/api/borrower/applications', bTok, { ...c.b, propertyAddress: ADDR });
      if (r.status !== 201) assert(false, `POST /api/borrower/applications | ${c.n} :: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
      else await readBack(r.body.applicationId, 'POST /api/borrower/applications', c.n, c.want);
      // door 2 — the legacy-draft door: written as a draft, then submitted
      const dr = await call('POST', '/api/borrower/drafts', bTok, { data: { ...c.b, propertyAddress: ADDR }, step: 5 });
      r = await call('POST', `/api/borrower/drafts/${dr.body && dr.body.id}/submit`, bTok, {});
      if (r.status !== 201) assert(false, `POST /api/borrower/drafts/:id/submit | ${c.n} :: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
      else await readBack(r.body.applicationId, 'POST /api/borrower/drafts/:id/submit', c.n, c.want);
      // door 3 — staff new file
      r = await call('POST', '/api/staff/applications', sTok,
        { ...c.b, borrower: { email: bEmail, firstName: 'Draft', lastName: 'Submit' }, propertyAddress: ADDR });
      if (r.status !== 201) assert(false, `POST /api/staff/applications | ${c.n} :: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
      else await readBack(r.body.applicationId, 'POST /api/staff/applications', c.n, c.want);
    }
  } finally {
    if (server) { try { server.close(); } catch (_) { /* best-effort */ } }
    if (borrowerId) {
      await db.query(`DELETE FROM application_drafts WHERE borrower_id=$1`, [borrowerId]).catch(() => {});
      await db.query(`DELETE FROM applications WHERE borrower_id=$1`, [borrowerId]).catch(() => {});
      await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]).catch(() => {});
    }
    if (staffId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [staffId]).catch(() => {});
    if (db.pool && db.pool.end) await db.pool.end().catch(() => {});
  }
  console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL studio draft-submit assertions passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
