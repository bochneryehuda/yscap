'use strict';
/**
 * THE SPIN RUNNER -- the state machine behind every wheel turn.
 *
 * THE ORDER OF EVENTS IS THE WHOLE DESIGN. It is written out here because the
 * order is what makes the draw trustworthy, and any rearrangement quietly
 * destroys that while leaving everything still apparently working:
 *
 *   1. CREATE.  The moment a spin is created, EVERY wheel it will run gets its
 *      secret seed and publishes the fingerprint of it (`commit_hash`). This
 *      happens before check-in opens, before anybody has entered anything, and
 *      before any candidate list exists. That is the point: a seed committed
 *      later could have been tried against a known list until it produced a
 *      convenient name. Committed first, it cannot be.
 *   2. OPEN.    People check in and say what they would like to win. A super
 *      admin approves.
 *   3. LOCK.    The wheel's candidate list is FROZEN and its fingerprint
 *      (`roster_hash`) published. Everyone can see exactly who is on the wheel
 *      before it moves.
 *   4. SPIN.    The server works out the winner from the frozen list and the
 *      committed seed, THEN computes how far the wheel must turn to land there.
 *      It broadcasts the start time and duration; every screen in the building
 *      animates the same wheel to the same stop from the same clock.
 *   5. REVEAL.  The secret seed is disclosed. Anyone can now recompute the
 *      whole thing and confirm nobody steered it.
 *
 * A LATER WHEEL DEPENDS ON AN EARLIER ONE. "Spin what wins, then spin who did
 * it" means wheel two's candidates are not knowable until wheel one has landed.
 * So each wheel is frozen at step 3 in its own turn -- wheel one at lock, wheel
 * two when wheel one reveals -- while both were COMMITTED back at step 1. That
 * is exactly the property that matters: the seed is always older than the list.
 *
 * THE WHEEL IS NEVER THE DECIDER. The winner is computed first and the rotation
 * derived from it. A wheel that reports whatever it lands on has moved the
 * decision into a browser, where it cannot be verified and can be watched
 * happening in devtools.
 *
 * SETTLING IS BELT AND BRACES. When a wheel starts, a timer is set to reveal it
 * when the animation ends -- and `settleDue()` also reveals any wheel whose
 * time has passed, and is called on every read of the board and by the sweep.
 * A process restart mid-spin therefore cannot leave the room staring at a wheel
 * that never stops.
 *
 * NOTHING HERE DECIDES WHO MAY DO ANY OF IT. Permission is the route's job
 * (super admin only for everything in this file); this module is the mechanism.
 */

const db = require('../../db');
const fair = require('./fair-draw');
const sources = require('./candidate-sources');
const games = require('./game-types');
const templates = require('./templates');
const jokes = require('./joke-prizes');
const settings = require('./settings');

/** Fired for the live channel. Injected by routes/arena.js so this module has
 *  no opinion about transport and can be tested without one. */
let broadcast = () => {};
function setBroadcaster(fn) { if (typeof fn === 'function') broadcast = fn; }

const asConfig = (spin) => (spin && spin.config && typeof spin.config === 'object') ? spin.config : {};

async function getSpin(spinId) {
  const r = await db.query(`SELECT * FROM arena_spins WHERE id = $1`, [spinId]);
  return r.rows[0] || null;
}
async function getSession(sessionId) {
  const r = await db.query(`SELECT * FROM arena_sessions WHERE id = $1`, [sessionId]);
  return r.rows[0] || null;
}
async function getDraws(spinId) {
  const r = await db.query(`SELECT * FROM arena_draws WHERE spin_id = $1 ORDER BY seq`, [spinId]);
  return r.rows;
}

/**
 * Create the spin AND commit a seed for every wheel it will run, in one
 * transaction. If the commit half failed after the spin were saved, the spin
 * would exist with wheels that were never committed -- which is the one state
 * that would let a seed be chosen after the fact.
 */
async function createSpin({ sessionId, title, subtitle, kind, config, entryOpensAt, entryDeadlineAt, createdBy }) {
  const base = games.defaultsFor(kind) || games.defaultsFor('classic_raffle');
  const merged = { ...base, ...(config || {}) };
  const problems = games.configProblems(merged);
  if (problems.length) { const e = new Error(problems.join(' ')); e.arenaProblems = problems; throw e; }

  // db.getClient() rather than pool.connect(): it is the wrapped accessor every
  // other transaction in this codebase uses, so this one shows up in the same
  // query tracking as the rest.
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const seqRow = await client.query(
      `SELECT COALESCE(max(seq), 0) + 1 AS next FROM arena_spins WHERE session_id = $1`, [sessionId]);
    const seq = seqRow.rows[0].next;
    const ins = await client.query(
      `INSERT INTO arena_spins (session_id, seq, title, subtitle, kind, state, config,
                                entry_opens_at, entry_deadline_at, created_by)
       VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9) RETURNING *`,
      [sessionId, seq, title || `Spin ${seq}`, subtitle || null, merged.kind || kind || 'classic_raffle',
        JSON.stringify(merged), entryOpensAt || null, entryDeadlineAt || null, createdBy || null]);
    const spin = ins.rows[0];

    // One committed seed per wheel, right now, before anything is knowable.
    for (let i = 0; i < merged.wheels.length; i++) {
      const w = merged.wheels[i];
      const { serverSeed, commitHash } = fair.newCommitment();
      await client.query(
        `INSERT INTO arena_draws (spin_id, seq, title, pool, state, commit_hash, server_seed,
                                  nonce, duration_ms, created_by)
         VALUES ($1,$2,$3,$4,'committed',$5,$6,$7,$8,$9)`,
        [spin.id, i + 1, w.title || `Wheel ${i + 1}`, w.source, commitHash,
          // The seed is STORED now and only PUBLISHED at reveal. It has to be
          // stored, or nobody could reveal it; what makes the scheme work is
          // that the fingerprint was published first and is unchangeable.
          serverSeed, 1, Math.round(Number(merged.durationMs) || 7000), createdBy || null]);
    }
    await client.query('COMMIT');
    return spin;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* connection already gone */ }
    throw e;
  } finally {
    client.release();
  }
}

