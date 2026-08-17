'use strict';
/**
 * LONG-TERM — recording who a long-term loan's borrower actually is.
 *
 * `borrower-match.js` proposes; this decides and applies. It is the borrower twin
 * of `people/links.js`, and it obeys the same owner-directed rule (2026-08-14 for
 * the staff roster, restated for borrowers 2026-08-16): **auto-match by email, a
 * human confirms.** Nothing here ever adopts a profile on its own.
 *
 * WHAT A CONFIRMATION DOES, EXACTLY
 * ------------------------------------------------------------------------
 * It records the decision against the ADDRESS (`lt_borrower_links`, db/573) and
 * then stamps `lt_loans.borrower_id` on every long-term loan carrying that
 * address. That second half is the whole point: `borrower_id` is what a borrower's
 * own login reads, so until it is filled the loan exists and the client cannot see
 * it. One statement, inside the same transaction as the decision — a decision that
 * recorded but did not apply would look done and change nothing.
 *
 * READ-ONLY ON THE SHARED IDENTITY ZONE. Long-Term may READ the `borrowers` person
 * record and never rewrite it (charter §2, ledger 2026-08-03 — *"same login same
 * borrower record, keep it separate everything else"*). There is no UPDATE of
 * `borrowers` anywhere in this file, and there must never be one: the person record
 * has a single writer on the RTL side and a dozen modules that heal, enrich and
 * de-duplicate it. We point AT a profile; we do not touch it.
 *
 * A DECISION IS REVERSIBLE, AND SAYS SO. `unlink` exists because the expensive
 * failure here is a borrower seeing a loan that is not theirs, and the person who
 * notices needs to be able to undo it in one press rather than file a ticket. It
 * un-stamps every loan the link stamped, so undoing is as complete as doing.
 */

const db = require('./db');
const borrowerMatch = require('./borrower-match');
const { nameLooksLike } = require('./people/match');

/** A refusal a screen can show verbatim. `status` is the HTTP code to answer with. */
function refuse(status, message) {
  const e = new Error(message);
  e.status = status;
  e.plain = message;
  return e;
}

/**
 * Stamp (or clear) `borrower_id` on every long-term loan carrying an address.
 *
 * `borrower_email` is stored already normalised by the sync, so this is a plain
 * equality against the index. It is deliberately NOT a COALESCE: a confirmation is
 * a human saying "these loans are this person's", and it must be able to CORRECT a
 * loan that a previous decision attached to somebody else. That is precisely what
 * the undo path needs too.
 */
async function applyToLoans(dbc, email, borrowerId) {
  const { rowCount } = await dbc.query(
    `UPDATE lt_loans
        SET borrower_id = $2::uuid, updated_at = now()
      WHERE borrower_email = $1
        AND borrower_id IS DISTINCT FROM $2::uuid`,
    [email, borrowerId],
  );
  return rowCount;
}

/**
 * Confirm that an Encompass borrower email belongs to a PILOT borrower profile.
 *
 * Every check answers a question a wrong link would leave open: is the address one
 * that identifies anybody at all, does the profile exist, and — the one that
 * matters most — does Encompass agree that this address belongs to ONE person.
 */
async function confirmLink(email, borrowerId, actorId, opts = {}) {
  const addr = borrowerMatch.normalizeEmail(email);
  const bid = String(borrowerId || '').trim();
  if (!addr) throw refuse(400, 'Which borrower email? None was named.');
  if (!bid) throw refuse(400, 'Which borrower profile? None was named.');

  const settings = opts.settings || {};
  if (borrowerMatch.isUnusableEmail(addr, settings)) {
    throw refuse(400, 'That email address identifies nobody — it is a placeholder or a stand-in — so it cannot be linked to a person.');
  }

  const dbc = await db.getClient();
  try {
    await dbc.query('BEGIN');

    const { rows: people } = await dbc.query(
      'SELECT id FROM borrowers WHERE id = $1::uuid', [bid],
    );
    if (!people.length) throw refuse(404, 'That borrower profile does not exist.');

    // THE GUARD THAT MATTERS. If Encompass carries two different borrower names on
    // this one address, the loans belong to two different people and attaching all
    // of them to one profile would show a client somebody else's loan. The matcher
    // refuses to SUGGEST it; this refuses to ACCEPT it, because a screen is not a
    // security boundary and this route can be reached directly.
    const { rows: loans } = await dbc.query(
      `SELECT id, borrower_name FROM lt_loans WHERE borrower_email = $1`, [addr],
    );
    if (!loans.length) {
      throw refuse(404, 'No long-term loan carries that email address, so there is nothing to link.');
    }
    // Distinct by MEANING, not by string: the same human is spelled "Malky  Katz"
    // and "Katz Malky" across this tenant's loans, and refusing on that would make
    // an honest address unlinkable. `nameLooksLike` is the same tolerance the
    // matcher groups by, so the two can never disagree about how many people are
    // on an address.
    const names = [];
    for (const l of loans) {
      const nm = String(l.borrower_name || '').trim();
      if (nm && !names.some((n) => nameLooksLike(n, nm))) names.push(nm);
    }
    if (names.length > 1 && opts.force !== true) {
      throw refuse(409, `Encompass has more than one borrower name on that email address (${names.join(', ')}), so these loans are not all the same person. Link them one at a time instead.`);
    }

    await dbc.query(
      `INSERT INTO lt_borrower_links
         (encompass_email, borrower_id, status, match_method, encompass_name, confirmed_by, confirmed_at, updated_at)
       VALUES ($1, $2::uuid, 'confirmed', $3, $4, $5::uuid, now(), now())
       ON CONFLICT (encompass_email) DO UPDATE SET
         borrower_id = EXCLUDED.borrower_id,
         status = 'confirmed',
         match_method = EXCLUDED.match_method,
         encompass_name = COALESCE(EXCLUDED.encompass_name, lt_borrower_links.encompass_name),
         confirmed_by = EXCLUDED.confirmed_by,
         confirmed_at = now(),
         updated_at = now()`,
      [addr, bid, String(opts.method || 'email'), names[0] || null, actorId || null],
    );

    const applied = await applyToLoans(dbc, addr, bid);
    await dbc.query('COMMIT');
    return { ok: true, email: addr, borrowerId: bid, loansLinked: applied, loansOnAddress: loans.length };
  } catch (e) {
    await dbc.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    dbc.release();
  }
}

