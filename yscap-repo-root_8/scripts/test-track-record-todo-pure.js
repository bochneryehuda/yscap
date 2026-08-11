'use strict';
/**
 * WHAT IS STILL LEFT ON THE TRACK RECORD (owner-directed 2026-08-03), proven
 * with no database.
 *
 * The owner: "on the track record screen inside the file, after the track
 * record, there should be the skew of the stuff that still needs to be done to
 * the track record — stuff that still needs to be reviewed — nicely laid out
 * within the file as well."
 *
 * THE PROPERTY THAT MUST NOT REGRESS: this panel and the SIGN-OFF GATE must
 * always be describing the same file. Two ways they could drift, both guarded
 * here — the panel re-deriving the frozen 3-year exit window in the browser, and
 * a second copy of the refusal wording. A list that says a line is ready to
 * verify while the click answers 422 is worse than no list at all.
 */
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

const TODO = require('../src/lib/track-record-todo');
const staff = read('src', 'routes', 'staff.js');
const experience = read('src', 'lib', 'experience.js');
const mod = read('src', 'lib', 'track-record-todo.js');
const screen = read('app-v2', 'src', 'screens', 'StaffApplication.jsx');
const apiJs = read('app-v2', 'src', 'lib', 'api.js');

const codes = (row) => TODO.lineTodo(row).map((t) => t.code);

console.log('\nA. one line at a time — what does it still need?');

{
  // A finished line: an in-window exit, documentation somebody accepted, nothing
  // left unread, and the verdict recorded. This is the whole point of the panel —
  // a clean line must produce NOTHING, or the list becomes noise nobody reads.
  ok(codes({ is_verified: true, doc_count: 1, docs_accepted: 1 }).length === 0,
    'a verified line with accepted documentation and nothing outstanding says nothing');

  ok(codes({ is_verified: false, doc_count: 0 }).join() === 'no_documents',
    'a typed deal with nothing behind it needs the documentation asked for');

  ok(codes({ is_verified: false, doc_count: 1, docs_accepted: 1 }).join() === 'ready_to_verify',
    'the exit is in, the document is accepted, nothing is unread — the only thing left is the verdict');

  // The reviewer has not read it yet, so it is NOT ready — offering the verdict
  // here is exactly the "verified off unreviewed typing" the whole change exists
  // to stop.
  ok(codes({ is_verified: false, doc_count: 2, docs_accepted: 1, docs_waiting: 1 }).join() === 'documents_waiting',
    'a document nobody has read yet is OUR work, and the line is not called ready');

  ok(codes({ is_verified: false, doc_count: 1, docs_rejected: 1 }).join() === 'document_rejected',
    'a rejected document is named as such — never re-reported as "nothing uploaded"');

  ok(codes({ is_verified: false, doc_count: 0, open_request_count: 1 }).includes('open_request'),
    'a document we already asked for is shown as waiting on them');
}

console.log('\nB. the exit is the frozen rule — and it is terminal');

