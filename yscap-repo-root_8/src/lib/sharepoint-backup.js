/**
 * SharePoint one-way sync reconciler (owner-directed design, 2026-07-13).
 *
 * Every document saved on the server is mirrored — automatically, right away —
 * into the team site at:
 *   Pipeline Drive/<Officer>/<Borrower>/<Address>/YS portal syncing/<Condition>/
 *
 * Design:
 *  • ONE central chokepoint instead of edits to every upload path: a reconciler
 *    scans `documents` rows not yet mirrored and copies each one's bytes from
 *    primary (local) storage up to SharePoint. Upload endpoints call kick() so
 *    new documents mirror within seconds; the interval sweep retries failures
 *    and performs the first-run FULL HISTORY BACKFILL (oldest-first, so version
 *    history replays in true chronological order).
 *  • VERSION FOLDERS: when a document supersedes previously-mirrored ones for
 *    the same condition (the portal's is_current/slot supersede signal), the
 *    condition folder is versioned exactly as the owner specified: on the FIRST
 *    replacement, create "Version 1", move the OLD portal-uploaded copies into
 *    it, create "Version 2" and put the new document there; later replacements
 *    just add "Version 3", "Version 4", … The ONLY items ever moved are the
 *    portal's own mirror copies (verified against documents.sharepoint_backup_ref
 *    AND the expected-parent check in sp.moveOwnItem).
 *  • ONE-WAY & NO-DELETE: never reads document bytes from SharePoint, never
 *    deletes anything, never touches human-curated files (docs/SHAREPOINT-POLICY.md).
 *  • A SharePoint problem NEVER breaks an upload: everything here is
 *    out-of-band and best-effort with per-document error records.
 *
 * Self-gated: inert unless SHAREPOINT_BACKUP_ENABLED=1 and Graph creds are set.
 */
const crypto = require('crypto');
const cfg = require('../config');
const db = require('../db');
const storage = require('./storage');
const sp = require('./sharepoint');
const map = require('./sharepoint-map');
const { sniffKind, expectedKind } = require('./upload-bytes');

const MAX_ATTEMPTS = 8;            // per-document retry cap (interval sweeps retry)
const DEFAULT_BATCH = 25;
const PACING_MS = 300;             // between uploads — keeps Graph bursts polite

// ------------------------------------------------------- churn classification
// SYSTEM-GENERATED, REGENERABLE artifact streams (autosaved tool snapshots and
// exports). These are the streams that exploded to "Version 47": the track
// record tool pushes a full HTML snapshot ~2.5s after every edit pause
// (track-record-portal.js), each snapshot supersedes the previous one, and the
// mirror was minting a Version-N folder for every autosave. Root fix
// (owner-directed 2026-07-15, "47 versions is not true"):
//   1. a regen-kind row that is ALREADY SUPERSEDED when the mirror looks at it
//      is skipped outright — only the survivor of an editing burst uploads;
//   2. regen kinds get a LONG settle window (default 10 min) so an editing
//      session collapses to ONE mirrored copy;
//   3. regen kinds never version-shuffle — copies land in the category folder
//      root with dated names (no more Version-N forests for autosaves).
// HUMAN uploads (borrower/staff documents, chat attachments) keep the full
// owner-approved history + Version-N behavior.
const REGEN_KIND_SQL = `(d.doc_kind = 'track_record_html' OR d.doc_kind = 'tpr_export' OR d.doc_kind LIKE '%\\_export')`;
function isRegenKind(k) { return k === 'track_record_html' || k === 'tpr_export' || /_export$/.test(String(k || '')); }
function snapshotSettleSec() {
  const v = parseInt(process.env.SHAREPOINT_SNAPSHOT_SETTLE_SEC || '600', 10);
  return Number.isFinite(v) && v >= 10 ? v : 600;
}

const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ------------------------------------------------------- cross-process leases
// Deploy overlap / scale-out safety: only ONE process may run a given pass at
// a time, portfolio-wide. In-process single-flight (_running) cannot see the
// other instance; this DB lease can. Fail-open on DB error (the pass is
// idempotent-ish and conflict-adoption absorbs stragglers) — fail-closed on a
// held lease.
const LEASE_MINUTES = 10;
const _holderId = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
async function acquireLease(key) {
  try {
    const r = await db.query(
      `INSERT INTO sync_locks (lock_key, holder, expires_at)
       VALUES ($1, $2, now() + make_interval(mins => ${LEASE_MINUTES}))
       ON CONFLICT (lock_key) DO UPDATE
         SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
       WHERE sync_locks.expires_at < now() OR sync_locks.holder = $2
       RETURNING holder`,
      [key, _holderId]);
    return r.rows.length > 0;
  } catch (e) {
    console.warn(`[sp-sync] lease "${key}" check failed (${e.message}) — proceeding without it`);
    return true;
  }
}
async function renewLease(key) {
  try {
    await db.query(
      `UPDATE sync_locks SET expires_at = now() + make_interval(mins => ${LEASE_MINUTES})
        WHERE lock_key = $1 AND holder = $2`, [key, _holderId]);
  } catch (_) { /* best-effort */ }
}
async function releaseLease(key) {
  try {
    await db.query(
      `UPDATE sync_locks SET expires_at = now() WHERE lock_key = $1 AND holder = $2`,
      [key, _holderId]);
  } catch (_) { /* best-effort */ }
}

// Trust state for the local QuickXorHash implementation: null = not yet
// calibrated, true = matched Graph's hash on a fresh upload (mismatch verdicts
// are meaningful), false = disagreed on bytes we KNOW arrived intact (size
// matched) — implementation/tenant drift, fall back to size-only forever.
let _qxTrusted = null;
function calibrateQuickXor(localHash, item, sizeMatches) {
  const remote = item && item.file && item.file.hashes && item.file.hashes.quickXorHash;
  if (!remote || !sizeMatches || _qxTrusted !== null) return;
  _qxTrusted = remote === localHash;
  if (!_qxTrusted) {
    console.warn('[sp-sync] QuickXorHash self-calibration FAILED (local implementation disagrees with Graph on a verified upload) — integrity checks fall back to size-only');
  }
}
const KICK_DEBOUNCE_MS = 4000;     // collapse a burst of uploads into one pass;
                                   // MUST exceed pendingBatch's 3s settle window
                                   // or a kicked pass would skip the very doc
                                   // that kicked it and wait for the sweep
const MAX_DRAIN_LOOPS = 200;       // backfill safety valve per drain (200*25 docs)

let _running = false;              // single-flight: kick + interval never overlap
let _rekick = false;               // an upload arrived mid-drain — drain again after
let _kickTimer = null;
let _interval = null;
let _verifyInterval = null;
let _lastPass = null;              // stats for /api/health

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function enabled() {
  return !!cfg.sharepointBackupEnabled && sp.configured();
}

// ---------------------------------------------------------------- categorizing
// LLC document-type subfolders by slot template code (owner-directed
// 2026-07-13: each LLC gets a folder named with the LLC NAME, containing
// EIN letter / formation documents / operating agreement subfolders).
function llcSubfolder(row) {
  const code = row.template_code || '';
  if (/formation/.test(code)) return 'Formation Documents';
  if (/ein/.test(code)) return 'EIN Letter';
  if (/opagmt|operating/.test(code)) return 'Operating Agreement';
  if (/goodstanding/.test(code)) return 'Certificate of Good Standing';
  const label = (row.item_label || '').toLowerCase();
  if (/formation|articles|certificate of formation/.test(label)) return 'Formation Documents';
  if (/ein|ss-4/.test(label)) return 'EIN Letter';
  if (/operating/.test(label)) return 'Operating Agreement';
  if (/good standing/.test(label)) return 'Certificate of Good Standing';
  return row.item_label || 'Other Documents';
}

