'use strict';
/**
 * INTERNAL NOTES ON EVERYTHING — one writer, one reader, staff-only forever.
 *
 * Owner-directed 2026-08-09: *"internal notes on everything."*
 *
 * Five levels, listed in the blueprint and all served by this one module:
 *   property   a track-record line
 *   pillar     one of the three checks on that line
 *   entity     an LLC
 *   condition  the document request itself
 *   candidate  a staged public-records match, before anyone promotes it
 *
 * ── WHY ONE MODULE AND NOT FIVE COLUMNS ────────────────────────────────────
 * Four of those five already have a `text` column and the obvious move is to
 * append into it. Appending cannot record WHO said it or WHEN — the two things
 * a note is for — and a blob can be trampled by the next writer with no trace.
 * db/502 explains the schema choice; this module is the reason it stays one
 * choice: every note in the system is written here, read here, and excluded
 * from the borrower's world here, rather than in five places that each have to
 * remember.
 *
 * ── STAFF-ONLY IS A PROPERTY OF THIS MODULE ────────────────────────────────
 * `readNotes` takes no audience argument and there is no borrower-facing read.
 * Nothing in `src/routes/borrower.js` may require this file, and a test asserts
 * that. The borrower's channel for the same conversation is the condition's own
 * `issue_reason` / `borrower_hint`, which they DO see — a deliberately separate
 * field, so a candid note about a borrower can never be shown to them.
 *
 * ── APPEND-ONLY, AND RETRACTION IS NOT DELETION ────────────────────────────
 * A note is what somebody thought at the time. It is never edited and never
 * deleted; withdrawing one stamps `retracted_at` so the thread still shows that
 * something was said and taken back. That is the same discipline the repo
 * applies to a decided exception and to a superseded document.
 *
 * ── THE PROPERTY MIRROR ────────────────────────────────────────────────────
 * A property note also writes `track_records.lo_notes`. That is not a second
 * copy for its own sake — two live readers depend on that column, and one of
 * them is protective: `encompass/enrich.js` will only auto-REMOVE a
 * pristine enrichment row while `lo_notes IS NULL` ("nobody has touched this").
 * A note is exactly somebody touching it, so the mirror makes adding a note
 * protect the line from an automatic sweep. Losing that would be a real
 * regression, and it is why the mirror is here rather than left to a screen.
 */

const SUBJECTS = ['property', 'pillar', 'entity', 'condition', 'candidate'];

/** How long one note may be. Long enough for a paragraph of real reasoning,
 *  short enough that the column can never be used as a document store. */
const MAX_BODY = 4000;

/** `track_records.lo_notes` is a 1000-char column (the staff PATCH caps there
 *  too). The mirror truncates rather than refusing — the full note is safe in
 *  the thread, and a mirror is a convenience. */
const LO_NOTES_MAX = 1000;

const clean = (s) => String(s == null ? '' : s).trim();

/**
 * Which table and column a subject lives in, so `addNote` can resolve the
 * borrower for a subject the caller did not name. A subject with no lookup is
 * not a bug — a candidate's borrower is always supplied by its own row.
 */
const OWNER_SQL = {
  property: 'SELECT borrower_id FROM track_records WHERE id=$1',
  entity: 'SELECT borrower_id FROM llcs WHERE id=$1',
  condition: 'SELECT COALESCE(ci.borrower_id, a.borrower_id) AS borrower_id FROM checklist_items ci LEFT JOIN applications a ON a.id = ci.application_id WHERE ci.id=$1',
  pillar: 'SELECT t.borrower_id FROM track_record_pillars p JOIN track_records t ON t.id = p.track_record_id WHERE p.id=$1',
  candidate: 'SELECT borrower_id FROM track_record_candidates WHERE id=$1',
};

/**
 * Write one note.
 *
 * @param {object} a
 * @param {string} a.subjectKind  one of SUBJECTS
 * @param {string} a.subjectId
 * @param {string} [a.borrowerId] resolved from the subject when omitted
 * @param {string} a.body
 * @param {string} a.authorId     a staff id — a note with no author is not a note
 * @returns {{id, borrowerId}}
 *
 * Throws with `.status` for anything a route should answer 4xx.
 */
