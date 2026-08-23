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
const contacts = require('./people/contacts');
const product = require('./product');
const stages = require('./stages');
const book = require('./pipeline-book');
const productTerm = require('./product-term');

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
  // Sorted on the SAME expression the row displays. Sorting on b.full_name alone put
  // every unlinked loan in one undifferentiated block at the end while the page
  // showed real names -- a list that disagrees with its own ordering.
  borrower: "COALESCE(b.full_name, NULLIF(TRIM(l.borrower_name), ''))",
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

/**
 * The chip for "we have no stage for this loan yet", and the value that filters to it.
 *
 * NOT a hypothetical. `discoverLoans` finds a loan from the pipeline search, whose
 * `Loan.CurrentMilestone` column is blank on every loan in this tenant (§4.1.1), so a
 * newly discovered loan carries NO stage until its detail sync runs — which makes an
 * unstaged loan the NORMAL state of the newest files, exactly the ones somebody is
 * looking for. Without a chip it sits in the list, is counted in the header, and can
 * be filtered to by nothing: §4.1.1's "shown, not hidden" half-kept, which is the
 * version that looks fine until you go looking for a file.
 *
 * The sentinel is parenthesised because a stage key is a settings word or an Encompass
 * milestone name, and neither carries brackets — so it can never collide with a real
 * one. It is EXPORTED so the screen and the saved-view validator use the one constant.
 */
const NO_STAGE = '(none)';

/** "This loan officer's files" — one predicate, so the list and its count agree. */
const officerIsSql = (ph) => `EXISTS (
      SELECT 1 FROM lt_loan_contacts c2
       WHERE c2.loan_id = l.id
         AND c2.role = '${contacts.OFFICER_ROLE}'
         AND ${access.effectiveStaffSql('c2')} = ${ph}::uuid
    )`;

