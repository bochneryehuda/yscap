#!/usr/bin/env node
'use strict';
/**
 * THE FCI CATALOGUE IS GENERATED — this test is what makes that TRUE rather than aspirational.
 *
 * `docs/fci/API-CATALOG.md` is the reference every future FCI change will be read against: which
 * call answers which question, what it returns, what it can be filtered by. A reference that
 * anybody can hand-edit is a reference that will disagree with FCI and never say so — the exact
 * failure this repo's "generate rather than hand-maintain" rule exists to stop.
 *
 * So: this re-runs the generator against the pinned snapshot and asserts the file on disk is
 * byte-identical. Edit the markdown by hand and this fails. Change the generator and forget to
 * rebuild, and this fails. Re-pin a new FCI release without rebuilding, and this fails.
 *
 * It ALSO proves the extraction itself is not quietly empty, which is the failure mode that would
 * make a green build meaningless: a Postman collection stores the documented GraphQL query on the
 * saved EXAMPLE, not on the request, so a reader that looks in the obvious place finds 70 endpoints
 * with no fields at all and renders a perfectly well-formed, perfectly useless catalogue. The
 * floor assertions below are set from what FCI publishes today and would catch that.
 *
 * PURE: no database, no network, no credential. It reads two files in this repository.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const G = require('./fci-api-catalog.js');

const ROOT = path.resolve(__dirname, '..');
const rel = (p) => path.relative(ROOT, p);

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL  ${name}\n      ${e && e.message ? e.message : e}`);
  }
}

console.log('FCI API catalogue — generated-output proof');

// ---------------------------------------------------------------------------
// The inputs exist
// ---------------------------------------------------------------------------

check('the pinned collection snapshot is present', () => {
  assert.ok(fs.existsSync(G.SNAPSHOT), `${rel(G.SNAPSHOT)} is missing — run: node scripts/fci-api-catalog.js --fetch`);
});

check('the generated catalogue is present', () => {
  assert.ok(fs.existsSync(G.OUTPUT), `${rel(G.OUTPUT)} is missing — run: node scripts/fci-api-catalog.js`);
});

if (!fs.existsSync(G.SNAPSHOT) || !fs.existsSync(G.OUTPUT)) {
  console.error('\ncannot continue without both files');
  process.exit(1);
}

const collection = JSON.parse(fs.readFileSync(G.SNAPSHOT, 'utf8'));
const onDisk = fs.readFileSync(G.OUTPUT, 'utf8');
const rendered = G.render(collection);

// ---------------------------------------------------------------------------
// The catalogue is exactly what the generator produces
// ---------------------------------------------------------------------------

check('docs/fci/API-CATALOG.md is byte-identical to the generator output', () => {
  if (onDisk === rendered) return;
  // Say WHERE it diverged — "files differ" on a 230KB document is not a fix instruction.
  let i = 0;
  while (i < Math.min(onDisk.length, rendered.length) && onDisk[i] === rendered[i]) i++;
  const line = onDisk.slice(0, i).split('\n').length;
  assert.fail(
    `they diverge at line ${line} (byte ${i}). on disk: ${onDisk.length} bytes, generated: ${rendered.length}.\n`
    + '      The catalogue is generated output — never edit it by hand.\n'
    + '      Fix: node scripts/fci-api-catalog.js');
});

// ---------------------------------------------------------------------------
// The extraction is not quietly empty
// ---------------------------------------------------------------------------

// Floors, not exact counts: FCI adding an endpoint must NOT break this build, but FCI's collection
// coming back gutted (or our reader looking in the wrong place) must.
const FLOORS = { operations: 60, rootFields: 50, folderDicts: 12 };

const counted = {
  operations: (rendered.match(/^\| Operations documented \| (\d+) \|$/m) || [])[1],
  rootFields: (rendered.match(/^\| Distinct GraphQL root fields \| (\d+) \|$/m) || [])[1],
  folderDicts: (rendered.match(/^\| Folder-level data dictionaries \| (\d+) \|$/m) || [])[1],
};

for (const k of Object.keys(FLOORS)) {
  check(`the catalogue counts at least ${FLOORS[k]} ${k}`, () => {
    assert.ok(counted[k] !== undefined, `the "${k}" row is missing from the summary table`);
    assert.ok(Number(counted[k]) >= FLOORS[k], `found ${counted[k]}, expected at least ${FLOORS[k]}`);
  });
}

// The four operations the servicing workflow is actually built on. If any of these stops appearing
// under the root field this repo calls, the design doc is describing an API that no longer exists.
const MUST_DOCUMENT = [
  ['getLoanPortfolio', 'the portfolio read every monitoring surface starts from'],
  ['getUpdatedLoanList', 'the delta-sync primitive — without it every sync is a full sweep'],
  ['getPayoffValuetoDate', 'the payoff figure PILOT must never contradict'],
  ['insertDrawLoan', 'the draw push'],
  ['insertBoarding', 'the boarding push'],
  ['getOTPLink', 'the borrower payment link — the only place PILOT may send a borrower to pay'],
];
for (const [root, why] of MUST_DOCUMENT) {
  check(`\`${root}\` is still documented (${why})`, () => {
    assert.ok(rendered.includes('`' + root + '`'), `${root} no longer appears in the catalogue`);
  });
}

// ---------------------------------------------------------------------------
// The reader looks in the right place — the trap this catalogue exists to avoid
// ---------------------------------------------------------------------------

check('queries are read off saved EXAMPLES, not off request.body', () => {
  // Find any request whose own body is empty but whose example carries a query. FCI's collection is
  // full of them; if this finds none, either FCI changed how it documents, or the snapshot is not
  // what we think it is — and in both cases the extraction assumption needs re-checking.
  let emptyRequestWithExampleQuery = 0;
  (function walk(items) {
    for (const it of items || []) {
      if (Array.isArray(it.item)) { walk(it.item); continue; }
      const ownBody = it.request && it.request.body && it.request.body.graphql && it.request.body.graphql.query;
      const exQuery = (it.response || []).some((ex) => G.queryOfExample(ex).text);
      if (!ownBody && exQuery) emptyRequestWithExampleQuery++;
    }
  }(collection.item));
  assert.ok(emptyRequestWithExampleQuery > 0,
    'no request documents itself only through its example — the extraction assumption may no longer hold');
});

check('the html-to-text reader survives the shapes FCI actually publishes', () => {
  assert.strictEqual(G.htmlToText('<p>a</p><p>b</p>'), 'a\nb');
  assert.strictEqual(G.htmlToText('<ul><li>x</li><li>y</li></ul>'), '- x\n- y');
  assert.strictEqual(G.htmlToText('a &amp; b &lt;c&gt;'), 'a & b <c>');
  assert.strictEqual(G.htmlToText(null), '');
  assert.strictEqual(G.htmlToText(undefined), '');
});

check('root-field detection finds both queries and mutations', () => {
  assert.deepStrictEqual(G.rootFields('{ getLoanPortfolio(account:"x") { loanAccount } }'), ['getLoanPortfolio']);
  assert.deepStrictEqual(G.rootFields('mutation{ insertDrawLoan( drawloan: { amount: 1 } ) }'), ['insertDrawLoan']);
  assert.deepStrictEqual(G.rootFields('{\n  getApiVersion\n}'), ['getApiVersion']);
  assert.deepStrictEqual(G.rootFields(''), []);
});

check('a base64 sample attachment is replaced by a sentence that says so', () => {
  // The delimiters must be OUTSIDE the base64 alphabet, or the greedy match swallows them and the
  // reported length is off by the delimiters — which is exactly what the first version of this
  // assertion measured, and it is the kind of quiet inaccuracy the message exists to avoid.
  const big = 'A'.repeat(400);
  const out = G.scrubBase64({ q: `<${big}>` });
  assert.ok(!out.q.includes(big), 'the base64 run survived');
  assert.ok(/base64 sample attachment, 400 chars, removed/.test(out.q),
    `the replacement does not say what was removed: ${out.q}`);
  assert.ok(out.q.startsWith('<') && out.q.endsWith('>'), 'the surrounding text was eaten');
  // and it must not touch anything short
  assert.strictEqual(G.scrubBase64('abc'), 'abc');
});

// ---------------------------------------------------------------------------

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
