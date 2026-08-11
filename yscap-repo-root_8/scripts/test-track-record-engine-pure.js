'use strict';
/**
 * THE PURE ENGINE — checks.js, match.js, counterparty.js.
 *
 * Three assertions here carry most of the weight, and each one exists because
 * the OPPOSITE reading is the tempting one:
 *
 *   §2.4  A deed proving the ENTITY held the property, with nobody having
 *         confirmed the borrower controls that entity, reports `no_data` — NOT
 *         `proved`. Turning that into a pass puts a green tick in front of a
 *         reviewer for a question nobody has answered.
 *   §5.2  An auto-confirm needs BOTH address comparers. A caller that could not
 *         reach the SQL twin gets manual review, never "the JS said yes".
 *   §7.1  An unconsulted relationship graph is `unknown`, never `unrelated`.
 *         Reporting "no connection found" when nobody looked would put an
 *         all-clear on the single check the Baltimore scheme defeated.
 *
 * Offline: no database, no network, and the clock is passed in.
 */

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

const C = require('../src/lib/track-record/checks');
const M = require('../src/lib/track-record/match');
const CP = require('../src/lib/track-record/counterparty');
const S = require('../src/lib/track-record/scoring');
const EXP = require('../src/lib/experience');

const TODAY = '2026-08-09';
const ADDR = { line1: '412 Bishop St', city: 'Baltimore', state: 'MD', zip: '21230' };
const ONE_LINE = '412 Bishop St, Baltimore, MD 21230';

/** A clean flip: bought in the entity, sold to a stranger, inside the window. */
const LINE = {
  deal_type: 'flip',
  purchase_date: '2024-02-01',
  sale_date: '2025-06-15',
  property_address: ADDR,
  entity_name: 'Bishop Street Holdings LLC',
};
const CTX = {
  entityNames: ['Bishop Street Holdings LLC'],
  borrowerNames: ['Yehuda Bochner'],
  controlVerdict: 'confirmed',
  llcId: '00000000-0000-0000-0000-000000000001',
};
const RECS = {
  searched: true,
  deeds: [
    { addresses: [ONE_LINE], grantors: ['Somebody Else'], grantees: ['Bishop Street Holdings LLC'],
      date: '2024-02-08', documentId: 'D-ACQ-1' },
    { addresses: [ONE_LINE], grantors: ['Bishop Street Holdings LLC'], grantees: ['Marcus Reed'],
      date: '2025-06-20', documentId: 'D-SALE-1', amount: 415000, armsLength: true },
  ],
  mortgages: [], satisfactions: [], currentOwner: null,
  coverage: { entityCombinedCoveragePct: 88, county: 'Baltimore City|MD' },
};

const byPillar = (out) => Object.fromEntries(out.map((c) => [c.pillar, c]));

// ═══════════════════ 1. NEVER FABRICATE
console.log('\n1. With nothing looked up, nothing is claimed');
{
  const r = byPillar(C.computeChecks(LINE, {}, { borrowerNames: ['Yehuda Bochner'] }, TODAY));
  ok(r.ownership.auto_verdict === 'no_data', 'ownership is no_data, never a guess');
  ok(r.exit.auto_verdict === 'no_data', 'the exit is no_data');
  ok(r.ownership.auto_evidence.searched === false,
    '…and it says plainly that nobody has SEARCHED, rather than implying we looked and found nothing');
  ok(r.ownership.auto_grade === 'unacceptable' && r.exit.auto_grade === 'unacceptable',
    'no evidence grades as unacceptable');
  ok(C.computeChecks(LINE, {}, {}, TODAY)
    .filter((c) => c.pillar !== 'recency').every((c) => c.auto_verdict !== 'proved'),
  'neither pillar that depends on the records reaches proved on an empty search');

  // The recency pillar is derived from the line's own dates, so it CAN answer.
  ok(r.recency.auto_verdict === 'proved' && r.recency.auto_grade === 'weak',
    'recency still answers from the line itself — at a weak grade, because nothing corroborates the date');
}

