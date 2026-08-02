'use strict';
/* =====================================================================
   EVERY DOOR THAT BINDS A TYPED COLUMN — the post-merge audit's SECOND pass
   (2026-08-02).

   The first pass wired the column guards into the doors it ENUMERATED, and the
   list was not complete. This suite is the other five, each reproduced against
   a real Postgres BEFORE the fix and each assertion checked to FAIL on the
   pre-fix code:

     F1  both completeness panels (staff + borrower) answered 500 "server error"
         on a money value the column cannot hold — while the SAME value on
         PATCH /details answered a plain 400 naming the field.
     F2  the borrower's completeness panel SWALLOWED the change-request
         refusal on a locked file: 200 {ok:true}, no request filed, nothing said.
     F3  the appraisal finding's "custom" reprice 500'd on an oversized value,
         and parsed a unit COUNT by deleting non-digits — so "1e10" silently
         stored 110 UNITS on an input the loan is priced off.
     F4  the info-condition door handed the BORROWER Postgres's own words
         ("numeric field overflow"), naming no field and quoting no limit.
     F5  the public intake door bounded each assignment PART but not the
         purchase price it DERIVES from them, and LOST THE LEAD to a 500.

   …plus the two smaller ones from the same report:
     R3  a NUL byte in a draft autosave answered 500 (a JSONB column, so the
         text-column NUL strip never covered it).
     R5  the cash-to-close attachment accepted a SUPERSEDED document as the
         evidence for the figure.

   Needs DATABASE_URL; skips cleanly without one.
   Run: DATABASE_URL=… node scripts/test-column-bounds-doors-db.js
   ===================================================================== */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const eq = (a, b, m) => assert(String(a) === String(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

/* The two things that separate "refused" from the bug. A 500 is the bug itself;
   a 400 whose text is the DRIVER's is the bug wearing a better status code, and
   that is exactly what F4 was. */
const RAW_PG = /numeric field overflow|out of range for type|invalid input syntax|unsupported Unicode/i;
const saysLimit = (r) => /999,999,999,999\.99|2,147,483,647|whole number|between 0 and 24/.test(String((r.body && r.body.error) || ''));
const noRawPg = (r) => !RAW_PG.test(String((r.body && r.body.error) || ''));

if (!process.env.DATABASE_URL) {
  console.log('(skipping — no DATABASE_URL)');
  process.exit(0);
}

(async () => {
  const db = require('../src/db');
  const C = require('../src/lib/crypto');
  const http = require('http');
  const sfx = Date.now().toString(36);
  let server = null;

  try {
    const borrowerId = (await db.query(
      `INSERT INTO borrowers (email,first_name,last_name) VALUES ($1,'Bounds','Doors') RETURNING id`,
      [`bounds-doors-${sfx}@test.local`])).rows[0].id;
    await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,'x',0) ON CONFLICT DO NOTHING`, [borrowerId]);
    const staffId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Bounds Admin','super_admin',true,false,'x',0) RETURNING id`,
      [`bounds-doors-admin-${sfx}@test.local`])).rows[0].id;

    const app = require('../src/server');
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));

    const REQ_TIMEOUT_MS = 8000;
    const call = (method, p, token, body, headers) => new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const rq = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1',
        timeout: REQ_TIMEOUT_MS,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(headers || {}), ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
        (res) => { let s = ''; res.on('data', (c) => s += c); res.on('end', () => { let j = null; try { j = s ? JSON.parse(s) : null; } catch (_) { j = { _raw: s.slice(0, 300) }; } resolve({ status: res.statusCode, body: j }); }); });
      rq.on('timeout', () => { rq.destroy(); resolve({ status: 'timeout', body: { error: `no answer in ${REQ_TIMEOUT_MS}ms` } }); });
      rq.on('error', (e) => (e && e.code === 'ECONNRESET' ? resolve({ status: 'timeout', body: { error: 'connection destroyed' } }) : reject(e)));
      if (data) rq.write(data); rq.end();
    });
    const bTok = C.signJwt({ sub: borrowerId, kind: 'borrower', tv: 0 });
    const sTok = C.signJwt({ sub: staffId, kind: 'staff', role: 'super_admin', tv: 0 });
    const ADDR = { line1: '11 Bounds Ct', city: 'Lakewood', state: 'NJ', zip: '08701' };

    const newFile = async () => {
      const r = await call('POST', '/api/staff/applications', sTok, {
        borrower: { email: `bounds-doors-${sfx}@test.local`, firstName: 'Bounds', lastName: 'Doors' },
        propertyAddress: ADDR, program: 'Fix & Flip w/ Construction', loanType: 'Purchase',
        purchasePrice: 500000, asIsValue: 600000, arv: 900000, rehabBudget: 200000,
        propertyType: 'SFR (1 unit)', units: 1,
      });
      return (r.body && (r.body.applicationId || r.body.id)) || null;
    };
    const register = (appId) => db.query(
      `INSERT INTO product_registrations (application_id, program, status, note_rate, total_loan, inputs, quote, is_current)
       VALUES ($1,'standard','ELIGIBLE',0.1199,100000,'{}'::jsonb,'{"sizing":{"totalLoan":100000}}'::jsonb,true)`,
      [appId]);

    // Big enough to overflow numeric(14,2) by a wide margin, in the shape a
    // human actually produces: a paste with an extra keypress on the end.
    const HUGE_MONEY = '99999999999999999';

    /* ================================================================ *
     * THE COLUMN TABLE, CHECKED AGAINST THE REAL SCHEMA.
     *
     * The pure suite's completeness check is a HARD-CODED list, so it can only
     * ever re-state what someone already knew — the pre-merge audit proved it by
     * adding a real numeric(14,2) column and by giving an existing column the
     * WRONG kind, and the pure suite passed both times. The only thing that can
     * actually catch a drift is the database itself.
     * ================================================================ */
    console.log('\n--- the column table vs information_schema ---');
    {
      const nb = require('../src/lib/number-bounds');
      const KIND_OF = (t, p, s) => {
        if (t === 'integer') return 'int';
        if (t !== 'numeric' || p == null) return null;    // bigint / bare numeric: no ceiling to enforce
        if (p === 14 && s === 2) return 'money';
        if (p === 6 && s === 3) return 'pct';
        return { precision: p, scale: s };
      };
      const same = (a, b) => (a && typeof a === 'object' && b && typeof b === 'object')
        ? (a.precision === b.precision && a.scale === b.scale)
        : a === b;

      const problems = [];
      for (const table of Object.keys(nb.COLUMN_KIND)) {
        const cols = (await db.query(
          `SELECT column_name, data_type, numeric_precision, numeric_scale
             FROM information_schema.columns
            WHERE table_schema='public' AND table_name=$1
              AND data_type IN ('numeric','integer')`, [table])).rows;
        const seen = new Set();
        for (const c of cols) {
          const want = KIND_OF(c.data_type, c.numeric_precision, c.numeric_scale);
          const got = nb.columnKindOf(table, c.column_name);
          seen.add(c.column_name);
          if (want == null) continue;                     // nothing to enforce
          /* A CHECK narrower than the type legitimately overrides the type's own
             ceiling — that is the {min,max,what} kind, and it is stricter, so it
             is never a gap. */
          if (got && typeof got === 'object' && got.min != null) continue;
          if (got == null) { problems.push(`${table}.${c.column_name} is ${c.data_type}(${c.numeric_precision},${c.numeric_scale}) but has NO kind`); continue; }
          if (!same(want, got)) problems.push(`${table}.${c.column_name} is ${c.data_type}(${c.numeric_precision},${c.numeric_scale}) but the table says ${JSON.stringify(got)}`);
        }
        for (const k of Object.keys(nb.COLUMN_KIND[table])) {
          if (!seen.has(k)) problems.push(`${table}.${k} is in the table but is not a numeric column`);
        }
      }
      eq(problems.join(' | ') || '(none)', '(none)', 'every numeric column agrees with the table, read from the live schema');

      /* …and prove THIS check can fail, which is the whole point — the hard-coded
         one could not. A column the schema has and the table does not must be
         reported, so a real ALTER TABLE that forgets the table is caught. */
      const cols = (await db.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name='applications'
            AND data_type='numeric' AND numeric_precision=14 AND numeric_scale=2`)).rows;
      const sample = cols[0] && cols[0].column_name;
      assert(!!sample && nb.columnKindOf('applications', sample) === 'money',
        `…and it really is reading the schema (${sample} → money)`);
      const pretendMissing = cols.filter((c) => !nb.columnKindOf('applications', c.column_name));
      eq(pretendMissing.length, 0, '…with no numeric(14,2) column left uncovered');
    }

    /* ================================================================ *
     * F1 — the two completeness panels.
     * ================================================================ */
    console.log('\n--- F1: a money value the column cannot hold is a 400, not a 500 ---');
    {
      const appId = await newFile();
      assert(!!appId, 'a file was created for the completeness cases');

      const staffSet = (body) => call('POST', `/api/staff/applications/${appId}/complete-fields`, sTok, body);

      const arv = await staffSet({ arv: HUGE_MONEY });
      eq(arv.status, 400, 'staff completeness refuses an unstorable ARV');
      assert(saysLimit(arv), '…naming the limit the officer has to get under');
      assert(noRawPg(arv), '…in our words, never the database driver\'s');

      const rent = await staffSet({ estimated_rental_income: HUGE_MONEY });
      eq(rent.status, 400, 'the staff-only rental-income field is bounded too');

      /* THE PARITY THAT MATTERS: this panel writes the SAME columns as the
         details door, so the two must answer the same value the same way. A
         divergence here is the whole class — one door learns the rule, its twin
         does not, and which screen you happened to use decides whether the app
         breaks. */
      const details = await call('PATCH', `/api/staff/applications/${appId}/details`, sTok, { arv: HUGE_MONEY });
      eq(details.status, arv.status, 'the completeness panel and the details door agree on the same value');

      // …and an ordinary value still saves, so the guard did not just close the door.
      const ok = await staffSet({ arv: 950000 });
      eq(ok.status, 200, 'a perfectly ordinary ARV still saves');
      const row = (await db.query(`SELECT arv FROM applications WHERE id=$1`, [appId])).rows[0];
      eq(Number(row.arv), 950000, '…and it is what landed on the file');
    }

    {
      const appId = await newFile();
      const bSet = (body) => call('POST', `/api/borrower/applications/${appId}/complete-fields`, bTok, body);
      const unlocked = await bSet({ arv: HUGE_MONEY });
      eq(unlocked.status, 400, 'the BORROWER completeness panel refuses it too (unregistered file)');
      assert(noRawPg(unlocked), '…without showing a borrower the database driver\'s words');
      const okB = await bSet({ arv: 940000 });
      eq(okB.status, 200, 'an ordinary ARV from the borrower still saves');
    }

    /* ================================================================ *
     * F2 — a refusal is the answer, not a field to skip.
     * ================================================================ */
    console.log('\n--- F2: the borrower is never told "ok" when nothing was filed ---');
    {
      const appId = await newFile();
      await register(appId);                       // registered ⇒ economics are change-requested

      const locked = await call('POST', `/api/borrower/applications/${appId}/complete-fields`, bTok, { arv: HUGE_MONEY });
      assert(locked.status !== 200, 'an unstorable value on a LOCKED file is not answered 200');
      eq(locked.status, 400, '…it is refused, with a reason');
      assert(saysLimit(locked), '…that quotes the limit');
      const pend = await db.query(
        `SELECT 1 FROM change_requests WHERE application_id=$1 AND field='arv' AND status='pending'`, [appId]);
      eq(pend.rows.length, 0, '…and no request was filed (there was nothing fileable)');

      /* THE CASES THAT ACTUALLY REACH THE SWALLOW. The oversized ARV above is
         now stopped by the money bound BEFORE the locked branch, so on its own
         it proves nothing about the catch — mutating the catch back left every
         assertion above still passing, which is precisely the "a test that
         survives its subject being removed" trap this round exists to close.
         These two do reach it, one per target table. */
      const badProgram = await call('POST', `/api/borrower/applications/${appId}/complete-fields`, bTok,
        { program: 'Not A Real Program' });
      eq(badProgram.status, 400, 'a governed value openRequest refuses is REPORTED, not swallowed');
      assert(/must be one of/i.test(String(badProgram.body && badProgram.body.error)),
        '…saying what the options are');

      const badFico = await call('POST', `/api/borrower/applications/${appId}/complete-fields`, bTok,
        { fico: 'not-a-score' });
      eq(badFico.status, 400, 'and the same on a PERSONAL field (the borrowers-row path)');
      assert(/value we can use|required/i.test(String(badFico.body && badFico.body.error)),
        '…in words the borrower can act on');

      /* NOTHING IS FILED WHEN ANY FIELD IS BAD. A post carrying a good ARV and a
         bad credit score used to file the ARV and then answer 400 — a real
         pending request the borrower was told had failed, with the loan team
         never notified because that runs at the very end. */
      const beforeN = (await db.query(
        `SELECT count(*)::int n FROM change_requests WHERE application_id=$1 AND status='pending'`, [appId])).rows[0].n;
      const mixed = await call('POST', `/api/borrower/applications/${appId}/complete-fields`, bTok,
        { arv: 1300000, fico: '250' });
      eq(mixed.status, 400, 'a post with one bad field is refused');
      const afterN = (await db.query(
        `SELECT count(*)::int n FROM change_requests WHERE application_id=$1 AND status='pending'`, [appId])).rows[0].n;
      eq(afterN, beforeN, '…and NOTHING was filed — not even the field that was fine');

      /* The control. The swallow existed for a REASON — one bad field must not
         sink the rest of the save — so a legitimate change request must still
         be filed and still come back as one. */
      const good = await call('POST', `/api/borrower/applications/${appId}/complete-fields`, bTok, { arv: 975000 });
      eq(good.status, 200, 'a legitimate economics change on a locked file still succeeds');
      assert(!!(good.body && good.body.locked), '…still reported as locked');
      const filed = await db.query(
        `SELECT new_value FROM change_requests WHERE application_id=$1 AND field='arv' AND status='pending'`, [appId]);
      eq(filed.rows.length, 1, '…and it really was filed as a pending request');
    }

    /* ================================================================ *
     * F3 — the appraisal finding's custom reprice.
     * ================================================================ */
    console.log('\n--- F3: a reprice writes the number on the screen, or refuses ---');
    {
      const appId = await newFile();
      const apprId = (await db.query(
        `INSERT INTO appraisals (application_id) VALUES ($1) RETURNING id`, [appId])).rows[0].id;
      const finding = async (field, appraisalValue) => (await db.query(
        `INSERT INTO appraisal_findings (appraisal_id, application_id, code, severity, field, appraisal_value, status)
         VALUES ($1,$2,$3,'warning',$4,$5,'open') RETURNING id`,
        [apprId, appId, `bounds_${field}_${Math.random().toString(36).slice(2, 8)}`, field, appraisalValue])).rows[0].id;
      const resolve = (fid, body) => call('POST', `/api/appraisal/${appId}/findings/${fid}/resolve`, sTok, body);

      const bigArv = await resolve(await finding('arv', '900000'), { action: 'custom', value: HUGE_MONEY });
      eq(bigArv.status, 400, 'an oversized custom ARV is refused');
      assert(noRawPg(bigArv), '…in our words');

      const bigUnits = await resolve(await finding('units', '3'), { action: 'custom', value: '99999999999' });
      eq(bigUnits.status, 400, 'a unit count past int4 is refused');

      /* THE SILENT ONE. This did not fail — it SUCCEEDED, storing a different
         number than the one typed, on a pricing input. That is worse than a
         500, because nothing tells anybody it happened. */
      const sciUnits = await resolve(await finding('units', '3'), { action: 'custom', value: '1e10' });
      eq(sciUnits.status, 400, '"1e10" in a units box is refused, not reinterpreted');
      const after = (await db.query(`SELECT units FROM applications WHERE id=$1`, [appId])).rows[0];
      assert(Number(after.units) !== 110, `…and 110 units was NOT written to the file (units=${after.units})`);

      const dashUnits = await resolve(await finding('units', '3'), { action: 'custom', value: '2-4' });
      eq(dashUnits.status, 400, '"2-4" — the property-type spelling — is refused, not stored as 24');

      /* …and the door still WORKS. `replace` carries OUR OWN extracted string
         ("3 units"), which has always been stripped to 3 and must keep being. */
      const rep = await resolve(await finding('units', '3 units'), { action: 'replace' });
      eq(rep.status, 200, 'accepting the appraisal\'s own "3 units" still works');
      const u = (await db.query(`SELECT units FROM applications WHERE id=$1`, [appId])).rows[0];
      eq(Number(u.units), 3, '…and stores 3');

      const custOk = await resolve(await finding('arv', '900000'), { action: 'custom', value: '925,000' });
      eq(custOk.status, 200, 'an ordinary typed ARV still applies');
      const a2 = (await db.query(`SELECT arv FROM applications WHERE id=$1`, [appId])).rows[0];
      eq(Number(a2.arv), 925000, '…and lands on the file');
    }

    /* ================================================================ *
     * F4 — the info-condition door's NUMBER axis.
     * ================================================================ */
    console.log('\n--- F4: a borrower never sees the database driver\'s words ---');
    {
      /* UNREGISTERED on purpose. On a registered file `openRequest` answers
         instead — which is bounded, and is what the previous suite measured —
         so the live-write path this fixes was never exercised. */
      const appId = await newFile();
      const borrowerSays = async (fieldKey, value) => {
        const c = await call('POST', `/api/staff/applications/${appId}/conditions/custom`, sTok, {
          conditionType: 'info_field', fieldKey, label: `Confirm ${fieldKey}`, audience: 'borrower',
        });
        const itemId = c.body && c.body.itemId;
        if (!itemId) return { status: `no-condition(${c.status})`, body: null };
        return call('POST', `/api/borrower/applications/${appId}/checklist/${itemId}/info`, bTok, { value });
      };

      const payoff = await borrowerSays('payoff_amount', HUGE_MONEY);
      eq(payoff.status, 400, 'an unstorable payoff amount is refused');
      assert(noRawPg(payoff), '…never as "numeric field overflow"');
      assert(saysLimit(payoff), '…and the message quotes the limit');

      const units = await borrowerSays('units', '1e10');
      eq(units.status, 400, 'a unit count past int4 is refused');
      assert(noRawPg(units), '…never as `value "10000000000" is out of range for type integer`');

      const loan = await borrowerSays('loan_amount', HUGE_MONEY);
      eq(loan.status, 400, 'the same holds for the loan amount');
      assert(noRawPg(loan), '…in our words');

      // The control: an ordinary answer still writes through.
      const fine = await borrowerSays('payoff_amount', '125000');
      eq(fine.status, 200, 'an ordinary payoff amount still saves');
      const pf = (await db.query(`SELECT payoff_amount FROM applications WHERE id=$1`, [appId])).rows[0];
      eq(Number(pf.payoff_amount), 125000, '…and lands on the file');
    }

    /* ================================================================ *
     * F5 — the public intake door must never lose a lead.
     * ================================================================ */
    console.log('\n--- F5: the derived assignment price cannot strand a lead ---');
    {
      const r = await call('POST', '/api/intake', null, {
        email: `bounds-intake-${sfx}@test.local`, firstName: 'Derived', lastName: 'Sum',
        propertyAddress: ADDR, isAssignment: true,
        underlyingContractPrice: 900000000000, assignmentFee: 900000000000,
      });
      eq(r.status, 201, 'the lead is captured even though the two parts sum past the column');
      const appId = r.body && r.body.applicationId;
      assert(!!appId, '…and an application really exists');
      if (appId) {
        const row = (await db.query(
          `SELECT purchase_price, underlying_contract_price, assignment_fee FROM applications WHERE id=$1`, [appId])).rows[0];
        eq(row.purchase_price, null, '…with the unstorable derived price dropped');
        eq(Number(row.underlying_contract_price), 900000000000, '…while the part that DOES fit is kept');
        eq(Number(row.assignment_fee), 900000000000, '…both of them');
      }

      // The control: an ordinary assignment still derives its price.
      const ok = await call('POST', '/api/intake', null, {
        email: `bounds-intake2-${sfx}@test.local`, firstName: 'Ordinary', lastName: 'Assign',
        propertyAddress: ADDR, isAssignment: true,
        underlyingContractPrice: 100000, assignmentFee: 20000,
      });
      eq(ok.status, 201, 'an ordinary assignment intake still succeeds');
      const okRow = (await db.query(`SELECT purchase_price FROM applications WHERE id=$1`,
        [ok.body && ok.body.applicationId])).rows[0];
      eq(Number(okRow.purchase_price), 120000, '…and still stores contract + fee');
    }

    /* ================================================================ *
     * R3 — a NUL byte, one column type over.
     * ================================================================ */
    console.log('\n--- R3: a NUL byte in a draft is stripped, not 500 ---');
    {
      const NUL = String.fromCharCode(0);
      const created = await call('POST', '/api/borrower/drafts', bTok,
        { data: { payoffLender: `AB${NUL}C`, nested: { note: `x${NUL}y` } }, step: 1 });
      eq(created.status, 201, 'a draft carrying a NUL byte saves');
      const draftId = created.body && created.body.id;
      if (draftId) {
        const got = await call('GET', `/api/borrower/drafts/${draftId}`, bTok);
        eq(got.body && got.body.data && got.body.data.payoffLender, 'ABC', '…with the invisible character removed');
        eq(got.body && got.body.data && got.body.data.nested && got.body.data.nested.note, 'xy', '…at every depth');
        const put = await call('PUT', `/api/borrower/drafts/${draftId}`, bTok, { data: { more: `p${NUL}q` } });
        eq(put.status, 200, 'the autosave takes one too');
      }

      /* THE TRAP THIS FIX HAD TO AVOID: a string containing the literal
         characters backslash-u-0000 must survive intact. The obvious one-line
         fix (stripping the escape out of the SERIALIZED json) eats a backslash
         and produces malformed JSON. */
      const literal = await call('POST', '/api/borrower/drafts', bTok, { data: { s: 'a\\u0000b' }, step: 1 });
      eq(literal.status, 201, 'a draft whose text merely SPELLS the escape still saves');
      const lid = literal.body && literal.body.id;
      if (lid) {
        const back = await call('GET', `/api/borrower/drafts/${lid}`, bTok);
        eq(back.body && back.body.data && back.body.data.s, 'a\\u0000b', '…unchanged, character for character');
      }
    }

    /* ================================================================ *
     * R5 — the ALTA attachment must be the CURRENT copy.
     * ================================================================ */
    console.log('\n--- R5: a superseded document cannot be cited as the evidence ---');
    {
      const appId = await newFile();
      const mkDoc = async (isCurrent) => (await db.query(
        `INSERT INTO documents (application_id, filename, content_type, storage_provider, storage_ref, is_current)
         VALUES ($1,'alta.pdf','application/pdf','local','x/y',$2) RETURNING id`, [appId, isCurrent])).rows[0].id;
      const post = (body) => call('POST', `/api/staff/applications/${appId}/closing/cash-to-close`, sTok, body);

      // `actualCashToClose` is the key the route reads — posting `amount` left the
      // money half of this door untested (pre-merge audit nit).
      const stale = await post({ actualCashToClose: 50000, docId: await mkDoc(false) });
      eq(stale.status, 400, 'a SUPERSEDED document is refused as the cash-to-close evidence');

      const current = await post({ actualCashToClose: 50000, docId: await mkDoc(true) });
      eq(current.status, 200, '…while the current copy is accepted');
      const saved = (await db.query(
        `SELECT actual_cash_to_close FROM closing_workflow WHERE application_id=$1`, [appId])).rows[0];
      eq(Number(saved && saved.actual_cash_to_close), 50000, '…and the FIGURE really was recorded');
      const big = await post({ actualCashToClose: 1e17 });
      eq(big.status, 400, 'an unstorable cash-to-close figure is refused');
    }

    /* ================================================================ *
     * THE PRE-MERGE AUDIT'S OWN FINDINGS (2026-08-02) — the five things the
     * first cut of this round got wrong or left open.
     * ================================================================ */
    console.log('\n--- P1: a reprice can never store a NEGATIVE unit count ---');
    {
      /* A REGRESSION THIS ROUND INTRODUCED. The `\D` strip it replaced silently
         deleted a minus, so "-3" used to store 3; the tightened regex admits the
         sign, and `applications.units` has no CHECK to catch it. */
      const appId = await newFile();
      const apprId = (await db.query(`INSERT INTO appraisals (application_id) VALUES ($1) RETURNING id`, [appId])).rows[0].id;
      const finding = async () => (await db.query(
        `INSERT INTO appraisal_findings (appraisal_id, application_id, code, severity, field, appraisal_value, status)
         VALUES ($1,$2,$3,'warning','units','3','open') RETURNING id`,
        [apprId, appId, `neg_${Math.random().toString(36).slice(2, 8)}`])).rows[0].id;
      const resolve = (fid, v) => call('POST', `/api/appraisal/${appId}/findings/${fid}/resolve`, sTok, { action: 'custom', value: v });

      const neg = await resolve(await finding(), '-3');
      eq(neg.status, 400, 'a negative unit count is refused');
      const u = (await db.query(`SELECT units FROM applications WHERE id=$1`, [appId])).rows[0];
      assert(Number(u.units) > 0, `…and the file still has a real unit count (units=${u.units})`);
      eq((await resolve(await finding(), '0')).status, 400, 'zero units is refused too');
      eq((await resolve(await finding(), '3')).status, 200, '…while an ordinary count still applies');
    }

    console.log('\n--- P2: the MISMO import bounds the money that bypasses num() ---');
    {
      /* `assignmentFields` PARSES but does not BOUND, and its three outputs are
         bound to the INSERT directly — so the ceilings added to num/int/pct
         never touched purchase_price / underlying / fee, and the door still
         answered 500 and lost the whole import. */
      /* THROUGH THE REAL IMPORT, not a re-implementation of its rule in the test.
         The first version of this case computed the drop itself, so mutating the
         import changed nothing and it proved exactly nothing — the same trap the
         F2 case fell into. `createFromParsed` is the function the route calls. */
      const mismo = require('../src/lib/mismo');
      const parsed = (over) => ({
        borrower: { firstName: 'Mismo', lastName: 'Bounds', email: `mismo-${Math.random().toString(36).slice(2, 8)}-${sfx}@test.local` },
        loan: { loanType: 'Purchase' },
        property: { address: { line1: '3 Import Way', city: 'Lakewood', state: 'NJ', zip: '08701' }, ...over.property },
        extras: { isAssignment: true, ...over.extras },
      });

      let threw = null, appId = null;
      try {
        const out = await mismo.createFromParsed(parsed({
          extras: { isAssignment: true, underlyingContractPrice: 900000000000, assignmentFee: 900000000000 },
        }));
        appId = out && (out.applicationId || out.id);
      } catch (e) { threw = e.code || e.message || String(e); }
      eq(threw, null, 'an assignment whose parts SUM past the column still imports');
      assert(!!appId, '…and a real file exists');
      if (appId) {
        const row = (await db.query(
          `SELECT purchase_price, underlying_contract_price FROM applications WHERE id=$1`, [appId])).rows[0];
        eq(row.purchase_price, null, '…with the unstorable derived price dropped');
        eq(Number(row.underlying_contract_price), 900000000000, '…and the storable part kept');
      }

      // The control: an ordinary assignment import still derives its price.
      const ok = await mismo.createFromParsed(parsed({
        extras: { isAssignment: true, underlyingContractPrice: 100000, assignmentFee: 20000 },
      }));
      const okRow = (await db.query(`SELECT purchase_price FROM applications WHERE id=$1`,
        [ok.applicationId || ok.id])).rows[0];
      eq(Number(okRow.purchase_price), 120000, 'an ordinary assignment import still stores contract + fee');
    }

    console.log('\n--- P3: borrowers columns that are neither money nor a percent ---');
    {
      /* numeric(12,2) and numeric(4,1). The first cut of the column table could
         not express these at all, so both profile doors still answered 500. */
      const staffSet = (body) => call('PATCH', `/api/staff/borrowers/${borrowerId}`, sTok, body);
      const bSet = (body) => call('PUT', '/api/borrower/profile', bTok, body);

      const sBig = await staffSet({ housingPayment: 1e14 });
      eq(sBig.status, 400, 'the staff profile door refuses an unstorable housing payment');
      assert(noRawPg(sBig), '…in our words');
      eq((await staffSet({ housingPayment: 3200 })).status, 200, '…while an ordinary one still saves');

      const bBig = await bSet({ housingPayment: 1e14 });
      eq(bBig.status, 400, 'and so does the borrower profile door');
      const bYears = await bSet({ yearsAtResidence: 99999 });
      eq(bYears.status, 400, 'an impossible time-at-residence is refused (it used to be a date out of range)');
      eq((await bSet({ housingPayment: 2400, yearsAtResidence: 3 })).status, 200,
        '…while ordinary values still save');
      const hp = (await db.query(`SELECT housing_payment, years_at_residence FROM borrowers WHERE id=$1`, [borrowerId])).rows[0];
      eq(Number(hp.housing_payment), 2400, '…and land on the profile');
      eq(Number(hp.years_at_residence), 3, '…both of them');

      /* A CLEARED field is a legitimate "no value", not a bad number. The first
         cut of this sweep handed null to the checker as NaN and turned every
         CLEAR into "must be a number" — caught by test-borrower-fields-db's own
         clearing case, which is why this one is pinned here too. */
      eq((await bSet({ housingPayment: '' })).status, 200, 'and a field can still be CLEARED');
      const cleared = (await db.query(`SELECT housing_payment FROM borrowers WHERE id=$1`, [borrowerId])).rows[0];
      eq(cleared.housing_payment, null, '…really cleared, not zeroed');
      eq((await staffSet({ fico: '' })).status, 200, '…and from the staff door too');
    }

    console.log('\n--- P4: a program the borrower is OFFERED is a program we accept ---');
    {
      /* The panel offers DSCR / Rental; the server's governed enum did not carry
         it. Before this round the refusal was swallowed and the panel said "that
         already matches what we have on file" — a lie. Offering a choice and then
         refusing it is the bug. */
      const appId = await newFile();
      await register(appId);
      const r = await call('POST', `/api/borrower/applications/${appId}/complete-fields`, bTok, { program: 'DSCR / Rental' });
      eq(r.status, 200, 'the borrower can request the program their own screen offers');
      const filed = await db.query(
        `SELECT new_value FROM change_requests WHERE application_id=$1 AND field='program' AND status='pending'`, [appId]);
      eq(filed.rows.length, 1, '…and it is filed as a real pending request');
      eq(filed.rows[0].new_value, 'DSCR / Rental', '…with the value they picked');

      const junk = await call('POST', `/api/borrower/applications/${appId}/complete-fields`, bTok, { program: 'Not A Real Program' });
      eq(junk.status, 400, '…while a value no screen offers is still refused');
    }

    console.log('\n--- P5: a NUL byte on the profile doors, not just the drafts ---');
    {
      const NUL = String.fromCharCode(0);
      const sAddr = await call('PATCH', `/api/staff/borrowers/${borrowerId}`, sTok,
        { currentAddress: { line1: `1 A${NUL}St`, city: 'Lakewood', state: 'NJ', zip: '08701' } });
      eq(sAddr.status, 200, 'the staff profile door takes an address carrying a NUL');
      const bAddr = await call('PUT', '/api/borrower/profile', bTok,
        { currentAddress: { line1: `2 B${NUL}St`, city: 'Lakewood', state: 'NJ', zip: '08701' } });
      eq(bAddr.status, 200, 'and so does the borrower profile door');
      const row = (await db.query(`SELECT current_address FROM borrowers WHERE id=$1`, [borrowerId])).rows[0];
      eq(row.current_address && row.current_address.line1, '2 BSt', '…with the invisible character removed');
    }

    console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL column-bounds door assertions passed');
  } catch (e) {
    console.error('SUITE ERROR', e);
    failures++;
  } finally {
    if (server) server.close();
    try { await db.pool.end(); } catch (_) {}
  }
  process.exit(failures ? 1 : 0);
})();
