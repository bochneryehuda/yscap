'use strict';
/**
 * LT test — WHY A ROW IS HALF EMPTY, ANSWERED ON THE SCREEN.
 *
 * OWNER-REPORTED 2026-08-24, three Sherman Ave files (YSCAP258134856/857/858):
 * *"All these files somehow are not updating in pilot. I don't know why I'm not
 * getting the information."*
 *
 * A long-term loan reaches PILOT in TWO steps. DISCOVERY finds it in Encompass's
 * pipeline search and stores what that search returns — number, officer, address,
 * program, amount, borrower name. THE FULL READ then opens the loan itself and
 * brings back the milestone ladder, the rate, the DSCR, the lock, the investor and
 * the 1003 sections. Between the two the row is real and half empty.
 *
 * PILOT HAS ALWAYS KNOWN WHICH STEP EACH LOAN IS AT: `encompass_synced_at` is NULL
 * until the first successful read, and `encompass_sync_error` holds the reason a
 * read was refused. The REFUSAL was already surfaced on the sync screen and the
 * file's rail. The WAITING state was surfaced NOWHERE — the count was implicit
 * (loans minus read-at-least-once, which also silently contains every refusal) and
 * the loans themselves were named on no screen. So a file that arrived an hour ago
 * and a file that has been stuck for three days looked identical, and both looked
 * broken. That is a fact recorded, correct, and invisible.
 *
 * WHAT THIS GUARDS: the one definition, its three states in the right order, and
 * the fact that all four surfaces read it rather than each deciding for itself.
 *
 * PURE. Reads source and calls a module with no database and no network.
 */

const path = require('path');
const fs = require('fs');
const readState = require('../src/longterm/read-state');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
/** The comments here quote the very shapes being forbidden, so a guard that read
 *  them would fail on its own explanation and then be "fixed" by deleting it. */
const code = (p) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

// ── 1. The three states ──────────────────────────────────────────────────────
console.log('a loan is read, refused, or still waiting — and never anything else');

const waiting = readState.readStateOf({ encompass_synced_at: null, encompass_sync_error: null });
check(waiting.state === 'waiting', 'discovered and never read reads as WAITING');
check(/has not read the file itself yet/.test(waiting.why),
  'and it says so in words a person can act on, not a code');
check(waiting.everRead === false, 'nothing on that row came from the loan itself');

const done = readState.readStateOf({ encompass_synced_at: '2026-08-24T10:00:00Z', encompass_sync_error: null });
check(done.state === 'read', 'a loan Encompass answered for reads as READ');
check(done.why === null, 'and needs no explanation');

const refused = readState.readStateOf({ encompass_synced_at: null, encompass_sync_error: 'HTTP 403' });
check(refused.state === 'failed', 'a refused first read reads as FAILED, never as waiting');
check(/HTTP 403/.test(refused.why), 'and carries Encompass\'s own reason');

// THE ORDER OF THE TESTS IS THE RULE, and this is the case that proves it.
const stale = readState.readStateOf({ encompass_synced_at: '2026-08-01T10:00:00Z', encompass_sync_error: 'timed out' });
check(stale.state === 'failed',
  'THE ONE THAT MATTERS: a loan read a week ago and REFUSED this morning is FAILED, not read — its figures are stale, and "stale, here is why" is a different answer from "fresh"');
check(stale.everRead === true, 'while still recording that there ARE figures on it, from the earlier read');

// ── 2. It never throws, whatever it is handed ────────────────────────────────
console.log('it answers about anything, and never throws');
for (const bad of [null, undefined, {}, { encompass_sync_error: '   ' }, { encompass_sync_error: 42 }]) {
  let ok = true;
  try { readState.readStateOf(bad); } catch (_) { ok = false; }
  check(ok, `no throw on ${JSON.stringify(bad)}`);
}
check(readState.readStateOf({ encompass_sync_error: '   ' }).state === 'waiting',
  'a blank error is not an error — whitespace must not turn a queued loan into a fault');
check(readState.readStateOf({ encompass_synced_at: '2026-08-24', encompass_sync_error: 42 }).state === 'read',
  'and a non-string in that column is not a reason to claim a refusal');

// ── 3. Every surface reads the ONE definition ────────────────────────────────
console.log('four surfaces, one definition');

const pipeline = code('src/longterm/pipeline.js');
const workspace = code('src/longterm/workspace.js');
const syncRoute = code('src/longterm/routes/sync.js');
const uiPipeline = code('app-v2/src/longterm/LtPipeline.jsx');
const uiLoan = code('app-v2/src/longterm/LtLoan.jsx');
const uiSync = code('app-v2/src/longterm/LtSync.jsx');

check(/require\('\.\/read-state'\)/.test(pipeline) && /r\.read_state = rs\.state/.test(pipeline),
  'the PIPELINE stamps every row with its read state');
check(/require\('\.\/read-state'\)/.test(workspace) && /readState: readState\.readStateOf\(l\)\.state/.test(workspace),
  'the FILE SCREEN\'s rail carries it too');
check(/row\.read_state !== 'read'/.test(uiPipeline) && /NOT READ YET/.test(uiPipeline),
  'the pipeline MARKS a row that is not read — a back end is not a feature');
check(/title=\{row\.read_why \|\| ''\}/.test(uiPipeline),
  'and the hover is the SERVER\'s own sentence, never one retyped on the screen');
check(/rail\.readState === 'failed' \|\| rail\.readState === 'waiting'/.test(uiLoan)
  && /rail\.readWhy \|\|/.test(uiLoan),
'the file overview says which of the two steps the loan is at, instead of "Read from Encompass —"');
// THE RULE IS UNCHANGED; ITS SHAPE IS NOT. The always-on rail became the shared
// file-overview slide-over on 2026-08-30, so the two branches are now a ternary that
// produces a SENTENCE rather than two pieces of JSX. What still has to be true is the
// same thing it always was: the date line is reachable ONLY on the branch that has a
// date, and a server too old to name a state falls through to it rather than blanking.
check(/const reading = \(rail\.readState === 'failed' \|\| rail\.readState === 'waiting'\)\s*\?[\s\S]{0,200}:\s*`Read from Encompass \$\{day\(rail\.syncedAt\)\}`/.test(uiLoan),
  'the date line is drawn ONLY on the branch that has a date — and an older server that names no state still falls through to it, so a half-landed deploy never blanks the line');
check(!/The last read failed:/.test(uiLoan),
  'and the failure wording is the server\'s one definition, not a second copy typed on the screen');

// ── 4. The count and the list come from the SAME predicate ───────────────────
console.log('the sync screen names them, and its count cannot disagree with its list');

check(/AS waiting_count/.test(syncRoute), 'the waiting loans are COUNTED');
check(/encompass_synced_at IS NULL\s*\n\s*AND encompass_sync_error IS NULL/.test(syncRoute),
  'by the same two-part predicate the list uses — never "loans minus read-at-least-once", which silently contains every refusal too');
check(/ORDER BY created_at ASC/.test(syncRoute),
  'oldest first: a loan waiting minutes is the queue working, one waiting days is a fault');
check(/waiting_secs/.test(syncRoute) && /waitedFor\(w\.waiting_secs\)/.test(uiSync),
  'and the WAIT is what the screen shows, because the wait is what tells those two apart');
check(/state\.waiting_count > \(state\.waiting \|\| \[\]\)\.length/.test(uiSync),
  'a truncated list SAYS it was truncated — no silent caps');

console.log(failures ? `\n${failures} FAILED` : '\nlt read state (pure): all checks passed');
process.exit(failures ? 1 : 0);
