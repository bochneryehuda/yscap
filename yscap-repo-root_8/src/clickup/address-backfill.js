'use strict';

/**
 * ADDRESS BACKFILL — put the subject property (and the borrower's home) address
 * on the ClickUp cards that never got one.
 *
 * WHY THIS EXISTS (owner-reported 2026-07-28, file YSCAP258134791 / card
 * FILLE-1990 "MOSES WEIL"): the file was opened in PILOT with a subject property
 * address, everything else on the card synced — borrower name, SSN, DOB, FICO,
 * LLC, purchase price, as-is value, the push-only "Date File Submitted" — and
 * BOTH `location` fields, "*Subject Property Address" and "*Borrower Address",
 * were empty.
 *
 * ROOT CAUSE, in two parts:
 *   1. Until 2026-07-26 `orchestrator.withCoords` called `require('../lib/address')
 *      .geocode` — a function that never existed on that module. No address ever
 *      gained coordinates, and a ClickUp `location` field REQUIRES them
 *      (mapper.addressField correctly refuses to write one without lat/lng), so
 *      both fields were silently dropped from every push. That is fixed at the
 *      source (lib/address-canon.geocode).
 *   2. THE FIX WAS GO-FORWARD ONLY, which is what left this card blank. Outbound
 *      is enqueue-on-write ONLY — there is deliberately no dirty sweep — so a
 *      field re-pushes when a human EDITS it, and nobody edits an address that is
 *      already correct in PILOT. `lib/address-heal` repairs the stored FORMAT of
 *      an address but never re-pushes it. So every file pushed before the fix
 *      keeps a blank address on its card forever. That breaks the "previous AND
 *      future" rule: a fix has to reach the files that are already broken.
 *
 * This is that pass. It also covers the go-forward hole the same root leaves
 * behind: if the geocoder is unreachable at the moment a file is created, the
 * create push drops the address and nothing would ever try again — so the sweep
 * keeps cycling rather than running once.
 *
 * SAFETY — it can only ever ADD:
 *   • it READS the card first and enqueues only the fields that are BLANK there;
 *   • the push itself runs with `fillOnly`, so even if someone types a value into
 *     ClickUp between our read and the write, the orchestrator skips the field
 *     rather than overwriting it. "*Borrower Address" is a PII-shielded identity
 *     field, and a repair sweep must never be able to clobber one;
 *   • it never creates a task (a scoped push structurally cannot), never renames
 *     one, never deletes anything, and never touches any other field;
 *   • an address the geocoder cannot resolve simply isn't pushed — exactly as
 *     before, never a bad or location-clearing write.
 *
 * It is bounded (a few files a tick), resumable from a durable cursor, and rests
 * between cycles, so it stays far under ClickUp's rate limit and never competes
 * with the live reconcile/push loops.
 */
const db = require('../db');
const switches = require('../lib/integrations/switches');
const clickup = require('./client');
const mapper = require('./mapper');
const F = require('./fields');

const STATE_KEY = 'clickup_address_backfill';

// How much work one tick does. Each file costs ONE getTask read, plus at most two
// field writes on the files that are actually missing an address.
const FILES_PER_TICK = Math.max(1, parseInt(process.env.CLICKUP_ADDRESS_BACKFILL_FILES || '25', 10) || 25);
// Rest between full passes. The pass exists to catch what never CHANGES (the
// live queue already handles every edit), so it is deliberately slow.
const CYCLE_DAYS = Math.max(1, parseInt(process.env.CLICKUP_ADDRESS_BACKFILL_CYCLE_DAYS || '7', 10) || 7);
// A pass that read nothing and errored means ClickUp was unreachable, not that
// every card is fine — retry in minutes rather than serving the full rest.
const FAILED_RETRY_MS = 15 * 60 * 1000;

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

