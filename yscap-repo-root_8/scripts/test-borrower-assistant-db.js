'use strict';
/**
 * BORROWER ASSISTANT — the real-schema + real-HTTP proof (owner-directed).
 * DB-gated (skips cleanly with no DATABASE_URL), in `npm test`.
 *
 * The pure test proves the token + PII scrub + blocklist in isolation. This one
 * proves the parts a pure test structurally cannot:
 *   • the migration schema (table + the one-live-helper-per-email partial index);
 *   • the invite → accept → login lifecycle over the real auth routes;
 *   • authenticate() actually mints `req.assistant`, so a real borrower response
 *     comes back with the PII stripped (DOB / SSN last-4 / credit score gone);
 *   • the guard refuses the signing ceremony, the profile editor, the payment
 *     card, and the borrower credential routes over real HTTP;
 *   • the borrower self-service management (invite / list / disable), that an
 *     assistant can NEVER manage helpers, and that disabling KILLS a live session
 *     immediately (the dual-identity revocation).
 *
 *   DATABASE_URL=postgres://… node scripts/test-borrower-assistant-db.js
 */
const R = require('path').resolve(__dirname, '..');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-assistant-db';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
function finish() {
  console.log(`\n${fail ? '✗' : '✓'} borrower-assistant DB: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

(async () => {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP borrower-assistant DB (no DATABASE_URL)'); return finish(); }
  const { ensureSchema } = require(R + '/src/migrate-boot');
  await ensureSchema();
  const db = require(R + '/src/db');
  const C = require(R + '/src/lib/crypto');
  const http = require('http');
  const app = require(R + '/src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  const call = (method, p, token, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });

  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  try {
    // ---- SCHEMA ------------------------------------------------------------
    const cols = (await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='borrower_assistants'`)).rows.map((r) => r.column_name);
    for (const c of ['id', 'borrower_id', 'email', 'name', 'password_hash', 'token_version',
      'invite_token_hash', 'invite_expires_at', 'disabled_at']) {
      ok(cols.includes(c), `borrower_assistants has column ${c}`);
    }
    const idx = (await db.query(`SELECT indexname FROM pg_indexes WHERE tablename='borrower_assistants'`)).rows.map((r) => r.indexname);
    ok(idx.includes('borrower_assistants_email_uk'), 'the one-live-helper-per-email partial unique index exists');

    // ---- a borrower WITH PII + a login ------------------------------------
    const s = C.ssnForStorage('123456789');
    const bId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email,date_of_birth,ssn_encrypted,ssn_last4,fico,citizenship,cell_phone)
       VALUES ('Pat','Borrower',$1,'1990-01-01',$2,$3,720,'US','555-1212') RETURNING id`,
      [`ba-b-${sfx}@test.local`, s.encrypted, s.last4])).rows[0].id;
    await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version,email_verified) VALUES ($1,'x',0,true)`, [bId]);
    const borrowerTok = C.signJwt({ sub: bId, kind: 'borrower', role: 'borrower', tv: 0 });
    // An application on the file — for the timestamp-survival + complete-fields checks.
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, status, loan_type) VALUES ($1,'file_intake','Purchase') RETURNING id`, [bId])).rows[0].id;

    // ---- INVITE (borrower self-service) -----------------------------------
    const inv = await call('POST', '/api/borrower/assistants', borrowerTok, { email: `ba-helper-${sfx}@test.local`, name: 'Helper H' });
    ok(inv.status === 201 && inv.body && inv.body.ok, 'borrower invites a helper (201)');
    const helperId = inv.body && inv.body.id;
    const list1 = await call('GET', '/api/borrower/assistants', borrowerTok);
    ok(list1.status === 200 && Array.isArray(list1.body.assistants) && list1.body.assistants.some((a) => a.id === helperId && a.status === 'invited'),
      'the invited helper shows in the list as "invited"');
    // a real invite token hash was stored
    const hashRow = (await db.query(`SELECT invite_token_hash, invite_expires_at FROM borrower_assistants WHERE id=$1`, [helperId])).rows[0];
    ok(hashRow.invite_token_hash && hashRow.invite_expires_at, 'a one-time invite link was stored (hashed)');

    // ---- ACCEPT the invite (set password) via a known token ----------------
    // The raw token is only emailed, so plant a known one on the row to accept it.
    const rawToken = C.randomToken(24);
    await db.query(`UPDATE borrower_assistants SET invite_token_hash=$2, invite_expires_at=now()+interval '1 day' WHERE id=$1`,
      [helperId, C.sha256(rawToken)]);
    const badAccept = await call('POST', '/auth/assistant/accept', null, { token: 'nope', password: 'Helper-Assistant-Pass-2026' });
    ok(badAccept.status === 400, 'accept with a wrong token is refused');
    const acc = await call('POST', '/auth/assistant/accept', null, { token: rawToken, password: 'Helper-Assistant-Pass-2026' });
    ok(acc.status === 200 && acc.body && acc.body.assistant === true && acc.body.token, 'accept sets the password and returns a helper token');
    let helperTok = acc.body.token;
    ok((await db.query(`SELECT invite_token_hash FROM borrower_assistants WHERE id=$1`, [helperId])).rows[0].invite_token_hash === null,
      'the one-time invite link is cleared after use');

    // ---- the helper token IS a working borrower session, PII STRIPPED ------
    const me = await call('GET', '/auth/me', helperTok);
    ok(me.status === 200 && me.body && me.body.assistant === true, '/auth/me reports a helper session');
    ok(me.body.id === bId, 'the helper acts as the BORROWER (scoping id)');
    const prof = await call('GET', '/api/borrower/profile', helperTok);
    ok(prof.status === 200, 'the helper can read the borrower profile');
    ok(!('date_of_birth' in prof.body) && !('ssn_last4' in prof.body) && !('fico' in prof.body)
       && !('citizenship' in prof.body) && !('marital_status' in prof.body),
      'PERSONAL INFO is stripped from the helper response (DOB / SSN / credit / citizenship)');
    ok(prof.body.first_name === 'Pat' && prof.body.email && prof.body.cell_phone === '555-1212',
      'operational fields (name / email / phone) are still there');
    // the SAME endpoint for the real BORROWER still shows their PII
    const profB = await call('GET', '/api/borrower/profile', borrowerTok);
    ok(profB.status === 200 && profB.body.ssn_last4 === s.last4 && profB.body.fico === 720,
      'the real borrower still sees their own personal info (the strip is helper-only)');

    // TIMESTAMPS SURVIVE THE SCRUB (a timestamptz Date must not become {}).
    const apps = await call('GET', '/api/borrower/applications', helperTok);
    ok(apps.status === 200 && Array.isArray(apps.body) && apps.body.length >= 1, 'the helper sees the borrower’s applications');
    ok(apps.body[0] && typeof apps.body[0].created_at === 'string' && !Number.isNaN(Date.parse(apps.body[0].created_at)),
      'a timestamp comes back as a real date string for a helper (not {})');

    // The stored payment card is HIDDEN from a helper (bare last4/brand keys).
    const cardBlk = await call('GET', `/api/borrower/applications/${appId}/appraisal-card`, helperTok);
    ok(cardBlk.status === 403 && cardBlk.body.assistantBlocked === 'card_view', 'the helper cannot read the payment card');
    const savedCardBlk = await call('GET', '/api/borrower/saved-appraisal-card', helperTok);
    ok(savedCardBlk.status === 403 && savedCardBlk.body.assistantBlocked === 'card_view', 'the helper cannot read the saved payment card');
    // Document downloads are blocked (bytes bypass the scrub; a photo ID shows DOB).
    const dlBlk = await call('GET', `/api/borrower/documents/${bId}/download`, helperTok);
    ok(dlBlk.status === 403 && dlBlk.body.assistantBlocked === 'document', 'the helper cannot download documents');

    // complete-fields: a helper may complete DEAL fields but NEVER the borrower's
    // personal details — the identity fields are stripped, the DOB is unchanged.
    await call('POST', `/api/borrower/applications/${appId}/complete-fields`, helperTok, { date_of_birth: '2000-12-31', fico: 500 });
    const dobRow = (await db.query(`SELECT to_char(date_of_birth,'YYYY-MM-DD') AS dob, fico FROM borrowers WHERE id=$1`, [bId])).rows[0];
    ok(dobRow.dob === '1990-01-01' && Number(dobRow.fico) === 720, 'a helper’s complete-fields did NOT change the borrower’s date of birth or credit score');

    // A helper cannot ANSWER a condition that writes the borrower's own detail
    // (the credit-score info-condition writes borrowers.fico) — but the borrower can.
    const itemId = (await db.query(
      `INSERT INTO checklist_items (application_id, scope, label, field_key, tool_key, audience, status)
       VALUES ($1,'application','Credit score','fico','info_field','both','outstanding') RETURNING id`, [appId])).rows[0].id;
    const infoBlk = await call('POST', `/api/borrower/applications/${appId}/checklist/${itemId}/info`, helperTok, { value: 650 });
    ok(infoBlk.status === 403, 'a helper cannot answer the credit-score condition (writes borrowers.fico)');
    const infoOk = await call('POST', `/api/borrower/applications/${appId}/checklist/${itemId}/info`, borrowerTok, { value: 640 });
    ok(infoOk.status !== 403, 'the real borrower CAN answer the same condition (the block is helper-only)');

    // ---- the helper CANNOT sign / edit identity / add a card / touch creds -
    const signBlocked = await call('POST', `/api/borrower/applications/00000000-0000-0000-0000-000000000000/esign/sign-view`, helperTok, {});
    ok(signBlocked.status === 403 && signBlocked.body.assistantBlocked === 'esign', 'the helper cannot open the signing ceremony');
    const putBlocked = await call('PUT', '/api/borrower/profile', helperTok, { firstName: 'Nope' });
    ok(putBlocked.status === 403 && putBlocked.body.assistantBlocked === 'profile', 'the helper cannot edit the borrower’s personal details');
    const cardBlocked = await call('POST', `/api/borrower/applications/00000000-0000-0000-0000-000000000000/appraisal-card`, helperTok, {});
    ok(cardBlocked.status === 403 && cardBlocked.body.assistantBlocked === 'card', 'the helper cannot add a payment card');
    const logoutBlocked = await call('POST', '/auth/logout', helperTok, {});
    ok(logoutBlocked.status === 403 && logoutBlocked.body.assistantBlocked === 'logout', 'the helper cannot sign the real borrower out');

    // ---- a helper can never manage helpers (no escalation) ------------------
    const mgmtBlocked = await call('POST', '/api/borrower/assistants', helperTok, { email: `x-${sfx}@test.local` });
    ok(mgmtBlocked.status === 403, 'a helper cannot create another helper');

    // ---- LOGIN by email + password ----------------------------------------
    const login = await call('POST', '/auth/assistant/login', null, { email: `ba-helper-${sfx}@test.local`, password: 'Helper-Assistant-Pass-2026' });
    ok(login.status === 200 && login.body && login.body.token, 'the helper can sign in by email + password');
    const badLogin = await call('POST', '/auth/assistant/login', null, { email: `ba-helper-${sfx}@test.local`, password: 'wrong' });
    ok(badLogin.status === 401, 'a wrong password is refused');

    // ---- DISABLE kills the live session immediately (dual-identity) ---------
    const disable = await call('POST', `/api/borrower/assistants/${helperId}/disable`, borrowerTok, {});
    ok(disable.status === 200, 'the borrower disables the helper');
    const afterDisable = await call('GET', '/auth/me', helperTok);
    ok(afterDisable.status === 401, 'the disabled helper’s live session is refused on the very next request');
    // The live event STREAM is revoked too (it re-implements auth and must honor
    // the disable — the token is passed as a query param, not a bearer header).
    const evt = await call('GET', `/api/events?token=${encodeURIComponent(helperTok)}`, null);
    ok(evt.status === 401, 'the disabled helper’s live event stream is refused');
    const loginAfter = await call('POST', '/auth/assistant/login', null, { email: `ba-helper-${sfx}@test.local`, password: 'Helper-Assistant-Pass-2026' });
    ok(loginAfter.status === 401, 'a disabled helper can no longer sign in');
    const gone = await call('GET', '/api/borrower/assistants', borrowerTok);
    ok(gone.status === 200 && !gone.body.assistants.some((a) => a.id === helperId), 'the disabled helper drops off the list');
  } catch (e) {
    fail++; console.log('  FAIL (threw):', e && e.stack || e);
  } finally {
    server.close();
  }
  finish();
})();
