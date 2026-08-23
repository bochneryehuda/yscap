'use strict';
/**
 * LT test — the live book and the closed book, against a real database.
 *
 * A pure test proves the SQL is composed correctly. It cannot prove the SQL is TRUE
 * about rows, and this feature's whole risk is in that gap: `= ANY($1::text[])`, the
 * COALESCE that decides where a folderless loan lands, and the case-folding on both
 * sides either behave or do not, and a wrong one hides real loans from the person
 * working them. So every claim here is made by putting rows in a table and reading
 * them back.
 *
 * The three properties:
 *
 *   1. WITH NOTHING CONFIGURED, EVERY BOOK RETURNS EVERY LOAN. The tenant that has
 *      not answered must not lose a file.
 *   2. AN UNLISTED FOLDER IS LIVE, AND SO IS NO FOLDER AT ALL. The two ways a loan
 *      can fail to be named, both landing on the showing side.
 *   3. EVERY CHIP COUNT EQUALS THE ROWS CLICKING IT RETURNS. Counted the same way
 *      the stage and scope chips already are.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) {
  console.log('SKIP test-lt-pipeline-book-db (no DATABASE_URL)');
  process.exit(0);
}

const ltDb = require('../src/longterm/db');
const pipeline = require('../src/longterm/pipeline');
const book = require('../src/longterm/pipeline-book');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const made = [];
const ALL = { seesAll: true, scope: 'all' };

// Stage keys unique to THIS run. The stage facet counts the whole table — it cannot be
// narrowed to the rows this test made — so a stage key nobody else can be carrying is
// what lets section D assert an exact number instead of a "greater than" that would
// pass whatever the rest of the book looked like.
const RUN = `${Date.now()}`;
const STAGE_LIVE = `ltbk-live-${RUN}`;
const STAGE_DONE = `ltbk-done-${RUN}`;

async function makeLoan(folder, stage = STAGE_LIVE) {
  const stamp = `LTBK${RUN}${made.length}`;
  const { rows } = await ltDb.query(
    `INSERT INTO lt_loans (id, loan_number, encompass_loan_guid, stage_key, milestone_name, loan_folder)
          VALUES (gen_random_uuid(), $1, $1, $3, 'Processing', $2) RETURNING id`,
    [stamp, folder, stage],
  );
  made.push(String(rows[0].id));
  return String(rows[0].id);
}

/** The list, narrowed to the loans this test made, so a pre-existing book cannot skew it. */
async function listIds(filters, opts) {
  const q = pipeline.buildPipelineQuery(ALL, null, filters, opts);
  const { rows } = await ltDb.query(q.sql, q.params);
  return rows.filter((r) => made.includes(String(r.id))).map((r) => String(r.id));
}

async function bookCounts(filters, opts) {
  const f = pipeline.buildFacetQueries(ALL, null, filters, opts);
  if (!f.bookSql) return null;
  const { rows } = await ltDb.query(f.bookSql, f.bookParams);
  return rows[0];
}