{
  // Each verdict is computed in SQL off experience.EXIT_DATE_SQL; the pure half
  // only ever reads the answer. All three are terminal for verification, so
  // nothing may call such a line ready however good its documents look.
  for (const [flag, code] of [['no_exit', 'no_exit'], ['future_exit', 'future_exit'], ['exit_expired', 'exit_expired']]) {
    const c = codes({ is_verified: false, doc_count: 1, docs_accepted: 1, [flag]: true });
    ok(c.includes(code) && !c.includes('ready_to_verify'),
      `${code}: reported, and the line is never offered as ready to verify`);
  }
  ok(!codes({ is_verified: false, doc_count: 0, no_exit: true }).includes('no_documents'),
    'a line with no exit is not ALSO nagged for documents — the exit is the thing to chase');
  // Only one exit verdict can be true at a time, and the first wins — so a row
  // that somehow carries two never produces two contradictory instructions.
  ok(codes({ is_verified: false, no_exit: true, exit_expired: true, doc_count: 1, docs_accepted: 1 })
    .filter((c) => ['no_exit', 'future_exit', 'exit_expired'].includes(c)).length === 1,
    'exactly one exit verdict is ever reported');
  ok(codes({ is_verified: true, doc_count: 1, docs_accepted: 1, exit_expired: true }).join() === 'exit_expired',
    'a VERIFIED line whose exit aged out still says so — "verified but counts toward nothing" is the confusion this prevents');

  // #40 (owner-directed 2026-08-10): a recorded review OUTCOME is a DECISION,
  // so the line no longer nags "verify me".
  ok(codes({ is_verified: false, verification_status: 'rejected', doc_count: 0, docs_waiting: 1 }).length === 0,
    'a REJECTED line is settled — no outstanding work at all, not even a waiting document');
  ok(codes({ is_verified: false, verification_status: 'not_verified', doc_count: 0 }).join() === '',
    'a "not verified" outcome never nags "no documents"/"ready to verify" — the reviewer decided');
  ok(codes({ is_verified: false, verification_status: 'unable_mismatch', doc_count: 1, docs_accepted: 1 }).join() === '',
    'an "unable to verify" outcome is not "ready to verify"');
  ok(codes({ is_verified: false, verification_status: 'unable_docs', doc_count: 2, docs_waiting: 1, open_request_count: 1 })
    .sort().join() === ['documents_waiting', 'open_request'].sort().join(),
    'but a decided line still surfaces a REAL open item (a waiting document, an open request)');
}

console.log('\nC. it is a work list, so it says WHO owes the work');

{
  const groups = new Set(['us', 'borrower', 'nobody']);
  for (const code of TODO.TODO_ORDER) {
    const spec = TODO.LINE_TODO[code];
    ok(!!spec && !!spec.title && !!spec.how && groups.has(spec.waitingOn),
      `${code} has wording and a party — the panel can never receive a group it does not render`);
  }
  ok(Object.keys(TODO.LINE_TODO).length === TODO.TODO_ORDER.length,
    'every kind of outstanding work is in the display order — one added without an order entry would be invisible');
  // Our own work first: it is the only part anyone in the office can finish today.
  ok(TODO.TODO_ORDER.indexOf('documents_waiting') < TODO.TODO_ORDER.indexOf('no_documents'),
    'what WE owe is listed before what we are waiting on');
  const many = TODO.lineTodo({ is_verified: false, doc_count: 2, docs_waiting: 1, open_request_count: 1, no_exit: true });
  ok(many.map((t) => t.code).join() === 'documents_waiting,open_request,no_exit',
    'several problems on one line come back in that same order, never in the order they were detected');

  const s = TODO.summarize([
    { todo: [{ waitingOn: 'us' }, { waitingOn: 'borrower' }] },
    { todo: [{ waitingOn: 'nobody' }] },
    { todo: [] },
  ]);
  ok(s.lines === 2 && s.items === 3 && s.us === 1 && s.borrower === 1,
    'the headline counts deals and items, split by who owes them; a clean line counts for nothing');
}

console.log('\nD. the shortfall is stated in the sign-off gate\'s own arithmetic');

{
  const short = TODO.shortfallOf({ flips: 1, holds: 0, ground: 0 }, { flips: 3, holds: 1, ground: 0 });
  ok(short.length === 2 && short[0].text === '2 more flips' && short[1].text === '1 more hold',
    'it names the gap per bucket, singular and plural');
  ok(TODO.shortfallOf({ flips: 5, holds: 5, ground: 5 }, { flips: 1, holds: 1, ground: 1 }).length === 0,
    'more verified than the product needs is no shortfall');
}

console.log('\nE. nothing is re-derived — one wording, one window, one need');

