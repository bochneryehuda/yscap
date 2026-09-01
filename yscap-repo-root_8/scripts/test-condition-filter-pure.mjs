/* WHICH CONDITIONS AM I LOOKING AT — one rule, both products.
 *
 * Owner-directed 2026-09-01, on the Long-Term conditions screen: *"We also need
 * to add the full sorting features so that you can sort by stuff that is done,
 * by signed off, and by outstanding, to sort the conditions accordingly that we
 * have on the short-term side. You can share that code as well."*
 *
 * ── WHAT THIS SUITE IS ACTUALLY FOR ─────────────────────────────────────────
 *
 * The rule was written out TWICE in this app before it was extracted, each copy
 * commenting that it mirrored the other. So the property worth guarding is not
 * "the predicate is correct" — it is "there is only ONE of it, and every screen
 * reads it". A behaviour test cannot see a fourth copy appearing next year, so
 * the source guards below are the half that keeps this shared.
 *
 * The other half is EQUIVALENCE. The short-term filter is a live screen a whole
 * team uses every day; extracting it must not have moved one row. Section B
 * therefore re-implements the ORIGINAL inline switch verbatim and runs both over
 * every combination — a difference of one verdict fails the build.
 *
 * Pure — no browser, no database, no React.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  roleDone, CONDITION_FILTER_KEYS, conditionFilterLabel, conditionFilterHint,
  matchConditionFilter, filterConditions,
} from '../app-v2/src/lib/condition-filter.js';
import { conditionStatusLabel } from '../app-v2/src/lib/conditions-vocab.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
/* Comments are stripped before every "must not appear" assertion. The code that
   removed a duplicate necessarily NAMES it while explaining why, so a guard that
   read comments would fail on its own explanation and then get "fixed" by
   deleting the explanation. */
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

let failures = 0;
const ok = (cond, what, detail) => {
  if (cond) { console.log(`  PASS ${what}`); return; }
  failures++;
  console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ''}`);
};

const ROLES = ['loan_officer', 'processor', 'underwriter', 'admin', 'super_admin', 'closer', null, undefined, ''];
const STATUSES = ['outstanding', 'requested', 'received', 'satisfied', 'issue'];
const STAMPS = [
  {},
  { signed_off_at: '2026-09-01' },
  { waived_at: '2026-09-01' },
  { reviewed_at: '2026-09-01' },
  { reviewed_at: '2026-09-01', signed_off_at: '2026-09-01' },
  { reviewed_at: '2026-09-01', waived_at: '2026-09-01' },
];
const EVERY_ROW = [];
for (const status of STATUSES) for (const st of STAMPS) EVERY_ROW.push({ status, ...st });

// ── A. THE RULE ITSELF ──────────────────────────────────────────────────────
console.log('\nA. THE OFFICER CLEARS THEIR OWN ROW; THE BACK OFFICE CLEARS EVERYBODY\'S');
{
  const working = { status: 'received' };
  ok(roleDone(working, 'loan_officer') === false, 'an unstamped condition is on the officer\'s plate');
  ok(roleDone(working, 'processor') === false, '…and on the back office\'s');

  const done = { status: 'received', reviewed_at: '2026-09-01' };
  ok(roleDone(done, 'loan_officer') === true,
    'THE ONE THAT MATTERS: the officer\'s own Done stamp takes it off THEIR list');
  ok(roleDone(done, 'processor') === false,
    '…and leaves it squarely on the back office\'s — the stamp is not a clearance');

  ok(roleDone({ status: 'satisfied' }, 'loan_officer') === true, 'satisfied is done for everyone');
  ok(roleDone({ status: 'received', signed_off_at: 'x' }, 'processor') === true, 'so is a sign-off');
  ok(roleDone({ status: 'received', waived_at: 'x' }, 'processor') === true, 'so is a waive');

  ok(roleDone(null, 'processor') === false, 'a missing row is not "done" — it is nothing');
  ok(roleDone(undefined, 'loan_officer') === false, '…and neither is undefined');

  /* An unknown role must read as the BACK OFFICE, not the officer: reading it
     as an officer would let a stray `reviewed_at` hide a condition from someone
     whose sign-off is still required. Fail toward showing. */
  for (const r of ['closer', 'funder', null, undefined, '', 'LOAN_OFFICER']) {
    ok(roleDone(done, r) === false, `an unrecognised role (${JSON.stringify(r)}) does NOT inherit the officer's stamp`);
  }
}

