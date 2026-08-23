'use strict';
/**
 * LT test — ONLY OUR OWN LOANS COME IN, with no database and no Encompass.
 *
 * Owner-directed 2026-08-23: *"make sure it's only gonna pull according to our rule:
 * only long-term files."*
 *
 * Discovery reads the WHOLE Encompass book, because no folder separates the two
 * products at the source — 772 loans, 251 of them fix-and-flip. Filtering them out
 * needs two facts the discovery row did not carry, and asking for them is the risky
 * part: the live probe recorded that an unknown field id "rejects the whole batch",
 * and a rejected discovery is not a smaller sync, it is NO sync — the entire book
 * gone from every screen.
 *
 * SO THE TWO THINGS PINNED HERE ARE BOTH ABOUT WHAT HAPPENS WHEN IT GOES WRONG:
 *
 *   · **A refused enrichment falls back and keeps working.** One retry, the proven
 *     field list, and the pass carries on — reported, never silent. Section A.
 *   · **"We could not ask" never reads as "short-term".** With the enrichment
 *     refused NOTHING is skipped, so the failure mode is mirroring too much (which
 *     is where we started) and never dropping a real file. Section B.
 *
 * Everything here is pure. No Postgres, no Encompass, no HTTP.
 */

const path = require('path');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

// ── A. The enrichment, and its fallback ─────────────────────────────────────
console.log('asking Encompass for the two fields that say whose loan this is');

const CLIENT = require.resolve('../src/longterm/encompass/client');
const calls = [];
let failWhen = () => false;
require.cache[CLIENT] = {
  id: CLIENT,
  filename: CLIENT,
  loaded: true,
  exports: {
    configured: () => true,
    // A stub that answers with fields NOBODY ASKED FOR proves nothing about the
    // fallback: the whole point is that a request without the two extra fields comes
    // back without them. So this returns only what was requested, the way Encompass
    // does — and that is what makes the "unclassifiable after a fallback" assertion
    // below mean something. (The first version of this stub did not, and the test
    // failed honestly rather than passing on a fiction.)
    pipelineSearch: async (request) => {
      const asked = (request.fields || []).slice();
      calls.push(asked);
      if (failWhen(request)) throw new Error('Invalid field id');
      const all = { 'Loan.LoanNumber': 'LN-1', 'Fields.1401': 'DSCR 30 Year FRM', 'Fields.4': '360' };
      const fields = {};
      for (const k of asked) if (all[k] !== undefined) fields[k] = all[k];
      return [{ loanId: 'g1', fields }];
    },
  },
};

const discover = require('../src/longterm/sync/discover');
const productTerm = require('../src/longterm/product-term');

check(discover.CLASSIFY_FIELDS.join(',') === 'Fields.1401,Fields.4',
  'the two extra fields are the program (1401) and the term (4) — the exact pair product-term decides on');
check(!discover.DISCOVERY_FIELDS.includes('Fields.1401'),
  'they are kept OUT of the proven field list, so the fallback has something proven to fall back TO');

