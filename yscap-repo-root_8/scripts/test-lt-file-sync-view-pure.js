'use strict';
/**
 * LT test — THE ENCOMPASS SECTION'S TWO LISTS ARE HELD TO THE CODE THAT FILLS THEM.
 *
 * `encompass/file-sync-view.js` answers the owner's *"see what it read and what it
 * didn't read"* with two lists: what the pipeline search brings back, and what
 * opening the loan adds. A list like that is a HAND-KEPT LIST, and this repo's own
 * rule about those is that they go stale silently — except this one would not go
 * quiet, it would go WRONG: a column named here that `loans.js` never writes makes
 * the section state, confidently, that Encompass gave us nothing for a field PILOT
 * never asked about. That is worse than not showing the list at all.
 *
 * So sections 1 and 2 READ `sync/loans.js` and check every column this module
 * claims is written where it claims. It is a source guard rather than a behaviour
 * test on purpose: the two writers are a single 20-line SQL statement each, no
 * amount of running them proves a column is ABSENT from one, and running them at
 * all needs Encompass and a database.
 *
 * PURE. No database, no network, no credentials.
 */

const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const view = require('../src/longterm/encompass/file-sync-view');
const LOANS_SRC = fs.readFileSync(path.join(__dirname, '..', 'src/longterm/sync/loans.js'), 'utf8');

/** The body of one function in loans.js, so a column can be looked for in the
 *  writer that is supposed to write it rather than anywhere in the file. */
function fnBody(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a + 1);
  if (a < 0 || b < 0) return null;
  return src.slice(a, b);
}

const DISCOVERY_SRC = fnBody(LOANS_SRC, 'async function upsertDiscovered', 'const REREAD_HOURS');
const READ_SRC = fnBody(LOANS_SRC, 'async function readLoan', 'async function syncOnce');

// ── 1. Every "from the pipeline search" column is written by discovery ────────
console.log('the pipeline-search list matches what discovery writes');

check(!!DISCOVERY_SRC, 'upsertDiscovered was located in loans.js — a rename must fail this file loudly, not silently stop checking');
for (const f of view.DISCOVERY_FIELDS) {
  check(!!DISCOVERY_SRC && DISCOVERY_SRC.includes(f.column),
    `discovery writes ${f.column} — the section says it comes from the pipeline search`);
}

// ── 2. Every "from opening the loan" column is written by the full read ───────
console.log('');
console.log('the full-read list matches what readLoan writes');

check(!!READ_SRC, 'readLoan was located in loans.js');
for (const f of view.FULL_READ_FIELDS) {
  check(!!READ_SRC && READ_SRC.includes(f.column),
    `the full read writes ${f.column} — the section says opening the loan brings it back`);
}

// AND THE OTHER DIRECTION, which is the half a list like this usually misses. A
// column DISCOVERY already fills must not appear in the full-read list: the full
// read writes several of them again, and crediting the read with a value that was
// there before it ran would tell somebody a read had succeeded when it had not.
console.log('');
console.log('a column discovery already fills is never credited to the full read');
const discoveryCols = new Set(view.DISCOVERY_FIELDS.map((f) => f.column));
for (const f of view.FULL_READ_FIELDS) {
  check(!discoveryCols.has(f.column),
    `${f.column} is not counted twice — the full-read list is what the read ADDS`);
}

// ── 3. Filled vs blank, and the difference between them ──────────────────────
console.log('');
console.log('a value is filled, or it is honestly blank');

const bare = view.fileSyncView({}, {});
check(bare.fields.discovery.filled === 0, 'an empty row has nothing filled in');
check(bare.fields.discovery.total === view.DISCOVERY_FIELDS.length, '…and still lists everything it would hold');
check(bare.fields.fullRead.filled === 0, 'the full-read list is empty too');
check(bare.identity.loanNumber === null, 'a missing loan number is null, never an empty string on screen');
check(bare.nudge.count === 0, 'a loan nobody has nudged reads as zero pings, which is a real answer');
check(bare.nudge.at === null && bare.nudge.viaWords === null,
  '…and never invents a time or a reason for a ping that never happened');

// A ZERO IS NOT A BLANK. A loan amount of 0 is a fact about the loan and "we could
// not read it" is not — reading the first as the second is this repo's oldest
// recurring bug (`Number('')` is 0).
const zero = view.fileSyncView({ loan_amount: 0, term_months: 0 }, {});
const amount = zero.fields.discovery.rows.find((r) => r.column === 'loan_amount');
const term = zero.fields.discovery.rows.find((r) => r.column === 'term_months');
check(amount.filled === true && amount.value === 0, 'a loan amount of ZERO counts as filled in, and keeps its zero');
check(term.filled === true && term.value === 0, '…and so does a term of zero');

const blankString = view.fileSyncView({ borrower_email: '' }, {});
const email = blankString.fields.fullRead.rows.find((r) => r.column === 'borrower_email');
check(email.filled === false, 'an EMPTY STRING is blank — Encompass returning "" is not an email address');

// ── 4. The rota, and when it refuses to guess ────────────────────────────────
console.log('');
console.log('the rota says when, or says nothing');

const NOW = Date.UTC(2026, 7, 25, 12, 0, 0);
check(view.nextRotaDue({ encompass_synced_at: '2026-08-25T00:00:00Z' }, NOW) === '2026-08-25T12:00:00.000Z',
  'twelve hours after the last read is when the rota comes round');
check(view.nextRotaDue({ encompass_synced_at: null }, NOW) === null,
  'a loan never read has no rota date — there is no clock to count from, and a guess here would promise a re-read at a time nothing will happen');
