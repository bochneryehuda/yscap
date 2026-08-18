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
const oauth = require('../elementix/oauth');
const client = require('../elementix/client');
const crmTools = require('../lib/elementix/crm-tools');
const crm = require('../lib/elementix/crm');
const identity = require('../lib/elementix/identity');
const profile = require('../lib/elementix/profile');

const str = (v) => String(v == null ? '' : v).trim();
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str(v));

router.use(requireAuth, requireStaff);

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
    paid_cap_reached: 429, rate_limited: 429,
    not_connected: 409, disabled: 503, unavailable: 503,
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
    status: mine,
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
  const [connections, missing] = await Promise.all([
    identity.connections(),
    identity.officersNotConnected(),
  ]);
  res.json({ connections, notConnected: missing });
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
  res.json({ results: rows, truncated: rows.length >= 20 });
});

/** FREE. Is this person already unlocked on the account? */
router.get('/people/:personId/contact', async (req, res) => {
  const personId = str(req.params.personId);
  if (!isUuid(personId)) return res.status(400).json({ error: 'That is not a person from a search result.' });
  const state = await crm.contactState(personId, { staffId: req.actor.id });
  const held = await db.query(
    `SELECT phones, emails, addresses, unlocked_by, unlocked_at, source, refreshed_at
       FROM elementix_contacts WHERE person_id = $1`, [personId]);
  res.json({ ...state, stored: held.rows[0] || null });
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

/** No money: make a lead from a person whose contact we already hold. */
router.post('/people/:personId/lead', async (req, res) => {
  const personId = str(req.params.personId);
  if (!isUuid(personId)) return res.status(400).json({ error: 'That is not a person from a search result.' });
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

router.get('/people/:personId/profile', async (req, res) => {
  const out = await profile.readProfile(str(req.params.personId));
  if (!out || out.ok !== true) return refuse(res, out);
  const candidates = await profile.openAliasCandidates(out.personId);
  res.json({ ...out, aliasCandidates: candidates });
});

router.post('/people/:personId/profile/build', async (req, res) => {
  const personId = str(req.params.personId);
  const body = req.body || {};
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
  const out = await profile.decideAlias({
    personId: str(req.params.personId),
    aliasPersonId: str(req.params.aliasId),
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
  const r = await db.query(`SELECT elementix_person_id FROM ${table} WHERE id = $1`, [recordId]);
  if (!r.rowCount) return res.status(404).json({ error: 'That record could not be found.' });
  const personId = r.rows[0].elementix_person_id;
  if (!personId) return res.json({ linked: false, personId: null, profile: null });
  const view = await profile.readProfile(personId);
  const candidates = view.ok ? await profile.openAliasCandidates(view.personId) : [];
  res.json({ linked: true, personId, profile: view.ok ? { ...view, aliasCandidates: candidates } : null });
});

module.exports = router;
