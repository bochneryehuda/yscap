#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE VENDOR REORDERS ITS OWN LLPAs; OUR ANSWER MUST NOT MOVE (§2.100).
 *
 * ⛔ WHAT WAS MEASURED, LIVE 2026-08-18. One scenario priced TWICE, seconds apart, both whole responses
 * diffed leaf by leaf:
 *
 *     2,889 raw adjustment arrays  ->  2,445 identical
 *                                        444 the SAME SET in a DIFFERENT ORDER
 *                                          0 genuinely different
 *
 * Through `normalizeLpFull` that was 222 of 499 rungs, so our normalized answer was byte-different on
 * every call while nothing about the pricing had changed. `scripts/fixtures/lp-llpa-order.json` holds
 * six of those real rung pairs — the vendor's own bytes, kept as evidence so the canonical ordering can
 * never be "simplified" away as unnecessary.
 *
 * ⚠ AND THE FIRST READING OF THIS WAS WRONG, WHICH IS WHY THE FIXTURE IS A PAIR AND NOT A SNAPSHOT. The
 * leaf diff that found it compares BY INDEX, so a reordered array reads as "202 adjustments were
 * RELABELLED — adjType LoanAmountRateAdjustment became SimpleRateAdjustment". That is a completely
 * different and far more alarming defect (the LLPA dimension crosswalk in `ratesheet-agreement-diff`
 * keys on `adjType`), and it is not what is happening: comparing the arrays as SETS shows zero genuine
 * differences. Section A asserts the set-equality directly, so the alarming reading can never be
 * re-derived from this data by the next person to diff it.
 *
 * WHAT THIS SUITE PINS:
 *   A  the vendor's real behaviour — same set, different order, nothing relabelled
 *   B  the comparator is TOTAL, so nothing is left in arrival order
 *   C  sorting LOSES NOTHING — same count, same rows, same total
 *   D  the two consumers that were ALREADY order-independent stay that way
 *
 * PURE — no DB, no network, no vendor call. LT-only.
 */
const fs = require('fs');
const path = require('path');
const full = require('../src/longterm/ppe/lp-normalize-full');
const finding = require('../src/longterm/ppe/finding');
const digest = require('../src/longterm/ppe/rung-digest');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'lp-llpa-order.json'), 'utf8'));
const setOf = (arr) => JSON.stringify(arr.map((x) => JSON.stringify(x)).sort());
const seqOf = (arr) => JSON.stringify(arr);
const byKey = (arr) => [...arr].sort((x, y) => (full.llpaSortKey(x) < full.llpaSortKey(y) ? -1 : 1));

// ---- A: what the vendor actually did ---------------------------------------------------------------
console.log('-- A: the vendor returned the same set in a different order, and relabelled NOTHING --');
ok(Array.isArray(FIX.rows) && FIX.rows.length >= 5, `${(FIX.rows || []).length} real rung pairs captured`);
ok(FIX.measured && FIX.measured.genuinelyDifferent === 0 && FIX.measured.sameSetDifferentOrder > 0,
  `the whole-response measurement: ${FIX.measured.sameSetDifferentOrder} reordered, ${FIX.measured.genuinelyDifferent} genuinely different`);
let reordered = 0;
for (const r of FIX.rows) {
  ok(setOf(r.a) === setOf(r.b), `${r.lender} @ ${r.rate}: the two calls carry the IDENTICAL SET of adjustments`);
  if (seqOf(r.a) !== seqOf(r.b)) reordered += 1;
}
ok(reordered === FIX.rows.length,
  `and all ${reordered} carry it in a DIFFERENT ORDER — which is the whole defect, not a relabelling`);
// The alarming misreading, refuted directly on the vendor's own bytes: no adjustment carries a
// different adjType for the same reason+value between the two calls. An index-wise diff says
// otherwise; a set-wise one does not.
{
  const byReason = (arr) => { const m = new Map(); for (const a of arr) m.set(`${a.reason}|${a.valueMilli}`, a.adjType); return m; };
  let relabelled = 0;
  for (const r of FIX.rows) {
    const ma = byReason(r.a); const mb = byReason(r.b);
    for (const [k, v] of ma) if (mb.has(k) && mb.get(k) !== v) relabelled += 1;
  }
  ok(relabelled === 0,
    'and NO adjustment carries a different adjType for the same reason+value — the "202 relabelled" reading was an artifact of diffing by index');
}

