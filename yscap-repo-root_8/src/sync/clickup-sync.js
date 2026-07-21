/**
 * ClickUp sync worker. Four loops, all gated by switches.on('CLICKUP_SYNC_ENABLED'):
 *   pushOutbox   — drain sync_queue outbound jobs → orchestrator.pushApplication
 *   processInbox — drain clickup_webhook_inbox → ingest (with materialization gate)
 *   reconcile    — periodic filtered poll to catch missed webhooks + hot duplicates
 *   backfill     — one-shot historical ingest of every Pipeline task (paced)
 *
 * Everything is idempotent and keyed on task_id, so re-runs are safe.
 */
const db = require('../db');
const cfg = require('../config');
const switches = require('../lib/integrations/switches'); // runtime on/off (env default unless flipped)
const clickup = require('../clickup/client');
const registry = require('../clickup/registry');
const ingest = require('../clickup/ingest');
const orchestrator = require('../clickup/orchestrator');
const identity = require('../clickup/identity');
const mapper = require('../clickup/mapper');
const routing = require('../clickup/routing');
const statusMap = require('../clickup/status');

const PIPELINE_FOLDERS = () => {
  const f = new Set();
  for (const o of Object.values(routing.LOAN_OFFICERS)) if (o.pipeline) f.add(o.pipeline);
  for (const p of Object.values(routing.PROCESSORS)) if (p.pipeline) f.add(p.pipeline);
  f.add(routing.LEAD_CAPTURE_FOLDER);
  return [...f];
};

// A task is "real enough" to materialize a portal file: >=2 identity fields.
//
// 'starting' NO LONGER blocks materialization (owner-directed 2026-07-21). The
// ClickUp 'starting' status maps 1:1 to the portal's FILE_INTAKE stage
// (status.js EXTERNAL_FOR), so a task an officer creates DIRECTLY in ClickUp in
// 'starting' now syncs in RIGHT AWAY as an intake file, correctly mapped. This
// closes the gap behind the Moshe Spitzer / 76 Thompson St duplicate: an
// officer's June 'starting' card stayed invisible to the portal (scratch-gated),
// so when the same deal was later typed into the portal a SECOND ClickUp card
// was minted — two RTL-purchase twins. Syncing 'starting' cards in immediately
// means the deal already exists (and is task-linked) before anyone re-enters it,
// so no duplicate is created.
//
// The >=2 identity-field threshold (identity.canMaterialize) STAYS as the junk
// filter — a placeholder card with no real borrower ("h", "Miller", "mandel")
// still does not create a file until it carries at least two identity fields.
// 'prospect / pricing' (a softer, pre-file pricing prospect that may never
// become a deal) remains a scratch status that does not auto-create a file.
const SCRATCH = new Set(['prospect / pricing']);
function canMaterialize(read) {
  const idObj = ingest.identityFrom(read);
  if (!identity.canMaterialize(idObj)) return false;
  if (SCRATCH.has(String(read.internalStatus || '').trim().toLowerCase())) return false;
  return true;
}

async function optionMap() {
  // any Pipeline list carries the space-level dropdown options
  try {
    const folder = PIPELINE_FOLDERS()[0];
    const listId = await orchestrator.firstListId(folder);
    return await registry.optionMap(listId);
  } catch { return registry.peek(); }
}

// ---- outbound (portal → ClickUp) -----------------------------------------
async function pushOutboxOnce() {
  // Also RECLAIM jobs stranded in 'processing' — if the process crashed between
  // marking a job 'processing' and finalizing it, it would otherwise be lost
  // forever (a silently-dropped outbound push). updated_at is stamped to now() on
  // claim, so a 5-minute floor only catches genuine crash orphans, never a live
  // in-flight push (which finishes in well under a second). Re-running a push is
  // idempotent (setField writes the same values), so reclaim is safe.
  const r = await db.query(
    `UPDATE sync_queue SET status='processing', updated_at=now()
      WHERE id = (SELECT id FROM sync_queue WHERE target='clickup' AND direction='push' AND op='update'
                   AND run_after <= now()
                   AND (status='queued' OR (status='processing' AND updated_at < now() - interval '5 minutes'))
                   ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING *`);
  const job = r.rows[0];
  if (!job) return false;
  try {
    if (job.entity_type === 'application') {
      // Scoped push: the job carries the specific fields the edit changed
      // (payload.only). A queue job MUST name its fields — a job with no field
      // set (a legacy job enqueued before scoped push, or an empty set) is
      // skipped rather than pushed, so it can NEVER fall back to a full-payload
      // overwrite. Full pushes happen only via the explicit admin repush.
      const only = job.payload && Array.isArray(job.payload.only) ? job.payload.only.filter(Boolean) : [];
      // Keys a human typed directly into a portal form ride along so the DOB
      // gate can recognize the deliberate human decision it exists to demand.
      const humanEditKeys = job.payload && Array.isArray(job.payload.humanEditKeys) ? job.payload.humanEditKeys.filter(Boolean) : [];
      if (only.length) {
        // WO-4b (F-M15): heartbeat updated_at while the push runs, so the 5-min
        // 'processing' reclaim floor can never catch a STILL-RUNNING push and
        // double-run it (double journal + breaker double-count). WO-2's patient
        // retries mean a throttled push can now exceed 5 min; this keeps the job
        // claimed until it genuinely finishes.
        const heartbeat = setInterval(() => {
          db.query(`UPDATE sync_queue SET updated_at=now() WHERE id=$1 AND status='processing'`, [job.id]).catch(() => {});
        }, 120000);
        if (heartbeat.unref) heartbeat.unref();
        try {
          await orchestrator.pushApplication(job.entity_id, { force: true, only, humanEditKeys });
        } finally {
          clearInterval(heartbeat);
        }
      }
    }
    await db.query(`UPDATE sync_queue SET status='done', updated_at=now() WHERE id=$1`, [job.id]);
    // A push landing means the file's outbound path works again — any open
    // "push failed" review row for this file is stale; close it, no clicks
    // needed (one indexed UPDATE, hits only when such a row exists).
    if (job.entity_type === 'application') {
      try {
        await require('../lib/sync-review').closeStaleReviews({
          applicationId: job.entity_id, fieldKey: 'push_job',
          note: 'auto-closed — a later push for this file succeeded' });
      } catch (_) { /* best-effort */ }
    }
  } catch (e) {
    const attempts = job.attempts + 1;
    // OUTAGE-CLASS retries (post-merge audit finding #3): a circuit-breaker
    // rejection or a fail-closed pre-write read means ClickUp (or our own
    // volume cap) is temporarily unavailable — NOT that the job is bad. The
    // default budget (dead at 8 attempts ≈ 4 minutes of backoff) is SHORTER
    // than the breaker's own 10-minute window, so a legitimate user edit could
    // dead-letter during a breaker opening or a brief API outage and be lost
    // (there is no dead-job requeue path). These classes retry patiently:
    // fixed 10-minute spacing, dead only after 40 attempts (~7 hours). A task
    // deleted upstream resolves sooner anyway — the orphan reconcile archives
    // its file, and a push to an archived file completes as a skip.
    const outage = e && (e.code === 'CLICKUP_CIRCUIT_OPEN' || e.code === 'CLICKUP_PREREAD_FAILED' || e.retryable === true);
    const dead = attempts >= (outage ? 40 : 8);
    const backoff = outage ? 600 : Math.min(2 ** attempts, 3600);
    await db.query(
      `UPDATE sync_queue SET status=$1, attempts=$2, last_error=$3, run_after=now()+($4||' seconds')::interval, updated_at=now() WHERE id=$5`,
      [dead ? 'dead' : 'queued', attempts, String(e.message).slice(0, 500), backoff, job.id]);
    // DEAD-LETTERED = a user's edit silently stopped reaching ClickUp — that
    // must never be invisible (owner-directed 2026-07-15 night: anything stuck
    // goes to manual review, with options). The row offers "Retry push"; it
    // auto-closes when any later push for the file succeeds.
    if (dead && job.entity_type === 'application') {
      try {
        const app = (await db.query(
          `SELECT clickup_pipeline_task_id, borrower_id FROM applications WHERE id=$1`, [job.entity_id])).rows[0] || {};
        const only = (job.payload && Array.isArray(job.payload.only) ? job.payload.only : []).filter(Boolean);
        await require('../lib/sync-review').queueReview({
          applicationId: job.entity_id, borrowerId: app.borrower_id || null,
          taskId: app.clickup_pipeline_task_id || require('../lib/sync-file-review').syntheticTaskKey(job.entity_id),
          direction: 'outbound', fieldKey: 'push_job', reason: 'push_dead_lettered',
          portalValue: only.join(', ') || null, clickupValue: null,
          rawValue: JSON.stringify({ jobId: job.id, only, error: String(e.message).slice(0, 300) }) });
      } catch (qe) { console.warn('[clickup-sync] dead-letter review skipped:', qe.message); }
    }
  }
  return true;
}

// ---- unlinked-file recovery (post-merge audit finding #4) ------------------
// createForNewFile is fire-and-forget: one transient ClickUp error at
// file-start used to leave the portal file permanently unlinked, because the
// scoped-push-never-creates guard (correctly) stops later edits from creating
// the task. This boot-time one-shot is the deliberate, bounded recovery path:
// recent, live, still-unlinked files get one explicit createForNewFile retry.
// Bounds: portal-origin states only (never descoped/dead/manual_review), file
// older than 10 minutes (gives the inbound reconcile every chance to LINK an
// existing task first — identity matching runs before any create), younger
// than 30 days, 50 files per boot. Idempotent: a successful create links the
// file, dropping it from the next run's SELECT.
async function recoverUnlinkedFilesOnce() {
  if (!switches.on('CLICKUP_OUTBOUND_ENABLED')) return 0;
  const r = await db.query(
    `SELECT id FROM applications
      WHERE clickup_pipeline_task_id IS NULL AND deleted_at IS NULL
        AND (sync_state IS NULL OR sync_state NOT IN ('descoped','dead','manual_review'))
        AND created_at < now() - interval '10 minutes'
        AND created_at > now() - interval '30 days'
      ORDER BY created_at DESC LIMIT 50`).catch(() => ({ rows: [] }));
  let recovered = 0;
  for (const row of r.rows) {
    try {
      const out = await orchestrator.createForNewFile(row.id);
      if (out && out.taskId) recovered++;
    } catch (e) { console.error('[clickup-sync] unlinked-file recovery failed', row.id, e.message); }
  }
  if (r.rows.length) console.log(`[clickup-sync] unlinked-file recovery: ${recovered}/${r.rows.length} linked`);
  return recovered;
}