// ═══════════════════ 2. OWNERSHIP — the two-check model
console.log('\n2. Ownership is Check A and Check B, and it never collapses them');
{
  const proved = byPillar(C.computeChecks(LINE, RECS, CTX, TODAY)).ownership;
  ok(proved.auto_verdict === 'proved', 'entity is the grantee + control confirmed → proved');
  ok(proved.auto_evidence.checkB.granteeIsMatchedEntity === true, '…recording that the entity is the GRANTEE');
  ok(String(proved.auto_evidence.satisfiedByLlcId) === String(CTX.llcId),
    '…and WHICH entity carried it, so one verification can reach every property it held');

  const rejected = byPillar(C.computeChecks(LINE, RECS, { ...CTX, controlVerdict: 'rejected' }, TODAY)).ownership;
  ok(rejected.auto_verdict === 'contradicted',
    'a human rejecting the borrower\'s control of the entity contradicts the ownership');

  /* §2.4 — THE LOAD-BEARING ONE. Read the module header before "fixing" this. */
  const unknown = byPillar(C.computeChecks(LINE, RECS, { ...CTX, controlVerdict: null }, TODAY)).ownership;
  ok(unknown.auto_verdict === 'no_data',
    'Check B proved with Check A never asked is NO_DATA — a company holding a deed says nothing about who controls the company');
  ok(unknown.auto_evidence.needsControlCheck === true && unknown.auto_evidence.checkB.granteeIsMatchedEntity === true,
    '…and NOTHING is lost: the proved Check B rides along, flagged as needing the control check');

  const personal = {
    ...RECS,
    deeds: [{ ...RECS.deeds[0], grantees: ['Yehuda Bochner'] }, RECS.deeds[1]],
  };
  const own = byPillar(C.computeChecks(LINE, personal, { ...CTX, controlVerdict: null }, TODAY)).ownership;
  ok(own.auto_verdict === 'proved',
    'but a deed in the BORROWER\'S OWN NAME needs no control check at all — there is no company in between');

  const signed = byPillar(C.computeChecks(LINE, {
    ...personal,
    deeds: [{ ...personal.deeds[0], signers: [{ name: 'Yehuda Bochner' }] }, RECS.deeds[1]],
  }, CTX, TODAY)).ownership;
  ok(signed.auto_grade === 'superior', 'reading the signers and finding the borrower\'s own signature is the top grade');
}

// ═══════════════════ 3. Contradiction needs an affirmative record
console.log('\n3. A contradiction is a record that says otherwise — never an absence');
{
  const other = byPillar(C.computeChecks(LINE, {
    searched: true,
    deeds: [{ addresses: [ONE_LINE], grantors: ['A'], grantees: ['Completely Different Co LLC'], date: '2024-02-08', documentId: 'X' }],
  }, CTX, TODAY)).ownership;
  ok(other.auto_verdict === 'contradicted', 'every readable deed conveying to somebody else contradicts the claim');
  ok(other.auto_confidence === 'possible',
    '…at POSSIBLE confidence, because patchy county coverage looks exactly like this');

  const blank = byPillar(C.computeChecks(LINE, { searched: true, deeds: [] }, CTX, TODAY)).ownership;
  ok(blank.auto_verdict === 'no_data', 'a search that found nothing is no_data, not a contradiction');

  /* THE LIVE FALSE POSITIVE FROM API PROBING: a York, PA investor's profile
     returned a Philadelphia property he never owned, because his LLC appeared as
     GRANTOR on an unrelated later deed. Appearing on a deed is not owning it. */
  const grantorOnly = C.computeChecks(LINE, {
    searched: true,
    deeds: [{ addresses: [ONE_LINE], grantors: ['Bishop Street Holdings LLC'], grantees: ['Third Party LLC'],
      date: '2025-06-20', documentId: 'D' }],
  }, CTX, TODAY);
  ok(byPillar(grantorOnly).ownership.auto_verdict === 'contradicted',
    'appearing only as GRANTOR is not ownership — the deed conveys the property to somebody else');
  ok(S.scoreDeal(C.signalsFor(grantorOnly, {}, CTX), { today: TODAY }).discarded === true,
    '…and the ladder DISCARDS the row rather than scoring it, because A3 never fired');
}

// ═══════════════════ 4. too_recent
console.log('\n4. "Too recent" is a real answer, and it is not "no data"');
{
  const fresh = byPillar(C.computeChecks(
    { ...LINE, purchase_date: '2026-07-25', sale_date: null }, { searched: true, deeds: [] }, CTX, TODAY)).ownership;
  ok(fresh.auto_verdict === 'too_recent',
    'a purchase 15 days old with no deed found is too_recent — counties take weeks, so nothing found proves nothing');
  ok(/check again/i.test(fresh.auto_evidence.why), '…and it tells the reviewer to check again rather than to go hunting');

  const future = byPillar(C.computeChecks({ ...LINE, sale_date: '2026-12-01' }, RECS, CTX, TODAY)).recency;
  ok(future.auto_verdict === 'too_recent', 'a future-dated exit has not closed yet');
}

