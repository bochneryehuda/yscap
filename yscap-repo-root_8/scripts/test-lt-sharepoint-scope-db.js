'use strict';
/**
 * THE ONE SHAREPOINT MIRROR LEARNS THE lt_loan SCOPE — real Postgres, the real
 * mirror code, the real folder resolver, a stubbed Graph. Skips with no DATABASE_URL.
 *
 * The owner, 2026-08-30 (docs/longterm/SHARE-THE-CODE-DIRECTIVE.md):
 *   *"Same thing is with SharePoint: you need to share the code."*
 *   *"The SharePoint looks for the same exact folder, same exact logic that we
 *    build up on the short-term side."*
 *
 * THE DANGER THIS SUITE EXISTS TO CLOSE. `pendingBatch` selects EVERY documents
 * row with a storage_ref, and before this shipment `scopeKeyFor` knew nothing of
 * lt_loan_id — so the FIRST long-term document ever written would have thrown
 * "no application or borrower to file under" on every sweep, exhausted its eight
 * attempts, gone terminally DEAD (DEAD never reverts), and held the backlog SLO
 * in permanent breach, emailing every admin about a document nothing could ever
 * fix. Every assertion below is aimed at that.
 *
 * What is proven here, because none of it can be proven by a pure test:
 *   1. an lt_loan document mirrors into the SAME Pipeline Drive tree an RTL
 *      document does — Officer / Borrower / Address / sync leaf / category —
 *      resolved by the REAL sharepoint-map (only Graph itself is stubbed);
 *   2. an RTL document's path is BYTE-IDENTICAL to the pre-change mirror's;
 *   3. the SHARED borrower profile names the folder when the loan is linked to
 *      one, and the loan number is the address folder's fallback (both products,
 *      one rule);
 *   4. an unresolvable long-term document PARKS as skipped with the named reason
 *      `lt_unresolved_scope` — never attempted, never retried, never stuck, and
 *      never in the backlog the SLO watchdog measures;
 *   5. the drain selector and sp-mirror-queue's claimableWhere agree about all of
 *      it, which is the LOCK-STEP that file demands of itself;
 *   6. the JS twin (identitiesResolved) and the SQL twin (unresolvedSql) give the
 *      same verdict on the same rows;
 *   7. the shelf sweep moves a long-term copy exactly as it moves an RTL one;
 *   8. nothing, anywhere in any of it, was deleted.
 *
 * NAMED test-lt-* deliberately: the separation gate reads a test's FILENAME as its
 * product, and this one inserts lt_loans / lt_properties rows and requires
 * src/longterm/sharepoint-scope.js. Any other name would be read as RTL code
 * reaching into the Long-Term side, and the gate would be right to fail it.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-lt-sharepoint-scope-db (no DATABASE_URL)'); process.exit(0); }

const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-lt-store-'));
process.env.STORAGE_DIR = tmpStore;
process.env.SHAREPOINT_BACKUP_ENABLED = '1';
process.env.MS_TENANT_ID = 't'; process.env.MS_CLIENT_ID = 'c'; process.env.MS_CLIENT_SECRET = 's';
process.env.SHAREPOINT_STAMP_METADATA = '0';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const storage = require('../src/lib/storage');
const map = require('../src/lib/sharepoint-map');
const sp = require('../src/lib/sharepoint');
const backup = require('../src/lib/sharepoint-backup');
const queue = require('../src/lib/sp-mirror-queue');
const ltScope = require('../src/longterm/sharepoint-scope');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const eq = (got, want, m) => assert(got === want, `${m}${got === want ? '' : `\n       got:  ${JSON.stringify(got)}\n       want: ${JSON.stringify(want)}`}`);

/* ── a tiny in-memory SharePoint, rooted at the real Pipeline Drive ───────────
   Only GRAPH is stubbed. sharepoint-map's officer/borrower/address matching and
   folder creation all run for real against this tree, so the asserted path is
   the path the resolver actually builds. */
