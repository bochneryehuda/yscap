'use strict';
/**
 * LONG-TERM — field 4008 decides how title vests, and "Individual" means
 * individual (db/624, owner-directed 2026-08-23: *"The only time you need to
 * look for the entity name is if that field 4008 shows 'officer'."*).
 *
 * Fixtures are the LIVE answers captured 2026-08-24:
 *   Officer-vested:    {"4008":"Officer","1859":"400 Birchwood LLC"}
 *   Individual-vested: {"4008":"Individual","1859":""}
 *
 * What this proves:
 *   A. vestingOf — the whole truth table, including the trap the rule exists
 *      for: an Individual vesting NEVER reads 1859, even when it carries text
 *   B. describeVesting — one wording for every screen
 *   C. (DB) the loan read end to end, through a stubbed client: Officer lands
 *      the entity name; re-vesting to Individual CLEARS it (COALESCE could
 *      never); a read whose 4008 was blank leaves both columns alone
 *
 * Mutation-proven:
 *   1. vestingOf reading 1859 on an Individual vesting → A fails
 *   2. the writer COALESCEing instead of CASE-guarding   → C fails (stale name)
 */

const assert = require('assert');

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); console.log('  ok  ', w); checks++; };
const eq = (a, b, w) => { assert.strictEqual(a, b, w); console.log('  ok  ', w); checks++; };

