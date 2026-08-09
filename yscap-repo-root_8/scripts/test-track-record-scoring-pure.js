'use strict';
/**
 * THE SCORING LADDER — pure, offline, no database.
 *
 * The single most important assertion in this file is section 1: a record where
 * our entity is NOT the grantee is DISCARDED rather than scored. That is not a
 * style choice — it caught a live false positive during API probing, where a
 * York, PA investor's profile returned a Philadelphia property he never owned
 * because his LLC appeared as GRANTOR on an unrelated later deed. Appearing on a
 * deed is not owning the property.
 *
 * Section 6 is the other one that earns its keep: nothing here may reach
 * `auto_proved` on signals that do not include a real identity tie, a
 * corroborated date and a real exit — because a false positive credits this
 * borrower with somebody else's flip.
 */

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

const S = require('../src/lib/track-record/scoring');

/** A deal with every signal a clean, fully-corroborated flip would carry. */
const CLEAN = {
  granteeIsMatchedEntity: true,
  borrowerSignedInstrument: true,
  sosListsAsOfficer: true,
  vendorLinksEntityToBorrower: true,
  exitInWindow: true,
  deedCorroboratesExitDate: true,
  armsLengthSale: true,
  recordedSatisfaction: true,
  nameCommonnessScore: 10,
  entityCombinedCoveragePct: 90,
};
const TODAY = '2026-08-09';

// ═══════════════════ 1. THE HARD PRECONDITION — grantee or nothing
console.log('\n1. A record where our entity is not the GRANTEE is discarded, not scored');
{
  const r = S.scoreDeal({ ...CLEAN, granteeIsMatchedEntity: false }, { today: TODAY });
  ok(r.discarded === true, 'the row is DISCARDED');
  ok(r.band === 'discarded' && r.score === 0,
    '…and carries no score at all — a pile of strong-but-irrelevant signals must not push it into review');
  ok(/GRANTEE/.test(r.reasons[0].why), '…with the reason stated plainly');

  // Absent is not false: an unknown grantee is equally not a pass.
  ok(S.scoreDeal({ ...CLEAN, granteeIsMatchedEntity: undefined }, { today: TODAY }).discarded === true,
    'and an UNKNOWN grantee is discarded too — absent is never treated as yes');
}

// ═══════════════════ 2. The clean case reaches auto-proved
console.log('\n2. A fully corroborated deal reaches auto_proved');
{
  const r = S.scoreDeal(CLEAN, { today: TODAY });
  ok(r.band === 'auto_proved', `a clean flip is auto_proved (score ${r.score})`);
  ok(r.score >= S.BAND_AUTO, `…and its score clears the ${S.BAND_AUTO} bar`);
  ok(r.reasons.some((x) => x.key === 'A1') && r.reasons.some((x) => x.key === 'C1'),
    '…with the identity tie and the exit both named in the reasons');
  ok(r.needs.length === 0, '…and asks for nothing');
}

// ═══════════════════ 3. Each gate is genuinely required for auto-proved
console.log('\n3. Removing any one gate drops it out of auto_proved');
{
  const drop = (patch, label) => {
    const r = S.scoreDeal({ ...CLEAN, ...patch }, { today: TODAY });
    ok(r.band !== 'auto_proved', `${label} → ${r.band} (score ${r.score})`);
  };
  drop({ borrowerSignedInstrument: false, sosListsAsOfficer: false }, 'no personal identity tie at all');
  drop({ deedCorroboratesExitDate: false }, 'nothing recorded corroborates the exit date');
  drop({ armsLengthSale: false }, 'no arm’s-length sale and no qualifying refinance');
  drop({ exitInWindow: false }, 'the exit is outside the 3-year window');
}

// ═══════════════════ 4. The refinance window the owner widened
console.log('\n4. The refinance rule — 4 to 20 months, and cash purchases count');
{
  const q = (r) => S.refinanceQualifies(r);
  ok(q({ monthsAfterPurchase: 12, termMonths: 360 }).ok === true, '12 months into a 30-year loan qualifies');
  ok(q({ monthsAfterPurchase: 18, termMonths: 360 }).ok === true,
    '18 months qualifies — the owner widened this from the old 12-14 month window');
  ok(q({ monthsAfterPurchase: 20, termMonths: 360 }).ok === true, '20 months, the far edge, qualifies');
  ok(q({ monthsAfterPurchase: 21, termMonths: 360 }).ok === false, '21 months is outside');
  ok(q({ monthsAfterPurchase: 3, termMonths: 360 }).ok === false, '3 months is too soon to be a completed project');
  ok(q({ monthsAfterPurchase: 12, termMonths: 12 }).ok === false,
    'refinancing into ANOTHER short-term loan is not an exit');
  ok(q({ monthsAfterPurchase: 12, termMonths: 360, isExtension: true }).ok === false,
    'an extension of the same loan is not a refinance');
  ok(q(null).ok === false && /no refinance/.test(q(null).why), 'and no refinance at all says so plainly');

  /* THE OWNER'S RULING: "You must have purchased with a short-term loan. If you
     purchase with cash and you refinance, then it's the same good." So how the
     property was ACQUIRED is deliberately not a condition anywhere here. */
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/lib/track-record/scoring.js'), 'utf8');
  ok(!/purchasedWithShortTerm|acquiredWith|purchaseLoanType/.test(src),
    'nothing in the ladder conditions on HOW the property was bought — a cash purchase then a refinance counts the same');

  const cashRefi = S.scoreDeal({
    ...CLEAN, armsLengthSale: false, recordedSatisfaction: false,
    refinance: { monthsAfterPurchase: 16, termMonths: 360 },
  }, { today: TODAY });
  ok(cashRefi.reasons.some((x) => x.key === 'C2'), 'a 16-month refinance scores as a real exit');
}