// The folder PATH a document belongs in, inside YS portal syncing — an array
// of nested segments. Condition-attached documents use the condition's label;
// LLC documents nest under the LLC's NAME; track-record (REO / experience)
// docs nest under REO/<project address> — one folder per line item, holding
// every document uploaded to that experience (owner-directed 2026-07-13);
// term sheets split Unsigned/Signed (the Signed side arrives with DocuSign).
function categoryPathFor(row) {
  if (row.llc_resolved_id) return [row.llc_name || 'LLC', llcSubfolder(row)];
  if (row.doc_kind === 'photo_id') return ['Photo ID'];               // always profile-level
  if (row.doc_kind === 'term_sheet') return ['Term Sheet', 'Unsigned'];
  if (row.doc_kind === 'term_sheet_signed') return ['Term Sheet', 'Signed'];
  if (row.doc_kind === 'tpr_export') return ['TPR Exports'];
  // The autosaved track-record HTML gets its own category so its frequent
  // supersede-driven versions never shuffle the per-project verification docs.
  if (row.doc_kind === 'track_record_html') return ['REO', 'Track Record Saved Copy'];
  if (row.track_record_id || row.doc_kind === 'track_record_doc') {
    return ['REO', row.tr_address || (row.track_record_id ? `Project ${String(row.track_record_id).slice(0, 8)}` : 'General')];
  }
  if (row.item_label) return [row.item_label];
  if (row.source_type === 'chat_attachment') return ['Chat Attachments'];
  return ['General Documents'];
}
// Back-compat name used by tests/health.
const categoryFor = (row) => categoryPathFor(row).join('/');

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';

// Scope: which YS portal syncing folder the document belongs to. Applications
// get the full officer/borrower/address chain; borrower-profile documents live
// under the borrower folder directly. Photo IDs are ALWAYS profile-level
// (owner-directed: the government ID lives directly in the borrower's profile
// folder, like the profile itself) even when uploaded from a file context.
function scopeKeyFor(row) {
  if (row.doc_kind === 'photo_id' && row.borrower_id) return `borrower:${row.borrower_id}`;
  // The track record (REO / experience) is a BORROWER-level dataset shared by
  // every loan file, so its documents always file into ONE REO tree at the
  // borrower profile level — even when the upload came in through a per-file
  // request condition (which carries an app id).
  if ((row.track_record_id || row.doc_kind === 'track_record_doc' || row.doc_kind === 'track_record_html') && row.borrower_id) {
    return `borrower:${row.borrower_id}`;
  }
  if (row.app_id) return `app:${row.app_id}`;
  if (row.borrower_id) return `borrower:${row.borrower_id}`;
  return null;
}

// Doc kinds whose ROUTES supersede app/borrower-wide by doc_kind (not per
// checklist item): these always use ONE kind-scoped version stream so the
// stream, the folder, and the supersede matching all agree even when a copy
// happens to be attached to a checklist item.
const KIND_STREAM = new Set(['photo_id', 'term_sheet', 'term_sheet_signed']);

function stateKeyFor(row, scopeKey) {
  if (row.doc_kind === 'photo_id') return `kind:${scopeKey}:photo-id`;   // one stream across files
  if (KIND_STREAM.has(row.doc_kind)) return `kind:${scopeKey}:${slug(categoryFor(row))}`;
  return row.checklist_item_id ? `item:${row.checklist_item_id}` : `kind:${scopeKey}:${slug(categoryFor(row))}`;
}

// ------------------------------------------------------------------- selection
// Documents that still need mirroring, with everything the resolver needs.
// COALESCE walks document → checklist item → llc so condition- and entity-
// attached documents route to the right file/borrower. Oldest first so the
// backfill replays supersede history in order.
async function pendingBatch(limit) {
  const { rows } = await db.query(
    `SELECT d.id, d.filename, d.content_type, d.storage_ref, d.storage_provider,
            d.slot_label, d.doc_kind, d.source_type, d.is_current, d.size_bytes,
            d.sharepoint_backup_ref, d.sharepoint_parent_id, d.sharepoint_version,
            d.checklist_item_id, d.llc_id, d.created_at,
            COALESCE(d.track_record_id, ci.track_record_id)                     AS track_record_id,
            COALESCE(d.application_id, ci.application_id)                        AS app_id,
            COALESCE(d.borrower_id, ci.borrower_id, l.borrower_id, a.borrower_id) AS borrower_id,
            ci.label                                                            AS item_label,
            ct.code                                                             AS template_code,
            l.id                                                                AS llc_resolved_id,
            l.llc_name,
            COALESCE(tr.property_address->>'oneLine',
                     tr.property_address->>'street', tr.property_address->>'line1') AS tr_address,
            a.ys_loan_number,
            COALESCE(a.property_address->>'oneLine',
                     NULLIF(TRIM(CONCAT_WS(', ',
                       COALESCE(a.property_address->>'street', a.property_address->>'line1'),
                       a.property_address->>'city', a.property_address->>'state')), '')) AS address_one_line,
            COALESCE(su.full_name, a.loan_officer_name, recent.officer_name)    AS officer_name,
            b.first_name  AS borrower_first,
            b.last_name   AS borrower_last
       FROM documents d
       LEFT JOIN checklist_items ci ON ci.id = d.checklist_item_id
       LEFT JOIN checklist_templates ct ON ct.id = ci.template_id
       LEFT JOIN track_records tr   ON tr.id = COALESCE(d.track_record_id, ci.track_record_id)
       LEFT JOIN llcs l             ON l.id = COALESCE(d.llc_id, ci.llc_id)
       LEFT JOIN applications a     ON a.id = COALESCE(d.application_id, ci.application_id)
       LEFT JOIN staff_users su     ON su.id = a.loan_officer_id
       LEFT JOIN borrowers b        ON b.id = COALESCE(d.borrower_id, ci.borrower_id, l.borrower_id, a.borrower_id)
       LEFT JOIN LATERAL (
         SELECT COALESCE(su2.full_name, a2.loan_officer_name) AS officer_name
           FROM applications a2
           LEFT JOIN staff_users su2 ON su2.id = a2.loan_officer_id
          WHERE COALESCE(d.application_id, ci.application_id) IS NULL
            AND a2.borrower_id = COALESCE(d.borrower_id, ci.borrower_id, l.borrower_id)
          ORDER BY a2.created_at DESC LIMIT 1
       ) recent ON true
      WHERE d.sharepoint_backed_up_at IS NULL
        AND d.storage_ref IS NOT NULL
        AND COALESCE(d.storage_provider, 'local') = 'local'
        AND d.sharepoint_backup_attempts < $2
        -- Settle window: the upload request's follow-up statements (supersede
        -- flags on prior versions) run in separate autocommit statements right
        -- after the INSERT; never mirror a row before they have landed.
        -- Regen-kind snapshots settle MUCH longer (default 10 min) so a whole
        -- editing session of 2.5s autosaves collapses into ONE mirrored copy.
        AND d.created_at < now() - (CASE WHEN ${REGEN_KIND_SQL}
              THEN make_interval(secs => $3) ELSE interval '3 seconds' END)
        -- A superseded regen-kind snapshot never uploads (runOnce marks these
        -- skipped; this predicate is the belt to that suspender).
        AND NOT (${REGEN_KIND_SQL} AND d.is_current = false)
      -- attempts ASC first: fresh uploads are never starved behind a head-of-
      -- queue clump of repeatedly-failing rows; created_at ASC within a tier
      -- keeps the backfill's version replay chronological.
      ORDER BY d.sharepoint_backup_attempts ASC, d.created_at ASC
      LIMIT $1`,
    [limit, MAX_ATTEMPTS, snapshotSettleSec()],
  );
  return rows;
}

