'use strict';
/**
 * THE BORROWER CONFIRMS THEIR OWN PROPERTIES — blueprint §9.4, phase 8.
 *
 * Staff have searched the public records and staged what came back. This module
 * shows the borrower that queue, one property at a time, and records yes / no.
 *
 * ═══ A BORROWER'S "YES" IS A CLAIM, NOT A VERIFICATION ═════════════════════
 * It writes a track-record line at `pending` and lands in the staff queue. That
 * is not a weakening of anything: a borrower can ALREADY type a track-record
 * line by hand through their own tool (`POST /api/borrower/track-records`), and
 * confirming a property the public records already name is strictly less risky
 * than typing one from memory. db/485's guard forces `pending` either way, and a
 * human verifies before it counts toward the tier that prices the loan.
 *
 * ═══ NOTHING HERE SPENDS MONEY ════════════════════════════════════════════
 * This module makes NO vendor call — not one, not cached, not conditional. It
 * reads a queue a staffer already paid for. A borrower pressing a button must
 * never be able to spend the office's hourly allowance THROUGH THIS MODULE, and
 * the way to guarantee that is for the code path to contain no lookup at all
 * rather than a throttle somebody could later raise. A test asserts the module
 * never requires the lookups layer. Borrower-INITIATED search exists as its own
 * separate door with its own budget class (self-search.js, 2026-08-19 — durable
 * cooldown + monthly ceiling, never a bare personal-name search); what it finds
 * lands in THIS queue for the borrower to confirm.
 *
 * ═══ WHAT A BORROWER MAY SEE ══════════════════════════════════════════════
 * `SAFE_FIELDS` is a closed list and the projection is built from it, so a
 * column added to the staging table tomorrow is invisible here until somebody
 * deliberately adds it. Never exposed: the vendor payload (`raw`), staff
 * `internal_notes`, `match_why`, who decided, the search that found it, or any
 * contact detail — we do not skip trace, and showing a phone number would imply
 * we had.
 *
 * ═══ A BORROWER'S "NOT MINE" IS WEAKER THAN A STAFFER'S ═══════════════════
 * db/496 makes a decline durable so the next search cannot re-raise it, and that
 * reasoning was written for a staffer looking at the whole file. A borrower
 * answers from memory, at speed, usually on a phone, about a property they may
 * have held years ago under a company they barely remember — and a mistaken "not
 * mine" costs them experience, which sets the tier, which sets the leverage. So
 * db/504 records WHICH of the two answered, `loadQueue` surfaces it, and a
 * staffer can overturn it. The borrower is not re-asked; the answer is not
 * hidden from us.
 */

const IMPORTER = require('./importer');

const str = (v) => String(v == null ? '' : v).trim();

/** THE CLOSED LIST. A new column on the staging table is not borrower-facing
 *  until it is named here, deliberately. */
const SAFE_FIELDS = [
  'id', 'address', 'purchaseDate', 'purchasePrice', 'saleDate', 'salePrice',
  'entityName', 'alreadyOnRecord', 'answered', 'answer',
  'dealType', 'dealTypeDerived', 'dealTypeWhy',
];
/* The allowlist is ENFORCED, not aspirational (2026-08-09 audit: the header
   claimed "the projection is built from it" while `shape()` was hand-written —
   dealType had already been added to the payload without touching this list,
   which is exactly the drift the list exists to stop). Every borrower-facing
   candidate object passes through here; a field not named above is dropped, so
   a future internal column (vendor raw, match confidence, decided_by) can
   never leak by being added to `shape()` alone. */
const pickSafe = (o) => { const out = {}; for (const k of SAFE_FIELDS) if (o[k] !== undefined) out[k] = o[k]; return out; };

const ANSWERS = ['mine', 'not_mine'];

/* `track_record_candidates.id` is a bigint. A path id that is not a plausible
   bigint ('abc', 20 digits, an injection probe) used to reach the bind and
   raise 22P02/22003, which the route's catch turns into 500 "server error" —
   reads as "PILOT is broken" instead of "no such property". The column decides
   (the repo's number-bounds rule); this door answers 404 like any other id
   that matches nothing. */
const GOOD_ID = /^\d{1,18}$/;
function assertId(candidateId) {
  if (GOOD_ID.test(String(candidateId == null ? '' : candidateId).trim())) return;
  const e = new Error('not found'); e.status = 404; throw e;
}

