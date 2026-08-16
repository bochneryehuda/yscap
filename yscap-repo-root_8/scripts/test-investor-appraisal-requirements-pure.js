#!/usr/bin/env node
'use strict';
/**
 * THE INVESTOR'S APPRAISAL REQUIREMENTS — one definition, two surfaces.
 * Pure: no database, no network.
 *
 * Owner-directed 2026-08-16: an EMCAP file must post the appraisal requirements
 * onto the order right after it is placed, so the appraisal team knows what the
 * report will be judged against.
 *
 * What is proven here, and why each one exists:
 *   A. THE NUMBERS ARE STATED ONCE. `note-buyer-checks.js` — whose anchor rule
 *      is a clear-to-close-blocking fatal — reads them from the same module the
 *      message is built from. A second copy is how you end up telling an
 *      appraiser one rule and refusing their report for another.
 *   B. THE MESSAGE NAMES NOBODY. An AMC is an outside company; the capital
 *      partner's name may never reach one. Asserted against the shared partner
 *      list, not against a hand-typed set of spellings.
 *   C. IT IS SILENT WHEN IT HAS NOTHING TO SAY. A file with no investor
 *      requirements posts nothing at all.
 *   D. THE MILE IS ADDITIVE. Accepting the appraiser's stated distance can only
 *      ever let MORE comps qualify — never fewer — so no live file can newly
 *      fail the fatal because of this change. Proven by running the verdict
 *      over a battery with and without the distance, not asserted in prose.
 */
const path = require('path');
const R = path.resolve(__dirname, '..');
const reqs = require(R + '/src/lib/appraisal/investor-appraisal-requirements');
const checks = require(R + '/src/lib/appraisal/note-buyer-checks');
const borrowerSafe = require(R + '/src/lib/borrower-safe');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

// ── A. ONE DEFINITION ──────────────────────────────────────────────────────
{
  ok(reqs.ANCHOR_MONTHS === 12, 'the anchor window is 12 months');
  ok(reqs.ANCHOR_MAX_NET_ADJ_PCT === 15, 'the anchor net-adjustment ceiling is 15%');
  ok(reqs.COMP_RADIUS_MILES === 1, 'the comp radius is 1 mile');

  // The checks module must READ them, not restate them. A source guard, because
  // no behavioural test can tell a shared constant from an identical literal.
  const src = require('fs').readFileSync(R + '/src/lib/appraisal/note-buyer-checks.js', 'utf8');
  ok(/require\('\.\/investor-appraisal-requirements'\)/.test(src),
    'note-buyer-checks reads the requirements module');
  ok(/ANCHOR_MONTHS, ANCHOR_MAX_NET_ADJ_PCT, COMP_RADIUS_MILES/.test(src),
    'note-buyer-checks takes all three numbers from it');
  // And the finding wording must be built FROM the constants, so moving a
  // number moves the words a human reads too.
  ok(/within \$\{ANCHOR_MONTHS\} months/.test(src) && /under \$\{ANCHOR_MAX_NET_ADJ_PCT\}%/.test(src)
    && /within \$\{COMP_RADIUS_MILES\} mile/.test(src),
    'the finding text is built from the shared numbers, not typed again');
}

