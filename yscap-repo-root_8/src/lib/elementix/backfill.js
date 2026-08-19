'use strict';
/**
 * src/lib/elementix/backfill.js — every contact this office ever unlocked,
 * given back to the officer who unlocked it.
 *
 * ── WHAT THE OWNER ASKED FOR ────────────────────────────────────────────────
 * "Backdate from the beginning. We have about a thousand leads already skip
 * traced — go through every loan officer, find which ones they already skip
 * traced, and import all of them with all the Elementix data."
 *
 * ── WHY THIS WAS REPORTED AS IMPOSSIBLE, AND WHY THAT WAS WRONG ─────────────
 * The vendor publishes 40 tools and none of them is called "list our users" or
 * "list our unlocks", so the first reading of the catalogue concluded the
 * history could not be pulled and the owner would need a CSV export. The owner
 * pushed back — "dig in deeper, I'm 100% you can link who discovered the number
 * by email link" — and was right.
 *
 * Two things settle it, both measured against the live account on 2026-08-18
 * and neither of them documented:
 *   · `get_contact_status` returns `unlockedBy` (an EMAIL) and `unlockedAt`.
 *     Its published description says it returns {isUnlocked, isJobCompleted}.
 *   · `list_people` takes `unlockStatus:'unlocked'` and puts that same email on
 *     EVERY ROW. The entire history came back in two calls: 1,041 contacts, 13
 *     distinct users, not one row missing its email.
 *
 * LESSON WORTH KEEPING: a tool's published description is a summary, not a
 * schema. "The catalogue has no tool for X" is a claim about the catalogue, not
 * about the API — call the closest tool and read what actually comes back.
 *
 * ── HOW IT RUNS ─────────────────────────────────────────────────────────────
 * Two phases, deliberately separate, because they cost very different amounts.
 *   LIST  — two calls, and the whole queue exists. Cheap enough to re-run.
 *   WORK  — one FREE `get_contact_info` per person, ~1,041 of them, against a
 *           400-an-hour self cap. That is hours, so it is a resumable queue with
 *           a stamp per row, never one long pass that loses its place.
 *
 * NOTHING HERE SPENDS A CREDIT. `submit_contact_enrichment` is not reachable
 * from this module — every one of these people is ALREADY unlocked, which is the
 * only reason the history can be read at all, and re-buying a contact we own
 * would be the most expensive possible way to import it.
 */

const db = require('../../db');
const crmTools = require('./crm-tools');
const crm = require('./crm');

const str = (v) => String(v == null ? '' : v).trim();
const clip = (v, n) => str(v).slice(0, n);
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str(v));
const email = (v) => {
  const s = str(v).toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : null;
};

/* A page of `list_people` rows is several megabytes — one row is ~6KB — so this
   is sized for the transport, not for the vendor's 5,000 ceiling. */
const LIST_PAGE = 250;
const MAX_PAGES = 40;          // 10,000 people; the account holds 1,041
const WORK_BATCH = 25;
const MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// PHASE 1 — LIST: who has been unlocked, and by whom
// ---------------------------------------------------------------------------

/**
 * Walk the unlocked list into `elementix_backfill_queue` and the distinct
 * unlockers into `elementix_users`.
 *
 * Re-runnable by design: a person already queued keeps their row (and their
 * status, so a finished one is not re-worked), and a new unlock made since the
 * last run is simply added. That is what makes this safe to run again after a
 * failure, and what makes it double as "catch up on anything done in Elementix's
 * own screens since we last looked".
 */