// ---- B: the comparator is total --------------------------------------------------------------------
console.log('\n-- B: the order is defined on the CONTENT, and it is total --');
{
  const key = full.llpaSortKey;
  ok(typeof key === 'function', 'the sort key is exported, so this suite drives the real comparator');
  // Two rows differing in ONLY one part must still be ordered — a comparator that stopped at `reason`
  // would leave every same-reason tie in arrival order and reintroduce the instability it removes.
  const base = { reason: 'R', adjType: 'T', group: 'G', valueMilli: 100 };
  for (const part of ['reason', 'adjType', 'group', 'valueMilli']) {
    const other = { ...base, [part]: part === 'valueMilli' ? 999 : 'Z' };
    ok(key(base) !== key(other), `two rows differing only in \`${part}\` get different keys — the order does not stop early`);
  }
  ok(key({ reason: null, adjType: null, group: null, valueMilli: null }) !== key(base),
    'an all-null row is orderable and distinct — a null must never throw or collide');
  ok(key({ reason: 'A B', adjType: 'C', group: null, valueMilli: 1 })
    !== key({ reason: 'A', adjType: 'B C', group: null, valueMilli: 1 }),
    'the separator cannot be forged from field content — two different rows never share a key');
}

// ---- C: sorting loses nothing ----------------------------------------------------------------------
console.log('\n-- C: the sort is a REORDERING — nothing added, dropped or changed --');
for (const r of FIX.rows) {
  const a = byKey(r.a); const b = byKey(r.b);
  ok(seqOf(a) === seqOf(b), `${r.lender} @ ${r.rate}: the two calls become IDENTICAL once ordered`);
  ok(a.length === r.a.length && b.length === r.b.length, '…with the same number of adjustments — a sort may never drop one');
  const sum = (xs) => xs.reduce((t, x) => t + (typeof x.valueMilli === 'number' ? x.valueMilli : 0), 0);
  ok(sum(a) === sum(r.a) && sum(a) === sum(r.b),
    `…and the same LLPA total (${sum(a)} milli) — which is the number that reaches a price`);
}

// ---- C2: and the SHIPPED path is the thing that sorts ------------------------------------------------
// ⛔ SECTION C ALONE IS NOT ENOUGH, AND THIS SUITE SHIPPED WITHOUT THIS SECTION FOR ONE MUTATION ROUND.
// C sorts the fixture rows BY HAND with `byKey`, so it proves the comparator is total and that ordering
// makes the two calls agree — and it passes identically whether or not `normalizeLpFull` applies that
// comparator at all. Deleting the `.sort(...)` from the production builder left every assertion above
// green. That is the recurring shape: a test that proves a property of a HELPER while claiming to prove
// it of the SHIPPED PATH. So the real builder is driven here, on the vendor's own recorded rows, fed in
// deliberately reversed so an unsorted builder cannot accidentally agree.
console.log('\n-- C2: normalizeLpFull itself emits them ordered --');
{
  const row = FIX.rows[0];
  // The shape `normalizeLpFull` consumes is `client.parseFull(raw)` — programs[].options[], each option
  // carrying `adjustments[]` in the VENDOR's units (points), which the normalizer converts to milli.
  const asVendor = (llpas) => llpas.map((l) => ({
    reason: l.reason, adjType: l.adjType, group: l.group,
    value: l.valueMilli == null ? null : l.valueMilli / 1000,
  }));
  const parsedFull = (llpas) => ({
    programs: [{
      lender: row.lender, investor: 'x', program: row.program, product: 'p',
      options: [{ priceBuild: { noteRate: row.rate / 1000, price: 100, basePoints: 0, adjustmentPoints: 0 }, adjustments: asVendor(llpas) }],
    }],
  });
  const outOf = (llpas) => full.normalizeLpFull(parsedFull(llpas)).programs[0].rungs[0].llpas;
  const forward = outOf(row.a);
  const backward = outOf([...row.a].reverse());
  ok(forward.length === row.a.length, `the builder kept all ${forward.length} adjustments`);
  ok(seqOf(forward) === seqOf(backward),
    'the SAME rows fed forwards and reversed come out in the SAME order — the builder sorts, it does not merely preserve');
  ok(seqOf(forward) === seqOf(byKey(forward)),
    '…and that order is the canonical one, not some other stable order');
  // The two REAL calls, put through the real builder, must now agree — the end-to-end statement.
  ok(seqOf(outOf(row.a)) === seqOf(outOf(row.b)),
    'and the two real vendor calls normalize to an IDENTICAL adjustment list, which is the whole point');

  // ⛔ A DUPLICATE ROW IS MONEY, AND A SORT MUST NOT SWALLOW IT. Duplicate adjustment rows genuinely
  // occur and they SUM — that is a recorded finding of its own ("overlapping DSCR blocks and duplicate
  // adjustment rows both SUM, silently"), so a builder that quietly de-duplicated while ordering would
  // remove real points from the LLPA stack and under-charge. Sorting is a REORDERING and nothing else.
  // Without this the obvious `.filter(unique)` "tidy-up" passes every other assertion here.
  {
    const dup = { reason: 'Additional LLPAs - Purchase', adjType: 'SimpleRateAdjustment', group: 'g', valueMilli: 125 };
    const withDup = [dup, { ...dup }, { reason: 'Z other', adjType: 'SimpleRateAdjustment', group: 'g', valueMilli: 500 }];
    const out = outOf(withDup);
    ok(out.length === 3, `an identical adjustment appearing twice stays twice (${out.length} of 3 kept)`);
    const total = out.reduce((t, x) => t + (x.valueMilli || 0), 0);
    ok(total === 750, `…so the stack still totals ${total} milli, not 625 — the second copy is real money`);
  }
}

