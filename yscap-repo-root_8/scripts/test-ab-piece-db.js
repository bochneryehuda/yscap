#!/usr/bin/env node
'use strict';
/* THE A-PIECE / B-PIECE SPLIT on a manual-program loan (owner-directed
 * 2026-08-18), against a real database + the real HTTP routes:
 *
 *   A. save + derive: the A-piece stores, the B-piece is DERIVED as
 *      total loan − A (from the CURRENT registration), a re-register moves the
 *      B-piece with no re-save, clearing works, and every refusal is a plain
 *      400 (negative / garbage / more than the loan itself).
 *   B. THE OWNER'S CORE RULE — saving the split NEVER trips the re-register
 *      machinery: on a file whose product_pricing condition is SIGNED OFF and
 *      whose registration is not stale, recording/editing the split leaves
 *      both untouched. A CONTROL then moves a real pricing input on the SAME
 *      file and proves the trigger genuinely bites this fixture (a guard
 *      nobody has seen fail is decoration).
 *   C. INTERNAL ONLY: the route exists on the staff router alone (borrower/TPO
 *      routers 404 it), an unrelated scoped officer 403s, the borrower
 *      overview-card payload never carries the split, and the audit row lands.
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

if (!process.env.DATABASE_URL) { console.log('SKIP test-ab-piece-db (no DATABASE_URL)'); process.exit(0); }
process.env.RESEND_API_KEY = '';

const http = require('http');
const crypto = require('crypto');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const app = require('../src/server');

function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }); } catch (_) { resolve({ status: res.statusCode, body: null }); } }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = crypto.randomBytes(4).toString('hex');
  let staffId, stranger, borId, appId, itemId;
  try {
    staffId = (await db.query(`INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version) VALUES ($1,'AB Officer','loan_officer',true,false,'x',0) RETURNING id`, [`ab-staff-${sfx}@test.local`])).rows[0].id;
    stranger = (await db.query(`INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version) VALUES ($1,'AB Stranger','loan_officer',true,false,'x',0) RETURNING id`, [`ab-str-${sfx}@test.local`])).rows[0].id;
    const tok = C.signJwt({ sub: staffId, kind: 'staff', role: 'loan_officer', tv: 0 });
    const tokS = C.signJwt({ sub: stranger, kind: 'staff', role: 'loan_officer', tv: 0 });
    borId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Abe','Splitson',$1) RETURNING id`, [`ab-bo-${sfx}@test.local`])).rows[0].id;
    await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,'x',0) ON CONFLICT DO NOTHING`, [borId]);
    appId = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status, ys_loan_number, property_address,
              loan_type, purchase_price, as_is_value, rehab_budget)
       VALUES ($1,$2,'underwriting','YSCAP-AB-1','{"oneLine":"2 Split St"}','Purchase',300000,310000,50000)
       RETURNING id`, [borId, staffId])).rows[0].id;
    await db.query(
      `INSERT INTO product_registrations (application_id, program, product_label, inputs, quote, is_current)
       VALUES ($1,'manual','Manual Program','{}'::jsonb,$2,true)`,
      [appId, JSON.stringify({ noteRate: 0.11, sizing: { totalLoan: 400000, initialAdvance: 350000, rehabHoldback: 50000 } })]);
    // A SIGNED-OFF Products & Pricing condition — the thing the split must never reopen.
    itemId = (await db.query(
      `INSERT INTO checklist_items (application_id, scope, label, status, audience, tool_key, signed_off_at, signed_off_by)
       VALUES ($1,'application','Products & pricing — register your product','satisfied','staff','product_pricing',now(),$2) RETURNING id`,
      [appId, staffId])).rows[0].id;

    // ---- A. save + derive -------------------------------------------------------------------
    const g0 = await call(server, 'GET', `/api/staff/applications/${appId}/ab-piece`, tok);
    ok('A1 the empty state reads: manual file, no split yet',
      g0.status === 200 && g0.body.manual === true && g0.body.enabled === false && g0.body.aPiece === null);
    const s1 = await call(server, 'POST', `/api/staff/applications/${appId}/ab-piece`, tok, { enabled: true, aPieceAmount: 250000 });
    ok('A2 saving the A-piece derives the B-piece as the REST of the loan',
      s1.status === 200 && s1.body.enabled === true && s1.body.aPiece === 250000
      && s1.body.bPiece === 150000 && s1.body.totalLoan === 400000);
    // A re-register (bigger loan) moves the B-piece with NO re-save — B is derived, never stored.
    await db.query(`UPDATE product_registrations SET quote = jsonb_set(quote,'{sizing,totalLoan}','450000') WHERE application_id=$1 AND is_current=true`, [appId]);
    const g1 = await call(server, 'GET', `/api/staff/applications/${appId}/ab-piece`, tok);
    ok('A3 a re-registered total moves the derived B-piece on its own',
      g1.status === 200 && g1.body.aPiece === 250000 && g1.body.bPiece === 200000);
    const bad1 = await call(server, 'POST', `/api/staff/applications/${appId}/ab-piece`, tok, { enabled: true, aPieceAmount: -5 });
    ok('A4 a negative A-piece refuses with a plain 400', bad1.status === 400);
    const bad2 = await call(server, 'POST', `/api/staff/applications/${appId}/ab-piece`, tok, { enabled: true, aPieceAmount: 'lots' });
    ok('A5 garbage refuses with a plain 400, never an opaque 500', bad2.status === 400);
    const bad3 = await call(server, 'POST', `/api/staff/applications/${appId}/ab-piece`, tok, { enabled: true, aPieceAmount: 999999999 });
    ok('A6 an A-piece bigger than the loan itself refuses and NAMES the loan',
      bad3.status === 400 && /450,000/.test(bad3.body.error || ''));
    const clr = await call(server, 'POST', `/api/staff/applications/${appId}/ab-piece`, tok, { enabled: false, aPieceAmount: null });
    ok('A7 the split clears cleanly', clr.status === 200 && clr.body.enabled === false && clr.body.aPiece === null && clr.body.bPiece === null);
    // Put it back for section B.
    await call(server, 'POST', `/api/staff/applications/${appId}/ab-piece`, tok, { enabled: true, aPieceAmount: 300000 });

    // ---- B. the owner's core rule: NO reopen, NO staleness ----------------------------------
    const cond1 = await db.query(`SELECT status, signed_off_at FROM checklist_items WHERE id=$1`, [itemId]);
    const reg1 = await db.query(`SELECT stale_reason FROM product_registrations WHERE application_id=$1 AND is_current=true`, [appId]);
    ok('B1 the signed-off Products & Pricing condition is UNTOUCHED by the split',
      cond1.rows[0].status === 'satisfied' && cond1.rows[0].signed_off_at != null);
    ok('B2 the registration is NOT flagged stale by the split', reg1.rows[0].stale_reason == null);
    // CONTROL: a REAL pricing input on the same file must trip the trigger —
    // proving the fixture is live and B1/B2 mean something.
    await db.query(`UPDATE applications SET purchase_price = 310000 WHERE id=$1`, [appId]);
    const cond2 = await db.query(`SELECT status, signed_off_at FROM checklist_items WHERE id=$1`, [itemId]);
    const reg2 = await db.query(`SELECT stale_reason FROM product_registrations WHERE application_id=$1 AND is_current=true`, [appId]);
    ok('B3 CONTROL: a real pricing change on the same file DOES reopen / flag stale',
      cond2.rows[0].signed_off_at == null || cond2.rows[0].status !== 'satisfied' || reg2.rows[0].stale_reason != null);

    // ---- C. internal only -------------------------------------------------------------------
    const str = await call(server, 'GET', `/api/staff/applications/${appId}/ab-piece`, tokS);
    ok('C1 an unrelated scoped officer is refused by the file scope', str.status === 403);
    const bTok = C.signJwt({ sub: borId, kind: 'borrower', tv: 0 });
    const bGet = await call(server, 'GET', `/api/borrower/applications/${appId}/ab-piece`, bTok);
    const bPost = await call(server, 'POST', `/api/borrower/applications/${appId}/ab-piece`, bTok, { enabled: false });
    ok('C2 no borrower door exists at all', bGet.status === 404 && bPost.status === 404);
    const bCard = await call(server, 'GET', `/api/borrower/applications/${appId}/overview-card`, bTok);
    ok('C3 the borrower overview payload never carries the split',
      bCard.status === 200 && !/a_?piece|ab_?piece|bPiece/i.test(JSON.stringify(bCard.body)));
    // The MAIN borrower application payload is SELECT a.* + a denylist, which
    // "fails open" on a new column — the audit reproduced exactly this leak
    // (ab_piece_enabled / a_piece_amount reaching the borrower) before the
    // denylist + _piece pattern entry landed. Pin the whole payload.
    const bApp = await call(server, 'GET', `/api/borrower/applications/${appId}`, bTok);
    ok('C3b the MAIN borrower application payload never carries the split either',
      bApp.status === 200 && !/a_?piece|ab_?piece/i.test(JSON.stringify(bApp.body)));
    const aud = await db.query(`SELECT 1 FROM audit_log WHERE action='ab_piece_set' AND entity_id=$1 LIMIT 1`, [appId]);
    ok('C4 every save writes its audit row', !!aud.rows[0]);

    // ---- D. the ENCOMPASS side (owner-supplied 2026-08-18: CX.BPIECESTRUCTURE /
    //      CX.APIECE / CX.BPIECE) — READ-ONLY + advisory, never a gate ------------------------
    const AB = require('../src/lib/ab-piece');
    const I = AB._internals;
    ok('D1 the checkbox rule: an "x" is checked, blank is not, garbage is UNREADABLE (never guessed)',
      I.parseEncChecked('x') === true && I.parseEncChecked(' X ') === true && I.parseEncChecked('Y') === true
      && I.parseEncChecked('') === false && I.parseEncChecked('No') === false
      && I.parseEncChecked('maybe') === null);
    ok('D2 money parses Encompass formats and refuses garbage',
      I.parseEncMoney('250000') === 250000 && I.parseEncMoney('$250,000.00') === 250000
      && I.parseEncMoney('') === null && I.parseEncMoney('lots') === null);
    ok('D3 a stored copy carrying NONE of the three fields reads as "not read", never "no split"',
      I.shapeEncompass({ 364: 'YSCAP-AB-1' }, { enabled: true, aPiece: 1, bPiece: 2 }) === null
      && I.shapeEncompass(null, null) === null);
    ok('D4 one side holding a number the other lacks is a DISAGREEMENT, not a skip',
      (() => { const s = I.shapeEncompass({ 'CX.APIECE': '' }, { enabled: true, aPiece: 250000, bPiece: null });
        return s && s.agrees.aPiece === false && s.relevant === true; })());

    // At this point the file's recorded split is enabled, A=300,000, total=450,000 → B=150,000.
    await db.query(
      `UPDATE applications SET encompass_extra = jsonb_build_object('_fieldValues',
         jsonb_build_object('CX.BPIECESTRUCTURE','X','CX.APIECE','300000','CX.BPIECE','150,000.00'))
       WHERE id=$1`, [appId]);
    const gE = await call(server, 'GET', `/api/staff/applications/${appId}/ab-piece`, tok);
    ok('D5 the staff GET carries the Encompass block and it AGREES with the recorded split',
      gE.status === 200 && gE.body.encompass && gE.body.encompass.structureChecked === true
      && gE.body.encompass.aPiece === 300000 && gE.body.encompass.bPiece === 150000
      && gE.body.encompass.overall === true && gE.body.encompass.relevant === true);
    await db.query(
      `UPDATE applications SET encompass_extra = jsonb_set(encompass_extra,'{_fieldValues,CX.APIECE}','"275000"')
       WHERE id=$1`, [appId]);
    const gE2 = await call(server, 'GET', `/api/staff/applications/${appId}/ab-piece`, tok);
    ok('D6 a differing Encompass amount reads as a MISMATCH (advisory — the GET still answers 200)',
      gE2.status === 200 && gE2.body.encompass && gE2.body.encompass.agrees.aPiece === false
      && gE2.body.encompass.overall === false);
    const sE = await call(server, 'POST', `/api/staff/applications/${appId}/ab-piece`, tok, { enabled: true, aPieceAmount: 300000 });
    ok('D7 the SAVE response carries the same advisory block (compared against the just-saved values)',
      sE.status === 200 && sE.body.encompass && sE.body.encompass.overall === false);
    await db.query(`UPDATE applications SET encompass_extra = NULL WHERE id=$1`, [appId]);
    const gE3 = await call(server, 'GET', `/api/staff/applications/${appId}/ab-piece`, tok);
    ok('D8 a file with no Encompass copy simply carries no block — the card renders as before',
      gE3.status === 200 && gE3.body.encompass == null && gE3.body.aPiece === 300000);
    // The borrower doors stay clean of the Encompass block too (C2/C3/C3b already
    // pin the split fields; the /bPiece/i regex also matches BPIECESTRUCTURE).
    await db.query(
      `UPDATE applications SET encompass_extra = jsonb_build_object('_fieldValues',
         jsonb_build_object('CX.BPIECESTRUCTURE','X')) WHERE id=$1`, [appId]);
    const bTok2 = C.signJwt({ sub: borId, kind: 'borrower', tv: 0 });
    const bApp2 = await call(server, 'GET', `/api/borrower/applications/${appId}`, bTok2);
    ok('D9 the borrower payload never carries the Encompass split fields',
      bApp2.status === 200 && !/bpiecestructure|cx\.apiece|cx\.bpiece|_fieldValues/i.test(JSON.stringify(bApp2.body)));

    // ---- E. the ENCOMPASS SYNC section carries the matching (owner-directed 2026-08-18:
    //      "it should be added to this section in the Encompass syncing. Encompass and
    //      PILOT need to match. PILOT can read Encompass, but it cannot write.") ----------
    const reconcile = require('../src/encompass/reconcile');
    const abRowsOf = (f) => (f.fields || []).filter((x) => /^ab_piece_/.test(x.key));
    // Recorded split right now: enabled, A=300,000, total=450,000 → derived B=150,000.
    await db.query(
      `UPDATE applications SET encompass_extra = jsonb_build_object('_fieldValues',
         jsonb_build_object('CX.BPIECESTRUCTURE','X','CX.APIECE','300000','CX.BPIECE','150000'),
         'loanNumber','YSCAP-AB-1') WHERE id=$1`, [appId]);
    const f1 = await reconcile.computeFindings(appId, db);
    const r1 = abRowsOf(f1);
    ok('E1 an agreeing split renders THREE MATCH rows in the compared section, all ADVISORY',
      r1.length === 3 && r1.every((x) => x.status === 'match' && x.gate === 'advisory' && x.writable === false));
    await db.query(
      `UPDATE applications SET encompass_extra = jsonb_set(encompass_extra,'{_fieldValues,CX.APIECE}','"275000"')
       WHERE id=$1`, [appId]);
    const f2 = await reconcile.computeFindings(appId, db);
    const aRow = abRowsOf(f2).find((x) => x.key === 'ab_piece_a_amount');
    ok('E2 a differing A-piece is a MISMATCH row (advisory counter) that names the fix-by-hand rule',
      !!aRow && aRow.status === 'mismatch' && aRow.gate === 'advisory'
      && /reads Encompass/.test(aRow.detail || '') && /cannot|by hand/i.test(aRow.detail || ''));
    // The BLOCKING is the intent, not an accident (owner-directed 2026-08-18:
    // "Encompass and PILOT need to match"): summarize()'s match-all gate counts
    // this mismatch, so the section is NOT clear and the term-sheet/tape gates
    // hold until the two systems agree or a super admin excepts the field.
    ok('E2b the mismatch HOLDS the section gate — summary.clear is false and the key is in the not-passing set',
      !!f2.summary && f2.summary.clear === false
      && Array.isArray(f2.summary.notPassingKeys) && f2.summary.notPassingKeys.includes('ab_piece_a_amount'));
    // No split ANYWHERE → total silence: the compared section gains no rows at all,
    // so 99% of files (no A/B structure) are untouched by this feature.
    await call(server, 'POST', `/api/staff/applications/${appId}/ab-piece`, tok, { enabled: false, aPieceAmount: null });
    await db.query(
      `UPDATE applications SET encompass_extra = jsonb_build_object('_fieldValues',
         jsonb_build_object('CX.BPIECESTRUCTURE','','CX.APIECE','','CX.BPIECE','')) WHERE id=$1`, [appId]);
    const f3 = await reconcile.computeFindings(appId, db);
    ok('E3 no split on either side → NO rows (silence, never noise on ordinary files)',
      abRowsOf(f3).length === 0);
    // Put the split back so nothing later is surprised.
    await call(server, 'POST', `/api/staff/applications/${appId}/ab-piece`, tok, { enabled: true, aPieceAmount: 300000 });
  } finally {
    try {
      if (appId) await db.query(`DELETE FROM applications WHERE id=$1`, [appId]);
      if (borId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borId]);
      await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [[staffId, stranger].filter(Boolean)]);
    } catch (_) { /* best-effort cleanup */ }
    server.close();
  }

  console.log(`test-ab-piece-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
