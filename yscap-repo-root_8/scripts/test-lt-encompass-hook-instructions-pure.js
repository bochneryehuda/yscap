'use strict';
/**
 * LT test — THE SETUP INSTRUCTIONS MUST COMPILE, AND MUST MEAN WHAT THEY PROMISE.
 *
 * WHY THIS EXISTS (owner-reported 2026-08-24, twice). `ENCOMPASS-WEBHOOK-SETUP.md`
 * shipped a VB.NET sample that read the loan number as `Loan.Fields("364").Value`.
 * The owner pasted it into their Encompass advanced-code editor and the COMPILER
 * REFUSED IT: neither `Loan` nor `EncompassApplication` is in scope there. A
 * document that hands somebody code that cannot compile is worse than no document —
 * it costs them the afternoon and the trust.
 *
 * TWO CLASSES OF DEFECT ARE GUARDED HERE, and they are different:
 *
 *   1. THE CODE CANNOT COMPILE. The sample may not reach for an API this tenant's
 *      compiler refuses by name, and it must be wrapped in Try/Catch — an unwrapped
 *      rule that fires on every milestone change raises a 403 (wrong secret) or a
 *      timeout (PILOT down) INSIDE Encompass, on whoever is saving the loan.
 *
 *   2. THE CODE COMPILES AND THE DOCUMENT LIES ABOUT WHAT IT DOES. The document
 *      promises the rule works WHETHER OR NOT the editor substitutes `[364]` inside
 *      a quoted string — which is unconfirmed on this tenant. That promise is only
 *      true because of what the RECEIVER does, so it is not asserted in prose here:
 *      the exact body strings the document tells the owner to paste are lifted out
 *      of the document and fed through the receiver's own `identityFrom`, and the
 *      outcome the document promises is the outcome asserted. If either side moves,
 *      this bites.
 *
 * PURE. Reads the document and the route module. No database, no network.
 */

const path = require('path');
const fs = require('fs');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const rel = (p) => path.join(__dirname, '..', p);
const read = (p) => fs.readFileSync(rel(p), 'utf8');

const DOC = 'docs/longterm/ENCOMPASS-WEBHOOK-SETUP.md';
const doc = read(DOC);
const hook = require('../src/longterm/routes/encompass-hook');
const { identityFrom } = hook._internals;

/** Every ```vb fenced block in the document — the text the owner actually pastes. */
const vbBlocks = [...doc.matchAll(/```vb\n([\s\S]*?)```/g)].map((m) => m[1]);
/** The whole document minus its code blocks — the prose, for promise assertions. */
const prose = doc.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ');

// ── 1. The code the owner pastes must be code their compiler accepts ─────────
console.log('the pasted code must compile in THIS tenant`s advanced-code editor');

check(vbBlocks.length >= 1, `the document carries at least one VB block (${vbBlocks.length})`);

