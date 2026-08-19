#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the PRICED PROBE selector (agreement-priced-probe.js), offline.
 *
 * The defect it exists against: every paid Lender Price run has reported `agreedPriced 0`, because the
 * probe file it is given contains only loans OUR OWN sheet declines — so the run can only ever produce
 * both-declines, and no rate, band or LLPA is ever read on either side. This selector answers, free and
 * offline, which scenarios our sheet actually prices.
 *
 * What is pinned here is not "it filters" — it is the four things a filter of this shape gets wrong:
 *   (1) a scenario that CRASHES the pricer is counted as a decline (evidence about the harness read as
 *       evidence about the sheet);
 *   (2) an ELIGIBLE scenario the sheet could not price for want of a fact is counted as a decline (the
 *       remedy is a fact, not a rule — two different places to send a reader);
 *   (3) the cap takes the head of the list, so a probe of 5 is five cells of ONE table and the paid run
 *       never touches the other axes;
 *   (4) the cap is silent, so a narrowed probe reads as the whole sheet.
 *
 * Every assertion below was proven to FAIL by mutating agreement-priced-probe.js (the mutation log is
 * at the foot of this file). No network, no database, no live pricer — the pricer is injected.
 *
 *   node scripts/test-lt-ppe-priced-probe.js
 */
const {
  selectPricedProbe, describeProbe, probeBlocker, classifyQuote, _internals,
} = require('../src/longterm/ppe/agreement-priced-probe');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

console.log('LT PPE priced probe — offline\n');

// ---- the four quote shapes quote.js can actually return ----------------------------------------
const PRICED = { eligible: true, ladder: [{ rate: 7000, price: 100000 }, { rate: 7125, price: 100500 }] };
const DECLINED = (why) => ({ eligible: false, declines: [{ code: 'ltv_max', reason: why }] });
const INCOMPLETE = { eligible: true, priced: false, incomplete: true, reason: 'missing_price_fact', missingPriceFacts: ['dscr'] };
const NO_RUNGS = { eligible: true, ladder: [] };

// A) classifyQuote — the whole truth table, including the two shapes that are NOT declines.
{
  ok(classifyQuote(PRICED).outcome === 'priced' && classifyQuote(PRICED).rungs === 2, 'eligible + rungs → priced, and the rung count rides along');
  ok(classifyQuote(DECLINED('Max LTV 75%')).outcome === 'declined', 'eligible:false → declined');
  ok(classifyQuote(DECLINED('Max LTV 75%')).why === 'Max LTV 75%', "…and the decline's own reason is what is reported");
  ok(classifyQuote({ eligible: false, declines: [] }).outcome === 'declined'
    && /no stated reason/.test(classifyQuote({ eligible: false, declines: [] }).why),
    'a decline with no reason SAYS it had none — never an empty string that reads as a reason');
  // ⛔ THE TWO THAT MUST NOT BE DECLINES.
  ok(classifyQuote(INCOMPLETE).outcome === 'incomplete', 'eligible but unpriceable → incomplete, NOT declined (the remedy is a fact, not a rule)');
  ok(classifyQuote(NO_RUNGS).outcome === 'no_rungs', 'eligible with an EMPTY ladder → no_rungs, never counted as priced');
  ok(classifyQuote(null).outcome === 'errored' && classifyQuote(7).outcome === 'errored', 'a non-result is errored, not declined');
  // The priced shape carries NO `priced` key at all (quote.js line ~403), so a test of `q.priced ===
  // false` must not read `undefined` as false — this is the exact case that would misfile every real
  // priced quote as incomplete.
  ok(PRICED.priced === undefined && classifyQuote(PRICED).outcome === 'priced', 'a real priced quote has no `priced` key, and is still read as priced');
}

// ---- a battery with a known composition ---------------------------------------------------------
// 4 groups, deliberately uneven, so a round-robin and a head-of-list cap give DIFFERENT answers.
function battery() {
  const s = [];
  for (let i = 0; i < 5; i += 1) s.push({ _group: 'a', _label: `a${i}`, fico: 700 + i });
  for (let i = 0; i < 3; i += 1) s.push({ _group: 'b', _label: `b${i}`, fico: 700 + i });
  s.push({ _group: 'c', _label: 'c0', fico: 660 });
  s.push({ _label: 'nogroup', fico: 640 });          // no _group at all
  return s;
}
// price everything → every scenario is a probe candidate
const priceAll = () => PRICED;

