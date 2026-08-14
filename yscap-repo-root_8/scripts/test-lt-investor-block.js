#!/usr/bin/env node
'use strict';
/**
 * LT test — THE INVESTOR NAME NEVER REACHES A CLIENT.
 *
 * Owner-directed 2026-08-14, in his own words:
 *   "You also need to make sure that you put a hard rule to block the investor name.
 *    The client should not be able to see the investor name. Never ever! Not
 *    borrowers, not TPOs, only internal staff."
 *
 * A hard rule that lives only in a document is a wish. This is the rule with teeth.
 *
 * It guards BOTH directions, because a redactor is only useful if it is trusted:
 *   • every real spelling in the tenant IS caught (a leak is the unacceptable failure)
 *   • ordinary English is NOT mangled (a redactor that ruins sentences gets switched
 *     off, and then it protects nothing)
 *
 * Pure — no database, no network, no Encompass. Runs in CI.
 *
 *   node scripts/test-lt-investor-block.js
 */

const path = require('path');

const ROOT = path.join(__dirname, '..');
const A = require(path.join(ROOT, 'src/longterm/audience'));
const investors = require(path.join(ROOT, 'src/longterm/encompass/investors'));

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

console.log('LT — the investor name is blocked from every client surface');

// ── 1. The rule itself is recorded, in the owner's terms ─────────────────────
const s = A.summary();
check(s.audiences.includes('internal') && s.audiences.includes('borrower')
  && s.audiences.includes('tpo'),
'all three audiences are named — internal, borrower, TPO');
check(s.clientAudiences.length === 2 && !s.clientAudiences.includes('internal'),
  'a borrower and a TPO are both CLIENTS; only internal staff are not');
check(/never reaches a borrower or a TPO/i.test(s.rule),
  "the rule is stated in the module, in the owner's terms");

// ── 2. It fails CLOSED ───────────────────────────────────────────────────────
// An audience nobody thought of must be treated as a client. The expensive
// mistake is handing internal data to an unrecognised caller.
check(A.isClient('borrower') && A.isClient('tpo'), 'a borrower and a TPO are clients');
check(A.isClient(undefined) && A.isClient(null) && A.isClient('') && A.isClient('admin'),
  'an unknown, missing or invented audience is treated as a CLIENT — fails closed');
check(!A.isClient('internal'), 'only the exact internal audience is not a client');

// ── 3. The fields that carry it are named, so a mapping can ask ──────────────
// The primary defence is never selecting the value at all. These are the six
// places in Encompass it lives.
for (const id of ['CX.WHICHINVESTOR', 'VEND.X263', 'VEND.X276', 'VEND.X273',
  'VEND.X267', 'CX.TABLEFUNDER']) {
  check(!A.maySeeField('borrower', id) && !A.maySeeField('tpo', id),
    `${id} is refused to a borrower and to a TPO`);
  check(A.maySeeField('internal', id), `${id} is available to internal staff`);
}
check(A.maySeeField('borrower', '1005') && A.maySeeField('borrower', '912'),
  'ordinary loan fields are still available to a client (rent, housing expense)');
check(!A.maySeeField('borrower', 'vend.x276'),
  'the field check is case-insensitive — vend.x276 is refused too');

// The investor loan number is the one the owner said must survive. Surviving on
// OUR side and being hidden from a client are not in tension; assert both.
check(investors.INVESTOR_LOAN_NUMBER_FIELD === 'VEND.X276'
  && !A.maySeeField('borrower', investors.INVESTOR_LOAN_NUMBER_FIELD),
'the investor loan number survives internally AND is blocked from clients');