/**
 * Record that this address is NOT the profile we proposed.
 *
 * A rejection is durable on purpose — the matcher reads it and never proposes that
 * address again — and it carries NO borrower id (the db/573 CHECK enforces that),
 * so a refusal can never be mistaken for a link by anything that reads the table.
 * It does NOT un-stamp loans: rejecting a SUGGESTION is not the same act as undoing
 * a CONFIRMATION, and quietly detaching loans somebody had already linked would be
 * a second, unasked-for decision. `unlink` is how you undo a link.
 */
async function rejectLink(email, actorId) {
  const addr = borrowerMatch.normalizeEmail(email);
  if (!addr) throw refuse(400, 'Which borrower email? None was named.');

  const { rows } = await db.query(
    `INSERT INTO lt_borrower_links
       (encompass_email, borrower_id, status, confirmed_by, confirmed_at, updated_at)
     VALUES ($1, NULL, 'rejected', $2::uuid, now(), now())
     ON CONFLICT (encompass_email) DO UPDATE SET
       borrower_id = NULL,
       status = 'rejected',
       confirmed_by = EXCLUDED.confirmed_by,
       confirmed_at = now(),
       updated_at = now()
     RETURNING encompass_email, status`,
    [addr, actorId || null],
  );
  return { ok: true, email: addr, status: rows[0] && rows[0].status };
}

/**
 * Undo a link entirely — forget the decision AND detach the loans it attached.
 *
 * Both halves, or the undo is a lie: leaving `borrower_id` stamped would keep the
 * loan on the borrower's login while the screen showed nothing linked.
 */
async function unlink(email) {
  const addr = borrowerMatch.normalizeEmail(email);
  if (!addr) throw refuse(400, 'Which borrower email? None was named.');

  const dbc = await db.getClient();
  try {
    await dbc.query('BEGIN');
    const detached = await applyToLoans(dbc, addr, null);
    await dbc.query('DELETE FROM lt_borrower_links WHERE encompass_email = $1', [addr]);
    await dbc.query('COMMIT');
    return { ok: true, email: addr, loansDetached: detached };
  } catch (e) {
    await dbc.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    dbc.release();
  }
}

/** Every decision on file, for the matcher and for the screen. */
async function loadLinks(dbc = db) {
  const { rows } = await dbc.query(
    `SELECT l.encompass_email, l.borrower_id, l.status, l.match_method, l.encompass_name,
            l.confirmed_at,
            NULLIF(b.full_name, '') AS borrower_name
       FROM lt_borrower_links l
       LEFT JOIN borrowers b ON b.id = l.borrower_id
      ORDER BY l.encompass_email`,
  );
  return rows;
}

/**
 * Re-apply every CONFIRMED link to the loans on file.
 *
 * A decision made yesterday must reach a loan that arrived today — the sync mirrors
 * a new loan with its email and no `borrower_id`, and nobody is going to re-confirm
 * an address they already answered. Called at the tail of a sync pass. Best-effort:
 * it may never undo the mirror it follows.
 */
async function applyConfirmedLinks() {
  try {
    const { rowCount } = await db.query(
      `UPDATE lt_loans l
          SET borrower_id = k.borrower_id, updated_at = now()
         FROM lt_borrower_links k
        WHERE k.status = 'confirmed'
          AND k.borrower_id IS NOT NULL
          AND l.borrower_email = k.encompass_email
          AND l.borrower_id IS DISTINCT FROM k.borrower_id`,
    );
    return { ok: true, linked: rowCount };
  } catch (e) {
    console.error('[lt] applying confirmed borrower links failed:', (e && e.message) || e);
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

module.exports = {
  confirmLink,
  rejectLink,
  unlink,
  loadLinks,
  applyConfirmedLinks,
  _internals: { applyToLoans, refuse },
};
