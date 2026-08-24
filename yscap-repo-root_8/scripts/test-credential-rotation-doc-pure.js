'use strict';
/**
 * TEST — THE ROTATION RUNBOOK IS DERIVED FROM THE CODE, NOT TYPED BESIDE IT.
 *
 * WHY THIS EXISTS. `docs/CREDENTIAL-ROTATION.md` exists because rotating an
 * Encompass credential on this system is NOT "change one variable": Long-Term's
 * credentials FALL BACK to the shared ones, so an `LT_`-prefixed override that is
 * set holds the OLD value after a rotation and takes Long-Term down while retail
 * keeps working. The runbook's whole value is that it lists that fallback chain
 * correctly. A runbook that lists it WRONG is worse than none — it is a confident
 * wrong answer given to somebody mid-outage.
 *
 * THE LESSON THIS ENCODES was learned the expensive way on 2026-08-24, when a
 * hand-typed list sitting beside a machine-recorded census omitted eleven values,
 * invented two, and a decision was made from the summary. So the chain is not
 * asserted from memory here: it is READ OUT OF `src/longterm/config.js` and every
 * pair found there must appear in the document.
 *
 * AND WHILE AUDITING THE RUNBOOK, TWO OF ITS OWN CLAIMS WERE WRONG — the flood
 * fallback was attributed to the wrong file, and "nothing reads RENDER_API_KEY"
 * missed the restore procedure that does. Both are now pinned.
 *
 * IT ALSO ENFORCES THE RULE THE RUNBOOK IS ABOUT: no secret VALUE may appear in
 * it. That check is structural — this file must never carry a real secret to
 * compare against.
 *
 * PURE. Reads two source files and one document. No database, no network.
 */

const path = require('path');
const fs = require('fs');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const DOC = 'docs/CREDENTIAL-ROTATION.md';
const doc = read(DOC);

// ── 1. The fallback chain, read out of the code ──────────────────────────────
console.log('the fallback chain the runbook lists must be the one the code implements');

const ltConfig = read('src/longterm/config.js');
const pairs = [...ltConfig.matchAll(
  /process\.env\.(LT_ENCOMPASS_[A-Z0-9_]+)\s*\|\|\s*process\.env\.(ENCOMPASS_[A-Z0-9_]+)/g)]
  .map((m) => [m[1], m[2]]);

check(pairs.length >= 5,
  `src/longterm/config.js falls back on at least five credentials (${pairs.length} found)`);

for (const [lt, shared] of pairs) {
  // The document must name BOTH halves — a chain listed with only one half of a
  // pair is the exact failure this guards: the override nobody thought to check.
  check(doc.includes(lt) && doc.includes(shared),
    `the runbook names both halves of ${lt} || ${shared}`);
}

// And nothing may be listed that the code does NOT fall back on — an invented
// pair sends somebody hunting a variable that does not exist.
const docPairs = [...doc.matchAll(/^(LT_ENCOMPASS_[A-Z0-9_]+)\s*\|\|\s*(ENCOMPASS_[A-Z0-9_]+)$/gm)]
  .map((m) => `${m[1]}||${m[2]}`);
const codePairs = new Set(pairs.map(([a, b]) => `${a}||${b}`));
check(docPairs.length === pairs.length,
  `the runbook's chain block lists exactly as many pairs as the code has (${docPairs.length} vs ${pairs.length})`);
for (const p of docPairs) {
  check(codePairs.has(p), `the runbook's "${p.replace('||', ' || ')}" is a pair the code really implements`);
}

// ── 2. The two claims that were wrong on the first pass ──────────────────────
console.log('');
console.log('the claims the audit corrected stay correct');

const flood = read('src/encompass/flood-order.js');
check(/flood\.clientId\s*\|\|\s*enc\.clientId/.test(flood),
  'the flood fallback really does live in src/encompass/flood-order.js, per field');
check(doc.includes('src/encompass/flood-order.js'),
  'and the runbook attributes it to that file rather than to config.js');

const cfg = read('src/config.js');
check(/ENCOMPASS_FLOOD_CLIENT_ID\s*\|\|\s*null/.test(cfg),
  'src/config.js really does leave the flood credentials null (which is why the attribution mattered)');

check(doc.includes('docs/DATABASE-BACKUP-AND-RESTORE.md'),
  'the runbook points at the one documented use of the Render API key rather than claiming there is none');
check(read('docs/DATABASE-BACKUP-AND-RESTORE.md').includes('RENDER_API_KEY'),
  'and that document does in fact use it');

// ── 3. The rule the runbook is about, applied to the runbook ─────────────────
console.log('');
console.log('the runbook itself carries no secret VALUE');

// Structural, not a blocklist: a secret value would show up as a long opaque
// token that is not one of the variable names or paths the document legitimately
// carries. Anything alphanumeric-and-long that is NOT a known-safe shape fails.
const SAFE = /^(?:[A-Z0-9_]+|[A-Za-z0-9_./-]+\.(?:md|js|json|sql)|https?:.*)$/;
const suspects = (doc.match(/[A-Za-z0-9_+./=-]{28,}/g) || []).filter((t) => !SAFE.test(t));
check(suspects.length === 0,
  `no long opaque token that is not a variable name or a file path (${suspects.length}${suspects.length ? `: ${suspects.slice(0, 3).join(', ')}` : ''})`);

// The order of operations is the thing that keeps the integration up. If it is
// dropped, the runbook stops being a runbook.
const prose = doc.replace(/\s+/g, ' ');
check(/Only then.{0,40}revoke the old value/i.test(prose),
  'the runbook still says to revoke the old value LAST, after the new one is in and restarted');
check(/fails closed/i.test(prose) && /503/.test(doc) && /403/.test(doc),
  'and it still says the webhook fails closed, with both refusal codes, so a rotation window is not mistaken for a breach');

console.log('');
if (failures) {
  console.error(`\n${failures} FAILED`);
  process.exit(1);
}
console.log('all good');
