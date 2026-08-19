'use strict';
/**
 * THE ELEMENTIX CRM DESK — mounted at /api/elementix. Staff only, internal only.
 *
 *   GET  /me                          -> my own Elementix connection
 *   GET  /connect                     -> start connecting MY OWN Elementix login
 *   POST /disconnect                  -> drop my own connection
 *   GET  /connections                 -> the whole roster (who is connected to what)
 *   GET  /usage                       -> what is left of the hourly and monthly allowance
 *   GET  /search?q=&state=            -> find a person by name
 *   GET  /people/:id/contact          -> is this person already unlocked? (FREE)
 *   POST /people/:id/skip-trace       -> SPENDS A CREDIT: unlock, and make a lead
 *   POST /people/:id/lead             -> make a lead from a person already unlocked
 *   GET  /people/:id/profile          -> the whole profile, from the cache
 *   POST /people/:id/profile/build    -> Run a search / Refresh data (spends calls)
 *   GET  /people/:id/aliases          -> other states offered for this person
 *   POST /people/:id/aliases/:aliasId -> yes, that is the same person / no it is not
 *   POST /link                        -> attach a person to a lead or a borrower
 *   GET  /for/:kind/:recordId         -> the person attached to a lead or borrower
 *
 * ── WHY THIS IS ITS OWN ROUTER, NOT A CORNER OF /api/staff ──────────────────
 * Everything here belongs to the CRM plane. `src/lib/elementix/lookups.js` — the
 * UNDERWRITING plane, which proves a borrower's track record — is not reachable
 * from any route in this file, and contact detail bought here may never be read
 * back by a lending decision. That is the FCRA line the connector research drew,
 * and keeping the two behind different doors is what makes it structural rather
 * than a convention somebody has to remember.
 *
 * ── WHO MAY USE IT ──────────────────────────────────────────────────────────
 * ANY INTERNAL staff member. The owner's requirement is that every loan officer
 * skip traces from their own login, so gating this on a capability nobody holds
 * by default would kill the feature for exactly the people it is for. The
 * controls on the money are elsewhere and already built: a named officer, a
 * typed reason, a monthly cap counted from the call ledger, and a refusal that
 * fails CLOSED when the count cannot be read.
 *
 * AN EXTERNAL STAFF USER IS REFUSED. A TPO broker is a `staff_users` row with
 * `is_external = true` (they have to be — a broker is the loan officer on their
 * own firm's files), so `requireStaff` alone would hand an outside company the
 * ability to spend our Elementix credits and read our CRM. That refusal is the
 * first thing this router does.
 */

const router = require('../lib/safe-router')();
const db = require('../db');
const { requireAuth, requireStaff, requirePermission } = require('../auth');
const { keyedRateLimit } = require('../lib/rate-limit');
const { can, visibleBorrowerSql, visibleLeadSql } = require('../lib/permissions');
const oauth = require('../elementix/oauth');
const client = require('../elementix/client');
const crmTools = require('../lib/elementix/crm-tools');
const crm = require('../lib/elementix/crm');
const identity = require('../lib/elementix/identity');
const profile = require('../lib/elementix/profile');
const elxAddress = require('../lib/elementix/address');
const backfill = require('../lib/elementix/backfill');

const str = (v) => String(v == null ? '' : v).trim();
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str(v));

router.use(requireAuth, requireStaff);

/* THROTTLED PER OFFICER, which most staff routers are not, because one click
   here can turn into forty outbound calls: "Refresh data" on a profile walks
   eight sections, each of them paged. Those calls come out of an allowance the
   WHOLE ORGANISATION shares — Elementix's own ceiling is 1,000 an hour across
   every connected client — so a held-down button, or a screen stuck in a reload
   loop, does not merely slow PILOT down: it takes the underwriting desk's
   track-record lookups down with it.
   KEYED ON THE PERSON, NOT THE IP. The office is behind one address, so a
   per-IP bucket would be shared by everybody in it and the busiest afternoon
   would look like abuse. Generous enough that ordinary use never notices; the
   monthly money cap and the per-hour self cap in elementix/client.js are the
   other two layers, and they are the ones that actually protect the vendor
   allowance. Mounted AFTER requireAuth, because that is what puts req.actor
   there for the key.
   120 A MINUTE is roughly four times the busiest real minute anybody has here
   (a search, a status check and a profile open are one request each, and the
   tabs are drawn from what is already loaded), and orders of magnitude below a
   screen stuck in a loop. The number is deliberately loose: this layer exists
   to stop a runaway, not to ration an officer's work. */
router.use(keyedRateLimit({
  bucket: 'elementix-crm', windowMs: 60000, max: 120,
  keyOf: (req) => (req.actor && req.actor.id) || '',
}));

/** No outside company spends our credits or reads our CRM. */
router.use(async (req, res, next) => {
  const { rows } = await db.query(
    `SELECT is_external, is_active FROM staff_users WHERE id = $1`, [req.actor.id]);
  const me = rows[0];
  if (!me || me.is_active === false) {
    return res.status(403).json({ error: 'That account is not active.' });
  }
  if (me.is_external) {
    return res.status(403).json({ error: 'Elementix is an internal tool — it is not part of the broker portal.' });
  }
  return next();
});

