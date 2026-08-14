'use strict';
/**
 * LONG-TERM — the human half of the people map.
 *
 * roster.js proposes; this decides. Owner-directed 2026-08-14: **auto-match by
 * email, admin confirms** — so a link only ever becomes real here, and only ever
 * because a person pressed a button.
 *
 * WHY A CONFIRMED LINK IS THE MOST CONSEQUENTIAL ROW IN THE LONG-TERM BUILD, and
 * therefore why every refusal below is worth its lines:
 *
 *   A confirmed link says "this Encompass login IS this PILOT person". From that
 *   moment every long-term loan naming that login is attributed to them, and — for
 *   an officer or a processor, whose scope is `own` — it decides which files they
 *   can open. Link the wrong two people and somebody quietly gets another officer's
 *   book, with nothing on any screen to say so. That is why the machine only ever
 *   suggests, and why a wrong confirm must be undoable (`unlink`).
 *
 * THE STATES, and what each one means to the next sync:
 *
 *   none        no row. The sync may propose.
 *   suggested   the machine's proposal, awaiting a human. The sync may refresh it.
 *   confirmed   a person said yes. The sync never touches it.
 *   rejected    a person said "this is not them". The sync never re-proposes it —
 *               a suggestion that comes back every sync is how a review screen
 *               becomes noise people click past.
 *
 * `unlink` deletes the row, which returns the login to `none` — the deliberate way
 * to reopen a decision, distinct from `reject`, which IS a decision.
 *
 * ONE PERSON, ONE LOGIN. The partial unique index on `staff_id WHERE confirmed`
 * enforces it in the database rather than here, because two admins confirming at
 * the same instant would each read "free" and both write. We catch its 23505 and
 * answer in plain words instead of a stack trace.
 *
 * SEPARATION: writes only `lt_staff_links`; READS `staff_users` (authorized in
 * writing 2026-08-03) to check the person is real, internal and active.
 */

const db = require('../db');
// Required lazily — contacts.js requires this module back for the confirmed-link
// map, and a plain top-level pair would leave one of the two holding a half-built
// module depending on which is loaded first.
const lazyContacts = () => require('./contacts');

/**
 * A decision about WHO somebody is has to reach the files they are already on.
 *
 * Confirming a link is retroactive by design: the moment an admin says "this login
 * is that person", every long-term file that login appears on becomes theirs — with
 * no Encompass call and no loan re-sync — and unlinking takes them back off. Without
 * this, an admin would confirm a link, see nothing change, and re-confirm it.
 *
 * Best-effort on purpose: the decision itself is already committed and is the thing
 * that matters. A failure here is corrected by the next sync or the next decision,
 * so it may never turn a successful confirm into an error.
 */
async function reattribute(where) {
  try {
    return await lazyContacts().reattributeAll();
  } catch (e) {
    console.error(`[lt] re-attributing loan contacts after ${where} failed:`, (e && e.message) || e);
    return null;
  }
}

/** A refusal a screen can show verbatim. `status` is the HTTP code to answer with. */
function refuse(status, message) {
  const e = new Error(message);
  e.status = status;
  e.plain = message;
  return e;
}

async function encompassUserExists(dbc, loginId) {
  const { rows } = await dbc.query('SELECT login_id FROM lt_encompass_users WHERE login_id = $1', [loginId]);
  return rows.length > 0;
}

/**
 * Confirm that an Encompass login belongs to a PILOT person.
 *
 * Every check here answers a question a wrong link would leave unanswered:
 * does the login exist (or the link points at nobody), is the person real and
 * INTERNAL (a TPO broker is an external `staff_users` row and must never be handed
 * a long-term pipeline), are they active, and is either side already spoken for.
 */