const tree = { folders: new Map(), items: new Map() };
tree.folders.set('root', { id: 'root', name: 'Pipeline Drive', parent: null });
const folderPath = (id) => {
  const parts = [];
  let cur = tree.folders.get(id);
  while (cur) { parts.unshift(cur.name); cur = cur.parent ? tree.folders.get(cur.parent) : null; }
  return parts.join('/');
};
/** Where a document's copy sits, as a human would read it in Explorer. */
const whereIs = async (docId) => {
  const r = (await db.query('SELECT sharepoint_parent_id FROM documents WHERE id=$1', [docId])).rows[0];
  return folderPath(r.sharepoint_parent_id);
};

sp.resolveDrive = async () => ({ driveId: 'drive1' });
sp.itemByPath = async (_d, p) => {
  if (String(p) !== 'Pipeline Drive') throw new Error(`unexpected root path ${p}`);
  return tree.folders.get('root');
};
sp.listChildren = async (_d, parentId) => [...tree.folders.values()]
  .filter((f) => f.parent === parentId)
  .map((f) => ({ id: f.id, name: f.name, isFolder: true, webUrl: `https://sp.example/${f.id}` }));
sp.ensureChildFolder = async (_d, parentId, name) => {
  for (const f of tree.folders.values()) if (f.parent === parentId && f.name === name) return f;
  const id = `f${tree.folders.size + 1}`;
  const f = { id, name, parent: parentId };
  tree.folders.set(id, f);
  return f;
};
let uploads = 0;
sp.uploadNew = async (_d, parentId, name, bytes) => {
  uploads += 1;
  const id = `item${uploads}`;
  tree.items.set(id, { id, name, parent: parentId });
  return { item: { id, webUrl: `https://sp.example/${id}`, size: bytes.length }, conflict: false };
};
sp.itemMetaByName = async () => null;
let deletes = 0;
sp.remove = async () => { deletes += 1; throw new Error('remove is a no-op'); };
sp.moveOwnItem = async (_d, itemId, newParentId, { expectedParentId }) => {
  const it = tree.items.get(itemId);
  if (!it) { const e = new Error('itemNotFound'); e.status = 404; throw e; }
  if (it.parent !== expectedParentId) throw new Error(`moveOwnItem refused: item is not in the expected portal-managed folder (found parent ${it.parent})`);
  it.parent = newParentId;
  return { id: itemId, webUrl: `https://sp.example/${itemId}` };
};

// Fixed ids: the suite deletes its own rows first and last, so a shared test
// database is left exactly as found and a re-run never inherits a stale folder
// cache pointing at the PREVIOUS run's in-memory folder ids.
const OFFICER_RTL = '65a71000-0000-4000-8000-00000000f001';
const OFFICER_LT = '65a71000-0000-4000-8000-00000000f002';
const BORR_RTL = '65a71000-0000-4000-8000-00000000f003';
const BORR_SHARED = '65a71000-0000-4000-8000-00000000f004';
const APP = '65a71000-0000-4000-8000-00000000f005';
const LOAN_A = '65a71000-0000-4000-8000-00000000f006';   // resolvable, its own borrower names
const LOAN_B = '65a71000-0000-4000-8000-00000000f007';   // resolvable via the SHARED profile + loan number
const LOAN_C = '65a71000-0000-4000-8000-00000000f008';   // names nobody: no borrower, no place
const LOANS = [LOAN_A, LOAN_B, LOAN_C];

// THE CONTROL. This is the path the mirror produced for this exact RTL fixture
// BEFORE the lt_loan scope was taught to it (measured 2026-08-30 by running this
// suite against the pre-change sharepoint-backup.js — see the commit's proofs).
// It is written out in full, on purpose: an RTL document's folder is the thing
// this shipment was forbidden to move, and a literal is the only assertion that
// can catch it moving.
const RTL_CONTROL_PATH = 'Pipeline Drive/Rtl Control Officer/Rtl Control/12 Control Rd/Synced by Pilot/Insurance/Waiting for review';