async function audit(req, action, detail, entityId) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, ip_address, user_agent, detail)
       VALUES ('staff', $1, $2, 'elementix', $3, $4, $5, $6::jsonb)`,
      [req.actor.id, action, entityId || null, req.ip, req.get('user-agent') || null, JSON.stringify(detail || {})]);
  } catch (_) { /* an audit failure must never block the action */ }
}

/** The shape every refusal from the library layer is turned into. */
function refuse(res, out, fallbackStatus = 400) {
  const map = {
    no_actor: 403, not_allowed: 403, paid_tool_refused: 403,
    bad_args: 400, no_reason: 400,
    not_found: 404,
    paid_cap_reached: 429, rate_limited: 429,
    not_connected: 409, disabled: 503, unavailable: 503,
    /* OUR OWN STATE IS NOT AN ELEMENTIX OUTAGE. Both of these fell through to a
       502, which the request log records as [api-fail] and vendor-health reads as
       the vendor being down — for a switch on our own API Health page, and for
       our own ledger being unreadable (the money cap failing CLOSED). */
    paid_cap_unknown: 429, dry_run: 503,
  };
  const status = map[out && out.reason] || fallbackStatus;
  return res.status(status).json({ error: (out && out.detail) || 'That could not be done.', reason: out && out.reason });
}

// ---------------------------------------------------------------------------
// MY OWN SEAT
// ---------------------------------------------------------------------------

router.get('/me', async (req, res) => {
  const mine = await oauth.status(req.actor.id);
  const company = await oauth.status(null);
  // `oauth.status(staffId)` falls back to the company row when the officer has
  // none, so "have I connected?" is answered from the officers table directly
  // rather than from a status that may be describing somebody else's seat.
  const own = await db.query(
    `SELECT elx_user_label, elx_user_email, elx_org_label, identity_at, connected_at
       FROM elementix_oauth
      WHERE staff_id = $1`, [req.actor.id]);
  res.json({
    connected: own.rows.length > 0,
    mine: own.rows[0] ? {
      user: own.rows[0].elx_user_label, email: own.rows[0].elx_user_email,
      org: own.rows[0].elx_org_label, checkedAt: own.rows[0].identity_at,
      connectedAt: own.rows[0].connected_at,
    } : null,
    // A company-wide connection means an officer can still READ, but their skip
    // traces cannot be signed by their own Elementix seat.
    companyConnected: !!(company && company.connected),
    /* NAMED FIELDS, NOT THE WHOLE STATUS OBJECT. `oauth.status()` carries the MCP
       resource URL and, once connected, the OAuth client id and authorization
       server — the API Health page's material, and that page is behind
       platform_setup while this route is open to every internal officer. No
       secret was ever in it; the connection's identity does not belong here
       either. */
    status: mine ? {
      configured: !!mine.configured, connected: !!mine.connected,
      expiresAt: mine.expiresAt || null, lastError: mine.lastError || null,
      detail: mine.detail || null,
    } : null,
  });
});

router.get('/connect', async (req, res) => {
  const out = await oauth.beginConnect({ staffId: req.actor.id, actorId: req.actor.id });
  if (!out || out.ok === false) return refuse(res, out, 409);
  await audit(req, 'elementix_connect_started', {});
  res.json({ ok: true, url: out.url || out.authorizeUrl, expiresAt: out.expiresAt });
});

router.post('/disconnect', async (req, res) => {
  const out = await oauth.disconnect(req.actor.id);
  await audit(req, 'elementix_disconnected', { removed: out.removed });
  res.json(out);
});

// ---------------------------------------------------------------------------
// THE ROSTER — "a list of all of our users", assembled from who actually connected
// ---------------------------------------------------------------------------

router.get('/connections', requirePermission('manage_team'), async (req, res) => {
  const [connections, missing, history] = await Promise.all([
    identity.connections(),
    identity.officersNotConnected(),
    // THE ACTUAL LIST OF OUR ELEMENTIX USERS. `connections` is who has approved
    // an OAuth seat here — under the shared-login model, usually just the one
    // company connection. `users` is who has actually DONE something over there,
    // derived from the email on every unlocked contact, which is the list the
    // owner asked for and the only one that reflects reality.
    backfill.progress().catch(() => null),
  ]);
  res.json({
    connections,
    notConnected: missing,
    users: history ? history.users : [],
    backfill: history ? { total: history.total, pending: history.pending, done: history.done, skipped: history.skipped, failed: history.failed } : null,
  });
});

/** Ask Elementix who a connection belongs to, and store the label. */
router.post('/connections/:staffId/refresh-identity', requirePermission('manage_team'), async (req, res) => {
  const target = str(req.params.staffId);
  const staffId = target === 'company' ? null : target;
  if (staffId && !isUuid(staffId)) return res.status(400).json({ error: 'That is not a member of staff.' });
  const out = await identity.recordIdentity(staffId, { actingStaffId: req.actor.id });
  if (!out.ok) return refuse(res, out, 502);
  res.json(out);
});

// ---------------------------------------------------------------------------
// THE ADMIN CRM DESK — the whole company's lead book, one row per officer
//
// Owner-directed 2026-08-19: "make admin can see everybody all crm in admin crm
// screen — set up to switch view and jump from one officer full crm screen from
// each and everybody."
//
// READ-ONLY, and behind `manage_team` — the same authority as the roster above,
// because this answers "what is every officer's book worth" rather than "what is
// mine". It writes nothing, calls no vendor and spends nothing: every figure
// comes out of tables PILOT already keeps.
//
// EVERY ACTIVE INTERNAL STAFF ROW APPEARS, INCLUDING THE ONES AT ZERO. A row
// left out because it had nothing reads as "this person does not exist", which
// is a different claim from "this person has no leads yet" — and on a screen an
// admin uses to walk the team one by one, a missing person is a person nobody
// checks. External (TPO) rows are excluded here for the same reason the door
// above refuses them: a broker is another company's officer, not ours.
//
// ONE STATEMENT, NEVER ONE PER OFFICER. Four aggregates joined onto the roster,
// plus the company and unassigned rows in the same breath. A per-officer loop
// would be twenty round trips on a twenty-person team and would grow with the
// team; this stays one no matter how many officers there are.
//
// A FIGURE THAT CANNOT BE READ COMES BACK NULL, NEVER 0. The Elementix halves
// (contacts unlocked, credits spent) live in tables the leads desk does not
// need, so if they cannot be read the roster is still answered — with those two
// columns null and `elementixKnown:false` saying so out loud, which the screen
// renders as "—". A confident zero here would read as "this officer has not
// used Elementix all month", which is a claim we would not have measured.
// ---------------------------------------------------------------------------

/* The four aggregates, each in its own CTE so a table with nothing in it
   contributes nothing rather than dropping officers out of the join. `leads`
   carries the whole lead desk (`officer_id` is the CRM owner); the two
   `elementix_*` tables carry the CRM plane's own work. */
const CRM_DESK_SQL = (withElementix) => `
  WITH officers AS (
    SELECT id, full_name, email, role
      FROM staff_users
     WHERE is_active = true AND is_external = false
  ),
  lead_stats AS (
    SELECT officer_id AS staff_id,
           count(*)::int AS leads_total,
           count(*) FILTER (WHERE source = 'elementix')::int AS leads_elementix,
           max(last_activity_at) AS last_activity_at
      FROM leads
     WHERE officer_id IS NOT NULL
     GROUP BY officer_id
  )${withElementix ? `,
  trace_stats AS (
    SELECT staff_id, count(*)::int AS contacts_unlocked
      FROM elementix_skip_traces
     WHERE staff_id IS NOT NULL
     GROUP BY staff_id
  ),
  call_stats AS (
    SELECT staff_id, count(*)::int AS credits_month
      FROM elementix_calls
     WHERE paid = true AND staff_id IS NOT NULL
       AND created_at >= date_trunc('month', now())
     GROUP BY staff_id
  )` : ''}
  SELECT 'officer'::text AS kind, o.id::text AS staff_id,
         o.full_name, o.email, o.role,
         COALESCE(l.leads_total, 0) AS leads_total,
         COALESCE(l.leads_elementix, 0) AS leads_elementix,
         ${withElementix ? 'COALESCE(t.contacts_unlocked, 0)' : 'NULL::int'} AS contacts_unlocked,
         ${withElementix ? 'COALESCE(c.credits_month, 0)' : 'NULL::int'} AS credits_month,
         l.last_activity_at,
         date_trunc('month', now()) AS month_start
    FROM officers o
    LEFT JOIN lead_stats l ON l.staff_id = o.id
    ${withElementix ? `LEFT JOIN trace_stats t ON t.staff_id = o.id
    LEFT JOIN call_stats  c ON c.staff_id = o.id` : ''}
  UNION ALL
  /* THE COMPANY ROW COVERS EVERY LEAD, not the sum of the rows above — a lead
     owned by somebody who has since left, or by nobody at all, is still the
     company's. The unassigned row below is what makes the arithmetic legible
     instead of leaving an admin to wonder where the difference went. */
  SELECT 'company', NULL, NULL, NULL, NULL,
         (SELECT count(*)::int FROM leads),
         (SELECT count(*)::int FROM leads WHERE source = 'elementix'),
         ${withElementix ? '(SELECT count(*)::int FROM elementix_skip_traces)' : 'NULL::int'},
         ${withElementix ? `(SELECT count(*)::int FROM elementix_calls
            WHERE paid = true AND created_at >= date_trunc('month', now()))` : 'NULL::int'},
         (SELECT max(last_activity_at) FROM leads),
         date_trunc('month', now())
  UNION ALL
  SELECT 'unassigned', NULL, NULL, NULL, NULL,
         (SELECT count(*)::int FROM leads WHERE officer_id IS NULL),
         (SELECT count(*)::int FROM leads WHERE officer_id IS NULL AND source = 'elementix'),
         NULL::int, NULL::int,
         (SELECT max(last_activity_at) FROM leads WHERE officer_id IS NULL),
         date_trunc('month', now())
  ORDER BY 1, 3`;

router.get('/crm-desk', requirePermission('manage_team'), async (req, res) => {
  const shape = (r) => ({
    id: r.staff_id || null,
    name: r.full_name || null,
    email: r.email || null,
    role: r.role || null,
    leads: r.leads_total == null ? null : Number(r.leads_total),
    elementixLeads: r.leads_elementix == null ? null : Number(r.leads_elementix),
    contactsUnlocked: r.contacts_unlocked == null ? null : Number(r.contacts_unlocked),
    creditsThisMonth: r.credits_month == null ? null : Number(r.credits_month),
    lastActivityAt: r.last_activity_at || null,
  });

  let rows = null;
  let elementixKnown = true;
  let unreadable = null;
  try {
    rows = (await db.query(CRM_DESK_SQL(true))).rows;
  } catch (e) {
    /* THE ROSTER STILL ANSWERS. The two Elementix columns are the ones that can
       be missing (an instance whose CRM-plane migrations have not run yet), and
       losing them must not take the whole company's lead book off the screen —
       but they come back NULL and say why, never 0. */
    unreadable = (db.describeError ? db.describeError(e) : e.message) || 'unreadable';
    elementixKnown = false;
    rows = (await db.query(CRM_DESK_SQL(false))).rows;
  }

  const officers = rows.filter((r) => r.kind === 'officer').map(shape);
  const company = shape(rows.find((r) => r.kind === 'company') || {});
  const unassigned = shape(rows.find((r) => r.kind === 'unassigned') || {});
  res.json({
    officers, company, unassigned,
    // Which calendar month the credit figure covers, read off the SAME clock
    // that counted it (`date_trunc('month', now())` in the statement above) —
    // never recomputed here, or the column header could name a different month
    // from the one the database actually counted.
    monthStart: (rows[0] && rows[0].month_start) || null,
    elementixKnown,
    ...(unreadable ? { elementixProblem: unreadable } : {}),
  });
});

// ---------------------------------------------------------------------------
// THE HISTORY IMPORT
//
// The owner asked to go back to the beginning and give every officer the
// contacts they had already skip traced. The vendor names the unlocker of every
// contact by EMAIL, so this reads the whole history and hands each one to the
// officer whose login did it. Nothing here spends a credit — every person in the
// history is already unlocked.
//
// Gated on `manage_team` because what it really does is map Elementix logins to
// members of staff, which is the same authority as the roster above.
// ---------------------------------------------------------------------------

router.get('/backfill', requirePermission('manage_team'), async (req, res) => {
  const progress = await backfill.progress();
  /* IS IT RUNNING BY ITSELF, AND HOW FAST? Without this the screen shows "still
     to do: 800" and reads as stuck — an owner who has just switched the
     automatic import on needs to see it working, not infer it. The cadence comes
     from the sync module rather than being restated here, so the number on the
     screen is the number the timer actually uses. */
  let auto = null;
  try {
    const sync = require('../sync/elementix-crm-sync');
    const i = sync._internals;
    auto = {
      on: sync.autoImportOn(),
      perPass: i.WORK_BATCH,
      everyMinutes: Math.max(1, Math.round(i.WORK_INTERVAL_MS / 60000)),
    };
  } catch (_) { auto = null; }
  res.json({ ...progress, auto });
});

router.post('/backfill/list', requirePermission('manage_team'), async (req, res) => {
  const out = await backfill.listUnlocked({ staffId: req.actor.id });
  await audit(req, 'elementix_backfill_listed', {
    people: out.peopleSeen, queued: out.newlyQueued, users: (out.users || []).length, partial: out.partial || null });
  // A listing that stopped early is answered 200 WITH its own partial flag, not
  // as an error: what it did read is real and is already queued, and the screen
  // has to be able to say both things at once.
  res.json(out);
});

router.post('/backfill/work', requirePermission('manage_team'), async (req, res) => {
  const out = await backfill.workBatch({ staffId: req.actor.id, limit: (req.body || {}).limit });
  if (!out || out.ok !== true) return refuse(res, out);
  res.json(out);
});

router.post('/backfill/users/link', requirePermission('manage_team'), async (req, res) => {
  const b = req.body || {};
  const out = await backfill.linkUser({
    email: b.email, staffId: b.staffId || null, ignore: b.ignore === true, actorId: req.actor.id });
  if (!out || out.ok !== true) return refuse(res, out);
  await audit(req, 'elementix_user_linked', { email: out.email, staffId: out.staffId, ignored: out.ignored });
  // Contacts already imported for that login are waiting on exactly this answer.
  const released = out.staffId ? await backfill.releaseSkipped({ email: out.email }) : { requeued: 0 };
  res.json({ ...out, requeued: released.requeued });
});

// ---------------------------------------------------------------------------
// THE ALLOWANCE — shown on the search sheet so nobody spends blind
// ---------------------------------------------------------------------------

router.get('/usage', async (req, res) => {
  const [usage, budget] = await Promise.all([client.usage(), Promise.resolve(client.budget())]);
  res.json({
    ...usage,
    perSec: budget.perSec, maxPerSec: budget.maxPerSec,
    maxPerHour: budget.maxPerHour,
    platformCeilingPerHour: budget.platformCeilingPerHour,
    note: budget.note,
    enabled: client.enabled(), dryrun: client.dryrun(),
  });
});

// ---------------------------------------------------------------------------
// FINDING A PERSON — the manual "Add lead from Elementix"
// ---------------------------------------------------------------------------

router.get('/search', async (req, res) => {
  const q = str(req.query.q);
  const state = str(req.query.state).toUpperCase();
  if (q.length < 3) {
    return res.status(400).json({ error: 'Type at least three letters of the name.' });
  }
  const args = { query: q, entityFilter: 'person' };
  if (/^[A-Z]{2}$/.test(state)) args.state = state;
  const out = await crmTools.call('search', args, { staffId: req.actor.id });
  if (!out || out.ok !== true) return refuse(res, out, 502);

  const rows = crmTools.rowsOf(out.data).map((r) => ({
    personId: r.id || null,
    name: r.name || r.displayName || null,
    state: r.state || null,
    type: r.entityType || r.type || null,
    url: r._url || null,
    // Everything else the vendor sent, so a picker can show more without a
    // second round trip and without this route guessing which fields matter.
    raw: r,
  })).filter((r) => r.personId);

  // Which of these we ALREADY hold, so the picker can say "already in the CRM"
  // instead of offering to buy a contact we have paid for once already.
  const known = rows.length
    ? (await db.query(
      `SELECT p.person_id, c.person_id IS NOT NULL AS has_contact,
              (SELECT count(*)::int FROM leads l WHERE l.elementix_person_id = p.person_id) AS leads
         FROM elementix_persons p
         LEFT JOIN elementix_contacts c ON c.person_id = p.person_id
        WHERE p.person_id = ANY($1::text[])`, [rows.map((r) => r.personId)])).rows
    : [];
  const byId = new Map(known.map((k) => [k.person_id, k]));
  for (const r of rows) {
    const k = byId.get(r.personId);
    r.inPilot = !!k;
    r.hasContact = !!(k && k.has_contact);
    r.leadCount = k ? k.leads : 0;
  }
  /* HOW MANY THE VENDOR WAS WILLING TO SEND — read off its own answer, never
     hand-typed. The search envelope states `resultLimit` (20 today), and a
     number transcribed into our code is a number that goes stale silently the
     day they change it: a full page would stop reading as "there are more" and
     an officer would be told these are all the matches when they are not. With
     no stated limit we claim NOTHING rather than guess. */
  const cap = Number((out.data && (out.data.resultLimit || out.data.result_limit)) || 0);
  const capped = Number.isFinite(cap) && cap > 0 ? cap : null;
  res.json({
    results: rows,
    resultLimit: capped,
    total: crmTools.totalOf(out.data),
    truncated: capped != null && rows.length >= capped,
  });
});

/**
 * FREE. The question this answers is not "is it unlocked" — it is WILL THE NEXT
 * CLICK COST MONEY, and the screen must not have to work that out from the shape
 * of the row it gets back.
 *
 * OUR OWN DATABASE IS ASKED FIRST AND IS DECISIVE, the same order `crm.skipTrace`
 * uses and for the same reason: contact detail we already hold is proof we have
 * already paid, it needs no network round trip, and it cannot be wrong. The
 * vendor is asked only when we hold nothing.
 *
 * A VENDOR THAT CANNOT BE ASKED IS SAID OUT LOUD (`statusKnown:false`) rather
 * than answered as a confident "not unlocked" — an unreadable status is not
 * evidence that nobody has unlocked them, and rendering it as one would put a
 * "this spends a credit" warning on a person we already own.
 */
router.get('/people/:personId/contact', async (req, res) => {
  const personId = str(req.params.personId);
  if (!isUuid(personId)) return res.status(400).json({ error: 'That is not a person from a search result.' });

  const held = await db.query(
    `SELECT person_id, phones, emails, addresses, unlocked_by, unlocked_by_email,
            unlocked_at, vendor_unlocked_at, source, refreshed_at,
            -- COUNTED BY SHAPE, NOT BY FAITH. jsonb_array_length RAISES on a
            -- value that is not an array, and this endpoint is the one that
            -- answers "will the next click cost money" — a 500 here leaves the
            -- screen unable to tell free from paid. Anything that is not an
            -- array holds no contact detail we can count, which is the honest
            -- answer as well as the safe one.
            CASE WHEN jsonb_typeof(phones) = 'array' THEN jsonb_array_length(phones) ELSE 0 END AS phone_count,
            CASE WHEN jsonb_typeof(emails) = 'array' THEN jsonb_array_length(emails) ELSE 0 END AS email_count
       FROM elementix_contacts WHERE person_id = $1`, [personId]);
  const row = held.rows[0] || null;
  const haveDetail = !!(row && (row.phone_count > 0 || row.email_count > 0));

  /* THIS ROUTE ANSWERS ONE QUESTION — "will the next click cost money" — AND IT
     ANSWERS ONLY THAT. It is deliberately unscoped, because an officer has to be
     able to ask the price of a person they have not attached to anything yet;
     which is exactly why it may not carry the contact DETAIL. Returning the
     stored row whole handed any internal officer the phone numbers and emails of
     a borrower the scoped doors answer 403 for, two hops from a name (search →
     contact), and left no audit row behind. The COUNTS are the price; the
     numbers themselves are what the scoped doors are for. */
  const stored = row && {
    person_id: row.person_id,
    phoneCount: row.phone_count,
    emailCount: row.email_count,
    unlockedAt: row.vendor_unlocked_at || row.unlocked_at,
    source: row.source,
    refreshedAt: row.refreshed_at,
  };

  // Already ours: answer without spending a slot of the shared hourly allowance.
  if (haveDetail) {
    return res.json({
      ok: true, unlocked: true, statusKnown: true,
      free: true, freeReason: 'already_stored', stored,
    });
  }

  const state = await crm.contactState(personId, { staffId: req.actor.id });
  if (state.ok !== true) {
    return res.json({
      ok: true, unlocked: null, statusKnown: false,
      free: false, freeReason: null,
      statusProblem: { reason: state.reason || 'unavailable', detail: state.detail || 'Elementix could not be reached.' },
      stored,
    });
  }
  res.json({
    ...state, statusKnown: true,
    free: !!state.unlocked,
    freeReason: state.unlocked ? 'unlocked_at_elementix' : null,
    stored,
  });
});

// ---------------------------------------------------------------------------
// THE SKIP TRACE — the one thing here that spends money
// ---------------------------------------------------------------------------

router.post('/people/:personId/skip-trace', async (req, res) => {
  const personId = str(req.params.personId);
  const reason = str(req.body && req.body.reason);
  if (!isUuid(personId)) return res.status(400).json({ error: 'That is not a person from a search result.' });
  // TWO LAYERS, AND THEY REFUSE DIFFERENT THINGS. crm.skipTrace refuses a BLANK
  // reason on its own, so this is not merely a friendlier copy of it: what this
  // line catches is a reason too short to mean anything to whoever reads the
  // spend back a month later. Removing it would let "hm" through and buy a
  // contact against it — which is what the route test proves.
  if (reason.length < 4) {
    return res.status(400).json({ error: 'Say in a few words why you are looking this person up — it is recorded against the credit that gets spent.' });
  }
  const out = await crm.skipTrace({
    personId, staffId: req.actor.id, reason,
    name: str(req.body && req.body.name) || null,
    state: str(req.body && req.body.state).toUpperCase() || null,
  });
  if (!out || out.ok !== true) {
    await audit(req, 'elementix_skip_trace_refused', { personId, reason: out && out.reason }, personId);
    return refuse(res, out, 502);
  }
  await audit(req, 'elementix_skip_trace', { personId, charged: !!out.charged, leadId: out.leadId || null, why: reason }, personId);
  res.json(out);
});

/**
 * No money: make a lead from a person whose contact we already hold.
 *
 * IT HAS TO CHECK THAT WE ACTUALLY HOLD THEM. `finishSkipTrace` cannot spend a
 * credit, so calling it on a LOCKED person costs nothing directly — but it reads
 * the contact, gets nothing back, and records the trace as PENDING. The settle
 * pass then polls that person every couple of minutes for 48 hours, spending
 * free calls out of the allowance the whole organisation shares, on somebody who
 * was never unlocked and never will be by this door. One mistyped id is cheap;
 * a screen looping on this is not.
 *
 * Asked in the same order as everywhere else on this plane: our own database
 * first (detail we hold is proof we already paid), the vendor second. A person
 * nobody has unlocked is told so, and pointed at the door that can do it.
 */
router.post('/people/:personId/lead', async (req, res) => {
  const personId = str(req.params.personId);
  if (!isUuid(personId)) return res.status(400).json({ error: 'That is not a person from a search result.' });

  const held = await db.query(
    `SELECT CASE WHEN jsonb_typeof(phones) = 'array' THEN jsonb_array_length(phones) ELSE 0 END
          + CASE WHEN jsonb_typeof(emails) = 'array' THEN jsonb_array_length(emails) ELSE 0 END AS n
       FROM elementix_contacts WHERE person_id = $1`, [personId]);
  const ours = !!(held.rows[0] && held.rows[0].n > 0);
  if (!ours) {
    const st = await crm.contactState(personId, { staffId: req.actor.id });
    if (st.ok !== true) return refuse(res, st, 502);
    if (!st.unlocked) {
      return res.status(409).json({ reason: 'not_unlocked',
        error: 'Nobody here has looked this person up yet, so there are no details to add. Use “look them up” instead — that one spends a credit.' });
    }
  }

  const out = await crm.finishSkipTrace({
    personId, staffId: req.actor.id,
    reason: str(req.body && req.body.reason) || 'Added from Elementix',
    name: str(req.body && req.body.name) || null,
    state: str(req.body && req.body.state).toUpperCase() || null,
    charged: false, source: 'already_unlocked',
  });
  if (!out || out.ok !== true) return refuse(res, out, 502);
  await audit(req, 'elementix_lead_added', { personId, leadId: out.leadId || null }, personId);
  res.json(out);
});

// ---------------------------------------------------------------------------
// THE PROFILE
// ---------------------------------------------------------------------------

/* WHOSE PERSON IS THIS? — one predicate, used by every profile door.
 *
 * "Seen" is not enough on its own: a person attached to somebody else's borrower
 * has been seen by PILOT and has nothing to do with the officer asking. So the
 * link has to be one THIS officer can already see, through the SAME shared
 * fragments `/link` and `/for` use — never a second copy of a scope.
 *
 * The bare header row stays a legitimate way in, and deliberately so: that is
 * the finder's own flow (search, then attach), where nobody has linked anything
 * yet. What it can never be is a way to read a profile that belongs to another
 * officer's client, or to spend forty of the organisation's calls building one.
 */
async function seenByActor(req, personId) {
  if (!isUuid(personId)) return { seen: false, bad: true };
  const all = can(req.actor, 'see_all_files');
  /* A HEADER ROW IS NOT A RELATIONSHIP. Accepting "PILOT has heard of this
     person" let every internal officer read any profile on the plane, because a
     header row is written for everybody we ever look up. What makes a person
     YOURS is a lead or a borrower you can already see — or your own paid lookup,
     which is the one case that can briefly exist before either. The screen links
     BEFORE it builds (ElementixProfile.linkTo), so the ordinary flow is covered. */
  const sql = all
    ? `SELECT EXISTS (SELECT 1 FROM leads     WHERE elementix_person_id = $1)
            OR EXISTS (SELECT 1 FROM borrowers WHERE elementix_person_id = $1)
            OR EXISTS (SELECT 1 FROM elementix_skip_traces WHERE person_id = $1) AS seen`
    : `SELECT EXISTS (SELECT 1 FROM leads t     WHERE t.elementix_person_id = $1 AND (${visibleLeadSql('t', '$2')}))
            OR EXISTS (SELECT 1 FROM borrowers t WHERE t.elementix_person_id = $1 AND (${visibleBorrowerSql('t', '$2')}))
            OR EXISTS (SELECT 1 FROM elementix_skip_traces WHERE person_id = $1 AND staff_id = $2::uuid) AS seen`;
  try {
    const r = await db.query(sql, all ? [personId] : [personId, req.actor.id]);
    return { seen: r.rows[0] && r.rows[0].seen === true };
  } catch (_) {
    // An unreadable scope is not evidence of access.
    return { seen: false, unreadable: true };
  }
}

function refuseSeen(res, v) {
  if (v.bad) return res.status(400).json({ error: 'That is not a person from a search result.' });
  if (v.unreadable) return res.status(503).json({ error: 'PILOT could not check who that record belongs to. Try again in a moment.' });
  return res.status(404).json({ reason: 'not_found',
    error: 'PILOT has no record of that Elementix person on anything you can see. Search for them and attach them first.' });
}

/**
 * MAY THIS OFFICER OPEN THIS PROPERTY?
 *
 * A property is reached THROUGH a person, so the answer is the person's: the
 * caller names the person whose record the row came from, that person goes
 * through the ordinary `seenByActor` gate, and then the address must actually
 * appear in that person's own cached rows. Both halves matter. Without the
 * first, a typed uuid opens any property on the plane; without the second, an
 * officer who can see ONE person could read any property in the country by
 * pasting its id and naming their own lead — and every one of those reads spends
 * the organisation's shared hourly allowance.
 *
 * FAILS CLOSED: an unreadable profile is not evidence of access.
 */
async function addressSeenByActor(req, addressId, personId) {
  if (!isUuid(addressId)) return { seen: false, bad: true };
  const v = await seenByActor(req, personId);
  if (!v.seen) return v;
  try {
    const prof = await profile.readProfile(personId);
    if (!prof || prof.ok !== true) return { seen: false, unreadable: true };
    const want = String(addressId).toLowerCase();
    const hit = (row) => {
      if (!row || typeof row !== 'object') return false;
      if (String(row.addressId || row.address_id || '').toLowerCase() === want) return true;
      for (const b of [row.propertyAddresses, row.property_addresses, row.addresses]) {
        if (Array.isArray(b) && b.some((a) => a && String(a.id || '').toLowerCase() === want)) return true;
      }
      const ids = Array.isArray(row.addressesIds) ? row.addressesIds : [];
      return ids.some((x) => String(x || '').toLowerCase() === want);
    };
    for (const sec of Object.values(prof.sections || {})) {
      if ((sec.rows || []).some(hit)) return { seen: true };
    }
    return { seen: false, notOnPerson: true };
  } catch (_) {
    return { seen: false, unreadable: true };
  }
}

function refuseAddress(res, v) {
  if (v.bad) return res.status(400).json({ error: 'That is not a property from an Elementix record.' });
  if (v.unreadable) return res.status(503).json({ error: 'PILOT could not check who that record belongs to. Try again in a moment.' });
  if (v.notOnPerson) {
    return res.status(404).json({ reason: 'not_found',
      error: 'That property is not on this person’s record in PILOT. Open it from one of their own rows.' });
  }
  return refuseSeen(res, v);
}

/* THE CACHE. Never calls Elementix, so it is safe on render and on every open. */
router.get('/addresses/:addressId', async (req, res) => {
  const addressId = str(req.params.addressId);
  const personId = str(req.query.personId);
  const v = await addressSeenByActor(req, addressId, personId);
  if (!v.seen) return refuseAddress(res, v);
  const out = await elxAddress.readAddress(addressId);
  if (!out || out.ok !== true) return refuse(res, out);
  res.json(out);
});

/* THE DELIBERATE READ. Three to five requests out of the organisation's shared
   1,000 an hour, so it is a button and never a side effect. Free of charge:
   none of the three tools it can reach is the paid one. */
router.post('/addresses/:addressId/read', async (req, res) => {
  const addressId = str(req.params.addressId);
  const body = req.body || {};
  const personId = str(body.personId);
  const v = await addressSeenByActor(req, addressId, personId);
  if (!v.seen) return refuseAddress(res, v);
  const out = await elxAddress.buildAddress(addressId, { staffId: req.actor.id, force: body.force === true });
  if (!out || out.ok !== true) return refuse(res, out);
  await audit(req, 'elementix_address_read', {
    addressId, personId, calls: out.callsSpent || 0, cached: !!out.cached });
  res.json(out);
});

router.get('/people/:personId/profile', async (req, res) => {
  const personId = str(req.params.personId);
  const v = await seenByActor(req, personId);
  if (!v.seen) return refuseSeen(res, v);
  const out = await profile.readProfile(personId);
  if (!out || out.ok !== true) return refuse(res, out);
  const candidates = await profile.openAliasCandidates(out.personId);
  res.json({ ...out, aliasCandidates: candidates });
});

router.post('/people/:personId/profile/build', async (req, res) => {
  const personId = str(req.params.personId);
  const body = req.body || {};
  /* A PROFILE IS BUILT FOR SOMEBODY WE HAVE SEEN, NEVER FOR A TYPED ID.
     This is the most expensive button on the plane — up to forty outbound calls
     across eight paged sections — and it used to accept any well-formed UUID,
     create a nameless header row for it, and spend the whole budget out of an
     allowance the entire organisation shares. Every real caller attaches the
     person first (the finder and the profile screen both link, which is what
     writes the row), so requiring it costs nothing legitimate and closes the
     hole. Same rule as joining two records: a judgement about a person who
     exists, never a way to invent one. */
  /* "SEEN" MEANS EITHER: we hold a header row for them, OR they are attached to
     a lead or a borrower. The link is every bit as good as the header — it is
     what a human did — and `leads.elementix_person_id` carries no foreign key,
     so a link can outlive its header row. Accepting both means the button never
     dead-ends on a record somebody is looking straight at, while a typed id
     still gets nowhere. */
  const v = await seenByActor(req, personId);
  if (!v.seen) return refuseSeen(res, v);
  const out = await profile.buildProfile(personId, {
    staffId: req.actor.id,
    force: body.force === true,
    sections: Array.isArray(body.sections) ? body.sections : undefined,
  });
  if (!out || out.ok !== true) return refuse(res, out);
  await audit(req, 'elementix_profile_built', { personId, calls: out.callsSpent, force: body.force === true }, personId);
  const view = await profile.readProfile(personId);
  res.json({ ...out, profile: view.ok ? view : null });
});

router.get('/people/:personId/aliases', async (req, res) => {
  const personId = str(req.params.personId);
  if (!isUuid(personId)) return res.status(400).json({ error: 'That is not a person from a search result.' });
  res.json({ candidates: await profile.openAliasCandidates(personId) });
});

router.post('/people/:personId/aliases/:aliasId', async (req, res) => {
  /* MERGING TWO RECORDS IS THE MOST EXPENSIVE JUDGEMENT ON THIS PLANE — it joins
     a stranger's properties and loans onto somebody's profile — so it is scoped
     exactly like reading one. `decideAlias` already refuses an id PILOT has never
     seen and demands a signed-in human; this adds "and it has to be yours". */
  const personId = str(req.params.personId);
  const aliasId = str(req.params.aliasId);
  if (!isUuid(personId) || !isUuid(aliasId)) {
    return res.status(400).json({ error: 'That is not a person from a search result.' });
  }
  const v = await seenByActor(req, personId);
  if (!v.seen) return refuseSeen(res, v);
  const out = await profile.decideAlias({
    personId,
    aliasPersonId: aliasId,
    staffId: req.actor.id,
    confirm: (req.body || {}).confirm === true,
  });
  if (!out || out.ok !== true) return refuse(res, out);
  await audit(req, out.confirmed ? 'elementix_alias_confirmed' : 'elementix_alias_rejected',
    { personId: req.params.personId, aliasPersonId: req.params.aliasId }, str(req.params.personId));
  res.json(out);
});

// ---------------------------------------------------------------------------
// LINKING A PERSON TO WHAT WE ALREADY HOLD
// ---------------------------------------------------------------------------

const LINKABLE = { lead: 'leads', borrower: 'borrowers' };

/**
 * MAY THIS STAFFER TOUCH THIS RECORD?
 *
 * Being signed in as internal staff is what gets you through the door of this
 * router; it is NOT permission to reach into any lead or any borrower in the
 * company by typing its id. Without this, one officer could overwrite the
 * Elementix person another officer had attached to their own lead, and anybody
 * could read the whole merged profile — every property, every mortgage, every
 * company — of a borrower they have no business with.
 *
 * The rules are the ones the rest of PILOT already applies, reached through the
 * SHARED fragments in lib/permissions rather than re-typed here: a lead is yours
 * or unassigned (`visibleLeadSql`), a borrower is one you own or have a file
 * with (`visibleBorrowerSql`), and `see_all_files` reaches everything.
 *
 * It answers `{ found, allowed }` so a refusal can tell "no such record" from
 * "not yours" — 404 and 403 are different sentences to whoever is reading them.
 * A read error is NOT allowed: an unreadable scope is not evidence of access.
 */
async function recordScope(req, kind, recordId) {
  const table = LINKABLE[kind];
  if (!table) return { found: false, allowed: false };
  try {
    if (can(req.actor, 'see_all_files')) {
      const r = await db.query(`SELECT 1 FROM ${table} WHERE id = $1`, [recordId]);
      return { found: !!r.rowCount, allowed: !!r.rowCount };
    }
    const scope = kind === 'lead' ? visibleLeadSql('t', '$2') : visibleBorrowerSql('t', '$2');
    const r = await db.query(
      `SELECT (${scope}) AS allowed FROM ${table} t WHERE t.id = $1`, [recordId, req.actor.id]);
    if (!r.rowCount) return { found: false, allowed: false };
    return { found: true, allowed: r.rows[0].allowed === true };
  } catch (_) { return { found: false, allowed: false, unreadable: true }; }
}

/** The one refusal both linking routes give, so they cannot word it differently. */
function refuseScope(res, scope) {
  if (scope.unreadable) return res.status(503).json({ error: 'PILOT could not check who that record belongs to. Try again in a moment.' });
  if (!scope.found) return res.status(404).json({ error: 'That record could not be found.' });
  return res.status(403).json({ error: 'That belongs to another officer.' });
}

/**
 * Attach an Elementix person to a CRM lead or a borrower profile.
 *
 * FILL-ONLY BY DEFAULT: a link somebody already made is not replaced by a later
 * one unless the caller says `replace` explicitly, because the usual way a
 * second link arrives is a search that matched a namesake.
 */
router.post('/link', async (req, res) => {
  const b = req.body || {};
  const kind = str(b.kind);
  const table = LINKABLE[kind];
  const recordId = str(b.recordId);
  const personId = str(b.personId);
  if (!table) return res.status(400).json({ error: 'A person is attached to a lead or to a borrower.' });
  if (!isUuid(recordId)) return res.status(400).json({ error: 'That record could not be found.' });
  if (personId && !isUuid(personId)) return res.status(400).json({ error: 'That is not a person from a search result.' });

  const scope = await recordScope(req, kind, recordId);
  if (!scope.allowed) return refuseScope(res, scope);

  if (!personId) {
    const r = await db.query(`UPDATE ${table} SET elementix_person_id = NULL WHERE id = $1 RETURNING id`, [recordId]);
    if (!r.rowCount) return res.status(404).json({ error: 'That record could not be found.' });
    await audit(req, 'elementix_link_cleared', { kind, recordId }, recordId);
    return res.json({ ok: true, personId: null });
  }

  await crm.ensurePerson({ personId, name: str(b.name) || null, state: str(b.state).toUpperCase() || null });
  const sql = b.replace === true
    ? `UPDATE ${table} SET elementix_person_id = $2 WHERE id = $1 RETURNING elementix_person_id`
    : `UPDATE ${table} SET elementix_person_id = COALESCE(elementix_person_id, $2) WHERE id = $1 RETURNING elementix_person_id`;
  const r = await db.query(sql, [recordId, personId]);
  if (!r.rowCount) return res.status(404).json({ error: 'That record could not be found.' });
  await audit(req, 'elementix_link_set', { kind, recordId, personId, replaced: b.replace === true }, recordId);
  res.json({ ok: true, personId: r.rows[0].elementix_person_id, changed: r.rows[0].elementix_person_id === personId });
});

/** What is attached to this lead / borrower, and its profile if there is one. */
router.get('/for/:kind/:recordId', async (req, res) => {
  const table = LINKABLE[str(req.params.kind)];
  const recordId = str(req.params.recordId);
  if (!table) return res.status(400).json({ error: 'A person is attached to a lead or to a borrower.' });
  if (!isUuid(recordId)) return res.status(400).json({ error: 'That record could not be found.' });
  const scope = await recordScope(req, str(req.params.kind), recordId);
  if (!scope.allowed) return refuseScope(res, scope);
  const r = await db.query(`SELECT elementix_person_id FROM ${table} WHERE id = $1`, [recordId]);
  if (!r.rowCount) return res.status(404).json({ error: 'That record could not be found.' });
  const personId = r.rows[0].elementix_person_id;
  if (!personId) return res.json({ linked: false, personId: null, profile: null, contact: null });

  /* THE CONTACT DETAILS RIDE ALONG. The owner asked for the lead to carry "all
     the contact information — all phone numbers and their names, all details",
     and every one of them IS stored: `normalizeContact` keeps each number with
     the vendor's own label, carrier, location, deliverability and confidence
     score, plus every email with its verdict and the person's mailing addresses.
     The LEAD row itself has only `phone` and `phone_alt` — two — so a person
     with five numbers had three sitting in the database that no screen showed.
     Returned here because this section is mounted on the lead AND on the
     borrower profile, which is exactly the pair the owner named. */
  const held = (await db.query(
    `SELECT phones, emails, addresses, raw, unlocked_by_email,
            COALESCE(vendor_unlocked_at, unlocked_at) AS unlocked_at, source, refreshed_at
       FROM elementix_contacts WHERE person_id = $1`, [personId])).rows[0] || null;
  let contact = null;
  if (held) {
    /* The summary, the company and the LinkedIn page are DERIVED on read rather
       than stored: `normalizeContact` already works them out of the vendor's own
       payload, and re-reading it here keeps the screen and the reader in step
       for free — a stored copy would be a second definition to keep current, and
       a migration for three display fields we already hold the source of. */
    let extra = null;
    try { extra = crm.normalizeContact(held.raw).profile; } catch (_) { extra = null; }
    contact = {
      phones: held.phones, emails: held.emails, addresses: held.addresses,
      profile: extra,
      unlockedByEmail: held.unlocked_by_email, unlockedAt: held.unlocked_at,
      source: held.source, refreshedAt: held.refreshed_at,
    };
  }

  const view = await profile.readProfile(personId);
  const candidates = view.ok ? await profile.openAliasCandidates(view.personId) : [];
  res.json({ linked: true, personId, contact,
    profile: view.ok ? { ...view, aliasCandidates: candidates } : null });
});

// ---------------------------------------------------------------------------
// THE LEAD'S PHONE BOOK — the call-log picker and the working / not-working
// marks (owner-directed 2026-08-19). lib/elementix/lead-phones.js is the one
// definition of the union (the lead's own numbers + everything the unlock
// holds, deduped by the plane's shared phoneKey) and of the mark upsert; the
// lead activity route in routes/staff.js delegates to the SAME functions, so
// the picker, the panel and a verdict riding a call log can never disagree.
// Mounted HERE, not on /api/staff/leads, because the union reads the stored
// contact and only this router (+ lib/elementix) may — which also means these
// routes inherit the internal-only door, the external-staff refusal and the
// per-officer throttle for free. A mark NEVER removes a number.
// ---------------------------------------------------------------------------
const leadPhones = require('../lib/elementix/lead-phones');

router.get('/leads/:leadId/phones', async (req, res) => {
  const leadId = str(req.params.leadId);
  if (!isUuid(leadId)) return res.status(400).json({ error: 'That record could not be found.' });
  const scope = await recordScope(req, 'lead', leadId);
  if (!scope.allowed) return refuseScope(res, scope);
  const out = await leadPhones.leadPhonesFor(leadId);
  if (!out.found) return res.status(404).json({ error: 'That record could not be found.' });
  res.json(out);
});

router.post('/leads/:leadId/phones/mark', async (req, res) => {
  const b = req.body || {};
  const leadId = str(req.params.leadId);
  if (!isUuid(leadId)) return res.status(400).json({ error: 'That record could not be found.' });
  const scope = await recordScope(req, 'lead', leadId);
  if (!scope.allowed) return refuseScope(res, scope);
  const out = await leadPhones.markLeadPhone({
    leadId, phone: b.phone, status: b.status, rightPerson: b.rightPerson, staffId: req.actor.id,
  });
  if (!out.ok) {
    if (out.reason === 'unknown_number') return res.status(400).json({ error: "That number is not one of this lead's phone numbers." });
    if (out.reason === 'not_found') return res.status(404).json({ error: 'That record could not be found.' });
    return res.status(400).json({ error: 'A mark is working, not working, or clear.' });
  }
  await audit(req, 'elementix_lead_phone_mark',
    { leadId, phoneKey: out.key, status: out.mark.status, rightPerson: out.mark.rightPerson }, leadId);
  res.json(out);
});

module.exports = router;
