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

/* REFUSALS THAT ARE ABOUT THE SYSTEM, NEVER ABOUT THE PERSON. Kept as one named
   set so the import and any future queue answer the same way, and so adding a
   reason to the transport does not silently start retiring rows. */
const GLOBAL_REFUSALS = new Set(['rate_limited', 'disabled', 'not_configured', 'dry_run',
  'not_connected', 'reapproval_needed', 'refresh_failed', 'store_unreadable']);
const MAX_ATTEMPTS = 3;

/* HOW RECENT AN UNLOCK HAS TO BE BEFORE IT IS WORTH TELLING SOMEBODY.
   The owner's requirement is that a contact a user unlocks becomes a lead "plus
   a notification to that officer" — and the SAME import also carries the whole
   history back to the beginning, which on the first pass is about a thousand
   contacts. Notifying on those would put hundreds of notices in one officer's
   list in an afternoon, about people they looked up months ago: precisely the
   bombardment the notification rules exist to stop, and it would bury the one
   notice that is actually news.
   So the test is the VENDOR'S OWN `unlockedAt`, not "did this pass create the
   row": somebody unlocked in Elementix this morning is news, somebody unlocked
   in March is history, and the same rule holds whenever the import happens to
   run. A row with NO unlock date says nothing, so it notifies nobody — news is
   never fabricated from a missing timestamp. */
const NOTIFY_UNLOCKED_WITHIN_HOURS = Math.max(
  1, parseInt(process.env.ELEMENTIX_NOTIFY_WITHIN_HOURS || '168', 10) || 168);

function unlockIsNews(unlockedAt) {
  if (!unlockedAt) return false;
  const t = new Date(unlockedAt).getTime();
  if (!Number.isFinite(t)) return false;
  const ageH = (Date.now() - t) / 3600000;
  // A date in the FUTURE is a clock problem, not news.
  return ageH >= 0 && ageH <= NOTIFY_UNLOCKED_WITHIN_HOURS;
}

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

    /* THE CEILING IS NOT A COMPLETION. Forty pages of 250 is 10,000 people
       against an account that holds 1,041 — but that is an assumption about the
       vendor's data, not a fact about the code, and a listing that stops at its
       own ceiling while the vendor is still offering pages must never report
       itself complete. Same shape as the refusal above: keep everything queued,
       and say where it stopped. */
    if (page >= maxPages) {
      refusal = { reason: 'page_cap', page,
        detail: `PILOT read ${maxPages} pages and Elementix still had more. Everything read so far is queued; run the history again to continue.` };
    }
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
        -- AND ACTIVE. Auto-linking a login to somebody who has left files every
        -- contact they ever unlocked into a pipeline nobody reads, and no
        -- notification reaches anyone. Left unmatched, the login shows on the
        -- admin screen as "whose login is this?" — which is the true state and
        -- an answerable question. A human may still link one deliberately.
        AND s.is_active = true
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
 * WHO REALLY ASKED FOR THIS PERSON — PILOT'S OWN RECORD BEATS THE VENDOR'S.
 *
 * Elementix stamps every unlock with the EMAIL OF THE LOGIN THAT MADE IT, and
 * under the shared super-admin connection that is ONE login for the whole
 * company. So a contact an officer skip traced from inside PILOT comes back down
 * the history list wearing the shared login's email — and mapping that email to
 * an officer, as the roster does for a real Elementix seat, would hand every
 * PILOT-originated unlock to that one person: a second lead in the wrong
 * pipeline, beside the correct one the officer already has, and a notification
 * telling somebody a contact is theirs when it is not.
 *
 * PILOT knows better, because PILOT was there: a trace made here recorded the
 * signed-in officer at the moment of the click. The vendor's email identifies a
 * SEAT; our own row identifies a PERSON, and where they disagree the person
 * wins. Returns null for a contact unlocked in Elementix's own screens, which is
 * the case the roster mapping exists for and where the email IS the only answer.
 */
