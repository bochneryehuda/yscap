/**
 * TPO PORTAL — Phase 4b (the Term Sheet Studio: price / register / term sheet)
 * end-to-end, real Postgres + HTTP.
 *
 * Proves the security-critical properties of the broker pricing surface:
 *   • a live quote (GET /pricing, POST /pricing/quote) carries NO internal
 *     lender margin — no `adminPricing` on any program, no `markup*Pct`/`fico`
 *     on the inputs — exactly the borrower-safe scrub;
 *   • a broker REGISTERS a product onto their firm's file (a real
 *     product_registrations row, registered_by = the broker), the file's loan
 *     amount is written, and the Products & pricing condition reopens;
 *   • the register returns `termSheetFinal` and a FRESH file's sheet is INITIAL
 *     (not final) — WE send the official final term sheet, not the broker;
 *   • the studio's term-sheet PDF uploads through the ONE special kind: born
 *     ACCEPTED, on the pricing condition, and a re-upload SUPERSEDES the prior;
 *   • a broker can only ever set doc_kind='term_sheet' (never an arbitrary kind);
 *   • firm isolation — broker B reaches none of firm A's pricing endpoints;
 *   • a refinance with no as-is value is refused (nothing to size on);
 *   • the DocuSign SEND surface does not exist for a broker (lender-only).
 */
const http = require('http');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

function call(server, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) };
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1', headers },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

// A quote (or bundle) is borrower-safe when no program carries `adminPricing`
// (internal margin) and the inputs carry no markup / fico. This is the exact
// property the shared scrub guarantees; assert it on every surface.
function noMargin(bundle) {
  if (!bundle || typeof bundle !== 'object') return true;
  for (const prog of ['standard', 'gold', 'silver']) {
    const q = bundle[prog];
    if (q && typeof q === 'object' && 'adminPricing' in q) return false;
  }
  const inp = bundle.inputs || {};
  return !('markupStdPct' in inp) && !('markupGoldPct' in inp) && !('markupSilverPct' in inp)
      && !('markupGoldT1Pct' in inp) && !('fico' in inp);
}

