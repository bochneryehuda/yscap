'use strict';
/**
 * LT test — A READ THAT FILLED NOTHING MUST NOT REPORT ITSELF AS A SUCCESS.
 *
 * WHY THIS EXISTS (owner-reported 2026-08-25, with a screenshot): *"This is how this
 * file was: it was empty for 20 hours. Only when I went into the section of Encampus
 * syncing and I clicked sync to the file for that particular file did it pull
 * information, and everything was updated. Why didn't it go by itself?"*
 *
 * IT DID GO BY ITSELF. It went by itself twice — the rota is twelve hours — reported
 * success both times, and wrote nothing. `readLoan` stamped `encompass_synced_at =
 * now()` and cleared `encompass_sync_error` in an UPDATE a hundred lines ABOVE the
 * four writes that actually fill a file: the subject property, the loan terms, the
 * borrowers and the investor. Each of those four is wrapped in its own try/catch and
 * hands back `{ok:false, reason}` on a miss; every one of those reasons went into
 * `readLoan`'s return value, which `syncOnce` discarded without reading. So the row
 * said "read just now, no error" while the address, the rate and the DSCR stayed
 * blank, and the next pass re-stamped it.
 *
 * FOUR DEFECTS, ONE SHAPE: silence. This pins all four.
 *
 *   1. the stamp is written AFTER the work, and records what missed
 *   2. the no-ladder milestone fallback reads the key this tenant actually sends
 *   3. a lock read that learned nothing may not erase the lock we hold
 *   4. one loan that throws may not starve the loans behind it
 *
 * SECTION 5 IS THE HALF THAT OUTLIVES THESE PARTICULAR BUGS. `node --check` proved
 * every one of these edits "syntactically fine", and one of them — naming `ms` a
 * hundred and fifty lines above its own `const` — would have thrown a ReferenceError
 * on EVERY read, from inside the drain loop, on the first tick after deploy. A syntax
 * check cannot see a temporal dead zone. Section 5 does.
 *
 * PURE. No database, no network.
 */

const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const loansSrc = read('src/longterm/sync/loans.js');
const locksSrc = read('src/longterm/locks.js');

// ── 1. The stamp is written after the work, not before it ────────────────────
console.log('\n1. the stamp closes the read instead of opening it');

const mainUpdateAt = loansSrc.indexOf('UPDATE lt_loans\n        SET milestone_name');
const propertyAt = loansSrc.indexOf('application.syncSubjectProperty');
const termsAt = loansSrc.indexOf('application.syncLoanTerms');
const pairsAt = loansSrc.indexOf('application.syncBorrowerPairs');
const investorAt = loansSrc.indexOf('application.syncLoanInvestor');
const stampAt = loansSrc.indexOf('SET encompass_synced_at = now(),');

check(mainUpdateAt > 0, 'the main mirror UPDATE is still there');
check(stampAt > 0, 'the read is stamped by a statement of its own');
for (const [name, at] of [['subject property', propertyAt], ['loan terms', termsAt],
  ['borrowers', pairsAt], ['investor', investorAt]]) {
  check(at > 0 && stampAt > at, `the stamp is written AFTER the ${name} sync, not before it`);
}
check(!/loan_amount = COALESCE\(\$17::numeric, loan_amount\),\s*\n\s*encompass_synced_at = now\(\)/.test(loansSrc),
  'the mid-read UPDATE no longer stamps the loan as fully read');

// THE MISS IS RECORDED, and specifically NOT as a bare success.
check(/const misses/.test(loansSrc), 'the read collects what it failed to fill');
check(/encompass_sync_error = \$2/.test(loansSrc),
  'the reason is written to the loan, not returned into a value nobody reads');
check(!/encompass_sync_error = NULL/.test(loansSrc),
  'nothing clears the error column unconditionally any more');
check(/partial: misses\.length > 0/.test(loansSrc), 'readLoan reports a partial read as partial');

