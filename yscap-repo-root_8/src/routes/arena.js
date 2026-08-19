'use strict';
/**
 * THE ARENA API -- the live game board (Elementix Day and every session after).
 *
 * MOUNTED BEHIND TWO WALLS, and the order matters:
 *   1. server.js mounts this with requireAuth + requireStaff, so nothing here
 *      is reachable by a borrower, a broker or an anonymous caller.
 *   2. `settings.guard` then answers 404 to EVERYONE while the master switch is
 *      off -- not 403, because 403 confirms the feature exists, and the owner's
 *      rule is that when it is off "nobody should even see that setting". The
 *      one route in front of the guard is the switch itself, which stays
 *      reachable by a super admin so that "off" is not a one-way door.
 *
 * WHO MAY DO WHAT:
 *   - EVERY internal staffer: see the board, check in, put a prize forward,
 *     claim a qualifier, chat, react, suggest, and verify any past draw.
 *   - SUPER ADMIN only: the switch, the settings, sessions, spins, approvals,
 *     turning the wheel, moderating chat, and the awards export.
 *   Nothing between the two -- the owner asked for super-admin control, and a
 *   halfway permission nobody asked for is a permission nobody audited.
 *
 * EVERY WRITE THAT MATTERS IS AUDITED into the existing `audit_log`, with the
 * same helper shape the rest of the console uses.
 */

const router = require('../lib/safe-router')();
const db = require('../db');
const events = require('../lib/events');
const notify = require('../lib/notify');
const settings = require('../lib/arena/settings');
const rules = require('../lib/arena/entry-rules');
const games = require('../lib/arena/game-types');
const psources = require('../lib/arena/candidate-sources');
const runner = require('../lib/arena/spin-runner');
const rematch = require('../lib/arena/rematch');
const recap = require('../lib/arena/recap');

// The runner has no opinion about transport; this is where it gets one.
runner.setBroadcaster((event, data) => {
  try { events.publishToStaff(event, data); } catch (_) { /* a missed frame must never fail a draw */ }
});

const isSuper = (req) => settings.isSuperAdmin(req.actor);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

/** Same shape as the console's other audit helper: a logging write must never
 *  fail the action it is describing. */
async function audit(req, action, entityType, entityId, detail) {
  let d = detail;
  if (d != null && typeof d !== 'object') d = { note: String(d) };
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, ip_address, user_agent, detail)
       VALUES ('staff',$1,$2,$3,$4,$5,$6,$7)`,
      [req.actor.id, action, entityType, entityId || null, req.ip, req.get('user-agent') || null, d || null]);
  } catch (e) {
    console.warn(`[arena] audit write failed for ${action}: ${(e && e.message) || e}`);
  }
}

/** Super-admin gate. 403 here, not 404: past this point the caller already
 *  knows the Arena exists (the guard let them through), so hiding it again
 *  would only be confusing. */
function requireSuper(req, res, next) {
  if (isSuper(req)) return next();
  return bad(res, 'Only a super admin can do that.', 403);
}

// ===========================================================================
// THE SWITCH -- in FRONT of the guard, super admin only.
// ===========================================================================

router.get('/settings', settings.requireSuperAdmin, async (req, res) => {
  const s = await settings.load({ fresh: true });
  res.json({
    enabled: s.enabled,
    settings: s.settings,
    updatedAt: s.updatedAt,
    // Truthful about a settings row we could not read: the OFF above would then
    // be a fail-closed default rather than the owner's recorded choice.
    readable: s.readable,
    defaults: settings.DEFAULTS,
  });
});

router.put('/settings', settings.requireSuperAdmin, async (req, res) => {
  const { enabled, settings: incoming } = req.body || {};
  if (enabled !== undefined && typeof enabled !== 'boolean') return bad(res, 'The on/off switch has to be true or false.');
  const before = await settings.load({ fresh: true });
  const after = await settings.save({ enabled, settings: incoming }, req.actor.id);
  if (enabled !== undefined && before.enabled !== after.enabled) {
    await audit(req, after.enabled ? 'arena_switched_on' : 'arena_switched_off', 'arena', null, { by: req.actor.id });
    // Everyone's window changes the moment this flips -- turning it off has to
    // clear the screens, not wait for the next refresh.
    try { events.publishToStaff('arena:switch', { enabled: after.enabled }); } catch (_) { /* cosmetic */ }
  } else if (incoming !== undefined) {
    await audit(req, 'arena_settings_changed', 'arena', null, { keys: Object.keys(incoming || {}) });
  }
  // The SAME shape the GET answers, because the panel replaces its whole state
  // with this response — answering a narrower shape made `readable` vanish and
  // the screen showed the red "settings could not be read" banner immediately
  // after every successful save (found by the 2026-08-19 audit).
  res.json({
    enabled: after.enabled, settings: after.settings, updatedAt: after.updatedAt,
    readable: after.readable !== false, defaults: settings.DEFAULTS,
  });
});

/**
 * WHAT THIS PERSON SEES -- the one call the nav makes on every load.
 * In FRONT of the guard on purpose: when the Arena is off this must still
 * answer, and answer "nothing", rather than 404 and make the nav guess.
 */
router.get('/visibility', async (req, res) => {
  const on = await settings.isEnabled();
  const v = settings.visibilityFor(req.actor, on);
  let live = null;
  if (v.seesArena) {
    const r = await db.query(
      `SELECT id, name, subtitle, theme FROM arena_sessions WHERE state = 'live' LIMIT 1`);
    live = r.rows[0] || null;
  }
  res.json({ enabled: on, seesArena: v.seesArena, seesSwitch: v.seesSwitch, isSuperAdmin: isSuper(req), liveSession: live });
});

// ===========================================================================
// Everything below this line does not exist while the switch is off.
// ===========================================================================
router.use(settings.guard);

// PART TWO — challenges, the stop button, the templates and the AI helper.
// Mounted HERE, after `settings.guard`, so it inherits the master switch: while
// the Arena is off, none of it exists either.
router.use('/', require('./arena-play'));

/** The catalogs the admin console renders from. Generated, never hand-listed. */
router.get('/catalog', async (req, res) => {
  res.json({
    games: games.describeGames(),
    families: games.FAMILIES,
    sources: psources.describeSources(),
    weightModes: psources.WEIGHT_MODES,
    baseDefaults: games.BASE_DEFAULTS,
  });
});

// ---------------------------------------------------------------- sessions

router.get('/sessions', async (req, res) => {
  const r = await db.query(
    `SELECT s.*,
            (SELECT count(*) FROM arena_spins  p WHERE p.session_id = s.id)  AS spin_count,
            (SELECT count(*) FROM arena_awards a WHERE a.session_id = s.id)  AS award_count
       FROM arena_sessions s
      ORDER BY (s.state = 'live') DESC, s.created_at DESC
      LIMIT 100`);
  res.json({ sessions: r.rows });
});

router.post('/sessions', requireSuper, async (req, res) => {
  const { name, subtitle, theme, startsAt, endsAt, staffIds } = req.body || {};
  const title = String(name || '').trim();
  if (!title) return bad(res, 'Give the session a name.');
  const r = await db.query(
    `INSERT INTO arena_sessions (name, subtitle, theme, starts_at, ends_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [title, subtitle || null, theme || 'midnight', startsAt || null, endsAt || null, req.actor.id]);
  const session = r.rows[0];
  if (Array.isArray(staffIds) && staffIds.length) await setMembers(session.id, staffIds, req.actor.id);
  await audit(req, 'arena_session_created', 'arena_session', session.id, { name: title });
  res.status(201).json({ session });
});

