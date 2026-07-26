'use strict';
/**
 * Sitewire capital-partner RELINK + DEDUPE + rule-builder ACTIVE-FILE scoping
 * (owner-directed 2026-07-20).
 *
 *  #27 — the rule-builder / note-buyer list must contain ONLY the note buyers on files we are
 *        actively using (alive files, funded INCLUDED), NOT the whole Sitewire directory; a note
 *        buyer with an existing rule is kept so its rule is never orphaned.
 *  #26 — after the owner renamed our note-buyer labels to match Sitewire exactly, the resolver
 *        auto-binds an exact directory match even when Sitewire lists the SAME name under two ids
 *        (prefer the one attached to our lender); the directory picker + the /rules list never show
 *        the same investor twice.
 *
 * Boots the real server against local PG and hits the real routes with a forged super_admin token
 * (super_admin implicitly has every capability, incl. platform_setup). Run:
 *   DATABASE_URL=... node scripts/test-sitewire-partner-scope.js
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5433/yscap';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-sw-scope';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const http = require('http');
const crypto = require('crypto');
const assert = require('assert');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const C = require(REPO + '/src/lib/crypto.js');
const orchestrator = require(REPO + '/src/sitewire/orchestrator');
const PORT = 5673;
const uuid = () => crypto.randomUUID();
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

function api(method, path, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path,
      headers: { Authorization: `Bearer ${token}` } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    req.on('error', reject); req.end();
  });
}

// unique tags so the test is isolated + re-runnable
const TAG = 't' + Date.now().toString(36);
const nm = (s) => `${s} ${TAG}`;                 // display name
const normKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

async function main() {
  const app = require(REPO + '/src/server.js');
  const server = app.listen(PORT);
  await require(REPO + '/src/migrate-boot').ensureSchema();

  const admin = uuid();
  const cpIds = { dupOurs: 91000 + (Date.now() % 1000), dupOther: 92000 + (Date.now() % 1000), solo: 93000 + (Date.now() % 1000) };
  const seededApps = [];
  const seededCp = [cpIds.dupOurs, cpIds.dupOther, cpIds.solo];
  const rulePartner = nm('Ruled Only');       // has a rule but NOT on any active file
  const dupName = nm('Dupe Capital LLC');      // same name, two directory ids (one on our lender)
  const soloName = nm('Solo Capital LLC');     // on a funded file only

  try {
    await db.query(`INSERT INTO staff_users (id,email,full_name,role,is_active) VALUES ($1,$2,'SW Scope Admin','super_admin',true)`,
      [admin, `swscope_${TAG}@x.test`]);
    const token = C.signJwt({ sub: admin, kind: 'staff', role: 'super_admin', tv: 0 });

    const borrower = uuid();
    await db.query(`INSERT INTO borrowers (id,first_name,last_name,email) VALUES ($1,'SW','Scope',$2)`,
      [borrower, `swscopeb_${TAG}@x.test`]);

    // --- Sitewire directory: a DUPLICATE name under two ids (one on our lender), + a solo partner ---
    await db.query(`INSERT INTO sitewire_capital_partners (sitewire_id,name,on_our_lender,synced_at) VALUES
      ($1,$4,true,now()), ($2,$4,false,now()), ($3,$5,true,now())
      ON CONFLICT (sitewire_id) DO UPDATE SET name=EXCLUDED.name, on_our_lender=EXCLUDED.on_our_lender`,
      [cpIds.dupOurs, cpIds.dupOther, cpIds.solo, dupName, soloName]);

    // --- applications with a spread of statuses; lender = the note buyer label ---
    const mkApp = async (lender, status, deleted) => {
      const id = uuid(); seededApps.push(id);
      await db.query(`INSERT INTO applications (id,borrower_id,status,lender,deleted_at) VALUES ($1,$5,$2,$3,$4)`,
        [id, status, lender, deleted ? new Date() : null, borrower]);
      return id;
    };
    await mkApp(dupName, 'processing', false);   // ALIVE, dup-name buyer → should appear, bind to OUR id
    await mkApp(soloName, 'funded', false);      // FUNDED → must still appear (draws are post-funding)
    await mkApp(nm('Declined Buyer'), 'declined', false);   // dead → must NOT appear
    await mkApp(nm('Withdrawn Buyer'), 'withdrawn', false);  // dead → must NOT appear
    await mkApp(nm('Deleted Buyer'), 'processing', true);    // soft-deleted → must NOT appear

    // --- a rule for a partner that is NOT on any active file (must stay in the builder) ---
    await db.query(`INSERT INTO sitewire_inspection_rules (partner_label, inspection_method) VALUES ($1,'mobile')
      ON CONFLICT (regexp_replace(lower(COALESCE(partner_label,'')), '[^a-z0-9]+', '', 'g'), COALESCE(program,'')) DO NOTHING`,
      [rulePartner]);

    // =========================================================================
    // #26 — RESOLVER: exact match to a DUPLICATE directory name binds to our-lender id
    // =========================================================================
    const r1 = await orchestrator.resolveCapitalPartnerId(dupName);
    ok(r1.id === cpIds.dupOurs && !r1.ambiguous, 'resolver: duplicate directory name binds to the on-our-lender id (not ambiguous)');
    ok(r1.dedupedByLender === true, 'resolver: flags the dedupe-by-lender tiebreak');

    const r2 = await orchestrator.resolveCapitalPartnerId(soloName);
    ok(r2.id === cpIds.solo && !r2.ambiguous, 'resolver: a single exact match still auto-binds');

    // a truly ambiguous duplicate (two ids, NEITHER on our lender) must PARK, never guess
    const ambName = nm('Ambiguous Cap LLC');
    await db.query(`INSERT INTO sitewire_capital_partners (sitewire_id,name,on_our_lender,synced_at) VALUES ($1,$3,false,now()),($2,$3,false,now())
      ON CONFLICT (sitewire_id) DO UPDATE SET name=EXCLUDED.name`, [94001, 94002, ambName]);
    seededCp.push(94001, 94002);
    const r3 = await orchestrator.resolveCapitalPartnerId(ambName);
    ok(r3.id == null && r3.ambiguous === true, 'resolver: duplicate name with no on-our-lender winner stays ambiguous (never-guess)');

    // a confirmed link still HARD-wins over the directory
    await db.query(`INSERT INTO sitewire_partner_links (label_norm,label,sitewire_id) VALUES ($1,$2,$3)
      ON CONFLICT (label_norm) DO UPDATE SET sitewire_id=EXCLUDED.sitewire_id`, [normKey(ambName), ambName, cpIds.solo]);
    const r4 = await orchestrator.resolveCapitalPartnerId(ambName);
    ok(r4.id === cpIds.solo && r4.linked === true, 'resolver: a confirmed link still hard-wins over an ambiguous directory');

    // =========================================================================
    // #27 — GET /rules partners[] = active-file note buyers + ruled partners, NOT the whole directory
    // =========================================================================
    const rules = await api('GET', '/api/sitewire/rules', token);
    ok(rules.status === 200, 'GET /rules → 200 for super_admin');
    const labels = (rules.body.partners || []).map((p) => p.label);
    const has = (name) => labels.some((l) => normKey(l) === normKey(name));

    ok(has(dupName), '#27: alive-file note buyer IS listed');
    ok(has(soloName), '#27: FUNDED-file note buyer IS listed (draws are post-funding)');
    ok(has(rulePartner), '#27: a partner with an existing rule is kept (rule never orphaned)');
    ok(!has(nm('Declined Buyer')), '#27: declined-file note buyer is NOT listed');
    ok(!has(nm('Withdrawn Buyer')), '#27: withdrawn-file note buyer is NOT listed');
    ok(!has(nm('Deleted Buyer')), '#27: soft-deleted-file note buyer is NOT listed');
    // the OTHER (non-on-our-lender) duplicate directory id must not leak in as a separate row
    ok(!has(ambName), '#27: a directory-only partner (never on a file, no rule) is NOT listed');

    // the dup-name buyer resolves to the on-our-lender directory id in the enriched row
    const dupRow = (rules.body.partners || []).find((p) => normKey(p.label) === normKey(dupName));
    ok(dupRow && Number(dupRow.directory_id) === cpIds.dupOurs, '#26: /rules enriches the dup-name buyer with the on-our-lender directory id');
    ok(dupRow && dupRow.in_directory === true && dupRow.in_use === true, '#26: dup-name buyer marked in_directory + in_use');

    // no DUPLICATE investor name in the list (each normalized label appears once)
    const seen = {}; let dupCount = 0;
    for (const l of labels) { const k = normKey(l); if (seen[k]) dupCount++; seen[k] = true; }
    ok(dupCount === 0, '#26: no duplicate investor name in the rule-builder list');

    // =========================================================================
    // #26 — GET /capital-partners picker de-duplicates the directory by name
    // =========================================================================
    const dir = await api('GET', '/api/sitewire/capital-partners', token);
    ok(dir.status === 200, 'GET /capital-partners → 200');
    const dupInPicker = (dir.body.partners || []).filter((p) => normKey(p.name) === normKey(dupName));
    ok(dupInPicker.length === 1, '#26: picker shows the duplicated investor name exactly once');
    ok(dupInPicker[0] && Number(dupInPicker[0].sitewire_id) === cpIds.dupOurs, '#26: picker keeps the on-our-lender id for the duplicated name');

    console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
  } finally {
    // cleanup — leave the DB as we found it
    for (const id of seededApps) await db.query(`DELETE FROM applications WHERE id=$1`, [id]).catch(() => {});
    await db.query(`DELETE FROM sitewire_inspection_rules WHERE partner_label=$1`, [rulePartner]).catch(() => {});
    await db.query(`DELETE FROM sitewire_partner_links WHERE label_norm LIKE $1`, ['%' + normKey(TAG) + '%']).catch(() => {});
    for (const cid of seededCp) await db.query(`DELETE FROM sitewire_capital_partners WHERE sitewire_id=$1`, [cid]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE email=$1`, [`swscopeb_${TAG}@x.test`]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE id=$1`, [admin]).catch(() => {});
    server.close();
    await db.pool.end().catch(() => {});
  }
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