// B) the census is a PARTITION — every scenario in exactly one bucket, counts derived from the lists.
{
  const scs = battery();
  const mixed = (sc) => {
    if (sc._label === 'a0') throw new Error('boom');
    if (sc._label === 'a1') return INCOMPLETE;
    if (sc._label === 'a2') return DECLINED('Minimum DSCR 1.00');
    if (sc._label === 'b0') return NO_RUNGS;
    return PRICED;
  };
  return (async () => {
    const sel = await selectPricedProbe(scs, mixed);
    ok(sel.scenarios === 10, `every scenario is accounted for — got ${sel.scenarios} of 10`);
    const sum = sel.pricedTotal + sel.declined + sel.incomplete + sel.noRungs + sel.errors;
    ok(sum === sel.scenarios, `the five buckets PARTITION the battery — ${sum} vs ${sel.scenarios}`);
    ok(sel.entries.length === 10, 'one entry per scenario, so the census can be checked against its own list');
    ok(sel.entries.every((e) => e.outcome), 'no entry is left without an outcome');

    // C) A CRASH IS NOT A DECLINE.
    const crashed = sel.entries.find((e) => e.label === 'a0');
    ok(crashed.outcome === 'errored', 'a pricer that THREW is errored, not declined');
    ok(sel.errors === 1 && sel.declined === 1, `errors 1 / declined 1 — got ${sel.errors} / ${sel.declined}`);
    ok(/boom/.test(crashed.why), "…and the crash's own message is kept, so it can be fixed");

    // D) An incomplete is neither priced nor declined.
    const inc = sel.entries.find((e) => e.label === 'a1');
    ok(inc.outcome === 'incomplete' && sel.incomplete === 1, 'the unpriceable-but-eligible scenario is its own bucket');
    ok(!sel.probe.some((x) => x._label === 'a1'), '…and it is never handed to the paid run as a probe candidate');
    ok(!sel.probe.some((x) => x._label === 'b0'), 'the empty-ladder scenario is never a probe candidate either');
    ok(sel.pricedTotal === 6, `6 of 10 price — got ${sel.pricedTotal}`);

    // the reason census
    ok(sel.declineReasons['Minimum DSCR 1.00'] === 1, 'the decline reason is counted by its own words');

    // per-group census
    ok(sel.byGroup.a.total === 5 && sel.byGroup.a.priced === 2 && sel.byGroup.a.errors === 1, 'the per-group census matches the group');
    ok(sel.byGroup.ungrouped && sel.byGroup.ungrouped.total === 1, 'a scenario with no _group is bucketed, never dropped');

    await sectionE();
  })();
}

