'use strict';
/**
 * LONG-TERM — the loan's own milestone LADDER, and the milestone it is SITTING in.
 *
 * Owner-reported 2026-08-23 (363 Birch Dr / YSCAP258134741): the file showed
 * "Funding" although the Funding milestone had COMPLETED. *"The wording is
 * changing from funding to funded … it's sitting in the NEXT status, waiting for
 * that status to be completed."* Proven live against the tenant:
 *
 *   · `GET /loans/{id}/milestones` returns the loan's OWN ladder — every step
 *     with `doneIndicator`, its date, and the associate assigned to that step.
 *     The file SITS in the FIRST step whose doneIndicator is false. On Birch:
 *     Funding done=true → sitting = "Investor Delivery".
 *   · `Log.MS.CurrentMilestone` — what the mirror displayed until db/623 — LAGS:
 *     it stays on the last WORKED milestone until somebody starts the next one.
 *     On Birch it still read "Funding". That is the wrong answer this module
 *     replaces.
 *   · Virtual field `MS.STATUS` is the tenant's own status WORDING, stamped at
 *     each milestone transition ("Funded" on Birch — the field their existing
 *     Encompass automation fires webhooks on), and `MS.STATUSDATE` is its stamp.
 *     Both were verified live on 486 loans (the 2026-08-24 field sweep) before
 *     joining any fieldReader batch — the FR0117 lesson: the LT client does NOT
 *     split a failed batch, so one bad id blanks every other read on the loan.
 *
 * THE DATES ON THE LADDER MEAN TWO THINGS, AND `done` SAYS WHICH. Encompass keeps
 * ONE date per step: the actual start for a step that has been worked, the
 * PLANNED/expected date for one that has not (Birch's future steps carry
 * 2026-08-25 / 08-30 / 09-29 — its expected closing plan). The mirror stores the
 * date verbatim and every screen reads `done` before calling it either.
 *
 * A FAILED OR EMPTY READ CHANGES NOTHING. An empty ladder is an outage, not a
 * loan that lost its workflow — nothing is deleted, nothing is stamped, and the
 * backfill simply tries again later. Same doctrine as every mirror here.
 *
 * ENCOMPASS STAYS ONE-WAY. Every call is a GET.
 * SEPARATION: reads and writes only `lt_*`.
 */

const stagesMod = require('../stages');
const milestones = require('../milestones');
// The master on/off switch — asked directly, never through the client, because the
// tests replace the client wholesale in require.cache (the repo-wide pattern).
const killSwitch = require('../encompass/enabled');

const lazy = {
  get db() { return require('../db'); },
  get client() { return require('../encompass/client'); },
  get settings() { return require('../settings/store'); },
};

/**
 * The two virtual status fields, VERIFIED LIVE (Birch, 2026-08-24:
 * `{"MS.STATUS":"Funded","MS.STATUSDATE":"08/23/2026 04:07:53 PM"}`) before being
 * offered to any shared batch. Do not add an id here without a live probe first.
 */
const MS_FIELD_IDS = ['MS.STATUS', 'MS.STATUSDATE'];

/** How many loans one backfill pass will ladder. Each costs one milestones GET
 *  plus one two-id fieldReader, on a tenant whose pacing is a shared budget. */
const DEFAULT_BACKFILL_BUDGET = 40;

const text = (v) => {
  const s = String(v == null ? '' : v).trim();
  return s === '' ? null : s;
};

/** The list Encompass answered with, whatever envelope it arrived in. */
function itemsOf(answer) {
  if (Array.isArray(answer)) return answer;
  if (answer && Array.isArray(answer.items)) return answer.items;
  if (answer && Array.isArray(answer.value)) return answer.value;
  return [];
}

/**
 * One ladder step as our table holds it. PURE.
 *
 * The associate's LOGIN (`user.entityId`) is the join key the people map is built
 * on; the name/email/phone are display copies, never identity — the same rule
 * `people/contacts.js` records (one live row read `{"id":"mschwimmer","name":
 * "Malky Katz"}`, two different people).
 */
function rowFrom(item, index) {
  const it = item || {};
  const a = it.loanAssociate && typeof it.loanAssociate === 'object' ? it.loanAssociate : {};
  const user = a.user && typeof a.user === 'object' ? a.user : {};
  const role = a.role && typeof a.role === 'object' ? a.role : {};
  return {
    milestoneName: text(it.name),
    position: index,
    done: it.doneIndicator === true,
    startDate: text(it.startDate),
    associateId: text(user.entityId),
    associateName: text(user.entityName),
    associateRole: text(role.entityName),
    associateEmail: text(a.email),
    associatePhone: text(a.phone),
    roleRequired: text(it.roleRequired),
  };
}

/**
 * WHERE THE FILE SITS. The first not-done step; a loan whose every step is done
 * sits at its LAST step (the file is finished — "Completion" on this tenant);
 * an empty ladder answers null and the caller keeps whatever it had.
 *
 * PURE — this is the one sentence the whole rebuild exists for, so it is a
 * function a test can hold still.
 */
