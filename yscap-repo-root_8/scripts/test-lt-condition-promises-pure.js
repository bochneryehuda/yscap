'use strict';
/**
 * EVERY CAPABILITY A LONG-TERM CONDITION DECLARES IS EITHER IMPLEMENTED OR
 * RECORDED AS NOT YET — never silently promised.
 *
 * ── THE CLASS THIS EXISTS TO STOP ───────────────────────────────────────────
 *
 * A condition's `config` is a promise about what it does, and its HINT tells the
 * borrower the same thing in words. Four of them promised something no code
 * anywhere did:
 *
 *   · `lt_vesting_entity`   — "save it to the profile and the next loan for the
 *     same company starts already done". Nothing wrote to the profile at all.
 *   · `lt_appraisal_card`   — "a card given on one loan is already here on the
 *     next". No long-term module referenced `saved_card_*`.
 *   · `lt_photo_id`         — "an ID given on any previous loan is already here".
 *     No long-term module referenced `photo_id_document_id`.
 *   · `lt_reo_liabilities`  — "the answer is saved to the SHARED borrower profile
 *     so the next loan starts from it". Nothing in `src/longterm/` touches
 *     `track_records`, which is where the profile keeps that answer.
 *
 * Three are built now; the fourth is recorded below with what still has to be
 * decided. None of them FAILED — they quietly did nothing, which is worse,
 * because the screen kept saying otherwise and a borrower kept being asked for
 * something they had already given.
 *
 * ── HOW IT CHECKS ───────────────────────────────────────────────────────────
 *
 * Each capability names the module that has to carry it and a SYMBOL that module
 * must actually contain — a table, a column, a function — rather than merely the
 * capability's own name, which a comment could satisfy. Comments are stripped
 * first for exactly that reason.
 *
 * A capability not yet built goes in `NOT_YET`, with the reason, so the promise
 * is visible in a test run instead of only in a hint the borrower reads. The
 * library ALSO has to stop making the promise to the borrower — a `NOT_YET`
 * entry names the wording that must not appear, so an unbuilt capability can
 * never be advertised.
 *
 * Run: node scripts/test-lt-condition-promises-pure.js
 */
const fs = require('fs');
const { stripComments } = require('./lib/strip-comments');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const read = (f) => stripComments(fs.readFileSync(f, 'utf8'));

/**
 * capability -> what has to exist for it to be real.
 *   file   — the module that carries it
 *   needs  — a symbol that module must contain. Deliberately something only a
 *            working implementation has (a column, a table, a shared function),
 *            never the capability's own name.
 */
const IMPLEMENTED_BY = Object.freeze({
  readsFromBorrowerProfile: [
    { file: 'src/longterm/conditions-center/entity-prefill.js', needs: 'findLlcByName' },
    { file: 'src/longterm/conditions-center/profile-links.js', needs: 'photo_id_document_id' },
  ],
  savesToBorrowerProfile: [
    { file: 'src/longterm/conditions-center/entity-profile.js', needs: 'findOrCreateLlc' },
    { file: 'src/longterm/conditions-center/profile-links.js', needs: 'saveCardForReuse' },
  ],
  prefillFromEntity: [
    { file: 'src/longterm/conditions-center/entity-prefill.js', needs: 'getLlcBundle' },
  ],
  answeredBy: [
    // THE SHARED module — `answers.js` lives in `src/lib/conditions/`, not under
    // `src/longterm/`, because both products read the same one. Pointing this at a
    // long-term path would have asserted against a file that does not exist.
    { file: 'src/lib/conditions/answers.js', needs: 'plan' },
  ],
  orderType: [
    { file: 'src/longterm/orders/desk.js', needs: 'lt_file_orders' },
  ],
});

/**
 * DECLARED AND NOT BUILT — each with what is still open. A promise nobody has
 * kept is recorded here rather than left to be discovered by a borrower being
 * asked twice.
 *
 * `mustNotSay` is the other half: while a capability is unbuilt the library may
 * not TELL anybody it works. The wording is checked against the condition's own
 * borrower-facing text.
 */