// Superseded-before-mirror regen snapshots are settled WITHOUT uploading: the
// newer copy of the same autosave stream carries all the information. This is
// the version-explosion root fix — an editing burst of N snapshots mirrors 1
// file instead of N files in N Version folders. Nothing is lost: the bytes
// stay in portal storage and the CURRENT snapshot always mirrors.
async function settleSupersededSnapshots() {
  const r = await db.query(
    `UPDATE documents d SET
        sharepoint_backed_up_at = now(),
        sharepoint_skipped_reason = 'superseded before mirror — a newer copy of this autosaved snapshot mirrors instead',
        sharepoint_backup_error = NULL
      WHERE d.sharepoint_backed_up_at IS NULL
        AND d.is_current = false
        AND ${REGEN_KIND_SQL}
        AND d.storage_ref IS NOT NULL`);
  if (r.rowCount) console.log(`[sp-sync] settled ${r.rowCount} superseded snapshot(s) without uploading`);
  return r.rowCount || 0;
}

// ------------------------------------------------------------------ versioning
async function getConditionState(stateKey) {
  return (await db.query(
    'SELECT state_key, scope_key, folder_id, current_version FROM sharepoint_condition_state WHERE state_key=$1',
    [stateKey])).rows[0] || null;
}

async function upsertConditionState(stateKey, scopeKey, folderId, folderName, version) {
  await db.query(
    `INSERT INTO sharepoint_condition_state (state_key, scope_key, folder_id, folder_name, current_version)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (state_key) DO UPDATE SET folder_id=EXCLUDED.folder_id,
       folder_name=EXCLUDED.folder_name, current_version=EXCLUDED.current_version, updated_at=now()`,
    [stateKey, scopeKey, folderId, folderName, version]);
}

// Would mirroring `row` supersede docs already mirrored at the CURRENT version
// of its condition? (The trigger for a Version-N bump.) Matches the portal's
// slot semantics: a slotted upload supersedes its slot; an unslotted one
// supersedes across the condition.
async function isSupersedeEvent(row, stateKey, currentVersion, conditionFolderId) {
  // NOTE: every param pushed MUST be referenced in the SQL — Postgres rejects
  // a statement with an unreferenced parameter ("could not determine data type
  // of parameter $N"), so each branch builds its own exact parameter list.
  const params = [row.id, currentVersion];
  let where;
  if (KIND_STREAM.has(row.doc_kind)) {
    // Streams the routes supersede by DOC KIND (app-wide term sheets,
    // borrower-wide photo IDs) — checklist attachment is ignored on BOTH sides
    // so an item-attached copy and a plain copy share one stream, exactly like
    // the routes' own supersede UPDATEs.
    if (row.app_id && row.doc_kind !== 'photo_id') {
      params.push(row.app_id, row.doc_kind);
      where = `m.application_id::text = $3::text AND m.doc_kind = $4`;
    } else {
      params.push(row.borrower_id, row.doc_kind);
      where = `COALESCE(m.borrower_id::text,'') = COALESCE($3::text,'') AND m.doc_kind = $4`;
    }
  } else if (row.checklist_item_id) {
    params.push(row.checklist_item_id);
    where = 'm.checklist_item_id = $3';
  } else if (row.app_id) {
    // kind-scoped on a file: match on the APP alone (a borrower-uploaded and a
    // staff-saved term sheet on the same file share one version stream even
    // though their raw borrower_id differs). llc/track-record NULL-ness
    // participates so unrelated categories never trip each other's counter.
    params.push(row.app_id, row.doc_kind || '', row.source_type || '');
    where = `m.checklist_item_id IS NULL
             AND m.application_id::text = $3::text
             AND COALESCE(m.doc_kind,'')    = $4
             AND COALESCE(m.source_type,'') = $5
             AND (m.llc_id IS NULL) = ${row.llc_id ? 'false' : 'true'}
             AND (m.track_record_id IS NULL) = ${row.track_record_id ? 'false' : 'true'}`;
  } else {
    // kind-scoped with no file: the borrower anchors the match.
    params.push(row.borrower_id, row.doc_kind || '', row.source_type || '');
    where = `m.checklist_item_id IS NULL
             AND m.application_id IS NULL
             AND COALESCE(m.borrower_id::text,'') = COALESCE($3::text,'')
             AND COALESCE(m.doc_kind,'')    = $4
             AND COALESCE(m.source_type,'') = $5
             AND (m.llc_id IS NULL) = ${row.llc_id ? 'false' : 'true'}
             AND (m.track_record_id IS NULL) = ${row.track_record_id ? 'false' : 'true'}`;
  }
  params.push(row.slot_label);
  const slotIdx = params.length;
  // Same-folder guard for the version-0 case: a supersede only counts when the
  // superseded mirror copy actually lives in THIS stream's condition folder.
  // Without it, a pre-relocation copy sitting in an OLD category folder (e.g.
  // 'Term Sheet' before the Unsigned split) would phantom-bump the NEW folder
  // to Version 2 with an empty Version 1 and nothing movable.
  let folderGuard = '';
  if (currentVersion === 0 && conditionFolderId) {
    params.push(conditionFolderId);
    folderGuard = `AND m.sharepoint_parent_id = $${params.length}`;
  }
  const { rows } = await db.query(
    `SELECT 1 FROM documents m
      WHERE m.id <> $1
        AND m.sharepoint_backup_ref IS NOT NULL
        AND m.sharepoint_version = $2
        AND m.is_current = false
        AND ${where}
        AND ($${slotIdx}::text IS NULL OR m.slot_label IS NOT DISTINCT FROM $${slotIdx}::text)
        ${folderGuard}
      LIMIT 1`, params);
  return rows.length > 0;
}