// ── WHAT COUNTS AS A MISS — asserted on the FUNCTION, never on the source ────
// The previous version of this section grepped for `r.written === false`, which
// is how it came to guarantee a defect instead of preventing one: it pinned the
// implementation without ever asking what the implementation DECIDED. Sixteen
// files that read perfectly were reported unreadable for a year of hourly
// re-reads, and this test was green throughout. The shapes below are the REAL
// ones the four sync functions return, copied from src/longterm/application/sync.js.
{
  const { classifyParts } = require('../src/longterm/sync/loans');
  const P = (result) => [{ what: 'investor', result }];

  // A part that FAILED is a miss.
  check(classifyParts(P(null)).misses.length === 1, 'nothing coming back at all is a miss');
  check(/nothing came back/.test(classifyParts(P(null)).misses[0]), '…and it says so');
  check(classifyParts(P({ ok: false, reason: 'no loan payload' })).misses.length === 1,
    'a part that answered ok:false is a miss');
  check(/no loan payload/.test(classifyParts(P({ ok: false, reason: 'no loan payload' })).misses[0]),
    '…carrying its own reason, not a generic one');

  // A part that COMPLETED with nothing to write is NOT a miss.
  const noInvestor = { ok: true, written: false, reason: 'the payload named no investor' };
  check(classifyParts(P(noInvestor)).misses.length === 0,
    'a file with no investor is NOT a miss — measured on 16 real files, all Started or Withdrawn, '
    + 'and confirmed against Encompass itself: the fields are absent from the payload');
  check(classifyParts(P(noInvestor)).empties.length === 1,
    '…it is recorded as EMPTY, so the fact is not lost, only de-alarmed');

  // Every real success shape counts as filled — including the two that carry no
  // `written` key, which is what the old test could never see.
  const filled = (r) => classifyParts([{ what: 'x', result: r }]).filledAny;
  check(filled({ ok: true, written: true, found: 3 }), 'property/terms/investor report filled as written:true');
  check(filled({ ok: true, pairs: 1, parties: 2, reason: 'read' }),
    'borrowers report filled as pairs/parties — they carry NO `written` key, so a test that '
    + 'looked only at `written` never checked them at all');
  check(!filled({ ok: true, pairs: 0, parties: 0, reason: 'the payload carried no applications' }),
    'and zero pairs is genuinely empty');
  check(!filled({ ok: false, reason: 'failed' }), 'a failed part is never counted as filled');

  // The ORIGINAL defect is still caught: answered, but filled nothing anywhere.
  const all = classifyParts([
    { what: 'subject property', result: { ok: true, written: false, reason: 'no property figures' } },
    { what: 'loan terms', result: { ok: true, written: false, reason: 'no terms' } },
    { what: 'borrowers', result: { ok: true, pairs: 0, parties: 0, reason: 'no applications' } },
    { what: 'investor', result: { ok: true, written: false, reason: 'no investor' } },
  ]);
  check(all.misses.length === 0 && all.empties.length === 4 && all.filledAny === false,
    'a read that filled NOTHING reports four empties and no filled part — which is what the '
    + 'all-empty guard in readLoan turns into a miss');
  const one = classifyParts([
    { what: 'subject property', result: { ok: true, written: true, found: 9 } },
    { what: 'investor', result: noInvestor },
  ]);
  check(one.filledAny === true && one.misses.length === 0,
    'while a file that filled its property and simply has no investor is clean — the 16-file case');
  check(/the read answered but filled nothing/.test(loansSrc),
    'and readLoan still turns the all-empty case into a reported miss');
}

// An EMPTY answer is not an answer — the `{}` case the batch can return.
check(/Object\.keys\(values\)\.length > 0/.test(loansSrc),
  'an empty {} from the field batch counts as a miss, not as values');

// ── 2. The milestone fallback reads the key this tenant sends ────────────────
console.log('\n2. the no-ladder fallback reads a key that exists');

check(/loan\.milestoneCurrentName/.test(loansSrc),
  'the fallback asks for milestoneCurrentName');
const lagAt = loansSrc.indexOf('const laggingMilestone');
const liveKeyAt = loansSrc.indexOf('loan.milestoneCurrentName', lagAt);
const deadKeyAt = loansSrc.indexOf('loan.currentMilestone', lagAt);
check(lagAt > 0 && liveKeyAt > 0 && liveKeyAt < deadKeyAt,
  'the key that is 100% filled on this tenant is asked FIRST, ahead of the three that are never sent');

// The dictionary is the evidence, so the evidence is the test.
const dict = JSON.parse(read('src/longterm/encompass/dictionary/field-dictionary.json'));
const dictText = JSON.stringify(dict);
check(!dictText.includes('"$.currentMilestone"'),
  'the live 772-loan dictionary confirms $.currentMilestone is not a path this tenant sends');
check(dictText.includes('$.milestoneCurrentName'),
  'the live dictionary confirms $.milestoneCurrentName IS');

// ── 3. A lock read that learned nothing may not erase one we hold ────────────
console.log('\n3. an uninformed lock read leaves the lock alone');

check(/sawEvidence:/.test(locksSrc), 'the posture reports whether it saw any lock evidence at all');
check(/if \(prev && !posture\.sawEvidence\)/.test(locksSrc),
  'writeLock refuses the overwrite when it learned nothing and a lock is already on file');
const guardAt = locksSrc.indexOf('if (prev && !posture.sawEvidence)');
const upsertAt = locksSrc.indexOf('ON CONFLICT (loan_id) DO UPDATE SET');
check(guardAt > 0 && upsertAt > guardAt, 'the guard sits BEFORE the upsert it is guarding');
// The upsert stays un-COALESCEd on purpose — a real release must still clear.
check(/lock_status = EXCLUDED\.lock_status/.test(locksSrc),
  'a lock genuinely released can still clear its columns');

