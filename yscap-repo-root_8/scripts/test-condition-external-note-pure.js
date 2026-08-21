'use strict';
/* THE TWO NOTES CANNOT SWAP PLACES — the source half (db/604).
 *
 * The DB suite proves the behaviour against a real Postgres over real HTTP. This one
 * runs in the no-database job too, and guards the three things that are facts about
 * the SOURCE rather than about a request:
 *
 *   · the borrower and TPO routes still never SELECT the internal note;
 *   · every client surface goes through the ONE definition rather than reading the
 *     raw column, so neither can skip the scrub;
 *   · the raw columns are DELETED from the row before the response ships, so a
 *     future consumer downstream cannot reach past that scrub.
 *
 * A leak here is a capital-partner name on a borrower's screen, which is the
 * standing hard rule this whole module exists under.
 */
const fs = require('fs');
const path = require('path');
const R = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(R, p), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };

const EXT = require(R + '/src/lib/conditions/external-note');

console.log('\nA. the rule');
ok(EXT.clean('  a  ') === 'a' && EXT.clean('') === null && EXT.clean(null) === null && EXT.clean('  \n ') === null,
  'an empty note is NOTHING, never an empty string');
ok(EXT.clean('x'.repeat(EXT.EXTERNAL_NOTE_MAX + 50)).length === EXT.EXTERNAL_NOTE_MAX, 'a stored note cannot exceed the cap');
ok(EXT.noteProblem({}) !== '' && EXT.noteProblem([]) !== '', 'a note that is not text is refused rather than stringified into nonsense');
ok(EXT.forClient({ external_note: 'hi' }, undefined) === null,
  'NO scrubber → NO note. It fails CLOSED: shipping an unscrubbed note is the failure this guards.');
ok(EXT.forClient(null, (v) => v) === null && EXT.forClient({}, (v) => v) === null, 'nothing to say → nothing sent');
ok((() => { const o = EXT.forClient({ external_note: ' x ', external_note_at: 'T' }, (v) => v); return o.note === 'x' && o.at === 'T'; })(),
  'what ships is the words and WHEN');
ok((() => { const o = EXT.forClient({ external_note: 'x', external_note_by: 'staff-uuid' }, (v) => v); return !('by' in o); })(),
  '…and never who — the client surfaces are outside the company');
ok(EXT.forClient({ external_note: 'x' }, () => '   ') === null,
  'a note the scrub empties out is not sent as a blank card');

console.log('\nB. the routes');
for (const [file, who] of [['src/routes/borrower.js', 'the borrower'], ['src/routes/tpo.js', 'the broker']]) {
  const src = read(file);
  // The checklist query is the one that selects a condition's columns for a client.
  ok(!/^\s*(ci\.notes|.*\bci\.notes\b.*AS)/m.test(src.replace(/--[^\n]*/g, '')),
    `${who}'s routes never select the internal note`);
  ok(/externalNote\.forClient\(/.test(src),
    `${who}'s route goes through the ONE definition, so it cannot skip the scrub`);
  // ANCHORED TO A LINE START — the un-anchored form matches the commented-out line
  // too, so the guard passed while the thing it guards was switched off.
  ok(/^\s*delete (it|s)\.external_note; delete (it|s)\.external_note_at;/m.test(src),
    `${who}'s route DELETES the raw columns, so nothing downstream can reach past the scrub`);
}

console.log('\nC. the staff screen tells them apart in WORDS, not by colour');
const line = read('app-v2/src/components/ConditionLine.jsx');
ok(/field: 'notes'/.test(line) && /field: 'externalNote'/.test(line),
  'the two editors write DIFFERENT fields — one cannot post into the other');
ok(/banner: null,/.test(line) && /banner: 'Visible to the borrower and the broker'/.test(line),
  'only the external one carries a standing label naming who reads it');
ok(/\{K\.banner && <div className="cnd-note-warn">\{K\.banner\}<\/div>\}/.test(line),
  '…and it stays on screen while you type, not only on the button you already clicked');
ok(/add: '\+ Add a note the borrower will see'/.test(line) && /placeholder: 'The borrower and the broker will read this…'/.test(line),
  'the button and the placeholder say it too — three chances to notice before a word is typed');

console.log('\nD. one component for both client surfaces');
for (const f of ['app-v2/src/screens/Application.jsx', 'app-v2/src/screens/TpoFile.jsx']) {
  ok(/import ConditionTeamNote from '\.\.\/components\/ConditionTeamNote\.jsx'/.test(read(f)) && /<ConditionTeamNote note=/.test(read(f)),
    `${f.split('/').pop()} renders the shared note component — one sentence, shown one way`);
}
const tn = read('app-v2/src/components/ConditionTeamNote.jsx');
ok(/if \(!body\) return null;/.test(tn), 'with no note it renders nothing at all');
ok(!/external_note_by|\bby\b\s*=/.test(tn), 'and it has no way to show an author even if one were sent');

console.log(`\ntest-condition-external-note-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
