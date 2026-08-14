'use strict';
/**
 * LONG-TERM — the pipeline query.
 *
 * The owner's first ask: *"Every loan officer should have his RTL pipeline and his
 * long term pipeline… the pipeline dashboard should be totally different."* This is
 * the long-term one's data.
 *
 * THE SCOPE IS THE POINT, and it is not re-derived here. `access.pipelineScopeSql`
 * is the ONE definition of who sees which files, and this module composes its
 * fragment rather than writing a second one — a pipeline that scoped differently
 * from `mayOpenLoan` would mean a file you can see in the list and cannot open, or
 * worse, one you can open from a link and never see listed.
 *
 * THE PLACEHOLDER DISCIPLINE. Every fragment is built from a running parameter
 * index, never a hard-coded `$1`. RTL hit a live Postgres 42P18 exactly here: a
 * hard-coded placeholder becomes an unreferenced parameter the moment a sees-all
 * caller drops the clause. The `p()` helper is what makes that impossible — the
 * index and the parameter array advance together, always.
 *
 * FILTERS ARE APPENDED, NEVER `($n IS NULL OR col = $n)`. That idiom reads as
 * tidy and makes the planner produce one generic plan for every shape of query,
 * which on a growing table is the difference between an index scan and a sequential
 * one. A filter that was not asked for simply is not in the SQL.
 *
 * PURE-ish: `buildPipelineQuery` builds SQL and parameters and touches nothing, so
 * the whole composition — including the placeholder arithmetic — is unit-testable
 * without a database.
 */

const access = require('./access');
const stages = require('./stages');

const lazy = {
  get db() { return require('./db'); },
  get settings() { return require('./settings/store'); },
};

/**
 * What a pipeline row may be sorted by. An ALLOWLIST, because a sort column is
 * interpolated into SQL — there is no placeholder for an identifier, so the only
 * safe sort is one we named ourselves.
 */
const SORTABLE = {
  last_modified: 'l.encompass_last_modified',
  loan_number: 'l.loan_number',
  loan_amount: 'l.loan_amount',
  stage: 'l.stage_key',
  milestone: 'l.milestone_name',
  borrower: 'b.full_name',
  synced: 'l.encompass_synced_at',
};
const DEFAULT_SORT = 'last_modified';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * Build the pipeline query for one viewer.
 *
 * @param access  the viewer's resolved access (`accessFor`)
 * @param staffId the viewer's PILOT id
 * @param filters {stage, folder, search, officerStaffId, unassigned}
 * @returns {{sql, countSql, params}} — the SAME params serve both, so the count can
 *          never describe a different set of rows than the page.
 */
