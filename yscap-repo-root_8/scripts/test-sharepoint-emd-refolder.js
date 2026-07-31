'use strict';
/**
 * The one-shot EMD refolder (owner-directed 2026-07-31: "run the recategorize
 * script so old files get the EMD folder") — the boot pass that renames the
 * mirror's OWN all-EMD condition folders to the clean "EMD" category name.
 *
 * PURE section (no DB): the whole decision table with a fake Graph + fake db —
 * kill switch, sync-disabled, marker short-circuit, nothing-to-do stamps,
 * happy-path rename (incl. a doc inside a Version-N subfolder), the
 * heterogeneous (mixed contract+EMD) guard, already-clean skip, collision
 * skip-but-stamp, Graph-outage leaves it UNSTAMPED, and the inspect cap
 * skipping the rename phase entirely.
 *
 * DB section (needs DATABASE_URL): the module's real SQL against the real
 * schema (the #248 lesson — a wrong column inside a swallowed catch is
 * invisible to a pure test), through the REAL sharepoint-backup enrichment,
 * with only the Graph faked. Proves the marker + audit rows actually land.
 *
 * Run: node scripts/test-sharepoint-emd-refolder.js
 */
process.env.SHAREPOINT_EMD_REFOLDER_MAX_DOCS = '50';   // before require — cap scenario needs a small cap

const REPO = __dirname + '/..';
const refolder = require(REPO + '/src/lib/sharepoint-emd-refolder');
const backupReal = require(REPO + '/src/lib/sharepoint-backup');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

// ------------------------------------------------------------------ fakes
// Folder tree: leaf L; under it the old long-label EMD folder T1 (with a
// "Version 1" child V1), a contract folder T2, and an already-clean T3.
const TREE = {
  L:  { name: 'Synced by Pilot', parent: 'X' },
  T1: { name: 'Earnest money deposit (EMD) verification — CorrFirst', parent: 'L' },
  V1: { name: 'Version 1', parent: 'T1' },
  T2: { name: 'Contract & Assignment', parent: 'L' },
  T3: { name: 'EMD', parent: 'L' },
};

function mkSp(calls, opts = {}) {
  return {
    parseRef: (ref) => ({ driveId: opts.foreignDrive ? 'OTHER' : 'D', itemId: ref }),
    resolveDrive: async () => ({ driveId: 'D' }),
    graph: async (path) => {
      calls.graph.push(path);
      if (opts.graphFail) throw new Error('503 from Graph');
      const id = (path.match(/items\/([^?]+)/) || [])[1];
      const n = TREE[id];
      return n ? { id, name: n.name, parentReference: { id: n.parent } } : {};
    },
    renameOwnItem: async (driveId, itemId, newName, o) => {
      calls.renames.push({ itemId, newName, kind: o && o.kind });
      if (opts.collide) return { skipped: true, reason: 'a sibling named "EMD" already exists — a human must merge them' };
      return { renamed: true, from: TREE[itemId].name, to: newName, isFolder: true };
    },
  };
}

// Fake db routed on distinctive SQL substrings. `rows` shapes each result set.
function mkDb(calls, data = {}) {
  return {
    query: async (sql, params) => {
      const s = String(sql);
      calls.sql.push(s.slice(0, 60).replace(/\s+/g, ' '));
      if (s.includes('FROM sync_runtime_state')) return { rows: data.marker ? [{ value: data.marker }] : [] };
      if (s.includes('INSERT INTO sync_runtime_state')) { calls.stamped.push(JSON.parse(params[1])); return { rows: [] }; }
      if (s.includes("ct.code = 'cond_emd_corrfirst'")) return { rows: data.emdRows || [] };
      if (s.includes('is_current = true')) return { rows: data.allRows || [] };
      if (s.includes('sharepoint_folder_cache')) return { rows: [{ sync_folder_id: 'L' }] };
      if (s.includes('INSERT INTO audit_log')) { calls.audits.push(JSON.parse(params[0])); return { rows: [] }; }
      throw new Error('unexpected SQL in fake db: ' + s.slice(0, 80));
    },
  };
}