const allVb = vbBlocks.join('\n');
check(!/\bLoan\s*\.\s*Fields\s*\(/.test(allVb),
  'THE SHIPPED DEFECT: no VB block reads a field through `Loan.Fields(...)` — that identifier is refused by name in this tenant`s compiler');
check(!/\bEncompassApplication\b/.test(allVb),
  'and no VB block reaches for `EncompassApplication` either — refused by the same compiler');

// The refused names must still be NAMED somewhere, or the next person re-adds them.
check(/Loan\.Fields/.test(prose) || /`Loan`/.test(prose),
  'the document still WARNS about the refused identifiers in prose, so the next person does not re-introduce them');

const main = vbBlocks.find((b) => /HttpWebRequest/.test(b));
check(!!main, 'one VB block is the whole rule (it creates the request)');
if (main) {
  check(/^\s*Try\b/m.test(main) && /\bCatch\b/.test(main) && /\bEnd Try\b/.test(main),
    'THE RULE IS WRAPPED IN Try/Catch — a wrong secret or an unreachable PILOT can never throw inside Encompass on a loan officer`s save');
  check(/req\.Timeout\s*=/.test(main),
    'and it sets a Timeout, so a hung PILOT cannot freeze the save for .NET`s 100-second default');
  check(/SecurityProtocol[\s\S]*\bOr\b/.test(main),
    'TLS 1.2 is OR`d into ServicePointManager.SecurityProtocol rather than assigned over it — the live drivekosher rule keeps whatever it relies on');
  check(/DirectCast\s*\(/.test(main),
    'the WebRequest is DirectCast to HttpWebRequest, so the line compiles under Option Strict On as well as Off');
}

// ── 2. The address and header must be the ones the server actually serves ────
console.log('');
console.log('the address and header in the document must be the ones PILOT answers on');

const server = read('src/server.js');
const mount = server.match(/app\.use\('([^']*encompass-hook[^']*)'/);
check(!!mount, 'src/server.js mounts the hook');
if (mount) {
  check(doc.includes(mount[1]),
    `the document's URL carries the mounted path (${mount[1]})`);
}

const route = read('src/longterm/routes/encompass-hook.js');
const headerRead = route.match(/req\.headers\['([^']+)'\]/);
check(!!headerRead, 'the route reads a named header');
if (headerRead) {
  const want = headerRead[1];                    // lower-cased by express
  check(doc.toLowerCase().includes(want.toLowerCase()),
    `the document tells the owner to send that exact header (${want})`);
}

const envVar = (route.match(/process\.env\.(LT_ENCOMPASS_WEBHOOK_SECRET)/) || [])[1];
check(!!envVar && doc.includes(envVar),
  'and it names the environment variable the secret has to be set in — never the secret itself');
// The secret is a CREDENTIAL. It may be spoken in chat; it may NEVER live in the
// repo. Asserting "a placeholder exists somewhere" is not enough — a real value
// pasted over one of two placeholders leaves the other one standing. So every
// place the document hands over a secret is checked to BE a placeholder, and the
// check is structural: this file must never itself contain a real secret to
// compare against.
const PLACEHOLDER = /^(PASTE-|<|your-|YOUR-|\.\.\.)/;
const headerArgs = [...doc.matchAll(/Headers\.Add\(\s*"X-Encompass-Secret"\s*,\s*"([^"]*)"\s*\)/gi)].map((m) => m[1]);
check(headerArgs.length >= 1, `the document shows the secret header being set (${headerArgs.length}x)`);
for (const v of headerArgs) {
  check(PLACEHOLDER.test(v),
    `the secret header's value is a PLACEHOLDER, not a real secret ("${v}")`);
}
const curlSecrets = [...doc.matchAll(/X-Encompass-Secret:\s*(\S+)/gi)].map((m) => m[1]);
for (const v of curlSecrets) {
  check(PLACEHOLDER.test(v),
    `every X-Encompass-Secret shown in a test command is a placeholder too ("${v}")`);
}
check(!/LT_ENCOMPASS_WEBHOOK_SECRET\s*=\s*(?!<)\S/.test(doc),
  'and the environment variable is never shown with a value beside it');

// ── 3. The promise: the rule works whether or not [364] is substituted ───────
console.log('');
console.log('the promise "you do not need the loan number for this to work", tested against the receiver');

/** Turn a VB string literal into the JSON body Encompass would actually POST. */
const vbStringToJson = (lit) => lit.slice(1, -1).replace(/""/g, '"');

const bodyLits = [...allVb.matchAll(/Dim\s+body\s+As\s+String\s*=\s*("(?:[^"]|"")*")/g)].map((m) => m[1]);
check(bodyLits.length >= 2,
  `the document offers both body lines — the bracket one and the fixed fallback (${bodyLits.length})`);

const named = (body) => {
  const id = identityFrom({ body, query: {} });
  return !!(id.guid || id.loanNumber);
};

for (const lit of bodyLits) {
  let body;
  try { body = JSON.parse(vbStringToJson(lit)); } catch (e) { body = null; }
  check(body !== null, `the body line is valid JSON once VB un-doubles its quotes: ${vbStringToJson(lit)}`);
  if (body === null) continue;

  // AS PASTED — the bracket NOT substituted, or a fixed ping. Either way the
  // receiver must find no identity, which is what sends it down the sweep path.
  check(!named(body),
    `as pasted, the receiver finds no loan in it (${JSON.stringify(body)}) — so it takes the "ask Encompass what moved" path, exactly as the document promises`);
}

// AND the other half of the promise: if the bracket IS substituted, the ping
// names the loan and the receiver nudges that one file directly.
const bracket = bodyLits.find((l) => l.includes('[364]'));
check(!!bracket, 'one of the two body lines is the `[364]` version');
if (bracket) {
  const substituted = JSON.parse(vbStringToJson(bracket).replace('[364]', 'YSCAP258134856'));
  const id = identityFrom({ body: substituted, query: {} });
  check(id.loanNumber === 'YSCAP258134856',
    'and WHEN Encompass substitutes it, the receiver reads that loan number straight out of the body and nudges that one file');
}

// The document must not quietly drop the sentence that makes all of this safe.
check(/does not need the loan number|do not need the loan number|not need the loan number/i.test(prose),
  'the document states plainly that the rule does not need the loan number to work');
check(/recently-changed sweep|which loans just changed|which loans were modified|what moved/i.test(prose),
  'and it says what happens instead — PILOT asks Encompass which loans changed');

// ── 4. The receiver still fails closed ───────────────────────────────────────
console.log('');
console.log('the receiver the document points at still fails closed');

check(/if \(!secret\(\)\)[\s\S]{0,200}503/.test(route),
  'with no secret configured, the endpoint refuses everything with a 503');
check(/timingSafeEqual/.test(route),
  'the secret is compared in constant time, so it cannot be guessed byte by byte');
check(/503/.test(doc) && /403/.test(doc),
  'and the document tells the owner both of those answers, so a refusal is not mistaken for a bug');

console.log('');
if (failures) {
  console.error(`\n${failures} FAILED`);
  process.exit(1);
}
console.log('all good');