/** draft -> open. Check-in and entries begin. */
async function openSpin(spinId) {
  const r = await db.query(
    `UPDATE arena_spins SET state = 'open', entry_opens_at = COALESCE(entry_opens_at, now()), updated_at = now()
      WHERE id = $1 AND state = 'draft' RETURNING *`, [spinId]);
  if (!r.rows[0]) throw new Error('That spin is not waiting to be opened.');
  broadcast('arena:spin', { spinId, state: 'open' });
  return r.rows[0];
}

/** open -> locked. The door shuts; wheel one's list is frozen and published. */
async function lockSpin(spinId) {
  const r = await db.query(
    `UPDATE arena_spins SET state = 'locked', locked_at = now(), updated_at = now()
      WHERE id = $1 AND state IN ('open','draft') RETURNING *`, [spinId]);
  if (!r.rows[0]) throw new Error('That spin is not open.');
  await freezeRoster(spinId, 1).catch((e) => {
    // A freeze that cannot find anybody is a REAL problem the admin must see,
    // but it must not leave the spin half-locked. The lock stands; the freeze
    // is retried when they press spin, which is where the error belongs.
    console.warn(`[arena] wheel 1 of spin ${spinId} could not be frozen at lock: ${e.message}`);
  });
  broadcast('arena:spin', { spinId, state: 'locked' });
  return r.rows[0];
}

/**
 * Freeze one wheel's candidate list and publish its fingerprint.
 * Idempotent: a wheel already frozen is returned untouched, because re-freezing
 * after people have seen the list is precisely the tamper this guards against.
 */
/**
 * Of the wheels that CARRIED a joke, did it land? Newest first.
 *
 * ONLY WHEELS THAT COULD HAVE LANDED ONE COUNT, and getting that wrong made the
 * whole pacing rule dead on the shape the day actually runs in. Elementix Day
 * spins TWO wheels — what you win, then who won it — and the people wheel never
 * carries a joke. Reading every revealed draw therefore meant the newest one was
 * almost always the people wheel, so "one just landed, back off" never once
 * fired, and every people wheel counted as a clean spin and inflated the rate.
 * Caught by the control run of its own test, not by reading.
 *
 * Read from what actually happened rather than from a counter, so a restart, a
 * cancelled spin or an admin re-running a wheel cannot desynchronise it. Never
 * throws: an unreadable history means the ordinary share, which is the safe
 * middle rather than a surprise in either direction.
 */
async function recentJokeOutcomes(sessionId, limit = 5) {
  try {
    const r = await db.query(
      `SELECT d.winner_key
         FROM arena_draws d JOIN arena_spins p ON p.id = d.spin_id
        WHERE p.session_id = $1 AND d.state = 'revealed' AND d.winner_key IS NOT NULL
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(d.roster, '[]'::jsonb)) c
                       WHERE (c -> 'meta' ->> 'joke') = 'true')
        ORDER BY d.revealed_at DESC NULLS LAST, d.id DESC LIMIT $2`, [sessionId, limit]);
    return r.rows.map((x) => !!jokes.jokeFor(x.winner_key));
  } catch (_) { return []; }
}

/** Which jokes this session has already told — a punchline repeats badly. */
async function jokesAlreadyTold(sessionId) {
  try {
    const r = await db.query(
      `SELECT DISTINCT c ->> 'key' AS k
         FROM arena_draws d JOIN arena_spins p ON p.id = d.spin_id,
              LATERAL jsonb_array_elements(COALESCE(d.roster, '[]'::jsonb)) c
        WHERE p.session_id = $1 AND (c -> 'meta' ->> 'joke') = 'true'`, [sessionId]);
    return r.rows.map((x) => x.k).filter(Boolean);
  } catch (_) { return []; }
}