// ═══════════════════ 5. The frozen exit rule reaches this module
console.log('\n5. The exit date comes from the frozen rule, not from a second copy');
{
  const built = { deal_type: 'ground-up', purchase_date: '2023-01-10', sale_date: '2025-06-01', property_address: ADDR };
  ok(EXP.exitDateOf(built) === '2025-06-01', 'the frozen rule dates a built-and-sold ground-up off its sale');
  const r = byPillar(C.computeChecks(built, {}, {}, TODAY)).recency;
  ok(r.auto_verdict === 'proved' && r.auto_evidence.exitDate === '2025-06-01',
    '…and this module reports exactly that date — it never re-derives one');

  const stale = byPillar(C.computeChecks({ ...LINE, sale_date: '2021-04-01' }, {}, {}, TODAY)).recency;
  ok(stale.auto_verdict === 'contradicted', `an exit ${EXP.EXIT_WINDOW_MONTHS}+ months old counts toward nothing`);
  ok(stale.auto_evidence.reoReason === 'outside_window',
    '…and it carries the machine-readable reason, so the line joins the REO list instead of vanishing');

  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/lib/track-record/checks.js'), 'utf8');
  ok(/experience\.exitDateOf/.test(src) && !/rent_date\s*\|\|\s*.*refi_date/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')),
    'the source calls the frozen rule and contains no second copy of it');
}

