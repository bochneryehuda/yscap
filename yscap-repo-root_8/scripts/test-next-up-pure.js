/**
 * "What needs you next" — the loan file's front door (blueprint Move 1).
 *
 * Pure. Exercises app-v2/src/lib/next-up.js, the ordering brain behind
 * components/NextUpPanel.jsx. This card is the FIRST thing anyone sees on a
 * loan file, so "which item is at the top" is worth locking down: get it wrong
 * and the front door quietly points at the wrong work.
 *
 * The two rules that must never regress:
 *   1. PILOT's advisories are never listed and never counted (owner-directed
 *      2026-07-27 — an AI finding may not read as something holding the file).
 *   2. An item that blocks BOTH clear-to-close and funding appears once.
 */
const assert = require('node:assert');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

(async () => {
  const { buildNextUp, byUrgency } = await import('../app-v2/src/lib/next-up.js');

  // Ageing as the two endpoints already stamp it (daysOpen / overdue / overdueBy).
  const items = [
    { id: 'a', daysOpen: 3, overdue: false, overdueBy: 0 },
    { id: 'b', daysOpen: 22, overdue: true, overdueBy: 8 },
    { id: 'c', daysOpen: 11, overdue: false, overdueBy: 0 },
    { id: 'g', daysOpen: 1, overdue: false, overdueBy: 0 },
  ];
  const conds = [{ id: 'u1', daysOpen: 40, overdue: true, overdueBy: 25 }];
  const gating = {
    clear_to_close: {
      ready: false,
      conditions: [
        { kind: 'condition', id: 'a', title: 'Bank statements' },
        { kind: 'condition', id: 'c', title: 'Insurance binder' },
        { kind: 'condition', id: 'b', title: 'Title commitment' },
        { kind: 'condition', id: 'u1', title: 'Verify owner of record' },
      ],
      gates: [{ kind: 'gate', id: 'g', title: 'Appraisal review cleared' }],
      advisories: [{ kind: 'advisory', id: 'ai1', title: 'AI advisory: seller chain' }],
    },
    funded: {
      ready: false,
      conditions: [
        { kind: 'condition', id: 'a', title: 'Bank statements' },   // also blocks CTC
        { kind: 'condition', id: 'f1', title: 'Final HUD' },
      ],
      gates: [],
    },
  };

  // ---- ordering -----------------------------------------------------------
  {
    const r = buildNextUp(gating, items, conds);
    const t = r.all.map((x) => x.title);
    ok(t[0] === 'Verify owner of record', 'worst overdue first — and ageing joins from the underwriting-conditions table too');
    ok(t[1] === 'Title commitment', 'the second overdue item follows');
    ok(t[2] === 'Appraisal review cleared', 'a gate outranks every non-overdue condition');
    ok(t[3] === 'Insurance binder' && t[4] === 'Bank statements', 'among equals, the longest-open condition comes first');
    ok(t[5] === 'Final HUD', 'a funding-only item sorts after everything holding clear-to-close');
    ok(r.holding.length === 5 && r.next.length === 1, 'the two groups split holding-the-file from before-funding');
    ok(r.overdue === 2, 'the overdue count is the overdue rows, nothing else');
  }

  // ---- the two rules that must never regress ------------------------------
  {
    const r = buildNextUp(gating, items, conds);
    const t = r.all.map((x) => x.title);
    ok(!t.includes('AI advisory: seller chain'), 'advisories are never listed');
    ok(r.all.length === 6 && r.overdue === 2, 'advisories are never counted');
    ok(t.filter((x) => x === 'Bank statements').length === 1, 'an item blocking both CTC and funding appears once');
  }

  // ---- degrades safely ----------------------------------------------------
  {
    ok(buildNextUp(null).all.length === 0, 'no gating payload yet → nothing, never a crash');
    ok(buildNextUp({}).all.length === 0, 'empty payload → nothing');
    const onlyAdvisories = buildNextUp(
      { clear_to_close: { ready: true, conditions: [], gates: [], advisories: [{ id: 'x' }] }, funded: { ready: true, conditions: [], gates: [] } }, [], []);
    ok(onlyAdvisories.all.length === 0, 'a file whose only open items are advisories reads as clear');
    const noAgeing = buildNextUp(
      { clear_to_close: { conditions: [{ kind: 'condition', id: 'z', title: 'Z' }], gates: [] }, funded: {} }, null, null);
    ok(noAgeing.all.length === 1 && noAgeing.overdue === 0, 'missing ageing data → the row still lists, just without an age');
  }

  // ---- the comparator itself ---------------------------------------------
  {
    const late = { kind: 'condition', overdue: true, daysOpen: 2, title: 'late' };
    const gate = { kind: 'gate', overdue: false, daysOpen: 99, title: 'gate' };
    const old = { kind: 'condition', overdue: false, daysOpen: 50, title: 'old' };
    const blank = { kind: 'condition', overdue: false, daysOpen: null, title: 'blank' };
    const sorted = [blank, old, gate, late].sort(byUrgency).map((x) => x.title);
    assert.deepStrictEqual(sorted, ['late', 'gate', 'old', 'blank']);
    ok(true, 'comparator: overdue → gate → longest open → no ageing data last');
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
