#!/usr/bin/env node
'use strict';
/**
 * THE CONDITION RULES RUN BY THEMSELVES — the WIRING, without a database.
 *
 * The database suite (`test-lt-condition-rules-db.js`) proves the sweep does
 * the right thing when it is called. This proves it IS called, from the two
 * places the owner's sentence requires, and that "is this loan due" has ONE
 * definition rather than two that can drift:
 *
 *   A. The sync worker runs the sweep on every tick, under its own run-log
 *      name, after the loan drain (so a loan read this tick is evaluated this
 *      tick).
 *   B. The file's own conditions read runs the engine first when the loan is
 *      due, and reports what it did in the response.
 *   C. The predicate is ONE string, used by both "which loans" and "this
 *      loan" — the sweep and the screen cannot disagree about "due".
 *   D. The engine stamps the loan on a clean pass and not on an unclean one.
 *   E. The screen no longer tells anybody the button is the only way.
 *   F. The off switch exists and reads the sync's own grammar.
 *
 * Every source read strips comments first, so a guard can never be satisfied
 * by its own explanation.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

let pass = 0;
const fails = [];
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); return; }
  fails.push(detail ? `${name} — ${detail}` : name);
  console.log('  ✗ ' + name + (detail ? ` — ${detail}` : ''));
};

const sweep = require('../src/longterm/conditions-center/sweep.js');

console.log('\nA. THE WORKER RUNS THE SWEEP ON EVERY TICK');
{
  const src = strip(read('src/longterm/sync/worker.js'));
  ok(/require\('\.\.\/conditions-center\/sweep'\)/.test(src), 'the worker requires the sweep');
  ok(/runLog\.record\('condition_rules',\s*trigger,\s*\(\)\s*=>\s*conditionRules\.sweepOnce\(\{\}\)\)/.test(src),
    'and runs it under its own run-log name, so the Sync screen can say whether it ran');
  const loansAt = src.indexOf("runLog.record('loans'");
  const rulesAt = src.indexOf("runLog.record('condition_rules'");
  ok(loansAt > 0 && rulesAt > loansAt, 'AFTER the loan drain, so a loan read this tick is evaluated this tick');
  ok(/out\.conditionRules\s*=\s*\{\s*ok:\s*false/.test(src), 'a sweep that throws is reported, never allowed to stop the tick');
}

console.log('\nB. THE FILE\'S OWN READ RUNS THE RULES FIRST');
{
  const src = strip(read('src/longterm/routes/condition-center.js'));
  ok(/require\('\.\.\/conditions-center\/sweep'\)/.test(src), 'the route requires the sweep');
  const get = src.slice(src.indexOf("router.get('/loans/:loanId'"), src.indexOf("router.post('/loans/:loanId/evaluate'"));
  ok(/await sweep\.evaluateIfStale\(scoped\.loan\.id,\s*\{\s*db\s*\}\)/.test(get),
    'THE ONE THAT MATTERS: the conditions GET evaluates a due loan before reading the list');
  ok(get.indexOf('sweep.evaluateIfStale') < get.indexOf('read.forLoan'), '…BEFORE the list is read, not after');
  ok(/rules,/.test(get), 'and the response carries what the rules did, so the screen can say so');
}

console.log('\nC. "DUE" HAS ONE DEFINITION');
{
  const one = sweep.staleSql('l', '$1');
  ok(/conditions_evaluated_at IS NULL/.test(one), 'never evaluated is due');
  ok(/encompass_synced_at > l\.conditions_evaluated_at/.test(one), 'a mirror that moved since is due');
  ok(/conditions_evaluated_at < \$1::timestamptz/.test(one), 'a library that moved since is due');
  const dueSql = sweep._internals.dueSql();
  const oneSql = sweep._internals.oneSql();
  ok(dueSql.includes(one) && oneSql.includes(one), 'both doors ask the question in the same words — the predicate is one string, not two');
  ok(/ORDER BY l\.conditions_evaluate_tried_at ASC NULLS FIRST/.test(dueSql),
    'the batch walks the oldest ATTEMPT first, so an unreadable file cannot starve the rest');
  ok(/LIMIT \$2/.test(dueSql), 'and is bounded');
  const src = strip(read('src/longterm/conditions-center/sweep.js'));
  ok(/notTrashSql\('l'\)/.test(src), 'a loan in the trash is never evaluated');
}

console.log('\nD. THE ENGINE STAMPS THE LOAN, AND ONLY ON A CLEAN PASS');
{
  const src = strip(read('src/longterm/conditions-center/engine.js'));
  ok(/SELECT clock_timestamp\(\) AS t/.test(src) && src.indexOf('let startedAt') < src.indexOf('await loadContext(loanId, client)'),
    'the DATABASE clock is read BEFORE the context, so the stamp is the start of the pass in the same clock the sync writes');
  ok(/out\.clean = out\.ok && !out\.degraded && !out\.skipped\.some/.test(src),
    'a pass is clean only when every table was read and every decision written');
  ok(/SET conditions_evaluate_tried_at = clock_timestamp\(\)/.test(src), 'every attempt is stamped as tried, in real time even inside a transaction');
  ok(/conditions_evaluated_at = CASE WHEN \$2::boolean THEN \$3::timestamptz ELSE conditions_evaluated_at END/.test(src),
    '…and evaluated only when clean — an unclean pass leaves the loan due');
  ok(/opts\.stamp !== false/.test(src), 'a caller can ask for no stamp (a preview must never mark a loan current)');
}

console.log('\nE. THE SCREEN NO LONGER MAKES THE BUTTON THE ONLY WAY');
{
  const src = strip(read('app-v2/src/longterm/LtFileConditions.jsx'));
  ok(!/Press <strong>Re-check the rules<\/strong>\s*\{' '\}\s*to run the library against it/.test(src),
    'the empty state no longer says pressing the button is how conditions arrive');
  ok(/The rules run by themselves/.test(src), 'it says the rules run by themselves');
  ok(/data\.rules && data\.rules\.evaluated/.test(src), 'and the screen says when the rules ran as the file opened and changed something');
}

console.log('\nF. THE OFF SWITCH');
{
  const saved = process.env.LT_CONDITION_RULES_ENABLED;
  try {
    delete process.env.LT_CONDITION_RULES_ENABLED;
    ok(sweep.enabled() === true, 'blank means ON — the owner asked for it to run by itself');
    for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
      process.env.LT_CONDITION_RULES_ENABLED = v;
      ok(sweep.enabled() === false, `"${v}" turns it off`);
    }
    process.env.LT_CONDITION_RULES_ENABLED = '1';
    ok(sweep.enabled() === true, '"1" is on');
    delete process.env.LT_CONDITION_RULES_PER_PASS;
    ok(sweep.perPass() === 40, 'the default batch is 40 loans per tick');
    process.env.LT_CONDITION_RULES_PER_PASS = '7';
    ok(sweep.perPass() === 7, 'and it is settable without a deploy');
    process.env.LT_CONDITION_RULES_PER_PASS = 'nonsense';
    ok(sweep.perPass() === 40, 'an unreadable setting falls back rather than to zero or NaN');
  } finally {
    if (saved === undefined) delete process.env.LT_CONDITION_RULES_ENABLED; else process.env.LT_CONDITION_RULES_ENABLED = saved;
    delete process.env.LT_CONDITION_RULES_PER_PASS;
  }
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { fails.forEach((f) => console.error('  FAIL ' + f)); process.exit(1); }