// E) THE CAP SPREADS — the defect that would make a paid run price one table five times.
async function sectionE() {
  const scs = battery();
  const sel = await selectPricedProbe(scs, priceAll, { limit: 5 });
  const labels = sel.probe.map((x) => x._label);
  ok(sel.probe.length === 5, `the cap is honoured — got ${sel.probe.length}`);
  // round-robin over first-appearance group order a,b,c,ungrouped → a0,b0,c0,nogroup,a1
  ok(JSON.stringify(labels) === JSON.stringify(['a0', 'b0', 'c0', 'nogroup', 'a1']),
    `the cap goes ROUND-ROBIN across groups, not down the head of the list — got ${JSON.stringify(labels)}`);
  const groups = new Set(sel.probe.map((x) => x._group || 'ungrouped'));
  ok(groups.size === 4, `a probe of 5 touches all 4 groups — got ${groups.size}`);

  // F) the cap is never silent, and never makes the sheet look narrower than it is.
  ok(sel.pricedTotal === 10, `pricedTotal is the UNCAPPED figure — got ${sel.pricedTotal}`);
  ok(sel.priced === 5, 'priced is what was picked');
  ok(sel.droppedForCap.length === 5, `what the cap left out is named — got ${sel.droppedForCap.length}`);
  ok(sel.droppedForCap.every((d) => d.label && d.group), '…by label AND group, so it can be asked for later');
  ok(sel.byGroup.a.picked === 2 && sel.byGroup.a.dropped === 3, 'the per-group split names picked AND dropped');
  const lines = describeProbe(sel).join('\n');
  ok(/probe capped to 5/.test(lines) && /5 priced scenario\(s\) left out/.test(lines), 'the printed census SAYS the probe was capped and by how much');

  // no cap → everything priced, nothing dropped
  const all = await selectPricedProbe(scs, priceAll);
  ok(all.probe.length === 10 && all.droppedForCap.length === 0, 'with no cap, every priced scenario is a probe candidate');

  // a cap larger than the population is not a cap
  const big = await selectPricedProbe(scs, priceAll, { limit: 99 });
  ok(big.probe.length === 10 && big.droppedForCap.length === 0, 'a cap above the population drops nothing');
  const zero = await selectPricedProbe(scs, priceAll, { limit: 0 });
  ok(zero.probe.length === 0 && zero.droppedForCap.length === 10, 'a cap of 0 picks nothing and says so — never "no priced scenarios"');

  await sectionG();
}

// G) determinism + identity + the empty cases.
async function sectionG() {
  const scs = battery();
  const a = await selectPricedProbe(scs, priceAll, { limit: 4 });
  const b = await selectPricedProbe(scs, priceAll, { limit: 4 });
  ok(JSON.stringify(a.probe.map((x) => x._label)) === JSON.stringify(b.probe.map((x) => x._label)),
    'the same battery selects the same probe twice — no randomness, no clock');

  // The probe must be the ORIGINAL objects: the runner reads `_label`/`_group` off them and the LP leg
  // sends the rest, so a copy that dropped a key would silently change what is priced.
  ok(a.probe.every((x) => scs.includes(x)), 'the probe carries the ORIGINAL scenario objects, not copies');

  const empty = await selectPricedProbe([], priceAll);
  ok(empty.scenarios === 0 && empty.probe.length === 0 && empty.pricedTotal === 0, 'an empty battery is an empty answer, not a throw');

  const noneP = await selectPricedProbe(scs, () => DECLINED('Max LTV 70%'));
  ok(noneP.pricedTotal === 0 && noneP.probe.length === 0 && noneP.declined === 10, 'a sheet that prices nothing reports 0 priced and 10 declined');
  ok(/our sheet prices 0 of 10/.test(describeProbe(noneP).join('\n')), '…and says so in words');

  let threw = false;
  try { await selectPricedProbe(scs, null); } catch (_) { threw = true; }
  ok(threw, 'no pricer is a THROW — never a silent "nothing prices"');

  // an async pricer works exactly the same (the real leg may be awaited)
  const asyncSel = await selectPricedProbe(scs, async (sc) => (sc._group === 'a' ? PRICED : DECLINED('no')));
  ok(asyncSel.pricedTotal === 5, `an async pricer is awaited — got ${asyncSel.pricedTotal}`);

  await sectionH();
}

// H) describeProbe never truncates silently.
async function sectionH() {
  const scs = [];
  for (let i = 0; i < 9; i += 1) scs.push({ _group: 'g', _label: `s${i}` });
  const sel = await selectPricedProbe(scs, (sc) => DECLINED(`reason ${sc._label}`));
  const lines = describeProbe(sel, { topReasons: 3 }).join('\n');
  const shown = (lines.match(/^ {2}x /gm) || []).length;
  ok(shown === 3, `the reason list is capped at 3 — got ${shown}`);
  ok(/6 more reason\(s\), 6 scenario\(s\)/.test(lines), 'what the reason list cut is NAMED as a remainder — no silent cap');

  // the round-robin helper on its own: an exhausted group must not stall the rotation
  const entries = [
    { group: 'x' }, { group: 'x' }, { group: 'x' }, { group: 'y' },
  ];
  const { picked } = _internals.spreadPick(entries, 4);
  ok(picked.length === 4, `the rotation drains a battery whose groups are uneven — got ${picked.length}`);

  await sectionI();
}