// ── 4. EVERY spelling in the registry is caught ──────────────────────────────
// This is the assertion that makes the rule real: not "Deephaven is blocked" but
// "every one of the 117 ways our staff have actually spelled an investor is
// blocked". A new investor added to the registry is covered automatically.
const CONTEXTS = [
  (n) => `Approval received from ${n} on 5/2.`,
  (n) => `Sent to ${n} for review`,
  (n) => `${n} requires an updated lease agreement.`,
  (n) => `${n}_approval_signed.pdf`,
  (n) => `Per ${n} guidelines, two months of statements are needed.`,
];
let missed = [];
let checkedSpellings = 0;
for (const inv of investors.INVESTORS) {
  for (const raw of [inv.label].concat(inv.aliases || [])) {
    const name = String(raw || '').trim();
    if (!name) continue;
    checkedSpellings += 1;
    for (const ctx of CONTEXTS) {
      const text = ctx(name);
      if (A.scrubInvestorNames(text, 'borrower') === text) {
        missed.push(`${inv.key}: "${name}" in ${JSON.stringify(text)}`);
        break;
      }
    }
  }
}
check(checkedSpellings >= 100, `${checkedSpellings} recorded spellings put through the scrubber`);
check(missed.length === 0,
  `every recorded spelling is caught in every context (${missed.length} missed)`);
if (missed.length) missed.slice(0, 8).forEach((m) => console.error(`         · ${m}`));

// The same must hold for a TPO, not only a borrower — the owner named both.
check(A.scrubInvestorNames('Sent to Deephaven for review', 'tpo')
  === A.scrubInvestorNames('Sent to Deephaven for review', 'borrower'),
'a TPO is redacted exactly as a borrower is');

// ── 5. The awkward real-world shapes ─────────────────────────────────────────
const MUST_CATCH = [
  ['Approval received from Deephaven Mortgage LLC on 5/2.', 'the full legal name'],
  ['Deepahven needs the lease agreement.', 'a typo we have actually seen'],
  ['Sent to OAK TREE for review', 'upper case with a space'],
  ['oak  tree approval pending', 'lower case with a doubled space'],
  ['AHL requires two months of statements', 'a short code'],
  ['Deephaven_approval_signed.pdf', 'inside a filename, no spaces around it'],
  ['OAKTREE-letter.pdf', 'inside a hyphenated filename'],
  ['emcep sent it back', 'a misspelling that is not an English word'],
  ['RCN and NQM both declined', 'two investors in one sentence'],
  ['Blue Lake Capital wants an updated lease', 'a two-word name that reads like scenery'],
  ['Temple View asked for the operating agreement', 'another one'],
  ['Sent to Foundation for review', 'an English word used as a company name'],
  ['per Dominion Financial guidelines', 'an ambiguous word in its multi-word form'],
  ['Deephaven\nMortgage LLC approved', 'a name broken across a line'],
];
for (const [text, why] of MUST_CATCH) {
  check(A.scrubInvestorNames(text, 'borrower') !== text, `CAUGHT — ${why}`);
}

// ── 6. And it does NOT mangle ordinary English ───────────────────────────────
// A redactor that ruins real sentences gets turned off, and then it protects
// nothing. These must pass through untouched.
const MUST_NOT_TOUCH = [
  ['The property has a solid foundation and needs foundation repair.',
    'the ordinary word "foundation", lower case'],
  ['We added the roof and the road, then had a chat.', '"ad" inside ordinary words'],
  ['A large oak sits in the yard.', 'a bare "oak" is not the investor'],
  ['Provide a copy of the recorded deed and the title commitment.',
    'an ordinary condition body'],
  ['Photo ID is required for all borrowers.', 'a real condition from the library'],
];
for (const [text, why] of MUST_NOT_TOUCH) {
  const out = A.scrubInvestorNames(text, 'borrower');
  check(out === text, `UNTOUCHED — ${why}`);
  if (out !== text) console.error(`         got: ${JSON.stringify(out)}`);
}

// ── 6b. The tradeoff we DID take, asserted so it stays a decision ────────────
// 'champions', 'dominion' and 'arc' are English words AND recorded investor
// spellings — recorded in LOWER CASE, meaning a staffer really typed them that
// way on a real file. A recorded spelling the scrubber cannot see is a leak, so
// these are caught in every case and the odd mangled sentence is accepted.
// 'foundation' is the one exception, because a loan condition uses it in its
// ordinary sense constantly.
for (const [text, why] of [
  ['sent to champions today', "lower-case 'champions' — a recorded spelling"],
  ['dominion has the file', "lower-case 'dominion' — a recorded spelling"],
  ['arc reviewed it', "lower-case 'arc' — a recorded spelling"],
]) {
  check(A.scrubInvestorNames(text, 'borrower') !== text,
    `CAUGHT (accepted tradeoff) — ${why}`);
}
check(A.scrubInvestorNames('needs foundation repair', 'borrower') === 'needs foundation repair',
  "but lower-case 'foundation' is left alone — a loan condition really means the building");
