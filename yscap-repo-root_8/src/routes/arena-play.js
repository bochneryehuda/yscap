'use strict';
/**
 * THE ARENA, PART TWO — challenges, the stop button, the templates, the helper.
 *
 * Mounted by routes/arena.js BEHIND its master-switch guard, so everything here
 * inherits the same rule: while the Arena is off, none of it exists. It is a
 * separate file only because one router with fifty routes in it is a file
 * nobody can find anything in.
 *
 * WHO MAY DO WHAT, same as part one:
 *   - every internal staffer: see what is live, fulfil a challenge, press the
 *     button if it is theirs, ask the helper for wording;
 *   - super admin only: plan the day, edit or skip a challenge, decide a
 *     fulfilment, load a template, hand out or take back chances.
 */

const router = require('../lib/safe-router')();
const db = require('../db');
const events = require('../lib/events');
const settings = require('../lib/arena/settings');
const runner = require('../lib/arena/spin-runner');
const challenges = require('../lib/arena/challenges');
const lib = require('../lib/arena/challenge-library');
const templates = require('../lib/arena/templates');
const daySetup = require('../lib/arena/day-setup');
const copilot = require('../lib/arena/copilot');
const games = require('../lib/arena/game-types');
const { decodeUploadBase64 } = require('../lib/upload-bytes');
const storage = require('../lib/storage');

