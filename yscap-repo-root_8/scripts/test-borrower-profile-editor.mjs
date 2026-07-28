/* The PERSON is editable wherever they appear — on their profile screen AND on
   the loan file, for the borrower AND the co-borrower (owner-directed 2026-07-27:
   "when we edit the application we can only edit the details of the property, we
   can't edit the borrower profile … a button to edit the entire borrower profile
   over there, so we can edit the 1st borrower profile and the 2nd borrower's
   profile as well — name, social, everything").

   Two things this guards:
   (A) ONE definition. The edit form + the SSN row live in the shared component;
       the profile screen must USE it, never keep a second copy that can drift.
   (B) BOTH people. The loan file must mount the panel for the borrower AND the
       co-borrower — the co-borrower's record previously had no editor anywhere.

   Pure — reads the source, no DB, no browser. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let failures = 0;
const ok = (cond, what) => { if (!cond) { failures++; console.error(`  ✗ ${what}`); } };

const panel = read('app-v2/src/components/BorrowerProfilePanel.jsx');
const file = read('app-v2/src/screens/StaffApplication.jsx');
const screen = read('app-v2/src/screens/StaffBorrowerDetail.jsx');

/* ------------------------------------------------- (A) one shared definition */

ok(/export function BorrowerProfileForm\(/.test(panel), 'the shared edit form is exported');
ok(/export function BorrowerSsnRow\(/.test(panel), 'the shared SSN row is exported');
ok(/export default function BorrowerProfilePanel\(/.test(panel), 'the loan-file panel is the default export');

// Both must come FROM the shared component — the point of the guard. The name
// list is matched loosely so importing a third shared piece alongside them (the
// name-split prompt, for one) does not read as a regression.
ok(/import \{[^}]*\bBorrowerProfileForm\b[^}]*\bBorrowerSsnRow\b[^}]*\} from '\.\.\/components\/BorrowerProfilePanel\.js/.test(screen),
  'the profile screen imports the shared form + SSN row');
ok(!/^function SsnRow\(/m.test(screen), 'the profile screen no longer keeps its own copy of the SSN row');
ok(!/staffUpdateBorrower/.test(screen), 'the profile screen no longer saves the profile itself — the shared form does');
ok(/<BorrowerProfileForm\b/.test(screen), 'the profile screen renders the shared form');
ok(/<BorrowerSsnRow\b/.test(screen), 'the profile screen renders the shared SSN row');

/* ---------------------------------------------------- (B) both people, on the file */

ok(/import BorrowerProfilePanel from '\.\.\/components\/BorrowerProfilePanel\.js/.test(file),
  'the loan file imports the profile panel');
ok(/<BorrowerProfilePanel borrowerId=\{app\.borrower_id\}/.test(file),
  'the loan file mounts the panel for the BORROWER');
ok(/<BorrowerProfilePanel borrowerId=\{app\.co_borrower_id\}/.test(file),
  'the loan file mounts the panel for the CO-BORROWER');
{
  const m = file.match(/<BorrowerProfilePanel/g) || [];
  ok(m.length === 2, `exactly two profile panels on the file (found ${m.length})`);
}
// Both panels must refresh the file after a save — the name they just changed is
// shown in a dozen places further up the page.
{
  const rows = file.match(/<BorrowerProfilePanel[^/]*\/>/g) || [];
  ok(rows.length === 2 && rows.every(r => /onChanged=\{load\}/.test(r)),
    'each panel refreshes the loan file after a save');
  ok(rows.some(r => /heading="Borrower profile"/.test(r)) && rows.some(r => /heading="Co-borrower profile"/.test(r)),
    'the two panels are labelled so you can tell whose record you are editing');
}

/* --------------------------------------------- the record is the WHOLE person */

for (const label of ['First name', 'Last name', 'Email', 'Cell phone', 'Date of birth',
  'Citizenship', 'Marital status', 'Contact type', 'Primary officer',
  'Owns or rents', 'Employment', 'Employer', 'Dependents']) {
  ok(panel.includes(`<span>${label}</span>`), `the editor covers "${label}"`);
}
ok(/Current address/.test(panel) && /Mailing address/.test(panel), 'the editor covers both addresses');
// The Social has its OWN audited endpoint and must never ride along in the
// ordinary profile save.
ok(/staffSetBorrowerSsn/.test(panel), 'the Social is settable (its own audited endpoint)');
ok(!/ssn/i.test(panel.slice(panel.indexOf('async function save('), panel.indexOf('const setCa'))),
  'the ordinary profile save never carries the Social');

/* ------------------------------------------------------------- house style ---
   The white-first portal: `--ink*` tokens are LIGHT and must never be a text
   color (the recurring white-on-white bug). */
ok(!/color:\s*['"]?var\(--ink/.test(panel), 'no --ink token is used as a text color');

if (failures) { console.error(`test-borrower-profile-editor: ${failures} failure(s)`); process.exit(1); }
console.log('test-borrower-profile-editor: ok — one shared editor, mounted for both the borrower and the co-borrower');
