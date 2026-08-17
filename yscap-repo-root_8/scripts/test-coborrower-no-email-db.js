/**
 * A CO-BORROWER WITH NO EMAIL SAVES — and a "server error" says what it was.
 * Real Postgres, real HTTP, through the real routes.
 *
 * Owner-reported 2026-08-16 with a screenshot: name + DOB + Social typed into the
 * Co-borrower panel, "Save co-borrower" pressed, and a red "server error" under
 * the button. Two separate defects, one report:
 *
 *   1. `borrowers.email` was `citext NOT NULL`, while the ONE function both the
 *      co-borrower panel and staff file-creation share binds NULL when the box
 *      the screen itself labels OPTIONAL is left blank. Every email-less
 *      co-borrower add has failed since that was written — db/569.
 *   2. The failure reached the user as the words "server error" and nothing
 *      else, from a catch-all shared by 379 route handlers — src/lib/http-fail.js.
 *
 * WHAT IS PROVEN HERE, and why each assertion exists:
 *   • the owner's exact payload saves, and the person is stored with NO address
 *     (not an empty string, not a synthetic one) — an empty string would collide
 *     two different email-less people on the partial unique index;
 *   • TWO email-less co-borrowers coexist, which is the property the NULL was
 *     chosen for in the first place;
 *   • the same door still works with an email, and still refuses a duplicate
 *     email belonging to a different person (the guard db/569 must not weaken);
 *   • a genuine 500 now carries a reference for everyone and the real reason for
 *     a STAFF caller — and NOT for a borrower, because the reason is internal
 *     wording that can quote what somebody typed;
 *   • the reason reaches `request_audit_log.error`, so the file's own audit log
 *     can show it instead of a bare 500.
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
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP co-borrower no-email DB (no DATABASE_URL)'); process.exit(0); }
  const R = require('path').resolve(__dirname, '..');
  const db = require(R + '/src/db');
  const C = require(R + '/src/lib/crypto');
  const app = require(R + '/src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const mail = (t) => `${t}-${sfx}@cob.test`;

  try {
    // ── the file ────────────────────────────────────────────────────────────
    const staffId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,token_version)
       VALUES ($1,'Desk Admin','admin',true,0) RETURNING id`, [mail('admin')])).rows[0].id;
    const tok = C.signJwt({ sub: staffId, kind: 'staff', role: 'admin', tv: 0 });
    const borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Primary','Borrower',$1) RETURNING id`,
      [mail('primary')])).rows[0].id;
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, property_address, loan_type, status)
       VALUES ($1,$2,'Purchase','file_intake') RETURNING id`,
      [borrowerId, JSON.stringify({ line1: '1 Main St', city: 'Lakewood', state: 'NJ', zip: '08701' })])).rows[0].id;

    // ── A. THE OWNER'S OWN PAYLOAD ──────────────────────────────────────────
    // Name + DOB + Social, no email — exactly the screenshot.
    const save = await call(server, 'POST', `/api/staff/applications/${appId}/co-borrower`, tok,
      { firstName: 'Chana', lastName: 'Jacobs', dob: '1988-04-12', ssn: '123-45-6789' });
    ok(save.status === 200 && save.body && save.body.ok === true,
      `a co-borrower with no email saves (got ${save.status} ${JSON.stringify(save.body)})`);
    const coId = save.body && save.body.coBorrowerId;

    const co = coId ? (await db.query(
      `SELECT first_name, last_name, email, date_of_birth, ssn_last4, origin FROM borrowers WHERE id=$1`, [coId])).rows[0] : null;
    ok(co && co.first_name === 'Chana' && co.last_name === 'Jacobs', 'the co-borrower is stored under the typed name');
    // NULL, not '' — an empty string is a VALUE and would collide the next
    // email-less person on `borrowers_email_owner_uk`.
    ok(co && co.email === null, `no email is stored as nothing at all (got ${co && JSON.stringify(co.email)})`);
    ok(co && co.ssn_last4 === '6789', 'the Social is still encrypted + last-4 indexed');
    ok(co && String(co.date_of_birth).slice(0, 10) === '1988-04-12', 'the date of birth is stored as the typed day');
    ok((await db.query(`SELECT co_borrower_id FROM applications WHERE id=$1`, [appId])).rows[0].co_borrower_id === coId,
      'the file points at the co-borrower');

    // ── A2. THE SAME ROOT, A SECOND DOOR ───────────────────────────────────
    // `PATCH /borrowers/:id` turns a blank email into NULL (`… || null`), so
    // CLEARING an address on the borrower profile hit the identical NOT NULL and
    // answered the identical "server error" — on the shared editor both the
    // primary and the co-borrower are edited through. The column was the root;
    // this is the other place it surfaced.
    const cleared = await call(server, 'PATCH', `/api/staff/borrowers/${coId}`, tok, { email: '' });
    ok(cleared.status === 200, `clearing a borrower's email saves (got ${cleared.status} ${JSON.stringify(cleared.body)})`);
    ok((await db.query(`SELECT email FROM borrowers WHERE id=$1`, [coId])).rows[0].email === null,
      'a cleared email is stored as nothing, never as an empty string');

    // ── B. TWO people with no email coexist ────────────────────────────────
    // The property the NULL was chosen for. With '' they would be one row.
    const app2 = (await db.query(
      `INSERT INTO applications (borrower_id, property_address, loan_type, status)
       VALUES ($1,$2,'Purchase','file_intake') RETURNING id`,
      [borrowerId, JSON.stringify({ line1: '2 Main St', city: 'Lakewood', state: 'NJ', zip: '08701' })])).rows[0].id;
    const save2 = await call(server, 'POST', `/api/staff/applications/${app2}/co-borrower`, tok,
      { firstName: 'Miriam', lastName: 'Stern' });
    ok(save2.status === 200 && save2.body.coBorrowerId && save2.body.coBorrowerId !== coId,
      'a SECOND email-less co-borrower is a distinct person, not a collision');

    // ── C. the door is otherwise untouched ─────────────────────────────────
    const app3 = (await db.query(
      `INSERT INTO applications (borrower_id, property_address, loan_type, status)
       VALUES ($1,$2,'Purchase','file_intake') RETURNING id`,
      [borrowerId, JSON.stringify({ line1: '3 Main St', city: 'Lakewood', state: 'NJ', zip: '08701' })])).rows[0].id;
    const withEmail = await call(server, 'POST', `/api/staff/applications/${app3}/co-borrower`, tok,
      { firstName: 'Rivka', lastName: 'Gold', email: mail('rivka') });
    ok(withEmail.status === 200, 'a co-borrower WITH an email still saves');
    // The email-adoption guard must survive: the same address under a different
    // name is still refused rather than silently merged onto a stranger.
    const clash = await call(server, 'POST', `/api/staff/applications/${app3}/co-borrower`, tok,
      { firstName: 'Someone', lastName: 'Else', email: mail('rivka') });
    ok(clash.status === 409, `a different person on a taken email is still refused (got ${clash.status})`);
    // A nameless co-borrower is still refused — db/569 relaxes the EMAIL only.
    ok((await call(server, 'POST', `/api/staff/applications/${app3}/co-borrower`, tok, { firstName: 'OnlyFirst' })).status === 400,
      'a co-borrower still needs a first AND last name');

    // ── D. A "server error" NOW SAYS WHAT IT WAS ───────────────────────────
    // A REAL production route, reached over HTTP, hitting a REAL database error
    // and ending in the exact `catch { 500 'server error' }` that 379 handlers
    // share — so what is proven is the WIRING, not a hand-called function.
    // Linking a co-borrower by an id that is not a uuid reaches
    // `UPDATE applications SET co_borrower_id=$2` and Postgres refuses it (22P02).
    // Before this change that reached the staffer as the two words "server error".
    const httpFail = require(R + '/src/lib/http-fail');
    const failed = await call(server, 'POST', `/api/staff/applications/${appId}/co-borrower`, tok,
      { borrowerId: 'not-a-uuid' });
    ok(failed.status === 500, `the failing route still answers 500 (got ${failed.status})`);
    ok(failed.body && failed.body.error === 'server error', 'the original wording is untouched (nothing existing changes)');
    ok(failed.body && typeof failed.body.reference === 'string' && failed.body.reference.length > 3,
      'a reference is attached, so a person can quote it');
    ok(failed.body && failed.body.reference === failed.headers['x-request-id'],
      'the reference IS the request id the response already carried, so it names one row in the request log');
    ok(failed.body && /invalid input syntax for type uuid/i.test(failed.body.detail || ''),
      `a STAFF caller is told the real reason (got ${JSON.stringify(failed.body && failed.body.detail)})`);
    ok(failed.body && failed.body.code === '22P02', 'the Postgres code rides along for whoever is troubleshooting');

    // The reason reaches the request log, which is what puts it in the file's
    // own audit log rather than only in a server log nobody can open.
    await require(R + '/src/lib/request-audit').flushNow();
    const logged = (await db.query(
      `SELECT error, status FROM request_audit_log WHERE request_id=$1 LIMIT 1`, [failed.body.reference])).rows[0];
    ok(logged && logged.status === 500 && /invalid input syntax for type uuid/i.test(logged.error || ''),
      'the reason is recorded on the request-log row for that reference');

    // ── E. WHO MAY SEE THE REASON ──────────────────────────────────────────
    // The reason is internal wording and can quote what somebody typed, so it
    // goes to STAFF only. A borrower and an outside broker get the reference,
    // which is all a support conversation needs. Asserted on the decision
    // itself, because there is no borrower route that reliably 500s.
    const shownTo = (kind) => {
      const res2 = { statusCode: 500, locals: {} };
      return httpFail._internals.enrich({ method: 'POST', path: '/x', requestId: 'ref123', actor: kind ? { kind } : null },
        res2, { cause: Object.assign(new Error('boom'), { code: '42P01' }), count: 1 }, { error: 'server error' });
    };
    ok(shownTo('staff').detail === 'boom code=42P01', 'a staff caller is shown the reason');
    // A ROUTE THAT ALREADY EXPLAINED ITSELF IS LEFT ALONE. Several handlers put
    // the VENDOR's own words on `detail` (the Class order path answers 502 with
    // the exact reason Class gave); replacing that with whatever the request
    // last tripped over would be worse than the bare message this improves.
    {
      const res3 = { statusCode: 502, locals: {} };
      const kept = httpFail._internals.enrich({ method: 'POST', path: '/x', requestId: 'ref9', actor: { kind: 'staff' } },
        res3, { cause: Object.assign(new Error('boom'), { code: '42P01' }), count: 1 },
        { error: 'order_failed', detail: 'The County field is required.', code: 'CLASS_400' });
      ok(kept.detail === 'The County field is required.' && kept.code === 'CLASS_400',
        'a reason the route already gave is never overwritten');
      ok(kept.reference === 'ref9', '...and it still gains a reference');
    }
    ok(shownTo('borrower').detail === undefined && shownTo('borrower').reference === 'ref123',
      'a borrower gets the reference and NOT the database error text');
    ok(shownTo('tpo').detail === undefined, 'an outside broker gets the reference and NOT the database error text');
    ok(shownTo(null).detail === undefined, 'an anonymous caller gets the reference and NOT the database error text');

    // ── F. NOTHING ELSE IS TOUCHED ─────────────────────────────────────────
    // A 4xx and a 2xx must be byte-identical to before, or every screen that
    // reads a refusal starts rendering plumbing.
    const refusal = await call(server, 'POST', `/api/staff/applications/${app3}/co-borrower`, tok, { firstName: 'OnlyFirst' });
    ok(refusal.body && refusal.body.reference === undefined && refusal.body.detail === undefined,
      'a 400 refusal carries no reference and no plumbing');
    ok(withEmail.body.reference === undefined, 'a 200 carries no reference');

    // The scrubber: a reason that quotes a Social must never be handed back.
    const scrubbed = httpFail.describe(Object.assign(new Error('invalid input syntax for type integer: "123-45-6789"'), { code: '22P02' }));
    ok(!/123-45-6789/.test(scrubbed) && /SSN ending 6789/.test(scrubbed),
      `a Social inside a database message is scrubbed out of the reason (got ${scrubbed})`);
    // The failing ROW is never quoted: pg puts its values in `detail`, so that
    // field is deliberately not read.
    const rowy = Object.assign(new Error('null value in column "email" violates not-null constraint'), {
      code: '23502', column: 'email', table: 'borrowers',
      detail: 'Failing row contains (uuid, Chana, Jacobs, null, 1988-04-12, \\xdeadbeef).' });
    const described = httpFail.describe(rowy);
    ok(/23502/.test(described) && /email/.test(described) && !/Chana/.test(described) && !/deadbeef/.test(described),
      `the failing row's values are never quoted (got ${described})`);
  } catch (e) {
    fail++; console.log('  FAIL: harness threw:', e && e.stack ? e.stack : e);
  }

  server.close();
  await db.pool.end().catch(() => {});
  console.log(`co-borrower no-email + server-error detail: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
