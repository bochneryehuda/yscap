/**
 * THE SUBJECT-PROPERTY LLC IS FILLED IN WHERE IT IS MISSING (owner-directed
 * 2026-08-03: "this missing stuff doesn't have the plus button like everywhere
 * else … you can't fill in the vesting LLC over there … once you put an LLC name
 * just set up and save that LLC name into the profile like it's doing regularly
 * with any LLC name").
 *
 * Two halves, because the bug had two halves:
 *   (A) PURE — the completeness pill is EDITABLE and posts to the file's one
 *       vesting door, and no route re-inlines its own resolve-or-create. That
 *       second rule is the durable one: five doors had hand-rolled the same
 *       `SELECT … lower(llc_name) … else INSERT INTO llcs`, three of them
 *       skipping the entity chokepoint's race recovery and two never building
 *       the entity's document slots. The panel is the sixth door.
 *   (B) DB — the real endpoint, over real HTTP: the entity lands on the
 *       BORROWER'S PROFILE with its document slots, the file vests in it, and
 *       the LLC condition opens. Plus the three ways it must NOT behave: a name
 *       the borrower already has is reused (never a second entity), a blank name
 *       is refused, and a frozen file neither links NOR leaves a stray entity
 *       behind on the profile.
 *
 * The DB half needs DATABASE_URL; the pure half always runs.
 */
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..');
let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

/* ---------------------------------------------------------------- A. pure */
console.log('\nA. the pill can be filled in, and there is one resolve-or-create');
{
  const screen = fs.readFileSync(path.join(R, 'app-v2/src/screens/StaffApplication.jsx'), 'utf8');
  const i = screen.indexOf("{ key: 'entity_name',");
  const row = i < 0 ? '' : screen.slice(i, screen.indexOf('},', i) + 2);
  assert(!!row, 'the vesting completeness pill is findable');
  assert(!/edit:\s*false/.test(row),
    'it is no longer edit:false — a dead grey chip is what the owner reported');
  assert(/type:\s*'entity'/.test(row), 'it declares the entity input type');
  assert(/postEndpoint[\s\S]*vesting-llc/.test(row),
    'it saves through the file\'s vesting door, not complete-fields (llc_id is a link, not text)');
  assert(/postBody[\s\S]*entityName/.test(row), 'it sends the typed name as entityName');
  assert(/f\.type === 'entity'/.test(screen) && /list=\{entListId\}/.test(screen),
    'the panel renders an input for it (with the borrower\'s own entities to pick from)');

  // The chokepoint rule. Entities are still created directly in the places that
  // OWN that data shape (lib/llc.js is the chokepoint itself; the ClickUp,
  // Encompass and MISMO importers carry their own origin/verification columns) —
  // but never again in a request handler that merely took a typed name.
  const routes = fs.readdirSync(path.join(R, 'src/routes')).filter((f) => f.endsWith('.js'));
  const offenders = routes.filter((f) =>
    /INSERT INTO llcs/i.test(fs.readFileSync(path.join(R, 'src/routes', f), 'utf8')));
  assert(offenders.length === 0,
    `no route re-inlines the entity create (offenders: ${offenders.join(', ') || 'none'})`);

  const vesting = require(path.join(R, 'src/lib/vesting'));
  assert(typeof vesting.setVestingLlcByName === 'function' && typeof vesting.resolveEntityByName === 'function',
    'the chokepoint exports both halves');
  assert(vesting.cleanEntityName('  Acme   Holdings\nLLC  ') === 'Acme Holdings LLC',
    'a pasted name is collapsed to one line');
  assert(vesting.cleanEntityName('x'.repeat(400)).length === 160, 'and capped, so a paste cannot become a company name');
  assert(vesting.cleanEntityName(null) === '' && vesting.cleanEntityName(undefined) === '',
    'a missing name is empty, never the string "null"');
}

if (!process.env.DATABASE_URL) {
  console.log('\nSKIP the DB half (no DATABASE_URL)');
  process.exit(failures ? 1 : 0);
}

/* ------------------------------------------------------------------ B. DB */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const http = require('http');
const db = require(path.join(R, 'src/db'));
const C = require(path.join(R, 'src/lib/crypto'));
const app = require(path.join(R, 'src/server'));