// A portal file with NO ClickUp task that is OLDER than the auto-recovery
// window (recoverUnlinkedFilesOnce stops at 30 days) cannot sync at all and
// was previously invisible — nothing listed it anywhere (owner-directed
// 2026-07-15 night: any file that can't sync goes to manual review, with
// options). One review row per file ("Create its ClickUp task" / dismiss),
// deduped via the synthetic app:<id> task key, auto-closed by ingest the
// moment the file links. Bounded: 100 files per boot, 180-day lookback so
// ancient pre-sync archives don't flood the queue on the first deploy.
async function flagUnsyncableFilesOnce() {
  const SFR = require('../lib/sync-file-review');
  const review = require('../lib/sync-review');
  const r = await db.query(
    `SELECT id, borrower_id, property_address->>'oneLine' AS one_line FROM applications a
      WHERE clickup_pipeline_task_id IS NULL AND deleted_at IS NULL
        AND (sync_state IS NULL OR sync_state NOT IN ('descoped','dead','manual_review'))
        AND created_at <= now() - interval '30 days'
        AND created_at >  now() - interval '180 days'
        -- Files that ALREADY have their row (open, or dismissed-for-good)
        -- must not hold LIMIT slots — otherwise a backlog wider than one
        -- boot's cap starves the tail forever (post-merge audit #3).
        AND NOT EXISTS (SELECT 1 FROM sync_review_queue q
                         WHERE q.task_id = 'app:' || a.id::text
                           AND q.field_key='file_link' AND q.status IN ('open','rejected'))
      ORDER BY created_at DESC LIMIT 100`).catch(() => ({ rows: [] }));
  let queued = 0;
  for (const row of r.rows) {
    try {
      await review.queueReview({
        applicationId: row.id, borrowerId: row.borrower_id || null,
        taskId: SFR.syntheticTaskKey(row.id),
        direction: 'outbound', fieldKey: 'file_link', reason: 'file_unlinked_no_task',
        suppressIfRejected: true,   // this sweep re-runs every boot — a dismiss must stick
        clickupValue: null, portalValue: row.one_line || null,
        rawValue: JSON.stringify({ applicationId: row.id }) });
      queued++;
    } catch (e) { console.warn('[clickup-sync] unsyncable-flag skipped', row.id, e.message); }
  }
  if (r.rows.length) console.log(`[clickup-sync] unsyncable-file sweep: ${queued}/${r.rows.length} review rows ensured`);
  return queued;
}

// DEAD / ORPHANED-BUT-STILL-LIVE files → review queue WITH OPTIONS (owner-directed
// 2026-07-19, the Pinches Lichtman / 129 Carlisle St incident: the real 73%-done
// file lost its ClickUp card and went orphaned while its card stuck to the empty
// twin). A file that carries NO card but is STILL a live file (deleted_at IS NULL)
// and sits in 'dead' or 'manual_review' is invisible to flagUnsyncableFilesOnce
// above — that sweep deliberately EXCLUDES those states and only covers
// 'unlinked'/NULL portal-origin files. So these orphaned real files never
// surfaced anywhere actionable. This boot one-shot queues a file_dead_unlinked
// review row for each, offering relink_task (move the correct existing card onto
// it — the twin fix), create_task, archive, or keep. The two sweeps' sync_state
// sets are DISJOINT, so a file is flagged by exactly one of them. Bounded
// (100/boot, 365-day lookback so an ancient archive can't flood the queue),
// deduped by the synthetic app:<id> key, and a dismiss sticks (suppressIfRejected).
async function flagDeadUnlinkedFilesOnce() {
  const SFR = require('../lib/sync-file-review');
  const review = require('../lib/sync-review');
  const r = await db.query(
    `SELECT id, borrower_id, sync_state, property_address->>'oneLine' AS one_line FROM applications a
      WHERE clickup_pipeline_task_id IS NULL AND deleted_at IS NULL
        AND sync_state IN ('dead','manual_review')
        AND created_at > now() - interval '365 days'
        -- Files that ALREADY have their row (open, or dismissed-for-good) must
        -- not hold LIMIT slots — a backlog wider than one boot's cap would
        -- otherwise starve the tail forever (mirrors flagUnsyncableFilesOnce).
        AND NOT EXISTS (SELECT 1 FROM sync_review_queue q
                         WHERE q.task_id = 'app:' || a.id::text
                           AND q.field_key='file_link' AND q.status IN ('open','rejected'))
      ORDER BY created_at DESC LIMIT 100`).catch(() => ({ rows: [] }));
  let queued = 0;
  for (const row of r.rows) {
    try {
      await review.queueReview({
        applicationId: row.id, borrowerId: row.borrower_id || null,
        taskId: SFR.syntheticTaskKey(row.id),
        direction: 'outbound', fieldKey: 'file_link', reason: 'file_dead_unlinked',
        suppressIfRejected: true,   // this sweep re-runs every boot — a dismiss must stick
        clickupValue: null, portalValue: row.one_line || null,
        rawValue: JSON.stringify({ applicationId: row.id, syncState: row.sync_state }) });
      queued++;
    } catch (e) { console.warn('[clickup-sync] dead-unlinked-flag skipped', row.id, e.message); }
  }
  if (r.rows.length) console.log(`[clickup-sync] dead-unlinked sweep: ${queued}/${r.rows.length} review rows ensured`);
  return queued;
}