// I) ONE DEFINITION — this selector and the free pre-flight must never disagree about what our sheet
// did with a scenario. They bucket differently ON PURPOSE (the pre-flight folds the two unpriceable
// outcomes into `unpriced`; a probe report keeps them apart), so what is pinned is that the buckets
// RECONCILE, and that every outcome the shared classifier can produce has a home here.
async function sectionI() {
  const preflight = require('../src/longterm/ppe/agreement-preflight');
  const scs = battery();
  const mixed = (sc) => {
    if (sc._label === 'a1') return INCOMPLETE;
    if (sc._label === 'a2') return DECLINED('Minimum DSCR 1.00');
    if (sc._label === 'b0') return NO_RUNGS;
    if (sc._label === 'c0') return null;                 // an unreadable answer
    return PRICED;
  };
  const sel = await selectPricedProbe(scs, mixed);
  const pre = preflight.runOursOnly(scs, mixed, {});
  ok(sel.pricedTotal === pre.priced, `both read the same PRICED count — ${sel.pricedTotal} vs ${pre.priced}`);
  ok(sel.incomplete + sel.noRungs === pre.unpriced,
    `the two unpriceable buckets reconcile with the pre-flight's one — ${sel.incomplete}+${sel.noRungs} vs ${pre.unpriced}`);
  // The one place they deliberately differ, stated rather than implied: the pre-flight counts an
  // unreadable answer as a decline (pre-existing, left alone); the probe counts it as an error.
  ok(pre.declined === sel.declined + sel.errors && sel.errors === 1,
    `the unreadable answer is a decline to the pre-flight and an ERROR here — ${pre.declined} vs ${sel.declined}+${sel.errors}`);

  // Every outcome the SHARED classifier can return has a bucket — read off its own source, so a new
  // outcome added there cannot be silently absorbed into "the sheet declined it".
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src/longterm/ppe/agreement-preflight.js'), 'utf8');
  const body = src.slice(src.indexOf('function classifyOursQuote'), src.indexOf('function declineCodesOf'));
  const outcomes = Array.from(new Set((body.match(/outcome: '([a-z_]+)'/g) || []).map((m) => m.slice(10, -1))));
  ok(outcomes.length >= 5, `the classifier's own source names its outcomes — found ${outcomes.length}`);
  const unbucketed = outcomes.filter((o) => !_internals.OUTCOME_BUCKET[o]);
  ok(unbucketed.length === 0, `every classifier outcome has a bucket here — unbucketed: ${JSON.stringify(unbucketed)}`);

  await sectionJ();
}

// J) A SCENARIO THE BATTERY ITSELF EXPECTS TO BE REFUSED IS NEVER A PROBE CANDIDATE — and when our
// sheet prices one, that is a finding, not something to drop. Measured live over the canonical 305:
// our sheet prices `NJ Individual PPP prohibited`, because the built-in sheet-under-test is the RATE
// SHEET alone and New Jersey's prepayment prohibition lives in the separate prepayment matrix. Handing
// that to a paid run buys a guaranteed disagreement about a layer this sheet does not carry.
async function sectionJ() {
  const scs = [
    { _group: 'a', _label: 'ok0' },
    { _group: 'a', _label: 'ok1' },
    { _group: 'ineligible', _label: 'NJ Individual PPP prohibited', _ineligible: true },
    { _group: 'ineligible', _label: 'fico 500', _ineligible: true },
  ];
  const sel = await selectPricedProbe(scs, (sc) => (sc._label === 'fico 500' ? DECLINED('Min FICO 660') : PRICED));
  ok(sel.pricedTotal === 3, `the census still counts it as PRICED — got ${sel.pricedTotal}`);
  ok(sel.candidates === 2, `…but the probe candidates are only the 2 unlabelled ones — got ${sel.candidates}`);
  ok(!sel.probe.some((x) => x._ineligible), 'a labelled-ineligible scenario is never handed to the paid run');
  ok(sel.pricedLabelledIneligible.length === 1
    && sel.pricedLabelledIneligible[0].label === 'NJ Individual PPP prohibited',
    'the one our sheet priced anyway is named — never silently dropped');
  const lines = describeProbe(sel).join('\n');
  ok(/labels INELIGIBLE/.test(lines) && /NJ Individual PPP prohibited/.test(lines),
    'the printed census names it, so a run cannot hide the finding it just made');
  // the one the sheet DECLINED needs no report — the battery and the sheet agree about it
  ok(!/fico 500/.test(lines), 'a labelled-ineligible scenario the sheet also declines is NOT reported — the two agree');
  const capped = await selectPricedProbe(scs, () => PRICED, { limit: 1 });
  ok(capped.probe.length === 1 && !capped.probe[0]._ineligible && capped.droppedForCap.length === 1,
    'under a cap, the dropped-for-cap list counts only real candidates — never the excluded ones');

  await sectionK();
}