function call(server, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const llcCount = async (borrowerId) =>
  (await db.query(`SELECT count(*)::int n FROM llcs WHERE borrower_id=$1`, [borrowerId])).rows[0].n;

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  let adminId; const boEmails = [];
  try {
    const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    adminId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'A','super_admin',true,false,'x',0) RETURNING id`, [`vn-admin-${sfx}@test.local`])).rows[0].id;
    const token = C.signJwt({ sub: adminId, kind: 'staff', role: 'super_admin', tv: 0 });
    const boEmail = `vn-bo-${sfx}@test.local`; boEmails.push(boEmail);
    const base = {
      borrower: { firstName: 'Vest', lastName: 'Name', email: boEmail },
      propertyAddress: { line1: '11 Name St', city: 'Testville', state: 'NY', zip: '10001', oneLine: '11 Name St, Testville, NY 10001' },
    };

    // A file with NO vesting entity — the state the owner was looking at.
    let r = await call(server, 'POST', '/api/staff/applications', token, base);
    assert(r.status === 201, 'a file is created with no vesting entity');
    const appId = r.body.applicationId, borrowerId = r.body.borrowerId;

    console.log('\nB1. typing the name fills it in, everywhere it has to land');
    r = await call(server, 'POST', `/api/staff/applications/${appId}/vesting-llc`, token, { entityName: '  Namely   Holdings LLC ' });
    assert(r.status === 200, 'the typed name is accepted');
    assert(r.body && r.body.existed === false, 'and it reports that it CREATED the entity (not reused one)');
    const llc = (await db.query(
      `SELECT id, llc_name FROM llcs WHERE borrower_id=$1`, [borrowerId])).rows[0];
    assert(!!llc && llc.llc_name === 'Namely Holdings LLC',
      'the LLC is saved on the BORROWER\'S PROFILE, collapsed to one clean line');
    const row = (await db.query(`SELECT llc_id, personal_name_purchase FROM applications WHERE id=$1`, [appId])).rows[0];
    assert(llc && String(row.llc_id) === String(llc.id), 'the file now vests in it');
    const cond = (await db.query(
      `SELECT count(*)::int n FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
        WHERE ci.application_id=$1 AND t.code='rtl_p1_llc'`, [appId])).rows[0].n;
    assert(cond >= 1, 'the LLC vesting condition fired onto the file');
    const slots = (await db.query(`SELECT count(*)::int n FROM checklist_items WHERE llc_id=$1`, [llc.id])).rows[0].n;
    assert(slots >= 3, 'and the entity has its document slots, so there is somewhere to upload');

    console.log('\nB2. the same name again is the SAME entity — never a second one');
    const before = await llcCount(borrowerId);
    r = await call(server, 'POST', `/api/staff/applications/${appId}/vesting-llc`, token, { entityName: 'namely holdings llc' });
    assert(r.status === 200 && r.body.existed === true, 'a name the borrower already has is REUSED');
    assert(await llcCount(borrowerId) === before, 'the profile did not grow a duplicate entity');
    assert(String(r.body.llcId) === String(llc.id), 'and it is the very same entity');

    console.log('\nB3. a second file links the entity the borrower already had');
    r = await call(server, 'POST', '/api/staff/applications', token, {
      ...base, propertyAddress: { ...base.propertyAddress, line1: '12 Name St', oneLine: '12 Name St, Testville, NY 10001' } });
    const app2 = r.body.applicationId;
    r = await call(server, 'POST', `/api/staff/applications/${app2}/vesting-llc`, token, { entityName: 'Namely Holdings LLC' });
    assert(r.status === 200 && String(r.body.llcId) === String(llc.id),
      'the second file vests in the entity from the first — with its documents and verification');
    assert(await llcCount(borrowerId) === before, 'still no duplicate on the profile');

    console.log('\nB4. what it refuses');
    r = await call(server, 'POST', `/api/staff/applications/${app2}/vesting-llc`, token, { entityName: '   ' });
    assert(r.status === 400, 'a blank name is refused');
    assert(r.body && /LLC/i.test(r.body.error || ''), 'in words an officer can act on');

    // A frozen file must not link — and must not leave a stray entity behind on
    // the borrower's profile either, which is why the freeze is checked BEFORE
    // the entity is created rather than only at the link.
    await db.query(`UPDATE applications SET status='clear_to_close' WHERE id=$1`, [app2]);
    const beforeFrozen = await llcCount(borrowerId);
    r = await call(server, 'POST', `/api/staff/applications/${app2}/vesting-llc`, token, { entityName: 'Frozen Late LLC' });
    assert(r.status === 409, 'a Clear-to-Close file refuses the change');
    assert(await llcCount(borrowerId) === beforeFrozen,
      'and no orphan entity was created on the profile on the way to that refusal');
    const direct = await require(path.join(R, 'src/lib/vesting'))
      .setVestingLlcByName(app2, 'Frozen Late LLC', { source: 'staff', push: false });
    assert(direct && direct.reason === 'locked' && !direct.llcId, 'the library itself refuses it too, not just the route');
    assert(await llcCount(borrowerId) === beforeFrozen, 'still no orphan entity');

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL vesting-name-door assertions passed');
  } catch (e) { console.error('ERROR', e); failures++; }
  finally {
    for (const em of boEmails) { try { await db.query(`DELETE FROM borrowers WHERE email=$1`, [em]); } catch (_) {} }
    try { if (adminId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [adminId]); } catch (_) {}
    server.close();
  }
  process.exit(failures ? 1 : 0);
})();