async function freezeRoster(spinId, seq) {
  const spin = await getSpin(spinId);
  if (!spin) throw new Error('That spin does not exist.');
  const session = await getSession(spin.session_id);
  const draws = await getDraws(spinId);
  const draw = draws.find((d) => d.seq === seq);
  if (!draw) throw new Error(`This spin has no wheel ${seq}.`);
  if (draw.roster) return draw;                       // already frozen; leave it alone
  if (draw.state === 'revealed') return draw;

  const config = asConfig(spin);
  const wheels = Array.isArray(config.wheels) ? config.wheels : [];
  const wheel = wheels[seq - 1];
  if (!wheel) throw new Error(`This spin has no wheel ${seq}.`);

  // What the previous wheel landed on -- this is what makes "spin what wins,
  // then spin who did it" work.
  const prev = draws.find((d) => d.seq === seq - 1);
  const previousWinnerKey = prev && prev.state === 'revealed' ? prev.winner_key : null;
  if (seq > 1 && !previousWinnerKey) {
    throw new Error(`Wheel ${seq - 1} has not finished yet, so wheel ${seq} cannot be set up.`);
  }

  // TICKETS ARE THE ODDS, READ FROM THE LEDGER (owner's Mega Spin premise:
  // "for every challenge you do you get another chance" — measured broken
  // 2026-08-19: Ben with 9 chances and Ann with 1 froze as identical slices,
  // because the 'tickets' weight branch read `config.weights`, an admin-typed
  // map nothing ever populated). The ledger is summed HERE, at freeze time,
  // into the ctx copy of that same map — never written back onto the stored
  // spin — so `weightFor`'s existing branch does the rest and an admin-typed
  // entry still wins over the ledger (an explicit number is a decision).
  // Everyone starts from ONE slice and their chances stack on top (1 + sum),
  // because being in the room already earns a place on this wheel and "more
  // tickets, better odds — but everyone still has a chance" is the promise the
  // screen makes. Negative sums (reversals past zero) floor at the base 1.
  let ctxConfig = config;
  if ((config.weightMode || 'equal') === 'tickets') {
    const led = await db.query(
      `SELECT staff_id, COALESCE(sum(count), 0)::int AS n
         FROM arena_tickets WHERE session_id = $1 GROUP BY staff_id`, [spin.session_id]);
    const weights = {};
    for (const row of led.rows) weights[String(row.staff_id)] = 1 + Math.max(0, Number(row.n) || 0);
    ctxConfig = { ...config, weights: { ...weights, ...(config.weights || {}) } };
  }

  const built = await sources.buildPool(wheel.source, {
    spin, session, config: ctxConfig, weightMode: config.weightMode || 'equal', previousWinnerKey,
  });
  const candidates = built.candidates || [];
  if (!candidates.length) {
    throw new Error(`There is nobody (and nothing) on wheel ${seq} yet - "${wheel.title || wheel.source}" came back empty.`);
  }
  const total = candidates.reduce((a, c) => a + (Number(c.weight) || 0), 0);
  if (total <= 0) {
    throw new Error(`Everyone on wheel ${seq} has zero tickets, so nobody could win. Give somebody a ticket first.`);
  }

  // ── THE BOOBY PRIZES ────────────────────────────────────────────────────
  // Put on the wheel HERE, before the hash, because that is what keeps the
  // fairness story whole: they are in the published roster, inside the hash,
  // and they take up real space. The alternative — letting the wheel land and
  // then swapping the answer for a joke one time in four — is a rigged wheel,
  // and no gag is worth the sentence "the draw is checkable by anybody".
  //
  // PRIZE WHEELS ONLY. The owner was explicit: "not on the officer but on the
  // prize that you win". A joke on the people wheel would mean nobody wins,
  // which is a different and much less funny thing.
  // TWO SWITCHES, and the spin's own always wins: a super admin can turn them
  // off for the whole day in the Arena's settings, or for one spin that is
  // meant to be serious without touching the day.
  let withJokes = candidates;
  const arenaCfg = await settings.load().then((c) => c.settings || {}).catch(() => ({}));
  const jokesOn = config.jokePrizes != null ? config.jokePrizes !== false : arenaCfg.jokePrizes !== false;
  if (built.scope === 'prizes' && jokesOn) {
    const pinned = [config.jokeShare, arenaCfg.jokeShare].find((x) => Number.isFinite(Number(x)));
    withJokes = jokes.injectInto(candidates, {
      recent: await recentJokeOutcomes(spin.session_id),
      used: await jokesAlreadyTold(spin.session_id),
      share: pinned == null ? null : Number(pinned),
    });
  }
  const finalCandidates = withJokes;
  const hash = fair.rosterHash(finalCandidates);
  // WHO HOLDS THE BUTTON. If this wheel's stop button belongs to the winner of
  // an earlier wheel (the Early Bird's shape), resolve that now -- at freeze
  // time, when the earlier wheel has already landed. Resolved once and stored,
  // so the person holding it cannot change after the room has been told.
  const holderFrom = templates.stopHolderSource(config, seq);
  let holder = null;
  if (holderFrom) {
    const src = draws.find((d) => d.seq === holderFrom);
    if (src && src.state === 'revealed' && src.winner_staff_id) holder = src.winner_staff_id;
  }
  const upd = await db.query(
    `UPDATE arena_draws SET roster = $2::jsonb, roster_hash = $3,
            stop_holder_staff_id = COALESCE(stop_holder_staff_id, $4)
      WHERE id = $1 AND roster IS NULL RETURNING *`,
    [draw.id, JSON.stringify(finalCandidates), hash, holder]);
  // The WHERE guard means a racing second freeze changes nothing; read back
  // whichever version won rather than reporting the one we built.
  const frozen = upd.rows[0] || (await db.query(`SELECT * FROM arena_draws WHERE id = $1`, [draw.id])).rows[0];
  broadcast('arena:roster', {
    spinId, seq, count: finalCandidates.length, rosterHash: frozen.roster_hash,
    stopHolderStaffId: frozen.stop_holder_staff_id ? String(frozen.stop_holder_staff_id) : null,
  });
  return frozen;
}