function buildPipelineQuery(viewerAccess, staffId, filters = {}) {
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };

  const where = [];

  // WHO MAY SEE IT — composed, never re-derived. The fragment is asked for the
  // index it will actually occupy.
  const scope = access.pipelineScopeSql(viewerAccess, staffId, params.length + 1);
  if (scope.where) {
    where.push(scope.where);
    // The fragment used ONE placeholder; keep the counter in step with it.
    params.push(...scope.params);
  }

  if (filters.stage) where.push(`l.stage_key = ${p(String(filters.stage))}`);
  if (filters.folder) where.push(`l.loan_folder = ${p(String(filters.folder))}`);

  // "Somebody else's files" — only meaningful to a viewer who sees everything; a
  // scoped viewer already cannot see them, so it narrows rather than widens.
  if (filters.officerStaffId) {
    where.push(`EXISTS (
      SELECT 1 FROM lt_loan_contacts c2
       WHERE c2.loan_id = l.id
         AND c2.role = 'loan_officer'
         AND COALESCE(c2.override_staff_id, c2.staff_id) = ${p(String(filters.officerStaffId))}::uuid
    )`);
  }

  // The files nobody is on yet — the closer's and funder's reason for seeing the
  // whole book before assignment.
  if (filters.unassigned) {
    where.push(`NOT EXISTS (
      SELECT 1 FROM lt_loan_contacts c3
       WHERE c3.loan_id = l.id
         AND COALESCE(c3.override_staff_id, c3.staff_id) IS NOT NULL
    )`);
  }

  if (filters.search) {
    const q = `%${String(filters.search).trim().toLowerCase()}%`;
    const ph = p(q);
    where.push(`(lower(COALESCE(l.loan_number, '')) LIKE ${ph}
              OR lower(COALESCE(b.full_name, '')) LIKE ${ph})`);
  }

  const whereSql = where.length ? `WHERE ${where.join('\n        AND ')}` : '';

  const sortKey = SORTABLE[filters.sort] ? filters.sort : DEFAULT_SORT;
  const dir = String(filters.dir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // NULLS LAST on both directions: a loan we have never synced must not head the
  // list just because its stamp is empty.
  const orderSql = `ORDER BY ${SORTABLE[sortKey]} ${dir} NULLS LAST, l.id`;

  const limit = Math.min(
    Math.max(1, Number.isFinite(Number(filters.limit)) ? Math.floor(Number(filters.limit)) : DEFAULT_LIMIT),
    MAX_LIMIT,
  );
  const offset = Math.max(0, Number.isFinite(Number(filters.offset)) ? Math.floor(Number(filters.offset)) : 0);

  // There is no `lt_borrowers` table, and inventing one is the phantom-table trap
  // this codebase keeps paying for: `lt_loans.borrower_id` points at the SHARED
  // `borrowers` record (db/549's own FK), which is the identity zone Long-Term is
  // authorized to READ — `sql-read borrowers`, ledger 2026-08-03. It is read, never
  // written. `borrowers.full_name` is a generated column (db/346), so it can never
  // disagree with the name parts it is built from.
  //
  // The join is LEFT: a loan whose borrower has not been mirrored yet must still
  // appear. An inner join would silently shrink the pipeline, which on a screen
  // that is meant to be somebody's whole book is the worst kind of wrong.
  const FROM = `
      FROM lt_loans l
      LEFT JOIN borrowers b ON b.id = l.borrower_id`;

  const sql = `
    SELECT l.id, l.loan_number, l.loan_amount, l.note_rate_pct, l.dscr_ratio,
           l.milestone_name, l.stage_key, l.loan_folder,
           l.encompass_last_modified, l.encompass_synced_at, l.encompass_sync_error,
           b.full_name AS borrower_name,
           (SELECT json_agg(json_build_object(
                     'role', c.role,
                     'name', c.encompass_name,
                     'staffId', COALESCE(c.override_staff_id, c.staff_id),
                     'overridden', c.override_staff_id IS NOT NULL))
              FROM lt_loan_contacts c WHERE c.loan_id = l.id) AS contacts
      ${FROM}
      ${whereSql}
      ${orderSql}
      LIMIT ${limit} OFFSET ${offset}`;

  const countSql = `SELECT count(*)::int AS n ${FROM} ${whereSql}`;

  return { sql, countSql, params, limit, offset, sort: sortKey, dir };
}

/**
 * Run it, and say WHY the answer is empty when it is.
 *
 * "You have no long-term files" and "nobody has linked your Encompass account yet"
 * look identical on screen and need completely different actions — the second is
 * the state every officer is in until an admin confirms their link, so a pipeline
 * that could not explain it would generate a support question per officer.
 */
async function loadPipeline(staff, filters = {}) {
  const { settings } = await lazy.settings.load();
  const viewerAccess = access.accessFor(staff, settings);
  const staffId = staff && staff.id ? String(staff.id) : null;

  const q = buildPipelineQuery(viewerAccess, staffId, filters);
  const [{ rows }, { rows: counted }] = await Promise.all([
    lazy.db.query(q.sql, q.params),
    lazy.db.query(q.countSql, q.params),
  ]);

  let emptyReason = null;
  if (!rows.length && !viewerAccess.seesAll) {
    let hasConfirmedLink = null;
    try {
      hasConfirmedLink = await require('./people/links').hasConfirmedLink(staffId);
    } catch (_) { /* an unreadable link is not a reason to invent an explanation */ }
    emptyReason = access.emptyPipelineReason(viewerAccess, { hasConfirmedLink });
  }

  return {
    loans: rows,
    total: counted[0] ? counted[0].n : 0,
    limit: q.limit,
    offset: q.offset,
    sort: q.sort,
    dir: q.dir,
    scope: viewerAccess.scope,
    ltRole: viewerAccess.ltRole,
    emptyReason,
    stages: stages.stageList(stages.configFrom(settings)),
  };
}

module.exports = {
  SORTABLE,
  DEFAULT_SORT,
  MAX_LIMIT,
  DEFAULT_LIMIT,
  buildPipelineQuery,
  loadPipeline,
};