(async () => {
  try {
    // A book with every shape that matters: two plainly finished, one plainly live,
    // one whose folder nobody has named, and one with NO folder at all.
    const adverse = await makeLoan('Adverse', STAGE_DONE);
    const trash = await makeLoan('Trash', STAGE_DONE);
    const active = await makeLoan('Active Loans');
    const unnamed = await makeLoan('Some Folder Nobody Listed');
    const noFolder = await makeLoan(null);
    // Typed one way in the setting, stored another way by Encompass — the case and
    // spacing difference this is most likely to meet in the wild.
    const spaced = await makeLoan('  loan   WITHDRAWN ');
    // ADDED 2026-08-23 with the third book: a deal that DIED, and a file that is not a
    // deal at all. Without real rows in these two folders the partition below could
    // only ever prove the two-book case it used to.
    const cancelled = await makeLoan('Withdrawn files', STAGE_DONE);
    const training = await makeLoan('Training');

    const CLOSED = ['Adverse', 'Trash', 'Loan Withdrawn'];
    const WITHDRAWN = ['Withdrawn files'];
    const EXCLUDED = ['Training'];
    const OFF = { books: { closed: [], withdrawn: [], excluded: [] } };
    const ON = { books: { closed: CLOSED, withdrawn: WITHDRAWN, excluded: EXCLUDED } };

    // ── A. Nothing configured: nothing changes ───────────────────────────────
    console.log('with nothing configured, no file is hidden from anybody');

    const everyone = await listIds({}, OFF);
    check(everyone.length === made.length,
      `every loan this test made is listed (${everyone.length} of ${made.length})`);
    for (const b of ['live', 'closed', 'all']) {
      const got = await listIds({ book: b }, OFF);
      check(got.length === made.length,
        `THE ONE THAT MATTERS: asking for the ${b} book still returns ALL ${got.length} — a tenant that has not `
        + 'said which folders mean "finished" must not lose a file to a book nobody defined');
    }
    check((await bookCounts({}, OFF)) === null,
      'and no count is offered, so the screen draws no control and claims no measurement');

    // ── B. Configured: the split is real ─────────────────────────────────────
    console.log('\nonce folders are named, the two books are real');

    const live = await listIds({ book: 'live' }, ON);
    const closed = await listIds({ book: 'closed' }, ON);
    const both = await listIds({ book: 'all' }, ON);

    check(closed.includes(adverse) && closed.includes(trash),
      'a loan in a named folder is in the FINISHED book');
    check(!live.includes(adverse) && !live.includes(trash),
      '…and is not in the live one');
    check(live.includes(active), 'an ordinary loan is live');

    check(live.includes(unnamed),
      'THE ONE THAT MATTERS: a folder NOBODY NAMED is LIVE — folder names are the tenant\'s own and we cannot '
      + 'read the real list, so an unnamed folder must never be guessed into the finished book');
    check(live.includes(noFolder),
      'THE ONE THAT MATTERS: a loan with NO folder at all is LIVE — a newly discovered loan has not been read in '
      + 'detail yet, which makes a blank folder the normal state of the NEWEST files');
    check(!closed.includes(unnamed) && !closed.includes(noFolder),
      '…and neither of them leaks into the finished book');

    check(closed.includes(spaced),
      'a folder typed "Loan Withdrawn" in the setting matches "  loan   WITHDRAWN " on the loan — case and '
      + 'spacing must not decide whether somebody\'s file disappears');

    const withdrawnIds = await listIds({ book: 'withdrawn' }, ON);
    check(withdrawnIds.includes(cancelled) && !closed.includes(cancelled) && !live.includes(cancelled),
      'THE ONE THAT MATTERS: a withdrawn file is in the withdrawn book and in NEITHER of the other two — the '
      + 'owner ruled out mixing a deal that died with one that completed (2026-08-23)');
    check(!live.includes(training) && !closed.includes(training) && !withdrawnIds.includes(training),
      'a hidden folder is in no book at all — a training file is not a deal in any state');

    check(both.length === made.length - 1,
      `"all" returns the three books together and NOT the hidden file (${both.length} of ${made.length})`);
    check(live.length + closed.length + withdrawnIds.length === made.length - 1,
      `THE ONE THAT MATTERS: the three books PARTITION the visible table — ${live.length} live + `
      + `${closed.length} closed + ${withdrawnIds.length} withdrawn = ${made.length - 1}, so no loan is in `
      + 'neither and none is in two');
    check(!live.some((id) => closed.includes(id))
      && !live.some((id) => withdrawnIds.includes(id))
      && !closed.some((id) => withdrawnIds.includes(id)),
    '…proven pairwise by set membership too, not only by the totals adding up');

    // ── C. Every count equals what clicking returns ──────────────────────────
    console.log('\nevery chip count equals the rows clicking it returns');

    // Counted with nothing selected AND with each book selected: the facet lifts its
    // own filter, so all three must agree. A count that moved when a chip was pressed
    // would be the row-of-zeroes bug this pattern exists to prevent.
    for (const selected of [undefined, 'live', 'closed', 'withdrawn', 'all']) {
      const c = await bookCounts(selected ? { book: selected } : {}, ON);
      const scopedLive = Number(c.live_n);
      const scopedClosed = Number(c.closed_n);
      // The counts run over the WHOLE table, so compare the deltas this test owns by
      // re-listing rather than by trusting an absolute number.
      check(scopedLive >= live.length && scopedClosed >= closed.length,
        `with ${selected || '(nothing)'} selected the counts still see both books (${scopedLive} live, ${scopedClosed} finished)`);
    }

    const cBase = await bookCounts({}, ON);
    const cClosed = await bookCounts({ book: 'closed' }, ON);
    check(Number(cBase.live_n) === Number(cClosed.live_n)
      && Number(cBase.closed_n) === Number(cClosed.closed_n),
    'THE ONE THAT MATTERS: selecting the finished book does not change either count — the book filter is lifted '
      + 'for its own facet, so the "Live" chip never reads zero while you are standing in the other book');
    check(Number(cBase.all_n) === Number(cBase.live_n) + Number(cBase.closed_n) + Number(cBase.withdrawn_n),
      'and the THREE counts add up to the total above them, so the row reconciles on screen');

    // ── D. A stage chip is a question about the book you are in ──────────────
    console.log('\nthe other chips narrow BY the book');

    const fLive = pipeline.buildFacetQueries(ALL, null, { book: 'live' }, ON);
    const fClosed = pipeline.buildFacetQueries(ALL, null, { book: 'closed' }, ON);
    // Read as a MAP of this run's own stage keys, not as a total. Comparing the two
    // books' totals is the obvious test and it is worthless: the split here happens to
    // put three loans on each side, so "the totals differ" was false on a perfectly
    // correct query — a fixture coincidence masquerading as a broken rule.
    const stageIn = async (f) => {
      const { rows } = await ltDb.query(f.stagesSql, f.stagesParams);
      const out = {};
      for (const r of rows) out[String(r.stage_key)] = Number(r.n);
      return out;
    };
    const liveStages = await stageIn(fLive);
    const closedStages = await stageIn(fClosed);

    check(liveStages[STAGE_DONE] === undefined && closedStages[STAGE_DONE] === 2,
      'THE ONE THAT MATTERS: a stage that exists ONLY on finished loans is absent from the live book\'s chips and '
      + 'reads 2 in the finished one — a stage chip is a question about the book you are standing in');
    check(closedStages[STAGE_LIVE] === 1 && liveStages[STAGE_LIVE] === 3,
      '…and a stage the two books share is counted separately in each, never once across the table');

    // ── E. The whole thing, through loadPipeline ─────────────────────────────
    console.log('\nand the real read agrees with all of it');

    // `loadPipeline` reads the setting itself. Since 2026-08-23 the shipped default
    // CARRIES the owner's answer, so the control is drawn on an untouched install —
    // which is the state this database is actually in.
    const out = await pipeline.loadPipeline({ id: null, role: 'admin' }, {});
    check(out.book === 'live', 'the response names the book it drew');
    check(out.bookControl === true,
      'and draws the control, because the shipped default names the folders the owner classified');
    check(out.bookCounts && typeof out.bookCounts.withdrawn === 'number',
      '…with a withdrawn count beside the other two, so all three books are reachable from the row');
    check(Array.isArray(out.filtersIgnored),
      'the ignored-filter list is still an array');

    // THE STRANDING CASE STILL HAS TO BE PROVEN, and it can no longer be proven by
    // doing nothing — so the setting is explicitly emptied here. A saved view is
    // SHARED, so somebody can hand a desk "Closed" on a tenant where the list was
    // cleared; the book filter is then dropped and this is what says so.
    await ltDb.query(
      `INSERT INTO lt_settings (scope, key, value, updated_at)
       VALUES ('company', 'pipeline.inactiveFolders', $1::jsonb, now())
       ON CONFLICT (scope, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify([])]);
    // The store caches for a minute and busts on ITS OWN writes; a raw INSERT is
    // invisible to it, so without this the read below would answer from the cache and
    // the assertion would pass or fail for a reason that has nothing to do with the rule.
    require('../src/longterm/settings/store').bust();
    try {
      const cleared = await pipeline.loadPipeline({ id: null, role: 'admin' }, {});
      const stranded = await pipeline.loadPipeline({ id: null, role: 'admin' }, { book: 'closed' });
      check(stranded.filtersIgnored.some((f) => f.key === 'book'),
        'THE ONE THAT MATTERS: asking for the closed book on a tenant whose list was CLEARED is REPORTED — a '
        + 'SHARED saved view could otherwise hand a desk an empty pipeline with no control row to clear it with');
      check(stranded.loans.length >= cleared.loans.length && stranded.loans.length > 0,
        '…and the pipeline shows the book rather than nothing');
      const strandedIds = stranded.loans.map((l) => String(l.id));
      check(!strandedIds.includes(training),
        'THE ONE THAT MATTERS: dropping the book filter does NOT unhide a hidden folder — a cleared closed list '
        + 'must not become the one request that shows a training file');
    } finally {
      await ltDb.query(
        `DELETE FROM lt_settings WHERE scope = 'company' AND key = 'pipeline.inactiveFolders'`).catch(() => {});
      require('../src/longterm/settings/store').bust();
    }

    // ── F. The setting really is declared ────────────────────────────────────
    console.log('\nthe setting carries the owner\'s answer, and the reader agrees');

    const declared = require('../src/longterm/settings/encompass-settings')
      .SETTINGS.find((s) => s.key === 'pipeline.inactiveFolders');
    check(!!declared, 'the settings screen offers it');
    // CHANGED 2026-08-23: this used to assert the default was EMPTY, because which
    // folder means "over" was a business rule nobody here could guess. The owner
    // answered it (§11 q13). What made an empty default safe — an unmatched folder
    // falls through to LIVE — is asserted directly in the pure suite instead, which
    // is the property rather than a proxy for it.
    check(Array.isArray(declared.default) && declared.default.length > 0,
      'its default carries the owner\'s 2026-08-23 classification rather than a blank or a guess');
    check(book.inactiveFolders({ [declared.key]: declared.default }).length > 0,
      'and the reader agrees with the declaration');
  } catch (e) {
    failures += 1;
    console.error('  FAIL unexpected error:', (e && e.message) || e);
  } finally {
    for (const id of made) {
      await ltDb.query('DELETE FROM lt_loan_contacts WHERE loan_id = $1::uuid', [id]).catch(() => {});
      await ltDb.query('DELETE FROM lt_loans WHERE id = $1::uuid', [id]).catch(() => {});
    }
    console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
    process.exit(failures ? 1 : 0);
  }
})();
