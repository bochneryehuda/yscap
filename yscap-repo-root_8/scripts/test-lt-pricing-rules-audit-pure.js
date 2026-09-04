'use strict';
/**
 * LONG-TERM — THE RULE-CENTER AUDIT ENGINE, WITHOUT A DATABASE.
 *
 * Owner-directed 2026-09-04: *"open audit engines to make sure that every rule
 * is actually firing."*
 *
 * The whole point of this feature is telling apart four situations that all
 * produce the sentence "this rule has matched nothing", so the assertions here
 * are mostly about which of them is reported:
 *
 *   • asked 4,000 times, matched none      → the rule is WRONG
 *   • asked 0 times                        → nobody has priced a board yet
 *   • asked, matched none, fired last year → seasonal, not broken
 *   • cannot be read at all                → fix the RULE, not the loan
 *
 * Getting that ordering wrong is worse than having no screen: it sends somebody
 * to fix a rule that is fine, which is how a screen like this stops being read.
 *
 * ⛔ EVERY READ IS TOTAL — `(x || {})`, never `x.y` — for the reason the sibling
 * suite records: a mutation that empties a list must FAIL this battery, never
 * CRASH it, because a crash stops the run and reports a pass count that means
 * nothing.
 *
 * PURE: no database, no network, no clock. Every module here takes its data as
 * arguments.
 */

const fs = require('fs');
const path = require('path');

const shared = require('../src/lib/conditions/rules');
const fields = require('../src/longterm/pricing/rules/fields');
const diagnose = require('../src/longterm/pricing/rules/diagnose');
const firing = require('../src/longterm/pricing/rules/firing');
const audit = require('../src/longterm/pricing/rules/audit');

let pass = 0; const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}
const eq = (name, a, b) => ok(name, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
/* Comments are STRIPPED before every "must not appear" check — the code that
   removes a thing names it in the comment explaining why, and a guard that read
   comments would fail on its own explanation. */
const stripComments = (s) => String(s)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/.*$/gm, '$1 ');

const RULE = (over) => Object.assign({
  id: 'r1',
  name: 'A rule',
  engine: 'all',
  enabled: true,
  priority: 100,
  when: { combinator: 'and', rules: [{ field: 'ltv', operator: 'between', value: [80, 90] }] },
  then: [{ type: 'add_holdback', points: 0.25, reason: 'because' }],
}, over || {});