// The first-replacement shuffle: create "Version 1", move OUR mirror copies
// from the condition-folder root into it. Only items recorded in
// documents.sharepoint_backup_ref are touched, and sp.moveOwnItem refuses any
// item whose current parent isn't the condition folder we created.
// NOTE (owner-designed): ALL of the portal's root copies move — including a
// still-current doc of another slot ("move in all the old documents in the
// version 1 folder"). The freshest set always lives in the HIGHEST Version
// folder; a still-current doc parked in Version 1 simply hasn't changed since.
async function shuffleRootIntoVersion1(driveId, row, stateKey, conditionFolder) {
  // Same rule as isSupersedeEvent: every pushed param must be referenced, and
  // the stream (kind vs item) is selected identically.
  let where, params;
  if (KIND_STREAM.has(row.doc_kind)) {
    if (row.app_id && row.doc_kind !== 'photo_id') {
      where = `application_id::text = $1::text AND doc_kind = $2`;
      params = [row.app_id, row.doc_kind];
    } else {
      where = `COALESCE(borrower_id::text,'') = COALESCE($1::text,'') AND doc_kind = $2`;
      params = [row.borrower_id, row.doc_kind];
    }
  } else if (row.checklist_item_id) {
    where = 'checklist_item_id = $1';
    params = [row.checklist_item_id];
  } else if (row.app_id) {
    where = `checklist_item_id IS NULL
             AND application_id::text = $1::text
             AND COALESCE(doc_kind,'')    = $2
             AND COALESCE(source_type,'') = $3
             AND (llc_id IS NULL) = ${row.llc_id ? 'false' : 'true'}
             AND (track_record_id IS NULL) = ${row.track_record_id ? 'false' : 'true'}`;
    params = [row.app_id, row.doc_kind || '', row.source_type || ''];
  } else {
    where = `checklist_item_id IS NULL
             AND application_id IS NULL
             AND COALESCE(borrower_id::text,'') = COALESCE($1::text,'')
             AND COALESCE(doc_kind,'')    = $2
             AND COALESCE(source_type,'') = $3
             AND (llc_id IS NULL) = ${row.llc_id ? 'false' : 'true'}
             AND (track_record_id IS NULL) = ${row.track_record_id ? 'false' : 'true'}`;
    params = [row.borrower_id, row.doc_kind || '', row.source_type || ''];
  }
  const olds = (await db.query(
    `SELECT id, sharepoint_backup_ref FROM documents
      WHERE sharepoint_backup_ref IS NOT NULL AND sharepoint_version = 0
        AND sharepoint_parent_id = $${params.length + 1} AND ${where}`,
    [...params, conditionFolder.id])).rows;
  // Nothing movable (e.g. a human relocated every root copy): no empty
  // "Version 1" is created and the caller skips the bump entirely.
  if (!olds.length) return null;
  const v1 = await sp.ensureChildFolder(driveId, conditionFolder.id, 'Version 1');
  for (const old of olds) {
    const { itemId } = sp.parseRef(old.sharepoint_backup_ref);
    try {
      await sp.moveOwnItem(driveId, itemId, v1.id, { expectedParentId: conditionFolder.id });
      await db.query('UPDATE documents SET sharepoint_version=1, sharepoint_parent_id=$2 WHERE id=$1', [old.id, v1.id]);
    } catch (e) {
      // Distinguish "a human intervened" (item gone, or no longer where our
      // records say — leave it alone forever, never force) from a TRANSIENT
      // failure (throttle/network — rethrow so this document's pass fails and
      // the whole shuffle retries later with consistent bookkeeping).
      const humanIntervened = e.status === 404 || e.status === 412 || e.graphCode === 'itemNotFound'
        || /moveOwnItem refused/.test(e.message || '');
      if (!humanIntervened) throw e;
      console.warn(`[sp-sync] version shuffle skipped for doc ${old.id} (human intervention): ${e.message}`);
      await db.query('UPDATE documents SET sharepoint_version=1 WHERE id=$1', [old.id]);
    }
    await sleep(PACING_MS);
  }
  return v1;
}

// --------------------------------------------------------------------- mirror
// Upload `bytes` for `row` into `parentId` and record the mirror on the
// document row. On a name conflict it first checks whether the existing item
// IS this document (identical size + hash): a crash/lost response between
// "uploaded" and "recorded" used to re-upload a "(id)" duplicate on every
// retry — now the earlier successful copy is ADOPTED. Only a genuinely
// different same-named file uniquifies (append-only, nothing overwritten).
async function uploadAndRecord({ row, driveId, parentId, version, bytes, contentSha, nameSuffix }) {
  const localQx = sp.quickXorHash(bytes);
  const cleanName = sp.seg(row.filename || 'document');

  // Adopt-or-null: if the same-named existing item IS these bytes (size +
  // hash), return it so we never mint a duplicate after a crash/lost response.
  const adoptIfIdentical = async (name) => {
    try {
      const existing = await sp.itemMetaByName(driveId, parentId, name);
      const sizeOk = existing && existing.size != null && Number(existing.size) === bytes.length;
      const remoteQx = existing && existing.file && existing.file.hashes && existing.file.hashes.quickXorHash;
      const hashOk = _qxTrusted === true ? (remoteQx && remoteQx === localQx) : true;
      return (sizeOk && hashOk) ? existing : null;
    } catch (_) { return null; }
  };

  const ext = (cleanName.match(/\.[A-Za-z0-9]{1,12}$/) || [''])[0];
  const base = ext ? cleanName.slice(0, -ext.length) : cleanName;
  // Candidate names in order: the clean name, a caller-provided human-readable
  // suffix ("fixed copy" for corrupt-mirror replacements — staff must be able
  // to TELL which file is the good one), then the doc-id uniquifier.
  const candidates = [cleanName];
  if (nameSuffix) candidates.push(`${base} (${nameSuffix})${ext}`);
  candidates.push(`${base} (${String(row.id).slice(0, 8)})${ext}`);

  let up = null;
  for (const name of candidates) {
    up = await sp.uploadNew(driveId, parentId, name, bytes, row.content_type);
    if (!up.conflict) break;
    const adopted = await adoptIfIdentical(name);
    if (adopted) { up = { item: adopted, adopted: true }; break; }
  }
  if (!up || up.conflict) throw new Error('name conflict persisted after uniquification');

  // Self-calibrate the local QuickXorHash against Graph's on this verified
  // fresh upload (size already checked inside uploadNew), then stamp integrity.
  calibrateQuickXor(localQx, up.item, up.item && up.item.size != null && Number(up.item.size) === bytes.length);

  // Trusted-hash transit check: same size but different content hash means the
  // stored copy is NOT our bytes — fail the row so it retries (the adopt path
  // above will not adopt a hash-mismatched item either).
  if (!up.adopted && _qxTrusted === true) {
    const remoteQx = up.item && up.item.file && up.item.file.hashes && up.item.file.hashes.quickXorHash;
    if (remoteQx && remoteQx !== localQx) {
      throw new Error(`upload integrity check failed for "${cleanName}": content hash mismatch (transit corruption) — will retry`);
    }
  }

  await db.query(
    `UPDATE documents SET
        sharepoint_backup_ref = $2,
        sharepoint_web_url = $3,
        sharepoint_backed_up_at = now(),
        sharepoint_backup_error = NULL,
        sharepoint_skipped_reason = NULL,
        sharepoint_version = $4,
        sharepoint_parent_id = $5,
        sharepoint_backup_attempts = sharepoint_backup_attempts + 1,
        sharepoint_backup_attempted_at = now(),
        sha256 = $6,
        sharepoint_item_size = $7,
        sharepoint_verified_at = now(),
        sharepoint_integrity = 'ok'
      WHERE id = $1`,
    [row.id, sp.makeRef(driveId, up.item.id), up.item.webUrl || null, version, parentId,
     contentSha, up.item && up.item.size != null ? Number(up.item.size) : bytes.length]);
  return up;
}

// `retried` guards the one self-heal: when a cached folder id has gone stale
// (a human deleted/moved the folder in SharePoint → Graph itemNotFound), the
// scope cache is invalidated and resolution re-runs once from scratch.
async function mirrorRow(row, retried = false) {
  const scopeKey = scopeKeyFor(row);
  if (!scopeKey) throw new Error('document has no application or borrower to file under');
  try {
    return await mirrorRowInner(row, scopeKey);
  } catch (e) {
    if (!retried && (e.graphCode === 'itemNotFound' || e.status === 404)) {
      console.warn(`[sp-sync] stale folder cache for ${scopeKey} (${e.message}) — re-resolving once`);
      await map.invalidateScope(scopeKey);
      return mirrorRow(row, true);
    }
    throw e;
  }
}

