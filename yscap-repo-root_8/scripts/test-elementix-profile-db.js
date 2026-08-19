'use strict';
/**
 * scripts/test-elementix-profile-db.js — the mega profile, for real.
 *
 * REAL POSTGRES, STUBBED VENDOR. The database half is where this can be wrong
 * in ways no pure test can see (a phantom column, a section row written twice
 * for one source, a merge that double-counts). The VENDOR is stubbed because a
 * unit test must never call Elementix: every call spends a slot of the office's
 * shared 1,000-an-hour allowance, and this suite runs on every push.
 *
 * THE STUB PREFLIGHTS EVERY REQUEST against the real transcribed contract. That
 * is the point of it: the person detail tools take `id` while the contact tools
 * take `personId`, and a request sent with the wrong key does not merely fail —
 * it fails AFTER spending a slot. If profile.js ever sends a malformed request,
 * this suite goes red instead of the owner's allowance going down.
 *
 * DB-gated like the rest of the suite: no DATABASE_URL, no run.
 */

const assert = require('assert');

if (!process.env.DATABASE_URL) {
  console.log('· test-elementix-profile-db: no DATABASE_URL — skipped');
  process.exit(0);
}

const db = require('../src/db');
const crmTools = require('../src/lib/elementix/crm-tools');
const lookups = require('../src/lib/elementix/lookups');

const PID_NJ = '33333333-3333-4333-8333-333333333333';
const PID_FL = '44444444-4444-4444-8444-444444444444';
const PID_XX = '55555555-5555-4555-8555-555555555555';

// ---------------------------------------------------------------------------
// The vendor, as it really answers. Every envelope below was CAPTURED LIVE on
// 2026-08-18 from person MOTY BRISK / NJ — the same person in the owner's own
// screenshots — so the shapes here are transcribed, not imagined.
// ---------------------------------------------------------------------------
const OVERVIEW_NJ = {
  person: {
    id: PID_NJ, name: 'MOTY BRISK', state: 'NJ',
    mortgageCount: 349, deedCount: 602, satisfactionCount: 0,
    ownershipCount: 222, ownershipRecordCount: 829, preforeclosureCount: 3,
    aliasCount: 2, linkedMortgageCount3Mo: 5, linkedMortgageCount6Mo: 6, linkedMortgageCount12Mo: 24,
    currentExposure: '197839792.86',
    firstAnyLenderDate: '2015-06-08', firstBankDate: '2016-02-10',
    nameCommonnessScore: 0,
  },
};
const OVERVIEW_FL = {
  person: {
    id: PID_FL, name: 'MOTY BRISK', state: 'FL',
    mortgageCount: 1, deedCount: 2, satisfactionCount: 0,
    ownershipCount: 1, ownershipRecordCount: 2, preforeclosureCount: 0,
    currentExposure: '250000.00', nameCommonnessScore: 0,
  },
};
const LENDERS_NJ = {
  person: { id: PID_NJ, name: 'MOTY BRISK' },
  // THE ROWS ARE UNDER `lenderConnections`, not `data` — the key the shared
  // reader does not know. This fixture is the regression guard for it.
  lenderConnections: [
    { id: 'aaaa0000-0000-4000-8000-000000000001', name: 'CoreVest Finance', lenderType: 'Private Money', totalVolume: 284072090, mortgageCount: 39,
      // ~9 KB of base64 JPEG the vendor embeds on EVERY lender row. Seventy of
      // these would put the better part of a megabyte of pictures in one jsonb
      // row, and nothing on the screen uses them.
      _logoDataUri: 'data:image/jpeg;base64,' + 'A'.repeat(9000) },
    { id: 'aaaa0000-0000-4000-8000-000000000002', name: 'Roc Capital / Roc360', lenderType: 'Private Money', totalVolume: 27208850, mortgageCount: 47 },
  ],
};

let passed = 0;
const ok = (m) => { passed += 1; console.log(`  ✓ ${m}`); };