challenges.setBroadcaster((event, data) => {
  try { events.publishToStaff(event, data); } catch (_) { /* a missed frame never fails a write */ }
});

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
function requireSuper(req, res, next) {
  if (settings.isSuperAdmin(req.actor)) return next();
  return bad(res, 'Only a super admin can do that.', 403);
}
async function audit(req, action, entityId, detail) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, ip_address, user_agent, detail)
       VALUES ('staff',$1,$2,'arena_spin',$3,$4,$5,$6)`,
      [req.actor.id, action, entityId || null, req.ip, req.get('user-agent') || null, detail || null]);
  } catch (e) { console.warn(`[arena] audit failed for ${action}: ${e.message}`); }
}

// ===========================================================================
// THE STOP BUTTON
// ===========================================================================

/**
 * Press it. The route checks nothing about fairness — the runner owns that —
 * and only confirms this is a signed-in staffer. The runner refuses anybody
 * who is not the holder.
 */
router.post('/draws/:id/stop', async (req, res) => {
  try {
    const d = await runner.pressStop(req.params.id, req.actor.id);
    await audit(req, 'arena_wheel_stopped', d.spin_id, { drawId: d.id, seq: d.seq });
    // The winner is NOT in this response. The person who pressed watches the
    // wheel come to rest like everybody else.
    res.json({ ok: true, drawId: d.id, seq: d.seq, coastMs: 1600 });
  } catch (e) {
    return bad(res, e.message || 'That did not work.');
  }
});

/** Who holds which button on this spin, so a screen knows whether to show one. */
router.get('/spins/:id/buttons', async (req, res) => {
  const draws = await runner.getDraws(req.params.id);
  res.json({
    buttons: draws.map((d) => ({
      seq: d.seq, drawId: d.id, title: d.title, state: d.state,
      holderStaffId: d.stop_holder_staff_id ? String(d.stop_holder_staff_id) : null,
      mine: d.stop_holder_staff_id && String(d.stop_holder_staff_id) === String(req.actor.id),
      stopMode: d.stop_mode,
    })),
    truth: templates.STOP_BUTTON_TRUTH,
  });
});

// ===========================================================================
// WHO IS IN A SPIN — everybody, minus whoever was taken off
// ===========================================================================

router.get('/spins/:id/roster', requireSuper, async (req, res) => {
  const spin = await runner.getSpin(req.params.id);
  if (!spin) return bad(res, 'That spin does not exist.', 404);
  res.json({ people: await runner.rosterFor(spin), excluded: spin.excluded_staff_ids || [] });
});

/** Take people off a spin (or put them back). Everybody is on it by default. */
router.put('/spins/:id/roster', requireSuper, async (req, res) => {
  const ids = [...new Set((req.body && req.body.excludedStaffIds ? req.body.excludedStaffIds : []).map(String).filter(Boolean))];
  const spin = await runner.getSpin(req.params.id);
  if (!spin) return bad(res, 'That spin does not exist.', 404);
  if (['spinning', 'decided'].includes(spin.state)) return bad(res, 'That spin has already run.');
  const r = await db.query(
    `UPDATE arena_spins SET excluded_staff_ids = $2::uuid[], updated_at = now() WHERE id = $1 RETURNING *`,
    [req.params.id, ids]);
  await audit(req, 'arena_spin_roster_changed', req.params.id, { off: ids.length });
  events.publishToStaff('arena:spin', { spinId: req.params.id, state: r.rows[0].state });
  res.json({ spin: r.rows[0], people: await runner.rosterFor(r.rows[0]) });
});

// ===========================================================================
// TEMPLATES
// ===========================================================================

/**
 * SET THE WHOLE DAY UP IN ONE PRESS.
 *
 * Builds "Elementix Day" as a DRAFT with both ready-made plans inside it, so
 * the morning is a Start button rather than a form. It never puts the day live
 * and never mails anybody — the owner asked to be able to read it and adjust it
 * first ("so I have more control").
 *
 * Safe to press twice: db/592's unique indexes decide, not a read here, so a
 * second press reports what was already there and changes nothing.
 *
 * `day` is the room's own calendar day and `offsetMinutes` how far the room is
 * from UTC — both from the browser, because the server sits in whatever region
 * it sits in and "10:30" means 10:30 where the people are.
 */
router.post('/setup-day', requireSuper, async (req, res) => {
  const b = req.body || {};
  try {
    const out = await daySetup.setUpDay({
      day: String(b.day || '').trim(),
      offsetMinutes: Number(b.offsetMinutes) || 0,
      name: b.name, subtitle: b.subtitle,
      keys: Array.isArray(b.templates) ? b.templates : null,
      createdBy: req.actor.id,
    });
    await audit(req, 'arena_day_set_up', out.session.id, {
      day: out.day,
      sessionCreated: out.sessionCreated,
      built: out.parts.filter((p) => p.ok && p.created).map((p) => p.key),
      alreadyThere: out.parts.filter((p) => p.ok && !p.created).map((p) => p.key),
    });
    events.publishToStaff('arena:session', { sessionId: out.session.id, state: out.session.state });
    res.status(out.sessionCreated ? 201 : 200).json({
      session: out.session,
      sessionCreated: out.sessionCreated,
      summary: out.summary,
      parts: out.parts.map((p) => ({
        key: p.key, ok: p.ok, created: !!p.created, label: p.label || null,
        reason: p.reason || null, warning: p.warning || null,
        challengesPlanned: p.challengesPlanned || 0,
        spinId: p.spin ? p.spin.id : null,
      })),
    });
  } catch (e) {
    if (e && e.badRequest) return bad(res, e.message);
    return bad(res, (e && e.message) || 'The day could not be set up.', 500);
  }
});

router.get('/templates', async (req, res) => {
  res.json({ templates: templates.describeTemplates() });
});

/**
 * Load a template into a real spin, ready to go.
 *
 * `day` is the date the room is having, and `offsetMinutes` is how far the room
 * is from UTC — both passed in by the browser, because the server sits in
 * whatever region it sits in and 10:30 means 10:30 where the people are.
 */
router.post('/sessions/:id/templates/:key', requireSuper, async (req, res) => {
  const day = String((req.body || {}).day || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return bad(res, 'Which day is this for? Send it as YYYY-MM-DD.');
  const offsetMinutes = Number((req.body || {}).offsetMinutes) || 0;
  const built = templates.buildTemplate(req.params.key, { day, offsetMinutes });
  if (!built) return bad(res, 'There is no template by that name.', 404);
  try {
    // Through the ONE idempotent builder — the same code the one-press day
    // setup uses. The old inline version had the exact defect db/401 documents:
    // createSpin committed, the separate template_key stamp then hit db/592's
    // unique index, the raw Postgres string went to the screen, and a complete
    // ORPHAN spin was left on the board — one more per press (measured: four
    // presses left four Early Birds, three of them unstamped). ensureSpin
    // adopts the existing copy instead and cancels its own loser on a race.
    const session = await runner.getSession(req.params.id);
    if (!session) return bad(res, 'That session does not exist.', 404);
    const part = await daySetup.ensureSpin(session, req.params.key, { day, offsetMinutes, createdBy: req.actor.id });
    if (!part.ok) return bad(res, part.reason || 'That template could not be loaded.');
    if (!part.created) {
      if (part.revived) {
        await audit(req, 'arena_template_revived', part.spin.id, { template: req.params.key, day });
        events.publishToStaff('arena:spin', { spinId: part.spin.id, sessionId: req.params.id, state: 'draft' });
        return res.json({
          spin: part.spin, revived: true,
          message: `${part.label || 'That plan'} had been called off — it is back now as a draft, with its times restored.`,
          challengesPlanned: 0,
        });
      }
      return res.json({
        spin: part.spin, alreadyThere: true,
        message: `${part.label || 'That plan'} is already in this session — nothing was added twice.`,
        challengesPlanned: 0,
      });
    }
    await audit(req, 'arena_template_loaded', part.spin.id, { template: req.params.key, day });
    events.publishToStaff('arena:spin', { spinId: part.spin.id, sessionId: req.params.id, state: 'draft' });
    res.status(201).json({
      spin: { ...part.spin, launch_at: built.launchAt, template_key: built.templateKey },
      announcement: built.announcement, emailSubject: built.emailSubject,
      challengesPlanned: part.challengesPlanned || 0,
      warning: part.warning || null,
    });
  } catch (e) {
    return bad(res, e.message || 'That template could not be loaded.');
  }
});

// ===========================================================================
// CHALLENGES
// ===========================================================================

router.get('/challenges/library', async (req, res) => {
  res.json({
    challenges: lib.describeAll(), groups: lib.GROUPS, tiers: lib.TIERS,
    proofTypes: lib.PROOF_TYPES, awardModes: lib.AWARD_MODES,
    ticketsPerNomination: lib.TICKETS_PER_NOMINATION, maxConcurrent: lib.MAX_CONCURRENT,
  });
});

/** What is live, what is next, and where I stand. */
router.get('/sessions/:id/challenges', async (req, res) => {
  res.json(await challenges.boardFor(req.params.id, req.actor.id, {
    isSuperAdmin: settings.isSuperAdmin(req.actor),
  }));
});

/** Lay out a day. Replaces anything still scheduled, never anything already seen. */
router.post('/sessions/:id/challenges/plan', requireSuper, async (req, res) => {
  const b = req.body || {};
  if (!b.from || !b.to) return bad(res, 'When should the challenges start and finish?');
  try {
    const out = await challenges.planDay(req.params.id, b.spinId || null, {
      from: new Date(b.from), to: new Date(b.to),
      targetGapMinutes: Number(b.targetGapMinutes) || 20,
      jitterMinutes: Number(b.jitterMinutes) || 5,
      windowMinutes: Number(b.windowMinutes) || 45,
      seed: Number(b.seed) || 1,
      keys: Array.isArray(b.keys) && b.keys.length ? b.keys : null,
      replace: b.replace !== false,
      createdBy: req.actor.id,
    });
    await audit(req, 'arena_challenges_planned', b.spinId || null, { created: out.created, cleared: out.cleared });
    res.json({ created: out.created, cleared: out.cleared });
  } catch (e) {
    return bad(res, e.message || 'That plan could not be made.');
  }
});

/** Add one by hand, or from the library. */
router.post('/sessions/:id/challenges', requireSuper, async (req, res) => {
  const b = req.body || {};
  const base = b.libraryKey ? lib.describe(b.libraryKey, b) : null;
  const title = String(b.title || (base && base.title) || '').trim();
  const prompt = String(b.prompt || (base && base.prompt) || '').trim();
  if (!title || !prompt) return bad(res, 'It needs a name and something for people to read.');
  const tier = Math.max(1, Math.min(5, Math.floor(Number(b.tier ?? (base && base.tier) ?? 1))));
  const t = lib.TIER_BY_N[tier];
  const proof = lib.PROOF_KEYS.includes(b.proofType) ? b.proofType : ((base && base.proofType) || 'text');
  const award = ['everyone', 'first', 'first_n'].includes(b.awardMode) ? b.awardMode : ((base && base.awardMode) || 'everyone');
  const r = await db.query(
    `INSERT INTO arena_challenges
       (session_id, spin_id, library_key, seq, title, prompt, detail, tier, proof_type,
        award_mode, slots, tickets_awarded, prize_cap_cents, opens_at, closes_at, state, created_by)
     VALUES ($1,$2,$3,
       (SELECT COALESCE(max(seq),0)+1 FROM arena_challenges WHERE session_id=$1),
       $4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [req.params.id, b.spinId || null, b.libraryKey || null, title, prompt, b.detail || null,
      tier, proof, award,
      Math.max(1, Math.floor(Number(b.slots ?? (base && base.slots) ?? 1))),
      Math.max(0, Math.floor(Number(b.ticketsAwarded ?? t.tickets))),
      Math.max(0, Math.floor(Number(b.prizeCapCents ?? t.prizeCapCents))),
      b.opensAt || null,
      // A closing time, one way or another. `closesInMinutes` is the plain
      // "close it in N minutes" the control room sends; without ANY closing
      // time a hand-added live challenge could never be closed by the sweep
      // (it only closes rows whose closes_at is set) and sat on every screen
      // until a human remembered — found by the 2026-08-19 audit.
      b.closesAt || (Number(b.closesInMinutes) > 0
        ? new Date(Date.now() + Math.min(24 * 60, Math.floor(Number(b.closesInMinutes))) * 60000)
        : (b.startNow ? new Date(Date.now() + 20 * 60000) : null)),
      b.startNow ? 'live' : 'scheduled', req.actor.id]);
  await audit(req, 'arena_challenge_added', b.spinId || null, { title, tier });
  if (r.rows[0].state === 'live') events.publishToStaff('arena:challenge-open', challenges.publicChallenge(r.rows[0]));
  res.status(201).json({ challenge: challenges.publicChallenge(r.rows[0]) });
});

