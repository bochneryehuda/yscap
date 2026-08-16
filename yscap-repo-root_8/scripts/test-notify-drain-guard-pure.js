'use strict';

// =============================================================================
// A TEST MAY NOT TEAR DOWN WHILE ITS OWN EMAIL WRITE IS STILL IN FLIGHT
// =============================================================================
//
// WHAT WENT WRONG. On 2026-08-16 the `test-db` job went red on main and the
// deploy was skipped. The failing suite had already printed "ALL 14 borrower-draw
// assertions passed" — every assertion had passed. What failed was its CLEANUP:
//
//   Process 917: DELETE FROM applications WHERE id=$1
//   Process 918: INSERT INTO sent_emails (notification_id, application_id, ...)
//   ERROR: deadlock detected (40P01)
//   CONTEXT: while deleting tuple in relation "notifications"
//
// THE MECHANISM, MEASURED RATHER THAN ASSUMED. The email fan-out is deliberately
// FIRE-AND-FORGET in production — `notify.js` `_track()`s the promise and does not
// await it, so a web request never waits on an email. That means
// `notifyAppBorrowers()` RESOLVES WHILE ITS `sent_emails` INSERT IS STILL RUNNING.
// Probed against a real database, three runs out of three: the `sent_emails` row is
// ABSENT the instant the fan-out resolves and PRESENT after `drainEmails()`. So at
// the moment a test's cleanup `DELETE FROM applications` runs, that INSERT is live.
// The DELETE cascades into `notifications`; the INSERT references the very rows it
// is removing; each waits on the other's transaction, and Postgres kills one.
//
// WHY A GUARD AND NOT TWELVE FIXES. Nothing about the failing suite was special —
// TWELVE suites had the same shape, each a red build waiting for the scheduler to
// go the other way, and one of them blocks the deploy for everybody when it does.
// This is a race, so it is INVISIBLE until it bites and it bites at random: the
// same suite passed 18 minutes earlier on a near-identical tree. A rule nobody can
// see is a rule that comes back the next time somebody writes a teardown.
//
// THE RULE. A test that fans a notification out AND tears its rows down must call
// `notify.drainEmails()` FIRST. `notify.js` already documents this exact failure
// and exports the drain for it; the suites simply were not calling it.
//
// ORDER IS THE WHOLE POINT. A drain AFTER the first DELETE is decoration — the
// deadlock has already had its chance. So this asserts POSITION, not presence.
//
// PURE: reads the test sources. No database, no network.

const fs = require('fs');
const path = require('path');

const SCRIPTS = path.join(__dirname);
let checks = 0;
const problems = [];
const ok = (c, w) => { checks++; if (!c) problems.push(w); };

// A call that fans a notification out to real recipients — every one of these ends
// up at notify.js's fire-and-forget `_track(_emailRow(...))`.
const FANOUT = /\bnotify(?:AppBorrowers|AppStaff|AppStaffThread|AppThread|Borrower|Staff|Admins)\s*\(/;

// The first statement of a teardown: removing the rows the email write points at,
// or closing the pool out from under it.
const TEARDOWN = /DELETE\s+FROM\s+(?:applications|borrowers|notifications)\b|\b(?:db\.)?pool\.end\s*\(|\bdb\.end\s*\(/;

const DRAIN = /drainEmails\s*\(/;

/** Strip comments so a rule can never be satisfied — or tripped — by prose ABOUT it. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + '');
}

/** First index matching `re`, or -1. Operates on comment-stripped source. */
function firstIndex(src, re) {
  const m = new RegExp(re.source, re.flags.replace('g', '') + 'g').exec(src);
  return m ? m.index : -1;
}

/** Last index matching `re`, or -1. */
function lastIndex(src, re) {
  const g = new RegExp(re.source, re.flags.replace('g', '') + 'g');
  let m, at = -1;
  while ((m = g.exec(src))) { at = m.index; if (m.index === g.lastIndex) g.lastIndex++; }
  return at;
}

const files = fs.readdirSync(SCRIPTS)
  .filter((f) => /^test-.*\.(js|mjs)$/.test(f))
  .sort();

ok(files.length > 100, `the sweep found the test files (${files.length})`);

const audited = [];
for (const f of files) {
  const raw = fs.readFileSync(path.join(SCRIPTS, f), 'utf8');
  const src = stripComments(raw);

  // MEASURED FROM THE **LAST** FAN-OUT TO THE **LAST** TEARDOWN, deliberately.
  // Anchoring on the FIRST teardown reads a mid-test removal of a scratch fixture
  // — several suites create a throwaway file, assert on it and delete it before
  // carrying on — as though it were the final cleanup, and flags seven suites that
  // are perfectly correct. What has to hold is the thing that actually failed:
  // after the last email a suite sends, it drains before it tears its rows down.
  const fanOut = lastIndex(src, FANOUT);
  if (fanOut < 0) continue;                       // never sends anything — nothing to race
  const teardown = lastIndex(src, TEARDOWN);
  if (teardown < 0) continue;                     // creates nothing it tears down
  // Only a teardown AFTER the fan-out can race it.
  if (teardown < fanOut) continue;

  audited.push(f);
  const drain = lastIndex(src, DRAIN);
  ok(drain >= 0,
    `${f} fans a notification out and then tears its rows down, but never calls `
    + `notify.drainEmails() — its sent_emails INSERT can deadlock with that cleanup`);
  if (drain >= 0) {
    ok(drain > fanOut,
      `${f} drains BEFORE its last notification fan-out — the writes that fan-out `
      + `starts are still in flight at teardown, which is the whole failure`);
    ok(drain < teardown,
      `${f} calls drainEmails() only AFTER it has torn its rows down — by then the `
      + `deadlock has already had its chance; drain BEFORE the cleanup`);
  }
}

ok(audited.length >= 12,
  `the sweep is actually reaching the suites at risk (found ${audited.length})`);

// AND THE DRAIN IT NAMES IS REAL. A guard that requires a function nobody exports
// would be satisfied for ever by a typo.
{
  const notifySrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'notify.js'), 'utf8');
  ok(/module\.exports\s*=\s*\{[\s\S]*?\bdrainEmails\b[\s\S]*?\}/.test(notifySrc),
    'notify.js still EXPORTS drainEmails — the guard above names a real function');
  ok(/async function drainEmails\s*\(/.test(notifySrc),
    'and drainEmails is awaitable, so "await it before teardown" is meaningful');
}

if (problems.length) {
  console.error(`test-notify-drain-guard-pure: ${problems.length} problem(s)\n  ` + problems.join('\n  '));
  process.exit(1);
}
console.log(`test-notify-drain-guard-pure: ${checks} assertions passed — `
  + `${audited.length} suites fan out and tear down, and every one drains the email `
  + `writes first, so a cleanup DELETE can never deadlock with a sent_emails INSERT`);