// K) THE HONEST BLOCKER, and the two causes it must not collapse. "Nothing to compare" is the same
// class of refusal as "no credentials" — paying to compare nothing buys a confident verdict about
// nothing — but a sheet that priced NONE of the battery and a sheet whose only priced scenarios are
// ones the battery expects to be refused send a reader to two completely different places.
async function sectionK() {
  const scs = [{ _group: 'a', _label: 'ok0' }, { _group: 'x', _label: 'nope', _ineligible: true }];
  const fine = await selectPricedProbe(scs, () => PRICED);
  ok(probeBlocker(fine) === null, 'a probe with something in it is not blocked');

  const none = await selectPricedProbe(scs, () => DECLINED('Max LTV 70%'));
  const m1 = probeBlocker(none);
  ok(typeof m1 === 'string' && /prices NONE/.test(m1), 'a sheet that priced nothing says so');
  ok(/Nothing was sent to Lender Price/.test(m1), '…and states plainly that no paid call was made');

  const onlyFlagged = await selectPricedProbe(scs, (sc) => (sc._ineligible ? PRICED : DECLINED('Max LTV 70%')));
  const m2 = probeBlocker(onlyFlagged);
  ok(typeof m2 === 'string' && /labels INELIGIBLE/.test(m2) && !/prices NONE/.test(m2),
    'a sheet whose only priced scenarios are the battery\'s own ineligible probes gets a DIFFERENT message');
  ok(m1 !== m2, 'the two causes are never collapsed into one sentence');
  ok(probeBlocker(null) !== null, 'an unreadable selection blocks — it never reads as "there is a probe"');

  console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
  process.exit(failures ? 1 : 0);
}

/* ---------------------------------------------------------------------------------------------
 * MUTATION LOG — each mutation applied to src/longterm/ppe/agreement-priced-probe.js on its own,
 * with an unmutated control green either side. A mutation that CRASHED was re-done until it failed
 * as an ASSERTION, because a crash is not proof.
 *
 *   M1  classifyQuote: treat a throw as `declined`          → C fails (a crash read as the sheet's opinion)
 *   M2  classifyQuote: drop the incomplete branch           → D fails (an eligible scenario that needs a FACT
 *                                                              filed under "the sheet has no rung for it")
 *   M3  classifyQuote: `q.ladder.length >= 0` for priced    → D fails (an empty ladder sold as a price)
 *   M4  spreadPick: `entries.slice(0, limit)`               → E fails (the head-of-list cap, all one group)
 *   M5  report `priced` as the uncapped figure              → F fails (a capped probe reading as the whole sheet)
 *   M6  droppedForCap: `[]`                                 → F fails (a silent cap)
 *   M7  describeProbe: drop the remainder line              → H fails (a silently truncated reason list)
 *   M8  OUTCOME_BUCKET: drop the `incomplete` entry          → I fails (an outcome with no home here,
 *                                                              which is how a new verdict gets absorbed)
 *   M9  candidacy: probe from pricedEntries again            → J fails (a loan the battery says is
 *                                                              refused, sent to a paid run)
 *   M10 pricedLabelledIneligible: `[]`                       → J fails (the finding dropped in silence)
 *   M11 probeBlocker: one message for both causes            → K fails (two different problems, one
 *                                                              sentence, one wrong place to look)
 * ------------------------------------------------------------------------------------------- */