/**
 * The borrower's queue, and honest progress.
 *
 * The denominator comes from the SERVER (`total`), never from a client-side
 * counter, so "3 of 8" survives closing the tab — and the count is of what they
 * were actually asked, so it can never quietly grow while they work.
 */
async function loadForBorrower(borrowerId, client) {
  const db = client || require('../../db');
  const rows = (await db.query(
    `SELECT c.id, c.property_address, c.purchase_date, c.purchase_price,
            c.sale_date, c.sale_price, c.entity_name, c.status,
            c.match_track_record_id, c.decided_by_kind, c.borrower_seen_at
       FROM track_record_candidates c
      WHERE c.borrower_id=$1
        AND c.status IN ('staged','imported','merged','declined')
        /* A candidate a STAFFER already decided is not the borrower's question.
           Only their own answers, and whatever is still open, are theirs. */
        AND (c.status = 'staged' OR c.decided_by_kind = 'borrower')
      ORDER BY c.created_at`, [borrowerId])).rows;

  const shape = (r) => ({
    id: String(r.id),
    address: IMPORTER.addressLabel(r.property_address),
    purchaseDate: r.purchase_date, purchasePrice: r.purchase_price,
    saleDate: r.sale_date, salePrice: r.sale_price,
    entityName: r.entity_name || null,
    /* Worth saying plainly — "you already have this one" is a different
       sentence from "is this yours?", and asking the second when the first is
       true reads as though we lost their record. */
    alreadyOnRecord: !!r.match_track_record_id,
    answered: r.status !== 'staged',
    answer: r.status === 'staged' ? null
      : (r.status === 'declined' ? 'not_mine' : 'mine'),
    /* THE DEAL TYPE IS DERIVED AND STATED, NOT ASKED — when the records answer
       it. Bought and then sold IS a flip; asking a borrower to classify their
       own deal invites them to pick the label that prices best, and the records
       already said it. When the records do NOT say, `dealType` is null and the
       screen asks — because a line imported without one counts toward nothing
       and is filed under holds (see `importer.dealTypeFromRecords`). */
    dealType: IMPORTER.dealTypeFromRecords(r).dealType,
    dealTypeDerived: IMPORTER.dealTypeFromRecords(r).derived,
    dealTypeWhy: IMPORTER.dealTypeFromRecords(r).why,
  });

  const all = rows.map((r) => pickSafe(shape(r)));
  const answered = all.filter((x) => x.answered).length;

  // Mark what they are being shown, once, so progress is a server fact.
  const unseen = rows.filter((r) => r.status === 'staged' && !r.borrower_seen_at).map((r) => r.id);
  if (unseen.length) {
    await db.query(
      `UPDATE track_record_candidates SET borrower_seen_at = now()
        WHERE id = ANY($1::bigint[]) AND borrower_seen_at IS NULL`, [unseen]).catch(() => {});
  }

  return {
    ok: true,
    total: all.length,
    answered,
    remaining: all.length - answered,
    done: all.length > 0 && answered === all.length,
    properties: all,
    /* The empty state is its OWN thing and must never read as a finding against
       them. Nothing found usually means the county does not publish, not that
       the borrower has no history. */
    nothingToConfirm: all.length === 0,
  };
}

/**
 * Record one answer.
 *
 * `mine` on a property NOT already on their record creates the line, through the
 * importer's own `importNew` — so the entity chokepoint runs (the company on the
 * deed becomes a real entity on their profile) and the line lands `pending`
 * because db/485 says so, not because this module remembered to ask.
 *
 * `mine` on a property ALREADY on their record deliberately writes NOTHING to
 * that line. The owner's rule is that the public records never rewrite our data
 * without a human choosing each change, and a borrower saying "yes that's mine"
 * is not the same as them approving a price and a date they never looked at.
 * The candidate is settled as `merged` so nobody is asked twice, and staff use
 * the side-by-side to fill blanks deliberately.
 */