// ── B. THE EQUIVALENCE PROOF — the short-term screen did not move ────────────
console.log('\nB. THE SHORT-TERM FILTER ANSWERS EXACTLY WHAT IT ANSWERED BEFORE');
{
  /* The ORIGINAL inline switch from screens/StaffApplication.jsx, copied here
     verbatim as the reference. This is deliberately NOT a call into the module:
     comparing the module with itself would prove nothing, which is the tautology
     this repo's own rules warn about. */
  const originalOffMyPlate = (it, role) =>
    it.status === 'satisfied' || !!it.signed_off_at || !!it.waived_at
    || (role === 'loan_officer' && !!it.reviewed_at);
  const originalMatch = (it, condFilter, role) => {
    switch (condFilter) {
      case 'awaiting':  return ['outstanding', 'requested'].includes(it.status) && !it.signed_off_at;
      case 'review':    return it.status === 'received' && !it.signed_off_at;
      case 'attention': return it.status === 'issue';
      case 'signed':    return !!it.signed_off_at || it.status === 'satisfied';
      case 'unsigned':  return !(it.status === 'satisfied' || !!it.signed_off_at || !!it.waived_at);
      case 'all':       return true;
      case 'mine':
      default:          return !originalOffMyPlate(it, role);
    }
  };

  // Every option, every role, every status × stamp combination — plus a stale
  // key, which is the one input that can only reach the fallback branch.
  const keys = [...CONDITION_FILTER_KEYS, 'a-view-we-removed', '', null, undefined];
  let compared = 0;
  let drift = null;
  for (const key of keys) for (const role of ROLES) for (const row of EVERY_ROW) {
    compared++;
    const a = originalMatch(row, key, role);
    const b = matchConditionFilter(row, key, role);
    if (a !== b && !drift) drift = { key, role, row, was: a, now: b };
  }
  ok(compared > 2000, `the battery is real: ${compared} comparisons`, String(compared));
  ok(!drift, 'THE ONE THAT MATTERS: not one verdict moved when the rule was extracted',
    drift ? JSON.stringify(drift) : '');

  // …and the battery genuinely disagrees somewhere, or "identical" is a
  // tautology about a predicate that answers the same thing to everything.
  const trues = EVERY_ROW.filter((r) => matchConditionFilter(r, 'signed', 'processor')).length;
  ok(trues > 0 && trues < EVERY_ROW.length,
    'the battery separates rows rather than answering the same for all of them', `${trues}/${EVERY_ROW.length}`);
}

// ── C. THE THREE THE OWNER NAMED ────────────────────────────────────────────
console.log('\nC. DONE, SIGNED OFF, OUTSTANDING — the three the owner asked for by name');
{
  const outstanding = { status: 'outstanding' };
  const signed = { status: 'received', signed_off_at: '2026-09-01' };
  const officerDone = { status: 'received', reviewed_at: '2026-09-01' };

  ok(matchConditionFilter(outstanding, 'awaiting', 'processor'), 'OUTSTANDING: a not-started condition is in the outstanding view');
  ok(!matchConditionFilter(signed, 'awaiting', 'processor'), '…and a signed-off one is not');

  ok(matchConditionFilter(signed, 'signed', 'processor'), 'SIGNED OFF: a signed-off condition is in the signed-off view');
  ok(!matchConditionFilter(outstanding, 'signed', 'processor'), '…and an untouched one is not');

  ok(!matchConditionFilter(officerDone, 'mine', 'loan_officer'),
    'DONE: the officer\'s own Done stamp takes the row out of their default view');
  ok(matchConditionFilter(officerDone, 'mine', 'processor'),
    '…and the back office still sees it, because nobody has signed it off');
  ok(matchConditionFilter(officerDone, 'unsigned', 'processor'),
    '…and it is still "not signed off yet", which is the view that asks that question');
}

// ── D. WORDS ────────────────────────────────────────────────────────────────
console.log('\nD. WHAT THE OPTIONS ARE CALLED');
{
  ok(conditionFilterLabel('mine', 'loan_officer') === 'Needs my review', 'the officer is asked about their REVIEW');
  ok(conditionFilterLabel('mine', 'processor') === 'Needs my sign-off', 'the back office about their SIGN-OFF');
  // The status words are the shared vocabulary's, never retyped — so a filter
  // can never name a state differently from the row stamp under it.
  ok(conditionFilterLabel('awaiting') === conditionStatusLabel('outstanding'), 'the outstanding label comes from the shared vocabulary');
  ok(conditionFilterLabel('review') === conditionStatusLabel('received'), 'so does the received one');
  ok(conditionFilterLabel('attention') === conditionStatusLabel('issue'), 'so does the needs-attention one');
  ok(conditionFilterLabel('signed') === 'Signed off', 'signed off says so');
  ok(conditionFilterLabel('all') === 'Everything', 'everything says so');
  ok(CONDITION_FILTER_KEYS.every((k) => typeof conditionFilterLabel(k, 'processor') === 'string'
    && conditionFilterLabel(k, 'processor').length > 0), 'every offered option has a name');
  ok(new Set(CONDITION_FILTER_KEYS.map((k) => conditionFilterLabel(k, 'processor'))).size === CONDITION_FILTER_KEYS.length,
    'no two options read the same — a picker with two identical lines cannot be used');
  ok(conditionFilterHint('loan_officer') !== conditionFilterHint('processor'),
    'the tooltip tells each role what actually clears a row for them');
  ok(CONDITION_FILTER_KEYS[0] === 'mine', 'the default is first — the question a person opening a file is asking');
  ok(CONDITION_FILTER_KEYS[CONDITION_FILTER_KEYS.length - 1] === 'all', '…and everything is last, the escape hatch');
}

