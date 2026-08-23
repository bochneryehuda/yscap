'use strict';
/**
 * LONG-TERM — Encompass's trash is the ARCHIVE, and nothing else ever sees it.
 *
 * Owner-directed 2026-08-23: *"The trash folder from Encompass is real trash …
 * It should not be part of the pipeline at all, not by any filters. It should be
 * totaled in the archive folder, and you can click over there to delete it
 * permanently."* Measured the same day: 49 of 486 mirrored loans were trash —
 * every test file the owner could not find in Encompass ("testing, tesing", the
 * HELOC samples, Alice Customer), plus six of the seven duplicated loan numbers.
 *
 * What this proves, against a REAL Postgres:
 *   A. the rule itself — one normalisation, shared with the book filters
 *   B. the pipeline excludes trash from the list, the count and the FOLDER filter
 *      (the owner's "not by any filters"), while the duplicate-record marker
 *      counts live twins only
 *   C. the mirror retires a live loan that moves to trash, never inserts fresh
 *      trash, and brings a restored loan straight back
 *   D. the ClickUp link pass neither links nor holds on trash — a live loan whose
 *      only "duplicate" is trashed now links
 *   E. the archive: list, the structurally-guarded permanent delete (a live loan
 *      is undeletable), children going with it, and the schema guard that keeps
 *      the non-cascade child list honest
 *   F. every other reader carries the guard (source-held, so removing one fails)
 *   G. the officer picker lists linked AND unlinked officers, and the login
 *      filter narrows to that officer's files
 *
 * Mutation-proven (each reverted in a scratch copy; the suite went red):
 *   1. buildWhere without the trash guard          → B fails (trash listed)
 *   2. the mirror loop without the trash branch    → C fails (fresh trash inserted)
 *   3. deleteArchivedLoan without the trash WHERE  → E fails (live loan deleted)
 *   4. linkPass selection without the guard        → D fails (dup refusal returns)
 */

const assert = require('assert');

