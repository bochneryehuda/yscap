/**
 * THE SCREEN, THE REGISTRATION AND THE FINAL TERM SHEET MUST AGREE — EXACTLY.
 * Real Postgres + real HTTP. Skips cleanly with no DATABASE_URL.
 *
 * Owner-directed 2026-08-07, after a live divergence:
 *
 *   "Whatever you see on the screen, according to the eligibility, that should be
 *    exactly what's getting registered, and that should be exactly what's going on
 *    on the final term sheet. This can cause us to not be able to sell files.
 *    There never should have been a mistake like this again."
 *
 * THE CLASS THIS EXISTS TO KILL. A price is produced at EIGHT places, each of which
 * assembles the engine's overrides itself. The moment one layers on something the
 * others do not, the screen, the registration and the printed sheet stop agreeing —
 * and nothing errors, because each one is individually "working". That is precisely
 * how a staff-set loan ceiling came to be applied on the borrower REGISTER route
 * alone, so the borrower's studio quoted $652,200 at 9.250% while registering
 * produced $489,150 at 8.500%.
 *
 * A unit test of the chokepoint would NOT have caught it — the chokepoint was
 * correct; the bug was a door that never called it. So this test does the only
 * thing that can catch that: it drives the REAL doors over HTTP against ONE file and
 * asserts the numbers match. A new door that forgets the chokepoint fails here.
 *
 * WHAT "MATCH" MEANS. Loan amount and note rate, to the cent and to the basis point,
 * for the program actually being registered. Not "close" — exactly.
 */
'use strict';

const assert = require('assert');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

if (!process.env.DATABASE_URL) {
  console.log('SKIP test-quote-register-parity-db: no DATABASE_URL');
  process.exit(0);
}
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-parity';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';

const db = require('../src/db');
const app = require('../src/server');
const C = require('../src/lib/crypto');

const money = (x) => Math.round(Number(x) || 0);
// The sized loan lives on `sizing.totalLoan` — the SAME field persistProductRegistration
// records as the registered total, so screen and file are compared on one figure.
const loanOf = (q) => money(((q || {}).sizing || {}).totalLoan);
const rate = (x) => Number(x) || 0;

function listen() {
  return new Promise((res) => { const s = app.listen(0, () => res(s)); });
}
async function req(server, method, path, token, body) {
  const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' },
      token ? { authorization: `Bearer ${token}` } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
}

