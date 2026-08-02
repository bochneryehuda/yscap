/**
 * "What's left on this file" — the ONE work list (components/WhatsLeftPanel.jsx).
 *
 * Pure. Exercises app-v2/src/lib/next-up.js, the ordering brain behind it, plus
 * the structural rule the 2026-08-02 merge exists to enforce: there is exactly
 * ONE such list, and it lives inside the Overview.
 *
 * The rules that must never regress:
 *   1. PILOT's advisories are never listed and never counted (owner-directed
 *      2026-07-27 — an AI finding may not read as something holding the file).
 *   2. An item that blocks BOTH clear-to-close and funding appears once.
 *   3. ONE panel, in sec-overview, carrying the permanent #ctc-outstanding
 *      anchor — never a second copy above the room nav (owner-directed
 *      2026-08-02: "it should only be one section … under the overview").
 */
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ROOT = join(__dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

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

  /* ---- ONE list, in the Overview (the 2026-08-02 merge) ------------------ */
  {
    const staff = read('app-v2/src/screens/StaffApplication.jsx');

    // The two panels this replaced are gone — not merely unmounted, deleted, so
    // nobody can re-mount a second work list from a file that still exists.
    for (const gone of ['NextUpPanel', 'ClearToClosePanel']) {
      ok(!staff.includes(`components/${gone}.jsx`), `${gone} is retired (no import)`);
      let exists = true;
      try { read(`app-v2/src/components/${gone}.jsx`); } catch { exists = false; }
      ok(!exists, `components/${gone}.jsx is deleted`);
    }

    // Exactly one mount, and it is INSIDE sec-overview — not above the room nav,
    // which is what made the top of the file noisy.
    const mounts = staff.match(/<WhatsLeftPanel\b/g) || [];
    ok(mounts.length === 1, 'exactly one WhatsLeftPanel is mounted');
    const overviewAt = staff.indexOf(`id="sec-overview"`);
    const nextSectionAt = staff.indexOf('<Section ', overviewAt + 1);
    const mountAt = staff.indexOf('<WhatsLeftPanel');
    ok(overviewAt > 0 && mountAt > overviewAt && mountAt < nextSectionAt,
      'the work list renders inside the File overview section');

    // It is fed the ageing rows; without these it silently loses every
    // overdue chip (the one thing the retired top card had that the other didn't).
    ok(/<WhatsLeftPanel[^>]*items=\{items\}[^>]*conds=\{conds\}/.test(staff),
      'the work list receives items + conds, so ageing/overdue still renders');

    const panel = read('app-v2/src/components/WhatsLeftPanel.jsx');
    ok(panel.includes('id="ctc-outstanding"'), 'it keeps the permanent #ctc-outstanding anchor');
    ok(panel.includes('id="next-up"'), 'it keeps #next-up as an alias so old links still land');
    ok(panel.includes('buildNextUp'), 'it orders through the tested brain, not a private sort');
    // Advisories still render, and still under their own "does not block" heading.
    ok(/advisories/.test(panel) && /None of it holds up clear-to-close/.test(panel),
      "PILOT's notes survive the merge, still labelled as never blocking");
    // Every text colour dark on white (--ink* tokens are LIGHT — see styles.css).
    ok(!/color:\s*['"]?var\(--ink/.test(panel), 'no --ink* token is used as a text colour');
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