// ═══════════════════════════════════════════════════════════════════════════
// A · THE DIAGNOSIS AGREES WITH THE ENGINE THAT PRICES THE BOARD
//
// Everything this feature says rests on one claim: the per-row verdicts come
// from the SAME walk the overlay uses. If that is ever untrue the screen will
// confidently explain why a rule did not fire while the board fires it.
// ═══════════════════════════════════════════════════════════════════════════
{
  console.log('\nA · the diagnosis agrees with the shared walk');

  const ROWS = [
    { field: 'ltv', operator: 'between', value: [80, 90] },        // true at 85
    { field: 'ltv', operator: 'gt', value: 99 },                   // false at 85
    { field: 'nope_missing', operator: 'eq', value: 1 },           // null (no such field)
    { field: 'ltv', operator: 'contains', value: 'x' },            // null (illegal operator)
    { field: 'loan_amount', operator: 'between', value: [100000, 500000] },
    { field: 'dscr', operator: 'lt', value: 0.5 },
  ];
  const F = { ltv: 85, loan_amount: 250000, dscr: 1.1 };

  let compared = 0; let mismatched = 0;
  const pick = (i, k) => ROWS[(i >> (k * 3)) % ROWS.length];
  for (let i = 0; i < 2048; i++) {
    for (const comb of ['and', 'or']) {
      const size = 1 + (i % 3);
      const rules = []; for (let k = 0; k < size; k++) rules.push(pick(i, k));
      const tree = { combinator: comb, rules };
      let want = null;
      try { want = shared.evaluateRuleTri(tree, F, fields.BY_KEY); } catch (_) { want = 'THREW'; }
      const got = (diagnose.judgeGroup(tree, F, 0) || {}).verdict;
      const w = (want === true || want === false) ? want : null;
      compared++;
      if (got !== w) mismatched++;
    }
  }
  eq(`A1 ${compared} flat trees judged exactly as the shared walk judges them`, mismatched, 0);

  let nested = 0; let nestedBad = 0;
  for (let i = 0; i < 400; i++) {
    const tree = {
      combinator: i % 2 ? 'or' : 'and',
      rules: [pick(i, 0), { combinator: i % 3 ? 'or' : 'and', rules: [pick(i, 1), pick(i, 2)] }],
    };
    const want = shared.evaluateRuleTri(tree, F, fields.BY_KEY);
    const got = (diagnose.judgeGroup(tree, F, 0) || {}).verdict;
    nested++;
    if (got !== ((want === true || want === false) ? want : null)) nestedBad++;
  }
  eq(`A2 ${nested} nested trees judged the same way`, nestedBad, 0);

  ok('A3 the diagnosis never keeps its own copy of the comparison',
    /evaluateRuleTri\(/.test(stripComments(src('src/longterm/pricing/rules/diagnose.js'))));
}

// ═══════════════════════════════════════════════════════════════════════════
// B · "CANNOT BE READ" IS NEVER REPORTED AS "DID NOT MATCH"
//
// The two have opposite fixes: a failing row means the LOAN did not qualify, an
// unreadable row means the RULE is broken and has been quietly doing nothing.
// ═══════════════════════════════════════════════════════════════════════════
{
  console.log('\nB · a rule that cannot be read says so');

  const unknownField = diagnose.diagnose(
    RULE({ when: { combinator: 'and', rules: [{ field: 'not_a_field', operator: 'eq', value: 1 }] } }), { ltv: 85 });
  ok('B1 an unknown field is reported as unreadable, not as a plain miss', unknownField.broken === true);
  eq('B2 …and it does not fire', unknownField.fires, false);
  ok('B3 …and the reason names the field',
    /not_a_field/.test(String(unknownField.headline || '')), unknownField.headline);
  ok('B4 …and says it can never match',
    /never match/i.test(String(unknownField.headline || '')), unknownField.headline);

  const badOp = diagnose.diagnose(
    RULE({ when: { combinator: 'and', rules: [{ field: 'ltv', operator: 'contains', value: 'x' }] } }), { ltv: 85 });
  ok('B5 an operator the field type does not take is unreadable too', badOp.broken === true);

  const badAction = diagnose.diagnose(RULE({ then: [{ type: 'constructor' }] }), { ltv: 85 });
  ok('B6 a rule whose ACTIONS cannot be read is broken however well it matches',
    badAction.broken === true && badAction.fires === false);

  const healthyMiss = diagnose.diagnose(RULE(), { ltv: 72 });
  ok('B7 an ordinary non-match is NOT reported as broken', healthyMiss.broken === false);
  eq('B8 …and it does not fire', healthyMiss.fires, false);
  ok('B9 …and the reason states the loan\'s own figure',
    /72/.test(String(healthyMiss.headline || '')), healthyMiss.headline);

  const absent = diagnose.diagnose(RULE(), {});
  ok('B10 a fact the board does not carry reads as "no value", never as a wrong value',
    /no LTV/i.test(String((absent.blockers[0] || {}).why || '')), (absent.blockers[0] || {}).why);
  ok('B11 …and that is still not "broken"', absent.broken === false);
}

// ═══════════════════════════════════════════════════════════════════════════
// C · THE SHORTEST HONEST REASON — an `and` and an `or` have different answers
//
// In an `and` only the FAILING rows are to blame. In an `or` NOTHING passed, so
// every row is — naming one would send somebody to fix a row that would not
// have helped on its own.
// ═══════════════════════════════════════════════════════════════════════════
{
  console.log('\nC · which conditions are actually to blame');

  const andRule = RULE({
    when: { combinator: 'and', rules: [
      { field: 'ltv', operator: 'between', value: [80, 90] },   // passes at 85
      { field: 'dscr', operator: 'gt', value: 2 },              // fails at 1.1
    ] },
  });
  const a = diagnose.diagnose(andRule, { ltv: 85, dscr: 1.1 });
  eq('C1 an `and` blames only the rows that failed', (a.blockers || []).length, 1);
  eq('C2 …and it is the right one', ((a.blockers || [])[0] || {}).field, 'dscr');
  ok('C3 …and with one blocker the headline is that row\'s own reason',
    /DSCR is 1\.1/.test(String(a.headline || '')), a.headline);

  const orRule = RULE({
    when: { combinator: 'or', rules: [
      { field: 'ltv', operator: 'gt', value: 99 },
      { field: 'dscr', operator: 'gt', value: 99 },
    ] },
  });
  const o = diagnose.diagnose(orRule, { ltv: 85, dscr: 1.1 });
  eq('C4 an `or` that matched nothing blames EVERY row', (o.blockers || []).length, 2);
  ok('C5 …and says how many rather than naming one',
    /2 conditions/.test(String(o.headline || '')), o.headline);

  /* THE PROPERTY THAT MAKES ONE TEST COVER BOTH SHAPES: a group that PASSED is
     never walked, so a satisfied `or` nested inside an `and` is not blamed for
     the rule not firing — and the failing sibling beside it is. */
  const nested = diagnose.diagnose(RULE({
    when: { combinator: 'and', rules: [
      { combinator: 'or', rules: [
        { field: 'ltv', operator: 'between', value: [80, 90] },   // passes
        { field: 'dscr', operator: 'gt', value: 99 },             // fails
      ] },
      { field: 'fico', operator: 'gt', value: 800 },              // fails at 720
    ] },
  }), { ltv: 85, dscr: 1.1, fico: 720 });
  eq('C6a a satisfied `or` inside an `and` is never blamed', (nested.blockers || []).length, 1);
  eq('C6b …and the failing sibling is', ((nested.blockers || [])[0] || {}).field, 'fico');

  /* A ROW THE VALIDATOR ACCEPTS AND THE WALK STILL CANNOT ANSWER — the field
     exists and the operator is legal, but this quote holds something that is not
     a number. It is a BLOCKER as much as a failing row is: the rule did not
     fire, and the person needs to know which row could not be answered. Naming
     only the rows that came back FALSE would leave the real one unmentioned. */
  const unreadableRow = diagnose.diagnose(RULE({
    when: { combinator: 'and', rules: [
      { field: 'ltv', operator: 'between', value: [80, 90] },   // passes at 85
      { field: 'dscr', operator: 'gt', value: 1 },              // cannot be answered
    ] },
  }), { ltv: 85, dscr: 'not a number' });
  eq('C5a a row that cannot be answered is blamed too', (unreadableRow.blockers || []).length, 1);
  eq('C5b …and it is the right one', ((unreadableRow.blockers || [])[0] || {}).field, 'dscr');
  ok('C5c …and it is reported as unreadable rather than as a plain miss',
    ((unreadableRow.blockers || [])[0] || {}).unreadable === true);

  const orPasses = diagnose.diagnose(RULE({
    when: { combinator: 'or', rules: [
      { field: 'ltv', operator: 'between', value: [80, 90] },
      { field: 'dscr', operator: 'gt', value: 99 },
    ] },
  }), { ltv: 85, dscr: 1.1 });
  ok('C6 an `or` where one row passes fires, and blames nobody',
    orPasses.fires === true && (orPasses.blockers || []).length === 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// D · THE COUNTERS — the denominator is the whole point
// ═══════════════════════════════════════════════════════════════════════════
{
  console.log('\nD · turning a board into firing counts');

  const rules = [
    RULE({ id: 'a', name: 'A', engine: 'all' }),
    RULE({ id: 'b', name: 'B', engine: 'combined' }),
    RULE({ id: 'c', name: 'C', engine: 'all', enabled: false }),
  ];
  const at = new Date('2026-09-04T10:00:00Z');

  const none = firing.deltasFrom({ ran: true, applied: [], ineligible: [], blocked: [], problems: [] },
    { rules, engine: 'general', at });
  eq('D1 only the rules IN FORCE on this engine are counted as seen', none.length, 1);
  eq('D2 …and that is the one governing it', (none[0] || {}).ruleId, 'a');
  eq('D3 a rule in force but matching nothing is still SEEN — the denominator', (none[0] || {}).boardsSeen, 1);
  eq('D4 …and matched nothing', (none[0] || {}).boardsMatched, 0);

  const combined = firing.deltasFrom({ ran: true, applied: [], ineligible: [], blocked: [], problems: [] },
    { rules, engine: 'combined', at });
  eq('D5 the combined board asks both the "all" rule and its own', combined.length, 2);

  const acted = firing.deltasFrom({
    ran: true,
    applied: [{ ruleId: 'a', name: 'A', quotes: 4, adjustedQuotes: 3 }],
    ineligible: [{ ruleId: 'a', rule: 'A' }, { ruleId: 'a', rule: 'A' }],
    blocked: [{ ruleId: 'a', rule: 'A' }],
    problems: [],
  }, { rules, engine: 'general', at });
  const d = acted.find((x) => x.ruleId === 'a') || {};
  eq('D6 quotes reached are summed', d.quotesReached, 4);
  eq('D7 quotes whose price moved are counted separately', d.quotesAdjusted, 3);
  eq('D8 refusals are counted', d.quotesRefused, 2);
  eq('D9 blocked investors are counted', d.rowsBlocked, 1);
  eq('D10 …and the board counts as MATCHED once, never three times', d.boardsMatched, 1);

  const unreadable = firing.deltasFrom({
    ran: true, applied: [], ineligible: [], blocked: [],
    problems: [{ ruleId: 'a', name: 'A', problem: 'nope' }],
  }, { rules, engine: 'general', at });
  const u = unreadable.find((x) => x.ruleId === 'a') || {};
  eq('D11 a rule the board could not read is its own event', u.unreadable, 1);
  eq('D12 …and is NOT counted as a match', u.boardsMatched, 0);

  const notRun = firing.deltasFrom({ ran: false }, { rules, engine: 'general', at });
  eq('D13 a board the overlay never ran on records nothing', notRun.length, 0);

  const merged = firing.merge([
    ...firing.deltasFrom({ ran: true, applied: [{ ruleId: 'a', quotes: 2, adjustedQuotes: 1 }] }, { rules, engine: 'general', at }),
    ...firing.deltasFrom({ ran: true, applied: [{ ruleId: 'a', quotes: 3, adjustedQuotes: 2 }] }, { rules, engine: 'general', at }),
  ]);
  const m = merged.find((x) => x.ruleId === 'a') || {};
  eq('D14 two boards fold into one row for the day', merged.filter((x) => x.ruleId === 'a').length, 1);
  eq('D15 …with the boards added', m.boardsSeen, 2);
  eq('D16 …and the quotes added', m.quotesReached, 5);

  const seenOnly = firing.deltasFrom({ ran: true, applied: [] }, { rules, engine: 'general', at: new Date('2026-09-04T12:00:00Z') });
  const mixed = firing.merge([...acted, ...seenOnly]);
  const mm = mixed.find((x) => x.ruleId === 'a') || {};
  ok('D17 a board that merely SAW the rule never erases the moment it last fired', !!mm.at);

  const noId = firing.deltasFrom({ ran: true, applied: [{ ruleId: null, quotes: 1 }] },
    { rules: [RULE({ id: null })], engine: 'general', at });
  eq('D18 a rule with no id is skipped rather than bucketed under null', noId.length, 0);

  eq('D19 the day is the UTC day, so a bucket is the same everywhere',
    firing.dayOf(new Date('2026-09-04T23:59:00Z')), '2026-09-04');
}

// ═══════════════════════════════════════════════════════════════════════════
// E · THE VERDICT — the order of the questions IS the feature
// ═══════════════════════════════════════════════════════════════════════════
{
  console.log('\nE · one sentence per rule, and the right one');

  const asked = (seen, matched, extra) => Object.assign(
    { total: { boardsSeen: seen, boardsMatched: matched, quotesReached: 0, quotesAdjusted: 0, quotesRefused: 0, rowsBlocked: 0, unreadable: 0 }, engines: {} },
    extra || {});

  eq('E1 asked thousands of times and never matched → the rule is wrong',
    (audit.standing(RULE(), asked(4000, 0)) || {}).verdict, 'never_fired');
  eq('E2 never asked at all → nothing is wrong yet',
    (audit.standing(RULE(), asked(0, 0)) || {}).verdict, 'not_asked');
  eq('E3 asked and matching → healthy',
    (audit.standing(RULE(), asked(100, 12)) || {}).verdict, 'firing');
  eq('E4 asked, matched none, but it HAS fired before → not the same finding',
    (audit.standing(RULE(), asked(100, 0, { everFiredAt: '2026-01-01T00:00:00Z' })) || {}).verdict, 'stale');

  /* THE ORDERING TRAP THIS WHOLE FEATURE EXISTS FOR: a broken rule has also
     "never fired", and reporting THAT sends somebody hunting for a loan that
     would match when the answer is that none can. */
  const brokenAndUnasked = audit.standing(
    RULE({ when: { combinator: 'and', rules: [{ field: 'gone_field', operator: 'eq', value: 1 }] } }),
    asked(4000, 0));
  eq('E5 a broken rule is reported as BROKEN, never as "never fired"', (brokenAndUnasked || {}).verdict, 'broken');
  ok('E6 …and its reason names the field rather than the loan',
    /gone_field/.test(String((brokenAndUnasked || {}).headline || '')), (brokenAndUnasked || {}).headline);

  /* ⛔ THE BOUNDARY E5 DOES NOT REACH. E5's fixture is `asked(4000, 0)`, so it
     pins BROKEN ahead of NEVER-FIRED and never touches broken-vs-NOT-ASKED —
     the audit moved a `seen === 0` branch above the broken branch and the suite
     stayed at 103 passed. That is the live window between saving a broken rule
     and the first board priced with it in force: precisely when an officer
     checks whether the rule they just wrote works, and precisely the licensing
     block db/697's header names. Reporting "nobody has priced a board it
     governs yet" about a rule that can never match anything sends them away
     satisfied. Bounded — once any board is priced a broken rule gets
     boardsSeen 1 AND unreadable 1 — but the window is the one that matters. */
  const brokenNeverAsked = audit.standing(
    RULE({ when: { combinator: 'and', rules: [{ field: 'gone_field', operator: 'eq', value: 1 }] } }),
    asked(0, 0));
  eq('E5b a broken rule NOBODY HAS PRICED YET is still reported as broken',
    (brokenNeverAsked || {}).verdict, 'broken');
  /* The control that makes E5b a boundary rather than a coincidence: the same
     ledger row, a rule that is merely unused, must still read as not-asked. */
  eq('E5c …while a HEALTHY rule nobody has priced is not-yet-asked',
    (audit.standing(RULE(), asked(0, 0)) || {}).verdict, 'not_asked');

  eq('E7 switched off outranks every finding about firing',
    (audit.standing(RULE({ enabled: false }), asked(4000, 0)) || {}).verdict, 'off');
  eq('E8 archived likewise',
    (audit.standing(RULE({ archivedAt: '2026-01-01T00:00:00Z' }), asked(4000, 0)) || {}).verdict, 'archived');
  ok('E9 …and archived is read off `archivedAt`, the shape the store actually exposes',
    (audit.standing(RULE({ archivedAt: '2026-01-01T00:00:00Z' }), null) || {}).archived === true);

  const refused = audit.standing(RULE(), Object.assign(asked(50, 0), {
    total: { boardsSeen: 50, boardsMatched: 0, quotesReached: 0, quotesAdjusted: 0, quotesRefused: 0, rowsBlocked: 0, unreadable: 3 },
  }));
  eq('E10 a rule boards REFUSED to read is broken even though it reads fine now', (refused || {}).verdict, 'broken');
  ok('E11 …and says how many times',
    /3 times/.test(String((refused || {}).headline || '')), (refused || {}).headline);

  const noLedger = audit.standing(RULE(), null);
  eq('E12 a rule with no ledger row at all reads as not-yet-asked', (noLedger || {}).verdict, 'not_asked');
  ok('E13 …and never as "it has never fired", which would be an accusation',
    !/never matched/i.test(String((noLedger || {}).headline || '')), (noLedger || {}).headline);
}

// ═══════════════════════════════════════════════════════════════════════════
// F · THE TABLE — worst first, and the headline names the work
// ═══════════════════════════════════════════════════════════════════════════
{
  console.log('\nF · the whole centre at a glance');

  const rules = [
    RULE({ id: 'ok', name: 'Healthy', priority: 50 }),
    RULE({ id: 'bad', name: 'Broken', priority: 90, when: { combinator: 'and', rules: [{ field: 'zzz', operator: 'eq', value: 1 }] } }),
    RULE({ id: 'quiet', name: 'Quiet', priority: 10 }),
  ];
  const byRule = new Map([
    ['ok', { total: { boardsSeen: 10, boardsMatched: 5 }, engines: {} }],
    ['bad', { total: { boardsSeen: 10, boardsMatched: 0 }, engines: {} }],
    ['quiet', { total: { boardsSeen: 4000, boardsMatched: 0 }, engines: {} }],
  ]);
  const out = audit.auditAll(rules, byRule, { days: 90 });

  eq('F1 the broken rule is first, whatever its order in the centre', ((out.rows || [])[0] || {}).name, 'Broken');
  eq('F2 the never-fired one is next', ((out.rows || [])[1] || {}).name, 'Quiet');
  eq('F3 the healthy one is last', ((out.rows || [])[2] || {}).name, 'Healthy');
  ok('F4 the headline names the work rather than counting rules',
    /cannot run/i.test(String(out.summary || '')), out.summary);

  const clean = audit.auditAll([RULE({ id: 'ok', name: 'Healthy' })],
    new Map([['ok', { total: { boardsSeen: 10, boardsMatched: 5 }, engines: {} }]]), {});
  ok('F5 with nothing wrong it says so plainly',
    /firing|waiting/i.test(String(clean.summary || '')) && !/cannot run/i.test(String(clean.summary || '')), clean.summary);

  const empty = audit.auditAll([], new Map(), {});
  ok('F6 an empty centre states the safety property rather than reading as broken',
    /rate sheets/i.test(String(empty.summary || '')), empty.summary);

  const staleOnly = audit.auditAll([RULE({ id: 's', name: 'S' })],
    new Map([['s', { total: { boardsSeen: 20, boardsMatched: 0 }, everFiredAt: '2026-01-01T00:00:00Z', engines: {} }]]), {});
  ok('F7 a rule that is merely quiet lately is not reported as an accusation',
    /fired before/i.test(String(staleOnly.summary || '')), staleOnly.summary);
}

// ═══════════════════════════════════════════════════════════════════════════
// G · THE FIRE DRILL — every rule, one loan
// ═══════════════════════════════════════════════════════════════════════════
{
  console.log('\nG · trying every rule against one loan');

  const rules = [
    RULE({ id: 'fires', name: 'Fires' }),
    RULE({ id: 'misses', name: 'Misses', when: { combinator: 'and', rules: [{ field: 'ltv', operator: 'gt', value: 99 }] } }),
    RULE({ id: 'offrule', name: 'Off', enabled: false }),
    RULE({ id: 'other', name: 'Other board', engine: 'combined' }),
    RULE({ id: 'brk', name: 'Broken', when: { combinator: 'and', rules: [{ field: 'nope', operator: 'eq', value: 1 }] } }),
  ];
  const out = audit.dryRun(rules, { ltv: 85 }, { engine: 'general' });
  const by = Object.fromEntries((out.rows || []).map((r) => [r.ruleId, r]));

  ok('G1 a matching rule on this board fires', (by.fires || {}).wouldRun === true);
  ok('G2 a rule whose conditions miss does not', (by.misses || {}).wouldRun === false);
  ok('G3 a switched-off rule is still JUDGED — testing before turning it on is the point',
    (by.offrule || {}).fires === true);
  ok('G4 …but it would not run', (by.offrule || {}).wouldRun === false);
  ok('G5 a rule written for the other board matches and still would not run',
    (by.other || {}).fires === true && (by.other || {}).wouldRun === false);
  ok('G6 …and says so separately, so a perfect match on the wrong board is obvious',
    (by.other || {}).governs === false);
  ok('G7 a broken rule never "fires"', (by.brk || {}).wouldRun === false && (by.brk || {}).broken === true);
  ok('G8 the firing ones sort to the top', ((out.rows || [])[0] || {}).wouldRun === true);
  ok('G9 the summary counts what would actually run',
    /1 of 5/.test(String(out.summary || '')), out.summary);

  const noneFire = audit.dryRun([rules[1]], { ltv: 85 }, { engine: 'general' });
  ok('G10 nothing firing is stated plainly',
    /No rule would fire/.test(String(noneFire.summary || '')), noneFire.summary);
}

// ═══════════════════════════════════════════════════════════════════════════
// H · NOTHING HERE MAY EVER THROW, AND NOTHING HERE WRITES
// ═══════════════════════════════════════════════════════════════════════════
{
  console.log('\nH · total, and read-only');

  const junk = [null, undefined, 0, '', [], {}, { when: null }, { when: 'x', then: 'y' },
    { when: { combinator: 'and', rules: null } }, { when: { combinator: 'and', rules: [null] } },
    { then: [null] }, { then: [{ type: '__proto__' }] }];
  let threw = null;
  for (const j of junk) {
    for (const f of [{}, null, { ltv: 85 }]) {
      try { diagnose.diagnose(j, f); audit.standing(j, null, {}); } catch (e) { threw = threw || `${JSON.stringify(j)}: ${e.message}`; }
    }
  }
  ok('H1 a malformed rule is judged, never thrown on', threw === null, threw);

  let threw2 = null;
  for (const j of [null, undefined, 'x', 0, {}, { rows: null }]) {
    try { audit.auditAll(j, null, {}); audit.dryRun(j, null, {}); firing.deltasFrom(j, {}); firing.merge(j); } catch (e) { threw2 = threw2 || e.message; }
  }
  ok('H2 the table and the drill survive junk too', threw2 === null, threw2);

  const dsrc = stripComments(src('src/longterm/pricing/rules/diagnose.js'));
  const asrc = stripComments(src('src/longterm/pricing/rules/audit.js'));
  const fsrc = stripComments(src('src/longterm/pricing/rules/firing.js'));
  ok('H3 the diagnosis reaches no database', !/require\(['"].*\/db['"]\)/.test(dsrc));
  ok('H4 the verdict reaches no database', !/require\(['"].*\/db['"]\)/.test(asrc));
  ok('H5 the counting reaches no database', !/require\(['"].*\/db['"]\)/.test(fsrc));
  ok('H6 none of the three reads a clock the caller did not pass',
    !/Date\.now\(\)/.test(dsrc) && !/Date\.now\(\)/.test(asrc));
  ok('H7 the counting judges "in force" with the overlay\'s OWN test, never a second copy',
    /overlay\.governs\(/.test(fsrc));
}

// ═══════════════════════════════════════════════════════════════════════════
// I · THE WRITER MAY NEVER COST A BOARD ITS PRICE
// ═══════════════════════════════════════════════════════════════════════════
{
  console.log('\nI · the recorder is unable to break pricing');

  const lsrc = stripComments(src('src/longterm/pricing/rules/ledger.js'));
  ok('I1 recording a board is SYNCHRONOUS — an unawaited async recorder is an unhandled rejection on the pricing path',
    /^function record\(/m.test(lsrc) && !/async function record\(/.test(lsrc));
  /* ⛔ THE ONE CONTRACT THIS FILE'S HEADER CALLS ABSOLUTE, AND IT IS RUN, NOT
     GREPPED. This assertion used to be a regex over the source
     (`/catch \(e\) \{[\s\S]{0,400}counters\.failures/`) — and the post-merge
     audit put `throw e;` immediately AFTER `counters.failures += 1`, which the
     regex still matched, so the suite reported 103 passed with the recorder
     re-throwing on the live pricing path. `record()` is called synchronously
     and UNAWAITED from general-board.js and combined-pricer.js, so a throw
     there costs the board its price — the exact thing the module exists not to
     do. A regex can see that a catch block mentions the counter; only calling
     it can see whether anything escapes. */
  const ledgerMod = require('../src/longterm/pricing/rules/ledger');
  ledgerMod.reset();
  const failuresBefore = ledgerMod.stats().failures;
  let escaped = null;
  try {
    /* A result that throws the moment the aggregator reads it — the shape a
       malformed overlay answer really takes. */
    ledgerMod.record({ ran: true, get applied() { throw new Error('boom from overlay result'); } },
      { rules: [RULE()], engine: 'general' });
  } catch (e) { escaped = e; }
  ok('I2 a malformed result loses a COUNT, never a board — nothing escapes record()',
    escaped === null, escaped ? String(escaped.message) : '');
  ok('I2b …and the failure is COUNTED rather than silently discarded',
    ledgerMod.stats().failures === failuresBefore + 1,
    'failures went ' + failuresBefore + ' -> ' + ledgerMod.stats().failures);
  ledgerMod.reset();
  ok('I3 the flush upsert ADDS rather than replaces — two processes flush the same day',
    /lt_pricing_rule_firing\.boards_seen\s*\+\s*EXCLUDED\.boards_seen/.test(lsrc));
  ok('I4 …and never overwrites a day\'s total with one window\'s',
    !/boards_seen\s*=\s*EXCLUDED\.boards_seen\b/.test(lsrc));
  ok('I5 the buffer is bounded, so a database outage cannot become an out-of-memory crash',
    /MAX_KEYS/.test(lsrc) && /counters\.dropped/.test(lsrc));

  /* ⛔ THE DENOMINATOR ACCUMULATES WITHIN A FLUSH WINDOW, AND THAT IS RUN TOO.
     `boardsSeen` is what makes "matched 0" mean "the rule is wrong" rather than
     "nobody has priced a board it governs" — the distinction this whole feature
     exists for. `fold` is the THIRD copy of the adds-not-replaces property
     (`firing.merge` is pinned by D15, the SQL upsert by I3/I4 and by C1/E3 in
     the database suite) and it was the only unpinned one: the audit changed
     `cur.boardsSeen +=` to `=` and both suites stayed green while three boards
     priced inside one 15-second window recorded 1 instead of 3. Under-counting
     the denominator pushes rules toward "not asked" and AWAY from "never fired"
     — it hides exactly the rules the engine was built to surface. */
  ledgerMod.reset();
  const oneBoard = () => ledgerMod.record(
    { ran: true, applied: [], ineligible: [], blocked: [], unreadable: [] },
    { rules: [RULE()], engine: 'general' });
  oneBoard(); oneBoard(); oneBoard();
  const held = [...ledgerMod._internals.buffer.values()];
  ok('I5b three boards in one flush window are three boards, not one',
    held.length === 1 && held[0].boardsSeen === 3,
    held.length + ' key(s), boardsSeen=' + (held[0] && held[0].boardsSeen));
  ledgerMod.reset();
  ok('I6 the drain timer is unref\'d, so it never holds a script or a test runner open',
    /unref\(\)/.test(lsrc));

  const gb = stripComments(src('src/longterm/pricing/general-board.js'));
  ok('I7 the general board records what its rules did', /ledger\.record\(/.test(gb));
  ok('I8 …without awaiting it in front of the board', !/await\s+ledger\.record\(/.test(gb));

  const cp = stripComments(src('src/longterm/routes/combined-pricer.js'));
  const recs = (cp.match(/ledger\.record\(/g) || []).length;
  eq('I9 the combined board records ONCE — the ?shape=options pass is the same board again', recs, 1);

  /* ⛔ EVERY CALLER OF THE RECORDER ACTUALLY REQUIRES IT.
     `ledger.record(...)` with no `require` PARSES PERFECTLY — `ledger` is a
     valid identifier — so `node --check`, the build and every source guard pass
     while the module throws `ReferenceError` on the FIRST board it prices. That
     is exactly what shipped in the first cut of this change: the combined
     engine's require was missed, and it was caught by an unrelated database
     suite rather than by anything here. A call and its import are one fact. */
  for (const f of ['src/longterm/pricing/general-board.js', 'src/longterm/routes/combined-pricer.js']) {
    const body = stripComments(src(f));
    const calls = /\bledger\.record\(/.test(body);
    const imports = /\brequire\((['"])[^'"]*rules\/ledger\1\)/.test(body);
    ok(`I10 ${f.split('/').pop()} requires the recorder it calls`, !calls || imports,
      calls && !imports ? 'calls ledger.record with no require — ReferenceError on the first board' : '');
  }

  /* And the same fact proven by LOADING them, which is the only check that
     cannot be fooled by a require written some other way. */
  let loadErr = null;
  try {
    const gbMod = require('../src/longterm/pricing/general-board');
    const cpMod = require('../src/longterm/routes/combined-pricer');
    if (!gbMod || !cpMod) loadErr = 'a module loaded as nothing';
  } catch (e) { loadErr = e.message; }
  ok('I11 both engines load with every module they reference resolvable', loadErr === null, loadErr);
}

// ═══════════════════════════════════════════════════════════════════════════
// J · THE DOOR
// ═══════════════════════════════════════════════════════════════════════════
{
  console.log('\nJ · the audit door');

  const rsrc = stripComments(src('src/longterm/routes/pricing-rules.js'));
  const idAt = rsrc.indexOf("router.get('/:id'");
  const auditAt = rsrc.indexOf("router.get('/audit'");
  ok('J1 the audit door exists', auditAt !== -1);
  ok('J2 …and is registered BEFORE `/:id`, which matches anything', auditAt !== -1 && auditAt < idAt,
    `audit at ${auditAt}, /:id at ${idAt}`);
  ok('J3 the fire drill exists', /router\.post\('\/audit\/dry-run'/.test(rsrc));
  ok('J4 it reports an unreadable ledger rather than drawing zeroes', /ledgerProblem/.test(rsrc));
  ok('J5 the drill builds its facts with the board\'s own module, never a hand-made bag',
    /facts\.factsFor\(/.test(rsrc));

  const screen = stripComments(src('app-v2/src/longterm/LtPricingRules.jsx'));
  ok('J6 the screen has an audit view', /AuditView/.test(screen));
  ok('J7 …which reads its verdicts from the server rather than working them out',
    /pricingRuleAudit\(/.test(screen));
  ok('J8 …and the drill likewise', /pricingRuleDryRun\(/.test(screen));
  ok('J9 the screen never decides for itself whether a rule is broken',
    !/\bdiagnose\b/.test(screen));
  ok('J10 every colour on it is an explicit dark, never an `--ink` token',
    !/var\(--ink/.test(screen));
}

// ═══════════════════════════════════════════════════════════════════════════
const total = pass + failures.length;
console.log(`\n${failures.length ? 'FAILED' : 'ALL PASSED'} (${pass} passed, ${failures.length} failed of ${total})`);
if (failures.length) { failures.forEach((f) => console.log(`  · ${f}`)); process.exit(1); }