// ---- D: the consumers that were already safe stay safe ---------------------------------------------
console.log('\n-- D: the two things that were ALREADY order-independent, pinned so they stay that way --');
{
  // A finding's IDENTITY must never include its evidence. `parity-detectors` attaches the raw `lpLlpas`
  // array as detail; if the key took the detail in, a reordered evidence array would mint a NEW finding
  // on every run and the review queue would fill with the same finding forever.
  const f = (llpas) => ({ investor: 'Deephaven', program: 'DSCR', scenario: 's1', kind: 'llpa_total', rate: 6125, lpLlpas: llpas });
  ok(finding.findingKey(f([{ reason: 'A' }, { reason: 'B' }])) === finding.findingKey(f([{ reason: 'B' }, { reason: 'A' }])),
    'findingKey ignores the evidence order — a reordered lpLlpas can never mint a duplicate finding');
  ok(finding.findingKey(f([])) === finding.findingKey(f([{ reason: 'A' }])),
    '…and ignores the evidence entirely, which is what makes that true for any future detail field too');
}
{
  // The rung digest sums into a dimension-keyed Map, so it was never order-sensitive. Asserted here
  // because that is a PROPERTY somebody could refactor away — and once the normalizer sorts, the
  // damage would be invisible until the vendor reordered something the sort does not reach.
  const { theirRungs } = digest._internals;
  const mk = (llpas) => ({ rungs: [{ rate: 6125, llpas, adjustmentPointsMilli: 1375, priceMilli: 100475 }] });
  const llpas = [
    { reason: 'DSCR (All) - 760 - 779', adjType: 'FicoRateAdjustment', group: 'g', valueMilli: 125 },
    { reason: 'Other - State of NY', adjType: 'SimpleRateAdjustment', group: 'g', valueMilli: 375 },
    { reason: '5 Year Prepay Penalty', adjType: 'SimpleRateAdjustment', group: 'g', valueMilli: 625 },
  ];
  const flat = (rs) => JSON.stringify(rs.map((r) => ({ ...r, adjByDim: [...r.adjByDim.entries()].sort() })));
  ok(flat(theirRungs(mk(llpas))) === flat(theirRungs(mk([...llpas].reverse()))),
    'rung-digest sums per dimension, so it is order-independent whatever order it is handed — pinned');
}

console.log(`\n${failures === 0 ? 'all passed' : `${failures} FAILED`}`);
if (failures) process.exit(1);