function sittingOf(rows) {
  const list = (rows || []).filter((r) => r && r.milestoneName);
  if (!list.length) return null;
  const open = list.find((r) => !r.done);
  return (open || list[list.length - 1]).milestoneName;
}

/**
 * The tenant's own wording + stamp out of a fieldReader answer. PURE. A null
 * `values` (the batch failed) answers nulls, and the writer's COALESCE keeps
 * what we already hold — a failed read is not evidence of anything.
 */
function msStatusOf(values) {
  if (!values || typeof values !== 'object') return { status: null, date: null };
  return {
    status: text(values['MS.STATUS']),
    date: text(values['MS.STATUSDATE']),
  };
}

/**
 * Read one loan's ladder from Encompass. READ-ONLY; never throws — an
 * unreadable ladder answers `{ok:false, reason}` and the caller falls back to
 * the lagging milestone read rather than losing the loan.
 */
async function readLadder(guid, opts = {}) {
  const client = opts.client || lazy.client;
  let answer;
  try {
    answer = await client.getLoanMilestones(guid);
  } catch (e) {
    return { ok: false, reason: `Could not read the milestone ladder: ${(e && e.message) || e}` };
  }
  const rows = itemsOf(answer).map(rowFrom).filter((r) => r.milestoneName);
  if (!rows.length) {
    // An empty answer is an outage (or a loan with no workflow at all), never a
    // reason to delete a ladder we hold or to stamp the loan as laddered.
    return { ok: false, reason: 'Encompass returned no milestones for this loan — nothing was changed.' };
  }
  return { ok: true, rows, sitting: sittingOf(rows) };
}

/**
 * Mirror one loan's ladder rows and stamp `ladder_synced_at`.
 *
 * The upsert replaces every mirrored column; rows for steps the ladder no longer
 * carries are DELETED — this table is a mirror of the loan's CURRENT workflow
 * (a tenant rename must not leave a ghost step), and the loan's history lives in
 * `lt_milestone_events`, not here. The delete only ever runs under a non-empty
 * read, which `readLadder` already guarantees.
 *
 * Never throws — one unrecordable ladder must not undo a loan we just mirrored.
 */
async function writeLadder(loanId, rows, opts = {}) {
  const db = opts.db || lazy.db;
  try {
    for (const r of rows) {
      await db.query(
        `INSERT INTO lt_loan_milestones
           (loan_id, milestone_name, position, done, start_date,
            associate_id, associate_name, associate_role, associate_email, associate_phone,
            role_required, encompass_synced_at, updated_at)
         VALUES ($1::uuid, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11, now(), now())
         ON CONFLICT (loan_id, milestone_name) DO UPDATE SET
           position = EXCLUDED.position,
           done = EXCLUDED.done,
           start_date = EXCLUDED.start_date,
           associate_id = EXCLUDED.associate_id,
           associate_name = EXCLUDED.associate_name,
           associate_role = EXCLUDED.associate_role,
           associate_email = EXCLUDED.associate_email,
           associate_phone = EXCLUDED.associate_phone,
           role_required = EXCLUDED.role_required,
           encompass_synced_at = now(),
           updated_at = now()`,
        [String(loanId), r.milestoneName, r.position, r.done, r.startDate,
          r.associateId, r.associateName, r.associateRole, r.associateEmail, r.associatePhone,
          r.roleRequired],
      );
    }
        await db.query(
      `DELETE FROM lt_loan_milestones
        WHERE loan_id = $1::uuid AND NOT (milestone_name = ANY($2::text[]))`,
      [String(loanId), rows.map((r) => r.milestoneName)],
    );
    await db.query(
      'UPDATE lt_loans SET ladder_synced_at = now(), updated_at = now() WHERE id = $1::uuid',
      [String(loanId)],
    );
    return { ok: true, written: rows.length };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e).slice(0, 300) };
  }
}

/**
 * The tenant's wording + stamp onto the loan row. COALESCE(new, old) — the
 * mirror's never-blank rule: a read that could not see the field (or a step
 * genuinely stamped nothing yet) must never blank a wording we already hold.
 * Never throws.
 */
async function writeMsStatus(loanId, ms, opts = {}) {
  const db = opts.db || lazy.db;
  if (!ms || (!ms.status && !ms.date)) return { ok: true, skipped: true };
  try {
    await db.query(
      `UPDATE lt_loans
          SET ms_status = COALESCE($2, ms_status),
              ms_status_date = COALESCE($3, ms_status_date),
              updated_at = now()
        WHERE id = $1::uuid`,
      [String(loanId), ms.status, ms.date],
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e).slice(0, 300) };
  }
}

/** The loans whose ladder has never been read, freshest activity first — the
 *  files most likely to be on somebody's screen heal soonest. The trash and the
 *  archive are skipped through the ONE definition (trash.notTrashSql). */
