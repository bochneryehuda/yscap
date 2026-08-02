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
        /* A type with no kind DEFINED is skipped (bigint/smallint/float have no
           ceiling in the table today — `applications.clickup_folder_id` and
           `borrower_gross_annual_revenue_cents` are the live examples). What the
           widened filter really buys is the `seen` set: a legitimate COLUMN_KIND
           entry on such a column no longer reads as "not a numeric column".
           Widening it is a no-op on today's schema — said plainly here because
           the previous comment overstated it (fourth audit, 2026-08-02). */
        if (t !== 'numeric') return null;                 // bigint/smallint/float: no ceiling defined
        if (p == null) return null;                       // bare numeric: no ceiling to enforce
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
              AND data_type IN ('numeric','integer','smallint','bigint','double precision','real')`, [table])).rows;
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

      /* THE DERIVED YEARS-AT-RESIDENCE. `parse.js` computes it from the MISMO
         residency-MONTHS count, so a months value the file itself carries can
         produce a years value numeric(4,1) cannot hold — and the whole import
         was lost to a 500. Same class as the assignment sum and residence_since. */
      let yThrew = null, yApp = null;
      try {
        const out = await mismo.createFromParsed(Object.assign(parsed({}), {
          borrower: { firstName: 'Mismo', lastName: 'Years', email: `mismo-y-${sfx}@test.local`, yearsAtResidence: 8333.3 },
        }));
        yApp = out && (out.applicationId || out.id);
      } catch (e) { yThrew = e.code || e.message || String(e); }
      eq(yThrew, null, 'an out-of-range years-at-residence no longer loses the whole import');
      assert(!!yApp, '…and the file exists');
      const yRow = (await db.query(
        `SELECT years_at_residence FROM borrowers WHERE email=$1`, [`mismo-y-${sfx}@test.local`])).rows[0];
      eq(yRow && yRow.years_at_residence, null, '…with only the unstorable figure dropped');

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

    /* ================================================================ *
     * THE RE-AUDIT'S FINDINGS (2026-08-02) — what the FIX round left open.
     * ================================================================ */
    console.log('\n--- Q1: a count that cannot be a move-in date ---');
    {
      /* THE BLOCKER. `months_at_residence` is int4, so 99999 fits its column
         perfectly — it is the DERIVED move-in date that Postgres cannot store,
         which the column sweep structurally cannot see. The fix round closed the
         YEARS axis and left the MONTHS one open, on the same two doors, and 99999
         months is the more plausible fat-finger of the two. */
      const R = require('../src/lib/residence');
      eq(R.moveInFrom(0, 99999), null, 'moveInFrom refuses to build a date it cannot make');
      eq(R.moveInFrom(0, 2000000000), null, '…and never returns an Invalid Date');
      assert(R.moveInFrom(2, 3) instanceof Date, '…while an ordinary duration still anchors');
      eq(R.residenceCountProblem(0, 5), '', 'five months is a fine duration');
      assert(R.residenceCountProblem(0, 99999) !== '', '…99999 months is not');
      assert(R.residenceCountProblem(9999, 0) !== '', '…and neither is 9999 years');

      const bSet = (body) => call('PUT', '/api/borrower/profile', bTok, body);
      const staffSet = (body) => call('PATCH', `/api/staff/borrowers/${borrowerId}`, sTok, body);
      for (const [label, door] of [['borrower', bSet], ['staff', staffSet]]) {
        for (const m of [99999, 100000000, 2000000000]) {
          const r = await door({ monthsAtResidence: m });
          eq(r.status, 400, `${label}: monthsAtResidence ${m} is refused, not a 500`);
          assert(noRawPg(r), `${label}: …in our words, not the driver's`);
        }
        eq((await door({ yearsAtResidence: 2, monthsAtResidence: 3 })).status, 200,
          `${label}: an ordinary time at this address still saves`);
      }
      const anchored = (await db.query(
        `SELECT years_at_residence, months_at_residence, residence_since FROM borrowers WHERE id=$1`, [borrowerId])).rows[0];
      eq(Number(anchored.years_at_residence), 2, '…and is stored');
      assert(!!anchored.residence_since, '…with a real move-in date anchored from it');
    }

    console.log('\n--- Q2: the PUBLIC lead door cannot lose a lead to a NUL byte ---');
    {
      const NUL = String.fromCharCode(0);
      const post = (body) => call('POST', '/api/leads', null, body);
      const clean = await post({ tool: 'loan_application', name: `Clean ${sfx}`, email: `lead-a-${sfx}@test.local`, payload: { v: { note: 'clean' } } });
      eq(clean.status, 201, 'an ordinary lead is captured');
      const nul = await post({ tool: 'loan_application', name: `Nul ${sfx}`, email: `lead-b-${sfx}@test.local`, payload: { v: { note: `a${NUL}b` } } });
      eq(nul.status, 201, 'a lead carrying a NUL byte is ALSO captured (it used to 500 and be lost)');
      const nulKey = await post({ tool: 'loan_application', name: `NulKey ${sfx}`, email: `lead-c-${sfx}@test.local`, payload: { [`k${NUL}`]: 1 } });
      eq(nulKey.status, 201, '…including one in a KEY');
      const rows = await db.query(`SELECT payload FROM leads WHERE email=$1`, [`lead-b-${sfx}@test.local`]);
      eq(rows.rows.length, 1, '…and it really is stored');
      eq(rows.rows[0].payload && rows.rows[0].payload.v && rows.rows[0].payload.v.note, 'ab',
        '…with the invisible character removed');
    }

    console.log('\n--- Q3: the pre-pass never refuses work the writer would have done ---');
    {
      /* A pre-check STRICTER than the door it guards is its own bug. The writer
         has always IGNORED a money value with no digits in it ("TBD"), so
         refusing it made a registered file behave differently from an
         unregistered one for identical input. */
      const appId = await newFile();
      await register(appId);
      /* The pre-pass and the writer must give the SAME answer. That answer used
         to be "pass it over" — a 200 with nothing saved. It is a refusal now
         (see T6): silently ignoring a money box the borrower typed into is the
         "returned 200 but didn't save" class, and reinterpreting it is worse. */
      const r = await call('POST', `/api/borrower/applications/${appId}/complete-fields`, bTok,
        { purchase_price: 'TBD', arv: 725000 });
      eq(r.status, 400, 'a junk money value is refused, not passed over');
      const filed = await db.query(
        `SELECT field FROM change_requests WHERE application_id=$1 AND status='pending' ORDER BY field`, [appId]);
      eq(filed.rows.length, 0, '…and nothing was filed — not even the field that was fine');
      const good = await call('POST', `/api/borrower/applications/${appId}/complete-fields`, bTok, { arv: 725000 });
      eq(good.status, 200, '…while the same good field on its own is filed');

      // …and the two paths agree, which is the property that actually matters.
      const open = await newFile();
      const unlocked = await call('POST', `/api/borrower/applications/${open}/complete-fields`, bTok,
        { purchase_price: 'TBD', arv: 725000 });
      eq(unlocked.status, r.status, 'a registered and an unregistered file answer the same way');
    }

    console.log('\n--- Q4: a bad credit score is refused, never written as a blank ---');
    {
      /* `sanitizeFico` answers null for BOTH "cleared" and "that is not a score",
         and this door wrote the null either way — so junk came back 200 {ok:true}
         and ERASED a score the file already had. */
      /* A FRESH borrower with no registered file — once ANY of a borrower's files
         is accepted, a personal edit becomes a change request instead of a live
         write, and this is about the LIVE write path. */
      const freshId = (await db.query(
        `INSERT INTO borrowers (email,first_name,last_name) VALUES ($1,'Fresh','Score') RETURNING id`,
        [`bounds-fico-${sfx}@test.local`])).rows[0].id;
      await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,'x',0) ON CONFLICT DO NOTHING`, [freshId]);
      const fTok = C.signJwt({ sub: freshId, kind: 'borrower', tv: 0 });
      const bSet = (body) => call('PUT', '/api/borrower/profile', fTok, body);
      const ficoNow = async () => (await db.query(`SELECT fico FROM borrowers WHERE id=$1`, [freshId])).rows[0].fico;

      eq((await bSet({ fico: 740 })).status, 200, 'a real score saves');
      eq(Number(await ficoNow()), 740, '…and is stored');
      const junk = await bSet({ fico: 'abc' });
      eq(junk.status, 400, 'junk is REFUSED');
      eq(Number(await ficoNow()), 740, '…and the score already on file is UNTOUCHED');
      eq((await bSet({ fico: 1e12 })).status, 400, 'an absurd score is refused too');
      eq(Number(await ficoNow()), 740, '…still untouched');
      eq((await bSet({ fico: '' })).status, 200, '…while an explicit blank still CLEARS it');
      eq(await ficoNow(), null, '…really cleared');
    }

    console.log('\n--- Q5: the pre-check agrees with the writer on every axis ---');
    {
      const CR = require('../src/lib/change-requests');
      // LOOSER than the writer re-opens the hole the pre-pass exists to close.
      assert(CR.proposalProblem('fico', '720', {}) !== '',
        'a personal field with no target borrower is refused, exactly as openBorrowerRequest refuses it');
      eq(CR.proposalProblem('fico', '720', { targetBorrowerId: borrowerId }), '',
        '…and accepted once there is one');
    }

    /* ================================================================ *
     * THE THIRD AUDIT'S FINDINGS (2026-08-02).
     * ================================================================ */
    console.log('\n--- T1: a NUL byte cannot reach ANY column, on any door ---');
    {
      const NUL = String.fromCharCode(0);
      /* The class was fixed three times — textColumn, then jsonbText on 4 of ~17
         binds, then the rest — and each fix was a LIST. The public lead door was
         still 500-ing on the visitor's own name box, and the public intake door
         lost a whole application on `firstName`, because those are plain TEXT
         columns. It is now stripped once, at the request boundary. */
      const lead = (over) => call('POST', '/api/leads', null, Object.assign(
        { tool: 'contact', name: `Lead ${sfx}`, email: `nul-${Math.random().toString(36).slice(2, 8)}-${sfx}@test.local` }, over));
      for (const [field, body] of [
        ['name', { name: `Bo${NUL}b` }], ['phone', { phone: `55${NUL}5` }],
        ['subject', { subject: `s${NUL}u` }], ['message', { message: `hi${NUL}there` }],
        ['payload', { payload: { v: `a${NUL}b` } }],
      ]) {
        const r = await lead(body);
        eq(r.status, 201, `the public lead door survives a NUL in ${field}`);
      }
      const stored = await db.query(`SELECT name FROM leads WHERE name LIKE 'Bob'`);
      assert(stored.rows.length > 0, '…and the cleaned value is what was stored');

      const intake = await call('POST', '/api/intake', null, {
        email: `nul-intake-${sfx}@test.local`, firstName: `Jo${NUL}e`, lastName: 'Nul',
        propertyAddress: ADDR,
      });
      eq(intake.status, 201, 'the public intake door survives a NUL in firstName');
      const b = await db.query(`SELECT first_name FROM borrowers WHERE email=$1`, [`nul-intake-${sfx}@test.local`]);
      eq(b.rows[0] && b.rows[0].first_name, 'Joe', '…with the invisible character removed');

      for (const [door, method, path, tok] of [
        ['borrower profile', 'PUT', '/api/borrower/profile', bTok],
        ['staff profile', 'PATCH', `/api/staff/borrowers/${borrowerId}`, sTok],
      ]) {
        const r = await call(method, path, tok, { citizenship: `US${NUL}A` });
        eq(r.status, 200, `${door}: a NUL in a plain TEXT field no longer 500s`);
      }

      // The middleware itself: bounded, never throws, leaves real values alone.
      const N = require('../src/lib/nul-strip');
      eq(N.stripNulBody({ a: `x${NUL}y` }).a, 'xy', 'the stripper removes a NUL from a value');
      eq(Object.keys(N.stripNulBody({ [`k${NUL}`]: 1 }))[0], 'k', '…and from a KEY');
      eq(N.stripNulBody({ s: 'a\\u0000b' }).s, 'a\\u0000b', '…while text that merely SPELLS it survives');
      assert(N.stripNulBody({ d: new Date(0) }).d instanceof Date, '…a Date is left as a Date');
      eq(N.stripNulBody(null), null, '…a null body never throws');
      let deep = { s: `a${NUL}` }; for (let i = 0; i < 200; i++) deep = { deep };
      assert(!!N.stripNulBody(deep), '…and a body deeper than the cap returns rather than blowing the stack');
    }

    console.log('\n--- T2: a derived value that cannot be stored, on the two doors that swallow ---');
    {
      /* Same class as `residence_since` and the assignment sum: the INPUT fits
         its column and the DERIVED value does not. Here it is worse than a 500 —
         the caller swallows, so the whole update vanished behind a 201. */
      const freshId = (await db.query(
        `INSERT INTO borrowers (email,first_name,last_name) VALUES ($1,'Draft','Sync') RETURNING id`,
        [`draft-sync-${sfx}@test.local`])).rows[0].id;
      await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,'x',0) ON CONFLICT DO NOTHING`, [freshId]);
      const dTok = C.signJwt({ sub: freshId, kind: 'borrower', tv: 0 });
      const draft = await call('POST', '/api/borrower/drafts', dTok, { data: {}, step: 1 });
      const did = draft.body && draft.body.id;
      assert(!!did, 'a draft exists to submit');
      if (did) {
        const sub = await call('POST', `/api/borrower/drafts/${did}/submit`, dTok, {
          propertyAddress: ADDR, program: 'Bridge', loanType: 'Purchase',
          personal: { yearsAtResidence: 99999, citizenship: 'US Citizen' },
        });
        assert(sub.status === 201 || sub.status === 200, 'the submit succeeds');
        const row = (await db.query(
          `SELECT citizenship, years_at_residence FROM borrowers WHERE id=$1`, [freshId])).rows[0];
        eq(row.citizenship, 'US Citizen', '…and the REST of the profile really saved (it used to be lost whole)');
        eq(row.years_at_residence, null, '…with only the unstorable figure dropped');
      }
    }

    console.log('\n--- T3: the >100-year rule cannot brick a profile it did not cause ---');
    {
      /* Every client resends the whole form on every save, so refusing an
         UNCHANGED out-of-range value made editing a phone number impossible on
         any row whose anchor predates the rule. */
      /* THE ANCHOR IS THE POINT. The first version of this case inserted the row
         with `residence_since` NULL, so `withLiveResidence` never fired, the
         client echoed the stored columns verbatim, and the case passed without
         ever exercising its subject — the fourth audit proved the brick was
         still live behind it. A real legacy row HAS an anchor, and the GET door
         recomputes the duration from it. */
      const oldId = (await db.query(
        `INSERT INTO borrowers (email,first_name,last_name,years_at_residence,months_at_residence,residence_since)
         VALUES ($1,'Legacy','Anchor',120,0, (now() - interval '1520 months')::date) RETURNING id`,
        [`legacy-anchor-${sfx}@test.local`])).rows[0].id;
      await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,'x',0) ON CONFLICT DO NOTHING`, [oldId]);
      const oTok = C.signJwt({ sub: oldId, kind: 'borrower', tv: 0 });
      /* Echo back exactly what the GET door SHOWS — which is the live duration
         from the anchor, not the stored columns. That is what every client does. */
      const shown = await call('GET', '/api/borrower/profile', oTok);
      const sy = shown.body && shown.body.years_at_residence;
      const sm = shown.body && shown.body.months_at_residence;
      assert(Number(sy) > 100, `the GET door really does show a >100-year duration (${sy}y ${sm}m)`);
      const resave = await call('PUT', '/api/borrower/profile', oTok,
        { cellPhone: '555-0100', yearsAtResidence: sy, monthsAtResidence: sm });
      eq(resave.status, 200, 'resending an UNCHANGED legacy duration still saves');
      eq((await db.query(`SELECT cell_phone FROM borrowers WHERE id=$1`, [oldId])).rows[0].cell_phone, '555-0100',
        '…and the field they actually edited landed');
      const changed = await call('PUT', '/api/borrower/profile', oTok, { yearsAtResidence: 300 });
      eq(changed.status, 400, '…while genuinely CHANGING it to an impossible value is still refused');
    }

    console.log('\n--- T4: one column, four doors, ONE behaviour ---');
    {
      const appId = await newFile();
      const bad = { fico: 'abc' };
      const doors = [
        ['staff completeness', await call('POST', `/api/staff/applications/${appId}/complete-fields`, sTok, bad)],
        ['borrower completeness', await call('POST', `/api/borrower/applications/${appId}/complete-fields`, bTok, bad)],
      ];
      for (const [name, r] of doors) eq(r.status, 400, `${name} refuses a junk credit score (it used to answer 200 and drop it)`);
    }

    console.log('\n--- T5: a pricing input is validated on EVERY path, not just the locked one ---');
    {
      const appId = await newFile();
      const junk = await call('POST', `/api/borrower/applications/${appId}/complete-fields`, bTok, { program: 'Not A Real Program' });
      eq(junk.status, 400, 'an unregistered file refuses a program no screen offers');
      const lt = await call('POST', `/api/borrower/applications/${appId}/complete-fields`, bTok, { loan_type: 'Banana' });
      eq(lt.status, 400, '…and a made-up loan type');
      const ok = await call('POST', `/api/borrower/applications/${appId}/complete-fields`, bTok, { program: 'Bridge' });
      eq(ok.status, 200, '…while a real program still saves');
      eq((await db.query(`SELECT program FROM applications WHERE id=$1`, [appId])).rows[0].program, 'Bridge', '…and lands');
    }

    console.log('\n--- T6: the pre-pass and the writer agree on EVERY shape ---');
    {
      /* It mirrored one of the writer's skips, so a registered file refused nine
         shapes an unregistered one ignored — including a European "1.200.000". */
      const locked = await newFile(); await register(locked);
      const open = await newFile();
      for (const v of ['TBD', '1.2.3', '.', '..', '1.200.000', '1e5', '2-4']) {
        const a = await call('POST', `/api/borrower/applications/${locked}/complete-fields`, bTok, { purchase_price: v, arv: 725000 });
        const b2 = await call('POST', `/api/borrower/applications/${open}/complete-fields`, bTok, { purchase_price: v, arv: 725000 });
        eq(a.status, b2.status, `"${v}": a registered and an unregistered file answer the same way`);
        /* …AND pin what that answer IS. Asserting only that the two agree is not
           enough: they share one predicate, so a change moves both together and
           the equality holds while the behaviour is wrong.
           The answer used to be "ignore it and save the rest" — which was a 200
           with NOTHING saved on a client that posts one field at a time, and for
           "1e5"/"2-4" it was worse: the character-deleting parse SILENTLY stored
           15 and 24 on a pricing column. It is a refusal now. */
        eq(a.status, 400, `"${v}": …and that answer is a refusal, not a silent reinterpretation`);
      }
      // …and the value the money box is FOR still saves, in every real spelling.
      for (const v of ['725000', '$1,250,000.50', ' 480000 ', 725000]) {
        const r = await call('POST', `/api/borrower/applications/${open}/complete-fields`, bTok, { arv: v });
        eq(r.status, 200, `an ordinary money value ${JSON.stringify(v)} still saves`);
      }
    }

    /* ================================================================ *
     * THE FOURTH AUDIT'S FINDINGS (2026-08-02).
     * ================================================================ */
    console.log('\n--- U1: a value we OFFER is a value we accept (the whole list) ---');
    {
      /* Fixed for `DSCR / Rental` one round ago and left broken two entries down
         the same hand-copied list: `Not sure yet` is a real PROGRAMS entry that
         db/382 canonicalizes on write, and `PUD` is canonical in
         property-type.js and stores fine via PATCH /details. The list is derived
         now, so it cannot drift from its source again. */
      const appId = await newFile();
      for (const [k, v] of [['program', 'Not sure yet'], ['property_type', 'PUD']]) {
        const r = await call('POST', `/api/borrower/applications/${appId}/complete-fields`, bTok, { [k]: v });
        eq(r.status, 200, `the borrower can set ${k} = "${v}" — a value the system supports elsewhere`);
      }
      const CR = require('../src/lib/change-requests');
      const canonical = require('../src/lib/property-type').PROPERTY_TYPES.map((p) => p.label);
      const missing = canonical.filter((lbl) => !CR.FIELD_OPTIONS.property_type.includes(lbl));
      eq(missing.join(',') || '(none)', '(none)', 'every canonical property type is accepted (derived, not re-typed)');
    }

    console.log('\n--- U2: the residence guard compares what the client was SHOWN ---');
    {
      /* The self-inflicted half: exactly 100 years is ACCEPTED, and one month of
         drift later the GET door shows 100y1m — which the client echoes back. */
      const id = (await db.query(
        `INSERT INTO borrowers (email,first_name,last_name,residence_since)
         VALUES ($1,'Drift','Case',(now() - interval '1201 months')::date) RETURNING id`,
        [`drift-${sfx}@test.local`])).rows[0].id;
      await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,'x',0) ON CONFLICT DO NOTHING`, [id]);
      const t = C.signJwt({ sub: id, kind: 'borrower', tv: 0 });
      const shown = await call('GET', '/api/borrower/profile', t);
      const sy = shown.body && shown.body.years_at_residence;
      const sm = shown.body && shown.body.months_at_residence;
      const r = await call('PUT', '/api/borrower/profile', t,
        { cellPhone: '555-0123', yearsAtResidence: sy, monthsAtResidence: sm });
      eq(r.status, 200, 'a row just past the cap by DRIFT can still be saved');
      eq((await db.query(`SELECT cell_phone FROM borrowers WHERE id=$1`, [id])).rows[0].cell_phone, '555-0123',
        '…and the field they actually edited landed');
      /* The staff half of the same guard, on its OWN untouched row — the first
         version ran after the borrower PUT above had already written the columns,
         so a stored-column comparison happened to agree and the case proved
         nothing (it survived its mutation). */
      const id2 = (await db.query(
        `INSERT INTO borrowers (email,first_name,last_name,residence_since)
         VALUES ($1,'Drift','Staff',(now() - interval '1201 months')::date) RETURNING id`,
        [`drift-staff-${sfx}@test.local`])).rows[0].id;
      const shown2 = require('../src/lib/residence').withLiveResidence(
        (await db.query(`SELECT years_at_residence, months_at_residence, residence_since FROM borrowers WHERE id=$1`, [id2])).rows[0]);
      const sr = await call('PATCH', `/api/staff/borrowers/${id2}`, sTok,
        { citizenship: 'US Citizen', yearsAtResidence: shown2.years_at_residence, monthsAtResidence: shown2.months_at_residence });
      eq(sr.status, 200, 'the STAFF door behaves the same way (it had no assertion at all)');
      const bump = await call('PUT', '/api/borrower/profile', t, { yearsAtResidence: 300 });
      eq(bump.status, 400, '…while genuinely changing it to an impossible value is still refused');
    }

    console.log('\n--- U3: a cleaned key is an own property, never a prototype write ---');
    {
      const NUL = String.fromCharCode(0);
      const appId = await newFile();
      const before = (await db.query(`SELECT arv FROM applications WHERE id=$1`, [appId])).rows[0].arv;
      const r = await call('POST', `/api/staff/applications/${appId}/complete-fields`, sTok,
        JSON.parse(JSON.stringify({ [`__proto__${NUL}`]: { arv: 777777 } })));
      const after = (await db.query(`SELECT arv FROM applications WHERE id=$1`, [appId])).rows[0].arv;
      eq(String(after), String(before), 'a `__proto__` key cannot smuggle a value into a route handler');
      assert(r.status < 500, '…and the request does not 500');
      eq({}.arv, undefined, '…and Object.prototype is untouched');
    }

    console.log('\n--- U4: junk time-at-residence gets ONE answer ---');
    {
      /* A row with NO stored duration is the case that matters: both sides of the
         "did they change it?" comparison read 0, so "unchanged" won and the junk
         sailed through. A row that already holds a duration was already refused,
         which is why the first version of this case proved nothing. */
      const fresh = (await db.query(
        `INSERT INTO borrowers (email,first_name,last_name) VALUES ($1,'Junk','Res') RETURNING id`,
        [`junk-res-${sfx}@test.local`])).rows[0].id;
      await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,'x',0) ON CONFLICT DO NOTHING`, [fresh]);
      const t = C.signJwt({ sub: fresh, kind: 'borrower', tv: 0 });
      eq((await call('PUT', '/api/borrower/profile', t, { yearsAtResidence: 'abc' })).status, 400,
        'the borrower door refuses a junk duration');
      eq((await call('PATCH', `/api/staff/borrowers/${fresh}`, sTok, { yearsAtResidence: 'abc' })).status, 400,
        '…and so does the staff door (it used to answer 200 and NULL all three columns)');
      const row = (await db.query(`SELECT years_at_residence FROM borrowers WHERE id=$1`, [fresh])).rows[0];
      eq(row.years_at_residence, null, '…and nothing was written');
      eq((await call('PUT', '/api/borrower/profile', t, { yearsAtResidence: 4, monthsAtResidence: 2 })).status, 200,
        '…while a real duration still saves');
    }

    console.log('\n--- U6: the STAFF money box is not reinterpreted either ---');
    {
      /* The character-deleting parse lived on BOTH completeness panels; only the
         borrower half had an assertion, so the staff half survived its mutation. */
      const appId = await newFile();
      const before = (await db.query(`SELECT arv FROM applications WHERE id=$1`, [appId])).rows[0].arv;
      for (const v of ['1e5', '2-4', '1.2.3']) {
        const r = await call('POST', `/api/staff/applications/${appId}/complete-fields`, sTok, { arv: v });
        eq(r.status, 400, `staff completeness refuses "${v}" rather than reinterpreting it`);
      }
      const after = (await db.query(`SELECT arv FROM applications WHERE id=$1`, [appId])).rows[0].arv;
      eq(String(after), String(before), '…and the ARV on the file never moved');
      const ok = await call('POST', `/api/staff/applications/${appId}/complete-fields`, sTok, { arv: '$1,250,000.50' });
      eq(ok.status, 200, '…while a properly formatted amount still saves');
      eq(Number((await db.query(`SELECT arv FROM applications WHERE id=$1`, [appId])).rows[0].arv), 1250000.5,
        '…at full precision');
    }

    console.log('\n--- U5: the pre-pass honours the refinance skip too ---');
    {
      const refi = await newFile();
      await db.query(`UPDATE applications SET loan_type='Refinance — Cash-Out' WHERE id=$1`, [refi]);
      const open2 = await newFile();
      await db.query(`UPDATE applications SET loan_type='Refinance — Cash-Out' WHERE id=$1`, [open2]);
      await register(refi);
      const a = await call('POST', `/api/borrower/applications/${refi}/complete-fields`, bTok, { purchase_price: HUGE_MONEY });
      const b2 = await call('POST', `/api/borrower/applications/${open2}/complete-fields`, bTok, { purchase_price: HUGE_MONEY });
      eq(a.status, b2.status, 'on a REFINANCE the two paths still answer the same way');
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