// ═══════════════════ 6. The exit pillar
console.log('\n6. The exit — a sale, a real refinance, and the two things that are neither');
{
  const sold = byPillar(C.computeChecks(LINE, RECS, CTX, TODAY)).exit;
  ok(sold.auto_verdict === 'proved' && sold.auto_evidence.armsLengthSale === true, 'a deed out to a stranger is an exit');

  const self = byPillar(C.computeChecks(LINE, {
    ...RECS,
    deeds: [RECS.deeds[0], { ...RECS.deeds[1], grantees: ['Bishop Street Holdings LLC'] }],
  }, CTX, TODAY)).exit;
  ok(self.auto_verdict === 'contradicted' && self.auto_evidence.selfDealing === true,
    'SOLD TO THEMSELVES IS NOT AN EXIT — the property never left');

  const cousin = byPillar(C.computeChecks(LINE, {
    ...RECS,
    deeds: [RECS.deeds[0], { ...RECS.deeds[1], armsLength: false }],
  }, CTX, TODAY)).exit;
  ok(cousin.auto_verdict === 'proved' && cousin.auto_evidence.relatedPartyExit === true,
    '…but selling to a related party IS a sale — flagged, not denied (the ladder is what punishes it)');

  /* THE FIXTURE IS THE SHAPE'S OWN FIELDS — `grantees`/`date`/`isCurrent`,
     exactly what shapes.ownership() produces. The first version of this case
     used `owners`/`asOf`, names NO real row carries, so the suite passed while
     the check was permanently dark against live data (a fixture invented by
     whoever wrote the reader can only ratify their guess — the shapes module's
     own lesson, re-learned one layer up on 2026-08-09). */
  const still = byPillar(C.computeChecks(LINE, {
    ...RECS, deeds: [RECS.deeds[0]],
    currentOwner: { addresses: [ONE_LINE], grantees: ['Bishop Street Holdings LLC'],
      people: [], date: '2024-11-02', isCurrent: true },
  }, CTX, TODAY)).exit;
  ok(still.auto_verdict === 'contradicted',
    'claiming a sale while the county STILL shows them as the current owner is a real contradiction');
  /* Inside the recording-lag window it is NOT — a sale recorded three weeks
     late must never be painted as a false claim. */
  const lag = byPillar(C.computeChecks({ ...LINE, sale_date: '2026-07-20' }, {
    ...RECS, deeds: [RECS.deeds[0]],
    currentOwner: { addresses: [ONE_LINE], grantees: ['Bishop Street Holdings LLC'],
      people: [], date: '2024-11-02', isCurrent: true },
  }, CTX, TODAY)).exit;
  ok(lag.auto_verdict !== 'contradicted',
    'a fresh exit the county may simply not have recorded yet is NOT called a contradiction');

  const hold = { deal_type: 'hold', purchase_date: '2024-02-01', refi_date: '2025-04-01', property_address: ADDR };
  const refi = (termMonths, isExtension) => byPillar(C.computeChecks(hold, {
    searched: true, deeds: [], satisfactions: [],
    mortgages: [{ addresses: [ONE_LINE], borrowers: ['Bishop Street Holdings LLC'], date: '2025-04-04', documentId: 'M1', termMonths, isExtension }],
  }, CTX, TODAY)).exit;
  ok(refi(360, false).auto_verdict === 'proved', 'a 30-year refinance is a real exit');
  ok(refi(12, false).auto_verdict === 'no_data', 'refinancing into ANOTHER short-term loan is not');
  ok(refi(360, true).auto_verdict === 'no_data', 'and an extension of the same loan is not');
  ok(C.PERM_TERM_MIN_MONTHS === S.PERM_TERM_MIN_MONTHS,
    'the permanent-term floor is the SAME number the scoring ladder uses — one rule read from two sides');

  /* THE ROOT-FIX, PROVEN ON THE REAL FIELD. shapes.mortgage() puts the borrower
     names in `grantees` (from borrowerNames||borrower), NEVER `borrowers` — so
     findRefinance, reading `m.borrowers`, was silently dark on every production
     mortgage. This fixture carries ONLY `grantees`, the shape live data has. */
  const refiRealField = byPillar(C.computeChecks(hold, {
    searched: true, deeds: [], satisfactions: [],
    mortgages: [{ addresses: [ONE_LINE], grantees: ['Bishop Street Holdings LLC'], date: '2025-04-04', documentId: 'M1', termMonths: 360 }],
  }, CTX, TODAY)).exit;
  ok(refiRealField.auto_verdict === 'proved',
    'a permanent-term refinance named on the REAL `grantees` field is a proved exit — findRefinance read the never-emitted `borrowers` and was dark on this before');

  const leased = byPillar(C.computeChecks(
    { deal_type: 'hold', purchase_date: '2024-02-01', rent_date: '2025-04-01', property_address: ADDR },
    { searched: true, deeds: [], mortgages: [] }, CTX, TODAY)).exit;
  ok(leased.auto_verdict === 'no_data' && leased.auto_evidence.needsDocument === 'lease_or_rent_roll',
    'a lease is not recorded anywhere public, and it says so — a failed search would send somebody hunting for nothing');

  /* The frozen rule dates a hold off COALESCE(rent, refi), so a property that was
     BOTH rented and refinanced exits on the rent date — and the lease branch sits
     after the refinance branch precisely so the recorded evidence still wins. */
  const rentedAndRefinanced = byPillar(C.computeChecks(
    { deal_type: 'hold', purchase_date: '2024-02-01', rent_date: '2025-04-01', refi_date: '2025-04-01', property_address: ADDR },
    { searched: true, mortgages: [{ addresses: [ONE_LINE], borrowers: ['Bishop Street Holdings LLC'], date: '2025-04-04', termMonths: 360, documentId: 'M1' }] },
    CTX, TODAY)).exit;
  ok(rentedAndRefinanced.auto_verdict === 'proved',
    'a hold that both rented AND refinanced is proved off the recorded mortgage — it never falls through to "a lease is not public"');
}

// ═══════════════════ 7. The engine speaks the ladder's language
console.log('\n7. The checks feed the scoring ladder without a translator in between');
{
  const checks = C.computeChecks(LINE, RECS, CTX, TODAY);
  const signals = C.signalsFor(checks, RECS, { ...CTX, sosListsAsOfficer: true, vendorLinksEntityToBorrower: true, nameCommonnessScore: 12 });
  const scored = S.scoreDeal(signals, { today: TODAY });
  ok(scored.discarded !== true, 'a clean, corroborated deal is not discarded');
  ok(scored.band === 'auto_proved', `…and reaches auto_proved end to end (score ${scored.score})`);

  const thin = S.scoreDeal(C.signalsFor(C.computeChecks(LINE, {}, CTX, TODAY), {}, CTX), { today: TODAY });
  ok(thin.discarded === true,
    'while the SAME deal with nothing looked up is DISCARDED — no grantee evidence, so it is never scored');
}