// ---------------------------------------------------------------------------
// The stub
// ---------------------------------------------------------------------------
const calls = [];
const fail = new Set();          // "tool" or "tool:foreclosures" keys that must fail
let deedsAlwaysMore = false;     // make the deed pages never end
let extraDeedRows = {};          // per person id, rows to append

crmTools.call = async (tool, args, opts) => {
  // 1. The preflight the real door runs. A malformed request must never leave.
  const problem = lookups._internals.contractProblem(tool, args);
  assert.strictEqual(problem, null, `profile.js sent a request the vendor would refuse: ${problem}`);
  // 2. Every CRM-plane call names the officer who made it.
  assert.ok(opts && opts.staffId, `${tool} was called with no staffId`);
  calls.push({ tool, args, opts });

  const id = args.id;
  const isForeclosure = args.hasForeclosure === true;
  const key = isForeclosure ? `${tool}:foreclosure` : tool;
  if (fail.has(key)) return { ok: false, reason: 'vendor_error', detail: 'Elementix could not answer that.' };

  switch (tool) {
    case 'get_person':
      return { ok: true, data: id === PID_FL ? OVERVIEW_FL : OVERVIEW_NJ };
    case 'get_person_lender_network':
      return { ok: true, data: LENDERS_NJ };
    case 'list_people':
      return { ok: true, data: { data: [
        // The vendor pads some filtered lists with unrelated rows; this proves
        // we take only the person we asked for.
        { id: '00000050-0000-4000-8000-000000000000', name: 'A STRANGER', personState: 'IA' },
        { id: args.personIds[0], name: 'MOTY BRISK', personState: 'NJ',
          mailingAddress: '7 GLENWOOD AVE #418, EAST ORANGE, NJ 07017',
          previousExits3y: 80, yearsActive: 11, firstLoanDate: '2015-02-11',
          loanCount: 5, totalVolume: 1400550, averageLoanSize: 280110,
          shortTermLoanPct: 40, longTermLoanPct: 0,
          mostFrequentMortgageCity: 'SOMERDALE', mostFrequentMortgageCounty: 'Camden County',
          isAttorneyOrTitleAgent: false, isLikelySupportStaff: false,
          unlockedBy: 'yosef@yscapgroup.com', unlockedAt: '2026-06-10T12:00:00.000Z',
          entities: [{ id: 'e1', name: 'JC SWB EQUITIES ONE LLC', state: 'NJ' }],
          topLenders: [{ id: 'l1', name: 'CoreVest Finance', _logoDataUri: 'data:image/jpeg;base64,' + 'A'.repeat(9000) }] },
      ] } };
    case 'get_person_entities':
      if (args.scope === 'count') return { ok: true, data: { totalCount: 295 } };
      return { ok: true, data: { data: [{ id: 'e0000000-0000-4000-8000-000000000001', name: 'JC SWB EQUITIES ONE LLC', state: 'NJ' }] } };
    case 'get_person_cross_state':
      return { ok: true, data: { data: id === PID_NJ ? [{ id: PID_FL, name: 'MOTY BRISK', state: 'FL', transactionCount: 3 }] : [] } };
    case 'get_person_associated_people':
      return { ok: true, data: { data: [{ id: 'p0000000-0000-4000-8000-000000000001'.replace('p', 'b'), name: 'HIRSCH EISSENBERG', sharedTotalCount: 551 }] } };
    case 'get_person_properties':
      return { ok: true, data: { data: [{ id: `prop-${id}-1` }] } };
    case 'get_person_mortgages':
      if (isForeclosure) return { ok: true, data: { data: [{ id: `fc-${id}-1` }] } };
      return { ok: true, data: { data: [{ id: `mtg-${id}-1` }] } };
    case 'get_person_deeds': {
      if (args.scope === 'count') return { ok: true, data: { totalCount: deedsAlwaysMore ? 9999 : 1 } };
      // A REAL vendor page: when there is more, the page comes back FULL. That
      // matters — `nextPage` alone means "ask again", not "there is more" (it is
      // emitted on any full page, even the last), so a stub returning one row
      // plus nextPage tests a signal the vendor never actually sends.
      const rows = deedsAlwaysMore
        ? Array.from({ length: args.perPage }, (_, i) => ({ id: `deed-${id}-p${args.page}-${i}` }))
        : [{ id: `deed-${id}-p${args.page}` }, ...(extraDeedRows[id] || [])];
      return { ok: true, data: { data: rows, ...(deedsAlwaysMore ? { nextPage: args.page + 1 } : {}) } };
    }
    default:
      return { ok: false, reason: 'not_stubbed', detail: tool };
  }
};