async function pilotOwnerOf(personId, client = db) {
  try {
    const { rows } = await client.query(
      `SELECT c.unlocked_by AS staff_id, t.staff_id AS trace_staff_id, t.status AS trace_status
         FROM (SELECT $1::text AS pid) k
         LEFT JOIN elementix_contacts c
                ON c.person_id = k.pid AND c.source = 'pilot_skip_trace' AND c.unlocked_by IS NOT NULL
         LEFT JOIN LATERAL (
                SELECT staff_id, status FROM elementix_skip_traces
                 WHERE person_id = k.pid AND source = 'pilot_skip_trace' AND staff_id IS NOT NULL
                 ORDER BY (status = 'complete') DESC, occurred_at
                 LIMIT 1) t ON true`, [personId]);
    const r = rows[0] || {};
    const id = r.staff_id || r.trace_staff_id || null;
    return id ? { staffId: id, traced: r.trace_status === 'complete' } : null;
  } catch (_) {
    /* UNREADABLE IS NOT "PILOT DID NOT TRACE THIS". Answering null here sends the
       row down the vendor-email branch, which calls recordSkipTrace — and that
       upsert would overwrite the reason an officer typed and the record that a
       credit was spent, on a row we simply could not read. So say "unknown":
       the lead is still made from the vendor's email (the contact is never lost,
       and a lead in the wrong pipeline is something a human can move), but the
       history is left exactly as it is. */
    return { unknown: true };
  }
}

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
      /* A CONTACT SOMEBODY UNLOCKED THIS MORNING GOES FIRST. Oldest-first alone
         is right for draining a backlog and wrong on the day the import is
         switched on: a thousand rows from March sit in front of the lookup an
         officer just did, so the one notification that is actually news arrives
         hours late — twenty rows every five minutes is four and a half hours of
         queue. Fresh unlocks jump; within each group it is still oldest-first,
         so nothing starves and the backlog still drains in order. */
      ORDER BY (q.unlocked_at IS NOT NULL AND q.unlocked_at >= now() - make_interval(hours => $3)) DESC,
               q.listed_at
      LIMIT $1`,
    [Math.max(1, Math.min(Number(limit) || WORK_BATCH, 200)), MAX_ATTEMPTS, NOTIFY_UNLOCKED_WITHIN_HOURS]);

  const out = { ok: true, worked: 0, leads: 0, notified: 0, alreadyOurs: 0, noOfficer: 0, failed: 0, remaining: 0 };

  /* ONE ROW CAN NEVER STALL THE QUEUE. Rows are taken oldest-first, and a row
     that THROWS is never stamped — so it comes back at the head of the very next
     batch, throws again, and the import stops dead behind it while the log says
     only "import pass failed". That is a poison row, and the queue has 1,041 of
     them behind it. Every failure — the vendor's, and anything the database
     refuses — therefore lands here: attempts up, the reason recorded, and the
     row retired after MAX_ATTEMPTS so the queue drains rather than grinding. */
  const recordRowFailure = async (personId, detail) => {
    out.failed += 1;
    try {
      await client.query(
        `UPDATE elementix_backfill_queue
            SET attempts = attempts + 1, detail = $2,
                status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'pending' END,
                worked_at = now()
          WHERE person_id = $1`,
        [personId, clip(detail || 'Elementix did not answer.', 500), MAX_ATTEMPTS]);
    } catch (_) { /* if even this cannot be written the next pass tries again */ }
  };

  for (const r of rows) {
    const personId = r.person_id;
    const res = await crmTools.call('get_contact_info', { personId }, { staffId });
    if (!res || res.ok !== true) {
      /* A REFUSAL ABOUT THE SYSTEM IS NOT A FAILURE OF THIS ROW. Rate-limited,
         switched off, dry run, not connected — none of those say anything about
         this person, and stamping them spends one of the row's three lives for a
         reason it had no part in. The work pass runs 20 rows every five minutes
         against a shared hourly cap, so tripping the limiter is the ORDINARY
         state of the first drain, not an edge case: without this, one episode
         retires a whole batch of the owner's paid-for history, permanently, with
         nothing at the desk able to bring it back. Stop the pass instead and
         leave the rows exactly as they were — the next pass picks them up. */
      if (GLOBAL_REFUSALS.has(res && res.reason)) {
        out.stoppedEarly = (res && res.reason) || 'refused';
        out.stoppedDetail = (res && res.detail) || 'Elementix stopped answering.';
        break;
      }
      await recordRowFailure(personId, (res && res.detail) || 'Elementix did not answer.');
      continue;
    }

    try {
    const contact = crm.normalizeContact(res.data);
    // Whose contact is this? PILOT's own record of the click first (see
    // pilotOwnerOf), the vendor's login email second.
    const mine = await pilotOwnerOf(personId, client);
    const historyUnreadable = !!(mine && mine.unknown);
    const officerId = (mine && mine.staffId) || r.officer_id || null;
    /* The header row the contact hangs off (a foreign key). `listUnlocked`
       writes it when it queues the row, and this does NOT lean on that: a queue
       row whose person went missing — cleaned up, or seeded by some future
       path — would otherwise fail the insert, and before the guard above that
       took the whole batch with it. */
    await crm.ensurePerson({ personId, name: r.person_name, state: r.person_state, client });
    // The vendor's own record of who unlocked it, kept whether or not we could
    // match it to somebody on the roster.
    await crm.storeContact({
      personId, contact, raw: res.data,
      staffId: officerId,
      source: 'imported', client,
    });
    await client.query(
      `UPDATE elementix_contacts
          SET unlocked_by_email  = COALESCE(unlocked_by_email, $2),
              vendor_unlocked_at = COALESCE(vendor_unlocked_at, $3),
              unlocked_at        = COALESCE(unlocked_at, $3)
        WHERE person_id = $1`, [personId, r.unlocked_by_email, r.unlocked_at]);

    let leadId = null;
    if (mine) {
      /* PILOT ASKED FOR THIS ONE ITSELF, so its own history is the record and
         this pass must not rewrite it. `ensureLead` is safe and worth running —
         it is keyed on (person, officer), so it returns the lead the officer
         already has, or gives them the one an earlier failed attempt never
         made. `recordSkipTrace` is NOT: it upserts on the same key and would
         overwrite the reason the officer typed with "Imported from Elementix
         history" and the charge with false, quietly erasing what was bought and
         why. That is true whether the earlier trace COMPLETED or is still
         pending — a pending one is charged and belongs to the settle pass, and a
         failed one still holds the officer's own words. So: refresh the detail,
         make sure the lead exists, leave the history alone. */
      const lead = await crm.ensureLead({
        personId, staffId: mine.staffId, name: r.person_name, state: r.person_state, contact, client,
      });
      leadId = lead && lead.id ? lead.id : null;
      if (lead && lead.created) out.leads += 1;
      out.alreadyOurs += 1;
    } else if (officerId) {
      const lead = await crm.ensureLead({
        personId, staffId: officerId, name: r.person_name, state: r.person_state, contact, client,
      });
      leadId = lead && lead.id ? lead.id : null;
      if (lead && lead.created) out.leads += 1;
      /* THE OWNER'S "plus a notification to that officer" — for a FRESH unlock
         only. Best-effort and never awaited into the import's success: a
         notification that fails must not fail the import, and the lead is the
         thing that matters. */
      if (lead && lead.created && unlockIsNews(r.unlocked_at)) {
        out.notified += 1;
        crm.notifyOfficer({ staffId: officerId, leadId, name: r.person_name, contact })
          .catch(() => { /* the lead landed; the notice is a courtesy */ });
      }
      /* HISTORY IS ONLY WRITTEN WHEN WE COULD READ IT. This upsert overwrites the
         status and the detail, so running it on a row whose PILOT history we
         merely failed to read could erase what an officer typed and what a
         credit bought. The lead above is made either way — the contact is never
         lost — but a record we cannot see is a record we do not touch. */
      if (!historyUnreadable) {
        await crm.recordSkipTrace({
          personId, staffId: officerId, name: r.person_name, state: r.person_state,
          reason: 'Imported from Elementix history', charged: false, source: 'imported',
          leadId, status: 'complete', client,
        });
        await client.query(
          `UPDATE elementix_skip_traces SET unlocked_by_email = COALESCE(unlocked_by_email, $2)
            WHERE person_id = $1 AND staff_id = $3`, [personId, r.unlocked_by_email, officerId]);
      }
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
      [personId, officerId ? 'done' : 'skipped', leadId, r.unlocked_by_email]);
    out.worked += 1;
    } catch (e) {
      // Anything the database or a helper refused. Recorded against THIS row so
      // the batch carries on and the queue keeps draining.
      await recordRowFailure(personId, `PILOT could not file this contact: ${e && e.message}`);
    }
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
  _internals: { LIST_PAGE, MAX_PAGES, WORK_BATCH, MAX_ATTEMPTS, email, pilotOwnerOf, unlockIsNews, NOTIFY_UNLOCKED_WITHIN_HOURS },
};