/**
 * Turn the wheel.
 *
 * `clientSeed` is the value contributed in the room -- typed by whoever is
 * running the day, or generated if they did not type one. It exists so the
 * house does not solely control the input. When it is generated, it is
 * generated HERE and recorded, so it is still fixed before the result is known.
 */
async function startSpin(spinId, seq, { clientSeed, by } = {}) {
  const spin = await getSpin(spinId);
  if (!spin) throw new Error('That spin does not exist.');
  if (spin.state === 'cancelled') throw new Error('That spin was cancelled.');
  if (spin.state === 'draft') throw new Error('Open the spin before turning the wheel.');

  const draw = await freezeRoster(spinId, seq);
  if (draw.state === 'revealed') throw new Error(`Wheel ${seq} has already been spun.`);
  if (draw.state === 'spinning') throw new Error(`Wheel ${seq} is spinning right now.`);
  if (!draw.server_seed) throw new Error(`Wheel ${seq} has no committed seed - it cannot be spun.`);

  const config = asConfig(spin);
  const candidates = draw.roster || [];
  const seed = String(clientSeed == null ? '' : clientSeed).trim()
    || `${new Date().toISOString()}#${Math.floor(Number(draw.nonce) || 1)}`;

  // ── TWO WAYS A WHEEL CAN STOP, and they are genuinely different ──────────
  //
  // HELD: somebody holds the stop button. The wheel spins and KEEPS SPINNING
  // until they press it, and where it lands is really decided by when they
  // pressed — nothing is chosen in advance. It is still checkable afterwards,
  // because the landing comes from the sealed seed plus the moment the press
  // reached the server, both of which are on the record. And it cannot be
  // aimed: at this speed the wheel crosses a slice in a few tens of
  // milliseconds, so a person can lean on roughly which quarter and no finer.
  //
  // AUTO: no button-holder. The winner is settled first and the wheel is turned
  // to it over a fixed time.
  if (draw.stop_holder_staff_id) {
    const held = await db.query(
      `UPDATE arena_draws
          SET state = 'spinning', client_seed = $2, spin_started_at = now(),
              duration_ms = $3, stop_mode = NULL, target_rotation_deg = NULL
        WHERE id = $1 AND state = 'committed'
        RETURNING *`,
      [draw.id, seed, Math.max(1500, Math.min(600000, Math.round(Number(config.maxHeldMs) || 300000)))]);
    if (!held.rows[0]) throw new Error(`Wheel ${seq} was already started by somebody else.`);
    const row = held.rows[0];
    await db.query(`UPDATE arena_spins SET state = 'spinning', updated_at = now() WHERE id = $1 AND state <> 'decided'`, [spinId]);
    broadcast('arena:spinning', {
      spinId, seq, drawId: row.id,
      startedAt: row.spin_started_at,
      // No duration and no stop angle, because there is no answer yet.
      durationMs: null,
      targetRotationDeg: null,
      degPerSecond: Math.max(120, Math.round(Number(config.degPerSecond) || 900)),
      free: true,
      rosterHash: row.roster_hash,
      commitHash: row.commit_hash,
      stopHolderStaffId: String(row.stop_holder_staff_id),
      stopTruth: templates.STOP_BUTTON_TRUTH,
      serverNow: new Date().toISOString(),
    });
    // A safety net, not the mechanism: if nobody ever presses, the wheel is
    // stopped for them rather than turning until the end of time. It is
    // deliberately long — this is a person's moment, not a timeout to race.
    const t = setTimeout(() => { pressStopInternal(row.id, null).catch(() => {}); }, row.duration_ms + 500);
    if (t.unref) t.unref();
    return row;
  }

  const result = fair.runDraw({
    candidates,
    serverSeed: draw.server_seed,
    clientSeed: seed,
    nonce: Number(draw.nonce) || 1,
    fullTurns: Math.max(1, Math.floor(Number(config.fullTurns) || 6)),
    // Cosmetic only -- bounded inside the winning slice, so it cannot move the
    // result. Derived from the roster hash so it is reproducible, not random.
    jitterFraction: (parseInt(String(draw.roster_hash || '0').slice(0, 4), 16) % 61 - 30) / 100,
  });

  const winner = candidates[result.index] || {};
  const meta = winner.meta || {};
  const durationMs = Math.max(1500, Math.min(60000, Math.round(Number(config.durationMs) || draw.duration_ms || 7000)));

  const upd = await db.query(
    `UPDATE arena_draws
        SET state = 'spinning', client_seed = $2, winner_index = $3, winner_key = $4,
            winner_label = $5, winner_staff_id = $6, winner_entry_id = $7,
            target_rotation_deg = $8, duration_ms = $9, spin_started_at = now()
      WHERE id = $1 AND state = 'committed'
      RETURNING *`,
    [draw.id, seed, result.index, result.key, result.label,
      meta.staffId || null, meta.entryId || null,
      result.targetRotationDeg, durationMs]);
  if (!upd.rows[0]) throw new Error(`Wheel ${seq} was already started by somebody else.`);
  const started = upd.rows[0];

  await db.query(`UPDATE arena_spins SET state = 'spinning', updated_at = now() WHERE id = $1 AND state <> 'decided'`, [spinId]);

  // The room gets the start time, the duration and the stop angle -- everything
  // needed to animate the identical wheel -- but NOT the winner and NOT the
  // seed. The label arrives with the reveal, so a curious person with devtools
  // open cannot see the answer before the wheel does.
  broadcast('arena:spinning', {
    spinId, seq, drawId: started.id,
    startedAt: started.spin_started_at,
    durationMs,
    targetRotationDeg: Number(started.target_rotation_deg),
    rosterHash: started.roster_hash,
    commitHash: started.commit_hash,
    // Who may press stop, so exactly one screen shows the button. The winner
    // is still NOT in this frame -- holding the button does not mean knowing
    // the answer, and it must not mean seeing it early either.
    stopHolderStaffId: started.stop_holder_staff_id ? String(started.stop_holder_staff_id) : null,
    stopTruth: templates.STOP_BUTTON_TRUTH,
    serverNow: new Date().toISOString(),
  });

  // Reveal when the animation ends. `unref` so this timer can never hold a
  // shutdown open; `settleDue()` is the real guarantee (see the header).
  const t = setTimeout(() => { revealDraw(started.id).catch(() => {}); }, durationMs + 250);
  if (t.unref) t.unref();

  return started;
}

