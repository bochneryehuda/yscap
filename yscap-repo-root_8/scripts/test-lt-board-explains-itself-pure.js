'use strict';
/**
 * LONG-TERM — THE GENERAL BOARD ANSWERS WHY AN INVESTOR IS NOT ON IT.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────
 * `investor-routing.applyRouting` builds three things on EVERY search:
 *
 *   hidden[]      every removal, with its reason (switched off / the sheet did not
 *                 answer / the sheet had no quote) and the investor's CLIENT-SAFE name
 *   completeness  whether both rate sheets answered, worded vendor-neutrally
 *   settings      how many routes applied, and what could not be read
 *
 * The COMBINED engine has returned all three since it shipped. `general-board`
 * built them and returned NONE of them, so the general engine's screen could not
 * answer the one question an officer asks about a short board — why is that
 * investor missing? Two boards built by ONE function answered differently about
 * the same search, which is exactly the drift a shared builder exists to stop.
 *
 * Three more were computed or in hand and dropped: the hand-added investors and
 * what could not be read of them (`customInvestors`), the grid cells the
 * "almost at a better tier" hint reads its REAL bands from, and — the expensive
 * one — the LoanNEX transaction id, so a LoanNEX REFUSAL could never reach this
 * engine's not-eligible list even though the search already held the handle.
 *
 * ⛔ THIS SUITE RUNS THE DOORS. A regex over a route body can only ever pin how an
 * answer is SPELLED; four guards of exactly that shape were defeated on this branch
 * on 2026-09-03 while the defects they were written for were fully restored. Here
 * the board is built with both vendor clients stubbed and its answer is READ, and
 * the ineligibility collector is driven with stub clients and its answer asserted.
 *
 * PURE: every vendor client is injected or stubbed. No network, no database.
 */

