'use strict';
/**
 * src/sync/elementix-crm-sync.js — keep the CRM in step with Elementix, by itself.
 *
 * ── WHAT THE OWNER ASKED FOR ────────────────────────────────────────────────
 * "It should run a refresh for all the users' entire time. Every contact that a
 * user unlocks should be added to this user as a lead in his CRM system,
 * assigned to his login… and set this previous run up for PILOT to run
 * automatically once it gets deployed."
 *
 * So there are two jobs and they are the SAME two the admin screen runs by hand,
 * on a timer — not a second implementation. Reusing `backfill.js` is the point:
 * a scheduled pass and a human's click must not be able to disagree about what
 * an import does.
 *
 *   LIST  — ask Elementix which contacts the office has unlocked. Anything new
 *           since last time (including work done in Elementix's own screens,
 *           which is most of it) joins the queue.
 *   WORK  — read each queued contact and hand it to the officer whose login
 *           unlocked it, as a lead.
 *
 * ── WHY THIS IS SAFE TO LEAVE RUNNING ───────────────────────────────────────
 * NOTHING HERE CAN SPEND A CREDIT. `submit_contact_enrichment` is not reachable
 * from backfill.js at all: every person in the queue is already unlocked, so the
 * contact read is free. That is what makes an unattended loop acceptable — the
 * worst case is calls against a rate limit, never money.
 *
 * It is BOUNDED and RESUMABLE by construction: the queue is a table with a
 * status per row, so a pass that stops mid-way loses nothing and the next one
 * carries on. And it is quiet — a pass with nothing to do writes nothing and
 * says nothing.
 *
 * ON BY DEFAULT (owner-directed 2026-08-19, "set up auto pull leads").
 * `ELEMENTIX_CRM_SYNC_ENABLED=0` turns the bulk import off, and it is a real
 * switch on the API Health page read at CALL time — so it can be stopped and
 * started without a deploy. Until the roster of Elementix logins is mapped to
 * officers the import still runs: it imports every contact and parks the ones
 * whose login nobody has claimed, which the Elementix screen shows and offers a
 * dropdown for.
 */

const cfg = require('../config');
const client = require('../elementix/client');
const flags = require('../lib/flags');

