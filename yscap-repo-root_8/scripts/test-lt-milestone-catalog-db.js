'use strict';
/**
 * LT test — the milestone catalog, read from the tenant instead of frozen.
 *
 * The catalog decides how the file screen draws progress, and it marks progress
 * POSITIONALLY: a loan sitting at a milestone the catalog does not carry leaves
 * the current position at -1 and marks NOTHING reached, so the bar goes blank
 * rather than slightly wrong. That is what makes a frozen catalog expensive, and
 * it is why every question below is about what happens when the read goes WRONG —
 * an empty answer, a failed detail call, a milestone that disappeared — rather
 * than about the happy path, which is the easy half.
 *
 * Encompass is stubbed: no network, no credentials. The DATABASE is real, because
 * the whole point is which columns survive a partial read.
 */

const path = require('path');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

async function main() {
  await require(path.join(__dirname, 'lib', 'db-gate')).skipUnlessDb('lt-milestone-catalog');

  const db = require('../src/longterm/db');
  const catalog = require('../src/longterm/sync/milestone-catalog');

  // Our own milestones, out of the way of the seeded nineteen.
  const A = 'test-ms-a';
  const B = 'test-ms-b';
  const GONE = 'test-ms-gone';
  const ids = [A, B, GONE];

  const stub = (list, details, opts = {}) => {
    const calls = [];
    return {
      calls,
      async getMilestoneSettings(o) { calls.push(`list:${o && o.includeArchived}`); return { items: list }; },
      async getMilestoneSetting(id) {
        calls.push(`detail:${id}`);
        if (opts.detailThrows) throw new Error('detail read refused');
        return details[id] || {};
      },
    };
  };

  const LIST = [
    { id: A, name: 'Our First Step', tpoStatus: 'Started', consumerStatus: 'Getting going', isArchived: false },
    { id: B, name: 'Our Second Step', tpoStatus: 'Working', consumerStatus: 'In progress', isArchived: false },
  ];
  const DETAILS = {
    [A]: { role: { entityId: '5', entityName: 'Loan Processor' }, assignMemberToRoleRequired: true, daysToFinish: 3 },
    [B]: { role: { entityId: '9', entityName: 'Closer' }, assignMemberToRoleRequired: false, daysToFinish: 7 },
  };

  const rowOf = async (id) => (await db.query(
    'SELECT * FROM lt_encompass_milestones WHERE milestone_id = $1', [id])).rows[0] || null;

  // The seeded nineteen are the tenant's real catalog in this database, and the
  // archive rule below is SUPPOSED to retire anything a read did not list — so
  // they are put back exactly as found rather than left archived for whatever
  // runs next.
  const seeded = (await db.query(
    'SELECT milestone_id, is_archived FROM lt_encompass_milestones WHERE NOT (milestone_id = ANY($1::text[]))',
    [ids])).rows;

  try {
    await db.query('DELETE FROM lt_encompass_milestones WHERE milestone_id = ANY($1::text[])', [ids]);

    console.log('a live read fills the catalog');

    const client = stub(LIST, DETAILS);
    const out = await catalog.refreshOnce({ db, client, force: true });
    check(out.ok === true && out.read === 2 && out.written === 2,
      'both milestones are read and written');
    check(client.calls[0] === 'list:true',
      'THE ARCHIVED ONES ARE ASKED FOR — reading only the live ones would make "archived in Encompass" and "gone from Encompass" look identical, and those two are treated differently');
    check(client.calls.includes(`detail:${A}`) && client.calls.includes(`detail:${B}`),
      '…and each milestone\'s own settings are read, because the list answer carries no role, no day count and no assignment rule');

    const a = await rowOf(A);
    check(a && a.milestone_name === 'Our First Step' && a.tpo_status === 'Started'
      && a.consumer_status === 'Getting going',
      'the name and both statuses land');
    check(a.role === 'Loan Processor' && a.role_id === '5'
      && a.assignment_required === true && Number(a.expected_days) === 3,
      '…and the role, the assignment rule and the expected days come from the detail read');
    check(Number(a.sequence) === 1 && Number((await rowOf(B)).sequence) === 2,
      'the pipeline ORDER is the list\'s own order — Encompass offers no order field, so this is the one inference in the module and it is stated rather than buried');
    check(a.catalog_source === 'live' && a.catalog_synced_at,
      'and the row says it came from a live read and when — a catalog nobody has ever confirmed is a different fact from one confirmed this morning');

    console.log('\nthe read going wrong never costs us the catalog');

    // A pass that cannot read the details must not blank what it cannot see.
    const blind = stub(LIST, {}, { detailThrows: true });
    const partial = await catalog.refreshOnce({ db, client: blind, force: true });
    check(partial.ok === true && partial.detailFailures === 2,
      'a pass whose detail reads all failed says so rather than reporting a clean run');
    const afterBlind = await rowOf(A);
    check(afterBlind.role === 'Loan Processor' && Number(afterBlind.expected_days) === 3
      && afterBlind.assignment_required === true,
      'THE ONE THAT MATTERS: the role, the days and the assignment rule are UNTOUCHED — a read that could not see them must never write nulls over a catalog that was right');
    check(afterBlind.milestone_name === 'Our First Step',
      '…while the name and position, which the list DID carry, still landed');

    // An empty answer is an outage, not a tenant that retired every step it has.
    await db.query(
      `INSERT INTO lt_encompass_milestones
         (milestone_id, sequence, milestone_name, assignment_required, expected_days,
          tpo_status, consumer_status, is_archived)
       VALUES ($1, 98, 'A Step That Went Away', false, 0, 'x', 'y', false)
       ON CONFLICT (milestone_id) DO UPDATE SET is_archived = false`, [GONE]);

    const emptyOut = await catalog.refreshOnce({ db, client: stub([], {}), force: true });
    check(emptyOut.ok === false && /no milestones/i.test(emptyOut.reason),
      'an EMPTY answer fails loudly and changes nothing — an outage is not evidence that a tenant retired every step it has');
    check((await rowOf(GONE)).is_archived === false,
      '…so nothing was archived by it');

    console.log('\na milestone that disappears is archived, never deleted');

    const out2 = await catalog.refreshOnce({ db, client: stub(LIST, DETAILS), force: true });
    check(out2.archived >= 1, 'the milestone Encompass no longer lists is archived');
    const gone = await rowOf(GONE);
    check(gone && gone.is_archived === true,
      'THE ONE THAT MATTERS: it is still there, archived — loans passed through that step and a retired one still has to explain them');
    check(gone.milestone_name === 'A Step That Went Away',
      '…with its name intact, so a file sitting at it still reads as something rather than as a blank');

    // An archived milestone that comes BACK is live again.
    const backList = [...LIST, { id: GONE, name: 'A Step That Went Away', tpoStatus: 'x', consumerStatus: 'y', isArchived: false }];
    await catalog.refreshOnce({ db, client: stub(backList, DETAILS), force: true });
    check((await rowOf(GONE)).is_archived === false,
      'and a step a buyer brings back is live again — the archive is a state, not a grave');

    // Encompass's own archived flag is honoured as archived, not as gone.
    const archivedThere = [LIST[0], { ...LIST[1], isArchived: true }];
    await catalog.refreshOnce({ db, client: stub(archivedThere, DETAILS), force: true });
    check((await rowOf(B)).is_archived === true,
      'a milestone Encompass itself calls archived is recorded as archived');

    console.log('\nit does not spend twenty calls for nothing');

    const cheap = stub(LIST, DETAILS);
    const skipped = await catalog.refreshOnce({ db, client: cheap, maxAgeHours: 24 });
    check(skipped.ok === true && skipped.skipped === true && cheap.calls.length === 0,
      'a catalog confirmed minutes ago is left alone and NOTHING is called — nineteen milestones is twenty reads against a budget shared with every other integration, and the catalog changes about never');
    const forced = stub(LIST, DETAILS);
    await catalog.refreshOnce({ db, client: forced, maxAgeHours: 0 });
    check(forced.calls.length > 0,
      '…and an age of zero means "ask now", which is what pressing the button by hand means');

    console.log('\nthe pass is wired to something');

    const worker = require('fs').readFileSync(path.join(__dirname, '..', 'src/longterm/sync/worker.js'), 'utf8');
    check(/milestoneCatalog\.refreshOnce/.test(worker),
      'the pass that runs on its own calls it — a refresher nothing ever calls is the same failure as the frozen catalog it replaces');
    const route = require('fs').readFileSync(path.join(__dirname, '..', 'src/longterm/routes/sync.js'), 'utf8');
    check(/milestoneCatalogSync\.refreshOnce/.test(route),
      '…and so does the button, so somebody who has just changed a milestone in Encompass can pull it in without waiting');

    console.log('\nthe screen can tell a confirmed catalog from a shipped one');

    const route2 = require('fs').readFileSync(path.join(__dirname, '..', 'src/longterm/routes/sync.js'), 'utf8');
    check(/catalog_source = 'live'/.test(route2) && /milestoneCatalog: cat\[0\]/.test(route2),
      'the sync screen is told how many steps a real read has confirmed and when — a catalog nobody has ever checked is still the list PILOT shipped with, which is worth knowing before somebody wonders why a new step is missing');
    const syncUi = require('fs').readFileSync(path.join(__dirname, '..', 'app-v2/src/longterm/LtSync.jsx'), 'utf8');
    check(/milestoneCatalog\.live_steps/.test(syncUi) && /list PILOT shipped with/.test(syncUi),
      '…and it SAYS so in words when nothing has been confirmed, rather than showing a confident zero');

    console.log('\na first page is not the whole catalog');

    // A tenant with more milestones than one page would hand us a first page, and
    // archiving everything absent from it would retire most of their catalog.
    const bigList = Array.from({ length: catalog._internals.PAGE_SIZE }, (_, i) => ({
      id: `test-ms-page-${i}`, name: `Step ${i}`, tpoStatus: 'x', consumerStatus: 'y', isArchived: false,
    }));
    const pageIds = bigList.map((x) => x.id);
    try {
      const full = await catalog.refreshOnce({ db, client: stub(bigList, {}), force: true });
      check(full.ok === true && full.archived === 0 && /full page/i.test(full.reason || ''),
        'THE ONE THAT MATTERS: a read that filled its page archives NOTHING and says why — a milestone missing from a first page is not a milestone that is gone');
      check((await rowOf(A)).is_archived === false,
        '…so a real milestone absent from that page keeps its place');
    } finally {
      await db.query('DELETE FROM lt_encompass_milestones WHERE milestone_id = ANY($1::text[])', [pageIds]).catch(() => {});
    }
  } finally {
    await db.query('DELETE FROM lt_encompass_milestones WHERE milestone_id = ANY($1::text[])', [ids]).catch(() => {});
    for (const r of seeded) {
      await db.query('UPDATE lt_encompass_milestones SET is_archived = $2 WHERE milestone_id = $1',
        [r.milestone_id, r.is_archived]).catch(() => {});
    }
    await db.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