const NOT_YET = Object.freeze({
  lt_reo_liabilities: {
    capability: 'savesToBorrowerProfile',
    why: 'The REO answers belong on the shared profile as `track_records` rows — the residual '
       + 'REO list, per the 2026-08-09 rule that REO is every line not currently counting. What '
       + 'is NOT decided is what an LT answer becomes there: a currently-owned property with a '
       + 'mortgage has no exit, so it counts toward no experience and cannot inflate a tier — but '
       + 'which fields it carries, and whether a long-term answer may create a line on a person\'s '
       + 'permanent record at all, is the owner\'s to state rather than mine to infer.',
    /* NARROW ON PURPOSE, and the first cut was not. `savesToBorrowerProfile`
       claims ONE thing to a borrower: that answering here means the NEXT LOAN
       does not ask again. The condition's hint also says "if one of them is the
       home you live in, say so and we will use what we already have" — which is
       a different, WITHIN-LOAN promise about linking to the primary residence,
       and `answers.js` genuinely keeps it. A broad pattern flagged that as an
       unkept promise, which would have been a false alarm on working behaviour;
       the fix is a pattern that means the cross-loan claim and nothing else.
       Do not widen it back — flagging correct wording is how a guard gets
       switched off. */
    mustNotSay: /next (loan|time)|already (verified|done) (on|from) (a |your )?(previous|earlier|other) loan/i,
  },
});

console.log('1. every declared capability is carried by a module that really implements it');
{
  const lib = require('../src/longterm/conditions-center/library');
  const items = lib.library();
  assert(items.length > 10, `A0 the library was read (${items.length} conditions)`);

  const declared = new Map();          // capability -> [codes]
  for (const c of items) {
    for (const k of Object.keys(c.config || {})) {
      if (!declared.has(k)) declared.set(k, []);
      declared.get(k).push(c.code);
    }
  }

  for (const [cap, spec] of Object.entries(IMPLEMENTED_BY)) {
    assert(declared.has(cap),
      `A1 ${cap} is still declared by at least one condition — an entry here for a capability nobody declares is stale`);
    for (const { file, needs } of spec) {
      let src = null;
      try { src = read(file); } catch (_) { src = null; }
      assert(src !== null, `A2 ${cap}: ${file} exists`);
      assert(src !== null && src.includes(needs),
        `A3 ${cap}: ${file} really implements it (contains \`${needs}\`, not just the word "${cap}")`);
    }
  }
}

console.log('\n2. an unbuilt promise is recorded — and is not made to the borrower');
{
  const lib = require('../src/longterm/conditions-center/library');
  const byCode = new Map(lib.library().map((c) => [c.code, c]));

  for (const [code, entry] of Object.entries(NOT_YET)) {
    const c = byCode.get(code);
    assert(!!c, `B1 ${code} is still in the library`);
    if (!c) continue;
    assert((c.config || {})[entry.capability] !== undefined,
      `B2 ${code} still declares ${entry.capability} — remove this entry once it is built, or the record goes stale`);
    assert(typeof entry.why === 'string' && entry.why.length > 60,
      `B3 ${code} records WHY it is not built yet, in enough words to act on`);

    /* THE BORROWER IS NOT TOLD IT WORKS. This is the half that actually costs
       somebody something: a hint promising "we will use what we already have"
       makes a borrower stop looking for a document PILOT is about to ask for. */
    const facing = `${c.borrowerLabel || ''} ${c.borrowerHint || ''}`;
    assert(!entry.mustNotSay.test(facing),
      `B4 ${code} does NOT promise the borrower a capability it does not have yet (its borrower wording)`);
  }
}

console.log('\n3. the guard is proven to bite');
{
  /* A SOURCE SWEEP THAT MATCHES NOTHING PASSES FOREVER. Both halves are run
     against a deliberate failure so a run can never be green because the check
     silently stopped working. */
  const fakeSrc = stripComments('// savesToBorrowerProfile is mentioned only in this comment\nconst x = 1;');
  assert(!fakeSrc.includes('savesToBorrowerProfile'),
    'C1 comments are stripped — a capability named only in an explanation never counts as implemented');

  const promising = { borrowerLabel: 'Your mortgages',
    borrowerHint: 'Answer once and the next loan will not ask you again.' };
  assert(NOT_YET.lt_reo_liabilities.mustNotSay.test(`${promising.borrowerLabel} ${promising.borrowerHint}`),
    'C2 the borrower-wording check really does catch the CROSS-LOAN promise — so B4 passing means the wording is clean, not that the pattern is dead');
  const legitimate = 'If one of them is the home you live in, say so and we will use what we already have.';
  assert(!NOT_YET.lt_reo_liabilities.mustNotSay.test(legitimate),
    'C3 …and does NOT catch the within-loan promise that IS kept — a guard that flags working behaviour gets switched off');
}

console.log(failures ? `\n${failures} FAILURE(S)` : `\nALL PASS`);
process.exit(failures ? 1 : 0);
