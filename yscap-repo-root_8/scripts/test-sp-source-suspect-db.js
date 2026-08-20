'use strict';
/* DB integration test — the integrity audit must not report a package PILOT
 * built itself as corrupted, and when a file genuinely IS damaged the advice must
 * name an action the reader can actually take.
 *
 * Root cause it guards (owner-reported 2026-08-20, file YSCAP258134701 / Dovid
 * Turim: "TPR_YSCAP258134701_2026-07-21.zip — the FILE ITSELF appears corrupted
 * (content is pdf, not zip) … request a fresh copy from whoever uploaded it",
 * and "we're getting this lately a lot"). Two defects:
 *   1. sniffKind ran its tolerant "%PDF anywhere in the first 1KB" scan BEFORE
 *      the anchored ZIP signature, and lib/zip.js stores members UNCOMPRESSED,
 *      so a TPR export's first PDF sat ~70 bytes in and the package was judged a
 *      PDF. Every export whose first document is a PDF false-alarmed.
 *   2. The advice said to ask whoever uploaded it for a fresh copy — of a file
 *      NOBODY uploaded. PILOT generates it; the action is to re-run the export.
 *
 * Requires a throwaway Postgres in DATABASE_URL. No network — every Graph read
 * is stubbed to a HEALTHY mirror copy of the row's own bytes, so each case runs
 * the WHOLE audit and stops on the verdict it is actually about.
 * Run: DATABASE_URL=... node scripts/test-sp-source-suspect-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-sp-source-suspect-db (no DATABASE_URL)'); process.exit(0); }

process.env.SHAREPOINT_BACKUP_ENABLED = process.env.SHAREPOINT_BACKUP_ENABLED || '1';
process.env.MS_TENANT_ID = process.env.MS_TENANT_ID || 't';
process.env.MS_CLIENT_ID = process.env.MS_CLIENT_ID || 'pilot-app-id';
process.env.MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET || 's';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const backup = require('../src/lib/sharepoint-backup');
const sp = require('../src/lib/sharepoint');
const storage = require('../src/lib/storage');
const { zip } = require('../src/lib/zip');
const recheck = require('../src/lib/sp-source-suspect-recheck');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(3000, 0x41), Buffer.from('\n%%EOF\n')]);
// The real thing: our own writer, PDFs stored uncompressed.
const TPR_ZIP = zip([
  { name: 'Contract & Assignment/contract.pdf', data: pdfBytes },
  { name: 'TITLE/commitment.pdf', data: pdfBytes },
]);
const HEALTHY = { ok: true, base: '/x', configured: '/x', persistent: true };

(async () => {
  await ensureSchema();

  const email = 'spsuspect@example.test';
  const prior = (await db.query(`SELECT id FROM borrowers WHERE email=$1`, [email])).rows.map((r) => r.id);
  if (prior.length) {
    await db.query(`DELETE FROM sync_review_queue WHERE task_id IN (SELECT 'spdoc:'||d.id FROM documents d WHERE d.borrower_id = ANY($1))`, [prior]);
    await db.query(`DELETE FROM documents WHERE borrower_id = ANY($1)`, [prior]);
    await db.query(`DELETE FROM applications WHERE borrower_id = ANY($1)`, [prior]);
    await db.query(`DELETE FROM borrowers WHERE id = ANY($1)`, [prior]);
  }
  const b = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Dovid','Turim',$1) RETURNING id`, [email])).rows[0].id;
  const app = (await db.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [b])).rows[0].id;

  // Each document serves its OWN bytes, keyed on storage_ref — a single shared
  // stub would let a pass that read the wrong row still look right.
  const BY_REF = new Map();
  const realRead = storage._local.read, realProbe = storage._local.probe;
  storage._local.read = async (ref) => {
    if (!BY_REF.has(ref)) throw new Error(`ENOENT no such file ${ref}`);
    return BY_REF.get(ref);
  };
  storage._local.probe = () => HEALTHY;

  // The audit's remote read is stubbed to a HEALTHY mirror copy of each row's
  // OWN bytes — never to a 404. A 404 would divert verifyRow into its
  // item-missing branch, which raises its own review card and OVERWRITES the
  // verdict with 'item-missing', silently masking the very content check under
  // test (that is exactly what a first cut of this suite did). So every case
  // now runs the whole audit and stops on the verdict it is actually about.
  const BY_ITEM = new Map();                   // driveItem id -> the bytes it mirrors
  const realMeta = { itemMeta: sp.itemMeta, itemMetaByName: sp.itemMetaByName, findByPilotDocumentId: sp.findByPilotDocumentId };
  const metaFor = (itemId) => {
    const bytes = BY_ITEM.get(itemId);
    if (!bytes) { const e = new Error('itemNotFound'); e.status = 404; e.graphCode = 'itemNotFound'; throw e; }
    return {
      id: itemId, name: itemId, size: bytes.length,
      file: { hashes: { quickXorHash: sp.quickXorHash(bytes) } },
      parentReference: { driveId: 'drive1', id: 'parent-1' },
      webUrl: `https://ys.sharepoint.com/x/${itemId}`, eTag: '"1"',
      createdBy: { application: { id: process.env.MS_CLIENT_ID } },
      // NOT later than sharepoint_backed_up_at, or the modified-in-sharepoint
      // guard would answer 'ok' before the comparison this suite depends on.
      lastModifiedDateTime: new Date(Date.now() - 60 * 86400000).toISOString(),
      malware: null,
    };
  };
  sp.itemMeta = async (_drive, itemId) => metaFor(itemId);
  sp.itemMetaByName = async (_drive, _parent, name) => metaFor(name);
  sp.findByPilotDocumentId = async () => null;

  let seq = 0;
  const mkDoc = async ({ filename, contentType, bytes, docKind, sourceType }) => {
    const n = ++seq;
    const ref = `sus/${n}-${filename}`;
    const itemId = `item-${n}`;                // its OWN mirror copy, never a shared one
    BY_REF.set(ref, bytes);
    BY_ITEM.set(itemId, bytes);
    return (await db.query(
      `INSERT INTO documents (filename, content_type, doc_kind, source_type, storage_provider, storage_ref,
          size_bytes, application_id, borrower_id, is_current, sharepoint_backup_ref, sharepoint_parent_id,
          sharepoint_web_url, sharepoint_backed_up_at, sharepoint_verified_at)
       VALUES ($1,$2,$3,$4,'local',$5,$6,$7,$8,true,$9,'parent-1',
          'https://ys.sharepoint.com/x/'||$1, now() - interval '40 days', NULL)
       RETURNING id`,
      [filename, contentType, docKind, sourceType, ref, bytes.length, app, b,
       `sp:drive1:${itemId}`])).rows[0].id;
  };

  const auditOne = async (id) => {
    // Only this row — verifyOnce sweeps every due document in the shared test
    // database, which is how a suite corrupts its neighbours (2026-08-20).
    const rows = await backup.verifyBatch(2000);
    const row = rows.find((r) => r.id === id);
    if (!row) throw new Error(`doc ${id} was not selected by verifyBatch`);
    return backup.verifyRow(row);
  };
  const verdictOf = async (id) => (await db.query(
    `SELECT sharepoint_integrity AS i, sharepoint_verified_at AS v FROM documents WHERE id=$1`, [id])).rows[0];
  const cardOf = async (id) => (await db.query(
    `SELECT portal_value AS p, raw_value AS r FROM sync_review_queue WHERE task_id=$1 ORDER BY id DESC LIMIT 1`,
    [`spdoc:${id}`])).rows[0];
  const cardCount = async (id) => (await db.query(
    `SELECT count(*)::int AS n FROM sync_review_queue WHERE task_id=$1`, [`spdoc:${id}`])).rows[0].n;

  // === CASE A: the reported file — a real TPR export ==========================
  const tpr = await mkDoc({
    filename: 'TPR_YSCAP258134701_2026-07-21.zip', contentType: 'application/zip',
    bytes: TPR_ZIP, docKind: 'tpr_export', sourceType: 'system' });
  await auditOne(tpr);
  const a = await verdictOf(tpr);
  ok('A: a real TPR export is NOT reported as corrupted', !/source-suspect/.test(a.i || ''));
  ok('A: and no loan-officer card is raised for it', (await cardCount(tpr)) === 0);

  // === CASE B: a genuinely damaged upload still IS caught =====================
  // The detector must not have been blunted — this is the accident it exists for.
  const html = Buffer.from('<!doctype html>\n<html><body>Download failed</body></html>');
  const badUpload = await mkDoc({
    filename: 'insurance-binder.pdf', contentType: 'application/pdf',
    bytes: html, docKind: null, sourceType: 'borrower_upload' });
  await auditOne(badUpload);
  ok('B: an HTML error page saved as .pdf is still caught', /source-suspect/.test((await verdictOf(badUpload)).i || ''));
  const bCard = await cardOf(badUpload);
  ok('B: a human upload is still told to ask for a fresh copy',
    /request a fresh copy from whoever uploaded it/i.test(bCard.p || ''));
  ok('B: and the card does not claim PILOT made it', !JSON.parse(bCard.r).pilotMade);

  // === CASE C: a damaged file PILOT made — the ADVICE must be actionable ======
  const badExport = await mkDoc({
    filename: 'TPR_YSCAP999_2026-08-20.zip', contentType: 'application/zip',
    bytes: html, docKind: 'tpr_export', sourceType: 'system' });
  await auditOne(badExport);
  const cCard = await cardOf(badExport);
  ok('C: a damaged PILOT-generated file is still caught', /source-suspect/.test((await verdictOf(badExport)).i || ''));
  ok('C: it never tells anyone to chase an uploader who does not exist',
    !/whoever uploaded it/i.test(cCard.p || ''));
  ok('C: it says to re-run the export instead', /re-run the export/i.test(cCard.p || ''));
  ok('C: and the card records that PILOT made it, so the email can say so too',
    JSON.parse(cCard.r).pilotMade === true);

  // The email built from that card must carry the same, correct instruction.
  const mail = require('../src/lib/sync-review').sharepointDocEmail({
    borrowerName: 'Dovid Turim', portalValue: cCard.p, rawValue: cCard.r });
  ok('C: the loan-officer email says re-run the export', /re-run the export/i.test(mail.body));
  ok('C: and never tells them to ask the borrower to upload it again',
    !/ask the borrower to upload it again/i.test(mail.body) && !/whoever uploaded it/i.test(mail.body));

  // === CASE D: the one-shot re-check puts stale verdicts back in the queue ====
  // Simulate a document stamped by the OLD rule and long-since exiled.
  await db.query(
    `UPDATE documents SET sharepoint_integrity='source-suspect: content looks like pdf, not zip', sharepoint_verified_at=now()
      WHERE id=$1`, [tpr]);
  await db.query(`DELETE FROM sync_runtime_state WHERE key=$1`, [recheck.STATE_KEY]);
  const r1 = await recheck.recheckSourceSuspectOnce();
  ok('D: the pass re-queues the stale verdict', r1.requeued >= 1);
  ok('D: by clearing the audit stamp, so the audit re-judges it', (await verdictOf(tpr)).v === null);
  const r2 = await recheck.recheckSourceSuspectOnce();
  ok('D: and it is ONE-SHOT — a second boot does nothing', r2.skipped === true && r2.reason === 'already_ran');

  // Re-audited under the fixed rule, the false verdict clears itself.
  await auditOne(tpr);
  ok('D: the re-audit clears the false verdict', !/source-suspect/.test((await verdictOf(tpr)).i || ''));

  // ...and the loan officer's card goes away on its own. This is the outcome the
  // owner actually sees ("why are we still getting these errors?"), so it is
  // asserted end-to-end rather than assumed from the verdict: the standing
  // re-check closes a sharepoint_doc card only on a genuinely-good integrity
  // verdict, which is exactly what the fixed sniffer now produces.
  // The card the OLD rule raised. ON CONFLICT DO NOTHING because the queue keeps
  // one open row per document by design — under a broken sniffer the audit above
  // has already raised its own, and the point of this block is the card that is
  // OPEN, not which pass put it there.
  await db.query(
    `INSERT INTO sync_review_queue (application_id, borrower_id, task_id, direction, field_key,
        reason, portal_value, raw_value, status)
     VALUES ($1,$2,$3,'outbound','sharepoint_doc','sharepoint_mirror_failed',$4,$5,'open')
     ON CONFLICT ((coalesce(task_id,'')), field_key, direction, (coalesce(proposed_value,'')))
       WHERE status='open' DO NOTHING`,
    [app, b, `spdoc:${tpr}`,
     'TPR_YSCAP258134701_2026-07-21.zip — the FILE ITSELF appears corrupted (content is pdf, not zip).',
     JSON.stringify({ docId: tpr, kind: 'source-suspect' })]);
  const staleCard = (await db.query(
    `SELECT id FROM sync_review_queue WHERE task_id=$1 AND status='open' ORDER BY id DESC LIMIT 1`,
    [`spdoc:${tpr}`])).rows[0];
  ok('D: (control) a stale card really is open before the re-check', !!staleCard);
  const rr = staleCard ? await require('../src/lib/sync-review-recheck').recheckReview({
    id: staleCard.id, task_id: `spdoc:${tpr}`, field_key: 'sharepoint_doc',
    raw_value: JSON.stringify({ docId: tpr, kind: 'source-suspect' }) }) : null;
  ok('D: the officer\'s false card closes itself once the verdict is good', !!rr && rr.outcome === 'closed');
  ok('D: and the card really is off the queue', !!staleCard &&
    (await db.query(`SELECT status FROM sync_review_queue WHERE id=$1`, [staleCard.id])).rows[0].status !== 'open');

  const off = process.env.SP_SOURCE_SUSPECT_RECHECK_DISABLED;
  process.env.SP_SOURCE_SUSPECT_RECHECK_DISABLED = '1';
  ok('D: the kill switch works', (await recheck.recheckSourceSuspectOnce()).reason === 'disabled');
  if (off === undefined) delete process.env.SP_SOURCE_SUSPECT_RECHECK_DISABLED; else process.env.SP_SOURCE_SUSPECT_RECHECK_DISABLED = off;

  Object.assign(sp, realMeta);
  storage._local.read = realRead; storage._local.probe = realProbe;
  console.log(`\n${pass} passed, ${fail} failed`);
  await db.end?.();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