async function mirrorRowInner(row, scopeKey) {
  // Read the bytes FIRST: a missing/corrupt local file must fail the row
  // before any folder is created or a version counter is bumped.
  const bytes = await storage.read(row.storage_ref);

  // Local integrity gate: the bytes on disk must be the bytes the upload
  // recorded. A mismatch means the local copy is damaged (or a ref collision)
  // — mirroring it would push corruption INTO SharePoint.
  if (row.size_bytes != null && Number(row.size_bytes) > 0 && bytes.length !== Number(row.size_bytes)) {
    throw new Error(`local integrity: stored file is ${bytes.length} bytes but the upload recorded ${row.size_bytes} — not mirroring damaged bytes`);
  }

  const contentSha = sha256hex(bytes);

  // Byte-level dedup: if these EXACT bytes, under this filename, in this same
  // scope already have a live mirror copy, don't upload a second identical
  // file — record where the existing copy lives and settle the row. (This is
  // what stops re-submitted identical documents and double-fired exports from
  // stacking "(abc12345)" duplicates in SharePoint.)
  // NEVER dedups a RE-MIRROR (row already carries a ref): a corrupt-mirror
  // replacement or an admin's explicit re-mirror must actually upload — a
  // byte-identical historical sibling would otherwise settle the row while its
  // ref still points at the corrupt item (an endless flag→settle loop).
  const dup = row.sharepoint_backup_ref ? null : (await db.query(
    `SELECT id, sharepoint_web_url, sharepoint_backup_ref FROM documents
      WHERE sha256 = $1 AND filename = $2 AND id <> $3
        AND sharepoint_backup_ref IS NOT NULL
        AND application_id  IS NOT DISTINCT FROM $4
        AND borrower_id     IS NOT DISTINCT FROM $5
        AND llc_id          IS NOT DISTINCT FROM $6
        AND track_record_id IS NOT DISTINCT FROM $7
      ORDER BY created_at DESC LIMIT 1`,
    [contentSha, row.filename, row.id, row.app_id || null, row.borrower_id || null,
     row.llc_id || null, row.track_record_id || null])).rows[0];
  if (dup) {
    await db.query(
      `UPDATE documents SET
          sha256 = $2,
          sharepoint_backed_up_at = now(),
          sharepoint_web_url = $3,
          sharepoint_skipped_reason = $4,
          sharepoint_backup_error = NULL
        WHERE id = $1`,
      [row.id, contentSha, dup.sharepoint_web_url || null,
       `duplicate bytes — identical to already-mirrored document ${dup.id}`]);
    return { webUrl: dup.sharepoint_web_url, deduped: true, path: '(shared with existing mirror copy)' };
  }

  // RE-MIRROR fast path: a document that was mirrored before (the integrity
  // audit found its copy corrupt, or an admin forced a re-mirror) re-uploads
  // into the SAME folder it lived in, so history stays in its Version-N home.
  // Falls back to full resolution when that folder no longer exists.
  if (row.sharepoint_backup_ref && row.sharepoint_parent_id) {
    try {
      const { driveId: oldDriveId } = sp.parseRef(row.sharepoint_backup_ref);
      const up = await uploadAndRecord({
        row, driveId: oldDriveId, parentId: row.sharepoint_parent_id,
        version: row.sharepoint_version || 0, bytes, contentSha,
        // The corrupt copy keeps the clean name (no-delete/no-rename policy);
        // the replacement must be OBVIOUSLY the good one in Explorer.
        nameSuffix: 'fixed copy' });
      try {
        await require('./sync-review').closeStaleReviews({
          taskId: `spdoc:${row.id}`, fieldKey: 'sharepoint_doc',
          note: 'auto-closed — a good copy re-mirrored into the original folder' });
      } catch (_) { /* best-effort */ }
      return { webUrl: up.item.webUrl, path: '(re-mirrored into its original folder)' };
    } catch (e) {
      if (!(e.status === 404 || e.graphCode === 'itemNotFound')) throw e;
      console.warn(`[sp-sync] doc ${row.id} re-mirror target folder is gone — re-resolving from scratch`);
    }
  }

  const target = await map.resolveSyncFolder({
    scopeKey,
    // For the uncertainty review row (owner-directed 2026-07-15 night): a
    // fuzzy-match the resolver wasn't SURE about surfaces in the sync review
    // queue, scoped to the file/borrower so the right people see it.
    applicationId: row.app_id || null,
    borrowerId: row.borrower_id || null,
    officerName: row.officer_name || null,
    borrowerFirst: row.borrower_first || '',
    borrowerLast: row.borrower_last || '',
    addressOneLine: row.address_one_line || null,
    ysLoanNumber: row.ys_loan_number || null,
    // MUST follow the SCOPE, not the raw row: a photo ID uploaded from a file
    // context has app_id set but a borrower scope — passing !!row.app_id here
    // would build (and permanently cache!) the ADDRESS-level chain under the
    // borrower-profile scope key, mis-filing every future profile document.
    hasApplication: scopeKey.startsWith('app:'),
  });
  const driveId = target.driveId;

  const categoryPath = categoryPathFor(row);
  const category = categoryPath.join('/');
  const conditionFolder = await map.resolveConditionFolder(driveId, target.syncFolderId, categoryPath);
  const stateKey = stateKeyFor(row, scopeKey);

  let version = 0;
  let parentId = conditionFolder.id;

  // Regen-kind snapshots NEVER version-shuffle (the Version-47 fix): each
  // surviving snapshot lands in the category folder root under its dated name.
  // Everything else keeps the owner's Version-1/Version-2 supersede flow.
  if (!isRegenKind(row.doc_kind)) {
    let state = await getConditionState(stateKey);
    // A version counter is only meaningful WITHIN one condition folder. If the
    // scope re-resolved into a different tree (Unfiled→officer upgrade, human
    // reorganization + stale-cache heal), the new folder starts a fresh stream
    // at version 0 — otherwise the first doc there would land alone in a
    // phantom "Version N" folder with N climbing forever.
    if (state && state.folder_id && state.folder_id !== conditionFolder.id) state = null;
    if (!state) {
      state = { current_version: 0 };
      await upsertConditionState(stateKey, scopeKey, conditionFolder.id, category, 0);
    }
    version = state.current_version;

    // Version bump on supersede (the owner's Version-1/Version-2 flow).
    if (await isSupersedeEvent(row, stateKey, version, conditionFolder.id)) {
      let bump = true;
      if (version === 0) {
        const v1 = await shuffleRootIntoVersion1(driveId, row, stateKey, conditionFolder);
        if (!v1) bump = false;   // nothing movable — don't start at a phantom Version 2
      }
      if (bump) {
        version = version === 0 ? 2 : version + 1;
        await upsertConditionState(stateKey, scopeKey, conditionFolder.id, category, version);
      }
    }

    // Where this document lands: condition root before any versioning, else the
    // current Version-N folder.
    if (version > 0) {
      const vf = await sp.ensureChildFolder(driveId, conditionFolder.id, `Version ${version}`);
      parentId = vf.id;
    }
  }

  const up = await uploadAndRecord({ row, driveId, parentId, version, bytes, contentSha });

  // A successful mirror vacates any open "mirror failed" review row for this
  // document — fixed at the source, no clicks needed.
  try {
    await require('./sync-review').closeStaleReviews({
      taskId: `spdoc:${row.id}`, fieldKey: 'sharepoint_doc',
      note: `auto-closed — the document mirrored successfully to ${target.fullPath}/${category}` });
  } catch (_) { /* best-effort */ }

  return { webUrl: up.item.webUrl, path: `${target.fullPath}/${category}${version ? `/Version ${version}` : ''}` };
}