check(A.scrubInvestorNames('Foundation approved it', 'borrower') !== 'Foundation approved it',
  'while capitalised "Foundation" is caught');

// ── 7. Internal staff see the truth ──────────────────────────────────────────
// The rule hides the investor from CLIENTS. It must never hide it from us —
// our own desk has to know who bought the loan.
const internalText = 'Approval received from Deephaven Mortgage LLC on 5/2.';
check(A.scrubInvestorNames(internalText, 'internal') === internalText,
  'internal text is returned completely untouched');
check(A.scrubInvestorNames(internalText, A.AUDIENCES.INTERNAL) === internalText,
  'and via the exported constant');

// ── 8. It can never throw, and never returns the raw text on failure ─────────
// A scrubber that can fail is a scrubber somebody wraps in a swallowing catch.
check(A.scrubInvestorNames(null) === null, 'null passes through as null');
check(A.scrubInvestorNames(undefined) === undefined, 'undefined passes through');
check(A.scrubInvestorNames('') === '', 'an empty string stays empty');
check(typeof A.scrubInvestorNames(12345) === 'string', 'a number is coerced, not thrown on');
check(typeof A.scrubInvestorNames({ a: 1 }) === 'string', 'an object is coerced, not thrown on');
const long = `Deephaven ${'x'.repeat(50000)} Oaktree`;
check(!A.mentionsInvestor(A.scrubInvestorNames(long, 'borrower')),
  'a very long string is still fully scrubbed');

// ── 9. Redaction says nothing about who ──────────────────────────────────────
check(!A.mentionsInvestor(A.REDACTION),
  'the replacement wording does not itself name an investor');
check(!/lender|bank|investor|buyer/i.test(A.REDACTION),
  'the replacement invites no follow-up question — it names no role either');

// ── 10. Object stripping ─────────────────────────────────────────────────────
const payload = {
  loanNumber: 'YSCAP123', dscrRatio: 1.28,
  investorName: 'Deephaven', investorLoanNumber: '25098221',
  canonical_key: 'deephaven', funding_channel: 'Correspondent', noteBuyer: 'Fidelis',
};
const forClient = A.stripInternalOnly(payload, 'borrower');
check(forClient.loanNumber === 'YSCAP123' && forClient.dscrRatio === 1.28,
  'stripping keeps everything a client is entitled to');
for (const k of ['investorName', 'investorLoanNumber', 'canonical_key',
  'funding_channel', 'noteBuyer']) {
  check(!(k in forClient), `stripping removes ${k}`);
}
check(JSON.stringify(A.stripInternalOnly(payload, 'internal')) === JSON.stringify(payload),
  'an internal payload is returned unchanged');
check(!A.mentionsInvestor(JSON.stringify(forClient)),
  'and nothing investor-shaped survives in the stripped payload');

// ── 11. The registry drives the block — adding an investor covers it ─────────
// If this ever stops holding, the block has been re-implemented against a
// hard-coded list somewhere and will rot the day a new investor is added.
const src = require('fs').readFileSync(path.join(ROOT, 'src/longterm/audience.js'), 'utf8');
check(/require\(['"]\.\/encompass\/investors['"]\)/.test(src),
  'the block reads the investor REGISTRY — not a private hard-coded list');
check(A.summary().spellingsBlocked >= 80,
  `${A.summary().spellingsBlocked} spellings are actively blocked`);

// ── done ─────────────────────────────────────────────────────────────────────
if (failures) {
  console.error(`\nFAILED — ${failures} check(s). The investor name could reach a client.`);
  process.exit(1);
}
console.log('\nOK — the investor name is blocked from borrowers and TPOs, and internal staff still see it.');