/**
 * The wheel has stopped: disclose the seed, announce the winner, and -- if this
 * was the last wheel -- record the award.
 */
async function revealDraw(drawId, { stoppedBy = null } = {}) {
  const r = await db.query(
    `UPDATE arena_draws
        SET state = 'revealed', revealed_at = now(),
            stopped_at = COALESCE(stopped_at, now()),
            stop_mode = COALESCE(stop_mode, $2)
      WHERE id = $1 AND state IN ('spinning', 'stopping') RETURNING *`,
    [drawId, stoppedBy ? 'held' : 'auto']);
  if (!r.rows[0]) return null;                     // already revealed, or never spun
  const draw = r.rows[0];
  const spin = await getSpin(draw.spin_id);
  const candidates = draw.roster || [];
  const winner = candidates[draw.winner_index] || {};

  broadcast('arena:revealed', {
    spinId: draw.spin_id, seq: draw.seq, drawId: draw.id,
    winnerKey: draw.winner_key, winnerLabel: draw.winner_label,
    winnerMeta: winner.meta || null,
    // Disclosed only now. This is the half of the proof that was withheld.
    serverSeed: draw.server_seed, commitHash: draw.commit_hash,
    clientSeed: draw.client_seed, nonce: draw.nonce, rosterHash: draw.roster_hash,
  });

  const draws = await getDraws(draw.spin_id);
  const config = asConfig(spin);
  const total = (Array.isArray(config.wheels) ? config.wheels : []).length || draws.length;
  const allDone = draws.filter((d) => d.state === 'revealed').length >= total;
  if (allDone) await settleSpin(spin, draws);
  return draw;
}

/**
 * Every wheel has landed: work out WHO won and WHAT, and write it down.
 *
 * The person is the first revealed wheel that produced a staff member; the
 * prize is the first that produced an entry, a catalogue prize or a typed
 * label. Written this way round -- rather than assuming wheel 1 is people --
 * because the owner explicitly asked to be able to spin the prize first.
 *
 * A FILE wheel resolves to that file's loan officer, which is what "the file
 * that wins, that officer wins something" means.
 */