const envSec = (k, dflt) => {
  const n = parseInt(process.env[k] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

/* THE AUTO-IMPORT IS READ AT CALL TIME, NOT AT BOOT — the same rule every other
   integration switch here follows. Read once in `start()`, a flip on the API
   Health page would do nothing until the next deploy: the timers were never
   armed, so there was nothing to turn back on. Now the timers always run and
   each pass asks the switch, which means an owner can stop the import the moment
   it is doing something they did not want, and start it again with one click. */
const autoImportOn = () => flags.enabled('ELEMENTIX_CRM_SYNC_ENABLED', cfg.elementix.crmSync);

/* The LIST is cheap (a handful of calls) but there is no point asking often —
   an unlock made a few hours ago is not urgent, and the office's hourly
   allowance is shared with everything else PILOT does. */
const LIST_INTERVAL_MS = envSec('ELEMENTIX_CRM_LIST_SEC', 6 * 3600) * 1000;
/* The WORK pass is where the volume is: one free read per person, and the first
   run has ~1,000 of them. Small batches, often, so it drains over a day or two
   without ever being the reason somebody else's lookup is rate-limited. */
const WORK_INTERVAL_MS = envSec('ELEMENTIX_CRM_WORK_SEC', 300) * 1000;
const WORK_BATCH = envSec('ELEMENTIX_CRM_WORK_BATCH', 20);

/* THE SETTLE PASS — the second half of a click somebody already made.
   `crm.skipTrace` waits about six seconds for the vendor's enrichment job; a
   job that takes longer is recorded `pending` AND THE CREDIT IS ALREADY SPENT.
   Without something to come back and finish it, that officer's contact never
   arrives, no lead is made, nobody is notified, and the money is gone — so this
   is the pass that makes the screen's "PILOT will keep checking" true.
   Frequent and tiny: one FREE status check per pending row. */
const SETTLE_INTERVAL_MS = envSec('ELEMENTIX_CRM_SETTLE_SEC', 120) * 1000;
const SETTLE_BATCH = envSec('ELEMENTIX_CRM_SETTLE_BATCH', 25);

/* THE HISTORY BACKFILL — the owner's "backdate this: all the profiles we
   currently have" (2026-08-19). Walks borrowers already linked to an Elementix
   person and lands the CACHED profile history on their real profile — entities
   + unverified track-record lines. CACHE-ONLY: it never calls the vendor, so it
   is deliberately NOT gated on the Elementix switch — data already paid for is
   imported whether or not the connection is currently on. Its own kill switch,
   default ON, readable at call time like every other switch here. */
const HISTORY_INTERVAL_MS = envSec('ELEMENTIX_HISTORY_IMPORT_SEC', 600) * 1000;
const HISTORY_BATCH = envSec('ELEMENTIX_HISTORY_IMPORT_BATCH', 10);
const historyImportOn = () => flags.enabled('ELEMENTIX_HISTORY_IMPORT_ENABLED',
  process.env.ELEMENTIX_HISTORY_IMPORT_ENABLED !== '0');

let started = false;
let listing = false;
let working = false;
let settling = false;
let importingHistory = false;

/**
 * Who the passes run AS. Every CRM-plane call needs a staff id — it is how the
 * ledger answers "who used the allowance" — and an unattended job has no human
 * behind it, so it borrows the identity of the person who connected Elementix.
 * That is the truthful answer: the shared connection is theirs.
 *
 * Returns null when nobody has connected, which is also when there is nothing
 * to sync, so the pass simply does not run.
 */
async function runAs() {
  const db = require('../db');
  const url = String((cfg.elementix && cfg.elementix.url) || '').replace(/\/+$/, '');
  try {
    const { rows } = await db.query(
      `SELECT o.connected_by, o.staff_id
         FROM elementix_oauth o
        WHERE o.resource_url = $1
        ORDER BY (o.staff_id IS NULL) DESC, o.connected_at DESC
        LIMIT 1`, [url]);
    const r = rows[0];
    if (!r) return null;
    const id = r.staff_id || r.connected_by;
    if (id) return id;
  } catch (_) { /* fall through to the roster answer below */ }
  // A connection recorded before we tracked who made it: fall back to any active
  // super admin, so a working connection is never stranded by a missing stamp.
  try {
    const { rows } = await db.query(
      `SELECT id FROM staff_users
        WHERE role = 'super_admin' AND is_active = true AND is_external = false
        ORDER BY created_at LIMIT 1`);
    return rows[0] ? rows[0].id : null;
  } catch (_) { return null; }
}

async function listOnce() {
  if (listing) return null;
  if (!client.enabled()) return null;   // Elementix itself, read at CALL time — see start()
  if (!autoImportOn()) return null;
  listing = true;
  try {
    const backfill = require('../lib/elementix/backfill');
    const staffId = await runAs();
    if (!staffId) return null;
    const out = await backfill.listUnlocked({ staffId });
    // Quiet when nothing moved: a log line every six hours saying "0 new" is how
    // a log stops being read.
    if (out && (out.newlyQueued || out.released)) {
      console.log('[elementix-crm] %d newly unlocked contact(s) queued, %d released by a login being matched (%d seen, %d login(s))',
        out.newlyQueued, out.released || 0, out.peopleSeen, (out.users || []).length);
    }
    if (out && out.partial) {
      console.warn('[elementix-crm] the unlocked list stopped early on page %d: %s',
        out.partial.page, out.partial.detail);
    }
    if (out && out.unmatchedUsers && out.unmatchedUsers.length) {
      console.warn('[elementix-crm] %d Elementix login(s) match nobody on the team — their contacts import but their leads wait: %s',
        out.unmatchedUsers.length, out.unmatchedUsers.map((u) => u.email).join(', '));
    }
    return out;
  } catch (e) {
    console.warn('[elementix-crm] listing failed:', e.message);
    return null;
  } finally { listing = false; }
}

async function workOnce() {
  if (working) return null;
  if (!client.enabled()) return null;   // Elementix itself, read at CALL time — see start()
  if (!autoImportOn()) return null;
  working = true;
  try {
    const backfill = require('../lib/elementix/backfill');
    const staffId = await runAs();
    if (!staffId) return null;
    const out = await backfill.workBatch({ staffId, limit: WORK_BATCH });
    if (out && out.worked) {
      console.log('[elementix-crm] brought in %d contact(s), %d became leads, %d already ours, %d waiting on a login, %d left',
        out.worked, out.leads, out.alreadyOurs || 0, out.noOfficer, out.remaining);
    }
    return out;
  } catch (e) {
    console.warn('[elementix-crm] import pass failed:', e.message);
    return null;
  } finally { working = false; }
}

/**
 * Finish the paid lookups that were still running when the officer's click gave
 * up waiting. FREE — `drainPendingSkipTraces` only ever asks `get_contact_status`
 * and `get_contact_info`, both of which are free for a person already unlocked;
 * it cannot reach the paid tool. It gives up on a job older than 48 hours and
 * marks the row failed, so the queue drains rather than growing forever.
 */
async function settleOnce() {
  if (settling) return null;
  /* THE MASTER SWITCH, READ AT CALL TIME — and read HERE rather than at boot.
     start() used to return before arming a single timer when Elementix was off,
     which is the exact trap the import switch was moved to call time to escape:
     turning Elementix ON from the API Health page started nothing until the next
     deploy, and every paid lookup whose vendor job outlived the click sat
     unsettled with the credit already spent. The timers are armed unconditionally
     now; a pass with Elementix off costs one function call. */
  if (!client.enabled()) return null;
  settling = true;
  try {
    const crm = require('../lib/elementix/crm');
    const out = await crm.drainPendingSkipTraces({ limit: SETTLE_BATCH });
    // Quiet when there is nothing pending, which is the normal state.
    if (out && (out.completed || out.failed)) {
      console.log('[elementix-crm] settled %d lookup(s), gave up on %d, %d still running',
        out.completed, out.failed, out.stillPending);
    }
    return out;
  } catch (e) {
    console.warn('[elementix-crm] settle pass failed:', e.message);
    return null;
  } finally { settling = false; }
}

/**
 * Land already-cached Elementix histories on their linked borrowers, a few at
 * a time. Bounded + self-draining (the db/597 stamps); no vendor calls at all,
 * so it cannot spend a slot of the shared allowance or a credit. Quiet when
 * there is nothing to do, which after the first drain is the normal state.
 */
async function historyOnce() {
  if (importingHistory) return null;
  if (!historyImportOn()) return null;
  importingHistory = true;
  try {
    const out = await require('../lib/elementix/deep-history').backfillOnce({ limit: HISTORY_BATCH });
    if (out && (out.imported || out.failed)) {
      console.log('[elementix-crm] history import: %d borrower(s) imported, %d had no cached profile yet, %d failed (retried up to 3 times)',
        out.imported, out.nothing, out.failed);
    }
    return out;
  } catch (e) {
    console.warn('[elementix-crm] history import pass failed:', e.message);
    return null;
  } finally { importingHistory = false; }
}

function start() {
  if (started) return;
  started = true;

  /* THE SETTLE PASS IS NOT BEHIND THE SWITCH, ON PURPOSE. The switch guards the
     BULK IMPORT, which creates leads in people's pipelines from work done in
     Elementix's own screens — that is the thing an owner should turn on
     deliberately. A pending skip trace is the opposite: a member of staff
     pressed the button in PILOT, PILOT spent a credit, and the vendor's job
     outlived the six seconds the click waited. Leaving that unsettled wastes
     money that is already spent and silently drops a lead somebody asked for,
     so it runs wherever Elementix runs. */
  setTimeout(settleOnce, 20000);
  setInterval(settleOnce, SETTLE_INTERVAL_MS);

  console.log('[elementix-crm] Elementix %s, auto-import %s — listing every %dh, importing %d at a time every %dm. No credit can be spent by this loop; stop it any time on the API Health page.',
    client.enabled() ? 'on' : 'OFF (nothing runs until it is switched on — no deploy needed)',
    autoImportOn() ? 'ON' : 'off (switch it on from the API Health page)',
    Math.round(LIST_INTERVAL_MS / 3600000), WORK_BATCH, Math.round(WORK_INTERVAL_MS / 60000));

  /* ARMED WHETHER OR NOT THE SWITCH IS ON, because the switch is read inside
     each pass. A pass with the switch off returns immediately and costs a
     function call — the price of being able to start the import from a screen
     instead of a deploy. Staggered so a deploy does not fire everything at once,
     and so the first work pass has a queue to work. */
  setTimeout(listOnce, 45000);
  setTimeout(workOnce, 90000);
  setInterval(listOnce, LIST_INTERVAL_MS);
  setInterval(workOnce, WORK_INTERVAL_MS);

  /* The cache-only history backfill (owner-directed 2026-08-19). Not behind the
     Elementix switch — see its constant above — but behind its own, read at
     call time. Staggered behind the other first passes. */
  setTimeout(historyOnce, 120000);
  setInterval(historyOnce, HISTORY_INTERVAL_MS);
}

module.exports = { start, listOnce, workOnce, settleOnce, historyOnce, autoImportOn, historyImportOn,
  _internals: { runAs, LIST_INTERVAL_MS, WORK_INTERVAL_MS, WORK_BATCH, SETTLE_INTERVAL_MS, SETTLE_BATCH, HISTORY_INTERVAL_MS, HISTORY_BATCH } };