async function main() {
  await require(`${__dirname}/lib/db-gate`).skipUnlessDb('lt-trash');

  let checks = 0;
  const ok = (c, w) => { assert.ok(c, w); console.log('  ok  ', w); checks++; };
  const eq = (a, b, w) => { assert.strictEqual(a, b, w); console.log('  ok  ', w); checks++; };

  const trash = require('../src/longterm/trash');
  const book = require('../src/longterm/pipeline-book');
  const db = require('../src/longterm/db');
  const uuid = () => require('crypto').randomUUID();
  const stamp = 'trash' + Math.random().toString(36).slice(2, 8);

  console.log('A. the rule — one normalisation with the book filters');
  ok(trash.isTrashFolder('(Trash)'), 'the literal Encompass name is trash');
  ok(trash.isTrashFolder('  (trash)  '), 'case and spacing do not matter');
  ok(!trash.isTrashFolder('Pipeline') && !trash.isTrashFolder('Withdrawn files'),
    'a real folder is never trash');
  ok(!trash.isTrashFolder('') && !trash.isTrashFolder(null), 'no folder reads as LIVE, never trash');
  ok(trash.trashSql('l').startsWith(book.folderNormSql('l')),
    'the SQL half is built on the SAME normalisation the book filters compare with');
  ok(trash.notTrashSql('x').includes("<> '(trash)'"), 'and the guard is its negation');

  // ── fixtures ──────────────────────────────────────────────────────────────
  const L = {};
  const mk = async (name, { num, folder, milestone = 'Started', stage = 'new', amount = 100000 }) => {
    const id = uuid();
    await db.query(
      `INSERT INTO lt_loans (id, encompass_loan_guid, loan_number, loan_amount, milestone_name,
                             stage_key, loan_folder, program_name, term_months)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, 'Investor DSCR', 360)`,
      [id, `${stamp}-${name}`, num, amount, milestone, stage, folder]);
    L[name] = id;
    return id;
  };

  await mk('live1', { num: `${stamp}-1001`, folder: 'Pipeline' });
  await mk('live2', { num: `${stamp}-1002`, folder: 'Pipeline' });
  await mk('trash1', { num: `${stamp}-2001`, folder: '(Trash)' });
  // A LIVE duplicate pair — the YSCAP258134474 shape.
  await mk('dupA', { num: `${stamp}-3000`, folder: 'Corr Post Purchase', milestone: 'Purchasing Conditions', stage: 'post_closing' });
  await mk('dupB', { num: `${stamp}-3000`, folder: 'Pipeline' });
  // A live loan whose only twin is TRASHED — six of the seven real held numbers.
  await mk('halfA', { num: `${stamp}-4000`, folder: 'Pipeline' });
  await mk('halfT', { num: `${stamp}-4000`, folder: '(Trash)' });

  const allIds = () => Object.values(L);
  const cleanup = async () => {
    await db.query(`DELETE FROM lt_clickup_link_log WHERE lt_loan_id = ANY($1::uuid[])`, [allIds()]);
    await db.query(`DELETE FROM lt_milestone_events WHERE loan_id = ANY($1::uuid[])`, [allIds()]);
    await db.query(`DELETE FROM lt_loans WHERE encompass_loan_guid LIKE $1`, [`${stamp}-%`]);
    await db.query(`DELETE FROM staff_users WHERE email LIKE $1`, [`${stamp}%`]);
  };

  try {
    console.log('\nB. the pipeline: out of the list, out of the count, out of every filter');
    const pipeline = require('../src/longterm/pipeline');
    const seesAll = { seesAll: true, scope: 'all', ltRole: 'admin' };
    const run = async (filters = {}) => {
      const q = pipeline.buildPipelineQuery(seesAll, null, { search: stamp, ...filters }, { hideShortTerm: false });
      const { rows } = await db.query(q.sql, q.params);
      const { rows: c } = await db.query(q.countSql, q.params);
      return { rows, total: c[0].n };
    };
    const all = await run();
    ok(!all.rows.some((r) => r.loan_number === `${stamp}-2001`), 'the trash row is not in the list');
    ok(!all.rows.some((r) => String(r.loan_folder || '') === '(Trash)'), 'no listed row is in the trash at all');
    eq(all.total, 5, 'the count agrees with the list (5 live rows; 2 trash rows unseen)');
    const asFolder = await run({ folder: '(Trash)' });
    eq(asFolder.total, 0, 'filtering to the (Trash) folder finds NOTHING — the owner\'s "not by any filters"');

    const dupA = all.rows.find((r) => r.loan_number === `${stamp}-3000` && r.stage_key === 'post_closing');
    const dupB = all.rows.find((r) => r.loan_number === `${stamp}-3000` && r.stage_key === 'new');
    eq(Number(dupA.duplicate_records), 1, 'a LIVE duplicate pair marks each row (the real one…)');
    eq(Number(dupB.duplicate_records), 1, '…and the stale one)');
    const half = all.rows.find((r) => r.loan_number === `${stamp}-4000`);
    eq(Number(half.duplicate_records), 0, 'a twin already in the trash is NOT a duplicate any more');

    // The file screen's own lookup — the ONE definition the route calls.
    const dupsOfA = await trash.liveDuplicates(`${stamp}-3000`, L.dupA);
    eq(dupsOfA.length, 1, 'liveDuplicates finds the other live record…');
    eq(dupsOfA[0].id, L.dupB, '…and it is the right one');
    eq((await trash.liveDuplicates(`${stamp}-4000`, L.halfA)).length, 0,
      'and never a twin that is already deleted');

    console.log('\nC. the mirror: retire on move-to-trash, never insert fresh trash, restore comes back');
    const encPath = require.resolve('../src/longterm/encompass/client');
    const discPath = require.resolve('../src/longterm/sync/discover');
    const rosterPath = require.resolve('../src/longterm/people/roster');
    const realDisc = require(discPath);
    const fixture = { loans: [], pages: 1, truncated: false, classifyFields: 'answered' };
    require.cache[encPath] = { id: encPath, filename: encPath, loaded: true,
      exports: { configured: () => true, getLoan: async () => { throw new Error('no loan reads in this test'); } } };
    require.cache[discPath] = { id: discPath, filename: discPath, loaded: true,
      exports: { ...realDisc, discoverLoans: async () => fixture } };
    require.cache[rosterPath] = { id: rosterPath, filename: rosterPath, loaded: true,
      exports: { syncRoster: async () => ({ ok: true, proposedNow: 0, unmatched: 0 }) } };
    delete require.cache[require.resolve('../src/longterm/sync/loans')];
    const loans = require('../src/longterm/sync/loans');
    const row = (name, guid) => ({
      encompassLoanGuid: `${stamp}-${guid || name}`, loanNumber: null, loanFolder: 'Pipeline',
      loanAmount: 100000, borrowerName: null, milestoneName: 'Started',
      lastModified: new Date().toISOString(), programName: 'Investor DSCR', termMonths: 360,
    });

    fixture.loans = [
      { ...row('live1'), loanNumber: `${stamp}-1001`, loanFolder: '(Trash)' },   // live → trash
      { ...row('fresh-trash'), loanNumber: `${stamp}-5000`, loanFolder: '(Trash)' }, // brand-new trash
      { ...row('live2'), loanNumber: `${stamp}-1002`, lastModified: null },      // ordinary control
    ];
    const pass1 = await loans.syncOnce({ readBudget: 0 });
    ok(pass1.ok === true, 'the pass ran');
    eq(pass1.archivedTrash, 2, 'the two trash sightings are COUNTED, never silent');
    const folderOf = async (g) => {
      const { rows } = await db.query(`SELECT loan_folder FROM lt_loans WHERE encompass_loan_guid = $1`, [`${stamp}-${g}`]);
      return rows.length ? rows[0].loan_folder : null;
    };
    eq(await folderOf('live1'), '(Trash)', 'a live loan somebody deleted in Encompass is RETIRED into the archive');
    eq(await folderOf('fresh-trash'), null, 'a loan that was already trash when first seen is NEVER inserted');
    eq(await folderOf('live2'), 'Pipeline', 'the ordinary loan beside them mirrors exactly as before');

    // The restore: Encompass's trash can be undone there, and the loan walks back in.
    fixture.loans = [{ ...row('live1'), loanNumber: `${stamp}-1001`, loanFolder: 'Pipeline' }];
    const pass2 = await loans.syncOnce({ readBudget: 0 });
    ok(pass2.ok === true && pass2.archivedTrash === 0, 'the restore pass sees no trash');
    eq(await folderOf('live1'), 'Pipeline', 'a loan RESTORED from Encompass\'s trash comes straight back');
    // put live1 back in the trash for the archive section below
    await db.query(`UPDATE lt_loans SET loan_folder = '(Trash)' WHERE id = $1::uuid`, [L.live1]);

    console.log('\nD. the link pass: trash neither links nor holds');
    process.env.LT_CLICKUP_LINK_ENABLED = '1';
    const link = require('../src/longterm/clickup/link');
    const F = require('../src/clickup/fields');
    const card = (id, ys) => ({ id, custom_id: `CU-${id}`, url: `https://x/${id}`,
      custom_fields: [{ id: F.PIPELINE.ysLoanNumber, value: ys }] });
    const client = {
      configured: () => true,
      pipelineTasksPage: async (page) => (page === 0
        ? { tasks: [card(`${stamp}t1`, `${stamp}-4000`), card(`${stamp}t2`, `${stamp}-2001`)], last_page: true }
        : { tasks: [], last_page: true }),
    };
    const out = await link.linkPass({ client, stamp: { enabled: () => false } });
    ok(out.ok === true, 'the link pass ran');
    const linked = await db.query(`SELECT id, clickup_task_id FROM lt_loans WHERE id = $1::uuid`, [L.halfA]);
    eq(linked.rows[0].clickup_task_id, `${stamp}t1`,
      'the live loan LINKS — its trashed twin no longer reads as a duplicate Encompass record');
    const trashLinked = await db.query(`SELECT clickup_task_id FROM lt_loans WHERE id = $1::uuid`, [L.trash1]);
    eq(trashLinked.rows[0].clickup_task_id, null,
      'the card carrying a TRASHED loan\'s number links to nothing — a deleted loan never claims a card');

    // THE RETRY SWEEP, executed for real — inside a transaction that is rolled
    // back, so the stamps it would record on OTHER suites' leftover rows never
    // land. This is what makes the sql-prepared suite's COVERED_BY entry for
    // clickup/link.js an honest statement about BOTH of its assembled queries.
    {
      const txc = await db.getClient();
      try {
        await txc.query('BEGIN');
        const sweepStamp = { enabled: () => true, stampTask: async () => ({ ok: true, wrote: ['f'] }) };
        const out2 = await link.linkPass({ db: txc, client, stamp: sweepStamp });
        ok(out2.ok === true, 'the link pass with the stamper on runs the retry sweep against the real schema');
      } finally {
        await txc.query('ROLLBACK').catch(() => {});
        txc.release();
      }
    }

    // THE BORROWER AUTO-LINK's own selection, against the real schema — reads
    // live, writes stubbed, so nothing in the shared test database is confirmed
    // by a suite about the trash rule.
    process.env.LT_BORROWER_AUTOLINK_ENABLED = '1';
    const autolink = require('../src/longterm/borrower-autolink');
    const auto = await autolink.autoLinkPass({
      links: { loadLinks: async () => [], confirmLink: async () => ({ ok: true }) },
      loadSettings: async () => ({}),
    });
    ok(auto && auto.ok === true, 'autoLinkPass runs its live selection against the real schema');

    console.log('\nE. the archive: list, guarded delete, children, and the honest child list');
    const listed = await trash.listArchive();
    const mine = listed.filter((r) => String(r.encompass_loan_guid || '').startsWith(stamp));
    eq(mine.length, 3, 'the archive lists exactly this suite\'s three trash rows (live1, trash1, halfT)');

    const refused = await trash.deleteArchivedLoan(L.live2);
    eq(refused, null, 'a LIVE loan is structurally undeletable — whatever id is handed in');
    const still = await db.query(`SELECT 1 FROM lt_loans WHERE id = $1::uuid`, [L.live2]);
    eq(still.rows.length, 1, 'and the live row is untouched');

    // Children on the doomed row: a cascade child, and both non-cascade children.
    await db.query(`INSERT INTO lt_loan_contacts (id, loan_id, role, encompass_name)
                    VALUES ($1::uuid, $2::uuid, 'loan_officer', 'Someone')`, [uuid(), L.trash1]);
    await db.query(`INSERT INTO lt_clickup_link_log (id, lt_loan_id, action, reason)
                    VALUES ($1::uuid, $2::uuid, 'linked', 'test')`, [uuid(), L.trash1]);
    await db.query(`INSERT INTO lt_milestone_events (id, loan_id, event_type, to_milestone)
                    VALUES ($1::uuid, $2::uuid, 'observed_baseline', 'Started')`, [uuid(), L.trash1]);
    const gone = await trash.deleteArchivedLoan(L.trash1);
    ok(gone && gone.loan_number === `${stamp}-2001`, 'an archived loan deletes, and says which one it was');
    for (const [t, c] of [['lt_loans', 'id'], ['lt_loan_contacts', 'loan_id'],
      ['lt_clickup_link_log', 'lt_loan_id'], ['lt_milestone_events', 'loan_id']]) {
      const { rows } = await db.query(`SELECT 1 FROM ${t} WHERE ${c} = $1::uuid`, [L.trash1]);
      eq(rows.length, 0, `…and nothing is left behind in ${t}`);
    }
    eq(await trash.deleteArchivedLoan(L.trash1), null, 'deleting it again is a clean "not there"');

    // THE HONEST CHILD LIST: every lt_* table keyed on a loan either cascades off
    // lt_loans or is named in NON_CASCADE_CHILD_TABLES. A table added later with
    // neither fails HERE, which is what lets the runtime skip the catalog read the
    // separation gate refuses.
    const { rows: kids } = await db.query(
      `SELECT c.table_name, c.column_name,
              EXISTS (SELECT 1
                 FROM information_schema.table_constraints tc
                 JOIN information_schema.key_column_usage kcu
                   ON kcu.constraint_name = tc.constraint_name AND kcu.table_name = tc.table_name
                 JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
                 JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
                WHERE tc.table_name = c.table_name AND tc.constraint_type = 'FOREIGN KEY'
                  AND kcu.column_name = c.column_name AND ccu.table_name = 'lt_loans'
                  AND rc.delete_rule = 'CASCADE') AS cascades
         FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.table_name LIKE 'lt\\_%'
          AND c.table_name <> 'lt_loans' AND c.column_name IN ('loan_id', 'lt_loan_id')`);
    const namedNonCascade = new Set(trash.NON_CASCADE_CHILD_TABLES.map((t) => `${t.table}.${t.column}`));
    const orphanable = kids.filter((k) => !k.cascades && !namedNonCascade.has(`${k.table_name}.${k.column_name}`));
    eq(orphanable.length, 0,
      `every loan-keyed lt_* table either cascades or is on the archive's own delete list${
        orphanable.length ? ` — MISSING: ${orphanable.map((k) => k.table_name).join(', ')}` : ''}`);
    for (const t of trash.NON_CASCADE_CHILD_TABLES) {
      ok(kids.some((k) => k.table_name === t.table && k.column_name === t.column && !k.cascades),
        `${t.table} genuinely has no cascade — the explicit delete is needed, not decoration`);
    }

    console.log('\nF. every other reader carries the guard (source-held)');
    const fs = require('fs');
    const readsGuard = [
      ['src/longterm/pipeline.js', 3],              // buildWhere + dup subselect + officers list
      ['src/longterm/clickup/link.js', 2],          // selection + retry sweep
      ['src/longterm/borrower-autolink.js', 1],
      ['src/longterm/borrower-links.js', 1],        // the two-names identity guard
      ['src/longterm/routes/my-loans.js', 1],       // the borrower's own list
      ['src/longterm/routes/borrowers.js', 1],      // the match screen
      ['src/longterm/conditions/sync.js', 1],       // the condition sweep
    ];
    for (const [file, min] of readsGuard) {
      const src = fs.readFileSync(file, 'utf8');
      const n = (src.match(/notTrashSql\(/g) || []).length;
      ok(n >= min, `${file} composes the trash guard (${n} use${n === 1 ? '' : 's'}, needs ≥${min})`);
    }
    const archiveRoute = fs.readFileSync('src/longterm/routes/archive.js', 'utf8');
    ok(/requireSuperAdmin/.test(archiveRoute)
      && /router\.delete\('\/:id', requireArchiveAdmin, requireSuperAdmin/.test(archiveRoute)
      && /router\.post\('\/delete-all', requireArchiveAdmin, requireSuperAdmin/.test(archiveRoute),
    'both permanent-delete doors sit behind the super-admin gate');
    ok(/router\.use\('\/archive', require\('\.\/routes\/archive'\)\)/.test(
      fs.readFileSync('src/longterm/index.js', 'utf8')), 'the archive router is mounted');
    const detail = fs.readFileSync('src/longterm/routes/pipeline.js', 'utf8');
    ok(/duplicates,/.test(detail) && /liveDuplicates\(rows\[0\]\.loan_number, rows\[0\]\.id\)/.test(detail),
      'the file screen is HANDED its duplicate records — the banner has data to draw');

    console.log('\nG. the officer picker: linked AND unlinked, and the login filter narrows');
    const staffId = uuid();
    await db.query(`INSERT INTO staff_users (id, email, full_name, role, is_active)
                    VALUES ($1::uuid, $2, 'Linked Officer', 'loan_officer', true)`,
    [staffId, `${stamp}.lo@example.test`]);
    await db.query(`INSERT INTO lt_loan_contacts (id, loan_id, role, encompass_name, encompass_login_id, staff_id)
                    VALUES ($1::uuid, $2::uuid, 'loan_officer', 'Linked Officer', $3, $4::uuid)`,
    [uuid(), L.live2, `${stamp}lo1`, staffId]);
    await db.query(`INSERT INTO lt_loan_contacts (id, loan_id, role, encompass_name, encompass_login_id)
                    VALUES ($1::uuid, $2::uuid, 'loan_officer', 'Yehuda Unlinked', $3)`,
    [uuid(), L.dupA, `${stamp}lo2`]);
    // …and an officer whose ONLY file is in the trash — must not be offered.
    await db.query(`INSERT INTO lt_loan_contacts (id, loan_id, role, encompass_name, encompass_login_id)
                    VALUES ($1::uuid, $2::uuid, 'loan_officer', 'Trash Only', $3)`,
    [uuid(), L.halfT, `${stamp}lo3`]);

    const loaded = await pipeline.loadPipeline({ id: staffId, role: 'super_admin' }, { search: stamp, limit: 1000 });
    const officers = loaded.officers || [];
    const mineOfficers = officers.filter((o) => String(o.full_name || '').includes('Officer')
      || String(o.login_id || '').startsWith(stamp) || String(o.full_name || '').includes('Yehuda Unlinked')
      || String(o.full_name || '').includes('Trash Only'));
    ok(mineOfficers.some((o) => o.linked === true && o.staff_id === staffId),
      'the linked officer is offered by their PILOT identity');
    ok(mineOfficers.some((o) => o.linked === false && o.login_id === `${stamp}lo2`
      && o.full_name === 'Yehuda Unlinked'),
    'the UNLINKED officer is offered too, by their Encompass login — the name on the rows is pickable');
    ok(!mineOfficers.some((o) => o.login_id === `${stamp}lo3` || o.full_name === 'Trash Only'),
      'an officer whose only file is deleted is not offered');

    const byLogin = pipeline.buildPipelineQuery(seesAll, null,
      { search: stamp, officerLoginId: `${stamp}lo2` }, { hideShortTerm: false });
    const { rows: narrowed } = await db.query(byLogin.sql, byLogin.params);
    eq(narrowed.length, 1, 'filtering by the unlinked officer\'s login narrows to their file');
    eq(narrowed[0].id, L.dupA, '…and it is the right file');

    ok(loaded.archiveCount >= 2, 'the pipeline hands a sees-all viewer the archive total');
    eq(loaded.viewerLinked, false,
      'and says this viewer\'s own login is not linked — the reason "My files" reads empty');
  } finally {
    await cleanup();
  }
  console.log(`\nall passed (${checks})`);
  process.exit(0);
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
