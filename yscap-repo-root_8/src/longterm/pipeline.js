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
const product = require('./product');
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
  // The lock desk's own order: whatever expires soonest, first.
  lock_expiration: 'k.expiration_date',
  // "Which files are stuck" — oldest sighting first. Sorting on the STAMP rather
  // than on the computed age is the same ordering and needs no expression here;
  // a loan we have only baselined sorts last, because its stamp is not an age.
  milestone_since: 'CASE WHEN l.milestone_since_is_baseline THEN NULL ELSE l.milestone_since END',
};
const DEFAULT_SORT = 'last_modified';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * The tables every pipeline read shares — the list, its total, and the chip counts.
 * ONE definition, because a count over a different FROM is a count that describes
 * different rows than the page it sits above.
 *
 * There is no `lt_borrowers` table, and inventing one is the phantom-table trap this
 * codebase keeps paying for: `lt_loans.borrower_id` points at the SHARED `borrowers`
 * record (db/549's own FK), which is the identity zone Long-Term is authorized to
 * READ — `sql-read borrowers`, ledger 2026-08-03. It is read, never written.
 * `borrowers.full_name` is a generated column (db/346), so it can never disagree with
 * the name parts it is built from.
 *
 * Every join is LEFT. A loan whose borrower has not been mirrored yet must still
 * appear; an inner join would silently shrink the pipeline, which on a screen meant
 * to be somebody's whole book is the worst kind of wrong. `lt_locks` and
 * `lt_properties` join LEFT for the same reason — a loan with no lock or no property
 * read yet is an ordinary loan whose columns simply read empty. `lt_properties` is
 * keyed BY `loan_id` (db/549's primary key), so it can never multiply a row.
 */
const FROM = `
      FROM lt_loans l
      LEFT JOIN borrowers b ON b.id = l.borrower_id
      LEFT JOIN lt_locks k ON k.loan_id = l.id
      LEFT JOIN lt_properties p ON p.loan_id = l.id`;

/** "This loan officer's files" — one predicate, so the list and its count agree. */
const officerIsSql = (ph) => `EXISTS (
      SELECT 1 FROM lt_loan_contacts c2
       WHERE c2.loan_id = l.id
         AND c2.role = 'loan_officer'
         AND COALESCE(c2.override_staff_id, c2.staff_id) = ${ph}::uuid
    )`;

/** "Nobody is on it yet" — the closer's and funder's reason for seeing the whole book. */
const UNASSIGNED_SQL = `NOT EXISTS (
      SELECT 1 FROM lt_loan_contacts c3
       WHERE c3.loan_id = l.id
         AND COALESCE(c3.override_staff_id, c3.staff_id) IS NOT NULL
    )`;

/**
 * Compose the WHERE every pipeline read shares.
 *
 * `omit` NAMES A FILTER TO LEAVE OUT, and it exists for the chip counts. A facet
 * count has to describe WHAT CLICKING IT WOULD SHOW, so counting the stages while
 * the stage filter is applied answers zero for every stage except the selected one —
 * and a row of zeroes is a row nobody can navigate with. So the stage counts are
 * built with `omit:'stage'` and everything else (scope, search, who it belongs to)
 * still applied, and the scope counts the mirror image. Both come from THIS function
 * rather than a second hand-written WHERE, because a count assembled separately from
 * the list is a count that eventually describes different rows.
 *
 * @param viewerAccess the viewer's resolved access (`accessFor`)
 * @param staffId      the viewer's PILOT id
 * @param filters      {stage, folder, search, officerStaffId, unassigned}
 * @param omit         Set of filter names to leave out
 * @returns {{whereSql, params, p}}
 */
function buildWhere(viewerAccess, staffId, filters = {}, omit = new Set()) {
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const where = [];
  const skip = (k) => (omit instanceof Set ? omit.has(k) : Array.isArray(omit) && omit.includes(k));

  // WHO MAY SEE IT — composed, never re-derived, and NEVER omittable: the scope is
  // the authorization, not a filter, so no facet may count past it.
  const scope = access.pipelineScopeSql(viewerAccess, staffId, params.length + 1);
  if (scope.where) {
    where.push(scope.where);
    // The fragment used ONE placeholder; keep the counter in step with it.
    params.push(...scope.params);
  }

  if (!skip('stage') && filters.stage) where.push(`l.stage_key = ${p(String(filters.stage))}`);
  if (!skip('folder') && filters.folder) where.push(`l.loan_folder = ${p(String(filters.folder))}`);

  // "Somebody else's files" — only meaningful to a viewer who sees everything; a
  // scoped viewer already cannot see them, so it narrows rather than widens.
  if (!skip('whose') && filters.officerStaffId) {
    where.push(officerIsSql(p(String(filters.officerStaffId))));
  }
  if (!skip('whose') && filters.unassigned) where.push(UNASSIGNED_SQL);

  // "Mine" for somebody who sees the whole book. It is `access.onFileSql`, the SAME
  // predicate that decides what a SCOPED viewer may see at all — so "my files" means
  // one thing on this side, whichever chair you are sitting in. Defining it as "the
  // loan officer is me" would hand every processor an empty book of their own.
  if (!skip('whose') && filters.mine && staffId) {
    where.push(access.onFileSql(p(String(staffId))));
  }

  if (!skip('search') && filters.search) {
    const q = `%${String(filters.search).trim().toLowerCase()}%`;
    const ph = p(q);
    where.push(`(lower(COALESCE(l.loan_number, '')) LIKE ${ph}
              OR lower(COALESCE(b.full_name, '')) LIKE ${ph})`);
  }

  return { whereSql: where.length ? `WHERE ${where.join('\n        AND ')}` : '', params, p };
}

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
  const { whereSql, params } = buildWhere(viewerAccess, staffId, filters);

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

  const sql = `
    SELECT l.id, l.loan_number, l.loan_amount, l.note_rate_pct, l.dscr_ratio,
           l.milestone_name, l.stage_key, l.loan_folder, l.program_name,
           -- The property columns. Selected ALWAYS, whatever pipeline.columns says:
           -- the setting decides what the SCREEN draws, and building a SELECT list out
           -- of a stored setting would put an administrator's typed value into the
           -- query text and hand the planner a different statement per configuration.
           NULLIF(CONCAT_WS(', ', NULLIF(p.street,''), NULLIF(p.city,''),
                            NULLIF(p.state,''), NULLIF(p.zip,'')), '') AS property_address,
           p.ltv_pct,
           l.encompass_last_modified, l.encompass_synced_at, l.encompass_sync_error,
           b.full_name AS borrower_name,
           k.lock_status, k.expiration_date AS lock_expiration_date,
           k.note_rate_pct AS locked_rate_pct,
           -- Days to expiry is computed HERE rather than in JS so the pipeline can
           -- sort on it. It is a countdown TO a stated date, never a calculation OF
           -- one: the expiration itself is always taken as Encompass states it.
           CASE WHEN k.expiration_date IS NULL THEN NULL
                ELSE (k.expiration_date - CURRENT_DATE) END AS lock_days_remaining,
           l.milestone_since, l.milestone_since_is_baseline,
           -- HOW LONG IT HAS SAT WHERE IT IS — computed here, like the lock
           -- countdown, so the list can be SORTED on it.
           --
           -- NULL ON A BASELINE, and that is the whole point. A baseline stamp is
           -- when PILOT started watching, not when the loan arrived; turning it into
           -- a number would put a confident age on every file in the back book and
           -- would be wrong on exactly the stuck ones this column exists to surface.
           -- milestones.describeClock refuses the same thing for one file; this is
           -- that rule expressed for the list, so the two can never disagree.
           CASE WHEN l.milestone_since IS NULL OR l.milestone_since_is_baseline THEN NULL
                ELSE EXTRACT(DAY FROM (now() - l.milestone_since))::int END AS milestone_days,
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
 * The counts behind the two chip rows.
 *
 * §4.1: "Two independent control rows above it (status chips, scope chips) plus
 * free-text search." A chip without a count is a guess about where the work is; with
 * one, the row triages the book before anybody opens a file.
 *
 * EACH FACET IS COUNTED WITH ITS OWN FILTER LIFTED, and that is the whole subtlety.
 * Count the stages while a stage is selected and every other stage answers zero — a
 * row of zeroes nobody can navigate out of, because the way back is the chip that
 * says there is nothing there. So the stage counts drop `stage` and keep everything
 * else; the scope counts drop `whose` and keep the stage. Both are built by
 * `buildWhere`, so neither can drift from the list they describe.
 *
 * THE SCOPE IS NEVER LIFTED. It is the authorization, not a filter — a chip counting
 * files the viewer may not open would tell them a book exists that they cannot reach.
 */
function buildFacetQueries(viewerAccess, staffId, filters = {}) {
  const forStages = buildWhere(viewerAccess, staffId, filters, new Set(['stage']));
  const stagesSql = `
    SELECT COALESCE(l.stage_key, '') AS stage_key, count(*)::int AS n
      ${FROM} ${forStages.whereSql}
     GROUP BY 1`;

  // The scope counts. `mine` needs the viewer's own id, and a viewer we cannot
  // identify simply has no "mine" — reported as null, never as 0, because "nobody
  // knows who you are" and "you have no files" are different answers.
  const forScope = buildWhere(viewerAccess, staffId, filters, new Set(['whose']));
  const me = staffId ? String(staffId) : null;
  const minePh = me ? `$${forScope.params.length + 1}` : null;
  if (me) forScope.params.push(me);
  const scopeSql = `
    SELECT count(*)::int AS all_n,
           ${me ? `count(*) FILTER (WHERE ${access.onFileSql(minePh)})::int` : 'NULL::int'} AS mine_n,
           count(*) FILTER (WHERE ${UNASSIGNED_SQL})::int AS unassigned_n
      ${FROM} ${forScope.whereSql}`;

  return {
    stagesSql, stagesParams: forStages.params,
    scopeSql, scopeParams: forScope.params,
  };
}

/**
 * Run the two facet queries and shape them for the chip rows.
 *
 * A stage the tenant declares but that no loan is in reports **0**, deliberately —
 * "there is nothing at this stage" is a real answer a desk acts on, and a chip that
 * disappears when it empties makes the row jump around as the book moves. A stage no
 * loan carries AND the tenant has not declared is a different thing: it is a milestone
 * mapping nobody has written yet, so it is listed under its raw key rather than hidden
 * (§4.1.1 — "a milestone with no mapping is shown, not hidden").
 */
async function loadFacets(f, staffId) {
  const [{ rows: stageRows }, { rows: scopeRows }] = await Promise.all([
    lazy.db.query(f.stagesSql, f.stagesParams),
    lazy.db.query(f.scopeSql, f.scopeParams),
  ]);
  const byStage = {};
  for (const r of stageRows) byStage[String(r.stage_key || '')] = Number(r.n) || 0;
  const s = scopeRows[0] || {};
  return {
    byStage,
    scope: {
      all: Number(s.all_n) || 0,
      mine: staffId ? (Number(s.mine_n) || 0) : null,
      unassigned: Number(s.unassigned_n) || 0,
    },
  };
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
  const f = buildFacetQueries(viewerAccess, staffId, filters);
  const [{ rows }, { rows: counted }, facets] = await Promise.all([
    lazy.db.query(q.sql, q.params),
    lazy.db.query(q.countSql, q.params),
    // The chip counts are a CONVENIENCE on top of the list, so a failure to count
    // must never cost somebody their pipeline: the chips lose their numbers and the
    // rows still arrive. Reported as null rather than zero — a zero would say the
    // book is empty, which is precisely the thing the list beside it disproves.
    loadFacets(f, staffId).catch(() => null),
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
    // EVERY ROW CARRIES ITS OWN PRODUCT STAMP (CLAUDE.md §7). Tagged here, at the
    // edge, because a combined pipeline tags and concatenates what each product
    // answers for — so the stamp must be a property of the row and never of the
    // screen it happens to be drawn on.
    loans: product.tagRows(rows),
    total: counted[0] ? counted[0].n : 0,
    limit: q.limit,
    offset: q.offset,
    sort: q.sort,
    dir: q.dir,
    scope: viewerAccess.scope,
    ltRole: viewerAccess.ltRole,
    emptyReason,
    stages: stageChips(stages.stageList(stages.configFrom(settings)), facets),
    facets: facets ? facets.scope : null,
  };
}

/**
 * The stage chips: the tenant's own ladder, each with its count, plus any stage the
 * BOOK holds that the ladder does not name.
 *
 * That last part is §4.1.1's rule expressed for the control row — a milestone with no
 * mapping is shown, not hidden. A loan sitting under a stage key nobody declared is
 * unreachable from a chip row built only from the declared ladder, and a file you
 * cannot filter to is a file people stop seeing. It is marked `undeclared` so the
 * screen can say what it is rather than pretend it was configured.
 */
function stageChips(declared, facets) {
  const counts = facets ? facets.byStage : null;
  const list = (declared || []).map((s) => ({
    ...s, count: counts ? (counts[s.key] || 0) : null,
  }));
  if (!counts) return list;
  const known = new Set(list.map((s) => s.key));
  for (const [key, n] of Object.entries(counts)) {
    if (!key || known.has(key)) continue;
    list.push({ key, label: key, count: n, undeclared: true });
  }
  return list;
}

module.exports = {
  SORTABLE,
  DEFAULT_SORT,
  MAX_LIMIT,
  DEFAULT_LIMIT,
  buildPipelineQuery,
  buildFacetQueries,
  stageChips,
  loadPipeline,
};