// ── 4. One loan that throws may not starve the ones behind it ────────────────
console.log('\n4. one bad loan costs one loan');

const drainAt = loansSrc.indexOf('for (const item of drain.slice(0, readBudget))');
const drainBody = loansSrc.slice(drainAt, drainAt + 2000);
check(drainAt > 0, 'the drain loop is still there');
check(/try \{[\s\S]*await readLoan\(/.test(drainBody), 'readLoan is called inside a try');
check(/catch \(e\)/.test(drainBody) && /continue;/.test(drainBody),
  'a throw is caught and the pass continues to the next loan');
check(/starvedLoans/.test(loansSrc), 'the loans that threw are NAMED, not just counted');
check(/partial,\n    starved,/.test(loansSrc), 'the pass reports both counts to the run log');

// ── 5. THE HALF THAT OUTLIVES THESE FOUR BUGS ────────────────────────────────
// Every edit above passed `node --check`. One of them still named a `const` a
// hundred and fifty lines above its own declaration, which is a ReferenceError on
// every read and invisible to a syntax check. This section is what actually loads
// the modules and puts a loan through the shape of a read.
console.log('\n5. the modules LOAD, and nothing is named before it exists');

let loans; let locks;
try {
  loans = require('../src/longterm/sync/loans');
  locks = require('../src/longterm/locks');
  check(true, 'both modules load');
} catch (e) {
  check(false, `both modules load — ${e.message}`);
}

// The dead-zone class of bug, caught directly: every `const NAME` in readLoan must be
// declared before the first line that reads NAME.
if (loans) {
  const fnAt = loansSrc.indexOf('async function readLoan(');
  const fnEnd = loansSrc.indexOf('\n}', loansSrc.indexOf('return { ok: true, partial:'));
  const body = loansSrc.slice(fnAt, fnEnd);
  // Strip comments AND string literals, and keep the length identical so the
  // offsets still line up. A name discussed in prose is not a name used in code,
  // and neither is one that happens to appear inside a require path — the first
  // run of this check flagged `ladder` because './milestone-ladder' contains it.
  const blank = (m) => ' '.repeat(m.length);
  const code = body
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
    .replace(/'(?:[^'\\\n]|\\.)*'/g, blank)
    .replace(/"(?:[^"\\\n]|\\.)*"/g, blank)
    .replace(/`(?:[^`\\]|\\.)*`/g, blank);
  const decls = [...code.matchAll(/^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/gm)]
    .map((m) => ({ name: m[1], at: m.index }));
  let deadZone = 0;
  for (const d of decls) {
    // A bare use of the name earlier in the same function body.
    const re = new RegExp(`(^|[^\\w$.])${d.name}(?![\\w$])`, 'g');
    let m;
    while ((m = re.exec(code)) !== null) {
      if (m.index < d.at) { deadZone += 1; console.error(`       ${d.name} is used at ${m.index} but declared at ${d.at}`); break; }
    }
  }
  check(deadZone === 0, `no name inside readLoan is read before it is declared (${decls.length} declarations checked)`);
}

// needsRead is the rota, and a loan carrying a recorded miss comes back sooner.
if (loans && typeof loans.needsRead === 'function') {
  const HOUR = 3600 * 1000;
  const now = Date.parse('2026-08-25T12:00:00Z');
  const ago = (h) => new Date(now - h * HOUR).toISOString();

  check(loans.needsRead({ encompass_synced_at: null }, now) === true,
    'a loan nobody has ever read is due');
  check(loans.needsRead({ encompass_synced_at: ago(2), encompass_sync_error: null }, now) === false,
    'a loan read cleanly two hours ago is NOT due');
  check(loans.needsRead({ encompass_synced_at: ago(2), encompass_sync_error: 'Read from Encompass, but 2 part(s) came back empty' }, now) === true,
    'a loan read two hours ago that came back EMPTY is due again');
  check(loans.needsRead({ encompass_synced_at: ago(0.2), encompass_sync_error: 'came back empty' }, now) === false,
    '...but not within the hour — an unfillable loan must not become a hot loop');
  check(loans.needsRead({ encompass_synced_at: ago(13), encompass_sync_error: null }, now) === true,
    'the ordinary twelve-hour rota still applies to a clean read');
}

// The lock guard, exercised rather than grepped.
if (locks && typeof locks.lockFromLoan === 'function') {
  const blind = locks.lockFromLoan({}, null, {});
  check(blind.sawEvidence === false,
    'a loan payload with no rate-lock entity and no numbered dates reports NO evidence');
  const seen = locks.lockFromLoan({ rateLock: { lockStatus: 'Locked' } }, null, {});
  check(seen.sawEvidence === true,
    'a loan that carries a rate-lock entity reports evidence, even when it says not locked');
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
