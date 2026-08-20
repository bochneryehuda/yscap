'use strict';
/**
 * CONTACTS ON FILE — pre-fill from what they used before, type-ahead over the
 * vendor directory, and EVERY address on the order (owner-directed 2026-08-20).
 *
 * The three asks, in the owner's words:
 *   · "Every borrower's profile should have all the contacts that he previously
 *      used for title and insurance on his second file … he should be able to
 *      pre-fill from his previous contacts."
 *   · "We already have a database from all the vendors that we're using across
 *      the board. Anywhere you start typing … it gives you a lot of options of
 *      the insurance companies that you can auto-populate all the information
 *      just by starting to type."
 *   · "We should be able to add additional email addresses for vendors, and all
 *      emails should be included when we send out the orders."
 *
 * THE THIRD ONE IS THE ONE WITH TEETH, and it is the reason this needs a real
 * database rather than a fixture: `service_contacts` carries BOTH a legacy scalar
 * `email` and db/224's `emails text[]`, backfilled only for the rows that existed
 * then. So live rows come in three shapes — scalar only, array only, and both —
 * and reading either column alone silently drops a real recipient. On this desk
 * that means a title company's closing@ inbox never receiving the order, with
 * nothing anywhere saying so.
 *
 * Real HTTP + real Postgres.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-vendor-directory-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const VD = require('../src/lib/vendor-directory');
const orders = require('../src/lib/orders');
const app = require('../src/server');

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

function call(server, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }); } catch (_) { resolve({ status: res.statusCode, body: null }); } }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = crypto.randomBytes(4).toString('hex');
  const clean = [];
  try {
    // =====================================================================
    console.log('\nA. every address a row carries — the column pair is the trap');
    // =====================================================================
    // The three shapes a live row can be in. Reading either column alone loses
    // addresses on two of them.
    ok(JSON.stringify(VD.allEmails({ email: 'a@x.com', emails: null })) === '["a@x.com"]',
      'SCALAR ONLY (a row written before db/224, or by a path that sets only `email`)');
    ok(JSON.stringify(VD.allEmails({ email: null, emails: ['b@x.com', 'c@x.com'] })) === '["b@x.com","c@x.com"]',
      'ARRAY ONLY — reading the scalar alone would report no contact at all');
    ok(JSON.stringify(VD.allEmails({ email: 'a@x.com', emails: ['a@x.com', 'b@x.com'] })) === '["a@x.com","b@x.com"]',
      'BOTH — the scalar is the array\'s first entry, so it must not be counted twice');
    ok(JSON.stringify(VD.allEmails({ email: 'A@X.com', emails: ['a@x.com'] })) === '["A@X.com"]',
      'a case-only duplicate collapses — one address, not two');
    ok(VD.allEmails(null).length === 0 && VD.allEmails({}).length === 0, 'a missing contact answers nothing, never throws');
    ok(JSON.stringify(VD.allEmails({ email: '  a@x.com ', emails: ['', null, ' b@x.com'] })) === '["a@x.com","b@x.com"]',
      'blanks and padding are dropped');

    // =====================================================================
    console.log('\nB. one company, one suggestion — folding');
    // =====================================================================
    // A staff-added file contact is written with the FILE'S borrower_id, so the
    // same title company genuinely exists once per deal. A raw type-ahead would
    // show forty identical rows.
    {
      const folded = VD.foldGroups([
        { id: 1, contact_type: 'title_company', company_name: 'Madison Title', email: 'a@madison.com', emails: null, phone: null, phones: null, files_used: 1 },
        { id: 2, contact_type: 'title_company', company_name: 'madison  title', email: 'closing@madison.com', emails: null, phone: '212-555-0100', phones: null, address: '1 Main St', contact_name: 'Sarah', files_used: 3 },
        { id: 3, contact_type: 'title_company', company_name: 'Somebody Else', email: 'z@else.com', emails: null, phone: null, phones: null, files_used: 1 },
      ]);
      ok(folded.length === 2, 'two spellings of one company fold into ONE suggestion; a different company stays its own');
      const mad = folded.find((f) => /madison/i.test(f.companyName || ''));
      ok(!!mad && mad.emails.length === 2 && mad.emails.includes('a@madison.com') && mad.emails.includes('closing@madison.com'),
        '…carrying EVERY address the group knows about — this is the material behind "all emails are included"');
      ok(mad.contactName === 'Sarah' && mad.address === '1 Main St',
        'the MOST COMPLETE row becomes the face, so the suggestion is the best business card the group has');
      ok(mad.usedCount === 4, '…and it says how many files it stands for, which is how you tell near-identical rows apart');
    }
    {
      // Folding by EMAIL as well as by name — the same agent under two spellings.
      const folded = VD.foldGroups([
        { id: 1, contact_type: 'insurance_agent', company_name: 'Acme Ins', email: 'agent@acme.com', emails: null, files_used: 1 },
        { id: 2, contact_type: 'insurance_agent', company_name: 'Acme Insurance Group', email: 'agent@acme.com', emails: null, files_used: 1 },
      ]);
      ok(folded.length === 1, 'two names sharing one email are one company');
    }
    {
      // A short phone fragment is NOT an identity — without the floor every row
      // carrying "911" would fold into one company.
      const folded = VD.foldGroups([
        { id: 1, contact_type: 'other', company_name: 'One', phone: '911', phones: null, files_used: 1 },
        { id: 2, contact_type: 'other', company_name: 'Two', phone: '911', phones: null, files_used: 1 },
      ]);
      ok(folded.length === 2, 'a 3-digit phone does not fold two different companies together');
    }

    // =====================================================================
    console.log('\nC. the two audiences — the boundary is on the server');
    // =====================================================================
    const staffId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Vendor Officer','admin',true,false,'x',0) RETURNING id`, [`vd-staff-${sfx}@test.local`])).rows[0].id;
    const tok = C.signJwt({ sub: staffId, kind: 'staff', role: 'admin', tv: 0 });
    const mine = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Mine','Borrower',$1) RETURNING id`, [`vd-mine-${sfx}@test.local`])).rows[0].id;
    const theirs = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Their','Borrower',$1) RETURNING id`, [`vd-theirs-${sfx}@test.local`])).rows[0].id;
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status, ys_loan_number, property_address, loan_type)
       VALUES ($1,$2,'underwriting',$3,'{"oneLine":"7 Vendor Way"}','Purchase') RETURNING id`,
      [mine, staffId, `YSCAP-VD-${sfx}`])).rows[0].id;
    clean.push(async () => {
      await db.query(`DELETE FROM application_service_contacts WHERE application_id=$1`, [appId]);
      await db.query(`DELETE FROM file_orders WHERE application_id=$1`, [appId]);
      await db.query(`DELETE FROM applications WHERE id=$1`, [appId]);
      await db.query(`DELETE FROM service_contacts WHERE borrower_id = ANY($1::uuid[]) OR company_name LIKE $2`, [[mine, theirs], `VD${sfx}%`]);
      await db.query(`DELETE FROM borrowers WHERE id = ANY($1::uuid[])`, [[mine, theirs]]);
      await db.query(`DELETE FROM staff_users WHERE id=$1`, [staffId]);
    });

    // Three vendors: one THIS borrower used, one ANOTHER borrower used, and one on
    // the company directory (no borrower at all).
    const usedByMe = (await db.query(
      `INSERT INTO service_contacts (borrower_id,contact_type,company_name,email,emails,phone,last_used_at)
       VALUES ($1,'title_company',$2,'me@t.com',ARRAY['me@t.com','closing@t.com'],'212-555-0101',now()) RETURNING id`,
      [mine, `VD${sfx} Mine Title`])).rows[0].id;
    await db.query(
      `INSERT INTO service_contacts (borrower_id,contact_type,company_name,email)
       VALUES ($1,'title_company',$2,'them@t.com')`, [theirs, `VD${sfx} Theirs Title`]);
    await db.query(
      `INSERT INTO service_contacts (contact_type,company_name,email,added_by_staff_id)
       VALUES ('title_company',$1,'house@t.com',$2)`, [`VD${sfx} House Title`, staffId]);

    const staffSees = await VD.suggest({ type: 'title_company', q: `VD${sfx}`, borrowerId: mine, audience: 'staff' });
    const names = (rows) => rows.map((r) => r.companyName).sort();
    ok(staffSees.length === 3, `STAFF see the whole directory — every vendor we use (saw: ${names(staffSees).join(' | ')})`);
    ok(staffSees.some((r) => r.mine === true) && staffSees.some((r) => r.mine === false),
      '…and each row says whether THIS borrower used it before, so the prefill is distinguishable from the directory');
    ok(staffSees[0].mine === true, 'the borrower\'s own contacts sort first — that is what they are usually reaching for');
    ok(!Object.prototype.hasOwnProperty.call(staffSees[0], 'notes'),
      '`notes` is NEVER returned — it is free text a human wrote beside one deal, not a business card');

    const borrowerSees = await VD.suggest({ type: 'title_company', q: `VD${sfx}`, borrowerId: mine, audience: 'borrower' });
    ok(borrowerSees.length === 1 && borrowerSees[0].companyName === `VD${sfx} Mine Title`,
      'A BORROWER sees ONLY what they used themselves — never another borrower\'s vendor, never our roster');
    ok(borrowerSees[0].emails.length === 2,
      '…with every address on it, which is what makes the prefill fill the whole form');

    // A blank query IS the prefill: "show me what I have used" on focus.
    const onFocus = await VD.suggest({ type: 'title_company', q: '', borrowerId: mine, audience: 'borrower' });
    ok(onFocus.some((r) => r.companyName === `VD${sfx} Mine Title`),
      'a BLANK query lists what they have used — the prefill half of the request');

    /* Fail-safe defaults — and these are asserted on the QUERY, not on the answer.
       The SQL already answers nothing in both cases (`contact_type = $1` matches no
       row for a type nobody uses, and `($3 OR sc.borrower_id = $2)` is NULL, never
       true, when the audience is not staff and there is no borrower). So an
       assertion on the returned list passes with the guards DELETED — proven by
       mutation — and would be decoration. What the guards actually do is refuse
       BEFORE the database is touched, which is what keeps them correct if the
       query ever grows a branch that can match without a type or without a
       borrower. So we hand `suggest` a recording connection and assert it was
       never asked. */
    const spy = () => { const s = { calls: 0 }; s.query = async () => { s.calls++; return { rows: [] }; }; return s; };
    let s1 = spy();
    ok((await VD.suggest({ type: 'not_a_type', q: 'x', borrowerId: mine, audience: 'staff' }, s1)).length === 0
      && s1.calls === 0,
      'an unknown contact type is refused BEFORE the query — it never searches every vendor we have');
    let s2 = spy();
    ok((await VD.suggest({ type: 'title_company', q: 'x', borrowerId: null }, s2)).length === 0 && s2.calls === 0,
      'no borrower and no staff audience is refused before the query — the default is the SAFE side');
    let s3 = spy();
    ok((await VD.suggest({}, s3)).length === 0 && s3.calls === 0, 'a call with nothing at all is safe');
    // And a legitimate ask DOES reach the database — or the two guards above would
    // pass just as well on a function that never queries at all.
    let s4 = spy();
    await VD.suggest({ type: 'title_company', q: 'x', borrowerId: mine }, s4);
    ok(s4.calls === 1, 'a real ask does reach the database — the control for the two guards above');

    // …and over HTTP, with the file scope as the permission.
    const viaHttp = await call(server, 'GET', `/api/staff/applications/${appId}/vendor-suggest?type=title_company&q=VD${sfx}`, tok);
    ok(viaHttp.status === 200 && Array.isArray(viaHttp.body) && viaHttp.body.length === 3, 'the staff door answers the same set');
    const outsider = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'No Access','loan_officer',true,false,'x',0) RETURNING id`, [`vd-out-${sfx}@test.local`])).rows[0].id;
    clean.push(async () => { await db.query(`DELETE FROM staff_users WHERE id=$1`, [outsider]); });
    const denied = await call(server, 'GET', `/api/staff/applications/${appId}/vendor-suggest?type=title_company&q=VD${sfx}`,
      C.signJwt({ sub: outsider, kind: 'staff', role: 'loan_officer', tv: 0 }));
    /* TWO layers answer this 403 and either one alone is enough — the path-scoped
       `/applications/:id` middleware (the repo's `VISIBLE_OFFICERS_SQL` chokepoint)
       and the route's own `canTouchApp`. Proven by mutation: removing EITHER leaves
       this assertion green, removing BOTH turns it red. That is defence in depth,
       not dead code — do not delete one because a test still passes without it. */
    ok(denied.status === 403, 'a staffer with no relationship to the file cannot use its type-ahead');

    // =====================================================================
    console.log('\nD. EVERY address is on the order — the ask with teeth');
    // =====================================================================
    await db.query(
      `INSERT INTO application_service_contacts (application_id,service_contact_id,contact_type,added_by_kind,added_by_id)
       VALUES ($1,$2,'title_company','staff',$3)`, [appId, usedByMe, staffId]);
    const data = await orders.getOrderData(appId);
    const rcp = orders.recipientsFor('title', data, { ccBorrower: false });
    ok(rcp.to.length === 2 && rcp.to.includes('me@t.com') && rcp.to.includes('closing@t.com'),
      'BOTH the vendor\'s addresses are on the order — before this only the primary was');
    ok(rcp.to[0] === 'me@t.com', 'the primary leads');
    ok(!rcp.cc.some((e) => rcp.to.includes(e)), 'nobody is both a To and a Cc');

    // AND THE GATE AGREES WITH THE SEND. A vendor carrying only additional
    // addresses (scalar null) must not read as "no contact" and block its own order.
    await db.query(`UPDATE service_contacts SET email=NULL, emails=ARRAY['only@t.com'] WHERE id=$1`, [usedByMe]);
    const data2 = await orders.getOrderData(appId);
    ok(orders.vendorEmails('title', data2).length === 1, 'a vendor with only an ARRAY address still has a contact');
    ok(!orders.blockers('title', data2).includes('contact'),
      '…and is not blocked from ordering — the gate reads the same addresses the send does');
    ok(orders.recipientsFor('title', data2, { ccBorrower: false }).to[0] === 'only@t.com', '…and that is who it goes to');

    // =====================================================================
    console.log('\nE. the write doors take a list, and store BOTH columns');
    // =====================================================================
    const added = await call(server, 'POST', `/api/staff/applications/${appId}/file-contacts`, tok, {
      contactType: 'insurance_agent', companyName: `VD${sfx} Multi Ins`,
      emails: ['first@i.com', 'second@i.com', 'first@i.com', '  '],
    });
    ok(added.status === 201, 'a contact saves with several addresses');
    {
      const row = (await db.query(`SELECT email, emails FROM service_contacts WHERE id=$1`, [added.body.contactId])).rows[0];
      ok(Array.isArray(row.emails) && row.emails.length === 2, 'the duplicate and the blank are dropped');
      ok(row.email === 'first@i.com' && row.emails[0] === 'first@i.com',
        'the SCALAR is always the array\'s first entry — the two columns can never describe different vendors');
    }
    const edited = await call(server, 'PATCH', `/api/staff/file-contacts/${added.body.linkId}`, tok, {
      companyName: `VD${sfx} Multi Ins`, emails: ['third@i.com', 'first@i.com'],
    });
    ok(edited.status === 200, 'and edits the same way');
    {
      const row = (await db.query(`SELECT email, emails FROM service_contacts WHERE id=$1`, [added.body.contactId])).rows[0];
      ok(row.email === 'third@i.com' && row.emails.length === 2, 'the edit moves BOTH columns together');
    }
    // BACK-COMPAT: a caller that still sends only the old scalar is untouched.
    const oldStyle = await call(server, 'POST', `/api/staff/applications/${appId}/file-contacts`, tok, {
      contactType: 'attorney', companyName: `VD${sfx} Old Style`, email: 'solo@a.com',
    });
    ok(oldStyle.status === 201, 'a form that sends only `email` still works');
    {
      const row = (await db.query(`SELECT email, emails FROM service_contacts WHERE id=$1`, [oldStyle.body.contactId])).rows[0];
      ok(row.email === 'solo@a.com' && Array.isArray(row.emails) && row.emails.length === 1,
        '…and its one address lands in BOTH columns, so the order path sees it either way');
    }
    // A contact with NOTHING is still refused — the list must not become a way past it.
    const empty = await call(server, 'POST', `/api/staff/applications/${appId}/file-contacts`, tok,
      { contactType: 'attorney', emails: ['', '  '] });
    ok(empty.status === 400, 'a contact with no details at all is still refused');

    // =====================================================================
    console.log('\nF. the type lists have not drifted, and the screens are wired');
    // =====================================================================
    const ROOT = path.resolve(__dirname, '..');
    const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
    {
      // EVERY type a write door accepts must be suggestable, or a contact kind
      // exists that nobody can type-ahead for and nothing says why.
      const listOf = (src, name) => {
        const m = new RegExp(`const ${name} = \\[([^\\]]+)\\]`).exec(src);
        return m ? m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean) : [];
      };
      const staffSrc = rd('src/routes/staff.js');
      const borrowerSrc = rd('src/routes/borrower.js');
      const declared = [
        ...listOf(staffSrc, 'FILE_CONTACT_TYPES'),
        ...listOf(staffSrc, 'VENDOR_TYPES'),
        ...listOf(borrowerSrc, 'FILE_CONTACT_TYPES'),
        ...listOf(borrowerSrc, 'CONTACT_TYPES'),
      ];
      ok(declared.length > 10, `the route-level type lists were found (${declared.length} entries)`);
      const missing = [...new Set(declared)].filter((t) => !VD.SUGGEST_TYPES.has(t));
      ok(missing.length === 0, `every type a write door accepts is suggestable (missing: ${missing.join(', ') || 'none'})`);
    }
    {
      const staffScreen = rd('app-v2/src/screens/StaffApplication.jsx');
      const borrowerScreen = rd('app-v2/src/screens/Application.jsx');
      ok(/<VendorAutocomplete/.test(staffScreen), 'the staff condition form has the type-ahead');
      ok(/<VendorAutocomplete/.test(borrowerScreen), 'the borrower condition form has it too');
      ok(/<EmailListInput/.test(staffScreen) && /<EmailListInput/.test(borrowerScreen),
        'both forms take additional email addresses — "in the condition, we should also be able to add additional email addresses"');
      ok(/api\.staffVendorSuggest\(appId, contactType, q\)/.test(staffScreen),
        'the staff form asks the FILE-scoped door, so the permission and the search agree');
      ok(/api\.vendorSuggest\(meta\.type, q\)/.test(borrowerScreen), 'the borrower form asks its own door');
      // The old bare-button row is gone — it showed a name and nothing else, and
      // ran off the edge once somebody had a handful of saved contacts.
      ok(!/Use a saved contact:/.test(borrowerScreen),
        'the old name-only "use a saved contact" button row is replaced, not left beside it');
    }

    console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  vendor directory: prefill, type-ahead, and every address on the order');
  } catch (e) {
    fail++; console.error('THREW', e && e.message, e && e.stack);
  } finally {
    try { await require('../src/lib/notify').drainEmails(); } catch (_) {}
    for (const c of clean.reverse()) { try { await c(); } catch (_) {} }
    try { server.close(); } catch (_) {}
    try { await db.pool.end(); } catch (_) {}
    process.exit(fail ? 1 : 0);
  }
})();
