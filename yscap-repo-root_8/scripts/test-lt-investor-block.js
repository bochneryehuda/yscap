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
const roster = require(path.join(ROOT, 'src/longterm/pricing/investor-roster'));

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
// AN INVESTOR SOMEBODY ADDED BY HAND IS SWEPT EXACTLY LIKE A RECORDED ONE.
// Its label and every spelling recorded for it are names a client may not see,
// and the whole point of the door that adds one is that it does not take a
// deploy — so a scrub that covered only the code registry would go stale the
// first afternoon somebody used it. `useCustomInvestors` is the hook the
// settings store fires on the load that read them; this is that same call.
const CUSTOM_FIXTURE = {
  swept_capital: {
    label: 'Sweptside Capital Partners',
    whiteLabel: 'Northgate',
    aliases: ['Sweptside Capital Partners', 'Sweptside Cap', 'SWEPTSIDE CAPITAL PARTNERS LLC'],
  },
};
A.useCustomInvestors(CUSTOM_FIXTURE);

let missed = [];
let checkedSpellings = 0;
for (const inv of roster.effectiveList(roster.readCustom(CUSTOM_FIXTURE).custom)) {
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
const rosterSrc = require('fs').readFileSync(path.join(ROOT, 'src/longterm/pricing/investor-roster.js'), 'utf8');
// The block reads the EFFECTIVE ROSTER, and the effective roster reads the
// registry. Both halves are asserted: a block reading a roster that had stopped
// reading the registry would pass a check on either one alone, and would rot the
// day a new investor is added to the code — which is the failure this guards.
check(/require\(['"]\.\/pricing\/investor-roster['"]\)/.test(src),
  'the block reads the ONE effective roster — not a private hard-coded list');
check(/require\(['"]\.\.\/encompass\/investors['"]\)/.test(rosterSrc),
  '…and that roster is the code registry with the hand-added investors laid over it');
check(!/require\(['"]\.\/encompass\/investors['"]\)/.test(src),
  'the block has no second door to the registry, so the two can never drift');

// A HAND-ADDED INVESTOR IS BLOCKED THE MOMENT IT IS SAVED — the property the
// write door proves before it stores a white label, asserted here from the other
// end: after the load hook has run, the label and every spelling are scrubbed in
// every one of the five sentence shapes, and the client-safe name survives.
{
  const before = A.summary().customInvestorsBlocked;
  A.useCustomInvestors(CUSTOM_FIXTURE);
  check(A.summary().customInvestorsBlocked === 1 && before === 1,
    'the investors added by hand are in force in the block');
  let leaked = [];
  for (const spelling of CUSTOM_FIXTURE.swept_capital.aliases.concat([CUSTOM_FIXTURE.swept_capital.label])) {
    for (const ctx of CONTEXTS) {
      const text = ctx(spelling);
      if (A.scrubInvestorNames(text, 'borrower') === text) leaked.push(`"${spelling}" in ${JSON.stringify(text)}`);
    }
  }
  check(leaked.length === 0,
    `a hand-added investor's label and every spelling are scrubbed in every shape (${leaked.length} leaked)`);
  if (leaked.length) leaked.slice(0, 4).forEach((m) => console.error(`         · ${m}`));
  const wl = CUSTOM_FIXTURE.swept_capital.whiteLabel;
  check(A.scrubInvestorNames(`Your ${wl} quote is ready to review.`, 'borrower') === `Your ${wl} quote is ready to review.`,
    'and the name a client MAY see survives the scrub untouched — otherwise the investor could never be quoted');
  /* ⛔ AN OUTAGE MAY NEVER SHRINK THIS LIST, and this assertion used to say the
     opposite. It read "taking them back out is what a settings store that could
     not be read does" — encoding a fail-OPEN as correct, so no test could ever
     catch it. An audit found the code doing exactly that: `load()` caught the
     database error, fell back to the declared defaults and pushed an EMPTY map
     into the block, so a blip removed a rule-10 protection for as long as it
     lasted. An empty map is what "nobody has added an investor" means; it is not
     what "we could not find out" means. */
  const customName = CUSTOM_FIXTURE.swept_capital.label;
  A.markCustomInvestorsUnread('the settings store could not be read');
  check(!A.scrubInvestorNames(`Approval received from ${customName} on 5/2.`, 'borrower').includes(customName),
    'THE ONE THAT MATTERS: a settings store that cannot be read KEEPS the investors already known — an outage may never take a block away');
  check(A.summary().customInvestors.degraded === true && A.summary().customInvestors.count === 1,
    '…and says the list may be stale rather than reporting a confident zero');

  // A map that really IS empty — somebody removed the last one — does clear it.
  // That is a reading, not a failure to read, and the two must not look alike.
  A.useCustomInvestors({});
  check(A.summary().customInvestors.count === 0
    && A.summary().customInvestors.degraded === false
    && A.scrubInvestorNames(`Approval received from ${customName} on 5/2.`, 'borrower').includes(customName),
    'with none stored the block is the registry alone — the behaviour before they existed');
  A.useCustomInvestors(CUSTOM_FIXTURE);
}

/* ── THE THIRD PLACE A SPELLING IS RECORDED: THE HUMAN LINKS MAP (audit F1, rule 10) ────────
   `pricing.investorLinks` is keyed by FREE TEXT — a person types a spelling a vendor used and
   points it at a canonical investor. `validateLinks` checks that the TARGET exists and never
   looked at the spelling, so a name recorded there resolved as a real investor for pricing,
   routing, the white label and the holdback, and walked straight past this scrubber to a borrower
   while the REGISTRY'S own name for that same investor was redacted.

   The CONTROL matters as much as the assertion: the same sentence is scrubbed BEFORE the map is
   read and must come back untouched. Without it this block would pass just as well against a name
   the registry already blocked — the vacuous shape this codebase has been finding all day. */
{
  const LINKED = 'Zephyr Capital Partners';
  A.useInvestorLinks(null);
  const plain = `Payoff from ${LINKED} is required before closing.`;
  check(A.scrubInvestorNames(plain, 'borrower') === plain,
    `CONTROL: with no links recorded, "${LINKED}" is NOT blocked — so what follows is about the link, not about a name the registry already knew`);

  A.useInvestorLinks({ [LINKED]: { key: 'acra', source: 'loannex', linkedBy: 'test' } });
  const linkLeaks = [];
  for (const ctx of CONTEXTS) {
    const text = ctx(LINKED);
    if (A.scrubInvestorNames(text, 'borrower') === text) linkLeaks.push(JSON.stringify(text));
  }
  check(linkLeaks.length === 0,
    `THE ONE THAT MATTERS: a spelling recorded BY HAND in the links map is scrubbed in every one of the five shapes (${linkLeaks.length} leaked)`);
  if (linkLeaks.length) linkLeaks.slice(0, 4).forEach((m) => console.error(`         · ${m}`));

  check(!A.scrubInvestorNames(`send to ${LINKED.toUpperCase()} today`, 'borrower').includes('ZEPHYR')
    && !A.scrubInvestorNames(`send to ${LINKED.toLowerCase()} today`, 'borrower').includes('zephyr'),
    'and it is caught in any casing — a multi-word name matches however it was typed');

  /* THE MEMO. The spelling list is memoised per roster map; a link saved AFTER a scrub has already
     warmed that memo must still be blocked, or the block is exactly as stale as the defect. */
  A.useInvestorLinks(null);
  const warm = `Ask ${LINKED} for the letter.`;
  A.scrubInvestorNames(warm, 'borrower');
  A.useInvestorLinks({ [LINKED]: { key: 'acra' } });
  check(!A.scrubInvestorNames(warm, 'borrower').includes('Zephyr'),
    'a link saved AFTER the block was last built is blocked on the very next scrub — the memo notices');

  A.useInvestorLinks({ 'Made Up Holdings': { key: 'not_an_investor' } });
  check(A.scrubInvestorNames('Ask Made Up Holdings for it.', 'borrower') === 'Ask Made Up Holdings for it.',
    'a link whose target is not a real investor blocks nothing — `readLinks` drops it, so the block and the resolver agree about which entries count');

  /* AN OUTAGE MAY NEVER SHRINK THIS HALF EITHER — the same rule the custom map carries, for the
     same reason: an empty links map means "block fewer investor names". */
  A.useInvestorLinks({ [LINKED]: { key: 'acra' } });
  A.markInvestorLinksUnread('the settings store could not be read');
  check(!A.scrubInvestorNames(`Approval from ${LINKED} received.`, 'borrower').includes('Zephyr'),
    'a settings store that cannot be read KEEPS the link spellings already known');
  A.useInvestorLinks(null);

  /* ⛔ AND THE WIRING IS ASSERTED THROUGH THE DECLARATION ITSELF, NOT BY CALLING THE HOOK BY HAND.
     Everything above calls `useInvestorLinks` directly, so it would all stay green while the
     settings declaration lost its `applyOnLoad` and the block silently stopped being fed in
     production. Caught by mutation: deleting that one line left this suite passing.
     So the hooks are taken OFF the declaration and INVOKED — a grep for their names would be
     satisfied by the comment that explains them, which is the other trap this codebase keeps
     finding. */
  const decl = require(path.join(ROOT, 'src/longterm/settings/encompass-settings'))
    .SETTINGS.find((d) => d && d.key === 'pricing.investorLinks');
  check(!!decl && typeof decl.validate === 'function' && typeof decl.applyOnLoad === 'function'
    && typeof decl.applyOnUnreadable === 'function',
    'the links setting declares all three doors — a write check, a load hook and what to do when the store cannot be read');

  A.useInvestorLinks(null);
  const viaDecl = `Payoff from ${LINKED} is due.`;
  check(A.scrubInvestorNames(viaDecl, 'borrower') === viaDecl, 'CONTROL: still unblocked before the declaration\'s own hook runs');
  decl.applyOnLoad({ [LINKED]: { key: 'acra' } });
  check(!A.scrubInvestorNames(viaDecl, 'borrower').includes('Zephyr'),
    'THE WIRING: running the DECLARATION\'s own load hook is what blocks the spelling — so removing it from the settings file reddens this line');

  const bad = decl.validate({ 'Someone': { key: 'not_an_investor' } });
  check(bad.ok === false && (bad.problems || []).length > 0,
    'and the declaration\'s write door refuses a link pointing at an investor that does not exist');
  const good = decl.validate({ [LINKED]: { key: 'acra' } });
  check(good.ok === true, '…while a link at a real investor is accepted, so the door is not simply refusing everything');
  A.useInvestorLinks(null);
}

check(A.summary().spellingsBlocked >= 80,
  `${A.summary().spellingsBlocked} spellings are actively blocked`);

/* ── THE NUMBER IN THE DOCS IS THE NUMBER IN THE CODE (audit F10) ────────────────────────────
   Three places disagreed — CLAUDE.md said 117, AUDIENCE-RULES.md said 151 and then 150,
   investors.js says 151 — while the code answered 135. The disagreement was that TWO DIFFERENT
   FACTS were being quoted as one: 151 is how many spellings the live Encompass fields held on
   2026-08-14 (a fact about the book, and why this registry exists); 135 is how many the REGISTRY
   records and this file sweeps. Both are true. A prose number nothing checks is a number that goes
   stale the first time somebody adds an investor — so the registry's own count is asserted against
   the sentence that quotes it. */
{
  /* ⛔ COUNTED WITH NOTHING ELSE IN FORCE, and this guard caught its own first draft: run as it
     stood it read 138 blocked against 135 registry spellings, because the sections above leave a
     hand-added investor installed. The block was right and the comparison was wrong. Both extra
     maps are cleared, the registry's own number is taken, and they are restored after — otherwise
     this would be a number about the fixture rather than about the registry. */
  const registry = investors;
  const fsDocs = require('fs');
  A.useCustomInvestors(null);
  A.useInvestorLinks(null);
  const distinct = new Set();
  let rawRows = 0;
  for (const inv of registry.INVESTORS) {
    for (const one of [inv.label].concat(inv.aliases || [])) { rawRows += 1; distinct.add(String(one).toLowerCase()); }
  }
  check(A.summary().spellingsBlocked === distinct.size,
    `the block sweeps EVERY distinct registry spelling and no more (${A.summary().spellingsBlocked} blocked, ${distinct.size} distinct, from ${registry.INVESTORS.length} investors and ${rawRows} label+alias rows)`);

  const rulesDoc = fsDocs.readFileSync(path.join(ROOT, 'docs/longterm/AUDIENCE-RULES.md'), 'utf8');
  check(rulesDoc.includes(`every one of the ${distinct.size} recorded spellings`),
    `AUDIENCE-RULES.md quotes the registry's REAL count (${distinct.size}) — the sentence that promises the sweep must not name a number the sweep does not cover`);
  const claude = fsDocs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
  check(claude.includes(`REGISTRY (**${distinct.size}** recorded spellings`),
    `CLAUDE.md quotes it too (${distinct.size}) — it was 117, stale by three separate additions`);
  A.useCustomInvestors(CUSTOM_FIXTURE);
}

// ── THE INVESTOR IDENTITY CHAIN NEVER LEAVES THE STAFF SIDE ─────────────────
//
// `lt_loan_investors` holds who bought the loan, their own loan number, their
// email and the funding channel — all of it internal (rule 10), the channel
// included, because HOW a loan is funded implies WHO bought it. The borrower's own
// screen is built FOR the client rather than filtered from a staff payload, which
// is the first of the two defences that rule names — so the guard is that it never
// reads the table at all.
const fs2 = require('fs');
const clientRoutes = ['src/longterm/routes/my-loans.js', 'src/longterm/routes/me.js'];
for (const rel of clientRoutes) {
  const text = fs2.readFileSync(path.join(ROOT, rel), 'utf8');
  check(!/lt_loan_investors/.test(text),
    `${rel} never reads the investor table — a client payload is BUILT for the client, never a staff one with fields removed`);
}
const fileSrc = fs2.readFileSync(path.join(ROOT, 'src/longterm/file.js'), 'utf8');
check(/STAFF ONLY/i.test(fileSrc.slice(fileSrc.indexOf('investor: {') - 900, fileSrc.indexOf('investor: {'))),
  'and the one place that DOES read it says on its face that it is staff-only, so nobody lifts the block onto a client surface without meeting the rule first');

// ── The client door, RUN rather than read ───────────────────────────────────
//
// Every check above this line reads source or exercises the audience rules. This
// one takes the actual function the borrower's own screen is built by, hands it a
// loan row carrying every internal field there is, and looks at what comes out.
//
// It matters because the guard directly above — "my-loans.js never reads
// lt_loan_investors" — stays TRUE if somebody rewrites the payload as
// `{ ...row, status }`. The table would still not be read; every investor-ish
// column on `lt_loans`, present or future, would ship to the client anyway. A
// whitelist is only a defence while it is still a whitelist, and the only way to
// know is to run it.
const myLoans = require(path.join(ROOT, 'src/longterm/routes/my-loans'));
const shape = myLoans._internals && myLoans._internals.shape;
check(typeof shape === 'function',
  'the borrower payload builder is reachable, so this can be run rather than read — a source grep cannot tell a whitelist from a spread');

if (typeof shape === 'function') {
  // A row as wide as a leak could ever make it: the real loan columns, plus every
  // internal name and shape the investor mirror uses, plus a program name with an
  // investor's name typed inside it.
  const wideRow = {
    id: 'loan-1', loan_number: 'LT-1001', stage_key: 'clear_to_close',
    milestone_name: 'Docs Out', loan_amount: 415000, term_months: 360,
    program_name: 'Deephaven Investor DSCR 30 YEAR FRM',
    encompass_synced_at: '2026-08-18T00:00:00.000Z', consumer_status: 'Funded',
    // None of these may come out the other side.
    shorthand_name: 'Deephaven', accurate_name: 'Deephaven Mortgage LLC',
    canonical_key: 'deephaven', investor_loan_number: 'DH-99887',
    investor_email: 'purchasing@deephaven.example', funding_channel: 'Correspondent',
    note_buyer: 'Deephaven', capital_provider: 'Deephaven', lender: 'Deephaven',
    buy_rate_pct: 6.5, override_staff_id: 'staff-1',
  };
  const out = shape(wideRow, { stages: [] });

  const ALLOWED = ['id', 'file', 'status', 'milestone', 'loanAmount', 'termMonths',
    'programName', 'product', 'updatedAt'];
  const extra = Object.keys(out).filter((k) => !ALLOWED.includes(k));
  check(extra.length === 0,
    `THE ONE THAT MATTERS: the client payload carries ONLY the keys it names${extra.length ? ` — these got through: ${extra.join(', ')}` : ` (${ALLOWED.join(', ')})`}`);

  check(!/Deephaven|DH-99887|deephaven|Correspondent/.test(JSON.stringify(out)),
    '…so not one investor field, loan number, email or funding channel reaches a borrower — including the one typed INSIDE the program name, which the scrub catches');
  check(out.programName && out.programName.length > 0 && out.status === 'Funded',
    '…while the file itself still reads as a file: the borrower keeps their program wording and their own status, scrubbed rather than blanked');
}

// ── N. THE CONDITION'S OWN WORDING IS SCRUBBED, NOT ONLY ITS REJECTION REASON ─
// A condition's `label` and `hint` are NOT a fixed whitelist. The desk may PATCH
// both from free text (routes/condition-center.js writes label / hint /
// borrower_label / borrower_hint), so what a borrower reads on the portal — and
// in the emailed outreach list, which is built from this same client view — is a
// sentence a human typed. That is precisely the charter's SECOND defence: scrub
// the free text. Before this, only `rejectionReason` went through the scrub, so
// a staffer who typed an investor's name into a borrower-facing label handed it
// straight to the borrower.
{
  const read = require(path.join(ROOT, 'src/longterm/conditions-center/read'));
  const shape = read._internals.shape;

  const row = {
    id: 'c1', code: 'lt_x', bucket_key: 'prior_to_submission', kind: 'document',
    status: 'outstanding', is_required: true, file_count: 0, accepted_count: 0,
    label: 'INTERNAL: Deephaven approval', hint: 'internal hint',
    borrower_label: 'Upload the Deephaven approval letter',
    borrower_hint: 'Deephaven needs this before we can submit.',
    rejection_reason: 'Deephaven rejected the copy you sent.',
  };

  const client = shape(row, false);
  const json = JSON.stringify(client);
  check(!/deephaven/i.test(json),
    'THE ONE THAT MATTERS: no spelling of the investor survives anywhere in a client condition — label, hint or rejection reason');
  check(client.label && client.label.length > 0 && client.hint && client.hint.length > 0,
    '…and the condition still reads as an instruction: the wording is SCRUBBED, never blanked');
  check(/upload/i.test(client.label), '…the borrower still knows what to do');

  // The scrub must not invent wording where there was none: a condition with no
  // borrower hint answers null, not an empty string, so a screen renders nothing
  // rather than an empty line.
  const bare = shape({ ...row, borrower_hint: null, rejection_reason: null }, false);
  check(bare.hint === null && bare.rejectionReason === null,
    'a condition with no hint and nothing rejected answers null on both — never an empty string');

  // Internal staff still see every word, unscrubbed — the whole point of the rule.
  const staff = shape(row, true);
  check(/Deephaven/.test(staff.label) && /Deephaven/.test(staff.borrowerLabel),
    'internal staff still read the real name — the scrub is on the CLIENT payload only');

  // INERT ON EVERY WORD THE OWNER WROTE. A scrub that quietly rewrites the
  // shipped library would change the wording of 28 conditions nobody asked to
  // change, and nothing would report it. Measured over every string the library
  // carries, not only the ones that look like wording.
  const lib = require(path.join(ROOT, 'src/longterm/conditions-center/library'));
  const conds = [...lib.PRIOR_TO_SUBMISSION, ...lib.PRIOR_TO_CTC];
  let strings = 0; const moved = [];
  for (const c of conds) {
    for (const k of Object.keys(c)) {
      const v = c[k];
      if (typeof v !== 'string' || !v) continue;
      strings += 1;
      if (A.scrubInvestorNames(v, 'borrower') !== v) moved.push(`${c.code || '?'}.${k}`);
    }
  }
  check(strings > 100, `the shipped library really was measured (${strings} strings across ${conds.length} conditions)`);
  check(moved.length === 0,
    `INERT: the scrub rewrites nothing in the shipped library${moved.length ? ` — it moved ${moved.join(', ')}` : ''}`);
}

// ── done ─────────────────────────────────────────────────────────────────────
if (failures) {
  console.error(`\nFAILED — ${failures} check(s). The investor name could reach a client.`);
  process.exit(1);
}
console.log('\nOK — the investor name is blocked from borrowers and TPOs, and internal staff still see it.');