// ═══════════════════ 8. It never throws
console.log('\n8. Garbage in never takes a borrower\'s record off the screen');
{
  for (const bad of [null, undefined, 'nonsense', 42, { property_address: { line1: null } }]) {
    const out = C.computeChecks(bad, bad, bad, bad);
    ok(Array.isArray(out) && out.length === 3, `computeChecks(${JSON.stringify(bad)}) still answers three pillars`);
  }
  ok(C.computeChecks({}, {}, {}, TODAY).every((c) => C.PILLARS.includes(c.pillar)),
    'and always the same three pillars, named exactly as db/494 spells them');
}

// ═══════════════════ 9. MATCH — the preconditions
console.log('\n9. Binding a stranger\'s record needs every precondition');
{
  const row = { property_address: ADDR };
  const cand = { addresses: [ONE_LINE] };
  const good = M.decideMatch(row, cand, { elxStatus: 'exact', sqlSamePlace: true });
  ok(good.action === 'auto_confirm', 'an exact vendor match that both comparers confirm may bind on its own');

  /* §5.2 — fail CLOSED. */
  ok(M.decideMatch(row, cand, { elxStatus: 'exact' }).action === 'manual_review',
    'the SQL comparer NOT CONSULTED is manual review — never "the JS said yes"');
  ok(M.decideMatch(row, cand, { elxStatus: 'exact', sqlSamePlace: false }).blockers.some((b) => b.key === 'sql_disagrees'),
    'and the two comparers disagreeing is named as the reason');

  ok(M.decideMatch(row, cand, { elxStatus: 'ambiguous', sqlSamePlace: true }).action === 'manual_review',
    'an ambiguous vendor address match never binds');
  ok(M.decideMatch({ property_address: '412 Bishop St' }, cand, { elxStatus: 'exact', sqlSamePlace: true })
    .blockers.some((b) => b.key === 'our_row_has_no_place'),
  'our own line with neither state nor ZIP never binds — two towns share a street name');
}

// ═══════════════════ 10. MATCH — the four look-alike shapes
console.log('\n10. The four shapes where two addresses look identical and are not');
{
  const shape = (ours, theirs) => M.decideMatch({ property_address: ours }, { address: theirs },
    { elxStatus: 'exact', sqlSamePlace: true });

  const hyph = shape('150-25 78th Rd, Queens, NY 11367', '150-25 78th Rd, Queens, NY 11367');
  ok(hyph.action === 'manual_review' && hyph.blockers.some((b) => b.key === 'hyphenated_house_number'),
    'a hyphenated house number goes to a person — in Queens that is one number, not a range');

  const unit = shape(ADDR, '412 Bishop St Apt 4, Baltimore, MD 21230');
  ok(unit.blockers.some((b) => b.key === 'unit_on_one_side_only'),
    'one side naming a unit goes to a person — a deed for unit 4 is not evidence about the building');

  ok(M.differences('5 Oak St, Nyack, NY 10960', '5 Oak Street Extension, Nyack, NY 10960').extension === true,
    '"Extension" makes it a different street');
  ok(M.differences('1727 S 2nd St, Piscataway, NJ 08854', '1727 2nd St, Piscataway, NJ 08854').directional === true,
    'a directional on one side only is a different street — the exact geocoder corruption from 2026-07-28');
  ok(M.differences(ADDR, ONE_LINE).directional === false && M.differences(ADDR, ONE_LINE).unitOneSided === false,
    '…while two spellings of one address raise none of them');

  const stranger = shape(ADDR, '412 Bishop St, Baltimore, MD 21231');
  ok(stranger.action === 'reject', 'a different ZIP is a different property — rejected, not asked about');
}

// ═══════════════════ 11. MATCH — no new normalizer, and no home is a question
console.log('\n11. It reuses the chokepoint, and an unplaceable record is a person\'s call');
{
  const rows = [{ id: 'r1', property_address: ADDR, address_key: require('../src/lib/track-record-key').trackRecordKey(ADDR) }];
  ok(M.findOurRow(rows, '412 Bishop Street, Baltimore, MD 21230').id === 'r1',
    'it finds the borrower\'s line through matchTrackRecord');
  const orphan = M.matchCandidate(rows, { address: '900 Elsewhere Ave, Trenton, NJ 08608' }, { elxStatus: 'exact', sqlSamePlace: true });
  ok(orphan.row === null && orphan.action === 'manual_review',
    'a property not on the record yet is never inserted automatically — adding one is a decision');

  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/lib/track-record/match.js'), 'utf8');
  ok(/require\('\.\.\/track-record-key'\)/.test(src), 'the module reaches for the chokepoint by name');
  ok(!/require\('\.\.\/\.\.\/db'\)/.test(src) && !/db\.query/.test(src),
    '…and touches no database, so the SQL comparer can only ever be an argument');
}