async function setMembers(sessionId, staffIds, byId) {
  const ids = [...new Set((staffIds || []).map(String).filter(Boolean))];
  // Mark everyone out first, then re-add — so the roster ends up exactly as
  // sent, and somebody removed keeps their row (and their history) rather than
  // vanishing from the record.
  await db.query(`UPDATE arena_session_members SET removed_at = now() WHERE session_id = $1 AND removed_at IS NULL`, [sessionId]);
  for (const id of ids) {
    await db.query(
      `INSERT INTO arena_session_members (session_id, staff_id, added_by)
       VALUES ($1,$2,$3)
       ON CONFLICT (session_id, staff_id) DO UPDATE SET removed_at = NULL, added_at = now()`,
      [sessionId, id, byId || null]);
  }
  return ids.length;
}

router.put('/sessions/:id', requireSuper, async (req, res) => {
  const { name, subtitle, theme, startsAt, endsAt, staffIds } = req.body || {};
  const r = await db.query(
    `UPDATE arena_sessions
        SET name = COALESCE($2, name), subtitle = COALESCE($3, subtitle), theme = COALESCE($4, theme),
            starts_at = COALESCE($5, starts_at), ends_at = COALESCE($6, ends_at), updated_at = now()
      WHERE id = $1 RETURNING *`,
    [req.params.id, name || null, subtitle || null, theme || null, startsAt || null, endsAt || null]);
  if (!r.rows[0]) return bad(res, 'That session does not exist.', 404);
  if (Array.isArray(staffIds)) await setMembers(req.params.id, staffIds, req.actor.id);
  await audit(req, 'arena_session_updated', 'arena_session', req.params.id, {});
  res.json({ session: r.rows[0] });
});

router.post('/sessions/:id/state', requireSuper, async (req, res) => {
  const want = String((req.body || {}).state || '');
  if (!['draft', 'live', 'closed', 'paused'].includes(want)) return bad(res, 'A session can be draft, live, paused or closed.');
  const prior = (await db.query(`SELECT * FROM arena_sessions WHERE id = $1`, [req.params.id])).rows[0];
  if (!prior) return bad(res, 'That session does not exist.', 404);

  // PAUSE / RESUME. Pause is a stamp, not a state value (db/593): the session
  // stays live on the board, but the clockwork stops — nothing launches
  // itself, no alarms go out, no door shuts, no challenge opens — until it is
  // resumed. Nothing is announced either way: a pause is the admin catching
  // their breath, not news for the whole company.
  if (want === 'paused') {
    if (prior.state !== 'live') return bad(res, 'Only a live session can be paused.');
    const r = await db.query(
      `UPDATE arena_sessions SET paused_at = COALESCE(paused_at, now()), updated_at = now()
        WHERE id = $1 RETURNING *`, [req.params.id]);
    await audit(req, 'arena_session_paused', 'arena_session', req.params.id, {});
    events.publishToStaff('arena:session', { sessionId: req.params.id, state: 'paused' });
    return res.json({ session: r.rows[0] });
  }

  if (want === 'live') {
    if (prior.state === 'live' && prior.paused_at) {
      // A RESUME, not a start: clear the stamp and say nothing — the team was
      // already told the day began.
      const r = await db.query(
        `UPDATE arena_sessions SET paused_at = NULL, updated_at = now() WHERE id = $1 RETURNING *`, [req.params.id]);
      await audit(req, 'arena_session_resumed', 'arena_session', req.params.id, {});
      events.publishToStaff('arena:session', { sessionId: req.params.id, state: 'live' });
      return res.json({ session: r.rows[0] });
    }
    // Only one session can be live -- the database enforces it, and this turns
    // that constraint into a sentence a person can act on instead of a 500.
    const other = await db.query(`SELECT id, name FROM arena_sessions WHERE state = 'live' AND id <> $1`, [req.params.id]);
    if (other.rows[0]) return bad(res, `"${other.rows[0].name}" is live right now. Close it before starting another.`);
  }
  const r = await db.query(
    `UPDATE arena_sessions
        SET state = $2,
            opened_at = CASE WHEN $2 = 'live'   THEN COALESCE(opened_at, now()) ELSE opened_at END,
            closed_at = CASE WHEN $2 = 'closed' THEN now() ELSE NULL END,
            paused_at = CASE WHEN $2 = 'live'   THEN NULL ELSE paused_at END,
            updated_at = now()
      WHERE id = $1 RETURNING *`, [req.params.id, want]);
  if (!r.rows[0]) return bad(res, 'That session does not exist.', 404);
  await audit(req, `arena_session_${want}`, 'arena_session', req.params.id, {});
  events.publishToStaff('arena:session', { sessionId: req.params.id, state: want });
  // Announced only when the day actually BEGINS. A session that was live
  // before (paused, or briefly put back to draft) already told everybody.
  if (want === 'live' && !prior.opened_at) await announceSessionLive(r.rows[0]).catch(() => {});
  // Closing the day sends ONE round-up of everything that was won — the owner's
  // "final nice notifications for everybody that is involved in the game".
  if (want === 'closed') {
    require('../lib/arena/announce').sessionClosed(r.rows[0])
      .then((x) => { if (x && x.sent) console.log(`[arena] wrap-up sent to ${x.sent}`); })
      .catch((e) => console.warn(`[arena] wrap-up failed: ${(e && e.message) || e}`));
  }
  res.json({ session: r.rows[0] });
});

/** Tell the people in a session that it has started. */
async function announceSessionLive(session) {
  const s = await settings.load();
  if (!s.settings.emailResults) return 0;
  const people = await sessionPeople(session.id);
  for (const p of people) {
    await notify.notifyStaff(p.id, {
      type: 'arena_session_live',
      title: `${session.name} has started`,
      body: `${session.name} is live now. Open it to check in and join the spins.`,
      link: '/internal/arena',
      ctaLabel: 'Open the Arena',
    }).catch(() => {});
  }
  return people.length;
}

/** Everyone in a session -- the picked members, or the whole internal roster. */
async function sessionPeople(sessionId) {
  const m = await db.query(
    `SELECT s.id, s.full_name, s.email, s.role, s.title
       FROM arena_session_members m JOIN staff_users s ON s.id = m.staff_id
      WHERE m.session_id = $1 AND m.removed_at IS NULL AND s.is_active = true AND s.is_external IS NOT TRUE
      ORDER BY s.full_name`, [sessionId]);
  if (m.rows.length) return m.rows;
  const all = await db.query(
    `SELECT id, full_name, email, role, title FROM staff_users
      WHERE is_active = true AND is_external IS NOT TRUE ORDER BY full_name`);
  return all.rows;
}