async function main() {
  const vesting = require('../src/longterm/vesting');

  console.log('A. vestingOf — the rule');
  let v = vesting.vestingOf({ 4008: 'Officer', 1859: '400 Birchwood LLC' });
  eq(v.answered, true, 'Officer answers');
  eq(v.vestsInEntity, true, 'Officer = an entity takes title');
  eq(v.entityName, '400 Birchwood LLC', '…and 1859 is its legal name (the live fixture)');
  eq(v.entityNameMissing, false, 'a named entity is not missing');

  v = vesting.vestingOf({ 4008: 'Individual', 1859: 'STALE COMPANY LLC' });
  eq(v.vestsInEntity, false, 'Individual = the person takes title');
  eq(v.entityName, null,
    'THE RULE ITSELF: an Individual vesting NEVER reads the entity name — even when 1859 carries stale text');

  v = vesting.vestingOf({ 4008: 'Officer', 1859: '' });
  eq(v.entityName, null, 'an Officer vesting with a blank 1859 has no name…');
  eq(v.entityNameMissing, true, '…and says so — a real young-file state, never a guess');

  v = vesting.vestingOf({ 4008: 'Trustee', 1859: 'Smith Family Trust' });
  eq(v.vestsInEntity, true, 'Trustee is an entity vesting too (the tenant’s own completion rule)');

  v = vesting.vestingOf({ 4008: '', 1859: 'Whatever LLC' });
  eq(v.answered, false, 'a blank 4008 claims NOTHING — the writer leaves both columns alone');
  v = vesting.vestingOf(null);
  eq(v.answered, false, 'no values at all claims nothing');
  v = vesting.vestingOf({ 4008: 'Something New', 1859: 'X LLC' });
  eq(v.answered, true, 'an unrecognised word is recorded…');
  eq(v.vestsInEntity, null, '…but no entity conclusion is drawn from a word we have never measured');

  console.log('B. describeVesting — one wording everywhere');
  eq(vesting.describeVesting({ vesting_type: 'Individual' }).label, 'Individual', 'individual reads as Individual');
  eq(vesting.describeVesting({ vesting_type: 'Officer', vesting_entity_name: '400 Birchwood LLC' }).label,
    '400 Birchwood LLC', 'an entity vesting reads as the entity');
  eq(vesting.describeVesting({ vesting_type: 'Officer' }).label,
    'Entity — name not entered yet', 'a nameless entity vesting says so');
  eq(vesting.describeVesting({}).known, false, 'nothing read yet claims nothing');

  if (!process.env.DATABASE_URL) {
    console.log(`\nNo DATABASE_URL — pure half passed (${checks} checks); DB half skipped.`);
    return;
  }

  // ── C. The loan read end to end, through a stubbed client ─────────────────
  console.log('C. readLoan writes vesting — and re-vesting to Individual CLEARS the name');
  const path = require('path');
  const clientPath = path.resolve(__dirname, '../src/longterm/encompass/client.js');
  // The repo-wide stub pattern: replace the client wholesale in require.cache
  // BEFORE anything requires it.
  let fields = { 4008: 'Officer', 1859: '400 Birchwood LLC', 'MS.STATUS': 'Funded' };
  const stub = {
    configured: () => true,
    getLoan: async () => ({ loanAmortizationTermMonths: 360, loanProgramName: 'Investor DSCR 30 YEAR FRM' }),
    getLoanMilestones: async () => ([
      { name: 'Started', doneIndicator: true, startDate: '2026-06-01T00:00:00Z' },
      { name: 'Funding', doneIndicator: true, startDate: '2026-08-01T00:00:00Z' },
      { name: 'Investor Delivery', doneIndicator: false, startDate: '2026-08-25T00:00:00Z' },
    ]),
    fieldReader: async () => ({ ...fields }),
  };
  require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: stub };
  const loans = require('../src/longterm/sync/loans');
  const db = require('../src/longterm/db');

  const { rows: made } = await db.query(
    `INSERT INTO lt_loans (id, encompass_loan_guid, loan_number)
     VALUES (gen_random_uuid(), 'test-vest-' || gen_random_uuid(), 'TESTVEST1')
     RETURNING id, encompass_loan_guid AS guid`,
  );
  const loanId = made[0].id;
  try {
    let out = await loans.readLoan(loanId, made[0].guid, {});
    eq(out.ok, true, 'the read runs against the stubbed client');
    let l = (await db.query('SELECT vesting_type, vesting_entity_name, milestone_name, ms_status FROM lt_loans WHERE id = $1::uuid', [loanId])).rows[0];
    eq(l.vesting_type, 'Officer', 'the vesting word landed');
    eq(l.vesting_entity_name, '400 Birchwood LLC', 'the entity name landed on an Officer vesting');
    eq(l.milestone_name, 'Funding',
      'and the STANDING milestone rode the same read — the LAST COMPLETED step (db/623 + owner-directed 2026-08-24)');
    eq(l.ms_status, 'Funded', 'with the tenant’s own wording');

    // The loan is RE-VESTED to an individual in Encompass. 1859 often keeps its
    // stale text there — the rule is that it must not survive here.
    fields = { 4008: 'Individual', 1859: '400 Birchwood LLC', 'MS.STATUS': 'Funded' };
    out = await loans.readLoan(loanId, made[0].guid, {});
    l = (await db.query('SELECT vesting_type, vesting_entity_name FROM lt_loans WHERE id = $1::uuid', [loanId])).rows[0];
    eq(l.vesting_type, 'Individual', 'the re-vest landed');
    eq(l.vesting_entity_name, null,
      'THE ONE THAT MATTERS: re-vesting to Individual CLEARED the stale entity name — individual means individual');

    // A read whose 4008 came back blank: both columns stay exactly as they are.
    fields = { 'MS.STATUS': 'Funded' };
    out = await loans.readLoan(loanId, made[0].guid, {});
    l = (await db.query('SELECT vesting_type, vesting_entity_name FROM lt_loans WHERE id = $1::uuid', [loanId])).rows[0];
    eq(l.vesting_type, 'Individual', 'a blank 4008 left the vesting word alone');
    eq(l.vesting_entity_name, null, '…and the (correctly cleared) name stayed cleared');

    // ── D3 (audit round 3): a FAILED ladder read on an ALREADY-LADDERED loan
    // must claim NOTHING — no milestone move, no stage move, no history event
    // and no clock reset. Before the fix it fell back to the lagging
    // `currentMilestone`, which under the last-completed rule is the step AHEAD
    // of where the loan stands: it recorded a move that never happened and
    // reset "at this milestone" to zero, and realignStanding then quietly put
    // the milestone back, leaving the bogus event and clock behind.
    console.log('D. a failed ladder read on a laddered loan claims NOTHING (audit round 3, D3)');
    const ladderMod = require('../src/longterm/sync/milestone-ladder');
    await ladderMod.writeLadder(loanId, [
      { milestoneName: 'Cond. Approval', position: 4, done: true, startDate: '2026-07-01' },
      { milestoneName: 'Processing', position: 5, done: false, startDate: '2026-07-20' },
    ], { db });
    await db.query(
      `UPDATE lt_loans SET milestone_name = 'Cond. Approval', stage_key = 'underwriting',
              milestone_since = '2026-07-01T00:00:00Z', milestone_since_is_baseline = false
        WHERE id = $1::uuid`, [loanId]);
    const evBefore = (await db.query(
      'SELECT count(*)::int AS n FROM lt_milestone_events WHERE loan_id = $1::uuid', [loanId])).rows[0].n;

    // Encompass answers the loan but NOT the ladder, and its lagging field says
    // "Processing" — the step being worked, i.e. one AHEAD of where we stand.
    stub.getLoanMilestones = async () => { throw new Error('milestones unreachable'); };
    stub.getLoan = async () => ({
      loanAmortizationTermMonths: 360, loanProgramName: 'Investor DSCR 30 YEAR FRM',
      currentMilestone: 'Processing',
    });
    out = await loans.readLoan(loanId, made[0].guid, {});
    eq(out.ok, true, 'the read still succeeds — a ladder outage never loses the loan');
    l = (await db.query(
      'SELECT milestone_name, stage_key, milestone_since FROM lt_loans WHERE id = $1::uuid', [loanId])).rows[0];
    eq(l.milestone_name, 'Cond. Approval',
      'the standing did NOT walk forward to the lagging reading');
    eq(l.stage_key, 'underwriting',
      "…and the stage was not dropped into the unmapped 'other' bucket");
    eq(new Date(l.milestone_since).toISOString(), '2026-07-01T00:00:00.000Z',
      '…and the milestone clock was not reset to the moment of the failure');
    const evAfter = (await db.query(
      'SELECT count(*)::int AS n FROM lt_milestone_events WHERE loan_id = $1::uuid', [loanId])).rows[0].n;
    eq(evAfter, evBefore, '…and no phantom "entered" event was written');
  } finally {
    await db.query('DELETE FROM lt_loans WHERE id = $1::uuid', [loanId]).catch(() => {});
  }

  console.log(`\nAll ${checks} checks passed.`);
  process.exit(0);
}

main().catch((e) => { console.error('FAIL:', e && e.message); process.exit(1); });