// ═══════════════════ 12. COUNTERPARTY — unknown is the default
console.log('\n12. The Baltimore control: "we did not look" is never "they are strangers"');
{
  /* §7.1 */
  const nothing = CP.assessCounterparty({ grantee: 'Marcus Reed' }, {});
  ok(nothing.verdict === 'unknown', 'an unconsulted graph is UNKNOWN, never unrelated');
  ok(/nobody has looked/i.test(nothing.why), '…and it says so in words a reviewer can act on');
  ok(CP.assessCounterparty({}, { fetched: true }).verdict === 'unknown', 'a record naming no buyer is unknown too');

  const clean = CP.assessCounterparty({ grantee: 'Marcus Reed' },
    { fetched: true, ourPeople: [{ name: 'Yehuda Bochner' }], theirPeople: [{ name: 'Marcus Reed' }] });
  ok(clean.verdict === 'unrelated', 'a genuinely unconnected buyer, actually looked up, is unrelated');
}

// ═══════════════════ 13. COUNTERPARTY — the signals
console.log('\n13. Each signal, weighted the way it deserves');
{
  const g = (extra) => ({ fetched: true, ourEntity: 'Bishop Street Holdings LLC', ...extra });

  ok(CP.assessCounterparty({ grantee: 'Reed Capital LLC' },
    g({ ourPeople: [{ name: 'Yehuda Bochner' }], theirPeople: [{ name: 'Yehuda Bochner' }] })).verdict === 'related',
  'one human behind both sides is enough on its own');

  ok(CP.assessCounterparty({ grantee: 'Reed Capital LLC' },
    g({ ourSigners: [{ name: 'Yehuda Bochner' }], theirSigners: [{ name: 'Y Bochner' }] })).verdict === 'related',
  'the same person signing for buyer and seller is enough');

  ok(CP.assessCounterparty({ grantee: 'Reed Capital LLC' },
    g({ coOccurring: [{ name: 'Reed Capital LLC', sharedDeals: 4 }] })).verdict === 'related',
  'the records service already linking the two companies is enough');

  const sameAddr = CP.assessCounterparty({ grantee: 'Reed Capital LLC' },
    g({ ourAddresses: ['5 Court St, Brooklyn, NY 11201'], theirAddresses: ['5 Court Street, Brooklyn, NY 11201'] }));
  ok(sameAddr.verdict === 'related', 'a shared mailing address is enough');
  ok(CP.assessCounterparty({ grantee: 'Reed Capital LLC' },
    g({ ourAddresses: ['5 Court St, Brooklyn, NY 11201'], theirAddresses: ['5 Court St, Brooklyn, NY 11201'],
      agentAddresses: ['5 Court St, Brooklyn, NY 11201'] })).verdict === 'unrelated',
  '…unless it is a known registered-agent office, which serves thousands of unrelated companies');

  const one = CP.assessCounterparty({ grantee: 'Reed Capital LLC' },
    g({ priorExits: [{ grantee: 'Reed Capital LLC', address: 'a' }] }));
  ok(one.verdict === 'unrelated',
    'ONE repeat buyer is not enough — an investor selling to the same landlord twice is ordinary');
  const three = CP.assessCounterparty({ grantee: 'Reed Capital LLC' },
    g({ priorExits: [{ grantee: 'Reed Capital LLC' }, { grantee: 'Reed Capital LLC' }] }));
  ok(three.verdict === 'related', '…but a buyer absorbing three of one borrower\'s "exits" is');

  const token = CP.assessCounterparty({ grantee: 'Kensington Capital LLC' }, g({ ourEntity: 'Kensington Holdings LLC' }));
  ok(token.verdict === 'unrelated' && token.signals.some((s) => s.key === 'shared_name_token'),
    'a shared distinctive name is worth points but is never enough alone — it can be a coincidence');
  ok(CP.assessCounterparty({ grantee: 'Kensington Capital LLC' },
    g({ ourEntity: 'Kensington Holdings LLC', priorExits: [{ grantee: 'Kensington Capital LLC' }] })).verdict === 'related',
  '…and together with a repeat it is');

  ok(CP.distinctiveTokens('Premier Holdings Capital Properties Group LLC').length === 0,
    'the generic industry words identify nobody and can never fire the name signal');
  ok(CP.distinctiveTokens('Kensington Holdings LLC').join() === 'kensington', 'while a real name survives');

  ok(CP.assessCounterparty({ grantee: 'Reed Capital LLC', isNonArmsLengthTransfer: true }, g({})).verdict === 'related',
    'and the records service\'s own not-arm\'s-length flag stands on its own');
}

