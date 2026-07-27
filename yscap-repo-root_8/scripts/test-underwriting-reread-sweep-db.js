'use strict';
/**
 * DB test for the un-funded RE-READ SWEEP (src/lib/underwriting/reread-sweep.js,
 * owner decision 2026-07-27).
 *
 * Proves the five requirements the owner set for the sweep:
 *   1. scope   — ALIVE + not-yet-funded only (funded / withdrawn / declined / cancelled excluded)
 *   2. re-read — re-reads ALREADY-analysed docs too (via the real buildAutoReadQueue includeAnalyzed
 *                + analyzeOneDocument force), not just never-read ones
 *   3. idempotent — a second pass re-reads NOTHING (the generation stamp is the cursor)
 *   4. cost cap  — a file over the per-file cap is skipped + stamped (not re-read), never re-selected
 *   5. safe     — reader-off / disabled → clean no-op; never notifies / clears / moves status
 *
 * Uses the REAL selection + buildAutoReadQueue (so the includeAnalyzed edit is exercised) with a
 * STUBBED analyzeOneDocument (there is no live Azure reader in CI). Requires DATABASE_URL; skips otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-underwriting-reread-sweep-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const sweep = require('../src/lib/underwriting/reread-sweep');
const realUw = require('../src/routes/underwriting');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const TAG = `rr${process.pid}`;

// The re-read calls the stub records, so a test can assert exactly which (file, doc) were re-read.
let calls = [];
function makeUw({ costDenyAppIds = new Set() } = {}) {
  return {
    ...realUw,   // real fileForById / fileDocById / buildAutoReadQueue / AUTOREAD_* — only analyze is stubbed
    analyzeOneDocument: async (app, doc, docType, opts) => {
      calls.push({ appId: app.id, docId: doc.id, docType, force: !!(opts && opts.force), actorId: (opts && opts.actorId) || null });
      return { ok: true, cached: false, findings: [] };
    },
    // cost gate is injected separately via sweepOnce opts.costAllow; keep this here for clarity.
    _costDeny: costDenyAppIds,
  };
}

async function seedFile(kind, status) {
  const bor = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ($1,$2,$3) RETURNING id`,
    [kind, TAG, `${kind}_${TAG}@example.com`])).rows[0];
  const app = (await db.query(
    'INSERT INTO applications (borrower_id, status) VALUES ($1,$2) RETURNING id', [bor.id, status])).rows[0];
  // One bank statement, already ANALYSED (a current extraction) — the "stale answer" case the sweep re-reads.
  const item = (await db.query(
    `INSERT INTO checklist_items (scope, label, audience, item_kind, application_id, status)
     VALUES ('application','Assets','staff','document',$1,'received') RETURNING id`, [app.id])).rows[0];
  const doc = (await db.query(
    `INSERT INTO documents (application_id, checklist_item_id, filename, doc_kind, visibility, review_status, is_current, slot_label, storage_ref, sha256)
     VALUES ($1,$2,'bank.pdf','bank_statement','staff_only','accepted',true,'Bank statement','x/y',$3) RETURNING id`,
    [app.id, item.id, `sha${kind}${TAG}`])).rows[0];
  await db.query(
    `INSERT INTO document_extractions (document_id, application_id, doc_type, status, confidence, is_current, superseded, fields, analyzer_version)
     VALUES ($1,$2,'bank_statement','analyzed','definite',true,false,'{"closingBalance":1000}'::jsonb,'old-version')`,
    [doc.id, app.id]);
  return { appId: app.id, docId: doc.id };
}

async function stampGen(appId) {
  return (await db.query('SELECT generation, docs_read, last_error FROM underwriting_reread_state WHERE application_id=$1', [appId])).rows[0] || null;
}

(async () => {
  await ensureSchema();
  const GEN = sweep.REREAD_GENERATION;

  // Scope: two alive+unfunded, one funded, one withdrawn.
  const alive1 = await seedFile('alivea', 'underwriting');
  const alive2 = await seedFile('aliveb', 'in_review');
  const funded = await seedFile('funded', 'funded');
  const dead = await seedFile('dead', 'withdrawn');

  // --- 1+2: a slice re-reads only the alive+unfunded files, INCLUDING their already-analysed docs, with force ---
  calls = [];
  const uw = makeUw();
  const r1 = await sweep.sweepOnce({ uw, readerOn: true, batchFiles: 50 });
  const readApps = new Set(calls.map((c) => c.appId));
  ok(readApps.has(alive1.appId) && readApps.has(alive2.appId), 'both alive+unfunded files were re-read');
  ok(!readApps.has(funded.appId), 'a FUNDED file is NOT re-read (done — never re-bill)');
  ok(!readApps.has(dead.appId), 'a WITHDRAWN file is NOT re-read (dead — nobody working it)');
  ok(calls.length > 0 && calls.every((c) => c.force === true), 're-read forces a genuine read (bypasses the cache)');
  ok(calls.every((c) => c.actorId === null), 're-read runs as no-one (no borrower/staff notification path)');
  ok(calls.some((c) => c.appId === alive1.appId && c.docId === alive1.docId),
    'an ALREADY-analysed document is re-read (includeAnalyzed), not skipped');
  const g1 = await stampGen(alive1.appId);
  ok(g1 && g1.generation === GEN, `alive file is stamped to the current generation (${GEN})`);
  ok(r1 && r1.remaining === 0 && r1.done === true, 'sweep reports the book caught up (remaining 0)');

  // --- 3: idempotent — a second pass re-reads nothing ---
  calls = [];
  const r2 = await sweep.sweepOnce({ uw, readerOn: true, batchFiles: 50 });
  ok(calls.length === 0, 'second pass re-reads NOTHING — the generation stamp makes it a no-op (idempotent)');
  ok(r2 && r2.filesRead === 0, 'second pass reports 0 files read');

  // --- 4: per-file cost cap — a file over cap is skipped + stamped, and never re-selected ---
  const capped = await seedFile('capped', 'processing');
  calls = [];
  const costAllow = async (id) => id !== capped.appId;   // capped file is over its per-file AI cap
  const r3 = await sweep.sweepOnce({ uw, readerOn: true, batchFiles: 50, costAllow });
  ok(!calls.some((c) => c.appId === capped.appId), 'a file over its cost cap is NOT re-read');
  const gc = await stampGen(capped.appId);
  ok(gc && gc.generation === GEN && gc.last_error === 'cost_cap_reached',
    'the cost-capped file is stamped with last_error=cost_cap_reached (recorded, not silently retried forever)');
  ok(r3 && r3.capped >= 1, 'sweep reports the capped count');
  // re-run: capped file is stamped, so not re-selected
  calls = [];
  await sweep.sweepOnce({ uw, readerOn: true, batchFiles: 50, costAllow });
  ok(calls.length === 0, 'the capped file is not re-selected on the next pass');

  // --- 5: reader off / disabled → clean no-op ---
  // Force a below-generation file so there IS work, then prove reader-off/disabled skip it.
  await db.query('DELETE FROM underwriting_reread_state WHERE application_id=$1', [alive1.appId]);
  calls = [];
  const off = await sweep.sweepOnce({ uw, readerOn: false, batchFiles: 50 });
  ok(off && off.skipped === 'reader_off' && calls.length === 0, 'reader OFF → clean no-op (never a paid call we cannot fulfil)');
  process.env.UNDERWRITING_REREAD_SWEEP_DISABLED = '1';
  const dis = await sweep.sweepOnce({ uw, readerOn: true, batchFiles: 50 });
  ok(dis && dis.skipped === 'disabled' && calls.length === 0, 'kill-switch env → clean no-op');
  delete process.env.UNDERWRITING_REREAD_SWEEP_DISABLED;

  // pendingCount reflects the un-stamped alive file we just cleared.
  const pending = await sweep.pendingCount();
  ok(typeof pending === 'number' && pending >= 1, 'pendingCount counts alive+unfunded files still below the generation');

  // cleanup — children first (documents/checklist_items don't all cascade), then apps, then borrowers.
  const appIds = (await db.query(
    `SELECT a.id FROM applications a JOIN borrowers b ON b.id=a.borrower_id WHERE b.last_name=$1`, [TAG])).rows.map((r) => r.id);
  if (appIds.length) {
    await db.query(`DELETE FROM documents WHERE application_id = ANY($1)`, [appIds]);
    await db.query(`DELETE FROM checklist_items WHERE application_id = ANY($1)`, [appIds]);
    await db.query(`DELETE FROM applications WHERE id = ANY($1)`, [appIds]);
  }
  await db.query(`DELETE FROM borrowers WHERE last_name=$1`, [TAG]);

  console.log(`\n${failures === 0 ? 'OK' : 'FAIL'}  underwriting-reread-sweep-db: ${failures} failure(s)`);
  await db.pool.end();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
