/**
 * Borrower-profile linking (owner-directed 2026-07-26). Five behaviours that
 * were all broken in ways that showed up as the same complaint — "the profile
 * doesn't have the information, and I can't put it in":
 *
 *   1. ON HOLD is a real status.  ClickUp's "inactive / on hold" must derive to
 *      the borrower-facing `on_hold`, and `on_hold` must be settable from PILOT
 *      (it was missing from the staff status list, so a file could only ever be
 *      parked from the ClickUp side).
 *   2. A held file is QUIET.  The borrower fan-out chokepoint drops every
 *      message for a parked file.
 *   3. THE SUBJECT ADDRESS REACHES CLICKUP.  A ClickUp `location` field needs
 *      real coordinates, and the resolver called a `geocode` function that has
 *      never existed on `lib/address` — so no address ever gained coordinates
 *      and both location fields were silently dropped from every push.
 *   4. HOUSING + SSN + PRIMARY CONTACT are editable on the profile.
 *   5. A SHARED EMAIL is allowed (a husband and wife on one mailbox), the
 *      address still has exactly one owner, and only one profile per address can
 *      hold the portal login.
 *
 * The pure half always runs; the DB half needs DATABASE_URL.
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const statusMap = require('../src/clickup/status');
const mapper = require('../src/clickup/mapper');
const F = require('../src/clickup/fields');

let failures = 0, passes = 0;
const assert = (c, m) => { if (c) { passes++; } else { failures++; console.log(`FAIL ${m}`); } };

// ---- 1. on hold is on hold -------------------------------------------------
assert(statusMap.externalFor('inactive / on hold') === 'on_hold',
  'ClickUp "inactive / on hold" derives to the borrower-facing on_hold');
assert(statusMap.externalFor('INACTIVE / ON HOLD  ') === 'on_hold',
  'casing and trailing spaces do not change the derive');
assert(statusMap.isOnHold('inactive / on hold') && statusMap.isOnHold('Parked / On Hold'),
  'isOnHold recognizes the exact status AND a renamed hold status by keyword');
assert(!statusMap.isOnHold('starting') && !statusMap.isOnHold('waiting for docs') && !statusMap.isOnHold(''),
  'an intake / working / empty status is never read as on hold');
assert(statusMap.externalFor('starting') === 'file_intake',
  'file_intake stays the FIRST stage — it is not where a parked file lands');
assert(statusMap.ON_HOLD_INTERNAL === 'inactive / on hold',
  'the canonical ClickUp hold status is exported so PILOT can push it back');
assert(!statusMap.isTerminal('inactive / on hold'),
  'a held file is paused, not finished — it must not count as terminal');

// The staff status list is the only way to set a borrower-facing status by hand.
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'routes', 'staff.js'), 'utf8');
  const m = /const APP_STATUS = \[([^\]]*)\]/.exec(src);
  assert(!!m && /'on_hold'/.test(m[1]), 'on_hold is settable from PILOT (present in APP_STATUS)');
  assert(/VISIBLE_BORROWER_SQL/.test(src) && /primary_officer_id=\$\{p\}/.test(src),
    'borrower visibility includes the profile\'s own owning officer, not only loan files');
}
{
  const { STATUS_LABEL, MAJOR_STATUSES } = require('../src/lib/status-notify');
  assert(STATUS_LABEL.on_hold === 'On hold', 'on_hold has a human label (never the raw value on screen)');
  assert(!MAJOR_STATUSES.has('on_hold'), 'parking a file is not a decision milestone — it never emails');
}

// ---- 3. the subject address can actually reach ClickUp ---------------------
// addressField is the gate: no coordinates, no location field, no sync.
{
  const noCoords = mapper.buildTaskFields({
    app: { property_address: { oneLine: '12 Main St, Newark, NJ 07107' } },
    borrower: { first_name: 'A', last_name: 'B' },
  });
  const withCoords = mapper.buildTaskFields({
    app: { property_address: { oneLine: '12 Main St, Newark, NJ 07107', lat: 40.7, lng: -74.1 } },
    borrower: { first_name: 'A', last_name: 'B' },
  });
  const has = (r) => r.customFields.some((c) => c.id === F.PIPELINE.subjectAddress);
  assert(!has(noCoords), 'without coordinates the subject address is (correctly) never written');
  assert(has(withCoords), 'with coordinates the subject address IS written — so resolving them is the whole fix');
  const loc = withCoords.customFields.find((c) => c.id === F.PIPELINE.subjectAddress).value;
  assert(loc && loc.location && loc.location.lat === 40.7 && typeof loc.formatted_address === 'string',
    'the written value carries both the coordinates and a formatted address ClickUp can display');
}
// The resolver must call something that EXISTS. This is the actual 2026-07-26
// bug: `require('../lib/address').geocode` is undefined, so `withCoords` was a
// permanent no-op and every address silently failed to sync.
{
  const canon = require('../src/lib/address-canon');
  assert(typeof canon.geocode === 'function',
    'address-canon.geocode exists — the resolver the push always meant to call');
  assert(typeof require('../src/lib/address').geocode !== 'function',
    'lib/address still has no geocode — the old call really was dead');
  const orch = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'clickup', 'orchestrator.js'), 'utf8');
  assert(/address-canon/.test(orch) && /g\.geocode\(line\)/.test(orch),
    'the push orchestrator resolves coordinates through a resolver that exists');
}

// ---- 4/5. the scoped push carries what the profile now edits ---------------
{
  const { cuIds } = mapper.resolveOnly(['housing_status', 'housing_payment', 'years_at_residence', 'current_address', 'ssn', 'email']);
  assert(cuIds.has(F.SHARED.primaryHousingType) && cuIds.has(F.SHARED.primaryHousingAmt),
    'a housing edit on the profile pushes the ClickUp Primary Housing fields');
  assert(cuIds.has(F.EXTRA.yearsAtResidence), 'years-at-residence pushes too');
  assert(cuIds.has(F.SHARED.borrowerAddress) && cuIds.has(F.SHARED.borrowerSSN) && cuIds.has(F.SHARED.borrowerEmail),
    'address / SSN / email keep their scoped push');
}

console.log(`test-borrower-profile-linking: PURE ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);

if (!process.env.DATABASE_URL) { console.log('  (SKIP DB — no DATABASE_URL)'); process.exit(0); }

// ---------------------------------------------------------------------------
// DB half — the real routes, over HTTP, exactly as the screens call them.
// ---------------------------------------------------------------------------
const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const app = require('../src/server');

function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  // An SSN is unique across the whole borrower table, so a fixed literal would
  // collide with the row a PREVIOUS run of this test left behind and make the
  // first save fail for the wrong reason. One throwaway number per run.
  const digits = String(Math.floor(100000000 + Math.random() * 899999999));
  const SSN = `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
  let dbPass = 0, dbFail = 0;
  const ok = (c, m) => { if (c) { dbPass++; } else { dbFail++; console.log(`FAIL ${m}`); } };
  try {
    const adminId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Admin','super_admin',true,false,'x',0) RETURNING id`, [`bpl-admin-${sfx}@test.local`])).rows[0].id;
    const loId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Officer','loan_officer',true,false,'x',0) RETURNING id`, [`bpl-lo-${sfx}@test.local`])).rows[0].id;
    const token = C.signJwt({ sub: adminId, kind: 'staff', role: 'super_admin', tv: 0 });
    const loToken = C.signJwt({ sub: loId, kind: 'staff', role: 'loan_officer', tv: 0 });

    const shared = `bpl-shared-${sfx}@test.local`;
    const husband = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Chaim','Klein',$1) RETURNING id`, [shared])).rows[0].id;

    // --- housing + employment are editable from the profile -----------------
    const save = await call(server, 'PATCH', `/api/staff/borrowers/${husband}`, token, {
      housingStatus: 'Rent', housingPayment: '2,800', yearsAtResidence: '2', monthsAtResidence: '10',
      employmentType: 'Self employed', employer: 'Klein Holdings', dependentsCount: '3',
    });
    ok(save.status === 200, 'housing + employment save from the borrower profile');
    const stored = (await db.query(
      `SELECT housing_status, housing_payment, years_at_residence, months_at_residence, residence_since, employer, dependents_count
         FROM borrowers WHERE id=$1`, [husband])).rows[0];
    ok(stored.housing_status === 'Rent' && Number(stored.housing_payment) === 2800,
      'owns-or-rents and the monthly payment land on the profile');
    ok(Number(stored.years_at_residence) === 2 && stored.months_at_residence === 10 && stored.residence_since,
      'time at the address is stored AND anchored to a move-in date so it keeps counting');
    ok(stored.employer === 'Klein Holdings' && stored.dependents_count === 3, 'employment + dependents save');

    const read = await call(server, 'GET', `/api/staff/borrowers/${husband}`, token);
    ok(read.body.housing_status === 'Rent' && read.body.employer === 'Klein Holdings',
      'the profile reads housing + employment back');
    ok(Array.isArray(read.body.otherDeals) && Array.isArray(read.body.contacts) && Array.isArray(read.body.sharing),
      'the profile returns contacts, shared-mailbox people, and non-RTL ClickUp deals');

    // --- the SSN is settable ON THE PROFILE ---------------------------------
    const setSsn = await call(server, 'POST', `/api/staff/borrowers/${husband}/ssn`, token, { ssn: SSN });
    ok(setSsn.status === 200 && setSsn.body.last4 === digits.slice(-4), 'the SSN can be entered on the profile itself');
    ok((await db.query(`SELECT ssn_encrypted IS NOT NULL AS e, ssn_hash IS NOT NULL AS h FROM borrowers WHERE id=$1`, [husband])).rows[0].e,
      'it is stored encrypted, with the match hash');

    // --- the duplicate-profile dead end is now explained AND fixable --------
    const dupe = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Chaim','Klein',$1) RETURNING id`,
      [`bpl-dupe-${sfx}@test.local`])).rows[0].id;
    const blocked = await call(server, 'POST', `/api/staff/borrowers/${dupe}/ssn`, token, { ssn: SSN });
    ok(blocked.status === 409, 'the same SSN on a second profile is still refused');
    ok(blocked.body.conflict && blocked.body.conflict.borrowerId === husband,
      'the refusal NAMES the profile already holding it (the missing half of the old error)');
    ok(blocked.body.conflict.sameLastName === true && /Chaim Klein/.test(blocked.body.error),
      'it says whose profile it is and that the name matches — enough to decide');
    const moved = await call(server, 'POST', `/api/staff/borrowers/${dupe}/ssn`, token,
      { ssn: SSN, resolveConflict: 'same_person' });
    ok(moved.status === 200 && moved.body.movedFrom === husband, 'confirming "same person" moves the number over');
    const after = (await db.query(
      `SELECT (SELECT ssn_hash FROM borrowers WHERE id=$1) AS old_hash,
              (SELECT ssn_hash FROM borrowers WHERE id=$2) AS new_hash`, [husband, dupe])).rows[0];
    ok(after.old_hash === null && after.new_hash !== null, 'the number now sits on exactly one profile');
    ok((await db.query(`SELECT count(*)::int n FROM borrower_dedup_candidates WHERE borrower_id=$1 AND matched_borrower_id=$2`, [dupe, husband])).rows[0].n === 1,
      'the duplicate pair is recorded so it gets worked, not just worked around');

    // --- a husband and wife on one mailbox ----------------------------------
    const wife = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email,shares_email) VALUES ('Rivka','Klein',$1,true) RETURNING id`, [shared])).rows[0].id;
    ok((await db.query(`SELECT count(*)::int n FROM borrowers WHERE email=$1`, [shared])).rows[0].n === 2,
      'two separate people can hold the same email address');
    let refused = false;
    try { await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Third','Person',$1)`, [shared]); }
    catch (e) { refused = e.code === '23505'; }
    ok(refused, 'the address still has exactly ONE owner — a third owner is refused');
    await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash) VALUES ($1,'x')`, [husband]);
    let loginRefused = false;
    try { await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash) VALUES ($1,'x')`, [wife]); }
    catch (e) { loginRefused = e.code === '23505'; }
    ok(loginRefused, 'only one of them can hold the portal login (a sign-in must resolve to one person)');
    const invite = await call(server, 'POST', `/api/staff/borrowers/${wife}/portal-invite`, token);
    ok(invite.status === 409 && /only one of them can have the portal login/i.test(invite.body.error || ''),
      'inviting the second person explains why, up front, instead of failing later');

    // --- the sync is STABLE on a shared mailbox -----------------------------
    // A husband and wife on one email are two profiles. Re-syncing their cards
    // must keep finding those same two — the resolver reads EVERY profile on the
    // address, so it can never land on the wrong spouse, fail to corroborate and
    // mint a third profile on each pass (which a one-row lookup would do).
    const ingest = require('../src/clickup/ingest');
    const pairEmail = `bpl-pair-${sfx}@test.local`;
    const him = { first_name: 'Yaakov', last_name: 'Stern', email: pairEmail, cell_phone: '5551110001' };
    const her = { first_name: 'Miriam', last_name: 'Stern', email: pairEmail, cell_phone: '5551110002' };
    const r1 = await ingest.resolveBorrower({ borrower: him }, `bpl-t1-${sfx}`);
    const r2 = await ingest.resolveBorrower({ borrower: her }, `bpl-t2-${sfx}`);
    ok(r1.borrowerId && r2.borrowerId && r1.borrowerId !== r2.borrowerId,
      'a husband and wife on one email become TWO profiles, not one merged person');
    const r1b = await ingest.resolveBorrower({ borrower: him }, `bpl-t1-${sfx}`);
    const r2b = await ingest.resolveBorrower({ borrower: her }, `bpl-t2-${sfx}`);
    ok(String(r1b.borrowerId) === String(r1.borrowerId) && String(r2b.borrowerId) === String(r2.borrowerId),
      're-syncing both cards resolves to the SAME two people');
    ok((await db.query(`SELECT count(*)::int n FROM borrowers WHERE email=$1`, [pairEmail])).rows[0].n === 2,
      'and no third profile is minted on the re-sync');
    ok((await db.query(`SELECT count(*)::int n FROM borrowers WHERE email=$1 AND shares_email=false`, [pairEmail])).rows[0].n === 1,
      'exactly one of them OWNS the address (the other is flagged as sharing it)');
    ok(!(await db.query(`SELECT 1 FROM borrowers WHERE email LIKE 'noemail+%' AND id IN ($1,$2)`, [r1.borrowerId, r2.borrowerId])).rows[0],
      'neither of them is given a fake @clickup.local address any more');

    // --- the officer sees a client who never took an RTL loan ---------------
    const dscrOnly = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email,primary_officer_id) VALUES ('Dscr','Only',$1,$2) RETURNING id`,
      [`bpl-dscr-${sfx}@test.local`, loId])).rows[0].id;
    await db.query(
      `INSERT INTO clickup_task_index (task_id, kind, borrower_id, loan_officer_id, task_name, internal_status, snapshot, last_seen)
       VALUES ($1,'data_only',$2,$3,'Dscr Only - 1 Main St','self procesing',$4::jsonb, now())`,
      [`bpl-task-${sfx}`, dscrOnly, loId,
       JSON.stringify({ rawProgram: 'Non-QM - DSCR Ratio', app: { loan_amount: 250000, property_address: { oneLine: '1 Main St, Newark, NJ' } } })]);
    const book = await call(server, 'GET', '/api/staff/borrowers', loToken);
    const mine = (book.body || []).find((b) => String(b.id) === String(dscrOnly));
    ok(!!mine, 'a DSCR-only client appears in the loan officer\'s borrower list (they never had an RTL file)');
    ok(mine && mine.other_deals === 1 && mine.files === 0,
      'their history shows as "other deals" instead of an empty record');
    ok(mine && mine.loan_officer_name === 'Officer', 'the list shows who they belong to even with no file');
    const search = await call(server, 'GET', '/api/staff/borrowers/search?q=Dscr', loToken);
    ok((search.body || []).some((b) => String(b.id) === String(dscrOnly)),
      'and the new-file typeahead finds them, so a duplicate is not typed in');
    const profile = await call(server, 'GET', `/api/staff/borrowers/${dscrOnly}`, loToken);
    ok(profile.status === 200 && (profile.body.otherDeals || []).length === 1,
      'the officer can open the profile and see the ClickUp deal behind it');

    // --- primary contact ----------------------------------------------------
    const addC = await call(server, 'POST', `/api/staff/borrowers/${dscrOnly}/contacts`, loToken,
      { kind: 'phone', value: '(845) 825-0374', makePrimary: true });
    ok(addC.status === 200 || addC.status === 201, 'a new phone can be added to the profile');
    ok((await db.query(`SELECT cell_phone FROM borrowers WHERE id=$1`, [dscrOnly])).rows[0].cell_phone === '(845) 825-0374',
      'making it primary is what PILOT actually uses from then on');
    const addE = await call(server, 'POST', `/api/staff/borrowers/${dscrOnly}/contacts`, loToken,
      { kind: 'email', value: `bpl-alt-${sfx}@test.local` });
    ok(addE.status === 201, 'a second email is kept as another way to reach them');
    const promoted = await call(server, 'POST', `/api/staff/borrowers/${dscrOnly}/contacts/primary`, loToken,
      { kind: 'email', value: `bpl-alt-${sfx}@test.local` });
    ok(promoted.status === 200, 'and it can be promoted to primary');
    const contacts = (await call(server, 'GET', `/api/staff/borrowers/${dscrOnly}`, loToken)).body.contacts || [];
    ok(contacts.some((c) => c.kind === 'email' && c.value === `bpl-dscr-${sfx}@test.local`),
      'the OLD primary is kept in the contact list — nothing is lost by switching');

    // --- a parked file is quiet + parked on both sides ----------------------
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id,loan_officer_id,status,internal_status)
       VALUES ($1,$2,'processing','file being worked') RETURNING id`, [husband, loId])).rows[0].id;
    const park = await call(server, 'PATCH', `/api/staff/applications/${appId}`, token, { status: 'on_hold' });
    ok(park.status === 200 && park.body.status === 'on_hold', 'a file can be put on hold from PILOT');
    const parked = (await db.query(`SELECT status, internal_status FROM applications WHERE id=$1`, [appId])).rows[0];
    ok(parked.status === 'on_hold' && statusMap.norm(parked.internal_status) === statusMap.ON_HOLD_INTERNAL,
      'the ClickUp status is parked in lock-step — the whole file goes on hold, not just the label');
    const sent = await require('../src/lib/notify').notifyAppBorrowers(appId,
      { type: 'status_change', title: 'should not be sent', body: 'x' });
    ok(Array.isArray(sent) && sent.length === 0, 'a held file sends the borrower nothing at all');

    // The reported symptom itself: the ClickUp card says ON HOLD but PILOT is
    // stuck showing FILE INTAKE (the file arrived while the card said "starting"
    // and the parking pull never landed). Picking the status it already has used
    // to be a no-op that fixed nothing.
    const drifted = (await db.query(
      `INSERT INTO applications (borrower_id,loan_officer_id,status,internal_status)
       VALUES ($1,$2,'file_intake','inactive / on hold') RETURNING id`, [husband, loId])).rows[0].id;
    const heal = await call(server, 'PATCH', `/api/staff/applications/${drifted}`, token, { status: 'on_hold' });
    ok(heal.status === 200, 'a drifted file accepts the on-hold correction');
    const healed = (await db.query(`SELECT status, status_notified_external FROM applications WHERE id=$1`, [drifted])).rows[0];
    ok(healed.status === 'on_hold',
      'a file whose ClickUp card says on hold no longer shows FILE INTAKE in PILOT');
    ok(healed.status_notified_external === 'on_hold',
      'and correcting it is silent — no retroactive "your loan is on hold" email');
  } catch (e) {
    dbFail++; console.log('FAIL threw:', e && e.message);
  } finally {
    // Order matters: the file references the borrower, the borrower references
    // the officer. Leaving rows behind would make a LATER run of this test fail
    // for the wrong reason (a stale profile holding a name or an SSN).
    await db.query(`DELETE FROM clickup_task_index WHERE task_id LIKE $1`, [`bpl-task-${sfx}%`]).catch(() => {});
    await db.query(`DELETE FROM applications WHERE borrower_id IN (SELECT id FROM borrowers WHERE email LIKE $1)`,
      [`bpl-%${sfx}@test.local`]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE email LIKE $1`, [`bpl-%${sfx}@test.local`]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE email = $1`, [`bpl-pair-${sfx}@test.local`]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE email LIKE $1`, [`bpl-%${sfx}@test.local`]).catch(() => {});
    server.close();
    console.log(`test-borrower-profile-linking: DB ${dbPass} passed, ${dbFail} failed`);
    process.exit(dbFail ? 1 : 0);
  }
})();