// ── E. THE LIST HELPER ──────────────────────────────────────────────────────
console.log('\nE. OVER A LIST');
{
  const list = [{ status: 'outstanding' }, { status: 'satisfied' }, { status: 'received', reviewed_at: 'x' }];
  const before = JSON.stringify(list);
  const out = filterConditions(list, 'mine', 'loan_officer');
  ok(out.length === 1 && out[0].status === 'outstanding', 'the officer is left with the one row still theirs');
  ok(JSON.stringify(list) === before, 'the array it was handed is never mutated');
  ok(Array.isArray(filterConditions(null, 'all', 'processor')), 'a missing list answers an empty array, never a throw');
  ok(filterConditions(undefined, 'all', 'processor').length === 0, '…and it is empty');
}

// ── F. ONE DEFINITION — the guard a behaviour test cannot be ────────────────
console.log('\nF. THERE IS EXACTLY ONE OF THIS RULE, AND EVERY SCREEN READS IT');
{
  const READERS = [
    ['app-v2/src/screens/StaffApplication.jsx', 'the short-term file screen'],
    ['app-v2/src/screens/StaffTasks.jsx', 'the personal task queue'],
    ['app-v2/src/longterm/LtFileConditions.jsx', 'the Long-Term conditions list'],
  ];
  for (const [path, what] of READERS) {
    const src = read(path);
    const bare = stripComments(src);
    ok(/from\s+['"][^'"]*lib\/condition-filter\.js['"]/.test(bare),
      `${what} imports the shared rule`);
    ok(!/function\s+roleDone\s*\(/.test(bare),
      `${what} carries NO second copy of the off-my-plate rule`);
  }

  /* The one that would let the two products drift apart quietly: a screen
     typing out its own <option> list. The short-term side had seven; a view
     added there and not here is exactly the shape the share-the-code directive
     exists to stop. */
  const PICKERS = [
    ['app-v2/src/screens/StaffApplication.jsx', 'the short-term file screen'],
    ['app-v2/src/longterm/LtFileConditions.jsx', 'the Long-Term conditions list'],
  ];
  for (const [path, what] of PICKERS) {
    const bare = stripComments(read(path));
    ok(bare.includes('CONDITION_FILTER_KEYS.map('),
      `${what} builds its picker from the shared key list`);
    for (const dead of ['value="signed"', "value='signed'", 'value="unsigned"', 'value="awaiting"']) {
      ok(!bare.includes(dead), `${what} does not hand-type the option "${dead}"`);
    }
  }

  /* THE LONG-TERM SIDE RUNS IT ON THE SHARED SHAPE. That is the whole reason one
     rule can serve two products whose stored statuses differ — Long-Term calls a
     waive its own status and `in_progress` what the other side calls `requested`.
     Filtering its RAW rows would silently answer "outstanding" to nothing. */
  const lt = stripComments(read('app-v2/src/longterm/LtFileConditions.jsx'));
  ok(/matchConditionFilter\(\s*asSharedCondition\(/.test(lt),
    'Long-Term filters the SHARED shape, not its own stored statuses');

  /* And the tick it replaced is gone rather than left beside it: two controls
     that overlap are two controls that disagree, and a row hidden by one and
     shown by the other is the state nobody can explain. */
  ok(!/showDone/.test(lt), 'the old show-finished tick is gone, not sitting beside the picker');

  /* WHO IS READING DECIDES WHICH ROWS ARE SHOWN, so the list must not be drawn
     before the answer arrives — otherwise a loan officer watches rows they had
     already marked Done vanish a beat after the page settles. The flag has to be
     separate from `role` itself and set on the FAILURE path too, or a role we
     cannot read leaves the whole screen blank forever. */
  ok(/!data \|\| !roleKnown/.test(lt), 'the Long-Term list waits until it knows who is reading');
  ok(/\.finally\(\(\)\s*=>\s*\{\s*if \(alive\) setRoleKnown\(true\)/.test(lt),
    '…and a role it could not read still lets the screen render');
}

console.log(`\n${failures === 0 ? 'ok' : 'FAILED'} — test-condition-filter-pure${failures ? `: ${failures} failure(s)` : ''}`);
process.exit(failures ? 1 : 0);
