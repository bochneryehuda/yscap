'use strict';
/**
 * LT test — WHO GRANTED ACCESS, AND WHEN, REACHES A SCREEN.
 *
 * WHY THIS EXISTS. Two long-term actions hand somebody access to files:
 *
 *   · REASSIGNING a file (`lt_loan_contacts.override_staff_id`) — `access.onFileSql`
 *     matches that column, so naming somebody puts the file in their pipeline and
 *     lets them open it, and clearing it takes that away.
 *   · CONFIRMING a person's Encompass link (`lt_staff_links`) — which decides whose
 *     pipeline every file that login is named on lands in.
 *
 * Both write who did it and when, on the row, at the moment they do it. Long-Term
 * writes nothing to `audit_log` — that is an RTL table and this side does not touch
 * one without a written crossing — so THE ROW IS THE ONLY RECORD THERE IS. And for
 * both of them the stamp was written and read by nothing: the file screen said a
 * file had been reassigned and why, and never by whom; the people screen said a
 * link was confirmed and never by whom or when.
 *
 * That is the same shape as a column with no writer, inverted: nothing fails, the
 * data is perfectly correct, and the only place it exists is a table nobody looks
 * at. So this test follows each fact from the row it is written on to the element
 * that draws it, and fails if any link in that chain goes.
 *
 * PURE. Reads source. No database, no network.
 */

const path = require('path');
const fs = require('fs');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
/** Comments EXPLAIN these rules and name every column, so a guard that read them
 *  would pass on its own documentation and be "fixed" by deleting it. */
const code = (p) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const contacts = code('src/longterm/people/contacts.js');
const routeSrc = code('src/longterm/routes/pipeline.js');
const loanUi = code('app-v2/src/longterm/LtLoan.jsx');
const roster = code('src/longterm/people/roster.js');
const peopleUi = code('app-v2/src/longterm/LtPeople.jsx');

// ── The reassignment ─────────────────────────────────────────────────────────
console.log('reassigning a file records who did it, and the screen says so');

check(/override_by\s*=/.test(contacts) && /override_at\s*=/.test(contacts),
  'the reassignment still writes who and when — the record starts here');
check(/\boverrideBy: row\.override_by/.test(contacts) && /\boverrideAt: row\.override_at/.test(contacts),
  'and the contact a screen is handed CARRIES them, rather than only the reason (which is all it carried while this went unnoticed)');
check(/\boverrideByName: overrideByName/.test(contacts) && /overrideByName = null/.test(contacts),
  '…including a place for the person\'s NAME, because an id is not something anybody can read');

check(/t\.override_by/.test(routeSrc) && /row\.override_by/.test(routeSrc),
  'BOTH routes resolve that name — the file header and the reassign response, because a row that updates in place after the save would otherwise lose the stamp the reload shows');
check(/\[t\.staff_id, t\.override_staff_id, t\.override_by\]/.test(routeSrc),
  '…out of the staff lookup the route was ALREADY making, so naming who reassigned a file costs no extra query');

check(/c\.overridden && \(c\.overrideReason \|\| c\.overrideByName \|\| c\.overrideAt\)/.test(loanUi),
  'THE ONE THAT MATTERS: the file screen draws who reassigned it and when — reassigning grants that person access to the file, and this row is the only record of it Long-Term keeps');
check(/\{c\.overrideByName \|\| c\.overrideAt \?/.test(loanUi)
  && /c\.overrideByName \? ` by \$\{c\.overrideByName\}` : ''/.test(loanUi)
  && /c\.overrideAt \? ` on \$\{day\(c\.overrideAt\)\}` : ''/.test(loanUi),
  '…each half only when we hold it, so a person since deleted or a missing date never prints as "by  on "');

// ── The people map ───────────────────────────────────────────────────────────
console.log('\nconfirming a person records who did it, and the screen says so');

check(/\bconfirmedBy: link && link\.confirmed_by/.test(roster) && /\bconfirmedAt: link \?/.test(roster),
  'the people map carries who confirmed a link and when — confirming one decides whose pipeline that login\'s files land in');
check(/\bconfirmedByName: link && link\.confirmed_by/.test(roster) && /staffBy\.get\(String\(link\.confirmed_by\)\)/.test(roster),
  '…with the name resolved from the staff list the roster already loaded, so this costs no query either');
check(/p\.status === 'confirmed' && \(p\.confirmedByName \|\| p\.confirmedAt\) \?/.test(peopleUi),
  'and the people screen draws both, on the confirmed rows where they mean something');

console.log('\nand the screen says what a person actually DOES in Encompass');

check(/\broles: Array\.isArray\(u\.role_names\)/.test(roster),
  'the roles the roster has recorded on every sync reach the screen — they were written from the day it shipped and read by nothing');
check(/\{p\.roles && p\.roles\.length \?/.test(peopleUi) && /p\.roles\.join\(/.test(peopleUi),
  'THE ONE THAT MATTERS: the people screen shows them, because confirming a link on a NAME alone is how the wrong person ends up owning somebody else\'s files');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
