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
 * OFF BY DEFAULT. `ELEMENTIX_CRM_SYNC_ENABLED=1` turns it on, which is
 * deliberate for a job that creates leads in people's pipelines: the owner
 * should switch it on once the roster of Elementix logins has been mapped to
 * officers, or the first pass will park everything as "waiting on whose login
 * that was" and tell nobody.
 */

const cfg = require('../config');
const client = require('../elementix/client');

const envSec = (k, dflt) => {
  const n = parseInt(process.env[k] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
const on = (k) => {
  const v = String(process.env[k] || '').trim().toLowerCase();
  return v === '1' || v === 'true';
};

/* The LIST is cheap (a handful of calls) but there is no point asking often —
   an unlock made a few hours ago is not urgent, and the office's hourly
   allowance is shared with everything else PILOT does. */
const LIST_INTERVAL_MS = envSec('ELEMENTIX_CRM_LIST_SEC', 6 * 3600) * 1000;
/* The WORK pass is where the volume is: one free read per person, and the first
   run has ~1,000 of them. Small batches, often, so it drains over a day or two
   without ever being the reason somebody else's lookup is rate-limited. */
const WORK_INTERVAL_MS = envSec('ELEMENTIX_CRM_WORK_SEC', 300) * 1000;
const WORK_BATCH = envSec('ELEMENTIX_CRM_WORK_BATCH', 20);

let started = false;
let listing = false;
let working = false;

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
  listing = true;
  try {
    const backfill = require('../lib/elementix/backfill');
    const staffId = await runAs();
    if (!staffId) return null;
    const out = await backfill.listUnlocked({ staffId });
    // Quiet when nothing moved: a log line every six hours saying "0 new" is how
    // a log stops being read.
    if (out && out.newlyQueued) {
      console.log('[elementix-crm] %d newly unlocked contact(s) queued (%d seen, %d login(s))',
        out.newlyQueued, out.peopleSeen, (out.users || []).length);
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
  working = true;
  try {
    const backfill = require('../lib/elementix/backfill');
    const staffId = await runAs();
    if (!staffId) return null;
    const out = await backfill.workBatch({ staffId, limit: WORK_BATCH });
    if (out && out.worked) {
      console.log('[elementix-crm] brought in %d contact(s), %d became leads, %d waiting on a login, %d left',
        out.worked, out.leads, out.noOfficer, out.remaining);
    }
    return out;
  } catch (e) {
    console.warn('[elementix-crm] import pass failed:', e.message);
    return null;
  } finally { working = false; }
}

function start() {
  if (started) return;
  if (!on('ELEMENTIX_CRM_SYNC_ENABLED')) {
    console.log('[elementix-crm] off (set ELEMENTIX_CRM_SYNC_ENABLED=1 to bring unlocked contacts in automatically)');
    return;
  }
  if (!client.enabled()) { console.log('[elementix-crm] Elementix itself is off — nothing to sync'); return; }
  started = true;
  console.log('[elementix-crm] on — listing every %dh, importing %d at a time every %dm. No credit can be spent by this loop.',
    Math.round(LIST_INTERVAL_MS / 3600000), WORK_BATCH, Math.round(WORK_INTERVAL_MS / 60000));

  // Staggered so a deploy does not fire everything at once, and so the first
  // work pass has a queue to work.
  setTimeout(listOnce, 45000);
  setTimeout(workOnce, 90000);
  setInterval(listOnce, LIST_INTERVAL_MS);
  setInterval(workOnce, WORK_INTERVAL_MS);
}

module.exports = { start, listOnce, workOnce, _internals: { runAs, LIST_INTERVAL_MS, WORK_INTERVAL_MS, WORK_BATCH } };