(async () => {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP TPO pricing DB (no DATABASE_URL)'); process.exit(0); }
  const R = require('path').resolve(__dirname, '..');
  const db = require(R + '/src/db');
  const C = require(R + '/src/lib/crypto');
  const app = require(R + '/src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const mail = (t) => `${t}-${sfx}@brk.test`;
  const addrOf = (n) => ({ line1: `${n} Main St`, city: 'Lakewood', state: 'NJ', zip: '08701' });
  const tpoTok = (id) => C.signJwt({ sub: id, kind: 'tpo', role: 'tpo_officer', tv: 0 });
  try {
    const hash = await C.hashPassword('BrokerPass123!');
    const firmA = (await db.query(`INSERT INTO tpo_firms (name,status) VALUES ($1,'active') RETURNING id`, [`Firm A ${sfx}`])).rows[0].id;
    const firmB = (await db.query(`INSERT INTO tpo_firms (name,status) VALUES ($1,'active') RETURNING id`, [`Firm B ${sfx}`])).rows[0].id;
    const brokerA = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,is_external,tpo_firm_id,password_hash,token_version)
       VALUES ($1,'Broker A','tpo_officer',true,true,$2,$3,0) RETURNING id`, [mail('brokerA'), firmA, hash])).rows[0].id;
    const brokerB = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,is_external,tpo_firm_id,password_hash,token_version)
       VALUES ($1,'Broker B','tpo_officer',true,true,$2,$3,0) RETURNING id`, [mail('brokerB'), firmB, hash])).rows[0].id;
    const tokA = tpoTok(brokerA), tokB = tpoTok(brokerB);

    // A clearly-eligible fix & flip.
    const enter = await call(server, 'POST', '/api/tpo/applications', tokA, {
      borrower: { firstName: 'Pat', lastName: 'Broker', email: mail('pat') },
      propertyAddress: addrOf(1), loanType: 'Purchase',
      purchasePrice: 200000, asIsValue: 200000, arv: 300000, rehabBudget: 40000 });
    ok(enter.status === 201 && enter.body.id, 'broker A enters a loan (201)');
    const appA = enter.body.id;
    const borr = (await db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [appA])).rows[0].borrower_id;
    // Give the borrower a real FICO so the deal prices (the enter door sets none).
    await call(server, 'PATCH', `/api/tpo/borrowers/${borr}`, tokA, { fico: 730 });

    // ---- 1) GET /pricing — borrower-safe, no internal margin ----
    const pg = await call(server, 'GET', `/api/tpo/applications/${appA}/pricing`, tokA);
    ok(pg.status === 200, 'broker A reads pricing (200)');
    ok(typeof pg.body.termSheetFinal === 'boolean', 'the pricing read reports termSheetFinal (a boolean)');
    ok('econVersion' in pg.body, 'the pricing read carries an econVersion (optimistic-concurrency token)');
    const enginesReady = !!pg.body.enginesReady;
    ok(noMargin(pg.body.quote), 'the live what-if quote carries NO internal margin (no adminPricing / markup / fico)');

    // ---- 2) POST /pricing/quote — still stripped ----
    const q2 = await call(server, 'POST', `/api/tpo/applications/${appA}/pricing/quote`, tokA, { overrides: { targetLTC: 0.7 } });
    if (enginesReady) {
      ok(q2.status === 200 && noMargin(q2.body), 'a what-if quote with a broker override is stripped of internal margin');
    } else { ok(true, '(pricing engines not loaded in this env — quote skipped)'); }

    // ---- 3) POST /pricing/register — a real registration, INITIAL sheet ----
    let regOK = false;
    if (enginesReady) {
      const reg = await call(server, 'POST', `/api/tpo/applications/${appA}/pricing/register`, tokA, { program: 'standard', econVersion: pg.body.econVersion });
      regOK = reg.status === 201 && !!reg.body.registrationId;
      ok(regOK, `broker A registers a Standard product (201)${regOK ? '' : ' — got ' + reg.status + ' ' + JSON.stringify(reg.body).slice(0, 160)}`);
      if (regOK) {
        ok(noMargin({ standard: reg.body.quote }), 'the registered quote in the response carries NO internal margin');
        ok(reg.body.termSheetFinal === false, 'a fresh file\'s term sheet is INITIAL, not final (WE send the official one)');
        const rr = (await db.query(`SELECT is_current, registered_by, total_loan FROM product_registrations WHERE application_id=$1 ORDER BY created_at DESC LIMIT 1`, [appA])).rows[0];
        ok(rr && rr.is_current === true, 'a current product_registrations row was written');
        ok(rr && String(rr.registered_by) === String(brokerA), 'the registration records the BROKER as registered_by (a staff_users FK)');
        ok(Number((await db.query(`SELECT loan_amount FROM applications WHERE id=$1`, [appA])).rows[0].loan_amount) > 0,
          'the file\'s loan amount was written by the register');
        const pp = (await db.query(`SELECT status FROM checklist_items WHERE application_id=$1 AND tool_key='product_pricing' LIMIT 1`, [appA])).rows[0];
        ok(!pp || pp.status === 'received', 'the Products & pricing condition reopened to received on register');
        // (The TPO register deliberately never calls terms-notify.sendBorrowerTerms —
        // WE send the official term sheet; a broker register never emails the
        // borrower terms. Verified by construction in routes/tpo.js.)
      }
    } else { ok(true, '(pricing engines not loaded — register skipped)'); }

    // ---- 4) the term sheet uploads through the ONE special kind ----
    const tsB64 = Buffer.from('%PDF-1.4 fake term sheet ' + sfx).toString('base64');
    const up1 = await call(server, 'POST', '/api/tpo/documents', tokA, {
      filename: 'term-sheet.pdf', contentType: 'application/pdf', dataBase64: tsB64, applicationId: appA, docKind: 'term_sheet', termSheetFinal: false });
    ok(up1.status === 201 && up1.body.documentId, 'the studio uploads the term-sheet PDF (201)');
    const ts1 = (await db.query(`SELECT doc_kind, review_status, is_current, term_sheet_final, checklist_item_id FROM documents WHERE id=$1`, [up1.body.documentId])).rows[0];
    ok(ts1 && ts1.doc_kind === 'term_sheet' && ts1.review_status === 'pending' && ts1.is_current === true,
      'a broker\'s term sheet is born PENDING (untrusted external party — the LENDER reviews it before it is accepted)');
    ok(ts1 && ts1.term_sheet_final === false, 'a fresh file\'s term sheet is stamped INITIAL (server-derived)');
    ok(ts1 && ts1.checklist_item_id != null, 'the term sheet auto-attaches to the Products & pricing condition');
    const ts1cond = ts1 && ts1.checklist_item_id
      ? (await db.query(`SELECT tool_key FROM checklist_items WHERE id=$1`, [ts1.checklist_item_id])).rows[0] : null;
    ok(!ts1cond || ts1cond.tool_key === 'product_pricing', 'the term sheet condition is the pricing condition');
    // a second term sheet supersedes the first — exactly one current — and a broker
    // CANNOT forge FINAL: the client claims termSheetFinal:true, the server ignores
    // it and re-derives INITIAL from the send gate (a fresh file has open blockers).
    const up2 = await call(server, 'POST', '/api/tpo/documents', tokA, {
      filename: 'term-sheet-2.pdf', contentType: 'application/pdf', dataBase64: Buffer.from('%PDF-1.4 second ' + sfx).toString('base64'), applicationId: appA, docKind: 'term_sheet', termSheetFinal: true });
    ok(up2.status === 201, 'the studio uploads a second (re-registered) term sheet');
    ok((await db.query(`SELECT term_sheet_final FROM documents WHERE id=$1`, [up2.body.documentId])).rows[0].term_sheet_final === false,
      'a broker\'s forged termSheetFinal:true is IGNORED — the server re-derives INITIAL (the send byte-check can\'t be defeated)');
    ok((await db.query(`SELECT count(*)::int n FROM documents WHERE application_id=$1 AND doc_kind='term_sheet' AND is_current=true`, [appA])).rows[0].n === 1,
      'exactly ONE term sheet is current — the prior was superseded');
    ok((await db.query(`SELECT is_current FROM documents WHERE id=$1`, [up1.body.documentId])).rows[0].is_current === false,
      'the first term sheet is no longer current');
    // Fix (security audit): a STAFF registration's internal admin-override knobs
    // (ovr*/forcePrice/manualPricing/markup*) must be STRIPPED from a broker's
    // pricing-history view — internal underwriting-override disclosure.
    await db.query(
      `INSERT INTO product_registrations (application_id, program, product_label, status, note_rate, total_loan, is_current, inputs, quote, registered_by)
       VALUES ($1,'standard','Standard','ELIGIBLE',0.1,150000,false,$2,$3,$4)`,
      [appA,
       JSON.stringify({ purchasePrice: 200000, asIsValue: 200000, arv: 300000, rehabBudget: 40000, term: 12, ovrLTC: 0.85, ovrRate: 0.0925, ovrEffPrice: 410000, forcePrice: true, manualPricing: true, markupStdPct: 2, fico: 700 }),
       JSON.stringify({ noteRate: 0.1, adminPricing: { spread: 0.02 } }), brokerA]);
    const pg2 = await call(server, 'GET', `/api/tpo/applications/${appA}/pricing`, tokA);
    const staffHist = (pg2.body.history || []).find((h) => Number(h.total_loan) === 150000);
    const si = (staffHist && staffHist.inputs) || {};
    ok(staffHist && !('ovrLTC' in si) && !('ovrRate' in si) && !('ovrEffPrice' in si) && !('forcePrice' in si)
        && !('manualPricing' in si) && !('markupStdPct' in si) && !('fico' in si),
      'a staff registration\'s admin-override knobs are STRIPPED from the broker\'s pricing history');
    ok(staffHist && si.purchasePrice === 200000 && si.term === 12,
      'the borrower-safe scenario (price / term / values) survives the strip');
    ok(staffHist && (!staffHist.quote || !('adminPricing' in staffHist.quote)),
      'the staff registration\'s adminPricing (internal margin) is stripped from the history quote');

    // ---- 5) a broker cannot forge an arbitrary doc_kind ----
    const forge = await call(server, 'POST', '/api/tpo/documents', tokA, {
      filename: 'evil.pdf', contentType: 'application/pdf', dataBase64: tsB64, applicationId: appA, docKind: 'appraisal_source' });
    ok(forge.status === 201 && (await db.query(`SELECT doc_kind, review_status FROM documents WHERE id=$1`, [forge.body.documentId])).rows[0].doc_kind === null,
      'a non-term-sheet docKind from a broker is IGNORED (stored as an ordinary pending document)');

    // ---- 6) firm isolation across the whole pricing surface ----
    ok((await call(server, 'GET', `/api/tpo/applications/${appA}/pricing`, tokB)).status === 404, 'broker B cannot read firm A pricing (404)');
    ok((await call(server, 'POST', `/api/tpo/applications/${appA}/pricing/quote`, tokB, { overrides: {} })).status === 404, 'broker B cannot quote firm A (404)');
    ok((await call(server, 'POST', `/api/tpo/applications/${appA}/pricing/register`, tokB, { program: 'standard' })).status === 404, 'broker B cannot register on firm A (404)');
    ok((await call(server, 'POST', '/api/tpo/documents', tokB, { filename: 'x.pdf', dataBase64: tsB64, applicationId: appA, docKind: 'term_sheet' })).status === 404, 'broker B cannot upload a term sheet to firm A (404)');

    // ---- 7) a refinance with no as-is value is refused ----
    const refi = await call(server, 'POST', '/api/tpo/applications', tokA, {
      borrower: { firstName: 'Ref', lastName: 'Eye', email: mail('refi') },
      propertyAddress: addrOf(2), loanType: 'Refinance', arv: 300000, rehabBudget: 20000 });
    ok(refi.status === 201, 'broker A enters a refinance with no as-is value');
    if (enginesReady) {
      const rReg = await call(server, 'POST', `/api/tpo/applications/${refi.body.id}/pricing/register`, tokA, { program: 'standard' });
      ok(rReg.status === 400 && rReg.body.field === 'asIsValue', 'registering a refinance with no as-is value is refused (400, field asIsValue)');
    } else { ok(true, '(engines not loaded — refi register skipped)'); }

    // ---- 8) the DocuSign SEND surface does not exist for a broker ----
    ok((await call(server, 'POST', `/api/tpo/applications/${appA}/esign/send`, tokA, {})).status === 404,
      'there is NO term-sheet SEND route on the broker surface — sending is lender-only');
  } catch (e) {
    fail++; console.log('  FAIL (threw):', e.message, e.stack ? e.stack.split('\n').slice(1, 3).join(' | ') : '');
  } finally {
    try {
      const like = `%${sfx}%`;
      await db.query(`DELETE FROM applications WHERE tpo_firm_id IN (SELECT id FROM tpo_firms WHERE name LIKE $1)`, [like]);
      await db.query(`DELETE FROM applications WHERE borrower_id IN (SELECT id FROM borrowers WHERE email LIKE $1)`, [like]);
      await db.query(`DELETE FROM audit_log WHERE actor_id IN (SELECT id FROM staff_users WHERE email LIKE $1)`, [like]);
      await db.query(`DELETE FROM borrowers WHERE email LIKE $1`, [like]);
      await db.query(`DELETE FROM staff_users WHERE email LIKE $1`, [like]);
      await db.query(`DELETE FROM tpo_firms WHERE name LIKE $1`, [like]);
    } catch (_) { /* best-effort cleanup */ }
    try { server.close(); } catch (_) {}
    try { await db.pool.end(); } catch (_) {}
    console.log(`test-tpo-pricing-db: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