async function settleSpin(spin, draws) {
  if (!spin) return null;
  const revealed = draws.filter((d) => d.state === 'revealed').sort((a, b) => a.seq - b.seq);

  // A BUTTON LOTTERY IS NOT THE WINNER (owner's day, measured 5/5 wrong before
  // this line). On the Early Bird, wheels 1 and 2 exist only to hand out the
  // stop buttons — `stopHolders` names them as `fromWheel` sources — and wheel 3
  // is "Which loan officer wins". Taking the FIRST revealed wheel with a staff
  // id therefore awarded the prize to whoever won the BUTTON, while the room
  // watched wheel 3 announce somebody else: the ledger, the payroll CSV, the
  // winner email and the recap all named the wrong person, every single time.
  // So any wheel that merely hands its winner a button is excluded from award
  // candidacy. An ordinary spin has no stopHolders and is byte-identical.
  const cfg = asConfig(spin);
  const buttonWheels = new Set(
    (Array.isArray(cfg.stopHolders) ? cfg.stopHolders : [])
      .map((x) => Number(x && x.fromWheel)).filter((n) => n > 0));

  let staffId = null;
  let personLabel = null;
  let prizeLabel = null;
  let prizeKind = 'personal';
  let prizeValue = 0;
  let entryId = null;
  let jokeDetail = null;

  for (const d of revealed) {
    const cand = (d.roster || [])[d.winner_index] || {};
    const meta = cand.meta || {};
    const isButtonLottery = buttonWheels.has(Number(d.seq));
    if (!isButtonLottery && !staffId && d.winner_staff_id) { staffId = d.winner_staff_id; personLabel = d.winner_label; }
    if (!isButtonLottery && !staffId && meta.officerStaffId) { staffId = meta.officerStaffId; personLabel = meta.officer || d.winner_label; }
    // A JOKE COUNTS AS THE OUTCOME, and is recorded as its own kind with no
    // value. It has to be here, or a wheel that lands on one would settle with
    // no prize at all and the room would be told nothing happened — which is
    // the opposite of the point. `valueCents` is forced to zero rather than
    // trusted, so no wording in the library can ever become money owed.
    if (!prizeLabel && meta.joke === true) {
      prizeLabel = d.winner_label;
      prizeKind = 'joke';
      prizeValue = 0;
      jokeDetail = meta.detail || null;
    } else if (!prizeLabel && (meta.entryId || meta.prizeId || meta.custom)) {
      prizeLabel = d.winner_label;
      prizeKind = meta.kind === 'business' ? 'business' : (meta.kind === 'perk' ? 'perk' : 'personal');
      prizeValue = Number(meta.valueCents) || 0;
      entryId = meta.entryId || null;
    }
  }
  // A single-wheel prize spin (the person was already decided in the room) has
  // no staff member on it. That is legitimate; there is simply nothing to
  // record in the awards ledger, and the draw itself remains the record.
  const reason = revealed.map((d) => `${d.title}: ${d.winner_label}`).join(' | ');
  await db.query(
    `UPDATE arena_spins SET state = 'decided', decided_at = now(),
            outcome_note = COALESCE(outcome_note, $2), updated_at = now()
      WHERE id = $1`, [spin.id, reason]);

  let award = null;
  if (staffId) {
    const a = await db.query(
      `INSERT INTO arena_awards (session_id, spin_id, staff_id, prize_label, prize_kind, value_cents, reason, entry_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (spin_id, staff_id) DO NOTHING
       RETURNING *`,
      [spin.session_id, spin.id, staffId, prizeLabel || spin.title, prizeKind, prizeValue, reason, entryId]);
    award = a.rows[0] || null;
  }
  broadcast('arena:decided', {
    spinId: spin.id, sessionId: spin.session_id, seq: spin.seq,
    winnerStaffId: staffId, winnerName: personLabel,
    // `joke` and its follow-through ride along so the full-screen takeover can
    // deliver the punchline instead of announcing a prize that is not one.
    prizeLabel, prizeKind, valueCents: prizeValue, reason,
    joke: prizeKind === 'joke', jokeDetail,
  });
  // AND TELL THE PEOPLE WHO WERE NOT LOOKING. The broadcast above reaches the
  // thirty people watching the wheel; somebody who won while they were on a
  // call hears nothing from it. `announce` sends the winner their own message
  // and the room the result, exactly once — it claims the send in the database
  // first, so a replayed settle cannot send it twice. Fire-and-forget: a
  // message that cannot go must never undo an award that is already written.
  require('./announce').spinDecided(spin, {
    staffId, personLabel, prizeLabel, prizeValue, reason,
    joke: prizeKind === 'joke', jokeDetail,
  })
    .then((r) => { if (r && r.sent) console.log(`[arena] spin ${spin.seq} result sent to ${r.sent}`); })
    .catch((e) => console.warn(`[arena] result announcement failed: ${(e && e.message) || e}`));
  return { award, staffId, personLabel, prizeLabel, prizeKind, prizeValue, reason, jokeDetail };
}

/**
 * Reveal every wheel whose animation has finished. Called on each read of the
 * board and by the background sweep, so a restart mid-spin heals itself instead
 * of leaving a wheel spinning forever. Never throws.
 */
async function settleDue() {
  try {
    const r = await db.query(
      `SELECT id FROM arena_draws
        WHERE (
                (state = 'spinning' AND spin_started_at IS NOT NULL
                 AND spin_started_at + (duration_ms || ' milliseconds')::interval < now())
             OR (state = 'stopping' AND stopped_at IS NOT NULL
                 AND stopped_at < now() - interval '10 seconds')
              )`);
    let n = 0;
    for (const row of r.rows) { if (await revealDraw(row.id)) n++; }
    return n;
  } catch (e) {
    console.warn(`[arena] could not settle finished wheels: ${(e && e.message) || e}`);
    return 0;
  }
}