async function recordFailure(row, err) {
  const r = await db.query(
    `UPDATE documents SET sharepoint_backup_error=$2,
        sharepoint_backup_attempts = sharepoint_backup_attempts + 1,
        sharepoint_backup_attempted_at = now()
      WHERE id=$1 RETURNING sharepoint_backup_attempts`,
    [row.id, String((err && err.message) || err).slice(0, 500)]);
  // EXHAUSTED → MANUAL REVIEW (owner-directed 2026-07-15 night: "enhance the
  // SharePoint error handling — when it should be sent to manual review").
  // Transient failures retry silently through the attempt budget + the daily
  // fresh chance; a document that BURNS the whole budget is stuck on
  // something real (permissions, a bad path, an unreadable local file) and a
  // human must see it. One row per document (synthetic spdoc:<id> key),
  // dismiss sticks, auto-closed by the success path when a later retry lands.
  try {
    const attempts = r.rows[0] ? Number(r.rows[0].sharepoint_backup_attempts) : 0;
    if (attempts >= MAX_ATTEMPTS) {
      await require('./sync-review').queueReview({
        applicationId: row.app_id || null, borrowerId: row.borrower_id || null,
        taskId: `spdoc:${row.id}`, direction: 'outbound', fieldKey: 'sharepoint_doc',
        reason: 'sharepoint_mirror_failed', suppressIfRejected: true,
        clickupValue: null,
        portalValue: `${row.filename || 'document'} — ${row.item_label || row.slot_label || row.doc_kind || 'file'}`.slice(0, 160),
        rawValue: JSON.stringify({ docId: row.id, attempts,
          error: String((err && err.message) || err).slice(0, 300) }).slice(0, 500) });
    }
  } catch (_) { /* visibility is best-effort — never breaks the mirror */ }
}

// ------------------------------------------------------------ integrity audit
// The corrupted-mirror audit + re-sync (owner-directed 2026-07-15: "look for
// the corrupted documents, re-sync everything so the corrupted documents are
// replaced with working documents"). For every mirrored document it compares
// the LOCAL bytes (size + sha256 + QuickXorHash) against the METADATA Graph
// reports for the mirrored driveItem — bytes are never downloaded back
// (one-way policy holds). Verdicts:
//   ok            — mirror matches the portal bytes.
//   mismatch      — the SharePoint copy is NOT the bytes we hold → the row is
//                   re-queued for the normal mirror pass, which uploads a good
//                   copy (uniquified name; nothing is ever deleted) and
//                   re-points the document at it. The corrupt item stays for a
//                   human to remove (no-delete policy) and is audit-logged.
//   item-missing  — the mirror copy is gone from SharePoint (human deletion is
//                   their prerogative) → sync-review row with the existing
//                   retry/re-match actions; a HUMAN decides whether to re-mirror.
//   local-missing — the portal's own bytes are unreadable; the mirror may be
//                   the ONLY surviving copy → review row, mirror untouched.
const VERIFY_BATCH = 40;
const VERIFY_PACING_MS = 250;
const VERIFY_RECHECK_DAYS = 30;
let _verifyRunning = false;
let _lastVerify = null;

function verifyPollSec() {
  const v = parseInt(process.env.SHAREPOINT_VERIFY_POLL_SEC || '21600', 10);
  return Number.isFinite(v) && v >= 300 ? v : 21600;
}

async function verifyBatch(limit) {
  const { rows } = await db.query(
    `SELECT id, filename, content_type, storage_ref, size_bytes, sha256,
            sharepoint_backup_ref, sharepoint_parent_id, sharepoint_web_url,
            application_id, borrower_id, doc_kind, slot_label, is_current
       FROM documents
      WHERE sharepoint_backup_ref IS NOT NULL
        AND COALESCE(storage_provider, 'local') = 'local'
        AND (sharepoint_verified_at IS NULL
             OR sharepoint_verified_at < now() - make_interval(days => $2))
      ORDER BY sharepoint_verified_at ASC NULLS FIRST, created_at ASC
      LIMIT $1`,
    [limit, VERIFY_RECHECK_DAYS]);
  return rows;
}

async function stampVerdict(id, verdict, extra = {}) {
  // A transient verify ERROR must not push the doc out of the audit rotation
  // for the full recheck window — stamp it as "re-check tomorrow" instead
  // (backdated so it also leaves the head of the NULLS FIRST queue).
  const isError = /^verify-error/.test(String(verdict));
  await db.query(
    `UPDATE documents SET
        sharepoint_verified_at = CASE WHEN $5 THEN now() - make_interval(days => ${VERIFY_RECHECK_DAYS - 1}) ELSE now() END,
        sharepoint_integrity = $2,
        sha256 = COALESCE($3, sha256),
        sharepoint_item_size = COALESCE($4, sharepoint_item_size)
      WHERE id = $1`,
    [id, String(verdict).slice(0, 200), extra.sha256 || null,
     extra.itemSize != null ? Number(extra.itemSize) : null, isError]);
}