// ── B. THE MESSAGE ─────────────────────────────────────────────────────────
{
  const msg = reqs.orderMessage({ investorKey: 'emcap', loanNumber: 'YSCAP258134728',
    propertyAddress: '27 Beacon St, Lakewood, NJ 08701', rentalExit: false });
  ok(typeof msg === 'string' && msg.length > 200, 'an EMCAP order gets a message');
  ok(msg.startsWith(reqs.MARKER), 'it starts with the stable marker (which is also the do-not-repeat key)');
  ok(/YSCAP258134728/.test(msg) && /27 Beacon St/.test(msg), 'it names the loan and the property');
  ok(/within 1 mile/.test(msg), 'it states the 1-mile rule the owner gave');
  ok(/12 months/.test(msg) && /15% net adjustment/.test(msg) && /SETTLED sale/.test(msg),
    'it states the anchor rule: settled, 12 months, under 15%');
  // THE ANCHOR'S THREE CRITERIA ARE PRINTED AS THREE, not run together in a
  // sentence (owner-directed 2026-08-16: "EMCAP needs three things for the
  // anchor comp"). An appraiser skimming a paragraph misses the third.
  ok(/all THREE of/.test(msg), 'the anchor requirement says plainly that there are three things');
  const anchorItem = msg.split('\n').filter((l) => /^ *[abc]\. /.test(l));
  ok(anchorItem.length === 3, `the three criteria are three separate lines (found ${anchorItem.length})`);
  ok(/a\..*within 1 mile/.test(anchorItem[0] || ''), 'criterion a is the mile');
  ok(/b\..*last 12 months/.test(anchorItem[1] || ''), 'criterion b is the year');
  ok(/c\..*under 15% net adjustment/.test(anchorItem[2] || ''), 'criterion c is the net adjustment');
  ok(/[Ii]nterior photograph/.test(msg), 'it states the interior-photo requirement');
  ok(/YS Capital as the lender/.test(msg), 'it states that the report must be in our name');

  // THE RENT SCHEDULE ONLY ON A RENTAL EXIT (owner-directed 2026-08-16). Tested
  // on the WHOLE sentence, not just "1007" — asking a flip's appraiser for a
  // rent schedule costs money and time for nothing.
  const RENTAL_RE = /rent(al)? (analysis|schedule)|1007|1025/i;
  ok(!RENTAL_RE.test(msg), 'a non-rental file is told nothing at all about rent');
  const rental = reqs.orderMessage({ investorKey: 'emcap', rentalExit: true });
  ok(/1007/.test(rental) && /1025/.test(rental), 'a rental exit IS told a rental analysis is required');
  // ...and the rental line is the ONLY difference between the two messages, so
  // switching a file's exit can never quietly change any other requirement.
  // Same context on both sides — otherwise this would be comparing the loan
  // number, not the requirements. The renumbering the extra item causes is
  // stripped too, or every later line would read as "changed".
  const flat = (t) => t.split('\n').filter((l) => !RENTAL_RE.test(l)).join('\n').replace(/^\d+\. /gm, '');
  const plainNoCtx = reqs.orderMessage({ investorKey: 'emcap' });
  ok(flat(plainNoCtx) === flat(rental), 'the rental line is the only thing a rental exit adds');
  ok(reqs.orderMessage({ investorKey: 'emcap', rentalExit: false }) === plainNoCtx
    && reqs.orderMessage({ investorKey: 'emcap', rentalExit: null }) === plainNoCtx
    && reqs.orderMessage({ investorKey: 'emcap', rentalExit: undefined }) === plainNoCtx,
    'an unknown exit is treated as NOT rental — the rent line is never guessed on');

  // THE NAME NEVER LEAVES THE BUILDING. Checked against the shared partner list
  // rather than a hand-typed one, so a partner added later is covered.
  const names = borrowerSafe.PARTNER_PATTERNS || [];
  const leaked = names.filter((re) => { try { return re.test(msg) || re.test(rental); } catch (_) { return false; } });
  ok(leaked.length === 0, `no capital-partner name appears in the message (leaked: ${leaked})`);
  ok(!/emcap/i.test(msg) && !/emcap/i.test(rental), 'the word EMCAP itself never appears');
  ok(borrowerSafe.hasPartnerName(msg) !== true, 'the shared partner-name detector finds nothing in the message');
}

// ── C. SILENT WHEN THERE IS NOTHING TO SAY ────────────────────────────────
{
  ok(reqs.orderMessage({ investorKey: null }) === null, 'no investor → no message');
  ok(reqs.orderMessage({ investorKey: 'someone_else' }) === null, 'an investor with no requirements → no message');
  ok(reqs.orderMessage({}) === null, 'an empty context → no message, never a half-written one');

  // WHICH investor governs. The file's own note buyer decides; a blank one falls
  // back to the registered program's provider — the SAME derivation that stamps
  // `applications.lender` in the first place, so the two cannot disagree.
  ok(reqs.investorForFile({ noteBuyer: 'EMCAP Financial' }) === 'emcap', 'the real production label is recognised');
  ok(reqs.investorForFile({ noteBuyer: 'emcap' }) === 'emcap', 'the bare key is recognised');
  ok(reqs.investorForFile({ noteBuyer: null, registeredProgram: 'silver' }) === 'emcap',
    'a Silver file with no note buyer yet still gets EMCAP\'s requirements');
  ok(reqs.investorForFile({ noteBuyer: 'Blue Lake Capital' }) === null, 'a different named buyer gets nothing');
  ok(reqs.investorForFile({ noteBuyer: null, registeredProgram: 'gold' }) === null, 'a Gold file gets nothing');
  ok(reqs.investorForFile({ noteBuyer: null, registeredProgram: 'manual' }) === null,
    'a manual program implies no buyer, so it gets nothing');
  ok(reqs.investorForFile({}) === null && reqs.investorForFile() === null, 'nothing known → nothing said');
}