/** Change one, skip it, or start it right now. */
router.put('/challenges/:id', requireSuper, async (req, res) => {
  const b = req.body || {};
  if (b.state && !['scheduled', 'live', 'closed', 'skipped', 'cancelled'].includes(b.state)) {
    return bad(res, 'That is not a state a challenge can be in.');
  }
  const r = await db.query(
    `UPDATE arena_challenges
        SET title = COALESCE($2, title), prompt = COALESCE($3, prompt), detail = COALESCE($4, detail),
            tier = COALESCE($5, tier), proof_type = COALESCE($6, proof_type),
            award_mode = COALESCE($7, award_mode), slots = COALESCE($8, slots),
            tickets_awarded = COALESCE($9, tickets_awarded), prize_cap_cents = COALESCE($10, prize_cap_cents),
            opens_at = COALESCE($11, opens_at), closes_at = COALESCE($12, closes_at),
            state = COALESCE($13, state),
            closed_reason = CASE WHEN $13 = 'closed' THEN COALESCE(closed_reason, 'manual')
                                 WHEN $13 = 'live' THEN NULL
                                 ELSE closed_reason END,
            updated_at = now()
      WHERE id = $1 RETURNING *`,
    [req.params.id,
      b.title ? String(b.title).trim() : null, b.prompt ? String(b.prompt).trim() : null,
      b.detail === undefined ? null : b.detail,
      b.tier == null ? null : Math.max(1, Math.min(5, Math.floor(Number(b.tier)))),
      lib.PROOF_KEYS.includes(b.proofType) ? b.proofType : null,
      ['everyone', 'first', 'first_n'].includes(b.awardMode) ? b.awardMode : null,
      b.slots == null ? null : Math.max(1, Math.floor(Number(b.slots))),
      b.ticketsAwarded == null ? null : Math.max(0, Math.floor(Number(b.ticketsAwarded))),
      b.prizeCapCents == null ? null : Math.max(0, Math.floor(Number(b.prizeCapCents))),
      b.opensAt || null, b.closesAt || null, b.state || null]);
  if (!r.rows[0]) return bad(res, 'That challenge does not exist.', 404);
  await audit(req, 'arena_challenge_changed', r.rows[0].spin_id, { id: r.rows[0].id, state: r.rows[0].state });
  const ev = r.rows[0].state === 'live' ? 'arena:challenge-open' : 'arena:challenge-close';
  events.publishToStaff(ev, challenges.publicChallenge(r.rows[0]));
  res.json({ challenge: challenges.publicChallenge(r.rows[0]) });
});