async function auditLogVerify(row, action, details) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
       VALUES ('system', NULL, $1, 'document', $2, $3::jsonb)`,
      [action, row.id, JSON.stringify(details).slice(0, 2000)]);
  } catch (_) { /* audit is best-effort here — verdicts live on the document row */ }
}

async function verifyRow(row) {
  const { driveId, itemId } = sp.parseRef(row.sharepoint_backup_ref);

  let bytes;
  try {
    bytes = await storage.read(row.storage_ref);
  } catch (e) {
    // The portal's own copy is unreadable — the mirror may be the ONLY copy
    // left. NEVER touch the mirror; a human must see this.
    await stampVerdict(row.id, 'local-missing');
    try {
      await require('./sync-review').queueReview({
        applicationId: row.application_id || null, borrowerId: row.borrower_id || null,
        taskId: `spdoc:${row.id}`, direction: 'outbound', fieldKey: 'sharepoint_doc',
        reason: 'sharepoint_mirror_failed', suppressIfRejected: true,
        clickupValue: null,
        portalValue: `${row.filename || 'document'} — the portal's local bytes are unreadable (${String(e.message).slice(0, 80)}); the SharePoint mirror copy may be the only surviving copy. Do not delete it.`.slice(0, 300),
        rawValue: JSON.stringify({ docId: row.id, kind: 'local-missing' }).slice(0, 500) });
    } catch (_) { /* visibility best-effort */ }
    return 'local-missing';
  }

  const contentSha = sha256hex(bytes);

  // SOURCE-corruption detector: a mirror that faithfully holds garbage passes
  // the local-vs-remote comparison, so ALSO check that the bytes carry the
  // binary signature their name/type promises (a real PDF starts '%PDF', a
  // docx/xlsx is a ZIP, …). An HTML error page saved as ".pdf" — the classic
  // e-sign-portal download accident — is exactly what staff report as "the
  // file is corrupted, it won't open". These can't be auto-fixed (the good
  // bytes never reached the portal) — they surface for a human to request a
  // fresh copy.
  const BINARY_KINDS = ['pdf', 'png', 'jpg', 'zip', 'gif', 'heic', 'tiff'];
  const expected = expectedKind(row.filename, row.content_type);
  const sniffed = sniffKind(bytes);
  const sourceSuspect = expected && BINARY_KINDS.includes(expected) && sniffed !== expected;
  const okVerdict = sourceSuspect
    ? `source-suspect: content looks like ${sniffed || 'unrecognized data'}, not ${expected} — corrupted before upload; a fresh copy must be re-uploaded`
    : 'ok';
  if (sourceSuspect && row.is_current) {
    try {
      await require('./sync-review').queueReview({
        applicationId: row.application_id || null, borrowerId: row.borrower_id || null,
        taskId: `spdoc:${row.id}`, direction: 'outbound', fieldKey: 'sharepoint_doc',
        reason: 'sharepoint_mirror_failed', suppressIfRejected: true,
        clickupValue: null,
        portalValue: `${row.filename || 'document'} — the FILE ITSELF appears corrupted (content is ${sniffed || 'unrecognized data'}, not ${expected}). It was already damaged when it was uploaded, so re-mirroring cannot fix it: request a fresh copy from whoever uploaded it.`.slice(0, 400),
        rawValue: JSON.stringify({ docId: row.id, kind: 'source-suspect', sniffed, expected }).slice(0, 500) });
    } catch (_) { /* visibility best-effort */ }
  }

  let meta;
  try {
    meta = await sp.itemMeta(driveId, itemId);
  } catch (e) {
    if (e.status === 404 || e.graphCode === 'itemNotFound') {
      await stampVerdict(row.id, 'item-missing', { sha256: contentSha });
      try {
        await require('./sync-review').queueReview({
          applicationId: row.application_id || null, borrowerId: row.borrower_id || null,
          taskId: `spdoc:${row.id}`, direction: 'outbound', fieldKey: 'sharepoint_doc',
          reason: 'sharepoint_mirror_failed', suppressIfRejected: true,
          clickupValue: null,
          portalValue: `${row.filename || 'document'} — its mirror copy is no longer in SharePoint (deleted or moved by a person). Retry re-mirrors it; dismiss keeps it un-mirrored.`.slice(0, 300),
          rawValue: JSON.stringify({ docId: row.id, kind: 'item-missing' }).slice(0, 500) });
      } catch (_) { /* visibility best-effort */ }
      return 'item-missing';
    }
    await stampVerdict(row.id, `verify-error: ${String(e.message).slice(0, 150)}`, { sha256: contentSha });
    return 'verify-error';
  }

  const remoteSize = meta && meta.size != null ? Number(meta.size) : null;
  const remoteQx = meta && meta.file && meta.file.hashes && meta.file.hashes.quickXorHash;
  const localQx = sp.quickXorHash(bytes);
  const sizeMatches = remoteSize != null && remoteSize === bytes.length;

  // A hash MATCH proves the local QuickXorHash implementation (it cannot match
  // by accident) — calibrate trust from it.
  if (sizeMatches && remoteQx && remoteQx === localQx && _qxTrusted === null) _qxTrusted = true;

  const hashMismatch = _qxTrusted === true && remoteQx && remoteQx !== localQx;
  if ((!sizeMatches || hashMismatch) && isRegenKind(row.doc_kind) && row.is_current === false) {
    // An OBSOLETE autosave snapshot with a corrupt mirror is not worth a
    // replacement upload (its newer sibling carries the truth) — record the
    // verdict and move on. Re-uploading these would recreate snapshot churn.
    await stampVerdict(row.id, 'mismatch-superseded (obsolete snapshot; not replaced)', { sha256: contentSha, itemSize: remoteSize });
    return 'ok';
  }
  if (!sizeMatches || hashMismatch) {
    // CORRUPTED MIRROR → re-queue through the normal mirror pass, which
    // uploads a fresh good copy (append-only; the name uniquifies against the
    // corrupt item) and re-points this document's ref/webUrl at it.
    await db.query(
      `UPDATE documents SET
          sharepoint_backed_up_at = NULL,
          sharepoint_backup_attempts = 0,
          sharepoint_backup_error = 'integrity: corrupt mirror copy detected — re-mirroring a good copy',
          sharepoint_verified_at = now(),
          sharepoint_integrity = $2,
          sha256 = $3,
          sharepoint_item_size = $4
        WHERE id = $1`,
      [row.id,
       `mismatch: sharepoint has ${remoteSize == null ? 'unknown size' : remoteSize + ' bytes'}${hashMismatch ? ' (hash differs)' : ''}, portal holds ${bytes.length}`,
       contentSha, remoteSize]);
    await auditLogVerify(row, 'sharepoint_corrupt_mirror_replaced', {
      filename: row.filename, itemId, remoteSize, localSize: bytes.length,
      hashMismatch, corruptItemWebUrl: row.sharepoint_web_url,
      note: 'good copy re-uploads on the next mirror pass; the corrupt SharePoint item is NOT deleted (no-delete policy) — remove it manually if desired',
    });
    return 'mismatch';
  }

  await stampVerdict(row.id, okVerdict, { sha256: contentSha, itemSize: remoteSize });
  return sourceSuspect ? 'source-suspect' : 'ok';
}

/** One integrity-audit pass over a batch of mirrored documents. */
async function verifyOnce({ limit = VERIFY_BATCH } = {}) {
  if (!enabled()) return { skipped: true };
  const rows = await verifyBatch(limit);
  const stats = { scanned: rows.length, ok: 0, mismatch: 0, sourceSuspect: 0, itemMissing: 0, localMissing: 0, errors: 0 };
  for (const row of rows) {
    try {
      const v = await verifyRow(row);
      if (v === 'ok') stats.ok++;
      else if (v === 'mismatch') stats.mismatch++;
      else if (v === 'source-suspect') stats.sourceSuspect++;
      else if (v === 'item-missing') stats.itemMissing++;
      else if (v === 'local-missing') stats.localMissing++;
      else stats.errors++;
    } catch (e) {
      stats.errors++;
      console.warn(`[sp-verify] doc ${row.id} verify failed: ${e.message}`);
      try { await stampVerdict(row.id, `verify-error: ${String(e.message).slice(0, 150)}`); } catch (_) {}
    }
    await sleep(VERIFY_PACING_MS);
  }
  _lastVerify = { at: new Date().toISOString(), ...stats };
  if (rows.length) console.log(`[sp-verify] pass: scanned ${stats.scanned}, ok ${stats.ok}, corrupt-mirror ${stats.mismatch}, corrupt-source ${stats.sourceSuspect}, missing ${stats.itemMissing}, local-missing ${stats.localMissing}, errors ${stats.errors}`);
  return stats;
}

