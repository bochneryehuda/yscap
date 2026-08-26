'use strict';
/**
 * GATE — EVERY ENCOMPASS REQUEST IN THE CODE IS ONE THE AUDIT ACTUALLY ASKS.
 *
 * WHY THIS EXISTS (owner-directed, 2026-08-25, asked three separate times): *"I want
 * you to double-check and triple-check every single request that you're going to
 * encompass to make sure every request works... nothing returns an error."*
 *
 * `/request-audit` in `longterm/routes/book-diag.js` answers that by firing every
 * request at the live tenant and writing down what it said. But an audit is only
 * worth its coverage, and its list is HAND-KEPT — so the day somebody adds a
 * seventeenth endpoint to a client, the audit keeps reporting "all requests
 * answered" while saying nothing at all about the new one. That is the same failure
 * this whole week has been about: a green report that is not measuring the thing it
 * claims to measure.
 *
 * So this reads the THREE Encompass clients, extracts every path they can reach, and
 * fails if the audit does not ask about one. The audit's list stops being a list
 * somebody remembered to update and becomes one the build refuses to let drift.
 *
 * PURE. No database, no network, no credentials.
 */

const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/** Comments are prose. An endpoint DISCUSSED in a header is not one the code calls,
 *  and counting it would make this gate demand audits for paths that do not exist. */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');

/** A path with its interpolations flattened, so `${guid}` and `${loanId}` are the
 *  same shape — they are the same request. */
const shapeOf = (p) => p
  .replace(/\$\{[^}]*\}/g, '{id}')
  .replace(/\{guid\}|\{loanId\}/g, '{id}')
  // Two interpolations in a row are one segment, not two: RTL's getLoan builds
  // `/loans/${guid}${qs}` where the second half is a QUERY STRING. Left uncollapsed
  // this gate would demand an audit for `/loans/{id}{id}`, an endpoint that does not
  // exist, and the obvious way to make that pass is to add a fake entry to the audit.
  .replace(/(\{id\})+/g, '{id}')
  .split('?')[0]
  .replace(/\/+$/, '');

const CLIENTS = [
  'src/encompass/client.js',
  'src/longterm/encompass/client.js',
  'src/lib/integrations/encompass.js',
  // Not a client, but it reaches Encompass through one with a path of its own.
  'src/longterm/people/roster.js',
];

const reachable = new Set();
for (const rel of CLIENTS) {
  const src = stripComments(read(rel));
  for (const m of src.matchAll(/[`'"](\/(?:encompass|oauth2)\/v\d[^`'"]*)/g)) {
    const shape = shapeOf(m[1]);
    // `/encompass/v3/loans/` on its own is a PREFIX constant the field reader builds
    // on, not a request anybody issues. Its real shapes are captured either side.
    if (shape === '/encompass/v3/loans') continue;
    if (shape) reachable.add(shape);
  }
}

const AUDIT_SRC = read('src/longterm/routes/book-diag.js');
// Only the audit route's own body counts — a path mentioned in `/catalog-probe`'s
// list is a different question and must not be allowed to satisfy this gate.
const auditAt = AUDIT_SRC.indexOf("router.get('/request-audit'");
const auditEnd = AUDIT_SRC.indexOf("router.get('/people'", auditAt);
const AUDIT = AUDIT_SRC.slice(auditAt, auditEnd);

check(auditAt > 0 && auditEnd > auditAt,
  'the /request-audit route was located — a rename must fail this file loudly, not silently stop checking');

const audited = new Set();
for (const m of AUDIT.matchAll(/[`'"](\/(?:encompass|oauth2)\/v\d[^`'"]*)/g)) {
  const shape = shapeOf(m[1]);
  if (shape) audited.add(shape);
}
// The two read-shaped POSTs are exercised through the client's own helpers rather
// than by literal path, so they are credited by the helper name.
if (/encompass\.pipelineSearch\(/.test(AUDIT)) audited.add('/encompass/v3/loanPipeline');
if (/encompass\.fieldReader\(/.test(AUDIT)) audited.add('/encompass/v3/loans/{id}/fieldReader');
if (/encompass\.getLoan\(/.test(AUDIT)) audited.add('/encompass/v3/loans/{id}');
if (/encompass\.getLoanMilestones\(/.test(AUDIT)) audited.add('/encompass/v3/loans/{id}/milestones');
if (/encompass\.ping\(/.test(AUDIT)) audited.add('/oauth2/v1/token');

console.log(`\n${reachable.size} request shape(s) reachable from the clients; the audit asks about ${audited.size}\n`);

for (const p of [...reachable].sort()) {
  check(audited.has(p), `the audit asks about ${p}`);
}

// ── The audit must actually REPORT a failure, not swallow it ─────────────────
console.log('');
check(/failed: failed\.length/.test(AUDIT), 'the audit counts what failed');
check(/ok: failed\.length === 0/.test(AUDIT),
  'a single failing request makes the whole audit answer ok:false — an audit that reports ok with a failure in it is worse than none');
check(/did NOT work/.test(AUDIT), 'the headline names what failed in words, so the answer does not need the table to be read');
check(!/catch \(_\) \{ \}/.test(AUDIT), 'nothing in the audit swallows an error into nothing');

// ── It must stay READ-ONLY ──────────────────────────────────────────────────
check(!/method:\s*'(PUT|PATCH|DELETE)'/i.test(AUDIT), 'the audit issues no write method');
check(!/req\.query\.[A-Za-z]+\s*\)?\s*\}?\s*`/.test(AUDIT.replace(/req\.query\.loan/g, 'SUBJECT')),
  'nothing from the query string is interpolated into an Encompass path — the loan is looked up in our own book first');

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