async function listUnlocked({ staffId, maxPages = MAX_PAGES, perPage = LIST_PAGE, client = db } = {}) {
  if (!staffId) return { ok: false, reason: 'no_actor', detail: 'Importing the history has to be started by a signed-in member of staff.' };

  let queued = 0; let seen = 0; let pages = 0;
  const users = new Map();   // email -> {count, first, last}
  let refusal = null;

  for (let page = 1; page <= maxPages; page += 1) {
    const res = await crmTools.call('list_people',
      { unlockStatus: 'unlocked', perPage, page, sortBy: 'unlockedAt', sortOrder: 'asc' },
      { staffId });
    pages += 1;
    if (!res || res.ok !== true) {
      // Stop, keep everything already queued, and SAY where it stopped. A
      // half-listed history that reports itself complete is the failure that
      // makes the whole import untrustworthy.
      refusal = { reason: (res && res.reason) || 'failed', detail: (res && res.detail) || 'Elementix stopped answering.', page };
      break;
    }
    const rows = crmTools.rowsOf(res.data);
    seen += rows.length;

    for (const r of rows) {
      const personId = str(r && r.id);
      if (!isUuid(personId)) continue;
      const by = email(r.unlockedBy);
      const at = r.unlockedAt || null;
      if (by) {
        const u = users.get(by) || { count: 0, first: at, last: at };
        u.count += 1;
        if (at && (!u.first || at < u.first)) u.first = at;
        if (at && (!u.last || at > u.last)) u.last = at;
        users.set(by, u);
      }
      const ins = await client.query(
        `INSERT INTO elementix_backfill_queue
           (person_id, person_name, person_state, unlocked_by_email, unlocked_at)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (person_id) DO UPDATE
            SET person_name       = COALESCE(elementix_backfill_queue.person_name, EXCLUDED.person_name),
                person_state      = COALESCE(elementix_backfill_queue.person_state, EXCLUDED.person_state),
                unlocked_by_email = COALESCE(elementix_backfill_queue.unlocked_by_email, EXCLUDED.unlocked_by_email),
                unlocked_at       = COALESCE(elementix_backfill_queue.unlocked_at, EXCLUDED.unlocked_at)
         RETURNING (xmax = 0) AS inserted`,
        [personId, clip(r.name, 300) || null,
          clip(r.primaryState || r.personState, 2).toUpperCase() || null, by, at]);
      /* `rowCount` is 1 for the UPDATE half of an upsert too, so counting it
         reported "1,041 newly queued" on every re-run of an import that had
         added nobody. `xmax = 0` is true only on the row this statement
         actually INSERTED — which is the number an operator is reading to
         decide whether the run did anything. */
      if (ins.rows[0] && ins.rows[0].inserted) queued += 1;
      // The person row has to exist for a contact or a section to hang off it.
      await crm.ensurePerson({ personId, name: r.name, state: str(r.primaryState || r.personState).toUpperCase(), client });
    }

    if (!res.data || res.data.nextPage == null) break;
  }

  for (const [addr, u] of users) await recordUser(addr, u, client);
  const matched = await matchUsers(client);

  return {
    ok: !refusal, ...(refusal ? { partial: refusal } : {}),
    pagesRead: pages, peopleSeen: seen, newlyQueued: queued,
    users: [...users.entries()].map(([e, u]) => ({ email: e, unlocks: u.count, first: u.first, last: u.last }))
      .sort((a, b) => b.unlocks - a.unlocks),
    matchedUsers: matched.matched, unmatchedUsers: matched.unmatched,
  };
}

/** One row per Elementix login we have seen do anything. */
async function recordUser(addr, u, client = db) {
  await client.query(
    `INSERT INTO elementix_users (email, unlock_count, first_unlock_at, last_unlock_at, last_seen_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (email) DO UPDATE
        SET unlock_count    = GREATEST(elementix_users.unlock_count, EXCLUDED.unlock_count),
            first_unlock_at = LEAST(COALESCE(elementix_users.first_unlock_at, EXCLUDED.first_unlock_at), EXCLUDED.first_unlock_at),
            last_unlock_at  = GREATEST(COALESCE(elementix_users.last_unlock_at, EXCLUDED.last_unlock_at), EXCLUDED.last_unlock_at),
            last_seen_at    = now(),
            updated_at      = now()`,
    [addr, u.count, u.first, u.last]);
}

/**
 * Match Elementix logins to PILOT staff BY EMAIL — an exact, case-insensitive
 * equality and nothing else.
 *
 * NEVER BY NAME. Two of the thirteen logins on this account are `josef@` and
 * `yosef@`, and another pair is `sol@` and `solomon@`: any fuzzy matcher worth
 * the name would join at least one of those pairs, and the cost of being wrong
 * is one officer's leads landing in another officer's pipeline. An address that
 * matches nobody stays unmatched and is put in front of a human.
 *
 * A link a HUMAN made (`linked_by` set) is never touched.
 */
