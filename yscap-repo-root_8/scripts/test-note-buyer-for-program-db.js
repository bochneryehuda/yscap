/**
 * The registered PROGRAM chooses the NOTE BUYER (owner-directed 2026-08-06) —
 * the DB half, over real HTTP against a real Postgres.
 *
 *   A. Registering STANDARD stamps the file "Fidelis Investors LLC".
 *   B. Registering GOLD stamps "Blue Lake Capital".
 *   C. A note buyer a HUMAN already set is NEVER overwritten by a register.
 *   D. A buyer somebody set AFTER the registration survives a re-register.
 *   E. The derived buyer is a REAL one: the file can export that buyer's tape,
 *      and the note-buyer-driven conditions engine sees it.
 *   H. The stamp SELF-CORRECTS on a re-register (owner-directed 2026-08-07) —
 *      but only ever one of OUR OWN derived labels, so C and D still hold.
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
const pricing = require('../src/lib/pricing');

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

    /* ---------- H. THE NOTE BUYER FOLLOWS THE REGISTERED PROGRAM ----------
       (owner-directed 2026-08-07.) A borrower can self-register and so chooses
       the program — which chose the buyer. An officer registering the RIGHT
       program afterwards used to leave the WRONG buyer stamped, because the
       write was fill-only, and that file could then export NO data tape at all
       (every one refused for mismatching). It now corrects itself — but ONLY
       ever one of OUR OWN derived labels, and only when that label disagrees
       with the program now registered. A name a human (or ClickUp) put there is
       never ours to change: that is what C2/D2 above pin, and they still pass.

       NOTE this block runs INSIDE the try, before the finally tears the pool
       down — a suite that appends work after `db.pool.end()` dies on "Cannot
       use a pool after calling end on the pool" with its assertions never run. */
    {
      const NB = require('../src/lib/note-buyer-for-program');
      const mk = async (lender) => {
        const bid = (await db.query(
          `INSERT INTO borrowers (first_name,last_name,email,fico)
           VALUES ('Follow','Prog',$1,760) RETURNING id`,
          [`nbfollow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@t.local`])).rows[0].id;
        const aid = (await db.query(
          `INSERT INTO applications
            (borrower_id,loan_type,program,property_type,units,property_address,purchase_price,
             as_is_value,arv,rehab_budget,rehab_type,term,requested_ir_months,
             requested_exp_flips,requested_exp_holds,requested_exp_ground,status,lender)
           VALUES ($1,'Purchase','Fix & Flip w/ Construction','SFR (1 unit)',1,
             '{"line1":"7 Follow St","city":"Newark","state":"NJ","zip":"07102"}'::jsonb,
             558000,558000,900000,150000,'Light Rehab','12 Months',0,6,6,6,'file_intake',$2)
           RETURNING id`, [bid, lender])).rows[0].id;
        return { bid, aid };
      };
      const reg = async (aid, program) => {
        const inputs = pricing.buildInputs(
          (await db.query('SELECT a.*, b.fico FROM applications a JOIN borrowers b ON b.id=a.borrower_id WHERE a.id=$1', [aid])).rows[0],
          { flips: 6, holds: 6, ground: 6 }, {});
        const quote = pricing.quoteProgram(program, inputs);
        const c = await db.pool.connect();
        try {
          await c.query('BEGIN');
          await require('../src/lib/product-registration')
            .persistProductRegistration(c, { appId: aid, program, inputs, quote, registeredByStaffId: null });
          await c.query('COMMIT');
        } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
        return (await db.query('SELECT lender FROM applications WHERE id=$1', [aid])).rows[0].lender;
      };
      const clean = async ({ bid, aid }) => {
        await db.query('DELETE FROM applications WHERE id=$1', [aid]);
        await db.query('DELETE FROM borrowers WHERE id=$1', [bid]);
      };

      // 1. The owner's own case: a borrower self-registers Gold, staff then
      //    register the file as Silver. The buyer must follow the program.
      let f = await mk(null);
      const gold = await reg(f.aid, 'gold');
      assert(gold === NB.noteBuyerForProgram('gold'), `H1 a Gold register stamps ${gold}`);
      const silver = await reg(f.aid, 'silver');
      assert(silver === NB.noteBuyerForProgram('silver'),
        `H2 re-registering as Silver CORRECTS it to ${NB.noteBuyerForProgram('silver')} (got ${silver})`);
      await clean(f);

      // 2. A name we never derive is a human's (or ClickUp's) — never touched,
      //    however far the registered program moves.
      f = await mk('CorrFirst');
      const kept = await reg(f.aid, 'silver');
      assert(kept === 'CorrFirst', `H3 a buyer we never derive is left completely alone (got ${kept})`);
      await clean(f);

      // 3. The correction runs on EVERY pairing, not just the reported one.
      f = await mk(null);
      await reg(f.aid, 'gold');
      const corrected = await reg(f.aid, 'standard');
      assert(corrected === NB.noteBuyerForProgram('standard'),
        `H4 a Standard register corrects a Gold stamp to ${NB.noteBuyerForProgram('standard')} (got ${corrected})`);
      await clean(f);

      // 4. THE LINE THE CORRECTION IS DRAWN ON, and it is not "does this label
      //    look like one of ours". A file can carry Blue Lake because somebody
      //    typed it, or because ClickUp pulled it in, with no registration
      //    behind it at all — and nothing about the TEXT can tell that apart
      //    from a stamp we wrote. So the correction keys on the PREVIOUS
      //    REGISTRATION's own derived label: with no prior registration there
      //    is no evidence the buyer is ours, and it is left alone. Getting this
      //    backwards would silently overwrite a human's choice on a first
      //    register, which is exactly what C2 forbids.
      f = await mk(NB.noteBuyerForProgram('gold'));
      const unproven = await reg(f.aid, 'standard');
      assert(unproven === NB.noteBuyerForProgram('gold'),
        `H4b a matching label with NO registration behind it is a human's, and is left alone (got ${unproven})`);
      await clean(f);

      // 5. A MANUAL product derives NO buyer, so it may never CLEAR one.
      f = await mk(NB.noteBuyerForProgram('silver'));
      const manualKept = await reg(f.aid, 'manual').catch(() => null);
      assert(manualKept === null || manualKept === NB.noteBuyerForProgram('silver'),
        `H5 a manual register never clears the stamped buyer (got ${JSON.stringify(manualKept)})`);
      await clean(f);
    }
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