async function loadState() {
  try {
    const r = await db.query(`SELECT value FROM sync_runtime_state WHERE key=$1`, [STATE_KEY]);
    return (r.rows[0] && r.rows[0].value) || null;
  } catch (_) { return null; }   // table missing / DB blip → behave like no bookmark
}
async function saveState(value) {
  try {
    await db.query(
      `INSERT INTO sync_runtime_state (key, value, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [STATE_KEY, JSON.stringify(value)]);
  } catch (_) { /* a lost bookmark only means we re-walk — never fatal */ }
}

/** A fresh cursor at the start of the file list (oldest first — those are the
 *  files the broken geocoder pushed, so they get repaired first). */
const freshCursor = (cycle) => ({
  cycle, afterCreatedAt: '-infinity', afterId: NIL_UUID,
  startedAt: new Date().toISOString(), finishedAt: null,
  checked: 0, filled: 0, unresolved: 0, errors: 0,
});

/**
 * Which scoped-push keys does this file need? PURE — the whole decision, so the
 * "only ever fill a blank" rule is unit-testable without ClickUp or a DB.
 *
 * `subject`/`home` are the values ClickUp currently holds for the two location
 * fields; `hasSubject`/`hasHome` say whether PILOT actually has an address to
 * offer. We ask for a field ONLY when PILOT has one and the card does not.
 */
function pushKeysFor({ subject, home, hasSubject, hasHome }) {
  const keys = [];
  if (hasSubject && mapper.isBlankClickupValue(subject)) keys.push('property_address');
  if (hasHome && mapper.isBlankClickupValue(home)) keys.push('current_address');
  return keys;
}

/** The two location values off a fetched task, by field id. */
function locationValues(task) {
  const out = { subject: null, home: null };
  for (const c of (task && task.custom_fields) || []) {
    if (c.id === F.PIPELINE.subjectAddress) out.subject = c.value;
    else if (c.id === F.SHARED.borrowerAddress) out.home = c.value;
  }
  return out;
}

/** The next slice of linked, live files that HAVE an address in PILOT. */
async function candidates(st, limit) {
  const r = await db.query(
    `SELECT a.id, a.created_at, a.clickup_pipeline_task_id AS task_id,
            (a.property_address IS NOT NULL) AS has_subject,
            (b.current_address IS NOT NULL) AS has_home
       FROM applications a
       JOIN borrowers b ON b.id = a.borrower_id
      WHERE a.clickup_pipeline_task_id IS NOT NULL
        AND a.deleted_at IS NULL
        AND (a.property_address IS NOT NULL OR b.current_address IS NOT NULL)
        AND (a.created_at, a.id) > ($1::timestamptz, $2::uuid)
      ORDER BY a.created_at, a.id
      LIMIT $3`,
    [st.afterCreatedAt, st.afterId, limit]);
  return r.rows;
}

/**
 * Do ONE bounded slice. Returns a small progress object; never throws.
 * Idempotent: a file whose card already carries both addresses is a read and
 * nothing more, so an overlapping tick costs a wasted read at worst.
 */
async function sweepOnce({ files = FILES_PER_TICK } = {}) {
  if (!switches.on('CLICKUP_SYNC_ENABLED')) return { skipped: 'sync_disabled' };
  if (!switches.on('CLICKUP_OUTBOUND_ENABLED')) return { skipped: 'outbound_disabled' };
  if (process.env.CLICKUP_ADDRESS_BACKFILL_DISABLED === '1') return { skipped: 'disabled' };

  let st = await loadState();
  if (!st || !st.startedAt) {
    st = freshCursor(1);
  } else if (st.finishedAt) {
    const restMs = st.failed ? FAILED_RETRY_MS : CYCLE_DAYS * 24 * 3600 * 1000;
    if (Date.now() - Date.parse(st.finishedAt) < restMs) {
      return { idle: true, cycle: st.cycle, finishedAt: st.finishedAt, failed: !!st.failed };
    }
    st = freshCursor((st.cycle || 0) + 1);
  }

  let rows;
  try {
    rows = await candidates(st, files);
  } catch (e) {
    console.error('[clickup-address-backfill] candidate query failed', e && e.message);
    return { error: String(e && e.message).slice(0, 200) };
  }

  if (!rows.length) {
    // The pass is done. `failed` records that it saw nothing but errors, so the
    // next cycle comes in minutes instead of a week.
    st.finishedAt = new Date().toISOString();
    st.failed = st.checked === 0 && st.errors > 0;
    await saveState(st);
    return { done: true, cycle: st.cycle, checked: st.checked, filled: st.filled, unresolved: st.unresolved, errors: st.errors };
  }

  const orchestrator = require('./orchestrator');   // lazy: keeps this unit-testable
  let filled = 0;
  for (const row of rows) {
    st.afterCreatedAt = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
    st.afterId = row.id;
    st.checked++;
    try {
      const task = await clickup.getTask(row.task_id);
      const { subject, home } = locationValues(task);
      const keys = pushKeysFor({ subject, home, hasSubject: row.has_subject, hasHome: row.has_home });
      if (!keys.length) continue;
      // fillOnly: even with the read above, the orchestrator re-checks each field
      // against its own pre-write read and refuses to replace anything.
      const out = await orchestrator.pushApplication(row.id, { only: keys, fillOnly: true });
      if (out && out.written) { filled++; st.filled++; }
      // Written 0 with fields offered means the geocoder could not place the
      // address (mapper.addressField refuses a location with no coordinates).
      // Nothing was written and nothing was harmed; the next cycle tries again.
      else st.unresolved++;
    } catch (e) {
      st.errors++;
      console.error('[clickup-address-backfill] file failed', row.id, e && e.message);
    }
  }
  await saveState(st);
  return { cycle: st.cycle, batch: rows.length, filled, checked: st.checked, unresolved: st.unresolved, errors: st.errors };
}

module.exports = {
  sweepOnce, pushKeysFor, locationValues,
  STATE_KEY, FILES_PER_TICK, CYCLE_DAYS,
};