// ═══════════════════ 5. A common name cannot identify a person
console.log('\n5. The common-name rule, where the spec contradicted itself');
{
  const noTie = { ...CLEAN, borrowerSignedInstrument: false, sosListsAsOfficer: false };
  const r60 = S.scoreDeal({ ...noTie, nameCommonnessScore: 65 }, { today: TODAY });
  ok(r60.reasons.some((x) => x.key === 'P1' && x.points === -40),
    'a common name with no personal tie takes the -40 penalty');

  const withTie = S.scoreDeal({ ...CLEAN, nameCommonnessScore: 65 }, { today: TODAY });
  ok(!withTie.reasons.some((x) => x.key === 'P1'),
    '…but not when the borrower personally signed the instrument — then the name is not doing the identifying');

  /* The blueprint said BOTH "cap at needs review" and "cannot verify" for >= 85.
     Both are implemented and the stricter binds. */
  const r85 = S.scoreDeal({ ...CLEAN, nameCommonnessScore: 92 }, { today: TODAY });
  ok(r85.band === 'cannot_verify',
    'a very common name is cannot_verify EVEN on otherwise perfect signals — the stricter of the two rules binds');
  ok(r85.needs.length > 0, '…and it says what document would settle it');

  ok(S.scoreDeal({ ...CLEAN, nameCommonnessScore: undefined }, { today: TODAY }).band === 'auto_proved',
    'an UNKNOWN commonness score is not a penalty — absent is never a negative finding');
}

// ═══════════════════ 6. A related-party exit is punished hard
console.log('\n6. Related-party and thin-coverage penalties');
{
  const rel = S.scoreDeal({ ...CLEAN, relatedPartyExit: true }, { today: TODAY });
  ok(rel.reasons.some((x) => x.key === 'C5' && x.points === -30), 'a related-party exit takes -30');
  ok(rel.band !== 'auto_proved', '…and drops it out of auto_proved');

  ok(S.scoreDeal({ ...CLEAN, isNonArmsLengthTransfer: true }, { today: TODAY })
    .reasons.some((x) => x.key === 'C5'), 'the vendor’s own non-arms-length flag does the same');

  ok(S.scoreDeal({ ...CLEAN, entityCombinedCoveragePct: 20 }, { today: TODAY })
    .reasons.some((x) => x.key === 'P2'),
  'a county with thin entity records is penalised — an absence there proves little');
  ok(!S.scoreDeal({ ...CLEAN, entityCombinedCoveragePct: undefined }, { today: TODAY })
    .reasons.some((x) => x.key === 'P2'), '…and an unknown coverage is not');

  ok(S.scoreDeal({ ...CLEAN, mlsSaleDom: 0, exitEvidenceIsListingOnly: true }, { today: TODAY })
    .reasons.some((x) => x.key === 'P4'),
  'a listing whose dates were synthesized from the deed is not independent evidence');
}

// ═══════════════════ 7. The boundary cap
console.log('\n7. An exit near the 3-year boundary is never auto-proved');
{
  const near = S.scoreDeal({ ...CLEAN, exitDate: '2023-08-20' }, { today: TODAY });   // ~36 months ago
  ok(near.caps.some((c) => c.key === 'B3'), 'an exit close to the boundary raises the B3 cap');
  ok(near.band === 'needs_review', '…and is capped at needs_review, because that date decides whether it counts at all');

  const far = S.scoreDeal({ ...CLEAN, exitDate: '2025-06-01' }, { today: TODAY });
  ok(far.band === 'auto_proved', 'while a comfortably in-window exit is unaffected');
}

// ═══════════════════ 8. No hold-period rule exists, and none may be added
console.log('\n8. Hold period is not a gate (owner-directed)');
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/lib/track-record/scoring.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/holdDays|hold_days|holdPeriod|daysHeld/.test(src),
    'the ladder contains no hold-period rule at all — real presentable flips exist at 2, 11 and 13 days');

  const quick = S.scoreDeal({ ...CLEAN, holdDays: 2 }, { today: TODAY });
  ok(quick.band === 'auto_proved', 'and a 2-day hold scores exactly like any other clean flip');
}

// ═══════════════════ 9. Bands are ordered, and a cap only ever lowers
console.log('\n9. A cap can only ever lower the band');
{
  const weak = S.scoreDeal({
    granteeIsMatchedEntity: true, exitInWindow: true, memberOfEntity: true,
  }, { today: TODAY });
  ok(weak.band === 'cannot_verify', `thin signals land in cannot_verify (score ${weak.score})`);
  ok(weak.needs.length > 0 && /operating agreement|deed/.test(weak.needs[0]),
    '…and it names the document that would settle it, rather than just refusing');

  const mid = S.scoreDeal({ ...CLEAN, deedCorroboratesExitDate: false }, { today: TODAY });
  ok(mid.band === 'needs_review', 'a strong-but-uncorroborated deal lands in needs_review');
  ok(mid.score >= S.BAND_REVIEW, '…above the review floor');
}

console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  scoring: grantee or nothing, precision over recall, and no hold-period gate');
process.exit(fail ? 1 : 0);