/**
 * The whole internal roster, BEFORE a session exists — so an admin can pick who
 * is playing on the CREATE form instead of creating first and trimming after
 * (owner-directed 2026-08-19: "Before I click Create Session, I should be able
 * to select who should be part of the session… by groups: back office or sales
 * team"). Super-admin only: it lists every colleague's name, role and email.
 */
router.get('/roster', requireSuper, async (req, res) => {
  const roster = await db.query(
    `SELECT id, full_name, email, role, title FROM staff_users
      WHERE is_active = true AND is_external IS NOT TRUE ORDER BY full_name`);
  res.json({ everyone: roster.rows });
});

// Super-admin only for the same reason as /roster: this answers with every
// colleague's email address, and the one screen that calls it is the control
// room's people picker (found open to any staffer by the 2026-08-19 audit).
router.get('/sessions/:id/people', requireSuper, async (req, res) => {
  const people = await sessionPeople(req.params.id);
  const picked = await db.query(
    `SELECT staff_id FROM arena_session_members WHERE session_id = $1 AND removed_at IS NULL`, [req.params.id]);
  const roster = await db.query(
    `SELECT id, full_name, email, role, title FROM staff_users
      WHERE is_active = true AND is_external IS NOT TRUE ORDER BY full_name`);
  res.json({
    people,
    everyone: roster.rows,
    // No rows means "the whole team", which is what an admin who never opened
    // the picker meant. Said explicitly so the screen does not have to infer it.
    limitedToPicked: picked.rows.length > 0,
    pickedIds: picked.rows.map((r) => String(r.staff_id)),
  });
});

/**
 * WHO IS IN THE ROOM — checked in, and here right now.
 *
 * The owner asked for "a 'who's in the room' bar showing who's checked in and
 * online, live". Two different facts, deliberately kept apart on the bar
 * because they mean different things:
 *
 *   CHECKED IN  is a CLAIM a person made about the day — "I am here, on time" —
 *               approved by a super admin. It is what puts them on the wheel.
 *   HERE NOW    is whether they have the Arena open on a screen this second.
 *
 * Somebody can be checked in and away from their desk (they are still in the
 * draw), and somebody can be watching without having checked in (they are not).
 * Showing one number for both would quietly tell the room a lie about who is
 * in the spin.
 *
 * "HERE NOW" IS NOT A NEW HEARTBEAT AND NOT A NEW TABLE. The live stream this
 * screen is already listening to holds an open connection per screen, and
 * `events.isOnline` answers from exactly those connections — so it is honest
 * by construction (an open Arena tab, nothing else) and costs one lookup. It is
 * multi-tab safe and carries a 45-second grace, so a page refresh does not make
 * somebody blink out of the room.
 */
router.get('/sessions/:id/room', async (req, res) => {
  const sid = req.params.id;
  const s = await db.query(`SELECT id FROM arena_sessions WHERE id = $1`, [sid]);
  if (!s.rows[0]) return bad(res, 'That session does not exist.', 404);

  const people = await sessionPeople(sid);
  // The spin the check-ins belong to: the live one whose DOOR SHUTS SOONEST —
  // that is the one people are actually clocking into. "Newest first" was
  // measured wrong on the shipped day (2026-08-19): the all-day Mega Spin is
  // seq 2, so it always beat the Early Bird and the bar read "0 in the spin"
  // all morning while four approved check-ins sat on the Early Bird. A future
  // deadline sorts before a passed one, a passed one before none at all, and
  // only then does newest-first break the tie. A session with no live spin has
  // nobody "checked in" yet, which is the truth rather than a stale count.
  const spin = (await db.query(
    `SELECT id, seq, title, state FROM arena_spins
      WHERE session_id = $1 AND state IN ('open','locked','spinning')
      ORDER BY (entry_deadline_at IS NULL) ASC,
               (entry_deadline_at < now()) ASC,
               CASE WHEN entry_deadline_at >= now() THEN entry_deadline_at END ASC,
               seq DESC
      LIMIT 1`, [sid])).rows[0] || null;
  const checkins = spin
    ? (await db.query(
      `SELECT staff_id, status FROM arena_checkins WHERE spin_id = $1`, [spin.id])).rows : [];
  const byId = new Map(checkins.map((c) => [String(c.staff_id), c.status]));

  const rows = people.map((p) => {
    const status = byId.get(String(p.id)) || null;
    return {
      id: String(p.id),
      name: p.full_name,
      role: p.role,
      // 'approved' | 'pending' | 'rejected' | null (has not checked in)
      checkin: status,
      checkedIn: status === 'approved',
      here: events.isOnline('staff', p.id),
    };
  });
  // Here-and-in first, then here, then the rest — the bar reads left to right
  // as "who is actually with us".
  rows.sort((a, b) => (Number(b.checkedIn) - Number(a.checkedIn))
    || (Number(b.here) - Number(a.here))
    || String(a.name || '').localeCompare(String(b.name || '')));

  res.json({
    spin: spin ? { id: spin.id, seq: spin.seq, title: spin.title, state: spin.state } : null,
    people: rows,
    counts: {
      total: rows.length,
      here: rows.filter((r) => r.here).length,
      checkedIn: rows.filter((r) => r.checkedIn).length,
      waitingOnApproval: rows.filter((r) => r.checkin === 'pending').length,
    },
    serverNow: new Date().toISOString(),
  });
});

// ===========================================================================
// THE BOARD -- one call that paints the whole live screen.
// ===========================================================================