/**
 * Re-run a recorded draw and report whether it holds. This is what the
 * "check it yourself" button asks for. It uses the SAME functions the draw used
 * -- there is no second implementation to disagree.
 */
async function verify(drawId) {
  const r = await db.query(
    `SELECT *, EXTRACT(EPOCH FROM (stopped_at - spin_started_at)) * 1000 AS elapsed_ms
       FROM arena_draws WHERE id = $1`, [drawId]);
  const d = r.rows[0];
  if (!d) return { ok: false, reason: 'that draw does not exist' };

  // A HELD wheel is checked by different maths, because it WAS decided
  // differently: the landing came from the moment the button was pressed, not
  // from a winner chosen in advance. Same evidence, same seal, different sum —
  // and both live in fair-draw.js, so neither can drift from what happened.
  if (d.stop_mode === 'held') {
    const spin = await getSpin(d.spin_id);
    const config = asConfig(spin);
    const elapsedMs = Math.round(Number(d.elapsed_ms) || 0);
    const degPerSecond = Math.max(120, Math.round(Number(config.degPerSecond) || 900));
    const spinDownDeg = Math.max(0, Math.round(Number(config.spinDownDeg) || 540));
    const held = fair.verifyHeldDraw({
      candidates: d.roster || [],
      serverSeed: d.state === 'revealed' ? d.server_seed : null,
      commitHash: d.commit_hash,
      rosterHash: d.roster_hash,
      elapsedMs, degPerSecond, spinDownDeg,
      winnerIndex: d.winner_index, winnerKey: d.winner_key,
    });
    return {
      ...held,
      mode: 'held',
      drawId: d.id, seq: d.seq, title: d.title,
      candidateCount: (d.roster || []).length,
      winnerLabel: d.winner_label,
      commitHash: d.commit_hash, rosterHash: d.roster_hash,
      serverSeed: d.state === 'revealed' ? d.server_seed : null,
      elapsedMs, degPerSecond, spinDownDeg,
      stoppedByPerson: true,
    };
  }

  const res = fair.verifyDraw({
    candidates: d.roster || [],
    serverSeed: d.state === 'revealed' ? d.server_seed : null,
    commitHash: d.commit_hash,
    clientSeed: d.client_seed,
    nonce: d.nonce,
    rosterHash: d.roster_hash,
    winnerIndex: d.winner_index,
    winnerKey: d.winner_key,
  });
  return {
    ...res,
    mode: 'auto',
    drawId: d.id, seq: d.seq, title: d.title,
    candidateCount: (d.roster || []).length,
    winnerLabel: d.winner_label,
    commitHash: d.commit_hash,
    rosterHash: d.roster_hash,
    clientSeed: d.client_seed,
    nonce: d.nonce,
    serverSeed: d.state === 'revealed' ? d.server_seed : null,
  };
}

/**
 * PRESS STOP.
 *
 * The one thing worth being completely clear about: this does NOT choose the
 * winner. The winner was settled by `startSpin` before the wheel moved, from a
 * seed committed before anybody entered, and it is verifiable afterwards by
 * anyone in the room. What this decides is WHEN the wheel stops -- which is a
 * real thing to hold, and the best seat in the house.
 *
 * Only the person holding the button may press it, and only once. A wheel with
 * no holder stops by itself when its time runs out, exactly as before.
 */
async function pressStop(drawId, staffId) {
  const r = await db.query(`SELECT * FROM arena_draws WHERE id = $1`, [drawId]);
  const d = r.rows[0];
  if (!d) throw new Error('That wheel does not exist.');
  if (!d.stop_holder_staff_id) throw new Error('Nobody holds the button on this wheel — it stops on its own.');
  if (String(d.stop_holder_staff_id) !== String(staffId)) throw new Error('The button on this wheel is not yours.');
  return pressStopInternal(drawId, staffId);
}

/**
 * The press itself. `staffId` is null when the safety net fires instead of a
 * person — which is recorded honestly as 'auto', not passed off as a press.
 *
 * THE ELAPSED TIME IS MEASURED BY THE DATABASE, not by a browser and not by
 * this process. `now() - spin_started_at` in one statement means the number
 * that decides the result comes from one clock, and a laptop that is ninety
 * seconds fast cannot move it.
 */