// FULL-PORTFOLIO IDENTITY MISMATCH AUDIT (owner-directed 2026-07-15 night:
// "a real audit on every single mismatch"). The inbound heal is deliberately
// fill-only for borrower identity (email / cell / name / home address / SSN),
// so a DISAGREEMENT between the two systems on those fields was silent by
// design — nothing overwrote, but nothing surfaced it either. This boot
// one-shot compares every linked file's borrower profile against the task's
// LAST-INGEST SNAPSHOT (zero extra ClickUp API calls; it runs after the
// reconcile pass has refreshed snapshots) and queues a TWO-SIDED, RESOLVABLE
// review row per genuine mismatch. Common-sense comparators keep the noise
// down (NOT too strict — owner's words): emails compare case-folded, phones
// by their last 10 digits, names by FIRST token only (middle names and
// suffixes never flag), addresses by the same normalized street identity the
// dedup matcher uses, SSNs by last-4 (masked display). Fill-only cases (one
// side blank) never flag — they aren't mismatches. Dismissals stick
// (suppressIfRejected); rows self-close here when the systems agree again.
async function auditIdentityMismatchesOnce() {
  const review = require('../lib/sync-review');
  const identity = require('../clickup/identity');
  const transforms = require('../clickup/transforms');
  // co_first_name / co_cell_phone were MISSING from this list, so their open
  // rows could never auto-close (owner-reported: the Mendelovits co-cell card
  // sat open forever) — every key the loop can queue must be listed here.
  const KEYS = ['email', 'cell_phone', 'first_name', 'current_address', 'ssn',
    'co_first_name', 'co_cell_phone', 'borrower_identity', 'co_borrower_identity'];
  const r = await db.query(
    `SELECT a.id, a.clickup_pipeline_task_id AS task_id, a.borrower_id, a.co_borrower_id, a.loan_officer_id,
            b.email, b.cell_phone, b.first_name, b.last_name, b.current_address, b.ssn_last4,
            b2.email AS co_email, b2.cell_phone AS co_cell, b2.first_name AS co_first, b2.last_name AS co_last, b2.ssn_last4 AS co_ssn_last4,
            i.snapshot
       FROM applications a
       JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN borrowers b2 ON b2.id = a.co_borrower_id
       JOIN clickup_task_index i ON i.task_id = a.clickup_pipeline_task_id
      WHERE a.clickup_pipeline_task_id IS NOT NULL AND a.deleted_at IS NULL
        AND (a.sync_state IS NULL OR a.sync_state NOT IN ('descoped','manual_review','dead'))
        AND i.snapshot IS NOT NULL
      ORDER BY a.updated_at DESC LIMIT 500`).catch(() => ({ rows: [] }));
  if (!r.rows.length) return 0;
  // Close-only-what's-open: one upfront read instead of per-field UPDATEs.
  const open = await db.query(
    `SELECT task_id, field_key FROM sync_review_queue WHERE status='open' AND field_key = ANY($1)`,
    [KEYS]).catch(() => ({ rows: [] }));
  const openSet = new Set(open.rows.map((o) => `${o.task_id}|${o.field_key}`));
  const digitsOf = (v) => String(v == null ? '' : v).replace(/\D/g, '');
  const lc = (v) => String(v == null ? '' : v).trim().toLowerCase();
  // Our own placeholder emails are FILLER, never data — treated as blank here
  // (Avrohom Kopel: shadow-vs-real "mismatches" hundreds of times; the heal
  // now upgrades them, and they must never flag meanwhile).
  const isShadowEmail = (v) => /^noemail\+.*@clickup\.local$/i.test(String(v || ''));
  const addrText = (v) => (v && (v.formatted_address || v.oneLine || v.line1)) || '';
  // SAME-STREET comparator (Noach Mendelovits: "Ave" vs "Avenue", "Unit 114"
  // vs "114", "Village of Spring Valley" vs "Spring Valley" are the SAME
  // place). House number + first two street tokens (suffix-normalized) +
  // ZIP-when-both-present must all agree to be "same"; anything failing that
  // is a real disagreement. Full canonicalization (Google place_id) is the
  // owner's follow-up project — this kills the formatting-noise class now.
  const STREET_ABBR = { avenue: 'ave', av: 'ave', street: 'st', road: 'rd', drive: 'dr', lane: 'ln', court: 'ct',
    place: 'pl', boulevard: 'blvd', terrace: 'ter', highway: 'hwy', parkway: 'pkwy', circle: 'cir', square: 'sq', trail: 'trl' };
  const addrParts = (t) => {
    const raw = String(t || '');
    if (!raw.trim()) return null;
    const s = raw.toLowerCase()
      .replace(/\b(unit|apt|apartment|suite|ste)\s*#?\s*[\w-]+/g, ' ')
      .replace(/#\s*[\w-]+/g, ' ')
      .replace(/\b(village|town|city|borough|township)\s+of\b/g, ' ')
      .replace(/[^a-z0-9 ]+/g, ' ');
    const toks = s.split(/\s+/).filter(Boolean).map((w) => STREET_ABBR[w] || w);
    const num = toks.find((w) => /^\d/.test(w)) || '';
    const street = toks.filter((w) => /^[a-z]/.test(w)).slice(0, 2).join(' ');
    const zip = (raw.match(/\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)/) || [])[1] || '';
    return num && street ? { num, street, zip } : null;
  };
  const sameStreet = (a, b) => {
    const x = addrParts(a), y = addrParts(b);
    if (!x || !y) return null;   // can't tell → skip (never flag on a guess)
    return x.num === y.num && x.street === y.street && (!x.zip || !y.zip || x.zip === y.zip);
  };
  // WRONG-MERGE SIGNATURE (owner incident 2026-07-15 night): a NAME
  // disagreement between the task and the profile is usually a typo/nickname —
  // but when the profile ALSO shows evidence of belonging to someone else's
  // relationship (an owning officer or a CRM lead under a DIFFERENT officer
  // than the file's), the likeliest truth is that TWO PEOPLE were merged into
  // ONE row (family-shared email + family surname). That case must NOT be a
  // rename review — adopting either name onto the shared row renames the OTHER
  // person too. It queues a 'borrower_identity_conflict' row whose
  // split_borrower action un-merges them.
  const wrongMergeSignature = async (personId, loanOfficerId) => {
    try {
      const s = await db.query(
        `SELECT
           EXISTS (SELECT 1 FROM borrowers bb
                    WHERE bb.id=$1 AND bb.primary_officer_id IS NOT NULL
                      AND bb.primary_officer_id IS DISTINCT FROM $2) AS owner_differs,
           EXISTS (SELECT 1 FROM leads l
                    WHERE l.officer_id IS NOT NULL AND l.officer_id IS DISTINCT FROM $2
                      AND (l.borrower_id=$1 OR EXISTS (
                            SELECT 1 FROM borrowers bb2
                             WHERE bb2.id=$1 AND bb2.email IS NOT NULL
                               AND lower(l.email)=lower(bb2.email)))) AS lead_differs`,
        [personId, loanOfficerId]);
      return !!(s.rows[0] && (s.rows[0].owner_differs || s.rows[0].lead_differs));
    } catch (_) { return false; }
  };
  let queued = 0, closed = 0;
  for (const row of r.rows) {
    const sb = (row.snapshot && row.snapshot.borrower) || {};
    // SWAP-PENDING GUARD (Boruch Stauber): when the MAIN task's person is the
    // file's CO-borrower (roles reversed between the systems), every check
    // below would cross-compare two different humans. The ingest-side role
    // reconciliation aligns the file on the same boot pass — skip it here.
    const sbLast4 = (String(sb.ssn || '').match(/(\d{4})\s*$/) || [])[1] || null;
    const sbFirst = lc(String(sb.first_name || '').split(/\s+/)[0]);
    const looksLikeCo = !!(row.co_first || row.co_ssn_last4) && (
      (sbLast4 && row.co_ssn_last4 && sbLast4 === String(row.co_ssn_last4)) ||
      (sb.email && row.co_email && lc(sb.email) === lc(row.co_email) && !isShadowEmail(row.co_email)) ||
      (sbFirst && row.co_first && sbFirst === lc(String(row.co_first).split(/\s+/)[0])
        && digitsOf(sb.cell_phone).slice(-10) && digitsOf(sb.cell_phone).slice(-10) === digitsOf(row.co_cell).slice(-10)));
    if (looksLikeCo) continue;
    const checks = [];
    // CONTACT INFO IS ADDITIVE, never a conflict (owner-directed 2026-07-15
    // night: "additional phone numbers, additional email addresses — just add
    // them to the borrower profile; it's not about replacing the old one").
    // A different email/phone on another of the borrower's files ACCUMULATES
    // into borrower_contacts (deduped) — the profile primary stays, each
    // task keeps its own contact, and no review card is ever raised for it.
    const addContact = async (kind, value) => {
      try {
        await db.query(
          `INSERT INTO borrower_contacts (borrower_id, kind, value, source)
           VALUES ($1,$2,$3,$4) ON CONFLICT (borrower_id, kind, value) DO NOTHING`,
          [row.borrower_id, kind, String(value).toLowerCase().trim(), `clickup:${row.task_id}`]);
      } catch (_) { /* best-effort */ }
    };
    const closeContactRow = async (fk, note) => {
      if (openSet.has(`${row.task_id}|${fk}`)) {
        closed += await review.closeStaleReviews({ taskId: row.task_id, fieldKey: fk, note });
      }
    };
    // ---- MAIN-PERSON wrong-merge check FIRST (owner incident 2026-07-15
    // night, follow-up: "the officer still has access and I don't have the
    // option to split"). ANY identity disagreement — name, SSN, or phone —
    // on a profile that belongs to another officer's relationship means the
    // profile likely holds TWO people. In that case every per-field card is
    // meaningless cross-person noise (and the "additive" contact adoption
    // below would stamp the other person's phone/email onto the lead's
    // profile — pollution, not enrichment): suppress them all, close any
    // already open, and queue ONE actionable "one profile, two people" card.
    const pFirstTok = lc(String(row.first_name || '').split(/\s+/)[0]);
    const namesComparable = !!(sbFirst && pFirstTok
      && !transforms.isPlaceholderName(sb.first_name) && !transforms.isPlaceholderName(row.first_name));
    const firstDiffer = namesComparable && sbFirst !== pFirstTok;
    const ssnDiffer = !!(sbLast4 && row.ssn_last4 && sbLast4 !== String(row.ssn_last4));
    const cpEarly = digitsOf(sb.cell_phone), ppEarly = digitsOf(row.cell_phone);
    const phoneDiffer = cpEarly.length >= 10 && ppEarly.length >= 10 && cpEarly.slice(-10) !== ppEarly.slice(-10);
    const mainMerged = (firstDiffer || ssnDiffer || phoneDiffer)
      && await wrongMergeSignature(row.borrower_id, row.loan_officer_id);
    if (mainMerged) {
      try {
        await review.queueReview({
          applicationId: row.id, borrowerId: row.borrower_id, taskId: row.task_id,
          direction: 'inbound', fieldKey: 'borrower_identity', reason: 'borrower_identity_conflict',
          suppressIfRejected: true,
          rawValue: JSON.stringify({ role: 'borrower', mergedBorrowerId: row.borrower_id,
            evidence: { firstDiffer, ssnDiffer, phoneDiffer } }).slice(0, 300),
          clickupValue: [sb.first_name, sb.last_name].filter(Boolean).join(' ').slice(0, 160),
          portalValue: [row.first_name, row.last_name].filter(Boolean).join(' ').slice(0, 160) });
        queued++;
      } catch (_) { /* best-effort */ }
      for (const fk of ['first_name', 'email', 'cell_phone', 'ssn', 'current_address']) {
        try {
          await closeContactRow(fk, 'auto-closed — this profile appears to hold TWO different people (see the “one profile, two people” card); comparing fields across two humans is meaningless');
        } catch (_) { /* best-effort */ }
      }
    }
    if (!mainMerged && sb.email && row.email && !isShadowEmail(sb.email)) {
      if (isShadowEmail(row.email)) {
        // Placeholder vs real is NOT a disagreement — the heal upgrades it;
        // close any noise row already queued for it.
        await closeContactRow('email', 'auto-closed — PILOT held our own placeholder email, not a real value; it upgrades from ClickUp automatically');
      } else if (lc(sb.email) !== lc(row.email)) {
        await addContact('email', sb.email);
        await closeContactRow('email', 'auto-closed — recorded as an ADDITIONAL email on the borrower profile (contact info accumulates; nothing was replaced)');
      } else {
        await closeContactRow('email', 'auto-closed — the two systems now agree');
      }
    }
    if (!mainMerged && cpEarly.length >= 10 && ppEarly.length >= 10) {
      if (phoneDiffer) {
        await addContact('phone', sb.cell_phone);
        await closeContactRow('cell_phone', 'auto-closed — recorded as an ADDITIONAL phone on the borrower profile (contact info accumulates; nothing was replaced)');
      } else {
        await closeContactRow('cell_phone', 'auto-closed — the two systems now agree');
      }
    }
    if (!mainMerged && namesComparable) {
      checks.push({ key: 'first_name', differ: firstDiffer,
        cu: [sb.first_name, sb.last_name].filter(Boolean).join(' '), p: [row.first_name, row.last_name].filter(Boolean).join(' ') });
      // A same-person verdict clears any earlier merge-suspicion card.
      checks.push({ key: 'borrower_identity', differ: false,
        cu: [sb.first_name, sb.last_name].filter(Boolean).join(' '), p: [row.first_name, row.last_name].filter(Boolean).join(' ') });
    }
    let same = mainMerged ? null : sameStreet(addrText(sb.current_address), addrText(row.current_address));
    // CANONICAL fallback (owner-directed: Google Maps decides "technically the
    // same"): when the text heuristic says the addresses DIFFER, resolve both
    // through the cached place_id canonicalizer — the same property in two
    // formats stops flagging. Degradable: no API key / unresolvable → the
    // heuristic verdict stands. Bounded: only runs on heuristic mismatches,
    // and every distinct text resolves once (db/113 cache).
    if (same === false) {
      try {
        const sp2 = await require('../lib/address-canon').samePlace(addrText(sb.current_address), addrText(row.current_address));
        if (sp2 === true) same = true;
      } catch (_) { /* canonicalization is an enhancement, never a blocker */ }
    }
    if (same === true) {
      // UNITS ARE ADDITIVE (owner-directed 2026-07-15 night: "a unit is just
      // an addition, not an override — if one side has it, add it to the
      // other"). Same street, one side missing the unit → enrich that side.
      const unitOf = (t) => (String(t || '').toLowerCase().match(/\b(?:unit|apt|apartment|suite|ste)\s*#?\s*([\w-]+)/) || [])[1] || '';
      const cuUnit = unitOf(addrText(sb.current_address)), pUnit = unitOf(addrText(row.current_address));
      try {
        if (cuUnit && !pUnit && sb.current_address && typeof sb.current_address === 'object') {
          // ClickUp's Google-canonical form carries the unit — adopt it into
          // the profile (same place, fuller text; audited).
          await db.query(`UPDATE borrowers SET current_address=$2::jsonb, updated_at=now() WHERE id=$1`,
            [row.borrower_id, JSON.stringify(sb.current_address)]);
          await db.query(
            `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
             VALUES ('system',NULL,'address_unit_enriched','borrower',$1,$2)`,
            [row.borrower_id, JSON.stringify({ taskId: row.task_id, unit: cuUnit,
              adopted: addrText(sb.current_address), was: addrText(row.current_address) })]).catch(() => {});
        } else if (pUnit && !cuUnit) {
          // The portal carries the unit — push the fuller address to ClickUp
          // through the normal scoped path (guarded; skips without coords).
          await require('../clickup/enqueue').enqueueClickupPush(row.id, ['current_address']);
        }
      } catch (_) { /* enrichment is best-effort */ }
      await closeContactRow('current_address', 'auto-closed — same address (a missing unit is added, never a conflict)');
    } else if (same === false) {
      checks.push({ key: 'current_address', differ: true, cu: addrText(sb.current_address), p: addrText(row.current_address) });
    }
    if (!mainMerged && sbLast4 && row.ssn_last4) {
      checks.push({ key: 'ssn', differ: ssnDiffer, cu: '✱✱✱-✱✱-' + sbLast4, p: '✱✱✱-✱✱-' + row.ssn_last4 });
    }
    // CO-BORROWER coverage (mega-audit enhancement #3): the snapshot's masked
    // coBorrower block carries enough for name + phone-last4 comparisons
    // against the SUBTASK person. Guidance-only rows (co_* keys are not side-
    // resolvable — the fix happens on the subtask or the co profile); the
    // role-reconciliation pass makes the pairing trustworthy.
    const sco = row.snapshot && row.snapshot.coBorrower;
    if (sco && row.co_borrower_id && typeof sco === 'object') {
      const scoFirst = lc(String(sco.first_name || '').split(/\s+/)[0]);
      const pcoFirst = lc(String(row.co_first || '').split(/\s+/)[0]);
      const coNamesComparable = !!(scoFirst && pcoFirst
        && !transforms.isPlaceholderName(sco.first_name) && !transforms.isPlaceholderName(row.co_first));
      const coNameDiffer = coNamesComparable && scoFirst !== pcoFirst;
      const scoP4 = String(sco.phone_last4 || ''), pcoP4 = digitsOf(row.co_cell).slice(-4);
      const coPhonesComparable = scoP4.length === 4 && pcoP4.length === 4;
      const coPhoneDiffer = coPhonesComparable && scoP4 !== pcoP4;
      // The Mendelovits/Cohen incident shape: the file's CO-borrower slot
      // points at a profile that is really another officer's lead — two
      // different people merged on a shared family email + surname. The
      // PHONE disagreeing is merge evidence exactly like the name (the
      // incident surfaced as a co-cell card, not a name card) — either one,
      // on a profile with another officer's relationship, means ONE
      // actionable split card instead of unanswerable field cards.
      const coMerged = (coNameDiffer || coPhoneDiffer)
        && await wrongMergeSignature(row.co_borrower_id, row.loan_officer_id);
      if (coMerged) {
        checks.push({ key: 'co_borrower_identity', reason: 'borrower_identity_conflict', bId: row.co_borrower_id, differ: true,
          raw: { role: 'co_borrower', mergedBorrowerId: row.co_borrower_id,
            evidence: { coNameDiffer, coPhoneDiffer } },
          cu: [sco.first_name, sco.last_name].filter(Boolean).join(' ') || ('…' + scoP4),
          p: [row.co_first, row.co_last].filter(Boolean).join(' ') || ('…' + pcoP4) });
        for (const fk of ['co_first_name', 'co_cell_phone']) {
          try {
            await closeContactRow(fk, 'auto-closed — this co-borrower profile appears to hold TWO different people (see the “one profile, two people” card); comparing fields across two humans is meaningless');
          } catch (_) { /* best-effort */ }
        }
      } else {
        if (coNamesComparable) {
          checks.push({ key: 'co_first_name', bId: row.co_borrower_id, differ: coNameDiffer,
            cu: [sco.first_name, sco.last_name].filter(Boolean).join(' '), p: [row.co_first, row.co_last].filter(Boolean).join(' ') });
        }
        if (coPhonesComparable) {
          checks.push({ key: 'co_cell_phone', bId: row.co_borrower_id, differ: coPhoneDiffer,
            cu: '…' + scoP4, p: '…' + pcoP4 });
        }
        // A same-person verdict clears any earlier merge-suspicion card.
        checks.push({ key: 'co_borrower_identity', bId: row.co_borrower_id, differ: false,
          cu: [sco.first_name, sco.last_name].filter(Boolean).join(' '), p: [row.co_first, row.co_last].filter(Boolean).join(' ') });
      }
    }
    for (const c of checks) {
      try {
        if (c.differ) {
          await review.queueReview({
            applicationId: row.id, borrowerId: c.bId || row.borrower_id, taskId: row.task_id,
            direction: 'inbound', fieldKey: c.key, reason: c.reason || 'identity_mismatch_audit',
            suppressIfRejected: true,
            rawValue: c.raw ? JSON.stringify(c.raw).slice(0, 300) : undefined,
            clickupValue: String(c.cu).slice(0, 160), portalValue: String(c.p).slice(0, 160) });
          queued++;
        } else if (openSet.has(`${row.task_id}|${c.key}`)) {
          // The RESOLVED tab must SAY what settled it (owner-directed): the
          // note carries the value the two systems now share, so "somebody
          // fixed it outside PILOT" is still a visible, explained record.
          closed += await review.closeStaleReviews({ taskId: row.task_id, fieldKey: c.key,
            note: `auto-closed — the two systems now agree on “${String(c.p).slice(0, 80)}” (fixed at the source or by a sync heal)` });
        }
      } catch (_) { /* per-field best-effort */ }
    }
  }
  if (queued || closed) console.log(`[clickup-sync] identity mismatch audit: ${queued} queued, ${closed} auto-closed`);
  return queued;
}

// SHARED EMAIL = A REVIEW CARD OF ITS OWN (owner-directed 2026-07-15 night:
// "sign up a manual review that two separate borrowers have the same email —
// one of them needs their email changed, and the email assigned to only ONE
// borrower; until fixed the system must not link files by that email, and the
// borrowers stay separately assigned to their own loan officers").
// The linking quarantine is structural: an uncorroborated shared email NEVER
// merges (identity.emailMatchCorroborated) — the second person gets a distinct
// profile with a placeholder email. What was MISSING was the visible to-do:
// the pair sat silently in borrower_dedup_candidates. This sweep turns every
// open shared-email pair into a review card telling staff exactly what to fix
// (give one of the two their own email — in PILOT on the borrower screen, or
// in ClickUp), and auto-closes the card (and settles the candidate row) the
// moment each borrower carries their own real email.
async function sharedEmailReviewSweepOnce() {
  const review = require('../lib/sync-review');
  const isPlaceholder = (e) => /^noemail\+.*@clickup\.local$/i.test(String(e || ''));
  const r = await db.query(
    `SELECT c.id AS cand_id, c.borrower_id AS b1, c.matched_borrower_id AS b2,
            x.email AS e1, x.first_name AS f1, x.last_name AS l1,
            y.email AS e2, y.first_name AS f2, y.last_name AS l2
       FROM borrower_dedup_candidates c
       JOIN borrowers x ON x.id = c.borrower_id
       JOIN borrowers y ON y.id = c.matched_borrower_id
      WHERE c.status = 'open' AND c.reason = 'shared_email_uncorroborated'
        -- an ALLOWED pair (staff clicked "Allow — same email for both") never flags again
        AND NOT EXISTS (SELECT 1 FROM borrower_profile_links pl
                         WHERE pl.borrower_id = c.borrower_id AND pl.linked_borrower_id = c.matched_borrower_id)
      ORDER BY c.created_at DESC LIMIT 200`).catch(() => ({ rows: [] }));
  if (!r.rows.length) return 0;
  const identity = require('../clickup/identity');
  let queued = 0, closedN = 0;
  for (const row of r.rows) {
    const key = 'dedup:' + [String(row.b1), String(row.b2)].sort().join(':');
    const n1 = [row.f1, row.l1].filter(Boolean).join(' ') || 'first person';
    const n2 = [row.f2, row.l2].filter(Boolean).join(' ') || 'second person';
    try {
      // A pair with a NAMELESS side is not human-decidable ("give one of
      // Unknown and Unknown their own email"?) — owner-reported noise. No
      // card; close any card an earlier pass queued. The husk fills from
      // ClickUp automatically and the pair becomes reviewable when it does.
      if (!identity.nameToken(row.f1) || !identity.nameToken(row.f2)) {
        closedN += await review.closeStaleReviews({ taskId: key, fieldKey: 'shared_email',
          note: 'auto-closed — one side of this pair is a nameless placeholder profile (it fills from ClickUp automatically); nothing to decide yet' });
        continue;
      }
      if (!isPlaceholder(row.e1) && !isPlaceholder(row.e2)) {
        // Each person now carries their own real email (primary emails are
        // unique, so two real emails are necessarily two different emails) —
        // the situation the card asked staff to create. Close + settle.
        closedN += await review.closeStaleReviews({ taskId: key, fieldKey: 'shared_email',
          note: `auto-closed — ${n1} and ${n2} each carry their own email now` });
        await db.query(
          `UPDATE borrower_dedup_candidates SET status='distinct', resolved_at=now()
            WHERE id=$1 AND status='open'`, [row.cand_id]).catch(() => {});
      } else {
        const sharedEmail = isPlaceholder(row.e1) ? row.e2 : row.e1;
        await review.queueReview({
          borrowerId: row.b1, taskId: key, direction: 'inbound',
          fieldKey: 'shared_email', reason: 'shared_email_needs_reassignment',
          suppressIfRejected: true,
          rawValue: JSON.stringify({ b1: row.b1, b2: row.b2 }).slice(0, 300),
          clickupValue: String(sharedEmail || '').slice(0, 160),
          portalValue: `${n1} AND ${n2}`.slice(0, 160) });
        queued++;
      }
    } catch (_) { /* per-pair best-effort */ }
  }
  if (queued || closedN) console.log(`[clickup-sync] shared-email sweep: ${queued} queued, ${closedN} auto-closed`);
  return queued;
}

// A task that failed to MATERIALIZE (match_status 'ambiguous' or
// 'duplicate_pending') only ever got re-examined when ClickUp happened to send
// another webhook or the task fell inside the reconcile window — so a task
// stuck on a since-FIXED root cause stayed invisible in the portal forever
// (Asher Salamon, 2026-07-15: a copied YS-loan-number from the duplicate-a-task
// workflow kept the Dennis Pl task 'ambiguous' long after the resolver learned
// to handle copied numbers). This boot one-shot deliberately re-drives every
// stuck task through the CURRENT resolver so each root-cause fix heals the
// whole backlog on the next deploy, not just tasks that happen to change.
// Bounds: non-materialized rows only (application_id IS NULL), newest first,
// 200 per boot; per-task failures are isolated. Idempotent: a task that
// materializes gets application_id set and drops out of the next run's SELECT;
// one that is still genuinely ambiguous just refreshes its match_detail (and
// its ingest now queues a visible 'file_link' review row instead of silence).
async function retryStuckTasksOnce() {
  // Without inbound creation the retry could only DEMOTE visibility (a re-
  // ingest that can't create resolves 'skipped', overwriting the ambiguous/
  // duplicate_pending flag that keeps the task in the manual-review queues).
  if (!switches.on('CLICKUP_INBOUND_CREATE_FILES')) { console.log('[clickup-sync] stuck-task retry skipped (inbound create OFF)'); return 0; }
  // Oldest-first so a backlog wider than one boot's cap ROTATES instead of
  // starving the tail (a retried-but-still-stuck task refreshes snapshot_at,
  // sending it to the back of the line for the next boot).
  // 'skipped' is INCLUDED (owner-reported class of silently-stuck tasks): a task
  // ingested while inbound-create was OFF, or one that lacked enough identity data
  // to materialize at ingest time, is stored 'skipped' and — unlike ambiguous/
  // duplicate_pending — produced no review row. Re-driving it here (only ever with
  // create ON, per the guard above) materializes it the moment it's eligible
  // (switch flipped, or the task gained an address/loan#). Genuine-stuck rows
  // (ambiguous/duplicate_pending) are ordered FIRST so a large skipped backlog
  // can never starve them within one boot's cap.
  const r = await db.query(
    `SELECT task_id, match_status FROM clickup_task_index
      WHERE match_status IN ('ambiguous','duplicate_pending','skipped')
        AND application_id IS NULL
      ORDER BY (match_status='skipped') ASC, snapshot_at ASC NULLS FIRST LIMIT 200`).catch(() => ({ rows: [] }));
  if (!r.rows.length) return 0;
  let materialized = 0, still = 0, failed = 0;
  for (const row of r.rows) {
    try {
      const res = await ingestOne(row.task_id);
      if (res && res.applicationId) materialized++; else still++;
    } catch (e) { failed++; console.error('[clickup-sync] stuck-task retry failed', row.task_id, e.message); }
    // Pace the pass — each retry costs multiple ClickUp reads and the client
    // has no 429 backoff; a big backlog must not exhaust the API rate limit
    // while the webhook inbox is draining (pre-merge audit should-fix).
    await new Promise((res2) => setTimeout(res2, 400));
  }
  console.log(`[clickup-sync] stuck-task retry: ${materialized} materialized, ${still} still waiting, ${failed} failed (of ${r.rows.length})`);
  return materialized;
}

// ---- dirty sweep (RETIRED — do not reintroduce) ---------------------------
// The old dirty-sweep did a FULL, unscoped push of every "dirty" file. That is
// exactly the behavior that caused the ClickUp-overwrite incident (it pushed
// mapped/synthetic values over real ClickUp data and echo-looped). Outbound is
// now enqueue-on-write + scoped push ONLY (pushOutboxOnce). This function is
// permanently retired to a no-op so it can never be re-wired into a full
// overwrite path; it stays exported only so any stale caller/test is a safe
// no-op rather than a crash. Returns false so a `while (await fn())` drains once.
async function sweepDirtyOnce() {
  return false;
}

// ---- inbound (ClickUp → portal) ------------------------------------------
async function processInboxOnce() {
  // Also RECLAIM inbox rows stranded in 'processing' by a crash mid-ingest (they'd
  // otherwise never be re-driven). The age is measured from CLAIM time
  // (processing_started_at, stamped below) — NOT receipt time — so an overlapping
  // drain can never re-grab a row that is still being ingested during a >15-min
  // backlog (which would double-ingest and, since upsertLlc/upsertTrackRecord are
  // check-then-insert without a unique constraint, create duplicate rows). The
  // COALESCE(..., received_at) fallback reclaims any row left 'processing' before
  // this column existed (db/080). A genuine crash orphan is re-ingested safely
  // (ingestTask is idempotent: COALESCE upserts, no-downgrade, ON CONFLICT keys).
  const r = await db.query(
    `UPDATE clickup_webhook_inbox SET status='processing', processing_started_at=now()
      WHERE id = (SELECT id FROM clickup_webhook_inbox
                   WHERE status='received'
                      OR (status='processing'
                          AND COALESCE(processing_started_at, received_at) < now() - interval '15 minutes')
                   ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`);
  const row = r.rows[0];
  if (!row) return false;
  try {
    if (row.task_id) await ingestOne(row.task_id);
    await db.query(`UPDATE clickup_webhook_inbox SET status='done', processed_at=now() WHERE id=$1`, [row.id]);
  } catch (e) {
    const attempts = row.attempts + 1;
    const terminal = attempts >= 6;
    await db.query(`UPDATE clickup_webhook_inbox SET status=$1, attempts=$2, last_error=$3 WHERE id=$4`,
      [terminal ? 'error' : 'received', attempts, String(e.message).slice(0, 500), row.id]);
    // WO-3 (F-M6): a terminal inbox failure used to be a SILENT drop — the row
    // sat in 'error' and nothing ever looked at it, so a ClickUp update never
    // reached the portal and no one knew. Make it traceable (audit_log, PII-free)
    // so it surfaces in the evidence report; the boot re-drive
    // (redriveInboxErrorsOnce) re-attempts error rows on the next deploy so a
    // transient failure self-heals. (Phase 2: a visible review card + a
    // webhook-health probe.)
    if (terminal) {
      try {
        await db.query(
          `INSERT INTO audit_log (actor_kind, action, entity_type, entity_id, detail)
           VALUES ('system', 'clickup_ingest_failed', 'application', NULL, $1)`,
          [JSON.stringify({ inboxId: row.id, taskId: row.task_id || null, error: String(e.message).slice(0, 300) })]);
      } catch (_) { /* the row is already in 'error' with last_error; audit is the extra trace */ }
    }
  }
  return true;
}

// WO-3 (F-M6): re-attempt terminally-failed inbox rows on boot so a transient
// failure (a brief outage, a since-fixed bug) self-heals instead of sitting in
// 'error' forever, silently dropping a ClickUp update. Bounded + newest-per-task
// so a persistent failure can't spin; ingestOne is idempotent, so re-driving is
// safe. attempts are NOT reset, so a still-broken row terminals again after one
// more try (one retry per deploy, never an infinite loop).
async function redriveInboxErrorsOnce() {
  const sel = await db.query(
    `SELECT DISTINCT ON (task_id) id FROM clickup_webhook_inbox
      WHERE status='error' AND task_id IS NOT NULL AND received_at > now() - interval '7 days'
      ORDER BY task_id, received_at DESC
      LIMIT 100`).catch(() => ({ rows: [] }));
  if (!sel.rows.length) return 0;
  const ids = sel.rows.map((x) => x.id);
  await db.query(`UPDATE clickup_webhook_inbox SET status='received' WHERE id = ANY($1) AND status='error'`, [ids]).catch(() => {});
  console.log(`[clickup-sync] inbox re-drive: reset ${ids.length} terminal error row(s) to retry`);
  return ids.length;
}

/** Fetch + ingest a single task by id, applying the materialization gate.
 *  opts.forceCreate: admin override — creates the file even when the
 *  duplicate-in-progress defer would wait (a genuine same-address second deal). */
async function ingestOne(taskId, opts = {}) {
  const task = await clickup.getTask(taskId, { include: ['custom_fields'] });
  const options = await optionMap();
  const read = mapper.readTaskFields(task, options);
  // Inbound new-file creation is gated (see switches.on('CLICKUP_INBOUND_CREATE_FILES')) to
  // avoid duplicating an existing unlinked portal app; linked files still update.
  const createFile = (switches.on('CLICKUP_INBOUND_CREATE_FILES') || opts.forceCreate === true) && canMaterialize(read);
  return ingest.ingestTask(task, options, { createFile, forceCreate: opts.forceCreate === true });
}

// ---- reconciliation poll --------------------------------------------------
// WO-4 (F-M7 / F-H4): the reconcile "bookmark" is DURABLE and only moves forward
// on a fully-successful pass.
//   * Persisted in sync_runtime_state (db/125) so a restart RESUMES instead of
//     re-scanning the last 24h on every deploy (the boot-storm driver).
//   * Captured BEFORE the query (preQueryMs), so a task updated DURING the pass
//     is caught next time instead of being skipped.
//   * Advanced only if NO task in the pass failed — a thrown ingest no longer
//     lets the bookmark slide past the task it choked on.
//   * A small overlap re-covers the boundary (re-ingest is idempotent), and a
//     72h clamp bounds the catch-up scan after a long outage.
let _watermark = 0;   // in-process mirror of the persisted bookmark (fallback only)
const RECON_KEY = 'clickup_reconcile_watermark';
const RECON_OVERLAP_MS = 2 * 60 * 1000;        // re-cover the last 2 min (idempotent) so nothing on the boundary is missed
const RECON_DEFAULT_LOOKBACK_MS = 24 * 3600 * 1000;
const RECON_MAX_LOOKBACK_MS = 72 * 3600 * 1000; // never scan more than 72h in one catch-up pass

async function loadState(key) {
  try {
    const r = await db.query(`SELECT value FROM sync_runtime_state WHERE key=$1`, [key]);
    return (r.rows[0] && r.rows[0].value) || null;
  } catch (_) { return null; }   // table missing / DB blip → behave like no bookmark yet
}
async function saveState(key, value) {
  try {
    await db.query(
      `INSERT INTO sync_runtime_state (key, value, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [key, JSON.stringify(value)]);
  } catch (e) { console.warn('[clickup-sync] saveState failed:', e.message); }
}

/** The `dateUpdatedGt` to query with: the persisted bookmark, but never older
 *  than maxLookback before now (bounds a catch-up after a long outage), and the
 *  default lookback when there is no bookmark yet. Pure — unit tested. */
function reconcileSince({ persisted, preQueryMs, defaultLookbackMs = RECON_DEFAULT_LOOKBACK_MS, maxLookbackMs = RECON_MAX_LOOKBACK_MS }) {
  const floor = preQueryMs - maxLookbackMs;
  const base = (typeof persisted === 'number' && persisted > 0) ? persisted : (preQueryMs - defaultLookbackMs);
  // Clamp into [floor, preQueryMs]: never scan more than maxLookback (bounds a
  // long-outage catch-up) and never into the future (a corrupted/clock-skewed
  // bookmark self-corrects on the next clean pass instead of scanning nothing forever).
  return Math.min(Math.max(base, floor), preQueryMs);
}

/** The bookmark to persist AFTER a pass: advance to just-before-this-pass (minus
 *  an overlap) ONLY when the pass fully succeeded; otherwise keep the old value
 *  so the failed/mid-pass tasks are re-covered next time. Pure — unit tested. */
function nextWatermark({ preQueryMs, hadFailure, current, overlapMs = RECON_OVERLAP_MS }) {
  if (hadFailure) return (typeof current === 'number' && current > 0) ? current : 0;
  return Math.max(0, preQueryMs - overlapMs);
}

async function reconcileOnce() {
  const options = await optionMap();
  const preQueryMs = Date.now();                 // BEFORE the query — the safe new bookmark ceiling
  const state = await loadState(RECON_KEY);
  const current = state && typeof state.since_ms === 'number' ? state.since_ms : 0;
  const since = reconcileSince({ persisted: current, preQueryMs });
  const res = await clickup.getFilteredTeamTasks(cfg.clickupTeamId, {
    folderIds: PIPELINE_FOLDERS(), includeClosed: true, dateUpdatedGt: since, subtasks: true,
  });
  const tasks = (res && res.tasks) || [];
  let hadFailure = false;
  for (const t of tasks) {
    try {
      const full = t.custom_fields ? t : await clickup.getTask(t.id, { include: ['custom_fields'] });
      const read = mapper.readTaskFields(full, options);
      await ingest.ingestTask(full, options, { createFile: switches.on('CLICKUP_INBOUND_CREATE_FILES') && canMaterialize(read) });
    } catch (e) { hadFailure = true; console.error('[clickup] reconcile task failed', t.id, e.message); }
  }
  const advanced = nextWatermark({ preQueryMs, hadFailure, current });
  _watermark = advanced;                         // keep the in-process mirror for anything that reads it
  if (advanced !== current) await saveState(RECON_KEY, { since_ms: advanced });
  return tasks.length;
}

// True only when a ClickUp getTask failure means the task was DELETED (not a
// transient/network/auth error). A hard 404 is definitive. ClickUp occasionally
// returns 401 with a "Task not found" body for a deleted task, so we accept that
// narrowly — but never a blanket 401 (that's a bad token, which would 404-classify
// the whole portfolio). The reconcile circuit-breaker below is the second guard.
function isTaskDeletedError(e) {
  if (!e) return false;
  // WO-6 (F-M14): a genuinely deleted/nonexistent ClickUp task returns a hard
  // 404. A 401 means an AUTH problem (a bad, missing, or ROTATING token) —
  // ClickUp's "Authorization token not found" message previously matched the
  // deleted-task regex here, so a token rotation could misclassify live files as
  // orphans and (past the 50% breaker) archive them. Never treat a 401 as a
  // deletion: require the 404. A real deletion is always a 404.
  return e.status === 404;
}

// Best-effort system audit row (no request context; used by the sync worker).
async function auditSystem(action, appId, detail) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind,action,entity_type,entity_id,detail)
       VALUES ('system',$1,'application',$2,$3)`,
      [action, appId || null, detail ? JSON.stringify(detail) : null]);
  } catch (_) { /* audit best-effort */ }
}

// Resolve files whose linked ClickUp task was DELETED (a hard 404 seen during the
// reconcile pass). A ClickUp task that is deleted+recreated leaves the portal with
// a stale orphan (old task, now 404) AND a fresh file for the new task — a
// duplicate whose LLC/conditions live on the NEW file, so the orphan looks "empty"
// and reads as "the sync is broken."
//   • Orphan with a HEALTHY sibling (same borrower + same property by the SAME
//     normalizer the dedup uses, task confirmed live THIS run) → MERGE: re-point
//     the orphan's documents onto the sibling (nothing the borrower uploaded is
//     lost), then soft-archive the orphan (deleted_at + sync_state='dead'). It
//     drops out of every list + sync loop, ClickUp is untouched, fully reversible.
//   • No live sibling → flag 'manual_review' so a human decides — never silently
//     drop a borrower's only file for a property.
// `liveTaskIds` are the task ids confirmed present in the same run — the merge path
// REQUIRES one, so a global API/token outage (no live tasks) can never auto-archive
// anything.
async function resolveOrphans(orphans, liveTaskIds) {
  const identity = require('../clickup/identity');
  const q = (sql, p = []) => db.query(sql, p).then((r) => r.rows);
  const norm = (a) => { try { return identity.normalizeIdentity({ address: a || null }).address || null; } catch { return null; } };
  let archived = 0, merged = 0, flagged = 0;
  for (const o of orphans) {
    const oAddr = norm(o.one_line);
    let sibling = null;
    if (oAddr) {
      const sibs = await q(
        `SELECT id, property_address->>'oneLine' AS one_line, clickup_pipeline_task_id AS task_id
           FROM applications
          WHERE deleted_at IS NULL AND id <> $1 AND borrower_id = $2
            AND clickup_pipeline_task_id IS NOT NULL AND clickup_pipeline_task_id <> $3`,
        [o.id, o.borrower_id, o.task_id]);
      for (const s of sibs) {
        if (!liveTaskIds.has(String(s.task_id))) continue;   // sibling's own task must be live
        if (norm(s.one_line) === oAddr) { sibling = s; break; }
      }
    }
    const docs = (await q(`SELECT count(*)::int n FROM documents WHERE application_id=$1`, [o.id]))[0].n;
    if (sibling) {
      // Merge: re-point the orphan's documents onto the live sibling so nothing the
      // borrower uploaded is lost, detaching them from the orphan's now-archived
      // checklist items so they surface in the sibling's document vault. Then
      // soft-archive the orphan (reversible; ClickUp untouched).
      if (docs > 0) { await q(`UPDATE documents SET application_id=$2, checklist_item_id=NULL WHERE application_id=$1`, [sibling.id, o.id]); merged++; }
      const u = await q(
        `UPDATE applications SET deleted_at=now(), sync_state='dead', updated_at=now()
          WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [o.id]);
      if (u.length) { archived++; await auditSystem('clickup_orphan_merged', o.id, { task: o.task_id, superseded_by: sibling.id, movedDocs: docs }); }
    } else {
      const u = await q(
        `UPDATE applications SET sync_state='manual_review', updated_at=now()
          WHERE id=$1 AND deleted_at IS NULL AND sync_state <> 'manual_review' RETURNING id`, [o.id]);
      if (u.length) {
        flagged++; await auditSystem('clickup_orphan_flagged', o.id, { task: o.task_id, docs, reason: 'no_live_sibling' });
        // Owner-directed 2026-07-15 night: a stuck FILE goes to the review
        // queue with options, not only the Control Center. The reviewer
        // chooses: archive the file, or keep it (relink later).
        try {
          await require('../lib/sync-review').queueReview({
            applicationId: o.id, borrowerId: o.borrower_id || null, taskId: o.task_id,
            direction: 'inbound', fieldKey: 'file_link', reason: 'task_deleted_needs_decision',
            clickupValue: null, portalValue: o.one_line || null,
            rawValue: JSON.stringify({ deletedTask: o.task_id, docs }) });
        } catch (qe) { console.warn('[clickup-sync] orphan review skipped:', qe.message); }
      }
    }
  }
  return { archived, merged, flagged };
}

// ---- program reconcile + orphan sweep -------------------------------------
// WO-4b (F-H4): this used to re-ingest EVERY linked file on every boot — the
// other half of the deploy re-ingest storm (13 deploys/day × the whole
// portfolio). Now it processes a BOUNDED slice per pass, OLDEST-SNAPSHOT-FIRST,
// so the portfolio rotates through instead of being hammered all at once
// (mirrors retryStuckTasksOnce). A slow periodic tick (see start()) keeps the
// rotation going even when deploys are rare, and the client's token bucket (WO-2)
// paces the ClickUp calls.
const RECON_PROGRAMS_LIMIT = Math.max(1, parseInt(process.env.CLICKUP_RECONCILE_PROGRAMS_LIMIT || '150', 10) || 150);
const RECON_PROGRAMS_INTERVAL_SEC = Math.max(0, parseInt(process.env.CLICKUP_RECONCILE_PROGRAMS_INTERVAL_SEC || '900', 10) || 900); // 0 disables the periodic tick

/** Orphan-resolution safety breaker (preserves the prior inline semantics): a
 *  large 404 fraction — or NOTHING resolving live — is almost certainly an
 *  API/token outage, not mass task deletion, so we must NOT archive/merge this
 *  pass. Pure — unit tested. */
function shouldSkipOrphanResolution({ orphanCount, checked, liveCount }) {
  if (!orphanCount) return false;                    // nothing to resolve
  if (liveCount === 0) return true;                  // no task resolved live at all → outage, not deletions
  return orphanCount > Math.max(5, checked * 0.5);   // majority of a bounded slice 404'd → outage
}

// Re-check every LINKED, non-descoped RTL file against its CURRENT ClickUp task:
//   • program flipped to a non-RTL type (e.g. Short-Term Rehab → DSCR) → ingestTask
//     descopes it (removed from the portal, ClickUp untouched).
//   • ClickUp task DELETED (hard 404) → orphan-resolution (see resolveOrphans):
//     soft-archive a stale duplicate, or flag it for manual review.
// Bounded to already-linked files (cheap), idempotent (descoped/dead files are
// excluded next run), and read-only against ClickUp. Never creates or deletes
// anything in ClickUp. Reuses the getTask each linked file already makes, so
// orphan detection adds zero ClickUp API load.
async function reconcileLinkedProgramsOnce() {
  const r = await db.query(
    `SELECT a.id, a.clickup_pipeline_task_id AS task_id, a.borrower_id,
            a.property_address->>'oneLine' AS one_line
       FROM applications a
       LEFT JOIN clickup_task_index cti ON cti.task_id = a.clickup_pipeline_task_id
      WHERE a.clickup_pipeline_task_id IS NOT NULL AND a.deleted_at IS NULL
        AND a.sync_state NOT IN ('descoped','manual_review','dead')
      ORDER BY cti.snapshot_at ASC NULLS FIRST
      LIMIT $1`, [RECON_PROGRAMS_LIMIT]);   // WO-4b: bounded slice, least-recently-checked first (rotates)
  let checked = 0, descoped = 0;
  const orphans = [];               // files whose ClickUp task returned a hard 404
  const liveTaskIds = new Set();    // task ids confirmed present this run
  for (const row of r.rows) {
    try {
      const res = await ingestOne(row.task_id);
      checked++;
      liveTaskIds.add(String(row.task_id));
      if (res && res.matchStatus === 'descoped') descoped++;
      // Stamp heal for the EXISTING portfolio ("previous AND future" rule): a
      // task linked before the stamp switch-over existed may carry a stale or
      // missing "YS Portal File ID/Link" (e.g. a copied stamp from the
      // duplicate workflow). Enqueue the scoped stamp push once per boot pass;
      // the push's no-op suppression makes an already-correct stamp write-free,
      // so this converges to zero writes after the first healing pass.
      if (switches.on('CLICKUP_OUTBOUND_ENABLED') && res && res.applicationId) {
        try { await require('../clickup/enqueue').enqueueClickupPush(res.applicationId, ['portal_stamp']); } catch (_) {}
      }
    } catch (e) {
      if (isTaskDeletedError(e)) orphans.push(row);
      else console.error('[clickup] reconcile-programs task failed', row.task_id, e.message);
    }
  }
  // Re-examine files previously FLAGGED 'manual_review' — including orphans flagged
  // by an EARLIER build (before merge-on-heal existed), which the query above
  // excludes so they'd otherwise stay stuck forever. If such a file's task is now
  // confirmed deleted, treat it as an orphan so resolveOrphans can merge it into a
  // live sibling. We do NOT re-ingest these (that would clear a genuine ambiguous
  // flag) — only check task liveness (its live sibling is already in liveTaskIds
  // from the main loop above, which is what the merge path needs).
  const flagged = await db.query(
    `SELECT a.id, a.clickup_pipeline_task_id AS task_id, a.borrower_id,
            a.property_address->>'oneLine' AS one_line
       FROM applications a
      WHERE a.sync_state='manual_review' AND a.deleted_at IS NULL
        AND a.clickup_pipeline_task_id IS NOT NULL`);
  for (const row of flagged.rows) {
    if (liveTaskIds.has(String(row.task_id))) continue;   // its own task is live → genuinely ambiguous, leave it
    try { await clickup.getTask(row.task_id); liveTaskIds.add(String(row.task_id)); }
    catch (e) { if (isTaskDeletedError(e)) orphans.push(row); }
  }
  // Circuit-breaker: a large 404 fraction (or NO task resolving at all) is almost
  // certainly an API/token outage, not mass task deletion — do nothing this run.
  let orphan = { archived: 0, merged: 0, flagged: 0, skipped: 0 };
  if (shouldSkipOrphanResolution({ orphanCount: orphans.length, checked, liveCount: liveTaskIds.size })) {
    orphan.skipped = orphans.length;
    console.warn(`[clickup-sync] reconcile-programs: ${orphans.length}/${orphans.length + checked} tasks 404'd — treating as an API outage, skipping orphan resolution`);
  } else if (orphans.length) {
    orphan = { ...orphan, ...(await resolveOrphans(orphans, liveTaskIds)) };
  }
  console.log(`[clickup-sync] reconcile-programs: checked ${checked} linked files, descoped ${descoped}, orphans ${orphans.length} (archived ${orphan.archived}, merged-docs ${orphan.merged}, flagged ${orphan.flagged}, skipped ${orphan.skipped})`);
  return { checked, descoped, orphans: orphans.length, ...orphan };
}

// ---- historical backfill (one-shot, paced) --------------------------------
// folders: optional subset (e.g. one officer's pipeline folder for a self-serve
// re-sync); defaults to every configured pipeline folder.
async function runBackfill({ createFiles = true, pageLimit = 1000, folders = null } = {}) {
  const options = await optionMap();
  let total = 0;
  const folderList = (folders && folders.length) ? folders : PIPELINE_FOLDERS();
  for (const folder of folderList) {
    for (let page = 0; page < pageLimit; page++) {
      let res;
      try { res = await clickup.getFilteredTeamTasks(cfg.clickupTeamId, { folderIds: [folder], includeClosed: true, page, subtasks: true }); }
      catch (e) { console.error('[backfill] page failed', folder, page, e.message); break; }
      const tasks = (res && res.tasks) || [];
      if (!tasks.length) break;
      for (const t of tasks) {
        try {
          const full = t.custom_fields ? t : await clickup.getTask(t.id, { include: ['custom_fields'] });
          const read = mapper.readTaskFields(full, options);
          // folderId fallback: the per-folder loop knows the folder even if the
          // filtered task payload omits task.folder (officer resolution).
          await ingest.ingestTask(full, options, { createFile: createFiles && canMaterialize(read), folderId: folder });
          total++;
        } catch (e) { console.error('[backfill] task failed', t.id, e.message); }
      }
      if (tasks.length < 100) break; // last page
    }
  }
  console.log(`[backfill] ingested ${total} tasks`);
  // Verification summary (assignment + match outcomes) — no PII, safe to log.
  try {
    const s = await db.query(
      `SELECT count(*)::int linked, count(*) FILTER (WHERE loan_officer_id IS NOT NULL)::int assigned,
              count(DISTINCT loan_officer_id)::int distinct_officers
         FROM applications WHERE deleted_at IS NULL AND clickup_pipeline_task_id IS NOT NULL`);
    const mi = await db.query(`SELECT match_status, count(*)::int n FROM clickup_task_index WHERE match_status IS NOT NULL GROUP BY match_status ORDER BY n DESC`);
    const st = await db.query(`SELECT status, count(*)::int n FROM applications WHERE deleted_at IS NULL AND clickup_pipeline_task_id IS NOT NULL GROUP BY status ORDER BY n DESC`);
    console.log('[backfill] linked apps:', JSON.stringify(s.rows[0]));
    console.log('[backfill] match_status:', JSON.stringify(mi.rows));
    console.log('[backfill] borrower-status spread:', JSON.stringify(st.rows));
  } catch (e) { console.error('[backfill] summary failed', e.message); }
  return total;
}

// ---- data audit (portal vs ClickUp coverage; assignment; completeness) ----
// Runs server-side from the DB (applications + clickup_task_index snapshots) and
// logs a masked report so data quality can be verified from the logs. Answers:
// who's unassigned, what's missing, which ClickUp fields we're NOT capturing,
// and what long-term (non-RTL) data we preserved.
async function auditData() {
  const q = (sql, p = []) => db.query(sql, p).then((r) => r.rows).catch((e) => [{ error: e.message }]);
  const out = {};
  out.filesPerOfficer = await q(
    `SELECT COALESCE(loan_officer_name,'(unassigned)') officer, count(*)::int n
       FROM applications WHERE deleted_at IS NULL AND clickup_pipeline_task_id IS NOT NULL
      GROUP BY 1 ORDER BY n DESC`);
  out.unassignedByFolder = await q(
    `SELECT clickup_folder_id, count(*)::int n FROM applications
      WHERE deleted_at IS NULL AND clickup_pipeline_task_id IS NOT NULL AND loan_officer_id IS NULL
      GROUP BY 1 ORDER BY n DESC`);
  out.completeness = (await q(
    `SELECT count(*)::int total,
            count(*) FILTER (WHERE property_address IS NULL)::int no_address,
            count(*) FILTER (WHERE loan_amount IS NULL)::int no_loan_amount,
            count(*) FILTER (WHERE program IS NULL)::int no_program,
            count(*) FILTER (WHERE ys_loan_number IS NULL)::int no_ys_loan,
            count(*) FILTER (WHERE loan_officer_id IS NULL)::int no_officer,
            count(*) FILTER (WHERE internal_status IS NULL)::int no_status
       FROM applications WHERE deleted_at IS NULL AND clickup_pipeline_task_id IS NOT NULL`))[0];
  out.topUnmappedFields = await q(
    `SELECT k AS field, count(*)::int n FROM clickup_task_index, LATERAL jsonb_object_keys(snapshot->'unmapped') k
      WHERE snapshot ? 'unmapped' GROUP BY k ORDER BY n DESC LIMIT 30`);
  out.nonRtlPrograms = await q(
    `SELECT COALESCE(program,'(none)') program, count(*)::int n FROM clickup_task_index
      WHERE kind='data_only' GROUP BY 1 ORDER BY n DESC LIMIT 30`);
  out.matchStatus = await q(`SELECT match_status, count(*)::int n FROM clickup_task_index WHERE match_status IS NOT NULL GROUP BY 1 ORDER BY n DESC`);
  out.ambiguous = await q(`SELECT task_id, task_name FROM clickup_task_index WHERE match_status='ambiguous' LIMIT 25`);
  out.snapshotsStored = (await q(`SELECT count(*)::int n FROM clickup_task_index WHERE snapshot IS NOT NULL`))[0];
  // ---- reconciliation diagnostics (portal vs ClickUp RTL SHORT MTM dashboard) ----
  // Raw ClickUp status distribution for the linked RTL files, so we can map the
  // portal's counts onto ClickUp's own dashboard buckets (which filter on raw
  // statuses / status-type) and reverse-engineer its 30-active / 96-funded rule.
  out.rtlInternalStatus = await q(
    `SELECT COALESCE(internal_status,'(none)') st, count(*)::int n FROM applications
      WHERE deleted_at IS NULL AND clickup_pipeline_task_id IS NOT NULL GROUP BY 1 ORDER BY n DESC`);
  // Raw status of data_only (blank / non-RTL *Program) tasks. A FUNDED status here
  // is a likely "missing funded" the ClickUp RTL dashboard counts but the portal
  // skipped for lack of a recognized RTL program label.
  out.dataOnlyStatus = await q(
    `SELECT COALESCE(snapshot->>'status','(none)') st, count(*)::int n FROM clickup_task_index
      WHERE kind='data_only' GROUP BY 1 ORDER BY n DESC LIMIT 40`);
  // Hard proof the address fix landed: linked files whose property_address is the
  // NORMALIZED shape (has oneLine) vs still-raw vs blank.
  out.addressShape = (await q(
    `SELECT count(*) FILTER (WHERE property_address ? 'oneLine')::int normalized,
            count(*) FILTER (WHERE property_address IS NOT NULL AND NOT (property_address ? 'oneLine'))::int raw_or_other,
            count(*) FILTER (WHERE property_address IS NULL)::int none
       FROM applications WHERE deleted_at IS NULL AND clickup_pipeline_task_id IS NOT NULL`))[0];
  // Funded files still awaiting an actual closing date (K1: the "funded, no date yet" bucket).
  out.fundedDateCoverage = (await q(
    `SELECT count(*) FILTER (WHERE status='funded')::int funded_total,
            count(*) FILTER (WHERE status='funded' AND actual_closing IS NULL)::int funded_no_date,
            count(*) FILTER (WHERE status='funded' AND actual_closing IS NOT NULL)::int funded_dated
       FROM applications WHERE deleted_at IS NULL`))[0];
  // The EXACT data_only FUNDED files that are missing a *Program in ClickUp but
  // carry RTL signals (ARV / rehab budget / rehab type) — the concrete candidates
  // behind the portal-vs-ClickUp funded-count gap. Listed with name + address so
  // they can be opened in ClickUp and verified.
  const FUNDED_RAW = `('closed reconciled','closed (6-email funded)','non del closed reconciled','refinanced','waiting for final docs','in purchase review','purchase conditions','pa issued-post closing.')`;
  out.rtlFundedMissingProgram = await q(
    `SELECT task_id, task_name,
            snapshot->>'status' AS status,
            NULLIF(snapshot->'app'->>'arv','') AS arv,
            NULLIF(snapshot->'app'->>'rehab_budget','') AS rehab_budget,
            NULLIF(snapshot->'app'->>'rehab_type','') AS rehab_type,
            NULLIF(snapshot->'app'->>'loan_type','') AS loan_type,
            NULLIF(snapshot->'app'->>'dscr_ratio','') AS dscr_ratio
       FROM clickup_task_index
      WHERE kind='data_only'
        AND lower(btrim(COALESCE(snapshot->>'status',''))) IN ${FUNDED_RAW}
        AND (snapshot->>'rawProgram') IS NULL
        AND (NULLIF(snapshot->'app'->>'arv','') IS NOT NULL
             OR NULLIF(snapshot->'app'->>'rehab_budget','') IS NOT NULL
             OR NULLIF(snapshot->'app'->>'rehab_type','') IS NOT NULL)
      ORDER BY task_name LIMIT 40`);
  // Breakdown of ALL data_only funded files by their *Program label (blank vs
  // DSCR/non-QM), + how many of each carry an RTL signal — sizes the whole gap.
  out.dataOnlyFundedByProgram = await q(
    `SELECT COALESCE(NULLIF(snapshot->>'rawProgram',''),'(blank program)') raw_program, count(*)::int n,
            count(*) FILTER (WHERE NULLIF(snapshot->'app'->>'arv','') IS NOT NULL
                                OR NULLIF(snapshot->'app'->>'rehab_budget','') IS NOT NULL)::int with_rtl_signal
       FROM clickup_task_index
      WHERE kind='data_only' AND lower(btrim(COALESCE(snapshot->>'status',''))) IN ${FUNDED_RAW}
      GROUP BY 1 ORDER BY n DESC LIMIT 30`);
  console.log('[audit] ' + JSON.stringify(out));
  return out;
}

// ---- field-value diff audit (portal value vs live ClickUp value) ----------
// Re-reads each linked task from ClickUp and compares field-by-field with the
// stored portal value — surfaces transformation bugs, stale data, and fields
// present in ClickUp but missing in the portal (and vice-versa). Read-only.
async function auditFieldDiff({ limit = 120 } = {}) {
  const options = await optionMap();
  const apps = await db.query(
    `SELECT id, clickup_pipeline_task_id, clickup_folder_id, program, loan_type, property_type, loan_amount,
            purchase_price, arv, rehab_budget, ys_loan_number, lender, term, units, occupancy, internal_status, status
       FROM applications WHERE deleted_at IS NULL AND clickup_pipeline_task_id IS NOT NULL
      ORDER BY updated_at DESC LIMIT $1`, [limit]).then((r) => r.rows).catch(() => []);
  const NUM = new Set(['loan_amount', 'purchase_price', 'arv', 'rehab_budget', 'units']);
  const FIELDS = ['program', 'loan_type', 'property_type', 'occupancy', 'loan_amount', 'purchase_price', 'arv', 'rehab_budget', 'ys_loan_number', 'lender', 'term', 'units', 'internal_status'];
  const mismatch = {}, missingPortal = {}, missingClickup = {}, samples = [];
  let checked = 0, folderMismatch = 0, taskErr = 0;
  for (const app of apps) {
    let task; try { task = await clickup.getTask(app.clickup_pipeline_task_id); } catch { taskErr++; continue; }
    const read = mapper.readTaskFields(task, options);
    checked++;
    const cuFolder = task.folder && task.folder.id;
    if (cuFolder && app.clickup_folder_id && String(cuFolder) !== String(app.clickup_folder_id)) folderMismatch++;
    for (const f of FIELDS) {
      const pv = f === 'internal_status' ? app.internal_status : app[f];
      const cv = f === 'internal_status' ? read.internalStatus : read.app[f];
      const P = pv == null || pv === '' ? null : String(pv);
      const C = cv == null || cv === '' ? null : String(cv);
      if (C != null && P == null) { missingPortal[f] = (missingPortal[f] || 0) + 1; continue; }
      if (C == null && P != null) { missingClickup[f] = (missingClickup[f] || 0) + 1; continue; }
      if (P != null && C != null && P !== C) {
        if (NUM.has(f) && Math.abs(Number(P) - Number(C)) < 1) continue;   // numeric rounding
        mismatch[f] = (mismatch[f] || 0) + 1;
        if (samples.length < 20) samples.push({ field: f, portal: P.slice(0, 40), clickup: C.slice(0, 40), task: app.clickup_pipeline_task_id });
      }
    }
  }
  const out = { checked, taskErr, folderMismatch, mismatch, missingPortal, missingClickup, samples };
  console.log('[audit-diff] ' + JSON.stringify(out));
  return out;
}

// ---- dry-run backfill (READ-ONLY validation, zero DB writes) --------------
// Fetches a sample of real tasks per folder, runs the mapper, and reports what
// WOULD happen — for validating the mapping/identity graph before enabling sync.
async function dryRunBackfill({ samplePerFolder = 8 } = {}) {
  const options = await optionMap();
  const stats = { folders: 0, tasksSeen: 0, rtl: 0, dataOnly: 0, materializable: 0, withSSN: 0, withLLC: 0, programs: {}, samples: [] };
  for (const folder of PIPELINE_FOLDERS()) {
    stats.folders++;
    let res;
    try { res = await clickup.getFilteredTeamTasks(cfg.clickupTeamId, { folderIds: [folder], includeClosed: true, subtasks: true }); }
    catch (e) { continue; }
    const tasks = ((res && res.tasks) || []).slice(0, samplePerFolder);
    for (const t of tasks) {
      try {
        const full = t.custom_fields ? t : await clickup.getTask(t.id, { include: ['custom_fields'] });
        const read = mapper.readTaskFields(full, options);
        stats.tasksSeen++;
        const prog = read.app.program || '(none)';
        stats.programs[prog] = (stats.programs[prog] || 0) + 1;
        const isRtl = read.app.program && ingest.RTL_PROGRAMS.has(read.app.program);
        if (isRtl) stats.rtl++; else stats.dataOnly++;
        if (canMaterialize(read)) stats.materializable++;
        if (read.borrower.ssn) stats.withSSN++;
        if (read.llc.llc_name) stats.withLLC++;
        if (stats.samples.length < 12) stats.samples.push({
          task: full.id, status: read.internalStatus, external: statusMap.externalFor(read.internalStatus),
          program: read.app.program, loan_type: read.app.loan_type, property_type: read.app.property_type,
          loan_amount: read.app.loan_amount, arv: read.app.arv, ys_loan: read.app.ys_loan_number,
          borrower: `${read.borrower.first_name || ''} ${read.borrower.last_name || ''}`.trim(),
          hasSSN: !!read.borrower.ssn, llc: read.llc.llc_name || null, lender: read.app.lender || null,
          extraKeys: Object.keys(read.extra).length,
        });
      } catch (e) { /* skip */ }
    }
  }
  return stats;
}

// ---- loops ----------------------------------------------------------------
// ---- one-shot: link staff to their ClickUp user id by email (#89) ----------
// The db/045 backfill linked only 18 named staffers; anyone created since (esp.
// PROCESSORS) has a NULL clickup_user_id, so their officer/processor field never
// syncs OUTBOUND (the mapper omits a null-id users field). Fill (never overwrite)
// the id from the live workspace members, matched by email — so PREVIOUS files pick
// up their officer/processor on the next push/reconcile, and every FUTURE assignment
// resolves too. Idempotent, bounded (one API call + one UPDATE per unlinked staffer),
// best-effort. "Previous and future" per the repo rule.
async function backfillMemberLinksOnce() {
  const byEmail = new Map();
  try {
    const data = await clickup.getTeams();
    for (const team of (data && data.teams) || []) {
      if (String(team.id) !== String(cfg.clickupTeamId)) continue;
      for (const m of (team.members || [])) {
        const u = m.user || {};
        if (u.email && u.id != null) byEmail.set(String(u.email).toLowerCase(), Number(u.id));
      }
    }
  } catch (e) { console.error('[clickup-sync] member-link backfill: member fetch failed', e.message); return 0; }
  if (!byEmail.size) return 0;
  const staff = await db.query(
    `SELECT id, email FROM staff_users WHERE clickup_user_id IS NULL AND email IS NOT NULL AND is_active=true`);
  let linked = 0;
  for (const s of staff.rows) {
    const cu = byEmail.get(String(s.email).toLowerCase());
    if (cu == null) continue;
    const r = await db.query(
      `UPDATE staff_users SET clickup_user_id=$2 WHERE id=$1 AND clickup_user_id IS NULL`, [s.id, cu]
    ).catch(() => ({ rowCount: 0 }));
    if (r.rowCount) linked++;
  }
  if (linked) console.log(`[clickup-sync] member-link backfill: linked ${linked} staffer(s) to ClickUp by email`);
  return linked;
}

function start() {
  // Stage 0 — DRY-RUN validation boot mode. Read-only: fetch a sample of real
  // tasks, run the mapper, and dump what WOULD happen to the logs. Runs even
  // when the master switch is off (it writes nothing), so the mapping/identity
  // graph can be validated against production ClickUp before anything is live.
  if (cfg.clickupRunDryrun) {
    if (!cfg.clickupToken) { console.log('[clickup-sync] DRY-RUN requested but CLICKUP_API_TOKEN not set'); return; }
    console.log('[clickup-sync] DRY-RUN starting (read-only, no writes)…');
    dryRunBackfill({ samplePerFolder: 8 })
      .then((s) => console.log('[clickup-sync] DRY-RUN result:', JSON.stringify(s, null, 2)))
      .catch((e) => console.error('[clickup-sync] DRY-RUN failed', e.message));
    return; // validation-only boot; do not start the live loops
  }

  if (!switches.on('CLICKUP_SYNC_ENABLED')) { console.log('[clickup-sync] disabled (CLICKUP_SYNC_ENABLED!=1)'); return; }
  console.log('[clickup-sync] worker started');

  // Warm the dropdown-option cache immediately so outbound pushes for already-
  // linked tasks resolve dropdown option ids from the first tick (the cache is
  // space-level and shared; without this, the first ~poll-interval of linked
  // pushes silently dropped dropdown fields).
  optionMap().then(() => console.log('[clickup-sync] option cache warmed'))
    .catch((e) => console.error('[clickup-sync] option cache warm failed', e.message));

  // WO-4b (F-M16): prime the volume breaker from the durable write journal so a
  // deploy/restart mid-storm doesn't reset it to zero. Best-effort, before any
  // outbound drain starts.
  orchestrator.seedBreakerFromDb().catch(() => {});

  // Link any not-yet-linked staff (esp. processors created after the db/045 backfill)
  // to their ClickUp user id by email, so their officer/processor assignment syncs
  // outbound (#89). One-shot, best-effort; the push path also self-heals per-staffer.
  backfillMemberLinksOnce().catch((e) => console.error('[clickup-sync] member-link backfill', e.message));

  // Stage 1 — one-shot inbound backfill on boot (identity graph, and RTL files
  // when mode='full'). Inbound only; writes to the portal, never to ClickUp.
  if (cfg.clickupRunBackfill) {
    const createFiles = cfg.clickupRunBackfill === 'full';
    console.log(`[clickup-sync] boot backfill (mode=${cfg.clickupRunBackfill}, createFiles=${createFiles})…`);
    runBackfill({ createFiles })
      .then((n) => console.log('[clickup-sync] boot backfill ingested', n))
      .catch((e) => console.error('[clickup-sync] boot backfill', e.message));
  }

  // One-shot data audit on boot (CLICKUP_RUN_AUDIT=1) — logs the coverage /
  // assignment / completeness report after any backfill has had time to run.
  if (cfg.clickupRunAudit) {
    setTimeout(() => {
      auditData()
        .catch((e) => console.error('[audit]', e.message))
        .then(() => auditFieldDiff({ limit: 120 }))
        .catch((e) => console.error('[audit-diff]', e.message));
    }, cfg.clickupRunBackfill ? 60000 : 3000);
  }

  // One-shot program reconcile: descope any file whose ClickUp program was flipped
  // to a non-RTL type (e.g. Short-Term Rehab → DSCR) before the descope logic
  // existed or outside the reconcile poll's window. Portal-only, ClickUp untouched,
  // idempotent. Delayed so the option cache + any boot backfill settle first.
  setTimeout(() => {
    reconcileLinkedProgramsOnce()
      .catch((e) => console.error('[clickup-sync] reconcile-programs', e.message))
      // The mismatch audit reads each task's LAST-INGEST snapshot, so it runs
      // after the reconcile pass above has refreshed them portfolio-wide.
      .then(() => auditIdentityMismatchesOnce())
      .catch((e) => console.error('[clickup-sync] identity mismatch audit', e.message))
      // Shared-email pairs ride the same chain: after the audit has refreshed
      // the picture, every open pair gets its "assign this email to ONE
      // borrower" card (and resolved pairs auto-close).
      .then(() => sharedEmailReviewSweepOnce())
      .catch((e) => console.error('[clickup-sync] shared-email sweep', e.message));
    // AFTER the reconcile pass (which links files to their EXISTING tasks by
    // identity), give any still-unlinked recent portal file its one bounded
    // create retry — the recovery path for a failed create-at-file-start.
    // Files that CANNOT sync (no task, older than the recovery window) become
    // visible review rows with a "create the task" option — chained so it
    // truly runs AFTER the recovery pass has had its chance to link/create
    // the recent ones (their age windows are disjoint, but keep it ordered).
    recoverUnlinkedFilesOnce()
      .catch((e) => console.error('[clickup-sync] unlinked-recovery', e.message))
      .then(() => flagUnsyncableFilesOnce())
      .catch((e) => console.error('[clickup-sync] unsyncable sweep', e.message))
      // Orphaned-but-live files ('dead'/'manual_review', no card) → review queue
      // with a relink option (the disjoint other half of the unsyncable sweep).
      .then(() => flagDeadUnlinkedFilesOnce())
      .catch((e) => console.error('[clickup-sync] dead-unlinked sweep', e.message));
    // And re-drive every NON-materialized task ('ambiguous'/'duplicate_pending')
    // through the current resolver, so a root-cause fix (like copied-loan-number
    // handling) heals the entire stuck backlog on deploy — not only the tasks
    // that happen to receive a new webhook.
    retryStuckTasksOnce().catch((e) => console.error('[clickup-sync] stuck-task retry', e.message));
    // WO-3 (F-M6): re-attempt any terminally-failed inbound webhook rows so a
    // transient/ since-fixed failure self-heals instead of silently dropping a
    // ClickUp update forever.
    redriveInboxErrorsOnce().catch((e) => console.error('[clickup-sync] inbox re-drive', e.message));
  }, cfg.clickupRunBackfill ? 120000 : 15000);

  // Review-queue upkeep (mega-audit enhancements #2/#5): the aging sweep
  // re-notifies/escalates stale open rows; the digest self-gates to weekly.
  // Boot pass + daily cadence; both best-effort and cheap.
  const reviewUpkeep = () => {
    const R = require('../lib/sync-review');
    R.remindStaleReviewsOnce().catch((e) => console.error('[clickup-sync] review aging', e.message));
    R.sendReviewDigestOnce().catch((e) => console.error('[clickup-sync] review digest', e.message));
  };
  setTimeout(reviewUpkeep, 60000);
  setInterval(reviewUpkeep, 24 * 3600 * 1000).unref();

  const tick = async (fn, name) => { try { while (await fn()) { /* drain */ } } catch (e) { console.error(`[clickup-sync] ${name}`, e.message); } };

  // Inbound loops (ClickUp → portal) always run when the master switch is on —
  // the portal is the mirror, so pulling is always safe.
  console.log('[clickup-sync] inbound ' +
    (switches.on('CLICKUP_INBOUND_CREATE_FILES')
      ? 'materializes new RTL loan files (CLICKUP_INBOUND_CREATE_FILES=1)'
      : 'identity-graph + linked-file updates only — new-file creation OFF (CLICKUP_INBOUND_CREATE_FILES!=1)'));
  setInterval(() => tick(processInboxOnce, 'inbox'), 4000);
  setInterval(() => { reconcileOnce().catch((e) => console.error('[clickup-sync] reconcile', e.message)); }, (cfg.clickupPollSec || 300) * 1000);
  // WO-4b: keep the bounded program reconcile ROTATING on a slow cadence, so
  // bounding the boot pass doesn't leave the tail of the portfolio unchecked
  // when deploys are rare. Each tick processes the next oldest-snapshot slice;
  // the token bucket paces the ClickUp calls. Set the interval to 0 to disable.
  if (RECON_PROGRAMS_INTERVAL_SEC > 0) {
    setInterval(() => { reconcileLinkedProgramsOnce().catch((e) => console.error('[clickup-sync] reconcile-programs (periodic)', e.message)); }, RECON_PROGRAMS_INTERVAL_SEC * 1000).unref();
  }

  // Stage 2 — outbound loops (portal → ClickUp writes) are gated separately so
  // inbound/backfill can run and be validated first, before the portal is
  // allowed to write to production ClickUp.
  if (switches.on('CLICKUP_OUTBOUND_ENABLED')) {
    // SAFETY (post-incident): outbound pushes ONLY changes explicitly enqueued by a
    // staff edit in the portal (enqueue-on-write). The old "dirty sweep" auto-pushed
    // ANY file whose updated_at moved — including files just re-ingested FROM ClickUp
    // (a round-trip), which overwrote ClickUp with the portal's mapped/synthetic
    // values and looped. The sweep is intentionally NOT started; only the queue
    // drain runs, so nothing reaches ClickUp unless a human changed it in the portal.
    console.log('[clickup-sync] outbound writes ENABLED — enqueue-on-write ONLY (no auto-sweep)');
    setInterval(() => tick(pushOutboxOnce, 'push'), 3000);
  } else {
    console.log('[clickup-sync] outbound writes DISABLED (CLICKUP_OUTBOUND_ENABLED!=1) — inbound/reconcile only');
  }
}

module.exports = { start, pushOutboxOnce, sweepDirtyOnce, processInboxOnce, redriveInboxErrorsOnce, ingestOne, reconcileOnce, reconcileLinkedProgramsOnce, recoverUnlinkedFilesOnce, retryStuckTasksOnce, flagUnsyncableFilesOnce, flagDeadUnlinkedFilesOnce, auditIdentityMismatchesOnce, sharedEmailReviewSweepOnce, runBackfill, dryRunBackfill, auditData, auditFieldDiff, backfillMemberLinksOnce, canMaterialize, PIPELINE_FOLDERS,
  reconcileSince, nextWatermark, // WO-4: exported for the durable-watermark test
  isTaskDeletedError, // WO-6: exported for the token-rotation-safety test
  shouldSkipOrphanResolution }; // WO-4b: exported for the orphan-breaker test
