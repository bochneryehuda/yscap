'use strict';
/*
 * A REFINANCE HAS NO PURCHASE FIELDS TO MATCH — proven against a REAL Postgres,
 * through computeFindings' own live SELECT.
 *
 * The pure suite proves the RULE. It cannot prove the WIRING: whether the live
 * query actually reads `loan_type`, whether the marker really runs over the
 * assembled field set, and whether the gate the term-sheet send and the tape
 * export consult (isClear → summary.openBlockingKeys) genuinely stops naming the
 * four purchase rows. A phantom column here sits inside a route's catch and reads
 * as "nothing to report" forever — exactly how two phantom columns slipped past
 * this module's pure test the first time (a.deal_type, l.name).
 *
 * THE CENTRAL PROOF is one file, priced identically, compared TWICE: once as a
 * refinance and once as a purchase. Everything else about the row is held still,
 * so the ONLY thing that can move a verdict is the loan type.
 *
 * Requires DATABASE_URL with migrations applied; SKIPs cleanly otherwise. Runs in
 * a transaction and ROLLS BACK — leaves no rows behind.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-encompass-refinance-fields-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const recon = require('../src/encompass/reconcile');

let n = 0;
const ok = (m) => { n++; console.log('  ok  ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); ok(m); };
const yes = (v, m) => { assert.ok(v, m); ok(m); };

const FOUR = ['purchase_price', 'effective_purchase', 'contract_price', 'assignment_fee'];

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tag = Buffer.from(String(process.pid)).toString('hex');
    const b = (await client.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Refi','Sync',$1) RETURNING id`,
      [`refisync+${tag}@example.com`])).rows[0];

    /* The Encompass copy of a REFINANCE. It carries purchase-side numbers, which is
       the ordinary state of affairs — the property was bought at some point and the
       tenant's fields keep whatever was last put in them. Our side has none of it,
       deliberately, and that is the disagreement nobody can resolve. */
    const loan = {
      baseLoanAmount: '500000.0000',
      purchasePriceAmount: '420000.0000',
      loanNumber: 'YSCAP-REFI-' + tag,
      customFields: [
        { fieldName: 'CX.EFFECTIVEPURCHASE', value: '420000.0000' },
        { fieldName: 'CX.ORIGINALCONTRACTPURCHASEP', value: '415000.0000' },
        { fieldName: 'CX.ASSIGNMENTFEE', value: '5000.0000' },
      ],
    };

    /* db/399 CLEARED purchase_price on every refinance and the details door refuses
       to store one; db/630 forces is_assignment false. So this row is exactly what a
       real refinance looks like — not a fixture convenience. */
    const app = (await client.query(
      `INSERT INTO applications
         (borrower_id, ys_loan_number, loan_type, program, loan_amount,
          purchase_price, is_assignment, underlying_contract_price, assignment_fee,
          as_is_value, arv, encompass_extra, encompass_last_pulled_at)
       VALUES ($1,$2,'Refinance — Cash-Out','Bridge',500000,
               NULL, false, NULL, NULL,
               600000, 700000, $3::jsonb, now())
       RETURNING id`, [b.id, 'YSCAP-REFI-' + tag, JSON.stringify(loan)])).rows[0];

    // ── 1. THE LIVE QUERY RUNS, AND THE RULE FIRES THROUGH IT ────────────────
    const c = await recon.computeFindings(app.id, client);
    eq(c.found, true, '1a the application is found by the real SELECT');
    eq(c.hasLoan, true, '1b the pulled Encompass loan is read');
    ok('1c computeFindings runs the real applications+llcs+borrowers SELECT with no phantom-column throw');

    const byKey = c.fields.reduce((m, f) => (m[f.key] = f, m), {});
    for (const k of FOUR) {
      eq(byKey[k].status, 'not_applicable', `1d ${k} reads "doesn't apply" on a refinance`);
      yes(byKey[k].notApplicable === true, `1e ${k} carries the flag the screen renders`);
      yes(/refinance/i.test(byKey[k].naReason || ''), `1f ${k} carries a reason naming the refinance`);
    }
    /* THE FACT A PURE TEST CANNOT SEE: Encompass really is holding a value on each of
       these, so this is not "both sides are blank so nothing happened". */
    yes(byKey.purchase_price.theirs != null && String(byKey.purchase_price.theirs) !== '',
      '1g Encompass genuinely HOLDS a purchase price on this refinance — the row is silenced despite a value, not because of an absence');
    yes(byKey.assignment_fee.theirs != null, '1h and a stale assignment fee, which used to read as an honest mismatch');

    // ── 2. THE GATE THE TERM SHEET AND THE TAPE CONSULT ──────────────────────
    const gate = await recon.isClear(app.id, client);
    for (const k of FOUR) {
      yes(!gate.openBlockingKeys.includes(k), `2a ${k} no longer holds the DocuSign send / the tape export`);
    }
    ok('2b the four purchase rows are out of the blocking set on a refinance');

    // ── 3. THE SAME FILE AS A PURCHASE — the only thing that changed is the type
    await client.query(`UPDATE applications SET loan_type = 'Purchase' WHERE id = $1`, [app.id]);
    const p = await recon.computeFindings(app.id, client);
    const pByKey = p.fields.reduce((m, f) => (m[f.key] = f, m), {});
    for (const k of FOUR) {
      yes(pByKey[k].status !== 'not_applicable', `3a ${k} is compared again the moment the file is a purchase`);
      yes((p.summary.openBlockingKeys || []).includes(k), `3b ${k} holds the section on a purchase, exactly as it always has`);
    }
    /* The whole-roster check: nothing ELSE moved. A money assertion cannot see a rule
       that quietly silenced a different field, so compare every key's verdict. */
    const moved = Object.keys(byKey).filter((k) => byKey[k].status !== (pByKey[k] || {}).status).sort();
    assert.deepStrictEqual(moved, FOUR.slice().sort(),
      `3c the ONLY rows that differ between the refinance and the purchase are the owner's four (got ${moved.join(',') || 'none'})`);
    ok("3c switching the loan type moves exactly four verdicts and nothing else in the whole registry");
    await client.query(`UPDATE applications SET loan_type = 'Refinance — Cash-Out' WHERE id = $1`, [app.id]);

    // ── 4. THE A/B-PIECE SPLIT STILL HAS TO MATCH ON A REFINANCE ─────────────
    /* Owner-directed 2026-08-18: "whenever we set up a file for a B-piece structure in
       the manual section, these three fields also need to match." A refinance can carry
       a split just as a purchase can, so the new rule must not reach it. */
    const loanAb = JSON.parse(JSON.stringify(loan));
    loanAb._fieldValues = { 'CX.BPIECESTRUCTURE': 'x', 'CX.APIECE': '300000', 'CX.BPIECE': '200000' };
    await client.query(
      `UPDATE applications SET ab_piece_enabled = true, a_piece_amount = 250000, encompass_extra = $2::jsonb WHERE id = $1`,
      [app.id, JSON.stringify(loanAb)]);
    const ab = await recon.computeFindings(app.id, client);
    const abByKey = ab.fields.reduce((m, f) => (m[f.key] = f, m), {});
    yes(abByKey.ab_piece_a_amount, '4a the A-piece comparison is surfaced on a refinance');
    eq(abByKey.ab_piece_a_amount.status, 'mismatch', '4b PILOT $250,000 vs Encompass $300,000 is an honest mismatch');
    yes((ab.summary.openBlockingKeys || []).includes('ab_piece_a_amount'),
      '4c and it still HOLDS the section — the refinance rule does not reach the split');
    for (const k of FOUR) yes(abByKey[k].status === 'not_applicable', `4d ${k} is still not-applicable alongside it`);

    // ── 5. A NOT-APPLICABLE ROW IS NOT AN EXCEPTION WAITING TO HAPPEN ────────
    await client.query(
      `INSERT INTO encompass_sync_resolutions (application_id, field_key, resolution, ours_snapshot, theirs_snapshot, resolved_by)
       VALUES ($1,'purchase_price','excepted',$2,$3,NULL)`,
      [app.id, String(byKey.purchase_price.oursNorm ?? ''), String(byKey.purchase_price.theirsNorm ?? '')]);
    const withExc = await recon.computeFindings(app.id, client);
    const pp = withExc.fields.find((f) => f.key === 'purchase_price');
    eq(pp.status, 'not_applicable', '5a a stale granted exception does not change the verdict');
    yes(!pp.excepted, '5b and it is not shown as "Exception granted" — nobody had to ask for a field that never applied');

    // ── 6. THE PANEL IS NOT TOLD ENCOMPASS IS MISSING SOMETHING ──────────────
    const diag = await recon.rawDiagnostic(app.id, client);
    for (const k of FOUR) {
      yes(!(diag.missingFromEncompass || []).some((m) => m.key === k),
        `6a ${k} is not reported as "Encompass is missing this" — that advice is what started the report`);
    }

    // ── 7. THE OTHER SHAPE OF THE SAME FILE: Encompass holds nothing either ──
    /* Section 6 above only proves the case where Encompass HAS values — and a row
       with a value can never reach `missingFromEncompass` whatever its status, so
       that assertion alone could not tell a correct filter from a broken one
       (mutation-proven: widening the filter to admit not-applicable rows survived
       it). The common refinance is the other way round: neither side carries a
       purchase price, so the row IS blank on their side and the filter's status
       test is the only thing keeping it off the "Encompass is missing this" list. */
    const bareLoan = { baseLoanAmount: '500000.0000', loanNumber: 'YSCAP-REFI2-' + tag };
    const app2 = (await client.query(
      `INSERT INTO applications
         (borrower_id, ys_loan_number, loan_type, program, loan_amount,
          purchase_price, is_assignment, as_is_value, arv, encompass_extra, encompass_last_pulled_at)
       VALUES ($1,$2,'Refinance — Rate and Term','Bridge',500000,
               NULL, false, 600000, 700000, $3::jsonb, now())
       RETURNING id`, [b.id, 'YSCAP-REFI2-' + tag, JSON.stringify(bareLoan)])).rows[0];
    const d2 = await recon.rawDiagnostic(app2.id, client);
    const c2 = await recon.computeFindings(app2.id, client);
    const k2 = c2.fields.reduce((m, f) => (m[f.key] = f, m), {});
    for (const k of FOUR) {
      eq(k2[k].status, 'not_applicable', `7a ${k} is not-applicable on a rate-and-term refinance too`);
      yes(!(d2.missingFromEncompass || []).some((m) => m.key === k),
        `7c ${k} is kept off the "Encompass is missing this" list`);
      yes(!((c2.summary.openBlockingKeys) || []).includes(k), `7d ${k} does not hold the section`);
    }
    /* THE THREE that really are blank on the Encompass side — this is what makes 7c a
       real check rather than a tautology: a row carrying a value could never reach the
       "missing" list whatever its status, so only a blank row exercises the filter. */
    for (const k of ['purchase_price', 'effective_purchase', 'contract_price']) {
      yes(k2[k].theirsNorm === null || k2[k].theirsNorm === undefined || k2[k].theirsNorm === '',
        `7b ${k} genuinely has NOTHING on the Encompass side here`);
    }
    /* The assignment fee is the exception, and it is worth pinning: `zeroMeansNone`
       reads our deliberate 0 against Encompass's blank as 0-vs-0, so without this rule
       the row would sit there reading a confident green "Matches" about a question that
       has no meaning on a refinance. It is greyed instead. */
    eq(k2.assignment_fee.theirsNorm, 0, '7e zeroMeansNone turns Encompass\'s blank fee into a 0 against our deliberate 0');
    eq(k2.assignment_fee.status, 'not_applicable', '7f and it still reads "doesn\'t apply" rather than a meaningless green Matches');

    console.log(`\ntest-encompass-refinance-fields-db: all ${n} checks passed.`);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