async function answerCandidate(candidateId, opts, client) {
  assertId(candidateId);
  const a = str(opts && opts.answer);
  if (!ANSWERS.includes(a)) { const e = new Error('that is not one of the answers'); e.status = 400; throw e; }
  if (client) return answerLocked(client, candidateId, opts, a);

  /* ONE ANSWER PER PROPERTY, AND THAT IS A LOCK — the same defect the staff
     door had (see `importer.decideCandidate`). Reading the status and then
     writing let two taps of one button both pass the check and write two
     track-record lines for one property; driven concurrently, three taps
     produced three lines. A phone on a flaky connection retries by itself, so
     this is not a contrived race — and the duplicate lands on the record that
     prices the loan. The transaction also means the line and the candidate's
     settlement commit together or not at all. */
  const conn = await require('../../db').getClient();
  try {
    await conn.query('BEGIN');
    const out = await answerLocked(conn, candidateId, opts, a);
    await conn.query('COMMIT');
    return out;
  } catch (e) {
    await conn.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

async function answerLocked(db, candidateId, { borrowerId, dealType, note }, a) {
  const c = (await db.query(
    `SELECT * FROM track_record_candidates WHERE id=$1 AND borrower_id=$2 FOR UPDATE`,
    [candidateId, borrowerId])).rows[0];
  if (!c) { const e = new Error('not found'); e.status = 404; throw e; }
  if (c.status !== 'staged') {
    const e = new Error('That one has already been answered.'); e.status = 409; throw e;
  }

  if (a === 'not_mine') {
    await db.query(
      `UPDATE track_record_candidates
          SET status='declined', decided_by_borrower=$2::uuid, decided_by_kind='borrower',
              decided_at=now(), resolution_note=$3
        WHERE id=$1`,
      [candidateId, borrowerId, str(note).slice(0, 500) || 'The borrower says this is not their property.']);
    return { ok: true, answer: a, status: 'declined' };
  }

  if (c.match_track_record_id) {
    await db.query(
      `UPDATE track_record_candidates
          SET status='merged', imported_track_record_id=$2,
              decided_by_borrower=$3::uuid, decided_by_kind='borrower',
              decided_at=now(), resolution_note=$4
        WHERE id=$1`,
      [candidateId, c.match_track_record_id, borrowerId,
        'The borrower confirmed this is theirs; it was already on their record.']);
    return { ok: true, answer: a, status: 'merged', trackRecordId: c.match_track_record_id, alreadyOnRecord: true };
  }

  const out = await IMPORTER._internals.importNew(db, c, {
    staffId: null, borrowerActor: borrowerId, enteredByKind: 'borrower',
    dealType, note,
  });
  return { ...out, answer: a, alreadyOnRecord: false };
}

/**
 * Take an answer back.
 *
 * Undoing a "yes" removes the line it created — but ONLY a line that is still
 * EXACTLY as this module left it, and "exactly" is enforced literally: every
 * figure still equal to what the candidate staged, the import's own note text
 * untouched, no officer note, no verification activity of any kind, no
 * document, no condition. The first cut checked five of those and an audit
 * proved the gap the hard way: lines carrying an officer's fraud note
 * ("seller is the borrower's brother"), a `docs_status` a staffer had moved,
 * a `verification_status` of 'limited' — one of the two statuses db/485's own
 * counting function treats as verified — were all DELETED by a borrower's
 * undo. The moment anybody has touched the line it is theirs; the pristine
 * test must be the FULL definition of untouched, the same discipline as
 * `encompass/enrich.js`'s PRISTINE_ENRICHMENT_ROW, and for the same reason:
 * `documents.track_record_id` CASCADES, so deleting a worked line takes the
 * evidence with it.
 *
 * AND THE ANSWER ONLY REOPENS WHEN THE LINE ACTUALLY WENT. The old shape reset
 * the candidate to `staged` unconditionally — so when the line was KEPT
 * (because staff had worked it), the question came back with its link to the
 * surviving line erased, and answering "mine" again wrote a SECOND line for
 * the same property: two clicks, a duplicate on the record that prices the
 * loan, exactly the state db/418 exists to clean up. Now: line removed →
 * question reopens; line kept → the answer STANDS and the borrower is told
 * the team has it — the same sentence the screen already shows.
 *
 * Runs in one transaction with the candidate locked, like `answerCandidate` —
 * two concurrent undos used to each report a different story about the same
 * line ("removed" and "kept it for you" at once).
 */
async function undoAnswer(candidateId, opts, client) {
  assertId(candidateId);
  if (client) return undoLocked(client, candidateId, opts);
  const conn = await require('../../db').getClient();
  try {
    await conn.query('BEGIN');
    const out = await undoLocked(conn, candidateId, opts);
    await conn.query('COMMIT');
    return out;
  } catch (e) {
    await conn.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

/* The import's own notes text — the pristine test requires it verbatim, so an
   edited note (even a non-material one) reads as "worked". Pinned to the
   string `importer.importNew` writes for a borrower's confirm. */
const IMPORT_NOTE = 'The borrower confirmed this one from the public records.';

async function undoLocked(db, candidateId, { borrowerId }) {
  const c = (await db.query(
    `SELECT * FROM track_record_candidates WHERE id=$1 AND borrower_id=$2 FOR UPDATE`,
    [candidateId, borrowerId])).rows[0];
  if (!c) { const e = new Error('not found'); e.status = 404; throw e; }
  if (c.status === 'staged') return { ok: true, status: 'staged', changed: false };
  if (c.decided_by_kind !== 'borrower') {
    /* Somebody on our side decided this. A borrower may not undo a staffer's
       answer — they ask, and a human changes it. */
    const e = new Error('Our team has already reviewed this one. Ask them if it needs changing.');
    e.status = 409; throw e;
  }

  let lineRemoved = false;
  let lineKept = false;
  if (c.status === 'imported' && c.imported_track_record_id) {
    const r = await db.query(
      `DELETE FROM track_records t
        WHERE t.id=$1 AND t.borrower_id=$2
          /* Untouched, in FULL: no verification activity of any kind… */
          AND t.is_verified = false
          AND t.verification_status = 'pending'
          AND t.verified_by IS NULL
          AND t.verified_at IS NULL
          AND COALESCE(t.docs_status, 'outstanding') = 'outstanding'
          /* …no human words on it… */
          AND t.lo_notes IS NULL
          AND t.notes = $3
          /* …every figure still exactly what the candidate staged (a staffer
             re-typing a price is work, whether or not a trigger calls it
             material)… */
          AND t.purchase_price IS NOT DISTINCT FROM $4::numeric
          AND t.purchase_date  IS NOT DISTINCT FROM $5::date
          AND t.sale_price     IS NOT DISTINCT FROM $6::numeric
          AND t.sale_date      IS NOT DISTINCT FROM $7::date
          AND t.rent_amount    IS NOT DISTINCT FROM $8::numeric
          AND t.rent_date      IS NOT DISTINCT FROM $9::date
          AND t.refi_amount    IS NOT DISTINCT FROM $10::numeric
          AND t.refi_date      IS NOT DISTINCT FROM $11::date
          /* …still the row this module wrote, with nothing hanging off it. */
          AND t.origin = 'public_records'
          AND t.entered_by_kind = 'borrower'
          AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.track_record_id = t.id)
          AND NOT EXISTS (SELECT 1 FROM checklist_items ci WHERE ci.track_record_id = t.id)
        RETURNING id`,
      [c.imported_track_record_id, borrowerId, IMPORT_NOTE,
        c.purchase_price, c.purchase_date, c.sale_price, c.sale_date,
        c.rent_amount, c.rent_date, c.refi_amount, c.refi_date]);
    lineRemoved = r.rows.length > 0;
    if (!lineRemoved) {
      /* Removed already by a staffer, or worked? A line that no longer exists
         has nothing to keep — the question simply reopens. */
      const still = (await db.query(
        `SELECT 1 FROM track_records WHERE id=$1`, [c.imported_track_record_id])).rows[0];
      if (still) lineKept = true; else lineRemoved = true;
    }
  }

  if (lineKept) {
    /* THE ANSWER STANDS. Reopening here is what minted duplicate lines. */
    return { ok: true, status: c.status, changed: false, lineRemoved: false, lineKept: true };
  }

  await db.query(
    `UPDATE track_record_candidates
        SET status='staged', imported_track_record_id=NULL,
            decided_by_borrower=NULL, decided_by_kind=NULL, decided_at=NULL, resolution_note=NULL
      WHERE id=$1`, [candidateId]);

  return { ok: true, status: 'staged', changed: true, lineRemoved, lineKept: false };
}

module.exports = {
  loadForBorrower, answerCandidate, undoAnswer,
  SAFE_FIELDS, ANSWERS,
};
