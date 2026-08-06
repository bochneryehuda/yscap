/**
 * The registered PROGRAM chooses the NOTE BUYER (owner-directed 2026-08-06) —
 * the DB half, over real HTTP against a real Postgres.
 *
 *   A. Registering STANDARD stamps the file "Fidelis Investors LLC".
 *   B. Registering GOLD stamps "Blue Lake Capital".
 *   C. A note buyer a HUMAN already set is NEVER overwritten by a register.
 *   D. The stamp is FILL-ONLY across a re-register too (register standard, then
 *      re-register — the buyer stays whatever the file holds).
 *   E. The derived buyer is a REAL one: the file can export that buyer's tape,
 *      and the note-buyer-driven conditions engine sees it.
 *
 * Manual is covered in the pure suite (it derives nothing, so there is no write
 * to observe here); registering a manual product needs an escalation + asset
 * months and is exercised by the manual-program suites.
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-note-buyer-for-program-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const app = require('../src/server');
const { normNoteBuyer } = require('../src/lib/conditions/field-registry');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

// Comfortably eligible on both Standard and Gold so the register succeeds and the
// test is about the note buyer, not about pricing.
const SCENARIO = {
  loanType: 'Purchase', strategy: 'Fix & Flip', state: 'NJ', propertyType: 'SFR (1 unit)',
  purchasePrice: 400000, asIsValue: 400000, arv: 600000, rehabBudget: 80000,
  fico: 760, term: 12, expFlips: 5, expHolds: 0, expGround: 0,
};

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let staffId = null, borrowerId = null;
  try {
    staffId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Owner','super_admin',true,false,'x',0) RETURNING id`,
      [`nbprog-${sfx}@test.local`])).rows[0].id;
    const tok = C.signJwt({ sub: staffId, kind: 'staff', role: 'super_admin', tv: 0 });
    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Note','Buyer',$1) RETURNING id`,
      [`nbprog-bo-${sfx}@test.local`])).rows[0].id;

    const mkApp = async (lender = null) => {
      const id = (await db.query(
        `INSERT INTO applications (borrower_id, loan_officer_id, status, loan_type, program, property_type,
                                   purchase_price, as_is_value, arv, rehab_budget, rehab_type, term,
                                   requested_exp_flips, lender, property_address)
         VALUES ($1,$2,'underwriting','Purchase','standard','SFR (1 unit)',400000,400000,600000,80000,'Cosmetic','12 Months',5,$3,
                 '{"line1":"1 Buyer St","city":"Newark","state":"NJ","zip":"07102"}'::jsonb)
         RETURNING id`, [borrowerId, staffId, lender])).rows[0].id;
      await require('../src/lib/conditions/ensure').ensureFileConditions(id, { reason: 'test' });
      return id;
    };
    const lenderOf = async (id) => (await db.query(`SELECT lender FROM applications WHERE id=$1`, [id])).rows[0].lender;
    const reg = (id) => `/api/staff/applications/${id}/pricing/register`;

    // ---------- A. Standard → Fidelis ----------
    const appA = await mkApp();
    assert((await lenderOf(appA)) == null, 'A0 the file starts with no note buyer');
    const rA = await call(server, 'POST', reg(appA), tok, { program: 'standard', overrides: SCENARIO });
    assert(rA.status === 201, `A1 the Standard registration is accepted (got ${rA.status} ${JSON.stringify((rA.body || {}).error || '')})`);
    assert((await lenderOf(appA)) === 'Fidelis Investors LLC',
      `A2 registering STANDARD stamps the file Fidelis (got ${JSON.stringify(await lenderOf(appA))})`);

    // ---------- B. Gold → Blue Lake ----------
    const appB = await mkApp();
    const rB = await call(server, 'POST', reg(appB), tok, { program: 'gold', overrides: SCENARIO });
    assert(rB.status === 201, `B1 the Gold registration is accepted (got ${rB.status} ${JSON.stringify((rB.body || {}).error || '')})`);
    assert((await lenderOf(appB)) === 'Blue Lake Capital',
      `B2 registering GOLD stamps the file Blue Lake (got ${JSON.stringify(await lenderOf(appB))})`);

    // ---------- C. A human's choice is never overwritten ----------
    const appC = await mkApp('CorrFirst');
    const rC = await call(server, 'POST', reg(appC), tok, { program: 'standard', overrides: SCENARIO });
    assert(rC.status === 201, `C1 registering a file that already names a buyer is accepted (got ${rC.status})`);
    assert((await lenderOf(appC)) === 'CorrFirst',
      `C2 a note buyer somebody already set is NEVER overwritten by a register (got ${JSON.stringify(await lenderOf(appC))})`);

    // ---------- D. Fill-only across a RE-register ----------
    await db.query(`UPDATE applications SET lender='EMCAP Financial' WHERE id=$1`, [appA]);
    const rD = await call(server, 'POST', reg(appA), tok, { program: 'standard', overrides: { ...SCENARIO, arv: 610000 } });
    assert(rD.status === 201, `D1 the re-register is accepted (got ${rD.status})`);
    assert((await lenderOf(appA)) === 'EMCAP Financial',
      `D2 a re-register never re-stamps the buyer over a later human change (got ${JSON.stringify(await lenderOf(appA))})`);

    // ---------- E. The derived buyer is a REAL one ----------
    // The gate's own closed-list matcher, fed the label the register actually
    // wrote onto the file — this is the assertion that matters: a derived buyer
    // that could not export its own tape would be worse than no buyer at all.
    const tapes = require('../src/lib/tapes');
    const blueLake = require('../src/lib/tapes/registry').TAPES.find((t) => t.buyerKey === 'bluelake');
    const stamped = await lenderOf(appB);
    assert(tapes.buyerMatches({ noteBuyerRaw: stamped }, blueLake) === true,
      `E1 the derived label passes the tape gate's closed-list matcher (got ${JSON.stringify(stamped)})`);
    const fidelis = require('../src/lib/tapes/registry').TAPES.find((t) => t.buyerKey === 'fidelis');
    assert(tapes.buyerMatches({ noteBuyerRaw: stamped }, fidelis) === false,
      'E1b …and does NOT match another buyer\'s tape');
    const loaded = await require('../src/lib/conditions/engine').loadRuleContext(appB).catch(() => null);
    const ctx = loaded && loaded.ctx;
    assert(ctx && ctx.note_buyer === normNoteBuyer('Blue Lake Capital'),
      `E2 the conditions engine reads the derived buyer (got ${JSON.stringify(ctx && ctx.note_buyer)})`);
    // THE STANDARD THIS IS HELD TO: the derived stamp must behave EXACTLY like
    // the owner's own real label, not merely "like something". normNoteBuyer is
    // deliberately EXACT, so "Blue Lake Capital" keys as 'bluelakecapital' and
    // NOT the bare 'bluelake' — which is true of a human-typed production label
    // too (see the buyerAliases note in tapes/bluelake.js). Pinning it here means
    // a future "helpful" loosening of the stamp to the bare key, which would make
    // derived files behave unlike real ones, fails loudly.
    const appHuman = await mkApp('Blue Lake Capital');
    const humanCtx = (await require('../src/lib/conditions/engine').loadRuleContext(appHuman)).ctx;
    assert(humanCtx.note_buyer === ctx.note_buyer,
      `E3 a DERIVED buyer keys identically to the same label typed by a human (${ctx.note_buyer} vs ${humanCtx.note_buyer})`);
    assert(humanCtx.note_buyer_is_fidelis === ctx.note_buyer_is_fidelis
        && humanCtx.note_buyer_is_emcap === ctx.note_buyer_is_emcap,
      'E4 …and its buyer booleans agree too, so every note-buyer rule sees the same file');
  } catch (e) {
    console.error('FAIL unexpected error:', (e && e.stack) || e);
    failures++;
  } finally {
    if (borrowerId) {
      await db.query(`DELETE FROM applications WHERE borrower_id=$1`, [borrowerId]).catch(() => {});
      await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]).catch(() => {});
    }
    if (staffId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [staffId]).catch(() => {});
    server.close();
    await db.pool.end().catch(() => {});
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