async function cleanup() {
  await db.query(`DELETE FROM documents WHERE lt_loan_id = ANY($1::uuid[]) OR application_id = $2::uuid`, [LOANS, APP]);
  await db.query(`DELETE FROM checklist_items WHERE lt_loan_id = ANY($1::uuid[]) OR application_id = $2::uuid`, [LOANS, APP]);
  await db.query(`DELETE FROM sharepoint_condition_state WHERE scope_key = ANY($1::text[])`,
    [[...LOANS.map((l) => `lt:${l}`), `app:${APP}`]]);
  await db.query(`DELETE FROM sharepoint_folder_cache WHERE scope_key = ANY($1::text[])`,
    [[...LOANS.map((l) => `lt:${l}`), `app:${APP}`]]);
  await db.query(`DELETE FROM lt_properties WHERE loan_id = ANY($1::uuid[])`, [LOANS]);
  await db.query(`DELETE FROM lt_loans WHERE id = ANY($1::uuid[])`, [LOANS]);
  await db.query(`DELETE FROM applications WHERE id = $1::uuid`, [APP]);
  await db.query(`DELETE FROM borrowers WHERE id = ANY($1::uuid[])`, [[BORR_RTL, BORR_SHARED]]);
  await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [[OFFICER_RTL, OFFICER_LT]]);
}