/** Drain the whole verify backlog (boot audit + admin-triggered re-sync). */
async function drainVerify() {
  if (_verifyRunning) return { alreadyRunning: true };
  if (!(await acquireLease('sp-verify'))) {
    console.log('[sp-verify] another instance holds the verify lease — skipping this pass');
    return { leaseHeldElsewhere: true };
  }
  _verifyRunning = true;
  const totals = { scanned: 0, ok: 0, mismatch: 0, sourceSuspect: 0, itemMissing: 0, localMissing: 0, errors: 0 };
  try {
    for (let i = 0; i < MAX_DRAIN_LOOPS; i++) {
      const res = await verifyOnce({});
      await renewLease('sp-verify');
      if (res.skipped || !res.scanned) break;
      for (const k of Object.keys(totals)) totals[k] += res[k] || 0;
      // Everything in a full batch erroring means Graph (or the DB) is having a
      // moment — stop; the interval retries later.
      if (res.scanned > 0 && res.errors === res.scanned) break;
    }
    // Corrupt mirrors were re-queued as pending mirror work — upload the good
    // copies right away rather than waiting for the next sweep.
    if (totals.mismatch > 0) kick();
  } catch (e) {
    console.warn('[sp-verify] drain error:', e.message);
  } finally {
    await releaseLease('sp-verify');
    _verifyRunning = false;
  }
  return totals;
}

// ---------------------------------------------------------------------- passes
/** One reconciliation pass. Never throws for a single document. */
async function runOnce({ limit = DEFAULT_BATCH } = {}) {
  if (!enabled()) return { skipped: true, scanned: 0, mirrored: 0, failed: 0 };
  // Version-churn fix: settle superseded autosave snapshots WITHOUT uploading
  // before selecting work — an editing burst mirrors one file, not N.
  try { await settleSupersededSnapshots(); } catch (e) { console.warn('[sp-sync] snapshot settle error:', e.message); }
  const rows = await pendingBatch(limit);
  let mirrored = 0, failed = 0;
  for (const row of rows) {
    try { await mirrorRow(row); mirrored++; }
    catch (e) {
      failed++;
      console.warn(`[sp-sync] doc ${row.id} failed: ${e.message}`);
      try { await recordFailure(row, e); } catch (_) { /* best-effort */ }
    }
    // Per-document lease renewal: one throttled chunked upload can legally
    // take longer than the whole lease, and an expired lease mid-batch is
    // exactly the double-drain the lease exists to prevent.
    await renewLease('sp-drain');
    await sleep(PACING_MS);
  }
  _lastPass = { at: new Date().toISOString(), scanned: rows.length, mirrored, failed };
  if (rows.length) console.log(`[sp-sync] pass: scanned ${rows.length}, mirrored ${mirrored}, failed ${failed}`);
  return { scanned: rows.length, mirrored, failed };
}

/** Drain everything pending (the first-run backfill + burst catch-up). */
async function drain() {
  if (_running) return;
  if (!(await acquireLease('sp-drain'))) {
    console.log('[sp-sync] another instance holds the drain lease — skipping this pass');
    return;
  }
  _running = true;
  try {
    // Documents that exhausted their attempts get one fresh chance per day —
    // a persistent outage (or a bug fixed by a deploy) must not orphan them.
    await db.query(
      `UPDATE documents SET sharepoint_backup_attempts = 0
        WHERE sharepoint_backed_up_at IS NULL AND sharepoint_backup_attempts >= $1
          AND sharepoint_backup_attempted_at < now() - interval '1 day'`,
      [MAX_ATTEMPTS]).catch(() => {});
    for (let i = 0; i < MAX_DRAIN_LOOPS; i++) {
      const res = await runOnce({});
      await renewLease('sp-drain');
      if (res.skipped || res.scanned === 0) break;
      // If everything in a full batch failed, stop — retrying immediately would
      // hammer the same failure; the interval sweep retries later.
      if (res.scanned > 0 && res.mirrored === 0) break;
    }
  } catch (e) {
    console.warn('[sp-sync] drain error:', e.message);
  } finally {
    await releaseLease('sp-drain');
    _running = false;
    // Lost-wakeup guard: an upload that arrived while this drain was running
    // re-queues one more pass instead of waiting for the interval sweep.
    if (_rekick) { _rekick = false; kick(); }
  }
}

/**
 * Called by every upload path right after a document row lands: mirrors new
 * documents to SharePoint within seconds. Debounced so a multi-file upload
 * triggers one pass. Fire-and-forget — never throws into the request path.
 */
function kick() {
  if (!enabled()) return;
  if (_running) { _rekick = true; return; }   // drain in flight — run again after
  if (_kickTimer) return;
  _kickTimer = setTimeout(() => {
    _kickTimer = null;
    drain().catch((e) => console.warn('[sp-sync] kick error:', e.message));
  }, KICK_DEBOUNCE_MS);
  if (_kickTimer.unref) _kickTimer.unref();
}

function start() {
  if (_interval) return;
  if (!enabled()) {
    console.log('[sp-sync] disabled (set SHAREPOINT_BACKUP_ENABLED=1 + MS_* creds to enable)');
    return;
  }
  // Boot reset: rows that exhausted their retry budget get a fresh chance on
  // every deploy — deploys are exactly when fixes arrive (learned in prod:
  // the first backfill burned all 8 attempts on a bug that the next deploy
  // fixed, and the daily reset alone would have stalled the mirror for a day).
  // Time-guarded (30 min) so a burst of rapid deploys doesn't re-burn 8
  // attempts of Graph traffic per deploy on permanently-failing rows.
  db.query(
    `UPDATE documents SET sharepoint_backup_attempts = 0
      WHERE sharepoint_backed_up_at IS NULL AND sharepoint_backup_attempts >= $1
        AND (sharepoint_backup_attempted_at IS NULL
             OR sharepoint_backup_attempted_at < now() - interval '30 minutes')`,
    [MAX_ATTEMPTS]).catch(() => {});
  const sec = Number.isFinite(cfg.sharepointBackupPollSec) ? cfg.sharepointBackupPollSec : 300;
  const ms = Math.max(60, sec) * 1000;
  console.log(`[sp-sync] enabled — mirroring into "${cfg.sharepointPipelineRoot}/**/${cfg.sharepointSyncFolderName}" (sweep every ${ms / 1000}s)`);
  _interval = setInterval(() => drain(), ms);
  if (_interval.unref) _interval.unref();
  // First-run full-history backfill (and boot catch-up) — oldest-first drain.
  const boot = setTimeout(() => drain(), 5000);
  if (boot.unref) boot.unref();
  // Integrity audit: sweep every mirrored document (paced metadata reads, no
  // byte downloads), re-mirroring any corrupted copy. First full audit runs
  // shortly after boot; steady-state re-checks each doc every 30 days.
  const vms = verifyPollSec() * 1000;
  _verifyInterval = setInterval(() => drainVerify().catch(() => {}), vms);
  if (_verifyInterval.unref) _verifyInterval.unref();
  const vboot = setTimeout(() => drainVerify().catch((e) => console.warn('[sp-verify] boot audit error:', e.message)), 60000);
  if (vboot.unref) vboot.unref();
}

function stop() {
  if (_interval) { clearInterval(_interval); _interval = null; }
  if (_verifyInterval) { clearInterval(_verifyInterval); _verifyInterval = null; }
  if (_kickTimer) { clearTimeout(_kickTimer); _kickTimer = null; }
}

function health() {
  return {
    enabled: enabled(), configured: sp.configured(), running: _running, lastPass: _lastPass,
    verify: { running: _verifyRunning, lastPass: _lastVerify, quickXorTrusted: _qxTrusted },
  };
}

module.exports = {
  start, stop, kick, runOnce, drain, enabled, health, categoryFor, mirrorRow,
  verifyOnce, drainVerify, settleSupersededSnapshots, isRegenKind,
};