// Hybrid backup: REAL category/scope decisions (the one chokepoint — the test
// must prove the pass follows it), fake enablement + enrichment.
const APP = '11111111-1111-4111-8111-111111111111';
const ROWS = {
  d1: { id: 'd1', template_code: 'cond_emd_corrfirst', checklist_item_id: 'ci1', app_id: APP, filename: 'EMD wire.pdf', item_label: 'Earnest money deposit (EMD) verification — CorrFirst' },
  d2: { id: 'd2', template_code: 'cond_emd_corrfirst', checklist_item_id: 'ci1', app_id: APP, filename: 'EMD receipt.pdf', item_label: 'Earnest money deposit (EMD) verification — CorrFirst' },
  d3: { id: 'd3', template_code: 'rtl_p1_contract', checklist_item_id: 'ci2', app_id: APP, filename: 'Purchase contract.pdf', item_label: 'Executed purchase contract' },
  d4: { id: 'd4', template_code: 'cond_emd_corrfirst', checklist_item_id: 'ci1', app_id: APP, filename: 'EMD proof.pdf', item_label: 'Earnest money deposit (EMD) verification — CorrFirst' },
  d5: { id: 'd5', template_code: 'cond_emd_corrfirst', checklist_item_id: 'ci1', app_id: APP, filename: 'EMD.pdf', item_label: 'Earnest money deposit (EMD) verification — CorrFirst' },
};
function mkBackup(opts = {}) {
  return {
    enabled: () => !opts.disabled,
    enrichedRowById: async (id) => ROWS[id] || null,
    categoryPathFor: backupReal.categoryPathFor,
    scopeKeyFor: backupReal.scopeKeyFor,
  };
}

const doc = (id, parent) => ({ id, sharepoint_backup_ref: `ref-${id}`, sharepoint_parent_id: parent, app_id: APP });
const freshCalls = () => ({ graph: [], renames: [], sql: [], stamped: [], audits: [] });

async function pureTests() {
  console.log('--- pure: decision table');

  // 1) kill switch
  process.env.SHAREPOINT_EMD_REFOLDER_DISABLED = '1';
  let calls = freshCalls();
  let r = await refolder.refolderEmdOnce({ sp: mkSp(calls), db: mkDb(calls), backup: mkBackup() });
  ok(r.skippedReason === 'disabled' && calls.sql.length === 0, 'kill switch: skipped before any query');
  delete process.env.SHAREPOINT_EMD_REFOLDER_DISABLED;

  // 2) sync disabled → no marker written (must retry when sync turns on)
  calls = freshCalls();
  r = await refolder.refolderEmdOnce({ sp: mkSp(calls), db: mkDb(calls), backup: mkBackup({ disabled: true }) });
  ok(r.skippedReason === 'sync disabled' && calls.stamped.length === 0, 'sync disabled: skipped, unstamped');

  // 3) marker present → done, no Graph traffic
  calls = freshCalls();
  r = await refolder.refolderEmdOnce({ sp: mkSp(calls), db: mkDb(calls, { marker: { finishedAt: 'x' } }), backup: mkBackup() });
  ok(r.skippedReason === 'done' && calls.graph.length === 0, 'marker present: one-shot never re-runs');

  // 4) no mirrored EMD docs → stamps (repair complete by vacuity)
  calls = freshCalls();
  r = await refolder.refolderEmdOnce({ sp: mkSp(calls), db: mkDb(calls, { emdRows: [] }), backup: mkBackup() });
  ok(r.emdDocs === 0 && calls.stamped.length === 1 && calls.graph.length === 0, 'nothing mirrored: stamped without touching Graph');

  // 5) happy path: old long-label folder, one doc in its root + one in Version 1
  calls = freshCalls();
  r = await refolder.refolderEmdOnce({
    sp: mkSp(calls), backup: mkBackup(),
    db: mkDb(calls, { emdRows: [doc('d1', 'T1')], allRows: [doc('d1', 'T1'), doc('d2', 'V1')] }),
  });
  ok(r.renamed === 1 && calls.renames.length === 1 && calls.renames[0].itemId === 'T1' && calls.renames[0].newName === 'EMD',
    'all-EMD long-label folder → renamed to "EMD" (Version-N child resolves to the same top folder)');
  ok(calls.renames[0].kind === 'folder', 'rename is pinned to kind:folder');
  ok(calls.stamped.length === 1 && calls.stamped[0].renamed === 1, 'clean pass stamps the marker with its summary');
  ok(calls.audits.length === 1 && calls.audits[0].from === TREE.T1.name && calls.audits[0].to === 'EMD', 'rename is audit-logged');

  // 6) mixed folder: contract + EMD docs share one top folder → NEVER renamed
  calls = freshCalls();
  r = await refolder.refolderEmdOnce({
    sp: mkSp(calls), backup: mkBackup(),
    db: mkDb(calls, { emdRows: [doc('d4', 'T2')], allRows: [doc('d3', 'T2'), doc('d4', 'T2')] }),
  });
  ok(r.heterogeneous === 1 && r.renamed === 0 && calls.renames.length === 0, 'mixed contract+EMD folder: skipped, never renamed/split');
  ok(calls.stamped.length === 1, 'mixed folder is a final human-owned state — the pass still stamps');

  // 7) already clean
  calls = freshCalls();
  r = await refolder.refolderEmdOnce({
    sp: mkSp(calls), backup: mkBackup(),
    db: mkDb(calls, { emdRows: [doc('d5', 'T3')], allRows: [doc('d5', 'T3')] }),
  });
  ok(r.alreadyClean === 1 && r.renamed === 0 && calls.stamped.length === 1, 'folder already named "EMD": nothing to do, stamped');

  // 8) Graph outage during the walk → UNSTAMPED (next boot retries)
  calls = freshCalls();
  r = await refolder.refolderEmdOnce({
    sp: mkSp(calls, { graphFail: true }), backup: mkBackup(),
    db: mkDb(calls, { emdRows: [doc('d1', 'T1')], allRows: [doc('d1', 'T1')] }),
  });
  ok(r.errors > 0 && calls.stamped.length === 0, 'Graph outage: errors counted, marker NOT stamped');

  // 9) rename collision → reported skip, but stamped (a sibling "EMD" is permanent)
  calls = freshCalls();
  r = await refolder.refolderEmdOnce({
    sp: mkSp(calls, { collide: true }), backup: mkBackup(),
    db: mkDb(calls, { emdRows: [doc('d1', 'T1')], allRows: [doc('d1', 'T1')] }),
  });
  ok(r.skipped === 1 && r.renamed === 0 && calls.stamped.length === 1 && calls.audits.length === 0,
    'collision: skipped (never merged), no audit row, still stamped');

  // 10) inspect cap: a truncated view proves nothing → whole rename phase skipped, unstamped
  calls = freshCalls();
  const many = Array.from({ length: 51 }, (_, i) => doc('d1', 'T1'));
  r = await refolder.refolderEmdOnce({
    sp: mkSp(calls), backup: mkBackup(),
    db: mkDb(calls, { emdRows: [doc('d1', 'T1')], allRows: many }),
  });
  ok(r.skippedReason === 'cap' && calls.renames.length === 0 && calls.stamped.length === 0,
    'inspect cap hit: no renames on partial evidence, unstamped (manual script finishes)');

  // 11) a doc on ANOTHER drive is ignored (same rule as the manual script)
  calls = freshCalls();
  r = await refolder.refolderEmdOnce({
    sp: mkSp(calls, { foreignDrive: true }), backup: mkBackup(),
    db: mkDb(calls, { emdRows: [doc('d1', 'T1')], allRows: [doc('d1', 'T1')] }),
  });
  ok(r.inspected === 0 && calls.renames.length === 0 && calls.stamped.length === 1, 'foreign-drive ref: ignored, stamped');

  // 12) the target name is DERIVED from the tpr-export chokepoint
  ok(refolder._internals.emdCategory() === 'EMD', 'rename target comes from tpr-export.categoryFor (no re-inlined name)');
}

