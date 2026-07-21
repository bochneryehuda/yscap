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
// draw_inspection_report (Draw Management phase 2b) is a SYSTEM-REGENERABLE, version-hashed artifact —
// PILOT rebuilds it on demand from the persisted findings + durable photos, and a new version supersedes the
// prior of the SAME report identity. So it takes the REGEN path (settle superseded copies without a Version-N
// shuffle, land in the category root) exactly like tpr_export / track_record_html — never the human Version-N
// path, which would churn the mirror every time a draw changes.
// NULL-SAFE (root fix 2026-07-21): a bare `d.doc_kind` here is a SQL three-valued-
// logic trap. For an ORDINARY upload doc_kind IS NULL, so `NULL = 'x'` / `NULL LIKE
// '…'` are NULL (not FALSE), making this whole expression NULL. Fed into the drain
// + stray-net regen-skip guard `NOT (REGEN_KIND_SQL AND is_current=false)`, a doc
// with doc_kind NULL AND is_current=false evaluates to `NOT(NULL)=NULL` → the row
// is FILTERED OUT of BOTH pendingBatch and neverAttemptedStrays, yet stuckDocuments/
// reconciliation (no regen guard) still count it → it sat "(not yet attempted)" for
// hours (a superseded insurance PDF, etc.) until the 12h escalation force-attempted
// it. COALESCE(d.doc_kind,'') makes this strictly TRUE/FALSE, matching the JS
// isRegenKind() below and NEVER_MIRROR_SQL, so a doc_kind-NULL doc is correctly
// non-regen (FALSE) and the guard becomes `NOT(FALSE AND …)=TRUE` → selected +
// mirrored within seconds. Every consumer derives from this ONE constant.
const REGEN_KIND_SQL = `(COALESCE(d.doc_kind,'') = 'track_record_html' OR COALESCE(d.doc_kind,'') = 'tpr_export' OR COALESCE(d.doc_kind,'') = 'draw_inspection_report' OR COALESCE(d.doc_kind,'') LIKE '%\\_export')`;
function isRegenKind(k) { return k === 'track_record_html' || k === 'tpr_export' || k === 'draw_inspection_report' || /_export$/.test(String(k || '')); }
// ONE definition of "deliberately NEVER mirrored to SharePoint" (owner-directed).
// The drain-exclusion SQL, the settle pass, AND the upload chokepoint ALL derive
// from this single map so they can never diverge. ROOT of the appraisal_photo
// stuck-noise bug (2026-07-20): a kind was added to the exclusion SQL but NOT to
// the settle set, so those docs were skipped by the drain yet never stamped
// "skipped" — they sat backed_up_at IS NULL as "(not yet attempted)" forever,
// driving a permanent stuck/backlog-SLO false alarm. Deriving both from this map
// makes that whole class impossible.
//   • heter_iska_signed — owner policy: kept in-system + on DocuSign ONLY (never
//     leaks; companion to the TPR export denylist + rtl_cond_iska.tpr_exclude).
//     (DOCUSIGN-DOCUMENT-BUILD-SPEC Addendum A.3/A.9.)
//   • appraisal_photo — derived thumbnails auto-extracted from the appraisal PDF
//     (which IS mirrored); up to ~24 per file, so mirroring them floods the team
//     site for no gain.
const NEVER_MIRROR_REASON = {
  heter_iska_signed: 'never mirrored (owner policy: the Heter Iska is kept in-system + on DocuSign only)',
  appraisal_photo: 'not mirrored — a thumbnail auto-extracted from the appraisal (the appraisal PDF itself IS mirrored)',
};
const DEFAULT_NEVER_MIRROR_REASON = 'not mirrored (owner policy: this document kind is kept in-system only)';
const NEVER_MIRROR_KINDS = new Set(Object.keys(NEVER_MIRROR_REASON));
function neverMirrorReason(kind) { return NEVER_MIRROR_REASON[kind] || DEFAULT_NEVER_MIRROR_REASON; }
const _sqlLit = (s) => `'${String(s).replace(/'/g, "''")}'`;
// Per-kind skipped_reason as a SQL CASE, built from the same map so the settle
// pass stamps the RIGHT reason for every never-mirror kind (not a hardcoded one).
const NEVER_MIRROR_REASON_CASE = `CASE d.doc_kind ${Object.entries(NEVER_MIRROR_REASON)
  .map(([k, v]) => `WHEN ${_sqlLit(k)} THEN ${_sqlLit(v)}`).join(' ')} ELSE ${_sqlLit(DEFAULT_NEVER_MIRROR_REASON)} END`;
// Drain-selector SQL fragment — a doc is IN-SCOPE for mirroring when it is not a
// never-mirror kind AND not a lead-CRM attachment (a `lead_id` with no pipeline
// scope — no application/borrower/llc/track-record/checklist item — has nowhere
// to file, so it would churn doomed "no borrower or loan file" attempts and sit
// as permanent stuck noise, A-Z audit F1). Built FROM NEVER_MIRROR_KINDS so the
// SQL and the settle set can never drift apart again.
const NEVER_MIRROR_SQL = `(COALESCE(d.doc_kind,'') NOT IN (${[...NEVER_MIRROR_KINDS].map(_sqlLit).join(',')})
  AND NOT (d.lead_id IS NOT NULL AND d.application_id IS NULL AND d.borrower_id IS NULL
           AND d.checklist_item_id IS NULL AND d.llc_id IS NULL AND d.track_record_id IS NULL))`;
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
    // Bounded: a lock-hung renew in the drain loop must not stall the pass (it's
    // awaited after each doc). withTimeout defined below (hoisted).
    await withTimeout(db.query(
      `UPDATE sync_locks SET expires_at = now() + make_interval(mins => ${LEASE_MINUTES})
        WHERE lock_key = $1 AND holder = $2`, [key, _holderId]), DB_OP_TIMEOUT_MS, 'lease renew timed out');
  } catch (_) { /* best-effort */ }
}
async function releaseLease(key) {
  try {
    await withTimeout(db.query(
      `UPDATE sync_locks SET expires_at = now() WHERE lock_key = $1 AND holder = $2`,
      [key, _holderId]), DB_OP_TIMEOUT_MS, 'lease release timed out');
  } catch (_) { /* best-effort */ }
}

