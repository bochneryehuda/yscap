'use strict';
/**
 * The vesting entity's documents must actually be READABLE by its own file
 * (owner-reported 2026-07-26, reproduced against a real database before fixing).
 *
 * The owner: *"the AI review says EIN / formation / operating agreement are all missing while the
 * file has dedicated LLC section slots. It is not connected to them."* All three were sitting in
 * their labelled slots. Two separate breaks, each of which alone makes the desk go blind:
 *
 *   1. The LLC section's documents carry `application_id NULL` + `llc_id`, and were resolved only
 *      through the BORROWER branch of `fileDoc`. So whenever the entity is filed under a different
 *      borrower record — a co-borrower's profile, a layered owning entity — every LLC document was
 *      queued for reading and then failed to resolve. Nothing was ever read, so the entity chain
 *      reported "no operating agreement on file" forever.
 *   2. The LLC upload accepts a `slot` WITHOUT a checklist item, which leaves the document with no
 *      condition code and no doc_kind — nothing at all saying what it is — so the reader skipped it
 *      as unidentifiable even though a human had put it in the "Operating Agreement" slot.
 *
 * DB-gated: a pure test cannot catch either one (the first is a SQL predicate, the second needs the
 * real documents/checklist_items shape). SKIPs cleanly with no DATABASE_URL.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-llc-documents-readable-db (no DATABASE_URL)'); process.exit(0); }

const R = require('path').resolve(__dirname, '..');
const db = require(R + '/src/db');
const { selectAutoReadQueue } = require(R + '/src/lib/underwriting/auto-read');
const { expectedDocTypeForCode } = require(R + '/src/lib/underwriting/condition-map');
const registry = require(R + '/src/lib/underwriting/registry');
const { fileDocForTest } = require(R + '/src/routes/underwriting');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const rnd = () => Math.floor(Math.random() * 1e9);
const SLOTS = ['rtl_llc_formation', 'rtl_llc_ein', 'rtl_llc_opagmt'];

async function build({ entityUnderOtherBorrower = false, noChecklistItem = false }) {
  const q = (t, p) => db.query(t, p);
  const bor = (await q(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Moses','Weil',$1) RETURNING id`,
    [`uwtest${rnd()}@example.com`])).rows[0];
  const owner = entityUnderOtherBorrower
    ? (await q(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Co','Borrower',$1) RETURNING id`,
        [`uwtest${rnd()}@example.com`])).rows[0]
    : bor;
  const llc = (await q(`INSERT INTO llcs (borrower_id, llc_name) VALUES ($1,'MW TRADING LLC') RETURNING id`,
    [owner.id])).rows[0];
  const app = (await q(
    `INSERT INTO applications (borrower_id, llc_id, property_address, loan_amount, status)
     VALUES ($1,$2,'{"street":"1 Main St"}'::jsonb, 300000, 'processing') RETURNING id, borrower_id, llc_id`,
    [bor.id, llc.id])).rows[0];

  for (const code of SLOTS) {
    const t = (await q(`SELECT id FROM checklist_templates WHERE code=$1 LIMIT 1`, [code])).rows[0];
    if (!t) continue;
    let ciId = null;
    if (!noChecklistItem) {
      ciId = (await q(
        `INSERT INTO checklist_items (llc_id, template_id, scope, label, status)
         VALUES ($1,$2,'llc',$3,'outstanding') RETURNING id`, [llc.id, t.id, code])).rows[0].id;
    }
    // Exactly what staff.js POST /llcs/:id/documents writes: no application_id, no doc_kind.
    await q(
      `INSERT INTO documents (checklist_item_id, llc_id, borrower_id, filename, content_type, size_bytes,
                              storage_provider, storage_ref, uploaded_by_kind, visibility, is_current, slot_label)
       VALUES ($1,$2,$3,$4,'application/pdf',1000,'local','ref/x','staff','borrower',true,$5)`,
      [ciId, llc.id, owner.id, `${code}.pdf`, code]);
  }
  return app;
}

// The file-view / auto-read document query, verbatim from routes/underwriting.js buildAutoReadQueue.
async function queueFor(app) {
  const docs = await db.query(
    `SELECT d.id, d.filename, d.doc_kind, d.slot_label, d.page_bounded, t.code AS condition_code
       FROM documents d
       LEFT JOIN checklist_items ci ON ci.id = d.checklist_item_id
       LEFT JOIN checklist_templates t ON t.id = ci.template_id
      WHERE d.is_current = true AND COALESCE(d.review_status,'') <> 'rejected'
        AND COALESCE(d.source_type,'') <> 'chat_attachment'
        AND ( d.application_id = $1 OR ci.application_id = $1 OR (d.llc_id IS NOT NULL AND d.llc_id = $2) )
      ORDER BY d.created_at`, [app.id, app.llc_id || null]);
  return { docs: docs.rows,
    queue: selectAutoReadQueue({ documents: docs.rows, analyzedIds: new Set(), isReadable: (t) => !!registry.get(t) }) };
}

async function readableCount(app, queue) {
  let n = 0;
  for (const item of queue) if (await fileDocForTest(app, item.id)) n++;
  return n;
}

(async function main() {
  // ---------- 1. the ordinary file ----------
  const a1 = await build({});
  const r1 = await queueFor(a1);
  ok(r1.queue.length === 3, `the three LLC slot documents are queued to read (got ${r1.queue.length})`);
  ok(await readableCount(a1, r1.queue) === 3, 'and all three can actually be read');
  ok(r1.queue.map((q) => q.expectedType).sort().join(',') === 'ein_letter,llc_formation,operating_agreement',
    `each is read as the right kind of document (got ${r1.queue.map((q) => q.expectedType).sort().join(',')})`);

  // ---------- 2. the entity filed under a DIFFERENT borrower record ----------
  // A co-borrower's profile, or a layered owning entity. Before the fix all three were queued and
  // then silently failed to resolve, so the desk said they were missing — forever.
  const a2 = await build({ entityUnderOtherBorrower: true });
  const r2 = await queueFor(a2);
  ok(r2.queue.length === 3, `a co-borrower-owned entity's documents are still queued (got ${r2.queue.length})`);
  const n2 = await readableCount(a2, r2.queue);
  ok(n2 === 3,
    `and are READABLE by the file that vests into that entity (got ${n2}/3) — this is the owner's "not connected to them"`);

  // ---------- 3. filed into a slot with NO checklist item ----------
  // The LLC upload accepts a `slot` without one; that document had nothing saying what it was.
  const a3 = await build({ noChecklistItem: true });
  const r3 = await queueFor(a3);
  ok(r3.docs.length === 3, 'the documents are visible to the file');
  ok(r3.queue.length === 3,
    `a document in a labelled slot with no checklist item is still identified (got ${r3.queue.length}) — the slot label says what it is`);
  ok(await readableCount(a3, r3.queue) === 3, 'and can be read');

  // ---------- the boundary: this must NOT open the door wider ----------
  // Another borrower's unrelated entity document is not readable by this file just because the file
  // has an LLC. The vesting-entity branch is scoped to THIS file's own llc_id.
  const other = await build({});
  const rOther = await queueFor(other);
  const strangerDoc = rOther.queue[0];
  ok(!(await fileDocForTest(a1, strangerDoc.id)),
    'a DIFFERENT file\'s entity document is still not readable — the new branch is scoped to this file\'s own entity');
  // …and a file with NO entity at all can't reach entity documents through a null llc_id.
  ok(!(await fileDocForTest({ id: a1.id, borrower_id: a1.borrower_id, llc_id: null }, strangerDoc.id)),
    'a file with no vesting entity resolves nothing through the entity branch (a null llc_id matches nothing)');

  console.log(`test-llc-documents-readable-db: ${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await db.pool.end(); } catch (_) {} process.exit(1); });
