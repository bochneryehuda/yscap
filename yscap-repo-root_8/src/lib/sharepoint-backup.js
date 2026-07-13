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
const cfg = require('../config');
const db = require('../db');
const storage = require('./storage');
const sp = require('./sharepoint');
const map = require('./sharepoint-map');

const MAX_ATTEMPTS = 8;            // per-document retry cap (interval sweeps retry)
const DEFAULT_BATCH = 25;
const PACING_MS = 300;             // between uploads — keeps Graph bursts polite
const KICK_DEBOUNCE_MS = 4000;     // collapse a burst of uploads into one pass;
                                   // MUST exceed pendingBatch's 3s settle window
                                   // or a kicked pass would skip the very doc
                                   // that kicked it and wait for the sweep
const MAX_DRAIN_LOOPS = 200;       // backfill safety valve per drain (200*25 docs)

let _running = false;              // single-flight: kick + interval never overlap
let _rekick = false;               // an upload arrived mid-drain — drain again after
let _kickTimer = null;
let _interval = null;
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
            d.slot_label, d.doc_kind, d.source_type, d.is_current,
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
        AND d.created_at < now() - interval '3 seconds'
      -- attempts ASC first: fresh uploads are never starved behind a head-of-
      -- queue clump of repeatedly-failing rows; created_at ASC within a tier
      -- keeps the backfill's version replay chronological.
      ORDER BY d.sharepoint_backup_attempts ASC, d.created_at ASC
      LIMIT $1`,
    [limit, MAX_ATTEMPTS],
  );
  return rows;
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

  const target = await map.resolveSyncFolder({
    scopeKey,
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

  let state = await getConditionState(stateKey);
  if (!state) {
    state = { current_version: 0 };
    await upsertConditionState(stateKey, scopeKey, conditionFolder.id, category, 0);
  }
  let version = state.current_version;

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
  let parentId = conditionFolder.id;
  if (version > 0) {
    const vf = await sp.ensureChildFolder(driveId, conditionFolder.id, `Version ${version}`);
    parentId = vf.id;
  }

  // Upload with the clean original filename; uniquify only on a real conflict
  // (append-only — never overwrite an existing item).
  const cleanName = sp.seg(row.filename || 'document');
  let up = await sp.uploadNew(driveId, parentId, cleanName, bytes, row.content_type);
  if (up.conflict) {
    const ext = (cleanName.match(/\.[A-Za-z0-9]{1,12}$/) || [''])[0];
    const base = ext ? cleanName.slice(0, -ext.length) : cleanName;
    up = await sp.uploadNew(driveId, parentId, `${base} (${String(row.id).slice(0, 8)})${ext}`, bytes, row.content_type);
    if (up.conflict) throw new Error('name conflict persisted after uniquification');
  }

  await db.query(
    `UPDATE documents SET
        sharepoint_backup_ref = $2,
        sharepoint_web_url = $3,
        sharepoint_backed_up_at = now(),
        sharepoint_backup_error = NULL,
        sharepoint_version = $4,
        sharepoint_parent_id = $5,
        sharepoint_backup_attempts = sharepoint_backup_attempts + 1,
        sharepoint_backup_attempted_at = now()
      WHERE id = $1`,
    [row.id, sp.makeRef(driveId, up.item.id), up.item.webUrl || null, version, parentId]);

  return { webUrl: up.item.webUrl, path: `${target.fullPath}/${category}${version ? `/Version ${version}` : ''}` };
}

async function recordFailure(row, err) {
  await db.query(
    `UPDATE documents SET sharepoint_backup_error=$2,
        sharepoint_backup_attempts = sharepoint_backup_attempts + 1,
        sharepoint_backup_attempted_at = now()
      WHERE id=$1`,
    [row.id, String((err && err.message) || err).slice(0, 500)]);
}

// ---------------------------------------------------------------------- passes
/** One reconciliation pass. Never throws for a single document. */
async function runOnce({ limit = DEFAULT_BATCH } = {}) {
  if (!enabled()) return { skipped: true, scanned: 0, mirrored: 0, failed: 0 };
  const rows = await pendingBatch(limit);
  let mirrored = 0, failed = 0;
  for (const row of rows) {
    try { await mirrorRow(row); mirrored++; }
    catch (e) {
      failed++;
      console.warn(`[sp-sync] doc ${row.id} failed: ${e.message}`);
      try { await recordFailure(row, e); } catch (_) { /* best-effort */ }
    }
    await sleep(PACING_MS);
  }
  _lastPass = { at: new Date().toISOString(), scanned: rows.length, mirrored, failed };
  if (rows.length) console.log(`[sp-sync] pass: scanned ${rows.length}, mirrored ${mirrored}, failed ${failed}`);
  return { scanned: rows.length, mirrored, failed };
}

/** Drain everything pending (the first-run backfill + burst catch-up). */
async function drain() {
  if (_running) return;
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
      if (res.skipped || res.scanned === 0) break;
      // If everything in a full batch failed, stop — retrying immediately would
      // hammer the same failure; the interval sweep retries later.
      if (res.scanned > 0 && res.mirrored === 0) break;
    }
  } catch (e) {
    console.warn('[sp-sync] drain error:', e.message);
  } finally {
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
  db.query(
    `UPDATE documents SET sharepoint_backup_attempts = 0
      WHERE sharepoint_backed_up_at IS NULL AND sharepoint_backup_attempts >= $1`,
    [MAX_ATTEMPTS]).catch(() => {});
  const sec = Number.isFinite(cfg.sharepointBackupPollSec) ? cfg.sharepointBackupPollSec : 300;
  const ms = Math.max(60, sec) * 1000;
  console.log(`[sp-sync] enabled — mirroring into "${cfg.sharepointPipelineRoot}/**/${cfg.sharepointSyncFolderName}" (sweep every ${ms / 1000}s)`);
  _interval = setInterval(() => drain(), ms);
  if (_interval.unref) _interval.unref();
  // First-run full-history backfill (and boot catch-up) — oldest-first drain.
  const boot = setTimeout(() => drain(), 5000);
  if (boot.unref) boot.unref();
}

function stop() {
  if (_interval) { clearInterval(_interval); _interval = null; }
  if (_kickTimer) { clearTimeout(_kickTimer); _kickTimer = null; }
}

function health() {
  return { enabled: enabled(), configured: sp.configured(), running: _running, lastPass: _lastPass };
}

module.exports = { start, stop, kick, runOnce, drain, enabled, health, categoryFor, mirrorRow };