async function pressStopInternal(drawId, staffId) {
  const claim = await db.query(
    `UPDATE arena_draws
        SET state = 'stopping', stopped_at = now(), stop_mode = $2
      WHERE id = $1 AND state = 'spinning'
      RETURNING *, EXTRACT(EPOCH FROM (now() - spin_started_at)) * 1000 AS elapsed_ms`,
    [drawId, staffId ? 'held' : 'auto']);
  if (!claim.rows[0]) throw new Error('That wheel had already stopped.');
  const d = claim.rows[0];
  const spin = await getSpin(d.spin_id);
  const config = asConfig(spin);
  const candidates = d.roster || [];

  const res = fair.runHeldDraw({
    candidates,
    serverSeed: d.server_seed,
    elapsedMs: Math.round(Number(d.elapsed_ms) || 0),
    degPerSecond: Math.max(120, Math.round(Number(config.degPerSecond) || 900)),
    spinDownDeg: Math.max(0, Math.round(Number(config.spinDownDeg) || 540)),
  });
  const meta = (candidates[res.index] || {}).meta || {};

  // STAYS in 'stopping' through the coast. Putting it back to 'spinning' would
  // reopen the door for a second press (and for the safety-net timer) while the
  // wheel was still slowing down — which is exactly the double-landing the
  // 'stopping' state exists to prevent. The suite caught this.
  const upd = await db.query(
    `UPDATE arena_draws
        SET winner_index = $2, winner_key = $3, winner_label = $4,
            winner_staff_id = $5, winner_entry_id = $6,
            target_rotation_deg = $7, duration_ms = $8
      WHERE id = $1 RETURNING *`,
    [d.id, res.index, res.key, res.label, meta.staffId || null, meta.entryId || null,
      res.targetRotationDeg, Math.round(Number(d.elapsed_ms) || 0) + 1600]);

  // Tell the room it is slowing down, and where it will come to rest — the
  // coast-down is the same on every screen because the angle is the server's.
  broadcast('arena:stopping', {
    spinId: d.spin_id, seq: d.seq, drawId: d.id,
    stoppedAt: d.stopped_at,
    elapsedMs: Math.round(Number(d.elapsed_ms) || 0),
    targetRotationDeg: res.targetRotationDeg,
    coastMs: 1600,
    byStaffId: staffId ? String(staffId) : null,
  });

  const t = setTimeout(() => { revealDraw(d.id, { stoppedBy: staffId }).catch(() => {}); }, 1700);
  if (t.unref) t.unref();
  return upd.rows[0];
}

/**
 * WHO IS AUTOMATICALLY IN A NEW SPIN.
 *
 * The owner: "when we start the spin, before we click start, everybody gets
 * auto selected — everybody that's part of the session — we can remove certain
 * people as well." So the answer is: everybody in the session, minus whoever
 * the admin took off. Taking somebody off is the exception, so the exceptions
 * are what is stored (`excluded_staff_ids`) and the roster is derived. Nobody
 * can be silently missing because a list was built once and then went stale.
 */
async function rosterFor(spin) {
  if (!spin) return [];
  const members = await db.query(
    `SELECT s.id, s.full_name, s.email, s.role, s.title
       FROM arena_session_members m JOIN staff_users s ON s.id = m.staff_id
      WHERE m.session_id = $1 AND m.removed_at IS NULL AND s.is_active = true AND s.is_external IS NOT TRUE
      ORDER BY s.full_name`, [spin.session_id]);
  const rows = members.rows.length ? members.rows : (await db.query(
    `SELECT id, full_name, email, role, title FROM staff_users
      WHERE is_active = true AND is_external IS NOT TRUE ORDER BY full_name`)).rows;
  const off = new Set((spin.excluded_staff_ids || []).map(String));
  return rows.map((r) => ({ ...r, excluded: off.has(String(r.id)) }));
}

/**
 * OPEN EVERY SPIN WHOSE MOMENT HAS COME.
 *
 * The Early Bird "should automatically launch 10:30 AM" — so nobody has to be
 * standing at a keyboard at 10:30. Called by the minute sweep. Never throws.
 */
async function launchDue(now = new Date()) {
  const out = [];
  try {
    const r = await db.query(
      `SELECT p.id FROM arena_spins p JOIN arena_sessions s ON s.id = p.session_id
        WHERE p.state = 'draft' AND p.launch_at IS NOT NULL AND p.launch_at <= $1
          AND s.state = 'live'`, [now]);
    for (const row of r.rows) {
      try { out.push(await openSpin(row.id)); }
      catch (e) { console.warn(`[arena] spin ${row.id} could not launch itself: ${e.message}`); }
    }
  } catch (e) {
    console.warn(`[arena] could not look for spins due to launch: ${(e && e.message) || e}`);
  }
  return out;
}

/** Abandon a spin. The draws stay exactly as they are -- a cancelled spin is
 *  part of the record, not something to erase. */
async function cancelSpin(spinId, reason) {
  const r = await db.query(
    `UPDATE arena_spins SET state = 'cancelled', outcome_note = COALESCE(outcome_note, $2), updated_at = now()
      WHERE id = $1 AND state <> 'decided' RETURNING *`, [spinId, reason || 'Cancelled']);
  if (!r.rows[0]) throw new Error('That spin has already been decided.');
  broadcast('arena:spin', { spinId, state: 'cancelled' });
  return r.rows[0];
}

module.exports = {
  setBroadcaster,
  createSpin, openSpin, lockSpin, freezeRoster,
  startSpin, revealDraw, settleSpin, settleDue,
  pressStop, pressStopInternal, rosterFor, launchDue,
  verify, cancelSpin,
  getSpin, getSession, getDraws,
};
