'use strict';
/**
 * WHY A DECLINED PROPERTY IS NOT THEIRS — derived, never typed (owner-directed
 * 2026-08-10: "reject 'not theirs' — no type-in reason box; the system figures
 * out WHY itself: same-name-different-person / matched by entity only"). The
 * system reads the reason off the #11 match basis; the reviewer confirms it or
 * picks a guided option; a decline is NEVER refused for "no reason given".
 *
 * The one that carries this file is section 4: the BROWSER MIRROR cannot drift.
 * The workbench pre-selects the suggested reason from
 * app-v2/src/lib/declineReason.js while the server records the text from
 * src/lib/track-record/decline-reason.js — if the two disagree on the suggested
 * CODE, the reviewer sees one reason and the file records another. It runs BOTH
 * over a battery of match bases and fails on any drift.
 */

const DR = require('../src/lib/track-record/decline-reason');

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

(async () => {
  console.log('\n1. THE SYSTEM DERIVES THE REASON FROM THE #11 MATCH BASIS');
  {
    ok(DR.suggestFromBasis({ warn: true, basis: 'entity_only', entityMatched: true }) === 'not_our_company',
      'a company-only match with the pending warning → "a different company with the same name"');
    ok(DR.suggestFromBasis({ basis: 'personal', personalMatched: true }) === 'same_name_different_person',
      'a personal-name match → "a different person with the same name"');
    ok(DR.suggestFromBasis({ basis: 'both', personalMatched: true, entityMatched: true }) === 'same_name_different_person',
      'a "both" match (the borrower IS behind the company) → a namesake person, not a same-name company');
    ok(DR.suggestFromBasis({ basis: 'entity_only', entityMatched: true, warn: false, peopleKnown: false }) === 'not_our_company',
      'a company match we could not check (no people list) → still "a different company"');
    ok(DR.suggestFromBasis(null) === 'not_theirs', 'no match basis → the plain "not this borrower\'s"');
    ok(DR.suggestFromBasis(undefined) === 'not_theirs', 'undefined basis → the catch-all, never a throw');
  }

  console.log('\n2. RESOLVE ALWAYS PRODUCES A NON-EMPTY, HUMAN-READABLE REASON');
  {
    const r1 = DR.resolve({ matchBasis: { warn: true, basis: 'entity_only', entityMatched: true, entityName: 'MW Trading LLC' } });
    ok(/different company with the same name/i.test(r1) && /MW Trading LLC/.test(r1),
      'the derived company reason names the entity and states the same-name-company risk');
    const r2 = DR.resolve({ matchBasis: { basis: 'personal', personalMatched: true } });
    ok(/different person/i.test(r2), 'the derived personal reason says "a different person"');
    const r3 = DR.resolve({ reasonCode: 'wrong_property', matchBasis: { basis: 'personal', personalMatched: true } });
    ok(/property details/i.test(r3), 'a guided reasonCode wins over the basis-derived default');
    ok(DR.resolve({ note: 'a specific note' }) === 'a specific note',
      'a typed note is honored (back-compat) but never required');
    ok(DR.resolve({}) === DR.REASONS.not_theirs.text && DR.resolve({}).length > 0,
      'with nothing to go on it still records a real reason — a decline is never refused for "no reason"');
    ok(DR.resolve({ note: 'x'.repeat(900) }).length === 500, 'a typed reason is capped to the column');
    // A junk reasonCode is ignored (falls through to a real derivation), never stored raw.
    const r4 = DR.resolve({ reasonCode: 'nonsense_code', matchBasis: { warn: true, basis: 'entity_only', entityMatched: true } });
    ok(/different company/i.test(r4), 'an unknown reasonCode is ignored and the basis derivation is used');
  }

  console.log('\n3. THE GUIDED OPTIONS put the suggestion first-flagged, every code known');
  {
    const opt = DR.optionsFor({ warn: true, basis: 'entity_only', entityMatched: true });
    ok(opt.suggested === 'not_our_company', 'optionsFor carries the suggestion');
    ok(opt.options.length === DR.ORDER.length && opt.options.every((o) => DR.REASONS[o.code]),
      'every option is a known reason code');
    ok(opt.options.filter((o) => o.suggested).length === 1
      && opt.options.find((o) => o.suggested).code === 'not_our_company',
      'exactly one option is flagged suggested, and it is the derived one');
  }

  console.log('\n4. THE BROWSER MIRROR CANNOT DRIFT');
  {
    const M = await import('../app-v2/src/lib/declineReason.js');
    ok(JSON.stringify(M.ORDER) === JSON.stringify(DR.ORDER),
      'the mirror lists the SAME reason codes, in the same order');
    ok(DR.ORDER.every((c) => M.REASON_LABELS[c] === DR.REASONS[c].label),
      'every browser label matches the server\'s');
    const bases = [
      { warn: true, basis: 'entity_only', entityMatched: true },
      { warn: false, basis: 'entity_only', entityMatched: true, peopleKnown: false },
      { basis: 'personal', personalMatched: true },
      { basis: 'both', personalMatched: true, entityMatched: true },
      { basis: 'entity_only', entityMatched: true, warn: true, personalMatched: false },
      null, undefined, {}, { nonsense: 1 },
    ];
    let drift = 0;
    for (const b of bases) if (M.suggestFromBasis(b) !== DR.suggestFromBasis(b)) drift += 1;
    ok(drift === 0, 'the browser suggestFromBasis agrees with the server on every match basis — no drift');
  }

  if (fail) { console.error(`\ntest-track-record-decline-reason-pure: ${fail} FAILED`); process.exit(1); }
  console.log('\ntest-track-record-decline-reason-pure: all passed');
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