async function confirmLink(loginId, staffId, actorId) {
  const login = String(loginId || '').trim();
  const staff = String(staffId || '').trim();
  if (!login) throw refuse(400, 'Which Encompass user? None was named.');
  if (!staff) throw refuse(400, 'Which PILOT person? None was named.');

  const dbc = await db.getClient();
  try {
    await dbc.query('BEGIN');

    if (!(await encompassUserExists(dbc, login))) {
      throw refuse(404, 'That Encompass user is not in the roster. Sync the roster and try again.');
    }

    const { rows: people } = await dbc.query(
      `SELECT id, is_active, COALESCE(is_external, false) AS is_external
         FROM staff_users WHERE id = $1::uuid`,
      [staff],
    );
    if (!people.length) throw refuse(404, 'That PILOT person does not exist.');
    if (people[0].is_external) {
      throw refuse(400, 'That account is an outside broker, not a member of staff, so it cannot be linked to an Encompass user.');
    }
    if (people[0].is_active === false) {
      throw refuse(400, 'That PILOT person is deactivated. Reactivate them first, or link a different person.');
    }

    // Named separately from the unique index so the common case gets a sentence
    // instead of a database error. The index is still what makes it true.
    const { rows: taken } = await dbc.query(
      `SELECT encompass_login_id FROM lt_staff_links
        WHERE staff_id = $1::uuid AND status = 'confirmed' AND encompass_login_id <> $2`,
      [staff, login],
    );
    if (taken.length) {
      throw refuse(409, `That PILOT person is already linked to the Encompass user "${taken[0].encompass_login_id}". Unlink that one first.`);
    }

    const { rows } = await dbc.query(
      `INSERT INTO lt_staff_links
         (encompass_login_id, staff_id, status, match_method, confirmed_by, confirmed_at, updated_at)
       VALUES ($1, $2::uuid, 'confirmed', 'manual', $3::uuid, now(), now())
       ON CONFLICT (encompass_login_id) DO UPDATE SET
         staff_id = EXCLUDED.staff_id,
         status = 'confirmed',
         match_method = COALESCE(lt_staff_links.match_method, 'manual'),
         confirmed_by = EXCLUDED.confirmed_by,
         confirmed_at = now(),
         updated_at = now()
       RETURNING *`,
      [login, staff, actorId || null],
    );

    await dbc.query('COMMIT');
    // The link is decided; now make it true of the files that login is already on.
    await reattribute('a confirm');
    return rows[0];
  } catch (e) {
    try { await dbc.query('ROLLBACK'); } catch (_) { /* the original error is the one that matters */ }
    if (e && e.code === '23505') {
      throw refuse(409, 'That PILOT person was linked to another Encompass user a moment ago. Reload the screen.');
    }
    throw e;
  } finally {
    dbc.release();
  }
}

/**
 * Record that a proposal is wrong. The login stays in the roster and stays
 * unlinked, and the sync will not propose it again — which is the whole point.
 */
async function rejectLink(loginId, actorId) {
  const login = String(loginId || '').trim();
  if (!login) throw refuse(400, 'Which Encompass user? None was named.');
  if (!(await encompassUserExists(db, login))) {
    throw refuse(404, 'That Encompass user is not in the roster.');
  }
  const { rows } = await db.query(
    `INSERT INTO lt_staff_links
       (encompass_login_id, staff_id, status, match_method, confirmed_by, confirmed_at, updated_at)
     VALUES ($1, NULL, 'rejected', 'manual', $2::uuid, now(), now())
     ON CONFLICT (encompass_login_id) DO UPDATE SET
       staff_id = NULL,
       status = 'rejected',
       confirmed_by = EXCLUDED.confirmed_by,
       confirmed_at = now(),
       updated_at = now()
     RETURNING *`,
    [login, actorId || null],
  );
  // A rejection can undo an earlier confirm, so the files must stop being theirs.
  await reattribute('a reject');
  return rows[0];
}

/**
 * Undo a decision entirely — the row goes, and the login is back to unlinked and
 * proposable. This is the way out of a wrong confirm, which is why it exists as
 * something distinct from `reject`.
 */
async function unlink(loginId) {
  const login = String(loginId || '').trim();
  if (!login) throw refuse(400, 'Which Encompass user? None was named.');
  const { rowCount } = await db.query('DELETE FROM lt_staff_links WHERE encompass_login_id = $1', [login]);
  await reattribute('an unlink');
  return { removed: rowCount || 0 };
}

/**
 * The PILOT person behind an Encompass login — CONFIRMED links only.
 *
 * This is the function the loan sync will attribute files through, so a mere
 * suggestion must never satisfy it: attributing a book on a proposal nobody read
 * would be the auto-match deciding after all.
 */
async function staffIdForLogin(loginId, dbc = db) {
  const { rows } = await dbc.query(
    `SELECT staff_id FROM lt_staff_links
      WHERE encompass_login_id = $1 AND status = 'confirmed' AND staff_id IS NOT NULL`,
    [String(loginId || '').trim()],
  );
  return rows.length ? String(rows[0].staff_id) : null;
}

/** Does this PILOT person have a confirmed Encompass identity? Drives the empty-pipeline copy. */
async function hasConfirmedLink(staffId, dbc = db) {
  const { rows } = await dbc.query(
    `SELECT 1 FROM lt_staff_links WHERE staff_id = $1::uuid AND status = 'confirmed' LIMIT 1`,
    [String(staffId || '')],
  );
  return rows.length > 0;
}

module.exports = {
  confirmLink,
  rejectLink,
  unlink,
  staffIdForLogin,
  hasConfirmedLink,
  _internals: { refuse },
};
