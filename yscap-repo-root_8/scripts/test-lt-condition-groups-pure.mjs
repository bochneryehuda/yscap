// LT test — how the Condition Center folds its list up. No database, no network,
// no browser: the rule lives in its own plain module precisely so it can be RUN.
//
// Everything asserted here is invisible in a screenshot of a folded section, and
// each of them is a way a person is misled rather than merely inconvenienced:
//
//   · a section that says "all done" while something is still outstanding;
//   · a count that disappears with the contents, so the only way to find the work
//     is to open all nine gates;
//   · a re-sort in the browser, which makes the screen and the API disagree about
//     what "first" means between two reads;
//   · a condition with no stated gate quietly folded into a real one.

import { groupConditions, groupDone, groupSummary } from '../app-v2/src/longterm/conditionGroups.js';

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const C = (id, group, open) => ({ id, group, open });

console.log('conditions are bucketed by the gate they block');

// DELIBERATELY NOT IN ALPHABETICAL ORDER, in either dimension: the gates arrive
// Funding-then-Docs and the Docs conditions arrive 5, 1, 2. A fixture that is
// already sorted cannot notice a sort, and an order assertion that cannot fail
// is worse than none — it reads as proof.
const groups = groupConditions([
  C('3', 'Funding', false), C('5', 'Docs', true), C('1', 'Docs', true),
  C('2', 'Docs', false), C('4', null, true),
]);
const byName = Object.fromEntries(groups.map((g) => [g.name, g]));

check(groups.length === 3, 'one bucket per gate');
check(byName.Docs.total === 3 && byName.Docs.open === 2,
  'each carries BOTH figures — how much is in it and how much of that is still outstanding');
check(!!byName['Not stated'] && byName['Not stated'].total === 1,
  'a condition with no stated gate gets its OWN bucket — folding it into a real gate would claim it blocks something it may not');

check(groups.map((g) => g.name).join() === 'Funding,Docs,Not stated',
  'the buckets appear in the order the conditions arrived, so the server keeps owning the order');
check(byName.Docs.items.map((i) => i.id).join() === '5,1,2',
  'and so do the conditions inside one — the server sends unapproved first, chosen so the list does not reshuffle under somebody\'s cursor between two reads');

console.log('\nwhat the header says, folded or not');

check(groupSummary(byName.Docs) === '2 of 3 outstanding',
  'a gate with work names the work — this is on the SUMMARY, so it survives being folded away');
check(groupSummary(byName.Funding) === 'all 1 done',
  'a finished gate says so plainly rather than showing a zero');
check(groupDone(byName.Funding) === true && groupDone(byName.Docs) === false,
  'and one rule decides both the wording and the fold, so a section can never sit open saying "all done"');

console.log('\nnothing is invented from nothing');

check(groupConditions([]).length === 0 && groupConditions(null).length === 0,
  'no conditions is no groups — never an empty gate that reads as "nothing outstanding here"');
check(groupDone({ name: 'Docs', total: 0, open: 0 }) === false,
  'an EMPTY group is not a finished one: zero of zero done is not an achievement, and calling it done would fold away the only clue that the gate is unpopulated');
check(groupSummary(null) === 'nothing here' && groupSummary({ total: 0 }) === 'nothing here',
  '…and it says that rather than dividing by nothing');

const nulls = groupConditions([C('a', 'Docs', null), C('b', 'Docs', undefined)]);
check(nulls[0].open === 0 && nulls[0].total === 2,
  'a condition whose outstanding flag the server did not answer is counted in the total and not in the outstanding — the server has already decided how to report a null, and a second reading of it here is how the two come to disagree');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
