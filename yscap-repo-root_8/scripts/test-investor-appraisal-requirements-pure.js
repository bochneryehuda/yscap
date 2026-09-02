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
// Owner-directed 2026-09-01: the message states ONE requirement — the anchor
// comp — with its three criteria numbered 1, 2, 3. "All comps within 1 mile" was
// wrong and is gone; interior photos and the lender name are "self-understood"
// and are no longer listed.
{
  const msg = reqs.orderMessage({ investorKey: 'emcap', loanNumber: 'YSCAP258134728',
    propertyAddress: '27 Beacon St, Lakewood, NJ 08701', rentalExit: false });
  ok(typeof msg === 'string' && msg.length > 200, 'an EMCAP order gets a message');
  ok(msg.startsWith(reqs.MARKER), 'it starts with the stable marker (which is also the do-not-repeat key)');
  ok(/YSCAP258134728/.test(msg) && /27 Beacon St/.test(msg), 'it names the loan and the property');
  ok(/12 months/.test(msg) && /15% net adjustment/.test(msg) && /SETTLED sale/.test(msg),
    'it states the anchor rule: settled, 12 months, under 15%');
  ok(/all THREE of/.test(msg), 'the anchor requirement says plainly that there are three things');
  const criteria = msg.split('\n').filter((l) => /^[123]\. /.test(l));
  ok(criteria.length === 3, `the three criteria are three separate NUMBERED lines (found ${criteria.length})`);
  ok(/^1\. within 1 mile of the subject;$/.test(criteria[0] || ''), 'criterion 1 is the mile');
  ok(/^2\. sold within the last 12 months;$/.test(criteria[1] || ''), 'criterion 2 is the year');
  ok(/^3\. under 15% net adjustment\.$/.test(criteria[2] || ''), 'criterion 3 is the net adjustment');
  ok(!msg.split('\n').some((l) => /^ *[abc]\. /.test(l)), 'no a/b/c lettering remains (the owner asked for 1, 2, 3)');

  // THE THREE WITHDRAWN ITEMS ARE GONE. Asserted on the exact lines that went
  // out, and on the ideas behind them, so a rewording cannot bring one back.
  for (const line of reqs.SUPERSEDED_LINES) ok(!msg.includes(line), `the withdrawn line is gone: "${line}"`);
  ok(!/Comparable sales must be within/.test(msg), 'it no longer says every comparable must be within the mile');
  ok(!/[Ii]nterior photograph/.test(msg), 'interior photographs are not listed (self-understood)');
  ok(!/YS Capital as the lender/.test(msg) && !/lender\/client/.test(msg), 'the lender-name line is not listed (self-understood)');
  // The mile is stated exactly ONCE — in the anchor criterion — never as a blanket rule.
  ok((msg.match(/within 1 mile/g) || []).length === 1, 'the mile appears exactly once, as the anchor criterion');
  // And the requirement is the ONLY numbered thing: no outer 1./2./3. list wraps it.
  ok(msg.indexOf('1. within') > msg.indexOf('all THREE of'), 'the numbers belong to the anchor criteria, not to an outer list');

  // THE RENT SCHEDULE ONLY ON A RENTAL EXIT (owner-directed 2026-08-16). Tested
  // on the WHOLE sentence, not just "1007" — asking a flip's appraiser for a
  // rent schedule costs money and time for nothing.
  const RENTAL_RE = /rent(al)? (analysis|schedule)|1007|1025/i;
  ok(!RENTAL_RE.test(msg), 'a non-rental file is told nothing at all about rent');
  const rental = reqs.orderMessage({ investorKey: 'emcap', rentalExit: true });
  ok(/1007/.test(rental) && /1025/.test(rental), 'a rental exit IS told a rental analysis is required');
  // ...and the rental line is the ONLY difference between the two messages, so
  // switching a file's exit can never quietly change any other requirement.
  const flat = (t) => t.split('\n').filter((l) => !RENTAL_RE.test(l)).join('\n').replace(/\n{2,}/g, '\n');
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

// ── B2. THE CORRECTION for orders that got the earlier message ─────────────
// Owner-directed 2026-09-01: "a one-time run job for all the files that you sent
// this message in the past, everybody, correcting the instructions."
{
  // The detector recognises EXACTLY the withdrawn wording — rebuilt here as it
  // was posted on 2026-08-16, not read from the module, so this test would catch
  // the module drifting away from the historical text it must keep matching.
  const oldMsg = [
    'Appraisal requirements for this loan — Loan #YSCAP1 · 27 Beacon St, Lakewood, NJ 08701', '',
    'Before this report is submitted, please make sure it meets the following. These are the requirements this loan will be reviewed against, so a report that misses one will have to come back for revision.', '',
    '1. Comparable sales must be within 1 mile of the subject.',
    '2. At least one As-Is comparable — and, where the report gives an after-repair (ARV) value, at least one ARV comparable — must be an "anchor" comp. An anchor comp is a SETTLED sale (an active or pending listing does not count) that meets all THREE of:',
    '      a. within 1 mile of the subject;', '      b. sold within the last 12 months;', '      c. under 15% net adjustment.',
    '3. Interior photographs of the subject are required.',
    '4. The report must name YS Capital as the lender/client.', '',
    'If any of these cannot be met on this property, please reply on this order and tell us before you complete the report.',
  ].join('\n');
  ok(reqs.isSupersededMessage(oldMsg) === true, 'the 2026-08-16 wording is recognised as superseded');
  ok(reqs.isSupersededMessage(reqs.orderMessage({ investorKey: 'emcap' })) === false,
    'the CURRENT wording is not superseded (a message posted today needs no correction)');
  ok(reqs.isSupersededMessage(reqs.orderMessage({ investorKey: 'emcap', rentalExit: true })) === false,
    'the current rental wording is not superseded either');
  ok(reqs.isSupersededMessage(reqs.correctionMessage({ investorKey: 'emcap' })) === false,
    'a correction is never itself "superseded" (or it would be corrected again, forever)');
  ok(reqs.isSupersededMessage('Comparable sales must be within 1 mile of the subject.') === false,
    'a HUMAN message that happens to contain the old line is not ours and is left alone');
  ok(reqs.isSupersededMessage(null) === false && reqs.isSupersededMessage('') === false, 'nothing → not superseded');

  const corr = reqs.correctionMessage({ investorKey: 'emcap', loanNumber: 'YSCAP258134728',
    propertyAddress: '27 Beacon St, Lakewood, NJ 08701' });
  ok(typeof corr === 'string' && corr.startsWith(reqs.CORRECTION_MARKER), 'the correction leads with its own marker');
  ok(!corr.startsWith(reqs.MARKER) && !reqs.CORRECTION_MARKER.startsWith(reqs.MARKER),
    'the correction marker can never be mistaken for the requirements marker (each is its own do-not-repeat key)');
  ok(/every comparable sale must be within 1 mile/.test(corr) && /not the requirement/.test(corr),
    'it says plainly what the earlier message got wrong');
  ok(/replaces it in full/.test(corr), 'it says the new list replaces the old one');
  ok(!/disregard.*photograph/i.test(corr) && !/[Ii]nterior photograph/.test(corr) && !/lender\/client/.test(corr),
    'it does NOT tell the appraiser to skip photographs or the lender name — those still apply, they just are not listed');
  ok(corr.includes(reqs._internals.anchorRequirement()),
    'the correction states the anchor requirement from the SAME single definition the live message uses');
  ok(corr.split('\n').filter((l) => /^[123]\. /.test(l)).length === 3, 'its three criteria are numbered 1, 2, 3');
  ok(/YSCAP258134728/.test(corr) && /27 Beacon St/.test(corr), 'it names the loan and the property');
  ok(!borrowerSafe.hasPartnerName(corr) && !/emcap/i.test(corr), 'the correction names no capital partner');
  ok(/1007/.test(reqs.correctionMessage({ investorKey: 'emcap', rentalExit: true }))
    && !/1007/.test(corr), 'the rental line follows the file\'s exit on the correction too');
  ok(reqs.correctionMessage({ investorKey: null }) === null && reqs.correctionMessage({ investorKey: 'other' }) === null
    && reqs.correctionMessage({}) === null, 'a file with no requirements gets no correction (nothing to correct it TO)');
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