check(view.nextRotaDue({ encompass_synced_at: 'not a date' }, NOW) === null,
  'an unreadable stamp answers nothing rather than an invented date');

const saved = process.env.LT_ENCOMPASS_REREAD_HOURS;
process.env.LT_ENCOMPASS_REREAD_HOURS = '0';
check(view.rotaHours() === 0, 'the rota can be switched off');
check(view.nextRotaDue({ encompass_synced_at: '2026-08-25T00:00:00Z' }, NOW) === null,
  '…and then there is no next re-read to promise');
process.env.LT_ENCOMPASS_REREAD_HOURS = 'junk';
check(view.rotaHours() === 12, 'junk in the setting falls back to twelve hours rather than switching the backstop off');
if (saved === undefined) delete process.env.LT_ENCOMPASS_REREAD_HOURS;
else process.env.LT_ENCOMPASS_REREAD_HOURS = saved;

// THE SCREEN MUST NEVER PROMISE A DIFFERENT ROTA FROM THE ONE THAT RUNS. Both read
// the same environment variable with the same fallback; this pins that they agree,
// because a section explaining "every 12 hours" over an engine running every 6 is a
// confident wrong answer about the one thing this section exists to explain.
const loansMod = require('../src/longterm/sync/loans');
const dueAfter = (hours) => loansMod.needsRead(
  { encompass_synced_at: new Date(NOW - hours * 3600 * 1000).toISOString(), encompass_last_modified: null }, NOW);
check(dueAfter(view.rotaHours() + 1) === true && dueAfter(view.rotaHours() - 1) === false,
  'the rota the section states is the rota needsRead actually runs');

// ── 5. The read state is HANDED IN, never decided twice ──────────────────────
console.log('');
console.log('the read state is the one every other screen already asks');

const handed = view.fileSyncView({ encompass_synced_at: null }, { readState: { state: 'waiting', why: 'because', everRead: false } });
check(handed.read.state === 'waiting' && handed.read.why === 'because',
  'the caller’s read state is used verbatim — deciding it here would be a second opinion free to drift from read-state.js');
const unstated = view.fileSyncView({ encompass_synced_at: '2026-08-25T00:00:00Z' }, {});
check(unstated.read.state === null && unstated.read.everRead === true,
  'with none handed in it states no state rather than inventing one, while still saying honestly that the file has been read');

// ── 6. Words, never codes ────────────────────────────────────────────────────
console.log('');
console.log('a ping is described in words');
for (const key of ['guid', 'loan_number', 'sweep', 'manual']) {
  const v = view.fileSyncView({ encompass_nudged_via: key }, {});
  check(typeof v.nudge.viaWords === 'string' && v.nudge.viaWords.length > 10 && v.nudge.viaWords !== key,
    `"${key}" is turned into a sentence, not printed as the stored code`);
}
const odd = view.fileSyncView({ encompass_nudged_via: 'something_new' }, {});
check(odd.nudge.viaWords === 'something_new',
  'a shape nobody has words for is shown VERBATIM rather than dropped — an unexplained value on screen beats a silently missing one');

// ── 7. Why the READ button cannot run, in words that say what to change ──────
// The route's own rule, stubbed at the two seams it asks (the master switch and
// whether Encompass is connected) so no credentials and no network are involved.
// This is the branch that decides whether the owner's button works at all, and its
// third case is the one nobody would think to test: a loan PILOT holds no Encompass
// id for cannot be opened however healthy the connection is.
console.log('');
console.log('a read that cannot run says why');

const KS = require.resolve('../src/longterm/encompass/enabled');
const CL = require.resolve('../src/longterm/encompass/client');
const realKs = require.cache[KS];
const realCl = require.cache[CL];
const stubMod = (id, exports) => { require.cache[id] = { id, filename: id, loaded: true, exports }; };

let enabled = true;
let configured = true;
stubMod(KS, { encompassEnabled: () => enabled, OFF_REASON: 'Encompass is switched off for the whole of PILOT.' });
stubMod(CL, { configured: () => configured });
delete require.cache[require.resolve('../src/longterm/routes/encompass-file')];
const routeMod = require('../src/longterm/routes/encompass-file');
const blocked = routeMod._internals.blockedReason;

const WITH_GUID = { encompass_loan_guid: 'abc' };
check(blocked(WITH_GUID) === null, 'a connected, switched-on file with an Encompass id can be read');

enabled = false;
check(/switched off/i.test(blocked(WITH_GUID) || ''),
  'the master switch being off is said in the words that name the switch, not as a failure');

enabled = true; configured = false;
check(/not connected/i.test(blocked(WITH_GUID) || ''),
  'no credentials is "not connected yet", which is a different thing to fix');

configured = true;
const noGuid = blocked({ encompass_loan_guid: null });
check(typeof noGuid === 'string' && /Encompass id/.test(noGuid),
  'a loan PILOT holds no Encompass id for says so — it cannot be opened however healthy the connection is');
check(/discovery/i.test(noGuid),
  '…and says what fixes it, so the reason is never a dead end');

// THE ORDER MATTERS: a switched-off connection is reported as switched off even on
// a loan with no id, because turning the switch on is the first thing to do and
// hunting for a missing id under a dead connection is wasted effort.
enabled = false;
check(/switched off/i.test(blocked({ encompass_loan_guid: null }) || ''),
  'with the switch off, that is the reason given even on a loan with no id — first things first');

if (realKs) require.cache[KS] = realKs; else delete require.cache[KS];
if (realCl) require.cache[CL] = realCl; else delete require.cache[CL];
delete require.cache[require.resolve('../src/longterm/routes/encompass-file')];

console.log('');
if (failures) {
  console.error(`\n${failures} FAILED`);
  process.exit(1);
}
console.log('all good');