const profile = require('../src/lib/elementix/profile');

async function staff(name, email) {
  const r = await db.query(
    `INSERT INTO staff_users (email, full_name, role) VALUES ($1::citext,$2,'loan_officer') RETURNING id`,
    [email, name]);
  return r.rows[0].id;
}
const wipe = async () => {
  const ids = [PID_NJ, PID_FL, PID_XX];
  await db.query(`DELETE FROM elementix_person_sections WHERE person_id = ANY($1)`, [ids]);
  await db.query(`DELETE FROM elementix_person_aliases WHERE person_id = ANY($1) OR alias_person_id = ANY($1)`, [ids]);
  await db.query(`UPDATE elementix_persons SET primary_person_id = NULL WHERE person_id = ANY($1)`, [ids]);
  await db.query(`DELETE FROM elementix_persons WHERE person_id = ANY($1)`, [ids]);
};

async function main() {
  console.log('\nELEMENTIX MEGA PROFILE — build, merge, and never a confident zero\n');
  await wipe();
  const officer = await staff('Profile Officer', `elxprof.${Date.now()}@yscapgroup.com`);

  // -------------------------------------------------------------------------
  console.log('1. It refuses what it must, and writes nothing');
  // -------------------------------------------------------------------------
  let r = await profile.buildProfile(PID_NJ, {});
  assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'no_actor');
  ok('a build with nobody behind it is refused — a profile is a deliberate click');

  r = await profile.buildProfile('not-a-uuid', { staffId: officer });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'bad_args');
  ok('a person id that never came from a search result is refused');

  let n = await db.query(`SELECT count(*)::int c FROM elementix_person_sections WHERE person_id = $1`, [PID_NJ]);
  assert.strictEqual(n.rows[0].c, 0);
  assert.strictEqual(calls.length, 0, 'a refusal must not reach the vendor');
  ok('neither refusal spent a single call or wrote a single row');

  // -------------------------------------------------------------------------
  console.log('\n2. A full build');
  // -------------------------------------------------------------------------
  r = await profile.buildProfile(PID_NJ, { staffId: officer });
  assert.strictEqual(r.ok, true);
  const built = r.sections.filter((s) => s.status === 'ok').map((s) => s.section).sort();
  assert.deepStrictEqual(built, ['associated_people', 'cross_state', 'deeds', 'entities', 'foreclosures', 'lender_network', 'mortgages', 'overview', 'properties']);
  ok('every available section was fetched and stored');

  const secs = await db.query(
    `SELECT section, state, row_count, truncated, last_error, calls_spent FROM elementix_person_sections WHERE person_id = $1 ORDER BY section`, [PID_NJ]);
  assert.strictEqual(secs.rows.length, 9);
  assert.ok(secs.rows.every((x) => x.state === ''), 'a section row is keyed on the person, never on a state');
  ok('one row per section per person — and the state column stays empty on purpose');

  // THE REGRESSION THAT MATTERS.
  const lenders = secs.rows.find((x) => x.section === 'lender_network');
  assert.strictEqual(lenders.row_count, 2);
  ok('the lenders came out of `lenderConnections` — the shared reader would have said zero');

  const p = await db.query(`SELECT display_name, primary_state, states, refreshed_at, refreshed_by FROM elementix_persons WHERE person_id = $1`, [PID_NJ]);
  assert.strictEqual(p.rows[0].display_name, 'MOTY BRISK');
  assert.strictEqual(p.rows[0].primary_state, 'NJ');
  assert.deepStrictEqual(p.rows[0].states, ['NJ']);
  assert.strictEqual(p.rows[0].refreshed_by, officer);
  ok('the overview taught us the person’s name and state, and who refreshed it');

  const fcCall = calls.find((c) => c.tool === 'get_person_mortgages' && c.args.hasForeclosure === true);
  assert.ok(fcCall, 'foreclosures must be asked for on the person’s own mortgages');
  assert.ok(!calls.some((c) => c.tool === 'list_transactions'), 'the name-matched transaction feed is never used for a person');
  ok('foreclosures come from the person’s own id, never from a name search');

  // -------------------------------------------------------------------------
  console.log('\n3. Reading it back');
  // -------------------------------------------------------------------------
  let v = await profile.readProfile(PID_NJ);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.summary.counts.mortgages, 349);
  assert.strictEqual(v.summary.counts.deeds, 602);
  assert.strictEqual(v.summary.counts.properties, 829);
  assert.strictEqual(v.summary.counts.foreclosures, 3);
  assert.strictEqual(v.summary.counts.entities, 295);
  assert.strictEqual(v.summary.exposure, 197839792.86);
  assert.strictEqual(v.summary.complete, true);
  ok('the headline numbers are the vendor’s own roll-up — 349 / 602 / 829 / 3 / 295 and $197,839,792.86');

  assert.strictEqual(v.sections.lender_network.rows.length, 2);
  assert.ok(!JSON.stringify(v.sections.lender_network.rows).includes('_logoDataUri'),
    'the vendor’s inline logo images are dropped before anything is stored');
  const stored = await db.query(
    `SELECT length(payload::text) AS n FROM elementix_person_sections WHERE person_id = $1 AND section = 'lender_network'`, [PID_NJ]);
  assert.ok(Number(stored.rows[0].n) < 4000, `the stored section stays small (${stored.rows[0].n} bytes)`);
  ok('the vendor’s embedded logo images never reach the database');

  const ov = v.summary.byState.find((b) => b.personId === PID_NJ);
  assert.strictEqual(ov.facts.mailingAddress, '7 GLENWOOD AVE #418, EAST ORANGE, NJ 07017');
  assert.strictEqual(ov.facts.previousExits3y, 80);
  assert.strictEqual(ov.facts.yearsActive, 11);
  assert.strictEqual(ov.facts.unlockedBy, 'yosef@yscapgroup.com');
  ok('the header carries their mailing address, their track record and who looked them up');
  assert.strictEqual(v.sections.mortgages.status, 'ok');
  assert.strictEqual(v.sections.transactions.status, 'unavailable');
  assert.ok(v.sections.transactions.detail.length > 20);
  ok('the one tab we cannot key on a person says so, in words, instead of showing an empty list');

  assert.strictEqual(v.family.length, 1);
  const cand = await profile.openAliasCandidates(PID_NJ);
  assert.strictEqual(cand.length, 1);
  assert.strictEqual(cand[0].personId, PID_FL);
  ok('the Florida record was recorded as a CANDIDATE and did not join the profile on its own');

  // -------------------------------------------------------------------------
  console.log('\n4. Nothing is capped silently');
  // -------------------------------------------------------------------------
  deedsAlwaysMore = true;
  r = await profile.buildProfile(PID_NJ, { staffId: officer, force: true, sections: ['deeds'] });
  const deedRes = r.sections.find((s) => s.section === 'deeds');
  assert.strictEqual(deedRes.truncated, true);
  assert.strictEqual(deedRes.rows, profile._internals.MAX_PAGES * profile._internals.PAGE_SIZE);
  v = await profile.readProfile(PID_NJ);
  assert.strictEqual(v.sections.deeds.truncated, true);
  assert.strictEqual(v.sections.deeds.total, 9999,
    'and the count call turned "showing the first N" into "of 9,999"');
  ok('a list longer than we fetched is marked truncated AND sized, not quietly short');

  // The other half of the same rule: a section whose LAST page came back full
  // but which really is complete must NOT be called truncated.
  deedsAlwaysMore = false;
  r = await profile.buildProfile(PID_NJ, { staffId: officer, force: true, sections: ['deeds'] });
  assert.strictEqual(r.sections.find((s) => s.section === 'deeds').truncated, false);
  ok('and a complete list is never reported as truncated just because a page was full');
  deedsAlwaysMore = false;

  // `force` so nothing is served from cache — otherwise there is no spending
  // for a budget to run out of and the assertion below would pass vacuously.
  const before = calls.length;
  r = await profile.buildProfile(PID_NJ, { staffId: officer, callBudget: 2, force: true });
  const skipped = r.sections.filter((s) => s.status === 'skipped' && s.reason === 'budget');
  assert.ok(skipped.length >= 1, 'running out of allowance must be reported');
  assert.ok(calls.length - before <= 2, 'the budget is a real ceiling');
  assert.ok(skipped[0].detail.includes('Refresh'), 'and it must tell the reader what to do about it');
  ok('an exhausted allowance stops the build and says so — never a silent short profile');

  // -------------------------------------------------------------------------
  console.log('\n5. A refusal is not a zero');
  // -------------------------------------------------------------------------
  fail.add('get_person_mortgages');
  r = await profile.buildProfile(PID_NJ, { staffId: officer, force: true, sections: ['mortgages', 'foreclosures'] });
  assert.strictEqual(r.sections.find((s) => s.section === 'mortgages').status, 'error');
  assert.strictEqual(r.sections.find((s) => s.section === 'foreclosures').status, 'ok',
    'the foreclosure filter is a different question and must not be dragged down with it');
  v = await profile.readProfile(PID_NJ);
  assert.strictEqual(v.sections.mortgages.status, 'error');
  assert.strictEqual(v.sections.mortgages.rows.length, 0);
  assert.ok(v.sections.mortgages.detail, 'and it has to say WHY, on the screen');
  ok('a section the vendor refused reads as an error — never as "this person has no mortgages"');

  const perr = await db.query(`SELECT last_error FROM elementix_persons WHERE person_id = $1`, [PID_NJ]);
  assert.ok(perr.rows[0].last_error);
  ok('the profile header records the last failure too, so a stale profile can explain itself');
  fail.delete('get_person_mortgages');

  // A never-fetched section is a THIRD answer, distinct from both.
  await db.query(`DELETE FROM elementix_person_sections WHERE person_id = $1 AND section = 'mortgages'`, [PID_NJ]);
  v = await profile.readProfile(PID_NJ);
  assert.strictEqual(v.sections.mortgages.status, 'not_loaded');
  ok('"we have not read this yet" is its own answer, not an empty list either');

  // -------------------------------------------------------------------------
  console.log('\n6. A fresh section is not re-bought');
  // -------------------------------------------------------------------------
  const beforeFresh = calls.length;
  r = await profile.buildProfile(PID_NJ, { staffId: officer, sections: ['overview'] });
  assert.strictEqual(r.sections[0].status, 'cached');
  assert.strictEqual(calls.length, beforeFresh, 'a cached section must not touch the vendor');
  ok('re-opening a screen inside the freshness window spends nothing');

  r = await profile.buildProfile(PID_NJ, { staffId: officer, sections: ['overview'], force: true });
  assert.strictEqual(r.sections[0].status, 'ok');
  // TWO calls, not one: the header is get_person plus the list_people row that
  // carries the mailing address and the track record.
  assert.strictEqual(calls.length, beforeFresh + 2);
  ok('Refresh data really does go back to Elementix');

  // -------------------------------------------------------------------------
  console.log('\n7. Two states, one person — only once a human says so');
  // -------------------------------------------------------------------------
  let d = await profile.decideAlias({ personId: PID_NJ, aliasPersonId: PID_FL, staffId: null, confirm: true });
  assert.strictEqual(d.ok, false); assert.strictEqual(d.reason, 'no_actor');
  ok('merging two records is refused when nobody signed for it');

  d = await profile.decideAlias({ personId: PID_NJ, aliasPersonId: PID_FL, staffId: officer, confirm: true });
  assert.strictEqual(d.ok, true);
  let fam = await profile.familyOf(PID_NJ);
  assert.deepStrictEqual(fam.sort(), [PID_FL, PID_NJ].sort());
  ok('once confirmed, the two records are one family');

  // Landing on the Florida record must show the SAME profile.
  const famFromAlias = await profile.familyOf(PID_FL);
  assert.deepStrictEqual(famFromAlias.sort(), [PID_FL, PID_NJ].sort());
  ok('opening the Florida record shows the same merged profile — the owner asked for ONE profile');

  await profile.buildProfile(PID_NJ, { staffId: officer, force: true });
  v = await profile.readProfile(PID_NJ);
  assert.strictEqual(v.summary.counts.mortgages, 350, '349 in NJ plus 1 in FL');
  assert.strictEqual(v.summary.counts.deeds, 604);
  assert.strictEqual(v.summary.exposure, 197839792.86 + 250000);
  assert.deepStrictEqual(v.summary.states.sort(), ['FL', 'NJ']);
  ok('the merged profile adds both states up — 350 mortgages, 604 deeds, both exposures');

  d = await profile.decideAlias({ personId: PID_NJ, aliasPersonId: PID_FL, staffId: officer, confirm: false });
  assert.strictEqual(d.ok, true);
  fam = await profile.familyOf(PID_NJ);
  assert.deepStrictEqual(fam, [PID_NJ]);
  const headCleared = await db.query(`SELECT primary_person_id FROM elementix_persons WHERE person_id = $1`, [PID_FL]);
  assert.strictEqual(headCleared.rows[0].primary_person_id, null);
  ok('saying "not the same person" un-merges them completely');

  // -------------------------------------------------------------------------
  console.log('\n8. Merging never double-counts, and never drops a row');
  // -------------------------------------------------------------------------
  extraDeedRows[PID_NJ] = [{ id: 'deed-shared-1' }, { address: 'no id at all' }];
  extraDeedRows[PID_FL] = [{ id: 'deed-shared-1' }, { address: 'no id at all' }];
  await profile.decideAlias({ personId: PID_NJ, aliasPersonId: PID_FL, staffId: officer, confirm: true });
  await profile.buildProfile(PID_NJ, { staffId: officer, force: true, sections: ['deeds'] });
  v = await profile.readProfile(PID_NJ);
  const shared = v.sections.deeds.rows.filter((x) => x.id === 'deed-shared-1');
  assert.strictEqual(shared.length, 1, 'the same recorded deed under two ids is ONE deed');
  const idless = v.sections.deeds.rows.filter((x) => x.address === 'no id at all');
  assert.strictEqual(idless.length, 2, 'a row the vendor gave no id is KEPT — dropping a real property is worse than showing it twice');
  ok('the merge folds away what it can prove is the same, and keeps what it cannot');

  assert.ok(v.sections.deeds.rows.every((x) => x._source && x._source.personId),
    'every merged row says which record it came from');
  ok('every row on a merged tab can be traced back to the state it came from');

  // -------------------------------------------------------------------------
  console.log('\n9. Every request was one the vendor would accept');
  // -------------------------------------------------------------------------
  // (Asserted inside the stub on every single call — this just proves the stub
  //  actually ran, so the guarantee is not vacuous.)
  assert.ok(calls.length > 30, `the preflight guard ran on ${calls.length} requests`);
  const idKeys = new Set(calls.filter((c) => c.tool.startsWith('get_person')).map((c) => Object.keys(c.args).includes('id')));
  assert.deepStrictEqual([...idKeys], [true], 'the person tools take `id`, never `personId`');
  ok(`${calls.length} requests, every one preflighted against the vendor's own schema`);

  await wipe();
  console.log(`\n${passed} checks passed.\n`);
}

main().then(() => db.pool.end()).catch(async (e) => {
  console.error('\nFAILED:', e && e.message);
  console.error(e && e.stack);
  try { await db.pool.end(); } catch (_) {}
  process.exit(1);
});