async function addNote(a, client) {
  const db = client || require('../../db');
  const kind = clean(a && a.subjectKind);
  const subjectId = clean(a && a.subjectId);
  const body = clean(a && a.body).slice(0, MAX_BODY);

  if (!SUBJECTS.includes(kind)) { const e = new Error('what is this note about?'); e.status = 400; throw e; }
  if (!subjectId) { const e = new Error('which one?'); e.status = 400; throw e; }
  if (!body) { const e = new Error('the note is empty'); e.status = 400; throw e; }

  let borrowerId = clean(a.borrowerId) || null;
  if (!borrowerId && OWNER_SQL[kind]) {
    try {
      const r = (await db.query(OWNER_SQL[kind], [subjectId])).rows[0];
      borrowerId = (r && r.borrower_id) || null;
    } catch (_) { borrowerId = null; }
  }

  const ins = await db.query(
    `INSERT INTO track_record_notes (subject_kind, subject_id, borrower_id, body, author_id)
     VALUES ($1,$2,$3::uuid,$4,$5::uuid) RETURNING id`,
    [kind, subjectId, borrowerId, body, a.authorId || null]);

  /* THE MIRROR — see the file header. Best-effort: a failed mirror must never
     lose the note, which is the record. */
  if (kind === 'property') {
    try {
      await db.query(
        `UPDATE track_records SET lo_notes=$2, updated_at=now() WHERE id=$1`,
        [subjectId, body.slice(0, LO_NOTES_MAX)]);
    } catch (_) { /* the thread is the record */ }
  }

  return { id: ins.rows[0].id, borrowerId };
}

/**
 * The thread on one subject, newest first. STAFF-ONLY — there is deliberately
 * no audience parameter and no borrower-facing variant.
 */
async function readNotes(subjectKind, subjectId, opts, client) {
  const db = client || require('../../db');
  const kind = clean(subjectKind);
  if (!SUBJECTS.includes(kind) || !clean(subjectId)) return [];
  const limit = Math.min(Math.max(Number((opts && opts.limit) || 50) || 50, 1), 200);
  const r = await db.query(
    `SELECT n.id, n.subject_kind, n.subject_id, n.body, n.created_at,
            n.retracted_at, n.author_id,
            NULLIF(TRIM(COALESCE(s.full_name,'')),'') AS author_name
       FROM track_record_notes n
       LEFT JOIN staff_users s ON s.id = n.author_id
      WHERE n.subject_kind=$1 AND n.subject_id=$2::uuid
      ORDER BY n.created_at DESC
      LIMIT ${limit}`, [kind, clean(subjectId)]);
  return r.rows;
}

/**
 * Every note about one borrower, across all five levels — what the workspace
 * shows in one place so nobody opens five screens to find out what was said.
 */
async function readBorrowerNotes(borrowerId, opts, client) {
  const db = client || require('../../db');
  if (!clean(borrowerId)) return [];
  const limit = Math.min(Math.max(Number((opts && opts.limit) || 100) || 100, 1), 500);
  const r = await db.query(
    `SELECT n.id, n.subject_kind, n.subject_id, n.body, n.created_at, n.retracted_at,
            n.author_id, NULLIF(TRIM(COALESCE(s.full_name,'')),'') AS author_name
       FROM track_record_notes n
       LEFT JOIN staff_users s ON s.id = n.author_id
      WHERE n.borrower_id=$1::uuid
      ORDER BY n.created_at DESC
      LIMIT ${limit}`, [clean(borrowerId)]);
  return r.rows;
}

/**
 * Withdraw a note. It stays in the thread, stamped — a reviewer must be able to
 * see that something was said and taken back, which a delete would hide.
 */
async function retractNote(noteId, staffId, client) {
  const db = client || require('../../db');
  const r = await db.query(
    `UPDATE track_record_notes
        SET retracted_at=now(), retracted_by=$2::uuid
      WHERE id=$1::uuid AND retracted_at IS NULL
      RETURNING id, borrower_id`, [clean(noteId), staffId || null]);
  return r.rows[0] || null;
}

/** How many live notes sit on each subject in a list — one query for a screen
 *  that would otherwise ask once per row. */
async function countsFor(subjectKind, subjectIds, client) {
  const db = client || require('../../db');
  const kind = clean(subjectKind);
  const ids = (Array.isArray(subjectIds) ? subjectIds : []).map(clean).filter(Boolean);
  if (!SUBJECTS.includes(kind) || !ids.length) return {};
  const r = await db.query(
    `SELECT subject_id::text AS id, count(*)::int AS n
       FROM track_record_notes
      WHERE subject_kind=$1 AND subject_id = ANY($2::uuid[]) AND retracted_at IS NULL
      GROUP BY subject_id`, [kind, ids]);
  return Object.fromEntries(r.rows.map((x) => [x.id, x.n]));
}

module.exports = {
  addNote,
  readNotes,
  readBorrowerNotes,
  retractNote,
  countsFor,
  SUBJECTS,
  MAX_BODY,
  LO_NOTES_MAX,
};
