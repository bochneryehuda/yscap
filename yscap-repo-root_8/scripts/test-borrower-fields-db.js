/**
 * EVERY FIELD ON THE BORROWER SECTION IS EDITABLE, FOR EVERY BORROWER
 * (owner-reported 2026-07-27).
 *
 * The complaint: "In the BORROWER profile section you can only edit a few fields
 * from the first borrower, you can't edit the fields from the 2nd borrower, and
 * you can't even ADD all the fields from both borrowers. You need to be able to
 * edit any field on the entire BORROWER section from any BORROWER."
 *
 * ROOT CAUSE was per-surface duplication: the loan file's Borrower panel, the
 * co-borrower block, the two completeness panels and the borrower CRM profile
 * each hand-rolled their OWN subset of the borrower's fields, so "can I edit
 * this?" depended on which screen you were on and whether the value happened to
 * be blank. The fix is ONE shared editor (components/BorrowerProfilePanel.jsx)
 * keyed on a BORROWER ID — the primary and the co-borrower are the same code
 * path — mounted on the file overview, which is the section the owner named.
 *
 * This test guards BOTH halves:
 *   PURE — the fields that were still missing after the shared editor landed
 *          (FICO, the canonical employment list), the fact that the panel sits
 *          on the file OVERVIEW rather than only inside a collapsed section, and
 *          that the co-borrower's ClickUp push can never write the PRIMARY's
 *          fields onto the card. The shared editor's own "one definition,
 *          mounted for both people" contract is guarded next door in
 *          scripts/test-borrower-profile-editor.mjs.
 *   DB   — every field round-trips through the real HTTP endpoints for the
 *          PRIMARY and for the CO-BORROWER, re-read from the server afterwards.
 *          "Returned 200 but didn't save" is the #1 recurring bug class here, so
 *          nothing is asserted from the write's own response.
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const fs = require('fs');
const path = require('path');

let failures = 0, passes = 0;
const assert = (c, m) => { if (c) { passes++; } else { failures++; console.log(`FAIL ${m}`); } };
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

// ---------------------------------------------------------------------------
// PURE 1 — the fields the owner named are actually on the shared editor, and
// the surface they complained about is the one that carries it.
//
// The shared editor itself (ONE definition, mounted for both people) is guarded
// by scripts/test-borrower-profile-editor.mjs. What is asserted HERE is the part
// that was still missing after that: FICO, the canonical employment list, and
// the fact that the panel sits on the file OVERVIEW — the "BORROWER section" the
// owner was looking at — rather than only inside a section that is collapsed by
// default.
// ---------------------------------------------------------------------------
{
  const panel = read('app-v2', 'src', 'components', 'BorrowerProfilePanel.jsx');
  const file = read('app-v2', 'src', 'screens', 'StaffApplication.jsx');

  assert(/<span>FICO<\/span>/.test(panel), 'FICO is editable on the borrower record');
  assert(/fico: f\.fico/.test(panel), 'and the save actually sends it');
  assert(/ficoValid\(f\.fico\)/.test(panel), 'an impossible score is refused by name, not silently dropped');
  assert(/<Row k="FICO"/.test(panel), 'and it is shown on the read view');

  // Employment is a two-way mapped ClickUp dropdown: a free-text spelling the
  // crosswalk cannot translate is dropped from the push in silence and read back
  // over on the next pull, so it must be a fixed list.
  assert(/withCurrent\(EMPLOYMENT, f\.employmentType\)/.test(panel),
    'employment is picked from the canonical list, not typed free-hand');
  const enums = read('app-v2', 'src', 'lib', 'enums.js');
  const cross = read('src', 'clickup', 'crosswalk.js');
  const list = /export const EMPLOYMENT = \[([^\]]*)\]/.exec(enums);
  assert(!!list, 'EMPLOYMENT is defined in the shared enums');
  for (const v of (list ? list[1].match(/'([^']+)'/g) || [] : [])) {
    assert(cross.includes(v), `the ClickUp crosswalk knows the employment value ${v}`);
  }

  // THE SURFACE — moved by owner direction 2026-08-02 ("both borrower profiles
  // under Application Details, side by side"), which REVERSES the 2026-07-27
  // placement on the file overview.
  //
  // The reason the panels were on the overview still matters and is not simply
  // dropped: "Application details" is collapsed by default, and an editor
  // nobody can see is how this surface stayed read-only in the first place. So
  // what is asserted now is the NEW arrangement PLUS the three things that make
  // it discoverable — the tab, a named way in from the overview, and the
  // completeness pills landing on the right tab rather than a dead end.
  const appSection = file.slice(file.indexOf('id="sec-application"'));
  assert(/<BorrowerProfilePanel borrowerId=\{app\.borrower_id\}/.test(appSection),
    'the BORROWER panel is under Application details, where the owner asked for it');
  assert(/<BorrowerProfilePanel borrowerId=\{app\.co_borrower_id\}/.test(appSection),
    'and so is the CO-BORROWER panel');
  assert(/appDetailTab === 'people'/.test(appSection),
    'they sit on their own tab, not buried under the deal editor');
  assert(/className="bprof-pair"/.test(appSection),
    'the two are laid out side by side (the owner asked for side by side)');
  // Discoverability, the reason the old placement existed:
  const overview = file.slice(0, file.indexOf('id="sec-application"'));
  assert(/setAppDetailTab\('people'\)/.test(overview) && /goToSection\('sec-application'\)/.test(overview),
    'the overview carries a button that opens that exact tab — the section is collapsed by default');
  assert(/goTab: 'people'/.test(file),
    'a completeness pill this panel cannot edit itself lands on the people tab, never a dead end');
  assert(!/goTo: 'sec-overview',\s*\n\s*hint: 'Add it on the SSN line/.test(file),
    'and no borrower pill still points at the overview, where the editor no longer is');
  // ONE mount per person, wherever they live — two editors for one record is
  // worse than none, and the move is exactly when that could go wrong.
  assert((file.match(/<BorrowerProfilePanel/g) || []).length === 2,
    'exactly two profile panels on the file after the move');

  // The old read-only rows must be gone, not merely bypassed — leaving them
  // would put an uneditable copy of the same facts right next to the editor.
  assert(!/function DobRow\b/.test(file), 'the loan file no longer has its own private DOB editor');
  assert(!/setSsnDraft|ssnEditing/.test(file), 'nor its own private SSN editor');
  assert(!/<span className="k">Tier<\/span>/.test(file), 'nor the old read-only borrower rows');
}

// ---------------------------------------------------------------------------
// PURE 2 — a CO-BORROWER edit may never be pushed as the PRIMARY's fields.
// Every 'b' column in the ClickUp field map belongs to the file's primary
// borrower, so pushing `first_name`/`email`/`cell_phone` for a co-borrower would
// have written the WRONG person's values onto the card.
// ---------------------------------------------------------------------------
{
  const { resolveOnly } = require('../src/clickup/mapper');
  const F = require('../src/clickup/fields');
  const co = resolveOnly(['co_borrower']);
  const ids = [...co.cuIds];
  assert(ids.includes(F.PIPELINE.coBorrowerFlag) && ids.includes(F.PIPELINE.coBorrowerName)
    && ids.includes(F.PIPELINE.secondBorrowerEmail) && ids.includes(F.PIPELINE.secondBorrowerCell),
    'the co-borrower push carries the flag, name, email and cell');
  assert(ids.length === 4, 'and nothing else');
  for (const primary of [F.SHARED.borrowerName, F.SHARED.borrowerEmail, F.SHARED.borrowerCell,
    F.SHARED.borrowerSSN, F.SHARED.borrowerDOB, F.SHARED.borrowerFICO, F.SHARED.borrowerAddress]) {
    assert(!ids.includes(primary), 'the co-borrower push never touches a PRIMARY borrower field');
  }
  assert(co.status === false && co.internalStatus === false,
    'and it never moves the task status');

  // The route half: a co-borrower edit has to actually enqueue that key, and the
  // primary-keyed push must stay scoped to files where they ARE the primary.
  const staff = read('src', 'routes', 'staff.js');
  assert(/co_borrower_id=\$1[\s\S]{0,200}enqueueClickupPush\(a\.id, \['co_borrower'\]\)/.test(staff),
    'editing someone who is a CO-borrower on a file pushes through the co_borrower key');
  assert(/WHERE borrower_id=\$1 AND deleted_at IS NULL AND clickup_pipeline_task_id IS NOT NULL/.test(staff),
    'the ordinary identity push still only targets files where they are the PRIMARY');
}

console.log(`test-borrower-fields: PURE ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
if (!process.env.DATABASE_URL) { console.log('  (SKIP DB — no DATABASE_URL)'); process.exit(0); }

// ---------------------------------------------------------------------------
// DB — every field round-trips, for the FIRST and the SECOND borrower alike.
// ---------------------------------------------------------------------------
const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const app = require('../src/server');

function call(server, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let dbPass = 0, dbFail = 0;
  const ok = (c, m) => { if (c) { dbPass++; } else { dbFail++; console.log(`FAIL ${m}`); } };
  try {
    const loId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Field Officer','loan_officer',true,false,'x',0) RETURNING id`, [`bf-lo-${sfx}@test.local`])).rows[0].id;
    const otherId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Other Officer','loan_officer',true,false,'x',0) RETURNING id`, [`bf-lo2-${sfx}@test.local`])).rows[0].id;
    const loTok = C.signJwt({ sub: loId, kind: 'staff', role: 'loan_officer', tv: 0 });
    const otherTok = C.signJwt({ sub: otherId, kind: 'staff', role: 'loan_officer', tv: 0 });

    const mk = (first, last, mail) => db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ($1,$2,$3) RETURNING id`,
      [first, last, mail]).then((r) => r.rows[0].id);
    const primaryId = await mk('Avi', 'Klein', `bf-p-${sfx}@test.local`);
    const coId = await mk('Rivka', 'Klein', `bf-c-${sfx}@test.local`);
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, co_borrower_id, loan_officer_id, status, loan_type)
       VALUES ($1,$2,$3,'file_intake','Purchase') RETURNING id`, [primaryId, coId, loId])).rows[0].id;

    // A LOAN OFFICER assigned to the file — not an admin. The reported problem is
    // one an ordinary officer hits, so the whole test runs at that authority.
    const profile = (id) => call(server, 'GET', `/api/staff/borrowers/${id}`, loTok);
    const patch = (id, body) => call(server, 'PATCH', `/api/staff/borrowers/${id}`, loTok, body);

    ok((await profile(coId)).status === 200,
      'an officer on the file can open the CO-borrower, not only the primary');

    // ---- EVERY field, both people ----------------------------------------
    // One list, applied to each borrower in turn: what the panel offers is what
    // the server must accept. `check` re-reads from the server (never the write's
    // own response) and asserts the value LANDED.
    const EDITS = [
      { what: 'name', body: { firstName: 'Abraham', lastName: 'Kleinman' },
        check: (b) => b.first_name === 'Abraham' && b.last_name === 'Kleinman' },
      // A fresh address PER PERSON: two profiles may share a mailbox only when
      // the staffer deliberately says so, so reusing one address here would be
      // testing the shared-email guard, not the edit.
      { what: 'email', body: (tag) => ({ email: `bf-new-${tag}-${sfx}@test.local` }),
        check: (b, tag) => String(b.email).toLowerCase() === `bf-new-${tag}-${sfx}@test.local` },
      { what: 'phone', body: { cellPhone: '(845) 825-0374' }, check: (b) => /825/.test(b.cell_phone || '') },
      { what: 'date of birth', body: { dob: '1985-04-12' }, check: (b) => String(b.date_of_birth).startsWith('1985-04-12') },
      { what: 'FICO', body: { fico: '742' }, check: (b) => Number(b.fico) === 742 },
      { what: 'citizenship', body: { citizenship: 'Permanent Resident' }, check: (b) => b.citizenship === 'Permanent Resident' },
      { what: 'marital status', body: { maritalStatus: 'Married' }, check: (b) => b.marital_status === 'Married' },
      { what: 'contact type', body: { contactType: 'Investor' }, check: (b) => b.contact_type === 'Investor' },
      { what: 'dependents', body: { dependentsCount: '3' }, check: (b) => Number(b.dependents_count) === 3 },
      { what: 'employment type', body: { employmentType: 'Self employed' }, check: (b) => b.employment_type === 'Self employed' },
      { what: 'employer', body: { employer: 'Klein Holdings' }, check: (b) => b.employer === 'Klein Holdings' },
      { what: 'home address', body: { currentAddress: { line1: '144 Hewes St', unit: '2R', city: 'Brooklyn', state: 'NY', zip: '11211' } },
        check: (b) => b.current_address && b.current_address.line1 === '144 Hewes St' && b.current_address.zip === '11211' },
      { what: 'mailing address', body: { mailingAddress: { line1: 'PO Box 12', city: 'Monsey', state: 'NY', zip: '10952' } },
        check: (b) => b.mailing_address && b.mailing_address.city === 'Monsey' },
      { what: 'owns or rents', body: { housingStatus: 'Own with mortgage' }, check: (b) => b.housing_status === 'Own with mortgage' },
      { what: 'housing payment', body: { housingPayment: '2800' }, check: (b) => Number(b.housing_payment) === 2800 },
      { what: 'time at address', body: { yearsAtResidence: '4', monthsAtResidence: '2' },
        check: (b) => Number(b.years_at_residence) === 4 },
    ];

    for (const [who, id, tag] of [['FIRST borrower', primaryId, 'p'], ['SECOND borrower', coId, 'c']]) {
      for (const e of EDITS) {
        const r = await patch(id, typeof e.body === 'function' ? e.body(tag) : e.body);
        const after = (await profile(id)).body;
        ok(r.status === 200 && e.check(after, tag), `${who}: ${e.what} saves and stays saved`);
      }
      // SSN has its own audited door — it must work for BOTH people too (the
      // co-borrower's row could previously only REVEAL, never set).
      const ssn = String(100000000 + Math.floor(Math.random() * 799999999));
      const s = await call(server, 'POST', `/api/staff/borrowers/${id}/ssn`, loTok, { ssn });
      const afterSsn = (await profile(id)).body;
      ok(s.status === 200 && afterSsn.ssn_last4 === ssn.slice(-4), `${who}: SSN can be added`);
      const rev = await call(server, 'GET', `/api/staff/borrowers/${id}/ssn`, loTok);
      ok(rev.status === 200 && String(rev.body.ssn).replace(/\D/g, '') === ssn, `${who}: and revealed`);
    }

    // ---- the FILE's own view of the co-borrower reflects the edits ---------
    // The loan file reads co_* columns off its own payload; if those went stale
    // the officer would edit the co-borrower and watch the file keep showing the
    // old details until a hard refresh.
    const fileRow = (await call(server, 'GET', `/api/staff/applications/${appId}`, loTok)).body;
    ok(fileRow && fileRow.co_first_name === 'Abraham' && Number(fileRow.co_fico) === 742
      && fileRow.co_citizenship === 'Permanent Resident',
      'the loan file shows the co-borrower edits straight back');

    // ---- clearing, and refusing junk -------------------------------------
    ok((await patch(coId, { fico: '' })).status === 200
      && (await profile(coId)).body.fico == null, 'a field can be CLEARED, not only filled');
    const bad = await patch(coId, { fico: '99' });
    ok(bad.status === 400 && /300/.test(bad.body.error || ''),
      'an out-of-range FICO is REFUSED with a reason — never silently dropped');
    ok((await patch(coId, { firstName: '' })).status === 400,
      'a blank first name is refused — it would erase the person on every surface');
    ok((await patch(coId, { dob: '1885-01-01' })).status === 400,
      'an impossible date of birth is refused');

    // ---- the scope still scopes ------------------------------------------
    ok((await call(server, 'GET', `/api/staff/borrowers/${coId}`, otherTok)).status === 403,
      'an officer NOT on the file still cannot see the co-borrower');
    ok((await call(server, 'PATCH', `/api/staff/borrowers/${coId}`, otherTok, { employer: 'nope' })).status === 403,
      'and certainly cannot edit them');

    await db.query(`DELETE FROM applications WHERE id=$1`, [appId]);
    await db.query(`DELETE FROM borrowers WHERE id = ANY($1::uuid[])`, [[primaryId, coId]]);
    await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [[loId, otherId]]);
  } catch (e) {
    dbFail++; console.log('FAIL (threw)', e && e.stack ? e.stack : e);
  } finally {
    server.close();
    await db.pool.end().catch(() => {});
  }
  console.log(`test-borrower-fields: DB ${dbPass} passed, ${dbFail} failed`);
  process.exit(dbFail ? 1 : 0);
})();