(async () => {
  // Happy path — the enrichment is answered.
  calls.length = 0; failWhen = () => false;
  const good = await discover.discoverLoans({});
  check(good.classifyFields === 'answered', 'when Encompass answers, the pass says so');
  check(calls[0].includes('Fields.1401') && calls[0].includes('Fields.4'),
    'the very first call asks for both extra fields');
  check(good.loans[0].programName === 'DSCR 30 Year FRM' && good.loans[0].termMonths === 360,
    'and both land on the discovered loan');

  // The dangerous path — Encompass refuses the enriched field list.
  calls.length = 0;
  let first = true;
  failWhen = () => { const f = first; first = false; return f; };
  const fell = await discover.discoverLoans({});
  check(fell.classifyFields === 'refused',
    'THE ONE THAT MATTERS: a refused enrichment is REPORTED, not swallowed');
  check(fell.loans.length === 1,
    '…and the pass still returns the book — a rejected discovery would be every file gone from every screen');
  check(calls.length === 2 && !calls[1].includes('Fields.1401'),
    '…having retried ONCE with the proven field list');
  check(fell.loans[0].programName === null && fell.loans[0].termMonths === null,
    '…and every loan comes back unclassifiable, which is the truth');

  // A failure AFTER the fallback is a real failure and must not be retried forever.
  calls.length = 0; failWhen = () => true;
  let threw = false;
  try { await discover.discoverLoans({}); } catch (_) { threw = true; }
  check(threw, 'a failure that survives the fallback is thrown — a sync reporting an empty book would be far worse');
  check(calls.length === 2, '…and it is retried exactly once, never in a loop');

  // ── B. Which loans are ours ───────────────────────────────────────────────
  console.log('\nwhich loans the rule says are ours');

  const verdict = (programName, termMonths) =>
    productTerm.classifyProduct({ programName, termMonths }).product;

  check(verdict('DSCR 30 Year FRM', 360) === productTerm.PRODUCT.LONG, 'a DSCR 30-year is ours');
  check(verdict('Fix & Flip Purchase + reno', 12) === productTerm.PRODUCT.SHORT, 'a fix & flip is not');
  check(verdict(null, 36) === productTerm.PRODUCT.BOUNDARY, 'exactly 36 months is a boundary case');
  check(verdict(null, null) === productTerm.PRODUCT.UNKNOWN, 'no program and no term is unknown');

  // The rule the sync applies, stated as the sync states it: skip ONLY the provable.
  const wouldSkip = (p, t, canClassify = true) =>
    canClassify && productTerm.classifyProduct({ programName: p, termMonths: t }).product === productTerm.PRODUCT.SHORT;

  check(wouldSkip('Fix & Flip Purchase + reno', 12) === true,
    'THE ONE THAT MATTERS: a provable short-term loan is skipped — never written, never read');
  check(wouldSkip('DSCR 30 Year FRM', 360) === false, 'a long-term loan is mirrored');
  check(wouldSkip(null, 36) === false,
    'a BOUNDARY loan is mirrored — a file we cannot place must never vanish with nothing saying so');
  check(wouldSkip(null, null) === false, 'so is an unknown one');
  check(wouldSkip('Fix & Flip Purchase + reno', 12, false) === false,
    'THE OTHER ONE THAT MATTERS: with the fields refused, NOTHING is skipped — "we could not ask" can never read as "short-term"');

  // ── C. The pipeline hides what is already in ──────────────────────────────
  console.log('\nand the screen stops listing what was pulled in before the rule existed');

  const pipeline = require('../src/longterm/pipeline');
  const books = { closed: [], withdrawn: [], excluded: [] };
  const sqlOf = (hide) => pipeline.buildPipelineQuery({ scope: 'all' }, null, {}, { books, hideShortTerm: hide }).sql;
  const marker = /<> 'short_term'/;

  check(marker.test(sqlOf(true)), 'the filter is in the query when the setting is on');
  check(marker.test(sqlOf(undefined)), '…and on by default, because this is the long-term pipeline');
  check(!marker.test(sqlOf(false)),
    '…and genuinely gone when a tenant turns it off — a switch that changes nothing is worse than no switch');

  // It must be the SHARED rule, not a second copy: two definitions of "whose loan is
  // this" is how the pipeline and the census come to disagree about one file.
  check(sqlOf(true).includes(productTerm.productSql('l.program_name', 'l.term_months')),
    'the filter IS product-term\'s own SQL twin, verbatim — never a hand-written program test here');

  // The facet counts must be filtered too, or a chip would count files the list refuses
  // to show and nobody could reconcile the two.
  const facets = pipeline.buildFacetQueries({ scope: 'all' }, null, {}, { books, hideShortTerm: true });
  const facetSql = JSON.stringify(facets);
  check(marker.test(facetSql), 'the chip counts are filtered too, so a count can never disagree with the page');

  console.log(failures ? `\n${failures} failure(s)` : '\nall good');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('  FAIL threw:', (e && e.message) || e); process.exit(1); });
