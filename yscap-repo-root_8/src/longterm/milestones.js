'use strict';
/**
 * LONG-TERM — the milestone clock: when a loan reached where it is, and how long
 * it has been there.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WE REPORT WHAT WE WATCHED, AND NOTHING ELSE.
 *
 * Encompass keeps its own milestone log and we cannot read it — the client
 * registration lacks the `encompass_admin` scope, so those endpoints answer 403
 * (LOS-MASTER-PLAN §11 item 6). What PILOT can do is notice that a loan's milestone
 * is not what it was the last time it looked. Every event this module writes is
 * therefore named `observed_*`, so nothing downstream can mistake our sighting for
 * Encompass's record of who moved the file.
 *
 * AND THE FIRST SIGHTING IS NOT A DATE. The first time we read a loan we have no
 * idea how long it has been sitting where it is. Stamping "reached today" would make
 * the entire back book look freshly moved on the day the sync first ran, and would
 * make the stalled-file signal confidently wrong on exactly the files it exists to
 * surface. So a first sighting is a BASELINE — a distinct event type, and a flag on
 * the loan — and `describeClock` refuses to compute an age from one.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * SEPARATION: reads and writes only `lt_*`.
 */

const lazy = {
  get db() { return require('./db'); },
};

const EVENT_ENTERED = 'observed_entered';
const EVENT_BASELINE = 'observed_baseline';

/** Two milestone names mean the same milestone. Blank never equals blank-with-a-name. */
const sameMilestone = (a, b) => {
  const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
  return norm(a) === norm(b);
};

/**
 * What to record, given what we stored last time and what Encompass says now.
 *
 * PURE — no database, no clock of its own (the caller passes `now`), so every branch
 * is testable and the decision can never depend on when the test happens to run.
 *
 * Returns `{ action, event }`:
 *   · `none`     — nothing changed, or there is nothing to say. Writes nothing; a
 *                  re-read that changed nothing must never append an event, exactly
 *                  as `locks.writeLock` refuses to.
 *   · `baseline` — first sighting. Records WHERE it already was, not when it got there.
 *   · `entered`  — we watched it move. This is the only case that produces a real date.
 */
function decideMilestoneEvent(prev, next, opts = {}) {
  const now = opts.now || new Date();
  const prevName = (prev && prev.milestoneName) || null;
  const nextName = (next && next.milestoneName) || null;

  // Encompass told us nothing about the milestone this time. That is not a move to
  // "no milestone" — it is an absent reading, and overwriting a known milestone with
  // it would erase real history. Locks take the same position on an absent posture.
  if (!nextName) return { action: 'none', reason: 'no_milestone_read' };

  const hasPrior = !!(prev && prev.hasRecord);

  if (!hasPrior) {
    return {
      action: 'baseline',
      event: {
        eventType: EVENT_BASELINE,
        fromMilestone: null,
        toMilestone: nextName,
        fromStage: null,
        toStage: (next && next.stageKey) || null,
        observedAt: now,
      },
    };
  }

  if (sameMilestone(prevName, nextName)) return { action: 'none', reason: 'unchanged' };

  return {
    action: 'entered',
    event: {
      eventType: EVENT_ENTERED,
      fromMilestone: prevName,
      toMilestone: nextName,
      fromStage: (prev && prev.stageKey) || null,
      toStage: (next && next.stageKey) || null,
      observedAt: now,
    },
  };
}

/**
 * How long this loan has been where it is, and whether that is worth acting on.
 *
 * PURE. `expectedDays` is the tenant's own figure from the milestone catalog
 * (`lt_encompass_milestones.expected_days`); when there is none, there is no bar to
 * be over and `stalled` is null rather than false — "nobody set an expectation" and
 * "it is within expectation" are different answers.
 *
 * A BASELINE YIELDS NO AGE. We know when we started watching, not when the loan
 * arrived, so `days` is null and `sinceIsBaseline` says why. Reporting the age of our
 * own observation as the age of the loan's position is the confident wrong answer
 * this whole module is arranged to avoid.
 */
function describeClock(loan, opts = {}) {
  const l = loan || {};
  const since = l.milestone_since || null;
  const isBaseline = l.milestone_since_is_baseline !== false;
  const expectedDays = opts.expectedDays == null || opts.expectedDays === ''
    ? null : Number(opts.expectedDays);
  const expected = Number.isFinite(expectedDays) && expectedDays > 0 ? expectedDays : null;

  const out = {
    since: since || null,
    sinceIsBaseline: since ? isBaseline : null,
    days: null,
    expectedDays: expected,
    stalled: null,
    // Plain words for the screen, so the distinction survives into what a person reads.
    note: null,
  };

  if (!since) {
    out.note = 'PILOT has not read this loan yet, so there is no record of when it reached this milestone.';
    return out;
  }
  if (isBaseline) {
    out.note = 'This is where the loan already was when PILOT started watching it — how long it has been here is not known.';
    return out;
  }

  const t = new Date(since).getTime();
  if (!Number.isFinite(t)) return out;
  const now = (opts.now || new Date()).getTime();
  // Floor, and never negative: a clock skew that puts the observation slightly in the
  // future must read as "today", never as a negative age.
  out.days = Math.max(0, Math.floor((now - t) / 86400000));
  if (expected !== null) out.stalled = out.days > expected;
  out.note = expected === null
    ? `At this milestone for ${out.days} day${out.days === 1 ? '' : 's'}. The milestone catalog sets no expected duration for it.`
    : out.stalled
      ? `At this milestone for ${out.days} days — longer than the ${expected} expected.`
      : `At this milestone for ${out.days} day${out.days === 1 ? '' : 's'}, within the ${expected} expected.`;
  return out;
}

