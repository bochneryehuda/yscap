'use strict';
/**
 * THREE OWNER-DIRECTED DRAW/CLOSING CHANGES (2026-08-12), end to end against a real Postgres.
 *
 * PART 3 — the pipeline completion % must NOT count the DOCUMENT-review gate.
 *   Owner: "the document finding section should not reduce the percentage of the file … only
 *   conditions and appraisal findings and required stuff." Document findings feed the ONE checklist
 *   item `underwriting_review_cleared`, which sat open and dragged a CTC-ready file down to ~52%.
 *   The pipeline row query (and the XLSX export) now exclude that ONE code, while keeping every real
 *   condition AND the appraisal gate (`appraisal_review_cleared`).
 *
 * PART 1 — a "Refresh PA date" button on the draw desk re-reads the Encompass PA date (READ-ONLY)
 *   so PILOT recognizes a file that has since been sold. The route hands back the recomputed release
 *   state, which now carries `paConfigured` so the button can hide where the field id is unset.
 *
 * PART 4 — a "Refresh from ClickUp" button in the funded-date reconciliation re-pulls the card. The
 *   route reports a friendly reason when the file has no linked card, and the closing workspace now
 *   exposes `clickup_linked` so the button shows only when there is a card to pull by.
 *
 * DB-gated: skips cleanly when DATABASE_URL is unset (no in-memory Postgres in this repo).
 */
if (!process.env.DATABASE_URL) { console.log('test-draw-closing-refresh-db: SKIP (no DATABASE_URL)'); process.exit(0); }

const db = require('../src/db');
const { signJwt } = require('../src/lib/crypto');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const uniq = `dcr-${process.pid}-${Date.now()}`;

(async () => {
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const admin = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Ada Admin','super_admin',true) RETURNING id`,
    [`${uniq}-admin@example.test`])).rows[0].id;
  const borrower = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Bo','Rrower',$1) RETURNING id`,
    [`${uniq}-bo@example.test`])).rows[0].id;
  const appId = (await db.query(
    `INSERT INTO applications (borrower_id, ys_loan_number, property_address, status, loan_type, program, term)
     VALUES ($1,$2,$3,'underwriting','Purchase','Gold Standard','12 Months') RETURNING id`,
    [borrower, `YSCAP${String(process.pid).slice(-6)}`,
     JSON.stringify({ oneLine: '9 Draw St, Lakewood, NJ 08701', street: '9 Draw St', city: 'Lakewood', state: 'NJ', zip: '08701' })])).rows[0].id;

  const jwt = signJwt({ sub: admin, kind: 'staff', role: 'super_admin', tv: 0, sid: 'test' });
  const call = async (method, path, body) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${jwt}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let j = null; try { j = await r.json(); } catch (_) {}
    return { status: r.status, body: j };
  };

  /* ─────────────── PART 3: the pipeline completion percentage ─────────────── */
  const tmpl = async (code) => (await db.query(`SELECT id FROM checklist_templates WHERE code=$1`, [code])).rows[0].id;
  const mkItem = async (code, done) => {
    const tid = await tmpl(code);
    await db.query(
      `INSERT INTO checklist_items (application_id, template_id, label, audience, item_kind, scope, status, signed_off_at)
       VALUES ($1,$2,$3,'staff','condition','application',$4,$5)`,
      [appId, tid, code, done ? 'satisfied' : 'outstanding', done ? new Date() : null]);
  };
  // The document-review gate (EXCLUDED), the appraisal gate (INCLUDED, not done), and a real
  // signed-off condition (INCLUDED + done).
  await mkItem('underwriting_review_cleared', false);
  await mkItem('appraisal_review_cleared', false);
  await mkItem('rtl_p1_contract', true);

  {
    const r = await call('GET', `/api/staff/applications?limit=1000`);
    assert(r.status === 200, 'the pipeline list answers');
    const row = (r.body || []).find((x) => x.id === appId);
    assert(row, 'our file is in the pipeline list');
    // 3 items on the file; underwriting_review_cleared is excluded → 2 count, 1 of them is done.
    assert(row.total_items === 2,
      `the document-review gate does NOT count toward total_items (got ${row && row.total_items}, want 2 — appraisal gate + the signed condition)`);
    assert(row.done_items === 1,
      `done_items counts the signed condition only, not the excluded doc-review gate (got ${row && row.done_items}, want 1)`);
  }

  // Even after the doc-review gate is SIGNED OFF it must not enter the count (it is excluded on
  // BOTH sides) — so a document-review sign-off can never move the percentage either way.
  await db.query(
    `UPDATE checklist_items SET status='satisfied', signed_off_at=now()
      WHERE application_id=$1 AND template_id=(SELECT id FROM checklist_templates WHERE code='underwriting_review_cleared')`,
    [appId]);
  {
    const r = await call('GET', `/api/staff/applications?limit=1000`);
    const row = (r.body || []).find((x) => x.id === appId);
    assert(row && row.total_items === 2 && row.done_items === 1,
      'signing off the document-review gate leaves the percentage unchanged — it is excluded on both sides');
  }

  /* ─────────────── PART 1: the read-only "Refresh PA date" route ─────────────── */
  {
    const r = await call('POST', `/api/sitewire/files/${appId}/refresh-pa-date`, {});
    assert(r.status === 200, 'the PA-date refresh route answers');
    assert(r.body && r.body.ok === true, 'it reports ok');
    // Encompass is unconfigured in the test env, so the read-only pull cannot run — the route must
    // report that gracefully (never 500), and still hand back the recomputed release state.
    assert(r.body && r.body.pulled === false && typeof r.body.reason === 'string' && r.body.reason.length > 0,
      'with Encompass unconfigured the route reports pulled=false WITH a friendly reason (never a 500)');
    assert(r.body && r.body.release && typeof r.body.release === 'object',
      'the route hands back the recomputed release state so the card can re-check the sold status');
    assert(r.body.release && typeof r.body.release.paConfigured === 'boolean',
      'the release state carries paConfigured so the button can hide where the PA-date field id is unset');
  }

  /* ─────────────── PART 4: closing workspace + "Refresh from ClickUp" ─────────────── */
  {
    const r = await call('GET', `/api/staff/applications/${appId}/closing`);
    assert(r.status === 200, 'the closing workspace answers');
    assert(r.body && r.body.clickup_linked === false,
      'a file with no linked ClickUp card reports clickup_linked=false (button hidden)');

    const rc = await call('POST', `/api/staff/applications/${appId}/closing/reclickup-refresh`, {});
    assert(rc.status === 200 && rc.body && rc.body.pulled === false && /not linked to a ClickUp card/i.test(rc.body.reason || ''),
      'refreshing from ClickUp on an unlinked file reports a friendly reason, not a crash');

    // Link a card and confirm the workspace flips clickup_linked → true (so the button appears).
    await db.query(`UPDATE applications SET clickup_pipeline_task_id=$2 WHERE id=$1`, [appId, `tsk-${uniq}`]);
    const r2 = await call('GET', `/api/staff/applications/${appId}/closing`);
    assert(r2.body && r2.body.clickup_linked === true,
      'once a ClickUp card is linked, clickup_linked flips to true (button shows)');
  }

  await server.close();
  if (failures) { console.error(`\ntest-draw-closing-refresh-db: ${failures} FAILURE(S).`); process.exit(1); }
  console.log('\nAll draw/closing refresh DB checks passed.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
