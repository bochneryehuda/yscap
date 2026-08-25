'use strict';
/**
 * ENCOMPASS CATALOG PATHS — the five reads that were being refused, and the two
 * we can prove.
 *
 * WHAT HAPPENED (measured in production 2026-08-25). The nightly field-catalog
 * refresh reported:
 *
 *   [encompass] field-catalog refreshed: {"customField":857,"standardField":0,
 *     "enum":0,"milestone":0,"folder":0,"loanTemplate":0,
 *     "errors":{"standardField":"Encompass 403: ","enum":"Encompass 403: ",
 *               "milestone":"Encompass 403: ","folder":"Encompass 403: ",
 *               "loanTemplate":"Encompass 403: "}}
 *
 * Five of six catalog reads REFUSED, and only the custom fields arriving. The
 * paths had moved under us; nothing in the build noticed, because a 403 caught
 * per-kind reads as a zero in a summary nobody diffs.
 *
 * WHAT THIS PINS. Two of the five have a correction that was PROBED AGAINST THIS
 * TENANT and recorded (the Long-Term API audit, 2026-08-14, written down in
 * `src/longterm/encompass/requests.js`):
 *
 *   · standard fields — /v3/settings/loan/standardFields 403
 *                     → /v3/schemas/loan/standardFields  200 (23,704 fields)
 *   · milestones      — /v3/settings/loan/milestones     403
 *                     → /v3/settings/milestones          200 (the 19-row catalog)
 *
 * So this asserts the RTL client uses the PROVEN paths and can never quietly slip
 * back to the refused ones.
 *
 * AND WHAT IT DELIBERATELY DOES NOT PIN. The enums, folders and templates were
 * never re-probed — the audit's own words are *"the audit did not re-verify their
 * current paths. Confirm against Developer Connect before use."* A path nobody has
 * probed is a guess, and a guessed path that happens to answer is far worse than a
 * 403 that says so. They are left refusing, loudly, until somebody probes them —
 * and section C asserts that nobody has quietly "fixed" them by invention.
 *
 * PURE. Reads the client as TEXT. No database, no network, no credentials.
 */

const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const file = path.join(__dirname, '..', 'src', 'encompass', 'client.js');
const raw = fs.readFileSync(file, 'utf8');
// COMMENTS ARE STRIPPED FIRST, and that is not tidiness: the fix necessarily NAMES
// the refused paths in the note explaining why they moved, so a check that read
// comments would fail on its own explanation and then get "fixed" by deleting it.
const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('the two catalog paths that were probed live');

check(/schemas\/loan\/standardFields/.test(code),
  'THE ONE THAT MATTERS: the standard-field catalog is read from /v3/schemas/loan/standardFields — the path this tenant answers 200 on');
check(!/settings\/loan\/standardFields/.test(code),
  '…and never from /v3/settings/loan/standardFields, which it answers 403 on');

check(/settings\/milestones/.test(code),
  'the milestone catalog is read from /v3/settings/milestones');
check(!/settings\/loan\/milestones/.test(code),
  '…and never from /v3/settings/loan/milestones, which it answers 403 on');

console.log('\nthe custom fields are left exactly as they are');
check(/settings\/loan\/customFields/.test(code),
  'the custom-field path is untouched — it is the one read that was WORKING (857 fields in production), and changing a working call to match a pattern is how a fix breaks something');

console.log('\nthe three nobody has probed are left refusing, not guessed at');
for (const [what, p] of [['enums', 'settings/loan/enums'], ['folders', 'settings/loan/folders'], ['templates', 'settings/loan/loanTemplates']]) {
  check(new RegExp(p.replace('/', '\\/')).test(code),
    `${what} still read from their recorded path — unverified, currently refused, and NOT replaced by a guess`);
}

console.log('\nthe catalog walk cannot silently truncate');
check(/ENCOMPASS_STANDARD_FIELD_MAX/.test(code),
  'the standard-field walk has a stated ceiling rather than an open-ended loop over ~23,700 fields');
check(/capped at/.test(raw),
  '…and it SAYS SO when it stops early — a round number reported as though it were the whole catalog is the silent cap this repo bans');
check(/batch\.length < PAGE/.test(code),
  '…while a short page still ends the walk properly, so a small catalog is read in full and never re-asked for ever');

console.log('\nit is still a read');
check(!/apiPost|apiPut|apiPatch|apiDelete/.test(code),
  'every catalog call is a GET over the read-only client — the Encompass connection is READ-ONLY and this change does not touch that');

console.log('');
if (failures) { console.error(`${failures} FAILED`); process.exit(1); }
console.log('all good');
