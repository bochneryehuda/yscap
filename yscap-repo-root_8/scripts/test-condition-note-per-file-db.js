/**
 * An internal note on a condition belongs to ONE file — never every file that
 * carries the same condition (owner-reported 2026-08-05: "I added an internal note
 * for a credit card link for a credit card condition, and that internal note
 * populated on every single file where there is a credit card condition").
 *
 * The note is stored on the per-file checklist_items row (checklist_items.notes)
 * and every write is keyed `WHERE id = <that file's item id>` — never by the
 * shared template. This test PROVES it end-to-end through the real PATCH endpoint:
 * two files that both carry the SAME condition template, a note saved on file A,
 * and file B's copy of the condition MUST stay empty. It locks the per-file
 * behavior so it can never silently regress into a shared/template write.
 *
 * Boots the real Express app and drives the real endpoint. Requires DATABASE_URL
 * with migrations applied; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-condition-note-per-file-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const app = require('../src/server');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

// One per-file instance of a template on an application.
async function mkItem(appId, templateId, label) {
  const r = await db.query(
    `INSERT INTO checklist_items (template_id, scope, application_id, label, status)
     VALUES ($1,'application',$2,$3,'received') RETURNING id`, [templateId, appId, label]);
  return r.rows[0].id;
}
async function noteOf(itemId) {
  const r = await db.query(`SELECT notes FROM checklist_items WHERE id=$1`, [itemId]);
  return r.rows[0] ? r.rows[0].notes : undefined;
}

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  try {
    const adminId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Note Admin','super_admin',true,false,'x',0) RETURNING id`, [`note-admin-${sfx}@test.local`])).rows[0].id;
    const token = C.signJwt({ sub: adminId, kind: 'staff', role: 'super_admin', tv: 0 });
    const boId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Note','Test',$1) RETURNING id`, [`note-bo-${sfx}@test.local`])).rows[0].id;

    // Two separate files (applications) for the same borrower.
    const appA = (await db.query(`INSERT INTO applications (borrower_id, loan_officer_id, status) VALUES ($1,$2,'processing') RETURNING id`, [boId, adminId])).rows[0].id;
    const appB = (await db.query(`INSERT INTO applications (borrower_id, loan_officer_id, status) VALUES ($1,$2,'processing') RETURNING id`, [boId, adminId])).rows[0].id;

    // The SAME condition template, instantiated once on each file — exactly the
    // situation the owner described ("every file that has this condition").
    const tpl = (await db.query(`SELECT id, label FROM checklist_templates WHERE code='rtl_p1_apprcard' LIMIT 1`)).rows[0];
    const itemA = await mkItem(appA, tpl.id, tpl.label);
    const itemB = await mkItem(appB, tpl.id, tpl.label);

    // Save an internal note on file A's copy only, through the real endpoint.
    const NOTE = `credit card link ${sfx} — for THIS file only`;
    const r = await call(server, 'PATCH', `/api/staff/checklist/${itemA}`, token, { notes: NOTE });
    assert(r.status === 200, 'saving an internal note on file A returns 200');

    assert((await noteOf(itemA)) === NOTE, "file A's condition carries the note");
    // The whole point: file B's copy of the SAME condition is untouched.
    assert(!(await noteOf(itemB)), "file B's copy of the same condition has NO note (per-file, not shared)");

    // And it holds through the read endpoint the UI uses.
    const readB = await call(server, 'GET', `/api/staff/applications/${appB}/checklist`, token);
    const listB = JSON.parse(readB.body || '[]');
    const rowB = (Array.isArray(listB) ? listB : (listB.items || [])).find((x) => x.id === itemB);
    assert(rowB && !rowB.notes, "file B's checklist read shows no note on the shared condition");
  } catch (e) {
    console.error('FAIL unexpected error', e && e.message); failures++;
  } finally {
    server.close();
    await db.query(`DELETE FROM staff_users WHERE email LIKE $1`, [`note-admin-${sfx}@test.local`]).catch(() => {});
  }
  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log('\nCondition internal notes are per-file. All checks passed.');
  process.exit(0);
})();