/**
 * Record what this read observed. Returns a shaped result, never throws — one
 * unrecordable milestone must not undo a loan we just mirrored.
 */
async function writeMilestone(loanId, prev, next, opts = {}) {
  const db = lazy.db;
  const decision = decideMilestoneEvent(prev, next, opts);
  if (decision.action === 'none') return { ok: true, action: 'none', reason: decision.reason };

  const e = decision.event;
  try {
    await db.query(
      `INSERT INTO lt_milestone_events
         (id, loan_id, event_type, from_milestone, to_milestone, from_stage, to_stage,
          observed_at, encompass_synced_at)
       VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6, $7, $8)`,
      [String(loanId), e.eventType, e.fromMilestone, e.toMilestone, e.fromStage, e.toStage,
        e.observedAt, opts.encompassSyncedAt || null],
    );
    // The clock on the loan. A witnessed move clears the baseline flag — from here on
    // the timestamp means what it says.
    await db.query(
      `UPDATE lt_loans
          SET milestone_since = $2,
              milestone_since_is_baseline = $3
        WHERE id = $1::uuid`,
      [String(loanId), e.observedAt, decision.action === 'baseline'],
    );
    return { ok: true, action: decision.action, event: e };
  } catch (err) {
    return { ok: false, action: decision.action, reason: String((err && err.message) || err).slice(0, 300) };
  }
}

/** What we already hold for this loan, in the shape `decideMilestoneEvent` expects. */
async function loadPrior(loanId) {
  try {
    const { rows } = await lazy.db.query(
      `SELECT milestone_name, stage_key, milestone_since
         FROM lt_loans WHERE id = $1::uuid`, [String(loanId)],
    );
    if (!rows.length) return { hasRecord: false, milestoneName: null, stageKey: null };
    const r = rows[0];
    return {
      // A loan row with a milestone but no `milestone_since` predates this table, so
      // it has no history and its next read is a BASELINE — which is right: we never
      // watched it arrive, and pretending otherwise would date it from a row we did
      // not write.
      hasRecord: !!r.milestone_since,
      milestoneName: r.milestone_name || null,
      stageKey: r.stage_key || null,
    };
  } catch (_) {
    return { hasRecord: false, milestoneName: null, stageKey: null };
  }
}

/** The observed history, newest first. Best-effort — a loan opens without it. */
async function loadHistory(loanId, limit = 50) {
  try {
    const { rows } = await lazy.db.query(
      `SELECT event_type, from_milestone, to_milestone, from_stage, to_stage, observed_at
         FROM lt_milestone_events
        WHERE loan_id = $1::uuid
        ORDER BY observed_at DESC
        LIMIT $2`,
      [String(loanId), Math.min(200, Math.max(1, Number(limit) || 50))],
    );
    return rows.map((r) => ({
      eventType: r.event_type,
      // A baseline is NOT a date the loan reached anything. The flag rides with every
      // row so a screen cannot render one as an arrival by accident.
      isBaseline: r.event_type === EVENT_BASELINE,
      fromMilestone: r.from_milestone,
      toMilestone: r.to_milestone,
      fromStage: r.from_stage,
      toStage: r.to_stage,
      observedAt: r.observed_at,
    }));
  } catch (_) {
    return [];
  }
}

/**
 * When each milestone NAME was observed to be reached — the map the stepper needs.
 *
 * Baselines are deliberately EXCLUDED: the stepper draws a date beside a step, and a
 * baseline is not one. The LATEST observation of a given milestone wins, because a
 * file that rolled back and returned reached it again.
 */
async function reachedAtByMilestone(loanId) {
  const out = {};
  for (const e of await loadHistory(loanId, 200)) {
    if (e.isBaseline || !e.toMilestone) continue;
    const key = String(e.toMilestone).trim().toLowerCase();
    if (!out[key]) out[key] = e.observedAt;   // history is newest-first, so the first is the latest
  }
  return out;
}

module.exports = {
  EVENT_ENTERED,
  EVENT_BASELINE,
  decideMilestoneEvent,
  describeClock,
  writeMilestone,
  loadPrior,
  loadHistory,
  reachedAtByMilestone,
  _internals: { sameMilestone },
};
