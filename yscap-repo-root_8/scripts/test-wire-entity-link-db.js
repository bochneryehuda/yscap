/* THE WIRE'S KNOWN-ENTITY ACCOUNT NAME IS A DOOR, AND ITS PROFILE OA RIDES ALONG
 * (owner-directed 2026-08-26): "populate it as a link to go directly to that entity
 * profile … automatically bring in the operating agreement from that particular entity
 * profile if it has an operating agreement in the operating agreement slot."
 *
 * What this proves, against a REAL Postgres + the REAL HTTP route:
 *   A. matchingFileEntity carries the entity's owning borrower_id (the link target);
 *   B. profileAcceptedOa is the db/424 rule — an ACCEPTED profile agreement is found,
 *      a merely-uploaded (pending) one is NOT;
 *   C. acceptedOaForInvestor FALLS BACK to the profile OA on a known-entity wire
 *      (no OA condition exists there), and attaches nothing on a borrower-personal wire;
 *   D. GET /api/sitewire/files/:id/draw-request returns wire.entity {llc_id, llc_name,
 *      borrower_id, oa} so the card can render the link + the "OA on file" line.
 * Run: DATABASE_URL=... node scripts/test-wire-entity-link-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-wire-entity-link-db (no DATABASE_URL)'); process.exit(0); }
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-wire-entity';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const crypto = require('crypto');
const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto.js');
const drawOa = require('../src/lib/esign/draw-oa');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

function api(server, method, p, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: p,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    req.on('error', reject); req.end();
  });
}

(async () => {
  const tag = crypto.randomBytes(4).toString('hex');
  const bor = (await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('Wire','Owner',$1) RETURNING id`,
    ['we' + tag + '@example.com'])).rows[0].id;
  const admin = (await db.query(
    `INSERT INTO staff_users(email, full_name, role, is_active) VALUES ($1,'Wire Admin','admin',true) RETURNING id`,
    ['wea' + tag + '@example.com'])).rows[0].id;
  const app = (await db.query(
    `INSERT INTO applications(borrower_id,status,ys_loan_number,property_address)
     VALUES($1,'funded',$2,'{"oneLine":"5 Wire Way, Testville, NY 10001"}'::jsonb) RETURNING id`,
    [bor, 'WE' + tag.toUpperCase()])).rows[0].id;
  // The borrower's OWN entity — a DIFFERENT company from the subject vesting (none linked),
  // spelled slightly differently on the wire form than on the profile.
  const llc = (await db.query(
    `INSERT INTO llcs(borrower_id, llc_name, is_verified) VALUES($1,$2,true) RETURNING id`,
    [bor, `Sunrise Holdings ${tag} LLC`])).rows[0].id;
  const tOa = (await db.query(`SELECT id FROM checklist_templates WHERE code='rtl_llc_opagmt' LIMIT 1`)).rows[0];
  ok(!!tOa, '0 the entity OA slot template exists');
  const slot = (await db.query(
    `INSERT INTO checklist_items(llc_id, template_id, label, status, scope) VALUES($1,$2,'Operating Agreement','received','llc') RETURNING id`,
    [llc, tOa.id])).rows[0].id;

  // ---- B. accepted-only (db/424) ----
  const doc = (await db.query(
    `INSERT INTO documents(checklist_item_id, borrower_id, filename, content_type, size_bytes,
        storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id, review_status)
     VALUES($1,$2,'sunrise-oa.pdf','application/pdf',10,'local','x/'||$3,'borrower',$2,'pending') RETURNING id`,
    [slot, bor, tag])).rows[0].id;
  ok((await drawOa.profileAcceptedOa(db, llc)) === null,
    'B1 a merely-uploaded (pending) profile agreement is NOT offered — accepted-only, the db/424 rule');
  await db.query(`UPDATE documents SET review_status='accepted' WHERE id=$1`, [doc]);
  const oa = await drawOa.profileAcceptedOa(db, llc);
  ok(oa && String(oa.id) === String(doc) && oa.filename === 'sunrise-oa.pdf',
    'B2 the ACCEPTED profile agreement is found on the entity\'s own slot');

  // ---- A. the matcher carries the owning borrower ----
  const ent = await drawOa.matchingFileEntity(db, app, `Sunrise Holdings ${tag}, L.L.C.`);
  ok(ent && String(ent.id) === String(llc) && String(ent.borrower_id) === String(bor),
    'A1 matchingFileEntity matches the differently-spelled name AND carries borrower_id (the link target)');

  // ---- C. the investor attachment fallback ----
  await db.query(
    `INSERT INTO draw_wire_instructions(application_id, account_name, bank_name, name_kind, name_matches, captured_at, raw, updated_at)
     VALUES($1,$2,'Test Bank','known_entity',true, now(), '{}'::jsonb, now())
     ON CONFLICT (application_id) DO UPDATE SET account_name=EXCLUDED.account_name, name_kind='known_entity', name_matches=true, updated_at=now()`,
    [app, `Sunrise Holdings ${tag}, L.L.C.`]);
  const inv = await drawOa.acceptedOaForInvestor(db, app);
  ok(inv && String(inv.id) === String(doc),
    'C1 a KNOWN-entity wire (no OA condition) attaches the profile\'s accepted agreement — the 2026-08-26 fallback');
  await db.query(`UPDATE draw_wire_instructions SET name_kind='borrower_personal', name_matches=true WHERE application_id=$1`, [app]);
  ok((await drawOa.acceptedOaForInvestor(db, app)) === null,
    'C2 a wire to the borrower personally attaches nothing');
  await db.query(`UPDATE draw_wire_instructions SET name_kind='known_entity' WHERE application_id=$1`, [app]);

  // ---- D. the route answers with the entity door ----
  const expressApp = require('../src/server.js');
  const server = expressApp.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const tok = C.signJwt({ sub: admin, kind: 'staff', role: 'admin', tv: 0 });
    const r = await api(server, 'GET', `/api/sitewire/files/${app}/draw-request`, tok);
    const wire = r.body && r.body.wire;
    ok(r.status === 200 && wire && wire.entity, 'D1 the route answers with wire.entity on a known-entity wire');
    ok(wire && wire.entity && String(wire.entity.llc_id) === String(llc)
      && String(wire.entity.borrower_id) === String(bor) && wire.entity.is_verified === true,
      'D2 …naming the entity, its verified state and the owning borrower (the profile link)');
    ok(wire && wire.entity && wire.entity.oa && String(wire.entity.oa.document_id) === String(doc)
      && wire.entity.oa.filename === 'sunrise-oa.pdf',
      'D3 …and the profile\'s accepted operating agreement, so the card can say it rides along');
  } finally { server.close(); }

  // cleanup
  await db.query(`DELETE FROM draw_wire_instructions WHERE application_id=$1`, [app]).catch(() => {});
  await db.query(`DELETE FROM applications WHERE id=$1`, [app]).catch(() => {});
  await db.query(`DELETE FROM llcs WHERE id=$1`, [llc]).catch(() => {});
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor]).catch(() => {});
  await db.query(`DELETE FROM staff_users WHERE id=$1`, [admin]).catch(() => {});

  console.log(`\nwire-entity-link: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