router.get('/board', async (req, res) => {
  // Heal anything left spinning by a restart before answering. Cheap, and it
  // means the board can never show a wheel that never stops.
  await runner.settleDue();

  const sid = req.query.session
    ? (await db.query(`SELECT * FROM arena_sessions WHERE id = $1`, [req.query.session])).rows[0]
    : (await db.query(`SELECT * FROM arena_sessions WHERE state = 'live' ORDER BY opened_at DESC LIMIT 1`)).rows[0];
  if (!sid) return res.json({ session: null, spins: [], awards: [], me: null });

  const cfg = await settings.load();
  const spins = await db.query(
    `SELECT * FROM arena_spins WHERE session_id = $1 ORDER BY seq DESC`, [sid.id]);
  const spinIds = spins.rows.map((s) => s.id);

  const draws = spinIds.length
    ? (await db.query(`SELECT * FROM arena_draws WHERE spin_id = ANY($1::uuid[]) ORDER BY seq`, [spinIds])).rows : [];
  const checkins = spinIds.length
    ? (await db.query(
      `SELECT c.*, s.full_name FROM arena_checkins c JOIN staff_users s ON s.id = c.staff_id
        WHERE c.spin_id = ANY($1::uuid[]) ORDER BY c.checked_in_at`, [spinIds])).rows : [];
  const entries = spinIds.length
    ? (await db.query(
      `SELECT e.*, s.full_name AS asked_by FROM arena_entries e LEFT JOIN staff_users s ON s.id = e.staff_id
        WHERE e.spin_id = ANY($1::uuid[]) ORDER BY e.created_at`, [spinIds])).rows : [];
  const qualifiers = spinIds.length
    ? (await db.query(`SELECT * FROM arena_qualifiers WHERE spin_id = ANY($1::uuid[]) ORDER BY seq`, [spinIds])).rows : [];
  const claims = spinIds.length
    ? (await db.query(
      `SELECT c.*, s.full_name FROM arena_claims c JOIN staff_users s ON s.id = c.staff_id
        WHERE c.spin_id = ANY($1::uuid[]) ORDER BY c.created_at`, [spinIds])).rows : [];
  const awards = (await db.query(
    `SELECT a.*, s.full_name FROM arena_awards a JOIN staff_users s ON s.id = a.staff_id
      WHERE a.session_id = $1 ORDER BY a.awarded_at DESC`, [sid.id])).rows;

  const me = String(req.actor.id);
  // Whether THIS person may play — a session limited to a picked list refuses
  // everyone else at check-in, so the button must not be shown to them (the
  // 2026-08-19 audit found a guaranteed 400 dead end).
  const roomPeople = await sessionPeople(sid.id);
  const iAmIn = roomPeople.some((p) => String(p.id) === me);
  res.json({
    session: sid,
    iAmIn,
    serverNow: new Date().toISOString(),
    settings: cfg.settings,
    isSuperAdmin: isSuper(req),
    spins: spins.rows.map((sp) => {
      const myCheckin = checkins.find((c) => c.spin_id === sp.id && String(c.staff_id) === me) || null;
      const spinDraws = draws.filter((d) => d.spin_id === sp.id);
      return {
        ...sp,
        // The frozen list is public — that is the point of freezing it — but the
        // SECRET SEED is stripped from every wheel that has not been revealed.
        // Without this strip, anybody could open devtools and read the answer
        // out of the board's own payload before the wheel stopped.
        draws: spinDraws.map(publicDraw),
        checkins: checkins.filter((c) => c.spin_id === sp.id),
        entries: entries.filter((e) => e.spin_id === sp.id),
        qualifiers: qualifiers.filter((q) => q.spin_id === sp.id).map((q) => ({
          ...q, claims: claims.filter((c) => c.qualifier_id === q.id),
        })),
        myCheckin,
        myEntries: entries.filter((e) => e.spin_id === sp.id && String(e.staff_id) === me),
      };
    }),
    awards,
  });
});

/**
 * A draw as everybody may see it. The one rule: `server_seed` exists in the
 * payload ONLY once the wheel has landed. Everything else — the commitment, the
 * frozen roster, the roster hash, the client seed — is public from the moment
 * it is set, because being public beforehand is exactly what makes it proof.
 */
function publicDraw(d) {
  const revealed = d.state === 'revealed';
  return {
    id: d.id, spin_id: d.spin_id, seq: d.seq, title: d.title, pool: d.pool, state: d.state,
    commit_hash: d.commit_hash,
    server_seed: revealed ? d.server_seed : null,
    client_seed: d.client_seed, nonce: d.nonce,
    roster: d.roster, roster_hash: d.roster_hash,
    winner_index: revealed ? d.winner_index : null,
    winner_key: revealed ? d.winner_key : null,
    winner_label: revealed ? d.winner_label : null,
    winner_staff_id: revealed ? d.winner_staff_id : null,
    target_rotation_deg: d.target_rotation_deg == null ? null : Number(d.target_rotation_deg),
    duration_ms: d.duration_ms,
    spin_started_at: d.spin_started_at, revealed_at: d.revealed_at,
  };
}

// ------------------------------------------------------------------- spins