// ------------------------------------------------ worker-liveness heartbeat
// A persistent dead-man's switch (industry standard for background workers,
// learned from the 2026-07-20 six-hour freeze: the only alarm watched the
// BACKLOG — a downstream symptom — while the worker itself was dead, so nothing
// fired on the actual failure). Every COMPLETED reconciler pass stamps a
// heartbeat row in sync_locks ('sp-drain-heartbeat') whose expires_at is now +
// a generous grace. If wall-clock passes expires_at, the worker has NOT
// completed a pass within the grace window — it is stalled or dead — and the
// liveness watchdog self-heals + (only if that fails) alerts. Persisting it (vs
// the in-memory _lastPass) means /health and any instance can read the true
// "last made progress" time even across a process restart or crash.
const HEARTBEAT_KEY = 'sp-drain-heartbeat';
function heartbeatGraceSec() {
  // 3× the poll interval, floor 15 min: an idle worker still completes an empty
  // pass every interval, so only a genuine stall/death lets this lapse.
  // Match start()'s clamp [60, 3600] so an absurd poll can't push the grace so
  // far out that the dead-man's switch never fires (A-Z audit D2).
  const poll = Number.isFinite(cfg.sharepointBackupPollSec) ? Math.max(60, Math.min(cfg.sharepointBackupPollSec, 3600)) : 300;
  return Math.max(poll * 3, 900);
}
async function recordHeartbeat(stats) {
  try {
    await db.query(
      `INSERT INTO sync_locks (lock_key, holder, expires_at)
       VALUES ($1, $2, now() + make_interval(secs => $3))
       ON CONFLICT (lock_key) DO UPDATE
         SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at`,
      [HEARTBEAT_KEY, JSON.stringify({ at: new Date().toISOString(), pid: _holderId, ...(stats || {}) }).slice(0, 500), heartbeatGraceSec()]);
  } catch (_) { /* liveness is best-effort — never break the pass */ }
}
// Seconds since the last completed pass (null if never / unknown). Reads the
// persistent heartbeat so it is correct even if THIS process just booted.
async function heartbeatStaleSec() {
  try {
    const { rows } = await db.query(
      `SELECT EXTRACT(EPOCH FROM (now() - (expires_at - make_interval(secs => $2))))::bigint AS age
         FROM sync_locks WHERE lock_key = $1`, [HEARTBEAT_KEY, heartbeatGraceSec()]);
    return rows[0] ? Number(rows[0].age) : null;
  } catch (_) { return null; }
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
// A single mirror attempt must never hang the whole pass. Every Graph HTTP call
// already has its own 60s/180s socket timeout, but a DB query blocked on a lock
// has NO timeout in pg — and one stalled attempt with the old code left the
// in-memory _running flag stuck true, freezing EVERY later drain (the 2026-07-20
// "nothing synced for 6h; docs stuck at not-yet-attempted" incident). This
// bounds one attempt; a hang becomes a recorded error and the pass continues.
// Set ABOVE a typical slow upload (sharepoint.js: 180s per-chunk socket timeout
// plus a few throttle sleeps) yet BELOW the 15-min stall ceiling. A
// pathologically throttled huge file (up to 8 retries × ~120s) can still hit
// this cap — that just records a normal failure and retries next pass (the
// background upload usually lands and self-heals), never a freeze. The cap MUST
// stay < DRAIN_STALL_CEILING_MS so one doc's heartbeat gap can't age out a pass.
const MIRROR_ATTEMPT_TIMEOUT_MS = 600000;   // 10 min: > typical real upload, < the stall ceiling
// If a drain has made NO progress for longer than this, treat it as dead (a
// hung await that never settled) and let a fresh pass start instead of no-opping
// forever — the freeze self-heals on the next interval, no restart needed.
// "Progress" is heartbeated (see _runningSince below), so a healthy long
// backfill never trips this — only a genuinely stalled pass ages out.
const DRAIN_STALL_CEILING_MS = 15 * 60 * 1000;
// Bound the reconciler's OWN DB queries too (settle passes, pendingBatch, boot
// reset). node-postgres has no default statement_timeout, so a query blocked on
// a row/table lock waits forever — exactly the hang class that froze the drain
// (the pre-loop queries run OUTSIDE the per-document timeout). This caps the
// caller so a lock-blocked query becomes a logged, recoverable error, not a
// freeze. A normal query here is milliseconds; 60s only ever trips on a lock.
const DB_OP_TIMEOUT_MS = 60000;
// Cap how long ONE drain may monopolize the single-flight slot. Without this a
// cluster of slow/throttled documents (each up to the 10-min per-doc cap) could
// run a single drain for hours, deferring every freshly-uploaded document's kick
// until it finished (the gap-audit's poison-pill-throughput starvation). When a
// drain exceeds this it yields cleanly (releases the lease, fires any pending
// re-kick); the interval/kick then starts a fresh pass so new uploads are not
// starved. Kept BELOW the stall ceiling so a yielded drain is never a stalled one.
const DRAIN_BUDGET_MS = 10 * 60 * 1000;

let _running = false;              // single-flight: kick + interval never overlap
let _runningSince = 0;             // heartbeat: wall-clock ms of the in-flight drain's LAST progress
let _runSeq = 0;                   // generation token — a stalled pass can't reset newer state
// Mark forward progress so the stall guard measures time-since-progress, not
// time-since-start — a healthy long backfill keeps itself fresh; only a pass
// wedged with no progress ages out. Guarded by the generation token so a zombie
// pass can't keep a superseding pass's clock alive.
function heartbeat(mySeq) { if (mySeq === _runSeq) _runningSince = Date.now(); }
// A drain is "actively progressing in THIS process" — used to suppress a false
// stall verdict while a legitimately slow batch (large/throttled uploads) runs.
// The persistent heartbeat only stamps periodically, so a single long runOnce
// could otherwise read stale cross-process; this in-process check is the truth
// for the running instance.
function drainProgressing() { return _running && Date.now() - _runningSince < DRAIN_STALL_CEILING_MS; }
// Throttle the PERSISTENT heartbeat so a healthy long backfill keeps the
// cross-process liveness fresh (not just once-per-batch) without a DB write per
// document. Fire-and-forget — recordHeartbeat is self-guarding.
let _lastPersistMs = 0;
const HEARTBEAT_PERSIST_MIN_MS = 30000;
function maybePersistHeartbeat(mySeq, stats) {
  if (mySeq && mySeq !== _runSeq) return;
  if (Date.now() - _lastPersistMs < HEARTBEAT_PERSIST_MIN_MS) return;
  _lastPersistMs = Date.now();
  recordHeartbeat(stats);
}
let _rekick = false;               // an upload arrived mid-drain — drain again after
let _kickTimer = null;
let _interval = null;
let _verifyInterval = null;
let _sloInterval = null;
let _livenessInterval = null;      // dead-man's-switch watchdog interval
let _startedAtMs = 0;              // when start() ran — so a worker that never produced a first heartbeat is still judged
let _lastPass = null;              // stats for /api/health

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bound any promise so a stalled operation can't hang its caller forever. The
// underlying work is not cancelled (it settles on its own socket/query timeout),
// but the caller stops waiting — the difference between "one slow document" and
// "the whole reconciler frozen until a restart".
function withTimeout(promise, ms, message) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(message)), ms); if (t.unref) t.unref(); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function enabled() {
  return require('./integrations/switches').on('SHAREPOINT_BACKUP_ENABLED') && sp.configured();
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
  // Draw Management phase 2b — the PILOT-branded inspection reports get their own category so their
  // frequent version-hashed supersedes never shuffle other (uncategorized) file documents.
  if (row.doc_kind === 'draw_inspection_report') return ['Draw Reports'];
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
// The enrichment (SELECT list + joins) shared by pendingBatch AND the
// force-attempt path, so a document loaded by id carries the EXACT same fields
// the mirror needs — no drift between "what the batch sees" and "what a forced
// attempt sees".
const ENRICH_SELECT = `
    SELECT d.id, d.filename, d.content_type, d.storage_ref, d.storage_provider,
           d.slot_label, d.doc_kind, d.source_type, d.is_current, d.size_bytes,
           d.sharepoint_backup_ref, d.sharepoint_parent_id, d.sharepoint_version,
           d.sharepoint_integrity, d.sharepoint_item_size,
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
      ) recent ON true`;

async function pendingBatch(limit) {
  const { rows } = await db.query(
    `${ENRICH_SELECT}
      WHERE d.sharepoint_backed_up_at IS NULL
        AND ${NEVER_MIRROR_SQL}
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
        -- skipped; this predicate is the belt to that suspender). NULL-safe:
        -- COALESCE(is_current,true) so a NULL is_current is treated as CURRENT
        -- (selected + attempted) rather than silently excluded here AND from
        -- the settle pass — the gap that stranded a doc "not yet attempted".
        AND NOT (${REGEN_KIND_SQL} AND COALESCE(d.is_current, true) = false)
      -- attempts ASC first: fresh uploads are never starved behind a head-of-
      -- queue clump of repeatedly-failing rows; created_at ASC within a tier
      -- keeps the backfill's version replay chronological.
      ORDER BY d.sharepoint_backup_attempts ASC, d.created_at ASC
      LIMIT $1`,
    [limit, MAX_ATTEMPTS, snapshotSettleSec()],
  );
  return rows;
}

// Load ONE document's fully-enriched row by id, with NO selection filters —
// used by the force-attempt path so a document that pendingBatch skipped for
// ANY reason can still be mirrored (or produce a real, classifiable error
// instead of sitting "not yet attempted" forever).
async function enrichedRowById(id) {
  const { rows } = await db.query(`${ENRICH_SELECT} WHERE d.id = $1`, [id]);
  return rows[0] || null;
}

// ------------------------------------------------- never-attempted stray net
// Root fix for "the document is stuck / last error: (not yet attempted)": a
// document can be excluded from pendingBatch by a selection predicate (a
// non-'local' storage_provider, a NULL/false is_current, a scope the JOINs
// don't resolve) while it is still un-mirrored with real bytes on disk. When
// that happens the normal drain never touches it, so recordFailure never runs,
// so it sits at attempts=0 / error=NULL — invisible and un-attempted — until
// the 12h SLO escalation force-attempts it. That window is too long and the
// cause is never logged. This selector finds exactly that population — past a
// grace window, attempts=0, error NULL, NOT a settling phantom — and does NOT
// filter on storage_provider, so even a doc the normal batch can't see is
// surfaced. runOnce force-attempts each one EVERY pass, so a stray gets one
// real attempt (mirror, or a classified error) within a single poll cycle.
const STRAY_BATCH = 15;                 // small: this is a safety net, not the main path
function strayGraceSec() {
  // Past the settle window + a margin: a doc this old that is STILL un-attempted
  // was definitively skipped by the normal selector, not merely mid-settle.
  return Math.max(snapshotSettleSec(), 300) + 60;
}
async function neverAttemptedStrays(limit) {
  const { rows } = await db.query(
    `SELECT d.id, d.filename, d.doc_kind, d.is_current, d.storage_ref,
            COALESCE(d.storage_provider, 'local') AS storage_provider,
            d.sharepoint_backup_attempts AS attempts,
            round(EXTRACT(EPOCH FROM (now() - d.created_at)) / 3600.0, 1) AS age_hours,
            (${REGEN_KIND_SQL}) AS is_regen,
            COALESCE(d.application_id, ci.application_id)                        AS app_id,
            COALESCE(d.borrower_id, ci.borrower_id, l.borrower_id, a.borrower_id) AS borrower_id
       FROM documents d
       LEFT JOIN checklist_items ci ON ci.id = d.checklist_item_id
       LEFT JOIN llcs l             ON l.id = COALESCE(d.llc_id, ci.llc_id)
       LEFT JOIN applications a     ON a.id = COALESCE(d.application_id, ci.application_id)
      WHERE d.sharepoint_backed_up_at IS NULL
        AND ${NEVER_MIRROR_SQL}
        AND d.storage_ref IS NOT NULL
        AND d.sharepoint_backup_attempts = 0
        AND d.sharepoint_backup_error IS NULL
        AND d.created_at < now() - make_interval(secs => $2)
        -- A superseded regen snapshot settles WITHOUT uploading (settle pass);
        -- never force-attempt one. Everything else is fair game.
        AND NOT ((${REGEN_KIND_SQL}) AND COALESCE(d.is_current, true) = false)
      ORDER BY d.created_at ASC
      LIMIT $1`,
    [limit, strayGraceSec()]);
  return rows;
}

// Human/log-readable answer to "why did the document get stuck?" — names the
// pendingBatch predicate(s) that would exclude this row, so a production log
// line pinpoints the cause instead of leaving "(not yet attempted)".
function explainExclusion(row) {
  const reasons = [];
  const prov = row.storage_provider || 'local';
  if (prov !== 'local') reasons.push(`storage_provider='${prov}' (the normal drain only mirrors 'local' bytes)`);
  if (row.is_regen && row.is_current === false) reasons.push('superseded auto-saved snapshot (should have settled)');
  if (row.is_regen && row.is_current == null) reasons.push('regen snapshot with NULL is_current');
  if (!row.app_id && !row.borrower_id) reasons.push('no application/borrower scope resolves (nothing to file it under)');
  return reasons.length
    ? `excluded from the normal batch by: ${reasons.join('; ')}`
    : 'no obvious exclusion predicate — check drain/lease health (the pass may not be running)';
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
        AND COALESCE(d.is_current, true) = false
        AND ${REGEN_KIND_SQL}
        AND d.storage_ref IS NOT NULL
      RETURNING d.id`);
  if (r.rowCount) console.log(`[sp-sync] settled ${r.rowCount} superseded snapshot(s) without uploading`);
  // A settled row is RESOLVED — any open "mirror failed" review card for it
  // must close itself (the 2026-07-16 queue: old exhausted SOW exports that a
  // newer save has since replaced would otherwise stay open forever).
  for (const row of r.rows.slice(0, 200)) {
    try {
      await require('./sync-review').closeStaleReviews({
        taskId: `spdoc:${row.id}`, fieldKey: 'sharepoint_doc',
        note: 'auto-closed — a newer copy of this snapshot mirrors instead; nothing was lost' });
    } catch (_) { /* best-effort */ }
  }
  return r.rowCount || 0;
}

// NEVER-MIRROR kinds (the signed Heter Iska) are SETTLED without uploading, the
// same way superseded snapshots are — stamp sharepoint_backed_up_at so they
// leave the pending/oldest-pending/stuck/backlog-SLO population entirely. Without
// this a signed Heter would sit backed_up_at IS NULL forever and (a) drive a
// permanent backlog-SLO breach + false "not mirrored" admin alerts, and (b) get
// force-attempted every sweep. The mirrorRow chokepoint guard stamps the same on
// a force-attempt; this pass catches the rows the excluding selectors never even
// hand to mirrorRow. (Audit HIGH, 2026-07-19.)
async function settleNeverMirror() {
  const r = await db.query(
    `UPDATE documents d SET
        sharepoint_backed_up_at = now(),
        sharepoint_skipped_reason = ${NEVER_MIRROR_REASON_CASE},
        sharepoint_backup_error = NULL
      WHERE d.sharepoint_backed_up_at IS NULL
        AND COALESCE(d.doc_kind,'') = ANY($1)
        AND d.storage_ref IS NOT NULL
      RETURNING d.id`, [Array.from(NEVER_MIRROR_KINDS)]);
  if (r.rowCount) console.log(`[sp-sync] settled ${r.rowCount} never-mirror doc(s) (kept in-system only)`);
  // Lead-CRM attachments (lead_id only, no pipeline scope): settle them skipped
  // too so they never count as pending/stuck or drive a false SLO breach (A-Z
  // audit F1). They belong to the CRM, not the SharePoint pipeline.
  const lead = await db.query(
    `UPDATE documents d SET
        sharepoint_backed_up_at = now(),
        sharepoint_skipped_reason = 'not mirrored — a lead/CRM attachment, not a pipeline document',
        sharepoint_backup_error = NULL
      WHERE d.sharepoint_backed_up_at IS NULL
        AND d.storage_ref IS NOT NULL
        AND d.lead_id IS NOT NULL AND d.application_id IS NULL AND d.borrower_id IS NULL
        AND d.checklist_item_id IS NULL AND d.llc_id IS NULL AND d.track_record_id IS NULL
      RETURNING d.id`);
  if (lead.rowCount) console.log(`[sp-sync] settled ${lead.rowCount} lead/CRM attachment(s) (not pipeline docs)`);
  return (r.rowCount || 0) + (lead.rowCount || 0);
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
async function uploadAndRecord({ row, driveId, parentId, version, bytes, contentSha, nameSuffix, pathBudget }) {
  const localQx = sp.quickXorHash(bytes);
  let cleanName = sp.seg(row.filename || 'document');
  // SharePoint's full decoded path limit is ~400 characters. Deep chains
  // (officer/borrower/long address/condition/Version N) + a long filename can
  // exceed it and fail every upload for that document forever. When the caller
  // knows the folder path length, the FILENAME is trimmed to fit (extension
  // preserved, floor of 24 chars) — a shortened name beats a dead mirror.
  // Reserve room for the uniquifier suffix that may be appended AFTER this trim
  // (" (fixed copy)" / " (12345678)") so a name that needs BOTH trimming AND
  // uniquification still fits the ~400-char path limit (A-Z audit F2 — else the
  // uniquified candidate exceeds it and every upload 400s forever).
  const SUFFIX_RESERVE = 16;
  if (pathBudget && cleanName.length > Math.max(24, pathBudget) - SUFFIX_RESERVE) {
    const ext = (cleanName.match(/\.[A-Za-z0-9]{1,12}$/) || [''])[0];
    const keep = Math.max(24, pathBudget) - SUFFIX_RESERVE - ext.length;
    cleanName = cleanName.slice(0, Math.max(8, keep)).trim() + ext;
  }

  // Adopt-or-null: if the same-named existing item IS ours, return it so we
  // never mint a duplicate after a crash/lost response. Two identity tests:
  //  • BYTES: identical size (+ hash when calibrated) — exact and sufficient
  //    for formats SharePoint stores verbatim (pdf, images, html, zip…).
  //  • PROVENANCE (Office formats ONLY — the 2026-07-16 root fix): SharePoint
  //    REWRITES xlsx/docx seconds after upload (property promotion), so their
  //    size/hash NEVER match ours again. A same-named Office item in OUR
  //    portal-created target folder that was CREATED BY THIS APP is our own
  //    earlier upload of this stream — adopt it. (A human's same-named file
  //    fails createdByThisApp and still uniquifies; nothing is overwritten.)
  const adoptIfIdentical = async (name) => {
    try {
      const existing = await sp.itemMetaByName(driveId, parentId, name);
      // NEVER adopt the item this row's own ref already points at: on a
      // re-mirror that item is the KNOWN-CORRUPT copy being replaced, and
      // before hash calibration a same-size corrupt item would pass the size
      // check and be re-recorded as 'ok' (post-merge audit, 2026-07-15).
      if (row.sharepoint_backup_ref && existing) {
        try { if (sp.parseRef(row.sharepoint_backup_ref).itemId === existing.id) return null; } catch (_) { /* bad ref — fall through */ }
      }
      if (!existing) return null;
      const sizeOk = existing.size != null && Number(existing.size) === bytes.length;
      const remoteQx = existing.file && existing.file.hashes && existing.file.hashes.quickXorHash;
      const hashOk = _qxTrusted === true ? (remoteQx && remoteQx === localQx) : true;
      if (sizeOk && hashOk) return existing;
      if (sp.isOfficeFormat(name) && sp.createdByThisApp(existing)) return existing;
      return null;
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
  // above will not adopt a hash-mismatched item either). Skipped for Office
  // formats: SharePoint property promotion can rewrite them between the PUT
  // and the response materializing — a hash drift there is not corruption.
  if (!up.adopted && _qxTrusted === true && !sp.isOfficeFormat(cleanName)) {
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

  // METADATA ID STAMP (roadmap R1) — best-effort, gated, never affects the
  // mirror (bytes are already uploaded + recorded above). Stamps Pilot identity
  // columns so the link survives any human rename/move. An adopted item is
  // re-stamped too (cheap, idempotent) so a copy created before stamping existed
  // gets its columns on the next pass.
  if (cfg.sharepointStampMetadata) {
    try {
      await sp.ensurePilotColumns(driveId);
      await sp.stampItemFields(driveId, up.item.id, {
        PilotDocumentId: row.id,
        PilotFileId: row.app_id || (row.borrower_id ? `borrower:${row.borrower_id}` : ''),
        PilotBorrower: [row.borrower_first, row.borrower_last].filter(Boolean).join(' '),
        PilotSyncedAt: new Date().toISOString(),
      });
      await db.query('UPDATE documents SET sharepoint_stamped_at = now() WHERE id = $1', [row.id]);
    } catch (e) {
      console.warn(`[sp-sync] metadata stamp skipped for doc ${row.id}: ${e.message}`);
    }
  }
  return up;
}

// `retried` guards the one self-heal: when a cached folder id has gone stale
// (a human deleted/moved the folder in SharePoint → Graph itemNotFound), the
// scope cache is invalidated and resolution re-runs once from scratch.
async function mirrorRow(row, retried = false) {
  // HARD RULE (owner-directed): the signed Heter Iska is NEVER mirrored to
  // SharePoint. Guard at the upload chokepoint so even a FORCE-attempt (the
  // enrichedRowById path, which bypasses pendingBatch's filters) cannot upload
  // it. Stamped skipped so a human can see WHY it isn't in the tree.
  if (NEVER_MIRROR_KINDS.has(row.doc_kind)) {
    // Settle it (backed_up_at + reason) so it leaves the pending/stuck/backlog-SLO
    // population — never left backed_up_at IS NULL, which would trip a permanent
    // backlog alert and re-force-attempt every sweep (audit HIGH).
    await db.query(
      `UPDATE documents SET sharepoint_backed_up_at = now(),
          sharepoint_skipped_reason = $2,
          sharepoint_backup_error = NULL
        WHERE id = $1 AND sharepoint_backed_up_at IS NULL`, [row.id, neverMirrorReason(row.doc_kind)]);
    return { skipped: true, reason: 'never_mirror_kind' };
  }
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
  let bytes;
  try {
    bytes = await storage.read(row.storage_ref);
  } catch (e) {
    // A read failure while the persistent disk is transiently unmounted (common
    // at Render boot/redeploy) must NOT be parked permanent (ENOENT is a HARD
    // permanent pattern) — the file is fine, the mount lagged. Only treat a
    // missing file as permanent when the disk itself is confirmed healthy; if the
    // disk is not writable/mounted, raise a TRANSIENT error so the row retries
    // instead of requiring a human "Retry" (round-2 audit F4).
    let diskOk = true;
    try {
      const p = storage.probe();
      // Not healthy = the base is unwritable, OR a STORAGE_DIR was configured (prod
      // intent) but we are NOT on it — i.e. the persistent mount hasn't come up and
      // we fell back to an ephemeral dir. In that state a read of a real-disk file
      // ENOENTs because the mount is lagging, not because the file is gone, so it
      // must retry, not park permanent (round-2 audit item 4).
      diskOk = !!(p && p.ok && !(p.configured && p.persistent === false));
    } catch (_) { diskOk = false; }
    if (!diskOk) throw new Error('storage temporarily unavailable (persistent disk not mounted/writable) — will retry');
    throw e;   // disk healthy but the file is genuinely gone → permanent local-missing
  }

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
        -- only dedup against a HEALTHY, fully-recorded mirror: a doc whose
        -- mirror is flagged corrupt (re-queued: backed_up_at NULL, ref kept)
        -- or mismatch-stamped must never lend its corrupt URL to a sibling
        -- (post-merge audit, 2026-07-15)
        AND sharepoint_backed_up_at IS NOT NULL
        AND (sharepoint_integrity IS NULL OR sharepoint_integrity NOT LIKE 'mismatch%')
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
    try {
      await require('./sync-review').closeStaleReviews({
        taskId: `spdoc:${row.id}`, fieldKey: 'sharepoint_doc',
        note: 'auto-closed — identical bytes are already mirrored; this copy shares that file' });
    } catch (_) { /* best-effort */ }
    return { webUrl: dup.sharepoint_web_url, deduped: true, path: '(shared with existing mirror copy)' };
  }

  // RE-MIRROR fast path: a document that was mirrored before (the integrity
  // audit found its copy corrupt, or an admin forced a re-mirror) re-uploads
  // into the SAME folder it lived in, so history stays in its Version-N home.
  // Falls back to full resolution when that folder no longer exists.
  if (row.sharepoint_backup_ref && row.sharepoint_parent_id) {
    try {
      const { driveId: oldDriveId, itemId: oldItemId } = sp.parseRef(row.sharepoint_backup_ref);
      const wasDiagnosedCorrupt = /^mismatch/.test(String(row.sharepoint_integrity || ''));
      const up = await uploadAndRecord({
        row, driveId: oldDriveId, parentId: row.sharepoint_parent_id,
        version: row.sharepoint_version || 0, bytes, contentSha,
        // The replacement must be OBVIOUSLY the good one in Explorer.
        nameSuffix: 'fixed copy' });
      // THE ONE SANCTIONED DELETE (owner-directed 2026-07-16): with the
      // verified fixed copy recorded, the DIAGNOSED-CORRUPT original may be
      // removed — behind the seven guards in sp.deleteReplacedCorruptMirror
      // (Pilot-tree ancestry, expected parent, same diagnosed bytes, If-Match,
      // replacement re-verified live). Best-effort: a refusal never fails the
      // mirror; the item simply stays for manual cleanup, audited either way.
      let cleanup = 'corrupt original left in place';
      if (wasDiagnosedCorrupt && !up.adopted) {
        try {
          const del = await sp.deleteReplacedCorruptMirror(oldDriveId, oldItemId, {
            expectedParentId: row.sharepoint_parent_id,
            corruptSize: row.sharepoint_item_size,
            replacementItemId: up.item.id,
            localSize: bytes.length,
          });
          cleanup = `corrupt original "${del.name}" deleted (verified fixed copy in place)`;
          await auditLogVerify(row, 'sharepoint_corrupt_original_deleted', {
            filename: row.filename, deletedItemId: oldItemId, replacementItemId: up.item.id });
        } catch (e) {
          cleanup = `corrupt original left in place (${String(e.message).slice(0, 140)})`;
          console.warn(`[sp-sync] sanctioned delete skipped for doc ${row.id}: ${e.message}`);
        }
      }
      try {
        await require('./sync-review').closeStaleReviews({
          taskId: `spdoc:${row.id}`, fieldKey: 'sharepoint_doc',
          note: `auto-closed — a good copy re-mirrored into the original folder; ${cleanup}` });
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

  // Path budget: total decoded path must stay under SharePoint's ~400-char
  // limit; leave headroom for "/Version NN/" and uniquifier suffixes.
  const usedLen = String(`${target.fullPath}/${category}`).length + 14;
  const up = await uploadAndRecord({
    row, driveId, parentId, version, bytes, contentSha,
    pathBudget: Math.max(24, 395 - usedLen) });

  // A successful mirror vacates any open "mirror failed" review row for this
  // document — fixed at the source, no clicks needed.
  try {
    await require('./sync-review').closeStaleReviews({
      taskId: `spdoc:${row.id}`, fieldKey: 'sharepoint_doc',
      note: `auto-closed — the document mirrored successfully to ${target.fullPath}/${category}` });
  } catch (_) { /* best-effort */ }

  return { webUrl: up.item.webUrl, path: `${target.fullPath}/${category}${version ? `/Version ${version}` : ''}` };
}

// ROOT of "why does a document get stuck?" (owner-directed 2026-07-17): the
// mirror used to retry EVERY failure blindly 8× and re-arm daily — treating a
// PERMANENT failure (one retrying can never fix) exactly like a network blip.
// So a doomed upload churned invisibly for days. The fix is to UNDERSTAND the
// error and route it:
//   • permanent — a human must act; retrying is pointless. Surface it FAST
//     (after 2 attempts, to rule out a one-off), with the specific cause, and
//     PARK it so the daily reset stops re-driving a doomed upload.
//   • throttle  — Graph is rate-limiting; back off and keep retrying (the
//     escalation ceiling cards it only if it persists for many hours).
//   • transient — a network/5xx blip; retry, escalate past the ceiling.
const TRANSIENT_ERROR = /(^|[^0-9])(500|502|503|504)([^0-9]|$)|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|network|fetch failed|aborted|socket hang up/i;
const THROTTLE_ERROR = /(^|[^0-9])429([^0-9]|$)|retry-after|throttl/i;
// Permanent: retrying the SAME upload will never succeed — a human (or a config
// change) must intervene. Each maps to a concrete, plain-language cause.
const PERMANENT_PATTERNS = [
  // `hard: true` — retrying the SAME input can NEVER help (bad bytes, no scope,
  // a missing local file, a persistent name conflict, an auth failure). These win
  // OUTRIGHT, even if a stray number in the message (a byte count like "503
  // bytes") coincidentally looks like an HTTP code — they must not be downgraded
  // to "retry forever" by the transient/throttle subordination (pre-merge audit).
  { re: /no application or borrower to file under/i, hard: true, cause: 'this document is not linked to any borrower or loan file, so there is nowhere to file it. Link it to a file/borrower in PILOT (or remove it).' },
  { re: /ENOENT|no such file|invalid storage ref|storage.*not configured/i, hard: true, cause: 'the document’s own saved copy could not be read from PILOT storage (its file is missing). This usually means it was saved to a non-persistent disk. Re-upload the document.' },
  { re: /not configured \(MS_|AADSTS|invalid_client|unauthorized_client|certificate|client assertion|token via/i, hard: true, cause: 'SharePoint authentication is failing (an expired or misconfigured certificate/secret). Rotate/renew the Microsoft credential — nothing will mirror until it is fixed.' },
  { re: /name conflict persisted after uniquification/i, hard: true, cause: 'the upload keeps colliding with an existing item and could not be uniquified. A human should check the target folder in SharePoint.' },
  // Local bytes on disk don't match what the upload recorded — retrying the
  // SAME damaged bytes can never succeed (it fails before any Graph call).
  { re: /local integrity|not mirroring damaged bytes/i, hard: true, cause: 'PILOT’s own saved copy of this document is damaged (its size no longer matches what was uploaded). Re-upload the document — the stored bytes cannot be trusted.' },
  // SOFT — numeric HTTP codes. Digit-boundary-anchored so a byte count / hex id
  // / latency figure that merely CONTAINS "400"/"403" is not misclassified
  // (A-Z audit); and they yield to a transient/throttle signal (safe = retry).
  { re: /Access denied|accessDenied|(^|[^0-9])403([^0-9]|$)|Forbidden|Sites\.|permission/i, cause: 'SharePoint denied access (a permissions problem on the target site/folder). An admin must grant the app write access to this location.' },
  { re: /invalidRequest|malformed|Invalid path|path.*too long|(^|[^0-9])400([^0-9]|$)/i, cause: 'SharePoint rejected the request as invalid (often a folder path or name problem). Review the folder match for this file.' },
];
function classifyMirrorError(message) {
  const m = String(message || '');
  // HARD permanents win outright (retrying can never help, regardless of a
  // number in the message that looks like an HTTP code).
  const hard = PERMANENT_PATTERNS.find((p) => p.hard && p.re.test(m));
  if (hard) return { class: 'permanent', cause: hard.cause };
  // SOFT (numeric) permanents yield to a transient/throttle signal (safe = retry).
  const perm = PERMANENT_PATTERNS.find((p) => !p.hard && p.re.test(m) && !THROTTLE_ERROR.test(m) && !TRANSIENT_ERROR.test(m));
  if (perm) return { class: 'permanent', cause: perm.cause };
  if (THROTTLE_ERROR.test(m)) return { class: 'throttle', cause: 'SharePoint is rate-limiting the sync (throttling). The mirror backs off and keeps retrying automatically.' };
  if (TRANSIENT_ERROR.test(m)) return { class: 'transient', cause: 'a temporary network or SharePoint error. The mirror retries automatically.' };
  return { class: 'transient', cause: 'an unclassified error; treated as temporary and retried.' };
}

async function cardMirrorFailure(row, error, kind, extra = {}) {
  await require('./sync-review').queueReview({
    applicationId: row.app_id || null, borrowerId: row.borrower_id || null,
    taskId: `spdoc:${row.id}`, direction: 'outbound', fieldKey: 'sharepoint_doc',
    reason: 'sharepoint_mirror_failed', suppressIfRejected: true,
    clickupValue: null,
    portalValue: `${row.filename || 'document'} — ${extra.cause || row.item_label || row.slot_label || row.doc_kind || 'file'}`.slice(0, 300),
    rawValue: JSON.stringify({ docId: row.id, attempts: extra.attempts, errorClass: kind,
      error: String(error).slice(0, 300) }).slice(0, 500) });
}

// Attempts before a PERMANENT-classed error is surfaced (small — one retry to
// rule out a fluke, then card + park so it stops churning).
const PERMANENT_CARD_AT = 2;

async function recordFailure(row, err) {
  const lastError = String((err && err.message) || err);
  const verdict = classifyMirrorError(lastError);
  const r = await db.query(
    `UPDATE documents SET sharepoint_backup_error=$2,
        sharepoint_backup_attempts = sharepoint_backup_attempts + 1,
        sharepoint_backup_attempted_at = now()
      WHERE id=$1 RETURNING sharepoint_backup_attempts`,
    [row.id, lastError.slice(0, 500)]);
  try {
    const attempts = r.rows[0] ? Number(r.rows[0].sharepoint_backup_attempts) : 0;

    // PERMANENT → surface FAST (retrying can't help) and PARK the doc so the
    // boot/daily reset stops re-driving a doomed upload. Its review card's
    // Retry re-arms it once the human fixes the cause.
    if (verdict.class === 'permanent' && attempts >= PERMANENT_CARD_AT) {
      await cardMirrorFailure(row, lastError, 'permanent', { attempts, cause: verdict.cause });
      // Park at the attempt ceiling with a marker so the resets skip it (they
      // only re-arm docs whose error is NOT a parked permanent one).
      await db.query(
        `UPDATE documents SET sharepoint_backup_attempts = $2,
            sharepoint_backup_error = $3
          WHERE id = $1`,
        [row.id, MAX_ATTEMPTS, `[permanent] ${verdict.cause} · ${lastError}`.slice(0, 500)]);
      console.warn(`[sp-sync] doc ${row.id} PERMANENT failure parked for review: ${verdict.cause}`);
      return;
    }

    // TRANSIENT/THROTTLE exhaustion: no fake card for brief blips — the resets
    // keep retrying and the escalation ceiling (escalateStuckDocs) cards it if
    // it persists for hours. (This is the correct behavior for genuinely
    // temporary errors; permanent ones are handled above.)
    if (attempts >= MAX_ATTEMPTS && (verdict.class === 'throttle' || verdict.class === 'transient')) {
      console.warn(`[sp-sync] doc ${row.id} exhausted on a ${verdict.class} error — retrying via resets; escalates if it persists: ${lastError.slice(0, 120)}`);
      return;
    }
    if (attempts >= MAX_ATTEMPTS) {
      await cardMirrorFailure(row, lastError, verdict.class, { attempts, cause: verdict.cause });
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
let _verifyRunningSince = 0;       // heartbeat for the verify pass (same freeze-proofing as drain)
let _verifySeq = 0;                // generation token for the verify pass
let _lastVerify = null;
const VERIFY_ATTEMPT_TIMEOUT_MS = 120000;   // bound one document's verify (metadata reads); < stall ceiling

function verifyPollSec() {
  const v = parseInt(process.env.SHAREPOINT_VERIFY_POLL_SEC || '21600', 10);
  return Number.isFinite(v) && v >= 300 ? v : 21600;
}

async function verifyBatch(limit) {
  const { rows } = await db.query(
    `SELECT id, filename, content_type, storage_ref, size_bytes, sha256,
            sharepoint_backup_ref, sharepoint_parent_id, sharepoint_web_url,
            sharepoint_backed_up_at,
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

  // MALWARE-FLAGGED mirror (research, 2026-07-16): Microsoft scans uploads
  // asynchronously and BLOCKS flagged files from opening — which staff report
  // as "the file won't open." Never auto-replace (if the source bytes are
  // infected, a re-upload just gets re-flagged); a human must check the
  // source document in PILOT.
  if (meta && meta.malware) {
    await stampVerdict(row.id, 'malware-flagged (Microsoft Defender blocked this mirror copy — check the source file in PILOT)', { sha256: contentSha });
    if (row.is_current) {
      try {
        await require('./sync-review').queueReview({
          applicationId: row.application_id || null, borrowerId: row.borrower_id || null,
          taskId: `spdoc:${row.id}`, direction: 'outbound', fieldKey: 'sharepoint_doc',
          reason: 'sharepoint_mirror_failed', suppressIfRejected: true,
          clickupValue: null,
          portalValue: `${row.filename || 'document'} — Microsoft Defender flagged the SharePoint copy as MALWARE and blocked it. Do not retry blindly: scan/check the source document in PILOT first; if it is a false positive, Microsoft support can release it.`.slice(0, 400),
          rawValue: JSON.stringify({ docId: row.id, kind: 'malware-flagged' }).slice(0, 500) });
      } catch (_) { /* visibility best-effort */ }
    }
    return 'malware';
  }

  // OFFICE FORMATS: verified once, at upload, from the PUT response — after
  // that SharePoint's property promotion has rewritten the bytes and ANY
  // size/hash comparison is meaningless (the 2026-07-16 root fix: healthy
  // xlsx mirrors were being flagged "corrupt" and churned into "(fixed copy)"
  // duplicates). The item exists, isn't malware-flagged, and passed its
  // upload-time verification — that IS the integrity story for these files.
  if (sp.isOfficeFormat(row.filename)) {
    await stampVerdict(row.id,
      'ok (office format — verified at upload; post-upload byte comparison not meaningful: SharePoint property promotion rewrites these files)',
      { sha256: contentSha, itemSize: meta && meta.size != null ? Number(meta.size) : null });
    return 'ok';
  }

  const remoteSize = meta && meta.size != null ? Number(meta.size) : null;
  const remoteQx = meta && meta.file && meta.file.hashes && meta.file.hashes.quickXorHash;
  const localQx = sp.quickXorHash(bytes);
  const sizeMatches = remoteSize != null && remoteSize === bytes.length;

  // A hash MATCH proves the local QuickXorHash implementation (it cannot match
  // by accident) — calibrate trust from it.
  if (sizeMatches && remoteQx && remoteQx === localQx && _qxTrusted === null) _qxTrusted = true;

  const hashMismatch = _qxTrusted === true && remoteQx && remoteQx !== localQx;

  // MODIFIED-AFTER-UPLOAD guard (industry research, 2026-07-16): SharePoint
  // itself REWRITES Office files after upload ("property promotion" stamps
  // document properties into docx/xlsx — size and hash drift), and a human may
  // legitimately edit a mirrored copy in place. Neither is corruption, and
  // auto-replacing them would churn endless "(fixed copy)" files (and fight
  // human edits). A mismatch on an item whose SharePoint lastModified is later
  // than our upload is therefore NEVER auto-replaced — record the verdict; a
  // human decides via the review Retry if they actually want the portal bytes.
  if ((!sizeMatches || hashMismatch) && meta && meta.lastModifiedDateTime && row.sharepoint_backed_up_at) {
    const modifiedAt = new Date(meta.lastModifiedDateTime).getTime();
    const uploadedAt = new Date(row.sharepoint_backed_up_at).getTime();
    if (Number.isFinite(modifiedAt) && Number.isFinite(uploadedAt) && modifiedAt > uploadedAt + 2 * 60 * 1000) {
      await stampVerdict(row.id,
        'modified-in-sharepoint (not replaced — the copy changed after upload: SharePoint property promotion or a human edit)',
        { sha256: contentSha, itemSize: remoteSize });
      return 'ok';
    }
  }

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
async function verifyOnce({ limit = VERIFY_BATCH, seq = 0 } = {}) {
  if (!enabled()) return { skipped: true };
  let rows;
  try { rows = await withTimeout(verifyBatch(limit), DB_OP_TIMEOUT_MS, 'verify selection timed out (DB lock?)'); }
  catch (e) { console.warn('[sp-verify] verifyBatch error:', e.message); rows = []; }
  const stats = { scanned: rows.length, ok: 0, mismatch: 0, sourceSuspect: 0, itemMissing: 0, localMissing: 0, errors: 0 };
  for (const row of rows) {
    if (seq && seq !== _verifySeq) break;   // superseded by a fresher verify pass — stop
    try {
      // Bound each doc's verify (a metadata read + a stamp write) the same way
      // the drain bounds a mirror attempt — no single hung read freezes verify.
      const v = await withTimeout(verifyRow(row), VERIFY_ATTEMPT_TIMEOUT_MS, 'verify attempt timed out (Graph/DB stalled)');
      if (v === 'ok') stats.ok++;
      else if (v === 'mismatch') stats.mismatch++;
      else if (v === 'source-suspect') stats.sourceSuspect++;
      else if (v === 'malware') stats.malware = (stats.malware || 0) + 1;
      else if (v === 'item-missing') stats.itemMissing++;
      else if (v === 'local-missing') stats.localMissing++;
      else stats.errors++;
    } catch (e) {
      stats.errors++;
      console.warn(`[sp-verify] doc ${row.id} verify failed: ${e.message}`);
      try { await stampVerdict(row.id, `verify-error: ${String(e.message).slice(0, 150)}`); } catch (_) {}
    }
    if (seq === _verifySeq) _verifyRunningSince = Date.now();   // heartbeat this verify pass
    await sleep(VERIFY_PACING_MS);
  }
  _lastVerify = { at: new Date().toISOString(), ...stats };
  if (rows.length) console.log(`[sp-verify] pass: scanned ${stats.scanned}, ok ${stats.ok}, corrupt-mirror ${stats.mismatch}, corrupt-source ${stats.sourceSuspect}, missing ${stats.itemMissing}, local-missing ${stats.localMissing}, errors ${stats.errors}`);
  return stats;
}

/** Drain the whole verify backlog (boot audit + admin-triggered re-sync). */
async function drainVerify() {
  // Same freeze-proofing as drain() (the gap-audit found verify had the ORIGINAL
  // _running-stuck-true bug unfixed — a hung verify await would leave
  // _verifyRunning true forever and the integrity audit dead until restart).
  if (_verifyRunning) {
    if (Date.now() - _verifyRunningSince < DRAIN_STALL_CEILING_MS) return { alreadyRunning: true };
    console.warn(`[sp-verify] previous verify has been running ${Math.round((Date.now() - _verifyRunningSince) / 1000)}s — presumed stalled; starting fresh`);
  }
  // Bound the lease acquisition too — a lock-blocked acquire must not hang.
  let gotLease;
  try { gotLease = await withTimeout(acquireLease('sp-verify'), DB_OP_TIMEOUT_MS, 'verify lease acquire timed out'); }
  catch (e) { console.warn('[sp-verify]', e.message); return { leaseTimeout: true }; }
  if (!gotLease) {
    console.log('[sp-verify] another instance holds the verify lease — skipping this pass');
    return { leaseHeldElsewhere: true };
  }
  _verifyRunning = true;
  _verifyRunningSince = Date.now();
  const mySeq = ++_verifySeq;
  const totals = { scanned: 0, ok: 0, mismatch: 0, sourceSuspect: 0, itemMissing: 0, localMissing: 0, errors: 0 };
  try {
    for (let i = 0; i < MAX_DRAIN_LOOPS; i++) {
      if (mySeq !== _verifySeq) break;   // superseded by a fresher verify pass — stop (no 200× empty spin)
      const res = await verifyOnce({ seq: mySeq });
      await renewLease('sp-verify');
      _verifyRunningSince = Date.now();
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
    // Only the latest verify pass clears state (a resumed zombie must not unlock
    // the pass that superseded it).
    if (mySeq === _verifySeq) {
      await releaseLease('sp-verify');
      _verifyRunning = false;
      _verifyRunningSince = 0;
    }
  }
  return totals;
}

// ---------------------------------------------------------------------- passes
/** One reconciliation pass. Never throws for a single document. */
async function runOnce({ limit = DEFAULT_BATCH, seq = 0 } = {}) {
  if (!enabled()) return { skipped: true, scanned: 0, mirrored: 0, failed: 0 };
  // Version-churn fix: settle superseded autosave snapshots WITHOUT uploading
  // before selecting work — an editing burst mirrors one file, not N. These
  // pre-loop DB queries run OUTSIDE the per-document timeout, so they are bounded
  // here too — a lock-blocked settle/select can't hang the pass (and freeze the
  // whole worker) as it did on 2026-07-20.
  try { await withTimeout(settleSupersededSnapshots(), DB_OP_TIMEOUT_MS, 'snapshot settle timed out (DB lock?)'); } catch (e) { console.warn('[sp-sync] snapshot settle error:', e.message); }
  try { await withTimeout(settleNeverMirror(), DB_OP_TIMEOUT_MS, 'never-mirror settle timed out (DB lock?)'); } catch (e) { console.warn('[sp-sync] never-mirror settle error:', e.message); }
  let rows;
  try {
    rows = await withTimeout(pendingBatch(limit), DB_OP_TIMEOUT_MS, 'pendingBatch selection timed out (DB lock?)');
  } catch (e) {
    // A timed-out selection means the DB is wedged; treat this pass as empty so
    // it completes + heartbeats (the watchdog then self-heals if it persists)
    // rather than throwing and skipping the heartbeat.
    console.warn('[sp-sync] pendingBatch error:', e.message);
    rows = [];
  }
  let mirrored = 0, failed = 0;
  for (const row of rows) {
    // If a stall-guard spawned a newer pass while this one was wedged, this pass
    // has been superseded — stop the moment we notice, so a resumed zombie never
    // uploads concurrently with its replacement (seq=0 = a non-drain caller,
    // never superseded).
    if (seq && seq !== _runSeq) break;
    try {
      // Bound every attempt: a stalled Graph move or a lock-blocked DB query can
      // no longer hang the whole pass (and, with it, all future drains). A hang
      // becomes a normal recorded failure and the loop moves on.
      await withTimeout(mirrorRow(row), MIRROR_ATTEMPT_TIMEOUT_MS,
        'mirror attempt timed out (a Graph or database call stalled)');
      mirrored++;
    } catch (e) {
      failed++;
      console.warn(`[sp-sync] doc ${row.id} failed: ${e.message}`);
      try { await recordFailure(row, e); } catch (_) { /* best-effort */ }
    }
    // Per-document lease renewal: one throttled chunked upload can legally
    // take longer than the whole lease, and an expired lease mid-batch is
    // exactly the double-drain the lease exists to prevent.
    await renewLease('sp-drain');
    heartbeat(seq);   // in-process: keep the stall guard from aging out a healthy pass
    maybePersistHeartbeat(seq, { mirrored, failed });   // cross-process: keep the watchdog from false-paging a slow batch
    await sleep(PACING_MS);
  }
  // Safety net: after the normal batch, force ONE real attempt on any document
  // that the normal selector silently skipped (attempts=0 / error=NULL past the
  // grace window). Without this a stray sits "not yet attempted" — invisible —
  // until the 12h SLO escalation. Here it either mirrors now or produces a
  // classified, visible error within this poll cycle, and the reason it was
  // skipped is written to the log. Force-attempt sets attempts≥1, so a stray is
  // swept at most once (next pass it no longer matches attempts=0).
  let strayForced = 0, strayMirrored = 0;
  try {
    const strays = await neverAttemptedStrays(STRAY_BATCH);
    for (const s of strays) {
      if (seq && seq !== _runSeq) break;   // superseded by a fresher pass — stop
      console.warn(`[sp-sync] never-attempted stray doc ${s.id} (${s.filename || '?'}) age ${s.age_hours}h — ${explainExclusion(s)}; forcing one attempt`);
      const res = await forceAttemptDoc(s.id).catch((e) => ({ failed: true, error: e.message }));
      strayForced++;
      if (res.mirrored) { strayMirrored++; mirrored++; }
      else if (res.failed) {
        failed++;
        // A non-'local' stray won't be retried by the normal drain and is
        // invisible to stuckDocuments/SLO (both filter to 'local'): after its one
        // forced attempt it would sit at attempts=1 with no card. Card it NOW so
        // it's visible in Sync review, not buried after a single log line.
        if (s.storage_provider !== 'local') {
          try {
            await cardStuckDoc({ docId: s.id, appId: s.app_id, borrowerId: s.borrower_id,
              filename: s.filename, ageHours: s.age_hours, attempts: 1,
              rawErr: res.error || `the document is stored on '${s.storage_provider}', which the sync cannot read` });
          } catch (_) { /* visibility best-effort */ }
        }
      }
      await renewLease('sp-drain');
      heartbeat(seq);
      maybePersistHeartbeat(seq, { mirrored, failed });
      await sleep(PACING_MS);
    }
  } catch (e) { console.warn('[sp-sync] stray sweep error:', e.message); }
  _lastPass = { at: new Date().toISOString(), scanned: rows.length + strayForced, mirrored, failed, strays: strayForced };
  // Liveness dead-man's switch: a COMPLETED pass (even an idle one) stamps the
  // persistent heartbeat, so "the worker last made progress at T" is always
  // knowable. A frozen worker never reaches here, so the heartbeat lapses and
  // the watchdog fires. Only the latest generation stamps it (a resumed zombie
  // must not refresh a healthy pass's liveness).
  if (!seq || seq === _runSeq) recordHeartbeat({ scanned: rows.length + strayForced, mirrored, failed });
  if (rows.length || strayForced) console.log(`[sp-sync] pass: scanned ${rows.length}, mirrored ${mirrored}, failed ${failed}` + (strayForced ? `, strays force-attempted ${strayForced} (${strayMirrored} mirrored)` : ''));
  return { scanned: rows.length + strayForced, mirrored, failed, strays: strayForced };
}

/** Drain everything pending (the first-run backfill + burst catch-up). */
async function drain() {
  // Single-flight — BUT never permanently: if the in-flight pass has been
  // "running" past the stall ceiling, its await hung (a lock-blocked DB query,
  // a black-holed socket) and will never clear _running. Abandon it and start a
  // fresh pass so the mirror self-heals on the next interval instead of staying
  // frozen until a restart (root of the 2026-07-20 "nothing synced for hours").
  if (_running) {
    if (Date.now() - _runningSince < DRAIN_STALL_CEILING_MS) return;
    console.warn(`[sp-sync] previous drain has been running ${Math.round((Date.now() - _runningSince) / 1000)}s — presumed stalled; abandoning it and starting a fresh pass`);
  }
  // Flag as running + start the heartbeat clock BEFORE acquiring the lease, so a
  // lock-blocked acquireLease is itself covered by the stall guard (else a hung
  // acquire — before _running was set — would stack a new hung acquire every
  // interval and starve the connection pool). Bound the acquire too.
  _running = true;
  _runningSince = Date.now();
  const mySeq = ++_runSeq;   // generation token — see the finally
  try {
    let gotLease;
    try { gotLease = await withTimeout(acquireLease('sp-drain'), DB_OP_TIMEOUT_MS, 'drain lease acquire timed out (DB lock?)'); }
    catch (e) { console.warn('[sp-sync]', e.message); return; }
    if (!gotLease) {
      console.log('[sp-sync] another instance holds the drain lease — skipping this pass');
      return;
    }
    // Documents that exhausted their attempts get one fresh chance per day —
    // a persistent outage (or a bug fixed by a deploy) must not orphan them.
    // EXCEPT a PARKED PERMANENT failure: retrying it can't help, so re-arming
    // it would just churn a doomed upload forever (the root of "stuck"). Its
    // review card's Retry (which clears the error) is the only re-arm path.
    await withTimeout(db.query(
      `UPDATE documents SET sharepoint_backup_attempts = 0
        WHERE sharepoint_backed_up_at IS NULL AND sharepoint_backup_attempts >= $1
          AND sharepoint_backup_attempted_at < now() - interval '1 day'
          AND COALESCE(sharepoint_backup_error, '') NOT LIKE '[permanent]%'`,
      [MAX_ATTEMPTS]), DB_OP_TIMEOUT_MS, 'daily-reset UPDATE timed out').catch((e) => console.warn('[sp-sync] daily reset:', e.message));
    const drainStart = Date.now();
    for (let i = 0; i < MAX_DRAIN_LOOPS; i++) {
      const res = await runOnce({ seq: mySeq });
      await renewLease('sp-drain');
      heartbeat(mySeq);
      if (res.skipped || res.scanned === 0) break;
      // If everything in a full batch failed, stop — retrying immediately would
      // hammer the same failure; the interval sweep retries later.
      if (res.scanned > 0 && res.mirrored === 0) break;
      // Yield the single-flight slot if we've held it too long, so a fresh pass
      // (and freshly-uploaded documents) are not starved behind a slow backlog.
      if (Date.now() - drainStart > DRAIN_BUDGET_MS) {
        console.log('[sp-sync] drain budget reached — yielding; the next sweep continues the backlog');
        _rekick = true;   // ensure the remaining backlog is picked up promptly
        break;
      }
    }
  } catch (e) {
    console.warn('[sp-sync] drain error:', e.message);
  } finally {
    // Only the LATEST pass touches shared state. If this pass was abandoned as
    // stalled and a fresher pass took over (mySeq !== _runSeq), do NOT release
    // the lease or clear the flag — a late-arriving finally from the zombie must
    // not unlock or un-lease a pass that is still legitimately running.
    if (mySeq === _runSeq) {
      await releaseLease('sp-drain');
      _running = false;
      _runningSince = 0;
    }
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
  // A genuinely in-flight drain: defer, run again after. A STALLED one (past the
  // ceiling): fall through so this upload can start a fresh pass that abandons
  // the zombie — a new document never has to wait out a hung drain.
  if (_running && Date.now() - _runningSince < DRAIN_STALL_CEILING_MS) { _rekick = true; return; }
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
  _startedAtMs = Date.now();
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
             OR sharepoint_backup_attempted_at < now() - interval '30 minutes')
        -- Skip PARKED permanents (match the daily reset): re-driving a doomed
        -- upload every deploy just re-burns Graph attempts. A deploy that fixes
        -- a permanent cause is re-driven via the card's Retry / retry-exhausted.
        AND COALESCE(sharepoint_backup_error, '') NOT LIKE '[permanent]%'`,
    [MAX_ATTEMPTS]).catch(() => {});
  // Fail-safe visibility: mirror enabled but bytes live on a non-'local' provider
  // means the fast drain selects nothing (it filters to 'local'); say so loudly
  // rather than degrade near-silently (A-Z audit D1).
  if ((cfg.storageProvider || 'local') !== 'local') {
    console.warn(`[sp-sync] WARNING: SharePoint sync is enabled but STORAGE_PROVIDER='${cfg.storageProvider}' (not 'local') — the mirror reads local bytes and will not pick up documents on this provider.`);
  }
  const sec = Number.isFinite(cfg.sharepointBackupPollSec) ? cfg.sharepointBackupPollSec : 300;
  // Floor 60s, CEILING 1h — an absurd poll must not push the watchdog grace
  // (3× poll) so far out that the dead-man's switch never fires (A-Z audit D2).
  const ms = Math.max(60, Math.min(sec, 3600)) * 1000;
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
  // Backlog SLO watchdog (R4): check on the same cadence as the sweep; notifies
  // admins once per breach episode. First check ~90s after boot (let the boot
  // drain make progress first so we don't page on a normal cold-start backlog).
  _sloInterval = setInterval(() => checkBacklogSlo(), ms);
  if (_sloInterval.unref) _sloInterval.unref();
  const sboot = setTimeout(() => checkBacklogSlo(), 90000);
  if (sboot.unref) sboot.unref();
  // Worker-liveness watchdog (dead-man's switch): on its OWN interval so it fires
  // even if the drain itself never runs. Self-heals a stalled worker and alerts
  // only if that fails. First check one grace window after boot.
  _livenessInterval = setInterval(() => checkDrainLiveness(), ms);
  if (_livenessInterval.unref) _livenessInterval.unref();
  const lboot = setTimeout(() => checkDrainLiveness(), Math.min(heartbeatGraceSec() * 1000, 20 * 60 * 1000));
  if (lboot.unref) lboot.unref();
}

function stop() {
  if (_interval) { clearInterval(_interval); _interval = null; }
  if (_verifyInterval) { clearInterval(_verifyInterval); _verifyInterval = null; }
  if (_sloInterval) { clearInterval(_sloInterval); _sloInterval = null; }
  if (_livenessInterval) { clearInterval(_livenessInterval); _livenessInterval = null; }
  if (_kickTimer) { clearTimeout(_kickTimer); _kickTimer = null; }
}

function health() {
  // In-process view (instant, no DB). lastPassAgeSec surfaces the liveness
  // signal directly so a stalled worker is visible on the health probe, not just
  // inferred from backlog. The persistent heartbeat (heartbeatStaleSec) is the
  // cross-process source of truth — reconciliation() exposes that.
  const lastAgeSec = _lastPass && _lastPass.at
    ? Math.round((Date.now() - Date.parse(_lastPass.at)) / 1000) : null;
  return {
    enabled: enabled(), configured: sp.configured(), running: _running, lastPass: _lastPass,
    lastPassAgeSec: lastAgeSec,
    stalled: lastAgeSec != null && lastAgeSec > heartbeatGraceSec(),
    heartbeatGraceSec: heartbeatGraceSec(),
    verify: { running: _verifyRunning, lastPass: _lastVerify, quickXorTrusted: _qxTrusted },
  };
}

// -------------------------------------------------- reconciliation (R3 + R4)
// The chain-of-custody deliverable (roadmap R3): a single query that PROVES the
// mirror is whole — every document classified into exactly one bucket, plus the
// oldest un-mirrored age (R4's SLO signal). Cheap (one scan, indexed
// predicates); safe to call from an admin endpoint or a digest.
async function reconciliation() {
  const { rows } = await db.query(
    `SELECT
        count(*) FILTER (WHERE storage_ref IS NOT NULL)::int                                            AS total_docs,
        count(*) FILTER (WHERE sharepoint_backup_ref IS NOT NULL)::int                                  AS mirrored,
        count(*) FILTER (WHERE sharepoint_skipped_reason IS NOT NULL)::int                              AS skipped,
        count(*) FILTER (WHERE sharepoint_backed_up_at IS NULL AND storage_ref IS NOT NULL
                          AND COALESCE(storage_provider,'local')='local' AND ${NEVER_MIRROR_SQL})::int   AS pending,
        count(*) FILTER (WHERE sharepoint_backed_up_at IS NULL AND storage_ref IS NOT NULL
                          AND sharepoint_backup_attempts >= $1 AND ${NEVER_MIRROR_SQL})::int             AS exhausted,
        count(*) FILTER (WHERE sharepoint_backup_ref IS NOT NULL AND sharepoint_verified_at IS NULL)::int AS unverified,
        count(*) FILTER (WHERE sharepoint_integrity = 'ok'
                          OR sharepoint_integrity LIKE 'ok %')::int                                      AS verified_ok,
        count(*) FILTER (WHERE sharepoint_integrity LIKE 'mismatch%')::int                              AS integrity_mismatch,
        count(*) FILTER (WHERE sharepoint_integrity LIKE 'source-suspect%')::int                        AS source_suspect,
        count(*) FILTER (WHERE sharepoint_integrity LIKE 'malware%')::int                               AS malware_flagged,
        count(*) FILTER (WHERE sharepoint_integrity = 'item-missing')::int                              AS item_missing,
        count(*) FILTER (WHERE sharepoint_integrity = 'local-missing')::int                             AS local_missing,
        count(*) FILTER (WHERE sharepoint_backup_ref IS NOT NULL AND sharepoint_stamped_at IS NOT NULL)::int AS id_stamped,
        -- Un-mirrored docs on a NON-'local' provider: invisible to the normal
        -- selectors (which filter to 'local'). Counted here so they can never be
        -- fully silent (the gap-audit's counted-but-never-selected class). Latent
        -- today — every doc is 'local' — but visible the moment a provider ships.
        count(*) FILTER (WHERE sharepoint_backed_up_at IS NULL AND storage_ref IS NOT NULL
                          AND COALESCE(storage_provider,'local') <> 'local')::int                        AS nonlocal_pending,
        EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (
           WHERE sharepoint_backed_up_at IS NULL AND storage_ref IS NOT NULL
             AND COALESCE(storage_provider,'local')='local' AND ${NEVER_MIRROR_SQL})))::bigint          AS oldest_pending_secs
      FROM documents d`,
    [MAX_ATTEMPTS]);
  const r = rows[0];
  const oldestHrs = r.oldest_pending_secs != null ? Math.round(r.oldest_pending_secs / 360) / 10 : null;
  const thresholdHrs = Number(process.env.SHAREPOINT_BACKLOG_SLO_HOURS || 6);
  const backlogBreached = oldestHrs != null && oldestHrs > thresholdHrs;
  // Count the audit-trailed sanctioned deletes (the SEC 17a-4 "audit-trail
  // alternative to WORM" evidence — every corrupt-copy removal is attributed).
  let sanctionedDeletes = null;
  try {
    sanctionedDeletes = Number((await db.query(
      `SELECT count(*)::int n FROM audit_log WHERE action='sharepoint_corrupt_original_deleted'`)).rows[0].n);
  } catch (_) { /* audit table optional in the count */ }
  // CONTROL STATE for the compliance/chain-of-custody report (round-4 research:
  // an auditor reads this to confirm the guarantees are actually enforced).
  let credential = null;
  try { credential = sp.credentialHealth(); } catch (_) { /* cert parse best-effort */ }
  const controls = {
    deleteSanctionedEnabled: sp.deleteEnabled(),      // the ONE delete path — on/off
    metadataStampEnabled: !!cfg.sharepointStampMetadata,
    idStampCoverage: r.mirrored > 0 ? Math.round((r.id_stamped / r.mirrored) * 1000) / 10 : null,  // %
    sanctionedDeletesTotal: sanctionedDeletes,
    backlogSloHours: thresholdHrs,
    credential,
    credentialWarning: credential && credential.warning ? credential.warning : null,
  };
  // WORKER LIVENESS (cross-process, from the persistent heartbeat) — the signal
  // that was missing on 2026-07-20: a frozen worker with an empty backlog used to
  // report healthy. Now staleness past the grace window makes the worker (and the
  // mirror) UN-healthy even if the backlog looks fine.
  let workerStaleSec = null;
  try { workerStaleSec = await heartbeatStaleSec(); } catch (_) { /* best-effort */ }
  const graceSec = heartbeatGraceSec();
  // Stalled = the persistent heartbeat lapsed AND this process isn't actively
  // progressing a (slow) pass — so a long legitimate backfill never reads as
  // stalled/unhealthy.
  const workerStalled = workerStaleSec != null && workerStaleSec > graceSec && !drainProgressing();
  const worker = {
    enabled: enabled(),
    lastPassAgeSec: workerStaleSec,          // seconds since the last completed pass (persistent)
    graceSec,
    stalled: workerStalled,
    running: _running,
    inFlightAgeSec: _running && _runningSince ? Math.round((Date.now() - _runningSince) / 1000) : null,
    verifyRunning: _verifyRunning,
  };
  // "Needs a human" verdicts that keep backed_up_at SET (so they never re-enter
  // the pending/backlog population) and therefore used to be INVISIBLE to the
  // health verdict — a mirror carrying malware-blocked or source-corrupt or
  // human-deleted copies reported healthy:true (A-Z audit #3). Fold them in.
  const needsAttention = (r.malware_flagged || 0) + (r.source_suspect || 0)
    + (r.item_missing || 0) + (r.local_missing || 0) + (r.nonlocal_pending || 0);
  return {
    ...r,
    oldest_pending_hours: oldestHrs,
    needs_attention: needsAttention,
    slo: { thresholdHours: thresholdHrs, oldestPendingHours: oldestHrs, breached: backlogBreached, exhausted: r.exhausted },
    controls,
    worker,
    // A mirror is "healthy" when nothing is exhausted, the backlog is inside
    // SLO, the auth credential is not about to expire, the worker itself is
    // alive (not stalled), AND nothing is sitting in a human-action verdict
    // (malware / source-corrupt / item-missing / local-missing / non-local).
    healthy: r.exhausted === 0 && !backlogBreached && !(credential && credential.warning)
             && !workerStalled && needsAttention === 0,
  };
}

// The ACTUAL stuck documents behind a backlog — WITH identity and the real
// reason, so an alert/report is interpretable and actionable (owner-reported
// 2026-07-17: "I got an SLO email but nothing in review and I don't understand
// it"). A document that has been un-mirrored past the SLO threshold, oldest
// first, each with a plain-language diagnosis of WHY it isn't progressing.
async function stuckDocuments(limit = 25) {
  const hrs = Number(process.env.SHAREPOINT_BACKLOG_SLO_HOURS || 6);
  const { rows } = await db.query(
    `SELECT d.id, d.filename, d.doc_kind, d.is_current,
            d.sharepoint_backup_attempts AS attempts,
            d.sharepoint_backup_error    AS last_error,
            d.sharepoint_skipped_reason  AS skipped_reason,
            round(EXTRACT(EPOCH FROM (now() - d.created_at)) / 3600.0, 1) AS age_hours,
            d.sharepoint_slo_alerted_at AS slo_alerted_at,
            COALESCE(d.application_id, ci.application_id)                        AS app_id,
            COALESCE(d.borrower_id, ci.borrower_id, l.borrower_id, a.borrower_id) AS borrower_id,
            TRIM(CONCAT_WS(' ', b.first_name, b.last_name))                     AS borrower_name,
            ${REGEN_KIND_SQL} AS is_regen
       FROM documents d
       LEFT JOIN checklist_items ci ON ci.id = d.checklist_item_id
       LEFT JOIN llcs l             ON l.id = COALESCE(d.llc_id, ci.llc_id)
       LEFT JOIN applications a     ON a.id = COALESCE(d.application_id, ci.application_id)
       LEFT JOIN borrowers b        ON b.id = COALESCE(d.borrower_id, ci.borrower_id, l.borrower_id, a.borrower_id)
      WHERE d.sharepoint_backed_up_at IS NULL
        AND d.storage_ref IS NOT NULL
        AND COALESCE(d.storage_provider,'local') = 'local'
        -- Deliberately-never-mirrored kinds (heter iska, appraisal photos) and
        -- lead-CRM attachments are NOT stuck backlog: the settle pass stamps them
        -- skipped. Excluding them here keeps a not-yet-settled policy doc out of
        -- the breach/alert (A-Z round-2 audit F2 — the alert and the settle set
        -- derive from the same NEVER_MIRROR map so they can't diverge).
        AND ${NEVER_MIRROR_SQL}
        AND d.created_at < now() - make_interval(hours => $1)
      ORDER BY d.created_at ASC
      LIMIT $2`,
    [hrs, limit]);
  return rows.map((r) => {
    const noScope = !r.app_id && !r.borrower_id;
    let why;
    if (r.is_regen && r.is_current === false) why = 'a superseded auto-saved copy that should have auto-settled (self-healing now)';
    else if (noScope) why = 'no borrower or loan file to file it under — a human must link or remove it';
    else if (Number(r.attempts) >= MAX_ATTEMPTS) why = `failed every automatic retry — last error: ${r.last_error || 'unknown'}`;
    else why = `keeps failing to upload — last error: ${r.last_error || '(not yet attempted)'}`;
    return { ...r, phantom: r.is_regen && r.is_current === false, noScope, why };
  });
}

// Escalate genuinely-stuck documents so they STOP being invisible (the
// 2026-07-17 blind spot): a doc past the escalation threshold either
//   (a) self-heals if it's a phantom (superseded snapshot that slipped the
//       settle pass) — settle it, no human needed; or
//   (b) gets a REVIEW CARD regardless of error class — a "transient" error that
//       has persisted this long is NOT transient, it's stuck, and a human must
//       see it (this is what #300's transient-suppression was missing).
function stuckEscalateHours() {
  const slo = Number(process.env.SHAREPOINT_BACKLOG_SLO_HOURS || 6);
  const v = Number(process.env.SHAREPOINT_STUCK_ESCALATE_HOURS || 0);
  // Belt-and-suspenders (2026-07-21): escalate at the SAME threshold the alert
  // fires, not 2x later. checkBacklogSlo() calls escalateStuckDocs() before EVERY
  // alert, so a never-tried doc is force-attempted the instant it breaches — it
  // then mirrors or yields a REAL error (and usually drops out of the alert),
  // instead of sitting "(not yet attempted)" for the 6h→12h window. So even if a
  // FUTURE selection bug ever strands a doc again, it self-heals when we'd alert,
  // never for 30h. The primary fix is the NULL-safe REGEN_KIND_SQL; this is the
  // second line of defense. Env override preserved.
  return v > 0 ? v : Math.max(1, slo);
}
// Force ONE document through the mirror, bypassing pendingBatch selection, with
// a hard timeout so a hanging upload (a poison-pill file) can't strand the doc
// "not yet attempted" forever — it either mirrors or produces a REAL,
// classifiable error that recordFailure turns into an actionable card.
const FORCE_ATTEMPT_TIMEOUT_MS = 90000;
async function forceAttemptDoc(id) {
  const row = await enrichedRowById(id);
  if (!row) return { gone: true };
  if (row.sharepoint_backed_up_at) return { alreadyDone: true };
  try {
    await withTimeout(mirrorRow(row), FORCE_ATTEMPT_TIMEOUT_MS,
      'force-attempt timed out after 90s (possible poison-pill file)');
    return { mirrored: true };
  } catch (e) {
    // Give the real error a home: recordFailure classifies it (permanent →
    // fast card; throttle/transient → retry) so it stops being "not attempted".
    try { await recordFailure(row, e); } catch (_) {}
    return { failed: true, error: e.message };
  }
}

// Ensure a Sync-review card exists for a stuck, human-actionable document,
// showing the FRIENDLY cause (e.g. "the document's own saved copy could not be
// read…" instead of a raw ENOENT). Idempotent — queueReview dedups per doc.
// Shared by escalateStuckDocs AND the never-attempted stray sweep, so a stray
// that fails a forced attempt and will NOT be retried by the normal drain
// (a non-'local' provider the mirror can't read is invisible to both
// pendingBatch and stuckDocuments) is made VISIBLE immediately — not surfaced
// for a single log line and then buried at attempts=1.
async function cardStuckDoc({ docId, appId, borrowerId, filename, ageHours, attempts, rawErr }) {
  const verdict = classifyMirrorError(rawErr);
  const shown = verdict.class === 'permanent' ? verdict.cause : String(rawErr);
  const agePart = ageHours != null ? `stuck ${ageHours}h: ` : '';
  await require('./sync-review').queueReview({
    applicationId: appId || null, borrowerId: borrowerId || null,
    taskId: `spdoc:${docId}`, direction: 'outbound', fieldKey: 'sharepoint_doc',
    reason: 'sharepoint_mirror_failed', suppressIfRejected: true,
    clickupValue: null,
    portalValue: `${filename || 'document'} — ${agePart}${shown}`.slice(0, 300),
    rawValue: JSON.stringify({ docId, attempts, stuckHours: ageHours,
      errorClass: verdict.class, error: String(rawErr).slice(0, 280), escalated: true }).slice(0, 500) });
}

// Belt to the per-success closeStaleReviews suspenders: if that best-effort
// close ever failed (a DB blip), a now-mirrored document would keep an open
// "mirror failed" card forever (nothing re-sweeps a doc once backed_up_at is
// set — A-Z audit B1). This bulk-closes any open sharepoint_doc card whose
// document is now resolved (mirrored or deliberately settled). Idempotent.
async function closeResolvedDocCards() {
  try {
    const r = await db.query(
      `UPDATE sync_review_queue q
          SET status='resolved', auto_resolved=true, resolved_at=now(),
              resolution_note='auto-closed — the document is now mirrored/settled'
        WHERE q.status='open' AND q.field_key='sharepoint_doc' AND q.task_id LIKE 'spdoc:%'
          AND EXISTS (SELECT 1 FROM documents d
                       WHERE d.id::text = substring(q.task_id from 7)
                         AND d.sharepoint_backed_up_at IS NOT NULL)
        RETURNING q.id`);
    if (r.rowCount) console.log(`[sp-sync] auto-closed ${r.rowCount} stale mirror-failure card(s) for now-mirrored docs`);
    return r.rowCount || 0;
  } catch (_) { return 0; }   // best-effort — never breaks a pass
}

async function escalateStuckDocs() {
  const escalateHrs = stuckEscalateHours();
  const docs = (await stuckDocuments(50)).filter((d) => Number(d.age_hours) >= escalateHrs);
  let settled = 0, carded = 0, forced = 0, forceMirrored = 0;
  for (const d of docs) {
    if (d.phantom) {
      // Self-heal: settle the superseded snapshot exactly like the settle pass.
      await db.query(
        `UPDATE documents SET sharepoint_backed_up_at = now(),
            sharepoint_skipped_reason = 'superseded before mirror — a newer copy of this snapshot mirrors instead (stuck-heal)',
            sharepoint_backup_error = NULL
          WHERE id = $1 AND sharepoint_backed_up_at IS NULL`, [d.id]);
      settled++;
      try {
        await require('./sync-review').closeStaleReviews({
          taskId: `spdoc:${d.id}`, fieldKey: 'sharepoint_doc', note: 'auto-closed — superseded snapshot settled' });
      } catch (_) { /* best-effort */ }
      continue;
    }
    // NEVER-ATTEMPTED but stuck (attempts 0 and no error) means pendingBatch
    // skipped it for some reason (the "not yet attempted" bug). FORCE an
    // attempt so it either mirrors now or yields a real error — don't just
    // card a doc that was never actually tried.
    const neverTried = Number(d.attempts || 0) === 0 && !d.last_error;
    let realError = d.last_error;
    if (neverTried) {
      forced++;
      const res = await forceAttemptDoc(d.id).catch((e) => ({ failed: true, error: e.message }));
      if (res.mirrored) { forceMirrored++; continue; }   // uploaded — card (if any) closed by the success path
      // The force-attempt produced a REAL error (or the doc vanished); use it
      // so the card no longer says "not yet attempted".
      realError = res.error || realError;
    }
    // Anything else stuck this long is human-actionable — ensure a card exists
    // with the REAL error (re-read fresh in case recordFailure already classified
    // it). queueReview dedups per doc, so this is idempotent across sweeps.
    try {
      const fresh = await enrichedRowById(d.id);
      if (!fresh || fresh.sharepoint_backed_up_at) continue;   // gone, or force-attempt mirrored it
      const rawErr = fresh.sharepoint_backup_error || realError || d.why;
      await cardStuckDoc({ docId: d.id, appId: d.app_id, borrowerId: d.borrower_id,
        filename: d.filename, ageHours: d.age_hours, attempts: d.attempts, rawErr });
      carded++;
    } catch (_) { /* visibility best-effort */ }
  }
  if (settled || carded || forced) console.log(`[sp-sync] stuck-escalation: settled ${settled} phantom(s), force-attempted ${forced} (${forceMirrored} mirrored), carded ${carded}`);
  return { settled, carded, forced, forceMirrored, considered: docs.length };
}

// Persistent, restart-proof SLO-alert dedup (owner-reported 2026-07-19: "I got
// the same email about this issue again seven minutes later"). The alert must
// fire ONCE per distinct backlog episode and stay quiet across a process
// restart or a second instance. The old dedup was an in-process boolean latch
// that resets to `false` on every boot — so a redeploy WHILE the backlog is
// still breaching re-sent the SAME email (two alerts ~7 min apart is exactly a
// deploy landing between two 90s boot checks / two instances). The dedup now
// lives in the DB (sync_locks, reused — no new migration): a cooldown row keyed
// 'sp-slo-alert' whose `holder` is a signature of the exact stuck set. We alert
// only when we can CLAIM that row — i.e. the cooldown lapsed OR the stuck set
// changed (a genuinely new problem re-alerts at once; the same problem stays
// quiet for the cooldown), and every process/instance shares the one row.
function sloAlertCooldownMin() {
  const v = Number(process.env.SHAREPOINT_SLO_ALERT_COOLDOWN_MIN || 360);
  return Number.isFinite(v) && v >= 5 ? v : 360;
}
// Signature = the SET of stuck documents named in the email, nothing else. It
// deliberately excludes the exhausted COUNT and per-doc attempt counters: those
// tick upward during one ongoing incident, and folding them in would re-alert
// the SAME incident every poll as counters advanced (a residual of the very
// duplicate-email complaint this targets). The alert re-fires only when the set
// of stuck documents actually changes — i.e. a genuinely new/different problem.
function sloSignature(stuck) {
  const ids = stuck.map((d) => String(d.id)).sort();
  return sha256hex(Buffer.from(ids.join(','))).slice(0, 48);
}
// Generic persistent, restart-proof alert dedup (reused by the backlog SLO AND
// the worker-liveness watchdog). Returns true iff THIS process wins the right to
// alert for `signature` under `lockKey` right now — i.e. no active cooldown, or
// the signature changed (a genuinely new/different problem). Survives restarts +
// scale-out because the cooldown lives in the DB, not process memory.
async function claimAlert(lockKey, signature, cooldownMin) {
  try {
    const r = await db.query(
      `INSERT INTO sync_locks (lock_key, holder, expires_at)
       VALUES ($1, $2, now() + make_interval(mins => $3))
       ON CONFLICT (lock_key) DO UPDATE
         SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
         WHERE sync_locks.expires_at < now() OR sync_locks.holder <> $2
       RETURNING holder`,
      [lockKey, signature, cooldownMin]);
    return r.rows.length > 0;
  } catch (e) {
    // Fail CLOSED (suppress): a missed reminder beats a duplicate storm.
    console.warn(`[sp-sync] alert dedup check "${lockKey}" failed (${e.message}) — suppressing`);
    return false;
  }
}
async function clearAlert(lockKey) {
  try { await db.query(`DELETE FROM sync_locks WHERE lock_key = $1`, [lockKey]); } catch (_) { /* best-effort */ }
}
// SLO wrappers (kept as named helpers — the tests + exports target these).
async function claimSloAlert(signature) { return claimAlert('sp-slo-alert', signature, sloAlertCooldownMin()); }
async function clearSloAlert() { return clearAlert('sp-slo-alert'); }

// ---- per-document SLO-alert dedup (the bombardment fix, round-2 audit F1) ----
// The old dedup keyed on a hash of the OLDEST 8 stuck docs, so any shift of that
// set (a doc resolving, the 9th sliding in, a redeploy) changed the hash and
// bypassed the cooldown — re-sending a near-identical email several times a day.
// The dedup is now PER DOCUMENT: the alert fires only when a stuck doc has not
// been alerted within the cooldown window (a genuinely NEW problem), never for
// churn/resolution of the existing set. A global time-cooldown row is the floor.
async function sloCooldownActive() {
  try {
    const r = await db.query(`SELECT 1 FROM sync_locks WHERE lock_key='sp-slo-alert' AND expires_at > now()`);
    return r.rows.length > 0;
  } catch (e) {
    // Fail CLOSED (treat as active → suppress): a missed reminder beats a storm.
    console.warn(`[sp-sync] SLO cooldown check failed (${e.message}) — suppressing`);
    return true;
  }
}
async function armSloCooldown() {
  const cd = sloAlertCooldownMin();
  try {
    await db.query(
      `INSERT INTO sync_locks (lock_key, holder, expires_at)
       VALUES ('sp-slo-alert','backlog', now() + make_interval(mins => $1))
       ON CONFLICT (lock_key) DO UPDATE SET holder='backlog', expires_at = now() + make_interval(mins => $1)`,
      [cd]);
  } catch (_) { /* best-effort; a failed arm leaves no active cooldown → fails SAFE toward re-alerting, never silent */ }
}
async function markSloAlerted(ids) {
  if (!ids || !ids.length) return;
  try { await db.query(`UPDATE documents SET sharepoint_slo_alerted_at = now() WHERE id = ANY($1)`, [ids]); }
  catch (_) { /* best-effort; a failed stamp leaves slo_alerted_at NULL → the doc re-alerts next pass (fails SAFE, never silently suppressed) */ }
}
// A stuck doc is "genuinely new" (worth a fresh email even mid-cooldown) when it
// has never been alerted, or its last alert has aged past the cooldown window
// (the re-remind cadence for a doc that stays stuck).
function sloDocIsNew(d, cooldownMin) {
  if (!d.slo_alerted_at) return true;
  const t = new Date(d.slo_alerted_at).getTime();
  return !Number.isFinite(t) || (Date.now() - t) > cooldownMin * 60000;
}

// R4 — the SLO watchdog: on each interval sweep, if the oldest un-mirrored doc
// is past the threshold (or anything is exhausted), ESCALATE the stuck docs
// (settle phantoms, force-attempt never-tried ones, card the rest) and notify
// admins ONCE per breach episode WITH the offending documents named. Silent
// degradation becomes a signal you can actually act on — without spamming.
async function checkBacklogSlo() {
  if (!enabled()) return;
  try {
    // Belt-and-suspenders: close any orphaned mirror-failure card whose doc has
    // since resolved (a best-effort per-success close that once failed).
    await closeResolvedDocCards();
    const recon = await reconciliation();
    const breaching = recon.slo.breached || recon.slo.exhausted > 0;
    // NOTE: do NOT delete the cooldown row on a transient non-breach — that let
    // threshold flapping reset the cooldown and re-alert. It expires on its own.
    if (!breaching) return;
    // Make the stuck docs visible + actionable BEFORE alerting, so the email
    // and the review queue agree (this also force-attempts never-tried docs, so
    // a transient stray may resolve itself and drop out of the alert entirely).
    const esc = await escalateStuckDocs().catch(() => ({ settled: 0, carded: 0 }));
    // Re-read the FULL stuck set (not just the oldest 8 — that LIMIT was the
    // churn source: a doc resolving slid the 9th in and re-alerted). We decide +
    // stamp over the whole set; the email still only NAMES the oldest few.
    const allStuck = (await stuckDocuments(200)).filter((d) => !d.phantom);
    // Only alert when there are named, past-SLO documents to show. If nothing is
    // nameable (escalation cleared it, or the only breach is a still-young
    // exhausted doc / a non-'local' doc that stuckDocuments can't list), skip the
    // email — a vague "0 document(s)…" alert helps no one, and those docs surface
    // through their own Sync-review cards (stray-sweep / permanent-error carding).
    if (allStuck.length === 0) return;
    // PER-DOCUMENT dedup (the bombardment fix): stay quiet while the cooldown is
    // active UNLESS a genuinely NEW stuck doc appeared (one not alerted within the
    // window). A doc resolving, the set reshuffling, or a redeploy never makes an
    // existing doc "new", so none of those re-alert. A brand-new stuck doc still
    // pages at once. Then re-arm the window and stamp the whole current set so it
    // won't re-trigger until it ages past the cooldown (the ~6h re-remind cadence).
    const cooldownMin = sloAlertCooldownMin();
    const hasNewDoc = allStuck.some((d) => sloDocIsNew(d, cooldownMin));
    if ((await sloCooldownActive()) && !hasNewDoc) return;
    await armSloCooldown();
    await markSloAlerted(allStuck.map((d) => d.id));
    const stuck = allStuck;
    const named = stuck.slice(0, 8).map((d) =>
      ({ label: (d.borrower_name || 'document') + (d.filename ? ` — ${d.filename}` : ''),
         value: `${d.age_hours}h · ${d.why}` }));
    const notify = require('./notify');
    await notify.notifyAdmins({
      type: 'sharepoint_backlog_slo',
      title: 'SharePoint sync — document(s) need attention',
      body: `${stuck.length} document(s) have not mirrored to SharePoint within the ${recon.slo.thresholdHours}h target` +
            (esc.carded ? ` (${esc.carded} now in Sync review with the exact reason)` : '') +
            (esc.settled ? `; ${esc.settled} superseded copy(ies) auto-resolved` : '') +
            '. Each is listed below with why — open Sync review to see the error and Retry. Nothing is lost; every document is safe in PILOT.',
      meta: [
        { label: 'Stuck documents', value: String(stuck.length) },
        { label: 'Oldest', value: recon.oldest_pending_hours != null ? `${recon.oldest_pending_hours}h` : '—' },
        ...named,
      ],
      link: '/internal/sync-reviews', ctaLabel: 'Open Sync review',
    }).catch(() => {});
  } catch (e) {
    console.warn('[sp-sync] backlog SLO check error:', e.message);
  }
}

// ------------------------------------------------ worker-liveness watchdog
// The dead-man's switch (the #1 lesson of the 2026-07-20 freeze): watch whether
// the WORKER is alive and progressing, not just the backlog. The stall guard in
// drain() self-heals a wedged pass, and this watchdog is the belt to that
// suspenders — it runs on its own interval, so even if drain() itself never
// runs (start() skipped, interval cleared, enabled() flipped, every pass
// throwing) the staleness is detected. Two tiers, so it stays SILENT in the good
// case: (1) stale past the grace window → self-heal by kicking a fresh drain;
// (2) stale past 2× grace → self-heal clearly failed → alert admins ONCE
// (persistent dedup), distinct from the backlog email. Recovery auto-clears.
function livenessAlertCooldownMin() {
  const v = Number(process.env.SHAREPOINT_LIVENESS_COOLDOWN_MIN || 120);
  return Number.isFinite(v) && v >= 5 ? v : 120;
}
async function checkDrainLiveness() {
  if (!enabled()) return;
  try {
    // If THIS process's drain is actively progressing (a legitimately slow
    // large/throttled backfill — one runOnce can outlive the persistent
    // heartbeat's grace), it is NOT stalled: never self-heal or alert. This is
    // the truth for the running instance and prevents a false "worker stalled"
    // page during a normal heavy backfill (the "silent" goal).
    if (drainProgressing()) { await clearAlert('sp-liveness-alert'); return; }
    const staleSec = await heartbeatStaleSec();
    const graceSec = heartbeatGraceSec();
    // No heartbeat row at all. Fresh boot → give the boot drain one grace window
    // to stamp the first heartbeat. But a worker that STARTED and still hasn't
    // produced a single heartbeat past that window never completed even one pass
    // (start() half-failed, or every pass throws before the heartbeat) — treat
    // that as stalled too, so a silent never-started worker isn't invisible.
    if (staleSec == null) {
      if (_startedAtMs && Date.now() - _startedAtMs > graceSec * 1000) {
        console.warn('[sp-sync] liveness: worker started but has never completed a pass — kicking');
        kick();
        if (await claimAlert('sp-liveness-alert', 'never-started', livenessAlertCooldownMin())) {
          await require('./notify').notifyAdmins({
            type: 'sharepoint_worker_stalled',
            title: 'SharePoint sync — the sync worker has not started syncing',
            body: 'PILOT\'s automatic SharePoint sync started but has not completed a single cycle. It may need a restart (a re-deploy). Nothing is lost — every document is safe in PILOT and will sync once it recovers.',
            meta: [{ label: 'Status', value: 'no completed cycle since start' }],
            link: '/internal/sync-reviews', ctaLabel: 'Open Sync review',
          }).catch(() => {});
        }
      }
      return;
    }
    if (staleSec <= graceSec) { await clearAlert('sp-liveness-alert'); return; }
    // Tier 1 — self-heal. A wedged pass is abandoned by the stall guard; a
    // never-started worker gets kicked. Cheap and silent.
    console.warn(`[sp-sync] liveness: no completed pass in ${Math.round(staleSec / 60)} min (grace ${Math.round(graceSec / 60)} min) — kicking a recovery drain`);
    kick();
    // Tier 2 — only alert once self-heal has clearly failed (stale past 2×
    // grace). STABLE signature so this is truly once-per-episode: the cooldown
    // (default 2h) governs any reminder cadence during a sustained outage — a
    // 6-hour freeze pages roughly every 2h, not every 30 min. Recovery clears it.
    if (staleSec <= graceSec * 2) return;
    if (!(await claimAlert('sp-liveness-alert', 'stalled', livenessAlertCooldownMin()))) return;
    const mins = Math.round(staleSec / 60);
    const notify = require('./notify');
    await notify.notifyAdmins({
      type: 'sharepoint_worker_stalled',
      title: 'SharePoint sync — the sync worker looks stalled',
      body: `PILOT's automatic SharePoint sync has not completed a cycle in about ${mins >= 120 ? Math.round(mins / 60) + ' hours' : mins + ' minutes'}. ` +
            'It normally runs every few minutes. PILOT is trying to restart it automatically; if this message repeats, the sync may need a restart (a re-deploy) to recover. ' +
            'Nothing is lost — every document is safe in PILOT and will sync once the worker recovers.',
      meta: [
        { label: 'Last completed sync', value: `${mins} min ago` },
        { label: 'Expected', value: 'every few minutes' },
      ],
      link: '/internal/sync-reviews', ctaLabel: 'Open Sync review',
    }).catch(() => {});
  } catch (e) {
    console.warn('[sp-sync] liveness check error:', e.message);
  }
}

module.exports = {
  start, stop, kick, runOnce, drain, enabled, health, categoryFor, mirrorRow,
  verifyOnce, drainVerify, settleSupersededSnapshots, isRegenKind,
  reconciliation, checkBacklogSlo, stuckDocuments, escalateStuckDocs,
  classifyMirrorError, forceAttemptDoc,
  neverAttemptedStrays, pendingBatch, explainExclusion,
  sloSignature, claimSloAlert, clearSloAlert,
  claimAlert, clearAlert,
  withTimeout,
  checkDrainLiveness, recordHeartbeat, heartbeatStaleSec, heartbeatGraceSec,
  MAX_ATTEMPTS, VERIFY_RECHECK_DAYS,
};