async function ladderDue(db, limit) {
  const trash = require('../trash');
  const { rows } = await db.query(
    `SELECT l.id, l.encompass_loan_guid AS guid
       FROM lt_loans l
      WHERE l.ladder_synced_at IS NULL
        AND l.encompass_loan_guid IS NOT NULL
        AND ${trash.notTrashSql('l')}
      ORDER BY l.encompass_last_modified DESC NULLS LAST
      LIMIT $1`,
    [limit],
  );
  return rows;
}

/**
 * Ladder one loan end to end: read the ladder, mirror it, move the loan to its
 * SITTING milestone (stage and observed-clock event included), and record the
 * tenant's own wording. Used by the backfill; the ordinary loan read composes
 * the same pieces inline so the ladder rides its existing calls.
 */
async function ladderOne(loanId, guid, settings, opts = {}) {
  const client = opts.client || lazy.client;
  const db = opts.db || lazy.db;

  const ladder = await readLadder(guid, { client });
  if (!ladder.ok) return ladder;

  // The sitting milestone through the SAME stage map every screen groups by.
  const cfg = stagesMod.configFrom(settings || {});
  const stage = stagesMod.stageForMilestone(ladder.sitting, cfg);

  // Notice the move BEFORE the write destroys the evidence — the observed-clock
  // rule (milestones.js): a first sighting is a baseline, a change is an event.
  const prior = await milestones.loadPrior(loanId);
  try {
    await db.query(
      `UPDATE lt_loans
          SET milestone_name = COALESCE($2, milestone_name),
              stage_key = COALESCE($3, stage_key),
              updated_at = now()
        WHERE id = $1::uuid`,
      [String(loanId), ladder.sitting, ladder.sitting ? stage.key : null],
    );
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e).slice(0, 300) };
  }
  await milestones.writeMilestone(loanId, prior, {
    milestoneName: ladder.sitting, stageKey: stage.key,
  });

  const wrote = await writeLadder(loanId, ladder.rows, { db });
  if (!wrote.ok) return wrote;

  // The tenant's own wording — its OWN two-id read here, because the backfill
  // has no shared batch to ride. Verified ids only (see MS_FIELD_IDS).
  let ms = { status: null, date: null };
  try {
    ms = msStatusOf(await client.fieldReader(guid, MS_FIELD_IDS));
  } catch (_) { /* the wording is best-effort; the ladder is the ground truth */ }
  await writeMsStatus(loanId, ms, { db });

  return { ok: true, sitting: ladder.sitting, stageKey: stage.key, steps: ladder.rows.length };
}

/**
 * THE BACKFILL — walk the already-mirrored book once, a few loans per pass.
 *
 * WHY IT EXISTS. The ordinary sync re-reads a loan only when Encompass's own
 * stamp moves (`loans.needsRead`), so a finished file — precisely the ones whose
 * milestone reads wrong, like Birch — would keep its lagging milestone forever.
 * This drains on `ladder_synced_at IS NULL`, so it self-terminates: a laddered
 * book costs one SELECT that finds nothing.
 *
 * Bounded, paced by the client's own discipline, never throws.
 */
async function backfillLadders(opts = {}) {
  if (!killSwitch.encompassEnabled()) return { ok: false, reason: killSwitch.OFF_REASON };
  const client = opts.client || lazy.client;
  if (!client.configured()) return { ok: false, reason: 'Encompass is not connected yet.' };

  const db = opts.db || lazy.db;
  const limit = Math.min(200, Math.max(1, Number(opts.limit) || DEFAULT_BACKFILL_BUDGET));

  let settings = opts.settings;
  if (!settings) {
    try { ({ settings } = await lazy.settings.load()); } catch (_) { settings = {}; }
  }

  let due;
  try {
    due = await ladderDue(db, limit);
  } catch (e) {
    return { ok: false, reason: `Could not list the loans still to ladder: ${(e && e.message) || e}` };
  }
  if (!due.length) return { ok: true, laddered: 0, failed: 0, more: false };

  let laddered = 0;
  let failed = 0;
  let reason = null;
  for (const row of due) {
    /* eslint-disable no-await-in-loop */ // deliberately serial — the tenant's pacing
    const out = await ladderOne(row.id, row.guid, settings, { client, db });
    if (out.ok) laddered += 1;
    else { failed += 1; if (!reason) reason = out.reason; }
  }
  // `more` is what makes a bounded pass honest: a full batch means another is
  // waiting. A pass that failed EVERYTHING reports ok:false so the run log says
  // so, rather than a green line over a book that did not move.
  if (laddered === 0 && failed > 0) return { ok: false, reason, failed };
  return { ok: true, laddered, failed, reason, more: due.length >= limit };
}

module.exports = {
  MS_FIELD_IDS,
  DEFAULT_BACKFILL_BUDGET,
  itemsOf,
  rowFrom,
  sittingOf,
  msStatusOf,
  readLadder,
  writeLadder,
  writeMsStatus,
  ladderOne,
  backfillLadders,
  _internals: { text, ladderDue },
};