// ═══════════════════ 14. COUNTERPARTY — the pattern across the whole record
console.log('\n14. The pattern that only shows across the whole track record');
{
  const exits = [
    { grantee: 'Reed Capital LLC', address: '1 A St' },
    { grantee: 'Reed Capital LLC', address: '2 A St' },
    { grantee: 'Reed Capital LLC', address: '3 A St' },
    { grantee: 'Someone Else LLC', address: '4 A St' },
  ];
  const p = CP.assessPortfolio(exits, { fetched: true });
  ok(p.concentrated === true, 'three of four "exits" going to one buyer is flagged');
  ok(/more buyers than that/.test(p.why), '…in plain words');
  ok(p.distinctBuyers === 2, 'and it counts how many buyers there really were');

  const spread = CP.assessPortfolio(
    ['A LLC', 'B LLC', 'C LLC', 'D LLC'].map((n, i) => ({ grantee: n, address: `${i} B St` })), { fetched: true });
  ok(spread.concentrated === false, 'while four buyers for four properties is an ordinary market');
  ok(CP.assessPortfolio([], {}).results.length === 0, 'an empty record answers without complaint');

  for (const bad of [null, 'x', 7]) {
    ok(CP.assessCounterparty(bad, bad).verdict === 'unknown', `assessCounterparty(${JSON.stringify(bad)}) answers unknown rather than throwing`);
  }
}