async function dbTests() {
  if (!process.env.DATABASE_URL) { console.log('--- db: SKIP (no DATABASE_URL)'); return; }
  console.log('--- db: real SQL against the real schema');
  const db = require(REPO + '/src/db');
  const crypto = require('crypto');
  const uuid = () => crypto.randomUUID();
  await require(REPO + '/src/migrate-boot').ensureSchema();

  const B = uuid(), APPID = uuid(), CI = uuid(), CI2 = uuid(), D_EMD = uuid(), D_CON = uuid();
  try {
    await db.query(`DELETE FROM sync_runtime_state WHERE key=$1`, [refolder.STATE_KEY]);
    await db.query(`INSERT INTO borrowers (id,first_name,last_name,email) VALUES ($1,'Emd','Refolder',$2)`,
      [B, `emdref_${B.slice(0, 8)}@x.test`]);
    await db.query(`INSERT INTO applications (id,borrower_id,property_address,lender) VALUES ($1,$2,$3,'CorrFirst')`,
      [APPID, B, JSON.stringify({ line1: '7 Emd Way', city: 'Testville', state: 'NJ' })]);
    const T = (await db.query(`SELECT id FROM checklist_templates WHERE code='cond_emd_corrfirst'`)).rows[0];
    ok(!!T, 'db/191 template cond_emd_corrfirst exists');
    await db.query(
      `INSERT INTO checklist_items (id,application_id,template_id,label,item_kind,audience,status,scope)
       VALUES ($1,$2,$3,'Earnest money deposit (EMD) verification — CorrFirst','document','borrower','received','application'),
              ($4,$2,NULL,'Executed purchase contract','document','borrower','received','application')`,
      [CI, APPID, T.id, CI2]);
    // Two mirrored docs: the EMD proof in the old long-label folder P1, and a
    // contract doc in its own folder P2 (must stay untouched — no EMD in cats).
    await db.query(
      `INSERT INTO documents (id,filename,storage_provider,storage_ref,uploaded_by_kind,checklist_item_id,application_id,borrower_id,
                              is_current,review_status,sharepoint_backup_ref,sharepoint_parent_id)
       VALUES ($1,'EMD wire confirmation.pdf','local','x/emd','borrower',$2,$3,$4,true,'pending','P1DOC','P1'),
              ($5,'Purchase contract.pdf','local','x/con','borrower',$6,$3,$4,true,'pending','P2DOC','P2')`,
      [D_EMD, CI, APPID, B, D_CON, CI2]);
    await db.query(
      `INSERT INTO sharepoint_folder_cache (scope_key,sync_folder_id) VALUES ($1,'L')
       ON CONFLICT (scope_key) DO UPDATE SET sync_folder_id='L'`, [`app:${APPID}`]);

    const DBTREE = {
      L: { name: 'Synced by Pilot', parent: 'X' },
      P1: { name: 'Earnest money deposit (EMD) verification — CorrFirst', parent: 'L' },
      P2: { name: 'Contract & Assignment', parent: 'L' },
    };
    const calls = { graph: [], renames: [] };
    const sp = {
      parseRef: (ref) => ({ driveId: 'D', itemId: ref }),
      resolveDrive: async () => ({ driveId: 'D' }),
      graph: async (path) => {
        calls.graph.push(path);
        const id = (path.match(/items\/([^?]+)/) || [])[1];
        const n = DBTREE[id];
        return n ? { id, name: n.name, parentReference: { id: n.parent } } : {};
      },
      renameOwnItem: async (driveId, itemId, newName) => {
        calls.renames.push({ itemId, newName });
        return { renamed: true, from: DBTREE[itemId].name, to: newName, isFolder: true };
      },
    };
    // REAL db + REAL backup enrichment; only enablement + Graph are faked.
    const hybrid = Object.assign(Object.create(backupReal), { enabled: () => true });
    const r = await refolder.refolderEmdOnce({ sp, db, backup: hybrid });

    ok(r.errors === 0, `pass ran clean against the real schema (errors=${r.errors})`);
    ok(r.emdDocs === 1 && r.inspected === 2, `real SQL found the EMD doc + both current docs (emdDocs=${r.emdDocs}, inspected=${r.inspected})`);
    ok(calls.renames.length === 1 && calls.renames[0].itemId === 'P1' && calls.renames[0].newName === 'EMD',
      'the old long-label EMD folder renamed; the contract folder untouched');
    const marker = (await db.query(`SELECT value FROM sync_runtime_state WHERE key=$1`, [refolder.STATE_KEY])).rows[0];
    ok(!!marker && marker.value.renamed === 1, 'marker stamped in the real sync_runtime_state');
    const audit = (await db.query(
      `SELECT detail FROM audit_log WHERE action='sharepoint_emd_refolder_renamed' ORDER BY created_at DESC LIMIT 1`)).rows[0];
    ok(!!audit && audit.detail && audit.detail.to === 'EMD', 'rename audit row landed');
    const again = await refolder.refolderEmdOnce({ sp, db, backup: hybrid });
    ok(again.skippedReason === 'done', 'second run: marker short-circuits (true one-shot)');
  } finally {
    try {
      await db.query(`DELETE FROM sync_runtime_state WHERE key=$1`, [refolder.STATE_KEY]);
      await db.query(`DELETE FROM documents WHERE id = ANY($1::uuid[])`, [[D_EMD, D_CON]]);
      await db.query(`DELETE FROM checklist_items WHERE id = ANY($1::uuid[])`, [[CI, CI2]]);
      await db.query(`DELETE FROM sharepoint_folder_cache WHERE scope_key=$1`, [`app:${APPID}`]);
      await db.query(`DELETE FROM applications WHERE id=$1`, [APPID]);
      await db.query(`DELETE FROM borrowers WHERE id=$1`, [B]);
      await db.pool.end();
    } catch (_) { /* cleanup best-effort */ }
  }
}

(async () => {
  await pureTests();
  await dbTests();
  console.log(`\nsharepoint-emd-refolder: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