{
  // The refusals are the verify route's own. A second copy is how a panel ends up
  // promising a line is ready and the click refusing it in different words.
  ok(/EXIT_PROBLEM_MSG/.test(staff),
    'the verify route reads the shared refusal wording rather than its own copy');
  ok(!/This project’s exit is more than 3 years ago/.test(staff),
    '…and no longer carries a second copy of it');
  ok(/EXIT_PROBLEM_MSG = \{[\s\S]{0,900}exit_expired:/.test(mod),
    'the three refusals live in ONE table');

  // The 36-month window is FROZEN. It is applied in SQL, from experience.js.
  ok(/EXP\.EXIT_DATE_SQL/.test(mod) && /INTERVAL '36 months'/.test(mod),
    'the exit window is applied in SQL off the frozen definition, never re-derived in JS');
  ok(!/36/.test(read('app-v2', 'src', 'screens', 'StaffApplication.jsx').split('function TrackRecordTodo')[1].slice(0, 6000)),
    '…and never restated in the browser');

  // "How much experience must be verified" is asked by the condition sync, the
  // sign-off gate and this list. Two answers would show an officer work that does
  // not match what the gate refuses on.
  ok(/function registeredExperienceNeed/.test(experience) && /registeredExperienceNeed,/.test(experience),
    'the registered experience need is ONE exported definition');
  ok(/registeredExperienceNeed\(appId, client, required\)/.test(experience),
    '…and the condition sync reads it');
  ok(/EXP\.registeredExperienceNeed/.test(mod), '…and so does this list');

  ok(/require\('\.\/track-record-findings'\)\.openForFile/.test(mod),
    'the open findings come from the module that owns them');
  ok(/EXP\.countBorrowersExperience/.test(mod),
    'verified experience is counted by the module that owns the frozen window');
}

console.log('\nF. it can never make anything worse');

{
  ok(!/\b(INSERT|UPDATE|DELETE)\b/i.test(mod), 'the module only ever READS — it writes nothing anywhere');
  ok(/ids\.includes\(borrowerId\)/.test(mod),
    'a borrower id that is not on the file is ignored, so the query string can never widen the scope');
  ok(/unreadable: true/.test(mod) && (mod.match(/catch \(_\)/g) || []).length >= 4,
    'every read is caught — a to-do list must never take the Track record section down with it');
  // Junk in, no throw, no fabricated work.
  for (const junk of [null, undefined, {}, { is_verified: 'yes' }, { doc_count: 'x', docs_waiting: null }, []]) {
    let threw = false;
    try { TODO.lineTodo(junk); } catch (_) { threw = true; }
    ok(!threw, `lineTodo(${JSON.stringify(junk)}) never throws`);
  }
  ok(TODO.addressOf(null) === 'A past project' && TODO.addressOf({ line1: '5 Main St', city: 'Lakewood', state: 'NJ' }) === '5 Main St, Lakewood, NJ',
    'an unreadable address still reads as something a human can look at');
}

console.log('\nG. it is INSIDE the file, AFTER the track record');

{
  const panel = screen.slice(screen.indexOf('function StaffTrackRecordPanel'));
  // "The track record itself" is the LEDGER since phase C (and the embedded
  // iframe is retired since phase E) — the subject of this pin is unchanged:
  // you read the record, THEN you read what is left on it.
  const recordAt = panel.indexOf('<RecordLedger');
  const todoAt = panel.indexOf('<TrackRecordTodo');
  ok(recordAt > 0 && todoAt > recordAt,
    'the list renders AFTER the track record itself — the owner\'s "after the track record"');
  ok(/staffTrackRecordTodo/.test(apiJs) && /staffTrackRecordTodo/.test(screen),
    'it reads the server\'s answer');
  ok(/router\.get\('\/applications\/:id\/track-record-todo'/.test(staff),
    'the route exists, under the file-scoped /applications/:id middleware');
  ok(/reloadKey=\{todoKey\}/.test(screen) && /const reloadAll = useCallback/.test(screen),
    'anything that changes the record re-asks what is left');
  // var(--ink*) tokens are LIGHT in this palette — using one as a text colour is
  // the repo's white-on-white bug.
  const body = screen.slice(screen.indexOf('function TrackRecordTodo'), screen.indexOf('function StaffTrackRecordPanel'));
  ok(!/color:\s*'var\(--ink/.test(body), 'no text is coloured with an --ink token (those are LIGHT)');
  ok(/#141B22/.test(body) && /#4B585C/.test(body), '…text is explicit dark ink on the white canvas');
}

console.log(fail
  ? `\n${fail} FAILURE(S)`
  : '\nOK  track record: what is left is stated in the file, in the sign-off gate\'s own terms');
process.exit(fail ? 1 : 0);