/** "Nobody is on it yet" — the closer's and funder's reason for seeing the whole book. */
const UNASSIGNED_SQL = `NOT EXISTS (
      SELECT 1 FROM lt_loan_contacts c3
       WHERE c3.loan_id = l.id
         AND ${access.effectiveStaffSql('c3')} IS NOT NULL
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
 * @param filters      {stage, folder, search, officerStaffId, unassigned, book}
 * @param omit         Set of filter names to leave out
 * @param opts         {books} — TENANT CONFIG, not a filter. It is passed in
 *                     rather than read here so this stays pure and unit-testable; with
 *                     it absent (or empty, which is the shipped default) the SQL is
 *                     byte-identical to what it was before the live/closed split.
 * @returns {{whereSql, params, p}}
 */
function buildWhere(viewerAccess, staffId, filters = {}, omit = new Set(), opts = {}) {
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

  if (!skip('stage') && filters.stage === NO_STAGE) {
    where.push("(l.stage_key IS NULL OR l.stage_key = '')");
  } else if (!skip('stage') && filters.stage) {
    where.push(`l.stage_key = ${p(String(filters.stage))}`);
  }
  if (!skip('folder') && filters.folder) where.push(`l.loan_folder = ${p(String(filters.folder))}`);

  // THE LIVE BOOK vs THE CLOSED ONE. Composed from `pipeline-book`, which is the one
  // place that decides what "over" means — and which answers NULL whenever the tenant
  // has named no folders, so this adds nothing to the query on a tenant that has not
  // configured it. An unlisted folder, and a loan with no folder, are always LIVE.
  if (!skip('book')) {
    const bookSql = book.bookWhereSql(filters.book, opts.books, p);
    if (bookSql) where.push(bookSql);
  }

  // THIS IS THE LONG-TERM PIPELINE, SO IT LISTS LONG-TERM FILES (owner-directed
  // 2026-08-23). The mirror no longer brings short-term loans IN, but one pulled
  // before that rule existed is already in the book, and the two halves are needed
  // together or the screen keeps showing files that were never ours.
  //
  // `productSql` is the SQL twin of `classifyProduct` — the SAME rule, proven to
  // agree with the JS half row for row by `test-lt-product-term-db.js`. Never a
  // hand-written program test here: a second copy is how the pipeline and the census
  // come to disagree about whose loan this is.
  //
  // ONLY A PROVABLE SHORT-TERM LOAN IS HIDDEN. `boundary` and `unknown` stay on the
  // screen — a file we cannot place must never vanish — and the census still counts
  // ALL FOUR buckets, including the hidden ones, so totals reconcile against
  // Encompass and nothing disappears without a trace. This is NOT omittable by a
  // facet: a count that included files the list refuses to show would be a number
  // nobody could reconcile with what is in front of them.
  if (opts.hideShortTerm !== false) {
    where.push(`(${productTerm.productSql('l.program_name', 'l.term_months')}) <> '${productTerm.PRODUCT.SHORT}'`);
  }

  // "Somebody else's files" — only meaningful to a viewer who sees everything; a
  // scoped viewer already cannot see them, so it narrows rather than widens.
  if (!skip('whose') && filters.officerStaffId) {
    where.push(officerIsSql(p(String(filters.officerStaffId))));
  }

  // A SCOPE FILTER THAT CANNOT MEAN ANYTHING FOR THIS VIEWER IS NOT APPLIED, and that
  // is a safety rule rather than a tidiness one. A saved view is SHARED: an admin who
  // saves "Nobody yet" and shares it hands a loan officer a filter that is
  // CONTRADICTORY with their own scope — their book is the files they are on, and
  // "nobody is on it" can never overlap that — so the view would open an empty
  // pipeline, and the screen does not draw the scope row for them, so there would be
  // no control to clear it with. `mine` is the harmless twin: for them it is exactly
  // their scope restated. Both are ignored and REPORTED, never silently obeyed.
  const scopeFilterMoot = !viewerAccess || !viewerAccess.seesAll;
  if (!skip('whose') && filters.unassigned && !scopeFilterMoot) where.push(UNASSIGNED_SQL);

  // "Mine" for somebody who sees the whole book. It is `access.onFileSql`, the SAME
  // predicate that decides what a SCOPED viewer may see at all — so "my files" means
  // one thing on this side, whichever chair you are sitting in. Defining it as "the
  // loan officer is me" would hand every processor an empty book of their own.
  if (!skip('whose') && filters.mine && staffId && !scopeFilterMoot) {
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
function buildPipelineQuery(viewerAccess, staffId, filters = {}, opts = {}) {
  const { whereSql, params } = buildWhere(viewerAccess, staffId, filters, new Set(), opts);

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
           -- THE NAME WE ALREADY HAVE, RATHER THAN A DASH (owner-reported
           -- 2026-08-23: "None of the files have borrower information").
           --
           -- This read b.full_name alone -- the LINKED shared profile. That link is
           -- made by a human on the borrower-match screen, so on a freshly mirrored
           -- book borrower_id is NULL on every loan, nothing sits on the other side
           -- of that outer join, and the column reads a dash. Which says WE DO NOT
           -- KNOW WHO THIS BORROWER IS, on a book where discovery stored the name Encompass
           -- gave us for every single loan (lt_loans.borrower_name). Showing a dash
           -- over a fact we hold is the confident wrong answer in its cheapest form,
           -- and here it made the entire pipeline look broken.
           --
           -- THE LINKED PROFILE STILL WINS when there is one: it is the name a human
           -- confirmed, and it is what every other PILOT surface shows this person
           -- as. Encompass's copy is the fallback, and borrower_is_linked travels
           -- with it so the screen can say which of the two it is drawing rather than
           -- letting an unconfirmed name pass for a confirmed one.
           COALESCE(b.full_name, NULLIF(TRIM(l.borrower_name), '')) AS borrower_name,
           (l.borrower_id IS NOT NULL) AS borrower_is_linked,
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
                     'staffId', ${access.effectiveStaffSql('c')},
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
function buildFacetQueries(viewerAccess, staffId, filters = {}, opts = {}) {
  const forStages = buildWhere(viewerAccess, staffId, filters, new Set(['stage']), opts);
  const stagesSql = `
    SELECT COALESCE(l.stage_key, '') AS stage_key, count(*)::int AS n
      ${FROM} ${forStages.whereSql}
     GROUP BY 1`;

  // The scope counts. `mine` needs the viewer's own id, and a viewer we cannot
  // identify simply has no "mine" — reported as null, never as 0, because "nobody
  // knows who you are" and "you have no files" are different answers.
  const forScope = buildWhere(viewerAccess, staffId, filters, new Set(['whose']), opts);
  const me = staffId ? String(staffId) : null;
  const minePh = me ? `$${forScope.params.length + 1}` : null;
  if (me) forScope.params.push(me);
  const scopeSql = `
    SELECT count(*)::int AS all_n,
           ${me ? `count(*) FILTER (WHERE ${access.onFileSql(minePh)})::int` : 'NULL::int'} AS mine_n,
           count(*) FILTER (WHERE ${UNASSIGNED_SQL})::int AS unassigned_n
      ${FROM} ${forScope.whereSql}`;

  // The live/closed counts, with the BOOK filter lifted and every other one kept —
  // the same rule as the two rows above, for the same reason: with "Closed" selected,
  // a "Live" chip counted under the closed filter would read zero and the way back
  // would be the chip claiming there is nothing there.
  //
  // NULL when the tenant has named no folder: the row is not drawn at all in that
  // case, and a count of 0 closed files would otherwise read as a measurement rather
  // than as "nobody has said which folders mean finished".
  let bookSql = null;
  let bookParams = null;
  if (book.bookSplitApplies(opts.books)) {
    const forBook = buildWhere(viewerAccess, staffId, filters, new Set(['book']), opts);
    // Normalized for the same reason `bookWhereSql` does it: the SQL lower-cases only
    // its own side, so a raw list here would count zero closed loans on a tenant that
    // has plenty — a chip reading 0 that nobody would think to doubt.
    const cfg = opts.books || {};
    // Each list becomes ONE parameter, referenced by every count that needs it. A
    // list nobody configured is the literal `false` rather than an empty array, so
    // `= ANY('{}')` — which is false for every row but still a comparison — never
    // gets built for a book this tenant does not have.
    const bind = (list) => {
      const clean = book.normalizeFolders(list);
      if (!clean.length) return 'false';
      forBook.params.push(clean);
      return book.folderInSql('l', `$${forBook.params.length}`);
    };
    const closed = bind(cfg.closed);
    const withdrawn = bind(cfg.withdrawn);
    const excluded = bind(cfg.excluded);
    // `live` is neither finished nor dead nor hidden; `all` is the three books
    // together and still not the hidden folders — an excluded folder is not a book,
    // so counting it into the total would make the chips fail to sum to the header.
    bookSql = `
    SELECT count(*) FILTER (WHERE NOT (${closed}) AND NOT (${withdrawn}) AND NOT (${excluded}))::int AS live_n,
           count(*) FILTER (WHERE ${closed})::int AS closed_n,
           count(*) FILTER (WHERE ${withdrawn})::int AS withdrawn_n,
           count(*) FILTER (WHERE NOT (${excluded}))::int AS all_n
      ${FROM} ${forBook.whereSql}`;
    bookParams = forBook.params;
  }

  return {
    stagesSql, stagesParams: forStages.params,
    scopeSql, scopeParams: forScope.params,
    bookSql, bookParams,
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
  const [{ rows: stageRows }, { rows: scopeRows }, bookRes] = await Promise.all([
    lazy.db.query(f.stagesSql, f.stagesParams),
    lazy.db.query(f.scopeSql, f.scopeParams),
    f.bookSql ? lazy.db.query(f.bookSql, f.bookParams) : Promise.resolve(null),
  ]);
  const byStage = {};
  let allStages = 0;
  for (const r of stageRows) {
    byStage[String(r.stage_key || '')] = Number(r.n) || 0;
    allStages += Number(r.n) || 0;
  }
  const s = scopeRows[0] || {};
  const bk = bookRes && bookRes.rows && bookRes.rows[0] ? bookRes.rows[0] : null;
  return {
    byStage,
    // NULL, not zeroes, when no folder is configured — the row is not drawn and
    // "0 finished" would be a claim nobody measured.
    book: bk ? {
      live: Number(bk.live_n) || 0,
      closed: Number(bk.closed_n) || 0,
      withdrawn: Number(bk.withdrawn_n) || 0,
      all: Number(bk.all_n) || 0,
    } : null,
    // What the "Every stage" chip must show. It is NOT the list's own total: that is
    // counted WITH the stage filter, so with a stage selected the "Every stage" chip
    // would read the selected stage's number and nobody could see how big the book
    // is — the same defect the per-stage counts are built to avoid, on the one chip
    // that undoes them. These rows are already counted stage-lifted, so their sum is
    // the answer and no third query is needed.
    allStages,
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

  // Which folders this tenant says mean the deal is over. Read ONCE here and threaded
  // into both builders, so the list, its total and every chip count are describing the
  // same book — reading it twice is how a count comes to disagree with the page.
  const books = book.bookFolders(settings);
  // Read here, with the books, and threaded into BOTH builders for the same reason:
  // the list and every chip count have to be describing one book. A tenant that turns
  // it off gets exactly the query this screen ran before the rule existed.
  const opts = { books, hideShortTerm: settings['pipeline.hideShortTerm'] !== false };

  const q = buildPipelineQuery(viewerAccess, staffId, filters, opts);
  const f = buildFacetQueries(viewerAccess, staffId, filters, opts);
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
    facets: facets ? { ...facets.scope, allStages: facets.allStages } : null,
    // WHICH BOOK IS BEING SHOWN, and whether there is anything to switch between.
    // `bookControl` is false on a tenant that has named no finished folders — the
    // screen draws no row then, because three chips selecting identical rows is not a
    // control (the same rule the scope row follows for a viewer who sees only their
    // own files).
    book: book.normalizeBook(filters.book),
    bookControl: book.bookSplitApplies(books),
    bookCounts: facets ? facets.book : null,
    // A filter this tenant's own configuration makes moot — NAMED, so the screen can
    // say so rather than showing a book that quietly ignores what was asked for.
    filtersIgnored: [
      ...ignoredScopeFilters(viewerAccess, filters),
      ...[book.ignoredBookFilter(filters.book, books)].filter(Boolean),
    ],
  };
}

/**
 * Which scope filters this viewer's own scope makes meaningless, in plain words.
 *
 * Saying so matters because a saved view is SHARED: an admin's "Nobody yet" opened by
 * a loan officer is not a narrower book, it is a contradiction with their own scope,
 * and answering it literally would be an empty pipeline they have no control to clear.
 * The filter is dropped in `buildWhere`; this is what tells them it was.
 */
function ignoredScopeFilters(viewerAccess, filters = {}) {
  if (viewerAccess && viewerAccess.seesAll) return [];
  const out = [];
  if (filters.unassigned) {
    out.push({
      key: 'unassigned',
      why: 'You see the files you are on, so "nobody yet" cannot match any of them — it has been left off.',
    });
  }
  if (filters.mine) {
    out.push({
      key: 'mine',
      why: 'Every file you can see is already one of yours, so this changes nothing.',
    });
  }
  return out;
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
  // The loans with NO stage at all. They come back under the empty key (the count
  // COALESCEs), and without this they would be in the list and in the header total
  // and reachable from no chip — so the row's numbers would not add up to the number
  // above it, which is the sort of thing nobody reports and everybody stops trusting.
  const unstaged = counts[''] || 0;
  if (unstaged > 0) {
    list.push({
      key: NO_STAGE, label: 'No stage yet', count: unstaged, unstaged: true,
    });
  }
  return list;
}

module.exports = {
  SORTABLE,
  NO_STAGE,
  DEFAULT_SORT,
  MAX_LIMIT,
  DEFAULT_LIMIT,
  buildPipelineQuery,
  buildFacetQueries,
  stageChips,
  ignoredScopeFilters,
  loadPipeline,
  // Exposed for the tests only. `officerIsSql` is the predicate behind "filter the
  // pipeline by officer", and a test that re-typed it would prove nothing about the
  // fragment that actually runs — which matters here because it and the ACCESS scope
  // (access.onFileSql) deliberately disagree about a reassigned file, and that
  // disagreement is asserted rather than assumed.
  _internals: { officerIsSql, UNASSIGNED_SQL },
};