(async () => {
  const server = await listen();
  const stamp = Date.now();
  let borrowerId, appId, staffId;
  try {
    // ---- a real file, a real borrower with a real score --------------------------
    const b = await db.query(
      `INSERT INTO borrowers (first_name,last_name,email,fico)
       VALUES ('Parity','Case',$1,760) RETURNING id`, [`parity-${stamp}@t.local`]);
    borrowerId = b.rows[0].id;
    const a = await db.query(
      `INSERT INTO applications
        (borrower_id,loan_type,program,property_type,units,property_address,
         purchase_price,as_is_value,arv,rehab_budget,rehab_type,term,
         requested_ir_months,requested_exp_flips,requested_exp_holds,requested_exp_ground,status)
       VALUES ($1,'Purchase','Fix & Flip w/ Construction','SFR (1 unit)',1,
         '{"line1":"9 Parity Way","city":"Newark","state":"NJ","zip":"07102"}'::jsonb,
         558000,558000,900000,150000,'Light Rehab','12 Months',0,6,6,6,'file_intake')
       RETURNING id`, [borrowerId]);
    appId = a.rows[0].id;

    const s = await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Parity Admin','super_admin',true,false,'x',0) RETURNING id`,
      [`parity-staff-${stamp}@t.local`]);
    staffId = s.rows[0].id;
    const staffTok = C.signJwt({ sub: staffId, kind: 'staff', role: 'super_admin', tv: 0 });

    await db.query(
      `INSERT INTO borrower_auth (borrower_id,password_hash,token_version)
       VALUES ($1,'x',0) ON CONFLICT DO NOTHING`, [borrowerId]);
    const borrowerTok = C.signJwt({ sub: borrowerId, kind: 'borrower', tv: 0 });

    // ---- 1. NO ceiling: every surface must already agree -------------------------
    const PROG = 'silver';
    const q0 = await req(server, 'POST', `/api/staff/applications/${appId}/pricing/quote`, staffTok, { overrides: {} });
    ok(q0.status === 200, `A0 staff what-if quote responds (${q0.status})`);
    const baseLoan = loanOf((q0.body || {})[PROG]);
    const baseRate = rate(((q0.body || {})[PROG] || {}).noteRate);
    ok(baseLoan > 0, `A1 the control deal prices ($${baseLoan.toLocaleString()} @ ${(baseRate * 100).toFixed(3)}%)`);

    // ---- 2. Staff registers a CEILING well below the maximum ---------------------
    const CEIL = Math.round(baseLoan * 0.75);
    const reg = await req(server, 'POST', `/api/staff/applications/${appId}/pricing/register`, staffTok,
      { program: PROG, overrides: { targetLoan: CEIL } });
    ok(reg.status === 200 || reg.status === 201, `B0 staff registers a $${CEIL.toLocaleString()} ceiling (${reg.status})`);

    const cur = await db.query(
      `SELECT total_loan, note_rate FROM product_registrations
        WHERE application_id=$1 AND is_current LIMIT 1`, [appId]);
    const regLoan = money(cur.rows[0] && cur.rows[0].total_loan);
    const regRate = rate(cur.rows[0] && cur.rows[0].note_rate);
    ok(regLoan > 0 && regLoan <= CEIL + 1 && regLoan < baseLoan,
      `B1 the registration honours the ceiling ($${regLoan.toLocaleString()} @ ${(regRate * 100).toFixed(3)}%)`);

    // ---- 3. THE HEART: every borrower-facing surface must show THAT number -------
    const bPanel = await req(server, 'GET', `/api/borrower/applications/${appId}/pricing`, borrowerTok);
    ok(bPanel.status === 200, `C0 borrower panel responds (${bPanel.status})`);
    const panelQ = ((bPanel.body || {}).quote || {})[PROG] || {};
    ok(loanOf(panelQ) === regLoan,
      `C1 THE BORROWER'S SCREEN shows the registered loan — $${loanOf(panelQ).toLocaleString()} vs $${regLoan.toLocaleString()}`);
    ok(Math.abs(rate(panelQ.noteRate) - regRate) < 1e-9,
      `C2 …and the registered RATE — ${(rate(panelQ.noteRate) * 100).toFixed(3)}% vs ${(regRate * 100).toFixed(3)}%`);

    const bQuote = await req(server, 'POST', `/api/borrower/applications/${appId}/pricing/quote`, borrowerTok, { overrides: {} });
    ok(bQuote.status === 200, `D0 borrower what-if responds (${bQuote.status})`);
    const wq = (bQuote.body || {})[PROG] || {};
    ok(loanOf(wq) === regLoan,
      `D1 the borrower's what-if quotes the registered loan — $${loanOf(wq).toLocaleString()} vs $${regLoan.toLocaleString()}`);
    ok(Math.abs(rate(wq.noteRate) - regRate) < 1e-9, 'D2 …and the registered rate');

    // ---- 4. And re-registering from the borrower lands on the SAME number --------
    const bReg = await req(server, 'POST', `/api/borrower/applications/${appId}/pricing/register`, borrowerTok, { program: PROG });
    ok(bReg.status === 200 || bReg.status === 201, `E0 borrower re-register responds (${bReg.status})`);
    const cur2 = await db.query(
      `SELECT total_loan, note_rate FROM product_registrations
        WHERE application_id=$1 AND is_current LIMIT 1`, [appId]);
    ok(money(cur2.rows[0].total_loan) === regLoan,
      `E1 a borrower re-register produces the SAME loan, not the maximum ($${money(cur2.rows[0].total_loan).toLocaleString()})`);
    ok(Math.abs(rate(cur2.rows[0].note_rate) - regRate) < 1e-9, 'E2 …and the same rate');

    // ---- 4b. A LADDER RUNG MUST SURVIVE A RE-REGISTER ---------------------------
    // This is the costliest instance of the class. The rung lives only in the
    // studio's module scope, which resets on every iframe load, and esign/gate.js
    // REQUIRES a re-register after the appraisal before a term sheet may issue — so
    // the mandatory workflow step was registering the MAXIMUM. Measured on a real
    // deal: a signed $1,794,000 at 8.500% came back as $2,070,000 at 9.125%.
    // The portal now hands the rung back and the register must reproduce it.
    {
      const st = require('../src/lib/pricing-sticky');
      const carried = await st.fileStickyOverrides(appId, db);
      ok(Number(carried.targetLoan) === CEIL,
        `H1 the file carries its registered ceiling for EVERY door ($${Number(carried.targetLoan || 0).toLocaleString()})`);

      // Register on a real value-side ladder rung, then re-register carrying it.
      const SVP = require('../web/v2/tools/silver-program.js');
      const pricing = require('../src/lib/pricing');
      const inp = pricing.buildInputs(
        (await db.query('SELECT a.*, b.fico FROM applications a JOIN borrowers b ON b.id=a.borrower_id WHERE a.id=$1', [appId])).rows[0],
        { flips: 6, holds: 6, ground: 6 }, {});
      const lad = SVP.priceLadder(inp);
      const rung = (lad.rows || []).find((r) => r.cut === 'arv') || (lad.rows || []).find((r) => r.cut);
      if (rung) {
        const lever = rung.cut === 'arv' ? { targetARLTV: Number(rung.key.split(':')[1]) }
                                         : { targetLTC: Number(rung.key.split(':')[1]) };
        const r1 = await req(server, 'POST', `/api/staff/applications/${appId}/pricing/register`, staffTok,
          { program: PROG, overrides: lever });
        ok(r1.status === 200 || r1.status === 201, `H2 staff registers on the ${rung.cut} rung (${r1.status})`);
        const c1 = await db.query(
          `SELECT total_loan, note_rate, inputs FROM product_registrations
            WHERE application_id=$1 AND is_current LIMIT 1`, [appId]);
        const rungLoan = money(c1.rows[0].total_loan);
        ok(Math.abs(rungLoan - money(rung.totalLoan)) <= 1,
          `H3 …at the rung's own loan ($${rungLoan.toLocaleString()})`);
        // THE CARRY-BACK: the stored inputs must still name the rung, so the studio
        // can hand it back and a re-register reproduces it rather than the maximum.
        const savedLever = Number((c1.rows[0].inputs || {}).targetARLTV) || Number((c1.rows[0].inputs || {}).targetLTC);
        ok(savedLever > 0,
          `H4 the registration RECORDS which rung it was priced on (${savedLever || 'NOTHING — a reopen cannot restore it'})`);
        const carried2 = await st.fileStickyOverrides(appId, db);
        ok(Number(carried2.targetARLTV || carried2.targetLTC) === savedLever,
          'H5 …and every door carries that rung forward, so a re-register cannot jump to the maximum');
      } else {
        ok(false, 'H2 the fixture produced no ladder rung to test');
      }
    }

    // ---- 5. The FINAL term sheet renders the registration, not a re-quote --------
    // It is built server-side from product_registrations.quote, so it cannot
    // disagree with the registration — assert that sourcing explicitly, because a
    // future refactor that re-quotes here would silently reopen the whole class.
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src/lib/esign/term-sheet-pdf.js'), 'utf8');
    ok(!/quoteAll\(|quoteProgram\(|buildInputs\(/.test(src),
      'F1 the FINAL term sheet never re-prices — it renders the stored registration');

    // ---- 6. Every pricing surface goes through the ONE chokepoint ----------------
    const brw = require('fs').readFileSync(require('path').join(__dirname, '..', 'src/routes/borrower.js'), 'utf8');
    const calls = (brw.match(/quoteAll\(|buildInputs\(/g) || []).length;
    const sticky = (brw.match(/stickyOverrides\.effectiveOverrides\(/g) || []).length;
    ok(sticky >= 3 && sticky >= calls,
      `G1 every borrower pricing surface layers the file's carried values (${sticky} chokepoint calls for ${calls} pricing calls)`);

    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  } finally {
    try { if (appId) await db.query('DELETE FROM applications WHERE id=$1', [appId]); } catch (_) {}
    try { if (borrowerId) await db.query('DELETE FROM borrower_auth WHERE borrower_id=$1', [borrowerId]); } catch (_) {}
    try { if (borrowerId) await db.query('DELETE FROM borrowers WHERE id=$1', [borrowerId]); } catch (_) {}
    try { if (staffId) await db.query('DELETE FROM staff_users WHERE id=$1', [staffId]); } catch (_) {}
    try { server.close(); } catch (_) {}
    try { await db.pool.end(); } catch (_) {}
  }
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error('FATAL', e && e.stack || e);
  try { await db.pool.end(); } catch (_) {}
  process.exit(1);
});