async function matchUsers(client = db) {
  const { rows } = await client.query(
    `UPDATE elementix_users u
        SET staff_id = s.id, updated_at = now()
       FROM staff_users s
      WHERE s.email = u.email
        AND s.is_external = false
        AND u.linked_by IS NULL
        AND u.ignored = false
        AND u.staff_id IS DISTINCT FROM s.id
      RETURNING u.email`);
  const all = await client.query(
    `SELECT email, staff_id, ignored, unlock_count FROM elementix_users ORDER BY unlock_count DESC`);
  return {
    changed: rows.length,
    matched: all.rows.filter((r) => r.staff_id).map((r) => r.email),
    unmatched: all.rows.filter((r) => !r.staff_id && !r.ignored).map((r) => ({ email: r.email, unlocks: r.unlock_count })),
  };
}

/** A human says which officer a login belongs to — or that it belongs to nobody. */
async function linkUser({ email: addr, staffId, actorId, ignore }, client = db) {
  const a = email(addr);
  if (!a) return { ok: false, reason: 'bad_args', detail: 'That is not an email address.' };
  if (!actorId) return { ok: false, reason: 'no_actor', detail: 'Linking a login to an officer is a decision, so it has to be made by a signed-in member of staff.' };
  if (staffId && !isUuid(staffId)) return { ok: false, reason: 'bad_args', detail: 'That is not a member of staff.' };
  await client.query(
    `INSERT INTO elementix_users (email, staff_id, linked_by, linked_at, ignored)
     VALUES ($1,$2,$3,now(),$4)
     ON CONFLICT (email) DO UPDATE
        SET staff_id = EXCLUDED.staff_id, linked_by = EXCLUDED.linked_by,
            linked_at = now(), ignored = EXCLUDED.ignored, updated_at = now()`,
    [a, staffId || null, actorId, ignore === true]);
  return { ok: true, email: a, staffId: staffId || null, ignored: ignore === true };
}

// ---------------------------------------------------------------------------
// PHASE 2 — WORK: read each contact and hand it to its officer
// ---------------------------------------------------------------------------

/**
 * Work a batch of the queue.
 *
 * FREE THROUGHOUT. Every person here is already unlocked, so `get_contact_info`
 * simply returns the enrichment job we have already paid for. A person whose
 * contact cannot be read is recorded as failed WITH THE REASON and retried a
 * bounded number of times — never silently dropped, and never re-bought.
 */
