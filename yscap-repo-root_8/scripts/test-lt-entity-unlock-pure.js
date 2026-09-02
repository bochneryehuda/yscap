#!/usr/bin/env node
'use strict';
/**
 * THE ENTITY SECTION UNLOCKS WHEN VERIFICATION IS REVOKED (owner-reported
 * 2026-09-02: *"On the entity conditions section, you can't edit anything. I
 * thought it's because it's a verified entity block, but I clicked on revoke
 * verification. I tried editing, and it didn't work."*).
 *
 * ROOT CAUSE, MEASURED IN THE SOURCE: the shared section
 * (`components/LlcManager.jsx`) computes `locked` from the `is_verified` it
 * loaded, and its reload effect is keyed on the company id ALONE — so a revoke
 * made from the long-term control lifted the lock on the server
 * (`src/lib/llc-edit.js` refuses on `is_verified`, which the revoke clears) and
 * left the form greyed until somebody reloaded the page. The database suite
 * (`test-lt-entity-section-db.js` F5–F7) proved the SERVER side of a revoke and
 * nothing proved the client.
 *
 * WHAT IS PROVEN HERE, from the source with comments stripped:
 *   A. The shared section really is keyed on the id alone (so the fix below is
 *      the right shape — if that changes, this test says so and the key can go).
 *   B. The long-term control remounts the section when the lock flips.
 *   C. The unlock → edit → lock flow is named as such, on both states.
 *   D. The section is reachable on the borrower's profile from the file, and
 *      the workspace hands the screen the borrower it belongs to.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

let pass = 0;
const fails = [];
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); return; }
  fails.push(detail ? `${name} — ${detail}` : name);
  console.log('  ✗ ' + name + (detail ? ` — ${detail}` : ''));
};

console.log('\nA. THE SHARED SECTION RELOADS ON THE COMPANY ID ALONE');
{
  const src = strip(read('app-v2/src/components/LlcManager.jsx'));
  ok(/const locked = !!llc\.is_verified \|\| readOnly;/.test(src),
    'the lock is computed from the is_verified the section itself loaded');
  ok(/useEffect\(\(\) => \{[^}]*load\(\);[^}]*\}, \[llcId\]\);/.test(src),
    'and its reload effect is keyed on llcId alone — which is why a revoke from outside it left the form locked');
}

console.log('\nB. THE LONG-TERM CONTROL REMOUNTS THE SECTION WHEN THE LOCK FLIPS');
{
  const src = strip(read('app-v2/src/longterm/LtEntity.jsx'));
  ok(/<LlcManager\s+key=\{`\$\{llcId\}:\$\{profile\.verified \? 'locked' : 'open'\}`\}/.test(src),
    'THE ONE THAT MATTERS: the section\'s key carries the verified state, so a revoke re-reads the company and unlocks the form on the spot');
  ok(!/<LlcManager\s+key=\{llcId\}/.test(src), 'the old id-only key is gone');
  // The control refreshes the workspace after a verify/revoke, which is what
  // flips `profile.verified` and therefore the key.
  ok(/await ltApi\.entityVerify\(loanId, llcId,[\s\S]*?if \(onChanged\) await onChanged\(\);/.test(src),
    'and after a verify or revoke it re-reads the workspace, which is where the new lock state comes from');
}

console.log('\nC. UNLOCK → EDIT → LOCK, IN THOSE WORDS');
{
  const src = read('app-v2/src/longterm/LtEntity.jsx');
  ok(/Unlock to edit \(revoke verification\)/.test(src), 'the verified state offers "Unlock to edit"');
  ok(/Lock & mark verified/.test(src), 'the unlocked state offers "Lock & mark verified"');
  ok(/Unlock to edit, make the change, then lock it again/.test(src), 'the sentence tells the reader the whole loop');
  ok(/entity type, details, owners and documents/.test(src), 'and names what is locked — the entity type the owner could not select, included');
  // A revoke still asks for a reason: the borrower is told why.
  ok(/askPrompt\('Revoke verification of this company\?/.test(strip(src)), 'unlocking still asks for the reason a revoke has always needed');
}

console.log('\nD. THE SAME COMPANY, ON THE BORROWER\'S PROFILE');
{
  const ws = strip(read('src/longterm/conditions-center/workspace.js'));
  ok(/profile: \{ \.\.\.prefill, borrowerId: vesting\.borrowerId \? String\(vesting\.borrowerId\) : null \}/.test(ws),
    'the workspace hands the screen the borrower the company belongs to');
  const src = strip(read('app-v2/src/longterm/LtEntity.jsx'));
  ok(/href=\{`#\/internal\/borrowers\/\$\{encodeURIComponent\(profile\.borrowerId\)\}`\}/.test(src),
    'and the control links to that borrower\'s own page, where the same section is edited');
  const app = strip(read('app-v2/src/App.jsx'));
  ok(/path="\/internal\/borrowers\/:id"/.test(app), 'which is a route the app actually serves');
  const detail = strip(read('app-v2/src/screens/StaffBorrowerDetail.jsx'));
  ok(/<LlcManager /.test(detail), 'and that page renders the SAME shared section — one record, two doors');
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { fails.forEach((f) => console.error('  FAIL ' + f)); process.exit(1); }
