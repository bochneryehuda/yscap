/**
 * COMPLETENESS IS THREE LISTS, BY SUBJECT (owner-directed 2026-08-02: split it
 * three ways — the application, the borrower, the co-borrower).
 *
 * It was one flat run of pills that mixed the DEAL (address, program, price, loan
 * number) with the PERSON (date of birth, Social, FICO), while the co-borrower's
 * identical six fields sat in their own section below — which only made the
 * primary borrower's identity look like part of the deal.
 *
 * THE RULE THIS PINS, and it is pinned in BOTH directions so a new field cannot
 * quietly land in the wrong list: a row that reads `borrower.*` is about the
 * PERSON and belongs to the borrower list; every other row is about the FILE.
 * Checking only one direction would let the split rot the moment somebody adds a
 * deal field to the borrower list.
 *
 * Pure — it reads the source. No DB, no browser.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = fs.readFileSync(path.join(here, '..', 'app-v2', 'src', 'screens', 'StaffApplication.jsx'), 'utf8');

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

/* Slice a `const NAME = (…) => [ … ];` list out of the source by walking the
   brackets — a regex would stop at the first `]` inside an options array. */
function listBody(name) {
  const start = file.indexOf(`const ${name} = (`);
  if (start < 0) return null;
  const open = file.indexOf('[', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < file.length; i++) {
    const ch = file[i];
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) return file.slice(open, i + 1); }
  }
  return null;
}
/* Every `key: '…'` at the TOP level of the list (a nested options array carries
   no `key:`, so a plain scan is safe here). */
const keysOf = (body) => Array.from(body.matchAll(/\{\s*key:\s*'([^']+)'/g)).map((m) => m[1]);
/* One field descriptor per key, so each can be judged on its own text. */
function rowsOf(body) {
  const out = {};
  const re = /\{\s*key:\s*'([^']+)'/g;
  let m;
  const starts = [];
  while ((m = re.exec(body))) starts.push([m.index, m[1]]);
  starts.forEach(([idx, key], i) => {
    out[key] = body.slice(idx, i + 1 < starts.length ? starts[i + 1][0] : body.length);
  });
  return out;
}

console.log('\nA. there are three lists, and the old combined one is gone');

const appBody = listBody('APP_COMPLETENESS_FIELDS');
const borBody = listBody('BORROWER_COMPLETENESS_FIELDS');
const coBody = listBody('CO_COMPLETENESS_FIELDS');
ok(!!appBody, 'the APPLICATION list exists');
ok(!!borBody, 'the BORROWER list exists');
ok(!!coBody, 'the CO-BORROWER list exists');
ok(!/const COMPLETENESS_FIELDS\s*=/.test(file),
  'the old combined list is gone, not merely bypassed — a leftover would drift');

if (!appBody || !borBody || !coBody) {
  console.error('\ncannot continue without all three lists');
  process.exit(1);
}

const appKeys = keysOf(appBody);
const borKeys = keysOf(borBody);
const coKeys = keysOf(coBody);
const appRows = rowsOf(appBody);
const borRows = rowsOf(borBody);

console.log('\nB. the split is by SUBJECT — checked BOTH ways');

// → a row that reads the PERSON must be in the borrower list…
for (const [key, row] of Object.entries(appRows)) {
  ok(!/\bborrower\s*&&\s*borrower\./.test(row) && !/\bborrower\.[a-z_]/.test(row),
    `the application list's "${key}" does not read the person's record`);
}
// …and every row in the borrower list must genuinely be about the person.
for (const [key, row] of Object.entries(borRows)) {
  ok(/\bborrower\b/.test(row),
    `the borrower list's "${key}" really is a fact about the person`);
}

console.log('\nC. nothing was lost or duplicated in the split');

const DEAL = ['property_address', 'entity_name', 'property_type', 'program', 'loan_type',
  'arv', 'rehab_budget', 'lender', 'ys_loan_number'];
for (const k of DEAL) ok(appKeys.includes(k), `the deal keeps "${k}"`);
const PERSON = ['cell_phone', 'current_address', 'date_of_birth', 'ssn', 'fico', 'citizenship'];
for (const k of PERSON) ok(borKeys.includes(k), `the borrower keeps "${k}"`);
{
  const overlap = appKeys.filter((k) => borKeys.includes(k));
  ok(overlap.length === 0, `no field is asked for twice (overlap: ${overlap.join(', ') || 'none'})`);
}
{
  // The two people are asked the same things — the co-borrower list is the
  // mirror, so a field added to one and not the other is a real gap.
  const mirrored = { cell_phone: 'co_phone', date_of_birth: 'co_dob', ssn: 'co_ssn',
    fico: 'co_fico', citizenship: 'co_citizenship' };
  for (const [mine, theirs] of Object.entries(mirrored)) {
    ok(borKeys.includes(mine) && coKeys.includes(theirs),
      `"${mine}" is asked of BOTH people (${theirs} on the co-borrower)`);
  }
}

console.log('\nD. all three render, each labelled for its subject');

ok(/<Completeness app=/.test(file) && /<BorrowerCompleteness app=/.test(file)
  && /<CoBorrowerCompleteness app=/.test(file),
  'the Missing-info tab renders all three panels');
for (const h of ["Application — what's missing", "Borrower — what's missing", "Co-borrower — what's missing"]) {
  ok(file.includes(h), `a panel is headed "${h}"`);
}
// The write path did NOT change — the borrower's fields still save through the
// same complete-fields door the combined list used, because the server keys on
// the field name, not on which panel it came from.
{
  const bc = file.slice(file.indexOf('function BorrowerCompleteness'));
  ok(/applications\/\$\{appId\}\/complete-fields/.test(bc.slice(0, 500)),
    'the borrower panel still saves through the same door — the split is presentation only');
}
// A panel with nothing missing must not print an empty box on a clean file.
ok(/if \(!fields\.length\) return null;/.test(file),
  'a list with no fields renders nothing');

console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  completeness-split: the deal, the borrower and the co-borrower are asked for separately');
process.exit(fail ? 1 : 0);