// ── D. THE MILE IS ADDITIVE — proven, not asserted ────────────────────────
{
  const verdict = checks._internals.compVerdict;
  const SUBMITTED = '2026-06-15';
  const SUBJECT_ZIP = '08701';
  const base = { saleStatus: 'closed', saleDate: '2026-03-01', netAdjPct: 5, zip: SUBJECT_ZIP };

  // Every combination that matters, each run twice: once as the report came
  // (no stated distance) and once with a distance added. Adding a distance may
  // only ever move a comp TOWARDS passing.
  const RANK = { fail: 0, unknown: 1, pass: 2 };
  const zips = [SUBJECT_ZIP, '08753', null];
  const dates = ['2026-03-01', '2024-01-01', null];
  const adjs = [5, 40, null];
  const statuses = ['closed', 'active'];
  const distances = ['0.35 miles SW', '0.99 mi', '1.00 miles', '2.40 miles NE', '1/2 mile', 'same street', ''];
  let cases = 0, regressions = 0;
  for (const zip of zips) for (const saleDate of dates) for (const netAdjPct of adjs) for (const saleStatus of statuses) {
    const bare = { ...base, zip, saleDate, netAdjPct, saleStatus, proximity: null };
    const before = verdict(bare, { submittedDate: SUBMITTED, subjectZip: SUBJECT_ZIP });
    for (const proximity of distances) {
      const after = verdict({ ...bare, proximity }, { submittedDate: SUBMITTED, subjectZip: SUBJECT_ZIP });
      cases++;
      if (RANK[after.verdict] < RANK[before.verdict]) {
        regressions++;
        if (regressions < 4) console.log(`     ${before.verdict} → ${after.verdict} with proximity "${proximity}" zip=${zip} date=${saleDate} adj=${netAdjPct} status=${saleStatus}`);
      }
    }
  }
  ok(regressions === 0, `a stated distance never makes a comp WORSE (${regressions} of ${cases} regressed)`);
  ok(cases === 3 * 3 * 3 * 2 * 7, `the battery ran the whole grid (${cases} cases)`);

  // And it does what it is for: the comp the ZIP rule was wrongly failing.
  const nextZip = { ...base, zip: '08753', proximity: '0.40 miles NE' };
  ok(verdict(nextZip, { submittedDate: SUBMITTED, subjectZip: SUBJECT_ZIP }).verdict === 'pass',
    'a comp 0.4 miles away in the next ZIP now qualifies — the rule is the mile');
  ok(verdict({ ...nextZip, proximity: null }, { submittedDate: SUBMITTED, subjectZip: SUBJECT_ZIP }).verdict === 'fail',
    'the same comp with NO stated distance still falls back to the ZIP (nothing else changed)');

  // A distance outside the mile is NOT a new way to fail: it falls back to the
  // ZIP test the comp has always faced.
  ok(verdict({ ...base, proximity: '3.00 miles' }, { submittedDate: SUBMITTED, subjectZip: SUBJECT_ZIP }).verdict === 'pass',
    'a comp 3 miles away in the SAME ZIP is not newly failed on distance');
  const far = verdict({ ...base, zip: '08753', proximity: '3.00 miles' }, { submittedDate: SUBMITTED, subjectZip: SUBJECT_ZIP });
  ok(far.verdict === 'fail' && /3 miles away/.test(far.reasons.join(' ')),
    'a far comp in a different ZIP fails, and the reason states the distance');

  // The unreadable ones must abstain, never be read as zero miles.
  for (const junk of ['1/2 mile', 'nearby', '', null, undefined, '60 miles']) {
    const v = verdict({ ...base, zip: '08753', proximity: junk }, { submittedDate: SUBMITTED, subjectZip: SUBJECT_ZIP });
    ok(v.verdict === 'fail', `an unreadable distance (${JSON.stringify(junk)}) falls back to the ZIP, never passes`);
  }
}

console.log(`investor appraisal requirements: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