// ═══════════════════ 15. OWNERSHIP — the current owner and the refinance prove it too
console.log('\n15. Ownership is proved by the county current-owner record and by a refinance — not only the acquisition deed');
{
  const co = (holder, key) => ({
    addresses: [ONE_LINE], grantees: key === 'entity' ? [holder] : [], people: key === 'person' ? [holder] : [],
    date: '2024-02-08', isCurrent: true, deedId: 'CO-1',
  });
  const noDeeds = { searched: true, deeds: [], mortgages: [], satisfactions: [] };

  // (1) the current-owner record
  const coPerson = byPillar(C.computeChecks(LINE,
    { ...noDeeds, currentOwner: co('Yehuda Bochner', 'person') }, { ...CTX, controlVerdict: null }, TODAY)).ownership;
  ok(coPerson.auto_verdict === 'proved',
    'the borrower named on the county current-owner record proves ownership, with no acquisition deed and no control check');

  const coEntityNoCtl = byPillar(C.computeChecks(LINE,
    { ...noDeeds, currentOwner: co('Bishop Street Holdings LLC', 'entity') }, { ...CTX, controlVerdict: null }, TODAY)).ownership;
  ok(coEntityNoCtl.auto_verdict === 'no_data' && coEntityNoCtl.auto_evidence.needsControlCheck === true,
    '…but when the current owner is our ENTITY and nobody confirmed control, it is no_data needing the control check — never a fabricated proof');

  const coEntityOk = byPillar(C.computeChecks(LINE,
    { ...noDeeds, currentOwner: co('Bishop Street Holdings LLC', 'entity') }, CTX, TODAY)).ownership;
  ok(coEntityOk.auto_verdict === 'proved' && String(coEntityOk.auto_evidence.satisfiedByLlcId) === String(CTX.llcId),
    '…and once control is confirmed it is proved, carrying which entity satisfied it');

  // (2) the refinance — ANY term (this is the ownership question, not the exit question)
  const refiEntity = byPillar(C.computeChecks(LINE, {
    searched: true, deeds: [], currentOwner: null,
    mortgages: [{ addresses: [ONE_LINE], grantees: ['Bishop Street Holdings LLC'], date: '2025-01-10', documentId: 'RM-1', isRefinance: true, termMonths: 24 }],
  }, CTX, TODAY)).ownership;
  ok(refiEntity.auto_verdict === 'proved',
    'a refinance in the entity name (real `grantees` field), confirmed control, proves ownership — even a short term, because you cannot refinance what you do not own');

  const refiPerson = byPillar(C.computeChecks(LINE, {
    searched: true, deeds: [], currentOwner: null,
    mortgages: [{ addresses: [ONE_LINE], grantees: ['Yehuda Bochner'], date: '2025-01-10', documentId: 'RM-2', loanPurpose: 'Refinance', termMonths: 360 }],
  }, { ...CTX, controlVerdict: null }, TODAY)).ownership;
  ok(refiPerson.auto_verdict === 'proved',
    'a refinance in the borrower\'s own name, detected via loanPurpose, proves ownership with no control check');

  // NEVER FABRICATE — the new sources naming somebody else, with deeds naming others, is still contradicted
  const stillContradicted = byPillar(C.computeChecks(LINE, {
    searched: true,
    deeds: [{ addresses: [ONE_LINE], grantors: ['A'], grantees: ['Completely Different Co LLC'], date: '2024-02-08', documentId: 'X' }],
    currentOwner: co('Completely Different Co LLC', 'entity'),
    mortgages: [{ addresses: [ONE_LINE], grantees: ['Completely Different Co LLC'], date: '2025-01-10', documentId: 'RM-X', isRefinance: true, termMonths: 360 }],
  }, CTX, TODAY)).ownership;
  ok(stillContradicted.auto_verdict === 'contradicted',
    'a current owner AND a refinance both naming somebody else, with deeds naming others, is still contradicted — the new sources never invent ownership');

  // A current-owner record for a DIFFERENT property is ignored
  const wrongAddr = byPillar(C.computeChecks(LINE, {
    ...noDeeds,
    currentOwner: { addresses: ['999 Nowhere Rd, Trenton, NJ 08608'], grantees: ['Bishop Street Holdings LLC'], people: [], date: '2024-02-08', isCurrent: true, deedId: 'CO-Z' },
  }, CTX, TODAY)).ownership;
  ok(wrongAddr.auto_verdict !== 'proved',
    'a current-owner record for a DIFFERENT property is ignored — it never proves this line');

  // THE SCORE FOLLOWS THE PILLAR. Without wiring the new evidence into `checkB`,
  // the ladder's A3 identity gate would DISCARD a currentOwner/refi-proved deal as
  // "not the grantee on any deed" — the pillar would say proved while the score
  // threw it away. A3 firing can only lift it to needs_review, never to auto_proved.
  const holdRefi = { deal_type: 'hold', purchase_date: '2024-02-01', refi_date: '2025-04-01', property_address: ADDR, entity_name: 'Bishop Street Holdings LLC' };
  const provenByRefi = C.computeChecks(holdRefi, {
    searched: true, deeds: [], satisfactions: [], currentOwner: null,
    mortgages: [{ addresses: [ONE_LINE], grantees: ['Bishop Street Holdings LLC'], date: '2025-04-04', documentId: 'M9', isRefinance: true, termMonths: 360 }],
  }, CTX, TODAY);
  const scoredRefi = S.scoreDeal(C.signalsFor(provenByRefi, {}, CTX), { today: TODAY });
  ok(scoredRefi.discarded === false,
    'the SCORE follows the pillar — a refinance-proved deal passes the ladder\'s A3 gate and is scored, not discarded as "never the grantee on a deed"');
  ok(scoredRefi.band !== 'auto_proved',
    '…but A3 alone never auto-proves it — the exit-corroboration and personal-identity gates still have to pass on their own');

  // The acquisition deed still wins when present (the new branches run AFTER it)
  const withAcq = byPillar(C.computeChecks(LINE, {
    ...RECS, deeds: [RECS.deeds[0]], currentOwner: co('Bishop Street Holdings LLC', 'entity'),
  }, CTX, TODAY)).ownership;
  ok(withAcq.auto_verdict === 'proved' && withAcq.auto_evidence.checkB && withAcq.auto_evidence.checkB.recordingDate === '2024-02-08',
    'the acquisition deed still decides when one is present — the new sources are a fallback, not a replacement');
}

console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  the pure engine: never fabricates, both comparers must agree, and "we did not look" is not an all-clear');
process.exit(fail ? 1 : 0);