(async () => {
  await db.query('SELECT 1');
  await ensureSchema();
  map._resetMemory();
  await cleanup();

  /* ═══ FIXTURES ══════════════════════════════════════════════════════════ */

  await db.query(
    `INSERT INTO staff_users (id, email, full_name, role) VALUES
       ($1::uuid, 'sp-lt-rtl@test.local', 'Rtl Control Officer', 'loan_officer'),
       ($2::uuid, 'sp-lt-lt@test.local',  'Lt Scope Officer',    'loan_officer')`, [OFFICER_RTL, OFFICER_LT]);
  await db.query(
    `INSERT INTO borrowers (id, first_name, last_name, email) VALUES
       ($1::uuid, 'Rtl', 'Control', 'sp-lt-control@test.local'),
       ($2::uuid, 'Sara', 'Shared',  'sp-lt-shared@test.local')`, [BORR_RTL, BORR_SHARED]);
  await db.query(
    `INSERT INTO applications (id, borrower_id, loan_officer_id, ys_loan_number, property_address)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'YS-CTRL-1', $4)`,
    [APP, BORR_RTL, OFFICER_RTL, JSON.stringify({ oneLine: '12 Control Rd, Lakewood, NJ 08701' })]);

  // LOAN A — a long-term file that knows everything about itself.
  await db.query(
    `INSERT INTO lt_loans (id, loan_number, borrower_first_name, borrower_last_name, loan_officer_id)
     VALUES ($1::uuid, 'LT-A-1001', 'Dovid', 'Ltborrower', $2::uuid)`, [LOAN_A, OFFICER_LT]);
  await db.query(
    `INSERT INTO lt_properties (loan_id, street, city, state, zip)
     VALUES ($1::uuid, '88 Longterm Ave', 'Lakewood', 'NJ', '08701')`, [LOAN_A]);
  // LOAN B — linked to the SHARED borrower profile, and with no property row at
  // all: the loan number has to name the address folder, exactly as ys_loan_number
  // does for an RTL file with no address.
  await db.query(
    `INSERT INTO lt_loans (id, loan_number, borrower_id, borrower_name, loan_officer_id)
     VALUES ($1::uuid, 'LT-B-2200', $2::uuid, 'Sarah Shaared', $3::uuid)`, [LOAN_B, BORR_SHARED, OFFICER_LT]);
  // LOAN C — the loan that can name nobody and nowhere. Every column the resolver
  // could file under is empty, which is the whole point of the fixture.
  await db.query(`INSERT INTO lt_loans (id) VALUES ($1::uuid)`, [LOAN_C]);

  const rtlItem = (await db.query(
    `INSERT INTO checklist_items (application_id, scope, label, item_kind, status)
     VALUES ($1::uuid,'application','Insurance (binder + invoice)','document','outstanding') RETURNING id`, [APP])).rows[0].id;
  // An LT condition points at NO RTL template row (the boot re-asserts rewrite
  // rows by template id) — its LABEL is what the shared categorizer reads.
  const ltItemA = (await db.query(
    `INSERT INTO checklist_items (lt_loan_id, scope, label, item_kind, status)
     VALUES ($1::uuid,'lt_loan','Insurance binder & invoice','document','outstanding') RETURNING id`, [LOAN_A])).rows[0].id;
  const ltItemC = (await db.query(
    `INSERT INTO checklist_items (lt_loan_id, scope, label, item_kind, status)
     VALUES ($1::uuid,'lt_loan','Anything at all','document','outstanding') RETURNING id`, [LOAN_C])).rows[0].id;

  // Documents are backdated past the drain's 3-second settle window so the real
  // selectors (pendingBatch / claimableWhere / stuckDocuments) can be asserted.
  const mkDoc = async (filename, over = {}, ageHours = 1) => {
    const bytes = Buffer.from(`%PDF-1.4\n${filename}\n`);
    const { ref, provider } = await storage.save(bytes, { filename });
    const cols = {
      filename, content_type: 'application/pdf', size_bytes: bytes.length,
      storage_provider: provider, storage_ref: ref, uploaded_by_kind: 'borrower',
      is_current: true, review_status: 'pending', ...over,
    };
    const keys = Object.keys(cols);
    const id = (await db.query(
      `INSERT INTO documents (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
      keys.map((k) => cols[k]))).rows[0].id;
    await db.query(`UPDATE documents SET created_at = now() - make_interval(hours => $2) WHERE id = $1`, [id, ageHours]);
    return id;
  };

  const docRtl = await mkDoc('rtl-binder.pdf', { application_id: APP, borrower_id: BORR_RTL, checklist_item_id: rtlItem });
  const docA = await mkDoc('lt-binder.pdf', { lt_loan_id: LOAN_A, checklist_item_id: ltItemA });
  const docB = await mkDoc('lt-loose-paper.pdf', { lt_loan_id: LOAN_B });
  // The unresolvable pair: one carrying the loan on the document row (what the
  // settle pass sees), one carrying it ONLY on its condition (what the chokepoint
  // sees). Aged past the 6h backlog SLO, so a false breach would be visible.
  const docC = await mkDoc('lt-nowhere.pdf', { lt_loan_id: LOAN_C }, 48);
  const docC2 = await mkDoc('lt-nowhere-via-condition.pdf', { checklist_item_id: ltItemC }, 48);

  const enrich = (id) => backup.enrichedRowById(id);
  const mirror = async (id) => backup.mirrorRow(await enrich(id));

  /* ═══ 1. THE SCOPE ITSELF ═══════════════════════════════════════════════ */

  const rowA = await enrich(docA);
  eq(backup.scopeKeyFor(rowA), `lt:${LOAN_A}`, 'an lt_loan document resolves to the lt:<loanId> scope');
  eq(backup.scopeKeyFor(await enrich(docRtl)), `app:${APP}`, 'an RTL document still resolves to app:<applicationId> (control)');
  eq(backup.stateKeyFor(rowA, `lt:${LOAN_A}`), `item:${ltItemA}:insurance`,
    'its version stream is the same item:<condition>:<category> shape the RTL side uses');
  eq(backup.categoryFor(rowA), 'Insurance',
    'and its folder comes from the condition LABEL through the same tpr-export categorizer the RTL rows use');
  eq(backup.categoryFor(await enrich(docB)), 'Other Documents',
    'a long-term document with no condition lands in "Other Documents", the categorizer\'s own default');
  eq(backup.scopeKeyFor(await enrich(docC2)), `lt:${LOAN_C}`,
    'a document carrying only its CONDITION\'s lt_loan_id still resolves to the loan (doc → condition, like every other owner)');

  /* ═══ 2. SELECTION — and the LOCK-STEP with the FSM claim set ═══════════ */

  const pendingIds = (await backup.pendingBatch(500)).map((r) => String(r.id));
  assert(pendingIds.includes(docA) && pendingIds.includes(docB),
    'a resolvable long-term document is drained by the ONE mirror — no second pipeline');
  assert(!pendingIds.includes(docC),
    'an unresolvable one is NOT in the drain: it can never churn attempts (the fail-loop this suite exists to close)');

  await queue.reconcileStatus();
  const claimIds = await queue.wouldClaimIds(500);
  eq(claimIds.includes(docA), true, 'sp-mirror-queue would claim the same resolvable long-term document');
  eq(claimIds.includes(docC), false, '…and excludes the same unresolvable one — claimableWhere is in LOCK-STEP with pendingBatch');

  const stuckIds = (await backup.stuckDocuments(500)).map((r) => String(r.id));
  assert(!stuckIds.includes(docC),
    'a 48h-old unresolvable long-term document is NOT counted stuck — the backlog SLO watchdog never breaches on it');

  /* ═══ 3. THE PARK ═══════════════════════════════════════════════════════ */

  await backup.settleNeverMirror();
  const parked = (await db.query(
    `SELECT sharepoint_backed_up_at, sharepoint_skipped_reason, sharepoint_backup_attempts AS attempts,
            sharepoint_backup_ref, sharepoint_backup_error
       FROM documents WHERE id=$1`, [docC])).rows[0];
  assert(!!parked.sharepoint_backed_up_at,
    'the unresolvable document is SETTLED, so it leaves the pending / oldest-pending / stuck population entirely');
  eq(parked.sharepoint_skipped_reason, backup.SKIP_REASON_LT_UNRESOLVED,
    'and says why, in the named reason lt_unresolved_scope');
  assert(/^lt_unresolved_scope/.test(parked.sharepoint_skipped_reason || ''),
    'the machine-readable token leads the reason, so a log, a bucket and a grep all find the same thing');
  eq(Number(parked.attempts), 0, 'it was never even ATTEMPTED — nothing to retry, nothing to exhaust, nothing to go DEAD');
  eq(parked.sharepoint_backup_error, null, 'and it carries no error: this is a policy park, not a failure');
  eq(parked.sharepoint_backup_ref, null, 'nothing was uploaded for it');

  const uploadsBeforeC2 = uploads;
  const c2 = await mirror(docC2);
  eq(c2 && c2.reason, 'lt_unresolved_scope',
    'the mirrorRow chokepoint parks the condition-only case too, instead of throwing "no application or borrower to file under"');
  eq(uploads, uploadsBeforeC2, 'and uploaded nothing');
  const parked2 = (await db.query(
    `SELECT sharepoint_backed_up_at, sharepoint_skipped_reason FROM documents WHERE id=$1`, [docC2])).rows[0];
  eq(parked2.sharepoint_skipped_reason, backup.SKIP_REASON_LT_UNRESOLVED, 'stamped with the same named reason');
  assert(!!parked2.sharepoint_backed_up_at, 'and settled, so it too leaves the backlog');

  // NOT RETRIED: a second settle pass and a second drain selection see nothing.
  await backup.settleNeverMirror();
  const pending2 = (await backup.pendingBatch(500)).map((r) => String(r.id));
  assert(!pending2.includes(docC) && !pending2.includes(docC2), 'a parked document is never selected again');
  const strays = (await backup.neverAttemptedStrays(50)).map((r) => String(r.id));
  assert(!strays.includes(docC) && !strays.includes(docC2),
    'nor force-attempted by the never-attempted stray net — the pass that would otherwise re-drive it every sweep');

  /* ═══ 4. THE JS TWIN AND THE SQL TWIN AGREE ═════════════════════════════ */

  const sqlUnresolved = async (id) => (await db.query(
    `SELECT ${ltScope.unresolvedSql('d.lt_loan_id')} AS unresolved FROM documents d WHERE d.id = $1`, [id])).rows[0].unresolved;
  for (const [id, name] of [[docA, 'LOAN A (resolvable)'], [docB, 'LOAN B (shared profile + loan number)'], [docC, 'LOAN C (unresolvable)'], [docRtl, 'an RTL document']]) {
    const row = await enrich(id);
    const js = ltScope.identitiesResolved(row);
    const sql = await sqlUnresolved(id);
    // An RTL row carries no lt_loan_id at all: the SQL predicate is FALSE (it is
    // not a long-term document) and the JS predicate is FALSE (it has no
    // long-term identities). Both are answering their own question correctly.
    const expectSql = row.lt_loan_id ? !js : false;
    eq(sql, expectSql, `the SQL park predicate and identitiesResolved() agree on ${name}`);
  }

  /* ═══ 5. THE FOLDER — the same tree, the same depth, the same rules ═════ */

  const rtlPath = (await mirror(docRtl)).path;
  eq(rtlPath, RTL_CONTROL_PATH,
    'CONTROL: an RTL document mirrors to byte-identically the path it did before the lt_loan scope existed');

  const aPath = (await mirror(docA)).path;
  eq(aPath, 'Pipeline Drive/Lt Scope Officer/Dovid Ltborrower/88 Longterm Ave/Synced by Pilot/Insurance/Waiting for review',
    'a long-term document files into the SAME Officer/Borrower/Address/sync-leaf/category tree');
  eq(await whereIs(docA), aPath, 'and the folder really exists in SharePoint, built by the real resolver');

  const bPath = (await mirror(docB)).path;
  eq(bPath, 'Pipeline Drive/Lt Scope Officer/Sara Shared/Loan LT-B-2200/Synced by Pilot/Other Documents/Waiting for review',
    'the SHARED borrower profile names the folder (never the loan\'s own spelling), and the loan number is the address fallback');

  const cache = (await db.query(`SELECT full_path FROM sharepoint_folder_cache WHERE scope_key=$1`, [`lt:${LOAN_A}`])).rows[0];
  eq(cache && cache.full_path, 'Pipeline Drive/Lt Scope Officer/Dovid Ltborrower/88 Longterm Ave/Synced by Pilot',
    'the resolution is cached under the lt: scope key, so the whole chain is walked once per loan');

  /* ═══ 6. THE SHELF SWEEP WORKS ON THE LONG-TERM COPY ════════════════════ */

  eq(await whereIs(docA), aPath, 'the fresh long-term upload waits on "Waiting for review", like every human upload');
  await db.query(`UPDATE documents SET review_status='accepted', reviewed_at=now() WHERE id=$1`, [docA]);
  await backup.refileOnce();
  eq(await whereIs(docA), 'Pipeline Drive/Lt Scope Officer/Dovid Ltborrower/88 Longterm Ave/Synced by Pilot/Insurance',
    'THE OWNER\'S RULE, on the long-term side too: once accepted the copy moves UP into the category folder');
  eq((await db.query('SELECT sharepoint_shelf FROM documents WHERE id=$1', [docA])).rows[0].sharepoint_shelf, 'live',
    'and the row records the shelf it is on');

  /* ═══ 7. THE SCOREBOARD, AND THE NO-DELETE LAW ══════════════════════════ */

  const recon = await backup.reconciliation();
  const bucket = (recon.skipped_breakdown || []).find((b) => b.key === 'lt_unresolved');
  assert(bucket && bucket.count >= 2,
    `the two parked documents are ITEMISED on the scoreboard, never rounded into "other" (got ${JSON.stringify(bucket || null)})`);
  eq(deletes, 0, 'NOTHING was deleted, anywhere, at any point — the no-delete law is untouched');

  await cleanup();
  await db.pool.end().catch(() => {});
  console.log(failures ? `\n${failures} FAILURE(S)` : '\ntest-lt-sharepoint-scope-db: all assertions passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