/**
 * "I did it."
 *
 * A screenshot rides as base64 through the shared upload chokepoint, the same
 * as every other upload in this codebase — never a bespoke decode.
 */
router.post('/challenges/:id/fulfil', async (req, res) => {
  const b = req.body || {};
  let evidence = null;
  if (b.dataBase64) {
    let buf;
    try { ({ buf } = decodeUploadBase64(b.dataBase64)); }
    catch (e) { return bad(res, `That picture could not be read: ${(e && e.message) || 'bad upload'}`); }
    if (!buf || !buf.length) return bad(res, 'That picture came through empty.');
    if (buf.length > 12 * 1024 * 1024) return bad(res, 'That picture is too big — keep it under 12MB.');
    try {
      const saved = await storage.save(buf, { filename: String(b.filename || 'proof.png') });
      evidence = { ref: saved.ref, name: String(b.filename || 'proof.png').slice(0, 160), mime: b.contentType || null, bytes: buf.length };
    } catch (e) {
      return bad(res, `That picture could not be saved: ${(e && e.message) || 'storage error'}`, 502);
    }
  }
  try {
    const out = await challenges.fulfil({
      challengeId: req.params.id, staffId: req.actor.id,
      note: b.note, evidence, countValue: b.countValue,
    });
    if (!out.ok) return res.status(out.taken ? 409 : 400).json({ error: out.reason, taken: !!out.taken });
    res.status(201).json({ entry: out.entry, place: out.place });
  } catch (e) {
    return bad(res, e.message || 'That did not go through.');
  }
});