router.post('/sessions/:id/spins', requireSuper, async (req, res) => {
  const { title, subtitle, kind, config, entryOpensAt, entryDeadlineAt, qualifiers } = req.body || {};
  try {
    const spin = await runner.createSpin({
      sessionId: req.params.id, title, subtitle, kind, config,
      entryOpensAt, entryDeadlineAt, createdBy: req.actor.id,
    });
    if (Array.isArray(qualifiers)) {
      for (let i = 0; i < qualifiers.length; i++) {
        const q = qualifiers[i] || {};
        const label = String(q.label || '').trim();
        if (!label) continue;
        await db.query(
          `INSERT INTO arena_qualifiers (spin_id, seq, label, description, evidence_hint, weight)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [spin.id, i + 1, label, q.description || null, q.evidenceHint || null,
            Number.isInteger(q.weight) && q.weight >= 0 ? q.weight : 1]);
      }
    }
    await audit(req, 'arena_spin_created', 'arena_spin', spin.id, { kind: spin.kind, seq: spin.seq });
    events.publishToStaff('arena:spin', { spinId: spin.id, sessionId: spin.session_id, state: 'draft' });
    res.status(201).json({ spin });
  } catch (e) {
    return bad(res, e.message || 'That spin could not be created.');
  }
});

// ---------------------------------------------------------------- rematch

/**
 * WHO THE DAY SAYS THE LAST TWO ARE. A suggestion with its reasoning attached —
 * the super admin can take it or type any other two names.
 */
router.get('/sessions/:id/rematch-suggestion', requireSuper, async (req, res) => {
  res.json(await rematch.suggestPair(req.params.id));
});

/**
 * THE REMATCH — one wheel, two names, the challenger on the stop button.
 *
 * It goes STRAIGHT to open, because the whole point is that it happens in the
 * next thirty seconds while the room is still watching; a duel that has to be
 * opened as a separate click is a duel the moment has already passed for. The
 * wheel is frozen here too, so the two names and the fingerprint are published
 * before anybody presses anything.
 */
router.post('/sessions/:id/rematch', requireSuper, async (req, res) => {
  const b = req.body || {};
  try {
    const made = await rematch.create({
      sessionId: req.params.id,
      staffIds: b.staffIds,
      title: b.title, subtitle: b.subtitle, prizeLabel: b.prizeLabel,
      stopHolderStaffId: b.stopHolderStaffId,
      durationMs: b.durationMs,
      createdBy: req.actor.id,
    });
    await runner.openSpin(made.spin.id);
    // Freeze now so the room sees the two names and the fingerprint before the
    // button exists. A freeze that cannot find both people is a real error the
    // admin must see, and the spin is already open, so it is reported rather
    // than swallowed — pressing spin would raise the same thing anyway.
    let frozen = null;
    try { frozen = await runner.freezeRoster(made.spin.id, 1); } catch (e) { frozen = { error: e.message }; }
    await audit(req, 'arena_rematch_created', 'arena_spin', made.spin.id, {
      pair: made.pair.map((p) => p.name), stopHolder: made.stopHolderName,
    });
    events.publishToStaff('arena:spin', { spinId: made.spin.id, sessionId: req.params.id, state: 'open' });
    res.status(201).json({ ...made, frozen: frozen && frozen.error ? null : frozen, freezeError: (frozen && frozen.error) || null });
  } catch (e) {
    return bad(res, e.message || 'That rematch could not be set up.');
  }
});

// ----------------------------------------------------------------- recap

/**
 * ONE PERSON'S DAY — and only ever the person asking for it.
 *
 * A super admin may read somebody else's with `?staff=`, because they are the
 * one who reads out the day at the end of it. Everybody else gets their own,
 * whatever they put in the query — the id is taken from the token, not the URL.
 */
router.get('/sessions/:id/recap', async (req, res) => {
  const asked = String((req.query && req.query.staff) || '').trim();
  const who = asked && isSuper(req) ? asked : req.actor.id;
  res.json(await recap.forPerson(req.params.id, who));
});

router.put('/spins/:id', requireSuper, async (req, res) => {
  const cur = await runner.getSpin(req.params.id);
  if (!cur) return bad(res, 'That spin does not exist.', 404);
  if (['decided', 'spinning'].includes(cur.state)) return bad(res, 'That spin is already running or finished.');
  const body = req.body || {};
  const { title, subtitle, config } = body;
  const merged = config ? { ...(cur.config || {}), ...config } : (cur.config || {});
  const problems = games.configProblems(merged);
  if (problems.length) return res.status(400).json({ error: problems.join(' '), problems });
  // A time sent as a KEY is a decision (null clears it); a key not sent leaves
  // the stored time alone. COALESCE alone could never CLEAR a deadline, which
  // is exactly what "just open it, no cutoff" needs.
  const tOf = (k, fallback) => {
    if (!(k in body)) return { set: false, val: fallback };
    const v = body[k];
    if (v === null || v === '') return { set: true, val: null };
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? { set: true, val: d.toISOString() } : { set: false, val: fallback };
  };
  const la = tOf('launchAt', cur.launch_at);
  const eo = tOf('entryOpensAt', cur.entry_opens_at);
  const ed = tOf('entryDeadlineAt', cur.entry_deadline_at);
  const r = await db.query(
    `UPDATE arena_spins
        SET title = COALESCE($2, title), subtitle = COALESCE($3, subtitle), config = $4::jsonb,
            entry_opens_at = $5, entry_deadline_at = $6, launch_at = $7,
            updated_at = now()
      WHERE id = $1 RETURNING *`,
    [req.params.id, title || null, subtitle || null, JSON.stringify(merged),
      eo.set ? eo.val : cur.entry_opens_at,
      ed.set ? ed.val : cur.entry_deadline_at,
      la.set ? la.val : cur.launch_at]);
  await audit(req, 'arena_spin_updated', 'arena_spin', req.params.id, {});
  events.publishToStaff('arena:spin', { spinId: req.params.id, state: r.rows[0].state });
  res.json({ spin: r.rows[0] });
});

router.post('/spins/:id/:action(open|lock|cancel)', requireSuper, async (req, res) => {
  try {
    const a = req.params.action;
    const spin = a === 'open' ? await runner.openSpin(req.params.id)
      : a === 'lock' ? await runner.lockSpin(req.params.id)
        : await runner.cancelSpin(req.params.id, (req.body || {}).reason);
    await audit(req, `arena_spin_${a}`, 'arena_spin', req.params.id, {});
    if (a === 'open') await announceSpinOpen(spin).catch(() => {});
    res.json({ spin });
  } catch (e) {
    return bad(res, e.message || 'That did not work.');
  }
});

/** "Spinner number one is open, here is the deadline." */
async function announceSpinOpen(spin) {
  const s = await settings.load();
  if (!s.settings.emailReminders) return 0;
  const people = await sessionPeople(spin.session_id);
  const when = spin.entry_deadline_at
    ? ` You have until ${new Date(spin.entry_deadline_at).toLocaleString('en-US')} to check in.`
    : '';
  for (const p of people) {
    await notify.notifyStaff(p.id, {
      type: 'arena_spin_open',
      title: `Spin ${spin.seq} is open: ${spin.title}`,
      body: `Check in to be part of it.${when}`,
      link: '/internal/arena',
      ctaLabel: 'Check in',
    }).catch(() => {});
  }
  return people.length;
}

/** Turn the wheel. Super admin only -- "we do the spin on our side". */
router.post('/spins/:id/spin', requireSuper, async (req, res) => {
  const seq = Math.max(1, Math.floor(Number((req.body || {}).seq) || 1));
  try {
    const draw = await runner.startSpin(req.params.id, seq, {
      clientSeed: (req.body || {}).clientSeed, by: req.actor.id,
    });
    await audit(req, 'arena_wheel_spun', 'arena_spin', req.params.id, {
      seq, drawId: draw.id, rosterHash: draw.roster_hash, commitHash: draw.commit_hash,
    });
    // The winner is deliberately NOT in this response. The admin who pressed the
    // button watches the same wheel as everybody else.
    res.json({
      ok: true, seq, drawId: draw.id,
      startedAt: draw.spin_started_at, durationMs: draw.duration_ms,
      targetRotationDeg: Number(draw.target_rotation_deg),
      commitHash: draw.commit_hash, rosterHash: draw.roster_hash,
      candidates: (draw.roster || []).length,
    });
  } catch (e) {
    return bad(res, e.message || 'The wheel could not be turned.');
  }
});

/** Freeze a wheel's list early, so the room can look at it before it turns. */
router.post('/spins/:id/freeze', requireSuper, async (req, res) => {
  const seq = Math.max(1, Math.floor(Number((req.body || {}).seq) || 1));
  try {
    const draw = await runner.freezeRoster(req.params.id, seq);
    res.json({ draw: publicDraw(draw) });
  } catch (e) {
    return bad(res, e.message || 'That wheel could not be set up.');
  }
});

/**
 * PREVIEW a wheel without freezing it -- who would be on it if it spun now.
 * Read-only, and it never commits or freezes anything, so an admin can look as
 * often as they like without touching the record.
 */
router.get('/spins/:id/preview', requireSuper, async (req, res) => {
  const spin = await runner.getSpin(req.params.id);
  if (!spin) return bad(res, 'That spin does not exist.', 404);
  const session = await runner.getSession(spin.session_id);
  const config = spin.config || {};
  const seq = Math.max(1, Math.floor(Number(req.query.seq) || 1));
  const wheel = (config.wheels || [])[seq - 1];
  if (!wheel) return bad(res, `This spin has no wheel ${seq}.`);
  const draws = await runner.getDraws(spin.id);
  const prev = draws.find((d) => d.seq === seq - 1);
  try {
    const built = await psources.buildPool(wheel.source, {
      spin, session, config, weightMode: config.weightMode || 'equal',
      previousWinnerKey: prev && prev.state === 'revealed' ? prev.winner_key : null,
    });
    const fair = require('../lib/arena/fair-draw');
    res.json({
      seq, source: built.source, scope: built.scope,
      candidates: built.candidates,
      angles: fair.sliceAngles(built.candidates),
      totalWeight: built.candidates.reduce((a, c) => a + (Number(c.weight) || 0), 0),
    });
  } catch (e) {
    return bad(res, e.message || 'That wheel could not be built.');
  }
});

/** Check any past draw. Open to every staffer -- that is the whole point. */
router.get('/draws/:id/verify', async (req, res) => {
  res.json(await runner.verify(req.params.id));
});

// ---------------------------------------------------------------- check-in

router.post('/spins/:id/checkin', async (req, res) => {
  const spin = await runner.getSpin(req.params.id);
  if (!spin) return bad(res, 'That spin does not exist.', 404);
  const paused = await db.query(`SELECT paused_at FROM arena_sessions WHERE id = $1`, [spin.session_id]);
  if (paused.rows[0] && paused.rows[0].paused_at) return bad(res, 'The session is paused right now — check-in reopens when it resumes.');
  const config = spin.config || {};
  const people = await sessionPeople(spin.session_id);
  const isMember = people.some((p) => String(p.id) === String(req.actor.id));
  const existing = await db.query(
    `SELECT id FROM arena_checkins WHERE spin_id = $1 AND staff_id = $2`, [spin.id, req.actor.id]);

  const verdict = rules.mayCheckIn(spin, new Date(), {
    alreadyCheckedIn: existing.rows.length > 0, isMember,
  });
  if (!verdict.ok) return res.status(400).json({ error: verdict.reason, code: verdict.code });

  const status = config.autoApproveCheckins === false ? 'pending' : 'approved';
  // What they agreed to when they pressed the button. A spin with an
  // attestation configured ("I am here, inside the building…") records the
  // EXACT WORDING the person attested to — the column existed since db/586 and
  // nothing wrote it (found by the 2026-08-19 audit) — so what they agreed to
  // is on the record rather than remembered differently later. NULL on an
  // ordinary check-in and when the client did not confirm.
  const attested = typeof config.attestation === 'string' && config.attestation.trim()
      && (req.body || {}).attested === true
    ? config.attestation.trim().slice(0, 500) : null;
  const r = await db.query(
    `INSERT INTO arena_checkins (spin_id, staff_id, status, note, attested)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [spin.id, req.actor.id, status, String((req.body || {}).note || '').slice(0, 280) || null, attested]);
  events.publishToStaff('arena:checkin', {
    spinId: spin.id, staffId: String(req.actor.id), status,
  });
  res.status(201).json({ checkin: r.rows[0], closesInMs: verdict.closesInMs });
});

router.post('/checkins/:id/decide', requireSuper, async (req, res) => {
  const want = String((req.body || {}).status || '');
  if (!['approved', 'rejected'].includes(want)) return bad(res, 'A check-in is either approved or rejected.');
  const r = await db.query(
    `UPDATE arena_checkins SET status = $2, decided_by = $3, decided_at = now(), decline_reason = $4
      WHERE id = $1 RETURNING *`,
    [req.params.id, want, req.actor.id, want === 'rejected' ? ((req.body || {}).reason || null) : null]);
  if (!r.rows[0]) return bad(res, 'That check-in does not exist.', 404);
  await audit(req, `arena_checkin_${want}`, 'arena_spin', r.rows[0].spin_id, { staffId: r.rows[0].staff_id });
  events.publishToStaff('arena:checkin', {
    spinId: r.rows[0].spin_id, staffId: String(r.rows[0].staff_id), status: want,
  });
  res.json({ checkin: r.rows[0] });
});

// ----------------------------------------------------------------- entries

router.post('/spins/:id/entries', async (req, res) => {
  const spin = await runner.getSpin(req.params.id);
  if (!spin) return bad(res, 'That spin does not exist.', 404);
  const cfg = await settings.load();
  const checked = await db.query(
    `SELECT status FROM arena_checkins WHERE spin_id = $1 AND staff_id = $2`, [spin.id, req.actor.id]);
  const mine = await db.query(
    `SELECT count(*)::int AS n FROM arena_entries WHERE spin_id = $1 AND staff_id = $2 AND status <> 'rejected'`,
    [spin.id, req.actor.id]);

  // The earned economy needs the person's standing (chances, nominations,
  // tier ceiling). Best-effort — an unreadable standing engages NO economy,
  // which is the ordinary-spin behaviour, never a refusal.
  let standing = null;
  if (spin.kind === 'ticket_lottery') {
    try { standing = await require('../lib/arena/challenges').standingFor(spin.session_id, req.actor.id); }
    catch (_) { standing = null; }
  }

  const verdict = rules.mayEnter(
    { kind: (req.body || {}).kind, label: (req.body || {}).label, value: (req.body || {}).value, valueCents: (req.body || {}).valueCents },
    {
      spin, settings: cfg.settings, now: new Date(),
      checkedIn: checked.rows.length > 0 && checked.rows[0].status !== 'rejected',
      existingCount: mine.rows[0].n,
      standing,
    });
  if (!verdict.ok) return res.status(400).json({ error: verdict.reason, code: verdict.code });

  const r = await db.query(
    `INSERT INTO arena_entries (spin_id, staff_id, kind, label, detail, value_cents, status, unlocked_by_tickets)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [spin.id, req.actor.id, verdict.kind, verdict.label,
      String((req.body || {}).detail || '').slice(0, 500) || null,
      verdict.valueCents, verdict.needsApproval ? 'pending' : 'approved',
      verdict.unlockedByTickets == null ? null : verdict.unlockedByTickets]);
  events.publishToStaff('arena:entry', { spinId: spin.id, entryId: r.rows[0].id, status: r.rows[0].status });
  res.status(201).json({ entry: r.rows[0] });
});

router.post('/entries/:id/decide', requireSuper, async (req, res) => {
  const want = String((req.body || {}).status || '');
  if (!['approved', 'rejected'].includes(want)) return bad(res, 'An entry is either approved or rejected.');
  const r = await db.query(
    `UPDATE arena_entries SET status = $2, decided_by = $3, decided_at = now(), decline_reason = $4, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [req.params.id, want, req.actor.id, want === 'rejected' ? ((req.body || {}).reason || null) : null]);
  if (!r.rows[0]) return bad(res, 'That entry does not exist.', 404);
  await audit(req, `arena_entry_${want}`, 'arena_spin', r.rows[0].spin_id, {
    entryId: r.rows[0].id, valueCents: r.rows[0].value_cents, kind: r.rows[0].kind,
  });
  events.publishToStaff('arena:entry', { spinId: r.rows[0].spin_id, entryId: r.rows[0].id, status: want });
  res.json({ entry: r.rows[0] });
});

router.delete('/entries/:id', async (req, res) => {
  // Your own entry, and only while it is still pending — once an admin has
  // accepted it, it is part of the prize pool the room can see.
  const r = await db.query(
    `DELETE FROM arena_entries WHERE id = $1 AND staff_id = $2 AND status = 'pending' RETURNING spin_id`,
    [req.params.id, req.actor.id]);
  if (!r.rows[0]) return bad(res, 'That entry is not yours to take back, or it has already been accepted.');
  events.publishToStaff('arena:entry', { spinId: r.rows[0].spin_id, entryId: req.params.id, status: 'withdrawn' });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ claims

router.post('/qualifiers/:id/claim', async (req, res) => {
  const q = (await db.query(`SELECT * FROM arena_qualifiers WHERE id = $1`, [req.params.id])).rows[0];
  if (!q) return bad(res, 'That does not exist.', 404);
  const spin = await runner.getSpin(q.spin_id);
  if (!spin || spin.state !== 'open') return bad(res, 'This spin is not taking claims right now.');
  const evidence = String((req.body || {}).evidence || '').trim().slice(0, 1000);
  if (!evidence) return bad(res, 'Say what you did and how we can see it.');
  const r = await db.query(
    `INSERT INTO arena_claims (spin_id, qualifier_id, staff_id, evidence, application_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (qualifier_id, staff_id) DO UPDATE SET evidence = EXCLUDED.evidence, status = 'pending',
       decided_by = NULL, decided_at = NULL, decline_reason = NULL
     RETURNING *`,
    [q.spin_id, q.id, req.actor.id, evidence, (req.body || {}).applicationId || null]);
  events.publishToStaff('arena:claim', { spinId: q.spin_id, qualifierId: q.id, staffId: String(req.actor.id) });
  res.status(201).json({ claim: r.rows[0] });
});

router.post('/claims/:id/decide', requireSuper, async (req, res) => {
  const want = String((req.body || {}).status || '');
  if (!['approved', 'rejected'].includes(want)) return bad(res, 'A claim is either approved or rejected.');
  const r = await db.query(
    `UPDATE arena_claims SET status = $2, decided_by = $3, decided_at = now(), decline_reason = $4
      WHERE id = $1 RETURNING *`,
    [req.params.id, want, req.actor.id, want === 'rejected' ? ((req.body || {}).reason || null) : null]);
  if (!r.rows[0]) return bad(res, 'That claim does not exist.', 404);
  await audit(req, `arena_claim_${want}`, 'arena_spin', r.rows[0].spin_id, { claimId: r.rows[0].id });
  events.publishToStaff('arena:claim', { spinId: r.rows[0].spin_id, claimId: r.rows[0].id, status: want });
  res.json({ claim: r.rows[0] });
});

// -------------------------------------------------------------------- chat

const lastMessageAt = new Map();   // staffId -> ms, for slow mode

router.get('/sessions/:id/chat', async (req, res) => {
  // Cursor-based, never OFFSET: messages arrive while somebody is scrolling, and
  // an offset page would then skip or repeat lines.
  const before = req.query.before ? Number(req.query.before) : null;
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 60));
  const r = await db.query(
    `SELECT m.id, m.session_id, m.spin_id, m.staff_id, m.kind, m.body, m.reaction_counts,
            m.pinned_at, m.created_at, s.full_name
       FROM arena_messages m LEFT JOIN staff_users s ON s.id = m.staff_id
      WHERE m.session_id = $1 AND m.deleted_at IS NULL
        AND ($2::bigint IS NULL OR m.id < $2::bigint)
      ORDER BY m.id DESC LIMIT $3`, [req.params.id, before, limit]);
  const pinned = await db.query(
    `SELECT m.id, m.body, m.created_at, s.full_name FROM arena_messages m
       LEFT JOIN staff_users s ON s.id = m.staff_id
      WHERE m.session_id = $1 AND m.pinned_at IS NOT NULL AND m.deleted_at IS NULL
      ORDER BY m.pinned_at DESC LIMIT 5`, [req.params.id]);
  res.json({ messages: r.rows.reverse(), pinned: pinned.rows, hasMore: r.rows.length === limit });
});

router.post('/sessions/:id/chat', async (req, res) => {
  const cfg = await settings.load();
  if (cfg.settings.chatEnabled === false) return bad(res, 'Chat is switched off for now.');
  const body = String((req.body || {}).body || '').trim();
  if (!body) return bad(res, 'Type something first.');
  if (body.length > 1000) return bad(res, 'Keep it under 1000 characters.');

  // Slow mode. In-memory, single process, matching how this app already runs —
  // and stated as such rather than implied: with more than one web process this
  // becomes per-process, which for a chat throttle is a cost worth naming and
  // not worth a Redis for.
  const gap = Math.max(0, Number(cfg.settings.chatSlowModeSeconds) || 0) * 1000;
  if (gap) {
    const last = lastMessageAt.get(String(req.actor.id)) || 0;
    const wait = gap - (Date.now() - last);
    if (wait > 0) return res.status(429).json({ error: `Give it ${Math.ceil(wait / 1000)} more second(s).` });
  }
  lastMessageAt.set(String(req.actor.id), Date.now());

  // The name comes from the INSERT itself. `req.actor` carries an id, a kind and
  // a role -- not a name -- so reading one off it would silently be null on
  // every message, and the room would watch an anonymous chat.
  const r = await db.query(
    `WITH ins AS (
       INSERT INTO arena_messages (session_id, spin_id, staff_id, kind, body)
       VALUES ($1,$2,$3,'chat',$4) RETURNING *)
     SELECT ins.*, s.full_name FROM ins LEFT JOIN staff_users s ON s.id = ins.staff_id`,
    [req.params.id, (req.body || {}).spinId || null, req.actor.id, body]);
  const msg = r.rows[0];
  events.publishToStaff('arena:chat', { message: msg });
  res.status(201).json({ message: msg });
});

router.post('/chat/:id/react', async (req, res) => {
  const emoji = String((req.body || {}).emoji || '').trim().slice(0, 8);
  if (!emoji) return bad(res, 'Pick a reaction.');
  // A counter, incremented in the database so two people reacting at once do
  // not overwrite each other with a read-modify-write.
  const r = await db.query(
    `UPDATE arena_messages
        SET reaction_counts = jsonb_set(
              COALESCE(reaction_counts, '{}'::jsonb), ARRAY[$2::text],
              to_jsonb(COALESCE((reaction_counts ->> $2)::int, 0) + 1))
      WHERE id = $1 AND deleted_at IS NULL RETURNING id, session_id, reaction_counts`,
    [req.params.id, emoji]);
  if (!r.rows[0]) return bad(res, 'That message is gone.', 404);
  events.publishToStaff('arena:chat-react', { messageId: String(r.rows[0].id), reactions: r.rows[0].reaction_counts });
  res.json({ reactions: r.rows[0].reaction_counts });
});

router.post('/chat/:id/moderate', requireSuper, async (req, res) => {
  const action = String((req.body || {}).action || '');
  if (!['pin', 'unpin', 'delete'].includes(action)) return bad(res, 'Pin, unpin or delete.');
  const sql = action === 'delete'
    ? `UPDATE arena_messages SET deleted_at = now(), deleted_by = $2 WHERE id = $1 RETURNING id, session_id`
    : `UPDATE arena_messages SET pinned_at = ${action === 'pin' ? 'now()' : 'NULL'} WHERE id = $1 AND $2 IS NOT NULL RETURNING id, session_id`;
  const r = await db.query(sql, [req.params.id, req.actor.id]);
  if (!r.rows[0]) return bad(res, 'That message is gone.', 404);
  await audit(req, `arena_chat_${action}`, 'arena_session', r.rows[0].session_id, { messageId: String(r.rows[0].id) });
  events.publishToStaff('arena:chat-moderated', { messageId: String(r.rows[0].id), action });
  res.json({ ok: true });
});

// ------------------------------------------------------------- suggestions

router.get('/sessions/:id/suggestions', async (req, res) => {
  const r = await db.query(
    `SELECT g.*, s.full_name,
            (SELECT count(*)::int FROM arena_suggestion_votes v WHERE v.suggestion_id = g.id) AS votes,
            EXISTS (SELECT 1 FROM arena_suggestion_votes v
                     WHERE v.suggestion_id = g.id AND v.staff_id = $2) AS voted
       FROM arena_suggestions g LEFT JOIN staff_users s ON s.id = g.staff_id
      WHERE g.session_id = $1
      ORDER BY votes DESC, g.created_at DESC LIMIT 200`, [req.params.id, req.actor.id]);
  res.json({ suggestions: r.rows });
});

router.post('/sessions/:id/suggestions', async (req, res) => {
  const cfg = await settings.load();
  if (cfg.settings.suggestionsEnabled === false) return bad(res, 'Suggestions are switched off for now.');
  const body = String((req.body || {}).body || '').trim();
  if (!body) return bad(res, 'Say what you would like to see.');
  if (body.length > 500) return bad(res, 'Keep it under 500 characters.');
  const r = await db.query(
    `INSERT INTO arena_suggestions (session_id, staff_id, body, kind) VALUES ($1,$2,$3,$4) RETURNING *`,
    [req.params.id, req.actor.id, body, String((req.body || {}).kind || 'spin_idea')]);
  events.publishToStaff('arena:suggestion', { sessionId: req.params.id, id: r.rows[0].id });
  const who = await db.query(`SELECT full_name FROM staff_users WHERE id = $1`, [req.actor.id]);
  res.status(201).json({ suggestion: { ...r.rows[0], full_name: (who.rows[0] || {}).full_name || null, votes: 0, voted: false } });
});

router.post('/suggestions/:id/vote', async (req, res) => {
  const on = (req.body || {}).vote !== false;
  if (on) {
    await db.query(
      `INSERT INTO arena_suggestion_votes (suggestion_id, staff_id) VALUES ($1,$2)
       ON CONFLICT DO NOTHING`, [req.params.id, req.actor.id]);
  } else {
    await db.query(`DELETE FROM arena_suggestion_votes WHERE suggestion_id = $1 AND staff_id = $2`,
      [req.params.id, req.actor.id]);
  }
  const c = await db.query(
    `SELECT count(*)::int AS votes FROM arena_suggestion_votes WHERE suggestion_id = $1`, [req.params.id]);
  events.publishToStaff('arena:suggestion', { id: req.params.id, votes: c.rows[0].votes });
  res.json({ votes: c.rows[0].votes, voted: on });
});

router.post('/suggestions/:id/status', requireSuper, async (req, res) => {
  const want = String((req.body || {}).status || '');
  if (!['new', 'planned', 'used', 'declined'].includes(want)) return bad(res, 'new, planned, used or declined.');
  const r = await db.query(
    `UPDATE arena_suggestions SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1 RETURNING *`,
    [req.params.id, want, req.actor.id]);
  if (!r.rows[0]) return bad(res, 'That suggestion does not exist.', 404);
  res.json({ suggestion: r.rows[0] });
});

// ------------------------------------------------------------------ prizes

router.get('/prizes', async (req, res) => {
  const r = await db.query(`SELECT * FROM arena_prizes ORDER BY sort_order, label`);
  res.json({ prizes: r.rows });
});

router.post('/prizes', requireSuper, async (req, res) => {
  const label = String((req.body || {}).label || '').trim();
  if (!label) return bad(res, 'Give the prize a name.');
  const cents = rules.toCents((req.body || {}).value);
  const r = await db.query(
    `INSERT INTO arena_prizes (label, description, kind, value_cents, sort_order, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [label, (req.body || {}).description || null,
      ['personal', 'business', 'perk'].includes((req.body || {}).kind) ? req.body.kind : 'personal',
      cents == null || cents < 0 ? 0 : cents,
      Number.isFinite(Number((req.body || {}).sortOrder)) ? Number(req.body.sortOrder) : 100, req.actor.id]);
  res.status(201).json({ prize: r.rows[0] });
});

router.put('/prizes/:id', requireSuper, async (req, res) => {
  const b = req.body || {};
  const cents = b.value === undefined ? null : rules.toCents(b.value);
  const r = await db.query(
    `UPDATE arena_prizes
        SET label = COALESCE($2, label), description = COALESCE($3, description),
            kind = COALESCE($4, kind), value_cents = COALESCE($5, value_cents),
            is_active = COALESCE($6, is_active), sort_order = COALESCE($7, sort_order)
      WHERE id = $1 RETURNING *`,
    [req.params.id, b.label ? String(b.label).trim() : null, b.description === undefined ? null : b.description,
      ['personal', 'business', 'perk'].includes(b.kind) ? b.kind : null,
      cents == null || cents < 0 ? null : cents,
      typeof b.isActive === 'boolean' ? b.isActive : null,
      Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : null]);
  if (!r.rows[0]) return bad(res, 'That prize does not exist.', 404);
  res.json({ prize: r.rows[0] });
});

router.delete('/prizes/:id', requireSuper, async (req, res) => {
  await db.query(`DELETE FROM arena_prizes WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ awards

router.get('/sessions/:id/awards', async (req, res) => {
  const r = await db.query(
    `SELECT a.*, s.full_name, s.email, p.seq AS spin_seq, p.title AS spin_title
       FROM arena_awards a
       JOIN staff_users s ON s.id = a.staff_id
       JOIN arena_spins  p ON p.id = a.spin_id
      WHERE a.session_id = $1 ORDER BY a.awarded_at DESC`, [req.params.id]);
  res.json({ awards: r.rows });
});

/**
 * Everything won in a session, as a spreadsheet — who won what, when, and why.
 * CSV because that is what opens anywhere.
 */
router.get('/sessions/:id/awards.csv', requireSuper, async (req, res) => {
  const r = await db.query(
    `SELECT s.full_name, s.email, p.seq, p.title, a.prize_label, a.prize_kind, a.value_cents, a.awarded_at, a.reason
       FROM arena_awards a
       JOIN staff_users s ON s.id = a.staff_id
       JOIN arena_spins  p ON p.id = a.spin_id
      WHERE a.session_id = $1 ORDER BY a.awarded_at`, [req.params.id]);
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [['Name', 'Email', 'Spin', 'Spin title', 'Prize', 'Kind', 'Value (USD)', 'Awarded at', 'Why'].map(esc).join(',')];
  for (const a of r.rows) {
    lines.push([a.full_name, a.email, a.seq, a.title, a.prize_label, a.prize_kind,
      (Number(a.value_cents) || 0) / 100, new Date(a.awarded_at).toISOString(), a.reason].map(esc).join(','));
  }
  await audit(req, 'arena_awards_exported', 'arena_session', req.params.id, { rows: r.rows.length });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="arena-awards-${req.params.id}.csv"`);
  res.send(lines.join('\n'));
});

module.exports = router;
