'use strict';
/**
 * THE BROWSER TWIN OF "IS THIS FILE SOLD?" MUST NEVER DISAGREE WITH THE SERVER.
 *
 * `src/lib/sold-status.displayStatus` is the definition: a file shows as Sold when it carries a
 * `sold_at` AND its stored status is still `funded` (db/611 — the stage rides on top of funded
 * because 139 places read `status` and moving it would switch servicing off).
 *
 * Two screens need that answer in the browser — the file header and the pipeline list — and a
 * browser cannot call the server function, so `app-v2/src/lib/soldStage.js` is a mirror. The repo's
 * rule for a mirror (CLAUDE.md, "One definition, never a second copy"): where a twin is
 * unavoidable, A TEST MUST FAIL THE MOMENT THEY DISAGREE. This is that test.
 *
 * It does not assert a hand-written table of expected answers — that would be a THIRD copy, free to
 * agree with a broken pair. It runs both implementations over the same rows and compares them to
 * EACH OTHER, plus a small set of anchor facts that pin the rule itself so the two cannot drift
 * together into agreeing on something wrong.
 *
 * PURE — no database, no network. The twin is an ES module, so it is read and evaluated rather than
 * `require`d; that also proves the file is syntactically loadable, which a bundler would otherwise
 * be the first to discover.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');
const SERVER = require(path.join(REPO, 'src/lib/sold-status.js'));

let pass = 0; let fail = 0;
const ok = (cond, what) => { if (cond) { pass += 1; console.log(`  ok  ${what}`); } else { fail += 1; console.error(`  FAIL ${what}`); } };

/* Load the ES-module twin without a bundler: strip the `export` keywords and evaluate. Deliberately
   crude and deliberately NOT a regex over the whole file — it only removes the two export forms this
   file uses, and anything else it cannot handle throws, which fails the test rather than silently
   testing nothing. */
function loadTwin() {
  const src = fs.readFileSync(path.join(REPO, 'app-v2/src/lib/soldStage.js'), 'utf8');
  const stripped = src
    .replace(/^export const /gm, 'const ')
    .replace(/^export function /gm, 'function ');
  if (/^export /m.test(stripped)) {
    throw new Error('soldStage.js uses an export form this loader does not understand — teach it, do not skip it');
  }
  const sandbox = { module: { exports: {} } };
  vm.createContext(sandbox);
  vm.runInContext(`${stripped}\nmodule.exports = { isSoldStage, displayStatus, statusLabel, statusPill };`, sandbox);
  return sandbox.module.exports;
}

const TWIN = loadTwin();

/* EVERY SHAPE A ROW CAN TAKE, generated rather than hand-listed — a hand-kept list is the thing
   that goes stale silently (CLAUDE.md, "Generate, don't hand-maintain"). Statuses are the real
   ones an application can carry, crossed with every way `sold_at` can arrive. */
const STATUSES = [
  'file_intake', 'new', 'in_review', 'processing', 'underwriting', 'approved',
  'clear_to_close', 'funded', 'on_hold', 'declined', 'withdrawn', null, undefined, '',
];
const SOLD_AT = [null, undefined, '', '2026-07-31', '2026-07-31T00:00:00.000Z', new Date('2026-07-31')];

const rows = [];
for (const status of STATUSES) for (const sold_at of SOLD_AT) rows.push({ status, sold_at });
rows.push(null, undefined, {});

console.log(`1. the twin agrees with the server on all ${rows.length} row shapes`);
let disagreements = 0;
for (const row of rows) {
  const server = SERVER.displayStatus(row);
  const twin = TWIN.displayStatus(row);
  if (server !== twin) {
    disagreements += 1;
    console.error(`  FAIL ${JSON.stringify(row)} → server ${JSON.stringify(server)} / twin ${JSON.stringify(twin)}`);
  }
}
ok(disagreements === 0, `displayStatus matches on every row shape (${rows.length} checked)`);

/* THE ANCHORS. Without these the two could drift together — both returning 'funded' forever, say —
   and the comparison above would stay green. These pin the rule itself. */
console.log('2. the rule itself, so the pair cannot drift together');
ok(SERVER.displayStatus({ status: 'funded', sold_at: '2026-07-31' }) === 'sold'
  && TWIN.displayStatus({ status: 'funded', sold_at: '2026-07-31' }) === 'sold',
  'a funded file carrying sold_at shows as sold');
ok(SERVER.displayStatus({ status: 'funded' }) === 'funded'
  && TWIN.displayStatus({ status: 'funded' }) === 'funded',
  'a funded file with no sold_at is untouched');
ok(SERVER.displayStatus({ status: 'underwriting', sold_at: '2026-07-31' }) === 'underwriting'
  && TWIN.displayStatus({ status: 'underwriting', sold_at: '2026-07-31' }) === 'underwriting',
  'a stage never overrides a status that is not funded — a stage is not a status');

console.log('3. the label and pill helpers the screens actually call');
const LABELS = { funded: 'Funded', underwriting: 'Underwriting' };
const PILLS = { funded: 'ok', underwriting: 'mut' };
ok(TWIN.statusLabel({ status: 'funded', sold_at: '2026-07-31' }, LABELS) === 'Sold',
  'a sold file is labelled Sold');
ok(TWIN.statusLabel({ status: 'funded' }, LABELS) === 'Funded',
  'a funded file keeps its own label');
ok(TWIN.statusLabel({ status: 'underwriting', sold_at: '2026-07-31' }, LABELS) === 'Underwriting',
  'a non-funded file keeps its own label even carrying sold_at');
ok(TWIN.statusLabel(null, LABELS) === '—', 'a missing row reads as a dash, never as a crash');
ok(TWIN.statusPill({ status: 'funded', sold_at: '2026-07-31' }, PILLS) === 'ok',
  'a sold file wears the funded pill');
ok(TWIN.statusPill({ status: 'nonsense' }, PILLS) === 'mut',
  'an unrecognised status falls back to the muted pill');

console.log(`\n${fail ? 'FAILED' : 'PASSED'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