/** Approve or decline a fulfilment. Approving hands out the chances. */
router.post('/challenge-entries/:id/decide', requireSuper, async (req, res) => {
  try {
    const out = await challenges.decide({
      entryId: req.params.id, status: (req.body || {}).status,
      byStaffId: req.actor.id, reason: (req.body || {}).reason,
    });
    if (!out.ok) return bad(res, out.reason);
    await audit(req, `arena_challenge_${out.entry.status}`, out.entry.spin_id, { tickets: out.tickets });
    // The streak rides back with the decision so the admin's own screen can say
    // "that one also earned them a bonus chance" without a second round trip —
    // and so the take-back is visible at the moment somebody declines one.
    res.json({ ok: true, tickets: out.tickets, streak: out.streak || null });
  } catch (e) {
    return bad(res, e.message || 'That did not work.');
  }
});

/** My chances, and what each one was for. */
router.get('/sessions/:id/my-tickets', async (req, res) => {
  res.json({
    standing: await challenges.standingFor(req.params.id, req.actor.id),
    ledger: await challenges.ledgerFor(req.params.id, req.actor.id),
  });
});

/** Hand out or take back chances by hand. Always with a reason. */
router.post('/sessions/:id/tickets', requireSuper, async (req, res) => {
  const b = req.body || {};
  const count = Math.floor(Number(b.count));
  if (!Number.isFinite(count) || count === 0) return bad(res, 'How many chances? A negative number takes them back.');
  if (!b.staffId) return bad(res, 'Who for?');
  const reason = String(b.reason || '').trim();
  if (!reason) return bad(res, 'Say why — this shows up on their own list.');
  await db.query(
    `INSERT INTO arena_tickets (session_id, spin_id, staff_id, count, source, reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [req.params.id, b.spinId || null, b.staffId, count, count > 0 ? 'manual' : 'reversal', reason, req.actor.id]);
  await audit(req, 'arena_tickets_adjusted', b.spinId || null, { staffId: b.staffId, count, reason });
  events.publishToStaff('arena:tickets', { sessionId: req.params.id, staffId: String(b.staffId) });
  res.json({ standing: await challenges.standingFor(req.params.id, b.staffId) });
});

// ===========================================================================
// THE LIVE MONITOR — one screen the super admin watches the whole day from
// ===========================================================================

/**
 * Everything happening right now, in one call.
 *
 * The owner asked for "the winner live screen to monitor how it's being filled
 * out, how the spins run, and who wins". The board already shows a player what
 * a player needs; this is the other view — the one where you can see, at a
 * glance, that eleven people have clocked in, four things are waiting on you,
 * spin two is mid-air, and who has won what all day.
 *
 * ONE CALL, not six, because a person refreshing this every thirty seconds
 * should not cost six round trips. Super admin only.
 */
router.get('/sessions/:id/monitor', requireSuper, async (req, res) => {
  const sid = req.params.id;
  const [session, spins, awards, tickets, chat] = await Promise.all([
    db.query(`SELECT * FROM arena_sessions WHERE id = $1`, [sid]),
    db.query(
      `SELECT p.*,
              (SELECT count(*) FROM arena_checkins c WHERE c.spin_id = p.id) AS checkins,
              (SELECT count(*) FROM arena_checkins c WHERE c.spin_id = p.id AND c.status = 'pending') AS checkins_pending,
              (SELECT count(*) FROM arena_entries  e WHERE e.spin_id = p.id) AS entries,
              (SELECT count(*) FROM arena_entries  e WHERE e.spin_id = p.id AND e.status = 'pending') AS entries_pending,
              (SELECT count(*) FROM arena_draws    d WHERE d.spin_id = p.id AND d.state = 'revealed') AS wheels_done,
              (SELECT count(*) FROM arena_draws    d WHERE d.spin_id = p.id) AS wheels_total,
              (SELECT COALESCE(json_agg(json_build_object('name', su.full_name, 'status', c.status)
                                        ORDER BY c.checked_in_at), '[]'::json)
                 FROM arena_checkins c JOIN staff_users su ON su.id = c.staff_id
                WHERE c.spin_id = p.id) AS checkin_people
         FROM arena_spins p WHERE p.session_id = $1 ORDER BY p.seq DESC`, [sid]),
    db.query(
      `SELECT a.*, s.full_name, p.seq AS spin_seq, p.title AS spin_title
         FROM arena_awards a JOIN staff_users s ON s.id = a.staff_id
         JOIN arena_spins p ON p.id = a.spin_id
        WHERE a.session_id = $1 ORDER BY a.awarded_at DESC`, [sid]),
    db.query(
      `SELECT s.id, s.full_name, COALESCE(sum(t.count), 0)::int AS tickets
         FROM staff_users s LEFT JOIN arena_tickets t ON t.staff_id = s.id AND t.session_id = $1
        WHERE s.id IN (SELECT staff_id FROM arena_session_members WHERE session_id = $1 AND removed_at IS NULL)
           OR t.id IS NOT NULL
        GROUP BY s.id, s.full_name ORDER BY tickets DESC, s.full_name`, [sid]),
    db.query(`SELECT count(*)::int AS n FROM arena_messages WHERE session_id = $1 AND deleted_at IS NULL`, [sid]),
  ]);
  if (!session.rows[0]) return bad(res, 'That session does not exist.', 404);

  const claims = await db.query(
    `SELECT count(*)::int AS n FROM arena_claims c JOIN arena_spins p ON p.id = c.spin_id
      WHERE p.session_id = $1 AND c.status = 'pending'`, [sid]);
  const fulfilments = await db.query(
    `SELECT count(*)::int AS n FROM arena_challenge_entries e
       JOIN arena_challenges c ON c.id = e.challenge_id
      WHERE c.session_id = $1 AND e.status = 'pending'`, [sid]);
  const challenges = await db.query(
    `SELECT state, count(*)::int AS n FROM arena_challenges WHERE session_id = $1 GROUP BY state`, [sid]);

  const rows = spins.rows;
  const waiting = rows.reduce((a, p) => a + Number(p.checkins_pending) + Number(p.entries_pending), 0)
    + Number(claims.rows[0].n) + Number(fulfilments.rows[0].n);

  res.json({
    session: session.rows[0],
    serverNow: new Date().toISOString(),
    // The one number that decides whether the super admin needs to look.
    waitingOnYou: waiting,
    spins: rows.map((p) => ({
      id: p.id, seq: p.seq, title: p.title, state: p.state,
      entryDeadlineAt: p.entry_deadline_at, launchAt: p.launch_at, decidedAt: p.decided_at,
      checkins: Number(p.checkins), checkinsPending: Number(p.checkins_pending),
      checkinPeople: p.checkin_people || [],
      entries: Number(p.entries), entriesPending: Number(p.entries_pending),
      wheelsDone: Number(p.wheels_done), wheelsTotal: Number(p.wheels_total),
      outcomeNote: p.outcome_note,
    })),
    awards: awards.rows,
    // Everybody's standing. This screen is the ONE place a full list is
    // reasonable, because it is the person running the day looking at it — the
    // players' own board deliberately shows only the top few and their own
    // position, so nobody is ever shown that they are last.
    standings: tickets.rows,
    challenges: Object.fromEntries(challenges.rows.map((c) => [c.state, c.n])),
    pending: {
      checkins: rows.reduce((a, p) => a + Number(p.checkins_pending), 0),
      entries: rows.reduce((a, p) => a + Number(p.entries_pending), 0),
      claims: Number(claims.rows[0].n),
      fulfilments: Number(fulfilments.rows[0].n),
    },
    chatMessages: chat.rows[0].n,
  });
});

// ===========================================================================
// THE AI HELPER — always optional, never publishes
// ===========================================================================

router.get('/ai/status', async (req, res) => {
  res.json({
    available: copilot.available(),
    model: copilot.modelName(),
    label: copilot.AI_LABEL,
    note: copilot.available()
      ? 'The helper can suggest wording and ideas. Everything it writes lands in a box you can edit — it never sends anything by itself.'
      : 'The AI helper is not switched on for this company. Everything here works without it.',
  });
});

/** Turn a sentence into a filled-in new-spin form. A DRAFT, always. */
router.post('/ai/spin', requireSuper, async (req, res) => {
  const text = String((req.body || {}).text || '').trim();
  if (!text) return bad(res, 'Tell it what you want the spin to be.');
  const out = await copilot.draftSpin({ text, gameKeys: games.GAME_KEYS, staffId: req.actor.id });
  if (!out.ok) return res.status(200).json({ ok: false, reason: out.reason });
  res.json({ ok: true, draft: out.data, label: out.label, model: out.model, aiGenerated: true });
});

router.post('/ai/prizes', async (req, res) => {
  const b = req.body || {};
  const out = await copilot.prizeIdeas({
    text: b.text, kind: b.kind, capUsd: b.capUsd,
    avoid: Array.isArray(b.avoid) ? b.avoid : [], staffId: req.actor.id,
  });
  if (!out.ok) return res.status(200).json({ ok: false, reason: out.reason });
  res.json({ ok: true, ideas: (out.data && out.data.ideas) || [], label: out.label, model: out.model, aiGenerated: true });
});

router.post('/ai/challenges', requireSuper, async (req, res) => {
  const b = req.body || {};
  const out = await copilot.challengeIdeas({
    text: b.text, avoid: Array.isArray(b.avoid) ? b.avoid : [], staffId: req.actor.id,
  });
  if (!out.ok) return res.status(200).json({ ok: false, reason: out.reason });
  res.json({ ok: true, ideas: (out.data && out.data.ideas) || [], label: out.label, model: out.model, aiGenerated: true });
});

/** Tidy up what somebody typed. RETURNED, never applied. */
router.post('/ai/rewrite', async (req, res) => {
  const text = String((req.body || {}).text || '').trim();
  if (!text) return bad(res, 'There is nothing to tidy up yet.');
  if (text.length > 3000) return bad(res, 'That is too long for the helper — keep it under 3000 characters.');
  const out = await copilot.rewrite({ text, purpose: (req.body || {}).purpose, staffId: req.actor.id });
  if (!out.ok) return res.status(200).json({ ok: false, reason: out.reason });
  res.json({
    ok: true,
    original: text,                 // handed back deliberately, so the screen can always put it back
    rewritten: (out.data && out.data.rewritten) || text,
    whatChanged: (out.data && out.data.whatChanged) || '',
    label: out.label, model: out.model, aiGenerated: true,
  });
});

router.post('/ai/subjects', requireSuper, async (req, res) => {
  const out = await copilot.subjectLines({ text: String((req.body || {}).text || '').trim(), staffId: req.actor.id });
  if (!out.ok) return res.status(200).json({ ok: false, reason: out.reason });
  res.json({ ok: true, subjects: (out.data && out.data.subjects) || [], label: out.label, model: out.model, aiGenerated: true });
});

module.exports = router;