async function workBatch({ staffId, limit = WORK_BATCH, client = db } = {}) {
  if (!staffId) return { ok: false, reason: 'no_actor', detail: 'The import has to be run by a signed-in member of staff.' };

  const { rows } = await client.query(
    `SELECT q.person_id, q.person_name, q.person_state, q.unlocked_by_email, q.unlocked_at, q.attempts,
            u.staff_id AS officer_id
       FROM elementix_backfill_queue q
       LEFT JOIN elementix_users u ON u.email = q.unlocked_by_email
      WHERE q.status = 'pending' AND q.attempts < $2
      ORDER BY q.listed_at
      LIMIT $1`, [Math.max(1, Math.min(Number(limit) || WORK_BATCH, 200)), MAX_ATTEMPTS]);

  const out = { ok: true, worked: 0, leads: 0, noOfficer: 0, failed: 0, remaining: 0 };

  for (const r of rows) {
    const personId = r.person_id;
    const res = await crmTools.call('get_contact_info', { personId }, { staffId });
    if (!res || res.ok !== true) {
      out.failed += 1;
      await client.query(
        `UPDATE elementix_backfill_queue
            SET attempts = attempts + 1, detail = $2,
                status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'pending' END,
                worked_at = now()
          WHERE person_id = $1`,
        [personId, clip((res && res.detail) || 'Elementix did not answer.', 500), MAX_ATTEMPTS]);
      continue;
    }

    const contact = crm.normalizeContact(res.data);
    // The vendor's own record of who unlocked it, kept whether or not we could
    // match it to somebody on the roster.
    await crm.storeContact({
      personId, contact, raw: res.data,
      staffId: r.officer_id || null,
      source: 'imported', client,
    });
    await client.query(
      `UPDATE elementix_contacts
          SET unlocked_by_email  = COALESCE(unlocked_by_email, $2),
              vendor_unlocked_at = COALESCE(vendor_unlocked_at, $3),
              unlocked_at        = COALESCE(unlocked_at, $3)
        WHERE person_id = $1`, [personId, r.unlocked_by_email, r.unlocked_at]);

    let leadId = null;
    if (r.officer_id) {
      const lead = await crm.ensureLead({
        personId, staffId: r.officer_id, name: r.person_name, state: r.person_state, contact, client,
      });
      leadId = lead && lead.id ? lead.id : null;
      if (leadId) out.leads += 1;
      await crm.recordSkipTrace({
        personId, staffId: r.officer_id, name: r.person_name, state: r.person_state,
        reason: 'Imported from Elementix history', charged: false, source: 'imported',
        leadId, status: 'complete', client,
      });
      await client.query(
        `UPDATE elementix_skip_traces SET unlocked_by_email = COALESCE(unlocked_by_email, $2)
          WHERE person_id = $1 AND staff_id = $3`, [personId, r.unlocked_by_email, r.officer_id]);
    } else {
      // The contact is still imported and still searchable — it just has no
      // pipeline to go into until somebody says whose login that was.
      out.noOfficer += 1;
    }

    await client.query(
      `UPDATE elementix_backfill_queue
          SET status = $2, lead_id = $3, worked_at = now(), attempts = attempts + 1,
              detail = CASE WHEN $2 = 'skipped'
                            THEN 'Imported, but no PILOT officer is linked to ' || COALESCE($4, 'that Elementix login') || ' yet.'
                            ELSE NULL END
        WHERE person_id = $1`,
      [personId, r.officer_id ? 'done' : 'skipped', leadId, r.unlocked_by_email]);
    out.worked += 1;
  }

  const left = await client.query(
    `SELECT count(*)::int AS n FROM elementix_backfill_queue WHERE status = 'pending' AND attempts < $1`, [MAX_ATTEMPTS]);
  out.remaining = left.rows[0].n;
  return out;
}

/** Where the import has got to, in plain numbers. */
async function progress(client = db) {
  const q = await client.query(
    `SELECT status, count(*)::int AS n FROM elementix_backfill_queue GROUP BY status`);
  const byStatus = Object.fromEntries(q.rows.map((r) => [r.status, r.n]));
  const users = await client.query(
    `SELECT u.email, u.staff_id, u.ignored, u.unlock_count, u.first_unlock_at, u.last_unlock_at,
            s.full_name AS officer_name, s.is_active AS officer_active
       FROM elementix_users u
       LEFT JOIN staff_users s ON s.id = u.staff_id
      ORDER BY u.unlock_count DESC, u.email`);
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  return {
    total,
    pending: byStatus.pending || 0,
    done: byStatus.done || 0,
    skipped: byStatus.skipped || 0,
    failed: byStatus.failed || 0,
    users: users.rows.map((r) => ({
      email: r.email,
      unlocks: r.unlock_count,
      firstAt: r.first_unlock_at,
      lastAt: r.last_unlock_at,
      ignored: r.ignored,
      officer: r.staff_id ? { id: r.staff_id, name: r.officer_name, active: r.officer_active } : null,
    })),
  };
}

/**
 * Rework the rows that were imported before their login was linked to anybody.
 *
 * This is what makes linking a login AFTER an import worth doing: the contacts
 * are already here, so those people just need their leads made. Nothing is
 * re-read from Elementix.
 */
async function releaseSkipped({ email: addr, client = db } = {}) {
  const a = email(addr);
  const { rowCount } = await client.query(
    `UPDATE elementix_backfill_queue
        SET status = 'pending', attempts = 0, detail = NULL
      WHERE status = 'skipped'
        AND ($1::citext IS NULL OR unlocked_by_email = $1::citext)
        AND EXISTS (SELECT 1 FROM elementix_users u
                     WHERE u.email = elementix_backfill_queue.unlocked_by_email
                       AND u.staff_id IS NOT NULL)`, [a]);
  return { ok: true, requeued: rowCount || 0 };
}

module.exports = {
  listUnlocked, workBatch, progress, linkUser, matchUsers, releaseSkipped,
  _internals: { LIST_PAGE, MAX_PAGES, WORK_BATCH, MAX_ATTEMPTS, email },
};