const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const eq = (a, b, m) => {
  try { assert.deepStrictEqual(a, b); pass++; console.log(`  ok   ${m}`); } catch (_) {
    fail++; console.log(`  FAIL ${m} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
  }
};

const generalBoard = require(path.join(ROOT, 'src/longterm/pricing/general-board'));
const ineligibility = require(path.join(ROOT, 'src/longterm/pricing/ineligibility'));
const nearTier = require(path.join(ROOT, 'src/longterm/pricing/near-tier'));

/* ── The two sheets — THE SAME RECORDED CAPTURE the two-source suite uses ───
   ⛔ NOT A HAND-BUILT STUB. A fixture thinner than what production builds is blind
   to any rule that reads the missing fields — the lesson this integration has now
   learned three times. The Lender Price half is the real parser over a real raw
   shape and the LoanNEX half is the recorded board, so `hidden[]` reports removals
   the merge genuinely made rather than ones a fixture invented. */
const lpModel = require(path.join(ROOT, 'src/longterm/lenderprice/client.js'));
const nexParse = require(path.join(ROOT, 'src/longterm/loannex/parse.js'));
const investorPrograms = require(path.join(ROOT, 'src/longterm/lenderprice/investor-programs'));
const RECORDED = nexParse.parse(require(path.join(ROOT, 'src/longterm/loannex/capture/quick-prices.json')).response);

const leaf = (co, rate) => ({
  companyId: co, companyName: co, programName: 'DSCR 30 Yr Fixed', productName: '30 Yr Fixed',
  rate, adjustedPoints: 1, basePoints: 0.5, adjustmentPoints: 0.5,
  dayLock: 30, term: 30, loanAmount: 375000, dscr: 1.3, fico: 760, ltv: 75,
  monthlyPayment: { monthlyPI: 2500, mi: 0 },
  /* ⛔ ADJUSTMENT CELLS IN THE VENDOR'S OWN SHAPE — groups carrying `name` and
     `adjustments[{key, llpa}]`, which is what `client.flattenAdjustments` reads. The first
     cut of this fixture wrote `{label, detail, adjustment}`, which that function ignores, so
     it produced ZERO cells and the section below would have passed on an empty list. A
     fixture thinner than, or differently shaped from, what production reads is blind to the
     rule it is meant to hold. */
  groupAdjustmentProperties: [
    { name: 'DSCR', adjustments: [{ key: 'DSCR 1.20 - 1.24', llpa: -0.25 }, { key: 'DSCR >= 1.25', llpa: 0 }] },
    { name: 'LTV', adjustments: [{ key: 'LTV 70.01 - 75.00', llpa: -0.5 }] },
  ],
  ratePeriod: { validAsOf: '2026-09-03T00:00:00Z' }, expired: false,
});
const LP_RAW = { results: { qualifiedNonQMData: { type: 'CriteriaFromLineResultKey', keyLabel: 'DSCR', childs: [
  { type: 'LenderKey', keyLabel: 'NQM Funding', plenderId: 'A', leafs: [leaf('NQM Funding', 7.5)] },
  { type: 'LenderKey', keyLabel: 'Verus', plenderId: 'D', leafs: [leaf('Verus', 7.7)] },
] } } };

const lp = {
  price: async () => ({ ok: true, raw: LP_RAW, searchKey: 'poll-key-abc', request: {}, provenance: null }),
  parseFull: lpModel.parseFull,
};
const nex = { price: async () => ({ board: RECORDED, transactionId: 'tree-id-xyz', portal: null }) };

const SC = { purpose: 'Purchase', value: 500000, loan: 375000, zip: '08201', fico: 760, dscr: 1.3, ltv: 75 };

async function main() {
  console.log('\nA · the board answers with its own explanations');
  const cfg = await generalBoard.loadConfig({
    routes: { verus: { source: 'lenderprice', enabled: false } },
    links: {},
    marginHoldback: 0.25,
  });
  const board = await generalBoard.boardForScenario(SC, { lp, nex, investorPrograms }, cfg);

  ok(board && board.ok === true, 'A0 CONTROL: the board built at all');
  /* ⛔ THE THREE `applyRouting` BUILDS AND THIS FUNCTION USED TO THROW AWAY. */
  ok(Array.isArray(board.hidden), `A1 ⛔ \`hidden\` comes back — every removal with its reason (${(board.hidden || []).length} rows)`);
  ok(board.completeness && typeof board.completeness.complete === 'boolean',
    'A2 ⛔ `completeness` comes back — so a short board can never be silent');
  ok(board.settings && typeof board.settings.applied === 'number',
    'A3 ⛔ `settings` comes back — how many routes applied, and what could not be read');

  /* THE SWITCHED-OFF INVESTOR IS ACTUALLY IN IT, with a reason and a CLIENT-SAFE name —
     without this the three keys could be present and empty on every board. */
  const off = (board.hidden || []).find((h) => h.key === 'verus');
  ok(!!off, `A4 CONTROL: the investor a setting switched off is REPORTED, not merely absent (${JSON.stringify((board.hidden || []).map((h) => h.key))})`);
  ok(off && typeof off.reason === 'string' && off.reason.length > 0,
    `A4a …with the reason it went (${off && off.reason})`);
  /* A hidden row carries the CLIENT-SAFE name and says whether one exists, so a screen
     never has to fall back to the vendor's spelling to name the row. The vendor's own
     spelling rides beside it — this whole payload is STAFF-ONLY (`/api/lt` is mounted
     behind requireAuth + requireStaff) and `investorRoster` on the same answer carries it
     too; the client-facing rule is enforced where a client is actually served. */
  ok(off && 'whiteLabel' in off && 'whiteLabelMissing' in off,
    `A4b …carrying the CLIENT-SAFE name and whether there is one (${off && JSON.stringify({ whiteLabel: off.whiteLabel, missing: off.whiteLabelMissing })})`);

  console.log('\nB · the three that were computed or in hand and dropped');
  ok(board.customInvestors && typeof board.customInvestors.count === 'number'
    && Array.isArray(board.customInvestors.problems) && 'problem' in board.customInvestors,
    'B1 the hand-added investors come back WITH what could not be read of them — a shorter roster than somebody configured can say so');
  ok(Array.isArray(board.cells),
    `B2 the grid cells this board carries come back (${(board.cells || []).length}) — the "almost at a better tier" hint reads its REAL bands from them`);
  ok((board.cells || []).some((c) => c && /DSCR/i.test(String(c.label || ''))),
    `B2a CONTROL: …and they are the board’s own cells, not an empty list that would pass anyway (${JSON.stringify((board.cells || []).slice(0, 2))})`);
  ok(board.nx && board.nx.transactionId === 'tree-id-xyz',
    `B3 ⛔ the LoanNEX transaction id is in hand (${board.nx && board.nx.transactionId}) — this is the handle a LoanNEX refusal is fetched with`);
  ok(board.searchKey === 'poll-key-abc',
    `B3a …beside the Lender Price poll key (${board.searchKey})`);

  console.log('\nC · the hint reads those cells rather than the standing steps');
  {
    /* A loan sitting JUST UNDER a band the sheet itself names — the case the whole feature
       is for. Anywhere else the two answers agree, so asserting on the suite's own scenario
       would have proved nothing. */
    const near = { value: SC.value, loan: SC.loan, ltvPct: SC.ltv, dscr: 1.19 };
    const withCells = nearTier.nearTier({ ...near, lines: board.cells });
    const without = nearTier.nearTier({ ...near, lines: [] });
    ok(withCells !== undefined && without !== undefined,
      'C1 CONTROL: the hint answers either way — it is a nicety beside a board and must never throw');
    ok(JSON.stringify(withCells) !== JSON.stringify(without),
      '⛔ C2 …and the board’s own cells CHANGE its answer, which is why an empty list mattered');
    ok(withCells.dscr && withCells.dscr.source === 'sheet',
      `⛔ C3 …naming the INVESTOR'S OWN band (${withCells.dscr && withCells.dscr.source}) — "${withCells.dscr && withCells.dscr.why}"`);
    ok(!without.dscr,
      'C3a CONTROL: …where an empty list gives no DSCR hint at all, which is what every board answered before this');
  }

  console.log('\nD · why every other investor said no — BOTH sheets, one list');
  {
    const lenders = (arr) => ({ lenders: arr });
    const lpStub = {
      pollDisqualifiedByKey: async () => ({ ok: true, ready: true, parsed: lenders([{ lender: 'NQM Funding', items: [{ reason: 'DSCR too low' }] }]) }),
      parseDisqualified: (r) => r,
    };
    const nexStub = { fails: async () => ({ disqualified: lenders([{ lender: 'Acra Lending', items: [{ reason: 'LTV too high' }] }]) }) };

    const both = await ineligibility.collect({ pollKey: 'k', treeId: 't' }, { lp: lpStub, nex: nexStub, programs: investorPrograms });
    ok(both.ready === true, 'D1 both halves arrived');
    eq(both.pending, [], 'D1a …nothing still pending');
    eq(both.failed, [], 'D1b …and nothing failed');
    ok(both.disqualified.lenderCount === 2,
      `⛔ D2 BOTH SHEETS' REFUSALS ARE IN THE LIST (${both.disqualified.lenderCount}) — the general engine could only ever see one`);

    /* ONE INVESTOR, ONE ENTRY — a refused investor can legitimately appear on both sheets,
       and the board joins them by key, so this list must join them the same way or one
       company shows twice under one white label. */
    const dupLp = { pollDisqualifiedByKey: async () => ({ ok: true, ready: true, parsed: lenders([{ lender: 'NQM Funding', items: [{ reason: 'a' }] }]) }), parseDisqualified: (r) => r };
    const dupNex = { fails: async () => ({ disqualified: lenders([{ lender: 'NQM Funding', items: [{ reason: 'b' }] }]) }) };
    const dup = await ineligibility.collect({ pollKey: 'k', treeId: 't' }, { lp: dupLp, nex: dupNex, programs: investorPrograms });
    ok(dup.disqualified.lenderCount === 1 && dup.disqualified.itemCount === 2,
      `⛔ D3 one investor refused by BOTH sheets is ONE row carrying both reasons (${dup.disqualified.lenderCount} row, ${dup.disqualified.itemCount} reasons)`);

    /* ONE HALF FAILING NEVER TAKES THE OTHER DOWN — "the other sheet could not be reached"
       and "the other sheet refused nobody" are different facts, and a blank space reads
       as the second. */
    const brokenNex = { fails: async () => { const e = new Error('upstream is down'); e.code = 'unreachable'; throw e; } };
    const half = await ineligibility.collect({ pollKey: 'k', treeId: 't' }, { lp: lpStub, nex: brokenNex, programs: investorPrograms });
    ok(half.ready === true && half.disqualified.lenderCount === 1,
      '⛔ D4 one half failing still answers with the other half’s refusals');
    ok(half.failed.length === 1 && half.failed[0].reason === 'unreachable',
      `D4a …and the failure is CARRIED, never swallowed (${JSON.stringify(half.failed)})`);

    /* STILL COMPUTING IS NOT THE SAME AS FINISHED. */
    const slowLp = { pollDisqualifiedByKey: async () => ({ ok: true, ready: false }), parseDisqualified: (r) => r };
    const part = await ineligibility.collect({ pollKey: 'k', treeId: 't' }, { lp: slowLp, nex: nexStub, programs: investorPrograms });
    ok(part.ready === true && part.pending.length === 1 && part.retryAfterMs === 2000,
      `D5 a half still working is NAMED as pending while the arrived half is shown (${JSON.stringify(part.pending)})`);
    ok(typeof part.message === 'string' && part.message.length > 10,
      'D5a …with a sentence saying so, so a half-filled list can never read as the whole answer');

    /* ⛔ THE VENDOR IS NAMED ONLY WHEN AN ADMIN ASKED. */
    ok(half.failed[0].half === 'tree',
      `⛔ D6 an ordinary caller is told the MECHANISM, never the vendor (${half.failed[0].half})`);
    const revealed = await ineligibility.collect({ pollKey: 'k', treeId: 't', reveal: true }, { lp: lpStub, nex: brokenNex, programs: investorPrograms });
    ok(revealed.failed[0].half === 'loannex',
      `D6a …and an admin who asked for the source gets it (${revealed.failed[0].half})`);

    /* A HANDLE FOR ONE SHEET ONLY IS A REAL STATE — a board on which nothing is routed to
       the other sheet. It must answer, not refuse. */
    const oneOnly = await ineligibility.collect({ pollKey: 'k' }, { lp: lpStub, nex: nexStub, programs: investorPrograms });
    ok(oneOnly.ready === true && oneOnly.disqualified.lenderCount === 1,
      'D7 one handle answers on its own — a board with nothing routed to the other sheet still gets its list');
  }

  console.log('\nE · both engines call the SAME collector, and both doors are mounted');
  {
    const { stripComments } = require(path.join(ROOT, 'scripts/lib/strip-comments'));
    const fs = require('fs');
    const rd = (f) => stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    const general = rd('src/longterm/routes/dscr-pricer.js');
    const combined = rd('src/longterm/routes/combined-pricer.js');
    ok(/ineligibility\.collect\(/.test(general) && /ineligibility\.collect\(/.test(combined),
      'E1 both engines ask the ONE collector — the joining rule, what `ready` means and what happens when a half fails live in one place');
    ok(!/const byKey = new Map\(\);/.test(combined),
      'E2 …and the combined engine kept no copy of the joining loop it used to hold');
    ok(/router\.post\('\/ineligible'/.test(general),
      'E3 the general engine has a handle-based door at all — it only ever had the scenario-based one, which asks Lender Price alone');
    ok(/handlers: \{[^}]*ineligible[^}]*\}/.test(general),
      'E3a …exported, so a test can run it without an HTTP server');
    ok(/router\.post\('\/disqualify'/.test(general),
      'E4 …and the scenario-based door it already had is UNTOUCHED — the saved-scenario flow still works');
    /* The cells helper moved to its ONE consumer so the two engines cannot read a board
       differently; the combined engine must not have kept its own. */
    ok(!/function cellsOnBoard\(board\)/.test(combined),
      'E5 the cells helper is not defined in the combined route any more — it lives with the hint that reads it');
    ok(/nearTier\.cellsOnBoard/.test(combined) || /cellsOnBoard = nearTier\.cellsOnBoard/.test(combined),
      'E5a …which is where it delegates to');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\nCRASHED:', (e && e.stack) || e); process.exit(1); });
